#!/usr/bin/env node
/**
 * ARSENALPROBE — the mechanical gate over the improvised arsenal.
 *
 * ============================================================================
 * WHY IT EXISTS
 * ============================================================================
 * The arsenal used to LOOK like it had collapsed: all three brothers appearing
 * to carry the same weapons, the nail gun apparently gone, and every frame
 * showing a DOCK PIPE. None of that was true of the DATA — all sixteen weapons
 * were built, and the three brothers had three different loadouts. It was all
 * true of the GAME:
 *
 *   1. every brother came up holding `loadout[1]`, which is his MELEE TOOL, so
 *      the HUD said DOCK PIPE / BODY WRENCH / CROWBAR forever, and
 *   2. holding any weapon that was not one-handed pushed a 0.46 carry pose into
 *      `player.setAdsProgress`, which `player` reads as "aiming" above 0.35 and
 *      which `player/movement.js` refuses to sprint through — so ten of the
 *      sixteen weapons silently cost you Shift and pinned you to 1.9 m/s.
 *
 * Both are invisible to a still-frame critic and to `tools/playprobe.mjs`,
 * whose three combat checks are satisfied by swinging a pipe. So the checks
 * live here, and they are deliberately about BEHAVIOUR: rounds leaving a
 * muzzle, ammunition going down, a measured rate of fire, a measured sprint.
 *
 * ============================================================================
 * RULE 12 — WHAT WOULD MAKE THIS FAIL
 * ============================================================================
 * Nothing here imports `lib.js`. The table under test comes from
 * `weapons.debugArsenal()`, which reports the FINALISED defs the fire code
 * reads plus a viewmodel signature measured off the instantiated THREE
 * geometry — vertex counts, index counts, the world-scale bounding box, the
 * material set and the muzzle/eject node transforms. A model builder that
 * silently returns the same mesh for two weapons fails `viewmodel`; a table
 * whose numbers collapse fails `table`; and neither can pass by agreeing with
 * the source literal, because the source literal is never read.
 *
 * The fired checks are stricter still: they assert the origin of the round
 * against the rig's live muzzle transform and against the player's position, so
 * the historical "fired from the world origin after a swap" bug is caught.
 *
 * ============================================================================
 * TWO STAGING RULES, BOTH LEARNED THE EXPENSIVE WAY
 * ============================================================================
 * The first version of this file scored 132-133/157 against an arsenal that was
 * working (the count moved run to run because half of it depended on whether a
 * police cruiser turned up). Every one of those red lines came from one of the
 * two rules below, and both are about the HARNESS, not the game — so they are
 * written down here rather than left in a diff:
 *
 * 1. A WEAPON MUST BE FIRED IN THE HANDS OF THE BROTHER WHO CARRIES IT.
 *    `weapons.update` polls the save twice a second and `setLoadout` puts
 *    `loadout[0]` — fists — back in your hands the moment you are holding
 *    something the active brother does not own. `setWeaponImmediate` bypasses
 *    the unlock gate, so a sweep that forces all sixteen into one brother's
 *    hands gets ONE round out of the ten he does not carry and then measures
 *    FISTS. That is what produced "smg: stated 176 rpm" (176 is the fists'
 *    swing rate), "flashScale 0" (fists have no muzzle), "mag 41 -> Infinity"
 *    (melee ammunition is Infinity by definition) and "tackgun: sim 0 rpm,
 *    1 rounds". Measured with the same burst staged on Dylan instead: smg
 *    664.5 rpm against a stated 666.7, tackgun 372.2 against 375.
 *    So: `OWNER[id]` below is read out of the game at runtime and every fired
 *    check stages the owning brother first. `stillHeld` then asserts the
 *    weapon under test was still in hand at the end, so a future mis-stage
 *    fails loudly instead of quietly measuring something else.
 *
 * 2. `weapon:fire` IS NOT THE PLAYER'S EVENT. Cops raise it too. See the long
 *    note at the recorder.
 *
 * The one place this file deliberately stages a state the game cannot reach is
 * the `brothers` group, which has to put ONE weapon in three different pairs of
 * hands to hold the variable constant — no two brothers share a firearm. It
 * suspends the ownership poll for the length of that measurement and says so.
 *
 * NEGATIVE CONTROLS (rule 12's corollary — a gate that has never failed is not
 * evidence of anything). Each arm reverts exactly one fix at runtime:
 *
 *   --nc=sprint     restore the 0.46 carry pose  -> `sprint` must go red
 *   --nc=cadence    drop the fire-cycle remainder -> `auto` rate must go red
 *   --nc=pose       let the ownership poll run during a frozen capture pose
 *                                                 -> `viewmodel` must go red
 *   --nc=brothers   neutralise BROTHER_HANDLING   -> `brothers` must go red
 *   --nc=table      copy the Shop SMG's def onto the Tack Cannon
 *                                                 -> `table` must go red
 *   --nc=models     point the Tack Cannon's rig entry at the SMG's meshes
 *                                                 -> `viewmodel` must go red
 *
 * A negative-control run PASSES when the targeted group goes red. Run it after
 * any change to this file: a control that stays green means the check it
 * guards has stopped testing anything. `--only=<groups>` skips the expensive
 * groups a control does not touch, so an arm is a couple of minutes rather
 * than the full sweep.
 *
 *   npm run build && node src/weapons/arsenalprobe.mjs
 *   node src/weapons/arsenalprobe.mjs --nc=sprint   --only=sprint
 *   node src/weapons/arsenalprobe.mjs --nc=cadence  --only=auto
 *   node src/weapons/arsenalprobe.mjs --nc=pose     --only=viewmodel
 *   node src/weapons/arsenalprobe.mjs --nc=brothers --only=brothers
 *   node src/weapons/arsenalprobe.mjs --nc=table    --only=table
 *   node src/weapons/arsenalprobe.mjs --nc=models   --only=viewmodel
 */
import { chromium } from 'playwright';
import { startServer } from '../../tools/lib/server.mjs';

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const m = a.match(/^--([^=]+)(?:=(.*))?$/);
    return m ? [m[1], m[2] ?? true] : [a, true];
  })
);

/** DESIGN.md "Weapons": the arsenal this game is contractually required to have. */
const REQUIRED = {
  melee: ['fists', 'pipe', 'wrench', 'crowbar'],
  light: ['nailgun', 'tackgun', 'sprayer', 'smg'],
  precise: ['flare', 'speargun', 'rivetgun', 'harpoon'],
  explosive: ['launcher', 'depth', 'rocket', 'emp'],
};
const REQUIRED_IDS = Object.values(REQUIRED).flat();

/**
 * The GTA-style class spread the arsenal has to cover, expressed as a predicate
 * over the emitted def rather than as a list of ids — so renaming a weapon
 * cannot quietly empty a class.
 */
const ARCHETYPES = {
  melee: (w) => w.melee && w.reach >= 3,
  /* pistol: one-handed, magazine-fed or break-open, drawn fast */
  pistol: (w) => !w.melee && w.hold === 'oneHand' && w.drawTime <= 0.5,
  /* shotgun: more than one projectile per pull, wide cone, short reach */
  shotgun: (w) => w.pellets > 1 && w.spreadHip >= 4 && w.range <= 30,
  /* automatic: holds the trigger down at 300 rpm or better off a real magazine */
  automatic: (w) => w.modes.includes('auto') && w.rpm >= 300 && w.magSize >= 20,
  /* rifle: flat, fast, long, one round per trigger pull if you want it */
  rifle: (w) => !w.melee && w.muzzleVelocity >= 200 && w.range >= 80 && w.magSize > 1,
  /* the rustbelt identity: things that are not guns at all */
  improvised: (w) => ['nail', 'tack', 'paint', 'flare', 'spear', 'rivet', 'harpoon', 'coil', 'drum'].includes(w.projectile),
  explosive: (w) => w.splash > 0,
  silent: (w) => w.silent === true,
};

/** Axes on which two weapons must not be the same thing wearing two hats. */
const AXES = [
  ['rate', (w) => w.cycleTime],
  ['spread', (w) => w.spreadHip],
  ['recoilPitch', (w) => w.recoil.pitch],
  ['recoilBody', (w) => w.recoil.body],
  ['reload', (w) => (w.melee ? w.drawTime : w.reloadEmpty)],
  ['handling', (w) => w.drawTime],
  ['range', (w) => w.range],
  ['damage', (w) => w.damage],
  ['velocity', (w) => (w.melee ? w.reach : w.muzzleVelocity)],
  ['mag', (w) => (w.melee ? w.arcDeg : w.magSize)],
  ['audio', (w) => `${w.fxClass}/${w.audioProfile}/${w.flashScale}`],
];
/** Two weapons must differ on at least this many of the axes above. */
const MIN_DISTINCT_AXES = 6;

const results = [];
const rec = (area, name, ok, detail) => results.push({ area, name, ok, detail: detail ?? '' });

/**
 * `--only=auto,sprint` runs just those groups. The cheap groups (coverage,
 * table, viewmodel) are one page call and always run; the expensive ones fire
 * or drive the character sixteen times each. A negative control only needs the
 * group it targets, and a five-arm control run that had to fire the whole
 * arsenal five times would not get run.
 */
const ONLY = args.only ? String(args.only).split(',').map((s) => s.trim()) : null;
const want = (g) => !ONLY || ONLY.includes(g);

const { port, server } = await startServer({ explicitPort: args.port });
const browser = await chromium.launch({
  args: ['--use-angle=metal', '--ignore-gpu-blocklist', '--enable-gpu', '--mute-audio'],
});
/* Small viewport on purpose. This gate measures WEAPON behaviour — cadence,
 * ammunition, recoil, sprint — none of which depend on resolution, and a
 * 1280x720 GPU page on a machine with a fleet of agents on it pushed the engine
 * frame to 50-100 ms, which is a large fraction of a 90 ms fire cycle and makes
 * the rate unmeasurable rather than wrong. */
const page = await browser.newPage({ viewport: { width: 800, height: 450 } });
const errs = [];
/* WITH THE TOP FRAME, ALWAYS. "no page errors" reporting only
 * "Cannot read properties of undefined (reading 'update')" is a red gate that
 * tells the next reader nothing at all — the whole cost of the check is finding
 * the thing again, and the stack was right there when it was thrown. */
const at = (e) => {
  const f = String(e?.stack ?? '').split('\n').slice(1)
    .map((l) => l.trim().replace(/^at\s+/, '').replace(/https?:\/\/[^/]+\//, ''))
    .filter(Boolean)[0];
  return f ? ` @ ${f.slice(0, 120)}` : '';
};
page.on('pageerror', (e) => errs.push(String(e.message).slice(0, 160) + at(e)));
page.on('console', (m) => { if (m.type() === 'error') errs.push(m.text().slice(0, 200)); });

const pump = (n) =>
  page.evaluate((k) => new Promise((d) => {
    let i = 0;
    const t = () => (++i >= k ? d() : requestAnimationFrame(t));
    requestAnimationFrame(t);
  }), n);

/* Somewhere flat, open and away from traffic, so a sprint test measures the
 * player rather than the first kerb he walks into. Re-applied before every
 * weapon so the runs cannot interfere with one another. */
const RANGE_POS = { x: -60, z: 250 };

const toRange = (yaw = 0) =>
  page.evaluate(({ p, yaw: y }) => {
    const e = window.__ENGINE__;
    const pl = e.ctx.peek('player');
    const w = e.ctx.peek('world');
    const gy = w?.walkableHeightAt?.(p.x, p.z) ?? 1;
    pl.teleport({ x: p.x, y: gy + 1.2, z: p.z }, y);
    /**
     * AND THE RANGE IS QUIET. Firing a hundred and fifty rounds down a Steel
     * City street is a hundred and fifty gunfire crimes: `police` escalates,
     * spawns a pursuit and follows the teleport, and by the back half of a run
     * the weapon under test is being measured through a firefight — a frame
     * that has trebled in length (which the cadence check has to correct for), a
     * player being shot at and shoved, and somebody else's `weapon:fire` in the
     * recorder. None of that is what this gate is about, and `police` has its
     * own. Clearing the stars restores the documented premise of this position:
     * flat, open, and nobody else in it.
     */
    e.ctx.peek('police')?.clearWanted?.('probe');
    return true;
  }, { p: RANGE_POS, yaw });

try {
  await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: 'domcontentloaded', timeout: 120000 });
  await page.waitForFunction('window.__READY__===true', null, { timeout: 420000 });
  await pump(120);

  await page.evaluate(() => {
    const e = window.__ENGINE__;
    e.input.enabled = true;
    e.input.frozen = false;
    e.ctx.peek('player')?.setControlEnabled?.(true);

    /* One shared recorder for every event this gate cares about. Installed
     * once, reset per check, so no check can be satisfied by another's noise. */
    const rec = { fire: [], tracer: [], impact: [], shell: [], reload: [], damage: [], explosion: [], foreign: [] };
    window.__WREC__ = rec;
    window.__WRESET__ = () => { for (const k of Object.keys(rec)) rec[k].length = 0; };
    const ev = e.ctx.events;
    /**
     * ATTRIBUTION — `weapon:fire` IS NOT THE PLAYER'S EVENT. IT IS EVERYONE'S.
     *
     * `src/police/index.js:copShotFx` raises the same canonical event for every
     * round a COP fires, because `fx` and `audio` have to answer it; its payload
     * carries `police: true` and a `weapon` that is the string `'pistol'`. The
     * first version of this recorder took all of them, so once the probe's own
     * gunfire raised a wanted level the return fire was scored as the player's:
     * measured on one run, `fists` reported "6 swings, 3 with origin" (a punch
     * that fired a gun), `depth` reported "origins 3/3, off-player 2" (a muzzle
     * 40 m from the player) and `smg` reported "5 shots, 1 projectiles". Every
     * one of those was a cop, and none of them said so — the checks went red and
     * green on whether a cruiser had turned up, which is rule 12's decorative
     * gate wearing a plausible number.
     *
     * The filter is the WEAPON SYSTEM'S OWN ID SET: this system publishes a
     * purpose-built descriptor object (`_fireWeapon`) whose `id` is one of the
     * sixteen. A string payload, a foreign id, or anything flagged `police`
     * belongs to somebody else. Discards are counted, not dropped silently, and
     * printed at the end of the run so a reader can see how noisy the world was.
     */
    const MINE = new Set(e.ctx.peek('weapons').weaponIds);
    /* Per-check (cleared by __WRESET__) and whole-run (never cleared). */
    window.__WFOREIGN__ = 0;
    /* The shooter's position is sampled AT THE EVENT, not afterwards: a Scrap
     * Rocket detonating 20 m away shoves the player several metres, and a check
     * that compares the muzzle to where he ended up measures the blast, not the
     * muzzle. */
    ev.on('weapon:fire', (p) => {
      if (p?.police || typeof p?.weapon !== 'object' || !p.weapon || !MINE.has(p.weapon.id)) {
        rec.foreign.push(typeof p?.weapon === 'object' ? (p?.weapon?.id ?? '?') : String(p?.weapon));
        window.__WFOREIGN__++;
        return;
      }
      const pp = e.ctx.peek('player')?.position;
      rec.fire.push({
        id: p?.weapon?.id ?? null,
        melee: !!p?.melee,
        origin: p?.origin ? [p.origin.x, p.origin.y, p.origin.z] : null,
        at: pp ? [pp.x, pp.y, pp.z] : null,
        t: performance.now(),
        /* SIMULATED time, which is the clock the fire timer, the projectiles,
         * the recoil springs and the ammunition all run on. See the cadence
         * check for why the rate is asserted against this and only reported
         * against the wall clock. */
        sim: e.ctx.time?.elapsed ?? 0,
        frame: e.ctx.time?.frame ?? 0,
      });
    });
    ev.on('bullet:tracer', () => rec.tracer.push(performance.now()));
    ev.on('bullet:impact', (p) => rec.impact.push({ damage: p?.damage ?? 0, surface: p?.surface ?? null }));
    ev.on('weapon:shell', () => rec.shell.push(performance.now()));
    ev.on('weapon:reload', (p) => rec.reload.push(p?.phase ?? '?'));
    ev.on('damage:dealt', (p) => rec.damage.push({ amount: p?.amount ?? 0, target: typeof p?.target === 'string' ? p.target : 'obj' }));
    ev.on('explosion', () => rec.explosion.push(performance.now()));
  });
  await pump(20);

  /* ------------------------------------------------------------------ */
  /*  negative-control arms                                              */
  /* ------------------------------------------------------------------ */
  const NC = String(args.nc ?? '');
  const applyNc = (arm) =>
    page.evaluate((a) => {
      const wp = window.__ENGINE__.ctx.peek('weapons');
      if (!a) return 'none';
      if (a === 'sprint') { wp.debugReadyFloor = 0.46; return 'ready floor -> 0.46 (pre-fix)'; }
      if (a === 'cadence') { wp.debugNoCadenceCarry = true; return 'fire-cycle remainder discarded'; }
      if (a === 'pose') { wp.debugPosePoll = true; return 'ownership poll runs during a capture pose again'; }
      if (a === 'cars') { wp.sim.cars.disabled = true; return 'bullets pass through vehicles again'; }
      if (a === 'driveby') { wp.debugHolsterInCar = true; return 'everything holsters in a vehicle again'; }
      if (a === 'brothers') {
        wp.debugUniformHandling = true;
        wp.setBrother(wp.brotherId ?? 'carson', false);
        return 'BROTHER_HANDLING neutralised';
      }
      if (a === 'table') {
        const src = wp.states.get('smg'), dst = wp.states.get('tackgun');
        dst.def = { ...src.def, id: 'tackgun', label: 'Tack Cannon' };
        return 'tackgun def := smg def';
      }
      if (a === 'models') {
        const src = wp.rig.entries.get('smg'), dst = wp.rig.entries.get('tackgun');
        dst.group = src.group; dst.muzzle = src.muzzle; dst.eject = src.eject; dst.tris = src.tris;
        return 'tackgun viewmodel := smg viewmodel';
      }
      return 'unknown';
    }, arm);

  if (NC) console.error(`[nc] ${NC}: ${await applyNc(NC)}`);

  /**
   * PROGRESSION FIRST, ON A FRESH SAVE.
   *
   * `game.economy` is the authority on what a brother owns, and a new game owns
   * only DESIGN.md's "starts with" — fists plus his melee tool. So the checks
   * below run in two states on purpose: locked (what minute one looks like) and
   * then unlocked (what most of the game looks like), because a gate that only
   * ever saw one of them would bless either a wheel that hands out a Scrap
   * Rocket on the first chapter or a wheel that never opens up.
   */
  if (want('brothers')) {
    const lock = await page.evaluate(() => {
      const e = window.__ENGINE__;
      const wp = e.ctx.peek('weapons');
      const out = { boys: {}, drew: null, locked: null, before: wp.activeId };
      for (const b of ['carson', 'aidan', 'dylan']) {
        wp.setBrother(b, true);
        out.boys[b] = { loadout: wp.loadout.slice(), active: wp.activeId, start: wp.debugArsenal().start };
      }
      /* Try to draw something this brother has not earned, through the same
       * call `ui:weapon` makes. */
      wp.setBrother('carson', true);
      const target = 'rocket';
      out.locked = target;
      out.canDraw = wp.canDraw(target);
      out.drew = wp.setWeapon(target);
      out.activeAfter = wp.activeId;
      /* And through the event the weapon wheel actually emits. */
      e.ctx.events.emit('ui:weapon', { id: target });
      out.activeAfterEvent = wp.activeId;
      return out;
    });
    for (const [b, v] of Object.entries(lock.boys)) {
      rec('progression', `${b} starts with only his DESIGN.md kit`,
        v.loadout.join(',') === v.start.join(','),
        `[${v.loadout.join(' ')}] vs start [${v.start.join(' ')}]`);
    }
    rec('progression', 'a weapon the save has not unlocked cannot be drawn',
      lock.canDraw === false && lock.drew === false &&
      lock.activeAfter !== lock.locked && lock.activeAfterEvent !== lock.locked,
      `canDraw=${lock.canDraw} setWeapon=${lock.drew} after=${lock.activeAfter}, ` +
      `after ui:weapon=${lock.activeAfterEvent}`);

    const grant = await page.evaluate(() => {
      const wp = window.__ENGINE__.ctx.peek('weapons');
      wp.setBrother('aidan', true);
      const before = { ...wp.ammo };
      const gave = wp.giveWeapon('rivetgun');
      wp.setWeapon('rivetgun');
      const st = wp.states.get('rivetgun');
      return {
        gave, drew: wp.activeId === 'rivetgun',
        mag: st.mag, magSize: st.def.magSize, before: before.mag,
        inLoadout: wp.loadout.includes('rivetgun'),
      };
    });
    rec('progression', 'a granted weapon arrives with a half magazine and is drawable',
      grant.gave && grant.inLoadout && grant.drew &&
      grant.mag >= Math.ceil(grant.magSize / 2),
      `mag ${grant.mag}/${grant.magSize} (want >= ${Math.ceil(grant.magSize / 2)}), ` +
      `drawable=${grant.drew}`);

    const stock = await page.evaluate(() => {
      const wp = window.__ENGINE__.ctx.peek('weapons');
      wp.unlockEverything();
      const out = [];
      for (const id of wp.loadout) {
        const s = wp.states.get(id);
        if (s.def.melee) continue;
        const total = s.def.magSize + s.def.reserve;
        out.push({ id, have: s.mag + s.reserve, total });
      }
      return { rows: out, loadout: wp.loadout.slice(), unlockAll: wp.unlockAll };
    });
    const under = stock.rows.filter((r) => r.have < r.total * 0.5);
    rec('progression', 'unlock-all grants the arsenal, each at >= 50% ammunition',
      stock.unlockAll && stock.loadout.length === 6 && under.length === 0,
      under.length ? under.map((r) => `${r.id} ${r.have}/${r.total}`).join(', ')
        : `${stock.loadout.length} weapons, all >= 50%`);
  }

  /**
   * EVERYTHING BELOW THIS LINE RUNS WITH THE ARSENAL UNLOCKED.
   *
   * It has to: `_resolveUnlocks` re-reads the save twice a second and
   * `setLoadout` takes a weapon out of your hand if you do not own it, so a
   * `fire` or `sprint` sweep over all sixteen would be testing 'fists' half the
   * time. The locked state is what the block above is for, and it is checked
   * BEFORE this because unlocking is deliberately one-way.
   *
   * UNLOCKING IS NOT ENOUGH ON ITS OWN. "Unlocked" means each brother carries
   * his own full six, not that anybody carries all sixteen — the three sets are
   * disjoint apart from fists, and the poll enforces that continuously. So the
   * fired groups also have to pick the right pair of hands; see `OWNER`.
   */
  if (want('brothers') || want('fire') || want('auto') || want('sprint') ||
      want('vehicle') || want('driveby')) {
    await page.evaluate(() => window.__ENGINE__.ctx.peek('weapons').unlockEverything());
    await pump(10);
  }

  /**
   * WHO CARRIES WHAT — read out of the running game, never from a table kept
   * here. `BROTHER_LOADOUT` moving would otherwise leave this file staging
   * weapons in hands that dropped them, which is precisely the failure this map
   * exists to prevent, and it would do it silently.
   */
  const OWNER = await page.evaluate(() => {
    const wp = window.__ENGINE__.ctx.peek('weapons');
    const before = wp.brotherId;
    const out = {};
    for (const b of ['carson', 'aidan', 'dylan']) {
      wp.setBrother(b, false);
      for (const id of wp.loadout) if (!(id in out)) out[id] = b;
    }
    wp.setBrother(before ?? 'carson', true);
    return out;
  });

  /* ================================================================== */
  /*  1. COVERAGE — is the arsenal DESIGN.md says exists actually here?  */
  /* ================================================================== */
  const arsenal = await page.evaluate(() => window.__ENGINE__.ctx.peek('weapons').debugArsenal());
  const W = arsenal.weapons;
  const ids = arsenal.order;

  rec('coverage', 'sixteen weapons are built and reachable', ids.length === 16, `${ids.length} built`);
  const missing = REQUIRED_IDS.filter((id) => !W[id]);
  rec('coverage', 'every DESIGN.md weapon id is present', missing.length === 0,
    missing.length ? `MISSING: ${missing.join(', ')}` : REQUIRED_IDS.join(' '));
  for (const [cls, want] of Object.entries(REQUIRED)) {
    const have = want.filter((id) => W[id]);
    rec('coverage', `class ${cls} is complete`, have.length === want.length,
      `${have.length}/${want.length} — ${have.join(' ')}`);
  }
  for (const [name, pred] of Object.entries(ARCHETYPES)) {
    const hit = ids.filter((id) => pred(W[id].def));
    rec('coverage', `archetype ${name} is covered`, hit.length > 0, hit.join(' ') || 'NONE');
  }

  /* ================================================================== */
  /*  2. TABLE — two weapons that differ only in stats are one weapon    */
  /* ================================================================== */
  {
    const key = (id) => AXES.map(([, f]) => String(f(W[id].def))).join('|');
    const seen = new Map();
    let dupes = 0;
    for (const id of ids) {
      const k = key(id);
      if (seen.has(k)) { dupes++; rec('table', `${id} is not a clone of ${seen.get(k)}`, false, k); }
      seen.set(k, id);
    }
    rec('table', 'no two weapons are identical across every axis', dupes === 0, `${ids.length} distinct`);

    /* No two share a rate of fire. */
    const rates = new Map();
    let rateClash = [];
    for (const id of ids) {
      const r = W[id].def.cycleTime.toFixed(4);
      if (rates.has(r)) rateClash.push(`${id}=${rates.get(r)}`);
      rates.set(r, id);
    }
    rec('table', 'every weapon has its own rate of fire', rateClash.length === 0,
      rateClash.length ? rateClash.join(', ') : `${rates.size} distinct cycle times`);

    /* No two share the (rate, spread, recoil) triple — the profile a player feels. */
    const prof = new Map();
    const profClash = [];
    for (const id of ids) {
      const d = W[id].def;
      const k = `${d.cycleTime}|${d.spreadHip}|${d.recoil.pitch}|${d.recoil.body}`;
      if (prof.has(k)) profClash.push(`${id}~${prof.get(k)}`);
      prof.set(k, id);
    }
    rec('table', 'no two share a rate AND a spread AND a recoil profile', profClash.length === 0,
      profClash.length ? profClash.join(', ') : `${prof.size} distinct profiles`);

    /* Every PAIR must differ on several axes, not just one. */
    let worst = { a: null, b: null, n: 99 };
    for (let i = 0; i < ids.length; i++) {
      for (let j = i + 1; j < ids.length; j++) {
        let n = 0;
        for (const [, f] of AXES) if (String(f(W[ids[i]].def)) !== String(f(W[ids[j]].def))) n++;
        if (n < worst.n) worst = { a: ids[i], b: ids[j], n };
      }
    }
    rec('table', `every pair differs on >= ${MIN_DISTINCT_AXES} of ${AXES.length} axes`,
      worst.n >= MIN_DISTINCT_AXES,
      `closest pair ${worst.a}/${worst.b} differ on ${worst.n}`);
  }

  /* ================================================================== */
  /*  3. VIEWMODEL — measured off the emitted geometry, not the builder  */
  /* ================================================================== */
  {
    const sigs = new Map();
    const clashes = [];
    let empty = [];
    for (const id of ids) {
      const vm = W[id].vm;
      if (!vm || vm.meshes === 0 || vm.verts === 0) { empty.push(id); continue; }
      const k = `${vm.meshes}|${vm.verts}|${vm.idx}|${vm.box.join(',')}|${vm.mats.join(',')}`;
      if (sigs.has(k)) clashes.push(`${id} == ${sigs.get(k)}`);
      sigs.set(k, id);
    }
    rec('viewmodel', 'every weapon emits real geometry', empty.length === 0,
      empty.length ? `EMPTY: ${empty.join(', ')}` : `${ids.length} models`);
    rec('viewmodel', 'no two weapons share a mesh signature', clashes.length === 0,
      clashes.length ? clashes.join('; ') : `${sigs.size} distinct silhouettes`);

    /* Silhouette really varies: the longest dimension must span a real range. */
    const spans = ids.map((id) => Math.max(...(W[id].vm?.box ?? [0])) / 1000);
    const lo = Math.min(...spans), hi = Math.max(...spans);
    rec('viewmodel', 'silhouettes span a real size range', hi / Math.max(0.01, lo) >= 2.5,
      `${lo.toFixed(2)} m .. ${hi.toFixed(2)} m (x${(hi / Math.max(0.01, lo)).toFixed(1)})`);

    /* A muzzle at the model default for everything means nobody authored one. */
    const muzzles = new Set(ids.filter((id) => !W[id].def.melee).map((id) => W[id].vm.muzzle.join(',')));
    const guns = ids.filter((id) => !W[id].def.melee).length;
    rec('viewmodel', 'muzzles are authored per weapon', muzzles.size >= guns - 1,
      `${muzzles.size} distinct muzzle nodes over ${guns} firearms`);
  }

  /* The `viewmodel` group has one more check — that a posed weapon survives to
   * the shutter — and it runs LAST, at the bottom of this file. See the note
   * there: `debugPose` freezes the rig and there is no public way back to
   * gameplay, so it cannot run before the groups that need a live rig. */

  /* The automatic measurement runs BEFORE the rest of the arsenal is fired:
  * a Flare Gun leaves a fire burning for 6.5 s and the three explosives leave
  * blast FX and debris behind them, and a frame that has doubled in length
  * cannot resolve a 90 ms fire cycle. Measure the cadence on a quiet world.
  */

  /* ================================================================== */
  /*  4. AUTOMATIC — sustained fire at the advertised rate               */
  /* ================================================================== */
  const autos = ids.filter((id) => W[id].def.modes.includes('auto'));
  rec('auto', 'the arsenal has an automatic weapon', autos.length > 0, autos.join(' '));

  const autoHeld = [];
  for (const id of want('auto') ? autos : []) {
    await toRange(0);
    const a = await page.evaluate(async ({ wid, owner }) => {
      const e = window.__ENGINE__;
      const wp = e.ctx.peek('weapons');
      /* Staging rule 1 (see the header): in the hands that carry it, or the
       * ownership poll swaps this burst to fists half a second in and the
       * numbers below describe a punch. */
      if (owner) wp.setBrother(owner, true);
      wp.setWeaponImmediate(wid);
      wp.refillAll();
      const st = wp.states.get(wid);
      st.mode = 'auto';
      st.modeIndex = Math.max(0, st.def.modes.indexOf('auto'));
      /* Read the advertised numbers off the weapon UNDER TEST, before a round
       * leaves it. Reading `wp.current` after the burst is how "smg: stated
       * 176 rpm" happened — 176 rpm is the fists' swing rate. */
      const stated = {
        rpm: st.def.rpm, magSize: st.def.magSize, spreadMax: st.def.spreadMax,
        eject: st.def.eject, flash: st.def.flashScale,
      };
      window.__WRESET__();
      const f0 = e.ctx.time?.frame ?? 0;

      /**
       * HOLD THE REAL TRIGGER.
       *
       * An earlier version of this check drove `wp._runTrigger` from its own
       * `requestAnimationFrame` chain. That measures a rate the game never
       * produces: the driver's callback runs AFTER the engine's, so the fire
       * decision and the timer decrement that feeds it land on opposite sides
       * of the frame, and every automatic read ~20% slow on a build where the
       * in-game rate was correct. `input.fire` is `down.has('Mouse0')` fed by a
       * real `mousedown`, so dispatching the event puts the trigger on the same
       * code path a player uses, inside `update`, with the engine's own dt.
       */
      const c = document.querySelector('canvas');
      const held = { t0: performance.now() };
      c?.dispatchEvent(new MouseEvent('mousedown', { button: 0, bubbles: true }));
      await new Promise((d) => setTimeout(d, 1600));
      c?.dispatchEvent(new MouseEvent('mouseup', { button: 0, bubbles: true }));
      const t1 = performance.now();
      /* Frame count sampled HERE, not after the settle below — otherwise the
       * settle's frames land in the denominator and the reported frame time is
       * a fiction that makes the tolerance too tight. */
      const frames = (e.ctx.time?.frame ?? 0) - f0;
      await new Promise((d) => { let i = 0; const t = () => (++i >= 20 ? d() : requestAnimationFrame(t)); requestAnimationFrame(t); });

      const r = window.__WREC__;
      const times = r.fire.map((f) => f.t);
      const sims = r.fire.map((f) => f.sim);
      const span = times.length > 1 ? (times[times.length - 1] - times[0]) / 1000 : 0;
      const simSpan = sims.length > 1 ? sims[sims.length - 1] - sims[0] : 0;
      const measuredRpm = times.length > 1 ? ((times.length - 1) / span) * 60 : 0;
      const simRpm = simSpan > 0 ? ((sims.length - 1) / simSpan) * 60 : 0;
      /* Recoil climb: the sum of the pattern's first half vs its second half. */
      const pat = wp.states.get(wid).pattern;
      const n = pat.length / 2;
      let early = 0, late = 0;
      for (let i = 0; i < n; i++) (i < n / 2 ? (early += pat[i * 2]) : (late += pat[i * 2]));
      return {
        id: wid,
        statedRpm: stated.rpm,
        measuredRpm,
        simRpm,
        /* The engine's real frame interval during the burst. A weapon whose
         * cycle is shorter than a frame cannot be measured at all, so the
         * check has to know what it is looking at rather than assume 60 fps. */
        frameMs: frames > 0 ? (t1 - held.t0) / frames : 0,
        frames,
        shots: times.length,
        heldMs: t1 - held.t0,
        magSize: stated.magSize,
        magAfter: st.mag,
        emptied: st.mag === 0,
        spreadAfter: wp.spreadDegrees,
        spreadMax: stated.spreadMax,
        shells: r.shell.length,
        eject: stated.eject,
        flash: stated.flash,
        /* Was the weapon under test still the weapon in hand? Everything above
         * is meaningless if it was not. */
        stillHeld: wp.activeId === wid,
        brother: wp.brotherId,
        climbEarly: early / Math.max(1, n / 2),
        climbLate: late / Math.max(1, n / 2),
      };
    }, { wid: id, owner: OWNER[id] });
    autoHeld.push(a);

    /**
     * THE RATE IS ASSERTED IN SIMULATED TIME. That is the honest denominator
     * rather than a way of letting the code grade its own homework.
     *
     * The defect this check exists for is a QUANTISATION defect: `_fireTimer`
     * was assigned `cycleTime` flat and clamped at zero, so the interval was
     * rounded UP to a whole number of `ctx.time.dt` steps — 0.09 s became six
     * 16.7 ms frames, i.e. 600 rpm out of a gun the table, the HUD and the
     * audio loop all call 667. That error is expressed entirely in the engine's
     * own clock, so `ctx.time.elapsed` measures it exactly, and the fix (bank
     * the remainder) is exactly what makes it go away.
     *
     * Wall-clock rpm measures something else on top: how evenly headless
     * Chromium got round to running frames. On a loaded machine the engine
     * frame moves between 20 and 100 ms inside a single 1.6 s burst, and
     * 100 ms is half a Rivet Gun cycle. Gating on that
     * number produced a check that went red and green on load rather than on
     * the code — which is a worse gate than none, for the reason rule 12 gives.
     *
     * So: SIM time gates, WALL time is printed beside it so a real stall stays
     * visible to a reader, and both are reported every run.
     *
     * THE TOLERANCE IS DERIVED, NOT PICKED. A trigger is serviced at most once
     * per frame, so however good the banking is, N rounds can only land within
     * one frame of N*cycle — the mean interval therefore carries an irreducible
     * error of `frame / ((N-1) * cycle)`. The allowance is that bound plus 4%
     * for spring and event ordering. This tightens by itself as the machine
     * gets quieter (0.053 for the Shop SMG at 60 fps against 0.112 at the
     * 91 ms frames this run saw), so the gate does not go soft when it matters
     * and does not go red because something else on the machine started a
     * build.
     *
     * RATCHET (rule 13): the 4% floor is where this got to. It is the residue
     * of running the burst on a free-running clock at all; the real bar is 0,
     * and reaching it means stepping the engine by hand with a synthetic `now`
     * through `?lockstep=1`, which this probe does not do because the rest of
     * it wants real keyboard and mouse input. Lower the floor when that lands;
     * never raise it to make a run go green.
     */
    const statedMs = 60000 / a.statedRpm;
    const simMs = a.shots > 1 && a.simRpm > 0 ? 60000 / a.simRpm : 1e9;
    const wallMs = a.shots > 1 && a.measuredRpm > 0 ? 60000 / a.measuredRpm : 1e9;
    const err = Math.abs(simMs - statedMs) / statedMs;
    const floor = 0.04;
    const allow = floor + a.frameMs / Math.max(1, (a.shots - 1) * statedMs);
    rec('auto', `${a.id}: sustains fire at its stated rate`,
      a.shots >= 5 && err <= allow,
      `stated ${a.statedRpm.toFixed(0)} rpm (${statedMs.toFixed(1)} ms) · ` +
      `sim ${a.simRpm.toFixed(0)} rpm (${simMs.toFixed(1)} ms, ${(err * 100).toFixed(1)}% off, ` +
      `allow ${(allow * 100).toFixed(1)}%) · wall ${a.measuredRpm.toFixed(0)} rpm ` +
      `(${wallMs.toFixed(1)} ms) · ${a.shots} rounds, engine frame ${a.frameMs.toFixed(1)} ms`);
    rec('auto', `${a.id}: the magazine actually runs out`, a.magAfter < a.magSize,
      `${a.magSize} -> ${a.magAfter} rounds in ${(a.heldMs / 1000).toFixed(1)} s`);
    rec('auto', `${a.id}: the cone opens under sustained fire`, a.spreadAfter > 0,
      `${a.spreadAfter.toFixed(2)} deg of ${a.spreadMax.toFixed(2)} max`);
    rec('auto', `${a.id}: recoil climbs early then settles`, a.climbEarly > a.climbLate,
      `first half ${(a.climbEarly * 1000).toFixed(2)} mrad/shot, second ${(a.climbLate * 1000).toFixed(2)}`);
    if (a.eject === 'brass') {
      rec('auto', `${a.id}: ejects a case per round`, a.shells >= a.shots - 2,
        `${a.shells} cases for ${a.shots} rounds`);
    }
    rec('auto', `${a.id}: has a muzzle flash`, a.flash > 0, `flashScale ${a.flash}`);
  }
  if (want('auto') && autoHeld.length) {
    /* THE STAGING GUARD. Every number above is read off `states.get(wid)` and
     * would still print if the burst had been fired by something else, so the
     * one thing that cannot be inferred from them is asserted directly. */
    const lost = autoHeld.filter((a) => !a.stillHeld);
    rec('auto', 'each automatic was still in hand at the end of its burst',
      lost.length === 0,
      lost.length ? lost.map((a) => `${a.id} lost by ${a.brother}`).join(', ')
        : autoHeld.map((a) => `${a.id}@${a.brother}`).join(' '));
  }

  /* Reload puts the automatic back into service. */
  for (const id of want('auto') ? autos : []) {
    const r = await page.evaluate(async ({ wid, owner }) => {
      const e = window.__ENGINE__;
      const wp = e.ctx.peek('weapons');
      if (owner) wp.setBrother(owner, true);
      wp.setWeaponImmediate(wid);
      wp.refillAll();
      const st = wp.states.get(wid);
      st.mag = 0; st.chambered = false;
      window.__WRESET__();
      const frames = (k) => new Promise((d) => { let i = 0; const t = () => (++i >= k ? d() : requestAnimationFrame(t)); requestAnimationFrame(t); });
      const dry = wp.tryFire();
      const started = wp.reload();
      await frames(Math.ceil((wp.current.reloadEmpty + 0.4) * 62));
      wp._fireTimer = 0;
      const wet = wp.tryFire();
      await frames(6);
      return {
        dry, started, wet, mag: st.mag, held: wp.activeId === wid,
        phases: window.__WREC__.reload.slice(),
      };
    }, { wid: id, owner: OWNER[id] });
    rec('auto', `${id}: an empty gun refuses to fire, reloads, then fires again`,
      r.dry === false && r.started === true && r.wet === true && r.mag > 0 && r.held,
      `dry=${r.dry} reload=${r.started} refire=${r.wet} mag=${r.mag} held=${r.held} ` +
      `phases=[${r.phases.join(',')}]`);
  }

  /* ================================================================== */
  /*  5. FIRE — every weapon actually shoots, in the engine              */
  /* ================================================================== */
  const fireOne = async (id) => {
    await toRange(0);
    return page.evaluate(async ({ wid, owner }) => {
      const e = window.__ENGINE__;
      const wp = e.ctx.peek('weapons');
      const pl = e.ctx.peek('player');
      /* Staging rule 1: the brother who carries it. `setWeaponImmediate` alone
       * bypasses the unlock gate but not the ownership POLL, which puts fists
       * back in his hands within half a second — see the header. */
      if (owner) wp.setBrother(owner, true);
      /* setWeaponImmediate, NOT giveWeapon: the probe must not mutate the
       * brother's loadout, or the per-brother checks later on are testing a
       * loadout this file assembled rather than the one the game ships. */
      wp.setWeaponImmediate(wid);
      wp.refillAll();
      /* Ammunition is read off the STATE OF THE WEAPON UNDER TEST, not off
       * `wp.ammo`, which follows whatever is in hand: every "mag 41 ->
       * Infinity" line in the pre-fix run was `wp.ammo` reporting the fists'
       * bottomless magazine after the poll had swapped the weapon away. */
      const st = wp.states.get(wid);
      const before = {
        mag: st.mag, reserve: st.reserve,
        fired: wp.sim.stats.fired, impacts: wp.sim.stats.impacts,
        dets: wp.sim.stats.detonations,
        swings: wp.melee.stats.swings, rays: wp.melee.stats.rays,
      };
      window.__WRESET__();
      const frames = (k) => new Promise((d) => { let i = 0; const t = () => (++i >= k ? d() : requestAnimationFrame(t)); requestAnimationFrame(t); });
      const d = wp.current;
      const shots = d.melee ? 3 : Math.min(5, Math.max(1, d.magSize || 1));
      for (let i = 0; i < shots; i++) {
        wp._fireTimer = 0;
        if (d.melee) wp.tryMelee(); else wp.tryFire();
        await frames(Math.max(3, Math.ceil(d.cycleTime * 62)));
      }
      await frames(30);
      const r = window.__WREC__;
      const p = pl.position;
      const mz = wp.muzzleWorld();
      return {
        id: wid, melee: !!d.melee, shots, brother: wp.brotherId,
        stillHeld: wp.activeId === wid,
        fireEvents: r.fire.length,
        foreign: r.foreign.length,
        withOrigin: r.fire.filter((f) => f.origin).length,
        originAtWorldOrigin: r.fire.filter((f) => f.origin && Math.hypot(...f.origin) < 1).length,
        originFarFromPlayer: r.fire.filter((f) => f.origin && f.at &&
          Math.hypot(f.origin[0] - f.at[0], f.origin[1] - f.at[1], f.origin[2] - f.at[2]) > 3).length,
        muzzleDist: Math.hypot(mz.x - p.x, mz.y - p.y, mz.z - p.z),
        simFired: wp.sim.stats.fired - before.fired,
        swings: wp.melee.stats.swings - before.swings,
        sweepRays: wp.melee.stats.rays - before.rays,
        impactEvents: r.impact.length,
        /* THE SYSTEM'S OWN STRIKE COUNTERS, for the same attribution reason the
         * recorder filters `weapon:fire`: `bullet:impact` is raised by
         * `physics` for every round in the world, a cop's included, so a check
         * that only counts events can be satisfied by somebody else's gunfight.
         * `sim.stats.impacts` is incremented on the line that calls
         * `physics.fireBullet` for one of OUR projectiles. */
        simImpacts: wp.sim.stats.impacts - before.impacts,
        simDetonations: wp.sim.stats.detonations - before.dets,
        impactDamage: r.impact.reduce((a, b) => a + (b.damage || 0), 0),
        damageEvents: r.damage.length,
        tracers: r.tracer.length,
        shells: r.shell.length,
        explosions: r.explosion.length,
        ammoBefore: before.mag, ammoAfter: st.mag,
        reserveBefore: before.reserve, reserveAfter: st.reserve,
        pellets: d.pellets, eject: d.eject, silent: !!d.silent, explodes: !!d.explodes,
      };
    }, { wid: id, owner: OWNER[id] });
  };

  const fired = [];
  if (want('fire')) for (const id of ids) fired.push(await fireOne(id));

  for (const f of fired) {
    if (f.melee) {
      rec('fire', `${f.id}: swings and raises weapon:fire`, f.fireEvents >= f.shots,
        `${f.fireEvents} swings`);
      rec('fire', `${f.id}: a swing carries NO origin (no gunfire crime)`, f.withOrigin === 0,
        `${f.withOrigin} with origin`);
      /**
       * The CONTACT FRAME resolved and swept, which is the part `weapons` owns.
       *
       * This deliberately does NOT assert an impact. The first version did, and
       * it failed for `fists` (reach 3.0 m) on the run where the probe's clear
       * patch of pavement was genuinely clear — a punch that hits nothing when
       * nothing is in range is correct behaviour, so an impact count here is a
       * check on where the harness parked the player. What must be true is that
       * the swing reached its contact frame and the solver cast its fan; a
       * regression that stops resolving contact shows up as zero rays.
       */
      rec('fire', `${f.id}: the swing resolves a contact frame and sweeps`,
        f.swings >= f.shots && f.sweepRays > 0,
        `${f.swings} contacts, ${f.sweepRays} sweep rays, ${f.impactEvents} impacts`);
      continue;
    }
    rec('fire', `${f.id}: rounds leave the barrel`, f.fireEvents >= f.shots && f.simFired >= f.shots,
      `${f.fireEvents} shots, ${f.simFired} projectiles`);
    rec('fire', `${f.id}: every round leaves the MUZZLE, not the map origin`,
      f.withOrigin === f.fireEvents && f.originAtWorldOrigin === 0 && f.originFarFromPlayer === 0,
      `origins ${f.withOrigin}/${f.fireEvents}, at-origin ${f.originAtWorldOrigin}, ` +
      `off-player ${f.originFarFromPlayer}, muzzle ${f.muzzleDist.toFixed(2)} m from the player`);
    rec('fire', `${f.id}: ammunition decrements`,
      f.ammoAfter < f.ammoBefore || f.reserveAfter < f.reserveBefore,
      `mag ${f.ammoBefore} -> ${f.ammoAfter}, reserve ${f.reserveBefore} -> ${f.reserveAfter}`);
    /**
     * ONE OF OUR ROUNDS STRUCK SOMETHING — asserted on the projectile sim's own
     * strike counter AND on the announcement `physics` makes, because either
     * one alone can be satisfied by the wrong thing: `bullet:impact` is raised
     * for every round in the world (a cop's included), and a counter that
     * moved without an event would be a hit nothing downstream can draw.
     */
    rec('fire', `${f.id}: the shot lands on something`,
      (f.simImpacts > 0 && f.impactEvents > 0) || f.simDetonations > 0,
      `${f.simImpacts} of our rounds struck (${f.impactEvents} bullet:impact, ` +
      `${f.impactDamage.toFixed(0)} dmg), ${f.simDetonations} detonations`);
    if (f.pellets > 1) {
      rec('fire', `${f.id}: fires ${f.pellets} pellets per pull`, f.simFired >= f.shots * f.pellets,
        `${f.simFired} projectiles from ${f.shots} pulls`);
    }
    if (f.eject === 'brass') {
      rec('fire', `${f.id}: ejects brass`, f.shells >= f.shots - 1, `${f.shells} cases`);
    }
    if (f.explodes) {
      rec('fire', `${f.id}: detonates`, f.simDetonations > 0 && f.explosions > 0,
        `${f.simDetonations} detonations, ${f.explosions} explosion events`);
    }
  }
  if (want('fire') && fired.length) {
    /* THE STAGING GUARD, as in `auto`: every line above is read off the weapon
     * under test, so the one thing they cannot show is that it was the weapon
     * the engine was actually firing. */
    const lost = fired.filter((f) => !f.stillHeld);
    rec('fire', 'every weapon was still in hand at the end of its own test',
      lost.length === 0,
      lost.length ? lost.map((f) => `${f.id} lost by ${f.brother}`).join(', ')
        : `${fired.length} weapons, staged on their owners`);
  }

  /* ================================================================== */
  /*  6. SPRINT — no weapon may cost the player his legs                 */
  /* ================================================================== */
  /**
   * MEASURED AS A DIFFERENTIAL, not against an absolute speed.
   *
   * The first version of this check asserted `horizontalSpeed > 0.8 * runSpeed`
   * and failed for all sixteen weapons on a build where sprint demonstrably
   * worked — because a probe-driven run starts from a standstill, crosses real
   * Steel City geometry and is sampled after a fixed number of frames, so the
   * absolute number is about the pavement, not about the weapon. Running the
   * same distance twice per weapon — once with Shift, once without — cancels
   * every one of those and leaves exactly the quantity under test.
   */
  /**
   * SAMPLED EVERY FRAME, AND SCORED ON PEAK SPEED.
   *
   * Two earlier versions of this check were about the pavement rather than the
   * weapon. Sampling `horizontalSpeed` once at the end of a fixed pump reported
   * 0.0 m/s after a clean 17 m sprint that had ended against a wall; scoring on
   * DISTANCE compared two legs whose wall-clock durations differ by a factor of
   * two on a loaded machine, and duly reported a jog outrunning a sprint. Peak
   * speed reached at any point in the leg is immune to both: the character hits
   * his top speed in ~0.35 s and nothing downstream can take it back.
   */
  /**
   * AND IT IS STAGED ON THE OWNER, for the reason in the header — this group
   * more than any other. The pre-fix version force-equipped all sixteen into
   * whichever brother happened to be active, so the ownership poll swapped
   * fourteen of them for FISTS before the legs were run: `carry pose max 0.00`
   * on every line except Aidan's own two-handed pair, which is the signature of
   * a melee weapon (`ready` is 0 for melee by construction) rather than of a
   * weapon that keeps your sprint. This is THE gate for the bug that cost ten
   * of sixteen weapons their Shift key, and it was measuring empty hands.
   */
  const runLeg = async (id, sprint) => {
    await page.evaluate(({ wid, owner }) => {
      const wp = window.__ENGINE__.ctx.peek('weapons');
      if (owner) wp.setBrother(owner, true);
      wp.setWeaponImmediate(wid);
    }, { wid: id, owner: OWNER[id] });
    await toRange(0);
    await pump(30);
    await page.evaluate(() => {
      const pl = window.__ENGINE__.ctx.peek('player');
      const s = { maxV: 0, sprintFrames: 0, aimFrames: 0, maxAds: 0, n: 0 };
      window.__SAMP__ = s;
      window.__SAMPSTOP__ = false;
      const t = () => {
        s.n++;
        s.maxV = Math.max(s.maxV, pl.horizontalSpeed ?? 0);
        if (pl.sprinting) s.sprintFrames++;
        if (pl.movement.aiming) s.aimFrames++;
        s.maxAds = Math.max(s.maxAds, pl.adsAmount);
        if (!window.__SAMPSTOP__) requestAnimationFrame(t);
      };
      requestAnimationFrame(t);
    });
    if (sprint) await page.keyboard.down('ShiftLeft');
    await page.keyboard.down('KeyW');
    await pump(80);
    await page.keyboard.up('KeyW');
    if (sprint) await page.keyboard.up('ShiftLeft');
    const s = await page.evaluate((wid) => {
      window.__SAMPSTOP__ = true;
      const wp = window.__ENGINE__.ctx.peek('weapons');
      window.__SAMP__.held = wp.activeId === wid;
      window.__SAMP__.hold = wp.current?.hold ?? null;
      return window.__SAMP__;
    }, id);
    await pump(10);
    return s;
  };

  for (const id of want('sprint') ? ids : []) {
    const walk = await runLeg(id, false);
    const run = await runLeg(id, true);
    const gain = walk.maxV > 0.5 ? run.maxV / walk.maxV : 0;
    rec('sprint', `${id}: holding it still lets you run`,
      run.sprintFrames > 0 && run.aimFrames === 0 && gain >= 1.25 &&
      run.held === true && walk.held === true,
      `peak ${run.maxV.toFixed(2)} m/s sprinting vs ${walk.maxV.toFixed(2)} jogging ` +
      `(x${gain.toFixed(2)}) · sprint frames ${run.sprintFrames}/${run.n}, ` +
      `aim frames ${run.aimFrames}, carry pose max ${run.maxAds.toFixed(2)}, ` +
      `held=${run.held && walk.held} (${run.hold})`);
  }
  rec('sprint', 'the carry pose stays under the player aim threshold',
    arsenal.readyCap < 0.35, `READY_CAP ${arsenal.readyCap} < 0.35`);

  /* ================================================================== */
  /*  7. BROTHERS — does picking one change the game?                    */
  /* ================================================================== */
  const boys = want('brothers') ? ['carson', 'aidan', 'dylan'] : [];
  const perBoy = [];
  for (const b of boys) {
    await toRange(0);
    perBoy.push(await page.evaluate(async (bid) => {
      const e = window.__ENGINE__;
      const wp = e.ctx.peek('weapons');
      /* The story-complete state: every brother carrying his full six. The
       * fresh-save state is covered by the `progression` group above. */
      wp.unlockEverything();
      wp.setBrother(bid, true);
      const frames = (k) => new Promise((d) => { let i = 0; const t = () => (++i >= k ? d() : requestAnimationFrame(t)); requestAnimationFrame(t); });
      await frames(20);
      /* Read what the brother came up holding BEFORE anything below equips a
       * test weapon — otherwise this reports the probe's choice, not the
       * game's. */
      const cameUpWith = wp.activeId;
      const signature = wp.debugArsenal().signature;

      /* Measure the HANDLING as the engine experiences it: fire a fixed burst
       * from a weapon every brother can hold and read the resulting cone and
       * camera climb, then time a real reload clip. Nothing here reads the
       * multiplier table. */
      /**
       * THE ONE DELIBERATELY ILLEGAL STAGING IN THIS FILE, AND WHY.
       *
       * The Nail Gun is Aidan's. Two of the three would never carry it — the
       * three loadouts are disjoint apart from fists, which is exactly what the
       * checks above assert — so there is NO weapon the game will let all three
       * hold, and no way to vary the hands while holding the weapon constant
       * inside the rules. Varying both instead measures nothing: the pre-fix
       * run "passed" this group with Carson and Dylan holding FISTS, whose
       * 0.28 s draw scaled by their own handling happened to give three
       * distinct numbers, and whose reload clip does not exist (`reload 0s`).
       *
       * So the ownership poll is suspended for the length of the measurement
       * and put back straight after. The poll is enforcement, not physics:
       * nothing it does affects a spread cone, a camera kick or a clip
       * duration, and the enforcement ITSELF is asserted by the `progression`
       * group on a fresh save, which is where it belongs. `heldThrough` below
       * proves the suspension actually held, so if this ever stops working the
       * group goes red instead of quietly measuring fists again.
       */
      const pollWas = wp._unlockPoll;
      wp._unlockPoll = 1e9;
      wp.setWeaponImmediate('nailgun');
      wp.refillAll();
      const st = wp.states.get('nailgun');
      st.mode = 'auto';
      wp._spread = 0;
      wp._shotIndex = 0;
      const simFired0 = wp.sim.stats.fired;
      const pl = e.ctx.peek('player');
      const p0 = pl.viewKick?.pitch ?? 0;
      /**
       * THE BURST GOES OUT IN ONE TICK, AND THE KICK IS SCORED ON ITS PEAK.
       *
       * The first version spaced the rounds three frames apart and asserted
       * only that the three brothers produced three DISTINCT camera climbs.
       * That is not a test: `RecoilAxis` decays between rounds, the decay is a
       * function of the frame time, and two floats off a free-running clock are
       * never equal — so it stayed GREEN under `--nc=brothers`, which sets all
       * three multipliers to 1.0 and should have flattened it completely
       * (measured: 2.266 / 2.377 / 3.021 mrad with the table on, and three
       * different numbers again with the table neutralised).
       *
       * Firing the whole burst inside one tick removes the between-round decay,
       * which is the entire source of that noise: twelve kicks land on the same
       * spring before anything integrates. `spreadDegrees` is then read before
       * the next `update` can bleed it.
       *
       * THE KICK IS SCORED AS A TIME INTEGRAL, not as a peak. `RecoilAxis` is a
       * 9.5 Hz spring at 0.52 damping plus a 0.3 s residual — it snaps most of
       * the way back inside two frames, so a peak sample is worth double or
       * half depending on whether the engine's rAF happened to run before the
       * probe's on that first frame. Measured that way the three came out
       * 17.1 / 10.8 / 25.5 mrad, i.e. Aidan at half of what his multiplier says,
       * purely from sampling phase. The integral of |kick| dt over the whole
       * recovery is the impulse response's area: it is proportional to the total
       * displacement that went in, and it is first-order independent of both
       * the phase and the frame rate.
       *
       * The assertion is then the DIRECTION the design promises rather than
       * mere distinctness: a 130 kg river hand eats the kick and the fast,
       * fragile brother gets thrown by it, so dylan > aidan > carson by a margin
       * noise cannot manufacture.
       */
      for (let i = 0; i < 12; i++) {
        wp._fireTimer = 0;
        wp.tryFire();
      }
      const spread = wp.spreadDegrees;
      let climb = 0;
      for (let i = 0; i < 42; i++) {
        await frames(1);
        climb += Math.abs((pl.viewKick?.pitch ?? 0) - p0) * (e.ctx.time?.dt ?? 1 / 60);
      }

      /* Reload duration, measured off the clip the rig is running. */
      st.mag = 0; st.chambered = false;
      wp.reload();
      const reloadDur = wp.rig.clip?.duration ?? 0;
      /* Draw time, likewise. */
      wp.rig.stopClip();
      wp.rig.play('draw');
      const drawDur = wp.rig.clip?.duration ?? 0;
      wp.rig.stopClip();
      /* Did the test weapon survive the whole measurement? */
      const heldThrough = wp.activeId === 'nailgun';
      const shotsFired = wp.sim.stats.fired - simFired0;

      /* Hand the arsenal back to the rules. */
      wp._unlockPoll = typeof pollWas === 'number' ? pollWas : 0;
      wp.setWeaponImmediate(cameUpWith);

      return {
        id: bid,
        loadout: wp.loadout.slice(),
        signature,
        active: cameUpWith,
        heldThrough,
        shotsFired,
        spread: +spread.toFixed(4),
        climb: +Math.abs(climb).toFixed(6),
        reloadDur: +reloadDur.toFixed(4),
        drawDur: +drawDur.toFixed(4),
        autos: wp.loadout.filter((w) => wp.states.get(w).def.modes.includes('auto')),
        hp: pl.maxHealth ?? null,
        run: pl.movement?.sprintSpeed ?? null,
      };
    }, b));
  }

  const uniq = (f) => new Set(perBoy.map(f)).size;
  if (perBoy.length === 3) {
  rec('brothers', 'the three loadouts are different', uniq((b) => b.loadout.join(',')) === 3,
    perBoy.map((b) => `${b.id}:[${b.loadout.join(' ')}]`).join('  '));
  {
    const overlap = [];
    for (let i = 0; i < 3; i++) {
      for (let j = i + 1; j < 3; j++) {
        const a = perBoy[i].loadout.filter((x) => x !== 'fists');
        const c = new Set(perBoy[j].loadout);
        const shared = a.filter((x) => c.has(x));
        if (shared.length) overlap.push(`${perBoy[i].id}/${perBoy[j].id}: ${shared.join(' ')}`);
      }
    }
    rec('brothers', 'no two brothers share a weapon beyond fists', overlap.length === 0,
      overlap.length ? overlap.join('; ') : 'disjoint');
  }
  rec('brothers', 'each comes up holding a different signature weapon',
    uniq((b) => b.active) === 3 && perBoy.every((b) => b.active === b.signature)
      && perBoy.every((b) => !W[b.active].def.melee),
    perBoy.map((b) => `${b.id}->${b.active}`).join(', '));
  /* THE STAGING GUARD for the three checks below: they only mean anything if
   * all three brothers really were holding the same gun and really fired it. */
  rec('brothers', 'all three measurements were taken with one weapon in hand',
    perBoy.every((b) => b.heldThrough && b.shotsFired >= 6),
    perBoy.map((b) => `${b.id} held=${b.heldThrough} rounds=${b.shotsFired}`).join(', '));
  rec('brothers', 'the same weapon has a different cone in each pair of hands',
    uniq((b) => b.spread) === 3,
    perBoy.map((b) => `${b.id} ${b.spread.toFixed(3)} deg`).join(', '));
  {
    /* Ordered, with a margin, because "three distinct floats" is what a free
     * clock produces on any build — see the note at the burst. */
    const by = (id) => perBoy.find((b) => b.id === id)?.climb ?? 0;
    const M = 1.06;
    rec('brothers', 'the same weapon kicks harder the lighter the man (dylan>aidan>carson)',
      by('dylan') > by('aidan') * M && by('aidan') > by('carson') * M,
      perBoy.map((b) => `${b.id} ${(b.climb * 1000).toFixed(3)} mrad·s`).join(', ') +
      ` · gaps x${(by('dylan') / Math.max(1e-9, by('aidan'))).toFixed(3)} and ` +
      `x${(by('aidan') / Math.max(1e-9, by('carson'))).toFixed(3)} (want > ${M})`);
  }
  rec('brothers', 'reload and draw times differ per brother',
    uniq((b) => b.reloadDur) === 3 && uniq((b) => b.drawDur) === 3,
    perBoy.map((b) => `${b.id} reload ${b.reloadDur}s draw ${b.drawDur}s`).join(', '));
  rec('brothers', 'the automatic weapons are not spread evenly (Dylan is the sprayer)',
    perBoy.find((b) => b.id === 'dylan').autos.length > perBoy.find((b) => b.id === 'carson').autos.length,
    perBoy.map((b) => `${b.id}:${b.autos.length}`).join(' '));
  }

  /* ================================================================== */
  /*  8. VEHICLES — a round has to stop at the car, not behind it        */
  /* ================================================================== */
  if (want('vehicle')) {
    await toRange(0);
    const v = await page.evaluate(async () => {
      const e = window.__ENGINE__;
      const wp = e.ctx.peek('weapons');
      const pl = e.ctx.peek('player');
      const veh = e.ctx.peek('vehicles');
      const frames = (k) => new Promise((d) => { let i = 0; const t = () => (++i >= k ? d() : requestAnimationFrame(t)); requestAnimationFrame(t); });
      if (!veh?.spawn) return { err: 'no vehicles system' };

      /* Park a car 9 m in front of the character, broadside, and shoot it. The
       * distance is short enough that drop and drag are negligible, so the
       * damage arithmetic below is about the scale factor and nothing else. */
      const p = pl.position;
      const yaw = pl.yaw ?? 0;
      const fx = -Math.sin(yaw), fz = -Math.cos(yaw);
      const w = e.ctx.peek('world');
      const tx = p.x + fx * 9, tz = p.z + fz * 9;
      const ty = w?.walkableHeightAt?.(tx, tz) ?? p.y;
      const car = veh.spawn('sedan', { x: tx, y: ty + 0.6, z: tz }, yaw + Math.PI / 2);
      if (!car) return { err: 'spawn failed' };
      await frames(20);

      /**
       * DYLAN, because the Shop SMG is HIS.
       *
       * `_resolveUnlocks` polls the save twice a second and `setLoadout` takes
       * back anything the active brother does not own — so holding Carson's
       * loadout and forcing an SMG into his hands gets exactly one round out
       * before the poll swaps him to fists, which is how an earlier run of this
       * check reported "1 of 8 rounds struck the body" and passed.
       */
      wp.setBrother('dylan', true);
      wp.setWeaponImmediate('smg');
      wp.refillAll();
      const st = wp.states.get('smg');
      st.mode = 'auto';
      await frames(10);
      window.__WRESET__();
      const h0 = car.health;
      const c0 = { ...wp.sim.cars.stats };

      /* Aim at the middle of the body, not at the character's own eyeline. */
      const cam = e.camera;
      cam.lookAt(car.position.x, car.position.y, car.position.z);
      cam.updateMatrixWorld();

      const shots = 8;
      for (let i = 0; i < shots; i++) {
        /* Re-aim before EVERY round: `tryFire` casts from the live camera and
         * the player's rig re-solves it each frame, so a single `lookAt` only
         * survives one shot and the rest went past the car. */
        cam.lookAt(car.position.x, car.position.y + 0.2, car.position.z);
        cam.updateMatrixWorld();
        wp._fireTimer = 0;
        wp.tryFire();
        await frames(5);
      }
      await frames(40);
      const c1 = { ...wp.sim.cars.stats };
      const out = {
        shots,
        health0: h0, health1: car.health,
        lost: h0 - car.health,
        perRound: wp.current.damage,
        carHits: c1.hits - c0.hits,
        carDamage: c1.damage - c0.damage,
        simCarHits: wp.sim.stats.carHits,
        impacts: window.__WREC__.impact.length,
        destroyed: car.destroyed,
      };

      /* Now wreck it and confirm rounds go through a wreck rather than into it. */
      veh.damage(car, 1e6, car.position);
      await frames(10);
      const c2 = { ...wp.sim.cars.stats };
      for (let i = 0; i < 4; i++) { wp._fireTimer = 0; wp.tryFire(); await frames(5); }
      await frames(20);
      out.wreckHits = wp.sim.cars.stats.hits - c2.hits;
      out.wrecked = car.destroyed;
      veh.despawn?.(car);
      return out;
    });

    if (v.err) {
      rec('vehicle', 'a vehicle can be staged for the bullet test', false, v.err);
    } else {
      rec('vehicle', 'bullets hit vehicles at all', v.carHits > 0,
        `${v.carHits} of ${v.shots} rounds struck the body`);
      rec('vehicle', 'the vehicle takes damage', v.lost > 0,
        `health ${v.health0.toFixed(0)} -> ${v.health1.toFixed(0)} (-${v.lost.toFixed(1)})`);
      /**
       * THE SCALE IS CHECKED AGAINST THE CAR'S OWN HEALTH, NOT AGAINST THE
       * NUMBER THIS CODE PASSED TO `vehicles.damage`. Reading back the argument
       * would be rule 12's "compare a number to itself"; reading the health the
       * vehicle system actually ended up with tests the whole path, including
       * anything `vehicles` does to the figure on the way in.
       */
      const want60 = v.carHits * v.perRound * 0.6;
      const ratio = want60 > 0 ? v.lost / want60 : 0;
      rec('vehicle', 'damage lands at the 60% vehicle scale',
        ratio > 0.6 && ratio < 1.45,
        `${v.carHits} hits x ${v.perRound} dmg x 0.6 = ${want60.toFixed(1)} expected, ` +
        `${v.lost.toFixed(1)} observed (x${ratio.toFixed(2)})`);
      rec('vehicle', 'the impact is announced so fx and audio can answer it',
        v.impacts > 0, `${v.impacts} bullet:impact events`);
      rec('vehicle', 'a wrecked vehicle is skipped', v.wrecked && v.wreckHits === 0,
        `destroyed=${v.wrecked}, ${v.wreckHits} further hits`);
    }
  }

  /* ================================================================== */
  /*  9. DRIVE-BY and DRY FIRE                                           */
  /* ================================================================== */
  if (want('driveby')) {
    await toRange(0);
    const stage = await page.evaluate(async () => {
      const e = window.__ENGINE__;
      const pl = e.ctx.peek('player');
      const veh = e.ctx.peek('vehicles');
      const frames = (k) => new Promise((d) => { let i = 0; const t = () => (++i >= k ? d() : requestAnimationFrame(t)); requestAnimationFrame(t); });
      const p = pl.position;
      const w = e.ctx.peek('world');
      const gy = w?.walkableHeightAt?.(p.x + 3, p.z) ?? p.y;
      const car = veh.spawn('sedan', { x: p.x + 3, y: gy + 0.6, z: p.z }, 0);
      if (!car) return { err: 'spawn failed' };
      await frames(15);
      window.__DBCAR__ = car;
      return { staged: true, x: car.position.x, y: car.position.y, z: car.position.z };
    });
    /* Entry is the F key — there is no public `player.enterVehicle`, and
     * synthesising `vehicle:enter` would announce a state `player` never
     * entered. Drive it the way a player does. */
    if (!stage.err) {
      await page.keyboard.down('KeyF');
      await pump(10);
      await page.keyboard.up('KeyF');
      await pump(150);
    }
    const d = stage.err ? stage : await page.evaluate(async () => {
      const e = window.__ENGINE__;
      const wp = e.ctx.peek('weapons');
      const pl = e.ctx.peek('player');
      const veh = e.ctx.peek('vehicles');
      const car = window.__DBCAR__;
      const frames = (k) => new Promise((d) => { let i = 0; const t = () => (++i >= k ? d() : requestAnimationFrame(t)); requestAnimationFrame(t); });
      const inCar = pl.inVehicle === true;

      /* Dylan owns the Shop SMG; see the note in the vehicle group. */
      wp.setBrother('dylan', true);
      wp.setWeaponImmediate('smg');
      wp.refillAll();
      await frames(20);
      const ranged = { holstered: wp._state.holstered, driveBy: wp.driveBy };
      window.__WRESET__();
      wp._fireTimer = 0;
      const fired = wp.tryFire();
      await frames(20);
      const shots = window.__WREC__.fire.length;

      /* Dylan's melee tool is the crowbar — again, one he actually owns. */
      wp.setWeaponImmediate('crowbar');
      await frames(20);
      const melee = { holstered: wp._state.holstered, driveBy: wp.driveBy };

      wp.setWeaponImmediate('smg');
      /* NEVER return a Vehicle. Serialising one drags the whole engine graph
       * over the debug protocol — ARCHITECTURE.md records the same footgun for
       * `police.wanted`, and it fails here as ERR_STRING_TOO_LONG. */
      window.__DBCAR__ = null;
      veh?.despawn?.(car);
      return { inCar, ranged, melee, fired, shots };
    });
    if (!stage.err) {
      /* Out of the car and clear of it, so nothing below inherits the state. */
      await page.keyboard.down('KeyF');
      await pump(10);
      await page.keyboard.up('KeyF');
      await pump(150);
      await page.evaluate((c) => {
        const veh = window.__ENGINE__.ctx.peek('vehicles');
        if (c) veh?.despawn?.(c);
      }, null);
    }
    if (d.err) {
      rec('driveby', 'a vehicle can be staged for the drive-by test', false, d.err);
    } else {
      rec('driveby', 'the player is actually in a vehicle', d.inCar === true, `inVehicle=${d.inCar}`);
      rec('driveby', 'a ranged weapon stays in hand in a car',
        d.ranged.holstered === false && d.ranged.driveBy === true,
        `holstered=${d.ranged.holstered} driveBy=${d.ranged.driveBy}`);
      rec('driveby', 'and it fires', d.fired === true && d.shots > 0,
        `tryFire=${d.fired}, ${d.shots} weapon:fire events`);
      rec('driveby', 'melee still holsters in a car (no swinging a pipe in a cab)',
        d.melee.holstered === true && d.melee.driveBy === false,
        `holstered=${d.melee.holstered} driveBy=${d.melee.driveBy}`);
    }

    const dry = await page.evaluate(async () => {
      const e = window.__ENGINE__;
      const wp = e.ctx.peek('weapons');
      const frames = (k) => new Promise((d) => { let i = 0; const t = () => (++i >= k ? d() : requestAnimationFrame(t)); requestAnimationFrame(t); });
      wp.setBrother('dylan', true);
      wp.setWeaponImmediate('smg');
      const st = wp.states.get('smg');
      st.mag = 0; st.chambered = false; st.reserve = 0;
      await frames(10);
      wp._fireTimer = 0;
      window.__WRESET__();
      const t0 = e.ctx.time.elapsed;
      const fired = wp.tryFire();
      await frames(4);
      const rec1 = window.__WREC__.fire.slice();
      /**
       * Mash the trigger and count the CLICKS, not the return values: a dry
       * pull always returns false, so counting `tryFire() === true` counts
       * nothing and passes on any build. The clicks are timestamped in sim
       * time, so "how many landed inside the lockout" is exact.
       */
      const lockout = wp.debugArsenal().dryLockout;
      while (e.ctx.time.elapsed - t0 < lockout * 0.9) {
        wp.tryFire();
        await frames(1);
      }
      const inWindow = window.__WREC__.fire.filter((f) => f.sim - t0 < lockout * 0.9).length;
      const clicks = window.__WREC__.fire.length;
      const hud = wp.getHudState();
      const lockedFor = wp._fireTimer;
      /* Wait it out, then confirm the click can happen again. */
      await frames(40);
      window.__WRESET__();
      wp.tryFire();
      await frames(4);
      return {
        fired, inWindow, clicks,
        emptyFlag: !!(rec1.length && rec1[0].origin === null),
        hudEmpty: hud.empty, hudDry: hud.dry, hudDryFired: hud.dryFired,
        lockedFor, lockout,
        again: window.__WREC__.fire.length,
        elapsed: e.ctx.time.elapsed - t0,
      };
    });
    rec('dryfire', 'an empty trigger refuses to fire but still announces itself',
      dry.fired === false && dry.clicks >= 1,
      `tryFire=${dry.fired}, ${dry.clicks} click event(s)`);
    rec('dryfire', 'the click carries no origin (no flash, no panic, no crime)',
      dry.emptyFlag === true, `origin=${dry.emptyFlag ? 'null' : 'PRESENT'}`);
    rec('dryfire', `the trigger locks out for ~${dry.lockout}s`,
      dry.inWindow === 1,
      `${dry.inWindow} click(s) landed inside the ${dry.lockout}s window despite ` +
      `continuous pulling (${dry.clicks} total)`);
    rec('dryfire', 'the empty state is published for the HUD',
      dry.hudEmpty === true && dry.hudDry === true,
      `empty=${dry.hudEmpty} dry=${dry.hudDry} dryFired=${dry.hudDryFired}`);
    rec('dryfire', 'the lockout expires and the click can happen again',
      dry.again >= 1, `${dry.again} click(s) after the window`);
  }

  /* ================================================================== */
  /*  10. A POSED WEAPON IS STILL THERE WHEN THE SHUTTER OPENS           */
  /* ================================================================== */
  /**
   * `debugPose(id)` is how `src/dev/shots.js` stages the `ads` and `muzzle`
   * review frames and how the model harness photographs a weapon at all. It
   * force-equips through `setWeaponImmediate`, which bypasses the unlock gate
   * on purpose — but the ownership poll in `update` ran anyway and put
   * `loadout[0]`, i.e. FISTS, back in the character's hands half a second
   * later, while the capture harness waits far longer than that for
   * `streamingIdle` before it presses the shutter.
   *
   * MEASURED before the fix, default brother carson, fresh-save loadout
   * [fists, pipe]: `debugPose('ads')` staged the Nail Gun and 90 frames later
   * the rig held FISTS; `debugPose('smg', {mode:'ads'})` the same. Both weapon
   * review frames were photographs of a pair of empty hands, and no still-frame
   * critic can tell that from a model that failed to build.
   *
   * It reads the RIG's active entry rather than `activeId`, because the rig is
   * the thing that gets photographed. Negative control: `--nc=pose`.
   *
   * IT RUNS LAST ON PURPOSE. `debugPose` sets `rig.debugFrozen` and there is no
   * public way back to gameplay, so every group that needs a live rig — clips
   * advancing, swings resolving, recoil springs stepping — has to be finished
   * before this point.
   */
  if (want('viewmodel')) {
    const posed = await page.evaluate(async () => {
      const wp = window.__ENGINE__.ctx.peek('weapons');
      const frames = (k) => new Promise((d) => { let i = 0; const t = () => (++i >= k ? d() : requestAnimationFrame(t)); requestAnimationFrame(t); });
      const out = [];
      /* Three weapons from three different brothers, so at least two of them
       * are always in the wrong hands whoever is active. */
      for (const id of ['smg', 'harpoon', 'launcher']) {
        wp.debugPose('idle');
        wp.debugPose(id, { mode: 'ads' });
        const staged = wp.rig?.active?.id ?? null;
        await frames(90);
        out.push({ id, staged, after: wp.rig?.active?.id ?? null, brother: wp.brotherId });
      }
      return out;
    });
    const dropped = posed.filter((p) => p.staged !== p.id || p.after !== p.id);
    rec('viewmodel', 'a posed weapon is still in the hand when the shutter opens',
      dropped.length === 0,
      posed.map((p) => `${p.id}: staged ${p.staged} -> ${p.after} (${p.brother})`).join(', '));
  }

  /* ------------------------------------------------------------------ */
  /* How much of somebody else's gunfire the recorder had to throw away.
   * Printed, never gated: a quiet run and a firefight are both legal. */
  const foreign = await page.evaluate(() => window.__WFOREIGN__ ?? 0);
  if (foreign) console.error(`[attribution] discarded ${foreign} foreign weapon:fire event(s) over the run (police and other systems)`);
  rec('boot', 'no page errors during the whole run', errs.length === 0,
    errs.length ? errs.slice(0, 3).join(' | ') : 'clean');
} catch (e) {
  rec('boot', 'probe completed', false, String(e.message).slice(0, 200));
} finally {
  await browser.close();
  server?.kill();
}

/* ---------------------------------------------------------------------- */
const byArea = new Map();
for (const r of results) {
  if (!byArea.has(r.area)) byArea.set(r.area, []);
  byArea.get(r.area).push(r);
}
for (const [area, rs] of byArea) {
  console.log(`\n--- ${area} ---`);
  for (const r of rs) {
    console.log(`  ${r.ok ? 'PASS' : 'FAIL'}  ${r.name.padEnd(62)} ${r.detail}`);
  }
}
const pass = results.filter((r) => r.ok).length;
console.log(`\n${pass}/${results.length} arsenal checks passing`);
if (args.nc) {
  const red = results.filter((r) => !r.ok).map((r) => r.area);
  console.log(`[negative control "${args.nc}"] red groups: ${[...new Set(red)].join(', ') || 'NONE — the control did not fire'}`);
}
console.log(JSON.stringify({
  ok: pass === results.length, pass, total: results.length,
  areas: Object.fromEntries([...byArea].map(([a, rs]) => [a, `${rs.filter((r) => r.ok).length}/${rs.length}`])),
}));
process.exit(args.nc ? 0 : (pass === results.length ? 0 : 1));
