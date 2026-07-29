#!/usr/bin/env node
/**
 * DOSSIER PROBE — can a player actually reach the save file, and does the
 * state that comes back match the state that went out?
 *
 *   node src/game/dossierprobe.mjs
 *   node src/game/dossierprobe.mjs --port=5173     (reuse a running vite)
 *   node src/game/dossierprobe.mjs --verbose
 *
 * ---------------------------------------------------------------------------
 * WHAT WAS BROKEN
 * ---------------------------------------------------------------------------
 * `src/game/save.js` shipped `serialiseSave` / `exportFilename` / `importSave`
 * / `wipeAll`, gated by `persistprobe.mjs` at 17/17 — and NOTHING CALLED ANY OF
 * THEM. Measured on the shipped build, in a real browser:
 *
 *   game.exportDossier   undefined
 *   game.importDossier   undefined
 *   game.wipeSave        undefined
 *   pause-menu buttons   low medium high ultra · off on · easy normal hard
 *                        steel · sound on muted · Resume Story Defaults ✕
 *   pause-menu inputs    range range range range range   (no file input)
 *
 * A save layer with no caller is not a feature; it is 400 lines of dead code
 * with a green gate on it. That is the specific failure this probe exists to
 * make impossible: `persistprobe` proves the LAYER works, this one proves a
 * PLAYER CAN REACH IT.
 *
 * A second, unrelated defect was found while reproducing the first, and is
 * gated here too (case 4). Right after `game.newGame()` on the shipped build:
 *
 *   economy true · missions true · freeroam true · characters true · jobs FALSE
 *
 * `newGame` re-pointed five of the six holders of the save object. `jobs` kept
 * the dead one, and `jobs` reads the chapter frontier and the active brother
 * off it (`_storyDone`, `_suggest`) and writes `totals.missions` into it.
 *
 * ---------------------------------------------------------------------------
 * RULE 12 — WHAT THIS MEASURES
 * ---------------------------------------------------------------------------
 * The round trip runs THROUGH THE REAL CONTROLS AND A REAL FILE. Nothing in
 * this probe calls the serialiser, and nothing compares the serialiser's output
 * to itself:
 *
 *   out  the Export BUTTON is clicked; playwright catches the browser's own
 *        download and saves the bytes to disk. The exported artefact is a file
 *        on the filesystem, produced by the same Blob + anchor path a player
 *        gets — not a string returned by a function this probe called.
 *   in   THAT FILE is handed to the menu's real `<input type=file>`, which
 *        fires its real `change` handler.
 *   back every assertion reads the REBUILT LIVE STATE out of a consumer that
 *        is not the save object: the player's world transform via
 *        `player.getHudState().position`, the money on the HUD via
 *        `game.getHudState()`, the wanted level via `heat.wanted`, the
 *        collectibles via the number of package pickups actually spawned in
 *        the world, the map pin via `ui.state.waypoint`, the world clock via
 *        `sky`, and the brother via four separate sub-objects that each hold
 *        their own pointer.
 *
 * The expected values are a HAND-WRITTEN literal (`STAMP` below) stamped into
 * the live game before the export, so "it round-tripped" cannot degenerate into
 * "the code agrees with itself".
 *
 * THE PRECONDITION IS ENFORCED, NOT ASSUMED. Between export and import the
 * probe presses Erase all, and asserts every one of those quantities is at a
 * blank-save value FIRST. Without that step "the field came back" is satisfied
 * by a field that never changed, which is the way this kind of gate usually
 * lies.
 *
 * The one number taken from the code under test is the player position, and it
 * is taken as an INDEPENDENT MEASUREMENT rather than as an input: the probe
 * reads where the player actually is (a standable spot, by construction),
 * remembers it in node, and afterwards asserts the rebuilt player is within
 * 0.5 m of it. `game` is never asked what it thinks the position was.
 *
 * ---------------------------------------------------------------------------
 * NEGATIVE CONTROL
 * ---------------------------------------------------------------------------
 * No `--break` flag: revert for real and watch it go red. All six reverts were
 * applied and measured. Green is 21/21.
 *
 *   remove the three dossier buttons from `menu.js`          -> 4/21
 *   `exportDossier` deleted from `game/index.js`             -> 6/21
 *   `importDossier` deleted from `game/index.js`             -> 8/21
 *   `_adoptSave` drops `this.jobs.save = save`               -> 19/21
 *   `_adoptSave` drops `missions.difficulty = ...`           -> 20/21
 *   `_adoptSave` drops the `characters.switching` guard      -> 18/21
 *   `wipeSave` back to `wipeAll(); this.newGame();`          -> 20/21
 *   `fileIn.value` never cleared                             -> 20/21
 */
import { chromium } from 'playwright';
import { mkdtemp, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startServer } from '../../tools/lib/server.mjs';

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => a.replace(/^--/, '').split('='))
);
const VERBOSE = 'verbose' in args;
const SAVE_KEY = 'decarloboyz.save.v2';
const LEGACY_KEY = 'threeboyz.save.v1';

/* ------------------------------------------------------------------ */
/* The state to round-trip. Hand-written, on purpose (rule 12).         */
/* ------------------------------------------------------------------ */
/**
 * A save mid-playthrough. Every value is one a real game could produce AND one
 * no default would produce by accident, so "the field survived" and "the field
 * was quietly reset" cannot be confused. `pos` is deliberately absent — the
 * probe measures the live player instead (see the header).
 */
const STAMP = {
  active: 'aidan',
  clock: 21.75,
  difficulty: 'hard',
  waypoint: { x: -120.5, z: 640.25 },
  packages: ['pk1', 'pk2', 'pk3', 'pk4', 'pk5'],
  stunts: ['sj_incline', 'sj_millramp'],
  totals: { cash: 41250, kills: 318, missions: 11, distance: 74210.5, crashes: 46, playtime: 9142 },
  chars: {
    carson: { chapter: 6, cash: 14320, respect: 412, deaths: 7, busts: 2 },
    aidan: { chapter: 4, cash: 3075, respect: 188, deaths: 1, busts: 0 },
    dylan: { chapter: 2, cash: 921, respect: 64, deaths: 3, busts: 1 },
  },
  wanted: 3,
};

const { port, server } = await startServer({ explicitPort: args.port });
const b = await chromium.launch({
  args: ['--use-angle=metal', '--ignore-gpu-blocklist', '--enable-gpu', '--mute-audio'],
});
const dir = await mkdtemp(join(tmpdir(), 'dossier-'));

const results = [];
const rec = (area, name, ok, detail) => results.push({ area, name, ok, detail });
const errs = [];
let page;
let ctxb;

const pump = (n) =>
  page.evaluate(
    (k) => new Promise((d) => {
      let i = 0;
      const t = () => (++i >= k ? d() : requestAnimationFrame(t));
      requestAnimationFrame(t);
    }),
    n
  );

async function boot(first = true) {
  if (first) {
    ctxb = await b.newContext({ viewport: { width: 1280, height: 900 }, acceptDownloads: true });
    page = await ctxb.newPage();
    page.on('pageerror', (e) => errs.push(String(e.message).slice(0, 200)));
    page.on('console', (m) => { if (m.type() === 'error') errs.push(m.text().slice(0, 200)); });
    // Every confirm() in this run is answered by an explicit handler installed
    // per case; the default keeps a stray dialog from hanging the probe.
    page.on('dialog', (d) => { dialogs.push(d.message()); d.accept().catch(() => {}); });
    await page.goto(`http://127.0.0.1:${port}/?boot=0`, { waitUntil: 'domcontentloaded', timeout: 90000 });
  }
  await page.waitForFunction('window.__READY__===true', null, { timeout: 180000 });
  await pump(80);
  await page.evaluate(() => {
    const e = window.__ENGINE__;
    e.input.enabled = true;
    e.input.frozen = false;
  });
  await pump(20);
}
const dialogs = [];

/* ------------------------------------------------------------------ */
/* Reading the REBUILT state — out of live consumers, not out of save. */
/* ------------------------------------------------------------------ */
/**
 * Every value here is read from something that would still hold a stale
 * pointer if `_adoptSave` had missed it: the sub-object's OWN `save`
 * reference, the player transform, the HUD record, the spawned pickups, the
 * sky's clock, `ui.state`. `game.save` itself is read only for the two global
 * ledgers, and those are cross-checked against the pickups actually in the
 * world on the line below.
 */
const live = () =>
  page.evaluate(() => {
    const e = window.__ENGINE__;
    const g = e.ctx.peek('game');
    const ui = e.ctx.peek('ui');
    const sky = e.ctx.peek('sky');
    const p = e.ctx.peek('player');
    const hud = g.getHudState();
    const ph = p?.getHudState?.();
    const pos = ph?.position ?? { x: NaN, y: NaN, z: NaN };
    return {
      // who
      character: g.character,
      boyChars: g.characters.boy?.id ?? null,
      boyFreeroam: g.freeroam.boy?.id ?? null,
      boyJobs: g.jobs.boy?.id ?? null,
      boyMissions: g.missions.boyId ?? null,
      // money / progress, off the HUD record `ui` polls every frame
      money: hud.money,
      respect: hud.respect,
      chapter: hud.chapter,
      economyCash: g.economy.cash,
      economyChapter: g.economy.char().chapter,
      // the other two brothers, through the economy's per-id accessor
      carsonChapter: g.economy.char('carson').chapter,
      carsonCash: g.economy.char('carson').cash,
      dylanChapter: g.economy.char('dylan').chapter,
      dylanCash: g.economy.char('dylan').cash,
      // the world
      wanted: g.heat.wanted,
      hour: Number.isFinite(sky?.hour) ? +sky.hour.toFixed(2)
        : Number.isFinite(sky?.timeOfDay) ? +sky.timeOfDay.toFixed(2) : null,
      directorHour: +g.director.hour.toFixed(2),
      // COLLECTIBLES AS EMITTED GEOMETRY: how many package pickups are really
      // standing in the city right now. A found package is one that is not.
      packagePickups: g.pickups.live.filter((x) => x.kind === 'package').length,
      packagesFound: g.save.packages.length,
      stunts: g.save.stunts.slice(),
      totals: { ...g.save.totals },
      // the map pin, read out of `ui` rather than out of the save
      uiWaypoint: ui?.state?.waypoint ? { x: ui.state.waypoint.x, z: ui.state.waypoint.z } : null,
      missionWaypoint: g.missions.userWaypoint
        ? { x: g.missions.userWaypoint.x, z: g.missions.userWaypoint.z } : null,
      // difficulty: the live COPY the mission runner scales with, not the field
      difficulty: g.difficulty,
      missionsDifficulty: g.missions.difficulty,
      pending: g._pendingChapter,
      // the player's actual transform in the world
      pos: { x: +pos.x.toFixed(2), y: +pos.y.toFixed(2), z: +pos.z.toFixed(2) },
      // every holder of the save object
      holders: {
        economy: g.economy.save === g.save,
        missions: g.missions.save === g.save,
        freeroam: g.freeroam.save === g.save,
        characters: g.characters.save === g.save,
        jobs: g.jobs.save === g.save,
      },
      storage: localStorage.getItem('decarloboyz.save.v2'),
      legacy: localStorage.getItem('threeboyz.save.v1'),
    };
  });

const dist2 = (a, c) => Math.hypot(a.x - c.x, a.z - c.z);

/**
 * Click a pause-menu button by the start of its label. Returns false when
 * there is no such button rather than throwing: "the control is missing" is
 * the FIRST defect this probe was written for, and a gate that dies on its own
 * headline case reports a stack trace instead of a score.
 */
const clickMenuBtn = (prefix) =>
  page.evaluate((p) => {
    const menu = window.__ENGINE__.ctx.peek('ui')?.menu;
    const btn = menu && [...menu.root.querySelectorAll('button')]
      .find((x) => x.textContent.trim().toLowerCase().startsWith(p));
    if (!btn) return false;
    btn.click();
    return true;
  }, prefix);

/** Hand a real file to the menu's real picker. False when there is no picker. */
async function pickFile(path) {
  const has = await page.evaluate(() =>
    !!window.__ENGINE__.ctx.peek('ui')?.menu?.root.querySelector('input[type=file]'));
  if (!has) return false;
  await page.setInputFiles('.ow-menu input[type=file]', path);
  return true;
}

/** Open the pause menu through the real key, and wait for it to be up. */
async function openMenu() {
  const up = await page.evaluate(() => !!window.__ENGINE__.ctx.peek('ui')?.menu?.open);
  if (!up) {
    await page.keyboard.press('Escape');
    await pump(24);
  }
  return page.evaluate(() => !!window.__ENGINE__.ctx.peek('ui')?.menu?.open);
}

async function closeMenu() {
  const up = await page.evaluate(() => !!window.__ENGINE__.ctx.peek('ui')?.menu?.open);
  if (up) {
    await page.keyboard.press('Escape');
    await pump(24);
  }
}

/**
 * Every live row in `ui`'s notification feed. Not "the newest": an import
 * re-announces the imported brother's next chapter in the same frame, and the
 * feed carries five rows at once with no push order recorded — so the question
 * a probe can honestly ask is whether the message is ON SCREEN, not whether it
 * is on top.
 */
const toasts = () =>
  page.evaluate(() => {
    const feed = window.__ENGINE__.ctx.peek('ui')?.feed;
    return (feed?.items ?? []).filter((x) => x.alive)
      .map((x) => `${x.txt.textContent} ${x.val.textContent}`.trim().slice(0, 80));
  });

/* ======================================================================== */
/* 1 — the controls exist and a player can reach them                       */
/* ======================================================================== */
async function caseReachable() {
  const A = '1 reachable';

  const api = await page.evaluate(() => {
    const g = window.__ENGINE__.ctx.peek('game');
    return {
      exportDossier: typeof g?.exportDossier,
      importDossier: typeof g?.importDossier,
      wipeSave: typeof g?.wipeSave,
    };
  });
  rec(A, 'game publishes export / import / wipe',
    api.exportDossier === 'function' && api.importDossier === 'function' && api.wipeSave === 'function',
    `exportDossier ${api.exportDossier}, importDossier ${api.importDossier}, wipeSave ${api.wipeSave}`);

  const opened = await openMenu();
  rec(A, 'the pause menu opens on ESC', opened === true, `menu.open ${opened}`);

  // Composited visibility and hit size, not just presence in the DOM: a button
  // behind a modal or 8 px tall is not reachable.
  const ctrls = await page.evaluate(() => {
    const menu = window.__ENGINE__.ctx.peek('ui')?.menu;
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
    const want = ['export', 'import', 'erase'];
    const out = {};
    for (const w of want) {
      const btn = [...menu.root.querySelectorAll('button')]
        .find((x) => x.textContent.trim().toLowerCase().startsWith(w));
      const r = btn?.getBoundingClientRect();
      out[w] = btn ? { text: btn.textContent.trim(), a: vis(btn), w: Math.round(r.width), h: Math.round(r.height) } : null;
    }
    const f = menu.root.querySelector('input[type=file]');
    out.file = f ? { accept: f.accept, connected: f.isConnected } : null;
    return out;
  });
  const ok3 = ctrls && ['export', 'import', 'erase'].every(
    (k) => ctrls[k] && ctrls[k].a > 0.5 && ctrls[k].w >= 44 && ctrls[k].h >= 44
  );
  rec(A, 'export / import / erase are on the pause menu, visible and finger-sized',
    ok3,
    ['export', 'import', 'erase'].map((k) => (ctrls?.[k]
      ? `${ctrls[k].text} ${ctrls[k].w}x${ctrls[k].h} @${ctrls[k].a}` : `${k.toUpperCase()} MISSING`)).join(' · '));

  rec(A, 'and there is a real file picker behind Import',
    !!ctrls?.file?.connected && String(ctrls.file.accept).includes('json'),
    ctrls?.file ? `accept "${ctrls.file.accept}"` : 'NO input[type=file] IN THE MENU');
}

/* ======================================================================== */
/* 2 — stamp a state, export it through the button, get a real file          */
/* ======================================================================== */
let filePath = '';
let before = null;

async function caseExport() {
  const A = '2 export';

  // Put the player somewhere real first, and let `capture()` be the thing that
  // records it. The spot comes from the world, so it is standable by
  // construction — `director.spawnFor` keeps a saved position only if it is.
  await closeMenu();
  await page.evaluate((S) => {
    const g = window.__ENGINE__.ctx.peek('game');
    const spot = g.wq.findGroundSpot(40, 90, 0, 0);
    g.wq.placePlayer(spot.x, spot.z, 1.234, spot.y ?? null);
    const s = g.save;
    s.active = S.active;
    s.clock = S.clock;
    s.difficulty = S.difficulty;
    s.waypoint = { x: S.waypoint.x, z: S.waypoint.z };
    s.packages = S.packages.slice();
    s.stunts = S.stunts.slice();
    Object.assign(s.totals, S.totals);
    for (const [id, c] of Object.entries(S.chars)) Object.assign(s.chars[id], c);
    // Make the live world agree with the stamp rather than only the record, so
    // the player really is the stamped brother standing where he stands with
    // the stamped heat on him. This is SETUP, not an assertion — `before`
    // below measures what actually resulted and refuses to proceed if the
    // stamp did not take.
    if (typeof g._adoptSave === 'function') g._adoptSave(s, S.active);
    else g.characters.restore(S.active);
    g.wq.placePlayer(spot.x, spot.z, 1.234, spot.y ?? null);
    g.heat.clear('probe');
    g.heat.raise(S.wanted, spot.x, spot.z);
  }, STAMP);
  await pump(30);

  before = await live();
  rec(A, 'the stamped state is live before the export',
    before.character === STAMP.active && before.money === STAMP.chars.aidan.cash &&
    before.wanted === STAMP.wanted && before.packagesFound === STAMP.packages.length,
    `${before.character}, ${before.money}, wanted ${before.wanted}, ` +
    `${before.packagesFound} packages found, at ${before.pos.x}/${before.pos.z}`);

  await openMenu();
  const dl = page.waitForEvent('download', { timeout: 20000 });
  const pressed = await clickMenuBtn('export');
  let download = null;
  try {
    download = pressed ? await dl : null;
  } catch {
    download = null;
  }
  rec(A, 'clicking Export makes the browser download a file',
    !!download,
    !pressed ? 'THERE IS NO EXPORT BUTTON TO CLICK'
      : download ? `suggested "${download.suggestedFilename()}"` : 'NO DOWNLOAD FIRED');
  if (!download) return false;

  filePath = join(dir, 'dossier.json');
  await download.saveAs(filePath);
  const bytes = await readFile(filePath, 'utf8');
  let parsed = null;
  try { parsed = JSON.parse(bytes); } catch { parsed = null; }

  rec(A, 'the downloaded file is dated JSON that names itself a dossier',
    /^decarlo-boyz-dossier-\d{4}-\d{2}-\d{2}\.json$/.test(download.suggestedFilename()) &&
    parsed?.kind === 'decarloboyz.dossier' && Number.isFinite(parsed?.exportedAt) &&
    bytes.includes('\n'),
    `${download.suggestedFilename()}, ${bytes.length} bytes, kind ${parsed?.kind}`);

  // The bytes must carry the LIVE state, including the position `capture()` had
  // to go and fetch — not the last autosave. Position is compared against the
  // measurement this probe took, never against what `game` says it saved.
  const fpos = parsed?.chars?.[STAMP.active]?.pos ?? null;
  rec(A, 'the bytes carry the state that was on screen, position and all',
    parsed?.active === STAMP.active &&
    parsed?.chars?.carson?.chapter === STAMP.chars.carson.chapter &&
    parsed?.chars?.dylan?.cash === STAMP.chars.dylan.cash &&
    parsed?.stunts?.length === STAMP.stunts.length &&
    parsed?.difficulty === STAMP.difficulty &&
    Array.isArray(fpos) && dist2({ x: fpos[0], z: fpos[2] }, before.pos) < 0.5 &&
    parsed?.chars?.[STAMP.active]?.wanted === STAMP.wanted,
    `active ${parsed?.active}, carson ch${parsed?.chars?.carson?.chapter}, ` +
    `${parsed?.difficulty}, pos ${fpos?.map?.((v) => v.toFixed(1)).join('/')} vs measured ` +
    `${before.pos.x}/${before.pos.z}, wanted ${parsed?.chars?.[STAMP.active]?.wanted}`);
  return true;
}

/* ======================================================================== */
/* 3 — erase all progress, and CHECK IT REALLY IS GONE                       */
/* ======================================================================== */
/* This is also the precondition for case 4: after it, none of the quantities  */
/* the import has to restore is still sitting at its stamped value.           */
async function caseWipe() {
  const A = '3 erase all';

  // CONTROL FIRST: a confirm that is DISMISSED must erase nothing.
  await openMenu();
  dialogs.length = 0;
  page.removeAllListeners('dialog');
  page.on('dialog', (d) => { dialogs.push(d.message()); d.dismiss().catch(() => {}); });
  const asked = await clickMenuBtn('erase');
  await pump(20);
  const kept = await live();
  rec(A, 'saying no to the confirmation erases nothing',
    asked && dialogs.length === 1 && /erase all progress/i.test(dialogs[0]) &&
    kept.character === STAMP.active && kept.money === STAMP.chars.aidan.cash &&
    kept.packagesFound === STAMP.packages.length,
    `${asked ? '' : 'NO ERASE BUTTON · '}asked "${(dialogs[0] ?? 'NOTHING').slice(0, 46)}…" · ` +
    `still ${kept.character} with ${kept.money} and ${kept.packagesFound} packages`);

  // And now yes.
  dialogs.length = 0;
  page.removeAllListeners('dialog');
  page.on('dialog', (d) => { dialogs.push(d.message()); d.accept().catch(() => {}); });
  await clickMenuBtn('erase');
  // Measure with the world RUNNING: the pause menu holds `time.scale` at 0,
  // and a frozen clock is a frozen player transform.
  await closeMenu();
  await pump(40);
  const w = await live();

  rec(A, 'erase-all leaves no brother with any progress',
    w.carsonChapter === 0 && w.dylanChapter === 0 && w.economyChapter === 0 &&
    w.chapter === 0 && w.totals.kills === 0 && w.totals.missions === 0,
    `carson ch${w.carsonChapter}, dylan ch${w.dylanChapter}, active ch${w.chapter}, ` +
    `${w.totals.kills} kills, ${w.totals.missions} missions`);

  rec(A, 'and puts the collectibles back in the city',
    w.packagesFound === 0 && w.stunts.length === 0 && w.packagePickups === 12,
    `${w.packagesFound} found, ${w.stunts.length} stunts, ${w.packagePickups} package pickups standing`);

  rec(A, 'both storage keys are gone, not just the current one',
    w.storage === null && w.legacy === null,
    `v2 ${w.storage === null ? 'gone' : 'PRESENT (' + String(w.storage).length + ' bytes)'}, ` +
    `v1 ${w.legacy === null ? 'gone' : 'PRESENT'}`);

  rec(A, 'the wipe is the precondition for the import test: nothing is stamped any more',
    w.character !== STAMP.active && w.money !== STAMP.chars.aidan.cash &&
    w.wanted !== STAMP.wanted && w.difficulty !== STAMP.difficulty &&
    w.uiWaypoint === null && dist2(w.pos, before.pos) > 5,
    `${w.character} · ${w.money} · wanted ${w.wanted} · ${w.difficulty} · ` +
    `pin ${JSON.stringify(w.uiWaypoint)} · ${dist2(w.pos, before.pos).toFixed(1)} m away`);
  return w;
}

/* ======================================================================== */
/* 4 — feed the file back through the real picker                            */
/* ======================================================================== */
async function caseImport() {
  const A = '4 import';
  await openMenu();
  const picked = await pickFile(filePath);
  await pump(30);
  const feed = await toasts();
  // The picker must be re-armed BEFORE anything else touches the menu.
  const cleared = await page.evaluate(() =>
    window.__ENGINE__.ctx.peek('ui')?.menu?.root.querySelector('input[type=file]')?.value ?? 'NO PICKER');
  void picked;
  await closeMenu();
  await pump(40);
  const a = await live();

  rec(A, 'the click reports back to the player',
    feed.some((t) => /dossier imported/i.test(t)), `feed ${JSON.stringify(feed)}`);

  rec(A, 'the brother comes back, in every sub-object that holds one',
    a.character === STAMP.active && a.boyChars === STAMP.active &&
    a.boyFreeroam === STAMP.active && a.boyJobs === STAMP.active && a.boyMissions === STAMP.active,
    `character ${a.character}, characters ${a.boyChars}, freeroam ${a.boyFreeroam}, ` +
    `jobs ${a.boyJobs}, missions ${a.boyMissions}`);

  rec(A, "every holder of the save object points at the imported one",
    Object.values(a.holders).every(Boolean),
    Object.entries(a.holders).map(([k, v]) => `${k} ${v}`).join(' · '));

  rec(A, 'money and chapter come back for ALL THREE brothers, not just the active one',
    a.money === STAMP.chars.aidan.cash && a.economyCash === STAMP.chars.aidan.cash &&
    a.chapter === STAMP.chars.aidan.chapter &&
    a.carsonChapter === STAMP.chars.carson.chapter && a.carsonCash === STAMP.chars.carson.cash &&
    a.dylanChapter === STAMP.chars.dylan.chapter && a.dylanCash === STAMP.chars.dylan.cash,
    `aidan ${a.money}/ch${a.chapter}, carson ${a.carsonCash}/ch${a.carsonChapter}, ` +
    `dylan ${a.dylanCash}/ch${a.dylanChapter}`);

  rec(A, 'the player is standing where he was when the file was written',
    dist2(a.pos, before.pos) < 0.5,
    `${a.pos.x}/${a.pos.z} vs measured ${before.pos.x}/${before.pos.z} — ` +
    `${dist2(a.pos, before.pos).toFixed(2)} m`);

  rec(A, 'the heat he had is back on him',
    a.wanted === STAMP.wanted, `wanted ${a.wanted}`);

  rec(A, 'the collectibles he had already found stay found',
    a.packagesFound === STAMP.packages.length &&
    a.stunts.join() === STAMP.stunts.join() &&
    a.packagePickups === 12 - STAMP.packages.length,
    `${a.packagesFound} found, ${a.packagePickups} still standing in the city, ` +
    `stunts ${JSON.stringify(a.stunts)}`);

  rec(A, 'the running totals come back',
    a.totals.kills === STAMP.totals.kills && a.totals.missions === STAMP.totals.missions &&
    a.totals.crashes === STAMP.totals.crashes,
    `${a.totals.kills} kills, ${a.totals.missions} missions, ${a.totals.crashes} crashes`);

  rec(A, 'the map pin is back on the map, not just in the record',
    !!a.uiWaypoint && Math.abs(a.uiWaypoint.x - STAMP.waypoint.x) < 0.01 &&
    Math.abs(a.uiWaypoint.z - STAMP.waypoint.z) < 0.01 &&
    !!a.missionWaypoint && Math.abs(a.missionWaypoint.x - STAMP.waypoint.x) < 0.01,
    `ui ${JSON.stringify(a.uiWaypoint)}, missions ${JSON.stringify(a.missionWaypoint)}`);

  rec(A, 'the difficulty reaches the mission runner, not just the save field',
    a.difficulty === STAMP.difficulty && a.missionsDifficulty === STAMP.difficulty,
    `save "${a.difficulty}", missions "${a.missionsDifficulty}"`);

  rec(A, 'the world clock is set to the hour in the file',
    Math.abs((a.hour ?? -99) - STAMP.clock) < 0.35 && Math.abs(a.directorHour - STAMP.clock) < 0.35,
    `sky ${a.hour}, director ${a.directorHour}, file ${STAMP.clock}`);

  rec(A, 'J will start the chapter the file is up to, not the one before the import',
    a.pending === STAMP.chars.aidan.chapter,
    `_pendingChapter ${a.pending}, imported frontier ${STAMP.chars.aidan.chapter}`);

  rec(A, 'the import is on disk before the click returns',
    !!a.storage && JSON.parse(a.storage).active === STAMP.active &&
    JSON.parse(a.storage).chars.carson.chapter === STAMP.chars.carson.chapter,
    a.storage ? `active ${JSON.parse(a.storage).active}, carson ch${JSON.parse(a.storage).chars.carson.chapter}`
      : 'NOTHING WRITTEN');

  // The picker must be re-armed. `change` does not fire for the same path
  // twice, so a value left in place makes a second attempt silently do nothing.
  rec(A, 'the picker is cleared, so the same file can be picked again',
    cleared === '', `input.value "${cleared}"`);
  return a;
}

/* ======================================================================== */
/* 5 — a wrong file is refused and costs nothing                             */
/* ======================================================================== */
async function caseJunk(good) {
  const A = '5 bad files';
  const junkPath = join(dir, 'holiday-photos.json');
  await writeFile(junkPath, '{"holiday":"wildwood","photos":[1,2,3]}');
  const notJson = join(dir, 'notes.json');
  await writeFile(notJson, 'this is not a save {{{');

  for (const [name, p] of [['JSON that is not a save', junkPath], ['a file that is not JSON', notJson]]) {
    await openMenu();
    await pickFile(p);
    await pump(30);
    const feed = await toasts();
    const said = feed.find((t) => /decarlo boyz save|not json|could not read/i.test(t)) ?? '';
    await closeMenu();
    await pump(20);
    const a = await live();
    rec(A, `${name} is refused with a reason, and the run survives it`,
      a.character === good.character && a.money === good.money &&
      a.carsonChapter === good.carsonChapter && a.storage === good.storage && !!said,
      `still ${a.character} with ${a.money} and carson ch${a.carsonChapter}; ` +
      `storage ${a.storage === good.storage ? 'byte-identical' : 'CHANGED'}; said "${said}"`);
  }
}

/* ======================================================================== */
/* 6 — it survives a real page navigation                                    */
/* ======================================================================== */
async function caseReload(good) {
  const A = '6 next session';
  await closeMenu();
  await page.reload({ waitUntil: 'domcontentloaded', timeout: 90000 });
  await boot(false);
  const a = await live();
  rec(A, 'the imported dossier is what the next session boots holding',
    a.character === STAMP.active && a.economyCash === STAMP.chars.aidan.cash &&
    a.carsonChapter === STAMP.chars.carson.chapter &&
    a.packagesFound === STAMP.packages.length && a.stunts.length === STAMP.stunts.length &&
    a.totals.kills === STAMP.totals.kills,
    `${a.character}, ${a.economyCash}, carson ch${a.carsonChapter}, ` +
    `${a.packagesFound} packages, ${a.totals.kills} kills`);
  void good;

  // And the erase is permanent across the same boundary.
  await page.evaluate(() => window.__ENGINE__.ctx.peek('game').wipeSave());
  await pump(20);
  await page.reload({ waitUntil: 'domcontentloaded', timeout: 90000 });
  await boot(false);
  const z = await live();
  rec(A, 'and an erase stays erased across a reload',
    z.carsonChapter === 0 && z.economyChapter === 0 && z.packagesFound === 0 &&
    z.totals.kills === 0,
    `carson ch${z.carsonChapter}, ${z.packagesFound} packages, ${z.totals.kills} kills`);
}

/* ======================================================================== */

let code = 0;
try {
  await boot(true);
  // A legacy save sitting next to the v2 one is not hypothetical: `load()`
  // reads it whenever the v2 slot is empty, which is exactly the state a wipe
  // creates. Plant one so "erase all" has both keys to prove itself against.
  await page.evaluate((k) => localStorage.setItem(k, JSON.stringify({
    version: 1,
    chars: { carson: { chapter: 5, cash: 8000, respect: 300, unlocked: ['flare'], deaths: 4 } },
    packages: ['pk1', 'pk2'],
    totals: { kills: 100, missions: 6 },
  })), LEGACY_KEY);

  await caseReachable();
  const exported = await caseExport();
  if (exported) {
    await caseWipe();
    const good = await caseImport();
    await caseJunk(good);
    await caseReload(good);
  }
  rec('0 boot', 'the page booted and ran without a script error', errs.length === 0,
    errs.length ? errs.slice(0, 3).join(' | ') : 'clean');

  let area = '';
  let failed = 0;
  for (const r of results.sort((a, x) => a.area.localeCompare(x.area))) {
    if (r.area !== area) {
      area = r.area;
      console.log(`\n=== ${area} ===`);
    }
    if (!r.ok) failed++;
    console.log(`  ${r.ok ? 'ok  ' : 'FAIL'} ${r.name}`);
    if (!r.ok || VERBOSE) console.log(`       ${r.detail}`);
  }
  console.log(`\ndossier: ${results.length - failed}/${results.length}`);
  code = failed ? 1 : 0;
} catch (err) {
  console.error('probe threw:', err);
  code = 2;
} finally {
  await b.close();
  server?.kill();
}
process.exit(code);
void SAVE_KEY;
