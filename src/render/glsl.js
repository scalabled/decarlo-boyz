/**
 * Shared GLSL building blocks for the DeCarlo Boyz render pipeline.
 *
 * Every post pass is a full-screen *triangle* (not a quad) — one primitive,
 * no diagonal seam, better quad utilisation on tiled GPUs.
 *
 * Conventions used everywhere in src/render:
 *   - Linear depth is stored as POSITIVE metres of view-space distance (-z).
 *   - Normals are stored octahedron-encoded in two half-float channels,
 *     in VIEW space.
 *   - Velocity is stored as a UV-space delta (current - previous), so it can
 *     be added directly to a uv to reproject into the previous frame.
 */

export const FS_VERT = /* glsl */ `
varying vec2 vUv;
void main() {
  vUv = position.xy * 0.5 + 0.5;
  gl_Position = vec4( position.xy, 0.0, 1.0 );
}
`;

/** Colour, packing, noise and reconstruction helpers. */
export const COMMON = /* glsl */ `
#ifndef OW_COMMON
#define OW_COMMON

const float OW_PI = 3.141592653589793;
const float OW_HALF_PI = 1.5707963267948966;

float owLum( vec3 c ) { return dot( c, vec3( 0.2126, 0.7152, 0.0722 ) ); }

// --- sRGB transfer ---------------------------------------------------------
vec3 owLinearToSrgb( vec3 c ) {
  c = max( c, vec3( 0.0 ) );
  return mix( c * 12.92, 1.055 * pow( c, vec3( 0.41666667 ) ) - 0.055, step( 0.0031308, c ) );
}
vec3 owSrgbToLinear( vec3 c ) {
  return mix( c / 12.92, pow( ( c + 0.055 ) / 1.055, vec3( 2.4 ) ), step( 0.04045, c ) );
}

// --- YCoCg (TAA neighbourhood clipping works far better in YCoCg) ----------
vec3 owRgbToYCoCg( vec3 c ) {
  return vec3(
     0.25 * c.r + 0.5 * c.g + 0.25 * c.b,
     0.5  * c.r              - 0.5  * c.b,
    -0.25 * c.r + 0.5 * c.g - 0.25 * c.b );
}
vec3 owYCoCgToRgb( vec3 c ) {
  float t = c.x - c.z;
  return vec3( t + c.y, c.x + c.z, t - c.y );
}

// --- octahedral normal packing --------------------------------------------
vec2 owOctWrap( vec2 v ) {
  return ( 1.0 - abs( v.yx ) ) * vec2( v.x >= 0.0 ? 1.0 : -1.0, v.y >= 0.0 ? 1.0 : -1.0 );
}
vec2 owEncodeNormal( vec3 n ) {
  n /= ( abs( n.x ) + abs( n.y ) + abs( n.z ) + 1e-8 );
  n.xy = n.z >= 0.0 ? n.xy : owOctWrap( n.xy );
  return n.xy;
}
vec3 owDecodeNormal( vec2 f ) {
  vec3 n = vec3( f.x, f.y, 1.0 - abs( f.x ) - abs( f.y ) );
  float t = max( -n.z, 0.0 );
  n.xy += vec2( n.x >= 0.0 ? -t : t, n.y >= 0.0 ? -t : t );
  return normalize( n );
}

// --- noise -----------------------------------------------------------------
// Interleaved gradient noise (Jimenez) — the right dither for rotating
// sample kernels that a temporal filter then resolves.
float owIGN( vec2 p ) {
  return fract( 52.9829189 * fract( dot( p, vec2( 0.06711056, 0.00583715 ) ) ) );
}
float owHash12( vec2 p ) {
  vec3 p3 = fract( vec3( p.xyx ) * 0.1031 );
  p3 += dot( p3, p3.yzx + 33.33 );
  return fract( ( p3.x + p3.y ) * p3.z );
}
vec2 owHash22( vec2 p ) {
  vec3 p3 = fract( vec3( p.xyx ) * vec3( 0.1031, 0.1030, 0.0973 ) );
  p3 += dot( p3, p3.yzx + 33.33 );
  return fract( ( p3.xx + p3.yz ) * p3.zy );
}
// Blue-ish 8x8 ordered dither, used to break up 8-bit output banding.
float owDither( vec2 p ) {
  return owHash12( floor( p ) ) - 0.5;
}

// --- reconstruction --------------------------------------------------------
// View-space position from a uv + POSITIVE linear view depth.
vec3 owViewPos( vec2 uv, float depth, mat4 projInv ) {
  vec4 h = projInv * vec4( uv * 2.0 - 1.0, 1.0, 1.0 );
  vec3 dir = h.xyz / h.w;
  dir /= max( 1e-6, -dir.z );
  return dir * depth;
}
// The unit ray (z = -1 plane) through a uv.
vec3 owViewRay( vec2 uv, mat4 projInv ) {
  vec4 h = projInv * vec4( uv * 2.0 - 1.0, 1.0, 1.0 );
  vec3 dir = h.xyz / h.w;
  return dir / max( 1e-6, -dir.z );
}

#endif
`;

/** AgX + ACES filmic tone mapping, written for the composite pass. */
export const TONEMAP = /* glsl */ `
#ifndef OW_TONEMAP
#define OW_TONEMAP

const mat3 OW_REC2020_FROM_SRGB = mat3(
  vec3( 0.6274, 0.0691, 0.0164 ),
  vec3( 0.3293, 0.9195, 0.0880 ),
  vec3( 0.0433, 0.0113, 0.8956 ) );
const mat3 OW_SRGB_FROM_REC2020 = mat3(
  vec3(  1.6605, -0.1246, -0.0182 ),
  vec3( -0.5876,  1.1329, -0.1006 ),
  vec3( -0.0728, -0.0083,  1.1187 ) );

/**
 * HIGHLIGHT SHOULDER — replaces a HARD CLIP at maxEv.
 *
 * The log-normalised value used to be clamped to 1.0, per channel, which is a
 * cliff: every scene value above maxEv landed on exactly the same code value,
 * and because the clip is PER CHANNEL a coloured highlight lost its two
 * smaller channels first and arrived at display white achromatic. Measured on
 * the night frame: a lit shop window slab read 181,184,194 — 6.5% saturation,
 * a flat plateau whose interior varied by under ten code values across forty
 * pixels even though the emitter behind it spans two stops of radiance.
 * A critic panel described it exactly: "clips to flat achromatic 255 that
 * falls off by eight code values over 40 px and illuminates nothing".
 *
 * A film stock does not do that. It has a shoulder: response keeps rising
 * toward Dmax with a falling slope, so a bright surface still carries shape
 * and hue right up to white. This is that shoulder, in the same log space the
 * curve already works in:
 *
 *     below k          identity
 *     k .. k+h         smooth, slope 1 at k falling to 0 at white
 *     h = 2(1-k)       the reach that makes the slope continuous at k
 *
 * so nothing below the knee moves at all (daylight mid-tones are untouched),
 * white is still REACHABLE — which is what the narrowed latitude was for —
 * and it now takes ~3.3 stops of roll-off to get there instead of a step.
 *
 * The hue behaviour falls out for free: the channel furthest into the shoulder
 * is compressed hardest, so a warm window that used to resolve to (1,1,0.7)
 * now resolves to (1,0.94,0.7) and stays warm as it blows.
 */
vec3 owAgxShoulder( vec3 x, float k ) {
  float h = 2.0 * ( 1.0 - k );
  vec3 t = clamp( ( x - k ) / max( h, 1e-4 ), 0.0, 1.0 );
  return min( x, k + ( 1.0 - k ) * t * ( 2.0 - t ) );
}

vec3 owAgxContrast( vec3 x ) {
  vec3 x2 = x * x;
  vec3 x4 = x2 * x2;
  return 15.5 * x4 * x2 - 40.14 * x4 * x + 31.96 * x4 - 6.868 * x2 * x
       + 0.4298 * x2 + 0.1191 * x - 0.00232;
}

/**
 * AgX with a punchy "look" applied in log space, and an ADJUSTABLE LATITUDE.
 *
 * minEv / maxEv are the log-exposure range the curve maps onto 0..1, and
 * stock AgX uses -12.47..+4.03 — 16.5 stops. That is a scene-referred archival
 * range, not a game-camera range, and it is why the inherited frame measured
 * p99.9 = 243.6/255 with only 0.0007% of pixels above 254: 4.03 stops of
 * highlight headroom above the point where a sunlit surface sits means NOTHING
 * short of a 16x specular event can reach display white, so the top fifth of
 * the histogram is simply never addressed and the image reads as flat.
 *
 * A film stock has 5-6 stops above mid grey to its shoulder, not 6.5, and a
 * shipped game camera is tighter still. Narrowing the latitude is what puts the
 * shoulder back where bright things can actually reach it — it does not
 * "brighten" the image (mid grey is re-anchored by the metering either way), it
 * redistributes contrast into the range the image occupies.
 */
vec3 owAgX( vec3 color, float slope, float power, float sat, float minEv, float maxEv, float shoulder ) {
  const mat3 inset = mat3(
    vec3( 0.856627153315983, 0.137318972929847, 0.11189821299995 ),
    vec3( 0.0951212405381588, 0.761241990602591, 0.0767994186031903 ),
    vec3( 0.0482516061458583, 0.101439036467562, 0.811302368396859 ) );
  const mat3 outset = mat3(
    vec3(  1.1271005818144368, -0.1413297634984383, -0.14132976349843826 ),
    vec3( -0.11060664309660323, 1.157823702216272, -0.11060664309660294 ),
    vec3( -0.016493938717834573, -0.016493938717834257, 1.2519364065950405 ) );

  color = OW_REC2020_FROM_SRGB * color;
  color = inset * color;
  color = max( color, 1e-10 );
  color = ( log2( color ) - minEv ) / ( maxEv - minEv );
  // NOT clamp(color, 0.0, 1.0). See owAgxShoulder: the upper clamp was a hard
  // per-channel clip that turned every emitter in the night city into a flat
  // achromatic slab. The lower bound stays a clamp — there is nothing below
  // the toe to preserve.
  color = owAgxShoulder( max( color, 0.0 ), shoulder );

  // look: slope / power / saturation in log space
  color = pow( max( color * slope, 0.0 ), vec3( power ) );
  float l = owLum( color );
  color = l + sat * ( color - l );

  color = owAgxContrast( clamp( color, 0.0, 1.0 ) );
  color = outset * color;
  color = pow( max( color, vec3( 0.0 ) ), vec3( 2.2 ) );
  color = OW_SRGB_FROM_REC2020 * color;
  return clamp( color, 0.0, 1.0 );
}

vec3 owRRTODTFit( vec3 v ) {
  vec3 a = v * ( v + 0.0245786 ) - 0.000090537;
  vec3 b = v * ( 0.983729 * v + 0.4329510 ) + 0.238081;
  return a / b;
}
vec3 owACES( vec3 color ) {
  const mat3 inMat = mat3(
    vec3( 0.59719, 0.07600, 0.02840 ),
    vec3( 0.35458, 0.90834, 0.13383 ),
    vec3( 0.04823, 0.01566, 0.83777 ) );
  const mat3 outMat = mat3(
    vec3(  1.60475, -0.10208, -0.00327 ),
    vec3( -0.53108,  1.10813, -0.07276 ),
    vec3( -0.07367, -0.00605,  1.07602 ) );
  color = inMat * color;
  color = owRRTODTFit( color );
  color = outMat * color;
  return clamp( color, 0.0, 1.0 );
}

#endif
`;
