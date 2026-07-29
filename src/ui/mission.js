/**
 * ===========================================================================
 * MISSION AND WORLD TEXT
 * ===========================================================================
 *
 * Everything the game says to the player that is not a number on a gauge:
 *
 *   ObjectivePanel  top right — the current instruction, a timer, lap and
 *                   checkpoint counters, a progress bar. Under the stars, so
 *                   the whole "what is happening to me" column is one place.
 *   ZoneFlourish    bottom left, directly above the ring — the district name
 *                   when you cross into it. Three seconds, then gone.
 *   TitleCard       a lower third at the start of a chapter: "CH 3 — AGAINST
 *                   THE CURRENT". Rockstar puts this bottom-left over live
 *                   gameplay rather than on a black card, and so do we.
 *   Cutscene        THE MODE. A chapter's authored dialogue, delivered with
 *                   the world stopped. See its own header.
 *   Subtitles       an in-mission BARK — one line over live gameplay, speaker
 *                   in his signature colour. Not the chapters' dialogue.
 *   BigCard         MISSION PASSED / WASTED / BUSTED.
 *   Feed            top left — pickups, unlocks, packages, respect.
 *
 * Every one of these animates from `update(dt)`, never from a CSS transition,
 * so a capture at frame N is reproducible.
 *
 * NOTE ON STYLING. `src/ui/style.js` carries the stylesheet for everything
 * above; the `Cutscene` below is styled INLINE instead. Nothing about it needs a
 * stylesheet — every animated value has to come out of `update(dt)` anyway (see
 * above), so the only cost is verbosity. `_css()` is one block to lift across if
 * it ever belongs in style.js.
 */

import { el, svg, setText, setStyle, setClass, clamp, clamp01, damp, ease, mmss } from './util.js';
import { BOY_BY_ID } from './data.js';

/* ------------------------------------------------------------ objective -- */

export class ObjectivePanel {
  constructor(parent) {
    this.root = el('div', 'ow-obj', parent);
    this.eyebrow = el('div', 'ow-obj-eyebrow', this.root, '');
    this.text = el('div', 'ow-obj-text', this.root, '');
    this.metaRow = el('div', 'ow-obj-meta', this.root);
    this.timer = el('div', 'ow-obj-timer', this.metaRow, '');
    this.counter = el('div', 'ow-obj-count', this.metaRow, '');
    const bar = el('div', 'ow-obj-bar', this.root);
    this.barFill = el('i', null, bar);
    this.bar = bar;

    this.active = false;
    this.shown = 0;
    this.data = { eyebrow: '', text: '', timer: null, warn: false, count: '', progress: -1 };
  }

  set(o) {
    if (!o) return this.clear();
    this.active = true;
    Object.assign(this.data, o);
    setText(this.eyebrow, (o.eyebrow ?? this.data.eyebrow ?? '').toUpperCase());
    setText(this.text, (o.text ?? '').toUpperCase());
  }

  clear() {
    this.active = false;
  }

  update(dt) {
    this.shown = damp(this.shown, this.active ? 1 : 0, 12, dt);
    const a = this.shown;
    setStyle(this.root, 'opacity', a.toFixed(3));
    setStyle(this.root, 'transform', `translateX(${((1 - ease.outCubic(a)) * 22).toFixed(2)}px)`);
    setStyle(this.root, 'display', a < 0.004 ? 'none' : '');
    if (a < 0.004) return 0;

    const d = this.data;
    if (d.timer !== null && d.timer !== undefined) {
      setText(this.timer, mmss(d.timer));
      setClass(this.timer, 'warn', d.timer <= 10);
      setStyle(this.timer, 'display', '');
    } else {
      setStyle(this.timer, 'display', 'none');
    }
    setText(this.counter, d.count ?? '');
    setStyle(this.counter, 'display', d.count ? '' : 'none');
    if (d.progress >= 0) {
      setStyle(this.bar, 'display', '');
      setStyle(this.barFill, 'transform', `scaleX(${clamp01(d.progress).toFixed(3)})`);
    } else {
      setStyle(this.bar, 'display', 'none');
    }
    return a;
  }

  dispose() {
    this.root.remove();
  }
}

/* --------------------------------------------------------------- zones --- */

/** The district-name flourish. Slides up over the ring and fades. */
export class ZoneFlourish {
  constructor(parent) {
    this.root = el('div', 'ow-zone', parent);
    this.rule = el('div', 'ow-zone-rule', this.root);
    this.sub = el('div', 'ow-zone-sub', this.root, 'ENTERING');
    this.name = el('div', 'ow-zone-name', this.root, '');
    this.t = 0;
    this.life = 3.6;
    setStyle(this.root, 'display', 'none');
  }

  show(name, sub = 'ENTERING') {
    setText(this.name, name);
    setText(this.sub, sub);
    this.t = 0;
    this.life = 3.6;
    this.active = true;
    setStyle(this.root, 'display', '');
  }

  update(dt) {
    if (!this.active) return 0;
    this.t += dt;
    if (this.t >= this.life) {
      this.active = false;
      setStyle(this.root, 'display', 'none');
      return 0;
    }
    const inA = ease.outCubic(clamp01(this.t / 0.42));
    const outA = 1 - ease.inOutCubic(clamp01((this.t - (this.life - 0.6)) / 0.6));
    const a = inA * outA;
    setStyle(this.root, 'opacity', a.toFixed(3));
    setStyle(this.root, 'transform', `translateY(${((1 - inA) * 14).toFixed(2)}px)`);
    setStyle(this.rule, 'transform', `scaleX(${inA.toFixed(3)})`);
    return a;
  }

  dispose() {
    this.root.remove();
  }
}

/* ---------------------------------------------------------- title card --- */

export class TitleCard {
  constructor(parent) {
    this.root = el('div', 'ow-title', parent);
    this.bar = el('div', 'ow-title-bar', this.root);
    const col = el('div', null, this.root);
    this.ch = el('div', 'ow-title-ch', col, 'CH 1');
    this.name = el('div', 'ow-title-name', col, '');
    this.zone = el('div', 'ow-title-zone', col, '');
    this.t = 0;
    this.life = 5.4;
    this.active = false;
    setStyle(this.root, 'display', 'none');
  }

  show(chapter, name, zone) {
    setText(this.ch, chapter ?? '');
    setText(this.name, name ?? '');
    setText(this.zone, zone ?? '');
    this.t = 0;
    this.active = true;
    setStyle(this.root, 'display', '');
  }

  update(dt) {
    if (!this.active) return 0;
    this.t += dt;
    if (this.t >= this.life) {
      this.active = false;
      setStyle(this.root, 'display', 'none');
      return 0;
    }
    const inA = ease.outQuint(clamp01(this.t / 0.7));
    const outA = 1 - ease.inOutCubic(clamp01((this.t - (this.life - 0.9)) / 0.9));
    const a = inA * outA;
    setStyle(this.root, 'opacity', a.toFixed(3));
    setStyle(this.bar, 'transform', `scaleY(${ease.outQuint(clamp01(this.t / 0.5)).toFixed(3)})`);
    // the name wipes in from the left behind the bar
    setStyle(this.name, 'transform', `translateX(${((1 - inA) * -26).toFixed(2)}px)`);
    setStyle(this.ch, 'opacity', clamp01((this.t - 0.16) / 0.4).toFixed(3));
    setStyle(this.zone, 'opacity', (clamp01((this.t - 0.34) / 0.5) * outA).toFixed(3));
    return a;
  }

  dispose() {
    this.root.remove();
  }
}

/* ------------------------------------------------------------ cutscene --- */

/**
 * ===========================================================================
 * THE CUTSCENE — a MODE, not a caption
 * ===========================================================================
 *
 * Twenty-four chapters of authored dialogue live in `src/game/data.js`. They
 * used to arrive as a two-line bar at the bottom of a live, running world:
 * full simulation, full HUD, gameplay fov, the whole line dumped at once and
 * held on a length-derived timer. Measured on that build, over one chapter
 * intro: 100% sim speed throughout, HUD opacity 1, the city clock ticking
 * 08:31 -> 08:32, projection fov 62. The writing was the game's voice and the
 * presentation threw it away.
 *
 * A cutscene is therefore a MODE: it runs no simulation at all, hides the HUD
 * and the touch layer, orbits the camera around the player at fov 44, types each
 * line at 46 cps with a tick every 4th character, animates in a per-speaker
 * procedural SVG portrait, substitutes the hero's rival name for the `boss`
 * speaker, and offers click-to-advance plus SKIP ALL.
 *
 * ---------------------------------------------------------------------------
 * HOW "NO SIMULATION AT ALL" IS EXPRESSED HERE
 * ---------------------------------------------------------------------------
 * There is no global mode flag. The two levers that reach every subsystem are
 * the clock and the keyboard, and BOTH are needed — neither alone stops the
 * frame:
 *
 *   `ctx.time.scale = 0`   stops everything that integrates `dt`. That is most
 *       of the sim, and it is what `time.elapsed` (the number every gate should
 *       measure) reports.
 *   `ctx.input.enabled = false`  stops everything that reads an input EDGE. The
 *       engine keeps delivering edges at full rate however slow the clock is —
 *       measured on the shipped build, that is exactly how `K` abandoned a
 *       chapter from behind the pause menu. During a cut the live edges are
 *       `J`/`K`/`U` in `game`, `F` in `game.freeroam`, and `M`/`P`/`O`/`ESC`/
 *       `TAB` in `ui._input`. Every one of those consumers already refuses on
 *       `!input.enabled`, so one flag closes all of them.
 *
 * Disabling input has a second, load-bearing effect: no overlay can open during
 * a cut, so `ui`'s PauseArbiter never transitions, never re-derives, and never
 * writes `time.scale` out from under us. The cut is the only writer for its own
 * duration. Both values are banked on entry and handed back on exit, and
 * `update()` re-asserts them every frame so a stray writer costs one frame
 * rather than the rest of the scene.
 *
 * THIS IS NOT WHERE IT SHOULD LIVE. The right shape is a `cut: 0` claim in the
 * arbiter's frozen table in `src/ui/index.js` — three lines — at which point
 * `ui.isPaused()` tells the truth during a cut and
 * the two writes below become one claim. `_arbiterOwnsCut()` detects that the
 * moment it lands and stands down, so there is never a window with two owners.
 *
 * ---------------------------------------------------------------------------
 * THE CAMERA, AND WHY IT IS DRIVEN FROM `lateUpdate`
 * ---------------------------------------------------------------------------
 * `player.cameraUpdate` applies the chase rig to `ctx.camera` every frame, and
 * `cameraUpdate` runs BEFORE `lateUpdate` (see the frame-order note in
 * `src/core/engine.js`). `ui.lateUpdate` — which is what calls this — is
 * therefore the first phase that can win the camera, and `render` draws after
 * every `lateUpdate`, so what is written here is what is photographed. The one
 * consumer that reads the camera earlier in the same phase is `sky.lateUpdate`
 * (volumetrics and clouds copy the camera matrix), which will be one frame
 * stale during a cut: 0.12 rad/s of orbit, i.e. ~2 cm at 60 fps. Visible to
 * nobody, and the alternative is a `cameraUpdate` in a file outside this
 * subsystem.
 *
 * `fov` is written to the CAMERA and the projection matrix is rebuilt, because
 * a fov written without `updateProjectionMatrix()` renders at the old angle and
 * looks exactly like a working one from the code's side. `src/ui/cutsceneprobe.mjs`
 * recovers the fov from `projectionMatrix` for that reason.
 */

/** Fallback ink for a speaker with no entry anywhere. */
const CUT_INK = '#e8e2d4';
/** The default portrait body — the `boss` palette. */
const CUT_BODY = Object.freeze({ skin: '#b07a52', shirt: '#3a1220', hair: '#15100c' });
/** 46 characters per second. */
const CUT_CPS = 46;
/** A tick every 4th character. */
const CUT_TICK = 4;
/**
 * Watchdog, in UNSCALED seconds, on one line. A cut owns the clock and the
 * keyboard; if it ever wedged, the game would be unplayable with no way back.
 * The longest authored line is ~200 characters — 4.3 s of typing plus 7.1 s of
 * hold — so 30 s cannot fire on a working scene.
 */
const CUT_LINE_WATCHDOG = 30;

export class Cutscene {
  /**
   * @param {HTMLElement} parent  any node inside `.ow-hud`; the cut layer is
   *   hoisted to the HUD root so `setHudVisible(false)` cannot fade it out
   *   along with the readouts it is replacing.
   */
  constructor(parent) {
    const host = parent?.closest?.('.ow-hud') ?? parent?.parentNode ?? parent;
    // DOM order IS the stacking order inside `.ow-hud` (no child sets z-index).
    // Built during `ui.init()` before the touch layer, the cheat panel and the
    // pause menu are appended, so all three still draw over the cut — which is
    // what keeps "ESC always lands on exactly one thing" true.
    this.root = el('div', 'ow-cut ow-layer', host);
    // A scrim under the stage only — enough to seat the type, no wash over the
    // shot. The letterbox is the framing device; dimming the whole frame just
    // makes the city look underexposed, which is the opposite of a money shot.
    this._css(this.root,
      'pointer-events:auto;cursor:pointer;background:linear-gradient(to top,' +
      'rgba(3,6,10,.66) 0%,rgba(3,6,10,.3) 20%,rgba(3,6,10,0) 42%);');
    setStyle(this.root, 'display', 'none');

    this.barT = el('div', 'ow-cut-bar t', this.root);
    this.barB = el('div', 'ow-cut-bar b', this.root);
    const BAR = 'position:absolute;left:0;right:0;background:#000;';
    this._css(this.barT, BAR + 'top:0;');
    this._css(this.barB, BAR + 'bottom:0;');

    this.ctxLine = el('div', 'ow-cut-ctx', this.root, '');
    // Viewport-relative, not `--k`-relative. `--k` is 0.67 on a 720p window,
    // which takes a 10 px context stamp down to 6 px — measured unreadable in
    // the first frame captured of this widget.
    this._css(this.ctxLine,
      'position:absolute;left:5vw;font-family:var(--fm);' +
      'font-size:clamp(9px,1.05vw,14px);letter-spacing:.3em;color:var(--ink-2);' +
      'border-left:2px solid var(--slag);padding-left:10px;' +
      'text-transform:uppercase;text-shadow:0 2px 8px #000;');

    this.stage = el('div', 'ow-cut-stage', this.root);
    this._css(this.stage,
      'position:absolute;left:0;right:0;padding:0 5vw calc(20px * var(--k));' +
      'display:flex;align-items:flex-end;gap:calc(14px * var(--k));');

    this.portrait = el('div', 'ow-cut-port', this.stage);
    this._css(this.portrait,
      'width:clamp(64px,15vw,108px);aspect-ratio:1;border-radius:calc(9px * var(--k));' +
      'overflow:hidden;flex:none;border:1px solid var(--line);background:#0a0e13;' +
      'box-shadow:0 calc(10px * var(--k)) calc(28px * var(--k)) rgba(0,0,0,.6);');
    this._buildPortrait(this.portrait);

    const bubble = el('div', 'ow-cut-bubble', this.stage);
    this._css(bubble, 'flex:1;min-width:0;');
    this.who = el('div', 'ow-cut-who', bubble, '');
    this._css(this.who,
      'font-family:var(--fd);font-size:clamp(17px,4vw,26px);letter-spacing:.05em;' +
      'color:var(--spk,var(--gold));text-shadow:0 2px 8px #000;');
    this.line = el('div', 'ow-cut-line', bubble);
    this._css(this.line,
      'font-size:clamp(13.5px,3vw,18px);line-height:1.5;color:#eef1f5;' +
      'text-shadow:0 2px 8px #000;min-height:2.6em;margin-top:2px;' +
      'text-transform:none;font-weight:500;letter-spacing:.01em;');
    this.text = el('span', 'ow-cut-text', this.line, '');
    this.cursor = el('i', 'ow-cut-cursor', this.line);
    this._css(this.cursor,
      'display:inline-block;width:calc(8px * var(--k));height:1em;' +
      'background:var(--slag);vertical-align:-2px;margin-left:2px;');

    this.skip = el('button', 'ow-cut-skip', this.root, 'SKIP ▸');
    this._css(this.skip,
      'position:absolute;right:5vw;appearance:none;cursor:pointer;' +
      'pointer-events:auto;touch-action:manipulation;padding:11px 18px;' +
      'border:1px solid var(--hair);background:rgba(8,10,14,.72);color:var(--ink);' +
      'font-family:var(--ff);font-size:clamp(11px,1.15vw,15px);letter-spacing:.2em;' +
      'text-transform:uppercase;');
    this.hint = el('div', 'ow-cut-hint', this.root, 'CLICK OR SPACE · NEXT LINE');
    this._css(this.hint,
      'position:absolute;right:5vw;font-family:var(--fm);' +
      'font-size:clamp(8px,0.85vw,11px);letter-spacing:.22em;color:var(--ink-3);' +
      'text-align:right;text-shadow:0 2px 8px #000;');

    /* ---- state ---------------------------------------------------------- */
    this.active = false;
    this.lines = EMPTY_LINES;
    this.idx = -1;
    this.char = 0;
    this.typeT = 0;
    this.holdT = 0;
    this.lineT = 0;
    this.portT = 0;
    this.camT = 0;
    this.orbit = 0;
    this.focusX = 0;
    this.focusY = 0;
    this.focusZ = 0;
    this.a = 0;
    this._settled = false;
    this._done = null;
    this._ctx = null;
    this._ui = null;
    this._full = '';
    this._shown = -1;
    this._prevScale = 1;
    this._prevInput = true;
    this._prevHud = 1;
    this._prevFov = 60;
    this._ownsClock = false;

    /**
     * ONE window listener, installed once, inert unless a cut is up. Escape is
     * SKIP ALL and Space/Enter is the next line — and it is a DOM listener
     * rather than an `input.pressed()` read because the cut has deliberately
     * switched `Input` off.
     *
     * The `menu.open` guard is the reason this cannot become the next "J fires
     * from behind the pause menu": a key handled here can never reach the game
     * while a menu owns the screen, whatever else changes upstream.
     */
    this._onKey = (e) => {
      if (!this.active || this._ui?.menu?.open) return;
      // `code` first, `key` as the fallback — and `||`, not `??`: an event with
      // no `code` reports the EMPTY STRING, which `??` happily passes through.
      const c = e.code || e.key;
      if (c === 'Escape') { e.preventDefault(); this.skipAll(); }
      else if (c === 'Space' || c === 'Enter' || c === 'NumpadEnter') {
        e.preventDefault();
        this.skipLine();
      }
    };
    addEventListener('keydown', this._onKey, true);

    // The whole letterbox is a tap target, so a phone has something to press.
    // The button stops its own click short.
    this.root.addEventListener('click', (e) => {
      if (!this.active) return;
      if (e.target === this.skip || this.skip.contains(e.target)) return;
      this.skipLine();
    });
    this.skip.addEventListener('click', (e) => {
      e.stopPropagation();
      this.skipAll();
    });
  }

  /** One shot of inline CSS. Never called per frame. */
  _css(node, text) {
    node.style.cssText = text;
  }

  /**
   * The per-speaker portrait, built ONCE and recoloured per line. Re-serialising
   * the SVG into `innerHTML` on every line would reparse a document fragment
   * mid-scene and allocate; this is the same picture, the same seven shapes, no
   * parse and no garbage. There are no art files: this is the whole portrait.
   */
  _buildPortrait(parent) {
    const s = svg('svg', { viewBox: '0 0 100 100', role: 'img' }, parent);
    s.style.cssText = 'width:100%;height:100%;display:block;';
    this.portSvg = s;
    this.portLabel = svg('title', null, s);
    const defs = svg('defs', null, s);
    const grad = svg('linearGradient', { id: 'ow-cut-grad', x1: '0', y1: '0', x2: '0', y2: '1' }, defs);
    this.portStop = svg('stop', { offset: '0', 'stop-opacity': '.55' }, grad);
    svg('stop', { offset: '1', 'stop-color': '#05070a' }, grad);
    svg('rect', { width: '100', height: '100', fill: 'url(#ow-cut-grad)' }, s);
    this.portShirt = svg('path', { d: 'M18 100c0-20 14-30 32-30s32 10 32 30z' }, s);
    this.portNeck = svg('rect', { x: '34', y: '52', width: '32', height: '20', rx: '8' }, s);
    this.portHead = svg('ellipse', { cx: '50', cy: '42', rx: '21', ry: '24' }, s);
    this.portHair = svg('path',
      { d: 'M29 38c2-16 12-22 21-22s19 6 21 22c-6-6-13-8-21-8s-15 2-21 8z' }, s);
    svg('ellipse', { cx: '42', cy: '42', rx: '3.1', ry: '3.6', fill: '#12161c' }, s);
    svg('ellipse', { cx: '58', cy: '42', rx: '3.1', ry: '3.6', fill: '#12161c' }, s);
    svg('path', {
      d: 'M43 55q7 4 14 0', stroke: '#7a4a3a', 'stroke-width': '2.2',
      fill: 'none', 'stroke-linecap': 'round',
    }, s);
    this.portFrame = svg('rect', {
      x: '0', y: '0', width: '100', height: '100', fill: 'none',
      'stroke-opacity': '.5', 'stroke-width': '2',
    }, s);
  }

  /* -------------------------------------------------------------- play --- */

  /**
   * @param {{who:string,text:string,name?:string,colour?:string,body?:object}[]} lines
   * @param {object} opts { ctx, ui, context, focusX, focusY, focusZ, onDone }
   * @returns {boolean} true if the cutscene took the screen. FALSE means the
   *   caller still owns the flow — an empty scene, or a host with no clock —
   *   and must do whatever it would have done without a cutscene.
   */
  play(lines, opts = {}) {
    const ctx = opts.ctx;
    if (!Array.isArray(lines) || !lines.length || !ctx?.time) return false;
    if (this.active) this.cancel();

    this._ctx = ctx;
    this._ui = opts.ui ?? null;
    this._done = typeof opts.onDone === 'function' ? opts.onDone : null;
    this.lines = lines;
    this.idx = -1;
    this.camT = 0;
    this.a = 0;
    this._settled = false;
    this.focusX = Number.isFinite(opts.focusX) ? opts.focusX : ctx.camera.position.x;
    this.focusZ = Number.isFinite(opts.focusZ) ? opts.focusZ : ctx.camera.position.z;
    this.focusY = Number.isFinite(opts.focusY) ? opts.focusY : ctx.camera.position.y - 2;
    // The orbit starts at the bearing the CAMERA IS ALREADY ON, rather than at a
    // random one: it cuts smoothly out of the chase camera instead of
    // jump-cutting, and — ARCHITECTURE.md rule 4 — needs no random number at
    // all, so a capture is reproducible.
    this.orbit = Math.atan2(ctx.camera.position.x - this.focusX,
      ctx.camera.position.z - this.focusZ);

    setText(this.ctxLine, String(opts.context ?? '').toUpperCase());
    this._seize();
    setStyle(this.root, 'display', '');
    this.active = true;
    this.next();
    return true;
  }

  next() {
    this.idx++;
    if (this.idx >= this.lines.length) { this.finish(); return; }
    const l = this.lines[this.idx] ?? EMPTY_LINE;
    const boy = BOY_BY_ID[l.who];
    // The `boss` speaker's name is the hero's own rival and only `game` knows
    // it, so it arrives resolved on the line record. Everything else falls back
    // through the HUD's own atlas and then to the raw id, uppercased.
    const name = l.name ?? boy?.name ?? String(l.who ?? '').toUpperCase();
    const colour = l.colour ?? boy?.colour ?? CUT_INK;
    const body = l.body ?? boy?.body ?? CUT_BODY;

    setText(this.who, String(name).toUpperCase());
    setStyle(this.root, '--spk', colour);
    this._paint(colour, body, name);

    this._full = String(l.text ?? '');
    this.char = 0;
    this.typeT = 0;
    this.holdT = 0;
    this.lineT = 0;
    this.portT = 0;
    this._shown = -1;
    this._sfx('type_tick', 0.2);
  }

  _paint(colour, body, name) {
    setText(this.portLabel, String(name));
    this.portSvg.setAttribute('aria-label', String(name));
    this.portStop.setAttribute('stop-color', colour);
    this.portFrame.setAttribute('stroke', colour);
    this.portShirt.setAttribute('fill', body.shirt ?? CUT_BODY.shirt);
    this.portNeck.setAttribute('fill', body.skin ?? CUT_BODY.skin);
    this.portHead.setAttribute('fill', body.skin ?? CUT_BODY.skin);
    this.portHair.setAttribute('fill', body.hair ?? CUT_BODY.hair);
  }

  /** Fill the line if it is still typing, otherwise move on. */
  skipLine() {
    if (!this.active) return;
    if (this.char < this._full.length) {
      this.char = this._full.length;
      this.holdT = 0.55;
    } else {
      this.next();
    }
  }

  /** The SKIP ALL button, and ESC. */
  skipAll() {
    if (!this.active) return;
    this.idx = this.lines.length;
    this.finish();
  }

  /** The scene ended: hand back the clock, the keyboard and the screen. */
  finish() {
    if (!this.active) return;
    this.active = false;
    this.lines = EMPTY_LINES;
    this._full = '';
    setStyle(this.root, 'display', 'none');
    this._release();
    const d = this._done;
    this._done = null;
    // LAST. `d()` can start the next chapter, which re-enters `play()`, so
    // every field this object owns is already back at rest before it runs.
    if (d) d();
  }

  /**
   * Tear the scene down WITHOUT the callback — the mission was aborted,
   * restarted or force-begun under it. Everything seized is still handed back;
   * that is the whole point of having a separate door.
   */
  cancel() {
    if (!this.active) return;
    this._done = null;
    this.finish();
  }

  /* ------------------------------------------------- the clock and keys --- */

  /**
   * Has the arbiter in `src/ui/index.js` grown its `cut` claim? If it has, it
   * is the one owner of `ctx.time.scale` (ARCHITECTURE.md's "one fact, one
   * owner") and this class must not write the clock at all.
   */
  _arbiterOwnsCut() {
    const w = this._ui?._wants;
    return !!w && Object.prototype.hasOwnProperty.call(w, 'cut');
  }

  _seize() {
    const ctx = this._ctx;
    const t = ctx.time;
    this._ownsClock = !this._arbiterOwnsCut();
    // Never bank a zero: handing a zero back gives the player a live HUD over a
    // dead world. Same rule the arbiter's `base` follows, and for the same
    // reason.
    this._prevScale = t.scale > 0 ? t.scale : 1;
    if (this._ownsClock) t.scale = 0;
    const input = ctx.input;
    if (input) {
      this._prevInput = input.enabled !== false;
      input.enabled = false;
    }
    this._prevFov = ctx.camera.fov;
    // BANK the HUD target rather than assuming it was up. A cut can start with
    // the HUD already down (`setHudVisible(false)` during the ending, a debug
    // state), and handing back a `true` nobody asked for would put the whole
    // HUD on screen over whatever had deliberately taken it off.
    const ui = this._ui;
    this._prevHud = Number.isFinite(ui?.hudTarget) ? ui.hudTarget : 1;
    ui?.setHudVisible?.(false);
    /**
     * RELEASE THE POINTER LOCK, exactly as `menu.show()` does, and for both of
     * the same reasons. While the pointer is locked the cursor is hidden and
     * every click is delivered to the canvas rather than to what is under it —
     * so SKIP ALL and click-to-advance, the two controls this scene is built
     * around, would be unreachable with a mouse. And a locked pointer makes the
     * browser EAT the first Escape to exit the lock, so the key bound to SKIP
     * ALL would silently do nothing on its first press.
     */
    try {
      if (document.pointerLockElement) document.exitPointerLock?.();
    } catch { /* not eligible — the scene plays either way */ }
  }

  _release() {
    const ctx = this._ctx;
    if (!ctx) return;
    if (this._ownsClock) {
      // If a real claim has the clock (a result card raised inside the
      // callback, say), leave it alone: it re-derives from live overlay state
      // at the end of this very frame and its answer beats a banked one.
      const held = typeof this._ui?.isPaused === 'function' && this._ui.isPaused() === true;
      if (!held) ctx.time.scale = this._prevScale;
    }
    if (ctx.input) ctx.input.enabled = this._prevInput;
    if (Math.abs(ctx.camera.fov - this._prevFov) > 1e-3) {
      ctx.camera.fov = this._prevFov;
      ctx.camera.updateProjectionMatrix();
    }
    this._ui?.setHudVisible?.(this._prevHud > 0);
    /**
     * DISARM THE POINTER-LOCK LATCH. `ui._input` treats "we had the lock and no
     * longer do" as the player pressing Escape and opens the pause menu — the
     * right rule in play, and a trap here, because `_seize` dropped the lock on
     * purpose and `_input` has been switched off since, so the latch is still
     * armed from before the scene. Without this, EVERY cutscene ends in a pause
     * menu the player did not ask for. `menu.show()` and `cheats.show()` are
     * disarmed the same way, in `ui._input`'s own early returns.
     */
    if (this._ui && this._ui._hadPointerLock !== undefined) {
      this._ui._hadPointerLock = false;
    }
    this._ownsClock = false;
  }

  _sfx(id, gain) {
    this._ui?.sfx?.(id, gain);
  }

  /* -------------------------------------------------------------- frame --- */

  /**
   * @param {number} dt UNSCALED seconds. The cut holds `time.scale` at zero, so
   *   a scaled dt would freeze the cutscene along with the world it stopped —
   *   `ui.lateUpdate` passes `rawDt` to every widget for exactly this reason.
   */
  update(dt) {
    if (!this.active) return 0;
    // Re-assert every frame. Nothing should be writing these while a cut is up
    // (input is off, so no overlay can open and claim the clock), but a scene
    // that silently lost the clock halfway through is the failure this costs
    // one frame instead of the rest of the chapter.
    const ctx = this._ctx;
    if (this._ownsClock && ctx.time.scale !== 0) ctx.time.scale = 0;
    if (ctx.input && ctx.input.enabled !== false) ctx.input.enabled = false;

    this.camT += dt;
    this.lineT += dt;
    this.portT += dt;
    this.a = ease.outCubic(clamp01(this.camT / 0.45));

    /* ---- typing ------------------------------------------------------- */
    const n = this._full.length;
    if (this.char < n) {
      this.typeT += dt;
      const step = 1 / CUT_CPS;
      let ticked = false;
      while (this.typeT > step && this.char < n) {
        this.typeT -= step;
        this.char++;
        if (this.char % CUT_TICK === 0) ticked = true;
      }
      if (ticked) this._sfx('type_tick', 0.14);
    } else {
      this.holdT += dt;
      // 1.5 s plus 28 ms a character before the line moves on.
      if (this.holdT > 1.5 + n * 0.028) this.next();
    }
    if (this.lineT > CUT_LINE_WATCHDOG) this.next();
    if (!this.active) return 0; // `next()` may have finished the scene
    // Reads `_full` rather than a captured copy, because `next()` above may
    // have swapped the line under us — and then `char` is 0 and this must
    // clear the OLD line, not slice the old string to the new length.
    if (this._shown !== this.char) {
      this._shown = this.char;
      // The only per-frame allocation in this method, and only on the frames a
      // character actually landed: one substring at 46 Hz while a line types.
      setText(this.text, this._full.slice(0, this.char));
    }

    /* ---- presentation, all integrated from dt (no CSS transitions) ----- */
    const a = this.a;
    // The letterbox and the furniture settle in 0.45 s and then never move, so
    // they are written until they arrive and not once after. Rule 5 is about
    // steady state: a `calc(...)` template rebuilt every frame for a value that
    // stopped changing is garbage with a constant in it.
    if (!this._settled) {
      setStyle(this.root, 'opacity', a.toFixed(3));
      const bar = (10.5 + 1.5 * a) * a;
      const barVh = bar.toFixed(2) + 'vh';
      setStyle(this.barT, 'height', barVh);
      setStyle(this.barB, 'height', barVh);
      setStyle(this.stage, 'bottom', barVh);
      setStyle(this.ctxLine, 'top', `calc(${barVh} + 18px)`);
      setStyle(this.skip, 'bottom', `calc(${barVh} + 18px)`);
      setStyle(this.hint, 'bottom', `calc(${barVh} + 62px)`);
      if (a >= 0.999) this._settled = true;
    }
    // The portrait pops in per LINE. Restarting a CSS transition would mean
    // forcing a reflow; this is the same 0.3 s curve, integrated, and it stops
    // writing the moment it has landed.
    if (this.portT < 0.32) {
      const p = ease.outBack(clamp01(this.portT / 0.3));
      setStyle(this.portrait, 'opacity', clamp01(this.portT / 0.18).toFixed(3));
      setStyle(this.portrait, 'transform', `translateY(${((1 - p) * 14).toFixed(2)}px)`);
    }
    // The caret blinks on a 0.7 s square wave, and holds solid
    // while there is still line to come. Both values are literals, so the
    // steady state allocates nothing.
    setStyle(this.cursor, 'opacity',
      this.char < n ? '1' : (this.camT % 0.7 < 0.35 ? '1' : '0'));

    /* ---- the orbit ----------------------------------------------------- */
    this.orbit += dt * 0.12;
    const r = 11 + Math.sin(this.camT * 0.3) * 2.5;
    const cam = ctx.camera;
    cam.position.set(
      this.focusX + Math.sin(this.orbit) * r,
      this.focusY + 3.2 + Math.sin(this.camT * 0.4) * 0.7,
      this.focusZ + Math.cos(this.orbit) * r
    );
    cam.lookAt(this.focusX, this.focusY + 1.5, this.focusZ);
    if (Math.abs(cam.fov - 44) > 1e-3) {
      cam.fov = 44;
      cam.updateProjectionMatrix();
    }
    // `player.cameraUpdate` already ran this frame and left a matrix for the
    // chase pose. Rebuild it, or the HUD's camera basis, `render`'s culling and
    // the composite all frame the shot we just replaced.
    cam.updateMatrixWorld(true);
    return a;
  }

  dispose() {
    this.cancel();
    removeEventListener('keydown', this._onKey, true);
    this.root.remove();
  }
}

const EMPTY_LINES = Object.freeze([]);
const EMPTY_LINE = Object.freeze({ who: '', text: '' });

/* ----------------------------------------------------------- subtitles --- */

/**
 * ONE line at a time over LIVE gameplay — an in-mission bark, not a scene.
 *
 * The chapters' authored dialogue does NOT come through here any more: it is a
 * `Cutscene` (above). What is left is the case a cutscene cannot serve — a track
 * shouting a single line at the player mid-fight (`boss.js`'s "they called in
 * the crooked cops"), where stopping the world would be absurd.
 *
 * `this.cut` is built here rather than in `ui/index.js` because that file
 * constructs the widgets from a fixed import list; the cut hoists itself to the
 * HUD root regardless of which layer it was handed.
 */
export class Subtitles {
  constructor(parent) {
    this.cut = new Cutscene(parent);
    this.root = el('div', 'ow-subs', parent);
    this.who = el('div', 'ow-subs-who', this.root, '');
    this.line = el('div', 'ow-subs-line', this.root, '');
    this.queue = [];
    this.t = 0;
    this.life = 0;
    this.active = false;
    setStyle(this.root, 'display', 'none');
  }

  /**
   * @param {{who:string,text:string}[]} lines
   *
   * A scene handed here while a CUT is running is dropped, not queued. Two
   * paths reach this with the same lines the cutscene is already performing —
   * `ui`'s own `mission:start` listener (`playScene(e.lines)`) and any caller
   * that has not been told about the cut — and a caption bar reciting the
   * cutscene underneath the cutscene is the exact defect this all replaces.
   */
  play(lines) {
    if (this.cut.active) return;
    this.queue.length = 0;
    for (const l of lines ?? []) this.queue.push(l);
    this._next();
  }

  push(who, text) {
    if (this.cut.active) return;
    this.queue.push({ who, text });
    if (!this.active) this._next();
  }

  _next() {
    const l = this.queue.shift();
    if (!l) {
      this.active = false;
      setStyle(this.root, 'display', 'none');
      return;
    }
    const boy = BOY_BY_ID[l.who];
    setText(this.who, (boy?.name ?? l.who ?? '').toUpperCase());
    setStyle(this.who, 'color', boy?.colour ?? '#ffc93c');
    setText(this.line, l.text ?? '');
    this.t = 0;
    this.life = clamp(1.6 + (l.text?.length ?? 0) * 0.055, 2.2, 6.5);
    this.active = true;
    setStyle(this.root, 'display', '');
  }

  /**
   * Take ALL dialogue off screen, scene included. `ui.debugState()` calls this
   * to reset the transients before a screenshot, and a cutscene left running
   * there would hold the clock and the camera through the capture.
   */
  clear() {
    this.cut.cancel();
    this.queue.length = 0;
    this.active = false;
    setStyle(this.root, 'display', 'none');
  }

  /** @param {number} dt UNSCALED — `ui.lateUpdate` hands every widget `rawDt`. */
  update(dt) {
    const cut = this.cut.update(dt);
    // A bark already on screen when a scene starts is taken down rather than
    // left burning through its timer behind the letterbox.
    if (this.cut.active) {
      if (this.active) this.clear();
      return cut;
    }
    if (!this.active) return 0;
    this.t += dt;
    if (this.t >= this.life) {
      this._next();
      return this.active ? 1 : 0;
    }
    const a = ease.outCubic(clamp01(this.t / 0.2)) *
      (1 - ease.inOutCubic(clamp01((this.t - (this.life - 0.3)) / 0.3)));
    setStyle(this.root, 'opacity', a.toFixed(3));
    return a;
  }

  dispose() {
    this.cut.dispose();
    this.root.remove();
  }
}

/* ------------------------------------------------------------ big card --- */

const CARD_STYLE = {
  passed: { title: 'MISSION PASSED', cls: 'win', tint: 'rgba(8,14,10,0)' },
  wasted: { title: 'WASTED', cls: 'lose', tint: 'rgba(58,4,8,.42)' },
  busted: { title: 'BUSTED', cls: 'busted', tint: 'rgba(6,18,42,.44)' },
  failed: { title: 'MISSION FAILED', cls: 'lose', tint: 'rgba(30,6,8,.3)' },
};

/**
 * MISSION PASSED / WASTED / BUSTED. The tint is a full-screen wash so the
 * moment reads even if the card itself is off the player's fovea; the reward
 * row underneath prints cash and respect.
 */
export class BigCard {
  constructor(parent) {
    this.tint = el('div', 'ow-card-tint', parent);
    this.root = el('div', 'ow-card', parent);
    this.title = el('div', 'ow-card-title', this.root, '');
    this.sub = el('div', 'ow-card-sub', this.root, '');
    this.rewards = el('div', 'ow-card-rewards', this.root);
    this.t = 0;
    this.life = 4.6;
    this.active = false;
    this.kind = 'passed';
    setStyle(this.root, 'display', 'none');
    setStyle(this.tint, 'display', 'none');
  }

  show(kind, sub, rewards) {
    const st = CARD_STYLE[kind] ?? CARD_STYLE.passed;
    this.kind = kind;
    setText(this.title, st.title);
    setText(this.sub, (sub ?? '').toUpperCase());
    this.root.className = 'ow-card ' + st.cls;
    setStyle(this.tint, 'background', st.tint);
    this.rewards.textContent = '';
    for (const r of rewards ?? []) {
      const cell = el('div', 'ow-card-rw', this.rewards);
      el('b', null, cell, r.value);
      el('span', null, cell, r.label);
    }
    this.t = 0;
    this.active = true;
    setStyle(this.root, 'display', '');
    setStyle(this.tint, 'display', '');
  }

  update(dt) {
    if (!this.active) return 0;
    this.t += dt;
    if (this.t >= this.life) {
      this.active = false;
      setStyle(this.root, 'display', 'none');
      setStyle(this.tint, 'display', 'none');
      return 0;
    }
    const inA = ease.outQuint(clamp01(this.t / 0.55));
    const outA = 1 - ease.inOutCubic(clamp01((this.t - (this.life - 0.8)) / 0.8));
    const a = inA * outA;
    setStyle(this.root, 'opacity', a.toFixed(3));
    setStyle(this.tint, 'opacity', a.toFixed(3));
    const s = 1 + (1 - inA) * 0.18;
    setStyle(this.title, 'transform', `scale(${s.toFixed(3)})`);
    setStyle(this.title, 'letter-spacing', `${(0.02 + (1 - inA) * 0.1).toFixed(3)}em`);
    setStyle(this.rewards, 'opacity', (clamp01((this.t - 0.5) / 0.5) * outA).toFixed(3));
    return a;
  }

  dispose() {
    this.root.remove();
    this.tint.remove();
  }
}

/* ----------------------------------------------------------------- feed -- */

const FEED_MAX = 5;

/** Pickups, unlocks, packages. Top left, oldest at the bottom, all transient. */
export class Feed {
  constructor(parent) {
    this.root = el('div', 'ow-feed', parent);
    this.items = [];
    for (let i = 0; i < FEED_MAX; i++) {
      const n = el('div', 'ow-feed-row', this.root);
      const icon = el('i', null, n);
      const txt = el('span', 'tx', n);
      const val = el('span', 'vl', n);
      setStyle(n, 'display', 'none');
      this.items.push({ n, icon, txt, val, t: 0, life: 0, alive: false });
    }
    this._next = 0;
  }

  /**
   * @param {?string} colour  an explicit accent for the rule and the lozenge.
   *   Anything the player did toasts in the ACTIVE BROTHER'S colour — it is how
   *   you tell, at a glance and without reading, that the thing that just
   *   happened was you and not the world.
   */
  push(text, value = '', tone = 'slag', colour = null) {
    let it = this.items.find((x) => !x.alive);
    if (!it) {
      it = this.items.reduce((a, b) => (a.t > b.t ? a : b));
    }
    it.alive = true;
    it.t = 0;
    it.life = 4.6;
    setText(it.txt, (text ?? '').toUpperCase());
    setText(it.val, value ?? '');
    it.n.className = 'ow-feed-row ' + tone;
    setStyle(it.n, 'border-left-color', colour ?? '');
    setStyle(it.icon, 'background', colour ?? '');
    setStyle(it.n, 'display', '');
    this._reflow();
  }

  clear() {
    for (const it of this.items) {
      it.alive = false;
      setStyle(it.n, 'display', 'none');
    }
  }

  _reflow() {
    const live = this.items.filter((x) => x.alive).sort((a, b) => b.t - a.t);
    for (let i = 0; i < live.length; i++) live[i].order = i;
  }

  update(dt) {
    let vis = 0;
    for (const it of this.items) {
      if (!it.alive) continue;
      it.t += dt;
      if (it.t >= it.life) {
        it.alive = false;
        setStyle(it.n, 'display', 'none');
        this._reflow();
        continue;
      }
      const inA = ease.outCubic(clamp01(it.t / 0.26));
      const outA = 1 - ease.inOutCubic(clamp01((it.t - (it.life - 0.5)) / 0.5));
      const a = inA * outA;
      setStyle(it.n, 'opacity', a.toFixed(3));
      setStyle(it.n, 'transform', `translateX(${((1 - inA) * -18).toFixed(2)}px)`);
      vis = Math.max(vis, a);
    }
    return vis;
  }

  dispose() {
    this.root.remove();
  }
}

/* ---------------------------------------------------------------- radio -- */

/**
 * The station strip. Only visible for a few seconds after a change — a radio
 * readout that never goes away is a radio readout nobody reads.
 */
export class RadioStrip {
  constructor(parent) {
    this.root = el('div', 'ow-radio', parent);
    this.dial = el('div', 'ow-radio-dial', this.root);
    this.ticks = [];
    for (let i = 0; i < 6; i++) this.ticks.push(el('i', null, this.dial));
    const col = el('div', 'ow-radio-col', this.root);
    this.name = el('div', 'ow-radio-name', col, '');
    this.genre = el('div', 'ow-radio-genre', col, '');
    this.freq = el('div', 'ow-radio-freq', this.root, '');
    this.t = 99;
    this.life = 4.2;
    this.index = 0;
    setStyle(this.root, 'display', 'none');
  }

  show(station, index, count) {
    if (!station) return;
    setText(this.name, station.name);
    setText(this.genre, station.genre);
    setText(this.freq, station.freq);
    setStyle(this.name, 'color', station.colour);
    this.index = index;
    for (let i = 0; i < this.ticks.length; i++) {
      setClass(this.ticks[i], 'on', i === index);
      setStyle(this.ticks[i], 'display', i < (count ?? 6) ? '' : 'none');
      setStyle(this.ticks[i], 'background', i === index ? station.colour : '');
    }
    this.t = 0;
    setStyle(this.root, 'display', '');
  }

  update(dt) {
    if (this.t >= this.life) return 0;
    this.t += dt;
    if (this.t >= this.life) {
      setStyle(this.root, 'display', 'none');
      return 0;
    }
    const a = ease.outCubic(clamp01(this.t / 0.24)) *
      (1 - ease.inOutCubic(clamp01((this.t - (this.life - 0.5)) / 0.5)));
    setStyle(this.root, 'opacity', a.toFixed(3));
    setStyle(this.root, 'transform', `translateY(${((1 - ease.outCubic(clamp01(this.t / 0.3))) * 10).toFixed(2)}px)`);
    return a;
  }

  dispose() {
    this.root.remove();
  }
}
