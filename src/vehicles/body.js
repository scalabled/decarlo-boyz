/**
 * Procedural car bodies.
 *
 * A body is one lofted shell (`BodySurface`) plus everything that hangs off it.
 * The greenhouse is NOT a separate object stuck on the roof: it is part of the
 * same loft, and the windows are cut out of it, so the roof, the drip rail, the
 * shoulder and the pillars all come from one continuous surface with correct
 * tumblehome and a windscreen that has the right rake by construction.
 *
 * The eleven control points of each cross-section:
 *
 *      TOP ─── ROOF_MID ── ROOF_EDGE*        * = hard, produces a highlight break
 *                              │
 *                          GLASS_MID
 *                              │
 *                            BELT*
 *                            SHOULDER*
 *                            CREASE*     <- widest point, the character line
 *                              │
 *                            LOWER
 *                            SILL*
 *                          FLOOR_EDGE
 *                            FLOOR
 */

import * as THREE from 'three';
import {
  BodySurface, loftBody, loftPatch, surfaceLine, sweep, roundedBox, quad,
  mergeAll, transform, mirrorX, tubeBetween, lathe, ribbon, polygon, groove,
} from './geom.js';

export const CP = {
  TOP: 0, ROOF_MID: 1, ROOF_EDGE: 2, GLASS_MID: 3, BELT: 4,
  SHOULDER: 5, CREASE: 6, LOWER: 7, SILL: 8, FLOOR_EDGE: 9, FLOOR: 10,
};
const NCP = 11;

/**
 * Samples per control segment, by LOD.
 *
 * A class may raise LOD0's with `style.perSeg0`. THE SECTION IS WHERE THE
 * FACETING IS, not the length: `Z_SAMPLES[0]` is 150 rings over five metres
 * (3.4 cm apart) while three samples per control segment puts only six columns
 * between the roof edge and the belt — and on a fastback that span is the sail
 * panel, which is the most curved sheet on the car and the one the eye lands on
 * from a rear three-quarter. It photographed as two flat facets meeting in a
 * fold. Nothing else in the fleet asks for it, because nothing else has a
 * quarter panel doing that much work.
 */
const PER_SEG = [3, 2, 1, 1];
const Z_SAMPLES = [150, 74, 30, 14];

export function colOf(cp, perSeg) {
  return cp * perSeg;
}

/* ------------------------------------------------------------------ */
/* Stations                                                            */
/* ------------------------------------------------------------------ */

function station(z, o) {
  const {
    hw, yTop, yBelt, yShoulder, ySill, yFloor,
    hwRoof, hwBelt, hwSill = 0.82, hwFloor = 0.5,
    crown = 0.05, creaseY, creaseOut = 1.0, hard = false,
    roofMid = 0.6, glassMid = 0.55,
  } = o;
  const cy = creaseY ?? (yShoulder + ySill) * 0.5;
  const ctrl = new Array(NCP);
  ctrl[CP.TOP] = { x: 0, y: yTop };
  ctrl[CP.ROOF_MID] = { x: hwRoof * roofMid, y: yTop - crown * 0.34 };
  ctrl[CP.ROOF_EDGE] = { x: hwRoof, y: yTop - crown, hard: true };
  ctrl[CP.GLASS_MID] = {
    x: hwRoof + (hwBelt - hwRoof) * glassMid,
    y: yTop - crown + (yBelt - (yTop - crown)) * glassMid,
  };
  ctrl[CP.BELT] = { x: hwBelt, y: yBelt, hard: true };
  ctrl[CP.SHOULDER] = { x: hw * 0.995, y: yShoulder, hard: true };
  ctrl[CP.CREASE] = { x: hw * creaseOut, y: cy, hard: true };
  ctrl[CP.LOWER] = { x: hw * 0.95, y: (cy + ySill) * 0.5 };
  ctrl[CP.SILL] = { x: hw * hwSill, y: ySill, hard: true };
  ctrl[CP.FLOOR_EDGE] = { x: hw * hwFloor, y: yFloor };
  ctrl[CP.FLOOR] = { x: 0, y: yFloor };
  return { z, ctrl, hard };
}

/**
 * ────────────────────────────────────────────────────────────────────────────
 * THE ROOF-TO-DECK LINE, AS ONE FUNCTION OF z
 * ────────────────────────────────────────────────────────────────────────────
 * The roof, the backlight and the boot lid used to be authored as three
 * INDEPENDENT station heights, and the wheel-arch stations were authored as a
 * fourth. `BodySurface` sorts its stations by z, so whether those four agreed
 * depended on where the rear axle happened to land — and on a fastback it lands
 * INSIDE the backlight run. Measured on the emitted silhouette of the Kessel
 * before this existed, walking nose to tail:
 *
 *     z -1.46  y 1.434     the roof
 *     z -1.78  y 1.030     the rear-arch station, pulled down to deck height
 *     z -1.93  y 1.182     the mid-backlight station, pulling back UP
 *     z -2.14  y 0.994     the second arch station, down again
 *     z -2.30  y 1.026     the boot
 *
 * — a 15 cm W in the one line that IS the car. That is what "a small greenhouse
 * sitting on a slab body" was: not a proportion problem, a station-ordering
 * problem. The Allegheny has the same defect at 4 mm and gets away with it.
 *
 * So the whole top line is now ONE curve sampled at whatever z a station
 * happens to want, which makes it impossible for two stations to disagree. It
 * returns the roof height, the roof half-width and the crown together, because
 * all three have to move as one or the section pinches where the line bends.
 *
 * `fastback` gets a single smootherstep from the crest to the boot: zero slope
 * at BOTH ends, so it leaves the roof and lands on the deck with no break in
 * it, which is the entire silhouette of a K5-shaped car. Every other shape gets
 * the piecewise line it already had, knot for knot.
 */
function topLine(s) {
  const zWs = s.windscreenTopZ;
  const zRR = s.roofRearZ;
  const zBk = s.backlightBaseZ;
  const zT = s.tailZ;
  const hwB = s.hwMax - s.greenhouseInset;
  const hwR = hwB - s.greenhouseTaper;
  const deckY = s.tailY + 0.03;
  const fast = s.shape === 'fastback';
  // How much flat roof there is behind the windscreen header before the sweep
  // starts. A fastback still has a crest; it just does not have a plateau.
  const zCrest = fast ? zWs - (s.roofCrest ?? 0.40) : zRR;

  /** Knots, descending z: [z, y, hwRoof, crown]. */
  const K = [[zWs, s.roofY, hwR, s.crownRoof], [zCrest, s.roofY, hwR, s.crownRoof]];
  if (fast) {
    const N = 8;
    for (let i = 1; i <= N; i++) {
      const u = i / N;
      const f = u * u * u * (u * (u * 6 - 15) + 10);
      K.push([
        zCrest + (zBk - zCrest) * u,
        s.roofY + (deckY - s.roofY) * f,
        hwR + (hwB * 0.95 - hwR) * f,
        s.crownRoof + (s.crownDeck - s.crownRoof) * f,
      ]);
    }
  } else {
    K.push([lerp(zRR, zBk, 0.55), lerp(s.roofY, s.tailY + 0.02, 0.55),
      lerp(hwR, hwB * 0.94, 0.55), lerp(s.crownRoof, s.crownDeck, 0.6)]);
    K.push([zBk, deckY, hwB * 0.95, s.crownDeck]);
  }

  // ---- the deck ---------------------------------------------------------
  // Non-fastback knots reproduce the old arch-station heights exactly, so no
  // other class moves: the sedan settled to `tailY` 0.26 m behind the backlight
  // base and that is where it still settles.
  if (fast) {
    // A ducktail is a SURFACE, not a bolt-on lip: the deck runs almost flat,
    // lifts a few centimetres at the trailing edge and drops over it.
    K.push([zT + 0.30, s.tailY + 0.018, hwB * 0.94, s.crownDeck]);
    K.push([zT + 0.10, s.tailY + (s.ducktail ?? 0.042), hwB * 0.94, s.crownDeck * 0.9]);
    K.push([zT, s.tailY + 0.006, hwB * 0.9, s.crownDeck * 0.8]);
  } else {
    K.push([Math.max(zBk - 0.26, zT + 0.20), s.tailY, hwB * 0.93, s.crownDeck]);
    K.push([zT + 0.16, s.tailY, hwB * 0.93, s.crownDeck * 0.9]);
    K.push([zT, s.tailY - 0.012, hwB * 0.9, s.crownDeck * 0.8]);
  }
  // Strictly descending, whatever the style block asks for: a knot list that
  // doubles back re-introduces exactly the notch this function exists to kill.
  for (let i = 1; i < K.length; i++) {
    if (K[i][0] >= K[i - 1][0]) K[i][0] = K[i - 1][0] - 1e-3;
  }

  return (z) => {
    let i = 0;
    while (i < K.length - 2 && z < K[i + 1][0]) i++;
    const a = K[i];
    const b = K[i + 1];
    const t = Math.max(0, Math.min(1, (a[0] - z) / Math.max(1e-6, a[0] - b[0])));
    return {
      yTop: a[1] + (b[1] - a[1]) * t,
      hwRoof: a[2] + (b[2] - a[2]) * t,
      crown: a[3] + (b[3] - a[3]) * t,
    };
  };
}

/**
 * Longitudinal shape for the five car-shaped classes. Everything is driven off
 * the style block so the silhouettes stay distinct: the wedge drops its nose
 * and raises its tail, the long-nose pushes the cowl a long way back, the van
 * and the truck run a constant-section box.
 */
function carStations(spec) {
  const s = spec.style;
  const g = s.groundY;
  const out = [];
  const box = !!s.boxBody;
  const isTruck = s.shape === 'truck';

  const roofY = s.roofY;
  const beltY = s.beltY;
  const shoulderY = s.shoulderY;
  const sillY = s.sillY;
  const hw = s.hwMax;
  const hwB = hw - s.greenhouseInset;
  const hwR = hwB - s.greenhouseTaper;

  const base = {
    hw, yTop: roofY, yBelt: beltY, yShoulder: shoulderY, ySill: sillY, yFloor: g,
    hwRoof: hwR, hwBelt: hwB, crown: s.crownRoof,
    creaseY: s.creaseY, creaseOut: 1.0,
  };

  const zNose = s.noseZ;
  const zTail = s.tailZ;
  const zCowl = s.cowlZ;
  const zWs = s.windscreenTopZ;
  const zRoofRear = s.roofRearZ;
  const zBack = s.backlightBaseZ;
  const zAF = s.archF.z;
  const zAR = s.archR.z;

  // ---- nose -------------------------------------------------------------
  // The very tip: a small, high-crowned section. Everything shrinks to it so
  // the fascia cap is a plausible shape rather than a chopped-off box.
  out.push(station(zNose, {
    ...base,
    hw: hw * s.noseHw * 0.9,
    yTop: s.noseY,
    yBelt: s.noseY - 0.02,
    yShoulder: s.noseY - 0.10,
    ySill: g + (isTruck ? 0.28 : 0.16),
    yFloor: g + (isTruck ? 0.34 : 0.2),
    hwRoof: hw * s.noseHw * 0.68,
    hwBelt: hw * s.noseHw * 0.82,
    crown: s.crownBonnet * 1.4,
    creaseY: Math.min(s.creaseY, s.noseY - 0.14),
    hard: true,
  }));
  out.push(station(zNose - (isTruck ? 0.2 : 0.13), {
    ...base,
    hw: hw * s.noseHw,
    yTop: s.noseY + 0.012,
    yBelt: s.noseY - 0.012,
    yShoulder: s.noseY - 0.09,
    ySill: g + (isTruck ? 0.2 : 0.09),
    yFloor: g + (isTruck ? 0.3 : 0.13),
    hwRoof: hw * s.noseHw * 0.74,
    hwBelt: hw * s.noseHw * 0.88,
    crown: s.crownBonnet * 1.2,
    creaseY: Math.min(s.creaseY, s.noseY - 0.12),
  }));

  // ---- front arch -------------------------------------------------------
  const archFY = mid(s.noseY, box ? s.beltY : s.beltY, 0.55);
  out.push(station(zAF + s.archF.r * 0.85, {
    ...base,
    hw: hw * 0.985 + s.archF.flare * 0.5,
    yTop: lerp(s.noseY, box ? roofY : beltY + 0.06, 0.35),
    yBelt: lerp(s.noseY - 0.02, beltY, 0.5),
    yShoulder: lerp(s.noseY - 0.09, shoulderY, 0.55),
    ySill: g + 0.06,
    yFloor: g + 0.05,
    hwRoof: hwR * 0.86,
    hwBelt: hwB * 0.95,
    crown: s.crownBonnet,
  }));
  out.push(station(zAF, {
    ...base,
    hw: hw + s.archF.flare,
    yTop: box ? roofY : lerp(s.noseY, beltY + 0.10, 0.62),
    yBelt: box ? beltY : lerp(s.noseY, beltY, 0.75),
    yShoulder: lerp(s.noseY - 0.06, shoulderY, 0.8),
    ySill: sillY * 0.82 + g * 0.18,
    yFloor: g + 0.035,
    hwRoof: box ? hwR : hwR * 0.92,
    hwBelt: hwB,
    crown: s.crownBonnet,
  }));

  // ---- cowl / base of the windscreen ------------------------------------
  out.push(station(zCowl, {
    ...base,
    hw,
    yTop: s.cowlY,
    yBelt: beltY,
    yShoulder: shoulderY,
    ySill: sillY,
    yFloor: g,
    hwRoof: hwB * 0.97,
    hwBelt: hwB,
    crown: s.crownBonnet * 0.7,
    hard: !box,
  }));

  // ---- greenhouse -------------------------------------------------------
  out.push(station(lerp(zCowl, zWs, 0.5), {
    ...base,
    yTop: lerp(s.cowlY, roofY, 0.62),
    hwRoof: lerp(hwB * 0.97, hwR, 0.68),
    crown: lerp(s.crownBonnet, s.crownRoof, 0.6),
  }));
  out.push(station(zWs, { ...base, hard: false }));

  /**
   * Everything from here to the tail cap SAMPLES `topLine`, so the roof, the
   * backlight, the boot and the two wheel-arch stations can no longer disagree
   * about how high the car is at a given z.
   *
   * `box` is left on the literal numbers it has always had. A van's lid is not
   * a line — it holds `roofY` flat over the arches and dips only at the one
   * `0.55` station — and re-deriving it from a curve would move three classes
   * for no gain. `lid()` therefore supplies the roof triple only when there is
   * a line to sample.
   */
  const top = box ? null : topLine(s);
  const lid = (z, o = {}) => station(z, box ? { ...base, ...o } : { ...base, ...top(z), ...o });
  const boxLid = { yTop: roofY, hwRoof: hwR, crown: s.crownDeck };

  // ---- backlight / deck -------------------------------------------------
  // A fastback's sweep is a CURVE, so it gets rings along it — one station at
  // each end and the loft's own interpolation in between would cut the corner
  // exactly where the line is steepest, which is where the eye is looking. A
  // three-box roof falls in a straight line and two knots describe it exactly.
  if (s.shape === 'fastback') {
    for (let i = 1; i <= 4; i++) out.push(lid(zWs + (zRoofRear - zWs) * (i / 4)));
    for (let i = 1; i <= 6; i++) out.push(lid(zRoofRear + (zBack - zRoofRear) * (i / 6)));
  } else {
    out.push(lid(lerp(zWs, zRoofRear, 0.5), { hwRoof: hwR * 1.005 }));
    out.push(lid(zRoofRear));
    out.push(station(lerp(zRoofRear, zBack, 0.55), {
      ...base,
      yTop: lerp(roofY, s.tailY + 0.02, 0.55),
      hwRoof: lerp(hwR, hwB * 0.94, 0.55),
      crown: lerp(s.crownRoof, s.crownDeck, 0.6),
    }));
    out.push(lid(zBack, box ? { ...boxLid, hard: false } : { hard: true }));
  }

  // ---- rear arch --------------------------------------------------------
  out.push(lid(zAR, {
    hw: hw + s.archR.flare,
    yBelt: beltY + (box ? 0 : 0.01),
    yShoulder: shoulderY + 0.01,
    ySill: sillY * 0.85 + g * 0.15,
    yFloor: g + 0.035,
    hwBelt: hwB + s.archR.flare * 0.3,
    ...(box ? boxLid : {}),
  }));
  out.push(lid(zAR - s.archR.r * 0.9, {
    hw: hw * 0.99 + s.archR.flare * 0.4,
    ySill: sillY * 0.9 + g * 0.1,
    yFloor: g + 0.05,
    ...(box ? { ...boxLid, hwRoof: hwR } : {}),
  }));

  // ---- tail -------------------------------------------------------------
  out.push(lid(zTail + (isTruck ? 0.24 : 0.16), {
    hw: hw * s.tailHw,
    yBelt: Math.min(beltY, s.tailY - 0.02),
    yShoulder: Math.min(shoulderY, s.tailY - 0.10),
    ySill: g + (isTruck ? 0.4 : 0.16),
    yFloor: g + (isTruck ? 0.5 : 0.2),
    hwRoof: hw * s.tailHw * 0.86,
    hwBelt: hw * s.tailHw * 0.95,
    creaseY: Math.min(s.creaseY, s.tailY - 0.16),
    ...(box ? { yTop: s.tailY, crown: s.crownDeck * 0.9 } : {}),
  }));
  out.push(lid(zTail, {
    hw: hw * s.tailHw * 0.93,
    yBelt: Math.min(beltY, s.tailY - 0.04),
    yShoulder: Math.min(shoulderY, s.tailY - 0.13),
    ySill: g + (isTruck ? 0.48 : 0.24),
    yFloor: g + (isTruck ? 0.56 : 0.28),
    hwRoof: hw * s.tailHw * 0.76,
    hwBelt: hw * s.tailHw * 0.88,
    creaseY: Math.min(s.creaseY, s.tailY - 0.18),
    hard: true,
    ...(box ? { yTop: s.tailY - 0.012, crown: s.crownDeck * 0.8 } : {}),
  }));

  /**
   * ---- the shoulder line ------------------------------------------------
   * A slab-sided car is one whose belt runs at a constant height from the cowl
   * to the tail. Lifting the belt and the shoulder towards the rear axle does
   * two things at once: it puts a rising character line down the flank, and it
   * closes the side glass to a point at the C-pillar, which is what makes a
   * fastback's DLO taper instead of ending in a square window. Applied as a
   * post-pass so no other class can be touched by it — `beltRise` defaults to
   * zero and only the Kessel authors one.
   */
  const rise = s.beltRise ?? 0;
  if (rise > 0) {
    const span = Math.max(0.25, zCowl - zAR);
    for (const st of out) {
      if (st.z > zCowl) continue;
      const t = Math.max(0, Math.min(1, (zCowl - st.z) / span));
      const d = rise * t * t * (3 - 2 * t);
      if (d <= 1e-4) continue;
      const c = st.ctrl;
      // Never far enough to swallow the glass or to cross the roof edge.
      const cap = c[CP.ROOF_EDGE].y - 0.055;
      c[CP.BELT].y = Math.max(c[CP.BELT].y, Math.min(cap, c[CP.BELT].y + d));
      c[CP.SHOULDER].y = Math.max(c[CP.SHOULDER].y, Math.min(cap - 0.02, c[CP.SHOULDER].y + d));
      c[CP.GLASS_MID].y = c[CP.ROOF_EDGE].y + (c[CP.BELT].y - c[CP.ROOF_EDGE].y) * 0.55;
    }
  }

  return out;
}

const lerp = (a, b, t) => a + (b - a) * t;
const mid = (a, b, t) => a + (b - a) * t;

/* ------------------------------------------------------------------ */
/* Body assembly                                                       */
/* ------------------------------------------------------------------ */

/**
 * @returns { paint, trim, chrome, cavity, glass, glassParts, lamps, interiorHint,
 *            plateQuads, grille, surface, perSeg }
 * Geometry lists, grouped by material. build.js turns them into meshes.
 */
export function buildCarBody(spec, lod = 0) {
  const s = spec.style;
  const perSeg = lod === 0 ? (s.perSeg0 ?? PER_SEG[0]) : PER_SEG[lod];
  const surface = new BodySurface(carStations(spec), perSeg);
  const C = (cp) => colOf(cp, perSeg);

  const out = {
    paint: [], trim: [], chrome: [], cavity: [], glass: [], lamps: {},
    plate: [], livery: [], grilleMesh: [], disc: [], surface, perSeg,
    anchors: {}, doors: [],
  };
  const lamp = (k, g) => (out.lamps[k] = out.lamps[k] ?? []).push(g);

  const zCowl = s.cowlZ;
  const zWs = s.windscreenTopZ;
  const zRoofRear = s.roofRearZ;
  const zBack = s.backlightBaseZ;
  const pillarA = s.pillarA;
  const pillarC = s.pillarC;
  const boxBody = !!s.boxBody;

  // ---- cutouts ----------------------------------------------------------
  const cuts = [
    { kind: 'arch', z: s.archF.z, y: s.archF.y ?? archY(spec), r: s.archF.r, c0: C(CP.BELT) - 0.5 },
    { kind: 'arch', z: s.archR.z, y: s.archR.y ?? archY(spec), r: s.archR.r, c0: C(CP.BELT) - 0.5 },
  ];

  const hasGlass = spec.kind === 'car';
  /**
   * Where the side glass STOPS.
   *
   * The default runs it to the base of the backlight, which is right for a
   * three-box saloon whose rear quarter window ends at the boot shut. On a
   * fastback the backlight base is most of a metre further aft and the roof has
   * fallen to within a hand's width of the belt by then, so the same expression
   * drags the DLO out into a tapering sliver of glass lying on the rear wing.
   * `sideWindowEnd` ends it at the C-pillar instead and leaves the sail panel
   * solid, which is what the shape actually has.
   */
  const sideZ0 = boxBody
    ? (s.sideWindowEnd ?? zRoofRear)
    : (s.sideWindowEnd ?? (zBack + pillarC));
  const sideZ1 = zCowl - pillarA;
  if (hasGlass) {
    // windscreen
    cuts.push({ kind: 'panel', c0: 0, c1: C(CP.ROOF_EDGE) - 0.5, z0: zWs, z1: zCowl });
    // backlight
    if (!boxBody) cuts.push({ kind: 'panel', c0: 0, c1: C(CP.ROOF_EDGE) - 0.5, z0: zBack, z1: zRoofRear });
    // side glass
    cuts.push({ kind: 'panel', c0: C(CP.ROOF_EDGE) + 0.5, c1: C(CP.BELT) - 0.5, z0: sideZ0, z1: sideZ1 });
  }

  // ---- doors that open (LOD0 only) --------------------------------------
  if (lod === 0) {
    const ds = buildDoors(spec, surface, C, sideZ1);
    if (ds) {
      cuts.push(ds.cut);
      out.doors = ds.doors;
    }
  }

  // ---- the shell --------------------------------------------------------
  const shell = loftBody(surface, {
    zSamples: Z_SAMPLES[lod],
    cuts,
    uvScale: 1.4,
  });
  out.paint.push(shell);

  // ---- glass ------------------------------------------------------------
  if (hasGlass) {
    const gz = lod >= 2 ? 5 : 12;
    out.glass.push(
      /**
       * 12 mm, not 22. A bonded modern screen sits within a centimetre of the
       * body skin; a 2.4 cm reveal turns every pillar into a proud fin and every
       * window into a gun slit, which is exactly how the greenhouse read.
       */
      loftPatch(surface, { c0: 0, c1: C(CP.ROOF_EDGE), z0: zWs, z1: zCowl, inset: 0.012, zSamples: gz })
    );
    if (!boxBody) {
      out.glass.push(
        loftPatch(surface, { c0: 0, c1: C(CP.ROOF_EDGE), z0: zBack, z1: zRoofRear, inset: 0.012, zSamples: gz })
      );
    }
    out.glass.push(
      loftPatch(surface, {
        c0: C(CP.ROOF_EDGE), c1: C(CP.BELT), z0: sideZ0, z1: sideZ1, inset: 0.014, zSamples: gz,
      })
    );
    /**
     * Headliner: the inside of the cabin, so the shell is not see-through.
     *
     * IT USED TO RUN TO `zCowl`, WHICH IS ACROSS THE WINDSCREEN. The screen is
     * a CUT in the shell, but this patch is a separate inset copy of the surface
     * with no cuts in it, so it was drawn as a solid dark sheet straight over
     * the windscreen aperture from the inside. From the driver's seat the car
     * had no windscreen at all — the `cockpit` shot came back as a black wall
     * above the steering wheel with the road nowhere in it — and `interior.js`'s
     * whole premise ("the chase camera looks straight through the windscreen and
     * an empty shell is immediately obvious") has never actually been testable.
     *
     * Stopping at the windscreen header leaves the aperture clear. The band
     * between the header and the cowl is the dash area, and `buildInterior`
     * fills it with the dash roll, the binnacle hood and the centre stack.
     */
    if (lod < 2) {
      out.cavity.push(
        loftPatch(surface, {
          c0: 0, c1: C(CP.BELT), z0: Math.min(sideZ0, zBack) - 0.05, z1: zWs + 0.02,
          inset: 0.055, zSamples: 10, flip: true,
        })
      );
    }
  }

  // ---- pillars ----------------------------------------------------------
  if (hasGlass && lod < 2) {
    out.paint.push(...pillars(surface, spec, C, { sideZ0, sideZ1 }));
  }

  // ---- wheel arches -----------------------------------------------------
  for (const [arch, front] of [[s.archF, true], [s.archR, false]]) {
    const y = arch.y ?? archY(spec);
    out.paint.push(archLip(surface, arch.z, y, arch.r, arch.flare, C(CP.CREASE), lod, s.hwMax));
    if (lod < 2) out.cavity.push(archLiner(spec, arch.z, y, arch.r, front, lod));
  }

  // ---- bumpers, fascias, lights, grille ---------------------------------
  buildFront(spec, surface, out, C, lod);
  buildRear(spec, surface, out, C, lod);

  // ---- shutlines, handles, mirrors, trim --------------------------------
  if (lod < 2) {
    buildShutlines(spec, surface, out, C);
    buildMirrors(spec, surface, out, lod);
    buildDetails(spec, surface, out, C, lod);
  }

  // Anchors other systems need.
  out.anchors.exhaust = [];
  const ex = s.exhaust;
  if (ex && ex.n) {
    for (let i = 0; i < ex.n; i++) {
      const x = ex.n === 1 ? ex.x : (i === 0 ? -ex.x : ex.x);
      out.anchors.exhaust.push(new THREE.Vector3(x, ex.y, ex.stack ? 0 : s.tailZ - 0.02));
    }
  }
  return out;
}

/**
 * Height of the wheel-arch circle centre. The body is authored with y = 0 on
 * the ground, so that is simply the wheel centre: the rolling radius.
 */
function archY(spec) {
  return spec.wheel.radius;
}

/* ------------------------------------------------------------------ */

function pillars(surface, spec, C, { sideZ0, sideZ1 }) {
  const s = spec.style;
  const outG = [];
  const mk = (z0, z1, c0, c1, w, taper = 1) => {
    const n = 8;
    const path = [];
    for (let i = 0; i < n; i++) {
      const t = i / (n - 1);
      const z = z0 + (z1 - z0) * t;
      const c = c0 + (c1 - c0) * t;
      const prof = surface.profileAt(z);
      const ci = Math.max(0, Math.min(surface.cols - 1, Math.round(c)));
      path.push(new THREE.Vector3(prof[ci].x, prof[ci].y, z));
    }
    const half = w / 2;
    const outline = [
      { x: -half, y: 0.008 }, { x: half, y: 0.008 },
      { x: half * 0.86, y: -0.05 }, { x: -half * 0.86, y: -0.05 },
    ];
    const g = sweep(outline, path, {
      closed: true, caps: true, up: new THREE.Vector3(1, 0, 0),
      scale: (t) => 1 - (1 - taper) * t,
    });
    outG.push(g, mirrorX(g.clone()));
  };

  // A-pillar: cowl corner up to the roof header.
  mk(s.cowlZ + 0.02, s.windscreenTopZ - 0.02, C(CP.BELT), C(CP.ROOF_EDGE), s.pillarA, 0.92);
  /**
   * C-pillar: roof rear down to the deck — as a RAISED BAR, which is what a
   * three-box saloon has and what a fastback specifically does not.
   *
   * A fastback's C-pillar is not a post between two panes, it is the sail
   * panel: the solid sheet left between the side glass and the backlight, and
   * the shell already emits it because both cuts stop short of it. Sweeping a
   * bar over the top of that sheet gave the Kessel a 14 cm rib standing proud
   * of its own quarter panel, and because the sweep samples the surface at a
   * column that walks from the roof edge to the belt across a run where the
   * roof is falling faster than the path does, it came out as a ribbon peeling
   * off the roof and curling over the rear seats. Do not build one.
   */
  if (!s.boxBody && s.shape !== 'fastback') {
    mk(s.roofRearZ + 0.02, s.backlightBaseZ - 0.02, C(CP.ROOF_EDGE), C(CP.BELT), s.pillarC, 1.06);
  }
  // B-pillar: vertical, at the door split.
  if (s.pillarB > 0 && s.doorSplit && s.doorSplit.length > 1) {
    const zb = s.doorSplit[1];
    mk(zb + s.pillarB * 0.5, zb - s.pillarB * 0.5, C(CP.ROOF_EDGE) + 0.4, C(CP.ROOF_EDGE) + 0.4, 0.001);
    const n = 9;
    const path = [];
    for (let i = 0; i < n; i++) {
      const t = i / (n - 1);
      const c = C(CP.ROOF_EDGE) + (C(CP.BELT) - C(CP.ROOF_EDGE)) * t;
      const prof = surface.profileAt(zb);
      const ci = Math.max(0, Math.min(surface.cols - 1, Math.round(c)));
      path.push(new THREE.Vector3(prof[ci].x, prof[ci].y, zb));
    }
    /**
     * Sweep along the section instead of along z: the B-pillar follows the
     * tumblehome, so a straight vertical bar would poke through the glass.
     *
     * THE OUTLINE IS TRANSPOSED relative to the A and C pillars, and it has to
     * be. `sweep` builds its frame as `right = up x tangent`, `nUp = tangent x
     * right`; for the A and C pillars the path runs FORE-AFT so `right` lands
     * across the section and `nUp` outward, but this path runs DOWN THE SECTION,
     * which swaps them — `right` becomes the outward normal and `nUp` becomes
     * +z. Feeding both sweeps the same outline therefore built a B-pillar whose
     * 6 cm "depth" pointed fore-aft and whose width stuck 3 cm OUT of the flank,
     * which is the proud white fin standing above the roofline in every frame
     * of every car with a B-pillar.
     */
    const half = s.pillarB / 2;
    const outline = [
      { x: 0.008, y: -half }, { x: 0.008, y: half },
      { x: -0.05, y: half * 0.8 }, { x: -0.05, y: -half * 0.8 },
    ];
    const g = sweep(outline, path, { closed: true, caps: true, up: new THREE.Vector3(0, 0, 1) });
    outG.push(g, mirrorX(g.clone()));
  }
  return outG;
}

/**
 * The arch lip — the rolled edge of the wheel opening. It also hides the ragged
 * edge left by cutting quads out of the shell.
 */
/**
 * The arch lip follows the BODY SURFACE, not a cylinder: at each angle around
 * the opening it looks up the column whose height matches, so the lip hugs the
 * flank as it tucks in towards the sill instead of floating off it.
 *
 * The sweep basis matters. The path lies in the (y,z) plane at a nearly
 * constant x, so `up` must be X — with up = Z the frame goes degenerate at the
 * top of the arch and the outline gets thrown sideways into a metre-wide flare.
 */
function archLip(surface, z, y, r, flare, colFrom, lod, hwMax) {
  const n = lod < 1 ? 26 : 13;
  const path = [];
  const a0 = -Math.PI * 0.03;
  const a1 = Math.PI * 1.03;
  // A CONSTANT x. Sampling the body's half-width per angle sounds better and is
  // catastrophically worse: the "closest column to this height" jumps between
  // neighbouring control points, the path zig-zags in x, and the swept frame
  // spins with it — the lips came out as ribbons flapping across the doors.
  const x = hwMax + flare * 0.55;
  for (let i = 0; i < n; i++) {
    const a = a0 + (a1 - a0) * (i / (n - 1));
    path.push(new THREE.Vector3(x, y + Math.sin(a) * r, z + Math.cos(a) * r));
  }
  // x = radial (out of the wheel), y = lateral (outboard).
  const outline = [
    { x: 0.012, y: 0.014 }, { x: 0.012, y: -0.052 },
    { x: -0.05, y: -0.052 }, { x: -0.05, y: 0.008 },
  ];
  const g = sweep(outline, path, { closed: true, caps: true, up: new THREE.Vector3(1, 0, 0) });
  return mergeAll([g, mirrorX(g.clone())]);
}

/* ------------------------------------------------------------------ */
/* Doors that open                                                     */
/* ------------------------------------------------------------------ */

/**
 * The front doors, as panels that can actually swing.
 *
 * `player` has always driven an enter/exit sequence that reaches for a handle
 * and pushes a door — `vehicles.setDoor(vehicle, seat, 0..1)` — and there was
 * no such method and no such geometry, so the most-used interaction in the game
 * played out with the actor walking THROUGH a solid flank.
 *
 * The door is not a slab stuck on the side. It is the piece of the body that
 * was CUT OUT for it (`kind: 'panel'` in the loft's cut list, exactly the
 * machinery that cuts the windows), re-lofted from the same `BodySurface` at
 * zero inset. So it has the flank's own curvature, crease and tumblehome by
 * construction, it fills its own aperture with no gap and nothing to z-fight,
 * and swinging it reveals the cabin rather than a hole through the car.
 *
 * Three things worth knowing:
 *
 * - It is split at the SHOULDER and CREASE columns and merged, because
 *   `loftPatch` averages normals across a patch and the shell duplicates its
 *   hard columns. One patch would have given the door a soft character line
 *   against a hard one on the wing beside it.
 * - It carries an inner card (the same surface, 6 cm inboard, wound the other
 *   way) so an open door is not a one-sided sliver and the FAR door closes the
 *   cabin off when you look in through the near one.
 * - LOD0 only. Doors matter at arm's length; the LOD1 threshold is 22 m.
 */
function buildDoors(spec, surface, C, sideZ1) {
  const s = spec.style;
  const splits = s.doorSplit ?? [];
  if (!splits.length) return null;

  // Leading edge (+z, where the hinge is) and trailing edge.
  const z1 = splits.length >= 2 ? splits[0] : sideZ1;
  let z0 = splits.length >= 2 ? splits[1] : splits[0];
  // A van or a lorry authors ONE shutline — the door runs from it to the
  // A-pillar. Anything under a stride wide is not a door.
  if (z1 - z0 < 0.8) z0 = z1 - 0.95;
  if (z1 - z0 < 0.4) return null;

  const cBelt = C(CP.BELT);
  const cSill = C(CP.SILL);
  const bands = [
    [cBelt, C(CP.SHOULDER)],
    [C(CP.SHOULDER), C(CP.CREASE)],
    [C(CP.CREASE), cSill],
  ];

  // The hinge line: on the skin at the leading edge, at shoulder height.
  const prof = surface.profileAt(z1);
  const hx = prof[Math.round(C(CP.SHOULDER))].x;
  const hy = prof[Math.round(C(CP.SHOULDER))].y;

  const doors = [];
  for (const side of [-1, 1]) {
    const parts = [];
    for (const [a, b] of bands) {
      parts.push(loftPatch(surface, { c0: a, c1: b, z0, z1, inset: 0, zSamples: 12, sides: [side] }));
    }
    // Inner card, wound inward. Inset a hair in z as well so its edge sits
    // inside the aperture rather than exactly on it.
    parts.push(loftPatch(surface, {
      c0: cBelt, c1: cSill, z0: z0 + 0.015, z1: z1 - 0.015,
      inset: 0.062, zSamples: 5, sides: [side], flip: true,
    }));
    doors.push({
      side,
      z0,
      z1,
      geo: mergeAll(parts),
      // Hinged just inboard of the skin, like a real hinge pillar.
      hinge: { x: side * hx * 0.94, y: hy, z: z1 },
    });
  }

  return {
    doors,
    cut: { kind: 'panel', c0: cBelt + 0.5, c1: cSill - 0.5, z0, z1 },
  };
}

/** Inner arch liner — the dark shell you see behind the tyre. */
function archLiner(spec, z, y, r, front, lod) {
  const seg = lod < 1 ? 16 : 9;
  const track = (front ? spec.trackF : spec.trackR) / 2;
  // Just inboard of the tyre's inner shoulder out to the arch lip.
  const inner = Math.max(0.14, track - spec.wheel.width * 0.62);
  const outer = spec.style.hwMax + 0.02;
  const pos = [];
  const idx = [];
  const a0 = -0.12;
  const a1 = Math.PI + 0.12;
  for (let i = 0; i < seg; i++) {
    const a = a0 + (a1 - a0) * (i / (seg - 1));
    const pz = z + Math.cos(a) * (r - 0.012);
    const py = y + Math.sin(a) * (r - 0.012);
    pos.push(inner, py, pz, outer, py, pz);
  }
  for (let i = 0; i < seg - 1; i++) {
    const a = i * 2, b = i * 2 + 1, c = i * 2 + 2, d = i * 2 + 3;
    idx.push(a, b, c, b, d, c);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setIndex(idx);
  g.computeVertexNormals();
  const uvs = new Float32Array(g.attributes.position.count * 2);
  g.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
  return mergeAll([g, mirrorX(g.clone())]);
}

/* ------------------------------------------------------------------ */
/* Front end                                                           */
/* ------------------------------------------------------------------ */

/**
 * Everything on a fascia is positioned as a FRACTION of that fascia's own
 * height, measured off the loft. Absolute heights do not survive contact with
 * eight bodies whose noses are between 0.6 m and 1.9 m tall: the sports car's
 * headlights ended up floating 6 cm above its own bonnet.
 */
function fasciaBand(surface, z, C) {
  const prof = surface.profileAt(z);
  const top = prof[C(CP.TOP)].y;
  const bottom = prof[C(CP.SILL)].y;
  return { top, bottom, h: Math.max(0.08, top - bottom) };
}

function buildFront(spec, surface, out, C, lod) {
  const s = spec.style;
  const zN = s.noseZ;
  const g = s.groundY;
  const hwN = s.hwMax * s.noseHw;
  const band = fasciaBand(surface, zN - 0.12, C);
  const at = (f) => band.bottom + band.h * f;
  /**
   * THE PLANE EVERYTHING ON A FASCIA HAS TO SIT ON.
   *
   * `loftBody` closes the shell with a cap at the frontmost station, so the
   * body is SOLID from z = zN backwards. Every light, grille and bezel here
   * used to be positioned at `zN - 0.04` or further back — i.e. sealed inside
   * the bodywork. Measured on the sedan: the shell reached z 2.509 while the
   * headlight lens topped out at 2.454 and the grille mesh at 2.409, so they
   * were buried 5.5 cm and 10 cm deep respectively. Every car in the game had
   * no headlights, no DRLs, no indicators and no grille — the critic's "no
   * lights, no grille" was not a shading problem, the parts were inside the
   * car. Only the plate and the bumper, which happen to be built proud of the
   * cap, were ever visible.
   *
   * `pz(off)` is the only way to place anything on this fascia: a POSITIVE
   * offset is proud of the skin.
   */
  const pz = (off) => zN + off;
  // Work vehicles keep a black plastic/steel bumper. Everything else gets a
  // body-coloured one, which is what makes a fascia read as one moulding
  // instead of a bar bolted to a slab.
  const workBumper = s.shape === 'truck' || !!s.boxBody;

  // ---- bumper: a sweep that follows the nose section --------------------
  const h = band.h * (s.shape === 'truck' ? 0.42 : 0.44);
  const bumperY = at(s.bumperF ?? 0.26);
  const path = [];
  const n = lod < 1 ? 15 : 8;
  for (let i = 0; i < n; i++) {
    const t = i / (n - 1);
    const x = (t * 2 - 1) * hwN * 1.0;
    // the fascia wraps: pull z back at the corners
    const z = zN - 0.02 - Math.pow(Math.abs(t * 2 - 1), 2.1) * (s.shape === 'truck' ? 0.22 : 0.34);
    path.push(new THREE.Vector3(x, bumperY, z));
  }
  /**
   * THE SECTION IS WHY A FASCIA READS AS ONE MOULDING OR AS A SLAB.
   *
   * This outline used to start 5 cm proud of the nose skin at its TOP edge, so
   * every car in the game had a 5 cm step running across the front where the
   * bumper met the wing — the critics' "front fascias read as separate slabs
   * rather than one moulded surface", and it is a section problem, not a
   * material one. A moulded fascia is FLUSH where it leaves the wing, swells to
   * its widest at the middle of its own height, and tucks back under. Bringing
   * the top point in to 1.2 cm does that with the same triangle count: the
   * highlight now runs off the bonnet, over the shoulder of the bumper and
   * under it in one unbroken sweep instead of breaking at a hard step.
   */
  const bump = sweep(
    [
      { x: 0.012, y: h * 0.54 }, { x: 0.040, y: h * 0.34 },
      { x: 0.060, y: h * 0.05 }, { x: 0.052, y: -h * 0.34 },
      { x: 0.018, y: -h * 0.55 },
      { x: -0.05, y: -h * 0.55 }, { x: -0.05, y: h * 0.54 },
    ],
    path,
    { closed: true, caps: true, up: new THREE.Vector3(0, 1, 0) }
  );
  (workBumper ? out.trim : out.paint).push(bump);

  // Lower valance: a dark lip under the moulding, so the bumper reads as a
  // body panel with an air dam under it rather than a floating black bar.
  const valance = sweep(
    [{ x: 0.036, y: 0.014 }, { x: 0.036, y: -0.016 }, { x: -0.04, y: -0.018 }, { x: -0.04, y: 0.014 }],
    path.map((p) => new THREE.Vector3(p.x * 0.985, bumperY - h * 0.55, p.z + 0.004)),
    { closed: true, caps: true, up: new THREE.Vector3(0, 1, 0) }
  );
  out.trim.push(valance);

  // Splitter / air dam under it.
  if (s.splitter > 0) {
    const sp = sweep(
      [{ x: 0.055, y: 0.011 }, { x: 0.055, y: -0.011 }, { x: -0.03, y: -0.013 }, { x: -0.03, y: 0.013 }],
      path.map((p) => new THREE.Vector3(p.x * 0.99, bumperY - h * 0.5 - s.splitter * 0.5, p.z - 0.01)),
      { closed: true, caps: true, up: new THREE.Vector3(0, 1, 0) }
    );
    out.trim.push(sp);
  }

  // ---- grille ------------------------------------------------------------
  const gr = s.grille;
  if (gr) {
    const gy = at(gr.yf);
    const gh = band.h * gr.hf;
    const gw = Math.min(gr.w, hwN * 1.8);
    // A RING, not a box. The frame used to be a solid `roundedBox` sitting in
    // front of the mesh, so even had it been outside the body it would have
    // covered its own grille.
    const fr = Math.min(0.03, gh * 0.22);
    const bar = (w, hgt, x, y) =>
      out.chrome.push(transform(roundedBox(w, hgt, 0.05, Math.min(0.008, hgt * 0.4), 1), { pos: [x, y, pz(0.020)] }));
    bar(gw + fr * 2, fr, 0, gy + gh * 0.5 + fr * 0.5);
    bar(gw + fr * 2, fr, 0, gy - gh * 0.5 - fr * 0.5);
    bar(fr, gh, -(gw * 0.5 + fr * 0.5), gy);
    bar(fr, gh, gw * 0.5 + fr * 0.5, gy);
    // The dark box behind the mesh gives the opening depth when you look into
    // it from an angle.
    const cav = roundedBox(gw, gh, 0.07, 0.01, 1);
    transform(cav, { pos: [0, gy, pz(-0.006)] });
    out.cavity.push(cav);
    const mesh = new THREE.PlaneGeometry(gw - 0.012, gh - 0.012);
    transform(mesh, { pos: [0, gy, pz(0.031)] });
    out.grilleMesh.push(mesh);
    if (gr.kind === 'lorry' || gr.kind === 'egg') {
      const nb = gr.kind === 'lorry' ? 5 : 3;
      for (let i = 0; i < nb; i++) {
        const y = gy - gh * 0.4 + ((i + 0.5) / nb) * gh * 0.8;
        const b = roundedBox(gw - 0.02, (gh / nb) * 0.3, 0.045, 0.006, 1);
        transform(b, { pos: [0, y, pz(0.026)] });
        out.chrome.push(b);
      }
    }
    // Lower intake, cut into the bumper face BELOW the plate. Centred on the
    // bumper it swallowed the number plate whole.
    const li = roundedBox(gw * 0.86, band.h * 0.10, 0.05, 0.016, 1);
    transform(li, { pos: [0, bumperY - h * 0.38, pz(0.030)] });
    out.cavity.push(li);
  }

  // ---- headlights --------------------------------------------------------
  const hl = s.headlight;
  if (hl) {
    const hy = at(hl.yf);
    const hh = Math.min(hl.h, band.h * 0.4);
    for (const side of [-1, 1]) {
      const x = side * (hwN - hl.inset);
      if (hl.kind === 'round2') {
        for (let i = 0; i < 2; i++) {
          const cx = side * (hwN - hl.inset) + (i === 0 ? -side * hh * 0.62 : side * hh * 0.62);
          // The lathe's own +Y becomes +Z after the quarter turn, so the bezel
          // grows FORWARD out of the fascia from where it is planted.
          out.chrome.push(transform(lathe(bezelPts(hh * 0.55), 18), { pos: [cx, hy, pz(-0.004)], rot: [Math.PI / 2, 0, 0] }));
          out.cavity.push(transform(new THREE.CircleGeometry(hh * 0.52, 18), { pos: [cx, hy, pz(0.014)] }));
          lamp('head', transform(new THREE.CircleGeometry(hh * 0.49, 18), { pos: [cx, hy, pz(0.036)] }), out);
        }
      } else {
        const w = hl.w;
        // Dark surround, then the lens recessed 6 mm inside it.
        const box = headlightShell(w, hh, hl.kind);
        transform(box, { pos: [x, hy, pz(0.006)], scale: [side, 1, 1] });
        out.cavity.push(box);
        const lensG = roundedBox(w, hh, 0.06, Math.min(0.03, hh * 0.4), 2);
        transform(lensG, { pos: [x, hy, pz(0.004)] });
        lamp('head', lensG, out);
        // DRL strip along the bottom edge — modern and instantly readable.
        if (hl.kind !== 'square') {
          const drl = roundedBox(w * 0.9, 0.024, 0.04, 0.008, 1);
          transform(drl, { pos: [x, hy - hh * 0.42, pz(0.026)] });
          lamp('drl', drl, out);
        }
        // indicator in the outer corner
        const ind = roundedBox(w * 0.26, hh * 0.42, 0.04, 0.008, 1);
        transform(ind, { pos: [x + side * w * 0.33, hy + hh * 0.14, pz(0.026)] });
        lamp('indicator', ind, out);
      }
    }
  }

  // ---- plate, recessed into the bumper face ------------------------------
  if (lod < 2) {
    const py = bumperY;
    const pz = path[Math.floor(path.length / 2)].z + 0.062;
    const pw = Math.min(0.46, hwN * 0.62);
    const ph = Math.min(0.12, h * 0.6);
    const plate = new THREE.PlaneGeometry(pw, ph);
    transform(plate, { pos: [0, py, pz + 0.004] });
    out.plate.push(plate);
    const pf = roundedBox(pw + 0.03, ph + 0.03, 0.016, 0.006, 1);
    transform(pf, { pos: [0, py, pz - 0.004] });
    out.trim.push(pf);
  }

  // ---- bonnet vents / scoop ---------------------------------------------
  if (s.bonnetScoop && lod < 2) {
    const zc = (s.cowlZ + s.archF.z) * 0.5;
    const prof = surface.profileAt(zc);
    const yTop = prof[0].y;
    const scoop = roundedBox(0.52, 0.1, 0.62, 0.05, 2);
    transform(scoop, { pos: [0, yTop + 0.03, zc] });
    out.paint.push(scoop);
    const mouth = roundedBox(0.4, 0.06, 0.1, 0.02, 1);
    transform(mouth, { pos: [0, yTop + 0.05, zc + 0.3] });
    out.cavity.push(mouth);
  }

  if (s.pushBar && lod < 2) {
    out.trim.push(pushBar(spec));
  }
}

function bezelPts(r) {
  return [
    { x: r * 0.98, y: 0 }, { x: r * 1.02, y: 0.02 }, { x: r * 1.02, y: 0.05 },
    { x: r * 0.92, y: 0.055 }, { x: r * 0.9, y: 0.01 },
  ];
}

function headlightShell(w, h, kind) {
  // Slightly larger than the lens in every direction and deeper than it, so it
  // reads as a dark surround the lens is set into.
  return roundedBox(w + 0.036, h + 0.036, 0.075, Math.min(0.03, h * 0.4), 2);
}

function lamp(kind, g, out) {
  (out.lamps[kind] = out.lamps[kind] ?? []).push(g);
}

function pushBar(spec) {
  const s = spec.style;
  const parts = [];
  const z = s.noseZ + 0.09;
  const y0 = s.groundY + 0.28;
  const y1 = s.creaseY + 0.02;
  const hw = s.hwMax * s.noseHw * 0.92;
  for (const side of [-1, 1]) {
    parts.push(tubeBetween(new THREE.Vector3(side * hw, y0, z), new THREE.Vector3(side * hw, y1, z), 0.035, 8));
    parts.push(tubeBetween(new THREE.Vector3(side * hw, y1, z), new THREE.Vector3(side * hw * 0.9, y1, z - 0.3), 0.03, 8));
    parts.push(tubeBetween(new THREE.Vector3(side * hw, y0, z), new THREE.Vector3(side * hw * 0.9, y0 - 0.06, z - 0.32), 0.03, 8));
  }
  for (let i = 0; i < 3; i++) {
    const y = y0 + ((y1 - y0) * (i + 0.5)) / 3;
    parts.push(tubeBetween(new THREE.Vector3(-hw, y, z), new THREE.Vector3(hw, y, z), 0.028, 8));
  }
  return mergeAll(parts);
}

/* ------------------------------------------------------------------ */
/* Rear end                                                            */
/* ------------------------------------------------------------------ */

function buildRear(spec, surface, out, C, lod) {
  const s = spec.style;
  const zT = s.tailZ;
  const g = s.groundY;
  const hwT = s.hwMax * s.tailHw;
  const band = fasciaBand(surface, zT + 0.14, C);
  const at = (f) => band.bottom + band.h * f;
  const h = band.h * (s.shape === 'truck' ? 0.36 : 0.32);

  // Same cap-plane rule as the front: the tail is capped at zT, so a negative
  // z offset here is OUTBOARD. Every tail, brake, indicator and reverse lamp
  // in the game was built at `zT + 0.035` — inside the bodywork.
  const pz = (off) => zT - off;
  const workBumper = s.shape === 'truck' || !!s.boxBody;

  const bumperY = at(s.bumperR ?? 0.24);
  const n = lod < 1 ? 13 : 7;
  const path = [];
  for (let i = 0; i < n; i++) {
    const t = i / (n - 1);
    const x = (t * 2 - 1) * hwT;
    const z = zT + 0.02 + Math.pow(Math.abs(t * 2 - 1), 2.1) * 0.3;
    path.push(new THREE.Vector3(x, bumperY, z));
  }
  // Same section rule as the front: flush at the top, widest in the middle of
  // its own height, tucked under at the bottom. See `buildFront`.
  (workBumper ? out.trim : out.paint).push(
    sweep(
      [
        { x: 0.012, y: h * 0.52 }, { x: 0.040, y: h * 0.30 },
        { x: 0.060, y: 0 }, { x: 0.050, y: -h * 0.36 },
        { x: 0.016, y: -h * 0.55 },
        { x: -0.05, y: -h * 0.55 }, { x: -0.05, y: h * 0.52 },
      ],
      path,
      { closed: true, caps: true, up: new THREE.Vector3(0, 1, 0) }
    )
  );
  out.trim.push(
    sweep(
      [{ x: 0.034, y: 0.014 }, { x: 0.034, y: -0.016 }, { x: -0.04, y: -0.018 }, { x: -0.04, y: 0.014 }],
      path.map((p) => new THREE.Vector3(p.x * 0.985, bumperY - h * 0.55, p.z - 0.004)),
      { closed: true, caps: true, up: new THREE.Vector3(0, 1, 0) }
    )
  );

  if (s.diffuser > 0) {
    const d = roundedBox(hwT * 1.5, s.diffuser, 0.34, 0.02, 1);
    transform(d, { pos: [0, bumperY - h * 0.5 - s.diffuser * 0.4, zT + 0.2] });
    out.trim.push(d);
    for (let i = -2; i <= 2; i++) {
      const f = roundedBox(0.022, s.diffuser * 1.1, 0.3, 0.008, 1);
      transform(f, { pos: [i * hwT * 0.3, bumperY - h * 0.5 - s.diffuser * 0.4, zT + 0.2] });
      out.trim.push(f);
    }
  }

  // ---- tail lights -------------------------------------------------------
  const tl = s.taillight;
  if (tl) {
    const zLens = pz(0.004);
    const ty = at(tl.yf);
    const th = Math.min(tl.h, band.h * 0.55);
    /**
     * FULL-WIDTH BAR. Every other kind here is a pair of pods at
     * `+/-(hwT - inset)` with bodywork between them; this one is a single thin
     * line that crosses the whole tail, which is the signature of a modern
     * fastback and the thing you recognise the car by at night.
     *
     * Built as a recessed channel spanning the full width plus four lit
     * segments: two long outer runs and two short inner ones stepped 22 mm
     * DOWN, so the line breaks and re-joins at a different height across the
     * middle. That step is the whole trick — a perfectly straight strip reads
     * as a light bar off a van, and the kink is what makes it read as a
     * deliberate signature. The break at the centre line is left dark so the
     * two halves are separate lamps rather than one continuous tube.
     *
     * The channel is `cavity`, not `trim`: unlit, a light bar has to read as a
     * dark slot across the tail. See the shutline note for why that material
     * choice is what makes a recess survive a flat overcast sky.
     */
    if (tl.kind === 'fullbar') {
      const barH = th;
      const inner = hwT * 0.12;             // half the dark centre break
      const outer = hwT - tl.inset;
      const step = barH * 0.55;             // the heartbeat kink, downward
      /**
       * THE LAMPS HAVE TO STAND PROUD OF THEIR OWN CHANNEL.
       *
       * `pz(off)` is `zT - off`, so a LARGER offset is further outboard. The
       * first version of this put the channel at `pz(0.004)` 60 mm deep and
       * every lamp at `pz(0.004)` 50 mm deep — which is the lamp entirely
       * INSIDE a closed dark box, 5 mm of unlit cavity in front of it on every
       * side. The car photographed with a flat black rectangle across its tail
       * and no tail lights at all, which is exactly what it had.
       *
       * The channel now sits back and the lenses sit 6 mm out of it, so the
       * recess reads as a recess and the line reads as a line.
       */
      const channel = roundedBox(hwT * 2 - tl.inset * 0.4, barH + 0.05, 0.05, 0.016, 2);
      transform(channel, { pos: [0, ty, pz(0.012)] });
      out.cavity.push(channel);
      const zBar = pz(tl.recess ?? 0.030);
      for (const side of [-1, 1]) {
        // Long outer run: from the shoulder in toward the middle.
        const runW = outer - hwT * 0.42;
        lamp('brake', transform(roundedBox(runW, barH * 0.62, 0.026, 0.008, 1),
          { pos: [side * (outer - runW * 0.5), ty, zBar] }), out);
        // Short inner run, stepped down — the break in the line.
        const innW = hwT * 0.42 - inner;
        lamp('tail', transform(roundedBox(innW, barH * 0.42, 0.026, 0.008, 1),
          { pos: [side * (inner + innW * 0.5), ty - step * 0.5, zBar] }), out);
        // Indicator lives in the outermost 26% of the long run, which is where
        // a wraparound bar puts it.
        lamp('indicator', transform(roundedBox(runW * 0.26, barH * 0.62, 0.026, 0.008, 1),
          { pos: [side * (outer - runW * 0.13), ty, pz(0.032)] }), out);
        lamp('reverse', transform(roundedBox(0.12, 0.05, 0.045, 0.01, 1),
          { pos: [side * hwT * 0.55, bumperY + 0.02, pz(0.03)] }), out);
      }
    } else for (const side of [-1, 1]) {
      /**
       * THE SAME BURIED-LENS BUG AS `fullbar`, AND IT WAS IN EVERY OTHER CAR IN
       * THE FLEET.
       *
       * `pz(off)` is `zT - off`, so outboard is -z. The housing was a 75 mm-deep
       * closed box centred at `pz(0.006)` — its outer face at `zT - 0.0435` —
       * and every lens was a 55-60 mm box centred at `pz(0.004)`, outer face
       * `zT - 0.034`. That is the lens sealed 9.5 mm INSIDE an unlit shell, on
       * the sports car, the muscle car, the sedan, the police car, the van, the
       * truck and the bus. `shapeprobe` measures it signed and scored 7 red
       * before this: -14.6 mm on the Peregrine, -13.7 mm on the other six.
       *
       * It is the same disease as the front fascia note in `buildFront` — parts
       * positioned relative to a cap plane with the sign of the offset guessed —
       * and it is why the tail lights read as a flat black rectangle and look
       * like a shading problem rather than a geometry one.
       *
       * The housing now sits back and the lenses stand 9 mm out of it, which is
       * what a lamp in a bezel looks like.
       */
      const x = side * (hwT - tl.inset);
      const shell = roundedBox(tl.w + 0.036, th + 0.036, 0.055, 0.018, 2);
      transform(shell, { pos: [x, ty, pz(0.002)] });
      out.cavity.push(shell);
      /**
       * How far the lens stands OUT of its bezel, metres. Authorable per class
       * because a wraparound and a deep-set cluster are different looks — but
       * it must stay positive enough to clear the housing's own face, and
       * `shapeprobe` measures the signed clearance on the emitted geometry
       * rather than trusting this number.
       */
      const zPod = pz(tl.recess ?? 0.026);

      if (tl.kind === 'vertical' || tl.kind === 'cluster') {
        const seg = th / 3;
        lamp('brake', transform(roundedBox(tl.w, seg * 0.92, 0.03, 0.008, 1), { pos: [x, ty + seg, zPod] }), out);
        lamp('tail', transform(roundedBox(tl.w, seg * 0.92, 0.03, 0.008, 1), { pos: [x, ty, zPod] }), out);
        lamp('indicator', transform(roundedBox(tl.w, seg * 0.92, 0.03, 0.008, 1), { pos: [x, ty - seg, zPod] }), out);
      } else if (tl.kind === 'segment') {
        const seg = tl.w / 3;
        lamp('indicator', transform(roundedBox(seg * 0.9, th, 0.03, 0.008, 1), { pos: [x + side * seg, ty, zPod] }), out);
        lamp('brake', transform(roundedBox(seg * 0.9, th, 0.03, 0.008, 1), { pos: [x, ty, zPod] }), out);
        lamp('tail', transform(roundedBox(seg * 0.9, th, 0.03, 0.008, 1), { pos: [x - side * seg, ty, zPod] }), out);
      } else {
        lamp('brake', transform(roundedBox(tl.w, th * 0.56, 0.03, 0.01, 1), { pos: [x, ty + th * 0.22, zPod] }), out);
        lamp('tail', transform(roundedBox(tl.w * 0.94, th * 0.3, 0.028, 0.008, 1), { pos: [x, ty - th * 0.26, zPod] }), out);
        lamp('indicator', transform(roundedBox(tl.w * 0.3, th * 0.3, 0.028, 0.008, 1), { pos: [x + side * tl.w * 0.32, ty - th * 0.26, zPod] }), out);
      }
      // reverse lamp in the bumper
      lamp('reverse', transform(roundedBox(0.12, 0.05, 0.045, 0.01, 1), { pos: [side * hwT * 0.55, bumperY + 0.02, pz(0.03)] }), out);
    }
  }

  // ---- plate + exhaust ---------------------------------------------------
  if (lod < 2) {
    const py = bumperY;
    const pz = path[Math.floor(path.length / 2)].z - 0.062;
    const pw = Math.min(0.46, hwT * 0.62);
    const ph = Math.min(0.12, h * 0.6);
    const plate = new THREE.PlaneGeometry(pw, ph);
    transform(plate, { pos: [0, py, pz - 0.004], rot: [0, Math.PI, 0] });
    out.plate.push(plate);
    const pf = roundedBox(pw + 0.03, ph + 0.03, 0.016, 0.006, 1);
    transform(pf, { pos: [0, py, pz + 0.004] });
    out.trim.push(pf);
  }

  const ex = s.exhaust;
  if (ex && ex.n && !ex.stack) {
    for (let i = 0; i < ex.n; i++) {
      const x = ex.n === 1 ? -ex.x : i === 0 ? -ex.x : ex.x;
      const tip = new THREE.CylinderGeometry(ex.r, ex.r * 0.92, 0.16, 12, 1, true);
      transform(tip, { pos: [x, ex.y, zT + 0.02], rot: [Math.PI / 2, 0, 0] });
      out.chrome.push(tip);
      const hole = new THREE.CircleGeometry(ex.r * 0.86, 12);
      transform(hole, { pos: [x, ex.y, zT - 0.03], rot: [0, Math.PI, 0] });
      out.cavity.push(hole);
    }
  }

  // ---- spoiler -----------------------------------------------------------
  if (s.spoiler === 'ducktail' && lod < 2) {
    const zd = s.backlightBaseZ - 0.12;
    const prof = surface.profileAt(zd);
    const lip = sweep(
      [{ x: 0.02, y: 0.05 }, { x: 0.05, y: 0.0 }, { x: 0.02, y: -0.03 }, { x: -0.07, y: -0.02 }, { x: -0.07, y: 0.045 }],
      [-1, -0.5, 0, 0.5, 1].map((t) => new THREE.Vector3(t * prof[0].x * 0 + t * s.hwMax * 0.94, prof[0].y + 0.02 - Math.abs(t) * 0.012, zd - Math.abs(t) * 0.05)),
      { closed: true, caps: true, up: new THREE.Vector3(0, 1, 0) }
    );
    out.paint.push(lip);
  }
}

/* ------------------------------------------------------------------ */
/* Shutlines and small detail                                          */
/* ------------------------------------------------------------------ */

/**
 * Panel gaps. A GTA V car at 3 m is read almost entirely by these: the bonnet
 * outline, the door gaps, the boot outline.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * THEY WERE HERE ALL ALONG AND NOBODY COULD SEE THEM
 * ────────────────────────────────────────────────────────────────────────────
 * These cars read as having no shutlines at all, and they did, even though
 * this function has always run. The gaps were `ribbon(...)` — a
 * FLAT 9 mm strip sitting 1.8 mm PROUD of the body in the dark trim material.
 * A flat strip on a smooth loft has the same shading normal as the panel under
 * it, so the only thing separating it from the paint is its albedo, and against
 * an overcast sky at 1-2 px wide that is a coin flip: measured in the vehicle
 * preview, the door split rendered LIGHTER than the door.
 *
 * A gap is a hole, so it is now `groove(...)` — lip, wall, wall, lip, 9 mm
 * across and 3 mm deep, in the near-black `cavity` material. The two walls face
 * each other, so whichever way the key comes from one of them is turned away
 * from it and the line reads as a shadow rather than as a stripe. That is what
 * makes it survive the flat overcast the vehicle shots are staged under.
 *
 * They are also no longer in `trim`: `trim` is grained bumper plastic with an
 * albedo around 0.055, and a panel gap is a cavity at 0.01 with almost no
 * environment reaching it.
 */
/** 9 mm across, 3 mm deep — a real panel gap, measured off a real car. */
const GAP_W = 0.009;
const GAP_D = 0.003;

function buildShutlines(spec, surface, out, C) {
  const s = spec.style;
  const lines = [];
  const cBelt = C(CP.BELT);
  const cSill = C(CP.SILL);
  const cTop = 0;
  const cRoof = C(CP.ROOF_EDGE);

  const vertical = (z, c0, c1, n = 12) => {
    const pts = [];
    const nor = [];
    const tan = [];
    const prof = surface.profileAt(z);
    for (let i = 0; i < n; i++) {
      const c = Math.round(c0 + ((c1 - c0) * i) / (n - 1));
      const ci = Math.max(0, Math.min(surface.cols - 1, c));
      pts.push(new THREE.Vector3(prof[ci].x, prof[ci].y, z));
      const cm = Math.max(0, ci - 1);
      const cp = Math.min(surface.cols - 1, ci + 1);
      const nx = prof[cp].y - prof[cm].y;
      const ny = -(prof[cp].x - prof[cm].x);
      const l = Math.hypot(nx, ny) || 1;
      nor.push(new THREE.Vector3(nx / l * Math.sign(nx || 1), (ny / l) * Math.sign(nx || 1), 0));
      tan.push(new THREE.Vector3(prof[cp].x - prof[cm].x, prof[cp].y - prof[cm].y, 0).normalize());
    }
    lines.push(groove(pts, nor, tan, GAP_W, GAP_D));
    const m = [];
    for (const p of pts) m.push(new THREE.Vector3(-p.x, p.y, p.z));
    const mn = nor.map((v) => new THREE.Vector3(-v.x, v.y, v.z));
    const mt = tan.map((v) => new THREE.Vector3(-v.x, v.y, v.z));
    lines.push(groove(m, mn, mt, GAP_W, GAP_D));
  };

  const longitudinal = (col, z0, z1, n = 26, both = true) => {
    const pts = [];
    const nor = [];
    const tan = [];
    for (let i = 0; i < n; i++) {
      const z = z0 + ((z1 - z0) * i) / (n - 1);
      const prof = surface.profileAt(z);
      const ci = Math.max(0, Math.min(surface.cols - 1, Math.round(col)));
      pts.push(new THREE.Vector3(prof[ci].x, prof[ci].y, z));
      const cm = Math.max(0, ci - 1);
      const cp = Math.min(surface.cols - 1, ci + 1);
      let nx = prof[cp].y - prof[cm].y;
      let ny = -(prof[cp].x - prof[cm].x);
      const l = Math.hypot(nx, ny) || 1;
      nx /= l; ny /= l;
      if (nx < 0) { nx = -nx; ny = -ny; }
      nor.push(new THREE.Vector3(nx, ny, 0));
      tan.push(new THREE.Vector3(0, 0, 1));
    }
    lines.push(groove(pts, nor, tan, GAP_W, GAP_D));
    if (both) {
      const m = pts.map((p) => new THREE.Vector3(-p.x, p.y, p.z));
      const mn = nor.map((v) => new THREE.Vector3(-v.x, v.y, v.z));
      lines.push(groove(m, mn, tan, GAP_W, GAP_D));
    }
  };

  // doors
  const splits = s.doorSplit ?? [];
  for (const z of splits) vertical(z, cRoof, cSill, 20);
  if (splits.length) {
    // the horizontal run along the sill closing the door apertures
    longitudinal(cSill - 1, Math.min(...splits) - 0.02, Math.max(...splits) + 0.02, 30);
  }

  // bonnet: two longitudinal runs plus the leading edge
  const zB0 = s.cowlZ - 0.01;
  const zB1 = s.archF.z + s.archF.r * 0.55;
  longitudinal(C(CP.ROOF_EDGE) - 1, zB1, zB0, 34);
  vertical(zB1, cTop, C(CP.ROOF_EDGE) - 1, 14);

  // boot / tailgate
  if (!s.boxBody) {
    const zD0 = s.backlightBaseZ + 0.02;
    const zD1 = s.tailZ + 0.16;
    longitudinal(C(CP.ROOF_EDGE) - 1, zD1, zD0, 28);
    vertical(zD1, cTop, C(CP.ROOF_EDGE) - 1, 14);
  }

  out.cavity.push(...lines);
}

function buildMirrors(spec, surface, out, lod) {
  const m = spec.style.mirror;
  if (!m) return;
  const arm = m.arm ?? 0.09;
  for (const side of [-1, 1]) {
    const base = new THREE.Vector3(side * (m.x - 0.02), m.y, m.z);
    const head = new THREE.Vector3(side * (m.x + arm), m.y + 0.035, m.z - 0.02);
    out.trim.push(tubeBetween(base, head, 0.022, 8));
    const shell = roundedBox(m.size * 0.75, m.size * 0.62, m.size * 1.05, m.size * 0.26, 2);
    transform(shell, { pos: [head.x + side * m.size * 0.3, head.y, head.z], rot: [0, side * -0.12, side * 0.08] });
    out.paint.push(shell);
    const glass = new THREE.PlaneGeometry(m.size * 0.62, m.size * 0.5);
    transform(glass, {
      pos: [head.x + side * m.size * 0.3, head.y, head.z + m.size * 0.53],
      rot: [0, 0.02 * side, side * 0.08],
    });
    out.chrome.push(glass);
  }
}

function buildDetails(spec, surface, out, C, lod) {
  const s = spec.style;

  // ---- door handles ------------------------------------------------------
  const splits = s.doorSplit ?? [];
  const handleZs = [];
  if (splits.length >= 2) {
    for (let i = 0; i < splits.length - 1; i++) handleZs.push(lerp(splits[i], splits[i + 1], 0.22));
    handleZs.push(splits[splits.length - 1] + 0.32);
  } else if (splits.length === 1) {
    handleZs.push(splits[0] - 0.5);
  }
  const cH = C(CP.BELT) + 1;
  for (const z of handleZs) {
    if (z < surface.z0 + 0.2 || z > surface.z1 - 0.2) continue;
    const prof = surface.profileAt(z);
    const ci = Math.max(0, Math.min(surface.cols - 1, cH));
    for (const side of [-1, 1]) {
      const h = roundedBox(0.028, 0.032, 0.145, 0.012, 2);
      transform(h, { pos: [side * (prof[ci].x + 0.012), prof[ci].y - 0.045, z] });
      out.chrome.push(h);
      const rec = roundedBox(0.02, 0.05, 0.17, 0.01, 1);
      transform(rec, { pos: [side * (prof[ci].x - 0.008), prof[ci].y - 0.045, z] });
      out.cavity.push(rec);
    }
  }

  // ---- windscreen wipers, parked at the base of the screen ---------------
  if (spec.kind === 'car') {
    const zc = s.cowlZ + 0.01;
    const prof = surface.profileAt(zc);
    const yc = prof[0].y;
    const reach = Math.min(0.52, s.hwMax * 0.62);
    for (const side of [-1, 1]) {
      const a = new THREE.Vector3(side * 0.16, yc + 0.012, zc);
      const b = new THREE.Vector3(side * (0.14 + reach), yc + 0.03, zc - 0.05);
      out.trim.push(tubeBetween(a, b, 0.011, 6));
      const blade = roundedBox(reach, 0.011, 0.017, 0.005, 1);
      transform(blade, { pos: [side * (0.15 + reach * 0.5), yc + 0.026, zc - 0.045], rot: [0, 0, side * 0.035] });
      out.trim.push(blade);
    }
  }

  // ---- side rubbing strip / rocker cladding ------------------------------
  const cSill = C(CP.SILL);
  const z0 = s.archF.z - s.archF.r * 0.98;
  const z1 = s.archR.z + s.archR.r * 0.98;
  if (z0 > z1) {
    const n = 12;
    const pts = [];
    for (let i = 0; i < n; i++) {
      const z = z1 + ((z0 - z1) * i) / (n - 1);
      const prof = surface.profileAt(z);
      const ci = Math.max(0, Math.min(surface.cols - 1, cSill));
      pts.push(new THREE.Vector3(prof[ci].x + 0.004, prof[ci].y, z));
    }
    const strip = sweep(
      [{ x: 0.012, y: 0.05 }, { x: 0.03, y: 0.0 }, { x: 0.012, y: -0.05 }, { x: -0.03, y: -0.05 }, { x: -0.03, y: 0.05 }],
      pts,
      { closed: true, caps: true, up: new THREE.Vector3(0, 1, 0) }
    );
    out.trim.push(strip, mirrorX(strip.clone()));
  }

  /**
   * ---- fuel flap ---------------------------------------------------------
   * Was a bare 15 cm disc of dark trim stuck on the quarter panel, which reads
   * as a sticker. A real filler is a body-coloured FLAP sitting a couple of
   * millimetres inside its own seam, with the seam broken by the hinge. It is
   * one of the three or four small asymmetries that stop a car looking like a
   * mirrored template, and it is directly in shot on the beauty three-quarter.
   */
  const zf = s.archR.z + s.archR.r * 0.55;
  const pf = surface.profileAt(zf);
  const cF = C(CP.CREASE) - 1;
  const flapR = 0.082;
  const fx = pf[cF].x;
  const fy = pf[cF].y + 0.12;
  {
    const pts = [];
    const nor = [];
    const tan = [];
    const N = 22;
    for (let i = 0; i <= N; i++) {
      const a = (i / N) * Math.PI * 2;
      const dz = Math.cos(a) * flapR;
      const dy = Math.sin(a) * flapR;
      const prof = surface.profileAt(zf + dz);
      const px = Math.min(fx, prof[cF].x);
      pts.push(new THREE.Vector3(-px, fy + dy, zf + dz));
      nor.push(new THREE.Vector3(-1, 0, 0));
      tan.push(new THREE.Vector3(0, Math.cos(a), -Math.sin(a)));
    }
    out.cavity.push(groove(pts, nor, tan, GAP_W, GAP_D));
    // The flap itself, 2 mm proud of the groove floor and body-coloured.
    const flap = new THREE.CylinderGeometry(flapR * 0.88, flapR * 0.88, 0.010, 20);
    transform(flap, { pos: [-(fx - 0.002), fy, zf], rot: [0, 0, Math.PI / 2] });
    out.paint.push(flap);
  }

  /**
   * ---- the bright window surround, and THE KINK ---------------------------
   * Two things make a fastback recognisable from the side. One is the roofline
   * (`topLine`). The other is this: a bright strip running the length of the
   * DLO that leaves the beltline near the rear door shut and CLIMBS the leading
   * edge of the C-pillar, so the surround finishes as a hook rather than as a
   * closed rectangle. People do not know they are reading it, and they name the
   * car off it anyway.
   *
   * It follows the surface by walking the SECTION — the path's column index
   * runs from the belt to the roof edge over the last third of the run — so it
   * stays welded to the flank through the tumblehome instead of standing off it
   * where the body pulls in. Same basis rule as `archLip`: the path sits at a
   * nearly constant x in the (y, z) plane, so `up` must be X, which makes the
   * outline's y the OUTBOARD axis.
   */
  if (s.dloBright && !s.boxBody && lod < 2) {
    const zFront = s.cowlZ - s.pillarA - 0.02;
    const zRear = (s.sideWindowEnd ?? (s.backlightBaseZ + s.pillarC)) + 0.01;
    const cB = C(CP.BELT);
    const cR = C(CP.ROOF_EDGE);
    if (zFront - zRear > 0.4) {
      /**
       * Where the strip stops following the belt and starts climbing. A FIXED
       * 30 cm, not a fraction of the run: at 30% of a two-metre DLO the upstroke
       * started level with the rear door handle and crossed the middle of the
       * glass, which is a diagonal bar through the window rather than a hook
       * around the end of it. The rear edge of a quarter light is raked but it
       * is still an EDGE.
       */
      const zKink = zRear + Math.min(0.30, (zFront - zRear) * 0.4);
      const N = 34;
      const pts = [];
      for (let i = 0; i < N; i++) {
        const t = i / (N - 1);
        const z = zFront + (zRear - zFront) * t;
        const u = z >= zKink ? 0 : Math.min(1, (zKink - z) / Math.max(0.05, zKink - zRear));
        const c = cB + (cR - cB) * (u * u * (3 - 2 * u));
        const prof = surface.profileAt(z);
        const ci = Math.max(0, Math.min(surface.cols - 1, Math.round(c)));
        pts.push(new THREE.Vector3(prof[ci].x, prof[ci].y, z));
      }
      const strip = sweep(
        [
          { x: 0.013, y: 0.006 }, { x: 0.013, y: -0.020 },
          { x: -0.013, y: -0.020 }, { x: -0.013, y: 0.006 },
        ],
        pts,
        { closed: true, caps: true, up: new THREE.Vector3(1, 0, 0) }
      );
      out.chrome.push(strip, mirrorX(strip.clone()));
      /**
       * The drip rail along the top of the DLO, so the surround is closed on
       * three sides and the hook reads as the open end of a shape.
       *
       * It starts at the HEADER, not at the base of the A-pillar. Run forward
       * of the header it lies on the windscreen pillar, which already has a
       * swept bar on it, and the two render as one 15 cm slab of brightwork
       * across the corner of the screen.
       */
      const rail = [];
      const zRailF = Math.min(zFront, s.windscreenTopZ);
      for (let i = 0; i < N; i++) {
        const z = zRailF + (zRear - zRailF) * (i / (N - 1));
        const prof = surface.profileAt(z);
        const ci = Math.max(0, Math.min(surface.cols - 1, Math.round(cR)));
        rail.push(new THREE.Vector3(prof[ci].x, prof[ci].y, z));
      }
      const drip = sweep(
        [
          { x: 0.010, y: 0.005 }, { x: 0.010, y: -0.018 },
          { x: -0.010, y: -0.018 }, { x: -0.010, y: 0.005 },
        ],
        rail,
        { closed: true, caps: true, up: new THREE.Vector3(1, 0, 0) }
      );
      out.chrome.push(drip, mirrorX(drip.clone()));
    }
  }

  // ---- badges ------------------------------------------------------------
  // A car without a badge is a concept sketch. Two small raised chrome plates:
  // a maker's mark on the nose and a model script offset to one side of the
  // boot lid, because they are never centred on both.
  if (spec.kind === 'car' && !s.boxBody) {
    const zb = s.tailZ + 0.10;
    const pb = surface.profileAt(zb);
    const by = (pb[C(CP.ROOF_EDGE)].y + pb[C(CP.BELT)].y) * 0.5;
    const mark = roundedBox(0.115, 0.052, 0.012, 0.014, 2);
    transform(mark, { pos: [0, by + 0.03, zb], rot: [0.12, 0, 0] });
    out.chrome.push(mark);
    for (let i = 0; i < 4; i++) {
      const script = roundedBox(0.030, 0.030, 0.009, 0.004, 1);
      transform(script, { pos: [0.30 + i * 0.042, by - 0.05, zb], rot: [0.12, 0, 0] });
      out.chrome.push(script);
    }
  }

  // ---- lightbar ----------------------------------------------------------
  if (s.lightbar) {
    const zL = lerp(s.windscreenTopZ, s.roofRearZ, 0.28);
    const prof = surface.profileAt(zL);
    const y = prof[0].y + 0.035;
    const base = roundedBox(1.24, 0.06, 0.24, 0.02, 2);
    transform(base, { pos: [0, y, zL] });
    out.trim.push(base);
    for (let i = 0; i < 6; i++) {
      const x = -0.52 + i * 0.208;
      const seg = roundedBox(0.18, 0.085, 0.2, 0.02, 2);
      transform(seg, { pos: [x, y + 0.065, zL] });
      lamp(i % 2 === 0 ? 'policeRed' : 'policeBlue', seg, out);
    }
    const capG = roundedBox(1.26, 0.02, 0.26, 0.01, 1);
    transform(capG, { pos: [0, y + 0.12, zL] });
    out.trim.push(capG);
  }

  // ---- truck flatbed -----------------------------------------------------
  if (s.flatbed) {
    out.trim.push(...flatbed(spec));
  }

  // ---- pickup bed --------------------------------------------------------
  if (s.bed) {
    pickupBed(spec, out);
  }

  // ---- roof rails --------------------------------------------------------
  if (s.roofRails) {
    out.trim.push(...roofRails(spec, surface, C));
  }

  // ---- exhaust stack -----------------------------------------------------
  if (s.exhaust?.stack) {
    const e = s.exhaust;
    const zst = s.cowlZ - 0.28;
    const st = new THREE.CylinderGeometry(e.r, e.r * 1.05, e.y * 1.5, 12, 1, true);
    transform(st, { pos: [-e.x, s.groundY + e.y * 1.4, zst] });
    out.chrome.push(st);
    const tipC = new THREE.CylinderGeometry(e.r * 1.15, e.r * 1.1, 0.14, 12, 1, true);
    transform(tipC, { pos: [-e.x, s.groundY + e.y * 2.1, zst] });
    out.chrome.push(tipC);
  }
}

function flatbed(spec) {
  const f = spec.style.flatbed;
  const hw = spec.style.hwMax;
  const parts = [];
  const deck = roundedBox(hw * 2.02, 0.08, f.z1 - f.z0, 0.012, 1);
  transform(deck, { pos: [0, f.deckY, (f.z0 + f.z1) / 2] });
  parts.push(deck);
  // planks
  const nP = 9;
  for (let i = 0; i < nP; i++) {
    const x = -hw + (hw * 2 * (i + 0.5)) / nP;
    const p = roundedBox((hw * 2) / nP - 0.02, 0.03, f.z1 - f.z0 - 0.04, 0.006, 1);
    transform(p, { pos: [x, f.deckY + 0.055, (f.z0 + f.z1) / 2] });
    parts.push(p);
  }
  // side gates
  for (const side of [-1, 1]) {
    const g = roundedBox(0.06, f.sideH, f.z1 - f.z0, 0.012, 1);
    transform(g, { pos: [side * hw, f.deckY + f.sideH / 2 + 0.05, (f.z0 + f.z1) / 2] });
    parts.push(g);
    for (let i = 0; i < 4; i++) {
      const post = roundedBox(0.07, f.sideH + 0.16, 0.08, 0.012, 1);
      transform(post, { pos: [side * hw, f.deckY + f.sideH / 2 + 0.1, f.z0 + ((f.z1 - f.z0) * (i + 0.5)) / 4] });
      parts.push(post);
    }
  }
  // headboard
  const hb = roundedBox(hw * 2, f.sideH * 1.9, 0.07, 0.012, 1);
  transform(hb, { pos: [0, f.deckY + f.sideH * 0.95 + 0.05, f.z1] });
  parts.push(hb);
  // tailgate
  const tg = roundedBox(hw * 2, f.sideH, 0.06, 0.012, 1);
  transform(tg, { pos: [0, f.deckY + f.sideH / 2 + 0.05, f.z0] });
  parts.push(tg);
  return parts;
}

/**
 * The open cargo bed of a compact PICKUP.
 *
 * Unlike `flatbed` — a stake deck bolted to a lorry — this is a smooth-walled
 * bed box that reads as a Ranger, not a farm truck. The bed FLOOR is already
 * there: with `tailY` set low the lofted body behind the cab settles to a flat
 * deck, and that deck IS the floor. This builder only raises the walls on it —
 * two body-coloured side panels with a dark capping rail, a front bulkhead
 * against the cab and a drop tailgate — plus a dark liner so the open box reads
 * as a floor rather than a slab top.
 *
 * All z come from the FINALISED style (`finalizeStyle` has already slid the tail
 * and backlight onto the real axle geometry), so the bed lands exactly where the
 * lofted deck does.
 */
function pickupBed(spec, out) {
  const s = spec.style;
  const zRear = s.tailZ + 0.03;
  const zFront = s.backlightBaseZ - 0.03;
  const len = zFront - zRear;
  if (len < 0.5) return; // no room for a bed — leave the body as lofted
  const wallH = s.bed?.wallH ?? 0.38;
  const wallX = s.hwMax * 0.94;
  const floorY = s.tailY;
  const zMid = (zRear + zFront) * 0.5;
  const topY = floorY + wallH;
  const paint = [];
  const trim = [];
  for (const side of [-1, 1]) {
    // Outer skin wall, dropped a little below the floor so its base overlaps the
    // lofted deck edge with no seam.
    const wall = roundedBox(0.05, wallH + 0.06, len, 0.012, 1);
    transform(wall, { pos: [side * (wallX - 0.025), floorY + wallH * 0.5 - 0.03, zMid] });
    paint.push(wall);
    // Dark capping rail along the top of each wall.
    const rail = roundedBox(0.09, 0.045, len, 0.014, 1);
    transform(rail, { pos: [side * (wallX - 0.03), topY, zMid] });
    trim.push(rail);
  }
  // Front bulkhead against the cab and the drop tailgate at the rear.
  const bh = roundedBox(wallX * 2, wallH + 0.06, 0.06, 0.012, 1);
  transform(bh, { pos: [0, floorY + wallH * 0.5 - 0.03, zFront] });
  paint.push(bh);
  const tg = roundedBox(wallX * 2, wallH, 0.06, 0.012, 1);
  transform(tg, { pos: [0, floorY + wallH * 0.5, zRear] });
  paint.push(tg);
  // Bed liner: a dark floor plane just proud of the deck.
  const floor = roundedBox(wallX * 2 - 0.03, 0.03, len - 0.04, 0.008, 1);
  transform(floor, { pos: [0, floorY + 0.03, zMid] });
  out.cavity.push(floor);
  out.paint.push(...paint);
  out.trim.push(...trim);
}

/**
 * Roof rails — two rails down the edges of an SUV roof, and the detail nobody
 * names but everybody reads as "that is an SUV". They follow the roof edge
 * column of the emitted surface, so they hug the roofline through its crown, and
 * sit a hair proud of the skin on short legs.
 */
function roofRails(spec, surface, C) {
  const s = spec.style;
  const parts = [];
  const zF = s.windscreenTopZ - 0.06;
  const zR = s.roofRearZ + 0.06;
  if (zF - zR < 0.4) return parts;
  const n = 10;
  const cR = Math.round(C(CP.ROOF_EDGE));
  for (const side of [-1, 1]) {
    const path = [];
    for (let i = 0; i < n; i++) {
      const t = i / (n - 1);
      const z = zF + (zR - zF) * t;
      const prof = surface.profileAt(z);
      const ci = Math.max(0, Math.min(surface.cols - 1, cR));
      path.push(new THREE.Vector3(side * (prof[ci].x - 0.05), prof[ci].y + 0.03, z));
    }
    const rail = sweep(
      [{ x: 0.020, y: 0.018 }, { x: 0.020, y: -0.018 }, { x: -0.020, y: -0.018 }, { x: -0.020, y: 0.018 }],
      path,
      { closed: true, caps: true, up: new THREE.Vector3(1, 0, 0) }
    );
    parts.push(rail);
    for (let i = 1; i < n - 1; i += 3) {
      const p = path[i];
      const leg = roundedBox(0.03, 0.045, 0.03, 0.006, 1);
      transform(leg, { pos: [p.x, p.y - 0.028, p.z] });
      parts.push(leg);
    }
  }
  return parts;
}
