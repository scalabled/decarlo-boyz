/**
 * TRAFFIC — AI drivers on the road graph.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * PUBLIC API  —  const t = ctx.get('traffic')
 * ────────────────────────────────────────────────────────────────────────────
 *   lightAt(nodeId)            'green' | 'red' | null   — THE `peds` contract
 *   phaseFor(nodeId, edgeId)   'green' | 'amber' | 'red' | null
 *   timeToGreen(nodeId, edgeId)
 *   drivers                    live Driver[]
 *   driverOf(vehicle)          Driver | null
 *   isTraffic(vehicle)         true for anything this system owns
 *   yieldFor(vehicle, radius)  make civilians pull over — `police` calls this
 *   scareAt(x, z, radius, amt) panic the drivers near a point
 *   sample()                   telemetry, for tools and the dev overlay
 *   stats                      { drivers, parked, ms, spawns, ... }
 *
 * ────────────────────────────────────────────────────────────────────────────
 * WHAT LIVES WHERE
 *   lanes.js       usable lanes, parking bays, successors — the layer over the
 *                  road graph that turns "edges" into "somewhere to drive"
 *   lights.js      signal phases, the green wave, junction reservations
 *   driver.js      pure-pursuit steering + IDM car following, per car
 *   population.js  how many cars, of what, where they appear and vanish
 *   parking.js     kerbside bays and cars that pull out of them
 *   grid.js        neighbour broadphase
 *
 * ────────────────────────────────────────────────────────────────────────────
 * TIMING. The controller runs at a fixed 60 Hz inside `fixedUpdate`, decimated
 * from the engine's 120 Hz physics step. Fixed-rate means behaviour does not
 * change with frame rate and a capture is reproducible; 60 Hz (rather than 120)
 * halves the cost for a control loop whose plant already has its own steering
 * rate limit. Spawning and parking run once per frame in `update`, because they
 * build geometry and want the camera.
 *
 * Every AI car is driven through `vehicles.setInput()`. This system never
 * writes a transform, so an AI car has exactly the player's tyre model, weight
 * transfer and collision response.
 */

import * as THREE from 'three';
import { LaneNet } from './lanes.js';
import { SignalNet } from './lights.js';
import { Driver, DRIVER_STATE } from './driver.js';
import { VehicleGrid } from './grid.js';
import { Director } from './population.js';
import { ParkingLot } from './parking.js';
import { TUNE, clamp, clamp01 } from './tune.js';

/** Control rate: every Nth fixed step. 120 Hz / 2 = 60 Hz. */
const DECIMATE = 2;
/** Fraction of the vehicle budget that is moving traffic; the rest is parked. */
const MOVING_SHARE = 0.72;
/** Seat a body in a traffic car once it is this close to the anchor... */
const SEAT_NEAR = 78;
/** ...and take it back out again past this. Hysteresis, or it thrashes. */
const SEAT_FAR = 118;

const _v = new THREE.Vector3();
const _c = new THREE.Vector3();

export class TrafficSystem {
  static id = 'traffic';
  static deps = ['world', 'vehicles'];

  async init(ctx) {
    this.ctx = ctx;
    this.rng = ctx.rng.fork();
    this.vehicles = ctx.peek('vehicles');
    this.world = ctx.peek('world');
    this.physics = ctx.peek('physics');

    this.lanes = new LaneNet();
    this.signals = new SignalNet(this.lanes);
    this.grid = new VehicleGrid();
    this.director = new Director(this);
    this.parking = new ParkingLot(this);

    /** Pool of Driver objects — bound and released, never reallocated. */
    this._pool = [];
    this.drivers = [];
    this._byVehicle = new Map();
    this._abandoned = [];
    this._nextId = 1;
    /** Traffic cars we have put a `peds` body into. */
    this._seated = new Set();
    this._seatCursor = 0;
    /** The car the player is in, so we never drive or despawn it. */
    this._playerCar = null;

    this.movingShare = MOVING_SHARE;
    /**
     * Can a car in this build actually be made to go backwards? The first
     * driver that needs to reverse out of something finds out for everybody —
     * see `Driver._reverseOut`. `vehicles` owns the answer; we only measure it.
     */
    this.reverseWorks = true;
    this.anchor = new THREE.Vector3();
    this.hour = 16.5;
    this.wetness = 0;
    this.gripScale = 1;
    this._proj = { s: 0, lateral: 0 };

    this._step = 0;
    /** Control ticks since boot — drivers stagger their probes off it. */
    this.tick = 0;
    this._netTimer = 0;
    this._sirenTimer = 0;
    /** Capture keep-out: radius, seconds left, and where it is centred. */
    this._holdR = 0;
    this._holdT = 0;
    this._holdX = 0;
    this._holdZ = 0;
    this._lastAnchor = new THREE.Vector3(NaN, NaN, NaN);
    this._fillPending = 0;
    this._stats = {
      drivers: 0, parked: 0, abandoned: 0, ms: 0, msPerCar: 0,
      spawns: 0, despawns: 0, recycled: 0, horns: 0, signals: 0,
      junctionPasses: 0, linkPasses: 0, laneChanges: 0, panics: 0, evades: 0,
      handovers: 0, seated: 0, gearRescues: 0, reverses: 0,
    };
    this._sirens = [];
    this._props = undefined;
    this._peds = undefined;
    this._audio = undefined;
    this._player = undefined;
    this._police = undefined;

    this._wire(ctx);
    this._attachNet();
  }

  /* ==================================================================== */
  /* Wiring                                                               */
  /* ==================================================================== */

  _wire(ctx) {
    this._offs = [];
    const on = (n, f) => this._offs.push(ctx.events.on(n, f));

    on('time:hour', (p) => { if (Number.isFinite(p?.hour)) this.hour = p.hour; });
    on('weather:change', (p) => {
      if (Number.isFinite(p?.wetness)) this._setWet(p.wetness);
    });
    on('bullet:impact', (p) => {
      if (p?.point) this.scareAt(p.point.x, p.point.z, 9, 1.0);
    });
    on('weapon:fire', (p) => {
      if (p?.origin) this.scareAt(p.origin.x, p.origin.z, 26, 0.5);
    });
    on('explosion', (p) => {
      if (p?.position) this.scareAt(p.position.x, p.position.z, (p.radius ?? 8) * 2.4, 1.2);
    });
    on('vehicle:collision', (p) => {
      // `vehicle:collision` also fires for chassis-vs-world contacts — a tyre
      // brushing a kerb. Reacting to those had a quarter of the city's drivers
      // permanently in a panic state. Only a real shunt counts.
      if (!p?.other?.isVehicle) return;
      const d = this._byVehicle.get(p.vehicle);
      // A shunt rattles you; it does not make you abandon the road.
      if (d && (p.impulse ?? 0) > p.vehicle.mass * 3.5) d.scare(0.3, false);
    });
    on('vehicle:destroyed', (p) => {
      const d = p?.vehicle && this._byVehicle.get(p.vehicle);
      if (d) this.abandon(d, ctx);
      // Enough to make the street react, not enough to start a chain reaction:
      // at 1.1 over 22 m every driver in sight bailed out, their abandoned cars
      // caused more collisions, and the whole block destroyed itself.
      if (p?.point) this.scareAt(p.point.x, p.point.z, 16, 0.55);
    });
    on('wanted:change', (p) => {
      // A chase raises the whole street's blood pressure.
      if ((p?.level ?? 0) > (p?.prev ?? 0)) this._alert = 1;
    });
    /**
     * SOMEBODY ELSE IS DRIVING NOW.
     *
     * `fixedUpdate` used to drive every entry in `drivers` unconditionally, so
     * when the player carjacked a traffic car our controller kept calling
     * `setInput()` underneath them at 60 Hz and the two fought over the
     * throttle for as long as they were in it. `player` worked around it by
     * calling `abandon()`, which is the wrong call for a handover — it brakes
     * the car, pulls the handbrake, and files it on the wreck list, where
     * `_ageAbandoned` is entitled to despawn it out from under whoever is
     * sitting in it. `release()` is the handover: we let go, and touch nothing.
     */
    on('vehicle:enter', (p) => {
      if (p?.vehicle) this.release(p.vehicle, 'enter');
    });
    /**
     * On exit the car is left where it stands rather than being given back to
     * the AI: a car that drives itself away the moment you step out of it
     * reads as a bug, not as a living city.
     */
    on('vehicle:exit', (p) => {
      if (p?.vehicle === this._playerCar) this._playerCar = null;
    });
    /**
     * A capture teleports the camera kilometres, so the street normally has to
     * be refilled or the shutter photographs an empty city.
     *
     * BUT a shot that declares `clearTraffic: <metres>` has just deliberately
     * emptied that radius, and `capture.mjs` empties it AGAIN immediately
     * before the shutter. Refilling it in between is not helpful, it is the
     * bug: review captures kept coming back with cars in the lens moments
     * after they had been cleared, and `peds` measured `--shot=hero` at 5693
     * draws / 16.3 M triangles of traffic and called it unusable for judging
     * anything. So honour the request, and keep honouring it for the whole
     * settle rather than for one frame.
     */
    on('shot:applied', (p) => {
      const r = p?.shot?.clearTraffic ?? 0;
      if (r > 0) {
        this._fillPending = 0;
        this._holdR = r + 8;
        this._holdT = 90;
        ctx.camera.getWorldPosition(_c);
        this._holdX = _c.x;
        this._holdZ = _c.z;
      } else {
        this._holdR = 0;
        this._holdT = 0;
        this._fillPending = 14;
      }
    });
  }

  _setWet(w) {
    this.wetness = clamp01(w);
    // Wet asphalt: civilians slow down. 15% off at soaked.
    this.gripScale = 1 - this.wetness * 0.15;
  }

  /** The road graph appears when `world` publishes it, which may be after us. */
  _attachNet() {
    const roads = this.world?.roads;
    if (!roads || this.lanes.roads === roads) return this.lanes.ready;
    const densityAt = (e) => {
      const n = roads.nodes[e.a];
      return this.world.districtAt?.(n.x, n.z)?.density ?? 0.5;
    };
    const ok = this.lanes.attach(roads, densityAt);
    if (ok) this.signals.reset();
    return ok;
  }

  /* ==================================================================== */
  /* Runtime lookups — never import another subsystem, ask for it          */
  /* ==================================================================== */

  _sys(key, id) {
    if (this[key] === undefined) this[key] = this.ctx.peek(id) ?? null;
    return this[key];
  }

  get peds() { return this._sys('_peds', 'peds'); }
  get audio() { return this._sys('_audio', 'audio'); }
  get props() { return this._sys('_props', 'props'); }
  get police() { return this._sys('_police', 'police'); }
  get playerSys() { return this._sys('_player', 'player'); }

  /** Player world position, or null. */
  player() {
    const p = this.playerSys;
    const pos = p?.position;
    return pos && Number.isFinite(pos.x) ? pos : null;
  }

  /**
   * Is (x,z) far enough from the PLAYER'S BODY to put a car there?
   *
   * Distinct from the anchor test on purpose. `anchor` follows the camera
   * whenever the camera is more than 30 m from the player, so during a capture
   * shot, a cutscene or a probe that teleports the body, every "34 m from the
   * anchor" spawn point can be standing on the player.
   */
  clearOfPlayer(x, z, r) {
    const p = this.player();
    if (!p) return true;
    const dx = x - p.x;
    const dz = z - p.z;
    if (dx * dx + dz * dz < r * r) return false;
    // ...and not on top of the car they are driving either.
    const pv = this.playerVehicle() ?? this._playerCar;
    if (pv?.position) {
      const vx = x - pv.position.x;
      const vz = z - pv.position.z;
      if (vx * vx + vz * vz < r * r) return false;
    }
    return true;
  }

  /**
   * True when (x,z) is inside a keep-out a shot asked for — see the
   * `shot:applied` handler. Anchored to where the camera was when the shot was
   * applied, so a settling camera cannot drag the hold off the frame.
   */
  inSpawnHold(x, z) {
    if (!(this._holdT > 0) || !(this._holdR > 0)) return false;
    const dx = x - this._holdX;
    const dz = z - this._holdZ;
    return dx * dx + dz * dz < this._holdR * this._holdR;
  }

  playerVehicle() {
    const p = this.playerSys;
    return p?.vehicle ?? p?.currentVehicle ?? null;
  }

  isPlayerVehicle(ctx, v) {
    return !!v && (v === this._playerCar || v === this.playerVehicle());
  }

  /**
   * Is `actor` the local player? `vehicle:enter` is emitted for peds boarding
   * too, and the payload's `actor` is whatever the emitter had to hand — the
   * player system itself, its movement actor, or a bare `'player'`.
   */
  isPlayerActor(actor) {
    if (!actor) return false;
    if (actor === 'player' || actor.isPlayer === true) return true;
    const ps = this.playerSys;
    return !!ps && (actor === ps || actor === ps.actor || actor === ps.movement);
  }

  /**
   * `props` owns static parked-car dressing. If it has claimed a kerb we do not
   * double up. Duck-typed, because `props` may not expose the hook at all.
   */
  propsHasParking(edge, side) {
    const p = this.props;
    if (!p) return false;
    try {
      if (typeof p.hasParkingOn === 'function') return !!p.hasParkingOn(edge.id, side);
      if (typeof p.parkedOnEdge === 'function') return !!p.parkedOnEdge(edge.id, side);
    } catch { /* a partner subsystem must never break traffic */ }
    return false;
  }

  /* ==================================================================== */
  /* Driver lifecycle                                                     */
  /* ==================================================================== */

  get liveCount() {
    return this.drivers.length;
  }

  driverOf(vehicle) {
    return this._byVehicle.get(vehicle) ?? null;
  }

  isTraffic(vehicle) {
    return !!vehicle?.isTraffic;
  }

  /** Bind a Driver (pooled) to a vehicle sitting on (edge, lane) at `s`. */
  attach(vehicle, edge, lane, s) {
    if (!vehicle || !this.lanes.ready) return null;
    let d = null;
    for (let i = 0; i < this._pool.length; i++) {
      if (!this._pool[i].active) { d = this._pool[i]; break; }
    }
    if (!d) {
      d = new Driver(this, this._nextId++);
      this._pool.push(d);
    }
    d.bind(vehicle, edge, lane, s, this.rng);
    this.drivers.push(d);
    this._byVehicle.set(vehicle, d);
    this._stats.spawns++;
    return d;
  }

  /** Detach a driver and destroy its car. */
  recycle(driver, reason = 'far') {
    const v = driver.vehicle;
    const i = this.drivers.indexOf(driver);
    if (i >= 0) this.drivers.splice(i, 1);
    if (v) {
      this._byVehicle.delete(v);
      this.parking.forget(v);
      this._unseatPed(v);
      this.vehicles.despawn(v);
    }
    driver.release();
    this._stats.despawns++;
    if (reason !== 'far') this._stats.recycled++;
    return true;
  }

  /**
   * HAND THE CAR OVER. Somebody who is not us — the player, a scripted actor —
   * has taken the wheel. Stop issuing `setInput` for it and let go of the
   * vehicle entirely: no brake, no handbrake, no wreck list, no despawn.
   *
   * This is deliberately NOT `abandon()`. `abandon` is for a driver who is
   * fleeing or dead: it stands the car on its brakes and files it as scenery
   * with a lifetime. Doing that to a carjack meant the player inherited a car
   * with the handbrake on that `_ageAbandoned` was entitled to delete from
   * under them once six more wrecks had accumulated.
   *
   * Idempotent, and safe to call with a car we never owned.
   */
  release(vehicle, reason = 'handover') {
    if (!vehicle) return false;
    const d = this._byVehicle.get(vehicle);
    if (!d) return false;
    const i = this.drivers.indexOf(d);
    if (i >= 0) this.drivers.splice(i, 1);
    this._byVehicle.delete(vehicle);
    this.parking.forget(vehicle);
    /**
     * Whoever is climbing in is taking the seat, so the body in it has to come
     * out. `pullFromVehicle` is the documented call and it is a no-op when the
     * car is empty — which it will be on the normal carjack path, because
     * `player` pulls the driver out itself before the seat is taken.
     */
    const peds = this.peds;
    if (peds) {
      try {
        if (peds.driverOf?.(vehicle)) {
          _v.copy(vehicle.position);
          _v.x += 1.4;
          peds.pullFromVehicle?.(vehicle, _v);
        }
      } catch { /* never let a peds failure break traffic */ }
    }
    this._seated.delete(vehicle);
    d.release();
    this._stats.handovers++;
    if (reason === 'enter') this._playerCar = vehicle;
    return true;
  }

  /* ==================================================================== */
  /* Bodies behind the wheel                                              */
  /* ==================================================================== */

  /**
   * A CITY OF DRIVERLESS CARS.
   *
   * `peds.attachDriver` was only ever called from `abandon()`, so every moving
   * car in the city was empty: the player walked up to pull somebody out of a
   * car in traffic and there was nobody there. In a game whose headline verb is
   * carjacking that is the single loudest immersion break traffic can produce.
   *
   * Bodies are expensive — one is a skinned mesh and an outfit — and they come
   * out of `q.pedBudget`, which is the same pool that fills the pavements. So
   * we do not seat every car in the city: we seat the ones close enough for the
   * player to walk up to, unseat them again when they drive away, and cap the
   * total. At most one seat or unseat per frame, because building an outfit on
   * the same frame as a vehicle model is a visible hitch.
   */
  _seatSweep(ctx) {
    const peds = this.peds;
    if (!peds?.attachDriver) return;
    const cap = clamp(Math.round((ctx.config.q.pedBudget ?? 40) * 0.28), 3, 14);
    const a = this.anchor;
    let did = false;
    // Unseat first: it frees budget and never allocates.
    for (const v of this._seated) {
      if (!this._byVehicle.has(v) || !v.model?.root?.parent) {
        this._unseatPed(v);
        did = true;
        break;
      }
      const d = Math.hypot(v.position.x - a.x, v.position.z - a.z);
      if (d > SEAT_FAR) {
        this._unseatPed(v);
        did = true;
        break;
      }
    }
    if (did || this._seated.size >= cap) return;
    // ...then seat one car that has come within reach and has nobody in it.
    const n = this.drivers.length;
    if (n === 0) return;
    for (let k = 0; k < n; k++) {
      const i = (this._seatCursor + k) % n;
      const v = this.drivers[i].vehicle;
      if (!v || this._seated.has(v)) continue;
      const d = Math.hypot(v.position.x - a.x, v.position.z - a.z);
      if (d > SEAT_NEAR) continue;
      this._seatCursor = (i + 1) % n;
      this._seatPed(v);
      return;
    }
  }

  _seatPed(v) {
    const peds = this.peds;
    if (!peds?.attachDriver || !v) return false;
    try {
      if (peds.driverOf?.(v)) { this._seated.add(v); return true; }
      const district = this.world?.districtAt?.(v.position.x, v.position.z);
      const ped = peds.attachDriver(v, 0, { archetype: district?.id === 'steelrow' ? 'worker' : 'street' });
      if (!ped) return false;
      this._seated.add(v);
      this._stats.seated++;
      return true;
    } catch { /* never let a peds failure break traffic */ }
    return false;
  }

  /**
   * Take the body back out. There is no `detachDriver` in the `peds` API yet,
   * so this duck-types the hook it will grow and falls back to the streamer's
   * own despawn — a driving ped whose car has been recycled otherwise sits
   * frozen at the last position the car reported, holding a budget slot, until
   * distance streaming happens to notice it.
   */
  _unseatPed(v) {
    if (!v || !this._seated.has(v)) return;
    this._seated.delete(v);
    const peds = this.peds;
    if (!peds) return;
    try {
      if (typeof peds.detachDriver === 'function') { peds.detachDriver(v); return; }
      const ped = peds.driverOf?.(v);
      if (!ped) return;
      if (typeof peds._despawn === 'function') { peds._despawn(ped); return; }
      /**
       * Last resort, and it must never be "clear the fields and hope": a ped
       * left in the DRIVING state with no vehicle stops updating its own
       * position and stands frozen at wherever the car was, holding a slot in
       * `q.pedBudget` for the rest of the session. Putting them out on the road
       * is at least a state the ped streamer knows how to clean up.
       */
      _v.copy(v.position);
      _v.x += 1.4;
      peds.pullFromVehicle?.(v, _v);
    } catch { /* never let a peds failure break traffic */ }
  }

  /**
   * The car is a write-off or its driver has fled: hand the body over to `peds`
   * so somebody actually runs away from it, then leave the wreck on the road as
   * an obstacle for a while. A car that simply vanishes when you shoot it is
   * the single most immersion-breaking thing traffic can do.
   */
  abandon(driver, ctx) {
    const v = driver.vehicle;
    const i = this.drivers.indexOf(driver);
    if (i >= 0) this.drivers.splice(i, 1);
    if (v) {
      this._byVehicle.delete(v);
      v.input.throttle = 0;
      v.input.brake = 1;
      v.input.handbrake = true;
      v.input.steer = 0;
      const peds = this.peds;
      if (peds && !v.destroyed) {
        try {
          _v.copy(v.position);
          _v.x += 1.4;
          if (!peds.driverOf(v)) peds.attachDriver?.(v, 0, { archetype: 'street' });
          peds.pullFromVehicle?.(v, _v);
        } catch { /* never let a peds failure break traffic */ }
      }
      // The body is out on the road now; it is no longer ours to unseat.
      this._seated.delete(v);
      this._abandoned.push({ v, t: 0 });
    }
    driver.release();
    return true;
  }

  /**
   * Re-snap a lost driver onto the nearest legal lane. Returns false when there
   * is no road anywhere near, in which case the caller recycles the car.
   */
  reseat(driver) {
    const v = driver.vehicle;
    const roads = this.world?.roads;
    if (!v || !roads) return false;
    /**
     * `nearestEdge` takes the query HEIGHT now, and passing it is not optional
     * here: this city has eleven bridges and every one of them flies over a
     * quay, so the nearest edge in plan to a car under a bridge is the bridge
     * deck eighteen metres up. Re-seating onto that gives a lateral error of
     * tens of metres, which trips the off-road recovery, which re-seats onto
     * the same deck again. `world` added the parameter for exactly this.
     */
    const hit = roads.nearestEdge(v.position.x, v.position.z, 90, v.position.y);
    if (!hit?.edge || hit.dist > TUNE.offroadHard) return false;
    if (Math.abs(hit.dy ?? 0) > 6) return false;
    const L = this.lanes;
    const e = hit.edge;
    /**
     * `nearestEdge` is a 2D query. Under a bridge the nearest edge in plan is
     * the BRIDGE, 18 m overhead — re-seating onto it gives a lateral error of
     * tens of metres, which trips the off-road recovery, which re-seats onto
     * the same bridge again. Reject any edge at a wildly different height and
     * let the caller recycle the car instead.
     */
    L.point(e, 0, hit.t * e.len, 0, _v);
    if (Math.abs(_v.y - v.position.y) > 6) return false;
    // Pick the direction the car is already pointing, so it does not spin round.
    const q = v.quaternion;
    const fx = 2 * (q.x * q.z + q.w * q.y);
    const fz = 1 - 2 * (q.x * q.x + q.y * q.y);
    let dir = fx * e.dx + fz * e.dz >= 0 ? 1 : -1;
    if (!L.drivable(e, dir)) dir = -dir;
    if (!L.drivable(e, dir)) return false;
    const lane = L.laneHi(e, dir);
    L.project(e, lane, v.position.x, v.position.z, this._proj);
    const s = clamp(this._proj.s, 1, e.len - 1);
    if (driver._claimNode >= 0) this.signals.release(driver._claimNode, driver.id);
    driver._claimNode = -1;
    driver._head = 0;
    driver._count = 0;
    driver._s = s;
    driver._laneBlend = 0;
    driver._swerve = 0;
    driver._consumed = 0;
    driver._markOdo = s;
    driver._progTimer = 0;
    driver._stall = 0;
    driver._push(e, lane);
    driver._ensureLinks(this.rng);
    driver.state = DRIVER_STATE.DRIVE;
    return driver._count > 0;
  }

  /**
   * Drop the `n` drivers furthest from the anchor that are not on screen.
   *
   * Distance alone is not enough. The population target falls when the clock
   * or the district changes, and cars circulating inside the spawn radius are
   * never "far" — so the surplus never cleared, and thirty cars sized for a
   * 4 am street ended up nose to tail on it. Over budget, the only test that
   * matters is whether anybody can see the car go.
   */
  recycleFarthest(ctx, n) {
    let dropped = 0;
    while (dropped < n) {
      let best = -1;
      let bestD = -1;
      for (let i = 0; i < this.drivers.length; i++) {
        const p = this.drivers[i].vehicle?.position;
        if (!p) { best = i; bestD = Infinity; break; }
        const d = Math.hypot(p.x - this.anchor.x, p.z - this.anchor.z);
        if (d <= bestD) continue;
        if (d < TUNE.despawnHard && this.director.visible(ctx, p.x, p.z)) continue;
        bestD = d;
        best = i;
      }
      if (best < 0) break;
      this.recycle(this.drivers[best], 'far');
      dropped++;
    }
    return dropped;
  }

  /* ==================================================================== */
  /* Reactions                                                            */
  /* ==================================================================== */

  /** Frighten every driver within `r` of a point. */
  scareAt(x, z, r, amount = 1) {
    const r2 = r * r;
    for (let i = 0; i < this.drivers.length; i++) {
      const d = this.drivers[i];
      const p = d.vehicle?.position;
      if (!p) continue;
      const dx = p.x - x;
      const dz = p.z - z;
      const q = dx * dx + dz * dz;
      if (q > r2) continue;
      d.scare(amount * (1 - Math.sqrt(q) / r));
    }
  }

  /**
   * A driver could not get down this edge — something solid is across it.
   * Remember it for a while so the rest of the fleet routes around instead of
   * queueing into the same dead end one car at a time.
   */
  blockEdge(edgeId, seconds = 90) {
    this.lanes.blocked.set(edgeId, this.signals.time + seconds);
  }

  /** `police` calls this to clear a path. Also driven by our own siren scan. */
  yieldFor(vehicle, radius = TUNE.sirenRadius) {
    if (!vehicle?.position) return 0;
    const r2 = radius * radius;
    let n = 0;
    for (let i = 0; i < this.drivers.length; i++) {
      const d = this.drivers[i];
      const p = d.vehicle?.position;
      if (!p) continue;
      const dx = p.x - vehicle.position.x;
      const dz = p.z - vehicle.position.z;
      const q = dx * dx + dz * dz;
      if (q > r2) continue;
      // Only for something that is actually coming AT us — a cruiser going
      // the other way down the far carriageway is not our problem.
      const closing = -(vehicle.velocity.x * dx + vehicle.velocity.z * dz);
      if (closing < 2 && q > 400) continue;
      d.yieldToSiren();
      n++;
    }
    return n;
  }

  /** Is a lit-up emergency vehicle close to `v`? */
  sirenNear(ctx, v) {
    for (let i = 0; i < this._sirens.length; i++) {
      const s = this._sirens[i];
      const dx = s.position.x - v.position.x;
      const dz = s.position.z - v.position.z;
      if (dx * dx + dz * dz < TUNE.sirenRadius * TUNE.sirenRadius) return true;
    }
    return false;
  }

  horn(ctx, vehicle, level = 1) {
    this._stats.horns++;
    const a = this.audio;
    if (!a?.play) return;
    try {
      a.play('city', vehicle.position, { which: 'horn', level: 0.55 + level * 0.5, near: true });
    } catch { /* audio may be suspended before a user gesture */ }
  }

  /* ==================================================================== */
  /* World helpers used by the driver / director                          */
  /* ==================================================================== */

  /** Ground height under (x,z), falling back to the lane's own y. */
  groundY(x, z, hint = 0) {
    const h = this.solidGroundY(x, z, hint);
    return h === null ? hint : h;
  }

  /**
   * Ground height under (x,z) from the REAL collision world, or null when
   * there is nothing solid there. Null means "do not put a car here": the
   * terrain collider is a moving window and a car spawned over the hole falls
   * out of the map forever.
   */
  solidGroundY(x, z, hint = 0) {
    const p = this.physics;
    if (!p?.groundHeight) return null;
    const h = p.groundHeight(x, z, hint + 8);
    if (!Number.isFinite(h) || h < -1e4) return null;
    return Math.abs(h - hint) < 9 ? h : null;
  }

  /**
   * Is this stretch of lane free? Distance-to-nearest-vehicle is not the right
   * test near a kerb: `props` parks up to 0.7 * trafficBudget cars along the
   * street, so at the ultra preset every candidate spawn point had a parked car
   * inside a plain 13 m radius and the spawner starved — measured at four live
   * drivers where fifty were wanted. What matters is whether the LANE is clear.
   */
  laneClear(edge, lane, s, need = 13) {
    const L = this.lanes;
    L.point(edge, lane, s, 0, _v);
    const n = this.grid.build ? this.grid.query(_v.x, _v.z, need + 8) : 0;
    const halfW = 1.6;
    for (let i = 0; i < n; i++) {
      const o = this.grid.list[this.grid.hits[i]];
      L.project(edge, lane, o.position.x, o.position.z, this._proj);
      if (Math.abs(this._proj.lateral) > halfW + o.spec.half.x) continue;
      if (Math.abs(this._proj.s - s) < need) return false;
    }
    return true;
  }

  /** Distance to the nearest live vehicle of any kind. */
  nearestVehicleDist(x, z) {
    let best = Infinity;
    const list = this.vehicles.vehicles;
    for (let i = 0; i < list.length; i++) {
      const p = list[i].position;
      const dx = p.x - x;
      const dz = p.z - z;
      const d = dx * dx + dz * dz;
      if (d < best) best = d;
    }
    return Math.sqrt(best);
  }

  /* ==================================================================== */
  /* The `peds` contract                                                  */
  /* ==================================================================== */

  /**
   * Traffic light phase at a junction node, from the PEDESTRIAN's point of
   * view: 'green' means green for traffic so do not cross, 'red' means every
   * approach is stopped, null means the junction is unsignalised and the ped
   * has to judge the gap itself. `peds/ped.js` reads exactly this.
   */
  lightAt(nodeId) {
    if (!this.lanes.ready) return null;
    return this.signals.lightAt(nodeId);
  }

  /** Full phase for one approach — for the HUD, `police`, and debugging. */
  phaseFor(nodeId, edgeId) {
    if (!this.lanes.ready) return null;
    return this.signals.phaseFor(nodeId, edgeId);
  }

  timeToGreen(nodeId, edgeId) {
    if (!this.lanes.ready) return 0;
    return this.signals.timeToGreen(nodeId, edgeId);
  }

  /* ==================================================================== */
  /* Frame                                                                */
  /* ==================================================================== */

  fixedUpdate(h, ctx) {
    if (!this.lanes.ready) return;
    if (++this._step % DECIMATE !== 0) return;
    const dt = h * DECIMATE;
    this.tick++;
    const t0 = performance.now();

    this.signals.update(dt);
    if (this.lanes.blocked.size) {
      for (const [id, t] of this.lanes.blocked) {
        if (this.signals.time > t) this.lanes.blocked.delete(id);
      }
    }
    this.grid.build(this.vehicles.vehicles);

    /**
     * Resolved ONCE per tick, and checked against every driver below. The
     * `vehicle:enter` event is the primary handover path, but it lands at the
     * END of the entry animation and `vehicles.setDriver` can be called
     * without it at all (a mission script, `game`'s spawn director). Anything
     * that leaves us steering a car with the player in it is a bug the player
     * feels immediately, so this is checked rather than trusted.
     */
    const pv = this.playerVehicle() ?? this._playerCar;

    for (let i = this.drivers.length - 1; i >= 0; i--) {
      const d = this.drivers[i];
      if (!d.active || !d.vehicle) {
        this.drivers.splice(i, 1);
        continue;
      }
      if (d.vehicle === pv) { this.release(d.vehicle, 'enter'); continue; }
      d.update(dt, ctx);
    }

    const ms = performance.now() - t0;
    this._stats.ms = this._stats.ms * 0.9 + ms * 0.1;
    this._stats.msPerCar = this.drivers.length ? this._stats.ms / this.drivers.length : 0;
  }

  update(dt, ctx) {
    // The graph can arrive long after we boot.
    this._netTimer -= dt;
    if (!this.lanes.ready && this._netTimer <= 0) {
      this._netTimer = 0.5;
      if (!this._attachNet()) return;
    }
    if (!this.lanes.ready) return;

    if (this._holdT > 0) this._holdT -= dt;
    this._pollWorld(dt, ctx);
    this._updateAnchor(ctx);
    this._scanSirens(dt);

    // A teleport (a capture shot, a mission cut) needs the street populated
    // NOW, not over the next twenty seconds. Amortised over a few frames so a
    // whole grid of vehicle models is not built on one of them.
    // A vehicle we are driving can be despawned by whoever else has a claim on
    // it (`props` streams its own parked cars out, `game` cleans up). Driving a
    // handle that is no longer in the scene is a silent leak, so check.
    for (let i = this.drivers.length - 1; i >= 0; i--) {
      const v = this.drivers[i].vehicle;
      if (!v || !v.model?.root?.parent) this.recycle(this.drivers[i], 'gone');
    }

    if (this._fillPending > 0) {
      this._fillPending--;
      if (this.director.fill(ctx, 6)) this._fillPending = 0;
    }

    this.director.step(dt, ctx);
    this.parking.update(dt, ctx);
    this._ageAbandoned(dt, ctx);
    this._seatSweep(ctx);

    this._stats.drivers = this.drivers.length;
    this._stats.parked = this.parking.count;
    this._stats.abandoned = this._abandoned.length;
    this._stats.signals = this.signals.stats.cached;
  }

  /** Indicators. `vehicles` owns the lamp materials but not the intent. */
  lateUpdate() {
    for (let i = 0; i < this.drivers.length; i++) {
      const d = this.drivers[i];
      const m = d.vehicle?.model?.lampMats;
      if (!m?.indicator) continue;
      let want = d.indicate > 0;
      if (!want) {
        // Signal an upcoming turn for the last 28 m of the approach.
        const rem = d._count > 0 ? d._llen[d._slot(0)] - d._s : 999;
        if (rem < 28 && d._count > 1) {
          const L = this.lanes;
          const turn = Math.abs(
            L.yaw(d._edge(1), d._lane(1)) - L.yaw(d._edge(0), d._lane(0))
          );
          want = turn > 0.42 && turn < 3.0;
        }
      }
      if (d.state === DRIVER_STATE.PULLOVER || d.state === DRIVER_STATE.PULLOUT) want = true;
      m.indicator.emissiveIntensity = want && Math.sin(d._indicatePhase) > 0 ? 6.5 : 0;
    }
  }

  _pollWorld(dt, ctx) {
    this._pollTimer = (this._pollTimer ?? 0) - dt;
    if (this._pollTimer > 0) return;
    this._pollTimer = 0.5;
    const sky = ctx.peek('sky');
    if (sky) {
      if (Number.isFinite(sky.timeOfDay)) this.hour = sky.timeOfDay;
      if (Number.isFinite(sky.wetness)) this._setWet(sky.wetness);
    }
  }

  /**
   * Traffic streams around the CAMERA, not the player: a cutscene or a capture
   * shot can put the camera a kilometre from the player's body and the street
   * being looked at is the one that has to be full.
   */
  _updateAnchor(ctx) {
    ctx.camera.getWorldPosition(_c);
    const p = this.player();
    // Prefer the player when the camera is chasing them (the normal case).
    if (p && _c.distanceToSquared(p) < 900) this.anchor.set(p.x, p.y, p.z);
    else this.anchor.copy(_c);

    if (!Number.isFinite(this._lastAnchor.x)) this._lastAnchor.copy(this.anchor);
    const jump = this._lastAnchor.distanceTo(this.anchor);
    this._lastAnchor.copy(this.anchor);
    if (jump > 180) {
      // Teleport: everything we had is in the wrong city block.
      this._flush(ctx);
      this._fillPending = 14;
    }
  }

  /** Drop every live car — used after a teleport. */
  _flush(ctx) {
    for (let i = this.drivers.length - 1; i >= 0; i--) this.recycle(this.drivers[i], 'far');
    for (const a of this._abandoned) this.vehicles.despawn(a.v);
    this._abandoned.length = 0;
    this.parking.dispose();
    this.signals.reset();
  }

  /**
   * Find lit emergency vehicles once every quarter second.
   *
   * A cruiser has to be MOVING to count. A parked-up patrol car with its
   * lightbar on used to freeze every civilian inside 74 m against the kerb
   * permanently — half of them ended up on the pavement, the other half were
   * rear-ended by the traffic still trying to get past, and the block
   * destroyed itself. A siren means "get out of the way of something coming
   * through", not "abandon the road".
   */
  _scanSirens(dt) {
    this._sirenTimer -= dt;
    if (this._sirenTimer > 0) return;
    this._sirenTimer = 0.25;
    this._sirens.length = 0;
    const list = this.vehicles.vehicles;
    for (let i = 0; i < list.length; i++) {
      const v = list[i];
      if ((v.lightbarOn || v.sirenOn) && v.speed > 4) this._sirens.push(v);
    }
    for (let i = 0; i < this._sirens.length; i++) this.yieldFor(this._sirens[i]);
  }

  /**
   * A wreck is scenery, and scenery has a budget. Without a cap they pile up
   * exactly where the trouble is and turn a bad minute into a permanent
   * roadblock. NOTE this runs in `update`, never in an event handler:
   * `vehicle:destroyed` is emitted from inside `vehicles.fixedUpdate`, and
   * despawning there splices the array that its own collision loop is walking.
   */
  _ageAbandoned(dt, ctx) {
    // NEVER delete the car somebody is sitting in. A jacked car reaches this
    // list on the old `abandon()` handover path and on any `vehicle:destroyed`
    // the player was driving through; deleting it mid-drive is the worst bug
    // this function can have.
    const pv = this.playerVehicle() ?? this._playerCar;
    for (let i = this._abandoned.length - 1; i >= 0; i--) {
      if (this._abandoned[i].v === pv) this._abandoned.splice(i, 1);
    }
    while (this._abandoned.length > 5) {
      const old = this._abandoned.shift();
      this.vehicles.despawn(old.v);
    }
    for (let i = this._abandoned.length - 1; i >= 0; i--) {
      const a = this._abandoned[i];
      a.t += dt;
      const p = a.v.position;
      const far = Math.hypot(p.x - this.anchor.x, p.z - this.anchor.z) > TUNE.despawnR;
      if (a.t > 45 && far) {
        this.vehicles.despawn(a.v);
        this._abandoned.splice(i, 1);
      }
    }
  }

  /* ==================================================================== */
  /* Telemetry                                                            */
  /* ==================================================================== */

  /**
   * A snapshot the headless harness asserts on. Deliberately plain data:
   * positions, speeds, lateral error, the reason each car is doing what it is
   * doing. `src/traffic/harness.mjs` runs the sim for minutes and looks for
   * intersecting cars, cars off the carriageway, cars stopped forever,
   * junctions with no throughput, speeding, and oscillating steering.
   */
  sample() {
    const out = {
      t: this.signals.time,
      hour: +this.hour.toFixed(2),
      target: this.director.target,
      cars: [],
      parked: this.parking.count,
      abandoned: this._abandoned.length,
      ms: +this._stats.ms.toFixed(3),
      horns: this._stats.horns,
      spawns: this._stats.spawns,
      recycled: this._stats.recycled,
    };
    for (let i = 0; i < this.drivers.length; i++) {
      const d = this.drivers[i];
      const v = d.vehicle;
      if (!v) continue;
      const e = d._count > 0 ? d._edge(0) : null;
      out.cars.push({
        id: d.id,
        type: v.type,
        x: +v.position.x.toFixed(2),
        z: +v.position.z.toFixed(2),
        y: +v.position.y.toFixed(2),
        hw: +v.spec.half.x.toFixed(2),
        hl: +v.spec.half.z.toFixed(2),
        v: +v.forwardSpeed.toFixed(2),
        state: d.state,
        lat: +d.diag.lat.toFixed(2),
        half: e ? +this.lanes.halfWidth(e).toFixed(2) : 0,
        kind: e ? e.kind : '?',
        limit: e ? +this.lanes.limit(e).toFixed(1) : 0,
        target: +d.diag.targetSpeed.toFixed(2),
        gap: d.diag.gap === Infinity ? -1 : +d.diag.gap.toFixed(2),
        reason: d.diag.reason,
        steer: +d.diag.steer.toFixed(3),
        slip: +((v.slipAngle * 180) / Math.PI).toFixed(1),
        grounded: v.grounded,
      });
    }
    return out;
  }

  get stats() {
    return this._stats;
  }

  /** Dev overlay one-liner. */
  debugText() {
    const s = this._stats;
    return `traffic ${s.drivers}/${this.director.target} parked ${s.parked} ` +
      `${s.ms.toFixed(2)}ms (${(s.msPerCar * 1000).toFixed(0)}us/car)`;
  }

  dispose() {
    for (const off of this._offs ?? []) off?.();
    this._offs = null;
    for (let i = this.drivers.length - 1; i >= 0; i--) this.recycle(this.drivers[i], 'far');
    for (const a of this._abandoned) this.vehicles?.despawn(a.v);
    this._abandoned.length = 0;
    this.parking?.dispose();
    this.grid?.clear();
    for (const v of [...this._seated]) this._unseatPed(v);
    this._seated.clear();
    this._byVehicle.clear();
    this._playerCar = null;
    this._pool.length = 0;
  }
}

export { Driver, DRIVER_STATE, LaneNet, SignalNet };
