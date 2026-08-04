/**
 * THE MONONGAHELA — the Steel City trolley, and the rail service that runs it.
 *
 * The player asked for "the subway (trolley with windows) onto train tracks".
 * `railsweep` proves the Strip -> Lawrenceville mill line ('rail_strip') is one
 * continuous 1082 m polyline, so this file puts a PCC-style interurban car on
 * it: a long boxy carriage with a rounded roof crown, a full-length WINDOW BAND
 * down both flanks (lit from inside at night), folding doors both sides, a
 * pantograph, in an ore-red livery over a dark roof — Pittsburgh Railways ran
 * red cars, and the fleet palette already owns the colour.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * WHY THE TRAM IS KINEMATIC AND NOT A CAR WITH INVISIBLE WHEELS
 * ────────────────────────────────────────────────────────────────────────────
 * A rail vehicle's whole character is that it CANNOT deviate: no slip angle,
 * no steering, no suspension wander — the track is the trajectory. Driving the
 * Pacejka tyre model along a ballast strip would spend the entire budget
 * fighting the thing the rails give for free, and any residual would read as a
 * derailment. So `TramService` poses the rigid body directly from a
 * `RailMover` arc position, two bogie samples apart, and
 * `VehicleSystem.fixedUpdate` skips `fixedStep` for anything flagged
 * `kinematic`. The tram still IS a `Vehicle` in `vehicles.vehicles`, which is
 * what buys the living-city half for free:
 *
 *   - traffic's grid sees it, so AI drivers brake for it at the crossings;
 *   - `_vehicleCollisions` resolves cars against it — at 19.5 t against a
 *     1.5 t sedan the split goes ~93% to the car, so cars are SHOVED and the
 *     tram holds its line, exactly how the bus behaves when something noses it;
 *   - `blocksPeds` stays true, so the capsule push keeps people out of it;
 *   - lamps, LOD, ground shadow and damage all run the standard paths.
 *
 * The service writes `prevPosition`/`prevQuaternion` alongside the pose, so
 * `syncTransforms` interpolation is exact, and it writes the REAL velocity so
 * a car struck at a crossing takes a physical impulse rather than a teleport.
 *
 * Pause: `update(dt)` receives the SCALED dt, so a stopped clock stops the
 * timetable with no extra gate — the mover treats dt <= 0 as a no-op.
 *
 * The gate is `src/vehicles/tramprobe.mjs` (`npm run tram`): it runs THIS
 * service against the emitted graph and asserts the EMITTED positions against
 * rail geometry it extracts independently (rule 12), with a negative control.
 */

import * as THREE from 'three';
import { roundedBox, transform, tubeBetween, mergeAll } from './geom.js';
import { extractRailLine, RailMover, RAIL_TOP } from '../world/railmover.js';

/* ====================================================================== */
/* Geometry — the carriage                                                */
/* ====================================================================== */

/** Per-LOD segment budgets, same shape the heli uses. */
const SEG = [
  { box: 3, tube: 8 },
  { box: 2, tube: 6 },
  { box: 2, tube: 4 },
  { box: 1, tube: 4 },
];

/**
 * The carriage. Returns the same material-group shape `buildCarBody` does.
 * Silhouette priorities at 60 m: the LONG BOX, the rounded roof crown, the
 * continuous window band, the skirt. Everything else is detail.
 *
 * All heights are above the WHEEL-CONTACT PLANE (the rail head), because
 * `buildVehicleModel` hangs the body at `-spec.comY` and `TramService` puts
 * the CoM at railTop + comY — same convention as every other class.
 */
export function buildTramBody(spec, lod = 0) {
  const s = spec.style;
  const seg = SEG[Math.min(SEG.length - 1, lod)];
  const out = {
    paint: [], trim: [], chrome: [], cavity: [], glass: [],
    lamps: {}, plate: [], disc: [], doors: [], rotors: [], anchors: {},
  };
  const lamp = (k, g) => (out.lamps[k] = out.lamps[k] ?? []).push(g);

  const hw = s.hwMax;              // 1.30
  const skirtY = s.skirtY;         // 0.30 — bottom of bodywork
  const beltY = s.beltY;           // 1.45 — window sill
  const winTopY = s.winTopY;       // 2.30 — window head
  const cantY = s.cantY;           // 2.62 — top of the letterboard
  const halfL = spec.dims.L / 2;   // 7.0
  const mainHL = halfL - 1.15;     // straight body half-length (5.85)

  /* ---- body shell: below the band, above the band, tapered ends ------- */
  // Lower body: sill to belt.
  const lower = roundedBox(hw * 2, beltY - skirtY, mainHL * 2, 0.08, seg.box);
  transform(lower, { pos: [0, (skirtY + beltY) / 2, 0] });
  out.paint.push(lower);
  // Letterboard: window head to cant rail.
  const cant = roundedBox(hw * 2, cantY - winTopY, mainHL * 2, 0.06, seg.box);
  transform(cant, { pos: [0, (winTopY + cantY) / 2, 0] });
  out.paint.push(cant);
  // Tapered ends: full height, streamlined in plan, closing the window band.
  // Face lands exactly at +/- L/2; everything ON the face (screen, lamps,
  // sign) is placed PROUD of it below — a lens sealed inside its own housing
  // photographs as a blank panel (see shapeprobe's tail-lamp section).
  for (const end of [-1, 1]) {
    const nose = roundedBox(hw * 2, cantY - skirtY, 2.3, 0.42, seg.box);
    transform(nose, {
      pos: [0, (skirtY + cantY) / 2, end * (halfL - 1.15)],
      scale: [0.86, 1, 1],
    });
    out.paint.push(nose);
  }

  /* ---- roof crown ------------------------------------------------------ */
  // The rounded roof that says "trolley" from any distance. Dark, like the
  // canvas roofs the real cars carried.
  const roof = roundedBox(hw * 2 * 0.90, (s.roofY - cantY) * 2, (halfL - 0.65) * 2, 0.34, seg.box);
  transform(roof, { pos: [0, cantY, 0] }); // half sunk into the letterboard
  out.trim.push(roof);

  /* ---- the window band ------------------------------------------------- */
  if (lod < 3) {
    const bandL = mainHL * 2 - 0.3;
    for (const side of [-1, 1]) {
      const pane = roundedBox(0.05, winTopY - beltY, bandL, 0.015, 1);
      transform(pane, { pos: [side * (hw - 0.045), (beltY + winTopY) / 2, 0] });
      out.glass.push(pane);
    }
    // End screens: thick enough to cut through the nose's rounded face and
    // stand a few cm proud across their whole width, raked back a touch.
    for (const end of [-1, 1]) {
      const screen = roundedBox(1.35, 0.80, 0.22, 0.03, 1);
      transform(screen, {
        pos: [0, (beltY + winTopY) / 2 + 0.06, end * (halfL - 0.10)],
        rot: [end * -0.10, 0, 0],
      });
      out.glass.push(screen);
    }
    /**
     * THE LIT CABIN. An emissive strip INSET behind the glass, in the `drl`
     * lamp slot: `_updateLamps` runs drl at 0.9 by day and ~3.1 at night, which
     * is a fluorescent saloon reading through the glazing after dark — the
     * "windows lit at night" the request names — with zero new material kinds
     * and zero per-frame work in this file. `build.js` keeps the tram's drl
     * cluster OUT of the red brake merge at far LODs for exactly this strip.
     */
    // Segmented per window bay, not one slab: a continuous 11 m emissive strip
    // reads as a white-hot band in daylight; nine lit windows read as a tram.
    for (const side of [-1, 1]) {
      for (let i = 0; i < 9; i++) {
        const z = -5.0 + i * 1.25;
        const glow = new THREE.BoxGeometry(0.02, winTopY - beltY - 0.24, 0.92);
        transform(glow, { pos: [side * (hw - 0.20), (beltY + winTopY) / 2 - 0.03, z] });
        lamp('drl', glow);
      }
    }
  }

  /* ---- window pillars (over the glass, so the band reads as windows) --- */
  if (lod < 2) {
    const nPil = 7;
    for (let i = 0; i < nPil; i++) {
      const z = -4.8 + (i * 9.6) / (nPil - 1);
      for (const side of [-1, 1]) {
        const pil = roundedBox(0.055, winTopY - beltY + 0.06, 0.16, 0.01, 1);
        transform(pil, { pos: [side * (hw - 0.02), (beltY + winTopY) / 2, z] });
        out.paint.push(pil);
      }
    }
  }

  /* ---- doors: double-leaf folding, both flanks, both ends -------------- */
  // A double-ended interurban loads from either side depending on the terminus,
  // and the symmetry is what lets the service run the return leg tail-first
  // without the body ever turning around.
  if (lod < 2) {
    for (const side of [-1, 1]) {
      for (const zc of [4.35, -4.35]) {
        // dark reveal
        const rev = new THREE.BoxGeometry(0.03, cantY - 0.36 - skirtY, 1.34);
        transform(rev, { pos: [side * (hw + 0.004), (skirtY + cantY - 0.36) / 2, zc] });
        out.cavity.push(rev);
        // two leaves, slightly proud, each with a small light in the top half
        for (const lz of [-0.33, 0.33]) {
          const leaf = roundedBox(0.035, cantY - 0.42 - skirtY, 0.60, 0.012, 1);
          transform(leaf, { pos: [side * (hw + 0.018), (skirtY + cantY - 0.42) / 2, zc + lz] });
          out.paint.push(leaf);
          const dg = new THREE.BoxGeometry(0.02, 0.62, 0.42);
          transform(dg, { pos: [side * (hw + 0.030), winTopY - 0.44, zc + lz] });
          out.glass.push(dg);
        }
      }
    }
  }

  /* ---- skirt + underframe ---------------------------------------------- */
  const skirt = roundedBox(hw * 2 - 0.16, 0.34, (halfL - 0.55) * 2, 0.05, 1);
  transform(skirt, { pos: [0, skirtY + 0.03, 0] });
  out.cavity.push(skirt);

  /* ---- bogies + wheels -------------------------------------------------- */
  if (lod < 2) {
    for (const bz of [s.bogieZ, -s.bogieZ]) {
      const frame = roundedBox(1.9, 0.42, 2.5, 0.08, 1);
      transform(frame, { pos: [0, 0.38, bz] });
      out.cavity.push(frame);
      for (const wz of [-0.85, 0.85]) {
        for (const side of [-1, 1]) {
          const wheel = new THREE.CylinderGeometry(s.wheelR, s.wheelR, 0.09, 12);
          transform(wheel, { pos: [side * 0.7175, s.wheelR, bz + wz], rot: [0, 0, Math.PI / 2] });
          out.trim.push(wheel);
        }
      }
    }
  }

  /* ---- roof gear: pantograph + vents ------------------------------------ */
  if (lod < 2) {
    const roofTop = s.roofY - 0.02; // sink the gear a shade into the crown
    // insulator feet
    for (const z of [-0.42, 0.42]) {
      const foot = new THREE.CylinderGeometry(0.05, 0.07, 0.12, 8);
      transform(foot, { pos: [0, roofTop + 0.06, z] });
      out.trim.push(foot);
    }
    // single-arm pantograph: lower arm aft, upper arm forward, shoe across.
    const kneeY = roofTop + 0.62;
    const shoeY = roofTop + 0.98;
    out.chrome.push(tubeBetween(
      new THREE.Vector3(0, roofTop + 0.10, 0.42),
      new THREE.Vector3(0, kneeY, -0.30), 0.030, seg.tube));
    out.chrome.push(tubeBetween(
      new THREE.Vector3(0, kneeY, -0.30),
      new THREE.Vector3(0, shoeY, 0.35), 0.024, seg.tube));
    const shoe = roundedBox(1.35, 0.045, 0.10, 0.02, 1);
    transform(shoe, { pos: [0, shoeY + 0.02, 0.35] });
    out.trim.push(shoe);
    // roof vents, half-sunk into the crown so they ride its curve
    for (const z of [-3.4, -1.7, 1.7, 3.4]) {
      const vent = roundedBox(0.62, 0.09, 0.5, 0.03, 1);
      transform(vent, { pos: [0, s.roofY - 0.01, z] });
      out.trim.push(vent);
    }
  }

  /* ---- lamps: both ends, because both ends lead ------------------------- */
  // Every fixture is thick and centred ON the face plane, so it stands proud
  // of the rounded nose everywhere instead of sealing itself inside it.
  for (const end of [-1, 1]) {
    const zFace = end * halfL;
    // the single centred headlamp every PCC carries
    lamp('head', transform(
      new THREE.SphereGeometry(0.115, 10, 7, 0, Math.PI * 2, 0, Math.PI * 0.55),
      { pos: [0, 1.06, zFace - end * 0.02], rot: [end * Math.PI * 0.5, 0, 0] }));
    // marker/tail pair low on the corners
    for (const side of [-1, 1]) {
      lamp('tail', transform(new THREE.BoxGeometry(0.16, 0.10, 0.10),
        { pos: [side * 0.68, 0.82, zFace] }));
    }
    if (lod < 3) {
      // lit destination box above the screen
      lamp('drl', transform(new THREE.BoxGeometry(0.72, 0.17, 0.14),
        { pos: [0, winTopY + 0.14, zFace - end * 0.10] }));
    }
  }

  out.anchors = { floorY: s.floorY };
  out.surface = null;
  return out;
}

/* ====================================================================== */
/* The service                                                            */
/* ====================================================================== */

/** Distance from the body centre to each bogie pivot, m. The body is posed on
 *  the CHORD between the two bogie contact points, which is how a real
 *  carriage negotiates a curve — the overhang swings, the bogies stay on the
 *  rail. */
const BOGIE_HALF = 3.8;

/** The corridor the service runs — the line `railsweep` certifies. */
const LINE_ID = 'rail_strip';

/**
 * Owns the one tram: finds the emitted rail line, spawns the carriage on it,
 * and poses it kinematically every frame. Created and driven by
 * `VehicleSystem.update` (see the wiring note there); everything it touches
 * outside `vehicles` goes through `ctx.peek` (hard rule 2).
 */
export class TramService {
  /**
   * @param {object} sys   the vehicle system (needs `.spawn`).
   * @param {object} [opts] `paralysed: true` freezes the timetable — the
   *        tram spawns on the rail and never advances. PROBE-ONLY, the
   *        negative control `tramprobe.mjs` runs against the live code with no
   *        edit (same pattern as `debugIgnorePause` in freeroam/weapons).
   */
  constructor(sys, opts = {}) {
    this.sys = sys;
    this.opts = opts;
    this.vehicle = null;
    this.mover = null;
    /** true once we know the map has no usable line — stop asking. */
    this.dead = false;
    // Preallocated scratch (hard rule 5).
    this._f = { x: 0, y: 0, z: 0 };
    this._r = { x: 0, y: 0, z: 0 };
    this._e = new THREE.Euler();
    this._p = new THREE.Vector3();
  }

  /** Once per frame, with the SCALED dt. Safe to call before world is ready. */
  update(dt, ctx) {
    if (this.dead) return;
    if (!this.mover && !this._init(ctx)) return;
    const v = this.vehicle;
    if (!v) return;

    // A wrecked tram stops where it was wrecked; the line is blocked. That is
    // a consequence, not a bug — and it must not keep gliding while on fire.
    if (!v.destroyed && !this.opts.paralysed) this.mover.step(dt);

    const m = this.mover;
    m.sampleAt(m.s + BOGIE_HALF, this._f);
    m.sampleAt(m.s - BOGIE_HALF, this._r);
    const dx = this._f.x - this._r.x;
    const dy = this._f.y - this._r.y;
    const dz = this._f.z - this._r.z;
    const len = Math.hypot(dx, dy, dz) || 1;
    const yaw = Math.atan2(dx, dz);
    const pitch = -Math.asin(dy / len);

    this._p.set(
      (this._f.x + this._r.x) * 0.5,
      (this._f.y + this._r.y) * 0.5 + v.spec.comY,
      (this._f.z + this._r.z) * 0.5
    );
    v.position.copy(this._p);
    v.prevPosition.copy(this._p);
    v.quaternion.setFromEuler(this._e.set(pitch, yaw, 0, 'YXZ'));
    v.prevQuaternion.copy(v.quaternion);
    // Real velocity, so a car struck at a crossing takes a physical impulse
    // (19.5 t at 9 m/s) instead of meeting a stationary wall that teleports.
    const vs = (m.v * m.dir) / len;
    v.velocity.set(dx * vs, dy * vs, dz * vs);
    v.angularVelocity.set(0, 0, 0);
    // Never let the sleep latch or the pair resolver bank a stale pose.
    v.sleeping = false;
    v._sleepTimer = 0;
    // Brake lamps while it slows for (or stands at) a terminus.
    v.control.brake = m.braking ? 1 : 0;
    v.speed = Math.abs(m.v);
    v.forwardSpeed = m.v * m.dir;
  }

  _init(ctx) {
    // `?.` throughout: headless benches drive `VehicleSystem.update` with
    // stub contexts that may have no `peek` and no world. No world, no tram —
    // never a throw.
    const world = ctx?.peek?.('world');
    const roads = world?.roads;
    if (!roads?.edges?.length) return false; // world still building — retry
    const line = extractRailLine(roads, LINE_ID);
    if (!line) {
      // No usable line on this map. Say so once; never retry per-frame.
      console.warn('[vehicles] tram: no continuous ' + LINE_ID + ' rail line emitted');
      this.dead = true;
      return false;
    }
    this.mover = new RailMover(line, this.opts.mover);
    const m = this.mover;
    m.sampleAt(m.s + BOGIE_HALF, this._f);
    m.sampleAt(m.s - BOGIE_HALF, this._r);
    const yaw = Math.atan2(this._f.x - this._r.x, this._f.z - this._r.z);
    this._p.set(
      (this._f.x + this._r.x) * 0.5,
      (this._f.y + this._r.y) * 0.5,
      (this._f.z + this._r.z) * 0.5
    );
    const spec = this.sys.specOf ? this.sys.specOf('tram') : null;
    this._p.y += spec?.comY ?? 1.15;
    // Ore red, tone 1, gloss, worked-in wear: an exact member of the
    // pre-warmed VARIANTS set, so this spawn compiles nothing mid-play.
    const v = this.sys.spawn('tram', this._p, yaw, {
      paint: 0x6d1f1c, finish: 'gloss', flake: 0.5, wear: 0.5,
      plate: 'PRT 1713',
    });
    if (!v) { this.dead = true; return false; }
    v.kinematic = true;   // VehicleSystem.fixedUpdate: never integrated
    v.burnsFuel = false;
    v.engineOn = true;
    this.vehicle = v;
    return true;
  }

  dispose() {
    // The vehicle itself is despawned by VehicleSystem.dispose's fleet sweep.
    this.vehicle = null;
    this.mover = null;
  }
}

export { RAIL_TOP, BOGIE_HALF };
