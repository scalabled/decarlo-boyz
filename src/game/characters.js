/**
 * GAME — character switching.
 *
 * GTA V's switch is the headline feature of this game's structure, and its
 * design rule is simple: the brother you leave keeps living where you left
 * him, and the brother you arrive at is somewhere plausible doing something.
 * So a switch is a *state handover*, not a model swap:
 *
 *   1. the outgoing brother's position, health, armour, wanted level, cash,
 *      respect and ammunition are written into his own save record;
 *   2. any live pursuit is dropped — his heat stays with him, on paper;
 *   3. `player.setBrother(id)` swaps the body and the stats, and
 *      `ui.setCharacter(id)` swaps the HUD colour, the vitals maxima and the
 *      weapon wheel loadout. Nothing in the repo bridges those two halves —
 *      this is that bridge;
 *   4. the incoming brother is placed at his saved position, or at whatever the
 *      `Director` says he is doing at this hour if he has never been played;
 *   5. his radio rotation, his wanted level and his kerbside car come back.
 *
 * `ui` already built the switch wheel and emits `ui:character { id }`. This
 * listens for it. It does not build a wheel.
 */

import { BOYZ, BOY_ORDER } from './data.js';

export class Characters {
  constructor(ctx, deps) {
    this.ctx = ctx;
    this.wq = deps.wq;
    this.economy = deps.economy;
    this.heat = deps.heat;
    this.director = deps.director;
    this.save = deps.save;

    this.activeId = save0(deps.save);
    this.boy = BOYZ[this.activeId];
    this.switching = false;
    this._car = null;
    this._off = null;
    /** Called after a completed switch so the game system can re-seed. */
    this.onSwitched = null;
  }

  init() {
    this._off = this.ctx.events.on('ui:character', (e) => {
      if (!e?.id || e.id === this.activeId) return;
      this.switchTo(e.id);
    });
    return this;
  }

  get ids() {
    return BOY_ORDER;
  }

  /* ==================================================================== */
  /* persistence of the live brother                                      */
  /* ==================================================================== */

  /** Write everything about the brother on screen into his save record. */
  capture(id = this.activeId) {
    const c = this.save.chars[id];
    if (!c) return c;
    const p = this.wq.player;
    const pos = this.wq.playerPos();
    if (Number.isFinite(pos.x)) {
      c.pos = [+pos.x.toFixed(2), +pos.y.toFixed(2), +pos.z.toFixed(2)];
      c.yaw = +(p?.yaw ?? 0).toFixed(3);
    }
    if (p?.health) {
      c.hp = +p.health.value.toFixed(1);
      c.armor = +(p.armour ?? 0).toFixed(1);
    }
    c.wanted = this.heat.wanted;
    return c;
  }

  /** Read a brother's save record back onto the live player. */
  restore(id) {
    const c = this.save.chars[id];
    const boy = BOYZ[id];
    const p = this.wq.player;

    // ---- body + stats ----------------------------------------------------
    p?.setBrother?.(id);
    // `player.setBrother` early-outs when the id already matches, which is
    // right, but it means health maxima are only applied on a real change.
    if (p?.health) {
      const max = p.health.max ?? boy.hp;
      p.health.value = c.hp >= 0 ? Math.min(c.hp, max) : max;
      if (p.health.armour !== undefined) {
        p.health.armour = c.armor >= 0 ? Math.min(c.armor, p.maxArmour ?? boy.armorMax) : 0;
      }
    }

    // ---- where he is -----------------------------------------------------
    const spot = this.director.spawnFor(id, c);
    this.wq.placePlayer(spot.x, spot.z, spot.yaw, spot.y ?? null);
    // Vetting a point on the far side of the map happens against collision that
    // has not streamed yet, so it can only be trusted once he is standing on
    // it. `GameSystem` re-checks for a few seconds; see `Director.unstick`.
    this.director.armUnstick?.();

    // ---- HUD -------------------------------------------------------------
    const ui = this.wq.ui;
    ui?.setCharacter?.(id);
    ui?.setMoney?.(c.cash, 0);
    // `ui` fades the money readout out unless it just changed; `hold` is its
    // own visibility timer, so arriving as a new brother shows his balance
    // without pretending a transaction happened.
    if (ui?.money) ui.money.hold = 3.4;
    if (spot.line) ui?.notify?.(boy.name.toUpperCase(), spot.line.toUpperCase(), 'slag');

    // ---- radio -----------------------------------------------------------
    const audio = this.wq.audio;
    audio?.setRadioRotation?.(boy.radio);
    if (boy.radio?.length) {
      audio?.setRadioStation?.(boy.radio[0]);
      ui?.setStation?.(boy.radio[0]);
    }

    // ---- heat ------------------------------------------------------------
    this.heat.clear('switch');
    if (c.wanted > 0) this.heat.raise(c.wanted, spot.x, spot.z);

    // ---- his car at the kerb --------------------------------------------
    this._parkCar(id, spot.x, spot.z);

    this.activeId = id;
    this.boy = boy;
    this.save.active = id;
    return spot;
  }

  _parkCar(id, x, z) {
    if (this._car && !this._car.destroyed) {
      // Only clear the previous brother's courtesy car if nobody is in it.
      if (this.wq.playerVehicle() !== this._car) this.wq.despawnVehicle(this._car);
    }
    this._car = null;
    const type = this.director.carFor(id);
    const spot = this.wq.curbSpot(x, z);
    const v = this.wq.spawnVehicle(type, spot.x, spot.z, spot.yaw);
    if (v) {
      v.isPersonal = true;
      this._car = v;
    }
  }

  /* ==================================================================== */
  /* the switch                                                           */
  /* ==================================================================== */

  /**
   * @param {'carson'|'aidan'|'dylan'} id
   * @returns {boolean} false if the id is unknown or it is already him.
   */
  switchTo(id) {
    if (!BOYZ[id] || id === this.activeId || this.switching) return false;
    this.switching = true;
    const from = this.activeId;

    // Get him out of the car first — arriving as a passenger in somebody
    // else's vehicle two kilometres away is the classic switch bug.
    const p = this.wq.player;
    if (p?.inVehicle) p.vehicles?.abort?.(p.movement);

    this.capture(from);
    this.restore(id);

    this.ctx.events.emit('game:character', { id, from });
    this.wq.uiSfx('regen', 0.8);
    this.switching = false;
    this.onSwitched?.(id, from);
    return true;
  }

  /** Next brother in the fixed order — what a keyboard shortcut would call. */
  cycle(dir = 1) {
    const i = BOY_ORDER.indexOf(this.activeId);
    const n = BOY_ORDER.length;
    return this.switchTo(BOY_ORDER[((i + dir) % n + n) % n]);
  }

  /** The switch-wheel blurb: what each brother is up to, right now. */
  roster(out = []) {
    out.length = 0;
    for (const id of BOY_ORDER) {
      const c = this.save.chars[id];
      const a = this.director.activityFor(id);
      out.push({
        id,
        name: BOYZ[id].name,
        colour: BOYZ[id].color,
        chapter: c.chapter,
        chapters: BOYZ[id].story.length,
        cash: c.cash,
        respect: c.respect,
        active: id === this.activeId,
        doing: id === this.activeId ? 'Active' : a.line,
      });
    }
    return out;
  }

  dispose() {
    this._off?.();
    if (this._car && this.wq.playerVehicle() !== this._car) this.wq.despawnVehicle(this._car);
    this._car = null;
  }
}

function save0(save) {
  return BOY_ORDER.includes(save?.active) ? save.active : BOY_ORDER[0];
}
