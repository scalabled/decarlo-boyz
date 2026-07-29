import * as THREE from 'three';
import { COMMON } from './glsl.js';
import { Pass, hdrTarget, floatType } from './pass.js';

/**
 * Physical exposure.
 *
 * Everything downstream is driven by a single scalar held in a 1x1 float
 * target — never by ad-hoc brightness multipliers scattered through the
 * shaders. Metering is a centre-weighted log-average luminance reduced on the
 * GPU (no readback, no stall), converted to an EV100 and then to a photometric
 * exposure with the standard saturation-based speed constant:
 *
 *     EV100 = log2( L * 100 / K ),  K = 12.5
 *     H     = 78 / (q * S) * 2^EV100,  exposure = 1 / H  (q=0.65, S=100)
 *
 * Adaptation is asymmetric — the eye brightens up slowly and darkens down
 * quickly — and clamped to a compensation window so a dark corner cannot
 * turn night into day.
 *
 * ---------------------------------------------------------------------------
 * TWO THINGS A PLAIN LOG-AVERAGE METER GETS WRONG, AND WHAT IS DONE ABOUT THEM
 * ---------------------------------------------------------------------------
 *
 * 1. IT RENDERS EVERY SCENE AT THE SAME BRIGHTNESS. That is what a meter is
 *    FOR — it is also why midnight came out as an overcast afternoon. Measured
 *    at hour 01:30: avgLum 0.005, which the formula above faithfully turns into
 *    an exposure of 5-14, and a moonlit brick wall then lands on code value 46
 *    with 1.7% of the frame pinned above 250. A camera does not do this either;
 *    a photographer stops down at night, and every shipped engine ships an
 *    "exposure compensation curve" that does the same thing automatically.
 *
 *    `uNight` is that curve. Below a knee EV the meter stops compensating: each
 *    stop the scene darkens past the knee is passed through to the image
 *    instead of being cancelled, at a configurable slope (1.0 = a hard exposure
 *    lock, 0 = the naive meter). Above the knee it is EXACTLY ZERO, so daylight,
 *    golden hour and every interior bright enough to meter normally are
 *    untouched. Softened with a smooth-max so there is no kink at the knee.
 *
 * 2. IT IS HIJACKED BY THE BRIGHTEST THING IN THE FRAME. A car fireball, a shop
 *    window authored as an emitter, a wet-kerb specular: a log-average with a
 *    per-tap clamp still lets a few thousand very bright pixels drag the whole
 *    image down by stops. Measured on the 15:00 street shot with an explosion
 *    in frame: the entire sunlit street went black behind the fireball.
 *
 *    So the meter now REJECTS ITS OWN OUTLIERS. The previous frame's smoothed
 *    log-luminance is fed back into the log pass (channel .b of the 1x1 adapt
 *    target), and any tap more than `uWindow.x` stops above it is faded out of
 *    the average, fully gone by `uWindow.y`. That is a highlight-weighted
 *    rejection, not a clamp: the pixels stop voting instead of voting for a
 *    smaller number.
 *
 *    Rejection can only ever run away in one direction, so the pass also
 *    carries the UNREJECTED average in .ba. When rejection has eaten most of
 *    the frame — which means the scene genuinely changed, e.g. walking out of a
 *    tunnel — the adapt step blends back to the unrejected average and the
 *    meter re-acquires. There is no feedback path that can latch.
 *
 *    KNOWN GAP, DIAGNOSED BUT NOT FIXED — A LARGE-AREA PERSISTENT ADDITIVE.
 *    Rejection is measured against `refLog`, which is THE FRAME'S OWN smoothed
 *    mean, tracking at 1.6x the fastest adaptation speed. That is right for a
 *    transient (a fireball is gone before the reference can follow it) and it
 *    is defeated by anything large and persistent: the reference simply rises
 *    to meet it, the event falls back inside the window within a fraction of a
 *    second, and it votes at full weight from then on. Observed for real on the
 *    helicopter searchlight, which was a constant additive cone with no falloff
 *    covering 15-24% of the frame: metered exposure 2.28 with the beam against
 *    4.09 without — 0.84 EV — and everything outside the cone crushed to black.
 *    Fixed at source (the cone), so nothing in the shipped build triggers it
 *    today; but explosions at close range, a wall of mill steam, a bank of
 *    headlights or dense fog are all the same shape of input.
 *
 *    The fix, if this recurs, is NOT a tighter rejection window — the beam was
 *    ~4 stops over the mean and would have been rejected on the first frame; it
 *    is that the ANCHOR is wrong. Reject against a SCENE-REFERRED reference
 *    instead of the image's own average: `sky` already publishes both halves of
 *    one (`sky.keyLight.intensity` and `sky.ambientColor`, which together are
 *    what the frame's surfaces are actually lit by), so the meter could be given
 *    a floor of the form "never stop down more than N stops below the exposure
 *    the published scene light implies". That is a design change to shared
 *    metering, not a tuning change: it governs the day scene, which has been
 *    signed off, and it has to be proved never to bind in a tunnel, an interior
 *    or a night street before it can ship. It deserves its own task with its
 *    own capture set, and is deliberately NOT bundled into a night-lighting fix.
 *
 *    The low end is handled by an absolute FLOOR rather than a relative one,
 *    for the same reason: a black night sky filling a third of the frame drags
 *    a log-average down without limit, and a relative cut on it is a positive
 *    feedback loop. A fixed floor cannot latch.
 */

const LOGLUM = /* glsl */ `
precision highp float;
${COMMON}
uniform sampler2D tSrc;
uniform sampler2D tDepth;
uniform sampler2D tPrev;   // 1x1 adapt result; .b is last frame's mean log2 lum
uniform vec2 uTexel;
uniform vec4 uMeter;   // x skyWeight, y farDistance(m), z tapClamp, w hasDepth
uniform vec2 uSkyKnee; // luminance range over which the sky de-weight ramps in
// x stops above the running mean where rejection starts, y where it is total,
// z absolute luminance floor, w unused.
uniform vec4 uWindow;
varying vec2 vUv;

// Per-tap clamp: the solar disc is authored at radiance 4000 and a specular
// hit off a rail can be worse. One such pixel inside a 4-tap box would drag
// the whole log-average by stops, so every tap is limited before the log.
float owMeterTap( vec2 uv ) {
  vec3 c = max( texture2D( tSrc, uv ).rgb, vec3( 0.0 ) );
  return min( owLum( c ), uMeter.z );
}

void main() {
  float lum = owMeterTap( vUv + vec2( -1.0, -1.0 ) * uTexel );
  lum += owMeterTap( vUv + vec2(  1.0, -1.0 ) * uTexel );
  lum += owMeterTap( vUv + vec2( -1.0,  1.0 ) * uTexel );
  lum += owMeterTap( vUv + vec2(  1.0,  1.0 ) * uTexel );
  // ABSOLUTE floor, not a relative one. See the header: the black half of a
  // night sky is real scene content whose log2 runs off to -14, and nothing
  // downstream cares about the difference between 0.0002 and 0.0012 except the
  // average it is dragging.
  lum = max( lum * 0.25, uWindow.z );

  // centre-weighted metering: the middle of the frame is what the player aims at
  vec2 d = ( vUv - 0.5 ) * 2.0;
  float w = exp( -dot( d, d ) * 1.1 );

  // ...but do NOT meter off a BRIGHT sky. A sunlit sky band fills the upper
  // half of almost every exterior shot; letting it into the average pulls the
  // exposure down until the street it is lighting reads as night. Depth is 0
  // where no geometry was written (sky), and anything past uMeter.y is aerial
  // perspective — also mostly sky.
  //
  // The de-weight ramps in with the sky's own luminance, and that matters: a
  // moonlit night sky is legitimate scene content and the only absolute anchor
  // the meter has at night. De-weight it unconditionally and night adapts up
  // until it looks like an overcast afternoon.
  if ( uMeter.w > 0.5 ) {
    float depth = texture2D( tDepth, vUv ).r;
    if ( depth <= 0.0 || depth > uMeter.y ) {
      w *= mix( 1.0, uMeter.x, smoothstep( uSkyKnee.x, uSkyKnee.y, lum ) );
    }
  }

  float logLum = log2( lum );

  // --- outlier rejection, relative to where the meter already sits ----------
  // A fireball, a muzzle flash or a shopfront authored as an emitter is not
  // what the frame is exposed for. Anything more than uWindow.x stops over the
  // running mean fades out of the vote and is gone by uWindow.y.
  float refLog = texture2D( tPrev, vec2( 0.5 ) ).b;
  float wSel = w * ( 1.0 - smoothstep( uWindow.x, uWindow.y, logLum - refLog ) );

  gl_FragColor = vec4( logLum * wSel, wSel, logLum * w, w );
}
`;

const REDUCE = /* glsl */ `
precision highp float;
uniform sampler2D tSrc;
uniform vec2 uTexel;
varying vec2 vUv;
void main() {
  vec4 s = vec4( 0.0 );
  for ( int y = 0; y < 4; y ++ ) {
    for ( int x = 0; x < 4; x ++ ) {
      vec2 o = ( vec2( float( x ), float( y ) ) - 1.5 ) * uTexel;
      s += texture2D( tSrc, vUv + o );
    }
  }
  gl_FragColor = s / 16.0;
}
`;

const ADAPT = /* glsl */ `
precision highp float;
uniform sampler2D tSrc;
uniform sampler2D tPrev;
uniform vec4 uParams;   // x dt, y speedUp, z speedDown, w manual EV bias
uniform vec4 uLimits;   // x minEV, y maxEV, z reset, w keyScale
// The exposure compensation curve. x knee EV100, y slope below it,
// z max compensation in stops, w knee softness.
uniform vec4 uNight;
// x coverage below which the rejected average is distrusted, y where it is
// trusted completely.
uniform vec2 uTrust;
varying vec2 vUv;

void main() {
  vec4 s = texture2D( tSrc, vec2( 0.5 ) );
  // .xy is the outlier-rejected accumulator, .zw the raw one. When rejection
  // has eaten the frame the scene changed under us; trust the raw average so
  // the meter can re-acquire instead of latching on whatever survived.
  float logSel = s.x / max( s.y, 1e-5 );
  float logAll = s.z / max( s.w, 1e-5 );
  float cover = s.y / max( s.w, 1e-5 );
  float avgLogLum = mix( logAll, logSel, smoothstep( uTrust.x, uTrust.y, cover ) );

  // EV100 from average scene luminance, then the photometric exposure.
  float evRaw = avgLogLum + log2( 100.0 / 12.5 );

  // --- the exposure compensation curve -------------------------------------
  // Zero above the knee (a smooth-max of a quantity that is negative there),
  // then uNight.y stops of 'stop compensating' for every stop the scene falls
  // below it. This is what makes night read as night; without it the meter
  // does its job perfectly and the image is wrong.
  float t = uNight.x - evRaw;
  float soft = 0.5 * ( t + sqrt( t * t + uNight.w ) );
  float comp = min( uNight.y * soft, uNight.z );

  // uParams.w is the artistic compensation and it is ADDED: a higher EV100
  // means a smaller exposure, so + is darker — which is the sign both this
  // file's header and RenderSystem.setExposureBias have always claimed.
  float ev100 = clamp( evRaw + comp + uParams.w, uLimits.x, uLimits.y );

  vec4 prev = texture2D( tPrev, vec2( 0.5 ) );
  float prevEv = prev.g;
  float prevLog = prev.b;
  if ( uLimits.z > 0.5 ) { prevEv = ev100; prevLog = avgLogLum; }

  float speed = ev100 > prevEv ? uParams.z : uParams.y;
  float k = 1.0 - exp( -uParams.x * speed );
  float ev = mix( prevEv, ev100, clamp( k, 0.0, 1.0 ) );
  // The rejection reference tracks faster than the exposure does, so a scene
  // change re-opens the window before the eye has finished adapting to it.
  float kr = 1.0 - exp( -uParams.x * max( uParams.y, uParams.z ) * 1.6 );
  float meanLog = mix( prevLog, avgLogLum, clamp( kr, 0.0, 1.0 ) );

  float maxLum = 1.2 * exp2( ev );       // 78/(q*S) with q=0.65,S=100 -> 1.2
  float exposure = uLimits.w / maxLum;

  gl_FragColor = vec4( exposure, ev, meanLog, 1.0 );
}
`;

export class AutoExposure {
  constructor(renderer) {
    this.logPass = new Pass('ow-loglum', LOGLUM, {
      tSrc: { value: null },
      tDepth: { value: null },
      tPrev: { value: null },
      uTexel: { value: new THREE.Vector2() },
      // x sky de-weight, y the distance past which geometry is treated as sky,
      // z per-tap clamp, w hasDepth.
      //
      // 400 m was a 120 m corridor's number: in a 3 km city a downtown skyline
      // at 1.5 km is real, lit geometry and the single biggest thing in the
      // frame, and de-weighting it made the meter open up on the street in the
      // foreground until the towers blew out. 1400 m keeps the whole city in
      // the average and only sheds the far haze, which by then genuinely IS
      // sky radiance (see aerial.js) and would double-count against it.
      uMeter: { value: new THREE.Vector4(0.15, 1400, 40, 0) },
      uSkyKnee: { value: new THREE.Vector2(0.06, 0.3) },
      /**
       * x/y: the highlight rejection window, in stops over the running mean.
       *
       * 2.5 stops over a metered mid grey is a sunlit white wall — real scene
       * content the frame must stay exposed for — so rejection starts above
       * that and is total by 5.5, which is a fireball, a lamp lens or a
       * specular event. Measured effect: the 15:00 street shot with a car
       * exploding six metres from the lens went from a black street behind a
       * white fireball to a correctly exposed street with a blown fireball,
       * which is what the eye and the camera both do.
       *
       * z: absolute luminance floor per tap. The night sky, a shadowed alley
       * and an unlit interior wall all run off toward zero radiance and their
       * log2 runs off with them. 1.2e-3 is about 9 stops under a metered
       * daylight mid grey — below anything the tone curve can distinguish —
       * and bounding it there stops a black third of the frame dragging the
       * average without any relative test that could latch.
       */
      uWindow: { value: new THREE.Vector4(2.5, 5.5, 1.2e-3, 0) },
    });
    this.reducePass = new Pass('ow-reduce', REDUCE, {
      tSrc: { value: null },
      uTexel: { value: new THREE.Vector2() },
    });
    this.adaptPass = new Pass('ow-adapt', ADAPT, {
      tSrc: { value: null },
      tPrev: { value: null },
      // x dt, y speed when the scene gets DARKER, z speed when it gets
      // BRIGHTER, w EV bias.
      //
      // Asymmetric on purpose and in the physiological direction: light
      // adaptation is fast, dark adaptation is slow. Both were raised for
      // driving — at 1.4/s, exiting a lit tunnel into a dark street took over
      // two seconds to open up, which at 120 km/h is 70 metres of black road.
      // 1.9 / 3.8 still reads as an eye adjusting rather than a gain slider,
      // and it settles inside the length of an underpass.
      uParams: { value: new THREE.Vector4(0.016, 1.9, 3.8, 0) },
      uLimits: { value: new THREE.Vector4(-4, 16, 1, 1.0) },
      /**
       * The exposure compensation curve: (knee EV100, slope, max stops, soft).
       *
       * The knee sits just under the darkest scene that should still be
       * metered normally. Measured EV100 before compensation:
       *   noon 12:30  -1.0     15:00 street   +0.4
       *   golden 19:36 -0.8    hour 01:30    -4.6
       * so -2.4 clears every daylight and golden-hour frame in the shot set
       * and only ever engages after dark or inside something genuinely unlit.
       *
       * Slope 0.75: three quarters of every stop the scene falls past the knee
       * reaches the image. 1.0 would be a hard exposure lock — correct for a
       * still, wrong for a game where driving into an unlit underpass has to
       * stay legible; swept on a FROZEN night frame at 0.7/0.8/0.9/1.0 and
       * 0.9 upward loses the pavement, the pedestrians and the parked cars in
       * the plaza while 0.7 still reads slightly like late dusk.
       *
       * Measured on that frozen frame (hour 01:30, avgLum 0.0031):
       *   curve off   exposure 17.40 (pinned on the -4.3 EV clamp), p50 46
       *   slope 0.75  exposure  5.26                                p50 12
       * i.e. 1.7 stops off a night that was metering itself into an overcast
       * afternoon.
       *
       * ----------------------------------------------------------------------
       * WHY THIS SLOPE STAYED AT 0.64 WHEN NIGHT WAS FIXED FOR BEING TOO DARK
       * ----------------------------------------------------------------------
       * The 21:21 overcast frame was unnavigable — median code
       * value 16, road / kerb / pavement / grass all inside code 6..22 with no
       * separation, unlit pedestrians as black blobs. This slope is one of the
       * two terms holding that image ~2.4 stops under a metered mid grey (the
       * other is `sky.exposureBias`), so it is the obvious knob, and it was
       * swept: 0.52 gives back 0.35 stops at 21:21 and 0.36 at 01:30.
       *
       * It was still put back, for two measured reasons.
       *
       * 1. IT IS THE ONE NIGHT LEVER THAT LEAKS INTO THE DAY. The compensation
       *    is a SMOOTH max, so its tail does not reach exactly zero at the
       *    knee: the golden-hour shot meters at evRaw -2.42, right on the -2.4
       *    knee, and moving the slope to 0.52 brightened it by 0.018 EV (+1.3%
       *    mean luma, +0.4 code values at p50). Small — and unnecessary, since
       *    everything it bought is available in `src/sky` behind a
       *    `1 - beamAlive` gate that is EXACTLY zero while any part of the
       *    solar disc is above the horizon.
       * 2. RAISING EXPOSURE IS THE WRONG FIX FOR THIS DEFECT ANYWAY. It scales
       *    the lit and the unlit alike, so it does not restore the separation
       *    that was missing, and it pushes the emissive shopfronts — already
       *    over display white — further into the clip: measured on the night
       *    street frame, +0.18 stops of exposure took the fraction above 0.98
       *    from 0.287% to 0.518%. Fixing it with LIGHT instead (see the urban
       *    skyglow term in src/sky/index.js) raises the unlit surfaces, which
       *    raises the metered average, which makes the meter stop DOWN — the
       *    same frame ended up brighter in the shadows AND at 0.163% clipped.
       *
       * So: night exposure compensation is correct as a policy and stays where
       * it is. What was wrong was that there was nothing to expose FOR.
       */
      uNight: { value: new THREE.Vector4(-2.4, 0.64, 5.0, 0.35) },
      uTrust: { value: new THREE.Vector2(0.10, 0.30) },
    });

    // Half where full float is not RENDERABLE — see `floatType` in pass.js.
    // Getting this wrong costs the whole image, not just the meter.
    const o = { type: floatType(renderer), format: THREE.RGBAFormat, name: 'exposure' };
    this.rt64 = hdrTarget(64, 64, o);
    this.rt16 = hdrTarget(16, 16, o);
    this.rt4 = hdrTarget(4, 4, o);
    this.rt1 = hdrTarget(1, 1, o);
    this.adapt = [hdrTarget(1, 1, o), hdrTarget(1, 1, o)];
    this._flip = 0;
    this.enabled = true;
    this.manual = 1.0;
    this._reset = true;
  }

  get texture() {
    return this.adapt[this._flip].texture;
  }

  reset() {
    this._reset = true;
  }

  /**
   * `bias` is an EV offset: +1 makes the image one stop darker.
   * `depthTexture` is the linear-depth gbuffer channel; when supplied the sky
   * is de-weighted out of the meter.
   */
  update(renderer, sourceTexture, sw, sh, dt, bias, key, depthTexture) {
    const lu = this.logPass.uniforms;
    lu.tSrc.value = sourceTexture;
    lu.tDepth.value = depthTexture ?? null;
    // Last frame's smoothed mean log-luminance, for the outlier window.
    lu.tPrev.value = this.adapt[this._flip].texture;
    lu.uMeter.value.w = depthTexture ? 1 : 0;
    lu.uTexel.value.set(1 / sw, 1 / sh);
    this.logPass.render(renderer, this.rt64);

    const ru = this.reducePass.uniforms;
    ru.tSrc.value = this.rt64.texture;
    ru.uTexel.value.set(1 / 64, 1 / 64);
    this.reducePass.render(renderer, this.rt16);
    ru.tSrc.value = this.rt16.texture;
    ru.uTexel.value.set(1 / 16, 1 / 16);
    this.reducePass.render(renderer, this.rt4);
    ru.tSrc.value = this.rt4.texture;
    ru.uTexel.value.set(1 / 4, 1 / 4);
    this.reducePass.render(renderer, this.rt1);

    const au = this.adaptPass.uniforms;
    au.tSrc.value = this.rt1.texture;
    au.tPrev.value = this.adapt[this._flip].texture;
    au.uParams.value.x = Math.min(dt, 0.1);
    au.uParams.value.w = bias;
    au.uLimits.value.z = this._reset ? 1 : 0;
    au.uLimits.value.w = key;
    this._reset = false;
    const dst = this.adapt[this._flip ^ 1];
    this.adaptPass.render(renderer, dst);
    this._flip ^= 1;
    return dst.texture;
  }

  /**
   * The exposure compensation curve. `knee` is the EV100 below which the meter
   * stops fully compensating, `slope` how much of each further stop reaches the
   * image (1 = exposure lock), `maxStops` the ceiling on the whole term.
   */
  setNightCurve(knee, slope, maxStops) {
    const v = this.adaptPass.uniforms.uNight.value;
    v.set(knee, slope, maxStops, v.w);
  }

  setLimits(minEv, maxEv) {
    this.adaptPass.uniforms.uLimits.value.x = minEv;
    this.adaptPass.uniforms.uLimits.value.y = maxEv;
  }

  dispose() {
    this.rt64.dispose();
    this.rt16.dispose();
    this.rt4.dispose();
    this.rt1.dispose();
    this.adapt[0].dispose();
    this.adapt[1].dispose();
    this.logPass.dispose();
    this.reducePass.dispose();
    this.adaptPass.dispose();
  }
}
