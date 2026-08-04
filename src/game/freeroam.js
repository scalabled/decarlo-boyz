/**
 * GAME — free roam, and THE ONE CONTEXTUAL ACTION.
 *
 * ── The idea this file is built around ────────────────────────────────────
 *
 * A single control is wired to a single function whose label rewrites itself to
 * EXIT while you are in a vehicle. There is no enter key, no exit key, no
 * carjack key and no interact key. One button, and the HUD always says what it
 * will do right now. See CONTROLS.md.
 *
 * So this is not a set of independent triggers with their own keys. It is ONE
 * RESOLVER: every frame it looks at where the player is standing and what is
 * around him, decides the single highest-priority thing `F` should do, and
 * publishes it. `ui` renders the label; a touch button calls `doAction()`
 * directly. Nothing else in the game binds a context key.
 *
 *   in a vehicle : body shop · pumps · respray · swap vehicle · EXIT
 *   on foot      : safehouse sleep · take a vehicle · counter · pumps · race
 *
 * The first five of those in a vehicle are AUTOMATIC — you drive onto the
 * forecourt and it happens, no press — so they publish a *status* line while
 * the button underneath still reads SWAP or EXIT. That split between the status
 * prompt and the action button is why you can never get stuck in a car you
 * cannot get out of.
 *
 * ── The published API (what `ui` consumes) ────────────────────────────────
 *
 *   game.getAction()      -> { id, short, label, sub, key, available, target }
 *                            preallocated and mutated in place; never null.
 *   game.doAction()       -> performs it; returns the id performed, or null.
 *   game.getStatus()      -> { text, sub, progress } | null — the automatic
 *                            service you are currently inside, if any.
 *   event 'game:action'   -> { id, short, label, sub, available } on change.
 *
 * ── Content ───────────────────────────────────────────────────────────────
 *
 *   - the 12 hidden packages, $600 and 8 respect each, all twelve unlocking
 *     the Nitro Launcher;
 *   - Rustbelt Respray, which clears heat — DESIGN.md's one cross-subsystem
 *     shop rule, routed through `Heat` so `police` stays the authority;
 *   - Foundry Supply / Row Hardware (ammunition) and Primo's / the Incline
 *     Diner (health);
 *   - six gas stations and the DeCarlo Body Shop, which is free because Aidan
 *     owns it and heals the driver as well as the car;
 *   - five safehouses: heal, autosave, sleep to morning;
 *   - the three race circuits as standalone activities;
 *   - taking a car off the street and swapping into the one alongside you,
 *     both of which the police are entitled to have an opinion about.
 */

import {
  HIDDEN_PACKAGES, SAFEHOUSES, SHOPS, GAS_STATIONS, RACE_TRACKS, R, DIFFS,
  PACKAGE_CASH, PACKAGE_RESPECT, PACKAGE_REWARD_WEAPON, WEAPON_LIB, BOY_ORDER,
} from './data.js';
import { dist } from './util.js';
import { money } from './economy.js';

/* ---- the scattered consumable economy --------------------------------- */
/**
 * Steel City is kilometres across, so a fixed global scatter of pickups would
 * never be met twice — instead the field DRIFTS with the player:
 * `AMBIENT_COUNT` pickups are kept standing in an annulus around him, one
 * respawns `AMBIENT_RESPAWN` seconds after a collect, and anything left more
 * than `AMBIENT_FAR` behind is quietly moved ahead. Densities chosen so a
 * five-minute drive sweeps a dozen of them without the street reading as a
 * gumball machine.
 */
const AMBIENT_COUNT = 14;
const AMBIENT_MIN = 70;
const AMBIENT_MAX = 380;
const AMBIENT_FAR = 640;
/** Seconds after a collect before one respawns. */
const AMBIENT_RESPAWN = 6;
/** Seconds between far-pickup recycle scans. */
const AMBIENT_SCAN = 0.7;
/** Kind weights — cash twice as common as the rest, because cash is the one
 *  that makes a detour feel paid. */
const AMBIENT_KINDS = ['cash', 'cash', 'health', 'armor', 'ammo', 'nitro'];
/** Cash pickup value — $40–219. */
const CASH_MIN = 40;
const CASH_SPAN = 180;
/** Per-kind effect sizes: +35 hp, +40 armour, 35% of each magazine, a full
 *  nitro bottle. */
const ARMOR_PICKUP = 40;
const AMMO_PICKUP_FRAC = 0.35;

/* ---- kill rewards ------------------------------------------------------ */
/**
 * +6 respect a goon, +2 a ped, +8 a cop; peds and goons drop $10–49 half the
 * time, cops $40–119 seven times in ten. The money hits the street as a cash
 * pickup at the body rather than going straight into the wallet, which feeds
 * the same economy and gives the kill a place to walk to.
 */
const RESPECT_GOON = 6;
const RESPECT_PED = 2;
const RESPECT_COP = 8;
const GOON_DROP = { p: 0.5, min: 10, span: 40 };
const COP_DROP = { p: 0.7, min: 40, span: 80 };
/** Uncollected drops melt after this long — a pool slot is not a memorial. */
const DROP_TTL = 45;
/**
 * Attribution. On a map this size, a body nearby is not necessarily the
 * player's doing, so a death only pays if he fired inside this window or was
 * standing over it — the same shape `police` uses to price `killPed`.
 */
const ATTRIB_FIRE = 6;
const ATTRIB_NEAR = 8;
const ATTRIB_VEH_NEAR = 35;

/** Repair rate at a gas station, HP per second and $ per HP. */
const REPAIR_RATE = 26;
const REPAIR_PRICE = 0.9;
/** Aidan's own shop is faster and free — 45 HP/s. */
const SHOP_REPAIR_RATE = 45;
const SHOP_FUEL_RATE = 30;
/** The body-shop ring heals the DRIVER too. HP per second. */
const SHOP_HEAL_RATE = 14;
/** Tank percent per second at a pump. */
const PUMP_RATE = 34;
/** A food counter is a full heal, so the number only has to be big. */
const FOOD_HEAL = 999;
/** The family body shop, which is also Aidan's safehouse. */
const BODY_SHOP_ID = 'sh_aidan';
/** Below this you have stopped at the pump rather than rolled past it. */
const STOPPED = 1.5;
/** Seconds between "still working on it" toasts inside a service ring. */
const SERVICE_TOAST = 2.2;
/**
 * How close a brother has to be to the car to hop in with you.
 *
 * A 30 m ring is fine when the allies are ACTORS trailing 5 m behind you. Here
 * they are the switchable brothers, and `characters.js` makes a promise the
 * harness checks: "the brother you leave keeps living where you left him". A
 * 30 m ring quietly broke that — a brother standing across the street when you
 * got into a car was carried off and set down wherever you stopped, 29.6 m
 * from where the player had left him. 12 m is "at the kerb beside this car",
 * which is the only reading under which being carried off is something you
 * asked for.
 */
const CREW_REACH = 12;

export class FreeRoam {
  constructor(ctx, deps) {
    this.ctx = ctx;
    this.wq = deps.wq;
    this.economy = deps.economy;
    this.heat = deps.heat;
    this.pickups = deps.pickups;
    this.missions = deps.missions;
    this.save = deps.save;

    this.boy = null;
    /**
     * NEGATIVE-CONTROL SWITCH. Drops the `ui.isPaused()` term back out of
     * `_usePressed()` at runtime, restoring the pre-fix behaviour without an
     * edit. `pausefreeroamprobe.mjs --nc` flips it; nothing else reads it.
     */
    this.debugIgnorePause = false;
    /** Set by the game system; called whenever something worth saving happens. */
    this.onSave = null;
    this.lastSafehouse = null;
    this.rng = ctx.rng.fork();

    /**
     * The static content tables, published as instance state so a harness, the
     * pause map or a debug overlay can enumerate what the world contains
     * without importing `data.js` (ARCHITECTURE.md rule 2 cuts both ways).
     */
    this.safehouses = SAFEHOUSES;
    this.shops = SHOPS;
    this.gasStations = GAS_STATIONS;
    this.raceTracks = RACE_TRACKS;
    this.packages = HIDDEN_PACKAGES;
    this.bodyShop = SAFEHOUSES.find((s) => s.id === BODY_SHOP_ID) ?? null;

    /** THE contextual action. Preallocated — `update()` must not allocate. */
    this.act = {
      id: 'none', short: '', label: '', sub: '', key: 'F',
      available: false, target: null,
    };
    /** The automatic service the player is currently inside, or null. */
    this.status = { text: '', sub: '', progress: undefined };
    this._statusOn = false;
    this._lastActId = '';
    this._lastActLabel = '';
    this._actEvent = { id: 'none', short: '', label: '', sub: '', available: false };
    /** `ui.setAction` shape: { label, verb, sub, available, key }. */
    this._uiAction = { label: '', verb: '', sub: '', available: false, key: 'F' };
    this._serviceEvent = { kind: '', phase: '', place: '', progress: 0 };
    this._blockEvent = { id: '', reason: '' };
    this._serviceKind = null;

    /** Which brothers are riding along in the player's car. */
    this.crew = [];

    this._prompt = { key: 'F', text: '', sub: '', progress: undefined };
    this._promptShown = false;
    this._atHome = false;
    this._sprayCd = 0;
    this._sprayHot = 0;
    this._repairDebt = 0;
    this._raceCd = 0;
    this._swapCd = 0;
    this._serviceToastT = 0;
    this._missT = 0;
    this._sprayHot = 0;
    this.packagesSeeded = false;

    /** The flyable fleet parked at the airfields, spawned once. See below. */
    this._airportSeeded = false;
    this._airportVehicles = [];

    // See `_respray`: `police` owns the same shop at the same coordinates and
    // updates first, so the stars can already be gone by the time this system
    // looks. A clear TO zero is therefore also evidence that the player drove
    // in hot, and it arms the free respray that `game` owns the other half of.
    this._offWanted = ctx.events.on('wanted:change', (e) => {
      if (e && e.level === 0 && (e.prev ?? 0) > 0) this._sprayHot = 2;
    });

    /* ---- the consumable field ----------------------------------------- */
    // `game/index.js` owns `onCollect` (packages, mission crates, the +35 hp
    // heal); this second slot applies the ambient per-kind effects.
    this.pickups.onConsume = (p) => this._consume(p);
    /** Pending respawn timers, one per collected ambient pickup. */
    this._ambPend = [];
    this._ambScanT = 0;
    this._ambSeeded = false;

    /* ---- kill rewards -------------------------------------------------- */
    /** Seconds since the player last pulled a trigger — the attribution clock. */
    this._sinceFire = 999;
    /** Cop units downed (foot or cruiser) — `jobs`' copwar and the probes read it. */
    this.copKills = 0;
    this._offFire = ctx.events.on('weapon:fire', () => { this._sinceFire = 0; });
    this._offDeath = ctx.events.on('actor:death', (e) => this._onActorDeath(e));
    this._offWreck = ctx.events.on('vehicle:destroyed', (e) => this._onVehicleDestroyed(e));

    /* ---- radio persistence --------------------------------------------- */
    // The chosen station persists on every change and is restored on boot.
    // `ui` emits `ui:station` whenever the station changes (its own pill, the
    // R key, or the restore below) — mirror it into the save.
    this._offStation = ctx.events.on('ui:station', (e) => {
      const id = e?.id ?? null;
      if (id === this.save.radio) return;
      this.save.radio = id;
      this.onSave?.();
    });
    this._radioRestored = false;
    this._radioEvent = { id: null };

    /* ---- difficulty publication ---------------------------------------- */
    // `DIFFS[..].dmgOut` (the PLAYER's damage multiplier) was defined and read
    // by nobody. Publish it whenever the difficulty changes so combat can
    // scale outgoing damage without importing `game`'s data.
    this._lastDiff = '';
    this._diffPayload = { id: 'normal', label: 'Normal', dmgIn: 1, dmgOut: 1, time: 1, enemy: 1 };
  }

  /* ==================================================================== */
  /* packages                                                             */
  /* ==================================================================== */

  seedPackages() {
    const found = this.save.packages;
    for (const p of HIDDEN_PACKAGES) {
      if (found.includes(p.id)) continue;
      if (this.pickups.has(p.id)) continue;
      this.pickups.spawn(p.x, p.z, 'package', { id: p.id });
    }
    this.packagesSeeded = true;
  }

  collectPackage(id) {
    const found = this.save.packages;
    if (found.includes(id)) return;
    found.push(id);
    this.economy.addCash(PACKAGE_CASH, 'package');
    this.economy.addRespect(PACKAGE_RESPECT, 'package');
    const ui = this.wq.ui;
    ui?.packageFound?.(id);
    ui?.notify?.('Hidden package', `${found.length} / ${HIDDEN_PACKAGES.length}`, 'gold');
    if (found.length >= HIDDEN_PACKAGES.length) {
      this.economy.unlockWeapon(PACKAGE_REWARD_WEAPON);
      ui?.notify?.('All packages found', 'NITRO LAUNCHER UNLOCKED', 'gold');
    }
    this.onSave?.();
  }

  /* ==================================================================== */
  /* the airfield fleet                                                   */
  /* ==================================================================== */

  /**
   * Park the flyable fleet at the two airfields, once, as soon as the world is
   * up: a fixed-wing SKYLARK on each runway — backed up to a threshold with the
   * whole strip ahead of it and its nose pointing down the centreline, ready to
   * build speed and rotate — and a RIVERHOP helicopter on the apron beside it.
   *
   * Both are ordinary spawns with no mission tag, so nothing despawns them, and
   * both are ENTERABLE through the very same F scan a car is: `_vehicleNear`
   * offers whatever `vehicles.nearest(..., TAKEABLE)` returns, and `TAKEABLE`
   * rejects only a destroyed vehicle. Walk up to either and the prompt reads
   * TAKE THE SKYLARK / TAKE THE RIVERHOP.
   *
   * The runway HEADING and EXTENT are READ from `world.airfields`, never
   * duplicated here — one owner for a spatial fact (ARCHITECTURE.md rule 12).
   * `world` is a static dep of `game`, so it is always up by the time free roam
   * runs a frame; the guard below simply waits for the first frame it can see it.
   */
  _seedAirportVehicles() {
    if (this._airportSeeded) return;
    const fields = this.wq.world?.airfields;
    const vs = this.wq.vehicles;
    if (!fields?.length || typeof vs?.spawn !== 'function') return;
    this._airportSeeded = true;
    for (const af of fields) {
      const c = Math.cos(af.yaw), s = Math.sin(af.yaw);
      const len = af.runway?.[0] ?? 400;
      const wid = af.runway?.[1] ?? 80;
      // Down-runway offset (nose points this way) and the perpendicular apron.
      const along = (d) => [af.x + s * d, af.z + c * d];
      const beside = (d, a) => [af.x + c * d + s * a, af.z - s * d + c * a];
      const [px, pz] = along(-len * 0.32);
      const plane = this.wq.spawnVehicle('plane', px, pz, af.yaw);
      const [hx, hz] = beside(wid * 0.5 + 12, len * 0.12);
      const heli = this.wq.spawnVehicle('heli', hx, hz, af.yaw);
      if (plane) this._airportVehicles.push(plane);
      if (heli) this._airportVehicles.push(heli);
    }
  }

  /* ==================================================================== */
  /* the consumable field                                                 */
  /* ==================================================================== */

  /**
   * Keep `AMBIENT_COUNT` consumables standing around the player. A collect
   * books a 6-second respawn; a pickup left `AMBIENT_FAR` behind is moved
   * ahead. Amortised: at most two spawns and one recycle per frame.
   */
  _ambient(dt) {
    // Pending respawn clocks tick down; each expiry frees one slot to refill.
    const pend = this._ambPend;
    for (let i = pend.length - 1; i >= 0; i--) {
      pend[i] -= dt;
      if (pend[i] <= 0) pend.splice(i, 1);
    }

    const standing = this.pickups.countAmbient();
    const deficit = AMBIENT_COUNT - standing - pend.length;
    if (deficit > 0) {
      // First fill floods (two per frame is ~half a second to stock the map);
      // afterwards the only deficits are expired respawn clocks.
      this._spawnAmbient();
      if (deficit > 1) this._spawnAmbient();
      this._ambSeeded = true;
    }

    // Recycle the field forward as the player travels.
    this._ambScanT -= dt;
    if (this._ambScanT <= 0) {
      this._ambScanT = AMBIENT_SCAN;
      const pos = this.wq.focusPos();
      const live = this.pickups.live;
      for (let i = live.length - 1; i >= 0; i--) {
        const p = live[i];
        if (!p.ambient) continue;
        if (dist(p.x, p.z, pos.x, pos.z) <= AMBIENT_FAR) continue;
        this.pickups.despawn(p);
        this._spawnAmbient();
        break; // one per scan — this is housekeeping, not gameplay
      }
    }
  }

  _spawnAmbient() {
    const pos = this.wq.focusPos();
    const kind = AMBIENT_KINDS[this.rng.u32() % AMBIENT_KINDS.length];
    // Two placements: on a lane (swept up at speed — the reason to drive) and
    // off-road (the reason to look around). 65 / 35 favours the road.
    const spot = this.rng.float() < 0.65
      ? this.wq.findRoadSpot(AMBIENT_MIN, AMBIENT_MAX, pos.x, pos.z)
      : this.wq.findGroundSpot(AMBIENT_MIN, AMBIENT_MAX, pos.x, pos.z);
    const value = kind === 'cash' ? CASH_MIN + (this.rng.u32() % CASH_SPAN) : 0;
    return this.pickups.spawn(spot.x, spot.z, kind, { ambient: true, value });
  }

  /** Book a respawn — called from `_consume` so only ambient collects count. */
  _bookRespawn() {
    this._ambPend.push(AMBIENT_RESPAWN);
  }

  /**
   * Per-kind effect of a consumable:
   * cash pays its rolled value, health +35 (applied by `game/index.js`'s
   * `onCollect` — only the toast lives here), armour +40, ammo tops every
   * carried magazine up by 35%, nitro refills the bottle.
   */
  _consume(p) {
    const ui = this.wq.ui;
    switch (p.kind) {
      case 'cash': {
        const v = p.value || CASH_MIN;
        this.economy.addCash(v, 'pickup');
        ui?.notify?.('Found cash', money(v), 'char');
        break;
      }
      case 'health':
        ui?.notify?.('Health', '+35', 'char');
        break;
      case 'armor': {
        const pl = this.wq.player;
        pl?.addArmour?.(ARMOR_PICKUP);
        ui?.notify?.('Armor', `+${ARMOR_PICKUP}`, 'char');
        break;
      }
      case 'ammo': {
        // Both ledgers: the save-side reserve `economy` owns, and whatever
        // `weapons` currently has live. Uncapped.
        for (const wid of this.economy.loadout(this.save.active, this.boy)) {
          const def = WEAPON_LIB[wid];
          if (!def || !Number.isFinite(def.ammo)) continue;
          this.economy.addAmmo(wid, Math.ceil(def.ammo * AMMO_PICKUP_FRAC));
        }
        const wp = this.wq.weapons;
        if (wp?.states) {
          for (const s of wp.states.values()) {
            // A wrench has no reserve, and inventing one confuses the ammo HUD.
            if (s.def?.melee || !Number.isFinite(s.def?.reserve)) continue;
            s.reserve = (s.reserve ?? 0) + Math.ceil(s.def.reserve * AMMO_PICKUP_FRAC);
          }
        }
        ui?.notify?.('Ammunition', '+35%', 'char');
        break;
      }
      case 'nitro': {
        const vh = this.wq.player?.vehicles;
        if (vh && typeof vh.nitro === 'number') vh.nitro = 100;
        ui?.notify?.('Nitro', 'BOTTLE FULL', 'char');
        break;
      }
      default:
        return; // packages and crates are `onCollect`'s business
    }
    if (p.ambient) this._bookRespawn();
  }

  /* ==================================================================== */
  /* kill rewards                                                         */
  /* ==================================================================== */

  /** Is this dead actor a police officer? `police` borrows its bodies from
   *  `peds`, so the only honest test is asking the officer pool. */
  _isCopActor(a) {
    const pol = this.wq.police;
    try { return pol?.officers?.owns?.(a) === true; } catch { return false; }
  }

  /**
   * Violence pays: goons +6 respect, peds
   * +2, cops +8; cash hits the pavement by the body. Deaths the player had no
   * hand in (a cruiser flattening a jaywalker three blocks over) pay nothing —
   * the attribution gate is recent player fire or standing over the body.
   */
  _onActorDeath(e) {
    const a = e?.actor;
    if (!a || a.isCrew || a.crew) return;
    if (a === this.wq.player || a.isPlayer === true) return;
    const point = e.point ?? a.position;
    if (!point || !Number.isFinite(point.x)) return;

    if (a.isHostile === true) {
      // Goons only ever fight the player — always his.
      this.economy.addRespect(RESPECT_GOON, 'kill');
      this._dropCash(GOON_DROP, point.x, point.z);
      return;
    }

    const pos = this.wq.playerPos();
    const attributed = this._sinceFire < ATTRIB_FIRE ||
      dist(point.x, point.z, pos.x, pos.z) < ATTRIB_NEAR;
    if (!attributed) return;

    if (this._isCopActor(a)) {
      this.copKills++;
      this.save.totals.kills++;
      this.economy.addRespect(RESPECT_COP, 'copkill');
      this._dropCash(COP_DROP, point.x, point.z);
      return;
    }
    this.save.totals.kills++;
    this.economy.addRespect(RESPECT_PED, 'kill');
    this._dropCash(GOON_DROP, point.x, point.z);
  }

  /** A wrecked cruiser is a downed cop UNIT, and the copwar job counts them
   *  the same way. */
  _onVehicleDestroyed(e) {
    const v = e?.vehicle;
    if (!v || !isPolice(v)) return;
    const pos = this.wq.playerPos();
    const px = e.point?.x ?? v.position.x;
    const pz = e.point?.z ?? v.position.z;
    const attributed = this._sinceFire < ATTRIB_FIRE ||
      dist(px, pz, pos.x, pos.z) < ATTRIB_VEH_NEAR;
    if (!attributed) return;
    this.copKills++;
    this.economy.addRespect(RESPECT_COP, 'copkill');
    this._dropCash(COP_DROP, px, pz);
  }

  /** Roll a drop and put it on the street. If the pool is momentarily full the
   *  money goes straight to the wallet — a won drop must never be voided. */
  _dropCash(spec, x, z) {
    if (this.rng.float() >= spec.p) return null;
    const value = spec.min + (this.rng.u32() % spec.span);
    const p = this.pickups.spawn(x, z, 'cash', { value, ttl: DROP_TTL });
    if (!p) this.economy.addCash(value, 'kill');
    return p ?? value;
  }

  /* ==================================================================== */
  /* radio + difficulty                                                   */
  /* ==================================================================== */

  /**
   * Restore the saved station, once, on the first frame — by which point every
   * subsystem's listeners exist. Going through `ui.setStation` keeps the pill
   * honest and re-emits `ui:station` for `audio`; the raw event is the
   * fallback for a build without a HUD.
   */
  _restoreRadio() {
    if (this._radioRestored) return;
    this._radioRestored = true;
    const id = this.save.radio;
    if (id == null) return;
    const ui = this.wq.ui;
    if (typeof ui?.setStation === 'function') {
      ui.setStation(id);
    } else {
      this._radioEvent.id = id;
      this.ctx.events.emit('ui:station', this._radioEvent);
    }
  }

  /** `game:difficulty { id, label, dmgIn, dmgOut, time, enemy }` on change
   *  (and once at boot). `weapons` scales outgoing player damage by `dmgOut`. */
  _publishDifficulty() {
    const id = this.save.difficulty ?? 'normal';
    if (id === this._lastDiff) return;
    const d = DIFFS[id];
    if (!d) return;
    this._lastDiff = id;
    const p = this._diffPayload;
    p.id = id;
    p.label = d.label;
    p.dmgIn = d.dmgIn;
    p.dmgOut = d.dmgOut;
    p.time = d.time;
    p.enemy = d.enemy;
    this.ctx.events.emit('game:difficulty', p);
  }

  /* ==================================================================== */
  /* the frame                                                            */
  /* ==================================================================== */

  update(dt) {
    this._sprayCd = Math.max(0, this._sprayCd - dt);
    this._raceCd = Math.max(0, this._raceCd - dt);
    this._swapCd = Math.max(0, this._swapCd - dt);
    this._serviceToastT = Math.max(0, this._serviceToastT - dt);
    this._missT = Math.max(0, this._missT - dt);
    this._sinceFire += dt;
    this._ambient(dt);
    this._seedAirportVehicles();
    this._restoreRadio();
    this._publishDifficulty();

    // ACT FIRST, THEN RESOLVE — and that order is the whole bug fix.
    //
    // `player` binds F too (enter at 3.4 m, exit while driving) and it updates
    // BEFORE this system, because `game` declares `player` as a static dep. So
    // on the very frame F goes down, `player` has already put the actor into
    // the car parked outside and flipped `movement.driving` true. Resolving
    // first therefore looked at a world the keypress had already changed:
    // standing in a safehouse ring with any car at the kerb, F resolved to
    // EXIT instead of SLEEP and the safehouse became unusable. Measured, with
    // the action tap in `interactprobe.mjs`: `action was "sleep", F did
    // [exit->null]`.
    //
    // Acting on the action resolved LAST frame is also simply more honest: it
    // is the one whose label the player was looking at when he pressed the key.
    if (this._usePressed()) this.doAction();
    this._resolve(dt);
    this._publish();
    this._carryCrew();
  }

  /**
   * Undo an entry `player` started from the same keypress we are about to
   * spend on something else. Without this, "sleep at the safehouse" and "buy
   * ammunition" both leave the player sitting in a car he never asked to be in.
   */
  _cancelPlayerEntry() {
    const p = this.wq.player;
    const ph = p?.vehicles?.phase;
    if (ph === 'open' || ph === 'jack' || ph === 'in') p.vehicles.abort(p.movement);
  }

  /* ---- resolve ------------------------------------------------------- */

  _resolve(dt) {
    const a = this.act;
    a.id = 'none'; a.short = ''; a.label = ''; a.sub = '';
    a.key = 'F'; a.available = false; a.target = null;
    this.status.text = ''; this.status.sub = ''; this.status.progress = undefined;
    this._statusOn = false;

    const veh = this.wq.playerVehicle();
    const pos = this.wq.playerPos();
    const x = veh ? veh.position.x : pos.x;
    const z = veh ? veh.position.z : pos.z;

    if (veh) {
      // The respray works whether or not a chapter is running: `escape`
      // chapters are ABOUT reaching it. Everything below is free-roam only.
      const sprayed = this._respray(x, z, veh, dt);
      if (!this.missions.running && !sprayed) {
        // Driving out of a ring mid-job is not a completion — drop the
        // in-progress kind silently so the next arrival starts cleanly.
        if (!this._bodyShop(x, z, veh, dt) && !this._gas(x, z, veh, dt)) {
          this._serviceKind = null;
        }
      }
      // The button underneath a running service is still SWAP or EXIT, always.
      if (!this.missions.running && this._race(x, z, veh)) return;
      if (this._swapTarget(veh)) return;
      this._setAction('exit', 'EXIT', `LEAVE THE ${nameOf(veh)}`, '', veh);
      return;
    }

    this._serviceKind = null;
    if (this.missions.running) return;
    if (this._safehouse(x, z, dt)) return;
    // A car and a shop counter both in reach: NEAREST WINS. Ranking the car
    // unconditionally above the counter is the obvious reading of the
    // priority list and it is wrong in play — every shop in this city has
    // parked cars outside it, so the ammo counter and the diner became
    // unreachable the moment anything was at the kerb.
    const car = this._vehicleNear(pos);
    const counter = this._counterDist(x, z);
    if (car && (counter == null || car <= counter)) return;
    if (this._counter(x, z)) return;
    if (car) return;
    this._respray(x, z, null, dt);
    if (this._gas(x, z, null, dt)) return;
    this._race(x, z, null);
  }

  _setAction(id, short, label, sub, target) {
    const a = this.act;
    a.id = id;
    a.short = short;
    a.label = label;
    a.sub = sub ?? '';
    a.target = target ?? null;
    a.available = true;
    return true;
  }

  _setStatus(text, sub, progress) {
    this.status.text = text;
    this.status.sub = sub ?? '';
    this.status.progress = progress;
    this._statusOn = true;
    return true;
  }

  /**
   * A throttled "still working" toast, so a service ring gives feedback the
   * whole time you sit in it rather than only on the frame you arrived.
   */
  _serviceToast(text, value) {
    if (this._serviceToastT > 0) return;
    this._serviceToastT = SERVICE_TOAST;
    this.wq.ui?.notify?.(text, value, 'char');
  }

  /**
   * `game:service` — the passive rings, as an EVENT rather than something to
   * be inferred from prompt text. `ui` was reading the prompt transitioning
   * into "TANK FULL" to know a refuel had finished, which breaks the moment
   * anyone rewords a string.
   *
   * @param {'refuel'|'repair'|'bodyshop'} kind
   * @param {'start'|'done'} phase
   */
  _service(kind, phase, place, progress) {
    if (phase === 'start') {
      if (this._serviceKind === kind) return;
      this._serviceKind = kind;
    } else {
      if (this._serviceKind !== kind) return;
      this._serviceKind = null;
    }
    const e = this._serviceEvent;
    e.kind = kind;
    e.phase = phase;
    e.place = place;
    e.progress = progress ?? (phase === 'done' ? 1 : 0);
    this.ctx.events.emit('game:service', e);
    if (phase === 'done') this.wq.ui?.notify?.(place, DONE_LABEL[kind] ?? 'DONE', 'char');
  }

  /** An action that was offered, pressed, and refused. Never silent. */
  _blocked(id, why) {
    const e = this._blockEvent;
    e.id = id;
    e.reason = why;
    this.ctx.events.emit('game:action:blocked', e);
    this.wq.ui?.notify?.('Cannot do that', why, 'bad');
  }

  /* ---- publish ------------------------------------------------------- */

  /**
   * Push the prompt EVERY frame while one is up, not only when the text
   * changes.
   *
   * `player`'s own vehicle handler writes to the same single `ui` prompt slot
   * when a car is inside its 3.4 m reach, and it caches what it last wrote too.
   * Two caches over one slot means whoever wrote last keeps it until its own
   * text changes — so walking the final metre to a car replaced "TAKE THE
   * ALLEGHENY 4DR" with the generic "ENTER" and it never came back. `ui`'s
   * `setText` compares before touching the DOM, so re-asserting is free, and
   * `game` (which updates after `player`, by static deps) simply wins.
   */
  _publish() {
    const ui = this.wq.ui;
    const a = this.act;
    const showStatus = this._statusOn;
    const text = showStatus ? this.status.text : a.label;

    if (text) {
      const pr = this._prompt;
      pr.key = showStatus ? '' : a.key;
      pr.text = text;
      pr.sub = showStatus ? this.status.sub : a.sub;
      pr.progress = showStatus ? this.status.progress : undefined;
      ui?.setPrompt?.(pr);
      this._promptShown = true;
    } else if (this._promptShown) {
      ui?.clearPrompt?.();
      this._promptShown = false;
    }

    if (a.id !== this._lastActId || a.label !== this._lastActLabel) {
      this._lastActId = a.id;
      this._lastActLabel = a.label;
      const e = this._actEvent;
      e.id = a.id; e.short = a.short; e.label = a.label;
      e.sub = a.sub; e.available = a.available;
      this.ctx.events.emit('game:action', e);

      // Hand `ui` the VERB explicitly rather than leaving it to reverse it out
      // of the prompt line. That inference is what forced the touch button to
      // read EXIT while the prompt said something else: when an automatic
      // service owns the prompt, the button's verb is not in that text at all.
      const u = this._uiAction;
      u.label = a.label;
      u.verb = a.short;
      u.sub = a.sub;
      u.available = a.available;
      u.key = a.key;
      ui?.setAction?.(a.available ? u : null);
    }
  }

  _clearPrompt() {
    if (!this._promptShown) return;
    this.wq.ui?.clearPrompt?.();
    this._promptShown = false;
  }

  /**
   * IS THE F EDGE OURS TO SPEND? Belt and braces.
   *
   * Today the pause gate is entirely in the CALLER: `game._update` reads
   * `this._paused(ctx)` and simply does not call `freeroam.update(dt)`
   * (`src/game/index.js:705`), and the comment there says so. That works, and
   * it is one `if` away from not working — the ordering in `_update` is edited
   * often, `freeroam.update` is not obviously input-bearing from the outside,
   * and the failure is silent: no error, no log, just a car boarded from
   * behind the pause menu. `interactprobe.mjs` would still pass, because it
   * never pauses.
   *
   * So the gate lives in BOTH places. `ui` is optional — the model preview
   * page and every headless bench boot without it — and is reached through
   * `this.wq.ui`, which is `ctx.peek('ui')` (`src/game/util.js:117`) and is
   * the spelling the other twenty `ui` reads in this file already use. No
   * `ui` means nothing is paused, which is correct for a bench.
   *
   * The check is FIRST, before the input reads, so it also covers the
   * `actionPressed('use')` path a touch build takes.
   */
  _usePressed() {
    if (!this.debugIgnorePause && this.wq.ui?.isPaused?.() === true) return false;
    const input = this.ctx.input;
    if (!input?.enabled || input.frozen) return false;
    return input.pressed?.('KeyF') === true || input.actionPressed?.('use') === true;
  }

  /* ==================================================================== */
  /* DO IT                                                                */
  /* ==================================================================== */

  /**
   * Perform the contextual action. Public: this is what a touch button calls,
   * and it is the only path `F` takes.
   * @returns {string|null} the id performed
   */
  doAction() {
    const a = this.act;
    // Anything that is not a vehicle verb outranks the entry `player` may have
    // started from this same press — see `_cancelPlayerEntry`.
    if (a.available && !VEHICLE_VERBS.has(a.id)) this._cancelPlayerEntry();
    switch (a.id) {
      case 'sleep': return this._sleep(a.target);
      case 'enter':
      case 'commandeer': {
        // `player`'s own 3.4 m bind may already have taken this exact car on
        // this exact frame. That is the right outcome, so report it as done
        // rather than boarding a second time.
        const p = this.wq.player;
        if (p?.vehicles?.vehicle === a.target) return a.id;
        return this._board(a.target) ? a.id : null;
      }
      case 'swap': {
        if (this._swapCd > 0) return null;
        this._swapCd = 1.2;
        // `player` has already begun the exit off this same press. The swap is
        // therefore the ONE thing the press does: it consumes that exit and
        // lands in the car the prompt named. `_board` puts him back where he
        // was if the entry fails, so a press can never leave him on the road.
        const from = this.wq.player?.vehicles?.vehicle ?? null;
        if (this._board(a.target)) return 'swap';
        if (from) this._board(from);
        this._blocked('swap', 'COULD NOT GET ACROSS');
        return null;
      }
      case 'exit': {
        // `player` OWNS the exit. It binds the same `use` verb, it updates
        // first, and it exits unconditionally whenever the actor is seated —
        // so on a keyboard press the exit has already happened by the time
        // this runs and the only correct thing to do is report it. Calling
        // `tryExit` again would be a second transition for one press, which is
        // the bug that dumped the player out of one car and straight into
        // another. It is still called when the player is somehow STILL seated,
        // because `game.doAction()` is also a public API a menu or a script
        // may call with no keypress behind it.
        const p = this.wq.player;
        const v = p?.vehicles;
        if (!v) return null;
        if (v.phase === 'out') return 'exit';
        if (v.phase === 'drive' && v.tryExit(p.movement)) return 'exit';
        // Refused: `player` bumps `stats.exitBlocked` and says nothing. A
        // control that does nothing when you press it reads as broken.
        this._blocked('exit', 'NO ROOM TO GET OUT');
        return null;
      }
      case 'ammo': return this._buyAmmo(a.target);
      case 'food': return this._eat(a.target);
      case 'respray': return this._payRespray(a.target);
      case 'race': {
        if (this._raceCd > 0) return null;
        this._raceCd = 3;
        return this.startRace(a.target) ? 'race' : null;
      }
      default: {
        // Feedback even for a no-op — toast "No vehicle nearby" rather than
        // leaving the player wondering whether the key is bound.
        if (this._missT <= 0 && !this.wq.playerVehicle() && !this.missions.running) {
          this._missT = 1.6;
          this.wq.ui?.notify?.('Nothing to use here', 'NO VEHICLE NEARBY', 'slag');
        }
        return null;
      }
    }
  }

  /* ==================================================================== */
  /* on foot                                                              */
  /* ==================================================================== */

  _safehouse(x, z, dt) {
    const near = this.wq.nearestSafehouse(x, z);
    if (!near || near.dist > R.safehouse) { this._atHome = false; return false; }
    const sh = near.poi;
    if (sh.respect && !this.economy.hasUnlock(sh.id)) {
      this._setStatus('LOCKED', `${sh.name} · ${sh.respect} RESPECT`);
      return true;
    }
    this.lastSafehouse = sh.id;
    this.economy.char().safehouse = sh.id;

    const p = this.wq.player;
    if (p?.health) {
      const h = p.health;
      if (h.value < h.max) h.value = Math.min(h.max, h.value + 24 * dt);
      if (p.addArmour && p.armour < p.maxArmour) p.addArmour(16 * dt);
    }
    if (!this._atHome) {
      this._atHome = true;
      this.onSave?.(true);
      this.wq.ui?.notify?.('Progress saved', sh.name, 'char');
      this.wq.uiSfx('regen', 0.7);
    }
    return this._setAction('sleep', 'SLEEP', 'SLEEP TILL MORNING', sh.name, sh);
  }

  _sleep(sh) {
    const p = this.wq.player;
    if (p?.health) { p.health.value = p.health.max; p.addArmour?.(p.maxArmour); }
    const sky = this.ctx.peek('sky');
    const hour = sky?.hour ?? sky?.timeOfDay ?? 8;
    const next = (hour + 8) % 24;
    sky?.setTimeOfDay?.(next);
    this.save.clock = next;
    this.wq.ui?.notify?.('Slept', 'FULLY RESTORED', 'char');
    this.wq.uiSfx('regen', 0.8);
    this.onSave?.(true);
    void sh;
    return 'sleep';
  }

  /**
   * "Take the Allegheny 4dr" / "Commandeer the Cruiser".
   *
   * `player` owns the enter ANIMATION and offers its own prompt from 3.4 m with
   * the generic verb ENTER. That is too short a reach and too bland a line, and
   * both are fixed here rather than by reaching into `src/player/`: the scan
   * runs at 5.5 m, the wording comes
   * from the vehicle's own name, and the action hands off to `player.vehicles`
   * through the same two steps (`candidate`, then `tryEnter`) its own scan uses
   * — so the door swing, the seat curve and `vehicle:enter` are the real ones.
   */
  _vehicleNear(pos) {
    const p = this.wq.player;
    const vs = this.wq.vehicles;
    const handler = p?.vehicles;
    if (!handler || typeof vs?.nearest !== 'function') return false;
    if (handler.phase && handler.phase !== 'none') return false;
    if (p.dead || p.health?.dead) return false;

    let v = null;
    try { v = vs.nearest(pos.x, pos.y, pos.z, R.enter, TAKEABLE); } catch { return false; }
    if (!v) return false;

    const police = isPolice(v);
    const name = nameOf(v);
    this._setAction(
      police ? 'commandeer' : 'enter',
      police ? 'TAKE' : 'ENTER',
      police ? `COMMANDEER THE ${name}` : `TAKE THE ${name}`,
      '', v
    );
    // Returns the DISTANCE, so the caller can rank this against a counter.
    return Math.max(0.01, Math.hypot(v.position.x - pos.x, v.position.z - pos.z));
  }

  /** How far the nearest walk-up counter is, or null if none is in reach. */
  _counterDist(x, z) {
    const ammo = this.wq.nearestShop(x, z, 'ammo');
    const ad = ammo ? ammo.dist : Infinity;
    const food = this.wq.nearestShop(x, z, 'food');
    const fd = food ? food.dist : Infinity;
    const d = Math.min(ad, fd);
    return d > R.poi ? null : d;
  }

  /** Ammunition and food, the two counters you walk up to. */
  _counter(x, z) {
    const ammo = this.wq.nearestShop(x, z, 'ammo');
    const ad = ammo ? ammo.dist : Infinity;
    const ap = ammo?.poi;
    const food = this.wq.nearestShop(x, z, 'food');
    const fd = food ? food.dist : Infinity;
    if (Math.min(ad, fd) > R.poi) return false;

    if (ad <= fd) {
      const quote = this.economy.priceRefill(this.boy);
      if (quote.rounds === 0) return this._setStatus('FULLY LOADED', ap.name);
      return this._setAction('ammo', 'BUY',
        `BUY ${quote.rounds} ROUNDS · ${money(quote.cost)}`, ap.name, ap);
    }
    const shop = food.poi;
    const h = this.wq.player?.health;
    if (h && h.value >= h.max) return this._setStatus('NOT HUNGRY', shop.name);
    return this._setAction('food', 'EAT', `EAT ${money(shop.price ?? 45)}`, shop.name, shop);
  }

  _buyAmmo(shop) {
    const quote = this.economy.priceRefill(this.boy);
    const r = this.economy.buyRefill(this.boy);
    if (!r.bought) {
      this.wq.ui?.notify?.('Not enough cash', money(quote.cost), 'bad');
      return null;
    }
    this.wq.ui?.notify?.('Ammunition', `${r.rounds} ROUNDS`, 'char');
    this.wq.sfx('reload', null, { gain: 0.7 });
    this._pushAmmoToWeapons();
    this.onSave?.();
    void shop;
    return 'ammo';
  }

  _eat(shop) {
    const price = shop.price ?? 45;
    if (!this.economy.canAfford(price)) {
      this.wq.ui?.notify?.('Not enough cash', money(price), 'bad');
      return null;
    }
    this.economy.addCash(-price, 'food');
    const h = this.wq.player?.health;
    if (h) h.value = Math.min(h.max, h.value + FOOD_HEAL);
    this.wq.ui?.notify?.(shop.name, 'HEALTH RESTORED', 'char');
    this.onSave?.();
    return 'food';
  }

  /* ==================================================================== */
  /* in a vehicle                                                         */
  /* ==================================================================== */

  /**
   * Rustbelt Respray. Free while you are hot — that is the whole point of the
   * shop, and charging a man with four stars is a joke he cannot stop for.
   *
   * `police` implements the same rule at the same coordinates and owns the
   * notification, so when it is the authority this only changes the paint and
   * lets the star clear come from there. Two RESPRAYED toasts for one drive-in
   * is the bug that comes from both systems being polite.
   */
  _respray(x, z, veh, dt) {
    // "Was he hot when he drove in?", not "is he hot on the frame I looked".
    //
    // `police` implements the same shop at the same coordinates and clears the
    // stars from its own update, which runs BEFORE this one. So on the frame
    // the car crosses onto the forecourt the level can already be zero by the
    // time this reads it — and then the free respray never fires and the car
    // keeps its old paint and plate, which is the half of the deal `game`
    // owns. Measured: the star clear passed and the repaint silently did not.
    if (this.heat.wanted > 0) this._sprayHot = 2;
    else this._sprayHot = Math.max(0, this._sprayHot - dt);

    const near = this.wq.nearestShop(x, z, 'spray');
    if (!near || near.dist > R.service) return false;
    const shop = near.poi;
    if (!veh) return this._setStatus('BRING A CAR IN', shop.name);
    if (Math.abs(veh.forwardSpeed ?? 0) > 2.5) return this._setStatus('PULL UP TO RESPRAY', shop.name);

    if (this._sprayHot > 0) {
      if (this._sprayCd <= 0) {
        this._sprayCd = 4;
        this._sprayHot = 0;
        this._repaint(veh);
        this.wq.sfx('reload', veh.position, { gain: 0.7 });
        if (this.heat.authoritative) {
          this.heat.clear('respray');
          this.wq.ui?.notify?.('Resprayed', 'HEAT OFF', 'char');
        }
        this.onSave?.();
      }
      return this._setStatus('RESPRAYING', `${shop.name} · HEAT OFF`);
    }
    void dt;
    this._setAction('respray', 'PAINT', `RESPRAY ${money(shop.price ?? 200)}`, shop.name, shop);
    return true;
  }

  _payRespray(shop) {
    const price = shop.price ?? 200;
    const veh = this.wq.playerVehicle();
    if (!veh || this._sprayCd > 0) return null;
    if (!this.economy.canAfford(price)) {
      this.wq.ui?.notify?.('Not enough cash', money(price), 'bad');
      return null;
    }
    this._sprayCd = 2;
    this.economy.addCash(-price, 'respray');
    this._repaint(veh);
    this.wq.ui?.notify?.('New colour', shop.name, 'char');
    return 'respray';
  }

  /** `vehicles` owns paint; the honest respray is a fresh handle, so recolour. */
  _repaint(veh) {
    const mats = this.ctx.peek('materials');
    const vs = this.wq.vehicles;
    if (!mats?.carPaint || !veh?.model) return;
    const palette = [0x2a3138, 0x7a1f1f, 0x1f4a5e, 0x5a5f2a, 0x3a2a4a, 0x8a5a12, 0xb0b4b8];
    const c = palette[(veh._sprayIdx = ((veh._sprayIdx ?? 0) + 1)) % palette.length];
    try {
      const mat = mats.carPaint(c, { finish: 'gloss' });
      veh.model.traverse?.((o) => {
        if (o.isMesh && o.material?.name?.startsWith?.('carpaint')) o.material = mat;
      });
      veh.paintName = 'resprayed';
      // Losing the plate is half of what a respray buys you.
      if (vs?._makePlate) veh.plate = vs._makePlate(this.wq.rng);
    } catch { /* paint is cosmetic — never let it break the heat clear */ }
  }

  /**
   * "Aidan's shop hammers out the dents and tops the tank for the whole
   * family" — and patches up the driver while it is at it. Free, faster than a
   * gas station, and no button: you drive in and it happens. That is the reward
   * for driving home, and it is why the map pin is worth learning.
   *
   * Same building as his safehouse, and there is no conflict because the
   * safehouse ring only answers on foot and this only answers from the seat.
   */
  _bodyShop(x, z, veh, dt) {
    const sh = this.bodyShop;
    if (!sh || dist(x, z, sh.x, sh.z) > R.service) return false;
    const fuel = fuelOf(veh);
    const p = this.wq.player;
    const hurt = veh.health < veh.maxHealth;
    const thirsty = fuel != null && fuel.value < fuel.max - 0.01;
    const bleeding = !!p?.health && p.health.value < p.health.max;

    if (!hurt && !thirsty && !bleeding) {
      this._service('bodyshop', 'done', sh.name, 1);
      return this._setStatus('EVERYTHING SOUND', sh.name);
    }
    if (Math.abs(veh.forwardSpeed ?? 0) > STOPPED) {
      return this._setStatus('PULL INTO THE SHOP', sh.name);
    }

    this._service('bodyshop', 'start', sh.name, veh.health / Math.max(1, veh.maxHealth));
    if (hurt) this._repair(veh, SHOP_REPAIR_RATE * dt);
    if (thirsty) this._pump(veh, SHOP_FUEL_RATE * dt);
    if (bleeding) p.health.value = Math.min(p.health.max, p.health.value + SHOP_HEAL_RATE * dt);
    const frac = veh.health / Math.max(1, veh.maxHealth);
    this._serviceToast('DeCarlo Body Shop', `${Math.round(frac * 100)}%`);
    return this._setStatus('HAMMERING OUT THE DENTS', `${sh.name} · ${Math.round(frac * 100)}%`,
      Math.min(1, frac));
  }

  /**
   * The pumps. Fuel first, because that is what the station is FOR and a dry
   * tank is the only thing here that can strand you; the paid panel-beating is
   * a second service once the tank is full.
   *
   * `vehicles` owns the tank (`v.fuel`, `v.maxFuel`, `vehicles.refuel`) and the
   * panels (`vehicles.repair`, which un-dents them as health returns). Both are
   * called through guards so this still works on a build where either is
   * missing.
   */
  _gas(x, z, veh, dt) {
    const near = this.wq.nearestGas(x, z);
    if (!near || near.dist > R.service) return false;
    const name = near.poi.name;
    if (!veh) return this._setStatus('PUMPS', name);

    const fuel = fuelOf(veh);
    const thirsty = fuel != null && fuel.value < fuel.max - 0.01;
    const hurt = veh.health < veh.maxHealth;
    if (!thirsty && !hurt) {
      this._service(this._serviceKind === 'repair' ? 'repair' : 'refuel', 'done', name, 1);
      return this._setStatus('TANK FULL', name);
    }
    if (Math.abs(veh.forwardSpeed ?? 0) > STOPPED) return this._setStatus('STOP AT THE PUMP', name);

    if (thirsty) {
      this._service('refuel', 'start', name, fuel.value / fuel.max);
      this._pump(veh, PUMP_RATE * dt);
      const f = fuelOf(veh);
      const pct = Math.round((f.value / f.max) * 100);
      this._serviceToast('Refuelling', `${pct}%`);
      return this._setStatus('REFUELLING', `${name} · ${pct}%`, Math.min(1, f.value / f.max));
    }

    // Held, not pressed: repairs tick while you sit there and cost as they go.
    this._service('repair', 'start', name, veh.health / Math.max(1, veh.maxHealth));
    const heal = Math.min(REPAIR_RATE * dt, veh.maxHealth - veh.health);
    this._repairDebt += heal * REPAIR_PRICE;
    if (this._repairDebt >= 1) {
      const charge = Math.floor(this._repairDebt);
      if (!this.economy.addCash(-charge, 'repair')) {
        this._repairDebt = 0;
        return this._setStatus('NO CASH FOR PARTS', name);
      }
      this._repairDebt -= charge;
    }
    this._repair(veh, heal);
    const pct = Math.round((veh.health / veh.maxHealth) * 100);
    this._serviceToast('Repairing', `${pct}%`);
    return this._setStatus('REPAIRING', `${name} · ${pct}%`, Math.min(1, veh.health / veh.maxHealth));
  }

  /** Add fuel through `vehicles`' own hook, falling back to the field. */
  _pump(veh, amount) {
    const vs = this.wq.vehicles;
    if (typeof vs?.refuel === 'function') {
      try { vs.refuel(veh, amount); return; } catch { /* fall through */ }
    }
    if (typeof veh.fuel === 'number') {
      veh.fuel = Math.min(veh.maxFuel ?? 100, veh.fuel + amount);
      if (veh.fuel > 0) veh.fuelDry = false;
    }
  }

  /** `vehicles.repair` also un-dents the panels; the field alone does not. */
  _repair(veh, amount) {
    const vs = this.wq.vehicles;
    if (typeof vs?.repair === 'function') {
      try { vs.repair(veh, amount); return; } catch { /* fall through */ }
    }
    veh.health = Math.min(veh.maxHealth, veh.health + amount);
  }

  /**
   * ROLL UP ALONGSIDE another car and the action button becomes SWITCH.
   *
   * The speed window is the whole design, and the LOWER bound matters more
   * than the upper one. Offering the swap at any speed under 9 m/s makes `F`
   * unable to get you out of a parked car whenever anything else is parked
   * within 5.2 m — which in a city is most kerbs. Measured by
   * `tools/playprobe.mjs`: "F exits the vehicle — still inside".
   *
   * So: stopped means EXIT, which is what the one action button in a vehicle
   * does and what a player expects. The swap is what it was actually for —
   * hopping across mid-chase — and it only appears while you are still
   * rolling.
   *
   * The `out` phase is accepted as well as `drive` because `player` binds F to
   * exit and updates first: by the time this reads the press it has already
   * started climbing out. Refusing anything but `drive` is what made the swap
   * silently dump the player on the pavement instead.
   */
  _swapTarget(veh) {
    const p = this.wq.player;
    const vs = this.wq.vehicles;
    const phase = p?.vehicles?.phase;
    if (!p?.vehicles || typeof vs?.nearest !== 'function') return false;
    if (phase !== 'drive' && phase !== 'out') return false;
    const speed = Math.abs(veh.forwardSpeed ?? 0);
    if (speed <= R.swapMin || speed > R.swapSpeed) return false;

    const pos = veh.position;
    let other = null;
    try {
      other = vs.nearest(pos.x, pos.y, pos.z, R.swap, (o) => o !== veh && TAKEABLE(o));
    } catch { return false; }
    if (!other) return false;
    return this._setAction('swap', 'SWAP', `SWITCH TO THE ${nameOf(other)}`, '', other);
  }

  /**
   * Put the player into `v` through `player`'s own transition. Identical in
   * shape to `game.debugBoard`, but this one is gameplay: it must go through
   * `tryEnter` rather than teleporting a seated actor, or the camera handover
   * and `vehicle:enter` never happen.
   */
  _board(v) {
    const p = this.wq.player;
    if (!p?.vehicles || !v || v.destroyed) return false;
    if (p.inVehicle) p.vehicles.abort(p.movement);
    const anchor = this.wq.vehicles?.seatAnchor?.(v, 0);
    const at = anchor?.enter ?? anchor?.door ?? anchor?.position ?? v.position;
    this.wq.placePlayer(at.x, at.z, p.yaw ?? 0, at.y);
    p.vehicles.candidate = v;
    return p.vehicles.tryEnter(p.movement);
  }

  /* ==================================================================== */
  /* grand theft auto, and the crew                                       */
  /* ==================================================================== */

  /**
   * Called from `game` on every `vehicle:enter` the player causes, so it covers
   * both entry paths — this file's prompt and `player`'s own — without either
   * having to report in.
   *
   * A police car is always a star, anything else is a 35% roll.
   * `police.reportCrime` prices it out of CRIME_HEAT (`carjack`, 9 heat against
   * a 10-heat first star), so the severity here is what turns "somebody saw
   * that" into that single star. Passing `witnessed` explicitly matters:
   * unwitnessed crimes are scaled by 0.55 and a quiet carjack would otherwise
   * be worth nothing at all.
   */
  reportTheft(v) {
    if (!v || v.isMission || v.isPersonal) return 0;
    if (this.missions.running) return 0;
    const police = isPolice(v);
    if (!police && this.rng.float() >= 0.35) return 0;
    const reason = police ? 'STOLE A POLICE CAR' : 'GRAND THEFT AUTO';
    const before = this.heat.wanted;
    this.heat.report('carjack', v.position, police ? 2.2 : 1.25, WITNESSED);
    const after = this.heat.wanted;
    if (after > before) this.wq.ui?.notify?.('Wanted', reason, 'bad');
    return after - before;
  }

  /**
   * THE CREW HOPS IN WITH YOU — the signature of a three-brothers game, and it
   * is toasted every time.
   *
   * There are no ally actors to hide: the brothers are switchable characters, so
   * "riding along" is a fact about their SAVE RECORD rather than a mesh. Any
   * brother whose last known position is within 30 m of the car boards it, his
   * position then tracks the car, and he steps out beside you when you do. The
   * payoff is real and persistent: switch to him afterwards and he is standing
   * where the drive ended, not back where you left him an hour ago.
   */
  boardCrew(v) {
    this.crew.length = 0;
    if (!v) return this.crew;
    const active = this.save.active;
    for (const id of BOY_ORDER) {
      if (id === active) continue;
      const c = this.save.chars[id];
      if (!c?.pos || !Number.isFinite(c.pos[0])) continue;
      if (dist(c.pos[0], c.pos[2], v.position.x, v.position.z) > CREW_REACH) continue;
      this.crew.push(id);
    }
    if (this.crew.length) {
      this.wq.ui?.notify?.('The crew hopped in', this.crew.length > 1 ? 'BOTH OF THEM' : '', 'char');
    }
    return this.crew;
  }

  /** Ride along: their saved position follows the car while they are aboard. */
  _carryCrew() {
    if (!this.crew.length) return;
    const v = this.wq.playerVehicle();
    if (!v) { this.crew.length = 0; return; }
    for (const id of this.crew) {
      const c = this.save.chars[id];
      if (c?.pos) { c.pos[0] = v.position.x; c.pos[1] = v.position.y; c.pos[2] = v.position.z; }
    }
  }

  /** Everyone climbs out beside you. */
  unboardCrew(v) {
    if (!this.crew.length) return;
    const p = this.wq.playerPos();
    for (let i = 0; i < this.crew.length; i++) {
      const c = this.save.chars[this.crew[i]];
      if (c?.pos) {
        c.pos[0] = p.x + (i ? 1.6 : -1.6);
        c.pos[1] = p.y;
        c.pos[2] = p.z + 1.3;
      }
    }
    this.wq.ui?.notify?.('The crew got out', '', 'char');
    this.crew.length = 0;
    void v;
  }

  /** Push the saved reserve into whatever `weapons` currently has chambered. */
  _pushAmmoToWeapons() {
    const wp = this.wq.weapons;
    if (!wp?.states) return;
    // The improvised-arsenal ids in `data.js` and the weapon subsystem's
    // rifle/smg/pistol ids are different namespaces (the weapon meshes are
    // still the inherited set). Top every magazine up rather than pretending
    // to map one onto the other.
    for (const s of wp.states.values()) {
      s.reserve = s.def?.reserve ?? s.reserve;
      s.mag = s.def?.magSize ?? s.mag;
      s.chambered = true;
    }
  }

  /* ==================================================================== */
  /* races                                                                */
  /* ==================================================================== */

  _race(x, z, veh) {
    if (this.missions.active) return false;
    for (const t of Object.values(RACE_TRACKS)) {
      const s = t.points[0];
      if (dist(x, z, s.x, s.z) > R.checkpoint * 1.6) continue;
      const best = this.save.races[t.id];
      const sub = best ? `${t.blurb} · BEST ${best.toFixed(1)}s` : t.blurb;
      if (!veh) return this._setStatus('BRING A CAR', `${t.name} · ${sub}`);
      return this._setAction('race', 'START',
        `START ${t.name} · ${money(t.reward)}`, sub, t.id);
    }
    return false;
  }

  /** A circuit as a standalone activity, run through the mission machinery. */
  startRace(trackId) {
    const t = RACE_TRACKS[trackId];
    if (!t || !this.boy) return null;
    const def = {
      no: 'CIRCUIT',
      name: t.name,
      zone: t.blurb.toUpperCase(),
      teaser: t.blurb,
      track: 'race',
      trackId,
      laps: t.laps,
      baseTimer: t.par * t.laps,
      cash: t.reward,
      respect: 12,
      difficulty: 2,
      intro: [],
      done: [],
    };
    this._clearPrompt();
    return this.missions.startCustom(this.boy, def, `race:${trackId}`);
  }

  /* ------------------------------------------------------------- markers -- */

  /** Every free-roam point the map should show. */
  mapPoints(out = []) {
    out.length = 0;
    for (const s of SAFEHOUSES) out.push({ x: s.x, z: s.z, kind: 'safehouse', name: s.name });
    for (const s of SHOPS) out.push({ x: s.x, z: s.z, kind: s.kind, name: s.name });
    for (const s of GAS_STATIONS) out.push({ x: s.x, z: s.z, kind: 'gas', name: s.name });
    for (const t of Object.values(RACE_TRACKS)) {
      out.push({ x: t.points[0].x, z: t.points[0].z, kind: 'race', name: t.name });
    }
    for (const p of HIDDEN_PACKAGES) {
      if (this.save.packages.includes(p.id)) continue;
      out.push({ x: p.x, z: p.z, kind: 'package', name: 'Hidden package' });
    }
    return out;
  }

  dispose() {
    this._offWanted?.();
    this._offFire?.();
    this._offDeath?.();
    this._offWreck?.();
    this._offStation?.();
    this._clearPrompt();
  }
}

/** `reportCrime` opts: somebody watched you do it. Frozen, never allocated. */
const WITNESSED = Object.freeze({ witnessed: true });

/** Actions that are ABOUT a vehicle, and so must not cancel `player`'s entry. */
const VEHICLE_VERBS = new Set(['enter', 'commandeer', 'swap', 'exit']);

/** What the completion toast says when a service ring finishes its work. */
const DONE_LABEL = {
  refuel: 'TANK FULL',
  repair: 'GOOD AS IT GETS',
  bodyshop: 'STRAIGHTENED OUT',
};

/** Is this handle a police cruiser? `spec.id` is the class, `type` mirrors it. */
export function isPolice(v) {
  return v?.type === 'police' || v?.spec?.id === 'police' || v?.isPursuit === true;
}

function nameOf(v) {
  return String(v?.name ?? v?.spec?.name ?? 'car').toUpperCase();
}

/**
 * Anything you are allowed to walk up to and take. A wreck is scenery; a car
 * somebody is already driving is still fair game — `player` turns that into a
 * PULL OUT and hauls the driver through the window.
 */
function TAKEABLE(v) {
  return !!v && !v.destroyed && v.enterable !== false;
}

/**
 * The tank, or null on a build where `vehicles` has no fuel model.
 * Returned as a reused record: `update()` must not allocate.
 */
const _fuel = { value: 0, max: 100 };
function fuelOf(v) {
  if (!v || typeof v.fuel !== 'number') return null;
  _fuel.value = v.fuel;
  _fuel.max = typeof v.maxFuel === 'number' && v.maxFuel > 0 ? v.maxFuel : 100;
  return _fuel;
}

/** Weapon price lookup, exported so a menu could show a shop list later. */
export function ammoPrice(id) {
  return WEAPON_LIB[id]?.price ?? 5;
}
