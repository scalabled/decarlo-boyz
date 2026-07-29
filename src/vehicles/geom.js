/**
 * Geometry toolkit for procedural car bodies.
 *
 * The core idea: a car body is not a box with bits stuck on it, it is a LOFTED
 * SURFACE. `BodySurface` holds a handful of cross-sections ("stations") along
 * the length of the car; each station is a list of control points describing
 * the half-section from the centre of the roof, out over the shoulder, down the
 * flank, under the sill and back to the centre of the floor. Between stations
 * everything is interpolated with a Catmull-Rom, so the bonnet crowns, the
 * shoulder runs the length of the car, and the roof tapers — the things that
 * make a shape read as a car rather than as a wedge.
 *
 * Control points may be flagged `hard`. A hard point is duplicated in the
 * lofted mesh, which stops normal averaging across it and produces a real
 * highlight break: that is the shoulder line, the character line down the door,
 * the edge of the bonnet. Without them a car reads as a bar of soap.
 *
 * Because the surface is evaluable at any (z, u), everything else can be
 * attached TO it rather than guessed at: shutlines are strips lying on the
 * surface, door handles and mirrors are placed on it with its normal, the
 * lights are recessed into it.
 */

import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';

/* ------------------------------------------------------------------ */
/* Curves                                                              */
/* ------------------------------------------------------------------ */

/** Uniform Catmull-Rom on a scalar. */
export function crom(p0, p1, p2, p3, t) {
  const t2 = t * t;
  const t3 = t2 * t;
  return (
    0.5 *
    (2 * p1 +
      (-p0 + p2) * t +
      (2 * p0 - 5 * p1 + 4 * p2 - p3) * t2 +
      (-p0 + 3 * p1 - 3 * p2 + p3) * t3)
  );
}

function clampIdx(i, n) {
  return i < 0 ? 0 : i >= n ? n - 1 : i;
}

/**
 * Resample a polyline of control points with a Catmull-Rom, splitting the curve
 * at `hard` points so corners stay sharp. Returns a flat sample list where each
 * sample carries the `hard` flag of the control point it sits exactly on.
 *
 * `perSeg` is samples per control segment (>= 1).
 */
export function resampleProfile(ctrl, perSeg = 4) {
  const n = ctrl.length;
  const out = [];
  const push = (x, y, hard) => out.push({ x, y, hard: !!hard });

  push(ctrl[0].x, ctrl[0].y, true); // the centreline is always a seam
  for (let i = 0; i < n - 1; i++) {
    const a = ctrl[i];
    const b = ctrl[i + 1];
    // A segment bounded by a hard point on either side is interpolated using
    // mirrored tangents so it does not overshoot into the corner.
    const p0 = a.hard ? a : ctrl[clampIdx(i - 1, n)];
    const p3 = b.hard ? b : ctrl[clampIdx(i + 2, n)];
    const straight = a.straight || b.straight;
    for (let s = 1; s <= perSeg; s++) {
      const t = s / perSeg;
      let x, y;
      if (straight) {
        x = a.x + (b.x - a.x) * t;
        y = a.y + (b.y - a.y) * t;
      } else {
        x = crom(p0.x, a.x, b.x, p3.x, t);
        y = crom(p0.y, a.y, b.y, p3.y, t);
      }
      push(x, y, s === perSeg && b.hard);
    }
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* BodySurface                                                         */
/* ------------------------------------------------------------------ */

export class BodySurface {
  /**
   * @param stations sorted by DESCENDING z (nose first), each
   *   `{ z, ctrl:[{x,y,hard?,straight?}], hard?:bool }`. Every station must
   *   have the same control-point count and the same hard pattern.
   */
  constructor(stations, perSeg = 4) {
    this.stations = stations.slice().sort((a, b) => b.z - a.z);
    this.perSeg = perSeg;
    this.profiles = this.stations.map((st) => resampleProfile(st.ctrl, perSeg));
    this.cols = this.profiles[0].length;
    this.z0 = this.stations[this.stations.length - 1].z;
    this.z1 = this.stations[0].z;
    this._tmp = new Array(this.cols);
    for (let i = 0; i < this.cols; i++) this._tmp[i] = { x: 0, y: 0, hard: this.profiles[0][i].hard };
  }

  /** Index of the station at or before z (walking nose -> tail). */
  _seg(z) {
    const st = this.stations;
    for (let i = 0; i < st.length - 1; i++) {
      if (z <= st[i].z && z >= st[i + 1].z) return i;
    }
    return z > st[0].z ? 0 : st.length - 2;
  }

  /** Interpolated profile at z, written into a shared scratch array. */
  profileAt(z) {
    const st = this.stations;
    const P = this.profiles;
    const i = this._seg(z);
    const za = st[i].z;
    const zb = st[i + 1].z;
    const t = zb === za ? 0 : (za - z) / (za - zb);
    const tc = Math.max(0, Math.min(1, t));
    const A = P[i];
    const B = P[i + 1];
    const A0 = P[clampIdx(i - 1, P.length)];
    const B1 = P[clampIdx(i + 2, P.length)];
    const flatA = st[i].hard;
    const flatB = st[i + 1].hard;
    const out = this._tmp;
    for (let c = 0; c < this.cols; c++) {
      if (flatA || flatB) {
        out[c].x = A[c].x + (B[c].x - A[c].x) * tc;
        out[c].y = A[c].y + (B[c].y - A[c].y) * tc;
      } else {
        out[c].x = crom(A0[c].x, A[c].x, B[c].x, B1[c].x, tc);
        out[c].y = crom(A0[c].y, A[c].y, B[c].y, B1[c].y, tc);
      }
    }
    return out;
  }

  /** Surface point at station z, column c (0 = top centre, cols-1 = floor centre). */
  point(z, c, out = new THREE.Vector3()) {
    const p = this.profileAt(z);
    const i = Math.max(0, Math.min(this.cols - 1, Math.round(c)));
    return out.set(p[i].x, p[i].y, z);
  }

  /** Outward normal at (z, c), by finite difference on the surface. */
  normal(z, c, out = new THREE.Vector3()) {
    const dz = 0.03;
    const a = this.point(Math.min(this.z1, z + dz), c, _n0);
    const b = this.point(Math.max(this.z0, z - dz), c, _n1);
    const p = this.profileAt(z);
    const i = Math.max(0, Math.min(this.cols - 1, Math.round(c)));
    const i0 = Math.max(0, i - 1);
    const i1 = Math.min(this.cols - 1, i + 1);
    _n2.set(p[i1].x - p[i0].x, p[i1].y - p[i0].y, 0);
    _n3.subVectors(a, b);
    out.crossVectors(_n2, _n3).normalize();
    if (out.lengthSq() < 0.5) out.set(1, 0, 0);
    if (out.x < 0 && p[i].x > 0.02) out.multiplyScalar(-1);
    return out;
  }

  /** Half-width of the section at z (the widest control point). */
  halfWidth(z) {
    const p = this.profileAt(z);
    let m = 0;
    for (let c = 0; c < this.cols; c++) if (p[c].x > m) m = p[c].x;
    return m;
  }

  /** Column index of the widest point at z — the shoulder. */
  widestColumn(z) {
    const p = this.profileAt(z);
    let m = -1;
    let mi = 0;
    for (let c = 0; c < this.cols; c++) if (p[c].x > m) { m = p[c].x; mi = c; }
    return mi;
  }
}

const _n0 = new THREE.Vector3();
const _n1 = new THREE.Vector3();
const _n2 = new THREE.Vector3();
const _n3 = new THREE.Vector3();

/* ------------------------------------------------------------------ */
/* Lofting                                                             */
/* ------------------------------------------------------------------ */

/**
 * Tessellate a BodySurface into a closed shell.
 *
 * opts:
 *   zSamples   number of longitudinal rings
 *   cuts       [{ z, r, flankFrom }] wheel-arch cutouts in the (z,y) plane
 *   capFront / capBack  close the ends with a fan
 *   uvScale    world metres per UV unit
 */
export function loftBody(surface, opts = {}) {
  const {
    zSamples = 120,
    cuts = [],
    capFront = true,
    capBack = true,
    uvScale = 1.6,
    zList = null,
  } = opts;

  const cols = surface.cols;
  const zs = zList ?? buildZList(surface, zSamples, cuts);
  const rows = zs.length;

  // Column expansion: hard columns are duplicated so normals do not average.
  const colMap = [];
  for (let c = 0; c < cols; c++) {
    colMap.push(c);
    if (c > 0 && c < cols - 1 && surface.profiles[0][c].hard) colMap.push(c);
  }
  const W = colMap.length;

  // Both sides: mirror columns. The centreline columns (c=0 and c=cols-1) are
  // shared, so build the right half then the left half reversed, skipping the
  // duplicated seam columns.
  const ring = [];
  for (let i = 0; i < W; i++) ring.push({ c: colMap[i], s: 1 });
  for (let i = W - 2; i >= 1; i--) ring.push({ c: colMap[i], s: -1 });
  const R = ring.length;

  const pos = new Float32Array(rows * R * 3);
  const uv = new Float32Array(rows * R * 2);
  const px = new Float32Array(rows * R); // |x| for the arch test

  for (let r = 0; r < rows; r++) {
    const z = zs[r];
    const prof = surface.profileAt(z);
    for (let i = 0; i < R; i++) {
      const e = ring[i];
      const p = prof[e.c];
      const k = (r * R + i) * 3;
      pos[k] = p.x * e.s;
      pos[k + 1] = p.y;
      pos[k + 2] = z;
      px[r * R + i] = p.x;
      const k2 = (r * R + i) * 2;
      uv[k2] = (i / (R - 1)) * 2.2;
      uv[k2 + 1] = z / uvScale;
    }
  }

  const idx = [];
  for (let r = 0; r < rows - 1; r++) {
    /**
     * `i < R` and a WRAPPING second column, not `i < R - 1`.
     *
     * The ring runs TOP(x=0) -> right flank -> FLOOR(x=0) -> left flank and has
     * to close back onto TOP. Stopping one short left the quad between the last
     * ring entry (the LEFT roof-mid column) and entry 0 unbuilt — an open strip
     * from the nose to the tail, as wide as the roof crown, along the top left
     * of the centreline. It read as a black "racing stripe" down the bonnet of
     * every car in the game and as a black V in the middle of every nose, and
     * because it is a hole rather than a surface it also swallowed the centre
     * of the bonnet shutline.
     */
    for (let i = 0; i < R; i++) {
      const j = (i + 1) % R;
      const a = r * R + i;
      const b = r * R + j;
      const c = (r + 1) * R + i;
      const d = (r + 1) * R + j;
      const zc = (zs[r] + zs[r + 1]) * 0.5;
      const yc = (pos[a * 3 + 1] + pos[b * 3 + 1] + pos[c * 3 + 1] + pos[d * 3 + 1]) * 0.25;
      const col = (ring[i].c + ring[j].c) * 0.5;
      if (cuts.length && isCut(cuts, zc, yc, col)) continue;
      const area =
        Math.abs(pos[a * 3] - pos[b * 3]) +
        Math.abs(pos[a * 3 + 1] - pos[b * 3 + 1]);
      if (area < 1e-6) continue;
      // Winding: the ring runs CLOCKWISE in the section plane seen from +Z
      // (roof centre -> right shoulder -> floor -> left shoulder) while rows
      // run towards -Z, so (a, b, c) is the outward-facing order. Getting this
      // backwards back-face-culls the entire body and you see the interior
      // trim through the doors — which is exactly what it did.
      idx.push(a, b, c, b, d, c);
    }
  }

  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  g.setIndex(idx);
  g.computeVertexNormals();

  const parts = [g];
  if (capFront) parts.push(capRing(surface, zs[0], ring, +1));
  if (capBack) parts.push(capRing(surface, zs[rows - 1], ring, -1));
  return parts.length > 1 ? mergeAll(parts) : g;
}

/**
 * Is this quad inside a cutout?
 *   arch  — a circle in the (z, y) plane with everything below it removed,
 *           restricted to the flank columns. This is the wheel-arch opening.
 *   panel — a (column, z) rectangle. Windows are exactly this: the greenhouse
 *           is part of the same loft as the body, so removing the band between
 *           the drip rail and the beltline over the cabin's z range leaves the
 *           roof, the shoulder and the pillars standing on their own.
 */
function isCut(cuts, z, y, col) {
  for (let q = 0; q < cuts.length; q++) {
    const cu = cuts[q];
    if (cu.kind === 'panel') {
      if (col < cu.c0 - 0.001 || col > cu.c1 + 0.001) continue;
      if (z < cu.z0 || z > cu.z1) continue;
      return true;
    }
    if (col < (cu.c0 ?? 0) - 0.001) continue;
    const dz = z - cu.z;
    if (Math.abs(dz) >= cu.r) continue;
    const top = cu.y + Math.sqrt(cu.r * cu.r - dz * dz);
    if (y <= top) return true;
  }
  return false;
}

/**
 * Re-tessellate a (column, z) region of the surface, pushed in along its own
 * normal. This is how glass is built: the windscreen is literally the piece of
 * the body that was cut away for it, moved 2 cm inboard, so it has the exact
 * rake and curvature of the opening and can never float or gap.
 */
export function loftPatch(surface, opts = {}) {
  const { c0, c1, z0, z1, inset = 0.02, zSamples = 14, sides = [1, -1], flip = false } = opts;
  const parts = [];
  const cols = [];
  for (let c = Math.round(c0); c <= Math.round(c1); c++) cols.push(c);
  const rows = Math.max(2, zSamples);
  for (const s of sides) {
    const pos = [];
    const uv = [];
    const idx = [];
    for (let r = 0; r < rows; r++) {
      const z = z1 + ((z0 - z1) * r) / (rows - 1);
      const prof = surface.profileAt(z);
      for (let ci = 0; ci < cols.length; ci++) {
        const c = Math.max(0, Math.min(surface.cols - 1, cols[ci]));
        const p = prof[c];
        // Inward normal, approximated in the section plane.
        const cm = Math.max(0, c - 1);
        const cp = Math.min(surface.cols - 1, c + 1);
        let nx = prof[cp].y - prof[cm].y;
        let ny = -(prof[cp].x - prof[cm].x);
        const l = Math.hypot(nx, ny) || 1;
        nx /= l; ny /= l;
        if (nx < 0) { nx = -nx; ny = -ny; }
        pos.push((p.x - nx * inset) * s, p.y - ny * inset, z);
        uv.push(ci / Math.max(1, cols.length - 1), r / (rows - 1));
      }
    }
    const W = cols.length;
    for (let r = 0; r < rows - 1; r++) {
      for (let ci = 0; ci < W - 1; ci++) {
        const a = r * W + ci;
        const b = r * W + ci + 1;
        const cc = (r + 1) * W + ci;
        const d = (r + 1) * W + ci + 1;
        // Same convention as loftBody: columns descend the section, rows run
        // aft, so (a, b, cc) faces outward.
        const front = s > 0 !== flip;
        if (front) idx.push(a, b, cc, b, d, cc);
        else idx.push(a, cc, b, b, cc, d);
      }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
    g.setIndex(idx);
    g.computeVertexNormals();
    parts.push(g);
  }
  return parts.length > 1 ? mergeAll(parts) : parts[0];
}

/**
 * A polyline that follows the surface along a column, used to place pillars,
 * shutlines and trim exactly on the shape.
 */
export function surfaceLine(surface, col, z0, z1, n = 12, side = 1, out = []) {
  out.length = 0;
  for (let i = 0; i < n; i++) {
    const z = z0 + ((z1 - z0) * i) / (n - 1);
    const prof = surface.profileAt(z);
    const c = Math.max(0, Math.min(surface.cols - 1, Math.round(col)));
    out.push(new THREE.Vector3(prof[c].x * side, prof[c].y, z));
  }
  return out;
}

/** Longitudinal sample positions, denser where the surface changes fastest. */
function buildZList(surface, n, cuts) {
  const out = [];
  const z0 = surface.z0;
  const z1 = surface.z1;
  // Always land a sample exactly on every station so creases stay put.
  const keys = surface.stations.map((s) => s.z);
  for (const cu of cuts) {
    if (cu.kind === 'panel') keys.push(cu.z0, cu.z1);
    else keys.push(cu.z - cu.r, cu.z + cu.r, cu.z);
  }
  // Clamp rather than filter: rounding a station's z can push it a hair
  // outside the surface's own range, and dropping it truncated the tail of
  // every body by exactly the last station's spacing.
  const uniq = [...new Set(keys.map((v) => Math.min(z1, Math.max(z0, v))))].sort((a, b) => b - a);

  for (let i = 0; i < uniq.length - 1; i++) {
    const a = uniq[i];
    const b = uniq[i + 1];
    const span = a - b;
    const steps = Math.max(1, Math.round((span / (z1 - z0)) * n));
    for (let s = 0; s < steps; s++) out.push(a - (span * s) / steps);
  }
  out.push(uniq[uniq.length - 1]);
  return out;
}

/** Close an end of the loft with a fan to the section centroid. */
function capRing(surface, z, ring, dir) {
  const prof = surface.profileAt(z);
  const R = ring.length;
  const pos = [];
  const uv = [];
  let cx = 0;
  let cy = 0;
  for (let i = 0; i < R; i++) {
    const p = prof[ring[i].c];
    cx += p.x * ring[i].s;
    cy += p.y;
  }
  cx /= R;
  cy /= R;
  const idx = [];
  pos.push(cx, cy, z);
  uv.push(0.5, 0.5);
  for (let i = 0; i < R; i++) {
    const p = prof[ring[i].c];
    pos.push(p.x * ring[i].s, p.y, z);
    uv.push(0.5 + p.x * ring[i].s * 0.4, 0.5 + p.y * 0.4);
  }
  // Fan over EVERY ring segment including the wrap from the last entry back to
  // the first. Stopping at R-1 left a missing wedge in the middle of the cap —
  // the black V in the centre of every nose and tail.
  for (let i = 1; i <= R; i++) {
    const j = i === R ? 1 : i + 1;
    if (dir > 0) idx.push(0, j, i);
    else idx.push(0, i, j);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

/* ------------------------------------------------------------------ */
/* Primitives                                                          */
/* ------------------------------------------------------------------ */

const _m = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _v = new THREE.Vector3();

/** Bevelled box — the workhorse for bumpers, mirrors, seats, dash. */
export function bevelBox(w, h, d, r = 0.02, seg = 2) {
  r = Math.min(r, w / 2 - 1e-3, h / 2 - 1e-3, d / 2 - 1e-3);
  if (r <= 0.002) return new THREE.BoxGeometry(w, h, d);
  const g = new THREE.BoxGeometry(w, h, d, 1, 1, 1);
  // Push the 8 corners in by r along each axis, then add a chamfer ring by
  // scaling: cheaper and cleaner than a real rounded box for panel work.
  const p = g.attributes.position;
  for (let i = 0; i < p.count; i++) {
    const x = p.getX(i), y = p.getY(i), z = p.getZ(i);
    p.setXYZ(i, x, y, z);
  }
  const inner = new THREE.BoxGeometry(w - 2 * r, h, d - 2 * r);
  const inner2 = new THREE.BoxGeometry(w, h - 2 * r, d - 2 * r);
  const inner3 = new THREE.BoxGeometry(w - 2 * r, h - 2 * r, d);
  const out = mergeAll([inner, inner2, inner3]);
  out.computeVertexNormals();
  g.dispose();
  return out;
}

/** A proper rounded box via a subdivided cube pushed onto a superellipsoid. */
export function roundedBox(w, h, d, r = 0.05, seg = 3) {
  const g = new THREE.BoxGeometry(w, h, d, seg, seg, seg);
  const p = g.attributes.position;
  const hx = w / 2, hy = h / 2, hz = d / 2;
  const rx = Math.min(r, hx * 0.98);
  const ry = Math.min(r, hy * 0.98);
  const rz = Math.min(r, hz * 0.98);
  for (let i = 0; i < p.count; i++) {
    let x = p.getX(i), y = p.getY(i), z = p.getZ(i);
    const cx = clampAbs(x, hx - rx);
    const cy = clampAbs(y, hy - ry);
    const cz = clampAbs(z, hz - rz);
    const dx = (x - cx) / rx, dy = (y - cy) / ry, dz = (z - cz) / rz;
    const l = Math.hypot(dx, dy, dz);
    if (l > 1e-6) {
      const s = 1 / l;
      x = cx + dx * s * rx;
      y = cy + dy * s * ry;
      z = cz + dz * s * rz;
    }
    p.setXYZ(i, x, y, z);
  }
  g.computeVertexNormals();
  return g;
}

function clampAbs(v, m) {
  return v > m ? m : v < -m ? -m : v;
}

/**
 * Sweep a 2D outline along a 3D polyline. Used for bumpers, arch lips, pillars,
 * roof rails, push bars — anything that follows a line on the body.
 */
/**
 * `smooth: false` (the default for a closed profile) duplicates the outline
 * vertices per face, so normals average ALONG the sweep but not ACROSS it. This
 * matters more than it sounds: a bumper, an arch lip or an A-pillar built from
 * a four-point outline with fully smoothed normals reads as a shiny sausage,
 * and the whole car looks like it was made of pipe cleaners.
 */
export function sweep(outline, path, opts = {}) {
  const {
    closed = false, caps = true, up = new THREE.Vector3(0, 1, 0),
    twist = null, scale = null, smooth = false,
  } = opts;
  const n = path.length;
  const m = outline.length;
  const segs = closed ? m : m - 1;
  const perRing = smooth ? m : segs * 2;
  const pos = [];
  const uv = [];
  const idx = [];
  const rawPos = [];
  const tangent = new THREE.Vector3();
  const right = new THREE.Vector3();
  const nUp = new THREE.Vector3();
  let run = 0;
  for (let i = 0; i < n; i++) {
    const a = path[Math.max(0, i - 1)];
    const b = path[Math.min(n - 1, i + 1)];
    tangent.set(b.x - a.x, b.y - a.y, b.z - a.z);
    if (tangent.lengthSq() < 1e-10) tangent.set(0, 0, 1);
    tangent.normalize();
    right.crossVectors(up, tangent);
    if (right.lengthSq() < 1e-8) right.set(1, 0, 0);
    right.normalize();
    nUp.crossVectors(tangent, right).normalize();
    if (i > 0) run += Math.hypot(path[i].x - path[i - 1].x, path[i].y - path[i - 1].y, path[i].z - path[i - 1].z);
    const s = scale ? scale(i / (n - 1)) : 1;
    const tw = twist ? twist(i / (n - 1)) : 0;
    const ct = Math.cos(tw), stw = Math.sin(tw);
    const place = (j) => {
      const ox = outline[j].x * s;
      const oy = outline[j].y * s;
      const rx = ox * ct - oy * stw;
      const ry = ox * stw + oy * ct;
      const x = path[i].x + right.x * rx + nUp.x * ry;
      const y = path[i].y + right.y * rx + nUp.y * ry;
      const z = path[i].z + right.z * rx + nUp.z * ry;
      pos.push(x, y, z);
      uv.push(j / m, run);
      return [x, y, z];
    };
    if (smooth) {
      for (let j = 0; j < m; j++) place(j);
    } else {
      for (let j = 0; j < segs; j++) {
        place(j);
        place((j + 1) % m);
      }
    }
    // Keep an un-duplicated ring for the end caps.
    for (let j = 0; j < m; j++) {
      const ox = outline[j].x * s;
      const oy = outline[j].y * s;
      const rx = ox * ct - oy * stw;
      const ry = ox * stw + oy * ct;
      rawPos.push(
        path[i].x + right.x * rx + nUp.x * ry,
        path[i].y + right.y * rx + nUp.y * ry,
        path[i].z + right.z * rx + nUp.z * ry
      );
    }
  }
  for (let i = 0; i < n - 1; i++) {
    for (let j = 0; j < segs; j++) {
      let a, b, c, d;
      if (smooth) {
        const j2 = (j + 1) % m;
        a = i * m + j; b = i * m + j2;
        c = (i + 1) * m + j; d = (i + 1) * m + j2;
      } else {
        a = i * perRing + j * 2; b = a + 1;
        c = (i + 1) * perRing + j * 2; d = c + 1;
      }
      idx.push(a, c, b, b, c, d);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setIndex(idx);
  g.computeVertexNormals();
  if (caps && closed) {
    const capA = fanCap(rawPos, 0, m, -1);
    const capB = fanCap(rawPos, (n - 1) * m, m, 1);
    return mergeAll([g, capA, capB]);
  }
  return g;
}

function fanCap(pos, start, m, dir) {
  const p = [];
  const uv = [];
  const idx = [];
  let cx = 0, cy = 0, cz = 0;
  for (let j = 0; j < m; j++) {
    cx += pos[(start + j) * 3];
    cy += pos[(start + j) * 3 + 1];
    cz += pos[(start + j) * 3 + 2];
  }
  cx /= m; cy /= m; cz /= m;
  p.push(cx, cy, cz);
  uv.push(0.5, 0.5);
  for (let j = 0; j < m; j++) {
    p.push(pos[(start + j) * 3], pos[(start + j) * 3 + 1], pos[(start + j) * 3 + 2]);
    uv.push(0.5, 0.5);
  }
  for (let j = 0; j < m; j++) {
    const a = 1 + j;
    const b = 1 + ((j + 1) % m);
    if (dir > 0) idx.push(0, a, b);
    else idx.push(0, b, a);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(p, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

/**
 * A thin strip lying on a surface — shutlines, badges, trim runs.
 * `pts` are world/local points already on (or just off) the surface, `normals`
 * the outward direction at each. Produces a ribbon of width `w` offset by `off`.
 */
export function ribbon(pts, normals, tangents, w, off = 0.002) {
  const n = pts.length;
  const pos = [];
  const uv = [];
  const idx = [];
  for (let i = 0; i < n; i++) {
    const p = pts[i];
    const nm = normals[i];
    const t = tangents[i];
    _v.crossVectors(nm, t).normalize().multiplyScalar(w * 0.5);
    pos.push(
      p.x + nm.x * off - _v.x, p.y + nm.y * off - _v.y, p.z + nm.z * off - _v.z,
      p.x + nm.x * off + _v.x, p.y + nm.y * off + _v.y, p.z + nm.z * off + _v.z
    );
    uv.push(0, i / n, 1, i / n);
  }
  for (let i = 0; i < n - 1; i++) {
    const a = i * 2, b = i * 2 + 1, c = i * 2 + 2, d = i * 2 + 3;
    idx.push(a, c, b, b, c, d);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

/**
 * A shutline. Not a ribbon — a real V-groove.
 *
 * WHY THIS REPLACED A FLAT STRIP. A panel gap used to be `ribbon(...)`: a flat
 * 9 mm strip sitting 1.8 mm PROUD of the body in the dark trim material. A flat
 * strip on a smooth loft has the same normal as the panel under it, so it shades
 * identically to the panel and the only thing distinguishing it is its albedo —
 * which, on a car photographed against a bright overcast sky, is a 1-pixel line
 * that reads LIGHTER than the paint as often as darker. Measured in the preview:
 * the door split came out as a pale line, not a gap, and the cars read as
 * having no shutlines at all.
 *
 * A gap is a hole. This builds four columns — lip, wall, wall, lip — so the two
 * walls face each other and one of them is always turned away from the key. That
 * pair of opposing normals is what makes a gap read at any light angle, and it
 * is why it survives the overcast sky the vehicle shots are staged under.
 *
 * @param w      total width across the lips, metres (10-16 mm is real)
 * @param depth  how far the floor sits below the skin (2-4 mm is real)
 * @param lift   how far the lips sit proud, to win the depth test against the
 *               loft they lie on. 0.4 mm was not enough and the first cut came
 *               out DASHED: the shutline is polylined at 8-26 samples while the
 *               shell it lies on is lofted at up to 150, so between samples the
 *               groove's flat chord sinks inside the curved panel and the body
 *               wins the depth test in the middle of every span. 1.4 mm clears
 *               the sagitta of a 15 cm chord on a 2 m radius panel and is still
 *               under the width of the gap itself.
 */
export function groove(pts, normals, tangents, w, depth = 0.003, lift = 0.0014) {
  const n = pts.length;
  const pos = [];
  const uv = [];
  const idx = [];
  // s across the groove, o along the normal. Lip / wall / wall / lip.
  const cols = [
    { s: -0.5, o: lift },
    { s: -0.17, o: -depth },
    { s: 0.17, o: -depth },
    { s: 0.5, o: lift },
  ];
  const W = cols.length;
  for (let i = 0; i < n; i++) {
    const p = pts[i];
    const nm = normals[i];
    const t = tangents[i];
    _v.crossVectors(nm, t).normalize();
    for (let c = 0; c < W; c++) {
      const s = cols[c].s * w;
      const o = cols[c].o;
      pos.push(p.x + nm.x * o + _v.x * s, p.y + nm.y * o + _v.y * s, p.z + nm.z * o + _v.z * s);
      uv.push(c / (W - 1), i / n);
    }
  }
  for (let i = 0; i < n - 1; i++) {
    for (let c = 0; c < W - 1; c++) {
      const a = i * W + c;
      const b = i * W + c + 1;
      const cc = (i + 1) * W + c;
      const d = (i + 1) * W + c + 1;
      idx.push(a, cc, b, b, cc, d);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

/**
 * OBJECT-SPACE BOX UV, IN METRES. Run over a MERGED group, after the merge.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * THIS IS WHY THE CARS SHIPPED UNTEXTURED
 * ────────────────────────────────────────────────────────────────────────────
 * A car body is a merge of about forty geometries from six different builders.
 * The lofted shell carries `u = ringIndex/(R-1)*2.2, v = z/uvScale`; a
 * `roundedBox` mirror cap carries a box unwrap in 0..1 over 6 cm; a lathe
 * carries a lathe unwrap; and `mergeAll` ZERO-FILLS the uv of anything that has
 * none at all. Those are four incompatible parameterisations sharing one
 * attribute, so a single texture cannot be applied to the group at a sane
 * density — put a 26x flake map on it and the shell gets 0.1 mm texels while
 * the mirror cap gets 2 mm ones and the parts with no uv get one texel each.
 *
 * That is the real reason `paint.js` had no `map` at all, and it is why every
 * review since the first has said "the sedan has no albedo map". The fix is not
 * a texture, it is a coordinate system.
 *
 * Dominant-axis planar projection in OBJECT space gives every triangle on every
 * part the same texel density in metres, needs no unwrap, and — because it is
 * object space, not world space — does not swim when the car drives. The seams
 * where the dominant axis changes are invisible for the isotropic micro-detail
 * this feeds (flake, orange peel, buffer swirls, road film, rust bloom); the
 * things that must NOT be projected — plate, dash, gauges, livery, tyre
 * sidewall, headlight fluting — keep their authored uv and are never passed
 * through here.
 *
 * `scale` is metres per uv unit; each texture then sets its own `repeat`.
 */
export function bakeBoxUV(geo, scale = 1) {
  const p = geo?.attributes?.position;
  if (!p) return geo;
  let nrm = geo.attributes.normal;
  if (!nrm) {
    geo.computeVertexNormals();
    nrm = geo.attributes.normal;
  }
  const n = p.count;
  const uv = new Float32Array(n * 2);
  const inv = 1 / (scale || 1);
  for (let i = 0; i < n; i++) {
    const x = p.getX(i);
    const y = p.getY(i);
    const z = p.getZ(i);
    const nx = Math.abs(nrm.getX(i));
    const ny = Math.abs(nrm.getY(i));
    const nz = Math.abs(nrm.getZ(i));
    let u, v;
    if (nx >= ny && nx >= nz) {
      // Flank. u runs the length of the car, v up it.
      u = z; v = y;
    } else if (ny >= nz) {
      // Roof, bonnet, boot lid. u across, v along.
      u = x; v = z;
    } else {
      // Fascia. u across, v up.
      u = x; v = y;
    }
    uv[i * 2] = u * inv;
    uv[i * 2 + 1] = v * inv;
  }
  geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  return geo;
}

/**
 * POLAR UV for a wheel rim, in wheel-local space (the axle runs along +X).
 *
 * Same problem as the body, and a worse one: a rim is a cylinder, a lathe, N
 * hand-built spokes with NO uv at all, a torus and two cylinders. Nothing can be
 * mapped across that set. But a wheel has an obvious natural parameterisation —
 * `u` around the axle, `v` out from the hub — and it is exactly the one the
 * content wants: machined lathe rings are constant in v, brake dust falls off in
 * v, spoke-pocket occlusion is periodic in u. So the texture and the geometry
 * agree by construction rather than by luck.
 *
 * `u` is multiplied by `spokes` so one tile of the map covers one spoke bay;
 * `v` is normalised on the rim radius, clamped a little past 1 for the lip.
 */
export function bakePolarUV(geo, radius, spokes = 5) {
  const p = geo?.attributes?.position;
  if (!p) return geo;
  const n = p.count;
  const uv = new Float32Array(n * 2);
  const inv = 1 / (radius || 1);
  const k = spokes / (Math.PI * 2);
  for (let i = 0; i < n; i++) {
    const y = p.getY(i);
    const z = p.getZ(i);
    const r = Math.hypot(y, z);
    uv[i * 2] = Math.atan2(z, y) * k;
    uv[i * 2 + 1] = r * inv;
  }
  geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  return geo;
}

/** Quad from four corners, with a normal that points at `dir`. */
export function quad(a, b, c, d) {
  const g = new THREE.BufferGeometry();
  g.setAttribute(
    'position',
    new THREE.Float32BufferAttribute([a.x, a.y, a.z, b.x, b.y, b.z, c.x, c.y, c.z, d.x, d.y, d.z], 3)
  );
  g.setAttribute('uv', new THREE.Float32BufferAttribute([0, 0, 1, 0, 1, 1, 0, 1], 2));
  g.setIndex([0, 1, 2, 0, 2, 3]);
  g.computeVertexNormals();
  return g;
}

/**
 * A planar polygon (fan) in 3D from a list of 2D points plus a placement basis.
 * Used for glass panels, which are flat-ish quads on a raked plane.
 */
export function polygon(pts2, origin, ex, ey, flip = false) {
  const pos = [];
  const uv = [];
  const idx = [];
  let cx = 0, cy = 0;
  for (const p of pts2) { cx += p.x; cy += p.y; }
  cx /= pts2.length; cy /= pts2.length;
  const put = (x, y) => {
    pos.push(
      origin.x + ex.x * x + ey.x * y,
      origin.y + ex.y * x + ey.y * y,
      origin.z + ex.z * x + ey.z * y
    );
    uv.push(x, y);
  };
  put(cx, cy);
  for (const p of pts2) put(p.x, p.y);
  for (let i = 0; i < pts2.length; i++) {
    const a = 1 + i;
    const b = 1 + ((i + 1) % pts2.length);
    if (flip) idx.push(0, b, a);
    else idx.push(0, a, b);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

/* ------------------------------------------------------------------ */
/* Utilities                                                           */
/* ------------------------------------------------------------------ */

export function transform(g, { pos, rot, scale, quat } = {}) {
  _m.identity();
  const q = quat ?? (rot ? _q.setFromEuler(new THREE.Euler(rot[0] ?? 0, rot[1] ?? 0, rot[2] ?? 0)) : _q.identity());
  _m.compose(
    _v.set(pos?.[0] ?? 0, pos?.[1] ?? 0, pos?.[2] ?? 0),
    q,
    new THREE.Vector3(scale?.[0] ?? 1, scale?.[1] ?? 1, scale?.[2] ?? 1)
  );
  g.applyMatrix4(_m);
  return g;
}

/**
 * Mirror across the YZ plane.
 *
 * `BufferGeometry.scale()` goes through `applyMatrix4`, which ALREADY transforms
 * the normal attribute by the normal matrix — so the normals come out mirrored
 * for free and flipping them again here points every mirrored part inside out.
 * That was worth an hour: half the car was lit as if the sun were underground.
 * The winding is NOT fixed by applyMatrix4 though (negative determinant), so
 * that still has to be reversed by hand.
 */
export function mirrorX(g) {
  const c = g.clone();
  c.scale(-1, 1, 1);
  const i = c.getIndex();
  if (i) {
    const arr = i.array;
    for (let k = 0; k < arr.length; k += 3) {
      const t = arr[k + 1];
      arr[k + 1] = arr[k + 2];
      arr[k + 2] = t;
    }
    i.needsUpdate = true;
  }
  return c;
}

/** Merge, tolerating geometries with mismatched attribute sets. */
export function mergeAll(list) {
  const good = list.filter((g) => g && g.attributes.position && g.attributes.position.count > 0);
  if (good.length === 0) return new THREE.BufferGeometry();
  if (good.length === 1) return good[0];
  for (const g of good) {
    if (!g.attributes.normal) g.computeVertexNormals();
    if (!g.attributes.uv) {
      const n = g.attributes.position.count;
      g.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(n * 2), 2));
    }
    for (const k of Object.keys(g.attributes)) {
      if (k !== 'position' && k !== 'normal' && k !== 'uv') g.deleteAttribute(k);
    }
    if (!g.getIndex()) {
      const n = g.attributes.position.count;
      const idx = new Uint32Array(n);
      for (let i = 0; i < n; i++) idx[i] = i;
      g.setIndex(new THREE.BufferAttribute(idx, 1));
    }
  }
  const merged = mergeGeometries(good, false);
  for (const g of good) g.dispose?.();
  return merged ?? good[0];
}

/** Approximate triangle count of a geometry. */
export function triCount(g) {
  const i = g.getIndex();
  return i ? i.count / 3 : g.attributes.position.count / 3;
}

/** Lathe a 2D outline (x = radius, y = axis) around Y. */
export function lathe(pts, seg = 24, thetaLen = Math.PI * 2, thetaStart = 0) {
  const shape = pts.map((p) => new THREE.Vector2(Math.max(1e-4, p.x), p.y));
  return new THREE.LatheGeometry(shape, seg, thetaStart, thetaLen);
}

/** Cylinder aligned with an arbitrary axis, from a to b. */
export function tubeBetween(a, b, r, seg = 10, capped = true) {
  const dir = _v.subVectors(b, a);
  const len = dir.length();
  if (len < 1e-6) return new THREE.BufferGeometry();
  const g = new THREE.CylinderGeometry(r, r, len, seg, 1, !capped);
  const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir.clone().normalize());
  const m = new THREE.Matrix4().compose(
    new THREE.Vector3().addVectors(a, b).multiplyScalar(0.5),
    q,
    new THREE.Vector3(1, 1, 1)
  );
  g.applyMatrix4(m);
  return g;
}

/** Per-vertex colour attribute filled with one colour. */
export function paintVertices(g, color) {
  const n = g.attributes.position.count;
  const arr = new Float32Array(n * 3);
  const c = new THREE.Color(color);
  for (let i = 0; i < n; i++) {
    arr[i * 3] = c.r;
    arr[i * 3 + 1] = c.g;
    arr[i * 3 + 2] = c.b;
  }
  g.setAttribute('color', new THREE.BufferAttribute(arr, 3));
  return g;
}
