import * as THREE from 'three';

/**
 * BUILDINGS — geometry toolkit.
 *
 * Self-contained (ARCHITECTURE.md rule 2: no cross-subsystem imports). Every
 * primitive here writes a `color` attribute carrying the three weathering masks
 * the shared material shader reads: (r) edge WEAR, (g) GRIME, (b) extra AO.
 * A box with no masks reads as a clean extruded prism, which is the single
 * loudest tell that a facade was generated rather than built.
 */

const _v0 = new THREE.Vector3();
const _v1 = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _n = new THREE.Vector3();
const _nm = new THREE.Matrix3();
const _q = new THREE.Quaternion();
const _e = new THREE.Euler();
const _s = new THREE.Vector3();
const _p = new THREE.Vector3();

// ------------------------------------------------------------------ noise --
export function hash3(x, y, z) {
  let h = Math.imul(x | 0, 0x27d4eb2d) ^ Math.imul(y | 0, 0x165667b1) ^ Math.imul(z | 0, 0x9e3779b9);
  h = Math.imul(h ^ (h >>> 15), 0x2c1b3c6d);
  h = Math.imul(h ^ (h >>> 12), 0x297a2d39);
  return ((h ^ (h >>> 15)) >>> 0) / 4294967296;
}

export function noise3(x, y, z) {
  const xi = Math.floor(x);
  const yi = Math.floor(y);
  const zi = Math.floor(z);
  const xf = x - xi;
  const yf = y - yi;
  const zf = z - zi;
  const u = xf * xf * (3 - 2 * xf);
  const v = yf * yf * (3 - 2 * yf);
  const w = zf * zf * (3 - 2 * zf);
  const l = (a, b, t) => a + (b - a) * t;
  const c = (i, j, k) => hash3(xi + i, yi + j, zi + k);
  return l(
    l(l(c(0, 0, 0), c(1, 0, 0), u), l(c(0, 1, 0), c(1, 1, 0), u), v),
    l(l(c(0, 0, 1), c(1, 0, 1), u), l(c(0, 1, 1), c(1, 1, 1), u), v),
    w
  );
}

export function fbm3(x, y, z, oct = 3) {
  let a = 0.5;
  let f = 1;
  let s = 0;
  let n = 0;
  for (let i = 0; i < oct; i++) {
    s += a * noise3(x * f, y * f, z * f);
    n += a;
    a *= 0.5;
    f *= 2.03;
  }
  return s / n;
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

// ------------------------------------------------------------------ merge --
/** Merges transformed geometries into one indexed BufferGeometry. */
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

  /** opts: { masks:[w,g,ao], paint(x,y,z,nx,ny,nz,out), addMasks } */
  add(geo, matrix = null, opts = null) {
    const pa = geo.getAttribute('position');
    if (!pa) return this;
    let na = geo.getAttribute('normal');
    if (!na) {
      geo.computeVertexNormals();
      na = geo.getAttribute('normal');
    }
    const ua = geo.getAttribute('uv');
    const ca = geo.getAttribute('color');
    const index = geo.getIndex();
    const base = this.verts;
    const masks = opts?.masks ?? null;
    const paint = opts?.paint ?? null;
    const out = paint ? [0, 0, 0] : null;
    if (matrix) _nm.getNormalMatrix(matrix);

    for (let i = 0; i < pa.count; i++) {
      _v0.fromBufferAttribute(pa, i);
      if (matrix) _v0.applyMatrix4(matrix);
      _n.fromBufferAttribute(na, i);
      if (matrix) _n.applyMatrix3(_nm).normalize();
      this.pos.push(_v0.x, _v0.y, _v0.z);
      this.nrm.push(_n.x, _n.y, _n.z);
      this.uv.push(ua ? ua.getX(i) : 0, ua ? ua.getY(i) : 0);

      let r = ca ? ca.getX(i) : 0;
      let g = ca ? ca.getY(i) : 0;
      let b = ca ? ca.getZ(i) : 0;
      if (masks) {
        r = Math.min(1, Math.max(r, masks[0]));
        g = Math.min(1, Math.max(g, masks[1]));
        b = Math.min(1, Math.max(b, masks[2]));
      }
      if (paint) {
        out[0] = r;
        out[1] = g;
        out[2] = b;
        paint(_v0.x, _v0.y, _v0.z, _n.x, _n.y, _n.z, out);
        r = out[0];
        g = out[1];
        b = out[2];
      }
      this.col.push(r, g, b);
      this.verts++;
    }

    if (index) {
      const a = index.array;
      for (let i = 0; i < a.length; i++) this.idx.push(base + a[i]);
      this.tris += a.length / 3;
    } else {
      for (let i = 0; i < pa.count; i++) this.idx.push(base + i);
      this.tris += pa.count / 3;
    }
    return this;
  }

  build() {
    const g = new THREE.BufferGeometry();
    g.name = this.name;
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(this.nrm, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(this.uv, 2));
    g.setAttribute('color', new THREE.Float32BufferAttribute(this.col, 3));
    g.setIndex(
      this.verts > 65535
        ? new THREE.Uint32BufferAttribute(this.idx, 1)
        : new THREE.Uint16BufferAttribute(this.idx, 1)
    );
    g.computeBoundingSphere();
    g.computeBoundingBox();
    this.pos = this.nrm = this.uv = this.col = this.idx = null;
    return g;
  }
}

// ------------------------------------------------------------------ masks --
export function paintMasks(geo, fn) {
  const pa = geo.getAttribute('position');
  let na = geo.getAttribute('normal');
  if (!na) {
    geo.computeVertexNormals();
    na = geo.getAttribute('normal');
  }
  let ca = geo.getAttribute('color');
  if (!ca) {
    ca = new THREE.Float32BufferAttribute(new Float32Array(pa.count * 3), 3);
    geo.setAttribute('color', ca);
  }
  const out = [0, 0, 0];
  for (let i = 0; i < pa.count; i++) {
    out[0] = ca.getX(i);
    out[1] = ca.getY(i);
    out[2] = ca.getZ(i);
    fn(pa.getX(i), pa.getY(i), pa.getZ(i), na.getX(i), na.getY(i), na.getZ(i), out, i);
    ca.setXYZ(i, out[0], out[1], out[2]);
  }
  ca.needsUpdate = true;
  return geo;
}

export function fillMasks(geo, w = 0, g = 0, a = 0) {
  const pa = geo.getAttribute('position');
  const arr = new Float32Array(pa.count * 3);
  for (let i = 0; i < pa.count; i++) {
    arr[i * 3] = w;
    arr[i * 3 + 1] = g;
    arr[i * 3 + 2] = a;
  }
  geo.setAttribute('color', new THREE.Float32BufferAttribute(arr, 3));
  return geo;
}

/**
 * Wear on chamfers, grime under overhangs, AO+splash toward the base. Applied
 * to nearly every detail piece so nothing reads as a clean extruded box.
 */
export function weather(geo, opts = {}) {
  const { wear = 0.8, grime = 0.45, down = 0.7, base = 0.0, seed = 0 } = opts;
  geo.computeBoundingBox();
  const bb = geo.boundingBox;
  const lo = bb.min.y;
  const span = Math.max(0.001, bb.max.y - lo);
  return paintMasks(geo, (x, y, z, nx, ny, nz, out) => {
    const t = 1 - (y - lo) / span; // 1 at the bottom
    const dn = Math.max(0, -ny);
    const up = Math.max(0, ny);
    const n = fbm3(x * 3.1 + seed, y * 3.3, z * 3.1, 2);
    out[0] = Math.min(1, out[0] * wear + up * 0.16 * wear * n);
    out[1] = Math.min(1, out[1] + grime * (dn * down + t * t * base) * (0.5 + 0.9 * n));
    out[2] = Math.min(1, out[2] + dn * 0.32 + t * t * base * 0.6);
  });
}

// ------------------------------------------------------------- primitives --
/**
 * A chamfered unit box. Real edges catch a specular highlight and give the
 * masks somewhere to put edge wear; a stock BoxGeometry cannot. 44 triangles.
 */
export function chamferBox(sx = 1, sy = 1, sz = 1, bevel = 0.012) {
  const h = [sx * 0.5, sy * 0.5, sz * 0.5];
  const b = Math.max(0.0004, Math.min(bevel, Math.min(sx, sy, sz) * 0.42));
  const signs = [];
  for (let i = 0; i < 8; i++) signs.push([i & 1 ? 1 : -1, i & 2 ? 1 : -1, i & 4 ? 1 : -1]);
  const vert = (ci, axis) => {
    const s = signs[ci];
    return [
      s[0] * (axis === 0 ? h[0] : h[0] - b),
      s[1] * (axis === 1 ? h[1] : h[1] - b),
      s[2] * (axis === 2 ? h[2] : h[2] - b),
    ];
  };

  const pos = [];
  const nrm = [];
  const uv = [];
  const col = [];

  const addPoly = (pts, wear) => {
    let cx = 0;
    let cy = 0;
    let cz = 0;
    for (const p of pts) {
      cx += p[0];
      cy += p[1];
      cz += p[2];
    }
    cx /= pts.length;
    cy /= pts.length;
    cz /= pts.length;
    _v0.set(pts[0][0], pts[0][1], pts[0][2]);
    _v1.set(pts[1][0], pts[1][1], pts[1][2]);
    _v2.set(pts[2][0], pts[2][1], pts[2][2]);
    _n.copy(_v1).sub(_v0).cross(_v2.clone().sub(_v0));
    if (_n.x * cx + _n.y * cy + _n.z * cz < 0) pts = pts.slice().reverse();
    _v0.set(pts[0][0], pts[0][1], pts[0][2]);
    _v1.set(pts[1][0], pts[1][1], pts[1][2]);
    _v2.set(pts[2][0], pts[2][1], pts[2][2]);
    _n.copy(_v1).sub(_v0).cross(_v2.clone().sub(_v0)).normalize();
    for (let t = 1; t < pts.length - 1; t++) {
      for (const p of [pts[0], pts[t], pts[t + 1]]) {
        pos.push(p[0], p[1], p[2]);
        nrm.push(_n.x, _n.y, _n.z);
        const ax =
          Math.abs(_n.x) > Math.abs(_n.y)
            ? Math.abs(_n.x) > Math.abs(_n.z)
              ? 0
              : 2
            : Math.abs(_n.y) > Math.abs(_n.z)
              ? 1
              : 2;
        uv.push(ax === 0 ? p[2] : p[0], ax === 1 ? p[2] : p[1]);
        col.push(wear, _n.y < -0.5 ? 0.4 : 0, _n.y < -0.4 ? 0.3 : 0);
      }
    }
  };

  for (let axis = 0; axis < 3; axis++) {
    for (const sa of [-1, 1]) {
      const corners = [];
      for (let ci = 0; ci < 8; ci++) if (signs[ci][axis] === sa) corners.push(ci);
      const a1 = (axis + 1) % 3;
      const a2 = (axis + 2) % 3;
      corners.sort(
        (p, q) =>
          Math.atan2(signs[p][a2], signs[p][a1]) - Math.atan2(signs[q][a2], signs[q][a1])
      );
      addPoly(
        corners.map((ci) => vert(ci, axis)),
        0.05
      );
    }
  }
  for (let a = 0; a < 3; a++) {
    for (let bx = a + 1; bx < 3; bx++) {
      for (const sa of [-1, 1]) {
        for (const sb of [-1, 1]) {
          const cs = [];
          for (let ci = 0; ci < 8; ci++) if (signs[ci][a] === sa && signs[ci][bx] === sb) cs.push(ci);
          addPoly([vert(cs[0], a), vert(cs[0], bx), vert(cs[1], bx), vert(cs[1], a)], 1.0);
        }
      }
    }
  }
  for (let ci = 0; ci < 8; ci++) addPoly([vert(ci, 0), vert(ci, 1), vert(ci, 2)], 1.0);

  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(nrm, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  g.computeBoundingBox();
  g.computeBoundingSphere();
  return g;
}

/** 12 triangles. For members where a chamfer would be sub-pixel. */
export function plainBox(sx = 1, sy = 1, sz = 1) {
  const g = new THREE.BoxGeometry(sx, sy, sz);
  const pa = g.getAttribute('position');
  g.setAttribute('color', new THREE.Float32BufferAttribute(new Float32Array(pa.count * 3), 3));
  g.computeBoundingBox();
  g.computeBoundingSphere();
  return g;
}

/** A quad in the XY plane facing +Z. */
export function quad(w = 1, h = 1, wseg = 1, hseg = 1) {
  const g = new THREE.PlaneGeometry(w, h, wseg, hseg);
  const pa = g.getAttribute('position');
  g.setAttribute('color', new THREE.Float32BufferAttribute(new Float32Array(pa.count * 3), 3));
  return g;
}

export function cylinderY(r, h, seg = 12, opts = {}) {
  const g = new THREE.CylinderGeometry(opts.rTop ?? r, r, h, seg, 1, opts.open ?? false);
  const pa = g.getAttribute('position');
  g.setAttribute('color', new THREE.Float32BufferAttribute(new Float32Array(pa.count * 3), 3));
  return g;
}

/** Simple polygon (CCW, [x,z] pairs) extruded up +Y from 0 to `height`. */
export function polyPrism(pts, height, opts = {}) {
  const shape = new THREE.Shape();
  shape.moveTo(pts[0][0], -pts[0][1]);
  for (let i = 1; i < pts.length; i++) shape.lineTo(pts[i][0], -pts[i][1]);
  shape.closePath();
  const geo = new THREE.ExtrudeGeometry(shape, {
    depth: height,
    bevelEnabled: !!opts.bevel,
    bevelThickness: opts.bevel ?? 0,
    bevelSize: opts.bevel ?? 0,
    bevelSegments: 1,
    steps: 1,
  });
  geo.rotateX(-Math.PI / 2);
  geo.computeVertexNormals();
  const pa = geo.getAttribute('position');
  geo.setAttribute('color', new THREE.Float32BufferAttribute(new Float32Array(pa.count * 3), 3));
  geo.computeBoundingBox();
  return geo;
}

// ------------------------------------------------------------ wall panels --
/**
 * Rectangular opening spec: { x, y, w, h, arch?:0..1 }
 * x/y is the centre in panel space; the panel spans -w/2..w/2 in x and 0..h in y.
 */
function holePath(o) {
  const p = new THREE.Path();
  const x0 = o.x - o.w / 2;
  const x1 = o.x + o.w / 2;
  const y0 = o.y - o.h / 2;
  const y1 = o.y + o.h / 2;
  if (o.arch > 0) {
    const r = (o.w / 2) * o.arch;
    const yA = y1 - r;
    p.moveTo(x0, y0);
    p.lineTo(x1, y0);
    p.lineTo(x1, yA);
    p.quadraticCurveTo(x1, y1, o.x, y1);
    p.quadraticCurveTo(x0, y1, x0, yA);
    p.lineTo(x0, y0);
  } else {
    p.moveTo(x0, y0);
    p.lineTo(x1, y0);
    p.lineTo(x1, y1);
    p.lineTo(x0, y1);
  }
  p.closePath();
  return p;
}

/**
 * A facade wall: a slab of real thickness with real holes, extruded so every
 * opening has a reveal with depth and a chamfered arris. This is the piece the
 * whole facade system stands on — a window cut into 350 mm of masonry has a
 * shadow line down one jamb at every hour of the day, and a window painted onto
 * a flat box never will.
 *
 * Panel space: x centred, y from 0 up, z from 0 (inside) to t (outside face).
 */
export function wallPanel(w, h, t, holes = [], opts = {}) {
  const { bevel = 0.022, top = 'flat', jag = 0, seed = 0 } = opts;
  const shape = new THREE.Shape();
  const x0 = -w / 2;
  const x1 = w / 2;
  shape.moveTo(x0, 0);
  shape.lineTo(x1, 0);
  shape.lineTo(x1, h);
  if (jag > 0 && top === 'flat') {
    const steps = Math.max(3, Math.round(w / 1.4));
    for (let i = steps - 1; i >= 1; i--) {
      const x = x0 + (i / steps) * w;
      shape.lineTo(x, h + (fbm3(x * 1.7 + seed, 5.5, 1.3, 2) - 0.5) * jag);
    }
  }
  shape.lineTo(x0, h);
  shape.lineTo(x0, 0);
  for (const o of holes) shape.holes.push(holePath(o));

  const geo = new THREE.ExtrudeGeometry(shape, {
    depth: Math.max(0.02, t - bevel * 2),
    bevelEnabled: bevel > 0,
    bevelThickness: bevel,
    bevelSize: bevel,
    bevelOffset: 0,
    bevelSegments: 1,
    curveSegments: opts.curveSegments ?? 5,
    steps: 1,
  });
  if (bevel > 0) geo.translate(0, 0, bevel);
  geo.computeVertexNormals();
  geo.computeBoundingBox();

  // Reveals (normals in the panel plane) collect crevice grime and AO; the
  // bottom two metres take the pavement splash.
  paintMasks(geo, (x, y, z, nx, ny, nz, out) => {
    const reveal = 1 - Math.abs(nz);
    const n = fbm3(x * 2.3 + seed, y * 2.1, z * 2.7, 2);
    const splash = Math.max(0, 1 - y / 2.2);
    out[0] = Math.min(1, reveal * 0.5 * (0.4 + n) + Math.max(0, ny) * 0.28);
    out[1] = Math.min(1, reveal * 0.4 * (0.5 + n) + Math.max(0, -ny) * 0.5 + splash * splash * 0.35);
    out[2] = Math.min(1, reveal * 0.36 + Math.max(0, -ny) * 0.38 + splash * splash * 0.3);
  });
  return geo;
}

/**
 * The solid rectangles left once the holes are cut, in panel space. Collision
 * is authored from these so a doorway is a real gap in the hull rather than a
 * triangle-soup query against every chamfer.
 */
export function solidSlabs(w, h, holes) {
  const xs = new Set([-w / 2, w / 2]);
  for (const o of holes) {
    xs.add(Math.max(-w / 2, o.x - o.w / 2));
    xs.add(Math.min(w / 2, o.x + o.w / 2));
  }
  const cuts = [...xs].sort((a, b) => a - b);
  const out = [];
  for (let i = 0; i < cuts.length - 1; i++) {
    const bx0 = cuts[i];
    const bx1 = cuts[i + 1];
    if (bx1 - bx0 < 1e-4) continue;
    const mid = (bx0 + bx1) / 2;
    const spans = holes
      .filter((o) => mid > o.x - o.w / 2 && mid < o.x + o.w / 2)
      .map((o) => [Math.max(0, o.y - o.h / 2), Math.min(h, o.y + o.h / 2)])
      .sort((a, b) => a[0] - b[0]);
    let y = 0;
    for (const [s0, s1] of spans) {
      if (s0 > y) out.push({ x: mid, y: (y + s0) / 2, w: bx1 - bx0, h: s0 - y });
      y = Math.max(y, s1);
    }
    if (y < h) out.push({ x: mid, y: (y + h) / 2, w: bx1 - bx0, h: h - y });
  }
  return out;
}

/**
 * A rain-runoff stain, as geometry.
 *
 * Every sill, ledge, cornice and AC unit sheds water, and the 0.6-2 m dark run
 * below it is the loudest signal that a building has stood outside for thirty
 * years. It cannot come from the wall's own vertex masks — an extruded panel
 * only has vertices on its outline and hole rims, so there is nowhere to put a
 * mask halfway down an elevation. So: a separate strip in the SAME material
 * batch, a centimetre proud, whose grime mask feathers to zero at every edge.
 * Same texture, same lighting; only the grime term differs, so it reads as a
 * stain in the render rather than a decal stuck on top of one.
 *
 * Authored in XY: x centred on the source, y running DOWN from 0 to -len.
 */
export function runoffStreak(rng, width, len, opts = {}) {
  const { amount = 0.9, cols = 3, rows = 5, wander = 0.35 } = opts;
  const seed = rng ? rng.float() * 40 : 0;
  const pos = [];
  const nrm = [];
  const uv = [];
  const col = [];
  const idx = [];
  for (let j = 0; j <= rows; j++) {
    const v = j / rows;
    const drift = (fbm3(seed + v * 2.3, 4.1, 1.7, 2) - 0.5) * wander * width * v;
    const wj = width * (1 - v * 0.4) * (0.85 + 0.3 * fbm3(seed + 9, v * 3.1, 2.2, 2));
    for (let i = 0; i <= cols; i++) {
      const u = i / cols;
      pos.push((u - 0.5) * wj + drift, -v * len, 0);
      nrm.push(0, 0, 1);
      uv.push(u, v);
      const side = Math.sin(Math.PI * u) ** 0.8;
      const head = Math.min(1, v / 0.1);
      const tail = 1 - v * v;
      const broken = 0.55 + 0.75 * fbm3(seed + u * 4.3, v * 5.7, 3.3, 2);
      const g = Math.min(1, amount * side * head * tail * broken);
      col.push(0, g, g * 0.45);
    }
  }
  const row = cols + 1;
  for (let j = 0; j < rows; j++) {
    for (let i = 0; i < cols; i++) {
      const a = j * row + i;
      idx.push(a, a + row, a + 1, a + 1, a + row, a + row + 1);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(nrm, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  g.setIndex(idx);
  g.computeBoundingBox();
  g.computeBoundingSphere();
  return g;
}

/**
 * A moulding run: an extruded profile swept along +X. `profile` is a list of
 * [z, y] pairs in the section plane (z out from the wall, y up), authored
 * counter-clockwise. Cornices, string courses, sills, copings and plinths all
 * come from here, which is what stops a facade being a stack of rectangles.
 */
export function moulding(length, profile, opts = {}) {
  const shape = new THREE.Shape();
  shape.moveTo(profile[0][0], profile[0][1]);
  for (let i = 1; i < profile.length; i++) shape.lineTo(profile[i][0], profile[i][1]);
  shape.closePath();
  // Bevel OFF by default. A moulding's shadow line comes from its profile, not
  // from a 6 mm arris, and turning the bevel on triples the triangle count of
  // the single most-repeated piece of geometry in the city.
  const geo = new THREE.ExtrudeGeometry(shape, {
    depth: length,
    bevelEnabled: (opts.bevel ?? 0) > 0,
    bevelThickness: opts.bevel ?? 0,
    bevelSize: opts.bevel ?? 0,
    bevelSegments: 1,
    steps: 1,
  });
  // Section authored in ZY, swept along +Z -> rotate so the sweep runs along X
  // while the profile's +z still points OUT of the wall.
  geo.rotateY(-Math.PI / 2);
  geo.translate(length / 2, 0, 0);
  geo.computeVertexNormals();
  const pa = geo.getAttribute('position');
  geo.setAttribute('color', new THREE.Float32BufferAttribute(new Float32Array(pa.count * 3), 3));
  geo.computeBoundingBox();
  return weather(geo, { wear: 0.75, grime: 0.55, down: 0.9 });
}

// ---------------------------------------------------------------- polygon --
export function polyArea(pts) {
  let a = 0;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    a += pts[j][0] * pts[i][1] - pts[i][0] * pts[j][1];
  }
  return a * 0.5;
}

export function polyCentroid(pts, out = [0, 0]) {
  let cx = 0;
  let cy = 0;
  for (const p of pts) {
    cx += p[0];
    cy += p[1];
  }
  out[0] = cx / pts.length;
  out[1] = cy / pts.length;
  return out;
}

/** Inset (d > 0) or outset (d < 0) a convex-ish polygon about its centroid. */
export function polyInset(pts, d) {
  const c = polyCentroid(pts);
  const out = [];
  for (const p of pts) {
    const dx = p[0] - c[0];
    const dy = p[1] - c[1];
    const len = Math.hypot(dx, dy) || 1;
    const k = Math.max(0.12, (len - d) / len);
    out.push([c[0] + dx * k, c[1] + dy * k]);
  }
  return out;
}

/** Axis-aligned bounds of a [x,z] polygon. */
export function polyBounds(pts) {
  let x0 = Infinity;
  let x1 = -Infinity;
  let z0 = Infinity;
  let z1 = -Infinity;
  for (const p of pts) {
    if (p[0] < x0) x0 = p[0];
    if (p[0] > x1) x1 = p[0];
    if (p[1] < z0) z0 = p[1];
    if (p[1] > z1) z1 = p[1];
  }
  return { x0, x1, z0, z1, w: x1 - x0, d: z1 - z0, cx: (x0 + x1) / 2, cz: (z0 + z1) / 2 };
}

/**
 * Sutherland-Hodgman clip of an [x,z] polygon to the half-plane
 * `nx*x + nz*z >= d`. Returns a NEW array; may be empty.
 *
 * This is how a building is kept out of the road. `world` subdivides a block
 * into lots without subtracting the carriageway, so three quarters of the lots
 * it hands us have at least one corner inside a running lane (measured: 365 of
 * 482, worst 14.3 m past the kerb line — i.e. on the centreline of a six-lane
 * highway). Nudging individual vertices distorts the plan and leaves the
 * frontage crooked; clipping to the kerb line keeps the polygon straight, keeps
 * the frontage parallel to the street it faces, and is exactly the operation a
 * surveyor performs.
 */
export function clipHalfPlane(pts, nx, nz, d) {
  const out = [];
  const n = pts.length;
  // Identity when nothing is outside — the caller iterates to a fixed point and
  // uses `result === input` as the "this pass changed nothing" test.
  let outside = false;
  for (let i = 0; i < n; i++) {
    if (nx * pts[i][0] + nz * pts[i][1] - d < -1e-6) {
      outside = true;
      break;
    }
  }
  if (!outside) return pts;
  for (let i = 0; i < n; i++) {
    const A = pts[i];
    const B = pts[(i + 1) % n];
    const da = nx * A[0] + nz * A[1] - d;
    const db = nx * B[0] + nz * B[1] - d;
    if (da >= 0) out.push(A);
    if (da >= 0 !== db >= 0) {
      const t = da / (da - db);
      out.push([A[0] + (B[0] - A[0]) * t, A[1] + (B[1] - A[1]) * t]);
    }
  }
  // Drop the degenerate vertices the clip introduces where an edge grazes the
  // plane; a 2 cm sliver edge becomes a wall panel that costs a full extrusion
  // and covers nothing.
  const clean = [];
  for (const p of out) {
    const q = clean[clean.length - 1];
    if (q && Math.hypot(p[0] - q[0], p[1] - q[1]) < 0.25) continue;
    clean.push(p);
  }
  if (clean.length > 2) {
    const a = clean[0];
    const z = clean[clean.length - 1];
    if (Math.hypot(a[0] - z[0], a[1] - z[1]) < 0.25) clean.pop();
  }
  return clean;
}

export function disposeAll(list) {
  for (const g of list) g?.dispose?.();
}
