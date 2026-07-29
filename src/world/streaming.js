/**
 * WORLD — the amortised build queue.
 *
 * ARCHITECTURE.md rule 8: nothing may build more than
 * `ctx.config.q.tileBuildBudgetMs` of geometry in one frame, and nothing may
 * build the whole city up front. Every subsystem funnels its streamed work
 * through `world.schedule(fn, priority)`, so this one queue is the single place
 * the frame budget is enforced — and the single place that knows whether the
 * city around the camera is finished, which is what `world.streamingIdle()`
 * answers for the capture harness.
 *
 * Priorities are small integers, lower first: 0 = the tile the camera is
 * standing in, 8 = speculative far work. Jobs may push more jobs.
 *
 * ---------------------------------------------------------------------------
 * TWO BUDGETS, AND WHY THE CAPTURE PATH NEEDS THE SECOND ONE
 *
 * In PLAY the budget is wall-clock milliseconds, and it has to be: a frame that
 * overruns is a stutter, and the number the player feels is time, not jobs.
 *
 * In CAPTURE (`config.deterministic`) a wall-clock budget is a bug, for exactly
 * the reason `src/core/engine.js` skips `FIXED_STEP_BUDGET_MS` there: how much
 * work a millisecond buys is machine- and load-dependent, so under a fixed
 * frame count a loaded machine builds less city than an idle one and the
 * shutter photographs a different scene every run.
 *
 * MEASURED on `hero` before this fix, three captures of one unchanged shot:
 *
 *     draw calls   2959 / 4074 / 4096
 *     triangles    8.26M / 10.94M / 10.96M
 *
 * — a 28% difference in how much city was in the photograph. Downstream, an
 * attempt to certify a lighting change as pixel-neutral measured a 1.54%
 * noise floor on one same-tree pair and 81.7% (maxDelta 235) on the next, so
 * that before/after result was worthless as evidence.
 *
 * The wall-clock budget also leaks into state machines that are gated on the
 * queue being drained rather than on the queue itself — `props` only promotes a
 * tile to LOD 0 while `pendingJobs() === 0`, `physics` only republishes static
 * collision when the last build left nothing deferred — so "how fast was the
 * machine" decided how much of the tail work completed too.
 *
 * So `run()` takes an optional JOB-COUNT budget which, when set, replaces the
 * clock entirely: exactly `jobBudget` jobs come off the queue per call, in
 * priority order. That is a pure function of the queue's contents, which is the
 * property the pixel gate needs. It is never used in play.
 * ---------------------------------------------------------------------------
 */

const BUCKETS = 10;

export class JobQueue {
  constructor() {
    this.buckets = [];
    for (let i = 0; i < BUCKETS; i++) this.buckets.push([]);
    this.pending = 0;
    this.ran = 0;
    this.lastMs = 0;
    /** Lifetime job count. Sizes the deterministic budget; also a cheap stat. */
    this.totalRan = 0;
  }

  push(fn, priority = 4) {
    const p = priority < 0 ? 0 : priority >= BUCKETS ? BUCKETS - 1 : priority | 0;
    this.buckets[p].push(fn);
    this.pending++;
    return this;
  }

  /**
   * Run jobs until the budget is spent. A job that overruns is allowed to
   * finish — the contract is a budget, not a preemption point — so jobs are
   * authored small and re-queue themselves when they have more to do.
   *
   * @param budgetMs   wall-clock ceiling, milliseconds. The PLAY budget.
   * @param now        clock, injected so the deterministic path can prove it
   *                   never consults one.
   * @param jobBudget  when > 0, run exactly this many jobs and IGNORE `now`
   *                   entirely. See the header: this is the capture path, and
   *                   the whole point is that the result depends only on what
   *                   is in the queue.
   */
  run(budgetMs, now, jobBudget = 0) {
    const counted = jobBudget > 0;
    // Read once, and only for the stat: control flow below must never branch on
    // the clock when `counted`, or the determinism guarantee is gone.
    const t0 = now();
    let ran = 0;
    for (let p = 0; p < BUCKETS; p++) {
      const b = this.buckets[p];
      while (b.length) {
        const spent = counted ? ran >= jobBudget : ran > 0 && now() - t0 >= budgetMs;
        if (spent) {
          this.lastMs = now() - t0;
          this.ran = ran;
          this.totalRan += ran;
          return ran;
        }
        const fn = b.shift();
        this.pending--;
        ran++;
        try {
          fn();
        } catch (err) {
          console.error('[world] build job threw:', err);
        }
      }
    }
    this.lastMs = now() - t0;
    this.ran = ran;
    this.totalRan += ran;
    return ran;
  }

  clear() {
    for (const b of this.buckets) b.length = 0;
    this.pending = 0;
  }
}

/**
 * Ring bookkeeping for a square grid of cells of edge `size`, centred on a
 * moving point. Reports what to add and what to drop, without allocating.
 */
export class RingTracker {
  constructor(size) {
    this.size = size;
    this.live = new Map();
    this._want = new Set();
    this._cx = NaN;
    this._cz = NaN;
  }

  key(ix, iz) {
    return ix * 100003 + iz;
  }

  /**
   * @returns {{ add: number[][], drop: any[] }|null} null if nothing changed.
   */
  diff(x, z, radius, out) {
    const s = this.size;
    const cx = Math.floor(x / s);
    const cz = Math.floor(z / s);
    const r = Math.ceil(radius / s);
    if (cx === this._cx && cz === this._cz && r === this._r) return null;
    this._cx = cx;
    this._cz = cz;
    this._r = r;
    const want = this._want;
    want.clear();
    out.add.length = 0;
    out.drop.length = 0;
    const r2 = (radius + s * 0.75) ** 2;
    for (let dz = -r; dz <= r; dz++) {
      for (let dx = -r; dx <= r; dx++) {
        const ix = cx + dx;
        const iz = cz + dz;
        const px = (ix + 0.5) * s - x;
        const pz = (iz + 0.5) * s - z;
        if (px * px + pz * pz > r2) continue;
        const k = this.key(ix, iz);
        want.add(k);
        if (!this.live.has(k)) out.add.push([ix, iz, px * px + pz * pz]);
      }
    }
    for (const [k, v] of this.live) if (!want.has(k)) out.drop.push(v);
    // nearest first
    out.add.sort((a, b) => a[2] - b[2]);
    return out;
  }

  /** How many live cells are inside the radius (used by streamingIdle). */
  wanted() {
    return this._want.size;
  }

  has(ix, iz) {
    return this.live.has(this.key(ix, iz));
  }
}
