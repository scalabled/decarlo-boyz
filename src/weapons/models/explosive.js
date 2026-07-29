import * as THREE from 'three';
import { Assembly, rodZ } from '../geometry.js';
import {
  box, blob, latheZ, tubeZ, dome, extrude, ring, knurlBand,
  pipe, coupling, weldRing, tapeWrap, tapeStrap, hoseRun,
  boltHead, hoseClamp, gauge, sheetChannel, seamTube, ribbedDrum,
  coilWinding, capacitor, terminalPost, insulator, scavengedGrip, rodGuard,
  wireTrigger, dent,
} from './kit.js';

/**
 * EXPLOSIVE — Nitro Launcher, Depth Charge, Scrap Rocket, EMP Coil.
 *
 * The end of the arsenal where a mistake kills you too. All four are big,
 * heavy, obviously home-made, and carry a visible thing that is about to go
 * wrong: a pressurised bottle, a lit fuse, a rocket motor, a charged capacitor
 * bank.
 *
 * SILHOUETTE BRIEF:
 *   Nitro Launcher a tube with a BOTTLE strapped along it
 *   Depth Charge   short and enormously fat, with a DRUM standing above it
 *   Scrap Rocket   a long thin stove pipe with FINS poking out the front
 *   EMP Coil       a COIL of copper at the front and a car battery at the back —
 *                  the only weapon in the game that is unmistakably electrical
 */

/* ========================================================================== */
/*  NITRO LAUNCHER                                                            */
/* ========================================================================== */

/**
 * A 60 mm launch tube welded up in the body shop, firing nitrous bottles off a
 * charge of the same gas. Aidan's.
 *
 * The propellant bottle strapped along the left is the read, and it is a real
 * 10 lb NOS bottle: 115 mm diameter, blue, with a valve, a siphon fitting, a
 * burst disc and a decal — because the one thing that must be legible is that
 * this is a PRESSURE VESSEL riding on the player's shoulder.
 */
export function buildNitroLauncher(rng) {
  const bore = 0.075;
  const zMuzzle = -0.50;
  const body = new Assembly('launcher');

  /* ---- launch tube ------------------------------------------------------ */
  const tube = pipe(0.038, 0.0035, 0.58, { seg: 24, bow: 0.0022 });
  dent(tube, rng, { count: 6, radius: 0.035, depth: 0.0022 });
  body.add(tube, 'imp_paint_orange', { y: bore, z: -0.215 });
  tube.dispose();
  const boreHole = tubeZ(0.0344, 0.006, 0.16, 20, 0.0006);
  body.add(boreHole, 'cavity', { y: bore, z: -0.42 });
  boreHole.dispose();
  // Muzzle collar + a blast deflector, so the tube end is not a flat annulus.
  const collar = coupling(0.0384, { len: 0.036, wall: 0.0062, seg: 22, hex: false });
  body.add(collar, 'imp_steel', { y: bore, z: zMuzzle + 0.020 });
  collar.dispose();
  for (let i = 0; i < 3; i++) {
    const vane = extrude([[0, 0], [0.030, 0], [0.026, 0.020], [0, 0.024]], 0.004, { bevel: 0.0007 });
    const a = (i / 3) * Math.PI * 2 + 0.5;
    body.add(vane, 'imp_steel', {
      x: Math.cos(a) * 0.040, y: bore + Math.sin(a) * 0.040, z: zMuzzle + 0.030,
      rz: a + Math.PI / 2, ry: -Math.PI / 2,
    });
    vane.dispose();
  }

  /* ---- hinged breech at the back ---------------------------------------- */
  const breechAsm = new Assembly('launcher-breech');
  const bcap = latheZ(
    [[0, 0], [0, 0.0396], [0.010, 0.0426], [0.044, 0.0426], [0.050, 0.036], [0.050, 0]],
    22
  );
  breechAsm.add(bcap, 'imp_steel', { y: bore, z: 0.076 });
  bcap.dispose();
  const bknurl = knurlBand(0.0432, 0.030, 28, 0.0005, 4);
  breechAsm.add(bknurl, 'imp_steel', { y: bore, z: 0.096 });
  bknurl.dispose();
  const bhandle = box(0.070, 0.010, 0.012, 0.0014, 1);
  breechAsm.add(bhandle, 'imp_forged', { y: bore + 0.048, z: 0.096, rz: 0.12 });
  bhandle.dispose();
  const bhinge = rodZ(0.0055, 0.0055, 0.048, 10, 0.0005);
  body.add(bhinge, 'imp_chrome', { y: bore - 0.040, z: 0.058, rx: Math.PI / 2 });
  bhinge.dispose();

  /* ---- THE BOTTLE ------------------------------------------------------- */
  const btlR = 0.0575;
  const btlY = bore - 0.014;
  const btlX = -0.088;
  const bottle = latheZ(
    [
      [-0.160, 0], [-0.158, 0.030], [-0.150, 0.046], [-0.140, btlR],
      [0.128, btlR], [0.140, 0.050], [0.150, 0.030], [0.156, 0.020],
      [0.170, 0.018], [0.170, 0],
    ],
    24
  );
  dent(bottle, rng, { count: 4, radius: 0.03, depth: 0.0016 });
  body.add(bottle, 'imp_paint_blue', { x: btlX, y: btlY, z: -0.110 });
  bottle.dispose();
  // Valve, siphon fitting and burst disc.
  const valve = latheZ(
    [[0, 0], [0, 0.017], [0.010, 0.019], [0.026, 0.019], [0.028, 0.013], [0.040, 0.012], [0.040, 0]],
    16
  );
  body.add(valve, 'imp_brass', { x: btlX, y: btlY, z: -0.288, ry: Math.PI });
  valve.dispose();
  const handwheel = latheZ([[0, 0.006], [0, 0.021], [0.006, 0.021], [0.006, 0.006]], 16);
  body.add(handwheel, 'imp_paint_red', { x: btlX, y: btlY + 0.024, z: -0.300, rx: Math.PI / 2 });
  handwheel.dispose();
  const burst = latheZ([[0, 0], [0, 0.0072], [0.006, 0.0072], [0.006, 0]], 10);
  body.add(burst, 'imp_brass', { x: btlX - 0.016, y: btlY + 0.012, z: -0.300, ry: -1.1 });
  burst.dispose();
  // White decal band around the bottle, in geometry.
  const decal = tubeZ(btlR + 0.0006, btlR - 0.0002, 0.052, 24, 0.0002);
  body.add(decal, 'imp_galv', { x: btlX, y: btlY, z: -0.140 });
  decal.dispose();
  // Two straps clamping the bottle to the tube.
  for (const dz of [-0.055, -0.215]) {
    const strap = ring(btlR + 0.0024, 0.0026, 24, 6, Math.PI * 1.35);
    body.add(strap, 'imp_steel', { x: btlX, y: btlY, z: dz, ry: Math.PI / 2, rz: -0.6 });
    strap.dispose();
    const bridge = box(0.052, 0.008, 0.014, 0.0012, 1);
    body.add(bridge, 'imp_steel', { x: btlX / 2, y: btlY + 0.030, z: dz, rz: 0.1 });
    bridge.dispose();
    const bolt = boltHead(0.0048, 0.0035, true);
    body.add(bolt, 'imp_zinc', { x: btlX / 2, y: btlY + 0.040, z: dz, rx: -Math.PI / 2 });
    bolt.dispose();
  }

  /* ---- regulator, gauge, hose to the breech ----------------------------- */
  const reg = box(0.034, 0.040, 0.038, 0.0022, 2);
  body.add(reg, 'imp_brass', { x: btlX + 0.006, y: btlY + 0.052, z: -0.288, rz: -0.15 });
  reg.dispose();
  {
    const g = gauge(0.019);
    body.add(g.body, 'imp_brass', { x: btlX - 0.006, y: btlY + 0.078, z: -0.282, rx: -0.7, ry: -0.3 });
    body.add(g.face, 'imp_plastic', { x: btlX - 0.0068, y: btlY + 0.0904, z: -0.2725, rx: -0.7, ry: -0.3 });
    body.add(g.needle, 'imp_paint_red', { x: btlX - 0.007, y: btlY + 0.0908, z: -0.2722, rx: -0.7, ry: -0.3, rz: -1.1 });
    g.body.dispose(); g.face.dispose(); g.needle.dispose();
  }
  {
    const h = hoseRun([btlX + 0.020, btlY + 0.052, -0.288], [-0.030, bore - 0.020, 0.060], 0.035, { radius: 0.0072, steps: 16 });
    body.add(h, 'imp_hose', {});
    h.dispose();
    const c = hoseClamp(0.0082, 0.008);
    body.add(c, 'imp_zinc', { x: btlX + 0.020, y: btlY + 0.052, z: -0.284, ry: 1.2 });
    body.add(c, 'imp_zinc', { x: -0.030, y: bore - 0.020, z: 0.056, ry: 0.6 });
    c.dispose();
  }
  // The firing solenoid: a black can with two spade terminals.
  const sol = latheZ([[-0.020, 0], [-0.020, 0.016], [0.020, 0.016], [0.020, 0]], 14);
  body.add(sol, 'imp_plastic', { x: -0.032, y: bore - 0.022, z: 0.030, ry: Math.PI / 2 });
  sol.dispose();

  /* ---- shoulder rest, grips, sight -------------------------------------- */
  const rest = extrude(
    [[-0.028, 0.052], [0.028, 0.052], [0.034, 0.008], [0.026, -0.036], [-0.026, -0.036], [-0.034, 0.008]],
    0.030,
    { bevel: 0.003, bevelSegments: 2 }
  );
  body.add(rest, 'imp_wood', { y: bore - 0.052, z: 0.192, rx: -0.18 });
  rest.dispose();
  const pad = blob(0.062, 0.098, 0.026, 0.010, 3);
  body.add(pad, 'imp_leather', { y: bore - 0.056, z: 0.212, rx: -0.20 });
  pad.dispose();
  const restStrut = box(0.010, 0.070, 0.026, 0.0016, 1);
  body.add(restStrut, 'imp_steel', { y: bore - 0.030, z: 0.150, rx: 0.35 });
  restStrut.dispose();

  const grip = scavengedGrip('tool', { len: 0.118, w: 0.038, d: 0.050 });
  body.add(grip, 'imp_plastic', { y: -0.048, z: 0.014, rx: 1.28 });
  grip.dispose();
  const gripWrap = tapeWrap(0.020, 0.076, rng, { band: 0.020, thick: 0.0012, seg: 12 });
  body.add(gripWrap, 'imp_tape_black', { y: -0.054, z: 0.006, rx: 1.28, sx: 1.05, sy: 1.25 });
  gripWrap.dispose();
  const guard = rodGuard(0.054, 0.040, 0.0036);
  body.add(guard, 'imp_steel', { y: 0.012, z: -0.030 });
  guard.dispose();
  const trigger = new Assembly('launcher-trigger');
  const trg = wireTrigger({ thick: 0.011 });
  trigger.add(trg, 'imp_chrome', {});
  trg.dispose();

  const fore = scavengedGrip('bike', { len: 0.100, w: 0.036 });
  body.add(fore, 'imp_hose', { y: bore - 0.078, z: -0.290, rx: 1.32 });
  fore.dispose();
  const foreArm = box(0.012, 0.058, 0.028, 0.0016, 1);
  body.add(foreArm, 'imp_steel', { y: bore - 0.042, z: -0.290 });
  foreArm.dispose();

  // Sight: a folding ladder made of welded bar with a peep at the top.
  const ladder = extrude([[-0.014, 0], [0.014, 0], [0.014, 0.058], [-0.014, 0.058]], 0.004, { bevel: 0.0006, holes: [[[-0.008, 0.010], [0.008, 0.010], [0.008, 0.050], [-0.008, 0.050]]] });
  body.add(ladder, 'imp_steel', { y: bore + 0.068, z: -0.060, rx: -0.06 });
  ladder.dispose();
  const beadPost = box(0.005, 0.026, 0.005, 0.0007, 1);
  body.add(beadPost, 'imp_steel', { y: bore + 0.050, z: -0.440 });
  beadPost.dispose();
  const bead = dome(0.0035, 8, 0.55);
  body.add(bead, 'imp_paint_yellow', { y: bore + 0.064, z: -0.440, rx: -Math.PI / 2 });
  bead.dispose();

  return {
    id: 'launcher',
    label: 'Nitro Launcher',
    body,
    moving: { trigger, breech: breechAsm },
    nodes: {
      triggerSeat: { pos: [0, 0.008, -0.026], rot: [0, 0, 0] },
      triggerPull: -0.3,
      breechSeat: { pos: [0, 0, 0], rot: [0, 0, 0] },
      breakPivot: [0, bore - 0.040, 0.058],
      breakAngle: 0.55,
      muzzle: [0, bore, zMuzzle - 0.01],
      eject: [0, bore, 0.10],
      ejectDir: [0.1, 0.5, 0.86],
      gripL: [0, bore - 0.086, -0.290],
      hand: { pos: [0.011, -0.004, 0.006], rot: [0, 0, 0] },
      holster: { pos: [-0.16, 0.06, 0.20], rot: [0.2, 0.4, 0.95] },
    },
    span: 0.82,
  };
}

/* ========================================================================== */
/*  DEPTH CHARGE                                                              */
/* ========================================================================== */

/**
 * A stern rack off a river tug, cut down to something one man can lift: a short
 * fat thrower with the charge sitting IN the muzzle, fuse dial set, ready to
 * roll off. Carson's.
 *
 * The drum standing proud of the tube is the read, and it must look like it
 * came out of the water: barnacle crust, weed in the ribs, and rust that has
 * eaten through the paint in sheets.
 */
export function buildDepthCharge(rng) {
  const bore = 0.078;
  const zMuzzle = -0.30;
  const body = new Assembly('depth');

  /* ---- the thrower tube: short, fat, riveted --------------------------- */
  const tube = seamTube(0.062, 0.290, 0.0022, { seg: 24, rivets: 6, seamAngle: Math.PI * 0.72 });
  dent(tube, rng, { count: 6, radius: 0.04, depth: 0.0026 });
  body.add(tube, 'imp_rust', { y: bore, z: -0.135 });
  tube.dispose();
  const mouth = latheZ(
    [[0, 0.062], [0, 0.070], [0.014, 0.072], [0.020, 0.068], [0.020, 0.060]],
    24
  );
  body.add(mouth, 'imp_rust', { y: bore, z: zMuzzle + 0.020, ry: Math.PI });
  mouth.dispose();
  const mouthWeld = weldRing(0.063, rng, { radius: 0.0024, count: 26 });
  body.add(mouthWeld, 'imp_steel', { y: bore, z: zMuzzle + 0.020 });
  mouthWeld.dispose();
  const baseCap = latheZ([[0, 0], [0, 0.064], [0.016, 0.068], [0.028, 0.062], [0.028, 0]], 22);
  body.add(baseCap, 'imp_steel', { y: bore, z: 0.012 });
  baseCap.dispose();

  /* ---- THE CHARGE, sitting in the muzzle -------------------------------- */
  const charge = new Assembly('depth-charge');
  const drumR = 0.058;
  const drum = ribbedDrum(drumR, 0.185, 3, { seg: 24 });
  dent(drum, rng, { count: 6, radius: 0.03, depth: 0.0024 });
  charge.add(drum, 'imp_paint_teal', { y: bore, z: zMuzzle - 0.048 });
  drum.dispose();
  // Rust holes eaten through the paint — patches of bare oxide.
  for (let i = 0; i < 8; i++) {
    const a = rng.float() * Math.PI * 2;
    const s = 0.6 + rng.float() * 1.1;
    const p = new THREE.SphereGeometry(0.011 * s, 8, 6);
    p.scale(1.4, 1.4, 0.3);
    charge.add(p, 'imp_rust', {
      x: Math.cos(a) * drumR, y: bore + Math.sin(a) * drumR,
      z: zMuzzle - 0.048 + (rng.float() - 0.5) * 0.15,
      rz: a, ry: Math.PI / 2,
    });
    p.dispose();
  }
  // Barnacles: a scatter of little cones on the underside.
  for (let i = 0; i < 14; i++) {
    const a = Math.PI + (rng.float() - 0.5) * 2.0;
    const s = 0.5 + rng.float() * 0.9;
    const b = latheZ([[0, 0], [0, 0.0042 * s], [0.005 * s, 0.0026 * s], [0.005 * s, 0.0012 * s]], 7);
    charge.add(b, 'imp_galv', {
      x: Math.cos(a) * (drumR + 0.001), y: bore + Math.sin(a) * (drumR + 0.001),
      z: zMuzzle - 0.048 + (rng.float() - 0.5) * 0.16,
      rz: a - Math.PI / 2, ry: -Math.PI / 2,
    });
    b.dispose();
  }
  // The fuse head: a brass dial with depth graduations and a setting key.
  const fuseHead = latheZ(
    [[0, 0], [0, 0.026], [0.008, 0.028], [0.020, 0.028], [0.024, 0.022], [0.024, 0]],
    18
  );
  charge.add(fuseHead, 'imp_brass', { y: bore, z: zMuzzle - 0.146, ry: Math.PI });
  fuseHead.dispose();
  for (let i = 0; i < 8; i++) {
    const a = (i / 8) * Math.PI * 2;
    const tick = box(0.0016, 0.008, 0.0009, 0.0002, 1);
    charge.add(tick, 'imp_grease', {
      x: Math.cos(a) * 0.021, y: bore + Math.sin(a) * 0.021, z: zMuzzle - 0.170, rz: a,
    });
    tick.dispose();
  }
  const fuseKey = box(0.030, 0.006, 0.007, 0.0008, 1);
  charge.add(fuseKey, 'imp_brass', { y: bore, z: zMuzzle - 0.172, rz: 0.5 });
  fuseKey.dispose();
  // Lifting lugs on the drum: this is a two-man object being thrown by one.
  for (const sx of [-1, 1]) {
    const lug = ring(0.012, 0.0028, 14, 6);
    charge.add(lug, 'imp_forged', { x: sx * drumR * 0.7, y: bore + drumR * 0.7, z: zMuzzle - 0.10, ry: Math.PI / 2 });
    lug.dispose();
  }

  /* ---- spade grip + baseplate ------------------------------------------- */
  const spade = extrude(
    [[-0.030, 0.056], [0.030, 0.056], [0.036, 0.006], [0.024, -0.052], [-0.024, -0.052], [-0.036, 0.006]],
    0.028,
    { bevel: 0.003, bevelSegments: 2 }
  );
  body.add(spade, 'imp_wood', { y: bore - 0.020, z: 0.108, rx: -0.35 });
  spade.dispose();
  const spadeBrace = box(0.012, 0.075, 0.026, 0.0016, 1);
  body.add(spadeBrace, 'imp_steel', { y: bore - 0.040, z: 0.062, rx: 0.5 });
  spadeBrace.dispose();

  const grip = scavengedGrip('wood', { len: 0.118, w: 0.040, d: 0.050 });
  body.add(grip, 'imp_wood', { y: -0.046, z: 0.016, rx: 1.30 });
  grip.dispose();
  const gripWrap = tapeWrap(0.021, 0.070, rng, { band: 0.020, thick: 0.0012, seg: 12 });
  body.add(gripWrap, 'imp_tape_duct', { y: -0.052, z: 0.008, rx: 1.30, sx: 1.05, sy: 1.25 });
  gripWrap.dispose();
  const guard = rodGuard(0.054, 0.040, 0.0036);
  body.add(guard, 'imp_steel', { y: 0.012, z: -0.030 });
  guard.dispose();
  const trigger = new Assembly('depth-trigger');
  const trg = wireTrigger({ thick: 0.011 });
  trigger.add(trg, 'imp_forged', {});
  trg.dispose();

  // Carry handle over the top — a length of pipe on two welded ears.
  const handle = pipe(0.011, 0.0022, 0.130, { seg: 12, bow: 0.001 });
  body.add(handle, 'imp_galv', { y: bore + 0.086, z: -0.100 });
  handle.dispose();
  for (const dz of [-0.036, -0.164]) {
    const ear = extrude([[0, 0], [0.014, 0], [0.014, 0.028], [0, 0.028]], 0.005, { bevel: 0.0007 });
    body.add(ear, 'imp_steel', { y: bore + 0.062, z: dz, ry: Math.PI / 2 });
    ear.dispose();
  }
  const handleWrap = tapeWrap(0.0112, 0.062, rng, { band: 0.018, thick: 0.001, seg: 10, tail: false });
  body.add(handleWrap, 'imp_tape_black', { y: bore + 0.086, z: -0.100 });
  handleWrap.dispose();

  // A fore-grip on the tube for the support hand.
  const fore = scavengedGrip('bike', { len: 0.094, w: 0.034 });
  body.add(fore, 'imp_hose', { y: bore - 0.104, z: -0.212, rx: 1.34 });
  fore.dispose();
  const foreArm = box(0.012, 0.060, 0.026, 0.0016, 1);
  body.add(foreArm, 'imp_steel', { y: bore - 0.068, z: -0.212 });
  foreArm.dispose();

  // River weed, caught in the ribs. Three little fronds, and worth it.
  for (let i = 0; i < 4; i++) {
    const a = 2.2 + rng.float() * 1.6;
    const w = extrude([[0, 0], [0.004, 0.002], [0.006, 0.030], [0.0, 0.046], [-0.004, 0.022]], 0.0008, { bevel: 0.0002 });
    body.add(w, 'imp_rope', {
      x: Math.cos(a) * 0.062, y: bore + Math.sin(a) * 0.062, z: -0.09 - rng.float() * 0.12,
      rz: a + Math.PI, ry: rng.signed() * 0.7, rx: rng.signed() * 0.4,
    });
    w.dispose();
  }

  return {
    id: 'depth',
    label: 'Depth Charge',
    body,
    moving: { trigger, charge },
    nodes: {
      triggerSeat: { pos: [0, 0.008, -0.026], rot: [0, 0, 0] },
      triggerPull: -0.3,
      chargeSeat: { pos: [0, 0, 0], rot: [0, 0, 0] },
      chargeTravel: [0, 0, -0.36],
      muzzle: [0, bore, zMuzzle - 0.02],
      eject: [0, bore + 0.05, -0.10],
      ejectDir: [0.1, 1, 0],
      gripL: [0, bore - 0.112, -0.212],
      hand: { pos: [0.011, -0.004, 0.006], rot: [0, 0, 0] },
      holster: { pos: [-0.16, 0.02, 0.19], rot: [0.15, 0.35, 0.6] },
    },
    span: 0.55,
  };
}

/* ========================================================================== */
/*  SCRAP ROCKET                                                              */
/* ========================================================================== */

/**
 * Six feet of galvanised stove pipe, a wooden shoulder yoke, a bicycle brake
 * lever and a rocket made out of a fire extinguisher with a sheet-metal fin
 * can. Dylan's, and it shows.
 *
 * It is the longest weapon in the game (1.05 m) and the thinnest, which is what
 * separates it from the Nitro Launcher at a glance: a pencil, not a log.
 */
export function buildScrapRocket(rng) {
  const bore = 0.078;
  const zMuzzle = -0.62;
  const body = new Assembly('rocket');

  /* ---- the tube --------------------------------------------------------- */
  const tube = seamTube(0.0345, 0.90, 0.0013, { seg: 22, rivets: 14, seamAngle: Math.PI * 0.58 });
  dent(tube, rng, { count: 8, radius: 0.045, depth: 0.0024 });
  body.add(tube, 'imp_galv', { y: bore, z: -0.185 });
  tube.dispose();
  const boreHole = tubeZ(0.0328, 0.006, 0.20, 18, 0.0004);
  body.add(boreHole, 'cavity', { y: bore, z: -0.50 });
  boreHole.dispose();
  // A second, larger crimped section at the rear — two pipes, one inside the
  // other, which is exactly how stove pipe is joined.
  const rear = seamTube(0.0375, 0.170, 0.0013, { seg: 22, rivets: 4, seamAngle: Math.PI * 0.58 });
  body.add(rear, 'imp_galv', { y: bore, z: 0.200 });
  rear.dispose();
  const crimp = latheZ(
    [[0, 0.0345], [0.006, 0.0378], [0.020, 0.0378], [0.020, 0.0345]],
    22
  );
  body.add(crimp, 'imp_galv', { y: bore, z: 0.118 });
  crimp.dispose();
  // Blast cone at the back, so the backblast has somewhere to come from.
  const blastCone = latheZ(
    [[0, 0.0375], [0.052, 0.062], [0.056, 0.063], [0.056, 0.0605], [0.052, 0.0596], [0, 0.036]],
    22
  );
  body.add(blastCone, 'imp_rust', { y: bore, z: 0.286 });
  blastCone.dispose();
  const coneWeld = weldRing(0.0378, rng, { radius: 0.0019, count: 18 });
  body.add(coneWeld, 'imp_steel', { y: bore, z: 0.286 });
  coneWeld.dispose();
  // Soot: everything within 80 mm of the blast end is black.
  const soot = tubeZ(0.0382, 0.0374, 0.075, 22, 0.0003);
  body.add(soot, 'imp_grease', { y: bore, z: 0.248 });
  soot.dispose();

  /* ---- THE ROCKET, sticking out the front ------------------------------- */
  const round = new Assembly('rocket-round');
  const warhead = latheZ(
    [
      [0, 0], [0.030, 0.0192], [0.062, 0.0282], [0.086, 0.0305],
      [0.150, 0.0305], [0.152, 0.0288], [0.152, 0],
    ],
    20
  );
  round.add(warhead, 'imp_paint_red', { y: bore, z: zMuzzle - 0.010, ry: Math.PI });
  warhead.dispose();
  const bodyTube = tubeZ(0.0305, 0.0292, 0.16, 20, 0.0004);
  round.add(bodyTube, 'imp_galv', { y: bore, z: zMuzzle + 0.070 });
  bodyTube.dispose();
  const bandY = tubeZ(0.0312, 0.0302, 0.014, 20, 0.0002);
  round.add(bandY, 'imp_paint_yellow', { y: bore, z: zMuzzle + 0.006 });
  round.add(bandY, 'imp_paint_yellow', { y: bore, z: zMuzzle + 0.030 });
  bandY.dispose();
  // The fin can: four sheet-metal fins folded from one blank, at 3 degrees of
  // cant so the rocket spins. Visible cant is a real detail and it costs nothing.
  for (let i = 0; i < 4; i++) {
    const a = (i / 4) * Math.PI * 2 + 0.4;
    const fin = extrude(
      [[0, 0], [0.030, 0.004], [0.030, 0.052], [0.004, 0.062], [0, 0.055]],
      0.0011,
      { bevel: 0.0003 }
    );
    round.add(fin, 'imp_steel', {
      x: Math.cos(a) * 0.030, y: bore + Math.sin(a) * 0.030, z: zMuzzle + 0.118,
      rz: a - Math.PI / 2, ry: -Math.PI / 2 + 0.052,
    });
    fin.dispose();
  }
  const nozzle = latheZ(
    [[0, 0.006], [0, 0.026], [0.020, 0.030], [0.020, 0.0125], [0.004, 0.006]],
    18
  );
  round.add(nozzle, 'imp_grease', { y: bore, z: zMuzzle + 0.150 });
  nozzle.dispose();
  // A crude stencil on the warhead — three bars, geometry not texture.
  for (let i = 0; i < 3; i++) {
    const bar = box(0.0028, 0.020, 0.0009, 0.0002, 1);
    round.add(bar, 'imp_paint_yellow', { x: 0.0, y: bore + 0.031, z: zMuzzle - 0.10 + i * 0.008, rx: -Math.PI / 2 });
    bar.dispose();
  }

  /* ---- shoulder yoke ---------------------------------------------------- */
  const yoke = extrude(
    [[-0.026, 0.058], [0.026, 0.058], [0.032, 0.006], [0.024, -0.044], [-0.024, -0.044], [-0.032, 0.006]],
    0.185,
    { bevel: 0.003, bevelSegments: 2 }
  );
  body.add(yoke, 'imp_wood', { y: bore - 0.052, z: 0.180, rx: -0.14, ry: Math.PI / 2 });
  yoke.dispose();
  const yokePad = blob(0.058, 0.090, 0.024, 0.009, 3);
  body.add(yokePad, 'imp_leather', { y: bore - 0.062, z: 0.244, rx: -0.18 });
  yokePad.dispose();
  // Two U-bolts holding the yoke to the tube.
  for (const dz of [0.108, 0.226]) {
    const u = new THREE.TorusGeometry(0.040, 0.0026, 6, 16, Math.PI);
    body.add(u, 'imp_zinc', { y: bore, z: dz, rz: Math.PI });
    u.dispose();
    const plate = box(0.096, 0.008, 0.014, 0.001, 1);
    body.add(plate, 'imp_steel', { y: bore - 0.040, z: dz });
    plate.dispose();
  }

  /* ---- grip, trigger, fore-grip, sight ---------------------------------- */
  const grip = scavengedGrip('bike', { len: 0.116, w: 0.036 });
  body.add(grip, 'imp_hose', { y: -0.046, z: 0.014, rx: 1.26 });
  grip.dispose();
  const gripTang = box(0.011, 0.062, 0.030, 0.0014, 1);
  body.add(gripTang, 'imp_steel', { y: bore - 0.062, z: 0.006, rx: 0.30 });
  gripTang.dispose();
  const guard = rodGuard(0.052, 0.038, 0.0034);
  body.add(guard, 'imp_steel', { y: 0.012, z: -0.030 });
  guard.dispose();
  // The trigger is a bicycle brake lever, with the cable still on it.
  const trigger = new Assembly('rocket-trigger');
  const lever = extrude(
    [[-0.005, 0.006], [0.005, 0.006], [0.008, -0.020], [0.003, -0.044], [-0.005, -0.042], [-0.007, -0.016]],
    0.006,
    { bevel: 0.0007 }
  );
  trigger.add(lever, 'imp_chrome', {});
  lever.dispose();
  const cable = hoseRun([0.006, -0.006, -0.024], [0.020, bore - 0.030, 0.070], 0.03, { radius: 0.0018, steps: 12, seg: 5 });
  body.add(cable, 'imp_hose', {});
  cable.dispose();

  const fore = scavengedGrip('bike', { len: 0.098, w: 0.034 });
  body.add(fore, 'imp_hose', { y: bore - 0.076, z: -0.320, rx: 1.32 });
  fore.dispose();
  const foreArm = box(0.012, 0.058, 0.026, 0.0016, 1);
  body.add(foreArm, 'imp_steel', { y: bore - 0.042, z: -0.320 });
  foreArm.dispose();
  const foreWrap = tapeWrap(0.0355, 0.075, rng, { band: 0.021, thick: 0.0012, seg: 18 });
  body.add(foreWrap, 'imp_tape_duct', { y: bore, z: -0.320 });
  foreWrap.dispose();

  // Sight: a bent-wire ring welded on, and a nail for a front bead.
  const sightRing = new THREE.TorusGeometry(0.022, 0.0018, 6, 18);
  body.add(sightRing, 'imp_steel', { y: bore + 0.060, z: -0.040, rx: 0.05 });
  sightRing.dispose();
  const sightPost = box(0.004, 0.028, 0.004, 0.0006, 1);
  body.add(sightPost, 'imp_steel', { y: bore + 0.046, z: -0.040 });
  sightPost.dispose();
  const beadPost = box(0.004, 0.030, 0.004, 0.0006, 1);
  body.add(beadPost, 'imp_steel', { y: bore + 0.048, z: -0.470 });
  beadPost.dispose();
  const bead = dome(0.0034, 8, 0.55);
  body.add(bead, 'imp_paint_orange', { y: bore + 0.063, z: -0.470, rx: -Math.PI / 2 });
  bead.dispose();

  // Hazard tape, because the last one went off early.
  for (let i = 0; i < 5; i++) {
    const t = tubeZ(0.0352, 0.0344, 0.011, 20, 0.0002);
    body.add(t, i % 2 ? 'imp_tape_black' : 'imp_paint_yellow', { y: bore, z: 0.062 - i * 0.012 });
    t.dispose();
  }

  return {
    id: 'rocket',
    label: 'Scrap Rocket',
    body,
    moving: { trigger, round },
    nodes: {
      triggerSeat: { pos: [0, 0.008, -0.026], rot: [0, 0, 0] },
      triggerPull: -0.34,
      roundSeat: { pos: [0, 0, 0], rot: [0, 0, 0] },
      roundTravel: [0, 0, -0.55],
      muzzle: [0, bore, zMuzzle - 0.16],
      eject: [0, bore, 0.34],
      ejectDir: [0, 0.12, 1],
      backblast: [0, bore, 0.345],
      gripL: [0, bore - 0.084, -0.320],
      hand: { pos: [0.011, -0.004, 0.006], rot: [0, 0, 0] },
      holster: { pos: [-0.17, 0.07, 0.22], rot: [0.2, 0.4, 0.95] },
    },
    span: 1.15,
  };
}

/* ========================================================================== */
/*  EMP COIL — the signature toy                                              */
/* ========================================================================== */

/**
 * A car battery, a bank of photoflash capacitors, forty turns of enamelled
 * copper on a ferrite core, and a spark gap. Point it at a cruiser and the
 * cruiser stops being a cruiser.
 *
 * DESIGN INTENT. This is the weapon the game is remembered for, so it is the
 * only one built to be READ RATHER THAN RECOGNISED: nothing about it looks like
 * a firearm. There is no barrel — the muzzle is the open end of a coil. There is
 * no magazine — there is a battery. There is no sight. What it has instead is a
 * legible ELECTRICAL story that the player can follow with their eyes:
 *
 *     battery  ->  jumper leads  ->  knife switch  ->  capacitor bank
 *              ->  bus bars  ->  the coil  ->  the gap
 *
 * Every one of those is a distinct object in a distinct material, laid out
 * left-to-right along the weapon, and the two brightest things on it are the
 * copper and the cyan glow in the gap.
 */
export function buildEmpCoil(rng) {
  const axis = 0.072;              // the coil axis height above the grip web
  const zMuzzle = -0.34;
  const body = new Assembly('emp');

  /* ---- spine: a length of channel everything is bolted to --------------- */
  const spine = sheetChannel(0.050, 0.038, 0.44, 0.0022, 0.03);
  dent(spine, rng, { count: 4, radius: 0.03, depth: 0.0016 });
  body.add(spine, 'imp_steel', { y: axis - 0.040, z: -0.100, rz: Math.PI });
  spine.dispose();
  for (let i = 0; i < 7; i++) {
    const b = boltHead(0.0044, 0.0032, true);
    body.add(b, 'imp_zinc', { x: 0.0255, y: axis - 0.052, z: -0.28 + i * 0.062, ry: Math.PI / 2 });
    b.dispose();
  }

  /* ---- THE COIL --------------------------------------------------------- */
  const coreR = 0.024;
  const coilLen = 0.135;
  const coilZ = -0.255;
  // Ferrite core: matte black, and the only truly dark thing at the front.
  const core = latheZ(
    [[-coilLen / 2 - 0.014, 0], [-coilLen / 2 - 0.014, coreR], [coilLen / 2 + 0.014, coreR], [coilLen / 2 + 0.014, 0]],
    20
  );
  body.add(core, 'imp_plastic', { y: axis, z: coilZ });
  core.dispose();
  const coreBore = tubeZ(coreR - 0.005, 0.001, 0.10, 16, 0.0004);
  body.add(coreBore, 'cavity', { y: axis, z: coilZ - 0.03 });
  coreBore.dispose();
  // 34 turns of 3 mm enamelled copper, in two layers.
  const winding = coilWinding(coreR, 0.0028, 22, coilLen, { layers: 2, seg: 6 });
  body.add(winding, 'imp_copper', { y: axis, z: coilZ });
  winding.dispose();
  // Fibreglass end cheeks holding the winding on.
  for (const dz of [-coilLen / 2 - 0.008, coilLen / 2 + 0.008]) {
    const cheek = latheZ([[0, coreR - 0.001], [0, 0.040], [0.006, 0.040], [0.006, coreR - 0.001]], 20);
    body.add(cheek, 'imp_paint_yellow', { y: axis, z: coilZ + dz });
    cheek.dispose();
  }
  // Three cable ties around the winding, because it is not staying on by itself.
  for (const dz of [-0.045, 0, 0.045]) {
    const tie = tubeZ(coreR + 0.0068, coreR + 0.0056, 0.0038, 20, 0.0002);
    body.add(tie, 'imp_plastic', { y: axis, z: coilZ + dz });
    tie.dispose();
    const head = box(0.008, 0.0055, 0.005, 0.0006, 1);
    body.add(head, 'imp_plastic', { y: axis + coreR + 0.010, z: coilZ + dz });
    head.dispose();
  }

  /* ---- the gap: two brass electrodes on porcelain standoffs ------------- */
  for (const sx of [-1, 1]) {
    const post = insulator(0.011, 0.048, 3);
    body.add(post, 'imp_galv', { x: sx * 0.026, y: axis + 0.006, z: zMuzzle + 0.036, ry: Math.PI / 2 });
    post.dispose();
    const elec = latheZ([[0, 0], [0, 0.0072], [0.026, 0.0072], [0.034, 0.0036], [0.034, 0]], 12);
    body.add(elec, 'imp_brass', { x: sx * 0.040, y: axis + 0.006, z: zMuzzle + 0.036, ry: -sx * Math.PI / 2 });
    elec.dispose();
    // Bus bar from the coil to the electrode.
    const bar = box(0.006, 0.0022, 0.075, 0.0004, 1);
    body.add(bar, 'imp_copper', { x: sx * 0.030, y: axis + 0.024, z: zMuzzle + 0.072, rz: sx * 0.12 });
    bar.dispose();
  }
  // The gap itself, glowing. Small, and the brightest thing on the weapon.
  const gapGlow = new THREE.SphereGeometry(0.0075, 10, 8);
  body.add(gapGlow, 'glow_charge', { y: axis + 0.006, z: zMuzzle + 0.036 });
  gapGlow.dispose();
  const gapCore = new THREE.SphereGeometry(0.0032, 8, 6);
  body.add(gapCore, 'glow_arc', { y: axis + 0.006, z: zMuzzle + 0.036 });
  gapCore.dispose();

  /* ---- capacitor bank --------------------------------------------------- */
  const capZ = -0.070;
  for (let i = 0; i < 3; i++) {
    const a = (i / 3) * Math.PI * 2 + 0.52;
    const c = capacitor(0.0205, 0.115);
    body.add(c, 'imp_paint_blue', {
      x: Math.cos(a) * 0.026, y: axis + 0.030 + Math.sin(a) * 0.026, z: capZ,
    });
    c.dispose();
    // Each can's positive lead, going forward to the bus.
    const lead = hoseRun(
      [Math.cos(a) * 0.026, axis + 0.030 + Math.sin(a) * 0.026, capZ - 0.060],
      [0, axis + 0.030, coilZ + 0.078],
      0.012,
      { radius: 0.0026, steps: 8, seg: 5 }
    );
    body.add(lead, i === 0 ? 'imp_paint_red' : 'imp_plastic', {});
    lead.dispose();
  }
  // A clamp ring holding the three cans together, front and back.
  for (const dz of [-0.048, 0.048]) {
    const band = ring(0.048, 0.0022, 22, 6);
    band.rotateY(Math.PI / 2);
    body.add(band, 'imp_galv', { y: axis + 0.030, z: capZ + dz });
    band.dispose();
  }
  const capStrap = tapeStrap(0.024, 0.100, 1.4, rng);
  body.add(capStrap, 'imp_tape_black', { y: axis + 0.078, z: capZ, rz: 0.05 });
  capStrap.dispose();

  /* ---- the knife switch — the most legible part of the whole thing ------ */
  const switchBase = box(0.052, 0.010, 0.058, 0.0012, 1);
  body.add(switchBase, 'imp_plastic', { x: -0.038, y: axis + 0.010, z: 0.010, rz: -0.35 });
  switchBase.dispose();
  for (const dz of [-0.020, 0.020]) {
    const post = insulator(0.008, 0.026, 2);
    body.add(post, 'imp_galv', { x: -0.042, y: axis + 0.026, z: 0.010 + dz, rx: Math.PI / 2, rz: -0.35 });
    post.dispose();
  }
  const blade = box(0.007, 0.0026, 0.052, 0.0004, 1);
  body.add(blade, 'imp_copper', { x: -0.046, y: axis + 0.040, z: 0.010, rz: -0.35, rx: -0.25 });
  blade.dispose();
  const bakeliteHandle = latheZ([[0, 0], [0, 0.007], [0.020, 0.0062], [0.022, 0]], 12);
  body.add(bakeliteHandle, 'imp_plastic', { x: -0.050, y: axis + 0.050, z: 0.040, rx: 1.2 });
  bakeliteHandle.dispose();

  /* ---- the voltmeter ---------------------------------------------------- */
  {
    const g = gauge(0.022);
    body.add(g.body, 'imp_plastic', { x: 0.040, y: axis + 0.030, z: -0.050, ry: 1.25, rx: -0.15 });
    body.add(g.face, 'imp_galv', { x: 0.0416, y: axis + 0.0303, z: -0.0495, ry: 1.25, rx: -0.15 });
    body.add(g.needle, 'imp_paint_red', { x: 0.0420, y: axis + 0.0303, z: -0.0494, ry: 1.25, rx: -0.15, rz: 0.55 });
    g.body.dispose(); g.face.dispose(); g.needle.dispose();
  }
  // Two terminals under it with ring lugs bolted on.
  for (const dz of [-0.018, 0.018]) {
    const t = terminalPost(0.0038);
    body.add(t, 'imp_brass', { x: 0.038, y: axis + 0.004, z: -0.050 + dz, ry: Math.PI / 2 });
    t.dispose();
  }

  /* ---- THE BATTERY, as the counterweight at the back -------------------- */
  const batX = 0;
  const batY = axis - 0.006;
  const batZ = 0.152;
  const bat = blob(0.108, 0.086, 0.130, 0.006, 3);
  dent(bat, rng, { count: 3, radius: 0.03, depth: 0.0014 });
  body.add(bat, 'imp_plastic', { x: batX, y: batY, z: batZ });
  bat.dispose();
  // Cell caps along the top.
  for (let i = 0; i < 3; i++) {
    const cap = latheZ([[0, 0], [0, 0.011], [0.005, 0.011], [0.005, 0]], 12);
    body.add(cap, 'imp_plastic', { x: batX - 0.030 + i * 0.030, y: batY + 0.044, z: batZ + 0.020, rx: -Math.PI / 2 });
    cap.dispose();
  }
  // Terminals + jumper leads running forward to the switch.
  for (const [sx, mat] of [[-1, 'imp_paint_red'], [1, 'imp_plastic']]) {
    const t = terminalPost(0.0072);
    body.add(t, 'imp_copper', { x: batX + sx * 0.034, y: batY + 0.044, z: batZ - 0.040, rx: -Math.PI / 2 });
    t.dispose();
    const lead = hoseRun(
      [batX + sx * 0.034, batY + 0.056, batZ - 0.040],
      [-0.040, axis + 0.020, 0.010 + sx * 0.020],
      0.045,
      { radius: 0.0072, steps: 12, seg: 7 }
    );
    body.add(lead, mat, {});
    lead.dispose();
  }
  // A label panel and a carry strap over the battery.
  const label = box(0.070, 0.0012, 0.048, 0.0003, 1);
  body.add(label, 'imp_galv', { x: batX, y: batY + 0.0435, z: batZ - 0.005 });
  label.dispose();
  const strap = tapeStrap(0.030, 0.150, 1.7, rng);
  body.add(strap, 'imp_canvas', { x: batX, y: batY + 0.048, z: batZ, rz: 0.02, sx: 1, sy: 1 });
  strap.dispose();

  /* ---- grip, dead-man trigger, fore-grip -------------------------------- */
  const grip = scavengedGrip('tool', { len: 0.118, w: 0.038, d: 0.050 });
  body.add(grip, 'imp_plastic', { y: -0.048, z: 0.014, rx: 1.28 });
  grip.dispose();
  const gripWrap = tapeWrap(0.020, 0.076, rng, { band: 0.020, thick: 0.0012, seg: 12 });
  body.add(gripWrap, 'imp_tape_black', { y: -0.054, z: 0.006, rx: 1.28, sx: 1.05, sy: 1.25 });
  gripWrap.dispose();
  const guard = rodGuard(0.054, 0.040, 0.0036);
  body.add(guard, 'imp_steel', { y: 0.012, z: -0.030 });
  guard.dispose();
  const trigger = new Assembly('emp-trigger');
  const trg = wireTrigger({ thick: 0.011 });
  trigger.add(trg, 'imp_chrome', {});
  trg.dispose();
  // The dead-man switch: a red mushroom button on top of the grip.
  const mushroom = latheZ([[0, 0], [0, 0.011], [0.006, 0.012], [0.009, 0.009], [0.009, 0]], 14);
  body.add(mushroom, 'imp_paint_red', { x: 0.020, y: axis - 0.040, z: 0.026, rx: -1.0 });
  mushroom.dispose();

  const fore = scavengedGrip('bike', { len: 0.096, w: 0.034 });
  body.add(fore, 'imp_hose', { y: axis - 0.098, z: -0.180, rx: 1.32 });
  fore.dispose();
  const foreArm = box(0.012, 0.062, 0.026, 0.0016, 1);
  body.add(foreArm, 'imp_steel', { y: axis - 0.062, z: -0.180 });
  foreArm.dispose();

  /* ---- warning triangle, in geometry ------------------------------------ */
  const tri = extrude([[0, 0.017], [0.016, -0.011], [-0.016, -0.011]], 0.0012, { bevel: 0.0003 });
  body.add(tri, 'imp_paint_yellow', { x: -0.0264, y: axis + 0.010, z: -0.110, ry: -Math.PI / 2 });
  tri.dispose();
  const bolt = extrude([[0.002, 0.008], [0.006, 0.000], [0.003, 0.000], [0.006, -0.008], [-0.001, 0.001], [0.002, 0.001]], 0.0008, { bevel: 0.0002 });
  body.add(bolt, 'imp_plastic', { x: -0.0272, y: axis + 0.009, z: -0.110, ry: -Math.PI / 2 });
  bolt.dispose();

  return {
    id: 'emp',
    label: 'EMP Coil',
    body,
    moving: { trigger },
    nodes: {
      triggerSeat: { pos: [0, 0.008, -0.026], rot: [0, 0, 0] },
      triggerPull: -0.3,
      muzzle: [0, axis + 0.006, zMuzzle + 0.03],
      eject: [0, axis + 0.05, -0.05],
      ejectDir: [0.2, 1, 0.1],
      gripL: [0, axis - 0.106, -0.180],
      hand: { pos: [0.011, -0.004, 0.006], rot: [0, 0, 0] },
      holster: { pos: [-0.16, 0.0, 0.16], rot: [0.1, 0.32, 0.45] },
      /* The rig pulses these with the charge state — see `thirdperson.js`. */
      glow: [
        { pos: [0, axis + 0.006, zMuzzle + 0.036], mat: 'glow_arc', r: 0.0032, key: 'gap' },
        { pos: [0, axis + 0.006, zMuzzle + 0.036], mat: 'glow_charge', r: 0.0075, key: 'halo' },
      ],
    },
    span: 0.80,
  };
}
