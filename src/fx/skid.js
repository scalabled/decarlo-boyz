import * as THREE from 'three';
import { P, D, buildSkidTextures } from './atlas.js';
import { resetSpawn } from './particles.js';
import { clamp } from './util.js';

/**
 * TYRE MARKS AND TYRE SMOKE — the signature driving FX.
 *
 * Two halves, both fed by `vehicle:skid { vehicle, wheel, point, normal, slip,
 * surface }`:
 *
 *  1. **A continuous ribbon.** Not stamped decals. A stamped skid mark is the
 *     single loudest tell of a cheap driving game: it beads, it pops in a dot at
 *     a time, and it cannot follow a drift because each stamp is axis-aligned to
 *     its own normal. Instead every wheel owns a *pen*. Each frame the pen is
 *     down, it extends a triangle strip from the rim pair it left last frame to
 *     the rim pair at the new contact patch, SHARING those two vertices exactly —
 *     so consecutive quads cannot gap however hard the car is turning, and the
 *     texture's V coordinate accumulates by real arc length, which is what makes
 *     a 40 m drift read as one unbroken mark with tread grooves running down it.
 *
 *  2. **What the contact patch throws into the air.** Rubber smoke on tarmac,
 *     dust on dirt, a fine spray on wet tarmac, a thrown sheet of water through
 *     a puddle — each born AT the patch with the patch's own velocity, dragged by
 *     the car's slipstream and then by the wind, lifting as it dilutes, and lit
 *     by the sun AND by the two nearest dynamic lights (see particles.js), so a
 *     burnout at night is lit by its own car's headlights.
 *
 * Costs: one extra draw call for the ribbon mesh, which is a plain
 * MeshStandardMaterial so it takes the renderer's cascades, AO and IBL like any
 * other surface; particles come out of the shared budget.
 */

/** Metres of mark per repeat of the strip texture. */
const V_SCALE = 1.9;
/** Don't emit a segment shorter than this — a stationary wheel would burn the ring. */
const MIN_SEG = 0.055;
/** Longest single segment before we subdivide so the mark follows the camber. */
const MAX_SEG = 0.55;
/** Lift off the road, metres. Enough to beat z-fighting, small enough to hide. */
const LIFT = 0.012;
/** A gap longer than this in time or space lifts the pen. */
const PEN_TIMEOUT = 0.22;
const PEN_JUMP = 3.0;
const MAX_PENS = 20;

const SKID_VERT_CHUNK = /* glsl */ `
#include <common>
attribute vec4 aSkid;
attribute vec4 aTint;
varying vec4 vSkid;
varying vec4 vTint;
`;

/**
 * Per-surface look of the mark itself.
 *  tint      multiplies the baked rubber albedo
 *  rough     added to the baked roughness (dust is matte, wet rubber is not)
 *  opacity   peak coverage at full slip
 *  life      seconds before it is gone
 */
const MARK = {
  asphalt: { tint: [1, 1, 1], rough: 0, opacity: 0.96, life: 260, smoke: 'rubber' },
  concrete: { tint: [1.35, 1.33, 1.3], rough: 0.12, opacity: 0.8, life: 210, smoke: 'rubber' },
  sidewalk: { tint: [1.3, 1.28, 1.26], rough: 0.14, opacity: 0.72, life: 180, smoke: 'rubber' },
  metal: { tint: [0.9, 0.9, 0.92], rough: -0.1, opacity: 0.7, life: 120, smoke: 'rubber' },
  // Loose surfaces do not take rubber — the tyre ploughs, exposing damp
  // sub-surface, so the mark is PALER than the road and matte.
  dirt: { tint: [3.4, 2.7, 2.0], rough: 0.3, opacity: 0.62, life: 90, smoke: 'dust' },
  gravel: { tint: [3.8, 3.5, 3.1], rough: 0.32, opacity: 0.5, life: 70, smoke: 'dust' },
  sand: { tint: [5.2, 4.6, 3.6], rough: 0.3, opacity: 0.55, life: 60, smoke: 'dust' },
  grass: { tint: [2.2, 2.6, 1.5], rough: 0.28, opacity: 0.66, life: 80, smoke: 'dust' },
  water: { tint: [1, 1, 1], rough: 0, opacity: 0, life: 1, smoke: 'water' },
};

class Pen {
  constructor() {
    this.veh = null;
    this.wheel = -1;
    this.down = false;
    this.pending = false;
    this.last = 0;
    this.v = 0;
    this.p = new THREE.Vector3();
    this.l = new THREE.Vector3();
    this.r = new THREE.Vector3();
    this.n = new THREE.Vector3(0, 1, 0);
    this.dir = new THREE.Vector3(0, 0, 1);
    this.vel = new THREE.Vector3();
    this.speed = 0;
    this.width = 0.22;
    this.smokeAcc = 0;
    this.surface = 'asphalt';
    this.age = 1e9;
  }
}

export class SkidSystem {
  /**
   * @param {object} fx      the FxSystem
   * @param {object} o
   * @param {number} o.capacity  ribbon segments (each is one quad)
   */
  constructor(fx, o) {
    this.fx = fx;
    this.capacity = Math.max(64, o.capacity | 0);
    this.vertsPerSeg = 6;
    const maxVerts = this.capacity * this.vertsPerSeg;
    this.cursor = 0;
    this.highWater = 0;
    this.expireAt = -1;
    this._wrapped = false;
    this.laid = 0;

    this.pos = new Float32Array(maxVerts * 3);
    this.nrm = new Float32Array(maxVerts * 3);
    this.uvs = new Float32Array(maxVerts * 2);
    this.skd = new Float32Array(maxVerts * 4);
    this.tnt = new Float32Array(maxVerts * 4);

    const g = new THREE.BufferGeometry();
    const mkAttr = (arr, n) => new THREE.BufferAttribute(arr, n).setUsage(THREE.DynamicDrawUsage);
    this.aPos = mkAttr(this.pos, 3);
    this.aNrm = mkAttr(this.nrm, 3);
    this.aUv = mkAttr(this.uvs, 2);
    this.aSkid = mkAttr(this.skd, 4);
    this.aTint = mkAttr(this.tnt, 4);
    g.setAttribute('position', this.aPos);
    g.setAttribute('normal', this.aNrm);
    g.setAttribute('uv', this.aUv);
    g.setAttribute('aSkid', this.aSkid);
    g.setAttribute('aTint', this.aTint);
    g.setDrawRange(0, 0);
    g.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e7);
    this.geometry = g;

    this.textures = buildSkidTextures(fx.rng.fork(), 256);
    this.uNow = { value: 0 };
    const mat = new THREE.MeshStandardMaterial({
      map: this.textures.albedo,
      normalMap: this.textures.normal,
      roughnessMap: this.textures.orm,
      aoMap: this.textures.orm,
      roughness: 1,
      metalness: 0,
      transparent: true,
      depthWrite: false,
      polygonOffset: true,
      polygonOffsetFactor: -3,
      polygonOffsetUnits: -6,
      side: THREE.DoubleSide,
      envMapIntensity: 0.42,
      normalScale: new THREE.Vector2(0.55, 0.55),
      alphaTest: 0.004,
      dithering: true,
    });
    mat.name = 'fx-skid';
    mat.onBeforeCompile = (shader) => {
      shader.uniforms.uNow = this.uNow;
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', SKID_VERT_CHUNK)
        .replace('#include <begin_vertex>', '#include <begin_vertex>\n\tvSkid = aSkid;\n\tvTint = aTint;');
      shader.fragmentShader = shader.fragmentShader
        .replace(
          '#include <common>',
          '#include <common>\nuniform float uNow;\nvarying vec4 vSkid;\nvarying vec4 vTint;'
        )
        .replace(
          '#include <color_fragment>',
          `#include <color_fragment>
  {
    float n = ( uNow - vSkid.x ) * vSkid.y;
    if ( n < 0.0 || n > 1.0 ) discard;
    // Rubber does not fade evenly: traffic polishes the thin shoulders off
    // first and the dense core last, so the fade is applied as a rising alpha
    // threshold, not a uniform dissolve.
    float f = 1.0 - smoothstep( vSkid.z, 1.0, n );
    diffuseColor.a *= vSkid.w * smoothstep( 0.0, 0.55, diffuseColor.a * ( 0.35 + 0.65 * f ) ) * f;
    diffuseColor.rgb *= vTint.rgb;
    if ( diffuseColor.a < 0.004 ) discard;
  }`
        )
        .replace(
          '#include <roughnessmap_fragment>',
          '#include <roughnessmap_fragment>\n\troughnessFactor = clamp( roughnessFactor + vTint.w, 0.02, 1.0 );'
        );
    };
    mat.customProgramCacheKey = () => 'fx-skid-1';
    this.material = mat;

    this.mesh = new THREE.Mesh(g, mat);
    this.mesh.frustumCulled = false;
    this.mesh.matrixAutoUpdate = false;
    this.mesh.renderOrder = 3; // under bullet-hole decals, over the road
    this.mesh.name = 'fx-skid';
    this.mesh.receiveShadow = false;
    this.mesh.castShadow = false;
    this.mesh.userData.owProbe = true;
    this.mesh.userData.owNoShadow = true;
    this.mesh.visible = false;

    this.pens = [];
    for (let i = 0; i < MAX_PENS; i++) this.pens.push(new Pen());

    // scratch
    this._d = new THREE.Vector3();
    this._lat = new THREE.Vector3();
    this._a = new THREE.Vector3();
    this._b = new THREE.Vector3();
    this._l1 = new THREE.Vector3();
    this._r1 = new THREE.Vector3();
    this._mid = new THREE.Vector3();
    this._vel = new THREE.Vector3();
    this._dirtyLo = Infinity;
    this._dirtyHi = -Infinity;
  }

  /* ===================================================================== */
  /*  pens                                                                 */
  /* ===================================================================== */

  _pen(veh, wheel, now) {
    let free = null;
    let oldest = null;
    for (let i = 0; i < this.pens.length; i++) {
      const p = this.pens[i];
      if (p.veh === veh && p.wheel === wheel) return p;
      if (!free && !p.down) free = p;
      if (!oldest || p.last < oldest.last) oldest = p;
    }
    const p = free ?? oldest;
    p.veh = veh;
    p.wheel = wheel;
    p.down = false;
    p.pending = false;
    p.v = 0;
    p.smokeAcc = 0;
    p.last = now;
    return p;
  }

  /* ===================================================================== */
  /*  the event                                                            */
  /* ===================================================================== */

  /**
   * One `vehicle:skid` sample.
   *
   * Everything that is not in the payload is DERIVED, so this works against a
   * `vehicles` implementation that publishes nothing but the contract: travel
   * direction and patch speed come from the motion of the contact point itself,
   * which is exactly the quantity the smoke needs anyway.
   */
  onSkid(e, now, dt) {
    const pt = e?.point;
    if (!pt) return;
    const slip = clamp(e.slip ?? 1, 0, 3);
    if (slip < 0.06) return;
    const veh = e.vehicle ?? null;
    const wheel = typeof e.wheel === 'number' ? e.wheel : (e.wheel?.index ?? 0);
    const pen = this._pen(veh, wheel, now);
    const surface = e.surface ?? 'asphalt';

    let nx = 0;
    let ny = 1;
    let nz = 0;
    if (e.normal) {
      nx = e.normal.x;
      ny = e.normal.y;
      nz = e.normal.z;
      const l = Math.hypot(nx, ny, nz) || 1;
      nx /= l;
      ny /= l;
      nz /= l;
    }

    const gap = now - pen.last;
    const jumped = pen.down && this._d.copy(pt).sub(pen.p).lengthSq() > PEN_JUMP * PEN_JUMP;
    if (!pen.down || gap > PEN_TIMEOUT || jumped || pen.surface !== surface) {
      // Lift and re-place: start a fresh mark rather than drawing a chord
      // across whatever the car did while it was not sliding.
      pen.down = true;
      pen.pending = true;
      pen.p.copy(pt);
      pen.n.set(nx, ny, nz);
      pen.v = this.fx.rng.float() * 4; // decorrelate the tread phase per mark
      pen.speed = 0;
      pen.vel.set(0, 0, 0);
      pen.smokeAcc = 0;
    }
    pen.last = now;
    pen.surface = surface;

    // ---- travel direction and patch speed -------------------------------
    this._d.copy(pt).sub(pen.p);
    const step = this._d.length();
    if (step > 1e-5) {
      this._d.multiplyScalar(1 / step);
      const h = dt > 1e-4 ? dt : 1 / 60;
      this._vel.copy(this._d).multiplyScalar(step / h);
      // low-pass so one jittery frame does not whip the ribbon
      pen.vel.lerp(this._vel, 0.45);
      pen.speed = pen.vel.length();
      pen.dir.copy(this._d);
    }
    // A payload that DOES carry a velocity wins: it is exact.
    const ev = e.velocity ?? e.vehicle?.velocity;
    if (ev && (ev.x || ev.y || ev.z)) {
      pen.vel.set(ev.x, ev.y, ev.z);
      pen.speed = pen.vel.length();
      if (pen.speed > 0.5 && !pen.pending) pen.dir.copy(pen.vel).multiplyScalar(1 / pen.speed);
    }

    const width = (e.width ?? 0.235) * (1 + Math.min(slip, 1.6) * 0.26);
    const mark = MARK[surface] ?? MARK.asphalt;

    if (pen.pending) {
      // Need a direction before the first rim pair exists. `dirHint` (or a
      // payload velocity) lets us start immediately; otherwise the next sample
      // establishes it, one frame later.
      if (pen.speed > 0.4 || e.dir) {
        if (e.dir) pen.dir.set(e.dir.x, e.dir.y, e.dir.z).normalize();
        this._openStroke(pen, pt, nx, ny, nz, width);
      }
    } else if (step >= MIN_SEG) {
      this._extend(pen, pt, nx, ny, nz, width, mark, slip, now);
    }

    // ---- what the patch throws into the air ------------------------------
    this._airborne(pen, pt, nx, ny, nz, slip, mark.smoke, dt, now, e);
  }

  _openStroke(pen, pt, nx, ny, nz, width) {
    this._lat.set(pen.dir.y * nz - pen.dir.z * ny, pen.dir.z * nx - pen.dir.x * nz, pen.dir.x * ny - pen.dir.y * nx);
    const ll = this._lat.length();
    if (ll < 1e-4) return;
    this._lat.multiplyScalar(width * 0.5 / ll);
    pen.l.copy(pt).sub(this._lat);
    pen.r.copy(pt).add(this._lat);
    pen.l.x += nx * LIFT; pen.l.y += ny * LIFT; pen.l.z += nz * LIFT;
    pen.r.x += nx * LIFT; pen.r.y += ny * LIFT; pen.r.z += nz * LIFT;
    pen.p.copy(pt);
    pen.n.set(nx, ny, nz);
    pen.width = width;
    pen.pending = false;
  }

  _extend(pen, pt, nx, ny, nz, width, mark, slip, now) {
    if (mark.opacity <= 0) {
      pen.p.copy(pt);
      return;
    }
    // Subdivide long steps so a mark laid at 180 km/h still follows the camber
    // instead of bridging it.
    this._d.copy(pt).sub(pen.p);
    const total = this._d.length();
    const steps = Math.min(6, Math.max(1, Math.ceil(total / MAX_SEG)));
    const inv = 1 / steps;
    const fade = 0.5;
    // Darkness and width both rise with slip: a light scrub is a grey smear,
    // a locked wheel is black and half as wide again.
    const op = mark.opacity * clamp(0.46 + slip * 0.54, 0.3, 1);
    const life = mark.life * clamp(0.55 + slip * 0.35, 0.5, 1.15);
    for (let s = 0; s < steps; s++) {
      const f = (s + 1) * inv;
      this._a.copy(pen.p).addScaledVector(this._d, f);
      const w = pen.width + (width - pen.width) * f;
      this._segment(pen, this._a, nx, ny, nz, w, total * inv, op, life, fade, mark, now);
    }
    pen.width = width;
    pen.n.set(nx, ny, nz);
  }

  /** One quad, welded to the pen's previous rim pair. */
  _segment(pen, pt, nx, ny, nz, width, len, op, life, fade, mark, now) {
    this._lat.set(pen.dir.y * nz - pen.dir.z * ny, pen.dir.z * nx - pen.dir.x * nz, pen.dir.x * ny - pen.dir.y * nx);
    const ll = this._lat.length();
    if (ll < 1e-4) return;
    this._lat.multiplyScalar((width * 0.5) / ll);
    this._l1.copy(pt).sub(this._lat);
    this._r1.copy(pt).add(this._lat);
    this._l1.x += nx * LIFT; this._l1.y += ny * LIFT; this._l1.z += nz * LIFT;
    this._r1.x += nx * LIFT; this._r1.y += ny * LIFT; this._r1.z += nz * LIFT;

    const v0 = pen.v;
    const v1 = v0 + len / V_SCALE;

    const slot = this.cursor;
    this.cursor = slot + 1;
    if (this.cursor >= this.capacity) {
      this.cursor = 0;
      this._wrapped = true;
    }
    let w = slot * this.vertsPerSeg;
    const t = mark.tint;
    const rough = mark.rough;
    // two triangles: (l0,r0,r1) (l0,r1,l1)
    this._vert(w++, pen.l, 0, v0, nx, ny, nz, now, life, fade, op, t, rough);
    this._vert(w++, pen.r, 1, v0, nx, ny, nz, now, life, fade, op, t, rough);
    this._vert(w++, this._r1, 1, v1, nx, ny, nz, now, life, fade, op, t, rough);
    this._vert(w++, pen.l, 0, v0, nx, ny, nz, now, life, fade, op, t, rough);
    this._vert(w++, this._r1, 1, v1, nx, ny, nz, now, life, fade, op, t, rough);
    this._vert(w++, this._l1, 0, v1, nx, ny, nz, now, life, fade, op, t, rough);

    pen.l.copy(this._l1);
    pen.r.copy(this._r1);
    pen.p.copy(pt);
    pen.v = v1;

    if (slot < this._dirtyLo) this._dirtyLo = slot;
    if (slot > this._dirtyHi) this._dirtyHi = slot;
    if (slot + 1 > this.highWater) this.highWater = slot + 1;
    if (now + life > this.expireAt) this.expireAt = now + life;
    this.laid++;
  }

  _vert(w, p, u, v, nx, ny, nz, now, life, fade, op, tint, rough) {
    const i3 = w * 3;
    this.pos[i3] = p.x;
    this.pos[i3 + 1] = p.y;
    this.pos[i3 + 2] = p.z;
    this.nrm[i3] = nx;
    this.nrm[i3 + 1] = ny;
    this.nrm[i3 + 2] = nz;
    const i2 = w * 2;
    this.uvs[i2] = u;
    this.uvs[i2 + 1] = v;
    const i4 = w * 4;
    this.skd[i4] = now;
    this.skd[i4 + 1] = 1 / life;
    this.skd[i4 + 2] = fade;
    this.skd[i4 + 3] = op;
    this.tnt[i4] = tint[0];
    this.tnt[i4 + 1] = tint[1];
    this.tnt[i4 + 2] = tint[2];
    this.tnt[i4 + 3] = rough;
  }

  /* ===================================================================== */
  /*  what the contact patch throws into the air                           */
  /* ===================================================================== */

  _airborne(pen, pt, nx, ny, nz, slip, kind, dt, now, e) {
    const fx = this.fx;
    const rng = fx.rng;
    // Rate rises with slip AND with how fast the patch is moving: a stationary
    // burnout smokes hard, a light scrub at 20 km/h barely puffs.
    const load = clamp(slip * 0.75, 0, 1.6) * clamp(0.35 + pen.speed * 0.055, 0.2, 1.5);
    const wet = fx.wetness ?? 0;
    let rate = 100 * load * fx.pScale;
    if (kind === 'rubber' && wet > 0.25) rate *= 1 - wet * 0.55; // wet rubber does not smoke
    pen.smokeAcc += rate * (dt > 1e-4 ? dt : 1 / 60);
    let n = Math.min(12, Math.floor(pen.smokeAcc));
    pen.smokeAcc -= n;
    if (n <= 0) return;

    // The slipstream: the patch's own velocity, halved (the smoke is shed, not
    // carried), plus the sideways kick of the tyre squirming.
    const vx = pen.vel.x;
    const vy = pen.vel.y;
    const vz = pen.vel.z;
    // lateral of travel, for the outward kick out of the wheel arch
    this._lat.set(pen.dir.y * nz - pen.dir.z * ny, pen.dir.z * nx - pen.dir.x * nz, pen.dir.x * ny - pen.dir.y * nx);
    if (this._lat.lengthSq() > 1e-6) this._lat.normalize();
    const side = rng.float() < 0.5 ? -1 : 1;

    const wetKind = kind === 'rubber' && wet > 0.45 ? 'spray' : kind;
    for (let i = 0; i < n; i++) {
      // born ACROSS the contact patch, not at a point
      const j = rng.signed() * 0.11;
      const bx = pt.x + this._lat.x * j + rng.signed() * 0.04;
      const by = pt.y + 0.035 + rng.float() * 0.05;
      const bz = pt.z + this._lat.z * j + rng.signed() * 0.04;
      if (wetKind === 'dust') this._dust(bx, by, bz, vx, vy, vz, side, load, slip, now, dt);
      else if (wetKind === 'spray') this._spray(bx, by, bz, vx, vy, vz, side, load, now, dt);
      else if (wetKind === 'water') this._waterPlume(bx, by, bz, vx, vy, vz, side, load, now, dt);
      else this._rubber(bx, by, bz, vx, vy, vz, side, load, slip, now, dt);
    }

    // Grit and rubber crumbs kicked backwards out from under the tyre.
    if (rng.float() < 0.35 * load) {
      const s = resetSpawn();
      s.x = pt.x; s.y = pt.y + 0.04; s.z = pt.z;
      const back = rng.range(-0.35, -0.08);
      s.vx = vx * back + this._lat.x * side * rng.range(0.4, 1.8) + rng.signed() * 0.5;
      s.vy = rng.range(0.9, 2.6);
      s.vz = vz * back + this._lat.z * side * rng.range(0.4, 1.8) + rng.signed() * 0.5;
      s.tile = P.CHIP;
      s.size0 = rng.range(0.008, 0.022);
      s.size1 = s.size0;
      s.life = rng.range(0.35, 0.85);
      s.drag = 0.9;
      s.gravity = -17;
      s.rot = rng.float() * 6.283;
      s.spin = rng.signed() * 22;
      if (kind === 'dust') {
        s.r0 = 0.2; s.g0 = 0.17; s.b0 = 0.13;
      } else {
        s.r0 = 0.035; s.g0 = 0.033; s.b0 = 0.031;
      }
      s.r1 = s.r0; s.g1 = s.g0; s.b1 = s.b0;
      s.alphaCurve = 0.35;
      s.soft = 0.05;
      s.seed = rng.float();
      fx.emitLit(s);
    }
  }

  /**
   * Vaporised rubber and oil: pale blue-grey, slow, buoyant, wind-carried.
   *
   * Two populations, and the split is what makes it read as a plume with a
   * SOURCE rather than as a drifting sausage:
   *
   *  - a ROOT (every third puff): small, dense, short-lived, launched with
   *    almost none of the car's velocity, so it piles up at the contact patch
   *    and marks where the smoke is being made;
   *  - a BODY: shed at half patch speed, growing hard, living for seconds, and
   *    handed over to the wind once its own momentum is gone.
   *
   * Both are self-shadowed along the sun: a sub-puff thrown into the light
   * starts a stop brighter than one thrown away from it, which is the only way
   * a cluster of billboards acquires a lit side and a shadow side.
   */
  _rubber(x, y, z, vx, vy, vz, side, load, slip, now, dt) {
    const fx = this.fx;
    const rng = fx.rng;
    const sun = fx.sunWorld();
    const root = rng.float() < 0.34;
    const s = resetSpawn();
    s.x = x; s.y = y; s.z = z;
    // Shed at roughly half patch speed, kicked outward and slightly up: this is
    // what puts the plume BEHIND and BESIDE the car instead of on top of it.
    const shed = root ? rng.range(0.04, 0.14) : rng.range(0.32, 0.55);
    const kick = root ? rng.range(0.3, 1.0) : rng.range(0.7, 2.1);
    s.vx = vx * shed + this._lat.x * side * kick + rng.signed() * 0.35;
    s.vy = root ? rng.range(0.25, 0.8) : rng.range(0.55, 1.5);
    s.vz = vz * shed + this._lat.z * side * kick + rng.signed() * 0.35;
    s.tile = rng.float() < 0.86 ? P.PLUME : rng.float() < 0.5 ? P.SMOKE_A : P.SMOKE_B;
    if (root) {
      s.size0 = rng.range(0.1, 0.2);
      s.size1 = rng.range(0.5, 1.0);
      s.sizeCurve = 0.35;
      s.life = rng.range(0.55, 1.2);
      s.drag = rng.range(3.4, 5.0);
    } else {
      s.size0 = rng.range(0.18, 0.34);
      s.size1 = rng.range(1.5, 2.7) * clamp(0.6 + load * 0.5, 0.6, 1.35);
      // 0.42: most of the growth is in the first third of the life, which is
      // what billowing IS. At 0.5 every sprite grew in lockstep and the cloud
      // read as one smudge being zoomed.
      s.sizeCurve = 0.42;
      s.life = rng.range(2.0, 3.9);
      // Loses its own momentum in ~half a second, then it belongs to the wind.
      s.drag = rng.range(2.0, 3.0);
    }
    s.delay = -rng.float() * dt;
    s.gravity = 0.34; // buoyant: hot rubber smoke rises slowly
    s.rot = rng.float() * 6.283;
    s.spin = rng.signed() * 0.55;
    // Self-shadowing: bias the authored colour by which way this puff was
    // thrown relative to the sun. A full stop between the two sides.
    const l = Math.hypot(s.vx, s.vy, s.vz) || 1;
    const lit = 0.62 + 0.76 * Math.max(0, (s.vx * sun.x + s.vy * sun.y + s.vz * sun.z) / l);
    // Tyre smoke is not exhaust — it is pale, faintly blue, and it PALES as it
    // dilutes rather than darkening.
    const d = rng.range(0.2, 0.32) * lit;
    s.r0 = d; s.g0 = d * 1.0; s.b0 = d * 1.06;
    s.r1 = d * 1.9; s.g1 = d * 1.91; s.b1 = d * 2.0;
    s.alpha = rng.range(root ? 0.5 : 0.3, root ? 0.9 : 0.62) * clamp(0.45 + load * 0.55, 0.35, 1);
    // 1.2, not 1.5: at 1.5 a body puff had lost 88% of its opacity by half its
    // life, so the plume was a line of discrete blobs at the source with
    // nothing joining them. Smoke thins slowly and then goes.
    s.alphaCurve = root ? 1.05 : 1.2;
    // 0.22, not 0.9. The soft-particle fade is a depth DIFFERENCE, and tyre
    // smoke is born ON the road: viewed from a chase camera the depth gap
    // between a puff 30 cm up and the tarmac behind it is a few centimetres, so
    // a 0.9 m fade distance erased the entire plume. Ground-hugging smoke needs
    // a short fade — just enough to kill the intersection line.
    s.soft = 0.22;
    s.turb = rng.range(0.2, 0.5);
    s.turbFreq = rng.range(0.5, 0.95);
    s.wind = root ? rng.range(0.2, 0.4) : rng.range(0.7, 0.95);
    s.fadeIn = root ? 0.03 : 0.08;
    s.lightGain = 1.35;
    s.seed = rng.float();
    fx.emitLit(s);
  }

  /** Loose surface: browner, denser, dies faster, barely rises. */
  _dust(x, y, z, vx, vy, vz, side, load, slip, now, dt) {
    const fx = this.fx;
    const rng = fx.rng;
    const s = resetSpawn();
    s.x = x; s.y = y; s.z = z;
    const shed = rng.range(0.3, 0.6);
    s.vx = vx * shed + this._lat.x * side * rng.range(0.9, 2.8) + rng.signed() * 0.4;
    s.vy = rng.range(0.7, 2.0);
    s.vz = vz * shed + this._lat.z * side * rng.range(0.9, 2.8) + rng.signed() * 0.4;
    s.tile = rng.float() < 0.45 ? P.PLUME : P.DUST;
    s.size0 = rng.range(0.14, 0.26);
    s.size1 = rng.range(1.1, 2.3) * clamp(0.6 + load * 0.5, 0.6, 1.3);
    s.sizeCurve = 0.44;
    s.life = rng.range(1.3, 2.6);
    s.delay = -rng.float() * dt;
    s.drag = rng.range(2.4, 3.6);
    s.gravity = -0.55; // dust settles, it does not rise
    s.rot = rng.float() * 6.283;
    s.spin = rng.signed() * 0.9;
    const b = rng.range(0.34, 0.48);
    s.r0 = b; s.g0 = b * 0.85; s.b0 = b * 0.66;
    s.r1 = b * 0.82; s.g1 = b * 0.7; s.b1 = b * 0.55;
    s.alpha = rng.range(0.34, 0.66) * clamp(0.45 + load * 0.55, 0.35, 1);
    s.alphaCurve = 1.6;
    s.soft = 0.2;
    s.turb = rng.range(0.15, 0.4);
    s.turbFreq = rng.range(0.7, 1.3);
    s.wind = rng.range(0.55, 0.85);
    s.fadeIn = 0.06;
    s.lightGain = 1.2;
    s.seed = rng.float();
    fx.emitLit(s);
  }

  /** Wet tarmac: a fine white aerosol that is gone in under a second. */
  _spray(x, y, z, vx, vy, vz, side, load, now, dt) {
    const fx = this.fx;
    const rng = fx.rng;
    const s = resetSpawn();
    s.x = x; s.y = y; s.z = z;
    const shed = rng.range(0.45, 0.8);
    s.vx = vx * shed + this._lat.x * side * rng.range(1.0, 3.0);
    s.vy = rng.range(0.8, 2.2);
    s.vz = vz * shed + this._lat.z * side * rng.range(1.0, 3.0);
    s.tile = rng.float() < 0.6 ? P.MIST : P.PLUME;
    s.size0 = rng.range(0.1, 0.2);
    s.size1 = rng.range(0.7, 1.5);
    s.sizeCurve = 0.4;
    s.life = rng.range(0.45, 1.05);
    s.delay = -rng.float() * dt;
    s.drag = rng.range(3.4, 5.2);
    s.gravity = -1.4;
    s.rot = rng.float() * 6.283;
    s.spin = rng.signed() * 1.4;
    const b = rng.range(0.55, 0.78);
    s.r0 = b; s.g0 = b * 1.01; s.b0 = b * 1.04;
    s.r1 = b * 0.8; s.g1 = b * 0.81; s.b1 = b * 0.85;
    s.alpha = rng.range(0.18, 0.4) * clamp(0.4 + load * 0.6, 0.3, 1);
    s.alphaCurve = 1.8;
    s.soft = 0.18;
    s.turb = rng.range(0.1, 0.3);
    s.turbFreq = 1.5;
    s.wind = rng.range(0.6, 0.9);
    s.fadeIn = 0.05;
    s.lightGain = 1.9; // spray in a headlight beam is the whole point
    s.seed = rng.float();
    fx.emitLit(s);
  }

  /** Standing water: a thrown sheet, velocity-aligned, plus separated drops. */
  _waterPlume(x, y, z, vx, vy, vz, side, load, now, dt) {
    const fx = this.fx;
    const rng = fx.rng;
    const s = resetSpawn();
    s.x = x; s.y = y; s.z = z;
    // Water leaves the patch nearly sideways and much faster than smoke.
    s.vx = vx * rng.range(0.25, 0.5) + this._lat.x * side * rng.range(2.5, 6.5);
    s.vy = rng.range(1.4, 3.6);
    s.vz = vz * rng.range(0.25, 0.5) + this._lat.z * side * rng.range(2.5, 6.5);
    s.tile = P.SPRAY;
    s.size0 = rng.range(0.14, 0.28);
    s.size1 = rng.range(0.5, 1.1);
    s.sizeCurve = 0.55;
    s.stretch = 0.16; // aligned to its own flight: a sheet, not a ball
    s.life = rng.range(0.4, 0.85);
    s.delay = -rng.float() * dt;
    s.drag = 2.1;
    s.gravity = -13;
    const b = rng.range(0.62, 0.86);
    s.r0 = b * 0.94; s.g0 = b * 0.99; s.b0 = b;
    s.r1 = b * 0.72; s.g1 = b * 0.76; s.b1 = b * 0.8;
    s.alpha = rng.range(0.28, 0.6);
    s.alphaCurve = 1.3;
    s.soft = 0.3;
    s.lightGain = 2.1;
    s.fadeIn = 0.03;
    s.seed = rng.float();
    fx.emitLit(s);

    if (rng.float() < 0.4) {
      const d = resetSpawn();
      d.x = x; d.y = y + 0.05; d.z = z;
      d.vx = s.vx * rng.range(0.9, 1.6);
      d.vy = rng.range(2.2, 5.0);
      d.vz = s.vz * rng.range(0.9, 1.6);
      d.tile = P.DROPLET;
      d.size0 = rng.range(0.012, 0.032);
      d.size1 = d.size0;
      d.stretch = 0.3;
      d.life = rng.range(0.4, 0.95);
      d.drag = 0.5;
      d.gravity = -16;
      d.r0 = 0.7; d.g0 = 0.76; d.b0 = 0.8;
      d.r1 = 0.6; d.g1 = 0.66; d.b1 = 0.7;
      d.alpha = 0.75;
      d.alphaCurve = 0.6;
      d.soft = 0.06;
      d.lightGain = 2.4;
      d.seed = rng.float();
      fx.emitLit(d);
    }
    if (rng.float() < 0.12) {
      fx.addDecal2(x, y, z, 0, 1, 0, {
        tile: D.RIPPLE,
        size: rng.range(0.5, 1.1),
        life: 3.5,
        fade: 0.2,
        opacity: 0.6,
        maxAngle: 40,
      });
    }
  }

  /* ===================================================================== */

  update(dt, now) {
    for (let i = 0; i < this.pens.length; i++) {
      const p = this.pens[i];
      if (p.down && now - p.last > PEN_TIMEOUT) {
        p.down = false;
        p.veh = null;
        p.wheel = -1;
      }
    }
  }

  flush(now) {
    this.uNow.value = now;
    if (this._dirtyHi >= this._dirtyLo) {
      const vps = this.vertsPerSeg;
      const start = this._dirtyLo * vps;
      const count = (this._dirtyHi - this._dirtyLo + 1) * vps;
      this.aPos.addUpdateRange(start * 3, count * 3);
      this.aPos.needsUpdate = true;
      this.aNrm.addUpdateRange(start * 3, count * 3);
      this.aNrm.needsUpdate = true;
      this.aUv.addUpdateRange(start * 2, count * 2);
      this.aUv.needsUpdate = true;
      this.aSkid.addUpdateRange(start * 4, count * 4);
      this.aSkid.needsUpdate = true;
      this.aTint.addUpdateRange(start * 4, count * 4);
      this.aTint.needsUpdate = true;
      this._dirtyLo = Infinity;
      this._dirtyHi = -Infinity;
    }
    const verts = (this._wrapped ? this.capacity : this.highWater) * this.vertsPerSeg;
    this.geometry.setDrawRange(0, verts);
    this.mesh.visible = verts > 0 && now < this.expireAt;
  }

  dispose() {
    this.geometry.dispose();
    this.material.dispose();
    this.textures.albedo.dispose();
    this.textures.normal.dispose();
    this.textures.orm.dispose();
  }
}
