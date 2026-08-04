import * as THREE from 'three';

/**
 * FUNICULAR — the two moving cars of the Duquesne Incline.
 *
 * The incline's trestle, rails and stations are emitted by `buildings`
 * (`src/buildings/landmarks.js`) from the track descriptor `world` solves and
 * publishes as `world.landmarks[].funicular.track` (`src/world/incline.js`).
 * This subsystem puts the CARS on those rails and runs them, so the landmark
 * is a working funicular rather than a photograph of one:
 *
 *   - two cars in the classic livery — deep red body, yellow waist and window
 *     posts, cream letterboard — with a full window band and the stepped
 *     profile that keeps the cabins level on the slope;
 *   - counterbalanced, like the real thing: one cable, so the descending car
 *     is the ascending car's counterweight and `alongA + alongB === run` at
 *     every instant. That invariant is not decoration, it is the gate
 *     (`src/vehicles/funicularprobe.mjs` measures it);
 *   - a dwell at each station, then a cosine-eased run, so the cars stop,
 *     board and glide rather than bounce between endpoints.
 *
 * WHY THE CARS CANNOT DRIFT OFF THE TRACK. Every frame each car is POSED BY
 * SAMPLING the published descriptor (`at`, `trackY`, `pitchAt`) — the same
 * object, not a copy, that the trestle's rails were emitted from. There is no
 * second solve and no cached line to go stale; the probe's negative control
 * (`--drift`) shows what the gate reports when a hardcoded line is simulated.
 *
 * THE STEPPED BODY, AND WHAT THE PITCH DOES — MEASURED FIRST. The emitted
 * track is NOT a constant ramp: measured off the published descriptor it runs
 * FLAT for its first ~50 m (the trestle crosses a dip before the bluff), then
 * steepens to a 1.27 grade mid-run (mean 0.55). So the two obvious poses both
 * fail: a body pitched by (local − mean) grade tips 29° nose-down onto the
 * flat approach, and a staircase authored at the mean grade with local pitch
 * sinks its downhill skirt 0.8 m through the rails on the steep middle. What
 * works on this profile is what the old static bake shipped: the car CHORDS
 * the track (pitch = local grade over the wheelbase) and carries a stylized
 * step stagger — STEP_RISE per bay, capped well inside the underframe — that
 * gives the classic level-cabin silhouette without ever leaving the rails.
 *
 * Registered in `src/main.js`. deps: ['world'] — the descriptor is published
 * during `WorldSystem.init`, so the cars exist before prewarm compiles the
 * scene. If no track was published (a stripped test world), the subsystem is
 * inert. No lights (shader-permutation budget), no per-frame allocation, no
 * randomness.
 */

/** The authored livery. `funicularprobe.mjs` samples the EMITTED mesh
 *  materials and asserts they are exactly these — and that they are actually
 *  red/yellow by component, so this table cannot silently turn blue. */
export const FUNICULAR_LIVERY = {
  body: 0xa11a1f,   // incline-car red
  accent: 0xf0b429, // yellow waist band, window posts, end trim
  cream: 0xefe3c0,  // letterboard / cornice
  roof: 0x33261f,   // dark roof
  frame: 0x1d1a18,  // underframe, skirt, wheels
  glass: 0x16212a,  // window band
};

/** Seconds held at each station. */
const DWELL = 7;
/** Seconds for the run between stations (cosine-eased). */
const TRAVEL = 36;
/** Steps in the car body; depth of one step (m). */
const STEPS = 4;
const STEP_D = 2.4;
/** Car width (m). */
const CAR_W = 2.7;
/**
 * Stagger between cabin steps (m). Stylized, NOT the mean grade: 1.5×STEP_RISE
 * must stay under `carLift` or the downhill skirt dives through the rails on
 * the parts of the run steeper than the stagger (see the class comment).
 */
const STEP_RISE = 0.5;
/**
 * The stations are solid headhouses straddling the track (16×12 m lower,
 * 18×14 m upper, centred on a=0 and a=run) — a car dwelling at a=0 would park
 * INSIDE the brickwork. Terminus stops sit just clear of each facade, at the
 * platform. The counterbalance invariant becomes alongA + alongB =
 * A_MIN + (run − A_MAX_INSET) — still a constant, still gated.
 */
const A_MIN = 8;
const A_MAX_INSET = 9;

/* ------------------------------------------------------------ geometry --- */

/** Append `geo` (any indexed BufferGeometry) into flat arrays, transformed by
 *  translate+scale only — all the car needs, so no matrix math. */
function pushGeo(dst, geo, cx, cy, cz, sx = 1, sy = 1, sz = 1) {
  const pa = geo.getAttribute('position');
  const na = geo.getAttribute('normal');
  const idx = geo.getIndex();
  const base = dst.verts;
  for (let i = 0; i < pa.count; i++) {
    dst.pos.push(pa.getX(i) * sx + cx, pa.getY(i) * sy + cy, pa.getZ(i) * sz + cz);
    // Normals: box/cylinder faces stay axis-true under positive scale; renorm
    // is done once in build() via normalizeNormals-equivalent below.
    dst.nrm.push(na.getX(i) / sx, na.getY(i) / sy, na.getZ(i) / sz);
    dst.verts++;
  }
  for (let i = 0; i < idx.count; i++) dst.idx.push(base + idx.getX(i));
}

function newAccum() {
  return { pos: [], nrm: [], idx: [], verts: 0 };
}

function buildAccum(acc) {
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(acc.pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(acc.nrm, 3));
  g.setIndex(acc.idx);
  g.normalizeNormals();
  g.computeBoundingBox();
  g.computeBoundingSphere();
  return g;
}

/* ----------------------------------------------------------- the system --- */

export class FunicularSystem {
  static id = 'funicular';
  static deps = ['world'];

  async init(ctx) {
    this.ctx = ctx;
    this.cars = [];
    this._mats = null;
    this._geos = [];
    this.root = null;

    const world = ctx.peek('world');
    const lm = world?.landmarks?.find?.((l) => l.kind === 'incline');
    this.track = lm?.funicular?.track ?? null;
    if (!this.track || typeof this.track.at !== 'function') return; // inert

    const t = this.track;
    this.aMin = A_MIN;
    this.aMax = t.run - A_MAX_INSET;

    const L = FUNICULAR_LIVERY;
    const mk = (color, extra) => new THREE.MeshStandardMaterial({ color, ...extra });
    this._mats = {
      body: mk(L.body, { roughness: 0.42, metalness: 0.12 }),
      accent: mk(L.accent, { roughness: 0.5, metalness: 0.18 }),
      cream: mk(L.cream, { roughness: 0.6, metalness: 0.05 }),
      roof: mk(L.roof, { roughness: 0.85, metalness: 0.05 }),
      frame: mk(L.frame, { roughness: 0.8, metalness: 0.35 }),
      glass: mk(L.glass, {
        roughness: 0.12,
        metalness: 0.55,
        emissive: 0x241505, // faint warm cabin glow so the band reads at night
        emissiveIntensity: 0.55,
      }),
    };

    this.root = new THREE.Group();
    this.root.name = 'funicular';
    this.root.matrixAutoUpdate = false;
    this.root.updateMatrix();
    for (let i = 0; i < 2; i++) {
      const car = this._buildCar();
      car.name = `funicular_car_${i}`;
      this.root.add(car);
      this.cars.push(car);
    }
    ctx.scene.add(this.root);

    // Motion state. Start mid-run so any first look at the hill catches the
    // cars in motion (the old static bake froze them at 0.34/0.66 for the
    // same reason). Deterministic: no randomness, phase advances on scaled dt.
    this._phase = DWELL + TRAVEL * 0.45;
    this._pt = { x: 0, z: 0 };
    this._pose(this._phase);
  }

  /** One car: a staircase of red/yellow/glass boxes, +Z pointing uphill. */
  _buildCar() {
    const R = STEP_RISE;
    const acc = {
      body: newAccum(), accent: newAccum(), cream: newAccum(),
      roof: newAccum(), frame: newAccum(), glass: newAccum(),
    };
    const box = new THREE.BoxGeometry(1, 1, 1);
    const wheel = new THREE.CylinderGeometry(0.34, 0.34, 0.24, 10);
    wheel.rotateZ(Math.PI / 2);

    const D = STEP_D;
    for (let k = 0; k < STEPS; k++) {
      const zc = (k - (STEPS - 1) / 2) * D;
      const yb = (k - (STEPS - 1) / 2) * R;
      // underframe / skirt
      pushGeo(acc.frame, box, 0, yb + 0.25, zc, CAR_W - 0.2, 0.5, D + 0.02);
      // body panel below the waist
      pushGeo(acc.body, box, 0, yb + 1.05, zc, CAR_W, 1.15, D + 0.04);
      // yellow waist band
      pushGeo(acc.accent, box, 0, yb + 1.69, zc, CAR_W + 0.05, 0.14, D + 0.05);
      // window band, inset between yellow posts
      pushGeo(acc.glass, box, 0, yb + 2.32, zc, CAR_W - 0.14, 1.12, D - 0.46);
      pushGeo(acc.accent, box, 0, yb + 2.32, zc - D / 2 + 0.14, CAR_W - 0.02, 1.12, 0.24);
      if (k === STEPS - 1) pushGeo(acc.accent, box, 0, yb + 2.32, zc + D / 2 - 0.14, CAR_W - 0.02, 1.12, 0.24);
      // cream letterboard and dark roof, stepped with the cabin
      pushGeo(acc.cream, box, 0, yb + 3.0, zc, CAR_W, 0.26, D + 0.04);
      pushGeo(acc.roof, box, 0, yb + 3.26, zc, CAR_W + 0.16, 0.2, D + 0.18);
      pushGeo(acc.body, box, 0, yb + 3.43, zc, 1.8, 0.14, D - 0.5);
    }
    // end walls — downhill face carries the classic red panel with a window
    const zEnd = (STEPS / 2) * D;
    const ybLo = -((STEPS - 1) / 2) * R;
    const ybHi = ((STEPS - 1) / 2) * R;
    for (const [ze, yb] of [[-zEnd, ybLo], [zEnd, ybHi]]) {
      const s = Math.sign(ze);
      pushGeo(acc.body, box, 0, yb + 1.7, ze + s * 0.06, CAR_W, 2.5, 0.16);
      pushGeo(acc.glass, box, 0, yb + 2.5, ze + s * 0.12, 1.6, 0.8, 0.1);
      pushGeo(acc.accent, box, 0, yb + 3.05, ze + s * 0.1, CAR_W - 0.2, 0.16, 0.12);
    }
    // wheels: the car CHORDS the track (rotation.x = local grade), so in the
    // car's frame the rail plane is level at −carLift; wheels ride just above.
    for (const zw of [-3.0, 3.0]) {
      for (const xw of [-0.95, 0.95]) pushGeo(acc.frame, wheel, xw, -0.75, zw);
    }
    box.dispose();
    wheel.dispose();

    const car = new THREE.Group();
    car.rotation.order = 'YXZ';
    for (const key of Object.keys(acc)) {
      const g = buildAccum(acc[key]);
      this._geos.push(g);
      const mesh = new THREE.Mesh(g, this._mats[key]);
      mesh.name = `funicular_${key}`;
      car.add(mesh);
    }
    return car;
  }

  /**
   * Along-track position of car 0 at cycle phase `p`: dwell at the lower
   * platform, cosine-eased climb, dwell at the top, eased descent. Car 1 is
   * posed at `aMin + aMax − along` — the counterweight on the one cable.
   */
  _along(p) {
    const half = DWELL + TRAVEL;
    const u = p % (2 * half);
    const leg = u < half ? u : u - half;
    const m = Math.max(0, Math.min(1, (leg - DWELL) / TRAVEL));
    const s = 0.5 - 0.5 * Math.cos(Math.PI * m);
    return this.aMin + (u < half ? s : 1 - s) * (this.aMax - this.aMin);
  }

  _pose(phase) {
    const t = this.track;
    const a0 = this._along(phase);
    for (let i = 0; i < 2; i++) {
      const a = i === 0 ? a0 : this.aMin + this.aMax - a0;
      const side = i === 0 ? -1 : 1;
      const car = this.cars[i];
      t.at(side * t.gauge, a, this._pt);
      car.position.set(this._pt.x, t.trackY(a) + t.carLift, this._pt.z);
      car.rotation.y = t.yaw;
      // Chord the track: pitch is the local grade over the wheelbase.
      car.rotation.x = t.pitchAt(a, 3);
    }
  }

  update(dt) {
    if (!this.cars.length) return;
    this._phase += dt;
    this._pose(this._phase);
  }

  dispose() {
    if (this.root) this.root.removeFromParent();
    for (const g of this._geos) g.dispose();
    if (this._mats) for (const k of Object.keys(this._mats)) this._mats[k].dispose();
    this._geos.length = 0;
    this.cars.length = 0;
  }
}
