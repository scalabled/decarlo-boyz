/**
 * ===========================================================================
 * TOUCH CONTROLS — the layer that makes this game playable on a phone
 * ===========================================================================
 *
 * The joystick, the camera zone, the `hold`/`tap` helpers, the touch-device test
 * and the iOS guards, spelled out in `CONTROLS.md`. Without this file the game
 * has NO touch input at all: on a phone you can look at Steel City and nothing
 * else.
 *
 * ---------------------------------------------------------------------------
 * THE ONE IDEA THAT MATTERS: everything funnels into `core/input`
 * ---------------------------------------------------------------------------
 * A parallel touch input path would have meant every consumer
 * (`player.movement`, `player.vehicles`, `game.freeroam`, `weapons`) growing a
 * second branch, and the two would drift. So nothing here talks to gameplay.
 * The joystick, the drag zone and the buttons all write into the SAME
 * `ctx.input` that the keyboard writes into, using the codes `ACTIONS` in
 * `src/core/input.js` already binds:
 *
 *     joystick      -> input.stick.moveX / moveY   (the gamepad left stick)
 *     camera drag   -> input._rawLook.x / y        (the same accumulator the
 *                                                   mouse writes, so it is
 *                                                   scaled by config.sensitivity
 *                                                   in beginFrame like any mouse)
 *     FIRE          -> Mouse0        AIM   -> Mouse2
 *     RUN           -> ShiftLeft     BRAKE -> Space   (jump on foot)
 *     ACT           -> KeyF          WEP   -> KeyE, held: Tab (weapon wheel)
 *     HORN          -> KeyH   (only while driving)
 *
 * The consequence is that touch is not a special case anywhere else in the
 * codebase, and `tools/playprobe.mjs` — which drives the real keyboard path —
 * is testing the touch path too.
 *
 * The one subtlety is the stick. `Input._pollGamepad()` runs at the top of
 * every frame and unconditionally overwrites `input.stick`, so writing to it
 * from `lateUpdate` would be erased before anything read it. Rather than
 * monkey-patching a private method (or, worse, editing `src/core/`, which this
 * subsystem does not own), `moveX`/`moveY` are replaced with accessors that
 * return the touch value while a thumb is down and the gamepad's value
 * otherwise. The gamepad poll still writes through the setter, so a controller
 * keeps working, and `dispose()` puts the plain data properties back.
 */

import { el, svg, setText, setStyle, setClass, clamp } from './util.js';

/* ------------------------------------------------------------------ codes -- */

const K = {
  fire: 'Mouse0',
  aim: 'Mouse2',
  sprint: 'ShiftLeft',
  brake: 'Space',
  act: 'KeyF',
  wep: 'KeyE',
  wheel: 'Tab',
  horn: 'KeyH',
};

/**
 * The `innerWidth <= 760` clause is what makes the controls appear in a narrow
 * desktop window and — deliberately — in the capture harness at 390x844, so a
 * phone layout can be screenshotted at all.
 */
export function isTouchDevice() {
  if (typeof window === 'undefined') return false;
  if (window.__FORCE_TOUCH__ === true) return true;
  if (window.__FORCE_TOUCH__ === false) return false;
  if ('ontouchstart' in window) return true;
  if ((navigator.maxTouchPoints ?? 0) > 0) return true;
  // A bare `innerWidth <= 760` is correct for a phone held upright and WRONG
  // for the same phone turned sideways — 844x390 is 844 wide and would be
  // treated as a desktop. The short edge is the honest test: no desktop window
  // is 390 px tall.
  return window.innerWidth <= 760 || Math.min(window.innerWidth, window.innerHeight) <= 500;
}

/* ------------------------------------------------------------------ icons -- */

/** 24x24 line icons. Stroked, no fill — they read at 22 px over a bright sky. */
const ICONS = {
  fire: 'M12 3v3M12 18v3M3 12h3M18 12h3M12 8.4a3.6 3.6 0 100 7.2 3.6 3.6 0 000-7.2z',
  aim: 'M12 2v4M12 18v4M2 12h4M18 12h4M12 6.5a5.5 5.5 0 100 11 5.5 5.5 0 000-11z',
  run: 'M13.5 4.6a1.6 1.6 0 100-.1M11 21l1.6-5.2-2.6-2.4.9-4.6L8 10.6 6.4 14M12.6 9.2l3.1 1.5 2.6-1.2M10.9 13.4l3.4 2.2 1.2 4.6',
  brake: 'M6 6l12 12M18 6L6 18M12 2.6a9.4 9.4 0 100 18.8 9.4 9.4 0 000-18.8z',
  jump: 'M12 20V5M6.5 10.5L12 4.6l5.5 5.9M5 21h14',
  enter: 'M4 4h9v16H4zM16 12H8.6M16 12l-3.2-3.4M16 12l-3.2 3.4M18 4h2v16h-2',
  exit: 'M20 4h-9v16h9M8 12h7.4M8 12l3.2-3.4M8 12l3.2 3.4M6 4H4v16h2',
  wep: 'M3 9h13l2 3h3v3h-4l-2 3h-4l-1-3H6a3 3 0 01-3-3V9zM8 15v3',
  horn: 'M4 9v6h3l6 4V5L7 9H4zM17 8.5a5 5 0 010 7M20 6a9 9 0 010 12',
  map: 'M9 4L3 6.5v13L9 17l6 2.5 6-2.5v-13L15 6.5 9 4zM9 4v13M15 6.5v13',
  phone: 'M7.5 2.4h9v19.2h-9zM10.6 19.4h2.8',
  radio: 'M3 9.5h18v11H3zM7 15a1.6 1.6 0 103.2 0A1.6 1.6 0 007 15zM14 13.5h4M14 16.5h4M6.5 6.5L18 3',
  menu: 'M4 7h16M4 12h16M4 17h16',
  flag: 'M6 21V4M6 5h11l-2.5 3.5L17 12H6',
  swap: 'M4 8h13l-3-3M20 16H7l3 3',
  spray: 'M8 9h7v12H8zM8 6h7V3H8zM18 5v1M20 7v1M18 9v1M20 11v1',
  fuel: 'M4 21V4h9v17M4 12h9M16 8l2 2v8a1.6 1.6 0 003.2 0V9l-2.6-3M3 21h11',
  bed: 'M3 18v-6h11a4 4 0 014 4v2M3 18v-8M3 18h18M6.5 12V9h5v3',
  hand: 'M9 12V5.6a1.5 1.5 0 013 0V12M12 11V4.6a1.5 1.5 0 013 0V12M15 12V6.6a1.5 1.5 0 013 0V15a6 6 0 01-6 6h-1a5 5 0 01-4.4-2.6L4 13.4a1.6 1.6 0 012.6-1.8L9 14',
  star: 'M12 3.4l2.6 5.6 6 .8-4.4 4.2 1.1 6-5.3-3-5.3 3 1.1-6L3.4 9.8l6-.8L12 3.4z',
  bug: 'M9 6a3 3 0 016 0M6 10h12M7 10v4a5 5 0 0010 0v-4M3 12h4M17 12h4M4.5 7.5L7 9M19.5 7.5L17 9M4.5 17.5L7 16M19.5 17.5L17 16',
  // Throttle / collective: a double chevron reads as "more / less". Up is the
  // aeroplane's throttle-up and the helicopter's climb; down is the reverse.
  climb: 'M6 13l6-6 6 6M6 19l6-6 6 6',
  descend: 'M6 11l6 6 6-6M6 5l6 6 6-6',
};

/**
 * The action verb is what the button SAYS; the icon is what it looks like.
 * Both are derived from the prompt text that `game`/`player` already publish
 * through `ui.setPrompt`, so no other subsystem has to learn a new API.
 */
const VERBS = [
  [/^EXIT|GET OUT/, 'EXIT', 'exit'],
  [/^TAKE|^ENTER|^GET IN/, 'TAKE', 'enter'],
  [/^COMMANDEER|^STEAL|^JACK|^PULL OUT/, 'STEAL', 'enter'],
  [/^SWAP|^SWITCH/, 'SWAP', 'swap'],
  [/RESPRAY|NEW COLOUR|NEW COLOR|SPRAY/, 'SPRAY', 'spray'],
  [/^SLEEP|^REST|MORNING|^BED/, 'SLEEP', 'bed'],
  [/^SAVE|SAFEHOUSE|^HOME/, 'SAVE', 'bed'],
  [/PUMP|FUEL|^FILL|TANK|^GAS/, 'FUEL', 'fuel'],
  [/REPAIR|DENT|BODY ?SHOP|SOUND|^FIX/, 'FIX', 'spray'],
  [/AMMO|AMMUNITION|ROUNDS|^BUY/, 'BUY', 'wep'],
  [/^EAT|FOOD|SANDWICH|DINER|HEALTH/, 'EAT', 'hand'],
  [/RACE|CIRCUIT|^START/, 'RACE', 'star'],
  [/^PICK|^GRAB|^COLLECT|PACKAGE/, 'GRAB', 'hand'],
];

/** "TAKE THE ALLEGHENY 4DR" -> { verb:'TAKE', icon:'enter' } */
export function verbFor(text, inVehicle) {
  const t = String(text ?? '').toUpperCase().trim();
  if (!t) return inVehicle ? { verb: 'EXIT', icon: 'exit' } : { verb: 'USE', icon: 'hand' };
  for (const [re, verb, icon] of VERBS) if (re.test(t)) return { verb, icon };
  const first = t.split(/[^A-Z0-9']+/)[0] || 'USE';
  return { verb: first.slice(0, 7), icon: 'hand' };
}

/* ------------------------------------------------------------------ bridge -- */

const TAP_SLOTS = 10;

/**
 * The only thing in `src/ui/` that writes to `ctx.input`. Everything it does is
 * reversible: `dispose()` restores the stick's plain properties and releases
 * every code it is still holding, so a HUD teardown can never leave the player
 * running forward forever.
 */
class InputBridge {
  constructor(input) {
    this.input = input;
    this.stickActive = false;
    this.stickX = 0;
    this.stickY = 0;
    this._held = new Set();
    this._restoreStick = null;
    this._taps = new Array(TAP_SLOTS);
    for (let i = 0; i < TAP_SLOTS; i++) this._taps[i] = { code: '', t: 0, alive: false };
    this._installStick();
  }

  get live() {
    const i = this.input;
    return !!i && i.enabled !== false && i.frozen !== true;
  }

  _installStick() {
    const s = this.input?.stick;
    if (!s) return;
    const dx = Object.getOwnPropertyDescriptor(s, 'moveX');
    const dy = Object.getOwnPropertyDescriptor(s, 'moveY');
    // Already an accessor (double-install, or core grew its own touch stick):
    // leave it alone rather than shadowing somebody else's implementation.
    if (!dx || !dy || dx.get || dy.get) return;
    let gx = s.moveX ?? 0;
    let gy = s.moveY ?? 0;
    const self = this;
    Object.defineProperty(s, 'moveX', {
      configurable: true,
      enumerable: true,
      get() { return self.stickActive ? self.stickX : gx; },
      set(v) { gx = v; },
    });
    Object.defineProperty(s, 'moveY', {
      configurable: true,
      enumerable: true,
      get() { return self.stickActive ? self.stickY : gy; },
      set(v) { gy = v; },
    });
    this._restoreStick = () => {
      delete s.moveX;
      delete s.moveY;
      s.moveX = gx;
      s.moveY = gy;
    };
  }

  /**
   * `x` right, `y` DOWN, both -1..1 — screen space, which is also the gamepad
   * convention `Input.moveVector` expects (`y -= stick.moveY`), so pushing the
   * thumb up walks forward with no sign juggling anywhere.
   */
  setStick(x, y) {
    this.stickX = x;
    this.stickY = y;
    this.stickActive = true;
  }

  clearStick() {
    this.stickX = 0;
    this.stickY = 0;
    this.stickActive = false;
  }

  /** Screen-pixel drag delta, straight into the mouse-look accumulator. */
  look(dx, dy) {
    if (!this.live) return;
    const raw = this.input._rawLook;
    if (raw) {
      raw.x += dx;
      raw.y += dy;
    } else if (this.input.look) {
      this.input.look.x += dx;
      this.input.look.y += dy;
    }
  }

  down(code) {
    if (!this.live || this._held.has(code)) return;
    this._held.add(code);
    const i = this.input;
    if (i._pendingDown?.add) i._pendingDown.add(code);
    else this._dispatch(code, true);
  }

  up(code) {
    if (!this._held.delete(code)) return;
    const i = this.input;
    if (!i) return;
    if (i._pendingUp?.add) i._pendingUp.add(code);
    else this._dispatch(code, false);
  }

  /**
   * A press that releases itself. Held for a beat rather than a single frame
   * because some consumers sample `input.action('use')` (a level) as well as
   * `actionPressed` (an edge), and a one-frame blip is easy to miss when the
   * fixed step and the render frame disagree.
   */
  tap(code, hold = 0.12) {
    this.down(code);
    for (const t of this._taps) {
      if (t.alive) continue;
      t.alive = true;
      t.code = code;
      t.t = hold;
      return;
    }
    // Pool exhausted (never in practice): release immediately rather than stick.
    this.up(code);
  }

  isHeld(code) {
    return this._held.has(code);
  }

  update(dt) {
    for (const t of this._taps) {
      if (!t.alive) continue;
      t.t -= dt;
      if (t.t > 0) continue;
      t.alive = false;
      this.up(t.code);
    }
  }

  releaseAll() {
    for (const t of this._taps) t.alive = false;
    for (const code of Array.from(this._held)) this.up(code);
    this.clearStick();
  }

  _dispatch(code, down) {
    // Fallback path for an `Input` without the pending sets. Keyboard codes go
    // through a real KeyboardEvent; the two mouse buttons through MouseEvent.
    const type = down ? 'down' : 'up';
    if (code.startsWith('Mouse')) {
      const button = Number(code.slice(5)) || 0;
      dispatchEvent(new MouseEvent('mouse' + type, { button, bubbles: true }));
    } else {
      dispatchEvent(new KeyboardEvent('key' + type, { code, bubbles: true }));
    }
  }

  dispose() {
    this.releaseAll();
    this._restoreStick?.();
    this._restoreStick = null;
  }
}

/* --------------------------------------------------------------- the layer -- */

/** iOS pinch/double-tap-zoom guards are document-level and installed once. */
let guardsInstalled = false;
let guardOff = null;

function installGestureGuards() {
  if (guardsInstalled) return;
  guardsInstalled = true;
  const noGesture = (e) => e.preventDefault();
  // Safari-only, and it is the only way to stop pinch-zoom over the canvas.
  document.addEventListener('gesturestart', noGesture, { passive: false });
  document.addEventListener('gesturechange', noGesture, { passive: false });

  // Double-tap zoom. Swallow a touchend within 300 ms of the previous one
  // UNLESS it lands in a menu — the pause menu, the pause map and the phone all
  // have real buttons and must stay tappable at speed.
  let lastEnd = 0;
  const onEnd = (e) => {
    const t = Date.now();
    // `.ow-map` is the pause map's real class — the old '.ow-pausemap' entry
    // matched nothing, so fast taps on the map's controls were being eaten.
    if (t - lastEnd < 300 &&
        !e.target?.closest?.('.ow-menu, .ow-map, .ow-phone, .ow-story, .ow-end, .ow-modal, .ow-boot')) {
      e.preventDefault();
    }
    lastEnd = t;
  };
  document.addEventListener('touchend', onEnd, { passive: false });

  guardOff = () => {
    document.removeEventListener('gesturestart', noGesture);
    document.removeEventListener('gesturechange', noGesture);
    document.removeEventListener('touchend', onEnd);
    guardsInstalled = false;
    guardOff = null;
  };
}

export class TouchControls {
  /**
   * @param {HTMLElement} zoneLayer  BELOW the HUD — holds only the drag zone,
   *                                 so every HUD tap target wins over it.
   * @param {HTMLElement} uiLayer    ABOVE the HUD — the joystick and buttons.
   * @param {object} ui              the UiSystem, for the action/notify path
   */
  constructor(zoneLayer, uiLayer, ctx, ui) {
    this.ctx = ctx;
    this.ui = ui;
    this.bridge = new InputBridge(ctx.input);
    this.active = false;
    this.visible = false;
    this.tk = 1;
    this.portrait = true;
    /** Multiplier on the drag-to-look gain, on top of config.sensitivity. */
    this.lookGain = 1.25;

    this._offs = [];
    this._tapTargets = [];
    this._joyId = null;
    this._joyCx = 0;
    this._joyCy = 0;
    this._joyR = 50;
    this._camId = null;
    this._camX = 0;
    this._camY = 0;
    this._wepDown = -1;
    this._wheelOpen = false;
    this._verb = '';
    this._icon = '';

    /* ---- drag zone (below everything) ---------------------------------- */
    this.zone = el('div', 'ow-tzone', zoneLayer);
    this._bindCamZone();

    /* ---- the control furniture (above everything) ---------------------- */
    this.root = uiLayer;

    this.joy = el('div', 'ow-tjoy', this.root);
    el('i', 'ow-tjoy-ring', this.joy);
    this.knob = el('i', 'ow-tjoy-knob', this.joy);
    this._bindJoystick();

    // The contextual action, spelled out. This is the mobile face of the one
    // idea in CONTROLS.md: the player is never guessing what a button does.
    this.actLabel = el('div', 'ow-tact-label', this.root);
    this.actLabelText = el('span', null, this.actLabel, '');

    this.btns = el('div', 'ow-tbtns', this.root);
    const row1 = el('div', 'ow-trow', this.btns);
    const row2 = el('div', 'ow-trow', this.btns);

    this.bAim = this._button(row1, 'aim', 'AIM', 'aim');
    this.bWep = this._button(row1, 'wep', 'WEP', 'wep');
    this.bAct = this._button(row1, 'act', 'ACT', 'enter');
    this.bBrake = this._button(row2, 'brake', 'JUMP', 'jump');
    this.bRun = this._button(row2, 'run', 'RUN', 'run');
    this.bFire = this._button(row2, 'fire', 'FIRE', 'fire');

    this._hold(this.bFire, K.fire);
    this._hold(this.bAim, K.aim);
    this._hold(this.bRun, K.sprint);
    this._hold(this.bBrake, K.brake);
    this._tap(this.bAct, () => this._onAct());
    this._weaponButton(this.bWep);

    /* ---- HUD taps: map, job board, phone, radio, pause ----------------- */
    this.nav = el('div', 'ow-tnav', this.root);
    this.nMap = this._navButton('map', 'MAP');
    // The mission action: KeyJ (start / skip a chapter) had no touch face at
    // all — a touch player could see 'PRESS J' and press nothing. `ui`
    // resolves what the tap means (story overview when idle, J when a mission
    // wants skipping).
    this.nJob = this._navButton('flag', 'JOB');
    this.nPhone = this._navButton('phone', 'PHONE');
    this.nRadio = this._navButton('radio', 'RADIO');
    this.nMenu = this._navButton('menu', 'MENU');
    // The cheat / test menu, only when it exists at all (never under
    // `?capture=1` or `navigator.webdriver` — see `cheatsEnabled()` in
    // src/ui/cheats.js). It goes LAST so `.ow-tnav-btn` still selects MAP,
    // which is what `src/ui/touchprobe.mjs` reaches for.
    //
    // It is a convenience, not the touch player's only door: this whole row is
    // hidden under a modal, so the panel's own always-live edge button, its ✕
    // and its CLOSE button are what actually get you back out.
    this.nCheat = ui.cheats ? this._navButton('bug', 'CHEATS') : null;
    this._tap(this.nMap, () => ui.toggleMap());
    this._tap(this.nJob, () => ui.missionAction('touch'));
    this._tap(this.nPhone, () => ui.phone.toggle());
    this._tap(this.nRadio, () => ui.cycleStation(1));
    this._tap(this.nMenu, () => ui.menu.toggle());
    if (this.nCheat) this._tap(this.nCheat, () => ui.cheats?.toggle());

    installGestureGuards();
    // `setVisible` is the sole owner of `display` on both layers (it is driven
    // every frame from `ui.lateUpdate`); start hidden so a modal that is
    // already up at boot never flashes a joystick over itself.
    setStyle(this.root, 'display', 'none');
    setStyle(this.zone, 'display', 'none');
    this.setActive(isTouchDevice());
  }

  /* ------------------------------------------------------------ building -- */

  _button(row, kind, label, icon) {
    const b = el('div', 'ow-tbtn ' + kind, row);
    const s = svg('svg', { viewBox: '0 0 24 24', class: 'ow-tbtn-ic' }, b);
    const p = svg('path', { d: ICONS[icon] ?? '', fill: 'none', 'stroke-width': '1.7',
      'stroke-linecap': 'round', 'stroke-linejoin': 'round' }, s);
    b._path = p;
    b._icon = icon;
    b._label = el('small', null, b, label);
    return b;
  }

  _navButton(icon, title) {
    const b = el('div', 'ow-tnav-btn', this.nav);
    b.setAttribute('aria-label', title);
    const s = svg('svg', { viewBox: '0 0 24 24' }, b);
    svg('path', { d: ICONS[icon], fill: 'none', 'stroke-width': '1.7',
      'stroke-linecap': 'round', 'stroke-linejoin': 'round' }, s);
    return b;
  }

  _setIcon(btn, icon) {
    if (btn._icon === icon) return;
    btn._icon = icon;
    btn._path.setAttribute('d', ICONS[icon] ?? '');
  }

  /* -------------------------------------------------------------- events -- */

  /**
   * Held button. `touchstart`/`touchend` are `{passive:false}` because both
   * call `preventDefault` — without it iOS fires a synthetic 300 ms-late click
   * and scrolls the page under the finger. `mouseleave` is the desktop escape
   * hatch: dragging off a button must not leave the code stuck down.
   */
  _hold(node, code) {
    const down = (e) => {
      e.preventDefault();
      setClass(node, 'held', true);
      this.bridge.down(code);
    };
    const up = (e) => {
      e?.preventDefault?.();
      setClass(node, 'held', false);
      this.bridge.up(code);
    };
    node.addEventListener('touchstart', down, { passive: false });
    node.addEventListener('touchend', up, { passive: false });
    node.addEventListener('touchcancel', up, { passive: false });
    node.addEventListener('mousedown', down);
    node.addEventListener('mouseup', up);
    node.addEventListener('mouseleave', () => up());
    this._offs.push(() => {
      node.removeEventListener('touchstart', down);
      node.removeEventListener('touchend', up);
      node.removeEventListener('touchcancel', up);
    });
  }

  /**
   * Make an existing HUD readout tappable. `.ow-hud` is `pointer-events:none`
   * wholesale, so the element has to opt in — which is why this is a method
   * here rather than a stylesheet rule: on desktop these must stay inert or
   * they would eat clicks meant for pointer lock.
   */
  tapTarget(node, fn) {
    if (!node) return;
    setStyle(node, 'touch-action', 'none');
    setStyle(node, 'pointer-events', this.active ? 'auto' : 'none');
    this._tapTargets.push(node);
    this._tap(node, () => { if (this.active && this.visible) fn(); });
  }

  /** Tap button. Touch wins; the click handler is the desktop/harness path. */
  _tap(node, fn) {
    let touched = 0;
    const t = (e) => {
      e.preventDefault();
      touched = Date.now();
      setClass(node, 'held', true);
      fn();
      setTimeout(() => setClass(node, 'held', false), 110);
    };
    const c = (e) => {
      e.preventDefault();
      // Ignore the synthetic click that follows a real touch.
      if (Date.now() - touched < 700) return;
      setClass(node, 'held', true);
      fn();
      setTimeout(() => setClass(node, 'held', false), 110);
    };
    node.addEventListener('touchstart', t, { passive: false });
    node.addEventListener('click', c);
    this._offs.push(() => {
      node.removeEventListener('touchstart', t);
      node.removeEventListener('click', c);
    });
  }

  /**
   * WEP is three controls in one.
   *   on foot, tap   -> next weapon (KeyE)
   *   on foot, hold  -> the weapon wheel (Tab), which `ui._input` already
   *                     drives, and which the camera drag then aims — so all
   *                     sixteen weapons are reachable with one thumb.
   *   driving        -> the horn (KeyH), held.
   */
  _weaponButton(node) {
    const start = (e) => {
      e.preventDefault();
      setClass(node, 'held', true);
      if (this._inVehicle()) {
        this.bridge.down(K.horn);
        return;
      }
      this._wepDown = performance.now();
    };
    const end = (e) => {
      e?.preventDefault?.();
      setClass(node, 'held', false);
      if (this.bridge.isHeld(K.horn)) {
        this.bridge.up(K.horn);
        return;
      }
      if (this._wepDown < 0) return;
      const heldMs = performance.now() - this._wepDown;
      this._wepDown = -1;
      if (this._wheelOpen) {
        this._wheelOpen = false;
        this.bridge.up(K.wheel);
      } else if (heldMs < 1000) {
        this.bridge.tap(K.wep);
      }
    };
    node.addEventListener('touchstart', start, { passive: false });
    node.addEventListener('touchend', end, { passive: false });
    node.addEventListener('touchcancel', end, { passive: false });
    node.addEventListener('mousedown', start);
    node.addEventListener('mouseup', end);
    node.addEventListener('mouseleave', () => { if (this._wepDown >= 0 || this._wheelOpen) end(); });
    this._offs.push(() => {
      node.removeEventListener('touchstart', start);
      node.removeEventListener('touchend', end);
      node.removeEventListener('touchcancel', end);
    });
  }

  /**
   * The joystick. `touch.identifier` tracking is the whole trick: without it a
   * second finger anywhere on screen retargets the knob and the player walks
   * off in whatever direction the FIRE thumb happens to be.
   */
  _bindJoystick() {
    const start = (e) => {
      e.preventDefault();
      if (this._joyId !== null) return;
      const t = e.changedTouches[0];
      this._joyBegin(t.clientX, t.clientY, t.identifier);
    };
    const move = (e) => {
      e.preventDefault();
      for (const t of e.changedTouches) {
        if (t.identifier === this._joyId) this._joyMove(t.clientX, t.clientY);
      }
    };
    const end = (e) => {
      e.preventDefault();
      for (const t of e.changedTouches) {
        if (t.identifier === this._joyId) this._joyEnd();
      }
    };
    this.joy.addEventListener('touchstart', start, { passive: false });
    this.joy.addEventListener('touchmove', move, { passive: false });
    this.joy.addEventListener('touchend', end, { passive: false });
    this.joy.addEventListener('touchcancel', end, { passive: false });

    // Mouse path so the joystick is testable in a desktop browser and by the
    // capture harness without touch emulation.
    const mdown = (e) => {
      e.preventDefault();
      this._joyBegin(e.clientX, e.clientY, 'mouse');
      const mm = (ev) => this._joyMove(ev.clientX, ev.clientY);
      const mu = () => {
        this._joyEnd();
        removeEventListener('mousemove', mm);
        removeEventListener('mouseup', mu);
      };
      addEventListener('mousemove', mm);
      addEventListener('mouseup', mu);
    };
    this.joy.addEventListener('mousedown', mdown);
    this._offs.push(() => {
      this.joy.removeEventListener('touchstart', start);
      this.joy.removeEventListener('touchmove', move);
      this.joy.removeEventListener('touchend', end);
      this.joy.removeEventListener('touchcancel', end);
      this.joy.removeEventListener('mousedown', mdown);
    });
  }

  _joyBegin(x, y, id) {
    const rc = this.joy.getBoundingClientRect();
    this._joyCx = rc.left + rc.width / 2;
    this._joyCy = rc.top + rc.height / 2;
    this._joyR = Math.max(24, rc.width / 2 - 10 * this.tk);
    this._joyId = id;
    setClass(this.joy, 'on', true);
    this._joyMove(x, y);
  }

  _joyMove(x, y) {
    let dx = x - this._joyCx;
    let dy = y - this._joyCy;
    const r = this._joyR;
    const d = Math.hypot(dx, dy);
    if (d > r) {
      dx = (dx / d) * r;
      dy = (dy / d) * r;
    }
    setStyle(this.knob, 'transform',
      `translate(calc(-50% + ${dx.toFixed(1)}px), calc(-50% + ${dy.toFixed(1)}px))`);
    // A small dead zone: a thumb resting on the pad must not creep.
    const nx = dx / r;
    const ny = dy / r;
    const len = Math.hypot(nx, ny);
    if (len < 0.12) this.bridge.setStick(0, 0);
    else {
      const s = ((len - 0.12) / 0.88) / len;
      this.bridge.setStick(clamp(nx * s, -1, 1), clamp(ny * s, -1, 1));
    }
  }

  _joyEnd() {
    this._joyId = null;
    setClass(this.joy, 'on', false);
    setStyle(this.knob, 'transform', 'translate(-50%,-50%)');
    this.bridge.clearStick();
  }

  /**
   * The camera drag zone. `{passive:true}` throughout — it never calls
   * `preventDefault`, and declaring that lets the browser scroll-optimise
   * instead of waiting on every move to see whether we will cancel it.
   * `touch-action:none` in the stylesheet is what actually stops the scroll.
   */
  _bindCamZone() {
    const start = (e) => {
      if (this._camId !== null) return;
      const t = e.changedTouches[0];
      this._camId = t.identifier;
      this._camX = t.clientX;
      this._camY = t.clientY;
    };
    const move = (e) => {
      for (const t of e.changedTouches) {
        if (t.identifier !== this._camId) continue;
        const g = this.lookGain;
        this.bridge.look((t.clientX - this._camX) * g, (t.clientY - this._camY) * g);
        this._camX = t.clientX;
        this._camY = t.clientY;
      }
    };
    const end = (e) => {
      for (const t of e.changedTouches) if (t.identifier === this._camId) this._camId = null;
    };
    this.zone.addEventListener('touchstart', start, { passive: true });
    this.zone.addEventListener('touchmove', move, { passive: true });
    this.zone.addEventListener('touchend', end, { passive: true });
    this.zone.addEventListener('touchcancel', end, { passive: true });
    this._offs.push(() => {
      this.zone.removeEventListener('touchstart', start);
      this.zone.removeEventListener('touchmove', move);
      this.zone.removeEventListener('touchend', end);
      this.zone.removeEventListener('touchcancel', end);
    });
  }

  /* --------------------------------------------------------------- state -- */

  _inVehicle() {
    return !!this.ui?.state?.inVehicle;
  }

  /**
   * The `kind` of the vehicle the player is seated in ('car' | 'plane' | 'heli'
   * | 'boat' | ...), or null on foot. Duck-typed off the player's handler so a
   * headless bench without `player` reads null and the layer stays in its
   * driving/walking roles. It is what swaps the two vertical buttons into their
   * FLIGHT roles in `update` — the throttle and the collective.
   */
  _vehicleKind() {
    if (!this._inVehicle()) return null;
    try {
      return this.ctx?.peek?.('player')?.vehicles?.vehicle?.spec?.kind ?? null;
    } catch {
      return null;
    }
  }

  _onAct() {
    this.ui.triggerAction('touch');
  }

  setActive(on) {
    if (this.active === on) return;
    this.active = on;
    if (!on) this.bridge.releaseAll();
    setClass(this.zone, 'on', on);
    // On a true desktop the HUD readouts must go back to being inert, or a
    // click on the minimap never reaches the canvas and pointer lock is lost.
    for (const n of this._tapTargets) setStyle(n, 'pointer-events', on ? 'auto' : 'none');
  }

  /** Hidden while a modal owns the screen, or when the HUD is faded out. */
  setVisible(v) {
    if (this.visible === v) return;
    this.visible = v;
    setStyle(this.root, 'display', v ? '' : 'none');
    setStyle(this.zone, 'display', v ? '' : 'none');
    if (!v) {
      this.bridge.releaseAll();
      this._joyEnd();
      this._camId = null;
      this._wepDown = -1;
      this._wheelOpen = false;
      for (const b of [this.bFire, this.bAim, this.bRun, this.bBrake, this.bWep, this.bAct]) {
        setClass(b, 'held', false);
      }
    }
  }

  /**
   * @param {object} a  ui.action — { available, verb, icon, label }
   */
  setAction(a) {
    const verb = a.verb || 'USE';
    if (verb !== this._verb) {
      this._verb = verb;
      setText(this.bAct._label, verb);
    }
    this._setIcon(this.bAct, a.icon || 'hand');
    setClass(this.bAct, 'off', !a.available);
    setClass(this.actLabel, 'on', !!a.label);
    setText(this.actLabelText, a.label ?? '');
  }

  update(rawDt) {
    this.bridge.update(rawDt);
    if (!this.active) return;

    // Long-press on WEP opens the weapon wheel. Done here rather than on a
    // setTimeout so it freezes with the rest of the HUD when the game pauses.
    if (this._wepDown >= 0 && !this._wheelOpen && performance.now() - this._wepDown > 340) {
      this._wheelOpen = true;
      this.bridge.down(K.wheel);
    }

    const driving = this._inVehicle();
    const kind = this._vehicleKind();
    const flying = kind === 'plane' || kind === 'heli';

    /**
     * THE TWO VERTICAL BUTTONS ARE CONTEXT-SWAPPED, WIRED TO THE SAME CODES.
     *
     * RUN is `ShiftLeft` and BRAKE is `Space` in every context — the codes never
     * change, so no new input path is invented (CONTROLS.md's whole thesis). What
     * changes is the ROLE the current vehicle reads them as, and the label/icon
     * follow it:
     *
     *   on foot   RUN = sprint,  BRAKE = jump
     *   in a car  RUN = boost (greyed nitro), BRAKE = handbrake
     *   AEROPLANE RUN = throttle UP (input.boost), BRAKE = throttle DOWN / brake
     *             (input.handbrake) — see plane.js
     *   HELICOPTER RUN = descend (input.boost), BRAKE = climb (input.handbrake)
     *             — see heli.js (SPACE climbs, SHIFT descends)
     *
     * Pitch/roll (plane) and cyclic/pedals (heli) are the JOYSTICK already — it
     * writes the same `control.throttle/brake/steer` the elevator and ailerons
     * read — so the stick needs no special case here.
     */
    let brakeLabel, brakeIcon, runLabel, runIcon;
    if (kind === 'heli') {
      brakeLabel = 'CLIMB'; brakeIcon = 'climb';
      runLabel = 'DESC'; runIcon = 'descend';
    } else if (flying) {
      brakeLabel = 'THR-'; brakeIcon = 'descend';
      runLabel = 'THR+'; runIcon = 'climb';
    } else if (driving) {
      brakeLabel = 'BRAKE'; brakeIcon = 'brake';
      runLabel = 'RUN'; runIcon = 'run';
    } else {
      brakeLabel = 'JUMP'; brakeIcon = 'jump';
      runLabel = 'RUN'; runIcon = 'run';
    }
    setText(this.bBrake._label, brakeLabel);
    this._setIcon(this.bBrake, brakeIcon);
    setText(this.bRun._label, runLabel);
    this._setIcon(this.bRun, runIcon);
    setText(this.bWep._label, driving ? 'HORN' : 'WEP');
    this._setIcon(this.bWep, driving ? 'horn' : 'wep');
    // AIM is meaningless in any vehicle. RUN is a live throttle in the air but
    // the greyed-out nitro in a ground vehicle, so it is only dimmed for a car.
    setClass(this.bAim, 'off', driving);
    setClass(this.bRun, 'off', driving && !flying);
  }

  /**
   * The controls scale with the SHORT screen edge — a thumb is the same size on
   * a 390 px phone in either orientation, so scaling off height (as --k does)
   * would make the landscape buttons uselessly small.
   *
   * It also publishes the two BANDS it occupies, in px, onto the HUD root:
   * `--tband-l` (the joystick's reach up the left edge) and `--tband-r` (the
   * button cluster's up the right). The Slag Ring, the weapon chip and the
   * subtitles are positioned off those rather than off numbers copied by hand,
   * so changing a button size here can never silently bury the minimap.
   */
  resize(w, h) {
    const portrait = h >= w;
    this.portrait = portrait;
    this.tk = clamp(Math.min(w, h) / 700, 0.6, 1.3);
    const tk = this.tk;
    setStyle(this.root, '--tk', tk.toFixed(3));
    setStyle(this.zone, '--tk', tk.toFixed(3));
    setClass(this.root, 'land', !portrait);

    const base = (portrait ? 22 : 13) * tk;
    const joyH = (portrait ? 208 : 184) * tk;
    // btn row + fire row + the gap between them, from the stylesheet.
    const btnH = (100 + 124 + 15) * tk;
    const host = this.root.parentElement ?? this.root;
    host.style.setProperty('--tjoy-size', joyH.toFixed(1) + 'px');
    host.style.setProperty('--tband-l', (base + joyH + 12 * tk).toFixed(1) + 'px');
    host.style.setProperty('--tband-r', (base + btnH + 12 * tk).toFixed(1) + 'px');
    // The action label sits on top of the button cluster, and the weapon chip
    // and dialogue stack above IT — publish its height so nothing has to guess.
    host.style.setProperty('--tlabel', (54 * tk).toFixed(1) + 'px');
    host.style.setProperty('--tnav', (68 * tk).toFixed(1) + 'px');
  }

  dispose() {
    for (const off of this._offs) off();
    this._offs.length = 0;
    this.bridge.dispose();
    this.zone.remove();
    guardOff?.();
  }
}
