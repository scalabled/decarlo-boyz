import { el, setStyle, clamp01, damp, ease, lerp } from './util.js';

/**
 * Screen-space hurt feedback.
 *
 *   0-25% hurt   nothing but a faint edge darkening
 *   25-60%       blood vignette blooms in, world desaturates
 *   60-100%      heartbeat pulses the vignette, saturation drops hard
 *   on hit       a 180 ms directional-agnostic red flash
 *   regen        vignette breathes out over ~2 s and saturation returns
 *
 * The vignette is two stacked layers pushed through an feTurbulence
 * displacement filter (see style.js) so its edge is organic; a clean radial
 * gradient is the single most "WebGL demo" thing a hurt overlay can do.
 *
 * The numeric side of health moved to the arcs on the Slag Ring (`vitals.js`) —
 * an open-world HUD has no room for a labelled bar in a corner, and GTA's
 * gauge-round-the-radar idiom is strictly better at a glance.
 */
export class HealthFx {
  constructor(parent) {
    this.bloodWrap = el('div', 'ow-blood', parent);
    el('div', 'ow-blood-a', this.bloodWrap);
    el('div', 'ow-blood-b', this.bloodWrap);
    this.beat = el('div', 'ow-lowbeat', parent);
    this.desat = el('div', 'ow-desat', parent);
    this.flash = el('div', 'ow-hitflash', parent);

    this.hurt = 0;
    this.flashT = 1;
    this.beatPhase = 0;
    this.beatEnergy = 0;
    this.regenT = 1;
    this._lastBeat = 0;
    this.onBeat = null; // set by index for the audio cue

    setStyle(this.bloodWrap, 'opacity', '0');
    setStyle(this.desat, 'display', 'none');
    setStyle(this.flash, 'opacity', '0');
    setStyle(this.beat, 'opacity', '0');
  }

  onDamage(intensity = 1) {
    this.flashT = 0;
    this.flashPeak = 0.35 + 0.65 * clamp01(intensity);
  }

  onRegenStart() {
    this.regenT = 0;
  }

  /** @param {object} s { health, maxHealth, regen:bool } */
  update(dt, s) {
    const h = clamp01((s.health ?? 100) / (s.maxHealth || 100));
    const targetHurt = clamp01((0.78 - h) / 0.78) ** 1.3;
    this.hurt = damp(this.hurt, targetHurt, 7, dt);
    const hurt = this.hurt;

    // --- heartbeat --------------------------------------------------------
    const beatIntensity = clamp01((0.5 - h) / 0.5);
    if (beatIntensity > 0.02) {
      const hz = lerp(1.15, 2.35, beatIntensity);
      this.beatPhase += dt * hz;
      const p = this.beatPhase % 1;
      // systole + weaker diastole
      const thump =
        Math.exp(-((p / 0.085) ** 2)) + 0.55 * Math.exp(-(((p - 0.235) / 0.1) ** 2));
      this.beatEnergy = thump * beatIntensity;
      const beatIndex = Math.floor(this.beatPhase);
      if (beatIndex !== this._lastBeat) {
        this._lastBeat = beatIndex;
        this.onBeat?.(beatIntensity);
      }
    } else {
      this.beatEnergy = damp(this.beatEnergy, 0, 6, dt);
      this.beatPhase = 0;
    }

    // --- regeneration breath ---------------------------------------------
    if (this.regenT < 1) this.regenT = Math.min(1, this.regenT + dt / 1.8);
    const regenPulse = s.regen ? 0.12 * (1 - ease.outCubic(this.regenT)) : 0;

    const bloodA = clamp01(hurt * 1.05 + this.beatEnergy * 0.16);
    setStyle(this.bloodWrap, 'opacity', bloodA.toFixed(3));
    setStyle(this.bloodWrap, 'display', bloodA < 0.004 ? 'none' : '');
    const bs = 1 + this.beatEnergy * 0.022 + regenPulse * 0.12;
    setStyle(this.bloodWrap, 'transform', `scale(${bs.toFixed(4)})`);

    const beatA = clamp01(this.beatEnergy * 0.55);
    setStyle(this.beat, 'opacity', beatA.toFixed(3));
    setStyle(this.beat, 'display', beatA < 0.004 ? 'none' : '');

    // backdrop-filter is expensive: only mount the element when it does work
    const desatA = clamp01(hurt * 0.8);
    setStyle(this.desat, 'display', desatA < 0.01 ? 'none' : '');
    setStyle(this.desat, 'opacity', desatA.toFixed(3));

    if (this.flashT < 1) {
      this.flashT = Math.min(1, this.flashT + dt / 0.19);
      const a = (this.flashPeak ?? 1) * (1 - ease.outQuad(this.flashT)) * 0.8;
      setStyle(this.flash, 'opacity', a.toFixed(3));
      setStyle(this.flash, 'display', '');
    } else {
      setStyle(this.flash, 'display', 'none');
    }
  }

  dispose() {
    this.bloodWrap.remove();
    this.beat.remove();
    this.desat.remove();
    this.flash.remove();
  }
}
