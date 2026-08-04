/**
 * TRAFFIC — the population director.
 *
 * Decides HOW MANY cars there should be, WHAT they are, and WHERE they appear.
 *
 * Density is the product of three things: the quality budget, the district you
 * are standing in, and the clock. Downtown at 8 am is bumper to bumper; Steel
 * Row at 4 am has one truck on it and that is the point of having a day cycle
 * at all. The class mix is per district too, because a street full of identical
 * sedans is the tell that a city is procedural — Steel Row runs trucks, the
 * Golden Triangle runs saloons and the occasional sports car.
 *
 * Spawning is always OUT OF SIGHT: ahead of the player but outside the view
 * cone, or behind them, and never within a car's length of another vehicle.
 * Cars pop out of existence the same way. The one exception is a camera
 * teleport (a capture shot, a mission cut): then we fill the street in one
 * frame, because a screenshot cannot wait twenty seconds for traffic to build.
 */

import * as THREE from 'three';
import {
  TUNE, DISTRICT_MIX, HOUR_VOLUME, DISTRICT_RHYTHM, clamp, clamp01,
} from './tune.js';

const _v = new THREE.Vector3();
const _fwd = new THREE.Vector3();
/**
 * THE CAMERA GETS ITS OWN SCRATCH, AND THIS IS NOT A STYLE PREFERENCE.
 *
 * `_visible()` used to read the camera into `_v` — the same module-scope
 * vector `trySpawn()` holds the candidate LANE POINT in. Everything in
 * `trySpawn` after the visibility test therefore ran against the camera's
 * position rather than the road: the ground probe, and then
 *
 *     sys.vehicles.spawn(type, _v.set(_v.x, y, _v.z), yaw, ...)
 *
 * which put EVERY SINGLE CAR THIS SYSTEM SPAWNED at the camera, and the
 * driver bound to a lane that could be hundreds of metres away.
 *
 * That one aliasing mistake is the whole of: cars materialising 1-2 m from
 * the player two frames after the area was cleared; cars on grass 70 m from
 * the nearest road; the
 * harness's p90-p99 lane error of 50-130 m, which was read as a lane
 * projection matching a bridge deck and was nothing of the kind; and a large
 * share of the collision rate, because a car that appears in the middle of a
 * junction is hit by everything already in it.
 *
 * Preallocated scratch is hard rule 5. Aliasing two live values onto one
 * vector is how that rule fails, and it fails silently.
 */
const _cam = new THREE.Vector3();

/**
 * Metres of drivable lane per moving car — the density knob behind
 * `laneCapacity()`. `spawnMax` is pinned at 175 m by the collision world, so no
 * amount of `trafficBudget` can put more than (lane length in that disc)/this
 * many moving cars on screen: this, not the budget, is the wall the near-camera
 * car count hits in a dense grid at the top tiers.
 *
 * KEPT AT 95 ON PURPOSE, and that is the measured result of trying to lower it.
 * When the tier budgets were raised for street density, dropping this to pack
 * more cars into downtown was the obvious next move — and it was tried and
 * rejected. The traffic harness (node src/traffic/harness.mjs --site=downtown
 * --q=ultra) flips "nobody stopped forever" from PASS to FAIL at 68 (19 cars
 * queued > 20 s, one stood ~56 s) AND at 80 (60 s). The Golden Triangle grid is
 * ALREADY near saturation at 95 — the harness reads 57.9% of car-frames moving,
 * one car waiting 44.8 s at a light — so any real capacity lift there does not
 * add flowing traffic, it lengthens the light queue into a car park, which is
 * exactly what the `desired()` comment warns about. No crash in either case
 * (write-offs 0, no interpenetration): it is orderly gridlock, but a
 * minute-long standing queue is not "busy".
 *
 * The budget raise still adds cars where there is room for them — the lower
 * tiers (budget-bound, not capacity-bound) and the non-saturated arterials and
 * residential roads at ultra, where `min(budget*movingShare, capacity)` is the
 * budget term. Downtown stays at its natural, already-busy saturation. If a
 * future road-network change opens the grid up, this can come down — but only
 * with a fresh harness run showing "nobody stopped forever" still green.
 */
const LANE_M_PER_CAR = 95;

export class Director {
  constructor(sys) {
    this.sys = sys;
    this.budget = 16;
    this.target = 0;
    this._acc = 0;
    this._fail = 0;
    this._mixKeys = [];
    this._mixW = new Float32Array(8);
    this._edges = [];
    this._capacity = 8;
    this._capTimer = 0;
    /** Bound once — `sampleSpawn` takes a filter and we must not allocate. */
    this._filter = (e) => this._edgeOk(e);
  }

  _edgeOk(e) {
    if (e.rail) return false;
    if (e.len < 26) return false;
    const L = this.sys.lanes;
    if (!L.drivable(e, 1) && !L.drivable(e, -1)) return false;
    return true;
  }

  /* ------------------------------------------------------------ counts -- */

  /** Traffic volume 0..1 at a point, from district identity and the clock. */
  volumeAt(x, z) {
    const world = this.sys.world;
    const d = world?.districtAt?.(x, z);
    const id = d?.id ?? 'default';
    const r = DISTRICT_RHYTHM[id] ?? DISTRICT_RHYTHM.default;
    const h = this.sys.hour;
    const i = Math.floor(h) % 24;
    const j = (i + 1) % 24;
    const f = h - Math.floor(h);
    const hv = HOUR_VOLUME[i] * (1 - f) + HOUR_VOLUME[j] * f;
    const density = clamp(d?.density ?? 0.5, 0.12, 1.05);
    return clamp01((r.base + r.swing * hv) * (0.42 + 0.72 * density));
  }

  /**
   * Desired live driver count right now.
   *
   * The quality budget is a CEILING, not a target. What actually decides how
   * many cars belong here is how much road there is to put them on: pouring an
   * ultra preset's fifty-five cars into 175 m of residential grid, on top of
   * the forty-five kerb cars `props` puts there, produced a cascading pile-up
   * — cars destroyed each other, every wreck panicked the street, and the
   * street panicked into more wrecks. `laneCapacity()` bounds it: one car per
   * `LANE_M_PER_CAR` of drivable lane in the spawn disc, which is still far
   * sparser than IDM following distance (see that constant).
   */
  desired(ctx) {
    const q = ctx.config.q;
    this.budget = q.trafficBudget ?? 16;
    const a = this.sys.anchor;
    const vol = this.volumeAt(a.x, a.z);
    const capacity = this.laneCapacity();
    const moving = Math.round(Math.min(this.budget * this.sys.movingShare, capacity) * vol);
    this.target = clamp(moving, this.budget > 20 ? 4 : 2, this.budget);
    return this.target;
  }

  /** How many moving cars the road network around the anchor can hold. */
  laneCapacity() {
    const roads = this.sys.world?.roads;
    if (!roads) return 8;
    this._capTimer = (this._capTimer ?? 0) - 1;
    if (this._capTimer > 0) return this._capacity;
    this._capTimer = 90; // frames
    const a = this.sys.anchor;
    const R = TUNE.spawnMax;
    this._edges.length = 0;
    roads.edgesInRect(a.x - R, a.z - R, a.x + R, a.z + R, this._edges);
    let m = 0;
    for (let i = 0; i < this._edges.length; i++) {
      const e = this._edges[i];
      if (e.rail) continue;
      const na = roads.nodes[e.a];
      const nb = roads.nodes[e.b];
      const cx = (na.x + nb.x) * 0.5 - a.x;
      const cz = (na.z + nb.z) * 0.5 - a.z;
      if (cx * cx + cz * cz > R * R) continue;
      m += e.len;
    }
    this._capacity = Math.max(3, m / LANE_M_PER_CAR);
    return this._capacity;
  }

  /* ------------------------------------------------------------- mix ---- */

  pickClass(x, z, rng) {
    const world = this.sys.world;
    const id = world?.districtAt?.(x, z)?.id ?? 'default';
    const mix = DISTRICT_MIX[id] ?? DISTRICT_MIX.default;
    let total = 0;
    let n = 0;
    for (const k in mix) {
      this._mixKeys[n] = k;
      this._mixW[n] = mix[k];
      total += mix[k];
      n++;
    }
    // Nobody rides a bike in the rain, and the night shift is vans and trucks.
    const wet = this.sys.wetness;
    const night = this.sys.hour < 6 || this.sys.hour > 21;
    let r = rng.float() * total;
    for (let i = 0; i < n; i++) {
      let w = this._mixW[i];
      const k = this._mixKeys[i];
      if (k === 'bike') w *= (1 - wet * 0.9) * (night ? 0.4 : 1);
      if (k === 'truck' && night) w *= 1.5;
      if (k === 'sports' && night) w *= 0.7;
      r -= w;
      if (r <= 0) return k;
    }
    return 'sedan';
  }

  /* ----------------------------------------------------------- spawning -- */

  /**
   * One attempt at a spawn. `force` skips the visibility rule (capture fills,
   * and the first population after a teleport).
   */
  trySpawn(ctx, force = false) {
    const sys = this.sys;
    const roads = sys.world?.roads;
    if (!roads) return null;
    /**
     * Hard ceiling on the TOTAL vehicle population, not just ours. `props`
     * spawns kerb dressing against the same budget and `police` adds cruisers,
     * so a spawner that only counts its own drivers can run away. This is the
     * valve that guarantees it cannot.
     */
    if (sys.vehicles.vehicles.length > this.budget * 2 + 12) return null;
    const a = sys.anchor;
    const minD = force ? 34 : TUNE.spawnMin;
    const s = roads.sampleSpawn(sys.rng, a, minD, TUNE.spawnMax, this._filter);
    if (!s?.edge) return null;

    const L = sys.lanes;
    const e = s.edge;
    // Re-pick a lane the driver is actually allowed to use.
    let dir = s.lane < e.forward ? 1 : -1;
    if (!L.drivable(e, dir)) dir = -dir;
    if (!L.drivable(e, dir)) return null;
    // Do not aim a fresh spawn at a trap (a run of road that commits it to a
    // dead-end U-turn) when the other direction of the same edge is usable —
    // see LaneNet._computeTraps.
    if (L.isTrap(e, dir) && L.drivable(e, -dir) && !L.isTrap(e, -dir)) {
      dir = -dir;
    }
    const lo = L.laneLo(e, dir);
    const hi = L.laneHi(e, dir);
    const lane = hi > lo ? sys.rng.int(lo, hi) : lo;

    const t = clamp(s.t, 0.1, 0.9);
    const sAlong = dir > 0 ? t * e.len : (1 - t) * e.len;
    L.point(e, lane, sAlong, 0, _v);

    /**
     * `sampleSpawn` filters on the edge MIDPOINT, so a long edge whose middle
     * is comfortably far away can still hand back a point two metres from the
     * lens — which is how a flatbed ended up parked across a hero shot. Test
     * the actual point.
     */
    if (Math.hypot(_v.x - a.x, _v.z - a.z) < minD) return null;
    /**
     * ...and never near the PLAYER, whatever the anchor happens to be. See
     * `TUNE.spawnPlayerMin`. `force` does not relax this and nothing else may
     * either: a car appearing on top of you is a bug in every mode the game
     * has, not just in a screenshot.
     */
    if (!sys.clearOfPlayer(_v.x, _v.z, TUNE.spawnPlayerMin)) return null;
    if (sys.inSpawnHold(_v.x, _v.z)) return null;

    /**
     * NOTHING MATERIALISES IN THE FRAME. `force` used to skip this test
     * outright, and the capture burst went further and REQUIRED the point to
     * be on screen — which is how review captures kept coming back full of
     * cars moments after the shot definition had deliberately cleared them.
     * The most a hard-up spawner may now do is put a car on a street it can
     * see from a hundred metres away, where materialising is not perceptible.
     */
    if (this._visible(ctx, _v.x, _v.z)) {
      if (!force) return null;
      if (this._camDist(ctx, _v.x, _v.z) < TUNE.popSafe) return null;
    }
    if (!sys.laneClear(e, lane, sAlong, TUNE.spawnClear)) return null;

    // Only ever put a car where the collision world actually has a floor.
    const ground = sys.solidGroundY(_v.x, _v.z, _v.y);
    if (ground === null) return null;
    const type = this.pickClass(_v.x, _v.z, sys.rng);
    const spec = sys.vehicles.specOf(type);
    const y = ground + spec.comY + 0.06;
    const yaw = L.yaw(e, lane);
    /**
     * Never materialise a car AIMED AT A WALL. The lane test above only sees
     * other vehicles; a bridge abutment or a prop standing on the carriageway
     * is invisible to it, and a car spawned at road speed 10 m from one is a
     * guaranteed hard impact before its driver's own probe has had a single
     * tick — MEASURED: 5 of 35 big impacts in a 3-min downtown run were cars
     * less than 5 s old, several against bridge colliders. Same ray the
     * driver's `_probeAhead` uses, cast once at spawn time.
     */
    const phys = sys.physics;
    if (phys?.raycast) {
      const h = phys.raycast(
        _v.x, ground + 0.55, _v.z, Math.sin(yaw), 0, Math.cos(yaw), 18, phys.MASK.WORLD
      );
      if (h.hit && Math.abs(h.normal.y) < 0.65) return null;
    }
    const veh = sys.vehicles.spawn(type, _v.set(_v.x, y, _v.z), yaw, { rng: sys.rng });
    if (!veh) return null;
    veh.isTraffic = true;
    // Roll in at the road speed rather than from a standstill in the middle of
    // a carriageway — a car materialising at 0 km/h on a 55 mph road is a
    // rear-end collision waiting to happen and reads as a bug when it does.
    const v0 = Math.min(L.limit(e) * 0.85, 24);
    veh.velocity.set(Math.sin(yaw) * v0, 0, Math.cos(yaw) * v0);
    const wheelW = v0 / veh.spec.wheel.radius;
    for (const w of veh.wheels) w.omega = wheelW;
    this._seatGear(veh, wheelW);

    return sys.attach(veh, e, lane, sAlong);
  }

  /**
   * Put the gearbox in the gear the car would actually be in at this speed.
   * Without this the auto box wakes up in first at 20 m/s, bounces off the
   * limiter and bangs through four upshifts in the first second — audible,
   * visible in the brake/throttle trace, and completely avoidable.
   */
  _seatGear(veh, wheelOmega) {
    const dt = veh.drivetrain;
    const gb = veh.spec.gearbox;
    const eng = veh.spec.engine;
    let best = 2;
    for (let g = 2; g < gb.gears.length; g++) {
      const w = wheelOmega * gb.gears[g] * gb.final;
      best = g;
      if (w < eng.redlineW * 0.78) break;
    }
    dt.gear = best;
    dt.clutch = 1;
    dt.shiftTimer = 0;
    dt.omega = clamp(wheelOmega * gb.gears[best] * gb.final, eng.idleW, eng.redlineW * 0.9);
    dt.rpm = dt.omega / (Math.PI / 30);
  }

  /** True when (x,z) is inside the camera's view cone and close enough to notice. */
  visible(ctx, x, z) {
    return this._visible(ctx, x, z);
  }

  _visible(ctx, x, z) {
    const cam = ctx.camera;
    cam.getWorldPosition(_cam);
    const dx = x - _cam.x;
    const dz = z - _cam.z;
    const d = Math.hypot(dx, dz);
    if (d > TUNE.screenNear) return false;
    cam.getWorldDirection(_fwd);
    const l = Math.hypot(_fwd.x, _fwd.z) || 1;
    return (dx * _fwd.x + dz * _fwd.z) / (d * l) > TUNE.screenCos;
  }

  /** Plan distance from the camera to a point. Uses `_cam`, never `_v`. */
  _camDist(ctx, x, z) {
    ctx.camera.getWorldPosition(_cam);
    return Math.hypot(x - _cam.x, z - _cam.z);
  }

  /** Should this driver be recycled for being too far away? */
  shouldDespawn(ctx, driver) {
    const p = driver.vehicle?.position;
    if (!p) return true;
    const a = this.sys.anchor;
    const d = Math.hypot(p.x - a.x, p.z - a.z);
    if (d > TUNE.despawnHard) return true;
    if (d < TUNE.despawnR) return false;
    return !this._visible(ctx, p.x, p.z);
  }

  /* --------------------------------------------------------------- step -- */

  step(dt, ctx) {
    const want = this.desired(ctx);
    const live = this.sys.liveCount;

    if (live > want + 2) {
      this.sys.recycleFarthest(ctx, live - want);
      return;
    }
    if (live >= want) {
      this._acc = 0;
      return;
    }
    // Injecting cars into an already-full street faster than it can absorb
    // them is how a jam becomes a pile-up.
    this._acc += dt * TUNE.spawnRate * (1 + (want - live) * 0.12);
    let budget = Math.min(2, Math.floor(this._acc));
    if (budget <= 0) return;
    this._acc -= budget;
    while (budget-- > 0) {
      // After enough failures, allow an on-screen spawn far away rather than
      // leave the street empty — an empty road is a worse artefact than a car
      // that appears 200 m up the block.
      const force = this._fail > 8 || live < want * 0.55;
      if (this.trySpawn(ctx, force)) this._fail = 0;
      else this._fail++;
    }
  }

  /**
   * Populate now, ignoring visibility, but at most `perFrame` cars per call —
   * each spawn builds a vehicle model, and forty of them on one frame is a
   * visible hitch. The caller repeats this over a handful of frames, which
   * still lands well inside a capture's settle window.
   */
  fill(ctx, perFrame = 6) {
    const want = this.desired(ctx);
    let made = 0;
    let guard = 0;
    while (this.sys.liveCount < want && made < perFrame && guard++ < perFrame * 14) {
      if (this.trySpawn(ctx, true)) made++;
    }
    this._fail = 0;
    return this.sys.liveCount >= want;
  }
}
