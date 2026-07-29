/**
 * ===========================================================================
 * THE PAUSE MAP
 * ===========================================================================
 *
 * The full-screen version of the same street map the Slag Ring draws — same
 * `CityMap`, same projection, so the two can never disagree about north.
 *
 * Pan with drag, zoom with the wheel (anchored on the cursor, which is the
 * difference between a map and a slideshow), click to drop a waypoint. Twelve
 * districts and six landmarks label themselves by zoom level; safehouses,
 * shops, gas and docks carry names once you are close enough for them to fit;
 * hidden packages appear only once found, so the map is a record of what you
 * have done rather than a checklist handed to you.
 */

import { el, setText, setStyle, clamp, clamp01, damp, ease, FONT_STACK } from './util.js';
import { CityMap, drawIcon, drawPlayerArrow } from './citymap.js';
import {
  POI_STYLE, buildPoiList, PACKAGES, RACES, DISTRICTS, HALF_CITY, districtAt,
} from './data.js';

const MIN_PPM = 0.13;
const MAX_PPM = 2.4;

export class PauseMap {
  constructor(parent, cityMap, ctx) {
    this.ctx = ctx;
    this.map = cityMap;
    this.pois = buildPoiList();

    this.root = el('div', 'ow-map', parent);
    this.canvas = el('canvas', 'ow-map-canvas', this.root);
    this.g = this.canvas.getContext('2d');

    const top = el('div', 'ow-map-top', this.root);
    const ttl = el('div', 'ow-map-ttl', top);
    el('div', 'eyebrow', ttl, 'ALLEGHENY COUNTY · PA');
    el('h2', null, ttl, 'STEEL CITY');
    this.where = el('div', 'ow-map-where', top, '');
    this.counts = el('div', 'ow-map-counts', top, '');

    const legend = el('div', 'ow-map-legend', this.root);
    this.legendRows = [];
    // Live contacts (mission, cops, hostiles, crew) sit at the top of the
    // legend because they are the rows that change what you do next.
    for (const k of ['mission', 'cop', 'enemy', 'friend', 'safehouse', 'ammo',
      'spray', 'food', 'gas', 'dock', 'landmark', 'race', 'package', 'waypoint']) {
      const st = POI_STYLE[k];
      const row = el('div', 'lg', legend);
      const sw = el('i', null, row);
      setStyle(sw, 'background', st.c);
      el('span', null, row, st.label);
    }
    this.hint = el('div', 'ow-map-hint', this.root);
    this._hintTouch = null;
    this.setTouch(false);

    // The one guaranteed way out on a phone: opening the map hides the touch
    // layer (including the MAP button that opened it), and a pinch-less canvas
    // has no M key. Same corner, same size, same class as the pause menu's ✕.
    this.closeBtn = el('button', 'ow-modal-x', this.root, '✕');
    this.closeBtn.type = 'button';
    this.closeBtn.setAttribute('aria-label', 'Close map');
    const bye = () => this.onClose?.();
    this.closeBtn.addEventListener('click', bye);
    this.closeBtn.addEventListener('touchend', (e) => {
      e.preventDefault();
      e.stopPropagation();
      bye();
    }, { passive: false });

    this.open = false;
    this.a = 0;
    this.cx = 0;
    this.cz = 0;
    this.ppm = 0.42;
    this.targetPpm = 0.42;
    this.w = 0;
    this.h = 0;
    this.dpr = Math.min(2, window.devicePixelRatio || 1);
    this.found = new Set();
    this.waypoint = null;
    /** Live contacts, same array the Slag Ring draws — set by ui each frame. */
    this.blips = null;
    this.player = { x: 0, z: 0, heading: 0, colour: '#ff6a12', inVehicle: false };
    this._drag = null;
    this._pt = [0, 0];
    this._view = {
      cx: 0, cz: 0, ppm: 1, rot: 0, w: 0, h: 0,
      alleys: true, tint: true, labels: true, labelScale: 1, px: 1, font: FONT_STACK,
    };

    setStyle(this.root, 'display', 'none');
    this._bind();
  }

  _bind() {
    const c = this.canvas;
    this._onDown = (e) => {
      this._drag = { x: e.clientX, y: e.clientY, cx: this.cx, cz: this.cz, moved: 0 };
      c.setPointerCapture?.(e.pointerId);
    };
    this._onMove = (e) => {
      if (!this._drag) return;
      const dx = e.clientX - this._drag.x;
      const dy = e.clientY - this._drag.y;
      this._drag.moved = Math.max(this._drag.moved, Math.hypot(dx, dy));
      this.cx = this._drag.cx - dx / this.ppm;
      this.cz = this._drag.cz - dy / this.ppm;
      this._clampCentre();
    };
    this._onUp = (e) => {
      const d = this._drag;
      this._drag = null;
      if (d && d.moved < 4) this._placeWaypoint(e.clientX, e.clientY);
    };
    this._onWheel = (e) => {
      e.preventDefault();
      const r = c.getBoundingClientRect();
      const mx = e.clientX - r.left - r.width * 0.5;
      const my = e.clientY - r.top - r.height * 0.5;
      const before = this.ppm;
      this.targetPpm = clamp(this.targetPpm * Math.exp(-e.deltaY * 0.0016), MIN_PPM, MAX_PPM);
      // keep the world point under the cursor fixed
      const after = this.targetPpm;
      this.cx += mx / before - mx / after;
      this.cz += my / before - my / after;
      this._clampCentre();
    };
    c.addEventListener('pointerdown', this._onDown);
    c.addEventListener('pointermove', this._onMove);
    c.addEventListener('pointerup', this._onUp);
    c.addEventListener('wheel', this._onWheel, { passive: false });
  }

  _clampCentre() {
    const lim = HALF_CITY * 1.05;
    this.cx = clamp(this.cx, -lim, lim);
    this.cz = clamp(this.cz, -lim, lim);
  }

  _placeWaypoint(clientX, clientY) {
    const r = this.canvas.getBoundingClientRect();
    const mx = clientX - r.left - r.width * 0.5;
    const my = clientY - r.top - r.height * 0.5;
    const x = this.cx + mx / this.ppm;
    const z = this.cz + my / this.ppm;
    if (this.waypoint && Math.hypot(this.waypoint.x - x, this.waypoint.z - z) < 40 / this.ppm) {
      this.waypoint = null;
    } else {
      this.waypoint = { x, z };
    }
    this.onWaypoint?.(this.waypoint);
  }

  /** Touch players get told about the controls they actually have. */
  setTouch(on) {
    if (this._hintTouch === on) return;
    this._hintTouch = on;
    this.hint.textContent = '';
    const lines = on
      ? ['DRAG — PAN', 'TAP — SET WAYPOINT', '✕ — CLOSE']
      : ['DRAG — PAN', 'WHEEL — ZOOM', 'CLICK — SET WAYPOINT', 'M / ESC — CLOSE'];
    for (const l of lines) el('div', null, this.hint, l);
  }

  show(player) {
    this.open = true;
    if (player) {
      this.cx = player.x;
      this.cz = player.z;
    }
    setStyle(this.root, 'display', '');
  }

  hide() {
    this.open = false;
  }

  toggle(player) {
    if (this.open) this.hide();
    else this.show(player);
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

  update(dt, player) {
    this.a = damp(this.a, this.open ? 1 : 0, 15, dt);
    if (!this.open && this.a < 0.005) {
      setStyle(this.root, 'display', 'none');
      return 0;
    }
    if (player) Object.assign(this.player, player);
    setStyle(this.root, 'opacity', this.a.toFixed(3));
    this.ppm = damp(this.ppm, this.targetPpm, 14, dt);
    this._draw();

    const d = districtAt(this.cx, this.cz);
    setText(this.where, d ? d.name : '');
    setText(this.counts, `PACKAGES ${this.found.size} / ${PACKAGES.length}`);
    return this.a;
  }

  _draw() {
    const g = this.g;
    const W = this.canvas.width;
    const H = this.canvas.height;
    const ppm = this.ppm * this.dpr;
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.clearRect(0, 0, W, H);
    g.fillStyle = '#070a0d';
    g.fillRect(0, 0, W, H);

    const v = this._view;
    v.cx = this.cx;
    v.cz = this.cz;
    v.ppm = ppm;
    v.rot = 0;
    v.w = W;
    v.h = H;
    v.alleys = ppm > 0.6;
    v.labels = true;
    v.px = this.dpr;
    v.labelScale = this.dpr * clamp(0.7 + ppm * 0.7, 0.9, 1.9);
    this.map.draw(g, v);

    const proj = (x, z, out) => {
      out[0] = W * 0.5 + (x - this.cx) * ppm;
      out[1] = H * 0.5 + (z - this.cz) * ppm;
      return out;
    };
    const p = this._pt;
    const u = this.dpr;

    // ---- graticule: 250 m, so distances are readable off the map ---------
    g.strokeStyle = 'rgba(125,140,163,.07)';
    g.lineWidth = 1 * u;
    g.beginPath();
    const step = ppm > 0.9 ? 100 : 250;
    const x0 = Math.ceil((this.cx - W * 0.5 / ppm) / step) * step;
    const x1 = this.cx + W * 0.5 / ppm;
    for (let x = x0; x < x1; x += step) {
      const sx = Math.round(W * 0.5 + (x - this.cx) * ppm) + 0.5;
      g.moveTo(sx, 0);
      g.lineTo(sx, H);
    }
    const z0 = Math.ceil((this.cz - H * 0.5 / ppm) / step) * step;
    const z1 = this.cz + H * 0.5 / ppm;
    for (let z = z0; z < z1; z += step) {
      const sy = Math.round(H * 0.5 + (z - this.cz) * ppm) + 0.5;
      g.moveTo(0, sy);
      g.lineTo(W, sy);
    }
    g.stroke();

    // ---- race circuits ----------------------------------------------------
    if (ppm > 0.2) {
      g.strokeStyle = 'rgba(123,240,216,.34)';
      g.lineWidth = 2 * u;
      g.setLineDash([7 * u, 6 * u]);
      for (const key in RACES) {
        const pts = RACES[key].pts;
        g.beginPath();
        for (let i = 0; i < pts.length; i += 2) {
          proj(pts[i], pts[i + 1], p);
          if (i === 0) g.moveTo(p[0], p[1]);
          else g.lineTo(p[0], p[1]);
        }
        g.closePath();
        g.stroke();
      }
      g.setLineDash([]);
    }

    // ---- POIs -------------------------------------------------------------
    const r = clamp(7 * u * clamp(ppm * 1.6, 0.7, 1.5), 6 * u, 13 * u);
    const nameAt = ppm > 0.62;
    g.textAlign = 'center';
    g.textBaseline = 'top';
    g.font = `600 ${(8.6 * u).toFixed(1)}px ${FONT_STACK}`;
    for (let i = 0; i < this.pois.length; i++) {
      const poi = this.pois[i];
      const st = POI_STYLE[poi.kind];
      if (!st) continue;
      if (ppm < 0.3 && st.p < 3) continue;
      proj(poi.x, poi.z, p);
      if (p[0] < -40 || p[1] < -40 || p[0] > W + 40 || p[1] > H + 40) continue;
      drawIcon(g, st.g, p[0], p[1], r, st.c, 1);
      if (nameAt && st.p >= 3) {
        g.strokeStyle = 'rgba(4,7,10,.9)';
        g.lineWidth = 3 * u;
        g.lineJoin = 'round';
        g.strokeText(poi.name, p[0], p[1] + r * 1.25);
        g.fillStyle = 'rgba(214,225,236,.86)';
        g.fillText(poi.name, p[0], p[1] + r * 1.25);
      }
    }

    // ---- hidden packages, once found -------------------------------------
    for (let i = 0; i < PACKAGES.length; i++) {
      if (!this.found.has(PACKAGES[i].id)) continue;
      proj(PACKAGES[i].x, PACKAGES[i].z, p);
      drawIcon(g, 'pkg', p[0], p[1], r * 0.86, POI_STYLE.package.c, 1);
    }

    // ---- live contacts ----------------------------------------------------
    // The same blip array the minimap draws (cops, hostiles, crew, mission
    // points), so the two views can never disagree about who is where. The
    // full map used to draw a city with nobody in it.
    const bl = this.blips;
    if (bl) {
      for (let i = 0; i < bl.length; i++) {
        const b = bl[i];
        if (!b || !Number.isFinite(b.x) || !Number.isFinite(b.z)) continue;
        const st = POI_STYLE[b.kind] ?? POI_STYLE.enemy;
        // Per-contact colour first — same rule as the ring, so the two views
        // cannot disagree about which brother is which.
        const ink = b.colour ?? st.c;
        proj(b.x, b.z, p);
        if (p[0] < -20 || p[1] < -20 || p[0] > W + 20 || p[1] > H + 20) continue;
        if (b.kind === 'mission') {
          drawIcon(g, 'mission', p[0], p[1], r * 1.05, ink, 1);
        } else {
          drawIcon(g, 'dot', p[0], p[1], r * 0.6, ink, 0.95);
        }
      }
    }

    // ---- waypoint ---------------------------------------------------------
    if (this.waypoint) {
      proj(this.waypoint.x, this.waypoint.z, p);
      g.strokeStyle = POI_STYLE.waypoint.c;
      g.lineWidth = 1.4 * u;
      g.setLineDash([4 * u, 4 * u]);
      g.beginPath();
      g.arc(p[0], p[1], r * 2.1, 0, Math.PI * 2);
      g.stroke();
      g.setLineDash([]);
      drawIcon(g, 'flag', p[0], p[1], r * 1.1, POI_STYLE.waypoint.c, 1);
    }

    // ---- the player -------------------------------------------------------
    proj(this.player.x, this.player.z, p);
    g.save();
    g.translate(p[0], p[1]);
    g.rotate((this.player.heading * Math.PI) / 180);
    g.shadowColor = 'rgba(0,0,0,.9)';
    g.shadowBlur = 8 * u;
    drawPlayerArrow(g, 9 * u, this.player.colour, this.player.inVehicle);
    g.restore();
    g.shadowBlur = 0;

    // ---- scale bar --------------------------------------------------------
    const targetPx = 160 * u;
    const nice = [50, 100, 200, 250, 500, 1000, 2000];
    let metres = nice[nice.length - 1];
    for (const m of nice) {
      if (m * ppm >= targetPx * 0.55) {
        metres = m;
        break;
      }
    }
    const barW = metres * ppm;
    const bx = W - barW - 34 * u;
    const by = H - 118 * u;
    g.strokeStyle = 'rgba(230,238,246,.7)';
    g.lineWidth = 2 * u;
    g.beginPath();
    g.moveTo(bx, by - 5 * u);
    g.lineTo(bx, by);
    g.lineTo(bx + barW, by);
    g.lineTo(bx + barW, by - 5 * u);
    g.stroke();
    g.fillStyle = 'rgba(230,238,246,.8)';
    g.textAlign = 'center';
    g.textBaseline = 'bottom';
    g.font = `700 ${(10 * u).toFixed(1)}px ${FONT_STACK}`;
    g.fillText(metres >= 1000 ? metres / 1000 + ' KM' : metres + ' M', bx + barW * 0.5, by - 7 * u);

    // ---- compass rose -----------------------------------------------------
    const rx = W - 62 * u;
    const ry = 96 * u;
    g.save();
    g.translate(rx, ry);
    g.strokeStyle = 'rgba(125,140,163,.4)';
    g.lineWidth = 1.4 * u;
    g.beginPath();
    g.arc(0, 0, 26 * u, 0, Math.PI * 2);
    g.stroke();
    g.fillStyle = '#ff3b4e';
    g.beginPath();
    g.moveTo(0, -26 * u);
    g.lineTo(6 * u, -6 * u);
    g.lineTo(-6 * u, -6 * u);
    g.closePath();
    g.fill();
    g.fillStyle = 'rgba(180,195,210,.7)';
    g.beginPath();
    g.moveTo(0, 26 * u);
    g.lineTo(6 * u, 6 * u);
    g.lineTo(-6 * u, 6 * u);
    g.closePath();
    g.fill();
    g.fillStyle = '#e8e2d4';
    g.font = `400 ${(15 * u).toFixed(1)}px ${FONT_STACK}`;
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.fillText('N', 0, -38 * u);
    g.restore();
  }

  dispose() {
    this.closeBtn?.remove();
    const c = this.canvas;
    c.removeEventListener('pointerdown', this._onDown);
    c.removeEventListener('pointermove', this._onMove);
    c.removeEventListener('pointerup', this._onUp);
    c.removeEventListener('wheel', this._onWheel);
    this.root.remove();
  }
}
