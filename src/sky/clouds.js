/**
 * Volumetric cloud decks.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS IS A RAYMARCH AND NOT A TEXTURE
 * ---------------------------------------------------------------------------
 * The previous deck was a 2D density field sampled twice with a parallax shear.
 * It is a good trick and it survives a fixed camera at a fixed hour, but it
 * fails the three things an open world asks of a cloud:
 *
 *   - the camera can climb Mt. Washington, and an extruded 2D field seen from
 *     400 m up is visibly a printed sheet;
 *   - the sun goes all the way round, and the *underside* of a cumulus at 19:20
 *     is the whole shot. A flat deck has no underside — its "shadowing" is a
 *     horizontal offset lookup, which cannot know that the light has to travel
 *     six hundred metres of water droplet to reach the base;
 *   - it shimmers. A per-pixel threshold on an fbm whose screen-space derivative
 *     blows up toward the horizon aliases into crawling hairlines under TAA.
 *
 * So: a genuine slab march. The deck is a shell between `base` and `top`
 * kilometres; the view ray is intersected against both, marched with a dithered
 * start offset, and each sample gets a 3D density and a short light march toward
 * the sun. Integration is what kills the shimmer — a marched slab averages the
 * field along the ray instead of thresholding it once.
 *
 * ---------------------------------------------------------------------------
 * DENSITY
 * ---------------------------------------------------------------------------
 *   macro      four analytic waves, in kilometres. Evaluated identically on the
 *              CPU (`cloudMacro` below) so the sun's occlusion factor matches
 *              the cloud the shader is drawing. Correlated, not faked.
 *   coverage   macro * the weather's coverage, thresholding a warped fbm
 *   profile    the vertical shape. A cumulus is a round base and a cauliflower
 *              top; a stratus is a flat slab. `uCloudShape.z` blends between
 *              them, which is what makes "overcast" a different CLOUD rather
 *              than the same cloud with the coverage turned up.
 *   shear      the deck's tops lag its bases by the wind. One line, and it is
 *              most of what makes a cumulus read as three-dimensional.
 *   erosion    two octaves of 3D value noise, subtracted hardest where the slab
 *              is already thin. Cauliflower at the top, wisps at the base.
 *
 * ---------------------------------------------------------------------------
 * LIGHTING
 * ---------------------------------------------------------------------------
 * Beer-Lambert on the light march, plus the multiple-scattering approximation
 * from Wrenninge et al. (three exponentials at halved extinction and halved
 * weight). That sum is what makes a cloud translucent rather than a grey solid,
 * and it costs one extra exp per octave off ONE optical depth.
 *
 * Phase is dual-lobe Henyey-Greenstein: a hard forward lobe for the silver
 * lining when you look toward the sun through a thin edge, and a broad back
 * lobe so a cloud lit from behind the camera is not flat.
 *
 * Radiance convention: sun/moon arrive as *irradiance* in scene light units, so
 * every direct term is divided by pi to become framebuffer radiance. See the
 * long note at the end of skRaymarchSky in atmosphere.js.
 */
export const CLOUDS_GLSL = /* glsl */ `
#ifndef SKY_CLOUDS
#define SKY_CLOUDS

// x coverage, y density, z detail gain, w time (seconds)
uniform vec4 uCloudParams;
// x cirrus coverage, y cirrus opacity, z wind x (km/s), w wind z (km/s)
uniform vec4 uCloudParams2;
// x base km, y top km, z stratus blend 0..1, w shear km per unit height
uniform vec4 uCloudShape;
// x absorption (storm darkening), y ambient gain, z powder, w evolution seconds
uniform vec4 uCloudLight;
/**
 * Viewer position in the PLANET frame (Mm), tracking the camera.
 *
 * uViewPos is the atmosphere's reference altitude and is deliberately fixed —
 * the sky-view LUT is baked against it and a 400 m climb does not change the
 * Rayleigh column enough to be worth a rebake. The cloud deck is a different
 * matter: it is 1.2 km up and the city is 3 km across, so a deck sampled from a
 * fixed origin is pinned to the camera and slides with it. That is the most
 * obvious "the sky is a skybox" tell there is, and this uniform is the fix.
 */
uniform vec3 uSkyOrigin;

const float SK_CIRRUS_KM = 7.8;

/** Weather-scale coverage, in kilometres. Mirrored exactly on the CPU. */
float skCloudMacro( vec2 p ) {
  float a = sin( p.x * 0.412 + 0.7 ) * cos( p.y * 0.331 - 0.4 );
  float b = sin( p.x * 0.173 - p.y * 0.209 + 1.9 );
  float c = cos( p.x * 0.0871 + p.y * 0.1123 - 0.6 );
  return clamp( 0.5 + 0.5 * ( 0.42 * a + 0.36 * b + 0.30 * c ), 0.0, 1.0 );
}

/**
 * Ridged noise with a *parabolic* crest instead of an absolute-value one.
 *
 * skRidge2 in noise.js builds its ridge as 1 - |2v-1|, which has a crease at the
 * crest: the derivative flips sign discontinuously, so any threshold applied to
 * it produces a hairline. On an anisotropic field stretched across the sky that
 * crease is a pen stroke, and a sky full of pen strokes was half the old cirrus
 * problem — the other half was where they pointed.
 *
 * 1 - (2v-1)^2 has the same crest lines and the same statistics but is C1 across
 * them, so a fibre has a soft shoulder and a body several pixels wide.
 */
float skSmoothRidge2( vec2 p, int oct ) {
  float a = 0.62, s = 0.0, n = 0.0;
  for ( int i = 0; i < oct; i ++ ) {
    float v = skVal2( p ) * 2.0 - 1.0;
    s += a * ( 1.0 - v * v );
    n += a;
    p = SK_ROT * p * 2.17 + 3.71;
    a *= 0.45;
  }
  return s / max( n, 1e-4 );
}

// ---------------------------------------------------------------------------
//  cumulus / stratus slab
// ---------------------------------------------------------------------------

/** Height above the ground shell, in kilometres, for a point in Mm. */
float skCloudAltKM( vec3 p ) { return ( length( p ) - SK_GROUND_R ) * 1000.0; }

/**
 * Vertical profile of the deck, hf normalised 0..1 through the slab.
 *
 * The cumulus lobe is deliberately asymmetric: it opens fast off the base
 * (a cumulus base is a hard flat line — that is where the air hits its
 * condensation level) and tapers slowly through the top two thirds, which is
 * the shape that produces a cauliflower rather than a lozenge. The stratus lobe
 * is a slab with soft edges, because that is what a stratus is.
 */
float skCloudProfile( float hf ) {
  float cumulus = smoothstep( 0.0, 0.08, hf ) * ( 1.0 - smoothstep( 0.28, 0.90, hf ) );
  // Bias the mass to the lower half: real cumulus are widest a third of the way
  // up, which is what puts the shadowed bulk UNDER the sunlit crown.
  cumulus *= 0.55 + 0.45 * ( 1.0 - hf );
  float stratus = smoothstep( 0.0, 0.16, hf ) * ( 1.0 - smoothstep( 0.62, 1.0, hf ) );
  return mix( cumulus, stratus, uCloudShape.z );
}

/**
 * Cloud density at a point in the planet frame (Mm).
 * oct is the fbm octave count; detail enables the 3D erosion pass.
 */
float skCloudDensity( vec3 pos, int oct, bool detail ) {
  float hKM = skCloudAltKM( pos );
  float baseKM = uCloudShape.x;
  float topKM = uCloudShape.y;
  float hf = ( hKM - baseKM ) / max( 0.05, topKM - baseKM );
  if ( hf <= 0.0 || hf >= 1.0 ) return 0.0;

  float prof = skCloudProfile( hf );
  if ( prof <= 0.001 ) return 0.0;

  float t = uCloudParams.w;
  vec2 wind = vec2( uCloudParams2.z, uCloudParams2.w ) * t;
  // Wind shear: the top of the deck is dragged downwind of its base. Without
  // this every billow is a vertical extrusion and the deck reads as a relief map.
  vec2 shear = normalize( vec2( uCloudParams2.z, uCloudParams2.w ) + 1e-5 )
               * ( uCloudShape.w * hf );
  vec2 p = pos.xz * 1000.0 + wind + shear;

  float macro = skCloudMacro( p * 0.22 );
  float cov = clamp( uCloudParams.x * ( 0.34 + 1.30 * macro ), 0.0, 1.0 );
  if ( cov <= 0.002 ) return 0.0;

  // Domain warp before the shape fbm. Straight fbm gives evenly sized blobs;
  // warping it stretches some and pinches others, which is what makes a cloud
  // field read as weather rather than as noise. The warp amplitude is kept
  // MODEST — at 1.6 it displaced a sample by more than a feature width, which
  // does not stretch billows, it shears them into diagonal smears.
  vec2 w = vec2( skVal2( p * 0.55 ), skVal2( p * 0.55 + 19.7 ) ) - 0.5;
  float n = skFbm2( p * 1.5 + w * 1.0, oct );

  /**
   * THE COVERAGE THRESHOLD RISES WITH HEIGHT, AND THIS IS THE MOST IMPORTANT
   * LINE IN THE FILE.
   *
   * A 2D coverage field times a vertical profile makes every cloud a COLUMN —
   * the same horizontal cross-section from base to top. Looking straight up that
   * is fine. At forty degrees of elevation, which is most of the sky anyone
   * actually looks at, a ray entering the base of a 1.4 km slab leaves its top
   * 1.7 km downwind of where it went in, so it integrates three unrelated clouds
   * and paints the average as one streak. Every streak points at the vertical
   * vanishing point, so the deck reads as rain falling out of the sky.
   *
   * That was diagnosed by raising the march from 20 steps to 64 and getting a
   * pixel-identical frame, and again by switching the 3D erosion off and getting
   * the same streaks: it was never the sampling or the noise, it was the shape.
   *
   * Lifting the threshold with height turns each column into a DOME — widest at
   * the condensation level, narrowing to a crown — so a ray crossing it leaves
   * through the top of the same cloud it entered. Which is what a cumulus is.
   * The lift is released as the deck becomes a stratus sheet, because a sheet is
   * supposed to be a slab and has no crown to narrow to.
   *
   * The ramp WIDTH is the softness of the edge: a cumulus boundary is a phase
   * boundary, condensed on one side and clear air on the other, and it is tens
   * of metres, not hundreds.
   */
  /**
   * LINEAR in hf, and it was measured that way.
   *
   * Squaring it rounds the crowns, which looks better in a backlit frame — and
   * costs the sky. The narrowing is what sets how much of the HEMISPHERE the
   * deck covers, and almost all of that coverage is decided in the lower half of
   * the slab where a squared lift barely narrows at all. Measured at noon: the
   * squared form took the zenith from 107/130/161 (blue-minus-red +54) to
   * 163/163/166 (+3) — a total overcast, and the Rayleigh column gone with it.
   * Slightly conical tops are a far cheaper price than a white sky.
   */
  float lift = cov * 0.62 * hf * ( 1.0 - 0.85 * uCloudShape.z );
  float d = smoothstep( 1.0 - cov * 0.92 + lift, 1.0 - cov * 0.50 + lift, n ) * prof;
  if ( d <= 0.002 ) return 0.0;

  if ( detail ) {
    // 3D erosion. The third axis is the ALTITUDE, plus a slow drift in the
    // noise's own domain — so a billow does not merely translate downwind, it
    // boils. A cloud field that only translates is the single loudest "this is a
    // scrolling texture" tell there is.
    // ISOTROPIC. The vertical frequency used to be 5.2 against a horizontal 4.6,
    // which over a 1.35 km slab carved the erosion into vertical channels — and
    // vertical channels hanging off a cloud base read as virga, or worse, as
    // banding.
    vec3 q = vec3( p * 4.6, hKM * 4.6 + uCloudLight.w );
    float e = skVal3( q ) * 0.60 + skVal3( q * 2.9 + 7.3 ) * 0.40;
    /**
     * Erosion is weighted UP THE SLAB, and that is the difference between a
     * cumulus and a cloud of steam.
     *
     * A cumulus base is the lifting condensation level — a physical altitude at
     * which the air's water condenses — so it is FLAT, and flat across the whole
     * field, which is why a fair-weather sky looks like it has a ceiling. Only
     * the top is turbulent. Eroding uniformly gave a deck that was equally
     * ragged at both ends and therefore had no ceiling and no read.
     */
    float bite = ( 0.22 + 0.78 * hf * hf ) * uCloudParams.z;
    d = clamp( d - ( 1.0 - d ) * ( 0.70 - 0.80 * e ) * bite, 0.0, 1.0 );
  }
  return d;
}

/**
 * Optical depth from pos toward lightDir, in slab units.
 *
 * Five taps on a geometric ladder: the first two resolve the local self-shadow
 * that makes a billow read as a sphere, the last reaches far enough across the
 * deck that a low sun has to travel through a neighbouring cloud to get here —
 * which is exactly why a sunset deck has dark bases and a blazing crown.
 */
float skCloudLightMarch( vec3 pos, vec3 lightDir, int oct ) {
  /**
   * Steps in Mm, on a 1.9 ladder from 60 m out to 3 km.
   *
   * The ratio matters more than the count. At 2.35 the second sample was already
   * 300 m from the first, which is half the width of a fair-weather cumulus — so
   * a point in the middle of a cloud got two taps inside it and three in clear
   * air, reported an optical depth of 0.2, and came back barely shaded. A cloud
   * whose interior is not several optical depths deep has no dark side, and a
   * cumulus with no dark side is a cotton ball.
   */
  const float S0 = 0.00006;
  float tau = 0.0;
  float t = 0.0;
  float step = S0;
  for ( int i = 0; i < 6; i ++ ) {
    t += step;
    tau += skCloudDensity( pos + lightDir * t, oct, i < 2 ) * step;
    step *= 1.9;
  }
  // A long tap for the neighbouring cloud a low sun has to shine through.
  tau += skCloudDensity( pos + lightDir * 0.0052, oct, false ) * 0.0022;
  return tau * 1000.0; // Mm -> km, so density is per-kilometre
}

/**
 * Wrenninge multiple-scattering approximation: three exponentials at halved
 * extinction and halved weight. This is what makes a cloud translucent instead
 * of a grey solid, and it is the term that lets a low sun light a cloud's
 * underside from inside rather than only rim it.
 */
vec3 skCloudScatter( float tau, float sigma ) {
  float a = 1.0, b = 1.0, s = 0.0;
  for ( int i = 0; i < 3; i ++ ) {
    s += a * exp( -tau * sigma * b );
    // 0.45 / 0.38 rather than 0.52 / 0.44. The higher pair kept the third octave
    // — the one with almost no extinction left on it — at a quarter weight
    // everywhere, which is a floor under the darkest part of every cloud. The
    // deep interior of a cumulus is two to three stops under its lit crown and
    // that floor was costing most of it.
    a *= 0.45;
    b *= 0.38;
  }
  return vec3( s );
}

/**
 * March the cumulus/stratus slab.
 *
 * @param ro        viewer, planet frame (Mm)
 * @param rd        unit view direction
 * @param steps     view-march samples
 * @param lightOct  fbm octaves for the light march (2 is plenty: it is an
 *                  average over a kilometre of cloud)
 * @param dith      0..1 dither offset for the first step
 * @return rgb premultiplied radiance, a = opacity
 */
vec4 skCloudSlab( vec3 ro, vec3 rd,
                  vec3 sunDir, vec3 sunIrr, vec3 moonDir, vec3 moonIrr,
                  vec3 ambSky, vec3 ambGround,
                  int steps, int oct, int lightOct, float dith ) {

  float rBase = SK_GROUND_R + uCloudShape.x * 0.001;
  float rTop = SK_GROUND_R + uCloudShape.y * 0.001;
  float hView = length( ro );

  float tEnter, tExit;
  if ( hView < rBase ) {
    // Under the deck, the usual case. skRaySphere returns the far root for a
    // ray that starts inside the shell, so a downward ray would come back with
    // an intersection on the OTHER SIDE OF THE PLANET. Everything below the
    // horizon is ground anyway.
    if ( rd.y < -0.012 ) return vec4( 0.0 );
    tEnter = skRaySphere( ro, rd, rBase );
    tExit = skRaySphere( ro, rd, rTop );
    if ( tEnter < 0.0 ) return vec4( 0.0 );
  } else if ( hView < rTop ) {
    tEnter = 0.0;
    float up = skRaySphere( ro, rd, rTop );
    float dn = skRaySphere( ro, rd, rBase );
    tExit = dn > 0.0 ? dn : up;
  } else {
    // Above the deck, looking down into it.
    tEnter = skRaySphere( ro, rd, rTop );
    if ( tEnter < 0.0 ) return vec4( 0.0 );
    float dn = skRaySphere( ro, rd, rBase );
    tExit = dn > 0.0 ? dn : skRaySphere( ro, rd, rTop );
  }
  if ( tExit <= tEnter ) return vec4( 0.0 );

  // Cap the march. A ray five degrees above the horizon crosses 120 km of deck;
  // marching that with a fixed step count turns every sample into an average of
  // the whole field and the deck goes uniformly grey. Capping it and fading the
  // remainder into the haze is both cheaper and what the atmosphere does anyway.
  float span = min( tExit - tEnter, 0.048 ); // 48 km
  float distKM = tEnter * 1000.0;
  /**
   * Distance fade into the horizon haze — and it has to know what kind of cloud
   * it is fading. A broken cumulus field genuinely does run out: the individual
   * billows get small, the gaps between them get large, and past thirty
   * kilometres it is haze. A STRATUS SHEET does not. It is continuous to the
   * horizon by definition, and fading it out on the cumulus curve left a band of
   * clean blue sky under an overcast, which is the one thing an overcast cannot
   * have.
   */
  float fadeStart = mix( 26.0, 65.0, uCloudShape.z );
  float fadeEnd = mix( 105.0, 260.0, uCloudShape.z );
  float far = 1.0 - smoothstep( fadeStart, fadeEnd, distKM );
  if ( far <= 0.003 ) return vec4( 0.0 );

  float prevG = 0.0;

  float cosSun = dot( rd, sunDir );
  float cosMoon = dot( rd, moonDir );
  // Forward lobe for the silver lining, back lobe so a cloud lit from behind
  // the camera still has shape. Real water droplets at these radii do both.
  float phS = mix( skHG( cosSun, 0.80 ), skHG( cosSun, -0.22 ), 0.30 );
  float phM = mix( skHG( cosMoon, 0.78 ), skHG( cosMoon, -0.20 ), 0.30 );
  // Normalise out the 1/4pi so the phase is a *relative* gain around 1, which
  // keeps the deck on the same photometric scale the rest of the sky is on.
  phS *= 4.0 * SK_PI;
  phM *= 4.0 * SK_PI;

  float sigma = uCloudParams.y * uCloudLight.x;

  vec3 sum = vec3( 0.0 );
  float trans = 1.0;

  for ( int i = 0; i < steps; i ++ ) {
    if ( trans < 0.008 ) break;
    /**
     * NON-UNIFORM STEPS.
     *
     * A ray five degrees above the horizon crosses tens of kilometres of deck,
     * and a uniform sixteen-step march over that is a 3 km step through a field
     * whose features are 500 m wide — every sample is an average of the whole
     * thing and the far half of the deck comes back as an even grey wash. But
     * the far half is also where the screen area ISN'T: at 40 km a cloud is a
     * couple of pixels tall. Distributing the samples quadratically puts two
     * thirds of them in the first third of the span, where the structure is
     * actually resolvable, and lets the far end be the blur it deserves to be.
     */
    float f = float( i + 1 ) / float( steps );
    float g = f * ( 0.34 + 0.66 * f );
    float dt = ( g - prevG ) * span;
    float t = tEnter + span * ( prevG + ( g - prevG ) * dith );
    prevG = g;
    if ( dt <= 1.0e-7 ) continue;
    vec3 p = ro + rd * t;
    float d = skCloudDensity( p, oct, true );
    if ( d <= 0.003 ) continue;

    float ext = d * sigma;
    float dtKM = dt * 1000.0;
    float aT = exp( -ext * dtKM );

    float tauS = skCloudLightMarch( p, sunDir, lightOct );
    vec3 msS = skCloudScatter( tauS, sigma );

    // Powder: the multiple-scattering deficit at a thin lit edge. It darkens the
    // rim RELATIVE to the deep core, which is what a real cloud shows against
    // the sun, and it is NOT what darkens bases — the light march is.
    float powder = 1.0 - exp( -d * uCloudLight.z * 5.0 );
    float pw = mix( 1.0, powder, uCloudLight.z > 0.0 ? 0.62 : 0.0 );

    vec3 lum = sunIrr * ( msS * phS * pw );

    float tauM = skCloudLightMarch( p, moonDir, lightOct );
    lum += moonIrr * ( skCloudScatter( tauM, sigma ) * phM * pw );

    lum /= SK_PI;

    // Ambient: sky from above, ground bounce from below, weighted by where in
    // the slab this sample sits. A cloud base over a city is measurably warmer
    // than its top, and that split is free here.
    float hf = clamp( ( skCloudAltKM( p ) - uCloudShape.x )
                      / max( 0.05, uCloudShape.y - uCloudShape.x ), 0.0, 1.0 );
    // Self-occlusion of the ambient: deep in the deck you see very little sky.
    float amb = uCloudLight.y * ( 0.22 + 0.78 * exp( -d * sigma * 1.4 ) );
    lum += mix( ambGround, ambSky, hf * hf ) * amb;

    // Analytic segment integration (exact for constant media over dt).
    sum += trans * lum * ( 1.0 - aT );
    trans *= aT;
  }

  float alpha = ( 1.0 - trans ) * far;
  return vec4( sum * far, clamp( alpha, 0.0, 1.0 ) );
}

// ---------------------------------------------------------------------------
//  cirrus
// ---------------------------------------------------------------------------

/**
 * One family of cirrus, p in kilometres on the deck.
 *
 * WHY THIS IS SHAPED THE WAY IT IS — the starburst, and its two successors.
 *
 * The deck is sampled where the view ray meets a shell 7.8 km up, so the map from
 * screen space to p is a projection whose derivative grows without bound as the
 * ray flattens toward that shell. Three separate artefacts came out of that:
 *
 *  1  STARBURST. A field with a locally constant direction is a family of
 *     parallel lines, and parallel lines on a plane converge on a vanishing
 *     point — every fibre pointed at the same spot on screen.
 *  2  FINGERPRINT. Rotating the anisotropy frame by a full +-1.45 rad instead
 *     removes the vanishing point and replaces it with something worse: the
 *     fibres close into concentric whorls and the sky reads as wood grain.
 *  3  BRUSH STROKES. A level set of a ridged field is a continuous curve that
 *     runs through as many cells as it likes, which is why raising the noise
 *     frequency only ever made the strokes thinner, never shorter.
 *
 * The answer to all three is to stop letting the anisotropic field decide *where
 * there is cloud*: an isotropic warped fbm sets the silhouette, and the
 * anisotropic ridge only modulates its density between 0.35 and 1.4.
 */
float skCirrusBand( vec2 p, float cov, float seed, float base,
                    float rotKmInv, float lenKM, float aniso, int oct ) {
  vec2 w = vec2( skVal2( p * 0.30 + seed ), skVal2( p * 0.30 + seed + 11.7 ) ) - 0.5;
  float n = skFbm2( p * 0.78 + w * 1.3, oct + 1 );
  float d = smoothstep( 1.0 - cov * 1.65, 1.0 - cov * 0.60, n );
  if ( d <= 0.001 ) return 0.0;

  // Fronts: the layer arrives in bands with clean sky between them.
  d *= smoothstep( 0.36, 0.66, skVal2( p * 0.12 + seed * 0.5 ) );
  if ( d <= 0.001 ) return 0.0;

  float ang = base + ( skVal2( p * rotKmInv + seed ) - 0.5 ) * 1.1;
  float ca = cos( ang ), sa = sin( ang );
  vec2 pr = vec2( p.x * ca - p.y * sa, p.x * sa + p.y * ca );
  float fa = 1.0 / max( 0.4, lenKM );
  vec2 q = vec2( pr.x * fa, pr.y * fa * aniso );
  float f = skSmoothRidge2( q + vec2( seed ), oct );
  return d * ( 0.35 + 1.05 * f );
}

/** Cirrus deck at 7.8 km. Returns rgb premultiplied, a = opacity. */
vec4 skCirrus( vec3 ro, vec3 rd, vec3 sunDir, vec3 sunHigh,
               vec3 moonDir, vec3 moonHigh, vec3 ambient ) {
  float cov = clamp( uCloudParams2.x, 0.0, 1.0 );
  if ( cov <= 0.002 || uCloudParams2.y <= 0.002 ) return vec4( 0.0 );

  float tc = skRaySphere( ro, rd, SK_GROUND_R + SK_CIRRUS_KM * 0.001 );
  if ( tc <= 0.0 ) return vec4( 0.0 );
  float distKM = tc * 1000.0;

  // Distance fade, doing antialiasing as much as atmospherics: below ~15 degrees
  // of elevation d(distance)/d(elevation) is over 400 m per screen pixel, which
  // is several times the width of a fibre. Ending the layer at 90 km removes the
  // whole undersampled band, and a real cirrus deck does fade into the haze there.
  float fade = 1.0 - smoothstep( 22.0, 90.0, distKM );
  // Above ~35 degrees the derivative blows up the other way and the field smears
  // radially through the zenith. High cirrus overhead is thin anyway.
  fade *= 1.0 - 0.66 * smoothstep( 0.55, 0.85, rd.y );
  if ( fade <= 0.004 ) return vec4( 0.0 );

  vec2 wind = vec2( uCloudParams2.z, uCloudParams2.w ) * uCloudParams.w;
  vec2 p = ( ro + rd * tc ).xz * 1000.0 + wind * 2.4;

  // Two decorrelated families 75 degrees apart: each square of sky is dominated
  // by one of them, but the frame always contains both, and two families 75
  // degrees apart cannot share a vanishing point.
  float d1 = skCirrusBand( p, cov, 0.0, 0.24, 0.135, 1.5, 4.0, 2 );
  float d2 = skCirrusBand( p + 137.4, cov * 0.92, 4.7, 1.56, 0.098, 2.0, 3.4, 2 );
  float d = 1.0 - ( 1.0 - d1 ) * ( 1.0 - d2 * 0.85 );
  float a = clamp( d * uCloudParams2.y * fade, 0.0, 0.70 );
  if ( a <= 0.002 ) return vec4( 0.0 );

  // Optically thin: mostly forward scatter plus whatever the sky gives back.
  // Cirrus sit above most of the aerosol, so they keep far more blue than the
  // cumulus below them — which is why a sunset goes pink up high and
  // orange-grey lower down.
  float fwd = skHG( dot( rd, sunDir ), 0.74 ) * 3.2 + 0.60;
  vec3 col = ( sunHigh * fwd + moonHigh * ( skHG( dot( rd, moonDir ), 0.68 ) * 2.8 + 0.55 ) )
             / SK_PI + ambient * 0.85;
  return vec4( col * a, a );
}

// ---------------------------------------------------------------------------
//  ground shadow
// ---------------------------------------------------------------------------

/**
 * Fraction of direct sunlight reaching a world XZ point through the deck.
 *
 * Marched through the slab from the ground, which is the only way to get the
 * long shadow a low sun throws — a flat-deck lookup puts a cloud's shadow
 * directly under the cloud at every hour, and at 19:20 that is wrong by
 * kilometres.
 */
float skCloudShadow( vec2 worldXZ, vec3 sunDir ) {
  if ( sunDir.y < 0.02 ) return 1.0;
  // Ground point in the planet frame. worldXZ is metres, uViewPos is Mm.
  vec3 g = vec3( worldXZ.x * 1e-6, SK_GROUND_R, worldXZ.y * 1e-6 );
  float baseKM = uCloudShape.x;
  float topKM = uCloudShape.y;
  // Walk from the base of the deck to its top along the sun ray.
  float t0 = ( baseKM * 0.001 ) / max( 0.06, sunDir.y );
  float t1 = ( topKM * 0.001 ) / max( 0.06, sunDir.y );
  float dt = ( t1 - t0 ) * 0.25;
  float tau = 0.0;
  for ( int i = 0; i < 4; i ++ ) {
    vec3 p = g + sunDir * ( t0 + ( float( i ) + 0.5 ) * dt );
    tau += skCloudDensity( p, 4, false ) * dt;
  }
  return exp( -tau * 1000.0 * uCloudParams.y * uCloudLight.x * 0.55 );
}

#endif
`;

/**
 * CPU twin of skCloudMacro. Identical expression, so the sun-occlusion factor
 * the DirectionalLight uses is the same field the shader draws. float32 vs
 * float64 differ in the last few bits; nothing here is sensitive to that.
 */
export function cloudMacro(x, y) {
  const a = Math.sin(x * 0.412 + 0.7) * Math.cos(y * 0.331 - 0.4);
  const b = Math.sin(x * 0.173 - y * 0.209 + 1.9);
  const c = Math.cos(x * 0.0871 + y * 0.1123 - 0.6);
  return Math.min(1, Math.max(0, 0.5 + 0.5 * (0.42 * a + 0.36 * b + 0.3 * c)));
}

/**
 * Approximate fraction of direct sunlight surviving the deck above a world
 * point. Uses the macro field only: the fbm detail modulates *within* a cloud,
 * but whether the sun is behind a cloud at all is a weather-scale question,
 * which is exactly what the macro field answers.
 *
 * This is the CPU path used for the sun DirectionalLight's global dimming. The
 * per-pixel shadow patches on the street come from `skCloudShadow` above,
 * rendered into a shadow map (see cloudShadowMap in index.js).
 */
export function cloudSunOcclusion(worldX, worldZ, sunDir, params) {
  const h = params.baseKM ?? 1.2;
  const k = h / Math.max(0.1, sunDir.y);
  const px = worldX * 0.001 + sunDir.x * k + params.windX * params.time;
  const pz = worldZ * 0.001 + sunDir.z * k + params.windZ * params.time;
  const macro = cloudMacro(px * 0.22, pz * 0.22);
  const cov = Math.min(1, Math.max(0, params.coverage * (0.34 + 1.3 * macro)));
  // Expected density for a coverage threshold applied to a [0,1] fbm.
  const d = Math.min(1, Math.max(0, (cov - 0.42) / 0.62));
  return Math.exp(-d * params.density * 1.55);
}
