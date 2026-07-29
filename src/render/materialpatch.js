import * as THREE from 'three';
import { csmShaderChunk } from './csm.js';

/**
 * Every lit material in the game gets four things injected into it:
 *
 *   1. the cascaded sun shadow (contact-hardening PCSS, see csm.js),
 *   2. screen-space contact shadows, multiplied onto the *sun* term only,
 *   3. GTAO applied to the *indirect* terms only — which is the physically
 *      right place for it, and the reason it reads as occlusion rather than
 *      as a dirty grey overlay,
 *   4. screen-space reflections blended into the IBL specular by confidence,
 *      so energy is replaced rather than added on top.
 *
 * Doing it in the base pass rather than as a post-multiply is what separates
 * this from a WebGL demo: AO darkens bounce light and leaves direct sunlight
 * alone, and SSR replaces the cubemap instead of double-counting it.
 *
 * Implementation note: `shader.uniforms` handed to onBeforeCompile *is* the
 * uniform object the renderer uploads from (WebGLRenderer stores it as
 * materialProperties.uniforms), so sharing one uniform object across every
 * patched material means a single write per frame updates all of them.
 */

const PATCH_VERSION = 13;

/** Max coarse interior volumes the indirect gate can hold (see OW_ROOMS). */
export const MAX_ROOMS = 10;

export class MaterialPatcher {
  constructor(csmUniforms, opts) {
    this.cascades = opts.cascades;
    this.quality = opts.quality;
    this.key = `ow-patch-${PATCH_VERSION}-${opts.cascades}-${opts.quality}`;

    this.uniforms = {
      ...csmUniforms,
      owAoTex: { value: null },
      owContactTex: { value: null },
      owSsrTex: { value: null },
      owScreenTexel: { value: new THREE.Vector2(1 / 1920, 1 / 1080) },
      // x: ao enable, y: contact enable, z: ssr enable, w: ao power
      owFeat: { value: new THREE.Vector4(0, 0, 0, 1) },
      // x diffuse AO strength, y SPECULAR occlusion strength.
      //
      // Specular occlusion cut from 0.6 to 0.28. AO is a diffuse visibility
      // term; applying it hard to the specular lobe removes reflections from
      // exactly the crevices, kerbs and railing junctions where a real frame
      // gets its glints, and it was one of the reasons nothing in the image
      // was brighter than sunlit albedo.
      // z: the AO VISIBILITY FLOOR — how much of the indirect term survives in
      //    a fully occluded pocket. It used to be a literal in the shader, and
      //    it was last changed (0.25 -> 0.15) during the entire period in which
      //    GTAO was returning 1.0 everywhere, so it has never once been looked
      //    at against a frame where it did anything. It is a uniform now so it
      //    can be swept in one browser session against measured crushed-pixel
      //    counts, which is how the shipped value was chosen.
      owAoStrength: { value: new THREE.Vector3(1, 0.28, 0.15) },
      /**
       * Specular shaping. See the lights_physical_fragment injection.
       *   x  alpha added for the sun's angular size (theta/2, 0.53 deg disc)
       *   y  unused
       *   z  geometric specular-AA gain on the screen-space normal variance
       *   w  ceiling on that term, so a silhouette edge cannot make a surface
       *      fully rough
       */
      owSpec: { value: new THREE.Vector4(0.0047, 0, 0.55, 0.22) },
      // Two-band hemispheric bounce fill. The PMREM sky cubemap is the only
      // indirect light this engine has, and GTAO then eats most of it, so
      // shadowed geometry collapsed to black. These are irradiance values in
      // the same units as a directional light's colour*intensity.
      owSkyFill: { value: new THREE.Vector3(0, 0, 0) },   // cool, upper band
      owGroundFill: { value: new THREE.Vector3(0, 0, 0) }, // lower band
      /**
       * THE SKY BAND, AS A MEASUREMENT INSTEAD OF A CONSTANT.
       *
       * Order-2 SH of the irradiance the real sky delivers, projected from the
       * sky subsystem's own emitted equirectangular environment (see
       * src/sky/irradiance.js) and uploaded scaled so the up-facing luminance
       * equals owSkyFill's. That last part is why this is safe: the LEVEL is
       * still the calibrated budget, and only the hue and the directional shape
       * come from the probe.
       *
       * It replaces owSkyFill multiplied by a cosine band. For a UNIFORM dome
       * the two are identical — a uniform hemisphere's irradiance is linear in
       * dot(N,up) and therefore lives entirely in the l=0 and l=1 terms — so
       * nothing calibrated against a flat sky can move, and everything this
       * adds is information the old form had no way to hold.
       */
      owSkySH: { value: makeVec3Array(9) },
      // Light bounced off SUNLIT VERTICAL SURFACES, arriving from the anti-sun
      // hemisphere. Its own band rather than a fraction of the ground one,
      // because the ground bounce goes as sin(sun altitude) and this goes as
      // cos: they peak twelve hours apart. See RenderSystem._updateBounceFill.
      owWrapFill: { value: new THREE.Vector3(0, 0, 0) },
      // x: hemispheric gain, y: warm sun-bounce wrap gain
      owFillGain: { value: new THREE.Vector2(1, 1) },
      // x: how far the sky band is bent away from the exact cosine hemisphere
      //    visibility. 0 is the physical integral; 1 is a full smoothstep, which
      //    models a street canyon seeing less sky than an open field of the same
      //    orientation. 0.25 is a light touch — the physical form is what makes
      //    the shadow occlusion orientation-consistent and it must stay close.
      // y: how much of the warm anti-sun WRAP survives on a surface with a
      //    clear view of the sky. The wrap is light off sunlit facades, so it
      //    is supplied by occluders rather than removed by them — see the
      //    owWrapVis note in the lights_fragment_maps injection. 0.35 keeps a
      //    little warmth on open ground (there is always something lit nearby)
      //    and gives the full authored level to a street canyon.
      // z,w: reserved.
      owFillDir: { value: new THREE.Vector4(0.25, 0.35, 0, 0) },
      // x: IBL diffuse budget (the PMREM is the biggest indirect term there is,
      //    and it is what decides the key:fill ratio), y: indirect floor inside
      //    interior volumes, z: live room count, w: unused.
      owIndirect: { value: new THREE.Vector4(1, 1, 0, 0) },
      // World -> level-space 2D transform: (cos, sin, tx, tz).
      owRoomXf: { value: new THREE.Vector4(1, 0, 0, 0) },
      // Coarse interior volumes in level space: (cx, cz, hx, hz) / (y0, y1,,).
      owRooms: { value: makeVec4Array(MAX_ROOMS) },
      owRoomsY: { value: makeVec4Array(MAX_ROOMS) },
    };

    this.chunk = csmShaderChunk(opts.cascades, opts.quality);
    this.rooms = this.uniforms.owRooms.value;
    this.roomsY = this.uniforms.owRoomsY.value;
    this._patched = new WeakSet();
    this.count = 0;
  }

  /** True for materials that run three's lighting pipeline. */
  static isLit(m) {
    return !!(
      m &&
      (m.isMeshStandardMaterial ||
        m.isMeshPhysicalMaterial ||
        m.isMeshPhongMaterial ||
        m.isMeshLambertMaterial ||
        m.isMeshToonMaterial)
    );
  }

  patch(material) {
    if (!material || this._patched.has(material)) return false;
    if (!MaterialPatcher.isLit(material)) return false;
    if (material.userData?.owNoPatch) return false;
    this._patched.add(material);
    this.count++;

    const uniforms = this.uniforms;
    const parsChunk = this.chunk + EXTRA_PARS;
    const prevHook = material.onBeforeCompile;
    const prevKey = material.customProgramCacheKey;
    const key = this.key;

    material.onBeforeCompile = function (shader, renderer) {
      if (typeof prevHook === 'function') prevHook.call(this, shader, renderer);
      for (const k in uniforms) shader.uniforms[k] = uniforms[k];

      shader.fragmentShader = shader.fragmentShader.replace(
        '#include <lights_pars_begin>',
        '#include <lights_pars_begin>\n' + parsChunk
      );

      // Inject the sun shadow inside the (unrolled) directional light loop.
      const dirBegin = THREE.ShaderChunk.lights_fragment_begin.replace(
        'getDirectionalLightInfo( directionalLight, directLight );',
        `getDirectionalLightInfo( directionalLight, directLight );
        // NOT gated on three's \`receiveShadow\`. THIS WAS THE BUG THAT MADE THE
        // CITY UNLIT.
        //
        // \`receiveShadow\` is a uniform three sets from \`object.receiveShadow\`,
        // and Object3D.receiveShadow DEFAULTS TO FALSE. Every mesh that did not
        // explicitly opt in therefore received no cascade shadow and no contact
        // shadow at all — silently, with the cascades rendering perfectly and
        // being sampled by nothing. A critic panel measured the consequences
        // exactly: "no building cast shadows at all in either wide shot",
        // "no AO or contact shadow anywhere two objects meet", and sunlit sand
        // at (178,165,145) whose own cast shadow read a flat neutral
        // (133,131,131) — because that "shadow" was not a shadow, it was the
        // one surface in the frame that happened to have the flag set sitting
        // next to a whole city that did not.
        //
        // ARCHITECTURE.md documents \`owNoShadow\` as "the ONLY shadow-caster
        // switch" and says nothing about receivers, so no subsystem had any
        // reason to set the flag, and there is no sane world in which the
        // default for a receiver is "ignore the sun's shadow". The contract is
        // now the obvious one: everything in the world receives the sun shadow.
        // A material that genuinely must not can set \`userData.owNoPatch\`.
        directLight.color *= owSunShadow( directionalLight.direction, geometryPosition, geometryNormal ) * owContactShadow( directionalLight.direction );
        // Micro-shadowing. AO belongs on indirect light, but a cascade texel is
        // tens of centimetres wide and the contact ray only runs along the sun
        // direction, so the last centimetre of a wall/soffit junction gets no
        // occlusion from EITHER and the frame comes back with razor-sharp
        // junctions and nothing grounded. A small fraction of the AO term on
        // the direct light is what every shipping renderer uses to close that
        // gap; at 0.35 it costs 2-3% on an open surface and a third of the key
        // in a crevice.
        directLight.color *= mix( 1.0, owSampleAO(), owAoStrength.x * 0.35 );`
      );
      shader.fragmentShader = shader.fragmentShader.replace(
        '#include <lights_fragment_begin>',
        dirBegin
      );

      /**
       * SPECULAR: give the frame a top end.
       *
       * MEASURED on the inherited image: p99.9 luminance 243.6/255 and only
       * 0.0007% of pixels above 254, in a frame containing steel railings,
       * glass, painted drums and a galvanised drainpipe. Every value in the top
       * of that histogram was sunlit ALBEDO. Nothing in the image was a
       * highlight. That is what "painted cardboard" means, and it is a
       * radiometric fault, not a grade fault: a tone curve cannot invent
       * energy that is not in the HDR buffer.
       *
       * Two causes, both fixed here by raising the roughness FLOOR:
       *
       * 1. THE SUN HAS NO ANGULAR SIZE. Three's DirectionalLight is a delta
       *    function, so a roughness-0.05 surface concentrates the entire solar
       *    highlight into a GGX lobe far narrower than the real 0.53-degree
       *    solar disc. The highlight is then a handful of sub-pixel-covered
       *    fragments that the box filter of rasterisation averages away against
       *    their neighbours — the energy is technically present and visually
       *    absent, which is exactly the measurement above. The standard fix is
       *    to widen the lobe by the light's solid angle:
       *        alpha' = alpha + theta/2,  theta = 0.0093 rad
       *    which for anything smoother than roughness ~0.09 spreads the
       *    highlight over several pixels at unchanged total energy. Highlights
       *    become things you can see instead of things a histogram can find.
       *
       * 2. SPECULAR ALIASING. At 3 km the city is mostly sub-pixel geometry,
       *    and a narrow GGX lobe on a normal that changes by a radian between
       *    adjacent pixels does not converge — it fireflies, and TAA then either
       *    smears it or clips it away. Kaplanyan's geometric specular
       *    antialiasing raises the roughness by the screen-space variance of
       *    the normal, which is the correct prefilter: a kilometre of instanced
       *    windows becomes a stable sheen instead of a field of white sparks.
       *
       * Both terms are floors, so a rough surface is untouched. The cost is
       * two derivative instructions.
       */
      shader.fragmentShader = shader.fragmentShader.replace(
        '#include <lights_physical_fragment>',
        `#include <lights_physical_fragment>
        {
          // normal (view space, mapped + flipped) is the shading normal in
          // scope here; geometryNormal only exists further down, inside
          // lights_fragment_begin.
          vec3 owNdx = dFdx( normal );
          vec3 owNdy = dFdy( normal );
          float owVar = owSpec.z * ( dot( owNdx, owNdx ) + dot( owNdy, owNdy ) );
          float owA = material.roughness * material.roughness;
          owA = min( 1.0, owA + owSpec.x + min( owVar, owSpec.w ) );
          material.roughness = sqrt( owA );
        }`
      );

      // AO on indirect only, SSR into the IBL specular.
      shader.fragmentShader = shader.fragmentShader.replace(
        '#include <lights_fragment_maps>',
        `#include <lights_fragment_maps>
        #if defined( RE_IndirectDiffuse )
        {
          float owAo = owSampleAO();
          if ( owAo < 1.0 ) {
            vec3 owBounce = owMultiBounce( owAo, diffuseColor.rgb );
            irradiance *= owBounce;
            iblIrradiance *= owBounce;
            #if defined( STANDARD ) && defined( RE_IndirectSpecular )
              radiance *= mix( 1.0, owSpecularOcclusion( owAo, material.roughness ), owAoStrength.y );
            #endif
          }

          // --- interior/exterior indirect budget -----------------------------
          // Skylight cannot reach the middle of a closed room, and letting it
          // do so is what makes a doorway read as a hole cut in a card instead
          // of as an aperture two stops over the room it lights. The gate is a
          // coarse room volume test (see RenderSystem._updateRooms) with an AO
          // term folded in, floored so nothing ever goes black.
          vec3 owWP = cameraPosition + ( geometryPosition * mat3( viewMatrix ) );
          float owIndoor = owInteriorGate( owWP, owAo );

          // --- two-band hemispheric fill: THE ANALYTIC SKY + GROUND ----------
          //
          // This used to be two independent smoothstep "gates" over dot(N,up),
          // tuned by hand. That is what produced the single worst measurable
          // defect in the inherited image: THE SAME SHADOW TRANSITION MEASURED
          // 4.0 STOPS ON A VERTICAL FACADE AND 1.9 STOPS ON GROUND TWO METRES
          // AWAY. The sun does not have two intensities. What differed was the
          // ambient, because the two hand-tuned gates did not add up to a
          // consistent hemispherical integral: an up-facing surface collected
          // the sky band at full strength and no ground band, a vertical one
          // collected 54% of the sky band and 1% of the ground band, so the
          // total ambient a surface received swung by a factor of two purely
          // with its orientation and had no relationship to how much sky it
          // could actually see.
          //
          // The replacement is the exact cosine-weighted hemisphere visibility,
          // which is not a tuning parameter at all — it is geometry:
          //
          //     skyVis    = ( 1 + N.up ) / 2      up-facing 1, vertical 1/2, down 0
          //     groundVis = ( 1 - N.up ) / 2      the complement, and they SUM TO 1
          //
          // Because the two visibilities sum to one for every possible normal,
          // the total indirect a surface receives now varies smoothly between
          // the sky irradiance and the ground irradiance instead of collapsing
          // in the middle, and a shadow costs the same number of stops whatever
          // the surface is doing. With the levels below (sky 0.16 of the beam,
          // ground 0.20) a shadow transition measures ~2.5 stops on open ground
          // and ~2.6 on a facade, against the ~2.7 / ~3.5 a light meter reads on
          // a real sunlit street — consistent, and in the right place.
          //
          // Occluded with sqrt(AO), never AO: a fill term that AO can drive to
          // zero is not a fill, it is just another way to make a black hole.
          vec3 owWN = inverseTransformDirection( normal, viewMatrix );
          float owFillAo = sqrt( max( owAo, 0.0 ) );
          float owUp = clamp( owWN.y, -1.0, 1.0 );
          float owGndG = ( 1.0 - owUp ) * 0.5;
          // ...AND THE SKY BAND IS NOW THE REAL SKY.
          //
          // The cool band used to be one uploaded colour times ( 1 + N.up ) / 2.
          // That form is the l <= 1 special case of the SH probe below, exactly:
          // a uniform hemisphere of radiance L delivers E(n) = pi*L*(1+N.up)/2,
          // which is linear in N.up and therefore has no l = 2 content at all.
          // So swapping in the probe cannot disturb anything that was tuned
          // against a flat dome, and it adds the two things the old form could
          // not represent — the sky's real zenith-to-horizon gradient, and its
          // lateral asymmetry about the sun.
          //
          // owFillDir.x used to bend this band away from the cosine by 0.25 of a
          // smoothstep. It is dropped: it is a no-op on a vertical surface
          // ( smoothstep(0,1,0.5) == 0.5 ) and worth 2.5% at 45 degrees, and a
          // hand bend on top of a measured integral is the thing this change
          // exists to stop doing.
          vec3 owSkyE = owShIrradiance( owWN );
          // --- WHY THE SKY BAND AND THE GROUND BAND OCCLUDE DIFFERENTLY ------
          // Both used to be scaled by sqrt(AO), and with the AO floor that
          // meant the MOST a nearby object could darken the ground it stands on
          // was a factor of two. A critic measured the consequence directly: in
          // the 'detail' frame the ground UNDER a parked van read 95,85,78 while
          // the van's own flank read 55,61,71 and the open ground two metres
          // away read 67,67,70. The ground a vehicle is sitting on was BRIGHTER
          // than the same ground in the open. Nothing in the frame read as
          // touching anything.
          //
          // The sky band is not an arbitrary ambient — it IS the cosine-weighted
          // sky visibility integral, and AO is this engine's estimate of exactly
          // that quantity. So it applies at full strength: a patch of tarmac
          // that can only see a quarter of the sky receives a quarter of the
          // skylight, which is both the physical answer and the contact shadow
          // the cascades are too coarse to draw.
          //
          // The ground band keeps sqrt(AO). It arrives from BELOW, off surfaces
          // a metre or two away that the same occluder does not hide, so the
          // hemisphere AO measured against the sky over-states how much of it is
          // lost — and driving a bounce term to zero is how you get a black
          // halo instead of an occlusion.
          float owSkyAo = clamp( owAo, 0.0, 1.0 );
          irradiance += ( owSkyE * owSkyAo
                        + owGroundFill * owGndG * owFillAo ) * owIndoor * owFillGain.x;

          // The PMREM sky is the dominant indirect term in the frame, so the
          // interior gate and the indirect budget have to bite here or the
          // key:fill ratio is whatever the env map happens to be.
          iblIrradiance *= owIndirect.x * owIndoor;

          // --- warm sun bounce off whatever the sun is actually hitting ------
          // A single wrap term from the anti-sun hemisphere: the wall in shade
          // is lit by the sunlit wall across the street, and that is the light
          // that makes shadowed geometry read as shape instead of silhouette.
          //
          // Its own colour and level (owWrapFill), not a fraction of the ground
          // band: bounce off a horizontal street and bounce off a vertical
          // facade are two different lights that peak at opposite ends of the
          // day, and sharing one number meant golden hour — when the facade
          // bounce is at its strongest and the road bounce is at zero — had
          // neither.
          //
          // Gated by owIndoor as well. It was not, and it is scaled off the sun,
          // so the inside of every room was receiving the street's bounce at
          // full strength through a metre of masonry — which is why an interior
          // metered the same as the sunlit exterior framed in its own doorway.
          //
          // --- AND IT IS OCCLUSION-DRIVEN, NOT OCCLUSION-ATTENUATED ----------
          // This term used to be scaled by sqrt(AO), the same as the sky band,
          // and that is exactly backwards. The sky band comes from the sky, so
          // geometry in the way REMOVES it. This one comes FROM the geometry —
          // it is the sunlit wall across the street — so geometry in the way is
          // what SUPPLIES it. Scaled by AO, the warm return was weakest in the
          // street canyon that is the only place it physically exists, and
          // strongest on an open hillside two kilometres from the nearest
          // facade.
          //
          // That inversion is what a critic measured on the sunset frame: a
          // shaded hillside at 85,47,19 carrying THE SAME HUE as the sunlit one
          // at 119,66,20, only darker. At golden hour the wrap is at its
          // maximum (it goes as cos of the sun altitude) and it was landing at
          // full strength on open terrain, where it swamped the blue skylight
          // that is the entire reason a golden-hour shadow reads cool. Shade
          // was a dimmer copy of the key instead of the opposite side of the
          // sky.
          //
          // owFillDir.y is the floor: how much of the authored wrap survives on
          // a surface that can see the whole sky. Not zero — there is always
          // SOMETHING lit nearby — but a fraction, rising to the full value
          // where the AO buffer says the surface is genuinely enclosed.
          float owWrapVis = mix( owFillDir.y, 1.0, 1.0 - owSkyAo );
          irradiance += owWrapFill *
            ( owSunBounce( owWN ) * owFillGain.y * owWrapVis * owIndoor );
        }
        #endif
        #if defined( STANDARD ) && defined( RE_IndirectSpecular ) && defined( USE_ENVMAP )
        if ( owFeat.z > 0.5 && material.roughness < 0.62 ) {
          vec4 owSsr = texture2D( owSsrTex, gl_FragCoord.xy * owScreenTexel );
          float owW = owSsr.a * smoothstep( 0.62, 0.14, material.roughness );
          radiance = mix( radiance, owSsr.rgb, clamp( owW, 0.0, 1.0 ) );
        }
        #endif
        `
      );
    };

    material.customProgramCacheKey = function () {
      const base = typeof prevKey === 'function' ? prevKey.call(this) : '';
      return key + base;
    };

    material.needsUpdate = true;
    return true;
  }

  setScreenSize(w, h) {
    this.uniforms.owScreenTexel.value.set(1 / w, 1 / h);
  }

  dispose() {
    this._patched = new WeakSet();
  }
}

function makeVec4Array(n) {
  const a = new Array(n);
  for (let i = 0; i < n; i++) a[i] = new THREE.Vector4(0, 0, 0, 0);
  return a;
}

function makeVec3Array(n) {
  const a = new Array(n);
  for (let i = 0; i < n; i++) a[i] = new THREE.Vector3(0, 0, 0);
  return a;
}

/**
 * The CPU twin of owShIrradiance() in EXTRA_PARS below.
 *
 * It lives here, three lines from the GLSL, on purpose. `RenderSystem` scales
 * the coefficients so that the up-facing result equals the calibrated indirect
 * budget, and it computes that scale WITH THIS FUNCTION — so if the two
 * polynomials ever disagree, the level uploaded to the shader is wrong by
 * exactly the difference, silently, in every frame. Keeping them adjacent is
 * the cheapest available defence.
 *
 * (`src/sky/irradiance.js` has its own copy because ARCHITECTURE.md rule 2
 * forbids importing across subsystems; it uses it only for a self-test.)
 */
export function shIrradiance(sh, x, y, z, out) {
  const c0 = 0.886227;
  const c1 = 1.023328;
  const c2 = 0.858086;
  const cz = 0.743125 * z * z - 0.247708;
  const cq = 0.429043 * (x * x - y * y);
  const b1 = c1 * y;
  const b2 = c1 * z;
  const b3 = c1 * x;
  const b4 = c2 * x * y;
  const b5 = c2 * y * z;
  const b7 = c2 * x * z;
  return out.set(
    sh[0].x * c0 + sh[1].x * b1 + sh[2].x * b2 + sh[3].x * b3 + sh[4].x * b4 +
      sh[5].x * b5 + sh[6].x * cz + sh[7].x * b7 + sh[8].x * cq,
    sh[0].y * c0 + sh[1].y * b1 + sh[2].y * b2 + sh[3].y * b3 + sh[4].y * b4 +
      sh[5].y * b5 + sh[6].y * cz + sh[7].y * b7 + sh[8].y * cq,
    sh[0].z * c0 + sh[1].z * b1 + sh[2].z * b2 + sh[3].z * b3 + sh[4].z * b4 +
      sh[5].z * b5 + sh[6].z * cz + sh[7].z * b7 + sh[8].z * cq
  );
}

/**
 * Add a uniform hemisphere of radiance (r,g,b) about +Y.
 *
 * Only l=0 and the l=1 y term survive; every other integral over a hemisphere
 * is zero by symmetry. The constants are 2*PI*Y00 and PI*Y1, and they give
 * E(+Y) = PI, E(horizon) = PI/2, E(-Y) = 0 — the analytic answers, which is
 * what `SkyIrradianceProbe.selfTest()` checks.
 */
const HEMI_L00 = 0.282095 * 2 * Math.PI;
const HEMI_L1Y = 0.488603 * Math.PI;
export function addHemisphereSH(sh, r, g, b) {
  sh[0].x += r * HEMI_L00;
  sh[0].y += g * HEMI_L00;
  sh[0].z += b * HEMI_L00;
  sh[1].x += r * HEMI_L1Y;
  sh[1].y += g * HEMI_L1Y;
  sh[1].z += b * HEMI_L1Y;
}

const EXTRA_PARS = /* glsl */ `
#define OW_ROOMS ${MAX_ROOMS}
uniform sampler2D owAoTex;
uniform sampler2D owContactTex;
uniform sampler2D owSsrTex;
uniform vec2 owScreenTexel;
uniform vec4 owFeat;
uniform vec3 owAoStrength;
uniform vec4 owSpec;
uniform vec3 owSkyFill;
uniform vec3 owSkySH[ 9 ];
uniform vec3 owGroundFill;
uniform vec3 owWrapFill;
uniform vec2 owFillGain;
uniform vec4 owFillDir;
uniform vec4 owIndirect;
uniform vec4 owRoomXf;
uniform vec4 owRooms[ OW_ROOMS ];
uniform vec4 owRoomsY[ OW_ROOMS ];

/**
 * 1 outdoors, -> owIndirect.y deep inside a coarse interior volume.
 *
 * The volumes are the enterable buildings' footprints, tested in LEVEL space
 * (one yaw, so a 2D rotate is enough) by *depth inside the box* rather than by
 * containment: a facade's outer skin sits exactly on the footprint boundary at
 * depth 0 and its inner skin one wall thickness in, so a 6..30 cm feather
 * separates the two faces of the same wall without needing per-room geometry.
 */
float owInteriorGate( vec3 worldPos, float ao ) {
  float indoor = 0.0;
  if ( owIndirect.z > 0.5 ) {
    float lx = worldPos.x * owRoomXf.x + worldPos.z * owRoomXf.y + owRoomXf.z;
    float lz = -worldPos.x * owRoomXf.y + worldPos.z * owRoomXf.x + owRoomXf.w;
    int n = int( owIndirect.z );
    for ( int i = 0; i < OW_ROOMS; i ++ ) {
      if ( i >= n ) break;
      vec4 r = owRooms[ i ];
      vec4 ry = owRoomsY[ i ];
      float d = min(
        min( r.z - abs( lx - r.x ), r.w - abs( lz - r.y ) ),
        min( worldPos.y - ry.x, ry.y - worldPos.y ) );
      indoor = max( indoor, smoothstep( 0.06, 0.30, d ) );
    }
  }
  // Even outside a tagged volume, a pocket the sky genuinely cannot see should
  // not receive full skylight — that is what the AO buffer knows and the room
  // list does not (arcades, stairwells, under-awning market stalls).
  //
  // Weight cut from 0.6 to 0.3 and the ramp moved down. At 0.6 over the range
  // 0.45..0.98 this was a SECOND full-strength AO multiply stacked on the
  // sqrt(AO) the fill already carries and on the multi-bounce AO the irradiance
  // already carries — a facade in a street canyon with AO 0.6 came out at
  // 0.52 x 0.77 = 0.40 of the fill that open ground two metres away received,
  // which is most of the 4.0-vs-1.9-stop shadow inconsistency. Occlusion is a
  // shaping tool and it is already applied twice; this third application only
  // needs to catch the genuinely enclosed cases.
  float aoGate = mix( 1.0, smoothstep( 0.18, 0.72, ao ), 0.30 );
  float g = min( 1.0 - indoor, aoGate );
  return mix( owIndirect.y, 1.0, clamp( g, 0.0, 1.0 ) );
}

/**
 * Diffuse irradiance from the sky, order-2 SH.
 *
 * The coefficients are projected from the sky subsystem's own emitted
 * environment map (src/sky/irradiance.js) and uploaded already scaled to the
 * renderer's indirect budget, so this is a plain evaluation with nothing to
 * tune. The A_l Lambert convolution factors are folded into the constants
 * below; the same polynomial is implemented on the CPU in shIrradiance(), and
 * the two MUST stay identical because the normalisation that sets the level is
 * computed with the CPU one.
 *
 * Clamped at zero: an order-2 fit to a sky with a very hard horizon can ring
 * slightly negative on the down-facing lobe, and negative irradiance subtracts
 * light that another term put there.
 */
vec3 owShIrradiance( vec3 n ) {
  vec3 r = owSkySH[ 0 ] * 0.886227;
  r += owSkySH[ 1 ] * ( 1.023328 * n.y );
  r += owSkySH[ 2 ] * ( 1.023328 * n.z );
  r += owSkySH[ 3 ] * ( 1.023328 * n.x );
  r += owSkySH[ 4 ] * ( 0.858086 * n.x * n.y );
  r += owSkySH[ 5 ] * ( 0.858086 * n.y * n.z );
  r += owSkySH[ 6 ] * ( 0.743125 * n.z * n.z - 0.247708 );
  r += owSkySH[ 7 ] * ( 0.858086 * n.x * n.z );
  r += owSkySH[ 8 ] * ( 0.429043 * ( n.x * n.x - n.y * n.y ) );
  return max( r, vec3( 0.0 ) );
}

float owSampleAO() {
  if ( owFeat.x < 0.5 ) return 1.0;
  float ao = texture2D( owAoTex, gl_FragCoord.xy * owScreenTexel ).r;
  // Floor the visibility: real crevices are filled by multiply-scattered light,
  // and an AO term that reaches 0 is a dark halo, not occlusion.
  //
  // The floor bounds how dark a contact can get. It stands in for the light a
  // second bounce would put into that pocket, which this engine does not
  // compute — so it is not a fudge, it is the only multiply-scattered term
  // there is, and driving it to zero produces a black halo rather than an
  // occlusion. Swept against measured crushed-pixel counts; see owAoStrength.
  return mix( 1.0, max( ao, owAoStrength.z ), owAoStrength.x );
}

/**
 * Wrapped diffuse from the anti-sun hemisphere — the reflected street key.
 * The wrap is tight (0.12 rather than 0.35): a face turned away from the sunlit
 * side of the street receives none of its bounce, and a wide wrap is what let
 * this warm term reach every surface in the frame at once.
 */
float owSunBounce( vec3 worldNormal ) {
  vec3 anti = normalize( vec3( -owSunDirWorld.x, 0.28, -owSunDirWorld.z ) + vec3( 1e-4 ) );
  return clamp( ( dot( worldNormal, anti ) + 0.12 ) / 1.12, 0.0, 1.0 );
}

// Jimenez GTAO multi-bounce: dark albedos occlude more than bright ones,
// which stops AO turning white plaster into grey mud.
vec3 owMultiBounce( float ao, vec3 albedo ) {
  vec3 a = 2.0404 * albedo - 0.3324;
  vec3 b = -4.7951 * albedo + 0.6417;
  vec3 c = 2.7552 * albedo + 0.6903;
  return clamp( ao * ( ao * ( ao * a + b ) + c ), vec3( ao ), vec3( 1.0 ) );
}

// Rough surfaces gather from a wide cone, so they see more occlusion.
float owSpecularOcclusion( float ao, float rough ) {
  float r2 = rough * rough;
  return clamp( pow( max( ao, 0.0 ), 1.0 + r2 * 2.0 ), 0.0, 1.0 );
}

float owContactShadow( vec3 lightDirView ) {
  if ( owFeat.y < 0.5 ) return 1.0;
  if ( dot( lightDirView, owSunDirView ) < 0.999 ) return 1.0;
  return texture2D( owContactTex, gl_FragCoord.xy * owScreenTexel ).r;
}

`;
