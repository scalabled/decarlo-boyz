/**
 * The procedural human — one rig, three brothers.
 *
 * A single SkinnedMesh built from swept tubes and displaced ellipsoids, with
 * eight material groups so the garments read as separate objects rather than a
 * painted-on texture: bare skin, face, shirt, trousers, boot leather, boot sole,
 * hair, eyes.
 *
 * WHY SWEEPS. A capsule per limb is what every "procedural character" looks
 * like, and it is instantly readable as programmer art. Real limbs have a
 * profile: a calf is a teardrop, a thigh is thickest a third of the way down, a
 * forearm tapers to a bony wrist. Every tube here takes a `radius(t)` function
 * so those profiles are authored, and an optional `shape(angle, t)` so a shin
 * can be flattened at the front where the tibia is under the skin.
 *
 * The skeleton is authored in metres in a bind pose with the arms hanging (not a
 * T-pose): this character never raises its arms above the shoulder, so an
 * A-pose bind gives far better deltoid deformation than a T-pose would.
 *
 * Bind-space convention, shared with the whole game:
 *   +Y up · -Z forward (the character faces the same way as yaw = 0) · +X is the
 *   character's RIGHT.
 */

import * as THREE from 'three';

/* ====================================================================== */
/* Skeleton                                                               */
/* ====================================================================== */

/**
 * [name, parent, x, y, z] — positions are BIND-POSE WORLD metres for a 1.78 m
 * body; the loader converts to parent-relative. Mirrored limbs are generated.
 */
const BONE_SPEC = [
  ['hips', null, 0, 0.945, 0],
  ['spine', 'hips', 0, 1.075, 0.006],
  ['chest', 'spine', 0, 1.248, 0.002],
  ['neck', 'chest', 0, 1.452, -0.012],
  ['head', 'neck', 0, 1.548, 0.004],
  ['headEnd', 'head', 0, 1.79, 0.004],
];

const LIMB_SPEC = [
  // clavicle -> hand
  ['clav', 'chest', 0.043, 1.418, 0.004],
  ['arm', 'clav', 0.176, 1.428, 0.002],
  ['forearm', 'arm', 0.199, 1.163, -0.012],
  ['hand', 'forearm', 0.214, 0.907, 0.004],
  ['handEnd', 'hand', 0.219, 0.772, 0.012],
  // leg
  ['thigh', 'hips', 0.094, 0.912, 0.004],
  ['shin', 'thigh', 0.099, 0.498, -0.014],
  ['foot', 'shin', 0.101, 0.086, 0.022],
  ['toe', 'foot', 0.101, 0.031, -0.108],
];

/** Names, in creation order. Index in this array is the skin index. */
export const BONE_NAMES = (() => {
  const out = BONE_SPEC.map((b) => b[0]);
  for (const side of ['R', 'L']) for (const l of LIMB_SPEC) out.push(l[0] + side);
  return out;
})();

export const BONE_INDEX = (() => {
  const m = Object.create(null);
  BONE_NAMES.forEach((n, i) => (m[n] = i));
  return m;
})();

/** Bind-pose world positions, after the per-brother build has been applied. */
function bindPositions(build) {
  const p = Object.create(null);
  const S = build.scale ?? 1;
  const shoulder = build.shoulder ?? 1;
  const limb = build.limb ?? 1;
  const push = (name, x, y, z) => {
    p[name] = [x * S, y * S, z * S];
  };
  for (const [name, , x, y, z] of BONE_SPEC) push(name, x, y, z);
  for (const side of ['R', 'L']) {
    const s = side === 'R' ? 1 : -1;
    for (const [name, , x, y, z] of LIMB_SPEC) {
      // Wider shoulders push the arm chain out; heavier legs sit slightly wider.
      const isArm = name === 'clav' || name === 'arm' || name === 'forearm' ||
        name === 'hand' || name === 'handEnd';
      const w = isArm ? shoulder : 1 + (limb - 1) * 0.45;
      push(name + side, s * x * w, y, z);
    }
  }
  return p;
}

function buildSkeleton(build) {
  const P = bindPositions(build);
  const bones = [];
  const byName = Object.create(null);
  const parentOf = Object.create(null);

  const make = (name, parent) => {
    const b = new THREE.Bone();
    b.name = name;
    const pp = parent ? P[parent] : null;
    const me = P[name];
    b.position.set(me[0] - (pp ? pp[0] : 0), me[1] - (pp ? pp[1] : 0), me[2] - (pp ? pp[2] : 0));
    if (parent) byName[parent].add(b);
    bones.push(b);
    byName[name] = b;
    parentOf[name] = parent;
    return b;
  };

  for (const [name, parent] of BONE_SPEC) make(name, parent);
  for (const side of ['R', 'L']) {
    for (const [name, parent] of LIMB_SPEC) {
      const par = parent === 'chest' || parent === 'hips' ? parent : parent + side;
      make(name + side, par);
    }
  }
  return { bones, byName, positions: P, parentOf, root: byName.hips };
}

/* ====================================================================== */
/* Geometry builder                                                       */
/* ====================================================================== */

const _t = new THREE.Vector3();
const _b = new THREE.Vector3();
const _n = new THREE.Vector3();
const _ref = new THREE.Vector3();
const _tPrev = new THREE.Vector3();
const _axis = new THREE.Vector3();

/** Catmull-Rom through the control points, evaluated at parameter u in [0,1]. */
function crEval(path, u, out) {
  const n = path.length;
  const f = u * (n - 1);
  let i = Math.floor(f);
  if (i > n - 2) i = n - 2;
  if (i < 0) i = 0;
  const t = f - i;
  const p0 = path[Math.max(0, i - 1)];
  const p1 = path[i];
  const p2 = path[i + 1];
  const p3 = path[Math.min(n - 1, i + 2)];
  const t2 = t * t, t3 = t2 * t;
  for (let k = 0; k < 3; k++) {
    out[k] = 0.5 * (
      2 * p1[k] +
      (-p0[k] + p2[k]) * t +
      (2 * p0[k] - 5 * p1[k] + 4 * p2[k] - p3[k]) * t2 +
      (-p0[k] + 3 * p1[k] - 3 * p2[k] + p3[k]) * t3
    );
  }
  return out;
}

const _e0 = [0, 0, 0];
const _e1 = [0, 0, 0];

/**
 * Accumulates positions / uvs / skin data across every body part and emits one
 * indexed BufferGeometry with a material group per part family.
 */
class BodyBuilder {
  constructor(materialCount) {
    this.pos = [];
    this.uv = [];
    this.si = [];
    this.sw = [];
    this.index = [];
    /** index-buffer runs, one per material, merged into groups at the end. */
    this.runs = [];
    for (let i = 0; i < materialCount; i++) this.runs.push([]);
    this.seams = [];
  }

  get vertexCount() {
    return this.pos.length / 3;
  }

  _vert(x, y, z, u, v, w) {
    this.pos.push(x, y, z);
    this.uv.push(u, v);
    this.si.push(w[0], w[2], 0, 0);
    this.sw.push(w[1], w[3], 0, 0);
    return this.vertexCount - 1;
  }

  /**
   * Sweep a tube along `path`.
   * @param o.path     control points [[x,y,z], ...]
   * @param o.rings    ring samples along the path
   * @param o.radial   segments around
   * @param o.radius   (t) => [rx, rz]   half-extents in the frame's two axes
   * @param o.weight   (t) => [i0, w0, i1, w1]
   * @param o.shape    (angle, t) => scalar multiplier, default 1
   * @param o.axis     world direction rx points along at ring 0 (auto by default)
   */
  tube(o) {
    const mat = o.material | 0;
    const run = this.runs[mat];
    const rings = o.rings;
    const radial = o.radial;
    const ref = o.axis ?? null;
    const shape = o.shape ?? null;
    const uvV = o.uvV ?? 3.0;
    const uvU = o.uvU ?? 1;
    const path = o.path;
    const straight = path.length === 2;

    let prevRow = -1;
    let firstRow = -1;
    let vSum = 0;
    const c = [0, 0, 0];
    const cPrev = [0, 0, 0];
    const cNext = [0, 0, 0];

    for (let i = 0; i < rings; i++) {
      const t = i / (rings - 1);
      if (straight) {
        for (let k = 0; k < 3; k++) c[k] = path[0][k] + (path[1][k] - path[0][k]) * t;
      } else {
        crEval(path, t, c);
      }
      // tangent by central difference on the curve
      const dt = 1 / (rings - 1) * 0.5;
      if (straight) {
        for (let k = 0; k < 3; k++) {
          cPrev[k] = path[0][k] + (path[1][k] - path[0][k]) * Math.max(0, t - dt);
          cNext[k] = path[0][k] + (path[1][k] - path[0][k]) * Math.min(1, t + dt);
        }
      } else {
        crEval(path, Math.max(0, t - dt), cPrev);
        crEval(path, Math.min(1, t + dt), cNext);
      }
      _t.set(cNext[0] - cPrev[0], cNext[1] - cPrev[1], cNext[2] - cPrev[2]);
      if (_t.lengthSq() < 1e-12) _t.set(0, 1, 0);
      _t.normalize();

      // PARALLEL TRANSPORT. Deriving the frame from a fixed reference axis on
      // every ring flips it wherever the tube turns past the reference (a boot
      // does exactly that: it starts vertical at the ankle and ends horizontal
      // at the toe), which twists the cross-section 90 degrees mid-limb. So the
      // frame is seeded once and then carried along the curve by the same
      // rotation that carries the tangent.
      if (i === 0) {
        // Seed: `axis` is the world direction the rx half-extent points along.
        // Default flips with the sweep direction so that N (the rz axis) always
        // comes out pointing FORWARD (-Z), which is the convention every
        // `shape(angle, t)` below is written against.
        if (ref) _ref.set(ref[0], ref[1], ref[2]);
        else _ref.set(_t.y > 0 ? -1 : 1, 0, 0);
        if (Math.abs(_ref.dot(_t)) > 0.9) _ref.set(0, 0, -1);
        if (Math.abs(_ref.dot(_t)) > 0.9) _ref.set(0, 1, 0);
        _b.copy(_ref).addScaledVector(_t, -_ref.dot(_t)).normalize();
      } else {
        _axis.crossVectors(_tPrev, _t);
        const s = _axis.length();
        if (s > 1e-7) {
          _axis.multiplyScalar(1 / s);
          _b.applyAxisAngle(_axis, Math.atan2(s, _tPrev.dot(_t)));
        }
        _b.addScaledVector(_t, -_b.dot(_t));
        if (_b.lengthSq() < 1e-10) _b.set(_t.y, -_t.x, 0);
        _b.normalize();
      }
      _tPrev.copy(_t);
      _n.crossVectors(_b, _t).normalize();

      if (i > 0) {
        vSum += Math.hypot(c[0] - _e0[0], c[1] - _e0[1], c[2] - _e0[2]);
      }
      _e0[0] = c[0]; _e0[1] = c[1]; _e0[2] = c[2];

      const r = o.radius(t, _e1);
      const rx = r[0], rz = r[1];
      const w = o.weight(t);
      const row = this.vertexCount;

      for (let j = 0; j <= radial; j++) {
        const a = (j / radial) * Math.PI * 2;
        const ca = Math.cos(a), sa = Math.sin(a);
        const m = shape ? shape(a, t) : 1;
        const x = c[0] + _b.x * rx * ca * m + _n.x * rz * sa * m;
        const y = c[1] + _b.y * rx * ca * m + _n.y * rz * sa * m;
        const z = c[2] + _b.z * rx * ca * m + _n.z * rz * sa * m;
        this._vert(x, y, z, (j / radial) * uvU, vSum * uvV, w);
      }
      this.seams.push(row, row + radial);
      if (i === 0) firstRow = row;

      if (prevRow >= 0) {
        for (let j = 0; j < radial; j++) {
          const a0 = prevRow + j, a1 = prevRow + j + 1;
          const b0 = row + j, b1 = row + j + 1;
          run.push(a0, b0, b1, a0, b1, a1);
        }
      }
      prevRow = row;
    }

    // Both row indices are resolved BEFORE any cap vertex is appended, or the
    // second cap reads a row offset by the first cap's centre vertex.
    const lastRow = prevRow;
    if (o.capStart) this._cap(run, firstRow, 0, radial, o, true);
    if (o.capEnd) this._cap(run, lastRow, 1, radial, o, false);
  }

  _cap(run, row, t, radial, o, isStart) {
    // centroid
    let cx = 0, cy = 0, cz = 0;
    for (let j = 0; j < radial; j++) {
      const i = (row + j) * 3;
      cx += this.pos[i]; cy += this.pos[i + 1]; cz += this.pos[i + 2];
    }
    cx /= radial; cy /= radial; cz /= radial;
    const w = o.weight(t);
    const centre = this._vert(cx, cy, cz, 0.5, 0.5, w);
    for (let j = 0; j < radial; j++) {
      if (isStart) run.push(centre, row + j + 1, row + j);
      else run.push(centre, row + j, row + j + 1);
    }
  }

  /**
   * A displaced ellipsoid. `deform(dir, p, out)` may move the surface point
   * anywhere; it is called with the unit direction and the base position.
   */
  ellipsoid(o) {
    const run = this.runs[o.material | 0];
    const lat = o.lat ?? 18;
    const lon = o.lon ?? 24;
    const w = o.weight;
    const c = o.center;
    const r = o.radius;
    const p = [0, 0, 0];
    const rows = [];
    const skip = o.skip ?? null;
    for (let i = 0; i <= lat; i++) {
      const v = i / lat;
      const theta = v * Math.PI;
      const st = Math.sin(theta), ct = Math.cos(theta);
      const row = [];
      for (let j = 0; j <= lon; j++) {
        const u = j / lon;
        const phi = u * Math.PI * 2;
        const dx = st * Math.sin(phi), dy = ct, dz = st * Math.cos(phi);
        p[0] = c[0] + dx * r[0];
        p[1] = c[1] + dy * r[1];
        p[2] = c[2] + dz * r[2];
        if (o.deform) o.deform(dx, dy, dz, p);
        if (skip && skip(dx, dy, dz, p)) { row.push(-1); continue; }
        row.push(this._vert(p[0], p[1], p[2], u * (o.uvU ?? 2), v * (o.uvV ?? 2), w(dx, dy, dz, p)));
      }
      rows.push(row);
      if (i > 0) {
        const prev = rows[i - 1];
        for (let j = 0; j < lon; j++) {
          const a0 = prev[j], a1 = prev[j + 1], b0 = row[j], b1 = row[j + 1];
          if (a0 < 0 || a1 < 0 || b0 < 0 || b1 < 0) continue;
          run.push(a0, b0, b1, a0, b1, a1);
        }
      }
    }
    for (const row of rows) {
      if (row[0] >= 0 && row[lon] >= 0) this.seams.push(row[0], row[lon]);
    }
  }

  /**
   * A parametric quad grid. Used where a surface needs its own boundary curve
   * rather than a slice of a sphere — the hair cap, whose edge must follow the
   * hairline exactly or it comes out as a staircase.
   * `point(u, v, out)` writes a world position; `wrap` closes the u seam.
   */
  grid(o) {
    const run = this.runs[o.material | 0];
    const rows = o.rows, cols = o.cols;
    const p = [0, 0, 0];
    const w = o.weight;
    const table = [];
    for (let i = 0; i <= rows; i++) {
      const v = i / rows;
      const line = [];
      for (let j = 0; j <= cols; j++) {
        const u = j / cols;
        o.point(u, v, p);
        line.push(this._vert(p[0], p[1], p[2], u * (o.uvU ?? 1), v * (o.uvV ?? 1), w(u, v, p)));
      }
      table.push(line);
      if (i > 0) {
        const prev = table[i - 1];
        for (let j = 0; j < cols; j++) {
          run.push(prev[j], line[j], line[j + 1], prev[j], line[j + 1], prev[j + 1]);
        }
      }
    }
    if (o.wrap !== false) for (const line of table) this.seams.push(line[0], line[cols]);
  }

  build() {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(this.uv, 2));
    g.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(this.si, 4));
    g.setAttribute('skinWeight', new THREE.Float32BufferAttribute(this.sw, 4));

    const index = [];
    let start = 0;
    for (let m = 0; m < this.runs.length; m++) {
      const run = this.runs[m];
      for (let i = 0; i < run.length; i++) index.push(run[i]);
      if (run.length) g.addGroup(start, run.length, m);
      start += run.length;
    }
    g.setIndex(index);
    g.computeVertexNormals();

    // Weld normals across every tube/sphere seam, or the duplicated column of
    // vertices at u = 0 / u = 1 shows as a hard crease down the limb.
    const nrm = g.attributes.normal.array;
    for (let i = 0; i < this.seams.length; i += 2) {
      const a = this.seams[i] * 3, b = this.seams[i + 1] * 3;
      const x = nrm[a] + nrm[b], y = nrm[a + 1] + nrm[b + 1], z = nrm[a + 2] + nrm[b + 2];
      const l = Math.hypot(x, y, z) || 1;
      nrm[a] = nrm[b] = x / l;
      nrm[a + 1] = nrm[b + 1] = y / l;
      nrm[a + 2] = nrm[b + 2] = z / l;
    }
    g.attributes.normal.needsUpdate = true;
    g.computeBoundingSphere();
    return g;
  }
}

/* ====================================================================== */
/* Weight helpers                                                         */
/* ====================================================================== */

/**
 * Blend along a bone chain. `stops` is [[tCentre, boneName], ...] and the
 * weight ramps linearly between adjacent stops, so a knee bends without the
 * candy-wrapper pinch a hard assignment gives.
 */
function chain(stops) {
  const idx = stops.map((s) => BONE_INDEX[s[1]]);
  const ts = stops.map((s) => s[0]);
  const out = [0, 1, 0, 0];
  return (t) => {
    if (t <= ts[0]) { out[0] = idx[0]; out[1] = 1; out[2] = idx[0]; out[3] = 0; return out; }
    const last = ts.length - 1;
    if (t >= ts[last]) { out[0] = idx[last]; out[1] = 1; out[2] = idx[last]; out[3] = 0; return out; }
    let i = 0;
    while (i < last && t > ts[i + 1]) i++;
    const f = (t - ts[i]) / (ts[i + 1] - ts[i] || 1);
    // smoothstep the blend so the transition band is soft at both ends
    const s = f * f * (3 - 2 * f);
    out[0] = idx[i]; out[1] = 1 - s;
    out[2] = idx[i + 1]; out[3] = s;
    return out;
  };
}

function single(name) {
  const i = BONE_INDEX[name];
  const out = [i, 1, i, 0];
  return () => out;
}

/* ====================================================================== */
/* Material groups                                                        */
/* ====================================================================== */

export const MAT = {
  skin: 0,
  face: 1,
  shirt: 2,
  pants: 3,
  leather: 4,
  sole: 5,
  hair: 6,
  eye: 7,
};
const MAT_COUNT = 8;

/* ====================================================================== */
/* The body                                                               */
/* ====================================================================== */

function lerp(a, b, t) { return a + (b - a) * t; }

/**
 * Piecewise profile: `[[t, r], ...]` with smooth (cosine) interpolation between
 * the stops. Authoring a limb as a handful of measured radii reads far better
 * than stacking gaussian bumps and guessing what they sum to.
 */
function prof(t, keys) {
  if (t <= keys[0][0]) return keys[0][1];
  const last = keys.length - 1;
  if (t >= keys[last][0]) return keys[last][1];
  let i = 0;
  while (i < last && t > keys[i + 1][0]) i++;
  const f = (t - keys[i][0]) / (keys[i + 1][0] - keys[i][0]);
  const e = 0.5 - 0.5 * Math.cos(f * Math.PI);
  return keys[i][1] + (keys[i + 1][1] - keys[i][1]) * e;
}

/** Smooth 0..1 bump centred on `c` with half-width `w`. */
function bump(x, c, w) {
  const d = (x - c) / w;
  return d <= -1 || d >= 1 ? 0 : Math.cos(d * Math.PI * 0.5) ** 2;
}

/**
 * Build the whole body. Returns { geometry, skeleton } — the caller wraps it in
 * a SkinnedMesh with the material array.
 */
export function buildBody(build) {
  const sk = buildSkeleton(build);
  const P = sk.positions;
  const S = build.scale ?? 1;
  const G = build.limb ?? 1; // limb girth
  const CH = build.chest ?? 1;
  const WA = build.waist ?? 1;
  const B = new BodyBuilder(MAT_COUNT);

  const r2 = [0, 0];
  const mk = (rx, rz) => { r2[0] = rx; r2[1] = rz; return r2; };

  /* ---------------------------------------------------------- torso ---- */
  // The shirt IS the torso: there is no naked body under it to see through,
  // and one surface means one silhouette without an inter-penetration seam.
  {
    const hipY = P.hips[1], chestY = P.chest[1], neckY = P.neck[1];
    const path = [
      [0, hipY - 0.10 * S, 0.004 * S],
      [0, hipY + 0.03 * S, 0.006 * S],
      [0, lerp(hipY, chestY, 0.45), 0.004 * S],
      [0, chestY, -0.002 * S],
      [0, lerp(chestY, neckY, 0.62), -0.006 * S],
      [0, neckY + 0.052 * S, -0.012 * S],
    ];
    B.tube({
      material: MAT.shirt,
      path,
      rings: 26,
      radial: 22,
      uvV: 11,
      uvU: 8,
      capStart: true,
      capEnd: true,
      radius: (t) => {
        // t: 0 hem -> 1 base of the neck. Measured half-widths for a 46 cm
        // shoulder span once the deltoids (which belong to the ARM tube) are
        // added on top at +-0.176.
        const sh = build.shoulder ?? 1;
        const rx = prof(t, [
          [0.00, 0.138], [0.10, 0.150], [0.34, 0.132 * WA], [0.52, 0.140],
          [0.70, 0.156 * CH], [0.80, 0.172 * sh], [0.88, 0.166 * sh],
          [0.94, 0.132 * sh], [1.00, 0.062],
        ]);
        const rz = prof(t, [
          [0.00, 0.098], [0.10, 0.106], [0.34, 0.094 * WA], [0.52, 0.104],
          [0.70, 0.118 * CH], [0.80, 0.116], [0.88, 0.110],
          [0.94, 0.090], [1.00, 0.056],
        ]);
        return mk(rx * S, rz * S);
      },
      // Flatten the front and back: a human torso is an oval, not a cylinder,
      // and the spine leaves a shallow groove.
      shape: (a, t) => {
        const front = -Math.sin(a); // +1 at -Z
        let m = 1 - 0.055 * Math.abs(front);
        m -= 0.05 * Math.max(0, -front) * bump(t, 0.72, 0.4); // spine groove
        return m;
      },
      weight: chain([[0.0, 'hips'], [0.3, 'hips'], [0.5, 'spine'], [0.78, 'chest'], [1, 'chest']]),
    });

    // Collar: a folded band standing proud of the neck hole.
    B.tube({
      material: MAT.shirt,
      path: [
        [0, neckY - 0.028 * S, -0.010 * S],
        [0, neckY + 0.026 * S, -0.018 * S],
      ],
      rings: 5,
      radial: 18,
      uvV: 16,
      uvU: 7,
      radius: (t) => mk((0.074 + t * 0.020) * S, (0.066 + t * 0.020) * S),
      weight: chain([[0, 'chest'], [1, 'neck']]),
      shape: (a) => 1 - 0.16 * Math.max(0, -Math.sin(a)),
    });

    // Placket: the button strip down the front, a distinct raised ridge.
    B.tube({
      material: MAT.shirt,
      path: [
        [0, neckY - 0.02 * S, -0.084 * S],
        [0, lerp(chestY, neckY, 0.35), -0.104 * S],
        [0, lerp(hipY, chestY, 0.5), -0.098 * S],
        [0, hipY - 0.06 * S, -0.092 * S],
      ],
      rings: 10,
      radial: 8,
      uvV: 9,
      radius: () => mk(0.019 * S, 0.010 * S),
      weight: chain([[0, 'chest'], [0.45, 'spine'], [1, 'hips']]),
    });
  }

  /* ----------------------------------------------------------- belt ---- */
  {
    const y = P.hips[1] - 0.055 * S;
    B.tube({
      material: MAT.leather,
      path: [[0, y - 0.021 * S, 0.004 * S], [0, y + 0.021 * S, 0.004 * S]],
      rings: 3,
      radial: 22,
      uvV: 10,
      uvU: 6,
      radius: () => mk(0.150 * S * WA, 0.104 * S * WA),
      weight: single('hips'),
      shape: (a) => 1 - 0.05 * Math.abs(Math.sin(a)),
    });
    // buckle
    B.tube({
      material: MAT.sole,
      path: [[0, y, -0.108 * S * WA], [0, y, -0.121 * S * WA]],
      rings: 2,
      radial: 4,
      uvV: 8,
      radius: () => mk(0.026 * S, 0.019 * S),
      capStart: true,
      capEnd: true,
      weight: single('hips'),
    });
  }

  /* ----------------------------------------------------------- neck ---- */
  {
    const y0 = P.chest[1] + 0.048 * S;
    const y1 = P.head[1] + 0.012 * S;
    B.tube({
      material: MAT.face,
      path: [[0, y0, 0.010 * S], [0, lerp(y0, y1, 0.5), -0.002 * S], [0, y1 + 0.03 * S, -0.008 * S]],
      rings: 8,
      radial: 16,
      uvV: 4,
      capStart: true,
      radius: (t) => {
        const n = build.neck ?? 1;
        const k = prof(t, [[0, 0.062], [0.35, 0.052], [0.8, 0.048], [1, 0.043]]);
        return mk(k * n * S, (k * 0.94) * n * S);
      },
      // Sternocleidomastoid: two soft ridges down the front of the neck.
      shape: (a, t) => 1 + 0.07 * Math.max(0, -Math.sin(a)) * Math.abs(Math.cos(a)) * (1 - t),
      weight: chain([[0, 'chest'], [0.35, 'neck'], [1, 'head']]),
    });
  }

  /* ----------------------------------------------------------- head ---- */
  buildHead(B, P, build, S);

  /* ------------------------------------------------------------ arms --- */
  for (const side of ['R', 'L']) {
    const s = side === 'R' ? 1 : -1;
    const sh = P['arm' + side];
    const el = P['forearm' + side];
    const wr = P['hand' + side];
    const he = P['handEnd' + side];

    // Deltoid + upper arm, in skin (the sleeve covers its top half).
    B.tube({
      material: MAT.skin,
      path: [
        [sh[0] - s * 0.012 * S, sh[1] + 0.052 * S, sh[2]],
        [sh[0], sh[1] - 0.02 * S, sh[2]],
        [lerp(sh[0], el[0], 0.55), lerp(sh[1], el[1], 0.55), lerp(sh[2], el[2], 0.55) + 0.004 * S],
        [el[0], el[1], el[2]],
      ],
      rings: 14,
      radial: 14,
      uvV: 9,
      uvU: 3,
      capStart: true,
      radius: (t) => {
        const r = prof(t, [
          [0.00, 0.050], [0.16, 0.055], [0.48, 0.047], [0.82, 0.039], [1.00, 0.037],
        ]) * G;
        return mk(r * S, (r * 1.03) * S);
      },
      weight: chain([[0, 'arm' + side], [0.82, 'arm' + side], [1, 'forearm' + side]]),
    });

    // Forearm: oval, thick at the belly, bony at the wrist.
    B.tube({
      material: MAT.skin,
      path: [
        [el[0], el[1] + 0.012 * S, el[2]],
        [lerp(el[0], wr[0], 0.4), lerp(el[1], wr[1], 0.4), lerp(el[2], wr[2], 0.4) - 0.006 * S],
        [wr[0], wr[1], wr[2]],
      ],
      rings: 12,
      radial: 14,
      uvV: 9,
      uvU: 3,
      radius: (t) => {
        const r = prof(t, [
          [0.00, 0.038], [0.24, 0.043], [0.62, 0.033], [1.00, 0.026],
        ]) * G;
        return mk(r * S, (r * (1.14 - t * 0.2)) * S);
      },
      weight: chain([[0, 'forearm' + side], [0.86, 'forearm' + side], [1, 'hand' + side]]),
    });

    // Hand: a palm block that tapers into fingers, plus a thumb.
    B.tube({
      material: MAT.skin,
      path: [
        [wr[0], wr[1], wr[2]],
        [lerp(wr[0], he[0], 0.35), lerp(wr[1], he[1], 0.35), lerp(wr[2], he[2], 0.35) - 0.004 * S],
        [lerp(wr[0], he[0], 0.78), lerp(wr[1], he[1], 0.78), lerp(wr[2], he[2], 0.78)],
        [he[0], he[1], he[2] + 0.004 * S],
      ],
      rings: 12,
      radial: 14,
      uvV: 8,
      uvU: 2,
      capEnd: true,
      radius: (t) => {
        const taper = t > 0.80 ? Math.sqrt(Math.max(0, 1 - ((t - 0.80) / 0.20) ** 2)) : 1;
        const rx = prof(t, [[0, 0.014], [0.3, 0.017], [1, 0.014]]) * G * taper;
        const rz = prof(t, [[0, 0.031], [0.28, 0.044], [0.7, 0.040], [1, 0.032]]) * G * taper;
        return mk(rx * S, rz * S);
      },
      // Knuckle side is fuller than the palm side.
      shape: (a, t) => 1 + 0.06 * Math.max(0, Math.sin(a)) * bump(t, 0.55, 0.4),
      weight: chain([[0, 'hand' + side], [0.25, 'hand' + side], [1, 'handEnd' + side]]),
    });

    // Thumb, angled forward and inward from the base of the palm.
    B.tube({
      material: MAT.skin,
      path: [
        [wr[0] - s * 0.006 * S, wr[1] - 0.018 * S, wr[2] - 0.026 * S],
        [wr[0] - s * 0.016 * S, wr[1] - 0.05 * S, wr[2] - 0.044 * S],
        [wr[0] - s * 0.02 * S, wr[1] - 0.078 * S, wr[2] - 0.05 * S],
      ],
      rings: 7,
      radial: 9,
      uvV: 8,
      capEnd: true,
      radius: (t) => {
        const taper = t > 0.7 ? Math.sqrt(Math.max(0, 1 - ((t - 0.7) / 0.3) ** 2)) : 1;
        return mk(0.0125 * G * S * taper, 0.0135 * G * S * taper);
      },
      weight: single('hand' + side),
    });

    // Short sleeve: a separate garment shell that ends in a rolled hem.
    B.tube({
      material: MAT.shirt,
      path: [
        [sh[0] - s * 0.085 * S, sh[1] - 0.004 * S, sh[2] - 0.004 * S],
        [sh[0] - s * 0.010 * S, sh[1] - 0.012 * S, sh[2]],
        [lerp(sh[0], el[0], 0.40), lerp(sh[1], el[1], 0.40), lerp(sh[2], el[2], 0.40)],
        [lerp(sh[0], el[0], 0.50), lerp(sh[1], el[1], 0.50), lerp(sh[2], el[2], 0.50)],
      ],
      rings: 14,
      radial: 16,
      uvV: 12,
      uvU: 6,
      radius: (t) => {
        // Open at both ends: the arm inside is what you should see through the
        // shoulder seam and the hem, not a flat capping disc.
        const r = prof(t, [
          [0.00, 0.052], [0.16, 0.064], [0.34, 0.062], [0.70, 0.053], [0.90, 0.050], [1.00, 0.054],
        ]) * G;
        return mk(r * S, r * 1.04 * S);
      },
      weight: chain([[0, 'arm' + side], [0.1, 'arm' + side], [1, 'arm' + side]]),
    });
  }

  /* ------------------------------------------------------------ legs --- */
  for (const side of ['R', 'L']) {
    const s = side === 'R' ? 1 : -1;
    const hp = P['thigh' + side];
    const kn = P['shin' + side];
    const an = P['foot' + side];
    const to = P['toe' + side];

    // Trouser leg, hip to ankle, with a knee break and a cuff over the boot.
    B.tube({
      material: MAT.pants,
      path: [
        [hp[0], hp[1] + 0.075 * S, hp[2] + 0.006 * S],
        [hp[0] + s * 0.004 * S, hp[1] - 0.06 * S, hp[2] + 0.008 * S],
        [lerp(hp[0], kn[0], 0.55), lerp(hp[1], kn[1], 0.55), lerp(hp[2], kn[2], 0.55) + 0.004 * S],
        [kn[0], kn[1], kn[2]],
        [lerp(kn[0], an[0], 0.55), lerp(kn[1], an[1], 0.55), lerp(kn[2], an[2], 0.55) - 0.008 * S],
        [an[0], an[1] + 0.062 * S, an[2] - 0.012 * S],
      ],
      rings: 26,
      radial: 18,
      uvV: 10,
      uvU: 7,
      capStart: true,
      radius: (t) => {
        // 0 crotch -> 1 cuff. Real measurements: thigh 55 cm around (r 8.8 cm),
        // knee 38 (6.0), calf 37 (5.9), ankle 23 (3.7) plus trouser slack.
        const r = prof(t, [
          [0.00, 0.092], [0.16, 0.087], [0.38, 0.075], [0.55, 0.063],
          [0.62, 0.061], [0.74, 0.066], [0.90, 0.050], [1.00, 0.055],
        ]) * G;
        const depth = prof(t, [
          [0.00, 0.098], [0.16, 0.092], [0.38, 0.079], [0.55, 0.066],
          [0.62, 0.066], [0.74, 0.072], [0.90, 0.052], [1.00, 0.056],
        ]) * G;
        return mk(r * S, depth * S);
      },
      // Slight flatten front-to-back at the shin, and the fabric hangs.
      shape: (a, t) => 1 - 0.04 * Math.abs(Math.sin(a)) * (1 - t) + 0.02 * Math.max(0, Math.sin(a)) * t,
      weight: chain([
        [0.0, 'hips'], [0.12, 'thigh' + side], [0.5, 'thigh' + side],
        [0.62, 'shin' + side], [0.93, 'shin' + side], [1, 'foot' + side],
      ]),
    });

    // Boot: upper, then a proud sole in a second material.
    const bootPath = [
      [an[0], an[1] + 0.085 * S, an[2] - 0.006 * S],
      [an[0], an[1] + 0.018 * S, an[2] + 0.004 * S],
      [an[0], an[1] - 0.028 * S, an[2] - 0.05 * S],
      [to[0], to[1] + 0.012 * S, to[2] - 0.028 * S],
      [to[0], to[1] + 0.016 * S, to[2] - 0.062 * S],
    ];
    B.tube({
      material: MAT.leather,
      path: bootPath,
      rings: 18,
      radial: 14,
      uvV: 8,
      uvU: 3,
      capStart: true,
      capEnd: true,
      radius: (t) => {
        const ankle = bump(t, 0.12, 0.3);
        const instep = bump(t, 0.55, 0.4);
        const toeCap = t > 0.88 ? Math.sqrt(Math.max(0, 1 - ((t - 0.88) / 0.12) ** 2)) : 1;
        const rx = (0.047 + ankle * 0.005 + instep * 0.005) * G * toeCap;
        const rz = (0.046 - ankle * 0.002 - instep * 0.008) * G * toeCap;
        return mk(rx * S, rz * S);
      },
      shape: (a, t) => 1 + 0.1 * Math.max(0, -Math.cos(a)) * 0 + 0.06 * Math.max(0, -Math.sin(a)) * bump(t, 0.5, 0.5),
      weight: chain([[0, 'foot' + side], [0.62, 'foot' + side], [0.86, 'toe' + side], [1, 'toe' + side]]),
    });
    // Sole slab: sits under the boot, wider, with a heel.
    B.tube({
      material: MAT.sole,
      path: [
        [an[0], an[1] - 0.052 * S, an[2] + 0.03 * S],
        [an[0], an[1] - 0.056 * S, an[2] - 0.03 * S],
        [to[0], to[1] - 0.006 * S, to[2] - 0.03 * S],
        [to[0], to[1] - 0.004 * S, to[2] - 0.07 * S],
      ],
      rings: 12,
      radial: 12,
      uvV: 10,
      uvU: 4,
      capStart: true,
      capEnd: true,
      radius: (t) => {
        const heel = bump(t, 0.05, 0.2);
        const toeCap = t > 0.85 ? Math.sqrt(Math.max(0, 1 - ((t - 0.85) / 0.15) ** 2)) : 1;
        const rx = (0.051 + heel * 0.004) * G * toeCap;
        const rz = (0.016 + heel * 0.008) * G * toeCap;
        return mk(rx * S, rz * S);
      },
      weight: chain([[0, 'foot' + side], [0.6, 'foot' + side], [0.85, 'toe' + side], [1, 'toe' + side]]),
    });
    void s;
  }

  /* ------------------------------------------------------------ seat --- */
  // Bridge the two trouser legs so there is no gap at the crotch.
  {
    const hy = P.hips[1];
    B.tube({
      material: MAT.pants,
      path: [
        [P.thighL[0] * 1.0, hy + 0.05 * S, 0.006 * S],
        [0, hy - 0.055 * S, 0.006 * S],
        [P.thighR[0] * 1.0, hy + 0.05 * S, 0.006 * S],
      ],
      rings: 12,
      radial: 14,
      uvV: 10,
      uvU: 6,
      capStart: true,
      capEnd: true,
      radius: (t) => {
        const mid = bump(t, 0.5, 0.6);
        const r = (0.062 + mid * 0.022) * WA;
        return mk((r * 1.12) * S, (r * 0.98) * S);
      },
      weight: chain([[0, 'thighL'], [0.35, 'hips'], [0.65, 'hips'], [1, 'thighR']]),
    });
  }

  const geometry = B.build();
  return { geometry, skeleton: sk };
}

/* ====================================================================== */
/* Head                                                                   */
/* ====================================================================== */

/**
 * The head is an ellipsoid pushed around by a list of gaussian "features".
 * Each feature is evaluated against the UNDEFORMED surface point so the
 * displacements compose predictably.
 *
 * Feature = [cx, cy, cz, sx, sy, sz, dx, dy, dz, amount]
 * (centre, gaussian half-widths, push direction, magnitude — all in head-local
 * metres for a 1.78 m body).
 */
function buildHead(B, P, build, S) {
  const hb = P.head; // head bone, bind space
  const hs = (build.headScale ?? 1) * S;
  const jaw = build.jaw ?? 1;
  const brow = build.brow ?? 1;
  const nose = build.nose ?? 1;

  // Skull centre relative to the head bone.
  const c = [hb[0], hb[1] + 0.096 * hs, hb[2] + 0.004 * hs];
  // 143 x 214 x 191 mm — a measured male head. The first version was 167 mm
  // wide, and a head that broad turns every facial feature into a dimple.
  const r = [0.0715 * hs, 0.108 * hs, 0.0935 * hs];

  const EYE_X = 0.0305 * hs, EYE_Y = 0.008 * hs, EYE_Z = -0.070 * hs;

  /**
   * Fewer, cleaner features. An earlier version had thirty-four overlapping
   * gaussians and they fought each other into a lumpy caricature; at the range
   * a third-person camera actually sits, what reads is the SILHOUETTE (brow,
   * nose wedge, jaw, chin) and the VALUE (dark sockets, dark hair) — not
   * micro-anatomy. Everything that did not contribute to one of those is gone.
   */
  const feats = [
    // cranium: occiput out at the back, temples in, forehead flattened
    [0, 0.010, 0.066, 0.078, 0.078, 0.050, 0, 0, 1, 0.012],
    [0.060, 0.038, -0.008, 0.024, 0.034, 0.042, -1, 0, 0, 0.010],
    [-0.060, 0.038, -0.008, 0.024, 0.034, 0.042, 1, 0, 0, 0.010],
    [0, 0.062, -0.044, 0.038, 0.026, 0.030, 0, 0, 1, 0.010],

    // brow ridge — the shadow it casts is most of what says "face" at range
    [0.026, 0.031, -0.054, 0.024, 0.013, 0.034, 0, 0.3, -1, 0.018 * brow],
    [-0.026, 0.031, -0.054, 0.024, 0.013, 0.034, 0, 0.3, -1, 0.018 * brow],
    [0, 0.031, -0.066, 0.009, 0.011, 0.022, 0, 0, 1, 0.006],

    // eye sockets + lids
    [0.0305, 0.008, -0.064, 0.022, 0.015, 0.024, 0, 0, 1, 0.020],
    [-0.0305, 0.008, -0.064, 0.022, 0.015, 0.024, 0, 0, 1, 0.020],
    [0.0305, 0.022, -0.056, 0.022, 0.009, 0.022, 0, 0.7, -1, 0.014],
    [-0.0305, 0.022, -0.056, 0.022, 0.009, 0.022, 0, 0.7, -1, 0.014],

    // cheekbone
    [0.046, -0.012, -0.042, 0.021, 0.018, 0.030, 0.7, 0.2, -1, 0.010],
    [-0.046, -0.012, -0.042, 0.021, 0.018, 0.030, -0.7, 0.2, -1, 0.010],

    // NOSE: a narrow wedge from between the brows to a projecting tip
    [0, 0.018, -0.070, 0.008, 0.017, 0.020, 0, 0, -1, 0.011 * nose],
    [0, -0.008, -0.074, 0.009, 0.014, 0.020, 0, 0, -1, 0.020 * nose],
    [0, -0.026, -0.076, 0.011, 0.010, 0.020, 0, 0, -1, 0.028 * nose],
    [0, -0.037, -0.070, 0.010, 0.006, 0.016, 0, -0.8, 0.6, 0.012 * nose],
    [0.014, -0.032, -0.064, 0.008, 0.009, 0.017, 0.85, -0.2, -0.9, 0.011 * nose],
    [-0.014, -0.032, -0.064, 0.008, 0.009, 0.017, -0.85, -0.2, -0.9, 0.011 * nose],

    // mouth: two lips and the seam between them
    [0, -0.055, -0.063, 0.018, 0.007, 0.019, 0, 0.3, -1, 0.012],
    [0, -0.067, -0.061, 0.017, 0.008, 0.019, 0, -0.3, -1, 0.012],
    [0, -0.061, -0.065, 0.021, 0.0035, 0.017, 0, 0, 1, 0.010],

    // chin pad, with the crease above it. Pushed FORWARD only — an earlier
    // downward component turned the chin into a beak.
    [0, -0.074, -0.056, 0.014, 0.006, 0.015, 0, 0, 1, 0.007],
    [0, -0.084, -0.048, 0.022, 0.016, 0.024, 0, 0, -1, 0.014 * jaw],

    // mandible line, then the tuck under it into the neck
    [0.048, -0.052, -0.008, 0.026, 0.022, 0.032, 1, -0.2, 0, 0.011 * jaw],
    [-0.048, -0.052, -0.008, 0.026, 0.022, 0.032, -1, -0.2, 0, 0.011 * jaw],
    [0, -0.086, 0.024, 0.046, 0.024, 0.040, 0, 1, 0, 0.011],
  ];

  const headW = single('head');

  /**
   * The skull's silhouette, as measured width/depth scales down the vertical
   * axis. This is what makes a head read as a head rather than an egg: widest
   * at the cheekbones, tapering hard into the chin, and shallower at the crown.
   */
  const WIDTH = [
    [-1.00, 0.26], [-0.82, 0.46], [-0.60, 0.68], [-0.34, 0.87],
    [-0.10, 0.98], [0.14, 1.00], [0.42, 0.97], [0.72, 0.86], [1.00, 0.52],
  ];
  const DEPTH = [
    [-1.00, 0.44], [-0.82, 0.62], [-0.60, 0.78], [-0.34, 0.90],
    [-0.10, 0.98], [0.14, 1.00], [0.42, 0.98], [0.72, 0.90], [1.00, 0.58],
  ];

  const applyFeatures = (dx, dy, dz, p) => {
    // Vertical profile. `jaw` pulls the lower half in or out per brother.
    const yn = Math.max(-1, Math.min(1, (p[1] - c[1]) / r[1]));
    let w = prof(yn, WIDTH);
    let d = prof(yn, DEPTH);
    if (yn < 0) {
      const t = -yn;
      w *= 1 + (jaw - 1) * t * 0.9;
      d *= 1 + (jaw - 1) * t * 0.45;
    }
    p[0] = c[0] + (p[0] - c[0]) * w;
    p[2] = c[2] + (p[2] - c[2]) * d;
    for (let i = 0; i < feats.length; i++) {
      const f = feats[i];
      const ex = (p[0] - c[0]) / hs - f[0];
      const ey = (p[1] - c[1]) / hs - f[1];
      const ez = (p[2] - c[2]) / hs - f[2];
      const g = Math.exp(-((ex * ex) / (f[3] * f[3]) + (ey * ey) / (f[4] * f[4]) + (ez * ez) / (f[5] * f[5])));
      if (g < 0.02) continue;
      const a = f[9] * g * hs;
      p[0] += f[6] * a;
      p[1] += f[7] * a;
      p[2] += f[8] * a;
    }
  };

  /**
   * The face surface as a function of (theta, phi) — the deformed skull, not
   * the ellipsoid it started as. Anything that has to SIT ON the face rather
   * than near it (eyebrows, the hair fringe) has to be placed against this,
   * because the feature gaussians move the surface by up to 30 mm and geometry
   * authored against the raw ellipsoid ends up buried inside the result.
   */
  const surfaceAt = (theta, phi, out) => {
    const st = Math.sin(theta), ct = Math.cos(theta);
    const dx = st * Math.sin(phi), dy = ct, dz = st * Math.cos(phi);
    out[0] = c[0] + dx * r[0];
    out[1] = c[1] + dy * r[1];
    out[2] = c[2] + dz * r[2];
    applyFeatures(dx, dy, dz, out);
    return out;
  };

  /**
   * Move `p` horizontally (in XZ, keeping its height) until it stands
   * `clearance` proud of the face at that height.
   *
   * The push is deliberately NOT radial from the skull centre: on the forehead
   * a radial push is mostly +Y, so it would undo the very drop the hair fringe
   * had just applied and the fringe would never descend. Real hair falls in
   * FRONT of the brow, and so does an eyebrow — move them forward and leave
   * their height alone.
   *
   * `surfaceAt`'s y falls monotonically with theta, so the surface point at
   * p's own height is one bisection away.
   */
  const _sp = [0, 0, 0];
  const clearFace = (p, clearance) => {
    const dx = p[0] - c[0], dz = p[2] - c[2];
    const R = Math.hypot(dx, dz);
    if (R < 1e-5) return; // straight over the crown: nothing in front of it
    const ex = dx / R, ez = dz / R;
    const phi = Math.atan2(ex, ez);
    let lo = 0, hi = Math.PI;
    for (let k = 0; k < 14; k++) {
      const mid = (lo + hi) * 0.5;
      surfaceAt(mid, phi, _sp);
      if (_sp[1] > p[1]) lo = mid;
      else hi = mid;
    }
    surfaceAt((lo + hi) * 0.5, phi, _sp);
    const need = (_sp[0] - c[0]) * ex + (_sp[2] - c[2]) * ez + clearance;
    if (R >= need) return;
    p[0] = c[0] + ex * need;
    p[2] = c[2] + ez * need;
  };

  B.ellipsoid({
    material: MAT.face,
    center: c,
    radius: r,
    lat: 42,
    lon: 52,
    uvU: 2.6,
    uvV: 2.6,
    weight: headW,
    deform: applyFeatures,
  });

  /* ---- ears ---- */
  for (const s of [1, -1]) {
    // Helix: a flattened ring standing off the skull, thickest at the top.
    B.tube({
      material: MAT.face,
      path: [
        [c[0] + s * 0.064 * hs, c[1] + 0.030 * hs, c[2] + 0.000 * hs],
        [c[0] + s * 0.072 * hs, c[1] + 0.020 * hs, c[2] + 0.014 * hs],
        [c[0] + s * 0.071 * hs, c[1] - 0.008 * hs, c[2] + 0.016 * hs],
        [c[0] + s * 0.072 * hs, c[1] - 0.028 * hs, c[2] + 0.004 * hs],
      ],
      rings: 10,
      radial: 8,
      uvV: 14,
      capStart: true,
      capEnd: true,
      radius: (t) => {
        const k = Math.sin(Math.min(1, t * 1.06) * Math.PI) * 0.45 + 0.55;
        return [0.0090 * hs * k, 0.0125 * hs * k];
      },
      weight: headW,
    });
    // Lobe / concha: a small pad filling the ring so it is not a floating loop.
    B.tube({
      material: MAT.face,
      path: [
        [c[0] + s * 0.060 * hs, c[1] + 0.024 * hs, c[2] + 0.004 * hs],
        [c[0] + s * 0.064 * hs, c[1] - 0.014 * hs, c[2] + 0.006 * hs],
      ],
      rings: 5,
      radial: 8,
      uvV: 14,
      capStart: true,
      capEnd: true,
      radius: (t) => {
        const k = Math.sin(Math.min(1, 0.15 + t * 0.85) * Math.PI) * 0.4 + 0.6;
        return [0.0075 * hs * k, 0.013 * hs * k];
      },
      weight: headW,
    });
  }

  /* ---- eyes ----
   * The eyeball centre has to sit just BEHIND the socket floor so the lids
   * overlap its top and bottom and only a lens of it shows. Push it in by its
   * own radius and it disappears inside the skull entirely. */
  for (const s of [1, -1]) {
    B.ellipsoid({
      material: MAT.eye,
      center: [c[0] + s * EYE_X, c[1] + EYE_Y, c[2] - 0.0672 * hs],
      radius: [0.0122 * hs, 0.0122 * hs, 0.0122 * hs],
      lat: 12,
      lon: 16,
      uvU: 1,
      uvV: 1,
      weight: headW,
    });
  }

  /* ---- eyebrows ----
   * Authored on the bare ellipsoid, then pushed out onto the face the feature
   * gaussians actually produced. Without that last step the brow ridge — which
   * pushes the surface forward by up to 18 mm, and `brow` scales it further per
   * brother — swallows the tube whole: every eyebrow vertex on all three men
   * sat up to 23 mm INSIDE the head, so nobody had eyebrows at all. `clearance`
   * is well under the tube radius on purpose, so the brow beds into the skin
   * like a ridge of hair instead of floating off it like a caterpillar. */
  for (const s of [1, -1]) {
    const brows = [
      [c[0] + s * 0.010 * hs, c[1] + 0.026 * hs, c[2] - 0.076 * hs],
      [c[0] + s * 0.029 * hs, c[1] + 0.032 * hs, c[2] - 0.070 * hs],
      [c[0] + s * 0.047 * hs, c[1] + 0.024 * hs, c[2] - 0.050 * hs],
    ];
    for (const p of brows) clearFace(p, 0.0016 * hs);
    B.tube({
      material: MAT.hair,
      path: brows,
      rings: 6,
      radial: 6,
      uvV: 12,
      capStart: true,
      capEnd: true,
      radius: (t) => {
        const k = Math.sin(Math.min(1, t) * Math.PI) * 0.5 + 0.5;
        return [0.0055 * hs * k, 0.0035 * hs * k];
      },
      weight: headW,
    });
  }

  /* ---- hair ---- */
  const style = build.hair ?? 'crop';
  /**
   * The hairline, in head-local metres for the 1.78 m reference body; the skull
   * only spans y = -0.108 .. +0.108, so these are small numbers by construction.
   *
   * THREE HEIGHTS, and every one of them is ANATOMY, not taste. The shell is
   * only `thick` proud of the skull while the features it would have to cross
   * stand much further out than that, so a hairline in the wrong place either
   * lets a feature punch back out through the hair or leaves bare scalp:
   *
   *   front  the FOREHEAD hairline. Bounded BELOW by the face: the brow ridge
   *          stands 18 mm proud at y = +0.031 and the eyebrow tube sits on top
   *          of that reaching y = +0.036, so a front hairline under it puts the
   *          brow, the cheekbones and the nose straight back out through the
   *          hair. This is the number the FIRST hair bug was about (sweep's
   *          lowest hair was at +0.017 and mop's at -0.012 — a fringe over the
   *          eyes and down onto the nostrils) and it has not moved since.
   *   ear    the hairline OVER THE EAR. Bounded BELOW by the ear, whose helix
   *          tops out at y = +0.037 and stands ~11 mm proud of a skull the
   *          shell is up to 24 mm thick over: let the hairline fall past the
   *          ear and the shell simply eats it.
   *   nape   the hairline at the CENTRE BACK. Bounded by nothing but the
   *          collar, and this is the number the SECOND hair bug was about.
   *
   * WHY THE BACK IS ITS OWN NUMBER RATHER THAN A DROP GATED BY |x|. The
   * previous table had ONE hairline plus a `nape` drop gated by `(1 - side)`,
   * where `side` was |x| / 0.072 on the skull. But |x| is large over most of the
   * back of a head, not only at the temple, so that gate cancelled the nape
   * everywhere except a narrow strip down the centre-back — and with the temple
   * drop cut to 8 mm to keep the ear out of the shell, what was left was a
   * hairline pinned near y = +0.05 right the way round. That is a swim cap on
   * the crown with both temples and the whole back of the skull left as bare
   * scalp, and from the third-person camera it reads as a bald patch.
   *
   * The gate is now the AZIMUTH round the skull, because that is what actually
   * separates "in front of the ear" from "behind it":
   *
   *   u = atan2(|x| / 0.0715, -z / 0.0935) / PI
   *     u = 0     dead ahead (forehead)
   *     u = 0.5   the ear
   *     u = 1     dead behind (nape)
   *
   * and u is INDEPENDENT OF THETA down a meridian — both |x| and -z carry the
   * same sin(theta), which cancels inside the atan2. So `line` is one constant
   * per meridian and `y - line` falls monotonically from the crown to the
   * hairline, which is what lets the boundary scan below find the one root it
   * is looking for instead of the first of several.
   *
   * `node src/player/character/headprobe.mjs` is the gate on all of this: it
   * fires a ray at the head from 24 000 directions and exits non-zero if skin
   * is the nearest surface anywhere on the cranium — plus four more checks that
   * stop this from being traded against the fringe, the brows or the ears.
   * RUN IT BEFORE YOU TOUCH ANY NUMBER IN THIS BLOCK. Both hair bugs shipped
   * because the change was only ever looked at from the front.
   */
  const HAIR = {
    crop: { front: 0.072, ear: 0.043, nape: -0.036, thick: 0.010, fringe: 0.0 },
    sweep: { front: 0.071, ear: 0.041, nape: -0.052, thick: 0.017, fringe: 0.018 },
    mop: { front: 0.070, ear: 0.040, nape: -0.074, thick: 0.024, fringe: 0.026 },
  }[style] ?? { front: 0.071, ear: 0.042, nape: -0.046, thick: 0.013, fringe: 0.010 };

  /**
   * Hairline height against azimuth. Held FLAT across u = 0.40 .. 0.58 because
   * that brackets the ear's own footprint (front edge z = -0.005, u = 0.48;
   * back edge z = +0.028, u = 0.60) and hair does not grow on an ear. Gate 4 of
   * `headprobe.mjs` is what proves the shell still is not eating them: the
   * number of ray directions whose nearest surface is an ear is 439 right and
   * 436 left in 24 000, IDENTICAL to before this change.
   *
   * The moment it is past the ear it DIVES: on a real head the hairline behind
   * the ear is already down at lobe height, and it runs back and down from
   * there to the nape. Easing gently out of `ear` all the way to u = 1 instead
   * (the obvious reading of "it drops at the back") leaves the whole
   * back-quarter of the skull above the ear bare, which in profile is a bald
   * wedge running from the temple to the crown.
   */
  const HAIRLINE = [
    [0.00, HAIR.front],
    [0.26, HAIR.front - 0.010],
    [0.40, HAIR.ear],
    [0.58, HAIR.ear],
    [0.68, HAIR.ear - 0.048],
    [1.00, HAIR.nape],
  ];
  /** Metres of skull between the hairline and full shell thickness. */
  const HAIR_RAMP = 0.035;
  /**
   * Floor on how far the shell stands off the skull, metres.
   *
   * Thickness reaches zero AT the hairline, which would leave the cap's rim
   * vertices exactly COPLANAR with the skull — and the straight chord between
   * two adjacent meridians then cuts slightly inside a convex skull, worst
   * behind the ear where the hairline drops ~16 mm per meridian. The ray gate
   * passes either way (measured: 0 leaking directions in 60 000 with and
   * without), so this is not load-bearing; it is there so the depth prepass and
   * the shadow cascades never have to resolve two coincident surfaces. 1.5 mm
   * is under a seventh of the thinnest style's shell and subpixel in play.
   */
  const EDGE_LIFT = 0.0015;

  /**
   * Hair thickness at a surface point: zero below the hairline, ramping to the
   * full shell thickness `HAIR_RAMP` above it — get that shape wrong and the
   * character is either bald or wearing a helmet.
   */
  const hairThickness = (px, py, pz) => {
    const x = (px - c[0]) / hs;
    const y = (py - c[1]) / hs;
    const z = (pz - c[2]) / hs;
    const u = Math.atan2(Math.abs(x) / 0.0715, -z / 0.0935) / Math.PI;
    // A widow's peak. Without it the front hairline is a band ruled straight
    // across the forehead, which is the single thing that makes procedural
    // hair read as a swim cap rather than as hair.
    const peak = Math.exp(-(x * x) / 0.00035) * Math.max(0, 1 - u / 0.34);
    const line = prof(u, HAIRLINE) - peak * 0.013;
    const t = (y - line) / HAIR_RAMP;
    if (t <= 0) return 0;
    const k = Math.min(1, t);
    return HAIR.thick * k * k * (3 - 2 * k);
  };

  /**
   * The cap is parameterised from the crown DOWN TO THE HAIRLINE along every
   * meridian, so its edge *is* the hairline. Cutting a hair region out of a
   * sphere grid instead (the obvious approach) leaves a staircase you can count
   * the quads on, which is the single most obvious "procedural" tell there is.
   *
   * thetaLine(phi) is a coarse scan plus twelve bisections, run once at build
   * time for fifty-six meridians — about 3000 evaluations, under a millisecond.
   */
  // The cap now runs from the crown to a nape at theta ~ 2.3 rad instead of
  // stopping near the equator, so it needs more rows to keep the quad size
  // (and therefore the silhouette of the edge) where it was.
  const HLAT = 26, HLON = 56;
  const probe = [0, 0, 0];
  const LIMIT = Math.PI * 0.96;
  const thetaLine = new Float32Array(HLON + 1);
  for (let j = 0; j <= HLON; j++) {
    const phi = (j / HLON) * Math.PI * 2;
    let lo = 0, hi = LIMIT;
    for (let k = 1; k <= 48; k++) {
      const th = (k / 48) * LIMIT;
      surfaceAt(th, phi, probe);
      if (hairThickness(probe[0], probe[1], probe[2]) <= 0) {
        hi = th;
        lo = ((k - 1) / 48) * LIMIT;
        break;
      }
    }
    for (let k = 0; k < 12; k++) {
      const mid = (lo + hi) * 0.5;
      surfaceAt(mid, phi, probe);
      if (hairThickness(probe[0], probe[1], probe[2]) > 0) lo = mid;
      else hi = mid;
    }
    thetaLine[j] = lo;
  }
  // Smooth the boundary so one noisy meridian cannot notch the hairline.
  const edge = Float32Array.from(thetaLine);
  for (let j = 0; j <= HLON; j++) {
    const a = thetaLine[(j - 1 + HLON) % HLON];
    const b = thetaLine[j % HLON];
    const d = thetaLine[(j + 1) % HLON];
    edge[j] = (a + b * 2 + d) * 0.25;
  }
  edge[HLON] = edge[0];

  B.grid({
    material: MAT.hair,
    rows: HLAT,
    cols: HLON,
    uvU: 3.4,
    uvV: 1.6,
    weight: headW,
    point: (u, v, out) => {
      const jf = u * HLON;
      const j0 = Math.floor(jf), f = jf - j0;
      const line = edge[j0] * (1 - f) + edge[Math.min(HLON, j0 + 1)] * f;
      // Bias the rows toward the edge: that is where the silhouette is.
      const theta = line * (v * v * 0.4 + v * 0.6);
      const phi = u * Math.PI * 2;
      surfaceAt(theta, phi, out);
      const th = hairThickness(out[0], out[1], out[2]);
      const nx = (out[0] - c[0]) / r[0];
      const ny = (out[1] - c[1]) / r[1];
      const nz = (out[2] - c[2]) / r[2];
      const l = Math.hypot(nx, ny, nz) || 1;
      // Fade the clump variation out at the crown. Every meridian collapses to
      // the same point at theta = 0, so a per-phi displacement there fans the
      // pole into a star — which is exactly the spike that stood up out of the
      // top of all three heads.
      const pole = Math.min(1, theta / 0.30);
      const clump = 0.78 + 0.22 * Math.sin(phi * 6.0) * Math.sin(theta * 8.0 + 1.3) * pole;
      const amt = Math.max(th * clump, EDGE_LIFT) * hs;
      out[0] += (nx / l) * amt;
      out[1] += (ny / l) * amt;
      out[2] += (nz / l) * amt;
      if (HAIR.fringe > 0 && nz < -0.25) {
        out[1] -= HAIR.fringe * hs * Math.max(0, -nz - 0.25) * 1.6;
        // Only the fringe needs this. Every other vertex is already `amt` off
        // the very surface it was built from, and pushing those out again
        // would inflate the crown.
        clearFace(out, Math.max(amt, 0.005 * hs));
      }
    },
  });
}

/* ====================================================================== */
/* Assembly                                                               */
/* ====================================================================== */

/**
 * Build the full SkinnedMesh for one brother.
 * @returns {{ mesh, skeleton, bones, geometry, materials, boneIndex }}
 */
export function buildCharacter(build, materials) {
  const { geometry, skeleton: sk } = buildBody(build);

  const mesh = new THREE.SkinnedMesh(geometry, materials);
  mesh.name = 'player:body';
  // The body is skinned far from its bind bounds; culling it by that box makes
  // it vanish at the edge of frame.
  mesh.frustumCulled = false;
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  // Never let the physics auto-scan turn the player's own body into static
  // collision — he would then be standing inside a wall shaped like himself.
  mesh.userData.collision = false;
  mesh.userData.noCollision = true;

  const root = new THREE.Group();
  root.name = 'player:character';
  root.add(sk.root);
  root.add(mesh);
  root.updateMatrixWorld(true);

  const skeleton = new THREE.Skeleton(sk.bones);
  mesh.bind(skeleton, new THREE.Matrix4());

  return {
    root,
    mesh,
    skeleton,
    bones: sk.byName,
    boneList: sk.bones,
    geometry,
    bindPositions: sk.positions,
  };
}
