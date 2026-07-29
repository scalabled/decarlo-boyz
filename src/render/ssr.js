import * as THREE from 'three';
import { COMMON } from './glsl.js';
import { Pass, hdrTarget } from './pass.js';

/**
 * Screen-space reflections, marched in SCREEN SPACE.
 *
 * A SODIUM LAMP REFLECTED IN A WET ROAD IS THIS PROJECT'S MONEY SHOT
 * (DESIGN.md), and a wet road is the hardest case an SSR implementation has:
 * a near-horizontal plane seen at a grazing angle, whose reflection rays run
 * tens of metres for every metre of screen they cross.
 *
 * The previous version marched in VIEW space with a geometric step — 28 steps
 * from 6 cm to 24 m. On a wall that is fine. On a wet road it fails in both
 * directions at once: near the camera a single step crosses dozens of pixels of
 * road (so a kerb, a lane line and a puddle edge are all stepped straight over
 * and the reflection is full of holes), while far up the road the steps are
 * shorter than a pixel and the march simply runs out of budget after 24 m —
 * which is roughly where the interesting reflection *starts*.
 *
 * Marching in screen space fixes both by construction. The ray is projected to
 * its screen-space endpoints and stepped at a fixed PIXEL stride, with the
 * view depth interpolated perspective-correctly (interpolate P/w and 1/w, then
 * divide — the standard homogeneous trick), so:
 *
 *   - every step lands on new texels: no holes, no missed thin geometry;
 *   - the step count is bounded by the screen, not by world distance, so a
 *     grazing ray can reach right across the frame — 90 m up a wet street
 *     instead of 24 — for the same cost as a short one;
 *   - the depth-comparison thickness can grow with the ray's own depth, which
 *     is what stops distant hits being rejected because the depth buffer's
 *     idea of "surface thickness" is a screen-space quantity.
 *
 * The hit is reprojected into the *previous* resolved frame with the velocity
 * buffer, so the reflected colour is already tone-mapped-stable and
 * antialiased, and it lags lighting changes rather than camera motion.
 *
 * The result is blended into the IBL specular term inside the material rather
 * than added on top of the frame (see materialpatch.js), so where SSR has no
 * data the reflection falls back to the PMREM environment — the sky, or
 * whatever probe the sky subsystem installed — instead of to black. That
 * fallback is the reason the confidence term is generous about fading out: a
 * soft handover to a slightly wrong cubemap reads as a wet road, a hard edge
 * reads as a bug.
 */

const SSR = /* glsl */ `
precision highp float;
${COMMON}

uniform sampler2D tColor;      // previous resolved frame (HDR)
uniform sampler2D tDepth;
uniform sampler2D tNormal;
uniform sampler2D tVelocity;
uniform mat4 uProj;
uniform mat4 uProjInv;
uniform vec2 uTexel;
uniform vec2 uResolution;
uniform vec4 uParams;   // x maxDistance  y thickness  z frame  w intensity
uniform vec4 uParams2;  // x pixel stride  y near plane  z distance fade  w -
varying vec2 vUv;

#define OW_SSR_STEPS 32
#define OW_SSR_REFINE 5

void main() {
  vec4 nrm = texture2D( tNormal, vUv );
  if ( nrm.z < 0.5 ) { gl_FragColor = vec4( 0.0 ); return; }

  float depth = texture2D( tDepth, vUv ).r;
  vec3 P = owViewPos( vUv, depth, uProjInv );
  vec3 N = owDecodeNormal( nrm.xy );
  vec3 V = normalize( P );
  vec3 R = reflect( V, N );

  // Rays coming back at the camera cannot be resolved on screen. This test is
  // deliberately NOT a grazing-angle test: -V.R = 2(V.N)^2 - 1, so a road seen
  // at a grazing angle scores -1 and is fully accepted, while a road seen from
  // directly above scores +1 and is rejected. That is the right way round.
  float facing = clamp( dot( -V, R ), 0.0, 1.0 );
  if ( facing > 0.94 ) { gl_FragColor = vec4( 0.0 ); return; }

  float maxDist = uParams.x;
  float jitter = owIGN( gl_FragCoord.xy + uParams.z * 7.331 );

  // Start offset along the normal, scaled by depth so the self-intersection
  // bias is roughly constant in SCREEN space rather than in metres.
  vec3 P0 = P + N * ( 0.03 + depth * 0.004 );
  vec3 P1 = P0 + R * maxDist;
  // Clip the far endpoint to just in front of the near plane, or the projection
  // wraps around and the march walks backwards across the frame.
  float nearZ = -uParams2.y;
  if ( P1.z > nearZ ) P1 = P0 + R * ( ( nearZ - P0.z ) / max( 1e-5, R.z ) );

  vec4 H0 = uProj * vec4( P0, 1.0 );
  vec4 H1 = uProj * vec4( P1, 1.0 );
  float k0 = 1.0 / max( 1e-5, H0.w );
  float k1 = 1.0 / max( 1e-5, H1.w );
  vec2 S0 = ( H0.xy * k0 ) * 0.5 + 0.5;
  vec2 S1 = ( H1.xy * k1 ) * 0.5 + 0.5;
  vec3 Q0 = P0 * k0;
  vec3 Q1 = P1 * k1;

  // Steps are chosen from the ray's SCREEN length so the stride is a constant
  // number of pixels whatever the geometry is doing in world space.
  vec2 pixSpan = ( S1 - S0 ) * uResolution;
  float pixels = max( abs( pixSpan.x ), abs( pixSpan.y ) );
  float steps = clamp( pixels / uParams2.x, 2.0, float( OW_SSR_STEPS ) );
  float invSteps = 1.0 / steps;

  bool hit = false;
  vec2 hitUv = vec2( 0.0 );
  float hitDiff = 0.0;
  float hitT = 0.0;
  float prevT = 0.0;

  for ( int i = 1; i <= OW_SSR_STEPS; i ++ ) {
    if ( float( i ) > steps ) break;
    float t = ( float( i ) - jitter ) * invSteps;
    vec2 suv = mix( S0, S1, t );
    if ( suv.x <= 0.0 || suv.x >= 1.0 || suv.y <= 0.0 || suv.y >= 1.0 ) break;

    float k = mix( k0, k1, t );
    float rayDepth = -( mix( Q0.z, Q1.z, t ) / max( 1e-6, k ) );

    float sceneDepth = texture2D( tDepth, suv ).r;
    float cov = texture2D( tNormal, suv ).z;
    float diff = rayDepth - sceneDepth;

    // Thickness grows with depth: a depth buffer records a surface, not a
    // solid, and how thick that surface "is" in a comparison has to scale with
    // how much world one texel covers or every distant hit is missed.
    float thick = uParams.y + sceneDepth * 0.035;

    if ( cov > 0.5 && diff > 0.0 && diff < thick ) {
      float lo = prevT, hi = t;
      for ( int m = 0; m < OW_SSR_REFINE; m ++ ) {
        float mid = ( lo + hi ) * 0.5;
        vec2 muv = mix( S0, S1, mid );
        float mk = mix( k0, k1, mid );
        float mDepth = -( mix( Q0.z, Q1.z, mid ) / max( 1e-6, mk ) );
        if ( mDepth - texture2D( tDepth, muv ).r > 0.0 ) hi = mid; else lo = mid;
      }
      hitUv = mix( S0, S1, hi );
      hitDiff = diff;
      hitT = hi;
      hit = true;
      break;
    }
    prevT = t;
  }

  if ( !hit ) { gl_FragColor = vec4( 0.0 ); return; }

  // Reproject the hit into the previous frame so the colour lines up.
  vec2 vel = texture2D( tVelocity, hitUv ).rg;
  vec2 srcUv = clamp( hitUv - vel, vec2( 0.001 ), vec2( 0.999 ) );
  vec3 color = texture2D( tColor, srcUv ).rgb;

  // --- confidence ----------------------------------------------------------
  // Every term here is a place SSR is KNOWN to be wrong, and each one hands
  // the pixel back to the environment probe rather than to black.
  vec2 edge = smoothstep( vec2( 0.0 ), vec2( 0.14 ), hitUv ) *
              smoothstep( vec2( 0.0 ), vec2( 0.14 ), 1.0 - hitUv );
  float conf = edge.x * edge.y;
  // rays folding back toward the lens
  conf *= 1.0 - smoothstep( 0.72, 0.94, facing );
  // a hit found in the last few steps is the one most likely to be a false
  // positive against a surface the ray actually passed behind
  conf *= 1.0 - smoothstep( 0.80, 1.0, hitT );
  // and one accepted only by the thickness slack is a guess
  conf *= 1.0 - smoothstep( ( uParams.y + depth * 0.035 ) * 0.55,
                            ( uParams.y + depth * 0.035 ), hitDiff );
  // Far from the camera a half-res screen-space reflection has less texel
  // information than the cubemap it would replace. Hand it over.
  conf *= 1.0 - smoothstep( uParams2.z * 0.6, uParams2.z, depth );

  gl_FragColor = vec4( max( color, vec3( 0.0 ) ), clamp( conf, 0.0, 1.0 ) * uParams.w );
}
`;

/**
 * Depth-aware separable blur.
 *
 * A plain blur bleeds a bright lamp reflection across the kerb and out onto the
 * pavement, which on a wet street is the single most obvious SSR tell. Weighting
 * the taps by depth similarity keeps the reflection inside the surface that
 * generated it.
 */
const SSR_BLUR = /* glsl */ `
precision highp float;
uniform sampler2D tSrc;
uniform sampler2D tDepth;
uniform vec2 uDirection;
uniform vec2 uDepthTexel;
varying vec2 vUv;
void main() {
  float d0 = texture2D( tDepth, vUv ).r;
  vec4 sum = texture2D( tSrc, vUv ) * 0.4;
  float w = 0.4;
  for ( int i = 1; i <= 2; i ++ ) {
    float wi = 0.3 / float( i );
    vec2 o = uDirection * float( i );
    float da = texture2D( tDepth, vUv + o ).r;
    float db = texture2D( tDepth, vUv - o ).r;
    float wa = wi * exp( -abs( da - d0 ) / max( 0.25, d0 * 0.06 ) );
    float wb = wi * exp( -abs( db - d0 ) / max( 0.25, d0 * 0.06 ) );
    sum += texture2D( tSrc, vUv + o ) * wa;
    sum += texture2D( tSrc, vUv - o ) * wb;
    w += wa + wb;
  }
  gl_FragColor = sum / max( w, 1e-4 );
}
`;

export class Ssr {
  constructor() {
    this.pass = new Pass('ow-ssr', SSR, {
      tColor: { value: null },
      tDepth: { value: null },
      tNormal: { value: null },
      tVelocity: { value: null },
      uProj: { value: new THREE.Matrix4() },
      uProjInv: { value: new THREE.Matrix4() },
      uTexel: { value: new THREE.Vector2() },
      uResolution: { value: new THREE.Vector2() },
      // maxDistance is 90 m, not 24. On a wet street the lamp worth reflecting
      // is the one 40-70 m up the road; the screen-space march reaches it for
      // the same cost as a short ray because the step budget is measured in
      // pixels.
      uParams: { value: new THREE.Vector4(90, 0.45, 0, 1) },
      // Pixel stride of 2 at half resolution is 4 full-res pixels per step,
      // which with 40 steps covers 160 px — most of the way across a 1080p
      // frame for a grazing road ray.
      // Pixel stride 2.6 at half resolution is ~5 full-res pixels per step;
      // 32 steps then reach ~166 px, most of the way across a 1080p frame for a
      // grazing road ray. Chosen against the profiler: the march is the single
      // most expensive ray-cast in the frame and every step is a dependent
      // texture fetch, so reach is bought with stride rather than step count.
      uParams2: { value: new THREE.Vector4(2.6, 0.1, 260, 0) },
    });
    this.blur = new Pass('ow-ssr-blur', SSR_BLUR, {
      tSrc: { value: null },
      tDepth: { value: null },
      uDirection: { value: new THREE.Vector2() },
      uDepthTexel: { value: new THREE.Vector2() },
    });
    this.rtA = null;
    this.rtB = null;
    this.texture = null;
  }

  setSize(w, h) {
    this.rtA?.dispose();
    this.rtB?.dispose();
    // half resolution: reflections are low frequency and this is the single
    // most expensive ray-marching pass in the frame
    const hw = Math.max(1, w >> 1);
    const hh = Math.max(1, h >> 1);
    this.rtA = hdrTarget(hw, hh, { name: 'ssr' });
    this.rtB = hdrTarget(hw, hh, { name: 'ssr-blur' });
    this.pass.uniforms.uTexel.value.set(1 / hw, 1 / hh);
    this.pass.uniforms.uResolution.value.set(hw, hh);
    this._texel = new THREE.Vector2(1 / hw, 1 / hh);
  }

  render(renderer, gbuffer, colorTexture, camera, frame) {
    const u = this.pass.uniforms;
    u.tColor.value = colorTexture;
    u.tDepth.value = gbuffer.depthTexture;
    u.tNormal.value = gbuffer.normalTexture;
    u.tVelocity.value = gbuffer.velocityTexture;
    u.uProj.value.copy(camera.projectionMatrix);
    u.uProjInv.value.copy(camera.projectionMatrixInverse);
    u.uParams.value.z = frame % 64;
    u.uParams2.value.y = camera.near;
    this.pass.render(renderer, this.rtA);

    const b = this.blur.uniforms;
    b.tDepth.value = gbuffer.depthTexture;
    b.tSrc.value = this.rtA.texture;
    b.uDirection.value.set(this._texel.x, 0);
    this.blur.render(renderer, this.rtB);
    b.tSrc.value = this.rtB.texture;
    b.uDirection.value.set(0, this._texel.y);
    this.blur.render(renderer, this.rtA);

    this.texture = this.rtA.texture;
    return this.texture;
  }

  dispose() {
    this.rtA?.dispose();
    this.rtB?.dispose();
    this.pass.dispose();
    this.blur.dispose();
  }
}
