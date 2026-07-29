import { el, setStyle, setText, clamp, clamp01, damp } from './util.js';
import { installStyles } from './style.js';
import { BOYZ, BOY_BY_ID } from './data.js';

/**
 * ===========================================================================
 * BOOT FLOW — loader → brother select → intro card → play
 * ===========================================================================
 *
 * Without this, boot drops straight into the world with nothing on screen while
 * the city streams, which is also why the wait *feels* like a hang rather than a
 * load.
 *
 * The shape is —
 *
 *   1. a progress bar with a named stage, so the wait is legible;
 *   2. one card per playable brother, each showing where that save left off;
 *   3. a full-bleed intro card in that brother's own colour, carrying his
 *      blurb, his turf, his rival and his tagline;
 *   4. START, which hands control to the game.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS MODULE PAINTS AT IMPORT TIME
 * ---------------------------------------------------------------------------
 * A loading screen that appears after the engine has loaded is not a loading
 * screen. `src/main.js` imports the whole subsystem graph before it calls
 * `engine.init()`, and `UiSystem.init` does not run until part-way through
 * that init — so the only moment early enough to cover the *whole* boot is
 * module evaluation. `installBoot()` therefore runs on import, painting the
 * loader before a single system has initialised, and `attach(ctx, ui)` wires
 * it to the engine later when there is an engine to wire it to.
 *
 * ---------------------------------------------------------------------------
 * WHEN IT IS SKIPPED
 * ---------------------------------------------------------------------------
 *   ?boot=0            off
 *   ?boot=1            on, even under automation
 *   ?capture=1         off — the review harness photographs the world, not this
 *   navigator.webdriver off by default, so every existing probe
 *                      (tools/playprobe.mjs, src/game/playtest.mjs,
 *                      tools/capture.mjs, src/ui/touchprobe.mjs) boots straight
 *                      into the world exactly as it did before.
 *
 * `window.__BOOT__` is the live instance, for probes that want to drive it.
 */

const STAGES = [
  'Firing up the mills…',
  'Pouring the Parkway…',
  'Raising the skyline dahntahn…',
  'Filling three rivers…',
  'Hanging forty bridges…',
  'Tuning Steel City radio…',
  'Calling the DeCarlo boys…',
];

/** Milestone → the fraction of the bar it is worth. */
const MARKS = { boot: 0.04, ui: 0.34, world: 0.72, ready: 1 };

/* --------------------------------------------------------------- portrait -- */

/**
 * Per-brother headgear. It is the only thing that separates the three
 * silhouettes, and it is doing real work: at card size the palette reads first
 * and the outline reads second, so a cap, a watch cap and a hood tell you who
 * you are looking at before you get to the name.
 */
const HEADGEAR = {
  // river hand — watch cap pulled down to the brow
  carson: (h) => `<path d="M78 50 Q78 22 100 22 Q122 22 122 50 Z" fill="${h}"/>
    <rect x="76" y="44" width="48" height="9" rx="2" fill="${h}" opacity=".82"/>`,
  // body man — flat shop cap with a peak
  aidan: (h) => `<path d="M78 44 Q78 20 100 20 Q122 20 122 44 Z" fill="${h}"/>
    <path d="M70 44 h58 q6 0 6 5 h-64 z" fill="${h}"/>`,
  // courier — hood up
  dylan: (h) => `<path d="M72 62 Q68 18 100 18 Q132 18 128 62 Q120 34 100 34 Q80 34 72 62 Z"
      fill="${h}"/>`,
};

/**
 * A procedural card portrait in the brother's own palette: skyline, bust,
 * headgear. No art assets exist in this project and none are introduced here —
 * it is drawn entirely from the `body` colours already in `data.js`.
 *
 * The 200x120 viewBox matches the card's 5:3 art box exactly, so the wide
 * desktop layout crops nothing; the bust is centred so the narrow phone layout,
 * which does crop the sides, still frames a face.
 */
function portrait(boy) {
  const b = boy.body ?? {};
  const id = 'bg_' + boy.id;
  const skin = b.skin ?? '#f0cdae';
  const hair = b.hair ?? '#3b2a1c';
  const shirt = b.shirt ?? boy.colour;
  // A deterministic skyline: same brother, same city, every time.
  let seed = 0;
  for (let i = 0; i < boy.id.length; i++) seed = (seed * 31 + boy.id.charCodeAt(i)) & 0xffff;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
  let sky = '';
  for (let x = -4; x < 204; x += 9) {
    const h = 16 + rnd() * 34;
    const w = 6 + rnd() * 4;
    sky += `<rect x="${x.toFixed(1)}" y="${(120 - h).toFixed(1)}" width="${w.toFixed(1)}" height="${h.toFixed(1)}"/>`;
  }

  return `<svg viewBox="0 0 200 120" preserveAspectRatio="xMidYMid slice" aria-hidden="true">
  <defs>
    <linearGradient id="${id}" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="${boy.accent}" stop-opacity=".42"/>
      <stop offset=".62" stop-color="${boy.colour}" stop-opacity=".2"/>
      <stop offset="1" stop-color="#05070b" stop-opacity=".85"/>
    </linearGradient>
  </defs>
  <rect width="200" height="120" fill="#080b11"/>
  <rect width="200" height="120" fill="url(#${id})"/>
  <g fill="#05070b" opacity=".5">${sky}</g>
  <path d="M52 120 Q52 84 100 82 Q148 84 148 120 Z" fill="${shirt}"/>
  <path d="M100 82 v38" stroke="#05070b" stroke-width="1.6" opacity=".45"/>
  <rect x="90" y="66" width="20" height="18" fill="${skin}"/>
  <ellipse cx="100" cy="50" rx="21" ry="24" fill="${skin}"/>
  <path d="M79 46 Q82 26 100 26 Q118 26 121 46 Q113 36 100 36 Q87 36 79 46 Z" fill="${hair}"/>
  ${(HEADGEAR[boy.id] ?? (() => ''))(hair)}
  <rect x="88" y="50" width="6" height="2.6" fill="#0b1020"/>
  <rect x="106" y="50" width="6" height="2.6" fill="#0b1020"/>
  <rect x="93" y="62" width="14" height="2" fill="#0b1020" opacity=".7"/>
  <rect x="0" y="116" width="200" height="4" fill="${boy.colour}" opacity=".9"/>
</svg>`;
}

/* ------------------------------------------------------------------ flow --- */

export class BootFlow {
  constructor() {
    /** 'load' | 'select' | 'intro' | 'done' */
    this.phase = 'load';
    this.active = true;
    this.ctx = null;
    this.ui = null;
    this.pick = null;
    this.p = 0;
    this.target = MARKS.boot;
    this._t = 0;
    this._raf = 0;
    this._marks = { boot: true };

    this.root = el('div', 'ow-boot ow-modal', document.body);
    // Same guard as the HUD root and the pause menu: `Input._onMouseDown` is on
    // `window` and grabs pointer lock on ANY left click, which retargets the
    // mouseup at the canvas and eats the click. That trap made the pause menu
    // inescapable; it would make START and every character card dead on arrival.
    for (const t of ['mousedown', 'mouseup', 'pointerdown', 'pointerup']) {
      this.root.addEventListener(t, (e) => e.stopPropagation());
    }

    this._buildLoader();
    this._buildSelect();
    this._buildIntro();
    this._show('load');

    /**
     * The flow is driven from rAF, NOT from `ui.lateUpdate`, and that is the
     * whole point: during `engine.init()` there is no frame loop yet — systems
     * are being awaited one after another — and that is exactly the stretch the
     * player is staring at. rAF keeps the bar moving through it.
     *
     * `__READY__` is raised by `src/main.js` once real frames have landed, so
     * the bar finishes on the actual event rather than on a timer.
     */
    this._last = performance.now();
    this._poll = (now) => {
      if (!this.active) return;
      const dt = Math.min(0.1, Math.max(0, (now - this._last) / 1000));
      this._last = now;
      if (window.__READY__ === true) this.mark('ready');
      this.update(dt);
      this._raf = requestAnimationFrame(this._poll);
    };
    this._raf = requestAnimationFrame(this._poll);
  }

  /* ------------------------------------------------------------- loader -- */

  _buildLoader() {
    const w = el('div', 'ow-boot-load', this.root);
    this.loadRoot = w;
    el('div', 'eyebrow', w, 'STEEL CITY');
    const h = el('h1', null, w);
    h.textContent = 'DECARLO BOYZ';
    el('div', 'sub', w, 'THREE BROTHERS · ONE CITY · FORTY BRIDGES');
    const bar = el('div', 'ow-boot-bar', w);
    this.fill = el('i', null, bar);
    const row = el('div', 'ow-boot-row', w);
    this.stage = el('div', 'stage', row, STAGES[0]);
    this.pct = el('div', 'pct', row, '0%');
  }

  /* ------------------------------------------------------------- select -- */

  _buildSelect() {
    const w = el('div', 'ow-boot-select', this.root);
    setStyle(w, 'display', 'none');
    this.selectRoot = w;
    el('div', 'eyebrow', w, 'CHOOSE A BROTHER');
    const h = el('h1', null, w);
    h.textContent = 'WHO ARE YOU TODAY?';
    el('div', 'sub', w,
      'Each brother keeps his own city, his own story and his own save.');
    this.cards = el('div', 'ow-boot-cards', w);
    this.cardEls = [];

    for (const boy of BOYZ) {
      const c = el('div', 'ow-boot-card', this.cards);
      c.tabIndex = 0;
      c.setAttribute('role', 'button');
      c.setAttribute('aria-label', boy.name);
      c.dataset.boy = boy.id;
      c.style.setProperty('--c', boy.colour);
      c.style.setProperty('--a', boy.accent);

      const ava = el('div', 'ava', c);
      ava.innerHTML = portrait(boy);
      el('div', 'live', ava, '');

      const body = el('div', 'body', c);
      const nm = el('h3', null, body);
      nm.textContent = boy.name;
      el('div', 'role', body, boy.role.toUpperCase());
      el('div', 'blurb', body, boy.blurb);

      const st = el('div', 'stats', body);
      for (const [label, v] of boy.stats) {
        const r = el('div', 'stat', st);
        el('span', null, r, label);
        const track = el('div', 'bar', r);
        const fill = el('i', null, track);
        setStyle(fill, 'width', (v * 100).toFixed(0) + '%');
      }

      const prog = el('div', 'prog', body, 'NEW GAME');
      c.__prog = prog;
      c.__live = ava.querySelector('.live');

      const choose = () => this.choose(boy.id);
      c.addEventListener('click', choose);
      c.addEventListener('touchend', (e) => {
        e.preventDefault();
        e.stopPropagation();
        choose();
      }, { passive: false });
      c.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          choose();
        }
      });
      this.cardEls.push(c);
    }

    el('div', 'ow-boot-hint', w,
      'You can switch brothers at any time — hold X, or use the phone.');

    // ---- erase all progress ------------------------------------------------
    // This is the ONLY destructive control on a screen where every other
    // control is one click from starting a game, so it is deliberately not a
    // peer of the cards: small, dim, below the hint line, and it takes a
    // `confirm()` before anything happens. It lives here rather than on the
    // pause menu because this is the only screen that is *about* the save slots
    // — the cards each show where a brother left off, so the thing you are
    // erasing is on screen while you erase it.
    //
    // `menu.wipeSave()` owns the confirm, the failure toasts and the ledger
    // refresh; calling it rather than `game.wipeSave()` keeps one answer to the
    // question. It is reached through `ui`, so `boot` still imports nothing
    // from `src/game/`.
    const eraseRow = el('div', 'ow-boot-erase', w);
    this.eraseBtn = el('button', 'ow-boot-erase-btn', eraseRow, 'Erase all progress');
    this.eraseBtn.type = 'button';
    this.eraseBtn.addEventListener('click', () => {
      // `attach(ctx, ui)` sets `this.ui` long before this can be clicked; the
      // peek is the belt-and-braces path for a select screen shown without one.
      const menu = this.ui?.menu ?? this.ctx?.peek?.('ui')?.menu;
      if (typeof menu?.wipeSave !== 'function') return;
      // A wipe that leaves the old chapter and cash sitting on the cards reads
      // as a no-op and invites a second click, so re-read them either way —
      // `wipeSave` returns false on a declined confirm and on a storage error.
      if (menu.wipeSave()) this._refreshProgress();
    });
  }

  /* -------------------------------------------------------------- intro -- */

  _buildIntro() {
    const w = el('div', 'ow-boot-intro', this.root);
    setStyle(w, 'display', 'none');
    this.introRoot = w;
    const card = el('div', 'card', w);
    this.introCard = card;
    this.introEyebrow = el('div', 'eyebrow', card, '');
    this.introName = el('h1', null, card);
    this.introRole = el('div', 'role', card, '');
    el('div', 'rule', card);
    this.introBody = el('p', 'body', card, '');

    const facts = el('div', 'facts', card);
    this.introFacts = [];
    for (const label of ['TURF', 'HOME', 'RIVAL', 'HEALTH']) {
      const f = el('div', 'fact', facts);
      el('span', 'k', f, label);
      this.introFacts.push(el('span', 'v', f, ''));
    }

    this.introTag = el('div', 'tag', card, '');

    const btns = el('div', 'ow-boot-btns', card);
    this.startBtn = el('button', 'ow-btn primary', btns, 'Start');
    this.startBtn.type = 'button';
    this.backBtn = el('button', 'ow-btn', btns, 'Back');
    this.backBtn.type = 'button';
    this._press(this.startBtn, () => this.start());
    this._press(this.backBtn, () => this._show('select'));
  }

  /** click AND touchend — a synthesized click is not guaranteed once anything
   *  in the stack preventDefaults a touch. */
  _press(node, fn) {
    node.addEventListener('click', fn);
    node.addEventListener('touchend', (e) => {
      e.preventDefault();
      e.stopPropagation();
      fn();
    }, { passive: false });
  }

  /* ------------------------------------------------------------- audio --- */

  /**
   * Wake the mix from inside a boot gesture.
   *
   * Web Audio is illegal until the page has been gestured at, and the boot
   * overlay IS the gesture surface: on a mouse-only desktop the card click and
   * START are the only two user gestures that happen between load and play, so
   * the mix is resumed on the hero-card pick and again on both intro buttons.
   *
   * This is the belt. The braces are that `AudioSystem` now arms its own
   * unlock in the CAPTURE phase, so the `stopPropagation` guards installed in
   * the constructor cannot starve it — a fix that worked only because one file
   * happened not to swallow an event would not survive the next overlay.
   *
   * `after` runs once the graph is actually rendering, because the click that
   * legalises audio is also the click that wants to make the first sound, and
   * at that instant there is no graph to make it with.
   */
  _wakeAudio(after) {
    // `ctx.peek` is the sanctioned way across subsystems (ARCHITECTURE.md); the
    // global is the fallback for the test seam, where the flow can exist before
    // `attach()` has handed it a ctx.
    const audio = this.ctx?.peek?.('audio')
      ?? (typeof window !== 'undefined' ? window.__AUDIO__ : null);
    const done = () => { try { after?.(); } catch { /* sound is never fatal */ } };
    if (!audio) { done(); return null; }
    let p = null;
    try {
      p = audio.resume ? audio.resume() : audio.start?.();
    } catch {
      p = null;
    }
    if (p && typeof p.then === 'function') p.then(done, done);
    else done();
    return p;
  }

  /* ------------------------------------------------------------ wiring --- */

  /** Called from `UiSystem.init` once there is an engine to talk to. */
  attach(ctx, ui) {
    this.ctx = ctx;
    this.ui = ui;
    this.mark('ui');
    this._offWorld = ctx.events.on('world:ready', () => this.mark('world'));
    // The world is behind a full-bleed overlay and the player has not chosen
    // anyone yet: no control, no HUD, and the sim free-runs so the city keeps
    // streaming while the select screen is being read.
    ui.setHudVisible(false);
    ctx.peek('player')?.setControlEnabled?.(false);
    return this;
  }

  /** Advance the bar to a named milestone. Monotonic — it never goes back. */
  mark(name) {
    const v = MARKS[name];
    if (v == null || this._marks[name]) return;
    this._marks[name] = true;
    this.target = Math.max(this.target, v);
  }

  /**
   * Driven from `ui.lateUpdate` with UNSCALED time, and self-driven by rAF
   * before the UI system exists. The bar always creeps so it never reads as a
   * hang, but it cannot pass a milestone it has not reached.
   */
  update(rawDt) {
    if (!this.active) return;
    if (this.phase === 'load') {
      // Creep towards, but never past, the next unreached milestone.
      const ceiling = this.target >= 1 ? 1 : this.target + 0.14;
      this._t += rawDt;
      const creep = clamp01(this._t / 26);
      const goal = Math.min(ceiling, Math.max(this.target, creep));
      this.p = damp(this.p, goal, 2.6, rawDt);
      if (this.target >= 1 && this.p > 0.995) this.p = 1;

      setStyle(this.fill, 'width', (this.p * 100).toFixed(1) + '%');
      setText(this.pct, Math.round(this.p * 100) + '%');
      const i = clamp(Math.floor(this.p * STAGES.length), 0, STAGES.length - 1);
      setText(this.stage, STAGES[i]);

      if (this.p >= 1) {
        this._hold = (this._hold ?? 0) + rawDt;
        if (this._hold > 0.35) this._show('select');
      }
    }
  }

  _show(phase) {
    this.phase = phase;
    setStyle(this.loadRoot, 'display', phase === 'load' ? '' : 'none');
    setStyle(this.selectRoot, 'display', phase === 'select' ? '' : 'none');
    setStyle(this.introRoot, 'display', phase === 'intro' ? '' : 'none');
    if (phase === 'select') this._refreshProgress();
    if (phase === 'select') this.cardEls[0]?.focus?.();
  }

  /**
   * Per-brother save progress, straight off `game.roster()` — chapter reached,
   * cash, respect, and which one the save was left on. That line ("Chapter 3 of
   * 8 · $4,120") is the reason the select screen is worth having: it is where
   * you left off, not a splash.
   */
  _refreshProgress() {
    const game = this.ctx?.peek?.('game');
    let roster = null;
    try {
      roster = game?.roster?.();
    } catch {
      roster = null;
    }
    const played = Array.isArray(roster) && roster.some((x) => (x.chapter ?? 0) > 0);
    for (const c of this.cardEls) {
      const id = c.dataset.boy;
      const r = Array.isArray(roster) ? roster.find((x) => x.id === id) : null;
      let line = 'NEW GAME';
      if (r) {
        const total = r.chapters || 8;
        const cash = '$' + Math.floor(r.cash ?? 0).toLocaleString('en-US');
        if (r.chapter >= total) line = `STORY COMPLETE · ${cash}`;
        else if (r.chapter > 0) line = `CHAPTER ${r.chapter + 1} OF ${total} · ${cash}`;
        else line = `NEW GAME · ${cash}`;
      }
      setText(c.__prog, line);
      const isLast = !!r?.active;
      c.classList.toggle('on', isLast);
      // "LAST PLAYED" is a lie on a save nobody has touched, so a fresh install
      // gets a recommendation instead of a false memory.
      setText(c.__live, isLast ? (played ? 'LAST PLAYED' : 'START HERE') : '');
      setStyle(c.__live, 'display', isLast ? '' : 'none');
    }
  }

  /** A brother was picked — show his card. */
  choose(id) {
    const boy = BOY_BY_ID[id];
    if (!boy) return;
    this.pick = id;
    this.introCard.style.setProperty('--c', boy.colour);
    this.introCard.style.setProperty('--a', boy.accent);
    setText(this.introEyebrow, boy.title ?? boy.name);
    this.introName.textContent = boy.name;
    setText(this.introRole, `${boy.role.toUpperCase()} · ${boy.turf}`);
    setText(this.introBody, boy.intro ?? boy.blurb);
    const vals = [boy.turf, boy.home, boy.rival, `${boy.hp} HP · ${boy.armour} ARMOUR`];
    for (let i = 0; i < this.introFacts.length; i++) setText(this.introFacts[i], vals[i] ?? '');
    setText(this.introTag, boy.tagline ?? '');
    this._show('intro');
    // The first user gesture of the whole session. Wake the mix on it, and only
    // then play the whoosh — before this, `wheel_open` was synthesized into a
    // graph that did not exist and dropped on the floor every single time.
    this._wakeAudio(() => this.ui?.sfx?.('wheel_open', 0.5));
    return id;
  }

  /** START — hand the city over. */
  start() {
    if (!this.active) return;
    const id = this.pick ?? BOYZ[0].id;
    const ctx = this.ctx;

    // START is the last gesture before the city, and on `?boot=0` / `skip()` it
    // is the FIRST one too — choose() never ran. Either way the player must not
    // walk into a silent city.
    this._wakeAudio();

    if (ctx) {
      const game = ctx.peek('game');
      try {
        if (game && game.character !== id) game.switchTo(id);
      } catch (err) {
        console.warn('[ui] boot: could not switch brother', err);
      }
      this.ui?.setCharacter?.(id);
      // Whatever the loader did to the clock, the player is playing now.
      if (ctx.time && !(ctx.time.scale > 0)) ctx.time.scale = 1;
      ctx.peek('player')?.setControlEnabled?.(true);
      this.ui?.setHudVisible?.(true);
      // We are inside a real click, which is the only moment a browser will
      // grant pointer lock — so this is where mouse-look starts.
      ctx.input?.requestPointerLock?.();
      ctx.events?.emit?.('ui:boot', { phase: 'play', character: id });
    }

    this.active = false;
    this.phase = 'done';
    cancelAnimationFrame(this._raf);
    setStyle(this.root, 'opacity', '0');
    setStyle(this.root, 'pointer-events', 'none');
    setTimeout(() => setStyle(this.root, 'display', 'none'), 420);
    this.ui?.notify?.(BOY_BY_ID[id]?.name ?? 'READY', 'STEEL CITY', 'char');
    return id;
  }

  /** Leave the flow without choosing — used by `?boot=0` and by harnesses. */
  skip() {
    if (!this.active) return;
    this.pick = this.pick ?? this.ctx?.peek?.('game')?.character ?? BOYZ[0].id;
    this.start();
  }

  dispose() {
    cancelAnimationFrame(this._raf);
    this._offWorld?.();
    this.root.remove();
    this.active = false;
  }
}

/* -------------------------------------------------------------- install --- */

/** Should the flow run at all? See the header comment. */
export function bootEnabled() {
  if (typeof document === 'undefined' || typeof location === 'undefined') return false;
  const q = new URLSearchParams(location.search);
  const flag = q.get('boot');
  if (flag === '0') return false;
  if (flag === '1') return true;
  if (q.get('capture') === '1') return false;
  // Every probe and capture tool in this repo drives the page through
  // Playwright, which sets this. They boot straight into the world, exactly as
  // they did before this file existed, and none of them regress.
  if (navigator?.webdriver) return false;
  return true;
}

let flow = null;

export function installBoot() {
  if (flow || !bootEnabled()) return flow;
  // The stylesheet normally goes in with `UiSystem.init`, which is far too late
  // to paint a loading screen. It is idempotent, so installing it here costs
  // nothing and the second call is a no-op.
  installStyles();
  flow = new BootFlow();
  window.__BOOT__ = flow;
  return flow;
}

export function getBoot() {
  return flow;
}

/**
 * Test seam. The flow is deliberately OFF under automation (see `bootEnabled`),
 * which would otherwise leave the loader, the select screen and the intro card
 * untestable — and a screen no probe can reach is a screen that breaks quietly.
 * `create()` brings the flow up on an already-booted page, so `touchprobe`
 * exercises the real thing without paying for a second 25-second boot.
 *
 * Published unconditionally and only ever read by probes.
 */
window.__BOOT_API__ = {
  bootEnabled,
  create() {
    if (!flow) {
      installStyles();
      flow = new BootFlow();
      window.__BOOT__ = flow;
    }
    const eng = window.__ENGINE__;
    const ui = eng?.ctx?.peek?.('ui');
    if (ui && !flow.ctx) {
      flow.attach(eng.ctx, ui);
      ui.boot = flow;
    }
    return flow;
  },
};
