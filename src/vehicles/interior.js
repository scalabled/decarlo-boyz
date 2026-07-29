/**
 * Cabin interior.
 *
 * The chase camera looks straight through the rear screen and out through the
 * windscreen, so an empty shell is immediately obvious — it is the single
 * cheapest tell that a car is a prop. This builds the parts that actually read
 * through glass at 5-10 m: seat backs and headrests, the dash roll with a lit
 * instrument binnacle, a steering wheel, a centre console, door cards with
 * armrests, and the parcel shelf.
 */

import * as THREE from 'three';
import { roundedBox, transform, mergeAll, mirrorX, tubeBetween } from './geom.js';

/**
 * WHICH SIDE THE WHEEL IS ON. It must be the side the DRIVER is on, and Steel
 * City is Pittsburgh, so that is the car's LEFT.
 *
 * A body whose nose is local +Z has its right along -X (see the derivation over
 * `DRIVER_SIDE` in `index.js`), so the car's left is +X. This file used to put
 * the wheel, the binnacle, its hood and the column at `-hwIn * 0.46` — the
 * car's RIGHT — and `seatAnchor` put the driver there too. The two agreed, so
 * the layout looked self-consistent from the inside and was simply right-hand
 * drive in an American city.
 *
 * Keep this equal to `DRIVER_SIDE` in `index.js`; `drivetest.mjs`'s `layout`
 * section asserts that the wheel and the seat are on the same side of the car
 * and that the side is the left, both against an independently derived right
 * vector.
 */
const WHEEL_SIDE = 1;

export function buildInterior(spec, lod = 0) {
  const s = spec.style;
  const out = { seat: [], leather: [], dash: [], trim: [], chrome: [], cavity: [] };
  if (lod >= 2) return out;

  const floorY = s.groundY + Math.max(0.1, s.sillY - 0.16);
  const hip = floorY + 0.2;
  const hwIn = s.hwMax * 0.82;
  const zFront = s.cowlZ - (spec.kind === 'car' ? 0.95 : 0.6);
  const rows = spec.seats >= 4 ? 2 : 1;
  const rowZ = [zFront, zFront - 1.0];
  /**
   * The cabin of a 1.15 m wedge is not the cabin of a 2.3 m van. Size the seat
   * off the actual headroom, or the headrests come out through the roof — which
   * is exactly what they did.
   */
  const headroom = Math.max(0.42, s.roofY - hip - 0.14);
  const backH = Math.min(0.72, headroom * 0.62);
  const hrY = Math.min(s.roofY - 0.13, hip + 0.16 + backH + 0.07);
  const hrH = Math.min(0.18, Math.max(0.09, headroom * 0.2));

  // ---- floor pan ---------------------------------------------------------
  const floor = roundedBox(hwIn * 2, 0.05, Math.abs(s.cowlZ - s.backlightBaseZ) + 0.5, 0.02, 1);
  transform(floor, { pos: [0, floorY, (s.cowlZ + s.backlightBaseZ) / 2] });
  out.cavity.push(floor);

  // ---- seats -------------------------------------------------------------
  for (let r = 0; r < rows; r++) {
    const z = rowZ[r];
    if (r === 1 && spec.seats >= 4) {
      // rear bench, one piece
      out.seat.push(seatBase(hwIn * 1.5, 0.5, hip, z - 0.05));
      out.seat.push(seatBack(hwIn * 1.5, backH * 0.94, hip, z - 0.32, 0.19));
      const hr = roundedBox(0.24, hrH * 0.86, 0.11, 0.05, 2);
      transform(hr, { pos: [-hwIn * 0.45, hrY - 0.04, z - 0.36] });
      out.seat.push(hr, mirrorX(hr.clone()));
    } else {
      for (const side of [-1, 1]) {
        const x = side * hwIn * 0.46;
        out.seat.push(transform(seatBase(0.5, 0.5, hip, z), { pos: [x, 0, 0] }));
        out.seat.push(transform(seatBack(0.5, backH, hip, z - 0.27, 0.19), { pos: [x, 0, 0] }));
        const hr = roundedBox(0.24, hrH, 0.12, 0.05, 2);
        transform(hr, { pos: [x, hrY, z - 0.28 - backH * 0.16] });
        out.seat.push(hr);
        // bolsters
        for (const b of [-1, 1]) {
          const bol = roundedBox(0.075, backH * 0.74, 0.14, 0.045, 2);
          transform(bol, { pos: [x + b * 0.21, hip + 0.16 + backH * 0.42, z - 0.24], rot: [0.19, 0, -b * 0.12] });
          out.seat.push(bol);
        }
      }
    }
  }

  // ---- dash --------------------------------------------------------------
  const dashZ = s.cowlZ - 0.24;
  const dashY = s.beltY - 0.02;
  const roll = roundedBox(hwIn * 1.92, 0.24, 0.5, 0.09, 3);
  transform(roll, { pos: [0, dashY - 0.06, dashZ], rot: [0.13, 0, 0] });
  out.leather.push(roll);

  // instrument binnacle: a plane carrying the gauge texture, hooded
  const bin = new THREE.PlaneGeometry(0.44, 0.22);
  const wheelX = WHEEL_SIDE * hwIn * 0.46;
  transform(bin, { pos: [wheelX, dashY + 0.02, dashZ - 0.24], rot: [-0.34, 0, 0] });
  out.dash.push(bin);
  const hood = roundedBox(0.5, 0.1, 0.2, 0.05, 2);
  transform(hood, { pos: [wheelX, dashY + 0.11, dashZ - 0.2], rot: [0.3, 0, 0] });
  out.leather.push(hood);

  // centre stack
  const stack = roundedBox(0.32, 0.34, 0.14, 0.03, 2);
  transform(stack, { pos: [0, dashY - 0.1, dashZ - 0.22], rot: [-0.15, 0, 0] });
  out.trim.push(stack);
  const screen = new THREE.PlaneGeometry(0.22, 0.13);
  transform(screen, { pos: [0, dashY - 0.02, dashZ - 0.28], rot: [-0.15, 0, 0] });
  out.dash.push(screen);

  // ---- steering wheel ----------------------------------------------------
  const wY = dashY + 0.03;
  const wZ = dashZ - 0.36;
  const rimR = spec.mass > 3000 ? 0.24 : 0.185;
  const wheel = new THREE.TorusGeometry(rimR, 0.019, 7, lod === 0 ? 22 : 12);
  transform(wheel, { pos: [wheelX, wY, wZ], rot: [Math.PI / 2 - 0.36, 0, 0] });
  out.leather.push(wheel);
  for (let i = 0; i < 3; i++) {
    const a = Math.PI * 0.5 + (i / 3) * Math.PI * 2;
    const sp = roundedBox(0.035, rimR * 0.94, 0.016, 0.006, 1);
    transform(sp, {
      pos: [
        wheelX + Math.cos(a) * rimR * 0.5,
        wY + Math.sin(a) * rimR * 0.5 * Math.cos(0.36),
        wZ + Math.sin(a) * rimR * 0.5 * Math.sin(0.36),
      ],
      rot: [-0.36, 0, -a + Math.PI / 2],
    });
    out.trim.push(sp);
  }
  const boss = new THREE.CylinderGeometry(0.055, 0.055, 0.03, 12);
  transform(boss, { pos: [wheelX, wY, wZ], rot: [0.36 + Math.PI / 2, 0, 0] });
  out.trim.push(boss);
  const col = tubeBetween(
    new THREE.Vector3(wheelX, wY, wZ),
    new THREE.Vector3(wheelX, wY - 0.1, wZ + 0.24),
    0.03,
    8
  );
  out.trim.push(col);

  // ---- console + gear lever ---------------------------------------------
  const con = roundedBox(0.26, 0.2, 0.86, 0.05, 2);
  transform(con, { pos: [0, hip - 0.02, dashZ - 0.66] });
  out.trim.push(con);
  const lever = tubeBetween(
    new THREE.Vector3(0, hip + 0.06, dashZ - 0.46),
    new THREE.Vector3(0, hip + 0.24, dashZ - 0.5),
    0.014,
    6
  );
  out.chrome.push(lever);
  const knob = new THREE.SphereGeometry(0.036, 10, 8);
  transform(knob, { pos: [0, hip + 0.26, dashZ - 0.5] });
  out.leather.push(knob);

  // ---- door cards --------------------------------------------------------
  if (lod === 0) {
    const z0 = s.cowlZ - 0.1;
    const z1 = s.backlightBaseZ + 0.2;
    const card = roundedBox(0.05, s.beltY - hip + 0.18, Math.abs(z1 - z0), 0.02, 1);
    transform(card, { pos: [-hwIn * 0.99, (s.beltY + hip) * 0.5 - 0.02, (z0 + z1) / 2] });
    out.trim.push(card, mirrorX(card.clone()));
    const arm = roundedBox(0.07, 0.09, 0.42, 0.03, 1);
    transform(arm, { pos: [-hwIn * 0.94, hip + 0.28, dashZ - 0.5] });
    out.leather.push(arm, mirrorX(arm.clone()));
  }

  // ---- parcel shelf ------------------------------------------------------
  if (!s.boxBody && spec.kind === 'car') {
    const shelf = roundedBox(hwIn * 1.8, 0.04, 0.42, 0.02, 1);
    transform(shelf, { pos: [0, s.beltY - 0.06, s.backlightBaseZ + 0.2] });
    out.trim.push(shelf);
  }

  return out;
}

function seatBase(w, d, y, z) {
  const g = roundedBox(w, 0.16, d, 0.06, 2);
  transform(g, { pos: [0, y, z] });
  return g;
}

function seatBack(w, h, y, z, lean) {
  const g = roundedBox(w, h, 0.16, 0.06, 2);
  transform(g, { pos: [0, y + h * 0.5 + 0.04, z], rot: [lean, 0, 0] });
  return g;
}

/** Open helm for the boat: bench seats, a console and a wheel. */
export function buildBoatInterior(spec, lod = 0) {
  const s = spec.style;
  const out = { seat: [], leather: [], dash: [], trim: [], chrome: [], cavity: [] };
  if (lod >= 2) return out;
  const deck = s.deckY;

  // The helm sits with the helmsman: `seatAnchor` puts the boat driver on
  // `DRIVER_SIDE` too, and a console on the other side of the deck from the
  // seat is the same defect as a right-hand-drive car.
  const hx = WHEEL_SIDE * 0.3;
  const console_ = roundedBox(0.72, 0.62, 0.5, 0.09, 3);
  transform(console_, { pos: [hx, deck + 0.31, s.consoleZ] });
  out.trim.push(console_);
  const face = new THREE.PlaneGeometry(0.4, 0.2);
  transform(face, { pos: [hx, deck + 0.5, s.consoleZ - 0.26], rot: [-0.3, 0, 0] });
  out.dash.push(face);
  const wheel = new THREE.TorusGeometry(0.14, 0.016, 6, 16);
  transform(wheel, { pos: [hx, deck + 0.56, s.consoleZ - 0.3], rot: [Math.PI / 2 - 0.45, 0, 0] });
  out.leather.push(wheel);

  for (let i = 0; i < 2; i++) {
    const z = s.consoleZ - 0.6 - i * 0.8;
    const b = roundedBox(1.6, 0.16, 0.5, 0.05, 2);
    transform(b, { pos: [0, deck + 0.24, z] });
    out.seat.push(b);
    const back = roundedBox(1.6, 0.42, 0.14, 0.05, 2);
    transform(back, { pos: [0, deck + 0.5, z - 0.24], rot: [0.18, 0, 0] });
    out.seat.push(back);
  }
  return out;
}
