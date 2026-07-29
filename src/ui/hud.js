/**
 * ===========================================================================
 * HUD — the ward health bar
 * ===========================================================================
 *
 * A `protect` chapter has exactly one way to lose: the brother you are standing
 * over runs out of HP. Everything else on screen during one of those chapters
 * is about the ATTACKERS — "Keep Dylan alive", a `kills / goal` counter, and a
 * progress bar that fills with YOUR OWN KILLS (`game/tracks.js`). The single
 * number that decides whether you win or lose was published every frame on
 * `game.getHudState().ward` and drawn by nobody, so the fail condition was
 * invisible right up until it fired.
 *
 * It is drawn for the whole duration — a name and a meter, shown when the
 * chapter starts, width tracking `hp / maxHp`, hidden when the chapter ends:
 * the row lives at the bottom of the objective panel, so it inherits the
 * panel's position, its fade and its lifetime, and there is no second place on
 * screen for "what is happening to me" to live.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS IS A SUBSYSTEM AND NOT A FEW LINES IN `ui/index.js`
 * ---------------------------------------------------------------------------
 * The registry is the sanctioned way to add behaviour without editing
 * `src/ui/index.js`: `static deps = ['ui', 'game']` puts this after both in the
 * topo sort, `ctx.peek` reaches them at runtime (rule 2 — never an import),
 * and the DOM node is parented into the panel `ui` already built. Nothing here
 * writes game state, consumes input, claims the clock or touches `time.scale`.
 *
 * ---------------------------------------------------------------------------
 * TWO BARS, ONE TRUTH
 * ---------------------------------------------------------------------------
 * The FILL snaps to the published health every frame — a health bar that lags
 * is a health bar that lies, and this one is a fail condition. The CHIP behind
 * it is a slower ghost that drains down to meet the fill, which is what makes a
 * hit legible as an amount rather than as a new number. `src/ui/wardprobe.mjs`
 * measures the fill.
 */

import { el, setStyle, setText, clamp01, damp } from './util.js';
import { BOYZ } from './data.js';

/** Uppercased brother name -> his signature colour, for the ward's name+bar. */
const BOY_COLOUR = {};
for (const b of BOYZ) BOY_COLOUR[b.name.toUpperCase()] = b.colour;

/** Below this fraction the bar goes to blood and starts pulsing. */
const CRITICAL = 0.3;
const FALLBACK = '#79d2ff'; // --cyan, the ally colour

/**
 * Name + meter. `set(name, health01)` every frame it should be up, `hide()`
 * every frame it should not; `update(dt)` animates the chip and the pulse.
 */
export class WardBar {
  constructor(parent) {
    this.root = el('div', 'ow-ward', parent);
    // Right-aligned to sit under the objective text, which is right-aligned.
    this.root.style.cssText =
      'display:flex;justify-content:flex-end;align-items:center;' +
      'gap:calc(var(--u) * 2);margin-top:calc(var(--u) * 1.6);';

    this.name = el('div', 'ow-ward-name', this.root, '');
    this.name.style.cssText =
      'font-family:var(--fm);font-size:calc(10px * var(--k));letter-spacing:.28em;' +
      'text-shadow:var(--sh-o1);white-space:nowrap;';

    this.track = el('div', 'ow-ward-track', this.root);
    this.track.style.cssText =
      'position:relative;width:calc(96px * var(--k));height:calc(5px * var(--k));' +
      'background:rgba(8,12,17,.86);overflow:hidden;';

    this.chip = el('i', 'ow-ward-chip', this.track);
    this.chip.style.cssText =
      'position:absolute;left:0;top:0;height:100%;width:100%;' +
      'background:rgba(255,244,232,.34);';

    this.fill = el('i', 'ow-ward-fill', this.track);
    this.fill.style.cssText = 'position:absolute;left:0;top:0;height:100%;width:100%;';

    this.active = false;
    this.health = 1;
    this.chipValue = 1;
    this.colour = FALLBACK;
    this._pulse = 0;
    this._rawName = undefined;
    this._wroteFill = -1;
    this._wroteChip = -1;
    this._wroteHot = null;
    setStyle(this.root, 'display', 'none');
  }

  /** @param {number} health 0..1, already clamped by the caller or here. */
  set(name, health) {
    const h = clamp01(health);
    if (!this.active) {
      this.active = true;
      // A bar that fades in from the previous chapter's value would read as
      // the ward taking damage he never took, so start settled on the truth.
      this.chipValue = h;
      this._pulse = 0;
      setStyle(this.root, 'display', 'flex');
    }
    this.health = h;
    // Compare the RAW name first: `toUpperCase()` on an unchanged string would
    // otherwise allocate once per frame for the whole chapter (rule 5).
    if (name !== this._rawName) {
      this._rawName = name;
      const label = String(name ?? '').toUpperCase();
      setText(this.name, label);
      this.colour = BOY_COLOUR[label] ?? FALLBACK;
      setStyle(this.name, 'color', this.colour);
      this._wroteHot = null;
    }
  }

  hide() {
    if (!this.active) return;
    this.active = false;
    setStyle(this.root, 'display', 'none');
  }

  update(dt) {
    if (!this.active) return;
    // The chip only ever drains toward the fill. Healing (the ward is topped
    // up when he is pinned) snaps both, so the ghost can never sit BEHIND the
    // bar and read as damage that is about to land.
    this.chipValue = this.chipValue > this.health
      ? damp(this.chipValue, this.health, 3.4, dt)
      : this.health;

    const crit = this.health < CRITICAL;
    this._pulse = crit ? (this._pulse + dt) % 1 : 0;

    // Quantised to a tenth of a percent so a settled bar stops writing style
    // strings entirely (rule 5) while still moving smoothly on the way down.
    const f = Math.round(this.health * 1000);
    if (f !== this._wroteFill) {
      this._wroteFill = f;
      setStyle(this.fill, 'width', (f / 10).toFixed(1) + '%');
    }
    const c = Math.round(this.chipValue * 1000);
    if (c !== this._wroteChip) {
      this._wroteChip = c;
      setStyle(this.chip, 'width', (c / 10).toFixed(1) + '%');
    }

    const hot = crit ? '#ff3b4e' : this.colour;
    if (hot !== this._wroteHot) {
      this._wroteHot = hot;
      setStyle(this.fill, 'background', 'linear-gradient(90deg, rgba(8,12,17,.55), ' + hot + ')');
    }
    // Under a third he pulses. Unscaled dt drives it, so it keeps breathing
    // while a card or a menu has the world stopped. Outside the pulse the
    // opacity is a constant and costs nothing.
    if (crit) setStyle(this.root, 'opacity', (0.72 + 0.28 * Math.cos(this._pulse * 6.283)).toFixed(3));
    else setStyle(this.root, 'opacity', '1');
  }

  dispose() {
    this.root.remove();
  }
}

/**
 * The subsystem. Reads `game.getHudState().ward` — the record `game` already
 * publishes — and draws it. Draws nothing at all when there is no ward, which
 * is every chapter but one.
 */
export class HudSystem {
  static id = 'hud';
  static deps = ['ui', 'game'];

  async init(ctx) {
    this.ctx = ctx;
    const ui = ctx.peek('ui');
    // Into the objective panel when there is one, so the ward rides its fade
    // and its position; the chrome layer is the fallback for a `ui` that has
    // rearranged itself, and `document.body` for a headless DOM.
    const parent = ui?.objective?.root ?? ui?.topRight ?? ui?.chromeLayer ?? ui?.root
      ?? document.getElementById('ui') ?? document.body;
    this.bar = new WardBar(parent);
    this._lastRaw = ctx.time.raw;
  }

  /**
   * After `ui.lateUpdate` (deps put us behind it), so the objective panel has
   * already been shown or hidden for this frame and the bar is never drawn
   * into a panel that is about to vanish.
   */
  lateUpdate(dt, ctx) {
    if (!this.bar) return;
    // Unscaled: the pulse and the chip drain must keep running while a
    // MISSION FAILED card has the world stopped at zero scale.
    const raw = ctx.time.raw;
    const rawDt = Math.min(0.1, Math.max(0, raw - this._lastRaw));
    this._lastRaw = raw;

    const game = ctx.peek('game');
    const ward = typeof game?.getHudState === 'function' ? game.getHudState().ward : null;
    if (ward && Number.isFinite(ward.health)) this.bar.set(ward.name, ward.health);
    else this.bar.hide();
    this.bar.update(rawDt);
  }

  dispose() {
    this.bar?.dispose();
    this.bar = null;
  }
}
