import * as THREE from 'three';
import { WET_UNIFORMS } from './wetness.js';

/**
 * THE RIVER.
 *
 * Three rivers meet at The Point and they are a third of the map, so the water
 * surface is a first-class material, not a blue plane with a normal map on it.
 *
 * What it does:
 *
 *  - TWO SCALES OF FLOW. A large, slow normal map carries the swell and a fine,
 *    fast one carries the chop, each scrolling along the flow vector at its own
 *    rate and with a second counter-scrolling sample so the pattern never reads
 *    as a conveyor belt. Two scales is the minimum: one scale always looks like
 *    a scrolling texture, three costs more than it returns.
 *
 *  - DEPTH ABSORPTION, and these rivers are SILTY. The Mon is not the Caribbean:
 *    light is extinguished within a metre or two, and what comes back is a
 *    green-brown scatter off suspended sediment, not a blue transmission. The
 *    water column thickness comes from `render.depthTexture` (linear view depth
 *    in metres) minus the surface's own depth, so it is exact at the banks, at
 *    every bridge pier and around every hull.
 *
 *  - FOAM WHERE THE WATER IS SHALLOW OR DISTURBED. The same thickness term
 *    gives shoreline foam and the collar around a pier for free; wakes add
 *    their own. Foam is a real material change — near-white, rough, opaque —
 *    not a white tint.
 *
 *  - A WAKE INTERFACE for `vehicles`. `water.addWake(x, z, strength, radius)`
 *    per frame per hull; the shader turns each into an expanding ring in the
 *    normal plus a foam collar that decays.
 *
 * Public surface (reach it with `ctx.get('materials').water()`):
 *
 *   const w = materials.water();          // -> THREE.Material
 *   w.userData.owWater.addWake(x, z, strength, radius)
 *   w.userData.owWater.setFlow(dx, dz, speed)
 *   w.userData.owWater.setTurbidity(t)    // 0 clear .. 1 spring runoff
 *   w.userData.owWater.uniforms           // for anything else
 */

/** Wake slots. Twelve is enough for the player, traffic boats and a splash. */
export const MAX_WAKES = 12;

const PARS = /* glsl */ `
varying vec3 vOwWPos;

uniform sampler2D owFlowNrm;
uniform sampler2D owFoamTex;
uniform sampler2D owSceneDepth;
uniform vec4  owFlow;        // xy = flow direction, z = speed, w = time
uniform vec4  owWaveP;       // x = big scale, y = small scale, z = big amp, w = small amp
uniform vec4  owDeepP;       // xyz = absorption per metre, w = turbidity 0..1
uniform vec3  owShallowCol;  // the silt scatter colour
uniform vec3  owDeepCol;     // what a deep, still channel returns
uniform vec4  owFoamP;       // x = shore width m, y = foam scale, z = amount, w = depth fade m
uniform vec4  owScreen;      // xy = 1/size, z = depth texture valid, w = unused
uniform vec4  owWakes[ ${MAX_WAKES} ];   // xy = world xz, z = radius, w = strength
uniform int   owWakeCount;

/** Two counter-scrolling samples of one tiling normal map = no visible drift. */
vec3 owFlowSample( vec2 uv, vec2 dir, float t, float rate ){
  vec2 a = uv - dir * ( t * rate );
  vec2 b = uv * 0.83 + vec2( 0.37, 0.19 ) - dir * ( t * rate * 0.61 ) + dir.yx * ( t * rate * 0.24 );
  vec3 na = texture2D( owFlowNrm, a ).xyz * 2.0 - 1.0;
  vec3 nb = texture2D( owFlowNrm, b ).xyz * 2.0 - 1.0;
  return na + nb * 0.72;
}
`;

const VERT_MAIN = /* glsl */ `
  vOwWPos = ( modelMatrix * vec4( transformed, 1.0 ) ).xyz;
`;

const FRAG_MAIN = /* glsl */ `
{
  vec2 dir = normalize( owFlow.xy + vec2( 1e-4, 0.0 ) );
  float t = owFlow.w;
  float spd = owFlow.z;

  // ---- two scales of moving surface --------------------------------------
  // The fine chop is a 4 m tile, so past about 40 m it is well under a pixel
  // and every wave crest becomes an independent specular sample: water is the
  // worst aliasing case in any open-world renderer. Damping the fine amplitude
  // with distance converts that sparkle into the smooth sheen a real river has
  // at range, and it costs one smoothstep.
  float owWDist = length( vViewPosition );
  float chopFade = 1.0 - smoothstep( 18.0, 90.0, owWDist ) * 0.85;
  vec3 nBig = owFlowSample( vOwWPos.xz * owWaveP.x, dir, t, spd * 0.055 ) * owWaveP.z;
  vec3 nSml = owFlowSample( vOwWPos.xz * owWaveP.y, dir, t, spd * 0.16 ) * ( owWaveP.w * chopFade );
  vec3 nW = normalize( vec3( nBig.xy + nSml.xy, 1.0 ) );

  // ---- wakes -------------------------------------------------------------
  // Each source is an expanding ring in the normal plus a decaying foam collar.
  // A hull pushing water is the single most-watched surface in a boat mission,
  // so the ring has to have a real profile, not a bump.
  float wakeFoam = 0.0;
  for ( int i = 0; i < ${MAX_WAKES}; i ++ ) {
    if ( i >= owWakeCount ) break;
    vec4 wk = owWakes[ i ];
    if ( wk.w <= 0.001 ) continue;
    vec2 d2 = vOwWPos.xz - wk.xy;
    float d = length( d2 );
    float rr = max( wk.z, 0.05 );
    float band = ( d - rr ) / rr;
    float ring = sin( band * 9.0 ) * exp( -abs( band ) * 3.2 );
    nW.xy += ( d2 / max( d, 1e-3 ) ) * ring * wk.w * 0.55;
    // the churned collar just inside the ring
    wakeFoam += wk.w * ( 1.0 - smoothstep( 0.0, 1.0, abs( band ) * 3.0 ) ) * 0.55;
  }
  nW = normalize( nW );

  // nW is built in WORLD space (the flow, the wakes and the swell are all world
  // quantities), so it needs the world->view rotation, not the object normal
  // matrix. normalMatrix is a VERTEX-STAGE uniform and does not exist in a
  // fragment shader at all -- three declares viewMatrix here and not that, so
  // the first version of this line failed to compile and the river rendered as
  // a flat dark plane. mat3(viewMatrix) is also correct for a transformed or
  // instanced water mesh, which normalMatrix would not have been.
  vec3 nView = normalize( mat3( viewMatrix ) * nW );
  // Keep the shading normal on the visible side of the surface, or the water
  // flips to black wherever a big wave slope crosses the horizon.
  if ( nView.z < 0.05 ) nView = normalize( vec3( nView.xy, 0.05 ) );

  // ---- water column ------------------------------------------------------
  vec2 sUv = gl_FragCoord.xy * owScreen.xy;
  float ownDepth = vViewPosition.z;
  float sceneDepth = ownDepth + 12.0;                 // fallback: deep water
  if ( owScreen.z > 0.5 ) {
    sceneDepth = texture2D( owSceneDepth, sUv ).r;
    // A depth of 0 means nothing was written there (sky); treat it as deep.
    if ( sceneDepth <= ownDepth ) sceneDepth = ownDepth + 12.0;
  }
  float thick = max( sceneDepth - ownDepth, 0.0 );

  // Beer-Lambert through silty water. These coefficients are deliberately
  // brutal: 1.5 m of the Monongahela in April extinguishes essentially
  // everything, so the colour that comes back is the SCATTER off the sediment,
  // not the transmission of what is underneath.
  float turb = clamp( owDeepP.w, 0.0, 1.0 );
  vec3 sigma = owDeepP.xyz * mix( 0.55, 1.9, turb );
  vec3 trans = exp( -sigma * thick );
  // Shallow water shows the silt bed through a thin column; deep water is the
  // channel's own colour. The crossover is about a metre.
  vec3 body = mix( owDeepCol, owShallowCol, trans.g );

  // ---- foam --------------------------------------------------------------
  // Shoreline, pier collar, and anything a hull has stirred. Foam scrolls with
  // the flow at a slower rate than the surface, because it is floating ON it.
  vec2 fUv = vOwWPos.xz * owFoamP.y - dir * ( t * spd * 0.045 );
  vec4 fTex = texture2D( owFoamTex, fUv );
  vec4 fTex2 = texture2D( owFoamTex, fUv * 0.47 + vec2( 0.21, 0.63 ) - dir * ( t * spd * 0.02 ) );
  float fMask = fTex.a * 0.62 + fTex2.a * 0.48;
  float shore = 1.0 - smoothstep( 0.0, max( owFoamP.x, 0.02 ), thick );
  // the band right at the water line is nearly solid; it thins outward fast
  shore = shore * shore * ( 0.40 + 0.85 * fMask );
  float foam = clamp( ( shore + wakeFoam * ( 0.35 + 0.95 * fMask ) ) * owFoamP.z, 0.0, 1.0 );
  // Foam is a HARD-EDGED raft, not a gradient: it either is there or it is
  // not, and the ragged boundary is most of what makes it read as foam.
  foam = smoothstep( 0.34, 0.72, foam );

  vec3 foamCol = vec3( 0.74, 0.755, 0.745 ) * ( 0.72 + 0.42 * fTex.r );
  // Real river foam is not white — it is grey-tan, because it is full of the
  // same silt as the water and a good deal of what the mills left behind.
  foamCol = mix( foamCol, vec3( 0.52, 0.505, 0.462 ), 0.35 * turb );

  vec3 albedoOut = mix( body, foamCol, foam );
  float roughOut = mix( owWaveP.w > 0.0 ? 0.055 : 0.04, 0.82, foam );
  // Chop roughens the surface at a scale finer than the normal map can carry.
  roughOut += ( 1.0 - foam ) * length( nSml.xy ) * 0.05;
  // Sub-pixel chop does not vanish, it becomes roughness.
  roughOut += ( 1.0 - foam ) * ( 1.0 - chopFade ) * 0.16;

  diffuseColor.rgb = albedoOut;
  owWaterFoam = foam;
  owWaterNormal = nView;
  owWaterRough = roughOut;
  // The foam is opaque; clear water is not, but this river is silty enough that
  // it may as well be, and an opaque surface keeps it out of the sorted pass.
  diffuseColor.a = 1.0;
}
`;

const WATER_NORMAL_GLSL = /* glsl */ `
void owSurface(vec2 uv, out vec3 alb, out float h, out float rough, out float metal, out float ao){
  const vec2 P = vec2(8.0);
  vec2 p = uv * P;

  // A river surface is not a sine field. It is a few long gravity waves running
  // with the current, a cross-hatch where the flow shears past the bank, and a
  // dense capillary ripple on top of everything that is what actually catches
  // the sky. Three bands, all periodic, all sheared along the flow axis.
  float swell = 0.0;
  swell += sin((p.y * 0.75 + owFbm(p * 0.5, P * 0.5, 3, 0.6) * 1.6) * 6.28318) * 0.55;
  swell += sin((p.y * 1.25 - p.x * 0.35 + owFbm(p * 0.8 + 3.0, P * 0.8, 3, 0.6) * 1.2) * 6.28318) * 0.35;
  // Sharpened crests, rounded troughs: a real wave profile, not a sinusoid.
  swell = swell * 0.5 + 0.5;
  swell = pow(clamp(swell, 0.0, 1.0), 1.35);

  float cross1 = owFbm01(owShear(p * 3.0, 1.0, 2.4), owShearPer(P * 3.0, 2.4), 4, 0.55);
  float cross2 = owFbm01(owShear(p * 5.5 + 7.0, -1.0, 2.0), owShearPer(P * 5.5, 2.0), 4, 0.52);
  float cap = owFbm01(p * 13.0, P * 13.0, 4, 0.5);
  float cap2 = owFbm01(p * 21.0 + 5.0, P * 21.0, 3, 0.5);

  h = 0.50
    + (swell - 0.5) * 0.44
    + (cross1 - 0.5) * 0.26
    + (cross2 - 0.5) * 0.16
    + (cap - 0.5) * 0.12
    + (cap2 - 0.5) * 0.055;

  alb = vec3(0.5);
  rough = 0.5;
  metal = 0.0;
  ao = 1.0;
  h = clamp(h, 0.0, 1.0);
}
`;

const FOAM_GLSL = /* glsl */ `
void owSurface(vec2 uv, out vec3 alb, out float h, out float rough, out float metal, out float ao){
  const vec2 P = vec2(8.0);
  vec2 p = uv * P + uSeed * 3.1;

  // Foam is a raft of bubbles of wildly different sizes with clear water
  // between them, torn into streaks by the current. Three worley grades give
  // the bubble structure; a sheared fbm tears it into the flow direction.
  vec4 b1 = owWorley(owWarp(p * 5.0, P * 5.0, 0.35, 3), P * 5.0, 1.0);
  vec4 b2 = owWorley(owWarp(p * 11.0 + 3.0, P * 11.0, 0.25, 3), P * 11.0, 1.0);
  vec4 b3 = owWorley(p * 20.0 + 7.0, P * 20.0, 1.0);
  float m1 = smoothstep(0.34, 0.06, b1.x) * step(0.30, b1.w);
  float m2 = smoothstep(0.30, 0.05, b2.x) * step(0.24, b2.w);
  float m3 = smoothstep(0.26, 0.04, b3.x) * step(0.42, b3.z);

  float tear = owFbm01(owShear(p * 2.2, 1.0, 4.0), owShearPer(P * 2.2, 4.0), 5, 0.58);
  float raft = owFbm01(owWarp(p * 1.1, P * 1.1, 0.8, 3), P * 1.1, 4, 0.6);

  float mask = clamp((m1 * 0.85 + m2 * 0.55 + m3 * 0.35) * (0.30 + 1.05 * smoothstep(0.28, 0.78, tear * 0.55 + raft * 0.6)), 0.0, 1.0);
  mask = smoothstep(0.10, 0.62, mask);

  // Bubble crowns catch the sky and their meniscus rings are darker.
  float crown = m1 * 0.6 + m2 * 0.4 + m3 * 0.3;
  alb = vec3(0.55 + 0.45 * crown);
  h = mask;
  rough = 0.5;
  metal = 0.0;
  ao = 1.0 - (1.0 - crown) * 0.2;
}
`;

/** Bake definitions the MaterialSystem hands to the forge. */
export const WATER_BAKES = {
  water_normal: {
    glsl: WATER_NORMAL_GLSL,
    // 6 m of river per tile with 12 cm of peak-to-trough: a real swell, and the
    // capillary band lands at ~2 cm, which is what a sky reflection needs.
    bake: { size: 1024, worldSize: 6.0, relief: 0.12, seed: 17 },
  },
  water_foam: {
    glsl: FOAM_GLSL,
    bake: { size: 512, worldSize: 3.0, relief: 0.02, seed: 23 },
  },
};

export class WaterSurface {
  /**
   * @param {{ flowNormal: THREE.Texture, foam: THREE.Texture }} maps
   * @param {object} [opts]
   */
  constructor(maps, opts = {}) {
    const o = {
      flow: [1, 0],
      speed: 1.0,
      /** Suspended sediment. A Pittsburgh river runs 0.55-0.85 most of the year. */
      turbidity: 0.7,
      /** Metres of surface per tile of the big/small normal maps. */
      waveScale: [0.045, 0.24],
      waveAmp: [0.55, 0.30],
      shallow: 0x6a6a4e,
      deep: 0x1c2a26,
      /** Per-metre extinction. Green survives longest, which is why a silty
       *  river reads olive rather than blue. */
      absorb: [1.35, 0.62, 1.05],
      foamShore: 0.55,
      foamScale: 0.55,
      foamAmount: 1.0,
      ...opts,
    };

    this.uniforms = {
      owFlowNrm: { value: maps.flowNormal },
      owFoamTex: { value: maps.foam },
      owSceneDepth: { value: null },
      owFlow: { value: new THREE.Vector4(o.flow[0], o.flow[1], o.speed, 0) },
      owWaveP: {
        value: new THREE.Vector4(o.waveScale[0], o.waveScale[1], o.waveAmp[0], o.waveAmp[1]),
      },
      owDeepP: { value: new THREE.Vector4(...o.absorb, o.turbidity) },
      owShallowCol: { value: new THREE.Color(o.shallow) },
      owDeepCol: { value: new THREE.Color(o.deep) },
      owFoamP: { value: new THREE.Vector4(o.foamShore, o.foamScale, o.foamAmount, 1) },
      owScreen: { value: new THREE.Vector4(1 / 1920, 1 / 1080, 0, 0) },
      owWakes: { value: Array.from({ length: MAX_WAKES }, () => new THREE.Vector4()) },
      owWakeCount: { value: 0 },
      owWetP: WET_UNIFORMS.owWetP,
    };

    const mat = new THREE.MeshStandardMaterial({
      color: 0xffffff,
      roughness: 0.06,
      metalness: 0,
      dithering: true,
    });
    mat.name = 'water';
    // A river reflects the sky, so it wants everything the render pipeline can
    // give it; SSR in particular is what puts the far bank and the bridge
    // lights on the surface.
    mat.envMapIntensity = 1.35;

    const u = this.uniforms;
    mat.customProgramCacheKey = () => 'ow:water';
    mat.onBeforeCompile = (shader) => {
      Object.assign(shader.uniforms, u);
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', '#include <common>\nvarying vec3 vOwWPos;')
        .replace('#include <worldpos_vertex>', '#include <worldpos_vertex>\n' + VERT_MAIN);

      let fs = shader.fragmentShader
        .replace(
          '#include <clipping_planes_pars_fragment>',
          '#include <clipping_planes_pars_fragment>\n' +
            PARS +
            '\nfloat owWaterFoam;\nvec3 owWaterNormal;\nfloat owWaterRough;\n'
        )
        .replace('#include <map_fragment>', FRAG_MAIN)
        .replace('#include <roughnessmap_fragment>', 'float roughnessFactor = owWaterRough;')
        .replace('#include <metalnessmap_fragment>', 'float metalnessFactor = 0.0;')
        .replace('#include <normal_fragment_maps>', 'normal = owWaterNormal;');
      shader.fragmentShader = fs;
    };
    mat.needsUpdate = true;

    /** The public wake / flow interface handed to 'vehicles'. */
    mat.userData.owWater = this;
    this.material = mat;
    this._wakeCursor = 0;
    this._wakes = [];
    for (let i = 0; i < MAX_WAKES; i++) this._wakes.push({ ttl: 0, life: 1 });
  }

  /**
   * Register a disturbance on the surface. Call once per frame per hull; the
   * ring buffer decays anything that stops being fed, so there is nothing to
   * clean up if a boat despawns.
   * @param {number} x world X
   * @param {number} z world Z
   * @param {number} strength 0..1, roughly speed / planing speed
   * @param {number} radius metres
   * @param {number} [ttl] seconds the disturbance persists (default 1.6)
   */
  addWake(x, z, strength = 1, radius = 2.5, ttl = 1.6) {
    const i = this._wakeCursor;
    this._wakeCursor = (this._wakeCursor + 1) % MAX_WAKES;
    const v = this.uniforms.owWakes.value[i];
    v.set(x, z, radius, Math.max(0, Math.min(1.5, strength)));
    const w = this._wakes[i];
    w.ttl = ttl;
    w.life = ttl;
    if (this.uniforms.owWakeCount.value < MAX_WAKES) {
      this.uniforms.owWakeCount.value = MAX_WAKES;
    }
    return i;
  }

  /** Set the current: direction (normalised internally) and speed multiplier. */
  setFlow(dx, dz, speed) {
    const l = Math.hypot(dx, dz) || 1;
    const f = this.uniforms.owFlow.value;
    f.x = dx / l;
    f.y = dz / l;
    if (speed !== undefined) f.z = speed;
    return this;
  }

  /** 0 = clear, 1 = spring runoff. Drives absorption and the foam's colour. */
  setTurbidity(t) {
    this.uniforms.owDeepP.value.w = Math.max(0, Math.min(1, t));
    return this;
  }

  /**
   * Advance the wake ring and pick up the scene depth texture.
   * Called by MaterialSystem.update(); safe to call with a null ctx.
   */
  update(time, dt, ctx) {
    const f = this.uniforms.owFlow.value;
    f.w = time;

    const wakes = this.uniforms.owWakes.value;
    for (let i = 0; i < MAX_WAKES; i++) {
      const w = this._wakes[i];
      if (w.ttl <= 0) continue;
      w.ttl -= dt;
      const k = Math.max(0, w.ttl / w.life);
      // A wake ring expands and fades; the expansion is what reads as motion.
      wakes[i].z += dt * 1.6;
      wakes[i].w *= k > 0 ? 1 - dt / Math.max(w.life, 1e-3) : 0;
      if (w.ttl <= 0) wakes[i].w = 0;
    }

    const r = ctx?.peek?.('render');
    if (r) {
      const dTex = r.depthTexture ?? null;
      this.uniforms.owSceneDepth.value = dTex;
      this.uniforms.owScreen.value.z = dTex ? 1 : 0;
      const s = r.screenSize;
      if (s?.width) this.uniforms.owScreen.value.set(1 / s.width, 1 / s.height, dTex ? 1 : 0, 0);
    }
  }

  dispose() {
    this.material.dispose();
  }
}
