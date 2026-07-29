import * as THREE from 'three';
import { Accum } from './util.js';
import { RIVERS, WATER_Y } from './plan.js';

/**
 * WORLD — the rivers.
 *
 * A third of Steel City is water and Carson's whole arc is on it, so the river
 * surface is not a blue plane: two procedurally generated normal layers scroll
 * across each other at different scales and speeds, the sheet is slightly
 * displaced so the horizon line of the water breaks up, and the whole thing is
 * a low-roughness dielectric so it takes the sky reflection from `render`'s
 * PMREM env map (which is what makes golden hour over the Ohio the money shot).
 *
 * The ribbon is generated from the same polylines that carve the terrain, so
 * the waterline meets the bank exactly at y = 0 with no gap and no float.
 */

const OVER = 24; // metres of overlap under the bank, so there is never a seam

export class Water {
  constructor({ ctx, root, rng, terrain }) {
    this.ctx = ctx;
    this.time = 0;
    this.normalMap = makeWaterNormal(192);
    this.mat = new THREE.MeshStandardMaterial({
      color: new THREE.Color(0x141f21),
      roughness: 0.10,
      metalness: 0.0,
      normalMap: this.normalMap,
      normalScale: new THREE.Vector2(0.85, 0.85),
      envMapIntensity: 1.05,
    });
    this.mat.name = 'water';
    this._u = {
      owWTime: { value: 0 },
      owWScale: { value: new THREE.Vector2(0.09, 0.028) },
    };
    const u = this._u;
    this.mat.onBeforeCompile = (shader) => {
      shader.uniforms.owWTime = u.owWTime;
      shader.uniforms.owWScale = u.owWScale;
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', '#include <common>\nvarying vec3 vOwWaterP;')
        .replace(
          '#include <worldpos_vertex>',
          '#include <worldpos_vertex>\n\tvOwWaterP = ( modelMatrix * vec4( transformed, 1.0 ) ).xyz;'
        );
      shader.fragmentShader = shader.fragmentShader
        .replace(
          '#include <common>',
          `#include <common>
varying vec3 vOwWaterP;
uniform float owWTime;
uniform vec2 owWScale;`
        )
        .replace(
          '#include <normal_fragment_maps>',
          `
{
  vec2 p = vOwWaterP.xz;
  vec2 uvA = p * owWScale.x + vec2(  owWTime * 0.013, owWTime * 0.0071 );
  vec2 uvB = p * owWScale.y + vec2( -owWTime * 0.0062, owWTime * 0.0104 );
  vec3 nA = texture2D( normalMap, uvA ).xyz * 2.0 - 1.0;
  vec3 nB = texture2D( normalMap, uvB ).xyz * 2.0 - 1.0;
  vec3 nrm = normalize( vec3( nA.xy * normalScale + nB.xy * normalScale * 1.35, nA.z * nB.z ) );
  // Flatten with distance so the far river is a mirror, not a shimmer field.
  float fade = 1.0 - clamp( length( vOwWaterP - cameraPosition ) / 420.0, 0.0, 1.0 );
  nrm = normalize( mix( vec3( 0.0, 0.0, 1.0 ), nrm, 0.16 + fade * 0.84 ) );
  // tangent space (z = up) -> world (y = up) -> view, which is where the
  // standard shader expects the normal to live.
  vec3 owWN = normalize( vec3( nrm.x, nrm.z, nrm.y ) );
  normal = normalize( ( viewMatrix * vec4( owWN, 0.0 ) ).xyz );
}
`
        );
    };

    const acc = new Accum('water');
    for (let ri = 0; ri < RIVERS.length; ri++) {
      ribbon(acc, RIVERS[ri], WATER_Y - 0.012 + ri * 0.006, terrain);
    }
    const geo = acc.build();
    this.mesh = new THREE.Mesh(geo, this.mat);
    this.mesh.name = 'water';
    this.mesh.matrixAutoUpdate = false;
    this.mesh.receiveShadow = false;
    this.mesh.castShadow = false;
    this.mesh.userData.owNoShadow = true;
    this.mesh.userData.collision = false;
    this.mesh.userData.surface = 'water';
    root.add(this.mesh);
  }

  update(dt) {
    this.time += dt;
    this._u.owWTime.value = this.time;
  }

  dispose() {
    this.mesh.geometry.dispose();
    this.mat.dispose();
    this.normalMap.dispose();
    this.mesh.parent?.remove(this.mesh);
  }
}

/**
 * A widened strip along a river polyline, subdivided for aerial perspective.
 *
 * The sheet runs `OVER` metres past the waterline on both sides so there can
 * never be a gap where it meets the bank — and every vertex that lands on dry
 * ground is pushed DOWN under that ground, so the visible edge of the water is
 * exactly the contour where the terrain crosses the pool level and nothing
 * disagrees with `isWater()`.
 */
function ribbon(acc, riv, y, terrain) {
  const hw = riv.width / 2 + OVER;
  const pts = riv.pts;
  const COLS = 14;
  let prev = null;
  for (let i = 0; i < pts.length - 1; i++) {
    const a = pts[i];
    const b = pts[i + 1];
    const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
    const steps = Math.max(1, Math.round(len / 34));
    for (let s = i === 0 ? 0 : 1; s <= steps; s++) {
      const t = s / steps;
      const x = a[0] + (b[0] - a[0]) * t;
      const z = a[1] + (b[1] - a[1]) * t;
      // Smooth tangent across the join so the ribbon does not pinch.
      const nx0 = (b[0] - a[0]) / len;
      const nz0 = (b[1] - a[1]) / len;
      const px = -nz0;
      const pz = nx0;
      const row = [];
      for (let c = 0; c <= COLS; c++) {
        const o = (c / COLS - 0.5) * 2 * hw;
        const vx = x + px * o;
        const vz = z + pz * o;
        // Follow the ground down rather than dropping to a fixed depth: a
        // straight dive from the waterline to -1 m cuts THROUGH a bank that
        // climbs faster than it, and the buried sheet reappears as a grey wall
        // along the shore.
        const g = terrain ? terrain.heightAt(vx, vz) : -99;
        const vy = g > y ? g - 0.6 : y;
        row.push(acc.vert(vx, vy, vz, 0, 1, 0, vx * 0.01, vz * 0.01, 0, 0, 0));
      }
      if (prev) for (let c = 0; c < COLS; c++) acc.faceQuad(prev[c], row[c], row[c + 1], prev[c + 1], 0, 1, 0);
      prev = row;
    }
  }
}

/** Two-octave procedural water normal map. No assets, no fetches. */
function makeWaterNormal(size) {
  const data = new Uint8Array(size * size * 4);
  const h = new Float32Array(size * size);
  for (let j = 0; j < size; j++) {
    for (let i = 0; i < size; i++) {
      const u = (i / size) * 8;
      const v = (j / size) * 8;
      // Tile seamlessly by summing on a torus of period 8.
      let s = 0;
      let amp = 1;
      let f = 1;
      let norm = 0;
      for (let o = 0; o < 4; o++) {
        s += amp * pnoise(u * f, v * f, 8 * f, o * 37);
        norm += amp;
        amp *= 0.52;
        f *= 2;
      }
      h[j * size + i] = s / norm;
    }
  }
  for (let j = 0; j < size; j++) {
    for (let i = 0; i < size; i++) {
      const l = h[j * size + ((i - 1 + size) % size)];
      const r = h[j * size + ((i + 1) % size)];
      const d = h[((j - 1 + size) % size) * size + i];
      const uu = h[((j + 1) % size) * size + i];
      const nx = (l - r) * 5.5;
      const ny = (d - uu) * 5.5;
      const nz = 1;
      const inv = 1 / Math.hypot(nx, ny, nz);
      const k = (j * size + i) * 4;
      data[k] = Math.round((nx * inv * 0.5 + 0.5) * 255);
      data[k + 1] = Math.round((ny * inv * 0.5 + 0.5) * 255);
      data[k + 2] = Math.round((nz * inv * 0.5 + 0.5) * 255);
      data[k + 3] = 255;
    }
  }
  const tex = new THREE.DataTexture(data, size, size, THREE.RGBAFormat);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.magFilter = THREE.LinearFilter;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.generateMipmaps = true;
  tex.anisotropy = 8;
  tex.needsUpdate = true;
  return tex;
}

/** Value noise whose integer lattice wraps at `period`, so the tile is seamless. */
function pnoise(x, y, period, seed) {
  const xi = Math.floor(x);
  const yi = Math.floor(y);
  let fx = x - xi;
  let fy = y - yi;
  fx = fx * fx * (3 - 2 * fx);
  fy = fy * fy * (3 - 2 * fy);
  const w = (a, b) => {
    const aa = ((a % period) + period) % period;
    const bb = ((b % period) + period) % period;
    let h = Math.imul(aa | 0, 0x27d4eb2d) ^ Math.imul(bb | 0, 0x85ebca6b) ^ Math.imul(seed, 0x9e3779b1);
    h = Math.imul(h ^ (h >>> 15), 0xc2b2ae35);
    h ^= h >>> 16;
    return (h >>> 0) / 4294967296;
  };
  const a = w(xi, yi);
  const b = w(xi + 1, yi);
  const c = w(xi, yi + 1);
  const d = w(xi + 1, yi + 1);
  return (a + (b - a) * fx) * (1 - fy) + (c + (d - c) * fx) * fy;
}
