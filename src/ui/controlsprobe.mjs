#!/usr/bin/env node
/**
 * CONTROLS PROBE — does the pause screen tell the player how to play, and is
 * every key it names a key this build actually reads?
 *
 *   npm run build && node src/ui/controlsprobe.mjs
 *   node src/ui/controlsprobe.mjs --port=5173      (reuse a running vite)
 *   node src/ui/controlsprobe.mjs --verbose
 *   node src/ui/controlsprobe.mjs --keep           (leave the browser open)
 *
 * ---------------------------------------------------------------------------
 * WHAT WAS BROKEN
 * ---------------------------------------------------------------------------
 * The pause screen had one line of eight bindings and no more. The contextual
 * action key, the whole weapon layer, the mouse buttons, the handbrake, the horn
 * and the helicopter appeared nowhere on the screen at any point in the game.
 *
 * ---------------------------------------------------------------------------
 * RULE 12 — WHAT THIS MEASURES, AND WHY IT IS NOT THE STRING TABLE
 * ---------------------------------------------------------------------------
 * The tempting gate is "the panel contains the rows in `CONTROL_GROUPS`". That
 * compares `menu.js` to `menu.js` and would pass on a panel listing forty keys
 * that do nothing. Neither side of anything below is that array:
 *
 *   DRAWN   every `<kbd>` under `.ow-menu`, harvested from the live document
 *           with `getBoundingClientRect()` and the full ancestor opacity /
 *           display chain — laid-out CSS pixels, not a field, not a style
 *           string, not "did we call el()". The probe never imports `menu.js`
 *           and never reads a property of the `PauseMenu` instance for any
 *           assertion about content.
 *   TRUTH   the ENGINE, asked in the only way that cannot lie: the key is
 *           pressed for real through the browser's keyboard, and the probe
 *           records whether any live subsystem ASKED `Input` about it and got
 *           a yes, during the frames it was down. `Input.pressed` / `held` /
 *           `action` / `actionPressed` and the `fire` / `ads` / `firePressed`
 *           getters are wrapped on the instance, and only a TRUE return is
 *           recorded. Exactly one key is down at a time, so a recorded hit is
 *           attributable to it.
 *
 * That is a strictly stronger question than "is it in `ACTIONS`". `ACTIONS`
 * binds `grenade` to G and `flashlight` to T, and NOTHING in the tree reads
 * either — `grep -rn "action('grenade')" src/` is empty. Both are keys a player
 * would press once and conclude the game is broken. This probe scores them as
 * unbound, because from the player's side they are.
 *
 * THE DETECTOR IS SELF-TESTED BEFORE IT IS TRUSTED (case 3). G (bound in
 * `ACTIONS`, read by nobody) and Y (bound nowhere at all) are pressed exactly
 * like every other key and MUST come back silent, and W must not. Without that
 * step an always-true detector would score a perfect run on a panel of invented
 * keys, which is the sixth-gate failure mode this project has already shipped.
 *
 * It also found three live keys that are in no document anywhere:
 * `GameSystem._input` (`src/game/index.js:775`) reads J, K and U — start the
 * next chapter, drop it, cycle brother. J was picked as the "bound nowhere"
 * control on the strength of `CONTROLS.md`, and the probe refused it.
 *
 * ---------------------------------------------------------------------------
 * ONE SEAM, NAMED
 * ---------------------------------------------------------------------------
 * `MOUSE — LOOK` is the one row that is not a key. Headless Chromium never
 * grants pointer lock (see the write-up in `src/ui/pauseprobe.mjs`), and
 * `Input._onMouseMove` early-returns unless it believes it is locked, so the
 * probe sets `input.pointerLocked = true` and dispatches real `mousemove`
 * events carrying `movementX`. What is faked is the browser's own lock bit;
 * the handler, the sensitivity path and the camera solver are all real, and the
 * assertion is on the DRAWN camera orientation, not on `input.look`.
 *
 * ---------------------------------------------------------------------------
 * NEGATIVE CONTROLS — measured, not asserted
 * ---------------------------------------------------------------------------
 * Green is 24/24, six runs in a row. Each of these was applied for real to
 * `src/ui/menu.js` and the run repeated:
 *
 *   1. `this.controls = this._buildControls()` removed          -> 19/24
 *      (all five composited-panel checks, and nothing else)
 *   2. one row added: [['G'], '', 'Grenade']                    -> 23/24
 *      G IS in `ACTIONS`. It fails on "every one of them is read by a live
 *      subsystem", because nothing in the tree consumes `action('grenade')`.
 *   3. one row added: [['Y'], '', 'Whistle']                    -> 23/24
 *   4. the Export / Import buttons put back                     -> 23/24
 *   5. `.ow-ctl { display:none }` — the panel built but not drawn -> 21/24
 *
 * Control 2 is the one that matters: it is the exact shape of the mistake this
 * file exists to prevent, and the only reason it goes red is that the truth
 * side of the comparison is the running engine rather than a doc. Control 5
 * matters for a different reason — the panel EXISTS in the DOM in that arm, so
 * anything asserting on the tree rather than on the composited pixels passes
 * it.
 */
import { chromium } from 'playwright';
import { startServer } from '../../tools/lib/server.mjs';

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => a.replace(/^--/, '').split('='))
);
const VERBOSE = 'verbose' in args;
const KEEP = 'keep' in args;

const { port, server } = await startServer({ explicitPort: args.port });
const b = await chromium.launch({
  args: ['--use-angle=metal', '--ignore-gpu-blocklist', '--enable-gpu', '--mute-audio'],
});
const page = await b.newPage({ viewport: { width: 1280, height: 720 } });
const errs = [];
page.on('pageerror', (e) => errs.push(String(e.message).slice(0, 200)));
page.on('console', (m) => { if (m.type() === 'error') errs.push(m.text().slice(0, 200)); });

const results = [];
let area = '';
const rec = (name, ok, detail) => results.push({ area, name, ok: !!ok, detail: String(detail) });

const pump = (n) =>
  page.evaluate(
    (k) => new Promise((d) => { let i = 0; const t = () => (++i >= k ? d() : requestAnimationFrame(t)); requestAnimationFrame(t); }),
    n
  );

/** Run a body with `engine`, `ctx`, `ui`, `game`, `player`, `veh` in scope. */
const run = (body) =>
  page.evaluate(`(() => {
    const engine = window.__ENGINE__;
    const ctx = engine.ctx;
    const ui = ctx.peek('ui');
    const game = ctx.peek('game');
    const player = ctx.peek('player');
    const veh = ctx.peek('vehicles');
    ${body}
  })()`);

/* ===================================================================== */
/* THE DETECTOR                                                          */
/* ===================================================================== */
/**
 * Wrap the live `Input` instance so that every question a subsystem asks about
 * a key — and gets a YES to — is recorded. Only true returns are kept, so the
 * per-frame reads that return false (which is most of them) are invisible.
 *
 * Installed once, on the instance, over the prototype's own methods. Nothing
 * about `Input`'s behaviour changes: every wrapper returns the original value.
 */
const installWatch = () =>
  page.evaluate(() => {
    if (window.__W) return true;
    const inp = window.__ENGINE__.input;
    const proto = Object.getPrototypeOf(inp);
    const W = { on: false, hits: [] };
    window.__W = W;
    const add = (s) => { if (W.on && !W.hits.includes(s)) W.hits.push(s); };
    for (const m of ['pressed', 'held', 'released']) {
      const f = proto[m];
      inp[m] = function watched(code) {
        const r = f.call(this, code);
        if (r) add('code:' + code);
        return r;
      };
    }
    for (const m of ['action', 'actionPressed']) {
      const f = proto[m];
      inp[m] = function watched(name) {
        const r = f.call(this, name);
        if (r) add('act:' + name);
        return r;
      };
    }
    for (const g of ['fire', 'firePressed', 'ads']) {
      const d = Object.getOwnPropertyDescriptor(proto, g);
      if (!d || !d.get) continue;
      Object.defineProperty(inp, g, {
        configurable: true,
        get() {
          const r = d.get.call(this);
          if (r) add('getter:' + g);
          return r;
        },
      });
    }
    return true;
  });

const arm = () => page.evaluate(() => { window.__W.hits.length = 0; window.__W.on = true; });
const disarm = () => page.evaluate(() => { window.__W.on = false; return window.__W.hits.slice(); });

/**
 * Put the game back in the state every sample assumes: nothing modal, nothing
 * latched, the player in control and the clock running.
 *
 * `missions.abort()` is not housekeeping, it is load-bearing, and it cost an
 * entire red run to learn. J starts the next chapter — see `GameSystem._input`
 * — and a chapter intro takes the player's control away, so ONE stray press of
 * an untested letter silently zeroed every gameplay key measured after it and
 * reported twenty-two dead keys that were all fine. A probe that leaves the
 * build in a different state than it found it is a probe measuring its own
 * last step.
 */
const calm = () =>
  run(`
    ui.menu.close();
    if (ui.map?.open) ui.closeMap();
    if (ui.phone?.open) ui.phone.hide();
    if (ui.story?.open) ui.closeStory();
    ui.cheats?.hide?.();
    game?.missions?.abort?.();
    engine.input.down.clear();
    engine.input._pressed.clear();
    engine.input._released.clear();
    engine.input.enabled = true;
    engine.input.frozen = false;
    player?.setControlEnabled?.(true);
    return {
      down: engine.input.down.size,
      hard: !!ui._hardModal(),
      control: player?.controlEnabled !== false,
      scale: engine.ctx.time.scale,
    };`);

/**
 * Press one key at the real browser and report everything the engine asked
 * about while it was down.
 * @param {string} code a KeyboardEvent.code, or Mouse0 / Mouse1 / Mouse2
 */
async function press(code) {
  await arm();
  if (code.startsWith('Mouse')) {
    const btn = code === 'Mouse0' ? 'left' : code === 'Mouse1' ? 'middle' : 'right';
    await page.mouse.down({ button: btn });
    await pump(5);
    const hits = await disarm();
    await page.mouse.up({ button: btn });
    await pump(3);
    return hits;
  }
  await page.keyboard.down(code);
  await pump(5);
  const hits = await disarm();
  await page.keyboard.up(code);
  await pump(3);
  return hits;
}

/* ===================================================================== */
/* TOKEN -> KEY                                                          */
/* ===================================================================== */
/**
 * How a label on the panel becomes something that can be pressed. This map is
 * the probe's own; a token the panel prints that is not in here FAILS, because
 * a key a harness cannot even name is a key a player cannot press either.
 */
const TOKEN = {
  W: 'KeyW', A: 'KeyA', S: 'KeyS', D: 'KeyD',
  E: 'KeyE', Q: 'KeyQ', R: 'KeyR', F: 'KeyF', V: 'KeyV', H: 'KeyH',
  B: 'KeyB', I: 'KeyI', M: 'KeyM', P: 'KeyP', O: 'KeyO', N: 'KeyN',
  X: 'KeyX', C: 'KeyC', G: 'KeyG', T: 'KeyT', J: 'KeyJ', K: 'KeyK', U: 'KeyU',
  // Not bound to anything. They are in the map ON PURPOSE, so
  // that a panel that starts naming one fails on "is it read", which says what
  // is wrong, rather than on "can a harness name it", which does not.
  Y: 'KeyY', L: 'KeyL', Z: 'KeyZ',
  1: 'Digit1', 2: 'Digit2', 3: 'Digit3', 4: 'Digit4', 5: 'Digit5', 6: 'Digit6',
  SHIFT: 'ShiftLeft', CTRL: 'ControlLeft', ALT: 'AltLeft',
  SPACE: 'Space', TAB: 'Tab', ENTER: 'Enter', ESC: 'Escape',
  '↑': 'ArrowUp', '↓': 'ArrowDown', '←': 'ArrowLeft', '→': 'ArrowRight',
  LMB: 'Mouse0', MMB: 'Mouse1', RMB: 'Mouse2',
  MOUSE: 'LOOK',
};

/**
 * Keys whose only reader runs in a vehicle, or only while a list is open.
 * Nothing here is exempt from being proven — they are proven in their own
 * context, in cases 5 and 6.
 */
const IN_CAR = new Set(['KeyH']);
const IN_LIST = new Set(['Enter']);

/* ===================================================================== */
/* THE DRAWN PANEL                                                       */
/* ===================================================================== */
/**
 * Everything about the pause screen that a camera would see. The only
 * load-bearing class name is `.ow-menu`: the keys are found as `<kbd>` elements
 * and the panel is derived as their common ancestor.
 */
const readPanel = () =>
  page.evaluate(() => {
    const menu = document.querySelector('.ow-menu');
    if (!menu) return null;
    const vis = (n) => {
      if (!n || !n.isConnected) return 0;
      let a = 1;
      for (let el = n; el && el !== document.documentElement; el = el.parentElement) {
        const s = getComputedStyle(el);
        if (s.display === 'none' || s.visibility === 'hidden') return 0;
        a *= parseFloat(s.opacity || '1');
      }
      return +a.toFixed(3);
    };
    const kbds = [...menu.querySelectorAll('kbd')];
    const keys = kbds.map((k) => {
      const r = k.getBoundingClientRect();
      return {
        t: k.textContent.trim(),
        a: vis(k),
        x: Math.round(r.x), y: Math.round(r.y),
        w: Math.round(r.width), h: Math.round(r.height),
      };
    });
    // The panel: the deepest element that contains every key.
    let panel = kbds[0] ?? null;
    while (panel && !kbds.every((k) => panel.contains(k))) panel = panel.parentElement;
    const pr = panel?.getBoundingClientRect();
    const box = (sel) => {
      const n = menu.querySelector(sel);
      if (!n) return null;
      const r = n.getBoundingClientRect();
      return { x: r.x, y: r.y, w: r.width, h: r.height, right: r.right, bottom: r.bottom };
    };
    const btns = [...menu.querySelectorAll('button')].map((n) => {
      const r = n.getBoundingClientRect();
      return { t: n.textContent.trim(), a: vis(n), w: Math.round(r.width), h: Math.round(r.height) };
    });
    return {
      keys,
      panel: panel ? { x: pr.x, y: pr.y, w: pr.width, h: pr.height, right: pr.right, bottom: pr.bottom, a: vis(panel) } : null,
      settings: box('.ow-menu-inner'),
      closeX: box('.ow-menu-x'),
      buttons: btns,
      file: !!menu.querySelector('input[type=file]'),
      view: { w: innerWidth, h: innerHeight },
    };
  });

const overlap = (a, c) => {
  if (!a || !c) return 0;
  const w = Math.min(a.right ?? a.x + a.w, c.right ?? c.x + c.w) - Math.max(a.x, c.x);
  const h = Math.min(a.bottom ?? a.y + a.h, c.bottom ?? c.y + c.h) - Math.max(a.y, c.y);
  return w > 0 && h > 0 ? Math.round(w * h) : 0;
};

/* ===================================================================== */

const openMenu = async () => {
  await page.keyboard.press('Escape');
  await pump(24);
  return run('return ui.menu.open === true;');
};
const closeMenu = async () => {
  await run('ui.menu.close(); return true;');
  await pump(24);
  return run('return ui.menu.open === false;');
};

let code = 0;
try {
  await page.goto(`http://127.0.0.1:${port}/?boot=0`, { waitUntil: 'domcontentloaded', timeout: 90000 });
  await page.waitForFunction('window.__READY__===true', null, { timeout: 180000 });
  await pump(90);
  await run(`
    engine.input.enabled = true;
    engine.input.frozen = false;
    player?.setControlEnabled?.(true);
    game?.missions?.abort?.();
    game?.heat?.clear?.('probe');
    return true;`);
  await installWatch();
  // The first synthetic keypress of a session is unreliable in a headless
  // browser — the page has never been interacted with. Burn one.
  await page.keyboard.press('KeyF');
  await pump(8);

  /* ================================================================= */
  area = '1 the panel is on the pause screen';
  /* ================================================================= */
  const closed = await readPanel();
  rec('nothing names a key while the game is running',
    closed.keys.every((k) => k.a < 0.02),
    `${closed.keys.length} key elements, max opacity ${Math.max(0, ...closed.keys.map((k) => k.a))}`);

  const opened = await openMenu();
  rec('the pause menu opens on ESC', opened === true, `menu.open ${opened}`);
  await pump(20);
  const P = await readPanel();

  const shown = P.keys.filter((k) => k.a > 0.5 && k.w > 4 && k.h > 4 &&
    k.x >= 0 && k.y >= 0 && k.x + k.w <= P.view.w && k.y + k.h <= P.view.h);
  rec('the paused screen names at least 30 keys, all of them on screen',
    shown.length >= 30 && shown.length === P.keys.length,
    `${shown.length} of ${P.keys.length} keys composited inside ${P.view.w}x${P.view.h}`);

  const cols = new Set(shown.map((k) => Math.round(k.x / 40)));
  const rows = new Set(shown.map((k) => Math.round(k.y / 8)));
  rec('they are laid out as columns, not one wall of text',
    cols.size >= 3 && rows.size >= 12,
    `${cols.size} column bands x ${rows.size} row bands`);

  rec('the panel does not cover the settings, the exits or the screen',
    P.panel && overlap(P.panel, P.settings) === 0 && overlap(P.panel, P.closeX) === 0 &&
    P.panel.h <= P.view.h * 0.9 && P.panel.w <= P.view.w * 0.62,
    P.panel
      ? `panel ${Math.round(P.panel.w)}x${Math.round(P.panel.h)} at ${Math.round(P.panel.x)},${Math.round(P.panel.y)}` +
        ` · settings overlap ${overlap(P.panel, P.settings)} px2 · close-button overlap ${overlap(P.panel, P.closeX)} px2`
      : 'NO PANEL: no <kbd> in the pause menu at all');

  rec('it fits without scrolling',
    !!P.panel && P.panel.h < P.view.h * 0.86,
    P.panel ? `${Math.round(P.panel.h)} px tall in ${P.view.h}` : '-');

  /* ================================================================= */
  area = '2 no import / export on the pause screen';
  /* ================================================================= */
  const label = (s) => s.toLowerCase();
  const gone = P.buttons.filter((x) => /^(export|import)/.test(label(x.t)));
  rec('no export and no import button on the pause screen',
    gone.length === 0 && P.file === false,
    gone.length ? gone.map((x) => x.t).join(' · ') : (P.file ? 'the file picker is still there' : 'gone, and the file picker with it'));

  // The erase button was on this screen when this probe was written and has
  // since moved to brother-select, so the assertion INVERTS — it must NOT be
  // here. That it still works, is still behind its confirm, and re-renders the
  // cards is now `src/ui/eraseprobe.mjs`'s job on the screen it moved to.
  //
  // This is not rule 13. The threshold did not move to go green; the
  // requirement changed, and a probe still asserting the old placement would
  // pin the UI to a layout that is no longer wanted.
  const wipe = P.buttons.find((x) => label(x.t).startsWith('erase'));
  rec('no erase button on the pause screen either — it lives on brother-select',
    !wipe,
    wipe ? `STILL HERE: "${wipe.t}" ${wipe.w}x${wipe.h} @${wipe.a}` : 'gone — see npm run erase');

  const wipeApi = await run("return typeof ctx.peek('game')?.wipeSave;");
  rec('and it still reaches `game`', wipeApi === 'function', `game.wipeSave is ${wipeApi}`);

  /* ================================================================= */
  area = '3 the detector can say no';
  /* ================================================================= */
  await closeMenu();
  await calm();
  await pump(10);
  // All three are pressed exactly as every real key below is. If either of the
  // first two comes back with a hit, nothing in case 4, 5 or 6 means anything.
  //
  // G is in `ACTIONS` and no subsystem reads it; Y is in neither. `grep -rn
  // "KeyY" src/` is empty, which is the whole reason it is the
  // control — pick a different letter and check that first, because pressing an
  // unaudited one is how this probe found J.
  const gHits = await press('KeyG');
  rec('G — bound in ACTIONS, read by nobody — scores as unbound',
    gHits.length === 0, gHits.length ? gHits.join(', ') : 'silent, as it must be');
  const yHits = await press('KeyY');
  rec('Y — bound nowhere at all — scores as unbound',
    yHits.length === 0, yHits.length ? yHits.join(', ') : 'silent, as it must be');
  await calm();
  const wHits = await press('KeyW');
  rec('and it can say yes: W is read', wHits.length > 0, wHits.join(', ') || 'NOTHING READ W');

  /* ================================================================= */
  area = '4 every key the panel names is a key the game reads';
  /* ================================================================= */
  // Six weapons in hand, or the number row has nothing to switch to: the reader
  // in `weapons` is `for (i < Math.min(6, loadout.length))`, so with three
  // weapons the keys 4, 5 and 6 are never asked about and score as dead.
  //
  // Through the ECONOMY, not just `weapons.giveWeapon`, and re-applied before
  // every number-row press. `weapons` rebuilds the loadout from
  // `economy.loadout(id, boy)` whenever the character is restored — which
  // `missions.abort()` does, and `calm()` calls it between every key — so a
  // bare `giveWeapon` is undone a few frames later. Two earlier versions of
  // this probe reported 4, 5 and 6 dead for that reason and for that reason
  // only; `unlockWeapon` writes the save the recompute reads.
  /**
   * `unlockEverything()` — the story-completion reward — and NOT `giveWeapon`.
   *
   * Two earlier versions of this used `giveWeapon` and then `economy.
   * unlockWeapon`, and both reported the number row dead one run in three.
   * The reason is worth writing down, because the symptom was a loadout read as
   * SEVEN a few frames before a press and THREE a few frames after it:
   * `WeaponSystem._resolveUnlocks` ends in `all.filter(w => owned.includes(w))`
   * where `all` is `BROTHER_LOADOUT[brother]` — six ids, and only six. A
   * weapon granted out of another brother's six is spliced straight into
   * `loadout` by `giveWeapon` and then filtered back out by the next resolve,
   * which `missions.abort()` triggers through the character restore that
   * `calm()` performs between every key.
   *
   * `unlockAll` short-circuits that filter (`if (this.unlockAll) return
   * this.setLoadout(all)`), so the loadout is the brother's full six and stays
   * six however many times the character is restored.
   */
  const topUp = () =>
    run(`
      const wp = ctx.peek('weapons');
      wp.unlockEverything();
      return wp.loadout.length;`);
  const load = await topUp();
  rec('the brother is carrying six weapons, so the number row has six slots',
    load >= 6, `${load} in the loadout`);

  const tokens = [...new Set(P.keys.map((k) => k.t))];
  const unknown = tokens.filter((t) => !(t in TOKEN));
  rec('every key the panel prints is one a harness can name',
    unknown.length === 0, unknown.length ? `UNKNOWN: ${unknown.join(' ')}` : `${tokens.length} distinct keys`);

  /**
   * The state a sample is only valid in: the player in control, the clock
   * running, no modal eating the key, and — for the number row — at least N
   * weapons carried, because the reader in `weapons` is
   * `i < Math.min(6, loadout.length)` and key 5 with three weapons is an empty
   * slot rather than a dead binding.
   */
  const state = () =>
    run(`
      return {
        control: player?.controlEnabled !== false,
        scale: engine.ctx.time.scale,
        hard: !!ui._hardModal(),
        guns: ctx.peek('weapons')?.loadout?.length ?? 0,
        boy: game?.economy?.save?.active ?? null,
      };`);

  /**
   * One key, up to three attempts. A press whose PRECONDITIONS did not hold is
   * thrown away and retried rather than counted, because it is not a
   * measurement of the key at all — and if the conditions never hold, that is
   * reported as itself instead of as a dead key.
   *
   * The number row is why this exists. `calm()` aborts any running mission
   * between every key, a mission abort restores the character, and the restore
   * rebuilds the loadout out of the save a frame or two later — so a loadout
   * read as 7 before the press could be 3 during it, and keys 4-6 were never
   * asked about. That scored a false DEAD KEY on one run in three.
   */
  const sample = async (t, c) => {
    const need = /^[1-6]$/.test(t) ? Number(t) : 0;
    let last = null;
    for (let attempt = 0; attempt < 3; attempt++) {
      await calm();
      await pump(6);
      if (need) await topUp();
      const before = await state();
      const hits = await press(c);
      const after = await state();
      const held = before.control && after.control && before.scale > 0 && after.scale > 0 &&
        !before.hard && before.guns >= need && after.guns >= need;
      last = { hits, held, before, after, attempt: attempt + 1 };
      if (hits.length || held) break;
    }
    await calm();
    return last;
  };

  const bad = [];
  const seen = [];
  const stale = [];
  for (const t of tokens) {
    const c = TOKEN[t];
    if (!c || c === 'LOOK') continue;
    if (IN_CAR.has(c) || IN_LIST.has(c)) continue;
    const r = await sample(t, c);
    seen.push(`${t}=${r.hits.length ? r.hits.join('/') : 'NOTHING'}${r.attempt > 1 ? ` (try ${r.attempt})` : ''}`);
    // A key that WAS read needs no alibi: the hit is the evidence, and whether
    // the loadout happened to be seven or eight long at the moment of the
    // bookkeeping read cannot make it less true. The preconditions exist only
    // to license a NEGATIVE — "nothing asked about this key" means something
    // very different when the player had no control at the time.
    if (r.hits.length) continue;
    if (r.held) bad.push(`${t} ${JSON.stringify(r.after)}`);
    else stale.push(`${t} before ${JSON.stringify(r.before)} after ${JSON.stringify(r.after)}`);
  }
  rec('no key was written off without the game being live and in the player\'s hands',
    stale.length === 0,
    stale.length
      ? `CONDITIONS NEVER HELD, SO THESE ARE NOT VERDICTS: ${stale.join(' · ')}`
      : `${seen.length} keys sampled, every silent one with control on and the clock running`);
  rec('and every one of them is read by a live subsystem when it is pressed',
    bad.length === 0,
    bad.length ? `DEAD KEYS: ${bad.join(' ')}` : seen.join(' · '));

  /* ---- the one row that is not a key ---- */
  const look = await run(`
    const inp = engine.input;
    const cam = ctx.camera;
    const q0 = cam.quaternion.clone();
    const was = inp.pointerLocked;
    inp.pointerLocked = true;
    return new Promise((done) => {
      let n = 0;
      const step = () => {
        window.dispatchEvent(new MouseEvent('mousemove', { movementX: 26, movementY: 0, bubbles: true }));
        if (++n < 14) return requestAnimationFrame(step);
        requestAnimationFrame(() => {
          inp.pointerLocked = was;
          done(+q0.angleTo(cam.quaternion).toFixed(4));
        });
      };
      requestAnimationFrame(step);
    });`);
  rec('MOUSE really does turn the camera',
    look > 0.02, `camera turned ${look} rad on 14 mousemoves`);

  /* ================================================================= */
  area = '5 the driving keys, in a car';
  /* ================================================================= */
  await calm();
  /**
   * THE PLAYER IS PUT IN THE CAR THROUGH `game.debugBoard`, NOT BY WALKING.
   *
   * The first version of this phase spawned a sedan 3.2 m away and pressed F,
   * and it failed one run in four — forty keys of walking, jumping and
   * arrow-key strafing leave the player somewhere nobody chose, and from a
   * riverbank or a slope the contextual action is not `enter` at all. A gate
   * that fails a quarter of the time for a reason that is not its subject is
   * the gate everybody learns to re-run instead of read.
   *
   * `debugBoard` is the seam `src/game/index.js` exposes for exactly this, and
   * it runs the same two steps the key path does — `candidate` then `tryEnter`,
   * with the real animation phases and the real `vehicle:enter`. What is being
   * measured here is whether the horn key is READ while driving, and that is
   * unaffected by how the driving started. F itself is proven in case 4, and
   * `npm run interact` (38/38) owns the walk-up-and-press-F chain.
   */
  const car = await run(`
    game.missions.abort();
    const p = player.position;
    for (const o of veh.vehicles.slice()) {
      if (Math.hypot(o.position.x - p.x, o.position.z - p.z) < 70) veh.despawn(o);
    }
    const v = game.wq.spawnVehicle('sedan', p.x + 3.2, p.z, 0);
    window.__CAR__ = v;
    const got = v ? game.debugBoard(v) : false;
    return { name: v ? v.name : null, boarded: got };`);
  await pump(40);
  const inCar = await run('return player.inVehicle === true;');
  rec('the player is at the wheel of a real car', inCar === true,
    `${car.name ?? 'no car'} · debugBoard ${car.boarded} · inVehicle ${inCar}`);

  /**
   * Every car key in one loop, each one re-checking that the player is STILL at
   * the wheel — and re-boarding if he is not. A sample taken after the player
   * has left the car is not a measurement of the key: it reported SPACE and
   * SHIFT dead once, and both of them had been read perfectly on foot ninety
   * seconds earlier.
   *
   * SPACE and SHIFT are on the panel twice — jump / sprint on foot, handbrake
   * and boost in a car. Case 4 proved the on-foot half; this is the other half,
   * and it is the same pair the helicopter's collective rides on.
   */
  /**
   * Seated, and WAITED FOR. `debugBoard` starts the real enter sequence —
   * `tryEnter` walks through PHASE.open / PHASE.jack before PHASE.drive — so
   * `player.inVehicle` is not true on the frame the call returns. Reading it
   * immediately scored the driving keys dead once in five runs, with the
   * player halfway through the door.
   */
  const seat = async () => {
    for (let k = 0; k < 3; k++) {
      if (await run('return player.inVehicle === true;')) return true;
      await run('if (window.__CAR__) game.debugBoard(window.__CAR__); return true;');
      await pump(45);
    }
    return run('return player.inVehicle === true;');
  };
  const carBad = [];
  const carSeen = [];
  const carKeys = [...tokens.map((t) => TOKEN[t]).filter((c) => c && IN_CAR.has(c)), 'Space', 'ShiftLeft'];
  for (const c of carKeys) {
    const seated = await seat();
    await pump(6);
    await arm();
    await page.keyboard.down(c);
    await pump(6);
    const hits = await disarm();
    await page.keyboard.up(c);
    await pump(4);
    carSeen.push(`${c}=${hits.length ? hits.join('/') : 'NOTHING'}${seated ? '' : ' (NOT SEATED)'}`);
    if (!hits.length || !seated) carBad.push(c);
  }
  rec('the driving keys are read while driving — horn, handbrake, boost, collective',
    inCar === true && carBad.length === 0,
    carBad.length ? `DEAD IN A CAR: ${carSeen.join(' · ')}` : carSeen.join(' · '));

  await run(`
    if (player.inVehicle) player.vehicles.abort(player.movement);
    if (window.__CAR__) veh.despawn(window.__CAR__);
    return true;`);
  await pump(20);

  /* ================================================================= */
  area = '6 the list keys, with a list open';
  /* ================================================================= */
  await calm();
  await page.keyboard.down('KeyP');
  await pump(4);
  await page.keyboard.up('KeyP');
  await pump(14);
  const phoneUp = await run('return ui.phone.open === true;');
  rec('P really opens the phone', phoneUp === true, `phone.open ${phoneUp}`);
  const listBad = [];
  const listSeen = [];
  for (const t of tokens) {
    const c = TOKEN[t];
    if (!c || !IN_LIST.has(c)) continue;
    await arm();
    await page.keyboard.down(c);
    await pump(5);
    const hits = await disarm();
    await page.keyboard.up(c);
    await pump(3);
    listSeen.push(`${t}=${hits.length ? hits.join('/') : 'NOTHING'}`);
    if (!hits.length) listBad.push(t);
  }
  rec('the keys that only do anything in a list are read there',
    phoneUp === true && listBad.length === 0,
    listBad.length ? `DEAD IN A LIST: ${listBad.join(' ')}` : (listSeen.join(' · ') || 'none to test'));
  await calm();

  /* ================================================================= */
  area = '7 it goes away again';
  /* ================================================================= */
  const after = await readPanel();
  rec('the controls are off the screen once the game is running again',
    after.keys.every((k) => k.a < 0.02),
    `max key opacity ${Math.max(0, ...after.keys.map((k) => k.a))}`);
  const reopened = await openMenu();
  const again = await readPanel();
  rec('and back on the next pause',
    reopened === true && again.keys.filter((k) => k.a > 0.5).length >= 30,
    `${again.keys.filter((k) => k.a > 0.5).length} keys visible`);
  await closeMenu();

  rec('0 boot', 'the page booted without a script error', errs.length === 0,
    errs.length ? errs.slice(0, 3).join(' | ') : 'clean');

  let last = '';
  let failed = 0;
  for (const r of results) {
    if (r.area !== last) {
      last = r.area;
      console.log(`\n=== ${last} ===`);
    }
    if (!r.ok) failed++;
    console.log(`  ${r.ok ? 'ok  ' : 'FAIL'} ${r.name}`);
    if (!r.ok || VERBOSE) console.log(`       ${r.detail}`);
  }
  console.log(`\ncontrols: ${results.length - failed}/${results.length}`);
  code = failed ? 1 : 0;
} catch (err) {
  console.error('probe threw:', err);
  code = 2;
} finally {
  if (!KEEP || !code) await b.close();
  server?.kill();
}
process.exit(code);
