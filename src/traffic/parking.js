/**
 * TRAFFIC — kerbside parking.
 *
 * WHO OWNS WHAT. `props` owns static parked-car dressing: it has a kerb layout
 * solver, its own budget, and it streams cars in and out with the camera. This
 * subsystem does NOT duplicate that. Placing our own bays on top of it produced
 * exactly what you would expect — two systems parking two cars in the same
 * three metres of kerb, measured at 1.7 m of interpenetration — and doubled the
 * vehicle count against a budget meant for one of us.
 *
 * What is left here is the part that is a TRAFFIC behaviour rather than set
 * dressing: a car standing at the kerb that indicates, waits for a gap, and
 * pulls out into the stream. It is one of the highest-value details in the
 * whole subsystem — a street where nothing ever joins or leaves is a conveyor
 * belt — and it needs a car this system owns, so we place that one ourselves,
 * in a clear stretch of kerb, out of sight.
 *
 * The bay geometry follows the same rule `lanes.js` uses: only where the kerb
 * lane can be given up and a running lane still remains in each direction.
 */

import * as THREE from 'three';
import { TUNE, clamp } from './tune.js';

/** Metres in from the kerb face to the centre of a parked car. */
const INSET = 1.25;
/** Keep clear of the junction at either end of the block. */
const END_CLEAR = 18;
/** Seconds a car sits at the kerb before it decides to leave. */
const DWELL = 4.5;

const _v = new THREE.Vector3();

export class ParkingLot {
  constructor(sys) {
    this.sys = sys;
    /** Cars we have parked that have not pulled out yet. */
    this.waiting = [];
    this.count = 0;
    this.cap = 0;
    this._edges = [];
    this._timer = 5;
  }

  dispose() {
    for (const w of this.waiting) this.sys.vehicles.despawn(w.v);
    this.waiting.length = 0;
    this.count = 0;
  }

  update(dt, ctx) {
    const sys = this.sys;
    if (!sys.lanes.ready) return;
    this.cap = sys.director.budget >= 26 ? 3 : 1;

    // Cars already at the kerb: count down, then merge into traffic.
    for (let i = this.waiting.length - 1; i >= 0; i--) {
      const w = this.waiting[i];
      w.t -= dt;
      const gone = !w.v.model.root.parent;
      if (gone || Math.hypot(w.v.position.x - sys.anchor.x, w.v.position.z - sys.anchor.z) > 260) {
        if (!gone) sys.vehicles.despawn(w.v);
        this.waiting.splice(i, 1);
        this.count--;
        continue;
      }
      if (w.t > 0) continue;
      if (!this._merge(w)) {
        w.t = 1.5; // no gap yet — wait, indicator still going
        continue;
      }
      this.waiting.splice(i, 1);
      this.count--;
    }

    this._timer -= dt;
    if (this._timer > 0) return;
    this._timer = 9 + sys.rng.float() * 14;
    if (this.count < this.cap) this._place(ctx);
  }

  /* --------------------------------------------------------------- place -- */

  /** Stand a car at a clear kerb, out of sight, ready to pull out. */
  _place(ctx) {
    const sys = this.sys;
    const roads = sys.world?.roads;
    if (!roads) return;
    const L = sys.lanes;
    const a = sys.anchor;
    const R = 150;
    this._edges.length = 0;
    roads.edgesInRect(a.x - R, a.z - R, a.x + R, a.z + R, this._edges);
    if (!this._edges.length) return;

    for (let attempt = 0; attempt < 14; attempt++) {
      const e = this._edges[sys.rng.int(0, this._edges.length - 1)];
      const flags = L.parkFlags(e);
      if (!flags) continue;
      const side = flags & 1 ? 1 : -1;
      const dir = side;
      if (!L.drivable(e, dir)) continue;
      if (e.len < END_CLEAR * 2 + 12) continue;
      const s = sys.rng.range(END_CLEAR, e.len - END_CLEAR);
      const half = L.halfWidth(e);
      L.centerAt(e, s / e.len, side > 0 ? half - INSET : -(half - INSET), _v);
      if (Math.hypot(_v.x - a.x, _v.z - a.z) < 34) continue;
      // The anchor is the CAMERA whenever the camera is away from the player,
      // so "34 m from the anchor" can be on top of the player's body. Test for
      // them separately — see `TUNE.spawnPlayerMin`.
      if (!sys.clearOfPlayer(_v.x, _v.z, TUNE.spawnPlayerMin)) continue;
      if (sys.inSpawnHold(_v.x, _v.z)) continue;
      if (sys.director.visible(ctx, _v.x, _v.z)) continue;
      if (sys.nearestVehicleDist(_v.x, _v.z) < 8) continue;
      const ground = sys.solidGroundY(_v.x, _v.z, _v.y);
      if (ground === null) continue;

      const type = sys.director.pickClass(_v.x, _v.z, sys.rng);
      const spec = sys.vehicles.specOf(type);
      const yaw = L.yaw(e, dir > 0 ? 0 : e.forward);
      const veh = sys.vehicles.spawn(
        type,
        _v.set(_v.x, ground + spec.comY + 0.04, _v.z),
        yaw + sys.rng.range(-0.035, 0.035),
        { rng: sys.rng, parked: true }
      );
      if (!veh) return;
      veh.isTraffic = true;
      veh.isParked = true;
      this.waiting.push({ v: veh, edge: e.id, dir, t: DWELL + sys.rng.float() * 6 });
      this.count++;
      return;
    }
  }

  /* --------------------------------------------------------------- merge -- */

  /** Join the traffic stream, if there is a gap to join it into. */
  _merge(w) {
    const sys = this.sys;
    if (sys.liveCount >= sys.director.target + 2) return false;
    const e = sys.world?.roads?.edges[w.edge];
    if (!e) return false;
    const L = sys.lanes;
    const lane = L.laneHi(e, w.dir);
    L.project(e, lane, w.v.position.x, w.v.position.z, sys._proj);
    const s = clamp(sys._proj.s, 2, e.len - 2);

    // Do not pull out in front of anybody: look back down the lane.
    const grid = sys.grid;
    const n = grid.query(w.v.position.x, w.v.position.z, 46, w.v);
    for (let i = 0; i < n; i++) {
      const o = grid.list[grid.hits[i]];
      if (o.speed < 1) continue;
      L.project(e, lane, o.position.x, o.position.z, sys._proj);
      if (Math.abs(sys._proj.lateral) > e.laneWidth) continue;
      const rel = s - sys._proj.s;
      // Behind us and closing, or right alongside.
      if (rel > 0 && rel < 24 + o.speed * 1.6) return false;
      if (Math.abs(rel) < 8) return false;
    }

    const d = sys.attach(w.v, e, lane, s);
    if (!d) return false;
    w.v.isParked = false;
    d.state = 'pullout';
    d.indicate = 3.5;
    return true;
  }

  /** A driver that was pulled out has been recycled — do not double-free. */
  forget(vehicle) {
    for (let i = 0; i < this.waiting.length; i++) {
      if (this.waiting[i].v === vehicle) {
        this.waiting.splice(i, 1);
        this.count--;
        return true;
      }
    }
    return false;
  }
}
