/**
 * GROUND FALLBACK — the answer a ray gets when it leaves the streamed world.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * WHAT THIS IS FOR
 * ────────────────────────────────────────────────────────────────────────────
 * `world` streams real triangle collision as a patch around the camera
 * (`TCOL_HALF`, 320 m) and states plainly that **beyond it there is
 * deliberately no collision** — the supported query out there is
 * `world.walkableHeightAt(x, z, y?)`, which is analytic and always available.
 *
 * That is a reasonable contract for anything that can call `world`. The
 * problem is that most of the things that need ground do NOT call `world`;
 * they call physics:
 *
 *   weapons/ballistics.js   phys.raycast(..., MASK.BULLET)
 *   vehicles/dynamics.js    phys.raycast(..., MASK.WORLD)   per wheel
 *   traffic/index.js        phys.groundHeight(x, z, hint)
 *   police/dispatch.js      phys.groundHeight(...)          spawn poses
 *   props/layout.js         phys.raycast(down)              placement
 *   player/vehicle.js       phys.groundHeight(...)          exit poses
 *
 * Measured with `node src/physics/groundsweep.mjs --noproxy` against the
 * 320 m build: a downward `MASK.BULLET` ray finds ground at **11.2%** of a
 * 50 m grid over the city, and 0% past 1.5 km. A rocket fired at a target
 * 500 m away passes through the floor and never detonates. Nothing is logged.
 * Nobody would ever know why.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * WHAT IT DOES
 * ────────────────────────────────────────────────────────────────────────────
 * It is not a second collider — `world` owns static collision and has decided
 * where it ends. This is physics honouring its own contract by CONSUMING the
 * analytic query `world` publishes for exactly this case: when a ray finds no
 * triangle, solve it against `walkableHeightAt` directly, by a sphere-traced
 * march and a bisection. Exact to about a millimetre, allocates nothing, and
 * costs literally zero inside the streamed patch because the ray hits a real
 * triangle first and never gets here.
 *
 * `walkableHeightAt`, not `heightAt`: the terrain is sunk 0.55 m under every
 * road corridor with the kerb 15 cm above that, so `heightAt` on a pavement is
 * most of a metre below the pavement. Using it as a ground reference puts every
 * long-range bullet impact underneath the street.
 */

/** How far out the analytic answer is offered. The city is 3 km square. */
const HALF = 1680;
/** Steepest slope the ground is assumed to reach, for the sphere-trace bound. */
const SLOPE_MAX = 4.0;
/** Bisection passes once a crossing is bracketed. */
const BISECT = 16;
/** Hard cap on march steps, so a grazing ray can never run away. */
const MAX_STEPS = 224;

/**
 * `world.surfaceAt` speaks the world vocabulary; physics speaks the twelve
 * names in ARCHITECTURE.md. One lookup per hit, never per step.
 */
const SURFACE_FROM_WORLD = {
  asphalt: 'concrete',
  sidewalk: 'concrete',
  dirt: 'dirt',
  grass: 'dirt',
  water: 'water',
  sand: 'sand',
};

export class GroundFallback {
  constructor() {
    this.half = HALF;
    /** True once `world` has been found and the analytic query is live. */
    this.ready = false;
    /** Queries answered here rather than by a real triangle. */
    this.hits = 0;

    this._hf = null;
    this._surfaceAt = null;
    this._world = null;

    /** Scratch for `ray()` — no per-frame allocation. */
    this.hit = { t: 0, px: 0, py: 0, pz: 0, nx: 0, ny: 1, nz: 0, surface: 'dirt' };
  }

  /**
   * Bind to `world`. Prefers `walkableHeightAt` (the surface a man or a car
   * stands on) and falls back to `heightAt` only if an older `world` is loaded.
   */
  bind(world) {
    if (this.ready || !world) return false;
    if (typeof world.walkableHeightAt === 'function') {
      this._hf = (x, z) => world.walkableHeightAt(x, z);
    } else if (typeof world.heightAt === 'function') {
      this._hf = (x, z) => world.heightAt(x, z);
      console.warn(
        '[physics] world has no walkableHeightAt() — falling back to heightAt(), ' +
        'which reads ~0.7 m low on every road and pavement in the city'
      );
    } else {
      return false;
    }
    this._surfaceAt = typeof world.surfaceAt === 'function' ? (x, z) => world.surfaceAt(x, z) : null;
    this._world = world;
    this.ready = true;
    console.info(
      '[physics] ground fallback armed — a ray that leaves the streamed collision ' +
      'patch is now solved against world.walkableHeightAt instead of finding nothing'
    );
    return true;
  }

  /** Walkable surface height, or NaN outside the city footprint. */
  heightAt(x, z) {
    if (!this._hf) return NaN;
    if (x < -HALF || x > HALF || z < -HALF || z > HALF) return NaN;
    const y = this._hf(x, z);
    return Number.isFinite(y) ? y : NaN;
  }

  /**
   * Exact ray / heightfield intersection, clipped to the city footprint.
   * Sphere-traced: the ground can climb at most `SLOPE_MAX` per metre of
   * horizontal travel, so the current gap bounds how far the trace may skip in one
   * step. Returns t (metres along a UNIT dir) or -1, and fills `this.hit`.
   */
  ray(ox, oy, oz, dx, dy, dz, maxT) {
    const hf = this._hf;
    if (!hf) return -1;

    // Clip to the XZ footprint.
    let t0 = 0, t1 = maxT;
    if (Math.abs(dx) > 1e-9) {
      const a = (-HALF - ox) / dx, b = (HALF - ox) / dx;
      t0 = Math.max(t0, Math.min(a, b));
      t1 = Math.min(t1, Math.max(a, b));
    } else if (ox < -HALF || ox > HALF) return -1;
    if (Math.abs(dz) > 1e-9) {
      const a = (-HALF - oz) / dz, b = (HALF - oz) / dz;
      t0 = Math.max(t0, Math.min(a, b));
      t1 = Math.min(t1, Math.max(a, b));
    } else if (oz < -HALF || oz > HALF) return -1;
    if (t1 <= t0) return -1;

    const horiz = Math.hypot(dx, dz);
    const climb = SLOPE_MAX * horiz - dy;   // fastest the gap can close, per t
    // A ray climbing faster than the ground possibly can will never meet it.
    // Without this, every shot fired at the sky pays for a full march.
    if (climb <= 1e-4) return -1;
    const minStep = Math.max(0.05, (t1 - t0) / (MAX_STEPS - 32));

    let t = t0;
    let gap = oy + dy * t - hf(ox + dx * t, oz + dz * t);
    // Starting inside the ground is not a surface crossing — a ray fired from
    // inside a hill must not report a point-blank impact on the shooter.
    if (!(gap > 0)) return -1;

    let guard = 0;
    while (t < t1 && guard++ < MAX_STEPS) {
      const dt = Math.min(Math.max(gap / climb, minStep), 96);
      const tn = Math.min(t + dt, t1);
      const gn = oy + dy * tn - hf(ox + dx * tn, oz + dz * tn);
      if (gn <= 0) {
        let lo = t, hi = tn;
        for (let k = 0; k < BISECT; k++) {
          const mid = (lo + hi) * 0.5;
          if (oy + dy * mid - hf(ox + dx * mid, oz + dz * mid) > 0) lo = mid;
          else hi = mid;
        }
        this.hits++;
        return this._fill(hi, ox, oy, oz, dx, dy, dz);
      }
      if (tn >= t1) break;
      t = tn;
      gap = gn;
    }
    return -1;
  }

  _fill(t, ox, oy, oz, dx, dy, dz) {
    const hf = this._hf;
    const px = ox + dx * t, pz = oz + dz * t;
    const h = this.hit;
    h.t = t;
    h.px = px;
    h.py = oy + dy * t;
    h.pz = pz;
    // Central-difference normal, one metre wide.
    const e = 1.0;
    const nx = hf(px - e, pz) - hf(px + e, pz);
    const nz = hf(px, pz - e) - hf(px, pz + e);
    const l = Math.hypot(nx, 2 * e, nz) || 1;
    h.nx = nx / l; h.ny = (2 * e) / l; h.nz = nz / l;
    h.surface = this._surfaceAt
      ? (SURFACE_FROM_WORLD[this._surfaceAt(px, pz)] ?? 'dirt')
      : 'dirt';
    return t;
  }

  dispose() {
    this.ready = false;
    this._hf = null;
    this._surfaceAt = null;
    this._world = null;
  }
}
