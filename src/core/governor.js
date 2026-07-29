/**
 * Adaptive performance governor.
 *
 * The game shipped defaulting to the `ultra` preset, which is a 6 km draw
 * distance, 4096 shadow maps, 24k particles, 110 pedestrians and a 1 km stream
 * radius. That is a benchmark setting, not a play setting, and it is far too
 * slow to actually play on.
 *
 * This watches real frame time and moves the quality preset until the game is
 * playable, then holds. It is deliberately conservative about moving UP, because
 * oscillating between presets is worse than sitting one notch low.
 *
 * Order of attack, cheapest visual cost first:
 *   1. trim `renderScale` within the current preset (invisible-ish, big win)
 *   2. drop a whole preset tier
 *
 * `?q=ultra` (or any explicit preset) pins the tier and disables tier changes —
 * the resolution trim still runs unless `?gov=0`.
 */

import { QUALITY_PRESETS } from './config.js';

const TIERS = ['low', 'medium', 'high', 'ultra'];

export class Governor {
  /**
   * @param {object} opts
   * @param {number} [opts.targetMs=16.7]  frame time we are aiming for
   * @param {number} [opts.slowMs=23]      above this for a whole window = act
   * @param {number} [opts.fastMs=11]      below this for a long stretch = maybe recover
   * @param {boolean} [opts.allowTierChange=true]
   */
  constructor({ targetMs = 16.7, slowMs = 23, fastMs = 11, allowTierChange = true } = {}) {
    this.targetMs = targetMs;
    this.slowMs = slowMs;
    this.fastMs = fastMs;
    this.allowTierChange = allowTierChange;
    this.enabled = true;

    this.minScale = 0.62;
    this.maxScale = 1.0;

    this._samples = new Float32Array(30);
    this._n = 0;
    this._filled = false;
    // Boot, prewarm and the first ring of streamed tiles are not representative
    // — but keep this short. A player should not have to endure several seconds
    // of slideshow before the governor is allowed to help.
    this._warmup = 60;
    this._cooldown = 0;
    this._goodStreak = 0;
    this.actions = [];

    /**
     * Highest renderScale we are still willing to go back up to.
     *
     * MEASURED, tier `low`, governor left to its own devices: 0.70 -> 0.62,
     * back up to 0.67, up to 0.72, then straight back down to 0.62. Four full
     * `render.resize()` calls — each one disposes and reallocates the HDR
     * target, the viewmodel target, both ping-pong targets, the gbuffer, GTAO,
     * contact, SSR, TAA, motion blur, DoF and bloom — to end up exactly where
     * it started. The resize IS a stall, so an oscillating governor is a
     * hitch generator, and it was oscillating at the playability floor.
     *
     * Anything we have already had to trim away is remembered as a ceiling, so
     * recovery can approach the last known-good value but never re-take the
     * step that was measured to be too expensive.
     */
    this._scaleCeiling = this.maxScale;
    /** Frozen once the picture has stopped changing. See `_settle`. */
    this._settled = 0;
    this._badStreak = 0;
    this.frozen = false;
  }

  /** Median of the window — robust against a single streaming hitch. */
  _median() {
    const n = this._filled ? this._samples.length : this._n;
    if (n < 8) return null;
    const a = Array.prototype.slice.call(this._samples, 0, n).sort((x, y) => x - y);
    return a[(n / 2) | 0];
  }

  _reset() {
    this._n = 0;
    this._filled = false;
  }

  /**
   * @param {number} dtMs   last frame time in milliseconds
   * @param {object} engine
   */
  update(dtMs, engine) {
    if (!this.enabled) return;
    if (this._warmup > 0) { this._warmup--; return; }
    if (this._cooldown > 0) { this._cooldown--; return; }

    // The city is still building. A streaming frame is not a frame the quality
    // preset can do anything about, and judging one is how the governor ends up
    // dropping two tiers for a transient — MEASURED: `high` -> `medium` -> `low`
    // inside the first 150 frames, off medians of 23.2 and 24.4 ms taken while
    // `world` was still laying down the first ring of tiles.
    const world = engine.ctx?.peek?.('world');
    if (world && typeof world.streamingIdle === 'function' && !world.streamingIdle()) return;

    // Hitches are not throughput and must not be treated as throughput. A
    // shader-compile or geometry-build frame can be 700-1400 ms; letting one
    // into the window drags the MEDIAN across the action threshold and buys a
    // permanent quality drop for a one-off cost that dropping quality does not
    // even fix. The governor's job is the steady state; the hitch work is
    // elsewhere (pre-warm, the light-count lock, the build budgets).
    if (dtMs > this.slowMs * 3) return;

    this._samples[this._n++] = dtMs;
    if (this._n >= this._samples.length) { this._n = 0; this._filled = true; }

    const med = this._median();
    if (med == null) return;
    if (!this._filled && this._n < 20) return;

    const cfg = engine.config;
    const render = engine.ctx?.peek?.('render');

    // Frozen is not "deaf". It stops the HUNTING — the ±0.05 walk around a
    // working setting that produced four resizes for no net change — but a
    // player who drives into a district the settled configuration genuinely
    // cannot hold still needs help. So the door reopens on sustained slowness,
    // never on one bad window: re-entering the loop costs a resize, and a
    // governor that unfreezes on noise is the oscillation again by another name.
    if (this.frozen) {
      if (med <= this.slowMs) { this._badStreak = 0; return; }
      if (++this._badStreak < 120) return;
      this.frozen = false;
      this._badStreak = 0;
      this._settled = 0;
      console.info(`[gov] ${med.toFixed(1)}ms sustained — unfreezing`);
    }

    if (med > this.slowMs) {
      this._goodStreak = 0;
      this._settled = 0;
      if (this._trimScale(cfg, render, engine, med)) return;
      if (this.allowTierChange && this._dropTier(cfg, engine, med)) return;
    } else if (med < this.fastMs) {
      // Only recover after a sustained good stretch, and only resolution —
      // stepping a tier back up mid-play causes a visible pop and a shader
      // compile spike, which is worse than staying one notch conservative.
      if (++this._goodStreak >= 6) {
        this._goodStreak = 0;
        if (!this._raiseScale(cfg, render, engine, med)) this._settle();
      }
    } else {
      this._goodStreak = 0;
      // In band. Enough consecutive in-band windows and the governor has done
      // its job; every further action can only cost a resize.
      this._settle();
    }
  }

  /**
   * Stop acting once the picture has held. The governor exists to find a
   * playable setting, not to keep hunting around one forever, and every action
   * it takes costs a full render-target reallocation.
   *
   * Counted in FRAMES, like `_goodStreak` and `_cooldown` — 240 of them is about
   * four seconds of the frame time staying inside the band, which is long enough
   * that it is the machine's steady state and not a quiet corner of the map.
   */
  _settle() {
    if (++this._settled < 240) return;
    this.frozen = true;
    this.actions.push({ kind: 'freeze', from: this.actions.length, to: 'settled' });
    console.info('[gov] settled — no further quality changes');
  }

  _apply(engine) {
    // render.resize() re-reads q.renderScale and resizes every target.
    engine.resize?.();
    engine.events?.emit?.('resize', { width: innerWidth, height: innerHeight });
    this._reset();
    this._cooldown = 45; // let it settle before judging again
  }

  _trimScale(cfg, render, engine, med) {
    const cur = cfg.q.renderScale ?? 1;
    if (cur <= this.minScale + 1e-3) return false;
    // Scale roughly with the square root of how far over budget we are — cost is
    // close to linear in pixel count, so this converges in a couple of steps.
    const want = Math.max(this.minScale, cur * Math.sqrt(this.targetMs / med));
    const next = Math.max(this.minScale, Math.min(cur - 0.06, want));
    cfg.q.renderScale = Number(next.toFixed(3));
    // Never offer this level back on recovery: it was measured too slow once.
    this._scaleCeiling = Math.min(this._scaleCeiling, cur - 0.02);
    this.actions.push({ kind: 'scale', from: cur, to: cfg.q.renderScale, med });
    console.info(`[gov] ${med.toFixed(1)}ms — renderScale ${cur.toFixed(2)} -> ${cfg.q.renderScale}`);
    this._apply(engine);
    return true;
  }

  _raiseScale(cfg, render, engine, med) {
    const cur = cfg.q.renderScale ?? 1;
    // Never above the tier's own authored resolution. The preset is the quality
    // decision; the governor's remit is to claw performance back from it, not to
    // invent quality it was never asked for. Left uncapped it walked `low` from
    // 0.70 up to 0.95 in five steps — five render-target reallocations, at the
    // one tier whose entire job is to be the smooth floor.
    const preset = QUALITY_PRESETS[cfg.quality]?.renderScale ?? this.maxScale;
    const ceiling = Math.min(this.maxScale, preset, this._scaleCeiling);
    if (cur >= ceiling - 1e-3) return false;
    const next = Math.min(ceiling, cur + 0.05);
    cfg.q.renderScale = Number(next.toFixed(3));
    this.actions.push({ kind: 'scale-up', from: cur, to: cfg.q.renderScale, med });
    console.info(`[gov] ${med.toFixed(1)}ms — renderScale ${cur.toFixed(2)} -> ${cfg.q.renderScale}`);
    this._apply(engine);
    return true;
  }

  /**
   * Dropping a tier is a WEAKER lever than it looks, and callers should know
   * why. `world`, `buildings` and `props` read `q.streamRadius` at init and do
   * not re-stream when it changes, so a tier drop reclaims resolution, shadow
   * and post cost but NOT the city that is already resident. Measured: booting
   * at ultra and falling back to `low` leaves ~3.4k draws where a genuine `low`
   * boot issues ~1.2k. That is why `detectTier` never starts play at `ultra`.
   *
   * The proper fix is for the streaming subsystems to honour a runtime radius
   * change; until they do, this is a partial recovery and the real defence is
   * picking the right tier before the world builds.
   */
  _dropTier(cfg, engine, med) {
    const i = TIERS.indexOf(cfg.quality);
    if (i <= 0) return false;
    const to = TIERS[i - 1];
    const keepScale = cfg.q.renderScale;
    cfg.setQuality(to);
    // setQuality resets renderScale from the preset; keep our trim if it was lower.
    if (keepScale < cfg.q.renderScale) cfg.q.renderScale = keepScale;
    this.actions.push({ kind: 'tier', from: TIERS[i], to, med });
    console.info(`[gov] ${med.toFixed(1)}ms — quality ${TIERS[i]} -> ${to}`);
    engine.events?.emit?.('quality:auto', { tier: to, reason: 'frametime', med });
    this._apply(engine);
    return true;
  }
}

/**
 * Pick a starting tier BEFORE the first frame — and this matters far more than
 * it looks, because the governor cannot fully undo a bad choice.
 *
 * MEASURED on an M2 Ultra at 1600x900 (`node tools/perfcheck.mjs --q=<tier>`):
 *
 *   booted at low     101 fps   1224 draws
 *   booted at medium   91 fps   1767 draws
 *   booted at high     62 fps   2493 draws
 *   booted at ultra,
 *   governor walks
 *   down to low        40 fps   3367 draws   <-- three times the draws of a
 *                                                real `low` boot, at the same
 *                                                tier name
 *
 * The reason for that last row is the important one: `world`, `buildings` and
 * `props` read `q.streamRadius` at init and stream the city once. When the
 * governor drops a tier it changes resolution, shadows and post — but the city
 * that is already resident STAYS resident. So booting at `ultra` and falling
 * back is permanently worse than booting at `high`, even though both end up
 * reporting the same tier.
 *
 * Hence: **play never auto-selects `ultra`.** Ultra is a capture/benchmark
 * setting. `?q=ultra` still pins it for screenshots.
 */
export function detectTier() {
  try {
    const c = document.createElement('canvas');
    const gl = c.getContext('webgl2');
    if (!gl) return 'low';
    const dbg = gl.getExtension('WEBGL_debug_renderer_info');
    const r = String(dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : '');
    if (/iPhone|iPad|Android/i.test(navigator.userAgent)) return 'low';
    // Retina at 3.3 MP internal is a very different job from 1080p.
    const px = innerWidth * innerHeight * Math.min(devicePixelRatio || 1, 2);
    const bigCanvas = px > 3.0e6;
    if (/M[1-4] (Ultra|Max)|RTX (40|50)/i.test(r)) return bigCanvas ? 'medium' : 'high';
    if (/Apple M|RTX (20|30)|Radeon RX|Arc A/i.test(r)) return bigCanvas ? 'medium' : 'high';
    if (/Intel|UHD|Iris|llvmpipe|SwiftShader/i.test(r)) return 'low';
    return 'medium';
  } catch {
    return 'medium';
  }
}
