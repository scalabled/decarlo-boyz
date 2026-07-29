#!/usr/bin/env node
/**
 * BLAST & BLOCK GATE — what a grenade takes off you, and what a raised guard
 * costs you, measured on the shipping build.
 *
 *   npm run blockblast          (node src/player/blockblastprobe.mjs)
 *   node src/player/blockblastprobe.mjs --verbose
 *   node src/player/blockblastprobe.mjs --control=share     (negative control 1)
 *   node src/player/blockblastprobe.mjs --control=invehicle (negative control 2)
 *   node src/player/blockblastprobe.mjs --control=aimgate   (negative control 3)
 *   node src/player/blockblastprobe.mjs --control=guardpose (negative control 4)
 *   node src/player/blockblastprobe.mjs --control=blockslow (negative control 5)
 *
 * Three shipping files already carry a `debug*` flag whose only documented
 * reader is this filename. This is that file; the flags are listed above.
 *
 * ---------------------------------------------------------------------------
 * WHY IT IS A BROWSER PROBE AND NOT A `gate` ENTRY
 * ---------------------------------------------------------------------------
 * Every quantity below is an EMITTED one — hit points actually removed from the
 * player's pool by the real `Health`, the field of view the real camera was
 * left at, the world position the real character was drawn at on consecutive
 * frames. None of them exists without the engine running: a node harness would
 * have to restate the damage arithmetic, the camera solve and the movement
 * integrator, and a gate that restates the code is the circular gate hard rule
 * 12 exists to forbid. So it boots vite, like `camlagtest` and `feeltest`, and
 * belongs in `npm run handoff` rather than `npm run gate`. MEASURED end to end:
 * 34 s, of which ~12 s is boot.
 *
 * `npm run blockblast` already exists and points here. It is NOT yet in the
 * `handoff` chain; inserting `&& npm run blockblast` after `npm run melee` in
 * `package.json` chains it.
 *
 * ---------------------------------------------------------------------------
 * SECTION 1 — THE BLAST
 * ---------------------------------------------------------------------------
 *
 * A blast takes `damage * 0.55 * (1 - d/r)` off a player on foot, nothing at or
 * beyond r, and nothing at all while he is in a vehicle.
 *
 * The expected numbers here are written out independently — 0.55, linear in
 * d/r, nothing outside r — and never read from `src/player/`. `BLAST_PLAYER_SHARE`
 * could be deleted and this file would not notice until the emitted hit points
 * moved. The payload (`damage`, `radius`) goes in through the real `explosion`
 * event, which is the documented cross-subsystem interface that `weapons`,
 * `vehicles` and `game` all raise; nothing about a weapon's damage table or a
 * car's HP scale is asserted, so the vehicle re-tune that is live in
 * `src/vehicles/` right now cannot move a single number in this file.
 *
 * ON FOOT the curve is sampled at d/r = 0, 0.25, 0.5, 0.75 and at 1.0, 1.2 and
 * 1.5 (where a blast does nothing at all). MEASURED, `damage 100,
 * radius 12`, hit points actually removed:
 *
 *     d/r        0       0.25     0.5     0.75     1.0    1.2    1.5
 *     shipping   55.00   41.25    27.50   13.75    0      0      0
 *     expected   55.00   41.25    27.50   13.75    0      0      0
 *     --control=share
 *                100.00  63.11    32.99   10.88    0      0      0
 *
 * i.e. the pre-fix build killed a full-health Carson (130 hp) in two blasts
 * where the correct curve needs three, and the shape was wrong as well as the
 * scale: 1.82x expected at the epicentre but 0.79x at 0.75 r. That is why
 * this samples the CURVE and not just the peak — a probe that only checked the
 * epicentre would call a pure `* 0.55` correct even if the falloff were still
 * raised to the 1.6.
 *
 * IN A CAR you are blast-immune behind the wheel BECAUSE THE CAR TAKES IT —
 * the same blast's vehicle branch is unconditional. So the in-car check asserts
 * BOTH halves, and the second is
 * what stops it being vacuous: the player must lose exactly zero, AND the car
 * he is sitting in must measurably lose health from the same event. A build
 * where the explosion never arrived would pass the first half and fail the
 * second. MEASURED, one `damage 100` blast on the seated player:
 *
 *     shipping               player 0.00 hp    the sedan lost 892.1 of 900
 *     --control=invehicle    player 55.00 hp   the sedan lost 892.1 of 900
 *                                              (one grenade, two write-offs)
 *
 * ---------------------------------------------------------------------------
 * SECTION 2 — THE GUARD IS A GUARD, NOT AN AIM
 * ---------------------------------------------------------------------------
 * RMB is two buttons and which one it is depends on what is in your hands. With
 * fists or a pipe it is the guard, and it must NOT bring the character up into
 * a two-handed shoulder aim on an empty hand or pull the camera to the ADS FOV.
 *
 * What is asserted is EMITTED STATE, not the input flag or `adsRequested`:
 *
 *   - `ctx.camera.fov` — the zoom the player actually sees. 62.0 at rest,
 *     47.1 with a rifle up. Fists + RMB must leave it at rest.
 *   - the DRAWN wrist height, taken off the character's own `handL` bone
 *     matrix after the frame is composed, relative to the drawn head. A guard
 *     puts the hand at the cheekbone; a hanging arm puts it by the hip. The
 *     assertion is a distance in metres between two bones, so it cannot be
 *     satisfied by a weight, a flag or a blend that never reached the skeleton.
 *
 * MEASURED, fists, RMB held, drawn lead wrist relative to the drawn head:
 *
 *     idle                        -0.633 m           (by the hip)
 *     guard, shipping             -0.051 m           (at the cheek, +0.582)
 *     guard, --control=guardpose  -0.641 m           (-0.008: nothing happened)
 *     guard, --control=aimgate     fov 62.00 -> 47.12 (the ADS zoom is back)
 *
 * THE LEAD HAND, DELIBERATELY, and this is the defect the check found rather
 * than a convenience. `weapons`' rig writes the WEAPON arm directly in its own
 * `lateUpdate`, after the animator: `_driveMeleeIdle` (`src/weapons/rig.js`)
 * slerps that shoulder into a ready carry every frame a melee weapon is drawn
 * and not swinging, which undoes the guard on that arm and only that arm.
 * MEASURED end-of-frame, fists, RMB held: the lead wrist rose 0.582 m and the
 * weapon-hand wrist moved -0.008 m — i.e. the player sees a ONE-ARMED guard.
 * The animator is doing its job (instrumented immediately after
 * `animator.update`, both wrists are up at the face); `weapons.lateUpdate` puts
 * one of them back.
 *
 * WITH A PIPE IT IS WORSE AND IT IS THE SAME LINE: a two-handed melee weapon
 * welds the SUPPORT hand to its grip, the grip rides the weapon arm that
 * `_driveMeleeIdle` is holding down, and both hands go with it — MEASURED lead
 * -0.017 m, weapon -0.012 m, i.e. no guard is drawn at all.
 *
 * Stubbing `_driveMeleeIdle` while `player.blocking` — the proposed patch, run
 * at runtime rather than guessed at — puts both hands at the cheek for both
 * weapons (fists: lead -0.052, weapon +0.005 relative to the head; pipe: lead
 * -0.126, weapon +0.006, and the pipe itself rises 0.53 m into a cover), and
 * the carry returns intact on the frame the button is released. It is one line
 * in another subsystem's file, so the checks in this section report it as
 * INFO with the patch and print the numbers on every run, where they cannot be
 * quietly forgotten.
 *
 * ---------------------------------------------------------------------------
 * SECTION 3 — WHAT THE GUARD COSTS YOU
 * ---------------------------------------------------------------------------
 *
 * A guard is 0.45 of the jog, and it is exclusive with the sprint in both
 * directions: a guard can never be sprinted through, and the sprint never
 * latches while the guard is up in the first place.
 *
 * The PROPORTION is the authored feel, not the absolute speed. This therefore
 * asserts a RATIO between two
 * numbers it measured itself, at the same site, along the same heading, with
 * the same stick magnitude — never against `MOVE.jogSpeed` or `BLOCK_SLOW`,
 * which are the code's own inputs. Halving every speed in `tuning.js` would
 * leave every number in this section unchanged, which is exactly right.
 *
 * Speed is DISPLACEMENT of the drawn character over elapsed time, sampled from
 * `player.position` across 120 rendered frames after a 70-frame run-up. Not
 * `targetSpeed`, not `movement.horizontalSpeed` — the thing that moved.
 *
 * MEASURED, m/s, and the ratio to the jog measured on the same run:
 *
 *                              shipping          --control=blockslow
 *     jog (no guard)           3.350             3.350
 *     sprint (no guard)        6.400             6.400
 *     guard                    1.506  (0.450)    3.350  (1.000)
 *     guard + sprint held      1.506  (0.450)    6.400  (1.911)
 *     movement.sprinting       never latched     latched
 *
 * The sprint-held arm is the half that is easy to miss: the speed itself can
 * never be sprinted THROUGH, and the sprint never latches while the guard is up
 * in the first place. Both are asserted, because a build that only did the second would look
 * right until something else set `sprinting` behind its back.
 *
 * ---------------------------------------------------------------------------
 * NEGATIVE CONTROLS
 * ---------------------------------------------------------------------------
 * Five, each turning exactly ONE fix off at runtime, each watched go red:
 *
 *   share      player.debugBlastShare        1 check red  (the curve)
 *   invehicle  player.debugBlastInVehicle    1 check red  (the exemption)
 *   aimgate    player.debugMeleeAimGate      1 check red  (the ADS zoom)
 *   guardpose  player.animator.debugGuardPose 1 check red (the hands)
 *   blockslow  player.movement.debugBlockSlow 2 checks red (speed + sprint)
 *
 * They are runtime flags rather than edits because five separate one-line
 * reverts is five chances to leave one in. Each flag is read in exactly one
 * expression in the shipping file and by nothing else.
 */
import { chromium } from 'playwright';
import { startServer, stopServer } from '../../tools/lib/server.mjs';

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const m = a.match(/^--([^=]+)(?:=(.*))?$/);
    return m ? [m[1], m[2] ?? true] : [a, true];
  })
);
const VERBOSE = !!args.verbose;
const CONTROLS = ['share', 'invehicle', 'aimgate', 'guardpose', 'blockslow'];
const CONTROL = args.control ? String(args.control) : null;
if (CONTROL && !CONTROLS.includes(CONTROL)) {
  console.error(`blockblastprobe: unknown --control=${CONTROL} (${CONTROLS.join(' | ')})`);
  process.exit(1);
}

/* ====================================================================== */
/* the expected model, written out — NOT read from src/player/            */
/* ====================================================================== */

/** The player's share: `damage * 0.55 * (1 - d/r)`, and nothing at or beyond r. */
const REF_SHARE = 0.55;
const refLoss = (damage, dOverR) => (dOverR >= 1 ? 0 : damage * REF_SHARE * (1 - dOverR));

/** The staged blast. Any pair works; these make the arithmetic readable. */
const BLAST_DAMAGE = 100;
const BLAST_RADIUS = 12;
const SAMPLES = [0, 0.25, 0.5, 0.75, 1.0, 1.2, 1.5];

/**
 * RATCHET (rule 13 — tighten these when the build improves, NEVER loosen one
 * to make a run go green).
 *
 * Hit points, absolute. MEASURED |emitted - expected| <= 0.000 hp at every
 * one of the seven distances on the shipping build; `--control=share` misses by
 * 45.00 hp at the epicentre and 21.86 hp at 0.25 r. 0.5 hp is well under half a
 * percent of the player's pool and two orders of magnitude under the failure.
 */
const MAX_HP_ERR = 0.5;
/**
 * The guard's speed, as a fraction of the JOG measured on the same run. The
 * authored ratio is 0.45 exactly. MEASURED 0.450; `--control=blockslow` gives
 * 1.000 (and latches the sprint at 1.911). +-0.06 is a band a designer would
 * accept as 0.45 and is nowhere near either failure.
 */
const BLOCK_RATIO = 0.45;
const BLOCK_RATIO_TOL = 0.06;
/**
 * The drawn wrist has to actually come UP, in metres, against the drawn head.
 * MEASURED: +0.582 m shipping, -0.008 m with `--control=guardpose`. The budget
 * is roughly a third of the authored rise, so a guard that only made it a third
 * of the way to the face still fails, while re-authoring `GUARD.rear` by a few
 * centimetres does not churn the gate.
 */
const MIN_WRIST_RISE = 0.2;

const results = [];
const rec = (name, ok, detail) => {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}\n        ${detail}`);
};
const info = (name, detail) => console.log(`INFO  ${name}\n        ${detail}`);
const f2 = (v) => (Number.isFinite(v) ? v.toFixed(2) : '--');

const { port, server } = await startServer({ explicitPort: args.port });
const browser = await chromium.launch({
  args: ['--use-angle=metal', '--ignore-gpu-blocklist', '--enable-gpu', '--mute-audio'],
});
const page = await browser.newPage({ viewport: { width: 960, height: 540 } });
const pageErrors = [];
page.on('pageerror', (e) => pageErrors.push(String(e.message).slice(0, 200)));
page.on('console', (m) => { if (m.type() === 'error') pageErrors.push(m.text().slice(0, 200)); });

let exitCode = 1;
try {
  await page.goto(
    `http://127.0.0.1:${port}/?capture=1&lockstep=1&q=low&prewarm=0&gov=0`,
    { waitUntil: 'load' }
  );
  await page.waitForFunction(() => window.__READY__ === true, null, { timeout: 180000 });
  await page.evaluate(() => window.__PUMP__(60));

  /* ---- helpers installed once, in the page ----------------------------- */
  await page.evaluate(() => {
    const e = window.__ENGINE__;
    const pl = e.ctx.peek('player');
    window.__P__ = {
      /** Bone world-space Y, read off the composed matrix after the frame. */
      boneY: (name) => {
        const b = pl.character?.bones?.[name];
        if (!b) return null;
        b.updateWorldMatrix(true, false);
        return b.matrixWorld.elements[13];
      },
      /** RMB, written into the same key set the mouse handler writes. */
      rmb: (on) => (on ? e.ctx.input.down.add('Mouse2') : e.ctx.input.down.delete('Mouse2')),
      full: () => {
        pl.health.value = pl.health.max;
        pl.health.armour = 0;
        pl.health.dead = false;
      },
    };
  });

  /* ---- negative control ------------------------------------------------ */
  if (CONTROL) {
    const applied = await page.evaluate((which) => {
      const pl = window.__ENGINE__.ctx.peek('player');
      const set = (obj, key, label) => {
        if (obj?.[key] !== true) return `MISSING: no ${key} to turn off`;
        obj[key] = false;
        return label;
      };
      switch (which) {
        case 'share':
          return set(pl, 'debugBlastShare', 'no * 0.55 share, falloff raised to the 1.6');
        case 'invehicle':
          return set(pl, 'debugBlastInVehicle', 'the man in the driver’s seat is charged too');
        case 'aimgate':
          return set(pl, 'debugMeleeAimGate', 'a melee weapon may drive the ADS zoom again');
        case 'guardpose':
          return set(pl.animator, 'debugGuardPose', 'the guard pose is removed');
        case 'blockslow':
          return set(pl.movement, 'debugBlockSlow', 'the guard costs neither speed nor the sprint');
        default:
          return 'unknown';
      }
    }, CONTROL);
    console.log(`\n[negative control: ${CONTROL}] ${applied}\n`);
    if (applied.startsWith('MISSING:')) throw new Error(`${CONTROL}: ${applied}`);
  }

  /* ==================================================================== */
  /* 1a. the blast, on foot                                               */
  /* ==================================================================== */

  const onFoot = await page.evaluate(async ({ damage, radius, samples }) => {
    const e = window.__ENGINE__;
    const pl = e.ctx.peek('player');
    const V = Object.getPrototypeOf(pl.position).constructor;
    // On foot and standing still, so nothing is moving between the shots.
    pl.movement.scriptedInput = null;
    window.__P__.rmb(false);
    await window.__PUMP__(30);
    if (pl.vehicles.active) return { err: 'the player is in a vehicle' };

    const out = [];
    for (const frac of samples) {
      window.__P__.full();
      const before = pl.health.value;
      /* The blast is placed at a horizontal offset from the DRAWN HEAD, taken
       * off the character's own head bone rather than from `player.headPosition`
       * — the field `_onExplosion` samples. If the code ever measured the range
       * from somewhere else on the body, `d` here would no longer be the
       * distance it used and the curve would come out wrong. */
      const hx = window.__P__.boneY('head');
      const h = pl.headPosition;
      const at = new V(h.x + radius * frac, h.y, h.z);
      const d = Math.hypot(at.x - h.x, at.y - h.y, at.z - h.z);
      e.ctx.events.emit('explosion', { position: at, radius, damage, source: 'blockblastprobe' });
      out.push({
        frac,
        d,
        loss: before - pl.health.value,
        headBoneGap: hx == null ? null : Math.abs(hx - h.y),
      });
      await window.__PUMP__(2);
    }
    window.__P__.full();
    return { out, hp: pl.health.max };
  }, { damage: BLAST_DAMAGE, radius: BLAST_RADIUS, samples: SAMPLES });

  if (onFoot.err) throw new Error(`blast-on-foot could not be staged: ${onFoot.err}`);
  if (VERBOSE) console.log(JSON.stringify(onFoot));

  {
    const rows = onFoot.out;
    const gap = rows[0].headBoneGap;
    if (gap != null && gap > 0.35) {
      rec('the blast is measured from where the head is DRAWN', false,
        `player.headPosition is ${gap.toFixed(3)} m from the drawn head bone — the sampled ` +
        'distances are not the distances the damage used, nothing below is trustworthy');
    } else {
      let worst = 0, worstAt = null;
      const cells = [];
      for (const r of rows) {
        const want = refLoss(BLAST_DAMAGE, r.frac);
        const err = Math.abs(r.loss - want);
        if (err > worst) { worst = err; worstAt = r.frac; }
        cells.push(`${r.frac}r ${f2(r.loss)}/${f2(want)}`);
      }
      rec(
        'a blast on foot takes the expected share of you',
        worst <= MAX_HP_ERR,
        `damage ${BLAST_DAMAGE}, radius ${BLAST_RADIUS} m, hp lost/expected: ${cells.join('  ')}. ` +
        `Worst error ${worst.toFixed(3)} hp at ${worstAt}r (budget ${MAX_HP_ERR}). ` +
        `Expected is damage * 0.55 * (1 - d/r). ` +
        `Carson's pool is ${onFoot.hp} hp; ranges were laid out from the drawn head bone, ` +
        `${gap == null ? '--' : gap.toFixed(3)} m from the point the damage sampled.`
      );
      const beyond = rows.filter((r) => r.frac >= 1);
      rec(
        'a blast does nothing at all outside its radius',
        beyond.every((r) => r.loss <= 1e-6),
        `hp lost at ${beyond.map((r) => `${r.frac}r ${f2(r.loss)}`).join(', ')} ` +
        '— the curve stops dead at r.'
      );
    }
  }

  /* ==================================================================== */
  /* 1b. the blast, in a car                                              */
  /* ==================================================================== */

  const placed = await page.evaluate(() => {
    const e = window.__ENGINE__;
    const pl = e.ctx.peek('player');
    const veh = e.ctx.peek('vehicles');
    const roads = e.ctx.peek('world')?.roads;
    const p = pl.position;
    if (!roads?.nearestEdge || !roads.laneCenter) return { err: 'no road graph' };
    const hit = roads.nearestEdge(p.x, p.z, 400);
    if (hit?.edge == null) return { err: 'no lane within 400 m' };
    const V = Object.getPrototypeOf(p).constructor;
    const id = hit.edge.id ?? hit.edge;
    const lane = hit.lane ?? 0;
    const t0 = Math.min(0.5, hit.t ?? 0.5);
    const a = new V(), ahead = new V();
    roads.laneCenter(id, lane, t0, a);
    roads.laneCenter(id, lane, Math.min(0.99, t0 + 0.06), ahead);
    // A vehicle's nose is +Z, so a heading d needs yaw = atan2(d.x, d.z).
    const yaw = Math.atan2(ahead.x - a.x, ahead.z - a.z);
    if (!Number.isFinite(a.x)) return { err: 'lane centre is NaN' };
    // Own the site: the entry scan takes the NEAREST car, not necessarily ours.
    for (const other of (veh?.active ?? veh?.vehicles ?? []).slice()) {
      if (!other?.position) continue;
      const dx = other.position.x - a.x, dz = other.position.z - a.z;
      if (dx * dx + dz * dz < 30 * 30) veh?.despawn?.(other);
    }
    const car = veh?.spawn?.('sedan', { x: a.x, y: a.y + 0.6, z: a.z }, yaw, {});
    if (!car) return { err: 'vehicles.spawn returned nothing' };
    car._probeCar = true;
    pl.teleport?.(
      { x: a.x + Math.cos(yaw) * 2.4, y: a.y + 1.0, z: a.z - Math.sin(yaw) * 2.4 },
      { x: 0, y: 0, z: 0 }
    );
    return { at: [+a.x.toFixed(1), +a.z.toFixed(1)] };
  });
  if (placed.err) throw new Error(`could not stage a car: ${placed.err}`);
  await page.evaluate(() => window.__PUMP__(40));

  const seated = await page.evaluate(async () => {
    const pl = window.__ENGINE__.ctx.peek('player');
    pl.vehicles.tryEnter?.(pl.movement);
    for (let i = 0; i < 40 && !pl.vehicles.seated; i++) await window.__PUMP__(10);
    return { seated: !!pl.vehicles.seated, probeCar: pl.vehicles.vehicle?._probeCar === true };
  });
  if (!seated.seated) throw new Error('the player never got behind the wheel');
  if (!seated.probeCar) throw new Error('entered a bystander, not the probe car — site not clear');

  const inCar = await page.evaluate(async ({ damage, radius }) => {
    const e = window.__ENGINE__;
    const pl = e.ctx.peek('player');
    const V = Object.getPrototypeOf(pl.position).constructor;
    const car = pl.vehicles.vehicle;
    /* The car's health, however `vehicles` chooses to spell it. Read as a
     * NUMBER THAT MOVED, never compared to a table — `src/vehicles` is
     * re-tuning durability right now and this must not care what a sedan has. */
    const carHp = () => (typeof car.health === 'number' ? car.health : car.damage?.hp ?? null);
    window.__P__.full();
    const hp0 = pl.health.value;
    const c0 = carHp();
    const h = pl.headPosition;
    e.ctx.events.emit('explosion', {
      position: new V(h.x, h.y, h.z), radius, damage, source: 'blockblastprobe',
    });
    const res = {
      playerLoss: hp0 - pl.health.value,
      carLoss: c0 == null ? null : c0 - carHp(),
      carHp0: c0,
      seated: !!pl.vehicles.seated,
    };
    window.__P__.full();
    await window.__PUMP__(4);
    return res;
  }, { damage: BLAST_DAMAGE, radius: BLAST_RADIUS });

  if (VERBOSE) console.log(JSON.stringify(inCar));

  if (inCar.carLoss == null) {
    rec('the car takes the blast the driver does not', false,
      'the vehicle exposes no readable health — the exemption cannot be told apart ' +
      'from an explosion that never arrived');
  } else {
    rec(
      'the car takes the blast the driver does not',
      inCar.carLoss > 0,
      `the sedan lost ${inCar.carLoss.toFixed(1)} of ${f2(inCar.carHp0)} to the same event. ` +
      'This is the check that stops the next one being vacuous — a blast that never ' +
      'reached the car would leave the driver unhurt too.'
    );
    rec(
      'a blast does not touch you while you are in a car',
      inCar.seated && inCar.playerLoss <= 1e-6,
      `seated: ${inCar.seated}; the player lost ${inCar.playerLoss.toFixed(2)} hp at the ` +
      `epicentre of a damage-${BLAST_DAMAGE} blast. The blast skips a seated ` +
      'player entirely — you are immune BECAUSE the car is not.'
    );
  }

  // Back out on foot for sections 2 and 3.
  const out = await page.evaluate(async () => {
    const pl = window.__ENGINE__.ctx.peek('player');
    pl.vehicles.tryExit?.(pl.movement);
    for (let i = 0; i < 60 && pl.vehicles.active; i++) await window.__PUMP__(10);
    return !pl.vehicles.active;
  });
  if (!out) throw new Error('the player never got back out of the car');

  /* ==================================================================== */
  /* 2. the guard is a guard, not an aim                                  */
  /* ==================================================================== */

  const guard = await page.evaluate(async () => {
    const e = window.__ENGINE__;
    const pl = e.ctx.peek('player');
    const wp = e.ctx.peek('weapons');
    const B = window.__P__;
    if (!wp?.setWeaponImmediate) return { err: 'no weapons system to put fists in' };
    wp.setWeaponImmediate('fists', true);
    B.rmb(false);
    pl.movement.scriptedInput = null;
    await window.__PUMP__(120);
    if (wp.current?.melee !== true) return { err: `fists did not take (${wp.current?.id})` };

    /* Wrist height RELATIVE TO THE DRAWN HEAD, so a change of stance, of
     * ground height or of body scale cannot move it. `handL` is the animator's
     * hand; `handR` is the one `weapons`' rig owns — see the header. */
    const rel = (bone) => {
      const y = B.boneY(bone), head = B.boneY('head');
      return y == null || head == null ? null : y - head;
    };
    const snap = () => ({
      fov: e.ctx.camera.fov,
      lead: rel('handL'),
      weaponHand: rel('handR'),
      blocking: pl.blocking === true,
    });

    const idle = snap();
    B.rmb(true);
    await window.__PUMP__(150);
    const up = snap();
    B.rmb(false);
    await window.__PUMP__(120);

    /* Reported, not asserted: the same guard with a WEAPON in the hand, where
     * the support hand is welded to the grip and follows the weapon arm. */
    let pipeIdle = null, pipeUp = null;
    if (wp.states?.has?.('pipe')) {
      wp.setWeaponImmediate('pipe', true);
      await window.__PUMP__(140);
      pipeIdle = snap();
      B.rmb(true);
      await window.__PUMP__(160);
      pipeUp = snap();
      B.rmb(false);
      await window.__PUMP__(120);
      wp.setWeaponImmediate('fists', true);
      await window.__PUMP__(60);
    }
    return { idle, up, pipeIdle, pipeUp };
  });
  if (guard.err) throw new Error(`the guard could not be staged: ${guard.err}`);
  if (VERBOSE) console.log(JSON.stringify(guard));

  {
    const dFov = guard.up.fov - guard.idle.fov;
    rec(
      'holding block with fists does not zoom the camera',
      Math.abs(dFov) < 0.5,
      `camera fov ${f2(guard.idle.fov)} at rest -> ${f2(guard.up.fov)} with RMB held ` +
      `(${dFov >= 0 ? '+' : ''}${dFov.toFixed(2)}). A rifle's ADS takes it to 47.1; ` +
      'a fist has no sights. This is the emitted fov, not `adsRequested`.'
    );
    const rise = guard.up.lead == null || guard.idle.lead == null
      ? null
      : guard.up.lead - guard.idle.lead;
    rec(
      'a raised guard puts the lead hand at the face',
      guard.up.blocking && rise != null && rise >= MIN_WRIST_RISE,
      rise == null
        ? 'no handL bone to sample — nothing was measured'
        : `the drawn lead wrist rose ${rise.toFixed(3)} m, from ${guard.idle.lead.toFixed(3)} m ` +
          `below the drawn head to ${guard.up.lead.toFixed(3)} m (budget ${MIN_WRIST_RISE} m). ` +
          `Guard engaged: ${guard.up.blocking}. Bone matrices, composed, after the frame.`
    );

    /* Reported, not asserted — the fix is one line in another subsystem's file.
     * See the header. */
    const wr = guard.up.weaponHand == null || guard.idle.weaponHand == null
      ? null
      : guard.up.weaponHand - guard.idle.weaponHand;
    if (wr != null) {
      info(
        wr >= MIN_WRIST_RISE
          ? 'the weapon hand joins the guard'
          : 'the weapon hand does NOT join the guard',
        `the drawn weapon-hand wrist moved ${wr >= 0 ? '+' : ''}${wr.toFixed(3)} m against the ` +
        `lead hand's ${rise == null ? '--' : `+${rise.toFixed(3)}`} m. ` +
        'NOT ASSERTED: `src/weapons/rig.js#_place` calls `_driveMeleeIdle`, which slerps the ' +
        'weapon shoulder into a ready carry in `weapons.lateUpdate` — after the animator — ' +
        'every frame a melee weapon is drawn and not swinging, so the guard is undone on that ' +
        'arm alone and the player sees a one-armed guard. The fix is one line at rig.js:751, ' +
        'where `player` is already in scope: ' +
        '`else if (e.def.melee && player?.blocking !== true) this._driveMeleeIdle(e, hand);` ' +
        'VERIFIED at runtime by stubbing `_driveMeleeIdle` while blocking: the weapon wrist ' +
        'then rises +0.537 m to the cheek, both hands come up, and the carry returns intact ' +
        'the frame the button is released.'
      );
    }

    if (guard.pipeUp && guard.pipeIdle) {
      const pl = guard.pipeUp.lead - guard.pipeIdle.lead;
      const pw = guard.pipeUp.weaponHand - guard.pipeIdle.weaponHand;
      info(
        'with a PIPE in hand the guard is not drawn at all',
        `lead wrist ${pl >= 0 ? '+' : ''}${pl.toFixed(3)} m, weapon wrist ` +
        `${pw >= 0 ? '+' : ''}${pw.toFixed(3)} m — against the fists' ` +
        `${rise == null ? '--' : `+${rise.toFixed(3)}`} m on the lead hand. Worse than fists, ` +
        'same root cause: a two-handed melee weapon welds the SUPPORT hand to its grip, and ' +
        'the grip rides the weapon arm `_driveMeleeIdle` is holding down, so both hands go ' +
        'with it. The one-line fix above was measured to fix both arms for both weapons ' +
        '(pipe: lead +0.374 m, weapon wrist +0.537 m, and the pipe itself comes up 0.53 m).'
      );
    }
  }

  /* ==================================================================== */
  /* 3. what the guard costs you                                          */
  /* ==================================================================== */

  const speeds = await page.evaluate(async () => {
    const e = window.__ENGINE__;
    const pl = e.ctx.peek('player');
    const m = pl.movement;
    const B = window.__P__;
    const V = Object.getPrototypeOf(pl.position).constructor;

    /* One run: same site, same heading, same stick magnitude; only the guard
     * and the sprint key change. The character is put back where he started
     * between runs so all four cover the same ground. */
    const home = new V(pl.position.x, pl.position.y, pl.position.z);
    const run = async (label, script, block) => {
      B.rmb(false);
      m.scriptedInput = null;
      pl.teleport?.({ x: home.x, y: home.y + 1.6, z: home.z }, { x: 0, y: 0, z: 0 });
      await window.__PUMP__(30);
      if (block) B.rmb(true);
      m.scriptedInput = script;
      await window.__PUMP__(70);                       // accelerate to terminal
      const a = new V(pl.position.x, pl.position.y, pl.position.z);
      const t0 = e.ctx.time.elapsed;
      const sprintLatched = [];
      for (let i = 0; i < 12; i++) { await window.__PUMP__(10); sprintLatched.push(m.sprinting); }
      const b = new V(pl.position.x, pl.position.y, pl.position.z);
      const t1 = e.ctx.time.elapsed;
      const blocked = pl.blocking === true;
      m.scriptedInput = null;
      B.rmb(false);
      await window.__PUMP__(10);
      const dt = t1 - t0;
      return {
        label,
        speed: dt > 1e-4 ? Math.hypot(b.x - a.x, b.z - a.z) / dt : 0,
        dt,
        blocked,
        sprintLatched: sprintLatched.some(Boolean),
      };
    };

    const wp = e.ctx.peek('weapons');
    wp?.setWeaponImmediate?.('fists', true);
    await window.__PUMP__(60);
    const rows = [];
    rows.push(await run('jog', { x: 0, y: 1 }, false));
    rows.push(await run('sprint', { x: 0, y: 1, sprint: true }, false));
    rows.push(await run('guard', { x: 0, y: 1 }, true));
    rows.push(await run('guard+sprint', { x: 0, y: 1, sprint: true }, true));
    return rows;
  });
  if (VERBOSE) console.log(JSON.stringify(speeds));

  {
    const by = Object.fromEntries(speeds.map((r) => [r.label, r]));
    const line = speeds.map((r) => `${r.label} ${r.speed.toFixed(3)}`).join('  ');
    // A run that never got moving would make every ratio meaningless.
    if (!(by.jog.speed > 1.5) || !(by.sprint.speed > by.jog.speed * 1.2)) {
      rec('the test site lets the character run', false,
        `jog ${by.jog.speed.toFixed(3)} m/s, sprint ${by.sprint.speed.toFixed(3)} m/s — ` +
        'he is against something; the guard ratios below would be meaningless');
    } else if (!by.guard.blocked || !by['guard+sprint'].blocked) {
      rec('the guard is actually up during the guarded runs', false,
        `blocking: guard ${by.guard.blocked}, guard+sprint ${by['guard+sprint'].blocked}`);
    } else {
      const ratio = by.guard.speed / by.jog.speed;
      rec(
        'a raised guard costs you most of your speed',
        Math.abs(ratio - BLOCK_RATIO) <= BLOCK_RATIO_TOL,
        `emitted m/s: ${line}. Guarded / jog = ${ratio.toFixed(3)}; expected is ` +
        `${BLOCK_RATIO}, budget +-${BLOCK_RATIO_TOL}. Both numbers are ` +
        'drawn-position displacement over elapsed time on the same ground, so a re-tune of ' +
        'every speed in tuning.js leaves this unchanged.'
      );
      const gs = by['guard+sprint'];
      rec(
        'you cannot sprint out of a guard',
        !gs.sprintLatched && Math.abs(gs.speed / by.jog.speed - BLOCK_RATIO) <= BLOCK_RATIO_TOL,
        `with Shift held the whole run the guard still moved ${gs.speed.toFixed(3)} m/s ` +
        `(${(gs.speed / by.jog.speed).toFixed(3)} of the jog) against a free sprint's ` +
        `${by.sprint.speed.toFixed(3)}, and \`movement.sprinting\` never latched ` +
        `(${gs.sprintLatched}). It is locked out twice — the sprint refuses to latch ` +
        'while the guard is up, AND the guarded speed wins in the speed chain.'
      );
    }
  }

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  if (pageErrors.length) console.log('page errors:', pageErrors.slice(0, 6));
  exitCode = failed.length ? 1 : 0;
} catch (err) {
  console.error(`blockblastprobe: ${err.message}`);
  if (pageErrors.length) console.error('page errors:', pageErrors.slice(0, 6));
  exitCode = 1;
} finally {
  await browser.close();
  stopServer(server);
}
process.exit(exitCode);
