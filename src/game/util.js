/**
 * GAME — the world adapter.
 *
 * Everything the mission layer needs to ask about Steel City, in one place, so
 * no track implementation has to know which subsystem answers which question or
 * what to do when one of them is still a stub.
 *
 * ARCHITECTURE.md rule 2: nothing here imports another subsystem. Every query
 * goes through `ctx.peek(id)` and every one has a defined answer when the
 * subsystem is missing — that is what lets the mission harness run a whole
 * chapter before `police` has landed.
 *
 * Rule 5: this module allocates nothing after `init`. All the Vector3s are
 * preallocated scratch; anything that returns a point returns a reused `{x,z}`
 * record unless the caller passes an `out`.
 */

import * as THREE from 'three';
import { POI, SAFEHOUSES, SHOPS, SHOPS_BY_KIND, GAS_STATIONS } from './data.js';

const TAU = Math.PI * 2;

export const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
export const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
export const lerp = (a, b, t) => a + (b - a) * t;

/** Shortest signed difference between two angles. */
export function wrapAngle(a) {
  a = (a + Math.PI) % TAU;
  if (a < 0) a += TAU;
  return a - Math.PI;
}

export function dist2(ax, az, bx, bz) {
  const dx = ax - bx;
  const dz = az - bz;
  return dx * dx + dz * dz;
}

export function dist(ax, az, bx, bz) {
  return Math.sqrt(dist2(ax, az, bx, bz));
}

/** mm:ss for a mission clock. */
export function clockText(sec) {
  const s = Math.max(0, Math.ceil(sec));
  const m = Math.floor(s / 60);
  return `${m}:${String(s % 60).padStart(2, '0')}`;
}

const _q = new THREE.Quaternion();
const _e = new THREE.Euler(0, 0, 0, 'YXZ');

/** Heading of a vehicle handle, radians, +Z forward to match `Math.atan2(dx,dz)`. */
export function yawOf(v) {
  if (!v?.quaternion) return 0;
  _q.copy(v.quaternion);
  _e.setFromQuaternion(_q, 'YXZ');
  return _e.y;
}

/**
 * Steer an AI-driven vehicle toward a point. The one place any mission actor
 * decides how to hold a wheel, so a rival, a fleeing target, an escort truck
 * and a boss all drive with the same physics-respecting logic.
 *
 * @param {object} veh   the `vehicles` subsystem
 * @param {object} v     the vehicle handle
 * @param {object} inp   a PREALLOCATED input record, reused by the caller
 */
export function driveToward(veh, v, inp, tx, tz, opts = {}) {
  if (!veh?.setInput || !v || v.destroyed) return 0;
  const dx = tx - v.position.x;
  const dz = tz - v.position.z;
  const d = Math.hypot(dx, dz);
  const err = wrapAngle(Math.atan2(dx, dz) - yawOf(v));
  const speed = Math.abs(v.forwardSpeed ?? 0);
  const slowRadius = opts.slow ?? 0;
  inp.steer = clamp(err * (opts.gain ?? 1.6), -1, 1);
  // Back off the throttle for a corner: full lock at 30 m/s just understeers.
  const corner = 1 - Math.min(0.72, Math.abs(err) * (speed / 34));
  inp.throttle = clamp((opts.throttle ?? 1) * corner, 0, 1);
  inp.brake = slowRadius > 0 && d < slowRadius ? clamp(1 - d / slowRadius, 0, 0.85) : 0;
  inp.handbrake = Math.abs(err) > 1.75 && speed > 15;
  inp.boost = !!opts.boost && Math.abs(err) < 0.5;
  veh.setInput(v, inp);
  return d;
}

export class WorldQuery {
  constructor(ctx) {
    this.ctx = ctx;
    this.rng = ctx.rng.fork();

    this._v = new THREE.Vector3();
    this._v2 = new THREE.Vector3();
    this._spot = { x: 0, y: 0, z: 0, yaw: 0, ok: false };
    this._spot2 = { x: 0, y: 0, z: 0, yaw: 0, ok: false };
    this._playerPos = new THREE.Vector3();
    this._half = 1400; // resolved from world.CITY_SIZE at init
  }

  init() {
    const w = this.world;
    if (w?.CITY_SIZE) this._half = w.CITY_SIZE / 2 - 60;
    return this;
  }

  /* ------------------------------------------------------------ systems -- */

  get world() { return this.ctx.peek('world'); }
  get player() { return this.ctx.peek('player'); }
  get vehicles() { return this.ctx.peek('vehicles'); }
  get peds() { return this.ctx.peek('peds'); }
  get police() { return this.ctx.peek('police'); }
  get traffic() { return this.ctx.peek('traffic'); }
  get ui() { return this.ctx.peek('ui'); }
  get audio() { return this.ctx.peek('audio'); }
  get physics() { return this.ctx.peek('physics'); }
  get weapons() { return this.ctx.peek('weapons'); }

  /* ------------------------------------------------------------- ground -- */

  /**
   * Best available floor height. `physics.groundHeight` casts against the real
   * static world (so it lands on a bridge deck, not the river below it);
   * `world.heightAt` is the analytic terrain fallback.
   */
  groundY(x, z, fromY = 260) {
    const ph = this.physics;
    if (ph?.groundHeight) {
      const h = ph.groundHeight(x, z, fromY);
      if (Number.isFinite(h) && h > -500) return h;
    }
    const w = this.world;
    if (w?.heightAt) {
      const h = w.heightAt(x, z);
      if (Number.isFinite(h)) return h;
    }
    return 0;
  }

  isWater(x, z) {
    return this.world?.isWater?.(x, z) === true;
  }

  surfaceAt(x, z) {
    return this.world?.surfaceAt?.(x, z) ?? 'asphalt';
  }

  inBounds(x, z) {
    return Math.abs(x) < this._half && Math.abs(z) < this._half;
  }

  districtName(x, z) {
    return this.world?.districtAt?.(x, z)?.name ?? '';
  }

  /* ------------------------------------------------------------- player -- */

  /** Live player position (feet). Copied into scratch — safe to keep for a frame. */
  playerPos(out = this._playerPos) {
    const p = this.player;
    const src = p?.position ?? p?.getPosition?.();
    if (src && Number.isFinite(src.x)) return out.copy(src);
    return out.copy(this.ctx.camera.position);
  }

  /** Where the mission should measure from: the car if he is in one, else him. */
  focusPos(out = this._playerPos) {
    const p = this.player;
    if (p?.inVehicle && p.vehicle?.position) return out.copy(p.vehicle.position);
    return this.playerPos(out);
  }

  playerVehicle() {
    const p = this.player;
    return p?.inVehicle ? p.vehicle ?? null : null;
  }

  /**
   * Put the player's feet at (x, z) on the ground, facing `yaw`.
   *
   * `player.teleport` takes an EYE position — feet + stand-eye * body scale.
   *
   * He is dropped out of any vehicle first, and that is not a nicety. While
   * `player.inVehicle` is true, `focusPos` (and the camera, and every mission
   * distance check) reads the VEHICLE's position, not his — so teleporting a
   * seated player leaves the game measuring from a car that is still parked
   * a kilometre away. That is what made a `chase` staged at the boathouse
   * report "the target got away" on its first frame.
   */
  placePlayer(x, z, yaw = 0, yOverride = null) {
    const p = this.player;
    if (!p) return false;
    if (p.inVehicle) p.vehicles?.abort?.(p.movement);
    const y = yOverride ?? this.groundY(x, z) + 0.06;
    if (p.movement?.teleport) {
      p.movement.teleport(x, y, z, yaw);
      p.rig?.reset?.(p.movement.anchorHeight, p.movement.position, yaw);
      return true;
    }
    if (p.teleport) {
      const scale = p.brother?.build?.scale ?? 1;
      this._v.set(x, y + 1.66 * scale, z);
      p.teleport(this._v, yaw);
      return true;
    }
    return false;
  }

  /* ---------------------------------------------------------------- POI -- */

  poi(id) {
    return POI.get(id) ?? null;
  }

  nearestOf(list, x, z) {
    let best = null;
    let bd = Infinity;
    for (let i = 0; i < list.length; i++) {
      const d = dist2(x, z, list[i].x, list[i].z);
      if (d < bd) { bd = d; best = list[i]; }
    }
    if (!best) return null;
    this._near ??= { poi: null, dist: 0 };
    this._near.poi = best;
    this._near.dist = Math.sqrt(bd);
    return this._near;
  }

  nearestSafehouse(x, z) { return this.nearestOf(SAFEHOUSES, x, z); }
  nearestGas(x, z) { return this.nearestOf(GAS_STATIONS, x, z); }
  nearestShop(x, z, kind) {
    // NOTE: `nearestOf` returns a REUSED record. Read `.poi`/`.dist` off it
    // before calling this again or the second call overwrites the first.
    return this.nearestOf(kind ? (SHOPS_BY_KIND[kind] ?? SHOPS) : SHOPS, x, z);
  }

  /* --------------------------------------------------------- spawn spots -- */

  /**
   * A dry, road-adjacent point in an annulus around `(cx, cz)`.
   *
   * The annulus radii come in as real metres and the road test goes through
   * the road graph, so a mission car spawns ON a lane rather than in somebody's
   * front room.
   */
  findRoadSpot(min, max, cx, cz, out = this._spot) {
    const roads = this.world?.roads;
    out.ok = false;
    for (let i = 0; i < 120; i++) {
      const a = this.rng.float() * TAU;
      const r = lerp(min, max, this.rng.float());
      const x = cx + Math.cos(a) * r;
      const z = cz + Math.sin(a) * r;
      if (!this.inBounds(x, z) || this.isWater(x, z)) continue;
      if (!roads?.nearestEdge) {
        out.x = x; out.z = z; out.y = this.groundY(x, z); out.yaw = a; out.ok = true;
        return out;
      }
      const hit = roads.nearestEdge(x, z, 40);
      if (!hit?.edge) continue;
      // Snap onto the lane centre so nothing spawns half on the kerb.
      if (roads.laneCenter) {
        const t = clamp01(typeof hit.t === 'number' ? hit.t : 0.5);
        roads.laneCenter(hit.edge.id ?? hit.edge, hit.lane ?? 0, t, this._v);
        if (this.isWater(this._v.x, this._v.z)) continue;
        out.x = this._v.x;
        out.z = this._v.z;
        out.yaw = roads.laneYaw ? roads.laneYaw(hit.edge, hit.lane ?? 0) : a;
      } else {
        out.x = x; out.z = z; out.yaw = a;
      }
      out.y = this.groundY(out.x, out.z);
      out.ok = true;
      return out;
    }
    // Nothing legal found — fall back to a jittered point near the anchor so a
    // mission still starts rather than silently spawning nothing.
    const a = this.rng.float() * TAU;
    out.x = cx + Math.cos(a) * min;
    out.z = cz + Math.sin(a) * min;
    out.y = this.groundY(out.x, out.z);
    out.yaw = a;
    out.ok = false;
    return out;
  }

  /** A dry point that need not be near a road — crates, enemies, hold points. */
  findGroundSpot(min, max, cx, cz, out = this._spot2) {
    out.ok = false;
    for (let i = 0; i < 140; i++) {
      const a = this.rng.float() * TAU;
      const r = lerp(min, max, this.rng.float());
      const x = cx + Math.cos(a) * r;
      const z = cz + Math.sin(a) * r;
      if (!this.inBounds(x, z) || this.isWater(x, z)) continue;
      if (this.world?.isOpen && !this.world.isOpen(x, z, 1.2)) continue;
      out.x = x; out.z = z; out.y = this.groundY(x, z); out.yaw = a; out.ok = true;
      return out;
    }
    out.x = cx; out.z = cz; out.y = this.groundY(cx, cz); out.yaw = 0;
    return out;
  }

  /**
   * A point ON a river — Carson's salvage crates and the boat deliveries.
   *
   * `nearShore` matters more than it looks: a boat moored in the middle of the
   * Mon is a boat you cannot get to on foot, and Carson's first chapter is a
   * boat delivery. When it is set the point must have dry land within
   * `SHORE_REACH`, which is what makes the mission reachable.
   */
  findWaterSpot(min, max, cx, cz, out = this._spot2, nearShore = false) {
    out.ok = false;
    for (let i = 0; i < 220; i++) {
      const a = this.rng.float() * TAU;
      const r = lerp(min, max, this.rng.float());
      const x = cx + Math.cos(a) * r;
      const z = cz + Math.sin(a) * r;
      if (!this.inBounds(x, z)) continue;
      if (!this.isWater(x, z)) continue;
      if (nearShore && !this._shoreWithin(x, z, SHORE_REACH)) continue;
      out.x = x; out.z = z; out.y = 0; out.yaw = a; out.ok = true;
      return out;
    }
    if (nearShore) return this.findWaterSpot(min, max, cx, cz, out, false);
    // No water within reach: fall back to the nearest dock, which is on water
    // by construction.
    const d = this.nearestOf(
      [{ x: -88, z: 280 }, { x: -24, z: -264 }, { x: -744, z: -88 }], cx, cz
    );
    out.x = d.poi.x; out.z = d.poi.z; out.y = 0; out.yaw = 0;
    return out;
  }

  /** Is there dry land within `r` of this water point? Eight-way probe. */
  _shoreWithin(x, z, r) {
    for (let k = 0; k < 8; k++) {
      const a = (k / 8) * TAU;
      if (!this.isWater(x + Math.cos(a) * r, z + Math.sin(a) * r)) return true;
    }
    return false;
  }

  /** Kerbside pose next to a POI — where a mission or safehouse car appears. */
  curbSpot(x, z, out = this._spot) {
    return this.findRoadSpot(14, 70, x, z, out);
  }

  /* ------------------------------------------------------------ vehicles -- */

  /**
   * Spawn a mission vehicle. Returns the handle or null. `type` is a
   * `vehicles` class id: sports muscle sedan van truck police bike boat.
   */
  spawnVehicle(type, x, z, yaw = 0, opts) {
    const veh = this.vehicles;
    if (!veh?.spawn) return null;
    const water = type === 'boat';
    const y = water ? (veh.waterHeightAt?.(x, z) ?? 0) + 0.4 : this.groundY(x, z) + 0.6;
    this._v.set(x, y, z);
    return veh.spawn(type, this._v, yaw, opts ?? EMPTY_OPTS);
  }

  despawnVehicle(v, opts) {
    if (v) this.vehicles?.despawn?.(v, opts);
  }

  damageVehicle(v, amount, point) {
    if (v && !v.destroyed) this.vehicles?.damage?.(v, amount, point);
  }

  /* -------------------------------------------------------------- audio -- */

  sfx(kind, position, opts) {
    const a = this.audio;
    if (!a?.play) return;
    try { a.play(kind, position ?? null, opts); } catch { /* optional feedback */ }
  }

  uiSfx(id, gain = 1) {
    const a = this.audio;
    if (!a) return;
    try {
      if (a.playUi) a.playUi(id, gain);
      else if (a.ui) a.ui(id, gain);
    } catch { /* optional feedback */ }
  }
}

const EMPTY_OPTS = Object.freeze({});

/** How far a moored boat may sit from a bank and still be walkable-to. */
const SHORE_REACH = 22;
