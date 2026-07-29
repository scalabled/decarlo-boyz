#!/usr/bin/env node
/**
 * BRAWL GATE — does melee have any game in it?
 *
 * =============================================================================
 * WHAT IT REFUSES TO DO (hard rule 12)
 * =============================================================================
 * It never reads the combo counter to prove the combo works, never reads
 * `time.scale` to prove hitstop works, and never asks `MeleeReach` what it
 * thinks it mitigated. Every number below is an EMITTED result, measured off a
 * surface this probe does not own:
 *
 *   combo / heavy    `damage:dealt.amount` on the bus, for a target collider
 *                    the PROBE created with `damageScale: 1`, so the number on
 *                    the wire is the swing's own worth and not a hitbox
 *                    multiplier. Three real swings, driven through
 *                    `weapons.attack()` -> `rig.startSwing` -> the contact
 *                    frame -> the ray fan -> `physics.fireBullet`.
 *
 *   hitstop          `ctx.time.elapsed` against `ctx.time.raw`, sampled per
 *                    frame. Both are written by `engine.step`, which this
 *                    change did not touch: `t.dt = rawDt * t.scale`. A stall is
 *                    proven by WORLD TIME FALLING BEHIND WALL TIME by the
 *                    authored factor for the authored duration. The probe never
 *                    looks at the scale itself — that is the code's own input.
 *
 *   parry / block    `player.health.hp`, the number the HUD arc draws, before
 *                    and after a blow the PROBE emits. Armour is zeroed first
 *                    so the pool that moves is the one being asserted on.
 *
 *   i-frames         the same HP reading, across `police:busted`.
 *
 * The incoming blows are emitted BY THE HARNESS in the exact shape
 * `peds.onPedPunch` uses, so the mitigation path is exercised end to end
 * without the probe standing in for any part of it.
 *
 * =============================================================================
 * NEGATIVE CONTROLS
 * =============================================================================
 * A gate nobody has watched fail is not a gate.
 *
 *   node src/fx/meleeprobe.mjs --nc=combo     flatten swingDamage
 *   node src/fx/meleeprobe.mjs --nc=heavy     never latch the heavy commit
 *   node src/fx/meleeprobe.mjs --nc=hitstop   refuse every stall request
 *   node src/fx/meleeprobe.mjs --nc=guard     remove the damage interception
 *   node src/fx/meleeprobe.mjs --nc=all       run each of them in turn
 *   node src/fx/meleeprobe.mjs --nc=off       ALL of them at once
 *
 * Each disables ONE fix in the live page and must turn its own checks red while
 * leaving the others green — a control that reddens everything proves nothing
 * except that the page broke.
 *
 * `--nc=off` is the different one and it is the BEFORE measurement: with every
 * fix neutralised the build behaves as it did before this work, so that run's
 * numbers are what "melee has no game in it" scores on this instrument.
 *
 *   node src/fx/meleeprobe.mjs
 *   node src/fx/meleeprobe.mjs --json
 */

import { chromium } from 'playwright';
import { startServer, stopServer } from '../../tools/lib/server.mjs';

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const m = a.match(/^--([^=]+)(?:=(.*))?$/);
    return m ? [m[1], m[2] ?? true] : [a, true];
  })
);
const JSON_OUT = !!args.json;
const log = (...a) => { if (!JSON_OUT) console.log(...a); };

const NC_ALL = ['combo', 'heavy', 'hitstop', 'guard'];
const NC = args.nc === true ? 'all' : (args.nc ? String(args.nc) : null);
const RUNS = NC === 'all' ? NC_ALL.map((n) => n) : [NC];

/* ========================================================================= */
/*  the page side                                                            */
/* ========================================================================= */

/**
 * Everything below runs INSIDE the page. It is passed as a function to
 * `page.evaluate`, never as a template literal — see hard rule 10's second
 * habitat: a backtick in a comment inside an evaluated string kills the whole
 * harness silently, and this file has plenty of comments.
 */
async function runInPage(nc) {
  const e = window.__ENGINE__;
  const ctx = e.ctx;
  const player = ctx.peek('player');
  const wp = ctx.peek('weapons');
  const phys = ctx.peek('physics');
  const fx = ctx.peek('fx');
  const out = { nc: nc || null, errors: [] };

  const raf = () => new Promise((d) => requestAnimationFrame(() => d()));
  const pump = async (n) => { for (let i = 0; i < n; i++) await raf(); };

  if (!player || !wp || !phys || !fx) {
    out.errors.push('missing subsystem');
    return out;
  }

  /* ---- arm --------------------------------------------------------------- */
  ctx.input.frozen = false;
  ctx.input.enabled = true;
  player.setControlEnabled?.(true);
  const model = player.meleeReach;
  if (!model) { out.errors.push('player.meleeReach missing'); return out; }

  /* Fists: the shortest swing in the set, so a three-beat combo fits inside
   * the 1.1 s window with room to spare. */
  if (typeof wp.setWeaponImmediate === 'function') wp.setWeaponImmediate('fists');
  else wp.setWeapon?.('fists');
  await pump(20);
  out.weapon = wp.current?.id ?? null;
  out.baseDamage = wp.current?.damage ?? 0;

  /* ---- the negative controls -------------------------------------------- */
  /* Each one removes exactly one fix, in the page, after boot. */
  const off = nc === 'off';
  if (off || nc === 'combo') model.swingDamage = (b) => (b || 0);
  if (off || nc === 'heavy') {
    const real = model._beginSwing.bind(model);
    model._beginSwing = function noHeavy() { real(); this.heavy = false; };
  }
  if (off || nc === 'hitstop') fx.hitstop.request = () => false;
  if (off || nc === 'guard') model._onDamage = () => {};

  /* ---- a target the probe owns ------------------------------------------ */
  /* `damageScale: 1` and one part, so the amount on the wire is the swing's
   * worth and not a head/torso/leg multiplier. A pedestrian would also walk
   * out of the arc between swings; this will not. */
  const dummy = { isProbeTarget: true, hits: 0 };
  const col = phys.addCollider({
    shape: 'capsule', radius: 0.34, surface: 'flesh',
    owner: dummy, part: 'torso', damageScale: 1,
  });

  const placeTarget = (dist) => {
    /* Down the CAMERA's forward, which is what the fan is aimed along, from
     * the player's own feet. Nothing here is read out of the melee code. */
    const cam = ctx.camera;
    cam.updateMatrixWorld();
    const fwdX = -cam.matrixWorld.elements[8];
    const fwdZ = -cam.matrixWorld.elements[10];
    const n = Math.hypot(fwdX, fwdZ) || 1;
    const p = player.position;
    const x = p.x + (fwdX / n) * dist;
    const z = p.z + (fwdZ / n) * dist;
    col.setSegment(x, p.y + 0.75, z, x, p.y + 1.55, z, 0.34);
  };

  /* ---- instrumentation --------------------------------------------------- */
  const dealt = [];
  const offDealt = ctx.events.on('damage:dealt', (p) => {
    if (p?.target === dummy) dealt.push(p.amount);
  });
  /* Diagnostic only, so a staging failure says WHERE the ray went rather than
   * just that a swing missed. Nothing is asserted from this. */
  const impacts = [];
  const perSwingEvents = [];
  const diag = [];
  const offImpact = ctx.events.on('bullet:impact', (p) => {
    if (impacts.length < 40) {
      impacts.push([p.surface, +(p.damage ?? 0).toFixed(2), !!p.exit, p.part ?? '-']);
    }
  });

  /* Per-frame samples of the ENGINE's own clock. Nothing else. */
  const clock = [];
  let sampling = false;
  const sample = () => {
    if (!sampling) return;
    const t = ctx.time;
    clock.push([t.raw, t.elapsed]);
    requestAnimationFrame(sample);
  };

  const swing = async (opts = {}) => {
    const dist = opts.dist ?? 1.25;
    const frames = opts.frames ?? 40;
    if (opts.heavy) ctx.input.down.add('ShiftLeft');
    else ctx.input.down.delete('ShiftLeft');
    /* WAIT FOR THE WEAPON, don't race it. `tryMelee` refuses while the swing
     * clock or the cycle timer is live, and a refused attack is not a miss —
     * scoring one as a miss is how a harness manufactures a defect. */
    for (let i = 0; i < 90 && !wp.canFire(); i++) await raf();
    placeTarget(dist);
    const before = dealt.length;
    if (!wp.attack()) return null;
    /* Re-place every frame until the contact frame resolves: the swing commits
     * the body and the facing snaps to the camera, which moves the origin. */
    for (let i = 0; i < frames; i++) {
      placeTarget(dist);
      await raf();
      if (dealt.length > before) break;
    }
    ctx.input.down.delete('ShiftLeft');
    /* How many damage events ONE swing produced, and the first of them. A
     * swing is one blow: anything past the first is the round penetrating the
     * body and coming back for another go. */
    perSwingEvents.push(dealt.length - before);
    diag.push([model.combo, +model.comboT.toFixed(2), model.heavy ? 'H' : 'l',
      +(wp.melee.lastProbe.damage ?? 0).toFixed(2)]);
    return dealt.length > before ? dealt[before] : null;
  };

  /* ===================================================================== */
  /* 1. COMBO — three swings inside the window, then a fourth that wraps    */
  /* ===================================================================== */
  await pump(10);
  const solver0 = model.stats.solverHits;
  const fallback0 = model.stats.fallbackHits;
  const combo = [];
  impacts.length = 0;
  for (let i = 0; i < 4; i++) {
    combo.push(await swing({}));
    await pump(2);
  }
  out.combo = combo;
  out.impacts = impacts.slice(0, 12);
  out.eventsPerSwing = perSwingEvents.slice(0, 4);
  out.diag = diag.slice(0, 4);
  out.solverHits = model.stats.solverHits - solver0;
  out.fallbackHits = model.stats.fallbackHits - fallback0;

  /* ---- and the chain must LAPSE ----------------------------------------- */
  await pump(110);           // > 1.1 s of world time at 60 fps
  out.afterLapse = await swing({});

  /* ===================================================================== */
  /* 2. HEAVY — one swing from a cold chain, with the modifier held         */
  /* ===================================================================== */
  await pump(110);
  out.lightCold = await swing({});
  await pump(110);
  out.heavyCold = await swing({ heavy: true });

  /* ===================================================================== */
  /* 3. HITSTOP — world time against wall time, across a landed swing       */
  /* ===================================================================== */
  await pump(110);
  clock.length = 0;
  sampling = true;
  requestAnimationFrame(sample);
  await pump(8);
  const stalled = await swing({});
  await pump(40);
  sampling = false;
  out.stallDealt = stalled;
  out.clock = clock;

  /* A heavy stalls longer. Same measurement, different authored duration. */
  await pump(140);
  const clock2 = [];
  let sampling2 = false;
  const sample2 = () => {
    if (!sampling2) return;
    const t = ctx.time;
    clock2.push([t.raw, t.elapsed]);
    requestAnimationFrame(sample2);
  };
  sampling2 = true;
  requestAnimationFrame(sample2);
  await pump(8);
  out.stallHeavyDealt = await swing({ heavy: true });
  await pump(40);
  sampling2 = false;
  out.clockHeavy = clock2;

  /* ===================================================================== */
  /* 4. GUARD — parry, late block, and no block at all                      */
  /* ===================================================================== */
  await pump(60);
  const hp = () => player.health.hp;

  /* One pool, so the delta being asserted on is unambiguous. */
  player.health.armour = 0;
  player.health.value = player.health.max;

  /**
   * A punch, in the exact shape `peds.onPedPunch` emits — the harness is the
   * attacker, so nothing in the mitigation path is stood in for.
   */
  /* The attacker applies his OWN damage, exactly as the `damage:dealt`
   * contract says a target must — so the 22 points the parry sends back are
   * measured where they arrive, not where they were computed. */
  const attacker = { isProbeAttacker: true, staggerT: 0, position: { x: 0, y: 0, z: 0 }, hp: 100 };
  const offRiposte = ctx.events.on('damage:dealt', (p) => {
    if (p?.target === attacker) attacker.hp -= p.amount ?? 0;
  });
  const punch = (amount) => {
    const p = player.position;
    const cam = ctx.camera;
    cam.updateMatrixWorld();
    const fx2 = -cam.matrixWorld.elements[8];
    const fz2 = -cam.matrixWorld.elements[10];
    const n = Math.hypot(fx2, fz2) || 1;
    const from = { x: p.x + (fx2 / n) * 1.1, y: p.y + 1.1, z: p.z + (fz2 / n) * 1.1 };
    attacker.position = from;
    const h0 = hp();
    ctx.events.emit('damage:dealt', {
      target: player, amount, headshot: false, killed: false,
      point: { x: p.x, y: p.y + 1.2, z: p.z }, from, source: attacker,
    });
    return h0 - hp();
  };

  const block = (on) => {
    if (on) ctx.input.down.add('Mouse2');
    else ctx.input.down.delete('Mouse2');
  };

  const AMT = 30;

  /* (a) no guard at all */
  player.health.value = player.health.max;
  player.health.armour = 0;
  block(false);
  await pump(3);
  out.costUnguarded = punch(AMT);

  /* (b) inside the parry window — guard raised one frame ago */
  player.health.value = player.health.max;
  player.health.armour = 0;
  block(true);
  await pump(2);
  out.costParry = punch(AMT);
  /* The riposte is fired one tick later, on purpose — see `_fireRiposte`. */
  await pump(4);
  out.attackerHp = attacker.hp;
  out.parryStagger = attacker.staggerT;

  /* (c) outside the parry window — guard held half a second */
  player.health.value = player.health.max;
  player.health.armour = 0;
  await pump(45);
  out.costBlocked = punch(AMT);
  block(false);
  await pump(3);

  /* ===================================================================== */
  /* 5. I-FRAMES — a bust owes you three seconds                            */
  /* ===================================================================== */
  player.health.value = player.health.max;
  player.health.armour = 0;
  ctx.events.emit('police:busted', { position: player.position, officer: null });
  await pump(3);
  out.costBusted = punch(AMT);

  /* ...and only three. `elapsed` is what the timer runs on, so wait on it. */
  const t0 = ctx.time.elapsed;
  while (ctx.time.elapsed - t0 < 3.3) await raf();
  player.health.value = player.health.max;
  player.health.armour = 0;
  out.costAfterGrace = punch(AMT);

  /* ---- the whiff -------------------------------------------------------- */
  /* With the target gone, the swing must resolve to SOMETHING the player can
   * hear: a whiff, or a wall. What it must not be is silence, which is what a
   * missed swing was before. `solidHits` is in there because the probe cannot
   * choose what is standing behind the target on a real street. */
  await pump(60);
  col.enabled = false;
  const whiffBefore = model.stats.whiffs;
  const solidBefore = wp.melee.stats.solidHits;
  await swing({ dist: 30 });
  out.whiffed = model.stats.whiffs > whiffBefore || wp.melee.stats.solidHits > solidBefore;
  col.enabled = true;

  offDealt();
  offImpact();
  offRiposte();
  phys.removeCollider?.(col);
  block(false);
  return out;
}

/* ========================================================================= */
/*  scoring                                                                  */
/* ========================================================================= */

/**
 * Reduce the per-frame clock samples to the one thing that matters: for how
 * long, and by how much, did WORLD time fall behind WALL time.
 *
 * A frame is "stalled" when it advanced world time by less than half the wall
 * time it consumed. That threshold is nowhere near the authored 0.12, so it
 * cannot pass by agreeing with the implementation — it only has to separate
 * "the world ran" from "the world did not".
 */
function analyseClock(samples) {
  const out = { frames: 0, rawSpan: 0, ratio: 1, stallFrames: 0 };
  if (!samples || samples.length < 4) return out;
  let rawSpan = 0;
  let worldSpan = 0;
  let frames = 0;
  for (let i = 1; i < samples.length; i++) {
    const dRaw = samples[i][0] - samples[i - 1][0];
    const dWorld = samples[i][1] - samples[i - 1][1];
    if (dRaw <= 1e-6) continue;
    if (dWorld / dRaw >= 0.5) continue;
    rawSpan += dRaw;
    worldSpan += dWorld;
    frames++;
  }
  out.frames = samples.length;
  out.stallFrames = frames;
  out.rawSpan = rawSpan;
  out.ratio = rawSpan > 0 ? worldSpan / rawSpan : 1;
  return out;
}

function score(r) {
  const checks = [];
  const add = (name, pass, detail) => checks.push({ name, pass: !!pass, detail });
  const near = (a, b, tol) => Number.isFinite(a) && Number.isFinite(b) && Math.abs(a - b) <= tol;

  const c = r.combo ?? [];
  const landed = c.filter((v) => Number.isFinite(v)).length;
  add('all four staged swings connected', landed === 4, `${landed}/4 booked damage`);
  const ev = r.eventsPerSwing ?? [];
  add('one swing deals damage exactly ONCE',
    ev.length === 4 && ev.every((n) => n === 1), `events per swing: ${ev.join(',')}`);

  if (landed === 4) {
    const base = c[0];
    const r2 = c[1] / base;
    const r3 = c[2] / base;
    const r4 = c[3] / base;
    add('combo beat 2 deals 1.25x beat 1', near(r2, 1.25, 0.02), `x${r2.toFixed(3)}`);
    add('combo beat 3 deals 1.50x beat 1', near(r3, 1.5, 0.02), `x${r3.toFixed(3)}`);
    add('combo wraps: beat 4 is back to 1.00x', near(r4, 1.0, 0.02), `x${r4.toFixed(3)}`);
    add('emitted damage escalates strictly', c[0] < c[1] && c[1] < c[2],
      c.map((v) => v.toFixed(1)).join(' -> '));
    add('the chain lapses after its window',
      near(r.afterLapse / base, 1.0, 0.02), `x${(r.afterLapse / base).toFixed(3)}`);
  }

  if (Number.isFinite(r.lightCold) && Number.isFinite(r.heavyCold)) {
    const hv = r.heavyCold / r.lightCold;
    add('heavy deals 1.9x a light of the same beat', near(hv, 1.9, 0.03), `x${hv.toFixed(3)}`);
  } else {
    add('heavy deals 1.9x a light of the same beat', false, 'a staged swing missed');
  }

  const s = analyseClock(r.clock);
  const sh = analyseClock(r.clockHeavy);
  r._stall = s;
  r._stallHeavy = sh;
  /* One frame of slack at each end: a stall can only start and stop on a frame
   * boundary, and a 60 Hz frame is 16.7 ms against an authored 40 ms. */
  add('a light hit stalls the world for ~0.04 s of wall clock',
    s.rawSpan > 0.012 && s.rawSpan < 0.075,
    `${(s.rawSpan * 1000).toFixed(1)} ms over ${s.stallFrames} frames`);
  add('world time runs at ~0.12x through the stall',
    near(s.ratio, 0.12, 0.05), `x${s.ratio.toFixed(3)}`);
  add('a heavy stalls longer than a light',
    sh.rawSpan > s.rawSpan * 1.2,
    `heavy ${(sh.rawSpan * 1000).toFixed(1)} ms vs light ${(s.rawSpan * 1000).toFixed(1)} ms`);
  add('the world is running again afterwards',
    s.stallFrames > 0 && s.stallFrames < s.frames - 2,
    `${s.stallFrames} stalled of ${s.frames} sampled`);

  add('an unguarded blow costs full health',
    near(r.costUnguarded, 30, 0.6), `${(r.costUnguarded ?? NaN).toFixed(2)} hp`);
  add('a parry inside the 0.24 s window costs NOTHING',
    r.costParry === 0, `${(r.costParry ?? NaN).toFixed(2)} hp`);
  add('a parry hurts the attacker for 22',
    near(100 - r.attackerHp, 22, 0.01), `attacker took ${(100 - r.attackerHp).toFixed(1)}`);
  add('a parry staggers the attacker for 1.3 s',
    near(r.parryStagger, 1.3, 0.001), `${r.parryStagger}`);
  add('a LATE block still costs 0.22x, not zero',
    near(r.costBlocked / (r.costUnguarded || 1), 0.22, 0.02),
    `${(r.costBlocked ?? NaN).toFixed(2)} hp = x${(r.costBlocked / (r.costUnguarded || 1)).toFixed(3)}`);

  add('i-frames after a bust cost nothing', r.costBusted === 0, `${(r.costBusted ?? NaN).toFixed(2)} hp`);
  add('i-frames EXPIRE after ~3 s',
    near(r.costAfterGrace, 30, 0.6), `${(r.costAfterGrace ?? NaN).toFixed(2)} hp`);

  add('a swing that met nothing is not silent', !!r.whiffed, String(r.whiffed));
  add('the ray fan found the target itself (no fallback)',
    r.solverHits >= 4 && r.fallbackHits === 0,
    `solver ${r.solverHits} · fallback ${r.fallbackHits} over 4 swings`);

  return checks;
}

/* ========================================================================= */
/*  driver                                                                   */
/* ========================================================================= */

const { port, server } = await startServer({ explicitPort: args.port });
const browser = await chromium.launch({
  headless: true,
  args: ['--use-angle=metal', '--ignore-gpu-blocklist', '--mute-audio', '--disable-frame-rate-limit'],
});

const results = [];
let failed = false;
try {
  for (const nc of RUNS) {
    const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
    const errs = [];
    page.on('pageerror', (ev) => errs.push(String(ev.message).slice(0, 200)));
    await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: 'domcontentloaded', timeout: 90000 });
    await page.waitForFunction('window.__READY__===true', null, { timeout: 150000 });
    await page.evaluate(
      (n) => new Promise((d) => { let i = 0; const t = () => (++i >= n ? d() : requestAnimationFrame(t)); requestAnimationFrame(t); }),
      150
    );

    const raw = await page.evaluate(runInPage, nc);
    raw.pageErrors = errs;
    const checks = score(raw);
    results.push({ nc, raw, checks });
    await page.close();
  }
} finally {
  await browser.close();
  stopServer(server);
}

/* ---- report -------------------------------------------------------------- */
for (const r of results) {
  const pass = r.checks.filter((c) => c.pass).length;
  const total = r.checks.length;
  log('');
  log(r.nc ? `=== NEGATIVE CONTROL: ${r.nc} disabled ===` : '=== BRAWL GATE ===');
  if (r.raw.pageErrors?.length) log(`  page errors: ${r.raw.pageErrors.join(' | ')}`);
  if (r.raw.errors?.length) log(`  setup: ${r.raw.errors.join(' | ')}`);
  log(`  weapon ${r.raw.weapon} · authored damage ${r.raw.baseDamage}`);
  log(`  combo emitted: ${(r.raw.combo ?? []).map((v) => (v == null ? 'MISS' : v.toFixed(2))).join('  ')}`);
  log(`  impacts: ${(r.raw.impacts ?? []).map((i) => i.join('/')).join('  ')}`);
  log(`  diag [combo,comboT,heavy,dmg]: ${(r.raw.diag ?? []).map((i) => i.join('/')).join('  ')}`);
  log(`  stall: light ${(r.raw._stall?.rawSpan * 1000).toFixed(1)} ms @ x${r.raw._stall?.ratio.toFixed(3)}` +
      ` · heavy ${(r.raw._stallHeavy?.rawSpan * 1000).toFixed(1)} ms @ x${r.raw._stallHeavy?.ratio.toFixed(3)}`);
  for (const c of r.checks) log(`  ${c.pass ? 'ok  ' : 'FAIL'} ${c.name}  [${c.detail}]`);
  log(`  ${pass}/${total}`);

  if (r.nc) {
    /* A control passes when it turned checks RED. One that leaves everything
     * green means the fix it removed was never doing anything. */
    if (pass === total) { failed = true; log(`  CONTROL DID NOT FIRE — ${r.nc} is not load-bearing`); }
    else log(`  control fired: ${total - pass} check(s) went red`);
  } else if (pass !== total) {
    failed = true;
  }
}

if (JSON_OUT) console.log(JSON.stringify(results.map((r) => ({ nc: r.nc, checks: r.checks })), null, 2));
log('');
log(failed ? 'FAIL' : 'PASS');
process.exit(failed ? 1 : 0);
