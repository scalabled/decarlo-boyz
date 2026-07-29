import * as THREE from 'three';

/**
 * Precipitation: wind-driven streaks, splash crowns, ripples, ledge drips and
 * vehicle spray.
 *
 * ---------------------------------------------------------------------------
 * THE TRAP THIS IS BUILT TO AVOID
 * ---------------------------------------------------------------------------
 * "Rain" in a hobby renderer is white lines drawn over an otherwise dry scene,
 * and it reads as a screen overlay in one frame. Four things separate that from
 * rain, and all four are here:
 *
 *  1  THE STREAKS ARE LIT BY THE SCENE, NOT WHITE. A falling drop is a lens: it
 *     scatters whatever light is around it. So the streak colour is the sky's
 *     own ambient plus a specular term off the key, which means rain over a
 *     bright overcast sky is nearly invisible against the sky and blazes against
 *     a dark wall — which is exactly what a photograph of rain shows, and it is
 *     why you cannot see rain against a white sky in real life either.
 *  2  IT LANDS. Every drop that reaches the ground throws a crown and an
 *     expanding ripple. Streaks without splashes read as a particle system;
 *     splashes are what put the rain IN the world.
 *  3  IT GETS THINGS WET. The wetness integral (weather.js) drives the material
 *     subsystem's global wetness uniform, so the asphalt goes to a mirror over
 *     the same minutes the puddles fill. Rain over dry asphalt is the loudest
 *     tell of the four.
 *  4  IT COMES OFF THINGS. Ledges drip for minutes after the rain stops, and a
 *     car at speed throws a sheet off its wheels.
 *
 * ---------------------------------------------------------------------------
 * COST
 * ---------------------------------------------------------------------------
 * Three instanced draws, no per-frame allocation, and the streak simulation is
 * entirely in the vertex shader: the CPU writes six uniforms a frame and never
 * touches the buffer. The splash and drip layers are ring buffers whose spawn
 * cursors advance a fixed number of slots per frame, so their upload is a
 * bounded sub-range regardless of the rain rate.
 */

/** Vertical fall speed of a raindrop, m/s. Real terminal velocity is 5-9. */
const FALL_SPEED = 8.5;

const STREAK_VERT = /* glsl */ `
precision highp float;
in vec3 position;
in vec2 uv;
in vec4 aSeed;        // xyz base position in the box, w size/speed jitter

uniform mat4 projectionMatrix;
uniform mat4 viewMatrix;
uniform mat4 modelMatrix;
uniform vec3 uCamPos;
uniform vec3 uWind;      // horizontal drift, m/s
uniform float uTime;
uniform float uBox;      // side of the wrap box, metres
uniform float uAmount;   // 0..1 fraction of instances alive
uniform vec2 uSize;      // x half width, y streak length scale
uniform float uNear;     // fade-in distance so drops do not pop at the lens

out vec2 vUv;
out float vFade;

void main() {
  float speed = FALL_SPEED * ( 0.78 + 0.44 * aSeed.w );
  vec3 vel = vec3( uWind.x, -speed, uWind.z );

  // Density is a fraction of the instance pool, keyed off a per-drop constant so
  // drops appear and disappear at the edges of the field rather than all at once.
  if ( aSeed.w > uAmount ) { gl_Position = vec4( 2.0, 2.0, 2.0, 1.0 ); return; }

  vec3 p = aSeed.xyz * uBox + vel * uTime;
  // Wrap into a box that follows the camera. The jump is a whole box side, so
  // it always happens outside the near fade and is never visible.
  vec3 rel = p - uCamPos;
  rel = mod( rel + 0.5 * uBox, uBox ) - 0.5 * uBox;
  vec3 world = uCamPos + rel;

  vec4 vp = viewMatrix * vec4( world, 1.0 );
  // The streak is the drop convolved with the shutter: a segment along the
  // velocity, in VIEW space, so it is correctly foreshortened when it falls
  // toward or away from the camera.
  vec3 vv = normalize( ( viewMatrix * vec4( vel, 0.0 ) ).xyz );
  vec3 side = normalize( cross( vv, vec3( 0.0, 0.0, 1.0 ) ) + vec3( 1.0e-5, 0.0, 0.0 ) );

  float len = uSize.y * speed;
  float halfW = uSize.x * ( 0.7 + 0.6 * fract( aSeed.w * 37.0 ) );
  vp.xyz += vv * ( position.y * len ) + side * ( position.x * halfW );

  float dist = length( rel );
  vFade = smoothstep( uNear, uNear * 3.0, dist ) * ( 1.0 - smoothstep( 0.34 * uBox, 0.5 * uBox, dist ) );
  vUv = uv;
  gl_Position = projectionMatrix * vp;
}
`;

const STREAK_FRAG = /* glsl */ `
precision highp float;
in vec2 vUv;
in float vFade;
uniform vec3 uColor;
uniform float uOpacity;
layout(location = 0) out vec4 fragColor;

void main() {
  // Soft round-ended capsule. A hard-edged quad is a scratch on the lens.
  float x = vUv.x * 2.0 - 1.0;
  float y = vUv.y * 2.0 - 1.0;
  float core = ( 1.0 - x * x ) * ( 1.0 - y * y * y * y );
  if ( core <= 0.0 ) discard;
  float a = core * uOpacity * vFade;
  if ( a <= 0.002 ) discard;
  fragColor = vec4( uColor * a, a );
}
`;

/**
 * Splash layer. One instanced quad lying flat on the ground per live splash,
 * carrying BOTH the crown (a short-lived vertical burst of droplets) and the
 * ripple (an expanding ring) — two sprites in one draw, separated in the
 * fragment shader by the age.
 */
const SPLASH_VERT = /* glsl */ `
precision highp float;
in vec3 position;
in vec2 uv;
in vec4 aSplash;   // xyz world position, w spawn time
in vec2 aSplash2;  // x seed, y scale (1 = rain splash, >1 = vehicle spray)

uniform mat4 projectionMatrix;
uniform mat4 viewMatrix;
uniform float uTime;
uniform float uLife;

out vec2 vUv;
out float vAge;
out float vSeed;

void main() {
  float age = ( uTime - aSplash.w ) / uLife;
  if ( age < 0.0 || age > 1.0 ) { gl_Position = vec4( 2.0, 2.0, 2.0, 1.0 ); return; }
  // Ripples spread as sqrt(t) — surface gravity waves on shallow water do, and
  // a linear expansion is instantly readable as an animated decal.
  float r = ( 0.10 + 0.52 * sqrt( age ) ) * aSplash2.y;
  vec3 world = aSplash.xyz + vec3( position.x * r, 0.012, position.y * r );
  vUv = uv;
  vAge = age;
  vSeed = aSplash2.x;
  gl_Position = projectionMatrix * viewMatrix * vec4( world, 1.0 );
}
`;

const SPLASH_FRAG = /* glsl */ `
precision highp float;
in vec2 vUv;
in float vAge;
in float vSeed;
uniform vec3 uColor;
uniform float uOpacity;
layout(location = 0) out vec4 fragColor;

float hash11( float p ) { p = fract( p * 0.1031 ); p *= p + 33.33; return fract( p * ( p + p ) ); }

void main() {
  vec2 d = vUv * 2.0 - 1.0;
  float r = length( d );
  if ( r > 1.0 ) discard;

  // Ring: a thin annulus that widens and softens as it travels out.
  float w = 0.12 + 0.30 * vAge;
  float ring = exp( -pow( ( r - 1.0 + w * 0.5 ) / w, 2.0 ) );

  // Crown: a spiky burst of droplets in the first fifth of the life, thrown
  // outward. Eight lobes with a per-splash phase so no two are identical.
  float ang = atan( d.y, d.x );
  float lobes = 0.5 + 0.5 * cos( ang * 8.0 + vSeed * 24.0 );
  float crownAge = 1.0 - smoothstep( 0.0, 0.22, vAge );
  float crown = crownAge * lobes * exp( -pow( ( r - 0.34 ) / 0.24, 2.0 ) );

  float a = ( ring * 0.72 + crown * 1.15 ) * uOpacity * ( 1.0 - vAge ) * ( 1.0 - vAge );
  if ( a <= 0.003 ) discard;
  fragColor = vec4( uColor * a, a );
}
`;

function quadGeometry() {
  const g = new THREE.InstancedBufferGeometry();
  g.setAttribute(
    'position',
    new THREE.BufferAttribute(
      new Float32Array([-1, -1, 0, 1, -1, 0, 1, 1, 0, -1, 1, 0]),
      3
    )
  );
  g.setAttribute(
    'uv',
    new THREE.BufferAttribute(new Float32Array([0, 0, 1, 0, 1, 1, 0, 1]), 2)
  );
  g.setIndex([0, 1, 2, 0, 2, 3]);
  return g;
}

export class RainSystem {
  /**
   * @param {object} ctx    engine context
   * @param {object} opts   { streaks, splashes, drips }
   */
  constructor(ctx, opts = {}) {
    this.ctx = ctx;
    this.rng = ctx.rng.fork();
    const budget = ctx.config.q.particleBudget ?? 6000;

    // Budgets are a fraction of the particle budget so the quality scaler moves
    // the rain with everything else. Rain is the headline effect at ultra and
    // has to still be legible at low, so the floor is generous.
    this.streakCount = Math.max(900, Math.min(opts.streaks ?? 9000, Math.round(budget * 0.62)));
    this.splashCount = Math.max(120, Math.min(opts.splashes ?? 900, Math.round(budget * 0.14)));
    this.dripCount = Math.max(48, Math.min(opts.drips ?? 260, Math.round(budget * 0.04)));

    this.group = new THREE.Group();
    this.group.name = 'sky-rain';
    this.group.matrixAutoUpdate = false;
    this.group.frustumCulled = false;

    this.rain = 0;
    this.wetness = 0;
    this._time = 0;
    this._wind = new THREE.Vector3();
    this._tmp = new THREE.Vector3();
    this._splashCursor = 0;
    this._dripCursor = 0;
    this._splashAccum = 0;
    this._dripAccum = 0;
    this._rayOrigin = new THREE.Vector3();
    this._rayDir = new THREE.Vector3(0, 1, 0);
    /** Ledge points found by upward raycasts; drips fall from these. */
    this._ledges = new Float32Array(64 * 3);
    this._ledgeCount = 0;
    this._ledgeCursor = 0;
    this._ledgeScanAccum = 0;

    this._buildStreaks();
    this._buildSplashes();
    this._buildDrips();
  }

  // ------------------------------------------------------------- build -----

  _buildStreaks() {
    const g = quadGeometry();
    const n = this.streakCount;
    const seed = new Float32Array(n * 4);
    for (let i = 0; i < n; i++) {
      seed[i * 4 + 0] = this.rng.float();
      seed[i * 4 + 1] = this.rng.float();
      seed[i * 4 + 2] = this.rng.float();
      seed[i * 4 + 3] = this.rng.float();
    }
    g.setAttribute('aSeed', new THREE.InstancedBufferAttribute(seed, 4));
    g.instanceCount = n;
    g.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e6);

    this.streakMat = new THREE.RawShaderMaterial({
      name: 'sky-rain-streak',
      glslVersion: THREE.GLSL3,
      vertexShader: `#define FALL_SPEED ${FALL_SPEED.toFixed(1)}\n${STREAK_VERT}`,
      fragmentShader: STREAK_FRAG,
      uniforms: {
        uCamPos: { value: new THREE.Vector3() },
        uWind: { value: new THREE.Vector3() },
        uTime: { value: 0 },
        // 20 m, not 34. The box is a DENSITY control: the same instance count in
        // a box of half the side is eight times the drops per cubic metre, and
        // sparse rain is the difference between weather and a scratched lens.
        // Everything past 20 m is too small to resolve anyway, which is why real
        // rain photographs as a wall near the camera and nothing at distance.
        uBox: { value: 20 },
        uAmount: { value: 0 },
        uSize: { value: new THREE.Vector2(0.008, 0.016) },
        // 1.3 m. A drop half a metre from the lens covers a hundred pixels and
        // reads as a smear on the glass, not as rain — and there is only ever one
        // of them, so it is a distraction with no statistical company.
        uNear: { value: 1.3 },
        uColor: { value: new THREE.Color(0.6, 0.68, 0.8) },
        uOpacity: { value: 0.20 },
      },
      transparent: true,
      depthWrite: false,
      depthTest: true,
      // Premultiplied: the fragment shader already multiplies by alpha, which
      // keeps the edge of a soft streak from darkening what is behind it.
      blending: THREE.CustomBlending,
      blendSrc: THREE.OneFactor,
      blendDst: THREE.OneMinusSrcAlphaFactor,
      side: THREE.DoubleSide,
    });

    this.streaks = new THREE.Mesh(g, this.streakMat);
    this.streaks.name = 'sky-rain-streaks';
    this.streaks.frustumCulled = false;
    this.streaks.renderOrder = 3000;
    this.streaks.matrixAutoUpdate = false;
    this.streaks.userData.owNoPrepass = true;
    this.streaks.userData.owNoShadow = true;
    this.streaks.visible = false;
    this.group.add(this.streaks);
  }

  _splashMesh(count, name, life, order) {
    const g = quadGeometry();
    const a = new Float32Array(count * 4);
    const b = new Float32Array(count * 2);
    // Park every slot far in the past so nothing draws until it is spawned.
    for (let i = 0; i < count; i++) a[i * 4 + 3] = -1e6;
    const attrA = new THREE.InstancedBufferAttribute(a, 4);
    const attrB = new THREE.InstancedBufferAttribute(b, 2);
    attrA.setUsage(THREE.DynamicDrawUsage);
    attrB.setUsage(THREE.DynamicDrawUsage);
    g.setAttribute('aSplash', attrA);
    g.setAttribute('aSplash2', attrB);
    g.instanceCount = count;
    g.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e6);

    const mat = new THREE.RawShaderMaterial({
      name,
      glslVersion: THREE.GLSL3,
      vertexShader: SPLASH_VERT,
      fragmentShader: SPLASH_FRAG,
      uniforms: {
        uTime: { value: 0 },
        uLife: { value: life },
        uColor: { value: new THREE.Color(0.7, 0.78, 0.9) },
        uOpacity: { value: 0.5 },
      },
      transparent: true,
      depthWrite: false,
      blending: THREE.CustomBlending,
      blendSrc: THREE.OneFactor,
      blendDst: THREE.OneMinusSrcAlphaFactor,
      side: THREE.DoubleSide,
    });

    const mesh = new THREE.Mesh(g, mat);
    mesh.name = name;
    mesh.frustumCulled = false;
    mesh.renderOrder = order;
    mesh.matrixAutoUpdate = false;
    mesh.userData.owNoPrepass = true;
    mesh.userData.owNoShadow = true;
    mesh.visible = false;
    this.group.add(mesh);
    return { mesh, mat, a, b, attrA, attrB, count };
  }

  _buildSplashes() {
    this.splash = this._splashMesh(this.splashCount, 'sky-rain-splash', 0.52, 2999);
  }

  _buildDrips() {
    // Drips reuse the streak shader with a slower fall and CPU-placed origins,
    // so they hang off the ledge they were found on rather than falling through
    // the whole box.
    const g = quadGeometry();
    const n = this.dripCount;
    const seed = new Float32Array(n * 4);
    const attr = new THREE.InstancedBufferAttribute(seed, 4);
    attr.setUsage(THREE.DynamicDrawUsage);
    for (let i = 0; i < n; i++) seed[i * 4 + 3] = -1;
    g.setAttribute('aDrip', attr);
    g.instanceCount = n;
    g.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e6);

    const DRIP_VERT = /* glsl */ `
precision highp float;
in vec3 position;
in vec2 uv;
in vec4 aDrip;   // xyz ledge point, w spawn time (<0 = dead)
uniform mat4 projectionMatrix;
uniform mat4 viewMatrix;
uniform float uTime;
uniform float uLife;
uniform vec2 uSize;
out vec2 vUv;
out float vFade;
void main() {
  float age = uTime - aDrip.w;
  if ( aDrip.w < 0.0 || age < 0.0 || age > uLife ) { gl_Position = vec4( 2.0, 2.0, 2.0, 1.0 ); return; }
  // A drip leaves the ledge from rest and accelerates: the streak lengthens as
  // it falls, which is most of what makes it read as a drip and not a dash.
  float g = 9.81;
  float fall = 0.5 * g * age * age;
  float speed = g * age;
  vec3 world = aDrip.xyz - vec3( 0.0, fall, 0.0 );
  vec4 vp = viewMatrix * vec4( world, 1.0 );
  vec3 vv = normalize( ( viewMatrix * vec4( 0.0, -1.0, 0.0, 0.0 ) ).xyz );
  vec3 side = normalize( cross( vv, vec3( 0.0, 0.0, 1.0 ) ) + vec3( 1.0e-5, 0.0, 0.0 ) );
  vp.xyz += vv * ( position.y * uSize.y * max( speed, 1.2 ) ) + side * ( position.x * uSize.x );
  vUv = uv;
  vFade = 1.0 - smoothstep( 0.65, 1.0, age / uLife );
  gl_Position = projectionMatrix * vp;
}
`;
    this.dripMat = new THREE.RawShaderMaterial({
      name: 'sky-rain-drip',
      glslVersion: THREE.GLSL3,
      vertexShader: DRIP_VERT,
      fragmentShader: STREAK_FRAG,
      uniforms: {
        uTime: { value: 0 },
        uLife: { value: 1.1 },
        uSize: { value: new THREE.Vector2(0.016, 0.020) },
        uColor: { value: new THREE.Color(0.7, 0.78, 0.9) },
        uOpacity: { value: 0.75 },
      },
      transparent: true,
      depthWrite: false,
      blending: THREE.CustomBlending,
      blendSrc: THREE.OneFactor,
      blendDst: THREE.OneMinusSrcAlphaFactor,
      side: THREE.DoubleSide,
    });
    this.drips = new THREE.Mesh(g, this.dripMat);
    this.drips.name = 'sky-rain-drips';
    this.drips.frustumCulled = false;
    this.drips.renderOrder = 3001;
    this.drips.matrixAutoUpdate = false;
    this.drips.userData.owNoPrepass = true;
    this.drips.userData.owNoShadow = true;
    this.drips.visible = false;
    this.group.add(this.drips);
    this._dripData = seed;
    this._dripAttr = attr;
  }

  // ------------------------------------------------------------- runtime ---

  /**
   * @param rain     0..1 precipitation rate
   * @param wetness  0..1 surface wetness (drives the ledge drips after the rain)
   * @param wind     THREE.Vector3, m/s horizontal
   * @param ambient  THREE.Color, whole-sky irradiance — the streaks take their
   *                 colour from it, which is what stops them being white lines
   * @param key      THREE.Color * intensity of the sun/moon
   */
  setConditions(rain, wetness, wind, ambient, key) {
    this.rain = rain;
    this.wetness = wetness;
    this._wind.copy(wind);

    const on = rain > 0.004;
    this.streaks.visible = on;
    this.splash.mesh.visible = on || wetness > 0.05;
    this.drips.visible = wetness > 0.02;

    const su = this.streakMat.uniforms;
    su.uWind.value.copy(wind);
    su.uAmount.value = Math.pow(THREE.MathUtils.clamp(rain, 0, 1), 0.72);
    // Heavier rain is not just more drops, it is FATTER drops and a longer
    // shutter smear. Both scale, which is what makes a storm feel different
    // from a drizzle rather than merely busier.
    su.uSize.value.set(0.0045 + 0.0035 * rain, 0.012 + 0.010 * rain);
    // A drop is a LENS, not a light. Individually it is barely visible; what you
    // see is thousands of them at once. Opacity this low is what makes the
    // difference between rain and a field of white scratches — the density does
    // the work, and the streaks that read are the ones that happen to overlap.
    su.uOpacity.value = 0.17 + 0.26 * rain;

    // A raindrop is a lens: it scatters the light around it. Sky ambient sets
    // the base, and a slice of the key gives the drops that catch the sun their
    // glint. Both are already in scene radiance units, so rain over a bright
    // overcast is close to invisible against the sky and blazes against a wall —
    // which is what rain does.
    /**
     * DIVIDE BY PI. `ambient` is sky.ambientColor, which is an ILLUMINANCE in
     * scene light units — the sky's irradiance onto a horizontal surface — and
     * what a streak needs is a RADIANCE. Using one as the other put the drops a
     * factor of three over the sky they were falling through, which is precisely
     * the "white lines over a dry scene" failure this file exists to avoid.
     * 0.42/pi: a drop scatters a good fraction of what hits it, but it is a
     * sphere of water, not a mirror.
     */
    const gain = 0.42 / Math.PI;
    const r = ambient.r * gain + key.r * 0.05;
    const g = ambient.g * gain + key.g * 0.05;
    const b = ambient.b * gain + key.b * 0.05;
    su.uColor.value.setRGB(r, g, b * 1.06);
    this.splash.mat.uniforms.uColor.value.setRGB(r * 1.6, g * 1.6, b * 1.7);
    this.splash.mat.uniforms.uOpacity.value = 0.42 + 0.45 * rain;
    this.dripMat.uniforms.uColor.value.setRGB(r * 1.1, g * 1.1, b * 1.15);
  }

  update(dt, camera) {
    this._time += dt;
    this.streakMat.uniforms.uTime.value = this._time;
    this.streakMat.uniforms.uCamPos.value.copy(camera.position);
    this.splash.mat.uniforms.uTime.value = this._time;
    this.dripMat.uniforms.uTime.value = this._time;

    if (this.splash.mesh.visible) this._spawnSplashes(dt, camera);
    if (this.drips.visible) this._spawnDrips(dt, camera);
  }

  /**
   * Splashes land on the actual ground. The height query goes to physics first
   * (exact, and knows about rooftops and bridges), then the world's analytic
   * floor, then zero. Spawns are amortised: a fixed slice of the ring per frame,
   * so a downpour costs the same upload as a drizzle.
   */
  _spawnSplashes(dt, camera) {
    const rate = 26 + 340 * this.rain * this.rain;
    this._splashAccum += rate * dt;
    let n = Math.min(this.splash.count >> 2, this._splashAccum | 0);
    if (n <= 0) return;
    this._splashAccum -= n;

    const phys = this.ctx.peek('physics');
    const world = this.ctx.peek('world');
    const a = this.splash.a;
    const b = this.splash.b;
    const cx = camera.position.x;
    const cy = camera.position.y;
    const cz = camera.position.z;
    let lo = this._splashCursor;
    let hi = this._splashCursor;

    for (let i = 0; i < n; i++) {
      const idx = this._splashCursor;
      this._splashCursor = (this._splashCursor + 1) % this.splash.count;
      hi = idx;
      // Radially biased toward the camera: splashes past 15 m are sub-pixel.
      const ang = this.rng.float() * Math.PI * 2;
      const rad = 1.2 + 13.0 * Math.sqrt(this.rng.float());
      const x = cx + Math.cos(ang) * rad;
      const z = cz + Math.sin(ang) * rad;

      let y = 0;
      if (phys?.groundHeight) {
        y = phys.groundHeight(x, z, cy + 2.2);
        if (!Number.isFinite(y)) y = world?.groundHeight?.(x, z) ?? 0;
      } else if (world?.heightAt) y = world.heightAt(x, z);
      else if (world?.groundHeight) y = world.groundHeight(x, z);

      a[idx * 4 + 0] = x;
      a[idx * 4 + 1] = y;
      a[idx * 4 + 2] = z;
      a[idx * 4 + 3] = this._time;
      b[idx * 2 + 0] = this.rng.float();
      b[idx * 2 + 1] = 0.8 + 0.5 * this.rng.float();
    }

    // Upload only the touched range; a wrapped range costs one extra call.
    if (hi >= lo) this._uploadRange(this.splash, lo, hi);
    else {
      this._uploadRange(this.splash, lo, this.splash.count - 1);
      this._uploadRange(this.splash, 0, hi);
    }
  }

  _uploadRange(layer, lo, hi) {
    layer.attrA.addUpdateRange(lo * 4, (hi - lo + 1) * 4);
    layer.attrB.addUpdateRange(lo * 2, (hi - lo + 1) * 2);
    layer.attrA.needsUpdate = true;
    layer.attrB.needsUpdate = true;
  }

  /**
   * Ledge drips. Finding a ledge is an upward raycast: if there is geometry over
   * a point near the camera, its underside drips. Two casts a frame, so this
   * costs nothing and the set of ledges refreshes over a few seconds as the
   * player moves.
   */
  _spawnDrips(dt, camera) {
    const phys = this.ctx.peek('physics');
    if (phys?.raycast) {
      this._ledgeScanAccum += dt;
      while (this._ledgeScanAccum > 0.05) {
        this._ledgeScanAccum -= 0.05;
        const ang = this.rng.float() * Math.PI * 2;
        const rad = 2.0 + 10.0 * this.rng.float();
        this._rayOrigin.set(
          camera.position.x + Math.cos(ang) * rad,
          camera.position.y - 0.4,
          camera.position.z + Math.sin(ang) * rad
        );
        this._rayDir.set(0, 1, 0);
        const hit = phys.raycast(this._rayOrigin, this._rayDir, 14);
        if (hit?.hit) {
          const i = this._ledgeCursor % 64;
          this._ledges[i * 3 + 0] = hit.point.x;
          this._ledges[i * 3 + 1] = hit.point.y - 0.06;
          this._ledges[i * 3 + 2] = hit.point.z;
          this._ledgeCursor++;
          this._ledgeCount = Math.min(64, this._ledgeCursor);
        }
      }
    }
    if (this._ledgeCount === 0) return;

    // Drip rate follows the WETNESS, not the rain: a ledge keeps dripping for
    // minutes after a shower, and that lag is most of what sells a wet city.
    const rate = 16 * this.wetness * this.wetness + 24 * this.rain;
    this._dripAccum += rate * dt;
    let n = Math.min(8, this._dripAccum | 0);
    if (n <= 0) return;
    this._dripAccum -= n;

    const d = this._dripData;
    let lo = this._dripCursor;
    let hi = this._dripCursor;
    for (let i = 0; i < n; i++) {
      const idx = this._dripCursor;
      this._dripCursor = (this._dripCursor + 1) % this.dripCount;
      hi = idx;
      const l = (this.rng.u32() % this._ledgeCount) * 3;
      d[idx * 4 + 0] = this._ledges[l] + this.rng.signed() * 0.25;
      d[idx * 4 + 1] = this._ledges[l + 1];
      d[idx * 4 + 2] = this._ledges[l + 2] + this.rng.signed() * 0.25;
      d[idx * 4 + 3] = this._time;
    }
    if (hi >= lo) this._dripAttr.addUpdateRange(lo * 4, (hi - lo + 1) * 4);
    else {
      this._dripAttr.addUpdateRange(lo * 4, (this.dripCount - lo) * 4);
      this._dripAttr.addUpdateRange(0, (hi + 1) * 4);
    }
    this._dripAttr.needsUpdate = true;
  }

  /**
   * Spray thrown off a wheel. Public so `vehicles` can drive it directly; the
   * sky also scans any vehicle list it can find (see SkySystem._updateSpray).
   * Reuses the splash ring at a larger scale and a lifted origin.
   */
  spray(x, y, z, strength) {
    if (this.wetness < 0.06 || strength <= 0) return;
    const a = this.splash.a;
    const b = this.splash.b;
    const n = Math.min(4, 1 + (strength * 3) | 0);
    let lo = this._splashCursor;
    let hi = this._splashCursor;
    for (let i = 0; i < n; i++) {
      const idx = this._splashCursor;
      this._splashCursor = (this._splashCursor + 1) % this.splash.count;
      hi = idx;
      a[idx * 4 + 0] = x + this.rng.signed() * 0.5;
      a[idx * 4 + 1] = y + 0.02;
      a[idx * 4 + 2] = z + this.rng.signed() * 0.5;
      a[idx * 4 + 3] = this._time;
      b[idx * 2 + 0] = this.rng.float();
      b[idx * 2 + 1] = 1.8 + 2.6 * strength;
    }
    if (hi >= lo) this._uploadRange(this.splash, lo, hi);
    else {
      this._uploadRange(this.splash, lo, this.splash.count - 1);
      this._uploadRange(this.splash, 0, hi);
    }
  }

  dispose() {
    this.streaks.geometry.dispose();
    this.streakMat.dispose();
    this.splash.mesh.geometry.dispose();
    this.splash.mat.dispose();
    this.drips.geometry.dispose();
    this.dripMat.dispose();
  }
}
