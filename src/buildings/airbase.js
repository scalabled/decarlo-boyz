import * as THREE from 'three';
import { plainBox, chamferBox, cylinderY, trs } from './geom.js';

/**
 * BUILDINGS — Ridgeline AFB structures: barrel-vault hangars (doors CLOSED —
 * set dressing with full collision), a control tower, a geodesic radar dome
 * on a plinth, a fuel farm inside a bund wall, half-sunk concrete bunkers,
 * gatehouses with raised barriers, apron floodlights, warning signs, and the
 * PERIMETER FENCE — which, unlike the civilian airfield fence, carries a
 * collision wall: a military perimeter that a capsule can stroll through is
 * scenery, and `basesweep` walks the polygon to prove this one is not.
 *
 * WHERE THE BASE IS IS NOT THIS FILE'S DECISION — the same contract as
 * `airfield.js` / `landmarks.js`. `world` grades the bench, paves the decks
 * and publishes the whole site on `world.airbase`:
 *
 *   ab.x, ab.z, ab.yaw, ab.runway    the authored numbers (plan.js)
 *   ab.pad                           the bench plane { yMid, slope }
 *   ab.layout                        every rect + the fence polygon + gates,
 *                                    field-local (a along runway, d across;
 *                                    NEGATIVE d is the city side)
 *   ab.padYAt(a) / ab.localAt(x,z)   bench arithmetic, published helpers
 *
 * This file reads those and never re-derives them. Every placement is
 * checked against the emitted road graph (the base road runs through the
 * main gate to the apron) and slid along the field until clear.
 */

const _m = new THREE.Matrix4();
const _m2 = new THREE.Matrix4();

let _bx = null;
function sharedBox() {
  return _bx ?? (_bx = plainBox());
}
let _cbx = null;
function sharedChamfer() {
  return _cbx ?? (_cbx = chamferBox(1, 1, 1, 0.02));
}

/**
 * Build the airbase structures into a TileBuilder.
 *
 * @param {TileBuilder} T
 * @param {ProtoLibrary} lib
 * @param {object} ab        `world.airbase` carrying pad + layout
 * @param {Rng} rng          deterministic fork
 * @param {function} groundAt (x, z) -> the surface height (bench on-field)
 * @param {object} roads     the emitted road graph (`world.roads`)
 * @returns {object|null}    a placement report `basesweep` asserts on
 */
export function buildAirbase(T, lib, ab, rng, groundAt, roads) {
  if (!ab?.pad || !ab.layout || typeof ab.padYAt !== 'function') return null;
  const lay = ab.layout;
  const { s, c } = lay;
  const yaw = ab.yaw;

  /** Field-local -> world. */
  const pt = (d, a) => ({ x: ab.x + c * d + s * a, z: ab.z - s * d + c * a });

  /** Is a footprint of half-diagonal `r` at (d, a) clear of every road? */
  const clear = (d, a, r) => {
    const p = pt(d, a);
    const ne = roads.nearestEdge(p.x, p.z, 64);
    const e = ne.edge;
    if (!e) return true;
    const lanes = e.lanes ?? 2;
    const lw = e.laneWidth ?? 3.9;
    const half = Math.max(e.width ?? 8, lanes * lw) * 0.5;
    return ne.dist > half + 0.33 + 3.4 + r + 1.6;
  };

  /** Slide along `a` in 14 m steps until the footprint is road-clear. */
  const settle = (d, a0, r) => {
    for (let k = 0; k < 9; k++) {
      const a = a0 + (k % 2 ? -1 : 1) * Math.ceil(k / 2) * 14;
      if (clear(d, a, r)) return a;
    }
    return null;
  };

  /** A box in field frame: centre (d, yC, a), size (sd across, sy, sa along). */
  const B = (key, d, yC, a, sd, sy, sa, masks = null, geo = null) => {
    const p = pt(d, a);
    trs(_m, p.x, yC, p.z, yaw, sd, sy, sa);
    T.add(key, geo ?? sharedBox(), _m, masks ? { masks } : null);
  };
  const CB = (key, d, yC, a, sd, sy, sa, masks = null) =>
    B(key, d, yC, a, sd, sy, sa, masks, sharedChamfer());
  const COL = (surface, d, yC, a, sd, sy, sa) => {
    const p = pt(d, a);
    T.box(surface, p.x, yC, p.z, sd, sy, sa, yaw);
  };

  const report = {
    id: ab.id, hangars: [], tower: null, radar: null, tanks: [], bunkers: [],
    gatehouses: [], floodlights: [], signs: 0, fencePosts: 0, fenceGapM: 0,
    skipped: [],
  };

  /* ---- barrel-vault hangars, doors CLOSED, facing the apron ------------ */
  const hangarAt = (a0) => {
    const HW = 30; // along a
    const HD = 26; // along d
    const dc = (lay.band.d0 + lay.band.d1) / 2; // -231
    const a = settle(dc, a0, Math.hypot(HW, HD) / 2);
    if (a === null) {
      report.skipped.push(`hangar@${a0.toFixed(0)}`);
      return;
    }
    const p = pt(dc, a);
    const gy = groundAt(p.x, p.z) - 0.1;
    const wallH = 6.2;
    const crown = 12.0; // vault crest
    // Side walls under the vault spring line.
    for (const sgn of [-1, 1]) {
      CB('mil_drab', dc + sgn * (HD / 2 - 0.35), gy + wallH / 2, a, 0.7, wallH, HW, [0.5, 0.55, 0.3]);
    }
    // Gable ends: the back end solid, the apron end is the CLOSED door.
    CB('mil_drab', dc, gy + wallH / 2, a + HW / 2 - 0.35, HD, wallH, 0.7, [0.5, 0.6, 0.35]);
    const aDoor = a - HW / 2 + 0.35;
    // Door frame posts + header, then the closed leaves (slightly proud,
    // vertically ribbed by alternating leaf depths — a shut hangar door).
    for (const sgn of [-1, 1]) {
      CB('steel_dark', dc + sgn * (HD / 2 - 1.0), gy + wallH / 2, aDoor, 2.0, wallH, 0.8, [0.5, 0.45, 0.25]);
    }
    CB('mil_drab', dc, gy + wallH - 0.5, aDoor, HD, 1.0, 0.8, [0.5, 0.5, 0.3]);
    const leaves = 6;
    const leafW = (HD - 4) / leaves;
    for (let i = 0; i < leaves; i++) {
      const dL = dc - (HD - 4) / 2 + (i + 0.5) * leafW;
      B('mil_drab', dL, gy + (wallH - 0.9) / 2, aDoor - 0.28 - (i % 2) * 0.16, leafW - 0.12, wallH - 0.9, 0.2, [0.45, 0.5, 0.3]);
    }
    // Hazard chevron strip across the door base.
    B('hazard_yellow', dc, gy + 0.5, aDoor - 0.5, HD - 4, 0.5, 0.1, [0.3, 0.2, 0.1]);
    // The VAULT: segmented barrel — chord slabs around the arch profile.
    const R = HD / 2 + 0.4;
    const rise = crown - wallH;
    const NSEG = 7;
    for (let i = 0; i < NSEG; i++) {
      const t0 = (i / NSEG) * Math.PI;
      const t1 = ((i + 1) / NSEG) * Math.PI;
      const x0 = Math.cos(t0) * R;
      const y0 = Math.sin(t0) * rise;
      const x1 = Math.cos(t1) * R;
      const y1 = Math.sin(t1) * rise;
      const mx = (x0 + x1) / 2;
      const my = (y0 + y1) / 2;
      const segLen = Math.hypot(x1 - x0, y1 - y0) + 0.25;
      const tilt = Math.atan2(y1 - y0, x1 - x0);
      const q = pt(dc + mx, a);
      _m.makeTranslation(q.x, gy + wallH + my, q.z)
        .multiply(_m2.makeRotationY(yaw))
        .multiply(new THREE.Matrix4().makeRotationZ(tilt))
        .multiply(new THREE.Matrix4().makeScale(segLen, 0.26, HW + 1.2));
      T.add('roof_metal', sharedBox(), _m, { masks: [0.45, 0.5, 0.25] });
    }

    // COLLISION: both side walls, back wall, the CLOSED door (a wall), and a
    // crown box so nothing flies through the vault.
    for (const sgn of [-1, 1]) COL('metal', dc + sgn * (HD / 2 - 0.35), gy + wallH / 2, a, 1.0, wallH + 1.5, HW);
    COL('metal', dc, gy + wallH / 2, a + HW / 2 - 0.35, HD, wallH + 2.5, 1.0);
    COL('metal', dc, gy + wallH / 2, aDoor, HD, wallH + 1.2, 1.2);
    COL('metal', dc, gy + wallH + rise / 2, a, HD * 0.6, rise + 0.6, HW * 0.9);
    report.hangars.push({ x: p.x, z: p.z, a, d: dc, w: HW, depth: HD, h: crown, gy });
  };
  hangarAt(110);
  hangarAt(215);
  hangarAt(470);
  hangarAt(575);

  /* ---- control tower ---------------------------------------------------- */
  {
    const dc = lay.band.d0 + 16;
    const a = settle(dc, 392, 7);
    if (a === null) {
      report.skipped.push('tower');
    } else {
      const p = pt(dc, a);
      const gy = groundAt(p.x, p.z) - 0.1;
      const H = 17.5;
      CB('mil_concrete', dc, gy + H / 2, a, 6.4, H, 6.4, [0.45, 0.5, 0.3]);
      // Cab: glass ring over a service floor, wider than the shaft.
      CB('mil_concrete', dc, gy + H + 0.5, a, 8.2, 1.0, 8.2, [0.5, 0.45, 0.25]);
      B('glass_plain', dc, gy + H + 2.3, a, 7.8, 2.4, 7.8, [0, 0.2, 0]);
      B('room_lit_cool', dc, gy + H + 2.3, a, 6.6, 2.2, 6.6, [0, 0.1, 0.4]);
      CB('alu_dark', dc, gy + H + 3.8, a, 8.6, 0.5, 8.6, [0.5, 0.4, 0.2]);
      // Mast + beacon.
      const mast = cylinderY(0.12, 2.6, 8);
      trs(_m, p.x, gy + H + 5.3, p.z, 0, 1, 1, 1);
      T.addOnce('steel_dark', mast, _m, { masks: [0.4, 0.25, 0.1] });
      B('neon_amber', dc, gy + H + 6.7, a, 0.5, 0.45, 0.5, [0, 0, 0]);
      // Door + hazard band at grade.
      B('steel_dark', dc - 3.25, gy + 1.15, a, 0.25, 2.3, 1.4, [0.4, 0.4, 0.2]);
      B('hazard_yellow', dc, gy + 0.35, a - 3.24, 6.2, 0.7, 0.12, [0.3, 0.2, 0.1]);
      COL('concrete', dc, gy + (H + 4) / 2, a, 6.8, H + 4, 6.8);
      report.tower = { x: p.x, z: p.z, a, d: dc, h: H + 4, gy };
    }
  }

  /* ---- radar dome: geodesic sphere on a plinth -------------------------- */
  {
    const dc = lay.band.d0 + 14;
    const a = settle(dc, 72, 9);
    if (a === null) {
      report.skipped.push('radar');
    } else {
      const p = pt(dc, a);
      const gy = groundAt(p.x, p.z) - 0.1;
      const plinthH = 5.2;
      CB('mil_concrete', dc, gy + plinthH / 2, a, 9.6, plinthH, 9.6, [0.45, 0.5, 0.3]);
      B('hazard_yellow', dc, gy + plinthH - 0.3, a - 4.83, 9.6, 0.6, 0.1, [0.3, 0.2, 0.1]);
      // The dome: icosahedron detail 1 — 80 flat facets, reads geodesic.
      const dome = new THREE.IcosahedronGeometry(1, 1);
      const pa = dome.getAttribute('position');
      dome.setAttribute('color', new THREE.Float32BufferAttribute(new Float32Array(pa.count * 3), 3));
      const R = 6.2;
      trs(_m, p.x, gy + plinthH + R * 0.62, p.z, rng.range(0, Math.PI), R, R, R);
      T.addOnce('render_grey', dome, _m, { masks: [0.35, 0.3, 0.15] });
      COL('concrete', dc, gy + plinthH / 2, a, 9.6, plinthH, 9.6);
      COL('metal', dc, gy + plinthH + R * 0.62, a, R * 1.5, R * 1.6, R * 1.5);
      report.radar = { x: p.x, z: p.z, a, d: dc, h: plinthH + R * 1.6, gy };
    }
  }

  /* ---- fuel farm inside a bund wall ------------------------------------ */
  {
    const dc = lay.band.d0 + 12;
    const a = settle(dc, 622, 12);
    if (a === null) {
      report.skipped.push('tanks');
    } else {
      const p0 = pt(dc, a);
      const gy = groundAt(p0.x, p0.z) - 0.05;
      // Bund wall: a low concrete ring, 24 x 18.
      const bw = 24;
      const bd = 18;
      for (const sgn of [-1, 1]) {
        CB('mil_concrete', dc + sgn * (bd / 2), gy + 0.6, a, 0.6, 1.2, bw, [0.5, 0.5, 0.3]);
        CB('mil_concrete', dc, gy + 0.6, a + sgn * (bw / 2), bd, 1.2, 0.6, [0.5, 0.5, 0.3]);
      }
      for (let i = 0; i < 3; i++) {
        const at = a - bw / 2 + 5 + i * 7;
        const p = pt(dc, at);
        const tg = cylinderY(2.6, 7.6, 14);
        trs(_m, p.x, gy + 3.8, p.z, 0, 1, 1, 1);
        T.addOnce('alu_bright', tg, _m, { masks: [0.55, 0.35, 0.2] });
        // Cap and hazard ring.
        const cap = cylinderY(2.62, 0.5, 14, { rTop: 1.7 });
        trs(_m, p.x, gy + 7.85, p.z, 0, 1, 1, 1);
        T.addOnce('mil_drab', cap, _m, { masks: [0.5, 0.35, 0.2] });
        COL('metal', dc, gy + 3.8, at, 5.4, 7.9, 5.4);
        report.tanks.push({ x: p.x, z: p.z, a: at, d: dc, gy });
      }
      COL('concrete', dc, gy + 0.6, a, bd + 0.6, 1.2, bw + 0.6);
    }
  }

  /* ---- bunkers: low, half-sunk, doors shut ------------------------------ */
  const bunkerAt = (a0) => {
    const dc = -82; // the west strip's south verge (fence at -100, taxi at -64)
    const a = settle(dc, a0, 10);
    if (a === null) {
      report.skipped.push(`bunker@${a0.toFixed(0)}`);
      return;
    }
    const p = pt(dc, a);
    const gy = groundAt(p.x, p.z) - 0.45; // half-sunk
    const BW = 16; // along a
    const BD = 11; // along d
    const H = 3.6;
    CB('mil_concrete', dc, gy + H / 2, a, BD, H, BW, [0.5, 0.55, 0.35]);
    // Sloped earth-cap roof: two pitched slabs, drab.
    for (const sgn of [-1, 1]) {
      const q = pt(dc + (sgn * BD) / 4, a);
      _m.makeTranslation(q.x, gy + H + 0.35, q.z)
        .multiply(_m2.makeRotationY(yaw))
        .multiply(new THREE.Matrix4().makeRotationZ(sgn * 0.24))
        .multiply(new THREE.Matrix4().makeScale(BD / 2 + 0.8, 0.3, BW + 0.8));
      T.add('mil_drab', sharedBox(), _m, { masks: [0.45, 0.5, 0.3] });
    }
    // The shut door on the taxiway face (+d), recessed, with hazard jambs.
    B('steel_dark', dc + BD / 2 - 0.1, gy + 1.35, a, 0.3, 2.7, 3.4, [0.4, 0.5, 0.3]);
    B('hazard_yellow', dc + BD / 2 + 0.02, gy + 1.35, a - 2.1, 0.12, 2.7, 0.5, [0.3, 0.2, 0.1]);
    B('hazard_yellow', dc + BD / 2 + 0.02, gy + 1.35, a + 2.1, 0.12, 2.7, 0.5, [0.3, 0.2, 0.1]);
    COL('concrete', dc, gy + (H + 0.7) / 2, a, BD + 0.5, H + 0.7, BW + 0.5);
    report.bunkers.push({ x: p.x, z: p.z, a, d: dc, w: BW, depth: BD, h: H, gy });
  };
  bunkerAt(-560);
  bunkerAt(-480);
  bunkerAt(-300);
  bunkerAt(-220);

  /* ---- gatehouses + raised barriers at both gates ----------------------- */
  for (const g of lay.gates) {
    const beside = g.a + (g.half + 5.5); // hut just east of the gap
    const dHut = g.d + (g.d < -200 ? 5 : 5); // just inside the fence line
    const a = settle(dHut, beside, 3.4);
    if (a === null) {
      report.skipped.push(`gatehouse@${g.id}`);
      continue;
    }
    const p = pt(dHut, a);
    const gy = groundAt(p.x, p.z) - 0.08;
    CB('mil_concrete', dHut, gy + 1.5, a, 3.6, 3.0, 4.2, [0.45, 0.5, 0.3]);
    B('glass_plain', dHut, gy + 2.1, a, 3.7, 1.0, 3.0, [0, 0.2, 0]);
    CB('alu_dark', dHut, gy + 3.15, a, 4.2, 0.3, 4.8, [0.5, 0.4, 0.2]);
    B('hazard_yellow', dHut, gy + 0.4, a - 2.06, 3.4, 0.8, 0.1, [0.3, 0.2, 0.1]);
    // Barrier post with the arm RAISED — the gap must stay drivable.
    const armP = pt(g.d + 2.2, g.a - g.half - 1.2);
    const post = cylinderY(0.14, 1.2, 8);
    trs(_m, armP.x, gy + 0.6, armP.z, 0, 1, 1, 1);
    T.addOnce('steel_dark', post, _m, { masks: [0.5, 0.3, 0.15] });
    const arm = cylinderY(0.07, 4.4, 8);
    trs(_m, armP.x, gy + 3.3, armP.z, 0, 1, 1, 1);
    T.addOnce('hazard_yellow', arm, _m, { masks: [0.35, 0.2, 0.1] });
    COL('concrete', dHut, gy + 1.6, a, 3.8, 3.4, 4.4);
    COL('metal', g.d + 2.2, gy + 2.4, g.a - g.half - 1.2, 0.5, 4.8, 0.5);
    report.gatehouses.push({ id: g.id, x: p.x, z: p.z, a, d: dHut, gy });
  }

  /* ---- apron floodlight masts ------------------------------------------- */
  for (const aBase of [70, 250, 430, 610]) {
    const dc = lay.apron.d0 + 3.5;
    const a = settle(dc, aBase, 1.8);
    if (a === null) continue;
    const p = pt(dc, a);
    const gy = groundAt(p.x, p.z);
    const pole = cylinderY(0.18, 12.5, 8, { rTop: 0.12 });
    trs(_m, p.x, gy + 6.25, p.z, 0, 1, 1, 1);
    T.addOnce('steel_dark', pole, _m, { masks: [0.5, 0.3, 0.15] });
    B('alu_dark', dc + 0.6, gy + 12.4, a, 1.8, 0.6, 2.8, [0.45, 0.3, 0.15]);
    for (const sgn of [-1, 1]) B('neon_amber', dc + 0.95, gy + 12.35, a + sgn * 0.7, 0.4, 0.34, 0.8, [0, 0, 0]);
    COL('metal', dc, gy + 6.25, a, 0.5, 12.5, 0.5);
    report.floodlights.push({ x: p.x, z: p.z, a, d: dc, gy });
  }

  /* ---- THE PERIMETER FENCE — collision-backed, gapped at the gates ------ */
  {
    const poly = lay.polygon;
    const gates = lay.gates;
    const postGeo = sharedBox();
    const FH = 2.6; // fence height
    const SEG = 6; // post spacing
    const inGate = (a, d) => {
      for (const g of gates) {
        if (Math.abs(d - g.d) < 2 && Math.abs(a - g.a) <= g.half) return g;
      }
      return null;
    };
    for (let i = 0; i < poly.length; i++) {
      const [a0, d0] = poly[i];
      const [a1, d1] = poly[(i + 1) % poly.length];
      const len = Math.hypot(a1 - a0, d1 - d0);
      const nP = Math.max(1, Math.round(len / SEG));
      let prev = null;
      for (let k = 0; k <= nP; k++) {
        const t = k / nP;
        const a = a0 + (a1 - a0) * t;
        const d = d0 + (d1 - d0) * t;
        const gate = inGate(a, d);
        const p = pt(d, a);
        const gy = groundAt(p.x, p.z);
        if (!gate) {
          trs(_m, p.x, gy + FH / 2, p.z, yaw, 0.1, FH, 0.1);
          T.add('steel_dark', postGeo, _m, { masks: [0.6, 0.35, 0.2] });
        }
        if (prev && !gate && !prev.gate) {
          const mx = (prev.x + p.x) / 2;
          const mz = (prev.z + p.z) / 2;
          const my = (prev.gy + gy) / 2;
          const segLen = Math.hypot(p.x - prev.x, p.z - prev.z);
          const ry = Math.atan2(p.x - prev.x, p.z - prev.z);
          const rPitch = Math.atan2(prev.gy - gy, segLen);
          const lay1 = (railY, sy, sz, key, msk) => {
            _m.makeTranslation(mx, my + railY, mz)
              .multiply(_m2.makeRotationY(ry))
              .multiply(new THREE.Matrix4().makeRotationX(rPitch))
              .multiply(new THREE.Matrix4().makeScale(sz, sy, segLen));
            T.add(key, postGeo, _m, { masks: msk });
          };
          // Top + mid rails, and the chain-mesh panel: a near-paper-thin
          // dark sheet — reads as mesh at any distance the base is seen from.
          lay1(FH - 0.06, 0.06, 0.06, 'steel_light', [0.6, 0.3, 0.15]);
          lay1(FH * 0.5, 0.05, 0.05, 'steel_light', [0.6, 0.3, 0.15]);
          lay1(FH * 0.52, FH * 0.92, 0.025, 'steel_dark', [0.25, 0.75, 0.55]);
          // Barbed outrigger stub on every other bay.
          if (k % 2 === 0) lay1(FH + 0.18, 0.05, 0.4, 'steel_light', [0.65, 0.3, 0.1]);
          // COLLISION: the wall a capsule cannot pass. The polygon's edges
          // are axis-aligned in field space, so each bay is a thin box long
          // on whichever local axis the edge runs.
          const ca = (prev.a + a) / 2;
          const cd = (prev.d + d) / 2;
          const sa = Math.max(0.35, Math.abs(a - prev.a) + 0.12);
          const sd = Math.max(0.35, Math.abs(d - prev.d) + 0.12);
          COL('metal', cd, my + FH / 2, ca, sd, FH + 1.0, sa);
          report.fencePosts++;
        } else if (prev && (gate || prev.gate)) {
          report.fenceGapM += Math.hypot(p.x - prev.x, p.z - prev.z);
        }
        prev = { x: p.x, z: p.z, gy, a, d, gate };
      }
    }
  }

  /* ---- warning signs on the fence, facing out --------------------------- */
  {
    const poly = lay.polygon;
    for (let i = 0; i < poly.length; i++) {
      const [a0, d0] = poly[i];
      const [a1, d1] = poly[(i + 1) % poly.length];
      const len = Math.hypot(a1 - a0, d1 - d0);
      const n = Math.max(1, Math.floor(len / 90));
      for (let k = 1; k <= n; k++) {
        const t = (k - 0.35) / n;
        const a = a0 + (a1 - a0) * t;
        const d = d0 + (d1 - d0) * t;
        let bad = false;
        for (const g of lay.gates) {
          if (Math.abs(d - g.d) < 3 && Math.abs(a - g.a) < g.half + 4) bad = true;
        }
        if (bad) continue;
        const p = pt(d, a);
        const gy = groundAt(p.x, p.z);
        // Board hung ALONG the fence run (its thin axis faces in/out).
        const q = pt(d + ((d1 - d0) / len) * 0.5, a + ((a1 - a0) / len) * 0.5);
        const ry = Math.atan2(q.x - p.x, q.z - p.z);
        _m.makeTranslation(p.x, gy + 1.7, p.z)
          .multiply(_m2.makeRotationY(ry))
          .multiply(new THREE.Matrix4().makeScale(0.06, 0.65, 0.95));
        T.add('hazard_yellow', sharedBox(), _m, { masks: [0.3, 0.25, 0.1] });
        report.signs++;
      }
    }
  }

  void lib;
  return report;
}
