/**
 * GAME — THE JET CHASE. Two interceptors scrambled after a stolen military jet.
 *
 * When the player boards a 'jet' inside the Ridgeline AFB perimeter (see
 * `airbase.js`, which owns the trigger), this module spawns two pursuit jets
 * at the published `world.airbase.runwayStart`, takes them off down the real
 * runway, and chases the player's aircraft — through the SAME input surface
 * the flight model consumes. Nothing here reaches into `stepPlane`: every
 * pursuer is an ordinary `Vehicle` of class 'jet' fed via `vehicles.setInput`
 * (`throttle`/`brake` = elevator, `steer` = ailerons, `boost` = throttle
 * lever/reheat, `handbrake` = lever down + wheel brakes), exactly the fields a
 * player at the keyboard drives. The AI is therefore subject to the same
 * physics: it has to build speed down the runway before it can rotate, it
 * stalls if it gets slow, and its turns are banked because that is the only
 * way `stepPlane` turns.
 *
 * STEER SIGN, settled empirically rather than re-derived: `flightprobe.mjs`
 * measures "steer +1 rolls right (right wing DOWN, bank negative) and heading
 * (atan2 convention) increases" WITH the auto-reverse sign a player gets
 * (`v.autoReverse = true`). The pursuers set the same flag. For a plane
 * `autoReverse` does nothing else (the drivetrain mapping is not on the
 * 'plane' path).
 *
 * THE CONTROL LAW IS A BANK-ATTITUDE LOOP, NOT A HEADING LOOP — and that is
 * a lesson paid for, not a preference. The first cut steered
 * `steer = clamp(headingErr * k)`, the convention `heat.js` uses for its
 * ground cruisers, and it FLEW AWAY: with the target astern the error
 * saturates the aileron, and the jet's spec (`rollAuth 3.6` against
 * `rollStab 0.20`) has no bank equilibrium under held full aileron — full
 * deflection out-torques the dihedral at every bank angle, so the jet
 * BARREL-ROLLS continuously (measured: bank 12 -> 75 -> 136 -> -177 -> ...
 * while the heading random-walked and the pair climbed 2.3 km away until the
 * escape timer ended the chase). A heading controller is only valid when its
 * output cannot hold the roll axis saturated. So: heading error commands a
 * BOUNDED bank (`MAX_BANK`), and the aileron servos the EMITTED bank (from
 * the same quaternion `syncTransforms` draws) onto that command — through
 * the wrap, so even an inverted entry unrolls by the short way. Pitch gets
 * the same treatment: the altitude error commands a bounded pitch ATTITUDE,
 * never a raw elevator, which is what keeps the climb-out handoff (45 deg
 * nose-up) from becoming a zoom stall.
 *
 * TRACERS: occasional bursts NEAR the player at range, never into him — the
 * same decision `peds/hostile.js` documents: 'bullet:tracer' + a positioned
 * 'shot' one-shot, never 'weapon:fire', which would panic the crowd and tell
 * `police` the PLAYER fired. The miss vector is never shorter than 4.5 m.
 *
 * IT NEVER CHASES FOREVER. Four independent outs, all timed:
 *   - the player exits the aircraft (landed or bailed): 3 s grace, then RTB;
 *   - the player opens 1.5 km on both pursuers for 6 s: escaped, RTB;
 *   - both pursuers destroyed: over;
 *   - a hard 300 s TTL: RTB regardless.
 * RTB pursuers hold their heading, climb away, and are despawned through the
 * `vehicles.despawn` chokepoint once they are far from the player (or after
 * 22 s). While live they carry `isMission = true` so no cull path can retire
 * them mid-chase; this module is their owner and force-despawns them, which
 * is the same authorised-teardown shape `mission.cleanup` uses.
 *
 * ARCHITECTURE.md: rule 2 (everything via `wq`/`ctx.peek`), rule 4 (forked
 * rng), rule 5 (per-pursuer records allocated at `begin`, nothing per frame).
 */

import * as THREE from 'three';
import { clamp, wrapAngle, yawOf, dist } from './util.js';

/** Interceptors per scramble. */
const PURSUERS = 2;
/** Rotate speed on the takeoff roll, m/s — past the jet's ~85 unstick. */
const ROTATE_SPEED = 92;
/** Altitude that ends the climb-out and begins the chase proper. */
const CLIMB_OUT_ALT = 55;
/** Player distance that counts as escaped, and how long it must hold. */
const ESCAPE_DIST = 1500;
const ESCAPE_HOLD = 6;
/** Seconds after the player leaves the aircraft before the flight breaks off. */
const EXIT_HOLD = 3;
/** The hard ceiling on a chase, seconds. */
const TTL = 300;
/** RTB: despawn beyond this distance from the player, or after this long. */
const RTB_FAR = 700;
const RTB_TIME = 22;
/** Tracer envelope: range band and nose-on cone. The band reaches out to
 *  the run-in leg (720-560 m) — a 620 m/s tracer covers it in ~1.1 s. */
const TRACER_MIN = 90;
const TRACER_MAX = 720;
const TRACER_CONE = 0.25;
/** The bank the heading loop may command, rad (~60 deg). Measured at both
 *  neighbours: 66 deg needs more lift than CLmax gives at chase speeds, the
 *  jet sags onto the deck and the ground margin flattens the turn; 54 deg
 *  holds height but turns at 5-6 deg/s and every turnback becomes a 1.7 km
 *  excursion. 60 deg with the turn PULL below (load factor ~2, CL ~1.15 of
 *  the 1.35 CLmax at 85-90 m/s) sustains level and turns ~11 deg/s. */
const MAX_BANK = 1.05;
/** Pitch-attitude command bounds, rad: dive shallower than the climb. */
const PITCH_UP = 0.42;
const PITCH_DOWN = -0.38;
/** Orbit height over a GROUNDED target (a boarded jet still on the apron). */
const ORBIT_ALT = 130;
/** Standoff orbit radius round a grounded target. THE ONE RIGID NUMBER in
 *  this file: it must EXCEED the turn radius the airframe actually flies at
 *  chase speeds (~520 m at 85-90 m/s, 58 deg of bank — measured, not the
 *  textbook 445: the servo droops a few degrees). Every smaller value that
 *  was tried commanded an unflyable circle, so each join PENETRATED it, the
 *  bearing flipped behind, and the exit reversal opened the cycle out past
 *  a kilometre. */
const ORBIT_R = 520;
/** The pilot marker: `stepPlane` makes no thrust with an empty seat. */
const PILOT = Object.freeze({ npc: true, pilot: true });

export class JetChase {
  constructor(ctx, wq, rng) {
    this.ctx = ctx;
    this.wq = wq;
    this.rng = rng;

    this.active = false;
    this.phase = 'idle'; // 'chase' | 'rtb'
    this.target = null;  // the stolen jet (a Vehicle), not the player
    this.pursuers = [];
    this.endReason = '';
    this.t = 0;
    this._exitT = 0;
    this._escapeT = 0;
    this._rtbT = 0;

    /* ---- scratch: nothing below allocates per frame ---- */
    this._spawnV = new THREE.Vector3();
    this._fwd = new THREE.Vector3();
    this._right = new THREE.Vector3();
    this._up = new THREE.Vector3();
    this._tracer = { from: new THREE.Vector3(), to: new THREE.Vector3(), speed: 620 };
  }

  get count() {
    return this.pursuers.length;
  }

  /* ================================================================== */
  /* begin                                                              */
  /* ================================================================== */

  /**
   * Scramble the flight. `target` is the stolen jet's Vehicle handle; `ab` is
   * the published `world.airbase` (for `runwayStart`).
   * @returns {boolean} true when the pursuers actually spawned.
   */
  begin(target, ab) {
    if (this.active || !target || !ab?.runwayStart) return false;
    const veh = this.wq.vehicles;
    if (typeof veh?.spawn !== 'function') return false;

    const rs = ab.runwayStart;
    const dx = Math.sin(rs.heading);
    const dz = Math.cos(rs.heading);
    const comY = veh.specOf?.('jet')?.comY ?? 1.35;
    for (let i = 0; i < PURSUERS; i++) {
      // Staggered pair: lead on the numbers, wingman 46 m back and offset.
      const back = i * 46;
      const side = i === 0 ? -6 : 8;
      const x = rs.x - dx * back + dz * side;
      const z = rs.z - dz * back - dx * side;
      const y = this.wq.groundY(x, z) + comY + 0.02;
      const v = veh.spawn('jet', this._spawnV.set(x, y, z), rs.heading, {});
      if (!v) continue;
      v.driver = PILOT;        // thrust needs a pilot aboard (stepPlane)
      v.engineOn = true;
      v.autoReverse = true;    // the measured steer sign — see the header
      v.isMission = true;      // no cull may take an interceptor mid-chase
      this.pursuers.push({
        v,
        phase: 'roll',
        side: i === 0 ? -1 : 1,
        inp: { throttle: 0, brake: 0, steer: 0, handbrake: false, boost: 0 },
        lastD: 1e9,
        turnDir: 0,
        mode: 'chase', // 'chase' (flying target) | 'orbit' | 'run' (grounded)
        runT: 0,
        burstT: 4 + i * 2.3,
        shots: 0,
        shotT: 0,
        rtbYaw: 0,
      });
    }
    if (!this.pursuers.length) return false;

    this.active = true;
    this.phase = 'chase';
    this.target = target;
    this.endReason = '';
    this.t = 0;
    this._exitT = 0;
    this._escapeT = 0;
    this.wq.ui?.notify?.('Interceptors scrambled', 'x' + this.pursuers.length, 'bad');
    return true;
  }

  /* ================================================================== */
  /* frame                                                              */
  /* ================================================================== */

  update(dt) {
    if (!this.active) return;
    this.t += dt;

    // A destroyed interceptor leaves the flight (its wreck stays where it
    // fell; clearing the mission tag hands it back to the ordinary world).
    for (let i = this.pursuers.length - 1; i >= 0; i--) {
      const p = this.pursuers[i];
      if (!p.v || p.v.destroyed) {
        if (p.v) p.v.isMission = false;
        this.pursuers.splice(i, 1);
      }
    }
    if (!this.pursuers.length) {
      this._finish('destroyed');
      return;
    }

    if (this.phase === 'chase') this._updateChase(dt);
    else this._updateRtb(dt);
  }

  _updateChase(dt) {
    const target = this.target;

    // ---- ends -----------------------------------------------------------
    if (!target || target.destroyed) return this._rtb('splash');
    if (this.t > TTL) return this._rtb('ttl');

    const occupied = this.wq.playerVehicle() === target;
    this._exitT = occupied ? 0 : this._exitT + dt;
    if (this._exitT > EXIT_HOLD) return this._rtb('exit');

    let nearest = Infinity;
    for (const p of this.pursuers) {
      const d = dist(p.v.position.x, p.v.position.z, target.position.x, target.position.z);
      if (d < nearest) nearest = d;
    }
    this._escapeT = nearest > ESCAPE_DIST ? this._escapeT + dt : 0;
    if (this._escapeT > ESCAPE_HOLD) return this._rtb('escape');

    // ---- fly ------------------------------------------------------------
    const veh = this.wq.vehicles;
    for (const p of this.pursuers) this._steer(p, dt, veh);
  }

  /** One pursuer, one frame — writes its input record and hands it over. */
  _steer(p, dt, veh) {
    const v = p.v;
    const t = this.target;
    const inp = p.inp;
    inp.throttle = 0;
    inp.brake = 0;
    inp.steer = 0;
    inp.handbrake = false;
    inp.boost = 1;

    // The EMITTED attitude — the same quaternion `syncTransforms` draws.
    // bank: atan2(right.y, up.y), the convention `stepPlane` itself banks by;
    // negative bank = right wing down = the heading swings right (measured
    // in `flightprobe.mjs`, not re-derived).
    const q = v.quaternion;
    this._fwd.set(0, 0, 1).applyQuaternion(q);
    this._right.set(1, 0, 0).applyQuaternion(q);
    this._up.set(0, 1, 0).applyQuaternion(q);
    const bank = Math.atan2(this._right.y, this._up.y);
    const pitch = Math.asin(clamp(this._fwd.y, -1, 1));
    const yaw = Math.atan2(this._fwd.x, this._fwd.z);

    if (p.phase === 'roll') {
      // Straight down the strip, lever firewalled; the anisotropic gear
      // holds the centreline without nosewheel work.
      inp.steer = 0;
      if ((v.forwardSpeed ?? 0) > ROTATE_SPEED) p.phase = 'climb';
    } else if (p.phase === 'climb') {
      // Wings level, a bounded climb attitude — not a raw elevator hold,
      // which handed the chase a 45-degree zoom the old law never recovered.
      // And OFF the reheat: arriving over the apron at 113 m/s made the
      // first turnback a ~1.6 km circle that brushed the escape radius; dry
      // thrust climbs this jet fine and hands the chase ~95 m/s instead.
      inp.steer = clamp(bank * 1.2, -1, 1);
      this._pitchTo(inp, 0.30, pitch);
      inp.boost = 0;
      inp.handbrake = (v.forwardSpeed ?? 0) > 95;
      if ((v.altitude ?? 0) > CLIMB_OUT_ALT) p.phase = 'chase';
    } else {
      /* ---- the chase ---------------------------------------------------- */
      const d = dist(v.position.x, v.position.z, t.position.x, t.position.z);
      const closing = (p.lastD - d) / Math.max(dt, 1e-4);
      p.lastD = d;
      const speed = v.forwardSpeed ?? 0;
      const alt = v.altitude ?? 0;
      // The nose-off-target angle — what the tracer cone is gated on.
      const rawErr = wrapAngle(
        Math.atan2(t.position.x - v.position.x, t.position.z - v.position.z) - yaw);

      /**
       * TWO GEOMETRIES, because the physics demands it. This airframe's
       * sustainable level turn at chase speeds is ~500 m of radius (75-90
       * m/s at the ~54 deg bank it can hold without sinking — MEASURED:
       * sustained 62 deg sagged both pursuers onto the deck). So PURE
       * PURSUIT of a STATIONARY target cannot converge: every pass is a
       * 1 km+ egg around the base. A FLYING target gets pure pursuit with
       * lead (tail-chase geometry is stable); a GROUNDED one gets a
       * STANDOFF ORBIT — the aim bearing swung aside by asin(R/d), which
       * rolls smoothly from head-on intercept (far) to a tangent circle at
       * R (near) — broken by periodic GUN RUNS: nose straight at the
       * target, burst fired from the nose while the cone and band allow,
       * then back onto the orbit. The runs are both the drama the encounter
       * owes and the only honest way to emit a tracer (from the nose — an
       * orbiting jet never bears on its own orbit centre).
       */
      const onGround = (t.altitude ?? 0) < 6;
      if (!onGround) {
        p.mode = 'chase';
      } else if (p.mode === 'run') {
        p.runT -= dt;
        // The run ends AT the orbit radius, nose still short of the target.
        // This is the geometry that keeps the whole fight tight: any
        // overflight (or any join commanded inside the flyable turn
        // radius) flips the bearing behind and forces a near-full reversal
        // — measured at 1.1 km of excursion per pass, whether the exit
        // turned immediately or flew straight through first. Broken off at
        // ORBIT_R the nose never crosses the target and the exit tangent
        // is flyable. The burst has already fired on the way in (720-560 m
        // is inside the envelope).
        if (d < ORBIT_R || Math.abs(rawErr) > 1.9 || p.runT <= 0) {
          p.mode = 'orbit';
          p.burstT = 6 + this.rng.float() * 4;
        }
      } else if (p.mode === 'extend') {
        // Opening for the next pass: a run STARTED close spirals — pure
        // pursuit's bearing rate rises exactly as fast as the proportional
        // bank turns, and the nose parks ~30 deg off the target for the
        // whole approach (measured, 690 m all the way down to 170 m: not
        // one frame inside the tracer cone). From 700+ m the same servo
        // captures the bearing with room to spare.
        p.runT -= dt;
        if (d > 860 || p.runT <= 0) {
          p.mode = 'run';
          p.runT = 12;
        }
      } else {
        p.mode = 'orbit';
        // The run-in clock ticks only while roughly established on the
        // fight (nose within ~80 deg of the target): expiring it mid
        // turnback used to launch an "extend" leg pointed away from a
        // target the jet had not even re-acquired.
        if (Math.abs(rawErr) < 1.4) p.burstT -= dt;
        if (p.burstT <= 0) {
          if (d < 780) {
            p.mode = 'extend';
            p.runT = 12;
          } else if (d < 1300 && Math.abs(rawErr) < 1.2) {
            p.mode = 'run';
            p.runT = 12;
          }
        }
      }

      // Intercept point: lead the target by its own velocity.
      const lead = clamp(d / 260, 0, 4);
      let ax = t.position.x + (t.velocity?.x ?? 0) * lead;
      let az = t.position.z + (t.velocity?.z ?? 0) * lead;

      // Formation-ish, flying targets: inside 320 m each pursuer offsets to
      // its own side of the line of sight so the pair bracket the target
      // instead of stacking. (A gun RUN aims dead at the target instead —
      // the offset would hold the nose outside the tracer cone.)
      if (p.mode === 'chase' && d < 320 && d > 1) {
        const lx = (ax - v.position.x) / d;
        const lz = (az - v.position.z) / d;
        ax += lz * 55 * p.side;
        az -= lx * 55 * p.side;
      }

      let err = wrapAngle(Math.atan2(ax - v.position.x, az - v.position.z) - yaw);
      if (p.mode === 'orbit' || p.mode === 'extend') {
        // Swing the commanded bearing off the target: tangent to the R
        // circle when at it, easing toward head-on as d grows (orbit), or
        // 135 deg off to open the next run (extend). ALWAYS THE NEAR
        // TANGENT — the side is chosen per frame as whichever needs the
        // smaller turn, which by construction matches the jet's current
        // circulation. A fixed assigned direction was measured fighting
        // the jet's own momentum after every join: chasing the far tangent
        // while its motion rotated the bearing away wound a log-spiral out
        // past 950 m and never closed.
        // ...and NO swing at all beyond ~1.5R: out there both tangents sit
        // a few degrees either side of head-on, the argmin flips sign frame
        // to frame, the net correction is zero, and a jet 1 km out was
        // measured flying a private carousel it never left. Far away, the
        // only stable guidance is straight at the target.
        const off = p.mode === 'orbit'
          ? (d > ORBIT_R * 1.55 ? 0 : Math.asin(clamp(ORBIT_R / Math.max(d, 1), 0, 1)))
          : 2.35;
        if (off > 0) {
          const eA = wrapAngle(err + off);
          const eB = wrapAngle(err - off);
          err = Math.abs(eA) < Math.abs(eB) ? eA : eB;
        }
      }
      // On a RUN the servo saturates early (gain 4): a proportional 1.5
      // relaxes the bank exactly as the bearing rate rises and equilibrates
      // ~30 deg off the nose; saturated, the turn outruns the bearing and
      // the nose CAPTURES the target — which is what a gun run is.
      const gain = p.mode === 'run' ? 4 : 1.5;

      // COMMIT THE TURNBACK. With the target dead astern the wrapped error
      // hovers at +/-pi and flips sign sample to sample; each flip is a full
      // roll reversal (~2 s at 66 deg) flown straight AWAY from the target —
      // measured, that chatter alone walked the pair out to the escape
      // radius. So the direction latches near the discontinuity and holds
      // until the nose is genuinely coming round; for a pursuit geometry the
      // latched error then shrinks monotonically, so the handover is smooth.
      if (p.turnDir === 0 && Math.abs(err) > 2.35) p.turnDir = err >= 0 ? 1 : -1;
      else if (Math.abs(err) < 1.1) p.turnDir = 0;
      const steerErr = p.turnDir === 0 ? err : p.turnDir * Math.abs(err);

      // Heading error -> a BOUNDED bank command (turn right = bank negative),
      // then the aileron servos the emitted bank onto it, through the wrap so
      // an inverted entry unrolls the short way. See the header for why a
      // direct heading loop cannot work on this airframe. The bound itself is
      // CAPPED BY THE MARGINS: at 66 deg of bank only 40% of the lift is
      // vertical, and a slow or low jet holding that all the way round the
      // turn flies into the ground — measured: both pursuers sagged out of a
      // lever-down turn, one pancaking at 16 m/s. Low or slow, the wings come
      // level first.
      const bankCap = MAX_BANK * Math.min(
        clamp((speed - 60) / 22, 0.35, 1),  // stall margin (stall ~57)
        clamp((alt - 25) / 50, 0.3, 1)      // ground margin
      );
      const wantBank = -clamp(steerErr * gain, -bankCap, bankCap);
      inp.steer = clamp(wrapAngle(bank - wantBank) * 1.3, -1, 1);

      // Altitude: match a flying target 12 m above it; orbit a grounded one
      // (a parked jet is the interceptors' problem to circle, not ram). The
      // error commands a bounded pitch ATTITUDE, and the elevator servos the
      // emitted pitch onto that.
      let wantY = onGround ? t.position.y + ORBIT_ALT : t.position.y + 12;
      const floor = (v.groundY ?? 0) + 45;
      if (wantY < floor) wantY = floor;
      const dy = wantY - v.position.y;
      let wantPitch = clamp(dy * 0.01, PITCH_DOWN, PITCH_UP);
      // A slow jet cannot afford the full climb attitude: the uncapped 0.42
      // at ~85 m/s zoomed one pursuer to a dead stop (measured -4 m/s) and
      // a tailslide.
      wantPitch = Math.min(wantPitch, 0.18 + 0.24 * clamp((speed - 78) / 35, 0, 1));
      if (alt < 45) wantPitch = Math.max(wantPitch, 0.24); // terrain: nose up

      /**
       * WHO OWNS THE ELEVATOR — decided by bank, and paid for three times:
       *
       * Wings near level, the elevator is the pitch-attitude servo above.
       *
       * In a COMMITTED BANK the elevator IS the turn: it loads the wing
       * (n ~ 1/cos(bank) holds the turn level; more drives the nose round
       * faster), and altitude becomes a TRIM on that load. Every other
       * arrangement measured worse: attitude servo alone turned 4-6 deg/s
       * at 57 deg of bank (all bank, no load); a pull floor fighting the
       * servo cancelled to elev ~0; gating the pull on the servo's wishes
       * either zoom-climbed a fast pursuer 600 m above the fight (pull won)
       * or died to ~3 deg/s the moment the orbit sat a few metres above its
       * wanted altitude and the servo commanded nose-down through a 55 deg
       * bank (servo won). Load first, trim with dy, and a zoom guard sheds
       * the pull if the nose ever points 26 deg over the horizon.
       */
      if (Math.abs(wantBank) > 0.5) {
        const spdScale = clamp((speed - 68) / 25, 0.25, 1);
        // COMMITTED TURNBACK (>57 deg of heading error): the full load,
        // altitude ignored — an 18 s reversal can afford 100 m of drift,
        // and letting the trim bleed the load (it was clamping to elev
        // ~0.01 whenever the jet sat above its wanted height, which after
        // any pull it always did) is how every circuit before this one
        // opened past the escape radius. Established (shallow error), the
        // trim flies the height but may never steal more than half the
        // load.
        const committed = Math.abs(steerErr) > 1.0;
        const load = (committed ? 0.48 : 0.55 * (Math.abs(bank) / MAX_BANK)) *
          spdScale;
        // Even a committed turn descends a little when high — with no
        // downhill path at all, each pull banked ~100 m and the pair
        // ratcheted up to a 600 m orbit nothing ever brought down.
        // Trims are LOAD-PROPORTIONAL, never absolute: a flat -0.15 against
        // a slow turn's 0.19 of load parked a pursuer on a 1.5 km arc for
        // 18 s, one metre per second under the escape timer.
        const trim = committed
          ? clamp(dy * 0.003, -Math.min(0.12, load * 0.35), 0.1)
          : clamp(dy * 0.005, -Math.min(0.3, load * 0.85), 0.22);
        let e = load + trim - Math.max(0, pitch - 0.2) * 2.5;
        // Terrain floor inside the turn: the bank margin has already
        // flattened the wings down here, so the load can safely climb.
        if (alt < 60) e = Math.max(e, 0.28);
        if (e >= 0) {
          inp.brake = e > 0.7 ? 0.7 : e;
          inp.throttle = 0;
        } else {
          inp.throttle = -e > 0.4 ? 0.4 : -e;
          inp.brake = 0;
        }
      } else {
        this._pitchTo(inp, wantPitch, pitch);
      }

      // Energy. The throttle lever HOLDS where the last input left it (the
      // flight model's two-stage lever), so speed control is lever work.
      // The load-bearing rule, measured the hard way: SLOW DOWN TO TURN.
      // Turn radius goes with speed squared (at 140 m/s under reheat even a
      // 55-deg bank is a 1.4 km circle — the pair orbited AWAY from the base
      // until the escape timer ended the chase), so with the target off the
      // nose the lever comes DOWN and the reheat stays gated on being
      // roughly nose-on. Never slow through the stall (~57 m/s; 75 keeps
      // manoeuvre margin).
      // Reheat is for STRAIGHT lines. At 120+ m/s the turn rate falls to
      // the bearing rotation rate and the pursuit locks into a spiral that
      // never aligns (measured: err pinned at 50-55 deg for 20 s, climbing
      // to 800 m under the burner). So anything past 34 deg off the nose
      // flies the 84-92 turnback band, and a RUN caps at 96 regardless.
      const offNose = Math.abs(err) > 0.6;
      if (p.mode === 'run') {
        inp.boost = 0;
        inp.handbrake = speed > 96;
      } else if (offNose) {
        // Turnback speed band, 84-92: above it the turn is a mile wide,
        // below it the wing has no load margin and spdScale guts the turn.
        inp.boost = speed < 84 ? 1 : 0;
        inp.handbrake = speed > 92;
      } else {
        inp.boost = d > 900 || (closing < 0 && d > 350) ? 1 : 0;
        inp.handbrake =
          (d < 260 && speed > 105) ||
          (onGround && d < 900 && speed > 84);
      }
      // Energy floors, least drastic first: near the ground stop bleeding
      // the lever; near the stall (or really low) light the burner too. The
      // burner is NOT lit for mere low altitude — reheat mid-turnback is a
      // measured way to double the circle and lose the fight.
      if (alt < 45) inp.handbrake = false;
      if (speed < 75 || alt < 22) {
        inp.brake = Math.min(inp.brake, 0.2);
        inp.boost = 1;
        inp.handbrake = false;
      }

      // Guns are live on a RUN or in a flying tail-chase — never around the
      // orbit or clearing the pass, where the burst clock is already ticking
      // toward the next run. The cone reads the NOSE-off-target angle, so
      // every tracer leaves roughly along the airframe.
      if (p.mode === 'run' || p.mode === 'chase') this._tracers(p, dt, d, rawErr);
    }

    veh?.setInput?.(v, inp);
  }

  /**
   * Servo the emitted pitch onto a commanded attitude. Elevator channels:
   * `brake` is nose UP, `throttle` nose DOWN (`stepPlane`'s
   * `elev = throttle - brake`, positive = nose down).
   */
  _pitchTo(inp, wantPitch, pitch) {
    const pe = wantPitch - pitch;
    if (pe > 0) inp.brake = clamp(pe * 2.0, 0, 0.7);
    else inp.throttle = clamp(-pe * 2.0, 0, 0.55);
  }

  /**
   * The drama: short bursts NEAR the player at range. 'bullet:tracer' plus a
   * positioned shot one-shot — deliberately never 'weapon:fire' (see header).
   */
  _tracers(p, dt, d, err) {
    if (p.shots <= 0) {
      if (d < TRACER_MIN || d > TRACER_MAX || Math.abs(err) > TRACER_CONE) return;
      p.burstT -= dt;
      if (p.burstT > 0) return;
      p.shots = 5;
      p.shotT = 0;
      p.burstT = 2.8 + this.rng.float() * 2.2;
      return;
    }
    p.shotT -= dt;
    if (p.shotT > 0) return;
    p.shotT = 0.075;
    p.shots--;

    const v = p.v;
    const t = this.target;
    const tr = this._tracer;
    this._fwd.set(0, 0, 1).applyQuaternion(v.quaternion);
    tr.from.copy(v.position).addScaledVector(this._fwd, 7.4);
    // Miss vector: perpendicular to the line of sight, never under 4.5 m.
    const lx = t.position.x - v.position.x;
    const lz = t.position.z - v.position.z;
    const ll = Math.hypot(lx, lz) || 1;
    const side = this.rng.float() < 0.5 ? -1 : 1;
    const off = (4.5 + this.rng.float() * 9) * side;
    tr.to.set(
      t.position.x + (lz / ll) * off,
      t.position.y + (this.rng.float() * 6 - 2),
      t.position.z - (lx / ll) * off
    );
    tr.speed = 620;
    this.ctx.events.emit('bullet:tracer', tr);
    if ((p.shots & 1) === 0) this.wq.sfx('shot', tr.from, TRACER_GAIN);
  }

  /* ================================================================== */
  /* wind-down                                                          */
  /* ================================================================== */

  _rtb(reason) {
    if (this.phase === 'rtb') return;
    this.phase = 'rtb';
    this.endReason = reason;
    this._rtbT = 0;
    for (const p of this.pursuers) p.rtbYaw = yawOf(p.v);
    this.wq.ui?.notify?.('Interceptors breaking off', '', 'slag');
  }

  _updateRtb(dt) {
    this._rtbT += dt;
    const veh = this.wq.vehicles;
    const pos = this.wq.playerPos();
    for (let i = this.pursuers.length - 1; i >= 0; i--) {
      const p = this.pursuers[i];
      const v = p.v;
      const inp = p.inp;
      // Hold the break-off heading, climb gently, burner lit — leave the map.
      inp.steer = clamp(wrapAngle(p.rtbYaw - yawOf(v)) * 1.2, -1, 1);
      inp.brake = 0.3;
      inp.throttle = 0;
      inp.handbrake = false;
      inp.boost = 1;
      veh?.setInput?.(v, inp);
      const d = dist(v.position.x, v.position.z, pos.x, pos.z);
      if (d > RTB_FAR || this._rtbT > RTB_TIME) this._despawn(p, i);
    }
    if (!this.pursuers.length) this._finish(this.endReason || 'rtb');
  }

  _despawn(p, i) {
    this.pursuers.splice(i, 1);
    if (!p.v) return;
    // Authorised teardown of our own mission-tagged vehicle, through the one
    // chokepoint. A pursuer the player somehow occupies is refused (guard a).
    this.wq.vehicles?.despawn?.(p.v, FORCE);
  }

  _finish(reason) {
    this.active = false;
    this.phase = 'idle';
    this.target = null;
    this.endReason = reason;
  }

  /** Hard stop: despawn everything NOW. Death, respawn, save adoption. */
  reset() {
    for (let i = this.pursuers.length - 1; i >= 0; i--) this._despawn(this.pursuers[i], i);
    this._finish('reset');
  }

  dispose() {
    this.reset();
  }
}

const FORCE = Object.freeze({ force: true });
const TRACER_GAIN = Object.freeze({ gain: 0.5 });
