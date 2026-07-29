/**
 * GAME — mission flow, objectives, economy, save/load, spawn director.
 *
 * This is the system that turns the sandbox into a game. It owns:
 *
 *   - character switching between Carson, Aidan and Dylan (`characters.js`),
 *     driven by the `ui:character` event the switch wheel already emits;
 *   - the 24 story chapters and the twelve mission track types they use
 *     (`mission.js` + `tracks.js` + `boss.js`);
 *   - cash and respect (`economy.js`), the sole emitter of `money:change`;
 *   - free-roam content — hidden packages, shops, gas, safehouses, the three
 *     race circuits (`freeroam.js`);
 *   - save/load to localStorage (`save.js`);
 *   - the spawn director: time of day, where the player starts, what each
 *     brother is doing when you switch to him (`director.js`);
 *   - a provisional wanted level (`heat.js`) and provisional mission enemies
 *     (`hostiles.js`), both of which stand down the moment `police` and `peds`
 *     grow the APIs they are missing. Each file says so at the top.
 *
 * It publishes `getHudState()` because that is how `ui` reads a subsystem —
 * `ui/index.js` polls `game.getHudState().money` and `.objective` every frame.
 *
 * KEYS this system owns (nothing else in the repo binds them):
 *   J  start the next chapter / accept the job
 *   K  abandon the current chapter
 *   U  cycle brother (the wheel is `ui`'s; this is the keyboard shortcut)
 *
 * EVERY ONE OF THEM IS GATED ON `ui.isPaused()`. `time.scale` going to zero
 * does NOT stop this system reading input: the engine calls `update(t.dt)` on
 * every subsystem every frame however slow the clock is, and an input EDGE is
 * delivered at full rate regardless. So a hotkey added here without the gate
 * fires from behind the pause menu — which is how K used to abandon a chapter
 * while the player was looking at the settings, silently. See `_paused` and
 * `src/ui/pausearbiterprobe.mjs`.
 */

import * as THREE from 'three';
import { BOYZ, BOY_ORDER, DIFFS, RACE_TRACKS, HIDDEN_PACKAGES } from './data.js';
import {
  load as loadSave, write as writeSave, blankSave, SaveWriter,
  serialiseSave, exportFilename, importSave, wipeAll,
} from './save.js';
import { Economy, money } from './economy.js';
import { WorldQuery } from './util.js';
import { Heat } from './heat.js';
import { HostilePool } from './hostiles.js';
import { PickupPool } from './pickups.js';
import { MissionRunner, toScene } from './mission.js';
import { FreeRoam } from './freeroam.js';
import { Director } from './director.js';
import { Characters } from './characters.js';
import { JobBoard } from './jobs.js';

export class GameSystem {
  static id = 'game';
  /**
   * These are *update-order* dependencies as much as construction ones, and the
   * distinction matters here: the registry topo-sorts `deps` and uses that one
   * order for both. Mission progress has to run after everything that produces
   * the state it tests — this frame's ped kills, the current wanted level, a
   * vehicle that just got destroyed. Read them a frame early and the last goon
   * in a chapter dies without the objective ticking over.
   *
   * That ordering used to hold only because `GameSystem` happened to be the
   * last import in `main.js` (the sort walks registration order, so a system
   * with no unmet deps lands where it was registered). Moving one import line
   * would have silently reintroduced the lag. Declaring what we actually reach
   * for makes the sort enforce it. None of these depend on `game`, so there is
   * no cycle — `resolve()` throws if that ever stops being true.
   */
  static deps = ['world', 'player', 'peds', 'police', 'vehicles', 'weapons', 'traffic'];

  constructor() {
    /** Mutated in place — `ui` polls this every frame, so it must not allocate. */
    this._hud = { money: 0, objective: null, respect: 0, character: 'carson', chapter: 0, wanted: 0, ward: null, storyDone: false };
    this._roster = [];
    this._mapPoints = [];
    this._pendingChapter = -1;
    this._deathCd = 0;
    this._playtime = 0;
    /** True while a SCRIPTED board is in flight — suppresses the theft roll. */
    this._boarding = false;
    this._clearBoarding = 0;
    /** Death mid-chapter: the chapter restarts itself after the WASTED card. */
    this._restartIdx = -1;
    this._restartT = 0;
  }

  /* ---- the world's content, readable without importing `data.js` -------- */

  get safehouses() { return this.freeroam?.safehouses ?? null; }
  get shops() { return this.freeroam?.shops ?? null; }
  get gasStations() { return this.freeroam?.gasStations ?? null; }
  get raceTracks() { return this.freeroam?.raceTracks ?? null; }
  get hiddenPackages() { return this.freeroam?.packages ?? null; }
  get crew() { return this.freeroam?.crew ?? EMPTY_ARRAY; }

  /* ==================================================================== */
  /* THE ONE CONTEXTUAL ACTION — the API `ui` renders                     */
  /* ==================================================================== */

  /**
   * What `F` (or the touch action button) does RIGHT NOW.
   *
   * CONTROLS.md: one control is wired to one function whose label rewrites
   * itself by context. This is that, resolved every frame in `freeroam.js`.
   * The record is PREALLOCATED and mutated in place, so read it, do not
   * retain it.
   *
   *   id         'enter' | 'commandeer' | 'swap' | 'exit' | 'sleep' | 'ammo'
   *              | 'food' | 'respray' | 'race' | 'none'
   *   short      one word for a touch button: ENTER TAKE SWAP EXIT SLEEP BUY
   *              EAT PAINT START
   *   label      the full line: 'COMMANDEER THE PRECINCT CRUISER'
   *   sub        context, usually the place name
   *   key        the keycap to draw, 'F'
   *   available  false when there is nothing to do
   *   target     the vehicle handle or POI it refers to
   */
  getAction() {
    return this.freeroam?.act ?? IDLE_ACTION;
  }

  /** One word for a touch button. Always a string. */
  get actionLabel() {
    const a = this.getAction();
    return a.available ? a.short : '';
  }

  /**
   * The automatic service the player is standing/parked in — the body-shop
   * ring, the pumps, a respray in progress. No button; this is a status line,
   * not an offer. Null when there is none.
   */
  getStatus() {
    return this.freeroam?._statusOn ? this.freeroam.status : null;
  }

  /**
   * Perform the contextual action. This is the touch button's entry point and
   * the only path `F` takes.
   * @returns {string|null} the id performed
   */
  doAction() {
    return this.freeroam?.doAction() ?? null;
  }

  /* ==================================================================== */
  /* init                                                                 */
  /* ==================================================================== */

  async init(ctx) {
    this.ctx = ctx;
    this.rng = ctx.rng.fork();
    this.enabled = true;

    const loaded = loadSave();
    this.save = loaded.save;
    this.saveSource = loaded.source;
    this.writer = new SaveWriter(0.6);

    this.wq = new WorldQuery(ctx).init();
    this.economy = new Economy(ctx, this.save);
    this.heat = new Heat(ctx, ctx.config.q).init();
    this.hostiles = new HostilePool(ctx, this.wq).init();
    this.pickups = new PickupPool(ctx, this.wq).init();
    this.director = new Director(ctx, this.wq).init(this.save);

    this.missions = new MissionRunner(ctx, {
      wq: this.wq,
      economy: this.economy,
      heat: this.heat,
      hostiles: this.hostiles,
      pickups: this.pickups,
      save: this.save,
    });

    this.freeroam = new FreeRoam(ctx, {
      wq: this.wq,
      economy: this.economy,
      heat: this.heat,
      pickups: this.pickups,
      missions: this.missions,
      save: this.save,
    });

    this.jobs = new JobBoard(ctx, {
      wq: this.wq,
      economy: this.economy,
      missions: this.missions,
      save: this.save,
    });

    this.characters = new Characters(ctx, {
      wq: this.wq,
      economy: this.economy,
      heat: this.heat,
      director: this.director,
      save: this.save,
    }).init();

    this.freeroam.boy = this.characters.boy;
    this.jobs.boy = this.characters.boy;
    this.missions.boy = this.characters.boy;
    this.missions.boyId = this.characters.activeId;
    this.missions.difficulty = this.save.difficulty ?? 'normal';

    /* ---- cross-wiring ---------------------------------------------------- */

    this.freeroam.onSave = (force) => (force ? this.writer.now(this.save) : this.writer.touch());
    this.characters.onSwitched = (id) => this._onSwitched(id);
    this.heat.onBusted = () => this.busted();
    this.missions.onEnd = (M, won) => this._onMissionEnd(M, won);

    this.pickups.onCollect = (p) => {
      if (p.kind === 'package') this.freeroam.collectPackage(p.id);
      else if (p.kind === 'health') this.wq.player?.heal?.(35);
      else if (p.kind === 'crate') this.wq.ui?.notify?.('Crate secured', null, 'gold');
    };

    this.hostiles.onKill = (h) => {
      this.save.totals.kills++;
      // Kill-goal tracks (protect) count their own dead through the runner.
      this.missions.noteKill(h);
      // A body on the street is a crime, and peds panic on `wanted:heat`.
      if (!this.missions.running) this.heat.raise(1, this.wq.playerPos().x, this.wq.playerPos().z);
      this.heat.heat(this.wq.playerPos().x, this.wq.playerPos().z, 55);
    };

    this._offs = [
      ctx.events.on('player:death', () => this.wasted()),
      ctx.events.on('vehicle:destroyed', (e) => {
        if (e?.vehicle?.isMission) this.save.totals.crashes++;
      }),
      // GRAND THEFT AUTO. There are two ways into a car — this system's 4.2 m
      // "Take the ..." prompt and `player`'s own 3.4 m one — so the theft is
      // priced off the EVENT rather than inside either enter path. That also
      // means a vehicle swap at speed is charged exactly like a carjack on
      // foot, which it is.
      ctx.events.on('vehicle:enter', (e) => {
        if (!e?.vehicle) return;
        if (e.actor && e.actor !== this.wq.player) return;
        this.freeroam.boardCrew(e.vehicle);
        if (this._boarding) return;
        this.save.totals.jacked = (this.save.totals.jacked ?? 0) + 1;
        this.freeroam.reportTheft(e.vehicle);
      }),
      ctx.events.on('vehicle:exit', (e) => {
        if (e?.actor && e.actor !== this.wq.player) return;
        this.freeroam.unboardCrew(e?.vehicle ?? null);
      }),
      ctx.events.on('game:unlock', (u) => {
        this.wq.ui?.notify?.('Unlocked', String(u.label ?? '').toUpperCase(), 'gold');
      }),
      // Critic hook. `src/dev/shots.js` carries no `game` entry, but it emits
      // `shot:applied { name, shot }` and inline JSON shots pass through
      // arbitrary keys — so a reviewer can stage any mission state from the
      // command line without editing shots.js:
      //
      //   node tools/capture.mjs --out=shots/boss.png \
      //     --shot='{"pos":[-744,24,-88],"look":[-744,4,-260],"fov":60,
      //              "time":18.4,"ground":true,"game":"boss"}'
      //
      // Stage names are listed by `debugStage('?')`.
      ctx.events.on('shot:applied', (e) => {
        const stage = e?.shot?.game;
        if (typeof stage !== 'string') return;
        this.debugStage(stage, e.shot.gameOpts ?? {});
        this._followPlayer(e.shot);
      }),
      // The map pin is the player's. A mission borrows it and hands it back.
      ctx.events.on('ui:waypoint', (w) => {
        if (this.missions.running) return;
        this.missions.userWaypoint = w && Number.isFinite(w.x) ? { x: w.x, z: w.z } : null;
        this.save.waypoint = this.missions.userWaypoint;
        this.writer.touch();
      }),
    ];

    /* ---- open the world -------------------------------------------------- */

    this.director.openWorld(this.save);
    // The opening spawn gets the same post-streaming re-check as every other.
    this.director.armUnstick?.(10);
    this.characters.restore(this.characters.activeId);
    this.freeroam.seedPackages();
    if (this.save.waypoint) {
      this.missions.userWaypoint = this.save.waypoint;
      this.wq.ui?.setWaypoint?.(this.save.waypoint);
    }
    this._syncHud(1);
    this._announceNext();

    console.info(
      `[game] Steel City — save "${this.saveSource}", ${this.characters.boy.name}, ` +
      `chapter ${this.economy.char().chapter + 1}/8, ${money(this.economy.cash)}, ` +
      `${this.economy.respect} respect, ${this.save.packages.length}/12 packages` +
      (this.heat.authoritative ? ', wanted level owned by `game` (police is a stub)' : '')
    );
    return this;
  }

  /** Compile the enemy and pickup materials before the first frame. */
  async prewarmMaterials(ctx = this.ctx) {
    await this.hostiles.prewarmMaterials(ctx);
    await this.pickups.prewarmMaterials(ctx);
  }

  /* ==================================================================== */
  /* the HUD contract                                                     */
  /* ==================================================================== */

  /**
   * `ui/index.js` `_pullState` reads `.money` and `.objective` off this every
   * frame. The object is preallocated and mutated in place.
   */
  getHudState() {
    return this._hud;
  }

  get money() { return this._hud.money; }
  get respect() { return this._hud.respect; }
  get cash() { return this.economy.cash; }
  get character() { return this.characters.activeId; }
  get wanted() { return this.heat.wanted; }

  _syncHud(forceDelta = 0) {
    const h = this._hud;
    const prev = h.money;
    h.money = this.economy.cash;
    h.respect = this.economy.respect;
    h.character = this.characters.activeId;
    h.chapter = this.economy.char().chapter;
    h.wanted = this.heat.wanted;
    h.objective = this.missions.hudObjective();
    /** `{ name, health 0..1 }` while a protect chapter is live, else null. */
    h.ward = this.missions.hudWard();
    h.storyDone = this.economy.char().chapter >= this.characters.boy.story.length;
    if (prev !== h.money) {
      this.wq.ui?.setMoney?.(h.money, h.money - prev);
    } else if (forceDelta) {
      // Show the balance without inventing a transaction. `ui` hides the money
      // readout unless it just moved (GTA does the same), and `hold` is that
      // timer — a fake `+$1` delta to make it appear would be a lie on screen.
      const ui = this.wq.ui;
      ui?.setMoney?.(h.money, 0);
      if (ui?.money) ui.money.hold = 3.4;
    }
  }

  /* ==================================================================== */
  /* chapters                                                             */
  /* ==================================================================== */

  /** The chapter this brother is up to, or null when his arc is finished. */
  nextChapter(id = this.characters.activeId) {
    const c = this.economy.char(id);
    const boy = BOYZ[id];
    if (c.chapter >= boy.story.length) return null;
    return { index: c.chapter, def: boy.story[c.chapter] };
  }

  _announceNext() {
    const n = this.nextChapter();
    const ui = this.wq.ui;
    if (!n) {
      // The arc is over; the city is not. Point him at the job board rather
      // than at nothing — an empty map after the credits is the thing
      // GAMEPLAY.md calls out as the difference between our build and one with
      // a game in it.
      ui?.notify?.(`${this.characters.boy.name.toUpperCase()}'S STORY`, 'COMPLETE', 'gold');
      const j = this.jobs.best();
      if (j) ui?.notify?.(j.name.toUpperCase(), `SIDE JOB · PRESS J · ${money(j.pay)}`, 'slag');
      this._pendingChapter = -1;
      return;
    }
    ui?.notify?.(`${n.def.no} · ${n.def.name.toUpperCase()}`, 'PRESS J', 'slag');
    this._pendingChapter = n.index;
  }

  /**
   * Every point the map should pin: the free-roam furniture plus the three
   * standing side jobs.
   */
  mapPoints(out = this._mapPoints) {
    this.freeroam.mapPoints(out);
    this.jobs.mapPoints(out);
    return out;
  }

  /** The three standing side-job offers. `ui`'s phone / job list reads this. */
  jobBoard() {
    return this.jobs.list();
  }

  /** Accept a side job by id, or the nearest one. */
  takeJob(id) {
    return this.jobs.start(id);
  }

  /**
   * Begin a chapter. With no argument it starts whatever the active brother is
   * up to, which is what the J key and the phone prompt both mean.
   */
  startMission(index = this._pendingChapter) {
    if (this.missions.active) return null;
    const boy = this.characters.boy;
    const i = index >= 0 ? index : this.economy.char().chapter;
    // Story finished, or an index nobody wrote: take a job off the board
    // instead of doing nothing. `J` means "give me the next thing to do",
    // and after the credits the next thing is side work.
    if (!boy.story[i]) return this.jobs.start();
    this.missions.boy = boy;
    this.missions.boyId = boy.id;
    // Free roam is not a mission; anything the world spawned for it goes.
    this.pickups.clearMission();
    return this.missions.start(boy, i);
  }

  /** Older name for `startMission`, kept for existing callers. */
  startChapter(index) {
    return this.startMission(index);
  }

  /**
   * The mission-overview backend — everything a chapter list needs to render:
   * status per chapter
   * (done / current / locked), teaser, reward, best time, and whether the row
   * is playable. Completed chapters are replayable; a replay can never regress
   * the frontier (`win` uses `Math.max`). Called from menus, not per frame.
   */
  getStoryOverview(id = this.characters.activeId) {
    const boy = BOYZ[id];
    if (!boy) return null;
    const cs = this.economy.char(id);
    const total = boy.story.length;
    const frontier = Math.min(cs.chapter, total);
    const storyDone = cs.chapter >= total;
    const chapters = boy.story.map((c, i) => {
      const status = i < frontier ? 'done' : i === frontier && !storyDone ? 'current' : 'locked';
      return {
        index: i,
        no: c.no,
        name: c.name,
        teaser: c.teaser ?? '',
        zone: c.zone ?? '',
        track: c.track,
        reward: c.cash ?? 0,
        respect: c.respect ?? 0,
        status,
        playable: status !== 'locked',
        best: cs.best[`${id}:${i}`] ?? null,
      };
    });
    return {
      boy: id,
      name: boy.name,
      title: `${boy.name.toUpperCase()}'S STORY`,
      storyDone,
      summary: storyDone
        ? 'Story complete — the city is yours. Replay any chapter, or free-roam forever.'
        : `${frontier} of ${total} chapters complete`,
      chapters,
      pending: this._pendingChapter,
    };
  }

  /**
   * Pick a chapter from the overview — the next one or any completed one for
   * a replay. It arms `_pendingChapter`, which is what `J`, the phone prompt
   * and a no-argument `startMission()` all honour, so a pick made on a menu
   * before play starts is exactly what boots into. Locked chapters refuse.
   */
  selectChapter(index, id) {
    if (id && id !== this.characters.activeId && !this.switchTo(id)) return null;
    if (this.missions.active) return null;
    const boy = this.characters.boy;
    const i = Math.floor(index);
    const frontier = Math.min(this.economy.char().chapter, boy.story.length);
    const c = boy.story[i];
    if (!c || i > frontier) return null;
    this._pendingChapter = i;
    this.wq.ui?.notify?.(`${c.no} · ${c.name.toUpperCase()}`,
      i < frontier ? 'REPLAY · PRESS J' : 'PRESS J', 'slag');
    return { index: i, def: c };
  }

  /**
   * `easy` | `normal` | `hard` | `steel`, from `DIFFS`. Scales incoming
   * damage, enemy health, and every mission clock. Takes effect on the next
   * chapter — changing it mid-job would move the goalposts under the player.
   */
  setDifficulty(id) {
    if (!DIFFS[id]) return this.save.difficulty;
    this.save.difficulty = id;
    this.missions.difficulty = id;
    this.writer.touch();
    this.wq.ui?.notify?.('Difficulty', DIFFS[id].label.toUpperCase(), 'slag');
    return id;
  }

  get difficulty() {
    return this.save.difficulty ?? 'normal';
  }

  abortMission() {
    if (!this.missions.active) return false;
    const M = this.missions.M;
    if (M.state === 'run') this.missions.fail(M, 'You walked away from the job');
    else this.missions.abort();
    return true;
  }

  _onMissionEnd(M, won) {
    this._syncHud();
    this.writer.now(this.save);
    if (won) this._announceNext();
    else if (!M.side) {
      this.wq.ui?.notify?.(`${M.def.no} FAILED`, 'PRESS J TO RETRY', 'bad');
      this._pendingChapter = M.idx;
    }
  }

  /* ==================================================================== */
  /* characters                                                           */
  /* ==================================================================== */

  /** Switch active DeCarlo brother. */
  switchTo(id) {
    if (this.missions.running) {
      this.wq.ui?.notify?.('Not during a job', null, 'bad');
      return false;
    }
    return this.characters.switchTo(id);
  }

  _onSwitched(id) {
    this.freeroam.boy = this.characters.boy;
    this.jobs.boy = this.characters.boy;
    this.jobs.refresh(true);
    this.missions.boy = this.characters.boy;
    this.missions.boyId = id;
    this.pickups.clearMission();
    this.freeroam.seedPackages();
    this._syncHud(1);
    this._announceNext();
    this.writer.now(this.save);
  }

  /** Every brother's headline state — for a switch wheel or a pause menu. */
  roster() {
    return this.characters.roster(this._roster);
  }

  /* ==================================================================== */
  /* death and arrest                                                     */
  /* ==================================================================== */

  /**
   * Death or arrest mid-STORY-chapter restarts the chapter, it does not
   * abort it: zero the wanted level, dispose the pursuit, respawn, restart the
   * chapter — and the WASTED/HAULED IN overlay itself promises "The chapter
   * will restart."
   * Side jobs stay a plain fail: free-roam work is disposable, the story is
   * not. The actual restart runs a beat later (`RESTART_DELAY` in `_update`)
   * so the result card can breathe before the title card replaces it.
   */
  wasted() {
    if (this._deathCd > 0) return;
    this._deathCd = 3;
    const c = this.economy.char();
    c.deaths++;
    const lost = Math.floor(this.economy.cash * 0.1);
    if (lost > 0) this.economy.addCash(-lost, 'hospital');
    // Wanted is zeroed and the pursuit disposed on EVERY death — `heat`
    // emits `wanted:change 0` and purges its pursuit; when `police` owns the
    // level the same call routes through `police.clearWanted`.
    this.heat.clear('wasted');
    this._deathEnd('wasted', 'You were killed', lost, 'WASTED');
  }

  busted() {
    if (this._deathCd > 0) return;
    this._deathCd = 3;
    const c = this.economy.char();
    c.busts++;
    const lost = Math.floor(this.economy.cash * 0.15);
    if (lost > 0) this.economy.addCash(-lost, 'bail');
    this.heat.clear('busted');
    this._deathEnd('busted', 'Busted — hauled in by the cops', lost, 'BUSTED');
  }

  _deathEnd(kind, why, lost, label) {
    const M = this.missions.M;
    const storyLive = !!M && !M.side && M.state === 'run';
    if (storyLive) {
      // No fail card, no `mission:fail` — the chapter is coming back. The
      // death overlay carries the promise instead.
      this._restartIdx = M.idx;
      this._restartT = RESTART_DELAY;
      this.missions.abort();
      this.wq.ui?.card?.(kind, why, EMPTY_ARRAY);
      this._respawn(lost, label, true);
    } else {
      this.missions.abortWith(kind, why);
      this._respawn(lost, label, false);
    }
    this.writer.now(this.save);
  }

  _respawn(lost, label, restarting = false) {
    const c = this.economy.char();
    const id = c.safehouse ?? this.characters.boy.home;
    const sh = this.wq.poi(id) ?? this.wq.nearestSafehouse(0, 0).poi;
    const p = this.wq.player;
    if (p?.inVehicle) p.vehicles?.abort?.(p.movement);
    // Through the director, not a random bearing off the POI: Carson's
    // safehouse IS a boathouse, so "8 m in a random direction" respawned a
    // wasted player straight back into the Monongahela.
    const spot = this.director.groundPose(sh.x, sh.z);
    this.wq.placePlayer(spot.x, spot.z, spot.yaw, spot.y ?? null);
    this.director.armUnstick?.();
    if (p?.health) {
      p.health.reset(false);
      p.health.value = Math.max(p.health.value, (p.health.max ?? 100) * 0.55);
      p.health.armour = 0;
    }
    this.hostiles.clear();
    const line = lost > 0 ? `They took ${money(lost)}` : 'They let you off';
    this.wq.ui?.titleCard?.(label, sh.name, restarting ? `${line} · The chapter restarts` : line);
    this._syncHud(1);
  }

  /* ==================================================================== */
  /* frame                                                                */
  /* ==================================================================== */

  /**
   * IT MUST REFUSE TO BREAK.
   *
   * GAMEPLAY.md §6: the whole simulation is wrapped in a try/catch that logs
   * ONCE and keeps rendering. A thrown exception in a
   * mission track is a bug to fix, but it must never take the frame loop —
   * and therefore the whole screen — down with it while the player is mid-job.
   * The engine calls every subsystem's `update` in one loop, so an unhandled
   * throw here also skips `ui`, `audio` and anything else after us.
   */
  update(dt, ctx) {
    if (!this.enabled) return;
    try {
      this._update(dt, ctx);
    } catch (e) {
      if (!this._simErr) {
        this._simErr = true;
        console.error('[game] sim error — the loop keeps running, fix this:', e);
        this.wq.ui?.notify?.('Something broke', 'PRESS K THEN J TO RESTART', 'bad');
      }
    }
  }

  _update(dt, ctx) {
    this._playtime += dt;
    // A spawn is only verifiable once the city around it has streamed in — see
    // `Director.unstick`. Cheap: a no-op the moment it has settled.
    this.director?.tickUnstick?.(dt);
    this.save.totals.playtime = Math.round(this._playtime);
    if (this._deathCd > 0) this._deathCd -= dt;
    if (this._clearBoarding > 0 && (this._clearBoarding -= dt) <= 0) this._boarding = false;

    // The promised chapter restart after WASTED / BUSTED.
    if (this._restartT > 0) {
      this._restartT -= dt;
      if (this._restartT <= 0 && this._restartIdx >= 0 && !this.missions.active) {
        const idx = this._restartIdx;
        this._restartIdx = -1;
        this.startMission(idx);
        this._syncHud(1);
      }
    }

    const pos = this.wq.playerPos();
    const alive = !(this.wq.player?.dead);
    const v = this.wq.playerVehicle();

    /**
     * A STOPPED WORLD TAKES NO ORDERS.
     *
     * `ui` owns `ctx.time.scale` and publishes `isPaused()` — one predicate,
     * true while any modal has the world at a standstill. Reached through
     * `ctx.peek`, never an import (ARCHITECTURE.md rule 2).
     *
     * Everything above runs with `dt === 0` while paused, which makes it a
     * no-op by arithmetic. The two things below are NOT: they read input
     * EDGES, which the engine keeps delivering at full rate however slow the
     * clock is. Measured on the shipped build, with the pause menu up and
     * `time.scale: 0` throughout — U switched brother, J consumed the
     * chapter's intro cutscene, and K ABANDONED THE CHAPTER outright, with no
     * confirmation and nothing on screen to show it had happened. The player
     * closed the menu as a different brother, somewhere else, with no mission.
     */
    const paused = this._paused(ctx);

    this.heat.update(dt, this.wq);
    this.hostiles.update(dt, pos, alive);
    // A pickup you can grab from a moving car. GAMEPLAY.md §5: the collect
    // radius grows from 2.2 m on foot to 3.5 m in a vehicle, and that one
    // number is most of why driving the map is worth doing.
    this.pickups.update(dt, pos.x, pos.y, pos.z, v ? PICKUP_DRIVE_BOOST : 1);
    this.missions.update(dt);
    // `freeroam` acts on the F edge inside its own update (`_usePressed`), so
    // not calling it IS the gate — carjacking a parked car from behind the
    // pause menu is the same defect as abandoning a chapter from behind it.
    if (!paused) this.freeroam.update(dt);
    this.jobs.update(dt);
    if (!paused) this._input(ctx);
    this._syncHud();
    this.writer.update(dt, this.save);

    // Track how far the family has driven — a stat the result cards and the
    // pause menu can use, and cheap to keep honest.
    if (v) this.save.totals.distance += Math.abs(v.forwardSpeed ?? 0) * dt;
  }

  /**
   * Recover from ANY state — dead, busted, wrecked, halfway through a failed
   * job — and put the player back at the start of the chapter he was on.
   * GAMEPLAY.md §6: this is what makes a broken run recoverable without a page
   * reload, and `K` then `J` is the same two steps by hand.
   */
  restartCurrentMission() {
    const idx = this.missions.M?.idx ?? this._pendingChapter;
    const p = this.wq.player;
    this._restartT = 0;
    this._restartIdx = -1;
    this.missions.abort();
    this.hostiles.clear();
    this.pickups.clearMission();
    this.heat.clear('restart');
    if (p?.inVehicle) p.vehicles?.abort?.(p.movement);
    if (p?.health) {
      p.health.reset?.(false);
      p.health.value = p.health.max ?? 100;
      if (p.health.dead) p.health.dead = false;
    }
    this._deathCd = 0;
    this._simErr = false;
    const M = this.startMission(idx >= 0 ? idx : 0);
    this._syncHud(1);
    return M;
  }

  /**
   * Is a UI modal holding the world still? The single arbiter in `src/ui/` is
   * the authority — `ui.isPaused()` is a pure read of which pause claims are
   * live, so `game` never has to know that the map, the phone, the story
   * overview, the cheat panel, a result card and the pause menu are six
   * different objects.
   *
   * Duck-typed and failure-tolerant on purpose: `ui` is optional (headless
   * benches boot without it) and a HUD that throws must never cost the frame.
   * No `ui` means nothing is paused, which is the correct answer for a build
   * that has no menus to pause with.
   */
  _paused(ctx) {
    try {
      const ui = ctx.peek('ui');
      return typeof ui?.isPaused === 'function' && ui.isPaused() === true;
    } catch {
      return false;
    }
  }

  _input(ctx) {
    const input = ctx.input;
    if (!input?.enabled || input.frozen) return;
    // Belt and braces: `_update` gates the call, and this refuses again in case
    // a future caller reaches `_input` by another path.
    if (this._paused(ctx)) return;
    if (input.pressed?.('KeyJ')) {
      if (this.missions.active && this.missions.M.phase === 'intro') this.missions.skipIntro();
      else if (!this.missions.active) this.startMission();
    }
    if (input.pressed?.('KeyK')) this.abortMission();
    if (input.pressed?.('KeyU')) this.characters.cycle(1);
  }

  /* ==================================================================== */
  /* save                                                                 */
  /* ==================================================================== */

  saveNow() {
    this.characters.capture();
    this.save.clock = this.director.hour;
    return this.writer.now(this.save);
  }

  /** Round-trip the whole game state without touching the disk — for tests. */
  snapshot() {
    this.characters.capture();
    this.save.clock = this.director.hour;
    return JSON.parse(JSON.stringify(this.save));
  }

  /**
   * ADOPT A DIFFERENT SAVE OBJECT AND REBUILD THE LIVE GAME FROM IT.
   *
   * `newGame`, `importDossier` and `wipeSave` all land here, so there is
   * exactly ONE list of the things that hold a save reference. The previous
   * version of that list lived inline in `newGame` and had five of the six
   * entries — MEASURED on the shipped build, right after `game.newGame()`:
   *
   *   economy true · missions true · freeroam true · characters true
   *   jobs  FALSE
   *
   * so the side-job board kept reading the DEAD object: `_storyDone()` and
   * `_suggest()` take the chapter frontier and the active brother off
   * `jobs.save`, and `_endLite` writes `totals.missions` into it. A fresh save
   * therefore still offered post-credits side work, and every side job
   * completed afterwards was counted into an object nothing would ever
   * persist. An imported dossier would have inherited the identical bug.
   *
   * @param {object} save     the new save object — already normalised
   * @param {string} activeId which brother to wake up as
   */
  _adoptSave(save, activeId = save.active) {
    this.save = save;
    this.economy.save = save;
    this.missions.save = save;
    this.freeroam.save = save;
    this.characters.save = save;
    this.jobs.save = save;
    // `missions.difficulty` is a COPY taken once in init(), not a live read of
    // `save.difficulty`. Without this line an imported STEEL dossier scales
    // nothing — same class of bug as the stale `jobs.save` above.
    this.missions.difficulty = save.difficulty ?? 'normal';

    // Nothing from the previous save may outlive it.
    this._restartT = 0;
    this._restartIdx = -1;
    this._pendingChapter = -1;
    this._deathCd = 0;
    this._simErr = false;
    this.missions.abort();
    this.pickups.clear();
    this.hostiles.clear();
    this.heat.clear('adopt');

    this.director.openWorld(save);

    /**
     * `characters.restore` pushes the new brother at `ui.setCharacter`, which
     * emits `ui:character` — and `Characters` LISTENS to that event and calls
     * `switchTo` on it. Inside a real switch `characters.switching` is already
     * true and the re-entry is refused; a bare `restore()` has no such cover.
     * So a dossier whose active brother differs from the live one would
     * re-enter `switchTo` -> `capture(outgoing)` and overwrite the record we
     * had just imported with the live player's position, health and wanted
     * level. Borrow the class's own re-entrancy flag rather than inventing a
     * second one.
     */
    const wasSwitching = this.characters.switching;
    this.characters.switching = true;
    try {
      this.characters.restore(BOY_ORDER.includes(activeId) ? activeId : save.active);
    } finally {
      this.characters.switching = wasSwitching;
    }

    this.freeroam.boy = this.characters.boy;
    this.jobs.boy = this.characters.boy;
    this.jobs.refresh(true);
    this.missions.boy = this.characters.boy;
    this.missions.boyId = this.characters.activeId;
    this.freeroam.seedPackages();
    // `freeroam` restores the saved station ONCE, on its first frame. This is a
    // different save with its own station; let that fire again.
    this.freeroam._radioRestored = false;

    // The map pin travels with the save — `init()` restores it the same way.
    this.missions.userWaypoint = save.waypoint ? { x: save.waypoint.x, z: save.waypoint.z } : null;
    this.wq.ui?.setWaypoint?.(this.missions.userWaypoint);

    this._syncHud(1);
    // Re-arms `_pendingChapter`. Without it `J` starts whatever index the
    // PREVIOUS save was up to: `startMission()` defaults to `_pendingChapter`,
    // and a stale 5 against an imported chapter 0 is five chapters skipped.
    this._announceNext();
    return save;
  }

  newGame() {
    this._adoptSave(blankSave(), BOY_ORDER[0]);
    writeSave(this.save);
    return this.save;
  }

  /* ==================================================================== */
  /* the dossier — hand the player his progress as a file, and take it back */
  /* ==================================================================== */

  /**
   * THE SAVE, AS A FILE.
   *
   * Captures the live brother into his record first — the thing on screen is
   * part of the save and a dossier exported without it is a dossier of the
   * last autosave, not of now — then hands `ui` the bytes and a filename. No
   * DOM here: the Blob, the anchor and the click belong to `src/ui/menu.js`.
   *
   * @returns {{text: string, filename: string}}
   */
  exportDossier() {
    this.characters.capture();
    this.save.clock = this.director.hour;
    return { text: serialiseSave(this.save), filename: exportFilename() };
  }

  /**
   * READ A DOSSIER BACK.
   *
   * `importSave` validates, normalises through the same `normalise()` the boot
   * path runs, and persists — an accepted import is on disk before this
   * returns. A REFUSED one leaves both storage and the live game completely
   * untouched, which is the whole point: picking the wrong file out of your
   * downloads folder must not cost you the save you already had.
   *
   * @param {string|object} text file contents (or an already-parsed object)
   * @returns {{ok:boolean, save:object|null, stored:boolean, error:string}}
   */
  importDossier(text) {
    const r = importSave(text);
    if (!r.ok) return r;
    this._adoptSave(r.save);
    // The debounced writer may still be holding a dirty flag from the save we
    // just replaced. It would write the NEW object, so nothing is lost — but
    // the import already persisted synchronously and there is nothing pending.
    this.writer.dirty = false;
    this.writer.pending = 0;
    return r;
  }

  /**
   * ERASE ALL PROGRESS FOR ALL THREE BROTHERS.
   *
   * Order matters and is the opposite of the obvious one. `newGame()` ends in
   * `writeSave()`, so wiping FIRST and reseting second leaves a freshly written
   * blank save sitting in the slot the player was just told had been erased —
   * `load()` reports `source: 'v2'` on the next boot instead of `'new'`.
   * Reset first, then erase every key `load()` can read, then stand the writer
   * down so it does not immediately put one back.
   *
   * @returns {boolean} false only when storage itself is unreachable.
   */
  wipeSave() {
    this.newGame();
    const ok = wipeAll();
    this.writer.dirty = false;
    this.writer.pending = 0;
    return ok;
  }

  /* ==================================================================== */
  /* debug — for the critic harness and tools/capture.mjs                 */
  /* ==================================================================== */

  /**
   * Force the game into a reviewable state. Mirrors `ui.debugState`,
   * `police.debugStage` and `vehicles.debugPose`.
   *
   * Names:
   *   'clean'     free roam, no objective, no heat
   *   'chapter'   the active brother's next chapter, past the cutscene
   *   'race'      the Triangle circuit mid-lap
   *   'firefight' a goons wave live around the player
   *   'boss'      the active brother's rival, in his arena
   *   'wanted:N'  N stars and the pursuit that goes with them
   *   'passed' | 'failed' | 'wasted' | 'busted'  the result card
   *   'packages'  every hidden package placed and marked
   *   'carson' | 'aidan' | 'dylan'  switch to that brother
   */
  debugStage(name = 'chapter', opts = {}) {
    const ui = this.wq.ui;
    if (BOY_ORDER.includes(name)) {
      this.characters.switchTo(name);
      return { stage: name, character: name };
    }
    if (name.startsWith('wanted')) {
      const n = Number(name.split(':')[1] ?? 3);
      this.missions.abort();
      this.heat.clear();
      this.heat.raise(n, this.wq.playerPos().x, this.wq.playerPos().z);
      return { stage: name, wanted: this.heat.wanted };
    }
    switch (name) {
      case 'clean':
        this.missions.abort();
        this.heat.clear();
        this.hostiles.clear();
        ui?.clearObjective?.();
        ui?.clearPrompt?.();
        return { stage: 'clean' };

      case 'chapter': {
        // Always from a clean slate: `startMission` refuses while one is live,
        // so a second stage in the same session would silently do nothing.
        this.missions.abort();
        const n = this.nextChapter() ?? { index: 0 };
        const M = this.startMission(opts.index ?? n.index);
        this.missions.forceBegin();
        return { stage: 'chapter', mission: M?.id, track: M?.track };
      }

      case 'race': {
        this.missions.abort();
        const M = this.freeroam.startRace(opts.track ?? 'triangle');
        this.missions.forceBegin();
        if (M) { M.cpIdx = 1; M.timer = 90; }
        return { stage: 'race', mission: M?.id };
      }

      case 'firefight': {
        this.missions.abort();
        const p = this.wq.playerPos();
        this.hostiles.clear();
        for (let i = 0; i < (opts.count ?? 6); i++) {
          const s = this.wq.findGroundSpot(18, 55, p.x, p.z);
          this.hostiles.spawn(s.x, s.z, { hp: 80, ranged: i % 2 === 0, dmg: 9, leash: 90 });
        }
        ui?.setObjective?.({ eyebrow: 'Combat', text: 'Take them down', count: `0 / ${opts.count ?? 6}`, progress: 0 });
        return { stage: 'firefight', hostiles: this.hostiles.aliveCount };
      }

      case 'boss': {
        this.missions.abort();
        const boy = this.characters.boy;
        const i = boy.story.findIndex((c) => c.track === 'boss' && c.bossId === RIVAL[boy.id]);
        const M = this.startMission(i < 0 ? boy.story.length - 1 : i);
        this.missions.forceBegin();
        return { stage: 'boss', mission: M?.id, boss: M?.def?.bossId };
      }

      case 'ending': {
        // The finale, staged at its home ring — one arrival from the slides.
        this.missions.abort();
        const boy = this.characters.boy;
        const i = boy.story.findIndex((c) => c.track === 'final');
        const M = this.startMission(i < 0 ? boy.story.length - 1 : i);
        this.missions.forceBegin();
        return { stage: 'ending', mission: M?.id, dest: M?.dest?.name };
      }

      case 'packages': {
        this.save.packages.length = 0;
        this.pickups.clear();
        this.freeroam.seedPackages();
        return { stage: 'packages', count: HIDDEN_PACKAGES.length };
      }

      case 'passed':
        ui?.card?.('passed', 'SLACKWATER', [
          { value: money(1450), label: 'Payout' },
          { value: money(750), label: 'Time bonus' },
          { value: '+20', label: 'Respect' },
        ]);
        return { stage: 'passed' };

      case 'failed':
      case 'wasted':
      case 'busted':
        ui?.card?.(name, name === 'busted' ? 'Hauled in by the cops' : 'The vehicle was wrecked', []);
        return { stage: name };

      default:
        return { stage: 'unknown', available: STAGES };
    }
  }

  /**
   * Put the player into a specific vehicle through `player`'s own enter
   * transition. A test seam, not gameplay: the harness needs to board a boat
   * moored off a bank, and walking a headless player onto a hull is not
   * something a script can do reliably.
   *
   * `player.vehicles._scan` sets `candidate` from `vehicles.nearest()` and
   * `tryEnter` consumes it; this does the same two steps by hand after putting
   * the player on the seat, so everything downstream — the animation phases,
   * `vehicle:enter`, the camera handover — runs exactly as it does in play.
   */
  debugBoard(v) {
    const p = this.wq.player;
    if (!p?.vehicles || !v) return false;
    // `tryEnter` only fires from `PHASE.none`, so a player still sitting in the
    // last chapter's car silently refuses to board this one's. Get out first.
    if (p.inVehicle) p.vehicles.abort(p.movement);
    const anchor = this.wq.vehicles?.seatAnchor?.(v, 0);
    const at = anchor?.enter ?? anchor?.position ?? v.position;
    this.wq.placePlayer(at.x, at.z, p.yaw ?? 0, at.y);
    p.vehicles.candidate = v;
    // A scripted board is not a carjack. Without this the harness picks up a
    // star every time it puts the player in a test car, and the wanted-level
    // assertions two steps later fail for reasons that have nothing to do with
    // what they are testing.
    this._boarding = true;
    try {
      return p.vehicles.tryEnter(p.movement);
    } finally {
      // The `vehicle:enter` event lands at the END of the entry animation, not
      // here, so the flag has to survive the transition rather than the call.
      this._clearBoarding = 1.6;
    }
  }

  /**
   * A staged mission usually TELEPORTS the player — a boss fight happens in
   * its arena, not wherever the shot's camera happened to be pointing. The
   * shot froze player control, so the camera would otherwise stay behind
   * photographing an empty street two kilometres from the fight.
   *
   * Re-frame it over the shoulder, honouring the shot's own `fov`/`dist` if it
   * gave one. Only when the player actually moved; a stage that leaves him
   * alone must not steal the reviewer's framing.
   */
  _followPlayer(shot) {
    const cam = this.ctx.camera;
    const p = this.wq.playerPos();
    if (cam.position.distanceTo(p) < 60) return;
    const dist = shot?.gameDist ?? 9;
    const height = shot?.gameHeight ?? 3.4;
    const yaw = shot?.gameYaw ?? this.wq.player?.yaw ?? 0;
    cam.position.set(p.x - Math.sin(yaw) * dist, p.y + height, p.z - Math.cos(yaw) * dist);
    this._look ??= new THREE.Vector3();
    this._look.set(p.x, p.y + 1.3, p.z);
    cam.lookAt(this._look);
    cam.updateMatrixWorld();
  }

  /** Diagnostics for the dev overlay and the playtest harness. */
  get stats() {
    const M = this.missions.M;
    return {
      character: this.characters.activeId,
      chapter: this.economy.char().chapter,
      cash: this.economy.cash,
      respect: this.economy.respect,
      familyRespect: this.economy.familyRespect,
      packages: this.save.packages.length,
      wanted: this.heat.wanted,
      wantedOwner: this.heat.authoritative ? 'game' : 'police',
      cops: this.heat.cops.length,
      hostiles: this.hostiles.aliveCount,
      pickups: this.pickups.live.length,
      mission: M ? { id: M.id, track: M.track, phase: M.phase, state: M.state, timer: +M.timer.toFixed(1), progress: M.progress, goal: M.goal } : null,
      unlocks: this.save.unlocks.slice(),
      writes: this.writer.writes,
    };
  }

  dispose() {
    for (const off of this._offs ?? []) off();
    this.saveNow();
    this.missions?.dispose?.();
    this.characters?.dispose();
    this.freeroam?.dispose();
    this.director?.dispose();
    this.heat?.dispose();
    this.hostiles?.dispose();
    this.pickups?.dispose();
  }
}

const RIVAL = { carson: 'harbormaster', aidan: 'duke', dylan: 'viper' };

const EMPTY_ARRAY = Object.freeze([]);

/** Read by `ui` before `game.init` has built the resolver. */
const IDLE_ACTION = Object.freeze({
  id: 'none', short: '', label: '', sub: '', key: 'F', available: false, target: null,
});

/** Collect radius multiplier while driving — 2.2 m -> 3.5 m. */
const PICKUP_DRIVE_BOOST = 1.6;

/** Seconds the WASTED/BUSTED card breathes before the chapter restarts. */
const RESTART_DELAY = 2.6;

const STAGES = [
  'clean', 'chapter', 'race', 'firefight', 'boss', 'ending', 'packages',
  'wanted:1', 'wanted:3', 'wanted:5',
  'passed', 'failed', 'wasted', 'busted',
  'carson', 'aidan', 'dylan',
];

export { DIFFS, RACE_TRACKS, BOYZ, toScene };
