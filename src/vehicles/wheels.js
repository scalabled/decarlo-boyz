/**
 * Wheels.
 *
 * Local space: the axle runs along +X, so the wheel is a disc in the YZ plane
 * and rolling is a rotation about X. The tyre is a revolve of a real sidewall
 * section — bead, bulge, shoulder, tread — with the tread band displaced by the
 * groove pattern so the blocks are geometry and not just a normal map. The rim
 * is a barrel, a lip, spokes and a hub with lug bolts, and behind it sit a
 * ventilated disc and a caliper, because at 3 m the gap between the spokes is
 * where the eye goes.
 */

import * as THREE from 'three';
import { mergeAll, transform, roundedBox, tubeBetween } from './geom.js';

const SECTION_V = [0, 0.06, 0.16, 0.24, 0.76, 0.84, 0.94, 1];

/**
 * @returns { rubber, rim, disc, caliper } geometry lists in wheel-local space.
 */
export function buildWheel(spec, lod = 0, front = true) {
  const w = spec.wheel;
  const r = w.radius;
  const halfW = w.width / 2;
  const rimR = r * w.rimFrac;
  const seg = [40, 24, 14, 8][lod];
  const out = { rubber: [], rim: [], disc: [], caliper: [] };

  out.rubber.push(tyre(r, halfW, rimR, seg, lod));

  // ---- rim barrel + lip -------------------------------------------------
  const barrel = new THREE.CylinderGeometry(rimR * 0.99, rimR * 0.99, w.width * 0.96, seg, 1, true);
  transform(barrel, { rot: [0, 0, Math.PI / 2] });
  out.rim.push(barrel);

  const lipPts = [];
  for (let i = 0; i <= 6; i++) {
    const a = (i / 6) * Math.PI;
    lipPts.push(new THREE.Vector2(rimR + Math.sin(a) * 0.014, halfW * 0.96 - 0.012 + Math.cos(a) * 0.014));
  }
  const lip = new THREE.LatheGeometry(lipPts, seg);
  transform(lip, { rot: [0, 0, -Math.PI / 2] });
  out.rim.push(lip);

  // ---- face -------------------------------------------------------------
  const faceX = halfW * 0.68;
  const style = w.style;
  const nSpoke = w.spokes;

  if (style === 'cover') {
    // full wheel cover: a dished disc with slots
    const cover = dishedDisc(rimR * 0.98, faceX, seg, 0.045);
    out.rim.push(cover);
    for (let i = 0; i < 10; i++) {
      const a = (i / 10) * Math.PI * 2;
      const slot = roundedBox(0.018, rimR * 0.5, 0.09, 0.008, 1);
      transform(slot, {
        pos: [faceX - 0.02, Math.cos(a) * rimR * 0.62, Math.sin(a) * rimR * 0.62],
        rot: [a, 0, 0],
      });
      out.disc.push(slot);
    }
  } else if (style === 'steel' || style === 'lorry') {
    const plate = dishedDisc(rimR * 0.97, faceX, seg, 0.03);
    out.rim.push(plate);
    const holes = style === 'lorry' ? 8 : 6;
    for (let i = 0; i < holes; i++) {
      const a = (i / holes) * Math.PI * 2;
      const hole = new THREE.CylinderGeometry(rimR * 0.14, rimR * 0.14, 0.06, 10);
      transform(hole, {
        pos: [faceX, Math.cos(a) * rimR * 0.58, Math.sin(a) * rimR * 0.58],
        rot: [0, 0, Math.PI / 2],
      });
      out.disc.push(hole);
    }
  } else {
    // alloy: spokes from the hub to the rim
    const spokeW = style === 'split' ? 0.055 : 0.075;
    const pairs = style === 'split' ? 2 : 1;
    for (let i = 0; i < nSpoke; i++) {
      const a = (i / nSpoke) * Math.PI * 2;
      for (let p = 0; p < pairs; p++) {
        const off = pairs === 1 ? 0 : (p - 0.5) * 0.19;
        const aa = a + off;
        const len = rimR * 0.84;
        const sp = spokeGeom(len, spokeW, rimR, style);
        transform(sp, { pos: [faceX - 0.012, 0, 0], rot: [aa, 0, 0] });
        out.rim.push(sp);
      }
    }
    // rim inner ring joining the spokes
    const ring = new THREE.TorusGeometry(rimR * 0.94, 0.022, 6, seg);
    transform(ring, { pos: [faceX - 0.01, 0, 0], rot: [0, Math.PI / 2, 0] });
    out.rim.push(ring);
  }

  // ---- hub + lug bolts ---------------------------------------------------
  const hub = new THREE.CylinderGeometry(rimR * 0.3, rimR * 0.34, 0.07, seg > 20 ? 20 : 10);
  transform(hub, { pos: [faceX - 0.02, 0, 0], rot: [0, 0, Math.PI / 2] });
  out.rim.push(hub);
  const cap = new THREE.CylinderGeometry(rimR * 0.17, rimR * 0.19, 0.03, 14);
  transform(cap, { pos: [faceX + 0.012, 0, 0], rot: [0, 0, Math.PI / 2] });
  out.disc.push(cap);
  if (lod < 2) {
    const nl = spec.mass > 3000 ? 8 : 5;
    for (let i = 0; i < nl; i++) {
      const a = (i / nl) * Math.PI * 2;
      const bolt = new THREE.CylinderGeometry(0.017, 0.017, 0.022, 6);
      transform(bolt, {
        pos: [faceX - 0.005, Math.cos(a) * rimR * 0.24, Math.sin(a) * rimR * 0.24],
        rot: [0, 0, Math.PI / 2],
      });
      out.disc.push(bolt);
    }
  }

  // ---- brake disc + caliper ---------------------------------------------
  if (lod < 2) {
    const dR = rimR * 0.82;
    const disc = new THREE.CylinderGeometry(dR, dR, 0.026, seg > 20 ? 28 : 14);
    transform(disc, { pos: [-0.01, 0, 0], rot: [0, 0, Math.PI / 2] });
    out.disc.push(disc);
    // The disc bell. Kept clear of the rim hub in BOTH radius and x — at
    // dR*0.42 sitting at x=+0.02 it was coplanar with the hub cylinder and the
    // pair z-fought into a ring of black and white triangles behind the spokes.
    const hat = new THREE.CylinderGeometry(dR * 0.34, dR * 0.34, 0.05, 14);
    transform(hat, { pos: [-0.005, 0, 0], rot: [0, 0, Math.PI / 2] });
    out.disc.push(hat);
    if (lod === 0) {
      // drilled holes read as dark dots through the spokes
      for (let i = 0; i < 12; i++) {
        const a = (i / 12) * Math.PI * 2;
        const h = new THREE.CylinderGeometry(0.011, 0.011, 0.034, 6);
        transform(h, {
          pos: [-0.01, Math.cos(a) * dR * 0.72, Math.sin(a) * dR * 0.72],
          rot: [0, 0, Math.PI / 2],
        });
        out.caliper.push(h);
      }
    }
    const cal = roundedBox(0.075, dR * 0.62, 0.11, 0.02, 1);
    transform(cal, { pos: [-0.012, dR * 0.62, -0.03], rot: [0.35, 0, 0] });
    out.caliper.push(cal);
  }

  return out;
}

function spokeGeom(len, wid, rimR, style) {
  const parts = [];
  const n = 5;
  const pos = [];
  const idx = [];
  // A tapered, dished spoke: wide and deep at the hub, thin at the rim.
  for (let i = 0; i < n; i++) {
    const t = i / (n - 1);
    const rr = rimR * 0.2 + (len - rimR * 0.2) * t;
    const hw = wid * (1.5 - 0.85 * t);
    const d = 0.05 * (1 - 0.45 * t);
    const bow = -0.03 * Math.sin(t * Math.PI);
    pos.push(
      bow - d, rr, -hw,
      bow - d, rr, hw,
      bow + d * 0.35, rr, hw * 0.8,
      bow + d * 0.35, rr, -hw * 0.8
    );
  }
  for (let i = 0; i < n - 1; i++) {
    for (let j = 0; j < 4; j++) {
      const j2 = (j + 1) % 4;
      const a = i * 4 + j, b = i * 4 + j2, c = (i + 1) * 4 + j, d = (i + 1) * 4 + j2;
      idx.push(a, c, b, b, c, d);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setIndex(idx);
  g.computeVertexNormals();
  g.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(g.attributes.position.count * 2), 2));
  parts.push(g);
  return mergeAll(parts);
}

function dishedDisc(R, x, seg, dish) {
  const pts = [];
  const n = 8;
  for (let i = 0; i < n; i++) {
    const t = i / (n - 1);
    pts.push(new THREE.Vector2(Math.max(0.004, R * t), x - dish * (1 - t) * (1 - t)));
  }
  const g = new THREE.LatheGeometry(pts.reverse(), seg);
  transform(g, { rot: [0, 0, -Math.PI / 2] });
  return g;
}

/**
 * The tyre. A revolve of the sidewall section with the tread band displaced by
 * the groove pattern — four circumferential grooves and lateral sipes, so the
 * silhouette against the road has actual tread blocks in it.
 */
function tyre(r, halfW, rimR, seg, lod) {
  const shoulder = halfW * 0.86;
  /**
   * THE TREAD.
   *
   * What used to be here was one flat quad across the whole crown plus a
   * "lateral sipe" that displaced the radius by `((i/seg)*44) % 1 < 0.3`. With
   * `seg = 40` at LOD0 that expression advances 1.1 periods PER SEGMENT: the
   * pattern aliases into near-noise and never resolves into a block, so the
   * only tread the tyre had was whatever the normal map could suggest on a
   * geometrically perfect torus. A critic standing next to a car called them
   * "treadless torus wheels" and was right.
   *
   * The crown is now cut by four real circumferential grooves — duplicated
   * section rows at the same x with a smaller radius give vertical groove
   * walls, so the ribs read as separate blocks in the silhouette and catch
   * their own shadow. The groove positions match the four in `makeTyreMaps`,
   * so the geometry and the normal map describe the same tyre instead of two
   * different ones fighting.
   *
   * LOD1 and beyond keep the plain section: a groove is 14 mm and the whole
   * wheel is a few pixels past 22 m.
   */
  const GROOVES = [0.13, 0.38, 0.62, 0.87];
  const gHalf = 0.052;
  const gDepth = r * 0.036;
  const sect = [
    { x: -halfW, r: rimR, v: 0 },
    { x: -halfW * 1.06, r: rimR + (r - rimR) * 0.38, v: 0.06 },
    { x: -halfW * 0.99, r: r * 0.975, v: 0.16 },
  ];
  const crownAt = (t, rad) => sect.push({ x: -shoulder + 2 * shoulder * t, r: rad, v: 0.24 + t * 0.52 });
  crownAt(0, r);
  if (lod === 0) {
    for (const gp of GROOVES) {
      crownAt(gp - gHalf, r);
      crownAt(gp - gHalf, r - gDepth);
      crownAt(gp + gHalf, r - gDepth);
      crownAt(gp + gHalf, r);
    }
  }
  crownAt(1, r);
  sect.push(
    { x: halfW * 0.99, r: r * 0.975, v: 0.84 },
    { x: halfW * 1.06, r: rimR + (r - rimR) * 0.38, v: 0.94 },
    { x: halfW, r: rimR, v: 1 }
  );

  const m = sect.length;
  const pos = [];
  const uv = [];
  const idx = [];
  for (let i = 0; i < seg; i++) {
    const a = (i / seg) * Math.PI * 2;
    const ca = Math.cos(a);
    const sa = Math.sin(a);
    for (let j = 0; j < m; j++) {
      pos.push(sect[j].x, ca * sect[j].r, sa * sect[j].r);
      uv.push(i / seg, sect[j].v);
    }
  }
  for (let i = 0; i < seg; i++) {
    const i2 = (i + 1) % seg;
    for (let j = 0; j < m - 1; j++) {
      const a = i * m + j;
      const b = i * m + j + 1;
      const c = i2 * m + j;
      const d = i2 * m + j + 1;
      idx.push(a, b, c, b, d, c);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

/** Motorcycle fork / swingarm / bodywork, built around the two wheels. */
export function buildBikeChassis(spec, lod = 0) {
  const s = spec.style;
  const out = { paint: [], trim: [], chrome: [], cavity: [], glass: [], lamps: {}, plate: [], disc: [] };
  const lamp = (k, g) => (out.lamps[k] = out.lamps[k] ?? []).push(g);
  const zF = s.archF.z;
  const zR = s.archR.z;
  const rF = spec.wheel.radius;

  // A bicycle is a two-wheeler and shares the lean, the single-track axles and
  // the rider pose — but NOT the bodywork. Its own builder, below.
  if (s.pedal) return buildPedalChassis(spec, lod, out, lamp);

  // frame spine + tank + seat
  const tank = roundedBox(0.34, 0.30, 0.66, 0.13, 3);
  transform(tank, { pos: [0, s.tankY - 0.02, s.tankZ] });
  out.paint.push(tank);

  const seat = roundedBox(0.28, 0.13, 0.62, 0.07, 2);
  transform(seat, { pos: [0, s.seatY, s.tankZ - 0.6], rot: [-0.05, 0, 0] });
  out.trim.push(seat);

  const tailUnit = roundedBox(0.22, 0.16, 0.4, 0.07, 2);
  transform(tailUnit, { pos: [0, s.seatY + 0.06, s.tankZ - 0.98], rot: [0.22, 0, 0] });
  out.paint.push(tailUnit);

  // engine block
  const eng = roundedBox(0.36, 0.34, 0.34, 0.05, 2);
  transform(eng, { pos: [0, s.groundY + 0.36, s.tankZ - 0.1] });
  out.trim.push(eng);
  for (let i = 0; i < 5; i++) {
    const fin = roundedBox(0.4, 0.014, 0.3, 0.005, 1);
    transform(fin, { pos: [0, s.groundY + 0.30 + i * 0.05, s.tankZ - 0.06] });
    out.chrome.push(fin);
  }

  // fork legs
  const rake = s.forkRake;
  for (const side of [-1, 1]) {
    const top = new THREE.Vector3(side * 0.16, s.barY - 0.06, s.barZ - 0.06);
    const bottom = new THREE.Vector3(side * 0.16, rF + spec.style.groundY - 0.08, zF);
    out.chrome.push(tubeBetween(top, bottom, 0.028, 10));
    out.trim.push(
      tubeBetween(
        new THREE.Vector3(side * 0.16, (top.y + bottom.y) * 0.5, (top.z + bottom.z) * 0.5),
        bottom,
        0.036,
        10
      )
    );
  }
  // triple clamp + bars
  const clamp = roundedBox(0.4, 0.05, 0.14, 0.02, 1);
  transform(clamp, { pos: [0, s.barY - 0.04, s.barZ - 0.04] });
  out.trim.push(clamp);
  for (const side of [-1, 1]) {
    out.chrome.push(
      tubeBetween(
        new THREE.Vector3(side * 0.08, s.barY, s.barZ - 0.05),
        new THREE.Vector3(side * s.barW, s.barY + 0.02, s.barZ - 0.14),
        0.016,
        8
      )
    );
    const grip = new THREE.CylinderGeometry(0.023, 0.023, 0.12, 10);
    transform(grip, { pos: [side * (s.barW - 0.05), s.barY + 0.018, s.barZ - 0.12], rot: [0, 0, Math.PI / 2] });
    out.trim.push(grip);
    // mirror
    out.trim.push(
      tubeBetween(
        new THREE.Vector3(side * (s.barW - 0.08), s.barY + 0.03, s.barZ - 0.13),
        new THREE.Vector3(side * (s.barW + 0.04), s.barY + 0.2, s.barZ - 0.15),
        0.011,
        6
      )
    );
    const mg = new THREE.CircleGeometry(0.055, 12);
    transform(mg, { pos: [side * (s.barW + 0.05), s.barY + 0.21, s.barZ - 0.12], rot: [0, -side * 0.3, 0] });
    out.chrome.push(mg);
  }

  // swingarm
  for (const side of [-1, 1]) {
    out.trim.push(
      tubeBetween(
        new THREE.Vector3(side * 0.13, s.groundY + 0.3, s.tankZ - 0.34),
        new THREE.Vector3(side * 0.15, rF + s.groundY - 0.08, zR),
        0.028,
        8
      )
    );
  }
  // shock
  out.chrome.push(
    tubeBetween(
      new THREE.Vector3(0, s.groundY + 0.34, s.tankZ - 0.36),
      new THREE.Vector3(0, s.seatY - 0.02, s.tankZ - 0.5),
      0.03,
      8
    )
  );

  // fairing + screen
  const fair = roundedBox(0.34, 0.32, 0.36, 0.12, 3);
  transform(fair, { pos: [0, s.barY - 0.12, s.barZ + 0.1] });
  out.paint.push(fair);
  const screen = roundedBox(0.24, 0.22, 0.02, 0.05, 2);
  transform(screen, { pos: [0, s.barY + 0.12, s.barZ + 0.02], rot: [-0.5, 0, 0] });
  out.glass.push(screen);

  // headlight / taillight
  lamp('head', transform(new THREE.SphereGeometry(0.09, 14, 10, 0, Math.PI * 2, 0, Math.PI * 0.5), {
    pos: [0, s.headlight.y - 0.05, s.barZ + 0.24], rot: [Math.PI / 2, 0, 0],
  }));
  lamp('brake', transform(roundedBox(0.14, 0.05, 0.04, 0.015, 1), {
    pos: [0, s.taillight.y, s.tankZ - 1.16],
  }));

  // exhaust
  const e = s.exhaust;
  out.chrome.push(
    tubeBetween(
      new THREE.Vector3(-0.08, s.groundY + 0.3, s.tankZ + 0.1),
      new THREE.Vector3(-e.x, e.y, s.tankZ - 0.55),
      e.r * 0.7,
      8
    )
  );
  const can = new THREE.CylinderGeometry(e.r, e.r * 1.15, 0.42, 12);
  transform(can, { pos: [-e.x, e.y, s.tankZ - 0.82], rot: [Math.PI / 2 + 0.06, 0, 0] });
  out.chrome.push(can);

  // plate
  const plate = new THREE.PlaneGeometry(0.24, 0.062);
  transform(plate, { pos: [0, s.groundY + 0.5, s.tankZ - 1.2], rot: [-0.3, Math.PI, 0] });
  out.plate.push(plate);

  return out;
}

/**
 * THE TOWPATH — a bicycle.
 *
 * Shares nothing with the Slagbolt above except the file it lives in: a bicycle
 * has no tank, no engine block, no fairing, no exhaust and no number plate, and
 * the one thing it has that a motorcycle does not — a chainring, two cranks and
 * a pair of pedals — is the single detail that makes the silhouette read as a
 * bicycle from any distance at which you can see it at all.
 *
 * Everything is TUBES, at real bicycle diameters (28-32 mm main triangle, 16 mm
 * stays, 6 mm spokes), because that is the whole visual character of the thing.
 * Wall thickness is faked by the tube radius; nothing here is hollow.
 */
function buildPedalChassis(spec, lod, out, lamp) {
  const s = spec.style;
  const zF = s.archF.z;
  const zR = s.archR.z;
  const rW = spec.wheel.radius;
  const seg = lod === 0 ? 8 : lod === 1 ? 6 : 4;
  const V = (x, y, z) => new THREE.Vector3(x, y, z);

  /**
   * The diamond frame's five joints. A bicycle IS these five points.
   *
   * Measured from the BOTTOM BRACKET (`style.bbY`) and from the hub height,
   * never from `style.groundY` — `groundY` is the collision-probe floor and is
   * set by the kerb test rather than by where any tube is (see its note in
   * `specs.js`), so hanging the frame off it would move the whole bicycle every
   * time that number was tuned.
   */
  const bbY = s.bbY ?? 0.27;
  const hubY = rW;
  const bb = V(0, bbY, zR + 0.42);                        // bottom bracket
  const seatT = V(0, s.seatY - 0.10, zR + 0.22);          // seat cluster
  const headT = V(0, s.barY - 0.10, zF - 0.10);           // head tube top
  const headB = V(0, bbY + 0.17, zF - 0.02);              // head tube bottom
  const rearH = V(0, hubY, zR);                           // rear hub
  const frontH = V(0, hubY, zF);                          // front hub

  const tube = (a, b, r) => out.paint.push(tubeBetween(a, b, r, seg));
  // Main triangle — painted, because it is the frame and the frame is the colour.
  tube(headT, seatT, 0.016);                              // top tube
  tube(headT, bb, 0.017);                                 // down tube
  tube(seatT, bb, 0.015);                                 // seat tube
  tube(headB, headT, 0.021);                              // head tube
  // Rear triangle: chainstays and seatstays, one pair each side.
  for (const side of [-1, 1]) {
    tube(bb, V(side * 0.055, rearH.y, rearH.z), 0.011);
    tube(seatT, V(side * 0.045, rearH.y, rearH.z), 0.009);
    // Fork blade.
    out.chrome.push(tubeBetween(headB, V(side * 0.05, frontH.y, frontH.z), 0.012, seg));
  }

  // Saddle and its post.
  out.chrome.push(tubeBetween(seatT, V(0, s.seatY, seatT.z - 0.02), 0.0135, seg));
  const saddle = roundedBox(0.11, 0.045, 0.26, 0.022, 2);
  transform(saddle, { pos: [0, s.seatY + 0.03, seatT.z - 0.04], rot: [-0.06, 0, 0] });
  out.trim.push(saddle);

  // Bars: a stem forward of the head tube and a flat bar across it.
  out.chrome.push(tubeBetween(headT, V(0, s.barY, s.barZ - 0.02), 0.014, seg));
  out.chrome.push(tubeBetween(
    V(-s.barW, s.barY, s.barZ - 0.02), V(s.barW, s.barY, s.barZ - 0.02), 0.011, seg));
  for (const side of [-1, 1]) {
    const grip = new THREE.CylinderGeometry(0.016, 0.016, 0.10, 8);
    transform(grip, { pos: [side * (s.barW - 0.05), s.barY, s.barZ - 0.02], rot: [0, 0, Math.PI / 2] });
    out.trim.push(grip);
    // Brake lever — small, but it is at eye height for a rider camera.
    if (lod === 0) {
      out.chrome.push(tubeBetween(
        V(side * (s.barW - 0.09), s.barY - 0.005, s.barZ - 0.01),
        V(side * (s.barW - 0.10), s.barY - 0.05, s.barZ + 0.05), 0.007, 5));
    }
  }

  /* ---- the drivetrain: what makes it a bicycle ------------------------ */
  const cr = s.chainring ?? 0.093;
  const ring = new THREE.CylinderGeometry(cr, cr, 0.004, lod === 0 ? 22 : 12);
  transform(ring, { pos: [0.055, bb.y, bb.z], rot: [0, 0, Math.PI / 2] });
  out.chrome.push(ring);
  // Cranks and pedals, 180 degrees apart, at a plausible standing-start angle.
  const crank = s.crank ?? 0.1725;
  for (const [side, ang] of [[1, 0.9], [-1, 0.9 + Math.PI]]) {
    const tip = V(side * 0.075, bb.y + Math.sin(ang) * crank, bb.z + Math.cos(ang) * crank);
    out.trim.push(tubeBetween(V(side * 0.062, bb.y, bb.z), tip, 0.011, 5));
    const pedal = roundedBox(0.075, 0.016, 0.085, 0.006, 1);
    transform(pedal, { pos: [side * 0.11, tip.y, tip.z] });
    out.trim.push(pedal);
  }
  // Rear cassette and the chain runs, top and bottom.
  const cog = new THREE.CylinderGeometry(0.052, 0.052, 0.028, lod === 0 ? 16 : 8);
  transform(cog, { pos: [0.05, rearH.y, rearH.z], rot: [0, 0, Math.PI / 2] });
  out.chrome.push(cog);
  if (lod < 2) {
    out.trim.push(tubeBetween(
      V(0.055, bb.y + cr, bb.z), V(0.05, rearH.y + 0.05, rearH.z), 0.005, 4));
    out.trim.push(tubeBetween(
      V(0.055, bb.y - cr, bb.z), V(0.05, rearH.y - 0.05, rearH.z), 0.005, 4));
  }

  /* ---- lamps: a battery light and a rear reflector -------------------- */
  lamp('head', transform(
    new THREE.SphereGeometry(s.headlight.w, 8, 6, 0, Math.PI * 2, 0, Math.PI * 0.5),
    { pos: [0, s.headlight.y, s.barZ + 0.06], rot: [Math.PI / 2, 0, 0] }
  ));
  lamp('brake', transform(roundedBox(s.taillight.w, s.taillight.h, 0.015, 0.004, 1),
    { pos: [0, s.taillight.y, seatT.z - 0.09] }));

  return out;
}
