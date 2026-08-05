import { el, setText, setStyle, clamp, damp, ease } from './util.js';

const PRESETS = ['low', 'medium', 'high', 'ultra'];
const DIFFICULTIES = [
  ['easy', 'EASY'],
  ['normal', 'NORMAL'],
  ['hard', 'HARD'],
  ['steel', 'STEEL'],
];
/** Every non-music bus in `src/audio/mixer.js` — the "Effects" group. */
const SFX_BUSES = ['weapons', 'foley', 'ambience', 'sirens', 'vehicles', 'voice', 'ui'];

/**
 * ===========================================================================
 * THE CONTROLS PANEL
 * ===========================================================================
 * The pause screen needs controls on it. Without this panel there is one
 * 90-character hint line naming seven keys, while a sixteen-weapon arsenal, a
 * helicopter and a contextual action key appear nowhere at all.
 *
 * EVERY LINE BELOW WAS READ OUT OF THE CODE THAT CONSUMES THE KEY, NOT OUT OF
 * `CONTROLS.md`. The doc is out of date in at least three places that matter —
 * it gives the mouse wheel a chase-camera zoom (`input.wheel` has no reader in
 * the whole tree), and it does not know about Alt-walk, the middle-mouse
 * shoulder swap, or the number row. Two keys are BOUND in `ACTIONS` and read by
 * nobody — `grenade` (G) and `flashlight` (T) — so they are deliberately not
 * here: a hint naming a key that does nothing is worse than no hint, which is
 * what `src/ui/controlsprobe.mjs` gates. Add a row here only after you have
 * found the line that reads it.
 *
 * J and K come from `GameSystem._input` (`src/game/index.js:775`), which is in
 * no document at all and which the gate found by pressing every letter: J
 * starts the next chapter (or skips a running intro) and K drops it. They are
 * live, unconditional and, for a player who cannot work out how to start
 * anything, the two most useful keys on this panel. U is there too — it cycles
 * brother — and is left off only because the X wheel already does that with a
 * picture of who you are choosing.
 *
 * The two keys that are on purpose absent:
 *   - `` ` `` / F8 — the cheat menu. `ui` appends that to `hintRow` itself, and
 *     only when cheats exist at all (see `UiSystem.init`).
 *   - melee. `ACTIONS.melee` is `[]` on purpose: in this game a swing IS the
 *     fire button with fists or a pipe equipped (`weapons/index.js:1264`), so
 *     LMB carries it and there is no melee key to name.
 *
 * THE AIRPLANE AND THE HELICOPTER GET THEIR OWN SETS, and they do NOT share a
 * mapping — that was the whole "airplane does not take off, I can't find the
 * throttle" report. A plane's SHIFT is the THROTTLE (hold it to build speed);
 * a helicopter's SHIFT is DESCEND and its SPACE is CLIMB. One "FLYING" block
 * that named `[SHIFT, SPACE] Climb · descend` was both wrong for the plane (that
 * pair is its throttle, and there is no direct "climb") and backwards for the
 * heli (SPACE climbs, not SHIFT). Each set is now read straight out of the
 * controller that consumes the key — see the comments above `AIRPLANE` and
 * `HELICOPTER` in `CONTROL_GROUPS`. `src/ui/aircraftprobe.mjs` gates that the
 * plane actually flies on the keys this panel names, through the real input path.
 */
const CONTROL_GROUPS = [
  ['ON FOOT', [
    [['W', 'A', 'S', 'D'], '', 'Move'],
    [['SHIFT'], '', 'Sprint'],
    [['ALT'], '', 'Walk'],
    [['SPACE'], '', 'Jump'],
    [['CTRL', 'C'], '/', 'Crouch'],
    [['MOUSE'], '', 'Look'],
    [['V'], '', 'Camera view'],
    [['F'], '', 'Action · see the prompt'],
  ]],
  ['FIGHTING', [
    [['LMB'], '', 'Fire · swing'],
    [['RMB'], '', 'Aim · block'],
    [['MMB'], '', 'Swap shoulder'],
    [['R'], '', 'Reload'],
    [['E', 'Q'], '/', 'Next / last weapon'],
    [['1', '2', '3', '4', '5', '6'], '', 'Pick a weapon'],
    [['TAB'], '', 'Weapon wheel (hold)'],
    [['B'], '', 'Fire mode'],
    [['I'], '', 'Inspect'],
  ]],
  ['DRIVING', [
    [['F'], '', 'Get in · steal · out'],
    [['W', 'S'], '/', 'Throttle / brake'],
    [['A', 'D'], '/', 'Steer'],
    [['SPACE'], '', 'Handbrake'],
    [['SHIFT'], '', 'Boost'],
    [['H'], '', 'Horn'],
    [['LMB'], '', 'Drive-by'],
    [['V'], '', 'Camera view'],
  ]],
  // EVERY LINE READ OUT OF `src/vehicles/plane.js` — the throttle lever is
  // `input.boost` (SHIFT) up and `input.handbrake` (SPACE) down; W/S is the
  // elevator (`control.throttle - control.brake`, W positive = nose DOWN, so S
  // pulls back and rotates); A/D the ailerons (`control.steer`, roll, and the
  // nosewheel on the ground). Take-off is emergent, not scripted: hold SHIFT to
  // build airspeed, then pull back on S once the wing has the speed to fly.
  ['AIRPLANE', [
    [['SHIFT'], '', 'Throttle up — hold to build speed'],
    [['SPACE'], '', 'Throttle down · wheel brake'],
    [['S'], '', 'Pull back — nose up · take off'],
    [['W'], '', 'Push — nose down'],
    [['A', 'D'], '/', 'Roll · steer on the ground'],
    [['F'], '', 'Get out'],
  ]],
  // EVERY LINE READ OUT OF `src/vehicles/heli.js` — the collective is SPACE
  // (`input.handbrake`) climb and SHIFT (`input.boost`) descend (see that file's
  // header for why SPACE, not SHIFT, is up); W/S is the fore/aft cyclic and A/D
  // the pedals. Hold SPACE from a cold start and it winds the rotor up and lifts.
  ['HELICOPTER', [
    [['SPACE'], '', 'Climb'],
    [['SHIFT'], '', 'Descend'],
    [['W', 'S'], '/', 'Forward / back'],
    [['A', 'D'], '/', 'Turn'],
    [['F'], '', 'Get out'],
  ]],
  ['THE CITY', [
    [['ESC'], '', 'Pause'],
    [['M'], '', 'Map'],
    [['P'], '', 'Phone'],
    [['O'], '', 'Story'],
    [['J'], '', 'Start the next job'],
    [['K'], '', 'Drop the job'],
    [['N'], '', 'Radio station'],
    [['X'], '', 'Switch brother (hold)'],
    [['B'], '', 'Minimap mode'],
    [['↑', '↓', '←', '→'], '', 'Move in a list'],
    [['ENTER'], '', 'Choose'],
  ]],
];

/**
 * The panel's own stylesheet, kept here rather than in `src/ui/style.js`. The
 * existing dossier row already sets its layout inline here for the same reason
 * — this is that decision taken once for forty declarations instead of three.
 *
 * RULE 10: not one backtick and not one `${` inside this literal, ever. Three
 * separate subsystems have taken the whole boot down that way, `src/ui/style.js`
 * among them.
 */
const CONTROLS_CSS = `
.ow-ctl {
  position:absolute; top:50%; right: calc(var(--u) * 8);
  transform: translateY(-50%);
  width: min(56vw, calc(940px * var(--k))); max-height: 74vh;
  overflow-y:auto; overscroll-behavior:contain;
  padding: calc(var(--u) * 4) calc(var(--u) * 4.5);
  background: rgba(6,8,11,.46);
  border-left: calc(2px * var(--k)) solid var(--steel-d);
  text-shadow: var(--sh-hard);
}
.ow-ctl-h {
  font-family: var(--fd); font-size: calc(19px * var(--k));
  letter-spacing:.22em; color: var(--ink);
}
.ow-ctl-sub {
  margin-top: calc(var(--u) * .8); margin-bottom: calc(var(--u) * 3.5);
  font-family: var(--fm); font-size: calc(9px * var(--k));
  letter-spacing:.26em; color: var(--steel-d);
}
.ow-ctl-grid {
  display:grid; gap: calc(var(--u) * 2) calc(var(--u) * 5);
  grid-template-columns: repeat(auto-fill, minmax(calc(258px * var(--k)), 1fr));
  align-items:start;
}
.ow-ctl-gt {
  font-family: var(--fm); font-size: calc(9px * var(--k));
  letter-spacing:.26em; color: var(--slag);
  padding-bottom: calc(var(--u) * 1.2); margin-bottom: calc(var(--u) * 1.2);
  border-bottom:1px solid var(--hair-2);
}
.ow-ctl-r {
  display:grid; grid-template-columns: calc(92px * var(--k)) 1fr;
  gap: calc(var(--u) * 1.5); align-items:center;
  padding: calc(var(--u) * .7) 0;
}
.ow-ctl-k { display:flex; flex-wrap:wrap; align-items:center; gap: calc(2px * var(--k)); }
.ow-ctl-k kbd {
  font-family: var(--fm); font-size: calc(9px * var(--k)); line-height:1;
  letter-spacing:.06em; color: var(--gold);
  background: rgba(255,255,255,.05); border:1px solid var(--hair);
  padding: calc(3px * var(--k)) calc(4.5px * var(--k));
}
.ow-ctl-k .sep { color: var(--ink-3); font-size: calc(8px * var(--k)); }
.ow-ctl-a {
  font-family: var(--ff); font-size: calc(10.5px * var(--k));
  letter-spacing:.06em; color: var(--ink-2); text-transform:uppercase;
}
/* The narrow breakpoint is the touch build. The settings column becomes a
   full-bleed scrolling sheet there (style.js:1041) and .ow-menu .hint is
   hidden for the same reason this is: a keyboard reference on a phone is a
   wall of text about controls that phone does not have. */
@media (max-width: 760px) { .ow-ctl { display:none; } }
`;

let controlsCssInstalled = false;

function installControlsCss() {
  if (controlsCssInstalled && document.getElementById('ow-menu-controls-style')) return;
  const s = document.createElement('style');
  s.id = 'ow-menu-controls-style';
  s.textContent = CONTROLS_CSS;
  document.head.appendChild(s);
  controlsCssInstalled = true;
}

/**
 * Settings persistence. Every change is written to localStorage the moment it
 * happens and restored on load; without this, EVERYTHING here resets on reload
 * — quality, sensitivity, FOV, invert, all of it. Storage can be unavailable
 * (private mode, file://),
 * so both directions swallow failure and the game simply runs on defaults.
 */
const SET_KEY = 'decarlo.settings.v1';

function loadStored() {
  try {
    const s = JSON.parse(localStorage.getItem(SET_KEY));
    return s && typeof s === 'object' ? s : {};
  } catch {
    return {};
  }
}

function saveStored(s) {
  try {
    localStorage.setItem(SET_KEY, JSON.stringify(s));
  } catch {
    /* storage is a convenience, never a requirement */
  }
}

/**
 * Pause / settings menu.
 *
 * Wired straight into `ctx.config`: the quality segments call
 * `config.setQuality`, the sliders write `config.sensitivity` and `config.fov`
 * (and push the FOV into the live camera), and every change is announced on the
 * event bus so render/player can react without importing this module.
 *
 * Events emitted: `ui:pause` {paused}, `ui:quality` {quality},
 * `ui:sensitivity` {value}, `ui:fov` {value}, `ui:setting` {key, value}.
 *
 * It also carries the CONTROLS panel (see `CONTROL_GROUPS` above) and a single
 * "Erase all progress" button, which is what is left of the DOM half of
 * `src/game/save.js` — see `wipeSave` below for how the boundary is drawn and
 * why nothing here imports from `src/game/`.
 *
 * ---------------------------------------------------------------------------
 * THE EXPORT / IMPORT PAIR IS GONE, AND "ERASE ALL" IS NOT.
 * ---------------------------------------------------------------------------
 * Import/export of a save dossier is not a pause-screen feature, so the Export
 * button, the Import button, the hidden `<input type=file>`, the SAVE DOSSIER
 * heading and the `exportDossier` / `importDossier` methods are all removed.
 *
 * Erasing is a different feature that happened to be sitting in the same row,
 * and it is not gone — it MOVED. It now lives on the brother-select screen in
 * `src/ui/boot.js`, which is the only screen where anyone is thinking about
 * save slots at all, still behind a `confirm()`.
 *
 * `wipeSave()` STAYS IN THIS FILE and `boot` calls it. It is the tested path —
 * it owns the confirm, the `game.wipeSave()` call, the failure toasts and the
 * `_afterSaveChange` refresh — and duplicating that into `boot` to save one
 * `peek` would be two answers to one question. Nothing else in the pause menu
 * references it.
 *
 * `src/game/save.js` and `game.exportDossier` / `importDossier` are untouched:
 * only the DOM half went. `src/game/dossierprobe.mjs` still drives those two
 * through the removed buttons and will fail on cases 2 and 3 until it is
 * retargeted at the API.
 *
 * ---------------------------------------------------------------------------
 * THE MENU OWNS POINTER LOCK WHILE IT IS OPEN. THIS IS NOT OPTIONAL.
 * ---------------------------------------------------------------------------
 * Without this, the menu is inescapable: Resume does not respond to a click,
 * ESC does not close it, and a page refresh is the only way out. Neither
 * symptom reproduces in a headless browser, because headless
 * Chromium never grants pointer lock. In a REAL browser the loop is:
 *
 *   1. `Input._onMouseDown` (src/core/input.js) is on `window` and re-requests
 *      pointer lock on ANY left click, including a click on this menu. So
 *      clicking Resume locks the pointer instead of pressing the button:
 *      the lock retargets the following mouseup at the canvas, no `click`
 *      event is ever delivered to the button, and the menu stays open.
 *   2. With the pointer now locked, the browser CONSUMES the next Escape to
 *      exit the lock and does not dispatch the keydown to the page — so ESC
 *      can no longer reach `input.actionPressed('pause')` either.
 *   3. Repeat forever. Both exits are dead. Refresh is the only way out.
 *
 * The fix has three parts and all three matter:
 *   - `_swallow` stops mouse events on the menu from reaching the `window`
 *     listener that grabs the lock (the button still gets its own click);
 *   - `_onLockChange` releases any lock acquired while the menu is open, so
 *     Escape is never eaten by the browser;
 *   - a capture-phase `keydown` on `window` closes the menu directly, so
 *     resuming never depends on the frame loop observing the key edge.
 *
 * `src/ui/pauseprobe.mjs` emulates real pointer-lock semantics and fails on
 * the old code.
 *
 * ---------------------------------------------------------------------------
 * THIS MENU DOES NOT OWN `ctx.time.scale`. `ui`'s PauseArbiter DOES.
 * ---------------------------------------------------------------------------
 * `show()` / `close()` announce themselves through `onToggle` and stop there.
 * They must never write the clock or bank a previous value: three owners doing
 * exactly that is what let ESC-with-TAB-held leave the player in the pause menu
 * with the city running at full speed. `src/ui/pausearbiterprobe.mjs` drives
 * that sequence through the real keyboard and fails on the old code.
 */
export class PauseMenu {
  constructor(parent, ctx) {
    this.ctx = ctx;
    /** Set by `ui`: re-derive the pause the moment this menu opens or closes. */
    this.onToggle = null;
    this.set = loadStored();
    this._audioDirty = true;
    this._difficultyPending = typeof this.set.difficulty === 'string' &&
      this.set.difficulty !== 'normal' ? this.set.difficulty : null;
    this.root = el('div', 'ow-menu', parent);
    const inner = el('div', 'ow-menu-inner', this.root);

    const h = el('h1', null, inner, 'Paused');
    h.textContent = 'PAUSED';
    el('div', 'sub', inner, 'DECARLO BOYZ — STEEL CITY');
    el('div', 'rule', inner);

    this.rows = el('div', null, inner);

    // ---- quality preset --------------------------------------------------
    this.qBtns = [];
    const qRow = this._row('Graphics Preset');
    const seg = el('div', 'ow-seg', qRow);
    for (const p of PRESETS) {
      const b = el('button', null, seg, p);
      b.type = 'button';
      b.addEventListener('click', () => this.setQuality(p));
      this.qBtns.push(b);
    }

    // ---- sensitivity -----------------------------------------------------
    this.sens = this._slider('Mouse Sensitivity', 0.2, 3.0, 0.01, (v) => {
      this.ctx.config.sensitivity = 0.0022 * v;
      this.ctx.events.emit('ui:sensitivity', { value: this.ctx.config.sensitivity, multiplier: v });
      this._store('sensitivity', v);
      return v.toFixed(2);
    });

    // ---- field of view ---------------------------------------------------
    this.fov = this._slider('Field Of View', 65, 120, 1, (v) => {
      this.ctx.config.fov = v;
      const cam = this.ctx.camera;
      if (cam) {
        cam.fov = v;
        cam.updateProjectionMatrix();
      }
      this.ctx.events.emit('ui:fov', { value: v });
      this._store('fov', v);
      return String(v | 0);
    });

    // ---- invert look -----------------------------------------------------
    const invRow = this._row('Invert Look');
    const invSeg = el('div', 'ow-seg', invRow);
    this.invBtns = [];
    for (const [label, val] of [
      ['off', false],
      ['on', true],
    ]) {
      const b = el('button', null, invSeg, label);
      b.type = 'button';
      b.addEventListener('click', () => {
        this.ctx.config.invertY = val;
        this.ctx.events.emit('ui:setting', { key: 'invertY', value: val });
        this._store('invertY', val);
        this.syncFromConfig();
      });
      this.invBtns.push([b, val]);
    }

    // ---- difficulty ------------------------------------------------------
    // Four real tiers exist in `game` (`DIFFS`: easy/normal/hard/steel) and
    // `game.setDifficulty` had zero callers. The row is duck-typed: no game,
    // no harm — the choice still persists and applies when one appears.
    const diffRow = this._row('Difficulty');
    const diffSeg = el('div', 'ow-seg', diffRow);
    this.diffBtns = [];
    for (const [id, label] of DIFFICULTIES) {
      const b = el('button', null, diffSeg, label.toLowerCase());
      b.type = 'button';
      b.addEventListener('click', () => this.setDifficulty(id));
      this.diffBtns.push([b, id]);
    }

    // ---- audio -----------------------------------------------------------
    // `audio.setMasterVolume` / `setBusVolume` existed with ZERO callers.
    // The rows are a Master / Music / Effects / Mute set; the
    // audio system (and its mixer) may not exist yet, so `_applyAudio`
    // re-arms itself and retries from update() until a mixer appears.
    el('div', 'rule', inner);
    this.rows2 = el('div', null, inner);
    const rowsHold = this.rows;
    this.rows = this.rows2;
    this.master = this._slider('Master Volume', 0, 1, 0.05, (v) => {
      this._store('master', v);
      this._applyAudio();
      return Math.round(v * 100) + '%';
    });
    this.music = this._slider('Music', 0, 1, 0.05, (v) => {
      this._store('music', v);
      this._applyAudio();
      return Math.round(v * 100) + '%';
    });
    this.sfx = this._slider('Effects', 0, 1, 0.05, (v) => {
      this._store('sfx', v);
      this._applyAudio();
      return Math.round(v * 100) + '%';
    });
    const muteRow = this._row('Mute');
    const muteSeg = el('div', 'ow-seg', muteRow);
    this.muteBtns = [];
    for (const [label, val] of [
      ['sound on', false],
      ['muted', true],
    ]) {
      const b = el('button', null, muteSeg, label);
      b.type = 'button';
      b.addEventListener('click', () => {
        this._store('mute', val);
        this._applyAudio();
        this.syncFromConfig();
      });
      this.muteBtns.push([b, val]);
    }
    this.rows = rowsHold;

    // ---- buttons ---------------------------------------------------------
    const btns = el('div', 'ow-btns', inner);
    this.resumeBtn = el('button', 'ow-btn primary', btns, 'Resume');
    this.resumeBtn.type = 'button';
    this._exit(this.resumeBtn);
    const storyBtn = el('button', 'ow-btn', btns, 'Story');
    storyBtn.type = 'button';
    storyBtn.addEventListener('click', () => {
      // Open the overview BEFORE closing the menu. `close()` re-requests pointer
      // lock on its way back to the game, and `ui`'s pause guard only refuses
      // that grab while SOMETHING is claiming the pause. Closing first would
      // leave a one-call gap in which nothing is paused, the lock is taken, and
      // the story overview — which has no pointer-lock release of its own — is
      // handed a captured, invisible cursor: the "click Story, then you cannot
      // click Let's Ride until you press ESC" trap. Opening first keeps the
      // world claimed across the whole transition.
      this.ctx.peek('ui')?.openStory?.();
      this.close();
    });
    // Map and Phone: every overlay must be reachable BY MOUSE ALONE. On desktop
    // the pointer is locked in play, so a player who does not know the M / P
    // keys had literally no way to open these — "mouse lock prevents user from
    // seeing map unless they press 'm'". Same open-before-close order as Story,
    // for the same pointer-lock reason documented above.
    const mapBtn = el('button', 'ow-btn', btns, 'Map');
    mapBtn.type = 'button';
    mapBtn.addEventListener('click', () => {
      this.ctx.peek('ui')?.openMap?.();
      this.close();
    });
    const phoneBtn = el('button', 'ow-btn', btns, 'Phone');
    phoneBtn.type = 'button';
    phoneBtn.addEventListener('click', () => {
      this.ctx.peek('ui')?.phone?.show?.();
      this.close();
    });
    const reset = el('button', 'ow-btn', btns, 'Defaults');
    reset.type = 'button';
    reset.addEventListener('click', () => {
      this.sens.set(1);
      this.fov.set(80);
      this.ctx.config.invertY = false;
      this._store('invertY', false);
      this.master.set(1);
      this.music.set(1);
      this.sfx.set(1);
      this._store('mute', false);
      this.setDifficulty('normal');
      this.setQuality('ultra');
      this._applyAudio();
    });
    // There is deliberately NO erase control here — see the header. It lives on
    // the brother-select screen (`src/ui/boot.js`), which is the only screen
    // where a player is thinking about save slots at all.

    // `ui` appends the cheat-menu key to this line when the cheat menu exists
    // at all — see `UiSystem.init`. It is deliberately NOT written in here: the
    // menu is captured in the `menu` debug state, where cheats are off, and a
    // hint naming a key that does nothing is worse than no hint.
    //
    // It used to carry eight bindings; the controls panel now carries every one
    // of them and forty more, so this is back to being what it is — the label
    // on the way out.
    this.hintRow = el('div', 'hint', inner, 'ESC OR ✕ TO RESUME');

    this.controls = this._buildControls();

    // A second, unmissable way out. On a phone the touch layer — including the
    // MENU button that opened this — is hidden under a modal, so the buttons in
    // here are the ONLY exits and there had better be an obvious one.
    this.closeBtn = el('button', 'ow-menu-x', this.root, '✕');
    this.closeBtn.type = 'button';
    this.closeBtn.setAttribute('aria-label', 'Resume');
    this._exit(this.closeBtn);

    this.open = false;
    this.shown = 0;
    setStyle(this.root, 'display', 'none');
    setStyle(this.root, 'cursor', 'default');
    this.syncFromConfig();

    /* ---- the three guards described in the class comment ----------------- */

    // 1. Keep menu clicks away from the window-level pointer-lock grab.
    //    Bubble phase on the menu root: the button's own handler has already
    //    run by the time this fires, so only `Input` loses the event.
    this._swallow = (e) => e.stopPropagation();
    for (const t of ['mousedown', 'mouseup', 'pointerdown', 'pointerup']) {
      this.root.addEventListener(t, this._swallow);
    }

    // 2. Never be pointer-locked while paused — a locked pointer is what makes
    //    the browser eat Escape. Only ever RELEASES: it does not close the menu
    //    on a lock change, because `show()` releases the lock itself and that
    //    must not read as the player asking to resume.
    this._onLockChange = () => {
      if (!this.open) return;
      if (document.pointerLockElement) document.exitPointerLock?.();
    };
    document.addEventListener('pointerlockchange', this._onLockChange);

    // 3. Close on a real Escape keydown, independent of the frame loop.
    //    `_escSeen` is the handshake with `ui._input`, which sees the same
    //    physical key through `input.actionPressed('pause')` — without it the
    //    two paths would toggle twice and re-open the menu on the same press.
    this._escSeen = -1;
    this._onKey = (e) => {
      if (e.key !== 'Escape' && e.code !== 'Escape') return;
      if (!this.open) return;
      this._escSeen = (this.ctx.time?.frame ?? 0);
      this.close();
    };
    addEventListener('keydown', this._onKey, true);
  }

  /** Wire a control that leaves the menu. Click AND touch, because a synthesized
   *  click is not guaranteed once anything in the stack preventDefaults. */
  _exit(node) {
    node.addEventListener('click', () => this.close());
    node.addEventListener('touchend', (e) => {
      e.preventDefault();
      e.stopPropagation();
      this.close();
    }, { passive: false });
  }

  /** True if the frame loop should NOT act on this frame's pause edge, because
   *  the DOM listener above already consumed it. */
  consumedEscape() {
    const f = this.ctx.time?.frame ?? 0;
    return this._escSeen >= 0 && f - this._escSeen <= 1;
  }

  _row(name) {
    const r = el('div', 'ow-row', this.rows);
    el('div', 'name', r, name.toUpperCase());
    return r;
  }

  /**
   * The controls reference, built once, as a SECOND column in the overlay
   * rather than more rows in the settings panel.
   *
   * MEASURED, and it is the whole reason for the layout: at 1280x720 the
   * settings column `.ow-menu-inner` is already 606 px tall in a 720 px
   * viewport, it is `translateY(-50%)` centred, and it only becomes scrollable
   * under the 760 px breakpoint. Forty more rows inside it would have pushed
   * Resume off the bottom of the screen with no way to reach it — which is the
   * bug this menu already has a long comment about, arriving from a new
   * direction.
   *
   * Every key is its own `<kbd>`, which is also what makes the gate possible:
   * `src/ui/controlsprobe.mjs` harvests the rendered elements and presses each
   * one at the real engine. Keep them one key per element.
   */
  _buildControls() {
    installControlsCss();
    const root = el('div', 'ow-ctl', this.root);
    el('div', 'ow-ctl-h', root, 'CONTROLS');
    el('div', 'ow-ctl-sub', root, 'KEYBOARD & MOUSE');
    const grid = el('div', 'ow-ctl-grid', root);
    for (const [title, rows] of CONTROL_GROUPS) {
      const g = el('div', 'ow-ctl-g', grid);
      el('div', 'ow-ctl-gt', g, title);
      for (const [keys, sep, what] of rows) {
        const r = el('div', 'ow-ctl-r', g);
        const kk = el('div', 'ow-ctl-k', r);
        for (let i = 0; i < keys.length; i++) {
          if (i && sep) el('span', 'sep', kk, sep);
          el('kbd', null, kk, keys[i]);
        }
        el('div', 'ow-ctl-a', r, what);
      }
    }
    return root;
  }

  _slider(name, min, max, step, apply) {
    const row = this._row(name);
    const wrap = el('div', 'ow-slider', row);
    el('div', 'track', wrap);
    const fill = el('div', 'fill', wrap);
    const knob = el('div', 'knob', wrap);
    const input = el('input', null, wrap);
    input.type = 'range';
    input.min = String(min);
    input.max = String(max);
    input.step = String(step);
    const val = el('div', 'val', row, '');

    const paint = (v) => {
      const t = (v - min) / (max - min);
      setStyle(fill, 'width', (t * 100).toFixed(2) + '%');
      setStyle(knob, 'left', (t * 100).toFixed(2) + '%');
      setText(val, apply(v) ?? String(v));
    };
    input.addEventListener('input', () => paint(parseFloat(input.value)));
    const api = {
      set: (v) => {
        const c = clamp(v, min, max);
        input.value = String(c);
        paint(c);
      },
    };
    return api;
  }

  setQuality(name) {
    try {
      this.ctx.config.setQuality(name);
      this.ctx.events.emit('ui:quality', { quality: name });
      this._store('quality', name);
    } catch (err) {
      console.warn('[ui] quality switch failed', err);
    }
    this.syncFromConfig();
  }

  /**
   * Persist one field, immediately — every change survives a reload.
   *
   * `_silent` is set by `syncFromConfig`, and it is not a nicety: it is the fix
   * for a bug that made the FOV and sensitivity sliders un-persistable. Every
   * `slider.set()` runs the slider's `apply` callback, and every `apply`
   * callback ends in a `_store` — so `syncFromConfig`, whose whole job is to
   * PUSH THE CONFIG INTO THE ROWS, was writing the rows straight back out to
   * localStorage. The constructor calls it before `restoreSettings` has run, so
   * the boot order was:
   *
   *     load {fov:104} -> syncFromConfig() -> fov.set(config default 80)
   *       -> _store('fov', 80) -> restoreSettings() reads 80 -> 80 applied
   *
   * The stored value was overwritten by the default a few milliseconds before
   * anything tried to restore it, on every boot. Difficulty survived only
   * because `syncFromConfig` reads it instead of re-setting it.
   *
   * A sync is a READ of the config. Only a player action writes.
   */
  _store(key, value) {
    if (this._silent) return;
    this.set[key] = value;
    saveStored(this.set);
  }

  /**
   * Push the stored audio settings at the live mixer. Duck-typed and
   * self-retrying: `audio` may not have initialised yet (its mixer is built on
   * the first user gesture), so a miss arms `_audioDirty` and `update()` tries
   * again until it lands. Mute is a master override, not a lost slider value.
   */
  _applyAudio() {
    const a = this.ctx.peek('audio');
    if (!a || typeof a.setMasterVolume !== 'function' || !a.mixer) {
      this._audioDirty = true;
      return false;
    }
    const s = this.set;
    try {
      a.setMasterVolume(s.mute ? 0 : (typeof s.master === 'number' ? s.master : 1));
      if (typeof a.setBusVolume === 'function') {
        a.setBusVolume('music', typeof s.music === 'number' ? s.music : 1);
        const fx = typeof s.sfx === 'number' ? s.sfx : 1;
        for (const bus of SFX_BUSES) a.setBusVolume(bus, fx);
      }
      this._audioDirty = false;
      return true;
    } catch (err) {
      console.warn('[ui] audio settings failed', err);
      this._audioDirty = false;
      return false;
    }
  }

  /* ====================================================================== */
  /* ERASE ALL PROGRESS                                                     */
  /* ====================================================================== */
  /**
   * What is left of the DOM half of `src/game/save.js` once the export / import
   * pair is removed. Everything about what a save IS — its
   * shape, its validation, what a wipe has to clear — lives in `game`; this
   * file only knows how to ask.
   *
   * REACHED THROUGH `ctx.peek('game')`, NEVER BY IMPORTING `game/save.js`
   * (ARCHITECTURE.md rule 2). Every call is duck-typed and wrapped, because
   * `game` is optional — the model-preview page and every headless bench boot
   * without it, and a settings menu that throws is a menu with no way out.
   */

  _toast(text, value, tone) {
    try {
      this.ctx.peek('ui')?.notify?.(text, value ?? '', tone ?? 'slag');
    } catch {
      /* the HUD is a courtesy; never let it take the click down */
    }
  }

  /**
   * Erase all progress for all three brothers, behind a `confirm()`.
   * `wipeSave()` clears every key `load()` can read
   * (the v2 slot AND the legacy one) and stands the game back up on a blank
   * save; without the second key a wipe followed by a reload handed the legacy
   * save straight back.
   *
   * No `confirm` in the environment means there is no way to ask, so the click
   * — which is already an explicit act on a button labelled "Erase all
   * progress" — stands.
   */
  wipeSave() {
    const ask = globalThis.confirm;
    if (typeof ask === 'function' &&
        !ask.call(globalThis, 'Erase all progress for all three brothers? This cannot be undone.')) {
      return false;
    }
    let ok = null;
    try {
      ok = this.ctx.peek('game')?.wipeSave?.();
    } catch (err) {
      console.warn('[ui] wipe failed', err);
      this._toast('Could not erase the save', '', 'bad');
      return false;
    }
    if (ok === undefined) {
      this._toast('No game to erase', '', 'bad');
      return false;
    }
    this._afterSaveChange();
    this._toast('Progress erased', ok === false ? 'STORAGE UNAVAILABLE' : 'ALL THREE BROTHERS', 'bad');
    return true;
  }

  /**
   * The save underneath changed. Re-render everything that reads it:
   *
   *   - the character-select cards carry chapter / cash / LAST PLAYED per
   *     brother, straight off `game.roster()`;
   *   - the chapter overview is rebuilt on every `show()`, so it only needs
   *     re-showing when it happens to be open;
   *   - this menu's own difficulty row now reads a different tier.
   *
   * All three are inside `src/ui/` — the same subsystem — so they are reached
   * directly rather than through the event bus.
   */
  _afterSaveChange() {
    const ui = this.ctx.peek('ui');
    try {
      ui?.boot?._refreshProgress?.();
    } catch (err) {
      console.warn('[ui] select cards refresh failed', err);
    }
    try {
      if (ui?.story?.open) ui.openStory?.();
    } catch (err) {
      console.warn('[ui] mission list refresh failed', err);
    }
    // The new save carries its own difficulty; the row must not go on showing
    // the one it replaced. `_difficultyPending` is cleared for the same reason
    // — a wish from before the wipe must not be re-applied over it.
    this._difficultyPending = null;
    let live = null;
    try {
      live = this.ctx.peek('game')?.difficulty;
    } catch {
      live = null;
    }
    if (typeof live === 'string') this._store('difficulty', live);
    this.syncFromConfig();
  }

  /**
   * `easy` | `normal` | `hard` | `steel`. Applied through `game.setDifficulty`
   * (which persists it in the save and scales damage, enemies and clocks) and
   * mirrored to our own store so the choice survives even before `game` has
   * initialised — `update()` re-applies a pending value once it exists.
   */
  setDifficulty(id) {
    this._store('difficulty', id);
    const g = this.ctx.peek('game');
    try {
      if (g && typeof g.setDifficulty === 'function') {
        g.setDifficulty(id);
        this._difficultyPending = null;
      } else {
        this._difficultyPending = id;
      }
    } catch {
      // `game` is registered before its init() finishes and throws until then.
      // Keep the wish pending; update() re-applies once the system is real.
      this._difficultyPending = id;
    }
    this.syncFromConfig();
  }

  /**
   * Called once from `UiSystem.init`: put every stored setting back into the
   * live engine. Quality, sensitivity, FOV and invert apply immediately
   * through the same paths the rows use; audio and difficulty self-defer
   * until their subsystems exist. Restoring emits the same `ui:*` events a
   * hand change does, so every consumer reacts identically.
   */
  restoreSettings() {
    const s = this.set;
    const cfg = this.ctx.config;
    try {
      if (typeof s.quality === 'string' && s.quality !== cfg.quality && cfg.setQuality) {
        cfg.setQuality(s.quality);
        this.ctx.events.emit('ui:quality', { quality: s.quality });
      }
    } catch (err) {
      console.warn('[ui] stored quality failed', err);
    }
    if (typeof s.sensitivity === 'number') {
      cfg.sensitivity = 0.0022 * clamp(s.sensitivity, 0.2, 3.0);
      this.ctx.events.emit('ui:sensitivity', { value: cfg.sensitivity, multiplier: s.sensitivity });
    }
    if (typeof s.fov === 'number') {
      const v = clamp(s.fov, 65, 120);
      cfg.fov = v;
      const cam = this.ctx.camera;
      if (cam) {
        cam.fov = v;
        cam.updateProjectionMatrix();
      }
      this.ctx.events.emit('ui:fov', { value: v });
    }
    if (typeof s.invertY === 'boolean') {
      cfg.invertY = s.invertY;
      this.ctx.events.emit('ui:setting', { key: 'invertY', value: s.invertY });
    }
    this._applyAudio();
    this.syncFromConfig();
  }

  syncFromConfig() {
    const cfg = this.ctx.config;
    for (let i = 0; i < this.qBtns.length; i++)
      this.qBtns[i].classList.toggle('on', PRESETS[i] === cfg.quality);
    for (const [b, v] of this.invBtns) b.classList.toggle('on', !!cfg.invertY === v);
    const s = this.set;
    // try/finally, because a latched `_silent` would silently stop persisting
    // every setting for the rest of the session — a worse bug than the one it
    // is here to fix. See `_store`.
    this._silent = true;
    try {
      this.sens?.set((cfg.sensitivity ?? 0.0022) / 0.0022);
      this.fov?.set(cfg.fov ?? 80);
      this.master?.set(typeof s.master === 'number' ? s.master : 1);
      this.music?.set(typeof s.music === 'number' ? s.music : 1);
      this.sfx?.set(typeof s.sfx === 'number' ? s.sfx : 1);
    } finally {
      this._silent = false;
    }
    for (const [b, v] of this.muteBtns ?? []) b.classList.toggle('on', !!s.mute === v);
    // `game` is in the registry before its init() completes and its getters
    // throw until then — the stored value carries the row in the meantime.
    let diff = s.difficulty ?? 'normal';
    try {
      const d = this.ctx.peek('game')?.difficulty;
      if (typeof d === 'string') diff = d;
    } catch {
      /* pre-init — fall back to the store */
    }
    for (const [b, id] of this.diffBtns ?? []) b.classList.toggle('on', id === diff);
  }

  toggle() {
    this.open ? this.close() : this.show();
  }

  show() {
    if (this.open) return;
    this.open = true;
    this.syncFromConfig();
    setStyle(this.root, 'display', '');
    document.exitPointerLock?.();
    // THE CLOCK IS NOT OURS. This used to bank `_prevScale` and write
    // `time.scale = 0` here, one of three independent owners each with a
    // private previous value — and the one that lost the argument every time,
    // because both of the others restored theirs unconditionally. `onToggle`
    // hands the fact to `ui`'s PauseArbiter, which derives the scale from every
    // live claim at once. See the header of `src/ui/index.js`.
    this.onToggle?.(true);
    this.ctx.peek('player')?.setControlEnabled?.(false);
    this.ctx.events.emit('ui:pause', { paused: true });
  }

  close() {
    if (!this.open) return;
    this.open = false;
    this.onToggle?.(false);
    this.ctx.peek('player')?.setControlEnabled?.(true);
    // Re-locking is a nice-to-have, not part of resuming: Chrome refuses a lock
    // request for ~1 s after the user exited one with Escape, and it refuses
    // one made outside a user gesture. Either way the game is already running
    // again, and the next click on the world locks the pointer as usual.
    this.ctx.input?.requestPointerLock?.();
    this.ctx.events.emit('ui:pause', { paused: false });
  }

  /** Driven with unscaled time so the fade still runs while the game is frozen. */
  update(rawDt) {
    // Deferred restores: audio's mixer and `game` both come up after us.
    // One peek per frame until each has landed, then never again.
    if (this._audioDirty) this._applyAudio();
    if (this._difficultyPending) {
      const g = this.ctx.peek('game');
      if (g && typeof g.setDifficulty === 'function') {
        const want = this._difficultyPending;
        try {
          // `missions.difficulty` resets to 'normal' every boot even though
          // the save remembers the tier — re-applying is what restores it.
          if (g.difficulty !== want || g.missions?.difficulty !== want) g.setDifficulty(want);
          this._difficultyPending = null;
        } catch {
          /* game still initialising — retry next frame */
        }
      }
    }
    this.shown = damp(this.shown, this.open ? 1 : 0, 14, rawDt);
    if (this.shown < 0.004) {
      setStyle(this.root, 'display', 'none');
      setStyle(this.root, 'pointer-events', 'none');
      return;
    }
    setStyle(this.root, 'display', '');
    setStyle(this.root, 'pointer-events', this.open ? 'auto' : 'none');
    setStyle(this.root, 'opacity', ease.outQuad(this.shown).toFixed(3));
  }

  dispose() {
    removeEventListener('keydown', this._onKey, true);
    document.removeEventListener('pointerlockchange', this._onLockChange);
    this.root.remove();
    document.getElementById('ow-menu-controls-style')?.remove();
    controlsCssInstalled = false;
  }
}
