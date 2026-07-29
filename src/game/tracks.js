/**
 * GAME — the mission track types.
 *
 * DESIGN.md names eleven of them plus `boss`:
 *
 *   deliver · timedDeliver · race · chase · escape · escort · collect ·
 *   goons/brawl · survive · rampage · boss
 *
 * plus the four the story shape adds:
 *
 *   recover · protect · partner · final
 *
 * Every one is a small object with `init(M, c, g)` and `update(M, dt, g)`,
 * where `M` is the live mission record, `c` is the chapter definition out of
 * `data.js` and `g` is the `MissionRunner` that owns spawning, objectives,
 * markers and the win/fail verdict. Tracks never spawn anything directly —
 * they go through `g.spawnVehicle` / `g.spawnHostile` / `g.spawnPickup` so
 * that cleanup is automatic and a failed mission cannot leak a boss into free
 * roam.
 *
 * Distances are derived for a 3 km map rather than scaled up from the 700 m one
 * the track logic was originally authored against, and every track drives the
 * real subsystems rather than a single-file simulation.
 *
 * Rule 5: no allocation in `update`. Each track keeps its scratch on `M`.
 */

import { RACE_TRACKS, R, TIMED_STORY, MARK_GREEN, MARK_AMBER, REPAIR_TIME } from './data.js';
import { clamp01, dist, driveToward } from './util.js';

/* ===================================================================== */
/* helpers shared by several tracks                                       */
/* ===================================================================== */

/**
 * Where a chapter stages itself.
 *
 * `M.startPoi` is the place the chapter names — the docks, the mill, Butler
 * Street — and the runner's `travel` phase guarantees the player is standing
 * within `TRAVEL_ARRIVE` of it before any of these `init` functions run. So a
 * track can stage its content around the POI and know the player is there;
 * chapters that name nowhere stage around the player instead.
 */
function anchor(M, c, g) {
  if (M.startPoi) return M.startPoi;
  const p = g.wq.focusPos(g._anchorV);
  M._anchor.x = p.x;
  M._anchor.z = p.z;
  return M._anchor;
}

/** How much tougher an enemy is at this chapter's difficulty and setting. */
function enemyHp(c, g, base = 60) {
  return Math.round((base + c.difficulty * 14) * g.diff.enemy);
}
function enemyDmg(c, g, base = 10) {
  return Math.round((base + c.difficulty * 2) * g.diff.dmgIn);
}

/* ===================================================================== */

export const TRACKS = {
  /* ------------------------------------------------------------------- */
  /* deliver — take the marked vehicle to the drop                        */
  /* ------------------------------------------------------------------- */
  deliver: {
    init(M, c, g) {
      const dest = g.wq.poi(c.dest) ?? g.wq.nearestSafehouse(0, 0).poi;
      M.dest = dest;
      const a = anchor(M, c, g);
      const boat = c.vehType === 'boat';
      // A boat is moored where you can walk to it; a car is on a real lane.
      const spot = boat
        ? g.wq.findWaterSpot(25, 140, a.x, a.z, undefined, true)
        : g.wq.findRoadSpot(40, 160, a.x, a.z);
      M.veh = g.spawnVehicle(M, c.vehType ?? 'sedan', spot.x, spot.z, spot.yaw, { tag: 'deliver' });
      if (M.veh) {
        // The job is the delivery, not surviving a fender bender.
        M.veh.maxHealth *= 1.6;
        M.veh.health = M.veh.maxHealth;
        // The objective vehicle glows — green fetch, amber when it is timed.
        g.markVehicle(M, M.veh, c.track === 'timedDeliver' ? MARK_AMBER : MARK_GREEN);
      }
      // Hard+ puts a clock on the plain delivery (the `timedStory` flag).
      if (c.track === 'deliver' && !M.hasTimer && g.diff.timedStory) {
        g.armTimer(M, TIMED_STORY.deliver);
      }
      M.aboard = false;
    },
    update(M, dt, g) {
      if (!M.veh) return g.fail(M, 'The vehicle never arrived');
      if (M.veh.destroyed) return g.fail(M, 'The vehicle was wrecked');
      const pv = g.wq.playerVehicle();
      if (pv === M.veh) {
        if (!M.aboard) {
          M.aboard = true;
          g.say(g.boyId, M.dest.name === 'DeCarlo Body Shop' ? 'Right. Home it goes.' : null);
        }
        g.marker(M, 0, M.dest.x, M.dest.z, M.dest.name, 'D', R.dropoff);
        g.objective(M, `Deliver to ${M.dest.name}`, null,
          Math.round(dist(M.veh.position.x, M.veh.position.z, M.dest.x, M.dest.z)) + ' m');
        if (dist(M.veh.position.x, M.veh.position.z, M.dest.x, M.dest.z) < R.dropoff) g.win(M);
      } else {
        g.marker(M, 0, M.veh.position.x, M.veh.position.z, 'Your ride', 'V');
        g.objective(M, 'Get in the marked vehicle', null,
          Math.round(dist(M.veh.position.x, M.veh.position.z, g.px, g.pz)) + ' m');
      }
      if (M.state === 'run' && M.hasTimer && M.timer <= 0) g.fail(M, 'Out of time');
    },
  },

  /* ------------------------------------------------------------------- */
  /* timedDeliver — the same job with a clock                             */
  /* ------------------------------------------------------------------- */
  timedDeliver: {
    init(M, c, g) {
      TRACKS.deliver.init(M, c, g);
    },
    update(M, dt, g) {
      TRACKS.deliver.update(M, dt, g);
      if (M.state === 'run' && M.timer <= 0) g.fail(M, 'Out of time');
    },
  },

  /* ------------------------------------------------------------------- */
  /* goons — kill N, out in the open                                      */
  /* ------------------------------------------------------------------- */
  goons: {
    init(M, c, g) {
      const a = anchor(M, c, g);
      for (let i = 0; i < M.goal; i++) {
        const s = g.wq.findGroundSpot(45, 150, a.x, a.z);
        g.spawnHostile(M, s.x, s.z, {
          hp: enemyHp(c, g, 62),
          ranged: i % 3 !== 0,
          dmg: enemyDmg(c, g, 10),
        });
      }
      M.topUpT = 0;
    },
    update(M, dt, g) {
      const alive = g.aliveHostiles(M);
      M.progress = M.goal - alive;
      g.objective(M, 'Take them down', null, `${M.progress} / ${M.goal}`, M.progress / M.goal);
      const near = g.nearestHostile(M);
      if (near) g.marker(M, 0, near.position.x, near.position.z, 'Target', 'X');
      if (alive === 0) return g.win(M);

      // If the player drives off, bring the fight to him rather than making
      // him retrace 400 m of city.
      M.topUpT -= dt;
      if (M.topUpT <= 0) {
        M.topUpT = 2;
        if (near && dist(near.position.x, near.position.z, g.px, g.pz) > 320) {
          for (const h of g.hostilesOf(M)) {
            if (h.dead) continue;
            const s = g.wq.findGroundSpot(70, 150, g.px, g.pz);
            h.position.set(s.x, s.y, s.z);
            h.homeX = s.x;
            h.homeZ = s.z;
          }
          g.notify('They found you', null, 'bad');
        }
      }
    },
  },

  /* ------------------------------------------------------------------- */
  /* brawl — the same count, in a ring, hands and steel                   */
  /* ------------------------------------------------------------------- */
  brawl: {
    init(M, c, g) {
      const a = anchor(M, c, g);
      M.arena.x = a.x;
      M.arena.z = a.z;
      M.arena.r = R.brawlLeash;
      for (let i = 0; i < M.goal; i++) {
        const ang = (i / M.goal) * Math.PI * 2;
        const x = a.x + Math.cos(ang) * 26;
        const z = a.z + Math.sin(ang) * 26;
        g.spawnHostile(M, x, z, {
          hp: enemyHp(c, g, 70),
          ranged: false,
          dmg: enemyDmg(c, g, 13),
          leash: R.brawlLeash * 0.8,
        });
      }
      M.leaveT = 0;
    },
    update(M, dt, g) {
      const alive = g.aliveHostiles(M);
      M.progress = M.goal - alive;
      if (alive === 0) return g.win(M);
      g.marker(M, 0, M.arena.x, M.arena.z, 'The yard', 'A');

      const away = dist(g.px, g.pz, M.arena.x, M.arena.z);
      if (away > M.arena.r) {
        M.leaveT += dt;
        g.objective(M, 'Get back in the fight', 6 - M.leaveT, 'Leaving the area');
        if (M.leaveT > 6) return g.fail(M, 'You walked away');
      } else {
        M.leaveT = 0;
        g.objective(M, 'Hands only — put them down', null, `${M.progress} / ${M.goal}`, M.progress / M.goal);
      }
    },
  },

  /* ------------------------------------------------------------------- */
  /* race — checkpoint circuit, laps, three rivals                        */
  /* ------------------------------------------------------------------- */
  race: {
    init(M, c, g) {
      const track = RACE_TRACKS[c.trackId] ?? RACE_TRACKS.triangle;
      M.circuit = track;
      M.points = track.points;
      M.cpIdx = 0;
      M.lap = 0;
      M.laps = c.laps ?? track.laps ?? 1;

      // The runner's `travel` phase has already put the player at the start
      // line, so all that is left is to make sure he has something to drive.
      const start = M.points[0];
      const next = M.points[1 % M.points.length];
      const yaw = Math.atan2(next.x - start.x, next.z - start.z);
      if (!g.wq.playerVehicle()) {
        const s = g.wq.findRoadSpot(8, 40, g.px, g.pz);
        M.veh = g.spawnVehicle(M, g.boy.car ?? 'sports', s.x, s.z, yaw);
      }

      M.rivals.length = 0;
      for (let i = 0; i < 3; i++) {
        const s = g.wq.findRoadSpot(18, 60, start.x, start.z);
        const r = g.spawnVehicle(M, i === 0 ? 'muscle' : 'sports', s.x, s.z, yaw, { tag: 'rival' });
        if (!r) continue;
        r.raceCp = 1;
        r.raceLap = 0;
        // A rival that is quicker than the player at difficulty 5 and slower at
        // difficulty 1 — the pace comes from throttle discipline, not cheating.
        r.racePace = 0.78 + c.difficulty * 0.035 + i * 0.02;
        M.rivals.push(r);
      }
      M.bestLap = 0;
      M.lapT = 0;
    },
    update(M, dt, g) {
      const cps = M.points;
      const cp = cps[M.cpIdx];
      M.lapT += dt;
      g.marker(M, 0, cp.x, cp.z, `Checkpoint ${M.cpIdx + 1}`, String(M.cpIdx + 1), R.checkpoint);

      const src = g.wq.playerVehicle() ?? g.wq.player;
      const sx = src?.position?.x ?? g.px;
      const sz = src?.position?.z ?? g.pz;
      if (dist(sx, sz, cp.x, cp.z) < R.checkpoint) {
        M.cpIdx++;
        g.wq.uiSfx('hitmarker', 0.55);
        if (M.cpIdx >= cps.length) {
          M.cpIdx = 0;
          M.lap++;
          if (M.bestLap === 0 || M.lapT < M.bestLap) M.bestLap = M.lapT;
          M.lapT = 0;
          if (M.lap >= M.laps) return g.win(M);
          g.notify(`Lap ${M.lap + 1} of ${M.laps}`, null, 'gold');
        }
      }

      // Rival standings, for the count line.
      let ahead = 0;
      for (const r of M.rivals) {
        if (!r || r.destroyed) continue;
        const total = r.raceLap * cps.length + r.raceCp;
        if (total > M.lap * cps.length + M.cpIdx) ahead++;
      }
      g.objective(
        M,
        `Checkpoint ${M.cpIdx + 1} of ${cps.length}`,
        null,
        M.laps > 1 ? `Lap ${M.lap + 1}/${M.laps} · P${ahead + 1}` : `P${ahead + 1}`,
        (M.lap * cps.length + M.cpIdx) / (M.laps * cps.length)
      );

      if (M.hasTimer && M.timer <= 0) return g.fail(M, 'Out of time');
      this.driveRivals(M, dt, g);
    },

    driveRivals(M, dt, g) {
      const veh = g.wq.vehicles;
      const cps = M.points;
      for (const r of M.rivals) {
        if (!r || r.destroyed) continue;
        const t = cps[r.raceCp % cps.length];
        if (dist(r.position.x, r.position.z, t.x, t.z) < R.checkpoint) {
          r.raceCp++;
          if (r.raceCp % cps.length === 0) r.raceLap++;
        }
        // Aim a little past the gate so they carry speed through it.
        const nxt = cps[(r.raceCp + 1) % cps.length];
        const aimX = t.x + (nxt.x - t.x) * 0.18;
        const aimZ = t.z + (nxt.z - t.z) * 0.18;
        driveToward(veh, r, g._input, aimX, aimZ, { throttle: r.racePace, gain: 1.5 });
      }
    },
  },

  /* ------------------------------------------------------------------- */
  /* chase — run the target down                                          */
  /* ------------------------------------------------------------------- */
  chase: {
    init(M, c, g) {
      const a = anchor(M, c, g);
      const s = g.wq.findRoadSpot(180, 320, a.x, a.z);
      M.target = g.spawnVehicle(M, 'muscle', s.x, s.z, s.yaw, { tag: 'target' });
      if (M.target) {
        M.target.maxHealth = M.target.health = 260 + c.difficulty * 70;
        M.target.isMissionTarget = true;
      }
      if (!g.wq.playerVehicle()) {
        const p = g.wq.findRoadSpot(10, 45, g.px, g.pz);
        M.veh = g.spawnVehicle(M, g.boy.car ?? 'sports', p.x, p.z, p.yaw);
      }
      M.fleeT = 0;
    },
    update(M, dt, g) {
      const t = M.target;
      if (!t) return g.fail(M, 'The target got away');
      if (t.destroyed) return g.win(M);
      g.marker(M, 0, t.position.x, t.position.z, 'Target', 'X');
      const d = dist(t.position.x, t.position.z, g.px, g.pz);
      const hp = Math.round(clamp01(t.health / t.maxHealth) * 100);
      g.objective(M, 'Wreck the target', null, `${Math.round(d)} m · ${hp}%`, 1 - t.health / t.maxHealth);

      // Flee: pick a point directly away from the player and drive at it,
      // re-picked every couple of seconds so he does not head into the river.
      M.fleeT -= dt;
      if (M.fleeT <= 0 || M.fleeX === undefined) {
        M.fleeT = 2.2;
        const away = Math.atan2(t.position.x - g.px, t.position.z - g.pz);
        const s = g.wq.findRoadSpot(160, 300, t.position.x + Math.sin(away) * 120, t.position.z + Math.cos(away) * 120);
        M.fleeX = s.x;
        M.fleeZ = s.z;
      }
      driveToward(g.wq.vehicles, t, g._input, M.fleeX, M.fleeZ, { throttle: 1, boost: d < 60 });
      if (d > R.chaseLose) return g.fail(M, 'The target got away');
    },
  },

  /* ------------------------------------------------------------------- */
  /* escape — shed N stars                                                */
  /* ------------------------------------------------------------------- */
  escape: {
    init(M, c, g) {
      M.needStars = c.stars ?? 3;
      g.heat.raise(M.needStars, g.px, g.pz);
      M.graceT = 2.5;
      if (!g.wq.playerVehicle()) {
        const p = g.wq.findRoadSpot(10, 40, g.px, g.pz);
        M.veh = g.spawnVehicle(M, g.boy.car ?? 'sports', p.x, p.z, p.yaw);
      }
    },
    update(M, dt, g) {
      const w = g.heat.wanted;
      M.graceT -= dt;
      const spray = g.wq.nearestShop(g.px, g.pz, 'spray');
      if (spray) g.marker(M, 0, spray.poi.x, spray.poi.z, spray.poi.name, 'S');
      g.objective(
        M,
        'Shake the police',
        null,
        w > 0 ? `${w} star${w === 1 ? '' : 's'} · find a respray` : 'Heat off',
        1 - w / Math.max(1, M.needStars)
      );
      // The respray itself lives in `freeroam.js` so it works outside a
      // mission too; the track only has to notice the result.
      if (w === 0 && M.graceT <= 0) g.win(M);
    },
  },

  /* ------------------------------------------------------------------- */
  /* collect — N crates, optionally on the water, optionally on a clock   */
  /* ------------------------------------------------------------------- */
  collect: {
    init(M, c, g) {
      const a = anchor(M, c, g);
      const water = !!c.water;
      const spread = c.spread ?? 380;
      for (let i = 0; i < M.goal; i++) {
        const s = water
          ? g.wq.findWaterSpot(60, spread, a.x, a.z)
          : g.wq.findGroundSpot(60, spread, a.x, a.z);
        g.spawnPickup(M, s.x, s.z, 'crate', { mission: true, y: water ? 1.1 : undefined });
      }
    },
    update(M, dt, g) {
      const left = g.pickups.countMission();
      M.progress = M.goal - left;
      g.objective(M, 'Gather the crates', null, `${M.progress} / ${M.goal}`, M.progress / M.goal);
      const n = g.pickups.nearestMission(g.px, g.pz);
      if (n) g.marker(M, 0, n.x, n.z, 'Crate', 'C');
      if (left === 0) return g.win(M);
      if (M.hasTimer && M.timer <= 0) g.fail(M, 'Out of time');
    },
  },

  /* ------------------------------------------------------------------- */
  /* survive — hold the ground for N seconds                              */
  /* ------------------------------------------------------------------- */
  survive: {
    init(M, c, g) {
      const a = anchor(M, c, g);
      M.duration = (c.duration ?? 90) * (g.diff.timerMul ?? g.diff.time);
      M.timer = M.duration;
      M.hasTimer = true;
      M.hold.x = a.x;
      M.hold.z = a.z;
      M.waveT = 2;
      M.wave = 0;
      M.leaveT = 0;
      // Put the player on the hold point if the chapter named one far away.
      if (dist(g.px, g.pz, a.x, a.z) > R.holdLeash) g.wq.placePlayer(a.x, a.z, 0);
    },
    update(M, dt, g) {
      g.marker(M, 0, M.hold.x, M.hold.z, 'Hold here', 'H');
      const away = dist(g.px, g.pz, M.hold.x, M.hold.z);
      if (away > R.holdLeash) {
        M.leaveT += dt;
        g.objective(M, 'Return to the hold point', M.timer, 'Abandoning position');
        if (M.leaveT > 8) return g.fail(M, 'You abandoned the position');
      } else {
        M.leaveT = 0;
        g.objective(M, 'Hold this ground', M.timer, `Wave ${M.wave + 1}`,
          1 - M.timer / M.duration);
      }

      M.waveT -= dt;
      const alive = g.aliveHostiles(M);
      if (M.waveT <= 0 && alive < 7) {
        M.waveT = 7;
        M.wave++;
        const n = 2 + Math.floor(M.wave / 2);
        for (let i = 0; i < n; i++) {
          const s = g.wq.findGroundSpot(60, 130, M.hold.x, M.hold.z);
          g.spawnHostile(M, s.x, s.z, {
            hp: Math.round((55 + M.wave * 9) * g.diff.enemy),
            ranged: g.rng.float() < 0.5,
            dmg: Math.round((10 + M.wave) * g.diff.dmgIn),
            leash: R.holdLeash * 1.4,
          });
        }
        if (M.wave > 1) g.notify(`Wave ${M.wave}`, null, 'bad');
      }

      if (M.timer <= 0) g.win(M);
    },
  },

  /* ------------------------------------------------------------------- */
  /* escort — keep a slow ally alive to the drop                          */
  /* ------------------------------------------------------------------- */
  escort: {
    init(M, c, g) {
      const a = anchor(M, c, g);
      const s = g.wq.findRoadSpot(20, 70, a.x, a.z);
      M.ally = g.spawnVehicle(M, 'truck', s.x, s.z, s.yaw, { tag: 'ally' });
      if (M.ally) {
        M.ally.maxHealth = M.ally.health = 520;
        M.ally.isAlly = true;
      }
      M.dest = g.wq.poi(c.dest) ?? g.wq.nearestSafehouse(s.x, s.z).poi;
      M.attackT = 8;
      M.warnT = 0;
      if (!g.wq.playerVehicle()) {
        const p = g.wq.findRoadSpot(10, 36, s.x, s.z);
        M.veh = g.spawnVehicle(M, g.boy.car ?? 'sports', p.x, p.z, p.yaw);
      }
    },
    update(M, dt, g) {
      const a = M.ally;
      if (!a) return g.fail(M, 'The truck never made it out');
      if (a.destroyed) return g.fail(M, 'The truck was destroyed');
      g.marker(M, 0, M.dest.x, M.dest.z, M.dest.name, 'D', R.dropoff);
      g.marker(M, 1, a.position.x, a.position.z, 'The truck', 'T');
      const hull = Math.round(clamp01(a.health / a.maxHealth) * 100);
      const d = dist(a.position.x, a.position.z, M.dest.x, M.dest.z);
      g.objective(M, `Escort the truck to ${M.dest.name}`, null, `${hull}% hull · ${Math.round(d)} m`,
        clamp01(1 - d / Math.max(1, M.escortStart ?? d)));
      if (M.escortStart === undefined) M.escortStart = d;

      // Dylan is driving it and he is, per the chapter, slow and complaining.
      driveToward(g.wq.vehicles, a, g._input, M.dest.x, M.dest.z, { throttle: 0.62, gain: 1.4, slow: 26 });
      if (d < R.dropoff) return g.win(M);

      if (hull < 45 && M.warnT <= 0) {
        M.warnT = 12;
        g.say('dylan', "This truck is not built for this!");
      }
      M.warnT -= dt;

      // Ambushers, in cars, aimed at the truck rather than at the player.
      M.attackT -= dt;
      if (M.attackT <= 0) {
        M.attackT = 11;
        const s = g.wq.findRoadSpot(180, 300, a.position.x, a.position.z);
        const at = g.spawnVehicle(M, 'muscle', s.x, s.z, s.yaw, { tag: 'ambush' });
        if (at) { at.isAmbush = true; at.chaseTarget = a; }
      }
      for (const v of g.vehiclesOf(M)) {
        if (!v.isAmbush || v.destroyed) continue;
        const dd = driveToward(g.wq.vehicles, v, g._input, a.position.x, a.position.z, { throttle: 1, boost: true });
        if (dd < 6.5) g.wq.damageVehicle(a, 34 * dt, v.position);
      }
    },
  },

  /* ------------------------------------------------------------------- */
  /* rampage — wreck N targets on a clock                                 */
  /* ------------------------------------------------------------------- */
  rampage: {
    init(M, c, g) {
      const a = anchor(M, c, g);
      M.timer = (c.baseTimer ?? 100) * (g.diff.timerMul ?? g.diff.time);
      M.hasTimer = true;
      const types = ['van', 'truck', 'muscle'];
      for (let i = 0; i < M.goal; i++) {
        const s = g.wq.findRoadSpot(70, c.spread ?? 400, a.x, a.z);
        const v = g.spawnVehicle(M, types[i % types.length], s.x, s.z, s.yaw, { tag: 'rampage' });
        if (v) {
          v.isRampage = true;
          v.maxHealth = v.health = 210;
        }
      }
    },
    update(M, dt, g) {
      let left = 0;
      let near = null;
      let nd = Infinity;
      for (const v of g.vehiclesOf(M)) {
        if (!v.isRampage || v.destroyed) continue;
        left++;
        const d = dist(v.position.x, v.position.z, g.px, g.pz);
        if (d < nd) { nd = d; near = v; }
      }
      M.progress = M.goal - left;
      g.objective(M, 'Wreck the convoy', null, `${M.progress} / ${M.goal}`, M.progress / M.goal);
      if (near) g.marker(M, 0, near.position.x, near.position.z, 'Target', 'X');
      if (left === 0) return g.win(M);
      if (M.timer <= 0) g.fail(M, 'Out of time');
    },
  },

  /* ------------------------------------------------------------------- */
  /* recover — N marked stolen cars, each driven back to the home ring    */
  /* ------------------------------------------------------------------- */
  /* The marked cars glow green across the map, delivering one unmarks it,
   * bumps progress and steps you OUT of it, a wrecked marked car fails the
   * chapter, and hard+ puts 260 s on the whole job. */
  recover: {
    init(M, c, g) {
      M.dest = g.wq.poi(c.dest) ?? g.wq.nearestSafehouse(g.px, g.pz).poi;
      const types = ['muscle', 'sedan', 'sports'];
      for (let i = 0; i < M.goal; i++) {
        // One car per third of the compass, 260-620 m out, so the map reads
        // as "they are all over the Burgh" and no two spawn on one street.
        const bear = ((i + 0.5) / M.goal) * Math.PI * 2;
        const s = g.wq.findRoadSpot(120, 320,
          M.dest.x + Math.cos(bear) * 300, M.dest.z + Math.sin(bear) * 300);
        const v = g.spawnVehicle(M, types[i % types.length], s.x, s.z, s.yaw, { tag: 'recover' });
        if (v) g.markVehicle(M, v, MARK_GREEN);
      }
      M.progress = 0;
      if (!M.hasTimer && g.diff.timedStory) g.armTimer(M, TIMED_STORY.recover);
    },
    update(M, dt, g) {
      let nearest = null;
      let nd = Infinity;
      for (const v of g.vehiclesOf(M)) {
        if (!v._marked) continue;
        if (v.destroyed) return g.fail(M, 'A marked car was wrecked');
        const d = dist(v.position.x, v.position.z, g.px, g.pz);
        if (d < nd) { nd = d; nearest = v; }
      }
      const pv = g.wq.playerVehicle();
      if (pv && pv._marked) {
        g.marker(M, 0, M.dest.x, M.dest.z, M.dest.name, 'D', R.dropoff);
        const d = dist(pv.position.x, pv.position.z, M.dest.x, M.dest.z);
        g.objective(M, `Bring it home to ${M.dest.name}`, null,
          `${M.progress} / ${M.goal} · ${Math.round(d)} m`, M.progress / M.goal);
        if (d < R.dropoff) {
          g.unmarkVehicle(pv);
          M.progress++;
          g.wq.uiSfx('regen', 0.9);
          if (M.progress >= M.goal) return g.win(M);
          g.notify('Recovered', `${M.progress} / ${M.goal}`, 'gold');
          // Out you get, go fetch the next one.
          g.forceExit();
        }
      } else if (nearest) {
        g.marker(M, 0, nearest.position.x, nearest.position.z, 'Marked car', 'V');
        g.objective(M, 'Get in a marked car', null,
          `${M.progress} / ${M.goal} · ${Math.round(nd)} m`, M.progress / M.goal);
      }
      if (M.state === 'run' && M.hasTimer && M.timer <= 0) g.fail(M, 'Out of time');
    },
  },

  /* ------------------------------------------------------------------- */
  /* protect — keep the named brother alive, drop N attackers             */
  /* ------------------------------------------------------------------- */
  /* The ward is a named ally pinned on a guard anchor with `noRevive` and his
   * HP bar in the HUD. Waves of three every 9 s aimed at HIM, a kill pulling
   * the next wave to 4 s, mission fails the moment he goes down, completes at
   * `goal` kills. The ward's HP is published on `game.getHudState().ward` for
   * `ui` to draw. */
  protect: {
    init(M, c, g) {
      const a = anchor(M, c, g);
      const s = g.wq.findGroundSpot(5, 12, a.x, a.z);
      const ward = g.spawnWard(M, s.x, s.z, c.ward ?? 'dylan', WARD_HP);
      if (!ward) return g.fail(M, 'He never made it here');
      M.hold.x = s.x;
      M.hold.z = s.z;
      M.waveT = 3;
      M.wave = 0;
      M.kills = 0;
      M._seenKills = 0;
      M.progress = 0;
    },
    update(M, dt, g) {
      const w = M.ward;
      if (!w) return g.fail(M, 'He never made it here');
      if (w.health <= 0) return g.fail(M, `${w.name} went down`);
      M.progress = M.kills;
      if (M.kills >= M.goal) return g.win(M);
      // A kill brings the next wave sooner.
      if (M.kills > M._seenKills) {
        M._seenKills = M.kills;
        M.waveT = Math.min(M.waveT, 4);
      }
      g.marker(M, 0, w.x, w.z, w.name, 'W', 10);
      g.objective(M, `Keep ${w.name} alive`, null, `${M.kills} / ${M.goal}`, M.kills / M.goal);

      M.waveT -= dt;
      if (M.waveT <= 0) {
        M.waveT = 9;
        M.wave++;
        for (let i = 0; i < 3; i++) {
          const s = g.wq.findGroundSpot(35, 80, w.x, w.z);
          const h = g.spawnHostile(M, s.x, s.z, {
            hp: enemyHp(M.def, g, 58),
            ranged: M.def.difficulty >= 4 && i % 2 === 0,
            dmg: enemyDmg(M.def, g, 9),
            // Leashed to the WARD, not the player: this is what makes them
            // besiegers rather than a posse that chases you off the map.
            leash: 60,
          });
          if (h) { h.homeX = w.x; h.homeZ = w.z; }
        }
        if (M.wave > 1) g.notify(`Wave ${M.wave}`, null, 'bad');
      }

      // Attackers in his face chip him down — `hostiles` only ever fights the
      // player, so the siege damage is the track's arithmetic, exactly like
      // the escort ambushers ramming the truck.
      for (const h of g.hostilesOf(M)) {
        if (!h.active || h.dead) continue;
        if (dist(h.position.x, h.position.z, w.x, w.z) < R.wardAttack) {
          g.hurtWard(M, h.damage * 0.55 * dt);
        }
      }
    },
  },

  /* ------------------------------------------------------------------- */
  /* partner — drive to them, then fix the car on foot in the ring        */
  /* ------------------------------------------------------------------- */
  /* A timed-on-hard approach to the partner's zone, then the clock STOPS and
   * the minigame starts — on foot within 4.5 m of the dead sedan, the repair
   * fills over 6 s with a live percentage, sparks and a tick every 0.4 s, and
   * the chapter completes at 100%. */
  partner: {
    init(M, c, g) {
      M.dest = g.wq.poi(c.dest) ?? g.wq.poi(g.boy.home);
      M.step = 0;
      M.repair = 0;
      if (!M.hasTimer && g.diff.timedStory) g.armTimer(M, TIMED_STORY.partner);
    },
    update(M, dt, g) {
      const c = M.def;
      const pname = g.boy.partner?.name ?? 'them';
      if (M.step === 0) {
        g.marker(M, 0, M.dest.x, M.dest.z, pname, 'P', 14);
        const d = dist(g.px, g.pz, M.dest.x, M.dest.z);
        g.objective(M, `Get to ${pname} — ${M.dest.name}`, null, `${Math.round(d)} m`);
        if (M.hasTimer && M.timer <= 0) return g.fail(M, 'You left them waiting');
        if (d < R.partnerZone) {
          M.step = 1;
          // The approach was the race; the repair is not, so the clock stops
          // at the flip.
          M.hasTimer = false;
          M.timer = 0;
          const s = g.wq.findRoadSpot(6, 26, M.dest.x, M.dest.z);
          M.veh = g.spawnVehicle(M, 'sedan', s.x, s.z, s.yaw, { tag: 'partner' });
          if (M.veh) {
            // Dead on the kerb: real damage so the body wears the trouble.
            g.wq.damageVehicle(M.veh, M.veh.maxHealth * 0.72, M.veh.position);
          }
          const ps = g.wq.findGroundSpot(2.5, 5, s.x, s.z);
          const partner = g.boy.partner;
          if (partner) {
            g.spawnFigure(M, ps.x, ps.z, {
              id: partner.id,
              name: partner.name,
              color: parseInt(partner.color.slice(1), 16),
              accent: parseInt(partner.color.slice(1), 16),
            });
            g.say(partner.id, c.partnerLine ?? 'You made it! Can you take a look?');
          }
        }
      } else {
        const v = M.veh;
        if (!v) return g.fail(M, 'The car is gone');
        if (v.destroyed) return g.fail(M, 'You wrecked the car. Date night is off');
        g.marker(M, 0, v.position.x, v.position.z, 'The car', 'R', R.repair);
        const onFoot = !g.wq.playerVehicle();
        const d = dist(g.px, g.pz, v.position.x, v.position.z);
        if (onFoot && d < R.repair) {
          M.repair += (dt / REPAIR_TIME) * 100;
          g.repairFx(M, v);
          g.objective(M, `Repairing the car — ${Math.min(99, Math.floor(M.repair))}%`,
            null, '', clamp01(M.repair / 100), 'Repair');
          if (M.repair >= 100) {
            v.health = v.maxHealth;
            g.notify('Car fixed', null, 'gold');
            return g.win(M);
          }
        } else {
          g.objective(M, `Repair ${pname}'s car — stand by it on foot`,
            null, `${Math.round(d)} m`, clamp01(M.repair / 100), 'Repair');
        }
      }
    },
  },

  /* ------------------------------------------------------------------- */
  /* final — zero-reward homecoming into the ending                       */
  /* ------------------------------------------------------------------- */
  /* A marker on home, nothing spawned, nothing paid — arriving triggers the
   * ending. `MissionRunner.win` routes a `final` chapter into `_ending`
   * (slides, story-done flag, the all-weapons unlock) instead of the result
   * card. */
  final: {
    init(M, c, g) {
      M.dest = g.wq.poi(c.dest) ?? g.wq.poi(g.boy.home);
    },
    update(M, dt, g) {
      g.marker(M, 0, M.dest.x, M.dest.z, M.dest.name, 'H', R.finalZone);
      const d = dist(g.px, g.pz, M.dest.x, M.dest.z);
      g.objective(M, `Drive home to ${M.dest.name}`, null, `${Math.round(d)} m`, -1, 'Homecoming');
      if (d < R.finalZone) return g.win(M);
    },
  },
};

/** A protect ward's health pool. Flat: he is family, not a difficulty knob. */
const WARD_HP = 320;

/* ===================================================================== */
/* the objective eyebrow, shared                                          */
/* ===================================================================== */

export function trackOf(id) {
  return TRACKS[id] ?? null;
}
