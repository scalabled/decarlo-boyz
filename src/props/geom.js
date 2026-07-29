import * as THREE from 'three';

/**
 * PROPS — geometry toolkit.
 *
 * Self-contained (ARCHITECTURE.md rule 2). Every primitive writes a 3-component
 * `color` attribute carrying the weathering masks the shared material shader
 * reads: (r) edge WEAR, (g) GRIME, (b) extra AO. A prop with no masks is a
 * clean extruded prism, which is the loudest tell that a street was generated
 * rather than built — a bin has to be dented and greasy in the creases, a sign
 * has to be rubbed back to bare metal on the arris.
 *
 * Everything here is BUILD-TIME only: nothing in this file runs per frame.
 */

const _q = new THREE.Quaternion();
const _e = new THREE.Euler();
const _p = new THREE.Vector3();
const _s = new THREE.Vector3();
const _nm = new THREE.Matrix3();
const _v = new THREE.Vector3();

export const TAU = Math.PI * 2;

// ------------------------------------------------------------------ noise --

export function hash2i(x, y) {
  let h = Math.imul(x | 0, 0x27d4eb2d) ^ Math.imul(y | 0, 0x9e3779b9);
  h = Math.imul(h ^ (h >>> 15), 0x2c1b3c6d);
  h = Math.imul(h ^ (h >>> 12), 0x297a2d39);
  return ((h ^ (h >>> 15)) >>> 0) / 4294967296;
}

/** Deterministic 0..1 from an integer triple — the per-instance jitter source. */
export function hash3i(a, b, c) {
  let h = Math.imul(a | 0, 0x27d4eb2d) ^ Math.imul(b | 0, 0x165667b1) ^ Math.imul(c | 0, 0x9e3779b9);
  h = Math.imul(h ^ (h >>> 15), 0x2c1b3c6d);
  h = Math.imul(h ^ (h >>> 13), 0x297a2d39);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

export function smoothNoise(x, y) {
  const xi = Math.floor(x);
  const yi = Math.floor(y);
  const xf = x - xi;
  const yf = y - yi;
  const u = xf * xf * (3 - 2 * xf);
  const v = yf * yf * (3 - 2 * yf);
  const l = (a, b, t) => a + (b - a) * t;
  return l(
    l(hash2i(xi, yi), hash2i(xi + 1, yi), u),
    l(hash2i(xi, yi + 1), hash2i(xi + 1, yi + 1), u),
    v
  );
}

export function clamp01(v) {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

export function lerp(a, b, t) {
  return a + (b - a) * t;
}

// -------------------------------------------------------------- transforms --

export function trs(out, x, y, z, ry = 0, sx = 1, sy = sx, sz = sx, rx = 0, rz = 0) {
  _e.set(rx, ry, rz, 'YXZ');
  _q.setFromEuler(_e);
  _p.set(x, y, z);
  _s.set(sx, sy, sz);
  return out.compose(_p, _q, _s);
}

export function newTrs(x, y, z, ry = 0, sx = 1, sy = sx, sz = sx, rx = 0, rz = 0) {
  return trs(new THREE.Matrix4(), x, y, z, ry, sx, sy, sz, rx, rz);
}

// ------------------------------------------------------------------ Accum --

/**
 * Merges transformed geometries into one indexed BufferGeometry.
 *
 * This is the reason a tile with eight hundred props comes out as a couple of
 * dozen draw calls: everything that is not worth an InstancedMesh lands here,
 * keyed by material.
 */
export class Accum {
  constructor(name = 'merged') {
    this.name = name;
    this.pos = [];
    this.nrm = [];
    this.uv = [];
    this.col = [];
    this.idx = [];
    this.verts = 0;
    this.tris = 0;
  }

  get empty() {
    return this.tris === 0;
  }

  /** Append `geo` transformed by `m`, optionally multiplying its masks. */
  add(geo, m = null, maskMul = null, maskAdd = null) {
    const pos = geo.getAttribute('position');
    if (!pos) return this;
    const nrm = geo.getAttribute('normal');
    const uv = geo.getAttribute('uv');
    const col = geo.getAttribute('color');
    const index = geo.getIndex();
    const base = this.verts;
    const n = pos.count;
    if (m) _nm.getNormalMatrix(m);

    for (let i = 0; i < n; i++) {
      _v.set(pos.getX(i), pos.getY(i), pos.getZ(i));
      if (m) _v.applyMatrix4(m);
      this.pos.push(_v.x, _v.y, _v.z);
      if (nrm) {
        _v.set(nrm.getX(i), nrm.getY(i), nrm.getZ(i));
        if (m) _v.applyMatrix3(_nm).normalize();
        this.nrm.push(_v.x, _v.y, _v.z);
      } else {
        this.nrm.push(0, 1, 0);
      }
      if (uv) this.uv.push(uv.getX(i), uv.getY(i));
      else this.uv.push(0, 0);
      let r = col ? col.getX(i) : 0;
      let g = col ? col.getY(i) : 0;
      let b = col ? col.getZ(i) : 0;
      if (maskMul) {
        r *= maskMul[0];
        g *= maskMul[1];
        b *= maskMul[2];
      }
      if (maskAdd) {
        r += maskAdd[0];
        g += maskAdd[1];
        b += maskAdd[2];
      }
      this.col.push(clamp01(r), clamp01(g), clamp01(b));
    }
    this.verts += n;

    if (index) {
      const a = index.array;
      for (let i = 0; i < a.length; i++) this.idx.push(base + a[i]);
      this.tris += a.length / 3;
    } else {
      for (let i = 0; i < n; i++) this.idx.push(base + i);
      this.tris += n / 3;
    }
    return this;
  }

  /** Raw vertex push, for generators that build their own strips (wires). */
  vert(x, y, z, nx, ny, nz, u, v, mr = 0, mg = 0, mb = 0) {
    this.pos.push(x, y, z);
    this.nrm.push(nx, ny, nz);
    this.uv.push(u, v);
    this.col.push(mr, mg, mb);
    return this.verts++;
  }

  tri(a, b, c) {
    this.idx.push(a, b, c);
    this.tris++;
    return this;
  }

  quad(a, b, c, d) {
    this.idx.push(a, b, c, a, c, d);
    this.tris += 2;
    return this;
  }

  build() {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(this.nrm, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(this.uv, 2));
    g.setAttribute('color', new THREE.Float32BufferAttribute(this.col, 3));
    g.setIndex(this.verts > 65535
      ? new THREE.Uint32BufferAttribute(this.idx, 1)
      : new THREE.Uint16BufferAttribute(this.idx, 1));
    g.computeBoundingSphere();
    g.name = this.name;
    return g;
  }
}

// -------------------------------------------------------------- primitives --

/**
 * Paint the three masks onto a geometry from a callback of the local position
 * and normal. This is where a prop stops being clean: grime pools low and on
 * upward faces, wear rides the outer corners.
 */
export function paint(geo, fn) {
  const pos = geo.getAttribute('position');
  const nrm = geo.getAttribute('normal');
  const n = pos.count;
  const arr = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    const o = fn(
      pos.getX(i), pos.getY(i), pos.getZ(i),
      nrm ? nrm.getX(i) : 0, nrm ? nrm.getY(i) : 1, nrm ? nrm.getZ(i) : 0,
      i
    );
    arr[i * 3] = clamp01(o[0]);
    arr[i * 3 + 1] = clamp01(o[1]);
    arr[i * 3 + 2] = clamp01(o[2]);
  }
  geo.setAttribute('color', new THREE.BufferAttribute(arr, 3));
  return geo;
}

/**
 * The default street-furniture weathering: grime rises from the ground (dogs,
 * road spray, gutter splash), wear sits on outward-facing verticals at hand
 * height, undersides collect both.
 */
export function weather(geo, opts = {}) {
  const {
    grimeBase = 0.55, grimeHeight = 1.1, wear = 0.42, ao = 0.2,
    up = 0.25, down = 0.5, seed = 1, noise = 0.35, wearY = [0.5, 2.2],
  } = opts;
  return paint(geo, (x, y, z, nx, ny, nz) => {
    const nz2 = smoothNoise(x * 3.1 + seed * 7.7, z * 3.1 - y * 2.3 + seed * 3.1);
    const low = clamp01(1 - y / grimeHeight);
    let g = grimeBase * (0.35 + 0.85 * low * low) + noise * (nz2 - 0.5);
    if (ny > 0.5) g += up * ny;
    if (ny < -0.3) g += down * -ny;
    const hFade = clamp01((y - wearY[0]) / 0.4) * clamp01((wearY[1] - y) / 0.6);
    const outward = Math.sqrt(nx * nx + nz * nz);
    const w = wear * (0.35 + 0.65 * hFade) * (0.3 + 0.7 * outward) * (0.6 + 0.8 * nz2);
    return [w, g, ao * (0.4 + 0.9 * low) + (ny < -0.3 ? 0.2 : 0)];
  });
}

/** Box with its base at y=0, centred in x/z. Optional per-face UV scale. */
export function box(w, h, d, opts = {}) {
  const g = new THREE.BoxGeometry(w, h, d, opts.wSeg ?? 1, opts.hSeg ?? 1, opts.dSeg ?? 1);
  g.translate(0, (opts.centred ? 0 : h / 2) + (opts.y ?? 0), 0);
  return g;
}

/**
 * A box with chamfered arrises. Nothing on a street has a perfectly sharp
 * corner and a 6 mm chamfer is what catches the sodium highlight.
 */
export function chamferBox(w, h, d, c = 0.02, opts = {}) {
  const parts = [];
  const inner = new THREE.BoxGeometry(w - 2 * c, h, d - 2 * c);
  parts.push(inner);
  const x2 = new THREE.BoxGeometry(w, h - 2 * c, d - 2 * c);
  parts.push(x2);
  const z2 = new THREE.BoxGeometry(w - 2 * c, h - 2 * c, d);
  parts.push(z2);
  const a = new Accum('chamfer');
  const m = new THREE.Matrix4();
  for (const p of parts) {
    a.add(p, m);
    p.dispose();
  }
  const g = a.build();
  g.translate(0, (opts.centred ? 0 : h / 2) + (opts.y ?? 0), 0);
  g.computeVertexNormals();
  return g;
}

/** Cylinder with its base at y=0. */
export function cyl(rTop, rBot, h, radial = 8, opts = {}) {
  const g = new THREE.CylinderGeometry(rTop, rBot, h, radial, opts.hSeg ?? 1, !!opts.open);
  g.translate(0, (opts.centred ? 0 : h / 2) + (opts.y ?? 0), 0);
  return g;
}

/** A flat card in the XY plane facing +Z, base at y=0 unless centred. */
export function card(w, h, opts = {}) {
  const g = new THREE.PlaneGeometry(w, h, opts.wSeg ?? 1, opts.hSeg ?? 1);
  if (!opts.centred) g.translate(0, h / 2, 0);
  if (opts.y) g.translate(0, opts.y, 0);
  return g;
}

/** A horizontal card lying in XZ facing +Y — decals, puddles, grates. */
export function ground(w, d, opts = {}) {
  const g = new THREE.PlaneGeometry(w, d, opts.wSeg ?? 1, opts.dSeg ?? 1);
  g.rotateX(-Math.PI / 2);
  if (opts.y) g.translate(0, opts.y, 0);
  return g;
}

/**
 * A swept tube through a polyline. Used for wires, handrails, standpipes and
 * scaffold tubes. `radial` of 3 is enough for an 18 mm wire at street distance
 * and is a third of the triangles.
 */
export function tube(pts, radius, radial = 4, opts = {}) {
  const a = new Accum('tube');
  const n = pts.length;
  if (n < 2) return a.build();
  const up = new THREE.Vector3(0, 1, 0);
  const dir = new THREE.Vector3();
  const side = new THREE.Vector3();
  const nrm = new THREE.Vector3();
  const taper = opts.taper ?? 1;
  const rings = [];
  for (let i = 0; i < n; i++) {
    const p = pts[i];
    const p0 = pts[Math.max(0, i - 1)];
    const p1 = pts[Math.min(n - 1, i + 1)];
    dir.set(p1.x - p0.x, p1.y - p0.y, p1.z - p0.z);
    if (dir.lengthSq() < 1e-9) dir.set(0, 1, 0);
    dir.normalize();
    side.crossVectors(dir, up);
    if (side.lengthSq() < 1e-6) side.set(1, 0, 0);
    side.normalize();
    nrm.crossVectors(side, dir).normalize();
    const r = radius * lerp(1, taper, i / (n - 1));
    const ring = [];
    for (let k = 0; k < radial; k++) {
      const th = (k / radial) * TAU;
      const cx = Math.cos(th);
      const sy = Math.sin(th);
      const nx = side.x * cx + nrm.x * sy;
      const ny = side.y * cx + nrm.y * sy;
      const nz = side.z * cx + nrm.z * sy;
      ring.push(
        a.vert(p.x + nx * r, p.y + ny * r, p.z + nz * r, nx, ny, nz,
          k / radial, i / (n - 1), opts.mr ?? 0, opts.mg ?? 0.35, opts.mb ?? 0)
      );
    }
    rings.push(ring);
    if (i > 0) {
      const prev = rings[i - 1];
      for (let k = 0; k < radial; k++) {
        const k2 = (k + 1) % radial;
        a.quad(prev[k], ring[k], ring[k2], prev[k2]);
      }
    }
  }
  return a.build();
}

/**
 * A catenary between two points. `sagFactor` is sag as a fraction of span; a
 * real distribution line hangs about 2-4 % of its span, a trolley feeder less,
 * an abandoned telephone drop a great deal more.
 */
export function catenary(ax, ay, az, bx, by, bz, sag, segs = 10, out = []) {
  out.length = 0;
  for (let i = 0; i <= segs; i++) {
    const t = i / segs;
    const x = lerp(ax, bx, t);
    const z = lerp(az, bz, t);
    const y = lerp(ay, by, t);
    // cosh-shaped droop, normalised to 0 at the ends and `sag` at mid-span
    const u = t * 2 - 1;
    const droop = (Math.cosh(u * 1.6) - Math.cosh(1.6)) / (1 - Math.cosh(1.6));
    out.push({ x, y: y - sag * droop, z });
  }
  return out;
}

/** A lathe profile: [[r, y], …] revolved. Bollards, hydrants, fountains. */
export function lathe(profile, radial = 10, opts = {}) {
  const pts = profile.map(([r, y]) => new THREE.Vector2(Math.max(1e-4, r), y));
  const g = new THREE.LatheGeometry(pts, radial, opts.phiStart ?? 0, opts.phiLength ?? TAU);
  g.computeVertexNormals();
  return g;
}

/**
 * Extrude a closed 2D outline (XZ) up by `h`, with a flat cap. Used for skips,
 * planters, awning valances and anything with a non-rectangular plan.
 */
export function extrude(outline, h, opts = {}) {
  const a = new Accum('extrude');
  const n = outline.length;
  const topScale = opts.topScale ?? 1;
  const bot = [];
  const top = [];
  for (let i = 0; i < n; i++) {
    const [x, z] = outline[i];
    const [px, pz] = outline[(i - 1 + n) % n];
    const [nx2, nz2] = outline[(i + 1) % n];
    let ex = nx2 - px;
    let ez = nz2 - pz;
    const l = Math.hypot(ex, ez) || 1;
    ex /= l;
    ez /= l;
    const nx = ez;
    const nz = -ex;
    bot.push(a.vert(x, 0, z, nx, 0, nz, i / n, 0, 0, 0.6, 0.25));
    top.push(a.vert(x * topScale, h, z * topScale, nx, 0, nz, i / n, 1, 0.4, 0.15, 0));
  }
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    a.quad(bot[i], top[i], top[j], bot[j]);
  }
  if (opts.cap !== false) {
    const c = a.vert(0, h, 0, 0, 1, 0, 0.5, 0.5, 0.1, 0.4, 0);
    const ring = [];
    for (let i = 0; i < n; i++) {
      const [x, z] = outline[i];
      ring.push(a.vert(x * topScale, h, z * topScale, 0, 1, 0, x, z, 0.2, 0.3, 0));
    }
    for (let i = 0; i < n; i++) a.tri(c, ring[(i + 1) % n], ring[i]);
  }
  if (opts.floor) {
    const c = a.vert(0, opts.floorY ?? h * 0.12, 0, 0, 1, 0, 0.5, 0.5, 0, 0.85, 0.5);
    const ring = [];
    for (let i = 0; i < n; i++) {
      const [x, z] = outline[i];
      const s = lerp(1, topScale, (opts.floorY ?? h * 0.12) / h) * 0.97;
      ring.push(a.vert(x * s, opts.floorY ?? h * 0.12, z * s, 0, 1, 0, x, z, 0, 0.9, 0.4));
    }
    for (let i = 0; i < n; i++) a.tri(c, ring[(i + 1) % n], ring[i]);
  }
  return a.build();
}

/** Regular n-gon outline of radius r, optionally squashed and rotated. */
export function ngon(n, r, opts = {}) {
  const out = [];
  const sx = opts.sx ?? 1;
  const sz = opts.sz ?? 1;
  const rot = opts.rot ?? 0;
  const wob = opts.wob ?? 0;
  const seed = opts.seed ?? 0;
  for (let i = 0; i < n; i++) {
    const th = rot + (i / n) * TAU;
    const rr = r * (1 + wob * (hash3i(seed, i, 7) - 0.5));
    out.push([Math.cos(th) * rr * sx, Math.sin(th) * rr * sz]);
  }
  return out;
}

/** Dent a geometry: push vertices in along the normal in a few soft craters. */
export function dent(geo, craters, depth = 0.03) {
  const pos = geo.getAttribute('position');
  const nrm = geo.getAttribute('normal');
  if (!nrm) geo.computeVertexNormals();
  const n2 = geo.getAttribute('normal');
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i);
    const y = pos.getY(i);
    const z = pos.getZ(i);
    let d = 0;
    for (const c of craters) {
      const dd = Math.hypot(x - c[0], y - c[1], z - c[2]);
      d += Math.max(0, 1 - dd / c[3]) ** 2 * (c[4] ?? 1);
    }
    if (d <= 0) continue;
    const k = Math.min(1.6, d) * depth;
    pos.setXYZ(i, x - n2.getX(i) * k, y - n2.getY(i) * k, z - n2.getZ(i) * k);
  }
  pos.needsUpdate = true;
  geo.computeVertexNormals();
  return geo;
}

/** Bend a geometry about the X axis, pivoting at y=`from` — a leaning sign. */
export function bendY(geo, from, amount) {
  const pos = geo.getAttribute('position');
  for (let i = 0; i < pos.count; i++) {
    const y = pos.getY(i);
    if (y <= from) continue;
    const t = (y - from);
    const k = amount * t * t;
    pos.setX(i, pos.getX(i) + k);
  }
  pos.needsUpdate = true;
  geo.computeVertexNormals();
  return geo;
}

/** Merge a list of [geo, matrix?] into one and dispose the sources. */
export function combine(list, name = 'part') {
  const a = new Accum(name);
  for (const item of list) {
    if (!item) continue;
    const g = Array.isArray(item) ? item[0] : item;
    const m = Array.isArray(item) ? item[1] : null;
    const mul = Array.isArray(item) ? item[2] : null;
    const add = Array.isArray(item) ? item[3] : null;
    if (!g) continue;
    a.add(g, m, mul, add);
    g.dispose();
  }
  return a.build();
}

export { THREE };
