import * as THREE from 'three';
import { installStyles, removeStyles } from './style.js';
import { el, clamp, clamp01, damp, lerp, setClass, setStyle } from './util.js';
import { Crosshair } from './crosshair.js';
import { Hitmarkers } from './hitmarkers.js';
import { DamageArcs } from './damage.js';
import { HealthFx } from './health.js';
import { WorldMarkers } from './markers.js';
import { Prompt, Banner } from './prompts.js';
import { PauseMenu } from './menu.js';
import { SlagRing } from './radar.js';
import { PauseMap } from './pausemap.js';
import {
  VitalArcs, WantedStars, MoneyCounter, RespectCounter, VehicleCluster, WeaponChip, CityClock,
} from './vitals.js';
import {
  ObjectivePanel, ZoneFlourish, TitleCard, Subtitles, BigCard, Feed, RadioStrip,
} from './mission.js';
import { StoryOverview, EndingSequencer } from './story.js';
import { WeaponWheel, CharacterWheel, SLOW } from './wheels.js';
import { Phone } from './phone.js';
import { TouchControls, isTouchDevice, verbFor } from './touch.js';
import { installBoot } from './boot.js';
import { CheatMenu, cheatsEnabled } from './cheats.js';
import {
  BOYZ, BOY_BY_ID, WEAPONS, STATIONS, PACKAGES, districtAt, SAMPLE_SCENE,
} from './data.js';

const MAX_BLIPS = 64;

/**
 * ===========================================================================
 * THE PAUSE ARBITER — the ONE owner of `ctx.time.scale`
 * ===========================================================================
 *
 * There used to be three, each with its own private save/restore and no
 * knowledge of the others: the pause menu banked `menu._prevScale`, the modal
 * pass banked `ui._modalPrevScale`, and the radial wheels banked
 * `ui._prevScale`. Only one of the three checked the other two, and both of the
 * others restored their banked value UNCONDITIONALLY. What that produced,
 * measured on the shipped build:
 *
 *   hold TAB (wheel, scale 0.22) -> press ESC
 *     one pass of `_input` opened the menu (scale 0), recomputed `noWheel`,
 *     hid the wheel, and restored the wheel's banked 1. The player was in the
 *     pause menu with controls disabled and the city running at FULL SPEED:
 *     traffic moving, the wanted timer ticking, cops shooting a man who could
 *     not move. Releasing TAB did not fix it, and resuming left the clock stuck
 *     in bullet time for the rest of the session.
 *
 *   ESC, then M, then ESC
 *     resumed the world with the full-screen map still over it.
 *
 * The fix is that **nobody banks a private previous value**: one predicate
 * answers "is any modal open" and the paused state is RE-DERIVED from it every
 * time. Here that is a
 * set of named claims whose resulting scale is a PURE FUNCTION of which claims
 * are live — the lowest wins, so a 0 can never be out-voted by a 0.22 or a 1,
 * whatever order the claims arrive or leave in.
 *
 * The UI's own claims are DERIVED: `sync()` is handed a freshly built wants
 * record every frame, so one of those cannot leak — there is no "release" call
 * to forget. Subsystems outside `ui` cannot be derived from here (this file may
 * not import them, hard rule 2), so they get the two-method interface below.
 *
 * The only banked number is `base`, the scale free play was running at, handed
 * back when the last claim drops — and never banked as zero, because restoring
 * a zero gives the player a live HUD over a dead world.
 *
 * While NOTHING is claiming, the arbiter does not touch `scale` at all. That is
 * deliberate: `tools/capture.mjs` and `tools/demo-driver.js` own the clock in
 * free play (a shot freezes at 0, the demo driver runs at 0.28) and a
 * re-deriving owner that wrote every frame would fight them.
 *
 * ---------------------------------------------------------------------------
 * CLAIMS FROM OUTSIDE `ui` — `claim(name, scale)` / `release(name)`
 * ---------------------------------------------------------------------------
 * Two features need the clock and live in other directories: `src/fx/hitstop.js`
 * (the 40-90 ms freeze that makes a punch land) and, historically, the cutscene
 * player. Both were writing `ctx.time.scale` directly with their own private
 * "previous" value — the exact multi-owner disease this class exists to cure —
 * because there was no way in. There is now:
 *
 *   pause.claim('hitstop', 0.12)   register or refresh a claim
 *   pause.release('hitstop')       drop it
 *   pause.release()                NO ARGUMENT — full teardown, for dispose()
 *
 * `scale` is an ABSOLUTE target in the same currency as the table above, not a
 * factor of `base`. That is what keeps the resolved scale a pure function of
 * WHICH claims are live: mixing absolutes and multipliers would make the answer
 * depend on the order they arrived in, which is the property being bought here.
 * (`hitstop` asks for 0.12 and gets 0.12 even if free play was running at 0.28
 * under the demo driver. Its own comment calls 0.12 "the factor"; the arbiter
 * owns the arithmetic, and this is the arithmetic.)
 *
 * External claims are merged into the SAME MINIMUM as the derived ones, so a 0
 * can never be out-voted by a 0.12 or a 0.22 whatever order they arrive or
 * leave in, and `claim()` / `release()` re-resolve immediately rather than
 * waiting for the next frame's `sync()`.
 *
 * ---------------------------------------------------------------------------
 * WHY `base` IS NOT SAMPLED WHEN A CLAIM LANDS
 * ---------------------------------------------------------------------------
 * It used to be: `if (this.held === null) this.base = t.scale`. That made the
 * banked value depend on WHAT THE CLOCK HAPPENED TO SAY on one frame, and a
 * frame chosen by the player pressing a key. MEASURED on the shipped build,
 * with a 0.12 stall live and a modal opened one frame into it:
 *
 *     base banked 0.12 -> modal closes -> world runs at 0.12 FOR EVER
 *     (30 frames after the modal came down: 0.12 simulated seconds per real
 *      second, and `time.scale` still reading 0.12)
 *
 * `src/fx/hitstop.js:50-58` recognises and heals exactly that case from the
 * other side of the boundary, which is why the shipped build survives it — but
 * only for the one writer that knows the trick, and it is a live coupling
 * between two files that nobody would guess at.
 *
 * So the arbiter no longer samples the clock at claim time. It WATCHES it while
 * it holds nothing and adopts a value as `base` only once that value has stood
 * for longer than any transient stall is allowed to last. A hitstop is capped
 * at `HITSTOP_MAX` = 0.15 s, so a quarter second of the same number is free
 * play by definition and 0.12 for three frames is not — no cooperation from the
 * other file required, and no knowledge of what its number means.
 */
const PAUSE_CLAIMS = Object.freeze({
  /** A modal owns the screen: the world stops dead. */
  menu: 0,
  ending: 0,
  cheats: 0,
  story: 0,
  map: 0,
  phone: 0,
  card: 0,
  /** A cutscene owns the screen, the camera and the keyboard. */
  cut: 0,
  /** The radial selectors want bullet time, not a freeze. */
  wheel: SLOW,
});
const CLAIM_NAMES = Object.freeze(Object.keys(PAUSE_CLAIMS));

/**
 * How long one scale has to stand, in UNSCALED seconds, before the arbiter will
 * believe it is free play rather than somebody's transient stall.
 *
 * The bound that matters is `HITSTOP_MAX` in `src/fx/hitstop.js` — 0.15 s, and
 * its own comment says past ~0.15 s a stall stops reading as impact and starts
 * reading as a dropped frame. A quarter second clears it with room and is still
 * far below anything a player could perceive as the world being handed back at
 * the wrong speed.
 *
 * Deliberately measured on `time.raw`: every claim in the table can stop
 * `elapsed` dead, so a settling window denominated in scaled time would never
 * elapse at all.
 */
const FREE_PLAY_SETTLE = 0.25;

class PauseArbiter {
  constructor(ctx) {
    this.ctx = ctx;
    /**
     * The scale free play runs at. NOT sampled when a claim lands — see the
     * header. Adopted by `_observeFreePlay` from a value that has stood still
     * for `FREE_PLAY_SETTLE` while nothing was claiming.
     */
    this.base = 1;
    /** What we last wrote, or null while we own nothing. */
    this.held = null;
    /** Diagnostics only — never branch on these from outside. */
    this.top = null;
    this.count = 0;
    /** True while a claim has stopped the world outright. */
    this.frozen = false;
    /**
     * Claims from outside `ui`: two PARALLEL ARRAYS, name and absolute scale.
     *
     * A `Map` is the obvious shape and it is the wrong one here. `_resolve()`
     * runs every frame from `sync()`, and `for (const [k, v] of map)` allocates
     * an iterator plus a two-element array per entry every time it is reached —
     * hard rule 5, on a path the frame loop always takes. An indexed scan over
     * two arrays allocates nothing, and the list is a handful of subsystems
     * long, so the linear lookup in `claim` / `release` costs less than the
     * hashing would. Growth is the only allocation and it happens once per
     * claimant name that has ever existed.
     */
    this._extNames = [];
    this._extScales = [];
    /**
     * The last record `sync()` was handed. `ui._wants` is preallocated and
     * refilled IN PLACE every derivation, so holding the reference is holding
     * the live answer, never a stale copy — which is what lets `claim()` from
     * another subsystem re-resolve against the current overlays mid-frame.
     */
    this._wants = null;
    /** Free-play settling: the scale under observation, and since when. */
    this._seen = 1;
    this._seenAt = -FREE_PLAY_SETTLE;
  }

  /**
   * @param {object} wants  a live-derived record, one boolean per claim name.
   * @returns {boolean} frozen
   */
  sync(wants) {
    this._wants = wants;
    return this._resolve();
  }

  /**
   * Register or refresh a claim from a subsystem outside `ui`.
   * @param {string} name  stable per claimant — 'hitstop', not 'hitstop:7'
   * @param {number} scale absolute target scale, 0 for a dead stop
   * @returns {boolean} frozen
   */
  claim(name, scale) {
    if (typeof name !== 'string' || !name) return this.frozen;
    // Clamped, not trusted. A NaN through here would be written straight into
    // `time.scale` and every dt in the build becomes NaN on the next frame.
    const s = Number.isFinite(scale) ? Math.max(0, scale) : 0;
    const i = this._extNames.indexOf(name);
    if (i < 0) {
      this._extNames.push(name);
      this._extScales.push(s);
    } else {
      this._extScales[i] = s;
    }
    return this._resolve();
  }

  /**
   * Drop one external claim, or — WITH NO ARGUMENT — tear the whole thing down
   * and hand the clock back to whatever free play was running at. `ui.dispose()`
   * takes the second form; `src/fx/hitstop.js` takes the first.
   * @param {string} [name]
   * @returns {boolean} frozen
   */
  release(name) {
    if (name === undefined || name === null) {
      this._extNames.length = 0;
      this._extScales.length = 0;
      if (this.held === null) return false;
      const t = this.ctx.time;
      if (t) t.scale = this.base > 0 ? this.base : 1;
      this.held = null;
      this.top = null;
      this.count = 0;
      this.frozen = false;
      return false;
    }
    const i = this._extNames.indexOf(name);
    if (i < 0) return this.frozen;
    // Swap with the last and pop: `splice` would return a fresh array, and this
    // is reachable from `fx.update` every time a stall expires.
    const last = this._extNames.length - 1;
    this._extNames[i] = this._extNames[last];
    this._extScales[i] = this._extScales[last];
    this._extNames.pop();
    this._extScales.pop();
    return this._resolve();
  }

  /** The lowest live claim wins. Idempotent; call it as often as you like. */
  _resolve() {
    const t = this.ctx.time;
    if (!t) return this.frozen;

    let want = 1;
    let top = null;
    let n = 0;
    const wants = this._wants;
    if (wants) {
      for (let i = 0; i < CLAIM_NAMES.length; i++) {
        const k = CLAIM_NAMES[i];
        if (!wants[k]) continue;
        const s = PAUSE_CLAIMS[k];
        if (n === 0 || s < want) {
          want = s;
          top = k;
        }
        n++;
      }
    }
    // The same minimum, one table after the other. Nothing distinguishes an
    // external claim once it is in here, which is the point: a `menu` 0 and a
    // `hitstop` 0.12 resolve to 0 whichever of them landed first.
    for (let i = 0; i < this._extScales.length; i++) {
      const s = this._extScales[i];
      if (n === 0 || s < want) {
        want = s;
        top = this._extNames[i];
      }
      n++;
    }

    if (n === 0) {
      if (this.held !== null) {
        t.scale = this.base > 0 ? this.base : 1;
        this.held = null;
        // What we just wrote IS free play — we banked it as such — so start the
        // window already elapsed rather than making the next claim wait a
        // quarter second for a number we chose ourselves.
        this._seen = t.scale;
        this._seenAt = t.raw - FREE_PLAY_SETTLE;
      }
      this._observeFreePlay(t);
      this.top = null;
      this.count = 0;
      this.frozen = false;
      return false;
    }

    if (t.scale !== want) t.scale = want;
    this.held = want;
    this.top = top;
    this.count = n;
    this.frozen = want === 0;
    return this.frozen;
  }

  /**
   * Called only while nothing is claiming. Adopts the clock as the free-play
   * `base` once it has read the same value for `FREE_PLAY_SETTLE` of unscaled
   * time — long enough that no legal transient stall can be mistaken for it.
   */
  _observeFreePlay(t) {
    const s = t.scale;
    // A zero is never free play. `tools/capture.mjs` parks the clock at 0 for
    // the length of a shot, and handing a zero back later gives the player a
    // live HUD over a dead world.
    if (!(s > 0)) {
      this._seen = 0;
      this._seenAt = t.raw;
      return;
    }
    if (s !== this._seen) {
      this._seen = s;
      this._seenAt = t.raw;
      return;
    }
    if (t.raw - this._seenAt >= FREE_PLAY_SETTLE) this.base = s;
  }
}

/** The dial position past the last station — RADIO OFF. */
const OFF_STATION = Object.freeze({
  id: 'off', name: 'RADIO OFF', genre: '', freq: '', colour: '#8893ad',
});

/**
 * The loading screen goes up NOW, at module evaluation — before `engine.init()`
 * has run a single system, which is the only moment early enough to cover the
 * whole boot. `installBoot()` is a no-op under capture and automation; see the
 * header of `src/ui/boot.js`.
 */
const bootFlow = installBoot();

/**
 * ===========================================================================
 * HUD / UI subsystem — DECARLO BOYZ
 * ===========================================================================
 *
 * An open-world crime HUD, not a shooter HUD. The design brief in one line:
 * **the centre of the screen is empty and most of the HUD is invisible most of
 * the time.** Four corners, each with one job —
 *
 *   bottom left   the Slag Ring: street map, health and armour arcs, the zone
 *                 name when you cross a district line
 *   top right     money, wanted stars, clock, the mission objective and timer
 *   bottom right  the weapon
 *   top left      transient notifications
 *
 * — plus full-screen states (weapon wheel, character switch, pause map, title
 * cards, WASTED) that take over deliberately.
 *
 * Everything is DOM + canvas, driven entirely from `lateUpdate` after the
 * camera has reached its final transform. Nothing animates on a CSS keyframe
 * or transition: every value is integrated from `dt` here, which is what makes
 * the capture harness deterministic and lets the whole HUD freeze on pause.
 *
 * ---------------------------------------------------------------------------
 * PUBLIC API — `const ui = ctx.get('ui')`
 * ---------------------------------------------------------------------------
 *   ui.setObjective({eyebrow,text,timer,count,progress}) / ui.clearObjective()
 *   ui.titleCard(chapter, name, zone)      "CH 3" / "AGAINST THE CURRENT"
 *   ui.say(who, text) | ui.playScene([{who,text}])   brother dialogue
 *   ui.card('passed'|'failed'|'wasted'|'busted', sub, rewards[])
 *   ui.notify(text, value, 'slag'|'good'|'bad'|'gold')
 *   ui.setWanted(level, cooldown) | ui.setMoney(total, delta)
 *   ui.setRespect(total, delta)
 *   ui.setWaypoint({x,z}) | ui.setRoute(Float32Array|number[]  flat x,z pairs)
 *   ui.setBlips([{x,z,kind:'cop'|'enemy'|'friend'|'mission',heading}])
 *   ui.setCharacter('carson'|'aidan'|'dylan') | ui.setStation(id|'off')
 *   ui.openStory() / ui.closeStory() / ui.toggleStory()   chapter overview
 *   ui.missionAction(source)   the JOB button: overview when idle, KeyJ else
 *   ui.packageFound(id)
 *   ui.zone(name) | ui.openMap() / ui.closeMap()
 *   ui.hitmarker(kind) | ui.damageNumber(worldPos,n,kind) | ui.hurt(a,dx,dz)
 *   ui.setPrompt({key,text,sub,progress}) / ui.clearPrompt()
 *   ui.setHudVisible(bool) | ui.menu.show() / ui.resume()
 *   ui.pause.claim(name, scale) / ui.pause.release(name)   the clock, from
 *                              another subsystem. `ui.pause` is the ARBITER
 *                              OBJECT and never was a method — see `init()`.
 *   ui.debugState(name)   see DEBUG_STATES below
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS SUBSYSTEM READS FROM OTHERS (all optional, all duck-typed)
 * ---------------------------------------------------------------------------
 *   world.roads / world.districtAt(x,z)      the street map and the zone name
 *   player.getHudState() -> { health, maxHealth, armour, maxArmour, position,
 *                             heading, speed, inVehicle, character,
 *                             nitro, nitroFraction, nitroOn }
 *   weapons.getHudState()-> { id, name, ammo, reserve, magSize, reloading,
 *                             reloadProgress, loadout[], ammoByWeapon{} }
 *   police.getHudState() -> { wanted, cooldown, hunting, cops:[{x,z,heading}] }
 *   game.getHudState()   -> { money, respect, objective, chapter }
 *   game.getStoryOverview() -> the chapter list (optional; a fallback is
 *                             assembled from duck-typed game internals)
 *   vehicles.getHudState()-> { health, fuel, fuelDry, speedKmh, ... } | null
 *   peds.getHudActors()  -> [{ position|pos|x/z, kind|friendly, heading }]
 *   audio.station        -> current radio station id
 *
 * Events consumed: wanted:change, wanted:heat, damage:taken, damage:dealt,
 * player:state, vehicle:enter, vehicle:exit, vehicle:fuel, money:change,
 * mission:start, mission:complete, mission:fail, ending:play, weather:change,
 * time:hour, weapon:fire, weapon:reload, actor:death, explosion, resize.
 * Events emitted: ui:pause, ui:map, ui:waypoint, ui:weapon, ui:character,
 * ui:station, ui:quality, ui:sensitivity, ui:fov, ui:setting.
 */
export class UiSystem {
  static id = 'ui';
  static deps = ['render'];

  async init(ctx) {
    this.ctx = ctx;
    this.rng = ctx.rng.fork();
    installStyles();

    const host = document.getElementById('ui') ?? document.body;
    this.root = el('div', 'ow-hud', host);

    /**
     * A CLICK ON THE HUD IS NOT A CLICK ON THE WORLD.
     *
     * `Input._onMouseDown` (src/core/input.js) is bound to `window` and
     * re-requests pointer lock on any left click. `.ow-hud` is
     * `pointer-events: none`, so this listener only ever fires when the player
     * hit a real control — a menu button, a map pin, a phone row — and in that
     * case the lock grab is pure harm: it hides the cursor, it retargets the
     * mouseup at the canvas so the button never receives a `click` at all, and
     * once locked the browser starts eating Escape. That is the
     * "cannot click Resume, cannot press ESC, had to refresh" trap.
     *
     * Stopping propagation here is enough: the control's own handlers sit
     * deeper in the tree and have already run by the time this fires.
     */
    for (const t of ['mousedown', 'mouseup', 'pointerdown', 'pointerup']) {
      this.root.addEventListener(t, (e) => e.stopPropagation());
    }

    // Stacking order: hurt overlays under the HUD, wheels and map over it.
    // The touch camera-drag surface is created FIRST so it lands beneath every
    // readout — that is what lets the radar, the weapon chip and the nav
    // buttons stay tappable while the rest of the frame orbits the camera.
    this.touchZoneLayer = el('div', 'ow-layer ow-tzone-layer', this.root);
    this.hurtLayer = el('div', 'ow-layer', this.root);
    this.worldLayer = el('div', 'ow-layer', this.root);
    this.centreLayer = el('div', 'ow-layer', this.root);
    this.chromeLayer = el('div', 'ow-layer', this.root);
    this.overLayer = el('div', 'ow-layer', this.root);

    this.health = new HealthFx(this.hurtLayer);
    // Four and five stars wash the frame edges with slag. It sits UNDER the
    // HUD layer so the readouts stay clean, and it is the only thing on screen
    // besides the ring that reacts to the wanted level.
    this.heatWash = el('div', 'ow-heat-wash', this.hurtLayer);
    setStyle(this.heatWash, 'display', 'none');
    this.markers = new WorldMarkers(this.worldLayer, this.rng.fork());
    this.arcs = new DamageArcs(this.centreLayer);
    this.crosshair = new Crosshair(this.centreLayer);
    this.hit = new Hitmarkers(this.centreLayer);

    // ---- the bottom-left dock: ring + vitals arcs + zone flourish ---------
    this.dock = el('div', 'ow-dock', this.chromeLayer);
    this.radar = new SlagRing(this.dock, this.rng.fork(), ctx);
    this.vitalArcs = new VitalArcs(this.dock);
    this.zoneFlourish = new ZoneFlourish(this.chromeLayer);

    // ---- the top-right column: money, respect, stars, clock, objective ---
    this.topRight = el('div', 'ow-topright', this.chromeLayer);
    this.money = new MoneyCounter(this.topRight);
    this.respect = new RespectCounter(this.topRight);
    this.stars = new WantedStars(this.topRight);
    this.clock = new CityClock(this.topRight);
    this.objective = new ObjectivePanel(this.topRight);

    this.weapon = new WeaponChip(this.chromeLayer);
    // Vehicle health / fuel / nitro, above the weapon chip while driving.
    this.vehm = new VehicleCluster(this.chromeLayer);
    this.feed = new Feed(this.chromeLayer);
    this.radio = new RadioStrip(this.chromeLayer);
    this.subs = new Subtitles(this.chromeLayer);
    this.title = new TitleCard(this.chromeLayer);
    this.prompt = new Prompt(this.chromeLayer);
    this.banner = new Banner(this.chromeLayer);

    this.phone = new Phone(this.chromeLayer);

    this.bigCard = new BigCard(this.overLayer);
    this.weaponWheel = new WeaponWheel(this.overLayer);
    this.charWheel = new CharacterWheel(this.overLayer);
    this.map = new PauseMap(this.overLayer, this.radar.map, ctx);
    this.map.onWaypoint = (w) => {
      this.state.waypoint = w;
      ctx.events.emit('ui:waypoint', w);
    };
    this.map.onClose = () => this.toggleMap();

    // The chapter overview and the ending sequence. Both are dumb readers —
    // `_storyData()` normalises whatever `game` offers before show().
    this.story = new StoryOverview(this.overLayer);
    this.story.onPick = (i) => this._startChapter(i);
    this.ending = new EndingSequencer(this.overLayer);
    this.ending.onDone = () => {
      this.setHudVisible(true);
      this.sfx('ui_confirm', 0.6);
    };
    // Above the HUD, below the pause menu.
    this.touchLayer = el('div', 'ow-touch-layer', this.root);

    /**
     * THE CHEAT / TEST MENU. Its layer goes in HERE — above the touch controls
     * (so the panel is not competing with a joystick) and below the pause menu
     * (so ESC always lands on exactly one thing). It is `null` whenever
     * `cheatsEnabled()` is false, which is the default under `?capture=1` and
     * under `navigator.webdriver` — so no review frame and no existing probe
     * ever contains it, and every call site below is `?.`-guarded rather than
     * conditional. `?cheats=1` is the seam probes use, the same shape as
     * `?boot=1`. See the header of `src/ui/cheats.js`.
     */
    this.cheatLayer = cheatsEnabled() ? el('div', 'ow-layer ow-cheat-layer', this.root) : null;
    this.cheats = this.cheatLayer ? new CheatMenu(this.cheatLayer, ctx, this) : null;

    this.menu = new PauseMenu(this.root, ctx);
    // A tester who cannot find the key does not have the tool. The pause menu
    // is where a player looks for the control list, so the key is named there —
    // but only on a build that actually has it.
    if (this.cheats && this.menu.hintRow) {
      this.menu.hintRow.textContent += ' · ` OR F8 CHEAT MENU';
    }
    // Everything the player saved last session — quality, sensitivity, FOV,
    // invert, volumes, difficulty — goes back into the live engine now.
    this.menu.restoreSettings();
    this.touch = new TouchControls(this.touchZoneLayer, this.touchLayer, ctx, this);
    // Phone rows are tap-activated on touch; route them exactly like Enter.
    this.phone.onActivate = (a) => {
      if (a?.kind === 'station') this.setStation(a.id);
      else if (a?.kind === 'character') this.setCharacter(a.id);
    };
    // HUD taps. The readouts a player reaches for are the map and the weapon,
    // and on a phone the natural thing to do is touch the thing itself rather
    // than hunt for a button that opens it.
    this.touch.tapTarget(this.radar.root, () => this.toggleMap());
    this.touch.tapTarget(this.weapon.root, () => this.touch.bridge.tap('KeyE'));
    this.touch.tapTarget(this.stars.root, () => this.radar.setMode(!this.radar.headingUp));

    this.health.onBeat = (i) => this.sfx('heartbeat', 0.35 + i * 0.5);

    /** Single source of truth for everything the HUD draws. */
    this.state = {
      // vitals
      health: 130, maxHealth: 130, armour: 45, maxArmour: 60, regen: false,
      // weapon
      weaponId: 'pipe', weaponName: 'DOCK PIPE', weaponGlyph: 'bar',
      weaponMelee: true, ammo: 0, reserve: 0, magSize: 0,
      reloading: false, reloadProgress: 0,
      // world
      x: 0, z: 0, heading: 0, speed: 0, inVehicle: false, street: '',
      // the vehicle meter cluster — a field of -1 means "no producer, hide it"
      veh: { on: false, health: -1, fuel: -1, nitro: -1, nitroOn: false, dry: false },
      // economy / heat
      money: 0, respect: 0, wanted: 0, wantedCooldown: 1, hunting: true,
      // character / radio
      character: 'aidan', station: 'grease',
      // navigation
      waypoint: null, route: null,
      // misc
      hour: 17.4, weather: 'OVERCAST',
      ads: false, move: 0, sprint: false, crouch: false, airborne: false,
      baseSpread: 5.5, simulate: false, time: 0,
      colour: '#ff6a12',
    };

    this.k = 1;
    this.vw = 1920;
    this.vh = 1080;
    this.hudVisible = 1;
    this.hudTarget = 1;
    this._lastRaw = ctx.time.raw;
    this._lastKillAt = -10;
    this._regenTimer = 0;
    this._hadPointerLock = false;
    this._zone = '';
    this._debug = null;
    this._foundPackages = this.map.found;
    this._respectSeen = false;

    /**
     * THE ONE OWNER OF `ctx.time.scale`. See `PauseArbiter` above. `_wants` is
     * preallocated and refilled in place every sync — the record is derived
     * fresh from the live overlays, never accumulated, so a stale claim is not
     * a state a bug can reach.
     *
     * `ui.pause` IS THE ARBITER OBJECT, not a method, and that is deliberate:
     * `src/fx/hitstop.js:118-121` reaches it here by name (`ui?.pause`) and is
     * the reason the field wins. There used to be a `pause()` method on the
     * prototype as well and this assignment SHADOWED it, so `ui.pause()` threw
     * `ui.pause is not a function` for every caller outside the class while
     * `ui.resume()` went on working — an asymmetry nobody spots by reading. The
     * method is gone rather than renamed; `menu.show()` is what it did, it
     * announces itself through `onToggle` below, and `src/main.js:218` already
     * falls through to exactly that.
     */
    this.pause = new PauseArbiter(ctx);
    /**
     * Alias. `ui.pause` is the arbiter and always will be — this exists so that
     * a reader who goes looking for "the pause arbiter" by that name finds the
     * same object rather than concluding there isn't one.
     */
    this.pauseArbiter = this.pause;
    this._wants = {
      menu: false, ending: false, cheats: false, story: false,
      map: false, phone: false, card: false, cut: false, wheel: false,
    };
    // The menu's ESC arrives on a DOM listener, BETWEEN frames — see the
    // capture-phase handler in `menu.js`. Without this hook the clock would not
    // catch up until the next `lateUpdate`, and a button click that closes the
    // menu would not catch up at all until then either.
    this.menu.onToggle = () => this._syncPause();

    /**
     * Hand the input layer a way to refuse a pointer-lock grab while a modal
     * owns the mouse. Two callers need this: the window-level mousedown grab in
     * `src/core/input.js` fires on any click, and `menu.close()` re-requests the
     * lock on its way back to the game. Neither should lock while `isPaused()` —
     * the Story button closes the menu straight into the story overview, and a
     * lock taken in that gap leaves the overview with a captured, invisible
     * cursor and its buttons dead. `input` treats this as OPTIONAL: headless
     * benches and the model-preview page boot without `ui` and never set it.
     */
    if (ctx.input) ctx.input.pointerLockGuard = () => this.isPaused();

    /**
     * ---------------------------------------------------------------------
     * THE CONTEXTUAL ACTION — one control, whatever the world is offering
     * ---------------------------------------------------------------------
     * `CONTROLS.md` gives the contextual action a single key, and the HUD says
     * what it will do right now. The interactions exist all over the tree, but
     * without one place that names the current one a player could stand next to
     * a respray and never learn it existed.
     *
     * This object is that single place. It is filled from the prompt that
     * `game.freeroam` and `player.vehicles` ALREADY publish through
     * `setPrompt()`, so no other subsystem had to change: the text becomes a
     * short verb for the touch button and stays long for the desktop prompt.
     * `game` can also drive it explicitly with `ui.setAction({...})`.
     *
     *   available  is anything on offer at all
     *   verb       'TAKE' | 'EXIT' | 'SPRAY' | 'FUEL' | 'SLEEP' ...
     *   label      'TAKE THE ALLEGHENY 4DR' — the full line
     *   source     'prompt' | 'vehicle' | 'api'
     */
    this.action = {
      available: false, verb: 'USE', icon: 'hand', label: '', sub: '',
      key: 'F', source: 'prompt',
    };
    this._promptActive = false;
    this._missT = 0;
    this._apiAction = null;
    this._exitPromptT = 0;
    this._exitPromptShown = false;
    this._exitPrompt = { key: 'F', text: 'EXIT', sub: '' };
    this._lastPromptText = '';
    this._promptVerb = 'USE';
    this._promptIcon = 'hand';
    this._promptLabel = '';
    this._serviceToastT = 0;
    this._exitBlocked = 0;

    this._pos = new THREE.Vector3();
    this._prevPos = new THREE.Vector3();
    this._dir = new THREE.Vector3();
    this._tmp = new THREE.Vector3();
    this._objectives = [];
    this._blips = new Array(MAX_BLIPS);
    for (let i = 0; i < MAX_BLIPS; i++) {
      // `colour` is a PER-CONTACT override of POI_STYLE[kind].c. It exists
      // because `peds.getHudActors()` publishes each brother's own DESIGN.md
      // colour (carson #2ea6a0, aidan #ff6a12, dylan #c07cff) and this record
      // used to have nowhere to put it — so all three crew blips drew in the
      // generic ALLY green and the player could not tell which brother was
      // which at fifty metres. `src/peds/blipprobe.mjs` reported that as a
      // live cross-boundary GAP. null means "use the kind's own colour".
      this._blips[i] = { x: 0, z: 0, kind: 'enemy', heading: 0, colour: null };
    }
    this._blipCount = 0;
    this._blipView = [];
    this._radarState = {
      x: 0, z: 0, heading: 0, speed: 0, inVehicle: false, wanted: 0,
      hunting: true, blips: null, route: null, waypoint: null,
      colour: '#ff6a12', street: '',
    };

    this._unsubs = [];
    const on = (type, fn) => this._unsubs.push(ctx.events.on(type, fn));
    this._wireEvents(on, ctx);

    this.setCharacter(this.state.character);
    this.resize(ctx.canvas.clientWidth || innerWidth, ctx.canvas.clientHeight || innerHeight, ctx);
    this._prevPos.copy(this._playerPos());

    // The loader has been on screen since module evaluation; give it an engine
    // to read so the bar can finish on real milestones and the select screen
    // can show each brother's saved chapter. Null whenever the flow is off.
    this.boot = bootFlow?.attach(ctx, this) ?? null;
  }

  /* ------------------------------------------------------------- events -- */

  _wireEvents(on, ctx) {
    on('weapon:fire', (e) => {
      this.crosshair.onFire(e?.recoil ?? 1);
      this._fireT = 0.9;
      if (this.state.simulate) return;
      if (!this._weaponState()) this.state.ammo = Math.max(0, this.state.ammo - 1);
    });

    on('weapon:reload', (e) => {
      const s = this.state;
      if (e?.phase === 'start') {
        s.reloading = true;
        s.reloadProgress = 0;
      } else if (e?.phase === 'end') {
        s.reloading = false;
        if (!this._weaponState()) {
          const take = Math.min(s.magSize - s.ammo, s.reserve);
          s.ammo += take;
          s.reserve -= take;
        }
      }
    });

    on('damage:dealt', (e) => {
      if (!e || this._isPlayerTarget(e.target)) return;
      const kind = e.killed ? 'kill' : e.headshot ? 'head' : e.armour ? 'armour' : 'hit';
      this.hitmarker(kind);
      if (e.point) {
        this.damageNumber(e.point, e.amount ?? 0,
          e.killed ? 'kill' : e.headshot ? 'hs' : e.armour ? 'armour' : 'hit');
      }
      if (e.killed) this._lastKillAt = ctx.time.elapsed;
    });

    on('damage:taken', (e) => {
      const amount = e?.amount ?? 10;
      if (e?.health !== undefined) this.state.health = e.health;
      else this.state.health = Math.max(0, this.state.health - amount);
      let dx = 0;
      let dz = 1;
      if (e?.from) {
        this._tmp.copy(e.from).sub(this._playerPos());
        dx = this._tmp.x;
        dz = this._tmp.z;
      }
      this.hurt(amount, dx, dz);
    });

    on('explosion', (e) => {
      if (!e?.position) return;
      this._tmp.copy(e.position).sub(this._playerPos());
      if (this._tmp.length() < (e.radius ?? 6) * 2.5) this.crosshair.onFlinch(0.6);
    });

    on('player:state', (e) => {
      if (!e) return;
      const s = this.state;
      if (e.ads !== undefined) s.ads = !!e.ads;
      if (e.sprinting !== undefined) s.sprint = !!e.sprinting;
      if (e.stance !== undefined) s.crouch = e.stance === 'crouch' || e.stance === 'prone';
      if (e.inVehicle !== undefined) s.inVehicle = !!e.inVehicle;
    });

    // ---- the open-world set ----------------------------------------------
    on('wanted:change', (e) => {
      const level = clamp(e?.level ?? 0, 0, 5);
      const prev = e?.prev ?? this.state.wanted;
      this.setWanted(level, 1);
      if (level > prev) {
        this.sfx('wanted_up', 0.8);
        if (level === 1) this.notify('Wanted', '★', 'bad');
      } else if (level === 0 && prev > 0) {
        this.notify('Lost the cops', '', 'good');
        this.sfx('wanted_clear', 0.7);
      }
    });

    on('wanted:heat', (e) => {
      this.state.hunting = true;
      if (e?.radius) this._heatRadius = e.radius;
    });

    on('money:change', (e) => {
      if (!e) return;
      this.setMoney(e.total ?? this.state.money + (e.amount ?? 0), e.amount ?? 0);
      if (e.reason) this.notify(e.reason, (e.amount >= 0 ? '+$' : '-$') +
        Math.abs(e.amount ?? 0).toLocaleString('en-US'), e.amount >= 0 ? 'gold' : 'bad');
    });

    /**
     * FEEDBACK ON EVERY ACTION — `CONTROLS.md`, the last line of the interaction
     * rules. There is a toast for getting in, for the cruiser being hot, and
     * for the crew climbing in with you, all in the brother's accent colour.
     * Without them the HUD says nothing at all beyond the vehicle's name.
     */
    on('vehicle:enter', (e) => {
      const v = e?.vehicle;
      if (e?.actor && !this._isPlayerActor(e.actor)) return;
      this.state.inVehicle = true;
      this._exitPromptT = 3.2;
      const name = v?.displayName ?? v?.name ?? v?.spec?.name ?? 'VEHICLE';
      if (this._isPoliceVehicle(v)) {
        this.notify(name, 'STOLEN CRUISER', 'bad');
        this.sfx('ui_alert', 0.7);
      } else {
        this.notify(name, '', 'char');
      }
      // The crew hopping in is a signature of the DeCarlo-brothers premise, so
      // it gets its own line the moment any subsystem reports passengers.
      const crew = e?.crew ?? e?.boarded ??
        (Array.isArray(e?.passengers) ? e.passengers.length : 0);
      if (crew > 0) this.notify('The crew hopped in', crew > 1 ? `x${crew}` : '', 'slag');
    });
    on('vehicle:exit', (e) => {
      if (e?.actor && !this._isPlayerActor(e.actor)) return;
      this.state.inVehicle = false;
      this._exitPromptT = 0;
      const name = e?.vehicle?.displayName ?? e?.vehicle?.name ?? e?.vehicle?.spec?.name;
      if (name) this.notify('Left the ' + name, '', 'slag');
    });

    on('mission:start', (e) => {
      const ch = e?.chapter ?? e?.no ?? '';
      const name = e?.name ?? e?.id ?? '';
      if (name) this.titleCard(ch, name, e?.zone ?? '');
      if (e?.lines) this.playScene(e.lines);
    });
    on('mission:complete', (e) => {
      this.card('passed', e?.name ?? '', [
        { value: '$' + (e?.cash ?? 0).toLocaleString('en-US'), label: 'CASH' },
        { value: '+' + (e?.respect ?? 0), label: 'RESPECT' },
      ]);
      this.clearObjective();
    });
    on('mission:fail', (e) => {
      this.card('failed', e?.reason ?? '', []);
      this.clearObjective();
    });

    /**
     * THE ENDING. `game` emits `ending:play { slides }` when the last chapter
     * lands: icon, title, giant neon year, epilogue message per slide, PLAY
     * FREE ROAM on the last. Every other overlay stands down — the ending is
     * the one moment that owns the whole screen — and a malformed or empty
     * payload is ignored rather than trusted.
     */
    on('ending:play', (e) => {
      const slides = Array.isArray(e?.slides) ? e.slides : Array.isArray(e) ? e : null;
      if (!slides?.length) return;
      this.map.hide();
      this.phone.hide();
      this.story.hide();
      this.weaponWheel.hide();
      this.charWheel.hide();
      this.menu.close();
      if (this.ending.play(slides)) this.sfx('mission_pass', 0.8);
    });

    /**
     * Fuel edges. The gauge covers the slow drain; the moment the tank
     * actually runs dry deserves a line of its own, because the car coasting
     * to a stop otherwise reads as a physics bug. Only the player's car — the
     * emitter flags it, and AI traffic stranding itself is not a mechanic.
     */
    on('vehicle:fuel', (e) => {
      if (!e || e.player === false) return;
      if (e.dry) {
        this.notify('Out of gas', 'FIND A PUMP', 'bad');
        this.sfx('ui_alert', 0.6);
      }
    });

    on('weather:change', (e) => {
      if (e?.state) this.state.weather = String(e.state);
    });
    on('time:hour', (e) => {
      if (e?.hour !== undefined) this.state.hour = e.hour;
    });
  }

  /* ------------------------------------------------------------- helpers -- */

  _sub(id) {
    const s = this.ctx.peek(id);
    if (!s) return null;
    // GAMEPLAY.md §6: a producer that throws must cost the HUD one readout,
    // never the frame.
    try {
      const st = typeof s.getHudState === 'function' ? s.getHudState() : s.hudState ?? null;
      return st && typeof st === 'object' ? st : null;
    } catch {
      return null;
    }
  }

  /**
   * Live subsystem state is suppressed while a debug state is up. Without this
   * the real `weapons` system overwrites the scripted loadout on the very next
   * frame and every review screenshot shows the engine's default rifle instead
   * of the improvised arsenal the state was built to show.
   */
  _weaponState() {
    return this.state.simulate || this._debug ? null : this._sub('weapons');
  }

  _isPlayerTarget(t) {
    if (!t) return false;
    return t === 'player' || t === this.ctx.peek('player') || t.isPlayer === true;
  }

  /** `vehicle:enter` is emitted for peds boarding too — only toast for us. */
  _isPlayerActor(a) {
    if (!a) return true;
    const p = this.ctx.peek('player');
    return a === 'player' || a === p || a.isPlayer === true || a === p?.movement;
  }

  /** Duck-typed: `vehicles` has not settled on one flag for a cruiser. */
  _isPoliceVehicle(v) {
    if (!v) return false;
    if (v.isPolice === true || v.police === true) return true;
    const spec = v.spec ?? v.def ?? null;
    if (spec?.police || spec?.cop || spec?.kind === 'police') return true;
    const id = String(spec?.id ?? v.type ?? v.name ?? '').toLowerCase();
    return /cruiser|police|cop|patrol/.test(id);
  }

  _playerPos() {
    const p = this.ctx.peek('player');
    const pos = p?.position ?? p?.getPosition?.();
    if (pos && pos.isVector3) return this._pos.copy(pos);
    return this._pos.copy(this.ctx.camera.position);
  }

  /** Fire-and-forget audio; the audio subsystem may not exist yet. */
  sfx(id, gain = 1) {
    const a = this.ctx.peek('audio');
    if (!a) return;
    try {
      if (typeof a.playUi === 'function') a.playUi(id, gain);
      else if (typeof a.play === 'function') a.play(id, { gain });
      else if (typeof a.sfx === 'function') a.sfx(id, gain);
    } catch {
      /* audio is optional feedback — never let it break the HUD */
    }
  }

  /* ---------------------------------------------------------------- api --- */

  hitmarker(kind = 'hit') {
    this.hit.spawn(kind);
    this.crosshair.onHit();
    this.sfx(
      kind === 'kill' ? 'hit_kill' : kind === 'head' ? 'hit_head'
        : kind === 'armour' ? 'hit_armour' : 'hit_flesh',
      kind === 'kill' ? 1 : 0.7
    );
  }

  damageNumber(worldPos, amount, kind = 'hit') {
    this.markers.spawnDamage(worldPos, amount, kind);
  }

  hurt(amount = 10, dirX = 0, dirZ = 1) {
    const i = clamp01(amount / 40);
    this.arcs.spawn(dirX, dirZ, 0.45 + i * 0.55);
    this.health.onDamage(i);
    this.crosshair.onFlinch(0.5 + i);
    this._regenTimer = 0;
    this.state.regen = false;
    this.sfx('player_hurt', 0.6 + i * 0.4);
  }

  setObjective(o) {
    this.objective.set(o);
  }

  clearObjective() {
    this.objective.clear();
  }

  titleCard(chapter, name, zone) {
    this.title.show(chapter, name, zone);
    this.sfx('title_card', 0.7);
  }

  say(who, text) {
    this.subs.push(who, text);
  }

  playScene(lines) {
    this.subs.play(lines);
  }

  card(kind, sub, rewards) {
    this.bigCard.show(kind, sub, rewards);
    this.sfx(kind === 'passed' ? 'mission_pass' : 'mission_fail', 0.9);
    this._syncPause();
  }

  /**
   * The feedback path. `tone` is 'slag' | 'good' | 'bad' | 'gold' | 'char',
   * where 'char' is the active brother's accent colour. Anything the PLAYER did
   * toasts in the character's colour, which is what makes the three brothers
   * feel like three different people rather than
   * three meshes. A raw '#rrggbb' is accepted too, for callers that already
   * have a colour in hand.
   */
  notify(text, value, tone = 'slag') {
    const t = this._touchify(text);
    const v = this._touchify(value);
    if (typeof tone === 'string' && tone.charCodeAt(0) === 35 /* # */) {
      this.feed.push(t, v, 'char', tone);
      return;
    }
    this.feed.push(t, v, tone,
      tone === 'char' ? (this.state.accent ?? this.state.colour) : null);
  }

  /**
   * A touch player has no J, F, M or P. Anything that names a key it does not
   * have gets rewritten to name the on-screen control that does the same
   * thing — "tap ACT" instead of "press F" — applied at the one choke point
   * every toast already flows through.
   */
  _touchify(text) {
    if (!this.touch?.active || typeof text !== 'string') return text;
    return text
      .replace(/PRESS J\b/gi, 'TAP JOB')
      .replace(/PRESS F\b/gi, 'TAP ACT')
      .replace(/PRESS K\b/gi, 'TAP JOB')
      .replace(/PRESS M\b/gi, 'TAP MAP')
      .replace(/PRESS P\b/gi, 'TAP PHONE')
      .replace(/HOLD TAB\b/gi, 'HOLD WEP')
      .replace(/PRESS N\b/gi, 'TAP RADIO');
  }

  /** An alias for `notify`, kept for callers that use the older name. */
  toast(text, colourOrTone, value) {
    this.notify(text, value ?? '', colourOrTone ?? 'char');
  }

  /* ------------------------------------------------- the contextual action */

  /**
   * Publish the current contextual action explicitly. `game` may call this
   * instead of (or alongside) `setPrompt` when the short verb it wants on the
   * touch button is not derivable from the prompt line.
   *
   * @param {?object} a { label, verb, icon, sub, available, key }
   *                    pass null / omit to fall back to the prompt.
   */
  setAction(a) {
    if (!a) {
      this._apiAction = null;
      return;
    }
    this._apiAction = {
      available: a.available !== false,
      label: a.label ?? a.text ?? '',
      verb: (a.verb ?? verbFor(a.label ?? a.text, this.state.inVehicle).verb).toUpperCase(),
      icon: a.icon ?? verbFor(a.label ?? a.text, this.state.inVehicle).icon,
      sub: a.sub ?? '',
      key: a.key ?? 'F',
      source: 'api',
    };
  }

  /** What the action button / prompt is offering right now. */
  getAction() {
    return this.action;
  }

  /**
   * Fire the contextual action. The touch ACT button routes here, and so could
   * anything else that wants one-button interaction.
   *
   * It does NOT implement any interaction itself: it presses the same `use`
   * verb the keyboard presses, so `player.vehicles` and `game.freeroam` handle
   * it through the one code path they already have. The only thing it adds is
   * the miss case — it toasts "No vehicle nearby" rather than silently doing
   * nothing, because a control that gives no feedback when you press it reads
   * as broken.
   */
  triggerAction(source = 'button') {
    this.ctx.events.emit('ui:action', {
      source, verb: this.action.verb, available: this.action.available,
    });
    if (this.action.available) {
      this.touch?.bridge?.tap('KeyF');
      this.sfx('ui_confirm', 0.5);
      return true;
    }
    this._missFeedback();
    return false;
  }

  /**
   * Is there anything to do right now?
   *
   * Read live rather than off `this.action` because `game.freeroam` publishes
   * its prompt during `update()` and this is queried from `lateUpdate()` in the
   * same frame — one frame of lag here would let F toast "no vehicle nearby"
   * on the very frame you walked into range.
   */
  _actionAvailable() {
    if (this._apiAction) return this._apiAction.available;
    return this._promptActive || this.state.inVehicle;
  }

  /**
   * Resolve the one contextual action for this frame and push it at both faces
   * of it: the touch ACT button and the desktop prompt.
   *
   * The EXIT case is synthesized here. Nothing publishes it — `player.vehicles`
   * nulls its prompt the moment you are seated (`src/player/vehicle.js`), which
   * is correct for the centre-screen prompt but leaves the player with no
   * indication at all that F gets you out. So the action is relabelled EXIT for
   * as long as you are in the car, and the line is shown briefly on entry.
   */
  _updateAction(rawDt) {
    void rawDt;
    const a = this.action;
    const inVeh = this.state.inVehicle;

    /**
     * A refused exit is the one interaction in the game that can fail silently:
     * `player.vehicles.tryExit` returns false and bumps `stats.exitBlocked`
     * when there is nowhere to stand — a wall, a bridge parapet, water — and
     * nothing tells the player, so the button reads as broken. Watching the
     * counter is the only way to see it from here without reaching into
     * `src/player/`, and it costs one integer compare a frame.
     */
    const vstats = this.ctx.peek('player')?.vehicles?.stats;
    const blocked = vstats?.exitBlocked ?? 0;
    if (blocked > this._exitBlocked) {
      this._exitBlocked = blocked;
      if (this._missT <= 0) {
        this._missT = 0.9;
        this.notify('No room to get out', 'PULL OVER', 'bad');
      }
    }

    if (this._apiAction) {
      const s = this._apiAction;
      a.available = s.available;
      a.verb = s.verb;
      a.icon = s.icon;
      a.label = s.label;
      a.sub = s.sub;
      a.key = s.key;
      a.source = 'api';
    } else if (inVeh) {
      /**
       * IN A VEHICLE THE BUTTON SAYS EXIT, WHATEVER ELSE IS ON OFFER.
       *
       * `game.freeroam` publishes in-vehicle prompts of its own — SWAP, the
       * respray, a race start — and the probe caught the button promising
       * "SWAP" while the actual key did something else. It is not a labelling
       * mistake: `player.vehicles` acts on `use` FIRST and exits
       * unconditionally whenever you are seated (`src/player/vehicle.js`
       * `_useEdge` -> `tryExit`), so F in a car always means "get out" no
       * matter what else claims the same key that frame.
       *
       * A button that names an action it will not perform is worse than no
       * button, so the verb tells the truth and the prompt line survives as
       * INFORMATION on the label strip above it — which is also how you can
       * still see "FILLING · 62%" or a race name while you sit at the pump.
       * The underlying key collision belongs to `game`/`player`, not here.
       */
      a.available = true;
      a.verb = 'EXIT';
      a.icon = 'exit';
      a.label = this._promptActive && this._promptLabel ? this._promptLabel : 'EXIT VEHICLE';
      a.sub = '';
      a.key = 'F';
      a.source = 'vehicle';
      // On desktop, say EXIT for a beat after getting in and then get out of
      // the way — a permanent "F · EXIT" panel over the windscreen is noise —
      // but never over the top of a real prompt `game` is publishing.
      if (this._exitPromptT > 0 && !this._promptActive) {
        this.prompt.set(this._exitPrompt);
        this._exitPromptShown = true;
      } else if (this._exitPromptShown && !this._promptActive) {
        this._exitPromptShown = false;
        this.prompt.clear();
      }
    } else if (this._promptActive) {
      a.available = true;
      a.verb = this._promptVerb;
      a.icon = this._promptIcon;
      a.label = this._promptLabel;
      a.sub = '';
      a.key = 'F';
      a.source = 'prompt';
    } else {
      a.available = false;
      a.verb = 'USE';
      a.icon = 'hand';
      a.label = '';
      a.sub = '';
      a.key = 'F';
      a.source = 'prompt';
      if (this._exitPromptShown) {
        this._exitPromptShown = false;
        this.prompt.clear();
      }
    }

    this.touch?.setAction(a);
  }

  /** The no-op case, which still has to feel like something happened. */
  _missFeedback() {
    if (this._missT > 0) return;
    this._missT = 0.8;
    this.notify(this.state.inVehicle ? 'Nothing to do here' : 'No vehicle nearby', '', 'bad');
    this.sfx('ui_deny', 0.5);
  }

  setWanted(level, cooldown = 1) {
    this.state.wanted = clamp(level | 0, 0, 5);
    this.state.wantedCooldown = clamp01(cooldown);
    this.stars.set(this.state.wanted, this.state.wantedCooldown);
  }

  setMoney(total, delta = 0) {
    this.state.money = total;
    this.money.set(total, delta);
  }

  setRespect(total, delta = 0) {
    this.state.respect = total;
    this.respect.set(total, delta);
  }

  setWaypoint(w) {
    this.state.waypoint = w;
    this.map.waypoint = w;
  }

  /** @param {number[]|Float32Array} flat  x,z pairs in world metres */
  setRoute(flat) {
    this.state.route = flat;
  }

  setCharacter(id) {
    const boy = BOY_BY_ID[id];
    if (!boy) return;
    this.state.character = id;
    this.state.colour = boy.colour;
    this.state.accent = boy.accent ?? boy.colour;
    this.root.style.setProperty('--accent', this.state.accent);
    this.state.maxHealth = boy.hp;
    this.state.maxArmour = boy.armour;
    this.weaponWheel.setLoadout(boy.weapons, null);
    this.charWheel.index = BOYZ.findIndex((b) => b.id === id);
    this.ctx.events.emit('ui:character', { id });
  }

  /**
   * @param {string|number|null} id  a station id, or 'off' / -1 / null for
   *   RADIO OFF. OFF emits `ui:station { id: -1 }` — same event, sentinel id —
   *   so the audio consumer keeps one wire.
   */
  setStation(id) {
    if (id === 'off' || id === -1 || id == null) {
      this.state.station = 'off';
      this.radio.show(OFF_STATION, -1, STATIONS.length);
      this.ctx.events.emit('ui:station', { id: -1 });
      return;
    }
    const i = STATIONS.findIndex((s) => s.id === id);
    if (i < 0) return;
    this.state.station = id;
    this.radio.show(STATIONS[i], i, STATIONS.length);
    this.ctx.events.emit('ui:station', { id });
  }

  /**
   * Station 1 → … → station n → OFF → back to station 1. OFF is a real stop on
   * the dial, not a missing feature.
   */
  cycleStation(dir = 1) {
    const boy = BOY_BY_ID[this.state.character];
    const list = boy?.radio?.length ? boy.radio : STATIONS.map((s) => s.id);
    const n = list.length + 1; // the +1 is OFF
    const cur = this.state.station === 'off' ? list.length : list.indexOf(this.state.station);
    const next = ((cur + dir) % n + n) % n;
    this.setStation(next === list.length ? 'off' : list[next]);
  }

  packageFound(id) {
    if (this._foundPackages.has(id)) return;
    this._foundPackages.add(id);
    this.notify('Hidden package', `${this._foundPackages.size} / ${PACKAGES.length}`, 'gold');
  }

  zone(name) {
    // A chapter title card owns the lower left while it is up; a district
    // flourish underneath it is two pieces of display type fighting.
    if (this.title.active) return;
    this.zoneFlourish.show(name);
  }

  /**
   * Each of these re-derives the pause immediately rather than waiting for the
   * next `lateUpdate`: they are called from touch taps and from `game`, i.e.
   * between frames, and an overlay that is up for a frame with the world still
   * running is exactly the defect this all exists to prevent.
   */
  openMap() {
    this.map.show({ x: this.state.x, z: this.state.z });
    this._syncPause();
  }

  closeMap() {
    this.map.hide();
    this._syncPause();
  }

  /** M on the keyboard, the MAP nav button on touch, a tap on the radar. */
  toggleMap() {
    this.map.toggle({ x: this.state.x, z: this.state.z });
    this.ctx.events.emit('ui:map', { open: this.map.open });
    this._syncPause();
  }

  /* --------------------------------------------------- the story overview */

  /**
   * Normalise the chapter list for the overview. Three sources, best first:
   *
   *   1. `game.getStoryOverview()` — the real API. Either
   *      an array of rows or `{ title, summary, chapters: [...] }`; row fields
   *      are accepted under several spellings and statuses are derived from
   *      whatever is present.
   *   2. Duck-typed game internals (`characters.boy.story` + the save's
   *      chapter frontier) — enough to build the same list today.
   *   3. null — the modal still opens and says so honestly.
   */
  _storyData() {
    const g = this.ctx.peek('game');
    if (!g) return null;
    try {
      let raw = null;
      if (typeof g.getStoryOverview === 'function') raw = g.getStoryOverview();
      let title = null;
      let summary = null;
      let list = null;
      if (raw) {
        list = Array.isArray(raw) ? raw : raw.chapters ?? raw.rows ?? raw.list ?? null;
        title = raw.title ?? null;
        summary = raw.summary ?? null;
      }
      let frontier = null;
      if (!Array.isArray(list)) {
        // Fallback: the same tables `startMission` reads.
        const boy = g.characters?.boy;
        list = Array.isArray(boy?.story) ? boy.story : null;
        frontier = g.getHudState?.().chapter ?? 0;
      }
      if (!Array.isArray(list) || !list.length) return null;

      if (frontier === null) {
        frontier = raw?.chapter ?? raw?.frontier ?? g.getHudState?.().chapter ?? 0;
      }
      const rows = [];
      for (let i = 0; i < list.length; i++) {
        const r = list[i] ?? {};
        const index = Number.isInteger(r.index) ? r.index : Number.isInteger(r.i) ? r.i : i;
        let status = r.status;
        if (status !== 'done' && status !== 'current' && status !== 'locked') {
          status = r.done === true ? 'done' : r.current === true ? 'current'
            : r.locked === true ? 'locked'
              : index < frontier ? 'done' : index === frontier ? 'current' : 'locked';
        }
        rows.push({
          index,
          no: r.no ?? r.chapter ?? 'CHAPTER ' + (index + 1),
          name: r.name ?? r.title ?? r.def?.name ?? '',
          teaser: r.teaser ?? r.desc ?? r.sub ?? '',
          cash: r.cash ?? r.reward ?? r.pay ?? 0,
          status,
        });
      }
      const done = rows.filter((r) => r.status === 'done').length;
      const boyName = (g.characters?.boy?.name ?? this.state.character ?? '').toUpperCase();
      return {
        title: title ?? (boyName ? boyName + "'S STORY" : 'THE STORY'),
        summary: summary ?? (done >= rows.length
          ? 'Story complete — the city is yours. Replay any chapter.'
          : `${done} of ${rows.length} chapters complete`),
        rows,
      };
    } catch (err) {
      console.warn('[ui] story overview data failed', err);
      return null;
    }
  }

  openStory() {
    this.story.show(this._storyData());
    this.sfx('wheel_open', 0.5);
    this._syncPause();
  }

  closeStory() {
    this.story.hide();
    this._syncPause();
  }

  toggleStory() {
    if (this.story.open) this.closeStory();
    else this.openStory();
  }

  /**
   * A playable overview row was activated. Completed rows REPLAY, the current
   * row starts the chapter — both through whichever entry point `game` has,
   * newest API first. A refusal (a job already running) is feedback, not
   * silence.
   */
  _startChapter(i) {
    const g = this.ctx.peek('game');
    if (!g) return false;
    const fn = g.replayChapter ?? g.startChapter ?? g.startMission;
    if (typeof fn !== 'function') return false;
    let M = null;
    try {
      M = fn.call(g, i);
    } catch (err) {
      console.warn('[ui] chapter start failed', err);
    }
    if (M) {
      this.closeStory();
      this.sfx('ui_confirm', 0.6);
      return true;
    }
    this.notify('Finish the current job first', '', 'bad');
    this.sfx('ui_deny', 0.5);
    return false;
  }

  /**
   * The mission action — the JOB nav button on touch, and anything else that
   * wants "do the next story thing". Idle with chapters on the board: open the
   * overview — the road map sells the ride. Mission already running: press the
   * same J the keyboard presses (skip intro).
   */
  missionAction(source = 'touch') {
    void source;
    const g = this.ctx.peek('game');
    const active = !!(g?.missions?.active);
    if (!active && !this.story.open) {
      const data = this._storyData();
      if (data) {
        this.story.show(data);
        this.sfx('wheel_open', 0.5);
        return;
      }
    }
    if (this.story.open) {
      this.closeStory();
      return;
    }
    this.touch?.bridge?.tap('KeyJ');
  }

  /**
   * @param {object} p { key, text, sub, progress }
   *
   * Re-asserted every frame by `game.freeroam` (see the note in that file about
   * two caches over one slot), so this has to stay cheap: `Prompt.set` is
   * change-guarded through `setText`, and the verb is only re-derived when the
   * text actually changes.
   */
  setPrompt(p) {
    this.prompt.set(p);
    this._promptActive = true;
    const text = p?.text ?? '';
    if (text !== this._lastPromptText) {
      this._onPromptChanged(this._lastPromptText, text);
      this._lastPromptText = text;
      // Derived ONCE per change, not once per frame: `game` re-asserts the
      // prompt every frame and `toUpperCase`/`split` both allocate, which is a
      // steady 60 Hz of garbage for a string that almost never changes.
      const v = verbFor(text, this.state.inVehicle);
      this._promptVerb = v.verb;
      this._promptIcon = v.icon;
      this._promptLabel = String(text).toUpperCase();
    }
  }

  clearPrompt() {
    this.prompt.clear();
    this._promptActive = false;
    if (this._lastPromptText) {
      this._onPromptChanged(this._lastPromptText, '');
      this._lastPromptText = '';
      this._promptVerb = 'USE';
      this._promptIcon = 'hand';
      this._promptLabel = '';
    }
  }

  /**
   * A service that finishes changes its prompt and says nothing else. The pump
   * goes from "FILLING" to "TANK FULL" and the body shop from "HAMMERING OUT
   * THE DENTS" to "EVERYTHING SOUND" with no toast, so the player watching the
   * road rather than the prompt never learns it is done.
   *
   * This is a stopgap until `game` emits a completion event: a one-shot toast
   * on the transition INTO a completion line, rate-limited so idling at a pump
   * cannot spam the feed.
   */
  _onPromptChanged(from, to) {
    if (!from || this._serviceToastT > 0) return;
    const t = String(to).toUpperCase();
    if (/TANK FULL/.test(t)) {
      this._serviceToastT = 6;
      this.notify('Tank full', '', 'good');
    } else if (/EVERYTHING SOUND/.test(t)) {
      this._serviceToastT = 6;
      this.notify('Panels beaten out', '', 'good');
    }
  }

  setObjectives(list) {
    this._objectives = list ?? [];
  }

  /** Copies into a preallocated array — the caller's array is not retained. */
  setBlips(list) {
    const n = Math.min(list?.length ?? 0, MAX_BLIPS);
    for (let i = 0; i < n; i++) {
      const src = list[i];
      const dst = this._blips[i];
      dst.x = src.x ?? src.position?.x ?? 0;
      dst.z = src.z ?? src.position?.z ?? 0;
      dst.kind = src.kind ?? (src.friendly ? 'friend' : 'enemy');
      dst.heading = src.heading ?? 0;
      const c = src.colour ?? src.color;
      dst.colour = typeof c === 'string' && c ? c : null;
    }
    this._blipCount = n;
  }

  spawnGrenade(worldPos, fuse = 2.4) {
    this.markers.spawnGrenade(worldPos, fuse);
    this.sfx('grenade_warn', 0.6);
  }

  setHudVisible(v) {
    this.hudTarget = v ? 1 : 0;
  }

  /**
   * THERE IS NO `ui.pause()`. `ui.pause` is the arbiter object — see the note
   * at the assignment in `init()`. To stop the world from outside:
   *
   *   ui.menu.show()             the pause menu, what `pause()` used to do
   *   ui.pause.claim(name, 0)    a subsystem's own named claim
   *
   * `resume()` stays because nothing shadows it and it reads better than
   * `menu.close()` at a call site that is closing the game down.
   */
  resume() {
    this.menu.close();
    this._syncPause();
  }

  /* -------------------------------------------------------------- frame --- */

  lateUpdate(dt, ctx) {
    const t = ctx.time;
    const rawDt = clamp(t.raw - this._lastRaw, 0, 0.1);
    this._lastRaw = t.raw;
    const s = this.state;
    s.time = t.elapsed;

    this._missT = Math.max(0, this._missT - rawDt);
    this._serviceToastT = Math.max(0, this._serviceToastT - rawDt);
    this._exitPromptT = Math.max(0, this._exitPromptT - rawDt);

    // The boot overlay owns the screen until the player presses START, so the
    // in-game key handling underneath stands down — otherwise ESC on the
    // character select would silently arm a pause menu behind it, which is the
    // sort of thing that traps a player. (It animates itself off rAF, because
    // it has to keep moving during `engine.init()` when this loop is not yet
    // running at all.)
    if (!this.boot?.active) this._input(rawDt, ctx);
    this.menu.update(rawDt);
    // Unscaled time, and OUTSIDE any `open` guard: the godmode and
    // infinite-ammo pumps have to keep running after the panel is closed, and
    // the panel's own fade has to finish while the sim is frozen.
    this.cheats?.update(rawDt);
    this._pullState(dt, rawDt, ctx);
    this._updateAction(rawDt);
    if (this._debug) this._debugTick(rawDt);

    // ---- camera basis ----------------------------------------------------
    const m = ctx.camera.matrixWorld.elements;
    let fx = -m[8];
    let fz = -m[10];
    let rx = m[0];
    let rz = m[2];
    const fl = Math.hypot(fx, fz) || 1;
    const rl = Math.hypot(rx, rz) || 1;
    fx /= fl;
    fz /= fl;
    rx /= rl;
    rz /= rl;
    if (!this._headingOverride) s.heading = (Math.atan2(fx, -fz) * 180) / Math.PI;

    // ---- global HUD fade -------------------------------------------------
    const hudGoal = this.hudTarget *
      (this.menu.open ? 0.1 : 1) * (this.map.open ? 0 : 1) *
      (this.cheats?.open ? 0 : 1) *
      (this.story.open || this.ending.active ? 0 : 1) *
      (this.weaponWheel.a > 0.5 || this.charWheel.a > 0.5 ? 0.25 : 1);
    this.hudVisible = damp(this.hudVisible, hudGoal, 10, rawDt);
    const a = this.hudVisible.toFixed(3);
    setStyle(this.chromeLayer, 'opacity', a);
    setStyle(this.worldLayer, 'opacity', a);
    setStyle(this.centreLayer, 'opacity', a);

    // ---- touch controls --------------------------------------------------
    // Anything that owns the screen also owns the thumbs: the pause menu, the
    // pause map and the phone all have their own tap targets, and leaving a
    // FIRE button live under a modal is how you shoot the sky while reading
    // your texts. The weapon wheel is the exception — it is DRIVEN by the WEP
    // button being held, so it must stay up.
    if (this.touch) {
      const modal = this.menu.open || this.map.open || this.phone.open ||
        this.bigCard.active || this.story.open || this.ending.active ||
        !!this.cheats?.open;
      this.touch.setVisible(this.touch.active && !modal && this.hudTarget > 0);
      this.touch.update(rawDt);
    }

    // ---- widgets ---------------------------------------------------------
    // A third-person open-world game has no persistent reticle: it appears
    // when you aim and for a beat after you fire, and never otherwise. A
    // permanent cross in the middle of the screen is the single loudest "this
    // is a shooter HUD" tell there is.
    this._fireT = Math.max(0, (this._fireT ?? 0) - rawDt);
    s.hidden = !(s.ads || this._fireT > 0);
    this.crosshair.update(dt, s);
    this.hit.update(dt);
    this.arcs.update(dt, rx, rz, fx, fz);
    this.health.update(dt, s);
    this.vitalArcs.update(rawDt, s);
    this.weapon.update(rawDt, s);
    this.prompt.update(dt);
    this.banner.update(dt);

    // The clock reads the LIVE hour off `sky`, not just the `time:hour` event.
    //
    // `time:hour` fires when the hour turns. A capture calls `sky.setTimeOfDay()`
    // to jump straight to 01:30, which turns no hour, so the HUD kept displaying
    // its seeded 17.4 — and every frame in the review set, at every time of day,
    // was stamped "17:23 CLEAR". Two separate adversarial critic panels then used
    // that stamp as evidence that the night shot "is provably the same 17:23
    // daylight scene" and that the set "shows four mutually incompatible suns".
    // The sun was correct in all of them. The clock was lying.
    // NOTE: `_sub(id)` returns a subsystem's getHudState(), not the subsystem —
    // and `sky` does not implement one, so `_sub('sky')` is always null. Reach
    // for the system itself.
    const skySys = this.ctx.peek('sky');
    const liveHour = skySys?.hour ?? skySys?.timeOfDay;
    if (Number.isFinite(liveHour)) s.hour = liveHour;
    const liveWeather = skySys?.weather ?? skySys?.state;
    if (typeof liveWeather === 'string') s.weather = liveWeather;

    this.phone.setState({
      station: s.station, character: s.character,
      found: this._foundPackages.size, hour: s.hour, respect: s.respect,
    });
    this.phone.update(rawDt);
    this.stars.update(rawDt);
    const moneyBusy = this.money.update(rawDt);
    const respectBusy = this.respect.update(rawDt);
    this.vehm.update(rawDt, s.veh);
    this.story.update(rawDt);
    this.ending.update(rawDt);
    this.clock.set(s.hour, s.weather);
    this.clock.update();
    this.objective.update(rawDt);
    this.zoneFlourish.update(rawDt);
    this.title.update(rawDt);
    this.subs.update(rawDt);
    this.feed.update(rawDt);
    this.radio.update(rawDt);
    this.bigCard.update(rawDt);

    // ---- wanted heat wash -------------------------------------------------
    const washGoal = clamp01((s.wanted - 3.1) / 1.9);
    this._wash = damp(this._wash ?? 0, washGoal, 2.2, rawDt);
    const washPulse = 0.72 + 0.28 * Math.sin(t.raw * 3.4);
    setStyle(this.heatWash, 'display', this._wash < 0.004 ? 'none' : '');
    setStyle(this.heatWash, 'opacity', (this._wash * washPulse).toFixed(3));

    // Fade the corner readouts that are not currently telling you anything.
    // GTA's HUD is mostly invisible; ours earns the same by only showing money
    // when it moved and the clock when the hour turned.
    const quiet = !this._debug;
    setStyle(this.money.root, 'opacity', quiet ? clamp01(moneyBusy).toFixed(3) : '1');
    // Respect keeps money's rule: visible while either currency just moved
    // (a payout is usually both), invisible when neither is telling you
    // anything — the two read as one column, so they fade as one.
    setStyle(this.respect.root, 'opacity',
      quiet ? clamp01(Math.max(respectBusy, moneyBusy * 0.55)).toFixed(3) : '1');
    setStyle(this.clock.root, 'opacity', quiet ? '0.55' : '0.9');
    setStyle(this.stars.root, 'opacity', this.stars.level > 0 ? '1' : '0');
    setStyle(this.weapon.root, 'opacity',
      quiet && s.weaponMelee && !s.ads && s.wanted === 0 ? '0.5' : '1');

    // ---- markers ---------------------------------------------------------
    this.markers.updateObjectives(this._objectives, ctx.camera, this.vw, this.vh, this.k);
    this.markers.updateGrenades(dt, ctx.camera, this.vw, this.vh, this.k);
    this.markers.updateDamage(dt, ctx.camera, this.vw, this.vh, this.k);

    // ---- radar -----------------------------------------------------------
    this._collectBlips();
    this._blipView.length = this._blipCount;
    for (let i = 0; i < this._blipCount; i++) this._blipView[i] = this._blips[i];
    const r = this._radarState;
    r.x = s.x;
    r.z = s.z;
    r.heading = s.heading;
    r.speed = s.speed;
    r.inVehicle = s.inVehicle;
    r.wanted = s.wanted;
    r.hunting = s.hunting;
    r.blips = this._blipView;
    r.route = s.route;
    r.waypoint = s.waypoint;
    r.colour = s.colour;
    r.street = s.street;
    this.radar.draw(r, rawDt);

    // ---- full-screen states ----------------------------------------------
    this.weaponWheel.update(rawDt);
    this.charWheel.update(rawDt);
    // The full map draws the SAME live contacts the ring does — one source,
    // two projections, no way for them to disagree.
    this.map.blips = this._blipView;
    this.map.update(rawDt, {
      x: s.x, z: s.z, heading: s.heading, colour: s.colour, inVehicle: s.inVehicle,
    });

    // LAST, deliberately. Overlays close themselves inside the updates above —
    // `bigCard` expires on its own timer, the ending sequencer finishes — so a
    // derivation taken any earlier would be one frame stale and hand the clock
    // back a frame late (or hold it a frame long).
    this._syncPause();
  }

  /**
   * ---------------------------------------------------------------------
   * THE SINGLE DERIVATION — "is any modal open" answered in one place
   * ---------------------------------------------------------------------
   * Every overlay's CURRENT state, read live, handed to the arbiter. Nothing
   * here remembers anything; call it as often as you like, in any order.
   *
   * Debug states, the boot flow and the sandbox's `simulate` are exempt —
   * they are screenshot fictions and a loading screen, not gameplay. The pause
   * MENU is deliberately NOT exempt: `menu.show()` has always stopped the
   * world, including in the `menu` debug state the capture harness stages.
   */
  _syncPause() {
    const w = this._wants;
    const off = !!this._debug || !!this.boot?.active || !!this.state.simulate;
    w.menu = this.menu.open;
    w.ending = !off && this.ending.active;
    w.cheats = !off && !!this.cheats?.open;
    w.story = !off && this.story.open;
    w.map = !off && this.map.open;
    w.phone = !off && this.phone.open;
    w.card = !off && this.bigCard.active;
    // The cutscene player lives in `mission.js` and used to bank its own
    // `_prevScale` and write the clock itself. `Cutscene._arbiterOwnsCut()`
    // tests for this very key and stands down the moment it exists, so there is
    // no window in which both of us own the scale.
    w.cut = !off && !!this.subs.cut.active;
    w.wheel = !off && (this.weaponWheel.open || this.charWheel.open);
    const frozen = this.pause.sync(w);
    // Any overlay the player clicks with the mouse must free the cursor. A
    // window-level pointer lock survives the overlay opening (M/O/P open it
    // from the keyboard, clicking nothing), so without this the map/story/phone
    // came up with a captured, invisible cursor and dead buttons — the exact
    // "I can't click Let's Ride until I press Escape first" report. The lock
    // guard (input.pointerLockGuard = isPaused) then keeps it off until the
    // overlay closes, and the next click in the running game re-grabs it.
    // `w.cut` is IN this list on purpose: the intro cutscene has a SKIP button
    // and click-to-advance, and the first player report was exactly "I cannot
    // click skip" — the free-roam pointer lock survived into the cutscene and
    // held the cursor captive over an interstitial made of buttons. Releasing
    // here and letting the guard refuse re-grabs until the scene ends gives the
    // cursor back for the interstitial; the next canvas click re-locks.
    //
    // EDGE-triggered, twice over. Level-triggered, this ran every sync while
    // the result card's `active` flag outlived its fade, killing every grab the
    // player attempted for seconds after the card had visually gone. And the
    // release must DISARM `_hadPointerLock` in the same breath: `_input` reads
    // "had the lock, lost it" as the player pressing Escape (in a real browser
    // that IS how the first Escape arrives), so a deliberate release here would
    // otherwise arm a pause menu that springs open over the very interstitial
    // the release was freeing the cursor for.
    const needsCursor =
      w.menu || w.story || w.map || w.phone || w.cheats || w.ending || w.card || w.cut;
    if (needsCursor && !this._needsCursorPrev) {
      this._hadPointerLock = false;               // ours, not an Escape
      this.ctx?.input?.exitPointerLock?.();
    }
    this._needsCursorPrev = needsCursor;
    return frozen;
  }

  /**
   * IS THE WORLD STOPPED? The one predicate every input consumer gates on,
   * including `game`'s J / K / U (which reach it through `ctx.peek('ui')`,
   * never an import). If this is true nothing the player presses may reach the
   * simulation — he is looking at a menu, and a key that acts from behind one
   * is indistinguishable from the game doing it by itself.
   */
  isPaused() {
    return this.pause.frozen;
  }

  /**
   * The overlay that owns the screen below the pause menu, or null. Exactly
   * one at a time: stacking two of these is how a player ends up unable to
   * tell what Escape will close.
   */
  _hardModal() {
    if (this.story.open) return 'story';
    if (this.map.open) return 'map';
    if (this.phone.open) return 'phone';
    if (this.bigCard.active) return 'card';
    return null;
  }

  /* ------------------------------------------------------------- reading -- */

  _pullState(dt, rawDt, ctx) {
    const s = this.state;

    // ---- weapon -----------------------------------------------------------
    const ws = this._weaponState();
    if (ws) {
      if (ws.id && WEAPONS[ws.id]) {
        s.weaponId = ws.id;
        s.weaponName = WEAPONS[ws.id].name;
        s.weaponGlyph = WEAPONS[ws.id].glyph;
        s.weaponMelee = !!WEAPONS[ws.id].melee;
        s.magSize = WEAPONS[ws.id].mag;
      }
      if (ws.name) s.weaponName = String(ws.name).toUpperCase();
      if (ws.ammo !== undefined) s.ammo = ws.ammo;
      if (ws.reserve !== undefined) s.reserve = ws.reserve;
      if (ws.magSize !== undefined) s.magSize = ws.magSize;
      if (ws.reloading !== undefined) s.reloading = !!ws.reloading;
      if (ws.reloadProgress !== undefined) s.reloadProgress = ws.reloadProgress;
      if (ws.ads !== undefined) s.ads = !!ws.ads;
      if (ws.spread !== undefined) s.baseSpread = 4 + ws.spread * 40;
      if (Array.isArray(ws.loadout) && ws.loadout.length) {
        this.weaponWheel.setLoadout(ws.loadout, ws.ammoByWeapon ?? null);
      }
    }

    // ---- player -----------------------------------------------------------
    const ps = s.simulate || this._debug ? null : this._sub('player');
    const player = ctx.peek('player');
    this._headingOverride = false;
    if (ps) {
      if (ps.health !== undefined) s.health = ps.health;
      if (ps.maxHealth !== undefined) s.maxHealth = ps.maxHealth;
      if (ps.armour !== undefined) s.armour = ps.armour;
      else if (ps.armor !== undefined) s.armour = ps.armor;
      if (ps.maxArmour !== undefined) s.maxArmour = ps.maxArmour;
      if (ps.regen !== undefined) s.regen = !!ps.regen;
      if (ps.ads !== undefined) s.ads = !!ps.ads;
      if (ps.sprint !== undefined) s.sprint = !!ps.sprint;
      if (ps.inVehicle !== undefined) s.inVehicle = !!ps.inVehicle;
      if (ps.character && ps.character !== s.character) this.setCharacter(ps.character);
      // Re-evaluated every frame: latching this on the first heading the
      // player system publishes would freeze the radar for good the moment it
      // stopped publishing one.
      this._headingOverride = ps.heading !== undefined;
      if (this._headingOverride) s.heading = ps.heading;
    } else if (player && typeof player.health === 'number' && !this._debug) {
      s.health = player.health;
    }

    // ---- position / speed -------------------------------------------------
    const pos = this._playerPos();
    s.x = pos.x;
    s.z = pos.z;
    this._dir.copy(pos).sub(this._prevPos);
    this._dir.y = 0;
    const measured = rawDt > 1e-4 ? this._dir.length() / rawDt : 0;
    const vs = this._debug ? null : this._sub('vehicles');
    // `vehicles` publishes `speedKmh`, not `speed` — reading only `.speed`
    // silently fell through to the position delta every frame.
    const vSpeed = vs?.speed ?? (typeof vs?.speedKmh === 'number' ? vs.speedKmh / 3.6 : undefined);
    const speed = this._debug ? s.speed : (ps?.speed ?? vSpeed ?? measured);
    s.speed = damp(s.speed, clamp(speed, 0, 90), 4, rawDt);
    if (!ps && !s.simulate) {
      s.move = damp(s.move, clamp01(measured / 6.2), 12, Math.max(rawDt, 1e-3));
      if (!ws) s.ads = ctx.input.ads && ctx.input.enabled;
    }
    this._prevPos.copy(pos);

    // ---- the vehicle meter cluster ----------------------------------------
    // Field-by-field and optional throughout: `vehicles.getHudState()` is null
    // on foot and may predate fuel; nitro rides on the PLAYER (`player`
    // publishes nitroFraction on its HUD state). Any absent producer
    // hides its row; it never invents a value.
    const veh = s.veh;
    veh.on = !!s.inVehicle && !this._debug;
    veh.health = typeof vs?.health === 'number' && Number.isFinite(vs.health)
      ? clamp01(vs.health) : -1;
    veh.fuel = typeof vs?.fuel === 'number' && Number.isFinite(vs.fuel)
      ? clamp01(vs.fuel) : -1;
    veh.dry = !!vs?.fuelDry;
    const nitro = ps?.nitroFraction ?? (typeof ps?.nitro === 'number' ? ps.nitro / 100 : undefined);
    veh.nitro = typeof nitro === 'number' && Number.isFinite(nitro) ? clamp01(nitro) : -1;
    veh.nitroOn = !!ps?.nitroOn;

    // ---- police -----------------------------------------------------------
    const pol = this._sub('police');
    if (pol && !this._debug) {
      if (pol.wanted !== undefined) this.setWanted(pol.wanted, pol.cooldown ?? 1);
      if (pol.hunting !== undefined) s.hunting = !!pol.hunting;
    }

    // ---- game -------------------------------------------------------------
    const gs = this._sub('game');
    if (gs && !this._debug) {
      if (gs.money !== undefined && gs.money !== s.money) this.setMoney(gs.money, 0);
      if (gs.respect !== undefined && gs.respect !== s.respect) {
        // The very first sync is a restore, not a payout — no delta roll.
        const delta = this._respectSeen ? gs.respect - s.respect : 0;
        this.setRespect(gs.respect, delta);
      }
      if (gs.respect !== undefined) this._respectSeen = true;
      if (gs.objective) this.objective.set(gs.objective);
    }

    // ---- health regeneration when nobody else owns health -----------------
    if (!ps && !s.simulate && !this._debug && s.health < s.maxHealth) {
      this._regenTimer += dt;
      if (this._regenTimer > 4.5) {
        if (!s.regen) {
          s.regen = true;
          this.health.onRegenStart();
        }
        s.health = Math.min(s.maxHealth, s.health + dt * 24);
      }
    }

    // ---- district crossing -> the zone flourish ---------------------------
    const world = ctx.peek('world');
    const d = typeof world?.districtAt === 'function'
      ? world.districtAt(s.x, s.z) : districtAt(s.x, s.z);
    const name = d?.name ?? '';
    if (name && name !== this._zone) {
      const first = this._zone === '';
      this._zone = name;
      if (!first && !this._debug) this.zone(name);
    }
  }

  _collectBlips() {
    if (this._debug) return; // debug states drive their own contacts
    let n = 0;
    const push = (p, kind, heading, colour) => {
      if (n >= MAX_BLIPS || !p) return;
      const b = this._blips[n++];
      b.x = p.x ?? 0;
      b.z = p.z ?? 0;
      b.kind = kind;
      b.heading = heading ?? 0;
      // Only a real CSS colour string survives. Anything else clears the field
      // back to null so a pooled record can never leak the previous frame's
      // brother colour onto an unrelated contact.
      b.colour = typeof colour === 'string' && colour ? colour : null;
    };
    const pol = this._sub('police');
    if (Array.isArray(pol?.cops)) {
      for (const c of pol.cops) {
        if (!c) continue;
        push(c.position ?? c, 'cop', c.heading);
      }
    }
    /**
     * Hostile / crew contacts off `peds.getHudActors()`. The consumer assumes
     * nothing about the producer: a missing method,
     * a throw, a null entry, bare {x,z} instead of a position vector, a
     * `kind` string or a `friendly` flag — all are taken in stride, and a
     * malformed entry costs one blip, never the frame (GAMEPLAY.md §6).
     */
    const peds = this.ctx.peek('peds');
    let actors = null;
    try {
      actors = typeof peds?.getHudActors === 'function' ? peds.getHudActors() : null;
    } catch {
      actors = null;
    }
    if (Array.isArray(actors)) {
      for (const a of actors) {
        if (!a || a.alive === false || a.dead === true) continue;
        const p = a.position ?? a.pos ?? (Number.isFinite(a.x) && Number.isFinite(a.z) ? a : null);
        if (!p || !Number.isFinite(p.x) || !Number.isFinite(p.z)) continue;
        const k = a.kind;
        const kind = k === 'cop' ? 'cop'
          : (k === 'friend' || k === 'crew' || k === 'ally' || a.friendly) ? 'friend'
            : 'enemy';
        // The brother's signature colour, carried straight through to the
        // radar and the pause map. Cops keep their own flashing blue/white,
        // which is drawn from the wanted pulse rather than from a record.
        push(p, kind, a.heading, kind === 'cop' ? null : (a.colour ?? a.color));
      }
    }
    for (const o of this._objectives) {
      if (o.position) push(o.position, 'mission', 0);
    }
    this._blipCount = n;
  }

  /* -------------------------------------------------------------- input --- */

  _input(rawDt, ctx) {
    const input = ctx.input;
    if (!input || !input.enabled || input.frozen) {
      this._closeWheels(ctx);
      this._syncPause();
      return;
    }

    // `PauseMenu` also listens for Escape on the DOM, because a browser that has
    // just eaten the key to exit pointer lock never hands it to the frame loop.
    // When BOTH see the same press, the DOM path wins and this one stands down —
    // otherwise the menu would close and immediately toggle back open.
    if (input.actionPressed('pause') && !this.menu.consumedEscape() &&
        !this.cheats?.consumedEscape()) {
      if (this.ending.active) this.ending.skip();
      // The cheat panel draws over everything except the pause menu, so it is
      // what the first Escape must take down. Its own capture-phase listener
      // usually gets there first (that is what `consumedEscape` above is for);
      // this branch is the path when the key reaches the frame loop instead.
      else if (this.cheats?.open) this.cheats.hide();
      else if (this.story.open) this.closeStory();
      else if (this.map.open) this.closeMap();
      else if (this.phone.open) this.phone.hide();
      else this.menu.toggle();
      this._syncPause();
    }

    /**
     * ---------------------------------------------------------------------
     * THE PAUSE MENU OWNS THE KEYBOARD. NOTHING BELOW RUNS WHILE IT IS UP.
     * ---------------------------------------------------------------------
     * This early return is half the bug. The old code fell straight through to
     * the modal hotkeys and the radial wheels with the menu open, which is how
     * M opened the full map behind it (and left it there over a live world on
     * resume), and how one ESC pressed with TAB held opened the menu on line
     * one and handed the world back to full speed thirty lines later.
     *
     * The wheels are closed rather than abandoned — a wheel left `open` would
     * hold its bullet-time claim under the pause and commit nothing — and the
     * close COMMITS the highlighted entry, exactly as releasing the key does,
     * because from the player's side the wheel did end here.
     */
    if (this.menu.open) {
      this._closeWheels(ctx);
      // `show()` released the pointer lock on purpose. Leaving the latch armed
      // would re-open the menu the instant it came down — see the note on the
      // pointer-lock branch at the bottom of this method.
      this._hadPointerLock = false;
      this._syncPause();
      return;
    }

    // The ending owns the whole screen; nothing else opens over it.
    if (this.ending.active) {
      this._closeWheels(ctx);
      this._syncPause();
      return;
    }
    /**
     * THE CHEAT MENU KEY. Backquote is the convention for a dev console and is
     * the only unbound key in `CONTROLS.md`'s desktop table; F8 is the alias
     * for layouts where the backquote is awkward. Both are no-ops when
     * `cheatsEnabled()` said no, because `this.cheats` is then null.
     */
    if (input.pressed('Backquote') || input.pressed('F8')) this.cheats?.toggle();

    /**
     * Everything below opens ANOTHER modal, and a second modal stacked under
     * the cheat panel is how a player ends up unable to tell what Escape will
     * close. While the panel is up the rest of the hotkeys stand down; the
     * panel's own filter box swallows its keystrokes before they ever reach
     * `Input`, so typing "map" into it cannot open the map either.
     */
    if (this.cheats?.open) {
      this._closeWheels(ctx);
      // `show()` released the pointer lock ON PURPOSE (a locked pointer makes
      // the browser eat Escape). Leaving the latch armed would make the pause
      // menu spring open the instant the panel came down — a modal you did not
      // ask for, arriving exactly as you thought you were back in the game.
      this._hadPointerLock = false;
      this._syncPause();
      return;
    }

    /**
     * ONE OVERLAY AT A TIME. Each of these keys closes its OWN modal whatever
     * else is up (so the key that opened it always gets you back out), but
     * cannot open a second one on top of another. `_hardModal()` is re-read
     * between them rather than cached, so the map opened on this very line
     * blocks the phone on the next.
     */
    if (input.pressed('KeyM') && (this.map.open || !this._hardModal())) this.toggleMap();
    if (input.pressed('KeyP') && (this.phone.open || !this._hardModal())) this.phone.toggle();
    // O — the story overview. The road map is how a chapter is started or
    // replayed, so it deserves a key of its own next to M.
    if (input.pressed('KeyO') && (this.story.open || !this._hardModal())) this.toggleStory();
    if (!this._hardModal()) {
      if (input.pressed('KeyN')) this.cycleStation(1);
      // The radar's north-up / heading-up toggle used to live on H, which
      // `CONTROLS.md` and `ACTIONS.horn` both give to the HORN. Sounding the
      // horn flipped the minimap. It moves to B, and to a tap on the ring.
      if (input.pressed('KeyB')) this.radar.setMode(!this.radar.headingUp);
    }
    if (this.story.open) {
      if (input.pressed('ArrowDown')) this.story.move(1);
      if (input.pressed('ArrowUp')) this.story.move(-1);
      if (input.pressed('Enter')) this.story.activate();
    }

    // THE CONTEXTUAL ACTION, on the desktop side. `player` and `game` both act
    // on `use` themselves; all this adds is the miss case, so pressing F with
    // nothing in reach tells you so instead of feeling like a dead key.
    if (input.actionPressed('use') && !this._actionAvailable() && !this._hardModal()) {
      this._missFeedback();
    }
    if (this.phone.open) {
      if (input.pressed('ArrowDown')) this.phone.move(1);
      if (input.pressed('ArrowUp')) this.phone.move(-1);
      if (input.pressed('ArrowRight')) this.phone.cycleTab(1);
      if (input.pressed('ArrowLeft')) this.phone.cycleTab(-1);
      if (input.pressed('Enter')) {
        const a = this.phone.activate();
        if (a?.kind === 'station') this.setStation(a.id);
        else if (a?.kind === 'character') this.setCharacter(a.id);
      }
    }

    // ---- radial selectors -------------------------------------------------
    const noWheel = !!this._hardModal();
    const wantWeapon = input.held('Tab') && !noWheel;
    const wantChar = input.held('KeyX') && !noWheel;
    if (wantWeapon && !this.weaponWheel.open) {
      const boy = BOY_BY_ID[this.state.character];
      const idx = Math.max(0, (boy?.weapons ?? []).indexOf(this.state.weaponId));
      this.weaponWheel.show(idx);
      this.sfx('wheel_open', 0.6);
    } else if (!wantWeapon && this.weaponWheel.open) {
      this._closeWeaponWheel(ctx);
    }
    if (wantChar && !this.charWheel.open) {
      this.charWheel.show(Math.max(0, BOYZ.findIndex((b) => b.id === this.state.character)));
      this.sfx('wheel_open', 0.6);
    } else if (!wantChar && this.charWheel.open) {
      this._closeCharWheel();
    }
    const wheel = this.weaponWheel.open ? this.weaponWheel
      : this.charWheel.open ? this.charWheel : null;
    if (wheel) wheel.aim(input.look.x * 90, input.look.y * 90);

    // Losing pointer lock mid-game is the same intent as pressing Escape — in a
    // real browser that IS how the first Escape arrives, because the key that
    // exits the lock is consumed by the user agent and never dispatched.
    //
    // The flag is cleared on EVERY loss, not only on the loss that opens the
    // menu. It used to be left latched whenever a modal was already up, so a
    // pointer lock stolen while paused armed a permanent "reopen the menu"
    // that no later frame could disarm.
    if (input.pointerLocked) {
      this._hadPointerLock = true;
    } else if (this._hadPointerLock) {
      this._hadPointerLock = false;
      // The cutscene and the result card are interstitials, not gameplay: a
      // lock lost while one is up is either our own deliberate release (the
      // cursor freed so SKIP is clickable) or a real Escape — and a real
      // Escape during a cut means "skip", which the scene's own key handler
      // already does. Neither should stack a pause menu on top.
      if (!this.menu.open && !this.map.open && !this.phone.open &&
          !this.story.open && !this.ending.active && !this.boot?.active &&
          !this.cheats?.open && !this.subs.cut.active && !this.bigCard.active) {
        this.menu.show();
      }
    }

    this._syncPause();
  }

  /**
   * Take the radial selectors down and COMMIT what was highlighted — the same
   * thing releasing TAB / X does. Every early return in `_input` routes through
   * here, because a wheel left `open` keeps its bullet-time claim on the clock
   * and would quietly run the whole game at 0.22 behind whatever took over the
   * screen.
   */
  _closeWheels(ctx) {
    if (this.weaponWheel.open) this._closeWeaponWheel(ctx);
    if (this.charWheel.open) this._closeCharWheel();
  }

  _closeWeaponWheel(ctx) {
    this.weaponWheel.hide();
    const id = this.weaponWheel.selected;
    if (id && id !== this.state.weaponId) {
      this._selectWeapon(id);
      ctx?.events?.emit('ui:weapon', { id });
    }
  }

  _closeCharWheel() {
    this.charWheel.hide();
    const id = this.charWheel.selected;
    if (id && id !== this.state.character) {
      this.setCharacter(id);
      this.notify('Switched to ' + (BOY_BY_ID[id]?.name ?? id), '', 'slag');
    }
  }

  _selectWeapon(id) {
    const w = WEAPONS[id];
    if (!w) return;
    const s = this.state;
    s.weaponId = id;
    s.weaponName = w.name;
    s.weaponGlyph = w.glyph;
    s.weaponMelee = !!w.melee;
    s.magSize = w.mag;
    s.ammo = w.melee ? 0 : Math.min(w.mag, w.ammo ?? 0);
    s.reserve = w.melee ? 0 : Math.max(0, (w.ammo ?? 0) - s.ammo);
  }

  /* --------------------------------------------------------------- debug -- */

  /**
   * Representative states for screenshots and critics. Everything a debug
   * state shows is pinned: transient widgets are re-armed every frame so the
   * capture harness can pump an arbitrary number of frames and still find the
   * title card, the subtitle and the notification exactly where it left them.
   */
  debugState(name = 'combat') {
    const s = this.state;
    // The player position has to be resolved BEFORE any of the scripted
    // contacts are placed. `debugState` can be called before the first
    // lateUpdate (the capture harness does exactly that), and until then
    // state.x/z are still zero — which put every cop 250 m from the player,
    // off the radar, and made the wanted states look empty.
    const p0 = this._playerPos();
    s.x = p0.x;
    s.z = p0.z;
    this._debug = null;
    this._debugName = name;
    this.subs.clear();
    this.feed.clear();
    this.clearObjective();
    this.map.hide();
    this.phone.hide();
    this.story.hide();
    this.ending.close();
    this.weaponWheel.hide();
    this.charWheel.hide();
    this.bigCard.active = false;
    this.title.active = false;
    this.zoneFlourish.active = false;
    setStyle(this.bigCard.root, 'display', 'none');
    setStyle(this.bigCard.tint, 'display', 'none');
    setStyle(this.title.root, 'display', 'none');
    setStyle(this.zoneFlourish.root, 'display', 'none');
    this.radio.t = 99;
    setStyle(this.radio.root, 'display', 'none');

    if (name === 'clean') {
      this.setCharacter('carson');
      s.health = 130;
      s.armour = 0;
      s.money = 4820;
      this.money.shown = 4820;
      this.money.set(4820, 0);
      this.money.hold = 0;
      this.respect.shown = 320;
      this.setRespect(320, 0);
      this.respect.hold = 0;
      this.setWanted(0);
      this._selectWeapon('pipe');
      this._blipCount = 0;
      this.setWaypoint(null);
      this.setRoute(null);
      this.zoneFlourish.show('GOLDEN TRIANGLE');
      this._debug = { kind: 'clean' };
      return { state: 'clean' };
    }

    if (name === 'menu') {
      this.debugState('combat');
      this.menu.show();
      this.menu.shown = 1;
      return { state: 'menu' };
    }

    // Everything below shares the same fiction: Aidan, mid-chapter, in a car.
    this.setCharacter('aidan');
    s.money = 18450;
    this.money.shown = 18450;
    this.money.set(18450, 0);
    this.respect.shown = 780;
    this.setRespect(780, 0);
    s.inVehicle = true;
    s.speed = 24;
    s.weather = 'WET';
    s.hour = 17.4;
    this._selectWeapon('nailgun');
    s.ammo = 18;
    s.reserve = 64;

    const scene = { kind: name, blips: [], t: 0 };

    if (name === 'combat') {
      s.health = 84;
      s.armour = 44;
      this.setWanted(2, 0.72);
      this.setObjective({
        eyebrow: 'CH 4 · SALVAGE RIGHTS',
        text: 'Pull the crates out of the channel',
        count: '4 / 6',
        timer: 96,
        progress: 0.66,
      });
      this.subs.play([{ who: 'aidan', text: "Half the city's out there fishing for it." }]);
      this.feed.push('Crate recovered', '4 / 6', 'gold');
      this.feed.push('Nail gun ammo', '+30', 'slag');
      scene.blips = this._makeBlips(6, 3);
      scene.route = this._makeRoute();
    } else if (name === 'wanted3') {
      s.health = 62;
      s.armour = 18;
      this.setWanted(3, 0.44);
      this.setObjective({
        eyebrow: 'HEAT',
        text: 'Lose the cops',
        count: 'ROADBLOCKS AHEAD',
        timer: null,
        progress: -1,
      });
      this.feed.push('Roadblock — sixteenth st bridge', '', 'bad');
      scene.blips = this._makeBlips(8, 8);
    } else if (name === 'wanted5') {
      s.health = 26;
      s.armour = 0;
      s.speed = 41;
      this.setWanted(5, 0.92);
      this.setObjective({
        eyebrow: 'HEAT',
        text: 'They will ram you',
        count: 'BRIDGES CLOSED',
        timer: null,
        progress: -1,
      });
      this.feed.push('Helicopter inbound', '', 'bad');
      scene.blips = this._makeBlips(14, 14);
    } else if (name === 'mission') {
      s.health = 118;
      s.armour = 60;
      s.inVehicle = false;
      s.speed = 4;
      this.setWanted(0);
      this.title.show(SAMPLE_SCENE.chapter, SAMPLE_SCENE.title, SAMPLE_SCENE.zone);
      this.subs.play(SAMPLE_SCENE.lines);
      this.setObjective({
        eyebrow: 'RACE · RIVER LOOP',
        text: 'Beat the bridge circuit',
        count: 'CP 3 / 8 · LAP 1 / 1',
        timer: 108,
        progress: 0.37,
      });
      scene.blips = this._makeBlips(0, 0, 3);
      scene.route = this._makeRoute();
    } else if (name === 'map') {
      s.health = 104;
      s.armour = 40;
      this.setWanted(1, 0.8);
      for (let i = 0; i < 5; i++) this._foundPackages.add(PACKAGES[i].id);
      this.map.show({ x: s.x, z: s.z });
      this.map.targetPpm = 0.46;
      this.map.ppm = 0.46;
      this.map.a = 1;
      this.setWaypoint({ x: 632, z: -464 });
    } else if (name === 'wheel') {
      s.health = 96;
      s.armour = 52;
      this.setWanted(1, 0.9);
      this.weaponWheel.show(2);
      this.weaponWheel.a = 1;
      this.weaponWheel.cursor = -Math.PI / 2 + (Math.PI * 2 * 2) / 6;
      this.weaponWheel.hasCursor = true;
      scene.blips = this._makeBlips(3, 2);
    } else if (name === 'switch') {
      s.health = 96;
      s.armour = 52;
      this.setWanted(0);
      this.charWheel.show(1);
      this.charWheel.a = 1;
      this.charWheel.cursor = -Math.PI / 2 + (Math.PI * 2) / 3;
      this.charWheel.hasCursor = true;
    } else if (name === 'radio') {
      s.health = 130;
      s.armour = 60;
      this.setWanted(0);
      this.setStation('furnace');
      scene.blips = this._makeBlips(0, 0);
    } else if (name === 'phone') {
      s.health = 118;
      s.armour = 52;
      this.setWanted(0);
      for (let i = 0; i < 7; i++) this._foundPackages.add(PACKAGES[i].id);
      this.phone.show();
      this.phone.tab = 1;
      this.phone.index = 4;
      this.phone.a = 1;
      this.setStation('furnace');
      this.radio.t = 99;
      setStyle(this.radio.root, 'display', 'none');
      scene.blips = this._makeBlips(0, 0);
    } else if (name === 'passed') {
      this.setWanted(0);
      this.bigCard.show('passed', 'CH 4 — SALVAGE RIGHTS', [
        { value: '$1,900', label: 'CASH' },
        { value: '+55', label: 'RESPECT' },
        { value: 'SPEAR GUN', label: 'UNLOCKED' },
      ]);
    } else if (name === 'wasted') {
      s.health = 0;
      s.armour = 0;
      this.setWanted(3, 0.5);
      this.bigCard.show('wasted', 'you woke up at mercy general', [
        { value: '-$500', label: 'HOSPITAL' },
      ]);
    } else if (name === 'busted') {
      s.health = 40;
      s.armour = 0;
      this.setWanted(0);
      this.bigCard.show('busted', 'the cops took everything you were carrying', [
        { value: '-$1,200', label: 'BAIL' },
      ]);
    } else {
      return this.debugState('combat');
    }

    this._debug = scene;
    if (scene.blips?.length) this.setBlips(scene.blips);
    if (scene.route) this.setRoute(scene.route);
    return { state: name, states: DEBUG_STATES };
  }

  /** Deterministic contacts around the player, in world metres. */
  _makeBlips(cops, chasing, missions = 0) {
    const rng = this.rng;
    const out = [];
    const cx = this.state.x;
    const cz = this.state.z;
    for (let i = 0; i < cops; i++) {
      const a = rng.range(0, Math.PI * 2);
      const r = rng.range(40, i < chasing ? 130 : 320);
      out.push({
        x: cx + Math.cos(a) * r, z: cz + Math.sin(a) * r,
        kind: 'cop', heading: rng.range(0, 360),
      });
    }
    for (let i = 0; i < missions; i++) {
      const a = rng.range(0, Math.PI * 2);
      const r = rng.range(90, 210);
      out.push({ x: cx + Math.cos(a) * r, z: cz + Math.sin(a) * r, kind: 'mission' });
    }
    return out;
  }

  _makeRoute() {
    const rng = this.rng;
    const out = [];
    let x = this.state.x;
    let z = this.state.z;
    let dir = rng.range(0, Math.PI * 2);
    out.push(x, z);
    for (let i = 0; i < 7; i++) {
      dir += rng.range(-0.8, 0.8);
      const len = rng.range(50, 130);
      x += Math.cos(dir) * len;
      z += Math.sin(dir) * len;
      out.push(x, z);
    }
    return out;
  }

  /** Re-arm everything transient so a debug frame is stable at any settle. */
  _debugTick() {
    const d = this._debug;
    if (!d) return;
    if (this.title.active) this.title.t = 1.1;
    if (this.subs.active) this.subs.t = 0.55;
    if (this.zoneFlourish.active) this.zoneFlourish.t = 0.8;
    if (this.bigCard.active) this.bigCard.t = 1.3;
    if (this.radio.t < this.radio.life) this.radio.t = 0.6;
    this.money.hold = 1;
    this.respect.hold = 1;
    for (const it of this.feed.items) if (it.alive) it.t = Math.min(it.t, 0.6);
    if (d.kind === 'wanted5' || d.kind === 'wanted3') this.state.hunting = true;
    if (d.blips?.length) this.setBlips(d.blips);
  }

  /* --------------------------------------------------------------- frame -- */

  resize(w, h, ctx) {
    this.vw = w;
    this.vh = h;
    this.k = clamp(h / 1080, 0.62, 2.4);
    this.root.style.setProperty('--k', this.k.toFixed(4));
    this.crosshair.setScale(this.k);
    this.radar.resize(this.k);
    this.weapon.resize(this.k);
    this.weaponWheel.resize(w, h);
    this.charWheel.resize(w, h);
    this.map.resize(w, h);

    if (this.touch) {
      // `isTouchDevice()` includes `innerWidth <= 760`, so dragging a desktop
      // window narrow brings the controls up and widening it puts them away.
      // Re-tested on every resize rather than once at boot for that reason.
      this.touch.setActive(isTouchDevice());
      // The modals' help lines name the controls this platform actually has.
      this.map.setTouch(this.touch.active);
      this.phone.setTouch(this.touch.active);
      this.touch.resize(w, h);
      // The radar dock and the weapon chip have to clear the joystick and the
      // button cluster, whose size is --tkg.
      this.root.style.setProperty('--tkg', this.touch.tk.toFixed(3));
      setClass(this.root, 'ow-touch', this.touch.active);
      setClass(this.root, 'ow-touch-land', this.touch.active && w > h);
    }
  }

  dispose() {
    // Hand the pointer-lock decision back to `input`'s own default. Leaving a
    // closed-over `isPaused` on a torn-down `ui` would answer every future lock
    // request against a dead arbiter.
    if (this.ctx?.input && this.ctx.input.pointerLockGuard) {
      this.ctx.input.pointerLockGuard = null;
    }
    for (const off of this._unsubs) off();
    this._unsubs.length = 0;
    this.crosshair.dispose();
    this.hit.dispose();
    this.arcs.dispose();
    this.health.dispose();
    this.markers.dispose();
    this.radar.dispose();
    this.vitalArcs.dispose();
    this.zoneFlourish.dispose();
    this.money.dispose();
    this.respect.dispose();
    this.vehm.dispose();
    this.story.dispose();
    this.ending.dispose();
    this.stars.dispose();
    this.clock.dispose();
    this.objective.dispose();
    this.weapon.dispose();
    this.feed.dispose();
    this.radio.dispose();
    this.subs.dispose();
    this.title.dispose();
    this.prompt.dispose();
    this.banner.dispose();
    this.bigCard.dispose();
    this.map.dispose();
    this.phone.dispose();
    this.menu.dispose();
    // Two window-level listeners and a live pause claim. Disposing the panel
    // clears `open`, which is what `_syncPause` reads — so a subsystem torn
    // down with the cheat menu up cannot leave a frozen clock behind it.
    this.cheats?.dispose();
    this.cheats = null;
    // One owner, one hand-back: whatever was still claiming the clock, the
    // scale goes back to what free play was running at. A subsystem torn down
    // with a modal up cannot leave a frozen world behind it.
    this.pause.release();
    // Before the root goes: the bridge holds virtual keys down and has replaced
    // two properties on `input.stick`. Both have to be handed back.
    this.touch.dispose();
    this.root.remove();
    removeStyles();
  }
}

export const DEBUG_STATES = [
  'clean', 'combat', 'wanted3', 'wanted5', 'mission', 'map', 'wheel', 'switch',
  'radio', 'phone', 'passed', 'wasted', 'busted', 'menu',
];
