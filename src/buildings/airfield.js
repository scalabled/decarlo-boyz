import * as THREE from 'three';
import { plainBox, chamferBox, cylinderY, trs } from './geom.js';
import { Kit } from './kit.js';

/**
 * BUILDINGS — the airfield structures: hangars, a terminal with a small
 * tower and rotating-beacon head, a windsock, a fuel tank, apron floodlights
 * and the perimeter fence.
 *
 * WHERE AN AIRFIELD IS IS NOT THIS FILE'S DECISION — same contract as
 * `landmarks.js`. `world` grades the bench, paves the runway/taxiways/apron
 * and PUBLISHES the whole site on `world.airfields[i]`:
 *
 *   af.x, af.z, af.yaw, af.runway   the authored numbers (plan.js, always)
 *   af.pad                          the graded bench plane { yMid, slope }
 *   af.layout                       every rect in field-local metres —
 *                                   runway/apron/taxis/field/band, plus the
 *                                   frame (s = sin yaw, c = cos yaw)
 *   af.padYAt(a)                    bench height at along-coordinate `a`
 *   af.localAt(x, z, out)           world -> field-local { a, d }
 *
 * This file reads those and never re-derives them (one fact, one owner —
 * the Point Fountain was 8.7 m under the Ohio the last time two subsystems
 * each decided where a landmark was). Everything is placed in field-local
 * coordinates: `a` runs along the runway (+a is the take-off run), `d`
 * across it (+d is the apron side — where `game/freeroam` parks the heli).
 *
 * ROADS. The city street grid crosses both fields (deliberately uncut — see
 * `world/airfield.js`), so every structure placement is checked against the
 * emitted road graph and slid along the field until clear; the tile-builder
 * kerb keep-out then stands behind that as belt-and-braces. Collision shells
 * are authored with every mass (`T.box`) — the mill shipped as smoke once
 * (`solidprobe` measured 10 of 14 bearings open) and no archetype repeats
 * that here. `src/world/airsweep.mjs` fires rays at the emitted shells.
 */

const _m = new THREE.Matrix4();

let _bx = null;
function sharedBox() {
  return _bx ?? (_bx = plainBox());
}
let _cbx = null;
function sharedChamfer() {
  return _cbx ?? (_cbx = chamferBox(1, 1, 1, 0.02));
}

/**
 * Build one airfield's structures into a TileBuilder.
 *
 * @param {TileBuilder} T
 * @param {ProtoLibrary} lib
 * @param {object} af        a `world.airfields` entry carrying pad + layout
 * @param {Rng} rng          deterministic, forked per airfield
 * @param {function} groundAt (x, z) -> terrain height (the bench, on-field)
 * @param {object} roads     the emitted road graph (`world.roads`)
 * @returns {object|null}    a placement report the airport gate asserts on
 */
export function buildAirfield(T, lib, af, rng, groundAt, roads) {
  if (!af?.pad || !af.layout || typeof af.padYAt !== 'function') return null;
  const lay = af.layout;
  const { L, W, s, c } = lay;
  const yaw = af.yaw;

  /** Field-local -> world. */
  const pt = (d, a) => ({ x: af.x + c * d + s * a, z: af.z - s * d + c * a });

  /** Is a footprint of half-diagonal `r` at (d, a) clear of every road? */
  const clear = (d, a, r) => {
    const p = pt(d, a);
    const ne = roads.nearestEdge(p.x, p.z, 64);
    const e = ne.edge;
    if (!e) return true;
    // Widest corridor line: carriageway + kerb + footway, plus the piece's
    // own reach and a margin WIDER than the tile-builder kerb guard's, so the
    // guard behind this can only fire if this check has already failed.
    const lanes = e.lanes ?? 2;
    const lw = e.laneWidth ?? 3.9;
    const half = Math.max(e.width ?? 8, lanes * lw) * 0.5;
    return ne.dist > half + 0.33 + 3.4 + r + 1.6;
  };

  /**
   * Find a clear along-coordinate near `a0`, sliding in 14 m steps. Returns
   * the adjusted `a`, or null if 9 tries stay blocked (reported, gated).
   */
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
    id: af.id, hangars: [], terminal: null, tower: null,
    windsock: null, tank: null, floodlights: [], fencePosts: 0, skipped: [],
  };

  /* ---- hangars: two gabled sheds, doors facing the apron -------------- */
  const skin = rng.pick(['corrugated_rust', 'corrugated', 'siding_grey']);
  const hangarAt = (a0) => {
    const HW = 26;   // along a
    const HD = 22;   // along d
    const dc = lay.band.d0 + 12;
    const a = settle(dc, a0, Math.hypot(HW, HD) / 2);
    if (a === null) {
      report.skipped.push(`hangar@${a0.toFixed(0)}`);
      return;
    }
    const p = pt(dc, a);
    const gy = groundAt(p.x, p.z) - 0.1;
    const wallH = 6.4;
    const ridgeH = 9.6;
    // Side walls (gable ends), solid.
    for (const sgn of [-1, 1]) {
      CB(skin, dc, gy + wallH / 2, a + sgn * (HW / 2 - 0.35), HD, wallH, 0.7, [0.5, 0.55, 0.3]);
      // Gable triangle, boxed coarse: two steps up to the ridge.
      CB(skin, dc, gy + wallH + 0.8, a + sgn * (HW / 2 - 0.35), HD * 0.72, 1.6, 0.66, [0.5, 0.5, 0.3]);
      CB(skin, dc, gy + wallH + 2.2, a + sgn * (HW / 2 - 0.35), HD * 0.4, 1.4, 0.62, [0.5, 0.5, 0.3]);
    }
    // Back wall (away from the apron).
    CB(skin, dc + HD / 2 - 0.35, gy + wallH / 2, a, 0.7, wallH, HW, [0.5, 0.6, 0.35]);
    // Front: header over the door opening, posts either side, door leaves
    // parked half-open, and a dark interior plane so the opening reads deep.
    const dF = dc - HD / 2 + 0.35;
    CB(skin, dF, gy + wallH - 0.7, a, 0.7, 1.4, HW, [0.5, 0.5, 0.3]);
    for (const sgn of [-1, 1]) {
      CB('steel_dark', dF, gy + wallH / 2, a + sgn * (HW / 2 - 1.1), 0.8, wallH, 2.2, [0.5, 0.45, 0.25]);
      // Sliding door leaf, parked toward its post.
      B('steel_green', dF - 0.55, gy + (wallH - 1.4) / 2, a + sgn * (HW / 2 - 5.0), 0.24, wallH - 1.4, 7.4, [0.45, 0.5, 0.3]);
    }
    B('room_dark', dc, gy + wallH * 0.45, a, 0.2, wallH * 0.9, HW - 2.5, [0, 0.1, 0.5]);
    // Gabled roof: two pitched slabs meeting on the ridge (ridge runs along a).
    const half = HD / 2 + 0.8;
    const pitch = Math.atan2(ridgeH - wallH, HD / 2);
    const slabL = Math.hypot(HD / 2, ridgeH - wallH) + 0.6;
    for (const sgn of [-1, 1]) {
      const q = pt(dc + (sgn * HD) / 4, a);
      const rm = new THREE.Matrix4()
        .makeTranslation(q.x, gy + (wallH + ridgeH) / 2 + 0.15, q.z)
        .multiply(new THREE.Matrix4().makeRotationY(yaw))
        .multiply(new THREE.Matrix4().makeRotationZ(sgn * pitch))
        .multiply(new THREE.Matrix4().makeScale(slabL, 0.24, HW + 1.6));
      T.add('roof_metal', sharedBox(), rm, { masks: [0.45, 0.5, 0.25] });
    }
    // Ridge cap and a couple of roof vents.
    B('roof_metal', dc, gy + ridgeH + 0.1, a, 1.1, 0.3, HW + 1.2, [0.5, 0.45, 0.2]);
    T.put(Kit.vent(lib, 'steel_dark', 'stack'), p.x, gy + ridgeH - 0.4, p.z, yaw, 1.2);

    // COLLISION: three walls, two door posts, both roof slabs. The door
    // opening is real — the hangar is enterable — but every wall is a wall.
    COL('metal', dc, gy + wallH / 2, a + (HW / 2 - 0.35), HD, wallH + 3.4, 0.9);
    COL('metal', dc, gy + wallH / 2, a - (HW / 2 - 0.35), HD, wallH + 3.4, 0.9);
    COL('metal', dc + HD / 2 - 0.35, gy + wallH / 2 + 1, a, 0.9, wallH + 2, HW);
    for (const sgn of [-1, 1]) COL('metal', dF, gy + wallH / 2, a + sgn * (HW / 2 - 1.1), 1.0, wallH, 2.4);
    COL('metal', dF, gy + wallH - 0.7, a, 0.9, 1.4, HW);
    report.hangars.push({ x: p.x, z: p.z, a, d: dc, w: HW, depth: HD, h: ridgeH, gy });
  };
  hangarAt(0.065 * L);
  hangarAt(0.155 * L);

  /* ---- terminal: two storeys, glass to the apron, tower + beacon ------ */
  {
    const TW = 18;  // along a
    const TD = 10;  // along d
    const dc = lay.band.d0 + 8;
    const a = settle(dc, 0.245 * L, Math.hypot(TW, TD) / 2);
    if (a === null) {
      report.skipped.push('terminal');
    } else {
      const p = pt(dc, a);
      const gy = groundAt(p.x, p.z) - 0.1;
      const H = 7.4;
      CB('brick_dark', dc, gy + H / 2, a, TD, H, TW, [0.4, 0.5, 0.3]);
      // Apron-facing glazing band on both floors, dark rooms behind.
      const dF = dc - TD / 2;
      for (const fy of [1.6, 4.9]) {
        B('glass_plain', dF - 0.06, gy + fy, a, 0.14, 2.0, TW - 2.4, [0, 0.2, 0]);
        B('room_lit_cool', dF + 0.5, gy + fy, a, 0.2, 2.0, TW - 2.8, [0, 0.1, 0.4]);
      }
      // Entrance canopy and a sign board.
      B('alu_dark', dF - 1.3, gy + 3.3, a, 2.8, 0.22, 6.5, [0.45, 0.35, 0.2]);
      B('sign_board', dF - 0.2, gy + H - 0.9, a, 0.3, 1.2, 9, [0.4, 0.4, 0.2]);
      const sp = pt(dF - 0.42, a);
      T.putS(Kit.signFace(lib, 'neon_amber'), sp.x, gy + H - 0.9, sp.z, yaw + Math.PI / 2, 8.2, 0.8, 1);
      // Parapet and roof plant.
      CB('precast', dc, gy + H + 0.25, a, TD + 0.5, 0.5, TW + 0.5, [0.5, 0.45, 0.25]);
      T.put(Kit.acRoof(lib, 'alu_dark'), p.x, gy + H + 0.4, p.z, yaw, 1.5);

      // The tower: a stair-and-cab mast on the +a end, beacon on top.
      const ta = a + TW / 2 - 2.2;
      const tp = pt(dc + 1.5, ta);
      CB('precast', dc + 1.5, gy + 5.6, ta, 4.2, 11.2, 4.2, [0.45, 0.5, 0.3]);
      B('glass_plain', dc + 1.5, gy + 12.4, ta, 4.6, 2.2, 4.6, [0, 0.2, 0]);
      B('room_lit_cool', dc + 1.5, gy + 12.4, ta, 3.6, 2.0, 3.6, [0, 0.1, 0.4]);
      CB('alu_dark', dc + 1.5, gy + 13.8, ta, 5.0, 0.5, 5.0, [0.5, 0.4, 0.2]);
      // Rotating-beacon head: a short mast and a two-faced lamp.
      const bg = cylinderY(0.14, 1.4, 8);
      trs(_m, tp.x, gy + 14.7, tp.z, 0, 1, 1, 1);
      T.addOnce('steel_dark', bg, _m, { masks: [0.4, 0.25, 0.1] });
      B('neon_amber', dc + 1.5, gy + 15.5, ta, 0.55, 0.5, 0.55, [0, 0, 0]);

      COL('concrete', dc, gy + H / 2, a, TD, H + 0.6, TW);
      COL('concrete', dc + 1.5, gy + 7.5, ta, 4.4, 15, 4.4);
      report.terminal = { x: p.x, z: p.z, a, d: dc, w: TW, depth: TD, h: H, gy };
      report.tower = { x: tp.x, z: tp.z, a: ta, d: dc + 1.5, h: 15.5, gy };
    }
  }

  /* ---- fuel tank on saddles ------------------------------------------ */
  {
    const dc = lay.band.d0 + 6;
    const a = settle(dc, 0.205 * L, 6);
    if (a === null) {
      report.skipped.push('tank');
    } else {
      const p = pt(dc, a);
      const gy = groundAt(p.x, p.z) - 0.05;
      const tg = cylinderY(1.6, 7.2, 14);
      const rm = new THREE.Matrix4()
        .makeTranslation(p.x, gy + 2.4, p.z)
        .multiply(new THREE.Matrix4().makeRotationY(yaw))
        .multiply(new THREE.Matrix4().makeRotationX(Math.PI / 2));
      T.addOnce('alu_bright', tg, rm, { masks: [0.55, 0.35, 0.2] });
      for (const sgn of [-1, 1]) CB('concrete_dark', dc, gy + 0.7, a + sgn * 2.4, 3.4, 1.4, 0.8, [0.5, 0.5, 0.3]);
      COL('metal', dc, gy + 2.4, a, 3.4, 4.4, 7.6);
      report.tank = { x: p.x, z: p.z, a, d: dc, gy };
    }
  }

  /* ---- windsock, on the apron edge ------------------------------------ */
  {
    const dc = lay.apron.d1 + 2.5;
    const a = settle(dc, 0.295 * L, 1.5);
    if (a === null) {
      report.skipped.push('windsock');
    } else {
      const p = pt(dc, a);
      const gy = groundAt(p.x, p.z);
      const pole = cylinderY(0.09, 8.4, 8);
      trs(_m, p.x, gy + 4.2, p.z, 0, 1, 1, 1);
      T.addOnce('steel_light', pole, _m, { masks: [0.5, 0.3, 0.15] });
      // The sock: an orange cone flying with the prevailing wind (down +a,
      // drooping) — built from a squashed cone lying near-horizontal.
      const sock = new THREE.ConeGeometry(0.42, 2.6, 8, 1, true);
      const sm = new THREE.Matrix4()
        .makeTranslation(p.x + s * 1.5, gy + 8.0, p.z + c * 1.5)
        .multiply(new THREE.Matrix4().makeRotationY(yaw))
        .multiply(new THREE.Matrix4().makeRotationX(Math.PI / 2 + 0.28));
      T.addOnce('trim_red', sock, sm, { masks: [0.4, 0.3, 0.1] });
      COL('metal', dc, gy + 4.2, a, 0.3, 8.4, 0.3);
      report.windsock = { x: p.x, z: p.z, a, d: dc, gy };
    }
  }

  /* ---- apron floodlight masts ----------------------------------------- */
  for (const aBase of [0.04 * L, 0.27 * L]) {
    const dc = lay.apron.d1 + 2.5;
    const a = settle(dc, aBase, 1.5);
    if (a === null) continue;
    const p = pt(dc, a);
    const gy = groundAt(p.x, p.z);
    const pole = cylinderY(0.16, 9.5, 8, { rTop: 0.11 });
    trs(_m, p.x, gy + 4.75, p.z, 0, 1, 1, 1);
    T.addOnce('steel_dark', pole, _m, { masks: [0.5, 0.3, 0.15] });
    B('alu_dark', dc - 0.5, gy + 9.4, a, 1.5, 0.55, 2.4, [0.45, 0.3, 0.15]);
    for (const sgn of [-1, 1]) B('neon_amber', dc - 0.8, gy + 9.35, a + sgn * 0.6, 0.35, 0.3, 0.7, [0, 0, 0]);
    COL('metal', dc, gy + 4.75, a, 0.45, 9.5, 0.45);
    report.floodlights.push({ x: p.x, z: p.z, a, d: dc, gy });
  }

  /* ---- perimeter fence ------------------------------------------------ */
  // Post-and-rail round the field rect, inset 2 m, skipped wherever a road
  // crosses the line (the crossings ARE the gates). Visual only: a 1.4 m
  // chain fence a car can burst through is scenery, not an invisible wall.
  {
    const f = lay.field;
    const inset = 2;
    const ring = [
      [f.d0 + inset, f.a0 + inset, f.d1 - inset, f.a0 + inset],
      [f.d1 - inset, f.a0 + inset, f.d1 - inset, f.a1 - inset],
      [f.d1 - inset, f.a1 - inset, f.d0 + inset, f.a1 - inset],
      [f.d0 + inset, f.a1 - inset, f.d0 + inset, f.a0 + inset],
    ];
    const postGeo = sharedBox();
    for (const [d0, a0, d1, a1] of ring) {
      const len = Math.hypot(d1 - d0, a1 - a0);
      const nP = Math.max(1, Math.round(len / 14));
      let prev = null;
      for (let i = 0; i <= nP; i++) {
        const t = i / nP;
        const d = d0 + (d1 - d0) * t;
        const a = a0 + (a1 - a0) * t;
        const ok = clear(d, a, 0.4);
        const p = pt(d, a);
        const gy = groundAt(p.x, p.z);
        if (ok) {
          trs(_m, p.x, gy + 0.85, p.z, yaw, 0.09, 1.7, 0.09);
          T.add('steel_dark', postGeo, _m, { masks: [0.6, 0.35, 0.2] });
        }
        if (prev && ok && prev.ok) {
          const mx = (prev.x + p.x) / 2;
          const mz = (prev.z + p.z) / 2;
          const my = (prev.gy + gy) / 2;
          const segLen = Math.hypot(p.x - prev.x, p.z - prev.z);
          const ry = Math.atan2(p.x - prev.x, p.z - prev.z);
          const rPitch = Math.atan2(prev.gy - gy, segLen);
          for (const railY of [0.62, 1.5]) {
            const rm = new THREE.Matrix4()
              .makeTranslation(mx, my + railY, mz)
              .multiply(new THREE.Matrix4().makeRotationY(ry))
              .multiply(new THREE.Matrix4().makeRotationX(rPitch))
              .multiply(new THREE.Matrix4().makeScale(0.05, 0.05, segLen));
            T.add('steel_light', sharedBox(), rm, { masks: [0.6, 0.3, 0.15] });
          }
          report.fencePosts++;
        }
        prev = { x: p.x, z: p.z, gy, ok };
      }
    }
  }

  return report;
}
