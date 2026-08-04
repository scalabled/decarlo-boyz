/**
 * Input aggregation: keyboard, mouse (pointer-locked), and gamepad, exposed as
 * a stable per-frame snapshot so gameplay never touches raw DOM events.
 *
 * Edge queries (`pressed`, `released`) are valid only during the frame in which
 * the transition happened — read them in update(), not fixedUpdate().
 */

/**
 * THE CONTROL SCHEME.
 *
 * This was still the inherited Call of Duty layout — lean on Q/E, prone on Z,
 * melee on V, weapon swap on Tab — long after the game became a third-person
 * open-world driving game. The consequences were not cosmetic:
 *
 *   - `weapons.nextWeapon()` / `prevWeapon()` existed and were called by NOTHING
 *     in the entire codebase, so the sixteen-weapon arsenal was unreachable from
 *     the keyboard;
 *   - there was no horn, no camera cycle, and no radio key at all;
 *   - Q and E were wired to leaning, a mechanic this game does not have.
 *
 * The layout below follows GTA convention.
 * `ui` already owns M (map), Tab (weapon wheel), X (character switch),
 * P (phone) and N (radio station) — those are deliberately NOT duplicated here.
 */
export const ACTIONS = {
  forward: ['KeyW', 'ArrowUp'],
  back: ['KeyS', 'ArrowDown'],
  left: ['KeyA', 'ArrowLeft'],
  right: ['KeyD', 'ArrowRight'],
  jump: ['Space'],              // on foot: jump · in a vehicle: handbrake
  crouch: ['ControlLeft', 'KeyC'],
  sprint: ['ShiftLeft', 'ShiftRight'],
  reload: ['KeyR'],
  use: ['KeyF'],                // enter / exit / carjack / interact
  nextWeapon: ['KeyE'],
  prevWeapon: ['KeyQ'],
  camera: ['KeyV'],             // cycle chase / bonnet / far
  horn: ['KeyH'],
  grenade: ['KeyG'],
  flashlight: ['KeyT'],
  pause: ['Escape'],

  // Retained so nothing that still queries them throws; unbound because the
  // mechanics they drove (lean, prone) are not part of this game.
  melee: [],
  leanLeft: [],
  leanRight: [],
  prone: [],
  swapWeapon: ['Digit1', 'Digit2'],
};

export class Input {
  constructor(canvas, config) {
    this.canvas = canvas;
    this.config = config;

    this.down = new Set(); // codes currently held
    this._pressed = new Set(); // went down this frame
    this._released = new Set(); // went up this frame
    this._pendingDown = new Set();
    this._pendingUp = new Set();

    /** Accumulated pointer delta for this frame, in radians after sensitivity. */
    this.look = { x: 0, y: 0 };
    this._rawLook = { x: 0, y: 0 };
    this.wheel = 0;
    this._pendingWheel = 0;

    this.pointerLocked = false;
    this.enabled = true;
    /** Set true by capture mode so scripted shots aren't fought by real input. */
    this.frozen = false;

    /**
     * Optional predicate installed by `ui` (see `UiSystem.init`): while it
     * returns true a UI modal owns the mouse and the pointer must NOT be
     * grabbed. Null on headless benches and the model-preview page, where there
     * is no UI and nothing is ever paused — so the grab keeps its old behaviour
     * there. This is the one choke point EVERY lock request passes through, so a
     * single check closes both traps this exists to fix: the window-level
     * mousedown grab under a menu, and `menu.close()` re-locking on the way into
     * the story overview.
     */
    this.pointerLockGuard = null;

    this.gamepadIndex = null;
    this.stick = { moveX: 0, moveY: 0, lookX: 0, lookY: 0 };

    this._bound = {
      keydown: this._onKeyDown.bind(this),
      keyup: this._onKeyUp.bind(this),
      mousedown: this._onMouseDown.bind(this),
      mouseup: this._onMouseUp.bind(this),
      mousemove: this._onMouseMove.bind(this),
      wheel: this._onWheel.bind(this),
      lockchange: this._onLockChange.bind(this),
      blur: this._onBlur.bind(this),
      contextmenu: (e) => e.preventDefault(),
    };
  }

  attach() {
    addEventListener('keydown', this._bound.keydown);
    addEventListener('keyup', this._bound.keyup);
    addEventListener('mousedown', this._bound.mousedown);
    addEventListener('mouseup', this._bound.mouseup);
    addEventListener('mousemove', this._bound.mousemove);
    addEventListener('wheel', this._bound.wheel, { passive: true });
    addEventListener('blur', this._bound.blur);
    document.addEventListener('pointerlockchange', this._bound.lockchange);
    this.canvas.addEventListener('contextmenu', this._bound.contextmenu);
  }

  /**
   * Give the mouse back. A window-level pointer lock survives an overlay
   * opening (opening the map/story/phone with a keyboard shortcut does not
   * click anything), so the cursor stays hidden and captured over a menu the
   * player is trying to use. `ui._syncPause()` calls this whenever a
   * cursor-needing overlay comes up; the `pointerLockGuard` then keeps the lock
   * off until the overlay closes. Safe to call when nothing is locked.
   */
  exitPointerLock() {
    try {
      if (document.pointerLockElement) document.exitPointerLock?.();
    } catch {
      /* not eligible — nothing to release */
    }
  }

  detach() {
    removeEventListener('keydown', this._bound.keydown);
    removeEventListener('keyup', this._bound.keyup);
    removeEventListener('mousedown', this._bound.mousedown);
    removeEventListener('mouseup', this._bound.mouseup);
    removeEventListener('mousemove', this._bound.mousemove);
    removeEventListener('wheel', this._bound.wheel);
    removeEventListener('blur', this._bound.blur);
    document.removeEventListener('pointerlockchange', this._bound.lockchange);
    this.canvas.removeEventListener('contextmenu', this._bound.contextmenu);
  }

  requestPointerLock() {
    // A UI modal that owns the mouse must not have the pointer yanked out from
    // under it. `menu.close()` re-requests the lock on the way back to the game,
    // and the story overview it hands off to has no lock-release of its own — so
    // a grab here while the world is paused hides the cursor over a menu the
    // player is trying to click, and the browser then starts eating Escape.
    // A throwing guard must never break input, so it is wrapped.
    try {
      if (typeof this.pointerLockGuard === 'function' && this.pointerLockGuard()) return;
    } catch {
      /* a broken guard is not a reason to refuse the lock */
    }
    // Chrome returns a promise that rejects if the document is not eligible
    // (headless capture, an iframe, a lock request too soon after an exit).
    // An unhandled rejection there shows up as a page error in the harness, so
    // swallow it: failing to lock is not a game error.
    try {
      const p = this.canvas.requestPointerLock?.();
      if (p && typeof p.catch === 'function') p.catch(() => {});
    } catch {
      /* not eligible — keep running unlocked */
    }
  }

  _onKeyDown(e) {
    if (!this.enabled) return;
    if (e.repeat) return;
    // Let devtools/refresh through; swallow everything else the game binds.
    if (!e.metaKey && !e.ctrlKey) e.preventDefault();
    this._pendingDown.add(e.code);
  }

  _onKeyUp(e) {
    if (!this.enabled) return;
    this._pendingUp.add(e.code);
  }

  _onMouseDown(e) {
    if (!this.enabled) return;
    // ONLY a click on the game canvas asks for pointer lock. A click that landed
    // on a HUD control, a menu button, a map pin or the story overview is a UI
    // interaction, not a request to re-enter mouse-look — grabbing the lock
    // there hides the cursor, retargets the following mouseup at the canvas so
    // the button never receives its `click`, and makes the browser eat Escape.
    // `.ow-hud` is `pointer-events:none`, so an empty-world click still falls
    // through to the canvas and locks exactly as before.
    if (!this.pointerLocked && e.button === 0 && e.target === this.canvas) {
      this.requestPointerLock();
    }
    this._pendingDown.add(`Mouse${e.button}`);
  }

  _onMouseUp(e) {
    if (!this.enabled) return;
    this._pendingUp.add(`Mouse${e.button}`);
  }

  _onMouseMove(e) {
    if (!this.enabled || !this.pointerLocked || this.frozen) return;
    // movementX/Y is already relative and unaffected by cursor clamping.
    this._rawLook.x += e.movementX ?? 0;
    this._rawLook.y += e.movementY ?? 0;
  }

  _onWheel(e) {
    if (!this.enabled) return;
    this._pendingWheel += Math.sign(e.deltaY);
  }

  _onLockChange() {
    this.pointerLocked = document.pointerLockElement === this.canvas;
    if (!this.pointerLocked) this._onBlur();
  }

  /** Losing focus must release every held key, or the player runs forever. */
  _onBlur() {
    for (const code of this.down) this._pendingUp.add(code);
    this._rawLook.x = 0;
    this._rawLook.y = 0;
  }

  beginFrame() {
    this._pressed.clear();
    this._released.clear();

    for (const code of this._pendingDown) {
      if (!this.down.has(code)) {
        this.down.add(code);
        this._pressed.add(code);
      }
    }
    for (const code of this._pendingUp) {
      if (this.down.delete(code)) this._released.add(code);
    }
    this._pendingDown.clear();
    this._pendingUp.clear();

    const s = this.config.sensitivity;
    this.look.x = this.frozen ? 0 : this._rawLook.x * s;
    this.look.y = this.frozen ? 0 : this._rawLook.y * s * (this.config.invertY ? -1 : 1);
    this._rawLook.x = 0;
    this._rawLook.y = 0;

    this.wheel = this._pendingWheel;
    this._pendingWheel = 0;

    this._pollGamepad();
  }

  endFrame() {}

  _pollGamepad() {
    const pads = navigator.getGamepads?.() ?? [];
    const pad = pads[this.gamepadIndex ?? 0] ?? pads.find(Boolean);
    if (!pad) {
      this.stick.moveX = this.stick.moveY = this.stick.lookX = this.stick.lookY = 0;
      return;
    }
    const dz = (v) => (Math.abs(v) < 0.16 ? 0 : (v - Math.sign(v) * 0.16) / 0.84);
    this.stick.moveX = dz(pad.axes[0] ?? 0);
    this.stick.moveY = dz(pad.axes[1] ?? 0);
    // Cubic response curve on the look stick — fine aim near centre, fast flicks at the edge.
    const curve = (v) => Math.sign(v) * Math.abs(v) ** 2.4;
    this.stick.lookX = curve(dz(pad.axes[2] ?? 0));
    this.stick.lookY = curve(dz(pad.axes[3] ?? 0));
  }

  /** True while any key bound to `action` is held. */
  action(name) {
    const codes = ACTIONS[name];
    if (!codes) return false;
    for (const c of codes) if (this.down.has(c)) return true;
    return false;
  }

  actionPressed(name) {
    const codes = ACTIONS[name];
    if (!codes) return false;
    for (const c of codes) if (this._pressed.has(c)) return true;
    return false;
  }

  held(code) {
    return this.down.has(code);
  }

  pressed(code) {
    return this._pressed.has(code);
  }

  released(code) {
    return this._released.has(code);
  }

  get fire() {
    return this.down.has('Mouse0');
  }

  get firePressed() {
    return this._pressed.has('Mouse0');
  }

  get ads() {
    return this.down.has('Mouse2');
  }

  /** Normalised WASD + left-stick movement, clamped to the unit disc so
   *  diagonals aren't faster than cardinals. */
  moveVector(out = { x: 0, y: 0 }) {
    let x = (this.action('right') ? 1 : 0) - (this.action('left') ? 1 : 0);
    let y = (this.action('forward') ? 1 : 0) - (this.action('back') ? 1 : 0);
    x += this.stick.moveX;
    y -= this.stick.moveY;
    const len = Math.hypot(x, y);
    if (len > 1) {
      x /= len;
      y /= len;
    }
    out.x = x;
    out.y = y;
    return out;
  }
}
