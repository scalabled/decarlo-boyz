/**
 * ===========================================================================
 * VITALS — the arcs on the Slag Ring, the stars, the money, the weapon
 * ===========================================================================
 *
 * The rule this file exists to obey: **the centre of the screen stays empty**,
 * and every readout is either attached to the ring or pinned to a corner. If a
 * value is not changing and is not dangerous, its widget fades out.
 *
 * Health and armour are drawn as two arcs flanking the bottom of the iron ring,
 * meeting at six o'clock and filling outward — health to the left, armour to
 * the right. That reads as one gauge cluster instead of two bars, it costs no
 * horizontal space, and it keeps the player's eye on the map instead of on a
 * corner of the screen.
 */

import { el, setText, setStyle, setClass, clamp, clamp01, damp, lerp, ease } from './util.js';
import { drawWeaponGlyph } from './glyphs.js';
import { star as starPath, roundRect } from './citymap.js';

const SVG_NS = 'http://www.w3.org/2000/svg';
const ARC_DEG = 114; // sweep of a full gauge
/** Degrees of clearance either side of six o'clock, for the district tag. */
const ARC_GAP = 9;

function svgEl(tag, attrs, parent) {
  const n = document.createElementNS(SVG_NS, tag);
  for (const k in attrs) n.setAttribute(k, attrs[k]);
  if (parent) parent.appendChild(n);
  return n;
}

/* ------------------------------------------------------- health / armour -- */

export class VitalArcs {
  constructor(parent) {
    this.root = svgEl('svg', { class: 'ow-vitals', viewBox: '0 0 100 100' }, parent);

    // Both gauges start just off six o'clock and sweep upward — health up the
    // left flank, armour up the right — so they read as one cluster, the top of
    // the bezel stays clear for the north pip and the bottom stays clear for
    // the district tag.
    this.health = this._gauge(54, 1);
    this.armour = this._gauge(54, -1);

    this.hv = 1;
    this.av = 0;
    this.flash = 0;
  }

  _gauge(r, sign) {
    const g = svgEl('g', {
      // sign -1 mirrors the gauge onto the left flank of the ring
      transform: sign < 0 ? 'translate(100,0) scale(-1,1)' : '',
    }, this.root);
    const C = 2 * Math.PI * r;
    const span = (ARC_DEG / 360) * C;
    const common = {
      cx: 50, cy: 50, r,
      fill: 'none',
      'stroke-linecap': 'butt',
      // 90deg puts the dash start at six o'clock and a circle path runs
      // clockwise (i.e. up the LEFT flank) from there; ARC_GAP holds it off the
      // bottom centre, and the -1 gauge is mirrored onto the right flank.
      transform: `rotate(${90 + ARC_GAP} 50 50)`,
      'stroke-dasharray': `${span} ${C - span}`,
    };
    const track = svgEl('circle', {
      ...common, stroke: 'rgba(5,8,12,.9)', 'stroke-width': 5.2,
    }, g);
    const shadow = svgEl('circle', {
      ...common, stroke: 'rgba(158,176,198,.30)', 'stroke-width': 5.2,
    }, g);
    const fill = svgEl('circle', {
      ...common, stroke: '#41e08a', 'stroke-width': 3.2,
      'stroke-linecap': 'round',
    }, g);
    return { g, track, shadow, fill, C, span };
  }

  _set(gauge, frac, colour) {
    const len = gauge.span * clamp01(frac);
    setStyle(gauge.fill, 'stroke-dasharray', `${len.toFixed(2)} ${(gauge.C - len).toFixed(2)}`);
    setStyle(gauge.fill, 'stroke', colour);
  }

  update(dt, s) {
    const hFrac = clamp01(s.health / Math.max(1, s.maxHealth));
    const aFrac = clamp01(s.armour / Math.max(1, s.maxArmour));
    this.hv = damp(this.hv, hFrac, 11, dt);
    this.av = damp(this.av, aFrac, 11, dt);

    // Health reads green while it is not a problem and swings through amber to
    // red as it drops — the colour IS the warning, so nothing has to blink.
    const t = clamp01((this.hv - 0.12) / 0.5);
    const r = Math.round(lerp(255, 65, t));
    const g = Math.round(lerp(59, 224, ease.outQuad(t)));
    const b = Math.round(lerp(78, 138, t));
    let colour = `rgb(${r},${g},${b})`;
    if (this.hv < 0.26) {
      this.flash = (this.flash + dt * 2.6) % 1;
      const k = 0.72 + 0.28 * Math.sin(this.flash * Math.PI * 2);
      colour = `rgba(255,59,78,${k.toFixed(2)})`;
    }
    this._set(this.health, this.hv, colour);
    this._set(this.armour, this.av, '#5fd0ff');
    setStyle(this.armour.g, 'opacity', this.av < 0.005 ? '0.22' : '1');
  }

  dispose() {
    this.root.remove();
  }
}

/* --------------------------------------------------------- wanted stars --- */

/**
 * Five stars, GTA's grammar: earned stars are gold and solid, the star you are
 * about to lose flashes, and the whole rack flashes while you are inside the
 * search cordon but not spotted. A thin bar under the rack runs down as the
 * cooldown drains, which is the one piece of information GTA V hides and every
 * player wishes it showed.
 */
export class WantedStars {
  constructor(parent) {
    this.root = el('div', 'ow-wanted', parent);
    const svg = svgEl('svg', { viewBox: '0 0 132 26', class: 'ow-stars' }, this.root);
    this.stars = [];
    for (let i = 0; i < 5; i++) {
      const g = svgEl('g', { transform: `translate(${i * 26 + 13} 13)` }, svg);
      const back = svgEl('path', { d: this._star(11.4), class: 'back' }, g);
      const fill = svgEl('path', { d: this._star(9.6), class: 'fill' }, g);
      this.stars.push({ g, back, fill, on: 0, pop: 0 });
    }
    const bar = el('div', 'ow-wanted-bar', this.root);
    this.decay = el('i', null, bar);
    this.bar = bar;

    this.level = 0;
    this.shown = 0;
    this.blink = 0;
    this.cool = 1;
  }

  _star(r) {
    let d = '';
    for (let i = 0; i < 10; i++) {
      const a = (i / 10) * Math.PI * 2 - Math.PI / 2;
      const rr = i % 2 ? r * 0.44 : r;
      d += (i ? 'L' : 'M') + (Math.cos(a) * rr).toFixed(2) + ' ' + (Math.sin(a) * rr).toFixed(2);
    }
    return d + 'Z';
  }

  set(level, cooldown) {
    if (level > this.level) {
      for (let i = this.level; i < level; i++) this.stars[i].pop = 1;
    }
    this.level = clamp(level | 0, 0, 5);
    if (cooldown !== undefined) this.cool = clamp01(cooldown);
  }

  update(dt) {
    this.blink = (this.blink + dt * 3.1) % 1;
    const flick = this.blink < 0.5;
    for (let i = 0; i < 5; i++) {
      const st = this.stars[i];
      const on = i < this.level;
      // The top star flashes only when the cooldown is nearly spent — you are
      // about to lose it. Flashing it for the whole decay (the first pass) made
      // three stars read as two in any still frame, and the floor is 0.45 so it
      // never reads as unlit even mid-blink.
      const dim = on && i === this.level - 1 && this.cool < 0.34 && flick;
      st.on = damp(st.on, on ? 1 : 0, 16, dt);
      st.pop = Math.max(0, st.pop - dt * 3.6);
      const pop = 1 + ease.outBack(clamp01(1 - st.pop)) * 0 + st.pop * 0.55;
      setStyle(st.g, 'transform', `translate(${i * 26 + 13}px, 13px) scale(${pop.toFixed(3)})`);
      setStyle(st.fill, 'opacity', (st.on * (dim ? 0.45 : 1)).toFixed(3));
      setStyle(st.back, 'opacity', on ? '1' : '0.5');
    }
    setStyle(this.bar, 'opacity', this.level > 0 && this.cool < 0.999 ? '1' : '0');
    setStyle(this.decay, 'transform', `scaleX(${this.cool.toFixed(3)})`);
    return this.level > 0 ? 1 : 0;
  }

  dispose() {
    this.root.remove();
  }
}

/* --------------------------------------------------------------- money --- */

/**
 * The counter rolls. A jump straight to the new total reads as a bug; a
 * 0.55 s eased roll with the delta pinned underneath reads as a payout.
 */
export class MoneyCounter {
  constructor(parent) {
    this.root = el('div', 'ow-money', parent);
    this.value = el('div', 'ow-money-v', this.root, '$0');
    this.delta = el('div', 'ow-money-d', this.root, '');
    this.total = 0;
    this.shown = 0;
    this.deltaV = 0;
    this.deltaT = 0;
    this.hold = 0;
    this._txt = '';
  }

  set(total, delta) {
    if (delta) {
      this.deltaV = delta;
      this.deltaT = 2.6;
      this.hold = 3.4;
    }
    this.total = total;
  }

  update(dt) {
    const before = this.shown;
    this.shown = damp(this.shown, this.total, 7.5, dt);
    if (Math.abs(this.shown - this.total) < 0.7) this.shown = this.total;
    const n = Math.round(this.shown);
    const txt = '$' + n.toLocaleString('en-US');
    if (txt !== this._txt) {
      this._txt = txt;
      setText(this.value, txt);
    }
    const moving = Math.abs(this.shown - before) > 0.01;
    setClass(this.value, 'up', moving && this.total > before);

    this.deltaT = Math.max(0, this.deltaT - dt);
    this.hold = Math.max(0, this.hold - dt);
    if (this.deltaT > 0) {
      const d = this.deltaV;
      setText(this.delta, (d >= 0 ? '+$' : '-$') + Math.abs(d).toLocaleString('en-US'));
      setClass(this.delta, 'neg', d < 0);
      const a = clamp01(this.deltaT / 0.45) * clamp01((2.6 - this.deltaT) / 0.18);
      setStyle(this.delta, 'opacity', a.toFixed(3));
      setStyle(this.delta, 'transform', `translateY(${(1 - clamp01((2.6 - this.deltaT) / 0.25)) * -8}px)`);
    } else {
      setStyle(this.delta, 'opacity', '0');
    }
    return this.hold > 0 || Math.abs(this.shown - this.total) > 0.5 ? 1 : 0;
  }

  dispose() {
    this.root.remove();
  }
}

/* -------------------------------------------------------------- respect --- */

/**
 * The second currency, under the money and in the same grammar: an eased roll
 * with the delta pinned underneath, faded out unless it just moved. Respect
 * exists in `game`'s HUD state (`getHudState().respect`) and was previously
 * displayed nowhere outside a toast; this is the persistent two-currency
 * column.
 */
export class RespectCounter {
  constructor(parent) {
    this.root = el('div', 'ow-respect', parent);
    const row = el('div', 'ow-respect-row', this.root);
    this.value = el('span', 'ow-respect-v', row, '0');
    el('span', 'ow-respect-l', row, 'RESPECT');
    this.delta = el('div', 'ow-respect-d', this.root, '');
    this.total = 0;
    this.shown = 0;
    this.deltaV = 0;
    this.deltaT = 0;
    this.hold = 0;
    this._txt = '';
  }

  set(total, delta) {
    if (delta) {
      this.deltaV = delta;
      this.deltaT = 2.6;
      this.hold = 3.4;
    }
    this.total = total;
  }

  update(dt) {
    this.shown = damp(this.shown, this.total, 7.5, dt);
    if (Math.abs(this.shown - this.total) < 0.7) this.shown = this.total;
    const txt = String(Math.round(this.shown));
    if (txt !== this._txt) {
      this._txt = txt;
      setText(this.value, txt);
    }
    this.deltaT = Math.max(0, this.deltaT - dt);
    this.hold = Math.max(0, this.hold - dt);
    if (this.deltaT > 0) {
      const d = this.deltaV;
      setText(this.delta, (d >= 0 ? '+' : '-') + Math.abs(d));
      setClass(this.delta, 'neg', d < 0);
      const a = clamp01(this.deltaT / 0.45) * clamp01((2.6 - this.deltaT) / 0.18);
      setStyle(this.delta, 'opacity', a.toFixed(3));
    } else {
      setStyle(this.delta, 'opacity', '0');
    }
    return this.hold > 0 || Math.abs(this.shown - this.total) > 0.5 ? 1 : 0;
  }

  dispose() {
    this.root.remove();
  }
}

/* ------------------------------------------------ vehicle meter cluster --- */

/**
 * Vehicle health, fuel and nitro while driving. Fuel is a live mechanic (the
 * tank runs dry, six gas stations exist) and without this widget the HUD says
 * nothing at all about it.
 *
 * Everything it reads is optional and per-field:
 *   vehicles.getHudState()  -> health (0..1), fuel (0..1), fuelDry
 *   player.getHudState()    -> nitroFraction (0..1), nitroOn
 * A missing producer hides its row rather than drawing a lie; the cluster
 * itself only appears while seated. Low fuel (<15%) flashes the bar — driven
 * from dt here, never from a CSS keyframe.
 */
export class VehicleCluster {
  constructor(parent) {
    this.root = el('div', 'ow-vehm', parent);
    this.rows = {};
    for (const [key, label, cls] of [
      ['health', 'VEH', 'vh'],
      ['fuel', 'FUEL', 'fu'],
      ['nitro', 'NOS', 'no'],
    ]) {
      const r = el('div', 'ow-vehm-row ' + cls, this.root);
      el('span', 'k', r, label);
      const bar = el('div', 'bar', r);
      const fill = el('i', null, bar);
      this.rows[key] = { r, bar, fill, v: -1 };
    }
    this.shown = 0;
    this.flash = 0;
    setStyle(this.root, 'display', 'none');
  }

  _row(key, frac) {
    const row = this.rows[key];
    const on = typeof frac === 'number' && frac >= 0;
    setStyle(row.r, 'display', on ? '' : 'none');
    if (!on) return;
    const v = clamp01(frac);
    if (Math.abs(v - row.v) > 0.002) {
      row.v = v;
      setStyle(row.fill, 'transform', `scaleX(${v.toFixed(3)})`);
    }
  }

  /** @param {object} veh  ui.state.veh — { on, health, fuel, nitro, nitroOn } */
  update(dt, veh) {
    this.shown = damp(this.shown, veh?.on ? 1 : 0, 12, dt);
    if (this.shown < 0.004) {
      setStyle(this.root, 'display', 'none');
      return 0;
    }
    setStyle(this.root, 'display', '');
    setStyle(this.root, 'opacity', this.shown.toFixed(3));

    this._row('health', veh.health);
    this._row('fuel', veh.fuel);
    this._row('nitro', veh.nitro);

    // Health goes amber then red as the car dies, same ramp as the arcs.
    const hRow = this.rows.health;
    const h = clamp01(veh.health);
    setStyle(hRow.fill, 'background',
      h < 0.25 ? 'var(--blood)' : h < 0.5 ? 'var(--slag-hot)' : '');

    // Low fuel is the warning that matters: below 15% the bar flashes and the
    // label goes red. `dry` pins it solid red — flashing an empty bar is noise.
    const fu = this.rows.fuel;
    const low = typeof veh.fuel === 'number' && veh.fuel >= 0 && veh.fuel < 0.15;
    if (low && veh.fuel > 0.001) {
      this.flash = (this.flash + dt * 2.4) % 1;
      const k = 0.5 + 0.5 * Math.sin(this.flash * Math.PI * 2);
      setStyle(fu.bar, 'opacity', (0.55 + 0.45 * k).toFixed(2));
    } else {
      setStyle(fu.bar, 'opacity', '1');
    }
    setClass(fu.r, 'low', low);

    // Nitro brightens while it is being spent.
    setClass(this.rows.nitro.r, 'on', !!veh.nitroOn);
    return this.shown;
  }

  dispose() {
    this.root.remove();
  }
}

/* -------------------------------------------------------------- weapon --- */

/** Bottom-right chip: silhouette, name, magazine / reserve. */
export class WeaponChip {
  constructor(parent) {
    this.root = el('div', 'ow-weap', parent);
    this.canvas = el('canvas', 'ow-weap-icon', this.root);
    this.g = this.canvas.getContext('2d');
    const col = el('div', 'ow-weap-col', this.root);
    this.name = el('div', 'ow-weap-name', col, 'FISTS');
    const row = el('div', 'ow-weap-row', col);
    this.ammo = el('span', 'ow-weap-ammo', row, '—');
    this.reserve = el('span', 'ow-weap-res', row, '');
    this.bar = el('div', 'ow-weap-bar', this.root);
    this.barFill = el('i', null, this.bar);

    this._glyph = '';
    this._colour = '';
    this.k = 1;
    this.resize(1);
  }

  resize(k) {
    this.k = k;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const px = Math.round(46 * k * dpr);
    if (this.canvas.width !== px) {
      this.canvas.width = px;
      this.canvas.height = px;
      this._glyph = '';
    }
  }

  update(dt, s) {
    const glyph = s.weaponGlyph ?? 'fist';
    const colour = s.reloading ? '#ffb03a' : '#dfe7ee';
    if (glyph !== this._glyph || colour !== this._colour) {
      this._glyph = glyph;
      this._colour = colour;
      const g = this.g;
      const S = this.canvas.width;
      g.setTransform(1, 0, 0, 1, 0, 0);
      g.clearRect(0, 0, S, S);
      g.save();
      g.translate(S * 0.5, S * 0.5);
      g.shadowColor = 'rgba(0,0,0,.85)';
      g.shadowBlur = S * 0.06;
      drawWeaponGlyph(g, glyph, S * 0.92, colour);
      g.restore();
    }
    setText(this.name, s.weaponName ?? '');
    const melee = s.magSize === 0 || s.weaponMelee;
    setText(this.ammo, melee ? '∞' : String(s.ammo | 0));
    setText(this.reserve, melee ? '' : '/ ' + (s.reserve | 0));
    setClass(this.ammo, 'low', !melee && s.magSize > 0 && s.ammo / s.magSize <= 0.25);
    setStyle(this.bar, 'opacity', s.reloading ? '1' : '0');
    setStyle(this.barFill, 'transform', `scaleX(${clamp01(s.reloadProgress ?? 0).toFixed(3)})`);
  }

  dispose() {
    this.root.remove();
  }
}

/* --------------------------------------------------------------- clock --- */

/** Time of day + weather, sitting under the money. Fades unless it changed. */
export class CityClock {
  constructor(parent) {
    this.root = el('div', 'ow-clock', parent);
    this.time = el('span', 't', this.root, '00:00');
    this.wx = el('span', 'w', this.root, 'OVERCAST');
    this.hour = 12;
    this.min = 0;
  }

  set(hour, weather) {
    this.hour = hour;
    if (weather) this.weather = weather;
  }

  update() {
    const h = Math.floor(this.hour) % 24;
    const m = Math.floor((this.hour % 1) * 60);
    setText(this.time, `${h < 10 ? '0' : ''}${h}:${m < 10 ? '0' : ''}${m}`);
    setText(this.wx, (this.weather ?? '').toUpperCase());
  }

  dispose() {
    this.root.remove();
  }
}

export { starPath, roundRect };
