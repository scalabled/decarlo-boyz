/**
 * HITSTOP — the two-to-five frames of frozen world that make a punch land.
 *
 * ---------------------------------------------------------------------------
 * WHAT IT IS
 * ---------------------------------------------------------------------------
 * The whole mechanism is one line:
 *
 *     if (FX.hitstop > 0) { FX.hitstop -= dt; dt *= 0.12; }
 *
 * A connecting swing calls `FX.stop(heavy ? 0.075 : 0.04)`, a parry calls
 * `FX.stop(0.09)`, and for that many seconds of WALL CLOCK the simulation runs
 * at 0.12x. Note which clock each side uses, because it is the whole design:
 * the countdown is in RAW seconds (`dt` there is the unscaled frame delta —
 * the `dt *= 0.12` on the next line is what the world gets), so the stall is a
 * fixed duration the player's eye can learn. At 60 fps 0.04 s is 2.4 frames of
 * a world moving at an eighth speed.
 *
 * This is not a camera shake and must not be approximated by one. Shake says
 * "something happened near you"; hitstop says "the thing you were holding hit
 * something solid", because the impact interrupts TIME rather than the view.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS FILE IS SO CAREFUL ABOUT `ctx.time.scale`
 * ---------------------------------------------------------------------------
 * `ctx.time.scale` has exactly ONE owner: the `PauseArbiter` in `src/ui/`,
 * landed specifically to end a run of bugs where two callers each banked a
 * "previous" scale and handed each other's back. Its claim table is frozen and
 * its wants record is derived from live overlay state, so there is currently NO
 * way for a subsystem outside `ui` to register a claim.
 *
 * So this class does both halves of the honest answer:
 *
 *   1. IT PREFERS THE ARBITER. If `ui.pause` grows the two-method external
 *      claim API (`claim(name, scale)` / `release(name)`), this file finds it
 *      by feature detection and routes through it, with no further change
 *      anywhere. That is the interface hitstop needs and the only one it needs.
 *
 *   2. UNTIL THEN IT OWNS THE CLOCK ONLY WHEN NOBODY ELSE DOES, and never
 *      argues:
 *
 *      - it REFUSES to engage while the arbiter holds the clock at all (a menu
 *        freeze must not be released early, and the weapon wheel's bullet time
 *        must not be stomped), while the world is paused, or under
 *        `config.deterministic` — a capture harness owns the clock outright and
 *        a stall would poison a pixel-exact shot;
 *      - it ABANDONS its claim the instant the arbiter takes over mid-stall, or
 *        the instant `time.scale` stops being the value it wrote. It never
 *        writes over somebody else's number and never restores on top of one;
 *      - it HEALS THE ONE RACE IT CANNOT PREVENT. The arbiter banks
 *        `base = time.scale` on the frame its first claim goes live. If that
 *        lands inside a 40-90 ms stall it banks the hitstop value and hands it
 *        back when the menu closes, leaving the world at an eighth speed for
 *        ever. Hitstop cannot stop that from outside `ui`, but it can recognise
 *        it: the orphaned number is the exact product it wrote and nothing else
 *        in the build produces it, so when the arbiter lets go and the clock
 *        comes back reading that value, this file puts the free-play base back.
 *
 * The multiply is deliberate — `scale = base * 0.12`, not `scale = 0.12`. The
 * demo driver runs free play at 0.28 and a hitstop inside it should be an
 * eighth of THAT, not a speed-up to 0.12.
 */

/** The `dt *= 0.12` above: the world runs at an eighth speed during a stall. */
export const HITSTOP_SCALE = 0.12;

/**
 * Longest stall anyone may ask for. The authored values are 0.04 / 0.075 /
 * 0.09; this is a ceiling against a caller multiplying by a frame count, not a
 * tuning knob. Past ~0.15 s a stall stops reading as impact and starts reading
 * as a dropped frame.
 */
export const HITSTOP_MAX = 0.15;

export class Hitstop {
  constructor(ctx) {
    this.ctx = ctx;
    /** Raw-clock timestamp the stall ends at; <= raw means idle. */
    this._until = -1;
    /** The exact number we wrote into `time.scale`, or null while we hold nothing. */
    this._written = null;
    /** Free-play scale sampled when the stall began. */
    this._base = 1;
    /**
     * Set when the arbiter took the clock out from under a live stall: the
     * scale we had written, and the free-play base it displaced. Two fields
     * rather than an object because hard rule 5 wants no allocation on a path
     * the frame loop can reach, however rarely.
     */
    this._orphanScale = null;
    this._orphanBase = 1;
    /** True once we have routed through a real arbiter claim. */
    this._viaArbiter = false;

    /**
     * Diagnostics. NOTHING may gate on these and no probe may assert with them
     * — a stall is proven by `ctx.time.elapsed` falling behind `ctx.time.raw`,
     * which is the engine's own measurement and not ours. See rule 12.
     */
    this.stats = {
      requests: 0, engaged: 0, refused: 0, preempted: 0, healed: 0, released: 0,
    };
  }

  /** True while the world is being held. */
  get active() {
    return this._until > (this.ctx.time?.raw ?? 0);
  }

  /** Seconds of wall clock left in the stall. */
  get remaining() {
    return Math.max(0, this._until - (this.ctx.time?.raw ?? 0));
  }

  /* --------------------------------------------------------------------- */

  /** The `ui` arbiter, or null. Never imported — see hard rule 2. */
  get _arbiter() {
    const ui = this.ctx.peek?.('ui');
    return ui?.pause ?? null;
  }

  /**
   * FX.stop(t). Extends a live stall, never sums with it: two hits landing on
   * the same frame are one impact, not a double-length freeze.
   *
   * @param {number} seconds wall-clock duration
   * @returns {boolean} true if the world is now being held
   */
  request(seconds) {
    const t = this.ctx.time;
    if (!t || !(seconds > 0)) return false;
    this.stats.requests++;
    if (this.ctx.config?.deterministic) { this.stats.refused++; return false; }

    const arb = this._arbiter;
    /* A live pause/bullet-time claim outranks us outright. Refusing is the
     * whole point: the arbiter's number is a decision about the game's state,
     * ours is a 40 ms flourish on top of one. */
    if (!this._viaArbiter && arb && arb.held !== null && this._written === null) {
      this.stats.refused++;
      return false;
    }

    const dur = Math.min(HITSTOP_MAX, seconds);
    this._until = Math.max(this._until, t.raw + dur);

    if (this._written !== null || this._viaArbiter) return true;

    /* ---- take the clock ------------------------------------------------ */
    if (typeof arb?.claim === 'function') {
      /* The sanctioned path, the day `ui` grows it. The arbiter owns the
       * arithmetic; we only name the claim and the factor. */
      arb.claim('hitstop', HITSTOP_SCALE);
      this._viaArbiter = true;
      this.stats.engaged++;
      return true;
    }

    /* HEAL BEFORE BANKING. If a previous stall was orphaned and the clock is
     * still sitting on that number, banking it as the free-play base would
     * make the leak permanent AND throw away the record of it — the next
     * restore would put an eighth of an eighth back. */
    this._heal(arb);

    const base = t.scale > 0 ? t.scale : 1;
    this._base = base;
    this._written = base * HITSTOP_SCALE;
    t.scale = this._written;
    this._orphanScale = null;
    this.stats.engaged++;
    return true;
  }

  /**
   * Once per frame, from `fx.update`. Ordering is deliberate: `fx` sorts after
   * `player` and `weapons`, so a stall asked for by a swing this frame is
   * standing on the clock before the frame ends — and `engine.step` reads
   * `time.scale` at the TOP of the next frame, which is the first frame the
   * player could see it on anyway.
   */
  update() {
    const t = this.ctx.time;
    if (!t) return;
    const arb = this._arbiter;

    if (this._viaArbiter) {
      if (!this.active) {
        if (typeof arb?.release === 'function') arb.release('hitstop');
        this._viaArbiter = false;
        this._until = -1;
        this.stats.released++;
      }
      return;
    }

    if (this._written !== null) {
      /* Somebody else now owns the clock — the arbiter took a claim, or a
       * harness wrote its own number. Let go WITHOUT writing: restoring here
       * would overwrite a decision that outranks ours. */
      if ((arb && arb.held !== null) || t.scale !== this._written) {
        this._orphanScale = this._written;
        this._orphanBase = this._base;
        this._written = null;
        this._until = -1;
        this.stats.preempted++;
        return;
      }
      if (!this.active) {
        t.scale = this._base > 0 ? this._base : 1;
        this._written = null;
        this._until = -1;
        this.stats.released++;
      }
      return;
    }

    this._heal(arb);
  }

  /**
   * The arbiter banked our number as free play's `base` and has just handed it
   * back, so the world is stuck at an eighth speed. `scale` is the exact
   * product we wrote — a round trip through `base` with no arithmetic in
   * between — and nothing else in this build produces that value, so this is
   * unambiguously our leak to clean up.
   */
  _heal(arb) {
    if (this._orphanScale === null) return;
    const t = this.ctx.time;
    if (!t) return;
    if (arb && arb.held !== null) return;
    if (t.scale !== this._orphanScale) return;
    t.scale = this._orphanBase > 0 ? this._orphanBase : 1;
    this._orphanScale = null;
    this.stats.healed++;
  }

  /** Teardown / a hard state change: give the clock back now. */
  release() {
    const t = this.ctx.time;
    const arb = this._arbiter;
    if (this._viaArbiter) {
      if (typeof arb?.release === 'function') arb.release('hitstop');
      this._viaArbiter = false;
    } else if (this._written !== null && t && t.scale === this._written) {
      t.scale = this._base > 0 ? this._base : 1;
    }
    this._written = null;
    this._orphanScale = null;
    this._until = -1;
  }
}
