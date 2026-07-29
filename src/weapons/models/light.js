import * as THREE from 'three';
import { Assembly } from '../geometry.js';
import {
  box, blob, latheZ, tubeZ, rodZ, extrude, ring, screw, knurlBand,
  pipe, coupling, weldBead, weldRing, tapeWrap, hoseRun, popRivet,
  hoseClamp, gauge, sheetChannel, ribbedDrum, nailStrip, nail, scavengedGrip,
  rodGuard, wireTrigger, dent,
} from './kit.js';

/**
 * LIGHT — Nail Gun, Tack Cannon, Paint Cannon, Shop SMG.
 *
 * The high-rate, low-damage end of the arsenal. Three of them are real tools
 * doing a job they were not designed for; one is a gun somebody welded in a
 * body shop out of tube and sheet.
 *
 * SILHOUETTE BRIEF (they have to be told apart at 60 px):
 *   Nail Gun     stubby, fat cylinder, magazine raked back at 20 deg
 *   Tack Cannon  a DRUM on top — the only round-topped thing in the game
 *   Paint Cannon a wide CONE at the front and a pot slung underneath
 *   Shop SMG     a straight square box with a stick mag hanging out the bottom
 *
 * Convention: +X right, +Y up, -Z toward the muzzle, origin at the web of the
 * shooting hand.
 */

/* ========================================================================== */
/*  NAIL GUN                                                                  */
/* ========================================================================== */

/**
 * A pneumatic framing nailer — the real thing, turned on its side so the driver
 * blade points forward instead of down.
 *
 * Dimensions off a 34-degree clipped-head framing nailer: 350 mm nose to heel,
 * 76 mm cylinder, a magazine raked at 34 degrees carrying two strips of 3¼"
 * collated nails, and a 3/8" industrial quick-connect on the cap.
 *
 * The read is TOOL, not gun: safety yellow over a die-cast magnesium head, a
 * chromed cylinder sleeve, a red no-mar tip, and a hose stub that says this
 * thing is supposed to be plugged into a compressor.
 */
export function buildNailGun(rng) {
  const bore = 0.062;           // driver axis above the grip web
  const zNose = -0.205;
  const body = new Assembly('nailgun');

  /* ---- air cylinder: the mass of the tool ------------------------------ */
  const cyl = latheZ(
    [
      [0.075, 0], [0.075, 0.030],
      [0.070, 0.0355],
      [0.052, 0.038],
      [-0.055, 0.038],
      [-0.062, 0.0355],
      [-0.066, 0.030], [-0.066, 0],
    ],
    22
  );
  body.add(cyl, 'imp_paint_yellow', { y: bore, z: -0.055 });
  cyl.dispose();

  // Chromed sleeve band around the middle — the exhaust deflector clamp.
  const sleeve = tubeZ(0.0395, 0.0378, 0.030, 22, 0.0004);
  body.add(sleeve, 'imp_chrome', { y: bore, z: -0.055 });
  sleeve.dispose();
  // Cast cooling ribs on the yellow shell.
  for (let i = 0; i < 5; i++) {
    const r = ring(0.0385, 0.0022, 20, 6);
    r.rotateY(Math.PI / 2);
    body.add(r, 'imp_paint_yellow', { y: bore, z: -0.10 + i * 0.011 });
    r.dispose();
  }

  /* ---- cap + quick-connect --------------------------------------------- */
  const cap = latheZ(
    [
      [0, 0], [0, 0.0345], [0.006, 0.0375], [0.020, 0.0375],
      [0.024, 0.032], [0.024, 0],
    ],
    20
  );
  body.add(cap, 'imp_plastic', { y: bore, z: 0.020 });
  cap.dispose();
  for (let i = 0; i < 4; i++) {
    const a = (i / 4) * Math.PI * 2 + 0.6;
    const s = screw(0.0038, 0.0018, 0.0014, 0.006, 10);
    body.add(s, 'imp_zinc', {
      x: Math.cos(a) * 0.026, y: bore + Math.sin(a) * 0.026, z: 0.044, ry: Math.PI,
    });
    s.dispose();
  }
  // The exhaust port, blowing sideways as it should.
  const exhaust = tubeZ(0.0075, 0.005, 0.012, 10, 0.0004);
  body.add(exhaust, 'imp_chrome', { x: 0.036, y: bore + 0.012, z: 0.004, ry: Math.PI / 2 });
  exhaust.dispose();

  // 3/8" industrial quick-connect at the heel, with a stub of red air hose.
  const qc = latheZ(
    [[0, 0], [0, 0.009], [0.006, 0.011], [0.012, 0.011], [0.013, 0.0085], [0.022, 0.008], [0.022, 0]],
    12
  );
  body.add(qc, 'imp_brass', { y: bore - 0.012, z: 0.046, rx: -0.35, ry: Math.PI });
  qc.dispose();
  {
    const h = hoseRun([0, bore - 0.024, 0.066], [0.026, bore - 0.086, 0.086], 0.028, { radius: 0.0062, steps: 12 });
    body.add(h, 'imp_hose', {});
    h.dispose();
  }

  /* ---- die-cast nose ---------------------------------------------------- */
  const nose = latheZ(
    [
      [0, 0], [0, 0.036],
      [-0.020, 0.032],
      [-0.052, 0.022],
      [-0.066, 0.0175],
      [-0.078, 0.014], [-0.078, 0],
    ],
    20
  );
  body.add(nose, 'imp_grease', { y: bore, z: -0.128 });
  nose.dispose();
  // Cast web ribs on the nose — a die-casting is never a smooth cone.
  for (const sx of [-1, 1]) {
    const rib = extrude([[0, 0], [0.062, 0], [0.05, 0.012], [0, 0.016]], 0.0035, { bevel: 0.0006 });
    body.add(rib, 'imp_grease', {
      x: sx * 0.018, y: bore + 0.016, z: -0.20, ry: sx > 0 ? -Math.PI / 2 : Math.PI / 2, rz: 0,
    });
    rib.dispose();
  }

  /* ---- muzzle: the no-mar tip and the safety contact trip --------------- */
  const tip = latheZ(
    [[0, 0], [0, 0.0135], [0.008, 0.0135], [0.010, 0.011], [0.010, 0.0045], [0, 0.0045]],
    14
  );
  body.add(tip, 'imp_paint_red', { y: bore, z: zNose + 0.005, ry: Math.PI });
  tip.dispose();
  // Driver blade visible down the throat.
  const throat = tubeZ(0.0043, 0.0016, 0.03, 10, 0.0002);
  body.add(throat, 'cavity', { y: bore, z: zNose + 0.014 });
  throat.dispose();
  const driver = rodZ(0.0026, 0.0026, 0.026, 8, 0.0003);
  body.add(driver, 'imp_chrome', { y: bore, z: zNose + 0.022 });
  driver.dispose();

  // Contact-trip: a sprung wire yoke standing off the nose. Reads instantly as
  // "safety mechanism", which is the strongest single tool cue on the model.
  {
    const yoke = rodGuard(0.036, 0.030, 0.0018);
    body.add(yoke, 'imp_chrome', { y: bore + 0.014, z: zNose + 0.016, rx: Math.PI / 2, ry: Math.PI / 2 });
    yoke.dispose();
    const springWire = new THREE.TorusGeometry(0.0038, 0.0009, 5, 12, Math.PI * 1.7);
    body.add(springWire, 'imp_chrome', { x: 0.014, y: bore + 0.020, z: -0.16, ry: Math.PI / 2 });
    body.add(springWire, 'imp_chrome', { x: -0.014, y: bore + 0.020, z: -0.16, ry: Math.PI / 2 });
    springWire.dispose();
  }

  /* ---- magazine: raked back at 34 degrees, loaded with real nails ------- */
  const magLen = 0.185;
  const rake = 0.60;            // radians from the bore
  const magZ = -0.108;
  const magY = bore - 0.052;
  const chan = sheetChannel(0.030, 0.026, magLen, 0.0016, 0.05);
  body.add(chan, 'imp_galv', { y: magY, z: magZ, rx: -rake });
  chan.dispose();
  // Follower slot down the side, and the spring-loaded pusher in it.
  const slot = box(0.0026, 0.010, magLen * 0.82, 0.0004, 1);
  body.add(slot, 'cavity', { x: 0.0152, y: magY, z: magZ, rx: -rake });
  slot.dispose();
  const pusher = box(0.010, 0.017, 0.012, 0.0012, 1);
  body.add(pusher, 'imp_paint_yellow', { x: 0.010, y: magY + 0.030, z: magZ + 0.052, rx: -rake });
  pusher.dispose();

  // The nails themselves, visible through the open side of the channel.
  {
    const strip = nailStrip(13, 0.0063, 0.070, 0.0016);
    body.add(strip, 'imp_zinc', { y: magY + 0.001, z: magZ - 0.01, rx: -rake, ry: Math.PI / 2, rz: 0.0 });
    strip.dispose();
  }
  // Magazine end cap with a latch.
  const magCap = box(0.032, 0.030, 0.010, 0.0016, 1);
  body.add(magCap, 'imp_grease', {
    y: magY + Math.sin(rake) * magLen * 0.5, z: magZ + Math.cos(rake) * magLen * 0.5, rx: -rake,
  });
  magCap.dispose();
  // The bracket tying the magazine's front to the nose casting.
  const bracket = extrude([[0, 0], [0.030, 0], [0.030, 0.020], [0.004, 0.030], [0, 0.026]], 0.0022, { bevel: 0.0005 });
  body.add(bracket, 'imp_galv', { x: 0.0, y: bore - 0.052, z: -0.176, ry: Math.PI / 2, rz: 0.3 });
  bracket.dispose();

  /* ---- grip, trigger, guard --------------------------------------------- */
  const grip = scavengedGrip('tool', { len: 0.115, w: 0.036, d: 0.048 });
  body.add(grip, 'imp_paint_yellow', { y: -0.036, z: 0.014, rx: 1.30 });
  grip.dispose();
  const gripPad = blob(0.0335, 0.020, 0.086, 0.008, 3);
  body.add(gripPad, 'imp_hose', { y: -0.048, z: 0.004, rx: 1.30 });
  gripPad.dispose();
  // Yellow-and-black hazard band at the top of the grip, like every power tool.
  for (let i = 0; i < 3; i++) {
    const b = box(0.037, 0.0008, 0.008, 0.0003, 1);
    body.add(b, 'imp_tape_black', { y: 0.006 - i * 0.001, z: 0.030 - i * 0.014, rx: 1.30 });
    b.dispose();
  }

  const guard = rodGuard(0.046, 0.034, 0.0028);
  body.add(guard, 'imp_grease', { y: 0.014, z: -0.026 });
  guard.dispose();

  const trigger = new Assembly('nailgun-trigger');
  const trg = wireTrigger({ thick: 0.010 });
  trigger.add(trg, 'imp_grease', {});
  trg.dispose();

  /* ---- shop wear: a splash of somebody else's paint --------------------- */
  for (let i = 0; i < 5; i++) {
    const a = rng.float() * Math.PI * 2;
    const s = 0.5 + rng.float() * 0.8;
    const sp = new THREE.SphereGeometry(0.007 * s, 7, 5);
    sp.scale(1.6, 0.22, 2.1);
    body.add(sp, 'imp_paint_teal', {
      x: Math.cos(a) * 0.036, y: bore + Math.sin(a) * 0.036,
      z: -0.13 + rng.float() * 0.14, rz: a - Math.PI / 2, ry: rng.signed() * 0.6,
    });
    sp.dispose();
  }

  return {
    id: 'nailgun',
    label: 'Nail Gun',
    body,
    moving: { trigger },
    nodes: {
      triggerSeat: { pos: [0, 0.004, -0.020], rot: [0, 0, 0] },
      triggerPull: -0.34,
      muzzle: [0, bore, zNose - 0.004],
      eject: [0.030, bore + 0.012, 0.004],
      ejectDir: [0.9, 0.35, 0.2],
      gripL: [-0.012, bore - 0.05, -0.13],
      hand: { pos: [0.011, -0.004, 0.008], rot: [0, 0, 0] },
      holster: { pos: [-0.13, -0.05, 0.11], rot: [0, 0.35, 0.25] },
      glow: [{ pos: [0.024, bore + 0.028, 0.030], mat: 'glow_led', r: 0.0026 }],
    },
    span: 0.30,
  };
}

/* ========================================================================== */
/*  TACK CANNON                                                               */
/* ========================================================================== */

/**
 * An upholstery tack hammer's ammunition, an air compressor and a drum hopper,
 * bolted to a length of angle iron. Dylan built it.
 *
 * The DRUM is the whole silhouette — a 110 mm pancake magazine sitting on top of
 * the receiver, the only round-topped object in the arsenal. Everything else is
 * deliberately blocky so the drum reads.
 */
export function buildTackCannon(rng) {
  const bore = 0.058;
  const zMuzzle = -0.30;
  const body = new Assembly('tackgun');

  /* ---- receiver: two lengths of angle iron with a plate between them ---- */
  const rec = box(0.048, 0.052, 0.235, 0.0022, 2);
  dent(rec, rng, { count: 4, radius: 0.022, depth: 0.0015 });
  body.add(rec, 'imp_paint_yellow', { y: bore - 0.006, z: -0.115 });
  rec.dispose();
  for (const sx of [-1, 1]) {
    const ang = extrude([[0, 0], [0.020, 0], [0.020, 0.004], [0.004, 0.004], [0.004, 0.024], [0, 0.024]], 0.235, { bevel: 0.0006 });
    body.add(ang, 'imp_steel', {
      x: sx * 0.024, y: bore - 0.030, z: -0.115, sx: sx, ry: 0,
    });
    ang.dispose();
  }
  // Weld beads along the top seams — this thing was fabricated, not moulded.
  for (const sx of [-1, 1]) {
    const w = weldBead(0.22, rng, { radius: 0.0021 });
    body.add(w, 'imp_steel', { x: sx * 0.0244, y: bore + 0.019, z: -0.115 });
    w.dispose();
  }
  for (let i = 0; i < 6; i++) {
    const r = popRivet(0.0024);
    body.add(r, 'imp_zinc', { x: 0.0245, y: bore - 0.020, z: -0.02 - i * 0.036, ry: Math.PI / 2 });
    body.add(r, 'imp_zinc', { x: -0.0245, y: bore - 0.020, z: -0.02 - i * 0.036, ry: -Math.PI / 2 });
    r.dispose();
  }

  /* ---- THE DRUM -------------------------------------------------------- */
  const drumR = 0.056;
  const drum = latheZ(
    [
      [-0.021, 0], [-0.021, drumR - 0.006],
      [-0.017, drumR],
      [0.017, drumR],
      [0.021, drumR - 0.006], [0.021, 0],
    ],
    26
  );
  dent(drum, rng, { count: 5, radius: 0.02, depth: 0.0018 });
  body.add(drum, 'imp_galv', { y: bore + 0.070, z: -0.078, rx: Math.PI / 2 });
  drum.dispose();
  // Wind-up key and the spiral spring cover on the drum face.
  const hub = latheZ([[0, 0], [0, 0.016], [0.010, 0.014], [0.010, 0]], 14);
  body.add(hub, 'imp_grease', { x: 0.021, y: bore + 0.070, z: -0.078, ry: Math.PI / 2 });
  hub.dispose();
  const keyBar = box(0.030, 0.0055, 0.0075, 0.0008, 1);
  body.add(keyBar, 'imp_grease', { x: 0.033, y: bore + 0.070, z: -0.078, ry: Math.PI / 2, rz: 0.6 });
  keyBar.dispose();
  // Witness slot: a window with tacks visible through it.
  const win = box(0.0035, 0.052, 0.010, 0.0004, 1);
  body.add(win, 'cavity', { x: -0.0205, y: bore + 0.070, z: -0.078, ry: Math.PI / 2, rz: 0.5 });
  win.dispose();
  for (let i = 0; i < 7; i++) {
    const t = nail(0.0013, 0.013, { headR: 3.4, headSeg: 6, seg: 6 });
    body.add(t, 'imp_zinc', {
      x: -0.019,
      y: bore + 0.070 + Math.cos(0.5) * (0.014 + i * 0.006),
      z: -0.078 + Math.sin(0.5) * (0.014 + i * 0.006),
      ry: Math.PI / 2,
    });
    t.dispose();
  }
  // Two straps clamping the drum to the receiver.
  for (const dz of [-0.030, 0.030]) {
    const strap = ring(drumR + 0.002, 0.0022, 22, 6, Math.PI * 0.9);
    body.add(strap, 'imp_steel', { y: bore + 0.070, z: -0.078 + dz, rz: -Math.PI * 0.45, ry: Math.PI / 2 });
    strap.dispose();
  }

  /* ---- feed rail and barrel -------------------------------------------- */
  const rail = sheetChannel(0.020, 0.017, 0.145, 0.0015, 0.02);
  body.add(rail, 'imp_galv', { y: bore + 0.004, z: -0.235 });
  rail.dispose();
  const brl = pipe(0.010, 0.0022, 0.14, { seg: 16, bow: 0.0012 });
  body.add(brl, 'imp_steel', { y: bore, z: -0.235 });
  brl.dispose();
  const boreHole = tubeZ(0.0078, 0.0008, 0.05, 12, 0.0002);
  body.add(boreHole, 'cavity', { y: bore, z: zMuzzle + 0.026 });
  boreHole.dispose();
  const muzzleClamp = hoseClamp(0.0108, 0.009);
  body.add(muzzleClamp, 'imp_zinc', { y: bore, z: zMuzzle + 0.016 });
  body.add(muzzleClamp, 'imp_zinc', { y: bore, z: -0.20 });
  muzzleClamp.dispose();
  // Front sight: a bent nail welded to the clamp. Nothing here is a real sight.
  const fs = rodZ(0.0013, 0.0011, 0.020, 6, 0.0002);
  body.add(fs, 'imp_steel', { y: bore + 0.020, z: zMuzzle + 0.016, rx: Math.PI / 2 });
  fs.dispose();

  /* ---- pneumatics: a little compressor tank slung on the left ---------- */
  const tank = latheZ(
    [[-0.055, 0], [-0.052, 0.019], [-0.040, 0.022], [0.040, 0.022], [0.052, 0.019], [0.055, 0]],
    18
  );
  body.add(tank, 'imp_paint_blue', { x: -0.040, y: bore - 0.028, z: -0.115, ry: 0.06 });
  tank.dispose();
  {
    const g = gauge(0.013);
    body.add(g.body, 'imp_brass', { x: -0.040, y: bore - 0.006, z: -0.062, rx: -1.2 });
    body.add(g.face, 'imp_plastic', { x: -0.040, y: bore + 0.0035, z: -0.0605, rx: -1.2 });
    body.add(g.needle, 'imp_paint_red', { x: -0.040, y: bore + 0.004, z: -0.0605, rx: -1.2, rz: 0.9 });
    g.body.dispose(); g.face.dispose(); g.needle.dispose();
  }
  {
    const h = hoseRun([-0.040, bore - 0.028, -0.172], [-0.012, bore + 0.002, -0.222], 0.022, { radius: 0.005, steps: 10 });
    body.add(h, 'imp_hose', {});
    h.dispose();
  }

  /* ---- grip, guard, trigger, stock -------------------------------------- */
  const grip = scavengedGrip('bike', { len: 0.112, w: 0.036 });
  body.add(grip, 'imp_hose', { y: -0.048, z: 0.012, rx: 1.24 });
  grip.dispose();
  const tang = box(0.010, 0.052, 0.030, 0.0014, 1);
  body.add(tang, 'imp_steel', { y: bore - 0.048, z: 0.004, rx: 0.3 });
  tang.dispose();

  const guard = rodGuard(0.050, 0.036, 0.003);
  body.add(guard, 'imp_steel', { y: 0.012, z: -0.030 });
  guard.dispose();

  const trigger = new Assembly('tackgun-trigger');
  const trg = wireTrigger({ thick: 0.008 });
  trigger.add(trg, 'imp_grease', {});
  trg.dispose();

  // Wire stock: 8 mm bar bent into a loop, taped where the cheek goes.
  {
    const pts = [
      new THREE.Vector3(0.020, bore - 0.026, 0.030),
      new THREE.Vector3(0.026, bore - 0.048, 0.115),
      new THREE.Vector3(0.016, bore - 0.062, 0.196),
      new THREE.Vector3(-0.016, bore - 0.062, 0.196),
      new THREE.Vector3(-0.026, bore - 0.048, 0.115),
      new THREE.Vector3(-0.020, bore - 0.026, 0.030),
    ];
    const g = new THREE.TubeGeometry(new THREE.CatmullRomCurve3(pts), 30, 0.0042, 7, false);
    g.deleteAttribute('uv');
    g.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(g.getAttribute('position').count * 2), 2));
    body.add(g, 'imp_steel', {});
    g.dispose();
  }
  const pad = blob(0.040, 0.016, 0.026, 0.006, 3);
  body.add(pad, 'imp_tape_duct', { y: bore - 0.062, z: 0.190 });
  pad.dispose();
  const foreWrap = tapeWrap(0.0245, 0.070, rng, { band: 0.020, thick: 0.0012, seg: 14 });
  body.add(foreWrap, 'imp_tape_duct', { y: bore - 0.006, z: -0.196, sx: 1.05, sy: 1.15 });
  foreWrap.dispose();

  return {
    id: 'tackgun',
    label: 'Tack Cannon',
    body,
    moving: { trigger },
    nodes: {
      triggerSeat: { pos: [0, 0.008, -0.024], rot: [0, 0, 0] },
      triggerPull: -0.3,
      muzzle: [0, bore, zMuzzle],
      eject: [0.026, bore + 0.010, -0.06],
      ejectDir: [0.95, 0.25, 0.1],
      gripL: [-0.006, bore - 0.020, -0.205],
      hand: { pos: [0.011, -0.004, 0.006], rot: [0, 0, 0] },
      holster: { pos: [-0.14, -0.04, 0.13], rot: [0, 0.3, 0.2] },
    },
    span: 0.52,
  };
}

/* ========================================================================== */
/*  PAINT CANNON                                                              */
/* ========================================================================== */

/**
 * A body-shop pressure pot and a spray gun, with the nozzle cut off and a
 * funnel welded on. Fires seven gobs of enamel at once — the game's shotgun.
 *
 * The CONE at the front is the read, and it is enormous on purpose: a 92 mm
 * mouth on a 520 mm weapon. Under it hangs the pot, which is the second
 * silhouette cue and the only place a critic will look for the "improvised"
 * claim to be earned — so it is a real pressure vessel with a clamped lid,
 * a relief valve, a sight tube and paint down the outside.
 */
export function buildPaintCannon(rng) {
  const bore = 0.056;
  const zMuzzle = -0.29;
  const body = new Assembly('sprayer');

  /* ---- the funnel ------------------------------------------------------- */
  const cone = latheZ(
    [
      [0, 0.021], [0.004, 0.0225],
      [0.070, 0.046], [0.074, 0.0472],
      [0.074, 0.0448], [0.070, 0.0436],
      [0.004, 0.0205], [0, 0.019],
    ],
    24
  );
  dent(cone, rng, { count: 5, radius: 0.024, depth: 0.0022 });
  body.add(cone, 'imp_galv', { y: bore, z: zMuzzle + 0.074, ry: Math.PI });
  cone.dispose();
  const coneWeld = weldRing(0.0212, rng, { radius: 0.0018, count: 18 });
  body.add(coneWeld, 'imp_steel', { y: bore, z: zMuzzle + 0.075 });
  coneWeld.dispose();
  // Paint crust around the mouth: this thing has been fired a lot.
  for (let i = 0; i < 9; i++) {
    const a = rng.float() * Math.PI * 2;
    const s = 0.6 + rng.float() * 1.0;
    const cr = new THREE.SphereGeometry(0.0075 * s, 7, 5);
    cr.scale(1.2, 1.2, 0.5);
    body.add(cr, 'imp_paint_teal', {
      x: Math.cos(a) * 0.046, y: bore + Math.sin(a) * 0.046, z: zMuzzle + 0.004,
      rz: a, ry: rng.signed() * 0.4,
    });
    cr.dispose();
  }

  /* ---- gun body: a fat tube with the air cap on the front --------------- */
  const barrel = pipe(0.021, 0.0025, 0.165, { seg: 20, bow: 0.001 });
  body.add(barrel, 'imp_steel', { y: bore, z: -0.145 });
  barrel.dispose();
  const boreHole = tubeZ(0.0182, 0.001, 0.06, 14, 0.0003);
  body.add(boreHole, 'cavity', { y: bore, z: zMuzzle + 0.104 });
  boreHole.dispose();
  const airCap = coupling(0.0212, { len: 0.028, wall: 0.0055, seg: 20 });
  body.add(airCap, 'imp_brass', { y: bore, z: -0.204 });
  airCap.dispose();
  const knurl = knurlBand(0.0272, 0.020, 26, 0.0004, 3);
  body.add(knurl, 'imp_brass', { y: bore, z: -0.204 });
  knurl.dispose();

  /* ---- pressure pot slung underneath ------------------------------------ */
  const potR = 0.047;
  const pot = ribbedDrum(potR, 0.115, 2, { seg: 22 });
  dent(pot, rng, { count: 5, radius: 0.026, depth: 0.0022 });
  body.add(pot, 'imp_paint_teal', { y: bore - 0.088, z: -0.084, rx: Math.PI / 2 });
  pot.dispose();
  // Lid with three toggle clamps.
  const lid = latheZ(
    [[0, 0], [0, potR + 0.004], [0.008, potR + 0.004], [0.010, potR - 0.004], [0.010, 0]],
    22
  );
  body.add(lid, 'imp_galv', { y: bore - 0.030, z: -0.084, rx: -Math.PI / 2 });
  lid.dispose();
  for (let i = 0; i < 3; i++) {
    const a = (i / 3) * Math.PI * 2 + 0.5;
    const cl = box(0.010, 0.022, 0.006, 0.0009, 1);
    body.add(cl, 'imp_zinc', {
      x: Math.cos(a) * (potR + 0.002), y: bore - 0.036,
      z: -0.084 + Math.sin(a) * (potR + 0.002), ry: -a,
    });
    cl.dispose();
  }
  // Sight tube down the side: a length of clear hose with paint in it.
  const sight = tubeZ(0.0042, 0.0032, 0.098, 10, 0.0003);
  body.add(sight, 'imp_hose', { x: potR - 0.002, y: bore - 0.088, z: -0.028, rx: Math.PI / 2 });
  sight.dispose();

  /* ---- plumbing --------------------------------------------------------- */
  {
    const h = hoseRun([0.0, bore - 0.032, -0.128], [0.0, bore - 0.012, -0.176], 0.016, { radius: 0.0065, steps: 10 });
    body.add(h, 'imp_hose', {});
    h.dispose();
    const c1 = hoseClamp(0.0072, 0.007);
    body.add(c1, 'imp_zinc', { y: bore - 0.030, z: -0.128, rx: 0.9 });
    body.add(c1, 'imp_zinc', { y: bore - 0.014, z: -0.174, rx: 1.2 });
    c1.dispose();
  }
  {
    const g = gauge(0.017);
    body.add(g.body, 'imp_brass', { x: -0.030, y: bore + 0.020, z: -0.086, rx: -0.5, ry: -0.55 });
    body.add(g.face, 'imp_plastic', { x: -0.0315, y: bore + 0.0292, z: -0.0844, rx: -0.5, ry: -0.55 });
    body.add(g.needle, 'imp_paint_red', { x: -0.0318, y: bore + 0.0296, z: -0.0843, rx: -0.5, ry: -0.55, rz: -0.7 });
    g.body.dispose(); g.face.dispose(); g.needle.dispose();
  }
  // Relief valve with a ring pull on the top of the barrel.
  const valve = latheZ([[0, 0], [0, 0.008], [0.010, 0.008], [0.011, 0.005], [0.018, 0.005], [0.018, 0]], 12);
  body.add(valve, 'imp_brass', { x: 0.016, y: bore + 0.020, z: -0.150, rx: -1.2, rz: 0.3 });
  valve.dispose();
  const pull = ring(0.008, 0.0013, 12, 5);
  body.add(pull, 'imp_zinc', { x: 0.016, y: bore + 0.046, z: -0.150, rx: 0.3 });
  pull.dispose();

  /* ---- pump handle out of the back — the reload animation drives this --- */
  const pumpRod = rodZ(0.0072, 0.0072, 0.13, 12, 0.0006);
  const pump = new Assembly('sprayer-pump');
  pump.add(pumpRod, 'imp_chrome', { y: bore - 0.006, z: 0.075 });
  pumpRod.dispose();
  const pumpKnob = blob(0.030, 0.026, 0.030, 0.010, 3);
  pump.add(pumpKnob, 'imp_wood', { y: bore - 0.006, z: 0.142 });
  pumpKnob.dispose();

  /* ---- grip / trigger / fore-end ---------------------------------------- */
  const grip = scavengedGrip('tool', { len: 0.112, w: 0.036, d: 0.046 });
  body.add(grip, 'imp_plastic', { y: -0.044, z: 0.014, rx: 1.26 });
  grip.dispose();
  const gripWrap = tapeWrap(0.019, 0.070, rng, { band: 0.020, thick: 0.0012, seg: 12 });
  body.add(gripWrap, 'imp_tape_black', { y: -0.052, z: 0.006, rx: 1.26, sx: 1.05, sy: 1.25 });
  gripWrap.dispose();
  const guard = rodGuard(0.050, 0.038, 0.003);
  body.add(guard, 'imp_steel', { y: 0.012, z: -0.030 });
  guard.dispose();
  const trigger = new Assembly('sprayer-trigger');
  const trg = wireTrigger({ thick: 0.011 });
  trigger.add(trg, 'imp_chrome', {});
  trg.dispose();

  // Fore-end: a bit of broom handle hose-clamped to the barrel.
  const fore = rodZ(0.0165, 0.0155, 0.105, 14, 0.0012);
  body.add(fore, 'imp_wood', { y: bore - 0.040, z: -0.150, rx: 0.18 });
  fore.dispose();
  for (const dz of [-0.108, -0.192]) {
    const br = box(0.0055, 0.040, 0.010, 0.0008, 1);
    body.add(br, 'imp_steel', { y: bore - 0.020, z: dz });
    br.dispose();
  }

  return {
    id: 'sprayer',
    label: 'Paint Cannon',
    body,
    moving: { trigger, pump },
    nodes: {
      triggerSeat: { pos: [0, 0.008, -0.024], rot: [0, 0, 0] },
      triggerPull: -0.28,
      pumpSeat: { pos: [0, 0, 0], rot: [0, 0, 0] },
      pumpTravel: [0, 0, 0.085],
      muzzle: [0, bore, zMuzzle - 0.004],
      eject: [0, bore + 0.02, -0.15],
      ejectDir: [0.2, 1, 0.1],
      gripL: [0, bore - 0.046, -0.155],
      hand: { pos: [0.011, -0.004, 0.006], rot: [0, 0, 0] },
      holster: { pos: [-0.15, -0.05, 0.12], rot: [0, 0.32, 0.2] },
    },
    span: 0.52,
  };
}

/* ========================================================================== */
/*  SHOP SMG                                                                  */
/* ========================================================================== */

/**
 * An open-bolt 9 mm made out of square tube, a length of hydraulic line and a
 * bicycle grip, in a body shop, by somebody who is good at welding and has
 * never seen a machinist's drawing.
 *
 * Everything about it is honest about how it was made: the receiver is SQUARE
 * (a tube you can buy), the barrel is a pipe with a nut brazed on, the sights
 * are a filed notch and a welded nail, the stock is 8 mm bar bent in a vice,
 * and there is a weld bead down every seam with the spatter still on it.
 */
export function buildShopSmg(rng) {
  const bore = 0.060;
  const zMuzzle = -0.315;
  const body = new Assembly('smg');

  /* ---- square receiver -------------------------------------------------- */
  const recLen = 0.255;
  const rec = box(0.052, 0.052, recLen, 0.0026, 2);
  dent(rec, rng, { count: 5, radius: 0.024, depth: 0.0016 });
  body.add(rec, 'imp_steel', { y: bore, z: -0.075 });
  rec.dispose();
  // Weld beads down all four long seams.
  for (const [sx, sy] of [[1, 1], [-1, 1], [1, -1], [-1, -1]]) {
    const w = weldBead(recLen - 0.01, rng, { radius: 0.0019 });
    body.add(w, 'imp_steel', { x: sx * 0.0262, y: bore + sy * 0.0262, z: -0.075 });
    w.dispose();
  }
  // End caps, brazed on, slightly proud.
  const cap = box(0.056, 0.056, 0.006, 0.0012, 1);
  body.add(cap, 'imp_steel', { y: bore, z: -0.075 + recLen / 2 + 0.001 });
  cap.dispose();
  const capWeld = weldBead(0.052, rng, { radius: 0.002 });
  for (const sx of [1, -1]) {
    body.add(capWeld, 'imp_steel', {
      x: sx * 0.027, y: bore, z: -0.075 + recLen / 2 - 0.002,
      ry: Math.PI / 2, rz: Math.PI / 2,
    });
  }
  capWeld.dispose();

  /* ---- cocking slot with a welded knob ---------------------------------- */
  const slot = box(0.0042, 0.011, 0.115, 0.0006, 1);
  body.add(slot, 'cavity', { x: 0.0262, y: bore + 0.014, z: -0.10 });
  slot.dispose();
  const bolt = new Assembly('smg-bolt');
  const knobStem = rodZ(0.0048, 0.0048, 0.020, 10, 0.0006);
  bolt.add(knobStem, 'imp_grease', { x: 0.034, y: bore + 0.014, z: 0, ry: Math.PI / 2 });
  knobStem.dispose();
  const knob = blob(0.017, 0.017, 0.019, 0.006, 3);
  bolt.add(knob, 'imp_grease', { x: 0.046, y: bore + 0.014, z: 0 });
  knob.dispose();
  const knurl = knurlBand(0.0088, 0.016, 16, 0.0004, 3);
  bolt.add(knurl, 'imp_grease', { x: 0.046, y: bore + 0.014, z: 0, ry: Math.PI / 2 });
  knurl.dispose();

  /* ---- ejection port: a hole cut with an angle grinder ------------------ */
  const port = box(0.010, 0.024, 0.052, 0.0008, 1);
  body.add(port, 'cavity', { x: -0.024, y: bore + 0.004, z: -0.10 });
  port.dispose();
  const portLip = extrude(
    [[-0.028, -0.012], [0.028, -0.012], [0.028, 0.012], [-0.028, 0.012]],
    0.0018,
    { bevel: 0.0005 }
  );
  body.add(portLip, 'imp_steel', { x: -0.0268, y: bore + 0.004, z: -0.10, ry: Math.PI / 2 });
  portLip.dispose();
  // Grinder scars radiating from the port — the most characterful detail on it.
  for (let i = 0; i < 6; i++) {
    const s = box(0.0016, 0.0006, 0.020 + rng.float() * 0.02, 0.0002, 1);
    body.add(s, 'imp_steel', {
      x: -0.0264, y: bore + 0.004 + rng.signed() * 0.020, z: -0.10 + rng.signed() * 0.045,
      ry: Math.PI / 2, rz: rng.signed() * 0.5,
    });
    s.dispose();
  }

  /* ---- barrel: hydraulic line with a nut brazed on --------------------- */
  const brl = pipe(0.0105, 0.0026, 0.145, { seg: 16, bow: 0.0014 });
  body.add(brl, 'imp_steel', { y: bore, z: -0.272 });
  brl.dispose();
  const boreHole = tubeZ(0.0075, 0.0045, 0.05, 12, 0.0002);
  body.add(boreHole, 'cavity', { y: bore, z: zMuzzle + 0.026 });
  boreHole.dispose();
  const nut = new THREE.CylinderGeometry(0.0165, 0.0165, 0.014, 6, 1);
  nut.rotateX(Math.PI / 2);
  body.add(nut, 'imp_zinc', { y: bore, z: -0.206, rz: 0.4 });
  nut.dispose();
  const nutWeld = weldRing(0.0118, rng, { radius: 0.0018, count: 14 });
  body.add(nutWeld, 'imp_steel', { y: bore, z: -0.200 });
  nutWeld.dispose();
  // A perforated jacket over the front half — a bit of exhaust heat shield.
  const jacket = tubeZ(0.0165, 0.0152, 0.082, 18, 0.0004);
  body.add(jacket, 'imp_galv', { y: bore, z: -0.256 });
  jacket.dispose();
  for (let r = 0; r < 3; r++) {
    for (let i = 0; i < 8; i++) {
      const a = (i / 8) * Math.PI * 2 + r * 0.4;
      const h = tubeZ(0.0031, 0.0022, 0.004, 8, 0.0002);
      body.add(h, 'cavity', {
        x: Math.cos(a) * 0.0158, y: bore + Math.sin(a) * 0.0158, z: -0.286 + r * 0.028,
        ry: Math.PI / 2 - a, rx: 0,
      });
      h.dispose();
    }
  }

  /* ---- sights: a nail and a filed notch --------------------------------- */
  const fsBase = box(0.014, 0.006, 0.012, 0.0008, 1);
  body.add(fsBase, 'imp_steel', { y: bore + 0.018, z: -0.290 });
  fsBase.dispose();
  const fsPost = rodZ(0.0013, 0.0011, 0.014, 6, 0.0002);
  body.add(fsPost, 'imp_steel', { y: bore + 0.027, z: -0.290, rx: Math.PI / 2 });
  fsPost.dispose();
  const rs = extrude(
    [[-0.011, 0], [0.011, 0], [0.011, 0.013], [0.002, 0.013], [0, 0.006], [-0.002, 0.013], [-0.011, 0.013]],
    0.0035,
    { bevel: 0.0005 }
  );
  body.add(rs, 'imp_steel', { y: bore + 0.026, z: -0.010 });
  rs.dispose();

  /* ---- magazine well and stick mag -------------------------------------- */
  const well = box(0.032, 0.030, 0.062, 0.0016, 1);
  body.add(well, 'imp_steel', { y: bore - 0.040, z: -0.128, rx: -0.06 });
  well.dispose();
  const wellWeld = weldRing(0.028, rng, { radius: 0.0018, count: 16 });
  body.add(wellWeld, 'imp_steel', { y: bore - 0.026, z: -0.128, rx: Math.PI / 2, sx: 1.1, sy: 1.9 });
  wellWeld.dispose();

  const mag = new Assembly('smg-mag');
  const magBody = extrude(
    [[-0.0125, 0.014], [0.0125, 0.014], [0.0125, -0.014], [-0.0125, -0.014]],
    0.155,
    { bevel: 0.0012 }
  );
  {
    // Give it the gentle curve of a stick magazine.
    const pos = magBody.getAttribute('position');
    for (let i = 0; i < pos.count; i++) {
      const t = pos.getZ(i) / 0.155 + 0.5;
      pos.setY(i, pos.getY(i) + t * t * 0.010);
    }
    pos.needsUpdate = true;
    magBody.computeVertexNormals();
  }
  mag.add(magBody, 'imp_grease', { y: bore - 0.128, z: -0.128, rx: Math.PI / 2 - 0.06 });
  magBody.dispose();
  for (let i = 0; i < 5; i++) {
    const rib = box(0.027, 0.0016, 0.005, 0.0004, 1);
    mag.add(rib, 'imp_grease', { y: bore - 0.070 - i * 0.026, z: -0.126 + i * 0.0016, rx: -0.06 });
    rib.dispose();
  }
  const magTape = tapeWrap(0.016, 0.040, rng, { band: 0.018, thick: 0.0011, seg: 10, tail: false });
  mag.add(magTape, 'imp_tape_duct', { y: bore - 0.180, z: -0.118, rx: Math.PI / 2, sx: 1.5 });
  magTape.dispose();

  /* ---- grip, trigger, guard --------------------------------------------- */
  const grip = scavengedGrip('bike', { len: 0.118, w: 0.038 });
  body.add(grip, 'imp_hose', { y: -0.050, z: 0.014, rx: 1.22 });
  grip.dispose();
  const gripTang = box(0.011, 0.056, 0.032, 0.0014, 1);
  body.add(gripTang, 'imp_steel', { y: bore - 0.050, z: 0.006, rx: 0.34 });
  gripTang.dispose();
  const guard = rodGuard(0.050, 0.038, 0.003);
  body.add(guard, 'imp_steel', { y: 0.012, z: -0.030 });
  guard.dispose();
  const trigger = new Assembly('smg-trigger');
  const trg = wireTrigger({ thick: 0.009 });
  trigger.add(trg, 'imp_grease', {});
  trg.dispose();

  /* ---- folding wire stock ----------------------------------------------- */
  {
    const pts = [
      new THREE.Vector3(0.024, bore - 0.014, 0.048),
      new THREE.Vector3(0.030, bore - 0.044, 0.130),
      new THREE.Vector3(0.020, bore - 0.058, 0.212),
      new THREE.Vector3(-0.020, bore - 0.058, 0.212),
      new THREE.Vector3(-0.030, bore - 0.044, 0.130),
      new THREE.Vector3(-0.024, bore - 0.014, 0.048),
    ];
    const g = new THREE.TubeGeometry(new THREE.CatmullRomCurve3(pts), 30, 0.0044, 7, false);
    g.deleteAttribute('uv');
    g.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(g.getAttribute('position').count * 2), 2));
    body.add(g, 'imp_steel', {});
    g.dispose();
  }
  const cheek = blob(0.044, 0.018, 0.030, 0.007, 3);
  body.add(cheek, 'imp_tape_duct', { y: bore - 0.058, z: 0.204 });
  cheek.dispose();
  // Sling: a length of seatbelt webbing with a bolt through it.
  const sl = hoseRun([-0.024, bore - 0.014, 0.048], [-0.006, bore - 0.030, -0.256], 0.055, { radius: 0.0045, steps: 12, seg: 5 });
  body.add(sl, 'imp_canvas', { sx: 1, sy: 1, sz: 1 });
  sl.dispose();

  return {
    id: 'smg',
    label: 'Shop SMG',
    body,
    moving: { trigger, mag, bolt },
    nodes: {
      triggerSeat: { pos: [0, 0.008, -0.024], rot: [0, 0, 0] },
      triggerPull: -0.32,
      boltSeat: { pos: [0, 0, -0.10], rot: [0, 0, 0] },
      boltTravel: [0, 0, 0.052],
      magSeat: { pos: [0, 0, 0], rot: [0, 0, 0] },
      magDrop: [0, -0.5, 0.02],
      muzzle: [0, bore, zMuzzle],
      eject: [-0.030, bore + 0.008, -0.10],
      ejectDir: [-0.9, 0.42, 0.12],
      gripL: [0, bore - 0.034, -0.170],
      hand: { pos: [0.011, -0.004, 0.006], rot: [0, 0, 0] },
      holster: { pos: [-0.15, -0.02, 0.10], rot: [0, 0.3, 0.28] },
    },
    span: 0.58,
  };
}
