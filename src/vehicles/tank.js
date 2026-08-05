/**
 * THE BULWARK — a tracked main battle tank: hull geometry, the articulated
 * turret, and the shell it fires.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * WHY THE DRIVING IS THE CAR MODEL AND ONLY THE TURRET IS NEW
 * ────────────────────────────────────────────────────────────────────────────
 * A tank hull is a rigid body on sprung contacts, which is exactly what
 * `dynamics.js` already integrates. `kind: 'tank'` therefore takes the WHEEL
 * path of `Vehicle.fixedStep` — the four hardpoints stand in for the road-wheel
 * stations — and reads tracked through TUNING, not through a second simulator:
 * 45 t of mass, a top speed geared to ~14 m/s, track-pad grip far past any
 * tyre's, near-critical damping and monster anti-roll so the hull stays flat,
 * and a crumple coefficient so low that collisions cost it almost nothing
 * (`DamageModel.impact` prices a hit as `impulse / mass`, so the mass is
 * armour twice over). `milprobe.mjs` measures all of that on the emitted
 * motion; `drivetest.mjs` deliberately excludes `kind: 'tank'` from its car
 * sweep the same way it excludes the tram — a machine whose whole point is to
 * fail "accelerates like a car" assertions does not belong in them.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * THE TURRET IS KINEMATIC STATE, STEPPED EVEN WHILE THE HULL SLEEPS
 * ────────────────────────────────────────────────────────────────────────────
 * `turretYaw` / `gunPitch` live on the Vehicle and slew toward `aimTurret()`'s
 * point at the bounded rates in `spec.turret`. The step runs from
 * `VehicleSystem.fixedUpdate` OUTSIDE the physics-sleep gate, deliberately: an
 * AI emplacement is a PARKED tank — asleep by the solver's definition within
 * 1.2 s of standing still — and a turret that only slews while the hull is
 * integrating would freeze mid-traverse the moment the hull settled. Slewing
 * is not a force; it does not need the integrator awake.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * `fireShell` SPEAKS THE ROCKET'S EVENT VOCABULARY — NO PARALLEL DAMAGE PATH
 * ────────────────────────────────────────────────────────────────────────────
 * The Scrap Rocket detonates by emitting the canonical `explosion`
 * `{ position, radius, damage }` (`weapons/ballistics.js _detonate`), and
 * `physics`, `vehicles`, `peds`, `fx`, `police` and `ui` all already listen.
 * The shell does exactly the same: a ballistic point integrated at 120 Hz,
 * raycast against the static world each step, proximity-tested against the
 * live fleet, and ONE `explosion` event at the impact point. Damage to a
 * vehicle then flows through `_explosionDamage` -> `damage()` like every other
 * blast in the game — this file never touches a health number itself. The
 * muzzle emits the canonical `weapon:fire` `{ weapon, origin, dir, seed }`,
 * which is the event `fx` draws muzzle flashes from and `police`/`peds` price
 * and panic off — a tank shot is heard, seen and booked like any other shot.
 *
 * `v.afterburner` has a sibling note in `plane.js`; the visual hooks published
 * here are `v.turretYaw`, `v.gunPitch`, `v.gunCool` (seconds of reload left)
 * and the `model.turrets` pivots that `syncTransforms` drives.
 *
 * Gate: `src/vehicles/milprobe.mjs` (see its header for the numbers).
 */

import * as THREE from 'three';
import { roundedBox, transform, mergeAll } from './geom.js';

const GRAVITY = 9.81;

/* ====================================================================== */
/* Geometry                                                               */
/* ====================================================================== */

/** Per-LOD segment budgets. */
const SEG = [
  { ring: 12, wheel: 12 },
  { ring: 8, wheel: 8 },
  { ring: 6, wheel: 6 },
  { ring: 4, wheel: 5 },
];

/**
 * The hull. Same material-group contract as `buildPlaneBody`, plus a `turret`
 * entry `build.js` turns into two articulated pivots (traverse and elevation)
 * so the gun can track a target independently of the hull.
 *
 * Reads from sixty metres in this order: the TRACKS (a dark band low down the
 * whole length), the sloped GLACIS, the flat skirted hull, and the TURRET with
 * its long gun. Everything is sized off `spec.style` so the silhouette checks
 * in `milprobe.mjs` can run negative controls by mutating the style block.
 */
export function buildTankBody(spec, lod = 0) {
  const s = spec.style;
  const seg = SEG[Math.min(SEG.length - 1, lod)];
  const out = {
    paint: [], trim: [], chrome: [], cavity: [], glass: [],
    lamps: {}, plate: [], disc: [], doors: [], rotors: [], anchors: {},
  };
  const lamp = (k, g) => (out.lamps[k] = out.lamps[k] ?? []).push(g);

  const hull = s.hull;      // { y0, y1, z0, z1, w }  upper hull box
  const skirt = s.skirt;    // { y0, y1, x0, x1, z0, z1 }
  const track = s.track;    // { y0, y1, x0, x1, wheelR, wheels }

  /* ---- upper hull ----------------------------------------------------- */
  const hullH = hull.y1 - hull.y0;
  const hullL = hull.z1 - hull.z0;
  const deck = roundedBox(hull.w, hullH, hullL, 0.06, 2);
  transform(deck, { pos: [0, (hull.y0 + hull.y1) * 0.5, (hull.z0 + hull.z1) * 0.5] });
  out.paint.push(deck);

  /* ---- sloped glacis --------------------------------------------------- */
  // The nose plate: a slab leaned back from the low bow lip up to the deck
  // line. The slope IS the feature — milprobe measures the emitted angle.
  {
    const g = s.glacis;   // { z1 (bow tip), drop }
    const run = g.z1 - hull.z1;                   // horizontal reach
    const rise = g.drop;                          // vertical drop over it
    const len = Math.hypot(run, rise);
    const plate = roundedBox(hull.w * 0.98, 0.16, len + 0.2, 0.04, 2);
    const ang = Math.atan2(rise, run);            // from horizontal
    transform(plate, {
      pos: [0, hull.y1 - rise * 0.5 - 0.06, hull.z1 + run * 0.5],
      rot: [ang, 0, 0],
    });
    out.paint.push(plate);
    // The bow lip closes the wedge underneath.
    const lip = roundedBox(hull.w * 0.96, hull.y1 - rise - hull.y0 + 0.2, 0.5, 0.05, 1);
    transform(lip, { pos: [0, (hull.y0 + hull.y1 - rise) * 0.5, g.z1 - 0.28] });
    out.paint.push(lip);
    // Rear plate, leaned the other way.
    const tail = roundedBox(hull.w * 0.96, 0.14, hullH + 0.3, 0.04, 1);
    transform(tail, { pos: [0, (hull.y0 + hull.y1) * 0.5, hull.z0 - 0.1], rot: [Math.PI * 0.5 - 0.35, 0, 0] });
    out.paint.push(tail);
  }

  /* ---- track skirts ---------------------------------------------------- */
  for (const side of [-1, 1]) {
    const sk = roundedBox(skirt.x1 - skirt.x0, skirt.y1 - skirt.y0, skirt.z1 - skirt.z0, 0.04, 1);
    transform(sk, {
      pos: [side * (skirt.x0 + skirt.x1) * 0.5, (skirt.y0 + skirt.y1) * 0.5, (skirt.z0 + skirt.z1) * 0.5],
    });
    out.paint.push(sk);
  }

  /* ---- tracks and road wheels ------------------------------------------ */
  // The dark running gear under the skirts: a full-length track band per side,
  // and a row of road wheels visible under the skirt's lower edge.
  for (const side of [-1, 1]) {
    const tx = side * (track.x0 + track.x1) * 0.5;
    const tw = track.x1 - track.x0;
    const band = roundedBox(tw, track.y1 - track.y0, skirt.z1 - skirt.z0 - 0.2, 0.08, 1);
    transform(band, { pos: [tx, (track.y0 + track.y1) * 0.5, (skirt.z0 + skirt.z1) * 0.5] });
    out.trim.push(band);
    if (lod < 3) {
      const n = Math.max(3, track.wheels | 0);
      const z0 = skirt.z0 + 0.55;
      const z1 = skirt.z1 - 0.55;
      for (let i = 0; i < n; i++) {
        const z = z0 + ((z1 - z0) * i) / (n - 1);
        const wheel = new THREE.CylinderGeometry(track.wheelR, track.wheelR, tw + 0.06, seg.wheel);
        transform(wheel, { pos: [tx, track.y0 + track.wheelR, z], rot: [0, 0, Math.PI * 0.5] });
        out.trim.push(wheel);
      }
    }
  }

  /* ---- deck furniture -------------------------------------------------- */
  if (lod < 2) {
    // Engine deck grilles aft, a driver's hatch forward.
    const grille = roundedBox(hull.w * 0.6, 0.05, 1.1, 0.02, 1);
    transform(grille, { pos: [0, hull.y1 + 0.02, hull.z0 + 0.85] });
    out.cavity.push(grille);
    const hatch = new THREE.CylinderGeometry(0.3, 0.32, 0.08, seg.ring);
    transform(hatch, { pos: [0.62, hull.y1 + 0.04, hull.z1 - 0.55] });
    out.paint.push(hatch);
  }

  /* ---- lamps ------------------------------------------------------------ */
  const hl = s.headlight;
  for (const side of [-1, 1]) {
    lamp('head', transform(new THREE.SphereGeometry(hl.w, 8, 6, 0, Math.PI * 2, 0, Math.PI * 0.5),
      { pos: [side * hull.w * 0.36, hl.y, s.glacis.z1 - 0.12], rot: [Math.PI * 0.5, 0, 0] }));
    lamp('brake', transform(new THREE.SphereGeometry(s.taillight.w, 8, 6),
      { pos: [side * hull.w * 0.4, s.taillight.y, hull.z0 - 0.16] }));
  }

  /* ---- the turret — its own articulated node ---------------------------- */
  // Geometry is built about the TRAVERSE PIVOT (s.turret.x/y/z), so `build.js`
  // can hang it off a rotating group and share the geometry across instances.
  {
    const t = s.turret;   // { y, z, w, h, l, bustle }
    const parts = [];
    // The shell: a low frustum — sloped sides all round, longer than wide.
    const shell = roundedBox(t.w, t.h, t.l, 0.10, 2);
    {
      // Taper the top inward so every face slopes like armour, not a shed.
      const p = shell.attributes.position;
      for (let i = 0; i < p.count; i++) {
        const f = 1 - Math.max(0, p.getY(i) / t.h + 0.5 - 0.5) * 0.42;
        p.setX(i, p.getX(i) * f);
        p.setZ(i, p.getZ(i) * (1 - Math.max(0, p.getY(i) / t.h) * 0.16));
      }
      shell.computeVertexNormals();
    }
    transform(shell, { pos: [0, t.h * 0.5, -t.l * 0.12] });
    parts.push(shell);
    // Bustle rack aft.
    const bustle = roundedBox(t.w * 0.8, t.h * 0.5, t.bustle, 0.05, 1);
    transform(bustle, { pos: [0, t.h * 0.35, -t.l * 0.62 - t.bustle * 0.3] });
    parts.push(bustle);
    // Commander's cupola.
    if (lod < 3) {
      const cup = new THREE.CylinderGeometry(0.26, 0.3, 0.16, seg.ring);
      transform(cup, { pos: [-t.w * 0.22, t.h + 0.07, -t.l * 0.18] });
      parts.push(cup);
    }
    // Mantlet at the trunnion.
    const g = s.gun;      // { y, z, len, r } — pivot relative to the turret pivot
    const mant = roundedBox(0.6, 0.5, 0.5, 0.08, 2);
    transform(mant, { pos: [0, g.y, g.z + 0.1] });
    parts.push(mant);

    // The gun: a long tube from the trunnion, built about ITS OWN pivot so it
    // can elevate. Thermal sleeve step and muzzle collar so it reads as a gun.
    const gunParts = [];
    const barrel = new THREE.CylinderGeometry(g.r, g.r * 1.15, g.len, seg.ring);
    transform(barrel, { pos: [0, 0, g.len * 0.5], rot: [Math.PI * 0.5, 0, 0] });
    gunParts.push(barrel);
    const sleeve = new THREE.CylinderGeometry(g.r * 1.5, g.r * 1.6, g.len * 0.3, seg.ring);
    transform(sleeve, { pos: [0, 0, g.len * 0.3], rot: [Math.PI * 0.5, 0, 0] });
    gunParts.push(sleeve);
    const muzzle = new THREE.CylinderGeometry(g.r * 1.5, g.r * 1.5, 0.34, seg.ring);
    transform(muzzle, { pos: [0, 0, g.len - 0.2], rot: [Math.PI * 0.5, 0, 0] });
    gunParts.push(muzzle);

    out.turret = {
      pos: [t.x ?? 0, t.y, t.z],
      geo: mergeAll(parts),
      gun: { pos: [0, g.y, g.z], geo: mergeAll(gunParts) },
    };
  }

  out.anchors = {};
  out.surface = null;
  return out;
}

/* ====================================================================== */
/* Turret state and slew                                                  */
/* ====================================================================== */

const _q = new THREE.Quaternion();
const _qy = new THREE.Quaternion();
const _qp = new THREE.Quaternion();
const _Y = new THREE.Vector3(0, 1, 0);
const _X = new THREE.Vector3(1, 0, 0);
const _v = new THREE.Vector3();
const _d = new THREE.Vector3();
const _mp = new THREE.Vector3();
const _md = new THREE.Vector3();

function clamp(v, a, b) {
  return v < a ? a : v > b ? b : v;
}
function wrapPi(a) {
  while (a > Math.PI) a -= Math.PI * 2;
  while (a < -Math.PI) a += Math.PI * 2;
  return a;
}

/** Preallocate the turret's per-vehicle state. Called from the constructor. */
export function initTurret(v) {
  v.turretYaw = 0;
  v.gunPitch = 0;
  v.gunCool = 0;
  v.turretAim = new THREE.Vector3();
  v.turretAimActive = false;
}

/**
 * Command the turret at a WORLD point. The barrel does not snap — it slews at
 * `spec.turret.yawRate` / `pitchRate` in `stepTurret`, so an emplacement
 * tracks a runner visibly and a fast crossing target can outpace it.
 */
export function aimTurret(v, worldPoint) {
  if (!v?.spec?.turret || !worldPoint) return false;
  v.turretAim.set(
    worldPoint.x ?? worldPoint[0] ?? 0,
    worldPoint.y ?? worldPoint[1] ?? 0,
    worldPoint.z ?? worldPoint[2] ?? 0
  );
  v.turretAimActive = true;
  return true;
}

/**
 * One slew step. Runs from `VehicleSystem.fixedUpdate` for every vehicle with
 * a `spec.turret`, OUTSIDE the sleep gate (see the header). Also ticks the
 * reload clock, so `fireShell` needs no timer of its own.
 */
export function stepTurret(v, dt) {
  const T = v.spec.turret;
  if (!T) return;
  if (v.gunCool > 0) v.gunCool = Math.max(0, v.gunCool - dt);
  if (!v.turretAimActive || v.destroyed) return;

  // The aim point in body frame, about the traverse pivot.
  const st = v.spec.style;
  _v.set(st.turret.x ?? 0, st.turret.y + (st.gun?.y ?? 0.3) - v.spec.comY, st.turret.z)
    .applyQuaternion(v.quaternion).add(v.position);
  _d.copy(v.turretAim).sub(_v).applyQuaternion(_q.copy(v.quaternion).invert());

  const wantYaw = Math.atan2(_d.x, _d.z);
  const horiz = Math.hypot(_d.x, _d.z);
  /**
   * SUPERELEVATION — the fire-control half of "the explosion lands at the aim
   * point". A 105 m/s shell aimed straight down the line of sight falls
   * 4.9 t^2 below it and landed a MEASURED 21 m short at 65 m. Real fire
   * control solves the lob; the flat-fire solution is
   * `0.5 * asin(g d / v^2)` above the direct line, which brings the same
   * shot inside a couple of metres (milprobe gates it on the emitted event).
   */
  const S = T.shell;
  const dist = Math.hypot(horiz, _d.y);
  const sup = S ? 0.5 * Math.asin(clamp((GRAVITY * dist) / (S.speed * S.speed), -1, 1)) : 0;
  const wantPitch = clamp(
    Math.atan2(_d.y, Math.max(horiz, 0.5)) + sup, T.pitchMin, T.pitchMax);

  const dy = wrapPi(wantYaw - v.turretYaw);
  const stepY = T.yawRate * dt;
  v.turretYaw = wrapPi(v.turretYaw + clamp(dy, -stepY, stepY));
  const dp = wantPitch - v.gunPitch;
  const stepP = T.pitchRate * dt;
  v.gunPitch = clamp(v.gunPitch + clamp(dp, -stepP, stepP), T.pitchMin, T.pitchMax);
}

/**
 * The EMITTED muzzle pose — position and direction in world space, composed
 * from the same pivot chain `syncTransforms` drives, so the shell leaves the
 * end of the drawn barrel, not a bookkeeping point.
 */
export function muzzleWorld(v, outPos, outDir) {
  const st = v.spec.style;
  const g = st.gun;
  _qy.setFromAxisAngle(_Y, v.turretYaw ?? 0);
  _qp.setFromAxisAngle(_X, -(v.gunPitch ?? 0));
  // Gun-frame forward, into body frame.
  outDir.set(0, 0, 1).applyQuaternion(_qp).applyQuaternion(_qy).applyQuaternion(v.quaternion);
  // Muzzle: turret pivot + yawed (gun pivot + pitched barrel tip).
  outPos.set(0, 0, g.len).applyQuaternion(_qp)
    .add(_v.set(0, g.y, g.z))
    .applyQuaternion(_qy)
    .add(_d.set(st.turret.x ?? 0, st.turret.y - v.spec.comY, st.turret.z))
    .applyQuaternion(v.quaternion)
    .add(v.position);
  return outPos;
}

/* ====================================================================== */
/* The shell                                                              */
/* ====================================================================== */

/**
 * Fire the main gun. `sys` is the VehicleSystem (or a probe's stub carrying
 * `ctx.events`, `physics` and `vehicles`). Returns the live shell, or null
 * while reloading / wrecked. `target` is an optional convenience that also
 * commands the turret — but the shell leaves along the barrel's CURRENT
 * emitted direction, never along a snap to the target.
 */
export function fireShell(sys, v, target = null) {
  const T = v?.spec?.turret;
  if (!T || v.destroyed) return null;
  if (target) aimTurret(v, target);
  if (v.gunCool > 0) return null;
  v.gunCool = T.reload;

  muzzleWorld(v, _mp, _md);

  // The canonical muzzle event: fx draws the flash, audio plays the report,
  // police price the shot, peds panic. Allocation is fine at 0.25 Hz.
  sys?.ctx?.events?.emit('weapon:fire', {
    weapon: 'tankgun',
    origin: _mp.clone(),
    dir: _md.clone(),
    seed: ((sys?.rng?.u32?.() ?? (Math.abs(_mp.x * 7919 + _mp.z * 104729) | 0)) >>> 0),
    flashScale: T.recoil?.flash ?? 2.4,
    light: 2,
  });

  // Recoil: the hull takes the opposite impulse, plus a nose-up pitch kick
  // about the gun's right axis. Visible, felt, and it wakes the solver.
  const R = T.recoil ?? {};
  v.wake?.();
  v.velocity.addScaledVector(_md, -(R.kick ?? 0.8));
  _v.set(1, 0, 0).applyQuaternion(v.quaternion);
  v.angularVelocity.addScaledVector(_v, -(R.pitch ?? 0.4));

  const S = T.shell;
  const shell = {
    pos: _mp.clone().addScaledVector(_md, 0.2),
    prev: _mp.clone(),
    vel: _md.clone().multiplyScalar(S.speed),
    owner: v,
    life: S.life ?? 6,
    radius: S.radius,
    damage: S.damage,
  };
  (sys._shells ?? (sys._shells = [])).push(shell);
  return shell;
}

const _seg = new THREE.Vector3();
const _rel = new THREE.Vector3();
/** Reused payload, the same shape `ballistics.js` emits. */
const _boom = { position: new THREE.Vector3(), radius: 6, damage: 100, source: 'tankshell' };

/**
 * Integrate every live shell one fixed step and detonate the ones that land.
 * World geometry via `physics.raycast` (which falls back to the analytic
 * ground city-wide), vehicles via a segment-vs-bounding-sphere test — the
 * fleet is not in the static BVH.
 */
export function stepShells(sys, dt) {
  const shells = sys._shells;
  if (!shells || shells.length === 0) return;
  const phys = sys.physics;
  for (let i = shells.length - 1; i >= 0; i--) {
    const s = shells[i];
    s.prev.copy(s.pos);
    s.vel.y -= GRAVITY * dt;
    s.pos.addScaledVector(s.vel, dt);
    s.life -= dt;

    _seg.copy(s.pos).sub(s.prev);
    const len = _seg.length();
    let hit = null;
    if (len > 1e-6 && phys?.raycast) {
      _seg.multiplyScalar(1 / len);
      const h = phys.raycast(s.prev, _seg, len, phys.MASK?.WORLD ?? 0);
      if (h?.hit) hit = h.point;
    }
    if (!hit) {
      // The fleet. Never the tank that fired — a muzzle 5.3 m out on the
      // barrel still overlaps a 4 m hull's bounding sphere at fire time.
      const list = sys.vehicles;
      if (list) {
        for (let j = 0; j < list.length; j++) {
          const t = list[j];
          if (t === s.owner || t.destroyed || t._staged) continue;
          _rel.copy(t.position).sub(s.prev);
          const along = clamp(_rel.dot(_seg), 0, len);
          const d2 = _rel.addScaledVector(_seg, -along).lengthSq();
          const r = (t.boundingRadius ?? 2) * 0.85;
          if (d2 < r * r) {
            hit = _v.copy(s.prev).addScaledVector(_seg, along);
            break;
          }
        }
      }
    }
    if (!hit && s.life > 0) continue;

    // THE detonation — the same event, the same payload shape, the same
    // listeners as the Scrap Rocket. Nothing else applies damage.
    _boom.position.copy(hit ?? s.pos);
    _boom.radius = s.radius;
    _boom.damage = s.damage;
    sys?.ctx?.events?.emit('explosion', _boom);
    shells.splice(i, 1);
  }
}
