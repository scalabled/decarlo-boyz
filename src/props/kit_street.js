import * as THREE from 'three';
import {
  Accum, box, chamferBox, cyl, card, ground, lathe, extrude, ngon, tube,
  combine, weather, paint, dent, newTrs, trs, clamp01, lerp, TAU, hash3i,
} from './geom.js';

/**
 * PROPS — street furniture.
 *
 * The kit of parts a pavement is actually made of. Every family here is
 * registered as a shared prototype and instanced per tile; a family that needs
 * more than one material is registered as several co-located prototypes (a
 * lamp is a column, a lens and a glow cone), which keeps one material per draw
 * call without giving up the instancing.
 *
 * Nothing is symmetrical, nothing is clean, and every family has at least two
 * silhouettes so a street never shows the same object twice in a row.
 */

const M = new THREE.Matrix4();

function P(K, id, factory, surface, opts) {
  K.proto(id, factory, surface, opts);
  return id;
}

/* ====================================================================== */
/* LAMP POSTS — the signature light of this game                          */
/* ====================================================================== */

/**
 * A cobra-head sodium lamp: the tapered galvanised column, a base flange with
 * four bolts, an inspection door with two screws, and a curved mast arm. The
 * lens and the glow cone are separate prototypes so the emissive stays a
 * separate material.
 */
function cobraColumn(h, armLen, seed) {
  const parts = [];
  // Base flange + bolts + a service door that is never quite closed.
  parts.push([cyl(0.13, 0.155, 0.10, 10), newTrs(0, 0, 0)]);
  parts.push([cyl(0.115, 0.13, 0.20, 10), newTrs(0, 0.10, 0)]);
  for (let i = 0; i < 4; i++) {
    const a = (i / 4) * TAU + 0.4;
    parts.push([cyl(0.018, 0.020, 0.035, 5), newTrs(Math.cos(a) * 0.135, 0.10, Math.sin(a) * 0.135)]);
  }
  // Tapered shaft in three sections so the taper reads.
  const secs = 3;
  let y = 0.30;
  let r = 0.104;
  for (let i = 0; i < secs; i++) {
    const sh = (h - 0.30) / secs;
    const r2 = r * 0.80;
    parts.push([cyl(r2, r, sh, 8), newTrs(0, y, 0)]);
    y += sh;
    r = r2;
  }
  // Inspection door.
  parts.push([box(0.10, 0.30, 0.015), newTrs(0, 0.55, r * 2.1)]);

  // The mast arm: a quarter-arc sweep, not a straight elbow.
  const pts = [];
  const segs = 7;
  const rise = 0.85;
  for (let i = 0; i <= segs; i++) {
    const t = i / segs;
    const th = t * Math.PI * 0.5;
    pts.push({
      x: armLen * (1 - Math.cos(th)),
      y: h + rise * Math.sin(th) - 0.02 * t,
      z: 0,
    });
  }
  parts.push([tube(pts, 0.055, 6, { taper: 0.78 }), null]);
  const g = combine(parts, 'lampcolumn');
  weather(g, { grimeBase: 0.62, grimeHeight: 2.6, wear: 0.5, seed, wearY: [0.2, 2.4] });
  return g;
}

/** The cobra head shell — an elongated teardrop, open underneath. */
function cobraHead() {
  const prof = [
    [0.00, 0.00], [0.10, 0.01], [0.15, 0.045], [0.16, 0.10],
    [0.135, 0.155], [0.075, 0.185], [0.00, 0.19],
  ];
  const g = lathe(prof, 9);
  g.scale(1.75, 1, 1);
  const shroud = box(0.20, 0.055, 0.26);
  const out = combine([[g, null], [shroud, newTrs(0.06, 0.17, 0)]], 'cobrahead');
  weather(out, { grimeBase: 0.7, grimeHeight: 0.4, wear: 0.35, up: 0.5 });
  return out;
}

/** A fluted cast-iron column with an acorn globe — the heritage districts. */
function acornColumn(h, seed) {
  const parts = [];
  parts.push([lathe([[0.20, 0], [0.20, 0.06], [0.155, 0.10], [0.15, 0.30], [0.115, 0.36], [0.09, 0.42]], 10), null]);
  // fluting: eight shallow ribs on the shaft
  parts.push([cyl(0.055, 0.082, h - 0.42, 12), newTrs(0, 0.42, 0)]);
  for (let i = 0; i < 8; i++) {
    const a = (i / 8) * TAU;
    const rr = 0.072;
    parts.push([box(0.014, h - 0.6, 0.02), newTrs(Math.cos(a) * rr, 0.48, Math.sin(a) * rr, -a)]);
  }
  parts.push([lathe([[0.06, 0], [0.10, 0.03], [0.085, 0.08], [0.055, 0.14]], 10), newTrs(0, h - 0.42, 0)]);
  // a bracket for a hanging basket / banner arm, on one side only
  parts.push([tube([{ x: 0, y: h - 0.9, z: 0 }, { x: 0.16, y: h - 0.82, z: 0 }, { x: 0.26, y: h - 0.94, z: 0 }], 0.02, 4), null]);
  const g = combine(parts, 'acorncol');
  weather(g, { grimeBase: 0.7, grimeHeight: 1.6, wear: 0.6, seed, wearY: [0.1, 1.8] });
  return g;
}

function acornGlobe() {
  const g = lathe([
    [0.0, 0], [0.075, 0.02], [0.13, 0.09], [0.145, 0.19],
    [0.11, 0.30], [0.055, 0.36], [0.02, 0.40], [0.0, 0.41],
  ], 10);
  return g;
}

/**
 * THE LIGHT POOL under a lamp.
 *
 * This used to be a volumetric CONE, and it was wrong twice over: a cone that
 * is even slightly too bright reads as a solid orange wedge standing on the
 * pavement — a critic saw exactly that — and a hard-edged shaft is geometry,
 * not light, no matter how it is blended. Volumetric shafts belong to `sky`,
 * which owns the fog that would scatter them.
 *
 * What is left is the thing GTA V actually shows and DESIGN.md actually asks
 * for: "wet asphalt that mirrors sodium lamps at night". A disc lying FLAT on
 * the road, additive, with a radial falloff baked into the vertex colours so it
 * reaches exactly zero at the rim and can never show a silhouette. Flat on the
 * ground, an over-bright pool still reads as light on the road; a standing cone
 * never does.
 */
function lightPool(r) {
  const RINGS = 4;
  const SEG = 14;
  const a = new Accum('pool');
  const c = a.vert(0, 0, 0, 0, 1, 0, 0.5, 0.5, 1, 1, 1);
  let prev = null;
  for (let k = 1; k <= RINGS; k++) {
    const t = k / RINGS;
    const rr = r * t * t; // more samples near the hot centre
    // smootherstep to zero at the rim
    const f = 1 - t;
    const v = f * f * f * (f * (f * 6 - 15) + 10);
    const ring = [];
    for (let i = 0; i < SEG; i++) {
      const th = (i / SEG) * TAU;
      ring.push(a.vert(Math.cos(th) * rr, 0, Math.sin(th) * rr, 0, 1, 0,
        0.5 + Math.cos(th) * 0.5, 0.5 + Math.sin(th) * 0.5, v, v, v));
    }
    if (!prev) for (let i = 0; i < SEG; i++) a.tri(c, ring[(i + 1) % SEG], ring[i]);
    else for (let i = 0; i < SEG; i++) a.quad(prev[i], ring[i], ring[(i + 1) % SEG], prev[(i + 1) % SEG]);
    prev = ring;
  }
  return a.build();
}

export function registerLamps(K) {
  // Cobra, three heights so an avenue is not a metronome.
  const heights = [8.4, 9.3, 7.6];
  heights.forEach((h, i) => {
    P(K, `lamp_cobra_${i}`, () => cobraColumn(h, 2.0 + i * 0.35, 11 + i), 'pole_grey');
    P(K, `lamp_cobra_head_${i}`, () => {
      const g = cobraHead();
      g.translate(2.0 + i * 0.35, h + 0.85, 0);
      return g;
    }, 'pole_grey');
    P(K, `lamp_cobra_lens_${i}`, () => {
      const g = new THREE.SphereGeometry(0.145, 10, 6, 0, TAU, Math.PI * 0.45, Math.PI * 0.55);
      g.scale(1.7, 1, 1);
      g.translate(2.06 + i * 0.35, h + 0.85, 0);
      return g;
    }, 'sodium_lamp', { castShadow: false, noShadow: true });
    P(K, `lamp_cobra_glow_${i}`, () => {
      const g = lightPool(5.4 + i * 0.4);
      g.translate(2.06 + i * 0.35, 0.02, 0);
      return g;
    }, 'sodium_glow', { castShadow: false, noShadow: true, noPrepass: true, renderOrder: 4 });
  });

  // Twin-arm, downtown avenues.
  P(K, 'lamp_twin', () => {
    const a = cobraColumn(9.0, 2.2, 31);
    const arm = cobraColumn(9.0, 2.2, 31);
    arm.scale(-1, 1, 1);
    return combine([[a, null], [arm, null]], 'lamptwin');
  }, 'pole_grey');
  P(K, 'lamp_twin_head', () => {
    const a = cobraHead();
    a.translate(2.2, 9.85, 0);
    const b = cobraHead();
    b.scale(-1, 1, 1);
    b.translate(-2.2, 9.85, 0);
    return combine([[a, null], [b, null]], 'lamptwinhead');
  }, 'pole_grey');
  P(K, 'lamp_twin_lens', () => {
    const mk = (s) => {
      const g = new THREE.SphereGeometry(0.145, 10, 6, 0, TAU, Math.PI * 0.45, Math.PI * 0.55);
      g.scale(1.7 * s, 1, 1);
      g.translate(2.26 * s, 9.85, 0);
      return g;
    };
    return combine([[mk(1), null], [mk(-1), null]], 'lamptwinlens');
  }, 'sodium_lamp', { castShadow: false, noShadow: true });
  P(K, 'lamp_twin_glow', () => {
    const mk = (s) => {
      const g = lightPool(5.6);
      g.translate(2.26 * s, 0.02, 0);
      return g;
    };
    return combine([[mk(1), null], [mk(-1), null]], 'lamptwinglow');
  }, 'sodium_glow', { castShadow: false, noShadow: true, noPrepass: true, renderOrder: 4 });

  // Acorn, heritage + park.
  [[4.6, 'acorn'], [3.5, 'park']].forEach(([h, tag]) => {
    P(K, `lamp_${tag}`, () => acornColumn(h, tag === 'park' ? 51 : 61), 'pole_green');
    P(K, `lamp_${tag}_globe`, () => {
      const g = acornGlobe();
      g.translate(0, h - 0.30, 0);
      return g;
    }, 'sodium_lamp', { castShadow: false, noShadow: true });
    P(K, `lamp_${tag}_glow`, () => {
      const g = lightPool(3.6);
      g.translate(0, 0.02, 0);
      return g;
    }, 'sodium_glow', { castShadow: false, noShadow: true, noPrepass: true, renderOrder: 4 });
  });
}

/* ====================================================================== */
/* TRAFFIC SIGNALS                                                        */
/* ====================================================================== */

function signalHead(lenses = 3) {
  const parts = [];
  const h = 0.30 * lenses + 0.10;
  parts.push([chamferBox(0.30, h, 0.22, 0.015), newTrs(0, 0, 0)]);
  for (let i = 0; i < lenses; i++) {
    const y = 0.05 + 0.30 * i + 0.15;
    // visor: a half-tube hood over each lens
    const v = new THREE.CylinderGeometry(0.135, 0.135, 0.17, 10, 1, true, Math.PI * 0.05, Math.PI * 0.9);
    v.rotateX(Math.PI / 2);
    parts.push([v, newTrs(0, y, 0.20)]);
    parts.push([cyl(0.125, 0.125, 0.03, 10), newTrs(0, y - 0.015, 0.115, 0, 1, 1, 1, Math.PI / 2)]);
  }
  const g = combine(parts, 'sighead');
  weather(g, { grimeBase: 0.65, grimeHeight: 1.0, wear: 0.4, up: 0.55, seed: 7 });
  return g;
}

export function registerSignals(K) {
  P(K, 'signal_post', () => {
    const parts = [];
    parts.push([cyl(0.10, 0.135, 0.28, 10), null]);
    parts.push([cyl(0.075, 0.098, 5.6, 10), newTrs(0, 0.28, 0)]);
    // mast arm reaching over the carriageway
    const pts = [];
    for (let i = 0; i <= 6; i++) {
      const t = i / 6;
      pts.push({ x: t * 5.4, y: 5.88 + Math.sin(t * 1.2) * 0.18, z: 0 });
    }
    parts.push([tube(pts, 0.055, 6, { taper: 0.7 }), null]);
    // the tie-back cable bracket
    parts.push([box(0.06, 0.5, 0.06), newTrs(0, 5.4, 0)]);
    const g = combine(parts, 'sigpost');
    weather(g, { grimeBase: 0.6, grimeHeight: 2.2, wear: 0.5, seed: 17 });
    return g;
  }, 'pole_dark');

  P(K, 'signal_head_main', () => {
    const g = signalHead(3);
    g.translate(3.9, 5.0, 0);
    return g;
  }, 'pole_dark');
  P(K, 'signal_head_side', () => {
    const g = signalHead(3);
    g.translate(0.34, 3.1, 0.0);
    return g;
  }, 'pole_dark');

  // The lit lens: one per head, placed by the caller according to phase.
  for (const [tag, y] of [['red', 0.80], ['amber', 0.50], ['green', 0.20]]) {
    P(K, `signal_lit_${tag}_main`, () => {
      const g = new THREE.SphereGeometry(0.115, 10, 6, 0, TAU, 0, Math.PI * 0.55);
      g.rotateX(Math.PI / 2);
      g.translate(3.9, 5.0 + y, 0.115);
      return g;
    }, `signal_${tag}`, { castShadow: false, noShadow: true });
    P(K, `signal_lit_${tag}_side`, () => {
      const g = new THREE.SphereGeometry(0.115, 10, 6, 0, TAU, 0, Math.PI * 0.55);
      g.rotateX(Math.PI / 2);
      g.translate(0.34, 3.1 + y, 0.115);
      return g;
    }, `signal_${tag}`, { castShadow: false, noShadow: true });
  }

  // Pedestrian signal + push button, on its own short post.
  P(K, 'ped_signal', () => {
    const parts = [];
    parts.push([cyl(0.055, 0.07, 2.8, 8), null]);
    parts.push([chamferBox(0.26, 0.32, 0.18, 0.012), newTrs(0, 2.45, 0.08)]);
    parts.push([box(0.10, 0.14, 0.05), newTrs(0, 1.05, 0.09)]);
    const g = combine(parts, 'pedsig');
    weather(g, { grimeBase: 0.7, grimeHeight: 1.6, wear: 0.55, seed: 23 });
    return g;
  }, 'pole_dark');
  P(K, 'ped_signal_lens', () => {
    const g = card(0.20, 0.24);
    g.translate(0, 2.47, 0.175);
    return g;
  }, 'signal_red', { castShadow: false, noShadow: true });
}

/* ====================================================================== */
/* ROAD SIGNS + STREET NAME BLADES                                        */
/* ====================================================================== */

function signPost(h, r = 0.028) {
  const g = cyl(r, r * 1.08, h, 6);
  weather(g, { grimeBase: 0.68, grimeHeight: 1.4, wear: 0.6, seed: 29 });
  return g;
}

/** A sign face: a plate with a rolled edge, slightly bowed and never square. */
function signFace(w, h, opts = {}) {
  const g = new THREE.BoxGeometry(w, h, 0.012, 2, 2, 1);
  // bow the plate a little — a flat plate is a tell
  const pos = g.getAttribute('position');
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i) / (w * 0.5);
    pos.setZ(i, pos.getZ(i) + (1 - x * x) * (opts.bow ?? 0.006));
  }
  g.computeVertexNormals();
  paint(g, (x, y, z, nx, ny, nz) => {
    const edge = Math.max(Math.abs(x) / (w * 0.5), Math.abs(y) / (h * 0.5));
    const w2 = clamp01((edge - 0.72) / 0.28) * 0.85 + 0.1;
    const g2 = 0.30 + (ny > 0.4 ? 0.45 : 0) + clamp01(0.5 - y / h) * 0.35;
    return [w2, g2, 0.1];
  });
  return g;
}

function octagon(r) {
  const g = new THREE.CylinderGeometry(r, r, 0.012, 8, 1);
  g.rotateX(Math.PI / 2);
  g.rotateZ(Math.PI / 8);
  paint(g, (x, y) => [0.6 + 0.35 * clamp01(Math.hypot(x, y) / r - 0.6), 0.35, 0.1]);
  return g;
}

function diamond(r) {
  const g = new THREE.CylinderGeometry(r, r, 0.012, 4, 1);
  g.rotateX(Math.PI / 2);
  paint(g, (x, y) => [0.6 + 0.3 * clamp01(Math.hypot(x, y) / r - 0.6), 0.35, 0.1]);
  return g;
}

export function registerSigns(K) {
  // STOP — octagon on a short post.
  P(K, 'sign_stop', () => signPost(2.3), 'pole_grey');
  P(K, 'sign_stop_face', () => {
    const g = octagon(0.42);
    g.translate(0, 2.05, 0.022);
    return g;
  }, 'sign_red');

  // Warning diamond.
  P(K, 'sign_warn', () => signPost(2.5), 'pole_grey');
  P(K, 'sign_warn_face', () => {
    const g = diamond(0.44);
    g.translate(0, 2.2, 0.022);
    return g;
  }, 'sign_amber');

  // Regulatory white plate (no parking / speed limit).
  P(K, 'sign_reg', () => signPost(2.6), 'pole_grey');
  P(K, 'sign_reg_face', () => {
    const g = signFace(0.46, 0.62);
    g.translate(0, 2.15, 0.022);
    return g;
  }, 'sign_white');
  P(K, 'sign_reg_face2', () => {
    const a = signFace(0.46, 0.62);
    a.translate(0, 2.15, 0.022);
    const b = signFace(0.44, 0.30);
    b.translate(0, 1.66, 0.022);
    return combine([[a, null], [b, null]], 'reg2');
  }, 'sign_white');

  // One-way / directional blade.
  P(K, 'sign_oneway_face', () => {
    const g = signFace(0.92, 0.28);
    g.translate(0, 2.35, 0.022);
    return g;
  }, 'sign_white');

  // Street name blades — two, crossed, on a cast bracket at the corner.
  P(K, 'sign_street_post', () => {
    const parts = [];
    parts.push([cyl(0.038, 0.05, 3.1, 8), null]);
    parts.push([cyl(0.06, 0.06, 0.10, 8), newTrs(0, 2.86, 0)]);
    parts.push([lathe([[0.05, 0], [0.075, 0.03], [0.03, 0.09], [0, 0.12]], 8), newTrs(0, 3.1, 0)]);
    const g = combine(parts, 'streetpost');
    weather(g, { grimeBase: 0.65, grimeHeight: 1.8, wear: 0.6, seed: 37 });
    return g;
  }, 'pole_green');
  P(K, 'sign_street_blades', () => {
    const a = signFace(1.05, 0.20, { bow: 0.004 });
    a.translate(0, 2.92, 0);
    const b = signFace(1.05, 0.20, { bow: 0.004 });
    b.rotateY(Math.PI / 2);
    b.translate(0, 2.68, 0);
    return combine([[a, null], [b, null]], 'blades');
  }, 'sign_green');

  // Parking-restriction plate stack on a lamp column (no post of its own).
  P(K, 'sign_plate_small', () => {
    const g = signFace(0.30, 0.44);
    return g;
  }, 'sign_white');

  // A big overhead guide sign on two posts — arterial approaches.
  P(K, 'sign_guide_posts', () => {
    const a = signPost(3.4, 0.05);
    a.translate(-0.95, 0, 0);
    const b = signPost(3.4, 0.05);
    b.translate(0.95, 0, 0);
    return combine([[a, null], [b, null]], 'guideposts');
  }, 'pole_grey');
  P(K, 'sign_guide_face', () => {
    const g = signFace(2.5, 0.9, { bow: 0.012 });
    g.translate(0, 2.85, 0.03);
    const rib = box(2.5, 0.05, 0.05);
    return combine([[g, null], [rib, newTrs(0, 2.38, 0.04)]], 'guideface');
  }, 'sign_green');
}

/* ====================================================================== */
/* SMALL FURNITURE                                                        */
/* ====================================================================== */

export function registerFurniture(K) {
  /* ---- parking meters ------------------------------------------------ */
  P(K, 'meter_single', () => {
    const parts = [];
    parts.push([cyl(0.032, 0.042, 1.02, 8), null]);
    parts.push([chamferBox(0.14, 0.30, 0.11, 0.012), newTrs(0, 1.00, 0)]);
    parts.push([box(0.10, 0.13, 0.02), newTrs(0, 1.14, 0.062)]);
    parts.push([cyl(0.021, 0.021, 0.03, 8), newTrs(0, 1.05, 0.06, 0, 1, 1, 1, Math.PI / 2)]);
    const g = combine(parts, 'meter');
    weather(g, { grimeBase: 0.7, grimeHeight: 1.1, wear: 0.6, seed: 41 });
    return g;
  }, 'pole_grey');
  P(K, 'meter_twin', () => {
    const parts = [];
    parts.push([cyl(0.034, 0.046, 1.06, 8), null]);
    parts.push([chamferBox(0.26, 0.28, 0.11, 0.012), newTrs(0, 1.03, 0)]);
    parts.push([box(0.09, 0.12, 0.02), newTrs(-0.06, 1.16, 0.062)]);
    parts.push([box(0.09, 0.12, 0.02), newTrs(0.06, 1.16, 0.062)]);
    const g = combine(parts, 'metertwin');
    weather(g, { grimeBase: 0.7, grimeHeight: 1.1, wear: 0.6, seed: 43 });
    return g;
  }, 'pole_dark');
  P(K, 'meter_kiosk', () => {
    const parts = [];
    parts.push([chamferBox(0.34, 1.35, 0.24, 0.02), null]);
    parts.push([box(0.30, 0.02, 0.22), newTrs(0, 1.30, 0.02, 0, 1, 1, 1, -0.25)]);
    parts.push([box(0.22, 0.26, 0.02), newTrs(0, 1.06, 0.13)]);
    parts.push([cyl(0.06, 0.06, 0.05, 8), newTrs(0, 0.0, 0)]);
    const g = combine(parts, 'kiosk');
    weather(g, { grimeBase: 0.72, grimeHeight: 1.4, wear: 0.5, seed: 47 });
    return g;
  }, 'pole_dark');

  /* ---- hydrants ------------------------------------------------------- */
  const hydrant = (seed) => {
    const parts = [];
    parts.push([lathe([
      [0.20, 0], [0.20, 0.05], [0.155, 0.08], [0.145, 0.14],
      [0.175, 0.17], [0.135, 0.21], [0.125, 0.52], [0.155, 0.56],
      [0.16, 0.60], [0.115, 0.63], [0.10, 0.70], [0.055, 0.76], [0.0, 0.79],
    ], 10), null]);
    // two side outlets and the pumper on the front, each with a cap and chain
    for (const [a, r] of [[0, 0.10], [Math.PI, 0.075], [Math.PI / 2, 0.075]]) {
      const ox = Math.cos(a) * 0.12;
      const oz = Math.sin(a) * 0.12;
      parts.push([cyl(r, r * 1.1, 0.11, 8), newTrs(ox, 0.40, oz, 0, 1, 1, 1, 0, a === 0 ? -Math.PI / 2 : Math.PI / 2)]);
      parts.push([lathe([[r * 1.05, 0], [r * 1.15, 0.02], [r * 0.7, 0.05], [0, 0.06]], 8),
        newTrs(ox * 1.9, 0.40, oz * 1.9, a === Math.PI / 2 ? Math.PI / 2 : 0, 1, 1, 1, 0, a === 0 ? -Math.PI / 2 : Math.PI / 2)]);
    }
    parts.push([lathe([[0.055, 0], [0.075, 0.02], [0.05, 0.06]], 6), newTrs(0, 0.79, 0)]);
    const g = combine(parts, 'hydrant');
    weather(g, { grimeBase: 0.62, grimeHeight: 0.85, wear: 0.8, seed, wearY: [0.05, 0.8], up: 0.4 });
    return g;
  };
  P(K, 'hydrant_a', () => hydrant(53), 'plastic_red');
  P(K, 'hydrant_b', () => {
    const g = hydrant(59);
    g.scale(1.05, 0.92, 1.05);
    return g;
  }, 'sign_amber');

  /* ---- post boxes ----------------------------------------------------- */
  P(K, 'postbox_us', () => {
    const parts = [];
    const w = 0.52;
    const d = 0.46;
    const bodyH = 0.72;
    parts.push([chamferBox(w, bodyH, d, 0.015), newTrs(0, 0.34, 0)]);
    // domed lid
    const lid = new THREE.CylinderGeometry(w / 2, w / 2, d, 10, 1, false, 0, Math.PI);
    lid.rotateZ(Math.PI / 2);
    lid.rotateY(Math.PI / 2);
    parts.push([lid, newTrs(0, 0.34 + bodyH, 0)]);
    parts.push([box(0.30, 0.14, 0.04), newTrs(0, 0.98, d / 2 + 0.01, 0, 1, 1, 1, -0.35)]);
    parts.push([box(0.10, 0.34, 0.10), newTrs(-0.14, 0, 0)]);
    parts.push([box(0.10, 0.34, 0.10), newTrs(0.14, 0, 0)]);
    const g = combine(parts, 'postbox');
    dent(g, [[0.2, 0.5, 0.2, 0.28, 1], [-0.24, 0.72, -0.1, 0.22, 0.7]], 0.03);
    weather(g, { grimeBase: 0.6, grimeHeight: 1.2, wear: 0.7, seed: 61, up: 0.5 });
    return g;
  }, 'plastic_blue');
  P(K, 'postbox_relay', () => {
    const parts = [];
    parts.push([chamferBox(0.44, 1.20, 0.40, 0.015), newTrs(0, 0.12, 0)]);
    parts.push([box(0.42, 0.05, 0.38), newTrs(0, 1.32, 0, 0, 1, 1, 1, -0.12)]);
    parts.push([box(0.08, 0.12, 0.08), newTrs(-0.13, 0, 0)]);
    parts.push([box(0.08, 0.12, 0.08), newTrs(0.13, 0, 0)]);
    const g = combine(parts, 'relaybox');
    dent(g, [[0.18, 0.7, 0.2, 0.3, 1]], 0.025);
    weather(g, { grimeBase: 0.7, grimeHeight: 1.3, wear: 0.75, seed: 67, up: 0.5 });
    return g;
  }, 'pole_green');

  /* ---- litter bins ---------------------------------------------------- */
  P(K, 'bin_mesh', () => {
    const parts = [];
    // a wire-mesh basket read as vertical staves on two hoops
    for (let i = 0; i < 14; i++) {
      const a = (i / 14) * TAU;
      parts.push([box(0.016, 0.72, 0.016), newTrs(Math.cos(a) * 0.235, 0.14, Math.sin(a) * 0.235, -a)]);
    }
    parts.push([new THREE.TorusGeometry(0.235, 0.016, 4, 12), newTrs(0, 0.18, 0, 0, 1, 1, 1, Math.PI / 2)]);
    parts.push([new THREE.TorusGeometry(0.235, 0.016, 4, 12), newTrs(0, 0.80, 0, 0, 1, 1, 1, Math.PI / 2)]);
    parts.push([new THREE.TorusGeometry(0.26, 0.024, 4, 12), newTrs(0, 0.86, 0, 0, 1, 1, 1, Math.PI / 2)]);
    parts.push([cyl(0.23, 0.23, 0.02, 12), newTrs(0, 0.12, 0)]);
    parts.push([cyl(0.05, 0.06, 0.14, 6), null]);
    const g = combine(parts, 'binmesh');
    weather(g, { grimeBase: 0.8, grimeHeight: 1.0, wear: 0.6, seed: 71, up: 0.5 });
    return g;
  }, 'pole_dark');

  P(K, 'bin_drum', () => {
    const g = cyl(0.30, 0.28, 0.88, 12);
    dent(g, [[0.28, 0.5, 0.05, 0.3, 1], [-0.2, 0.3, 0.22, 0.26, 0.8], [0.05, 0.72, -0.28, 0.22, 0.6]], 0.045);
    const rim = new THREE.TorusGeometry(0.305, 0.022, 4, 14);
    const hoop1 = new THREE.TorusGeometry(0.30, 0.018, 4, 14);
    const hoop2 = new THREE.TorusGeometry(0.29, 0.018, 4, 14);
    const out = combine([
      [g, null],
      [rim, newTrs(0, 0.87, 0, 0, 1, 1, 1, Math.PI / 2)],
      [hoop1, newTrs(0, 0.32, 0, 0, 1, 1, 1, Math.PI / 2)],
      [hoop2, newTrs(0, 0.60, 0, 0, 1, 1, 1, Math.PI / 2)],
    ], 'bindrum');
    weather(out, { grimeBase: 0.9, grimeHeight: 1.1, wear: 0.8, seed: 73, up: 0.6 });
    return out;
  }, 'rust');

  P(K, 'bin_wheelie', () => {
    const parts = [];
    const body = extrude(
      [[-0.29, -0.24], [0.29, -0.24], [0.31, 0.25], [-0.31, 0.25]],
      1.02, { topScale: 1.06 }
    );
    parts.push([body, null]);
    parts.push([box(0.64, 0.05, 0.54), newTrs(0, 1.05, 0.0, 0, 1, 1, 1, -0.06)]);
    parts.push([box(0.60, 0.03, 0.06), newTrs(0, 1.09, -0.26)]);
    parts.push([cyl(0.085, 0.085, 0.05, 8), newTrs(-0.26, 0.085, -0.20, 0, 1, 1, 1, 0, Math.PI / 2)]);
    parts.push([cyl(0.085, 0.085, 0.05, 8), newTrs(0.26, 0.085, -0.20, 0, 1, 1, 1, 0, Math.PI / 2)]);
    const g = combine(parts, 'wheelie');
    dent(g, [[0.3, 0.55, 0.1, 0.3, 1]], 0.02);
    weather(g, { grimeBase: 0.78, grimeHeight: 1.2, wear: 0.4, seed: 79, up: 0.55 });
    return g;
  }, 'plastic_green');

  P(K, 'bin_concrete', () => {
    const g = extrude(ngon(12, 0.34, { wob: 0.03, seed: 5 }), 0.82, { topScale: 0.94, floor: true, floorY: 0.62 });
    weather(g, { grimeBase: 0.85, grimeHeight: 1.0, wear: 0.7, seed: 83, up: 0.6 });
    return g;
  }, 'concrete_prop');

  /* ---- benches -------------------------------------------------------- */
  P(K, 'bench_slat', () => {
    const parts = [];
    for (let i = 0; i < 5; i++) {
      parts.push([box(1.82, 0.038, 0.105), newTrs(0, 0.42 + i * 0.001, -0.22 + i * 0.115)]);
    }
    for (let i = 0; i < 4; i++) {
      parts.push([box(1.82, 0.105, 0.036), newTrs(0, 0.52 + i * 0.115, 0.26, 0, 1, 1, 1, -0.22)]);
    }
    const g = combine(parts, 'benchslats');
    weather(g, { grimeBase: 0.6, grimeHeight: 1.0, wear: 0.85, seed: 89, up: 0.6, wearY: [0.3, 1.0] });
    return g;
  }, 'wood_grey');
  P(K, 'bench_ends', () => {
    const end = (s) => {
      const parts = [];
      parts.push([box(0.055, 0.44, 0.10), newTrs(0, 0, -0.20)]);
      parts.push([box(0.055, 0.44, 0.10), newTrs(0, 0, 0.22)]);
      parts.push([box(0.055, 0.06, 0.56), newTrs(0, 0.42, 0.02)]);
      parts.push([box(0.05, 0.55, 0.06), newTrs(0, 0.46, 0.28, 0, 1, 1, 1, -0.22)]);
      parts.push([box(0.10, 0.03, 0.24), newTrs(0, 0.0, -0.20)]);
      parts.push([box(0.10, 0.03, 0.24), newTrs(0, 0.0, 0.22)]);
      const g = combine(parts, 'benchend');
      g.translate(s * 0.86, 0, 0);
      return g;
    };
    const g = combine([[end(-1), null], [end(1), null]], 'benchends');
    weather(g, { grimeBase: 0.75, grimeHeight: 0.9, wear: 0.7, seed: 97 });
    return g;
  }, 'pole_dark');

  P(K, 'bench_concrete', () => {
    const parts = [];
    parts.push([chamferBox(1.9, 0.14, 0.48, 0.02), newTrs(0, 0.40, 0)]);
    parts.push([chamferBox(0.22, 0.40, 0.42, 0.02), newTrs(-0.72, 0, 0)]);
    parts.push([chamferBox(0.22, 0.40, 0.42, 0.02), newTrs(0.72, 0, 0)]);
    const g = combine(parts, 'benchcon');
    weather(g, { grimeBase: 0.8, grimeHeight: 0.9, wear: 0.65, seed: 101, up: 0.5 });
    return g;
  }, 'concrete_prop');

  /* ---- bollards ------------------------------------------------------- */
  P(K, 'bollard_steel', () => {
    const g = lathe([[0.075, 0], [0.082, 0.03], [0.082, 0.86], [0.070, 0.92], [0.035, 0.95], [0, 0.96]], 10);
    weather(g, { grimeBase: 0.7, grimeHeight: 0.8, wear: 0.85, seed: 103, up: 0.4 });
    return g;
  }, 'pole_grey');
  P(K, 'bollard_iron', () => {
    const g = lathe([
      [0.11, 0], [0.115, 0.06], [0.085, 0.10], [0.078, 0.62],
      [0.098, 0.68], [0.092, 0.74], [0.06, 0.82], [0.03, 0.86], [0, 0.87],
    ], 10);
    weather(g, { grimeBase: 0.78, grimeHeight: 0.9, wear: 0.8, seed: 107, up: 0.45 });
    return g;
  }, 'pole_dark');
  P(K, 'bollard_concrete', () => {
    const g = extrude(ngon(10, 0.16, { wob: 0.02, seed: 9 }), 0.70, { topScale: 0.86 });
    weather(g, { grimeBase: 0.85, grimeHeight: 0.7, wear: 0.75, seed: 109, up: 0.6 });
    return g;
  }, 'concrete_prop');
  P(K, 'bollard_flex', () => {
    const g = cyl(0.045, 0.055, 0.86, 8);
    const band = cyl(0.052, 0.052, 0.07, 8);
    const out = combine([[g, null], [band, newTrs(0, 0.62, 0)]], 'flexbol');
    weather(out, { grimeBase: 0.7, grimeHeight: 0.6, wear: 0.5, seed: 113 });
    return out;
  }, 'plastic_red');

  /* ---- guard railing (a 2 m section) ---------------------------------- */
  P(K, 'rail_guard', () => {
    const parts = [];
    parts.push([cyl(0.028, 0.032, 1.06, 6), newTrs(-1.0, 0, 0)]);
    parts.push([cyl(0.028, 0.032, 1.06, 6), newTrs(1.0, 0, 0)]);
    parts.push([cyl(0.024, 0.024, 2.0, 6), newTrs(0, 1.04, 0, 0, 1, 1, 1, 0, Math.PI / 2)]);
    parts.push([cyl(0.020, 0.020, 2.0, 6), newTrs(0, 0.62, 0, 0, 1, 1, 1, 0, Math.PI / 2)]);
    for (let i = 0; i < 7; i++) {
      parts.push([box(0.014, 0.42, 0.014), newTrs(-0.85 + i * 0.283, 0.62, 0)]);
    }
    const g = combine(parts, 'guardrail');
    weather(g, { grimeBase: 0.75, grimeHeight: 1.0, wear: 0.8, seed: 127 });
    return g;
  }, 'pole_grey');

  /* ---- phone boxes ---------------------------------------------------- */
  P(K, 'phone_hood', () => {
    const parts = [];
    parts.push([cyl(0.055, 0.07, 2.3, 8), null]);
    // an open acoustic half-shell
    const shell = new THREE.CylinderGeometry(0.42, 0.42, 1.0, 10, 1, true, -Math.PI * 0.55, Math.PI * 1.1);
    parts.push([shell, newTrs(0, 1.72, 0)]);
    const cap = new THREE.CylinderGeometry(0.44, 0.42, 0.06, 10, 1, false, -Math.PI * 0.55, Math.PI * 1.1);
    parts.push([cap, newTrs(0, 2.25, 0)]);
    parts.push([chamferBox(0.26, 0.52, 0.14, 0.01), newTrs(0, 1.32, -0.24)]);
    const g = combine(parts, 'phonehood');
    weather(g, { grimeBase: 0.72, grimeHeight: 1.6, wear: 0.7, seed: 131, up: 0.5 });
    return g;
  }, 'pole_grey');

  P(K, 'phone_booth_frame', () => {
    const parts = [];
    const w = 0.92;
    const d = 0.92;
    const h = 2.42;
    for (const [sx, sz] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) {
      parts.push([box(0.075, h, 0.075), newTrs(sx * (w / 2 - 0.04), 0, sz * (d / 2 - 0.04))]);
    }
    parts.push([box(w, 0.10, d), newTrs(0, h, 0)]);
    parts.push([box(w + 0.10, 0.14, d + 0.10), newTrs(0, h + 0.10, 0)]);
    parts.push([box(w, 0.09, d), newTrs(0, 0, 0)]);
    // mullions
    for (const s of [-1, 1]) {
      parts.push([box(0.05, h - 0.2, 0.05), newTrs(s * 0.02, 0.1, d / 2 - 0.04)]);
    }
    parts.push([box(0.30, 0.42, 0.10), newTrs(0.14, 1.10, -d / 2 + 0.10)]);
    const g = combine(parts, 'boothframe');
    weather(g, { grimeBase: 0.75, grimeHeight: 2.0, wear: 0.7, seed: 137, up: 0.5 });
    return g;
  }, 'sign_red');
  P(K, 'phone_booth_glass', () => {
    const parts = [];
    const w = 0.86;
    const d = 0.86;
    for (let i = 0; i < 4; i++) {
      const a = (i / 4) * TAU;
      const g2 = card(w - 0.14, 1.95);
      g2.translate(0, 0.30, 0);
      parts.push([g2, newTrs(Math.sin(a) * (d / 2), 0, Math.cos(a) * (d / 2), a)]);
    }
    return combine(parts, 'boothglass');
  }, 'glass_prop', { castShadow: false, noShadow: true, noPrepass: true, renderOrder: 1 });

  /* ---- newspaper boxes (a rack of them) -------------------------------- */
  const newsbox = (w, h, d) => {
    const parts = [];
    parts.push([chamferBox(w, h, d, 0.012), newTrs(0, 0.28, 0)]);
    parts.push([box(w * 0.82, h * 0.42, 0.02), newTrs(0, 0.28 + h * 0.62, d / 2 + 0.005)]);
    parts.push([box(w, 0.04, d), newTrs(0, 0.28 + h, 0, 0, 1, 1, 1, -0.15)]);
    parts.push([box(0.045, 0.28, 0.045), newTrs(-w / 2 + 0.05, 0, -d / 2 + 0.05)]);
    parts.push([box(0.045, 0.28, 0.045), newTrs(w / 2 - 0.05, 0, -d / 2 + 0.05)]);
    parts.push([box(0.045, 0.28, 0.045), newTrs(-w / 2 + 0.05, 0, d / 2 - 0.05)]);
    parts.push([box(0.045, 0.28, 0.045), newTrs(w / 2 - 0.05, 0, d / 2 - 0.05)]);
    const g = combine(parts, 'newsbox');
    dent(g, [[w * 0.4, 0.6, d * 0.5, 0.24, 1]], 0.02);
    weather(g, { grimeBase: 0.78, grimeHeight: 1.0, wear: 0.65, seed: 139, up: 0.55 });
    return g;
  };
  P(K, 'newsbox_a', () => newsbox(0.46, 0.68, 0.40), 'plastic_red');
  P(K, 'newsbox_b', () => newsbox(0.42, 0.62, 0.38), 'plastic_blue');
  P(K, 'newsbox_c', () => newsbox(0.44, 0.66, 0.38), 'sign_amber');
  P(K, 'newsbox_d', () => newsbox(0.40, 0.60, 0.36), 'plastic_green');

  /* ---- cellar hatch / coal plate --------------------------------------- */
  P(K, 'hatch_twin', () => {
    const parts = [];
    for (const s of [-1, 1]) {
      const leaf = box(0.62, 0.045, 0.96);
      parts.push([leaf, newTrs(s * 0.33, 0, 0)]);
      // diamond tread: a coarse grid of little pyramids read as ribs
      for (let i = 0; i < 4; i++) {
        parts.push([box(0.56, 0.012, 0.03), newTrs(s * 0.33, 0.045, -0.34 + i * 0.23)]);
      }
    }
    parts.push([box(1.42, 0.05, 1.06), newTrs(0, -0.02, 0)]);
    const g = combine(parts, 'hatch');
    weather(g, { grimeBase: 0.9, grimeHeight: 0.35, wear: 0.9, seed: 149, up: 0.8 });
    return g;
  }, 'steel');
  P(K, 'hatch_round', () => {
    const parts = [];
    parts.push([cyl(0.36, 0.38, 0.05, 12), newTrs(0, -0.02, 0)]);
    parts.push([cyl(0.32, 0.32, 0.03, 12), newTrs(0, 0.02, 0)]);
    for (let i = 0; i < 6; i++) {
      const a = (i / 6) * TAU;
      parts.push([box(0.24, 0.012, 0.045), newTrs(Math.cos(a) * 0.14, 0.05, Math.sin(a) * 0.14, -a)]);
    }
    const g = combine(parts, 'hatchround');
    weather(g, { grimeBase: 0.92, grimeHeight: 0.3, wear: 0.85, seed: 151, up: 0.85 });
    return g;
  }, 'steel');

  /* ---- standpipe / siamese fire connection ----------------------------- */
  P(K, 'standpipe', () => {
    const parts = [];
    parts.push([cyl(0.055, 0.06, 1.05, 8), null]);
    parts.push([cyl(0.05, 0.05, 0.34, 8), newTrs(0, 1.05, 0, 0, 1, 1, 1, 0, Math.PI / 2)]);
    for (const s of [-1, 1]) {
      parts.push([cyl(0.075, 0.08, 0.12, 8), newTrs(s * 0.17, 1.05, 0.03, 0, 1, 1, 1, Math.PI / 2)]);
      parts.push([lathe([[0.082, 0], [0.09, 0.02], [0.05, 0.05], [0, 0.055]], 8),
        newTrs(s * 0.17, 1.05, 0.10, 0, 1, 1, 1, Math.PI / 2)]);
    }
    parts.push([box(0.34, 0.18, 0.02), newTrs(0, 1.30, 0)]);
    const g = combine(parts, 'standpipe');
    weather(g, { grimeBase: 0.75, grimeHeight: 1.3, wear: 0.8, seed: 157 });
    return g;
  }, 'sign_red');

  /* ---- utility cabinet (the one that always has stickers on it) -------- */
  P(K, 'cabinet_util', () => {
    const parts = [];
    parts.push([chamferBox(0.92, 1.34, 0.46, 0.02), newTrs(0, 0.08, 0)]);
    parts.push([box(0.98, 0.05, 0.52), newTrs(0, 1.42, 0, 0, 1, 1, 1, -0.05)]);
    parts.push([chamferBox(1.00, 0.10, 0.54, 0.015), newTrs(0, 0, 0)]);
    // louvres
    for (let i = 0; i < 5; i++) {
      parts.push([box(0.66, 0.02, 0.02), newTrs(0, 0.55 + i * 0.09, 0.235, 0, 1, 1, 1, -0.3)]);
    }
    parts.push([box(0.05, 0.10, 0.03), newTrs(0.34, 0.75, 0.24)]);
    const g = combine(parts, 'cabinet');
    dent(g, [[0.4, 0.9, 0.24, 0.34, 1]], 0.02);
    weather(g, { grimeBase: 0.8, grimeHeight: 1.6, wear: 0.7, seed: 163, up: 0.6 });
    return g;
  }, 'pole_green');

  /* ---- ground-level air-conditioning condenser ------------------------- */
  P(K, 'aircon_ground', () => {
    const parts = [];
    parts.push([chamferBox(0.78, 0.66, 0.42, 0.015), newTrs(0, 0.12, 0)]);
    // fan grille as concentric rings
    for (let i = 1; i <= 3; i++) {
      const r = 0.06 + i * 0.055;
      parts.push([new THREE.TorusGeometry(r, 0.008, 3, 12), newTrs(0, 0.46, 0.215, 0, 1, 1, 1, Math.PI / 2)]);
    }
    parts.push([box(0.02, 0.36, 0.02), newTrs(0, 0.46, 0.215)]);
    parts.push([box(0.36, 0.02, 0.02), newTrs(0, 0.46, 0.215)]);
    // fins on the side
    for (let i = 0; i < 10; i++) {
      parts.push([box(0.012, 0.52, 0.38), newTrs(-0.39 + i * 0.004, 0.18, 0)]);
    }
    parts.push([box(0.9, 0.10, 0.5), newTrs(0, 0, 0)]);
    parts.push([cyl(0.028, 0.028, 0.5, 6), newTrs(0.30, 0.30, -0.24)]);
    const g = combine(parts, 'aircon');
    dent(g, [[0.3, 0.5, 0.2, 0.3, 1]], 0.015);
    weather(g, { grimeBase: 0.85, grimeHeight: 1.4, wear: 0.7, seed: 167, up: 0.7 });
    return g;
  }, 'galv');

  /* ---- bus shelter ---------------------------------------------------- */
  P(K, 'shelter_frame', () => {
    const parts = [];
    const W = 3.9;
    const D = 1.5;
    const H = 2.42;
    for (const x of [-W / 2 + 0.08, W / 2 - 0.08]) {
      parts.push([box(0.09, H, 0.11), newTrs(x, 0, -D / 2 + 0.06)]);
      parts.push([box(0.09, H, 0.11), newTrs(x, 0, D / 2 - 0.06)]);
    }
    parts.push([box(0.09, H, 0.11), newTrs(0, 0, -D / 2 + 0.06)]);
    // roof: a shallow single-pitch canopy on two purlins
    parts.push([box(W + 0.26, 0.07, D + 0.34), newTrs(0, H + 0.10, 0.04, 0, 1, 1, 1, -0.05)]);
    parts.push([box(W, 0.10, 0.10), newTrs(0, H, -D / 2 + 0.06)]);
    parts.push([box(W, 0.10, 0.10), newTrs(0, H, D / 2 - 0.06)]);
    parts.push([box(W - 0.2, 0.05, 0.28), newTrs(0, H - 0.16, -D / 2 + 0.06)]);
    // bench inside
    parts.push([box(2.3, 0.06, 0.34), newTrs(0.5, 0.46, -D / 2 + 0.28)]);
    parts.push([box(0.07, 0.46, 0.30), newTrs(-0.6, 0, -D / 2 + 0.28)]);
    parts.push([box(0.07, 0.46, 0.30), newTrs(1.6, 0, -D / 2 + 0.28)]);
    // pole for the flag / timetable
    parts.push([cyl(0.05, 0.055, 3.1, 8), newTrs(W / 2 + 0.30, 0, 0)]);
    const g = combine(parts, 'shelter');
    weather(g, { grimeBase: 0.72, grimeHeight: 2.2, wear: 0.6, seed: 173, up: 0.6 });
    return g;
  }, 'pole_dark');
  P(K, 'shelter_glass', () => {
    const parts = [];
    const W = 3.9;
    const D = 1.5;
    const back = card(W - 0.3, 2.0);
    back.translate(0, 0.24, -D / 2 + 0.06);
    parts.push([back, null]);
    const side = card(D - 0.2, 2.0);
    side.rotateY(Math.PI / 2);
    side.translate(-W / 2 + 0.08, 0.24, 0);
    parts.push([side, null]);
    return combine(parts, 'shelterglass');
  }, 'glass_prop', { castShadow: false, noShadow: true, noPrepass: true, renderOrder: 1 });
  P(K, 'shelter_ad', () => {
    const g = card(1.20, 1.78);
    g.translate(1.28, 0.30, 0.79);
    g.rotateY(0);
    return g;
  }, 'shop_lit', { castShadow: false, noShadow: true });
  P(K, 'shelter_flag', () => {
    const parts = [];
    parts.push([box(0.46, 0.60, 0.03), newTrs(3.25, 2.55, 0)]);
    parts.push([box(0.30, 0.44, 0.02), newTrs(3.25, 1.60, 0.03)]);
    return combine(parts, 'shelterflag');
  }, 'sign_blue');

  /* ---- tree pit grate -------------------------------------------------- */
  P(K, 'tree_grate', () => {
    const parts = [];
    const R = 0.78;
    parts.push([new THREE.RingGeometry(0.20, R, 16, 1).rotateX(-Math.PI / 2), null]);
    parts.push([new THREE.TorusGeometry(R, 0.035, 4, 18), newTrs(0, 0.01, 0, 0, 1, 1, 1, Math.PI / 2)]);
    for (let i = 0; i < 10; i++) {
      const a = (i / 10) * Math.PI;
      parts.push([box(R * 2 - 0.1, 0.02, 0.03), newTrs(0, 0.015, 0, a)]);
    }
    const g = combine(parts, 'treegrate');
    weather(g, { grimeBase: 0.95, grimeHeight: 0.3, wear: 0.7, seed: 179, up: 0.9 });
    return g;
  }, 'steel');

  /* ---- stoop: three steps and a handrail to a front door --------------- */
  P(K, 'stoop_steps', () => {
    const parts = [];
    for (let i = 0; i < 4; i++) {
      const w = 1.5 - i * 0.02;
      parts.push([chamferBox(w, 0.175, 1.15 - i * 0.28, 0.012), newTrs(0, i * 0.175, -(i * 0.14))]);
    }
    parts.push([chamferBox(1.62, 0.14, 1.32, 0.015), newTrs(0, -0.14, 0.05)]);
    const g = combine(parts, 'stoop');
    weather(g, { grimeBase: 0.75, grimeHeight: 0.9, wear: 0.85, seed: 191, up: 0.7 });
    return g;
  }, 'concrete_prop');
  P(K, 'stoop_rail', () => {
    const parts = [];
    for (const s of [-1, 1]) {
      const pts = [
        { x: s * 0.72, y: 0.0, z: 0.55 },
        { x: s * 0.72, y: 0.55, z: 0.36 },
        { x: s * 0.72, y: 0.95, z: 0.05 },
        { x: s * 0.72, y: 1.0, z: -0.42 },
      ];
      parts.push([tube(pts, 0.022, 5), null]);
      parts.push([cyl(0.02, 0.024, 0.5, 6), newTrs(s * 0.72, 0.0, 0.52)]);
      parts.push([cyl(0.02, 0.024, 0.4, 6), newTrs(s * 0.72, 0.6, -0.30)]);
    }
    const g = combine(parts, 'stooprail');
    weather(g, { grimeBase: 0.7, grimeHeight: 1.2, wear: 0.85, seed: 193 });
    return g;
  }, 'pole_dark');
}

export function registerStreetKit(K) {
  registerLamps(K);
  registerSignals(K);
  registerSigns(K);
  registerFurniture(K);
}
