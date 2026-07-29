import * as THREE from 'three';
import { COMMON } from './glsl.js';
import { Pass, hdrTarget } from './pass.js';

/**
 * Ground-Truth Ambient Occlusion (Jimenez et al. 2016) — the visibility-arc
 * integral, not a hemisphere-sample SSAO approximation.
 *
 * Two slices x eight steps per frame, with the slice angle rotated by
 * interleaved-gradient noise and advanced every frame; a velocity-reprojected
 * temporal accumulator turns that into the equivalent of ~16 slices without
 * the cost. A depth-aware separable bilateral removes what is left.
 *
 * The result is consumed inside the material (see materialpatch.js), where it
 * multiplies indirect light only.
 */

const AO_CORE = /* glsl */ `
precision highp float;
${COMMON}

uniform sampler2D tDepth;
uniform sampler2D tNormal;
uniform mat4 uProjInv;
uniform vec2 uTexel;
uniform vec2 uResolution;
uniform float uP11;
uniform vec4 uParams;   // x radius(m)  y max march radius(px)  z frame  w tangent bias
uniform float uMaxDistance;
/** 1 = the pre-calibration march (128 px ceiling, quadratic steps). */
uniform float uLegacyMarch;
varying vec2 vUv;

#define OW_SLICES 3
#define OW_STEPS 8

float owArc( float h, float n, float cosN, float sinN ) {
  return 0.25 * ( -cos( 2.0 * h - n ) + cosN + 2.0 * h * sinN );
}

void main() {
  vec4 nrm = texture2D( tNormal, vUv );
  if ( nrm.z < 0.5 ) { gl_FragColor = vec4( 1.0, 1e4, 0.0, 1.0 ); return; }

  float depth = texture2D( tDepth, vUv ).r;

  // DISTANCE EARLY-OUT. A 1.35 m AO radius projects to under two pixels past
  // ~700 m, so the clamp to a 6 px minimum radius makes every tap land on
  // unrelated geometry and the falloff then throws all of them away — 48
  // texture fetches to compute 1.0. In a 120 m corridor that never happened; in
  // a 3 km city half the frame is past this line. Skipping it outright is the
  // single cheapest win in the pass and is bit-identical to what it computed.
  //
  // ...PROVIDED 'uMaxDistance' IS ACTUALLY UPLOADED. It was not. The uniform was
  // declared here and copied from contact.js, but it was never added to the
  // 'Pass' uniform map below, so three never set it and GL left it at its
  // default of ZERO. 'depth > 0.0' is true for every shaded fragment in every
  // frame, so this line returned visibility 1.0 for the WHOLE SCREEN and the
  // AO buffer has been identically white ever since — measured directly off
  // '?rview=ao' (RGB 255,255,255, min == max == 1.0, over every rect sampled in
  // 'car' and 'detail').
  //
  // Everything downstream of AO was therefore dead too, silently, while
  // 'owFeat.x' reported 1 and the pass cost its full price every frame: the
  // occlusion on indirect light, the micro-shadow on the direct term, the
  // sky-band visibility that is this engine's real contact shadow, and the
  // occlusion-driven warm wrap. That is what a critic panel measured as
  // "contact shadows do not exist", "the car and the ped cast nothing" and
  // "nothing in the frame reads as touching anything".
  //
  // The distance is now DERIVED (see Gtao.render) rather than assumed, so it
  // cannot silently mean zero again: it is the depth at which the projected
  // radius reaches the 6 px clamp above, which is exactly the point past which
  // this early-out was claimed to be free.
  if ( depth > uMaxDistance ) { gl_FragColor = vec4( 1.0, depth, 0.0, 1.0 ); return; }

  vec3 P = owViewPos( vUv, depth, uProjInv );
  vec3 N = owDecodeNormal( nrm.xy );
  vec3 V = normalize( -P );

  float radius = uParams.x;
  // world radius -> pixels
  float radiusPx = radius * uP11 * 0.5 * uResolution.y / max( 0.2, depth );
  /**
   * THE CEILING IS WHAT THE NEAR FIELD ACTUALLY GETS, AND IT WAS 128 px.
   *
   * Rearranged, the line above says the requested world radius is only
   * delivered past  depth = radius * P11 * 0.5 * resY / ceiling.  With the old
   * hardcoded 128 and the 'street' camera (fov 55, 1080p) that is 21 m: every
   * surface nearer than 21 m — i.e. the whole foreground, the part of the frame
   * a player actually looks at — was marched at an effective radius of
   * depth / 8.1 metres, not at 'aoRadius'. At 3 m that is 37 cm.
   *
   * MEASURED off '?rview=ao' before this changed: raising aoRadius from 1.35 to
   * 4.0 m moved the AO under the near kerb and on the foreground road by
   * NOTHING AT ALL (1.0000 -> 1.0000 at two separate road rects), while the
   * 15 m wall/pavement junction went 0.771 -> 0.332. The setting was being
   * silently discarded exactly where contact matters most, which is why turning
   * it up looked like it did nothing and made the number impossible to
   * calibrate.
   *
   * It is a uniform now, sized off the render height rather than a constant, so
   * it means the same thing at every resolution. The tap COUNT is unchanged —
   * this costs no extra fetches, only wider ones — and the eight steps stay
   * quadratic so the first three still land inside six pixels.
   *   '?owNoAoReach=1' puts the 128 back for the A/B.
   */
  radiusPx = clamp( radiusPx, 6.0, uParams.y );
  // Span of the geometric march, in octaves from the 1.5 px floor.
  float logSpan = log2( max( radiusPx, 3.0 ) / 1.5 );

  float noise = owIGN( gl_FragCoord.xy + uParams.z * 5.588238 );
  float noise2 = owHash12( gl_FragCoord.xy * 0.371 + uParams.z );

  float invR2 = 1.0 / ( radius * radius );
  float visibility = 0.0;
  // Sum of the per-slice weights actually accumulated. See the normalisation
  // at the bottom of the loop — this is not bookkeeping, it is the estimator.
  float wsum = 0.0;

  /**
   * TANGENT-PLANE BIAS — the reason facades came back black.
   *
   * A sample that lies in the shading point's OWN tangent plane is not an
   * occluder, it is the same surface. On a wall seen at a grazing angle the
   * view vector very nearly lies IN that wall, so a sample taken along the
   * slice toward the camera has dot(normalize(ds), V) close to +1, which is a
   * horizon at zero elevation, which closes the visibility arc completely. The
   * surface occludes itself.
   *
   * MEASURED, once the pass was emitting anything at all: every building
   * facade in the 'street' frame read AO 0.000 while the road, kerbs, poles
   * and street furniture in the same frame read correctly — and the normal
   * buffer was fine, so it was not a geometry or prepass fault. The visible
   * result was every brick rowhouse turning into a dark navy slab, which is
   * worse than the flat lighting it was supposed to fix.
   *
   * This is the standard HBAO/GTAO angle bias: require a sample to rise a
   * minimum sine above the tangent plane before it may act as an occluder.
   * uParams.w carried the value all along — it was declared as 'thickness',
   * initialised to 0.4, and read by nothing, exactly like uMaxDistance above.
   */
  float owBias = uParams.w;

  for ( int s = 0; s < OW_SLICES; s ++ ) {
    float phi = ( float( s ) + noise ) * ( OW_PI / float( OW_SLICES ) );
    vec2 dir2 = vec2( cos( phi ), sin( phi ) );
    vec3 sliceDir = vec3( dir2, 0.0 );

    vec3 axis = normalize( cross( sliceDir, V ) );
    vec3 projN = N - axis * dot( N, axis );
    float projLen = length( projN );
    if ( projLen < 1e-4 ) continue;
    vec3 projNn = projN / projLen;

    vec3 orthoDir = normalize( sliceDir - V * dot( sliceDir, V ) );
    float cosN = clamp( dot( projNn, V ), -1.0, 1.0 );
    float n = sign( dot( orthoDir, projNn ) ) * acos( cosN );
    float sinN = sin( n );

    // Horizons are signed relative to orthoDir: the +dir2 side carries the
    // POSITIVE angle. Getting this the wrong way round collapses the
    // visibility arc on every grazing surface.
    float cosHPos = -1.0;
    float cosHNeg = -1.0;

    for ( int t = 0; t < OW_STEPS; t ++ ) {
      /**
       * GEOMETRIC step distribution — log-uniform in pixels, not quadratic.
       *
       * The quadratic form this replaces was itself a fix: eight LINEAR steps
       * over a 128 px radius put the first sample sixteen pixels out, so the
       * wall/soffit junction, the foot of a column and the gap under a crate
       * were never sampled and the buffer came back at 0.92 almost everywhere.
       * Weighting toward the origin fixed that — but it made the near-field
       * sample density a function of the FAR radius, because every offset is
       * radiusPx * ft^2. So widening the march to reach further immediately
       * thinned out the near taps and started LOSING contacts.
       *
       * MEASURED, and it is the reason this is not just a ceiling change:
       * raising the ceiling from 128 to 324 px at aoRadius 2.6 moved the
       * wall/pavement junction the WRONG WAY, 0.542 -> 0.556, and the kerb
       * 0.752 -> 0.779. More reach, less contact — because the third tap had
       * moved from 13.5 px out to 18.6 px and stepped straight over the kerb.
       *
       * A geometric progression decouples the two: the taps are evenly spaced
       * in LOG pixels, so the first is always ~2 px whatever the radius and the
       * last is always the radius. At 324 px that is 1.5/3.2/7/15/33/71/153/331
       * — near-field contact and macro occlusion in the same eight fetches,
       * which is what a screen-space AO with a metres-scale radius needs.
       *
       * 1.5 px floor: a sample that lands back on the centre texel produces a
       * garbage horizon direction that closes the visibility arc completely.
       */
      float ft = ( float( t ) + noise2 ) / float( OW_STEPS );
      float off = uLegacyMarch > 0.5
        ? radiusPx * ft * ft + 1.0
        : 1.5 * exp2( logSpan * ft );
      vec2 duv = dir2 * off * uTexel;

      // +dir
      vec2 uv1 = vUv + duv;
      if ( uv1.x > 0.0 && uv1.x < 1.0 && uv1.y > 0.0 && uv1.y < 1.0 ) {
        float d1 = texture2D( tDepth, uv1 ).r;
        float cov1 = texture2D( tNormal, uv1 ).z;
        if ( cov1 > 0.5 ) {
          vec3 ds = owViewPos( uv1, d1, uProjInv ) - P;
          float len2 = dot( ds, ds );
          if ( len2 > 2e-5 ) {
            float inv = inversesqrt( len2 );
            // Elevation above the shading point's tangent plane, as a sine.
            if ( dot( ds, N ) * inv > owBias ) {
              float c = dot( ds, V ) * inv;
              float fall = clamp( len2 * invR2, 0.0, 1.0 );
              fall *= fall;
              cosHPos = max( cosHPos, mix( c, cosHPos, fall ) );
            }
          }
        }
      }

      // -dir
      vec2 uv2 = vUv - duv;
      if ( uv2.x > 0.0 && uv2.x < 1.0 && uv2.y > 0.0 && uv2.y < 1.0 ) {
        float d2 = texture2D( tDepth, uv2 ).r;
        float cov2 = texture2D( tNormal, uv2 ).z;
        if ( cov2 > 0.5 ) {
          vec3 ds = owViewPos( uv2, d2, uProjInv ) - P;
          float len2 = dot( ds, ds );
          if ( len2 > 2e-5 ) {
            float inv = inversesqrt( len2 );
            if ( dot( ds, N ) * inv > owBias ) {
              float c = dot( ds, V ) * inv;
              float fall = clamp( len2 * invR2, 0.0, 1.0 );
              fall *= fall;
              cosHNeg = max( cosHNeg, mix( c, cosHNeg, fall ) );
            }
          }
        }
      }
    }

    float h1 = -acos( clamp( cosHNeg, -1.0, 1.0 ) );
    float h2 = acos( clamp( cosHPos, -1.0, 1.0 ) );
    h1 = n + max( h1 - n, -OW_HALF_PI );
    h2 = n + min( h2 - n, OW_HALF_PI );

    // A single slice legitimately integrates to more than 1 on tilted
    // surfaces; the excess is what compensates the slices whose projected
    // normal is short. Clamping per slice (or per frame) biases the whole
    // buffer dark, which is the classic "my SSAO looks like dirt" bug.
    visibility += projLen * ( owArc( h1, n, cosN, sinN ) + owArc( h2, n, cosN, sinN ) );
    wsum += projLen;
  }

  /**
   * NORMALISE BY THE SUMMED WEIGHT, NOT BY THE SLICE COUNT.
   *
   * Each slice is weighted by |projN|, the length of the normal projected into
   * that slice's plane — the standard GTAO importance weight. Dividing the
   * weighted sum by OW_SLICES instead of by the sum of the weights is only
   * correct when the weights average 1, which happens when the surface faces
   * the camera. It is wrong exactly where |projN| is short, i.e. on surfaces
   * seen at a grazing angle — and it is worse than wrong there, because a slice
   * whose projected normal underflows is 'continue'd out of the numerator while
   * still counting in the denominator.
   *
   * MEASURED on the 'street' frame the first time this pass emitted anything:
   * every building facade read AO 0.000 with coverage 1.0 and a perfectly good
   * normal in the g-buffer, while the road (0.97) and pavement (1.00) in the
   * same frame were correct. A near-vertical facade viewed down the street is
   * the short-|projN| case; a road under the same camera is not. The visible
   * result was every brick rowhouse turning into a navy slab: measured
   * RGB(65,46,57) -> RGB(30,38,58), i.e. the red channel more than halved and
   * the blue left standing by the haze in front of it, which is the material
   * read dying — the exact defect this whole task exists to fix, arriving from
   * the fix for it.
   *
   * Nothing above this line changed. For a camera-facing surface every projLen
   * is 1, wsum is OW_SLICES, and the two forms are identical.
   */
  visibility = clamp( visibility / max( wsum, 1e-4 ), 0.0, 4.0 );

  gl_FragColor = vec4( visibility, depth, 0.0, 1.0 );
}
`;

const AO_TEMPORAL = /* glsl */ `
precision highp float;
${COMMON}
uniform sampler2D tCurrent;
uniform sampler2D tHistory;
uniform sampler2D tVelocity;
uniform sampler2D tNormal;
uniform vec2 uTexel;
uniform float uFeedback;
varying vec2 vUv;

void main() {
  vec2 cur = texture2D( tCurrent, vUv ).rg;
  vec2 vel = texture2D( tVelocity, vUv ).rg;
  vec2 huv = vUv - vel;

  float w = uFeedback;
  if ( huv.x < 0.0 || huv.x > 1.0 || huv.y < 0.0 || huv.y > 1.0 ) w = 0.0;

  vec2 hist = texture2D( tHistory, huv ).rg;
  // reject on depth discontinuity (disocclusion)
  float rel = abs( hist.y - cur.y ) / max( 0.05, cur.y );
  w *= exp( -rel * 30.0 );

  // A wide neighbourhood window only: the per-frame signal is 3 slices of a
  // stochastic integral, so a tight clamp would just re-inject its variance.
  float mn = cur.x, mx = cur.x;
  for ( int i = 0; i < 4; i ++ ) {
    vec2 o = vec2( i == 0 ? 1.0 : i == 1 ? -1.0 : 0.0, i == 2 ? 1.0 : i == 3 ? -1.0 : 0.0 );
    float s = texture2D( tCurrent, vUv + o * uTexel * 2.0 ).r;
    mn = min( mn, s ); mx = max( mx, s );
  }
  float h = clamp( hist.x, mn - 0.45, mx + 0.45 );

  gl_FragColor = vec4( mix( cur.x, h, w ), cur.y, 0.0, 1.0 );
}
`;

const AO_BLUR = /* glsl */ `
precision highp float;
uniform sampler2D tAo;
uniform vec2 uDirection;
uniform vec2 uParams;   // x: apply the intensity curve on this pass
varying vec2 vUv;

void main() {
  vec2 c = texture2D( tAo, vUv ).rg;
  float sum = c.r * 0.4;
  float wsum = 0.4;
  for ( int i = 1; i <= 3; i ++ ) {
    float w0 = 0.4 / float( i + 1 );
    vec2 o = uDirection * float( i );
    vec2 a = texture2D( tAo, vUv + o ).rg;
    vec2 b = texture2D( tAo, vUv - o ).rg;
    float wa = w0 * exp( -abs( a.g - c.g ) * 22.0 / max( 0.1, c.g ) );
    float wb = w0 * exp( -abs( b.g - c.g ) * 22.0 / max( 0.1, c.g ) );
    sum += a.r * wa + b.r * wb;
    wsum += wa + wb;
  }
  float ao = sum / wsum;
  if ( uParams.x > 0.5 ) ao = pow( clamp( ao, 0.0, 1.0 ), uParams.y );
  gl_FragColor = vec4( ao, c.g, 0.0, 1.0 );
}
`;

export class Gtao {
  constructor() {
    this.core = new Pass('ow-gtao', AO_CORE, {
      tDepth: { value: null },
      tNormal: { value: null },
      uProjInv: { value: new THREE.Matrix4() },
      uTexel: { value: new THREE.Vector2() },
      uResolution: { value: new THREE.Vector2() },
      uP11: { value: 1 },
      // x radius(m), y ceiling on the march radius IN PIXELS (see AO_CORE —
      // this is what the near field is really marched at; y used to be a dead
      // 'intensity' slot while the live intensity sat on the blur pass), z
      // frame, w tangent bias.
      uParams: { value: new THREE.Vector4(0.9, 128, 0, 0.4) },
      // Metres past which the arc march is skipped. Recomputed every frame in
      // 'render()' from the projection and the render size — never a constant,
      // and never absent (see the note in AO_CORE: absent meant zero, and zero
      // meant no ambient occlusion anywhere in the game).
      uMaxDistance: { value: 1e6 },
      uLegacyMarch: { value: 0 },
    });
    this.temporal = new Pass('ow-gtao-temporal', AO_TEMPORAL, {
      tCurrent: { value: null },
      tHistory: { value: null },
      tVelocity: { value: null },
      tNormal: { value: null },
      uTexel: { value: new THREE.Vector2() },
      uFeedback: { value: 0.92 },
    });
    this.blur = new Pass('ow-gtao-blur', AO_BLUR, {
      tAo: { value: null },
      uDirection: { value: new THREE.Vector2() },
      uParams: { value: new THREE.Vector2(0, 1.25) },
    });

    /** `?owNoAoFix=1`: restore the zero the early-out was silently using. */
    this.noEarlyOutFix = false;
    /** `?owNoAoReach=1`: restore the hardcoded 128 px march ceiling. */
    this.noReachFix = false;
    /** Ceiling on the march radius as a FRACTION of the render height. */
    this.reachFraction = 0.30;
    this.rtRaw = null;
    this.rtBlur = null;
    this.rtFinal = null;
    this.history = [null, null];
    this._flip = 0;
    this.texture = null;
  }

  setSize(w, h) {
    this.dispose(true);
    const o = { type: THREE.HalfFloatType, format: THREE.RGFormat, name: 'gtao' };
    this.rtRaw = hdrTarget(w, h, o);
    this.rtBlur = hdrTarget(w, h, o);
    this.rtFinal = hdrTarget(w, h, o);
    this.history[0] = hdrTarget(w, h, o);
    this.history[1] = hdrTarget(w, h, o);
    this.core.uniforms.uTexel.value.set(1 / w, 1 / h);
    this.core.uniforms.uResolution.value.set(w, h);
    this.temporal.uniforms.uTexel.value.set(1 / w, 1 / h);
    this._texel = new THREE.Vector2(1 / w, 1 / h);
  }

  render(renderer, gbuffer, camera, frame, temporalOn) {
    const cu = this.core.uniforms;
    cu.tDepth.value = gbuffer.depthTexture;
    cu.tNormal.value = gbuffer.normalTexture;
    cu.uProjInv.value.copy(camera.projectionMatrixInverse);
    cu.uP11.value = camera.projectionMatrix.elements[5];
    cu.uParams.value.z = temporalOn ? frame % 64 : 0;
    // Resolution-relative, so `aoRadius` means the same number of metres at
    // 720p and at 1440p instead of reaching a third as far at the higher one.
    cu.uParams.value.y = this.noReachFix
      ? 128
      : Math.max(64, Math.round(cu.uResolution.value.y * this.reachFraction));
    cu.uLegacyMarch.value = this.noReachFix ? 1 : 0;
    // The early-out distance is the depth at which the world-space radius has
    // shrunk to the 6 px floor the march clamps to. Past that every tap lands
    // on unrelated geometry and the falloff discards it, so skipping is
    // genuinely free; short of it, skipping is the bug this replaced. Derived
    // from the live projection and render height so it tracks FOV, quality
    // preset and resolution instead of being a number somebody has to remember
    // to update.
    //   radiusPx = radius * P11 * 0.5 * resY / depth   (see AO_CORE)
    cu.uMaxDistance.value = this.noEarlyOutFix
      ? 0
      : (cu.uParams.value.x * cu.uP11.value * 0.5 * cu.uResolution.value.y) / 6.0;
    this.core.render(renderer, this.rtRaw);

    let src = this.rtRaw;
    if (temporalOn) {
      const prev = this.history[this._flip];
      const next = this.history[this._flip ^ 1];
      const tu = this.temporal.uniforms;
      tu.tCurrent.value = this.rtRaw.texture;
      tu.tHistory.value = prev.texture;
      tu.tVelocity.value = gbuffer.velocityTexture;
      this.temporal.render(renderer, next);
      this._flip ^= 1;
      src = next;
    }

    // Blur into a dedicated target: the history must stay un-blurred or the
    // accumulator smears more every frame.
    const bu = this.blur.uniforms;
    bu.tAo.value = src.texture;
    bu.uDirection.value.set(this._texel.x, 0);
    bu.uParams.value.x = 0;
    this.blur.render(renderer, this.rtBlur);
    bu.tAo.value = this.rtBlur.texture;
    bu.uDirection.value.set(0, this._texel.y);
    bu.uParams.value.x = 1; // clamp + intensity curve on the last stage only
    this.blur.render(renderer, this.rtFinal);

    this.texture = this.rtFinal.texture;
    return this.texture;
  }

  setRadius(r) {
    this.core.uniforms.uParams.value.x = r;
  }
  setIntensity(i) {
    this.blur.uniforms.uParams.value.y = i;
  }
  /** @param b minimum sine above the tangent plane for a sample to occlude. */
  setBias(b) {
    this.core.uniforms.uParams.value.w = b;
  }

  dispose(keepPasses = false) {
    this.rtRaw?.dispose();
    this.rtBlur?.dispose();
    this.rtFinal?.dispose();
    this.history[0]?.dispose();
    this.history[1]?.dispose();
    this.rtRaw = this.rtBlur = this.rtFinal = null;
    this.history[0] = this.history[1] = null;
    if (!keepPasses) {
      this.core.dispose();
      this.temporal.dispose();
      this.blur.dispose();
    }
  }
}
