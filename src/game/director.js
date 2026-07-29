/**
 * GAME — the spawn director.
 *
 * Answers three questions:
 *
 *   1. Where does the game start? The active brother's own turf, on his own
 *      street, at a sensible hour — never the world origin, which in Steel City
 *      is the middle of the Golden Triangle and belongs to nobody.
 *   2. Where is a brother when you switch to him, if he has never been played
 *      or has not been played since the clock moved on? GTA V's answer is "in
 *      the middle of his own life", and that is what `activityFor` encodes: a
 *      per-brother, per-time-of-day place and a one-line description of what he
 *      is doing when the camera finds him.
 *   3. What hour should the world be at on a fresh save, and what does sleeping
 *      at a safehouse do to it?
 *
 * Everything here is data plus lookups. It owns no state beyond the clock it
 * pushes into `sky`, and every position resolves through `data.js`, so nothing
 * drifts from the map.
 */

import { BOYZ, SAFEHOUSES, DOCKS, SHOPS, LANDMARKS, POI } from './data.js';

/**
 * Per-brother daily routine. `at` is a POI id from `data.js`; `line` is what
 * the HUD says when you drop in on him. Slots are [startHour, endHour).
 *
 * The three routines deliberately do not overlap in place: switching should
 * always move you somewhere you were not, across a river if possible, because
 * that is what sells the city as bigger than one man's errand.
 */
const ROUTINE = {
  carson: [
    { from: 5, to: 11, at: 'dock_south', line: 'Loading out at the South Side docks' },
    { from: 11, to: 17, at: 'dock_point', line: 'Running freight off the Point marina' },
    { from: 17, to: 22, at: 'sh_carson', line: 'Back at the boathouse, hosing the deck' },
    { from: 22, to: 5, at: 'sh_carson', line: 'Asleep on the boathouse cot' },
  ],
  aidan: [
    { from: 6, to: 12, at: 'sh_aidan', line: 'Under a bonnet on Butler Street' },
    { from: 12, to: 19, at: 'shop_ammo', line: 'Arguing about parts at Foundry Supply' },
    { from: 19, to: 23, at: 'sh_aidan', line: 'Closing up the body shop' },
    { from: 23, to: 6, at: 'sh_aidan', line: 'Asleep over the shop' },
  ],
  dylan: [
    { from: 7, to: 13, at: 'sh_dylan', line: 'Warming the car up on the hill' },
    { from: 13, to: 20, at: 'lm_incline', line: 'Waiting on a drop by the incline' },
    { from: 20, to: 3, at: 'shop_food2', line: 'Third coffee at the Incline Diner' },
    { from: 3, to: 7, at: 'sh_dylan', line: 'Not asleep. Never asleep.' },
  ],
};

/** A slot spans midnight when `to <= from`. */
function inSlot(s, hour) {
  return s.to > s.from ? hour >= s.from && hour < s.to : hour >= s.from || hour < s.to;
}

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);

/**
 * How good each `world.surfaceAt` value is to START on. A pavement is the
 * answer; asphalt is acceptable; grass and dirt are a bad look but survivable;
 * `sand` is the riverbank the last fix kept landing on and is only ever taken
 * when nothing else exists; water is never.
 */
const SURFACE_SCORE = {
  sidewalk: 4,
  asphalt: 3,
  gravel: 2,
  grass: 2,
  dirt: 2,
  sand: 1,
  water: -1,
};

export class Director {
  constructor(ctx, wq) {
    this.ctx = ctx;
    this.wq = wq;
    this.rng = ctx.rng.fork();
    this.hour = 8.5;
    this._onHour = null;
    /** Preallocated: `spawnFor` runs on every switch and must not allocate. */
    this._lane = { x: 0, y: 0, z: 0 };
    this._best = { x: 0, z: 0, yaw: 0, score: 0 };
    this._pose = { x: 0, y: null, z: 0, yaw: 0, score: 0 };
  }

  init(save) {
    this.hour = Number.isFinite(save?.clock) ? save.clock : 8.5;
    // `sky` owns the clock; follow it once it starts publishing.
    this._onHour = this.ctx.events.on('time:hour', (e) => {
      if (Number.isFinite(e?.hour)) this.hour = e.hour;
    });
    const sky = this.ctx.peek('sky');
    const live = sky?.hour ?? sky?.timeOfDay;
    if (Number.isFinite(live)) this.hour = live;
    return this;
  }

  /** Push a fresh save's opening hour into `sky`. Morning, per Carson CH1. */
  openWorld(save) {
    const sky = this.ctx.peek('sky');
    const h = Number.isFinite(save?.clock) ? save.clock : 8.5;
    this.hour = h;
    sky?.setTimeOfDay?.(h);
    return h;
  }

  /** `{ poi, line }` — where this brother is right now and what he is at. */
  activityFor(boyId, hour = this.hour) {
    const list = ROUTINE[boyId] ?? ROUTINE.carson;
    for (const s of list) {
      if (!inSlot(s, hour)) continue;
      const poi = POI.get(s.at) ?? POI.get(BOYZ[boyId]?.home) ?? SAFEHOUSES[0];
      return { poi, line: s.line, at: s.at };
    }
    const poi = POI.get(BOYZ[boyId]?.home) ?? SAFEHOUSES[0];
    return { poi, line: 'Waiting on a call', at: BOYZ[boyId]?.home };
  }

  /* ==================================================================== */
  /* WHERE A MAN'S FEET GO                                                */
  /* ==================================================================== */

  /**
   * THE SPAWN-IN-THE-RIVER BUG, and why it kept coming back.
   *
   * The player intermittently started the game swimming in the Monongahela,
   * and on the runs that "passed" he started on `sand` — a riverbank with no
   * street in sight. Three separate causes, all of which had to go:
   *
   *   1. **"Not water" is not "somewhere to stand."** The first fix spiralled
   *      out from the POI and took the first point that was not water. Sand,
   *      silt and marsh all satisfy that, so the bug simply moved from "in the
   *      river" to "beside the river", which is not a fix and is not GTA.
   *   2. **Carson's own POI is his BOATHOUSE**, which is on the water by
   *      definition, as are the docks and the marina. A radial search from a
   *      point in the river is fighting the geometry: it succeeds or fails on
   *      which bearing the RNG picked, which is exactly why it was
   *      intermittent — `ctx.rng.fork()` is seeded differently every boot.
   *   3. **A saved position was trusted blindly.** Quit while swimming, or
   *      load a save written by the broken version, and you respawn in the
   *      river for ever with no way out.
   *
   * So the authority is now the ROAD NETWORK, not the POI:
   * `roads.nearestEdge` -> `laneCenter` gives a real carriageway, and this
   * steps sideways off it onto the pavement. That buys three things at once —
   * solid ground, a place a vehicle can actually reach you, and a start on a
   * street like a GTA game. `world.spawnPoints` (already vetted, already on
   * lanes) is the fallback, and the radial search is the last resort rather
   * than the first attempt.
   */

  /** How good is this ground to stand on? Higher is better; < 1 is a reject. */
  _score(x, z) {
    const w = this.ctx.peek('world');
    if (!w) return 3;
    if (typeof w.isWater === 'function' && w.isWater(x, z)) return -1;
    const s = typeof w.surfaceAt === 'function' ? w.surfaceAt(x, z) : 'asphalt';
    return SURFACE_SCORE[s] ?? 2;
  }

  /**
   * Best standing pose on or beside the road nearest `(px, pz)`.
   * @returns {{x, z, yaw, score}|null}
   */
  _onRoad(px, pz, search = 400) {
    const roads = this.ctx.peek('world')?.roads;
    if (!roads?.nearestEdge || !roads.laneCenter) return null;
    const hit = roads.nearestEdge(px, pz, search);
    if (!hit?.edge) return null;
    // Copy immediately: `nearestEdge` returns a REUSED record and `surfaceAt`
    // calls it again on every probe below, which would overwrite it mid-loop.
    const edge = hit.edge;
    const t = clamp(hit.t ?? 0.5, 0.08, 0.92);

    const c = roads.laneCenter(edge, 0, t, this._lane);
    if (!Number.isFinite(c.x)) return null;
    const yaw = roads.laneYaw ? roads.laneYaw(edge, 0) : 0;
    // Forward is (sin yaw, cos yaw); right is a quarter turn from it.
    const rx = Math.cos(yaw);
    const rz = -Math.sin(yaw);

    const best = this._best;
    best.score = 0;
    // Walk out from the crown of the road to both kerbs. The pavement is a
    // couple of metres past the carriageway edge, but road widths vary by class
    // so probing beats assuming.
    for (let side = -1; side <= 1; side += 2) {
      for (let off = 2; off <= 16; off += 1) {
        const x = c.x + rx * side * off;
        const z = c.z + rz * side * off;
        const s = this._score(x, z);
        if (s > best.score) {
          best.score = s;
          best.x = x;
          best.z = z;
          // Face across the road, which is what you do when you step off a kerb.
          best.yaw = Math.atan2(-rx * side, -rz * side);
          if (s >= 4) return best;   // a pavement — stop looking
        }
      }
    }
    // No pavement anywhere: the lane itself, if it is dry.
    if (best.score < 3) {
      const s = this._score(c.x, c.z);
      if (s > best.score) {
        best.score = s;
        best.x = c.x;
        best.z = c.z;
        best.yaw = yaw;
      }
    }
    return best.score >= 2 ? best : null;
  }

  /**
   * Resolve any desired point to a pose a man can stand in. Never returns
   * null — the last fallback is the world's own first spawn point.
   */
  groundPose(px, pz, out = this._pose) {
    // 1. The road nearest the point.
    let hit = this._onRoad(px, pz, 400);
    // 2. Widen: from a point in the middle of a river the nearest edge can be a
    //    bridge deck, so probe from a ring of offsets too.
    if (!hit || hit.score < 3) {
      for (let i = 0; i < 8 && (!hit || hit.score < 4); i++) {
        const a = (i / 8) * Math.PI * 2;
        const r = 60 + (i & 1) * 90;
        const alt = this._onRoad(px + Math.cos(a) * r, pz + Math.sin(a) * r, 260);
        if (alt && alt.score > (hit?.score ?? 0)) {
          out.x = alt.x; out.z = alt.z; out.yaw = alt.yaw; out.score = alt.score;
          hit = out;
        }
      }
    }
    if (hit && hit.score >= 3) {
      out.x = hit.x; out.z = hit.z; out.yaw = hit.yaw; out.score = hit.score;
      out.y = null;
      return out;
    }

    // 3. A spawn point `world` already vetted — these are laid on lane centres.
    const sp = this.ctx.peek('world')?.spawnPoints?.[0];
    if (sp?.position && Number.isFinite(sp.position.x)) {
      out.x = sp.position.x;
      out.y = sp.position.y;
      out.z = sp.position.z;
      out.yaw = sp.yaw ?? 0;
      out.score = 3;
      return out;
    }

    // 4. Last resort: the best of a spiral around the point. Deterministic
    //    bearings — an RNG here is what made the original failure flaky.
    let bs = -1;
    out.x = px; out.z = pz; out.yaw = 0; out.y = null;
    for (let ring = 0; ring < 10; ring++) {
      const r = 8 + ring * 12;
      for (let i = 0; i < 16; i++) {
        const a = (i / 16) * Math.PI * 2 + ring * 0.19;
        const x = px + Math.cos(a) * r;
        const z = pz + Math.sin(a) * r;
        const s = this._score(x, z);
        if (s > bs) {
          bs = s;
          out.x = x; out.z = z; out.yaw = Math.atan2(px - x, pz - z);
        }
      }
      if (bs >= 3) break;
    }
    out.score = bs;
    return out;
  }

  /**
   * Is this a pose the game is willing to put a player in?
   *
   * `strict` is for a FRESH spawn, which should be a street. A SAVED position
   * is held to the lower bar of "not in the river": quitting on a riverbank is
   * a deliberate place to stand, and silently relocating the player 30 m onto
   * the nearest road is its own bug — it broke "returning to a brother finds
   * him where you left him" the first time this check went in.
   */
  isStandable(x, z, strict = false) {
    const s = this._score(x, z);
    return strict ? s >= 3 : s >= 1;
  }

  /**
   * The pose the game should place a brother at, honouring a saved position
   * first and falling back to his routine.
   *
   * A saved position is CHECKED, not trusted: quitting while swimming (or
   * loading a save written before the road-network spawn landed) must not put
   * you back in the river every time you press continue.
   *
   * @returns {{x, y, z, yaw, line, fresh}}
   */
  spawnFor(boyId, charSave) {
    if (charSave?.pos && Number.isFinite(charSave.pos[0])) {
      const [sx, sy, sz] = charSave.pos;
      if (this.isStandable(sx, sz)) {
        return { x: sx, y: sy, z: sz, yaw: charSave.yaw ?? 0, line: '', fresh: false };
      }
      // Rescue him onto the nearest street rather than discarding the save.
      const p = this.groundPose(sx, sz);
      return { x: p.x, y: p.y, z: p.z, yaw: p.yaw, line: 'Back on dry land', fresh: false };
    }
    const a = this.activityFor(boyId);
    const p = this.groundPose(a.poi.x, a.poi.z);
    return { x: p.x, y: p.y, z: p.z, yaw: p.yaw, line: a.line, fresh: true };
  }

  /** The starter car every brother finds at the kerb. */
  carFor(boyId) {
    return BOYZ[boyId]?.car ?? 'sedan';
  }

  /** Sleep: advance the clock and tell `sky`. */
  sleep(hours = 8) {
    this.hour = (this.hour + hours) % 24;
    this.ctx.peek('sky')?.setTimeOfDay?.(this.hour);
    return this.hour;
  }

  /** Free-roam flavour: is it a working hour, an evening, or the small hours? */
  get phase() {
    const h = this.hour;
    if (h < 5) return 'night';
    if (h < 8) return 'dawn';
    if (h < 17) return 'day';
    if (h < 20) return 'dusk';
    return 'night';
  }

  dispose() {
    this._onHour?.();
  }
}

/** Exported so a debug overlay can list the routine without reaching inside. */
export { ROUTINE };
export const DIRECTOR_POIS = { SAFEHOUSES, DOCKS, SHOPS, LANDMARKS };
