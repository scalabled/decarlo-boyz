import * as THREE from 'three';
import { COMMON, TONEMAP } from './glsl.js';
import { Pass } from './pass.js';

/**
 * Final composite: exposure -> lens (chromatic aberration, additive thresholded
 * bloom, cos^4 lens shading — all in linear light) -> AgX filmic tone map ->
 * procedural LUT grade -> grain -> contrast-adaptive sharpen -> sRGB with an
 * ordered dither.
 *
 * All of it in one pass, one pass over the framebuffer, so the bandwidth cost
 * is a single read/write rather than one per effect.
 */

const COMPOSITE = /* glsl */ `
precision highp float;
${COMMON}
${TONEMAP}

uniform sampler2D tColor;
uniform sampler2D tBloom;
uniform sampler2D tExposure;
uniform sampler3D tLut;

uniform vec2 uTexel;
uniform vec2 uResolution;
uniform vec4 uLens;      // x chromatic, y vignette, z grainAmount, w time
uniform vec4 uGrade;     // x bloomStrength, y lutStrength, z sharpen, w lutSize
uniform float uFallbackExp; // exposure to use when the meter reads invalid
uniform vec4 uLook;      // x agx slope, y agx power, z agx sat, w exposureBias
uniform vec2 uBloomCa;   // x lateral dispersion, y chroma boost
uniform float uBloomCap; // ceiling on the lift the pyramid may add to a pixel
uniform vec3 uAgx;       // x minEv, y maxEv (latitude), z shoulder knee
varying vec2 vUv;

vec3 sampleLut( vec3 c ) {
  float n = uGrade.w;
  vec3 uvw = clamp( c, 0.0, 1.0 ) * ( ( n - 1.0 ) / n ) + ( 0.5 / n );
  return texture( tLut, uvw ).rgb;
}

void main() {
  // The meter is a 1x1 target the GPU wrote. If that write never landed the
  // read is 0 and this multiply takes the ENTIRE image to black — which is
  // exactly how the game shipped on mobile GPUs that cannot render to a 32-bit
  // float target: controls alive, HUD alive, world invisible. floatType() in
  // pass.js stops the target being unrenderable; this stops a black frame ever
  // being the failure mode again, whatever the cause.
  //
  // The floor is far below any exposure the meter produces in play (night
  // locks around 0.35), so it never clamps a real reading — it only catches
  // zero, and NaN, which fails the comparison and takes the same branch.
  // uFallbackExp is a CPU-side estimate from the sun angle we are standing in.
  // A hard-coded 1.0 here was itself about three stops under a daylight street,
  // so the rescue looked like a different bug rather than none.
  float metered = texture2D( tExposure, vec2( 0.5 ) ).r;
  if ( !( metered > 0.0025 ) ) metered = uFallbackExp;
  float exposure = metered * uLook.w;

  vec2 d = vUv - 0.5;
  float r2 = dot( d, d );

  // --- chromatic aberration ------------------------------------------------
  // Lateral CA on a real lens grows as r^2 from the OPTICAL CENTRE and is
  // exactly zero on axis. The offset here is ( d * ca ) and length(d) is r, so ca has
  // to be linear in r for the displacement to be quadratic: it used to be
  // quadratic in r, making the displacement cubic — which puts essentially all
  // of the effect in the last few percent of the frame and none of it anywhere
  // a viewer looks, so what reads instead is a uniform channel split rather
  // than a lens signature.
  //
  // Peak is ~0.8 px at the corner of a 1920-wide frame and 0 at centre. A
  // constant split at the centre is a rendering fault, not a lens.
  vec3 hdr;
  float ca = uLens.x * sqrt( r2 );
  if ( ca > 0.00002 ) {
    vec2 o = d * ca;
    hdr.r = texture2D( tColor, vUv + o ).r;
    hdr.g = texture2D( tColor, vUv ).g;
    hdr.b = texture2D( tColor, vUv - o ).b;
  } else {
    hdr = texture2D( tColor, vUv ).rgb;
  }
  vec3 centre = max( texture2D( tColor, vUv ).rgb, vec3( 0.0 ) );
  hdr = max( hdr, vec3( 0.0 ) );

  vec3 n1 = max( texture2D( tColor, vUv + vec2( uTexel.x, 0.0 ) ).rgb, vec3( 0.0 ) );
  vec3 n2 = max( texture2D( tColor, vUv - vec2( uTexel.x, 0.0 ) ).rgb, vec3( 0.0 ) );
  vec3 n3 = max( texture2D( tColor, vUv + vec2( 0.0, uTexel.y ) ).rgb, vec3( 0.0 ) );
  vec3 n4 = max( texture2D( tColor, vUv - vec2( 0.0, uTexel.y ) ).rgb, vec3( 0.0 ) );

  // --- chroma clean-up in the darks ---------------------------------------
  // A 4-tap CHROMA-only blur, applied only in the bottom three stops and
  // fading out completely by the mid-tones. It keeps each pixel's own
  // luminance exactly — so no detail, edge or texture is softened — and only
  // pulls its hue toward the neighbourhood's.
  //
  // The post chain is no longer the source of the per-pixel chroma speckle
  // over dark surfaces (measured: turning grain, CA and sharpen off together
  // moves the high-frequency chroma metric by under 5%), but the night frame
  // still reads as speckled because a ~14x exposure amplifies whatever chroma
  // variance the shading has. The eye has almost no chroma acuity down there,
  // which is exactly why every codec and every denoiser throws dark chroma
  // away, and why doing it here costs nothing visible but the noise.
  {
    vec3 nb = ( n1 + n2 + n3 + n4 ) * 0.25;
    float lh = owLum( hdr );
    float ln = owLum( nb );
    float w = ( 1.0 - smoothstep( 0.003, 0.030, lh ) ) * 0.60;
    if ( w > 0.005 && ln > 1e-6 ) hdr = mix( hdr, nb * ( lh / ln ), w );
  }

  // --- sharpen (contrast adaptive, only where TAA softened things) ---------
  // LUMINANCE ONLY, and computed from the UNSHIFTED centre tap. The old code
  // sharpened hdr, which is the chromatically-aberrated fetch, against a blur
  // of unshifted neighbours: the difference therefore *contained the CA offset
  // itself* and the sharpen amplified it, which is where the coarse
  // magenta/green fringing on every high-contrast edge came from. A scalar gain
  // around the centre luminance cannot invent chroma at all.
  if ( uGrade.z > 0.001 ) {
    float l1 = owLum( n1 ), l2 = owLum( n2 ), l3 = owLum( n3 ), l4 = owLum( n4 );
    float lc = owLum( centre );
    float lmn = min( min( l1, l2 ), min( l3, l4 ) );
    float lmx = max( max( l1, l2 ), max( l3, l4 ) );
    float lblur = ( l1 + l2 + l3 + l4 ) * 0.25;
    // contrast adaptive: less sharpening where local contrast is already high
    float contrast = ( lmx - lmn ) / ( lmx + lmn + 0.02 );
    float amount = uGrade.z * ( 1.0 - clamp( contrast * 1.6, 0.0, 1.0 ) );
    // ...and none at all down in the noise floor, where "detail" is grain.
    amount *= smoothstep( 0.004, 0.03, lc );
    float gain = ( lc + ( lc - lblur ) * amount ) / max( lc, 1e-4 );
    hdr *= clamp( gain, 0.0, 4.0 );
  }

  hdr *= exposure;

  // --- bloom (already exposure-scaled AND thresholded in the prefilter) ----
  // ADDED, not mixed. mix() with an unthresholded pyramid is veiling glare: it
  // replaces N% of every pixel with a blurred copy of the frame, which is a
  // milky haze you cannot turn up far enough to see a specular event. The
  // pyramid now only carries what is above display white, so adding it puts
  // light around the sun disc, the glints and the muzzle flash and leaves the
  // rest of the frame exactly where the tone curve put it.
  //
  // CHROMATIC, NOT WHITE. Two things, both cheap, both aimed at the night city:
  //
  //  1. lateral dispersion. Real lens glare is wavelength dependent — blue
  //     scatters wider than red — so the three channels are fetched at
  //     different radial offsets. A sodium lamp's halo comes out amber in the
  //     middle and cooler at its edge instead of a flat white disc.
  //  2. a chroma boost about the bloom's own luminance. The Karis average and
  //     the tent filter are both means, and a mean of a coloured highlight and
  //     its dark surroundings is always LESS saturated than the highlight. Left
  //     alone, a street of amber lamps blooms grey-white. Pushing the chroma
  //     back out restores the hue of the source that made it.
  vec2 bo = d * uBloomCa.x;
  vec3 bloom;
  bloom.r = texture2D( tBloom, vUv + bo ).r;
  bloom.g = texture2D( tBloom, vUv ).g;
  bloom.b = texture2D( tBloom, vUv - bo ).b;
  bloom = max( bloom, vec3( 0.0 ) );

  float bLum = owLum( bloom );
  bloom = max( vec3( 0.0 ), bLum + ( bloom - bLum ) * uBloomCa.y );

  //  3. A CEILING ON THE LIFT, which is what let the gain go up at all.
  //
  //     The gain a lit window needs to reach the mullion beside it is the same
  //     gain that self-brightens a big overcast sky, because the pyramid is one
  //     additive term and cannot tell them apart. MEASURED on 'driving', whose
  //     overcast sky already sat at mean 228 / p99 248 before any of this:
  //     raising the gain 0.34 -> 1.15 took pixels over 250 from 0.007% to
  //     4.29%, i.e. clipped the cloud gradient off the top of the sky.
  //
  //     The two cases differ by MAGNITUDE, not by kind: the sky's own pyramid
  //     value is a large fraction of display white, the mullion's is under one
  //     percent of it. So the ceiling is on the ADDED amount. Everything small
  //     — every skirt, every spill, every glint's halo — passes untouched, and
  //     only a term large enough to be veiling glare over a whole region is
  //     limited. Applied on the max channel with a proportional scale, so a
  //     capped amber lamp stays amber instead of clipping toward white.
  vec3 badd = bloom * max( uGrade.x, 0.0 );
  float bmax = max( max( badd.r, badd.g ), badd.b );
  badd *= min( 1.0, uBloomCap / max( bmax, 1e-5 ) );
  hdr += badd;

  // --- vignette: cos^4 natural falloff, in LINEAR LIGHT --------------------
  // Lens shading is a transmission loss, so it belongs in front of the tone
  // curve, not behind it. Applied in display space it was a flat multiply on the
  // code value: at 0.24 it scaled everything outside the middle sixth of the
  // frame by 0.85..0.81, which put a hard ceiling of ~210 code values on the sky
  // and made display white unreachable anywhere but dead centre. In linear light
  // the same 0.24 costs a quarter of a stop, which the filmic shoulder absorbs
  // in the highlights (a few code values) while still visibly weighting the mids
  // and shadows toward the corners — which is the whole point of a vignette.
  float cos4 = pow( 1.0 / ( 1.0 + r2 * 2.4 ), 2.0 );
  hdr *= mix( 1.0, cos4, uLens.y );

  // --- tone map ------------------------------------------------------------
  vec3 col = owAgX( hdr, uLook.x, uLook.y, uLook.z, uAgx.x, uAgx.y, uAgx.z );

  // --- DISPLAY TRANSFORM ---------------------------------------------------
  // Everything below this line is display-referred (code values, 0..1 sRGB).
  // The grade LUT and the grain are authored in that space:
  // the LUT's toe/shadowTint are additive *code value* offsets, so feeding it
  // linear light turned a 0.008 toe into a hard linear floor and painted the
  // whole frame's shadows blue-grey. Encode first, grade second.
  col = clamp( col, 0.0, 1.0 );
  vec3 disp = owLinearToSrgb( col );

  // --- procedural film grade (display-referred) ----------------------------
  vec3 graded = sampleLut( disp );
  disp = mix( disp, graded, uGrade.y );

  // --- grain, in code-value space, LESS of it in the darks -----------------
  // Real sensor noise is loudest in the mid/upper mids once it has been
  // through a display transform; in the darks it is what the eye reads as
  // "dirty image", so the response is deliberately the opposite of the naive
  // "more grain where it is dark".
  if ( uLens.z > 0.0005 ) {
    float g = owHash12( gl_FragCoord.xy + uLens.w * 137.13 ) - 0.5;
    float g2 = owHash12( gl_FragCoord.xy * 1.7 - uLens.w * 71.3 ) - 0.5;
    float noise = ( g * 0.65 + g2 * 0.35 );
    float l = owLum( disp );
    float response = uLens.z * ( 0.35 + 0.65 * smoothstep( 0.0, 0.30, l ) );
    disp += noise * response;
  }

  // ordered dither before the 8-bit write kills gradient banding in the sky
  disp += ( owHash12( gl_FragCoord.xy * 0.5 + uLens.w ) - 0.5 ) * 0.0022;

  gl_FragColor = vec4( disp, 1.0 );
}
`;

const FXAA = /* glsl */ `
precision highp float;
${COMMON}
uniform sampler2D tColor;
uniform vec2 uTexel;
varying vec2 vUv;

// Compact FXAA 3.11-style edge filter, used only when TAA is off so the
// no-temporal path still has clean silhouettes.
void main() {
  vec3 rgbNW = texture2D( tColor, vUv + vec2( -1.0, -1.0 ) * uTexel ).rgb;
  vec3 rgbNE = texture2D( tColor, vUv + vec2(  1.0, -1.0 ) * uTexel ).rgb;
  vec3 rgbSW = texture2D( tColor, vUv + vec2( -1.0,  1.0 ) * uTexel ).rgb;
  vec3 rgbSE = texture2D( tColor, vUv + vec2(  1.0,  1.0 ) * uTexel ).rgb;
  vec4 texColor = texture2D( tColor, vUv );
  vec3 rgbM = texColor.rgb;

  float lumaNW = owLum( rgbNW );
  float lumaNE = owLum( rgbNE );
  float lumaSW = owLum( rgbSW );
  float lumaSE = owLum( rgbSE );
  float lumaM  = owLum( rgbM );
  float lumaMin = min( lumaM, min( min( lumaNW, lumaNE ), min( lumaSW, lumaSE ) ) );
  float lumaMax = max( lumaM, max( max( lumaNW, lumaNE ), max( lumaSW, lumaSE ) ) );

  if ( lumaMax - lumaMin < max( 0.0312, lumaMax * 0.125 ) ) {
    gl_FragColor = texColor;
    return;
  }

  vec2 dir = vec2(
    -( ( lumaNW + lumaNE ) - ( lumaSW + lumaSE ) ),
      ( ( lumaNW + lumaSW ) - ( lumaNE + lumaSE ) ) );
  float dirReduce = max( ( lumaNW + lumaNE + lumaSW + lumaSE ) * 0.03125, 0.0078125 );
  float rcpDirMin = 1.0 / ( min( abs( dir.x ), abs( dir.y ) ) + dirReduce );
  dir = clamp( dir * rcpDirMin, -8.0, 8.0 ) * uTexel;

  vec3 rgbA = 0.5 * (
    texture2D( tColor, vUv + dir * ( 1.0 / 3.0 - 0.5 ) ).rgb +
    texture2D( tColor, vUv + dir * ( 2.0 / 3.0 - 0.5 ) ).rgb );
  vec3 rgbB = rgbA * 0.5 + 0.25 * (
    texture2D( tColor, vUv - dir * 0.5 ).rgb +
    texture2D( tColor, vUv + dir * 0.5 ).rgb );

  float lumaB = owLum( rgbB );
  gl_FragColor = vec4( ( lumaB < lumaMin || lumaB > lumaMax ) ? rgbA : rgbB, texColor.a );
}
`;

/**
 * Composite the first-person scene over the finished world image.
 *
 * The viewmodel is rendered into its own MSAA colour+depth target AFTER the TAA
 * resolve, because it is the one thing in the frame whose motion the camera
 * matrices cannot describe. The ADS transition, sway, bob, recoil and the
 * skinned AI meshes all move in VIEW space, so a velocity buffer built from
 * `viewPrevVP`/`viewCurrVP` emits zero motion for them; TAA then reprojected
 * those pixels onto a stale sample containing the static background and blended
 * it in at ~85%, which is why the optic tube, the mount and the glove were
 * semi-transparent with balcony rails and power lines legible straight through.
 * Drawing it after the resolve makes the whole class of bug impossible.
 *
 * The target holds PREMULTIPLIED alpha: opaque geometry lands a = 1, the MSAA
 * resolve produces fractional coverage on the silhouette, additive muzzle flash
 * accumulates a little alpha and a lot of colour. `world * (1 - a) + rgb`
 * handles all three correctly. An FXAA-style edge filter runs on the RGBA so
 * the machining, rail teeth and optic ring get the antialiasing TAA used to
 * provide, without any history to smear.
 */
const VIEW_COMPOSITE = /* glsl */ `
precision highp float;
${COMMON}
uniform sampler2D tColor;
uniform sampler2D tView;
uniform vec2 uTexel;
varying vec2 vUv;

vec4 fetchView( vec2 uv ) { return max( texture2D( tView, uv ), vec4( 0.0 ) ); }
// Alpha is part of the edge signal: the silhouette against an empty background
// is a step in coverage, not in luminance.
float edgeLuma( vec4 c ) { return owLum( c.rgb ) + c.a; }

void main() {
  vec3 world = texture2D( tColor, vUv ).rgb;

  vec4 m = fetchView( vUv );
  vec4 nw = fetchView( vUv + vec2( -1.0, -1.0 ) * uTexel );
  vec4 ne = fetchView( vUv + vec2(  1.0, -1.0 ) * uTexel );
  vec4 sw = fetchView( vUv + vec2( -1.0,  1.0 ) * uTexel );
  vec4 se = fetchView( vUv + vec2(  1.0,  1.0 ) * uTexel );

  float lm = edgeLuma( m );
  float lnw = edgeLuma( nw );
  float lne = edgeLuma( ne );
  float lsw = edgeLuma( sw );
  float lse = edgeLuma( se );
  float lmin = min( lm, min( min( lnw, lne ), min( lsw, lse ) ) );
  float lmax = max( lm, max( max( lnw, lne ), max( lsw, lse ) ) );

  vec4 v = m;
  if ( lmax - lmin >= max( 0.045, lmax * 0.11 ) ) {
    vec2 dir = vec2(
      -( ( lnw + lne ) - ( lsw + lse ) ),
        ( ( lnw + lsw ) - ( lne + lse ) ) );
    float dirReduce = max( ( lnw + lne + lsw + lse ) * 0.03125, 0.0078125 );
    float rcpDirMin = 1.0 / ( min( abs( dir.x ), abs( dir.y ) ) + dirReduce );
    dir = clamp( dir * rcpDirMin, -6.0, 6.0 ) * uTexel;

    vec4 a = 0.5 * (
      fetchView( vUv + dir * ( 1.0 / 3.0 - 0.5 ) ) +
      fetchView( vUv + dir * ( 2.0 / 3.0 - 0.5 ) ) );
    vec4 b = a * 0.5 + 0.25 * (
      fetchView( vUv - dir * 0.5 ) + fetchView( vUv + dir * 0.5 ) );
    float lb = edgeLuma( b );
    v = ( lb < lmin || lb > lmax ) ? a : b;
  }

  float alpha = clamp( v.a, 0.0, 1.0 );
  gl_FragColor = vec4( world * ( 1.0 - alpha ) + v.rgb, 1.0 );
}
`;

export function createViewComposite() {
  return new Pass('ow-view-composite', VIEW_COMPOSITE, {
    tColor: { value: null },
    tView: { value: null },
    uTexel: { value: new THREE.Vector2() },
  });
}

const DEBUG = /* glsl */ `
precision highp float;
${COMMON}
uniform sampler2D tSrc;
uniform int uMode;
varying vec2 vUv;
void main() {
  vec4 s = texture2D( tSrc, vUv );
  vec3 c;
  if ( uMode == 0 ) c = vec3( s.r );                       // scalar (AO, shadow)
  else if ( uMode == 1 ) c = owDecodeNormal( s.xy ) * 0.5 + 0.5;
  else if ( uMode == 2 ) c = vec3( abs( s.rg ) * 40.0, 0.0 ); // velocity
  else if ( uMode == 3 ) c = vec3( fract( s.r * 0.05 ) );  // linear depth
  else if ( uMode == 4 ) c = s.rgb;                        // raw colour
  else c = vec3( s.a );                                    // confidence
  gl_FragColor = vec4( owLinearToSrgb( clamp( c, 0.0, 1.0 ) ), 1.0 );
}
`;

export function createDebug() {
  return new Pass('ow-debug', DEBUG, {
    tSrc: { value: null },
    uMode: { value: 0 },
  });
}

export function createComposite(lut) {
  return new Pass('ow-composite', COMPOSITE, {
    tColor: { value: null },
    tBloom: { value: null },
    tExposure: { value: null },
    tLut: { value: lut.texture },
    uTexel: { value: new THREE.Vector2() },
    uResolution: { value: new THREE.Vector2() },
    uLens: { value: new THREE.Vector4(0.0016, 0.24, 0.010, 0) },
    uGrade: { value: new THREE.Vector4(0.05, 0.85, 0.22, lut.size) },
    // slope / power / saturation of the AgX look, applied to the LOG-NORMALISED
    // value. minEv..maxEv spans 16.5 stops, so power > 1 costs whole stops in
    // the shadows (1.35 lost ~1.8) — the contrast belongs in the LUT, which
    // works about a pivot instead of about zero.
    //
    // SLOPE IS 1.0 AND MUST STAY THERE. It multiplies the *normalised log*
    // value, so 1.05 is not "5% brighter", it is +0.5 EV applied to the whole
    // image at the point where AgX has already decided where mid-grey goes.
    // Together with a contrast pivot below mid-grey it is what put 18% scene
    // grey on code value 153.
    uLook: { value: new THREE.Vector4(1.0, 1.0, 1.08, 1) },
    /**
     * What the meter WOULD have said, from the sun angle alone. Consumed only
     * when the metered texture reads back invalid. `RenderSystem` refreshes it
     * every frame; the 3.0 here is a daylight value so that a frame rendered
     * before the first update is exposed rather than black.
     */
    uFallbackExp: { value: 3.0 },
    // Bloom dispersion (radial, in uv at r^1) and chroma boost. See the note
    // where the bloom is added: this is what stops a night street of sodium
    // lamps blooming into one grey-white smear.
    uBloomCa: { value: new THREE.Vector2(0.0032, 1.55) },
    // Ceiling on how much exposure-scaled linear light the pyramid may add to
    // any one pixel. See the note where it is used. Effectively infinite under
    // '?owNoEmissiveSpill=1', which also drops the gain back to 0.34.
    uBloomCap: { value: 0.12 },
    /**
     * AgX latitude, in stops: (minEv, maxEv). Stock AgX is (-12.47, +4.03) —
     * 16.5 stops, an archival range. Measured consequence on the inherited
     * frame: p99.9 = 243.6/255, 0.0007% of pixels above 254, and a critic panel
     * describing it as "painted cardboard" because the entire top of the
     * histogram was sunlit albedo with nothing above it.
     *
     * (-10.8, +3.1) is 13.9 stops: still more latitude than any film stock, but
     * the shoulder now sits about 4.5 stops over a metered mid grey instead of
     * 6.5, which is where a sunlit facade and a wet-kerb specular actually land.
     * Display white becomes reachable, and the upper mid-tones — the range the
     * critic called "bimodal, pixels dump into a shadow lobe or a highlight
     * lobe" — get populated by the surfaces that were previously all crushed
     * together at the top of the toe.
     */
    /**
     * z is the SHOULDER KNEE, in normalised-log units (see owAgxShoulder).
     *
     * 0.86 with the latitude above puts the start of the roll-off about 3.2
     * stops over the metered average — which is roughly where a sunlit white
     * wall sits, i.e. the brightest thing in the frame that is still a
     * SURFACE. Everything past that is a light source or a specular event, and
     * those are what the shoulder is for. White is reached at 1.14 in the same
     * units, ~1.9 stops further up than the old hard clip, so display white is
     * still attainable by the sun disc, a lamp lens or a muzzle flash.
     */
    uAgx: { value: new THREE.Vector3(-10.8, 3.1, 0.86) },
  });
}

export function createFxaa() {
  return new Pass('ow-fxaa', FXAA, {
    tColor: { value: null },
    uTexel: { value: new THREE.Vector2() },
  });
}
