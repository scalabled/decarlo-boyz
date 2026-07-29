/**
 * POLICE — the spawn director.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * THE RULE: A CRUISER MUST NEVER APPEAR IN YOUR MIRROR
 * ────────────────────────────────────────────────────────────────────────────
 * Pressure has to be believable, and nothing destroys that faster than a car
 * materialising in the frame. So a spawn must clear three tests:
 *
 *   1. OUT OF THE VIEW CONE. Rejected if it is inside the camera's forward
 *      cone and nearer than `spawnViewFar`.
 *   2. OUT OF SIGHT. A physics ray from the camera to the spawn must be
 *      blocked, unless it is far enough away that the pop is sub-pixel.
 *   3. USEFUL. Scored so that a spawn AHEAD of where the quarry is going beats
 *      one behind — cops should be coming the other way down the street you
 *      chose, which is the thing that makes a city feel policed rather than
 *      merely chased through.
 *
 * The director is also the budget authority. `traffic` sizes its population
 * from `q.trafficBudget` and (per its own grid.js) expects police to sit on top
 * of that; this system therefore keeps its own fleet to `TUNE.budgetShare` of
 * the same number so the two together stay inside what the renderer and the
 * vehicle solver were sized for, and asks `traffic.recycleFarthest()` for a
 * slot rather than silently overshooting.
 */

import * as THREE from 'three';
import { Unit, ROLE } from './unit.js';
import { TUNE, clamp } from './tune.js';

const _cam = new THREE.Vector3();
const _fwd = new THREE.Vector3();
const _pose = { x: 0, y: 0, z: 0, yaw: 0, score: -1e9 };
const _best = { x: 0, y: 0, z: 0, yaw: 0, score: -1e9 };

export class Dispatch {
  constructor(sys) {
    this.sys = sys;
    this._timer = 0;
    this._cullTimer = 0;
    this._footTimer = 0;
    this.stats = { spawned: 0, culled: 0, rejected: 0, wanted: 0 };
    this._edgeFilter = (e) => !e.rail && e.len > 24 && !e.oneway;
  }

  /** How many cruisers should be on the street right now. */
  fleetTarget() {
    const sys = this.sys;
    const level = sys.level;
    if (level === 0) return 0;
    const q = sys.ctx.config.q;
    const budget = Math.floor((q.trafficBudget ?? 24) * TUNE.budgetShare);
    return Math.max(1, Math.min(TUNE.fleet[level] ?? 1, budget, TUNE.fleetCeil));
  }

  step(dt, ctx) {
    const sys = this.sys;
    this._timer -= dt;
    this._cullTimer -= dt;
    this._footTimer -= dt;

    if (this._cullTimer <= 0) {
      this._cullTimer = 1.7;
      this._cull(ctx);
    }

    this._footStep(ctx);

    if (this._timer > 0) return;
    // Response aggression is a difficulty axis: hard/steel put cars on the
    // street faster, easy slower. Same fleet size — cadence, not count.
    this._timer = TUNE.dispatchPeriod / sys.diff.aggr;

    const want = this.fleetTarget();
    this.stats.wanted = want;
    const live = sys.liveUnits();

    if (live < want) {
      this.spawnOne(ctx, live === 0 ? ROLE.CHASE : ROLE.RESPOND);
    } else if (live > want) {
      this._standDown(ctx, live - want);
    }
  }

  /**
   * Independent pavement responders — a response is a foot cop 55% of the time
   * at wanted 1-2 and 30% at 3+. Rolled per attempt
   * against a per-star standing target so arrivals stagger the way cruiser
   * dispatches do, all inside the search cordon and never in view.
   */
  _footStep(ctx) {
    if (this._footTimer > 0) return;
    const sys = this.sys;
    this._footTimer = TUNE.foot.period / sys.diff.aggr;
    const level = sys.level;
    if (level === 0 || !sys.quarry.valid) return;
    const want = TUNE.foot.target[level] ?? 0;
    if (sys.officers.standalone >= want) return;
    if (sys.rng.float() >= (TUNE.foot.chance[level] ?? 0.3)) return;
    sys.spawnFootResponder();
  }

  /* ==================================================================== */
  /* Spawning                                                             */
  /* ==================================================================== */

  /**
   * Put one cruiser on the road. `opts.near` overrides the anchor (roadblocks
   * spawn near the block site, not near the player).
   *
   * The anchor is `police.searchAnchor` — WHERE THEY THINK YOU ARE, not where
   * you are. See the comment on that getter: this one line is the difference
   * between a wanted level you can escape and one you cannot.
   */
  spawnOne(ctx, role = ROLE.RESPOND, opts = {}) {
    const sys = this.sys;
    if (!sys.roads || !sys.vehicles) return null;
    const anchor = opts.near ?? sys.searchAnchor;
    if (!anchor) return null;

    const pose = this._findPose(ctx, anchor, opts);
    if (!pose) { this.stats.rejected++; return null; }

    // The total vehicle count is shared with `traffic`. If we are at the
    // ceiling, ask it for a slot through its own public API rather than
    // quietly pushing the count past what the frame was budgeted for.
    const q = ctx.config.q;
    const ceiling = (q.trafficBudget ?? 24) + TUNE.fleetCeil;
    if (sys.vehicles.vehicles.length >= ceiling) {
      try { sys.traffic?.recycleFarthest?.(ctx, 1); } catch { /* partner */ }
    }

    const spec = sys.vehicles.specOf('police');
    // Surface height: trust the physics ray only when it agrees with the road
    // graph's own lane height — `police.laneSurfaceY` carries the rule and the
    // reason. This is where it was found.
    const y = sys.laneSurfaceY(pose.x, pose.z, pose.y) + (spec?.comY ?? 0.5) + 0.05;
    const v = sys.vehicles.spawn('police', _cam.set(pose.x, y, pose.z), pose.yaw, {
      rng: sys.rng,
    });
    if (!v) return null;

    const unit = sys.takeUnit();
    unit.bind(v, role);
    // Rolling start: a cruiser that appears from a standstill 200 m away can
    // never catch anybody, and the acceleration model is honest enough that it
    // matters. Give it the speed it would have had arriving on this road.
    const s = Math.min(this._roadSpeedAt(pose.x, pose.z) * 0.55, 14);
    v.velocity.set(Math.sin(pose.yaw) * s, 0, Math.cos(pose.yaw) * s);
    v.sleeping = false;
    v._sleepTimer = 0;
    this.stats.spawned++;
    return unit;
  }

  _roadSpeedAt(x, z) {
    const hit = this.sys.roads?.nearestEdge?.(x, z, 60);
    return hit?.edge?.speed ?? 12;
  }

  /**
   * Sample legal lane poses and keep the best-scoring one that is genuinely
   * out of sight.
   */
  _findPose(ctx, anchor, opts) {
    const sys = this.sys;
    const roads = sys.roads;
    ctx.camera.getWorldPosition(_cam);
    _fwd.set(0, 0, -1).applyQuaternion(ctx.camera.quaternion);
    _fwd.y = 0;
    if (_fwd.lengthSq() < 1e-6) _fwd.set(0, 0, 1);
    _fwd.normalize();

    // The heading bias is part of the belief too: the last vector anybody
    // actually observed, which is the quarry's real one while they can see it
    // and a stale one the moment they cannot. Falling back to the quarry's live
    // forward would put cars ahead of a car nobody can see.
    const q = sys.quarry;
    const w = sys.meter;
    const bs = Math.hypot(w.knownVX, w.knownVZ);
    const hx = bs > 2.5 ? w.knownVX / bs : (w.hasKnown && !w.seen ? 0 : q.forward.x);
    const hz = bs > 2.5 ? w.knownVZ / bs : (w.hasKnown && !w.seen ? 0 : q.forward.z);
    const minD = opts.minDist ?? TUNE.spawnMin;
    const maxD = opts.maxDist ?? TUNE.spawnMax;

    _best.score = -1e9;
    for (let i = 0; i < TUNE.spawnTries; i++) {
      const s = roads.sampleSpawn(sys.rng, anchor, minD, maxD, this._edgeFilter);
      if (!s) break;
      const x = s.position.x;
      const y = s.position.y;
      const z = s.position.z;
      const yaw = s.yaw;

      /* --- 1. the view cone --- */
      const dx = x - _cam.x;
      const dz = z - _cam.z;
      const d = Math.hypot(dx, dz);
      if (d < 1) continue;
      const inCone = (dx / d) * _fwd.x + (dz / d) * _fwd.z > TUNE.spawnViewCos;
      if (inCone && d < TUNE.spawnViewFar) continue;

      /* --- 2. nothing already parked on that piece of road --- */
      if (sys.unitNear(x, z, TUNE.spawnClear)) continue;
      // Traffic and parked cars count too: spawning a cruiser inside a sedan
      // ejects both of them across the street.
      if (sys.vehicles.nearest(x, y + 0.6, z, TUNE.spawnBodyClear)) continue;

      /* --- 3. really out of sight --- */
      if (inCone || d < 150) {
        _pose.x = x; _pose.y = y + 1.2; _pose.z = z;
        if (sys.rayVisible(_cam, _pose, 0)) continue;
      }

      /* --- score: ahead of the quarry is worth the most --- */
      const ax = x - anchor.x;
      const az = z - anchor.z;
      const ad = Math.max(1, Math.hypot(ax, az));
      const ahead = (ax / ad) * hx + (az / ad) * hz;
      // Prefer them coming the other way down the street the quarry chose.
      const facing = -(Math.sin(yaw) * hx + Math.cos(yaw) * hz);
      const score =
        ahead * (TUNE.spawnAheadBonus * 100) +
        facing * 26 -
        Math.abs(ad - (minD + maxD) * 0.42) * 0.5;
      if (score > _best.score) {
        _best.score = score;
        _best.x = x;
        _best.y = y;
        _best.z = z;
        _best.yaw = yaw;
      }
    }
    return _best.score > -1e8 ? _best : null;
  }

  /* ==================================================================== */
  /* Culling                                                              */
  /* ==================================================================== */

  /**
   * Recycle units that have become useless: miles away, wrecked, or wedged.
   * Never in view — a car that vanishes on screen is worse than one that
   * appeared there.
   */
  _cull(ctx) {
    const sys = this.sys;
    ctx.camera.getWorldPosition(_cam);
    _fwd.set(0, 0, -1).applyQuaternion(ctx.camera.quaternion);
    _fwd.y = 0;
    _fwd.normalize();
    // Cull against the SEARCH, not against the quarry. Measured with the runner
    // teleported a kilometre away: every unit was instantly "far" from the
    // truth, all of them were recycled, and the replacements were spawned back
    // on top of the quarry — the cull was the second half of the same cheat.
    const ref = sys.searchAnchor;

    for (let i = sys.units.length - 1; i >= 0; i--) {
      const u = sys.units[i];
      if (!u.active || !u.vehicle) continue;
      const p = u.vehicle.position;
      const dq = ref ? Math.hypot(p.x - ref.x, p.z - ref.z) : 1e9;
      const wrecked = u.vehicle.destroyed;
      const far = dq > TUNE.cullRange;
      const gone = u.role === ROLE.LEAVE && dq > 220;
      if (!wrecked && !far && !gone) continue;

      // Wrecks stay — a burnt-out cruiser in the road is a story. But it is no
      // longer a unit, so hand the shell to nobody and drop the unit.
      const dx = p.x - _cam.x;
      const dz = p.z - _cam.z;
      const dc = Math.hypot(dx, dz);
      const visible = dc < 260 && (dx / Math.max(1, dc)) * _fwd.x + (dz / Math.max(1, dc)) * _fwd.z > TUNE.cullViewCos;
      if (visible && !wrecked) continue;
      sys.retireUnit(u, wrecked ? 'wrecked' : 'far');
      this.stats.culled++;
    }
  }

  /** Too many units for the current level: send the furthest ones home. */
  _standDown(ctx, n) {
    const sys = this.sys;
    let sent = 0;
    const ref = sys.searchAnchor;
    // Furthest first.
    let worst = null;
    for (let k = 0; k < n; k++) {
      worst = null;
      let wd = -1;
      for (const u of sys.units) {
        if (!u.active || u.role === ROLE.LEAVE || u.role === ROLE.BLOCK) continue;
        const d = ref
          ? Math.hypot(u.vehicle.position.x - ref.x, u.vehicle.position.z - ref.z)
          : 0;
        if (d > wd) { wd = d; worst = u; }
      }
      if (!worst) break;
      worst.role = ROLE.LEAVE;
      worst._replan = 0;
      worst.vehicle.lightbarOn = false;
      sent++;
    }
    return sent;
  }
}

export { Unit };
