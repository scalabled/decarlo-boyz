/**
 * ===========================================================================
 * THE SLAG RING — the signature element
 * ===========================================================================
 *
 * A cast-iron bezel around a live street map of Steel City. The iron HEATS as
 * the wanted level climbs: at 0 stars it is cold grey cast iron with machined
 * highlights; by 5 stars the whole ring is molten, throwing orange light onto
 * the frame around it. That is the game's motif and this is where it lives.
 *
 * The bezel is CSS (conic gradients, a blurred drop-shadow bloom, rivets) —
 * cheap, crisp at any DPR, and it can glow outside its own box. The map disc is
 * canvas: streets from `CityMap`, then route, POIs, blips, the search cone and
 * the player chevron, in that order, all clipped to the circle.
 *
 * ORIENTATION
 *   Two modes, `heading-up` (default, the map counter-rotates under a fixed
 *   chevron) and `north-up`. The north marker rides the bezel and always points
 *   at world -Z, so the mode is legible without a label.
 *
 * ZOOM
 *   `viewSpan` eases from 190 m at a standstill to 620 m at motorway speed, so
 *   the road you are about to be on is always on the disc. Entering a vehicle
 *   pulls out; a 3+ star chase pulls out further so the cordon is visible.
 */

import * as THREE from 'three';
import { el, clamp, clamp01, damp, lerp, setStyle, setText, FONT_STACK, FONT_MONO } from './util.js';
import { CityMap, drawIcon, drawPlayerArrow, MAP_INK } from './citymap.js';
import { POI_STYLE, buildPoiList, districtAt } from './data.js';

const SPAN_IDLE = 190;
const SPAN_FAST = 440;

/**
 * Negative-control hatch for the AFB findability gate (src/ui/afbprobe.mjs):
 * `?nomilitary=1` drops the Ridgeline AFB pin from the minimap too, matching
 * `pausemap.js` / `cheats.js`, so the probe's "blip when near" check measures
 * PRESENCE and not a constant. No effect without the flag.
 */
function militaryHidden() {
  if (typeof location === 'undefined') return false;
  try {
    return new URLSearchParams(location.search).get('nomilitary') === '1';
  } catch { return false; }
}

export class SlagRing {
  constructor(parent, rng, ctx) {
    this.ctx = ctx;
    this.root = el('div', 'ow-radar', parent);

    this.bloom = el('div', 'ow-radar-bloom', this.root);
    this.ring = el('div', 'ow-radar-ring', this.root);
    this.heat = el('div', 'ow-radar-heat', this.root);
    this.inner = el('div', 'ow-radar-inner', this.root);
    this.canvas = el('canvas', null, this.inner);
    this.g = this.canvas.getContext('2d');
    // Four rivets on the diagonals — the steel-fabrication motif.
    for (let i = 0; i < 4; i++) el('div', 'ow-radar-rivet r' + i, this.root);
    this.northMark = el('div', 'ow-radar-n', this.root);
    el('i', null, this.northMark);

    const tag = el('div', 'ow-radar-tag', this.root);
    this.zoneEl = el('span', 'zone', tag, 'THE POINT');
    this.streetEl = el('div', 'ow-radar-street', this.root, '');

    this.map = new CityMap(rng);
    this.pois = buildPoiList();
    if (militaryHidden()) this.pois = this.pois.filter((p) => p.kind !== 'military');

    this.k = 1;
    this.cssSize = 196;
    this.px = 0;
    this.viewSpan = SPAN_IDLE;
    this.headingUp = true;
    this.rot = 0;
    this.heatV = 0;
    this.sweep = 0;
    this.pulse = 0;
    this.time = 0;
    this._refreshT = 0;
    this._zone = '';

    this._pos = new THREE.Vector3();
    this._view = {
      cx: 0, cz: 0, ppm: 1, rot: 0, w: 0, h: 0,
      alleys: true, tint: true, labels: false, labelScale: 1, px: 1, font: FONT_STACK,
    };
    this._pt = [0, 0];

    this.resize(1);
  }

  resize(k) {
    this.k = k;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    // The disc is the bezel minus its thickness (see --radar-bezel in style.js).
    const css = this.cssSize * k;
    const px = Math.round((css - 2 * 9 * k) * dpr);
    if (this.canvas.width !== px) {
      this.canvas.width = px;
      this.canvas.height = px;
    }
    this.px = px;
    this.dpr = dpr;
  }

  setMode(headingUp) {
    this.headingUp = !!headingUp;
  }

  /* --------------------------------------------------------------- draw --- */

  /**
   * @param {object} s state from UiSystem:
   *   { x, z, heading, speed, inVehicle, wanted, wantedSearch, hunting,
   *     blips[], route[], waypoint, mission[], dt }
   */
  draw(s, dt) {
    this.time += dt;
    const S = this.px;
    if (!S) return;
    const g = this.g;
    const half = S * 0.5;

    // ---- adopt the real road graph as soon as world publishes one ---------
    this._refreshT -= dt;
    if (!this.map.live && this._refreshT <= 0) {
      this._refreshT = 0.5;
      this.map.refresh(this.ctx);
    }

    // ---- zoom -------------------------------------------------------------
    const spd = s.speed ?? 0;
    let want = lerp(SPAN_IDLE, SPAN_FAST, clamp01(spd / 42));
    if ((s.wanted ?? 0) >= 3) want *= 1.16;
    this.viewSpan = damp(this.viewSpan, want, 2.4, dt);
    const ppm = S / this.viewSpan;

    // ---- rotation ---------------------------------------------------------
    const head = ((s.heading ?? 0) * Math.PI) / 180;
    const target = this.headingUp ? -head : 0;
    // shortest-arc approach so the map never spins the long way round
    let d = target - this.rot;
    while (d > Math.PI) d -= Math.PI * 2;
    while (d < -Math.PI) d += Math.PI * 2;
    this.rot += d * (1 - Math.exp(-16 * dt));

    // ---- heat -------------------------------------------------------------
    const wanted = clamp(s.wanted ?? 0, 0, 5);
    this.heatV = damp(this.heatV, wanted / 5, 3.2, dt);
    this.pulse = wanted > 0 ? (this.pulse + dt * (1.4 + wanted * 0.42)) % 1 : 0;
    // Coverage and intensity are separate: --heat is how far round the molten
    // front has travelled (never modulated, or five stars would never close the
    // loop), --flare is the breathing brightness on top of it.
    const flare = wanted > 0 ? 0.84 + 0.16 * Math.sin(this.pulse * Math.PI * 2) : 1;
    setStyle(this.root, '--heat', this.heatV.toFixed(3));
    setStyle(this.root, '--heat-raw', this.heatV.toFixed(3));
    setStyle(this.root, '--flare', flare.toFixed(3));

    // ---- canvas -----------------------------------------------------------
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.clearRect(0, 0, S, S);
    g.save();
    g.beginPath();
    g.arc(half, half, half, 0, Math.PI * 2);
    g.clip();

    const v = this._view;
    v.cx = s.x ?? 0;
    v.cz = s.z ?? 0;
    v.ppm = ppm;
    v.rot = this.rot;
    v.w = S;
    v.h = S;
    v.alleys = ppm > 0.55;
    v.labels = false;
    v.px = this.dpr * this.k;
    this.map.draw(g, v);

    // Everything from here is screen space around the disc centre.
    const cos = Math.cos(this.rot);
    const sin = Math.sin(this.rot);
    const proj = (x, z, out) => {
      const dx = (x - v.cx) * ppm;
      const dz = (z - v.cz) * ppm;
      out[0] = half + dx * cos - dz * sin;
      out[1] = half + dx * sin + dz * cos;
      return out;
    };
    const u = S / 190; // device px per design px (the disc is authored at 190)

    // ---- police search cordon --------------------------------------------
    if (wanted > 0 && s.hunting !== false) this._cordon(g, half, S, wanted, u);

    // ---- route ------------------------------------------------------------
    const route = s.route;
    if (route && route.length >= 4) {
      const p = this._pt;
      g.lineJoin = 'round';
      g.lineCap = 'round';
      for (let pass = 0; pass < 2; pass++) {
        g.strokeStyle = pass === 0 ? 'rgba(4,8,12,.8)' : 'rgba(255,59,138,.92)';
        g.lineWidth = (pass === 0 ? 6.4 : 3.6) * u;
        g.beginPath();
        for (let i = 0; i < route.length; i += 2) {
          proj(route[i], route[i + 1], p);
          if (i === 0) g.moveTo(p[0], p[1]);
          else g.lineTo(p[0], p[1]);
        }
        g.stroke();
      }
    }

    // ---- static POIs (only what fits, only when zoomed in) ---------------
    if (ppm > 0.42) {
      const p = this._pt;
      const r = 5.2 * u;
      for (let i = 0; i < this.pois.length; i++) {
        const poi = this.pois[i];
        const dx = poi.x - v.cx;
        const dz = poi.z - v.cz;
        if (dx * dx + dz * dz > (this.viewSpan * 0.62) ** 2) continue;
        const st = POI_STYLE[poi.kind];
        if (!st || st.p < 2) continue;
        proj(poi.x, poi.z, p);
        drawIcon(g, st.g, p[0], p[1], r, st.c, 0.94);
      }
    }

    // ---- contacts: cops, hostiles, allies, mission markers ---------------
    const blips = s.blips;
    if (blips) {
      const p = this._pt;
      for (let i = 0; i < blips.length; i++) {
        const b = blips[i];
        const st = POI_STYLE[b.kind] ?? POI_STYLE.enemy;
        // A per-contact colour wins over the kind's generic one. This is what
        // makes each brother draw in his own DESIGN.md colour instead of all
        // three sharing the ALLY green — `ui._collectBlips` carries it off
        // `peds.getHudActors()`. Absent (the normal case) falls back to `st.c`.
        const ink = b.colour ?? st.c;
        proj(b.x, b.z, p);
        const objective = b.kind === 'mission' || b.kind === 'waypoint';
        // Only objectives get pinned to the rim. Clamping every contact turns
        // a busy chase into a string of beads round the edge that tells you
        // nothing about where anyone actually is.
        const off = Math.hypot(p[0] - half, p[1] - half) > half * 0.94;
        if (off && !objective) continue;
        if (objective) this._clampToDisc(p, half, half * 0.9);
        if (b.kind === 'cop') {
          // Police flash blue/white on the radar, in step with the lightbar.
          const t = (this.time * 2.6 + i * 0.31) % 1;
          const c = t < 0.5 ? '#3f8dff' : '#a8cfff';
          this._dotBlip(g, p[0], p[1], 3.5 * u, c, b.heading, false);
        } else if (objective) {
          drawIcon(g, st.g, p[0], p[1], 6.6 * u, ink, 1);
        } else {
          this._dotBlip(g, p[0], p[1], 3.8 * u, ink, b.heading, true);
        }
      }
    }

    // ---- waypoint ---------------------------------------------------------
    if (s.waypoint) {
      const p = proj(s.waypoint.x, s.waypoint.z, this._pt);
      const clamped = this._clampToDisc(p, half, half * 0.9);
      const st = POI_STYLE.waypoint;
      if (clamped) {
        // an arrow on the rim pointing at an off-disc waypoint
        const a = Math.atan2(p[1] - half, p[0] - half);
        g.save();
        g.translate(p[0], p[1]);
        g.rotate(a + Math.PI / 2);
        g.fillStyle = st.c;
        g.strokeStyle = 'rgba(3,6,9,.9)';
        g.lineWidth = 1.4 * u;
        g.beginPath();
        g.moveTo(0, -5 * u);
        g.lineTo(4.6 * u, 4 * u);
        g.lineTo(-4.6 * u, 4 * u);
        g.closePath();
        g.fill();
        g.stroke();
        g.restore();
      } else {
        drawIcon(g, st.g, p[0], p[1], 6.8 * u, st.c, 1);
      }
    }

    // ---- the player -------------------------------------------------------
    g.save();
    g.translate(half, half);
    g.rotate(this.headingUp ? 0 : head);
    g.shadowColor = 'rgba(0,0,0,.85)';
    g.shadowBlur = 5 * u;
    drawPlayerArrow(g, 6.4 * u, s.colour ?? '#f2f7fb', !!s.inVehicle);
    g.restore();
    g.shadowBlur = 0;

    // ---- inner shading so the disc sits inside the iron -------------------
    const vg = g.createRadialGradient(half, half, S * 0.30, half, half, S * 0.52);
    vg.addColorStop(0, 'rgba(0,0,0,0)');
    vg.addColorStop(0.82, 'rgba(0,0,0,.22)');
    vg.addColorStop(1, 'rgba(0,0,0,.5)');
    g.fillStyle = vg;
    g.fillRect(0, 0, S, S);
    g.restore();

    // ---- bezel furniture --------------------------------------------------
    setStyle(this.northMark, 'transform', `rotate(${(this.rot * 180) / Math.PI}deg)`);

    const dist = districtAt(v.cx, v.cz);
    if (dist && dist.name !== this._zone) {
      this._zone = dist.name;
      setText(this.zoneEl, dist.name);
    }
    setText(this.streetEl, s.street ?? '');
  }

  /**
   * The wanted cordon: a search radius ring plus a sector sweeping around it.
   * Cheap, and it says "they are looking for you HERE" without a legend.
   */
  /**
   * The wanted cordon: the radius they are searching, plus a beam sweeping it.
   * The beam is a hard leading edge with a decaying tail behind it — a
   * symmetric sector reads as a smudge, a radar sweep reads as a search.
   */
  _cordon(g, half, S, wanted, u) {
    const r = half * (0.44 + 0.105 * wanted);
    const a0 = this.time * (0.85 + wanted * 0.14);
    const tail = Math.PI * (0.5 + wanted * 0.07);

    g.save();
    g.beginPath();
    g.arc(half, half, r, 0, Math.PI * 2);
    g.clip();
    const grd = g.createConicGradient
      ? g.createConicGradient(a0 - tail, half, half)
      : null;
    if (grd) {
      grd.addColorStop(0, 'rgba(255,106,18,0)');
      grd.addColorStop(tail / (Math.PI * 2) * 0.55, `rgba(255,110,20,${0.018 + 0.006 * wanted})`);
      grd.addColorStop(tail / (Math.PI * 2), `rgba(255,150,40,${0.075 + 0.016 * wanted})`);
      grd.addColorStop(Math.min(0.999, tail / (Math.PI * 2) + 0.004), 'rgba(255,106,18,0)');
      grd.addColorStop(1, 'rgba(255,106,18,0)');
      g.fillStyle = grd;
      g.fillRect(half - r, half - r, r * 2, r * 2);
    }
    // hard leading edge
    g.strokeStyle = `rgba(255,214,140,${(0.3 + 0.08 * wanted).toFixed(2)})`;
    g.lineWidth = 1.3 * u;
    g.beginPath();
    g.moveTo(half, half);
    g.lineTo(half + Math.cos(a0) * r, half + Math.sin(a0) * r);
    g.stroke();
    g.restore();

    g.strokeStyle = `rgba(255,148,46,${(0.24 + 0.09 * wanted).toFixed(2)})`;
    g.lineWidth = 1.3 * u;
    g.setLineDash([4.5 * u, 5.5 * u]);
    g.beginPath();
    g.arc(half, half, r, 0, Math.PI * 2);
    g.stroke();
    g.setLineDash([]);
  }

  _dotBlip(g, x, y, r, colour, heading, pointed) {
    g.save();
    g.translate(x, y);
    if (pointed && heading !== undefined) {
      g.rotate(((heading ?? 0) * Math.PI) / 180 + this.rot);
      g.beginPath();
      g.moveTo(0, -r * 1.5);
      g.lineTo(r * 1.05, r * 1.0);
      g.lineTo(-r * 1.05, r * 1.0);
      g.closePath();
    } else {
      g.beginPath();
      g.arc(0, 0, r, 0, Math.PI * 2);
    }
    g.strokeStyle = 'rgba(3,6,9,.9)';
    g.lineWidth = Math.max(1, r * 0.42);
    g.stroke();
    g.fillStyle = colour;
    g.fill();
    g.restore();
  }

  /** Clamp a screen point into the disc. Returns true if it was outside. */
  _clampToDisc(p, half, radius) {
    const dx = p[0] - half;
    const dy = p[1] - half;
    const d = Math.hypot(dx, dy);
    if (d <= radius) return false;
    p[0] = half + (dx / d) * radius;
    p[1] = half + (dy / d) * radius;
    return true;
  }

  dispose() {
    this.root.remove();
  }
}
