import * as THREE from 'three';
import { el, svg, setText, setStyle, setClass, damp, ease, clamp } from './util.js';
import { BOYZ, BOY_BY_ID, DISTRICTS, LANDMARKS, buildPoiList } from './data.js';

/**
 * ===========================================================================
 * THE CHEAT / TEST MENU — everything in the game, one keypress away
 * ===========================================================================
 *
 * A test menu: spawn any car, take any weapon, teleport anywhere, change
 * character, set the weather, jump to any chapter.
 *
 * This is a tool for a HUMAN TESTER, so two properties beat polish:
 *
 *   1. **It is fast.** One key (`` ` `` or F8), one button, six tabs, a filter
 *      box that narrows any list to a couple of rows, and every row acts on a
 *      single click. Nothing is more than two clicks from open.
 *   2. **It cannot trap you.** Escape closes it, the button that opened it
 *      closes it, the ✕ closes it, the CLOSE button closes it, and the sim
 *      clock is restored on every one of those paths. See ANTI-TRAP below.
 *
 * ---------------------------------------------------------------------------
 * NOTHING IN HERE IS A HARDCODED LIST
 * ---------------------------------------------------------------------------
 * Every list is enumerated from the owning subsystem's own published table, at
 * the moment the tab is built, so a class or a weapon added next week appears
 * here with no edit:
 *
 *   vehicles   `vehicles.classes`  (= specs.js CLASS_IDS) + `vehicles.specOf(id)`
 *              for the display name and the class kind. 11 today, including the
 *              three new ones (bus, bicycle, heli); the count is never written
 *              down here.
 *   weapons    `weapons.weaponIds` (= the keys of the live state map) and
 *              `weapons.states.get(id).def.label` for the name. 16 today.
 *   teleport   `world.landmarks[]`, `world.districts[]` and `world.pois[]` —
 *              world is the declared authority on where things are — unioned
 *              with `buildPoiList()`, the map furniture `ui` itself draws, so
 *              the menu can never offer a destination the map does not show or
 *              vice versa. Deduplicated on rounded position.
 *   weather    `sky.states` (= WEATHER_NAMES), falling back to the six names in
 *              ARCHITECTURE.md only if `sky` publishes nothing.
 *   missions   `game.getStoryOverview()` for the ACTIVE brother.
 *   brothers   `game.roster()`, falling back to `BOYZ` in ui/data.js.
 *
 * ---------------------------------------------------------------------------
 * ANTI-TRAP — five doors out, and the clock always restarts
 * ---------------------------------------------------------------------------
 * A sticky overlay once pinned `time.scale` at 0 and hung a whole test suite
 * for 74 minutes, and a pause menu that could not be dismissed cost a player
 * the ability to play at all (see the header of `src/ui/menu.js`). Both failure
 * modes are structural, not accidental, so this panel copies every defence the
 * pause menu earned the hard way:
 *
 *   - `ui`'s `PauseArbiter` owns the clock — reached through `ui._syncPause()`,
 *     which derives a `cheats` claim from this panel's `open` flag. (It used to
 *     be `ui._updateModalPause`, which is long gone; the behaviour is the same
 *     and the name was not.) This panel NEVER writes `time.scale` itself; it
 *     only reports `open`. One owner, one restore path, and that path already
 *     refuses to bank a zero.
 *   - Pointer lock is released on `show()` and re-released on any lock granted
 *     while we are up — a locked pointer is what makes the browser EAT Escape.
 *   - Mouse events on the panel are stopped before they reach the window-level
 *     listener in `src/core/input.js` that re-grabs the lock on any click.
 *   - A capture-phase `keydown` on `window` closes the panel directly, so
 *     closing never depends on the frame loop observing a key edge.
 *   - Every action runs inside `_do()`, which catches. GAMEPLAY.md §6: a cheat
 *     that throws costs one toast, never the frame and never the way out.
 *
 * ---------------------------------------------------------------------------
 * OFF BY DEFAULT IN CAPTURES
 * ---------------------------------------------------------------------------
 * `cheatsEnabled()` is the same shape as `bootEnabled()` in `src/ui/boot.js`:
 * `?capture=1` and `navigator.webdriver` both turn it off, so no review frame
 * and no existing probe ever contains it. `?cheats=1` forces it on, which is
 * how `src/ui/cheatprobe.mjs` reaches it — exactly the seam `?boot=1` gives
 * the boot flow.
 */

/* --------------------------------------------------------------- gating --- */

/** Should the cheat menu exist at all? Same rules as `bootEnabled()`. */
export function cheatsEnabled() {
  if (typeof document === 'undefined' || typeof location === 'undefined') return false;
  const q = new URLSearchParams(location.search);
  const flag = q.get('cheats');
  if (flag === '0') return false;
  if (flag === '1') return true;
  // The review harness photographs the world, not the tooling.
  if (q.get('capture') === '1') return false;
  // Every probe and capture tool in this repo drives the page through
  // Playwright, which sets this. They see exactly the HUD they saw before this
  // file existed, so none of them regress.
  if (typeof navigator !== 'undefined' && navigator.webdriver) return false;
  return true;
}

/* ---------------------------------------------------------------- glyphs --- */

/** Stroked 24x24 paths. No image assets exist in this project. */
const GLYPHS = {
  car: 'M3 13l1.6-4.4A2 2 0 016.5 7h11a2 2 0 011.9 1.6L21 13v5h-3v-2H6v2H3zM6.5 15.5h.01M17.5 15.5h.01',
  gun: 'M3 8h13l2 3h3v3h-4l-2 3h-3l-1-3H6a3 3 0 01-3-3zM8 14v4',
  pin: 'M12 21s6.5-6.1 6.5-10.4A6.5 6.5 0 105.5 10.6C5.5 14.9 12 21 12 21zM12 8.4a2.2 2.2 0 100 4.4 2.2 2.2 0 000-4.4z',
  sun: 'M12 5.2V3M12 21v-2.2M5.2 12H3M21 12h-2.2M7.2 7.2L5.6 5.6M18.4 18.4l-1.6-1.6M7.2 16.8l-1.6 1.6M18.4 5.6l-1.6 1.6M12 8a4 4 0 100 8 4 4 0 000-8z',
  heart: 'M12 20s-7-4.3-7-9.1A3.9 3.9 0 0112 8.4a3.9 3.9 0 017 2.5C19 15.7 12 20 12 20z',
  flag: 'M6 21V4M6 5h11l-2.5 3.5L17 12H6',
  bug: 'M9 6a3 3 0 016 0M6 10h12M7 10v4a5 5 0 0010 0v-4M3 12h4M17 12h4M4.5 7.5L7 9M19.5 7.5L17 9M4.5 17.5L7 16M19.5 17.5L17 16',
};

function icon(parent, name, cls) {
  const s = svg('svg', { viewBox: '0 0 24 24', class: cls ?? '' }, parent);
  svg('path', {
    d: GLYPHS[name] ?? GLYPHS.bug, fill: 'none', 'stroke-width': '1.7',
    'stroke-linecap': 'round', 'stroke-linejoin': 'round',
  }, s);
  return s;
}

/**
 * click AND touchend. A synthesized click is not guaranteed once anything in
 * the stack preventDefaults a touch — the same pattern the pause menu and the
 * story overview both use, for the same reason.
 */
function press(node, fn) {
  node.addEventListener('click', (e) => { e.preventDefault(); e.stopPropagation(); fn(); });
  node.addEventListener('touchend', (e) => {
    e.preventDefault();
    e.stopPropagation();
    fn();
  }, { passive: false });
}

/* ----------------------------------------------------------------- tabs --- */

const TABS = [
  ['spawn', 'VEHICLES', 'car'],
  ['weapons', 'WEAPONS', 'gun'],
  ['tp', 'TELEPORT', 'pin'],
  ['world', 'WORLD', 'sun'],
  ['player', 'PLAYER', 'heart'],
  ['story', 'MISSIONS', 'flag'],
];

/** The six `sky` supports (ARCHITECTURE.md). Only used if `sky.states` is absent. */
const WEATHER_FALLBACK = ['clear', 'scattered', 'overcast', 'rain', 'storm', 'fog'];

/** Hour presets — the beats a tester actually wants to photograph. */
const HOUR_PRESETS = [
  ['DAWN', 5.6], ['MORNING', 8], ['NOON', 12], ['GOLDEN', 18.4],
  ['DUSK', 20.2], ['NIGHT', 1.5],
];

/**
 * Day-length presets, in REAL minutes per in-game day. The default cycle reads
 * as too fast; the engine default is 48 minutes
 * (`DEFAULT_TIME_RATE = 24 / (48*60)` in src/sky/index.js), so the useful
 * range runs either side of it and ends at a frozen sun for screenshots.
 */
const DAY_PRESETS = [
  ['FROZEN', 0], ['12 MIN', 12], ['24 MIN', 24], ['48 MIN', 48],
  ['2 HOURS', 120], ['4 HOURS', 240],
];

/** How often the godmode / infinite-ammo pumps re-assert, in seconds. */
const PUMP_PERIOD = 0.25;

/* ================================================================ menu ==== */

export class CheatMenu {
  /**
   * @param {HTMLElement} parent  a layer ABOVE the HUD and the touch controls
   *                              but BELOW the pause menu.
   * @param {object} ctx          engine context
   * @param {object} ui           the UiSystem, for toasts and the map waypoint
   */
  constructor(parent, ctx, ui) {
    this.ctx = ctx;
    this.ui = ui;
    this.rng = ctx.rng?.fork?.() ?? null;

    this.open = false;
    this.a = 0;
    this.tab = 'spawn';
    this.godmode = false;
    this.infiniteAmmo = false;
    this._pump = 0;
    this._rows = [];
    this._escSeen = -1;

    // Preallocated — this file must not allocate in `update()` (rule 5).
    this._v = new THREE.Vector3();
    this._v2 = new THREE.Vector3();
    this._q = new THREE.Quaternion();

    /* ---- the always-on HUD button ------------------------------------- */
    // Deliberately NOT inside `.ow-hud` (which is pointer-events:none
    // wholesale) and NOT a `touch.tapTarget` (those are switched off under a
    // modal). It has to stay live while the panel is up, because "the same
    // button closes it" is one of the five doors out.
    this.btn = el('button', 'ow-cheat-btn', parent);
    this.btn.type = 'button';
    this.btn.setAttribute('aria-label', 'Cheat and test menu');
    icon(this.btn, 'bug');
    el('small', null, this.btn, 'CHEATS');
    press(this.btn, () => this.toggle());

    /* ---- the panel ---------------------------------------------------- */
    this.root = el('div', 'ow-cheat ow-modal', parent);
    const card = el('div', 'ow-cheat-card', this.root);

    const head = el('div', 'ow-cheat-head', card);
    const titleCol = el('div', 'col', head);
    el('div', 'eyebrow', titleCol, 'TEST HARNESS · NOT SHIPPED IN CAPTURES');
    const h = el('h2', null, titleCol);
    h.textContent = 'CHEAT MENU';
    this.hint = el('div', 'sub', head, '` OR F8 · ESC CLOSES');

    this.tabsRow = el('div', 'ow-cheat-tabs', card);
    this.tabBtns = [];
    for (const [id, label, ic] of TABS) {
      const b = el('button', 'ow-cheat-tab', this.tabsRow);
      b.type = 'button';
      b.dataset.tab = id;
      icon(b, ic);
      el('span', null, b, label);
      press(b, () => this.setTab(id));
      this.tabBtns.push([b, id]);
    }

    const filterRow = el('div', 'ow-cheat-filter', card);
    this.search = el('input', null, filterRow);
    this.search.type = 'search';
    this.search.placeholder = 'Filter…';
    this.search.setAttribute('aria-label', 'Filter this list');
    /**
     * `Input._onKeyDown` is bound to `window` and calls `preventDefault()` on
     * every key the game does not explicitly let through — which means a
     * keystroke aimed at this box would never reach it and B would flip the
     * minimap instead of typing a "b". Stopping propagation AT THE TARGET is
     * enough: the window listener is on the bubble phase and never runs, while
     * the capture-phase Escape handler below has already fired.
     */
    for (const t of ['keydown', 'keyup', 'keypress']) {
      this.search.addEventListener(t, (e) => {
        e.stopPropagation();
        if (t === 'keydown' && (e.key === 'Escape' || e.code === 'Escape')) {
          if (this.search.value) {
            this.search.value = '';
            this._applyFilter();
          } else {
            this.search.blur();
            this.hide();
          }
        }
      });
    }
    this.search.addEventListener('input', () => this._applyFilter());
    this.clearBtn = el('button', 'ow-cheat-clear', filterRow, 'CLEAR');
    this.clearBtn.type = 'button';
    press(this.clearBtn, () => {
      this.search.value = '';
      this._applyFilter();
    });

    this.list = el('div', 'ow-cheat-list', card);
    this.status = el('div', 'ow-cheat-status', card, 'Ready.');

    const btns = el('div', 'ow-btns', card);
    this.closeBtn = el('button', 'ow-btn primary', btns, 'Close');
    this.closeBtn.type = 'button';
    press(this.closeBtn, () => this.hide());

    this.x = el('button', 'ow-modal-x', this.root, '✕');
    this.x.type = 'button';
    this.x.setAttribute('aria-label', 'Close');
    press(this.x, () => this.hide());

    setStyle(this.root, 'display', 'none');

    /* ---- the three pointer-lock guards, verbatim from the pause menu --- */
    this._swallow = (e) => e.stopPropagation();
    for (const t of ['mousedown', 'mouseup', 'pointerdown', 'pointerup']) {
      this.root.addEventListener(t, this._swallow);
      this.btn.addEventListener(t, this._swallow);
    }
    this._onLockChange = () => {
      if (!this.open) return;
      if (document.pointerLockElement) document.exitPointerLock?.();
    };
    document.addEventListener('pointerlockchange', this._onLockChange);
    this._onKey = (e) => {
      if (!this.open) return;
      if (e.key !== 'Escape' && e.code !== 'Escape') return;
      // Typing in the filter box handles its own Escape (clear, then close).
      if (e.target === this.search) return;
      this._escSeen = this.ctx.time?.frame ?? 0;
      this.hide();
    };
    addEventListener('keydown', this._onKey, true);
  }

  /** True if `ui._input` should NOT act on this frame's pause edge. */
  consumedEscape() {
    const f = this.ctx.time?.frame ?? 0;
    return this._escSeen >= 0 && f - this._escSeen <= 1;
  }

  /* ------------------------------------------------------------ visibility */

  show() {
    if (this.open) return;
    this.open = true;
    setStyle(this.root, 'display', '');
    // A locked pointer is what makes the browser eat Escape. Release it before
    // anything else — `ui._syncPause()` derives a `cheats` claim from `open`
    // and the arbiter stops the clock this frame.
    document.exitPointerLock?.();
    this.setTab(this.tab);
    this.ui?.sfx?.('wheel_open', 0.5);
  }

  hide() {
    if (!this.open) return;
    this.open = false;
    // The clock is restored by `ui`'s `PauseArbiter`, which is the ONLY owner
    // of `time.scale`. Writing it here as well is how two owners start
    // disagreeing and one of them banks a zero.
    this.ui?.sfx?.('ui_back', 0.4);
  }

  toggle() {
    if (this.open) this.hide();
    else this.show();
  }

  setTab(id) {
    this.tab = TABS.some((t) => t[0] === id) ? id : 'spawn';
    for (const [b, tid] of this.tabBtns) setClass(b, 'on', tid === this.tab);
    this._build();
  }

  /* ---------------------------------------------------------------- rows -- */

  /**
   * One row. `actions` is `[[label, fn, primary?]]`. A row with `why` set is
   * greyed out and says why — a missing subsystem must read as "not available
   * here", never as a dead button and never as a crash.
   */
  _row(name, sub, actions, opts = {}) {
    const row = el('div', 'ow-cheat-row' + (opts.why ? ' off' : ''), this.list);
    const col = el('div', 'col', row);
    const nm = el('div', 'name', col);
    setText(nm, name);
    if (opts.tag) {
      const t = el('span', 'tag', nm, opts.tag);
      if (opts.tagColour) setStyle(t, 'color', opts.tagColour);
    }
    if (sub || opts.why) el('div', 'sub', col, opts.why ? opts.why : sub);
    const acts = el('div', 'acts', row);
    for (const [label, fn, primary] of actions ?? []) {
      const b = el('button', 'ow-cheat-act' + (primary ? ' primary' : ''), acts, label);
      b.type = 'button';
      if (opts.why) b.disabled = true;
      else press(b, () => this._do(label + ' ' + name, fn));
    }
    this._rows.push({ node: row, hay: (name + ' ' + (sub ?? '') + ' ' + (opts.tag ?? '')).toLowerCase() });
    return row;
  }

  _head(text) {
    el('div', 'ow-cheat-head-row', this.list, text);
    this._rows.push({ node: this.list.lastChild, hay: null });
  }

  _applyFilter() {
    const q = this.search.value.trim().toLowerCase();
    let shown = 0;
    for (const r of this._rows) {
      // Section headers (hay === null) ride with the filter: they vanish the
      // moment the player is searching, because a header with no rows under it
      // is the slowest thing in a list you are scanning.
      if (r.hay === null) {
        setStyle(r.node, 'display', q ? 'none' : '');
        continue;
      }
      const on = !q || r.hay.includes(q);
      setStyle(r.node, 'display', on ? '' : 'none');
      if (on) shown++;
    }
    if (q) this._say(`${shown} match${shown === 1 ? '' : 'es'} for "${q}"`);
  }

  _say(text, bad) {
    setText(this.status, text);
    setClass(this.status, 'bad', !!bad);
  }

  /**
   * Run one cheat. GAMEPLAY.md §6: the sim refuses to break — a thrown action
   * logs once, says so in the status line, and leaves every exit working.
   */
  _do(label, fn) {
    let out = null;
    try {
      out = fn();
    } catch (err) {
      console.warn('[cheats] ' + label + ' failed', err);
      this._say(label + ' — failed: ' + (err?.message ?? err), true);
      this.ui?.sfx?.('ui_deny', 0.5);
      return false;
    }
    if (out === false) {
      this._say(label + ' — refused', true);
      this.ui?.sfx?.('ui_deny', 0.5);
      return false;
    }
    this._say(typeof out === 'string' ? out : label + ' — done');
    this.ui?.sfx?.('ui_confirm', 0.5);
    return true;
  }

  /* ------------------------------------------------------------- building - */

  _build() {
    this.list.textContent = '';
    this._rows.length = 0;
    try {
      switch (this.tab) {
        case 'spawn': this._buildSpawn(); break;
        case 'weapons': this._buildWeapons(); break;
        case 'tp': this._buildTeleport(); break;
        case 'world': this._buildWorld(); break;
        case 'player': this._buildPlayer(); break;
        case 'story': this._buildStory(); break;
        default: break;
      }
    } catch (err) {
      console.warn('[cheats] tab build failed', err);
      this._row('This tab could not be built', String(err?.message ?? err), [],
        { why: 'A subsystem it reads is missing or threw. Every other tab still works.' });
    }
    this._applyFilter();
    this.list.scrollTop = 0;
  }

  /* ------------------------------------------------------------- vehicles - */

  _buildSpawn() {
    const veh = this.ctx.peek('vehicles');
    const classes = Array.isArray(veh?.classes) ? veh.classes : null;
    if (!classes || !classes.length) {
      this._row('Vehicle spawning', '', [],
        { why: '`vehicles` is not running, or publishes no `classes` table.' });
      return;
    }
    this._head(`${classes.length} CLASSES — ENUMERATED FROM vehicles.classes`);
    for (const id of classes) {
      let spec = null;
      try { spec = veh.specOf?.(id) ?? null; } catch { spec = null; }
      const name = spec?.name ?? id;
      const kind = spec?.kind ?? 'car';
      const seats = spec?.seats ?? 1;
      const sub = `${id} · ${kind}${seats > 1 ? ' · ' + seats + ' seats' : ''}`
        + (kind === 'boat' ? ' · needs water' : '');
      this._row(String(name).toUpperCase(), sub, [
        ['SPAWN', () => this._spawnVehicle(id, false)],
        ['SPAWN + DRIVE', () => this._spawnVehicle(id, true), true],
      ], { tag: kind.toUpperCase() });
    }
    this._head('HOUSEKEEPING');
    this._row('CLEAR SPAWNED VEHICLES', 'Despawns everything this menu spawned', [
      ['CLEAR', () => this._clearSpawned()],
    ]);
  }

  /**
   * A spot beside the player that a car can actually be driven off.
   *
   * Order of preference, best first: the lane of the nearest road edge (real
   * drivable ground with a real heading), then any legal lane pose in an
   * annulus around the player, then a plain offset from the player's own
   * position. Boats want water instead and say so if there is none in reach.
   *
   * Writes into `this._v` and returns `{ x, z, yaw, why }` or null.
   */
  _spawnSpot(kind) {
    const world = this.ctx.peek('world');
    const p = this.ui?._playerPos?.() ?? this._v2.set(0, 0, 0);
    const px = p.x;
    const pz = p.z;

    if (kind === 'boat') {
      if (typeof world?.isWater !== 'function') return null;
      // Spiral out for open water — 12 m minimum so the hull is never dropped
      // on the player's head, 260 m maximum because past that you are asking
      // for a boat in a different district.
      for (let r = 12; r <= 260; r += 8) {
        for (let i = 0; i < 16; i++) {
          const a = (i / 16) * Math.PI * 2;
          const x = px + Math.cos(a) * r;
          const z = pz + Math.sin(a) * r;
          if (world.isWater(x, z) && world.waterDepthAt?.(x, z) > 0.8) {
            return { x, z, yaw: Math.atan2(x - px, z - pz), water: true };
          }
        }
      }
      return null;
    }

    const roads = world?.roads;
    if (roads?.nearestEdge) {
      const near = roads.nearestEdge(px, pz, 140);
      if (near?.edge) {
        const e = near.edge;
        const lane = near.lane ?? 0;
        // Step ~9 m along the lane so the car lands BESIDE the player rather
        // than inside him. `len` is metres, `t` is 0..1 along the edge.
        const step = e.len > 1 ? 9 / e.len : 0.2;
        let t = (near.t ?? 0.5) + step;
        if (t > 0.94) t = (near.t ?? 0.5) - step;
        t = clamp(t, 0.06, 0.94);
        roads.laneCenter(e, lane, t, this._v);
        const yaw = roads.laneYaw ? roads.laneYaw(e, lane) : 0;
        return { x: this._v.x, z: this._v.z, yaw };
      }
    }
    if (roads?.sampleSpawn && this.rng) {
      const s = roads.sampleSpawn(this.rng, { x: px, z: pz }, 10, 140);
      if (s?.position) return { x: s.position.x, z: s.position.z, yaw: s.yaw ?? 0 };
    }
    // Last resort: 7 m to the player's right, on whatever ground is there.
    const yaw = (this.ui?.state?.heading ?? 0) * Math.PI / 180;
    return { x: px + Math.cos(yaw) * 7, z: pz - Math.sin(yaw) * 7, yaw };
  }

  _spawnVehicle(type, andEnter) {
    const veh = this.ctx.peek('vehicles');
    if (!veh?.spawn) return false;
    let spec = null;
    try { spec = veh.specOf?.(type) ?? null; } catch { spec = null; }
    const kind = spec?.kind ?? 'car';
    const spot = this._spawnSpot(kind);
    if (!spot) {
      return kind === 'boat'
        ? 'No open water within 260 m — drive to a river first'
        : false;
    }
    const y = spot.water
      ? (this.ctx.peek('world')?.waterLevelAt?.(spot.x, spot.z) ?? 0)
      : this.groundY(spot.x, spot.z);
    const comY = Number.isFinite(spec?.comY) ? spec.comY : 0.7;
    this._v.set(spot.x, y + comY + 0.05, spot.z);
    const v = veh.spawn(type, this._v, spot.yaw, {});
    if (!v) return false;
    // `setPose` is what guarantees UPRIGHT: it builds the quaternion from yaw
    // alone, so roll and pitch are zero, and it zeroes the velocities and
    // re-seats the suspension so the car does not arrive already sliding.
    v.setPose?.(this._v, spot.yaw);
    v.syncTransforms?.(1, 0);
    (this._spawned ??= []).push(v);
    const name = (spec?.name ?? type).toString().toUpperCase();
    if (!andEnter) return `Spawned ${name} — ${(y).toFixed(1)} m, upright`;

    const player = this.ctx.peek('player');
    const handler = player?.vehicles;
    if (!handler?.tryEnter) return `Spawned ${name} — walk to it, F to get in`;
    // `tryEnter` enters `handler.candidate`, not an argument. The proximity
    // scan rewrites that field every frame while the phase is 'none', so it is
    // set and used in the same tick.
    handler.candidate = v;
    const got = handler.tryEnter(player.movement);
    return got ? `Spawned ${name} and got in` : `Spawned ${name} — too far to board, walk over`;
  }

  _clearSpawned() {
    const veh = this.ctx.peek('vehicles');
    const list = this._spawned ?? [];
    const player = this.ctx.peek('player');
    let n = 0;
    for (const v of list) {
      if (!v || v === player?.vehicle) continue;
      try { veh?.despawn?.(v); n++; } catch { /* already gone */ }
    }
    list.length = 0;
    return `Despawned ${n}`;
  }

  /* -------------------------------------------------------------- weapons - */

  /**
   * THE REVERT TRAP, and why every row here does three things instead of one.
   *
   * `weapons.update` polls the save twice a second (`_unlockPoll`, 0.5 s) and
   * calls `_resolveUnlocks()`, which rebuilds the loadout as
   *
   *     BROTHER_LOADOUT[activeBrother].filter(w => ownedBySave.includes(w))
   *
   * and then `setLoadout` puts FISTS in your hands the moment the weapon you
   * are holding is not in that list. So `setWeapon(id)` alone is a cheat that
   * silently undoes itself within 500 ms.
   *
   * Two conditions have to hold for a weapon to STAY in hand, and the row
   * satisfies both:
   *
   *   1. the save must say the ACTIVE brother owns it —
   *      `game.economy.unlockWeapon(id, weapons.brotherId)`;
   *   2. the weapon must be in that brother's own six-weapon list. It is a
   *      hard filter and nothing defeats it: `_granted`, `unlockWeapon` and
   *      even `unlockEverything()` all lose to it. So a weapon belonging to
   *      another brother is given by SWITCHING TO HIM first, which is what a
   *      tester wants anyway ("give me the rocket" -> you are Dylan now), and
   *      the row says whose it is before you click.
   */
  _buildWeapons() {
    const w = this.ctx.peek('weapons');
    const ids = Array.isArray(w?.weaponIds) ? w.weaponIds : null;
    if (!ids || !ids.length) {
      this._row('Weapons', '', [], { why: '`weapons` is not running.' });
      return;
    }
    const active = w.brotherId ?? this.ui?.state?.character ?? null;
    const owner = this._weaponOwners();

    this._head('BULK');
    this._row('UNLOCK EVERYTHING', 'Every weapon this brother can carry, plus ammo', [
      ['UNLOCK', () => {
        const ok = w.unlockEverything?.();
        // Idempotent: it returns false when it has already run. That is not a
        // failure, so do not report one.
        w.refillAll?.();
        return ok === false ? 'Already unlocked — ammo refilled' : 'Unlocked everything';
      }, true],
    ]);
    this._row('REFILL AMMO', 'Full magazine and full reserve on all 16', [
      ['REFILL', () => {
        if (typeof w.refillAll !== 'function') return false;
        w.refillAll();
        return 'Ammo refilled';
      }, true],
    ]);
    this._row('INFINITE AMMO', 'Re-tops every magazine four times a second', [
      [this.infiniteAmmo ? 'ON' : 'OFF', () => {
        this.infiniteAmmo = !this.infiniteAmmo;
        this._build();
        return 'Infinite ammo ' + (this.infiniteAmmo ? 'ON' : 'OFF');
      }, this.infiniteAmmo],
    ]);

    this._head(`${ids.length} WEAPONS — ENUMERATED FROM weapons.weaponIds`);
    for (const id of ids) {
      let def = null;
      try { def = w.states?.get?.(id)?.def ?? null; } catch { def = null; }
      const name = (def?.label ?? id).toString().toUpperCase();
      const own = owner[id] ?? null;
      const mine = !own || own === active;
      const boy = own ? BOY_BY_ID[own] : null;
      const sub = def?.melee ? 'melee'
        : `mag ${def?.magSize ?? '?'} · reserve ${def?.reserve ?? '?'}`;
      this._row(name, mine ? sub : sub + ` · switches you to ${boy?.name ?? own}`, [
        ['GIVE', () => this._giveWeapon(id, own), true],
      ], {
        tag: own ? (boy?.name ?? own.toUpperCase()) : 'ANY',
        tagColour: boy?.colour ?? null,
      });
    }
  }

  /**
   * Which brother carries which weapon. Read off `BOYZ[].weapons` in
   * `src/ui/data.js` — the table the weapon wheel already runs on — so the
   * cheat menu and the wheel can never disagree about whose gun this is. It is
   * a HINT for the row label and for deciding whether a switch is needed; the
   * authority is still `weapons`, and `_giveWeapon` verifies the result rather
   * than trusting this map.
   */
  _weaponOwners() {
    if (this._owners) return this._owners;
    const out = Object.create(null);
    for (const b of BOYZ) {
      for (const id of b.weapons ?? []) {
        // Fists are everyone's; anything shared stays unattributed.
        if (id in out) out[id] = null;
        else out[id] = b.id;
      }
    }
    this._owners = out;
    return out;
  }

  _giveWeapon(id, own) {
    const w = this.ctx.peek('weapons');
    const game = this.ctx.peek('game');
    if (!w?.giveWeapon) return false;
    let note = '';

    // 2. the brother must be one who can carry it (see the block comment).
    if (own && w.brotherId && own !== w.brotherId) {
      if (typeof game?.switchTo !== 'function') return false;
      if (!game.switchTo(own)) {
        return `${id.toUpperCase()} belongs to ${own.toUpperCase()} — cannot switch during a job`;
      }
      note = ' (switched to ' + own.toUpperCase() + ')';
    }

    // 1. the SAVE must say he owns it, or the 2 Hz poll takes it away again.
    const brother = w.brotherId ?? game?.character ?? null;
    try {
      if (brother && typeof game?.economy?.unlockWeapon === 'function') {
        game.economy.unlockWeapon(id, brother);
      }
    } catch (err) {
      console.warn('[cheats] unlockWeapon failed', err);
    }
    w.giveWeapon(id);
    // `giveWeapon` hands over a half magazine; a tester wants a full one.
    w.addAmmo?.(id, undefined);
    if (typeof w.setWeaponImmediate === 'function') w.setWeaponImmediate(id, true);
    else w.setWeapon?.(id, true);

    const held = w.activeId === id;
    return held ? `Holding ${id.toUpperCase()}${note}` : `Gave ${id.toUpperCase()}${note}`;
  }

  /* ------------------------------------------------------------- teleport - */

  /**
   * Every destination the world publishes, plus every pin `ui` draws on the
   * map, unioned and deduplicated. Nothing here is a literal list — add a
   * landmark to `world/plan.js` and it appears in this tab.
   */
  _teleportTargets() {
    const world = this.ctx.peek('world');
    const out = [];
    const seen = new Set();
    const add = (name, x, z, group) => {
      if (!Number.isFinite(x) || !Number.isFinite(z)) return;
      const key = group + ':' + Math.round(x / 4) + ',' + Math.round(z / 4);
      if (seen.has(key)) return;
      seen.add(key);
      out.push({ name: String(name ?? '').toUpperCase(), x, z, group });
    };

    const districts = Array.isArray(world?.districts) && world.districts.length
      ? world.districts : DISTRICTS;
    for (const d of districts) add(d.name ?? d.id, d.x, d.z, 'DISTRICT');

    const landmarks = Array.isArray(world?.landmarks) && world.landmarks.length
      ? world.landmarks : LANDMARKS;
    for (const l of landmarks) add(l.name ?? l.id, l.x, l.z, 'LANDMARK');

    // `world.pois` — the RESOLVED service points (they carry a road-side x/z
    // and a yaw, which is why they beat the map mirror when both exist).
    if (Array.isArray(world?.pois)) {
      for (const p of world.pois) add(p.name ?? p.id, p.x, p.z, (p.kind ?? 'POI').toUpperCase());
    }
    // ...and the map furniture `ui` itself draws, so the two can never differ.
    try {
      for (const p of buildPoiList()) add(p.name, p.x, p.z, (p.kind ?? 'POI').toUpperCase());
    } catch (err) {
      console.warn('[cheats] map POI list failed', err);
    }
    return out;
  }

  _buildTeleport() {
    const player = this.ctx.peek('player');
    if (!player) {
      this._row('Teleport', '', [], { why: '`player` is not running.' });
      return;
    }
    this._head('CURSOR');
    const wp = this.ui?.map?.waypoint ?? this.ui?.state?.waypoint ?? null;
    if (wp && Number.isFinite(wp.x) && Number.isFinite(wp.z)) {
      this._row('MAP WAYPOINT', `${wp.x | 0}, ${wp.z | 0}`, [
        ['TELEPORT', () => this._teleport(wp.x, wp.z), true],
      ], { tag: 'CURSOR' });
    } else {
      this._row('MAP WAYPOINT', '', [['TELEPORT', () => false]],
        { tag: 'CURSOR', why: 'Open the full map (M) and click a spot first.' });
    }

    const targets = this._teleportTargets();
    let group = '';
    // Districts and landmarks lead — they are what a tester reaches for — and
    // the services follow, grouped by kind.
    const order = { DISTRICT: 0, LANDMARK: 1 };
    targets.sort((a, b) =>
      (order[a.group] ?? 5) - (order[b.group] ?? 5) ||
      (a.group < b.group ? -1 : a.group > b.group ? 1 : 0) ||
      (a.name < b.name ? -1 : 1));
    for (const t of targets) {
      if (t.group !== group) {
        group = t.group;
        this._head(group);
      }
      this._row(t.name, `${t.x | 0}, ${t.z | 0}`, [
        ['TELEPORT', () => this._teleport(t.x, t.z), true],
      ], { tag: t.group });
    }
  }

  /**
   * THE SURFACE A MAN STANDS ON, reconciled from two independent answers.
   *
   * `world.walkableHeightAt` is analytic, city-wide and always available; it
   * knows the carriageway camber and the 15 cm kerb that `heightAt` does not.
   * A physics down-ray knows the things the analytic field cannot: a bridge
   * deck, a car park roof, a jetty.
   *
   * They are combined by taking the HIGHER of the two, and that direction is
   * not a preference — it is the fix for a real bug. A spawn that trusted the
   * ray alone found geometry BELOW the pavement (the terrain is sunk 0.55 m
   * under every road corridor, and the always-resident coarse clip shell is
   * built from the MINIMUM terrain over each cell, so it is provably at or
   * below real ground). The player was buried 2 m under the street and the
   * game was unplayable.
   *
   * The ray is fired from only 6 m above the analytic surface, which bounds
   * what "higher" can mean: it can find a deck you should be standing on and
   * it cannot find a tower roof two hundred metres up.
   */
  groundY(x, z) {
    const world = this.ctx.peek('world');
    const phys = this.ctx.peek('physics');
    let wy = NaN;
    try {
      wy = world?.walkableHeightAt?.(x, z);
    } catch { wy = NaN; }
    if (!Number.isFinite(wy)) {
      try { wy = world?.heightAt?.(x, z); } catch { wy = NaN; }
    }
    if (!Number.isFinite(wy)) wy = 0;

    let ry = -Infinity;
    try {
      const h = phys?.groundHeight?.(x, z, wy + 6);
      if (Number.isFinite(h)) ry = h;
    } catch { ry = -Infinity; }

    return ry > wy ? ry : wy;
  }

  /**
   * Land ON the ground at (x,z). If the player is in a vehicle the VEHICLE is
   * moved and he rides with it — `VehicleHandler._stepDrive` pins the body to
   * the live seat transform every frame, so the car is the only thing that has
   * to be told. Teleporting the man out from under himself would also break
   * every mission distance check, which all read the vehicle's position while
   * `inVehicle` is true.
   */
  _teleport(x, z, yaw = null) {
    const player = this.ctx.peek('player');
    if (!player) return false;
    const y = this.groundY(x, z);
    const heading = yaw ?? ((this.ui?.state?.heading ?? 0) * Math.PI) / 180;

    const v = player.vehicle ?? null;
    if (v && player.inVehicle) {
      const comY = Number.isFinite(v.spec?.comY) ? v.spec.comY : 0.7;
      this._v.set(x, y + comY + 0.05, z);
      if (typeof v.setPose !== 'function') return false;
      v.setPose(this._v, heading);
      v.syncTransforms?.(1, 0);
      return `Moved the ${String(v.name ?? v.type ?? 'car').toUpperCase()} to ${x | 0}, ${z | 0}`;
    }

    const game = this.ctx.peek('game');
    // `placePlayer` is the canonical wrapper: it drops any vehicle, teleports
    // the movement capsule and resets the camera rig. `yOverride` is exactly
    // the seam this needs, so the reconciled height above is what is used.
    if (typeof game?.wq?.placePlayer === 'function') {
      if (game.wq.placePlayer(x, z, heading, y + 0.06)) {
        return `Teleported to ${x | 0}, ${z | 0} (ground ${y.toFixed(2)} m)`;
      }
    }
    if (typeof player.teleport === 'function') {
      const scale = player.brother?.build?.scale ?? 1;
      this._v.set(x, y + 0.06 + 1.66 * scale, z);
      player.teleport(this._v, heading);
      return `Teleported to ${x | 0}, ${z | 0} (ground ${y.toFixed(2)} m)`;
    }
    return false;
  }

  /* ---------------------------------------------------------------- world - */

  _buildWorld() {
    const sky = this.ctx.peek('sky');
    if (!sky) {
      this._row('World state', '', [], { why: '`sky` is not running.' });
    } else {
      this._head('TIME OF DAY');
      const hour = Number.isFinite(sky.timeOfDay) ? sky.timeOfDay : sky.hour;
      this._row('CURRENT', Number.isFinite(hour) ? this._clock(hour) : '—', [], { tag: 'NOW' });
      for (const [label, h] of HOUR_PRESETS) {
        this._row(label, this._clock(h), [
          ['SET', () => {
            if (typeof sky.setTimeOfDay !== 'function') return false;
            sky.setTimeOfDay(h);
            return label + ' — ' + this._clock(h);
          }, true],
        ], { tag: 'HOUR' });
      }
      this._row('NUDGE THE CLOCK', 'Step the hour without waiting for the cycle', [
        ['-1 H', () => this._nudgeHour(sky, -1)],
        ['+1 H', () => this._nudgeHour(sky, 1)],
        ['+6 H', () => this._nudgeHour(sky, 6)],
      ], { tag: 'HOUR' });

      this._head('DAY LENGTH — THE CYCLE THE PLAYER FOUND TOO FAST');
      const rate = Number.isFinite(sky.timeRate) ? sky.timeRate : null;
      const mins = rate ? 24 / rate / 60 : 0;
      this._row('CURRENT', rate === 0 ? 'frozen'
        : rate ? `${mins.toFixed(0)} real minutes per game day` : '—', [], { tag: 'RATE' });
      for (const [label, m] of DAY_PRESETS) {
        this._row(label, m === 0 ? 'the sun stops where it is'
          : `${m} real minutes for a full 24 hours`, [
          ['SET', () => {
            if (typeof sky.setTimeRate !== 'function') return false;
            sky.setTimeRate(m === 0 ? 0 : 24 / (m * 60));
            return 'Day length ' + label;
          }, true],
        ], { tag: 'RATE' });
      }

      this._head('WEATHER');
      const states = Array.isArray(sky.states) && sky.states.length ? sky.states : WEATHER_FALLBACK;
      for (const s of states) {
        this._row(String(s).toUpperCase(), s === sky.weatherState ? 'active now' : '', [
          ['SNAP', () => {
            if (typeof sky.snapWeather === 'function') sky.snapWeather(s);
            else if (typeof sky.setWeather === 'function') sky.setWeather(s, { immediate: true });
            else return false;
            this._build();
            return 'Weather ' + String(s).toUpperCase();
          }, true],
          ['BLEND 30s', () => {
            if (typeof sky.setWeather !== 'function') return false;
            sky.setWeather(s, 30);
            return 'Blending to ' + String(s).toUpperCase();
          }],
        ], { tag: 'SKY' });
      }
    }

    this._head('HEAT');
    const police = this.ctx.peek('police');
    for (let n = 0; n <= 5; n++) {
      this._row('WANTED ' + n, n === 0 ? 'no heat' : '★'.repeat(n), [
        ['SET', () => {
          if (typeof police?.setWanted !== 'function') return false;
          police.setWanted(n);
          return 'Wanted level ' + n;
        }, true],
      ], {
        tag: 'HEAT',
        why: police ? null : '`police` is not running.',
      });
    }
    this._row('CLEAR WANTED', 'Stands every unit down, not just the stars', [
      ['CLEAR', () => {
        if (typeof police?.clearWanted !== 'function') return false;
        police.clearWanted('cheat');
        return 'Heat cleared';
      }, true],
    ], { tag: 'HEAT', why: police ? null : '`police` is not running.' });
  }

  _nudgeHour(sky, d) {
    const h = Number.isFinite(sky.timeOfDay) ? sky.timeOfDay : sky.hour;
    if (!Number.isFinite(h) || typeof sky.setTimeOfDay !== 'function') return false;
    const next = ((h + d) % 24 + 24) % 24;
    sky.setTimeOfDay(next);
    this._build();
    return 'Clock ' + this._clock(next);
  }

  _clock(h) {
    const hh = Math.floor(((h % 24) + 24) % 24);
    const mm = Math.floor((h - Math.floor(h)) * 60);
    return (hh < 10 ? '0' : '') + hh + ':' + (mm < 10 ? '0' : '') + mm;
  }

  /* --------------------------------------------------------------- player - */

  _buildPlayer() {
    const player = this.ctx.peek('player');
    const game = this.ctx.peek('game');

    this._head('BROTHER — game.switchTo(id)');
    const roster = (() => {
      try {
        const r = game?.roster?.();
        return Array.isArray(r) && r.length ? r : null;
      } catch { return null; }
    })();
    const boys = roster ?? BOYZ.map((b) => ({ id: b.id, name: b.name, colour: b.colour }));
    const activeId = game?.character ?? this.ui?.state?.character ?? null;
    for (const b of boys) {
      const meta = BOY_BY_ID[b.id];
      this._row(String(b.name ?? b.id).toUpperCase(),
        b.id === activeId ? 'active' : (meta?.role ?? ''), [
          ['SWITCH', () => {
            if (typeof game?.switchTo !== 'function') return false;
            if (!game.switchTo(b.id)) return 'Refused — not during a job';
            this._build();
            return 'Now playing ' + String(b.name ?? b.id).toUpperCase();
          }, b.id !== activeId],
        ], {
          tag: b.id === activeId ? 'ACTIVE' : '',
          tagColour: b.colour ?? meta?.colour ?? null,
          why: game ? null : '`game` is not running.',
        });
    }

    this._head('VITALS');
    this._row('HEAL', 'Health back to full', [
      ['HEAL', () => {
        if (typeof player?.heal !== 'function') return false;
        player.heal(player.maxHealth ?? 200);
        return 'Healed to ' + Math.round(player.health$ ?? player.maxHealth ?? 0);
      }, true],
    ], { why: player ? null : '`player` is not running.' });
    this._row('ARMOUR', 'Armour back to full', [
      ['ARMOUR', () => {
        if (typeof player?.addArmour !== 'function') return false;
        player.addArmour(player.maxArmour ?? 100);
        return 'Armour ' + Math.round(player.armour ?? 0);
      }, true],
    ], { why: player ? null : '`player` is not running.' });
    this._row('GODMODE', 'Pins health and armour at full, four times a second', [
      [this.godmode ? 'ON' : 'OFF', () => {
        this.godmode = !this.godmode;
        if (this.godmode) this._pumpGod();
        this._build();
        return 'Godmode ' + (this.godmode ? 'ON' : 'OFF');
      }, this.godmode],
    ], { why: player ? null : '`player` is not running.' });
    this._row('INFINITE AMMO', 'Same switch as the WEAPONS tab', [
      [this.infiniteAmmo ? 'ON' : 'OFF', () => {
        this.infiniteAmmo = !this.infiniteAmmo;
        this._build();
        return 'Infinite ammo ' + (this.infiniteAmmo ? 'ON' : 'OFF');
      }, this.infiniteAmmo],
    ], { why: this.ctx.peek('weapons') ? null : '`weapons` is not running.' });

    this._head('MONEY — game.economy.addCash');
    const cash = game?.cash ?? game?.money;
    this._row('CURRENT', Number.isFinite(cash) ? '$' + Number(cash).toLocaleString('en-US') : '—',
      [], { tag: 'CASH' });
    for (const n of [1000, 10000, 100000, 1000000]) {
      this._row('GIVE $' + n.toLocaleString('en-US'), '', [
        ['GIVE', () => {
          if (typeof game?.economy?.addCash !== 'function') return false;
          game.economy.addCash(n, 'cheat');
          this._build();
          return 'Paid $' + n.toLocaleString('en-US');
        }, true],
      ], { tag: 'CASH', why: game?.economy ? null : '`game.economy` is not running.' });
    }
  }

  /* -------------------------------------------------------------- missions - */

  _buildStory() {
    const game = this.ctx.peek('game');
    if (!game) {
      this._row('Missions', '', [], { why: '`game` is not running.' });
      return;
    }
    let data = null;
    try {
      data = typeof game.getStoryOverview === 'function' ? game.getStoryOverview() : null;
    } catch (err) {
      console.warn('[cheats] story overview failed', err);
    }
    const rows = Array.isArray(data) ? data : data?.chapters ?? data?.rows ?? null;
    if (!Array.isArray(rows) || !rows.length) {
      this._row('Chapters', '', [], { why: '`game.getStoryOverview()` returned nothing.' });
      return;
    }
    this._head((data?.title ?? 'THE STORY') + ' — ANY CHAPTER, LOCKED OR NOT');
    for (let i = 0; i < rows.length; i++) {
      const r = rows[i] ?? {};
      const index = Number.isInteger(r.index) ? r.index : i;
      const name = (r.name ?? r.title ?? 'CHAPTER ' + (index + 1)).toString().toUpperCase();
      const sub = [r.teaser ?? r.desc ?? '', r.zone ?? '', r.track ?? '']
        .filter(Boolean).join(' · ');
      this._row(name, sub, [
        ['START', () => {
          if (typeof game.startMission !== 'function') return false;
          const M = game.startMission(index);
          if (!M) return 'Refused — finish the current job first';
          this.hide();
          return 'Started ' + name;
        }, true],
      ], { tag: (r.status ?? '').toString().toUpperCase() || 'CHAPTER' });
    }
    this._head('CONTROL');
    this._row('ABORT CURRENT MISSION', 'Back to free roam', [
      ['ABORT', () => {
        if (typeof game.abortMission !== 'function') return false;
        return game.abortMission() ? 'Mission aborted' : 'Nothing running';
      }],
    ]);
  }

  /* ----------------------------------------------------------------- pumps - */

  _pumpGod() {
    const player = this.ctx.peek('player');
    if (!player) return;
    try {
      player.heal?.(player.maxHealth ?? 200);
      player.addArmour?.(player.maxArmour ?? 100);
    } catch (err) {
      console.warn('[cheats] godmode pump failed', err);
      this.godmode = false;
    }
  }

  /**
   * Driven with UNSCALED time from `ui.lateUpdate`, so the toggles keep working
   * while the panel itself has the sim frozen — and, more importantly, keep
   * working after it is closed. Allocates nothing.
   */
  update(rawDt) {
    if (this.godmode || this.infiniteAmmo) {
      this._pump -= rawDt;
      if (this._pump <= 0) {
        this._pump = PUMP_PERIOD;
        if (this.godmode) this._pumpGod();
        if (this.infiniteAmmo) {
          try { this.ctx.peek('weapons')?.refillAll?.(); } catch { this.infiniteAmmo = false; }
        }
      }
    }

    // The button hides under anything that owns the screen, and STAYS UP while
    // our own panel is open — "the same button closes it" is a door out.
    const ui = this.ui;
    const covered = !ui ? false : !!(ui.menu?.open || ui.map?.open || ui.phone?.open ||
      ui.story?.open || ui.ending?.active || ui.bigCard?.active || ui.boot?.active);
    setStyle(this.btn, 'display', covered && !this.open ? 'none' : '');
    setClass(this.btn, 'on', this.open);

    this.a = damp(this.a, this.open ? 1 : 0, 16, rawDt);
    if (!this.open && this.a < 0.005) {
      setStyle(this.root, 'display', 'none');
      setStyle(this.root, 'pointer-events', 'none');
      return 0;
    }
    setStyle(this.root, 'display', '');
    setStyle(this.root, 'pointer-events', this.open ? 'auto' : 'none');
    setStyle(this.root, 'opacity', ease.outQuad(this.a).toFixed(3));
    return this.a;
  }

  dispose() {
    removeEventListener('keydown', this._onKey, true);
    document.removeEventListener('pointerlockchange', this._onLockChange);
    // Whatever state the panel was in, it comes down with the subsystem — an
    // overlay that outlives its owner is the exact shape of the 74-minute hang.
    this.open = false;
    this.godmode = false;
    this.infiniteAmmo = false;
    this.root.remove();
    this.btn.remove();
  }
}
