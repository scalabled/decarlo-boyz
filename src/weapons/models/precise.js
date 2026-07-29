import * as THREE from 'three';
import { Assembly } from '../geometry.js';
import {
  box, blob, latheZ, tubeZ, rodZ, extrude, ring, screw, knurlBand,
  pipe, coupling, flange, weldRing, tapeWrap, hoseRun,
  ropeCoil, boltHead, hoseClamp, gauge, barbedHead, nail,
  scavengedGrip, rodGuard, wireTrigger, dent,
} from './kit.js';

/**
 * PRECISE — Flare Gun, Spear Gun, Rivet Gun, Harpoon.
 *
 * One heavy projectile at a time, aimed. Three of the four are single-shot and
 * their reload IS the fire cycle, so every one of them has a visible mechanism
 * that the reload animation drives: a break-open hinge, two rubber slings, a
 * strip magazine, a rope drum.
 *
 * SILHOUETTE BRIEF:
 *   Flare Gun   short, fat, and an ENORMOUS bore for its length — a signal
 *               pistol reads as "a toy that is all barrel"
 *   Spear Gun   a long thin rail with a shaft sticking a long way past it and
 *               two black rubber loops at the front
 *   Rivet Gun   a fat cylinder with a SPRING coiled round the protruding set
 *   Harpoon     the biggest thing in the game: barbed flukes at the front, a
 *               drum of rope on the side, a shoulder pad at the back
 */

/* ========================================================================== */
/*  FLARE GUN                                                                 */
/* ========================================================================== */

/**
 * A 25 mm marine signal pistol. Orange high-visibility ABS, a break-open
 * barrel, a big exposed hammer and a lanyard ring — everything oversized,
 * because a signal pistol is designed to be found and operated in the dark with
 * cold wet hands.
 *
 * Real numbers: 25.4 mm bore, 145 mm barrel, 210 mm overall, 570 g.
 */
export function buildFlareGun(rng) {
  const bore = 0.052;
  const zMuzzle = -0.152;
  const body = new Assembly('flare');

  /* ---- frame ------------------------------------------------------------ */
  const frame = extrude(
    [
      [-0.036, 0.030],
      [0.020, 0.032],
      [0.030, 0.018],
      [0.028, -0.010],
      [-0.020, -0.014],
      [-0.038, 0.004],
    ],
    0.030,
    { bevel: 0.0022, bevelSegments: 2 }
  );
  body.add(frame, 'imp_paint_orange', { y: bore - 0.030, z: 0.006, ry: Math.PI / 2 });
  frame.dispose();

  // Moulding seam down the middle: two halves screwed together, as it really is.
  const seam = box(0.0016, 0.052, 0.075, 0.0003, 1);
  body.add(seam, 'imp_paint_orange', { y: bore - 0.024, z: 0.004 });
  seam.dispose();
  for (const [yy, zz] of [[bore - 0.012, 0.020], [bore - 0.040, -0.004]]) {
    const s = screw(0.0038, 0.0018, 0.0013, 0.005, 10);
    body.add(s, 'imp_zinc', { x: 0.0152, y: yy, z: zz, ry: -Math.PI / 2 });
    s.dispose();
  }

  /* ---- BARREL: the read. 25 mm bore on a 210 mm gun. -------------------- */
  const barrelAsm = new Assembly('flare-barrel');
  const brl = latheZ(
    [
      [0.062, 0], [0.062, 0.0212],
      [0.058, 0.0224],
      [-0.062, 0.0224],
      [-0.066, 0.0208],
      [-0.070, 0.0196], [-0.070, 0],
    ],
    22
  );
  barrelAsm.add(brl, 'imp_paint_orange', { y: bore, z: -0.082 });
  brl.dispose();
  // Rifling-less smooth bore, black inside, with the shell head visible.
  const boreHole = tubeZ(0.0132, 0.0006, 0.115, 16, 0.0004);
  barrelAsm.add(boreHole, 'cavity', { y: bore, z: -0.088 });
  boreHole.dispose();
  const muzzleRing = tubeZ(0.0224, 0.0132, 0.0035, 22, 0.0005);
  barrelAsm.add(muzzleRing, 'imp_grease', { y: bore, z: zMuzzle + 0.002 });
  muzzleRing.dispose();
  // Stiffening ribs along the top of the barrel.
  for (const sx of [-1, 1]) {
    const rib = box(0.0035, 0.010, 0.110, 0.0008, 1);
    barrelAsm.add(rib, 'imp_paint_orange', { x: sx * 0.012, y: bore + 0.019, z: -0.086 });
    rib.dispose();
  }
  // A blade front sight moulded into the rib, and a notch at the back.
  const fs = extrude([[-0.0035, 0], [0.0035, 0], [0.0028, 0.010], [-0.0028, 0.010]], 0.004, { bevel: 0.0005 });
  barrelAsm.add(fs, 'imp_paint_orange', { y: bore + 0.024, z: -0.138 });
  fs.dispose();

  // The brass shell in the chamber — visible because the breech end is open.
  const shellAsm = new Assembly('flare-shell');
  const shell = latheZ(
    [
      [0, 0], [0, 0.0138], [0.0028, 0.0138], [0.0028, 0.0126],
      [0.058, 0.0126], [0.058, 0],
    ],
    18
  );
  shellAsm.add(shell, 'imp_brass', { y: bore, z: -0.030 });
  shell.dispose();
  const primer = latheZ([[0, 0], [0, 0.0032], [0.0015, 0.0032], [0.0015, 0]], 10);
  shellAsm.add(primer, 'imp_copper', { y: bore, z: -0.030 });
  primer.dispose();
  // Red plastic body forward of the brass head.
  const shellBody = tubeZ(0.0125, 0.0115, 0.052, 16, 0.0004);
  shellAsm.add(shellBody, 'imp_paint_red', { y: bore, z: -0.062 });
  shellBody.dispose();

  /* ---- hinge, latch, hammer --------------------------------------------- */
  const hinge = rodZ(0.0042, 0.0042, 0.032, 10, 0.0004);
  body.add(hinge, 'imp_chrome', { y: bore - 0.021, z: -0.030, rx: Math.PI / 2 });
  hinge.dispose();
  const latch = box(0.010, 0.014, 0.024, 0.0012, 1);
  body.add(latch, 'imp_chrome', { x: 0.017, y: bore + 0.008, z: 0.014 });
  latch.dispose();
  const latchKnurl = knurlBand(0.006, 0.014, 12, 0.0004, 3);
  body.add(latchKnurl, 'imp_chrome', { x: 0.017, y: bore + 0.008, z: 0.014, ry: Math.PI / 2 });
  latchKnurl.dispose();

  const hammer = new Assembly('flare-hammer');
  const ham = extrude(
    [[-0.006, 0], [0.006, 0], [0.008, 0.026], [0.001, 0.034], [-0.008, 0.030]],
    0.011,
    { bevel: 0.0008 }
  );
  hammer.add(ham, 'imp_grease', { y: 0, z: 0 });
  ham.dispose();
  const spur = box(0.013, 0.0035, 0.009, 0.0006, 1);
  hammer.add(spur, 'imp_grease', { y: 0.032, z: -0.003, rx: 0.4 });
  spur.dispose();

  /* ---- grip -------------------------------------------------------------- */
  const grip = scavengedGrip('tool', { len: 0.096, w: 0.034, d: 0.044 });
  body.add(grip, 'imp_paint_orange', { y: -0.030, z: 0.014, rx: 1.22 });
  grip.dispose();
  // Moulded finger grooves + a chequered panel.
  for (let i = 0; i < 4; i++) {
    const g = new THREE.TorusGeometry(0.019, 0.0022, 5, 12, Math.PI * 1.1);
    body.add(g, 'imp_paint_orange', { y: -0.010 - i * 0.021, z: 0.030 - i * 0.008, rx: 1.22, rz: -Math.PI / 2 });
    g.dispose();
  }
  const guard = rodGuard(0.044, 0.034, 0.0035);
  body.add(guard, 'imp_paint_orange', { y: 0.012, z: -0.022 });
  guard.dispose();
  const trigger = new Assembly('flare-trigger');
  const trg = wireTrigger({ thick: 0.008 });
  trigger.add(trg, 'imp_chrome', {});
  trg.dispose();

  /* ---- lanyard ring + a wrap of orange tape ----------------------------- */
  const lug = box(0.006, 0.010, 0.008, 0.0008, 1);
  body.add(lug, 'imp_chrome', { y: -0.076, z: 0.044 });
  lug.dispose();
  const lring = ring(0.009, 0.0015, 12, 5);
  body.add(lring, 'imp_chrome', { y: -0.086, z: 0.048, rx: 0.3 });
  lring.dispose();
  const cord = hoseRun([0, -0.092, 0.048], [0.020, -0.132, 0.020], 0.026, { radius: 0.0022, steps: 8, seg: 5 });
  body.add(cord, 'imp_rope', {});
  cord.dispose();
  const wrap = tapeWrap(0.018, 0.038, rng, { band: 0.016, thick: 0.001, seg: 12, tail: false });
  body.add(wrap, 'imp_tape_duct', { y: -0.048, z: 0.018, rx: 1.22, sx: 1.05, sy: 1.2 });
  wrap.dispose();

  return {
    id: 'flare',
    label: 'Flare Gun',
    body,
    moving: { trigger, hammer, barrel: barrelAsm, shell: shellAsm },
    nodes: {
      triggerSeat: { pos: [0, 0.006, -0.018], rot: [0, 0, 0] },
      triggerPull: -0.34,
      hammerSeat: { pos: [0, bore - 0.008, 0.026], rot: [0, 0, 0] },
      hammerCock: 0.85,
      /* The break: barrel and shell hinge down together about the pin. */
      barrelSeat: { pos: [0, 0, 0], rot: [0, 0, 0] },
      shellSeat: { pos: [0, 0, 0], rot: [0, 0, 0] },
      breakPivot: [0, bore - 0.021, -0.030],
      breakAngle: 0.62,
      muzzle: [0, bore, zMuzzle],
      eject: [0, bore, -0.020],
      ejectDir: [0.15, 0.55, 0.82],
      gripL: [-0.022, bore - 0.030, -0.020],
      hand: { pos: [0.011, -0.004, 0.006], rot: [0, 0, 0] },
      holster: { pos: [-0.11, -0.08, 0.06], rot: [0, 0.3, 0.1] },
      glow: [{ pos: [0, bore, -0.120], mat: 'glow_flare', r: 0.010 }],
    },
    span: 0.23,
  };
}

/* ========================================================================== */
/*  SPEAR GUN                                                                 */
/* ========================================================================== */

/**
 * A 90 cm band-powered speargun off Carson's boat, with the salt still on it.
 *
 * Two 16 mm latex slings, a 7 mm stainless shaft with a single barb, an
 * anodised aluminium rail, a moulded handle with a stainless trigger mech and a
 * line reel on the left. Silent — no flash, no report, nothing on the radio.
 */
export function buildSpearGun(rng) {
  const bore = 0.052;
  const railLen = 0.72;
  const zRailFront = -0.735;
  const zShaftTip = -0.98;
  const body = new Assembly('speargun');

  /* ---- the rail: an extruded aluminium section, not a tube -------------- */
  const rail = extrude(
    [
      [-0.017, 0.012],
      [-0.006, 0.016],
      [0.006, 0.016],
      [0.017, 0.012],
      [0.019, -0.006],
      [0.010, -0.016],
      [-0.010, -0.016],
      [-0.019, -0.006],
    ],
    railLen,
    { bevel: 0.0016, bevelSegments: 2 }
  );
  dent(rail, rng, { count: 4, radius: 0.03, depth: 0.0012 });
  body.add(rail, 'imp_galv', { y: bore, z: zRailFront + railLen / 2 });
  rail.dispose();
  // The shaft track down the top: a genuine groove, so the shaft sits IN it.
  const track = box(0.0092, 0.008, railLen + 0.004, 0.0006, 1);
  body.add(track, 'cavity', { y: bore + 0.014, z: zRailFront + railLen / 2 });
  track.dispose();
  // Line guides: three stainless loops along the rail.
  for (let i = 0; i < 3; i++) {
    const lg = ring(0.006, 0.0012, 12, 5);
    body.add(lg, 'imp_chrome', { x: -0.019, y: bore + 0.002, z: -0.16 - i * 0.20, ry: Math.PI / 2 });
    lg.dispose();
  }
  // Salt corrosion blooms where the anodising has failed.
  for (let i = 0; i < 7; i++) {
    const s = new THREE.SphereGeometry(0.006 + rng.float() * 0.005, 7, 5);
    s.scale(1.5, 0.3, 2.0);
    const a = rng.float() * Math.PI * 2;
    body.add(s, 'imp_rust', {
      x: Math.cos(a) * 0.017, y: bore + Math.sin(a) * 0.014,
      z: -0.10 - rng.float() * 0.58, rz: a, ry: rng.signed() * 0.5,
    });
    s.dispose();
  }

  /* ---- muzzle bridle: the closed loop the slings hook through ---------- */
  const bridle = latheZ(
    [[0, 0], [0, 0.020], [0.010, 0.024], [0.028, 0.024], [0.034, 0.019], [0.034, 0]],
    18
  );
  body.add(bridle, 'imp_grease', { y: bore, z: zRailFront - 0.016, ry: Math.PI });
  bridle.dispose();
  const bridleHole = tubeZ(0.0125, 0.0048, 0.040, 12, 0.0004);
  body.add(bridleHole, 'cavity', { y: bore, z: zRailFront - 0.014 });
  bridleHole.dispose();
  for (const sx of [-1, 1]) {
    const ear = extrude([[0, 0], [0.018, 0], [0.018, 0.014], [0, 0.018]], 0.005, { bevel: 0.0006 });
    body.add(ear, 'imp_grease', { x: sx * 0.021, y: bore + 0.004, z: zRailFront - 0.020, ry: sx * Math.PI / 2 });
    ear.dispose();
  }

  /* ---- THE SLINGS: two thick latex tubes with wishbones ---------------- */
  const slings = new Assembly('speargun-slings');
  for (const sx of [-1, 1]) {
    const s = hoseRun(
      [sx * 0.030, bore + 0.006, zRailFront - 0.028],
      [sx * 0.009, bore + 0.016, zRailFront + 0.245],
      -0.028,
      { radius: 0.0085, steps: 12, seg: 8 }
    );
    slings.add(s, 'imp_hose', {});
    s.dispose();
    // The whipping at the muzzle end.
    const whip = tubeZ(0.0098, 0.0082, 0.014, 10, 0.0003);
    slings.add(whip, 'imp_tape_black', { x: sx * 0.029, y: bore + 0.007, z: zRailFront - 0.020, ry: sx * 0.2 });
    whip.dispose();
  }
  // The wishbone: a loop of dyneema over the shaft's notch.
  const wish = ring(0.010, 0.0016, 12, 5);
  slings.add(wish, 'imp_rope', { y: bore + 0.015, z: zRailFront + 0.248, rx: 0.2, ry: Math.PI / 2 });
  wish.dispose();

  /* ---- the shaft -------------------------------------------------------- */
  const shaft = new Assembly('speargun-shaft');
  const shank = rodZ(0.0035, 0.0035, 0.90, 10, 0.0004);
  shaft.add(shank, 'imp_chrome', { y: bore + 0.014, z: zShaftTip + 0.47 });
  shank.dispose();
  // Sharkfin tabs (the notches the wishbone loads against).
  for (let i = 0; i < 3; i++) {
    const tab = extrude([[0, 0], [0.012, 0.0], [0.006, 0.008], [0, 0.008]], 0.0022, { bevel: 0.0004 });
    shaft.add(tab, 'imp_chrome', { y: bore + 0.017, z: zRailFront + 0.24 + i * 0.055, ry: -Math.PI / 2 });
    tab.dispose();
  }
  // The barb: a sprung fin hinged behind the point.
  const head = barbedHead(0.0042, 0.055, { barbs: 1, seg: 4, barbPhase: Math.PI * 0.5 });
  shaft.add(head, 'imp_forged', { y: bore + 0.014, z: zShaftTip + 0.055, ry: Math.PI });
  head.dispose();

  /* ---- reel ------------------------------------------------------------- */
  const reelR = 0.036;
  const reel = latheZ(
    [
      [-0.012, 0], [-0.012, reelR], [-0.009, reelR],
      [-0.007, reelR - 0.010], [0.007, reelR - 0.010],
      [0.009, reelR], [0.012, reelR], [0.012, 0],
    ],
    20
  );
  body.add(reel, 'imp_plastic', { x: -0.033, y: bore - 0.012, z: -0.028, ry: Math.PI / 2 });
  reel.dispose();
  const line = ropeCoil(reelR - 0.012, 5, rng, { radius: 0.0018, layers: 2 });
  body.add(line, 'imp_rope', { x: -0.033, y: bore - 0.012, z: -0.028, ry: Math.PI / 2 });
  line.dispose();
  const reelArm = box(0.007, 0.020, 0.030, 0.0012, 1);
  body.add(reelArm, 'imp_chrome', { x: -0.024, y: bore - 0.012, z: -0.028 });
  reelArm.dispose();
  const crank = box(0.026, 0.005, 0.006, 0.0008, 1);
  body.add(crank, 'imp_chrome', { x: -0.046, y: bore - 0.012, z: -0.028, ry: Math.PI / 2, rz: 0.7 });
  crank.dispose();
  // The line from the reel forward to the shaft.
  const runLine = hoseRun([-0.033, bore - 0.046, -0.028], [-0.019, bore + 0.002, zRailFront + 0.02], 0.03, { radius: 0.0015, steps: 12, seg: 4 });
  body.add(runLine, 'imp_rope', {});
  runLine.dispose();

  /* ---- handle ----------------------------------------------------------- */
  const handle = blob(0.036, 0.062, 0.100, 0.010, 3);
  body.add(handle, 'imp_plastic', { y: -0.024, z: 0.016, rx: 1.30 });
  handle.dispose();
  const butt = blob(0.042, 0.052, 0.024, 0.010, 3);
  body.add(butt, 'imp_hose', { y: bore - 0.006, z: 0.062 });
  butt.dispose();
  const guard = rodGuard(0.050, 0.040, 0.0032);
  body.add(guard, 'imp_chrome', { y: 0.012, z: -0.026 });
  guard.dispose();
  const trigger = new Assembly('speargun-trigger');
  const trg = wireTrigger({ thick: 0.009 });
  trigger.add(trg, 'imp_chrome', {});
  trg.dispose();
  // The safety lever and the loading pad on the butt.
  const safety = box(0.020, 0.006, 0.010, 0.0008, 1);
  body.add(safety, 'imp_paint_orange', { x: 0.019, y: bore - 0.018, z: 0.020, rz: 0.3 });
  safety.dispose();

  return {
    id: 'speargun',
    label: 'Spear Gun',
    body,
    moving: { trigger, shaft, slings },
    nodes: {
      triggerSeat: { pos: [0, 0.008, -0.022], rot: [0, 0, 0] },
      triggerPull: -0.3,
      shaftSeat: { pos: [0, 0, 0], rot: [0, 0, 0] },
      shaftTravel: [0, 0, -0.30],
      slingsSeat: { pos: [0, 0, 0], rot: [0, 0, 0] },
      muzzle: [0, bore + 0.014, zRailFront - 0.02],
      eject: [0, bore + 0.02, -0.05],
      ejectDir: [0, 1, 0.2],
      gripL: [0, bore - 0.030, -0.34],
      hand: { pos: [0.011, -0.004, 0.006], rot: [0, 0, 0] },
      holster: { pos: [-0.16, 0.04, 0.16], rot: [0.1, 0.35, 0.9] },
    },
    span: 1.05,
  };
}

/* ========================================================================== */
/*  RIVET GUN                                                                 */
/* ========================================================================== */

/**
 * A pneumatic structural rivet hammer off the mill's boiler shop. 4X — the big
 * one, for 3/8" rivets. It hits at 1500 blows a minute and it will punch a rivet
 * through a car door.
 *
 * The read is the SPRING RETAINER coiled around the protruding set: no other
 * weapon in the game has an exposed helical spring at the muzzle, and it is
 * legible from a long way off.
 */
export function buildRivetGun(rng) {
  const bore = 0.058;
  const zMuzzle = -0.315;
  const body = new Assembly('rivetgun');

  /* ---- barrel / cylinder ------------------------------------------------ */
  const cyl = latheZ(
    [
      [0.105, 0], [0.105, 0.026],
      [0.098, 0.030],
      [0.030, 0.030],
      [0.022, 0.027],
      [-0.096, 0.027],
      [-0.104, 0.023], [-0.104, 0],
    ],
    22
  );
  dent(cyl, rng, { count: 4, radius: 0.024, depth: 0.0015 });
  body.add(cyl, 'imp_grease', { y: bore, z: -0.145 });
  cyl.dispose();
  // Machined bands: this is a turned part and it should look turned.
  for (const dz of [-0.070, -0.118, -0.192]) {
    const b = ring(0.0285, 0.0022, 22, 6);
    b.rotateY(Math.PI / 2);
    body.add(b, 'imp_chrome', { y: bore, z: dz });
    b.dispose();
  }
  const hexCollar = new THREE.CylinderGeometry(0.032, 0.032, 0.020, 6, 1);
  hexCollar.rotateX(Math.PI / 2);
  body.add(hexCollar, 'imp_steel', { y: bore, z: -0.236, rz: 0.5 });
  hexCollar.dispose();

  /* ---- the set (the tool bit) and its retaining spring ------------------ */
  const set = rodZ(0.0088, 0.0082, 0.086, 12, 0.0008);
  body.add(set, 'imp_chrome', { y: bore, z: -0.286 });
  set.dispose();
  const setFace = latheZ([[0, 0], [0, 0.0082], [0.004, 0.0068], [0.004, 0]], 12);
  body.add(setFace, 'cavity', { y: bore, z: zMuzzle, ry: Math.PI });
  setFace.dispose();
  {
    // A real helix, 9 turns of 2.4 mm wire around the set.
    const pts = [];
    const turns = 9, len = 0.068, r = 0.0135;
    for (let i = 0; i <= turns * 12; i++) {
      const t = i / (turns * 12);
      const a = t * turns * Math.PI * 2;
      pts.push(new THREE.Vector3(Math.cos(a) * r, Math.sin(a) * r, -t * len));
    }
    const g = new THREE.TubeGeometry(new THREE.CatmullRomCurve3(pts), turns * 14, 0.0013, 5, false);
    g.deleteAttribute('uv');
    g.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(g.getAttribute('position').count * 2), 2));
    body.add(g, 'imp_steel', { y: bore, z: -0.250 });
    g.dispose();
  }
  const springCup = latheZ([[0, 0.0092], [0, 0.017], [0.008, 0.017], [0.008, 0.0092]], 16);
  body.add(springCup, 'imp_steel', { y: bore, z: -0.322 });
  springCup.dispose();

  /* ---- rivet strip magazine on top -------------------------------------- */
  const magHouse = box(0.026, 0.024, 0.115, 0.0018, 1);
  body.add(magHouse, 'imp_paint_orange', { y: bore + 0.040, z: -0.170, rx: -0.10 });
  magHouse.dispose();
  const magSlot = box(0.0032, 0.014, 0.098, 0.0004, 1);
  body.add(magSlot, 'cavity', { x: 0.0132, y: bore + 0.040, z: -0.170, rx: -0.10 });
  magSlot.dispose();
  // Rivets visible in the strip.
  const mag = new Assembly('rivetgun-mag');
  for (let i = 0; i < 9; i++) {
    const rv = latheZ([[0, 0], [0, 0.0055], [0.0032, 0.0055], [0.0038, 0.0038], [0.020, 0.0034], [0.020, 0]], 8);
    mag.add(rv, 'imp_zinc', { x: 0.008, y: bore + 0.038 - i * 0.0006, z: -0.222 + i * 0.0112, rx: Math.PI / 2 - 0.1 });
    rv.dispose();
  }
  const follower = box(0.020, 0.018, 0.010, 0.0012, 1);
  mag.add(follower, 'imp_paint_orange', { y: bore + 0.040, z: -0.112, rx: -0.10 });
  follower.dispose();

  /* ---- air motor plumbing ---------------------------------------------- */
  const throttleBlock = box(0.036, 0.030, 0.044, 0.0022, 2);
  body.add(throttleBlock, 'imp_steel', { y: bore - 0.014, z: 0.002 });
  throttleBlock.dispose();
  const inlet = latheZ([[0, 0], [0, 0.0105], [0.008, 0.0122], [0.020, 0.0122], [0.022, 0.010], [0.030, 0.010], [0.030, 0]], 14);
  body.add(inlet, 'imp_brass', { y: bore - 0.048, z: 0.048, rx: 1.05 });
  inlet.dispose();
  {
    const h = hoseRun([0.004, bore - 0.084, 0.070], [0.052, bore - 0.190, 0.100], 0.05, { radius: 0.0082, steps: 12 });
    body.add(h, 'imp_hose', {});
    h.dispose();
    const c = hoseClamp(0.0092, 0.009);
    body.add(c, 'imp_zinc', { y: bore - 0.070, z: 0.062, rx: 1.0 });
    c.dispose();
  }
  {
    const g = gauge(0.0145);
    body.add(g.body, 'imp_brass', { x: -0.030, y: bore + 0.014, z: -0.050, ry: -1.0, rx: -0.2 });
    body.add(g.face, 'imp_plastic', { x: -0.0313, y: bore + 0.0169, z: -0.0492, ry: -1.0, rx: -0.2 });
    body.add(g.needle, 'imp_paint_red', { x: -0.0316, y: bore + 0.017, z: -0.0491, ry: -1.0, rx: -0.2, rz: 1.2 });
    g.body.dispose(); g.face.dispose(); g.needle.dispose();
  }

  /* ---- grip, guard, trigger, fore-grip ---------------------------------- */
  const grip = scavengedGrip('wood', { len: 0.112, w: 0.036, d: 0.048 });
  body.add(grip, 'imp_wood', { y: -0.046, z: 0.014, rx: 1.28 });
  grip.dispose();
  const guard = rodGuard(0.050, 0.038, 0.0034);
  body.add(guard, 'imp_steel', { y: 0.012, z: -0.028 });
  guard.dispose();
  const trigger = new Assembly('rivetgun-trigger');
  const trg = wireTrigger({ thick: 0.010 });
  trigger.add(trg, 'imp_chrome', {});
  trg.dispose();

  // The fore-grip is a second bicycle grip clamped to the cylinder — you hold a
  // rivet hammer with both hands or it takes your wrist off.
  const fg = scavengedGrip('bike', { len: 0.092, w: 0.034 });
  body.add(fg, 'imp_hose', { y: bore - 0.070, z: -0.190, rx: 1.36 });
  fg.dispose();
  const fgBracket = box(0.012, 0.052, 0.026, 0.0016, 1);
  body.add(fgBracket, 'imp_steel', { y: bore - 0.038, z: -0.190 });
  fgBracket.dispose();
  const fgClamp = hoseClamp(0.0305, 0.011);
  body.add(fgClamp, 'imp_zinc', { y: bore, z: -0.190 });
  fgClamp.dispose();

  // Stencilled property mark, in geometry so it survives at any texel density.
  for (let i = 0; i < 4; i++) {
    const bar = box(0.0022, 0.012, 0.0009, 0.0002, 1);
    body.add(bar, 'imp_paint_yellow', { x: -0.0285, y: bore - 0.010, z: -0.120 + i * 0.0055, ry: -Math.PI / 2 });
    bar.dispose();
  }

  return {
    id: 'rivetgun',
    label: 'Rivet Gun',
    body,
    moving: { trigger, mag },
    nodes: {
      triggerSeat: { pos: [0, 0.008, -0.024], rot: [0, 0, 0] },
      triggerPull: -0.3,
      magSeat: { pos: [0, 0, 0], rot: [0, 0, 0] },
      magDrop: [0.4, -0.3, 0],
      muzzle: [0, bore, zMuzzle - 0.006],
      eject: [0.028, bore + 0.010, -0.02],
      ejectDir: [0.95, 0.3, 0.05],
      gripL: [0, bore - 0.072, -0.190],
      hand: { pos: [0.011, -0.004, 0.006], rot: [0, 0, 0] },
      holster: { pos: [-0.15, -0.04, 0.12], rot: [0, 0.3, 0.22] },
    },
    span: 0.55,
  };
}

/* ========================================================================== */
/*  HARPOON                                                                   */
/* ========================================================================== */

/**
 * A whaling gun off a scrapped river tug: a cast bronze breech, a short fat
 * barrel, a 1.1 m iron harpoon with folding flukes, and a drum of manila on the
 * side that pays out when you hit something.
 *
 * The heaviest, slowest, hardest-hitting thing Carson carries, and the only
 * weapon in the game whose projectile stays connected to it.
 */
export function buildHarpoon(rng) {
  const bore = 0.070;
  const zMuzzle = -0.42;
  const zTip = -0.86;
  const body = new Assembly('harpoon');

  /* ---- breech: a heavy casting ----------------------------------------- */
  const breech = latheZ(
    [
      [0.115, 0], [0.115, 0.030],
      [0.104, 0.044],
      [0.060, 0.048],
      [0.030, 0.046],
      [-0.010, 0.042],
      [-0.030, 0.036], [-0.030, 0],
    ],
    22
  );
  dent(breech, rng, { count: 5, radius: 0.03, depth: 0.0022 });
  body.add(breech, 'imp_brass', { y: bore, z: -0.075 });
  breech.dispose();
  // Cast ribs radiating off the breech — a casting has webs, a turning does not.
  for (let i = 0; i < 6; i++) {
    const a = (i / 6) * Math.PI * 2 + 0.3;
    const rib = extrude([[0, 0], [0.070, 0], [0.062, 0.012], [0, 0.016]], 0.005, { bevel: 0.0008 });
    body.add(rib, 'imp_brass', {
      x: Math.cos(a) * 0.040, y: bore + Math.sin(a) * 0.040, z: -0.095,
      rz: a + Math.PI / 2, ry: -Math.PI / 2,
    });
    rib.dispose();
  }
  const breechWeld = weldRing(0.031, rng, { radius: 0.0022, count: 20 });
  body.add(breechWeld, 'imp_steel', { y: bore, z: -0.190 });
  breechWeld.dispose();

  /* ---- barrel ----------------------------------------------------------- */
  const brl = pipe(0.0305, 0.0055, 0.235, { seg: 22, bow: 0.0016 });
  dent(brl, rng, { count: 5, radius: 0.03, depth: 0.002 });
  body.add(brl, 'imp_rust', { y: bore, z: -0.305 });
  brl.dispose();
  const boreHole = tubeZ(0.0248, 0.0116, 0.10, 18, 0.0005);
  body.add(boreHole, 'cavity', { y: bore, z: -0.372 });
  boreHole.dispose();
  const muzzleFlange = flange(0.0305, 0.046, 0.010, 4);
  body.add(muzzleFlange, 'imp_forged', { y: bore, z: zMuzzle + 0.006 });
  muzzleFlange.dispose();
  for (const dz of [-0.235, -0.330]) {
    const band = coupling(0.0308, { len: 0.024, wall: 0.005, seg: 20, hex: false });
    body.add(band, 'imp_forged', { y: bore, z: dz });
    band.dispose();
  }

  /* ---- THE HARPOON ------------------------------------------------------ */
  const spear = new Assembly('harpoon-shaft');
  const shaft = rodZ(0.0112, 0.0104, 0.62, 12, 0.0008);
  spear.add(shaft, 'imp_forged', { y: bore, z: zTip + 0.40 });
  shaft.dispose();
  // The head: a heavy leaf point with two big folding flukes.
  const head = barbedHead(0.0165, 0.135, { barbs: 2, seg: 4 });
  spear.add(head, 'imp_forged', { y: bore, z: zTip + 0.135, ry: Math.PI });
  head.dispose();
  // The toggle: a hinged bar behind the flukes that turns sideways in the wound.
  const toggle = box(0.062, 0.010, 0.020, 0.0016, 1);
  spear.add(toggle, 'imp_forged', { y: bore, z: zTip + 0.170, rz: 0.25 });
  toggle.dispose();
  const togglePin = rodZ(0.0034, 0.0034, 0.024, 8, 0.0004);
  spear.add(togglePin, 'imp_chrome', { y: bore, z: zTip + 0.170, rx: Math.PI / 2 });
  togglePin.dispose();
  // The line eye, and the rope leaving it.
  const eye = ring(0.011, 0.0032, 14, 6);
  spear.add(eye, 'imp_forged', { y: bore + 0.016, z: zTip + 0.215, rx: Math.PI / 2, ry: 0 });
  eye.dispose();
  const lead = hoseRun([0, bore + 0.024, zTip + 0.215], [0.030, bore + 0.012, -0.30], 0.02, { radius: 0.0038, steps: 12, seg: 6 });
  spear.add(lead, 'imp_rope', {});
  lead.dispose();

  /* ---- rope drum -------------------------------------------------------- */
  const drumR = 0.030;
  const drum = latheZ(
    [[-0.052, 0], [-0.052, 0.052], [-0.046, 0.052], [-0.044, drumR], [0.044, drumR], [0.046, 0.052], [0.052, 0.052], [0.052, 0]],
    20
  );
  body.add(drum, 'imp_steel', { x: 0.056, y: bore - 0.008, z: -0.085, ry: Math.PI / 2 });
  drum.dispose();
  const coil = ropeCoil(drumR, 7, rng, { radius: 0.0048, layers: 2 });
  body.add(coil, 'imp_rope', { x: 0.056, y: bore - 0.008, z: -0.085, ry: Math.PI / 2 });
  coil.dispose();
  const drumArm = box(0.030, 0.016, 0.026, 0.0016, 1);
  body.add(drumArm, 'imp_steel', { x: 0.032, y: bore - 0.008, z: -0.085 });
  drumArm.dispose();
  const drumHandle = box(0.005, 0.048, 0.006, 0.0008, 1);
  body.add(drumHandle, 'imp_forged', { x: 0.112, y: bore - 0.008, z: -0.085, rz: 0.3 });
  drumHandle.dispose();
  const drumKnob = blob(0.010, 0.014, 0.010, 0.004, 3);
  body.add(drumKnob, 'imp_wood', { x: 0.112, y: bore + 0.036, z: -0.085 });
  drumKnob.dispose();

  /* ---- hooped sight, hammer, shoulder stock ---------------------------- */
  const hoop = new THREE.TorusGeometry(0.020, 0.0022, 6, 18);
  body.add(hoop, 'imp_forged', { y: bore + 0.052, z: -0.400 });
  hoop.dispose();
  const hoopPost = box(0.006, 0.020, 0.006, 0.0008, 1);
  body.add(hoopPost, 'imp_forged', { y: bore + 0.036, z: -0.400 });
  hoopPost.dispose();
  const rearNotch = extrude([[-0.014, 0], [0.014, 0], [0.014, 0.016], [0.003, 0.016], [0, 0.007], [-0.003, 0.016], [-0.014, 0.016]], 0.005, { bevel: 0.0006 });
  body.add(rearNotch, 'imp_forged', { y: bore + 0.046, z: -0.040 });
  rearNotch.dispose();

  const hammer = new Assembly('harpoon-hammer');
  const ham = extrude([[-0.008, 0], [0.008, 0], [0.010, 0.038], [0.001, 0.048], [-0.010, 0.042]], 0.014, { bevel: 0.001 });
  hammer.add(ham, 'imp_forged', {});
  ham.dispose();
  const hamKnurl = box(0.019, 0.005, 0.012, 0.0008, 1);
  hammer.add(hamKnurl, 'imp_forged', { y: 0.046, z: -0.004, rx: 0.4 });
  hamKnurl.dispose();

  // The stock: a length of 4x2 with a leather pad nailed to it.
  const stock = extrude(
    [[-0.030, 0.048], [0.030, 0.048], [0.036, 0.010], [0.030, -0.030], [-0.030, -0.030], [-0.036, 0.010]],
    0.200,
    { bevel: 0.0035, bevelSegments: 2 }
  );
  body.add(stock, 'imp_wood', { y: bore - 0.038, z: 0.150, rx: -0.10, ry: Math.PI / 2, rz: 0 });
  stock.dispose();
  const pad = blob(0.070, 0.106, 0.028, 0.010, 3);
  body.add(pad, 'imp_leather', { y: bore - 0.052, z: 0.248, rx: -0.16 });
  pad.dispose();
  for (let i = 0; i < 8; i++) {
    const a = (i / 8) * Math.PI * 2;
    const st = nail(0.0013, 0.006, { headR: 3.0, seg: 6, headSeg: 6 });
    body.add(st, 'imp_zinc', {
      x: Math.cos(a) * 0.030, y: bore - 0.052 + Math.sin(a) * 0.046, z: 0.262, ry: Math.PI,
    });
    st.dispose();
  }
  // Steel strap tying the stock to the breech — the load path, made visible.
  for (const sx of [-1, 1]) {
    const strap = box(0.004, 0.030, 0.120, 0.0008, 1);
    body.add(strap, 'imp_forged', { x: sx * 0.030, y: bore - 0.024, z: 0.075, rx: -0.10 });
    strap.dispose();
    for (let i = 0; i < 3; i++) {
      const b = boltHead(0.0042, 0.003, true);
      body.add(b, 'imp_zinc', { x: sx * 0.033, y: bore - 0.024, z: 0.030 + i * 0.045, ry: sx * Math.PI / 2 });
      b.dispose();
    }
  }

  /* ---- grip -------------------------------------------------------------- */
  const grip = scavengedGrip('wood', { len: 0.120, w: 0.040, d: 0.052 });
  body.add(grip, 'imp_wood', { y: -0.046, z: 0.018, rx: 1.30 });
  grip.dispose();
  const gripWrap = tapeWrap(0.021, 0.070, rng, { band: 0.020, thick: 0.0012, seg: 12 });
  body.add(gripWrap, 'imp_tape_black', { y: -0.052, z: 0.010, rx: 1.30, sx: 1.05, sy: 1.25 });
  gripWrap.dispose();
  const guard = rodGuard(0.056, 0.042, 0.0038);
  body.add(guard, 'imp_forged', { y: 0.014, z: -0.032 });
  guard.dispose();
  const trigger = new Assembly('harpoon-trigger');
  const trg = wireTrigger({ thick: 0.012 });
  trigger.add(trg, 'imp_forged', {});
  trg.dispose();

  return {
    id: 'harpoon',
    label: 'Harpoon',
    body,
    moving: { trigger, hammer, spear },
    nodes: {
      triggerSeat: { pos: [0, 0.008, -0.026], rot: [0, 0, 0] },
      triggerPull: -0.28,
      hammerSeat: { pos: [0, bore + 0.030, 0.030], rot: [0, 0, 0] },
      hammerCock: 0.95,
      spearSeat: { pos: [0, 0, 0], rot: [0, 0, 0] },
      spearTravel: [0, 0, -0.42],
      muzzle: [0, bore, zMuzzle - 0.01],
      eject: [0, bore + 0.04, -0.06],
      ejectDir: [0.2, 1, 0.1],
      gripL: [0, bore - 0.052, -0.230],
      hand: { pos: [0.011, -0.004, 0.006], rot: [0, 0, 0] },
      holster: { pos: [-0.13, 0.08, 0.20], rot: [0.2, 0.4, 1.0] },
    },
    span: 1.15,
  };
}
