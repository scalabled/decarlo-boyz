#!/usr/bin/env node
/**
 * WARD BAR PROBE — during a protect chapter, does anything on screen tell the
 * player how his brother is doing?
 *
 *   node src/ui/wardprobe.mjs
 *   node src/ui/wardprobe.mjs --port=5173      (reuse a running vite)
 *   node src/ui/wardprobe.mjs --verbose
 *
 * ---------------------------------------------------------------------------
 * WHAT WAS BROKEN
 * ---------------------------------------------------------------------------
 * `protect` is the one chapter whose fail condition is somebody else's health
 * bar. `game.getHudState().ward` has been publishing `{ name, health }` every
 * frame since it was written and NOTHING read it. What the player got instead
 * was "KEEP DYLAN ALIVE", a `kills / goal` counter, and a progress bar that
 * fills with his OWN KILLS — so the bar went UP while Dylan went down, and the
 * first news of the fail condition was the fail.
 *
 * What is required: the bar appears when the chapter starts, its width tracks
 * `hp / maxHp` every frame, and it is hidden when the chapter ends.
 *
 * ---------------------------------------------------------------------------
 * RULE 12 — WHAT THIS MEASURES
 * ---------------------------------------------------------------------------
 * Nothing here calls the drawing code, and nothing here reads
 * `game.getHudState().ward` — the value the bar is drawn FROM. Both sides of
 * every assertion are independent of the widget:
 *
 *   TRUTH   `peds.crewState()` — the `peds` subsystem's own publication of the
 *           same brother's `hp / maxHp`, plus the `crew:hurt` events it emits.
 *           Different owner, different code path, and it is what the ward
 *           record proxies rather than what it is.
 *   DRAWN   `getBoundingClientRect()` on the elements inside `.ow-hud`, i.e.
 *           laid-out CSS pixels on the screen. Not a style string, not a
 *           field, not "did we call `set()`".
 *
 * The headline check does not even name the widget: it SEARCHES every element
 * under the HUD root for one whose rendered width tracks the ward's health
 * across four different HP levels, and reports how many it found. Before the
 * fix that number is 0 — which is the reproduction — and any implementation
 * that genuinely draws the value passes, including one that uses none of the
 * class names in `src/ui/hud.js`.
 *
 * The damage is delivered through the game's own `hurtWard`, i.e. the same
 * call the siege makes, so the bar is being driven by the mechanism that
 * drives it in play rather than by a value poked into the widget.
 *
 * ---------------------------------------------------------------------------
 * NEGATIVE CONTROL
 * ---------------------------------------------------------------------------
 * No `--break` flag. Four reverts, applied for real and measured. Green is
 * 11/11:
 *
 *   main.js  remove `.add(HudSystem)`                     -> 7/11
 *   hud.js   `this.bar.set(ward.name, 1)` (pinned full)   -> 8/11
 *   hud.js   `set(name, M.kills / M.goal)` — THE DEFECT   -> 7/11
 *   hud.js   delete the `else this.bar.hide()`            -> 10/11
 *
 * That last one is why section 3 asks the question it asks. The first version
 * of it checked that the bar was gone after `missions.abort()`, and a build
 * with `hide()` DELETED scored 11/11 — because the objective panel fades out
 * by itself when a chapter ends and takes the row's layout box with it. The
 * check that actually bites is a chapter with no ward and the panel UP.
 */
import { chromium } from 'playwright';
import { startServer } from '../../tools/lib/server.mjs';

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => a.replace(/^--/, '').split('='))
);
const VERBOSE = 'verbose' in args;

const { port, server } = await startServer({ explicitPort: args.port });
const b = await chromium.launch({
  args: ['--use-angle=metal', '--ignore-gpu-blocklist', '--enable-gpu', '--mute-audio'],
});

const results = [];
const rec = (area, name, ok, detail) => results.push({ area, name, ok, detail });
let page;

const pump = (n) =>
  page.evaluate(
    (k) => new Promise((d) => {
      let i = 0;
      const t = () => (++i >= k ? d() : requestAnimationFrame(t));
      requestAnimationFrame(t);
    }),
    n
  );

const inGame = (body, arg) => page.evaluate(new Function('ARG', `
  const e = window.__ENGINE__;
  const game = e.ctx.peek('game');
  const peds = e.ctx.peek('peds');
  const ui = e.ctx.peek('ui');
  ${body}
`), arg);

/**
 * One reading of the world: what `peds` says about the brother, and what every
 * element under the HUD root is actually WIDE.
 *
 * The geometry sweep is the whole point — it is taken without knowing which
 * element is supposed to be the health bar, so it cannot be satisfied by the
 * widget merely existing.
 */
const snap = () =>
  page.evaluate(() => {
    const e = window.__ENGINE__;
    const peds = e.ctx.peek('peds');
    const game = e.ctx.peek('game');
    const ui = e.ctx.peek('ui');

    const crew = peds?.crewState?.() ?? [];
    const M = game?.missions?.M ?? null;
    const wardId = M?.ward?.id ?? null;
    const c = crew.find((x) => x.id === wardId) ?? null;

    /** Composited visibility: display, visibility and EVERY ancestor opacity. */
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

    const root = ui?.root ?? document.querySelector('.ow-hud');
    const widths = {};
    if (root) {
      /**
       * A key that identifies the same NODE across two readings. A running
       * counter does not: the HUD spawns and retires feed rows and markers
       * between samples, so every index after one of them shifts and the
       * comparison silently starts comparing two different elements. The child
       * path from the HUD root is stable for as long as the node is there.
       */
      const path = (n) => {
        const p = [];
        for (let el = n; el && el !== root; el = el.parentElement) {
          p.push([...el.parentElement.children].indexOf(el));
        }
        return p.reverse().join('/');
      };
      for (const n of root.querySelectorAll('*')) {
        const r = n.getBoundingClientRect();
        // Only things a player can see. A zero-height sliver is not a bar.
        if (r.width < 0.5 || r.height < 0.5) continue;
        if (vis(n) < 0.05) continue;
        const cls = n.className && typeof n.className === 'string' ? n.className : n.tagName;
        widths[`${path(n)} ${cls}`] = +r.width.toFixed(3);
      }
    }

    return {
      // TRUTH — peds' own numbers for the same man.
      wardId,
      hp: c ? +c.hp.toFixed(3) : null,
      maxHp: c ? c.maxHp : null,
      up: c ? c.up : null,
      isWard: c ? !!c.ward : null,
      crewBacked: !!M?.ward?.crew,
      // context
      kills: M ? M.kills : null,
      goal: M ? M.goal : null,
      missionActive: !!game?.missions?.active,
      track: M ? M.track : null,
      phase: M ? M.phase : null,
      objText: (root?.querySelector('.ow-obj-text')?.textContent ?? '').trim(),
      // Is the panel the ward row lives in on screen at all? Without this the
      // "it disappears" check can be passed by the PANEL fading out, which is
      // not the same thing and is not this file's fix.
      objVis: vis(root?.querySelector('.ow-obj')),
      objW: +(root?.querySelector('.ow-obj')?.getBoundingClientRect().width ?? 0).toFixed(1),
      // DRAWN
      widths,
      hurtEvents: window.__WARDTAP__?.length ?? 0,
      lastHurt: window.__WARDTAP__?.at?.(-1) ?? null,
    };
  });

/* ======================================================================== */
/* boot + staging                                                           */
/* ======================================================================== */

async function boot() {
  page = await b.newPage({ viewport: { width: 1280, height: 720 } });
  const errs = [];
  page.on('pageerror', (e) => errs.push(String(e.message).slice(0, 200)));
  page.on('console', (m) => { if (m.type() === 'error') errs.push(m.text().slice(0, 200)); });
  await page.goto(`http://127.0.0.1:${port}/?boot=0`, { waitUntil: 'domcontentloaded', timeout: 90000 });
  await page.waitForFunction('window.__READY__===true', null, { timeout: 180000 });
  await pump(80);
  await page.evaluate(() => {
    const e = window.__ENGINE__;
    e.input.enabled = true;
    e.input.frozen = false;
    // An independent record of the damage `peds` says it took. Nothing in the
    // HUD path can write to this.
    window.__WARDTAP__ = [];
    e.ctx.events.on('crew:hurt', (p) => window.__WARDTAP__.push({ id: p.id, hp: p.hp, maxHp: p.maxHp }));
  });
  await pump(20);
  return errs;
}

/** Carson CH 6 "Nobody Touches Family" — `track: 'protect', ward: 'dylan'`. */
async function stageProtect() {
  const idx = await inGame(`
    const boy = game.characters.boy;
    return boy.story.findIndex((c) => c.track === 'protect');`);
  await inGame(`
    game.missions.abort();
    game.hostiles.clear();
    game.heat.clear && game.heat.clear('probe');
    game.economy.char().chapter = ARG;
    game.startMission(ARG);
    game.missions.skipIntro();
    game.missions.forceBegin();
    return true;`, idx);
  await pump(25);
  // Freeze the siege so the only thing that moves the ward's HP is this file.
  await inGame(`
    const M = game.missions.M;
    if (!M) return false;
    for (const h of M.spawnedHostiles) if (h.active) game.hostiles.despawn(h);
    M.waveT = 9999;
    return true;`);
  await pump(6);
  return idx;
}

/** Take the ward to `frac` of full through the game's own damage path. */
async function setWard(frac) {
  await inGame(`
    const M = game.missions.M;
    if (!M || !M.ward) return false;
    for (const h of M.spawnedHostiles) if (h.active) game.hostiles.despawn(h);
    M.waveT = 9999;
    const want = ARG * M.ward.maxHealth;
    const drop = M.ward.health - want;
    if (drop > 0) game.missions.hurtWard(M, drop);
    return true;`, frac);
  await pump(10);
  return snap();
}

/* ======================================================================== */
/* 1 — the bar tracks the ward's health                                     */
/* ======================================================================== */

/**
 * The set of elements whose rendered width is proportional to the ward's HP
 * across every sample. `full` is the reading at 100%; an element qualifies
 * when `width/full` equals `hp/maxHp` at each level, within `tol` of `full`.
 */
function trackers(samples, tol = 0.035) {
  const first = samples[0];
  const keys = Object.keys(first.widths).filter((k) => first.widths[k] > 2);
  return keys.filter((k) => samples.every((s) => {
    const w = s.widths[k];
    if (w === undefined) return false;
    const want = (s.hp / s.maxHp) * first.widths[k];
    return Math.abs(w - want) <= tol * first.widths[k];
  }));
}

async function caseTracking() {
  const A = '1 the bar tracks the ward';
  const idx = await stageProtect();
  const s0 = await snap();

  rec(A, 'the protect chapter is live and the ward is the real brother',
    s0.missionActive && s0.crewBacked && s0.isWard === true && s0.maxHp > 0,
    `chapter ${idx}, ward "${s0.wardId}", crew-backed ${s0.crewBacked}, ` +
    `${s0.hp}/${s0.maxHp} hp, objective "${s0.objText}"`);

  // Four levels, none of them a round fraction of anything the HUD already
  // draws, taken on the way DOWN as a siege would take them.
  const levels = [1, 0.72, 0.41, 0.15];
  const samples = [s0];
  for (const f of levels.slice(1)) samples.push(await setWard(f));

  const hit = trackers(samples);
  rec(A, 'something on screen is WIDE in proportion to the ward\'s health',
    hit.length > 0,
    `${hit.length} element(s) tracked ${samples.map((s) => (s.hp / s.maxHp * 100).toFixed(0) + '%').join(' -> ')}` +
    (hit.length ? `: ${hit.join(', ')}` : ' — NOTHING ON SCREEN DRAWS THE WARD\'S HP'));

  // ...and it is the health bar, not something that happens to correlate.
  const named = hit.filter((k) => /ow-ward-fill/.test(k));
  rec(A, 'the tracking element is the ward health bar',
    named.length > 0,
    named.length ? named.join(', ') : `tracked: ${hit.join(', ') || 'none'}`);

  // The defect exactly: the bar the player HAD was filling with his own kills.
  const killFrac = samples.map((s) => (s.goal ? s.kills / s.goal : 0));
  const hpFrac = samples.map((s) => s.hp / s.maxHp);
  rec(A, 'and it is the ward\'s health, not the kill counter',
    killFrac.every((k) => k === killFrac[0]) && new Set(hpFrac.map((h) => h.toFixed(2))).size === samples.length,
    `kills ${samples.map((s) => `${s.kills}/${s.goal}`).join(' ')} · ` +
    `ward ${hpFrac.map((h) => (h * 100).toFixed(0) + '%').join(' ')}`);

  // Cross-check the truth source against the events `peds` emitted, so a
  // `crewState()` that had gone stale could not carry the whole file.
  const last = samples.at(-1);
  rec(A, 'peds agrees with itself: crewState matches the crew:hurt it emitted',
    last.hurtEvents >= 3 && last.lastHurt && last.lastHurt.id === last.wardId &&
    Math.abs(last.lastHurt.hp - last.hp) < 0.5,
    `${last.hurtEvents} crew:hurt events, last says ${last.lastHurt?.hp?.toFixed(1)} hp, ` +
    `crewState says ${last.hp}`);

  if (VERBOSE) {
    for (const s of samples) {
      const w = named[0] ? s.widths[named[0]] : null;
      console.log(`   ${(s.hp / s.maxHp * 100).toFixed(1).padStart(5)}% hp -> ${w?.toFixed(2) ?? '—'} px`);
    }
  }
  return samples;
}

/* ======================================================================== */
/* 2 — the range is honest at both ends                                     */
/* ======================================================================== */

/** Put him back on his feet at full HP, through the crew's own revive. */
async function healWard() {
  await inGame(`
    const M = game.missions.M;
    if (!M || !M.ward) return false;
    if (peds.reviveCrew && M.ward.id) peds.reviveCrew(M.ward.id);
    M.ward.health = M.ward.maxHealth;
    return true;`);
  await pump(10);
  return snap();
}

async function caseRange() {
  const A = '2 the ends of the range';
  // Section 1 left him at 15%; damage is one-way, so heal before measuring
  // what "full" looks like.
  const full = await healWard();
  const named = Object.keys(full.widths).filter((k) => /ow-ward-fill/.test(k));
  const wide = named[0] ?? null;
  const fullW = wide ? full.widths[wide] : 0;

  // 3% of full HP: essentially empty, but the chapter has not failed yet.
  const low = await setWard(0.03);
  const lowW = wide ? (low.widths[wide] ?? 0) : 0;
  rec(A, 'a nearly-dead ward draws a nearly-empty bar',
    fullW > 4 && lowW <= fullW * 0.09 && low.missionActive,
    `full ${fullW.toFixed(1)} px at ${(full.hp / full.maxHp * 100).toFixed(0)}% -> ` +
    `${lowW.toFixed(1)} px at ${(low.hp / low.maxHp * 100).toFixed(0)}%`);

  // Healing must move it back UP, or a bar that only ever shrinks would pass.
  const back = await healWard();
  const backW = wide ? (back.widths[wide] ?? 0) : 0;
  rec(A, 'and it goes back up when he does',
    backW >= fullW * 0.9 && back.hp >= back.maxHp * 0.9,
    `${lowW.toFixed(1)} px -> ${backW.toFixed(1)} px at ${(back.hp / back.maxHp * 100).toFixed(0)}% hp`);
  return wide;
}

/* ======================================================================== */
/* 3 — it is there for the duration, and only for the duration              */
/* ======================================================================== */

async function caseLifetime(wide) {
  const A = '3 lifetime';
  const during = await snap();
  const onDuring = wide ? (during.widths[wide] ?? 0) : 0;
  rec(A, 'it is on screen while the chapter runs',
    onDuring > 4 && during.missionActive,
    `${onDuring.toFixed(1)} px, chapter ${during.phase}`);

  // THE CHECK THAT HAD TO BE REWRITTEN. "It goes away when the chapter ends"
  // was first asserted after an abort — and it passed even with `hide()`
  // deleted, because the objective PANEL fades out on its own and takes the
  // row's layout box with it. So the real question is asked instead: with the
  // panel up and a chapter running that has no ward, is the row gone?
  await inGame(`
    game.missions.abort();
    game.hostiles.clear();
    game.economy.char().chapter = 0;
    game.startMission(0); game.missions.skipIntro(); game.missions.forceBegin();
    return true;`);
  await pump(30);
  const other = await snap();
  const onOther = wide ? (other.widths[wide] ?? 0) : 0;
  rec(A, 'a chapter with no ward shows the objective panel and no health bar',
    onOther === 0 && other.missionActive && other.track !== 'protect' &&
    other.objVis > 0.5 && other.objW > 4,
    `${other.track} chapter: panel ${other.objW} px at opacity ${other.objVis} ("${other.objText}"), ` +
    `ward bar ${onOther.toFixed(1)} px`);

  await inGame(`game.missions.abort(); game.hostiles.clear(); return true;`);
  await pump(30);
  const idle = await snap();
  rec(A, 'free roam never shows it',
    (wide ? (idle.widths[wide] ?? 0) : 0) === 0 && !idle.missionActive,
    `${(wide ? (idle.widths[wide] ?? 0) : 0).toFixed(1)} px in free roam`);
}

/* ======================================================================== */

let code = 0;
try {
  const errs = await boot();
  await caseTracking();
  const wide = await caseRange();
  await caseLifetime(wide);
  rec('0 boot', 'the page booted without a script error', errs.length === 0,
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
  console.log(`\nward bar: ${results.length - failed}/${results.length}`);
  code = failed ? 1 : 0;
} catch (err) {
  console.error('probe threw:', err);
  code = 2;
} finally {
  await b.close();
  server?.kill();
}
process.exit(code);
