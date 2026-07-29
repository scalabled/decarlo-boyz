/**
 * GAME — the free-roam job board.
 *
 * GAMEPLAY.md §"Mechanics we do not have at all": an open world has to always
 * have something to do, and the cheapest way to get there is to generate
 * free-roam jobs out of the same track types the story uses. Without them
 * there are twenty-four authored chapters and then an empty city — finish a
 * brother's arc and the map becomes a driving simulator.
 *
 * So: thirteen job templates. Ten are a thin `def` over a track that already
 * exists in `tracks.js` — no new mission machinery, no second update loop, no
 * second save format; a job is a chapter that nobody wrote dialogue for. The
 * last three are LITE jobs the board runs itself (see below).
 *
 *   steal      boost a specific class of car and bring it to Aidan's  -> deliver
 *   delivery   run a van across town                                   -> timedDeliver
 *   recover    catch a runner and wreck it                             -> chase
 *   pickup     scavenge the scattered consumable field                 -> LITE
 *   kill       clear out a crew that is standing on your corner        -> goons
 *   copkill    wreck a convoy while they are looking                   -> rampage
 *   escape     shed the stars you are about to earn                    -> escape
 *   protect    keep a man alive while they come for him                -> survive
 *   escort     see a load out of the district in one piece             -> escort
 *   brawl      fists only, in a yard                                   -> brawl
 *   explore    cruise out to a named zone                              -> LITE
 *   speed      wind a ride out and HOLD it                             -> LITE
 *   copwar     take out N crooked cop units                            -> LITE
 *
 * Three offers stand at a time. They are regenerated when the player has moved
 * a district away or an hour has passed, so the board is stable enough to
 * drive to and fresh enough to be worth reading. Payouts scale with the job's
 * difficulty and how far it is asking you to go, which is the only balancing
 * lever it needs.
 *
 * THE FEED: a board alone still leaves the player jobless between offers, so
 * the feed sits on top of it. Whenever a job or chapter ends without
 * `game/index.js` having announced the next thing (a failed side job, a death
 * outside a mission, a finished LITE job), the nearest offer is toasted with a
 * `job:offer` event behind it, and while the story is done a standing
 * suggestion re-surfaces every 45 seconds.
 *
 * LITE jobs (`explore` · `speed` · `copwar`) are the three free-roam tracks
 * with no `tracks.js` implementation. They run right here — spatial, speed and
 * counter checks against live world state, the
 * HUD objective panel and a world marker, `mission:start`/`mission:complete`
 * emitted with the standard payloads so `ui` gives them the same title and
 * result cards — and they pay through the same economy.
 */

import * as THREE from 'three';
import { POI } from './data.js';
import { dist } from './util.js';
import { money } from './economy.js';

/**
 * @typedef {object} JobTemplate
 * `pay` is per difficulty point; `respect` is flat. `build(j, g)` fills in the
 * per-offer fields that need the world.
 */
const TEMPLATES = [
  {
    id: 'steal', track: 'deliver', label: 'BOOST',
    name: 'Hot Metal', teaser: 'Somebody wants a car that is not theirs. Bring it to the shop.',
    pay: 420, respect: 6, difficulty: 2,
    build: (j) => { j.vehType = pick(j.rng, ['muscle', 'sports', 'sedan']); j.dest = 'sh_aidan'; },
  },
  {
    id: 'delivery', track: 'timedDeliver', label: 'RUN',
    name: 'Butler Street Run', teaser: 'Load in the van, across town, before the shift ends.',
    pay: 520, respect: 7, difficulty: 3, baseTimer: 190,
    build: (j) => { j.vehType = 'van'; },
  },
  {
    id: 'recover', track: 'chase', label: 'RECOVER',
    name: 'It Left Without Asking', teaser: 'A car went missing. Bring it back in pieces if you have to.',
    pay: 640, respect: 9, difficulty: 3,
  },
  {
    // "Scavenge N parts pickups" counts the SCATTERED field, not staged
    // crates, so it is a LITE job over the ambient consumables `freeroam`
    // keeps stocked. (Story chapters still stage real crates through the
    // `collect` track in `tracks.js`.)
    id: 'pickup', track: 'scavenge', label: 'SWEEP', lite: true,
    name: 'Fell Off The Back', teaser: 'Loads shook loose all over town. Sweep up whatever you find.',
    pay: 300, respect: 5, difficulty: 1,
    // 3–5.
    build: (j) => { j.goal = 3 + (j.rng.u32() % 3); },
  },
  {
    id: 'kill', track: 'goons', label: 'CLEAR',
    name: 'Standing On Our Corner', teaser: "They have been told once. This is the second time.",
    pay: 560, respect: 8, difficulty: 3, goal: 5,
  },
  {
    id: 'copkill', track: 'rampage', label: 'WRECK',
    name: 'Insurance Job', teaser: 'A convoy nobody will miss. Total it and walk away.',
    pay: 760, respect: 11, difficulty: 4, goal: 4, baseTimer: 150,
  },
  {
    id: 'escape', track: 'escape', label: 'LOSE THEM',
    name: 'Bought Attention', teaser: 'Make some noise, then make it go away.',
    pay: 700, respect: 12, difficulty: 4, stars: 3,
  },
  {
    id: 'protect', track: 'survive', label: 'HOLD',
    name: 'Hold The Yard', teaser: 'Stand where you are told and do not move until it is quiet.',
    pay: 620, respect: 10, difficulty: 4, baseTimer: 95,
  },
  {
    id: 'escort', track: 'escort', label: 'ESCORT',
    name: 'See It Out', teaser: 'Ride the load out of the district. It does not go alone.',
    pay: 580, respect: 9, difficulty: 3,
  },
  {
    id: 'brawl', track: 'brawl', label: 'FISTS',
    name: 'No Iron', teaser: 'Hands only. He asked for it that way and you agreed.',
    pay: 340, respect: 8, difficulty: 2, goal: 4,
  },
  // ---- LITE jobs — run by the board itself, no `tracks.js` machinery ----
  {
    id: 'explore', track: 'explore', label: 'CRUISE', lite: true,
    name: 'Be Seen Out There', teaser: 'Cruise out to the far side and be seen. That is the whole job.',
    pay: 380, respect: 8, difficulty: 1, range: [520, 1200],
  },
  {
    id: 'speed', track: 'speed', label: 'OPEN IT UP', lite: true,
    name: 'Word Of Mouth', teaser: 'Any ride. Wind it out and HOLD it — a rumour needs witnesses.',
    pay: 340, respect: 6, difficulty: 1,
    // 26–33 m/s (94–120 km/h).
    build: (j) => { j.tgt = 26 + (j.rng.u32() % 8); },
  },
  {
    id: 'copwar', track: 'copwar', label: 'COP WAR', lite: true,
    name: 'Crooked Blue', teaser: 'Crooked units shaking down our streets. Take them off it.',
    pay: 900, respect: 16, difficulty: 5,
    // 2–3 units.
    build: (j) => { j.goal = 2 + (j.rng.u32() % 2); },
  },
];

/** Regenerate when the player has moved this far from where the board was cut. */
const REFRESH_DIST = 700;
/** ...or after this many seconds, so a board never goes stale in place. */
const REFRESH_TIME = 240;
const OFFERS = 3;
/** Jobless with the story done: re-surface the standing suggestion this often. */
const STAND_PERIOD = 45;
/** `explore` completes inside this ring. */
const EXPLORE_RADIUS = 46;
/** `speed` wants the target held for this many seconds. */
const SPEED_HOLD = 3;

const kmh = (ms) => Math.round(ms * 3.6);

/** What the scavenge job is allowed to count. */
const CONSUMABLES = new Set(['cash', 'health', 'armor', 'ammo', 'nitro']);

export class JobBoard {
  constructor(ctx, deps) {
    this.ctx = ctx;
    this.wq = deps.wq;
    this.economy = deps.economy;
    this.missions = deps.missions;
    this.save = deps.save;
    this.rng = ctx.rng.fork();

    /** The standing offers. Reused records — `update` allocates nothing. */
    this.offers = [];
    for (let i = 0; i < OFFERS; i++) {
      this.offers.push({
        i, id: '', label: '', name: '', zone: '', teaser: '', track: '',
        pay: 0, respect: 0, difficulty: 1, x: 0, z: 0, dist: 0,
        vehType: null, dest: null, goal: 1, baseTimer: 0, spread: 0, stars: 0,
        tgt: 0, lite: false, rng: null,
      });
    }
    this.boy = null;
    this._cutX = 0;
    this._cutZ = 0;
    this._age = 1e9;
    this._ready = false;
    this._def = {
      no: 'SIDE JOB', name: '', zone: '', teaser: '', track: '',
      baseTimer: 0, cash: 0, respect: 0, difficulty: 1,
      goal: 1, spread: 0, stars: 0, vehType: null, dest: null,
      intro: EMPTY, done: EMPTY,
    };

    /**
     * The running LITE job. `side`, `def` and `startPoi` make the handle
     * shape-compatible with a `MissionRunner` mission for anything that only
     * reads the headline fields (the probes do).
     */
    this.lite = {
      active: false, id: '', track: '', name: '', zone: '', side: true,
      pay: 0, respect: 0, x: 0, z: 0, d0: 1, tgt: 0, hold: 0, prog: 0, goal: 1,
      cop0: 0,
      def: { no: 'SIDE JOB', name: '', zone: '', cash: 0, respect: 0 },
      startPoi: { name: '' },
    };
    this._liteMarker = { position: new THREE.Vector3(), label: 'J', name: '' };
    this._liteMarkers = [this._liteMarker];
    this._liteObj = { eyebrow: 'SIDE JOB', text: '', count: '', progress: 0, timer: undefined };
    this._liteObjT = 0;
    this._startPayload = { id: '', chapter: 'SIDE JOB', name: '', zone: '', track: '', lines: null };
    this._endPayload = { id: '', name: '', cash: 0, respect: 0, reason: '' };

    /* ---- the feed ------------------------------------------------------ */
    /** The last suggestion pushed — probes and a phone UI read it. */
    this.suggestion = null;
    this._suggestT = 0;
    this._standT = STAND_PERIOD;
    this._offerPayload = { id: '', name: '', pay: 0, respect: 0, x: 0, z: 0, kind: 'job' };
    this._offs = [
      // `game/index.js` announces the next thing on every WIN (and on a failed
      // chapter). The feed covers what it does not: a failed side job, a death,
      // and lite jobs, whose end never passes through `MissionRunner.onEnd`.
      ctx.events.on('mission:complete', (e) => {
        if (typeof e?.id === 'string' && e.id.startsWith('lite:')) this._suggestT = 1.5;
      }),
      ctx.events.on('mission:fail', (e) => {
        if (typeof e?.id === 'string' && /^(job|race|lite):/.test(e.id)) this._suggestT = 2.5;
      }),
      ctx.events.on('player:death', () => {
        if (this.lite.active) this._cancelLite();
        this._suggestT = 5;
      }),
      // A real mission outranks side work: cancel a lite job the moment one
      // starts (our own lite start also emits `mission:start`, hence the id
      // check).
      ctx.events.on('mission:start', (e) => {
        if (this.lite.active && e?.id !== this.lite.id) this._cancelLite();
      }),
      // The scavenge job counts consumables off the ambient field.
      ctx.events.on('pickup:collect', (e) => {
        if (!this.lite.active || this.lite.track !== 'scavenge') return;
        if (CONSUMABLES.has(e?.kind)) this.lite.prog++;
      }),
    ];
  }

  /* ==================================================================== */

  /**
   * Cut a fresh board around the player. Deterministic given the RNG stream,
   * so a replay reproduces the same offers.
   */
  refresh(force = false) {
    const p = this.wq.focusPos();
    if (!force && this._ready &&
        this._age < REFRESH_TIME &&
        dist(p.x, p.z, this._cutX, this._cutZ) < REFRESH_DIST) return this.offers;

    this._cutX = p.x;
    this._cutZ = p.z;
    this._age = 0;
    this._ready = true;

    // Three DIFFERENT templates: a board offering the same job three times is
    // worse than no board.
    const taken = this._taken ?? (this._taken = new Set());
    taken.clear();
    for (let i = 0; i < OFFERS; i++) {
      let t = null;
      for (let tries = 0; tries < 12; tries++) {
        const c = TEMPLATES[this.rng.u32() % TEMPLATES.length];
        if (!taken.has(c.id)) { t = c; break; }
      }
      t ??= TEMPLATES[i % TEMPLATES.length];
      taken.add(t.id);
      this._fill(this.offers[i], t, p);
    }
    return this.offers;
  }

  _fill(j, t, p) {
    // Somewhere on the road network a few hundred metres out: far enough that
    // the drive is the job, close enough that it is not a commute. A template
    // may stretch the annulus (`explore` asks for a real cross-town cruise).
    const spot = this.wq.findRoadSpot(t.range?.[0] ?? 220, t.range?.[1] ?? 900, p.x, p.z);
    j.id = t.id;
    j.label = t.label;
    j.name = t.name;
    j.teaser = t.teaser;
    j.track = t.track;
    j.difficulty = t.difficulty;
    j.goal = t.goal ?? 1;
    j.spread = t.spread ?? 0;
    j.stars = t.stars ?? 0;
    j.baseTimer = t.baseTimer ?? 0;
    j.tgt = 0;
    j.lite = !!t.lite;
    j.vehType = null;
    j.dest = null;
    j.rng = this.rng;
    t.build?.(j, this);
    j.x = spot.x;
    j.z = spot.z;
    j.zone = (this.wq.districtName(spot.x, spot.z) || 'STEEL CITY').toUpperCase();
    j.dist = dist(p.x, p.z, spot.x, spot.z);
    // Pay for the work and for the drive. A job across the river is worth more
    // than the same job round the corner, which is what makes the board read
    // like choices rather than a list.
    j.pay = Math.round(t.pay + t.pay * 0.5 * Math.min(2, j.dist / 900));
    j.respect = t.respect;
  }

  update(dt) {
    this._age += dt;
    this._liteUpdate(dt);
    this._feed(dt);
  }

  /** The board, refreshed if it is stale. */
  list() {
    return this.refresh();
  }

  /** The offer nearest the player — what a single "take a job" verb means. */
  best() {
    const list = this.refresh();
    let b = null;
    for (const j of list) if (!b || j.dist < b.dist) b = j;
    return b;
  }

  find(id) {
    for (const j of this.offers) if (j.id === id) return j;
    return null;
  }

  /**
   * Build a one-off offer straight from a template — how a phone UI (or the
   * harness) asks for a job BY NAME when the three cut offers happen not to
   * include it.
   */
  _offTemplate(id) {
    for (const t of TEMPLATES) {
      if (t.id !== id) continue;
      this._spareOffer ??= { ...this.offers[0] };
      this._fill(this._spareOffer, t, this.wq.focusPos());
      return this._spareOffer;
    }
    return null;
  }

  /**
   * Accept a job. Runs through `MissionRunner.startCustom`, so cleanup, the
   * result card, the payout and the save are all the story path's.
   */
  start(idOrOffer) {
    if (this.missions.active || !this.boy) return null;
    const j = typeof idOrOffer === 'string'
      ? (this.find(idOrOffer) ?? this._offTemplate(idOrOffer))
      : (idOrOffer ?? this.best());
    if (!j || !j.track) return null;
    if (this.lite.active) this._cancelLite();
    if (j.lite) return this._startLite(j);

    const d = this._def;
    d.name = j.name;
    d.zone = j.zone;
    d.teaser = j.teaser;
    d.track = j.track;
    d.baseTimer = j.baseTimer;
    d.cash = j.pay;
    d.respect = j.respect;
    d.difficulty = j.difficulty;
    d.goal = j.goal;
    d.spread = j.spread;
    d.stars = j.stars;
    d.vehType = j.vehType;
    d.dest = j.dest;
    // Stage it where the board SAID it was, not under the player's feet.
    // `MissionRunner` resolves a chapter's place through `POI.get(c.at)`, and
    // the runner's `travel` phase then walks the player there before the track
    // spawns anything — so a job registers its pin as a POI and names it. A
    // pin you drive to and a job that happens where you were standing are two
    // different games, and only one of them is this one.
    const poiId = `job_${j.id}`;
    POI.set(poiId, { id: poiId, name: j.name, x: j.x, z: j.z });
    d.at = poiId;

    const M = this.missions.startCustom(this.boy, d, `job:${j.id}:${this.rng.u32() & 0xffff}`);
    if (M) {
      this.wq.ui?.notify?.('Job accepted', j.name.toUpperCase(), 'gold');
      // The board it came off is spent.
      this._age = REFRESH_TIME;
    }
    return M;
  }

  /* ==================================================================== */
  /* LITE jobs — explore · speed · copwar                                 */
  /* ==================================================================== */

  _startLite(j) {
    const L = this.lite;
    L.active = true;
    L.id = `lite:${j.id}:${this.rng.u32() & 0xffff}`;
    L.track = j.track;
    L.name = j.name;
    L.zone = j.zone;
    L.pay = j.pay;
    L.respect = j.respect;
    L.x = j.x;
    L.z = j.z;
    L.d0 = Math.max(1, j.dist);
    L.tgt = j.tgt || 0;
    L.hold = 0;
    L.prog = 0;
    L.goal = j.goal || 1;
    L.def.name = j.name;
    L.def.zone = j.zone;
    L.def.cash = j.pay;
    L.def.respect = j.respect;
    L.startPoi.name = j.zone;
    // Count cop units from the shared ledger `freeroam` keeps — the SAME
    // number the kill rewards pay on, so the job and the payout can never
    // disagree about what a downed unit is.
    L.cop0 = this.ctx.peek('game')?.freeroam?.copKills ?? 0;

    if (j.track === 'copwar') this._stageCopwar(L);

    const p = this._startPayload;
    p.id = L.id;
    p.name = j.name;
    p.zone = j.zone;
    p.track = j.track;
    this.ctx.events.emit('mission:start', p);
    this.wq.ui?.notify?.('Job accepted', j.name.toUpperCase(), 'gold');
    this.wq.uiSfx?.('regen', 0.8);
    this._age = REFRESH_TIME; // the board it came off is spent
    this._liteObjT = 0;
    return L;
  }

  /**
   * Uses `police.spawnCop(crooked)` when that API is present; without it, a
   * star of heat pulls regular units onto the street, which is exactly what
   * hunting crooked cops earns you anyway.
   */
  _stageCopwar(L) {
    const pol = this.ctx.peek('police');
    let spawned = 0;
    if (typeof pol?.spawnCop === 'function') {
      for (let i = 0; i < L.goal + 1; i++) {
        try { if (pol.spawnCop(true)) spawned++; } catch { break; }
      }
    }
    if (!spawned) {
      const pos = this.wq.focusPos();
      try { this.missions.heat?.raise?.(1, pos.x, pos.z); } catch { /* stub */ }
    }
  }

  _liteUpdate(dt) {
    const L = this.lite;
    if (!L.active) return;
    const ui = this.wq.ui;
    this._liteObjT -= dt;
    const o = this._liteObj;

    // Numeric checks every frame; strings only on the 0.25 s throttle below.
    let d = 0;
    let sp = 0;
    switch (L.track) {
      case 'explore': {
        const pos = this.wq.focusPos();
        d = dist(pos.x, pos.z, L.x, L.z);
        this._liteMarker.position.set(L.x, this.wq.groundY(L.x, L.z) + 1.4, L.z);
        if (ui?.setObjectives) ui.setObjectives(this._liteMarkers);
        if (d < EXPLORE_RADIUS) return this._endLite(true);
        break;
      }
      case 'speed': {
        const v = this.wq.playerVehicle();
        sp = v ? Math.abs(v.forwardSpeed ?? 0) : 0;
        // HOLD it, not touch it: the clock only fills at speed and drains
        // double when you lift, so a downhill blip does not pay.
        if (sp >= L.tgt) L.hold += dt;
        else L.hold = Math.max(0, L.hold - dt * 2);
        if (L.hold >= SPEED_HOLD) return this._endLite(true);
        break;
      }
      case 'copwar': {
        const ck = this.ctx.peek('game')?.freeroam?.copKills ?? L.cop0;
        L.prog = Math.max(0, ck - L.cop0);
        if (L.prog >= L.goal) return this._endLite(true);
        break;
      }
      case 'scavenge': {
        // `prog` is bumped by the `pickup:collect` listener.
        if (L.prog >= L.goal) return this._endLite(true);
        break;
      }
      default:
        return this._cancelLite();
    }

    if (this._liteObjT > 0) return;
    this._liteObjT = 0.25;
    if (L.track === 'explore') {
      o.text = L.zone ? `Cruise out to ${L.zone}` : 'Cruise out to the pin';
      o.count = `${Math.round(d)} m`;
      o.progress = Math.max(0, Math.min(1, 1 - d / L.d0));
      this._liteMarker.name = L.zone || L.name;
    } else if (L.track === 'speed') {
      o.text = `Hit ${kmh(L.tgt)} km/h and hold it`;
      o.count = `${kmh(sp)} / ${kmh(L.tgt)} km/h`;
      o.progress = Math.min(1, L.hold / SPEED_HOLD);
    } else if (L.track === 'scavenge') {
      o.text = 'Scavenge the scattered pickups';
      o.count = `${Math.min(L.prog, L.goal)} / ${L.goal}`;
      o.progress = Math.min(1, L.prog / L.goal);
    } else {
      o.text = `Take out ${L.goal} crooked cop units`;
      o.count = `${Math.min(L.prog, L.goal)} / ${L.goal}`;
      o.progress = Math.min(1, L.prog / L.goal);
    }
    ui?.setObjective?.(o);
  }

  _endLite(won) {
    const L = this.lite;
    if (!L.active) return;
    L.active = false;
    const ui = this.wq.ui;
    if (ui?.setObjectives) ui.setObjectives(EMPTY);
    const p = this._endPayload;
    p.id = L.id;
    p.name = L.name;
    p.cash = won ? L.pay : 0;
    p.respect = won ? L.respect : 0;
    p.reason = won ? '' : 'Walked away';
    if (won) {
      this.economy.addCash(L.pay, 'job');
      this.economy.addRespect(L.respect, 'job');
      this.save.totals.missions = (this.save.totals.missions ?? 0) + 1;
      // `ui` draws the PASSED card and clears the objective panel off this.
      this.ctx.events.emit('mission:complete', p);
      this.wq.uiSfx?.('regen', 0.9);
    } else {
      this.ctx.events.emit('mission:fail', p);
    }
    this.ctx.peek('game')?.writer?.touch?.();
  }

  /** Drop a lite job without a verdict — a chapter started, or the player died. */
  _cancelLite() {
    const L = this.lite;
    if (!L.active) return;
    L.active = false;
    const ui = this.wq.ui;
    if (ui?.setObjectives) ui.setObjectives(EMPTY);
    ui?.clearObjective?.();
  }

  /** Public abort — `K` routes through `game.abortMission` for real missions;
   *  anything driving lite jobs directly calls this. */
  abandonLite() {
    if (!this.lite.active) return false;
    this._endLite(false);
    return true;
  }

  /* ==================================================================== */
  /* the feed                                                             */
  /* ==================================================================== */

  _storyDone() {
    const c = this.save.chars?.[this.save.active];
    return !!this.boy && !!c && c.chapter >= this.boy.story.length;
  }

  _feed(dt) {
    if (this.missions.active || this.lite.active) {
      this._standT = STAND_PERIOD;
      return;
    }
    if (this._suggestT > 0) {
      this._suggestT -= dt;
      if (this._suggestT <= 0) this._suggest();
      return;
    }
    this._standT -= dt;
    if (this._standT <= 0) {
      this._standT = STAND_PERIOD;
      if (this._storyDone()) this._suggest();
    }
  }

  /**
   * Push the next thing to do at the player: the next chapter while the story
   * runs, the nearest side job after the credits. Toast + `job:offer`, so a
   * phone UI or `audio` can pick it up without polling.
   */
  _suggest() {
    const ui = this.wq.ui;
    const p = this._offerPayload;
    if (!this._storyDone()) {
      const c = this.save.chars?.[this.save.active];
      const def = this.boy?.story?.[c?.chapter];
      if (!def) return;
      ui?.notify?.(`${def.no} · ${def.name.toUpperCase()}`, 'PRESS J', 'slag');
      p.id = `chapter:${c.chapter}`;
      p.name = def.name;
      p.pay = def.cash ?? 0;
      p.respect = def.respect ?? 0;
      p.x = 0;
      p.z = 0;
      p.kind = 'chapter';
      this.suggestion = p;
      this.ctx.events.emit('job:offer', p);
      return;
    }
    const j = this.best();
    if (!j || !j.id) return;
    ui?.notify?.(j.name.toUpperCase(), `SIDE JOB · PRESS J · ${money(j.pay)}`, 'gold');
    p.id = j.id;
    p.name = j.name;
    p.pay = j.pay;
    p.respect = j.respect;
    p.x = j.x;
    p.z = j.z;
    p.kind = 'job';
    this.suggestion = p;
    this.ctx.events.emit('job:offer', p);
  }

  /** Map pins, in `freeroam.mapPoints`' shape. */
  mapPoints(out) {
    for (const j of this.refresh()) {
      if (!j.id) continue;
      out.push({ x: j.x, z: j.z, kind: 'job', name: j.name });
    }
    return out;
  }

  dispose() {
    for (const off of this._offs) off();
    this._offs.length = 0;
  }
}

const EMPTY = Object.freeze([]);

function pick(rng, list) {
  return list[rng.u32() % list.length];
}

export { TEMPLATES };
