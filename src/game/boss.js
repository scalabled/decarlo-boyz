/**
 * GAME — boss fights.
 *
 * Four of them, defined in `BOSSES`: THE HARBORMASTER and BRICK are brutes,
 * DUKE MARROW is a gunner, VIPER LANE fights from a car. Each has phases keyed
 * to remaining health, a weak point the brothers call out over the radio, a
 * telegraphed attack set, and a minion wave per phase.
 *
 * `ui` has no dedicated boss bar, and inventing one would mean adding HUD
 * drawing outside this module. The objective panel already carries an eyebrow, a
 * line, a count and a 0..1 progress bar, so the boss drives that: name on top,
 * the weak point as the line, phase as the count, and damage dealt as the bar.
 * It reads correctly and costs `ui` nothing.
 *
 * The telegraph is the whole design: every attack announces itself for ~0.8 s
 * (less as phases escalate), and that window is when you move. Without it a
 * brute that closes and hits is just damage on a timer.
 *
 * Killing the boss is not the end of the chapter — his death flips the fight
 * into the ESCAPE phase (wanted 4, ally radio call, win at zero stars). See
 * `_escape`.
 */

import { BOSSES, R, BOY_ORDER } from './data.js';
import { clamp01, dist, driveToward } from './util.js';

/**
 * Beats after the boss drops, the fight is not over — the kill flips to an
 * ESCAPE phase: wanted jumps to four, an ally calls it over the radio, and
 * the chapter only completes when the stars are back to zero. The grace beat
 * is so a pre-cleared street cannot win the phase on the same frame it starts.
 */
const ESCAPE_STARS = 4;
const ESCAPE_GRACE = 2.0;

const TELL_NAME = {
  slam: 'SLAM', sweep: 'SWEEP', charge: 'CHARGE', haymaker: 'HAYMAKER',
  volley: 'VOLLEY', grenade: 'GRENADE', call: 'REINFORCE',
  ram: 'RAM', spread: 'SPREAD', smoke: 'SMOKE',
};

export const bossTrack = {
  init(M, c, g) {
    const B = BOSSES[c.bossId];
    if (!B) return g.fail(M, 'No such rival');
    M.B = B;
    M.phase = 0;
    M.minionT = 5;
    M.tell = '';
    M.tellT = 0;
    M.atkT = 3.2;
    M.chargeT = 0;
    M.pendingT = 0;
    M.pending = '';
    M.arena.x = B.arena.x;
    M.arena.z = B.arena.z;
    M.arena.r = B.arena.r;

    // Always stage the fight in its arena — a boss ambushing you in a random
    // alley loses the one thing that makes a boss fight read as an event.
    if (B.kind === 'driver') {
      const s = g.wq.findRoadSpot(30, B.arena.r * 0.8, B.arena.x, B.arena.z);
      const v = g.spawnVehicle(M, 'muscle', s.x, s.z, s.yaw, { tag: 'boss', paint: 0x5b21b6, finish: 'gloss' });
      if (!v) return g.fail(M, 'She never showed');
      v.maxHealth = v.health = B.hp;
      v.isBoss = true;
      M.bossVeh = v;
      if (!g.wq.playerVehicle()) {
        const ps = g.wq.findRoadSpot(20, 70, B.arena.x, B.arena.z);
        M.veh = g.spawnVehicle(M, g.boy.car ?? 'sports', ps.x, ps.z, ps.yaw);
        g.wq.placePlayer(ps.x + 3, ps.z + 3, ps.yaw);
      }
    } else {
      const s = g.wq.findGroundSpot(30, B.arena.r * 0.55, B.arena.x, B.arena.z);
      const e = g.spawnHostile(M, s.x, s.z, {
        hp: B.hp,
        ranged: B.kind === 'gunner',
        dmg: Math.round(20 * g.diff.dmgIn),
        range: B.kind === 'gunner' ? 44 : 3.4,
        speed: B.kind === 'gunner' ? 2.6 : 3.6,
        scale: B.scale,
        tag: 'boss',
        leash: B.arena.r,
      });
      if (!e) return g.fail(M, 'He never showed');
      e.isBoss = true;
      M.bossEnt = e;
      // Square up 25-60 m from him, on DRY ground. Point Marina's arena is a
      // dock: a raw angle around the centre drops the player in the Ohio.
      const ps = g.wq.findGroundSpot(25, 60, s.x, s.z);
      g.wq.placePlayer(ps.x, ps.z, Math.atan2(s.x - ps.x, s.z - ps.z));
    }
    g.wq.uiSfx('kill', 1);
    g.notify(B.name, B.sub, 'bad');
  },

  update(M, dt, g) {
    const B = M.B;
    if (!B) return;
    // Once the escape phase is on, never re-read the boss handle — a pooled
    // hostile can be recycled, and a recycled handle reads as "alive" again.
    if (M.escapeOn) return this._escape(M, dt, g);
    const veh = M.bossVeh;
    const ent = M.bossEnt;
    const alive = veh ? !veh.destroyed : !!ent && !ent.dead;
    if (!alive) return this._escape(M, dt, g);

    const hpFrac = veh
      ? clamp01(veh.health / veh.maxHealth)
      : clamp01(ent.health / ent.maxHealth);
    const bx = veh ? veh.position.x : ent.position.x;
    const bz = veh ? veh.position.z : ent.position.z;

    // ---- phases ---------------------------------------------------------
    const phase = Math.min(B.phases - 1, Math.floor((1 - hpFrac) * B.phases));
    if (phase !== M.phase) {
      M.phase = phase;
      g.notify(`Phase ${phase + 1}`, B.weak, 'bad');
      g.wq.uiSfx('kill', 1);
      const n = B.minions[Math.min(phase, B.minions.length - 1)];
      for (let i = 0; i < n; i++) {
        const a = (i / n) * Math.PI * 2;
        const s = g.wq.findGroundSpot(30, B.arena.r * 0.7, B.arena.x + Math.cos(a) * 20, B.arena.z + Math.sin(a) * 20);
        g.spawnHostile(M, s.x, s.z, {
          hp: Math.round(58 * g.diff.enemy),
          ranged: i % 2 === 0,
          dmg: Math.round(11 * g.diff.dmgIn),
          leash: B.arena.r * 1.2,
        });
      }
    }

    g.marker(M, 0, bx, bz, B.name, 'B');
    g.objective(M, M.tell ? `${M.tell} — MOVE` : B.weak, null,
      `Phase ${phase + 1} of ${B.phases}`, 1 - hpFrac, B.name);

    // ---- leash ----------------------------------------------------------
    const away = dist(g.px, g.pz, B.arena.x, B.arena.z);
    if (away > R.arena + B.arena.r) {
      M.leaveT = (M.leaveT ?? 0) + dt;
      if (M.leaveT > 10) return g.fail(M, 'You ran from the fight');
    } else M.leaveT = 0;

    if (veh) this._driver(M, dt, g, B, phase, veh);
    else this._melee(M, dt, g, B, phase, ent);
  },

  /* ----------------------------------------------------- escape phase -- */

  /**
   * He is down; his crooked cops are not. Wanted goes to four, the arena
   * leash is off (running is the point), and the chapter completes only when
   * the heat is fully shed — through `heat`'s own cooldown or the respray.
   */
  _escape(M, dt, g) {
    const c = M.def;
    if (!M.escapeOn) {
      M.escapeOn = true;
      M.escapeGrace = ESCAPE_GRACE;
      g.heat.raise(ESCAPE_STARS, g.px, g.pz);
      const ally = c.escapeAlly ?? BOY_ORDER.find((id) => id !== g.boyId) ?? 'dylan';
      g.say(ally, c.escapeLine ?? 'They called in the crooked cops — lose the heat!');
      g.notify(M.B.name, 'DOWN — NOW LOSE THE HEAT', 'gold');
      g.wq.uiSfx('kill', 1);
    }
    M.escapeGrace -= dt;
    const w = g.heat.wanted;
    const spray = g.wq.nearestShop(g.px, g.pz, 'spray');
    if (spray) g.marker(M, 0, spray.poi.x, spray.poi.z, spray.poi.name, 'S');
    g.objective(M, 'Lose the heat', null,
      w > 0 ? `${w} star${w === 1 ? '' : 's'} · find a respray` : 'Clear',
      1 - w / ESCAPE_STARS, 'Escape');
    if (w === 0 && M.escapeGrace <= 0) g.win(M);
  },

  /* ------------------------------------------------------------ on foot -- */
  _melee(M, dt, g, B, phase, e) {
    const d = dist(e.position.x, e.position.z, g.px, g.pz);

    // A queued attack that has finished telegraphing.
    if (M.tellT > 0) {
      M.tellT -= dt;
      if (M.tellT <= 0) {
        this._resolve(M, g, B, phase, e, d);
        M.tell = '';
        M.atkT = 1.7 - phase * 0.3;
      }
      return;
    }
    // A delayed payload (the grenade fuse, the volley's later rounds).
    if (M.pendingT > 0) {
      M.pendingT -= dt;
      if (M.pendingT <= 0) this._payload(M, g, B, phase, e);
    }

    M.atkT -= dt;
    const reach = B.kind === 'gunner' ? 46 : 10;
    if (M.atkT <= 0 && d < reach) {
      const list = B.attacks;
      const pick = list[g.rng.u32() % list.length];
      if (pick === 'call') {
        M.atkT = 8;
        for (let i = 0; i < 2; i++) {
          const s = g.wq.findGroundSpot(18, 40, e.position.x, e.position.z);
          g.spawnHostile(M, s.x, s.z, {
            hp: Math.round(52 * g.diff.enemy), ranged: true,
            dmg: Math.round(10 * g.diff.dmgIn), leash: B.arena.r,
          });
        }
        g.notify("He's calling more in", null, 'bad');
        return;
      }
      M.tell = TELL_NAME[pick] ?? 'ATTACK';
      M.tellKind = pick;
      M.tellT = Math.max(0.32, 0.85 - phase * 0.13);
      g.wq.uiSfx('grenade_warn', 0.7);
    }
  },

  /** The telegraph expired — land the hit. */
  _resolve(M, g, B, phase, e, d) {
    const kind = M.tellKind;
    const player = g.wq.player;
    const hit = (amount, radius) => {
      if (d > radius) return;
      g.hurtPlayer(amount * g.diff.dmgIn, e.position);
    };
    switch (kind) {
      case 'slam':
      case 'haymaker':
        g.wq.sfx('explosion', e.position, { gain: 0.35 });
        g.shake(0.45);
        hit(30 + phase * 8, 6.0);
        break;
      case 'sweep':
        g.wq.sfx('bodyfall', e.position, { gain: 0.6 });
        g.shake(0.3);
        hit(20 + phase * 6, 7.0);
        break;
      case 'charge':
        M.chargeT = 1.0;
        break;
      case 'volley':
        M.pending = 'volley';
        M.pendingN = 6;
        M.pendingT = 0.12;
        break;
      case 'grenade': {
        M.pending = 'grenade';
        M.gx = g.px + g.rng.range(-6, 6);
        M.gz = g.pz + g.rng.range(-6, 6);
        M.pendingT = 1.2;
        g.grenadeWarn(M.gx, M.gz);
        break;
      }
      default:
        hit(18, 5.0);
    }
    if (player?.addTrauma) player.addTrauma(0.2);
  },

  _payload(M, g, B, phase, e) {
    if (M.pending === 'volley') {
      g.tracerAt(e.position, 1.5);
      g.hurtPlayerIfNear(e.position, 46, (11 + phase * 3) * g.diff.dmgIn);
      M.pendingN--;
      M.pendingT = M.pendingN > 0 ? 0.14 : 0;
      if (M.pendingN <= 0) M.pending = '';
    } else if (M.pending === 'grenade') {
      g.explode(M.gx, M.gz, 11, 46 * g.diff.dmgIn);
      M.pending = '';
    }
  },

  /* ------------------------------------------------------------- driver -- */
  _driver(M, dt, g, B, phase, v) {
    const pv = g.wq.playerVehicle();
    const tx = pv ? pv.position.x : g.px;
    const tz = pv ? pv.position.z : g.pz;
    const d = driveToward(g.wq.vehicles, v, g._input, tx, tz, {
      throttle: 1, gain: 1.7, boost: phase >= 1,
    });
    // Ram damage — this is her whole game, and it is why the brothers tell you
    // to go for the rear wheels rather than meet her head on.
    if (d < 6 && Math.abs(v.forwardSpeed ?? 0) > 11) {
      if (pv) g.wq.damageVehicle(pv, 26 * dt * 6, v.position);
      else g.hurtPlayer(28 * g.diff.dmgIn, v.position);
      g.shake(0.4);
    }
    M.atkT -= dt;
    if (M.atkT <= 0 && d < 70) {
      M.atkT = 2.6 - phase * 0.5;
      for (let i = 0; i < 3; i++) g.tracerAt(v.position, 1.2);
      g.hurtPlayerIfNear(v.position, 70, (9 + phase * 3) * g.diff.dmgIn);
    }
  },
};
