import * as THREE from 'three';
import { Assembly } from '../geometry.js';
import {
  box, latheZ, tubeZ, rodZ, extrude, ring,
  pipe, pipeThread, coupling, weldRing, tapeWrap, dent,
} from './kit.js';

/**
 * MELEE — Dock Pipe, Body Wrench, Crowbar.
 *
 * Three found objects, and the whole design problem is that they must read as
 * three DIFFERENT found objects in silhouette at 4 m over the shoulder, at
 * 60 px tall, while the character is swinging them.
 *
 *   Dock Pipe     a long straight cylinder with a lump at one end
 *   Body Wrench   a short thick bar with a wide FORKED head
 *   Crowbar       a thin hexagonal bar with a HOOK at one end and a flat at the
 *                 other — the only one in the set that is not axially symmetric
 *
 * Convention (shared with the whole subsystem): +X right, +Y up, **-Z toward
 * the business end**, origin at the web of the shooting hand. A melee weapon is
 * therefore a thing that sticks out forward from the fist, which is exactly the
 * transform the hand bone wants.
 */

/* ========================================================================== */
/*  DOCK PIPE                                                                 */
/* ========================================================================== */

/**
 * A 950 mm length of 1¼" galvanised water pipe off a dock gantry, with the
 * coupling still screwed on the far end and forty years of river on it.
 *
 * Real dimensions: 1¼" schedule 40 is 42.2 mm OD, 3.56 mm wall. That is heavy —
 * about 4.5 kg over this length — which is why the swing is the slowest in the
 * game and the knockback the largest.
 */
export function buildPipe(rng) {
  const R = 0.0211;        // 42.2 mm OD
  const WALL = 0.0036;
  const LEN = 0.95;
  const zButt = 0.155;     // behind the hand
  const zTip = zButt - LEN;
  const zMid = (zButt + zTip) * 0.5;

  const body = new Assembly('pipe');

  /* ---- the pipe itself ------------------------------------------------- */
  // Galvanised, bowed 4 mm over its length, and dented where it has been used.
  const tube = pipe(R, WALL, LEN, { seg: 22, bow: 0.0042, bowAxis: 'y' });
  dent(tube, rng, { count: 5, radius: 0.032, depth: 0.0022 });
  body.add(tube, 'imp_galv', { z: zMid });
  tube.dispose();

  // The bore is a real hole, not a dark ring: a cavity liner so the end reads
  // as a tube from any angle.
  const bore = tubeZ(R - WALL + 0.0002, 0.0002, 0.05, 14, 0.0002);
  body.add(bore, 'cavity', { z: zTip + 0.024 });
  body.add(bore, 'cavity', { z: zButt - 0.024 });
  bore.dispose();

  /* ---- exposed thread + coupling at the striking end -------------------- */
  const thread = pipeThread(R + 0.0004, 0.026, { seg: 20, pitch: 0.0019, depth: 0.0007 });
  body.add(thread, 'imp_rust', { z: zTip + 0.013 });
  thread.dispose();

  // The coupling is the mass at the end of the swing — visually the "head".
  const cpl = coupling(R + 0.0006, { len: 0.046, wall: 0.0062, seg: 20 });
  dent(cpl, rng, { count: 3, radius: 0.014, depth: 0.0013 });
  body.add(cpl, 'imp_rust', { z: zTip + 0.03 });
  cpl.dispose();

  // A second, half-unscrewed elbow stub hanging off it: the giveaway that this
  // came off something rather than out of a rack.
  const stub = pipe(R * 0.72, 0.003, 0.052, { seg: 14, bow: 0 });
  body.add(stub, 'imp_rust', { x: 0.019, y: 0.004, z: zTip + 0.058, ry: 1.28, rz: 0.06 });
  stub.dispose();
  const wr = weldRing(R * 0.75, rng, { radius: 0.0016, count: 12 });
  body.add(wr, 'imp_steel', { x: 0.0045, y: 0.004, z: zTip + 0.058, ry: 1.28 });
  wr.dispose();

  /* ---- rust bloom: raised scabs, not a texture ------------------------- */
  // Rust is a VOLUME — it lifts off the metal. Six blistered patches along the
  // pipe give the silhouette a broken edge, which no material can do.
  for (let i = 0; i < 7; i++) {
    const t = rng.float();
    const a = rng.float() * Math.PI * 2;
    const s = 0.6 + rng.float() * 0.9;
    const scab = new THREE.SphereGeometry(0.0115 * s, 8, 6);
    scab.scale(1.5, 0.28, 2.4);
    body.add(scab, 'imp_rust', {
      x: Math.cos(a) * R * 0.94,
      y: Math.sin(a) * R * 0.94,
      z: zTip + 0.08 + t * (LEN - 0.2),
      rz: a - Math.PI / 2,
      ry: rng.signed() * 0.5,
    });
    scab.dispose();
  }

  /* ---- the grip: duct tape over friction tape -------------------------- */
  const wrap = tapeWrap(R, 0.185, rng, { band: 0.021, thick: 0.0012, seg: 18 });
  body.add(wrap, 'imp_tape_duct', { z: 0.02 });
  wrap.dispose();
  const wrap2 = tapeWrap(R + 0.0011, 0.062, rng, { band: 0.017, thick: 0.0009, seg: 18, tail: false });
  body.add(wrap2, 'imp_tape_black', { z: -0.058 });
  wrap2.dispose();

  /* ---- lanyard: a drilled hole and a loop of manila through the butt ---- */
  const hole = tubeZ(0.0038, 0.0031, R * 2.4, 8, 0.0002);
  body.add(hole, 'cavity', { z: zButt - 0.022, rx: Math.PI / 2 });
  hole.dispose();
  const loop = ring(0.026, 0.0028, 14, 6);
  body.add(loop, 'imp_rope', { y: -0.024, z: zButt - 0.022, rx: 0.2, ry: 0.35 });
  loop.dispose();
  const knot = new THREE.SphereGeometry(0.0055, 8, 6);
  knot.scale(1, 1.3, 1);
  body.add(knot, 'imp_rope', { y: -0.048, z: zButt - 0.02 });
  knot.dispose();

  /* ---- a jubilee clip somebody left on it ------------------------------ */
  const clipRing = tubeZ(R + 0.0016, R + 0.0004, 0.0085, 20, 0.0002);
  body.add(clipRing, 'imp_zinc', { z: -0.22 });
  clipRing.dispose();
  const clipBox = box(0.011, 0.008, 0.011, 0.0006, 1);
  body.add(clipBox, 'imp_zinc', { y: R + 0.005, z: -0.22 });
  clipBox.dispose();

  body
    .node('head', 0, 0, zTip + 0.03)
    .node('tip', 0, 0, zTip)
    .node('muzzle', 0, 0, zTip)
    .node('hand', 0, 0, 0);

  return {
    id: 'pipe',
    label: 'Dock Pipe',
    body,
    moving: {},
    nodes: {
      muzzle: [0, 0, zTip],
      head: [0, 0, zTip + 0.03],
      tip: [0, 0, zTip],
      /* Contact happens over the last 260 mm of the shaft, not at a point. */
      edge: [[0, 0, zTip], [0, 0, zTip + 0.26]],
      gripL: [0, 0, 0.075],
      /* In the hand: the shaft runs out through the fist, rolled so the
       * coupling's flat faces the camera on the swing. */
      hand: { pos: [0.012, -0.006, 0.0], rot: [0, 0, 0.06] },
      /* Slung across the back when holstered. */
      holster: { pos: [-0.1, 0.14, 0.19], rot: [0.25, 0.5, 1.15] },
    },
    span: LEN,
  };
}

/* ========================================================================== */
/*  BODY WRENCH                                                               */
/* ========================================================================== */

/**
 * A 24" adjustable wrench out of a body shop — the biggest one on the wall,
 * jaws opened to 50 mm, the knurl packed with grease.
 *
 * The FORK is the silhouette. Everything is built so that the open jaw reads as
 * a gap from any angle: the fixed jaw is thicker than the sliding one, they are
 * offset in Y, and the throat between them is a genuine hole rather than a dark
 * face.
 */
export function buildWrench(rng) {
  const LEN = 0.60;
  const zButt = 0.13;
  const zHead = zButt - LEN;

  const body = new Assembly('wrench');

  /* ---- handle: a forged I-section, not a cylinder ---------------------- */
  // A drop-forged wrench handle is a flattened oval with a web down the middle,
  // and it TAPERS: thick at the head, thin at the butt.
  const shankLen = LEN - 0.155;
  const shank = extrude(
    [
      [-0.0095, 0.021],
      [0.0095, 0.021],
      [0.0115, 0.004],
      [0.0095, -0.019],
      [-0.0095, -0.019],
      [-0.0115, 0.004],
    ],
    shankLen,
    { bevel: 0.0016, bevelSegments: 2 }
  );
  // Taper the free end down.
  {
    const pos = shank.getAttribute('position');
    for (let i = 0; i < pos.count; i++) {
      const t = THREE.MathUtils.clamp((pos.getZ(i) / shankLen) + 0.5, 0, 1);
      const k = 1 - 0.3 * t;
      pos.setX(i, pos.getX(i) * k);
      pos.setY(i, pos.getY(i) * (1 - 0.22 * t));
    }
    pos.needsUpdate = true;
    shank.computeVertexNormals();
  }
  body.add(shank, 'imp_forged', { z: zButt - shankLen / 2 - 0.005, ry: Math.PI });
  shank.dispose();

  // Hanging hole punched through the butt.
  const hangHole = tubeZ(0.0062, 0.0048, 0.026, 10, 0.0003);
  body.add(hangHole, 'cavity', { z: zButt - 0.018, rx: Math.PI / 2 });
  hangHole.dispose();
  const hangRim = ring(0.0062, 0.0016, 14, 6);
  body.add(hangRim, 'imp_forged', { z: zButt - 0.018 });
  hangRim.dispose();

  /* ---- the head ---------------------------------------------------------- */
  const headZ = zHead + 0.058;
  // Body of the head: a slab with the sliding-jaw slot cut through it.
  const headSlab = extrude(
    [
      [-0.017, 0.030],
      [0.017, 0.030],
      [0.020, 0.010],
      [0.014, -0.026],
      [-0.014, -0.026],
      [-0.020, 0.010],
    ],
    0.020,
    { bevel: 0.0018, bevelSegments: 2 }
  );
  body.add(headSlab, 'imp_forged', { z: headZ });
  headSlab.dispose();

  /* FIXED JAW — the upper one, thick, with a serrated gripping face. */
  const fixedJaw = extrude(
    [
      [-0.0155, 0],
      [0.0155, 0],
      [0.0155, 0.052],
      [0.0075, 0.052],
      [0.0075, 0.016],
      [-0.0155, 0.014],
    ],
    0.019,
    { bevel: 0.0012 }
  );
  body.add(fixedJaw, 'imp_forged', { y: 0.026, z: headZ, rx: 0, ry: -Math.PI / 2, rz: -Math.PI / 2 });
  fixedJaw.dispose();

  /* SLIDING JAW — the lower one, thinner, sitting 50 mm open. */
  const slideJaw = extrude(
    [
      [-0.0135, 0],
      [0.0135, 0],
      [0.0135, 0.044],
      [0.0065, 0.044],
      [0.0065, 0.013],
      [-0.0135, 0.011],
    ],
    0.016,
    { bevel: 0.0011 }
  );
  body.add(slideJaw, 'imp_forged', { y: -0.024, z: headZ - 0.0, ry: -Math.PI / 2, rz: Math.PI / 2 });
  slideJaw.dispose();

  // The jaw faces carry cut serrations — this is what a wrench bites with.
  for (const [yy, n, w] of [[0.030, 7, 0.019], [-0.028, 6, 0.016]]) {
    for (let i = 0; i < n; i++) {
      const s = box(w * 0.94, 0.0011, 0.0016, 0.0003, 1);
      body.add(s, 'imp_forged', {
        y: yy,
        z: zHead + 0.014 + i * 0.0052,
        rx: 0,
      });
      s.dispose();
    }
  }

  /* ---- the worm screw: the part that says "adjustable" ------------------ */
  const wormLen = 0.030;
  const worm = latheZ(
    (() => {
      const p = [];
      const n = 16;
      for (let i = 0; i <= n; i++) {
        const z = -wormLen / 2 + (i / n) * wormLen;
        p.push([z, 0.0092]);
        p.push([z + wormLen / n * 0.45, 0.0114]);
      }
      return p;
    })(),
    16
  );
  body.add(worm, 'imp_grease', { y: 0.001, z: headZ + 0.006, rx: Math.PI / 2 });
  worm.dispose();
  // Its shaft and the slot it runs in.
  const wormShaft = rodZ(0.0042, 0.0042, 0.042, 10, 0.0004);
  body.add(wormShaft, 'imp_steel', { y: 0.001, z: headZ + 0.006, rx: Math.PI / 2 });
  wormShaft.dispose();

  /* ---- grease, rag and tape -------------------------------------------- */
  // A red shop rag knotted round the handle — the only saturated colour on it.
  const rag = new THREE.SphereGeometry(0.019, 10, 8);
  rag.scale(1.0, 0.75, 1.55);
  dent(rag, rng, { count: 4, radius: 0.012, depth: 0.004 });
  body.add(rag, 'imp_paint_red', { y: -0.004, z: 0.055, rz: 0.4 });
  rag.dispose();
  const ragTail = extrude(
    [[-0.012, 0], [0.012, 0.004], [0.016, -0.036], [-0.006, -0.042]],
    0.0016,
    { bevel: 0.0004 }
  );
  body.add(ragTail, 'imp_paint_red', { y: -0.018, z: 0.062, rx: 0.2, ry: 0.5 });
  ragTail.dispose();

  // Friction tape on the grip section, under the hand.
  const wrap = tapeWrap(0.0125, 0.105, rng, { band: 0.018, thick: 0.001, seg: 12 });
  body.add(wrap, 'imp_tape_black', { z: -0.008, sx: 1.35, sy: 1.05 });
  wrap.dispose();

  body
    .node('head', 0, 0.004, zHead + 0.03)
    .node('hand', 0, 0, 0);

  return {
    id: 'wrench',
    label: 'Body Wrench',
    body,
    moving: {},
    nodes: {
      muzzle: [0, 0.004, zHead + 0.02],
      head: [0, 0.004, zHead + 0.03],
      tip: [0, 0.03, zHead],
      edge: [[0, 0.01, zHead], [0, 0, zHead + 0.14]],
      gripL: [0, 0, 0.06],
      hand: { pos: [0.011, -0.004, 0], rot: [0, 0, -0.08] },
      holster: { pos: [-0.13, -0.03, 0.13], rot: [0.1, 0.2, 1.5] },
    },
    span: LEN,
  };
}

/* ========================================================================== */
/*  CROWBAR                                                                   */
/* ========================================================================== */

/**
 * A 30" wrecking bar. Hexagonal stock, a gooseneck claw with a nail slot at one
 * end and a flat chisel at the other, painted oxide red and chipped back to
 * bare steel on every corner.
 *
 * It is the only asymmetric weapon in the melee set, so it is the one that
 * reads instantly at a distance: the hook breaks the straight line.
 */
export function buildCrowbar(rng) {
  const LEN = 0.75;
  const R = 0.0092;            // 18 mm hex across flats
  const zButt = 0.14;
  const zTip = zButt - LEN;

  const body = new Assembly('crowbar');

  /* ---- hexagonal shank -------------------------------------------------- */
  const shankLen = LEN - 0.15;
  const hex = new THREE.CylinderGeometry(R, R, shankLen, 6, 1);
  hex.rotateX(Math.PI / 2);
  hex.rotateZ(0.26);
  body.add(hex, 'imp_paint_red', { z: zButt - 0.02 - shankLen / 2 });
  hex.dispose();

  /* ---- the gooseneck: a real bent bar ----------------------------------- */
  // Swept along a curve so the bend has continuous section rather than being
  // two cylinders meeting at a corner.
  {
    const pts = [];
    const n = 14;
    for (let i = 0; i <= n; i++) {
      const t = i / n;
      // 150 degrees of arc, radius 32 mm, in the YZ plane.
      const a = t * 2.62;
      const rad = 0.032;
      pts.push(new THREE.Vector3(
        0,
        rad * (1 - Math.cos(a)) * 0.9,
        zTip + 0.128 - rad * Math.sin(a) * 1.15
      ));
    }
    const curve = new THREE.CatmullRomCurve3(pts);
    const neck = new THREE.TubeGeometry(curve, 22, R * 0.94, 6, false);
    neck.deleteAttribute('uv');
    neck.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(neck.getAttribute('position').count * 2), 2));
    body.add(neck, 'imp_paint_red', {});
    neck.dispose();
  }

  /* ---- the claw: a flattened, split, chamfered blade -------------------- */
  const claw = extrude(
    [
      [-0.0125, 0.0],
      [0.0125, 0.0],
      [0.0135, -0.028],
      [0.0095, -0.045],
      [0.0035, -0.050],
      [0.0035, -0.030],       // the nail slot, right side
      [-0.0035, -0.030],
      [-0.0035, -0.050],      // left side
      [-0.0095, -0.045],
      [-0.0135, -0.028],
    ],
    0.0092,
    { bevel: 0.0011, bevelSegments: 2 }
  );
  body.add(claw, 'imp_forged', { y: 0.053, z: zTip + 0.056, rx: -0.55 });
  claw.dispose();

  /* ---- the chisel end at the butt --------------------------------------- */
  const chisel = extrude(
    [
      [-0.011, 0.008],
      [0.011, 0.008],
      [0.013, -0.004],
      [0.010, -0.014],
      [-0.010, -0.014],
      [-0.013, -0.004],
    ],
    0.042,
    { bevel: 0.0012 }
  );
  // Flattened and swept: a pry bar tip is a wedge.
  {
    const pos = chisel.getAttribute('position');
    for (let i = 0; i < pos.count; i++) {
      const t = THREE.MathUtils.clamp(pos.getZ(i) / 0.042 + 0.5, 0, 1);
      pos.setY(i, pos.getY(i) * (1 - 0.55 * t));
      pos.setX(i, pos.getX(i) * (1 + 0.25 * t));
    }
    pos.needsUpdate = true;
    chisel.computeVertexNormals();
  }
  body.add(chisel, 'imp_forged', { z: zButt - 0.018, rx: 0.16 });
  chisel.dispose();

  /* ---- knurled grip band + tape ---------------------------------------- */
  const knurlRing = tubeZ(R + 0.0012, R - 0.0004, 0.075, 14, 0.0003);
  body.add(knurlRing, 'imp_forged', { z: -0.005 });
  knurlRing.dispose();
  for (let i = 0; i < 11; i++) {
    const rr = ring(R + 0.0016, 0.0009, 14, 5);
    rr.rotateY(Math.PI / 2);
    body.add(rr, 'imp_forged', { z: -0.04 + i * 0.0072 });
    rr.dispose();
  }
  const wrap = tapeWrap(R + 0.0009, 0.058, rng, { band: 0.016, thick: 0.0009, seg: 12 });
  body.add(wrap, 'imp_tape_black', { z: 0.062 });
  wrap.dispose();

  /* ---- paint chips as GEOMETRY on the high corners ---------------------- */
  // The material's wear mask handles the fine chipping; these are the big
  // flakes that have lifted, and they break the silhouette of the hex edge.
  for (let i = 0; i < 9; i++) {
    const z = zTip + 0.15 + rng.float() * (LEN - 0.3);
    const a = Math.floor(rng.float() * 6) * (Math.PI / 3) + 0.26;
    const s = 0.7 + rng.float() * 0.8;
    const chip = box(0.011 * s, 0.0006, 0.017 * s, 0.0002, 1);
    body.add(chip, 'imp_steel', {
      x: Math.cos(a) * (R * 0.88), y: Math.sin(a) * (R * 0.88), z,
      rz: a - Math.PI / 2, ry: rng.signed() * 0.3,
    });
    chip.dispose();
  }

  body.node('head', 0, 0.05, zTip + 0.03).node('hand', 0, 0, 0);

  return {
    id: 'crowbar',
    label: 'Crowbar',
    body,
    moving: {},
    nodes: {
      muzzle: [0, 0.03, zTip + 0.04],
      head: [0, 0.05, zTip + 0.03],
      tip: [0, 0.075, zTip + 0.02],
      edge: [[0, 0.06, zTip + 0.02], [0, 0, zTip + 0.2]],
      gripL: [0, 0, 0.07],
      hand: { pos: [0.011, -0.004, 0], rot: [0, 0, 0.04] },
      holster: { pos: [-0.12, 0.0, 0.16], rot: [0.15, 0.35, 1.35] },
    },
    span: LEN,
  };
}

/* ========================================================================== */
/*  FISTS                                                                     */
/* ========================================================================== */

/**
 * Bare hands: no weapon mesh at all — the character's own hands do the work.
 * A model entry still exists so the rest of the system does not need a special
 * case, and it carries the wrap: two turns of friction tape across the
 * knuckles, which is the only thing there is to draw and is worth drawing
 * because it is what tells you the fists are ARMED.
 */
export function buildFists(rng) {
  const body = new Assembly('fists');
  // Knuckle wrap, sitting on the back of the hand.
  for (let i = 0; i < 3; i++) {
    const b = box(0.052, 0.0016, 0.011, 0.0006, 1);
    dent(b, rng, { count: 2, radius: 0.008, depth: 0.0005 });
    body.add(b, 'imp_tape_black', {
      x: 0, y: 0.001 + i * 0.0004, z: -0.012 - i * 0.0125,
      rx: 0.1 * (i - 1), rz: rng.signed() * 0.05,
    });
    b.dispose();
  }
  // Across the palm.
  const palm = box(0.046, 0.0015, 0.014, 0.0006, 1);
  body.add(palm, 'imp_tape_duct', { y: -0.006, z: 0.006, rx: 1.35 });
  palm.dispose();

  body.node('hand', 0, 0, 0);
  return {
    id: 'fists',
    label: 'Fists',
    body,
    moving: {},
    nodes: {
      muzzle: [0, 0, -0.06],
      head: [0, 0, -0.05],
      tip: [0, 0, -0.07],
      edge: [[0, 0, -0.07], [0, 0, -0.01]],
      gripL: [0, 0, 0],
      hand: { pos: [0.004, 0.012, 0.01], rot: [0, 0, 0] },
      holster: null,
    },
    span: 0.1,
  };
}
