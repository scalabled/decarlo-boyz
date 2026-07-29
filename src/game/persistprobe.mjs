#!/usr/bin/env node
/**
 * PERSISTENCE PROBE — does a dossier survive the round trip, and does "erase
 * everything" actually erase everything?
 *
 *   node src/game/persistprobe.mjs
 *   node src/game/persistprobe.mjs --verbose
 *
 * ---------------------------------------------------------------------------
 * WHAT WAS BROKEN
 * ---------------------------------------------------------------------------
 *  1. `exportSave` / `importSave` did not exist. Grepping `src/` for either
 *     name returned nothing, though the pause menu offers them.
 *  2. `wipe()` removed `decarloboyz.save.v2` and left `threeboyz.save.v1`
 *     sitting next to it — and `load()` falls back to exactly that key. "Erase
 *     all progress for all three brothers", then reload, and the v1 save came
 *     straight back.
 *  3. `SAVE.stunts` was in neither the blank save nor `normalise`, so a stunt
 *     jump could not be remembered for one reload.
 *
 * ---------------------------------------------------------------------------
 * RULE 12 — WHAT THIS MEASURES
 * ---------------------------------------------------------------------------
 * The expected state is a HAND-WRITTEN literal (`DOSSIER` below). It is not
 * produced by `blankSave()`, `normalise()` or any other function in the file
 * under test, so "it round-trips" cannot degenerate into "the code agrees with
 * itself". Every assertion is against an emitted artefact:
 *
 *   - the round trip is asserted on the OBJECT THAT COMES BACK OUT, compared
 *     leaf by leaf against that literal (`diff()` walks both, so a field the
 *     importer silently drops is a named failure rather than a missing check);
 *   - the file is asserted by `JSON.parse`ing the exported TEXT — the bytes a
 *     player's file would contain — not by reading the object we handed in;
 *   - the wipe is asserted by what `load()` reports on the next boot, which is
 *     the thing the player experiences, not by whether `removeItem` was called;
 *   - a REJECTED import is asserted by the storage string being byte-identical
 *     afterwards, because the failure mode that matters is a bad file costing
 *     you the save you already had.
 *
 * `START_CASH`, `BOY_ORDER` and the clamp limits are deliberately never
 * asserted against their own constants — the defaults are checked for the
 * PROPERTY that broke (finite, non-negative, integral) instead of for a value
 * copied out of the table.
 *
 * ---------------------------------------------------------------------------
 * NEGATIVE CONTROL
 * ---------------------------------------------------------------------------
 * There is no `--break` flag; revert for real and watch it go red. All six
 * reverts below were applied to `save.js` and measured — green is 17/17:
 *
 *   delete `stunts: []` from blankSave()              -> 15/17 (2 red)
 *   delete `s.stunts = ids(raw.stunts)` in normalise  -> 11/17 (6 red)
 *   wipeAll() -> `for (const k of [SAVE_KEY])`        -> 15/17 (2 red)
 *   ids() -> keep duplicates and blanks               -> 15/17 (2 red)
 *   importSave -> `const save = raw` (no normalise)   -> 14/17 (3 red)
 *   importSave -> write() before the shape check      -> 15/17 (2 red)
 */

/* ------------------------------------------------------------------ */
/* A localStorage that behaves like the browser's.                      */
/* ------------------------------------------------------------------ */
class MemStorage {
  #m = new Map();
  getItem(k) { return this.#m.has(String(k)) ? this.#m.get(String(k)) : null; }
  setItem(k, v) { this.#m.set(String(k), String(v)); }
  removeItem(k) { this.#m.delete(String(k)); }
  clear() { this.#m.clear(); }
  get length() { return this.#m.size; }
  key(i) { return [...this.#m.keys()][i] ?? null; }
}
globalThis.localStorage = new MemStorage();

const {
  SAVE_KEY, SAVE_VERSION, DOSSIER_KIND,
  blankSave, normalise, load, write, wipeAll, exportSave, serialiseSave, importSave, exportFilename,
} = await import('./save.js');

const LEGACY_KEY = 'threeboyz.save.v1';

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const m = a.match(/^--([^=]+)(?:=(.*))?$/);
    return m ? [m[1], m[2] ?? true] : [a, true];
  })
);
const VERBOSE = !!args.verbose;

const results = [];
let failed = 0;
const check = (section, name, ok, detail) => {
  results.push({ section, name, ok, detail });
  if (!ok) failed++;
};

/** Every leaf where `got` and `want` disagree, as `path: got != want`. */
function diff(got, want, path = '', out = []) {
  if (out.length > 24) return out;
  const tg = Array.isArray(want) ? 'array' : want === null ? 'null' : typeof want;
  if (tg === 'array') {
    if (!Array.isArray(got)) return (out.push(`${path}: not an array (${typeof got})`), out);
    if (got.length !== want.length) out.push(`${path}.length: ${got.length} != ${want.length}`);
    for (let i = 0; i < Math.max(got.length, want.length); i++) diff(got[i], want[i], `${path}[${i}]`, out);
    return out;
  }
  if (tg === 'object') {
    if (!got || typeof got !== 'object') return (out.push(`${path}: not an object (${got})`), out);
    const keys = new Set([...Object.keys(want), ...Object.keys(got)]);
    for (const k of keys) diff(got[k], want[k], path ? `${path}.${k}` : k, out);
    return out;
  }
  if (got !== want) out.push(`${path}: ${JSON.stringify(got)} != ${JSON.stringify(want)}`);
  return out;
}

/* ------------------------------------------------------------------ */
/* The expected state. Written out by hand, on purpose.                 */
/* ------------------------------------------------------------------ */
/**
 * A save mid-playthrough: Aidan active on chapter 4, all three brothers
 * carrying different money, weapons, ammo, positions and best times; nine of
 * twelve packages found, four stunt jumps landed, two races run, the radio on
 * a station and a waypoint dropped downtown.
 *
 * Every value here is chosen to be one a real game could produce AND one no
 * default would produce by accident, so "the field survived" and "the field was
 * silently reset to its default" cannot be confused.
 */
const DOSSIER = {
  version: SAVE_VERSION,
  createdAt: 1751000000000,
  savedAt: 1753600000000,
  active: 'aidan',
  chars: {
    carson: {
      id: 'carson', chapter: 6, cash: 14320, respect: 412, deaths: 7, busts: 2,
      unlocked: ['flare', 'speargun', 'harpoon'],
      ammo: { nailgun: 74, speargun: 11 },
      hp: 88.5, armor: 31.25,
      pos: [-412.75, 6.4, 118.02], yaw: 2.187,
      safehouse: 'sh_carson', wanted: 3,
      best: { ch3: 71.24, ch5: 96.8 },
    },
    aidan: {
      id: 'aidan', chapter: 4, cash: 3075, respect: 188, deaths: 1, busts: 0,
      unlocked: ['smg'],
      ammo: { smg: 220 },
      hp: -1, armor: -1,
      pos: [812.5, 12.75, -640.1], yaw: -1.04,
      safehouse: 'sh_dt', wanted: 0,
      best: { ch2: 44.6 },
    },
    dylan: {
      id: 'dylan', chapter: 0, cash: 500, respect: 0, deaths: 0, busts: 0,
      unlocked: [],
      ammo: {},
      hp: -1, armor: -1,
      pos: null, yaw: 0,
      safehouse: null, wanted: 0,
      best: {},
    },
  },
  packages: ['pk1', 'pk2', 'pk3', 'pk4', 'pk5', 'pk6', 'pk7', 'pk8', 'pk9'],
  stunts: ['sj_incline', 'sj_millramp', 'sj_smithfield', 'sj_strip'],
  races: { triangle: 168.42, riverloop: 204.9 },
  unlocks: ['sh_dt', 'garage_2'],
  totals: { cash: 41250, kills: 318, missions: 11, distance: 74210.5, crashes: 46, playtime: 9142.25 },
  clock: 21.75,
  waypoint: { x: -120.5, z: 640.25 },
  difficulty: 'hard',
  radio: 'furnace',
};

/* ================================================================== */
/* 1 — the round trip                                                  */
/* ================================================================== */
{
  const S = '1 round trip';
  const text = serialiseSave(DOSSIER);

  check(S, 'the exported file is JSON a human could read and a parser accepts',
    typeof text === 'string' && text.includes('\n') && text.length > 400,
    `${text.length} bytes, ${text.split('\n').length} lines`);

  let onDisk = null;
  try { onDisk = JSON.parse(text); } catch { onDisk = null; }
  check(S, 'the file identifies itself as a Decarlo Boyz dossier',
    onDisk?.kind === DOSSIER_KIND && Number.isFinite(onDisk?.exportedAt),
    `kind ${onDisk?.kind}, exportedAt ${onDisk?.exportedAt}`);

  // Read out of the TEXT, not out of the object we passed in.
  check(S, 'the file itself carries the two global ledgers',
    Array.isArray(onDisk?.packages) && onDisk.packages.length === 9 &&
    Array.isArray(onDisk?.stunts) && onDisk.stunts.length === 4 &&
    onDisk.stunts[0] === 'sj_incline',
    `packages ${onDisk?.packages?.length}, stunts ${JSON.stringify(onDisk?.stunts)}`);

  const r = importSave(text, { persist: false });
  const d = r.ok ? diff(r.save, DOSSIER) : ['import rejected: ' + r.error];
  check(S, 'every field comes back exactly as it went in',
    r.ok && d.length === 0,
    d.length ? d.slice(0, 8).join(' · ') : `${Object.keys(DOSSIER).length} top-level fields, 3 brothers, all identical`);

  // The half of the round trip that regressed on its own: a ledger that is
  // carried through export but dropped by the importer reads as an empty array
  // rather than as an error, so name it separately.
  check(S, 'stunts and packages survive the importer specifically',
    r.ok && JSON.stringify(r.save.stunts) === JSON.stringify(DOSSIER.stunts) &&
    JSON.stringify(r.save.packages) === JSON.stringify(DOSSIER.packages),
    `stunts ${JSON.stringify(r.save?.stunts)} · packages ${r.save?.packages?.length}`);

  check(S, 'a suggested filename is dated and .json',
    /^decarlo-boyz-dossier-\d{4}-\d{2}-\d{2}\.json$/.test(exportFilename(1753660800000)),
    exportFilename(1753660800000));
}

/* ================================================================== */
/* 2 — an import rebuilds the game, and cannot smuggle in nonsense     */
/* ================================================================== */
{
  const S = '2 import hardening';
  localStorage.clear();
  write(structuredClone(DOSSIER));
  const before = localStorage.getItem(SAVE_KEY);

  const junk = [
    ['not JSON at all', 'this is not a save {{{'],
    ['an array', '[1,2,3]'],
    ['JSON with no chars map', '{"version":2,"packages":["pk1"]}'],
    ['null', 'null'],
    ['a number', '17'],
  ];
  const rejected = junk.filter(([, t]) => importSave(t).ok === false);
  check(S, 'every kind of wrong file is refused with a reason',
    rejected.length === junk.length,
    junk.map(([n, t]) => `${n}: ${importSave(t).error || 'ACCEPTED'}`).join(' · '));

  check(S, 'a refused import does not touch the save already on disk',
    localStorage.getItem(SAVE_KEY) === before,
    localStorage.getItem(SAVE_KEY) === before ? 'byte-identical' : 'STORAGE CHANGED');

  // The failure mode being guarded against: `clean.chars = p.chars` wholesale.
  const hostile = JSON.stringify({
    version: 2,
    chars: {
      carson: { chapter: 99, cash: 'lots', respect: -500, unlocked: ['flare', 'flare', 7, null], wanted: 12, hp: 'full' },
      mallory: { chapter: 8, cash: 999999 },
    },
    packages: ['pk1', 'pk1', 'pk1', '', 42],
    stunts: ['sj_a', 'sj_a'],
    difficulty: 'godmode',
    clock: 91,
  });
  const h = importSave(hostile, { persist: false });
  const c = h.save?.chars?.carson;
  check(S, 'a hand-edited file cannot express a state the game cannot',
    h.ok && c && c.chapter <= 8 && Number.isInteger(c.cash) && c.cash >= 0 &&
    c.respect >= 0 && c.wanted <= 5 && Number.isFinite(c.hp) &&
    !('mallory' in h.save.chars) && ['easy', 'normal', 'hard', 'steel'].includes(h.save.difficulty) &&
    h.save.clock <= 24,
    `chapter ${c?.chapter}, cash ${JSON.stringify(c?.cash)}, respect ${c?.respect}, wanted ${c?.wanted}, ` +
    `hp ${c?.hp}, fourth brother ${'mallory' in (h.save?.chars ?? {})}, difficulty ${h.save?.difficulty}, clock ${h.save?.clock}`);

  check(S, 'the found-once ledgers are sets: no repeats, no blanks, no numbers',
    JSON.stringify(h.save?.packages) === JSON.stringify(['pk1']) &&
    JSON.stringify(h.save?.stunts) === JSON.stringify(['sj_a']) &&
    JSON.stringify(c?.unlocked) === JSON.stringify(['flare']),
    `packages ${JSON.stringify(h.save?.packages)}, stunts ${JSON.stringify(h.save?.stunts)}, ` +
    `unlocked ${JSON.stringify(c?.unlocked)}`);

  // A straight copy of the localStorage value, and a { save: ... } wrapper,
  // are both things a player will paste in. Both must work.
  const bare = importSave(localStorage.getItem(SAVE_KEY), { persist: false });
  const wrapped = importSave({ save: structuredClone(DOSSIER) }, { persist: false });
  check(S, 'a raw localStorage blob and a wrapped dossier both import',
    bare.ok && bare.save.active === DOSSIER.active &&
    wrapped.ok && diff(wrapped.save, DOSSIER).length === 0,
    `bare ${bare.ok} (${bare.save?.chars?.carson?.chapter} carson chapters) · wrapped ${wrapped.ok}`);

  // Persisted synchronously, as an explicit act.
  localStorage.clear();
  const p = importSave(serialiseSave(DOSSIER));
  const stored = JSON.parse(localStorage.getItem(SAVE_KEY) ?? 'null');
  check(S, 'an accepted import is on disk before the call returns',
    p.ok && p.stored && stored && stored.active === 'aidan' &&
    stored.stunts?.length === 4 && stored.chars.carson.chapter === 6,
    stored ? `active ${stored.active}, carson ch${stored.chars.carson.chapter}, ${stored.stunts?.length} stunts` : 'NOTHING WRITTEN');
}

/* ================================================================== */
/* 3 — erase all progress                                              */
/* ================================================================== */
{
  const S = '3 wipe';
  localStorage.clear();
  write(structuredClone(DOSSIER));
  // The legacy save is not hypothetical: `load()` reads it whenever the v2
  // slot is empty, which is precisely the state a wipe creates.
  localStorage.setItem(LEGACY_KEY, JSON.stringify({
    version: 1,
    chars: { carson: { chapter: 5, cash: 8000, respect: 300, unlocked: ['flare'], deaths: 4 } },
    packages: ['pk1', 'pk2'],
    stunts: ['sj_incline'],
    totals: { cash: 9000, kills: 100, missions: 6, distance: 100, crashes: 3, playtime: 500 },
  }));

  const ok = wipeAll();
  const after = load();
  const chapters = ['carson', 'aidan', 'dylan'].map((id) => after.save.chars[id].chapter);
  check(S, 'erase-all leaves no brother with any progress, on any key',
    ok && after.source === 'new' && chapters.every((c) => c === 0) &&
    (after.save.packages?.length ?? -1) === 0 && (after.save.stunts?.length ?? -1) === 0 &&
    after.save.totals.kills === 0,
    `next boot: source "${after.source}", chapters ${chapters.join('/')}, ` +
    `${after.save.packages?.length} packages, ${after.save.stunts?.length} stunts, ${after.save.totals.kills} kills`);

  check(S, 'both storage keys are gone, not just the current one',
    localStorage.getItem(SAVE_KEY) === null && localStorage.getItem(LEGACY_KEY) === null,
    `v2 ${localStorage.getItem(SAVE_KEY) === null ? 'gone' : 'PRESENT'}, ` +
    `v1 ${localStorage.getItem(LEGACY_KEY) === null ? 'gone' : 'PRESENT'}`);

  // A wipe followed by a new game must still be a working save.
  const fresh = blankSave();
  check(S, 'the blank save a wipe lands you on carries both ledgers',
    Array.isArray(fresh.packages) && fresh.packages.length === 0 &&
    Array.isArray(fresh.stunts) && fresh.stunts.length === 0,
    `packages ${JSON.stringify(fresh.packages)}, stunts ${JSON.stringify(fresh.stunts)}`);
}

/* ================================================================== */
/* 4 — the legacy save still comes forward when it SHOULD              */
/* ================================================================== */
{
  const S = '4 legacy';
  // Control for section 3: if the wipe passed because the legacy path is
  // simply broken, this fails and says so.
  localStorage.clear();
  localStorage.setItem(LEGACY_KEY, JSON.stringify({
    version: 1,
    chars: { carson: { chapter: 5, cash: 8000, respect: 300, unlocked: ['flare', 'flare'], deaths: 4 } },
    packages: ['pk1', 'pk2', 'pk2'],
    stunts: ['sj_incline', 'sj_incline'],
    totals: { cash: 9000, kills: 100, missions: 6, distance: 100, crashes: 3, playtime: 500 },
  }));
  const l = load();
  check(S, 'a v1 save is still carried forward on first boot',
    l.source === 'legacy' && l.save.chars.carson.chapter === 5 && l.save.totals.kills === 100,
    `source "${l.source}", carson ch${l.save.chars.carson.chapter}, ${l.save.totals.kills} kills`);
  check(S, 'and its ledgers are de-duplicated on the way in',
    JSON.stringify(l.save.packages) === JSON.stringify(['pk1', 'pk2']) &&
    JSON.stringify(l.save.stunts) === JSON.stringify(['sj_incline']) &&
    JSON.stringify(l.save.chars.carson.unlocked) === JSON.stringify(['flare']),
    `packages ${JSON.stringify(l.save.packages)}, stunts ${JSON.stringify(l.save.stunts)}, ` +
    `unlocked ${JSON.stringify(l.save.chars.carson.unlocked)}`);
  localStorage.clear();
}

/* ------------------------------------------------------------------ */
/* report                                                              */
/* ------------------------------------------------------------------ */
let section = '';
for (const r of results) {
  if (r.section !== section) {
    section = r.section;
    console.log(`\n=== ${section} ===`);
  }
  console.log(`  ${r.ok ? 'ok  ' : 'FAIL'} ${r.name}`);
  if (!r.ok || VERBOSE) console.log(`       ${r.detail}`);
}
const total = results.length;
console.log(`\npersistence: ${total - failed}/${total}`);
process.exit(failed ? 1 : 0);
