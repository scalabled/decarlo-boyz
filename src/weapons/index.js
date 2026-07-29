import * as THREE from 'three';
import { Rng } from '../core/rng.js';
import { WeaponMaterials } from './materials.js';
import { WeaponRig } from './rig.js';
import { ProjectileSim } from './ballistics.js';
import { MeleeSolver } from './melee.js';
import { EmpField } from './emp.js';
import { FireField } from './fire.js';
import { PaintField } from './paint.js';
import { Tether } from './tether.js';
import { buildModel } from './models/index.js';
import {
  ALL_WEAPONS, WEAPON_ORDER, WEAPON_CLASSES, CLASS_EXEMPLAR, BROTHER_LOADOUT,
  BROTHER_SIGNATURE, BROTHER_HANDLING, NEUTRAL_HANDLING, BROTHER_START,
  buildRecoilPattern, SPREAD_MODS,
} from './lib.js';
import { clamp, clamp01, lerp, DEG } from './mathx.js';

/**
 * WEAPONS — the improvised arsenal, held in a character's hand.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * WHAT THIS IS
 * ────────────────────────────────────────────────────────────────────────────
 * Sixteen weapons: four melee tools, four light guns, four precise ones and
 * four ways to blow something up.
 * Nothing military — a length of dock pipe, a framing nailer, a marine flare
 * gun, a nitrous bottle in a welded tube, and a capacitor bank that kills a
 * cruiser's engine. The weapon table's five numbers (dmg / rate / range / ammo
 * / pellets-splash) are authoritative and drive the ballistics directly; see
 * the long note at the top of `lib.js`.
 *
 *   lib.js         the sixteen definitions + the derived ballistics
 *   models/*.js    the sixteen procedural meshes (kit.js is the shared parts
 *                  bin: pipe, coupling, weld bead, tape wrap, hose clamp,
 *                  gauge, coil winding, capacitor, barbed head, nail strip)
 *   mats_improvised.js  rust, galvanising, forged steel, duct tape, enamel,
 *                  copper, brass — every one riding the baked curvature masks
 *   rig.js         THE THIRD-PERSON RIG: slaves the weapon to the player's
 *                  right-hand bone, holsters it on the body, and writes the
 *                  arm bones directly for a melee swing
 *   ballistics.js  travelling projectiles: drag, drop, motors, fuses, bounces,
 *                  tethers, and a real mesh for anything slow enough to watch
 *   melee.js       the swing arc, the contact frame and the fan sweep
 *   emp.js         the EMP Coil's discharge — engines and lights
 *   fire.js        what the Flare Gun's `ignites` leaves on the ground: a
 *                  burning patch that lights the street and burns whoever
 *                  stands in it (`fx.spawnFire` never existed — see the header)
 *   paint.js       what the Paint Cannon's `marks` does: blinds the target and
 *                  leaves a splat of enamel that rides him while he runs
 *   tether.js      the Harpoon's line — a distance constraint that reels the
 *                  target in, plus the rope you can see between the two
 *
 * The inherited Call-of-Duty first-person viewmodel (`viewmodel.js`,
 * `hands.js`, `models/{rifle,smg,pistol}.js`) is no longer on the boot path:
 * this is a third-person game and a rifle in a viewmodel was both the wrong
 * framing and the wrong content.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * PUBLIC API — `const wp = ctx.get('weapons')`
 * ────────────────────────────────────────────────────────────────────────────
 *   wp.current            the finalised def of the weapon in hand
 *   wp.ammo               { mag, chambered, reserve, magSize, total, empty }
 *   wp.fireMode           'auto' | 'semi'
 *   wp.spreadDegrees      live cone half-angle — the crosshair gap
 *   wp.adsProgress        0..1     (read by `render` for the ADS DoF blend)
 *   wp.reloading / wp.firing / wp.switching / wp.swinging
 *   wp.weaponIds          every id this system knows
 *   wp.loadout            the ids the active brother is carrying
 *   wp.setLoadout(ids)    e.g. on `game:character`
 *   wp.giveWeapon(id)     add to the loadout (a mission unlock)
 *   wp.addAmmo(id, n)     a pickup or an ammo shop
 *   wp.setWeapon(id)      animated holster -> draw
 *   wp.nextWeapon() / wp.prevWeapon() / wp.cycleFireMode()
 *   wp.reload() / wp.tryFire() / wp.tryMelee()
 *   wp.muzzleWorld(v3)    world-space muzzle (read by `fx`)
 *   wp.isBlinded(actor)   true while a Paint Cannon hit has him blinded
 *   wp.firesBurning       how many flare fires are alight right now
 *   wp.debugPose(kind)    'idle'|'ads'|'fire'|'melee'|'light'|'precise'|
 *                         'explosive'|<weaponId>   (the capture harness)
 *   wp.getHudState()      the `ui` adapter (id, ammo, loadout, ammoByWeapon)
 *
 * EVENTS EMITTED  (all canonical, see ARCHITECTURE.md)
 *   weapon:fire    { weapon, origin, dir, seed }
 *   weapon:shell   { position, velocity, caseLen, caseRadius, spin }
 *   weapon:reload  { weapon, phase: 'start'|'magout'|'magin'|'end' }
 *   bullet:tracer  { from, to, speed }
 *   explosion      { position, radius, damage }   (the four explosives)
 * `bullet:impact` comes from `physics`, because `physics` owns penetration.
 *
 * A MELEE HIT DELIBERATELY DOES NOT RAISE `weapon:fire`. That event startles
 * every ped inside 70 m and books the player for discharging a firearm
 * (`police/index.js`); a punch is neither. Melee reaches the world through the
 * `bullet:impact` / `damage:dealt` pair that `physics.fireBullet` raises, which
 * is a 14 m startle radius and no wanted level — correct for a brawl.
 */
/**
 * The hard ceiling on anything this system pushes into `player.setAdsProgress`
 * while the player is NOT aiming. `player/index.js` turns that value into
 * `m.aiming` at **0.35** and `player/movement.js` refuses to sprint while
 * aiming, so a carry pose at or above it silently disables Shift. 0.30 leaves
 * 0.05 of margin. See the long note at the `ready` computation in `update()`.
 *
 * If `player` ever exposes a dedicated carry-pose input, route through that
 * instead and delete this. `arsenalprobe.mjs --sprint` fires the whole arsenal
 * in-engine and fails if any weapon costs the player his sprint, so this cannot
 * regress silently even if `player` moves its threshold.
 */
const READY_CAP = 0.30;

/**
 * Carry-pose weight per hold type — how high the weapon rides when it is drawn
 * but not aimed. Ordered the way the poses want to read (a shouldered tube sits
 * higher than a pistol-gripped nailer) and all under `READY_CAP`.
 */
const READY_FLOOR = {
  oneHand: 0.20,
  twoHand: 0.28,
  shoulder: 0.30,
};

/**
 * Hard ceiling on the fire-cycle remainder carried between rounds, seconds.
 *
 * 0.1 s is `engine.js`'s own clamp on `rawDt` — the longest single frame the
 * simulation will ever be told about — so this is "never bank more than one
 * engine frame", expressed as the largest that frame can be. It was 0.05, and
 * on a loaded machine (measured frames of 52-100 ms in `arsenalprobe`) that
 * silently stopped correcting exactly where the error is worst: the Rivet Gun
 * read 146 rpm against a stated 300. At most one round leaves per frame no
 * matter what is banked, so a larger ceiling cannot produce a burst.
 */
const MAX_CADENCE_CARRY = 0.1;

/**
 * How long the trigger is dead after it clicks on an empty chamber, seconds.
 * Long enough that mashing the button produces a rhythm of clicks rather than
 * a buzz, short enough that it is never mistaken for the gun being broken.
 */
const DRY_FIRE_LOCKOUT = 0.3;

export class WeaponSystem {
  static id = 'weapons';
  static deps = ['materials', 'physics'];

  constructor() {
    this.rig = null;
    this.sim = null;
    this.melee = null;
    this.empField = null;
    this.states = new Map();
    this.activeId = 'fists';
    this.loadout = ['fists'];
    this.debugMode = null;
    /** Which brother's hands these are. Drives `hand`, see `setBrother`. */
    this.brotherId = null;
    /** Live per-brother handling multipliers (see lib.js BROTHER_HANDLING). */
    this.hand = { ...NEUTRAL_HANDLING };

    /**
     * A/B SWITCHES FOR THE GATE'S NEGATIVE CONTROLS. All null/false in play.
     *
     * ARCHITECTURE.md rule 12: a gate that has never failed is not evidence of
     * anything, so `arsenalprobe.mjs --nc=<arm>` reverts one fix at runtime and
     * proves the corresponding check goes red. These three are the reverts.
     *
     *   debugReadyFloor      force the carry-pose weight (0.46 = pre-fix, the
     *                        value that latched the player into aim-walk)
     *   debugNoCadenceCarry  drop the fire-cycle remainder, quantising every
     *                        automatic's rate up to whole frames
     *   debugUniformHandling ignore BROTHER_HANDLING, so all three brothers
     *                        shoot identically again
     */
    this.debugReadyFloor = null;
    /** The carry pose the `sprint` control forces into the aim channel. */
    this._ncAim = 0;
    this.debugNoCadenceCarry = false;
    this.debugUniformHandling = false;
    /** Restore the pre-fix "everything holsters in a car" for the drive-by NC. */
    this.debugHolsterInCar = false;
    /**
     * Restore the pre-fix "the ownership poll runs while a capture pose is
     * frozen", which took the posed weapon out of the character's hands half a
     * second after `debugPose` put it there. See the poll in `update`.
     */
    this.debugPosePoll = false;
    /**
     * Restore the pre-fix "the arsenal reads the keyboard from behind a modal",
     * i.e. drop the `ui.isPaused()` term out of `live`. See `_paused` and the
     * negative control in `pauseprobe.mjs --nc`.
     */
    this.debugIgnorePause = false;

    /** Story completion grants the whole arsenal. See `unlockEverything`. */
    this.unlockAll = false;
    /** Ids granted this session, ahead of the save catching up. */
    this._granted = [];
    /** True while a ranged weapon is in hand inside a vehicle (drive-by). */
    this.driveBy = false;

    this._fireTimer = 0;
    /** Last frame's dt, the unit the fire-cycle remainder is bounded in. */
    this._lastDt = 1 / 60;
    this._semiLatch = false;
    this._spread = 0;
    this._shotIndex = 0;
    this._sinceShot = 10;
    this._swingSide = 1;
    this._swingContactAt = -1;
    this._autoCycleAt = 0;
    this._switchTo = null;
    /** null = automatic (vehicle / dead); true|false = forced. */
    this.holsterOverride = null;

    this._muzzle = new THREE.Vector3();
    this._dir = new THREE.Vector3();
    this._right = new THREE.Vector3();
    this._up = new THREE.Vector3();
    this._tmp = new THREE.Vector3();
    this._camDir = new THREE.Vector3();
    this._disc = { x: 0, y: 0 };

    /**
     * `weapon` on the fire payload is a PURPOSE-BUILT descriptor, not the def.
     * `fx/muzzle.js` keys its flash profile on `weapon.class` first and `audio`
     * keys its report on `weapon.audio`; handing them the raw def would send
     * `class: 'light'`, which matches no muzzle profile and silently gives a
     * nail gun an assault-rifle flash.
     */
    this._fireWeapon = { id: '', name: '', class: 'smg', audio: 'smg', suppressed: false };
    this._firePayload = {
      weapon: this._fireWeapon,
      origin: new THREE.Vector3(),
      dir: new THREE.Vector3(),
      seed: 0,
      recoil: 1,
      fx: true,
      flashScale: 1,
      melee: false,
      /* `audio._onFire` routes on this to the dry click. See `tryFire`. */
      empty: false,
    };
    this._dryAt = -99;
    this._reloadPayload = { weapon: null, phase: 'start', position: new THREE.Vector3() };
    this._shellPayload = {
      position: new THREE.Vector3(),
      velocity: new THREE.Vector3(),
      weapon: null,
      caseLen: 0.0192,
      caseRadius: 0.00478,
      spin: 0,
    };
    this._pendingShots = 0;
    this._pendingSwings = 0;
    this._pendingFirst = false;
    this._fireSeed = 0;

    this._shellQueue = [];
    for (let i = 0; i < 8; i++) this._shellQueue.push({ t: -1 });

    this._state = {
      ads: false, sprint: false, speed: 0, crouch: false, airborne: false,
      trigger: false, empty: false, holstered: false,
    };
    this._hudState = {
      id: 'fists', name: '', mode: 'semi', ammo: 0, reserve: 0, magSize: 0,
      reloading: false, reloadProgress: 0, ads: false, spread: 0, firing: false,
      melee: false, loadout: [], ammoByWeapon: {},
      empty: false, dry: false, dryFired: false, driveBy: false,
      brother: null, locked: [],
    };
    this._ammoByWeapon = {};

    /* debug / capture */
    this._poseCamera = null;
    this._poseTarget = new THREE.Vector3();
    this._poseEye = new THREE.Vector3();
    this._scriptFrames = null;
    this._debugFrame = 0;
  }

  /* ====================================================================== */
  /*  init                                                                  */
  /* ====================================================================== */

  async init(ctx) {
    this.ctx = ctx;
    this.rng = ctx.rng.fork();
    this.mats = new WeaponMaterials(ctx);
    this.sim = new ProjectileSim(ctx, this.mats);
    this.melee = new MeleeSolver(ctx);
    this.empField = new EmpField(ctx);
    /* The flare's `ignites` and the sprayer's `marks`, both of which were
     * declared in `lib.js` and read by nothing. See fire.js / paint.js. */
    this.fireField = new FireField(ctx);
    this.paintField = new PaintField(ctx, this.mats);
    this.sim.emp = this.empField;
    this.sim.fire = this.fireField;
    this.sim.paint = this.paintField;
    this.tether = new Tether(ctx, this.mats);
    this.sim.tether = this.tether;
    this.rig = new WeaponRig(ctx, this.mats);
    this.rig.onClipEvent = (name, clip) => this._onClipEvent(name, clip);
    /* The shooter's end of the line is the muzzle, which only the rig knows. */
    this.tether.muzzle = (out) => this.rig.muzzleWorld(out);
    /**
     * `tools/demo-driver.js` and the inherited capture path both reach for
     * `weapons.viewmodel`. The first-person rig is gone; the third-person one
     * answers to the same handful of properties, so nothing outside this
     * directory has to change.
     */
    this.viewmodel = this.rig;

    const t0 = performance.now();
    let tris = 0;
    for (const id of WEAPON_ORDER) {
      const def = ALL_WEAPONS[id];
      /* One deterministic sub-stream per weapon: the dents in the Dock Pipe are
       * the same dents in every session and in every capture (rule 4). */
      const rng = new Rng((0x5eed_0000 ^ hash(id)) >>> 0);
      const model = buildModel(id, rng);
      if (!model) {
        console.warn(`[weapons] no model for ${id}`);
        continue;
      }
      const entry = this.rig.add(model, def, rng);
      tris += entry.tris;
      this.states.set(id, {
        def,
        pattern: buildRecoilPattern(def, Rng),
        mag: def.magSize,
        chambered: !def.melee,
        reserve: def.reserve,
        mode: def.modes[0],
        modeIndex: 0,
      });
      this._ammoByWeapon[id] = def.melee ? Infinity : def.reserve + def.magSize;
    }

    /* The brother the game starts on. `game:character` re-sets this. */
    this.setBrother(ctx.peek('player')?.brother?.id ?? 'carson', true);

    this.player = ctx.peek('player');
    this.physics = ctx.peek('physics');
    this._off = [];
    const on = (t, fn) => this._off.push(ctx.events.on(t, fn));
    /* `ui` emits this when the weapon wheel closes. Until now nothing listened
     * to it, which is why picking "DOCK PIPE" off the wheel changed the HUD
     * text and nothing else. */
    on('ui:weapon', (e) => { if (e?.id) this.setWeapon(e.id); });
    on('game:character', (e) => { if (e?.id) this.setBrother(e.id, true); });
    /**
     * UNLOCKS. `game.economy.unlockWeapon()` is the authority and it does not
     * announce itself, so `_resolveUnlocks` re-reads it on a slow tick (see
     * `update`) as well as reacting to whatever events do arrive. Both paths
     * are cheap and idempotent; having only the event path is what let a
     * chapter reward sit unusable until the next character switch.
     */
    on('game:unlock', (e) => {
      if (!e) return;
      if (this._isUnlockAll(e)) return void this.unlockEverything();
      if ((e.kind === 'weapon' || e.kind === 'weapons') && e.id) this.giveWeapon(e.id);
      this._resolveUnlocks();
    });
    /* The missions agent's story-completion reward. Spelt several ways on
     * purpose: this system must not be the reason the reward silently does
     * nothing, and every one of these is a no-op if it never fires. */
    for (const t of ['game:unlockall', 'game:weapons:unlockall', 'game:complete', 'story:complete']) {
      on(t, (e) => { if (!e || this._isUnlockAll(e) || e.all !== false) this.unlockEverything(); });
    }

    /**
     * GAME START: every unlocked ranged weapon comes up at least half stocked.
     * A save resumed with three rounds in a Rivet Gun and nothing in reserve is
     * a save that opens with a walk to a shop.
     */
    for (const id of this.loadout) this._grantAmmo(id, 0.5);

    this.stats = { tris, drawCalls: 0, live: 0, fired: 0, weapons: this.states.size };
    console.info(
      `[weapons] ${this.states.size} improvised weapons · ${(tris / 1000).toFixed(1)}k tris · ` +
        `built in ${(performance.now() - t0).toFixed(0)}ms`
    );
  }

  /* ====================================================================== */
  /*  inventory                                                             */
  /* ====================================================================== */

  /**
   * Switch the whole system to a brother: his loadout, his handling and the
   * weapon he comes up holding.
   *
   * `equip` is false when only the numbers should move (a save/load restoring
   * state, a probe) and true on a real character switch.
   */
  setBrother(id, equip = false) {
    const l = BROTHER_LOADOUT[id];
    if (!l) return false;
    this.brotherId = id;
    Object.assign(this.hand,
      this.debugUniformHandling ? NEUTRAL_HANDLING : (BROTHER_HANDLING[id] ?? NEUTRAL_HANDLING));
    /* The rig scales its own clip and blend times off the same profile, so a
     * brother's draw, holster, swap and reload all move together. */
    if (this.rig) {
      this.rig.handling = this.hand.handling;
      this.rig.reloadScale = this.hand.reload;
    }
    this._resolveUnlocks();
    if (equip) {
      const want = BROTHER_SIGNATURE[id];
      const ok = this.loadout.includes(want) ? want
        : (this.loadout.find((w) => !ALL_WEAPONS[w].melee) ?? this.loadout[1] ?? this.loadout[0]);
      this.setWeaponImmediate(ok ?? 'fists');
    }
    return true;
  }

  /**
   * THE LOADOUT IS THE SAVE'S, NOT THIS FILE'S.
   *
   * Until now `setBrother` handed the weapon wheel all six of `BROTHER_LOADOUT`
   * unconditionally, so a brand-new save could draw a Scrap Rocket in the first
   * minute and the eight chapters' worth of `unlock:` rewards changed nothing
   * but a toast. `game.economy` is the authority — `loadout(id, boy)` returns
   * the brother's `start` kit plus everything his chapters have actually
   * granted — and it is read at runtime through `peek`, never imported, so a
   * build without `game` (the preview page, the model harness) still gets a
   * full arsenal rather than an empty wheel.
   *
   * `unlockAll` is the story-completion reward: once all twenty-four chapters
   * are done every brother carries everything.
   */
  _resolveUnlocks() {
    const id = this.brotherId;
    const all = BROTHER_LOADOUT[id];
    if (!all) return this.loadout;
    if (this.unlockAll) return this.setLoadout(all);

    const game = this._game ?? (this._game = this.ctx.peek('game'));
    const econ = game?.economy;
    let owned;
    if (econ?.loadout) {
      /* `economy.loadout` wants the boy record only for its `start` array, and
       * `BROTHER_START` is byte-identical to `src/game/data.js`'s. Passing
       * this system's own copy avoids reaching into another subsystem's data
       * table for a field already held here. */
      owned = econ.loadout(id, { start: BROTHER_START[id] ?? ['fists'] });
    } else {
      owned = (BROTHER_START[id] ?? ['fists']).slice();
    }
    /* Anything granted this session that the save has not caught up with. */
    for (const w of this._granted ?? []) if (!owned.includes(w)) owned.push(w);
    /* Canonical wheel order, so the wheel never reshuffles as things unlock. */
    const out = all.filter((w) => owned.includes(w));
    if (!out.length) out.push('fists');
    return this.setLoadout(out);
  }

  /**
   * Story completion: every brother carries the whole arsenal. Idempotent.
   * Honours the missions agent's unlock-all however it chooses to spell it —
   * see the listener registrations in `init`.
   */
  unlockEverything() {
    if (this.unlockAll) return false;
    this.unlockAll = true;
    this._resolveUnlocks();
    for (const id of this.loadout) this._grantAmmo(id, 0.5);
    return true;
  }

  /** The ids this brother carries, in weapon-wheel order. */
  setLoadout(ids) {
    const out = [];
    for (const id of ids ?? []) if (this.states.has(id)) out.push(id);
    if (!out.length) out.push('fists');
    this.loadout = out;
    this._hudState.loadout = out;
    if (!out.includes(this.activeId)) this.setWeaponImmediate(out[0]);
    return out;
  }

  /**
   * Grant a weapon — a mission reward, a pickup, a shop.
   *
   * A grant hands over a HALF MAGAZINE with the weapon, and that
   * detail matters more than it looks: a weapon unlocked with an empty mag is
   * a toast that changes nothing until the player finds a shop, so the reward
   * beat lands on the wrong side of a drive across the map.
   */
  giveWeapon(id) {
    if (!this.states.has(id)) return false;
    if (!this._granted) this._granted = [];
    if (!this._granted.includes(id)) this._granted.push(id);
    if (this.loadout.includes(id)) return false;
    /* Insert in canonical wheel order so the wheel never reshuffles. */
    const order = WEAPON_ORDER.indexOf(id);
    let i = 0;
    while (i < this.loadout.length && WEAPON_ORDER.indexOf(this.loadout[i]) < order) i++;
    this.loadout.splice(i, 0, id);
    this._hudState.loadout = this.loadout;
    this._grantAmmo(id, 0);
    return true;
  }

  /**
   * Bring a weapon up to a usable state.
   *
   * `floor` is the fraction of its TOTAL carried ammunition (magazine plus
   * reserve) it must end up with; 0 means "just the half magazine the grant
   * comes with". Never takes ammunition away.
   */
  _grantAmmo(id, floor = 0) {
    const s = this.states.get(id);
    if (!s || s.def.melee) return false;
    const half = Math.max(1, Math.ceil(s.def.magSize / 2));
    if (s.mag < half) s.mag = Math.min(s.def.magSize, half);
    s.chambered = true;
    if (floor > 0) {
      const total = s.def.magSize + s.def.reserve;
      const want = Math.ceil(total * floor);
      const have = s.mag + s.reserve;
      if (have < want) s.reserve = Math.min(s.def.reserve, s.reserve + (want - have));
    }
    this._ammoByWeapon[id] = s.mag + s.reserve;
    return true;
  }

  /** Does this payload mean "unlock everything", however it is spelt? */
  _isUnlockAll(e) {
    if (!e) return false;
    if (e.all === true) return true;
    const id = String(e.id ?? '');
    const kind = String(e.kind ?? '');
    return id === 'all' || id === '*' ||
      ((kind === 'weapon' || kind === 'weapons') && (id === 'all' || id === '*')) ||
      kind === 'allweapons' || kind === 'unlockall';
  }

  /** A pickup, a mission reward, or the Foundry Supply counter. */
  addAmmo(id, n) {
    const s = this.states.get(id);
    if (!s || s.def.melee) return false;
    s.reserve = Math.max(0, Math.min(s.def.reserve * 2, s.reserve + (n ?? s.def.reserve)));
    return true;
  }

  /**
   * Force the weapon onto the body (or back into the hand), overriding the
   * automatic rule. `null` returns control to the automatic rule.
   */
  setHolstered(v) {
    this.holsterOverride = v === null || v === undefined ? null : !!v;
    return this.holsterOverride;
  }

  /** Top every magazine up — what `game.freeroam` does at a safehouse. */
  refillAll() {
    for (const s of this.states.values()) {
      if (s.def.melee) continue;
      s.reserve = s.def.reserve;
      s.mag = s.def.magSize;
      s.chambered = true;
    }
  }

  /* ====================================================================== */
  /*  getters                                                               */
  /* ====================================================================== */

  get state() { return this.states.get(this.activeId); }
  get current() { return this.state?.def ?? null; }
  get weaponIds() { return [...this.states.keys()]; }

  get ammo() {
    const s = this.state;
    if (!s) return { mag: 0, chambered: false, reserve: 0, magSize: 0, total: 0, empty: true };
    if (s.def.melee) {
      return { mag: Infinity, inMag: Infinity, chambered: true, reserve: Infinity,
        magSize: 0, total: Infinity, empty: false };
    }
    const ch = s.chambered ? 1 : 0;
    return {
      mag: s.mag + ch,
      inMag: s.mag,
      chambered: s.chambered,
      reserve: s.reserve,
      magSize: s.def.magSize,
      total: s.mag + ch + s.reserve,
      empty: s.mag + ch === 0,
    };
  }

  get fireMode() { return this.state?.mode ?? 'semi'; }
  get adsProgress() { return this.rig?.adsT ?? 0; }
  get reloading() {
    const n = this.rig?.clipName;
    return n === 'reloadTac' || n === 'reloadEmpty';
  }
  get inspecting() { return this.rig?.clipName === 'inspect'; }
  get switching() { return this.rig?.swapping === true; }
  get firing() { return this._sinceShot < 0.12; }
  get swinging() { return this.rig?.swinging === true; }
  get spreadDegrees() { return this._spread; }

  muzzleWorld(out) { return this.rig.muzzleWorld(out ?? this._tmp); }

  /**
   * Has this actor taken a face full of enamel recently?
   *
   * The Paint Cannon's `marks` flag needs somewhere to live, and the state
   * belongs to the weapon that caused it rather than to the target's own
   * system. `peds` and `police` can consult this when they want a hostile who
   * cannot see to stop shooting straight; until they do, the blinding is
   * expressed as the close, high-severity panic `paint.js` raises on the hit.
   */
  isBlinded(actor) { return this.paintField?.isBlinded(actor) ?? false; }

  /** Live fires started by the Flare Gun — `game` may want to know. */
  get firesBurning() { return this.fireField?.live ?? 0; }

  /**
   * HUD adapter polled by `ui` every lateUpdate.
   *
   * `ui/index.js:_pullState` wants THREE fields the inherited system never
   * published — `id` (which drives the weapon name, glyph and melee flag off
   * `ui/data.js`), `loadout` and `ammoByWeapon` (which drive the wheel). Without
   * them the HUD fell back to its seeded state, which is exactly why every
   * screenshot read "DOCK PIPE" while the engine held an M4A1.
   */
  getHudState() {
    const h = this._hudState;
    const s = this.state;
    if (!s) return h;
    const a = this.ammo;
    h.id = this.activeId;
    h.name = s.def.label ?? s.def.id;
    h.mode = s.mode;
    h.melee = !!s.def.melee;
    h.ammo = s.def.melee ? 0 : Math.min(a.mag, Math.max(1, a.magSize));
    h.reserve = s.def.melee ? 0 : a.reserve;
    h.magSize = s.def.magSize;
    h.reloading = this.reloading;
    h.reloadProgress = h.reloading && this.rig?.clip?.duration
      ? Math.min(1, this.rig.clipT / this.rig.clip.duration)
      : 0;
    /**
     * `empty` and `dryFired` are for `ui` to grey the weapon slot with. State
     * only — nothing is rendered here. `empty` is "nothing left to chamber",
     * `dryFired` goes true for the length of the click's lockout so the HUD can
     * flash rather than just sit greyed.
     */
    h.empty = !s.def.melee && a.mag === 0;
    h.dry = !s.def.melee && a.total === 0;
    h.dryFired = (this.ctx.time?.elapsed ?? 0) - this._dryAt < DRY_FIRE_LOCKOUT;
    h.driveBy = this.driveBy === true;
    h.brother = this.brotherId;
    h.locked = WEAPON_ORDER.filter((w) => !this.loadout.includes(w));
    h.ads = this.adsProgress > 0.5;
    /* `ui` maps this to reticle bloom as 4 + spread * 40 px. */
    h.spread = clamp01(this._spread / 6);
    h.firing = this.firing;
    h.loadout = this.loadout;
    for (const id of this.loadout) {
      const st = this.states.get(id);
      if (st) this._ammoByWeapon[id] = st.def.melee ? Infinity : st.mag + st.reserve;
    }
    h.ammoByWeapon = this._ammoByWeapon;
    return h;
  }

  /* ====================================================================== */
  /*  weapon management                                                     */
  /* ====================================================================== */

  /**
   * Change weapon.
   *
   * The state moves NOW. `activeId`, `current`, `ammo` and `getHudState()` are
   * all correct on the frame the key is pressed; the rig runs a short down-and-
   * up so it still reads as putting one thing away and bringing another out.
   *
   * The previous version parked `activeId` behind a holster CLIP and only
   * committed on its `end` event. With the Dock Pipe's 0.4 s holster that is
   * twenty-four frames in which every reader — the HUD, `game`, `ui`, a probe —
   * still saw the old weapon, which is indistinguishable from the key doing
   * nothing at all.
   */
  /**
   * Is this weapon drawable right now?
   *
   * The wheel offers `loadout` and only `loadout`, but `ui:weapon`, a debug
   * key and a mission script can all name an id directly, so the refusal has
   * to live at the draw rather than at the menu — otherwise "unlock
   * progression is enforced" means "enforced in one of the three ways you can
   * select a weapon".
   */
  canDraw(id) { return this.states.has(id) && this.loadout.includes(id); }

  setWeapon(id, force = false) {
    const s = this.states.get(id);
    if (!s || id === this.activeId) return false;
    if (!force && !this.loadout.includes(id)) {
      this._notify(s.def.label ?? id, 'LOCKED', 'slag');
      return false;
    }
    const from = this.current;
    this._switchTo = null;
    this._autoCycleAt = 0;
    this._swingContactAt = -1;
    this.rig.stopClip();
    this.rig.swingT = -1;
    this.activeId = id;
    this._shotIndex = 0;
    this._spread = 0;
    this._fireTimer = Math.max(this._fireTimer, 0.18);
    /* The swap is the brother's hands as much as the weapon's weight, so it
     * rides the same `handling` multiplier as draw, holster and ADS. */
    const hf = 0.42 * this.hand.handling;
    this.rig.swapTo(id, (from?.holsterTime ?? 0.34) * hf, (s.def.drawTime ?? 0.5) * hf);
    this.rig.setLoaded(true);
    this._notify(s.def.label ?? id, s.def.melee ? 'MELEE' : `${s.mag + (s.chambered ? 1 : 0)} / ${s.reserve}`);
    return true;
  }

  /** GAMEPLAY.md: every action produces a toast. `ui` may not exist yet. */
  _notify(title, value, kind = 'slag') {
    const ui = this._ui ?? (this._ui = this.ctx.peek('ui'));
    ui?.notify?.(title, value, kind);
  }

  /**
   * IS A UI MODAL HOLDING THE WORLD STILL?
   *
   * ---------------------------------------------------------------------
   * WHY THIS EXISTS — `time.scale = 0` DOES NOT STOP A SUBSYSTEM READING INPUT
   * ---------------------------------------------------------------------
   * `src/core/engine.js` calls `update(dt)` on every subsystem every frame
   * however slow the clock is, and input EDGES (`pressed`, `actionPressed`)
   * arrive at full rate regardless of the clock. Everything in `update` that
   * integrates against `dt` is a no-op by arithmetic while paused; the block of
   * edge reads is NOT, and this system is the one holding the keys that change
   * what is in the player's hands.
   *
   * `game._update` gates its own J / K / U on the same predicate, but `weapons`
   * is a separate subsystem and that gate never covered it. MEASURED on the
   * shipped tree with the pause menu at opacity 1 and `time.scale 0` asserted in
   * the same snapshot: `Digit1` swapped the weapon, `E` and `Q` cycled the
   * loadout, and `I` played the inspect animation — so you opened the menu,
   * pressed a key, closed the menu, and came back holding something else, with
   * the HUD chip changing under the menu to prove it. See `pauseprobe.mjs`.
   *
   * `ui` owns `ctx.time.scale` and publishes `isPaused()` — ONE predicate, true
   * while any modal has the world at a standstill. Reached through `ctx.peek`,
   * never an import (ARCHITECTURE.md rule 2).
   *
   * NOT the weapon wheel. The wheel claims bullet time (SLOW), not a freeze, so
   * `isPaused()` is false under it and the number row goes on working while it
   * is up — which is the whole point of a radial selector. Gating on "any
   * overlay is visible" instead would break TAB, and `pauseprobe.mjs` has a
   * check that fails if anyone tries it.
   *
   * Duck-typed and failure-tolerant on purpose: `ui` is optional (the model
   * preview page and every headless bench boot without it), and a HUD that
   * throws must never cost the frame or freeze the arsenal. No `ui` means
   * nothing is paused, which is the correct answer for a build with no menus.
   */
  _paused() {
    if (this.debugIgnorePause) return false;
    try {
      const ui = this._ui ?? (this._ui = this.ctx.peek('ui'));
      return typeof ui?.isPaused === 'function' && ui.isPaused() === true;
    } catch {
      return false;
    }
  }

  nextWeapon() {
    const l = this.loadout;
    const i = l.indexOf(this.activeId);
    return this.setWeapon(l[(i + 1) % l.length]);
  }

  prevWeapon() {
    const l = this.loadout;
    const i = l.indexOf(this.activeId);
    return this.setWeapon(l[(i - 1 + l.length) % l.length]);
  }

  cycleFireMode() {
    const s = this.state;
    if (!s || s.def.modes.length < 2) return s?.mode;
    s.modeIndex = (s.modeIndex + 1) % s.def.modes.length;
    s.mode = s.def.modes[s.modeIndex];
    return s.mode;
  }

  reload() {
    const s = this.state;
    if (!s || s.def.melee || this.reloading || this.switching) return false;
    if (s.mag >= s.def.magSize || s.reserve <= 0) return false;
    this.rig.stopClip();
    const empty = s.mag === 0 && !s.chambered;
    this.rig.play(empty ? 'reloadEmpty' : 'reloadTac');
    return true;
  }

  inspect() {
    if (this.reloading || this.switching || this.inspecting) return false;
    this.rig.play('inspect');
    return true;
  }

  /* ====================================================================== */
  /*  firing                                                                */
  /* ====================================================================== */

  canFire() {
    const s = this.state;
    if (!s) return false;
    if (this.reloading || this.switching || this._fireTimer > 0) return false;
    return s.def.melee ? !this.rig.swinging : s.chambered;
  }

  /** Route the trigger: a wrench swings, everything else shoots. */
  attack() {
    const s = this.state;
    if (!s) return false;
    return s.def.melee ? this.tryMelee() : this.tryFire();
  }

  /**
   * THE SWING. The damage does not land here — it lands on the contact frame,
   * `swing.contact` of the way through the arc, which `_advanceSwing` resolves.
   */
  tryMelee() {
    const s = this.state;
    if (!s || !s.def.melee) return false;
    if (this.rig.swinging || this._fireTimer > 0 || this.switching) return false;
    const sw = s.def.swing;
    if (sw.alternate) this._swingSide = -this._swingSide;
    const dur = this.rig.startSwing(sw, this._swingSide);
    this._swingContactAt = dur * sw.contact;
    this._fireTimer = s.def.cycleTime;
    this._sinceShot = 0;
    /* A swing is a body movement: the camera dips into it and comes back. */
    this.player?.addKick?.(-s.def.stagger * 0.03, this._swingSide * s.def.stagger * 0.02, 0);
    this._pendingSwings++;
    return true;
  }

  /**
   * A swing raises `weapon:fire` WITH NO `origin`.
   *
   * That is not sloppiness, it is the whole point. Every consumer of that event
   * either wants "the player attacked" or "a gun went off HERE", and the two
   * are told apart by the presence of a position:
   *
   *   fx      `if (!e.origin) return`  -> no muzzle flash for a crowbar
   *   peds    `if (!e.origin) return`  -> a punch does not panic a 70 m radius
   *   police  `if (!e?.origin) return` -> no `gunfire` crime for a pipe
   *   traffic `if (p?.origin)`         -> no lane panic
   *   ui      reads `e.recoil`         -> the crosshair still kicks
   *   audio   falls back to the listener with the `suppressed` profile
   *
   * The alternative — emitting the muzzle position — gives the player a wanted
   * star for swinging a wrench, which is a worse bug than the one it fixes.
   * The damage and the world reaction come from the contact frame instead, via
   * `physics.fireBullet` -> `bullet:impact` (14 m startle, no crime).
   */
  _emitSwing() {
    const def = this.current;
    if (!def) return;
    const w = this._fireWeapon;
    w.id = def.id;
    w.name = def.label;
    w.class = def.fxClass;
    w.audio = def.audioProfile;
    w.suppressed = true;
    const p = this._firePayload;
    const keepOrigin = p.origin;
    p.weapon = w;
    p.origin = null;
    p.melee = true;
    p.fx = false;
    p.recoil = 0.5;
    this.ctx.events.emit('weapon:fire', p);
    p.origin = keepOrigin;
    p.melee = false;
  }

  /** One round leaves the barrel. Returns false if the trigger clicked dry. */
  tryFire() {
    const s = this.state;
    if (!s || s.def.melee) return false;
    if (this.reloading || this.switching || this._fireTimer > 0) return false;
    /**
     * DRY FIRE — a click, a lockout and a state the HUD can grey out.
     *
     * Before this, an empty weapon produced a bolt hold and silence: no sound,
     * no feedback, nothing published, so the only way to learn you were out was
     * that the world stopped taking damage. `audio._onFire` has handled
     * `payload.empty` all along (it routes to `dryFire()` in
     * `audio/weapons.js`) and nothing had ever set it.
     *
     * The payload deliberately carries NO `origin`: `fx`, `peds`, `police` and
     * `traffic` all key "a gun went off here" on its presence, and a click is
     * not a discharge — it must not flash, must not panic a 70 m radius and
     * must not book the player for gunfire.
     */
    if (!s.chambered) {
      this.rig.boltHold = 1;
      this._fireTimer = DRY_FIRE_LOCKOUT;
      this._dryAt = this.ctx.time?.elapsed ?? 0;
      const dd = s.def;
      const w = this._fireWeapon;
      w.id = dd.id;
      w.name = dd.label;
      w.class = dd.fxClass;
      w.audio = dd.audioProfile;
      w.suppressed = true;
      const p = this._firePayload;
      const keepOrigin = p.origin;
      p.weapon = w;
      p.origin = null;
      p.empty = true;
      p.fx = false;
      p.recoil = 0;
      p.melee = false;
      this.ctx.events.emit('weapon:fire', p);
      p.origin = keepOrigin;
      p.empty = false;
      return false;
    }
    if (this.inspecting) this.rig.stopClip();

    const def = s.def;
    const first = this._sinceShot > 0.35;

    /* ---- feed ----------------------------------------------------------- */
    s.chambered = false;
    if (s.mag > 0) { s.mag--; s.chambered = true; }
    else this.rig.boltHold = 1;
    this.rig.setLoaded(false);

    /* ---- deterministic recoil pattern ------------------------------------ */
    /* The PATTERN stays the brother-independent thing a player memorises; only
     * its amplitude is scaled, so Carson and Dylan climb the same shape by
     * different amounts rather than needing two muscle memories. */
    const idx = Math.min(this._shotIndex, def.recoil.patternLength - 1);
    const rk = this.hand.recoil;
    const pitch = s.pattern[idx * 2] * rk;
    const yaw = s.pattern[idx * 2 + 1] * rk;
    this._shotIndex++;

    /* ---- aim: camera forward + the spread cone --------------------------- */
    const cam = this.ctx.camera;
    cam.updateMatrixWorld();
    this._camDir.set(0, 0, -1).applyQuaternion(cam.quaternion).normalize();

    /* The muzzle is in the character's hand, a metre below and to the side of
     * the camera, so firing straight down the camera axis would send rounds
     * past whatever the reticle is on. Converge on the aim POINT instead: cast
     * from the eye, then aim the round from the muzzle at what it found. This
     * is what every third-person shooter does and it is the difference between
     * "the crosshair means something" and "the crosshair is decorative". */
    this.rig.muzzleWorld(this._muzzle);
    const phys = this.physics ?? (this.physics = this.ctx.peek('physics'));
    let convergence = Math.max(12, def.range);
    if (phys?.raycast) {
      this._tmp.setFromMatrixPosition(cam.matrixWorld);
      const hit = phys.raycast(this._tmp, this._camDir, def.maxRange, phys.MASK?.BULLET);
      if (hit?.hit) convergence = Math.max(2.5, hit.distance);
    }
    this._tmp.setFromMatrixPosition(cam.matrixWorld).addScaledVector(this._camDir, convergence);
    this._dir.copy(this._tmp).sub(this._muzzle).normalize();

    this._right.set(1, 0, 0).applyQuaternion(cam.quaternion);
    this._up.set(0, 1, 0).applyQuaternion(cam.quaternion);

    /* ---- projectiles ----------------------------------------------------- */
    const seed = this.rng.u32();
    const pellets = Math.max(1, def.pellets);
    const spreadRad = this._spread * DEG;
    for (let i = 0; i < pellets; i++) {
      this._tmp.copy(this._dir);
      /* Every pellet of the Paint Cannon gets its own draw from the cone; the
       * single-projectile weapons take one only if the cone is open. */
      if (spreadRad > 1e-5 || pellets > 1) {
        const d = this.rng.disc(this._disc);
        const cone = Math.tan(Math.max(spreadRad, pellets > 1 ? def.spreadHip * DEG : 0));
        this._tmp
          .addScaledVector(this._right, cone * d.x)
          .addScaledVector(this._up, cone * d.y)
          .normalize();
      }
      this.sim.spawn({
        origin: this._muzzle,
        dir: this._tmp,
        speed: def.muzzleVelocity,
        damage: def.damage,
        penetration: def.penetration,
        dragK: def.dragK,
        dropoff: def.dropoff,
        maxRange: def.maxRange,
        weapon: def,
        tracer: def.tracerEvery > 0 && this.stats.fired % def.tracerEvery === 0,
      });
    }

    /* ---- feedback -------------------------------------------------------- */
    this.rig.addRecoil(pitch, yaw, first);
    /* THE RECOIL MOVES THE CHARACTER AND THE CAMERA, not a viewmodel. `punch`
     * is the boom's rearward shove, `trauma` the shake on top of the learnable
     * climb, and `body` scales how much of it the upper body absorbs. */
    const p = this.player;
    if (p) {
      p.addRecoil?.(pitch * def.recoil.body, yaw * def.recoil.body,
        def.recoil.roll * 0.35, def.recoil.punch);
      if (def.recoil.trauma > 0) p.addTrauma?.(def.recoil.trauma);
    }
    this._spread = Math.min(def.spreadMax * this.hand.spread,
      this._spread + def.spreadPerShot * this.hand.spread);
    /**
     * CARRY THE CADENCE REMAINDER — this is what makes an automatic run at the
     * rate it advertises.
     *
     * `_fireTimer` used to be assigned `def.cycleTime` flat and clamped at 0,
     * so the interval between rounds was quantised UP to whole frames: the Shop
     * SMG's 0.09 s cycle needs six 16.7 ms frames, which is 0.100 s, i.e. **600
     * rpm out of a gun the table, the HUD and the audio loop all call 667**.
     * The faster the weapon the worse it gets, and it gets worse again on a
     * loaded machine. Banking the overshoot (bounded to one cycle so a stall
     * can never dump a burst in a single frame) makes the long-run rate the
     * authored one at any frame rate.
     *
     * The remainder is only banked when this shot CONTINUES a burst
     * (`_sinceShot` inside two cycles). Banking an idle timer would let the
     * first pull of a trigger fire twice on consecutive frames.
     */
    const carry = this._sinceShot < def.cycleTime * 2 + this._lastDt && !this.debugNoCadenceCarry
      ? Math.max(-Math.min(def.cycleTime, this._lastDt), Math.min(0, this._fireTimer))
      : 0;
    this._fireTimer = def.cycleTime + carry;
    this._sinceShot = 0;
    this.stats.fired++;
    this._pendingShots++;
    this._pendingFirst = this._pendingFirst || first;
    this._fireSeed = seed;

    if (def.eject === 'brass') this._queueShell(Math.min(0.05, this._fireTimer * 0.45));
    else if (def.eject === 'flare-hull') this._queueShell(0.28);

    /* Single-shot actions cycle themselves: the reload IS the fire cycle. */
    if (def.autoCycle && s.reserve > 0) {
      this._autoCycleAt = def.cycleTime * 0.55;
    }
    return true;
  }

  _queueShell(delay) {
    for (const q of this._shellQueue) {
      if (q.t < 0) { q.t = delay; return q; }
    }
    return null;
  }

  /* ====================================================================== */
  /*  clip callbacks                                                        */
  /* ====================================================================== */

  _onClipEvent(name, clipName) {
    const isReload = clipName === 'reloadTac' || clipName === 'reloadEmpty';
    switch (name) {
      case 'start': if (isReload) this._emitReload('start'); break;
      case 'magout': if (isReload) this._emitReload('magout'); break;
      case 'magin':
        if (isReload) {
          this._emitReload('magin');
          this._completeReload(clipName === 'reloadEmpty');
          this.rig.setLoaded(true);
        }
        break;
      case 'boltrelease': this.rig.boltHold = 0; break;
      case 'end':
        if (isReload) { this._emitReload('end'); this.rig.boltHold = 0; }
        break;
      default: break;
    }
  }

  _completeReload(empty) {
    const s = this.state;
    if (!s) return;
    const want = s.def.magSize - s.mag;
    const take = Math.min(want, s.reserve);
    s.reserve -= take;
    s.mag += take;
    if (empty && !s.chambered && s.mag > 0) { s.mag--; s.chambered = true; }
    else if (!s.chambered && s.mag > 0) { s.mag--; s.chambered = true; }
    this._shotIndex = 0;
  }

  _emitReload(phase) {
    this._reloadPayload.weapon = this.current;
    this._reloadPayload.phase = phase;
    this.rig.muzzleWorld(this._reloadPayload.position);
    this.ctx.events.emit('weapon:reload', this._reloadPayload);
  }

  /* ====================================================================== */
  /*  frame                                                                 */
  /* ====================================================================== */

  fixedUpdate(h) {
    this.sim.fixedUpdate(h);
    /* The winch is a servo: it must see a FIXED dt or its gain is a function
     * of the frame rate. */
    this.tether.fixedUpdate(h);
  }

  update(dt, ctx) {
    const s = this.state;
    if (!s) return;
    const def = s.def;
    const input = ctx.input;
    const player = this.player ?? (this.player = ctx.peek('player'));
    const st = this._state;

    this._sinceShot += dt;
    /* Allowed ONE FRAME of undershoot: that overshoot is the cadence remainder
     * `tryFire` banks (see there). Denominated in the frame it was produced by
     * rather than in a constant, because the whole quantity being corrected is
     * "how far past the due time did this frame land" — a fixed 50 ms ceiling
     * silently stopped correcting once the frame got longer than 50 ms, which
     * is exactly the loaded machine where the error is worst. Hard-capped so an
     * idle trigger can never accumulate credit and dump a burst when pulled. */
    this._lastDt = Math.min(dt, MAX_CADENCE_CARRY);
    this._fireTimer = Math.max(-this._lastDt, this._fireTimer - dt);

    /* ---- the melee contact frame --------------------------------------- */
    if (this._swingContactAt >= 0 && this.rig.swingT >= this._swingContactAt) {
      this._swingContactAt = -1;
      this.melee.strike(def, player, this._swingSide, this.rng);
    }

    /* ---- single-shot auto-cycle ---------------------------------------- */
    if (this._autoCycleAt > 0) {
      this._autoCycleAt -= dt;
      if (this._autoCycleAt <= 0) {
        this._autoCycleAt = 0;
        if (!this.reloading && s.reserve > 0 && s.mag < def.magSize) {
          this.rig.play(def.reloadTac === def.reloadEmpty ? 'reloadTac' : 'reloadEmpty');
        }
      }
    }

    /* ---- the save may have granted something since the last check -------
     * `game.economy.unlockWeapon` raises no event, so poll it slowly rather
     * than let a chapter reward stay unusable until the next brother switch.
     * `_resolveUnlocks` is an array filter over six ids; twice a second is
     * free and it is the only thing keeping the wheel honest.
     *
     * NOT WHILE A CAPTURE POSE IS FROZEN — and this one cost a whole class of
     * screenshots. `debugPose` force-equips the weapon it was asked to
     * photograph (`setWeaponImmediate`, which bypasses the unlock gate on
     * purpose, because a review frame is not gameplay). This poll is the
     * OWNERSHIP ENFORCEMENT: half a second later `_resolveUnlocks` ->
     * `setLoadout` sees a weapon the active brother does not carry and puts
     * `loadout[0]` — fists — back in his hands. The capture harness settles for
     * far longer than half a second before it presses the shutter, so:
     *
     *   MEASURED, default brother (carson, fresh save loadout [fists, pipe]):
     *     debugPose('ads')            staged nailgun -> 90 frames later: FISTS
     *     debugPose('smg',{...})      staged smg     -> 90 frames later: FISTS
     *
     * i.e. `--shot=ads` and `--shot=muzzle`, the two frames a weapon reviewer
     * actually looks at, were photographs of a pair of empty hands, and the
     * review notes that came back ("no weapon visible") were correct about the
     * picture and had nothing to do with the models.
     *
     * `debugMode !== null` is exactly "the rig is frozen for the shutter": the
     * wheel is unreachable there, `update` already refuses to read live input
     * under it, and gameplay clears it back to null. See `debugPosePoll` for
     * the negative control. */
    this._unlockPoll = (this._unlockPoll ?? 0) - dt;
    if (this._unlockPoll <= 0) {
      this._unlockPoll = 0.5;
      if (this.brotherId && (this.debugMode === null || this.debugPosePoll)) this._resolveUnlocks();
    }

    /* ---- spread recovery ------------------------------------------------ */
    const rest = this._restSpread(def, player, st);
    this._spread = Math.max(
      rest,
      this._spread - def.spreadDecay * this.hand.settle * dt * (1 + this.adsProgress)
    );
    if (this._sinceShot > 0.6) this._shotIndex = 0;

    /* ---- gather state --------------------------------------------------- */
    /**
     * A STOPPED WORLD TAKES NO ORDERS.
     *
     * `live` is the single predicate every input read in this file hangs off —
     * the held states just below and the whole EDGE block further down (R, E/Q,
     * B, I, the number row and the trigger). `input.frozen` / `input.enabled`
     * are the capture harness's switches and the cutscene's; `debugMode` is the
     * shutter's frozen pose; `_paused()` is the fourth and the one that was
     * missing. It is deliberately folded in HERE rather than sprinkled over the
     * six call sites, so the next input read added inside `if (live)` is covered
     * by construction instead of by whoever remembers.
     */
    const live = !input.frozen && input.enabled !== false && this.debugMode === null
      && !this._paused();
    st.ads = live ? (input.ads || player?.adsRequested === true) : this.debugMode === 'ads';
    st.sprint = live ? player?.sprinting === true && this._sinceShot > 0.3 : false;
    st.speed = player?.horizontalSpeed ?? 0;
    st.crouch = player?.stance === 'crouch';
    st.airborne = player?.airborne === true;
    st.empty = !def.melee && s.mag === 0 && !s.chambered;
    /**
     * DRIVE-BY. This used to holster EVERYTHING the moment you got in a car,
     * which removed a whole pillar of the genre. Any RANGED weapon fires from
     * any vehicle and only melee is blocked, because a chase in which you
     * cannot shoot back is a chase with one verb in it.
     *
     * Melee still goes away, for the obvious reason that a metre of dock pipe
     * cannot be swung inside a cab, and because the swing solver sweeps a fan
     * from the character's shoulder — through the car he is sitting in.
     *
     * `holsterOverride` still wins, so `game` can put the weapon away for a
     * cutscene, a shop or a mission beat.
     */
    const inCar = player?.inVehicle === true;
    st.holstered = this.holsterOverride
      ?? (player?.dead === true || (inCar && (def.melee || this.debugHolsterInCar)));
    this.driveBy = inCar && !def.melee && !st.holstered;

    if (live) {
      if (input.actionPressed('reload')) this.reload();
      /**
       * E / Q cycle the brother's loadout — the GTA layout bound in
       * `src/core/input.js`. These are EDGES, not held states: `actionPressed`
       * is only true on the frame the key went down, so holding E does not
       * riffle through the whole arsenal.
       *
       * Until this existed, `nextWeapon()` and `prevWeapon()` were called by
       * nothing in the codebase and the sixteen-weapon arsenal was unreachable
       * from the keyboard.
       */
      if (input.actionPressed('nextWeapon')) this.nextWeapon();
      else if (input.actionPressed('prevWeapon')) this.prevWeapon();
      if (input.pressed('KeyB')) this.cycleFireMode();
      if (input.pressed('KeyI')) this.inspect();
      /* 1..6 pick straight out of the brother's own loadout, in wheel order. */
      for (let i = 0; i < Math.min(6, this.loadout.length); i++) {
        if (input.pressed(`Digit${i + 1}`)) this.setWeapon(this.loadout[i]);
      }
      /* `melee` is deliberately unbound now: in this game melee IS a weapon
       * (fists, Dock Pipe, Body Wrench, Crowbar), so a swing is the fire button
       * with one of them equipped — see `_runTrigger`. The pistol-whip stays
       * reachable for anything that rebinds it. */
      if (input.actionPressed('melee') && !def.melee) this._pistolWhip();
      this._runTrigger(dt, input.fire, input.firePressed, def, s);
      st.trigger = input.fire && this.canFire();
      if (input.firePressed && st.empty) this.reload();
    } else if (this.debugMode) {
      this._runDebug(ctx);
      st.trigger = this._sinceShot < 0.09;
    }

    /**
     * Drive the animator's aim pose — AND THE REASON SHIFT DID NOT RUN.
     *
     * `player._buildPose` feeds `adsAmount` straight into the animator as
     * `aim`, and the animator's ONLY upper-body pose that puts a weapon in
     * front of the chest is that one. So a drawn firearm holds a floor under
     * the aim value even at the hip — otherwise the character walks around with
     * a harpoon gun swinging from a slack arm.
     *
     * THE BUG. `player.setAdsProgress(v)` does not just pose the arms: it
     * writes `player.adsAmount`, and `player/index.js` derives
     *
     *     m.aiming = this.adsAmount > 0.35
     *
     * from it, while `player/movement.js:_updateSprint` refuses to sprint while
     * `this.aiming`. The old floor was **0.46** for every weapon that is not
     * one-handed. So merely HOLDING a Shop SMG — or a Tack Cannon, Paint
     * Cannon, Spear Gun, Rivet Gun, Harpoon, Nitro Launcher, Depth Charge,
     * Scrap Rocket or EMP Coil — told `player` the character was aiming, which
     * locked him to `MOVE.aimSpeed` and made Shift do nothing at all.
     *
     * It was a LATCH, not a glitch, which is why it never cleared: the floor
     * was lifted whenever `st.sprint` was false, `st.sprint` reads
     * `player.sprinting`, and `player.sprinting` could not become true while
     * the floor was up. Once you picked up a two-handed weapon you walked for
     * the rest of the session.
     *
     * MEASURED before the fix, one 60-frame Shift+W hold per weapon, all 16:
     *   fists/pipe/wrench/crowbar   sprinting=true   6.40 m/s   (melee, floor 0)
     *   nailgun                     sprinting=true   6.40 m/s   (0.34, under the
     *                                                            threshold by 0.01)
     *   flare                       floor 0.34, aiming=false
     *   the other ten              sprinting=FALSE  1.90 m/s   ads 0.46, aiming=true
     * i.e. 10 of 16 weapons — every heavy thing in the game — could not run.
     * The player's guess ("is this limited to which gun is being held?") was
     * exactly right, and the gate for it is `arsenalprobe.mjs --sprint`.
     *
     * THE FIX, and the invariant to keep. The ready pose and the aim STATE are
     * two different things sharing one channel, and `player` owns the channel's
     * meaning. Until `player` offers a separate "carry pose" input, everything
     * this system pushes while NOT aiming has to stay strictly below the aim
     * threshold. `READY_CAP` is that ceiling with margin; `READY_FLOOR` are the
     * carry weights, all under it by construction, and the pose is additionally
     * bled off with speed so the weapon comes down into a jog the way it should
     * anyway. When the player really is aiming, `rig.adsT` runs to 1 through
     * the `Math.max` below and `m.aiming` becomes true — which is correct.
     */
    let ready;
    if (this.debugReadyFloor !== null) {
      /* NEGATIVE CONTROL: the pre-fix expression, verbatim — a static floor,
       * no speed bleed and no cap. It has to be the WHOLE original, because
       * the bleed below is independently sufficient to unlatch the sprint once
       * the character is moving, and a control that reverts only the cap comes
       * back green and tells you nothing. */
      ready = def.melee || st.holstered ? 0
        : (st.sprint ? 0 : (def.hold === 'oneHand' ? 0.34 : this.debugReadyFloor));
      player?.setAdsProgress?.(Math.max(this.rig.adsT, ready * this.rig.drawT));
      /**
       * AND INTO THE AIM CHANNEL, because the pose channel is no longer wired
       * to `aiming` and a control that cannot fail is not a control.
       *
       * `player` has since SPLIT the field this bug rode on: `adsAmount` is the
       * pose the animator gets, `aimAmount` is the aim state gameplay reads,
       * and `_updateSprint` consults the second. So `setAdsProgress(0.46)` —
       * the exact pre-fix call — now reaches nothing that can stop a sprint,
       * and this arm ran GREEN on the pre-fix expression (measured: carry pose
       * max 0.46 on ten weapons, 6.40 m/s and 0 aim frames on all sixteen).
       * That is worth knowing in its own right: READY_CAP is belt and braces
       * now rather than the only thing holding Shift up.
       *
       * What the check is really for is "a drawn weapon must not park the
       * player in an aim state", and the channel that still MEANS that is
       * `player.aimAmount = max(own intent, weapons.adsProgress)` — i.e.
       * `rig.adsT`. So the arm puts the same carry pose there instead, which is
       * what this mistake looks like written today. Applied in `lateUpdate`,
       * after the rig has run its own ADS blend, or the blend erases it.
       */
      this._ncAim = ready;
    } else {
      const floor = READY_FLOOR[def.hold] ?? READY_FLOOR.twoHand;
      /* Carrying: the weapon comes down as the legs speed up (1.6 -> 4.8 m/s).
       * This is a second, independent guard on the same failure — even if the
       * floor were mis-set, a moving character sheds the pose. */
      const jog = clamp01((st.speed - 1.6) / 3.2);
      ready = def.melee || st.holstered || st.sprint ? 0 : floor * (1 - 0.55 * jog);
      player?.setAdsProgress?.(Math.max(this.rig.adsT, Math.min(READY_CAP, ready) * this.rig.drawT));
    }

    this.stats.live = this.sim.stats.live;
    this.stats.fired = this.sim.stats.fired;
  }

  /** A gun in the face. Uses the fists' timing with the weapon's own weight. */
  _pistolWhip() {
    if (this.rig.swinging || this._fireTimer > 0) return false;
    const fists = ALL_WEAPONS.fists;
    this._swingSide = 1;
    const dur = this.rig.startSwing(fists.swing, 1);
    this._swingContactAt = dur * fists.swing.contact;
    this._fireTimer = 0.55;
    return true;
  }

  _runTrigger(dt, held, pressed, def, s) {
    if (def.melee) {
      if (pressed) this.tryMelee();
      return;
    }
    if (s.mode === 'auto') { if (held) this.tryFire(); }
    else if (pressed) this.tryFire();
  }

  _restSpread(def, player, st) {
    /* `hand.spread` is the brother's `aim` stat: Aidan's cone is 0.85 of the
     * weapon's authored one, Dylan's is 1.20 of it. */
    let base = lerp(def.spreadHip, def.spreadAds, this.adsProgress) * this.hand.spread;
    if (st.crouch) base *= SPREAD_MODS.crouch;
    if (player?.stance === 'prone') base *= SPREAD_MODS.prone;
    if (st.speed < 0.4) base *= SPREAD_MODS.still;
    else if (st.speed > 3.2) base *= SPREAD_MODS.walking;
    if (st.sprint) base *= SPREAD_MODS.sprinting;
    if (st.airborne) base *= SPREAD_MODS.airborne;
    return base;
  }

  lateUpdate(dt, ctx) {
    const rig = this.rig;
    if (!rig) return;
    const player = this.player ?? (this.player = ctx.peek('player'));
    rig.update(dt, this._state, player);
    /* NEGATIVE CONTROL only — see the `debugReadyFloor` branch in `update`. */
    if (this.debugReadyFloor !== null) rig.adsT = Math.max(rig.adsT, this._ncAim ?? 0);
    this.sim.update();
    /* MUST be after `vehicles.update()`, which recomputes every lamp's emissive
     * from scratch each frame — see the note in emp.js. */
    this.empField.lateUpdate();
    /* A burning flare is a light source and a damage volume; the paint marks
     * ride pedestrians who are still running. Both every frame. */
    this.fireField.lateUpdate();
    this.paintField.update();
    this.tether.update();

    if (this._pendingSwings > 0) {
      for (let i = 0; i < this._pendingSwings; i++) this._emitSwing();
      this._pendingSwings = 0;
    }

    /* ---- muzzle flash / audio, now that the pose is final --------------- */
    if (this._pendingShots > 0) {
      const def = this.current;
      rig.muzzleWorld(this._firePayload.origin);
      rig.boreDir(this._firePayload.dir);
      const w = this._fireWeapon;
      w.id = def.id;
      w.name = def.label;
      w.class = def.fxClass;
      w.audio = def.audioProfile;
      w.suppressed = def.silent === true;
      this._firePayload.seed = this._fireSeed >>> 0;
      this._firePayload.recoil = def.recoil.punch;
      this._firePayload.flashScale = def.flashScale ?? 1;
      /* A speargun is rubber bands: no flash, no report, no crime. */
      this._firePayload.fx = def.silent !== true;
      this._firePayload.melee = false;
      for (let i = 0; i < this._pendingShots; i++) {
        ctx.events.emit('weapon:fire', this._firePayload);
      }
      this._pendingShots = 0;
      this._pendingFirst = false;
    }

    /* ---- deferred ejection --------------------------------------------- */
    for (const q of this._shellQueue) {
      if (q.t < 0) continue;
      q.t -= dt;
      if (q.t > 0) continue;
      q.t = -1;
      const def = this.current;
      rig.ejectWorld(this._shellPayload.position);
      rig.ejectVelocity(this._shellPayload.velocity, 2.3 + this.rng.float() * 1.2);
      const pv = this.player?.velocity;
      if (pv) this._shellPayload.velocity.add(pv);
      this._shellPayload.velocity.y += 1.1;
      this._shellPayload.weapon = def;
      this._shellPayload.caseLen = def?.shell?.caseLen ?? 0.0192;
      this._shellPayload.caseRadius = def?.shell?.rimR ?? 0.00478;
      this._shellPayload.spin = 28 + this.rng.float() * 34;
      ctx.events.emit('weapon:shell', this._shellPayload);
    }

    if (this._poseCamera) this._applyPoseCamera(ctx);
  }

  /* ====================================================================== */
  /*  capture harness                                                       */
  /* ====================================================================== */

  /**
   * Freeze the rig in a photogenic state.
   *
   * `'idle'` is the RESET: `src/dev/shots.js` calls it before every single shot
   * in the set to clear the previous shot's looping debug state, so it must not
   * touch the camera. Everything else is a weapon review and DOES frame itself,
   * because the harness poses the camera at the player's eye — which in a
   * third-person game is inside the character's head, looking away from the
   * weapon it was asked to photograph.
   */
  debugPose(kind = 'idle', opts = {}) {
    const rig = this.rig;
    if (!rig) return kind;

    /* A weapon id or a class name selects the subject. */
    let mode = kind;
    let want = null;
    if (this.states.has(kind)) { want = kind; mode = opts.mode ?? 'ads'; }
    else if (WEAPON_CLASSES.includes(kind)) { want = CLASS_EXEMPLAR[kind]; mode = opts.mode ?? 'ads'; }

    this.debugMode = mode;
    if (want) this.setWeaponImmediate(want);
    else if (this.current?.melee && (mode === 'ads' || mode === 'fire')) {
      this.setWeaponImmediate(CLASS_EXEMPLAR.light);
    }

    rig.stopClip();
    rig.recPos.reset();
    rig.recRot.reset();
    rig.settle.reset();
    rig.lag.reset();
    rig.boltHold = 0;
    rig.boltCycle = 0;
    rig.swingT = -1;
    rig.drawT = 1;
    rig.noiseT = 12.37;
    rig.debugFrozen = true;
    rig.setLoaded(true);
    this._spread = mode === 'ads' ? 0.24 : 2.05;
    this._sinceShot = 10;
    this._debugFrame = 0;
    this._swingContactAt = -1;
    this._autoCycleAt = 0;
    /* `holstered: true` photographs the sling pose (normally only seen from a
     * car), and it has to survive `update()` re-deriving the flag every frame,
     * so it goes through the same override `game` would use. */
    if (opts.holstered !== undefined) this.setHolstered(!!opts.holstered);
    this._state.holstered = this.holsterOverride === true;
    rig.drawT = this._state.holstered ? 0 : 1;

    const s = this.state;
    if (s) {
      s.mag = mode === 'fire' ? Math.max(1, Math.floor(s.def.magSize * 0.7)) : s.def.magSize;
      s.chambered = true;
      s.reserve = s.def.reserve;
    }

    rig.adsT = mode === 'ads' || mode === 'fire' ? 1 : 0;
    this._state.ads = rig.adsT > 0.5;
    this._state.sprint = false;
    this._state.speed = 0;
    this._state.trigger = false;
    this.player?.setAdsProgress?.(rig.adsT);

    /* `'idle'` is the between-shots reset. Anything else is a review. */
    this._poseCamera = mode === 'idle' ? null : (opts.camera ?? 'shoulder');
    if (mode === 'melee-swing' || (want && this.current?.melee)) {
      this._poseCamera = opts.camera ?? 'shoulder';
      /* Park the swing at the contact frame so a still photograph catches the
       * head at full extension rather than at rest. */
      const sw = this.current.swing;
      rig.startSwing(sw, 1);
      rig.swingT = (sw.wind + sw.strike + sw.recover) * sw.contact;
      rig.debugFrozen = true;
    }

    /* Frames on which to fire, so a flash is lit continuously across the
     * harness's shutter uncertainty window (see the long note this replaces:
     * a flash core lives ~52 ms, the grab frame is only known to a handful). */
    if (mode === 'fire') {
      const grab = Math.round(opts?.grabFrame ?? 90);
      const frames = [grab - 26, grab - 19, grab - 12];
      for (let f = grab - 6; f <= grab + 18; f += 2) frames.push(f);
      this._scriptFrames = frames.filter((f) => f >= 2);
    } else {
      this._scriptFrames = null;
    }
    return kind;
  }

  /**
   * Over-the-shoulder review framing. Re-applied every lateUpdate because the
   * character keeps breathing under it and the weapon has to stay in frame.
   */
  _applyPoseCamera(ctx) {
    const p = this.player;
    const cam = ctx.camera;
    if (!p?.headPosition) return;
    this.rig.muzzleWorld(this._tmp);
    const head = p.headPosition;
    /* Aim at the midpoint of head and muzzle so both the character and what he
     * is holding are in the frame — a weapon review with no character in it
     * cannot tell you whether the grip reads. */
    this._poseTarget.copy(head).add(this._tmp).multiplyScalar(0.5);

    const yaw = p.yaw ?? 0;
    const fx = -Math.sin(yaw), fz = -Math.cos(yaw);
    const rx = Math.cos(yaw), rz = -Math.sin(yaw);
    const mode = this._poseCamera;
    /**
     * Three-quarter SIDE, not three-quarter front. A firearm points down the
     * aim axis, so a camera in front of the character photographs the muzzle
     * crown and nothing else — the first pass at this framing produced a
     * perfect end-on view of a Shop SMG, which tells a critic nothing about
     * its silhouette. Standing off the character's right shoulder and slightly
     * ahead puts the whole length of the weapon across the frame.
     */
    const ahead = mode === 'wide' ? 1.5 : 0.62;
    const side = mode === 'wide' ? 2.9 : 1.5;
    this._poseEye.set(
      this._poseTarget.x + fx * ahead + rx * side,
      this._poseTarget.y + (mode === 'wide' ? 0.30 : 0.10),
      this._poseTarget.z + fz * ahead + rz * side
    );
    cam.position.copy(this._poseEye);
    cam.lookAt(this._poseTarget);
    cam.updateMatrixWorld();
  }

  /**
   * THE ARSENAL, AS EMITTED — the input to `arsenalprobe.mjs`.
   *
   * Two halves, deliberately from two different places:
   *
   *  - `def` is what the fire code actually reads this frame (`states`, i.e.
   *    post-`finalizeWeapon`), not the literal in `lib.js`. A typo that
   *    `finalizeWeapon` overwrites therefore cannot pass the gate by agreeing
   *    with the source table.
   *  - `vm` is measured off the INSTANTIATED THREE GEOMETRY hanging in the rig —
   *    real vertex and index counts, the real world-scale bounding box, the
   *    real material set, and the real muzzle/eject node positions. It is not
   *    the builder's declared `span` or anything else the model author typed,
   *    which is the whole point: ARCHITECTURE.md rule 12 forbids a gate that
   *    re-samples the function the thing was built from.
   */
  debugArsenal() {
    const out = {};
    const bb = new THREE.Box3();
    for (const [id, s] of this.states) {
      const d = s.def;
      const e = this.rig?.entries?.get(id);
      let vm = null;
      if (e) {
        let meshes = 0, verts = 0, idx = 0;
        const mats = new Set();
        bb.makeEmpty();
        e.group.traverse((o) => {
          const g = o.geometry;
          if (!g || !g.attributes?.position) return;
          meshes++;
          verts += g.attributes.position.count;
          idx += g.index ? g.index.count : 0;
          g.computeBoundingBox();
          if (g.boundingBox) bb.union(g.boundingBox);
          const m = o.material;
          for (const mm of Array.isArray(m) ? m : [m]) if (mm) mats.add(mm.name || mm.uuid);
        });
        const size = bb.isEmpty() ? { x: 0, y: 0, z: 0 } : bb.getSize(new THREE.Vector3());
        const mm = (v) => Math.round(v * 1000);
        vm = {
          meshes, verts, idx,
          box: [mm(size.x), mm(size.y), mm(size.z)],
          mats: [...mats].sort(),
          muzzle: [mm(e.muzzle.position.x), mm(e.muzzle.position.y), mm(e.muzzle.position.z)],
          eject: [mm(e.eject.position.x), mm(e.eject.position.y), mm(e.eject.position.z)],
          hold: e.hold === undefined ? null : d.hold,
          tris: e.tris,
        };
      }
      out[id] = {
        def: {
          id: d.id, label: d.label, cls: d.class, hold: d.hold, melee: !!d.melee,
          cycleTime: d.cycleTime, rpm: +d.rpm.toFixed(2), damage: d.damage,
          range: d.range, maxRange: d.maxRange, magSize: d.magSize, reserve: d.reserve,
          muzzleVelocity: d.muzzleVelocity ?? 0, pellets: d.pellets, splash: d.splash,
          dragK: d.dragK, dropoff: d.dropoff ?? 0, penetration: d.penetration,
          modes: d.modes.slice(), projectile: d.projectile ?? null, eject: d.eject ?? null,
          spreadHip: d.spreadHip, spreadAds: d.spreadAds, spreadPerShot: d.spreadPerShot,
          spreadMax: d.spreadMax, spreadDecay: d.spreadDecay,
          recoil: {
            pitch: d.recoil.pitch, yaw: d.recoil.yaw, roll: d.recoil.roll,
            punch: d.recoil.punch, body: d.recoil.body, trauma: d.recoil.trauma,
            climbShape: d.recoil.climbShape.slice(), drift: d.recoil.drift,
            patternLength: d.recoil.patternLength,
          },
          reloadTac: d.reloadTac, reloadEmpty: d.reloadEmpty,
          drawTime: d.drawTime, holsterTime: d.holsterTime, adsTime: d.adsTime,
          fxClass: d.fxClass, audioProfile: d.audioProfile, flashScale: d.flashScale,
          silent: !!d.silent, explodes: !!d.explodes, emp: !!d.emp, ignites: !!d.ignites,
          tethered: !!d.tethered, pins: !!d.pins, autoCycle: !!d.autoCycle,
          reach: d.reach ?? 0, arcDeg: d.arcDeg ?? 0,
          swing: d.swing ? { ...d.swing } : null,
        },
        vm,
        ammo: { mag: s.mag, reserve: s.reserve, chambered: s.chambered, mode: s.mode },
      };
    }
    return {
      weapons: out,
      order: [...this.states.keys()],
      brother: this.brotherId,
      loadout: this.loadout.slice(),
      active: this.activeId,
      hand: { ...this.hand },
      signature: BROTHER_SIGNATURE[this.brotherId] ?? null,
      start: (BROTHER_START[this.brotherId] ?? []).slice(),
      full: (BROTHER_LOADOUT[this.brotherId] ?? []).slice(),
      unlockAll: this.unlockAll,
      driveBy: this.driveBy,
      readyCap: READY_CAP,
      dryLockout: DRY_FIRE_LOCKOUT,
      carStats: { ...(this.sim?.cars?.stats ?? {}) },
    };
  }

  /**
   * Swap without the draw animation.
   *
   * `force` defaults TRUE because every caller is a harness, a capture pose or
   * this system's own brother switch — the player-facing path is `setWeapon`,
   * which is where the unlock gate belongs. `setWeaponImmediate(id, false)`
   * respects the gate for anything that wants both.
   */
  setWeaponImmediate(id, force = true) {
    if (!this.states.has(id)) return false;
    if (!force && !this.loadout.includes(id)) return false;
    this._switchTo = null;
    this._autoCycleAt = 0;
    this._swingContactAt = -1;
    this.activeId = id;
    this.rig.stopClip();
    this.rig.swingT = -1;
    this.rig.setActive(id, this.player ?? (this.player = this.ctx.peek('player')));
    this.rig.setLoaded(true);
    this.rig.drawT = 1;
    return true;
  }

  _runDebug() {
    this._debugFrame = (this._debugFrame ?? 0) + 1;
    const frames = this._scriptFrames;
    if (!frames) return;
    for (const f of frames) {
      if (f === this._debugFrame) { this._fireTimer = 0; this.tryFire(); }
    }
  }

  /* ====================================================================== */

  /**
   * Compile every material this subsystem can produce before the first frame.
   * All sixteen weapons are instantiated at init and the projectile pool shares
   * their materials, so making the whole rig visible for one compile pass warms
   * every program the system will ever need.
   */
  async prewarmMaterials(ctx = this.ctx) {
    const r = ctx.peek('render');
    const renderer = r?.renderer;
    if (!renderer || !this.rig) return;
    const shown = [];
    for (const e of this.rig.entries.values()) {
      if (!e.group.visible) { e.group.visible = true; shown.push(e.group); }
    }
    /* The paint splats carry CLONED library materials (they need their own
     * polygon offset), and a clone is a cache miss the first time it is drawn —
     * which would be the frame the Paint Cannon connects. Warm one of each
     * here instead. Same for the harpoon's line. */
    for (let i = 0; i < Math.min(2, this.paintField?.slots.length ?? 0); i++) {
      const m = this.paintField.slots[i].mesh;
      if (!m.visible) { m.visible = true; shown.push(m); }
    }
    if (this.tether && !this.tether.rope.visible) {
      this.tether.rope.visible = true;
      shown.push(this.tether.rope);
    }
    try {
      await renderer.compileAsync(ctx.scene, ctx.camera);
    } catch {
      /* Compilation is an optimisation; never let it break the boot. */
    }
    for (const g of shown) g.visible = false;
    if (this.rig.active) this.rig.active.group.visible = true;
  }

  resize() {}

  dispose() {
    for (const off of this._off ?? []) off();
    this.sim?.dispose();
    this.empField?.dispose();
    this.fireField?.dispose();
    this.paintField?.dispose();
    this.tether?.dispose();
    this.rig?.dispose();
    this.mats?.dispose();
  }
}

function hash(s) {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193); }
  return h >>> 0;
}
