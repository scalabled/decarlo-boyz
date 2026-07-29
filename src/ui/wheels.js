/**
 * ===========================================================================
 * RADIAL SELECTORS — the weapon wheel and the character switch
 * ===========================================================================
 *
 * Both are canvas, not DOM: a radial layout in DOM means twelve absolutely
 * positioned nodes fighting a transform each, and the selected-sector highlight
 * has to be an arc anyway. One canvas draws the whole thing in about forty
 * calls and scales to any DPR.
 *
 * Selection is by ANGLE, not by hover: while the wheel is open, mouse motion
 * integrates into a cursor angle and whichever sector owns that angle is
 * selected. That is what makes GTA's wheel feel instant — you flick, you do not
 * aim. Both wheels slow time to 0.22 while open (`ctx.time.scale`, restored on
 * close) and both are driven from `update(rawDt)` so they animate while the
 * world is nearly stopped.
 */

import { el, clamp, clamp01, damp, ease, lerp, setStyle, FONT_DISPLAY, FONT_STACK, FONT_MONO } from './util.js';
import { drawWeaponGlyph, drawPortrait, shade } from './glyphs.js';
import { roundRect } from './citymap.js';
import { WEAPONS, BOYZ } from './data.js';

const SLOW = 0.22;

class RadialBase {
  constructor(parent, cls) {
    this.root = el('div', 'ow-wheel ' + cls, parent);
    this.canvas = el('canvas', null, this.root);
    this.g = this.canvas.getContext('2d');
    this.open = false;
    this.a = 0; // 0..1 open animation
    this.cursor = -Math.PI / 2;
    this.hasCursor = false;
    this.index = 0;
    this.w = 0;
    this.h = 0;
    this.dpr = Math.min(2, window.devicePixelRatio || 1);
    setStyle(this.root, 'display', 'none');
  }

  resize(w, h) {
    this.w = w;
    this.h = h;
    const pw = Math.round(w * this.dpr);
    const ph = Math.round(h * this.dpr);
    if (this.canvas.width !== pw || this.canvas.height !== ph) {
      this.canvas.width = pw;
      this.canvas.height = ph;
    }
  }

  show(startIndex = 0) {
    if (this.open) return;
    this.open = true;
    this.index = startIndex;
    this.hasCursor = false;
    setStyle(this.root, 'display', '');
  }

  hide() {
    this.open = false;
  }

  /** Integrate mouse/stick motion into the cursor angle. */
  aim(dx, dy) {
    if (Math.abs(dx) + Math.abs(dy) < 1e-4) return;
    this.hasCursor = true;
    this._ax = (this._ax ?? 0) + dx;
    this._ay = (this._ay ?? 0) + dy;
    const m = Math.hypot(this._ax, this._ay);
    if (m > 40) {
      this._ax = (this._ax / m) * 40;
      this._ay = (this._ay / m) * 40;
    }
    if (m > 3) this.cursor = Math.atan2(this._ay, this._ax);
  }

  _tick(dt) {
    this.a = damp(this.a, this.open ? 1 : 0, 18, dt);
    if (!this.open && this.a < 0.004) {
      this.a = 0;
      setStyle(this.root, 'display', 'none');
      this._ax = 0;
      this._ay = 0;
      return false;
    }
    return true;
  }
}

/* -------------------------------------------------------- weapon wheel --- */

export class WeaponWheel extends RadialBase {
  constructor(parent) {
    super(parent, 'ow-wheel-weapons');
    this.ids = [];
    this.ammo = null;
  }

  /** @param {string[]} ids weapon ids for the active brother (six of them). */
  setLoadout(ids, ammo) {
    this.ids = ids ?? [];
    this.ammo = ammo ?? null;
  }

  get selected() {
    return this.ids[this.index] ?? null;
  }

  update(dt) {
    if (!this._tick(dt)) return;
    const n = this.ids.length || 1;
    if (this.hasCursor) {
      // sector 0 starts at 12 o'clock, going clockwise
      const a = this.cursor + Math.PI / 2 + Math.PI / n;
      const norm = ((a % (Math.PI * 2)) + Math.PI * 2) % (Math.PI * 2);
      this.index = Math.min(n - 1, Math.floor((norm / (Math.PI * 2)) * n));
    }
    this._draw();
  }

  _draw() {
    const g = this.g;
    const W = this.canvas.width;
    const H = this.canvas.height;
    const cx = W * 0.5;
    const cy = H * 0.5;
    const k = ease.outCubic(this.a);
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.clearRect(0, 0, W, H);

    // dim the world; the wheel owns the screen while it is up
    g.fillStyle = `rgba(4,6,9,${(0.62 * k).toFixed(3)})`;
    g.fillRect(0, 0, W, H);

    const R = Math.min(W, H) * 0.34 * lerp(0.86, 1, k);
    const R0 = R * 0.40;
    const n = this.ids.length || 1;
    const step = (Math.PI * 2) / n;
    const gap = 0.028;

    g.globalAlpha = k;
    for (let i = 0; i < n; i++) {
      const id = this.ids[i];
      const w = WEAPONS[id] ?? { name: id ?? '—', glyph: 'fist', mag: 0 };
      const sel = i === this.index;
      const a0 = -Math.PI / 2 - step * 0.5 + i * step + gap;
      const a1 = a0 + step - gap * 2;
      const ro = sel ? R * 1.08 : R;
      const ri = R0;

      g.beginPath();
      g.arc(cx, cy, ro, a0, a1);
      g.arc(cx, cy, ri, a1, a0, true);
      g.closePath();

      if (sel) {
        const grd = g.createRadialGradient(cx, cy, ri, cx, cy, ro);
        grd.addColorStop(0, 'rgba(255,106,18,.30)');
        grd.addColorStop(1, 'rgba(255,176,58,.62)');
        g.fillStyle = grd;
      } else {
        g.fillStyle = 'rgba(11,15,21,.84)';
      }
      g.fill();
      g.strokeStyle = sel ? 'rgba(255,201,60,.95)' : 'rgba(125,140,163,.26)';
      g.lineWidth = sel ? 2.6 * this.dpr : 1.2 * this.dpr;
      g.stroke();

      // Glyph, name and ammo stack VERTICALLY around the sector's centroid, and
      // the name is shrunk to the chord the sector actually offers at that
      // radius. Two earlier attempts failed here: a fixed screen-y offset let
      // "NITRO LAUNCHER" run under the hub, and stacking radially instead flung
      // the labels outside the wheel on the side sectors. Anchor radially, lay
      // out vertically, clamp the width — all three constraints at once.
      const am = (a0 + a1) * 0.5;
      const anchor = ri + (ro - ri) * 0.55;
      const ax = cx + Math.cos(am) * anchor;
      const ay = cy + Math.sin(am) * anchor;
      const maxW = 2 * anchor * Math.sin(Math.max(0.12, (a1 - a0) * 0.5)) * 0.82;

      g.save();
      g.translate(ax, ay - R * 0.1);
      const empty = !w.melee && this._count(id) === 0;
      g.globalAlpha = k * (empty ? 0.3 : 1);
      drawWeaponGlyph(g, w.glyph, R * 0.3, sel ? '#fff3d8' : '#c3cedb');
      g.restore();

      g.textAlign = 'center';
      g.textBaseline = 'middle';
      g.globalAlpha = k * (empty ? 0.42 : 1);
      let fs = R * 0.092;
      g.font = `400 ${fs.toFixed(1)}px ${FONT_DISPLAY}`;
      const wpx = g.measureText(w.name).width;
      if (wpx > maxW) {
        fs *= maxW / wpx;
        g.font = `400 ${fs.toFixed(1)}px ${FONT_DISPLAY}`;
      }
      g.fillStyle = sel ? '#1a0f03' : 'rgba(222,231,241,.95)';
      if (!sel) {
        g.strokeStyle = 'rgba(4,7,10,.88)';
        g.lineWidth = 3.4 * this.dpr;
        g.lineJoin = 'round';
        g.strokeText(w.name, ax, ay + R * 0.085);
      }
      g.fillText(w.name, ax, ay + R * 0.085);
      if (!w.melee) {
        g.font = `700 ${(R * 0.062).toFixed(1)}px ${FONT_MONO}`;
        g.fillStyle = sel ? 'rgba(30,16,2,.9)' : 'rgba(255,201,60,.85)';
        if (!sel) {
          g.strokeStyle = 'rgba(4,7,10,.88)';
          g.lineWidth = 3 * this.dpr;
          g.strokeText(String(this._count(id)), ax, ay + R * 0.165);
        }
        g.fillText(String(this._count(id)), ax, ay + R * 0.165);
      }
      g.globalAlpha = k;
    }

    // ---- hub --------------------------------------------------------------
    g.beginPath();
    g.arc(cx, cy, R0 - 4 * this.dpr, 0, Math.PI * 2);
    g.fillStyle = 'rgba(6,9,13,.92)';
    g.fill();
    g.strokeStyle = 'rgba(255,106,18,.55)';
    g.lineWidth = 1.6 * this.dpr;
    g.stroke();

    const sel = WEAPONS[this.ids[this.index]] ?? null;
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.fillStyle = 'rgba(125,140,163,.9)';
    g.font = `600 ${(R * 0.062).toFixed(0)}px ${FONT_MONO}`;
    g.fillText('WEAPONS', cx, cy - R * 0.2);
    g.fillStyle = '#f2ede0';
    g.font = `400 ${(R * 0.17).toFixed(0)}px ${FONT_DISPLAY}`;
    g.fillText(sel?.name ?? '—', cx, cy - R * 0.04);
    g.fillStyle = '#ffc93c';
    g.font = `700 ${(R * 0.12).toFixed(0)}px ${FONT_MONO}`;
    g.fillText(sel?.melee ? 'MELEE' : this._count(this.ids[this.index]) + ' RNDS', cx, cy + R * 0.16);

    g.globalAlpha = 1;
  }

  _count(id) {
    if (this.ammo && this.ammo[id] !== undefined) return this.ammo[id];
    return WEAPONS[id]?.ammo ?? 0;
  }
}

/* ----------------------------------------------------- character switch --- */

/**
 * Three brothers on a triangle, GTA V's switch wheel in Steel City's language:
 * each portrait sits in a plate ringed in his own signature colour, the
 * selected one lifts and lights, and his turf, rival and vitals print beside
 * the hub so switching is a decision and not a lottery.
 */
export class CharacterWheel extends RadialBase {
  constructor(parent) {
    super(parent, 'ow-wheel-chars');
    this.index = 1;
    this.portraits = [];
    for (const b of BOYZ) {
      const c = document.createElement('canvas');
      c.width = 200;
      c.height = 200;
      drawPortrait(c.getContext('2d'), b, 200);
      this.portraits.push(c);
    }
  }

  get selected() {
    return BOYZ[this.index]?.id ?? null;
  }

  update(dt) {
    if (!this._tick(dt)) return;
    if (this.hasCursor) {
      const a = this.cursor + Math.PI / 2 + Math.PI / 3;
      const norm = ((a % (Math.PI * 2)) + Math.PI * 2) % (Math.PI * 2);
      this.index = Math.min(2, Math.floor((norm / (Math.PI * 2)) * 3));
    }
    this._draw();
  }

  _draw() {
    const g = this.g;
    const W = this.canvas.width;
    const H = this.canvas.height;
    const cx = W * 0.5;
    const cy = H * 0.5;
    const k = ease.outCubic(this.a);
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.clearRect(0, 0, W, H);
    g.fillStyle = `rgba(4,6,9,${(0.68 * k).toFixed(3)})`;
    g.fillRect(0, 0, W, H);

    // Sized so the top portrait clears the top of a 16:9 frame at its selected
    // scale and the inner edge never reaches the hub. Both were violated by the
    // first pass and Carson lost the top of his head off-screen.
    const R = Math.min(W, H) * 0.225 * lerp(0.9, 1, k);
    const P = R * 0.46; // portrait plate half-size

    g.globalAlpha = k;
    for (let i = 0; i < 3; i++) {
      const b = BOYZ[i];
      const sel = i === this.index;
      const a = -Math.PI / 2 + (i * Math.PI * 2) / 3;
      const px = cx + Math.cos(a) * R * 1.42;
      const py = cy + Math.sin(a) * R * 1.42;
      const s = P * (sel ? 1.16 : 0.92);

      g.save();
      g.translate(px, py);
      // plate
      g.shadowColor = sel ? b.colour : 'rgba(0,0,0,.8)';
      g.shadowBlur = sel ? 34 * this.dpr : 12 * this.dpr;
      roundRect(g, -s, -s, s * 2, s * 2, s * 0.16);
      g.fillStyle = '#0a0e13';
      g.fill();
      g.shadowBlur = 0;

      g.save();
      roundRect(g, -s, -s, s * 2, s * 2, s * 0.16);
      g.clip();
      g.globalAlpha = k * (sel ? 1 : 0.52);
      g.drawImage(this.portraits[i], -s, -s, s * 2, s * 2);
      g.restore();

      g.globalAlpha = k;
      roundRect(g, -s, -s, s * 2, s * 2, s * 0.16);
      g.strokeStyle = sel ? b.accent : 'rgba(125,140,163,.34)';
      g.lineWidth = (sel ? 3.2 : 1.4) * this.dpr;
      g.stroke();

      // name tab
      g.fillStyle = sel ? b.colour : 'rgba(10,14,19,.92)';
      roundRect(g, -s, s * 0.6, s * 2, s * 0.4, s * 0.06);
      g.fill();
      g.fillStyle = sel ? '#0b0d10' : 'rgba(212,222,232,.82)';
      g.font = `400 ${(s * 0.32).toFixed(0)}px ${FONT_DISPLAY}`;
      g.textAlign = 'center';
      g.textBaseline = 'middle';
      g.fillText(b.name, 0, s * 0.815);
      g.restore();
    }

    // ---- hub: the four stats, and nothing that can overflow it -----------
    const b = BOYZ[this.index];
    const hub = R * 0.62;
    g.beginPath();
    g.arc(cx, cy, hub, 0, Math.PI * 2);
    g.fillStyle = 'rgba(6,9,13,.95)';
    g.fill();
    g.strokeStyle = b.colour;
    g.lineWidth = 2 * this.dpr;
    g.stroke();

    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.fillStyle = 'rgba(125,140,163,.85)';
    g.font = `600 ${(hub * 0.125).toFixed(0)}px ${FONT_MONO}`;
    g.fillText('SWITCH TO', cx, cy - hub * 0.66);
    g.fillStyle = b.accent;
    g.font = `400 ${(hub * 0.185).toFixed(0)}px ${FONT_DISPLAY}`;
    g.fillText(b.role.toUpperCase(), cx, cy - hub * 0.46);

    // stat bars, laid out inside the hub circle rather than across it
    const bw = hub * 1.06;
    const bh = hub * 0.088;
    const top = cy - hub * 0.2;
    for (let i = 0; i < b.stats.length; i++) {
      const [label, v] = b.stats[i];
      const y = top + i * bh * 2.35;
      g.textAlign = 'right';
      g.fillStyle = 'rgba(150,166,186,.85)';
      g.font = `600 ${(hub * 0.105).toFixed(0)}px ${FONT_MONO}`;
      g.fillText(label, cx - bw * 0.16, y + bh * 0.5);
      g.fillStyle = 'rgba(255,255,255,.10)';
      g.fillRect(cx - bw * 0.1, y, bw * 0.6, bh);
      g.fillStyle = b.colour;
      g.fillRect(cx - bw * 0.1, y, bw * 0.6 * v, bh);
    }

    // ---- caption under the whole wheel: turf, rival, vitals --------------
    // Outside the hub, where a long district name has room to be a long
    // district name.
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    // Directly below the two lower portraits — computed, not guessed, so it
    // cannot walk off the bottom of the frame at a different aspect ratio.
    const capY = cy + R * 1.42 * 0.5 + P * 1.16 + R * 0.26;
    g.fillStyle = '#eef2f6';
    g.font = `400 ${(R * 0.17).toFixed(0)}px ${FONT_DISPLAY}`;
    g.strokeStyle = 'rgba(4,7,10,.9)';
    g.lineWidth = 4 * this.dpr;
    g.lineJoin = 'round';
    g.strokeText(b.turf, cx, capY);
    g.fillText(b.turf, cx, capY);
    g.fillStyle = b.accent;
    g.font = `600 ${(R * 0.082).toFixed(0)}px ${FONT_MONO}`;
    g.strokeText('RIVAL · ' + b.rival, cx, capY + R * 0.19);
    g.fillText('RIVAL · ' + b.rival, cx, capY + R * 0.19);
    g.fillStyle = 'rgba(150,166,186,.8)';
    g.font = `600 ${(R * 0.076).toFixed(0)}px ${FONT_MONO}`;
    const vit = `${b.hp} HP · ${b.armour} ARMOUR · ${b.weapons.length} WEAPONS`;
    g.strokeText(vit, cx, capY + R * 0.34);
    g.fillText(vit, cx, capY + R * 0.34);
    g.globalAlpha = 1;
  }
}

export { SLOW };
