import * as THREE from 'three';
import { WET_UNIFORMS } from './wetness.js';

/**
 * onBeforeCompile extension for MeshStandardMaterial / MeshPhysicalMaterial.
 *
 * Adds, on top of three's standard PBR shading:
 *   - world / object planar + triplanar projection (no UVs required on the mesh)
 *   - parallax occlusion mapping driven by the height packed in albedo.a
 *   - a micro detail-normal layer that fades out with distance
 *   - macro low-frequency variation (the anti-tiling multiply)
 *   - stochastic two-scale de-tiling with height-preserving blending
 *   - procedural weathering: top-face dust, rain streaks, ground splash
 *   - cavity grime and vertex-colour driven edge wear / dirt masks
 *   - THE WETNESS LAYER: a globally-driven water film that darkens albedo,
 *     drops roughness, fills the height field's low spots with standing water
 *     and rings it with rain (see wetness.js)
 *   - a layered automotive paint model: metallic flake, view-dependent flop and
 *     an orange-peel clearcoat normal
 *   - grime accumulation driven by world height and cavity
 *
 * Everything is a #define so a material only pays for the features it enables.
 *
 * Vertex colour mask contract (all default to 0 = "no effect", so a mesh with
 * no colour attribute is unaffected):
 *   r = edge wear, g = grime, b = extra AO, a = per-instance tint variation
 */

const PARS_VERTEX = /* glsl */ `
varying vec3 vOwWPos;
varying vec3 vOwWNrm;
#ifdef OW_OBJECT_SPACE
  varying vec3 vOwOPos;
  varying vec3 vOwONrm;
  varying mat3 vOwP2V;
#endif
#ifdef OW_PARALLAX
  varying vec3 vOwViewDirP;
#endif
`;

const MAIN_VERTEX = /* glsl */ `
{
  mat4 owModel = modelMatrix;
  #ifdef USE_BATCHING
    owModel = owModel * batchingMatrix;
  #endif
  #ifdef USE_INSTANCING
    owModel = owModel * instanceMatrix;
  #endif
  vec4 owWP = owModel * vec4( transformed, 1.0 );
  vOwWPos = owWP.xyz;
  vOwWNrm = normalize( mat3( owModel ) * objectNormal );

  #ifdef OW_OBJECT_SPACE
    vOwOPos = transformed;
    vOwONrm = normalize( objectNormal );
    mat3 owR = mat3( owModel );
    owR[ 0 ] = normalize( owR[ 0 ] );
    owR[ 1 ] = normalize( owR[ 1 ] );
    owR[ 2 ] = normalize( owR[ 2 ] );
    vOwP2V = mat3( viewMatrix ) * owR;
  #endif

  #ifdef OW_PARALLAX
    #ifdef OW_OBJECT_SPACE
      vOwViewDirP = ( inverse( owModel ) * vec4( cameraPosition, 1.0 ) ).xyz - transformed;
    #else
      vOwViewDirP = cameraPosition - owWP.xyz;
    #endif
  #endif
}
`;

const PARS_FRAGMENT = /* glsl */ `
varying vec3 vOwWPos;
varying vec3 vOwWNrm;
#ifdef OW_OBJECT_SPACE
  varying vec3 vOwOPos;
  varying vec3 vOwONrm;
  varying mat3 vOwP2V;
#endif
#ifdef OW_PARALLAX
  varying vec3 vOwViewDirP;
#endif

uniform sampler2D owDetailNrm;
uniform sampler2D owDetailTex;   // rgb = micro albedo variation, a = micro height
uniform sampler2D owMacroTex;
uniform vec4  owTile;        // xy = scale (tiles per metre, or uv multiplier), zw = offset
uniform vec4  owDetailP;     // x tile, y normal amt, z albedo amt, w fade distance
uniform vec4  owMesoP;       // x tile multiplier, y normal amt, z albedo amt, w rough amt
uniform vec4  owMacroP;      // x scale, y albedo amt, z rough amt, w hue amt
uniform vec4  owMacroBig;    // x contrast, y big-band amt, z big-band scale, w unused
uniform vec4  owPatchP;      // x coverage, y cell metres, z albedo delta, w rough delta
uniform vec4  owZoneP;       // x amount, y cell metres, z paint chance, w soot amount
uniform vec4  owClothP;      // x transmission, y underside darkening, z fold amt, w unused
uniform vec4  owParallaxP;   // x depth (m), y fade start, z fade end, w max layers
uniform vec4  owWeatherP;    // x dust, y streak, z splash height, w cavity grime
uniform vec4  owWearP;       // x wear amt, y grime amt, z vcol AO amt, w curvature
uniform vec3  owTintCol;
uniform vec3  owDustCol;
uniform vec3  owGrimeCol;
uniform vec3  owRustCol;
uniform vec4  owWearMat;     // x rough, y metal, z reserved, w tint amount
uniform vec3  owWearCol;
uniform vec4  owRoughP;      // x scale, y offset, z detile amount, w minimum
uniform vec2  owDetRot;      // cos, sin of the micro-layer rotation
uniform float owNormalAmp;
uniform float owGroundY;
uniform float owAoAmt;
uniform float owMacroRelief;

// Explicit-gradient sampling keeps the mip selection correct through the
// parallax march; OW_NOGRAD falls back to implicit derivatives.
#ifdef OW_NOGRAD
  #define OW_TEX( t, uv, dx, dy ) texture2D( t, uv )
#else
  #define OW_TEX( t, uv, dx, dy ) textureGrad( t, uv, dx, dy )
#endif

/**
 * One directional light's contribution to fabric transmission. A macro with a
 * literal index rather than a loop: GLSL ES 1.00 will not index a uniform array
 * of structs with a running variable, and the light count is 2 (sun + moon).
 *
 * owBackLit  = beam landing on the face we are NOT looking at.
 * owFwd      = forward-scatter lobe, brightest looking nearly along the beam.
 */
#define OW_CLOTH_LIGHT( IDX ) { \
  IncidentLight owCl; \
  getDirectionalLightInfo( directionalLights[ IDX ], owCl ); \
  float owBackLit = max( 0.0, -dot( normal, owCl.direction ) ); \
  float owFwd = max( 0.0, dot( geometryViewDir, -owCl.direction ) ); \
  owTrans += owCl.color * ( owBackLit * ( 0.30 + 0.90 * owFwd * owFwd ) ); \
}

// filled by the surface evaluation, consumed by the chunk overrides below
vec4  owAlbedo;
vec3  owORM;          // ao, rough, metal
vec3  owNormalV;      // view-space shading normal
float owHeightS;
/** The 2D surface parameterisation the projection block settled on. */
vec2  owSurfUv;
/** Resolved wetness for the lighting hooks: x = film, y = standing water. */
vec2  owWetOut = vec2( 0.0 );
/** Clearcoat normal tilt (orange peel), view space xy. */
vec2  owClearTilt = vec2( 0.0 );
/** Automotive glass opacity after the Fresnel roll-off. */
float owGlassA = 1.0;

/**
 * Rotate the micro/meso lookup.
 *
 * Two surfaces sharing a detail set at the same mapping otherwise show the
 * IDENTICAL grain field — which is precisely how a critic was able to match a
 * road, a shirt and a rusted pipe "blob for blob at 5x". A per-surface rotation
 * costs one mat2 and makes the correlation unfindable. owDetRotInv counter-
 * rotates the sampled tangent normal so the relief still points the way the
 * height field says it does.
 */
vec2 owDetUv( vec2 q ){
  return vec2( q.x * owDetRot.x - q.y * owDetRot.y, q.x * owDetRot.y + q.y * owDetRot.x );
}
vec2 owDetRotInv( vec2 v ){
  return vec2( v.x * owDetRot.x + v.y * owDetRot.y, -v.x * owDetRot.y + v.y * owDetRot.x );
}

float owHash11( float x ){
  float p = fract( x * 0.1031 );
  p *= p + 33.33;
  p *= p + p;
  return fract( p );
}

vec3 owHash32f( vec2 p ){
  vec3 p3 = fract( vec3( p.xyx ) * vec3( 0.1031, 0.1030, 0.0973 ) );
  p3 += dot( p3, p3.yxz + 33.33 );
  return fract( ( p3.xxy + p3.yzz ) * p3.zyx );
}

#ifdef OW_WETNESS
uniform vec4 owWetP;     // x wetness, y puddle world scale, z rain, w clock
uniform vec4 owWetQ;     // x reserved, y wind, z drying, w reserved
uniform vec4 owWetSurf;  // x susceptibility, y porosity, z pooling, w sheen

/**
 * Rain rings on standing water.
 *
 * Two staggered lattices so the drops do not land on a visible grid. Each cell
 * holds one drop whose ring expands and dies over its own phase; the returned
 * xy is the slope of the ring, which is added to the shading normal. Falling
 * rain is what tells you a puddle is a puddle and not a glossy decal.
 */
vec2 owRainRipple( vec2 wp, float t ){
  vec2 acc = vec2( 0.0 );
  for ( int i = 0; i < 2; i ++ ){
    // 8-16 cm rings. A raindrop ring is a hand's width across, not a metre:
    // at the old 40 cm the puddles read as a pond with carp in it.
    float s = i == 0 ? 9.0 : 15.5;
    vec2 p = wp * s + float( i ) * 13.7;
    vec2 ci = floor( p );
    vec2 cf = fract( p ) - 0.5;
    vec3 h = owHash32f( ci + float( i ) * 31.0 );
    // stagger the drop inside its cell, and give it its own phase offset
    cf -= ( h.xy - 0.5 ) * 0.72;
    float phase = fract( t * ( 2.1 + h.z * 0.9 ) + h.x );
    float d = length( cf );
    float r = phase * 0.55;
    float band = d - r;
    float ring = sin( band * 62.0 ) * exp( -abs( band ) * 21.0 ) * ( 1.0 - phase ) * ( 1.0 - phase );
    acc += ( cf / max( d, 1e-3 ) ) * ring;
  }
  return acc * 0.5;
}
#endif

#ifdef OW_CARPAINT
uniform vec4 owCarP;     // x flake amount, y flake scale, z peel scale, w peel amount
uniform vec4 owCarFlop;  // xyz flop tint, w flop amount
#endif

#ifdef OW_AUTOGLASS
uniform vec4 owGlassP;   // x thickness m, y base opacity, z edge boost, w unused
uniform vec3 owGlassAbs; // per-metre absorption; the green edge lives here
#endif

#ifdef OW_GRIME
uniform vec4 owGrimeP;   // x amount, y world-height falloff m, z cavity bias, w up bias
#endif

/**
 * Runoff staining below a source.
 *
 * Real rain streaks start at something — a sill, a broken gutter, a slab edge —
 * and die out a metre or so below it. sAxis is the horizontal coordinate along
 * the wall, y the world height. Returns .x = 0..1: fades in over the first 15 cm
 * below the source and out over the next 1.5 m, in discrete columns, so a wall
 * gets a handful of dark runs rather than a uniform vertical grain.
 * .y carries the per-column random used to pick rusted fixings.
 */
vec3 owRunoff( float sAxis, float y, float wobble ){
  float u = sAxis * 1.55;
  float cell = floor( u );                            // ~65 cm source columns
  float lat = fract( u );
  float r0 = owHash11( cell * 1.37 + 3.1 );
  float r1 = owHash11( cell * 2.71 + 11.7 );
  // Only some columns have anything dripping down them.
  float srcAmt = smoothstep( 0.30, 0.62, r0 ) * ( 0.55 + 0.45 * r1 );
  // Feathered across the column, so a run has soft sides instead of cell walls.
  float bell = sin( lat * 3.14159265 );
  srcAmt *= bell * bell * ( 0.8 + 0.45 * r0 );
  // Sources sit roughly one storey apart, jittered per column.
  const float SPACING = 2.85;
  float jitter = r1 * 1.2 + r0 * 0.5;
  float srcY = ( floor( ( y + jitter ) / SPACING ) + 1.0 ) * SPACING - jitter + wobble * 0.2;
  float below = srcY - y;
  float run = smoothstep( 0.0, 0.15, below ) * ( 1.0 - smoothstep( 0.15, 1.65, below ) );
  return vec3( clamp( run * srcAmt, 0.0, 1.0 ), r1, below );
}

mat3 owTangentFrame( vec3 eye, vec3 n, vec2 uv ){
  vec3 q0 = dFdx( eye ), q1 = dFdy( eye );
  vec2 s0 = dFdx( uv ), s1 = dFdy( uv );
  vec3 q1p = cross( q1, n );
  vec3 q0p = cross( n, q0 );
  vec3 T = q1p * s0.x + q0p * s1.x;
  vec3 B = q1p * s0.y + q0p * s1.y;
  float det = max( dot( T, T ), dot( B, B ) );
  float sc = ( det == 0.0 ) ? 0.0 : inversesqrt( det );
  return mat3( T * sc, B * sc, n );
}

struct OwFrame { vec2 uv; vec3 T; vec3 B; vec3 N; };

OwFrame owAxisFrame( vec3 p, vec3 n, int axis ){
  vec3 s = mix( vec3( -1.0 ), vec3( 1.0 ), step( 0.0, n ) );
  OwFrame f;
  if ( axis == 0 ){
    f.uv = vec2( -p.z * s.x, p.y );
    f.T = vec3( 0.0, 0.0, -s.x ); f.B = vec3( 0.0, 1.0, 0.0 ); f.N = vec3( s.x, 0.0, 0.0 );
  } else if ( axis == 1 ){
    f.uv = vec2( p.x, -p.z * s.y );
    f.T = vec3( 1.0, 0.0, 0.0 ); f.B = vec3( 0.0, 0.0, -s.y ); f.N = vec3( 0.0, s.y, 0.0 );
  } else {
    f.uv = vec2( p.x * s.z, p.y );
    f.T = vec3( s.z, 0.0, 0.0 ); f.B = vec3( 0.0, 1.0, 0.0 ); f.N = vec3( 0.0, 0.0, s.z );
  }
  f.uv = f.uv * owTile.xy + owTile.zw;
  return f;
}

/** Re-anchor an axis frame onto the true interpolated normal. */
void owOrthonormalise( inout OwFrame f, vec3 n ){
  f.N = n;
  f.T = normalize( f.T - n * dot( n, f.T ) );
  f.B = cross( n, f.T );
}

/**
 * Parallax occlusion mapping. Marches the height field stored in albedo.a
 * and returns the displaced uv. Layer count follows the grazing angle and
 * the whole effect fades out with distance.
 */
vec2 owPOM( vec2 uv, vec3 vt, vec2 ddx, vec2 ddy, float depth, float fade ){
  if ( depth <= 0.0 || fade <= 0.001 ) return uv;
  float nl = mix( owParallaxP.w, 8.0, clamp( abs( vt.z ), 0.0, 1.0 ) );
  nl = max( nl * fade, 4.0 );
  float layer = 1.0 / nl;
  vec2 P = ( vt.xy / max( abs( vt.z ), 0.30 ) ) * depth * fade;
  vec2 dUv = P * layer;

  float cur = 0.0;
  vec2 c = uv;
  float d = 1.0 - OW_TEX( map, c, ddx, ddy ).a;
  for ( int i = 0; i < 48; i ++ ){
    if ( cur >= d || float( i ) >= nl ) break;
    c -= dUv;
    d = 1.0 - OW_TEX( map, c, ddx, ddy ).a;
    cur += layer;
  }
  vec2 prev = c + dUv;
  float after = d - cur;
  float before = ( 1.0 - OW_TEX( map, prev, ddx, ddy ).a ) - cur + layer;
  float w = clamp( after / max( after - before, 1e-4 ), 0.0, 1.0 );
  return mix( c, prev, w );
}

/** Height-preserving blend of two texture samples (kills the mushy 50% lerp). */
void owHeightBlend( inout vec4 a, inout vec3 ormA, inout vec3 nA,
                    vec4 b, vec3 ormB, vec3 nB, float t ){
  float wa = ( 1.0 - t ) + a.a * 0.6;
  float wb = t + b.a * 0.6;
  float k = max( wa, wb ) - 0.18;
  wa = max( wa - k, 0.0 );
  wb = max( wb - k, 0.0 );
  float inv = 1.0 / max( wa + wb, 1e-4 );
  a = ( a * wa + b * wb ) * inv;
  ormA = ( ormA * wa + ormB * wb ) * inv;
  nA = normalize( ( nA * wa + nB * wb ) * inv );
}
`;

const MAIN_FRAGMENT = /* glsl */ `
{
  float owDist = length( vViewPosition );
  float owFaceDir = gl_FrontFacing ? 1.0 : -1.0;
  vec3 owNw = normalize( vOwWNrm ) * owFaceDir;

  #ifdef OW_OBJECT_SPACE
    vec3 owP = vOwOPos;
    vec3 owNp = normalize( vOwONrm ) * owFaceDir;
    mat3 owP2V = vOwP2V;
  #else
    vec3 owP = vOwWPos;
    vec3 owNp = owNw;
    mat3 owP2V = mat3( viewMatrix );
  #endif

  vec4 alb; vec3 orm; vec3 nT; vec3 nShade;
  // Micro (sub-millimetre) height from the shared detail set, -1..1. This is the
  // aggregate / plaster-tooth / grit read at 0.5 m; it fades out with distance so
  // the near ground gains detail instead of shimmering.
  float owMicro = 0.0;
  float owDetFade = 0.0;

  #ifdef OW_TRIPLANAR

    vec3 an = abs( owNp );
    vec3 w = pow( an, vec3( 5.0 ) );
    w /= max( w.x + w.y + w.z, 1e-4 );

    OwFrame fx = owAxisFrame( owP, owNp, 0 );
    OwFrame fy = owAxisFrame( owP, owNp, 1 );
    OwFrame fz = owAxisFrame( owP, owNp, 2 );

    vec4 ax = texture2D( map, fx.uv );
    vec4 ay = texture2D( map, fy.uv );
    vec4 az = texture2D( map, fz.uv );
    alb = ax * w.x + ay * w.y + az * w.z;

    vec3 ox = texture2D( roughnessMap, fx.uv ).rgb;
    vec3 oy = texture2D( roughnessMap, fy.uv ).rgb;
    vec3 oz = texture2D( roughnessMap, fz.uv ).rgb;
    orm = ox * w.x + oy * w.y + oz * w.z;

    vec3 nx = texture2D( normalMap, fx.uv ).xyz * 2.0 - 1.0;
    vec3 ny = texture2D( normalMap, fy.uv ).xyz * 2.0 - 1.0;
    vec3 nz = texture2D( normalMap, fz.uv ).xyz * 2.0 - 1.0;
    nx.xy *= owNormalAmp; ny.xy *= owNormalAmp; nz.xy *= owNormalAmp;
    vec3 wnx = fx.T * nx.x + fx.B * nx.y + fx.N * nx.z;
    vec3 wny = fy.T * ny.x + fy.B * ny.y + fy.N * ny.z;
    vec3 wnz = fz.T * nz.x + fz.B * nz.y + fz.N * nz.z;
    vec3 nP = normalize( wnx * w.x + wny * w.y + wnz * w.z );

    // detail, projected on the dominant plane only (one extra fetch)
    OwFrame fd = fz;
    if ( an.y > max( an.x, an.z ) ) fd = fy;
    else if ( an.x > an.z ) fd = fx;
    vec2 detUv = owDetUv( fd.uv * owDetailP.x );
    float detFade = 1.0 - smoothstep( owDetailP.w * 0.45, owDetailP.w, owDist );
    owDetFade = detFade;
    vec3 dn = texture2D( owDetailNrm, detUv ).xyz * 2.0 - 1.0;
    dn.xy = owDetRotInv( dn.xy );
    vec3 dW = fd.T * dn.x + fd.B * dn.y + fd.N * dn.z;
    nP = normalize( nP + ( dW - fd.N * dot( dW, fd.N ) ) * owDetailP.y * detFade );
    vec4 dTex = texture2D( owDetailTex, detUv );
    owMicro = ( dTex.a - 0.5 ) * 2.0;
    alb.rgb *= 1.0 + ( owMicro * 0.95 + ( dTex.r - 0.5 ) * 1.25 ) * owDetailP.z * detFade;
    orm.r *= 1.0 - max( -owMicro, 0.0 ) * 0.30 * owDetailP.z * detFade;

    #ifdef OW_MESO
    {
      vec2 mUv2 = detUv * owMesoP.x;
      vec3 mn = texture2D( owDetailNrm, mUv2 ).xyz * 2.0 - 1.0;
      mn.xy = owDetRotInv( mn.xy );
      vec3 mW = fd.T * mn.x + fd.B * mn.y + fd.N * mn.z;
      nP = normalize( nP + ( mW - fd.N * dot( mW, fd.N ) ) * owMesoP.y );
      vec4 mT = texture2D( owDetailTex, mUv2 );
      float mh = ( mT.a - 0.5 ) * 2.0;
      alb.rgb *= 1.0 + ( mh * 0.9 + ( mT.r - 0.5 ) * 1.1 ) * owMesoP.z;
      orm.g = clamp( orm.g - mh * owMesoP.w, 0.0, 1.0 );
    }
    #endif

    nShade = normalize( owP2V * nP );
    owHeightS = clamp( alb.a + owMicro * 0.16 * detFade, 0.0, 1.0 );
    owSurfUv = fd.uv;

  #else

    #ifdef OW_MESH_UV
      vec2 baseUv = vMapUv * owTile.xy + owTile.zw;
      mat3 tbnV = owTangentFrame( -vViewPosition, normalize( vNormal ) * owFaceDir, baseUv );
      OwFrame f;
      f.uv = baseUv;
      f.T = tbnV[ 0 ]; f.B = tbnV[ 1 ]; f.N = tbnV[ 2 ];
    #else
      int axis = ( abs( owNp.x ) > abs( owNp.y ) )
        ? ( ( abs( owNp.x ) > abs( owNp.z ) ) ? 0 : 2 )
        : ( ( abs( owNp.y ) > abs( owNp.z ) ) ? 1 : 2 );
      OwFrame f = owAxisFrame( owP, owNp, axis );
      owOrthonormalise( f, owNp );
    #endif

    vec2 ddx = dFdx( f.uv );
    vec2 ddy = dFdy( f.uv );
    vec2 uv = f.uv;

    #ifdef OW_PARALLAX
      #ifdef OW_MESH_UV
        vec3 Vp = normalize( vViewPosition );
      #else
        vec3 Vp = normalize( vOwViewDirP );
      #endif
      vec3 vt = normalize( vec3( dot( Vp, f.T ), dot( Vp, f.B ), dot( Vp, f.N ) ) );
      float pFade = 1.0 - smoothstep( owParallaxP.y, owParallaxP.z, owDist );
      uv = owPOM( uv, vt, ddx, ddy, owParallaxP.x, pFade );
    #endif

    alb = OW_TEX( map, uv, ddx, ddy );
    orm = OW_TEX( roughnessMap, uv, ddx, ddy ).rgb;
    nT = OW_TEX( normalMap, uv, ddx, ddy ).xyz * 2.0 - 1.0;
    nT.xy *= owNormalAmp;

    #ifdef OW_DETILE
      // Second sample of the same texture, rotated and rescaled, blended by a
      // low-frequency mask: breaks the repeat without a second texture set.
      #ifdef OW_DETILE_LANE
        /**
         * LANE-ALIGNED DE-TILING.
         *
         * A carriageway cannot take the rotated de-tile above: rotating the
         * second sample drags the wheel-polish bands, the paver's cold joint
         * and the oil line off the lane and smears them diagonally across the
         * road. But leaving de-tiling off entirely is what put a visible 4 m
         * lattice of identical potholes down every street in the city.
         *
         * So mirror and rescale along v ONLY. u is untouched, so every
         * across-the-road feature lands in exactly the same place in both
         * samples and survives the blend at full contrast, while everything
         * that is a function of v as well — potholes, utility cuts, tar
         * snakes, thermal cracks — gets a second lattice at 0.83 of the period,
         * running the other way. The two beat against each other over ~24 m
         * instead of repeating every 4 m.
         */
        /**
         * The phase of the second sample WANDERS along the road, on a ~90 m
         * period taken from the world macro band. Two fixed samples would just
         * interleave two lattices and half the carriageway would still repeat
         * on 4 m; letting the offset drift means no two stretches of street get
         * the same pair. The drift is far slower than any texel footprint, so
         * the gradients below are still correct to well under a mip level.
         */
        float owLanePhase = texture2D( owMacroTex, vOwWPos.xz * 0.011 ).r * 7.0;
        vec2 uv2 = vec2( uv.x, -uv.y * 0.83 + owLanePhase );
        vec2 ddx2 = vec2( ddx.x, -ddx.y * 0.83 );
        vec2 ddy2 = vec2( ddy.x, -ddy.y * 0.83 );
      #else
      vec2 uv2 = vec2( uv.x * 0.803 - uv.y * 0.596, uv.x * 0.596 + uv.y * 0.803 ) * 0.617
               + vec2( 0.37, 0.71 );
      vec2 ddx2 = vec2( ddx.x * 0.803 - ddx.y * 0.596, ddx.x * 0.596 + ddx.y * 0.803 ) * 0.617;
      vec2 ddy2 = vec2( ddy.x * 0.803 - ddy.y * 0.596, ddy.x * 0.596 + ddy.y * 0.803 ) * 0.617;
      #endif
      vec4 alb2 = OW_TEX( map, uv2, ddx2, ddy2 );
      vec3 orm2 = OW_TEX( roughnessMap, uv2, ddx2, ddy2 ).rgb;
      vec3 n2 = OW_TEX( normalMap, uv2, ddx2, ddy2 ).xyz * 2.0 - 1.0;
      n2.xy *= owNormalAmp;
    #endif

    // ---- micro detail normal, faded by distance ----
    float detFade = 1.0 - smoothstep( owDetailP.w * 0.45, owDetailP.w, owDist );
    owDetFade = detFade;
    vec2 dUvB = owDetUv( uv * owDetailP.x );
    vec2 dDxB = owDetUv( ddx * owDetailP.x );
    vec2 dDyB = owDetUv( ddy * owDetailP.x );
    vec3 dn = OW_TEX( owDetailNrm, dUvB, dDxB, dDyB ).xyz * 2.0 - 1.0;
    dn.xy = owDetRotInv( dn.xy );
    nT = normalize( vec3( nT.xy + dn.xy * owDetailP.y * detFade, nT.z ) );
    #ifdef OW_DETILE
      n2 = normalize( vec3( n2.xy + dn.xy * owDetailP.y * detFade, n2.z ) );
      /**
       * The blend mask used to run at owMacroP.x * 5, which on a carriageway is
       * a ~3.6 m period — near enough to the 4 m texture tile that the mask
       * itself repeated with the thing it was supposed to be hiding. At 1.7 it
       * is a ~10 m patchwork, incommensurate with every tile size in the
       * library, and the extra contrast keeps it near 0 or 1 rather than
       * sitting at a permanent 50% cross-fade (which halves the contrast of
       * both samples and is what makes bad de-tiling look like mud).
       */
      float dtm = clamp( ( texture2D( owMacroTex, ( owP.xz + owP.y * 0.7 ) * owMacroP.x * 1.7 + 0.21 ).g - 0.42 ) * 3.4, 0.0, 1.0 );
      owHeightBlend( alb, orm, nT, alb2, orm2, n2, dtm * owRoughP.z );
    #endif
    // Sub-millimetre aggregate / tooth / grit: the height channel of the shared
    // micro set drives an albedo speckle *and* the cavity height, so the layer
    // shades instead of just tinting.
    vec4 dTex = OW_TEX( owDetailTex, dUvB, dDxB, dDyB );
    owMicro = ( dTex.a - 0.5 ) * 2.0;
    alb.rgb *= 1.0 + ( owMicro * 0.95 + ( dTex.r - 0.5 ) * 1.25 ) * owDetailP.z * detFade;
    // Aggregate reads dark in its troughs even in full sun, because a trough
    // is a tiny occluded pocket. Modulating only the albedo gives a washed
    // pattern; darkening the cavity as well is what makes it read as depth.
    orm.r *= 1.0 - max( -owMicro, 0.0 ) * 0.30 * owDetailP.z * detFade;

    /**
     * ---- THE MESO BAND: 5-40 cm -----------------------------------------
     *
     * MEASURED PROBLEM. Contrast-stretch a sunlit facade at 5 m and it is full
     * of trowel tooth, pores and aggregate. Do it at 15 m — where most of a
     * city frame actually lives — and there is nothing: a 2.2 m tile over 1024
     * texels is 2.1 mm a texel, so by 15 m the surface is being sampled two mip
     * levels down and everything under a centimetre has been averaged away,
     * while the macro layer only varies over 4-12 m and only modulates COLOUR.
     * Between them the surface has a hole in its frequency budget exactly where
     * the eye is looking, which is why an adversarial critic called an
     * otherwise fully-featured pipeline "tinted geometry".
     *
     * The fix costs two fetches: sample the SAME shared detail set at a ~5 m
     * tiling, where its 1.6 mm grain becomes a 3 cm mottle and its 10 mm swell
     * becomes a 20 cm undulation. That band is far too coarse to alias, so it
     * takes no distance fade at all and is still there at 60 m — which is what
     * gives a wall shape under a raking sun instead of a smooth luminance ramp.
     */
    #ifdef OW_MESO
    {
      vec2 mUv2 = dUvB * owMesoP.x;
      vec2 mdx = dDxB * owMesoP.x;
      vec2 mdy = dDyB * owMesoP.x;
      vec3 mn = OW_TEX( owDetailNrm, mUv2, mdx, mdy ).xyz * 2.0 - 1.0;
      mn.xy = owDetRotInv( mn.xy );
      nT = normalize( vec3( nT.xy + mn.xy * owMesoP.y, nT.z ) );
      vec4 mT = OW_TEX( owDetailTex, mUv2, mdx, mdy );
      float mh = ( mT.a - 0.5 ) * 2.0;
      alb.rgb *= 1.0 + ( mh * 0.9 + ( mT.r - 0.5 ) * 1.1 ) * owMesoP.z;
      // A hollow holds damp and dirt, so it is rougher than a proud area.
      orm.g = clamp( orm.g - mh * owMesoP.w, 0.0, 1.0 );
      orm.r *= 1.0 - max( -mh, 0.0 ) * 0.22 * owMesoP.z;
    }
    #endif

    owHeightS = clamp( alb.a + owMicro * 0.16 * detFade, 0.0, 1.0 );
    owSurfUv = uv;
    #ifdef OW_MESH_UV
      nShade = normalize( f.T * nT.x + f.B * nT.y + f.N * nT.z );
    #else
      nShade = normalize( owP2V * ( f.T * nT.x + f.B * nT.y + f.N * nT.z ) );
    #endif

  #endif

  // ------------------------------------------------ macro variation ----
  vec2 macroUv = mix( vec2( vOwWPos.x + vOwWPos.z * 0.63, vOwWPos.y ), vOwWPos.xz,
                      step( 0.62, abs( owNw.y ) ) );
  float owUpFace = step( 0.62, abs( owNw.y ) );
  vec4 mac1 = texture2D( owMacroTex, macroUv * owMacroP.x );
  vec4 mac2 = texture2D( owMacroTex, macroUv * owMacroP.x * 0.211 + 0.37 );
  // fbm never spans 0..1, so averaging two bands collapses toward 0.5 and the
  // "anti-tiling" multiply becomes a 5% wash. owMacroBig.x expands the contrast
  // back out before it is used, which is what lets a 12 m facade break up.
  float macro = clamp( ( mac1.r * 0.55 + mac2.b * 0.45 - 0.5 ) * owMacroBig.x + 0.5, 0.0, 1.0 );
  alb.rgb *= mix( 1.0, 0.55 + 0.92 * macro, owMacroP.y );
  // A second, much larger band (8-16 m features): the difference between one
  // sun-bleached end of a facade and the damp end, which is the signal that
  // survives at 40 m when everything finer has mipped away.
  if ( owMacroBig.y > 0.0 ) {
    vec2 bigUv = macroUv * owMacroBig.z;
    float big = texture2D( owMacroTex, bigUv ).r * 0.62
              + texture2D( owMacroTex, bigUv * 0.37 + 0.61 ).b * 0.38;
    big = clamp( ( big - 0.5 ) * 2.3, -1.0, 1.0 );
    alb.rgb *= 1.0 + big * owMacroBig.y;
    orm.g = clamp( orm.g - big * owMacroBig.y * 0.55, 0.0, 1.0 );
  }
  alb.rgb *= mix( vec3( 1.0 ), vec3( 1.05, 1.0, 0.93 ), ( mac2.r - 0.5 ) * owMacroP.w );
  // Roughness has to vary or nothing in the frame ever glints: a broad patch
  // term plus a tighter one, both signed, plus the micro tooth.
  orm.g = clamp( orm.g + ( mac1.g - 0.5 ) * owMacroP.z
                       + ( mac1.a - 0.5 ) * 0.16
                       - owMicro * 0.07 * owDetFade, 0.0, 1.0 );

  #ifdef OW_MACRO_RELIEF
    /**
     * Ruts, drifts, bellied render and bowed panels at 1-4 m. The tile cannot
     * carry anything this large, so the shading normal is tilted by the
     * gradient of the macro map.
     *
     * THIS USED TO BE GATED TO UP-FACING SURFACES ONLY ('* owUpFace'), which
     * meant a twelve-metre facade got no normal perturbation at any scale
     * between its 2 mm tooth and its 8 m colour wash. Under the hard low sun
     * this game is built around, that is precisely the condition in which a
     * wall resolves to a smooth luminance ramp and nothing else — the "couple
     * of soft smears" an adversarial critic measured on a sunlit stucco
     * elevation. A real wall is never plane: the render bellies between its
     * fixings, the brick courses wander out of plumb, a precast panel bows in
     * the sun. So the tilt now applies on verticals too, in the wall's own
     * tangent frame rather than in world XZ.
     */
    vec2 mUv = macroUv * owMacroP.x;
    float mhx = texture2D( owMacroTex, mUv + vec2( 0.035, 0.0 ) ).b;
    float mhy = texture2D( owMacroTex, mUv + vec2( 0.0, 0.035 ) ).b;
    vec2 mg = ( vec2( mhx, mhy ) - mac1.b ) * owMacroRelief;
    // Up-facing: macroUv is world XZ, so the gradient maps straight to a tilt.
    vec3 tiltUp = vec3( -mg.x, 0.0, -mg.y );
    // Vertical: macroUv is (along-wall, height). Build the wall's own frame so
    // the undulation runs across the elevation rather than along world X.
    vec3 wUp = vec3( 0.0, 1.0, 0.0 );
    vec3 wT = cross( wUp, owNw );
    float wl = length( wT );
    wT = wl > 1e-4 ? wT / wl : vec3( 1.0, 0.0, 0.0 );
    vec3 wB = cross( owNw, wT );
    vec3 tiltSide = ( -mg.x ) * wT + ( -mg.y ) * wB;
    vec3 tiltW = mix( tiltSide, tiltUp, owUpFace );
    tiltW -= owNw * dot( owNw, tiltW );
    nShade = normalize( nShade + mat3( viewMatrix ) * tiltW );
    // The hollows are damper and dirtier than the proud areas on a wall, and
    // shallower-lit on the ground: either way the value tracks the height.
    alb.rgb *= 1.0 - ( mac1.b - 0.5 ) * mix( 0.10, 0.16, owUpFace );
  #endif

  // Horizontal coordinate along a wall, shared by the patch and runoff layers.
  float owVert = smoothstep( 0.72, 0.34, abs( owNw.y ) );
  float owSAxis = vOwWPos.z * owNw.x - vOwWPos.x * owNw.z;

  // ------------------------------------------------- repair patches ----
  #ifdef OW_PATCH
  {
    // Somebody has replastered part of this wall. A repair is a RECTANGLE in the
    // plane of the facade, a few percent off the surrounding mix in value, a
    // little smoother because it is newer, and it has a trowel edge — a small
    // raised ridge where the new render was feathered out. Covering ~10% of each
    // facade with these is what stops a 12 m wall reading as one flat colour.
    float cw = max( owPatchP.y, 0.4 );
    vec2 pc = vec2( owSAxis, vOwWPos.y ) / cw;
    // wander the lattice so the cells are not a visible grid
    pc += ( vec2( mac2.r, mac2.g ) - 0.5 ) * 0.35;
    vec2 cid = floor( pc );
    vec2 cf = pc - cid;
    float r0 = owHash11( cid.x * 7.31 + cid.y * 13.77 + 5.1 );
    float r1 = owHash11( cid.x * 3.17 + cid.y * 9.41 + 21.3 );
    float r2 = owHash11( cid.x * 11.93 + cid.y * 4.73 + 37.7 );
    float r3 = owHash11( cid.x * 5.51 + cid.y * 17.29 + 53.9 );
    float has = step( 1.0 - clamp( owPatchP.x, 0.0, 1.0 ), r0 );
    vec2 lo = vec2( 0.05 + r1 * 0.30, 0.05 + r2 * 0.30 );
    vec2 hi = vec2( 0.95 - r2 * 0.26, 0.95 - r3 * 0.26 );
    float fe = 0.028 + 0.030 * r1;          // ~3-6 cm of trowel feather
    vec2 a0 = smoothstep( lo, lo + fe, cf );
    vec2 a1 = 1.0 - smoothstep( hi - fe, hi, cf );
    float pm = a0.x * a0.y * a1.x * a1.y * has * owVert;
    if ( pm > 0.001 ) {
      float sgn = r3 > 0.48 ? 1.0 : -1.0;
      alb.rgb *= 1.0 + sgn * owPatchP.z * pm;
      // A cement repair is greyer and cooler than the render around it; a patch
      // in the original mix that has weathered separately goes warmer. Value
      // alone reads as a lighting artefact — it needs the hue shift too.
      vec3 pTint = sgn > 0.0 ? vec3( 0.975, 0.988, 1.020 ) : vec3( 1.030, 1.008, 0.968 );
      alb.rgb *= mix( vec3( 1.0 ), pTint, pm );
      // a fresh coat has lost the mould and the fine crazing of the old wall
      orm.g = clamp( orm.g + owPatchP.w * pm, 0.0, 1.0 );
      // the trowel edge: a bright arris where the new render feathers out
      float lip = pm * ( 1.0 - pm ) * 4.0;
      alb.rgb *= 1.0 + lip * 0.13;
      owHeightS = clamp( owHeightS + pm * 0.07 + lip * 0.05, 0.0, 1.0 );
    }
  }
  #endif

  // ------------------------------------------------------ weathering ----
  #ifdef OW_WEATHER
    float up = clamp( owNw.y, 0.0, 1.0 );
    float dust = up * up * owWeatherP.x * smoothstep( 0.30, 0.80, mac1.b * 0.7 + mac2.g * 0.5 );
    alb.rgb = mix( alb.rgb, owDustCol, dust * 0.75 );
    orm.g = clamp( orm.g + dust * 0.30, 0.0, 1.0 );
    orm.b *= 1.0 - dust * 0.85;
    nShade = normalize( mix( nShade, normalize( owP2V * owNp ), dust * 0.35 ) );

    // ---- rain runoff -------------------------------------------------------
    // Streaks live on near-vertical faces only, below a source, and are 3-8 cm
    // wide with roughly a 3:1 vertical stretch. (A 10:1 stretch of a value-noise
    // channel over a whole wall is a wood-grain generator, not weathering.)
    float vert = owVert;
    float sAxis = owSAxis;
    float sN = texture2D( owMacroTex, vec2( sAxis * 0.46, vOwWPos.y * 0.155 ) ).a;
    float sFine = texture2D( owMacroTex, vec2( sAxis * 1.35 + 0.4, vOwWPos.y * 0.42 ) ).g;
    vec3 runoff = owRunoff( sAxis, vOwWPos.y, sN - 0.5 );
    float streak = clamp( owWeatherP.y * 2.2, 0.0, 1.15 ) * vert * runoff.x
                 * smoothstep( 0.30, 0.66, sN * 0.72 + sFine * 0.38 );
    streak = clamp( streak, 0.0, 1.0 );
    #ifdef OW_VCOL_MASKS
      // The world knows exactly where the water comes off — buildings.js places a
      // runoff strip under every sill, shopfront head and cornice with the grime
      // mask driven to ~1 at its source (see util.runoffStreak). A mask that high
      // only ever comes from something authored as a stain, so it drives the run
      // outright instead of merely modulating the procedural columns.
      float owStainM = smoothstep( 0.58, 0.98, vColor.g );
      streak = clamp( streak * ( 0.45 + 0.75 * clamp( vColor.g * 1.5 + vColor.b * 0.6, 0.0, 1.0 ) )
                    + owStainM * vert
                      * ( 0.55 + 0.45 * smoothstep( 0.20, 0.70, sN * 0.6 + sFine * 0.55 ) ),
                    0.0, 1.0 );
    #endif
    // A wet-then-dried run on render is a real 20-35% drop in albedo: at 10% it
    // is invisible from across the street, which is the whole point of a streak.
    vec3 runCol = mix( alb.rgb * 0.72, owGrimeCol, 0.26 );
    // Rust bleed under metal fixings — brackets, rebar ends, gutter straps.
    // strongest right under the fixing, thinning as it runs down
    float rust = clamp( step( 0.86, runoff.y ) * 0.9 + orm.b * 0.5, 0.0, 1.0 )
               * ( 0.30 + 0.70 * ( 1.0 - smoothstep( 0.1, 0.9, runoff.z ) ) );
    runCol = mix( runCol, mix( alb.rgb * 0.94, owRustCol, 0.5 ), rust );
    alb.rgb = mix( alb.rgb, runCol, streak );
    orm.g = clamp( orm.g + streak * 0.09, 0.0, 1.0 );
    orm.b *= 1.0 - streak * 0.35;

    // ---- ground splash ----------------------------------------------------
    // A hard dirt band in the bottom ~20 cm plus thinning splatter above it.
    float hAbove = vOwWPos.y - owGroundY;
    float band = 1.0 - smoothstep( 0.02, 0.22, hAbove );
    float spray = 1.0 - smoothstep( 0.10, max( owWeatherP.z, 1e-3 ), hAbove );
    float splash = vert * max( band, spray * spray * 0.85 ) * step( 1e-4, owWeatherP.z );
    // Broken up at 1-2 m, but with a floor so the base of every wall darkens.
    splash *= 0.55 + 0.45 * smoothstep( 0.25, 0.72, mac1.b * 0.7 + mac2.g * 0.4 );
    // Dust and rain-thrown dirt, not soot: a blend of the two weathering colours.
    vec3 splashCol = mix( owGrimeCol, owDustCol * 0.9, 0.35 );
    alb.rgb = mix( alb.rgb * ( 1.0 - splash * 0.35 ), splashCol, splash * 0.42 );
    orm.g = clamp( orm.g + splash * 0.16 - band * vert * 0.10, 0.0, 1.0 );
    orm.r *= 1.0 - splash * 0.18;
    orm.b *= 1.0 - splash * 0.7;

    // ---- dust wedge at the wall / ground junction -------------------------
    // A wall does not meet the ground on a line: wind and foot traffic pile a
    // 25-40 cm wedge of the ground's own dust against it, and the value of that
    // wedge is most of the way from the wall to the road. Without it every
    // wall/ground junction in the frame is a razor cut.
    float wedgeH = 0.26 + 0.18 * ( mac1.r * 0.6 + mac2.b * 0.7 );
    float wedge = vert * ( 1.0 - smoothstep( wedgeH * 0.25, wedgeH, hAbove ) );
    wedge *= wedge * ( 0.7 + 0.5 * smoothstep( 0.2, 0.8, mac2.g ) );
    wedge = clamp( wedge, 0.0, 1.0 ) * step( 1e-4, owWeatherP.z );
    alb.rgb = mix( alb.rgb, owDustCol, wedge * 0.46 );
    orm.g = clamp( orm.g + wedge * 0.07, 0.0, 1.0 );
    orm.b *= 1.0 - wedge * 0.9;
    // dust is loose powder: kill the sharp tile relief inside the wedge
    nShade = normalize( mix( nShade, normalize( owP2V * owNp ), wedge * 0.45 ) );
  #endif

  // ------------------------------------------- cavity + vertex masks ----
  float cav = 1.0 - owHeightS;
  alb.rgb = mix( alb.rgb, owGrimeCol, cav * cav * owWeatherP.w );
  orm.r *= 1.0 - cav * owWeatherP.w * 0.5;

  #ifdef OW_VCOL_MASKS
    // Wear is broken up by the macro noise and biased to the high points of the
    // height field, so an edge rubs through in patches rather than as a band.
    //
    // The height bias is deliberately shallow (0.55 -> 1.0, not 0 -> 1). On a
    // prop the mask is a thin band along an arris and the bias just decides
    // which grains inside that band rub through. On a large surface whose
    // height field IS its aggregate — a road, a gravel yard — a 0 -> 1 bias
    // turns the wear layer into a per-stone brightener, and since the mask is
    // painted over the whole plane every stone crown in the frame lights up.
    // That was most of the road's salt-and-pepper histogram.
    float wearN = smoothstep( 0.25, 0.85, mac1.b * 0.65 + mac2.a * 0.55 );
    float wearM = vColor.r * owWearP.x * ( 0.55 + 0.45 * smoothstep( 0.30, 0.80, owHeightS ) )
                * ( 0.25 + 1.15 * wearN );
    wearM = clamp( wearM, 0.0, 1.0 );
    alb.rgb = mix( alb.rgb, owWearCol, wearM * owWearMat.w );
    orm.g = mix( orm.g, owWearMat.x, wearM );
    orm.b = mix( orm.b, owWearMat.y, wearM );
    float grimeM = vColor.g * owWearP.y * ( 0.35 + 0.65 * cav ) * ( 0.45 + 0.9 * mac2.g );
    alb.rgb = mix( alb.rgb, owGrimeCol, grimeM * 0.8 );
    orm.g = clamp( orm.g + grimeM * 0.22, 0.0, 1.0 );
    orm.b *= 1.0 - grimeM * 0.8;
    orm.r *= 1.0 - vColor.b * owWearP.z;
  #endif

  #ifdef OW_CLOTH
    #ifdef OW_ALPHA_MASK
    /**
     * PER-CARD VARIATION for foliage.
     *
     * A canopy built from one alpha-cut texture renders every card identically,
     * which is why procedural trees read as a stamped decal repeated forty
     * times. Real leaves differ by age, by how much sun they get and by how
     * much dust is on them. Hashing the card's own world position gives each
     * one its own tint, value and gloss with no per-instance attribute and no
     * contract for 'props' to honour — it works on an InstancedMesh, on merged
     * geometry and on a single quad alike.
     */
    {
      vec3 cardId = floor( vOwWPos * 1.7 );
      vec3 lr = owHash32f( cardId.xz + cardId.y * 3.7 );
      // value and saturation spread: the difference between a sunlit outer leaf
      // and a shaded inner one is most of a stop
      alb.rgb *= 0.80 + 0.42 * lr.x;
      alb.rgb *= mix( vec3( 1.0 ), vec3( 1.10, 0.98, 0.86 ), ( lr.y - 0.4 ) * 0.55 );
      // and the waxy cuticle is not equally waxy on every leaf
      orm.g = clamp( orm.g + ( lr.z - 0.5 ) * 0.26, 0.06, 1.0 );
    }
    #endif
    // The underside of a stretched canopy is never the same value as its top: it
    // sits in its own shadow, it collects soot off the street, and the only sun
    // that reaches it comes through the weave. Matching the two values is what
    // makes fabric read as painted card with a knife edge.
    float owDown = smoothstep( 0.10, -0.70, owNw.y );
    alb.rgb *= mix( 1.0, owClothP.y, owDown );
    orm.g = clamp( orm.g + owDown * 0.05, 0.0, 1.0 );
    // 8-14 cm drape structure. The tile carries the weave and the camo blotches
    // but nothing at the scale of a fold, so the shading normal is tilted by the
    // gradient of the macro band — the cloth then catches the sun in ridges.
    if ( owClothP.z > 0.0 ) {
      vec2 fUv = vec2( vOwWPos.x + vOwWPos.z * 0.63, vOwWPos.y * 0.7 + vOwWPos.z * 0.4 ) * 3.4;
      float f0 = texture2D( owMacroTex, fUv ).b;
      float fx = texture2D( owMacroTex, fUv + vec2( 0.05, 0.0 ) ).b;
      float fy = texture2D( owMacroTex, fUv + vec2( 0.0, 0.05 ) ).b;
      vec3 tiltC = vec3( -( fx - f0 ), -( fy - f0 ), 0.0 ) * owClothP.z * 9.0;
      nShade = normalize( nShade + vec3( tiltC.x, tiltC.y, 0.0 ) );
      alb.rgb *= 1.0 - ( f0 - 0.5 ) * owClothP.z * 0.9;
    }
  #endif

  // ------------------------------------------------------------ tint ----
  alb.rgb *= owTintCol;
  // owRoughP.w is a per-surface floor: tile, glass and painted metal must stay
  // glossy enough to actually catch a highlight.
  orm.g = clamp( orm.g * owRoughP.x + owRoughP.y, max( owRoughP.w, 0.015 ), 1.0 );

  // ------------------------------------------------------ building zones ----
  #ifdef OW_ZONE
  {
    /**
     * A TERRACE IS NOT ONE WALL.
     *
     * Every variation layer above this point is CONTINUOUS — fbm, warped fbm,
     * a second fbm band — so a row of brick rowhouses gets one smooth wash
     * across all of it and reads as sixty metres of the same wallpaper. That is
     * the defect a critic reported as "brick tiles visibly at 10 m, courses
     * perfectly regular, no patched repairs, no painted-over sections, no soot
     * gradient between neighbours", and no amount of extra fbm fixes it,
     * because the thing that is missing is a DISCONTINUITY at the party wall.
     *
     * Real neighbours differ as objects, not as noise: one was repointed in a
     * paler mortar, the next has forty years of stack fall-out on it, the one
     * after that was painted cream in 1974 and is failing back to the brick.
     * So: a warped Voronoi of building-sized zones over world XZ, one draw of
     * randomness per zone, hard edges where they meet.
     *
     * It runs AFTER the tint so a zone's paint colour is its own and does not
     * come out pink on a red-brick tint, and before the grime layer so city
     * dirt still settles on top of everything.
     */
    float zcs = max( owZoneP.y, 1.0 );
    vec2 zp = vOwWPos.xz / zcs;
    // Warp the lattice: a straight chequerboard of frontages reads as a grid.
    zp += ( texture2D( owMacroTex, vOwWPos.xz * 0.017 ).rg - 0.5 ) * 0.9;
    vec2 zi = floor( zp );
    vec2 zf = zp - zi;
    vec2 zc = zi;
    float zd = 1e9;
    for ( int j = -1; j <= 1; j ++ ) {
      for ( int i = -1; i <= 1; i ++ ) {
        vec2 zo = vec2( float( i ), float( j ) );
        vec3 zh = owHash32f( zi + zo + 0.5 );
        vec2 zpt = zo + 0.15 + zh.xy * 0.70;
        vec2 zdv = zf - zpt;
        float zdd = dot( zdv, zdv );
        if ( zdd < zd ) { zd = zdd; zc = zi + zo; }
      }
    }
    vec3 z0 = owHash32f( zc * 1.37 + 4.7 );
    vec3 z1 = owHash32f( zc * 2.71 + 19.3 );
    // Verticals only: the ground is not divided into buildings.
    float zAmt = clamp( owZoneP.x, 0.0, 2.0 ) * owVert;

    // ---- the building's own colour --------------------------------------
    // Value first, because that is what carries at 40 m, then a warm/cool
    // shift, because value alone reads as a lighting artefact.
    alb.rgb *= 1.0 + ( z0.x - 0.5 ) * 0.32 * zAmt;
    alb.rgb *= mix( vec3( 1.0 ), vec3( 1.070, 0.994, 0.914 ), ( z0.y - 0.5 ) * 1.3 * zAmt );
    orm.g = clamp( orm.g + ( z0.z - 0.5 ) * 0.24 * zAmt, 0.0, 1.0 );

    // ---- soot ------------------------------------------------------------
    // This is a mill city. The elevation that faced the works is black and its
    // neighbour is not, and the line between them is the party wall. Heaviest
    // high up where the plume settled and under anything that sheltered it,
    // thinning where sixty years of rain has got at it.
    /**
     * Bimodal on purpose: MOST buildings are merely dirty and a few are black.
     *
     * Measured twice on the way down. A ramp from 0.30 sooted three quarters of
     * the city and took a red Lawrenceville elevation from (68,60,72) to
     * (33,42,61) — half its value and a flip from warm to cold. From 0.70 only
     * the top third of zones take any, the mean facade loses under a tenth of
     * its value, and what the layer buys is VARIANCE between neighbours rather
     * than a darker city.
     */
    float zSoot = smoothstep( 0.70, 0.99, z1.x ) * owZoneP.w * zAmt;
    zSoot *= 0.42 + 0.85 * smoothstep( 0.12, 0.86, mac2.g * 0.6 + mac1.r * 0.55 );
    // A wall is dirtier at the top than at eye level: rain washes the lower
    // courses and pedestrians rub them.
    zSoot *= 0.62 + 0.48 * smoothstep( 1.5, 9.0, vOwWPos.y - owGroundY );
    zSoot = clamp( zSoot, 0.0, 1.0 );
    /**
     * SOOT DARKENS BRICK; IT DOES NOT REPLACE IT.
     *
     * Mixing straight to the grime colour (a near-black 0x171512) took a red
     * Lawrenceville elevation from (68,60,72) to (33,42,61) — half the value AND
     * a flip from warm to cold, because once the red is gone the only thing left
     * on a shade face is skylight. Measured on the street shot; it read as a
     * black card, not as a dirty building. A sooted wall keeps its own hue
     * underneath: darken it and pull it toward the grime, do not overwrite it.
     */
    vec3 zSootCol = mix( alb.rgb * 0.44, owGrimeCol, 0.5 );
    alb.rgb = mix( alb.rgb, zSootCol, zSoot * 0.80 );
    orm.g = clamp( orm.g + zSoot * 0.15, 0.0, 1.0 );
    orm.b *= 1.0 - zSoot * 0.6;

    // ---- painted over ----------------------------------------------------
    // Somebody painted this one, badly, decades ago, and it is coming off.
    float zPaint = step( 1.0 - clamp( owZoneP.z, 0.0, 1.0 ), z1.y ) * clamp( zAmt, 0.0, 1.0 );
    if ( zPaint > 0.004 ) {
      // Nobody paints a whole building saturated: pull it most of the way to
      // its own luminance and keep it inside a plausible reflectance range.
      vec3 zpc = vec3( 0.30 + 0.44 * z1.z, 0.28 + 0.38 * z0.z, 0.24 + 0.34 * z0.x );
      zpc = mix( zpc, vec3( dot( zpc, vec3( 0.3333 ) ) ), 0.42 );
      // Failure: paint lets go in sheets off the arris and the wet courses.
      float zFail = smoothstep( 0.60, 0.92, mac1.b * 0.6 + mac2.a * 0.6 );
      float zCov = zPaint * ( 1.0 - zFail * 0.9 );
      alb.rgb = mix( alb.rgb, zpc, zCov * 0.88 );
      // A coat of paint bridges the mortar joints, so it is both smoother and
      // flatter than the masonry under it.
      orm.g = mix( orm.g, 0.58 + 0.22 * z1.z, zCov * 0.75 );
      orm.b *= 1.0 - zCov * 0.85;
      owHeightS = clamp( owHeightS + zCov * 0.06, 0.0, 1.0 );
      nShade = normalize( mix( nShade, normalize( owP2V * owNp ), zCov * 0.30 ) );
    }
  }
  #endif

  // ------------------------------------------------ grime accumulation ----
  #ifdef OW_GRIME
  {
    // City dirt is not uniform. It settles out of the air onto anything facing
    // up, it washes down and collects in every cavity, and it is thrown onto
    // the first metre above the road by tyres — so it is a function of world
    // HEIGHT and of the height field's CAVITY, never a flat multiply.
    float gHigh = 1.0 - smoothstep( 0.0, max( owGrimeP.y, 0.05 ), vOwWPos.y - owGroundY );
    float gUp = clamp( owNw.y, 0.0, 1.0 );
    float gCav = 1.0 - owHeightS;
    float gAmt = owGrimeP.x * clamp(
      gHigh * 0.55 + gCav * gCav * owGrimeP.z + gUp * gUp * owGrimeP.w, 0.0, 1.0 );
    // broken up at 0.5-2 m so it is deposited dirt, not a gradient
    gAmt *= 0.45 + 0.85 * smoothstep( 0.22, 0.78, mac1.b * 0.6 + mac2.g * 0.6 );
    gAmt = clamp( gAmt, 0.0, 1.0 );
    alb.rgb = mix( alb.rgb, owGrimeCol, gAmt * 0.72 );
    orm.g = clamp( orm.g + gAmt * 0.30, 0.0, 1.0 );
    orm.b *= 1.0 - gAmt * 0.85;
    orm.r *= 1.0 - gAmt * 0.18;
  }
  #endif

  // -------------------------------------------------------- car paint ----
  #ifdef OW_CARPAINT
  {
    float ndv = clamp( dot( normalize( vViewPosition ), nShade ), 0.0, 1.0 );

    // ---- metallic flake ------------------------------------------------
    // Aluminium flakes, 15-40 um, suspended at random tilts in the base coat
    // under the clearcoat. Head-on in flat light they do nothing; the instant a
    // specular highlight sweeps across the panel they light up individually.
    // That glitter is the strongest single cue that a car is PAINTED and not
    // vertex-coloured plastic, and it is also the easiest thing in the frame to
    // alias, so it fades out hard with distance.
    float fFade = ( 1.0 - smoothstep( 2.5, 9.0, owDist ) ) * owCarP.x;
    if ( fFade > 0.004 ) {
      vec2 fp = owSurfUv * owCarP.y;
      vec2 fi = floor( fp );
      vec2 ff = fract( fp ) - 0.5;
      vec3 h0 = owHash32f( fi );
      // Only about half the cells carry a flake near enough to the surface to
      // catch anything; the rest are clear binder.
      float has = step( 0.42, h0.z );
      // a rounded flake, so its normal is not a hard-edged square
      float shape = smoothstep( 0.48, 0.16, length( ff ) ) * has;
      vec2 tilt = ( h0.xy - 0.5 ) * 2.0 * shape;
      nShade = normalize( nShade + vec3( tilt * 0.34 * fFade, 0.0 ) );
      /**
       * METALNESS IS 0 OR 1, INCLUDING HERE.
       *
       * Metallic paint is usually faked with a base metalness around 0.6-0.9,
       * which is a physically meaningless value: a material is either a
       * conductor or it is not. It is a TWO-PHASE material — bare aluminium
       * flakes suspended in a dielectric binder — so each flake goes to 1 and
       * the binder stays at 0. Past the point where a flake is smaller than a
       * pixel the right answer is the AREA AVERAGE of that binary field, which
       * is exactly what a mipmap would produce, so the distance fade lands on
       * the flake coverage fraction rather than on zero. Nothing is ever
       * authored at an intermediate value.
       */
      float flakeCover = 0.42;                        // area fraction of flake
      orm.b = clamp( mix( flakeCover * owCarP.x, shape, fFade ), 0.0, 1.0 );
      orm.g = clamp( orm.g - shape * 0.16 * fFade, 0.012, 1.0 );
      alb.rgb *= 1.0 + shape * 0.22 * fFade;
    }

    // ---- flop ----------------------------------------------------------
    // Metallic paint changes colour with angle: the face-on "head" colour is
    // brighter and the grazing "flop" is darker and more saturated, because the
    // flakes are lying flat and you are seeing through more pigment.
    float flop = pow( 1.0 - ndv, 2.4 ) * owCarFlop.w;
    alb.rgb = mix( alb.rgb, alb.rgb * owCarFlop.rgb, flop );

    // ---- orange peel in the clearcoat ----------------------------------
    // Sprayed clear never levels flat: it sets with a 2-5 mm dimple field. A
    // reflected lamp wobbles as you walk past a real car; on a perfect clearcoat
    // it slides like a decal.
    vec2 op = owSurfUv * owCarP.z;
    float o0 = texture2D( owMacroTex, op ).b;
    float ox = texture2D( owMacroTex, op + vec2( 0.045, 0.0 ) ).b;
    float oy = texture2D( owMacroTex, op + vec2( 0.0, 0.045 ) ).b;
    float peelFade = 1.0 - smoothstep( 8.0, 24.0, owDist );
    owClearTilt = vec2( o0 - ox, o0 - oy ) * owCarP.w * peelFade;
  }
  #endif

  // ------------------------------------------------- automotive glass ----
  #ifdef OW_AUTOGLASS
  {
    // Float glass is green because of the iron in it, and the green only shows
    // where you look through the THICKNESS — the exposed edge of a windscreen,
    // and any grazing view through the pane. Beer-Lambert over a path length of
    // thickness/cos(theta) gives both for free.
    float ndv = clamp( dot( normalize( vViewPosition ), nShade ), 0.045, 1.0 );
    float path = owGlassP.x / ndv;
    alb.rgb *= exp( -owGlassAbs * path );
    // Fresnel roll-off: a tinted side window is see-through head-on and an
    // opaque mirror at 15 degrees.
    float fres = pow( 1.0 - ndv, 4.2 );
    owGlassA = clamp( mix( owGlassP.y, 1.0, fres * owGlassP.z ), 0.0, 1.0 );
  }
  #endif

  // ---------------------------------------------------------- wetness ----
  #ifdef OW_WETNESS
  {
    float wet = clamp( owWetP.x * owWetSurf.x, 0.0, 1.0 );
    if ( wet > 0.002 ) {
      float upF = clamp( owNw.y, 0.0, 1.0 );
      // Vertical faces shed, but they still soak: rain arrives at an angle and
      // a brick wall in a downpour is visibly a stop darker than a dry one.
      float film = wet * ( 0.55 + 0.45 * upF * upF );

      // ---- where the water actually stands ----------------------------
      // Two scales. Metre-wide swales come out of the world macro band, and the
      // tile's own height field supplies the cracks, ruts and joints. Water
      // finds the low spots in BOTH — which is the whole difference between
      // "wet" and a gloss pass laid flat over the street.
      //
      // The coverage is deliberately mean. A soaked street is dark and glossy
      // nearly everywhere and holds STANDING water in maybe a fifth of its
      // area — in the gutter, in the wheel ruts, in the dish around a drain.
      // Flooding the whole plane turns a rainy city into a boating lake, which
      // was exactly what the first pass did.
      vec2 pUv = vOwWPos.xz * owWetP.y;
      float swale = texture2D( owMacroTex, pUv ).r * 0.55
                  + texture2D( owMacroTex, pUv * 0.29 + 0.63 ).b * 0.45;
      /**
       * 3.4 was too steep. Expanding a 256-texel map that hard makes the
       * threshold land inside a single bilinear cell, so the waterline picks up
       * the diamond kinks of the interpolation grid — which is what a critic
       * was seeing as 'hard-edged blobs'. 2.1 spreads the transition over
       * several texels and the kinks disappear under it.
       */
      swale = clamp( ( swale - 0.5 ) * 2.1 + 0.5, 0.0, 1.0 );
      /**
       * A PUDDLE IS A METRE-SCALE SHAPE WITH A FINE FRINGE, and the weighting
       * here is what decides which. Let the tile's own height field drive the
       * outline and the waterline comes out speckled, because it is then
       * tracking individual chippings; the shape has to come from the swale
       * field, with the micro height only feathering the last centimetre where
       * the water actually does creep between the stones.
       */
      float hField = owHeightS * 0.22 + swale * 0.78;
      // The water line rises with wetness, squared so a damp street is only
      // damp and a soaked one has real puddles in its low ground.
      float line = 0.05 + 0.30 * wet * wet * owWetSurf.z;
      /**
       * THE WATERLINE HAS TO BE SOFTER THAN A PIXEL IS WIDE.
       *
       * A puddle edge is a contour of a smooth field, so at the wrong distance
       * a fixed-width smoothstep resolves to a hard, stair-stepped alpha cut —
       * which is exactly what a critic reported as "hard-edged black alpha
       * blobs". fwidth() gives the field's change across one pixel, so widening
       * the transition by that much guarantees the edge is never narrower than
       * the pixel that has to draw it, at any range, under any FOV.
       */
      float hAA = fwidth( hField ) * 1.6;
      float pool = smoothstep( line + 0.13 + hAA, line - 0.05 - hAA, hField );
      /**
       * DRAINAGE. Water does not stand on a slope, and 0.80 here (a 37 degree
       * face still fully flooded) is why puddles were sitting on kerb noses and
       * cambered verges. Standing water needs near-level ground: 0.94 is a
       * 20 degree face at half strength and level ground at full.
       */
      pool *= smoothstep( 0.72, 0.94, upF ) * clamp( owWetSurf.z, 0.0, 1.5 );
      pool = clamp( pool, 0.0, 1.0 );
      // The damp halo OUTSIDE the waterline: ground the puddle has soaked but
      // is not covering. Without it a puddle is a decal with a cut edge.
      float rim = clamp( smoothstep( line + 0.30 + hAA, line - 0.05, hField ) - pool, 0.0, 1.0 );

      // ---- the film: water in the pores -------------------------------
      // A wet porous surface is roughly half as bright. Light that would have
      // scattered back off a pore wall is instead refracted into the film and
      // absorbed on the next bounce; measured asphalt loses about 45%.
      float damp = film * owWetSurf.y;
      // Inside standing water the substrate is not ALSO pore-darkened — the
      // pores are already full and you are looking through a body of water at
      // them, not at a damp aggregate. Applying both multiplies is how the
      // puddles ended up at 0.15 of the dry albedo, i.e. darker than any
      // shadow in the frame and reading as a hole in the road.
      alb.rgb *= mix( 1.0, 0.44, damp * ( 1.0 - pool * 0.75 ) );
      // and the damp fringe just outside the waterline
      alb.rgb *= mix( 1.0, 0.80, rim * damp );
      /**
       * DAMP IS NOT MIRRORED, and this number was measured rather than guessed.
       *
       * A film that merely follows the aggregate is still water-smooth as a
       * microfacet distribution, so at roughness 0.28 every 20 mm chipping gets
       * its own highlight off the sky and the road turns into a choppy sea —
       * the screen-space deviation over a 500x140 patch went from 13.6 dry to
       * 24.3, and the mean got BRIGHTER (75 -> 84) when a wet road must read
       * darker. The mirror belongs to the standing water only. Outside a puddle
       * the surface lands near 0.45: glossy enough to smear a sodium lamp into
       * a vertical streak, nowhere near enough to resolve it as a point.
       */
      orm.g = mix( orm.g, orm.g * 0.42 + 0.10, film * 0.92 );
      orm.g = max( orm.g, mix( 0.02, 0.16, film ) );
      // The micro tooth drowns first: water is tens of microns deep over a
      // tooth that is tenths of a millimetre. Aggregate at 10-30 mm and ruts at
      // 1-4 m survive, which is the scale separation the eye expects.
      vec3 flatN = normalize( owP2V * owNp );
      nShade = normalize( mix( nShade, flatN, film * 0.78 ) );

      // ---- standing water ---------------------------------------------
      /**
       * A PUDDLE IS DARK, NOT BLACK.
       *
       * Measured on the frame this replaces: puddle interior (27,32,38) against
       * a wet-but-not-flooded neighbour at (99,100,104) — 0.27 of it, and below
       * every cast shadow in the same image. That is not what water over
       * asphalt does. Two or three centimetres of clean water absorbs almost
       * nothing; you see the substrate through it, darkened and saturated by
       * the refraction, PLUS a Fresnel-weighted reflection of the sky on top.
       * Crushing the transmitted term to a third and relying on a 4% reflection
       * to carry the read is why they looked like holes.
       */
      alb.rgb *= mix( 1.0, 0.72, pool );
      // Water is also a colour filter: it eats red first, which is what gives
      // standing water on grey asphalt its cold cast.
      alb.rgb *= mix( vec3( 1.0 ), vec3( 0.92, 0.98, 1.04 ), pool );
      /**
       * 0.022 is a perfect mirror, and a perfect mirror of a low-resolution
       * PMREM is a single flat value that flips from near-black looking down to
       * blown-out sky at a grazing angle — which is what made the near and far
       * halves of a wet street look like two unrelated systems. 0.05 keeps a
       * sodium lamp resolvable as a lamp while spreading the horizon across
       * enough of the lobe that the transition is a gradient.
       */
      orm.g = mix( orm.g, 0.050, pool );
      // the fringe is smoother than dry ground but nowhere near a mirror
      orm.g = mix( orm.g, orm.g * 0.72 + 0.06, rim * film );
      // whatever the substrate was, the top surface is now a dielectric
      orm.b *= 1.0 - pool * 0.92;
      // water fills the cavity, so the baked occlusion opens back up
      orm.r = mix( orm.r, 1.0, pool * 0.8 );
      // and it lies FLAT: it does not drape over the aggregate
      nShade = normalize( mix( nShade, flatN, pool * 0.97 ) );

      // ---- rain rings -------------------------------------------------
      // On standing water they are rings; on a wet-but-not-flooded surface
      // they are the flat splash crowns of drops hitting the film, which is
      // weaker but covers everything and is most of what sells falling rain.
      if ( owWetP.z > 0.003 ) {
        float rAmt = ( pool * 0.75 + film * film * 0.22 ) * owWetP.z * upF;
        if ( rAmt > 0.004 ) {
          vec2 rr = owRainRipple( vOwWPos.xz, owWetP.w );
          vec3 tw = vec3( rr.x, 0.0, rr.y ) * rAmt * 0.6;
          tw -= owNw * dot( owNw, tw );
          nShade = normalize( nShade + mat3( viewMatrix ) * tw );
        }
      }

      // ---- water running down a vertical face -------------------------
      // While it is actually raining, a wall carries moving vertical runnels.
      if ( owWetP.z > 0.003 && upF < 0.6 ) {
        float vertF = ( 1.0 - upF ) * owWetP.z * wet;
        float sx = vOwWPos.z * owNw.x - vOwWPos.x * owNw.z;
        float runU = sx * 5.5 + owWetQ.y * vOwWPos.y * 0.6;
        float runV = vOwWPos.y * 0.55 - owWetP.w * 0.75;
        float run = texture2D( owMacroTex, vec2( runU * 0.14, runV * 0.09 ) ).a;
        run = smoothstep( 0.56, 0.78, run ) * vertF;
        orm.g = mix( orm.g, 0.03, run * 0.8 );
        alb.rgb *= 1.0 - run * 0.18;
      }

      owWetOut = vec2( film, pool );
    }
  }
  #endif

  owAlbedo = alb;
  owORM = orm;
  owNormalV = nShade;
}

diffuseColor.rgb *= owAlbedo.rgb;
#ifdef OW_ALPHA_MASK
  diffuseColor.a *= owAlbedo.a;
#endif
#ifdef OW_AUTOGLASS
  diffuseColor.a = owGlassA;
#endif
`;

/**
 * Fabric transmission.
 *
 * A sunlit canvas awning is not opaque: 15-25% of the beam comes through it, so
 * from underneath you see a glowing sheet whose folds read as density and whose
 * edge is bright. That single term is most of what makes cloth read as cloth
 * rather than as painted card.
 *
 * It sums over every directional light rather than reusing 'directLight' (which
 * after the loop holds whichever light was added *last* — the moon, here), and
 * it is occluded by the baked cavity/AO term so a canopy inside an arcade does
 * not glow.
 */
const CLOTH_LIGHT = /* glsl */ `
#if defined( OW_CLOTH ) && ( NUM_DIR_LIGHTS > 0 ) && defined( RE_Direct )
{
  vec3 owTrans = vec3( 0.0 );
  OW_CLOTH_LIGHT( 0 )
  #if NUM_DIR_LIGHTS > 1
    OW_CLOTH_LIGHT( 1 )
  #endif
  #if NUM_DIR_LIGHTS > 2
    OW_CLOTH_LIGHT( 2 )
  #endif
  reflectedLight.directDiffuse += owTrans * diffuseColor.rgb
    * ( owClothP.x * clamp( owORM.r, 0.0, 1.0 ) );
}
#endif
`;

/**
 * Wet / clearcoat corrections to the resolved PhysicalMaterial.
 *
 * 'lights_physical_fragment' is where three turns roughness/metalness into the
 * BRDF parameters, and it is the only place the specular F0 and the clearcoat
 * roughness can still be reached. Both are needed:
 *
 *  - A water film is a dielectric layer with its own Fresnel sitting on top of
 *    the substrate. Raising F0 from 0.04 toward 0.05 is what makes a wet street
 *    throw a real reflection of a sodium lamp fifty metres away rather than a
 *    slightly shiny grey.
 *  - Rain on a car does not roughen the clearcoat, it POLISHES it, so the
 *    clearcoat lobe has to tighten as well as the base lobe.
 */
const MATERIAL_FIXUP = /* glsl */ `
#ifdef OW_WETNESS
{
  float owW = clamp( owWetOut.x * 0.65 + owWetOut.y, 0.0, 1.0 ) * owWetSurf.w;
  material.specularColor = mix( material.specularColor, vec3( 0.052 ),
                               clamp( owW, 0.0, 1.0 ) * ( 1.0 - metalnessFactor ) );
  #ifdef USE_CLEARCOAT
    material.clearcoatRoughness = mix( material.clearcoatRoughness, 0.022,
                                       clamp( owWetOut.x * 0.8 + owWetOut.y, 0.0, 1.0 ) );
  #endif
}
#endif
`;

/** Chunk overrides applied after the main injection. */
const OVERRIDES = [
  ['#include <color_fragment>', '// vertex colours are masks here, see OW_VCOL_MASKS'],
  ['#include <lights_fragment_end>', '#include <lights_fragment_end>\n' + CLOTH_LIGHT],
  [
    '#include <lights_physical_fragment>',
    '#include <lights_physical_fragment>\n' + MATERIAL_FIXUP,
  ],
  [
    '#include <clearcoat_normal_fragment_maps>',
    /* glsl */ `
    #include <clearcoat_normal_fragment_maps>
    #if defined( USE_CLEARCOAT ) && defined( OW_CARPAINT )
      clearcoatNormal = normalize( clearcoatNormal + vec3( owClearTilt, 0.0 ) );
    #endif`,
  ],
  ['#include <roughnessmap_fragment>', 'float roughnessFactor = roughness * owORM.g;'],
  ['#include <metalnessmap_fragment>', 'float metalnessFactor = metalness * owORM.b;'],
  ['#include <normal_fragment_maps>', 'normal = owNormalV;'],
  [
    '#include <aomap_fragment>',
    /* glsl */ `
    {
      float ambientOcclusion = ( owORM.r - 1.0 ) * owAoAmt + 1.0;
      reflectedLight.indirectDiffuse *= ambientOcclusion;
      #if defined( USE_CLEARCOAT )
        clearcoatSpecularIndirect *= ambientOcclusion;
      #endif
      #if defined( USE_SHEEN )
        sheenSpecularIndirect *= ambientOcclusion;
      #endif
      #if defined( USE_ENVMAP ) && defined( STANDARD )
        // Specular occlusion on top of an already AO-heavy cavity map wipes out
        // every glint on detailed geometry, so it only gets 60% of the term.
        float dotNV = saturate( dot( geometryNormal, geometryViewDir ) );
        float aoSpec = mix( 1.0, clamp( ambientOcclusion, 0.0, 1.0 ), 0.6 );
        reflectedLight.indirectSpecular *= computeSpecularOcclusion( dotNV, aoSpec, material.roughness );
      #endif
    }`,
  ],
];

export const DEFAULT_PARAMS = {
  /** 'planar' (world dominant axis) | 'triplanar' | 'mesh' */
  uvMode: 'planar',
  /** project in the object's local space instead of world space */
  localSpace: false,
  /** metres per texture tile */
  scale: 2,
  /** uv offset */
  offset: [0, 0],
  /** parallax depth in metres; 0 disables */
  parallax: 0,
  parallaxFade: [6, 14],
  parallaxLayers: 22,
  /** detail layer: tiles-per-base-tile, normal strength, albedo strength, fade metres */
  detail: [11, 0.55, 0.35, 16],
  /**
   * Metres the shared detail tile should span in the world.
   *
   * detail[0] is expressed *per base tile*, which silently ties the micro
   * layer's world scale to the macro layer's. A prop-scale variant such as
   * 'wood_prop' (scale 0.55 m) with detail[0] = 10 was mapping the 0.25 m
   * detail bake into 55 mm — every 1.6 mm grain became 0.35 mm, i.e. under one
   * pixel at 0.5 m, so the entire micro layer filtered away to nothing and
   * every prop read as flat colour up close. That is measurable: cranking
   * detail[2] from 0.42 to 2.5 on the market stall changed the frame by
   * nothing at all.
   *
   * So detail[0] is now DERIVED from 'scale' unless this is set to 0, which
   * keeps the micro tooth at a fixed physical size no matter how the surface
   * is mapped. 0.26 m matches the bake's authored worldSize of 0.25 m.
   */
  detailWorld: 0.26,
  /**
   * THE MESO BAND — [ tile multiplier on the detail layer, normal amount,
   * albedo amount, roughness amount ].
   *
   * A second sample of the shared detail set at a ~5 m tiling (0.055 x the
   * detail tile, which is authored at 0.26 m). It fills the 5-40 cm hole
   * between the micro tooth and the macro colour wash — the band that decides
   * whether a wall has shape at 15 m or is a smooth luminance ramp. It is far
   * too coarse to alias, so unlike 'detail' it takes no distance fade.
   * Set the normal amount to 0 to disable the layer and its two fetches.
   */
  meso: [0.055, 0.30, 0.10, 0.05],
  /** macro: world scale, albedo strength, roughness strength, hue strength */
  macro: [0.045, 0.35, 0.1, 0.35],
  /**
   * Macro contrast expansion plus a second, much larger band:
   * [ contrast, bigAmplitude, bigWorldScale, unused ]. 1/bigWorldScale is the
   * period of the macro texture in metres, and its coarsest band is a third of
   * that — so 0.028 gives ~12 m features.
   */
  macroBig: [1, 0, 0.03, 0],
  /**
   * Repair patches on vertical faces: [ coverage 0..1, cell metres,
   * albedo delta, roughness delta ]. 0 coverage disables the layer.
   */
  patch: [0, 2.6, 0.12, -0.08],
  /**
   * BUILDING ZONES — [ amount, cell metres, paint chance, soot amount ].
   *
   * A Voronoi of building-sized zones over world XZ, applied on vertical faces
   * only, that gives each neighbour its own value, hue, soot load and chance of
   * having been painted over. Amount 0 disables it. This is the only layer in
   * the shader that is DISCONTINUOUS in world space, which is the whole point:
   * fbm cannot produce a party wall.
   */
  zone: [0, 9, 0.16, 0.5],
  /**
   * Fabric: [ transmission 0..1, underside albedo multiplier, fold amount,
   * unused ]. transmission 0 and multiplier 1 disable the whole cloth layer.
   */
  cloth: [0, 1, 0, 0],
  /** macro-gradient normal tilt on up-facing surfaces (ruts / drifts); 0 = off */
  macroRelief: 0,
  /** de-tiling second-sample blend amount (0 disables the extra fetches) */
  detile: 0,
  /**
   * Use the LANE-PRESERVING de-tile (mirror + rescale along v only) instead of
   * the rotated one. For carriageways: keeps the wheel-polish bands, the cold
   * joint and the oil line locked across the road while breaking the repeat
   * along it. Meaningless without `detile` above 0.
   */
  detileLane: false,
  /**
   * WHICH SHARED MICRO SET this surface samples: 0 mineral aggregate,
   * 1 woven fibre, 2 machined/corroded metal. See generator.js DETAIL_SRC.
   */
  detailSet: 0,
  /**
   * Rotation, in turns, applied to the micro/meso detail lookup. Two surfaces
   * on the same detail set at the same mapping otherwise show the *identical*
   * grain field, which is what makes a critic able to match a road and a shirt
   * blob for blob. Costs nothing.
   */
  detailRot: 0,
  /** weathering: dust, rain streaks, ground-splash height, cavity grime */
  weather: [0.35, 0.3, 0.55, 0.4],
  groundY: 0,
  /** vertex-colour masks: wear, grime, extra AO, unused */
  wear: [0.5, 0.7, 0.5, 0],
  /**
   * [ roughness, METALNESS, unused, tint amount ] where the wear mask is 1.
   *
   * The metalness used to default to 0.5, so every worn edge on concrete,
   * plaster, brick, timber, hessian and the road turned half metal and picked
   * up a specular tint it has no business having. Only the metal library
   * entries — which set their own wearMaterial — should ever raise this.
   */
  wearMaterial: [0.42, 0.0, 0, 0.5],
  wearColor: 0x8d8b86,
  dustColor: 0x6b6154,
  grimeColor: 0x2a2620,
  rustColor: 0x6d3a1c,
  tint: 0xffffff,
  normalStrength: 1,
  /** roughness [ scale, offset, minimum ] */
  roughness: [1, 0, 0.06],
  aoStrength: 1,
  alphaMask: false,
  vertexMasks: false,
  noGrad: false,

  /**
   * WETNESS RESPONSE — [ susceptibility, porosity, pooling, sheen ].
   *
   * The global 0..1 wetness lives in a uniform shared by every material (see
   * wetness.js); this is how much of it THIS surface takes. Susceptibility 0
   * turns the whole layer off, which is what an interior, a viewmodel or the
   * underside of a bridge deck wants. Defaults to the porous-mineral response,
   * because that is what most of a city is made of — and because the global
   * wetness starts at 0, enabling it by default costs nothing until it rains.
   */
  wet: [1, 1, 1, 1],

  /**
   * CAR PAINT — [ flake amount, flake scale (cells/uv), orange-peel scale,
   * orange-peel amount ]. 0 flake and 0 peel disable the layer.
   */
  carPaint: [0, 900, 260, 0],
  /** [ r, g, b, amount ] — the grazing-angle "flop" tint of a metallic. */
  carFlop: [0.55, 0.55, 0.62, 0],

  /**
   * AUTOMOTIVE GLASS — [ thickness m, base opacity, Fresnel edge boost, unused ]
   * plus 'glassAbsorb' in per-metre absorption. Thickness 0 disables it.
   */
  autoGlass: [0, 0.5, 1, 0],
  /**
   * Per-metre absorption coefficients. Float glass is green because of its
   * iron content: red and blue are eaten far faster than green, which is why a
   * windscreen's exposed edge is bottle-green.
   */
  glassAbsorb: [22, 6, 17],

  /**
   * GRIME ACCUMULATION — [ amount, world-height falloff m, cavity bias, up bias ].
   * Amount 0 disables it. Distinct from the 'weather' splash band: this is the
   * slow city film that settles on ledges and fills every crevice, not the mud
   * thrown up off the road.
   */
  grime: [0, 2.5, 0.8, 0.5],
};

/** THREE.Color already converts hex (sRGB) into the linear working space. */
function col(v) {
  return v instanceof THREE.Color ? v.clone() : new THREE.Color(v);
}

/**
 * Install the extension on a material.
 * @param {THREE.MeshStandardMaterial} material
 * @param {object} p        merged parameters (see DEFAULT_PARAMS)
 * @param {object} shared   { detailNormal, macro }
 */
export function extendMaterial(material, p, shared) {
  // Mesh-UV mode treats 'scale' as a repeat count; projected modes treat it as
  // metres per tile.
  const tileScale = p.uvMode === 'mesh' ? p.scale : 1 / p.scale;

  /**
   * Keep the micro tooth at a fixed size in metres (see DEFAULT_PARAMS.detailWorld).
   *
   * Only for surfaces mapped at 0.3 m or coarser — i.e. architecture, ground
   * and world props. A viewmodel part is mapped at 0.02-0.12 m and wants its
   * detail an order of magnitude finer than a wall's; forcing 0.26 m on it
   * would put a 2 mm aggregate tooth on a bolt carrier.
   */
  const dw = p.detailWorld ?? DEFAULT_PARAMS.detailWorld;
  const detailTiles =
    p.uvMode === 'mesh' || !(dw > 0) || p.scale < 0.3
      ? p.detail[0]
      : Math.max(1.2, p.scale / dw);

  /**
   * ONE GREY SPECKLE WAS DOING EVERYTHING.
   *
   * `shared.detailNormal` / `.detailAlbedo` are now ARRAYS of micro sets with
   * genuinely different character (see generator.js). Old callers that hand a
   * single texture still work — the pick below degrades to that texture.
   */
  const pickSet = (v, i) => (Array.isArray(v) ? v[Math.min(i, v.length - 1)] ?? v[0] : v);
  const dset = Math.max(0, Math.round(p.detailSet ?? 0));
  const detNrm = pickSet(shared.detailNormal, dset);
  const detAlb = pickSet(shared.detailAlbedo ?? shared.detailNormal, dset);
  const drot = (p.detailRot ?? 0) * Math.PI * 2;

  const u = {
    owDetailNrm: { value: detNrm },
    owDetailTex: { value: detAlb },
    owMacroTex: { value: shared.macro },
    owDetRot: { value: new THREE.Vector2(Math.cos(drot), Math.sin(drot)) },
    owTile: { value: new THREE.Vector4(tileScale, tileScale, p.offset[0], p.offset[1]) },
    owDetailP: {
      value: new THREE.Vector4(detailTiles, p.detail[1], p.detail[2], p.detail[3]),
    },
    owMesoP: { value: new THREE.Vector4(...(p.meso ?? DEFAULT_PARAMS.meso)) },
    owMacroP: { value: new THREE.Vector4(...p.macro) },
    owMacroBig: { value: new THREE.Vector4(...(p.macroBig ?? DEFAULT_PARAMS.macroBig)) },
    owPatchP: { value: new THREE.Vector4(...(p.patch ?? DEFAULT_PARAMS.patch)) },
    owZoneP: { value: new THREE.Vector4(...(p.zone ?? DEFAULT_PARAMS.zone)) },
    owClothP: { value: new THREE.Vector4(...(p.cloth ?? DEFAULT_PARAMS.cloth)) },
    owParallaxP: {
      value: new THREE.Vector4(p.parallax, p.parallaxFade[0], p.parallaxFade[1], p.parallaxLayers),
    },
    owWeatherP: { value: new THREE.Vector4(...p.weather) },
    owWearP: { value: new THREE.Vector4(...p.wear) },
    owTintCol: { value: col(p.tint) },
    owDustCol: { value: col(p.dustColor) },
    owGrimeCol: { value: col(p.grimeColor) },
    owRustCol: { value: col(p.rustColor ?? DEFAULT_PARAMS.rustColor) },
    owWearCol: { value: col(p.wearColor) },
    owWearMat: { value: new THREE.Vector4(...p.wearMaterial) },
    owRoughP: {
      value: new THREE.Vector4(
        p.roughness[0],
        p.roughness[1],
        p.detile,
        p.roughness[2] ?? DEFAULT_PARAMS.roughness[2]
      ),
    },
    owNormalAmp: { value: p.normalStrength },
    owGroundY: { value: p.groundY },
    owAoAmt: { value: p.aoStrength },
    owMacroRelief: { value: p.macroRelief ?? 0 },
    // SHARED BY REFERENCE with every other extended material — one write in
    // wetness.js updates the whole world. Do not clone these.
    owWetP: WET_UNIFORMS.owWetP,
    owWetQ: WET_UNIFORMS.owWetQ,
    owWetSurf: { value: new THREE.Vector4(...(p.wet ?? DEFAULT_PARAMS.wet)) },
    owCarP: { value: new THREE.Vector4(...(p.carPaint ?? DEFAULT_PARAMS.carPaint)) },
    owCarFlop: { value: new THREE.Vector4(...(p.carFlop ?? DEFAULT_PARAMS.carFlop)) },
    owGlassP: { value: new THREE.Vector4(...(p.autoGlass ?? DEFAULT_PARAMS.autoGlass)) },
    owGlassAbs: {
      value: new THREE.Vector3(...(p.glassAbsorb ?? DEFAULT_PARAMS.glassAbsorb)),
    },
    owGrimeP: { value: new THREE.Vector4(...(p.grime ?? DEFAULT_PARAMS.grime)) },
  };

  const defines = {};
  if (p.uvMode === 'triplanar') defines.OW_TRIPLANAR = '';
  else if (p.uvMode === 'mesh') defines.OW_MESH_UV = '';
  if (p.localSpace) defines.OW_OBJECT_SPACE = '';
  if (p.parallax > 0 && p.uvMode !== 'triplanar') defines.OW_PARALLAX = '';
  if (p.detile > 0 && p.uvMode !== 'triplanar') {
    defines.OW_DETILE = '';
    if (p.detileLane) defines.OW_DETILE_LANE = '';
  }
  if ((p.zone?.[0] ?? 0) > 0) defines.OW_ZONE = '';
  if (p.weather[0] > 0 || p.weather[1] > 0 || p.weather[2] > 0) defines.OW_WEATHER = '';
  if ((p.patch?.[0] ?? 0) > 0) defines.OW_PATCH = '';
  if ((p.cloth?.[0] ?? 0) > 0 || (p.cloth?.[1] ?? 1) < 1) defines.OW_CLOTH = '';
  if ((p.macroRelief ?? 0) > 0) defines.OW_MACRO_RELIEF = '';
  if ((p.meso?.[1] ?? 0) > 0 || (p.meso?.[2] ?? 0) > 0) defines.OW_MESO = '';
  if (p.vertexMasks) defines.OW_VCOL_MASKS = '';
  if (p.alphaMask) defines.OW_ALPHA_MASK = '';
  if (p.noGrad) defines.OW_NOGRAD = '';
  if ((p.wet?.[0] ?? 0) > 0) defines.OW_WETNESS = '';
  if ((p.carPaint?.[0] ?? 0) > 0 || (p.carPaint?.[3] ?? 0) > 0 || (p.carFlop?.[3] ?? 0) > 0)
    defines.OW_CARPAINT = '';
  if ((p.autoGlass?.[0] ?? 0) > 0) defines.OW_AUTOGLASS = '';
  if ((p.grime?.[0] ?? 0) > 0) defines.OW_GRIME = '';

  Object.assign(material.defines ?? (material.defines = {}), defines);
  material.userData.owUniforms = u;
  material.userData.owParams = p;

  const key = Object.keys(defines).sort().join('|');
  material.customProgramCacheKey = () => 'ow:' + key;

  material.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, u);

    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\n' + PARS_VERTEX)
      .replace('#include <worldpos_vertex>', '#include <worldpos_vertex>\n' + MAIN_VERTEX);

    // The pars block must land *after* three has declared map / normalMap /
    // roughnessMap, so it hooks the last pars include rather than <common>.
    let fs = shader.fragmentShader
      .replace(
        '#include <clipping_planes_pars_fragment>',
        '#include <clipping_planes_pars_fragment>\n' + PARS_FRAGMENT
      )
      .replace('#include <map_fragment>', MAIN_FRAGMENT);

    for (const [find, repl] of OVERRIDES) fs = fs.replace(find, repl);
    shader.fragmentShader = fs;
  };

  material.needsUpdate = true;
  return material;
}
