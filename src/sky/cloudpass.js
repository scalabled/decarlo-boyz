import * as THREE from 'three';
import { SkyPass, hdrTarget } from './fullscreen.js';
import { ATMOSPHERE_GLSL, TRANSMITTANCE_LOOKUP_GLSL } from './atmosphere.js';
import { NOISE_GLSL } from './noise.js';
import { CLOUDS_GLSL } from './clouds.js';

/**
 * The cloud deck, rendered off-screen.
 *
 * ---------------------------------------------------------------------------
 * WHY OFF-SCREEN
 * ---------------------------------------------------------------------------
 * A slab march with a light march at every sample is ~700 noise evaluations per
 * sky pixel. At 1920x1080 with 40% of the frame showing sky that is 600 million
 * hashes a frame, which is four to six milliseconds — more than the entire rest
 * of the sky put together. Rendering it at half resolution is 4x cheaper, and
 * temporally accumulating a dithered march is what buys back the quality: eight
 * steps a frame with a per-frame dither converges to the same image as thirty-two
 * within half a second, and — this is the part that matters for TAA — the
 * accumulation is a low-pass filter on exactly the high-frequency crawl a
 * per-pixel threshold on an fbm produces.
 *
 * Clouds are behind everything, so half resolution costs nothing at silhouettes:
 * there are no silhouettes to cross. The one place it shows is a cumulus edge
 * against blue, which comes back a touch soft — and a real cumulus edge at 8 km
 * IS soft, so this is the rare case where the cheap answer is also the right one.
 *
 * ---------------------------------------------------------------------------
 * REPROJECTION
 * ---------------------------------------------------------------------------
 * The renderer's velocity buffer is zero on sky pixels (there is no geometry to
 * have moved), so it cannot reproject a cloud at all. But a cloud IS effectively
 * at infinity, and the reprojection of an infinitely distant point is exact and
 * free: project the view *direction* through the previous frame's
 * view-projection with w = 0. That is what `uPrevViewProj` is for, and it is why
 * this resolve does not touch `r.velocityTexture`.
 *
 * ---------------------------------------------------------------------------
 * THE SHADOW MAP
 * ---------------------------------------------------------------------------
 * Moving cloud shadows crossing the street are one of the loudest GTA V tells,
 * and they cannot come from the cascades: the clouds are not geometry. So a
 * second, tiny pass marches the slab from the ground toward the sun over a
 * square of world around the camera, and everything that needs to know how much
 * sun a ground point is getting — the volumetric fog, the light shafts, and the
 * screen-space patch term in the composite — reads that one texture.
 *
 * The square is SNAPPED to its own texel grid before it is used. Without that
 * the whole shadow field shimmers as the camera walks, because every texel is
 * resampling a different part of the cloud each frame.
 */

const CLOUD_COMMON = /* glsl */ `
${ATMOSPHERE_GLSL}
${TRANSMITTANCE_LOOKUP_GLSL}
${NOISE_GLSL}
${CLOUDS_GLSL}

uniform vec3 uSunDir;
uniform vec3 uMoonDir;
uniform vec3 uSunIrradiance;
uniform vec3 uMoonIrradiance;
uniform vec3 uGroundAlbedo;
uniform sampler2D uSkyAmbientLut;
`;

const MARCH_FRAG = /* glsl */ `
precision highp float;
${CLOUD_COMMON}
uniform mat4 uInvProj;
uniform mat4 uCamWorld;
uniform float uFrame;
in vec2 vUv;
layout(location = 0) out vec4 fragColor;

void main() {
  vec4 h = uInvProj * vec4( vUv * 2.0 - 1.0, 1.0, 1.0 );
  vec3 vd = h.xyz / h.w;
  vd /= max( 1.0e-6, -vd.z );
  vec3 rd = normalize( mat3( uCamWorld ) * vd );

  vec3 ambSky = texture( uSkyAmbientLut, vec2( 0.25, 0.5 ) ).rgb;
  vec3 ambHor = texture( uSkyAmbientLut, vec2( 0.75, 0.5 ) ).rgb;
  // Ground bounce lighting the cloud base. A cloud over a wet grey city takes a
  // cool, dark fill from below; over a sunlit one it takes a warm bright one.
  // uGroundAlbedo is the same number the IBL's lower hemisphere uses.
  vec3 ambGround = ambHor * uGroundAlbedo * 1.6
                 + uSunIrradiance * uGroundAlbedo * max( 0.0, uSunDir.y ) / SK_PI;

  // Two decks sample very different solar spectra: the cumulus at 1-2 km looks
  // through nearly the whole aerosol column, the cirrus at 7.8 km is above most
  // of it. That is what makes a sunset read as pink cirrus over orange-grey
  // cumulus instead of one flat wash.
  vec3 pLow  = vec3( 0.0, SK_GROUND_R + uCloudShape.x * 0.001, 0.0 );
  vec3 pHigh = vec3( 0.0, SK_GROUND_R + 0.0078, 0.0 );
  vec3 sunLow   = uSunIrradiance  * skTransmittance( pLow,  uSunDir );
  vec3 sunHigh  = uSunIrradiance  * skTransmittance( pHigh, uSunDir );
  vec3 moonLow  = uMoonIrradiance * skTransmittance( pLow,  uMoonDir );
  vec3 moonHigh = uMoonIrradiance * skTransmittance( pHigh, uMoonDir );

  /**
   * WHITE NOISE IN SPACE, GOLDEN RATIO IN TIME. Not interleaved-gradient noise.
   *
   * IGN is the right dither for a rotating sample kernel, but its two frequency
   * coefficients differ by a factor of eleven, so as a scalar offset field it is
   * strongly ANISOTROPIC — it varies fast across x and slowly up y. A march
   * whose result swings with the offset therefore prints IGN's own structure
   * into the image, and what that looks like on a cloud deck is a comb of
   * vertical streaks hanging off every base. It was unmistakable and it was not
   * the clouds: it was the dither.
   *
   * A per-pixel hash is spatially white, so there is no structure to print, and
   * advancing it by the golden ratio each frame walks the whole [0,1) interval
   * without ever repeating — which is exactly what the temporal accumulation
   * needs to converge.
   */
  float dith = fract( skHash12( gl_FragCoord.xy ) + uFrame * 0.6180339887 );

  vec4 cir = skCirrus( uSkyOrigin, rd, uSunDir, sunHigh, uMoonDir, moonHigh, ambSky );
  vec4 cum = skCloudSlab( uSkyOrigin, rd, uSunDir, sunLow, uMoonDir, moonLow,
                          ambSky, ambGround, VOL_CLOUD_STEPS, 5, 3, dith );

  // Cumulus is BELOW cirrus, so from the ground it is in front. Both are
  // premultiplied, so the over operator is one multiply-add.
  float a = cum.a + cir.a * ( 1.0 - cum.a );
  vec3 c = cum.rgb + cir.rgb * ( 1.0 - cum.a );
  fragColor = vec4( c, a );
}
`;

const RESOLVE_FRAG = /* glsl */ `
precision highp float;
uniform sampler2D tCurrent;
uniform sampler2D tHistory;
uniform mat4 uInvProj;
uniform mat4 uCamWorld;
uniform mat4 uPrevViewProj;
uniform vec2 uTexel;
uniform float uBlend;
in vec2 vUv;
layout(location = 0) out vec4 fragColor;

void main() {
  vec4 cur = texture( tCurrent, vUv );

  // Reprojection of a point at infinity: project the DIRECTION with w = 0.
  vec4 h = uInvProj * vec4( vUv * 2.0 - 1.0, 1.0, 1.0 );
  vec3 vd = h.xyz / h.w;
  vd /= max( 1.0e-6, -vd.z );
  vec3 dir = mat3( uCamWorld ) * vd;
  vec4 clip = uPrevViewProj * vec4( dir, 0.0 );

  float w = uBlend;
  vec2 puv = vec2( 0.0 );
  if ( clip.w <= 1.0e-6 ) w = 0.0;
  else {
    puv = clip.xy / clip.w * 0.5 + 0.5;
    if ( puv.x < 0.0 || puv.x > 1.0 || puv.y < 0.0 || puv.y > 1.0 ) w = 0.0;
  }

  if ( w <= 0.0 ) { fragColor = cur; return; }

  vec4 lo = cur, hi = cur;
  for ( int i = 0; i < 9; i ++ ) {
    if ( i == 4 ) continue;
    vec2 o = vec2( float( i % 3 ) - 1.0, float( i / 3 ) - 1.0 ) * uTexel;
    vec4 n = texture( tCurrent, vUv + o );
    lo = min( lo, n );
    hi = max( hi, n );
  }
  // Widen the box: clamping hard to the 3x3 range throws away the very
  // convergence the accumulation exists to buy, and on a dithered march the
  // neighbourhood is a sample of the same distribution, not a different signal.
  vec4 c = 0.5 * ( lo + hi );
  vec4 e = 0.5 * ( hi - lo ) * 1.7 + 1.0e-4;
  vec4 his = clamp( texture( tHistory, puv ), c - e, c + e );
  fragColor = mix( cur, his, w );
}
`;

/**
 * Sunlight reaching the ground, marched through the deck, over a square of
 * world snapped to this texture's own grid.
 *   uRect.xy  world XZ of the square's minimum corner, metres
 *   uRect.z   1 / extent
 */
const SHADOW_FRAG = /* glsl */ `
precision highp float;
${ATMOSPHERE_GLSL}
${NOISE_GLSL}
${CLOUDS_GLSL}
uniform vec3 uSunDir;
uniform vec4 uRect;
in vec2 vUv;
layout(location = 0) out vec4 fragColor;

void main() {
  vec2 w = uRect.xy + vUv / uRect.z;
  float s = skCloudShadow( w, uSunDir );
  fragColor = vec4( s, s, s, 1.0 );
}
`;

export class CloudRenderer {
  /**
   * @param {object} shared shared uniform objects, owned by SkySystem
   * @param {object} opts   { scale, steps, shadowSize, shadowExtent }
   */
  constructor(shared, opts = {}) {
    this.shared = shared;
    this.scale = opts.scale ?? 0.5;
    this.steps = opts.steps ?? 12;
    this.enabled = true;

    this.width = 0;
    this.height = 0;
    this.rtMarch = null;
    this.rtHistory = [null, null];
    this._flip = 0;
    this._reset = true;
    this._frame = 0;

    const base = {
      uMieScale: shared.uMieScale,
      uViewPos: shared.uViewPos,
      uSkyOrigin: shared.uSkyOrigin,
      uTransmittanceLut: shared.uTransmittanceLut,
      uSkyAmbientLut: shared.uSkyAmbientLut,
      uSunDir: shared.uSunDir,
      uMoonDir: shared.uMoonDir,
      uSunIrradiance: shared.uSunIrradiance,
      uMoonIrradiance: shared.uMoonIrradiance,
      uGroundAlbedo: shared.uGroundAlbedo,
      uCloudParams: shared.uCloudParams,
      uCloudParams2: shared.uCloudParams2,
      uCloudShape: shared.uCloudShape,
      uCloudLight: shared.uCloudLight,
    };

    this.marchPass = new SkyPass(
      'sky-cloud-march',
      MARCH_FRAG,
      {
        ...base,
        uInvProj: { value: new THREE.Matrix4() },
        uCamWorld: { value: new THREE.Matrix4() },
        uFrame: { value: 0 },
      },
      { VOL_CLOUD_STEPS: this.steps }
    );

    this.resolvePass = new SkyPass('sky-cloud-resolve', RESOLVE_FRAG, {
      tCurrent: { value: null },
      tHistory: { value: null },
      uInvProj: this.marchPass.uniforms.uInvProj,
      uCamWorld: this.marchPass.uniforms.uCamWorld,
      uPrevViewProj: { value: new THREE.Matrix4() },
      uTexel: { value: new THREE.Vector2() },
      uBlend: { value: 0.88 },
    });

    // ---- shadow map -------------------------------------------------------
    const size = opts.shadowSize ?? 384;
    this.shadowExtent = opts.shadowExtent ?? 2400;
    this.shadowSize = size;
    this.rtShadow = hdrTarget(size, size, { name: 'sky-cloud-shadow' });
    this.shadowPass = new SkyPass('sky-cloud-shadow', SHADOW_FRAG, {
      uMieScale: shared.uMieScale,
      uViewPos: shared.uViewPos,
      uSkyOrigin: shared.uSkyOrigin,
      uSunDir: shared.uSunDir,
      uCloudParams: shared.uCloudParams,
      uCloudParams2: shared.uCloudParams2,
      uCloudShape: shared.uCloudShape,
      uCloudLight: shared.uCloudLight,
      uRect: shared.uCloudShadowRect,
    });

    this._prevViewProj = new THREE.Matrix4();
    this._viewProj = new THREE.Matrix4();
  }

  resize(w, h) {
    const mw = Math.max(1, Math.round(w * this.scale));
    const mh = Math.max(1, Math.round(h * this.scale));
    if (this.rtMarch && this.width === mw && this.height === mh) return;
    this.width = mw;
    this.height = mh;
    this.rtMarch?.dispose();
    this.rtHistory[0]?.dispose();
    this.rtHistory[1]?.dispose();
    this.rtMarch = hdrTarget(mw, mh, { name: 'sky-cloud' });
    this.rtHistory[0] = hdrTarget(mw, mh, { name: 'sky-cloud-h0' });
    this.rtHistory[1] = hdrTarget(mw, mh, { name: 'sky-cloud-h1' });
    this.resolvePass.uniforms.uTexel.value.set(1 / mw, 1 / mh);
    this._reset = true;
  }

  /** Current resolved cloud texture, premultiplied rgb + coverage in a. */
  get texture() {
    return this.rtHistory[this._flip ^ 1]?.texture ?? null;
  }

  /**
   * Render this frame's cloud buffer and shadow map.
   * Called from `lateUpdate`, i.e. before the renderer takes the frame.
   */
  render(renderer, camera, screenW, screenH) {
    this.resize(screenW, screenH);
    this._frame++;

    const mu = this.marchPass.uniforms;
    // Unjittered: the renderer applies TAA jitter after lateUpdate, so what is
    // on the camera right now is the clean projection. Sampling the buffer with
    // gl_FragCoord in the dome then reads a stable image, which is precisely
    // what stops the deck crawling under TAA.
    mu.uInvProj.value.copy(camera.projectionMatrixInverse);
    mu.uCamWorld.value.copy(camera.matrixWorld);
    mu.uFrame.value = this._frame % 64;
    this.marchPass.render(renderer, this.rtMarch);

    const ru = this.resolvePass.uniforms;
    const prev = this.rtHistory[this._flip];
    const next = this.rtHistory[this._flip ^ 1];
    ru.tCurrent.value = this.rtMarch.texture;
    ru.tHistory.value = prev.texture;
    ru.uPrevViewProj.value.copy(this._prevViewProj);
    ru.uBlend.value = this._reset ? 0 : 0.88;
    this.resolvePass.render(renderer, next);
    this._flip ^= 1;
    this._reset = false;

    this._viewProj.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
    this._prevViewProj.copy(this._viewProj);

    this.shadowPass.render(renderer, this.rtShadow);
  }

  /** Snap the shadow square to its own texel grid around a world XZ. */
  updateShadowRect(x, z, out) {
    const texel = this.shadowExtent / this.shadowSize;
    const ox = Math.floor((x - this.shadowExtent * 0.5) / texel) * texel;
    const oz = Math.floor((z - this.shadowExtent * 0.5) / texel) * texel;
    out.set(ox, oz, 1 / this.shadowExtent, this.shadowExtent);
  }

  reset() {
    this._reset = true;
  }

  dispose() {
    this.rtMarch?.dispose();
    this.rtHistory[0]?.dispose();
    this.rtHistory[1]?.dispose();
    this.rtShadow.dispose();
    this.marchPass.dispose();
    this.resolvePass.dispose();
    this.shadowPass.dispose();
  }
}
