import * as THREE from 'three';
import {
  Accum, box, chamferBox, cyl, card, lathe, extrude, ngon, tube,
  combine, weather, paint, dent, newTrs, clamp01, lerp, TAU, hash3i, smoothNoise,
} from './geom.js';

/**
 * PROPS — signage and commerce.
 *
 * This is a night-time city: neon and sodium are the whole look (DESIGN.md,
 * "Art direction"). Every lit element here is an EMISSIVE material driven off
 * the sun altitude, never a punctual light — a downtown block carries fifty of
 * them and `q.lightSlots` is eight.
 *
 * The families:
 *   fascia      the horizontal signboard over a shopfront, with lit lettering
 *   blade       a sign projecting at right angles into the street
 *   neon        bent-tube word shapes, six of them, in the district's colour
 *   awning      sloped canvas with a valance, on a real frame
 *   menu/A-board the pavement clutter of a trading street
 *   poster      flyposting: overlapping, torn, on hoardings and shutters
 *   graffiti    aerosol strokes, raised a few millimetres off the wall
 *   ghost sign  the half-century-old painted advert on a brick gable
 */

function P(K, id, factory, surface, opts) {
  K.proto(id, factory, surface, opts);
  return id;
}

/** A stroke of spray paint: a flattened tube following a polyline. */
function stroke(pts, r = 0.05) {
  const g = tube(pts, r, 5);
  g.scale(1, 1, 0.3);
  return g;
}

/* ====================================================================== */
/* FASCIA + BLADE SIGNS                                                   */
/* ====================================================================== */

export function registerFascia(K) {
  /**
   * The signboard over a shopfront. Built at unit width (1 m) about the origin
   * so the layout can scale it to the shop's actual frontage — the only prop in
   * the kit that is deliberately scaled non-uniformly, because a fascia has to
   * fit its shop.
   */
  /**
   * NON-UNIFORM SCALE IS A TRAP. The board is stretched to the shop's actual
   * frontage, which is fine for boxes and fatal for anything with a round
   * cross-section: a 22 mm gooseneck tube stretched five times reads as a flat
   * ribbon. So the board carries only box geometry, and the two lamps over it
   * are their own prototype, placed at uniform scale.
   */
  P(K, 'fascia_board', () => {
    const parts = [];
    parts.push([chamferBox(1.0, 0.62, 0.14, 0.012), newTrs(0, 0, 0.07)]);
    parts.push([box(1.04, 0.05, 0.20), newTrs(0, 0.63, 0.07)]);
    parts.push([box(1.04, 0.04, 0.18), newTrs(0, -0.02, 0.07)]);
    const g = combine(parts, 'fascia');
    weather(g, { grimeBase: 0.7, grimeHeight: 3.0, wear: 0.6, seed: 601, up: 0.6 });
    return g;
  }, 'pole_dark');

  P(K, 'fascia_lamp', () => {
    const parts = [];
    parts.push([tube([
      { x: 0, y: 0.66, z: 0.06 },
      { x: 0, y: 0.86, z: 0.10 },
      { x: 0, y: 0.90, z: 0.26 },
      { x: 0, y: 0.82, z: 0.34 },
    ], 0.018, 5), null]);
    parts.push([lathe([[0.0, 0], [0.075, 0.01], [0.085, 0.05], [0.02, 0.075]], 8),
      newTrs(0, 0.80, 0.34, 0, 1, 1, 1, Math.PI)]);
    const g = combine(parts, 'fascialamp');
    weather(g, { grimeBase: 0.7, grimeHeight: 3.0, wear: 0.6, seed: 602, up: 0.6 });
    return g;
  }, 'pole_dark');

  /**
   * The face of the fascia — PAINTED sheet in four colourways, not a light.
   * Only the channel letters on top of it glow.
   */
  /**
   * The face is stretched to the shop's frontage, so every feature on it has to
   * survive an X scale of five. Boxes that run the FULL width do (a reveal rail
   * stays a reveal rail); anything with a fixed X extent does not, which is why
   * the border is two rails and not a picture frame. The old face was one flat
   * quad and read as a blank cream rectangle in every street capture.
   */
  for (const key of ['panel_cream', 'panel_navy', 'panel_maroon', 'panel_forest']) {
    P(K, `fascia_face_${key}`, () => {
      const parts = [];
      const g = new THREE.BoxGeometry(0.94, 0.48, 0.02);
      g.translate(0, 0.07, 0.152);
      parts.push([g, null]);
      // top and bottom reveal rails, proud of the field
      parts.push([box(0.97, 0.035, 0.045), newTrs(0, 0.285, 0.150)]);
      parts.push([box(0.97, 0.030, 0.045), newTrs(0, -0.185, 0.150)]);
      const out = combine(parts, 'fasciaface');
      paint(out, (x, y, z, nx, ny) => {
        const e = Math.max(Math.abs(x) / 0.47, Math.abs(y - 0.07) / 0.24);
        // sun-bleached toward the top, grime pooling along the bottom rail
        return [
          0.25 + 0.7 * Math.max(0, e - 0.66) / 0.34 + 0.25 * clamp01((y - 0.07) / 0.3),
          0.4 + (ny > 0.4 ? 0.5 : 0) + 0.45 * clamp01((-0.05 - y) / 0.2),
          0.1,
        ];
      });
      return out;
    }, key, { castShadow: false });
  }

  /**
   * SHOPFRONT LETTERING. Exposed neon script over the board — a word, in real
   * letterforms, sized to the board rather than to a fixed 70 cm. The first pass
   * put eight fat blocks on at a scale capped near 1.0, which on a five-metre
   * fascia was a small coloured smudge in the middle of a blank panel.
   */
  for (const key of ['neon_amber', 'neon_teal', 'neon_red', 'neon_white', 'neon_violet']) {
    P(K, `fascia_letters_${key}`, () => {
      const parts = [];
      const n = 5 + (key.length % 3);
      neonWord(parts, n, 701 + key.length, 0.245, 0.019, 0, 0.06, 0.175);
      return combine(parts, 'letters');
    }, key, { castShadow: false, noShadow: true });
  }

  /* ---- projecting blade signs ---------------------------------------- */
  P(K, 'blade_bracket', () => {
    const parts = [];
    parts.push([box(0.06, 0.62, 0.06), newTrs(0, 0, 0.04)]);
    parts.push([tube([
      { x: 0, y: 0.52, z: 0.06 },
      { x: 0, y: 0.55, z: 0.42 },
      { x: 0, y: 0.52, z: 0.78 },
    ], 0.025, 5), null]);
    parts.push([tube([
      { x: 0, y: 0.04, z: 0.08 },
      { x: 0, y: 0.34, z: 0.52 },
    ], 0.018, 4), null]);
    // scroll finial, because a bracket that is a plain L reads as a bracket
    for (let i = 0; i < 5; i++) {
      const t = i / 5;
      const a = t * Math.PI * 1.6;
      parts.push([cyl(0.012, 0.012, 0.06, 4),
        newTrs(0, 0.55 + Math.sin(a) * 0.09 * (1 - t), 0.80 + Math.cos(a) * 0.09 * (1 - t), 0, 1, 1, 1, Math.PI / 2)]);
    }
    const g = combine(parts, 'bladebracket');
    weather(g, { grimeBase: 0.72, grimeHeight: 4.0, wear: 0.75, seed: 607 });
    return g;
  }, 'pole_dark');

  P(K, 'blade_panel', () => {
    const parts = [];
    parts.push([box(0.055, 0.78, 0.86), newTrs(0, -0.12, 0.42)]);
    parts.push([box(0.08, 0.05, 0.92), newTrs(0, 0.29, 0.42)]);
    parts.push([box(0.08, 0.05, 0.92), newTrs(0, -0.53, 0.42)]);
    const g = combine(parts, 'bladepanel');
    weather(g, { grimeBase: 0.65, grimeHeight: 4.0, wear: 0.8, seed: 613, up: 0.6 });
    return g;
  }, 'pole_dark');

  /**
   * The lit part of a blade sign is the LETTERING, not the board. A solid
   * emissive card the size of the panel is a blank coloured rectangle by day and
   * a blown slab by night — a critic logged exactly that, twice. So: a neon
   * border and a short word, on both faces, over the dark panel.
   */
  for (const key of ['neon_amber', 'neon_teal', 'neon_red', 'neon_white', 'neon_violet']) {
    P(K, `blade_face_${key}`, () => {
      const parts = [];
      const R = 0.019;
      const mk = (pts, x) => parts.push([
        tube(pts.map(([u, v]) => ({ x, y: -0.12 + v, z: 0.42 + u })), R, 4), null,
      ]);
      for (const x of [-0.036, 0.036]) {
        mk([[-0.34, -0.30], [0.34, -0.30], [0.34, 0.30], [-0.34, 0.30], [-0.34, -0.30]], x);
        for (let i = 0; i < 3; i++) {
          const k = Math.floor(hash3i(2311, i, key.length) * 8);
          for (const st of glyphStrokes(k)) {
            mk(st.map(([gx, gy]) => [-0.21 + i * 0.21 + gx * 0.92, gy * 0.86]), x);
          }
        }
      }
      return combine(parts, 'bladeface');
    }, key, { castShadow: false, noShadow: true });
  }

  /** A vertical projecting sign — the big one, three storeys of hotel neon. */
  P(K, 'blade_tall_frame', () => {
    const parts = [];
    parts.push([box(0.10, 3.6, 0.10), newTrs(-0.0, -3.6, 0.10)]);
    parts.push([box(0.10, 3.6, 0.10), newTrs(-0.0, -3.6, 1.05)]);
    for (let i = 0; i <= 6; i++) {
      parts.push([box(0.08, 0.06, 1.0), newTrs(0, -3.6 + i * 0.6, 0.575)]);
    }
    parts.push([box(0.14, 0.10, 1.16), newTrs(0, 0.0, 0.575)]);
    parts.push([tube([{ x: 0, y: -0.1, z: 0.05 }, { x: 0, y: -0.9, z: -0.55 }], 0.022, 4), null]);
    const g = combine(parts, 'bladetall');
    weather(g, { grimeBase: 0.7, grimeHeight: 6.0, wear: 0.8, seed: 617 });
    return g;
  }, 'rust');
}

/* ====================================================================== */
/* NEON — bent-tube letterforms and word shapes                           */
/* ====================================================================== */

/**
 * A NEON LETTERFORM, drawn in a cell 0.23 m wide by 0.37 m tall about its own
 * origin. Eight of them: not a real alphabet — a procedural city has no font —
 * but each has the stroke count and, crucially, the ASYMMETRY of a letter.
 *
 * That last word is the whole defect this replaces. The old vertical-sign shape
 * was a horizontal bar with a stem through its middle, which is a PLUS SIGN,
 * and the layout stacked five of them down a wall. Every daylight capture came
 * back with a column of five flat violet crosses on the building to the
 * camera's left, and three separate critics called it an unfinished placeholder.
 * Nothing in this kit may be left/right AND up/down symmetric.
 */
function glyphStrokes(k) {
  const w = 0.105;
  const h = 0.175;
  switch (((k % 8) + 8) % 8) {
    case 0: // H
      return [[[-w, -h], [-w, h]], [[w, -h], [w, h]], [[-w, 0.01], [w, 0.01]]];
    case 1: { // O
      const r = [];
      for (let i = 0; i <= 14; i++) {
        const a = (i / 14) * TAU;
        r.push([Math.cos(a) * w, Math.sin(a) * h]);
      }
      return [r];
    }
    case 2: // T
      return [[[-w, h], [w, h]], [[0, h], [0, -h]]];
    case 3: // E
      return [
        [[-w, -h], [-w, h]], [[-w, h], [w * 0.85, h]],
        [[-w, 0.0], [w * 0.5, 0.0]], [[-w, -h], [w * 0.85, -h]],
      ];
    case 4: // L
      return [[[-w, h], [-w, -h]], [[-w, -h], [w * 0.9, -h]]];
    case 5: // A
      return [
        [[-w, -h], [0, h]], [[0, h], [w, -h]],
        [[-w * 0.55, -h * 0.15], [w * 0.55, -h * 0.15]],
      ];
    case 6: // R
      return [
        [[-w, -h], [-w, h]],
        [[-w, h], [w * 0.6, h * 0.72], [w * 0.62, h * 0.16], [-w, 0.0]],
        [[-w * 0.2, 0.0], [w, -h]],
      ];
    default: { // S
      const s = [];
      const pts = [
        [w, h * 0.72], [w * 0.2, h], [-w, h * 0.55], [w * 0.55, -h * 0.2],
        [w, -h * 0.62], [w * 0.1, -h], [-w * 0.95, -h * 0.6],
      ];
      for (const p of pts) s.push(p);
      return [s];
    }
  }
}

/** Lay `n` glyphs along +X, centred, at `pitch` metres. */
function neonWord(parts, n, seed, pitch = 0.255, R = 0.020, x0 = 0, y0 = 0, z0 = 0) {
  const span = (n - 1) * pitch;
  for (let i = 0; i < n; i++) {
    const k = Math.floor(hash3i(seed, i, 7) * 8);
    const cx = x0 - span * 0.5 + i * pitch;
    for (const st of glyphStrokes(k)) {
      // 4 radial segments, not 5: a 19 mm tube seen from the street is a
      // stroke, and this geometry is multiplied by every shop unit in the city.
      parts.push([tube(st.map(([x, y]) => ({ x: cx + x, y: y0 + y, z: z0 })), R, 4), null]);
    }
  }
  return parts;
}

function neonShape(kind) {
  const parts = [];
  const R = 0.022;
  if (kind === 0) {
    // a cursive squiggle: three joined arcs
    const pts = [];
    for (let i = 0; i <= 24; i++) {
      const t = i / 24;
      pts.push({ x: -0.62 + t * 1.24, y: Math.sin(t * Math.PI * 3.1) * 0.20, z: 0 });
    }
    parts.push([tube(pts, R, 5), null]);
    parts.push([tube([{ x: -0.68, y: -0.34, z: 0 }, { x: 0.68, y: -0.34, z: 0 }], R * 0.8, 5), null]);
  } else if (kind === 1) {
    // ring + crossbar
    const ring = [];
    for (let i = 0; i <= 20; i++) {
      const a = (i / 20) * TAU;
      ring.push({ x: Math.cos(a) * 0.36, y: Math.sin(a) * 0.36, z: 0 });
    }
    parts.push([tube(ring, R, 5), null]);
    parts.push([tube([{ x: -0.5, y: 0, z: 0 }, { x: 0.5, y: 0, z: 0 }], R, 5), null]);
  } else if (kind === 2) {
    // a five-letter word on a rule
    neonWord(parts, 5, 1571, 0.255, R, 0, 0.09, 0);
    parts.push([tube([{ x: -0.66, y: -0.24, z: 0 }, { x: 0.66, y: -0.24, z: 0 }], R * 0.7, 5), null]);
  } else if (kind === 3) {
    // arrow
    parts.push([tube([{ x: -0.6, y: 0, z: 0 }, { x: 0.45, y: 0, z: 0 }], R, 5), null]);
    parts.push([tube([{ x: 0.18, y: 0.30, z: 0 }, { x: 0.52, y: 0, z: 0 }, { x: 0.18, y: -0.30, z: 0 }], R, 5), null]);
  } else if (kind === 4) {
    // martini / diner glass
    parts.push([tube([{ x: -0.32, y: 0.32, z: 0 }, { x: 0, y: -0.06, z: 0 }, { x: 0.32, y: 0.32, z: 0 }], R, 5), null]);
    parts.push([tube([{ x: -0.34, y: 0.32, z: 0 }, { x: 0.34, y: 0.32, z: 0 }], R, 5), null]);
    parts.push([tube([{ x: 0, y: -0.06, z: 0 }, { x: 0, y: -0.42, z: 0 }], R, 5), null]);
    parts.push([tube([{ x: -0.22, y: -0.44, z: 0 }, { x: 0.22, y: -0.44, z: 0 }], R, 5), null]);
  } else {
    // an outline rectangle with a diagonal — the "OPEN" box
    const w = 0.62;
    const h = 0.28;
    parts.push([tube([
      { x: -w, y: -h, z: 0 }, { x: w, y: -h, z: 0 }, { x: w, y: h, z: 0 },
      { x: -w, y: h, z: 0 }, { x: -w, y: -h, z: 0 },
    ], R, 5), null]);
    for (let i = 0; i < 4; i++) {
      parts.push([tube([
        { x: -0.46 + i * 0.31, y: -0.14, z: 0 },
        { x: -0.46 + i * 0.31, y: 0.14, z: 0 },
      ], R * 0.85, 5), null]);
    }
  }
  return combine(parts, 'neon');
}

export function registerNeon(K) {
  const keys = ['neon_amber', 'neon_teal', 'neon_red', 'neon_white', 'neon_violet'];
  for (let k = 0; k < 6; k++) {
    for (const key of keys) {
      P(K, `neon_${k}_${key}`, () => neonShape(k), key, { castShadow: false, noShadow: true });
    }
  }
  /**
   * THE VERTICAL SIGN — the three-storey hotel/theatre blade.
   *
   * ONE prototype for the whole sign, not five copies of a small one stacked at
   * a pitch shorter than their own height (which is what produced the column of
   * overlapping crosses). Letters read DOWN the blade, tubes duplicated on both
   * faces because a projecting sign is lit from either side of the street, and
   * a chase of lamp bulbs down each margin.
   *
   * Authored to fill `blade_tall_frame`: x within +/-0.30, y within +/-1.55, so
   * it is placed unscaled at the frame's mid-height.
   */
  for (const key of keys) {
    P(K, `neon_vert_${key}`, () => {
      const parts = [];
      const R = 0.026;
      for (const face of [-0.055, 0.055]) {
        for (let i = 0; i < 6; i++) {
          const y = 1.19 - i * 0.475;
          const k = Math.floor(hash3i(1913, i, key.length) * 8);
          for (const st of glyphStrokes(k)) {
            parts.push([tube(st.map(([x, yy]) => ({ x: x * 1.35, y: y + yy * 1.28, z: face })), R, 4), null]);
          }
        }
        // margin chase: the running bulbs down both edges
        for (let i = 0; i < 9; i++) {
          const y = -1.5 + i * 0.37;
          for (const s of [-1, 1]) {
            parts.push([lathe([[0, 0], [0.030, 0.012], [0.030, 0.030], [0, 0.042]], 6),
              newTrs(s * 0.255, y, face)]);
          }
        }
        // the rule under the word
        parts.push([tube([{ x: -0.20, y: -1.62, z: face }, { x: 0.20, y: -1.62, z: face }], R * 0.7, 5), null]);
      }
      return combine(parts, 'neonvert');
    }, key, { castShadow: false, noShadow: true });
  }

  /** The dark backing board every neon is actually mounted on. */
  P(K, 'neon_backer', () => {
    const g = chamferBox(1.5, 0.95, 0.09, 0.01);
    g.translate(0, -0.475, -0.05);
    weather(g, { grimeBase: 0.75, grimeHeight: 4.0, wear: 0.6, seed: 631, up: 0.6 });
    return g;
  }, 'pole_dark');
}

/* ====================================================================== */
/* AWNINGS, BOARDS, SHUTTERS                                              */
/* ====================================================================== */

export function registerCommerce(K) {
  /** Sloped canvas awning, unit width, with a real tube frame and a valance. */
  P(K, 'awning_frame', () => {
    // Only what survives being stretched across a shopfront: the wall plate and
    // the front bar. The rakers are `awning_rib`, placed unscaled at each end.
    const parts = [];
    parts.push([box(1.04, 0.045, 0.045), newTrs(0, -0.42, 1.10)]);
    parts.push([box(1.06, 0.05, 0.06), newTrs(0, 0.0, 0.02)]);
    const g = combine(parts, 'awnframe');
    weather(g, { grimeBase: 0.7, grimeHeight: 4.0, wear: 0.7, seed: 641 });
    return g;
  }, 'pole_dark');

  P(K, 'awning_rib', () => {
    const parts = [];
    parts.push([tube([
      { x: 0, y: 0.0, z: 0.02 },
      { x: 0, y: -0.26, z: 0.60 },
      { x: 0, y: -0.42, z: 1.10 },
    ], 0.022, 5), null]);
    parts.push([tube([{ x: 0, y: 0.0, z: 0.02 }, { x: 0, y: -0.42, z: 1.06 }], 0.016, 4), null]);
    const g = combine(parts, 'awnrib');
    weather(g, { grimeBase: 0.7, grimeHeight: 4.0, wear: 0.7, seed: 642 });
    return g;
  }, 'pole_dark');

  for (const key of ['awning_red', 'awning_green', 'awning_cream']) {
    P(K, `awning_canvas_${key}`, () => {
      // A sagging sheet: 5x3 grid drooping between the ribs, plus the valance.
      const a = new Accum('awncanvas');
      const g = new THREE.PlaneGeometry(1.02, 1.16, 6, 4);
      const pos = g.getAttribute('position');
      for (let i = 0; i < pos.count; i++) {
        const x = pos.getX(i);
        const y = pos.getY(i);
        const v = y / 1.16 + 0.5;
        const ripple = Math.sin(x * 11.0) * 0.012 * v;
        pos.setZ(i, pos.getZ(i) + ripple);
      }
      g.computeVertexNormals();
      // lay it on the slope
      const m = new THREE.Matrix4();
      m.makeRotationX(-Math.PI / 2 + 0.37);
      m.setPosition(0, -0.21, 0.56);
      a.add(g, m, null, [0.45, 0.4, 0.1]);
      g.dispose();
      // valance: a scalloped hanging edge
      const val = new THREE.PlaneGeometry(1.04, 0.26, 8, 1);
      const vp = val.getAttribute('position');
      for (let i = 0; i < vp.count; i++) {
        if (vp.getY(i) < 0) vp.setY(i, vp.getY(i) + Math.abs(Math.sin(vp.getX(i) * 12)) * 0.06);
        vp.setZ(i, vp.getZ(i) + Math.sin(vp.getX(i) * 9) * 0.014);
      }
      val.computeVertexNormals();
      const m2 = new THREE.Matrix4();
      m2.makeTranslation(0, -0.55, 1.10);
      a.add(val, m2, null, [0.6, 0.55, 0.15]);
      val.dispose();
      return a.build();
    }, key, { castShadow: true });
  }

  /** A rolled security shutter over a closed shopfront. */
  P(K, 'shutter_unit', () => {
    const parts = [];
    const g = new THREE.PlaneGeometry(1.0, 1.0, 1, 14);
    const pos = g.getAttribute('position');
    for (let i = 0; i < pos.count; i++) {
      pos.setZ(i, pos.getZ(i) + Math.sin(pos.getY(i) * 44) * 0.012);
    }
    g.computeVertexNormals();
    g.translate(0, 0.5, 0);
    parts.push([g, null]);
    parts.push([box(1.06, 0.16, 0.16), newTrs(0, 1.0, 0.02)]);
    parts.push([box(0.06, 1.02, 0.10), newTrs(-0.52, 0, 0)]);
    parts.push([box(0.06, 1.02, 0.10), newTrs(0.52, 0, 0)]);
    parts.push([box(1.0, 0.07, 0.06), newTrs(0, 0.0, 0)]);
    const out = combine(parts, 'shutter');
    weather(out, { grimeBase: 0.8, grimeHeight: 2.2, wear: 0.7, seed: 653, up: 0.4 });
    return out;
  }, 'corrugated');

  /** A wall-mounted, internally lit menu case. */
  P(K, 'menu_case', () => {
    const parts = [];
    parts.push([chamferBox(0.62, 0.86, 0.09, 0.01), newTrs(0, 0, 0.045)]);
    parts.push([box(0.68, 0.05, 0.12), newTrs(0, 0.88, 0.045)]);
    const g = combine(parts, 'menucase');
    weather(g, { grimeBase: 0.72, grimeHeight: 2.4, wear: 0.6, seed: 659, up: 0.5 });
    return g;
  }, 'pole_grey');
  P(K, 'menu_lit', () => {
    const g = card(0.52, 0.74);
    g.translate(0, 0.06, 0.095);
    return g;
  }, 'shop_lit', { castShadow: false, noShadow: true });

  /** A-board on the pavement. Leans, and never squarely to the kerb. */
  P(K, 'a_board', () => {
    const parts = [];
    for (const s of [-1, 1]) {
      const p = box(0.66, 0.92, 0.035);
      const m = newTrs(0, 0.06, s * 0.16, 0, 1, 1, 1, s * 0.20);
      parts.push([p, m]);
      parts.push([box(0.70, 0.05, 0.05), newTrs(0, 1.0, s * 0.26)]);
      parts.push([box(0.05, 0.98, 0.05), newTrs(-0.34, 0.05, s * 0.17, 0, 1, 1, 1, s * 0.20)]);
      parts.push([box(0.05, 0.98, 0.05), newTrs(0.34, 0.05, s * 0.17, 0, 1, 1, 1, s * 0.20)]);
    }
    parts.push([box(0.60, 0.03, 0.03), newTrs(0, 0.34, 0)]);
    const g = combine(parts, 'aboard');
    weather(g, { grimeBase: 0.72, grimeHeight: 0.9, wear: 0.85, seed: 661, up: 0.6 });
    return g;
  }, 'chalkboard');

  /** A roadside hoarding on two legs — the billboard family. */
  P(K, 'billboard_frame', () => {
    const parts = [];
    for (const s of [-1, 1]) {
      parts.push([cyl(0.10, 0.13, 3.6, 8), newTrs(s * 1.7, 0, 0)]);
      parts.push([tube([{ x: s * 1.7, y: 1.2, z: 0 }, { x: s * 1.7, y: 2.6, z: 0.55 }], 0.05, 5), null]);
    }
    parts.push([box(5.4, 0.14, 0.14), newTrs(0, 3.5, 0)]);
    parts.push([box(5.4, 0.14, 0.14), newTrs(0, 5.6, 0)]);
    for (let i = 0; i < 5; i++) parts.push([box(0.10, 2.2, 0.10), newTrs(-2.2 + i * 1.1, 3.5, 0)]);
    parts.push([box(5.6, 0.10, 0.28), newTrs(0, 5.78, 0.20)]);
    const g = combine(parts, 'billboard');
    weather(g, { grimeBase: 0.75, grimeHeight: 3.5, wear: 0.8, seed: 673 });
    return g;
  }, 'rust');
  /**
   * A BILLBOARD IS A POSTER, NOT A COLOURED RECTANGLE. The paper ground is one
   * card; the artwork on top of it is a second surface, so the panel has a
   * composition — a block of image, a headline rule, a strapline — instead of
   * being 11 square metres of flat orange. Both are paper surfaces the kit
   * already carries, so this costs no new material.
   */
  P(K, 'billboard_face', () => {
    const a = new Accum('bbface');
    const m = new THREE.Matrix4();
    const g = new THREE.PlaneGeometry(5.3, 2.15, 6, 3);
    const pos = g.getAttribute('position');
    for (let i = 0; i < pos.count; i++) {
      // paper never lies flat on a hoarding: it bubbles between the boards
      pos.setZ(i, pos.getZ(i) + Math.sin(pos.getX(i) * 2.3) * 0.012
        + Math.sin(pos.getY(i) * 5.1) * 0.008);
    }
    g.computeVertexNormals();
    m.makeTranslation(0, 3.55 + 1.075, 0.10);
    a.add(g, m, null, [0.7, 0.55, 0.15]);
    g.dispose();
    return a.build();
  }, 'poster_d', { castShadow: false });

  P(K, 'billboard_art', () => {
    const a = new Accum('bbart');
    const m = new THREE.Matrix4();
    const put = (x, y, w, h, mask) => {
      const g = new THREE.PlaneGeometry(w, h);
      m.setPosition(x, 3.55 + y, 0.115);
      a.add(g, m, null, mask);
      g.dispose();
    };
    // the image block, off to one side, and the type stacked beside it
    put(-1.62, 1.06, 1.86, 1.62, [0.35, 0.6, 0.2]);
    put(0.92, 1.62, 2.94, 0.40, [0.55, 0.5, 0.15]);
    let x = -0.50;
    for (let i = 0; i < 6 && x < 2.3; i++) {
      const h0 = hash3i(677, i, 3);
      const w = 0.24 + h0 * 0.52;
      put(x + w * 0.5, 1.02, w, 0.19, [0.5 + 0.4 * h0, 0.55, 0.15]);
      x += w + 0.12;
    }
    put(1.30, 0.44, 2.1, 0.13, [0.6, 0.6, 0.15]);
    return a.build();
  }, 'poster_a', { castShadow: false });

  /**
   * The floodlights wash the poster after dark; they do not turn it into a lamp.
   * Two narrow bands under the lighting bar, not the whole panel.
   */
  P(K, 'billboard_lit', () => {
    const a = new Accum('bblit');
    const m = new THREE.Matrix4();
    for (let i = 0; i < 4; i++) {
      const g = new THREE.PlaneGeometry(1.18, 1.55);
      m.setPosition(-1.98 + i * 1.32, 3.55 + 1.28, 0.125);
      a.add(g, m);
      g.dispose();
    }
    return a.build();
  }, 'shop_lit', { castShadow: false, noShadow: true, noPrepass: true });

  /** A lamp-column banner, two per column. */
  P(K, 'banner_pair', () => {
    const parts = [];
    for (const s of [-1, 1]) {
      const g = new THREE.PlaneGeometry(0.44, 1.30, 3, 3);
      const pos = g.getAttribute('position');
      for (let i = 0; i < pos.count; i++) {
        pos.setZ(i, pos.getZ(i) + Math.sin(pos.getY(i) * 4 + s) * 0.03);
      }
      g.computeVertexNormals();
      g.translate(s * 0.32, -0.72, 0);
      parts.push([g, null, [0.5, 0.5, 0.2]]);
    }
    parts.push([cyl(0.014, 0.014, 0.9, 5), newTrs(0, -0.06, 0, 0, 1, 1, 1, 0, Math.PI / 2)]);
    parts.push([cyl(0.014, 0.014, 0.9, 5), newTrs(0, -1.4, 0, 0, 1, 1, 1, 0, Math.PI / 2)]);
    return combine(parts, 'banner');
  }, 'poster_b', { castShadow: false });

  /**
   * A lit shop window after dark.
   *
   * NOT one plane. A single emissive rectangle the width of a shopfront is a
   * white slab with no shape in it, which is exactly how the first night
   * capture read. Real light comes through GLAZING: three panes with mullions
   * between them, a dark transom band at the top, and the bottom third eaten by
   * the stallriser. The gaps are what give the light a silhouette.
   */
  P(K, 'shop_glow', () => {
    const a = new Accum('shopglow');
    const m = new THREE.Matrix4();
    for (let i = 0; i < 3; i++) {
      const g = new THREE.PlaneGeometry(0.28, 0.60);
      m.makeTranslation(-0.32 + i * 0.32, 0.12, 0);
      a.add(g, m);
      g.dispose();
      // a transom light over each pane
      const t = new THREE.PlaneGeometry(0.28, 0.10);
      m.makeTranslation(-0.32 + i * 0.32, 0.50, 0);
      a.add(t, m);
      t.dispose();
    }
    return a.build();
  }, 'window_glow', { castShadow: false, noShadow: true, noPrepass: true });
}

/* ====================================================================== */
/* PAINT: posters, tags, ghost signs                                      */
/* ====================================================================== */

export function registerPaint(K) {
  /** A flyposting cluster: six overlapping sheets, torn and skewed. */
  for (const key of ['poster_a', 'poster_b', 'poster_c', 'poster_d']) {
    P(K, `poster_cluster_${key}`, () => {
      const a = new Accum('posters');
      for (let i = 0; i < 6; i++) {
        const h0 = hash3i(801, i, key.length);
        const h1 = hash3i(802, i, key.length);
        const h2 = hash3i(803, i, key.length);
        const w = 0.42 + h0 * 0.26;
        const h = 0.58 + h1 * 0.36;
        const g = new THREE.PlaneGeometry(w, h, 2, 2);
        const pos = g.getAttribute('position');
        for (let k = 0; k < pos.count; k++) {
          // a torn corner and a lifted edge
          pos.setZ(k, pos.getZ(k) + (Math.abs(pos.getX(k)) / w) * h2 * 0.03);
        }
        g.computeVertexNormals();
        const m = new THREE.Matrix4();
        m.makeRotationZ((h2 - 0.5) * 0.22);
        m.setPosition(-0.7 + h0 * 1.4, 0.4 + h1 * 0.9, 0.004 + i * 0.0022);
        a.add(g, m, null, [0.5 + 0.5 * h1, 0.35 + 0.6 * h0, 0.15]);
        g.dispose();
      }
      return a.build();
    }, key, { castShadow: false });
  }

  /** Aerosol tags — four alphabets' worth of stroke, four colourways. */
  for (let v = 0; v < 4; v++) {
    for (const key of ['tag_a', 'tag_b', 'tag_c', 'tag_d']) {
      P(K, `tag_${v}_${key}`, () => {
        const parts = [];
        const seed = 900 + v * 13 + key.length;
        const n = 4 + (v % 3);
        for (let i = 0; i < n; i++) {
          const h0 = hash3i(seed, i, 1);
          const h1 = hash3i(seed, i, 2);
          const h2 = hash3i(seed, i, 3);
          const x0 = -0.85 + (i / n) * 1.7;
          const pts = [
            { x: x0, y: -0.34 + h0 * 0.16, z: 0 },
            { x: x0 + 0.10 + h1 * 0.16, y: 0.10 + h1 * 0.30, z: 0 },
            { x: x0 + 0.34 * h2 - 0.05, y: 0.40 + h2 * 0.22, z: 0 },
          ];
          parts.push([stroke(pts, 0.036 + h0 * 0.024), null]);
          if (h1 > 0.5) {
            parts.push([stroke([
              { x: x0 - 0.08, y: 0.02, z: 0 },
              { x: x0 + 0.30, y: -0.06 + h2 * 0.2, z: 0 },
            ], 0.03), null]);
          }
        }
        // the underline flourish every tag has
        parts.push([stroke([
          { x: -0.95, y: -0.46, z: 0 }, { x: -0.1, y: -0.56, z: 0 },
          { x: 0.6, y: -0.42, z: 0 }, { x: 1.0, y: -0.52, z: 0 },
        ], 0.032), null]);
        const g = combine(parts, 'tag');
        weather(g, { grimeBase: 0.4, grimeHeight: 2.0, wear: 0.9, seed: 907 + v });
        return g;
      }, key, { castShadow: false, noShadow: true });
    }
  }

  /** Small stickers, for poles, cabinets and the back of every sign. */
  P(K, 'sticker_cluster', () => {
    const a = new Accum('stickers');
    for (let i = 0; i < 7; i++) {
      const h0 = hash3i(951, i, 1);
      const h1 = hash3i(951, i, 2);
      const g = new THREE.PlaneGeometry(0.07 + h0 * 0.07, 0.05 + h1 * 0.06);
      const m = new THREE.Matrix4();
      m.makeRotationZ((h1 - 0.5) * 0.9);
      m.setPosition((h0 - 0.5) * 0.11, 1.0 + h1 * 0.55, 0.055 + i * 0.0004);
      a.add(g, m, null, [0.8, 0.4, 0.1]);
      g.dispose();
    }
    return a.build();
  }, 'poster_c', { castShadow: false, noShadow: true });

  /**
   * A GHOST SIGN. Unit-square so the layout can stretch it across whatever
   * gable it found; the interior "lettering" is a second, brighter set of
   * blocks so it reads as a sign rather than as a stain.
   */
  P(K, 'ghost_field', () => {
    // 8x8 so the wear mask can eat the field back RAGGEDLY. A 3x3 quad faded
    // linearly to its edges and read as a clean tan rectangle taped to a wall.
    const g = new THREE.PlaneGeometry(1, 1, 8, 8);
    paint(g, (x, y) => {
      const e = Math.max(Math.abs(x), Math.abs(y)) * 2;
      const blotch = smoothNoise(x * 7.3 + 11.2, y * 6.1 - 4.4);
      const scour = smoothNoise(x * 2.1 - 3.7, y * 3.4 + 8.1);
      return [
        clamp01(0.30 + 0.75 * e * e + 0.55 * (blotch - 0.35) + 0.4 * (0.5 - y)),
        clamp01(0.45 + 0.5 * (0.5 - y) + 0.5 * (scour - 0.5)),
        0.1,
      ];
    });
    return g;
  }, 'ghost', { castShadow: false, noShadow: true });

  /**
   * The advert itself: a headline in real letterforms over two rules of body
   * copy, in its OWN surface so it is not the same colour as the field it sits
   * on. Unit-square like the field, so the layout stretches both together.
   */
  P(K, 'ghost_letters', () => {
    const a = new Accum('ghostletters');
    const m = new THREE.Matrix4();
    const put = (x, y, w, h, mask) => {
      const g = new THREE.PlaneGeometry(w, h);
      m.setPosition(x, y, 0.006);
      a.add(g, m, null, mask);
      g.dispose();
    };
    // headline: block letterforms with counters knocked out of them
    const N = 5;
    for (let i = 0; i < N; i++) {
      const h0 = hash3i(981, i, 1);
      const cx = -0.30 + (i + 0.5) * (0.60 / N);
      const gw = (0.60 / N) * 0.62;
      const wear = 0.20 + 0.55 * h0;
      put(cx - gw * 0.34, 0.27, gw * 0.30, 0.20, [wear, 0.4, 0.05]);
      put(cx + gw * 0.34, 0.27, gw * 0.30, 0.20, [wear, 0.4, 0.05]);
      put(cx, 0.27 + (h0 < 0.5 ? 0.075 : -0.005), gw, 0.048, [wear, 0.4, 0.05]);
    }
    // two rules of body copy — words, with the gaps a line of type has
    for (let row = 0; row < 2; row++) {
      let x = -0.30;
      let i = 0;
      while (x < 0.28 && i < 12) {
        const h0 = hash3i(983, row * 17 + i, 2);
        const w = 0.04 + h0 * 0.085;
        put(x + w * 0.5, 0.03 - row * 0.17, w, row === 0 ? 0.062 : 0.045,
          [0.25 + 0.5 * h0, 0.45, 0.05]);
        x += w + 0.022 + h0 * 0.02;
        i++;
      }
    }
    return a.build();
  }, 'ghost_ink', { castShadow: false, noShadow: true });
}

export function registerSignKit(K) {
  registerFascia(K);
  registerNeon(K);
  registerCommerce(K);
  registerPaint(K);
}
