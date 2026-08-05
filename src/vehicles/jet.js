/**
 * THE TALON — a military fighter jet: the airframe only.
 *
 * The FLIGHT MODEL is `plane.js` unchanged — `kind: 'plane'`, stepped by
 * `stepPlane`, landing on `makePlaneGear`'s tricycle — with hot numbers in the
 * spec (`specs.js` `jet`): ~12x the sportplane's static thrust, a wing loaded
 * so heavily it will not unstick below ~85 m/s (the reason it lives on the
 * long runways and nowhere else), violent roll authority, and an AFTERBURNER
 * block `stepPlane` reads: hold SHIFT past the firewalled lever and
 * `v.afterburner` winds to 1, buying `flight.afterburner.thrust` of reheat
 * with its own, higher speed falloff. `flightprobe.mjs` gates every one of
 * those on the emitted motion, with negative controls.
 *
 * This file is the SILHOUETTE: a long pointed fuselage, a cropped-delta wing
 * swept hard, TWIN canted tails, side intakes, a closed bubble canopy, an
 * afterburner nozzle with a dark annular interior, and roundels on both
 * wings. Military grey (`milair` pool). Everything is sized off `spec.style`
 * so the probe's silhouette checks can mutate one number and watch the
 * detector notice (rule 12's negative-control discipline).
 */

import * as THREE from 'three';
import { roundedBox, transform, tubeBetween, mergeAll } from './geom.js';

/** Per-LOD segment budgets. */
const SEG = [
  { ring: 14, tube: 10 },
  { ring: 10, tube: 8 },
  { ring: 6, tube: 6 },
  { ring: 4, tube: 4 },
];

/**
 * The airframe. Same material-group shape as `buildPlaneBody`; `rotors` stays
 * empty (there is no propeller — thrust is the nozzle's job and the flame is
 * `fx`'s, off the published `v.afterburner`).
 */
export function buildJetBody(spec, lod = 0) {
  const s = spec.style;
  const seg = SEG[Math.min(SEG.length - 1, lod)];
  const out = {
    paint: [], trim: [], chrome: [], cavity: [], glass: [],
    lamps: {}, plate: [], disc: [], doors: [], rotors: [], anchors: {},
  };
  const lamp = (k, g) => (out.lamps[k] = out.lamps[k] ?? []).push(g);
  const fy = s.fuseY;

  /* ---- fuselage: a drawn-out ellipsoid, pinched hard toward the nose --- */
  const fuseL = s.fuseZ1 - s.fuseZ0;
  const pod = new THREE.SphereGeometry(1, seg.ring, Math.max(4, seg.ring >> 1));
  {
    const p = pod.attributes.position;
    for (let i = 0; i < p.count; i++) {
      const x = p.getX(i), y = p.getY(i), z = p.getZ(i);
      const fore = Math.max(0, z);              // toward the nose cone
      const aft = Math.max(0, -z);              // toward the nozzle
      p.setXYZ(i,
        x * s.fuseR * (1 - fore * 0.34) * (1 - aft * 0.18),
        y * s.fuseR * 0.92 * (1 - fore * 0.4) * (1 - aft * 0.22),
        z * fuseL * 0.5);
    }
    pod.computeVertexNormals();
  }
  transform(pod, { pos: [0, fy, (s.fuseZ0 + s.fuseZ1) * 0.5] });
  out.paint.push(pod);

  // Nose cone running out to `noseZ` — the radar point the silhouette needs.
  const nose = new THREE.ConeGeometry(s.fuseR * 0.66, s.noseZ - s.fuseZ1 + 0.6, seg.ring);
  transform(nose, { pos: [0, fy + 0.04, s.fuseZ1 + (s.noseZ - s.fuseZ1) * 0.5 - 0.28], rot: [Math.PI * 0.5, 0, 0] });
  out.paint.push(nose);

  /* ---- canopy: closed bubble, well forward ----------------------------- */
  if (lod < 3) {
    const cabL = s.cabinZ1 - s.cabinZ0;
    const bubble = new THREE.SphereGeometry(1, seg.ring, Math.max(5, seg.ring >> 1));
    const bp = bubble.attributes.position;
    for (let i = 0; i < bp.count; i++) {
      bp.setXYZ(i, bp.getX(i) * s.fuseR * 0.62,
        bp.getY(i) * (s.cabinY1 - s.cabinY0) * 0.66,
        bp.getZ(i) * cabL * 0.5);
    }
    bubble.computeVertexNormals();
    transform(bubble, { pos: [0, (s.cabinY0 + s.cabinY1) * 0.5 + 0.12, (s.cabinZ0 + s.cabinZ1) * 0.5] });
    out.glass.push(bubble);
  }

  /* ---- cockpit floor and seat ------------------------------------------ */
  if (lod < 2) {
    const floor = roundedBox(s.fuseR * 1.1, 0.05, (s.cabinZ1 - s.cabinZ0) * 0.9, 0.02, 1);
    transform(floor, { pos: [0, s.floorY, (s.cabinZ0 + s.cabinZ1) * 0.5] });
    out.cavity.push(floor);
    const pan = roundedBox(0.46, 0.10, 0.5, 0.05, 2);
    transform(pan, { pos: [0, s.floorY + 0.18, s.cabinZ0 + 0.7] });
    out.trim.push(pan);
    const back = roundedBox(0.46, 0.6, 0.1, 0.04, 2);
    transform(back, { pos: [0, s.floorY + 0.46, s.cabinZ0 + 0.4], rot: [-0.24, 0, 0] });
    out.trim.push(back);
  }

  /* ---- the delta wing --------------------------------------------------- */
  // Cropped delta: root chord nearly a third of the aircraft, swept hard, a
  // stub of a tip. `taper` and `sweep` are what make it read fighter rather
  // than club racer, and the probe's silhouette check measures the sweep off
  // the emitted leading edge.
  const wing = deltaPanel(s.wingSpan, s.wingChord, s.wingThick, 0.78, s.wingSweep ?? 0.55);
  transform(wing, { pos: [0, s.wingY, s.wingZ] });
  out.paint.push(wing);

  // Wingtip nav lamps: red to port, green to starboard.
  const halfSpan = s.wingSpan * 0.5;
  lamp('policeRed', transform(new THREE.SphereGeometry(0.07, 8, 6),
    { pos: [-halfSpan + 0.06, s.wingY + 0.02, s.wingZ - s.wingChord * 0.42] }));
  lamp('drl', transform(new THREE.SphereGeometry(0.07, 8, 6),
    { pos: [halfSpan - 0.06, s.wingY + 0.02, s.wingZ - s.wingChord * 0.42] }));

  /* ---- roundels ---------------------------------------------------------- */
  // Low-key military roundels on both wings' upper surface: a dark outer ring
  // (cavity) with a bright inner disc (chrome). Procedural two-tone without a
  // livery texture, visible from the flyby camera.
  if (lod < 2 && s.roundel) {
    for (const side of [-1, 1]) {
      const y = s.wingY + s.wingThick * 0.5 + 0.012;
      const ring = new THREE.CylinderGeometry(s.roundel.r, s.roundel.r, 0.014, 18);
      transform(ring, { pos: [side * s.roundel.x, y, s.roundel.z] });
      out.cavity.push(ring);
      const core = new THREE.CylinderGeometry(s.roundel.r * 0.55, s.roundel.r * 0.55, 0.02, 14);
      transform(core, { pos: [side * s.roundel.x, y + 0.004, s.roundel.z] });
      out.chrome.push(core);
    }
  }

  /* ---- twin tails, canted outward --------------------------------------- */
  for (const side of [-1, 1]) {
    const fin = roundedBox(0.07, s.finY1 - s.finY0, s.finChord, 0.03, 2);
    transform(fin, {
      pos: [side * s.finX, (s.finY0 + s.finY1) * 0.5, s.finZ],
      rot: [0.62, 0, -side * (s.finCant ?? 0.3)],
    });
    out.paint.push(fin);
  }
  lamp('brake', transform(new THREE.SphereGeometry(0.06, 8, 6),
    { pos: [0, s.finY1 - 0.25, s.finZ - s.finChord * 0.35] }));

  // All-moving slab stabilators, low and aft.
  const stab = deltaPanel(s.stabSpan, s.stabChord, 0.09, 0.6, 0.5);
  transform(stab, { pos: [0, fy - 0.12, s.stabZ] });
  out.paint.push(stab);

  /* ---- intakes ----------------------------------------------------------- */
  if (lod < 3 && s.intake) {
    for (const side of [-1, 1]) {
      const duct = roundedBox(0.5, 0.62, 2.4, 0.1, 2);
      transform(duct, { pos: [side * s.intake.x, fy - 0.18, s.intake.z] });
      out.paint.push(duct);
      const mouth = roundedBox(0.4, 0.5, 0.1, 0.06, 1);
      transform(mouth, { pos: [side * s.intake.x, fy - 0.18, s.intake.z + 1.2] });
      out.cavity.push(mouth);
    }
  }

  /* ---- afterburner nozzle ------------------------------------------------ */
  {
    const n = s.nozzle;   // { z, r, len }
    const can = new THREE.CylinderGeometry(n.r, n.r * 0.86, n.len, seg.ring, 1, true);
    transform(can, { pos: [0, fy, n.z - n.len * 0.5], rot: [Math.PI * 0.5, 0, 0] });
    out.trim.push(can);
    // The dark annular interior — the hole the reheat lives in.
    const iris = new THREE.CylinderGeometry(n.r * 0.8, n.r * 0.66, n.len * 0.9, seg.ring);
    transform(iris, { pos: [0, fy, n.z - n.len * 0.45], rot: [Math.PI * 0.5, 0, 0] });
    out.cavity.push(iris);
  }

  /* ---- landing gear (tricycle) ------------------------------------------- */
  const gw = s.gearWheelR;
  const gearAt = (x, z) => {
    out.trim.push(tubeBetween(
      new THREE.Vector3(x * 0.4, fy - s.fuseR * 0.5, z),
      new THREE.Vector3(x, s.gearY + gw, z), 0.06, Math.max(4, seg.tube >> 1)));
    const tyre = new THREE.CylinderGeometry(gw, gw, 0.17, Math.max(8, seg.tube + 2));
    transform(tyre, { pos: [x, s.gearY + gw, z], rot: [0, 0, Math.PI * 0.5] });
    out.trim.push(tyre);
  };
  gearAt(0, s.gearNoseZ);
  gearAt(-s.gearX, s.gearMainZ);
  gearAt(s.gearX, s.gearMainZ);

  // Landing light in the nose gear bay.
  lamp('head', transform(
    new THREE.SphereGeometry(s.headlight.w, 10, 7, 0, Math.PI * 2, 0, Math.PI * 0.5),
    { pos: [0, s.headlight.y, s.gearNoseZ + 0.3], rot: [Math.PI * 0.5, 0, 0] }));

  out.anchors = { floorY: s.floorY };
  out.surface = null;
  return out;
}

/**
 * A cropped-delta panel: root chord tapering hard to a stub tip, the leading
 * edge swept back by `sweep` (fraction of root chord per unit span).
 */
function deltaPanel(span, chord, thick, taper, sweep) {
  const g = roundedBox(span, thick, chord, thick * 0.4, 1);
  const p = g.attributes.position;
  const half = span * 0.5;
  for (let i = 0; i < p.count; i++) {
    const t = Math.min(1, Math.abs(p.getX(i)) / half);
    p.setZ(i, p.getZ(i) * (1 - t * taper) - t * chord * sweep);
  }
  g.computeVertexNormals();
  return g;
}
