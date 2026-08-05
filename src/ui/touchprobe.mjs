#!/usr/bin/env node
/**
 * TOUCH PROBE — does the mobile control layer actually drive the player?
 *
 * `tools/capture.mjs` proves the joystick is DRAWN. It cannot prove that
 * dragging it walks, that the ACT button gets you into a car, or that a second
 * finger on FIRE does not steal the stick. This dispatches real `TouchEvent`s
 * at the real elements — no shortcuts through the subsystem API — and checks
 * the observable result in the world.
 *
 *   npm run build && node src/ui/touchprobe.mjs
 */
import { chromium } from 'playwright';
import { startServer } from '../../tools/lib/server.mjs';

const { port, server } = await startServer({});
const b = await chromium.launch({
  args: ['--use-angle=metal', '--ignore-gpu-blocklist', '--enable-gpu', '--mute-audio'],
});
const page = await b.newPage({
  viewport: { width: 390, height: 844 },
  hasTouch: true,
  isMobile: true,
});
const errs = [];
page.on('pageerror', (e) => errs.push(String(e.message).slice(0, 200)));
page.on('console', (m) => { if (m.type() === 'error') errs.push(m.text().slice(0, 200)); });

const results = [];
const rec = (area, name, ok, detail) => results.push({ area, name, ok, detail });

const pump = (n) =>
  page.evaluate(
    (k) => new Promise((d) => { let i = 0; const t = () => (++i >= k ? d() : requestAnimationFrame(t)); requestAnimationFrame(t); }),
    n
  );

/**
 * Dispatch a TouchEvent by hand. Playwright's `page.touchscreen` only supports
 * a single tap, and the whole point of this file is multi-finger behaviour.
 */
const touch = (sel, type, id, x, y) =>
  page.evaluate(({ sel, type, id, x, y }) => {
    const el = document.querySelector(sel);
    if (!el) throw new Error('no element ' + sel);
    const t = new Touch({ identifier: id, target: el, clientX: x, clientY: y,
      pageX: x, pageY: y, screenX: x, screenY: y });
    const list = [t];
    el.dispatchEvent(new TouchEvent(type, {
      bubbles: true, cancelable: true, composed: true,
      touches: type === 'touchend' || type === 'touchcancel' ? [] : list,
      targetTouches: type === 'touchend' || type === 'touchcancel' ? [] : list,
      changedTouches: list,
    }));
  }, { sel, type, id, x, y });

const rect = (sel) =>
  page.evaluate((s) => {
    const e = document.querySelector(s);
    if (!e) return null;
    const r = e.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2, w: r.width, h: r.height };
  }, sel);

const snap = () =>
  page.evaluate(() => {
    const e = window.__ENGINE__;
    const pl = e.ctx.peek('player');
    const ui = e.ctx.peek('ui');
    const p = pl?.position;
    return {
      pos: p ? [+p.x.toFixed(2), +p.y.toFixed(2), +p.z.toFixed(2)] : null,
      yaw: +(pl?.rig?.yawTarget ?? pl?.rig?.yaw ?? 0).toFixed(3),
      // `vehicles.vehicle` STAYS SET after you get out (the handler keeps the
      // reference), so seated/phase is the only honest test.
      inVehicle: pl?.vehicles?.seated === true || pl?.vehicles?.phase === 'drive',
      phase: pl?.vehicles?.phase ?? null,
      exitBlocked: pl?.vehicles?.stats?.exitBlocked ?? 0,
      exits: pl?.vehicles?.stats?.exits ?? 0,
      enters: pl?.vehicles?.stats?.enters ?? 0,
      vehName: pl?.vehicles?.seated
        ? (pl.vehicles.vehicle?.name ?? pl.vehicles.vehicle?.spec?.name ?? '?') : null,
      nearVeh: (() => {
        const v = e.ctx.peek('vehicles');
        if (!v?.nearest || !p) return null;
        const n = v.nearest(p.x, p.y, p.z, 30);
        return n ? +n.position.distanceTo(p).toFixed(2) : null;
      })(),
      stick: [+e.input.stick.moveX.toFixed(3), +e.input.stick.moveY.toFixed(3)],
      move: (() => { const o = e.input.moveVector({ x: 0, y: 0 }); return [+o.x.toFixed(3), +o.y.toFixed(3)]; })(),
      down: [...e.input.down],
      action: ui ? { verb: ui.action.verb, available: ui.action.available, label: ui.action.label } : null,
      actBtn: document.querySelector('.ow-tbtn.act small')?.textContent ?? null,
      actOff: document.querySelector('.ow-tbtn.act')?.classList.contains('off') ?? null,
      feed: [...document.querySelectorAll('.ow-feed-row')]
        .filter((n) => n.style.display !== 'none')
        .map((n) => n.textContent.trim().slice(0, 46)),
      touchOn: !!e.ctx.peek('ui')?.touch?.active,
      visible: !!e.ctx.peek('ui')?.touch?.visible,
    };
  });

try {
  await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: 'domcontentloaded', timeout: 90000 });
  await page.waitForFunction('window.__READY__===true', null, { timeout: 120000 });
  await pump(120);
  await page.evaluate(() => {
    const e = window.__ENGINE__;
    e.input.enabled = true; e.input.frozen = false;
    e.ctx.peek('player')?.setControlEnabled?.(true);
  });
  await pump(30);

  const boot = await snap();
  rec('boot', 'touch layer is active on a 390x844 phone', boot.touchOn, String(boot.touchOn));
  rec('boot', 'controls are visible', boot.visible, String(boot.visible));
  const joy = await rect('.ow-tjoy');
  const fire = await rect('.ow-tbtn.fire');
  const act = await rect('.ow-tbtn.act');
  rec('boot', 'joystick is on screen', !!joy && joy.y < 844 && joy.x < 390,
    joy ? `${joy.w | 0}px at ${joy.x | 0},${joy.y | 0}` : 'missing');
  rec('boot', 'fire button is on screen', !!fire && fire.y < 844,
    fire ? `${fire.w | 0}px at ${fire.x | 0},${fire.y | 0}` : 'missing');
  rec('boot', 'action button is on screen', !!act, act ? `${act.w | 0}px at ${act.x | 0},${act.y | 0}` : 'missing');

  // ---- joystick -> stick -> movement -----------------------------------
  await touch('.ow-tjoy', 'touchstart', 1, joy.x, joy.y);
  await touch('.ow-tjoy', 'touchmove', 1, joy.x, joy.y - joy.h);   // full "up"
  await pump(3);
  const pushed = await snap();
  rec('joystick', 'thumb up drives input.stick', Math.abs(pushed.stick[1]) > 0.9,
    `stick ${JSON.stringify(pushed.stick)}`);
  rec('joystick', 'stick reaches moveVector as forward',
    pushed.move[1] > 0.9, `move ${JSON.stringify(pushed.move)}`);

  const before = await snap();
  await pump(70);
  const after = await snap();
  const walked = Math.hypot(after.pos[0] - before.pos[0], after.pos[2] - before.pos[2]);
  rec('joystick', 'holding the stick walks the player', walked > 1.0, `${walked.toFixed(2)} m`);

  // A second finger on FIRE must not steal the stick (identifier tracking).
  await touch('.ow-tbtn.fire', 'touchstart', 2, fire.x, fire.y);
  await pump(3);
  const twoFinger = await snap();
  rec('joystick', 'a second finger cannot steal the stick',
    Math.abs(twoFinger.stick[1]) > 0.9, `stick ${JSON.stringify(twoFinger.stick)}`);
  rec('buttons', 'FIRE holds Mouse0', twoFinger.down.includes('Mouse0'),
    twoFinger.down.join(','));
  // A touchmove for the FIRE finger must not move the knob either.
  await touch('.ow-tbtn.fire', 'touchmove', 2, fire.x - 120, fire.y);
  await pump(2);
  const stillHeld = await snap();
  rec('joystick', 'dragging the second finger does not move the knob',
    Math.abs(stillHeld.stick[1]) > 0.9, `stick ${JSON.stringify(stillHeld.stick)}`);

  await touch('.ow-tbtn.fire', 'touchend', 2, fire.x, fire.y);
  await pump(3);
  const released = await snap();
  rec('buttons', 'FIRE releases Mouse0', !released.down.includes('Mouse0'),
    released.down.join(',') || '(none)');

  await touch('.ow-tjoy', 'touchend', 1, joy.x, joy.y - joy.h);
  await pump(3);
  const centred = await snap();
  rec('joystick', 'touchend recentres the stick',
    centred.stick[0] === 0 && centred.stick[1] === 0, JSON.stringify(centred.stick));

  // ---- camera drag zone -------------------------------------------------
  const y0 = (await snap()).yaw;
  await touch('.ow-tzone', 'touchstart', 3, 300, 300);
  for (let i = 1; i <= 6; i++) await touch('.ow-tzone', 'touchmove', 3, 300 - i * 22, 300);
  await pump(6);
  await touch('.ow-tzone', 'touchend', 3, 168, 300);
  await pump(4);
  const y1 = (await snap()).yaw;
  rec('camera', 'dragging the camera zone turns the view', Math.abs(y1 - y0) > 0.05,
    `yaw ${y0} -> ${y1}`);

  // ---- held buttons -----------------------------------------------------
  for (const [sel, code, name] of [
    ['.ow-tbtn.run', 'ShiftLeft', 'RUN'],
    ['.ow-tbtn.brake', 'Space', 'BRAKE/JUMP'],
    ['.ow-tbtn.aim', 'Mouse2', 'AIM'],
  ]) {
    const r = await rect(sel);
    await touch(sel, 'touchstart', 7, r.x, r.y);
    await pump(3);
    const on = (await snap()).down.includes(code);
    await touch(sel, 'touchend', 7, r.x, r.y);
    await pump(3);
    const off = !(await snap()).down.includes(code);
    rec('buttons', `${name} holds and releases ${code}`, on && off,
      `down ${on}, up ${off}`);
  }

  // ---- the contextual action -------------------------------------------
  // Get somewhere with nothing in reach first: the walk above can easily end
  // up beside a parked car, and then "no action" is not what is being tested.
  const clearD = await page.evaluate(() => {
    const e = window.__ENGINE__;
    const pl = e.ctx.peek('player');
    const veh = e.ctx.peek('vehicles');
    const p = pl.position;
    for (let i = 0; i < 24; i++) {
      const a = (i / 24) * Math.PI * 2;
      const x = p.x + Math.cos(a) * 26;
      const z = p.z + Math.sin(a) * 26;
      const n = veh?.nearest?.(x, p.y, z, 14);
      if (!n) { pl.teleport?.({ x, y: p.y, z }, { x: 0, y: 0, z: 0 }); return 14; }
    }
    return 0;
  });
  await pump(30);
  const onFoot = await snap();
  const reallyClear = clearD > 0 && (onFoot.nearVeh === null || onFoot.nearVeh > 8);
  rec('action', 'no action nearby reads as unavailable',
    !reallyClear || onFoot.actOff === true,
    `verb "${onFoot.actBtn}", off ${onFoot.actOff}, nearest vehicle ${onFoot.nearVeh}m` +
    (reallyClear ? '' : ' (SKIPPED: could not get clear of traffic)'));

  // Tapping with nothing in reach must still say something.
  await page.evaluate(() => window.__ENGINE__.ctx.peek('ui').feed.clear());
  await touch('.ow-tbtn.act', 'touchstart', 8, act.x, act.y);
  await touch('.ow-tbtn.act', 'touchend', 8, act.x, act.y);
  await pump(10);
  const missed = await snap();
  rec('action', 'a miss toasts instead of doing nothing',
    !reallyClear || missed.feed.some((f) => /NO VEHICLE|NOTHING/i.test(f)),
    missed.feed.join(' | ') || '(empty feed)');

  // Walk up to a car and take it with the ACT button alone.
  //
  // The car is SPAWNED on a lane centre from the road graph rather than found
  // with `vehicles.nearest()`. `nearest` hands back whatever ambient traffic is
  // closest, which is regularly a parked car wedged against the kerb — and then
  // "the stick drives the car" reads 0.02 m/s and "entering the car toasts"
  // reads an empty feed, neither of which is what those cases are named for.
  // `tools/playprobe.mjs` hit exactly this and documents the same fix; this is
  // that fix, ported. Falls back to `nearest` where the road graph is unusable.
  await page.evaluate(() => {
    const e = window.__ENGINE__;
    const pl = e.ctx.peek('player');
    const veh = e.ctx.peek('vehicles');
    const w = e.ctx.peek('world');
    const p = pl.position;

    const roads = w?.roads;
    if (roads?.nearestEdge && roads.laneCenter && veh?.spawn) {
      const hit = roads.nearestEdge(p.x, p.z, 300);
      if (hit?.edge != null) {
        const a = new (Object.getPrototypeOf(p).constructor)();
        roads.laneCenter(hit.edge.id ?? hit.edge, hit.lane ?? 0,
          Math.min(0.9, (hit.t ?? 0.5) + 0.02), a);
        if (Number.isFinite(a.x)) {
          const car = veh.spawn('sedan', { x: a.x, y: a.y + 0.6, z: a.z }, 0, {});
          if (car) {
            car._probeCar = true;
            pl.teleport?.({ x: a.x + 2.4, y: a.y + 1.0, z: a.z }, { x: 0, y: 0, z: 0 });
            return;
          }
        }
      }
    }
    const n = veh?.nearest?.(p.x, p.y, p.z, 400);
    if (n) pl.teleport?.({ x: n.position.x + 2.2, y: n.position.y + 1.0, z: n.position.z }, { x: 0, y: 0, z: 0 });
  });
  // The teleport drops the player 1 m above the road; give the controller time
  // to land and the interaction scan time to see the car before asserting.
  for (let i = 0; i < 12; i++) {
    await pump(20);
    if ((await snap()).action?.available) break;
  }
  const atCar = await snap();
  rec('action', 'standing by a car names the action on the button',
    atCar.actOff === false && !!atCar.action?.available,
    `button "${atCar.actBtn}" · label "${atCar.action?.label}"`);

  await touch('.ow-tbtn.act', 'touchstart', 9, act.x, act.y);
  await touch('.ow-tbtn.act', 'touchend', 9, act.x, act.y);
  // The toast is read on its own, EARLY. Seating takes ~170 frames to settle,
  // and by then a notification raised at the moment of entry has already faded
  // out — so asserting both off one late snapshot made a passing toast look
  // like a missing one.
  let entryFeed = [];
  for (let i = 0; i < 9; i++) {
    await pump(20);
    const f = (await snap()).feed;
    if (f.length) { entryFeed = f; break; }
  }
  await pump(60);
  const inCar = await snap();
  rec('action', 'the ACT button gets you into the car', inCar.inVehicle,
    inCar.inVehicle ? 'seated' : 'still on foot');
  rec('action', 'entering the car toasts',
    entryFeed.length > 0, entryFeed.join(' | ') || '(empty feed)');
  rec('action', 'the button relabels to EXIT in a vehicle',
    /EXIT/i.test(inCar.actBtn ?? ''), `"${inCar.actBtn}"`);

  if (inCar.inVehicle) {
    // Drive with the stick.
    await touch('.ow-tjoy', 'touchstart', 10, joy.x, joy.y);
    await touch('.ow-tjoy', 'touchmove', 10, joy.x, joy.y - joy.h);
    await pump(80);
    const drove = await page.evaluate(() => {
      const pl = window.__ENGINE__.ctx.peek('player');
      const v = pl?.vehicles?.vehicle;
      return v ? +(v.speed ?? v.forwardSpeed ?? 0).toFixed(2) : null;
    });
    await touch('.ow-tjoy', 'touchend', 10, joy.x, joy.y - joy.h);
    rec('action', 'the stick drives the car', (Math.abs(drove) ?? 0) > 1.0, `${drove} m/s`);

    // Come to a stop the way a player would, on the BRAKE button, before
    // getting out: bailing at 30 km/h is a different code path (`_bail`) and
    // `tryExit` is entitled to refuse it.
    const brake = await rect('.ow-tbtn.brake');
    await touch('.ow-tbtn.brake', 'touchstart', 13, brake.x, brake.y);
    await pump(90);
    await touch('.ow-tbtn.brake', 'touchend', 13, brake.x, brake.y);
    await pump(60);

    const pre = await snap();
    await touch('.ow-tbtn.act', 'touchstart', 11, act.x, act.y);
    await touch('.ow-tbtn.act', 'touchend', 11, act.x, act.y);
    await pump(220);
    const out = await snap();
    // "Released the car you were in" rather than "on foot": `game.freeroam`
    // consumes the SAME `use` edge that `player` has already spent exiting, and
    // its car-swap can put you straight into the vehicle alongside. See the
    // note in `src/ui/index.js` `_updateAction`. The exit itself worked either
    // way — `stats.exits` is what proves it.
    const released = out.exits > pre.exits;
    rec('action', 'the same button gets you out of the car', released,
      released
        ? (out.inVehicle ? `exited, then game re-seated you in the ${out.vehName}` : 'on foot')
        : `still in the ${out.vehName} (${out.phase}, exitBlocked ${pre.exitBlocked}->${out.exitBlocked})`);
    if (released && out.inVehicle) {
      rec('action', 'NOTE: one F press was consumed twice (player exit + game swap)',
        false, `enters ${pre.enters}->${out.enters}, exits ${pre.exits}->${out.exits} — belongs to src/game/freeroam.js`);
    }
    if (!released && out.exitBlocked > pre.exitBlocked) {
      rec('action', 'a refused exit tells the player why',
        out.feed.some((f) => /NO ROOM/i.test(f)), out.feed.join(' | '));
    }
  }

  // ---- HUD taps ---------------------------------------------------------
  const mapBtn = await rect('.ow-tnav-btn');
  await touch('.ow-tnav-btn', 'touchstart', 12, mapBtn.x, mapBtn.y);
  await pump(20);
  const mapOpen = await page.evaluate(() => !!window.__ENGINE__.ctx.peek('ui')?.map?.open);
  rec('hud', 'the MAP nav button opens the pause map', mapOpen, String(mapOpen));
  if (mapOpen) {
    await page.evaluate(() => window.__ENGINE__.ctx.peek('ui').closeMap());
    await pump(20);
  }

  // The readouts themselves are tap targets — on a phone the natural move is to
  // touch the map rather than hunt for a button that opens the map.
  const ring = await rect('.ow-radar');
  await touch('.ow-radar', 'touchstart', 14, ring.x, ring.y);
  await pump(20);
  const ringOpened = await page.evaluate(() => !!window.__ENGINE__.ctx.peek('ui')?.map?.open);
  rec('hud', 'tapping the radar opens the map', ringOpened, String(ringOpened));
  if (ringOpened) {
    await page.evaluate(() => window.__ENGINE__.ctx.peek('ui').closeMap());
    await pump(20);
  }

  const chip = await rect('.ow-weap');
  const wepPress = await page.evaluate(({ x, y }) => new Promise((done) => {
    const e = window.__ENGINE__;
    const el = document.querySelector('.ow-weap');
    let saw = false;
    const iv = setInterval(() => { if (e.input.down.has('KeyE') || e.input._pendingDown.has('KeyE')) saw = true; }, 8);
    const t = new Touch({ identifier: 15, target: el, clientX: x, clientY: y });
    el.dispatchEvent(new TouchEvent('touchstart', { bubbles: true, cancelable: true,
      touches: [t], targetTouches: [t], changedTouches: [t] }));
    setTimeout(() => { clearInterval(iv); done(saw); }, 260);
  }), chip);
  rec('hud', 'tapping the weapon box cycles the weapon', wepPress, `KeyE seen: ${wepPress}`);
  const hidden = await page.evaluate(() => {
    const ui = window.__ENGINE__.ctx.peek('ui');
    ui.menu.show();
    return new Promise((d) => requestAnimationFrame(() => requestAnimationFrame(() => {
      const v = ui.touch.visible; ui.menu.close(); d(v);
    })));
  });
  await pump(10);
  rec('hud', 'the controls hide under a modal', hidden === false, `visible ${hidden}`);

  /* ==================================================================== */
  /* FLYING, ON A THUMB                                                   */
  /* ==================================================================== */
  //
  // The report: "mobile controls need to support flying the airplane as well."
  // The joystick already drives pitch/roll (it writes the same
  // `control.throttle/brake/steer` the elevator and ailerons read), so what a
  // flying vehicle needs on touch is the THROTTLE — and the RUN button already
  // holds `ShiftLeft`, which `plane.js` reads as throttle-up. This drives that
  // button for real and asserts the EMITTED plane winds up. The plane is put on
  // a real airfield runway (`world.airfields`) so it has somewhere to roll; the
  // seat is taken through `game.debugBoard` (boarding-by-touch is proven for
  // cars above — this case is about the throttle button, not the door).
  const planeSnap = () => page.evaluate(() => {
    const v = window.__PLANE__;
    const pl = window.__ENGINE__.ctx.peek('player');
    if (!v) return null;
    const q = v.quaternion;
    const fx = 2 * (q.x * q.z + q.w * q.y), fy = 2 * (q.y * q.z - q.w * q.x), fz = 1 - 2 * (q.x * q.x + q.y * q.y);
    const fwd = v.velocity.x * fx + v.velocity.y * fy + v.velocity.z * fz;
    return {
      airspeed: +fwd.toFixed(2),
      lever: +(v.throttleLever ?? 0).toFixed(3),
      inputBoost: +(v.input.boost ?? 0).toFixed(2),
      seated: pl?.vehicles?.seated === true,
      kind: v.spec?.kind ?? null,
      runLabel: document.querySelector('.ow-tbtn.run small')?.textContent ?? null,
    };
  });

  const flySetup = await page.evaluate(() => {
    const e = window.__ENGINE__;
    const player = e.ctx.peek('player');
    const veh = e.ctx.peek('vehicles');
    const world = e.ctx.peek('world');
    const game = e.ctx.peek('game');
    if (player.inVehicle) player.vehicles.abort(player.movement);
    const fields = world?.airfields;
    if (!fields?.length) return { err: 'no airfields' };
    const af = fields[0];
    const c = Math.cos(af.yaw), s = Math.sin(af.yaw);
    const len = af.runway?.[0] ?? 400;
    const px = af.x + s * (-len * 0.32), pz = af.z + c * (-len * 0.32);
    for (const o of veh.vehicles.slice()) {
      if (Math.hypot(o.position.x - px, o.position.z - pz) < 60) { try { veh.despawn(o); } catch (err) { /* */ } }
    }
    const v = game.wq.spawnVehicle('plane', px, pz, af.yaw);
    if (!v) return { err: 'spawn failed' };
    window.__PLANE__ = v;
    return { boarded: game.debugBoard(v), field: af.name };
  });
  for (let i = 0; i < 12; i++) { await pump(20); if ((await planeSnap())?.seated) break; }
  const seatedPlane = await planeSnap();
  rec('flight', 'the player takes the seat of a plane on the runway',
    !!seatedPlane?.seated && seatedPlane.kind === 'plane',
    flySetup.err ? `SETUP FAILED: ${flySetup.err}` : `${flySetup.field} · kind ${seatedPlane?.kind} · seated ${seatedPlane?.seated}`);
  rec('flight', 'the RUN button relabels to the throttle in a plane',
    /THR/i.test(seatedPlane?.runLabel ?? ''), `RUN label "${seatedPlane?.runLabel}"`);

  // NEGATIVE BASELINE: seated, nothing held, the plane does not wind up on its own.
  await pump(240);
  const idlePlane = await planeSnap();
  rec('flight', 'nothing held — the plane sits idle (negative baseline)',
    (idlePlane?.airspeed ?? 9) < 2 && (idlePlane?.lever ?? 9) < 0.1,
    `airspeed ${idlePlane?.airspeed} m/s, lever ${idlePlane?.lever}`);

  // Hold the touch throttle (RUN) and watch the emitted lever wind up and the
  // airspeed build — the real touch path, `ShiftLeft` -> input.boost -> stepPlane.
  const runBtn = await rect('.ow-tbtn.run');
  await touch('.ow-tbtn.run', 'touchstart', 30, runBtn.x, runBtn.y);
  let flew = idlePlane;
  for (let i = 0; i < 10; i++) { await pump(60); flew = await planeSnap(); if (flew?.airspeed > 6) break; }
  await touch('.ow-tbtn.run', 'touchend', 30, runBtn.x, runBtn.y);
  rec('flight', 'holding the touch throttle delivers input.boost to the plane',
    (flew?.inputBoost ?? 0) > 0.5, `input.boost ${flew?.inputBoost}`);
  rec('flight', 'the touch throttle winds the lever up and builds airspeed',
    (flew?.lever ?? 0) > 0.5 && (flew?.airspeed ?? 0) > 6,
    `lever ${flew?.lever}, airspeed ${flew?.airspeed} m/s (idle was ${idlePlane?.airspeed})`);

  await page.evaluate(() => {
    const e = window.__ENGINE__;
    const player = e.ctx.peek('player');
    const veh = e.ctx.peek('vehicles');
    if (player.inVehicle) player.vehicles.abort(player.movement);
    if (window.__PLANE__) { try { veh.despawn(window.__PLANE__); } catch (err) { /* */ } window.__PLANE__ = null; }
  });
  await pump(20);

  /* ==================================================================== */
  /* THE PAUSE MENU, ON A THUMB                                           */
  /* ==================================================================== */
  //
  // The failure being gated: the pause menu cannot be dismissed by Resume or by
  // ESC, leaving a refresh as the only exit. On a phone this is worse than on
  // desktop,
  // because opening the menu hides the whole touch layer — including the MENU
  // button that opened it — so the buttons inside the menu are the ONLY exits
  // that exist. `src/ui/pauseprobe.mjs` covers the pointer-lock mechanics that
  // caused it; these cases cover the thumb.
  const menuState = () =>
    page.evaluate(() => {
      const e = window.__ENGINE__;
      const ui = e.ctx.peek('ui');
      const r = ui.menu.resumeBtn.getBoundingClientRect();
      const x = ui.menu.closeBtn?.getBoundingClientRect();
      return {
        open: !!ui.menu.open,
        scale: e.time.scale,
        elapsed: +e.time.elapsed.toFixed(3),
        controls: !!ui.touch.visible,
        resume: [r.left + r.width / 2, r.top + r.height / 2, Math.round(r.width), Math.round(r.height)],
        onScreen: r.left >= 0 && r.top >= 0 && r.right <= innerWidth && r.bottom <= innerHeight,
        x: x ? [x.left + x.width / 2, x.top + x.height / 2, Math.round(x.width), Math.round(x.height)] : null,
      };
    });

  const tap = async (sel, id, x, y) => {
    await touch(sel, 'touchstart', id, x, y);
    await touch(sel, 'touchend', id, x, y);
    await pump(14);
  };

  const menuBtn = await rect('.ow-tnav-btn[aria-label="MENU"]');
  await tap('.ow-tnav-btn[aria-label="MENU"]', 20, menuBtn.x, menuBtn.y);
  const opened = await menuState();
  rec('pause', 'the MENU button opens the pause menu', opened.open, `open ${opened.open}`);
  rec('pause', 'opening the menu hides the touch controls', !opened.controls,
    `controls visible ${opened.controls} — so the menu buttons are the only way out`);
  rec('pause', 'Resume is a real tap target, fully on screen',
    opened.resume[2] >= 88 && opened.resume[3] >= 44 && opened.onScreen,
    `${opened.resume[2]}x${opened.resume[3]} px at ${opened.resume[0] | 0},${opened.resume[1] | 0}` +
    (opened.onScreen ? '' : ' — OFF SCREEN'));

  // (a) tap Resume
  await tap('.ow-menu .ow-btn.primary', 21, opened.resume[0], opened.resume[1]);
  const byTap = await menuState();
  rec('pause', 'tapping Resume closes the menu', !byTap.open, `open ${byTap.open}`);
  rec('pause', 'tapping Resume restores the clock', byTap.scale === 1, `time.scale ${byTap.scale}`);
  await pump(24);
  const ranTap = await menuState();
  rec('pause', 'the sim is actually running after a tapped Resume',
    ranTap.elapsed > byTap.elapsed + 0.02, `elapsed ${byTap.elapsed} -> ${ranTap.elapsed}`);
  rec('pause', 'the touch controls come back on resume', ranTap.controls,
    `controls visible ${ranTap.controls}`);

  // (b) ESC — a phone in a desktop dock, or a Bluetooth keyboard, still has one
  await page.keyboard.press('Escape');
  await pump(16);
  const reopened = await menuState();
  rec('pause', 'ESC opens the menu', reopened.open, `open ${reopened.open}`);
  await page.keyboard.press('Escape');
  await pump(16);
  const byEsc = await menuState();
  rec('pause', 'ESC pressed twice puts the player back in the game',
    !byEsc.open && byEsc.scale === 1, `open ${byEsc.open}, time.scale ${byEsc.scale}`);

  // (c) the ✕
  await page.evaluate(() => window.__ENGINE__.ctx.peek('ui').menu.show());
  await pump(14);
  const forX = await menuState();
  await tap('.ow-menu .ow-menu-x, .ow-menu-x', 22, forX.x[0], forX.x[1]);
  const byX = await menuState();
  rec('pause', 'the ✕ closes the menu', !byX.open && byX.scale === 1,
    `${forX.x[2]}x${forX.x[3]} px · open ${byX.open}, time.scale ${byX.scale}`);

  /* ==================================================================== */
  /* THE BOOT FLOW — loader, brother select, intro card                   */
  /* ==================================================================== */
  //
  // The failure this covers: no loading screen and no character select. The
  // flow is
  // off under automation by design (see `bootEnabled` in src/ui/boot.js), so it
  // is raised here on the already-booted page rather than paying for a second
  // 25-second boot.
  const bootUp = await page.evaluate(() => {
    const f = window.__BOOT_API__.create();
    f._show('select');
    return {
      phase: f.phase,
      cards: [...document.querySelectorAll('.ow-boot-card')].map((c) => ({
        id: c.dataset.boy,
        prog: c.querySelector('.prog')?.textContent ?? '',
        w: Math.round(c.getBoundingClientRect().width),
        h: Math.round(c.getBoundingClientRect().height),
        on: c.getBoundingClientRect().top >= 0 && c.getBoundingClientRect().bottom <= innerHeight,
      })),
      bar: !!document.querySelector('.ow-boot-bar > i'),
    };
  });
  rec('boot', 'the loader has a progress bar', bootUp.bar, String(bootUp.bar));
  rec('boot', 'the select screen lists all three brothers',
    bootUp.cards.length === 3 &&
    ['carson', 'aidan', 'dylan'].every((id) => bootUp.cards.some((c) => c.id === id)),
    bootUp.cards.map((c) => c.id).join(', '));
  rec('boot', 'each card shows that save\'s progress',
    bootUp.cards.every((c) => /NEW GAME|CHAPTER|COMPLETE/.test(c.prog)),
    bootUp.cards.map((c) => `${c.id}: ${c.prog}`).join(' | '));
  rec('boot', 'every card fits on the phone without scrolling',
    bootUp.cards.every((c) => c.on && c.h >= 44),
    bootUp.cards.map((c) => `${c.w}x${c.h}`).join(', '));

  // Tap a brother who is NOT the active one, so "START switched him" is real.
  const target = await page.evaluate(() => {
    const g = window.__ENGINE__.ctx.peek('game');
    const now = g?.character ?? 'carson';
    return ['carson', 'aidan', 'dylan'].find((id) => id !== now) ?? 'aidan';
  });
  const card = await rect(`.ow-boot-card[data-boy="${target}"]`);
  await tap(`.ow-boot-card[data-boy="${target}"]`, 23, card.x, card.y);
  const intro = await page.evaluate(() => ({
    phase: window.__BOOT__.phase,
    pick: window.__BOOT__.pick,
    name: document.querySelector('.ow-boot-intro h1')?.textContent ?? '',
    tag: document.querySelector('.ow-boot-intro .tag')?.textContent ?? '',
    colour: getComputedStyle(document.querySelector('.ow-boot-intro .card')).getPropertyValue('--c').trim(),
  }));
  rec('boot', 'tapping a brother opens his intro card',
    intro.phase === 'intro' && intro.pick === target,
    `${intro.phase} · ${intro.name} · "${intro.tag}"`);
  rec('boot', 'the intro card carries that brother\'s colour', !!intro.colour,
    `--c ${intro.colour}`);

  const startBtn = await rect('.ow-boot-intro .ow-btn.primary');
  rec('boot', 'START is a real tap target', startBtn.w >= 88 && startBtn.h >= 44,
    `${startBtn.w | 0}x${startBtn.h | 0} px`);
  await tap('.ow-boot-intro .ow-btn.primary', 24, startBtn.x, startBtn.y);
  await pump(40);
  const started = await page.evaluate(() => {
    const e = window.__ENGINE__;
    const ui = e.ctx.peek('ui');
    return {
      active: !!window.__BOOT__.active,
      hidden: getComputedStyle(document.querySelector('.ow-boot')).opacity === '0',
      character: e.ctx.peek('game')?.character ?? null,
      hudCharacter: ui.state.character,
      scale: e.time.scale,
      control: e.ctx.peek('player')?.controlEnabled !== false,
    };
  });
  rec('boot', 'START dismisses the overlay', !started.active && started.hidden,
    `active ${started.active}, faded ${started.hidden}`);
  rec('boot', 'START enters the game as the brother you picked',
    started.character === target || started.hudCharacter === target,
    `picked ${target} · game ${started.character} · hud ${started.hudCharacter}`);
  rec('boot', 'START hands back a running game with control',
    started.scale === 1 && started.control,
    `time.scale ${started.scale}, control ${started.control}`);

  // ---- desktop parity ---------------------------------------------------
  const desktop = await page.evaluate(() => {
    const e = window.__ENGINE__;
    const ui = e.ctx.peek('ui');
    window.__FORCE_TOUCH__ = false;
    ui.resize(1920, 1080, e.ctx);
    const off = !ui.touch.active;
    const stick = e.input.stick.moveX;
    window.__FORCE_TOUCH__ = undefined;
    ui.resize(390, 844, e.ctx);
    return { off, stick };
  });
  rec('desktop', 'a desktop viewport turns the touch layer off', desktop.off, String(desktop.off));
  rec('desktop', 'the gamepad stick still reads through the bridge',
    desktop.stick === 0, `stick.moveX ${desktop.stick}`);

  const pass = results.filter((r) => r.ok).length;
  const w = Math.max(...results.map((r) => r.name.length));
  let area = '';
  for (const r of results) {
    if (r.area !== area) { area = r.area; console.log(`\n--- ${area} ---`); }
    console.log(`  ${r.ok ? 'PASS' : 'FAIL'}  ${r.name.padEnd(w)}  ${r.detail ?? ''}`);
  }
  console.log(`\n${pass}/${results.length} touch behaviours working`);
  if (errs.length) console.log(`\nconsole errors (${errs.length}):\n  ` + [...new Set(errs)].slice(0, 8).join('\n  '));
} catch (e) {
  console.error('touchprobe failed:', e.message);
  console.error([...new Set(errs)].slice(0, 8).join('\n'));
  process.exitCode = 1;
} finally {
  await b.close();
  server?.kill();
}
