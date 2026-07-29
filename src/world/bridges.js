import * as THREE from 'three';
import { Accum } from './util.js';
import { clamp01, lerp, RIVER_BED } from './plan.js';

/**
 * WORLD — bridge structure.
 *
 * The rivers are the only thing splitting Steel City, so the bridges are its
 * chokepoints and its silhouette. The DRIVING surface of a bridge is ordinary
 * road: the deck is part of the road graph with pinned node heights, so
 * `roadmesh` gives it camber, kerbs and lane paint for free. This file adds
 * everything that makes it read as a bridge from two kilometres away:
 *
 *   deck box + edge beams · piers standing in the river · parapet walls and
 *   steel railings · and one of three superstructures — a Warren truss, a
 *   two-hinge steel arch, or a self-anchored suspension span (the Three
 *   Sisters, which is what Pittsburgh is actually famous for).
 *
 * All eleven bridges merge into three meshes, always resident. They are
 * landmarks: streaming them would mean the skyline changed as you drove.
 */

export function buildBridges(specs, materials, palette, root) {
  const acc = new Map();
  const a = (k) => {
    let x = acc.get(k);
    if (!x) acc.set(k, (x = new Accum(`bridge_${k}`)));
    return x;
  };
  const col = new Accum('bridge_col');

  for (const b of specs) buildOne(b, a, col);

  const group = new THREE.Group();
  group.name = 'bridges';
  group.matrixAutoUpdate = false;
  let tris = 0;
  for (const [key, ac] of acc) {
    if (ac.empty) continue;
    const def = palette[key];
    const mesh = new THREE.Mesh(ac.build(), materials.get(def.name, def.opts));
    mesh.name = `bridge_${key}`;
    mesh.matrixAutoUpdate = false;
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    mesh.userData.collision = false;
    mesh.userData.surface = def.surface;
    group.add(mesh);
    tris += mesh.geometry.index.count / 3;
  }
  root.add(group);

  let colMesh = null;
  if (!col.empty) {
    colMesh = new THREE.Mesh(col.build(), INVISIBLE);
    colMesh.name = 'bridge_col';
    colMesh.visible = false;
    colMesh.matrixAutoUpdate = false;
    colMesh.userData.surface = 'metal';
  }
  return { group, colMesh, tris };
}

function buildOne(b, a, col) {
  const conc = a('bridge_concrete');
  const steel = a('bridge_steel');
  const rail = a('bridge_rail');
  const pts = b.pts;
  const ys = b.y;
  const hw = b.width / 2;
  const [ox, oz] = b.origin;
  const [dx, dz] = b.dir;
  const rx = -dz;
  const rz = dx;
  const [sp0, sp1] = b.span;
  const arc = (p) => (p[0] - ox) * dx + (p[1] - oz) * dz;

  /* ---- deck box: soffit slab + edge beams ---------------------------- */
  let prev = null;
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i];
    const s = arc(p);
    const y = ys[i];
    const onSpan = s >= sp0 - 4 && s <= sp1 + 4;
    const depth = onSpan ? 1.5 : 0.9;
    const x = p[0];
    const z = p[1];
    const row = [];
    // outer bottom, outer top(under kerb), inner bottom — a simple box section
    for (const [o, dy, n] of [
      [-hw, -0.02, [rx * -1, 0, rz * -1]],
      [-hw, -depth, [rx * -1, 0, rz * -1]],
      [hw, -depth, [rx, 0, rz]],
      [hw, -0.02, [rx, 0, rz]],
    ]) {
      row.push(conc.vert(x + rx * o, y + dy, z + rz * o, n[0], n[1], n[2], s * 0.2, dy, 0.4, 0.55, 0.35));
    }
    // soffit normal-down copies
    const sf = [
      conc.vert(x + rx * -hw, y - depth, z + rz * -hw, 0, -1, 0, s * 0.2, -hw, 0.2, 0.7, 0.55),
      conc.vert(x + rx * hw, y - depth, z + rz * hw, 0, -1, 0, s * 0.2, hw, 0.2, 0.7, 0.55),
    ];
    const cur = { row, sf };
    if (prev) {
      conc.faceQuad(prev.row[0], row[0], row[1], prev.row[1], -rx, 0, -rz); // left
      conc.faceQuad(prev.row[3], prev.row[2], row[2], row[3], rx, 0, rz); // right
      conc.faceQuad(prev.sf[0], prev.sf[1], sf[1], sf[0], 0, -1, 0); // soffit
    }
    prev = cur;
  }

  /* ---- parapet + railing --------------------------------------------- */
  for (const side of [-1, 1]) {
    let pr = null;
    for (let i = 0; i < pts.length; i++) {
      const p = pts[i];
      const y = ys[i];
      const o = side * (hw - 0.28);
      const x = p[0] + rx * o;
      const z = p[1] + rz * o;
      const nx = rx * side;
      const nz = rz * side;
      const wear = clamp01(0.45 + Math.sin(i * 2.3) * 0.25);
      const v0 = conc.vert(x, y + 0.12, z, nx, 0, nz, i, 0, 0.5, wear, 0.3);
      const v1 = conc.vert(x, y + 0.62, z, nx, 0.2, nz, i, 1, 0.85, wear * 0.6, 0.1);
      const v2 = conc.vert(x - nx * 0.32, y + 0.62, z - nz * 0.32, 0, 1, 0, i, 1, 0.7, wear * 0.7, 0.12);
      if (pr) {
        conc.faceQuad(pr[0], v0, v1, pr[1], nx, 0, nz);
        conc.faceQuad(pr[1], v1, v2, pr[2], 0, 1, 0);
      }
      pr = [v0, v1, v2];

      // parapet collision: a thin wall so you cannot drive off
      if (i > 0) {
        const q = pts[i - 1];
        const qx = q[0] + rx * o;
        const qz = q[1] + rz * o;
        const qy = ys[i - 1];
        const c0 = col.vert(qx, qy + 0.1, qz, nx, 0, nz, 0, 0);
        const c1 = col.vert(x, y + 0.1, z, nx, 0, nz, 0, 0);
        const c2 = col.vert(x, y + 1.25, z, nx, 0, nz, 0, 0);
        const c3 = col.vert(qx, qy + 1.25, qz, nx, 0, nz, 0, 0);
        col.faceQuad(c0, c1, c2, c3, nx, 0, nz);
        col.faceQuad(c3, c2, c1, c0, -nx, 0, -nz);
      }
    }
    // steel railing above the parapet
    for (let i = 0; i < pts.length - 1; i++) {
      const p = pts[i];
      const q = pts[i + 1];
      const o = side * (hw - 0.28);
      const ax = p[0] + rx * o;
      const az = p[1] + rz * o;
      const bx = q[0] + rx * o;
      const bz = q[1] + rz * o;
      for (const h of [0.72, 1.12]) {
        member(rail, ax, ys[i] + h, az, bx, ys[i + 1] + h, bz, 0.035, 0.6, 0.4);
      }
      const segLen = Math.hypot(bx - ax, bz - az);
      const posts = Math.max(1, Math.round(segLen / 2.3));
      for (let k = 0; k < posts; k++) {
        const t = k / posts;
        const px = lerp(ax, bx, t);
        const pz = lerp(az, bz, t);
        const py = lerp(ys[i], ys[i + 1], t);
        member(rail, px, py + 0.58, pz, px, py + 1.18, pz, 0.042, 0.55, 0.45);
      }
    }
  }

  /* ---- piers ---------------------------------------------------------- */
  const spanLen = sp1 - sp0;
  const piers = Math.max(1, Math.round(spanLen / 92));
  for (let k = 1; k < piers; k++) {
    const s = sp0 + (spanLen * k) / piers;
    const t = arcToIndex(b, s);
    const px = ox + dx * s;
    const pz = oz + dz * s;
    const top = t.y - (s >= sp0 && s <= sp1 ? 1.5 : 0.9);
    const bed = RIVER_BED - 1;
    for (const side of [-1, 1]) {
      const cx = px + rx * side * hw * 0.44;
      const cz = pz + rz * side * hw * 0.44;
      column(conc, cx, bed, cz, top, 2.5, 1.7, dx, dz);
    }
    // pier cap
    member(conc, px + rx * (-hw), top - 0.55, pz + rz * (-hw), px + rx * hw, top - 0.55, pz + rz * hw, 1.05, 0.35, 0.5);
  }
  // abutments
  for (const s of [sp0, sp1]) {
    const t = arcToIndex(b, s);
    const px = ox + dx * s;
    const pz = oz + dz * s;
    column(conc, px, Math.max(-2, t.y - 22), pz, t.y - 1.1, hw * 0.95, hw * 0.8, dx, dz);
  }

  /* ---- superstructure ------------------------------------------------- */
  if (b.style === 'truss') truss(b, steel, arcToIndex, hw);
  else if (b.style === 'arch') arch(b, steel, arcToIndex, hw);
  else suspension(b, steel, arcToIndex, hw);
}

function arcToIndex(b, s) {
  const [ox, oz] = b.origin;
  const [dx, dz] = b.dir;
  const pts = b.pts;
  for (let i = 0; i < pts.length - 1; i++) {
    const sa = (pts[i][0] - ox) * dx + (pts[i][1] - oz) * dz;
    const sb = (pts[i + 1][0] - ox) * dx + (pts[i + 1][1] - oz) * dz;
    if (s >= sa && s <= sb) {
      const t = (s - sa) / Math.max(1e-6, sb - sa);
      return { y: lerp(b.y[i], b.y[i + 1], t) };
    }
  }
  return { y: b.deckY };
}

/* ------------------------------------------------------ superstructures -- */

function truss(b, steel, at, hw) {
  const [sp0, sp1] = b.span;
  const [ox, oz] = b.origin;
  const [dx, dz] = b.dir;
  const rx = -dz;
  const rz = dx;
  const L = sp1 - sp0;
  const bays = Math.max(6, Math.round(L / 13));
  const H = Math.min(16, 5 + L * 0.09);
  const P = (s, side, top) => {
    const y = at(b, s).y;
    const rise = top ? H * (0.55 + 0.45 * Math.sin((Math.PI * (s - sp0)) / L)) : 0;
    return [ox + dx * s + rx * side * (hw - 0.1), y + 1.35 + rise, oz + dz * s + rz * side * (hw - 0.1)];
  };
  for (const side of [-1, 1]) {
    let prevTop = null;
    let prevBot = null;
    for (let i = 0; i <= bays; i++) {
      const s = sp0 + (L * i) / bays;
      const top = P(s, side, true);
      const bot = P(s, side, false);
      if (prevTop) {
        member(steel, prevTop[0], prevTop[1], prevTop[2], top[0], top[1], top[2], 0.28, 0.5, 0.5);
        // Warren diagonals
        if (i % 2 === 1) member(steel, prevBot[0], prevBot[1], prevBot[2], top[0], top[1], top[2], 0.17, 0.45, 0.55);
        else member(steel, prevTop[0], prevTop[1], prevTop[2], bot[0], bot[1], bot[2], 0.17, 0.45, 0.55);
      }
      if (i > 0 && i < bays) member(steel, bot[0], bot[1], bot[2], top[0], top[1], top[2], 0.2, 0.5, 0.5);
      prevTop = top;
      prevBot = bot;
    }
  }
  // portal / sway bracing across the top
  for (let i = 1; i < bays; i += 2) {
    const s = sp0 + (L * i) / bays;
    const l = P(s, -1, true);
    const r = P(s, 1, true);
    member(steel, l[0], l[1], l[2], r[0], r[1], r[2], 0.16, 0.5, 0.5);
  }
}

function arch(b, steel, at, hw) {
  const [sp0, sp1] = b.span;
  const [ox, oz] = b.origin;
  const [dx, dz] = b.dir;
  const rx = -dz;
  const rz = dx;
  const L = sp1 - sp0;
  const RISE = Math.min(30, 8 + L * 0.16);
  const segs = Math.max(10, Math.round(L / 11));
  for (const side of [-1, 1]) {
    let prev = null;
    for (let i = 0; i <= segs; i++) {
      const t = i / segs;
      const s = sp0 + L * t;
      const y = at(b, s).y;
      const rise = RISE * Math.sin(Math.PI * t);
      const p = [ox + dx * s + rx * side * (hw - 0.6), y + 0.4 + rise, oz + dz * s + rz * side * (hw - 0.6)];
      if (prev) member(steel, prev[0], prev[1], prev[2], p[0], p[1], p[2], 0.42, 0.45, 0.5);
      // hangers down to the deck
      if (i > 0 && i < segs && i % 2 === 0 && rise > 2) {
        member(steel, p[0], p[1], p[2], p[0], y + 0.6, p[2], 0.07, 0.4, 0.5);
      }
      prev = p;
    }
  }
  // cross bracing over the crown
  for (let i = 2; i < segs - 1; i += 3) {
    const t = i / segs;
    const s = sp0 + L * t;
    const y = at(b, s).y + 0.4 + RISE * Math.sin(Math.PI * t);
    if (RISE * Math.sin(Math.PI * t) < 6) continue;
    member(steel, ox + dx * s + rx * -(hw - 0.6), y, oz + dz * s + rz * -(hw - 0.6),
      ox + dx * s + rx * (hw - 0.6), y, oz + dz * s + rz * (hw - 0.6), 0.14, 0.5, 0.5);
  }
}

function suspension(b, steel, at, hw) {
  const [sp0, sp1] = b.span;
  const [ox, oz] = b.origin;
  const [dx, dz] = b.dir;
  const rx = -dz;
  const rz = dx;
  const L = sp1 - sp0;
  const TOWER = Math.min(30, 13 + L * 0.09);
  const towers = [sp0 + L * 0.16, sp1 - L * 0.16];
  for (const side of [-1, 1]) {
    // towers
    for (const s of towers) {
      const y = at(b, s).y;
      const x = ox + dx * s + rx * side * (hw - 0.5);
      const z = oz + dz * s + rz * side * (hw - 0.5);
      member(steel, x, y - 1.4, z, x, y + TOWER, z, 0.62, 0.4, 0.45);
      member(steel, x - dx * 2.4, y + TOWER * 0.55, z - dz * 2.4, x + dx * 2.4, y + TOWER * 0.55, z + dz * 2.4, 0.22, 0.45, 0.5);
    }
    // main cable: catenary between the towers, back-stayed to the abutments
    const segs = 22;
    let prev = null;
    for (let i = 0; i <= segs; i++) {
      const t = i / segs;
      const s = sp0 + L * t;
      const y = at(b, s).y;
      let cy;
      if (s < towers[0]) cy = lerp(y + 1.2, y + TOWER, (s - sp0) / (towers[0] - sp0));
      else if (s > towers[1]) cy = lerp(y + TOWER, y + 1.2, (s - towers[1]) / (sp1 - towers[1]));
      else {
        const u = (s - towers[0]) / (towers[1] - towers[0]);
        const sag = TOWER * 0.78;
        cy = y + TOWER - sag * Math.sin(Math.PI * u) ** 1.15;
      }
      const p = [ox + dx * s + rx * side * (hw - 0.5), cy, oz + dz * s + rz * side * (hw - 0.5)];
      if (prev) member(steel, prev[0], prev[1], prev[2], p[0], p[1], p[2], 0.16, 0.35, 0.4);
      if (s > towers[0] && s < towers[1] && cy - y > 2.2) {
        member(steel, p[0], p[1], p[2], p[0], y + 0.7, p[2], 0.05, 0.35, 0.45);
      }
      prev = p;
    }
  }
}

/* ------------------------------------------------------------ primitives -- */

/** A square-section strut between two points. 8 verts, 8 triangles. */
function member(acc, x0, y0, z0, x1, y1, z1, r, wear, grime) {
  let ax = x1 - x0;
  let ay = y1 - y0;
  let az = z1 - z0;
  const len = Math.hypot(ax, ay, az);
  if (len < 1e-4) return;
  ax /= len;
  ay /= len;
  az /= len;
  // two perpendiculars
  let ux = 0;
  let uy = 1;
  let uz = 0;
  if (Math.abs(ay) > 0.94) {
    ux = 1;
    uy = 0;
  }
  let px = uy * az - uz * ay;
  let py = uz * ax - ux * az;
  let pz = ux * ay - uy * ax;
  const pl = Math.hypot(px, py, pz) || 1;
  px /= pl;
  py /= pl;
  pz /= pl;
  const qx = ay * pz - az * py;
  const qy = az * px - ax * pz;
  const qz = ax * py - ay * px;
  const v = [];
  for (const [ex, ey] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) {
    const nx = px * ex + qx * ey;
    const ny = py * ex + qy * ey;
    const nz = pz * ex + qz * ey;
    const inv = 1 / Math.hypot(nx, ny, nz);
    v.push(acc.vert(x0 + nx * r, y0 + ny * r, z0 + nz * r, nx * inv, ny * inv, nz * inv, 0, 0, wear, grime, 0.3));
    v.push(acc.vert(x1 + nx * r, y1 + ny * r, z1 + nz * r, nx * inv, ny * inv, nz * inv, 0, len, wear, grime, 0.3));
  }
  for (let i = 0; i < 4; i++) {
    const a0 = v[i * 2];
    const a1 = v[i * 2 + 1];
    const b0 = v[((i + 1) % 4) * 2];
    const b1 = v[((i + 1) % 4) * 2 + 1];
    // Outward is the mean of the two corner directions, which is all the
    // winding test needs.
    const e = [[-1, -1], [1, -1], [1, 1], [-1, 1]];
    const ea = e[i];
    const eb = e[(i + 1) % 4];
    const ox = px * (ea[0] + eb[0]) * 0.5 + qx * (ea[1] + eb[1]) * 0.5;
    const oy = py * (ea[0] + eb[0]) * 0.5 + qy * (ea[1] + eb[1]) * 0.5;
    const oz = pz * (ea[0] + eb[0]) * 0.5 + qz * (ea[1] + eb[1]) * 0.5;
    acc.faceQuad(a0, a1, b1, b0, ox, oy, oz);
  }
}

/** A tapered rectangular column, used for piers and abutments. */
function column(acc, x, yBase, z, yTop, rBase, rTop, dx, dz) {
  const rx = -dz;
  const rz = dx;
  const ring = (y, r) => {
    const o = [];
    for (const [u, v] of [[-1, -0.55], [1, -0.55], [1, 0.55], [-1, 0.55]]) {
      const nx = dx * u + rx * v;
      const nz = dz * u + rz * v;
      const inv = 1 / Math.hypot(nx, nz);
      o.push(acc.vert(x + nx * r, y, z + nz * r, nx * inv, 0, nz * inv, u, y * 0.2, 0.35, 0.6, 0.4));
    }
    return o;
  };
  const a = ring(yBase, rBase);
  const b = ring(yTop, rTop);
  for (let i = 0; i < 4; i++) {
    const e = [[-1, -0.55], [1, -0.55], [1, 0.55], [-1, 0.55]];
    const ea = e[i];
    const eb = e[(i + 1) % 4];
    const ox = dx * (ea[0] + eb[0]) * 0.5 + rx * (ea[1] + eb[1]) * 0.5;
    const oz = dz * (ea[0] + eb[0]) * 0.5 + rz * (ea[1] + eb[1]) * 0.5;
    acc.faceQuad(a[i], b[i], b[(i + 1) % 4], a[(i + 1) % 4], ox, 0, oz);
  }
  const t = ring(yTop, rTop);
  acc.faceQuad(t[0], t[1], t[2], t[3], 0, 1, 0);
}

const INVISIBLE = new THREE.MeshBasicMaterial({ visible: false });
