/**
 * GAME — the mission runner.
 *
 * Owns the lifecycle of one chapter: title card, intro cutscene, the live
 * objective, the fail conditions, the payout, the outro cutscene and the
 * result card. Track types (`tracks.js`, `boss.js`) implement the *rules*; this
 * implements everything they have in common, and it is the only thing that
 * spawns, so nothing a track creates can survive the mission that created it.
 *
 * PHASES
 *   'intro'  the title card is up and the CUTSCENE has the screen: the world
 *            is stopped dead (see `Cutscene` in `src/ui/mission.js`), nothing
 *            is spawned and no clock is ticking. The scene calls back when it
 *            ends; a raw-clock watchdog is the only thing that runs here,
 *            because scaled `dt` is zero for the whole phase.
 *   'travel' the chapter is staged somewhere specific and you are not there
 *            yet. Objective: get to the zone. Nothing is spawned, no clock.
 *   'run'    the track's `update` drives.
 *   'outro'  won: the `done` lines play FIRST, as a second cutscene; the result
 *            card comes up when the scene ends. Headless, with no `ui` to run a
 *            scene, the authored timing (`done.length * 2400` ms) stands in for
 *            it, so the choreography is identical either way. A `final`
 *            chapter's outro leads into `ending:play` instead.
 *   'over'   terminal; the game system drops the record.
 *
 * The travel phase is not decoration — it is the fix for a real bug. Chapters
 * name their turf (`at: 'dock_north'`, `at: 'lm_mill'`), and a `chase` staged
 * at Carson's boathouse while Carson is a kilometre up the Ohio spawned its
 * target 800 m away and failed on the first frame with "the target got away".
 * GTA V's answer is the one used here: you accept the job, you drive to it,
 * and the mission proper starts when you arrive.
 *
 * The three outcomes map onto `ui.card()`'s four kinds:
 *   passed / failed (a track fail) / wasted (player died) / busted (police).
 */

import * as THREE from 'three';
import {
  TRACK_LABEL, defaultObjective, DIFFS, RACE_TRACKS, WEAPON_LIB, BOYZ, SPEAKERS, MARK_GREEN,
} from './data.js';
import { TRACKS } from './tracks.js';
import { bossTrack } from './boss.js';
import { clamp01, dist } from './util.js';
import { money } from './economy.js';

TRACKS.boss = bossTrack;

/** Extra cash per second left on a mission clock. */
const TIME_BONUS = 6;

/** Marked cars a mission may glow at once (`recover` uses three). */
const VEH_GLOWS = 4;
/** Ward / partner NPC pool — a chapter never needs more than one of each. */
const FIGURES = 2;

/**
 * How close counts as "you are at the job". Generous, because the POI is the
 * neighbourhood the chapter is about, not a parking space — and because the
 * tracks themselves stage their content 40-400 m out from it.
 */
const TRAVEL_ARRIVE = 120;

/**
 * How long a dialogue phase may last in UNSCALED seconds before the runner
 * takes the screen back.
 *
 * It has to be unscaled. A cutscene stops the clock, so `dt` is ZERO for the
 * whole of `intro` and the whole of a won `outro` — a watchdog counted in
 * scaled seconds would never reach its limit, which is the opposite of what a
 * watchdog is for. `ctx.time.raw` is wall clock and nothing touches it.
 *
 * 26 s fits the content: the longest authored scene is five lines, and a
 * five-line scene runs ~24 s at the caption bar's typing and hold rates. It is
 * a wedge detector, not a pacing control — the scene ends itself long before
 * this on every real chapter.
 */
const SCENE_WATCHDOG = 26;

let _missionSeq = 1;

export class MissionRunner {
  constructor(ctx, deps) {
    this.ctx = ctx;
    this.wq = deps.wq;
    this.economy = deps.economy;
    this.heat = deps.heat;
    this.hostiles = deps.hostiles;
    this.pickups = deps.pickups;
    this.save = deps.save;
    this.rng = ctx.rng.fork();

    this.M = null;
    this.boy = null;
    this.boyId = 'carson';
    this.px = 0;
    this.pz = 0;
    this.difficulty = 'normal';

    this._input = { throttle: 0, brake: 0, steer: 0, handbrake: false, boost: false };
    this._anchorV = new THREE.Vector3();
    this._v = new THREE.Vector3();
    this._markerPool = [];
    for (let i = 0; i < 6; i++) {
      this._markerPool.push({ position: new THREE.Vector3(), label: '', name: '' });
    }
    this._markers = [];
    this._objective = { eyebrow: '', text: '', timer: null, count: '', progress: -1 };
    this._startPayload = { id: '', chapter: '', name: '', zone: '', track: '' };
    this._endPayload = { id: '', name: '', cash: 0, respect: 0, reason: '' };
    this._rewards = [];
    /** Lazy pools: the glowing ground ring + marked-vehicle glows, ward NPCs. */
    this._glow = null;
    this._figures = null;
    this._ringOn = false;
    this._ringR = 0;
    this._hudWard = { name: '', health: 1 };
    this._impact = null; // repair-spark payload, allocated on first use
    /** Set by the game system so a fail can offer a retry. */
    this.onEnd = null;
    /** The player's own map pin, stashed by the game system from `ui:waypoint`. */
    this.userWaypoint = null;
  }

  get diff() {
    return DIFFS[this.difficulty] ?? DIFFS.normal;
  }

  get active() {
    return !!this.M && this.M.phase !== 'over';
  }

  get running() {
    return !!this.M && this.M.phase === 'run';
  }

  /* ==================================================================== */
  /* start                                                                */
  /* ==================================================================== */

  start(boy, chapterIndex) {
    const c = boy.story[chapterIndex];
    if (!c) return null;
    return this._start(boy, c, chapterIndex, `${boy.id}:${chapterIndex}`, false);
  }

  /**
   * A side activity — a standalone race circuit, say — run through the exact
   * same machinery as a story chapter so it gets the objective panel, the
   * checkpoint markers, the timer, the payout and the result card for free.
   * `idx` is -1, which is what keeps it out of chapter progression.
   */
  startCustom(boy, def, id) {
    return this._start(boy, def, -1, id, true);
  }

  _start(boy, c, chapterIndex, id, side) {
    this.abort();
    this.boy = boy;
    this.boyId = boy.id;

    const M = {
      id,
      side,
      seq: _missionSeq++,
      idx: chapterIndex,
      def: c,
      track: c.track,
      phase: 'intro',
      state: 'run',
      t: 0,
      introT: 0,
      outroT: 0,
      timer: c.baseTimer ? c.baseTimer * (this.diff.timerMul ?? this.diff.time) : 0,
      hasTimer: !!c.baseTimer,
      goal: c.goal ?? 1,
      progress: 0,
      lap: 0,
      laps: c.laps ?? 1,
      cpIdx: 0,
      reason: '',
      cash: 0,
      bonus: 0,
      elapsed: 0,
      // per-track scratch, allocated once here so tracks never allocate
      spawnedVehicles: [],
      spawnedHostiles: [],
      spawnedPickups: [],
      rivals: [],
      arena: { x: 0, z: 0, r: 0 },
      hold: { x: 0, z: 0 },
      _anchor: { x: 0, z: 0 },
      veh: null,
      dest: null,
      target: null,
      ally: null,
      bossVeh: null,
      bossEnt: null,
      B: null,
      markerCount: 0,
      /** Kills of THIS mission's hostiles — fed by `noteKill`, read by protect. */
      kills: 0,
      /** The protect chapter's named brother, from `spawnWard`. */
      ward: null,
      /** Sub-phase counter for tracks with a mid-mission flip (partner). */
      step: 0,
      /** Partner repair fill, 0..100. */
      repair: 0,
      /** The boss's post-death escape phase (raise heat, win at zero stars). */
      escapeOn: false,
      escapeGrace: 0,
      /** How long the result card waits for the `done` dialogue beats. */
      doneHold: 1.2,
      /**
       * Unscaled wall clock at the start of the current dialogue phase. The
       * cutscene holds `time.scale` at zero, so this is the ONLY clock that
       * moves during one. See SCENE_WATCHDOG.
       */
      sceneRaw: this.ctx.time.raw,
      /** Set by the outro scene's callback; read on the next `update`. */
      sceneDone: false,
      /**
       * Where the chapter is staged, if it names a place. Drives 'travel'.
       * A race stages at its own start line even though the chapter names no
       * POI — you drive to the grid, you do not materialise on it.
       */
      startPoi: this.wq.poi(c.at ?? c.from ?? '') ?? startLineOf(c),
    };
    this.M = M;

    const ui = this.wq.ui;
    ui?.titleCard?.(c.no, c.name, c.zone);
    const intro = toScene(c.intro, boy);
    // If no scene took the screen — headless bench, a chapter with no intro —
    // the caption bar is the fallback and the phase poll below times it out.
    if (!this._playScene(M, intro, `${boy.name} · ${c.no}`)) ui?.playScene?.(intro);
    this._objective.eyebrow = TRACK_LABEL[c.track] ?? 'Chapter';
    this._objective.text = c.teaser ?? defaultObjective(c);
    this._objective.timer = null;
    this._objective.count = '';
    this._objective.progress = -1;

    const p = this._startPayload;
    p.id = M.id;
    p.chapter = c.no;
    p.name = c.name;
    p.zone = c.zone;
    p.track = c.track;
    p.lines = intro;
    this.ctx.events.emit('mission:start', p);
    this.wq.uiSfx('regen', 0.8);
    return M;
  }

  /* ==================================================================== */
  /* the cutscene                                                         */
  /* ==================================================================== */

  /** The live scene player, or null on a build with no `ui`. */
  _scene() {
    return this.wq.ui?.subs?.cut ?? null;
  }

  /**
   * Hand a scene to `ui`'s cutscene player and stop the world.
   *
   * `game` resolves the SPEAKER here rather than in `ui`, for two reasons.
   * `src/game/data.js` owns `SPEAKERS` and the brothers' rival names, and `ui`
   * may not import across the subsystem boundary (ARCHITECTURE.md rule 2) — so
   * a second copy over there would be two owners of one fact, which rule 12
   * calls out by name. And the `boss` speaker is not a speaker at all: it
   * prints the rival of the brother you are CURRENTLY PLAYING, which only this
   * side knows.
   *
   * @returns {boolean} true if the cutscene took the screen.
   */
  _playScene(M, lines, context) {
    const cut = this._scene();
    if (!cut?.play) return false;
    M.sceneRaw = this.ctx.time.raw;
    const f = this.wq.focusPos(this._v);
    return cut.play(lines, {
      ctx: this.ctx,
      ui: this.wq.ui,
      context,
      focusX: f.x,
      focusZ: f.z,
      focusY: this.wq.groundY(f.x, f.z),
      onDone: () => this._sceneEnded(M),
    }) === true;
  }

  /**
   * The scene finished on its own, or the player skipped it.
   *
   * IT RAISES A FLAG AND NOTHING ELSE. This runs inside `ui.lateUpdate` — the
   * cutscene is driven from there, on unscaled time — and both of the things it
   * would otherwise do reach a long way out of the HUD's frame phase: the intro
   * hand-over SPAWNS the chapter's vehicles, hostiles and pickups (and a track
   * whose `init` fails raises the result card on the spot), and the outro runs
   * the payout, the card and `onEnd`, which can start the next chapter and
   * re-enter the very cutscene that is finishing.
   *
   * `update` reads the flag on the next `game.update`, which is where every
   * other phase transition in this file has always happened.
   */
  _sceneEnded(M) {
    if (this.M !== M || M.phase === 'over') return;
    M.sceneDone = true;
  }

  /** Take any live scene down without its callback. */
  _cancelScene() {
    this._scene()?.cancel?.();
  }

  /**
   * Has this dialogue phase outstayed its welcome? UNSCALED seconds — see
   * SCENE_WATCHDOG for why a scaled clock cannot answer this question.
   */
  _sceneOverran(M) {
    return this.ctx.time.raw - M.sceneRaw > SCENE_WATCHDOG;
  }

  /** Skip the cutscene. The travel leg still has to be driven. */
  skipIntro() {
    const M = this.M;
    if (M?.phase !== 'intro') return;
    // `skipAll` -> `finish` -> `_sceneEnded` -> `_afterIntro`. Going straight
    // to `_afterIntro` instead would leave the scene holding the clock and the
    // keyboard with nothing on screen to explain why.
    const cut = this._scene();
    if (cut?.active) cut.skipAll();
    else this._afterIntro(M);
  }

  /**
   * Force the mission into its running state, teleporting to the staging POI
   * if the travel leg has not been driven. Debug/harness only — in play, you
   * drive there.
   */
  forceBegin() {
    const M = this.M;
    if (!M) return false;
    if (M.phase === 'intro') this._afterIntro(M);
    if (M.phase === 'travel') {
      const p = M.startPoi;
      if (p) this.wq.placePlayer(p.x + 6, p.z + 6, 0);
      this._begin(M);
    }
    return M.phase === 'run';
  }

  /**
   * The cutscene is over. Either the chapter is staged where the player is
   * standing, or he has to get there first.
   */
  _afterIntro(M) {
    // Idempotent, and it has to be: `forceBegin` (the harness door) calls this
    // directly while a scene is still up, and `skipIntro` reaches it through
    // the scene's own callback. Whichever way in, the cut hands the clock, the
    // keyboard and the camera back exactly once.
    this._cancelScene();
    M.sceneDone = false;
    const poi = M.startPoi;
    if (!poi) return this._begin(M);
    const p = this.wq.focusPos(this._v);
    if (dist(p.x, p.z, poi.x, poi.z) <= TRAVEL_ARRIVE) return this._begin(M);
    M.phase = 'travel';
    M.state = 'run';
    this.objective(M, `Get to ${M.def.zone}`, null, '', -1, 'Travel');
  }

  _begin(M) {
    M.phase = 'run';
    M.state = 'run';
    const t = TRACKS[M.track];
    if (!t) {
      this.fail(M, `Unimplemented track "${M.track}"`);
      return;
    }
    // `survive` overrides the timer inside init; everything else uses baseTimer.
    t.init(M, M.def, this);
    if (M.state !== 'run') return; // init already failed the mission
    this.objective(M, defaultObjective(M.def), M.hasTimer ? M.timer : null, '', -1);
  }

  /* ==================================================================== */
  /* frame                                                                */
  /* ==================================================================== */

  update(dt) {
    const M = this.M;
    if (!M || M.phase === 'over') return;
    const focus = this.wq.focusPos(this._v);
    this.px = focus.x;
    this.pz = focus.z;

    if (M.phase === 'intro') {
      M.introT += dt;
      // THE SCENE OWNS THIS PHASE. It runs on unscaled time inside
      // `ui.lateUpdate` and calls `_sceneEnded` when it is over, so there is
      // nothing to poll — only a wall-clock wedge detector, because `dt` here
      // is exactly zero for the whole phase.
      const cut = this._scene();
      if (cut?.active) {
        if (this._sceneOverran(M)) cut.skipAll();
        return;
      }
      if (M.sceneDone) { this._afterIntro(M); return; }
      const subs = this.wq.ui?.subs;
      const talking = subs ? subs.active : M.introT < 4;
      // A hard floor of 0.6 s so a headless harness with no UI still shows the
      // title card a beat before gameplay, and a ceiling so a missing UI can
      // never wedge the mission in its own cutscene.
      if ((!talking && M.introT > 0.6) || this._sceneOverran(M)) this._afterIntro(M);
      return;
    }

    if (M.phase === 'travel') {
      const poi = M.startPoi;
      const d = dist(this.px, this.pz, poi.x, poi.z);
      this._markers.length = 0;
      M.markerCount = 0;
      this._ringOn = false;
      this.marker(M, 0, poi.x, poi.z, poi.name, 'M', 22);
      this.objective(M, `Get to ${M.def.zone}`, null, `${Math.round(d)} m`, -1, 'Travel');
      this._publishMarkers();
      this._updateGlows(M, dt);
      if (d <= TRAVEL_ARRIVE) this._begin(M);
      return;
    }

    if (M.phase === 'outro') {
      M.outroT += dt;
      // The `done` scene plays and the result card is its callback. The scene
      // is the clock, so the card comes up the moment the last line clears —
      // never over the top of the brothers still talking, which is the bug the
      // old timer delayed past.
      const cut = this._scene();
      if (cut?.active) {
        if (this._sceneOverran(M)) cut.skipAll();
        return;
      }
      if (M.sceneDone) { this._finish(M); return; }
      // No scene took the screen (headless, or an outro with no `done` lines).
      // The authored timing — `done.length * 2400 + 400` ms — stands in.
      const talking = !!(this.wq.ui?.subs?.active);
      if (talking) M._sawTalk = true;
      const need = M._sawTalk ? 0.8 : (M.doneHold ?? 1.2);
      if (M.outroT > need && !talking) this._finish(M);
      return;
    }

    // ---- running ---------------------------------------------------------
    M.t += dt;
    M.elapsed += dt;
    if (M.hasTimer) {
      M.timer = Math.max(0, M.timer - dt);
      this._objective.timer = M.timer;
    }
    this._markers.length = 0;
    M.markerCount = 0;
    this._ringOn = false;

    const t = TRACKS[M.track];
    t?.update?.(M, dt, this);

    if (M.state === 'run') {
      this._publishMarkers();
      this._updateGlows(M, dt);
      this._updateFigures(dt);
    }
  }

  /* ==================================================================== */
  /* the track-facing API                                                 */
  /* ==================================================================== */

  /**
   * @param {number|null} timer  seconds remaining, or null for no clock. The
   *   HUD formats it — pass a NUMBER, not a string.
   */
  objective(M, text, timer = null, count = '', progress = -1, eyebrow = null) {
    const o = this._objective;
    o.eyebrow = eyebrow ?? TRACK_LABEL[M.def.track] ?? 'Chapter';
    o.text = text;
    o.timer = timer !== null ? timer : (M.hasTimer ? M.timer : null);
    o.count = count ?? '';
    o.progress = progress;
  }

  /**
   * World marker + radar blip, index-addressed so a track can hold two.
   *
   * `ui/markers.js` draws `label` inside a small diamond and `name` under it,
   * so `label` must be one or two glyphs — a whole destination name in there
   * renders as an unreadable smear.
   *
   * `ringR` (metres) additionally draws the in-world glowing ground ring at
   * this marker — GAMEPLAY.md §3's "one thing lit up". Only marker 0 may carry
   * it, so there is never more than one ring in the world, and the radius is
   * the track's own trigger radius so the ring tells the truth about where
   * "arrived" begins.
   */
  marker(M, i, x, z, name, label = null, ringR = 0) {
    const m = this._markerPool[i] ?? this._markerPool[0];
    m.position.set(x, this.wq.groundY(x, z) + 1.4, z);
    m.label = label ?? (name ? name[0].toUpperCase() : '');
    m.name = name;
    if (!this._markers.includes(m)) this._markers.push(m);
    M.markerCount = this._markers.length;
    if (i === 0 && ringR > 0) {
      this._ringOn = true;
      this._ringR = ringR;
      this._ensureGlow();
    }
  }

  /**
   * Arm a countdown on a track that authored none — the `timedStory` half of
   * the difficulty table. Base seconds come from `TIMED_STORY`, the scale from
   * `DIFFS.timerMul`.
   */
  armTimer(M, seconds) {
    M.timer = seconds * (this.diff.timerMul ?? this.diff.time ?? 1);
    M.hasTimer = true;
  }

  /**
   * The objective vehicle literally glows. Green means fetch it, amber means
   * fetch it on a clock. The glow is a mission-owned additive ring that tracks
   * the car: vehicle paint materials are POOLED by `vehicles`, so writing
   * `emissive` on one would light every car wearing that paint in the city.
   */
  markVehicle(M, v, color = MARK_GREEN) {
    if (!v) return;
    v._marked = color;
    this._ensureGlow();
  }

  unmarkVehicle(v) {
    if (v) v._marked = 0;
  }

  /** Step the player out of whatever he is driving, where it stands. */
  forceExit() {
    const p = this.wq.player;
    if (p?.inVehicle) p.vehicles?.abort?.(p.movement);
  }

  /**
   * A mission hostile died — called by the game system off `hostiles.onKill`.
   * `M.kills` is the honest counter for kill-goal tracks (`protect`): counting
   * dead handles in `spawnedHostiles` double-counts once the pool recycles one
   * into a later wave of the same mission.
   */
  noteKill(h) {
    const M = this.M;
    if (!M || M.state !== 'run' || !h) return;
    if (M.spawnedHostiles.includes(h)) M.kills++;
  }

  /**
   * The markers go to `ui.setObjectives`, which draws the world diamond AND
   * feeds the radar's `mission` blip in one call.
   *
   * The waypoint is separate and belongs to the PLAYER — he set it by clicking
   * the map. A mission may borrow it, but it has to give it back, and it must
   * not rewrite it every frame or the minimap needle jitters on a moving
   * target. `userWaypoint` is stashed by the game system from `ui:waypoint`.
   */
  _publishMarkers() {
    const ui = this.wq.ui;
    if (!ui?.setObjectives) return;
    ui.setObjectives(this._markers);
    const first = this._markers[0];
    if (!first) return;
    const w = this._wp ??= { x: 0, z: 0 };
    const dx = first.position.x - w.x;
    const dz = first.position.z - w.z;
    if (dx * dx + dz * dz < 400) return; // moved less than 20 m — leave it
    w.x = first.position.x;
    w.z = first.position.z;
    ui.setWaypoint?.(w);
  }

  notify(text, value, tone) {
    this.wq.ui?.notify?.(text, value ?? null, tone ?? 'slag');
  }

  say(who, text) {
    if (!text) return;
    this.wq.ui?.say?.(who, text);
  }

  shake(a) {
    this.wq.player?.addTrauma?.(a);
  }

  /* ------------------------------------------------------------- spawns -- */

  spawnVehicle(M, type, x, z, yaw, opts) {
    const v = this.wq.spawnVehicle(type, x, z, yaw, opts);
    if (v) {
      v.isMission = true;
      M.spawnedVehicles.push(v);
    }
    return v;
  }

  spawnHostile(M, x, z, opts) {
    const h = this.hostiles.spawn(x, z, opts);
    if (h) M.spawnedHostiles.push(h);
    return h;
  }

  spawnPickup(M, x, z, kind, opts) {
    const p = this.pickups.spawn(x, z, kind, opts);
    if (p) M.spawnedPickups.push(p);
    return p;
  }

  hostilesOf(M) {
    return M.spawnedHostiles;
  }

  vehiclesOf(M) {
    return M.spawnedVehicles;
  }

  aliveHostiles(M) {
    let n = 0;
    for (const h of M.spawnedHostiles) if (h.active && !h.dead) n++;
    return n;
  }

  nearestHostile(M) {
    let best = null;
    let bd = Infinity;
    for (const h of M.spawnedHostiles) {
      if (!h.active || h.dead) continue;
      const d = dist(h.position.x, h.position.z, this.px, this.pz);
      if (d < bd) { bd = d; best = h; }
    }
    return best;
  }

  /* -------------------------------------------------- the one glowing ring -- */

  /**
   * One flat additive ring for the destination, plus up to `VEH_GLOWS` smaller
   * ones that follow marked vehicles. `MeshBasicMaterial` on purpose: no
   * lighting, so it can never change the visible point-light count (see
   * ARCHITECTURE.md's shader-permutation section) and costs a handful of draw
   * calls only while a mission is live.
   */
  _ensureGlow() {
    if (this._glow) return this._glow;
    const geo = new THREE.RingGeometry(0.78, 1.0, 48);
    geo.rotateX(-Math.PI / 2);
    const mk = (hex, op) => new THREE.MeshBasicMaterial({
      color: hex, transparent: true, opacity: op,
      blending: THREE.AdditiveBlending, depthWrite: false, fog: false,
    });
    const group = new THREE.Group();
    group.name = 'game:mission-glow';
    const prep = (mesh) => {
      mesh.visible = false;
      mesh.renderOrder = 4;
      mesh.userData.owNoShadow = true;
      mesh.userData.owNoPrepass = true;
      group.add(mesh);
      return mesh;
    };
    const dest = prep(new THREE.Mesh(geo, mk(MARK_GREEN, 0.55)));
    const veh = [];
    for (let i = 0; i < VEH_GLOWS; i++) {
      const m = prep(new THREE.Mesh(geo, mk(MARK_GREEN, 0.5)));
      m.userData.hex = MARK_GREEN;
      veh.push(m);
    }
    this.ctx.scene.add(group);
    this._glow = { group, geo, dest, veh };
    return this._glow;
  }

  _updateGlows(M, dt) {
    void dt;
    const g = this._glow;
    if (!g) return;
    const t = this.ctx.time.elapsed;
    const pulse = 0.72 + 0.28 * Math.sin(t * 2.6);
    if (this._ringOn && this._markers.length) {
      const m0 = this._markers[0];
      g.dest.visible = true;
      g.dest.position.set(m0.position.x, m0.position.y - 1.28, m0.position.z);
      const r = this._ringR * (0.96 + 0.04 * Math.sin(t * 2.1));
      g.dest.scale.set(r, 1, r);
      g.dest.material.opacity = 0.34 + 0.2 * pulse;
    } else {
      g.dest.visible = false;
    }
    let n = 0;
    if (M) {
      for (const v of M.spawnedVehicles) {
        if (!v._marked || v.destroyed || n >= g.veh.length) continue;
        const ring = g.veh[n++];
        ring.visible = true;
        if (ring.userData.hex !== v._marked) {
          ring.material.color.setHex(v._marked);
          ring.userData.hex = v._marked;
        }
        ring.position.set(
          v.position.x,
          this.wq.groundY(v.position.x, v.position.z, v.position.y + 8) + 0.08,
          v.position.z
        );
        const s = 3.0 + 0.3 * Math.sin(t * 3.2 + n * 1.7);
        ring.scale.set(s, 1, s);
        ring.material.opacity = 0.3 + 0.24 * pulse;
      }
    }
    for (; n < g.veh.length; n++) g.veh[n].visible = false;
  }

  _hideGlows() {
    const g = this._glow;
    if (!g) return;
    g.dest.visible = false;
    for (const m of g.veh) m.visible = false;
  }

  /* ------------------------------------------------- ward / partner NPCs -- */

  /**
   * A named friendly figure standing in the world — the protect chapter's ward
   * (a brother, with HP the HUD shows) and the partner chapter's Gabby.
   * Deliberately the same blocky standard as `hostiles.js`: it is a stand-in
   * for a real `peds` character and should look like one so it gets replaced.
   */
  _ensureFigures() {
    if (this._figures) return this._figures;
    const mk = [];
    const skin = new THREE.MeshStandardMaterial({ color: 0xf2c9a0, roughness: 0.8, metalness: 0, name: 'game_figure_skin' });
    for (let i = 0; i < FIGURES; i++) {
      const group = new THREE.Group();
      group.name = `game:figure:${i}`;
      group.visible = false;
      const shirt = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.85, metalness: 0, name: `game_figure_shirt_${i}` });
      const ringMat = new THREE.MeshBasicMaterial({
        color: 0xffffff, transparent: true, opacity: 0.5,
        blending: THREE.AdditiveBlending, depthWrite: false, fog: false,
      });
      const torso = new THREE.Mesh(new THREE.CapsuleGeometry(0.24, 0.62, 4, 10), shirt);
      torso.position.y = 1.0;
      const head = new THREE.Mesh(new THREE.SphereGeometry(0.15, 12, 10), skin);
      head.position.y = 1.6;
      const ring = new THREE.Mesh(new THREE.RingGeometry(0.5, 0.62, 32), ringMat);
      ring.rotation.x = -Math.PI / 2;
      ring.position.y = 0.06;
      ring.userData.owNoShadow = true;
      ring.userData.owNoPrepass = true;
      group.add(torso, head, ring);
      this.ctx.scene.add(group);
      mk.push({
        active: false, id: '', name: '', x: 0, z: 0, yaw: 0,
        health: 1, maxHealth: 1, anim: i * 2.3,
        group, shirt, ringMat,
      });
    }
    // Same call `hostiles.js` makes: the shadow/AO chunks reach the figure on
    // its first frame instead of a frame late. Patch just the figure groups.
    const render = this.ctx.peek('render');
    for (const f of mk) render?.patchMaterials?.(f.group);
    this._figures = mk;
    this._figureSkin = skin;
    return mk;
  }

  /**
   * @returns a figure record `{ name, x, z, health, maxHealth }` or null.
   */
  spawnFigure(M, x, z, opts = {}) {
    const pool = this._ensureFigures();
    let f = null;
    for (const p of pool) if (!p.active) { f = p; break; }
    if (!f) return null;
    f.active = true;
    f.id = opts.id ?? '';
    f.name = opts.name ?? 'Ally';
    f.maxHealth = f.health = opts.hp ?? 1;
    f.x = x;
    f.z = z;
    f.yaw = 0;
    f.shirt.color.setHex(opts.color ?? 0x9aa4b2);
    f.ringMat.color.setHex(opts.accent ?? opts.color ?? 0x7bf0d8);
    f.group.position.set(x, this.wq.groundY(x, z), z);
    f.group.visible = true;
    return f;
  }

  /**
   * The protect chapter's brother, staged on the hold point with real HP.
   * `wardId` is a BOYZ id so he wears his own colours and his own name.
   *
   * ---------------------------------------------------------------------
   * HE IS THE BROTHER WHO IS ALREADY WALKING BESIDE YOU.
   * ---------------------------------------------------------------------
   * This used to spawn a blocky white stand-in and label it "Dylan" — while
   * `peds.crew` had the real, skinned, animated Dylan following the player
   * three metres away. Both were on screen at once, both were called Dylan,
   * and only the capsule had a health bar. `peds.setCrewWard()` was written
   * for exactly this and was never called from anywhere, which under
   * ARCHITECTURE.md rule 12 means the feature did not exist.
   *
   * So: pin the REAL companion, and keep the figure only as the fallback for
   * the cases where there is no companion to pin — the ward is the brother the
   * player is currently playing, or the crew has been despawned for a solo
   * chapter. `M.ward` keeps exactly the same shape either way (`name`, `x`,
   * `z`, `health`, `maxHealth`), so `tracks.js` and `hudWard()` are unchanged;
   * the crew-backed record uses live getters so it needs no per-frame sync.
   */
  spawnWard(M, x, z, wardId, hp = 320) {
    const boy = BOYZ[wardId];
    const peds = this.ctx.peek('peds');
    const m = peds?.crew?.byId?.(wardId);
    if (m && m.active && m.ped && peds.setCrewWard) {
      // `noRevive` is what makes the chapter losable, and pinning him to the
      // hold point is what makes it a siege rather than a chase.
      peds.setCrewWard(wardId, { noRevive: true, x, z, heal: true });
      const rec = this._crewWard ?? (this._crewWard = {
        crew: true, active: true, id: '', name: '', maxHealth: 1, _m: null, _peds: null,
        get x() { return this._m ? this._m.position.x : 0; },
        get z() { return this._m ? this._m.position.z : 0; },
        get health() { return this._m ? Math.max(0, this._m.up ? this._m.hp : 0) : 0; },
        /**
         * WRITE-THROUGH, and it has to exist. The old ward was a plain object
         * and callers assign to it — `playtest.mjs` stages the losable case
         * with a bare `M.ward.health = 6`. A getter with no setter swallows
         * that assignment in sloppy mode without a word, which is exactly how
         * the first version of this change turned a passing gate into a
         * mystery: the ward simply refused to be hurt.
         */
        set health(v) {
          if (!this._m) return;
          this._m.hp = Math.max(0, v);
          if (this._m.ped) this._m.ped.health = this._m.hp;
          if (this._m.hp <= 0 && this._m.up) this._peds?.downCrew?.(this._m.id);
        },
      });
      rec._peds = peds;
      rec.active = true;
      rec.id = wardId;
      rec.name = m.name;
      rec.maxHealth = m.maxHp;
      rec._m = m;
      M.ward = rec;
      return rec;
    }
    const f = this.spawnFigure(M, x, z, {
      id: wardId,
      name: boy?.name ?? wardId,
      color: boy ? parseInt(boy.body.shirt.slice(1), 16) : 0x9aa4b2,
      accent: boy ? parseInt(boy.accent.slice(1), 16) : 0x7bf0d8,
      hp,
    });
    M.ward = f;
    return f;
  }

  hurtWard(M, amount) {
    const w = M.ward;
    if (!w || amount <= 0) return;
    // A crew-backed ward takes it through the crew's own damage path, so the
    // flinch, the ragdoll, `crew:hurt` and `crew:down` all happen for real —
    // and going down is what fails the chapter, via `health <= 0` in `protect`.
    if (w.crew) {
      this.ctx.peek('peds')?.hurtCrew?.(w.id, amount);
      return;
    }
    w.health = Math.max(0, w.health - amount);
  }

  _updateFigures(dt) {
    const pool = this._figures;
    if (!pool) return;
    for (const f of pool) {
      if (!f.active) continue;
      f.anim += dt;
      // Face the player, breathe a little. He is standing his ground, not AI.
      const want = Math.atan2(this.px - f.x, this.pz - f.z);
      f.yaw += (want - f.yaw) * Math.min(1, dt * 3);
      f.group.rotation.y = f.yaw;
      f.group.position.y = this.wq.groundY(f.x, f.z) + Math.sin(f.anim * 1.8) * 0.02;
    }
  }

  _releaseFigures() {
    // A crew-backed ward is not in the figure pool; releasing him means giving
    // the brother his legs and his `revive` back, or he stays pinned on a hold
    // point with `noRevive` for the rest of the game.
    if (this._crewWard?.active) {
      this._crewWard.active = false;
      this._crewWard._m = null;
      const peds = this.ctx.peek('peds');
      peds?.clearCrewWard?.();
      peds?.setCrewGuard?.(this._crewWard.id, null);
    }
    const pool = this._figures;
    if (!pool) return;
    for (const f of pool) {
      f.active = false;
      f.group.visible = false;
    }
  }

  /** What `game.getHudState().ward` publishes — a `ui` agent renders it. */
  hudWard() {
    const M = this.M;
    const w = M?.ward;
    if (!M || !w || M.phase === 'over') return null;
    const h = this._hudWard;
    h.name = w.name;
    h.health = clamp01(w.health / w.maxHealth);
    return h;
  }

  /**
   * Repair-minigame feedback: a metal-surface impact through the canonical
   * `bullet:impact` event every ~0.45 s, which `fx` turns into sparks and
   * `audio` into a metallic tick — no new event, no new renderer.
   */
  repairFx(M, v) {
    M._fxT = (M._fxT ?? 0) - this.ctx.time.dt;
    if (M._fxT > 0) return;
    M._fxT = 0.45;
    const p = this._impact ??= {
      point: new THREE.Vector3(), normal: new THREE.Vector3(0, 1, 0),
      incident: new THREE.Vector3(0, -1, 0), surface: 'metal', damage: 6, exit: false,
    };
    p.point.set(
      v.position.x + this.rng.range(-0.7, 0.7),
      v.position.y + 0.55,
      v.position.z + this.rng.range(-0.7, 0.7)
    );
    this.ctx.events.emit('bullet:impact', p);
  }

  /* ------------------------------------------------------- player damage -- */

  hurtPlayer(amount, fromPos) {
    const p = this.wq.player;
    if (!p?.applyDamage) return;
    p.applyDamage(amount, fromPos ?? null, { type: 'melee' });
  }

  hurtPlayerIfNear(fromPos, range, amount) {
    const d = dist(fromPos.x, fromPos.z, this.px, this.pz);
    if (d > range) return;
    this.hurtPlayer(amount * (1 - d / range * 0.4), fromPos);
  }

  tracerAt(fromPos, height = 1.4) {
    const t = this._tracer ??= { from: new THREE.Vector3(), to: new THREE.Vector3(), speed: 420 };
    t.from.set(fromPos.x, fromPos.y + height, fromPos.z);
    const pp = this.wq.playerPos(this._anchorV);
    t.to.set(pp.x, pp.y + 1.1, pp.z);
    this.ctx.events.emit('bullet:tracer', t);
  }

  grenadeWarn(x, z) {
    const v = this._anchorV.set(x, this.wq.groundY(x, z) + 0.4, z);
    this.wq.ui?.spawnGrenade?.(v, 1.2);
  }

  explode(x, z, radius, damage) {
    const e = this._boom ??= { position: new THREE.Vector3(), radius: 8, damage: 60 };
    e.position.set(x, this.wq.groundY(x, z) + 0.7, z);
    e.radius = radius;
    e.damage = damage;
    this.ctx.events.emit('explosion', e);
  }

  /* ==================================================================== */
  /* outcomes                                                             */
  /* ==================================================================== */

  win(M) {
    if (M.state !== 'run') return;
    const c = M.def;
    if (c.track === 'final' && !M.side) return this._ending(M);
    M.state = 'won';
    M.phase = 'outro';
    M.outroT = 0;
    M.sceneDone = false;

    M.bonus = M.hasTimer ? Math.round(Math.max(0, M.timer) * TIME_BONUS) : 0;
    M.cash = c.cash + M.bonus;

    this.economy.addCash(M.cash, `chapter:${M.id}`);
    const crossed = this.economy.addRespect(c.respect, `chapter:${M.id}`);
    const cs = this.economy.char();
    if (!M.side) {
      cs.chapter = Math.max(cs.chapter, M.idx + 1);
      this.save.totals.missions++;
      const key = `${this.boyId}:${M.idx}`;
      if (M.hasTimer || M.track === 'race') {
        if (!(key in cs.best) || M.elapsed < cs.best[key]) cs.best[key] = +M.elapsed.toFixed(2);
      }
    } else if (M.def.trackId) {
      const prev = this.save.races[M.def.trackId];
      if (prev === undefined || M.elapsed < prev) {
        this.save.races[M.def.trackId] = +M.elapsed.toFixed(2);
        this.notify('New circuit record', `${M.elapsed.toFixed(1)}s`, 'gold');
      }
    }
    if (c.unlock) {
      if (this.economy.unlockWeapon(c.unlock)) {
        // The live system too — `economy` persists it, `weapons` carries it.
        this.wq.weapons?.giveWeapon?.(c.unlock);
        this.notify('Weapon unlocked', c.unlock.toUpperCase(), 'gold');
      }
    }
    for (const u of crossed) this.notify('Respect', u.label, 'gold');

    this._despawnHostiles(M);
    const done = toScene(c.done, this.boy);
    M.doneHold = 0.4 + done.length * 2.4;
    if (!this._playScene(M, done, 'Chapter complete')) this.wq.ui?.playScene?.(done);
    this.wq.uiSfx('kill', 1);
    // `mission:complete` is emitted from `_finish`, after the `done` beats —
    // `ui` raises the result card off that event, and raising it while the
    // brothers are still talking is the bug this delays past.
  }

  /**
   * The final chapter's homecoming: no result card, no payout — the ending
   * slides own the screen, the story-done flag is set, and every weapon in the
   * library unlocks. Emits
   * `ending:play { boy, name, slides }` for `ui` to render.
   */
  _ending(M) {
    M.state = 'won';
    M.phase = 'outro';
    M.outroT = 0;
    M.doneHold = 0.4;
    M.cash = 0;
    M.bonus = 0;

    const cs = this.economy.char();
    cs.chapter = Math.max(cs.chapter, M.idx + 1);
    // Derived truth: `chapter >= story.length` IS story-done (the save layer
    // clamps chapter to 0..8 and drops unknown keys on load, so the flag here
    // is a runtime convenience, not the persistence mechanism).
    cs.storyDone = cs.chapter >= this.boy.story.length;
    this.save.totals.missions++;

    // Story complete: the whole arsenal, once. Every weapon id unlocks here;
    // replaying the finale must not re-toast it.
    let gave = 0;
    for (const wid of Object.keys(WEAPON_LIB)) {
      if (this.economy.unlockWeapon(wid)) gave++;
      this.wq.weapons?.giveWeapon?.(wid);
    }
    if (gave > 0) {
      const u = this._unlockAll ??= { kind: 'weapons', id: 'all', label: 'Every tool in the box' };
      this.ctx.events.emit('game:unlock', u);
    }

    this._despawnHostiles(M);
    this.heat.clear('ending');
    this.wq.uiSfx('kill', 1);
    this.notify(`${this.boy.name.toUpperCase()}'S STORY`, 'COMPLETE', 'gold');

    const e = this._endingPayload ??= { boy: '', name: '', slides: EMPTY, storyDone: true };
    e.boy = this.boyId;
    e.name = this.boy.name;
    e.slides = this.boy.ending ?? EMPTY;
    this.ctx.events.emit('ending:play', e);
  }

  fail(M, why, kind = 'failed') {
    if (!M || M.state !== 'run') return;
    M.state = 'lost';
    M.reason = why;
    M.failKind = kind;
    const p = this._endPayload;
    p.id = M.id;
    p.name = M.def.name;
    p.cash = 0;
    p.respect = 0;
    p.reason = why;
    this.ctx.events.emit('mission:fail', p);
    this.wq.uiSfx('damage', 0.9);
    this._finish(M);
  }

  /** The player died / was arrested while a chapter was live. */
  abortWith(kind, why) {
    const M = this.M;
    if (!M || M.state !== 'run') return;
    this.fail(M, why, kind);
  }

  _finish(M) {
    const ui = this.wq.ui;
    const won = M.state === 'won';
    const finale = won && M.def.track === 'final' && !M.side;
    this._rewards.length = 0;
    if (finale) {
      // The ending slides own the screen — no JOB DONE card, no
      // `mission:complete`. `ending:play` already went out.
    } else if (won) {
      const p = this._endPayload;
      p.id = M.id;
      p.name = M.def.name;
      p.cash = M.cash;
      p.respect = M.def.respect;
      p.reason = '';
      this.ctx.events.emit('mission:complete', p);
      this._rewards.push({ value: money(M.cash), label: 'Payout' });
      if (M.bonus > 0) this._rewards.push({ value: money(M.bonus), label: 'Time bonus' });
      this._rewards.push({ value: `+${M.def.respect}`, label: 'Respect' });
      ui?.card?.('passed', M.def.name, this._rewards);
    } else {
      ui?.card?.(M.failKind ?? 'failed', M.reason || M.def.name, this._rewards);
    }
    this.cleanup();
    M.phase = 'over';
    this.onEnd?.(M, won);
  }

  /* ==================================================================== */
  /* teardown                                                             */
  /* ==================================================================== */

  _despawnHostiles(M) {
    for (const h of M.spawnedHostiles) this.hostiles.despawn(h);
    M.spawnedHostiles.length = 0;
  }

  cleanup() {
    const M = this.M;
    if (!M) return;
    // FIRST. A chapter abandoned mid-cutscene must not leave the scene holding
    // the clock, the keyboard and the camera with nothing on screen — that is
    // an unplayable game, not a stuck widget.
    this._cancelScene();
    this._despawnHostiles(M);
    for (const v of M.spawnedVehicles) {
      this.unmarkVehicle(v);
      // Leave the car the player is sitting in — yanking it out from under him
      // at the result card is the single worst thing a mission can do.
      if (this.wq.playerVehicle() === v) { v.isMission = false; continue; }
      // FORCE past the `isMission` cull-guard in `vehicles.despawn`: that guard
      // stops a distance/streaming cull taking a live mission car, but mission
      // cleanup is the one caller authorised to remove it. Force still refuses
      // a car the player is seated in (guard (a) holds under force), so a
      // chapter ending while he is aboard cannot strand him.
      this.wq.despawnVehicle(v, { force: true });
    }
    M.spawnedVehicles.length = 0;
    for (const p of M.spawnedPickups) this.pickups.despawn(p);
    M.spawnedPickups.length = 0;
    M.rivals.length = 0;
    M.bossVeh = null;
    M.bossEnt = null;
    M.ward = null;
    this._releaseFigures();
    this._ringOn = false;
    this._hideGlows();
    this._markers.length = 0;
    const ui = this.wq.ui;
    ui?.setObjectives?.(EMPTY);
    ui?.clearObjective?.();
    // Hand the map pin back to whatever the player had chosen before the job.
    if (this._wp) { this._wp.x = NaN; this._wp.z = NaN; }
    ui?.setWaypoint?.(this.userWaypoint ?? null);
    this._objective.text = '';
    this._objective.progress = -1;
    this._objective.timer = null;
    this._objective.count = '';
  }

  abort() {
    const M = this.M;
    if (!M) return;
    this.cleanup();
    M.phase = 'over';
    M.state = M.state === 'run' ? 'lost' : M.state;
    this.M = null;
  }

  /** What `ui` polls each frame, via `game.getHudState().objective`. */
  hudObjective() {
    if (!this.M || this.M.phase === 'over') return null;
    return this._objective.text ? this._objective : null;
  }

  /** Rule 6: free the glow rings and figure meshes this runner built. */
  dispose() {
    this.abort();
    if (this._glow) {
      this._glow.group.parent?.remove(this._glow.group);
      this._glow.geo.dispose();
      this._glow.dest.material.dispose();
      for (const m of this._glow.veh) m.material.dispose();
      this._glow = null;
    }
    if (this._figures) {
      for (const f of this._figures) {
        f.group.parent?.remove(f.group);
        f.shirt.dispose();
        f.ringMat.dispose();
        for (const child of f.group.children) child.geometry?.dispose();
      }
      this._figureSkin?.dispose();
      this._figures = null;
    }
  }
}

const EMPTY = Object.freeze([]);

/** The first gate of a race circuit, as a staging POI. */
function startLineOf(c) {
  if (c.track !== 'race') return null;
  const t = RACE_TRACKS[c.trackId];
  if (!t) return null;
  return { id: `grid_${t.id}`, name: `${t.name} start line`, x: t.points[0].x, z: t.points[0].z };
}

/**
 * `[['carson','line'], ...]` from `data.js` -> `[{who,text,name,colour}]`.
 *
 * The SPEAKER IS RESOLVED HERE, on the `game` side, because this is the side
 * that owns the facts:
 *
 *   - `SPEAKERS` (`src/game/data.js`) is the authored table of who is who —
 *     including `gabby`, `radio` and `cop`, none of whom are brothers and none
 *     of whom `ui`'s own atlas knows about. `ui` cannot import it (rule 2) and
 *     a second copy over there would be two owners of one fact.
 *   - **`boss` is not a speaker.** The villain's name is a property of the
 *     brother you are playing (THE HARBORMASTER / DUKE MARROW / VIPER LANE),
 *     which is `boy.rival` here and is unknowable from the HUD.
 *
 * `ui` still falls back to its own `BOY_BY_ID` and then to the raw id, so a
 * caller that hands it a bare `{who,text}` (a mid-mission bark) is unaffected.
 *
 * @param {object} [boy] the brother whose story this is — supplies `rival`.
 */
export function toScene(lines, boy = null) {
  if (!Array.isArray(lines)) return EMPTY;
  const out = [];
  for (const raw of lines) {
    const l = Array.isArray(raw) ? { who: raw[0], text: raw[1] }
      : (raw && typeof raw === 'object') ? { ...raw } : null;
    if (!l) continue;
    const sp = SPEAKERS[l.who];
    if (l.name === undefined) {
      l.name = (l.who === 'boss' && boy?.rival) ? boy.rival : sp?.name;
    }
    if (l.colour === undefined && sp?.color) l.colour = sp.color;
    // No `body` is sent: the brothers' portrait palettes are in the HUD's own
    // atlas already, and everyone else takes the boss palette. One owner per
    // fact, and this side is not it.
    out.push(l);
  }
  return out;
}
