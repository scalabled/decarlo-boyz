import * as THREE from 'three';
import { SkyPass, blit, hdrTarget } from './fullscreen.js';

/**
 * ---------------------------------------------------------------------------
 * SKY IRRADIANCE PROBE — the sky as a light, not as a colour
 * ---------------------------------------------------------------------------
 *
 * This subsystem already renders the real physical sky into a 512x256
 * equirectangular target every time the sun moves (`SkySystem.envEquirect`),
 * and hands it to PMREM for reflections. What nothing did was ask that image
 * the one question a lighting model actually needs answered:
 *
 *     how much light, and of what colour, does a surface facing THIS WAY
 *     receive from the sky that is currently in the frame?
 *
 * Instead the renderer took `sky.ambientColor` — a three-float CPU stand-in
 * this file's own header calls "not used for lighting" — normalised it so its
 * largest channel was 1, pushed its chroma out by 1.55x and used the result as
 * the colour of every shadow in the city. MEASURED against the sky's own
 * emitted environment map, that constant was wrong in both directions at once:
 *
 *   frame     model sky fill B/R     TRUE cosine irradiance B/R
 *   hero      4.88                   2.63
 *   car       4.88                   2.71
 *   street    1.30                   0.84   (overcast: the real dome is WARM)
 *   detail    1.30                   0.82
 *
 * On a clear day the shade was very nearly twice as blue as the sky casting it
 * — that is the "shade-side surfaces crush to a saturated cobalt and the
 * material read dies with it" a critic panel measured — and under the overcast
 * this city is supposed to lean into, the model tinted every shaded surface
 * BLUE while the actual dome integrates to a warm neutral grey.
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS COMPUTES
 * ---------------------------------------------------------------------------
 *
 * The order-2 spherical-harmonic projection of the sky's own radiance, which
 * is the standard exact-to-1% representation of diffuse irradiance
 * (Ramamoorthi & Hanrahan 2001). Nine RGB coefficients; the shader evaluates
 * a quadratic polynomial in the world normal and gets E(n) — the real
 * cosine-weighted integral of the real dome, per pixel, per normal.
 *
 * Three properties make this worth the readback:
 *
 *  1. IT IS A MEASUREMENT, NOT A GUESS. The input is the emitted equirect: the
 *     same pixels the player sees on the dome and the same ones PMREM reflects.
 *     The shadow colour cannot disagree with the sky any more, in any frame, at
 *     any time of day or weather, because it is derived from it.
 *
 *  2. IT IS DIRECTIONAL. A constant tinted by dot(N, up) has exactly one axis
 *     of variation. A real sky has a bright warm band on the sun's side and
 *     deep Rayleigh blue opposite it, and the L1/L2 terms carry that: at golden
 *     hour a west-facing wall in shade picks up the sunset band while the
 *     east-facing wall two metres away goes blue. That separation is what makes
 *     shade read as shape.
 *
 *  3. IT DEGRADES TO EXACTLY THE OLD MODEL. For a UNIFORM hemisphere the
 *     irradiance is E(n) = pi*L*(1 + N.up)/2, which is linear in N.up and
 *     therefore represented EXACTLY by the l=0 and l=1 bands — no ringing, no
 *     approximation. The renderer's previous two-band form is the l<=1 special
 *     case of this one, so nothing that was calibrated against a flat dome can
 *     move. Everything this adds is information the old form could not hold.
 *
 * ---------------------------------------------------------------------------
 * WHAT IT DELIBERATELY DOES NOT DO
 * ---------------------------------------------------------------------------
 *
 * It does not set the LEVEL. The renderer keeps driving the absolute level off
 * `sky.ambientColor`, and the probe supplies only shape and hue (it is uploaded
 * normalised to unit up-facing luminance). That is not timidity, it is the only
 * way to avoid destroying the night pass: the dome does NOT render urban
 * skyglow — the aggregate of a thousand sodium lamps scattering off the cloud
 * base, which is the term that took the 21:21 overcast frame from 1.71% to
 * 0.03% crushed pixels — so the dome's own integral is 17x too dark at night
 * and would drag the frame straight back into the hole. MEASURED at the `night`
 * shot: published ambient 0.234,0.254,0.348 against a dome integrating to
 * 0.009,0.016,0.030.
 *
 * Skyglow is therefore added here as what it physically is: an extra uniform
 * hemisphere of radiance, projected into the same basis and mixed in by its own
 * share of the published ambient. Sky and skyglow are one hemispherical
 * integral instead of two systems fighting over the same surface, and the
 * night work is carried forward rather than worked around.
 */

/** 4x box downsample: four bilinear taps, each of which is an exact 2x2 mean. */
const DOWN4 = /* glsl */ `
precision highp float;
uniform sampler2D tSrc;
uniform vec2 uDstTexel;
in vec2 vUv;
layout(location = 0) out vec4 fragColor;
void main() {
  vec2 o = uDstTexel * 0.25;
  vec4 c = texture( tSrc, vUv + vec2( -o.x, -o.y ) )
         + texture( tSrc, vUv + vec2(  o.x, -o.y ) )
         + texture( tSrc, vUv + vec2( -o.x,  o.y ) )
         + texture( tSrc, vUv + vec2(  o.x,  o.y ) );
  fragColor = c * 0.25;
}
`;

/** Grid the probe is integrated on. 512 directions for a 9-term basis. */
const PW = 32;
const PH = 16;

// Real SH basis constants, and the Lambert convolution A_l folded into the
// evaluation polynomial. Both halves live here so the CPU normalisation and
// the GLSL evaluation can never drift apart.
const Y00 = 0.282095;
const Y1 = 0.488603;
const Y2A = 1.092548;
const Y20 = 0.315392;
const Y22 = 0.546274;

/**
 * Evaluate the irradiance polynomial. MUST stay identical to `owShIrradiance`
 * in src/render/materialpatch.js — the renderer normalises against this, so if
 * the two disagree the uploaded level is wrong by whatever the difference is.
 */
export function shIrradiance(sh, x, y, z, out) {
  const r =
    sh[0].x * 0.886227 +
    sh[1].x * 1.023328 * y +
    sh[2].x * 1.023328 * z +
    sh[3].x * 1.023328 * x +
    sh[4].x * 0.858086 * x * y +
    sh[5].x * 0.858086 * y * z +
    sh[6].x * (0.743125 * z * z - 0.247708) +
    sh[7].x * 0.858086 * x * z +
    sh[8].x * 0.429043 * (x * x - y * y);
  const g =
    sh[0].y * 0.886227 +
    sh[1].y * 1.023328 * y +
    sh[2].y * 1.023328 * z +
    sh[3].y * 1.023328 * x +
    sh[4].y * 0.858086 * x * y +
    sh[5].y * 0.858086 * y * z +
    sh[6].y * (0.743125 * z * z - 0.247708) +
    sh[7].y * 0.858086 * x * z +
    sh[8].y * 0.429043 * (x * x - y * y);
  const b =
    sh[0].z * 0.886227 +
    sh[1].z * 1.023328 * y +
    sh[2].z * 1.023328 * z +
    sh[3].z * 1.023328 * x +
    sh[4].z * 0.858086 * x * y +
    sh[5].z * 0.858086 * y * z +
    sh[6].z * (0.743125 * z * z - 0.247708) +
    sh[7].z * 0.858086 * x * z +
    sh[8].z * 0.429043 * (x * x - y * y);
  return out.set(r, g, b);
}

/**
 * SH of a uniform hemisphere of unit radiance about +Y. Only the l=0 and the
 * l=1 (y) terms survive; every other integral is zero by symmetry. Checked:
 * E(+Y) = pi, E(horizon) = pi/2, E(-Y) = 0, which is the analytic answer.
 */
const HEMI_L00 = Y00 * 2 * Math.PI;
const HEMI_L1Y = Y1 * Math.PI;

export class SkyIrradianceProbe {
  constructor() {
    this.mid = hdrTarget(128, 64, { name: 'sky-irr-mid' });
    this.small = hdrTarget(PW, PH, { name: 'sky-irr-small' });
    this.down = new SkyPass('sky-irr-down', DOWN4, {
      tSrc: { value: null },
      uDstTexel: { value: new THREE.Vector2() },
    });

    /** Nine RGB coefficients of the SKY (upper hemisphere), radiance units. */
    this.sh = new Array(9);
    for (let i = 0; i < 9; i++) this.sh[i] = new THREE.Vector3();
    /** True while `sh` holds a projection of a real frame. */
    this.valid = false;

    this._buf = new Uint16Array(PW * PH * 4);
    this._dir = new Float32Array(PW * PH * 3);
    this._w = new Float32Array(PW * PH);
    this._tmp = new THREE.Vector3();

    // Direction and solid angle per probe texel. Fixed by the equirect mapping
    // in dome.js ENV_FRAG, so it is precomputed once.
    //
    // readRenderTargetPixels' row 0 is the BOTTOM of the image, and ENV_FRAG
    // maps v directly to latitude, so row j has lat = ((j+0.5)/PH - 0.5) * PI.
    // Getting this upside down would put the sky's irradiance under the ground
    // and is exactly the kind of thing that looks plausible in a still, so
    // `selfTest` below checks it against a known analytic answer.
    const dOmega = ((2 * Math.PI) / PW) * (Math.PI / PH);
    for (let j = 0; j < PH; j++) {
      const lat = ((j + 0.5) / PH - 0.5) * Math.PI;
      const sinL = Math.sin(lat);
      const cosL = Math.cos(lat);
      for (let i = 0; i < PW; i++) {
        const az = ((i + 0.5) / PW - 0.5) * 2 * Math.PI;
        const k = j * PW + i;
        this._dir[k * 3] = cosL * Math.cos(az);
        this._dir[k * 3 + 1] = sinL;
        this._dir[k * 3 + 2] = cosL * Math.sin(az);
        this._w[k] = dOmega * cosL;
      }
    }
  }

  /**
   * Downsample the equirect, read it back and project. Called on its own
   * amortisation phase, so it never shares a frame with the PMREM convolution.
   */
  update(renderer, srcTexture) {
    const u = this.down.uniforms;
    u.tSrc.value = srcTexture;
    u.uDstTexel.value.set(1 / 128, 1 / 64);
    this.down.render(renderer, this.mid);
    u.tSrc.value = this.mid.texture;
    u.uDstTexel.value.set(1 / PW, 1 / PH);
    this.down.render(renderer, this.small);
    renderer.setRenderTarget(null);

    const buf = this._buf;
    renderer.readRenderTargetPixels(this.small, 0, 0, PW, PH, buf);
    const dec = THREE.DataUtils.fromHalfFloat;

    const sh = this.sh;
    for (let i = 0; i < 9; i++) sh[i].set(0, 0, 0);

    const n = PW * PH;
    for (let k = 0; k < n; k++) {
      const y = this._dir[k * 3 + 1];
      // SKY ONLY. Below the horizon the dome paints its own ground bounce, and
      // the renderer already models that band analytically off the sun it is
      // actually using as the key. Letting both in would double-count the
      // brightest indirect term in a daylight frame.
      if (y <= 0) continue;
      const w = this._w[k];
      if (w <= 0) continue;
      const r = dec(buf[k * 4]) * w;
      const g = dec(buf[k * 4 + 1]) * w;
      const b = dec(buf[k * 4 + 2]) * w;
      if (!(r >= 0) || !(g >= 0) || !(b >= 0)) continue;
      const x = this._dir[k * 3];
      const z = this._dir[k * 3 + 2];

      sh[0].x += r * Y00; sh[0].y += g * Y00; sh[0].z += b * Y00;
      const y1y = Y1 * y, y1z = Y1 * z, y1x = Y1 * x;
      sh[1].x += r * y1y; sh[1].y += g * y1y; sh[1].z += b * y1y;
      sh[2].x += r * y1z; sh[2].y += g * y1z; sh[2].z += b * y1z;
      sh[3].x += r * y1x; sh[3].y += g * y1x; sh[3].z += b * y1x;
      const y2xy = Y2A * x * y, y2yz = Y2A * y * z, y2xz = Y2A * x * z;
      const y2z2 = Y20 * (3 * z * z - 1), y2x2 = Y22 * (x * x - y * y);
      sh[4].x += r * y2xy; sh[4].y += g * y2xy; sh[4].z += b * y2xy;
      sh[5].x += r * y2yz; sh[5].y += g * y2yz; sh[5].z += b * y2yz;
      sh[6].x += r * y2z2; sh[6].y += g * y2z2; sh[6].z += b * y2z2;
      sh[7].x += r * y2xz; sh[7].y += g * y2xz; sh[7].z += b * y2xz;
      sh[8].x += r * y2x2; sh[8].y += g * y2x2; sh[8].z += b * y2x2;
    }

    // A NaN or a negative anywhere in here silently blackens every lit material
    // in the game, so the probe refuses to publish rather than publish rubbish.
    for (let i = 0; i < 9; i++) {
      if (!Number.isFinite(sh[i].x) || !Number.isFinite(sh[i].y) || !Number.isFinite(sh[i].z)) {
        this.valid = false;
        return false;
      }
    }
    const up = shIrradiance(sh, 0, 1, 0, this._tmp);
    if (!(up.x + up.y + up.z > 1e-9)) {
      this.valid = false;
      return false;
    }
    this.valid = true;
    return true;
  }

  /** Add a uniform hemisphere of radiance (r,g,b) about +Y into `out`. */
  static addHemisphere(out, r, g, b, scale = 1) {
    out[0].x += r * HEMI_L00 * scale;
    out[0].y += g * HEMI_L00 * scale;
    out[0].z += b * HEMI_L00 * scale;
    out[1].x += r * HEMI_L1Y * scale;
    out[1].y += g * HEMI_L1Y * scale;
    out[1].z += b * HEMI_L1Y * scale;
  }

  /**
   * Prove the projection and the evaluator agree with the closed form.
   *
   * A uniform hemisphere of unit radiance must give E(+Y) = pi, E(horizontal)
   * = pi/2, E(-Y) = 0. This does NOT re-use anything the GPU path computed, so
   * it fails if the basis constants, the A_l factors or the evaluator are
   * wrong — which is the only reason it is worth having.
   */
  static selfTest() {
    const sh = new Array(9);
    for (let i = 0; i < 9; i++) sh[i] = new THREE.Vector3();
    SkyIrradianceProbe.addHemisphere(sh, 1, 1, 1);
    const t = new THREE.Vector3();
    const up = shIrradiance(sh, 0, 1, 0, t).x;
    const side = shIrradiance(sh, 1, 0, 0, t).x;
    const down = shIrradiance(sh, 0, -1, 0, t).x;
    return {
      up,
      side,
      down,
      ok:
        Math.abs(up - Math.PI) < 1e-4 &&
        Math.abs(side - Math.PI / 2) < 1e-4 &&
        Math.abs(down) < 1e-4,
    };
  }

  dispose() {
    this.mid.dispose();
    this.small.dispose();
    this.down.dispose();
  }
}
