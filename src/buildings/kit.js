import * as THREE from 'three';
import {
  Accum,
  chamferBox,
  plainBox,
  quad,
  cylinderY,
  moulding,
  weather,
  fillMasks,
  paintMasks,
  newTrs,
  trs,
  fbm3,
} from './geom.js';

/**
 * BUILDINGS — the modular kit.
 *
 * Everything a facade repeats: window units, doors, sills, shopfronts,
 * balconies, fire escapes, downpipes, air-conditioners, roof plant. Each piece
 * is authored ONCE at unit size and registered as an instance prototype, then
 * scaled per placement. That is what lets a tile carry twenty thousand pieces
 * of window furniture without twenty thousand draw calls or twenty thousand
 * vertex buffers.
 *
 * Unit convention for anything that goes on a wall:
 *   x  along the wall, centred, spans -0.5 .. 0.5
 *   y  up, spans -0.5 .. 0.5 (openings) or 0 .. 1 (things that stand on a line)
 *   z  OUT of the wall; the wall's outer face is z = 0
 */

const _m = new THREE.Matrix4();

/** Window frame styles. Each reads as a different era and a different use. */
export const WIN_STYLES = ['sash', 'grid', 'plain', 'curtain', 'shop', 'louvre'];

const id = (...p) => p.join('|');

// ---------------------------------------------------------------- windows --
/**
 * A window frame at unit size. Bar widths are absolute-ish rather than
 * proportional, so a 1.1 m sash and a 2.6 m shopfront light do not end up with
 * the same visual weight of joinery — the thing that makes generated facades
 * read as one repeated tile.
 */
function frameGeo(style, cls) {
  const a = new Accum('frame');
  // Nominal metres this class is scaled to, so the bar reads at the right size.
  const nomW = cls === 'lg' ? 2.6 : cls === 'md' ? 1.6 : 1.05;
  const nomH = cls === 'lg' ? 3.0 : cls === 'md' ? 2.0 : 1.35;
  const bw = (style === 'curtain' ? 0.045 : style === 'shop' ? 0.06 : 0.062) / nomW;
  const bh = (style === 'curtain' ? 0.045 : style === 'shop' ? 0.06 : 0.062) / nomH;
  const d = 0.075; // frame depth, out of the reveal
  const box = plainBox();

  const bar = (x, y, w, h) => a.add(box, trs(_m, x, y, d * 0.5, 0, w, h, d));
  // outer ring
  bar(0, 0.5 - bh / 2, 1, bh);
  bar(0, -0.5 + bh / 2, 1, bh);
  bar(-0.5 + bw / 2, 0, bw, 1 - bh * 2);
  bar(0.5 - bw / 2, 0, bw, 1 - bh * 2);

  const mb = bw * 0.72;
  const mh = bh * 0.72;
  if (style === 'sash') {
    // A one-over-one sash: the meeting rail is the whole read, and a lattice of
    // glazing bars on every window is what makes a terrace look like a spread-
    // sheet. The bottom rail is heavier than the top, as a real sash is.
    bar(0, 0.02, 1 - bw * 2, mh * 1.9);
  } else if (style === 'grid') {
    for (let i = 1; i < 3; i++) bar(-0.5 + i / 3, 0, mb, 1 - bh * 2);
    for (let j = 1; j < 4; j++) bar(0, -0.5 + j / 4, 1 - bw * 2, mh);
  } else if (style === 'plain') {
    bar(0, 0, mb, 1 - bh * 2);
    bar(0, -0.16, 1 - bw * 2, mh);
  } else if (style === 'curtain') {
    bar(0, 0, mb, 1 - bh * 2);
  } else if (style === 'louvre') {
    for (let j = 1; j < 7; j++) bar(0, -0.5 + j / 7, 1 - bw * 2, mh * 1.35);
  }
  const g = a.build();
  weather(g, { wear: 0.9, grime: 0.5, down: 0.8 });
  return g;
}

/**
 * The cardboard interior. Five faces, open toward the street: a ceiling that
 * catches whatever light gets in, a floor a stop under it and a back wall
 * darker still. The eye reads those three values as depth from the pavement,
 * and it is the difference between a window and a black rectangle.
 */
function roomGeo(depth = 1.0) {
  const a = new Accum('room');
  const d = depth;
  const face = (g, w, gr, ao) => {
    fillMasks(g, w, gr, ao);
    a.add(g, null);
    g.dispose();
  };
  // back wall, facing the street
  const back = quad(1, 1);
  back.translate(0, 0, -d);
  face(back, 0, 0.25, 0.45);
  // ceiling (normal down) — the plane that catches whatever light gets in
  const ceil = quad(1, d);
  ceil.rotateX(Math.PI / 2);
  ceil.translate(0, 0.5, -d / 2);
  face(ceil, 0, 0, 0.12);
  // floor, a stop under the ceiling
  const flr = quad(1, d);
  flr.rotateX(-Math.PI / 2);
  flr.translate(0, -0.5, -d / 2);
  face(flr, 0, 0.3, 0.5);
  // reveals
  const left = quad(d, 1);
  left.rotateY(Math.PI / 2);
  left.translate(-0.5, 0, -d / 2);
  face(left, 0, 0.2, 0.5);
  const right = quad(d, 1);
  right.rotateY(-Math.PI / 2);
  right.translate(0.5, 0, -d / 2);
  face(right, 0, 0.2, 0.5);
  return a.build();
}

/** A blind or curtain pulled part-way down — never all to the same height. */
function blindGeo(drop) {
  const g = quad(0.94, drop);
  g.translate(0, 0.5 - drop / 2, 0);
  return fillMasks(g, 0, 0.15, 0.1);
}

/** Projecting stone/timber sill with a drip and a slight fall. */
function sillGeo(proj = 0.09) {
  const g = moulding(
    1,
    [
      [-0.04, 0],
      [proj, 0.012],
      [proj, 0.07],
      [proj - 0.022, 0.09],
      [-0.04, 0.09],
    ],
    { bevel: 0.006 }
  );
  return g;
}

/** Flat lintel / soldier course over an opening. */
function lintelGeo() {
  // A soldier course or a stone head projects far enough to shade the top of
  // the opening. The old 4.5 cm was inside the reveal, so the head of every
  // window was lit exactly like the wall and the opening lost its top edge.
  return moulding(
    1,
    [
      [-0.03, 0],
      [0.09, 0.01],
      [0.09, 0.19],
      [0.05, 0.22],
      [-0.03, 0.22],
    ],
    { bevel: 0.005 }
  );
}

// ------------------------------------------------------------- registration --
/**
 * Everything below returns a prototype id, registering the geometry on first
 * use. Ids are deliberately coarse — a small shared vocabulary keeps the
 * per-tile instanced draw-call count in the teens.
 */
export const Kit = {
  frame(lib, matKey, style, cls) {
    const k = id('fr', style, cls, matKey);
    return lib.proto(k, () => frameGeo(style, cls), matKey);
  },

  glass(lib, matKey) {
    const k = id('gl', matKey);
    return lib.proto(k, () => fillMasks(quad(1, 1), 0, 0.2, 0), matKey, { noShadow: true });
  },

  room(lib, matKey, depth = 'md') {
    const d = depth === 'deep' ? 1.6 : depth === 'shallow' ? 0.5 : 1.0;
    const k = id('rm', matKey, depth);
    return lib.proto(k, () => roomGeo(d), matKey, { castShadow: false });
  },

  blind(lib, matKey, step) {
    const k = id('bl', matKey, step);
    return lib.proto(k, () => blindGeo(0.2 + step * 0.22), matKey, { castShadow: false });
  },

  sill(lib, matKey, proj = 'std') {
    const k = id('si', matKey, proj);
    // 13 cm of nose, not 9. A sill only earns its place by throwing a shadow
    // across the course below it and shedding a stain off its drip; at 9 cm on
    // a 34 cm wall it sat almost flush with the reveal and did neither.
    return lib.proto(k, () => sillGeo(proj === 'deep' ? 0.18 : 0.13), matKey);
  },

  lintel(lib, matKey) {
    const k = id('li', matKey);
    return lib.proto(k, () => lintelGeo(), matKey);
  },

  /** Plywood nailed over an opening — one boarded window per derelict block. */
  board(lib, matKey) {
    const k = id('bd', matKey);
    return lib.proto(k, () => {
      const a = new Accum('board');
      const b = plainBox();
      for (let i = 0; i < 3; i++) {
        const y = -0.32 + i * 0.32;
        a.add(b, trs(_m, 0, y + fbm3(i * 3.1, 1, 2, 2) * 0.05 - 0.02, 0.03, 0, 1.02, 0.3, 0.024));
      }
      b.dispose();
      const g = a.build();
      return weather(g, { wear: 0.9, grime: 0.6, down: 0.8 });
    }, matKey);
  },

  // ------------------------------------------------------------- doors ----
  door(lib, matKey, kind = 'panel') {
    const k = id('dr', matKey, kind);
    return lib.proto(k, () => {
      const a = new Accum('door');
      const box = plainBox();
      a.add(box, trs(_m, 0, 0, 0.025, 0, 0.98, 0.99, 0.05));
      if (kind === 'panel') {
        // four raised panels — the cheapest thing that stops a door being a slab
        for (let i = 0; i < 2; i++) {
          for (let j = 0; j < 2; j++) {
            a.add(
              box,
              trs(_m, -0.21 + i * 0.42, -0.26 + j * 0.44, 0.062, 0, 0.3, 0.3, 0.026)
            );
          }
        }
      } else if (kind === 'glazed') {
        a.add(box, trs(_m, 0, 0.22, 0.062, 0, 0.62, 0.34, 0.02));
        a.add(box, trs(_m, 0, -0.24, 0.062, 0, 0.7, 0.36, 0.026));
      } else if (kind === 'steel') {
        a.add(box, trs(_m, 0, 0.3, 0.062, 0, 0.8, 0.04, 0.02));
        a.add(box, trs(_m, 0, -0.1, 0.062, 0, 0.8, 0.04, 0.02));
      }
      // handle
      a.add(box, trs(_m, 0.36, -0.02, 0.09, 0, 0.05, 0.11, 0.05));
      box.dispose();
      const g = a.build();
      return weather(g, { wear: 0.85, grime: 0.5, down: 0.7, base: 0.5 });
    }, matKey);
  },

  /** Roller shutter, partly or fully down. Its ribs are the whole read. */
  shutter(lib, matKey, step) {
    const k = id('sh', matKey, step);
    return lib.proto(k, () => {
      const drop = [0.18, 0.55, 1.0][step];
      const a = new Accum('shutter');
      const box = plainBox();
      const n = Math.max(2, Math.round(drop * 14));
      for (let i = 0; i < n; i++) {
        const y = 0.5 - (i + 0.5) * (drop / n);
        a.add(box, trs(_m, 0, y, 0.018, 0, 1, drop / n - 0.008, 0.036));
      }
      // housing box at the head
      a.add(box, trs(_m, 0, 0.5 + 0.075, 0.04, 0, 1.06, 0.15, 0.13));
      box.dispose();
      const g = a.build();
      return weather(g, { wear: 0.9, grime: 0.55, down: 0.8, base: 0.6 });
    }, matKey);
  },

  // ------------------------------------------------------- facade metal ----
  /** 1 m of downpipe, scaled in Y. Brackets every metre keep it off the wall. */
  downpipe(lib, matKey) {
    const k = id('dp', matKey);
    return lib.proto(k, () => {
      // Authored 0..1 in Y so the caller can scale it by the wall height.
      const a = new Accum('downpipe');
      const t = cylinderY(0.05, 1, 8);
      a.add(t, trs(_m, 0, 0.5, 0.07, 0, 1, 1, 1));
      t.dispose();
      const b = plainBox();
      a.add(b, trs(_m, 0, 0.84, 0.035, 0, 0.14, 0.03, 0.075));
      a.add(b, trs(_m, 0, 0.16, 0.035, 0, 0.14, 0.03, 0.075));
      // the shoe at the bottom, kicking the run out over the pavement
      a.add(b, trs(_m, 0, 0.012, 0.105, 0, 0.11, 0.02, 0.2));
      b.dispose();
      const g = a.build();
      return weather(g, { wear: 0.8, grime: 0.75, down: 1.0 });
    }, matKey);
  },

  /** A window air-conditioner. Nothing says "someone lives here" faster. */
  ac(lib, matKey) {
    const k = id('ac', matKey);
    return lib.proto(k, () => {
      const a = new Accum('ac');
      const b = chamferBox(1, 1, 1, 0.02);
      a.add(b, trs(_m, 0, 0, 0.28, 0, 0.72, 0.42, 0.56));
      b.dispose();
      const p = plainBox();
      // grille slats
      for (let i = 0; i < 5; i++) {
        a.add(p, trs(_m, 0, -0.14 + i * 0.07, 0.565, 0, 0.6, 0.028, 0.02));
      }
      // the bracket under it, and the drip that always stains the wall
      a.add(p, trs(_m, -0.28, -0.24, 0.16, 0, 0.05, 0.05, 0.34));
      a.add(p, trs(_m, 0.28, -0.24, 0.16, 0, 0.05, 0.05, 0.34));
      p.dispose();
      const g = a.build();
      return weather(g, { wear: 0.85, grime: 0.7, down: 1.0 });
    }, matKey);
  },

  /** Rooftop condenser: the fan cowl is what reads from a neighbouring roof. */
  acRoof(lib, matKey) {
    const k = id('acr', matKey);
    return lib.proto(k, () => {
      const a = new Accum('acroof');
      const b = chamferBox(1, 1, 1, 0.025);
      a.add(b, trs(_m, 0, 0.35, 0, 0, 1.5, 0.7, 1.2));
      b.dispose();
      const c = cylinderY(0.36, 0.1, 12);
      a.add(c, trs(_m, 0, 0.74, 0, 0, 1, 1, 1));
      c.dispose();
      const p = plainBox();
      for (let i = 0; i < 4; i++) {
        a.add(p, trs(_m, 0, 0.78, 0, (i * Math.PI) / 4, 0.62, 0.012, 0.1));
      }
      // feet on anti-vibration pads
      for (const sx of [-1, 1]) {
        for (const sz of [-1, 1]) {
          a.add(p, trs(_m, sx * 0.6, 0.05, sz * 0.45, 0, 0.14, 0.1, 0.14));
        }
      }
      p.dispose();
      const g = a.build();
      return weather(g, { wear: 0.85, grime: 0.6, down: 0.9 });
    }, matKey);
  },

  /** Extract cowl / flue. */
  vent(lib, matKey, kind = 'cowl') {
    const k = id('vt', matKey, kind);
    return lib.proto(k, () => {
      const a = new Accum('vent');
      if (kind === 'cowl') {
        const t = cylinderY(0.18, 1.1, 10);
        a.add(t, trs(_m, 0, 0.55, 0, 0, 1, 1, 1));
        t.dispose();
        const c = cylinderY(0.3, 0.22, 10, { rTop: 0.16 });
        a.add(c, trs(_m, 0, 1.2, 0, 0, 1, 1, 1));
        c.dispose();
      } else if (kind === 'stack') {
        const t = cylinderY(0.26, 2.6, 10);
        a.add(t, trs(_m, 0, 1.3, 0, 0, 1, 1, 1));
        t.dispose();
        const c = cylinderY(0.34, 0.14, 10);
        a.add(c, trs(_m, 0, 2.62, 0, 0, 1, 1, 1));
        c.dispose();
      } else {
        const b = chamferBox(1, 1, 1, 0.02);
        a.add(b, trs(_m, 0, 0.22, 0, 0, 0.8, 0.44, 0.8));
        b.dispose();
        const p = plainBox();
        for (let i = 0; i < 4; i++) a.add(p, trs(_m, 0, 0.46, 0, 0, 0.9, 0.02, 0.08 + i * 0.16));
        p.dispose();
      }
      const g = a.build();
      return weather(g, { wear: 0.85, grime: 0.65, down: 0.9 });
    }, matKey);
  },

  dish(lib, matKey) {
    const k = id('di', matKey);
    return lib.proto(k, () => {
      const a = new Accum('dish');
      const d = new THREE.SphereGeometry(0.45, 12, 6, 0, Math.PI * 2, 0, Math.PI * 0.32);
      d.setAttribute(
        'color',
        new THREE.Float32BufferAttribute(new Float32Array(d.getAttribute('position').count * 3), 3)
      );
      const mm = new THREE.Matrix4().makeRotationX(-2.2);
      mm.setPosition(0, 0.55, 0);
      a.add(d, mm);
      d.dispose();
      const p = plainBox();
      a.add(p, trs(_m, 0, 0.26, 0, 0, 0.06, 0.55, 0.06));
      a.add(p, trs(_m, 0, 0.02, 0, 0, 0.3, 0.05, 0.3));
      a.add(p, trs(_m, 0, 0.62, 0.3, 0.5, 0.05, 0.05, 0.4));
      p.dispose();
      const g = a.build();
      return weather(g, { wear: 0.7, grime: 0.5, down: 0.8 });
    }, matKey);
  },

  /** Aerial mast — the thing that breaks a rooftop's flat silhouette. */
  antenna(lib, matKey) {
    const k = id('an', matKey);
    return lib.proto(k, () => {
      const a = new Accum('antenna');
      const p = plainBox();
      a.add(p, trs(_m, 0, 1.4, 0, 0, 0.06, 2.8, 0.06));
      for (let i = 0; i < 5; i++) {
        const y = 1.5 + i * 0.26;
        a.add(p, trs(_m, 0, y, 0, 0, 0.03, 0.03, 1.0 - i * 0.14));
      }
      a.add(p, trs(_m, 0, 0.06, 0, 0, 0.3, 0.12, 0.3));
      p.dispose();
      const g = a.build();
      return weather(g, { wear: 0.75, grime: 0.4, down: 0.6 });
    }, matKey);
  },

  // ---------------------------------------------------------- balconies ----
  /**
   * A balcony: slab, brackets, balustrade. Unit width in X; the caller scales
   * X only, so the balusters stay the right size on a 1.5 m or a 4 m balcony.
   */
  balconySlab(lib, matKey) {
    const k = id('bs', matKey);
    return lib.proto(k, () => {
      const a = new Accum('balc');
      const b = chamferBox(1, 1, 1, 0.015);
      a.add(b, trs(_m, 0, 0, 0.6, 0, 1, 0.11, 1.2));
      b.dispose();
      const p = plainBox();
      for (const s of [-0.42, 0.42]) {
        a.add(p, trs(_m, s, -0.16, 0.42, 0, 0.07, 0.24, 0.85), null);
      }
      p.dispose();
      const g = a.build();
      return weather(g, { wear: 0.85, grime: 0.7, down: 1.0 });
    }, matKey);
  },

  balconyRail(lib, matKey, kind = 'bar') {
    const k = id('br', matKey, kind);
    return lib.proto(k, () => {
      const a = new Accum('rail');
      const p = plainBox();
      const H = 1.05;
      // top rail + bottom rail along the front and the two returns
      const run = (x, z, len, rot) => {
        a.add(p, trs(_m, x, H, z, rot, len, 0.05, 0.05));
        a.add(p, trs(_m, x, 0.1, z, rot, len, 0.035, 0.035));
        if (kind === 'bar') {
          const n = Math.max(3, Math.round(len / 0.13));
          for (let i = 0; i <= n; i++) {
            const t = -len / 2 + (i / n) * len;
            const bx = rot === 0 ? x + t : x;
            const bz = rot === 0 ? z : z + t;
            a.add(p, trs(_m, bx, H / 2, bz, 0, 0.022, H, 0.022));
          }
        } else {
          // solid panel balustrade
          a.add(p, trs(_m, x, H / 2, z, rot, len, H - 0.1, 0.04));
        }
      };
      run(0, 1.16, 1, 0);
      run(-0.48, 0.6, 1.14, Math.PI / 2);
      run(0.48, 0.6, 1.14, Math.PI / 2);
      p.dispose();
      const g = a.build();
      return weather(g, { wear: 0.9, grime: 0.6, down: 0.8 });
    }, matKey);
  },

  /**
   * One storey of fire escape, authored for a 3.2 m floor: a landing at y = 0,
   * a rail round it, and a flight running diagonally ACROSS the landing down to
   * the next one at y = -3.2. Placed with a uniform scale of floorH/3.2 so the
   * flight always lands where the storey below actually is — a stair that stops
   * in mid-air is the fastest way to lose a whole facade.
   */
  fireEscape(lib, matKey) {
    const k = id('fe', matKey);
    return lib.proto(k, () => {
      const a = new Accum('fe');
      const p = plainBox();
      const D = 1.35; // how far the landing stands off the wall
      // landing grating: slats, so light gets through it the way a grating does
      for (let i = 0; i < 9; i++) {
        a.add(p, trs(_m, 0, 0, 0.12 + i * 0.14, 0, 2.0, 0.05, 0.085));
      }
      // edge angles
      a.add(p, trs(_m, 0, -0.03, D, 0, 2.05, 0.11, 0.07));
      a.add(p, trs(_m, 0, -0.03, 0.09, 0, 2.05, 0.11, 0.07));
      // posts + top rail + mid rail on the three open sides
      const rail = (x, z, len, ry) => {
        a.add(p, trs(_m, x, 1.02, z, ry, len, 0.05, 0.05));
        a.add(p, trs(_m, x, 0.52, z, ry, len, 0.035, 0.035));
        const n = Math.max(3, Math.round(len / 0.17));
        for (let i = 0; i <= n; i++) {
          const tt = -len / 2 + (i / n) * len;
          a.add(p, trs(_m, ry === 0 ? x + tt : x, 0.52, ry === 0 ? z : z + tt, 0, 0.022, 1.0, 0.022));
        }
      };
      rail(0, D, 2.0, 0);
      rail(-1.0, D / 2 + 0.05, D, Math.PI / 2);
      rail(1.0, D / 2 + 0.05, D, Math.PI / 2);
      // the flight down: treads march across the landing width as they descend
      const steps = 11;
      for (let i = 1; i <= steps; i++) {
        const tt = i / steps;
        a.add(
          p,
          trs(_m, -0.85 + tt * 1.7, -tt * 3.2 + 0.1, D * 0.62, 0, 0.62, 0.045, 0.24, 0, 0)
        );
      }
      // stringers along the flight
      for (const sz of [-0.24, 0.24]) {
        a.add(p, trs(_m, 0, -1.5, D * 0.62 + sz, 0, 2.1, 0.09, 0.06, 0, -1.08));
      }
      // the counterweighted drop ladder hanging off the bottom landing
      a.add(p, trs(_m, 0.86, -0.9, D - 0.12, 0, 0.05, 1.8, 0.05));
      p.dispose();
      const g = a.build();
      return weather(g, { wear: 0.95, grime: 0.7, down: 0.9 });
    }, matKey);
  },

  // ------------------------------------------------------------- ground ----
  /** Stoop: steps up to a raised front door, with cheek walls. */
  stoop(lib, matKey, steps = 4) {
    const k = id('st', matKey, steps);
    return lib.proto(k, () => {
      const a = new Accum('stoop');
      const b = chamferBox(1, 1, 1, 0.012);
      const rise = 0.17;
      const run = 0.3;
      for (let i = 0; i < steps; i++) {
        const d = (steps - i) * run;
        a.add(b, trs(_m, 0, rise * (i + 0.5), d / 2, 0, 1.5, rise, d));
      }
      for (const sx of [-1, 1]) {
        a.add(
          b,
          trs(_m, sx * 0.82, (rise * steps) / 2 + 0.1, (steps * run) / 2, 0, 0.16, rise * steps + 0.2, steps * run)
        );
      }
      b.dispose();
      const g = a.build();
      return weather(g, { wear: 0.9, grime: 0.6, down: 0.7, base: 0.9 });
    }, matKey);
  },

  /** Basement stairwell: a hole in the pavement with a rail round it. */
  areaway(lib, matKey) {
    const k = id('aw', matKey);
    return lib.proto(k, () => {
      const a = new Accum('areaway');
      const b = plainBox();
      // side walls and the steps going down
      for (const sx of [-1, 1]) a.add(b, trs(_m, sx * 0.62, -0.7, 0.5, 0, 0.12, 1.5, 1.6));
      a.add(b, trs(_m, 0, -0.7, 1.25, 0, 1.36, 1.5, 0.12));
      for (let i = 0; i < 7; i++) {
        a.add(b, trs(_m, 0, -0.12 - i * 0.2, 0.24 + i * 0.16, 0, 1.1, 0.06, 0.18));
      }
      // rail
      for (let i = 0; i <= 6; i++) {
        a.add(b, trs(_m, -0.66 + i * 0.22, 0.5, -0.12, 0, 0.03, 1.0, 0.03));
      }
      a.add(b, trs(_m, 0, 0.98, -0.12, 0, 1.44, 0.05, 0.05));
      b.dispose();
      const g = a.build();
      return weather(g, { wear: 0.9, grime: 0.8, down: 1.0, base: 1.0 });
    }, matKey);
  },

  /** Fabric awning over a shopfront. Sag, not a wedge. */
  awning(lib, matKey) {
    const k = id('aw2', matKey);
    return lib.proto(k, () => {
      const W = 12;
      const D = 6;
      const pos = [];
      const nrm = [];
      const uv = [];
      const col = [];
      const idx = [];
      for (let j = 0; j <= D; j++) {
        const v = j / D;
        for (let i = 0; i <= W; i++) {
          const u = i / W;
          const sag = Math.sin(u * Math.PI) * 0.06 * v;
          pos.push(u - 0.5, -v * 0.62 - sag, v * 0.95);
          nrm.push(0, 1, 0);
          uv.push(u * 2.4, v * 1.2);
          col.push(0.2, v * 0.35, v * 0.2);
        }
      }
      const row = W + 1;
      for (let j = 0; j < D; j++) {
        for (let i = 0; i < W; i++) {
          const A = j * row + i;
          idx.push(A, A + row, A + 1, A + 1, A + row, A + row + 1);
        }
      }
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
      g.setAttribute('normal', new THREE.Float32BufferAttribute(nrm, 3));
      g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
      g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
      g.setIndex(idx);
      g.computeVertexNormals();
      g.computeBoundingSphere();
      return g;
    }, matKey, { noShadow: false });
  },

  /** Awning frame — the tubes it hangs off. */
  awningFrame(lib, matKey) {
    const k = id('awf', matKey);
    return lib.proto(k, () => {
      const a = new Accum('awnf');
      const p = plainBox();
      for (const sx of [-0.48, 0.48]) {
        a.add(p, trs(_m, sx, -0.32, 0.48, 0, 0.04, 0.78, 0.04, 0, -0.62));
      }
      a.add(p, trs(_m, 0, -0.64, 0.95, 0, 1.0, 0.05, 0.05));
      p.dispose();
      return weather(a.build(), { wear: 0.85, grime: 0.6 });
    }, matKey);
  },

  /** Fascia signage board over a shop. */
  signBoard(lib, matKey) {
    const k = id('sg', matKey);
    return lib.proto(k, () => {
      const a = new Accum('sign');
      const b = chamferBox(1, 1, 1, 0.014);
      a.add(b, trs(_m, 0, 0, 0.07, 0, 1, 0.62, 0.14));
      b.dispose();
      const g = a.build();
      return weather(g, { wear: 0.8, grime: 0.55, down: 0.8 });
    }, matKey);
  },

  /** Projecting blade sign, hung off a bracket at right angles to the street. */
  bladeSign(lib, matKey) {
    const k = id('bs2', matKey);
    return lib.proto(k, () => {
      const a = new Accum('blade');
      const b = chamferBox(1, 1, 1, 0.012);
      a.add(b, trs(_m, 0, -0.45, 0.72, 0, 0.06, 0.8, 0.85));
      b.dispose();
      const p = plainBox();
      a.add(p, trs(_m, 0, 0.02, 0.34, 0, 0.05, 0.05, 0.68));
      a.add(p, trs(_m, 0, -0.16, 0.16, 0.0, 0.04, 0.42, 0.04, 0, 0.7));
      p.dispose();
      return weather(a.build(), { wear: 0.85, grime: 0.6, down: 0.9 });
    }, matKey);
  },

  /** A lit sign face, kept separate so it can be an emissive material. */
  signFace(lib, matKey) {
    const k = id('sf', matKey);
    return lib.proto(k, () => fillMasks(quad(1, 1), 0, 0, 0), matKey, {
      castShadow: false,
      noShadow: true,
    });
  },

  /**
   * What is actually inside a shop. Unit cube in X/Y, extending back in -Z:
   * a counter across the front third, shelving up the back wall and a stack of
   * cartons. Twelve boxes, and it is the difference between a lit rectangle and
   * a place that sells something.
   */
  shopFit(lib, matKey) {
    const k = id('sf2', matKey);
    return lib.proto(k, () => {
      const a = new Accum('shopfit');
      const b = plainBox();
      // counter
      a.add(b, trs(_m, -0.12, -0.22, -0.34, 0, 0.62, 0.3, 0.14));
      a.add(b, trs(_m, -0.12, -0.06, -0.34, 0, 0.66, 0.03, 0.18));
      // back shelving, four bands
      for (let i = 0; i < 4; i++) {
        a.add(b, trs(_m, 0, -0.34 + i * 0.19, -0.9, 0, 0.94, 0.035, 0.14));
        for (let j = 0; j < 5; j++) {
          if ((i * 7 + j * 3) % 4 === 0) continue;
          a.add(b, trs(_m, -0.4 + j * 0.2, -0.29 + i * 0.19, -0.9, 0, 0.11, 0.09, 0.1));
        }
      }
      // cartons stacked in the corner
      a.add(b, trs(_m, 0.36, -0.4, -0.62, 0.3, 0.2, 0.16, 0.2));
      a.add(b, trs(_m, 0.36, -0.24, -0.62, -0.2, 0.19, 0.15, 0.19));
      b.dispose();
      const g = a.build();
      return weather(g, { wear: 0.5, grime: 0.3, down: 0.4 });
    }, matKey, { castShadow: false });
  },

  bollard(lib, matKey) {
    const k = id('bo', matKey);
    return lib.proto(k, () => {
      const g = cylinderY(0.09, 0.95, 8);
      g.translate(0, 0.475, 0);
      return weather(g, { wear: 0.9, grime: 0.6, base: 0.8 });
    }, matKey);
  },

  // ------------------------------------------------------------- roofs ----
  /** Rooftop plant room / stair head. */
  plantRoom(lib, matKey) {
    const k = id('pr', matKey);
    return lib.proto(k, () => {
      const a = new Accum('plant');
      const b = chamferBox(1, 1, 1, 0.02);
      a.add(b, trs(_m, 0, 0.5, 0, 0, 1, 1, 1));
      a.add(b, trs(_m, 0, 1.03, 0, 0, 1.09, 0.07, 1.09));
      b.dispose();
      const g = a.build();
      return weather(g, { wear: 0.75, grime: 0.55, down: 0.8 });
    }, matKey);
  },

  /** Timber water tower — the Pittsburgh/NYC rooftop silhouette. */
  waterTower(lib, matKey) {
    const k = id('wt', matKey);
    return lib.proto(k, () => {
      const a = new Accum('wt');
      const tank = cylinderY(1.35, 3.1, 16);
      a.add(tank, trs(_m, 0, 4.6, 0, 0, 1, 1, 1));
      tank.dispose();
      const cone = cylinderY(1.42, 0.75, 16, { rTop: 0.12 });
      a.add(cone, trs(_m, 0, 6.5, 0, 0, 1, 1, 1));
      cone.dispose();
      const p = plainBox();
      // hoops
      for (const y of [3.5, 4.6, 5.7]) {
        const h = cylinderY(1.4, 0.09, 16, { open: true });
        a.add(h, trs(_m, 0, y, 0, 0, 1, 1, 1));
        h.dispose();
      }
      // legs and cross-bracing
      for (let i = 0; i < 4; i++) {
        const th = (i / 4) * Math.PI * 2 + 0.4;
        const x = Math.cos(th) * 1.05;
        const z = Math.sin(th) * 1.05;
        a.add(p, trs(_m, x, 1.5, z, -th, 0.14, 3.0, 0.14));
        a.add(p, trs(_m, x * 0.72, 2.05, z * 0.72, -th, 0.09, 0.09, 1.5, 0.55));
      }
      p.dispose();
      const g = a.build();
      return weather(g, { wear: 0.9, grime: 0.6, down: 0.85 });
    }, matKey);
  },

  /** Parapet coping run, 1 m, scaled along X. */
  coping(lib, matKey) {
    const k = id('cp', matKey);
    return lib.proto(k, () =>
      moulding(1, [
        [-0.09, 0],
        [0.09, 0],
        [0.09, 0.055],
        [0.06, 0.09],
        [-0.06, 0.09],
        [-0.09, 0.055],
      ]),
      matKey
    );
  },

  chimney(lib, matKey) {
    const k = id('ch', matKey);
    return lib.proto(k, () => {
      const a = new Accum('chim');
      const b = chamferBox(1, 1, 1, 0.015);
      a.add(b, trs(_m, 0, 0.75, 0, 0, 0.75, 1.5, 0.55));
      a.add(b, trs(_m, 0, 1.55, 0, 0, 0.87, 0.13, 0.67));
      b.dispose();
      const p = cylinderY(0.11, 0.34, 8);
      a.add(p, trs(_m, -0.16, 1.75, 0, 0, 1, 1, 1));
      a.add(p, trs(_m, 0.16, 1.75, 0, 0, 1, 1, 1));
      p.dispose();
      const g = a.build();
      return weather(g, { wear: 0.85, grime: 0.7, down: 0.85 });
    }, matKey);
  },

  // -------------------------------------------------------- industrial ----
  silo(lib, matKey) {
    const k = id('si2', matKey);
    return lib.proto(k, () => {
      const a = new Accum('silo');
      const t = cylinderY(1, 1, 20, { open: true });
      a.add(t, trs(_m, 0, 0.5, 0, 0, 1, 1, 1));
      t.dispose();
      const c = cylinderY(1.03, 0.22, 20, { rTop: 0.6 });
      a.add(c, trs(_m, 0, 1.06, 0, 0, 1, 1, 1));
      c.dispose();
      const r = cylinderY(1.02, 0.06, 20);
      for (const y of [0.25, 0.55, 0.85]) a.add(r, trs(_m, 0, y, 0, 0, 1, 1, 1));
      r.dispose();
      const g = a.build();
      return weather(g, { wear: 0.9, grime: 0.65, down: 0.85, base: 0.7 });
    }, matKey);
  },

  /** One bay of a lattice gantry / conveyor truss, 4 m long along X. */
  truss(lib, matKey) {
    const k = id('tr', matKey);
    return lib.proto(k, () => {
      const a = new Accum('truss');
      const p = plainBox();
      for (const y of [0, 1.5]) {
        for (const z of [-0.6, 0.6]) a.add(p, trs(_m, 0, y, z, 0, 4.05, 0.12, 0.12));
      }
      for (let i = 0; i <= 4; i++) {
        const x = -2 + i;
        for (const z of [-0.6, 0.6]) a.add(p, trs(_m, x, 0.75, z, 0, 0.09, 1.5, 0.09));
        a.add(p, trs(_m, x - 0.5, 0.75, 0, 0, 0.07, 1.75, 0.07, 0, 0.58));
      }
      p.dispose();
      const g = a.build();
      return weather(g, { wear: 0.95, grime: 0.7, down: 0.8 });
    }, matKey);
  },

  ladder(lib, matKey) {
    const k = id('ld', matKey);
    return lib.proto(k, () => {
      const a = new Accum('ladder');
      const p = plainBox();
      for (const sx of [-0.22, 0.22]) a.add(p, trs(_m, sx, 0.5, 0.1, 0, 0.045, 1, 0.045));
      const n = 4;
      for (let i = 0; i < n; i++) a.add(p, trs(_m, 0, (i + 0.5) / n, 0.1, 0, 0.44, 0.03, 0.03));
      p.dispose();
      return weather(a.build(), { wear: 0.9, grime: 0.6 });
    }, matKey);
  },
};

/** Quantised size class for a window opening. */
export function sizeClass(w, h) {
  const s = Math.max(w, h * 0.8);
  return s > 2.2 ? 'lg' : s > 1.35 ? 'md' : 'sm';
}

export { paintMasks, fillMasks, weather };
