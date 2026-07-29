/**
 * GAME — persistence.
 *
 * localStorage, schema v2. Schema v1 (`threeboyz.save.v1`) had the right
 * shape and is followed here: a per-character record plus a small pile of
 * globals. What v2 adds is everything v1 could not persist because it had no
 * notion of the player being *somewhere* when you quit — position, vehicle,
 * wanted state and the free-roam activity ledger.
 *
 *   {
 *     version: 2,
 *     createdAt, savedAt,
 *     active: 'carson' | 'aidan' | 'dylan',
 *     chars: {
 *       carson: {
 *         chapter: 0..8,          // next chapter index; 8 == arc complete
 *         cash, respect, deaths, busts,
 *         unlocked: ['flare', ...],   // weapons earned
 *         ammo: { nailgun: 90, ... },
 *         hp, armor,
 *         pos: [x, y, z], yaw,     // where he is standing in the city
 *         safehouse: 'sh_carson',  // last bed slept in — the respawn point
 *         wanted: 0..5,
 *         best: { 'ch3': 71.2 }    // best mission times, by chapter key
 *       }, ...
 *     },
 *     packages: ['pk1', ...],       // global — a package is found once
 *     stunts: ['sj_incline', ...],  // global — a stunt jump is landed once
 *     races: { triangle: 168.4 },   // best standalone circuit times
 *     unlocks: ['sh_dt'],           // respect-gated, global
 *     totals: { cash, kills, missions, distance, crashes, playtime },
 *     clock: 8.5,                   // hour of day at save
 *     waypoint: { x, z } | null,
 *     difficulty: 'easy'|'normal'|'hard'|'steel',
 *     radio: 'wdve' | null          // chosen station; null == never touched.
 *                                   // `freeroam` mirrors the `ui:station` event
 *                                   // into this field and re-emits it on load.
 *   }
 *
 * Every read is defensive. A save written by an older build, hand-edited, or
 * truncated by a full disk must never take the boot down — `load()` merges
 * whatever it can salvage onto a blank save and returns that.
 *
 * ---------------------------------------------------------------------------
 * THE DOSSIER — export / import / wipe
 * ---------------------------------------------------------------------------
 * Progress can be handed out as a file and taken back again. `exportSave` /
 * `serialiseSave` / `importSave` / `wipeAll` below are the SAVE-LAYER half of
 * that: object in, text out, text in, object back. They touch no DOM — the
 * Blob, the anchor click and the `<input type=file>` belong to
 * `src/ui/menu.js`.
 *
 * Two properties that are easy to get wrong, and are deliberate here:
 *
 *  - An import must NOT assign `clean.chars = p.chars` wholesale. That makes
 *    whatever is in the file live game state — a hand-edited chapter of 99, a
 *    `cash` of `"lots"`, a fourth brother. `importSave` runs the same
 *    `normalise()` every boot already runs, so an imported file cannot express
 *    a state a save file cannot express.
 *  - A wipe must not erase `SAVE_KEY` only. There is a SECOND key: `load()`
 *    falls back to `threeboyz.save.v1`, so "Erase all progress for all three
 *    brothers" followed by a reload would hand the v1 save straight back.
 *    `wipeAll()` clears both.
 */

import { BOY_ORDER, START_CASH } from './data.js';

export const SAVE_KEY = 'decarloboyz.save.v2';
export const SAVE_VERSION = 2;

/** Legacy key, read once on first boot so an old save is not silently lost. */
const LEGACY_KEY = 'threeboyz.save.v1';

export function blankChar(id) {
  return {
    id,
    chapter: 0,
    cash: START_CASH,
    respect: 0,
    deaths: 0,
    busts: 0,
    unlocked: [],
    ammo: {},
    hp: -1, // -1 == "full", resolved against the brother's build on load
    armor: -1,
    pos: null,
    yaw: 0,
    safehouse: null,
    wanted: 0,
    best: {},
  };
}

export function blankSave() {
  const chars = {};
  for (const id of BOY_ORDER) chars[id] = blankChar(id);
  return {
    version: SAVE_VERSION,
    createdAt: Date.now(),
    savedAt: 0,
    active: BOY_ORDER[0],
    chars,
    // Two global "done once" ledgers. Same shape on purpose: an id goes in the
    // first time it is earned and `ids()` refuses to let it in twice. Without
    // `stunts` here, a stunt jump could never be remembered across a session.
    packages: [],
    stunts: [],
    races: {},
    unlocks: [],
    totals: { cash: 0, kills: 0, missions: 0, distance: 0, crashes: 0, playtime: 0 },
    clock: 8.5,
    waypoint: null,
    difficulty: 'normal',
    radio: null,
  };
}

function storage() {
  try {
    // Private-mode Safari throws on the *setter*, not on the getter, so probe.
    const ls = globalThis.localStorage;
    if (!ls) return null;
    ls.setItem('__ow_probe__', '1');
    ls.removeItem('__ow_probe__');
    return ls;
  } catch {
    return null;
  }
}

const num = (v, d) => (Number.isFinite(v) ? v : d);
const str = (v, d) => (typeof v === 'string' ? v : d);

/**
 * A "collected once" ledger: string ids, no blanks, no repeats, order kept.
 *
 * `packages`, `stunts` and `unlocks` are all sets pretending to be arrays —
 * every consumer asks `.includes(id)` and every producer guards the push. A
 * hand-edited or double-written file that lists the same package twice would
 * otherwise read `13 / 12 packages` on the HUD and hand out the all-packages
 * weapon a collectible early.
 */
const ids = (v) => {
  const out = [];
  if (!Array.isArray(v)) return out;
  for (const x of v) if (typeof x === 'string' && x && !out.includes(x)) out.push(x);
  return out;
};

/** Merge an untrusted parsed object onto a blank save. Never throws. */
export function normalise(raw) {
  const s = blankSave();
  if (!raw || typeof raw !== 'object') return s;

  s.createdAt = num(raw.createdAt, s.createdAt);
  s.savedAt = num(raw.savedAt, 0);
  s.active = BOY_ORDER.includes(raw.active) ? raw.active : BOY_ORDER[0];
  s.packages = ids(raw.packages);
  s.stunts = ids(raw.stunts);
  s.unlocks = ids(raw.unlocks);
  s.clock = Math.max(0, Math.min(24, num(raw.clock, 8.5)));
  if (['easy', 'normal', 'hard', 'steel'].includes(raw.difficulty)) s.difficulty = raw.difficulty;
  // Station ids are strings today; a number survives too in case `ui` ever
  // goes back to indices. Anything else stays null (= radio never touched).
  if (typeof raw.radio === 'string' || Number.isFinite(raw.radio)) s.radio = raw.radio;

  if (raw.races && typeof raw.races === 'object') {
    for (const [k, v] of Object.entries(raw.races)) if (Number.isFinite(v)) s.races[k] = v;
  }
  if (raw.totals && typeof raw.totals === 'object') {
    for (const k of Object.keys(s.totals)) s.totals[k] = Math.max(0, num(raw.totals[k], 0));
  }
  if (raw.waypoint && Number.isFinite(raw.waypoint.x) && Number.isFinite(raw.waypoint.z)) {
    s.waypoint = { x: raw.waypoint.x, z: raw.waypoint.z };
  }

  const rc = raw.chars && typeof raw.chars === 'object' ? raw.chars : {};
  for (const id of BOY_ORDER) {
    const c = s.chars[id];
    const r = rc[id];
    if (!r || typeof r !== 'object') continue;
    c.chapter = Math.max(0, Math.min(8, Math.floor(num(r.chapter, 0))));
    c.cash = Math.max(0, Math.floor(num(r.cash, START_CASH)));
    c.respect = Math.max(0, Math.floor(num(r.respect, 0)));
    c.deaths = Math.max(0, Math.floor(num(r.deaths, 0)));
    c.busts = Math.max(0, Math.floor(num(r.busts, 0)));
    c.unlocked = ids(r.unlocked);
    c.hp = num(r.hp, -1);
    c.armor = num(r.armor, -1);
    c.yaw = num(r.yaw, 0);
    c.safehouse = str(r.safehouse, null);
    c.wanted = Math.max(0, Math.min(5, Math.floor(num(r.wanted, 0))));
    if (Array.isArray(r.pos) && r.pos.length === 3 && r.pos.every(Number.isFinite)) {
      c.pos = [r.pos[0], r.pos[1], r.pos[2]];
    }
    if (r.ammo && typeof r.ammo === 'object') {
      for (const [k, v] of Object.entries(r.ammo)) if (Number.isFinite(v)) c.ammo[k] = Math.max(0, Math.floor(v));
    }
    if (r.best && typeof r.best === 'object') {
      for (const [k, v] of Object.entries(r.best)) if (Number.isFinite(v)) c.best[k] = v;
    }
  }
  return s;
}

/** Pull the legacy `threeboyz.save.v1` record forward, once. */
function importLegacy(ls) {
  let raw;
  try {
    raw = JSON.parse(ls.getItem(LEGACY_KEY) ?? 'null');
  } catch {
    return null;
  }
  if (!raw || !raw.chars) return null;
  const s = blankSave();
  s.packages = ids(raw.packages);
  s.stunts = ids(raw.stunts);
  if (raw.totals) for (const k of Object.keys(s.totals)) s.totals[k] = Math.max(0, num(raw.totals[k], 0));
  for (const id of BOY_ORDER) {
    const r = raw.chars[id];
    if (!r) continue;
    const c = s.chars[id];
    c.chapter = Math.max(0, Math.min(8, Math.floor(num(r.chapter, 0))));
    c.cash = Math.max(0, Math.floor(num(r.cash, START_CASH)));
    c.respect = Math.max(0, Math.floor(num(r.respect, 0)));
    c.deaths = Math.max(0, Math.floor(num(r.deaths, 0)));
    c.unlocked = ids(r.unlocked);
  }
  return s;
}

export function load() {
  const ls = storage();
  if (!ls) return { save: blankSave(), source: 'none' };
  let raw = null;
  try {
    raw = JSON.parse(ls.getItem(SAVE_KEY) ?? 'null');
  } catch {
    raw = null;
  }
  if (raw) return { save: normalise(raw), source: 'v2' };
  const legacy = importLegacy(ls);
  if (legacy) return { save: legacy, source: 'legacy' };
  return { save: blankSave(), source: 'new' };
}

export function write(save) {
  const ls = storage();
  if (!ls) return false;
  save.savedAt = Date.now();
  save.version = SAVE_VERSION;
  try {
    ls.setItem(SAVE_KEY, JSON.stringify(save));
    return true;
  } catch {
    return false;
  }
}

/**
 * ERASE ALL PROGRESS FOR ALL THREE BROTHERS.
 *
 * Every key `load()` can read, not just the current one. `load()` falls through
 * to `threeboyz.save.v1` when the v2 slot is empty, so clearing v2 alone means
 * the next boot resurrects the v1 save and the player is told his erased
 * progress is back. Measured: wipe, reload, `source: 'legacy'`, chapters
 * intact.
 *
 * Returns false only when storage itself is unreachable (private-mode Safari),
 * never when a key simply was not there.
 */
export function wipeAll() {
  const ls = storage();
  if (!ls) return false;
  let ok = true;
  for (const k of [SAVE_KEY, LEGACY_KEY]) {
    try {
      ls.removeItem(k);
    } catch {
      ok = false;
    }
  }
  return ok;
}

/** @deprecated name kept for callers; erases every readable key. See `wipeAll`. */
export function wipe() {
  return wipeAll();
}

/* ======================================================================== */
/* the dossier — export / import                                            */
/* ======================================================================== */

/** Stamped into an exported file so an import can tell what it is holding. */
export const DOSSIER_KIND = 'decarloboyz.dossier';

/**
 * The object an exported file contains: the normalised save plus two lines of
 * provenance. Normalised on the way OUT as well as on the way in, so a file
 * cannot carry a shape the game would refuse to load — the export is a
 * dossier of the state, not a memory dump.
 */
export function exportSave(save) {
  const s = normalise(save);
  s.kind = DOSSIER_KIND;
  s.exportedAt = Date.now();
  return s;
}

/** What gets written to disk. Indented: a dossier is meant to be readable. */
export function serialiseSave(save) {
  return JSON.stringify(exportSave(save), null, 2);
}

/** `decarlo-boyz-dossier-2026-07-28.json`. */
export function exportFilename(when = Date.now()) {
  return `decarlo-boyz-dossier-${new Date(when).toISOString().slice(0, 10)}.json`;
}

/**
 * Read a dossier back and rebuild every brother from it.
 *
 * Accepts the text of a file, an already-parsed object, or a `{ save: {...} }`
 * wrapper, so a straight copy of the `localStorage` value works as well as an
 * exported file. Everything then goes through the SAME `normalise()` the boot
 * path runs, which is the point: an import cannot produce a state a save file
 * could not, and a truncated or hand-edited file degrades instead of poisoning
 * the game.
 *
 * @returns {{ok:boolean, save:object|null, stored:boolean, error:string}}
 *   `ok:false` leaves storage completely untouched — a rejected import must
 *   never be able to cost you the save you already had.
 */
export function importSave(input, { persist = true } = {}) {
  let raw = input;
  if (typeof raw === 'string') {
    try {
      raw = JSON.parse(raw);
    } catch {
      return { ok: false, save: null, stored: false, error: 'That file is not JSON' };
    }
  }
  if (raw && typeof raw === 'object' && !Array.isArray(raw) && raw.save && typeof raw.save === 'object') {
    raw = raw.save;
  }
  // Shape test: an object, not an array, with a `chars` map. It is the one
  // thing that distinguishes a save from any other JSON a player might pick
  // out of their downloads folder.
  if (!raw || typeof raw !== 'object' || Array.isArray(raw) || !raw.chars || typeof raw.chars !== 'object') {
    return { ok: false, save: null, stored: false, error: "That file isn't a Decarlo Boyz save" };
  }
  const save = normalise(raw);
  // Import is an explicit act, so it is persisted NOW rather than left to the
  // debounced autosave.
  const stored = persist ? write(save) : false;
  return { ok: true, save, stored, error: '' };
}

/**
 * Debounced writer. Saving happens on real events (mission end, safehouse,
 * purchase, package) and those can arrive several to a frame, so coalesce.
 * Uses the engine clock rather than setTimeout so a headless harness that
 * pumps frames by hand still gets a flush.
 */
export class SaveWriter {
  constructor(delay = 0.6) {
    this.delay = delay;
    this.pending = 0;
    this.dirty = false;
    this.writes = 0;
  }

  touch() {
    this.dirty = true;
    this.pending = this.delay;
  }

  /** Force a write on the next tick regardless of the debounce. */
  now(save) {
    this.dirty = false;
    this.pending = 0;
    if (write(save)) this.writes++;
    return this.writes;
  }

  update(dt, save) {
    if (!this.dirty) return;
    this.pending -= dt;
    if (this.pending > 0) return;
    this.now(save);
  }
}
