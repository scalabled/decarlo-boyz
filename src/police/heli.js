/**
 * POLICE — the four-star helicopter.
 *
 * Air support changes the shape of the chase rather than adding another car:
 * a cruiser loses you at a corner, and a spotter 60 m up does not. It is the
 * reason four stars feels different from three even when the same number of
 * cars are on the ground — you cannot break line of sight by turning, you have
 * to break it by going UNDER something, which in Steel City means a bridge, a
 * mill shed or a multi-storey.
 *
 * `vehicles` owns cars, bikes and boats; there is no rotorcraft class and this
 * one aircraft does not justify one, so the airframe is built here. It is a
 * lofted fuselage, a tapered boom, real skids, four blades and a rotor disc —
 * roughly 3k triangles and nine draw calls, present only at four stars and
 * above.
 */

import * as THREE from 'three';
import { clamp, angDiff } from './tune.js';

const _v = new THREE.Vector3();
const _t = new THREE.Vector3();
const _c = new THREE.Vector3();

/* ====================================================================== */
/* Searchlight                                                            */
/* ====================================================================== */

/**
 * THE SEARCHLIGHT, AND WHY IT USED TO EAT THE FRAME.
 *
 * It was a cone mesh with a flat MeshBasicMaterial, additive, double sided.
 * Every fragment of it added the SAME constant to the HDR buffer, so:
 *
 *   - the cone had a hard polygon silhouette you could trace across the sky and
 *     across building faces, because a constant has no edge;
 *   - nothing inside it had any falloff, along the beam or across it;
 *   - and when the beam was pointed at YOU — which is the only time a player
 *     ever sees it up close — the camera stood inside the cone, so the far wall
 *     of the mesh covered most of the screen and washed a constant over the
 *     whole frame.
 *
 * MEASURED on the repro — night 21:21, overcast, tier `low`, five stars, beam
 * on the player, 1600x900 — old cone against new, A/B'd inside one build and
 * one browser run by `src/police/_beamprobe.mjs --legacy=1`:
 *
 *                                    OLD       NEW
 *   frame at or above 0.5 luma      23.6%      3.5%
 *   local contrast in that region   0.021      0.117   (material vs no material)
 *   frame at or below 0.02 luma      1.30%     0.04%   (the crushed half)
 *   metered exposure                 2.43      4.25    (it stopped down on itself)
 *   a downtown tower facade      0.418 cream  0.119 grey-blue
 *   the night sky above it       0.429 cream  0.078 blue
 *
 * The tower and the sky metering the SAME cream, 0.42, with a standard
 * deviation of 0.03 across a whole facade, is the defect as a number: that is
 * not a lit building, it is a building that has been painted over. The meter
 * then stopped down against the glare and took the unwashed half of the frame
 * to black with it — a screen split into cream and black.
 *
 * So the shaft is now a real volume approximation, and the surfaces under it
 * are lit by a real punctual light instead of being painted over:
 *
 *   `soft`  abs(dot(N, V)) is a cheap proxy for how much of the cone volume a
 *           view ray crosses: 1 down the middle of the shaft, 0 at the
 *           silhouette. That IS the penumbra, and it costs one dot product.
 *           It also fixes the standing-in-the-beam case for free — looking up
 *           the axis every visible wall is edge-on, so the wash collapses.
 *   `fall`  inverse-square in metres from the lamp along the beam axis.
 *   `near`  fade over the first few metres from the lens, so a wall of light
 *           can never be pressed against the camera.
 *   light   `render.submitLight` puts one of the renderer's real punctual
 *           slots at the ground spot, so asphalt inside the pool keeps its
 *           albedo, its road paint and its normal map. Lit, not replaced.
 */
const BEAM = {
  /** Master additive gain of the shaft, in linear HDR, before the night fade. */
  gain: 0.16,
  /** Metres from the lamp at which the shaft has fallen to half. */
  refM: 34,
  /** Penumbra shaping exponent on the path-length proxy. Higher = tighter core. */
  edge: 2.6,
  /** Camera-proximity fade, metres: nothing at x, full shaft by y. */
  nearM: [1.5, 10],
  /**
   * What is left of the shaft when the camera is INSIDE the cone.
   *
   * Standing in the beam there is almost no lit air between your eye and the
   * ground — the shaft is above and around you, not in front of you — so the
   * screen should show a blinding pool at your feet and a glare around the
   * lamp, NOT a wall of light. This is also the exact case the player
   * screenshotted, so it is the one that has to be right.
   */
  insideFloor: 0.2,
  /** Cone half-angle as a fraction of the beam length (radius = len * spread). */
  spread: 0.075,
  tint: [1.0, 0.86, 0.62],

  /**
   * Ground pool: the real light. Height above the spot, metres.
   *
   * This is the pool's SHAPE control, not its brightness: with the cosine and
   * the inverse square, ground illuminance halves 0.77 * height out from the
   * spot, so 14 m draws a pool about 21 m across — what a Nightsun throws from
   * 60 m up. Raising it flattens the pool into ambient lift; lowering it turns
   * it into a hot dot.
   */
  lightHeight: 14,
  /**
   * Candela, three's physical point-light units. A street sodium lamp is 46.
   *
   * MEASURED on the repro frame (beam on the player, tier `low`, 1600x900),
   * mean display luma of the asphalt inside the pool / fraction of the frame
   * at or above 0.98 luma:
   *      900 cd -> 0.360 / 0.001%     1150 cd -> 0.397 / 0.020%
   *     1400 cd -> 0.428 / 0.081%
   * 1150 puts the pool clearly above the unlit road (0.246) with headroom left
   * in the highlights, and what little does clip is the specular streak down a
   * chrome pipe, which is a bright core and not a blown region: that rect
   * measures std 0.25, i.e. it is still full of form.
   */
  lightIntensity: 1150,
  /**
   * Metres. Two jobs: `submitLight` will not even score a light further than
   * this from the camera, so it also decides how far away a beam can be and
   * still put a pool on the ground. It bounds the spill as well — a punctual
   * light casts no shadow — and so does the physics: at 40 m the inverse square
   * has taken 1150 cd down to 0.7, and three's range window on top of that
   * halves it again. Measured live at five stars, the light correctly holds no
   * slot at all while the beam is 200 m up the street and takes one as it
   * closes.
   */
  lightRange: 55,
  /** Beats street practicals, loses to a muzzle flash. */
  lightPriority: 6,
  lightColor: 0xffe8c4,
};

const BEAM_VERT = /* glsl */ `
varying vec3 vViewPos;
varying vec3 vViewNrm;
varying float vAxial;

void main() {
  // The cone is built apex-at-origin running to -Y over one unit, so -y is the
  // fraction of the way from the lamp to the ground.
  vAxial = clamp( -position.y, 0.0, 1.0 );
  vec4 mv = modelViewMatrix * vec4( position, 1.0 );
  vViewPos = mv.xyz;
  // normalMatrix is the inverse transpose, which matters here: the cone is
  // scaled hard non-uniformly (radius vs length) every single frame.
  vViewNrm = normalize( normalMatrix * normal );
  gl_Position = projectionMatrix * mv;
}
`;

const BEAM_FRAG = /* glsl */ `
precision highp float;

// x: beam length in metres, y: inverse-square reference distance in metres,
// z: penumbra exponent, w: master gain.
uniform vec4 uBeam;
uniform vec3 uTint;
// Camera-proximity fade in metres: x start, y full.
uniform vec2 uNear;

varying vec3 vViewPos;
varying vec3 vViewNrm;
varying float vAxial;

layout(location = 0) out vec4 outColor;

void main() {
  float dist = length( vViewPos );
  vec3 V = vViewPos / max( dist, 1e-4 );
  // How much of the cone volume this view ray crosses, approximated by how
  // square-on the wall is. 1 down the axis of the shaft, 0 at the silhouette,
  // so the edge is a penumbra and not a polygon boundary.
  float soft = pow( abs( dot( normalize( vViewNrm ), V ) ), uBeam.z );
  // Inverse-square along the beam, plus a short ramp off the lamp itself so
  // the apex is not a point of infinite brightness.
  float d = vAxial * uBeam.x;
  float ref2 = uBeam.y * uBeam.y;
  float fall = ref2 / ( ref2 + d * d );
  fall *= smoothstep( 0.0, 0.08, vAxial );
  float a = uBeam.w * soft * fall * smoothstep( uNear.x, uNear.y, dist );
  if ( a <= 0.0015 ) discard;
  // Premultiplied: the material blends One / One, so this adds exactly
  // tint * a to the HDR buffer and nothing is scaled twice.
  outColor = vec4( uTint * a, a );
}
`;

export class Helicopter {
  constructor(sys) {
    this.sys = sys;
    this.root = new THREE.Group();
    this.root.name = 'police_heli';
    this.root.visible = false;
    this.active = false;

    this.position = new THREE.Vector3();
    this.velocity = new THREE.Vector3();
    this.yaw = 0;
    this.roll = 0;
    this.pitch = 0;
    this.orbit = 0;
    this.rotor = 0;
    this.los = false;
    this._geos = [];
    this._mats = [];
    this._built = false;
    this._light = null;
    this._target = new THREE.Vector3();
    /** World-space point the beam lands on, and the strength of the beam 0..1. */
    this._spot = new THREE.Vector3();
    this.beamOn = 0;
    /** The searchlight's tuning table, live: every value is read per frame, so
     *  `police.heli.beamTuning.lightIntensity = 900` in the console retunes it
     *  without a reload. This is how the shipped numbers were measured. */
    this.beamTuning = BEAM;
  }

  /* ==================================================================== */
  /* Build                                                                */
  /* ==================================================================== */

  build(ctx) {
    if (this._built) return;
    this._built = true;
    const mats = ctx.peek('materials');

    const own = (m) => { this._mats.push(m); return m; };
    const shared = (name, opts, fallback) => {
      const m = mats?.get?.(name, opts);
      return m ?? own(fallback());
    };

    const bodyMat = mats?.carPaint
      ? own(mats.carPaint(0x0d1220, { finish: 'gloss' }))
      : own(new THREE.MeshStandardMaterial({ color: 0x0d1220, roughness: 0.34, metalness: 0 }));
    const glassMat = shared('glass', { scale: 0.4 }, () =>
      new THREE.MeshStandardMaterial({
        color: 0x10161e, roughness: 0.08, metalness: 0, transparent: true, opacity: 0.72,
      }));
    const metalMat = shared('metal_brushed', { scale: 0.5 }, () =>
      new THREE.MeshStandardMaterial({ color: 0x7c828a, roughness: 0.36, metalness: 1 }));
    const bladeMat = shared('rubber', { scale: 0.6 }, () =>
      new THREE.MeshStandardMaterial({ color: 0x14161a, roughness: 0.72, metalness: 0 }));

    /* ---- fuselage ---------------------------------------------------- */
    const fus = loft(
      [
        [3.30, 0.10, 0.12, 0.06],
        [2.95, 0.52, 0.48, 0.02],
        [2.15, 0.90, 0.78, 0.05],
        [1.00, 1.04, 0.92, 0.10],
        [-0.25, 1.04, 0.95, 0.12],
        [-1.25, 0.86, 0.78, 0.17],
        [-2.05, 0.54, 0.49, 0.23],
        [-2.65, 0.32, 0.30, 0.27],
      ],
      18
    );
    this._add(fus, bodyMat, true);

    /* ---- canopy: a slightly larger shell over the front three rings --- */
    const glass = loft(
      [
        [3.24, 0.16, 0.18, 0.14],
        [2.90, 0.54, 0.52, 0.12],
        [2.10, 0.92, 0.82, 0.16],
        [1.05, 1.02, 0.92, 0.24],
        [0.55, 0.98, 0.86, 0.28],
      ],
      18,
      { openEnds: true, only: 'upper' }
    );
    const gm = this._add(glass, glassMat, false);
    gm.userData.owNoShadow = true;

    /* ---- tail boom ---------------------------------------------------- */
    this._add(tube(-2.55, -6.40, 0.21, 0.115, 0.30, 12), metalMat, true);
    /* vertical fin */
    this._add(slab(0.05, 0.62, -6.05, -6.65, 0.34, 1.55), metalMat, true);
    /* horizontal stabiliser */
    this._add(slab(1.05, 0.055, -5.45, -5.95, 0.44, 0.0), metalMat, true);

    /* ---- skids -------------------------------------------------------- */
    for (const sx of [-1, 1]) {
      const g = tubeX(sx * 0.92, 2.0, -2.1, 0.055, 0.055, -1.02, 10);
      this._add(g, metalMat, true);
      for (const sz of [1.35, -1.15]) {
        this._add(strut(sx * 0.92, -1.02, sz, sx * 0.42, -0.05, sz * 0.86, 0.045), metalMat, true);
      }
    }

    /* ---- rotor -------------------------------------------------------- */
    this._add(tube(0.35, -0.15, 0.10, 0.10, 1.02, 8), metalMat, true);
    this.rotorGroup = new THREE.Group();
    this.rotorGroup.position.set(0, 1.16, 0.10);
    this.root.add(this.rotorGroup);
    for (let i = 0; i < 4; i++) {
      const blade = slab(0.16, 0.028, 0.0, -5.6, 0.0, 0.0);
      const m = new THREE.Mesh(blade, bladeMat);
      m.rotation.y = (i / 4) * Math.PI * 2;
      m.userData.owNoShadow = true;
      this._geos.push(blade);
      this.rotorGroup.add(m);
    }
    // The disc: what you actually see of a turning rotor from the ground.
    const discGeo = new THREE.RingGeometry(1.1, 5.6, 40, 1);
    discGeo.rotateX(-Math.PI / 2);
    const discMat = own(new THREE.MeshBasicMaterial({
      color: 0x2a2f36,
      transparent: true,
      opacity: 0.16,
      side: THREE.DoubleSide,
      depthWrite: false,
    }));
    this.disc = new THREE.Mesh(discGeo, discMat);
    this.disc.position.set(0, 1.18, 0.10);
    this.disc.userData.owNoShadow = true;
    this.disc.userData.owNoPrepass = true;
    this._geos.push(discGeo);
    this.root.add(this.disc);

    /* tail rotor */
    const trGeo = new THREE.RingGeometry(0.12, 0.62, 18, 1);
    const trMat = own(new THREE.MeshBasicMaterial({
      color: 0x22262c, transparent: true, opacity: 0.22, side: THREE.DoubleSide, depthWrite: false,
    }));
    this.tailRotor = new THREE.Mesh(trGeo, trMat);
    this.tailRotor.position.set(0.26, 0.62, -6.45);
    this.tailRotor.rotation.y = Math.PI / 2;
    this.tailRotor.userData.owNoShadow = true;
    this._geos.push(trGeo);
    this.root.add(this.tailRotor);

    /* ---- strobes ------------------------------------------------------ */
    const bulb = new THREE.SphereGeometry(0.085, 8, 6);
    this._geos.push(bulb);
    this.strobes = [];
    for (const [x, y, z, col] of [
      [-1.06, 0.12, 0.2, 0xff2418],
      [1.06, 0.12, 0.2, 0x1f6bff],
      [0, 0.42, -6.5, 0xffffff],
    ]) {
      const m = own(new THREE.MeshStandardMaterial({
        color: 0x101010, emissive: col, emissiveIntensity: 6, roughness: 0.4, metalness: 0,
      }));
      const mesh = new THREE.Mesh(bulb, m);
      mesh.position.set(x, y, z);
      mesh.userData.owNoShadow = true;
      this.root.add(mesh);
      this.strobes.push({ mesh, mat: m, phase: this.strobes.length * 0.66 });
    }

    /* ---- searchlight cone --------------------------------------------- */
    // 40 radial segments, not 22: the penumbra is computed from the wall's
    // normal, so faceting in the normal is faceting in the soft edge.
    const cone = new THREE.ConeGeometry(1, 1, 40, 1, true);
    cone.translate(0, -0.5, 0);
    this._geos.push(cone);
    this.beamMat = own(new THREE.ShaderMaterial({
      name: 'police-searchlight',
      glslVersion: THREE.GLSL3,
      uniforms: {
        uBeam: { value: new THREE.Vector4(60, BEAM.refM, BEAM.edge, 0) },
        uTint: { value: new THREE.Vector3().fromArray(BEAM.tint) },
        uNear: { value: new THREE.Vector2(BEAM.nearM[0], BEAM.nearM[1]) },
      },
      vertexShader: BEAM_VERT,
      fragmentShader: BEAM_FRAG,
      transparent: true,
      depthTest: true,
      depthWrite: false,
      side: THREE.DoubleSide,
      toneMapped: false,
      // One / One on a premultiplied output: the shaft ADDS light to the HDR
      // buffer and can never scale what is behind it.
      blending: THREE.CustomBlending,
      blendSrc: THREE.OneFactor,
      blendDst: THREE.OneFactor,
      blendEquation: THREE.AddEquation,
    }));
    this.beam = new THREE.Mesh(cone, this.beamMat);
    this.beam.renderOrder = 12;
    this.beam.userData.owNoShadow = true;
    this.beam.userData.owNoPrepass = true;
    this.beam.frustumCulled = false;
    this.root.add(this.beam);

    ctx.scene.add(this.root);
    ctx.peek('render')?.patchMaterials?.(this.root);
  }

  _add(geo, mat, shadow) {
    const m = new THREE.Mesh(geo, mat);
    if (!shadow) m.userData.owNoShadow = true;
    this._geos.push(geo);
    this.root.add(m);
    return m;
  }

  /* ==================================================================== */
  /* Flight                                                               */
  /* ==================================================================== */

  launch(ctx, from) {
    this.build(ctx);
    this.active = true;
    this.root.visible = true;
    // Comes in from off to one side and high, so it is never "just there".
    const a = this.sys.rng.float() * Math.PI * 2;
    this.position.set(
      from.x + Math.cos(a) * 300,
      this.sys.groundAt(from.x, from.z, from.y + 200) + 120,
      from.z + Math.sin(a) * 300
    );
    this.velocity.set(0, 0, 0);
    this.orbit = a;
    this.yaw = a;
  }

  stand(ctx) {
    this.active = false;
    this.root.visible = false;
    this.los = false;
    // Stop asking for a light slot the moment the airframe leaves.
    this.beamOn = 0;
  }

  update(dt, ctx) {
    if (!this.active) return;
    const sys = this.sys;
    const q = sys.quarry;
    const w = sys.meter;

    // Orbit whatever the police believe is the target: the quarry while they
    // can see it, the last known position while they cannot.
    if (w.hasKnown) this._target.copy(w.known);
    else if (q.valid) this._target.copy(q.position);

    const groundY = sys.groundAt(this._target.x, this._target.z, this.position.y + 40);
    const R = w.seen ? 62 : 95;
    const alt = groundY + (w.seen ? 58 : 78);
    this.orbit += dt * (w.seen ? 0.30 : 0.19);

    const wantX = this._target.x + Math.cos(this.orbit) * R;
    const wantZ = this._target.z + Math.sin(this.orbit) * R;

    // Critically damped approach — a helicopter leans into its acceleration
    // and that lean is most of what sells it, so we keep the acceleration.
    const k = 0.55;
    const ax = (wantX - this.position.x) * k - this.velocity.x * 1.15;
    const az = (wantZ - this.position.z) * k - this.velocity.z * 1.15;
    const ay = (alt - this.position.y) * 0.9 - this.velocity.y * 1.5;
    this.velocity.x += ax * dt;
    this.velocity.y += ay * dt;
    this.velocity.z += az * dt;
    const sp = Math.hypot(this.velocity.x, this.velocity.z);
    const maxSp = 46;
    if (sp > maxSp) {
      this.velocity.x *= maxSp / sp;
      this.velocity.z *= maxSp / sp;
    }
    this.position.addScaledVector(this.velocity, dt);

    /* ---- attitude ----------------------------------------------------- */
    const wantYaw = sp > 3 ? Math.atan2(this.velocity.x, this.velocity.z) : this.yaw;
    const dy = angDiff(this.yaw, wantYaw);
    this.yaw += clamp(dy, -1.6 * dt, 1.6 * dt);
    // Bank into the turn; pitch nose-down under acceleration.
    const fx = Math.sin(this.yaw);
    const fz = Math.cos(this.yaw);
    const latA = ax * -fz + az * fx;
    const lonA = ax * fx + az * fz;
    this.roll += (clamp(-latA * 0.055, -0.5, 0.5) - this.roll) * Math.min(1, dt * 2.4);
    this.pitch += (clamp(-lonA * 0.028, -0.28, 0.28) - this.pitch) * Math.min(1, dt * 2.4);

    this.root.position.copy(this.position);
    this.root.rotation.set(this.pitch, this.yaw, this.roll, 'YXZ');

    this.rotor += dt * 34;
    this.rotorGroup.rotation.y = this.rotor;
    this.tailRotor.rotation.z = -this.rotor * 2.4;
    this.disc.rotation.y = this.rotor * 0.3;

    const t = ctx.time.elapsed;
    for (let i = 0; i < this.strobes.length; i++) {
      const s = this.strobes[i];
      const ph = (t * 1.35 + s.phase) % 1;
      s.mat.emissiveIntensity = ph < 0.11 ? 9 : 0.15;
    }

    /* ---- searchlight -------------------------------------------------- */
    this._aimBeam(ctx, groundY);

    /* ---- eyes ---------------------------------------------------------
     * `police._sight` owns this: it is one of three inputs to `_seen` and they
     * all have to be tested on the same tick, or a stale one stamps the last
     * known position with a place nobody looked at. See the note there.
     */
  }

  /**
   * The beam is a cone from the airframe to a point on the ground under the
   * target. Only lit at night — a searchlight in daylight reads as a bug.
   */
  _aimBeam(ctx, groundY) {
    const sky = ctx.peek('sky');
    const alt = sky?.sunAltitude ?? 0.6;
    const night = clamp(1 - (alt + 0.02) / 0.14, 0, 1);
    const on = night * (this.sys.meter.seen ? 1 : 0.55);
    this.beamOn = on;
    this.beam.visible = on > 0.02;
    // The ground pool is a real light and has to be resubmitted every frame,
    // whether or not the shaft mesh itself ends up on screen.
    this._spot.set(this._target.x, groundY + 0.05, this._target.z);
    this._submitBeamLight(ctx);
    if (!this.beam.visible) return;

    _t.copy(this._spot);
    _v.subVectors(_t, this.position);
    const len = Math.max(4, _v.length());
    const radius = Math.max(2.2, len * BEAM.spread);
    const u = this.beamMat.uniforms;
    u.uBeam.value.x = len;
    // The cone is built pointing -Y with its apex at the origin.
    this.beam.position.set(0, -0.2, 0.9);
    this.beam.scale.set(radius, len, radius);
    // Undo the airframe's rotation, then aim down the world-space beam vector.
    _v.multiplyScalar(1 / len);

    // Is the camera standing in the beam? `r` is 0 on the axis and 1 on the
    // cone wall, so this fades the shaft out as the player walks into it. See
    // BEAM.insideFloor.
    ctx.camera.getWorldPosition(_c).sub(this.position);
    const along = _c.dot(_v);
    const perp = Math.sqrt(Math.max(0, _c.lengthSq() - along * along));
    const r = along > 0.5 ? perp / Math.max(0.05, (along / len) * radius) : 9;
    const outside = clamp((r - 0.65) / 0.85, 0, 1);
    u.uBeam.value.w = BEAM.gain * on * (BEAM.insideFloor + (1 - BEAM.insideFloor) * outside);
    const pitch = Math.asin(clamp(-_v.y, -1, 1));
    const yaw = Math.atan2(_v.x, _v.z);
    this.beam.rotation.set(0, 0, 0);
    this.beam.quaternion.setFromEuler(
      _EULER.set(-(Math.PI / 2 - pitch), yaw, 0, 'YXZ')
    );
    this.root.updateMatrixWorld(false);
    // Convert the world aim into the airframe's local frame.
    _q1.setFromEuler(_EULER2.set(this.pitch, this.yaw, this.roll, 'YXZ')).invert();
    this.beam.quaternion.premultiply(_q1);
  }

  /**
   * The ground pool: one of the renderer's `q.lightSlots` REAL punctual lights,
   * resubmitted every frame (there is no handle to hold — see ARCHITECTURE.md),
   * hung above the spot the beam lands on.
   *
   * This is the half of the searchlight that makes surfaces LIT rather than
   * painted over. Asphalt inside the pool keeps its albedo, its lane paint and
   * its normal map, because it is being shaded, not composited on top of.
   *
   * It is a POINT light because that is the whole of the sanctioned API, so it
   * casts no shadow and will spill slightly through a wall it is standing next
   * to. `lightRange` and the visibility gate below are what bound that, and it
   * is the reason the range is 55 m rather than the 200 m a real Nightsun
   * would carry.
   */
  _submitBeamLight(ctx) {
    if (!(this.beamOn > 0.02)) return;
    const r = ctx.peek('render');
    if (!r?.submitLight) return;
    // A punctual light casts no shadow, so it would happily light the inside of
    // the building you are hiding in while the beam sweeps the street outside
    // — which is not just a rendering artefact, it is the counter-play to the
    // helicopter being deleted. Gate it on the camera actually being able to
    // see the spot, refreshed at 4 Hz like the spotter's own eyes. Dropping the
    // submission fades the slot out over ~0.15 s, so this cannot pop.
    this._litTimer = (this._litTimer ?? 0) - (ctx.time?.dt ?? 0);
    if (this._litTimer <= 0) {
      this._litTimer = 0.25;
      ctx.camera.getWorldPosition(_c);
      this._litVisible = this.sys.rayVisible(_c, this._spot, 0.5);
    }
    if (this._litVisible === false) return;
    r.submitLight(
      this._spot.x,
      this._spot.y + BEAM.lightHeight,
      this._spot.z,
      BEAM.lightColor,
      BEAM.lightIntensity * this.beamOn,
      BEAM.lightRange,
      BEAM.lightPriority,
      HELI_LIGHT_KEY
    );
  }

  /**
   * Light-only tick. A staged tableau (`police.debugStage`) freezes flight, but
   * the renderer's punctual slots are a per-frame auction, so the pool has to
   * keep being submitted or the ground under a staged beam goes unlit.
   */
  beamFrame(ctx) {
    if (!this.active || !this._built) return;
    this._submitBeamLight(ctx);
  }

  dispose() {
    for (const g of this._geos) g.dispose();
    this._geos.length = 0;
    for (const m of this._mats) m.dispose();
    this._mats.length = 0;
    this.root.parent?.remove(this.root);
    this._built = false;
  }
}

const _EULER = new THREE.Euler();
const _EULER2 = new THREE.Euler();
const _q1 = new THREE.Quaternion();
/** Stable id for the searchlight's slot request, so its fade follows it. */
const HELI_LIGHT_KEY = 74011;

/* ====================================================================== */
/* Geometry helpers                                                       */
/* ====================================================================== */

/**
 * Loft a set of elliptical rings along Z. Each section is
 * `[z, radiusX, radiusY, centreY]`. Returns a closed hull unless `openEnds`.
 * `only:'upper'` keeps the top half only, which is what a canopy is.
 */
function loft(sections, radial = 16, opts = {}) {
  const g = new THREE.BufferGeometry();
  const pos = [];
  const nrm = [];
  const uv = [];
  const rings = [];
  const half = opts.only === 'upper';
  const steps = half ? radial >> 1 : radial;

  for (const [z, rx, ry, cy] of sections) {
    const ring = [];
    for (let i = 0; i <= steps; i++) {
      const a = half
        ? Math.PI * (i / steps)
        : (i / steps) * Math.PI * 2;
      ring.push([Math.cos(a) * rx, cy + Math.sin(a) * ry, z, Math.cos(a) / Math.max(0.05, rx), Math.sin(a) / Math.max(0.05, ry)]);
    }
    rings.push(ring);
  }

  for (let s = 0; s < rings.length - 1; s++) {
    const A = rings[s];
    const B = rings[s + 1];
    for (let i = 0; i < A.length - 1; i++) {
      const a = A[i];
      const b = A[i + 1];
      const c = B[i + 1];
      const d = B[i];
      quad(pos, nrm, uv, a, b, c, d, i / (A.length - 1), s / (rings.length - 1));
    }
  }

  if (!opts.openEnds && !half) {
    // Cap the tail with a fan; the nose ring is already nearly a point.
    const last = rings[rings.length - 1];
    const cz = last[0][2];
    let cx = 0;
    let cy = 0;
    for (const p of last) { cx += p[0]; cy += p[1]; }
    cx /= last.length;
    cy /= last.length;
    for (let i = 0; i < last.length - 1; i++) {
      pos.push(cx, cy, cz, last[i][0], last[i][1], last[i][2], last[i + 1][0], last[i + 1][1], last[i + 1][2]);
      for (let k = 0; k < 3; k++) { nrm.push(0, 0, -1); uv.push(0.5, 0.5); }
    }
  }

  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(nrm, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.computeVertexNormals();
  g.computeBoundingSphere();
  return g;
}

function quad(pos, nrm, uv, a, b, c, d, u, v) {
  const push = (p) => {
    pos.push(p[0], p[1], p[2]);
    nrm.push(p[3] ?? 0, p[4] ?? 1, 0);
    uv.push(u, v);
  };
  push(a); push(b); push(c);
  push(a); push(c); push(d);
}

/** A tapered tube along Z, centred at (0, cy). */
function tube(z0, z1, r0, r1, cy, radial = 10) {
  const secs = [];
  const n = 5;
  for (let i = 0; i <= n; i++) {
    const t = i / n;
    const z = z0 + (z1 - z0) * t;
    const r = r0 + (r1 - r0) * t;
    secs.push([z, r, r, cy]);
  }
  return loft(secs, radial);
}

/** A tapered tube along Z at a lateral offset — a skid. */
function tubeX(x, z0, z1, r0, r1, cy, radial = 8) {
  const g = tube(z0, z1, r0, r1, cy, radial);
  g.translate(x, 0, 0);
  return g;
}

/** A thin slab: half-width, half-thickness, z span, y base, y top. */
function slab(hw, ht, z0, z1, y0, y1) {
  const g = new THREE.BoxGeometry(hw * 2, Math.max(0.02, Math.abs(y1 - y0) || ht * 2), Math.abs(z1 - z0));
  g.translate(0, (y0 + y1) * 0.5, (z0 + z1) * 0.5);
  return g;
}

/** A thin strut between two points. */
function strut(x0, y0, z0, x1, y1, z1, r) {
  const dx = x1 - x0;
  const dy = y1 - y0;
  const dz = z1 - z0;
  const len = Math.max(0.05, Math.hypot(dx, dy, dz));
  const g = new THREE.CylinderGeometry(r, r, len, 6, 1);
  const m = new THREE.Matrix4();
  const q = new THREE.Quaternion().setFromUnitVectors(
    new THREE.Vector3(0, 1, 0),
    new THREE.Vector3(dx / len, dy / len, dz / len)
  );
  m.compose(
    new THREE.Vector3((x0 + x1) * 0.5, (y0 + y1) * 0.5, (z0 + z1) * 0.5),
    q,
    new THREE.Vector3(1, 1, 1)
  );
  g.applyMatrix4(m);
  return g;
}
