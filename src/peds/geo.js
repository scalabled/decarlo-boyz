/**
 * PEDS — procedural geometry toolkit for the civilian crowd.
 *
 * One thing sets this apart from a single-character builder: a pedestrian's
 * colours are NOT baked into the vertex stream. A crowd needs hundreds of
 * distinct colour schemes and it cannot afford hundreds of skinned geometries,
 * so the builder emits
 *
 *   color   vec3   baked shading only — AO x mottle. Palette-independent.
 *   owTint  vec3   (paletteSlot, grimeAmount, paleAmount)
 *
 * and the material resolves `palette[slot]` from a per-ped uniform array at
 * draw time. One geometry per silhouette, unlimited colour variety, and three
 * draw calls per pedestrian.
 *
 * UV CONVENTION — u,v are stored in **metres of surface** (u around the ring,
 * v along the path). The builder divides by the material's tile size when it
 * writes the attribute, so the same physical texel density holds on a shoe, a
 * sleeve and a coat hem without any per-part tuning.
 *
 * Nothing here runs per frame; it is all boot-time work.
 */

import * as THREE from 'three';

/* ------------------------------------------------------------------ */
/* Deterministic gradient noise                                        */
/* ------------------------------------------------------------------ */

const G3 = [
  [1, 1, 0], [-1, 1, 0], [1, -1, 0], [-1, -1, 0],
  [1, 0, 1], [-1, 0, 1], [1, 0, -1], [-1, 0, -1],
  [0, 1, 1], [0, -1, 1], [0, 1, -1], [0, -1, -1],
];

export class Noise {
  constructor(rng) {
    const p = new Uint8Array(256);
    for (let i = 0; i < 256; i++) p[i] = i;
    for (let i = 255; i > 0; i--) {
      const j = rng.int(0, i);
      const t = p[i];
      p[i] = p[j];
      p[j] = t;
    }
    this.perm = new Uint8Array(512);
    for (let i = 0; i < 512; i++) this.perm[i] = p[i & 255];
  }

  n3(x, y, z) {
    const p = this.perm;
    const fx = Math.floor(x), fy = Math.floor(y), fz = Math.floor(z);
    const X = fx & 255, Y = fy & 255, Z = fz & 255;
    x -= fx; y -= fy; z -= fz;
    const u = x * x * x * (x * (x * 6 - 15) + 10);
    const v = y * y * y * (y * (y * 6 - 15) + 10);
    const w = z * z * z * (z * (z * 6 - 15) + 10);
    const A = p[X] + Y, B = p[X + 1] + Y;
    const AA = p[A] + Z, AB = p[A + 1] + Z;
    const BA = p[B] + Z, BB = p[B + 1] + Z;
    const g = (h, dx, dy, dz) => {
      const q = G3[h % 12];
      return q[0] * dx + q[1] * dy + q[2] * dz;
    };
    const lerp = (a, b, t) => a + (b - a) * t;
    return lerp(
      lerp(
        lerp(g(p[AA], x, y, z), g(p[BA], x - 1, y, z), u),
        lerp(g(p[AB], x, y - 1, z), g(p[BB], x - 1, y - 1, z), u),
        v
      ),
      lerp(
        lerp(g(p[AA + 1], x, y, z - 1), g(p[BA + 1], x - 1, y, z - 1), u),
        lerp(g(p[AB + 1], x, y - 1, z - 1), g(p[BB + 1], x - 1, y - 1, z - 1), u),
        v
      ),
      w
    );
  }

  fbm3(x, y, z, oct = 4, lac = 2.03, gain = 0.5) {
    let a = 0.5, f = 1, s = 0, norm = 0;
    for (let i = 0; i < oct; i++) {
      s += a * this.n3(x * f, y * f, z * f);
      norm += a;
      a *= gain;
      f *= lac;
    }
    return s / norm;
  }

  ridge3(x, y, z, oct = 3) {
    let a = 0.5, f = 1, s = 0, norm = 0;
    for (let i = 0; i < oct; i++) {
      s += a * (1 - Math.abs(this.n3(x * f, y * f, z * f)) * 2);
      norm += a;
      a *= 0.5;
      f *= 2.07;
    }
    return s / norm;
  }
}

/* ------------------------------------------------------------------ */
/* Mesh records                                                        */
/* ------------------------------------------------------------------ */

export function emptyMesh() {
  return { p: [], n: [], uv: [], i: [] };
}

export function vcount(m) {
  return m.p.length / 3;
}

/** Superellipse ring in the XZ plane. `n` 2 = ellipse, 6+ = rounded box. */
export function superEllipse(rx, rz, n = 2, seg = 16, rot = 0) {
  const pts = new Array(seg);
  const e = 2 / n;
  for (let i = 0; i < seg; i++) {
    const t = (i / seg) * Math.PI * 2 + rot;
    const c = Math.cos(t), s = Math.sin(t);
    pts[i] = [
      rx * Math.sign(c) * Math.abs(c) ** e,
      rz * Math.sign(s) * Math.abs(s) ** e,
    ];
  }
  return pts;
}

export function ellipseProfile(rx, rz, seg = 16, rot = 0) {
  return superEllipse(rx, rz, 2, seg, rot);
}

/** Loft a sequence of rings into a tube. See ai/geo.js for the full contract. */
export function loft(rings, opts = {}) {
  const out = opts.into ?? emptyMesh();
  const closed = opts.closed !== false;
  const k = rings[0].pts.length;
  const P = out.p, N = out.n, UV = out.uv, I = out.i;
  const base = vcount(out);

  const uArr = new Float64Array(k + 1);
  const pos = [];
  const v = new THREE.Vector3();
  const q = new THREE.Quaternion();

  let vLen = 0;
  let prevCentre = null;
  const centres = [];

  for (let r = 0; r < rings.length; r++) {
    const ring = rings[r];
    const o = ring.o ?? [0, 0, 0];
    const s = ring.s ?? [1, 1];
    if (ring.q) q.copy(ring.q);
    else q.identity();
    const arr = new Float64Array(k * 3);
    let cx = 0, cy = 0, cz = 0;
    for (let j = 0; j < k; j++) {
      const pt = ring.pts[j];
      v.set(pt[0] * s[0], ring.y ?? 0, pt[1] * s[1]);
      v.applyQuaternion(q);
      v.x += o[0]; v.y += o[1]; v.z += o[2];
      arr[j * 3] = v.x; arr[j * 3 + 1] = v.y; arr[j * 3 + 2] = v.z;
      cx += v.x; cy += v.y; cz += v.z;
    }
    cx /= k; cy /= k; cz /= k;
    centres.push([cx, cy, cz]);
    if (prevCentre) {
      vLen += Math.hypot(cx - prevCentre[0], cy - prevCentre[1], cz - prevCentre[2]);
    }
    prevCentre = [cx, cy, cz];
    pos.push({ arr, v: vLen });
  }

  {
    const a = pos[0].arr;
    uArr[0] = 0;
    for (let j = 1; j <= k; j++) {
      const j0 = ((j - 1) % k) * 3, j1 = (j % k) * 3;
      uArr[j] = uArr[j - 1] + Math.hypot(a[j1] - a[j0], a[j1 + 1] - a[j0 + 1], a[j1 + 2] - a[j0 + 2]);
    }
  }

  const cols = closed ? k + 1 : k;
  for (let r = 0; r < pos.length; r++) {
    const arr = pos[r].arr;
    for (let c = 0; c < cols; c++) {
      const j = (c % k) * 3;
      P.push(arr[j], arr[j + 1], arr[j + 2]);
      N.push(0, 0, 0);
      UV.push(uArr[c], pos[r].v);
    }
  }

  for (let r = 0; r + 1 < pos.length; r++) {
    for (let c = 0; c + 1 < cols; c++) {
      const a = base + r * cols + c;
      const b = a + 1;
      const d = base + (r + 1) * cols + c;
      const e = d + 1;
      I.push(a, d, b, b, d, e);
    }
  }

  const cap = (ringIndex, flip) => {
    const arr = pos[ringIndex].arr;
    const c = centres[ringIndex];
    const cIdx = vcount(out);
    P.push(c[0], c[1], c[2]);
    N.push(0, 0, 0);
    UV.push(uArr[k] * 0.5, pos[ringIndex].v);
    const start = vcount(out);
    for (let j = 0; j < k; j++) {
      P.push(arr[j * 3], arr[j * 3 + 1], arr[j * 3 + 2]);
      N.push(0, 0, 0);
      const ang = (j / k) * Math.PI * 2;
      UV.push(uArr[k] * 0.5 + Math.cos(ang) * 0.02, pos[ringIndex].v + Math.sin(ang) * 0.02);
    }
    for (let j = 0; j < k; j++) {
      const a = start + j;
      const b = start + ((j + 1) % k);
      if (flip) I.push(cIdx, b, a);
      else I.push(cIdx, a, b);
    }
  };
  if (opts.capStart) cap(0, true);
  if (opts.capEnd) cap(pos.length - 1, false);

  return out;
}

export function pathFrames(points, upRef = [0, 0, 1]) {
  const frames = [];
  const dir = new THREE.Vector3();
  const up = new THREE.Vector3();
  const m = new THREE.Matrix4();
  const x = new THREE.Vector3();
  const z = new THREE.Vector3();
  for (let i = 0; i < points.length; i++) {
    const a = points[Math.max(0, i - 1)];
    const b = points[Math.min(points.length - 1, i + 1)];
    dir.set(b[0] - a[0], b[1] - a[1], b[2] - a[2]);
    if (dir.lengthSq() < 1e-12) dir.set(0, 1, 0);
    dir.normalize();
    up.set(upRef[0], upRef[1], upRef[2]);
    if (Math.abs(up.dot(dir)) > 0.97) up.set(1, 0, 0);
    x.copy(dir).cross(up).normalize();
    z.copy(x).cross(dir).normalize();
    m.makeBasis(x, dir, z);
    frames.push(new THREE.Quaternion().setFromRotationMatrix(m));
  }
  return frames;
}

export function tube(points, profile, opts = {}) {
  const frames = opts.frames ?? pathFrames(points, opts.up ?? [0, 0, 1]);
  const rings = [];
  const n = points.length;
  for (let i = 0; i < n; i++) {
    rings.push({ pts: profile(i / (n - 1), i), o: points[i], q: frames[i] });
  }
  return loft(rings, opts);
}

export function revolve(profile, seg = 20, opts = {}) {
  const rings = [];
  for (let i = 0; i < profile.length; i++) {
    const [r, y] = profile[i];
    const rz = opts.squash ? r * opts.squash : r;
    rings.push({ pts: ellipseProfile(Math.max(1e-4, r), Math.max(1e-4, rz), seg), o: [0, y, 0] });
  }
  return loft(rings, opts);
}

export function boxRound(hx, hy, hz, opts = {}) {
  const n = opts.n ?? 5;
  const seg = opts.seg ?? 20;
  const rows = opts.rows ?? 9;
  const roundY = opts.roundY ?? 0.28;
  const ny = opts.ny ?? 5;
  const rings = [];
  for (let r = 0; r < rows; r++) {
    const t = r / (rows - 1);
    const y = (t * 2 - 1) * hy;
    const a = Math.min(1, Math.abs(y) / hy);
    const k = Math.min(1, Math.max(0, (a - (1 - roundY)) / roundY));
    const env = Math.max(0, 1 - k ** ny) ** (1 / ny);
    const e = Math.max(0.02, env);
    rings.push({ pts: superEllipse(hx * e, hz * e, n, seg), o: [0, y, 0] });
  }
  return loft(rings, { ...opts, capStart: false, capEnd: false });
}

export function ellipsoid(rx, ry, rz, opts = {}) {
  const seg = opts.seg ?? 22;
  const rows = opts.rows ?? 14;
  const v0 = opts.v0 ?? 0;
  const v1 = opts.v1 ?? 1;
  const rings = [];
  for (let r = 0; r < rows; r++) {
    const t = v0 + (v1 - v0) * (r / (rows - 1));
    const phi = t * Math.PI;
    const y = -Math.cos(phi) * ry;
    const s = Math.sin(phi);
    rings.push({ pts: ellipseProfile(Math.max(1e-4, rx * s), Math.max(1e-4, rz * s), seg), o: [0, y, 0] });
  }
  return loft(rings, opts);
}

export function ribbon(points, width, thick, opts = {}) {
  const half = width * 0.5, ht = thick * 0.5;
  const pts = opts.upright
    ? superEllipse(ht, half, 4, opts.seg ?? 8)
    : superEllipse(half, ht, 4, opts.seg ?? 8);
  return tube(points, () => pts, { ...opts, capStart: true, capEnd: true });
}

/* ------------------------------------------------------------------ */
/* Mesh ops                                                            */
/* ------------------------------------------------------------------ */

export function computeNormals(m, from = 0) {
  const P = m.p, N = m.n, I = m.i;
  for (let i = from * 3; i < N.length; i++) N[i] = 0;
  for (let t = 0; t < I.length; t += 3) {
    const a = I[t] * 3, b = I[t + 1] * 3, c = I[t + 2] * 3;
    if (a < from * 3 && b < from * 3 && c < from * 3) continue;
    const ax = P[a], ay = P[a + 1], az = P[a + 2];
    const e1x = P[b] - ax, e1y = P[b + 1] - ay, e1z = P[b + 2] - az;
    const e2x = P[c] - ax, e2y = P[c + 1] - ay, e2z = P[c + 2] - az;
    const nx = e1y * e2z - e1z * e2y;
    const ny = e1z * e2x - e1x * e2z;
    const nz = e1x * e2y - e1y * e2x;
    N[a] += nx; N[a + 1] += ny; N[a + 2] += nz;
    N[b] += nx; N[b + 1] += ny; N[b + 2] += nz;
    N[c] += nx; N[c + 1] += ny; N[c + 2] += nz;
  }
  for (let i = from * 3; i < N.length; i += 3) {
    const l = Math.hypot(N[i], N[i + 1], N[i + 2]) || 1;
    N[i] /= l; N[i + 1] /= l; N[i + 2] /= l;
  }
  return m;
}

export function weldNormals(m, eps = 1e-4) {
  const P = m.p, N = m.n;
  const cell = 1 / eps;
  const map = new Map();
  const n = vcount(m);
  for (let i = 0; i < n; i++) {
    const k =
      `${Math.round(P[i * 3] * cell)},${Math.round(P[i * 3 + 1] * cell)},${Math.round(P[i * 3 + 2] * cell)}`;
    let list = map.get(k);
    if (!list) map.set(k, (list = []));
    list.push(i);
  }
  for (const list of map.values()) {
    if (list.length < 2) continue;
    let nx = 0, ny = 0, nz = 0;
    for (const i of list) {
      nx += N[i * 3]; ny += N[i * 3 + 1]; nz += N[i * 3 + 2];
    }
    const l = Math.hypot(nx, ny, nz) || 1;
    nx /= l; ny /= l; nz /= l;
    for (const i of list) {
      N[i * 3] = nx; N[i * 3 + 1] = ny; N[i * 3 + 2] = nz;
    }
  }
  return m;
}

export function displace(m, fn, from = 0) {
  const P = m.p, N = m.n;
  const n = vcount(m);
  for (let i = from; i < n; i++) {
    const x = P[i * 3], y = P[i * 3 + 1], z = P[i * 3 + 2];
    const nx = N[i * 3], ny = N[i * 3 + 1], nz = N[i * 3 + 2];
    const d = fn(x, y, z, nx, ny, nz, i);
    if (!d) continue;
    P[i * 3] = x + nx * d;
    P[i * 3 + 1] = y + ny * d;
    P[i * 3 + 2] = z + nz * d;
  }
  return m;
}

export function warp(m, fn, from = 0) {
  const P = m.p;
  const v = new THREE.Vector3();
  const n = vcount(m);
  for (let i = from; i < n; i++) {
    v.set(P[i * 3], P[i * 3 + 1], P[i * 3 + 2]);
    fn(v, i);
    P[i * 3] = v.x; P[i * 3 + 1] = v.y; P[i * 3 + 2] = v.z;
  }
  return m;
}

export function transformMesh(m, matrix) {
  const nm = new THREE.Matrix3().getNormalMatrix(matrix);
  const v = new THREE.Vector3();
  const P = m.p, N = m.n;
  const n = vcount(m);
  for (let i = 0; i < n; i++) {
    v.set(P[i * 3], P[i * 3 + 1], P[i * 3 + 2]).applyMatrix4(matrix);
    P[i * 3] = v.x; P[i * 3 + 1] = v.y; P[i * 3 + 2] = v.z;
    v.set(N[i * 3], N[i * 3 + 1], N[i * 3 + 2]).applyMatrix3(nm).normalize();
    N[i * 3] = v.x; N[i * 3 + 1] = v.y; N[i * 3 + 2] = v.z;
  }
  return m;
}

export function appendMesh(dst, src) {
  const base = vcount(dst);
  for (let i = 0; i < src.p.length; i++) dst.p.push(src.p[i]);
  for (let i = 0; i < src.n.length; i++) dst.n.push(src.n[i]);
  for (let i = 0; i < src.uv.length; i++) dst.uv.push(src.uv[i]);
  for (let i = 0; i < src.i.length; i++) dst.i.push(src.i[i] + base);
  return dst;
}

/* ------------------------------------------------------------------ */
/* Character builder                                                   */
/* ------------------------------------------------------------------ */

/**
 * Palette slots. A part names one of these instead of carrying a literal
 * colour, and the ped's own `owPalette` uniform decides what it actually is.
 * The count is a shader constant — do not change it without changing
 * PALETTE_SIZE in materials.js.
 */
export const SLOT = {
  skin: 0,
  hair: 1,
  top: 2,     // coat / jacket / hoodie shell
  under: 3,   // shirt / jumper / lining visible at the opening
  bottom: 4,  // trousers / skirt / jeans
  shoe: 5,
  accent: 6,  // scarf, tie, hi-vis, bag strap, hood lining
  hat: 7,
  hard: 8,    // plastic / metal: buttons, phone, umbrella pole, hard hat
  dark: 9,    // eyes, soles, deep shadow parts
  skin2: 10,  // lips / darker skin regions
  extra: 11,  // bag body, second accent
};
export const PALETTE_SIZE = 12;

export class CharacterBuilder {
  constructor(rig, opts = {}) {
    this.rig = rig;
    this.noise = opts.noise;
    this.parts = [];
    this.materials = opts.materials;
    this.occluders = [];
  }

  /**
   * @param mesh  mesh record (metres, actor bind space)
   * @param o     { material, bones, bone, slot, grime, dirt, dust, wear,
   *                shade, tile, name }
   */
  add(mesh, o) {
    if (!mesh || !mesh.p.length) return this;
    computeNormals(mesh);
    if (o.weld !== false) weldNormals(mesh);
    this.parts.push({ mesh, ...o });
    return this;
  }

  occlude(a, b, r, k = 1) {
    this.occluders.push({ a, b, r, k });
    return this;
  }

  build() {
    const matNames = [];
    for (const p of this.parts) if (!matNames.includes(p.material)) matNames.push(p.material);
    const order = [];
    for (const m of matNames) for (const p of this.parts) if (p.material === m) order.push(p);

    let vTotal = 0, iTotal = 0;
    for (const p of order) {
      vTotal += vcount(p.mesh);
      iTotal += p.mesh.i.length;
    }

    const pos = new Float32Array(vTotal * 3);
    const nrm = new Float32Array(vTotal * 3);
    const uv = new Float32Array(vTotal * 2);
    const col = new Float32Array(vTotal * 3);
    const tint = new Float32Array(vTotal * 3);
    const skinIndex = new Uint16Array(vTotal * 4);
    const skinWeight = new Float32Array(vTotal * 4);
    const idx = vTotal > 65535 ? new Uint32Array(iTotal) : new Uint16Array(iTotal);

    const groups = [];
    let vo = 0, io = 0;
    let curMat = null, groupStart = 0;

    for (const p of order) {
      if (p.material !== curMat) {
        if (curMat !== null) groups.push({ start: groupStart, count: io - groupStart, mat: curMat });
        curMat = p.material;
        groupStart = io;
      }
      const m = p.mesh;
      const n = vcount(m);
      const tile = p.tile ?? this.materials[p.material]?.tile ?? 0.4;
      const inv = 1 / tile;
      for (let i = 0; i < n; i++) {
        pos[(vo + i) * 3] = m.p[i * 3];
        pos[(vo + i) * 3 + 1] = m.p[i * 3 + 1];
        pos[(vo + i) * 3 + 2] = m.p[i * 3 + 2];
        nrm[(vo + i) * 3] = m.n[i * 3];
        nrm[(vo + i) * 3 + 1] = m.n[i * 3 + 1];
        nrm[(vo + i) * 3 + 2] = m.n[i * 3 + 2];
        uv[(vo + i) * 2] = m.uv[i * 2] * inv + (p.uvOffset?.[0] ?? 0);
        uv[(vo + i) * 2 + 1] = m.uv[i * 2 + 1] * inv + (p.uvOffset?.[1] ?? 0);
      }
      for (let i = 0; i < m.i.length; i++) idx[io + i] = m.i[i] + vo;
      p._vo = vo;
      p._vn = n;
      vo += n;
      io += m.i.length;
    }
    groups.push({ start: groupStart, count: io - groupStart, mat: curMat });

    for (const p of order) this._bind(p, pos, skinIndex, skinWeight);
    this._shade(order, pos, nrm, col, tint);

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('normal', new THREE.BufferAttribute(nrm, 3));
    geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
    geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
    geo.setAttribute('owTint', new THREE.BufferAttribute(tint, 3));
    geo.setAttribute('skinIndex', new THREE.BufferAttribute(skinIndex, 4));
    geo.setAttribute('skinWeight', new THREE.BufferAttribute(skinWeight, 4));
    geo.setIndex(new THREE.BufferAttribute(idx, 1));
    for (const g of groups) geo.addGroup(g.start, g.count, matNames.indexOf(g.mat));
    geo.computeBoundingSphere();
    geo.boundingSphere.radius *= 1.5;
    geo.computeBoundingBox();

    return {
      geometry: geo,
      materialNames: matNames,
      vertices: vTotal,
      triangles: iTotal / 3,
      parts: order.map((p) => ({ name: p.name, material: p.material, start: p._vo, count: p._vn })),
    };
  }

  _bind(part, pos, skinIndex, skinWeight) {
    const rig = this.rig;
    const n = part._vn, vo = part._vo;
    if (part.bone) {
      const bi = rig.index(part.bone);
      for (let i = 0; i < n; i++) {
        skinIndex[(vo + i) * 4] = bi;
        skinWeight[(vo + i) * 4] = 1;
      }
      return;
    }
    const names = part.bones ?? ['Hips'];
    const cands = names.map((nm) => rig.index(nm));
    const C = cands.length;
    const bias = part.bias ?? null;
    const power = part.power ?? 3.2;

    /**
     * RADIAL CANDIDATES — measured from the bone's JOINT, not from its segment.
     *
     * The civilian bind pose is a relaxed stand, so the upper-arm segment hangs
     * alongside the ribs: a coat vertex on the FLANK at y = 1.15 is only ~5 cm
     * from the `UpperArm` segment and ~10 cm from `Spine1`. Inverse-distance to
     * the segment therefore gave the coat's flank more weight on the arm than
     * on the spine, and when the arm lifted, the side of the coat went up with
     * it. Measured, before this: a coat edge went 27.7 mm -> 115.9 mm on a LIVE
     * pedestrian in `cower`.
     *
     * A garment shell wants the opposite falloff — the arm should own the top
     * of the shoulder and nothing else — which is what distance from the
     * shoulder JOINT gives: 3 cm at the deltoid, 24 cm at the flank.
     *
     * Limb garments (sleeves, trouser legs) still measure to the segment, which
     * is correct for them: a sleeve really is a tube around the whole bone.
     */
    const radial = part.joint ? names.map((nm) => part.joint.includes(nm)) : null;

    /* --- dense weight field over this part's candidate bones --- */
    const W = new Float64Array(n * C);
    for (let i = 0; i < n; i++) {
      const x = pos[(vo + i) * 3], y = pos[(vo + i) * 3 + 1], z = pos[(vo + i) * 3 + 2];
      let tot = 0;
      for (let c = 0; c < C; c++) {
        const j = rig.bindPos[cands[c]];
        const d = radial && radial[c]
          ? Math.hypot(x - j.x, y - j.y, z - j.z)
          : rig.distanceToBone(cands[c], x, y, z);
        let w = 1 / (d ** power + 1e-6);
        if (bias) w *= bias[c] ?? 1;
        W[i * C + c] = w;
        tot += w;
      }
      if (tot > 0) for (let c = 0; c < C; c++) W[i * C + c] /= tot;
      else W[i * C] = 1;
    }

    /* --- top four, renormalised --- */
    for (let i = 0; i < n; i++) {
      let i0 = -1, i1 = -1, i2 = -1, i3 = -1;
      let w0 = -1, w1 = -1, w2 = -1, w3 = -1;
      for (let c = 0; c < C; c++) {
        const w = W[i * C + c];
        if (w > w0) { i3 = i2; w3 = w2; i2 = i1; w2 = w1; i1 = i0; w1 = w0; i0 = c; w0 = w; }
        else if (w > w1) { i3 = i2; w3 = w2; i2 = i1; w2 = w1; i1 = c; w1 = w; }
        else if (w > w2) { i3 = i2; w3 = w2; i2 = c; w2 = w; }
        else if (w > w3) { i3 = c; w3 = w; }
      }
      const picks = [i0, i1, i2, i3];
      const ws = [w0, w1, w2, w3];
      let tot = 0;
      for (let s = 0; s < 4; s++) if (picks[s] >= 0 && ws[s] > 0) tot += ws[s];
      if (tot <= 0) {
        skinIndex[(vo + i) * 4] = cands[0];
        skinWeight[(vo + i) * 4] = 1;
        continue;
      }
      for (let s = 0; s < 4; s++) {
        const c = picks[s];
        if (c < 0 || ws[s] <= 0) continue;
        skinIndex[(vo + i) * 4 + s] = cands[c];
        skinWeight[(vo + i) * 4 + s] = ws[s] / tot;
      }
    }
  }

  /**
   * Bake shading, NOT colour.
   *
   * `col` is the palette-independent multiplier: capsule AO, broad value
   * mottle and the pale rub of edge wear folded in as a lightening. `tint`
   * carries (slot, grime, pale) so the shader can blend the ped's own palette
   * entry toward the shared grime and dust colours. A city crowd wants dirty
   * hems, greasy cuffs and dusty shoulders exactly as much as a soldier does,
   * but it must not have them baked to one colour.
   */
  _shade(order, pos, nrm, col, tint) {
    const occ = this.occluders;
    const nz = this.noise;
    const groundDirt = (y) => Math.max(0, 1 - Math.max(0, y - 0.02) / 0.5);
    for (const part of order) {
      const n = part._vn, vo = part._vo;
      const slot = part.slot ?? SLOT.top;
      const shade = part.shade ?? 1;
      const wearAmt = part.wear ?? 0;
      const grimeAmt = part.grime ?? 0.5;
      const dirtAmt = part.dirt ?? 0.35;
      const dustAmt = part.dust ?? 0.16;
      for (let i = 0; i < n; i++) {
        const vi = vo + i;
        const x = pos[vi * 3], y = pos[vi * 3 + 1], z = pos[vi * 3 + 2];
        const nx = nrm[vi * 3], ny = nrm[vi * 3 + 1], nz3 = nrm[vi * 3 + 2];

        let ao = 1;
        for (let o = 0; o < occ.length; o++) {
          const c = occ[o];
          const d = segDist(x, y, z, c.a, c.b);
          const t = d - c.r;
          if (t > 0.09) continue;
          let dx = closestX - x, dy = closestY - y, dz = closestZ - z;
          const dl = Math.hypot(dx, dy, dz) || 1;
          dx /= dl; dy /= dl; dz /= dl;
          const face = Math.max(0, nx * dx + ny * dy + nz3 * dz);
          const w = (1 - Math.min(1, Math.max(0, t) / 0.09)) * face * c.k;
          ao *= 1 - 0.40 * w;
        }

        // crevice grime follows the AO: collar folds, cuffs, under a bag strap
        const grime = Math.min(0.85, (1 - ao) * grimeAmt);
        // ground splash on hems, shoes and trouser cuffs — this is a wet city
        const dirt = groundDirt(y) * dirtAmt * (0.5 + 0.5 * nz.fbm3(x * 24, y * 24, z * 24, 2));
        // settled damp/dust on up-facing surfaces: shoulders, hat crowns, bag tops
        const dust =
          Math.max(0, ny) ** 2.2 * (0.35 + 0.65 * nz.fbm3(x * 13 + 4, y * 13, z * 13 + 9, 2)) * dustAmt;
        let wear = 0;
        if (wearAmt > 0) {
          const upness = Math.max(0, ny) * 0.5 + Math.abs(nz3) * 0.5;
          const nv = nz.fbm3(x * 32 + 11, y * 32, z * 32 - 7, 3);
          wear = wearAmt * upness * Math.max(0, nv * 0.5 + 0.42) ** 1.7;
        }
        const mottle = 1 + 0.06 * nz.fbm3(x * 9, y * 9, z * 9, 3);
        const fine = 1 + 0.03 * nz.fbm3(x * 41, y * 41, z * 41, 2);

        const m = ao * mottle * fine * shade;
        col[vi * 3] = m;
        col[vi * 3 + 1] = m * (1 + 0.012 * nz.fbm3(x * 6 + 21, y * 6, z * 6, 2));
        col[vi * 3 + 2] = m * (1 - 0.014 * nz.fbm3(x * 6 - 13, y * 6, z * 6, 2));

        // These two channels REPAINT the palette entry, so they are capped
        // well below 1. The first pass let them saturate and every dirty hem,
        // every shoe and every pair of trousers came out the same grey-brown
        // regardless of what colour the person was actually wearing.
        tint[vi * 3] = slot;
        tint[vi * 3 + 1] = Math.min(0.58, grime * 0.50 + dirt * 0.42);
        tint[vi * 3 + 2] = Math.min(0.42, dust * 0.48 + wear * 0.52);
      }
    }
  }
}

let closestX = 0, closestY = 0, closestZ = 0;
export function segDist(px, py, pz, a, b) {
  const ax = a[0], ay = a[1], az = a[2];
  const bx = b[0], by = b[1], bz = b[2];
  const dx = bx - ax, dy = by - ay, dz = bz - az;
  const l2 = dx * dx + dy * dy + dz * dz;
  let t = l2 > 1e-12 ? ((px - ax) * dx + (py - ay) * dy + (pz - az) * dz) / l2 : 0;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  closestX = ax + dx * t;
  closestY = ay + dy * t;
  closestZ = az + dz * t;
  return Math.hypot(px - closestX, py - closestY, pz - closestZ);
}
