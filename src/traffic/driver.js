/**
 * TRAFFIC — the AI driver.
 *
 * One of these per traffic car. It never writes a transform: everything it does
 * reaches the world through `vehicles.setInput({throttle, brake, steer,
 * handbrake})`, so an AI car is subject to exactly the same tyre model, weight
 * transfer and collision response as the player's. If the controller is badly
 * tuned the car understeers into the kerb, and you can see it.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * LATERAL — pure pursuit with speed-scaled lookahead
 * ────────────────────────────────────────────────────────────────────────────
 *   Ld = clamp(L0 + kv * v, 4.6, 26)
 *   delta = atan2(2 * wheelbase * sin(alpha), Ld)
 * where `alpha` is the bearing to the point Ld metres along the lane path. Two
 * small correction terms are layered on: a proportional term on cross-track
 * error (pure pursuit alone rides wide through a constant-radius corner) and a
 * derivative term on it (damping — without it the car weaves at speed, and a
 * weaving car reads as broken from fifty metres away). The command is then
 * rate-limited and low-passed, because the plant already has its own steering
 * rate limit and fighting it produces exactly the oscillation we are avoiding.
 *
 * SIGN CONVENTIONS, the source of every bug in a controller like this:
 *   - yaw = atan2(fwd.x, fwd.z); increasing yaw rotates forward toward +X.
 *   - a body whose forward is +Z has its RIGHT along -X, so "+X is left".
 *   - therefore a POSITIVE `input.steer` (which produces a positive steer angle
 *     and a positive yaw rate) is a LEFT turn. To turn right we send negative.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * LONGITUDINAL — IDM against a set of constraints
 * ────────────────────────────────────────────────────────────────────────────
 *   a = A * (1 - (v/v0)^4)            free road
 *   a -= A * (s*(v,dv) / s)^2         per obstruction
 *   s* = s0 + max(0, v*T + v*dv / (2*sqrt(A*B)))
 * The obstruction set is: the real leader in our lane; a virtual stationary
 * leader at the stop line of a red light or an unclaimed junction; the corner
 * ahead (as a speed target folded into v0 by a braking-distance profile); and
 * anything the player has just done. Taking the minimum of the IDM terms is
 * what makes queues form behind a light and dissolve in order when it changes,
 * rather than every car launching at once.
 */

import * as THREE from 'three';
import { TUNE, clamp, clamp01, wrapPi } from './tune.js';

/** Ring capacity for the path ahead. ~8 links is 300 m of city street. */
const LINKS = 10;
/** How much path to keep queued ahead of the car. */
const HORIZON = 210;
/** Path sample distances used for the neighbour corridor test. */
const SAMPLES = [0, 8, 18, 30, 44, 60];

const STATE = {
  DRIVE: 'drive',
  PULLOUT: 'pullout',
  PULLOVER: 'pullover',
  FLEE: 'flee',
  BAIL: 'bail',
  /** Backing out of somewhere we should not have driven into. */
  RECOVER: 'recover',
  DEAD: 'dead',
};

/** How long a reverse-out manoeuvre may run before we give up on it. */
const RECOVER_TIME = 1.8;
/** How far back it tries to go. */
const RECOVER_DIST = 5.5;
/** Clearance needed behind before reversing is even considered. */
const RECOVER_CLEAR = 8.5;

export class Driver {
  constructor(sys, id) {
    this.sys = sys;
    this.id = id;
    this.vehicle = null;
    this.active = false;
    this.state = STATE.DRIVE;

    // ---- path ring -------------------------------------------------------
    this._le = new Int32Array(LINKS);
    this._ll = new Int32Array(LINKS);
    this._llen = new Float32Array(LINKS);
    this._head = 0;
    this._count = 0;
    this._s = 0;
    this._lat = 0;
    this._latPrev = 0;
    this._proj = { s: 0, lateral: 0 };

    // ---- lateral state ---------------------------------------------------
    this._steerCmd = 0;
    this._laneBlend = 0;
    this._laneCool = 0;
    this._swerve = 0;
    this._bias = 0;

    // ---- longitudinal ----------------------------------------------------
    this.speedFactor = 1;
    this.aggression = 0.5;
    this.patience = 1;
    this._throttle = 0;
    this._brake = 0;
    this._handbrake = false;

    // ---- junction --------------------------------------------------------
    this._claimNode = -1;
    this._stopDist = Infinity;
    this._stopReason = '';
    this._approachCap = Infinity;

    // ---- behaviour timers ------------------------------------------------
    this._stuck = 0;
    this._offroad = 0;
    this._stall = 0;
    this._excused = true;
    this._progTimer = 0;
    this._consumed = 0;
    this._markOdo = 0;
    this._hornCool = 0;
    this._fear = 0;
    this._pullTimer = 0;
    this._bailTimer = 0;
    this._reroute = 0;
    this._recoverTimer = 0;
    this._recoverCool = 0;
    this._recoverX = 0;
    this._recoverZ = 0;
    this.indicate = 0;
    this._indicatePhase = 0;

    // ---- diagnostics the harness reads -----------------------------------
    this.diag = {
      lat: 0, targetSpeed: 0, gap: Infinity, dv: 0, reason: 'free',
      curve: Infinity, stop: Infinity, steer: 0, accel: 0,
    };

    // ---- scratch ---------------------------------------------------------
    this._look = new THREE.Vector3();
    this._pt = new THREE.Vector3();
    this._px = new Float32Array(SAMPLES.length);
    this._pz = new Float32Array(SAMPLES.length);
    this._pd = new Float32Array(SAMPLES.length);
    this._q = { arc: 0, lat: 0, signed: 0 };
    this._static = { arc: Infinity, lat: 0, need: 0, v: null };
    this._avoid = 0;
    this._oncoming = 0;
    this._wall = Infinity;
    this._wallTime = 0;
    this._squeeze = Infinity;
    this._badLink = 0;
    this._wrongLink = 0;
    this._trueOff = 0;
    this._lead = { gap: Infinity, dv: 0, v: null, speed: 0 };
    this._hazard = { ttc: Infinity, v: null, headOn: false, side: 0 };
    this._input = { throttle: 0, brake: 0, steer: 0, handbrake: false };
  }

  /* ==================================================================== */
  /* Lifecycle                                                            */
  /* ==================================================================== */

  /** Bind to a freshly spawned vehicle sitting on (edge, lane) at `s`. */
  bind(vehicle, edge, lane, s, rng) {
    this.vehicle = vehicle;
    this.active = true;
    this.state = STATE.DRIVE;
    this._head = 0;
    this._count = 0;
    this._s = clamp(s, 0, edge.len);
    this._lat = 0;
    this._latPrev = 0;
    this._steerCmd = 0;
    this._laneBlend = 0;
    this._laneCool = rng.range(0, TUNE.laneChangeCool);
    this._swerve = 0;
    this._avoid = 0;
    this._wall = Infinity;
    this._wallTime = 0;
    this._squeeze = Infinity;
    this._badLink = 0;
    this._wrongLink = 0;
    this._trueOff = 0;
    this._bias = rng.range(-0.18, 0.18);
    this._stuck = 0;
    this._offroad = 0;
    this._stall = 0;
    this._progTimer = 0;
    this._consumed = 0;
    this._markOdo = this._s;
    this._hornCool = rng.range(0, 1.5);
    this._fear = 0;
    this._pullTimer = 0;
    this._bailTimer = 0;
    this._reroute = 0;
    this._recoverTimer = 0;
    this._recoverCool = 0;
    this._claimNode = -1;
    this.indicate = 0;
    this._indicatePhase = rng.float() * 6.28;
    // Personality. A street where every car holds exactly the limit reads as a
    // conveyor belt; the spread is what makes overtaking happen at all.
    this.speedFactor = clamp(0.88 + rng.gauss() * 0.09, 0.66, 1.16);
    this.aggression = clamp01(0.5 + rng.gauss() * 0.24);
    this.patience = clamp(1 + rng.gauss() * 0.25, 0.5, 1.6);
    this._push(edge, lane);
    this._ensureLinks(rng);
    return this;
  }

  release() {
    if (this._claimNode >= 0) this.sys.signals.release(this._claimNode, this.id);
    this._claimNode = -1;
    this.vehicle = null;
    this.active = false;
    this.state = STATE.DEAD;
    this._count = 0;
  }

  /* ==================================================================== */
  /* Path ring                                                            */
  /* ==================================================================== */

  _push(edge, lane) {
    if (this._count >= LINKS) return false;
    const slot = (this._head + this._count) % LINKS;
    this._le[slot] = edge.id;
    this._ll[slot] = lane;
    this._llen[slot] = edge.len;
    this._count++;
    return true;
  }

  _slot(i) {
    return (this._head + i) % LINKS;
  }

  _edge(i) {
    return this.sys.lanes.roads.edges[this._le[this._slot(i)]];
  }

  _lane(i) {
    return this._ll[this._slot(i)];
  }

  /** Metres of path queued ahead of the car. */
  _ahead() {
    let d = -this._s;
    for (let i = 0; i < this._count; i++) d += this._llen[this._slot(i)];
    return d;
  }

  _ensureLinks(rng) {
    const L = this.sys.lanes;
    let guard = 0;
    while (this._count < LINKS && this._ahead() < HORIZON && guard++ < LINKS) {
      const i = this._count - 1;
      if (i < 0) return false;
      const e = this._edge(i);
      const lane = this._lane(i);
      const node = L.toNode(e, lane);
      const nxt = L.successor(e, lane, node, rng);
      if (!nxt) return false;
      this._push(nxt.edge, nxt.lane);
    }
    return true;
  }

  /** World point `d` metres ahead along the path, offset `lateral` to the right. */
  _pointAt(d, lateral, out) {
    const L = this.sys.lanes;
    let rem = this._s + d;
    for (let i = 0; i < this._count; i++) {
      const len = this._llen[this._slot(i)];
      if (rem <= len || i === this._count - 1) {
        return L.point(this._edge(i), this._lane(i), rem, lateral, out);
      }
      rem -= len;
    }
    return out.set(0, 0, 0);
  }

  /** Re-project onto the path and consume links the car has driven past. */
  _syncPath() {
    const L = this.sys.lanes;
    const p = this.vehicle.position;
    /**
     * At most ONE link handover per control tick. At 60 Hz no car crosses two
     * junctions in 16 ms, so consuming several in one pass only ever happens
     * when the projection has gone degenerate — and when it does, the driver
     * skips its route several blocks forward and its lookahead lands somewhere
     * it has never been.
     */
    /**
     * The loop must ALWAYS get one more pass after a handover, because the
     * pass that consumes a link leaves `_proj` holding the OLD link's
     * projection — and `_s` / `_lat` are read from it below. Capping the loop
     * at two iterations skipped that re-projection, so every junction left the
     * driver with a station-keeping error of a whole block for a tick, which
     * immediately triggered another handover. Three: advance, re-project, out.
     */
    let guard = 0;
    while (this._count > 0 && guard++ < 3) {
      const e = this._edge(0);
      const lane = this._lane(0);
      L.project(e, lane, p.x, p.z, this._proj);
      const len = this._llen[this._slot(0)];
      let advance = this._proj.s >= len - 0.05;
      /**
       * Around a corner the old link's projection lags behind where the car
       * physically is, so also hand over as soon as the NEXT link fits us
       * better. The window has to be an absolute distance from the junction,
       * not a fraction of the link: as a fraction (len * 0.55) a 200 m edge
       * started testing 90 m out, a near-parallel bend won the lateral
       * comparison, and the driver jumped to a link whose start was 90 m
       * BEHIND it. Its lookahead then pointed off the road and it drove there.
       */
      if (!advance && this._count > 1 && len - this._proj.s < 9) {
        const e2 = this._edge(1);
        const l2 = this._lane(1);
        const cur = Math.abs(this._proj.lateral);
        const s0 = this._proj.s;
        L.project(e2, l2, p.x, p.z, this._proj);
        if (this._proj.s >= -1 && Math.abs(this._proj.lateral) < cur - 0.25) advance = true;
        else {
          this._proj.s = s0;
          L.project(e, lane, p.x, p.z, this._proj);
        }
      }
      if (advance && this._count > 1) {
        this._consumed += len;
        this._onPassNode(L.toNode(e, lane));
        this._head = (this._head + 1) % LINKS;
        this._count--;
        continue;
      }
      break;
    }
    this._s = clamp(this._proj.s, -8, this._llen[this._slot(0)] + 8);
    /**
     * Sanity-check the link we think we are on. A lane projection is onto an
     * INFINITE line, so a bridge deck eighteen metres overhead, or a parallel
     * street one block over, can report a perfectly plausible `s` and a
     * lateral error of a hundred metres. Height is the cheap discriminator:
     * if the lane we believe we are driving is not at our altitude, the belief
     * is wrong and no amount of steering will fix it.
     */
    const py = this._pathY();
    if (Number.isFinite(py) && Math.abs(py - this.vehicle.position.y) > 5.5) {
      this._badLink += 1;
      if (this._badLink > 6) {
        this._badLink = 0;
        if (!this.sys.reseat(this)) this.sys.recycle(this, 'lostlink');
        return;
      }
    } else {
      this._badLink = 0;
    }
    const raw = this._proj.lateral;
    this._latPrev = this._lat;
    this._lat = raw - this._laneBlend - this._avoid;
  }

  _onPassNode(nodeId) {
    if (this._claimNode === nodeId) {
      this.sys.signals.release(nodeId, this.id);
      this._claimNode = -1;
    }
    const st = this.sys.stats;
    st.linkPasses++;
    const node = this.sys.lanes.roads.nodes[nodeId];
    if (node && node.links.length > 2) st.junctionPasses++;
  }

  /* ==================================================================== */
  /* Sensing                                                              */
  /* ==================================================================== */

  /** Sample the path into a polyline used for the "is it in my lane" test. */
  _samplePath() {
    for (let i = 0; i < SAMPLES.length; i++) {
      this._pointAt(SAMPLES[i], this._laneBlend + this._swerve + this._avoid, this._pt);
      this._px[i] = this._pt.x;
      this._pz[i] = this._pt.z;
      this._pd[i] = SAMPLES[i];
    }
  }

  /**
   * Nearest point on the sampled path to (x,z): arc length, unsigned distance,
   * and the SIGNED offset (positive = to the driver's right of the path). The
   * sign is what lets a driver decide which way to go round something.
   */
  _pathQuery(x, z, out) {
    let bestD2 = Infinity;
    let bestArc = 0;
    let bestSign = 1;
    for (let i = 0; i < SAMPLES.length - 1; i++) {
      const ax = this._px[i];
      const az = this._pz[i];
      const bx = this._px[i + 1];
      const bz = this._pz[i + 1];
      const dx = bx - ax;
      const dz = bz - az;
      const l2 = dx * dx + dz * dz;
      let t = l2 > 1e-6 ? ((x - ax) * dx + (z - az) * dz) / l2 : 0;
      t = t < 0 ? 0 : t > 1 ? 1 : t;
      const qx = x - (ax + dx * t);
      const qz = z - (az + dz * t);
      const d2 = qx * qx + qz * qz;
      if (d2 < bestD2) {
        bestD2 = d2;
        bestArc = this._pd[i] + (this._pd[i + 1] - this._pd[i]) * t;
        // right-of-travel for a +Z-forward heading (dx,dz) is (-dz, dx)
        bestSign = -dz * qx + dx * qz >= 0 ? 1 : -1;
      }
    }
    out.arc = bestArc;
    out.lat = Math.sqrt(bestD2);
    out.signed = out.lat * bestSign;
    return out;
  }

  /**
   * Find the car we are following and anything about to hit us.
   * `fx,fz` is our forward; `hw,hl` our half width and length.
   */
  _sense(ctx) {
    const v = this.vehicle;
    const sys = this.sys;
    const grid = sys.grid;
    const lead = this._lead;
    const hz = this._hazard;
    lead.gap = Infinity;
    lead.dv = 0;
    lead.v = null;
    lead.speed = 0;
    hz.ttc = Infinity;
    hz.req = 0;
    hz.v = null;
    hz.headOn = false;
    hz.side = 0;
    const stat = this._static;
    stat.arc = Infinity;
    stat.v = null;
    this._oncoming = Infinity;

    const q = v.quaternion;
    const fx = 2 * (q.x * q.z + q.w * q.y);
    const fz = 1 - 2 * (q.x * q.x + q.y * q.y);
    const hw = v.spec.half.x;
    const hl = v.spec.half.z;
    const myV = v.forwardSpeed;
    const edgeLaneW = this._count > 0 ? this._edge(0).laneWidth : 3.4;
    // right-of-forward for a +Z-forward body is (-fz, fx)
    const rx2 = -fz;
    const rz2 = fx;

    const n = grid.query(v.position.x, v.position.z, 52, v);
    for (let i = 0; i < n; i++) {
      const o = grid.list[grid.hits[i]];
      const rx = o.position.x - v.position.x;
      const rz = o.position.z - v.position.z;
      const ahead = rx * fx + rz * fz;
      if (ahead < -3) continue;
      if (Math.abs(o.position.y - v.position.y) > 7) continue; // a bridge overhead
      this._pathQuery(o.position.x, o.position.z, this._q);
      /**
       * The corridor half-width. This number is load-bearing: on a two-lane
       * street the ONCOMING lane centre is only 3.35 m from ours, so a
       * generous corridor makes every car panic-brake at every car it passes.
       * Keep it just wider than two half-widths and let the predictive test
       * below catch anything that is actually coming at us.
       */
      const clear = hw + o.spec.half.x + 0.2;
      const arc = this._q.arc;
      const lat = this._q.lat;
      if (lat > clear + 4.5) continue;
      const oq = o.quaternion;
      const ofx = 2 * (oq.x * oq.z + oq.w * oq.y);
      const ofz = 1 - 2 * (oq.x * oq.x + oq.y * oq.y);
      const facing = ofx * fx + ofz * fz;
      const theirV = o.velocity.x * fx + o.velocity.z * fz; // closing along OUR axis

      if (lat < clear && arc > 0.05) {
        const gap = Math.max(0.1, arc - hl - o.spec.half.z);
        if (gap < lead.gap) {
          lead.gap = gap;
          lead.v = o;
          lead.speed = theirV;
          lead.dv = myV - theirV;
        }
      }
      /**
       * CLOSE RANGE IS TESTED IN BODY SPACE, NOT AGAINST THE PATH.
       *
       * The planned path can be clear of a parked car while the CAR is not:
       * planning a 1.5 m lateral shift five metres before the obstacle does
       * not move the bodywork 1.5 m in five metres. Cars were driving into
       * parked cars, then sitting there at 89% throttle with the tyres
       * spinning, because the corridor test said the way was clear. Within
       * ~16 m, where the car cannot turn much anyway, what matters is what is
       * in front of the bumper.
       */
      if (ahead > 0 && ahead < 16) {
        const bodyLat = Math.abs(rx * rx2 + rz * rz2);
        // A STATIC car gets a wider berth than a moving one: it will not move
        // out of the way, we are the only one with a say in the outcome, and
        // grazing a parked car down its flank is the single most visible
        // failure this system can produce.
        const bodyClear = o.speed < 0.6 && !this.sys.driverOf(o) ? clear + 0.4 : clear;
        if (bodyLat < bodyClear) {
          const gap = Math.max(0.1, ahead - hl - o.spec.half.z);
          if (gap < lead.gap) {
            lead.gap = gap;
            lead.v = o;
            lead.speed = theirV;
            lead.dv = myV - theirV;
          }
        }
      }
      /**
       * A STATIC obstruction sitting in the lane — `props` parks its kerb
       * dressing half a lane inside the carriageway, which on a two-lane
       * street overlaps the running lane by a metre. Traffic that treats that
       * as a wall queues behind it forever; traffic that ignores it drives
       * through it. Real traffic pulls out and goes round, giving way to
       * oncoming first. Record it here, plan the offset in _avoidStatic().
       */
      if (o.speed < 0.6 && !this.sys.driverOf(o) && arc > 0.05 && arc < 46 &&
          lat < clear + 2.2 && arc < stat.arc) {
        stat.arc = arc;
        stat.lat = this._q.signed;
        stat.need = clear + 0.85;
        stat.v = o;
      }
      // How far away the nearest genuinely oncoming car is: the gate on
      // whether we may borrow the other side of the road to get past.
      if (facing < -0.3 && o.speed > 1.5 && ahead > 0 && lat < clear + edgeLaneW) {
        const d = ahead - hl - o.spec.half.z;
        if (d < this._oncoming) this._oncoming = d;
      }
      /**
       * Predictive: where will it BE in 0.55 s? That is what separates "a car
       * cutting across my nose", which is an emergency, from "a car in the
       * opposite lane", which is Tuesday. Testing current positions against a
       * wide corridor cannot tell those apart.
       */
      if (ahead > 0 && (lat < clear + 4.5)) {
        const px = o.position.x + o.velocity.x * 0.55;
        const pz = o.position.z + o.velocity.z * 0.55;
        this._pathQuery(px, pz, this._q);
        if (this._q.lat < clear + 0.35) {
          const closing = myV - theirV;
          if (closing > 0.4) {
            const gap = Math.max(0.1, Math.min(arc, this._q.arc) - hl - o.spec.half.z);
            const ttc = gap / closing;
            const req = (closing * closing) / (2 * Math.max(0.6, gap - TUNE.idmS0));
            if (req > hz.req) {
              hz.ttc = ttc;
              hz.req = req;
              hz.v = o;
              hz.headOn = facing < -0.35 && o.speed > 1.5;
              hz.side = Math.sign(-rx * fz + rz * fx) || 1;
            }
          }
        }
      }
    }

    // The player on foot standing in the road is also an obstruction.
    const player = sys.player(ctx);
    if (player && !sys.playerVehicle(ctx)) {
      const rx = player.x - v.position.x;
      const rz = player.z - v.position.z;
      const ahead = rx * fx + rz * fz;
      if (ahead > 0 && ahead < 34) {
        this._pathQuery(player.x, player.z, this._q);
        if (this._q.lat < hw + 1.1) {
          const gap = Math.max(0.1, this._q.arc - hl - 0.4);
          if (gap < lead.gap) {
            lead.gap = gap;
            lead.v = null;
            lead.speed = 0;
            lead.dv = myV;
          }
          const req = (myV * myV) / (2 * Math.max(0.6, gap - TUNE.idmS0));
          if (req > hz.req) {
            hz.ttc = myV > 0.4 ? gap / myV : Infinity;
            hz.req = req;
            hz.v = null;
            hz.headOn = false;
            hz.side = Math.sign(-rx * fz + rz * fx) || 1;
          }
        }
      }
    }
  }

  /* ==================================================================== */
  /* Planning                                                             */
  /* ==================================================================== */

  /**
   * Speed the path allows: the current limit, then every corner and speed-limit
   * step inside the horizon converted back to a speed we may hold NOW via
   * v^2 = vc^2 + 2*b*d. Taking the minimum gives brake-in / accelerate-out for
   * free, with no explicit "am I in a corner" state.
   */
  _pathSpeed() {
    const L = this.sys.lanes;
    const e0 = this._edge(0);
    let v0 = L.limit(e0) * this.speedFactor;
    let best = v0;
    let d = this._llen[this._slot(0)] - this._s;
    let curve = Infinity;
    for (let i = 0; i + 1 < this._count && d < TUNE.cornerHorizon; i++) {
      const a = this._edge(i);
      const la = this._lane(i);
      const b = this._edge(i + 1);
      const lb = this._lane(i + 1);
      const turn = Math.abs(wrapPi(L.yaw(b, lb) - L.yaw(a, la)));
      let vc = L.limit(b) * this.speedFactor;
      if (turn > 0.11) {
        // Radius the lane geometry actually offers through the junction.
        const R = Math.max(4.5, (a.laneWidth * 2.15) / Math.tan(Math.min(1.45, turn * 0.5)));
        vc = Math.min(vc, Math.max(TUNE.cornerMin, Math.sqrt(TUNE.cornerLat * R)));
      }
      if (vc < curve) curve = vc;
      const allow = Math.sqrt(vc * vc + 2 * TUNE.cornerBrake * Math.max(0, d));
      if (allow < best) best = allow;
      d += this._llen[this._slot(i + 1)];
    }
    this.diag.curve = curve;
    return Math.max(1.5, best);
  }

  /**
   * Where — if anywhere — we must come to a stop, and why. Handles signals,
   * unsignalised reservations and anti-gridlock.
   */
  _junction(ctx, v) {
    this._stopDist = Infinity;
    this._stopReason = '';
    this._approachCap = Infinity;
    if (this._count < 1) return;
    const L = this.sys.lanes;
    const sig = this.sys.signals;
    const e = this._edge(0);
    const lane = this._lane(0);
    const nodeId = L.toNode(e, lane);
    const node = L.roads.nodes[nodeId];
    if (!node) return;
    const d = this._llen[this._slot(0)] - this._s - TUNE.stopSetback;

    // Past the line: we are in the box and we own it until we clear it.
    if (d < -1.5) return;
    if (d > 40) return;
    if (node.links.length < 3) return; // a bend, not a junction

    const speed = Math.max(0, v.forwardSpeed);
    const phase = sig.phaseFor(nodeId, e.id);
    /**
     * Anti-gridlock only applies BEFORE the stop line. Past it the car is
     * already in the box and the only correct thing to do is clear it —
     * braking there is what a deadlock is. Measured: one car stopped 30 cm
     * past the line with reason 'gridlock' held a junction for 71 seconds.
     */
    const blocked = d > 1.5 && this._blockedBeyond(d, nodeId);

    if (phase) {
      if (phase === 'green') {
        // Anti-gridlock: never enter a box you cannot clear.
        if (blocked) {
          this._stopDist = d;
          this._stopReason = 'gridlock';
        }
        return;
      }
      if (phase === 'amber') {
        // Run the amber only if stopping would be violent.
        const need = d > 0.2 ? (speed * speed) / (2 * d) : 99;
        if (need > TUNE.amberRunDecel * (0.8 + this.aggression * 0.6) && !blocked) return;
      }
      this._stopDist = d;
      this._stopReason = 'light';
      return;
    }

    // Unsignalised: reserve the box. We already hold it -> go.
    if (this._claimNode === nodeId && sig.holds(nodeId, this.id)) {
      if (blocked) {
        this._stopDist = d;
        this._stopReason = 'gridlock';
      }
      return;
    }
    // An unsignalised junction is approached slowly whether or not we end up
    // stopping — which is both what a driver does and what makes the stop
    // achievable without standing the car on its nose.
    this._approachCap = Math.min(this._approachCap, 8.5 + d * 0.22);
    if (blocked) {
      this._stopDist = d;
      this._stopReason = 'gridlock';
      return;
    }
    // Only ASK when we could actually use the box. Otherwise a car queueing
    // 20 m back holds the junction shut against the cross street for as long
    // as the queue lasts.
    if (d > 22) return;
    if (this._crossTrafficNear(nodeId, node)) {
      this._stopDist = d;
      this._stopReason = 'giveway';
      return;
    }
    if (sig.claim(nodeId, this.id, L.rank(e))) {
      if (this._claimNode >= 0 && this._claimNode !== nodeId) {
        sig.release(this._claimNode, this.id);
      }
      this._claimNode = nodeId;
      return;
    }
    this._stopDist = d;
    this._stopReason = 'giveway';
  }

  /** True when our leader is stopped so close beyond the junction we would block it. */
  _blockedBeyond(d, nodeId) {
    const lead = this._lead;
    if (!lead.v && lead.gap === Infinity) return false;
    if (lead.speed > 1.6) return false;
    const need = d + TUNE.boxRadius + this.vehicle.spec.half.z * 2 + 1.5;
    return lead.gap < need;
  }

  /**
   * Vehicles that are not AI drivers (the player, a cruiser under `police`)
   * never take a reservation, so an unsignalised junction also has to look.
   */
  _crossTrafficNear(nodeId, node) {
    const grid = this.sys.grid;
    const n = grid.query(node.x, node.z, 17, this.vehicle);
    for (let i = 0; i < n; i++) {
      const o = grid.list[grid.hits[i]];
      if (this.sys.driverOf(o)) continue; // an AI car; the claim covers it
      if (o.speed < 1.4) continue;
      const dx = node.x - o.position.x;
      const dz = node.z - o.position.z;
      const l = Math.hypot(dx, dz) || 1;
      if ((o.velocity.x * dx + o.velocity.z * dz) / l > 1.2) return true;
    }
    return false;
  }

  /* ==================================================================== */
  /* Lane discipline                                                      */
  /* ==================================================================== */

  /**
   * MOBIL-lite. Change lane when the car in front is materially slower and the
   * target lane is genuinely clear; drift back toward the kerb otherwise. Both
   * halves matter — a system that only overtakes ends up with every car in the
   * inside lane, which reads as badly as no lane discipline at all.
   */
  _laneChange(dt, v) {
    this._laneCool -= dt;
    const L = this.sys.lanes;
    const e = this._edge(0);
    const lane = this._lane(0);
    const dir = L.laneDir(e, lane);
    const lo = L.laneLo(e, dir);
    const hi = L.laneHi(e, dir);
    if (hi <= lo || this._laneCool > 0) return;
    const remaining = this._llen[this._slot(0)] - this._s;
    if (remaining < 45 || v.forwardSpeed < 4) return;

    const lead = this._lead;
    const desired = this.diag.targetSpeed;
    const slow = lead.gap < 42 && lead.speed < desired - TUNE.overtakeGain;
    let want = lane;
    if (slow && lane > lo) want = lane - 1; // inside lane to overtake
    else if (!slow && lane < hi) want = lane + 1; // keep right
    if (want === lane) return;

    if (!this._laneClear(e, want, v)) return;
    const from = L.laneOffset(e, lane) * dir;
    const to = L.laneOffset(e, want) * dir;
    this._ll[this._slot(0)] = want;
    this._laneBlend += from - to;
    this._laneCool = TUNE.laneChangeCool * (slow ? 0.6 : 1.4);
    this.indicate = Math.max(this.indicate, 1.6);
    this.sys.stats.laneChanges++;
  }

  /** Is there room in `lane` right now? */
  _laneClear(edge, lane, v) {
    const L = this.sys.lanes;
    const grid = this.sys.grid;
    const n = grid.query(v.position.x, v.position.z, 46, v);
    const myS = this._s;
    for (let i = 0; i < n; i++) {
      const o = grid.list[grid.hits[i]];
      const od = this.sys.driverOf(o);
      // Only cars on this very edge matter for the gap test.
      L.project(edge, lane, o.position.x, o.position.z, this._proj);
      if (Math.abs(this._proj.lateral) > edge.laneWidth * 0.75) continue;
      const rel = this._proj.s - myS;
      const need = rel >= 0 ? TUNE.laneChangeAhead : TUNE.laneChangeBack;
      if (Math.abs(rel) < need + o.spec.half.z + v.spec.half.z) return false;
      if (od && rel < 0 && rel > -34 && o.forwardSpeed > v.forwardSpeed + 5) return false;
    }
    return true;
  }

  /* ==================================================================== */
  /* Reactions                                                            */
  /* ==================================================================== */

  /**
   * Something frightening happened nearby. 0..1.
   *
   * `allowFlee` is the difference between violence and a fender-bender. Only
   * gunfire and explosions make a civilian abandon the rules; letting a
   * shunt do it produced a runaway feedback loop at high density — a bump put
   * both drivers into FLEE, FLEE raises their desired speed by 35%, and the
   * faster traffic bumped into more of itself until the whole street was
   * fleeing and writing itself off.
   */
  scare(amount, allowFlee = true) {
    this._fear = clamp01(this._fear + amount);
    if (!allowFlee) {
      if (this._fear > 0.42) this._fear = 0.42;
      return;
    }
    if (this._fear > 0.85 && this.state === STATE.DRIVE) {
      this.state = this.sys.rng.float() < 0.45 ? STATE.BAIL : STATE.FLEE;
      this._bailTimer = 0;
    } else if (this._fear > 0.45 && this.state === STATE.DRIVE) {
      this.state = STATE.FLEE;
    }
  }

  /** A siren is close: get out of the way. */
  yieldToSiren() {
    if (this.state === STATE.DRIVE || this.state === STATE.PULLOVER) {
      this.state = STATE.PULLOVER;
      this._pullTimer = 3.5;
    }
  }

  /**
   * FORWARD CLEARANCE AGAINST THE STATIC WORLD.
   *
   * The road graph is not a promise that the road is clear: measured in
   * Lawrenceville, cars sat on their own lane at 89% throttle with a building
   * collider 60 cm off the bumper, because nothing in a vehicle-to-vehicle
   * sensor model can see a wall. One ray per car at 15 Hz, aimed down the
   * PATH rather than down the heading (so it does not hit the building
   * opposite every time we approach a corner), and anything solid and roughly
   * vertical becomes a stationary obstruction for the IDM.
   *
   * This is also what stops a driver ploughing into whatever `props`,
   * `buildings` or a mission script decides to put on the carriageway later.
   */
  _probeAhead(v) {
    const phys = this.sys.physics;
    if (!phys?.raycast) { this._wall = Infinity; return; }
    const hl = v.spec.half.z;
    /**
     * Short reach on purpose. The probe is a STRAIGHT line and the path is
     * not: aimed twenty-five metres down a curving street it goes clean
     * through the building on the outside of the bend, and every car in the
     * city decides its route is walled. Fourteen metres is close enough to
     * straight, and still gives 3.6 m/s^2 of braking from 10 m/s.
     */
    const reach = clamp(6 + Math.abs(v.forwardSpeed) * 0.9, 6, 14);
    this._pointAt(reach, this._avoid + this._laneBlend, this._pt);
    let dx = this._pt.x - v.position.x;
    let dz = this._pt.z - v.position.z;
    const l = Math.hypot(dx, dz);
    if (l < 0.5) { this._wall = Infinity; return; }
    dx /= l;
    dz /= l;
    // Bumper height above the road, so the road surface itself is never a hit.
    const y = v.position.y - v.spec.comY + 0.55;
    // Three rays across the width: a single centre ray walks straight past a
    // bollard or a wall corner that the front wing is about to hit.
    const rx = -dz;
    const rz = dx;
    let best = Infinity;
    for (let i = -1; i <= 1; i++) {
      const ox = v.position.x + rx * i * v.spec.half.x * 0.8;
      const oz = v.position.z + rz * i * v.spec.half.x * 0.8;
      const h = phys.raycast(ox, y, oz, dx, 0, dz, reach, phys.MASK.WORLD);
      // Only roughly vertical faces count; a rising road or a ramp is not a wall.
      if (h.hit && Math.abs(h.normal.y) < 0.65) {
        // ...and confirm the thing we hit is actually ON the path. A wall
        // beside the road is scenery; a wall across it is a problem.
        this._pathQuery(h.point.x, h.point.z, this._q);
        if (this._q.lat > v.spec.half.x + 1.0) continue;
        const d = Math.max(0.15, h.distance - hl);
        if (d < best) best = d;
      }
    }
    this._wall = best;
  }

  /**
   * Plan a lateral offset that clears a parked car standing in our lane.
   *
   * The offset is always to the LEFT, because kerb parking is on the right.
   * Crossing the centreline to do it is allowed — that is what a driver does
   * on a narrow street — but only when nothing is coming the other way. When
   * it is not allowed the offset stays small, the parked car remains an IDM
   * leader, and we queue behind it and wait. That single rule is the whole
   * "traffic copes with a badly parked car" behaviour.
   */
  _avoidStatic(dt, v) {
    const stat = this._static;
    let want = 0;
    this._squeeze = Infinity;
    if (stat.v && stat.arc < 42) {
      /**
       * `stat.lat` is measured against the ALREADY-shifted path, so it has to
       * be un-shifted before it can be used as a target. Using it directly is
       * a feedback loop that eats itself: shift left, the obstacle now reads as
       * clear, the target collapses to zero, the car drifts back into it, and
       * it ends up parked behind a parked car forever.
       */
      const rel = stat.lat + this._avoid;
      if (Math.abs(rel) < stat.need) {
        want = rel - stat.need; // negative: shift left until it clears
        const L = this.sys.lanes;
        const e = this._edge(0);
        const lane = this._lane(0);
        const dir = L.laneDir(e, lane);
        const maxLeft = e.laneWidth * 1.2;
        if (want < -maxLeft) want = -maxLeft;
        // Would this put us over the centreline into opposing traffic?
        const centreOffset = L.laneOffset(e, lane) * dir; // >0, we sit right of it
        const overLine = centreOffset + want - v.spec.half.x < 0.25;
        const oneway = e.oneway || L.laneCount(e, dir) === e.lanes;
        if (overLine && !oneway) {
          const room = Math.max(18, stat.arc + 26 + v.forwardSpeed * 1.6);
          if (this._oncoming < room) {
            // Not safe. Tuck in as far as the centreline and let IDM queue.
            want = Math.min(0, 0.25 + v.spec.half.x - centreOffset);
          }
        }
      }
    }
    /**
     * While the manoeuvre is still IN PROGRESS the obstacle is not yet clear,
     * whatever the planned path says. Publish the distance so the longitudinal
     * controller slows down to squeeze past instead of committing to a line
     * the car has not reached yet — which is how a van ends up wearing a
     * parked coupe down its flank.
     */
    this._squeeze = Math.abs(want - this._avoid) > 0.25 ? stat.arc : Infinity;

    // Ease on quickly, ease off gently, so the line reads as a deliberate
    // manoeuvre rather than a twitch.
    const k = Math.min(1, dt * (want < this._avoid ? 4.5 : 1.1));
    this._avoid += (want - this._avoid) * k;
    if (Math.abs(this._avoid) < 0.02) this._avoid = 0;
    if (this._avoid < -0.35) this.indicate = Math.max(this.indicate, 0.25);
  }

  /**
   * Steer away from something that is about to hit us. The offset feeds the
   * pure-pursuit target, so the swerve is a real path deviation the tyres have
   * to work for — not a teleport sideways — and it decays back to the lane.
   */
  _evade(dt) {
    const hz = this._hazard;
    let want = 0;
    if (hz.req > TUNE.hornDecel && hz.headOn) {
      // Head-on: go for the kerb, hard, in proportion to how bad it is.
      want = TUNE.swerveMax * clamp01((hz.req - TUNE.hornDecel) / 4.0);
    } else if (hz.req > TUNE.panicDecel) {
      // Otherwise duck the other way from wherever it is.
      want = -hz.side * TUNE.swerveMax * 0.55 * clamp01((hz.req - TUNE.panicDecel) / 4.0);
    }
    const k = Math.min(1, dt * (want !== 0 ? 4.5 : 2.0));
    this._swerve += (want - this._swerve) * k;
    if (Math.abs(this._swerve) < 0.01) this._swerve = 0;
  }

  _horn(ctx, level = 1) {
    if (this._hornCool > 0) return;
    this._hornCool = TUNE.hornCooldown * (1.4 - this.aggression * 0.7);
    this.sys.horn(ctx, this.vehicle, level);
  }

  /* ==================================================================== */
  /* Frame                                                                */
  /* ==================================================================== */

  update(dt, ctx) {
    const v = this.vehicle;
    if (!v || !this.active) return;

    if (v.destroyed) {
      this._input.throttle = 0;
      this._input.brake = 1;
      this._input.steer = 0;
      this._input.handbrake = true;
      this.sys.vehicles.setInput(v, this._input);
      this.sys.abandon(this, ctx);
      return;
    }

    this._hornCool -= dt;
    this._fear = Math.max(0, this._fear - dt * 0.34);
    this._recoverCool = Math.max(0, this._recoverCool - dt);
    this.indicate = Math.max(0, this.indicate - dt);
    this._indicatePhase += dt * 5.2;

    if (!this._reseatIfNeeded()) return;

    this._syncPath();
    this._ensureLinks(this.sys.rng);
    if (this._count === 0) return;

    // Lane blend decays; that IS the lane change animation.
    if (this._laneBlend !== 0) {
      const step = (dt / TUNE.laneChangeTime) * 4.2;
      this._laneBlend -= Math.sign(this._laneBlend) * Math.min(Math.abs(this._laneBlend), step);
      this.indicate = Math.max(this.indicate, 0.2);
    }

    this._samplePath();
    // 15 Hz, staggered across the fleet so the cost never lands on one tick.
    if ((this.sys.tick + this.id) % 4 === 0) this._probeAhead(v);
    // 2 Hz, likewise. One spatial-hash query per car per half second.
    if ((this.sys.tick + this.id) % 30 === 0) this._checkGround(v);
    this._sense(ctx);
    this._junction(ctx, v);
    this._avoidStatic(dt, v);
    this._evade(dt);
    if (this.state === STATE.DRIVE) this._laneChange(dt, v);

    const acc = this._longitudinal(dt, ctx, v);
    const steer = this._lateral(dt, v);

    this._input.throttle = this._throttle;
    this._input.brake = this._brake;
    this._input.steer = steer;
    this._input.handbrake = this._handbrake;
    this.sys.vehicles.setInput(v, this._input);

    this.diag.lat = this._lat;
    this.diag.steer = steer;
    this.diag.accel = acc;
    this.diag.gap = this._lead.gap;
    this.diag.dv = this._lead.dv;
    this.diag.stop = this._stopDist;

    this._health(dt, ctx, v);
  }

  /* ---------------------------------------------------- longitudinal -- */

  _longitudinal(dt, ctx, v) {
    const A = TUNE.idmA;
    const B = TUNE.idmB;
    if (this.state === STATE.RECOVER) return this._reverseOut(dt, v);
    const speed = Math.max(0, v.forwardSpeed);
    let v0 = this._pathSpeed();

    switch (this.state) {
      case STATE.FLEE:
        v0 *= 1.35;
        break;
      case STATE.PULLOVER:
        v0 = Math.min(v0, this._pullTimer > 0 ? 0.0 : 5);
        break;
      case STATE.PULLOUT:
        v0 = Math.min(v0, 7);
        break;
      case STATE.BAIL:
        v0 = 0;
        break;
      default:
        break;
    }
    // A wet road is a slower road.
    v0 *= this.sys.gripScale;
    if (this._approachCap < v0) v0 = this._approachCap;
    this.diag.targetSpeed = v0;

    const free = A * (1 - Math.pow(speed / Math.max(1.2, v0), TUNE.idmDelta));
    let acc = free;
    let reason = 'free';

    const lead = this._lead;
    if (lead.gap < 90) {
      const sStar =
        TUNE.idmS0 + Math.max(0, speed * TUNE.idmT + (speed * lead.dv) / (2 * Math.sqrt(A * B)));
      const term = free - A * (sStar / Math.max(0.35, lead.gap)) ** 2;
      if (term < acc) { acc = term; reason = 'follow'; }
    }

    // Squeezing past something parked in the lane: down to a walking pace by
    // the time we are alongside it.
    if (this._squeeze < 42) {
      const d = Math.max(0.4, this._squeeze);
      const vSq = 4.5;
      const allow = Math.sqrt(vSq * vSq + 2 * TUNE.cornerBrake * d);
      if (speed > allow) {
        const term = -Math.min(TUNE.brakeMax, (speed * speed - vSq * vSq) / (2 * d));
        if (term < acc) { acc = term; reason = 'squeeze'; }
      } else if (v0 > allow) {
        this.diag.targetSpeed = allow;
      }
    }

    // A wall, a bollard, a skip — anything solid on the carriageway.
    if (this._wall < 40) {
      const d = Math.max(0.25, this._wall);
      const sStar = TUNE.idmS0 + Math.max(0, speed * 0.9 + (speed * speed) / (2 * Math.sqrt(A * B)));
      const term = free - A * (sStar / d) ** 2;
      if (term < acc) { acc = term; reason = 'wall'; }
    }

    if (this._stopDist < 90) {
      const d = Math.max(0.25, this._stopDist);
      const sStar =
        TUNE.idmS0 * 0.7 +
        Math.max(0, speed * TUNE.idmT * 0.85 + (speed * speed) / (2 * Math.sqrt(A * B)));
      const term = free - A * (sStar / d) ** 2;
      if (term < acc) { acc = term; reason = this._stopReason; }
    }

    /**
     * EMERGENCY. The trigger is the deceleration the situation REQUIRES, not a
     * raw time-to-collision: at 8 m/s a 10 m gap is a 1.25 s TTC and also a
     * perfectly ordinary approach to a queue. Triggering on TTC alone had 400
     * panic stops in thirty seconds and every one of them was a car joining a
     * queue — which then caused the rear-end shunts it was trying to avoid.
     */
    const hz = this._hazard;
    const need = hz.req ?? 0;
    if (need > TUNE.panicDecel) {
      acc = Math.min(acc, -TUNE.brakeMax);
      if (reason !== 'panic') this.sys.stats.panics++;
      reason = 'panic';
      if (hz.v && this.sys.isPlayerVehicle(ctx, hz.v)) this._horn(ctx, 1);
    } else if (need > TUNE.hornDecel && hz.v && this.sys.isPlayerVehicle(ctx, hz.v)) {
      this._horn(ctx, 0.8);
    }

    acc = clamp(acc, -TUNE.brakeMax, A * 1.4);
    this.diag.reason = reason;

    if (acc > 0.02) {
      this._throttle = clamp01(acc / TUNE.throttleRef);
      this._brake = 0;
    } else if (acc > TUNE.brakeDeadband) {
      this._throttle = 0;
      this._brake = 0;
    } else {
      this._throttle = 0;
      this._brake = clamp01(-acc / TUNE.brakeRef);
    }

    // Hold at a stop line / in a queue rather than creeping into the car ahead.
    const mustHold =
      this._wall < 2.6 ||
      (this._stopDist < 2.2 && this._stopDist > -3) ||
      lead.gap < TUNE.idmS0 * 0.85 ||
      v0 < 0.4;
    if (mustHold && speed < 1.4) {
      this._throttle = 0;
      this._brake = 1;
    }
    this._handbrake =
      (this.state === STATE.PULLOVER || this.state === STATE.BAIL) && speed < 0.5;

    this._holdWithoutSelectingReverse(v);
    return acc;
  }

  /**
   * ────────────────────────────────────────────────────────────────────────
   * A CIVILIAN NEVER ASKS FOR REVERSE, AND MUST NEVER BE GIVEN IT
   * ────────────────────────────────────────────────────────────────────────
   *
   * `Drivetrain._autoShift` selects reverse from the INPUTS alone:
   *
   *     wantReverse = throttle < 0.02 && brake > 0.5 && speed < 0.6
   *
   * which is, character for character, the command every AI driver holds at
   * every red light, in every queue, and through the last half-metre of every
   * ordinary stop. The gearbox then only leaves reverse again on
   *
   *     throttle > 0.1 && speed > -0.4
   *
   * so the moment the car creeps backwards past 0.4 m/s — which idle torque
   * through a reverse ratio does on its own as soon as the brake comes off —
   * the exit condition can never be true again. Throttle now accelerates the
   * car BACKWARDS, permanently.
   *
   * Measured, before this: cars in the middle of a green wave at -8.7 m/s with
   * `state=drive, reason=follow`; a median lane error of 6.5 m and a mean of
   * 9.1 m because pure pursuit's feedback sign inverts in reverse and the car
   * diverges from the lane a little further every frame; 26.7% of samples with
   * a wheel past the kerb; 165 big impacts a minute; a mean speed of 6.3 km/h
   * on roads posted at 38-100.
   *
   * Two halves, because one is not enough:
   *
   *  (a) NEVER EMIT THE COMBINATION. Below walking pace we hold with 0.5 brake
   *      — the test is `> 0.5`, so exactly 0.5 is safe — plus the handbrake,
   *      which is what actually holds the car and holds it harder than the
   *      footbrake did. Nothing about the behaviour changes; the car still
   *      stands still at the line.
   *
   *  (b) NEVER STAY IN IT. Whatever else puts a gearbox into reverse — a
   *      shunt, a script, a future change in `vehicles` — a driver that wants
   *      to go forwards and finds itself in reverse puts it back. `population`
   *      already seats the gearbox by hand at spawn, so this is the same
   *      contract, one frame later.
   */
  _holdWithoutSelectingReverse(v) {
    const speed = v.forwardSpeed;
    if (this._throttle < 0.02 && this._brake > 0.5 && speed < 0.75) {
      this._brake = 0.5;
      this._handbrake = true;
    }
    const dt = v.drivetrain;
    if (dt && dt.gear === 0 && dt.shiftTimer <= 0) {
      dt.gear = 2;
      dt.clutch = 1;
      this.sys.stats.gearRescues++;
    }
  }

  /**
   * BACK OUT OF IT.
   *
   * The old recovery for a car that had driven into something was to re-snap it
   * onto the graph, or, failing that, to delete it and spawn another one
   * somewhere else. Both are invisible when they happen behind you and both are
   * a pop when they happen in front of you. A driver who has nosed into a wall
   * should do what a person does: put it in reverse, back off five metres, and
   * drive round.
   *
   * The gear is pinned by hand for the first fraction of a second because
   * `_autoShift` leaves reverse again on `throttle > 0.1 && speed > -0.4` and
   * that is true for as long as the car has not started moving — so an AI that
   * only sets inputs cannot select reverse at all. Once the car is actually
   * rolling backwards the pin stops mattering and we let go of it.
   */
  _reverseOut(dt, v) {
    this._recoverTimer -= dt;
    const back = Math.hypot(v.position.x - this._recoverX, v.position.z - this._recoverZ);
    const elapsed = RECOVER_TIME - this._recoverTimer;

    /**
     * IS REVERSE EVEN REACHABLE? Today it is not. `Drivetrain._autoShift` runs
     * at 120 Hz, twice for every one of our 60 Hz control ticks, and leaves
     * reverse again on `throttle > 0.1 && speed > -0.4` — so it undoes the gear
     * we selected before the torque for that step is computed, every step, and
     * the car drives FORWARDS into the thing it was trying to back away from.
     *
     * Measured with the manoeuvre enabled and unguarded: cars spent 9% of all
     * car-frames pushing against an obstruction, the stop-recovery that used to
     * clear the lane was skipped for twelve seconds each time, junction
     * throughput fell from 151 crossings a minute to 46 and the longest
     * continuous stop went from 28 s to 57 s. A recovery that makes the street
     * worse is not a recovery.
     *
     * So the manoeuvre proves itself: the FIRST car to try it has half a second
     * to actually be moving backwards. If it is not, reverse is unavailable in
     * this build, the whole fleet is told once, and everybody uses the old
     * re-route path instead. When `vehicles` lands its `_autoShift` fix this
     * re-enables itself with no change here.
     */
    if (elapsed > 0.55 && v.forwardSpeed > -0.25) {
      this.sys.reverseWorks = false;
      return this._abortRecover(v);
    }
    if (this._recoverTimer <= 0 || back > RECOVER_DIST) {
      if (back < 0.8) return this._abortRecover(v);
      this.state = STATE.DRIVE;
      this._recoverCool = 6;
      this._throttle = 0;
      this._brake = 0.5;
      this._handbrake = true;
      this.diag.reason = 'recover';
      this.diag.targetSpeed = 0;
      return 0;
    }
    const gb = v.drivetrain;
    if (gb && v.forwardSpeed > -0.6) { gb.gear = 0; gb.clutch = 1; gb.shiftTimer = 0; }
    // Gently, and never faster than a car park. Straight back: whatever we are
    // wedged in, turning into it is what got us here.
    this._throttle = v.forwardSpeed < -2.2 ? 0 : 0.42;
    this._brake = 0;
    this._handbrake = false;
    this.diag.reason = 'recover';
    this.diag.targetSpeed = 2.2;
    return 0;
  }

  /** The manoeuvre is not going to work. Fall straight through to the old path. */
  _abortRecover(v) {
    this.state = STATE.DRIVE;
    this._recoverCool = 20;
    this._throttle = 0;
    this._brake = 0.5;
    this._handbrake = true;
    this.diag.reason = 'recover';
    if (v.drivetrain?.gear === 0) { v.drivetrain.gear = 2; v.drivetrain.clutch = 1; }
    this.sys.blockEdge(this._edge(0).id);
    if (!this.sys.reseat(this)) this.sys.recycle(this, 'walled');
    return 0;
  }

  /**
   * Is there room behind to do it in? Reversing into the car that is queueing
   * behind us turns one stuck car into two.
   */
  _roomBehind(v) {
    const grid = this.sys.grid;
    const q = v.quaternion;
    const fx = 2 * (q.x * q.z + q.w * q.y);
    const fz = 1 - 2 * (q.x * q.x + q.y * q.y);
    const n = grid.query(v.position.x, v.position.z, RECOVER_CLEAR + 6, v);
    for (let i = 0; i < n; i++) {
      const o = grid.list[grid.hits[i]];
      const rx = o.position.x - v.position.x;
      const rz = o.position.z - v.position.z;
      const behind = -(rx * fx + rz * fz);
      if (behind < 0 || behind > RECOVER_CLEAR) continue;
      const lat = Math.abs(-rx * fz + rz * fx);
      if (lat < v.spec.half.x + o.spec.half.x + 0.3) return false;
    }
    const p = this.sys.player();
    if (p) {
      const rx = p.x - v.position.x;
      const rz = p.z - v.position.z;
      const behind = -(rx * fx + rz * fz);
      if (behind > 0 && behind < RECOVER_CLEAR && Math.abs(-rx * fz + rz * fx) < 1.6) return false;
    }
    return true;
  }

  /** Start a reverse-out if the situation and the space allow one. */
  _tryReverseOut(v) {
    if (!this.sys.reverseWorks) return false;
    if (this._recoverCool > 0 || this.state !== STATE.DRIVE) return false;
    if (!this._roomBehind(v)) return false;
    this.state = STATE.RECOVER;
    this._recoverTimer = RECOVER_TIME;
    this._recoverX = v.position.x;
    this._recoverZ = v.position.z;
    this._swerve = 0;
    this._avoid = 0;
    this.sys.stats.reverses++;
    return true;
  }

  /* --------------------------------------------------------- lateral -- */

  _lateral(dt, v) {
    /**
     * Pure pursuit assumes the car is going FORWARDS: the bearing to the
     * lookahead point is fed back through the front wheels, and in reverse
     * that feedback loop has the opposite sign, so a reversing car does not
     * hunt for the lane — it diverges from it, a little further every frame.
     * Straight back is both correct and the only thing that recovers.
     */
    if (this.state === STATE.RECOVER) {
      const relax = Math.min(1, dt * 6);
      this._steerCmd += (0 - this._steerCmd) * relax;
      return this._steerCmd;
    }
    const speed = Math.abs(v.forwardSpeed);
    const Ld = clamp(TUNE.lookL0 + TUNE.lookKv * speed, TUNE.lookMin, TUNE.lookMax);

    // Kerb-hugging when pulling over; a small personal bias otherwise so a lane
    // of cars is not four perfectly-aligned dots.
    let bias = this._bias + this._laneBlend + this._swerve + this._avoid;
    if (this.state === STATE.PULLOVER) {
      // Tuck toward the kerb, but never past it: a fixed 1.9 m offset puts a
      // car on the pavement on a narrow street, and a car on the pavement is
      // then hit by everything still using the road.
      const L = this.sys.lanes;
      const e = this._edge(0);
      const dir = L.laneDir(e, this._lane(0));
      const room = L.halfWidth(e) - L.laneOffset(e, this._lane(0)) * dir - v.spec.half.x - 0.25;
      bias += clamp(room, 0, 1.7);
    }

    this._pointAt(Ld, bias, this._look);
    const q = v.quaternion;
    const fx = 2 * (q.x * q.z + q.w * q.y);
    const fz = 1 - 2 * (q.x * q.x + q.y * q.y);
    // right-of-forward for a +Z-forward body is (-fz, fx) in (x,z).
    const rx = -fz;
    const rz = fx;
    const dx = this._look.x - v.position.x;
    const dz = this._look.z - v.position.z;
    const ahead = dx * fx + dz * fz;
    const right = dx * rx + dz * rz;
    const alpha = Math.atan2(right, Math.max(0.5, ahead));

    // Pure pursuit: positive => the target is to our right => turn right.
    let delta = Math.atan2(2 * v.spec.wheelbase * Math.sin(alpha), Math.max(1.5, Ld));

    // Cross-track correction. `_lat` is metres to the RIGHT of the lane, so a
    // positive error needs LESS right steer.
    const latRate = (this._lat - this._latPrev) / Math.max(1e-3, dt);
    delta -= TUNE.crossTrackGain * clamp(this._lat, -3.5, 3.5);
    delta -= TUNE.crossRateGain * clamp(latRate, -6, 6);

    // Plant mapping: the dynamics scales `input.steer` by the max lock and its
    // own speed falloff, and POSITIVE steer is a LEFT turn.
    const st = v.spec.steer;
    const falloff = Math.max(0.24, 1 - st.speedFalloff * Math.min(1, speed / 42));
    let cmd = clamp(-delta / Math.max(0.05, st.max * falloff), -1, 1);

    // Rate limit + low-pass. The plant has its own steering rate limit; fighting
    // it is what makes an AI car weave.
    const maxStep = TUNE.steerRate * dt;
    cmd = clamp(cmd, this._steerCmd - maxStep, this._steerCmd + maxStep);
    this._steerCmd += (cmd - this._steerCmd) * Math.min(1, TUNE.steerSmooth * dt);
    if (!Number.isFinite(this._steerCmd)) this._steerCmd = 0;
    return this._steerCmd;
  }

  /* ---------------------------------------------------------- health -- */

  /**
   * Nothing kills the illusion faster than one car parked in the middle of a
   * junction forever, so every driver watches itself: stuck, off the
   * carriageway, or somewhere the path no longer exists.
   */
  _health(dt, ctx, v) {
    /**
     * FELL OUT OF THE WORLD. Nothing else catches this: the car is moving, so
     * it is not stuck; the lane projection is 2D, so it is not off-road; and
     * the despawn radius is 2D too, so it never gets recycled. It just holds a
     * driver slot at terminal velocity forever.
     */
    if (v.airborne > 2.5 || v.position.y < this._pathY() - 14) {
      this.sys.recycle(this, 'fell');
      return;
    }

    /**
     * Three checks in a row would have failed to notice the belief was stale;
     * a second and a half is long enough to be sure and short enough that the
     * car has not driven into anything yet.
     */
    if (this._wrongLink >= 3) {
      this._wrongLink = 0;
      this._trueOff = 0;
      if (!this.sys.reseat(this)) this.sys.recycle(this, 'lostlink');
      return;
    }

    const half = this.sys.lanes.halfWidth(this._edge(0));
    // Whichever of the two says we are further out is the one to believe.
    const off = Math.max(Math.abs(this._lat) - half, this._trueOff);

    // The route is physically blocked and we have stopped for it. Do not wait
    // out the stall window — mark the edge and go somewhere else now.
    if (this._wall < 3.2 && Math.abs(v.forwardSpeed) < 0.6) {
      this._wallTime += dt;
      if (this._wallTime > 1.8) {
        this._wallTime = 0;
        // Back out of it first. Re-routing on the spot leaves the nose still
        // touching whatever we ran into, so the new route's first metre is
        // through the same obstruction and we are straight back here.
        if (this._tryReverseOut(v)) return;
        this.sys.blockEdge(this._edge(0).id);
        if (this._reroute > 0 || !this.sys.reseat(this)) this.sys.recycle(this, 'walled');
        else this._reroute = 10;
        return;
      }
    } else {
      this._wallTime = 0;
    }

    /**
     * STALL DETECTION IS ON PATH PROGRESS, NOT ON SPEED.
     *
     * A car wedged on an embankment with the wheels at full lock has a speed
     * of 0.6 m/s (it is sliding and spinning), a valid path, and nothing in
     * front of it — every speed-based test says it is fine, and it sits there
     * for the rest of the session. What it is NOT doing is getting anywhere,
     * so measure that: metres advanced along the route per window.
     */
    this._progTimer += dt;
    if (this._progTimer >= 4) {
      /**
       * Waiting is only excusable if there is something to wait FOR. A stop
       * line, a leader that is still moving, or a leader that is itself close
       * to a stop line all count. Two cars that shunted and interlocked do
       * not — and the naive "my leader is close, so I am queueing" test
       * excused exactly that case, so the pair sat welded together for the
       * whole session and took the street's throughput with them.
       */
      const ld = this._lead.v ? this.sys.driverOf(this._lead.v) : null;
      const excused =
        // A wall across the road is never an excuse to wait: re-route.
        (this._wall > 4 || this._lead.gap < 12) &&
        // AT the stop line, not merely approaching one. A car sitting twelve
        // metres short of a red light with nothing in front of it is wedged on
        // something, not queueing, and "there is a red light ahead" excused it
        // for the whole session.
        this._stopDist < 4.5 ||
        this.state === STATE.PULLOVER || this.state === STATE.BAIL ||
        (this._lead.gap < 12 && (this._lead.speed > 0.5 || (ld && ld._stopDist < 45)));
      /**
       * Net displacement over the window, not accumulated path parameter:
       * a car that is stationary but jittering by a centimetre a tick
       * accumulates a metre of "progress" every four seconds and defeats an
       * accumulating counter completely.
       */
      /**
       * Progress is measured ALONG THE ROUTE, not through the air. A car
       * wedged against a kerb at full throttle slides and rotates enough to
       * cover three metres of ground in four seconds while getting precisely
       * nowhere; only the route odometer tells the two apart.
       */
      const odo = this._consumed + this._s;
      const moving = odo - this._markOdo > 2.5;
      this._progTimer = 0;
      this._markOdo = odo;
      this._excused = excused && off < 2.4;
      if (moving) this._stall = 0;
      else this._stall++;
      // Eight seconds of going nowhere with no excuse; forty with one — long
      // enough to sit out the longest red in the signal table.
      if (this._stall >= (this._excused ? 8 : 2)) {
        this._stall = 0;
        // Wedged, and there is space behind: back out and try again. This is
        // the difference between a car that recovers where the player can see
        // it and a car that pops out of existence.
        if (this._tryReverseOut(v)) return;
        // Off the carriageway and stationary is not something steering fixes.
        if (off > 2.4 || this._reroute > 0 || !this.sys.reseat(this)) {
          this.sys.recycle(this, 'stuck');
          return;
        }
        this._reroute = 14;
      }
    }

    // Drifting wide of the lane while still making progress: re-route rather
    // than recycle, so the car keeps driving and the player never sees a pop.
    if (off > 2.4) this._offroad += off > 9 ? dt * 4 : dt;
    else this._offroad = Math.max(0, this._offroad - dt * 1.5);
    this._reroute = Math.max(0, this._reroute - dt);
    if (this._offroad > TUNE.offroadTime) {
      this._offroad = 0;
      if (this._reroute > 0 || !this.sys.reseat(this)) this.sys.recycle(this, 'offroad');
      else this._reroute = 8;
      return;
    }

    // Pull-over / flee timers.
    const speed = Math.abs(v.forwardSpeed);
    if (this.state === STATE.PULLOVER) {
      this._pullTimer -= dt;
      // Hard timeout: whatever is going on, get moving again eventually.
      if (this._pullTimer < -9 || (this._pullTimer < -2.5 && !this.sys.sirenNear(ctx, v))) {
        this.state = STATE.DRIVE;
      }
    } else if (this.state === STATE.FLEE) {
      if (this._fear < 0.12) this.state = STATE.DRIVE;
    } else if (this.state === STATE.BAIL) {
      this._bailTimer += dt;
      if (speed < 1.2 || this._bailTimer > 4) this.sys.abandon(this, ctx);
    } else if (this.state === STATE.PULLOUT) {
      if (Math.abs(this._lat) < 1.1) this.state = STATE.DRIVE;
    }
  }

  /**
   * WHERE THE CAR ACTUALLY IS, measured against the road graph rather than
   * against what the driver believes.
   *
   * `_health` used to derive its whole off-road test from `|_lat| - halfWidth`,
   * where both terms come from the link the driver THINKS it is on. That works
   * right up to the moment the belief is wrong, and then it fails in the worst
   * possible direction: a car that has picked up a nine-metre highway stub at a
   * junction inherits a 14.3 m half-width, so it can sit four metres past the
   * kerb of a seven-metre street, on dirt, and compute `off` as comfortably
   * negative. Measured: cars stationary on dirt and sand at x=-190..-200 for
   * seconds at a time with `reason: free`, and cars 11 m clear of the road
   * believing an arterial.
   *
   * Two cheap facts from one query, twice a second:
   *   `_trueOff`    metres past the kerb of the NEAREST edge — the same number
   *                 the harness scores, so the driver and the test agree.
   *   `_wrongLink`  consecutive checks where the real road is much closer than
   *                 the lane we are steering to, i.e. the belief is stale.
   *
   * The height argument is not decoration — see `TrafficSystem.reseat`.
   */
  _checkGround(v) {
    const roads = this.sys.lanes.roads;
    if (!roads?.nearestEdge || this._count === 0) return;
    const hit = roads.nearestEdge(v.position.x, v.position.z, 70, v.position.y);
    if (!hit?.edge) {
      this._trueOff = 99;
      this._wrongLink++;
      return;
    }
    this._trueOff = hit.dist - hit.edge.width * 0.5 - v.spec.half.x;
    const stale = hit.edge !== this._edge(0) && hit.dist + 2.5 < Math.abs(this._lat);
    this._wrongLink = stale ? this._wrongLink + 1 : 0;
  }

  /** Height of the lane we believe we are on. */
  _pathY() {
    if (this._count === 0) return -1e9;
    this.sys.lanes.point(this._edge(0), this._lane(0), this._s, 0, this._pt);
    return this._pt.y;
  }

  /** Re-snap onto the graph if our path went stale. Returns false when hopeless. */
  _reseatIfNeeded() {
    if (this._count > 0) return true;
    if (this.sys.reseat(this)) return true;
    this.sys.recycle(this, 'lost');
    return false;
  }

  get position() {
    return this.vehicle?.position ?? null;
  }
}

export { STATE as DRIVER_STATE };
