/**
 * POLICE — the wanted system and everything that enforces it.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * PUBLIC API — `const pol = ctx.get('police')`
 * ────────────────────────────────────────────────────────────────────────────
 *   reportCrime(kind, position, severity)  raise heat. See CRIME_HEAT in tune.js
 *   clearWanted(reason)                    Rustbelt Respray / mission script
 *   setWanted(level)                       force a star level
 *   spawnCop(crooked, opts)                one foot cop near the player, out of
 *                                          view. crooked=true is the copwar
 *                                          variant: purple-accent uniform,
 *                                          hostile at any wanted level, death
 *                                          raises NO heat. Returns
 *                                          { officer, ped, crooked, x, z }|null
 *   fireEnabled / ramEnabled               kill-switches for officer gunfire /
 *                                          the scripted ram (missions, harness
 *                                          negative controls)
 *   releaseVehicle(v)                      this cruiser is not ours any more —
 *                                          drop the unit, despawn NOTHING.
 *                                          Wired to `vehicle:enter`; see the
 *                                          method for why it is the difference
 *                                          between an escapable wanted level
 *                                          and a permanent one.
 *   isPlayerCar(v)                         is the player in/driving it — the
 *                                          guard on every despawn path here
 *   wanted        0..5          · cooldown 0..1 · hunting bool
 *   cops          [{ position, heading }]  for the minimap
 *   getHudState() { wanted, cooldown, hunting, cops }
 *   searchCentre / searchRadius            the cordon, for anything that draws it
 *   debugStage(name)                       'pursuit' | 'roadblock' | 'busted' |
 *                                          'air' | 'none'
 *   sample()                               plain telemetry for the harness
 *
 * EVENTS EMITTED
 *   wanted:change { level, prev }          on every integer star change
 *   wanted:heat   { position, radius }     ~2 Hz while hunting: where they think
 *                                          you are and how wide the sweep is
 *   police:busted { position, officer }    an officer completed an arrest
 *   police:officer:down { position, crooked, officer }
 *                                          exactly once per officer death,
 *                                          whatever killed him. `game` pays
 *                                          respect/cash off it; the copwar job
 *                                          counts the crooked ones. (Needs an
 *                                          ARCHITECTURE.md table row — that
 *                                          file is lead-owned.)
 *   camera:shake  { amount, position }     scripted cruiser ram impact, 0.25
 *                                          per hit. The player camera may not
 *                                          consume it yet; emitted regardless.
 *   weapon:fire / bullet:tracer / damage:dealt / bullet:impact
 *                                          officer gunfire and ram FX through
 *                                          the canonical combat vocabulary.
 *                                          Police-emitted `weapon:fire` carries
 *                                          `police: true` so nobody prices it
 *                                          as the player's crime.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * WHAT LIVES WHERE
 *   tune.js       every constant, including the crime price list
 *   wanted.js     the meter: heat, the cordon, line-of-sight decay, respray
 *   unit.js       one cruiser: pursuit driving on the real dynamics model
 *   path.js       road-graph routes with the racing line cut toward the centre
 *   tactics.js    the squad brain: who tails, who intercepts, who PITs
 *   roadblock.js  blocks, spike strips, and closing the bridges at five stars
 *   officer.js    cops on foot, borrowed from the `peds` population
 *   heli.js       the four-star spotter
 *   dispatch.js   the spawn director: out of sight, ahead of you, on budget
 *   harness.mjs   headless behaviour tests — run it, it finds real bugs
 *
 * ────────────────────────────────────────────────────────────────────────────
 * THE ONE RULE THAT MAKES THE WANTED LEVEL A GAME
 *
 * Nothing that puts a cop on the street may use the quarry's TRUE position.
 * The dispatcher, the culler, the stand-down, the foot responders, the
 * roadblocks and the helicopter all anchor on `police.searchAnchor` — the last
 * position anybody actually SAW — and the search only knows what `_sight`
 * confirms, at the moment it confirms it. Break any of those and the meter
 * stops being escapable while still looking correct from every screenshot:
 * measured, a fresh cruiser spawned 90-260 m from the truth every 1.1 s, drove
 * at it, re-acquired, and held five stars through a 46 s escape 1.1 km out of
 * every cone.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * BUDGET
 * `traffic` sizes its population from `q.trafficBudget` and its own grid.js
 * documents that police sit ON TOP of that number. So this system caps its
 * fleet at `TUNE.budgetShare` (30%) of the same figure, never exceeds
 * `TUNE.fleetCeil`, and when the combined vehicle count would pass the ceiling
 * it asks `traffic.recycleFarthest()` for a slot through its public API rather
 * than silently overshooting. Officers are capped at ~28% of `q.pedBudget`.
 */

import * as THREE from 'three';
import { WantedModel } from './wanted.js';
import { Unit, ROLE } from './unit.js';
import { assignRoles } from './tactics.js';
import { BlockManager } from './roadblock.js';
import { OfficerPool } from './officer.js';
import { Helicopter } from './heli.js';
import { Dispatch } from './dispatch.js';
import { TUNE, POLICE_DIFF, clamp, clamp01 } from './tune.js';

/** Rustbelt Respray — DESIGN.md shop list. */
const RESPRAY = { x: -336, z: 176, r: 11 };

/** Control rate: every Nth 120 Hz fixed step. 120 / 2 = 60 Hz, as traffic. */
const DECIMATE = 2;

const _v = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _cam = new THREE.Vector3();
const _fwd = new THREE.Vector3();

/**
 * Whoever the police are after. Normally the player; the harness and the
 * staged tableaux point it somewhere else, which is also how a mission would
 * sic the cops on an NPC.
 */
class Quarry {
  constructor() {
    this.position = new THREE.Vector3();
    this.velocity = new THREE.Vector3();
    this.forward = new THREE.Vector3(0, 0, 1);
    this.heading = 0;
    this.speed = 0;
    this.halfLength = 2.4;
    this.vehicle = null;
    this.inVehicle = false;
    this.valid = false;
    this.stillTime = 0;
  }

  right(out) {
    return out.set(-this.forward.z, 0, this.forward.x);
  }

  refresh(sys, dt) {
    const override = sys._quarryOverride;
    const player = sys.playerSys;
    let veh = null;
    let pos = null;
    let vel = null;
    let yaw = null;

    if (override) {
      veh = override.vehicle ?? null;
      pos = veh ? veh.position : override.position;
      vel = veh ? veh.velocity : override.velocity;
    } else if (player) {
      veh = player.vehicle ?? player.currentVehicle ?? null;
      if (veh?.destroyed) veh = null;
      pos = veh ? veh.position : player.position;
      vel = veh ? veh.velocity : player.velocity;
      if (!veh) yaw = player.yaw;
    }

    if (!pos || !Number.isFinite(pos.x)) {
      this.valid = false;
      this.vehicle = null;
      this.inVehicle = false;
      return;
    }

    this.valid = true;
    this.position.copy(pos);
    if (vel && Number.isFinite(vel.x)) this.velocity.set(vel.x, 0, vel.z);
    else this.velocity.set(0, 0, 0);
    this.speed = Math.hypot(this.velocity.x, this.velocity.z);
    this.vehicle = veh;
    this.inVehicle = !!veh;
    this.halfLength = veh?.spec?.half?.z ?? 0.45;

    if (veh) {
      const q = veh.quaternion;
      this.forward.set(2 * (q.x * q.z + q.w * q.y), 0, 1 - 2 * (q.x * q.x + q.y * q.y));
      if (this.forward.lengthSq() < 1e-6) this.forward.set(0, 0, 1);
      this.forward.normalize();
    } else if (yaw !== null && Number.isFinite(yaw)) {
      this.forward.set(Math.sin(yaw), 0, Math.cos(yaw));
    } else if (this.speed > 0.4) {
      this.forward.copy(this.velocity).multiplyScalar(1 / this.speed);
    }
    this.heading = Math.atan2(this.forward.x, this.forward.z);
    this.stillTime = this.speed < 1.4 ? this.stillTime + dt : 0;
  }
}

export class PoliceSystem {
  static id = 'police';
  static deps = ['world', 'vehicles', 'peds'];

  async init(ctx) {
    this.ctx = ctx;
    this.rng = ctx.rng.fork();

    this.meter = new WantedModel(ctx);
    this.quarry = new Quarry();
    this.units = [];
    this._pool = [];
    this.officers = new OfficerPool(this);
    this.blocks = new BlockManager(this);
    this.blocks.attach(ctx);
    this.heli = new Helicopter(this);
    this.dispatch = new Dispatch(this);

    this._step = 0;
    this._losTimer = 0;
    this._tacticsTimer = 0;
    this._seen = false;
    /** Star floor owed for a cruiser taken this tick. See the `vehicle:enter`
     *  wiring; settled at the top of `update`. */
    this._theftStar = 0;
    this._resprayTimer = 0;
    this._panicTimer = 0;
    this._staged = null;
    this._stagedVehicles = [];
    this._quarryOverride = null;
    this._runners = [];
    this._debugFollow = false;
    this.gripScale = 1;

    /* preallocated scratch — nothing below allocates per frame */
    this._rayA = new THREE.Vector3();
    this._rayB = new THREE.Vector3();
    /** Where the quarry was at the last confirmed sighting. See `_sight`. */
    this._seenPos = new THREE.Vector3();
    this._seenBy = '';
    this._cops = [];
    for (let i = 0; i < TUNE.fleetCeil + 2; i++) {
      this._cops.push({ position: new THREE.Vector3(), heading: 0, kind: 'cop' });
    }
    this._copCount = 0;
    this._hud = { wanted: 0, cooldown: 1, hunting: false, cops: null };
    this._bustPayload = { position: new THREE.Vector3(), officer: null };
    this._crimeCool = new Map();
    this._playerFiredAt = -99;
    this._sample = null;

    /* ---- combat ---- */
    /** Test/mission hooks: cut officer gunfire or the scripted ram without
     *  touching the rest of the response. The harness uses both as negative
     *  controls. */
    this.fireEnabled = true;
    this.ramEnabled = true;
    this._diff = POLICE_DIFF.normal;
    this._diffTimer = 0;
    this.stats = { shots: 0, hits: 0, rams: 0, downs: 0, footSpawns: 0 };
    /* preallocated combat payloads — one shot per ~1.5 s per officer, but the
     * rule is the rule: nothing allocates per event */
    this._firePayload = {
      weapon: 'pistol',
      origin: new THREE.Vector3(),
      dir: new THREE.Vector3(),
      seed: 0,
      /** Marks the event as police gunfire so our own `weapon:fire` crime
       *  listener (and anything else attributing shots to the player) can
       *  skip it. */
      police: true,
    };
    this._tracerPayload = { from: new THREE.Vector3(), to: new THREE.Vector3(), speed: TUNE.fire.tracerSpeed };
    this._hitPayload = { target: null, amount: 0, headshot: false, killed: false, point: new THREE.Vector3(), from: new THREE.Vector3() };
    this._downPayload = { position: new THREE.Vector3(), crooked: false, officer: null };
    this._ramImpact = { point: new THREE.Vector3(), normal: new THREE.Vector3(), surface: 'metal', incident: new THREE.Vector3(), damage: 0 };
    this._shakePayload = { amount: 0, position: new THREE.Vector3() };
    this._footTimer = 0;

    this._wire(ctx);

    const cap = Math.min(
      TUNE.fleetCeil,
      Math.floor((ctx.config.q.trafficBudget ?? 24) * TUNE.budgetShare)
    );
    console.info(
      `[police] wanted 0-5 · fleet cap ${cap} cruisers (${TUNE.budgetShare * 100}% of ` +
      `trafficBudget ${ctx.config.q.trafficBudget}) · officer cap ${this.officers.max}`
    );
  }

  /* ==================================================================== */
  /* Runtime lookups — never import another subsystem, ask for it         */
  /* ==================================================================== */

  _sys(key, id) {
    if (this[key] === undefined) this[key] = this.ctx.peek(id) ?? null;
    return this[key];
  }

  get world() { return this._sys('_world', 'world'); }
  get vehicles() { return this._sys('_vehicles', 'vehicles'); }
  get traffic() { return this._sys('_traffic', 'traffic'); }
  get peds() { return this._sys('_peds', 'peds'); }
  get physics() { return this._sys('_physics', 'physics'); }
  get playerSys() { return this._sys('_player', 'player'); }
  get audio() { return this._sys('_audio', 'audio'); }
  get ui() { return this._sys('_ui', 'ui'); }
  get roads() { return this.world?.roads ?? null; }
  get level() { return this.meter.level; }

  /* ==================================================================== */
  /* Public API                                                           */
  /* ==================================================================== */

  /**
   * Raise the heat. `kind` is a key of CRIME_HEAT (tune.js); anything unknown
   * is priced as reckless driving so a typo is never free.
   */
  reportCrime(kind, position, severity = 1, opts = {}) {
    if (this._staged) return 0;
    const seenByCop = opts.seenByCop ?? this._seen;
    let witnessed = opts.witnessed;
    if (witnessed === undefined && position) witnessed = this._anyWitness(position);
    return this.meter.report(kind, position ?? this.quarry.position, severity, {
      seenByCop,
      witnessed,
    });
  }

  /** Clear all heat — Rustbelt Respray, a mission, or a bust. */
  clearWanted(reason = 'respray') {
    // A respray or an arrest cancels a star still owed for a theft a fraction
    // of a second ago; handing it back on the next tick would read as the
    // shop not working.
    this._theftStar = 0;
    const prev = this.meter.clear(reason);
    this._standDownAll();
    return prev;
  }

  setWanted(level) {
    this.meter.set(level);
  }

  /**
   * THE star level, as a NUMBER. `ui` reads `police.wanted` every frame and
   * feeds it straight into `clamp(level | 0, 0, 5)`, so this must never be an
   * object — the first version stored the WantedModel here and the HUD showed
   * zero stars through an entire five-star chase because `{...} | 0` is 0.
   */
  get wanted() { return this.meter.level; }
  get cooldown() { return this.meter.cooldown; }
  get hunting() { return this.meter.hunting; }
  get searchCentre() { return this.meter.known; }
  get searchRadius() { return this.meter.cordon; }

  /**
   * WHERE THE POLICE THINK YOU ARE — and the ONLY position anything that puts a
   * car on the street is allowed to use.
   *
   * This is the difference between a wanted level you can escape and one you
   * cannot. `meter.known` tracks the quarry exactly while somebody has eyes on
   * you and freezes at the last sighting the moment they do not, so anchoring
   * on it costs nothing during a chase and is the whole game once contact is
   * broken.
   *
   * MEASURED before this existed: the dispatcher anchored on `quarry.position`,
   * so with the runner teleported 900-1400 m away, out of every cone, a fresh
   * cruiser was spawned 90-260 m from its TRUE position every 1.1 s, drove
   * straight at it, re-acquired, and reset the evade clock. Over 46 s out of
   * sight the meter never fell a single star, because the police were never
   * actually searching — they were being told the answer. `spawnFootResponder`
   * already did this correctly; the cruiser director, the culler and the
   * roadblock siting did not.
   */
  get searchAnchor() {
    if (this.meter.hasKnown) return this.meter.known;
    return this.quarry.valid ? this.quarry.position : null;
  }

  /** Minimap contacts. A reused array of reused records. */
  get cops() {
    let n = 0;
    for (let i = 0; i < this.units.length && n < this._cops.length; i++) {
      const u = this.units[i];
      if (!u.active || !u.vehicle) continue;
      const c = this._cops[n++];
      c.position.copy(u.vehicle.position);
      c.heading = u.yaw;
      c.kind = 'cop';
    }
    if (this.heli.active && n < this._cops.length) {
      const c = this._cops[n++];
      c.position.copy(this.heli.position);
      c.heading = this.heli.yaw;
      c.kind = 'heli';
    }
    this._copCount = n;
    return this._copSlice(n);
  }

  _copSlice(n) {
    const out = this._copOut ?? (this._copOut = []);
    out.length = 0;
    for (let i = 0; i < n; i++) out.push(this._cops[i]);
    return out;
  }

  getHudState(out = this._hud) {
    out.wanted = this.meter.level;
    out.cooldown = this.meter.cooldown;
    out.hunting = this.meter.hunting;
    out.fill = this.meter.fill;
    out.cops = this.cops;
    out.searchX = this.meter.known.x;
    out.searchZ = this.meter.known.z;
    out.searchR = this.meter.cordon;
    return out;
  }

  /** An officer got their hands on you. */
  bust(officer) {
    if (this.meter.level === 0) return;
    const p = this._bustPayload;
    p.position.copy(officer?.position ?? this.quarry.position);
    p.officer = officer ?? null;
    this.ctx.events.emit('police:busted', p);
    try { this.ui?.notify?.('BUSTED', '', 'bad'); } catch { /* ui optional */ }
    this.clearWanted('busted');
  }

  /* ==================================================================== */
  /* Combat — shared emit paths for officers and the ram                  */
  /* ==================================================================== */

  /** Difficulty multipliers `{ dmg, aggr }`, from `game.difficulty`. */
  get diff() { return this._diff; }

  _pollDifficulty(dt) {
    this._diffTimer -= dt;
    if (this._diffTimer > 0) return;
    this._diffTimer = 2.0;
    // `game.difficulty` is a getter over its save file; guard it — reading a
    // partner system's state must never be able to take this one down.
    let id = null;
    try { id = this.ctx.peek('game')?.difficulty; } catch { id = null; }
    this._diff = POLICE_DIFF[id] ?? POLICE_DIFF.normal;
  }

  /**
   * One aimed shot, on screen and in the ears: `weapon:fire` gives `fx` the
   * muzzle flash (its pooled lights, so the visible point-light count never
   * moves) and `audio` the gunshot; `bullet:tracer` draws the round. The
   * payload carries `police: true` so nothing prices it as the player's crime.
   */
  copShotFx(eye, aim, officer) {
    const f = this._firePayload;
    f.origin.copy(eye);
    f.dir.copy(aim).sub(eye);
    const l = f.dir.length() || 1;
    f.dir.multiplyScalar(1 / l);
    f.seed = (this.rng.float() * 1e6) | 0;
    this.ctx.events.emit('weapon:fire', f);
    const t = this._tracerPayload;
    t.from.copy(eye);
    t.to.copy(aim);
    t.speed = TUNE.fire.tracerSpeed;
    this.ctx.events.emit('bullet:tracer', t);
    this.stats.shots++;
  }

  /** A round that connected with the player on foot. The player's own
   *  `damage:dealt` listener applies it — never applied here as well. */
  copHit(officer, amount, point, from) {
    const player = this.playerSys;
    if (!player || amount <= 0) return;
    const p = this._hitPayload;
    p.target = player;
    p.amount = amount;
    p.headshot = false;
    p.killed = false;
    p.point.copy(point);
    p.point.y += TUNE.fire.targetHeight;
    p.from.copy(from);
    this.ctx.events.emit('damage:dealt', p);
    this.stats.hits++;
  }

  statFire(hit) {
    if (hit) this.stats.hits++;
  }

  /**
   * `police:officer:down { position, crooked, officer }` — fired exactly once
   * per officer death by the pool's transition watch, whatever killed him.
   * `game`'s economy pays respect and the cash drop off it, and the `copwar`
   * job counts the `crooked: true` ones. The killCop/woundCop HEAT is priced
   * separately off `actor:death`/`damage:dealt` (and skipped for crooked).
   */
  officerDown(officer) {
    const p = this._downPayload;
    p.position.copy(officer.position);
    p.crooked = !!officer.crooked;
    p.officer = officer;
    this.ctx.events.emit('police:officer:down', p);
    this.stats.downs++;
  }

  /**
   * The scripted ram payload: vehicle damage through `vehicles.damage()`, a
   * speed cut, metal-impact sparks through the canonical `bullet:impact`
   * (which is what every other metal strike uses for FX and audio), and a
   * `camera:shake { amount, position }` — the player camera may not consume
   * that event yet; it is emitted regardless so the hook exists.
   */
  applyRam(unit, q, nx, nz) {
    const v = unit.vehicle;
    const dmg = (TUNE.ram.base + this.meter.level * TUNE.ram.perStar) * this._diff.dmg;
    const im = this._ramImpact;
    // Contact point: the quarry's near flank, at sill height.
    im.point.set(
      q.position.x - nx * (q.vehicle.spec?.half?.z ?? 2.2) * 0.8,
      q.position.y + 0.55,
      q.position.z - nz * (q.vehicle.spec?.half?.z ?? 2.2) * 0.8
    );
    im.normal.set(-nx, 0.35, -nz).normalize();
    im.incident.set(nx, 0, nz);
    im.damage = dmg;
    try { this.vehicles?.damage?.(q.vehicle, dmg, im.point); }
    catch { /* vehicles may not have booted */ }
    q.vehicle.velocity.multiplyScalar(TUNE.ram.slow);
    this.ctx.events.emit('bullet:impact', im);
    const s = this._shakePayload;
    s.amount = TUNE.ram.shake;
    s.position.copy(im.point);
    this.ctx.events.emit('camera:shake', s);
    this.stats.rams++;
  }

  /* ==================================================================== */
  /* Foot cops — pavement responders and the spawnCop API                 */
  /* ==================================================================== */

  /**
   * PUBLIC API — `police.spawnCop(crooked = false, opts = {})`.
   *
   * Spawns one foot cop on the street near the player (or `opts.at`),
   * respecting the pop-in rules: never inside the camera cone unless distant,
   * never on an unblocked near sightline, never in water.
   *
   *   crooked = false  a regular officer, wired into the wanted system:
   *                    arrests at 1-2 stars, shoots at 2+, killing him is
   *                    priced as killCop.
   *   crooked = true   the copwar variant: purple-accent uniform, hostile
   *                    whatever the wanted level, never arrests, survives
   *                    stand-downs/resprays, and his death raises NO heat.
   *
   *   opts: { at: {x,z}, minDist, maxDist, standoff, force }
   *         `force` skips the officer-pool ceiling (missions), not the peds
   *         budget — `peds` stays the authority on bodies.
   *
   * Returns `{ officer, ped, crooked, x, z }` or null (no free ped / no legal
   * pose). Death is announced as `police:officer:down { crooked, position }`.
   */
  spawnCop(crooked = false, opts = {}) {
    const anchor = opts.at ?? (this.quarry.valid ? this.quarry.position : null);
    if (!anchor) return null;
    const pose = this._footPose(this.ctx, anchor, opts);
    if (!pose) return null;
    const o = this.officers.deployAt(pose, {
      crooked: !!crooked,
      standoff: opts.standoff,
      force: opts.force ?? !!crooked,
    });
    if (!o) return null;
    this.stats.footSpawns++;
    return { officer: o, ped: o.ped, crooked: !!crooked, x: pose.x, z: pose.z };
  }

  /** The foot-dispatch tick — called by `dispatch.step` on its own cadence. */
  spawnFootResponder() {
    const q = this.quarry;
    const level = this.meter.level;
    if (level === 0 || !q.valid) return null;
    // The belief, like every other spawn in this system. See `searchAnchor`.
    const anchor = this.searchAnchor;
    if (!anchor) return null;
    const pose = this._footPose(this.ctx, anchor, {});
    if (!pose) return null;
    const o = this.officers.deployAt(pose, {});
    if (o) this.stats.footSpawns++;
    return o;
  }

  /**
   * A legal pavement pose: sampled off the road graph, pushed to the kerb
   * line, rejected inside the camera cone (unless beyond `foot.viewFar`) and
   * on any unblocked near sightline — the same three tests `dispatch` applies
   * to cruisers, at pedestrian scale.
   */
  _footPose(ctx, anchor, opts) {
    const roads = this.roads;
    if (!roads?.sampleSpawn) return null;
    ctx.camera.getWorldPosition(_cam);
    _fwd.set(0, 0, -1).applyQuaternion(ctx.camera.quaternion);
    _fwd.y = 0;
    if (_fwd.lengthSq() < 1e-6) _fwd.set(0, 0, 1);
    _fwd.normalize();
    const minD = opts.minDist ?? TUNE.foot.minDist;
    const maxD = opts.maxDist ?? TUNE.foot.maxDist;
    const w = this.world;

    for (let i = 0; i < TUNE.foot.tries; i++) {
      const s = roads.sampleSpawn(this.rng, anchor, minD, maxD, (e) => !e.rail);
      if (!s) break;
      // Push from the lane centre to the pavement side of the kerb.
      const yaw = s.yaw;
      const side = this.rng.float() < 0.5 ? -1 : 1;
      const off = (s.edge?.width ?? 7) * 0.5 + 1.4;
      const x = s.position.x + Math.cos(yaw) * side * off;
      const z = s.position.z - Math.sin(yaw) * side * off;
      if (w?.isWater?.(x, z)) continue;
      const surf = w?.surfaceAt?.(x, z);
      if (surf === 'water') continue;

      /* --- the pop-in rule, the way `peds` applies it: visibility, not
       *     distance. Out of the camera cone a person appearing is a person
       *     rounding a corner behind you — legal from 8 m. In the cone it
       *     must be either genuinely occluded or beyond `viewFar`, where the
       *     pop is sub-pixel. --- */
      const dx = x - _cam.x;
      const dz = z - _cam.z;
      const d = Math.hypot(dx, dz);
      if (d < 8) continue;
      const inCone = d > 0 && (dx / d) * _fwd.x + (dz / d) * _fwd.z > TUNE.spawnViewCos;
      if (inCone && d < TUNE.foot.viewFar) {
        if (d < 60) continue;
        this._rayB.set(x, this.groundAt(x, z, _cam.y + 20) + 1.5, z);
        if (this.rayVisible(_cam, this._rayB, 0)) continue;
      }

      const y = this.groundAt(x, z, _cam.y + 30);
      _v.set(x, y, z);
      return _v;
    }
    return null;
  }

  /* ==================================================================== */
  /* Frame                                                                */
  /* ==================================================================== */

  fixedUpdate(h, ctx) {
    if (this._staged) return;
    if (++this._step % DECIMATE !== 0) return;
    const dt = h * DECIMATE;
    for (let i = 0; i < this.units.length; i++) {
      const u = this.units[i];
      if (u.active) u.update(dt, ctx);
    }
    for (let i = 0; i < this._runners.length; i++) {
      const r = this._runners[i];
      if (r.active) r.update(dt, ctx);
    }
  }

  /** Nearest live cruiser to a point — the runner uses it to pick a direction. */
  nearestUnitTo(p) {
    let best = null;
    let bd = Infinity;
    for (const u of this.units) {
      if (!u.active || !u.vehicle) continue;
      const d = (u.vehicle.position.x - p.x) ** 2 + (u.vehicle.position.z - p.z) ** 2;
      if (d < bd) { bd = d; best = u; }
    }
    return best;
  }

  update(dt, ctx) {
    if (this._staged) {
      // A staged tableau must be STILL: the capture harness pumps hundreds of
      // frames waiting for the city to stream in, and anything that drives
      // would have crashed into the camera long before the shutter.
      this.officers.update(0);
      // ...but the searchlight's ground pool is one of the renderer's per-frame
      // punctual slots, and a slot that is not resubmitted is a slot that is
      // lost. Without this the staged air shot photographs an unlit street.
      if (this.heli.active) this.heli.beamFrame(ctx);
      return;
    }

    /* A cruiser was taken since the last tick: settle the star it costs now
     * that every other listener on `vehicle:enter` has had its turn. */
    if (this._theftStar) {
      const want = this._theftStar;
      this._theftStar = 0;
      if (this.meter.level < want) this.meter.set(want);
    }

    this.quarry.refresh(this, dt);
    if (this._debugFollow) this._followCamera(ctx);
    this._pollWeather(dt, ctx);
    this._pollDifficulty(dt);
    this._sight(dt);
    // Seen: the position AT the sighting (`_seenPos`, see `_sight`). Unseen:
    // the real one, because the meter's remaining use for it is the inside-the-
    // cordon test that decides whether you are escaping or hiding.
    this.meter.update(
      dt,
      this._seen ? this._seenPos : (this.quarry.valid ? this.quarry.position : null),
      this._seen,
      this.quarry.valid ? this.quarry.velocity : null
    );

    this._tacticsTimer -= dt;
    if (this._tacticsTimer <= 0) {
      this._tacticsTimer = 1 / TUNE.tacticsHz;
      assignRoles(this);
    }

    this.dispatch.step(dt, ctx);
    this.blocks.update(dt, ctx);
    this._deployOfficers(dt);
    this.officers.update(dt);
    this._air(dt, ctx);
    this._respray(dt);
    this._panic(dt);

    if (this.meter.level === 0 && (this.units.length || this.officers.lawCount)) this._standDownAll();
  }

  _pollWeather(dt, ctx) {
    this._wetTimer = (this._wetTimer ?? 0) - dt;
    if (this._wetTimer > 0) return;
    this._wetTimer = 0.6;
    const sky = ctx.peek('sky');
    const wet = Number.isFinite(sky?.wetness) ? sky.wetness : 0;
    // Police drive harder than civilians in the wet, but not by much: 9% off
    // at soaked against traffic's 15%.
    this.gripScale = 1 - clamp01(wet) * 0.09;
  }

  /* ==================================================================== */
  /* Sight                                                                */
  /* ==================================================================== */

  /**
   * Who can see the quarry, right now. This is THE input to the wanted model:
   * `seen` false is the only thing that lets the meter fall, so it has to be
   * honest — a cone, a range that widens with the star level, and a real
   * occlusion ray. Rate-limited to `TUNE.losHz`; with a fleet of eight that is
   * about fifty raycasts a second.
   */
  _sight(dt) {
    this._losTimer -= dt;
    if (this._losTimer > 0) return;
    this._losTimer = 1 / TUNE.losHz;

    const q = this.quarry;
    let seen = false;
    const range = TUNE.sightRange[this.meter.level] ?? 90;
    const cosHalf = Math.cos(TUNE.sightHalfAngle);

    for (let i = 0; i < this.units.length; i++) {
      const u = this.units[i];
      u.los = false;
      if (!u.active || !u.vehicle || !q.valid) continue;
      const dx = q.position.x - u.vehicle.position.x;
      const dz = q.position.z - u.vehicle.position.z;
      const d = Math.hypot(dx, dz);
      if (d > range) continue;
      if (d > TUNE.sightRear) {
        const yaw = u.yaw;
        const dot = (dx / d) * Math.sin(yaw) + (dz / d) * Math.cos(yaw);
        if (dot < cosHalf) continue;
      }
      u.los = this.rayVisible(u.vehicle.position, q.position, 1.0);
      if (u.los) seen = true;
    }

    let by = seen ? 'unit' : '';
    /**
     * The spotter's eyes are tested HERE, on this pass, not read off a flag the
     * airframe refreshed on its own 4 Hz clock.
     *
     * Every source of `seen` has to share one cadence, because `_seenPos` below
     * is copied from the quarry's LIVE position the moment any of them says
     * yes: a flag that is 250 ms old therefore stamps the belief with a
     * position that was never observed. Measured with the runner teleported
     * 903 m out of every cone — the ground units all reported false correctly,
     * the helicopter's stale flag said true for one more tick, and that single
     * tick moved the last known position across the map and re-dispatched the
     * whole fleet onto it. 162 of 230 evade samples "re-sighted", median
     * distance from the search centre 0.1 m.
     */
    if (!seen && this.heli.active && q.valid) {
      this.heli.los = false;
      const hd = Math.hypot(this.heli.position.x - q.position.x, this.heli.position.z - q.position.z);
      if (hd < TUNE.heliSight) {
        this.heli.los = this.rayVisible(this.heli.position, q.position, 1.0);
      }
      if (this.heli.los) { seen = true; by = 'heli'; }
    }
    if (!seen && q.valid && this.officers.count) {
      seen = this.officers.sightCheck(q, this);
      if (seen) by = 'officer';
    }
    // WHO has eyes on you, for the harness and the dev overlay. `seen` alone
    // cannot tell "a cruiser is behind you" from "a foot cop was dropped on top
    // of you", and those are a feature and a bug respectively.
    this._seenBy = by;
    this._seen = seen;
    /**
     * WHERE THEY SAW YOU — recorded here, at the sighting, and not read off
     * your live position later.
     *
     * This pass runs at `TUNE.losHz`, so `_seen` is up to 170 ms old by the
     * time `meter.update` consumes it. Feeding the meter the CURRENT position
     * under a stale flag means the last known position is not a sighting at
     * all: it is your real position, refreshed for free, every frame, on the
     * strength of an observation that has already expired. Measured with the
     * harness's runner teleported 979 m out of every cone: `known` followed it
     * across the map on the first frame, the whole fleet was re-dispatched onto
     * the truth, and the meter sat at five stars for the full 46 s escape
     * window — 219 of 230 samples "re-sighted", median distance from the search
     * centre 0.0 m. The freeze that the whole evasion mechanic rests on has to
     * happen the instant the sighting stops being current, not one sight period
     * later.
     */
    if (seen && q.valid) this._seenPos.copy(q.position);
  }

  /** True when nothing solid stands between the two points. */
  rayVisible(from, to, yOff = 1.0) {
    const phys = this.physics;
    if (!phys?.lineOfSight) return true;
    this._rayA.set(from.x, from.y + 0.9, from.z);
    this._rayB.set(to.x, to.y + yOff, to.z);
    try {
      return phys.lineOfSight(this._rayA, this._rayB, phys.MASK?.SIGHT) === true;
    } catch {
      return true;
    }
  }

  /** Is there anyone within earshot of a crime to phone it in? */
  _anyWitness(position) {
    const peds = this.peds;
    if (peds?.inRadius) {
      try {
        const near = peds.inRadius(position.x, position.z, TUNE.witnessRange);
        if (near && near.length) return true;
      } catch { /* peds may not be ready */ }
    }
    for (const u of this.units) {
      if (!u.active || !u.vehicle) continue;
      const d = Math.hypot(u.vehicle.position.x - position.x, u.vehicle.position.z - position.z);
      if (d < TUNE.witnessRange * 2) return true;
    }
    return false;
  }

  /* ==================================================================== */
  /* Units                                                                */
  /* ==================================================================== */

  takeUnit() {
    let u = null;
    for (let i = 0; i < this._pool.length; i++) {
      if (!this._pool[i].active) { u = this._pool[i]; break; }
    }
    if (!u) {
      u = new Unit(this);
      this._pool.push(u);
    }
    this.units.push(u);
    return u;
  }

  liveUnits() {
    let n = 0;
    for (const u of this.units) if (u.active && u.role !== ROLE.LEAVE) n++;
    return n;
  }

  unitNear(x, z, r) {
    const r2 = r * r;
    for (const u of this.units) {
      if (!u.active || !u.vehicle) continue;
      const dx = u.vehicle.position.x - x;
      const dz = u.vehicle.position.z - z;
      if (dx * dx + dz * dz < r2) return true;
    }
    return false;
  }

  /** A wrecked or hopelessly stuck unit hands itself back here. */
  onUnitLost(unit, reason) {
    // A debug runner is not part of the fleet and must never be recycled out
    // from under the harness; give it a fresh plan instead.
    if (unit.isPolice === false) {
      unit._stuckTotal = 0;
      unit._stuck = 0;
      unit.hasSearchPt = false;
      unit._replan = 0;
      return;
    }
    // 'frozen' is the blunt one — this unit has not moved at all for
    // `TUNE.frozenGiveUp` seconds — and it gets no reprieve. A cruiser standing
    // motionless in the road IS the visible defect; despawning it 100 m away at
    // the edge of the frame is the lesser of the two.
    if (reason === 'stuck') {
      // Only delete it if nobody is looking; otherwise let it keep trying —
      // but not forever. Each reprieve is counted, because a car that is
      // genuinely wedged will come back here every few seconds and the
      // original rule ("never despawn in view") then guaranteed a cruiser
      // grinding its nose into a kerb with its lightbar on for the rest of the
      // chase. Measured as the worst continuous stall in the harness. Two
      // reprieves is about fifteen seconds of trying; after that a despawn
      // 100 m away in the corner of the frame is the lesser evil.
      unit._giveUps = (unit._giveUps ?? 0) + 1;
      this.ctx.camera.getWorldPosition(_cam);
      const d = _cam.distanceTo(unit.vehicle.position);
      if (unit._giveUps <= 2 && d < 120 && this.rayVisible(_cam, unit.vehicle.position, 1)) {
        unit._stuckTotal = TUNE.stuckGiveUp * 0.55;
        return;
      }
    }
    this.retireUnit(unit, reason);
  }

  retireUnit(unit, reason = 'far') {
    const i = this.units.indexOf(unit);
    if (i >= 0) this.units.splice(i, 1);
    for (let k = unit.officers.length - 1; k >= 0; k--) this.officers.retire(unit.officers[k]);
    const v = unit.vehicle;
    unit.release();
    if (!v) return;
    // A destroyed cruiser stays in the road as a landmark of what you did; a
    // culled one is removed because it is far away and nobody can see it.
    if (reason === 'wrecked') {
      v.lightbarOn = false;
      v.isPolice = false;
      return;
    }
    /**
     * NEVER DELETE THE CAR THE PLAYER IS SITTING IN.
     *
     * Every caller of this method ends in `vehicles.despawn(v)`, and the only
     * thing that used to stand between that and the player's own car was an
     * accident: `dispatch._cull` happens to skip units that are on screen. The
     * other two callers do not. `onUnitLost` sends a cruiser here the moment it
     * reads as 'frozen' or 'stuck' — and a commandeered cruiser parked at a
     * kerb IS motionless from the unit's point of view, so a player who takes a
     * cop car and stops has his car deleted from underneath him. MEASURED: over
     * a 32 s getaway the stolen cruiser vanished mid-drive, with the player
     * still nominally aboard.
     *
     * The unit is dropped either way — it must not keep steering a car it no
     * longer owns — but the SHELL stays in the world, dressed down exactly as a
     * wreck is, because it is now the player's car.
     */
    if (this.isPlayerCar(v)) {
      v.lightbarOn = false;
      v.isPolice = false;
      return;
    }
    this.vehicles?.despawn(v);
  }

  /**
   * Is `v` the car the player is in or driving? Asked of the WORLD — the seat,
   * the wheel, the occupant list — rather than of this system's own belief,
   * because `quarry` is refreshed once a frame and an event can arrive between
   * two of them. The quarry is checked too, and deliberately last-resort-first:
   * it also covers the harness's stand-in runner, which is the right answer for
   * a guard whose job is "never delete the car somebody is driving".
   */
  isPlayerCar(v) {
    if (!v) return false;
    const p = this.playerSys;
    if (p && (p.vehicle === v || p.currentVehicle === v)) return true;
    if (this._isPlayerActor(v.driver)) return true;
    const occ = v.occupants;
    if (Array.isArray(occ)) {
      for (let i = 0; i < occ.length; i++) if (this._isPlayerActor(occ[i])) return true;
    }
    return this.quarry.inVehicle && this.quarry.vehicle === v;
  }

  /** `vehicle:enter` is raised for peds boarding too — only the player counts. */
  _isPlayerActor(actor) {
    if (!actor) return false;
    if (actor === 'player' || actor.isPlayer === true) return true;
    const p = this.playerSys;
    return !!p && (actor === p || actor === p.movement);
  }

  /**
   * A CRUISER HAS BEEN TAKEN OFF US — the fleet half of taking a police car;
   * the wanted-level half is on `vehicle:enter` below.
   *
   * The unit is released and NOTHING is despawned: the car is the player's now.
   *
   * This is not cosmetic bookkeeping. `_sight()` tests every unit with
   *
   *     u.los = this.rayVisible(u.vehicle.position, q.position, 1.0)
   *
   * and for a unit still bound to the car the player is driving those two
   * Vector3s ARE THE SAME OBJECT — separation zero, so the rear-arc cone is
   * skipped as "point blank" and the occlusion ray is cast from a point to
   * itself, which is trivially clear. `seen` is therefore pinned true forever:
   * `sinceSeen` and `evade` never leave zero, no star can ever fall, and
   * because `searchAnchor` follows a live sighting exactly, the dispatcher
   * keeps putting fresh cruisers down on top of the player. MEASURED with the
   * player 1.4 km from the search anchor and every other unit retired:
   * `seen=true seenBy="unit" sinceSeen=0.0 evade=0.0` flat across 160/160
   * samples of a 32 s escape, three stars in and three stars out, and the fleet
   * refilled to four cars, the nearest 66 m away. With the unit released:
   * `seen` false inside a second and the evade clock running.
   *
   * That is exactly the clairvoyance the notes on `searchAnchor` and `_sight`
   * say this system must never have — arrived at through bookkeeping rather
   * than through a bad anchor.
   *
   * @returns {boolean} true if a unit actually owned this car
   */
  releaseVehicle(v) {
    if (!v) return false;
    let i = -1;
    for (let k = 0; k < this.units.length; k++) {
      if (this.units[k].vehicle === v) { i = k; break; }
    }
    if (i < 0) return false;
    const unit = this.units[i];
    this.units.splice(i, 1);
    // Whoever was riding in it goes back to the pedestrian population; they are
    // not passengers in a car the player has just taken.
    for (let k = unit.officers.length - 1; k >= 0; k--) this.officers.retire(unit.officers[k]);
    unit.release();
    // Dressed down exactly as a wrecked cruiser is: the shell stays, the badge
    // does not. `game`'s `isPolice()` keys off `spec.id`, so the car still
    // reads as a cruiser to the prompt, the theft price and the HUD toast.
    v.lightbarOn = false;
    v.isPolice = false;
    // `roadblock.js` and `tactics.js` both skip units with `active === false`,
    // which `unit.release()` has just set, so no other book has to be told.
    return true;
  }

  /** `roadblock.js` asks for cars. Farthest-from-the-quarry first. */
  claimUnitsForBlock(block, n) {
    const out = [];
    const q = this.quarry;
    const cand = [];
    for (const u of this.units) {
      if (!u.active || u.role === ROLE.BLOCK || u.role === ROLE.LEAVE) continue;
      cand.push(u);
    }
    cand.sort((a, b) => {
      const da = Math.hypot(a.vehicle.position.x - block.x, a.vehicle.position.z - block.z);
      const db = Math.hypot(b.vehicle.position.x - block.x, b.vehicle.position.z - block.z);
      return da - db;
    });
    // Prefer cars that are already nearer the block than the quarry is — they
    // can actually be standing there in time.
    const qd = q.valid ? Math.hypot(q.position.x - block.x, q.position.z - block.z) : 1e9;
    // NEVER strip the chase bare to build a block. The harness caught this: at
    // three stars with three cars, all three were claimed for a roadblock and
    // nobody was left behind the quarry at all.
    // Take at most HALF the fleet for a block; the rest is spawned fresh at the
    // site. A block assembled by stripping the pursuit is a block you never
    // have to drive into, because nobody is pushing you toward it.
    const spare = Math.max(0, Math.min(cand.length - 1, Math.floor(cand.length / 2)));
    for (const u of cand) {
      if (out.length >= n || out.length >= spare) break;
      const d = Math.hypot(u.vehicle.position.x - block.x, u.vehicle.position.z - block.z);
      if (d > qd * 1.25) continue;
      u.role = ROLE.BLOCK;
      u._replan = 0;
      out.push(u);
    }
    // Deliberately NO spawning here. `TUNE.fleet` is the total car count for
    // the level and the dispatcher is the only thing allowed to grow it; a
    // block that cannot be manned yet simply waits for the fleet to fill.
    return out;
  }

  _standDownAll() {
    this.blocks.clear();
    this.officers.clear();
    this.heli.stand(this.ctx);
    for (let i = this.units.length - 1; i >= 0; i--) {
      const u = this.units[i];
      if (!u.active) continue;
      u.role = ROLE.LEAVE;
      u.holdPose = null;
      u._replan = 0;
      if (u.vehicle) u.vehicle.lightbarOn = false;
    }
  }

  /* ==================================================================== */
  /* Officers, air, respray, crowd                                        */
  /* ==================================================================== */

  /**
   * Cops get out when getting out is the right move: at a roadblock once the
   * car is parked, or when the quarry has stopped / is on foot and close.
   */
  _deployOfficers(dt) {
    const q = this.quarry;
    if (!q.valid || this.meter.level === 0) return;
    for (let i = 0; i < this.units.length; i++) {
      const u = this.units[i];
      if (!u.active || !u.vehicle) continue;
      const d = Math.hypot(u.vehicle.position.x - q.position.x, u.vehicle.position.z - q.position.z);

      if (u.deployed) {
        // Re-board once the chase has moved on and they are just standing in
        // the road. The officers become pedestrians again rather than popping.
        if (d > 130 && u.officers.length) {
          for (let k = u.officers.length - 1; k >= 0; k--) this.officers.retire(u.officers[k]);
          u.deployed = false;
        }
        continue;
      }

      const parked = Math.abs(u.vehicle.forwardSpeed) < 1.2;
      const atBlock = u.role === ROLE.BLOCK && u.holdPose && parked;
      const standoff = !q.inVehicle && d < TUNE.bailoutRange && parked;
      const boxedIn = q.inVehicle && q.stillTime > TUNE.bailoutStill && d < 22 && parked;
      if (!atBlock && !standoff && !boxedIn) continue;

      const n = this.meter.level >= 4 ? 2 : 1;
      let made = 0;
      for (let k = 0; k < n; k++) {
        if (this.officers.deployFrom(u, k)) made++;
      }
      if (made) u.deployed = true;
    }
  }

  _air(dt, ctx) {
    const want = (TUNE.helis[this.meter.level] ?? 0) > 0 && this.quarry.valid;
    if (want && !this.heli.active) this.heli.launch(ctx, this.quarry.position);
    else if (!want && this.heli.active) this.heli.stand(ctx);
    if (this.heli.active) this.heli.update(dt, ctx);
  }

  /**
   * Rustbelt Respray. Drive in with heat on the meter and the shop clears it —
   * the one hard reset in the system and the reason the shop is on the map.
   */
  _respray(dt) {
    this._resprayTimer -= dt;
    if (this._resprayTimer > 0) return;
    this._resprayTimer = 0.5;
    if (this.meter.level === 0) return;
    const q = this.quarry;
    if (!q.valid || !q.inVehicle || q.speed > 3.5) return;
    const d = Math.hypot(q.position.x - RESPRAY.x, q.position.z - RESPRAY.z);
    if (d > RESPRAY.r) return;
    this.clearWanted('respray');
    try { this.ui?.notify?.('RESPRAYED', 'HEAT OFF', 'good'); } catch { /* ui optional */ }
  }

  /** The crowd knows there is a chase on. */
  _panic(dt) {
    if (this.meter.level < 2 || !this.quarry.valid) return;
    this._panicTimer -= dt;
    if (this._panicTimer > 0) return;
    this._panicTimer = 1 / TUNE.panicHz;
    const peds = this.peds;
    if (!peds?.panic) return;
    try {
      peds.panic(this.quarry.position, 26 + this.meter.level * 5, 0.45 + this.meter.level * 0.1);
    } catch { /* peds may not have booted */ }
  }

  /* ==================================================================== */
  /* World helpers                                                        */
  /* ==================================================================== */

  groundAt(x, z, fromY = 120) {
    const phys = this.physics;
    if (phys?.groundHeight) {
      const h = phys.groundHeight(x, z, fromY);
      if (Number.isFinite(h) && h > -1e4) return h;
    }
    const w = this.world;
    const h2 = w?.heightAt?.(x, z) ?? w?.groundHeight?.(x, z);
    return Number.isFinite(h2) ? h2 : 0;
  }

  /**
   * The surface height to PLACE A CAR at on a lane, which is not the same
   * question as `groundAt`.
   *
   * `roads.laneCenter` already carries the deck height of the lane it sampled.
   * The physics ray is better when it agrees with that — it picks up the kerb
   * profile and the camber — and worse when it does not: outside the collision
   * streaming ring it falls through to raw terrain, and the terrain is sunk
   * 0.55 m under every road corridor (ARCHITECTURE, the world contract), so the
   * car is placed INSIDE the road mesh and penetration resolution either fires
   * it into the air or wedges it there for good. `dispatch.spawnOne` learned
   * this the expensive way; every other placement in this subsystem now shares
   * the rule.
   */
  laneSurfaceY(x, z, laneY, fromY = null) {
    const ray = this.physics?.groundHeight?.(x, z, fromY ?? (laneY + 10));
    if (Number.isFinite(ray) && ray > -1e4 && Math.abs(ray - laneY) < 5) return ray;
    return Number.isFinite(laneY) ? laneY : this.groundAt(x, z, fromY ?? 120);
  }

  /* ==================================================================== */
  /* Crime wiring                                                         */
  /* ==================================================================== */

  /**
   * Everything below turns the canonical event stream into heat, so the wanted
   * system works whether or not `game` ever calls `reportCrime` by hand.
   * Attribution is deliberately conservative: an event is the player's fault
   * only if they are demonstrably nearby, or fired within the last couple of
   * seconds. Blaming the player for a traffic accident two districts away is
   * the sort of bug that makes a wanted system feel arbitrary.
   */
  _wire(ctx) {
    this._offs = [];
    const on = (n, f) => this._offs.push(ctx.events.on(n, f));
    const now = () => ctx.time.elapsed;

    const cool = (kind, seconds) => {
      const t = now();
      const last = this._crimeCool.get(kind) ?? -99;
      if (t - last < seconds) return false;
      this._crimeCool.set(kind, t);
      return true;
    };
    this._cool = cool;

    const nearPlayer = (p, r) => {
      if (!p || !this.quarry.valid) return false;
      return Math.hypot(p.x - this.quarry.position.x, p.z - this.quarry.position.z) < r;
    };
    const playerJustFired = () => now() - this._playerFiredAt < 2.6;

    on('weapon:fire', (e) => {
      // Our own officers' shots carry `police: true` — an officer firing from
      // inside 4 m of the player must not be priced as the player's gunfire.
      if (e?.police) return;
      if (!e?.origin || !nearPlayer(e.origin, 4)) return;
      this._playerFiredAt = now();
      // A burst is one crime, not thirty.
      if (cool('gunfire', 1.1)) {
        this.reportCrime('gunfire', e.origin, 1);
      }
    });

    on('explosion', (e) => {
      if (!e?.position) return;
      if (!nearPlayer(e.position, 45) && !playerJustFired()) return;
      if (cool('explosion', 1.5)) this.reportCrime('explosion', e.position, 1);
    });

    on('damage:dealt', (e) => {
      const t = e?.target;
      if (!t || t === 'player' || t?.isPlayer === true) return;
      if (t === this.playerSys) return;
      const mine = this.officers.officerOf(t);
      if (!mine && !playerJustFired() && !nearPlayer(e.point ?? t.position, 3.5)) return;
      const pt = e.point ?? t.position ?? this.quarry.position;
      if (mine) {
        // A crooked cop is nobody's colleague: shooting one is priced at
        // exactly zero heat, which is the whole premise of the copwar job.
        // And it is only YOUR crime if you were there or had just fired —
        // see the note on `vehicle:destroyed` below.
        if (!mine.crooked && (playerJustFired() || nearPlayer(pt, 60))) {
          this.reportCrime(e.killed ? 'killCop' : 'woundCop', pt, 1, { seenByCop: true });
        }
      } else if (!e.killed && cool('woundPed', 0.5)) this.reportCrime('woundPed', pt, 1);
    });

    on('actor:death', (e) => {
      const a = e?.actor;
      if (!a) return;
      const pt = e.point ?? a.position ?? this.quarry.position;
      const mine = this.officers.officerOf(a);
      if (mine) {
        if (!mine.crooked && (playerJustFired() || nearPlayer(pt, 60))) {
          this.reportCrime('killCop', pt, 1, { seenByCop: true });
        }
        return;
      }
      if (playerJustFired() || nearPlayer(pt, 4)) this.reportCrime('killPed', pt, 1);
    });

    on('vehicle:collision', (e) => {
      const v = e?.vehicle;
      if (!v || !this.quarry.inVehicle || v !== this.quarry.vehicle) return;
      const other = e.other;
      if (other?.isPolice) {
        // Who hit whom. A PIT manoeuvre is the police ramming YOU, and being
        // rammed is not a crime — the first pass charged the player for every
        // contact and the meter ran to five stars inside ten seconds of a
        // three-star chase.
        const ours = v.speed;
        const theirs = other.speed ?? 0;
        if (ours > theirs + 1.5 && cool('ramCop', 1.6)) {
          this.reportCrime('ramCop', e.point, clamp((e.impulse ?? 0) / (v.mass * 1.5), 0.5, 2.5), { seenByCop: true });
        }
      } else if ((e.impulse ?? 0) > v.mass * 1.6 && cool('hitCar', 2.5)) {
        this.reportCrime('hitCar', e.point, 1);
      }
    });

    on('vehicle:destroyed', (e) => {
      const v = e?.vehicle;
      if (!v) return;
      for (const u of this.units) {
        if (u.vehicle === v) {
          /**
           * ATTRIBUTION, the same conservative rule everything else in this
           * file uses. A cruiser is written off for all sorts of reasons the
           * player had nothing to do with — a traffic car T-boned it at a
           * junction two districts away, or it drove into the river chasing
           * somebody else — and pricing that as `destroyCruiser` did more than
           * add heat: the report carries `seenByCop`, so it also RELOCATED the
           * search onto the wreck and zeroed the escape clock. Measured on the
           * harness's evasion phase with the runner a kilometre clear of every
           * cone: the clock kept restarting and the star never fell, for a
           * crime committed by nobody, in a place the runner had never been.
           */
          const pt = e.point ?? v.position;
          if (playerJustFired() || nearPlayer(pt, 60)) {
            this.reportCrime('destroyCruiser', pt, 1, { seenByCop: true });
          }
          this.onUnitLost(u, 'wrecked');
          return;
        }
      }
    });

    /**
     * THE PLAYER JUST TOOK ONE OF OURS.
     *
     * Both entry paths raise this — `vehicles.setDriver` and `player`'s own
     * fallback — and it lands at the END of the entry animation, which is
     * exactly when the car stops being ours. `vehicle:jack` is deliberately not
     * used: a jack that is aborted halfway leaves the cruiser ours.
     *
     * See `releaseVehicle` for what the fleet half is for. The other half is a
     * one-star rise, and it is recorded here as a FLOOR to be applied on the
     * next tick rather than added now.
     *
     * `game` already prices the theft as a witnessed `carjack` at severity 2.2
     * (`freeroam.js` `reportTheft`) off this same event, so the two listeners
     * are racing. Raising the star here, synchronously, was measured doing
     * exactly what a race does: `police` ran first, set the heat to the bottom
     * of the third star, `game`'s 28.7 landed on top of that, and a theft
     * staged at two stars came out at FOUR. Deferring to `update()` — where the
     * level has settled whichever way the bus ordered the two — and asking only
     * that the meter be at least one star above where it stood when the door
     * opened gives exactly one star in every ordering, at every
     * level, and when a mission has suppressed the heat half entirely.
     */
    on('vehicle:enter', (e) => {
      const v = e?.vehicle;
      if (!v || this._staged) return;
      if (!this._isPlayerActor(e.actor)) return;
      if (!this.releaseVehicle(v)) return;      // not one of ours — nothing owed
      if (v.isMission || v.isPersonal) return;  // scripted hand-over, not a theft
      this._theftStar = Math.max(this._theftStar, Math.min(5, this.meter.level + 1));
    });

    // Somebody was pulled out of a car right next to us: that is a carjack.
    on('vehicle:exit', (e) => {
      const a = e?.actor;
      if (!a || a === this.playerSys || a?.isPlayer) return;
      if (typeof a.startle !== 'function') return;      // a Ped, not the player
      if (!nearPlayer(e.vehicle?.position ?? a.position, 6)) return;
      if (cool('carjack', 2.0)) this.reportCrime('carjack', a.position, 1);
    });

    // Somebody ran a pedestrian over.
    on('player:state', () => { /* reserved: stance changes are not crimes */ });
  }

  /* ==================================================================== */
  /* Telemetry                                                            */
  /* ==================================================================== */

  /**
   * A plain-data snapshot. `src/police/harness.mjs` runs chases headless and
   * asserts on exactly this: that cops close distance, that they do not pile
   * into each other, that a roadblock is built AHEAD of the quarry, that the
   * meter only falls out of sight, and that no unit is ever stuck forever.
   */
  sample() {
    const q = this.quarry;
    const out = this._sample ?? (this._sample = { units: [], blocks: [] });
    out.t = +this.ctx.time.elapsed.toFixed(3);
    out.level = this.meter.level;
    out.heat = +this.meter.heat.toFixed(2);
    out.seen = this._seen;
    out.seenBy = this._seenBy ?? '';
    out.hunting = this.meter.hunting;
    out.evade = +this.meter.evade.toFixed(2);
    out.crimes = this.meter.crimeCount;
    out.lastCrime = this.meter.lastCrime ?? '';
    out.sinceSeen = +this.meter.sinceSeen.toFixed(2);
    out.cordon = +this.meter.cordon.toFixed(1);
    out.knownX = +this.meter.known.x.toFixed(2);
    out.knownZ = +this.meter.known.z.toFixed(2);
    out.officers = this.officers.count;
    out.footOfficers = this.officers.standalone;
    out.crooked = this.officers.crookedCount;
    out.shots = this.stats.shots;
    out.shotHits = this.stats.hits;
    out.rams = this.stats.rams;
    out.downs = this.stats.downs;
    out.heli = this.heli.active;
    out.spiked = this.blocks.spiked.size;
    out.fleetTarget = this.dispatch.fleetTarget();
    out.quarry = q.valid
      ? {
        x: +q.position.x.toFixed(2), z: +q.position.z.toFixed(2),
        vx: +q.velocity.x.toFixed(2), vz: +q.velocity.z.toFixed(2),
        speed: +q.speed.toFixed(2), inVehicle: q.inVehicle,
      }
      : null;

    out.units.length = 0;
    for (const u of this.units) {
      if (!u.active || !u.vehicle) continue;
      const v = u.vehicle;
      out.units.push({
        id: u.id,
        role: u.role,
        x: +v.position.x.toFixed(2),
        z: +v.position.z.toFixed(2),
        v: +v.forwardSpeed.toFixed(2),
        d: +u.diag.dist.toFixed(2),
        mode: u.diag.mode,
        reason: u.diag.reason,
        target: +u.diag.targetSpeed.toFixed(2),
        los: u.los,
        stuck: +u.diag.stuck.toFixed(2),
        hp: Math.round(v.health),
        officers: u.officers.length,
      });
    }

    out.runner = this._runners.length && this._runners[0].vehicle
      ? /* eslint-disable-line */ {
        x: +this._runners[0].vehicle.position.x.toFixed(2),
        z: +this._runners[0].vehicle.position.z.toFixed(2),
        v: +this._runners[0].vehicle.forwardSpeed.toFixed(2),
        stuck: +this._runners[0].diag.stuck.toFixed(2),
        mode: this._runners[0].diag.mode,
        reason: this._runners[0].diag.reason,
        target: +this._runners[0].diag.targetSpeed.toFixed(2),
        d: +this._runners[0].diag.dist.toFixed(1),
        sleep: !!this._runners[0].vehicle.sleeping,
        thr: +this._runners[0]._input.throttle.toFixed(2),
        brk: +this._runners[0]._input.brake.toFixed(2),
        pathN: this._runners[0].path.n,
      }
      : null;

    out.blocks.length = 0;
    for (const b of this.blocks.blocks) {
      out.blocks.push({
        id: b.id,
        x: +b.x.toFixed(2),
        z: +b.z.toFixed(2),
        cars: b.units.length,
        bridge: b.bridgeId ?? null,
        spikes: !!b.spike,
        age: +b.age.toFixed(1),
      });
    }
    return out;
  }

  debugText() {
    const w = this.meter;
    const s = this.stats;
    return `police ${w.level}* heat ${w.heat.toFixed(0)} ${this._seen ? 'SEEN' : `evade ${w.evade.toFixed(1)}`} ` +
      `units ${this.units.length} officers ${this.officers.count} (${this.officers.standalone} foot, ` +
      `${this.officers.crookedCount} crooked) blocks ${this.blocks.blocks.length} · ` +
      `shots ${s.shots}/${s.hits} rams ${s.rams} downs ${s.downs}`;
  }

  /* ==================================================================== */
  /* Test hooks                                                           */
  /* ==================================================================== */

  /**
   * Point the police at something other than the player. `{ vehicle }` or
   * `{ position, velocity }`. Used by the harness and by missions that want
   * the law chasing somebody else.
   */
  setQuarry(target) {
    this._quarryOverride = target ?? null;
  }

  /**
   * Start a scripted chase for `src/police/harness.mjs`.
   *
   * Spawns a getaway car on the road graph, drives it with the SAME controller
   * the cruisers use (ROLE.FLEE) so the harness is exercising shipping code,
   * and points the wanted system at it. `follow` walks the camera along behind
   * it so `world` keeps streaming collision under the chase — without that the
   * cars drive off the edge of the loaded city and fall through the floor,
   * which looks like a pursuit bug and is not one.
   */
  debugChase(opts = {}) {
    this.debugChaseStop();
    const roads = this.roads;
    if (!roads || !this.vehicles) return { ok: false, reason: 'no road graph' };

    this.ctx.camera.getWorldPosition(_cam);
    const anchor = opts.at ? _v.set(opts.at[0], 0, opts.at[1]) : _cam;
    /**
     * WHERE A CHASE IS STAGED DECIDES WHAT THE HARNESS MEASURES.
     *
     * Start it on a long arterial, not a bridge and not a back street:
     *
     *  - a bridge start spends the run in the Monongahela;
     *  - a tight downtown grid is right-angle junctions every 60 m with a
     *    shopfront on every corner, and both the runner and the cars chasing it
     *    spend the chase wedged in masonry. Measured on one such start: the
     *    runner moved in 11% of samples at a median 1.6 m/s, so "the cops never
     *    got within 70 m" was a measurement of a parked car.
     *
     * This is staging, not tuning: the pursuit code is identical either way, and
     * an arterial is where a chase happens in this game anyway.
     */
    const wide = (e) => !e.rail && !e.bridge && e.len > 60 &&
      (e.kind === 'arterial' || e.kind === 'highway');
    const any = (e) => !e.rail && !e.bridge && e.len > 40;
    const minD = opts.minDist ?? 10;
    const maxD = opts.maxDist ?? 220;
    const s = roads.sampleSpawn(this.rng, anchor, minD, maxD, wide) ??
      roads.sampleSpawn(this.rng, anchor, minD, maxD * 3, wide) ??
      roads.sampleSpawn(this.rng, anchor, minD, maxD, any) ??
      roads.sampleSpawn(this.rng, anchor, minD, maxD * 3, any);
    if (!s) return { ok: false, reason: 'no spawn' };

    const type = opts.type ?? 'muscle';
    const spec = this.vehicles.specOf(type);
    const y = this.laneSurfaceY(s.position.x, s.position.z, s.position.y) + spec.comY + 0.03;
    const v = this.vehicles.spawn(type, _v2.set(s.position.x, y, s.position.z), s.yaw, { rng: this.rng });
    if (!v) return { ok: false, reason: 'spawn failed' };
    v.velocity.set(Math.sin(s.yaw) * 12, 0, Math.cos(s.yaw) * 12);
    // The test subject has to survive the test. Eight cruisers ramming a
    // muscle car write it off in about forty seconds, and a wrecked runner
    // measures nothing after that.
    if (opts.tough !== false) {
      v.maxHealth = 1e7;
      v.health = 1e7;
    }

    const runner = new Unit(this);
    runner.bind(v, ROLE.FLEE, { police: false });
    this._runners.push(runner);
    this.setQuarry({ vehicle: v });
    this.quarry.refresh(this, 0);
    this._debugFollow = opts.follow !== false;
    this.setWanted(opts.level ?? 2);
    return { ok: true, x: +v.position.x.toFixed(1), z: +v.position.z.toFixed(1), type };
  }

  debugChaseStop() {
    for (const r of this._runners) {
      if (r.vehicle) this.vehicles?.despawn(r.vehicle);
      r.release();
    }
    this._runners.length = 0;
    this._debugFollow = false;
    this.setQuarry(null);
  }

  /** Chase camera for the harness. Debug-only; never runs in a real session. */
  _followCamera(ctx) {
    const q = this.quarry;
    if (!q.valid) return;
    const back = q.speed > 2 ? q.forward : q.forward;
    _v.set(
      q.position.x - back.x * 15,
      this.groundAt(q.position.x, q.position.z, q.position.y + 30) + 7.5,
      q.position.z - back.z * 15
    );
    ctx.camera.position.copy(_v);
    ctx.camera.lookAt(q.position.x, q.position.y + 1, q.position.z);
    ctx.camera.updateMatrixWorld(true);
  }

  /* ==================================================================== */
  /* Staged tableaux for the capture harness                              */
  /* ==================================================================== */

  /**
   * Compose a still in front of whatever camera the shot API has just set.
   *
   * Staged units are FROZEN — `update`/`fixedUpdate` early-out while a stage is
   * live. The capture harness pumps frames until `world.streamingIdle()`, which
   * can be several hundred, and anything under AI control would have driven
   * into the camera long before the shutter.
   */
  debugStage(name, shot = {}) {
    this._clearStage();
    if (!name || name === 'none' || name === 'clean') {
      this._staged = null;
      this.meter.set(0);
      return { staged: 0 };
    }

    const ctx = this.ctx;
    const cam = ctx.camera;
    cam.getWorldPosition(_cam);
    _fwd.set(0, 0, -1).applyQuaternion(cam.quaternion);
    _fwd.y = 0;
    if (_fwd.lengthSq() < 1e-6) _fwd.set(0, 0, 1);
    _fwd.normalize();

    this._staged = name;
    const level = name === 'busted' ? 2 : name === 'air' ? 4 : name === 'roadblock' ? 4 : 3;
    this.meter.set(level);
    this.meter.known.set(_cam.x, _cam.y, _cam.z);
    this.meter.hasKnown = true;
    this.meter.cordon = 90;
    this._seen = true;

    if (name === 'pursuit' || name === 'air') this._stagePursuit(ctx, name === 'air');
    else if (name === 'roadblock') this._stageRoadblock(ctx);
    else if (name === 'busted') this._stageBusted(ctx);

    // `update()` early-outs while staged, so the quarry record has to be
    // primed by hand or the officers have nothing to face.
    if (!this._quarryOverride) {
      this.setQuarry({ position: _cam.clone(), velocity: new THREE.Vector3() });
    }
    this.quarry.refresh(this, 0);
    this._settleStage(ctx);
    return { staged: this._stagedVehicles.length, officers: this.officers.count, level };
  }

  /** A fleeing car with a fan of cruisers behind it, all coming at the lens. */
  _stagePursuit(ctx, withAir) {
    const q = this._placeOnRoad(ctx, 34, 0, true, 'muscle');
    if (q) this.setQuarry({ vehicle: q });
    // Behind the quarry, staggered left/right so the frame reads as depth
    // rather than as a queue.
    const layout = [[48, -2.4], [61, 2.6], [75, -1.4], [90, 3.0]];
    for (let i = 0; i < layout.length; i++) {
      const v = this._placeOnRoad(ctx, layout[i][0], layout[i][1], true, 'police');
      if (!v) continue;
      const u = this.takeUnit();
      u.bind(v, ROLE.CHASE);
      u.slot = i;
      u.los = true;
    }
    if (withAir) {
      this.heli.build(ctx);
      this.heli.active = true;
      this.heli.root.visible = true;
      const gy = this.groundAt(_cam.x + _fwd.x * 70, _cam.z + _fwd.z * 70, _cam.y + 120);
      this.heli.position.set(_cam.x + _fwd.x * 74 - 26, gy + 52, _cam.z + _fwd.z * 74 - 18);
      this.heli.yaw = Math.atan2(_fwd.x, _fwd.z) + 1.1;
      this.heli.roll = -0.22;
      this.heli.pitch = 0.08;
      this.heli._target.set(_cam.x, _cam.y, _cam.z);
      this.heli.root.position.copy(this.heli.position);
      this.heli.root.rotation.set(this.heli.pitch, this.heli.yaw, this.heli.roll, 'YXZ');
      this.heli._aimBeam(ctx, gy);
    }
  }

  /** Cars across the carriageway, spikes in front, officers behind the doors. */
  _stageRoadblock(ctx) {
    const lead = 30;
    const base = this._roadPose(ctx, lead, 0, false);
    if (!base) return;
    const yaw = base.yaw + Math.PI * 0.5;
    const rx = Math.cos(base.yaw);
    const rz = -Math.sin(base.yaw);
    const n = 3;
    const block = {
      id: -1,
      x: base.x, y: base.y, z: base.z,
      dirX: -Math.sin(base.yaw), dirZ: -Math.cos(base.yaw),
      yaw,
      edge: base.edge,
      node: null,
      bridgeId: null,
      units: [], officers: [], poses: [], age: 0, spikeMesh: null, spike: null,
    };
    for (let i = 0; i < n; i++) {
      const off = (i - (n - 1) / 2) * 3.1;
      const x = base.x + rx * off;
      const z = base.z + rz * off;
      const v = this._spawnAt(ctx, 'police', x, z, yaw + (i - 1) * 0.16);
      if (!v) continue;
      const u = this.takeUnit();
      u.bind(v, ROLE.BLOCK);
      u.holdPose = { x, z, yaw };
      block.units.push(u);
      const o = this.officers.deployFrom(u, i === 1 ? 1 : 0);
      if (o) {
        o.standoff = 3.2;
        // Behind the engine block, facing the camera.
        o.anchor.set(x - block.dirX * -1.4, base.y, z - block.dirZ * -1.4);
        o.ped.position.set(
          x - block.dirX * 1.9 + rx * 0.9,
          this.groundAt(x, z, base.y + 4),
          z - block.dirZ * 1.9 + rz * 0.9
        );
        o.ped.groundY = o.ped.position.y;
      }
    }
    this.blocks._addSpikes(ctx, block);
    this.blocks.blocks.push(block);
  }

  /** One cruiser, two officers, weapons up, pointed at the lens. */
  _stageBusted(ctx) {
    const pose = this._roadPose(ctx, 9.5, 1.6, false);
    if (!pose) return;
    const v = this._spawnAt(ctx, 'police', pose.x, pose.z, pose.yaw + Math.PI * 0.62);
    if (!v) return;
    const u = this.takeUnit();
    u.bind(v, ROLE.CHASE);
    u.los = true;
    this.setQuarry({ position: _cam.clone(), velocity: new THREE.Vector3() });
    for (let i = 0; i < 2; i++) {
      const o = this.officers.deployFrom(u, i);
      if (!o) continue;
      o.standoff = 5.5 + i * 1.2;
      const side = i === 0 ? -1 : 1;
      const px = pose.x + _fwd.x * -1.6 + (-_fwd.z) * side * 1.7;
      const pz = pose.z + _fwd.z * -1.6 + _fwd.x * side * 1.7;
      o.ped.position.set(px, this.groundAt(px, pz, pose.y + 4), pz);
      o.ped.groundY = o.ped.position.y;
      o.ped.yaw = Math.atan2(_cam.x - px, _cam.z - pz);
      o.ped.targetYaw = o.ped.yaw;
      o._cover(0, _cam, o.standoff);
    }
  }

  /* ---- staging helpers ---------------------------------------------- */

  /**
   * A pose on the real road graph `dist` metres in front of the camera. Shots
   * are framed against a procedural city that regenerates, so a hardcoded
   * coordinate would eventually stage a roadblock inside a building.
   */
  _roadPose(ctx, dist, lateral, faceCamera) {
    const roads = this.roads;
    const px = _cam.x + _fwd.x * dist;
    const pz = _cam.z + _fwd.z * dist;
    if (!roads?.nearestEdge) {
      return { x: px, z: pz, y: this.groundAt(px, pz, _cam.y + 20), yaw: Math.atan2(-_fwd.x, -_fwd.z), edge: null };
    }
    const hit = roads.nearestEdge(px, pz, 140);
    if (!hit?.edge) return null;
    const e = hit.edge;
    // Pick the lane whose travel direction faces the way we want.
    const wantX = faceCamera ? -_fwd.x : _fwd.x;
    const wantZ = faceCamera ? -_fwd.z : _fwd.z;
    const along = e.dx * wantX + e.dz * wantZ;
    const lane = along >= 0 ? 0 : Math.min(e.lanes - 1, e.forward);
    const t = clamp(hit.t, 0.08, 0.92);
    roads.laneCenter(e, lane, t, _v);
    const yaw = roads.laneYaw(e, lane);
    const rx = Math.cos(yaw);
    const rz = -Math.sin(yaw);
    const x = _v.x + rx * lateral;
    const z = _v.z + rz * lateral;
    return { x, z, y: this.groundAt(x, z, _cam.y + 24), yaw, edge: e };
  }

  _placeOnRoad(ctx, dist, lateral, faceCamera, type) {
    const pose = this._roadPose(ctx, dist, lateral, faceCamera);
    if (!pose) return null;
    return this._spawnAt(ctx, type, pose.x, pose.z, pose.yaw);
  }

  _spawnAt(ctx, type, x, z, yaw) {
    const spec = this.vehicles?.specOf?.(type);
    if (!spec) return null;
    const y = this.groundAt(x, z, _cam.y + 30) + spec.comY + 0.02;
    const v = this.vehicles.spawn(type, _v2.set(x, y, z), yaw, { rng: this.rng });
    if (!v) return null;
    if (type === 'police') v.lightbarOn = true;
    this._stagedVehicles.push(v);
    return v;
  }

  /**
   * Settle the tableau: let the suspension find the ground and let the
   * officers' animation blend in, exactly as `peds.debugStage` does. Without
   * this the shutter catches cars floating at their spawn height and people
   * standing to attention in a bind pose.
   */
  _settleStage(ctx) {
    const h = 1 / 120;
    for (let i = 0; i < 90; i++) {
      for (const v of this._stagedVehicles) {
        v.input.throttle = 0;
        v.input.brake = 1;
        v.input.steer = 0;
        v.input.handbrake = true;
        v.fixedStep(h, ctx);
      }
    }
    for (const v of this._stagedVehicles) v.syncTransforms(1, 0);

    const peds = this.peds;
    if (peds && this.officers.count) {
      for (let step = 0; step < 40; step++) {
        for (const o of this.officers.list) {
          if (!o.ped) continue;
          o.update(1 / 60);
          o.ped.update(1 / 60);
          if (o.ped.body) o.ped.updateVisual(1 / 60, step / 60);
        }
      }
    }
  }

  _clearStage() {
    for (let i = this.units.length - 1; i >= 0; i--) {
      const u = this.units[i];
      for (let k = u.officers.length - 1; k >= 0; k--) this.officers.retire(u.officers[k]);
      this.units.splice(i, 1);
      u.release();
    }
    this.officers.clear(true);
    this.blocks.clear();
    for (const v of this._stagedVehicles) this.vehicles?.despawn(v);
    this._stagedVehicles.length = 0;
    this.heli.stand(this.ctx);
    this.setQuarry(null);
    this._staged = null;
  }

  /* ==================================================================== */
  /* Pre-warm                                                             */
  /* ==================================================================== */

  /**
   * The only materials this subsystem owns are the spike strip and the
   * helicopter. Both appear at three and four stars — exactly the moment the
   * frame is already busiest — so compiling them lazily would stall on the
   * worst possible frame.
   */
  async prewarmMaterials(ctx = this.ctx) {
    const render = ctx.peek('render');
    const renderer = render?.renderer;
    if (!renderer) return { ok: false, reason: 'no renderer' };
    const before = renderer.info.programs?.length ?? 0;
    const t0 = performance.now();
    try {
      this.blocks._buildAssets(ctx);
      this.heli.build(ctx);
      this.heli.root.visible = false;

      const scene = new THREE.Scene();
      scene.environment = ctx.scene.environment;
      const cam = new THREE.PerspectiveCamera(50, 1, 0.1, 400);
      cam.position.set(0, 2, 14);
      const strip = new THREE.Mesh(this.blocks._geo, this.blocks._mats);
      scene.add(strip);
      const clones = [];
      for (const child of this.heli.root.children) {
        if (!child.isMesh) continue;
        const m = new THREE.Mesh(child.geometry, child.material);
        m.position.set(0, 6, 0);
        clones.push(m);
        scene.add(m);
      }
      render.patchMaterials?.(scene);
      try {
        await renderer.compileAsync(scene, cam);
      } catch {
        try { renderer.compile(scene, cam); } catch { /* driver cannot warm */ }
      }
      const depth = render.csm?.depthMaterial;
      if (depth) {
        scene.overrideMaterial = depth;
        try { await renderer.compileAsync(scene, cam); } catch { /* noop */ }
        scene.overrideMaterial = null;
      }
      scene.clear();
      for (const c of clones) c.geometry = null;
      strip.geometry = null;
      return {
        ok: true,
        ms: Math.round(performance.now() - t0),
        compiled: (renderer.info.programs?.length ?? 0) - before,
      };
    } catch (err) {
      return { ok: false, error: String(err?.message ?? err) };
    }
  }

  dispose() {
    for (const off of this._offs ?? []) off?.();
    this._offs = null;
    this.debugChaseStop();
    this._clearStage();
    this.officers.clear(true);
    this.blocks.dispose();
    this.heli.dispose();
    for (let i = this.units.length - 1; i >= 0; i--) this.retireUnit(this.units[i], 'dispose');
    this.units.length = 0;
    this._pool.length = 0;
  }
}

export { ROLE, TUNE, clamp01 };
