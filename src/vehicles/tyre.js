/**
 * Combined-slip tyre model (Pacejka "magic formula", friction-ellipse coupling).
 *
 *   F = D * sin( C * atan( B*s - E*(B*s - atan(B*s)) ) )
 *
 * with the longitudinal and lateral slips combined into a single normalised
 * slip vector before the curve is evaluated, then the resulting force
 * distributed back along that vector. That coupling is the whole game: it is
 * why you cannot brake and turn at the same time, why standing on the throttle
 * mid-corner sends the back out, and why lifting mid-slide brings it back.
 *
 * Load sensitivity (`mu` falls as vertical load rises) is what turns weight
 * transfer into a handling effect rather than just a visual one — the loaded
 * outside tyre gives back less grip than the unloaded inside one takes away, so
 * a car with too much roll stiffness at one end pushes or spins at that end.
 */

import { SURFACE_GRIP, DEFAULT_GRIP } from './specs.js';

/** Minimum speed used to normalise slip, m/s. Below it the tyre is "stuck". */
const V_MIN = 2.2;

export function surfaceGrip(name) {
  return SURFACE_GRIP[name] ?? DEFAULT_GRIP;
}

/**
 * @param w        wheel state (mutated: w.fx, w.fy, w.slipRatio, w.slipAngle, w.combined)
 * @param tyre     spec.tyre
 * @param load     vertical load N (>= 0)
 * @param loadRef  the tyre's nominal load N
 * @param vLong    contact-patch velocity along the wheel's heading, m/s
 * @param vLat     contact-patch velocity across it, m/s
 * @param omega    wheel angular velocity rad/s
 * @param radius   rolling radius m
 * @param grip     surface multiplier
 * @param dt       step
 */
export function tyreForces(w, tyre, load, loadRef, vLong, vLat, omega, radius, grip, dt) {
  if (load <= 1) {
    w.fx = 0;
    w.fy = 0;
    w.slipRatio = 0;
    w.slipAngle = 0;
    w.combined = 0;
    w.latLag = 0;
    w.kFx = 0;
    return;
  }

  const vRef = Math.max(V_MIN, Math.abs(vLong));

  // ---- slips -------------------------------------------------------------
  const kappa = (omega * radius - vLong) / vRef;
  // Lateral slip is lagged by the relaxation length: a tyre does not build
  // cornering force instantly, it builds it over half a wheel revolution.
  // Without this the car snaps between grip states and feels like an air
  // hockey puck.
  const alphaTarget = -vLat / vRef;
  const relaxRate = Math.min(1, (Math.abs(vLong) * dt) / Math.max(0.05, tyre.relax));
  w.latLag = w.latLag + (alphaTarget - w.latLag) * Math.max(relaxRate, dt * 12);
  const alpha = w.latLag;

  // ---- load-sensitive friction ------------------------------------------
  const loadRatio = load / Math.max(1, loadRef);
  const sens = Math.max(0.42, Math.min(1.35, 1 - tyre.loadSens * (loadRatio - 1)));
  // Heat/abuse fade: a tyre that has been sliding gives back less.
  const fade = 1 - tyre.fade * w.heat;
  const muX = tyre.muLong * sens * grip.mu * fade;
  const muY = tyre.muLat * sens * grip.mu * fade;

  // ---- combined magic formula -------------------------------------------
  const sx = tyre.Bx * kappa;
  const sy = tyre.By * alpha;
  const s = Math.hypot(sx, sy);
  const C = (tyre.Cx + tyre.Cy) * 0.5;
  const E = (tyre.Ex + tyre.Ey) * 0.5;
  const shaped = s - E * (s - Math.atan(s));
  const f = Math.sin(C * Math.atan(shaped));

  let ux = 0;
  let uy = 0;
  if (s > 1e-5) {
    ux = sx / s;
    uy = sy / s;
  }

  w.fx = ux * f * muX * load;
  w.fy = uy * f * muY * load;
  w.slipRatio = kappa;
  w.slipAngle = Math.atan(alpha);
  // 0 at full grip, 1 at the peak, > 1 past it.
  w.combined = s / Math.max(0.4, peakSlip(C, E));
  w.mu = (muX + muY) * 0.5;

  /**
   * ---- LONGITUDINAL STIFFNESS, d(fx)/d(omega) ----------------------------
   *
   * Handed to `dynamics._stepWheels` so the wheel-spin integration can be made
   * implicit. THIS IS NOT A REFINEMENT — without it the wheel-spin ODE is
   * violently unstable at low road speed and the car cannot pull away.
   *
   * A free wheel obeys  I dw/dt = -r fx(w),  and near zero slip
   * fx = C Bx muX Fz (w r - v) / vRef, so the relaxation rate is
   *
   *     lambda = C Bx muX Fz r^2 / (I vRef)
   *
   * For the sedan's rear wheel on dirt that is 1543 per second: I = 1.53,
   * Fz = 3600, r = 0.335, vRef pinned at V_MIN. Explicit Euler is stable only
   * while lambda*dt < 2, and lambda*dt here is 12.9 — SIX TIMES over. The
   * measured result is an undriven wheel flipping between -4 and +4 rad/s on
   * alternate 120 Hz steps and throwing +2700/-2400 N at the chassis, which is
   * how a car at full throttle with four wheels on the ground sits still: the
   * body force alternated +5641 / -5305 N and averaged to nothing.
   *
   * It is a low-speed defect only because vRef is clamped at V_MIN below
   * 2.2 m/s; by 20 m/s lambda*dt is 1.4 and the same code is stable. That is
   * exactly why "the car will not pull away" and "the car drives fine once it
   * is moving" are the same bug.
   *
   * The larger of the local TANGENT and the SECANT through the origin, and both
   * are needed. The tangent is the right stiffness near zero slip, which is
   * where the divergence starts; but past the peak it goes negative, and a wheel
   * that has already been thrown out there then gets no damping at all and the
   * oscillation sustains itself instead of dying — measured on the bike's
   * coasting front wheel, still swinging at a slip ratio of 0.50 after six
   * seconds with the tangent alone. The secant `fx/kappa` stays positive
   * everywhere, equals the tangent as kappa goes to zero, and decays with deep
   * slip exactly as it should, because a tyre truly spinning up IS free to
   * accelerate.
   *
   * Neither choice can move the answer: the correction is proportional to the
   * CHANGE in omega, so it vanishes identically at steady state. Only the path
   * there differs, and only where the old one was diverging.
   */
  const dShaped = 1 - E * (1 - 1 / (1 + s * s));
  const dfds = (Math.cos(C * Math.atan(shaped)) * C * dShaped) / (1 + shaped * shaped);
  const fOverS = s > 1e-5 ? f / s : C;
  const dfdk = tyre.Bx * muX * load * (ux * ux * dfds + (1 - ux * ux) * fOverS);
  const secant = Math.abs(kappa) > 1e-6 ? Math.abs(w.fx / kappa) : dfdk;
  const k = dfdk > secant ? dfdk : secant;
  w.kFx = k > 0 ? (k * radius) / vRef : 0;

  // ---- heat / abuse ------------------------------------------------------
  const abuse = Math.max(0, w.combined - 1.0);
  w.heat += (abuse * 0.55 - w.heat * 0.5) * dt;
  if (w.heat < 0) w.heat = 0;
  else if (w.heat > 1) w.heat = 1;
}

/** Where the magic formula peaks, in normalised slip units. */
function peakSlip(C, E) {
  // sin(C*atan(x)) peaks when C*atan(x) = pi/2 -> x = tan(pi/(2C))
  const t = Math.tan(Math.PI / (2 * Math.max(1.01, C)));
  return t / (1 - E * 0.5);
}

/**
 * The SLIP RATIO at which this tyre makes its peak longitudinal force.
 *
 * 0.13 for a road tyre, 0.20 for the truck's, 0.11 for the bike's — the spread
 * comes straight from each class's `Bx`/`Cx`/`Ex`. The traction controller in
 * `dynamics` targets a fixed multiple of it, so it stays on the useful side of
 * the curve for every class without a per-class number to keep in sync.
 */
export function peakSlipRatio(tyre) {
  const C = (tyre.Cx + tyre.Cy) * 0.5;
  const E = (tyre.Ex + tyre.Ey) * 0.5;
  return peakSlip(C, E) / Math.max(0.5, tyre.Bx);
}

/**
 * Rolling resistance, N. Scales with load and (mildly) with speed, and is what
 * makes a coasting car actually come to a stop.
 */
export function rollingResistance(tyre, load, vLong, grip) {
  const c = tyre.rollRes * grip.roll;
  return -Math.sign(vLong) * load * c * (1 + Math.abs(vLong) * 0.012);
}
