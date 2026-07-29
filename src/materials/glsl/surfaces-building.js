/**
 * BUILDING SURFACES — Steel City.
 *
 * The district identities in DESIGN.md are carried almost entirely by these:
 * Lawrenceville is brick rowhouses, the Golden Triangle is glass curtain wall,
 * Steel Row is riveted mill plate and rust, Mt. Washington is painted timber on
 * a cliff. Each one therefore has to read from a distance as a SILHOUETTE
 * MATERIAL — one recognisable value and texture at 80 m — and still hold up
 * with the camera 40 cm from it.
 *
 * A hundred years of burning coke is the other half of the look. Pittsburgh
 * soot is not a grey overlay: it is a black carbon film that sticks to the
 * sheltered, north-facing, rain-shadowed parts of a facade and gets scoured off
 * everything the weather can reach, so a sooted building is a high-contrast
 * pattern of black and clean, not a uniformly dark one.
 */

/**
 * PITTSBURGH BRICK.
 *
 * uParam.x  bond   0 running · 1 common (a header course every 6th) · 2 stack
 * uParam.y  mortar 0..1  0 = tight tooled joints, 1 = eroded and repointed
 * uParam.z  soot   0..1
 * uParam.w  stock  0 red common · 0.5 buff/yellow · 1 dark iron-spot
 */
export const PGH_BRICK = /* glsl */ `
void owSurface(vec2 uv, out vec3 alb, out float h, out float rough, out float metal, out float ao){
  const vec2 P = vec2(8.0);
  const float COLS = 6.0;
  const float ROWS = 18.0;
  vec2 p = uv * P + uSeed * 9.1;

  int bond = int(uParam.x + 0.5);
  float mortarAge = clamp(uParam.y, 0.0, 1.0);
  float soot = clamp(uParam.z, 0.0, 1.0);
  float stock = clamp(uParam.w, 0.0, 1.0);

  // ---------------- lattice ----------------
  float rowF = uv.y * ROWS;
  float row = floor(rowF);
  // American common bond: five stretcher courses then a course of headers,
  // which are half as long. It is the giveaway of a load-bearing wall and it is
  // on most of the East End.
  float headerCourse = (bond == 1) ? step(0.5, 1.0 - abs(mod(row, 6.0) - 5.0)) : 0.0;
  float cols = mix(COLS, COLS * 2.0, headerCourse);
  float shift = (bond == 2) ? 0.0 : mod(row, 2.0) * 0.5;
  float colF = uv.x * cols + shift;
  float col = floor(colF);
  vec2 id = vec2(mod(col, cols), row);
  vec2 f = vec2(fract(colF), fract(rowF));

  vec4 rnd = owHash42(id + uSeed * 3.0);
  vec4 rnd2 = owHash42(id * 1.37 + 21.0 + uSeed);
  vec4 rnd3 = owHash42(id * 0.73 + 7.7 + uSeed * 1.9);

  vec2 jitter = (rnd.xy - 0.5) * vec2(0.014, 0.032);
  vec2 fj = f + jitter;

  // 10 mm joint on a 200x60 mm brick. Eroded joints are wider and deeper.
  float JX = mix(0.048, 0.070, mortarAge) / mix(1.0, 2.0, headerCourse);
  float JY = mix(0.135, 0.180, mortarAge);
  float dxj = min(fj.x, 1.0 - fj.x);
  float dyj = min(fj.y, 1.0 - fj.y);
  float shoulder = 0.74 + 0.16 * rnd3.w;
  float ex = smoothstep(JX * shoulder, JX * 1.02, dxj);
  float ey = smoothstep(JY * shoulder, JY * 1.02, dyj);
  float face = min(ex, ey);

  vec2 bp = vec2(fj.x, fj.y) * vec2(3.0, 1.0) + rnd.zw * 17.0;
  vec2 BP = vec2(24.0);

  // ---------------- mortar ----------------
  float mSand = owFbm01(p * 20.0, P * 20.0, 4, 0.5);
  vec4 mGrain = owWorley(p * 23.0, P * 23.0, 1.0);
  float mRough = owFbm01(p * 18.0, P * 18.0, 4, 0.55);
  // Original lime mortar is warm and soft; a 1970s cement repoint is grey,
  // harder and a different width, and half of any old wall has both.
  float repoint = step(0.55, owFbm01(owWarp(p * 1.1 + 31.0, P * 1.1, 0.9, 3), P * 1.1, 4, 0.6)) * mortarAge;
  vec3 mLime = owSRGB(vec3(0.442, 0.420, 0.375));
  vec3 mCement = owSRGB(vec3(0.352, 0.352, 0.348));
  vec3 mortarCol = mix(mLime, mCement, repoint);
  mortarCol *= 0.84 + 0.32 * mSand;
  mortarCol *= 0.88 + 0.24 * owFbm01(p * 6.0, P * 6.0, 4, 0.6);
  mortarCol = mix(mortarCol, mortarCol * 0.62, smoothstep(0.5, 0.06, mGrain.x) * 0.40);

  float jointDepth = mix(0.09, 0.20, mortarAge) + 0.05 * owFbm01(p * 1.2, P * 1.2, 3, 0.5);
  // Eroded mortar does not recede evenly: it washes out in bays and leaves
  // shoulders of hard cement pointing where somebody patched it.
  float wash = smoothstep(0.35, 0.80, owFbm01(p * 4.0 + 11.0, P * 4.0, 4, 0.55)) * mortarAge;
  jointDepth += wash * 0.13 * (1.0 - repoint);
  float mortarH = -(mSand - 0.5) * 0.020 - smoothstep(0.5, 0.0, mGrain.x) * 0.014;

  // ---------------- the brick face ----------------
  float faceN = owFbm01(bp * 2.2, BP, 5, 0.5);
  float faceFine = owFbm01(bp * 5.0, BP * 2.0, 4, 0.5);
  float faceGrain = owFbm01(bp * 8.0, BP * 4.0, 4, 0.55);
  vec4 facePore = owWorley(bp * 7.0, BP * 3.5, 1.0);
  float poreCluster = smoothstep(0.42, 0.78, owFbm01(bp * 3.0 + 8.0, BP * 1.5, 4, 0.55));
  float pore = smoothstep(0.26 + 0.16 * facePore.z, 0.0, facePore.x) * step(0.55, facePore.w) * poreCluster;

  // Three stocks. Pittsburgh common is a hard, dark, iron-spotted red that goes
  // almost purple in the over-fired headers; the buff is the Kittanning yellow
  // you see on the North Side.
  vec3 rA = owSRGB(vec3(0.408, 0.202, 0.148));   // red common
  vec3 rB = owSRGB(vec3(0.292, 0.152, 0.122));   // deep red
  vec3 rC = owSRGB(vec3(0.176, 0.116, 0.108));   // over-fired header
  vec3 yA = owSRGB(vec3(0.520, 0.442, 0.316));   // buff
  vec3 yB = owSRGB(vec3(0.412, 0.348, 0.244));
  vec3 dA = owSRGB(vec3(0.212, 0.166, 0.150));   // iron spot
  vec3 dB = owSRGB(vec3(0.148, 0.118, 0.112));

  vec3 red = mix(rA, rB, rnd.z);
  red = mix(red, rC, step(0.86, rnd.w) * 0.75);
  vec3 buff = mix(yA, yB, rnd.z);
  vec3 drk = mix(dA, dB, rnd.z);
  vec3 brick = mix(mix(red, buff, clamp(stock * 2.0, 0.0, 1.0)),
                   drk, clamp(stock * 2.0 - 1.0, 0.0, 1.0));
  // Kiln position decides shade, and a wall is laid straight off the pallet,
  // so neighbours differ by up to a quarter of a stop.
  brick *= 0.86 + 0.28 * rnd3.x;
  brick *= 0.86 + 0.28 * faceN;
  brick *= 0.87 + 0.26 * faceGrain;
  brick = mix(brick, brick * 1.22, smoothstep(0.55, 0.9, faceFine) * 0.5);
  // manganese iron spots — small, black, glassy, and the signature of the stock
  float ironSpot = smoothstep(0.20, 0.02, facePore.y) * step(0.82, facePore.z);
  brick = mix(brick, brick * 0.30, ironSpot * 0.85);
  brick = mix(brick, brick * 0.62, pore * 0.85);
  // sand-struck skin: a pale bloom on the smoother bricks
  brick = mix(brick, owSRGB(vec3(0.60, 0.56, 0.48)), smoothstep(0.86, 0.98, faceFine) * 0.30);

  float faceH = 0.74 + (faceN - 0.5) * 0.05 + (faceFine - 0.5) * 0.025 + (rnd2.z - 0.5) * 0.05;
  faceH -= pore * 0.075;

  float edgeD = min(dxj / JX, dyj / JY);
  float chipNoise = owFbm01(bp * 6.0 + 3.0, BP * 3.0, 4, 0.5);
  float chip = smoothstep(1.7, 0.30, edgeD) * smoothstep(0.60, 0.80, chipNoise)
             * step(0.70 - mortarAge * 0.20, rnd3.z);
  faceH -= chip * 0.17;
  brick = mix(brick, brick * 0.72 + owSRGB(vec3(0.22, 0.15, 0.10)), chip * 0.65);

  // Spalled faces: freeze-thaw pops the fired skin off and the soft pale core
  // shows. On a north wall in Pittsburgh this is on every third brick.
  float spall = step(0.90 - mortarAge * 0.14, rnd2.w)
              * smoothstep(0.40, 0.62, owFbm01(bp * 2.6 + 4.0, BP * 1.3, 4, 0.55));
  faceH -= spall * 0.10;
  brick = mix(brick, brick * 0.62 + owSRGB(vec3(0.30, 0.22, 0.17)), spall * 0.80);

  // ---------------- combine ----------------
  float m = face;
  h = mix(0.74 - jointDepth + mortarH, faceH, m);
  vec3 c = mix(mortarCol, brick, m);
  float brickRough = 0.58 + 0.30 * rnd2.z + (rnd3.y - 0.5) * 0.20;
  rough = mix(0.90 + 0.08 * mSand + 0.06 * (mRough - 0.5),
              brickRough + 0.14 * faceN + 0.10 * (faceGrain - 0.5) + chip * 0.14 + spall * 0.16, m);
  ao = mix(mix(0.34, 0.18, mortarAge), 1.0, smoothstep(0.0, 0.75, face));
  ao -= chip * 0.30;
  metal = 0.0;

  float smear = smoothstep(0.5, 1.0, 1.0 - face)
              * smoothstep(0.55, 0.9, owFbm01(p * 14.0, P * 14.0, 4, 0.5)) * (1.0 - mortarAge * 0.6);
  c = mix(c, mortarCol * 1.05, smear * 0.5);

  // ---------------- soot ----------------
  // A CARBON FILM, not a grey wash. It bonds where rain cannot reach and is
  // scoured to nothing where it can, so it produces high contrast: black under
  // every projection, clean on every washed face. Getting this pattern right is
  // most of what makes a city look like it burned coal for a century.
  float sootField = owFbm01(owWarp(p * 1.7 + 43.0, P * 1.7, 0.9, 3), P * 1.7, 5, 0.58);
  // it keys into the mortar and the pores far harder than into the fired skin
  float key = mix(1.0, 0.45, m) + pore * 0.6 + (1.0 - smoothstep(0.3, 0.8, faceGrain)) * 0.35;
  float sootM = clamp(soot * smoothstep(0.28, 0.80, sootField) * key, 0.0, 1.0);
  // rain-washed streaks cutting down through it
  float washed = smoothstep(0.55, 0.86, owFbm01(vec2(p.x * 5.0, p.y * 1.1), vec2(P.x * 5.0, max(P.y, 1.0)), 5, 0.55));
  sootM *= 1.0 - washed * 0.75 * soot;
  c = mix(c, owSRGB(vec3(0.038, 0.036, 0.034)), sootM * 0.88);
  rough = mix(rough, 0.95, sootM * 0.5);
  // and where it HAS washed, the brick under it is bright and clean
  c = mix(c, c * 1.20, washed * soot * 0.35);

  // ---------------- efflorescence + damp ----------------
  float efflo = smoothstep(0.62, 0.96, owFbm01(owWarp(p * 2.6, P * 2.6, 0.8, 3), P * 2.6, 4, 0.5));
  efflo *= mix(1.0, 0.35, m) * (1.0 - soot * 0.6) * (0.4 + 0.8 * mortarAge);
  c = mix(c, owSRGB(vec3(0.68, 0.672, 0.652)), efflo * 0.55);
  rough += efflo * 0.10;

  // stepped cracks through the joints — brick cracks at the mortar, not across
  float crack = owCracks(p * 2.2, P * 2.2, 0.85, 0.036, 0.62 - mortarAge * 0.14);
  crack *= mix(0.35, 1.0, 1.0 - m);
  h -= crack * 0.10;
  ao -= crack * 0.45;
  c = mix(c, c * 0.32, crack * 0.7);

  float cavity = 1.0 - smoothstep(0.52, 0.76, h);
  c = mix(c, owSRGB(vec3(0.14, 0.13, 0.12)), cavity * 0.34);

  alb = clamp(c, vec3(0.02), vec3(0.85));
  rough = clamp(rough, 0.35, 0.99);
  ao = clamp(ao, 0.10, 1.0);
  h = clamp(h, 0.0, 1.0);
}
`;

/**
 * GLAZED CURTAIN WALL — the Golden Triangle.
 *
 * A tower is not a glass box: it is a grid of mullions and transoms holding
 * vision glass over opaque spandrel panels, every unit slightly out of plane,
 * with blinds at random heights behind half of them. The out-of-plane wobble is
 * what makes a real tower's reflection break up into a mosaic instead of
 * sliding across it like a mirror, and it is the whole reason a procedural
 * skyline reads as CGI without it.
 *
 * uParam.x  units across the tile (defaults to 4)
 * uParam.y  spandrel 0..1  the fraction of each floor that is opaque panel
 * uParam.z  reflectivity 0..1  clear vision glass -> a hard bronze mirror
 * uParam.w  age 0..1  gasket failure, seal blowout, dirt
 */
export const CURTAIN_GLASS = /* glsl */ `
void owSurface(vec2 uv, out vec3 alb, out float h, out float rough, out float metal, out float ao){
  const vec2 P = vec2(8.0);
  vec2 p = uv * P + uSeed * 2.4;
  float units = max(uParam.x, 1.0);
  float spandrelH = clamp(uParam.y, 0.05, 0.9);
  float refl = clamp(uParam.z, 0.0, 1.0);
  float age = clamp(uParam.w, 0.0, 1.0);

  vec2 g = uv * vec2(units, units);
  vec2 gid = floor(g);
  vec2 gf = fract(g);
  vec4 rnd = owHash42(gid + uSeed * 1.6);
  vec4 rnd2 = owHash42(gid * 2.7 + 9.0 + uSeed);

  // ---- the frame ---------------------------------------------------------
  // Anodised aluminium mullions: 60 mm caps standing 25 mm proud, with a
  // brushed finish and a hard shadow line each side.
  float mx = min(gf.x, 1.0 - gf.x);
  float my = min(gf.y, 1.0 - gf.y);
  float mull = 1.0 - smoothstep(0.030, 0.042, mx);
  float tran = 1.0 - smoothstep(0.030, 0.042, my);
  float frame = clamp(mull + tran, 0.0, 1.0);
  float brush = owFbm01(owShear(p * 6.0, 0.0, 26.0), owShearPer(P * 6.0, 26.0), 4, 0.5);
  vec3 frameC = owSRGB(vec3(0.180, 0.182, 0.188)) * (0.88 + 0.24 * brush);
  float frameR = 0.32 + brush * 0.16;

  // the gasket: black EPDM, matt, that perishes and goes chalky-grey
  float gask = max(smoothstep(0.030, 0.046, mx) - smoothstep(0.046, 0.060, mx),
                   smoothstep(0.030, 0.046, my) - smoothstep(0.046, 0.060, my));
  vec3 gaskC = mix(owSRGB(vec3(0.055, 0.055, 0.058)), owSRGB(vec3(0.230, 0.228, 0.222)), age * 0.7);

  // ---- vision glass vs spandrel -----------------------------------------
  float isSpandrel = step(gf.y, spandrelH);
  // Spandrel panels are back-painted glass over insulation: an opaque, slightly
  // duller version of the vision glass, and their colour is the second thing
  // that reads on a tower after its silhouette.
  vec3 visionC = mix(owSRGB(vec3(0.030, 0.038, 0.042)), owSRGB(vec3(0.075, 0.085, 0.078)), refl);
  vec3 spanC = mix(owSRGB(vec3(0.055, 0.062, 0.068)), owSRGB(vec3(0.100, 0.092, 0.070)), refl);
  float visionR = mix(0.045, 0.020, refl);
  float spanR = 0.10 + 0.10 * rnd.y;

  vec3 c = mix(visionC, spanC, isSpandrel);
  float r = mix(visionR, spanR, isSpandrel);
  // Reflective coatings are a metal film — sputtered titanium or steel — so a
  // mirrored tower really is part-metal, and treating it as a dielectric is why
  // procedural glass towers look like blue plastic.
  // A reflective coating is a sputtered metal film; clear float glass is a
  // dielectric. Threshold rather than ramp, so nothing sits in between.
  float coated = smoothstep(0.18, 0.62, refl);
  metal = mix(coated, coated * 0.35, isSpandrel);
  h = 0.62;
  ao = 1.0;

  // ---- per-unit variation ------------------------------------------------
  // Every unit is glazed by hand: a millimetre or two out of plane, and its
  // coating batch is a shade different. Both are essential — they are what
  // shatter the reflection into a mosaic.
  h += (rnd.x - 0.5) * 0.055 * (1.0 - isSpandrel);
  c *= 0.90 + 0.20 * rnd.z;
  r *= 0.85 + 0.30 * rnd.w;

  // ---- what is behind the glass -----------------------------------------
  // Blinds at a random height in about half the units, plus the odd lit ceiling
  // and the dark of an empty floor. Behind-glass content is what tells you a
  // tower is occupied.
  float hasBlind = step(0.42, rnd2.x) * (1.0 - isSpandrel);
  float blindDrop = 0.25 + 0.65 * rnd2.y;
  float blind = hasBlind * step(gf.y, blindDrop);
  float slats = 1.0 - smoothstep(0.25, 0.75, abs(fract(gf.y * 42.0) - 0.5) * 2.0);
  vec3 blindC = mix(owSRGB(vec3(0.300, 0.294, 0.276)), owSRGB(vec3(0.150, 0.152, 0.158)), rnd2.z);
  c = mix(c, blindC * (0.80 + 0.30 * slats), blind * (1.0 - refl * 0.65) * 0.72);
  r = mix(r, 0.55, blind * (1.0 - refl * 0.65) * 0.5);
  // a ceiling grid glimpsed at the head of an unblinded unit
  float ceil = (1.0 - hasBlind) * (1.0 - isSpandrel) * smoothstep(0.80, 0.92, gf.y);
  c = mix(c, owSRGB(vec3(0.175, 0.172, 0.162)), ceil * (1.0 - refl * 0.7) * 0.55);

  // ---- age ---------------------------------------------------------------
  // Failed double-glazing units go milky between the panes and never come back;
  // it is one unit in thirty and it is instantly recognisable.
  float blown = step(0.965 - age * 0.05, rnd2.w) * (1.0 - isSpandrel);
  float milk = blown * smoothstep(0.15, 0.75, owFbm01(gf * 6.0 + rnd.xy * 20.0, vec2(48.0), 4, 0.55));
  c = mix(c, owSRGB(vec3(0.330, 0.336, 0.340)), milk * 0.75);
  r = mix(r, 0.42, milk * 0.8);
  metal *= 1.0 - milk;

  // ---- dirt --------------------------------------------------------------
  // Facade cleaners run a cradle down the building, so the dirt is banded
  // VERTICALLY between drops and thickest at the head of each pane where the
  // water runs off the transom.
  float band = smoothstep(0.55, 0.9, owFbm01(vec2(p.x * 1.6, p.y * 0.25), vec2(P.x * 1.6, max(P.y * 0.5, 1.0)), 4, 0.6));
  float head = smoothstep(0.72, 1.0, gf.y) * 0.8;
  float run = smoothstep(0.45, 0.85, owFbm01(vec2(p.x * 7.0, p.y * 0.8), vec2(P.x * 7.0, max(P.y, 1.0)), 5, 0.55));
  float dirt = clamp((0.35 * band + head + 0.55 * run) * (0.25 + 0.9 * age), 0.0, 1.0);
  c = mix(c, owSRGB(vec3(0.185, 0.180, 0.168)), dirt * 0.30);
  r += dirt * 0.14;
  metal *= 1.0 - dirt * 0.55;

  // ---- assemble ----------------------------------------------------------
  c = mix(c, frameC, frame);
  r = mix(r, frameR, frame);
  metal = mix(metal, 0.92, frame * 0.85);
  h = mix(h, 0.86 + (brush - 0.5) * 0.01, frame);
  c = mix(c, gaskC, gask * 0.9);
  r = mix(r, 0.78, gask * 0.85);
  metal *= 1.0 - gask * 0.9;
  h -= gask * 0.055;
  ao = 1.0 - gask * 0.45 - frame * 0.0;

  // sealant failure: a bead of silicone squeezed out and greyed
  float bead = gask * smoothstep(0.45, 0.80, owFbm01(p * 8.0, P * 8.0, 4, 0.55)) * age;
  c = mix(c, owSRGB(vec3(0.320, 0.315, 0.300)), bead * 0.55);
  h += bead * 0.02;

  // bird strike / hard-water spotting on the glass
  vec4 sp = owWorley(p * 15.0, P * 15.0, 1.0);
  float spot = max(smoothstep(0.18, 0.11, sp.x) - smoothstep(0.10, 0.03, sp.x), 0.0) * step(0.55, sp.z);
  r += spot * (1.0 - frame) * 0.22 * (0.3 + 0.8 * age);

  alb = clamp(c, vec3(0.02), vec3(0.72));
  rough = clamp(r, 0.015, 0.95);
  metal = clamp(metal, 0.0, 1.0);
  ao = clamp(ao, 0.35, 1.0);
  h = clamp(h, 0.0, 1.0);
}
`;

/**
 * PRECAST CONCRETE PANEL — 1960s-80s commercial, parking structures, the
 * podiums under the towers.
 *
 * uParam.x  finish 0 = smooth form face, 1 = exposed aggregate (retarded wash)
 * uParam.y  ribs 0..1  the vertical fluting of a hammered/ribbed panel
 * uParam.z  age 0..1
 * uParam.w  panels across the tile (defaults to 1)
 */
export const PRECAST = /* glsl */ `
void owSurface(vec2 uv, out vec3 alb, out float h, out float rough, out float metal, out float ao){
  const vec2 P = vec2(8.0);
  vec2 p = uv * P + uSeed * 6.6;
  float exposed = clamp(uParam.x, 0.0, 1.0);
  float ribAmt = clamp(uParam.y, 0.0, 1.0);
  float age = clamp(uParam.z, 0.0, 1.0);
  float panels = max(uParam.w, 1.0);

  float macro = owFbm01(p * 0.55, P * 0.55, 4, 0.6);
  float mid   = owFbm01(owWarp(p * 2.2, P * 2.2, 0.6, 3), P * 2.2, 5, 0.5);
  float fine  = owFbm01(p * 17.0, P * 17.0, 4, 0.5);

  // Precast is a controlled mix, so it is paler and more even than site-poured
  // concrete — and that evenness is exactly why it needs its panel-to-panel
  // variation to be real, or a whole elevation is one flat value.
  vec3 cPale = owSRGB(vec3(0.575, 0.566, 0.545));
  vec3 cMid  = owSRGB(vec3(0.435, 0.430, 0.418));
  vec3 cDark = owSRGB(vec3(0.245, 0.243, 0.240));
  vec3 c = mix(cPale, cMid, smoothstep(0.25, 0.85, macro * 0.6 + age * 0.5));
  c *= 0.94 + 0.12 * fine;

  h = 0.70 + (mid - 0.5) * 0.04 + (fine - 0.5) * 0.02;
  rough = 0.82 + (mid - 0.5) * 0.12;
  metal = 0.0;
  ao = 1.0;

  // ---- panel joints ------------------------------------------------------
  // A 20 mm gap with a backer rod and a silicone bead. The bead is a different
  // material with its own gloss, it holds dirt, and it is the ONLY thing that
  // gives a precast elevation its scale from across a street.
  vec2 pg = uv * vec2(panels, panels * 1.4);
  vec2 pid = floor(pg);
  vec2 pf = fract(pg);
  vec4 rnd = owHash42(pid + uSeed * 2.2);
  c *= 0.90 + 0.20 * rnd.x;            // each panel came off a different bed
  rough += (rnd.y - 0.5) * 0.08;
  h += (rnd.z - 0.5) * 0.030;          // and hangs a few millimetres out

  vec2 dj = min(pf, 1.0 - pf);
  float jm = min(dj.x, dj.y);
  float gap = 1.0 - smoothstep(0.006, 0.014, jm);
  float bead = smoothstep(0.004, 0.010, jm) * (1.0 - smoothstep(0.010, 0.018, jm));
  h -= gap * 0.10;
  ao -= gap * 0.60;
  c = mix(c, cDark * 0.55, gap * 0.75);
  // the silicone itself: matt grey-black, slightly proud, gone chalky with age
  vec3 sil = mix(owSRGB(vec3(0.135, 0.133, 0.130)), owSRGB(vec3(0.300, 0.296, 0.286)), age * 0.7);
  c = mix(c, sil, bead * 0.8);
  rough = mix(rough, 0.62, bead * 0.7);
  h += bead * 0.020;

  // ---- form face ---------------------------------------------------------
  // Steel-formed concrete is glassy where it touched the mould and pitted where
  // air was trapped against it; the bug holes are the tell.
  vec4 bug = owWorley(p * 20.0, P * 20.0, 1.0);
  float bugM = smoothstep(0.20, 0.0, bug.x) * step(0.78, bug.w);
  h -= bugM * 0.06;
  ao -= bugM * 0.55;
  rough += bugM * 0.10;
  // and the form itself leaves a faint grid of tie points and sheet joints
  float sheet = (1.0 - smoothstep(0.0, 0.006, abs(fract(uv.y * 3.0) - 0.5)))
              + (1.0 - smoothstep(0.0, 0.006, abs(fract(uv.x * 2.0) - 0.5)));
  sheet = clamp(sheet, 0.0, 1.0) * (1.0 - exposed);
  h -= sheet * 0.020;
  c *= 1.0 - sheet * 0.06;

  // ---- exposed aggregate -------------------------------------------------
  // A retarder is painted into the mould and the skin is washed off, leaving
  // rounded river gravel standing 3-4 mm proud. It is a completely different
  // material read: coarse, mottled, and it never looks flat.
  {
    vec2 ap = owWarp(p, P, 0.08, 3);
    vec4 a1 = owWorley(ap * 11.0, P * 11.0, 1.0);
    vec4 a2 = owWorley(ap * 19.0 + 5.0, P * 19.0, 1.0);
    float m1 = smoothstep(0.40, 0.10, a1.x);
    float m2 = smoothstep(0.34, 0.08, a2.x) * step(0.35, a2.w);
    vec3 s1 = owSRGB(vec3(0.480, 0.452, 0.408));
    vec3 s2 = owSRGB(vec3(0.268, 0.252, 0.240));
    vec3 s3 = owSRGB(vec3(0.620, 0.590, 0.545));
    vec3 s4 = owSRGB(vec3(0.360, 0.286, 0.230));
    vec3 stone = mix(s1, s2, a1.z);
    stone = mix(stone, s3, step(0.82, a1.w));
    stone = mix(stone, s4, step(0.88, a2.z) * 0.7);
    vec3 matrix = cMid * 0.82;
    vec3 ec = mix(matrix, stone, clamp(m1 * 0.85 + m2 * 0.5, 0.0, 1.0));
    float eh = 0.62 + m1 * 0.20 * (0.55 + 0.6 * a1.z) + m2 * 0.08;
    float er = mix(0.94, 0.58 + 0.24 * a1.z, clamp(m1 * 0.9 + m2 * 0.4, 0.0, 1.0));
    float eao = 1.0 - smoothstep(0.42, 0.70, a1.x) * 0.30;
    c = mix(c, ec, exposed);
    h = mix(h, eh + (rnd.z - 0.5) * 0.030, exposed);
    rough = mix(rough, er, exposed);
    ao = mix(ao, eao, exposed);
  }

  // ---- vertical ribs -----------------------------------------------------
  // Hammered rib panels: a 40 mm pitch of half-round flutes whose crowns were
  // broken off with a bush hammer, so the crown is coarse and pale and the
  // valley is smooth and dark.
  {
    float t = uv.x * 48.0;
    float w = abs(fract(t) - 0.5) * 2.0;
    float flute = 1.0 - w * w;
    float crown = smoothstep(0.55, 0.95, flute);
    float hammered = crown * smoothstep(0.35, 0.75, owFbm01(p * 14.0, P * 14.0, 4, 0.5));
    h += (flute - 0.5) * 0.24 * ribAmt;
    h += hammered * 0.05 * ribAmt;
    c = mix(c, c * 1.16, hammered * ribAmt * 0.6);
    c = mix(c, c * 0.82, (1.0 - crown) * ribAmt * 0.35);
    rough += hammered * 0.10 * ribAmt;
    ao -= (1.0 - flute) * 0.28 * ribAmt;
  }

  // ---- weathering --------------------------------------------------------
  // Precast streaks BADLY: the cement leaches and leaves pale calcite runs, and
  // the dirt runs dark between them, so an old panel is vertically striped.
  float leach = smoothstep(0.55, 0.88, owFbm01(vec2(p.x * 4.5, p.y * 0.8), vec2(P.x * 4.5, max(P.y, 1.0)), 5, 0.55));
  c = mix(c, cPale * 1.10, leach * age * 0.35);
  float soil = smoothstep(0.50, 0.90, owFbm01(vec2(p.x * 6.5 + 3.0, p.y * 0.7), vec2(P.x * 6.5, max(P.y, 1.0)), 5, 0.55));
  c *= 1.0 - soil * age * 0.24;
  rough += soil * age * 0.06;

  // rust bleeding out of a corroding tie or a spalled corner
  float spallF = owFbm01(p * 1.6 + 27.0, P * 1.6, 4, 0.6);
  float spall = smoothstep(0.80, 0.90, spallF) * age;
  h -= spall * 0.11;
  ao -= spall * 0.35;
  c = mix(c, cDark * 0.9, spall * 0.6);
  float bleed = smoothstep(0.45, 0.9, owFbm01(vec2(p.x * 5.0, p.y * 1.0), vec2(P.x * 5.0, max(P.y, 1.0)), 4, 0.55))
              * smoothstep(0.70, 0.86, spallF) * age;
  c = mix(c, owSRGB(vec3(0.400, 0.230, 0.120)), bleed * 0.45);

  float cavity = 1.0 - smoothstep(0.50, 0.74, h);
  c = mix(c, owSRGB(vec3(0.180, 0.175, 0.168)), cavity * 0.34);

  alb = clamp(c, vec3(0.02), vec3(0.86));
  rough = clamp(rough, 0.30, 0.99);
  ao = clamp(ao, 0.18, 1.0);
  h = clamp(h, 0.0, 1.0);
}
`;

/**
 * STONE CLADDING — ashlar limestone and sandstone. Banks, churches, courthouse,
 * and the base of everything downtown.
 *
 * uParam.x  course height fraction (0.5 = tall ashlar, 1.5 = thin band coursing)
 * uParam.y  tooling 0 = sawn smooth · 0.5 = bush-hammered · 1 = rock-faced
 * uParam.z  soot 0..1
 * uParam.w  stone 0 = grey limestone, 1 = warm sandstone
 */
export const STONE_CLAD = /* glsl */ `
void owSurface(vec2 uv, out vec3 alb, out float h, out float rough, out float metal, out float ao){
  const vec2 P = vec2(8.0);
  vec2 p = uv * P + uSeed * 11.9;
  float courseK = max(uParam.x, 0.2);
  float tooling = clamp(uParam.y, 0.0, 1.0);
  float soot = clamp(uParam.z, 0.0, 1.0);
  float warm = clamp(uParam.w, 0.0, 1.0);

  // ---- coursing ----------------------------------------------------------
  const float COLS = 3.0;
  float ROWS = 5.0 * courseK;
  float rowF = uv.y * ROWS;
  float row = floor(rowF);
  // Ashlar is laid in courses of equal height but random length — the vertical
  // joints must never line up and must never be evenly spaced.
  float lenR = owHash11(row * 3.71 + uSeed);
  float cols = COLS * (0.8 + 0.5 * lenR);
  float colF = uv.x * cols + lenR * 3.0;
  float col = floor(colF);
  vec2 id = vec2(mod(col, cols), row);
  vec2 f = vec2(fract(colF), fract(rowF));
  vec4 rnd = owHash42(id + uSeed * 4.0);
  vec4 rnd2 = owHash42(id * 1.9 + 17.0 + uSeed);

  // A fine ashlar joint is 4-6 mm — much tighter than brick, and getting it
  // tight is what separates a bank from a garden wall.
  float JX = 0.012 + 0.008 * rnd.x;
  float JY = 0.030 + 0.020 * rnd.y;
  float dxj = min(f.x, 1.0 - f.x);
  float dyj = min(f.y, 1.0 - f.y);
  float ex = smoothstep(JX * 0.55, JX * 1.05, dxj);
  float ey = smoothstep(JY * 0.55, JY * 1.05, dyj);
  float face = min(ex, ey);

  // ---- the stone ---------------------------------------------------------
  vec2 bp = f * vec2(2.2, 1.0) + rnd.zw * 21.0;
  vec2 BP = vec2(26.0);
  float bed = owFbm01(vec2(bp.x * 1.4, bp.y * 5.0), vec2(BP.x, BP.y * 5.0), 5, 0.55);
  float grain = owFbm01(bp * 4.0, BP * 1.5, 5, 0.5);
  float fineG = owFbm01(bp * 10.0, BP * 3.0, 4, 0.5);
  vec4 shell = owWorley(bp * 9.0, BP * 3.0, 1.0);

  vec3 lA = owSRGB(vec3(0.545, 0.532, 0.500));   // grey limestone
  vec3 lB = owSRGB(vec3(0.420, 0.412, 0.392));
  vec3 sA = owSRGB(vec3(0.552, 0.470, 0.360));   // warm sandstone
  vec3 sB = owSRGB(vec3(0.418, 0.340, 0.248));
  vec3 c = mix(mix(lA, lB, rnd.z), mix(sA, sB, rnd.z), warm);
  // every block came out of a different bed of the quarry
  c *= 0.88 + 0.24 * rnd2.x;
  // sedimentary bedding planes running horizontally through the block
  c *= 0.90 + 0.20 * bed;
  c *= 0.93 + 0.14 * grain;
  // fossil / shell inclusions in the limestone, iron nodules in the sandstone
  c = mix(c, c * 1.35, smoothstep(0.24, 0.03, shell.x) * step(0.62, shell.z) * (1.0 - warm) * 0.55);
  c = mix(c, c * vec3(0.85, 0.70, 0.55), smoothstep(0.20, 0.02, shell.y) * step(0.80, shell.w) * warm * 0.7);

  float faceH = 0.78 + (grain - 0.5) * 0.03 + (bed - 0.5) * 0.02 + (rnd2.y - 0.5) * 0.030;
  float faceR = 0.68 + grain * 0.18 + (rnd2.z - 0.5) * 0.14;

  // ---- tooling -----------------------------------------------------------
  // Bush-hammered stone is a field of small pyramidal bruises; rock-faced
  // ("pitched") stone has a proud, irregular boss with a drafted margin round
  // it. Both are hugely important reads at street level.
  {
    vec4 bh = owWorley(bp * 14.0, BP * 4.0, 1.0);
    float bruise = smoothstep(0.34, 0.06, bh.x);
    float hammer = smoothstep(0.0, 0.55, tooling) * (1.0 - smoothstep(0.55, 1.0, tooling));
    faceH += bruise * 0.055 * hammer;
    c *= 1.0 + (bruise - 0.35) * 0.16 * hammer;
    faceR += bruise * 0.10 * hammer;

    float rocky = smoothstep(0.5, 1.0, tooling);
    float margin = smoothstep(0.030, 0.075, min(dxj, dyj));
    float boss = owFbm01(bp * 3.0 + 7.0, BP, 4, 0.6);
    faceH += (boss - 0.4) * 0.30 * rocky * margin;
    faceH -= (1.0 - margin) * 0.03 * rocky;
    c *= 1.0 + (boss - 0.5) * 0.20 * rocky;
    faceR += (1.0 - boss) * 0.14 * rocky;
    // the drafted margin is chiselled and pale
    float draft = (1.0 - margin) * rocky;
    c = mix(c, c * 1.12, draft * 0.4);
    faceR += draft * 0.06;
  }

  // saw marks on the sawn faces — faint, parallel, only visible in raking light
  float saw = owScratches(bp * 1.4, BP * 0.7, 26.0, 0.0, 0.66) * (1.0 - tooling);
  faceH -= saw * 0.006;
  c *= 1.0 - saw * 0.03;

  // ---- joint -------------------------------------------------------------
  float mSand = owFbm01(p * 20.0, P * 20.0, 4, 0.5);
  vec3 mortarCol = owSRGB(vec3(0.470, 0.458, 0.432)) * (0.84 + 0.32 * mSand);
  float m = face;
  h = mix(0.72 - 0.055 + (mSand - 0.5) * 0.012, faceH, m);
  c = mix(mortarCol, c, m);
  rough = mix(0.92, faceR, m);
  ao = mix(0.32, 1.0, smoothstep(0.0, 0.75, face));
  metal = 0.0;

  // ---- soot and washing --------------------------------------------------
  // On carved stone the soot is what shows the carving: black in every recess,
  // scrubbed white on every projection.
  float cav = 1.0 - smoothstep(0.62, 0.86, h);
  float sootField = owFbm01(owWarp(p * 1.5 + 51.0, P * 1.5, 0.9, 3), P * 1.5, 5, 0.58);
  float sootM = clamp(soot * (smoothstep(0.30, 0.78, sootField) * 0.7 + cav * 1.1), 0.0, 1.0);
  float washed = smoothstep(0.55, 0.88, owFbm01(vec2(p.x * 4.0, p.y * 0.9), vec2(P.x * 4.0, max(P.y, 1.0)), 5, 0.55));
  sootM *= 1.0 - washed * 0.7;
  c = mix(c, owSRGB(vec3(0.045, 0.043, 0.040)), sootM * 0.85);
  rough = mix(rough, 0.94, sootM * 0.45);
  // gypsum crust: where soot and sulphur have eaten into the stone it blisters
  // into a hard black skin that then falls off, showing bright stone beneath.
  float crust = smoothstep(0.68, 0.80, sootField) * soot;
  float shed = smoothstep(0.55, 0.72, owFbm01(p * 5.0 + 13.0, P * 5.0, 4, 0.55)) * crust;
  c = mix(c, c * 1.9 + 0.02, shed * 0.55);
  h -= shed * 0.05;
  rough += shed * 0.10;

  // biological growth in the sheltered damp
  float algae = smoothstep(0.72, 0.94, owFbm01(p * 3.4 + 29.0, P * 3.4, 5, 0.6)) * (1.0 - soot * 0.5);
  c = mix(c, owSRGB(vec3(0.152, 0.170, 0.118)), algae * 0.35);

  alb = clamp(c, vec3(0.02), vec3(0.88));
  rough = clamp(rough, 0.32, 0.99);
  ao = clamp(ao, 0.14, 1.0);
  h = clamp(h, 0.0, 1.0);
}
`;

/**
 * PAINTED TIMBER SIDING — Mt. Washington, Troy Hill, the whole hillside.
 *
 * uParam.x  profile 0 = clapboard/lap · 1 = flush board & batten
 * uParam.y  boards per tile (defaults to 9 => ~150 mm exposure over 1.35 m)
 * uParam.z  paint failure 0..1
 * uParam.w  vinyl 0..1  a modern replacement: no grain, no failure, a seam
 */
export const SIDING = /* glsl */ `
void owSurface(vec2 uv, out vec3 alb, out float h, out float rough, out float metal, out float ao){
  const vec2 P = vec2(8.0);
  vec2 p = uv * P + uSeed * 12.3;
  float batten = clamp(uParam.x, 0.0, 1.0);
  float boards = max(uParam.y, 2.0);
  float fail = clamp(uParam.z, 0.0, 1.0);
  float vinyl = clamp(uParam.w, 0.0, 1.0);

  // ---- the lap -----------------------------------------------------------
  // A clapboard laps over the one below it: the bottom edge of each board
  // stands 8-10 mm proud and throws a hard shadow, and that row of shadows is
  // the entire read of the material at 30 m.
  float bF = uv.y * boards;
  float bId = floor(bF);
  float bf = fract(bF);
  vec4 rnd = owHash42(vec2(bId, floor(uv.x * 2.0)) + uSeed * 2.1);

  float lapEdge = 1.0 - smoothstep(0.0, 0.10, bf);
  float lapShadow = smoothstep(0.0, 0.16, bf) * (1.0 - smoothstep(0.16, 0.30, bf));
  float boardH = 0.66 + (1.0 - bf) * 0.16;         // the wedge section
  boardH += (rnd.x - 0.5) * 0.035;                 // boards cup and bow
  boardH -= lapEdge * 0.03;

  // board & batten: flat boards with a 40 mm batten over every joint
  float bat = 1.0 - smoothstep(0.020, 0.032, abs(fract(uv.x * 6.0) - 0.5));
  float flatH = 0.70 + bat * 0.13 + (rnd.y - 0.5) * 0.02;
  h = mix(boardH, flatH, batten);

  // ---- the paint ---------------------------------------------------------
  // A painted board is a FILM over grain: the grain telegraphs through as a
  // shallow ripple long before the paint fails, and where the paint has gone
  // the bare wood is a completely different value and roughness.
  float grainC = owFbm01(owShear(p * 3.0, 0.0, 26.0), owShearPer(P * 3.0, 26.0), 5, 0.52);
  float grainF = owFbm01(owShear(p * 9.0, 0.0, 30.0), owShearPer(P * 9.0, 30.0), 4, 0.5);
  float brushN = owFbm01(owShear(p * 5.0, 0.0, 14.0), owShearPer(P * 5.0, 14.0), 4, 0.5);

  vec3 paint = uTintA * (0.93 + 0.14 * brushN);
  paint *= 0.88 + 0.24 * rnd.z;                   // boards painted in batches
  // brush marks along the board and the sag where the coat ran
  paint *= 1.0 - (grainC - 0.5) * 0.11 * (1.0 - vinyl);
  h += (grainC - 0.5) * 0.030 * (1.0 - vinyl);
  h += (grainF - 0.5) * 0.012 * (1.0 - vinyl);

  float r = 0.56 + (brushN - 0.5) * 0.18;
  metal = 0.0;
  ao = 1.0;

  // ---- paint failure -----------------------------------------------------
  // House paint does not fade — it CRACKS, curls and flakes off in plates,
  // worst on the south wall and on the top edge of each board where water sits.
  float sun = smoothstep(0.25, 0.85, owFbm01(p * 0.8 + 5.0, P * 0.8, 3, 0.62));
  float alligator = owCracks(p * 8.0, P * 8.0, 0.9, 0.020, 0.60 - fail * 0.20);
  float plate = smoothstep(0.62 - fail * 0.28, 0.78 - fail * 0.22,
                           owFbm01(owWarp(p * 3.0 + 11.0, P * 3.0, 0.8, 3), P * 3.0, 4, 0.55)
                           + lapEdge * 0.35 + sun * 0.30);
  float flake = clamp(plate * fail, 0.0, 1.0) * (1.0 - vinyl);
  float craze = clamp(alligator * fail * 1.2, 0.0, 1.0) * (1.0 - vinyl);

  // bare weathered wood under the failed paint: silver-grey, raised grain
  vec3 bare = mix(owSRGB(vec3(0.372, 0.322, 0.252)), owSRGB(vec3(0.415, 0.402, 0.372)), 0.55);
  bare *= 0.86 + 0.28 * grainC;
  bare *= 0.92 + 0.16 * grainF;
  vec3 c = mix(paint, bare, flake * 0.9);
  r = mix(r, 0.90 + grainF * 0.08, flake * 0.85);
  h -= flake * 0.028;
  h += (grainC - 0.5) * 0.05 * flake;     // raised grain on bare timber
  // the curled lip of a flake catches the light hard
  float lip = plate * (1.0 - plate) * 4.0 * fail * (1.0 - vinyl);
  c *= 1.0 + lip * 0.20;
  h += lip * 0.035;
  ao -= lip * 0.15;
  // crazing that has not yet lifted
  c *= 1.0 - craze * 0.22;
  h -= craze * 0.012;
  r += craze * 0.14;

  // ---- vinyl -------------------------------------------------------------
  // A modern re-side: a shallow embossed woodgrain that repeats every 300 mm,
  // a butt seam every 3.6 m, and a plastic sheen that never quite goes matt.
  {
    float emboss = owFbm01(owShear(vec2(fract(p.x * 0.5) * 12.0, p.y * 3.0), 0.0, 12.0),
                           owShearPer(vec2(12.0, 24.0), 12.0), 4, 0.5);
    vec3 vc = uTintA * (0.96 + 0.08 * emboss);
    c = mix(c, vc, vinyl);
    h = mix(h, mix(boardH, flatH, batten) + (emboss - 0.5) * 0.018, vinyl);
    r = mix(r, 0.42 + (emboss - 0.5) * 0.08, vinyl);
    float seam = 1.0 - smoothstep(0.0, 0.008, abs(fract(uv.x * 1.0 + rnd.w * 0.3) - 0.5));
    c = mix(c, c * 0.88, seam * vinyl * 0.8);
    h -= seam * vinyl * 0.03;
  }

  // ---- nails, shadow, dirt -----------------------------------------------
  float nailX = fract(uv.x * 8.0);
  float nail = (1.0 - smoothstep(0.010, 0.020, length(vec2(nailX - 0.5, bf - 0.72) * vec2(1.0, 0.9))))
             * step(0.25, rnd.w) * (1.0 - batten * 0.6);
  h -= nail * 0.030;
  c = mix(c, c * 0.72, nail * 0.6);
  ao -= nail * 0.30;
  // rust weeping from the nail, streaking down the board below it
  float weep = smoothstep(0.0, 0.35, bf - 0.72) * (1.0 - smoothstep(0.35, 0.9, bf - 0.72))
             * (1.0 - smoothstep(0.012, 0.04, abs(nailX - 0.5))) * step(0.25, rnd.w) * fail;
  c = mix(c, owSRGB(vec3(0.360, 0.212, 0.115)), clamp(weep, 0.0, 1.0) * 0.45);

  // the shadow line under each lap, and the dirt that collects on top of it
  ao -= lapShadow * 0.55 * (1.0 - batten);
  c *= 1.0 - lapShadow * 0.28 * (1.0 - batten);
  float ledge = (1.0 - smoothstep(0.0, 0.055, bf)) * (1.0 - batten);
  c = mix(c, owSRGB(vec3(0.190, 0.180, 0.160)), ledge * 0.35);
  r += ledge * 0.08;

  // mildew on the north wall, and the green line where a gutter overflows
  float damp = smoothstep(0.60, 0.90, owFbm01(p * 2.6 + 19.0, P * 2.6, 5, 0.6)) * (1.0 - sun * 0.6);
  c = mix(c, owSRGB(vec3(0.150, 0.158, 0.128)), damp * 0.30);
  float soil = smoothstep(0.45, 0.90, owFbm01(vec2(p.x * 5.0, p.y * 0.9), vec2(P.x * 5.0, max(P.y, 1.0)), 5, 0.55));
  c *= 1.0 - soil * 0.16;

  float cavity = 1.0 - smoothstep(0.58, 0.80, h);
  c = mix(c, owSRGB(vec3(0.140, 0.132, 0.118)), cavity * 0.32);

  alb = clamp(c, vec3(0.02), vec3(0.88));
  rough = clamp(r, 0.28, 0.99);
  ao = clamp(ao, 0.20, 1.0);
  h = clamp(h, 0.0, 1.0);
}
`;

/**
 * MILL STEEL — riveted heavy plate. Steel Row, the blast furnace, the bridges,
 * every gantry and crane rail in the city. This is the signature material of
 * the whole game.
 *
 * uParam.x  rivets 0..1     the rows of driven rivets and their pattern density
 * uParam.y  rust 0..1
 * uParam.z  paint 0..1      the remains of a lead-oxide or a bridge-green coat
 * uParam.w  scale 0..1      blue-black mill scale still on the plate
 */
export const MILL_STEEL = /* glsl */ `
void owSurface(vec2 uv, out vec3 alb, out float h, out float rough, out float metal, out float ao){
  const vec2 P = vec2(8.0);
  vec2 p = uv * P + uSeed * 7.7;
  float rivetAmt = clamp(uParam.x, 0.0, 1.0);
  float rustAmt = clamp(uParam.y, 0.0, 1.0);
  float paintAmt = clamp(uParam.z, 0.0, 1.0);
  float scaleAmt = clamp(uParam.w, 0.0, 1.0);

  // ---- the plate ---------------------------------------------------------
  // Hot-rolled plate carries a directional roll texture and, where it has not
  // been blasted, a blue-black skin of mill scale that flakes off in plates.
  float roll = owFbm01(owShear(p * 4.0, 1.0, 8.0), owShearPer(P * 4.0, 8.0), 4, 0.5);
  float fine = owFbm01(p * 20.0, P * 20.0, 4, 0.5);
  vec3 steel = owSRGB(vec3(0.320, 0.325, 0.336)) * (0.90 + 0.18 * roll);
  vec3 scaleC = owSRGB(vec3(0.128, 0.130, 0.145)) * (0.86 + 0.28 * fine);
  float scalePlate = smoothstep(0.35, 0.72, owFbm01(owWarp(p * 2.4, P * 2.4, 0.7, 3), P * 2.4, 4, 0.58)) * scaleAmt;
  vec3 c = mix(steel, scaleC, scalePlate);
  float r = mix(0.36 + (roll - 0.5) * 0.16, 0.52 + fine * 0.14, scalePlate);
  metal = 1.0;
  h = 0.74 + (roll - 0.5) * 0.020 + (fine - 0.5) * 0.008;
  h += scalePlate * 0.012;
  ao = 1.0;

  // ---- plate layout ------------------------------------------------------
  // Plates lap over one another with a visible step and a line of rivets down
  // the joint. Nothing on a riveted structure is a continuous surface.
  float lapY = uv.y * 2.0;
  float lapId = floor(lapY);
  float lapF = fract(lapY);
  float plateStep = (owHash11(lapId * 2.3 + uSeed) - 0.5) * 0.06;
  h += plateStep;
  float lapLine = 1.0 - smoothstep(0.0, 0.012, min(lapF, 1.0 - lapF));
  h -= lapLine * 0.05;
  ao -= lapLine * 0.45;

  // ---- RIVETS ------------------------------------------------------------
  // Driven hot and hammered to a dome, so each head is a slightly different
  // shape, sits at a slightly different angle, and has a ring of upset metal
  // round it. Rows at 90 mm pitch, staggered, doubled at the plate laps.
  {
    vec2 rp = vec2(uv.x * 26.0, uv.y * 26.0);
    vec2 rid = floor(rp);
    vec2 rf = fract(rp) - 0.5;
    vec4 rr = owHash42(rid + uSeed * 5.0);
    // rivets live in rows: only the rows near a lap and the two seam rows
    float rowSel = step(0.62, 1.0 - abs(fract(uv.y * 26.0 / 6.5) - 0.5) * 2.0);
    float nearLap = 1.0 - smoothstep(0.02, 0.10, min(lapF, 1.0 - lapF));
    float sel = clamp(rowSel + nearLap, 0.0, 1.0) * step(0.12, rr.x) * rivetAmt;
    vec2 off = (rr.yz - 0.5) * 0.16;
    float d = length((rf - off) * vec2(1.0, 1.0));
    float head = smoothstep(0.34, 0.10, d) * sel;
    float upset = max(smoothstep(0.42, 0.34, d) - smoothstep(0.34, 0.10, d), 0.0) * sel;
    // a hammered dome, not a hemisphere: flattened and lopsided
    float dome = head * (0.72 + 0.5 * rr.w);
    h += dome * 0.16 + upset * 0.03;
    ao -= upset * 0.22;
    c *= 1.0 + head * 0.10 * (rr.w - 0.4);
    // the head is peened, so it is rougher than the plate
    r += head * 0.14;
    // and some rivets have simply gone, leaving an open hole
    float gone = step(0.965, rr.z) * sel;
    float hole = smoothstep(0.22, 0.10, d) * gone;
    h -= hole * 0.5;
    ao -= hole * 0.7;
    c = mix(c, owSRGB(vec3(0.045, 0.042, 0.040)), hole * 0.85);
  }

  // ---- paint -------------------------------------------------------------
  // Structural steel is painted, and the paint fails in sheets from the top
  // down, leaving hard-edged islands with a bright torn lip.
  {
    vec3 topcoat = uTintA;
    vec3 primer = owSRGB(vec3(0.420, 0.222, 0.130));   // red lead
    float peel = owFbm01(p * 18.0, P * 18.0, 4, 0.5);
    float roller = owFbm01(owShear(p * 2.0, 0.0, 3.0), owShearPer(P * 2.0, 3.0), 4, 0.5);
    vec3 pc = topcoat * (0.90 + 0.16 * roller) * (0.96 + 0.08 * peel);
    float lossF = owFbm01(owWarp(p * 2.0 + 4.0, P * 2.0, 0.9, 3), P * 2.0, 5, 0.55);
    float loss = smoothstep(0.40, 0.62, lossF * 0.7 + rustAmt * 0.55 + (1.0 - paintAmt) * 0.75);
    float pm = paintAmt * (1.0 - loss);
    float primerBand = paintAmt * max(smoothstep(0.36, 0.52, lossF * 0.7 + rustAmt * 0.55) - loss, 0.0);
    c = mix(c, pc, pm * 0.94);
    r = mix(r, 0.46 + (peel - 0.5) * 0.20, pm * 0.9);
    metal = mix(metal, 0.0, pm * 0.95);
    h += pm * 0.020;
    c = mix(c, primer * (0.9 + 0.2 * peel), primerBand * 0.75);
    r = mix(r, 0.72, primerBand * 0.7);
    metal = mix(metal, 0.0, primerBand * 0.9);
    // the torn edge of a sheet of paint
    float lip = paintAmt * max(pm * (1.0 - pm) * 4.0, 0.0);
    c *= 1.0 + lip * 0.16;
    h += lip * 0.030;
    ao -= lip * 0.12;
  }

  // ---- RUST --------------------------------------------------------------
  // On mill steel rust is not a tint: it is a LAYER with thickness. It blooms,
  // laminates, lifts in plates several millimetres thick and eventually falls
  // off leaving a pitted crater. Metalness must go to 0 wherever it covers.
  {
    vec2 wp = owWarp(p * 1.3, P * 1.3, 1.2, 4);
    float bloom = 1.0 - owBillow(wp, P * 1.3, 5, 0.6);
    float spread = owFbm01(p * 0.6 + 12.0, P * 0.6, 3, 0.6);
    float rust = smoothstep(0.34, 0.74, bloom * (0.45 + 0.95 * spread) + rustAmt * 0.45 - 0.25);
    rust *= rustAmt;
    float grain = owFbm01(p * 22.0, P * 22.0, 4, 0.55);
    float age = owFbm01(p * 0.85 + 21.0, P * 0.85, 4, 0.62);
    vec3 rc = owRustColour(age * 0.8 + rust * 0.3, grain);

    // laminating scale: the rust lifts in concentric plates
    float lam = owWorley(p * 9.0, P * 9.0, 1.0).x;
    float plateM = smoothstep(0.30, 0.10, lam) * smoothstep(0.30, 0.60, rust) * (1.0 - smoothstep(0.85, 1.0, rust));
    c = mix(c, rc, rust);
    metal = mix(metal, 0.0, smoothstep(0.12, 0.5, rust));
    r = mix(r, 0.90 + 0.08 * grain, smoothstep(0.10, 0.55, rust));
    h += rust * 0.10 * (0.4 + grain) + plateM * 0.14;
    ao -= plateM * 0.32 + smoothstep(0.6, 1.0, rust) * 0.16;

    // section loss: the plate has actually been eaten away
    vec4 pit = owWorley(p * 16.0, P * 16.0, 1.0);
    float deep = smoothstep(0.20, 0.0, pit.x) * step(0.70, pit.w) * smoothstep(0.45, 0.9, rust);
    h -= deep * 0.26;
    ao -= deep * 0.5;
    c = mix(c, rc * 0.32, deep * 0.75);

    // rust bleeding down from every rivet and every lap
    float bleed = smoothstep(0.50, 0.92, owFbm01(vec2(p.x * 6.0, p.y * 0.7), vec2(P.x * 6.0, max(P.y, 1.0)), 5, 0.55))
                * smoothstep(0.15, 0.55, rust);
    c = mix(c, owSRGB(vec3(0.365, 0.190, 0.090)), bleed * 0.45);
    r += bleed * 0.06;
  }

  // ---- soot and grease ---------------------------------------------------
  // A mill deposits a greasy black film on everything under cover.
  float soot = smoothstep(0.50, 0.90, owFbm01(owWarp(p * 2.2 + 33.0, P * 2.2, 0.7, 3), P * 2.2, 5, 0.55));
  c = mix(c, owSRGB(vec3(0.055, 0.052, 0.050)), soot * 0.32);
  r += soot * 0.08;
  metal *= 1.0 - soot * 0.5;

  float cavity = 1.0 - smoothstep(0.58, 0.82, h);
  c *= 1.0 - cavity * 0.22;
  metal *= 1.0 - cavity * 0.20;

  alb = clamp(c, vec3(0.02), vec3(0.82));
  rough = clamp(r, 0.14, 0.99);
  metal = clamp(metal, 0.0, 1.0);
  ao = clamp(ao, 0.15, 1.0);
  h = clamp(h, 0.0, 1.0);
}
`;

/**
 * ASPHALT SHINGLE ROOF. Every rowhouse and every porch in the city.
 *
 * uParam.x  courses per tile (defaults to 5)
 * uParam.y  age 0..1  granule loss, curling, cracked tabs
 * uParam.z  algae 0..1  the black Gloeocapsa streaks that run DOWN a roof
 */
export const SHINGLE = /* glsl */ `
void owSurface(vec2 uv, out vec3 alb, out float h, out float rough, out float metal, out float ao){
  const vec2 P = vec2(8.0);
  vec2 p = uv * P + uSeed * 5.7;
  float courses = max(uParam.x, 2.0);
  float age = clamp(uParam.y, 0.0, 1.0);
  float algae = clamp(uParam.z, 0.0, 1.0);

  // ---- courses and tabs --------------------------------------------------
  float cF = uv.y * courses;
  float cId = floor(cF);
  float cf = fract(cF);
  // each course offsets by half a tab
  float tabF = uv.x * 9.0 + mod(cId, 2.0) * 0.5;
  float tId = floor(tabF);
  float tf = fract(tabF);
  vec4 rnd = owHash42(vec2(mod(tId, 9.0), cId) + uSeed * 2.6);

  // The butt edge of each course stands proud and throws the shadow line that
  // is the entire read of a shingle roof from the street.
  float butt = 1.0 - smoothstep(0.0, 0.09, cf);
  float shadow = smoothstep(0.0, 0.13, cf) * (1.0 - smoothstep(0.13, 0.26, cf));
  // the slot between tabs, only in the exposed lower third of the course
  float slot = (1.0 - smoothstep(0.010, 0.022, min(tf, 1.0 - tf))) * (1.0 - smoothstep(0.34, 0.42, cf));

  h = 0.60 + (1.0 - cf) * 0.13;
  h += (rnd.x - 0.5) * 0.035;          // tabs sit unevenly
  h -= slot * 0.16;
  ao = 1.0 - shadow * 0.55 - slot * 0.45;

  // ---- granules ----------------------------------------------------------
  // The colour of a shingle IS its granules: crushed slate and ceramic, three
  // or four blended stocks, and the blend is deliberately mottled so a roof
  // never reads as one flat value. Losing them is how a roof ages.
  vec4 g1 = owWorley(p * 22.0, P * 22.0, 1.0);
  vec4 g2 = owWorley(p * 14.0 + 5.0, P * 14.0, 1.0);
  float gm1 = smoothstep(0.34, 0.06, g1.x);
  float gm2 = smoothstep(0.36, 0.08, g2.x);
  float blend = owFbm01(p * 2.2, P * 2.2, 4, 0.58);

  vec3 kA = uTintA;
  vec3 kB = uTintB;
  vec3 kC = owSRGB(vec3(0.400, 0.386, 0.360));
  vec3 c = mix(kA, kB, smoothstep(0.30, 0.70, blend));
  c = mix(c, c * 1.32, gm1 * step(0.62, g1.z) * 0.55);
  c = mix(c, c * 0.62, gm2 * step(0.70, g2.w) * 0.55);
  c = mix(c, kC, gm1 * step(0.88, g1.w) * 0.6);
  c *= 0.88 + 0.24 * rnd.y;            // per-tab bundle shade
  c *= 0.94 + 0.12 * owFbm01(p * 8.0, P * 8.0, 4, 0.5);

  h += gm1 * 0.030 + gm2 * 0.018;
  rough = 0.90 + (gm1 - 0.5) * 0.06;
  metal = 0.0;

  // ---- granule loss ------------------------------------------------------
  // Where the granules wash off, the asphalt mat shows: black, glossier, and
  // it appears in the water tracks first — down each slot and along the butts.
  float track = clamp(slot * 1.2 + butt * 0.5, 0.0, 1.0);
  float lossF = owFbm01(owWarp(p * 3.0 + 17.0, P * 3.0, 0.8, 3), P * 3.0, 4, 0.55);
  float loss = clamp(age * (smoothstep(0.42, 0.78, lossF) + track * 0.6), 0.0, 1.0);
  vec3 mat = owSRGB(vec3(0.088, 0.086, 0.088));
  c = mix(c, mat, loss * 0.80);
  rough = mix(rough, 0.56, loss * 0.7);
  h -= loss * 0.030;

  // ---- curling and cracking ---------------------------------------------
  // Old tabs curl at the corners and crack across. The curled corner catches
  // the sun and is what makes an old roof read as old from a helicopter.
  float curl = smoothstep(0.55, 0.95, (1.0 - cf) * (0.5 + 0.6 * rnd.z)) * age;
  h += curl * 0.10;
  ao -= curl * 0.10;
  c *= 1.0 + curl * 0.10;
  float crack = owCracks(p * 7.0, P * 7.0, 0.9, 0.020, 0.66 - age * 0.20) * age;
  h -= crack * 0.05;
  c = mix(c, mat * 0.8, crack * 0.6);

  // a tab missing entirely, showing the felt and the deck below
  float gone = step(0.975 - age * 0.03, rnd.w);
  float missing = gone * (1.0 - smoothstep(0.36, 0.44, cf));
  c = mix(c, owSRGB(vec3(0.185, 0.170, 0.148)), missing * 0.85);
  h -= missing * 0.14;
  ao -= missing * 0.35;
  rough = mix(rough, 0.94, missing * 0.8);

  // ---- algae -------------------------------------------------------------
  // Gloeocapsa magma: black-green streaks that run straight DOWN the slope
  // from wherever the water concentrates. Never a blotch, always a run.
  float streak = owFbm01(vec2(p.x * 3.2, p.y * 0.35), vec2(P.x * 3.2, max(P.y * 0.5, 1.0)), 5, 0.6);
  float run = smoothstep(0.48, 0.84, streak) * algae;
  c = mix(c, owSRGB(vec3(0.075, 0.082, 0.070)), run * 0.62);
  rough += run * 0.04;
  // and lichen where it stays damp
  float lich = smoothstep(0.80, 0.94, owFbm01(p * 6.0 + 23.0, P * 6.0, 5, 0.6)) * algae;
  c = mix(c, owSRGB(vec3(0.400, 0.400, 0.330)), lich * 0.4);

  // ---- dirt in the shadow lines -----------------------------------------
  float cavity = 1.0 - smoothstep(0.52, 0.74, h);
  c = mix(c, owSRGB(vec3(0.115, 0.108, 0.096)), cavity * 0.38);

  alb = clamp(c, vec3(0.02), vec3(0.68));
  rough = clamp(rough, 0.42, 0.99);
  ao = clamp(ao, 0.20, 1.0);
  h = clamp(h, 0.0, 1.0);
}
`;

/**
 * BUILT-UP TAR ROOF — the flat roof of every commercial building and every
 * rowhouse block. Seen from every window above the second floor and from every
 * helicopter, so it matters far more than it sounds.
 *
 * uParam.x  finish 0 = tar & gravel · 0.5 = smooth mopped · 1 = rolled cap sheet
 * uParam.y  age 0..1  blisters, alligatoring, patched seams
 * uParam.z  ponding 0..1  the permanent dished areas that never drain
 */
export const TAR_ROOF = /* glsl */ `
void owSurface(vec2 uv, out vec3 alb, out float h, out float rough, out float metal, out float ao){
  const vec2 P = vec2(8.0);
  vec2 p = uv * P + uSeed * 8.4;
  float finish = clamp(uParam.x, 0.0, 1.0);
  float age = clamp(uParam.y, 0.0, 1.0);
  float pond = clamp(uParam.z, 0.0, 1.0);

  float gravelF = 1.0 - smoothstep(0.0, 0.5, finish);
  float rollF = smoothstep(0.5, 1.0, finish);

  float macro = owFbm01(p * 0.6, P * 0.6, 4, 0.6);
  float fine = owFbm01(p * 15.0, P * 15.0, 4, 0.5);

  // The bitumen itself: near-black, greying with UV, with the mop strokes of
  // whoever laid it still visible in the surface.
  float mop = owFbm01(owWarp(p * 1.8, P * 1.8, 0.8, 3), P * 1.8, 4, 0.55);
  vec3 tar = owSRGB(vec3(0.082, 0.080, 0.082));
  vec3 grey = owSRGB(vec3(0.250, 0.246, 0.240));
  vec3 c = mix(tar, grey, smoothstep(0.2, 0.9, macro * 0.5 + age * 0.7));
  c *= 0.90 + 0.20 * mop;
  c *= 0.95 + 0.10 * fine;

  h = 0.62 + (mop - 0.5) * 0.05 + (fine - 0.5) * 0.02;
  float r = 0.66 + (fine - 0.5) * 0.16 + age * 0.16;
  metal = 0.0;
  ao = 1.0;

  // ---- the gravel ballast ------------------------------------------------
  // Pea gravel flung over hot tar: it half-sinks, it drifts into the low spots,
  // and where it has blown away the tar shows through as a dark island.
  {
    vec4 g1 = owWorley(p * 15.0, P * 15.0, 1.0);
    vec4 g2 = owWorley(p * 23.0 + 5.0, P * 23.0, 1.0);
    float m1 = smoothstep(0.36, 0.10, g1.x);
    float m2 = smoothstep(0.30, 0.07, g2.x) * step(0.42, g2.w);
    float drift = owFbm01(owWarp(p * 1.1 + 9.0, P * 1.1, 0.8, 3), P * 1.1, 4, 0.6);
    float cover = clamp(smoothstep(0.24, 0.62, drift) * 1.15, 0.0, 1.0);
    vec3 s1 = owSRGB(vec3(0.470, 0.450, 0.412));
    vec3 s2 = owSRGB(vec3(0.310, 0.296, 0.278));
    vec3 s3 = owSRGB(vec3(0.585, 0.555, 0.500));
    vec3 stone = mix(s1, s2, g1.z);
    stone = mix(stone, s3, step(0.82, g1.w));
    float gm = clamp(m1 * 0.85 + m2 * 0.45, 0.0, 1.0) * cover;
    vec3 gc = mix(c, stone, gm);
    // the tar wells up between the stones and is glossy against them
    gc = mix(gc, tar * 1.1, (1.0 - gm) * cover * 0.35);
    float gh = h + m1 * 0.16 * (0.5 + 0.6 * g1.z) * cover + m2 * 0.05 * cover;
    float gr = mix(r, 0.86 + 0.10 * g1.z, gm);
    float gao = 1.0 - smoothstep(0.40, 0.68, g1.x) * 0.24 * cover;
    c = mix(c, gc, gravelF);
    h = mix(h, gh, gravelF);
    r = mix(r, gr, gravelF);
    ao = mix(ao, gao, gravelF);
  }

  // ---- rolled cap sheet --------------------------------------------------
  // Mineral-surfaced roll roofing: 900 mm widths with a 75 mm lap, and the lap
  // seam is always the first thing to fail.
  {
    float rollY = uv.y * 3.0;
    float rid = floor(rollY);
    float rf = fract(rollY);
    float lap = 1.0 - smoothstep(0.0, 0.055, rf);
    float seam = 1.0 - smoothstep(0.0, 0.010, rf);
    vec4 min1 = owWorley(p * 21.0, P * 21.0, 1.0);
    float gran = smoothstep(0.32, 0.06, min1.x);
    vec3 mc = mix(owSRGB(vec3(0.300, 0.286, 0.262)), owSRGB(vec3(0.185, 0.178, 0.170)),
                  owHash11(rid * 3.1 + uSeed));
    mc = mix(mc, mc * 1.28, gran * step(0.6, min1.z) * 0.5);
    mc *= 0.93 + 0.14 * fine;
    float rh = 0.66 + lap * 0.055 + gran * 0.020;
    float rr2 = 0.88 - gran * 0.06;
    // the seam: extra bitumen troweled over it, glossy and slightly proud
    mc = mix(mc, tar, seam * 0.7);
    rh += seam * 0.02;
    rr2 = mix(rr2, 0.48, seam * 0.7);
    c = mix(c, mc, rollF);
    h = mix(h, rh, rollF);
    r = mix(r, rr2, rollF);
    ao = mix(ao, 1.0 - lap * 0.20, rollF);
  }

  // ---- blisters ----------------------------------------------------------
  // Trapped moisture lifts the felt into domes 10-40 cm across that split open
  // at the top. Every old flat roof is covered in them.
  {
    vec4 bl = owWorley(owWarp(p * 2.6 + 31.0, P * 2.6, 0.4, 3), P * 2.6, 0.9);
    float sel = step(0.72 - age * 0.16, bl.w);
    float d = bl.x / (0.24 + 0.16 * bl.z);
    float dome = sel * smoothstep(1.0, 0.0, d);
    h += dome * dome * 0.13 * age;
    // and the split across the crown, which is where the water gets in
    float split = sel * (1.0 - smoothstep(0.0, 0.030, abs(bl.x - 0.03))) * smoothstep(0.5, 0.85, age);
    h -= split * 0.10;
    ao -= split * 0.45;
    c = mix(c, owSRGB(vec3(0.290, 0.268, 0.230)), split * 0.5);
  }

  // ---- alligatoring ------------------------------------------------------
  // Bitumen oxidises and shrinks into a coarse polygonal crack net. It is the
  // signature texture of an old tar roof and nothing else looks like it.
  float ali = owCracks(p * 4.5, P * 4.5, 0.85, 0.026, 0.60 - age * 0.24) * age;
  float ali2 = owCracks(p * 9.0 + 7.0, P * 9.0, 0.9, 0.018, 0.68 - age * 0.20) * age * 0.6;
  float alg = clamp(ali + ali2, 0.0, 1.0) * (1.0 - gravelF * 0.55);
  h -= alg * 0.06;
  ao -= alg * 0.35;
  c = mix(c, c * 0.55, alg * 0.5);
  // the curled edges of each plate
  float curl = alg * (1.0 - alg) * 4.0;
  c *= 1.0 + curl * 0.18;
  h += curl * 0.025;

  // ---- patches -----------------------------------------------------------
  // Somebody has been up here with a bucket of cold-pour and a brush. The
  // patches are shiny black, irregular, and lap over each other.
  float patchF = owFbm01(owWarp(p * 1.6 + 43.0, P * 1.6, 1.0, 3), P * 1.6, 4, 0.58);
  float repairM = smoothstep(0.68 - age * 0.18, 0.78 - age * 0.16, patchF);
  c = mix(c, owSRGB(vec3(0.062, 0.060, 0.062)), repairM * 0.85);
  r = mix(r, 0.36 + 0.2 * fine, repairM * 0.85);
  h += repairM * 0.020;
  float patchEdge = max(smoothstep(0.64 - age * 0.18, 0.71 - age * 0.16, patchF) - repairM, 0.0);
  h += patchEdge * 0.020;
  c *= 1.0 - patchEdge * 0.10;

  // ---- ponding -----------------------------------------------------------
  // A flat roof is never flat: it dishes between the drains and holds water
  // for weeks, which leaves a hard-edged pale ring of silt and algae.
  {
    float dish = owFbm01(owWarp(p * 0.75 + 61.0, P * 0.75, 0.7, 3), P * 0.75, 4, 0.62);
    float inPond = smoothstep(0.58, 0.72, dish) * pond;
    h -= inPond * 0.10;
    // silt and dried algae film left behind
    c = mix(c, owSRGB(vec3(0.245, 0.240, 0.212)), inPond * 0.42);
    r = mix(r, 0.90, inPond * 0.6);
    // the tide line at the edge of the pond
    float tide = max(smoothstep(0.545, 0.60, dish) - smoothstep(0.60, 0.66, dish), 0.0) * pond;
    c = mix(c, owSRGB(vec3(0.330, 0.322, 0.286)), tide * 0.55);
  }

  float cavity = 1.0 - smoothstep(0.52, 0.74, h);
  c = mix(c, owSRGB(vec3(0.105, 0.098, 0.088)), cavity * 0.34);

  alb = clamp(c, vec3(0.02), vec3(0.70));
  rough = clamp(r, 0.30, 0.99);
  ao = clamp(ao, 0.22, 1.0);
  h = clamp(h, 0.0, 1.0);
}
`;

/**
 * STUCCO — dash-coat and sand-float render, the cheap re-face on half the
 * commercial strip. Distinct from the smooth 'plaster' already in the library:
 * this one has a real aggregate throw, so it reads as an American stucco rather
 * than a Mediterranean skim.
 *
 * uParam.x  texture 0 = sand float · 0.5 = knockdown · 1 = heavy dash
 * uParam.y  age 0..1
 * uParam.z  control joints per tile (0 = none)
 */
export const STUCCO = /* glsl */ `
void owSurface(vec2 uv, out vec3 alb, out float h, out float rough, out float metal, out float ao){
  const vec2 P = vec2(8.0);
  vec2 p = uv * P + uSeed * 6.8;
  float tex = clamp(uParam.x, 0.0, 1.0);
  float age = clamp(uParam.y, 0.0, 1.0);
  float joints = max(uParam.z, 0.0);

  float macro = owFbm01(p * 0.6, P * 0.6, 4, 0.6);
  float mid   = owFbm01(owWarp(p * 2.4, P * 2.4, 0.6, 3), P * 2.4, 5, 0.5);
  float fine  = owFbm01(p * 16.0, P * 16.0, 4, 0.5);

  vec3 c = uTintA * (0.92 + 0.16 * macro);
  c *= 0.94 + 0.12 * fine;
  h = 0.66;
  float r = 0.86 + (fine - 0.5) * 0.12;
  metal = 0.0;
  ao = 1.0;

  // ---- the throw ---------------------------------------------------------
  // A dash coat is thrown off a brush or a hopper gun, so the surface is a
  // field of discrete SPLATS with sharp edges and rounded crowns — not a noise
  // field. The knockdown finish is the same splats flattened with a trowel.
  vec4 d1 = owWorley(owWarp(p * 12.0, P * 12.0, 0.16, 2), P * 12.0, 1.0);
  vec4 d2 = owWorley(owWarp(p * 20.0 + 5.0, P * 20.0, 0.12, 2), P * 20.0, 1.0);
  float s1 = smoothstep(0.38, 0.10, d1.x) * step(0.24, d1.w);
  float s2 = smoothstep(0.32, 0.08, d2.x) * step(0.36, d2.w);
  float dash = clamp(s1 * 0.85 + s2 * 0.5, 0.0, 1.0);
  float heavy = smoothstep(0.5, 1.0, tex);
  float knock = 1.0 - abs(tex - 0.5) * 2.0;
  float sandf = 1.0 - smoothstep(0.0, 0.5, tex);

  // sand float: a fine, even 1-2 mm tooth from a rubber float
  vec4 sandW = owWorley(p * 22.0, P * 22.0, 1.0);
  float sand = smoothstep(0.40, 0.06, sandW.x);
  h += sand * 0.030 * sandf;
  c *= 1.0 + (sand - 0.30) * 0.14 * sandf;
  r += sand * 0.05 * sandf;

  // dash: full relief, hard shadows between splats
  h += dash * 0.30 * heavy;
  ao -= (1.0 - dash) * 0.24 * heavy;
  c *= 1.0 + (dash - 0.4) * 0.16 * heavy;

  // knockdown: the splats flattened on top, so the crowns are pale plateaus
  float flat1 = smoothstep(0.45, 0.75, dash);
  h += flat1 * 0.16 * knock;
  ao -= (1.0 - flat1) * 0.18 * knock;
  c *= 1.0 + (flat1 - 0.35) * 0.13 * knock;
  r -= flat1 * 0.06 * knock;

  // ---- control joints ----------------------------------------------------
  // A stucco field is broken by galvanised expansion beads on a grid. They rust
  // and they leave a straight brown line down a wall.
  if (joints > 0.0) {
    vec2 jg = abs(fract(uv * joints + 0.5) - 0.5);
    float j = 1.0 - smoothstep(0.006, 0.014, min(jg.x, jg.y));
    h -= j * 0.09;
    ao -= j * 0.5;
    c = mix(c, c * 0.55, j * 0.6);
    float rusty = j * smoothstep(0.45, 0.85, owFbm01(p * 5.0, P * 5.0, 4, 0.55)) * age;
    c = mix(c, owSRGB(vec3(0.360, 0.205, 0.110)), rusty * 0.5);
  }

  // ---- failure -----------------------------------------------------------
  // Stucco cracks in long diagonals off the corners of openings, and it
  // delaminates in sheets showing the black felt and the wire lath behind it.
  float crack = owCracks(p * 3.4 + 21.0, P * 3.4, 0.82, 0.020, 0.68 - age * 0.22);
  crack = clamp(crack * (0.35 + 1.0 * age), 0.0, 1.0);
  h -= crack * 0.075;
  ao -= crack * 0.42;
  c = mix(c, c * 0.48, crack * 0.65);

  float blowF = owFbm01(owWarp(p * 1.2 + 37.0, P * 1.2, 1.0, 3), P * 1.2, 4, 0.58);
  float blow = smoothstep(0.80 - age * 0.20, 0.87 - age * 0.16, blowF);
  // behind it: black felt paper and the diamond of the wire lath
  float lath = max(1.0 - smoothstep(0.0, 0.16, abs(fract((uv.x + uv.y) * 90.0) - 0.5) * 2.0),
                   1.0 - smoothstep(0.0, 0.16, abs(fract((uv.x - uv.y) * 90.0) - 0.5) * 2.0));
  vec3 sub = mix(owSRGB(vec3(0.105, 0.100, 0.096)), owSRGB(vec3(0.330, 0.320, 0.310)), lath * 0.7);
  c = mix(c, sub, blow * 0.88);
  h -= blow * 0.16;
  ao -= blow * 0.35;
  r = mix(r, 0.92, blow * 0.6);
  float blowLip = max(smoothstep(0.76 - age * 0.20, 0.82 - age * 0.16, blowF) - blow, 0.0);
  c *= 1.0 + blowLip * 0.16;
  h += blowLip * 0.030;

  // ---- weathering --------------------------------------------------------
  float soil = smoothstep(0.45, 0.90, owFbm01(vec2(p.x * 5.5, p.y * 0.8), vec2(P.x * 5.5, max(P.y, 1.0)), 5, 0.55));
  c *= 1.0 - soil * 0.20 * (0.4 + age);
  float mould = smoothstep(0.70, 0.94, owFbm01(p * 3.6 + 25.0, P * 3.6, 5, 0.6)) * (0.3 + 0.8 * age);
  c = mix(c, owSRGB(vec3(0.115, 0.122, 0.100)), mould * 0.42);
  float chalk = smoothstep(0.35, 0.85, mid) * age;
  c = mix(c, c * 0.7 + 0.14, chalk * 0.35);
  r += chalk * 0.05;

  float cavity = 1.0 - smoothstep(0.50, 0.76, h);
  c = mix(c, owSRGB(vec3(0.170, 0.164, 0.152)), cavity * 0.34);

  alb = clamp(c, vec3(0.02), vec3(0.88));
  rough = clamp(r, 0.34, 0.99);
  ao = clamp(ao, 0.16, 1.0);
  h = clamp(h, 0.0, 1.0);
}
`;
