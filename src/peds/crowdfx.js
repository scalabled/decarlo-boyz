/**
 * PEDS — the three instanced draws that carry the crowd.
 *
 *   GroundShadows  contact occlusion under every body and every foot. Without
 *                  it a pedestrian hovers a centimetre off the pavement, which
 *                  no amount of cast-shadow resolution fixes: at 4096 px over a
 *                  30 m cascade one texel is 7 mm and the depth bias needed to
 *                  stop a skinned mesh self-shadowing eats exactly that.
 *
 *   FarCrowd       the far LOD. Seven capsules per pedestrian, posed
 *                  analytically from the gait phase, all of them in ONE
 *                  InstancedMesh. At 55 m a person is about twenty pixels tall;
 *                  what has to be right is the silhouette, the colour and the
 *                  fact that they are moving. A full skinned mesh there costs a
 *                  draw call and buys nothing.
 *
 *   PropPool       phones and umbrellas, instanced and driven from the owner's
 *                  hand bone. An umbrella is a huge silhouette element in a wet
 *                  city and it has to be one draw call, not a hundred.
 */

import * as THREE from 'three';

/* ================================================================== */
/* Contact occlusion                                                  */
/* ================================================================== */

function occlusionTexture(size = 64, power = 3.4) {
  const buf = new Uint8Array(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const u = ((x + 0.5) / size) * 2 - 1;
      const v = ((y + 0.5) / size) * 2 - 1;
      const r = Math.min(1, Math.hypot(u, v));
      let a = Math.exp(-r * r * power);
      a *= 1 - r * r * r;
      const i = (y * size + x) * 4;
      buf[i] = 255; buf[i + 1] = 255; buf[i + 2] = 255;
      buf[i + 3] = Math.round(255 * Math.max(0, Math.min(1, a)));
    }
  }
  const t = new THREE.DataTexture(buf, size, size, THREE.RGBAFormat);
  t.colorSpace = THREE.NoColorSpace;
  t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping;
  t.minFilter = THREE.LinearFilter;
  t.magFilter = THREE.LinearFilter;
  t.generateMipmaps = false;
  t.needsUpdate = true;
  return t;
}

/**
 * ────────────────────────────────────────────────────────────────────────────
 * A GROUND SHADOW MULTIPLIES. IT DOES NOT LERP TOWARDS A DARK COLOUR.
 * ────────────────────────────────────────────────────────────────────────────
 * This pool used to be a `MeshBasicMaterial` with `color` (0.045, 0.05, 0.062)
 * and ordinary alpha blending, which is
 *
 *     out = colour * a + dst * (1 - a)
 *
 * — an INTERPOLATION towards a constant. Interpolating towards a constant
 * brightens everything darker than the constant, and dark asphalt, night and
 * shade are all darker than 0.05. So the "shadow" LIT the road.
 *
 * Measured on the `driving` frame, the only ground-contact mark was a fake blob
 * decal that rendered BRIGHTER than the asphalt around it. The identical defect
 * existed in `vehicles`, which had copied this material into its own pool.
 *
 * MEASURED by `src/peds/shadowprobe.mjs`, three arms of ONE frozen `driving`
 * frame differing only in this blend, over the 3 349 px the pool touches
 * (linear x255):
 *
 *     midday overcast    off 11.196   lerp 18.141 (+6.9)   multiply  8.715 (-2.5)
 *     21:21  overcast    off  1.853   lerp 11.597 (+9.7)   multiply  1.549 (-0.3)
 *
 * The lerp raised 99.8% and 99.7% of the pixels it touched, by as much as +106
 * sRGB. It was six times brighter than the road it sat on at 21:21, because a
 * lerp towards a constant does its worst damage where the receiver is darkest.
 * On the `night` shot (01:30) the same defect renders as a visible pale HALO
 * around the character's shoes: 54.9 sRGB in that block against 9.4 for the
 * open road beside it. After the fix, 7.9. The multiply arm raises exactly zero
 * pixels in either condition, which is not a tuning result — it is what the
 * operator guarantees.
 *
 * Occlusion is not a colour, it is a TRANSMITTANCE, and the only operator that
 * expresses transmittance is a multiply:
 *
 *     out = dst * (1 - a)          i.e.  src ZERO, dst ONE_MINUS_SRC_ALPHA
 *
 * At a = 0 that is the identity and at a = 1 it is black. It has no free
 * colour to be wrong about, and it is correct at every exposure and every
 * surface albedo, which a lerp towards a constant can only be at one.
 *
 * The alpha factors are split out (`ZERO` / `ONE`) so the target's own alpha
 * channel is left alone — TAA and the composite read it.
 *
 * `?owPedShadowLerp=1` restores the broken blend and nothing else, which is the
 * negative control for the numbers above. `?owNoPedShadow=1` removes the pool.
 */
function transmittanceBlend(m) {
  m.blending = THREE.CustomBlending;
  m.blendEquation = THREE.AddEquation;
  m.blendSrc = THREE.ZeroFactor;
  m.blendDst = THREE.OneMinusSrcAlphaFactor;
  m.blendEquationAlpha = THREE.AddEquation;
  m.blendSrcAlpha = THREE.ZeroFactor;
  m.blendDstAlpha = THREE.OneFactor;
  // Nothing reads it under this blend, but leaving a non-black colour here
  // would be an invitation to "fix" the shadow by tinting it again.
  m.color.setRGB(0, 0, 0);
  m.needsUpdate = true;
}

/** THE BUG, restorable on demand. Negative control only — never the default. */
function legacyLerpBlend(m) {
  m.blending = THREE.NormalBlending;
  m.color.setRGB(0.045, 0.05, 0.062);
  m.needsUpdate = true;
}

/**
 * PER-INSTANCE STRENGTH.
 *
 * A contact mark has to fade, not just shrink: a foot 20 cm off the pavement
 * still leaves a hard little dot if all that happens is that its quad gets
 * smaller, because the quad's centre texel is at full alpha whatever size the
 * quad is. Neither `instanceColor` nor `opacity` can carry a per-instance
 * ALPHA — three's instance colour is vec3 and multiplies `diffuse.rgb` only —
 * so this adds one float attribute and folds it into `diffuseColor.a` before
 * the blend reads it.
 *
 * Hard rule 10: there is not a single backtick or a `${` in the GLSL below,
 * and there must never be one. These are plain single-quoted strings for
 * exactly that reason.
 */
function patchInstanceFade(shader) {
  shader.vertexShader =
    'attribute float owFade;\nvarying float vOwFade;\n' + shader.vertexShader;
  shader.vertexShader = shader.vertexShader.replace(
    'void main() {',
    'void main() {\n\tvOwFade = owFade;'
  );
  shader.fragmentShader = 'varying float vOwFade;\n' + shader.fragmentShader;
  shader.fragmentShader = shader.fragmentShader.replace(
    '#include <specularmap_fragment>',
    '\tdiffuseColor.a *= vOwFade;\n\t#include <specularmap_fragment>'
  );
}

/* Shared scratch — `put` runs a few hundred times a frame (hard rule 5). */
const _sm = new THREE.Matrix4();
const _sq = new THREE.Quaternion();
const _sup = new THREE.Vector3(0, 1, 0);
const _spos = new THREE.Vector3();
const _sscale = new THREE.Vector3(1, 1, 1);
const _sflat = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), -Math.PI / 2);

/**
 * One instanced quad pool. Its own geometry, because the per-instance fade is
 * an `InstancedBufferAttribute` on the geometry and two pools of different
 * capacity cannot share one.
 */
class ShadowPool {
  constructor(cap, tex, opacity, order, name) {
    this.cap = Math.max(1, cap);
    this.tex = tex;
    this.opacity = opacity;
    this.geo = new THREE.PlaneGeometry(1, 1, 1, 1);
    this.fade = new THREE.InstancedBufferAttribute(new Float32Array(this.cap), 1);
    this.fade.setUsage(THREE.DynamicDrawUsage);
    this.geo.setAttribute('owFade', this.fade);

    this.mat = new THREE.MeshBasicMaterial({
      color: 0x000000,
      map: tex,
      transparent: true,
      opacity,
      depthWrite: false,
      depthTest: true,
      side: THREE.DoubleSide,
      toneMapped: false,
      fog: false,
    });
    this.mat.onBeforeCompile = patchInstanceFade;
    transmittanceBlend(this.mat);

    this.mesh = new THREE.InstancedMesh(this.geo, this.mat, this.cap);
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.mesh.frustumCulled = false;
    this.mesh.castShadow = false;
    this.mesh.renderOrder = order;
    this.mesh.name = name;
    this.mesh.userData.owProbe = true;
    this.mesh.userData.owNoShadow = true;
    this.mesh.userData.owNoPrepass = true;
    this.mesh.count = 0;
    this.mesh.visible = false;
    this.n = 0;
    this.off = false;
  }

  begin() {
    this.n = 0;
  }

  /** Place one quad flat on the ground at `yaw`, half-extents rx/rz. */
  put(x, y, z, yaw, rx, rz, fade) {
    if (this.n >= this.cap || fade <= 0.01) return;
    _sq.setFromAxisAngle(_sup, yaw).multiply(_sflat);
    _spos.set(x, y + 0.014, z);
    _sscale.set(rx * 2, rz * 2, 1);
    _sm.compose(_spos, _sq, _sscale);
    this.mesh.setMatrixAt(this.n, _sm);
    this.fade.array[this.n] = fade;
    this.n++;
  }

  end() {
    this.mesh.count = this.n;
    this.mesh.visible = !this.off && this.n > 0;
    if (this.n > 0) {
      this.mesh.instanceMatrix.needsUpdate = true;
      this.fade.needsUpdate = true;
    }
  }

  setMode(mode) {
    if (mode === 'lerp') legacyLerpBlend(this.mat);
    else transmittanceBlend(this.mat);
    this.off = mode === 'off';
    this.mesh.visible = !this.off && this.n > 0;
  }

  dispose() {
    this.mesh.parent?.remove(this.mesh);
    this.mesh.dispose?.();
    this.geo.dispose();
    this.mat.dispose();
    this.tex.dispose();
  }
}

export class GroundShadows {
  constructor(parent, capacity = 48) {
    this.capacity = Math.max(4, capacity);
    /**
     * The body falloff was `power = 3.2`, which puts almost all of its
     * darkening inside the middle 40% of the quad — and the middle of the quad
     * is behind the pedestrian's own shoes and shins from any camera at eye
     * level. Measured on `driving`: what a viewer actually sees of this pool is
     * the ANNULUS around the feet, so a curve that has already decayed to 0.06
     * by 80% of the radius contributes nothing visible at all. Flatter.
     */
    this.texture = occlusionTexture(64, 2.2);
    this.footTexture = occlusionTexture(64, 4.6);

    /**
     * Two pools, because they are two phenomena. The body AO is the ~70 cm of
     * sky a person's torso and legs block, soft and centred on them; the foot
     * patch is the near-black 25 cm crescent where a sole is actually pressed
     * against the pavement, and it is the mark that makes a pedestrian look
     * like they have weight rather than like a decal standing on the road.
     *
     * These strengths are TRANSMITTANCES now, not lerp weights, so they do not
     * mean what the old 0.58 / 0.82 meant. At the centre of a planted foot the
     * road is multiplied by 0.45 by the body pool and then by 0.20 by the foot
     * pool; out at the sill of the body blob, where a viewer at eye level
     * actually sees this pool, it is around 0.7. A person on an overcast day
     * blocks essentially the whole sky under their sole, and the sky IS the
     * light source in this game's default weather, so a near-black contact
     * line is the physical answer, not a stylistic one.
     *
     * RATCHET, not a target. These two numbers were set by looking at one
     * `driving` frame and one `night` frame; they are the strength that made
     * the crowd stop floating, not a value anybody derived. The real answer is
     * a screen-space contact term that knows the actual sky visibility, which
     * `render/contact.js` already computes and which is quality-gated off at
     * `low` — this pool exists because of that gate. If you improve it, lower
     * these towards the point where the geometric pool is only propping up the
     * quality levels that have no contact pass; do not raise them to make a
     * frame look better.
     */
    this.body = new ShadowPool(this.capacity, this.texture, 0.55, 6, 'ped-ao-body');
    this.feet = new ShadowPool(this.capacity * 2, this.footTexture, 0.80, 7, 'ped-ao-feet');
    parent.add(this.body.mesh);
    parent.add(this.feet.mesh);

    this.mode = 'multiply';
    /** Preallocated contact record; `PedAnimator.footContact` fills it. */
    this._c = { x: 0, y: 0, z: 0, above: 0, planted: false, lock: 0, hit: false };
  }

  /** 'multiply' (correct), 'lerp' (the historical defect), 'off'. */
  setMode(mode) {
    this.mode = mode === 'lerp' || mode === 'off' ? mode : 'multiply';
    this.body.setMode(this.mode);
    this.feet.setMode(this.mode);
  }

  begin() {
    this.body.begin();
    this.feet.begin();
  }

  /**
   * DRIVEN OFF REAL CONTACT, not off the root transform.
   *
   * The foot patches used to be placed at the ACTOR'S root height with a
   * strength derived from `FootR.y - root.y`. Both halves of that are wrong on
   * anything but flat ground: a foot up on a kerb had its mark drawn 15 cm
   * below its own sole, and because the ankle joint sits 8 cm above the sole
   * the height term read a fully planted foot as 3 cm airborne and never gave
   * it more than 88% strength. `footContact` publishes what the IK's stance
   * lock already solved — the foot's own ground, its daylight after the pelvis
   * drop, and whether the clip has it bearing weight — so the mark is now
   * tight and dark under a planted foot and spreads and fades as it lifts,
   * which is what a real penumbra does.
   */
  addPed(ped) {
    const p = ped.position;
    if (!p || !Number.isFinite(p.y)) return;
    const s = ped.scale ?? 1;
    const an = ped.animator;
    const skinned = an && ped.body && ped.lod <= 1;

    /* ---- feet first: they also tell the body blob how airborne it is ---- */
    let minAbove = 0;
    if (skinned) {
      minAbove = Infinity;
      for (let k = 0; k < 2; k++) {
        const c = an.footContact(k, this._c);
        if (!c.hit || !Number.isFinite(c.y)) continue;
        // Contact strength: 1 with the sole on the deck, 0 by 22 cm of lift.
        // The stance lock is the second opinion — while it is holding a foot
        // that foot is bearing weight by definition, and its 0.10 s release
        // ramp is exactly the softening a foot leaving the ground should have.
        const byHeight = 1 - Math.min(1, Math.max(0, c.above / (0.22 * s)));
        const contact = Math.min(1, Math.max(byHeight, c.lock));
        if (c.above < minAbove) minAbove = c.above;
        if (contact <= 0.04) continue;
        // A lifting foot's shadow SPREADS as it weakens. Shrinking it instead
        // (what this did before) leaves a small hard dot hanging under a foot
        // that is 20 cm in the air, which reads as a smear of dirt.
        const spread = 1 + 0.55 * (1 - contact);
        this.feet.put(
          c.x, c.y, c.z, ped.yaw,
          0.115 * s * spread, 0.155 * s * spread,
          contact * contact
        );
      }
      if (!Number.isFinite(minAbove)) minAbove = 0;
    }

    // The body blob sits on the actor's own ground (`Ped` pins `position.y` to
    // it) and fades out only when BOTH feet have left it — a run's flight
    // phase, a dive, a body thrown by a car. A walk always has one foot down,
    // so this is 1 for the entire crowd on a normal street.
    const onGround = 1 - Math.min(1, Math.max(0, (minAbove - 0.12) / 0.55));
    if (onGround > 0.02) {
      this.body.put(p.x, p.y, p.z, ped.yaw, 0.38 * s, 0.30 * s, onGround);
    }
  }

  end() {
    this.body.end();
    this.feet.end();
  }

  dispose() {
    this.body.dispose();
    this.feet.dispose();
  }
}

/* ================================================================== */
/* Far crowd                                                          */
/* ================================================================== */

/** Unit capsule spanning y 0..1, radius 0.5 in x/z. */
function unitCapsule() {
  const g = new THREE.CapsuleGeometry(0.5, 1.0, 3, 9);
  g.translate(0, 1, 0);
  g.scale(1, 0.5, 1);
  g.computeBoundingSphere();
  return g;
}

/**
 * Seven segments per body: two legs, hips, chest, head, two arms. Their
 * endpoints are a direct evaluation of the same gait the skinned clips use,
 * cut down to the four numbers that survive at this range.
 */
const SEG = 7;

/**
 * Distant garments are seen through 60+ m of aerial perspective and are usually
 * in shade; a literal 0.03-albedo pair of trousers disappears into the pavement
 * and the figure reads as a chess pawn. Lift the palette and floor it, which is
 * roughly what the atmosphere does anyway.
 */
const LIFT_A = 0.022;
const LIFT_K = 1.30;
const _c0 = [0, 0, 0], _c1 = [0, 0, 0], _c2 = [0, 0, 0], _c3 = [0, 0, 0];
/** Head colour: skin and hair mixed. Its own array so it cannot alias `_c2`. */
const _c4 = [0, 0, 0];
function _lift(c, out) {
  out[0] = LIFT_A + c[0] * LIFT_K;
  out[1] = LIFT_A + c[1] * LIFT_K;
  out[2] = LIFT_A + c[2] * LIFT_K;
  return out;
}

export class FarCrowd {
  constructor(parent, capacity, material) {
    this.capacity = capacity;
    this.geo = unitCapsule();
    this.material = material;
    this.mesh = new THREE.InstancedMesh(this.geo, material, capacity * SEG);
    this.mesh.frustumCulled = false;
    this.mesh.name = 'ped-far-crowd';
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.mesh.count = 0;
    this.mesh.visible = false;
    this.mesh.castShadow = false;
    this.mesh.receiveShadow = true;
    this.mesh.userData.owNoShadow = true;
    const col = new Float32Array(capacity * SEG * 3);
    this.mesh.instanceColor = new THREE.InstancedBufferAttribute(col, 3);
    this.mesh.instanceColor.setUsage(THREE.DynamicDrawUsage);
    parent.add(this.mesh);

    this._n = 0;
    this._m = new THREE.Matrix4();
    this._q = new THREE.Quaternion();
    this._pos = new THREE.Vector3();
    this._scale = new THREE.Vector3();
    this._a = new THREE.Vector3();
    this._b = new THREE.Vector3();
    this._d = new THREE.Vector3();
    /** Seated-figure scratch and frame — see `addSeated` and `_segLocal`. */
    this._sa = new THREE.Vector3();
    this._sb = new THREE.Vector3();
    this._sp = null;
    this._sq = null;
    this._up = new THREE.Vector3(0, 1, 0);
    this._px = 0; this._pz = 0; this._py = 0;
    this._cy = 1; this._sy = 0; this._h = 1.75; this._bob = 0;
    this._wx = (lx, lz) => this._px + lx * this._cy + lz * this._sy;
    this._wz = (lx, lz) => this._pz - lx * this._sy + lz * this._cy;
    this._wy = (ly) => this._py + ly * this._h + this._bob;
  }

  begin() {
    this._n = 0;
  }

  _seg(ax, ay, az, bx, by, bz, r, cr, cg, cb) {
    const i = this._n;
    if (i >= this.mesh.instanceMatrix.count) return;
    this._a.set(ax, ay, az);
    this._d.set(bx - ax, by - ay, bz - az);
    const len = this._d.length() || 1e-4;
    this._d.multiplyScalar(1 / len);
    this._q.setFromUnitVectors(this._up, this._d);
    this._scale.set(r * 2, len, r * 2);
    this._m.compose(this._a, this._q, this._scale);
    this.mesh.setMatrixAt(i, this._m);
    const c = this.mesh.instanceColor.array;
    c[i * 3] = cr; c[i * 3 + 1] = cg; c[i * 3 + 2] = cb;
    this._n++;
  }

  /**
   * `_seg` with both endpoints given in the SEATED FIGURE'S own frame, composed
   * through `_sq` (the drawn car's orientation) about `_sp` (the seat). Set
   * those two, then call this; `addSeated` is the only caller.
   */
  _segLocal(ax, ay, az, bx, by, bz, r, col) {
    const p = this._sp;
    const q = this._sq;
    const A = this._sa.set(ax, ay, az);
    const B = this._sb.set(bx, by, bz);
    if (q) { A.applyQuaternion(q); B.applyQuaternion(q); }
    this._seg(
      A.x + p.x, A.y + p.y, A.z + p.z,
      B.x + p.x, B.y + p.y, B.z + p.z,
      r, col[0], col[1], col[2]
    );
  }

  /**
   * @param ped   a pedestrian with no skinned body this frame
   * @param phase 0..1 stride phase
   */
  addPed(ped, phase) {
    if (this._n + SEG > this.mesh.instanceMatrix.count) return;
    // Distant garments are seen through 60+ m of aerial perspective and are
    // usually in shade; a literal 0.03-albedo pair of trousers disappears into
    // the pavement and the figure reads as a chess pawn. Lift the palette a
    // stop and floor it, which is what the atmosphere does anyway.
    const h = ped.height ?? 1.75;
    const p = ped.position;
    const cy = Math.cos(ped.yaw), sy = Math.sin(ped.yaw);
    const pal = ped.outfit.palette;
    const top = _lift(pal[2], _c0);
    const bottom = _lift(pal[4], _c1);
    const skin = _lift(pal[0], _c2);
    const hair = _lift(pal[1], _c3);
    const t = phase * Math.PI * 2;
    const sw = Math.min(1, ped.speed / 2.2);
    const swing = Math.sin(t) * 0.30 * sw * h;
    const lift = Math.max(0, Math.sin(t)) * 0.075 * sw * h;
    const swing2 = -swing;
    const lift2 = Math.max(0, -Math.sin(t)) * 0.075 * sw * h;
    const bob = Math.cos(2 * t) * 0.016 * sw * h;

    // local -> world, written out rather than closed over: three arrow
    // functions per pedestrian per frame is three hundred allocations a frame
    // at full population, which is a garbage collector pause you can see.
    this._px = p.x; this._pz = p.z; this._py = p.y;
    this._cy = cy; this._sy = sy; this._h = h; this._bob = bob;
    const wx = this._wx;
    const wz = this._wz;
    const y = this._wy;

    // Proportions matter more here than anywhere else: at 30 px tall the only
    // information is the outline, so the head must be clearly narrower than the
    // shoulders and the legs must be far enough apart to separate. The first
    // pass had a head as wide as the chest and legs 8 cm apart, and the whole
    // far crowd read as a row of bollards.
    const hipY = 0.505, shoY = 0.800, headY = 0.855, topY = 0.985;
    const legR = 0.048 * h, armR = 0.032 * h, torsoR = 0.096 * h, headR = 0.049 * h;
    const legX = 0.062, armX = 0.118;

    this._seg(
      wx(-legX, 0), y(hipY), wz(-legX, 0),
      wx(-legX - 0.006, swing), y(0.026) + lift, wz(-legX - 0.006, swing),
      legR, bottom[0], bottom[1], bottom[2]
    );
    this._seg(
      wx(legX, 0), y(hipY), wz(legX, 0),
      wx(legX + 0.006, swing2), y(0.026) + lift2, wz(legX + 0.006, swing2),
      legR, bottom[0], bottom[1], bottom[2]
    );
    // hips + chest: the chest is the widest thing on the figure
    this._seg(wx(0, 0), y(hipY - 0.040), wz(0, 0), wx(0, 0.004), y(0.625), wz(0, 0.004),
      torsoR * 0.88, bottom[0], bottom[1], bottom[2]);
    this._seg(wx(0, 0.004), y(0.615), wz(0, 0.004), wx(0, 0.012), y(shoY), wz(0, 0.012),
      torsoR, top[0], top[1], top[2]);
    // neck + head
    this._seg(wx(0, 0.006), y(headY), wz(0, 0.006), wx(0, 0.012), y(topY), wz(0, 0.012),
      headR, skin[0] * 0.6 + hair[0] * 0.4, skin[1] * 0.6 + hair[1] * 0.4, skin[2] * 0.6 + hair[2] * 0.4);
    // arms, hanging clear of the torso so the silhouette has gaps in it
    this._seg(
      wx(-armX, 0.006), y(shoY - 0.02), wz(-armX, 0.006),
      wx(-armX - 0.004, swing2 * 0.62), y(0.495), wz(-armX - 0.004, swing2 * 0.62),
      armR, top[0], top[1], top[2]
    );
    this._seg(
      wx(armX, 0.006), y(shoY - 0.02), wz(armX, 0.006),
      wx(armX + 0.004, swing * 0.62), y(0.495), wz(armX + 0.004, swing * 0.62),
      armR, top[0], top[1], top[2]
    );
  }

  /**
   * THE SAME PERSON, SITTING DOWN.
   *
   * `addPed` above stacks a standing figure off `ped.position`, crown at 0.985
   * of a body height. Called on a driver — whose `position` is the seat — that
   * is a man standing up through the roof of a moving car, which is precisely
   * the defect the skinned path was fixed for, surviving at LOD2 because the
   * far crowd never knew about seats. Between 58 m (where bodies stop) and
   * 118 m (where `traffic` unseats) that is EVERY car on the street.
   *
   * Heights are in METRES off the seat root, not in fractions of a body, and
   * they are the same stack `clips.sit` produces: hips 0.208 over the root,
   * shoulders 0.558, head bone 0.768, crown 1.008.
   *
   * It is also built on the CAR'S basis rather than on a yaw and world up, for
   * the same reason the skinned body takes the car's whole quaternion: a figure
   * left bolt upright in a car with three degrees of roll loses
   * `lateralOffset * sin(roll)` of headroom, which on the sports car is 20 mm
   * out of 31. `_seg` takes world endpoints, so the six segments are composed
   * here through `ped._seatQuat` — the DRAWN car's orientation, which
   * `Ped._seatPose` has already read this frame.
   */
  addSeated(ped) {
    if (this._n + SEG > this.mesh.instanceMatrix.count) return;
    const p = ped.position;
    if (!p || !Number.isFinite(p.y)) return;
    const s = ped.scale ?? 1;
    const pal = ped.outfit.palette;
    const top = _lift(pal[2], _c0);
    const bottom = _lift(pal[4], _c1);
    const skin = _lift(pal[0], _c2);
    const hair = _lift(pal[1], _c3);
    // `_segLocal` is a method rather than a closure over `p` and `q` for the
    // same reason `_wx`/`_wz`/`_wy` are built once in the constructor: a
    // closure per pedestrian per frame is hundreds of allocations a frame at
    // full population, and that is a garbage collector pause you can see.
    this._sp = p;
    this._sq = ped._seatQuat;

    const hipY = 0.208 * s, shoY = 0.558 * s, headY = 0.700 * s, topY = 1.008 * s;
    const legR = 0.084 * s, armR = 0.056 * s, torsoR = 0.168 * s, headR = 0.086 * s;
    const legX = 0.108 * s, armX = 0.196 * s;
    // Legs out along the floor. ONE segment each, not two: at the `drop` the
    // whole fleet actually asks for, a seated driver's leg is very nearly
    // straight, and six segments keeps a seated figure inside the same per-ped
    // budget (`SEG`) the standing one is capacity-planned against.
    // The ankle follows the same `drop` the skinned clip is given, or the far
    // figure keeps its feet at seat-root height in a car whose floor is a foot
    // BELOW that: measured on the sports car, a capsule end 6 mm under its own
    // floor pan. `0.485` is the same authored metre-per-drop slope `clips.sit`
    // is calibrated on; negative drop (heels up) is where the low classes sit.
    const footY = (0.08 - 0.485 * Math.max(0, ped._seatDrop ?? 0)) * s;
    const footZ = 0.80 * s;
    this._segLocal(-legX, hipY, 0, -legX, footY, footZ, legR, bottom);
    this._segLocal(legX, hipY, 0, legX, footY, footZ, legR, bottom);
    // torso
    this._segLocal(0, hipY, 0, 0, shoY, 0.02 * s, torsoR, top);
    // neck + head
    _c4[0] = skin[0] * 0.6 + hair[0] * 0.4;
    _c4[1] = skin[1] * 0.6 + hair[1] * 0.4;
    _c4[2] = skin[2] * 0.6 + hair[2] * 0.4;
    this._segLocal(0, headY, 0.02 * s, 0, topY, 0.03 * s, headR, _c4);
    // both arms forward onto the wheel — the one thing a driver's silhouette
    // has that a standing one does not
    const wheelZ = 0.34 * s, wheelY = 0.44 * s;
    this._segLocal(-armX, shoY - 0.03 * s, 0.01 * s, -armX * 0.5, wheelY, wheelZ, armR, top);
    this._segLocal(armX, shoY - 0.03 * s, 0.01 * s, armX * 0.5, wheelY, wheelZ, armR, top);
  }

  end() {
    this.mesh.count = this._n;
    this.mesh.visible = this._n > 0;
    if (this._n > 0) {
      this.mesh.instanceMatrix.needsUpdate = true;
      this.mesh.instanceColor.needsUpdate = true;
    }
  }

  dispose() {
    this.mesh.parent?.remove(this.mesh);
    this.mesh.dispose();
    this.geo.dispose();
  }
}

/* ================================================================== */
/* Carried props                                                      */
/* ================================================================== */

function umbrellaGeometry() {
  // an eight-panel canopy plus a shaft, merged into one geometry
  const pos = [];
  const nrm = [];
  const idx = [];
  const rows = 5, seg = 24, R = 0.46;
  for (let r = 0; r < rows; r++) {
    const t = r / (rows - 1);
    const rad = R * Math.sin(t * 1.36);
    const y = 0.16 - 0.155 * (1 - Math.cos(t * 1.36));
    for (let s = 0; s <= seg; s++) {
      const a = (s / seg) * Math.PI * 2;
      // scallop the rim between the eight ribs
      const scal = 1 - (1 - Math.abs(Math.sin(a * 4))) * 0.09 * t;
      pos.push(Math.sin(a) * rad * scal, y, Math.cos(a) * rad * scal);
      nrm.push(0, 0, 0);
    }
  }
  for (let r = 0; r + 1 < rows; r++) {
    for (let s = 0; s < seg; s++) {
      const a = r * (seg + 1) + s;
      const b = a + 1;
      const c = a + seg + 1;
      const d = c + 1;
      idx.push(a, c, b, b, c, d);
    }
  }
  // shaft
  const base = pos.length / 3;
  const sr = 0.010;
  for (let r = 0; r < 2; r++) {
    const y = r === 0 ? 0.20 : -0.62;
    for (let s = 0; s <= 6; s++) {
      const a = (s / 6) * Math.PI * 2;
      pos.push(Math.sin(a) * sr, y, Math.cos(a) * sr);
      nrm.push(0, 0, 0);
    }
  }
  for (let s = 0; s < 6; s++) {
    const a = base + s, b = a + 1, c = a + 7, d = c + 1;
    idx.push(a, c, b, b, c, d);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(pos), 3));
  g.setIndex(idx);
  g.computeVertexNormals();
  g.computeBoundingSphere();
  return g;
}

export class PropPool {
  constructor(parent, capacity, materials) {
    this.capacity = capacity;
    this.geos = {
      phone: new THREE.BoxGeometry(0.074, 0.152, 0.010),
      umbrella: umbrellaGeometry(),
      cane: new THREE.CylinderGeometry(0.011, 0.009, 0.92, 6),
      cig: new THREE.CylinderGeometry(0.0035, 0.0035, 0.062, 5),
    };
    this.meshes = {};
    this.counts = {};
    for (const k in this.geos) {
      const m = new THREE.InstancedMesh(this.geos[k], materials[k] ?? materials.phone, capacity);
      m.frustumCulled = false;
      m.castShadow = false;
      m.receiveShadow = true;
      m.name = `ped-prop-${k}`;
      m.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      m.count = 0;
      m.visible = false;
      m.userData.owNoShadow = k !== 'umbrella';
      const col = new Float32Array(capacity * 3);
      m.instanceColor = new THREE.InstancedBufferAttribute(col, 3);
      m.instanceColor.setUsage(THREE.DynamicDrawUsage);
      parent.add(m);
      this.meshes[k] = m;
      this.counts[k] = 0;
    }
    this._m = new THREE.Matrix4();
    this._m2 = new THREE.Matrix4();
    this._c = new THREE.Color();
  }

  begin() {
    for (const k in this.counts) this.counts[k] = 0;
  }

  /** Place one prop from a bone's world matrix plus a local offset matrix. */
  add(kind, boneMatrix, offset, colour) {
    const mesh = this.meshes[kind];
    if (!mesh) return;
    const i = this.counts[kind];
    if (i >= this.capacity) return;
    this._m.multiplyMatrices(boneMatrix, offset);
    mesh.setMatrixAt(i, this._m);
    const c = mesh.instanceColor.array;
    c[i * 3] = colour[0]; c[i * 3 + 1] = colour[1]; c[i * 3 + 2] = colour[2];
    this.counts[kind] = i + 1;
  }

  end() {
    for (const k in this.meshes) {
      const m = this.meshes[k];
      const n = this.counts[k];
      m.count = n;
      m.visible = n > 0;
      if (n > 0) {
        m.instanceMatrix.needsUpdate = true;
        m.instanceColor.needsUpdate = true;
      }
    }
  }

  dispose() {
    for (const k in this.meshes) {
      this.meshes[k].parent?.remove(this.meshes[k]);
      this.meshes[k].dispose();
      this.geos[k].dispose();
    }
  }
}
