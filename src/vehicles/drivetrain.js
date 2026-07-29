/**
 * Engine, clutch, gearbox, differential.
 *
 * The engine has its own inertia and revs independently of the wheels; the
 * clutch is a slipping friction element between the two. That is not
 * pedantry — it is what produces every driveline behaviour a player feels:
 * bogging down off the line in too high a gear, the momentary loss of drive
 * during a shift, engine braking on a trailing throttle, and the way a
 * locked-diff car with one wheel in the air just sits there and spins it.
 *
 * `gears[0]` is reverse, `gears[1]` is neutral, `gears[2..]` are forward.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * REVERSE — why it needs `mapControls` and not just a gear
 * ────────────────────────────────────────────────────────────────────────────
 * The player has two pedals and one of them is the S key. A GTA car resolves
 * that the way every two-pedal arcade driving game does, and it is a CONTROL
 * mapping, not a gearbox rule:
 *
 *   moving forward   S = brake.                W = throttle.
 *   stopped, S held  select reverse.
 *   in reverse       S = throttle (backwards). W = brake, and once it has
 *                    brought you nearly to a stop, first gear.
 *
 * This used to live inside `_autoShift`, which only ever looked at
 * `input.throttle` — and `input.throttle` is W, which nobody presses while
 * backing up. So reverse was selected correctly and then never driven: the
 * brake torque from S was applied to a car in reverse gear at zero throttle,
 * and the measured result was a car that could not back out of anything
 * (`tools/playprobe.mjs`: "S brakes/reverses", 1.85 -> 1.85 m/s).
 *
 * `mapControls` produces the pedal pair the REST of the model consumes —
 * engine torque here, brake torque in `dynamics._stepWheels`, the brake and
 * reverse lamps in `index._updateLights`. Nothing downstream needs to know
 * which gear is selected.
 *
 * AI DRIVERS DO NOT GET THIS. `traffic` holds `brake = 1` for as long as a red
 * light lasts; auto-selecting reverse under that rule would have every stopped
 * car in the city creep backwards into the one behind it. The mapping is armed
 * per-vehicle by `autoReverse` (set when a PLAYER takes the wheel) and AI keeps
 * an explicit channel instead: `setInput(v, { reverse: 0..1 })`.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * STEERING — the same split, and the reason D used to steer LEFT
 * ────────────────────────────────────────────────────────────────────────────
 * `input.steer` arrives meaning two DIFFERENT things depending on who is
 * driving, and until now the model only understood one of them.
 *
 *   AI (`traffic`, `police`, `game`)  a normalised STEER ANGLE in the car's own
 *       body frame. `traffic/driver.js` derives the convention explicitly and
 *       correctly: yaw = atan2(fwd.x, fwd.z), increasing yaw rotates the nose
 *       toward +X, and a body whose forward is +Z has its RIGHT along -X — so
 *       +X is LEFT, and a POSITIVE steer angle is a LEFT turn. All three AI
 *       call sites are written that way (`driver.js` sends `-delta`,
 *       `game/util.js` sends `atan2(dx,dz) - yaw`, which is positive when the
 *       target is to the left).
 *
 *   PLAYER (`player/vehicle.js`)      a raw CONTROL AXIS: `input.moveVector().x`,
 *       which is +1 for D / right stick right and -1 for A. Nobody has ever
 *       shipped a game where pushing right steers left.
 *
 * The player's axis was fed straight into the AI convention, so the two
 * cancelled: measured on a sedan, `input.steer = +1` gave `steerAngle +33.2 deg`,
 * `yaw +94.4 deg` and 6.3 m of displacement to the car's own LEFT. That is the
 * "steering is reversed (a/d swapped)" report exactly, and it is the same family
 * as the chase camera parked in front of the windscreen and the driver seated
 * backwards: a -Z convention meeting a +Z one.
 *
 * The mapping — not the geometry — is what was wrong, so it is fixed here,
 * where the player's OTHER controls are already resolved, and `control.steer`
 * is what the model steers on. `human` (the vehicle's `autoReverse`) is the same
 * "a person is at the wheel" flag the pedal crossing uses; when it is clear the
 * command passes through untouched and every AI driver in the city keeps the
 * convention it was written against.
 */

import { torqueFactor } from './specs.js';

const RPM = Math.PI / 30;

/** Below this |forward speed| the car counts as stopped, m/s. */
const STOPPED = 0.45;
/** How long S must be held at a standstill before reverse engages, seconds. */
const REVERSE_DWELL = 0.18;

function clamp01(v) {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

export class Drivetrain {
  constructor(spec) {
    this.spec = spec;
    this.omega = spec.engine.idleW;
    this.gear = 2; // first
    this.clutch = 1;
    this.shiftTimer = 0;
    this.shiftTarget = -1;
    this.rpm = spec.engine.idle;
    this.load = 0;
    this.driveTorque = 0;
    this.clutchTorque = 0;
    this.autoBox = true;
    this.stalled = false;
    this.ignition = true;
    this.locked = false;
    /** Engine inertia reflected through the gearbox onto ONE driven wheel. */
    this.reflectedInertia = 0;
    this._shiftCool = 0;
    /** Seconds the reverse request has been held at a standstill. */
    this._revHold = 0;
    /** Seconds since anything last asked to be in reverse. */
    this._revIdle = 0;
    /** True while `mapControls` has the pedals crossed over (in reverse). */
    this.reversing = false;
    /**
     * PER-HERO TOP-GEAR TRIM. 1 for everything the player is not driving.
     * Written every step by `Vehicle.fixedStep`; see the HERO block in
     * `specs.js` for why a driver's number lands on the top gear and nowhere
     * else — and for the proof, already in this file's TOP GEAR note, that a
     * top-gear-only change provably cannot alter a launch or a 0-100.
     */
    this.heroTop = 1;
  }

  /** The gearbox ratio in gear `g`, including the hero's top-gear trim. */
  ratioOf(g) {
    const gb = this.spec.gearbox;
    const r = gb.gears[g] * gb.final;
    // Top gear only. A TALLER gear is a SMALLER ratio, hence the divide.
    return g === gb.gears.length - 1 && this.heroTop !== 1 ? r / this.heroTop : r;
  }

  get ratio() {
    return this.ratioOf(this.gear);
  }

  get inGear() {
    return this.spec.gearbox.gears[this.gear] !== 0;
  }

  /** Is reverse selected (or being selected)? Used by the reverse lamps. */
  get inReverse() {
    return this.gear === 0 || (this.shiftTimer > 0 && this.shiftTarget === 0);
  }

  /**
   * Resolve the raw controls into the throttle/brake/steer triple the model
   * runs on, and make the forward/reverse decision. See the header.
   *
   * @param input        raw `{ throttle, brake, steer, reverse? }` from `setInput`
   * @param forwardSpeed signed speed along the car's nose, m/s
   * @param out          `{ throttle, brake, steer }`, written in place
   * @param human        a PERSON is at the wheel (the vehicle's `autoReverse`):
   *                     arm the hold-brake-at-a-standstill rule, and read
   *                     `steer` as a control axis rather than a body-frame
   *                     steer angle. See the header.
   */
  mapControls(input, forwardSpeed, dt, out, human) {
    const rawT = clamp01(input.throttle ?? 0);
    const rawB = clamp01(input.brake ?? 0);
    // AI's explicit channel: how hard it wants to go backwards.
    const askR = clamp01(input.reverse ?? 0);
    const gb = this.spec.gearbox;
    const hasReverse = gb.gears[0] !== 0;

    /**
     * STEERING, resolved first because nothing below can change it and every
     * early return has to carry it.
     *
     * A human pushes an axis: +1 is D / stick-right and MUST turn right. The
     * model's steer angle is positive to the LEFT (see the header), so the
     * axis is negated exactly once, here. An AI is already speaking the model's
     * convention and is passed through.
     */
    const rawS = Math.max(-1, Math.min(1, input.steer ?? 0));
    out.steer = human ? -rawS : rawS;

    const autoReverse = human;
    if (!this.autoBox || !hasReverse) {
      out.throttle = rawT;
      out.brake = rawB;
      this.reversing = false;
      return out;
    }

    const stopped = forwardSpeed < STOPPED;
    let wantReverse = askR > 0.02;

    if (autoReverse && rawT < 0.02 && rawB > 0.4) {
      // Hold the brake at a standstill and you get reverse — after a short
      // dwell, so a stab of the brake at walking pace is still just a brake.
      this._revHold = stopped ? this._revHold + dt : 0;
      if (this._revHold >= REVERSE_DWELL) wantReverse = true;
    } else if (!wantReverse) {
      this._revHold = 0;
    }

    if (this.gear === 0) {
      /**
       * IS ANYBODY STILL ASKING FOR REVERSE? If not — the driver got out, or he
       * let go of the brake, or the AI has finished backing out — roll to a stop
       * and take first.
       *
       * The guard is not theoretical in either direction:
       *
       *   `clearDriver` parks an abandoned car by setting `brake = 1`, and with
       *   the pedals crossed that IS full reverse throttle. A car the player
       *   stepped out of while in R would have driven itself backwards down the
       *   street at the governor limit.
       *
       *   ...and `autoReverse` is NOT an answer to the question. It is armed for
       *   as long as a PLAYER is in the seat, so reading it here made the test
       *   permanently true for a player and this release never fired at all. A
       *   car that had been braked to a standstill once — which is every car, at
       *   every light — latched reverse for the rest of the drive and idled
       *   BACKWARDS out of it: measured at -2.2 m/s on a sedan and -3.1 m/s on
       *   the bike, six seconds after the last pedal input, with the player
       *   touching nothing at all.
       *
       * The player's request is the brake pedal; the AI's is `reverse`. Reading
       * the REQUESTS rather than the arming flag satisfies both cases, because
       * an abandoned car has `autoReverse` cleared and so cannot qualify however
       * hard `clearDriver` stands on the brake.
       */
      const asking = askR > 0.02 || (autoReverse && rawB > 0.02);
      this._revIdle = asking ? 0 : this._revIdle + dt;
      if (!asking && this._revIdle > 0.3) {
        if (forwardSpeed > -0.5) {
          // Rolled to a halt with nobody asking: take first, so the car creeps
          // FORWARD like an automatic in D instead of backwards in R.
          this.gear = 2;
          this.clutch = 1;
          this.reversing = false;
          out.throttle = rawT;
          out.brake = rawB;
          return out;
        }
        // Still rolling backwards with nobody asking: roll it to a halt so the
        // branch above can take first. Braking is the only lever here — the
        // throttle is already zero and what keeps an unattended car moving is
        // the engine's IDLE torque through reverse gear, which is worth -2.2 m/s
        // on a sedan and -1.4 m/s on a truck for as long as you leave it.
        out.throttle = 0;
        out.brake = Math.max(rawT, rawB, 0.6);
        this.reversing = true;
        return out;
      }
      /**
       * In reverse the pedals are crossed. W brakes; when it has almost stopped
       * the car, first gear comes back — which is exactly the second half of a
       * three-point turn.
       */
      // Reverse is one low gear with no upshift, so it needs a governor or the
      // sports car backs up at 75 km/h. Tapers over the last 1.5 m/s so it eases
      // off rather than cutting.
      const cap = gb.reverseMax;
      const gov = clamp01((cap + forwardSpeed) / 1.5);
      out.throttle = Math.max(rawB, askR) * gov;
      out.brake = rawT;
      this.reversing = true;
      if (rawT > 0.08 && forwardSpeed > -0.55) {
        this.gear = 2;
        this.clutch = 1;
        this._revHold = 0;
        this.reversing = false;
        out.throttle = rawT;
        out.brake = 0;
      }
      return out;
    }

    this.reversing = false;
    if (wantReverse) {
      /**
       * ──────────────────────────────────────────────────────────────────────
       * THE GUARD ON THE LOW SIDE IS `-reverseMax`, NOT `-0.05`.
       * ──────────────────────────────────────────────────────────────────────
       * It used to read `forwardSpeed > -0.05`, and the comment below — "still
       * rolling FORWARDS: stop first" — says what it was meant to do. It was
       * written with the wrong sign, so a car rolling BACKWARDS at more than
       * 5 cm/s was sent down the same path and got the brakes instead of the
       * gear it was asking for. Rolling backwards is the one state in which
       * reverse is unambiguously what the driver wants.
       *
       * `stopped` (below `STOPPED`) already covers the case the comment is
       * about, so the old test bought nothing and cost this, measured on an icy
       * 6 degree slope with S held for the whole 900 frames:
       *
       *   gear 1 · control throttle/brake 0.00/1.00 · rpm 360 · _revHold 6.98 s
       *
       * Seven seconds past a 0.18 s dwell, still refusing the gear, still
       * applying full brake, while the car slid backwards down the hill with no
       * drive at all. On the flat it merely delayed engagement ~25 frames and
       * escaped by luck, because the brake happens to pull the drift back inside
       * the +/-0.05 window; anything that sustains the drift — a slope, a
       * slippery surface, a shove from behind — holds it there for good. That is
       * the "reverse engages but takes 600 frames" report, and the "gear 1, rpm
       * 388, brake held" sample.
       *
       * Below `-reverseMax` there is genuinely nothing to select: the governor
       * on the next branch would command zero throttle anyway, and engaging a
       * negative ratio at that speed only drags the crank onto its limiter. So
       * the low-side guard is the governor's own cap, which is the same number
       * the rest of the reverse path is written against.
       */
      if (stopped && forwardSpeed > -gb.reverseMax && this.shiftTimer <= 0) {
        this.gear = 0;
        this.clutch = 1;
        this._revHold = 0;
        this.reversing = true;
        out.throttle = Math.max(rawB, askR);
        out.brake = 0;
        return out;
      }
      // Still rolling forwards: stop first. An AI that asks for reverse at
      // 10 m/s gets the brakes, not a shredded gearbox.
      out.throttle = 0;
      out.brake = Math.max(rawB, askR);
      return out;
    }

    out.throttle = rawT;
    out.brake = rawB;
    return out;
  }

  /**
   * @param wheelOmegas driven wheels' angular velocities (rad/s), signed
   * @param out         per-wheel drive torque, written in place
   */
  step(dt, input, wheelOmegas, out, speed) {
    const spec = this.spec;
    const eng = spec.engine;
    const gb = spec.gearbox;

    const throttle = this.ignition ? Math.max(0, Math.min(1, input.throttle)) : 0;

    // ---- automatic gearbox ------------------------------------------------
    this._shiftCool = Math.max(0, this._shiftCool - dt);
    if (this.shiftTimer > 0) {
      this.shiftTimer -= dt;
      // Clutch out for the first half of the shift, back in over the second.
      const half = gb.shiftTime * 0.5;
      this.clutch = this.shiftTimer > half ? 0 : 1 - this.shiftTimer / half;
      if (this.shiftTimer <= 0) {
        this.gear = this.shiftTarget;
        this.shiftTimer = 0;
        this.clutch = 1;
        this._shiftCool = 0.35;
      }
    } else if (this.autoBox) {
      this._autoShift(input, speed, gb, eng);
    }

    // ---- engine torque ----------------------------------------------------
    const limiter = this.omega > eng.redlineW ? 0 : this.omega > eng.redlineW * 0.995 ? 0.35 : 1;
    /**
     * BOOST. Nitro on four wheels, a sprint out of the saddle on two — see the
     * BOOST block in `specs.js` for why the channel is shared and why this is
     * torque rather than a thruster. It multiplies the ENGINE, so the limiter
     * still owns the top end and a boosted car cannot outrun its own gearing.
     */
    const bst = spec.boost;
    const boostMul = bst
      ? 1 + (bst.torque - 1) * Math.max(0, Math.min(1, input.boost ?? 0))
      : 1;
    let Te = eng.peakTorque * torqueFactor(spec, this.omega) * throttle * limiter * boostMul;
    /**
     * Idle governor: enough torque to hold idle with the clutch out — and what
     * holds a parked car on a Pittsburgh hill.
     *
     * SKIPPED ENTIRELY when the class has no idle (`engine.idle <= 0`). That is
     * the bicycle: legs do not idle, and a governor that feeds 16% of peak
     * torque in below idle speed would give a parked bicycle 1.3 m/s^2 of creep
     * with nobody on it. `idleW` is also the divisor here, so an idle of zero
     * without this guard is a division by zero straight into NaN.
     */
    if (eng.idleW > 1e-4 && this.omega < eng.idleW * 1.1) {
      Te += eng.peakTorque * 0.16 * (1 - this.omega / (eng.idleW * 1.1));
    }
    // Pumping and friction losses — this is the engine-braking term.
    const friction = eng.friction * this.omega + eng.brakeTorque * (1 - throttle * 0.85);
    Te -= friction;

    /**
     * ---- clutch / driveline ------------------------------------------------
     *
     * NOT a torsional spring between engine and wheels. That formulation was
     * tried first and it stalls the engine on every launch: from rest the slip
     * is the whole idle speed, the spring saturates at its capacity, and the
     * capacity is necessarily larger than the torque the engine makes at idle,
     * so `Te - Tc` is hugely negative and the crank stops. Real launches do the
     * opposite — the engine holds revs and the CLUTCH gives.
     *
     * So: two regimes.
     *   LOCKED  (wheel speed x ratio is at or above idle) — the engine is rigidly
     *           tied to the wheels. It transmits everything it makes, including
     *           negative torque (that is engine braking), and its rotating mass
     *           is reflected onto the driven wheels as Ie * ratio^2, which is
     *           what stops first gear producing infinite wheelspin.
     *   SLIPPING (pulling away) — the engine revs against a clutch that passes
     *           at most `cap`, and `cap` scales with throttle so feathering it
     *           creeps and flooring it lights the tyres up.
     */
    let Tc = 0;
    const ratio = this.ratio;
    this.reflectedInertia = 0;
    this.locked = false;
    if (this.inGear && this.clutch > 0.001) {
      let wheelW = 0;
      for (let i = 0; i < wheelOmegas.length; i++) wheelW += wheelOmegas[i];
      wheelW /= Math.max(1, wheelOmegas.length);
      const lockW = wheelW * ratio;
      const engaged = this.clutch > 0.985;
      if (engaged && lockW >= eng.idleW * 0.98) {
        this.locked = true;
        this.omega = Math.min(eng.redlineW * 1.02, lockW);
        Tc = Te;
        this.reflectedInertia =
          (eng.inertia * ratio * ratio * gb.eff) / Math.max(1, wheelOmegas.length);
      } else {
        const cap = eng.peakTorque * (0.30 + 1.05 * throttle) * this.clutch;
        Tc = Math.max(-cap, Math.min(cap, Te > 0 ? Te : Te * 0.35));
        /**
         * THE CRANK HAS TO BE ABLE TO GET BACK TO IDLE.
         *
         * Below the clutch's capacity `Tc === Te`, so `Te - Tc` is zero and the
         * engine speed never changes: whatever the driveline last dragged the
         * crank down to, it stays at. Braking to a halt runs the LOCKED branch,
         * which slaves `omega` to the wheels and floors it at `idleW * 0.45` —
         * so a car that has simply stopped can find itself sitting at 360 rpm,
         * and then pull away from the lights at 360 rpm with the throttle
         * buried. Measured exactly that on a lane-centre launch: `throttle 1.00,
         * gear first, rpm 360, driveTorque 2553 N.m`. The torque was fine; the
         * engine note, the tacho and the shift logic were all reading a stalled
         * engine at full throttle.
         *
         * A real clutch (or a converter) cannot take torque the crank needs to
         * stay running, so hold back exactly the torque that returns it to idle
         * and pass the rest. It costs a few hundredths of a second and only
         * where the engine is already below idle, so a normal launch — which
         * starts AT idle — is untouched.
         */
        if (Tc > 0 && this.omega < eng.idleW) {
          const spinUp = ((eng.idleW - this.omega) * eng.inertia) / dt;
          Tc = Math.max(0, Tc - Math.min(Tc, spinUp));
        }
        // Surplus torque spins the engine up against its own inertia.
        this.omega += ((Te - Tc) / eng.inertia) * dt;
      }
    } else {
      this.omega += (Te / eng.inertia) * dt;
    }
    this.clutchTorque = Tc;

    if (this.omega < eng.idleW * 0.45) this.omega = eng.idleW * 0.45;
    if (this.omega > eng.redlineW * 1.04) this.omega = eng.redlineW * 1.04;
    this.rpm = this.omega / RPM;
    this.load = Math.max(0, Math.min(1, Math.abs(Tc) / (eng.peakTorque * 1.1)));

    // ---- differential -----------------------------------------------------
    const total = Tc * ratio * gb.eff;
    this.driveTorque = total;
    const n = wheelOmegas.length;
    if (n === 0) return;
    if (n === 1) {
      out[0] = total;
      return;
    }
    const share = total / n;
    const lock = spec.diff.lock;
    const preload = spec.diff.preload;
    let mean = 0;
    for (let i = 0; i < n; i++) mean += wheelOmegas[i];
    mean /= n;
    for (let i = 0; i < n; i++) {
      // Limited slip: torque is biased towards the SLOWER wheel, exactly as a
      // clutch-pack LSD does. lock = 0 is an open diff (both wheels get half
      // and the one with grip gets nothing), lock = 1 is a welded axle.
      const dw = wheelOmegas[i] - mean;
      const bias = -dw * lock * 220 - Math.sign(dw) * preload * lock;
      out[i] = share + bias;
    }
  }

  /**
   * Up/down shifts only. The forward/reverse decision belongs to
   * `mapControls`, which runs first and owns `gear === 0` — this used to try to
   * do both off `input.throttle` alone and that is what made reverse unusable.
   *
   * ──────────────────────────────────────────────────────────────────────────
   * A GEARBOX SHIFTS ON ROAD SPEED, NOT ON ENGINE SPEED
   * ──────────────────────────────────────────────────────────────────────────
   * This used to upshift on `omega / redlineW` alone. `omega` is the ENGINE,
   * and when the clutch is slipping the engine is not connected to anything —
   * so a car that could not move (nose against a kerb, a wall, the car in
   * front, one broken wheel dragging) sat at full throttle, revved to the
   * limiter against a slipping clutch, and UPSHIFTED. Then again. And again.
   *
   * Measured live in the city, a sedan at rest: `gear 5, rpm 6297, road speed
   * 0.03 m/s, driveTorque 49 N.m`. Fifth gear multiplies torque by 4.1 where
   * first multiplies it by 12.8, and at the limiter the engine is making almost
   * nothing anyway — so once the obstruction cleared the car STILL could not
   * pull away. It is stuck for good, at full throttle, on clean asphalt, with
   * nothing touching it. That is `traffic`'s "cars at full throttle that do not
   * move" (x=-156,z=127 and x=-102,z=188) and most of their residual "stopped
   * without a reason", and it is entirely this function's fault.
   *
   * Both directions are now gated on what the ROAD is asking the engine to do:
   *   - never upshift into a gear the current road speed cannot pull
   *   - drop out of a gear that is bogging, however high the engine is revving
   */
  _autoShift(input, speed, gb, eng) {
    const n = gb.gears.length;
    if (this.gear === 0) return;

    // Engine speed the road speed implies in gear `g`, rad/s.
    const wheelW = Math.abs(speed) / Math.max(0.05, this.spec.wheel.radius);
    // Through `ratioOf`, so the shift logic sees the SAME top gear the
    // driveline is actually running. Reading `gb.gears` directly here would
    // make the box decide when to reach for a ratio it does not have.
    const wFor = (g) => wheelW * Math.abs(this.ratioOf(g));

    /**
     * Bogging recovery, and it runs BEFORE the shift cooldown: a car sitting in
     * fifth at walking pace has to get out of it now, not in a third of a
     * second. Picks the highest gear the road speed can actually pull.
     */
    if (this.gear > 2 && wFor(this.gear) < eng.idleW * 1.05) {
      let g = 2;
      for (let i = 3; i < n; i++) {
        if (wFor(i) >= eng.idleW * 1.05) g = i;
      }
      if (g !== this.gear) {
        this.shiftTarget = g;
        this.shiftTimer = gb.shiftTime * 0.7;
        return;
      }
    }

    if (this._shiftCool > 0) return;
    const frac = this.omega / eng.redlineW;
    if (frac > gb.shiftUp && this.gear < n - 1) {
      // The next gear has to be able to hold the engine above idle on the road
      // speed actually available. Without this the box climbs to top against a
      // slipping clutch while the car stands still.
      if (wFor(this.gear + 1) > eng.idleW * 1.1) {
        this.shiftTarget = this.gear + 1;
        this.shiftTimer = gb.shiftTime;
      }
    } else if (frac < gb.shiftDown && this.gear > 2) {
      // Do not downshift into the limiter.
      const next = this.ratioOf(this.gear - 1);
      const cur = this.ratioOf(this.gear);
      if ((this.omega * next) / cur < eng.redlineW * 0.93) {
        this.shiftTarget = this.gear - 1;
        this.shiftTimer = gb.shiftTime * 0.7;
      }
    }
  }

  /** Public label for the HUD: 'R', 'N', '1'.. */
  get gearLabel() {
    if (this.gear === 0) return 'R';
    if (this.gear === 1) return 'N';
    return String(this.gear - 1);
  }

  reset() {
    this.omega = this.spec.engine.idleW;
    this.gear = 2;
    this.clutch = 1;
    this.shiftTimer = 0;
    this._revHold = 0;
    this._revIdle = 0;
    this.reversing = false;
  }
}
