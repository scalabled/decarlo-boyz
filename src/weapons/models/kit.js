import * as THREE from 'three';
import {
  box, blob, latheZ, tubeZ, rodZ, dome, extrude, roundRect, ring, screw,
  knurlBand, serrations, mergeAll,
} from '../geometry.js';

/**
 * SCRAPYARD KIT — the hard-surface vocabulary of an improvised weapon.
 *
 * `geometry.js` gives us the machinist's primitives (chamfered boxes, lathes,
 * Picatinny rail, knurling). None of those describe the things this arsenal is
 * actually made of. A Dock Pipe is a threaded galvanised nipple with a coupling
 * on it; a Scrap Rocket is a stove pipe with a seam and three pop rivets; an EMP
 * Coil is forty turns of enamelled copper on a ferrite core with a car battery
 * cable-tied to the stock.
 *
 * Every helper here obeys the same rules as the inherited kit:
 *   - authored in metres at real hardware-store dimensions,
 *   - +X right, +Y up, **-Z toward the muzzle**, origin at the grip hand,
 *   - no primitive has a true 90-degree edge — everything is chamfered, because
 *     a chamfer is what catches the specular line that separates "modelled"
 *     from "blocked out",
 *   - nothing is perfectly straight or perfectly clean: `sag`, `dent` and
 *     `jitter` parameters exist so a pipe bows, a bracket sits a degree off and
 *     a tape wrap does not start where the last one ended.
 *
 * Determinism: every helper that randomises takes an `Rng` — never
 * `Math.random()` (ARCHITECTURE rule 4).
 */

/* ========================================================================== */
/*  PIPE AND TUBE                                                             */
/* ========================================================================== */

/**
 * A length of schedule-40 pipe along Z, centred, with the wall visible at both
 * ends and a slight BOW along its length.
 *
 * The bow is the point. A perfectly straight extruded cylinder is the loudest
 * "this is a primitive" tell there is, and a pipe that has been swung into
 * things is never straight. 3 mm over a metre is invisible as a curve and very
 * visible as a moving specular line.
 */
export function pipe(rOuter, wall, len, opts = {}) {
  const seg = opts.seg ?? 20;
  const bow = opts.bow ?? len * 0.004;
  const bowAxis = opts.bowAxis ?? 'y';
  const rInner = Math.max(0.0004, rOuter - wall);
  const g = tubeZ(rOuter, rInner, len, seg, Math.min(wall * 0.4, 0.0009));
  if (bow > 1e-5) {
    // Bend it: a half-cosine over the length, so the ends stay on axis.
    const pos = g.getAttribute('position');
    const half = len / 2;
    for (let i = 0; i < pos.count; i++) {
      const t = Math.cos((pos.getZ(i) / half) * Math.PI * 0.5);
      if (bowAxis === 'y') pos.setY(i, pos.getY(i) + bow * t);
      else pos.setX(i, pos.getX(i) + bow * t);
    }
    pos.needsUpdate = true;
    g.computeVertexNormals();
  }
  return g;
}

/**
 * NPT pipe thread — a run of shallow helical vee grooves at the end of a pipe.
 * Modelled as a stack of slightly tapered rings rather than a true helix: at
 * hand scale the ring stack and the helix are visually identical and the ring
 * stack is a tenth of the triangles.
 */
export function pipeThread(rOuter, len, opts = {}) {
  const seg = opts.seg ?? 18;
  const pitch = opts.pitch ?? 0.0018;
  const depth = opts.depth ?? 0.0006;
  const taper = opts.taper ?? 0.0016; // NPT threads are tapered, 1:16
  const n = Math.max(2, Math.floor(len / pitch));
  const prof = [];
  for (let i = 0; i <= n; i++) {
    const t = i / n;
    const z = -len / 2 + t * len;
    const r = rOuter - taper * t;
    prof.push([z, r - depth]);
    prof.push([z + pitch * 0.5, r]);
  }
  return latheZ(prof, seg);
}

/** A screwed-on pipe coupling / union: a fat knurled collar with a hex flat. */
export function coupling(rPipe, opts = {}) {
  const len = opts.len ?? 0.038;
  const r = rPipe + (opts.wall ?? 0.006);
  const parts = [];
  parts.push(latheZ(
    [
      [-len / 2, rPipe],
      [-len / 2, r - 0.0012],
      [-len / 2 + 0.0012, r],
      [len / 2 - 0.0012, r],
      [len / 2, r - 0.0012],
      [len / 2, rPipe],
    ],
    opts.seg ?? 18
  ));
  // Wrench flats: six shallow facets so a pipe wrench has somewhere to bite.
  if (opts.hex !== false) {
    for (let i = 0; i < 6; i++) {
      const a = (i / 6) * Math.PI * 2;
      const f = box(r * 0.62, 0.0016, len * 0.8, 0.0004, 1);
      f.rotateZ(a);
      f.translate(Math.cos(a) * (r - 0.0004), Math.sin(a) * (r - 0.0004), 0);
      parts.push(f);
    }
  }
  parts.push(knurlBand(r + 0.0002, len * 0.62, opts.seg ?? 18, 0.00035, 3));
  return mergeAll(parts);
}

/** A welded flange plate on a pipe end — dock fitting, muzzle collar. */
export function flange(rPipe, rPlate, thick, holes = 4) {
  const parts = [];
  parts.push(latheZ(
    [
      [-thick / 2, rPipe],
      [-thick / 2, rPlate - 0.001],
      [-thick / 2 + 0.001, rPlate],
      [thick / 2 - 0.001, rPlate],
      [thick / 2, rPlate - 0.001],
      [thick / 2, rPipe],
    ],
    20
  ));
  for (let i = 0; i < holes; i++) {
    const a = (i / holes) * Math.PI * 2 + 0.4;
    const rh = (rPipe + rPlate) * 0.55;
    const h = tubeZ(0.0034, 0.0026, thick * 1.4, 8, 0.0002);
    h.translate(Math.cos(a) * rh, Math.sin(a) * rh, 0);
    parts.push(h);
  }
  return mergeAll(parts);
}

/**
 * A WELD BEAD along a straight seam: a run of overlapping stacked-dime blobs.
 * This is the single most valuable detail in the whole set — it is what says
 * "somebody made this in a shop" instead of "this came out of a factory".
 */
export function weldBead(len, rng, opts = {}) {
  const r = opts.radius ?? 0.0022;
  const n = Math.max(2, Math.round(len / (r * 1.35)));
  const parts = [];
  for (let i = 0; i < n; i++) {
    const t = (i + 0.5) / n;
    const s = 0.82 + rng.float() * 0.4;
    const d = new THREE.SphereGeometry(r * s, 7, 5);
    d.scale(1, 0.72, 1.25);
    d.rotateZ(rng.signed() * 0.3);
    d.translate(rng.signed() * r * 0.22, rng.signed() * r * 0.15, -len / 2 + t * len);
    parts.push(d);
  }
  return mergeAll(parts);
}

/** A weld bead running around a circle — a collar welded onto a tube. */
export function weldRing(radius, rng, opts = {}) {
  const r = opts.radius ?? 0.002;
  const n = opts.count ?? Math.max(8, Math.round((Math.PI * 2 * radius) / (r * 1.5)));
  const parts = [];
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2;
    const s = 0.8 + rng.float() * 0.45;
    const d = new THREE.SphereGeometry(r * s, 6, 4);
    d.scale(1.25, 1, 0.75);
    d.translate(Math.cos(a) * radius, Math.sin(a) * radius, rng.signed() * r * 0.3);
    parts.push(d);
  }
  return mergeAll(parts);
}

/* ========================================================================== */
/*  TAPE, ROPE, HOSE                                                          */
/* ========================================================================== */

/**
 * A helical tape wrap around a cylinder: overlapping bands with a visible
 * leading edge, a start tail and an end tail.
 *
 * Modelled as a stack of thin rings whose radius steps up where the wraps
 * overlap, so the silhouette is genuinely lumpy. A tape wrap that is a smooth
 * cylinder of slightly larger radius reads as a painted stripe.
 */
export function tapeWrap(rCore, len, rng, opts = {}) {
  const seg = opts.seg ?? 16;
  const thick = opts.thick ?? 0.0011;
  const band = opts.band ?? 0.019;      // tape width
  const advance = opts.advance ?? band * 0.62; // overlap
  const n = Math.max(2, Math.floor(len / advance));
  const parts = [];
  for (let i = 0; i < n; i++) {
    const z = -len / 2 + (i + 0.5) * advance;
    // Layer count under this ring: the middle of a wrap is fatter.
    const layers = 1 + Math.min(1, i * advance / band) + (rng.float() < 0.3 ? 1 : 0);
    const r = rCore + thick * layers;
    const w = band * (0.9 + rng.float() * 0.2);
    parts.push(latheZ(
      [
        [z - w / 2, rCore + thick * 0.2],
        [z - w / 2 + 0.0008, r],
        [z + w / 2 - 0.0008, r],
        [z + w / 2, rCore + thick * 0.2],
      ],
      seg
    ));
  }
  // The loose tail: a small flap standing off the end of the wrap.
  if (opts.tail !== false) {
    const tail = box(band * 0.8, thick, 0.016, 0.0004, 1);
    tail.rotateX(0.35);
    tail.rotateZ(Math.PI / 2);
    tail.translate(rCore + thick * 2.4, 0, len / 2 - 0.006);
    parts.push(tail);
  }
  return mergeAll(parts);
}

/** A flat strip of tape stuck across a joint — holds two parts together. */
export function tapeStrap(w, h, wrap, rng) {
  const parts = [];
  const n = 5;
  for (let i = 0; i < n; i++) {
    const t = i / (n - 1) - 0.5;
    const a = t * Math.PI * wrap;
    const s = box(w, 0.0011, h / n + 0.001, 0.0003, 1);
    s.rotateX(a);
    s.translate(rng.signed() * 0.0004, 0, 0);
    parts.push(s);
  }
  return mergeAll(parts);
}

/**
 * A hanging catenary of hose or cable between two points, with a ribbed surface.
 * `from` / `to` are [x,y,z]; `sag` is how far the middle drops.
 */
export function hoseRun(from, to, sag, opts = {}) {
  const r = opts.radius ?? 0.0055;
  const steps = opts.steps ?? 14;
  const pts = [];
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    const x = from[0] + (to[0] - from[0]) * t;
    const y = from[1] + (to[1] - from[1]) * t - Math.sin(t * Math.PI) * sag;
    const z = from[2] + (to[2] - from[2]) * t;
    pts.push(new THREE.Vector3(x, y, z));
  }
  const curve = new THREE.CatmullRomCurve3(pts);
  const g = new THREE.TubeGeometry(curve, steps * 2, r, opts.seg ?? 8, false);
  g.deleteAttribute('uv');
  const uv = new Float32Array(g.getAttribute('position').count * 2);
  g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  return g;
}

/** A coil of rope on a drum: overlapping torus turns, slightly uneven. */
export function ropeCoil(rDrum, turns, rng, opts = {}) {
  const rRope = opts.radius ?? 0.005;
  const layers = opts.layers ?? 2;
  const parts = [];
  for (let l = 0; l < layers; l++) {
    for (let i = 0; i < turns; i++) {
      const rr = rDrum + rRope * (2 * l + 1);
      const t = ring(rr, rRope * (0.92 + rng.float() * 0.16), 14, 6);
      t.rotateY(Math.PI / 2);
      t.translate(0, 0, (i - (turns - 1) / 2) * rRope * 2.05 + rng.signed() * rRope * 0.12);
      parts.push(t);
    }
  }
  return mergeAll(parts);
}

/* ========================================================================== */
/*  FASTENERS AND FITTINGS                                                    */
/* ========================================================================== */

/** A hex bolt head sitting proud, with a washer under it. */
export function boltHead(rAcross = 0.005, height = 0.0035, washer = true) {
  const parts = [];
  const g = new THREE.CylinderGeometry(rAcross, rAcross * 0.97, height, 6, 1);
  g.rotateX(Math.PI / 2);
  g.translate(0, 0, height / 2);
  parts.push(g);
  const dm = dome(rAcross * 0.34, 8, 0.5);
  dm.rotateX(Math.PI);
  dm.translate(0, 0, height + 0.0002);
  parts.push(dm);
  if (washer) {
    parts.push(tubeZ(rAcross * 1.3, rAcross * 0.62, 0.0009, 12, 0.0002));
  }
  return mergeAll(parts);
}

/** A pop rivet: a small domed head with a visible mandrel break in the middle. */
export function popRivet(r = 0.0022) {
  const parts = [];
  parts.push(latheZ(
    [
      [0, 0],
      [0, r],
      [0.0008, r * 0.92],
      [0.0014, r * 0.55],
      [0.0014, 0],
    ],
    10
  ));
  return mergeAll(parts);
}

/** A jubilee / worm-drive hose clamp — a banded ring with a screw housing. */
export function hoseClamp(radius, width = 0.008) {
  const parts = [];
  parts.push(tubeZ(radius + 0.0009, radius, width, 18, 0.0002));
  // The worm housing box on one side.
  const h = box(0.011, 0.0075, width + 0.002, 0.0006, 1);
  h.translate(0, radius + 0.0042, 0);
  parts.push(h);
  const sc = new THREE.CylinderGeometry(0.0018, 0.0018, 0.013, 8, 1);
  sc.rotateZ(Math.PI / 2);
  sc.translate(0, radius + 0.0042, 0);
  parts.push(sc);
  return mergeAll(parts);
}

/** A pressure gauge: chromed bezel, dial face, needle, threaded stem. */
export function gauge(r = 0.017, opts = {}) {
  const out = {};
  const body = [];
  body.push(latheZ(
    [
      [0, 0],
      [0, r * 0.86],
      [-0.0016, r * 0.94],
      [-0.0035, r],
      [-0.011, r],
      [-0.0125, r * 0.9],
      [-0.0125, r * 0.34],
      [-0.02, r * 0.3],
      [-0.02, 0],
    ],
    18
  ));
  // Threaded stem going into the body it reads.
  const stem = new THREE.CylinderGeometry(0.0042, 0.0042, 0.014, 8, 1);
  stem.rotateX(Math.PI / 2);
  stem.translate(0, 0, -0.024);
  body.push(stem);
  out.body = mergeAll(body);
  // Dial face and needle are separate materials.
  out.face = latheZ([[0.0002, 0], [0.0002, r * 0.86]], 18);
  const needle = box(0.0011, r * 0.7, 0.0004, 0.0002, 1);
  needle.translate(0, r * 0.3, 0.0008);
  const hub = new THREE.CylinderGeometry(0.0016, 0.0016, 0.0012, 8, 1);
  hub.rotateX(Math.PI / 2);
  hub.translate(0, 0, 0.0012);
  out.needle = mergeAll([needle, hub]);
  void opts;
  return out;
}

/* ========================================================================== */
/*  SHEET METAL                                                               */
/* ========================================================================== */

/**
 * A folded sheet-metal channel (a U section) along Z — the spine of every
 * home-made receiver in this set. `flangeAngle` lets the walls splay slightly,
 * which is what happens when you bend 16-gauge in a vice.
 */
export function sheetChannel(w, h, len, thick = 0.0016, flangeAngle = 0.04) {
  const parts = [];
  const base = box(w, thick, len, thick * 0.4, 1);
  base.translate(0, -h / 2, 0);
  parts.push(base);
  for (const s of [-1, 1]) {
    const wall = box(thick, h, len, thick * 0.4, 1);
    wall.rotateZ(-s * flangeAngle);
    wall.translate(s * (w / 2 - thick / 2), 0, 0);
    parts.push(wall);
  }
  return mergeAll(parts);
}

/**
 * A rolled sheet tube with a visible LAP SEAM — stove pipe, the Scrap Rocket's
 * body. The seam is a raised ridge with rivets along it.
 */
export function seamTube(r, len, thick = 0.0012, opts = {}) {
  const parts = [];
  parts.push(tubeZ(r, r - thick, len, opts.seg ?? 22, 0.0004));
  const seam = box(0.0075, thick * 2.2, len, 0.0004, 1);
  const a = opts.seamAngle ?? Math.PI * 0.62;
  seam.rotateZ(a);
  seam.translate(Math.cos(a) * (r + thick * 0.4), Math.sin(a) * (r + thick * 0.4), 0);
  parts.push(seam);
  const n = opts.rivets ?? Math.max(3, Math.round(len / 0.055));
  for (let i = 0; i < n; i++) {
    const z = -len / 2 + ((i + 0.5) / n) * len;
    const rv = popRivet(0.0021);
    rv.rotateY(Math.PI / 2);
    rv.rotateZ(a);
    rv.translate(Math.cos(a) * (r + thick * 1.6), Math.sin(a) * (r + thick * 1.6), z);
    parts.push(rv);
  }
  return mergeAll(parts);
}

/** A corrugated / ribbed drum wall — the Depth Charge and the paint pot. */
export function ribbedDrum(r, len, ribs = 3, opts = {}) {
  const parts = [];
  parts.push(latheZ(
    [
      [-len / 2, 0],
      [-len / 2, r - 0.004],
      [-len / 2 + 0.004, r],
      [len / 2 - 0.004, r],
      [len / 2, r - 0.004],
      [len / 2, 0],
    ],
    opts.seg ?? 22
  ));
  for (let i = 0; i < ribs; i++) {
    const z = -len / 2 + ((i + 1) / (ribs + 1)) * len;
    const rr = ring(r + 0.0016, 0.0032, 22, 7);
    rr.rotateY(Math.PI / 2);
    rr.translate(0, 0, z);
    parts.push(rr);
  }
  return mergeAll(parts);
}

/* ========================================================================== */
/*  ELECTRICAL                                                                */
/* ========================================================================== */

/**
 * A real helical winding around a core — the EMP Coil's forty turns of
 * enamelled copper. A true helix, not a ring stack: the pitch is visible at
 * arm's length and a ring stack looks like a stack of washers.
 */
export function coilWinding(rCore, wire, turns, len, opts = {}) {
  const layers = opts.layers ?? 1;
  const parts = [];
  for (let l = 0; l < layers; l++) {
    const r = rCore + wire * (2 * l + 1);
    const pts = [];
    const steps = Math.max(24, turns * 10);
    for (let i = 0; i <= steps; i++) {
      const t = i / steps;
      const a = t * turns * Math.PI * 2;
      pts.push(new THREE.Vector3(
        Math.cos(a) * r,
        Math.sin(a) * r,
        -len / 2 + t * len
      ));
    }
    const curve = new THREE.CatmullRomCurve3(pts);
    const g = new THREE.TubeGeometry(curve, steps, wire, opts.seg ?? 5, false);
    g.deleteAttribute('uv');
    g.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(g.getAttribute('position').count * 2), 2));
    parts.push(g);
  }
  return mergeAll(parts);
}

/** A capacitor can: cylinder with a crimped rim, a top vent cross and a lead. */
export function capacitor(r, len) {
  const parts = [];
  parts.push(latheZ(
    [
      [-len / 2, 0],
      [-len / 2, r - 0.0015],
      [-len / 2 + 0.0015, r],
      [len / 2 - 0.004, r],
      [len / 2 - 0.003, r - 0.0012],   // crimp groove
      [len / 2 - 0.0018, r - 0.0004],
      [len / 2 - 0.0018, r * 0.94],
      [len / 2, r * 0.9],
      [len / 2, 0],
    ],
    16
  ));
  // Vent score on the top face: the little cross stamped into every electrolytic.
  for (const a of [0, Math.PI / 2]) {
    const v = box(r * 1.5, 0.0007, 0.0006, 0.0002, 1);
    v.rotateZ(a);
    v.translate(0, 0, len / 2 + 0.0003);
    parts.push(v);
  }
  return mergeAll(parts);
}

/** A battery terminal post with a clamped lug on it. */
export function terminalPost(r = 0.0055) {
  const parts = [];
  const post = latheZ([[0, 0], [0, r], [0.008, r * 0.86], [0.008, 0]], 12);
  parts.push(post);
  const clamp = ring(r * 1.45, 0.0022, 14, 6);
  clamp.translate(0, 0, 0.005);
  parts.push(clamp);
  const ear = box(0.006, 0.0026, 0.0034, 0.0005, 1);
  ear.translate(r * 1.6, 0, 0.005);
  parts.push(ear);
  return mergeAll(parts);
}

/** A ceramic / porcelain standoff insulator — stacked skirts on a stud. */
export function insulator(r, len, skirts = 3) {
  const prof = [[-len / 2, 0], [-len / 2, r * 0.45]];
  for (let i = 0; i < skirts; i++) {
    const z0 = -len / 2 + (i / skirts) * len;
    const z1 = -len / 2 + ((i + 0.7) / skirts) * len;
    prof.push([z0 + 0.0008, r]);
    prof.push([z1, r * 0.52]);
  }
  prof.push([len / 2, r * 0.45]);
  prof.push([len / 2, 0]);
  return latheZ(prof, 14);
}

/* ========================================================================== */
/*  POINTY THINGS                                                             */
/* ========================================================================== */

/** A barbed spear/harpoon head: a leaf point with a hinged barb behind it. */
export function barbedHead(r, len, opts = {}) {
  const parts = [];
  // The point itself: a 4-sided pyramid ground on a shaft.
  const tip = latheZ(
    [
      [0, 0],
      [len * 0.42, r * 1.15],
      [len * 0.55, r * 1.02],
      [len, r * 0.62],
    ],
    opts.seg ?? 4
  );
  tip.rotateZ(Math.PI / 4);
  parts.push(tip);
  // Barbs: flat flukes swept back from the base of the point.
  const barbs = opts.barbs ?? 2;
  for (let i = 0; i < barbs; i++) {
    const a = (i / barbs) * Math.PI * 2 + (opts.barbPhase ?? 0);
    const b = extrude(
      [
        [0, 0],
        [r * 2.4, len * 0.34],
        [r * 2.1, len * 0.46],
        [0, len * 0.2],
      ],
      0.0016,
      { bevel: 0.0004 }
    );
    b.rotateX(-Math.PI / 2);
    b.rotateZ(a);
    b.translate(Math.cos(a) * r * 0.6, Math.sin(a) * r * 0.6, len * 0.62);
    parts.push(b);
  }
  return mergeAll(parts);
}

/**
 * A nail — shank along Z, head at +Z, point at -Z (so it flies muzzle-forward
 * with no extra rotation). Also serves as tack, rivet and staple leg.
 */
export function nail(rShank, len, opts = {}) {
  const parts = [];
  const shank = Math.max(rShank, len - rShank * 3);
  parts.push(rodZ(rShank, rShank, shank, opts.seg ?? 8, rShank * 0.2));
  // Diamond point ground on the end.
  const point = latheZ([[-rShank * 3, 0], [0, rShank]], opts.pointSeg ?? 6);
  point.translate(0, 0, -shank / 2);
  parts.push(point);
  if (opts.head !== false) {
    const hr = rShank * (opts.headR ?? 2.6);
    const head = latheZ(
      [[0, 0], [0, hr], [rShank * 0.6, hr * 0.94], [rShank * 0.6, 0]],
      opts.headSeg ?? 8
    );
    head.translate(0, 0, shank / 2);
    parts.push(head);
  }
  return mergeAll(parts);
}

/** A stick of collated nails for a framing nailer's magazine. */
export function nailStrip(count, spacing, nailLen, rShank) {
  const parts = [];
  for (let i = 0; i < count; i++) {
    const n = nail(rShank, nailLen, { headR: 2.2 });
    n.rotateX(Math.PI / 2);
    n.translate((i - (count - 1) / 2) * spacing, 0, 0);
    parts.push(n);
  }
  // The paper/plastic collation strip holding them.
  const strip = box(count * spacing, 0.0022, 0.006, 0.0004, 1);
  strip.translate(0, nailLen * 0.14, 0);
  parts.push(strip);
  return mergeAll(parts);
}

/* ========================================================================== */
/*  GRIPS AND HANDLES                                                         */
/* ========================================================================== */

/**
 * A generic scavenged pistol grip. `kind`:
 *   'bike'  a bicycle handlebar grip — ribbed rubber with end flanges
 *   'wood'  a shaped wooden block screwed to a steel tang
 *   'tool'  a moulded power-tool grip with finger swells
 */
export function scavengedGrip(kind, opts = {}) {
  const len = opts.len ?? 0.105;
  const w = opts.w ?? 0.032;
  const d = opts.d ?? 0.042;
  const parts = [];
  if (kind === 'bike') {
    parts.push(latheZ(
      [
        [-len / 2, 0], [-len / 2, w * 0.62], [-len / 2 + 0.004, w * 0.55],
        [len / 2 - 0.012, w * 0.5], [len / 2 - 0.008, w * 0.62],
        [len / 2 - 0.002, w * 0.62], [len / 2, w * 0.5], [len / 2, 0],
      ],
      16
    ));
    for (let i = 0; i < 7; i++) {
      const z = -len / 2 + 0.012 + i * (len - 0.03) / 6;
      const r = ring(w * 0.52, 0.0016, 16, 6);
      r.rotateY(Math.PI / 2);
      r.translate(0, 0, z);
      parts.push(r);
    }
  } else if (kind === 'wood') {
    const g = blob(w, d, len, 0.008, 3);
    parts.push(g);
    // Two countersunk screws through the scale.
    for (const t of [-0.28, 0.3]) {
      const s = screw(0.0034, 0.0016, 0.0012, 0.004, 10);
      s.rotateY(Math.PI / 2);
      s.translate(w / 2 - 0.0002, 0, t * len);
      parts.push(s);
    }
  } else {
    const g = blob(w, d, len, 0.01, 3);
    parts.push(g);
    for (let i = 0; i < 3; i++) {
      const z = -len * 0.28 + i * len * 0.26;
      const sw = new THREE.SphereGeometry(w * 0.42, 10, 8);
      sw.scale(1, 0.5, 0.55);
      sw.translate(0, -d * 0.42, z);
      parts.push(sw);
    }
  }
  return mergeAll(parts);
}

/** A bent-rod trigger and its guard — a bicycle brake lever, essentially. */
export function wireTrigger(opts = {}) {
  const parts = [];
  const lever = extrude(
    [
      [-0.0035, 0.004],
      [0.0035, 0.004],
      [0.005, -0.014],
      [0.001, -0.026],
      [-0.004, -0.026],
      [-0.0055, -0.012],
    ],
    opts.thick ?? 0.005,
    { bevel: 0.0006 }
  );
  parts.push(lever);
  return mergeAll(parts);
}

/** A guard bent from 6 mm round bar. */
export function rodGuard(w = 0.05, h = 0.036, r = 0.0028) {
  const pts = [
    new THREE.Vector3(-w / 2, 0, 0),
    new THREE.Vector3(-w / 2 - 0.004, -h * 0.55, 0),
    new THREE.Vector3(0, -h, 0),
    new THREE.Vector3(w / 2 + 0.002, -h * 0.5, 0),
    new THREE.Vector3(w / 2, 0.004, 0),
  ];
  const curve = new THREE.CatmullRomCurve3(pts);
  const g = new THREE.TubeGeometry(curve, 22, r, 7, false);
  g.deleteAttribute('uv');
  g.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(g.getAttribute('position').count * 2), 2));
  return g;
}

/* ========================================================================== */
/*  DAMAGE                                                                    */
/* ========================================================================== */

/**
 * Push a geometry's vertices around to DENT it.
 *
 * "Nothing perfectly straight, clean or repeated" is the quality bar, and on a
 * scavenged object this is the cheapest way to earn it: a few gaussian dents
 * per part destroy the primitive read completely and cost nothing at runtime
 * because they are baked into the merged geometry.
 */
export function dent(geo, rng, opts = {}) {
  const count = opts.count ?? 3;
  const radius = opts.radius ?? 0.02;
  const depth = opts.depth ?? 0.0018;
  const pos = geo.getAttribute('position');
  const nrm = geo.getAttribute('normal');
  if (!pos || !nrm) return geo;
  // Pick dent centres from actual surface vertices so they always land on it.
  const centres = [];
  for (let i = 0; i < count; i++) {
    const k = Math.floor(rng.float() * pos.count);
    centres.push([pos.getX(k), pos.getY(k), pos.getZ(k), 0.6 + rng.float() * 0.8]);
  }
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i), y = pos.getY(i), z = pos.getZ(i);
    let push = 0;
    for (const [cx, cy, cz, s] of centres) {
      const d2 = (x - cx) ** 2 + (y - cy) ** 2 + (z - cz) ** 2;
      const r2 = (radius * s) ** 2;
      if (d2 < r2) push += (1 - d2 / r2) ** 2 * depth * s;
    }
    if (push > 0) {
      pos.setX(i, x - nrm.getX(i) * push);
      pos.setY(i, y - nrm.getY(i) * push);
      pos.setZ(i, z - nrm.getZ(i) * push);
    }
  }
  pos.needsUpdate = true;
  geo.computeVertexNormals();
  return geo;
}

/** Rotate/translate a geometry by a tiny random amount — nothing sits square. */
export function jitter(geo, rng, lin = 0.0006, ang = 0.012) {
  geo.rotateX(rng.signed() * ang);
  geo.rotateY(rng.signed() * ang);
  geo.rotateZ(rng.signed() * ang);
  geo.translate(rng.signed() * lin, rng.signed() * lin, rng.signed() * lin);
  return geo;
}

export {
  box, blob, latheZ, tubeZ, rodZ, dome, extrude, roundRect, ring, screw,
  knurlBand, serrations, mergeAll,
};
