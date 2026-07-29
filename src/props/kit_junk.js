import * as THREE from 'three';
import {
  Accum, box, chamferBox, cyl, card, ground, lathe, extrude, ngon, tube,
  combine, weather, paint, dent, newTrs, clamp01, lerp, TAU, hash3i, smoothNoise,
} from './geom.js';

/**
 * PROPS — litter and life.
 *
 * The layer that says somebody works here. GTA V's streets are full of things
 * that are in the way: a stack of pallets nobody has moved, a skip half full of
 * plasterboard, four cones round a hole, a bike chained to a rail with one
 * wheel missing. None of it is architecture and all of it is what makes the
 * frame read as a place.
 */

function P(K, id, factory, surface, opts) {
  K.proto(id, factory, surface, opts);
  return id;
}

export function registerJunkKit(K) {
  /* ---- refuse sacks: lumpy, slumped, never spherical ------------------ */
  for (let v = 0; v < 3; v++) {
    P(K, `binbag_${v}`, () => {
      const g = new THREE.SphereGeometry(0.34, 9, 7);
      const pos = g.getAttribute('position');
      for (let i = 0; i < pos.count; i++) {
        const x = pos.getX(i);
        const y = pos.getY(i);
        const z = pos.getZ(i);
        const n = smoothNoise(x * 5 + v * 9, z * 5 - y * 4);
        const k = 0.78 + n * 0.44;
        pos.setXYZ(i, x * k * 1.12, Math.max(-0.30, y * k * 0.78) + 0.30, z * k * 1.0);
      }
      g.computeVertexNormals();
      // the gathered neck at the top
      const neck = cyl(0.03, 0.09, 0.16, 6);
      const out = combine([[g, null], [neck, newTrs(0.04, 0.50, -0.03, 0, 1, 1, 1, 0.3, 0.2)]], 'binbag');
      weather(out, { grimeBase: 0.5, grimeHeight: 0.5, wear: 0.2, seed: 1001 + v, up: 0.3, down: 0.6 });
      return out;
    }, 'bag');
  }

  /* ---- pallets, crates, boxes ----------------------------------------- */
  P(K, 'pallet', () => {
    const parts = [];
    for (let i = 0; i < 7; i++) parts.push([box(1.18, 0.022, 0.095), newTrs(0, 0.122, -0.46 + i * 0.155)]);
    for (const z of [-0.44, 0, 0.44]) {
      parts.push([box(1.18, 0.075, 0.10), newTrs(0, 0.04, z)]);
      parts.push([box(1.18, 0.022, 0.10), newTrs(0, 0.0, z)]);
    }
    const g = combine(parts, 'pallet');
    weather(g, { grimeBase: 0.85, grimeHeight: 0.4, wear: 0.9, seed: 1013, up: 0.7 });
    return g;
  }, 'wood_grey');

  P(K, 'crate_wood', () => {
    const parts = [];
    const w = 0.62;
    const h = 0.46;
    const d = 0.44;
    for (let i = 0; i < 4; i++) {
      parts.push([box(w, 0.075, 0.02), newTrs(0, 0.05 + i * 0.115, d / 2)]);
      parts.push([box(w, 0.075, 0.02), newTrs(0, 0.05 + i * 0.115, -d / 2)]);
      parts.push([box(0.02, 0.075, d), newTrs(w / 2, 0.05 + i * 0.115, 0)]);
      parts.push([box(0.02, 0.075, d), newTrs(-w / 2, 0.05 + i * 0.115, 0)]);
    }
    for (const s of [-1, 1]) {
      parts.push([box(0.05, h, 0.05), newTrs(s * (w / 2 - 0.02), 0, d / 2 - 0.02)]);
      parts.push([box(0.05, h, 0.05), newTrs(s * (w / 2 - 0.02), 0, -d / 2 + 0.02)]);
    }
    parts.push([box(w - 0.04, 0.02, d - 0.04), newTrs(0, 0.02, 0)]);
    const g = combine(parts, 'crate');
    weather(g, { grimeBase: 0.8, grimeHeight: 0.5, wear: 0.9, seed: 1019, up: 0.6 });
    return g;
  }, 'wood_grey');

  P(K, 'crate_milk', () => {
    const parts = [];
    parts.push([extrude([[-0.16, -0.16], [0.16, -0.16], [0.16, 0.16], [-0.16, 0.16]], 0.28, { topScale: 1.06, floor: true, floorY: 0.03 }), null]);
    for (let i = 0; i < 3; i++) {
      parts.push([box(0.34, 0.015, 0.015), newTrs(0, 0.08 + i * 0.09, 0.165)]);
      parts.push([box(0.015, 0.015, 0.34), newTrs(0.165, 0.08 + i * 0.09, 0)]);
    }
    const g = combine(parts, 'milkcrate');
    weather(g, { grimeBase: 0.7, grimeHeight: 0.4, wear: 0.6, seed: 1021, up: 0.6 });
    return g;
  }, 'plastic_blue');

  P(K, 'box_card', () => {
    const g = chamferBox(0.5, 0.38, 0.4, 0.012);
    dent(g, [[0.2, 0.3, 0.18, 0.3, 1], [-0.24, 0.14, -0.1, 0.24, 0.7]], 0.035);
    const flap = box(0.46, 0.012, 0.2);
    const out = combine([[g, null], [flap, newTrs(0, 0.38, 0.14, 0, 1, 1, 1, -0.7)]], 'cardbox');
    weather(out, { grimeBase: 0.8, grimeHeight: 0.5, wear: 0.75, seed: 1031, up: 0.65, down: 0.5 });
    return out;
  }, 'cardboard');

  /* ---- cones, barriers, roadworks -------------------------------------- */
  P(K, 'cone', () => {
    const parts = [];
    parts.push([chamferBox(0.36, 0.035, 0.36, 0.01), null]);
    parts.push([lathe([[0.16, 0.02], [0.145, 0.10], [0.075, 0.42], [0.055, 0.58], [0.05, 0.62], [0.0, 0.65]], 8), null]);
    const g = combine(parts, 'cone');
    dent(g, [[0.12, 0.3, 0.05, 0.2, 1]], 0.02);
    weather(g, { grimeBase: 0.7, grimeHeight: 0.5, wear: 0.5, seed: 1033, up: 0.55 });
    return g;
  }, 'plastic_red');
  P(K, 'cone_band', () => {
    const g = lathe([[0.116, 0], [0.108, 0.12]], 8);
    g.translate(0, 0.26, 0);
    return g;
  }, 'sign_white');

  /** The plastic water-filled barrier, in 1.5 m units. */
  P(K, 'barrier_water', () => {
    const parts = [];
    parts.push([extrude([
      [-0.75, -0.20], [0.75, -0.20], [0.78, -0.10], [0.78, 0.10], [0.75, 0.20], [-0.75, 0.20], [-0.78, 0.10], [-0.78, -0.10],
    ], 0.86, { topScale: 0.72 }), null]);
    parts.push([box(0.10, 0.24, 0.46), newTrs(0.78, 0.30, 0)]);
    parts.push([cyl(0.05, 0.05, 0.10, 6), newTrs(0, 0.86, 0)]);
    const g = combine(parts, 'barrierwater');
    weather(g, { grimeBase: 0.8, grimeHeight: 0.8, wear: 0.5, seed: 1039, up: 0.6 });
    return g;
  }, 'plastic_red');

  /** A jersey barrier, concrete, chipped and settled. */
  P(K, 'barrier_jersey', () => {
    const g = extrude([
      [-1.5, -0.30], [1.5, -0.30], [1.5, -0.14], [1.42, -0.10],
      [1.42, 0.10], [1.5, 0.14], [1.5, 0.30], [-1.5, 0.30],
      [-1.5, 0.14], [-1.42, 0.10], [-1.42, -0.10], [-1.5, -0.14],
    ], 0.82, { topScale: 0.55 });
    weather(g, { grimeBase: 0.9, grimeHeight: 0.8, wear: 0.85, seed: 1049, up: 0.7 });
    return g;
  }, 'concrete_prop');

  /** Pedestrian barrier: the classic linked scaffolding fence panel. */
  P(K, 'barrier_ped', () => {
    const parts = [];
    parts.push([cyl(0.022, 0.026, 1.05, 6), newTrs(-1.05, 0, 0)]);
    parts.push([cyl(0.022, 0.026, 1.05, 6), newTrs(1.05, 0, 0)]);
    parts.push([box(0.34, 0.03, 0.24), newTrs(-1.05, 0, 0)]);
    parts.push([box(0.34, 0.03, 0.24), newTrs(1.05, 0, 0)]);
    parts.push([cyl(0.018, 0.018, 2.14, 6), newTrs(0, 1.02, 0, 0, 1, 1, 1, 0, Math.PI / 2)]);
    parts.push([cyl(0.018, 0.018, 2.14, 6), newTrs(0, 0.50, 0, 0, 1, 1, 1, 0, Math.PI / 2)]);
    for (let i = 0; i < 10; i++) parts.push([box(0.012, 0.52, 0.012), newTrs(-0.92 + i * 0.205, 0.50, 0)]);
    const g = combine(parts, 'pedbarrier');
    weather(g, { grimeBase: 0.8, grimeHeight: 0.9, wear: 0.8, seed: 1051 });
    return g;
  }, 'galv');

  /** The roadworks sign on its own A-frame stand. */
  P(K, 'works_sign', () => {
    const parts = [];
    for (const s of [-1, 1]) {
      parts.push([box(0.05, 1.1, 0.05), newTrs(s * 0.32, 0, s * 0.18, 0, 1, 1, 1, s * 0.24)]);
    }
    parts.push([box(0.86, 0.05, 0.05), newTrs(0, 0.45, 0)]);
    parts.push([box(0.10, 0.05, 0.62), newTrs(-0.32, 0.0, 0)]);
    parts.push([box(0.10, 0.05, 0.62), newTrs(0.32, 0.0, 0)]);
    const g = combine(parts, 'workstand');
    weather(g, { grimeBase: 0.8, grimeHeight: 0.9, wear: 0.8, seed: 1061 });
    return g;
  }, 'pole_grey');
  P(K, 'works_face', () => {
    const g = new THREE.CylinderGeometry(0.42, 0.42, 0.02, 4, 1);
    g.rotateX(Math.PI / 2);
    g.translate(0, 1.02, 0.02);
    paint(g, (x, y) => [0.7, 0.35, 0.1]);
    return g;
  }, 'sign_amber');

  /** A hole in the road with its spoil heap and a plank over it. */
  P(K, 'works_hole', () => {
    const parts = [];
    const ring = ngon(9, 0.9, { wob: 0.16, seed: 77 });
    parts.push([extrude(ring, 0.10, { topScale: 0.86, floor: true, floorY: -0.16 }), null]);
    const g = combine(parts, 'workshole');
    weather(g, { grimeBase: 0.95, grimeHeight: 0.4, wear: 0.4, seed: 1063, up: 0.9 });
    return g;
  }, 'soil');
  P(K, 'spoil_heap', () => {
    const g = new THREE.ConeGeometry(0.68, 0.42, 9, 2);
    const pos = g.getAttribute('position');
    for (let i = 0; i < pos.count; i++) {
      const n = smoothNoise(pos.getX(i) * 6, pos.getZ(i) * 6);
      pos.setY(i, pos.getY(i) + (n - 0.5) * 0.10);
    }
    g.computeVertexNormals();
    g.translate(0, 0.21, 0);
    weather(g, { grimeBase: 0.95, grimeHeight: 0.5, wear: 0.3, seed: 1069, up: 0.8 });
    return g;
  }, 'gravelbed');

  /* ---- skip / dumpster ------------------------------------------------- */
  P(K, 'skip', () => {
    const parts = [];
    const body = extrude([
      [-1.65, -0.82], [1.65, -0.82], [1.65, 0.82], [-1.65, 0.82],
    ], 1.05, { topScale: 1.14, floor: true, floorY: 0.05 });
    parts.push([body, null]);
    // ribs
    for (let i = 0; i < 4; i++) {
      const x = -1.1 + i * 0.73;
      parts.push([box(0.07, 1.05, 1.72), newTrs(x, 0, 0)]);
    }
    parts.push([box(3.5, 0.09, 1.9), newTrs(0, 1.05, 0)]);
    for (const s of [-1, 1]) parts.push([box(0.14, 0.34, 0.14), newTrs(s * 1.5, 0.45, 0.92)]);
    parts.push([box(3.5, 0.12, 0.14), newTrs(0, 0.0, 0.86)]);
    parts.push([box(3.5, 0.12, 0.14), newTrs(0, 0.0, -0.86)]);
    const g = combine(parts, 'skip');
    dent(g, [[1.2, 0.6, 0.9, 0.5, 1], [-0.9, 0.4, -0.9, 0.4, 0.8]], 0.05);
    weather(g, { grimeBase: 0.9, grimeHeight: 1.4, wear: 0.9, seed: 1087, up: 0.6 });
    return g;
  }, 'rust');
  P(K, 'skip_fill', () => {
    const a = new Accum('skipfill');
    for (let i = 0; i < 16; i++) {
      const h0 = hash3i(1091, i, 1);
      const h1 = hash3i(1091, i, 2);
      const h2 = hash3i(1091, i, 3);
      const g = box(0.2 + h0 * 0.7, 0.05 + h1 * 0.2, 0.15 + h2 * 0.5);
      const m = newTrs(
        (h0 - 0.5) * 2.8, 0.85 + h1 * 0.30, (h1 - 0.5) * 1.3,
        h2 * TAU, 1, 1, 1, (h0 - 0.5) * 0.7, (h2 - 0.5) * 0.7
      );
      a.add(g, m, null, [0.8, 0.85, 0.4]);
      g.dispose();
    }
    return a.build();
  }, 'wood_grey');

  P(K, 'dumpster', () => {
    const parts = [];
    parts.push([extrude([[-0.92, -0.62], [0.92, -0.62], [0.92, 0.62], [-0.92, 0.62]], 1.10, { topScale: 1.06, floor: true, floorY: 0.16 }), null]);
    parts.push([box(1.92, 0.06, 1.32), newTrs(0, 1.14, 0.0, 0, 1, 1, 1, -0.05)]);
    parts.push([box(1.9, 0.05, 0.55), newTrs(0, 1.22, -0.46, 0, 1, 1, 1, -0.65)]);
    for (const [x, z] of [[-0.78, -0.5], [0.78, -0.5], [-0.78, 0.5], [0.78, 0.5]]) {
      parts.push([cyl(0.09, 0.09, 0.06, 8), newTrs(x, 0.09, z, 0, 1, 1, 1, 0, Math.PI / 2)]);
    }
    parts.push([box(0.14, 0.30, 0.14), newTrs(-0.99, 0.55, 0)]);
    parts.push([box(0.14, 0.30, 0.14), newTrs(0.99, 0.55, 0)]);
    const g = combine(parts, 'dumpster');
    dent(g, [[0.7, 0.6, 0.62, 0.4, 1]], 0.04);
    weather(g, { grimeBase: 0.92, grimeHeight: 1.4, wear: 0.85, seed: 1093, up: 0.7 });
    return g;
  }, 'plastic_green');

  /* ---- scaffolding ----------------------------------------------------- */
  /** One 2 m x 2 m x 2 m bay. The layout stacks and repeats it up a facade. */
  P(K, 'scaffold_bay', () => {
    const parts = [];
    const W = 2.0;
    const D = 1.2;
    const H = 2.0;
    for (const [x, z] of [[-W / 2, -D / 2], [W / 2, -D / 2], [-W / 2, D / 2], [W / 2, D / 2]]) {
      parts.push([cyl(0.024, 0.024, H, 6), newTrs(x, 0, z)]);
    }
    for (const y of [0.15, H - 0.1]) {
      parts.push([cyl(0.024, 0.024, W, 6), newTrs(0, y, -D / 2, 0, 1, 1, 1, 0, Math.PI / 2)]);
      parts.push([cyl(0.024, 0.024, W, 6), newTrs(0, y, D / 2, 0, 1, 1, 1, 0, Math.PI / 2)]);
      parts.push([cyl(0.024, 0.024, D, 6), newTrs(-W / 2, y, 0, Math.PI / 2, 1, 1, 1, 0, Math.PI / 2)]);
      parts.push([cyl(0.024, 0.024, D, 6), newTrs(W / 2, y, 0, Math.PI / 2, 1, 1, 1, 0, Math.PI / 2)]);
    }
    parts.push([cyl(0.022, 0.022, 1.0, 6), newTrs(0, H * 0.5, -D / 2, 0, 1, 1, 1, 0, Math.PI / 2 + 0.55)]);
    parts.push([cyl(0.020, 0.020, 2.3, 6), newTrs(0, H * 0.55, -D / 2, 0, 1, 1, 1, 0, Math.PI / 2 - 1.05)]);
    // boards
    for (let i = 0; i < 3; i++) parts.push([box(W, 0.035, 0.35), newTrs(0, H - 0.06, -D / 2 + 0.22 + i * 0.37)]);
    parts.push([box(W, 0.18, 0.03), newTrs(0, H - 0.02, -D / 2 + 0.06)]);
    const g = combine(parts, 'scaffold');
    weather(g, { grimeBase: 0.75, grimeHeight: 2.0, wear: 0.8, seed: 1097 });
    return g;
  }, 'galv');

  P(K, 'ladder', () => {
    const parts = [];
    parts.push([box(0.05, 3.2, 0.03), newTrs(-0.21, 0, 0)]);
    parts.push([box(0.05, 3.2, 0.03), newTrs(0.21, 0, 0)]);
    for (let i = 0; i < 11; i++) parts.push([cyl(0.016, 0.016, 0.42, 5), newTrs(0, 0.15 + i * 0.29, 0, 0, 1, 1, 1, 0, Math.PI / 2)]);
    const g = combine(parts, 'ladder');
    weather(g, { grimeBase: 0.7, grimeHeight: 2.0, wear: 0.85, seed: 1103 });
    return g;
  }, 'galv');

  /* ---- drums, cylinders, cable reels ----------------------------------- */
  P(K, 'drum_oil', () => {
    const g = cyl(0.29, 0.29, 0.88, 12);
    dent(g, [[0.26, 0.5, 0.1, 0.3, 1], [-0.15, 0.72, 0.24, 0.26, 0.7]], 0.04);
    const out = combine([
      [g, null],
      [new THREE.TorusGeometry(0.295, 0.022, 4, 14), newTrs(0, 0.30, 0, 0, 1, 1, 1, Math.PI / 2)],
      [new THREE.TorusGeometry(0.295, 0.022, 4, 14), newTrs(0, 0.58, 0, 0, 1, 1, 1, Math.PI / 2)],
      [new THREE.TorusGeometry(0.30, 0.026, 4, 14), newTrs(0, 0.87, 0, 0, 1, 1, 1, Math.PI / 2)],
      [cyl(0.035, 0.035, 0.03, 6), newTrs(0.15, 0.88, 0.06)],
    ], 'drum');
    weather(out, { grimeBase: 0.9, grimeHeight: 1.1, wear: 0.9, seed: 1109, up: 0.65 });
    return out;
  }, 'rust');

  P(K, 'gas_cylinder', () => {
    const g = lathe([
      [0, 0], [0.13, 0.02], [0.145, 0.08], [0.145, 0.94],
      [0.115, 1.04], [0.055, 1.08], [0.05, 1.18], [0.075, 1.22], [0, 1.24],
    ], 10);
    weather(g, { grimeBase: 0.75, grimeHeight: 1.2, wear: 0.7, seed: 1117 });
    return g;
  }, 'sign_amber');

  P(K, 'cable_reel', () => {
    const parts = [];
    parts.push([cyl(0.62, 0.62, 0.05, 12), newTrs(0, 0.62, -0.30, 0, 1, 1, 1, Math.PI / 2)]);
    parts.push([cyl(0.62, 0.62, 0.05, 12), newTrs(0, 0.62, 0.30, 0, 1, 1, 1, Math.PI / 2)]);
    parts.push([cyl(0.26, 0.26, 0.56, 10), newTrs(0, 0.62, 0, 0, 1, 1, 1, Math.PI / 2)]);
    for (let i = 0; i < 8; i++) {
      const a = (i / 8) * TAU;
      parts.push([box(0.04, 0.9, 0.04), newTrs(Math.cos(a) * 0.44, 0.62, Math.sin(a) * 0.0 - 0.30, 0, 1, 1, 1, 0, 0)]);
    }
    const g = combine(parts, 'reel');
    weather(g, { grimeBase: 0.85, grimeHeight: 1.0, wear: 0.85, seed: 1123, up: 0.6 });
    return g;
  }, 'wood_grey');

  P(K, 'tyre_stack', () => {
    const parts = [];
    for (let i = 0; i < 3; i++) {
      const t = new THREE.TorusGeometry(0.30, 0.105, 6, 12);
      parts.push([t, newTrs((hash3i(1129, i, 1) - 0.5) * 0.09, 0.11 + i * 0.20, (hash3i(1129, i, 2) - 0.5) * 0.09, hash3i(1129, i, 3) * TAU, 1, 1, 1, Math.PI / 2)]);
    }
    const g = combine(parts, 'tyres');
    weather(g, { grimeBase: 0.9, grimeHeight: 0.7, wear: 0.4, seed: 1129, up: 0.7 });
    return g;
  }, 'tyre');

  /* ---- bikes ----------------------------------------------------------- */
  P(K, 'bike_chained', () => {
    const parts = [];
    const R = 0.335;
    // wheels: rim + hub + a few spokes, tilted as a chained bike always is
    for (const zx of [-0.53, 0.53]) {
      parts.push([new THREE.TorusGeometry(R, 0.022, 4, 14), newTrs(zx, R, 0, 0, 1, 1, 1, 0, 0)]);
      parts.push([new THREE.TorusGeometry(R * 0.94, 0.012, 3, 14), newTrs(zx, R, 0, 0, 1, 1, 1, 0, 0)]);
      parts.push([cyl(0.028, 0.028, 0.09, 6), newTrs(zx, R, 0, 0, 1, 1, 1, Math.PI / 2)]);
      for (let i = 0; i < 5; i++) {
        const a = (i / 5) * Math.PI;
        parts.push([box(0.008, R * 1.85, 0.008), newTrs(zx, R, 0, 0, 1, 1, 1, 0, a)]);
      }
    }
    // frame
    const F = [
      [[-0.53, 0.335], [-0.16, 0.60]], [[-0.16, 0.60], [0.30, 0.60]],
      [[0.30, 0.60], [0.53, 0.335]], [[-0.16, 0.60], [0.02, 0.30]],
      [[0.02, 0.30], [0.53, 0.335]], [[0.02, 0.30], [0.30, 0.60]],
      [[0.30, 0.60], [0.34, 0.98]],
    ];
    for (const [a, b] of F) {
      parts.push([tube([{ x: a[0], y: a[1], z: 0 }, { x: b[0], y: b[1], z: 0 }], 0.017, 5), null]);
    }
    parts.push([box(0.42, 0.025, 0.03), newTrs(0.34, 1.0, 0)]);
    parts.push([box(0.16, 0.05, 0.10), newTrs(-0.14, 0.64, 0)]);
    parts.push([new THREE.TorusGeometry(0.10, 0.014, 4, 10), newTrs(0.02, 0.30, 0.05, 0, 1, 1, 1, 0, 0)]);
    const g = combine(parts, 'bike');
    weather(g, { grimeBase: 0.72, grimeHeight: 1.0, wear: 0.8, seed: 1151 });
    return g;
  }, 'pole_grey');

  /* ---- pavement drainage + utility lids -------------------------------- */
  P(K, 'gully_walk', () => {
    const parts = [];
    parts.push([box(0.46, 0.05, 0.30), newTrs(0, -0.02, 0)]);
    for (let i = 0; i < 5; i++) parts.push([box(0.40, 0.03, 0.026), newTrs(0, 0.02, -0.11 + i * 0.055)]);
    parts.push([box(0.50, 0.035, 0.34), newTrs(0, -0.05, 0)]);
    const g = combine(parts, 'gullywalk');
    weather(g, { grimeBase: 0.98, grimeHeight: 0.2, wear: 0.7, seed: 1153, up: 0.9 });
    return g;
  }, 'steel');
  P(K, 'utility_lid', () => {
    const parts = [];
    parts.push([box(0.44, 0.04, 0.62), newTrs(0, -0.015, 0)]);
    parts.push([box(0.37, 0.03, 0.55), newTrs(0, 0.012, 0)]);
    parts.push([box(0.10, 0.012, 0.02), newTrs(0, 0.03, 0.20)]);
    const g = combine(parts, 'utillid');
    weather(g, { grimeBase: 0.96, grimeHeight: 0.2, wear: 0.8, seed: 1163, up: 0.9 });
    return g;
  }, 'steel');

  /* ---- puddles ---------------------------------------------------------- */
  for (let v = 0; v < 3; v++) {
    P(K, `puddle_${v}`, () => {
      const outline = ngon(11, 1.0, { wob: 0.34, seed: 1200 + v, sx: 1.3, sz: 0.8 });
      const a = new Accum('puddle');
      const c = a.vert(0, 0, 0, 0, 1, 0, 0.5, 0.5, 0, 0, 0.6);
      const ring = [];
      for (const [x, z] of outline) ring.push(a.vert(x, 0, z, 0, 1, 0, x * 0.5 + 0.5, z * 0.5 + 0.5, 0, 0.9, 0));
      for (let i = 0; i < ring.length; i++) a.tri(c, ring[(i + 1) % ring.length], ring[i]);
      return a.build();
    }, 'puddle', { castShadow: false, noShadow: true, noPrepass: true, renderOrder: 2 });
  }

  /* ---- sandbags, bricks, pipe stacks ------------------------------------ */
  P(K, 'brick_stack', () => {
    const a = new Accum('bricks');
    for (let layer = 0; layer < 5; layer++) {
      for (let i = 0; i < 6; i++) {
        const h0 = hash3i(1213, layer * 7 + i, 1);
        const g = box(0.22, 0.065, 0.105);
        const m = newTrs(
          -0.28 + (i % 3) * 0.24 + (h0 - 0.5) * 0.02,
          layer * 0.068,
          -0.12 + Math.floor(i / 3) * 0.23 + (h0 - 0.5) * 0.02,
          (layer % 2) * Math.PI / 2 + (h0 - 0.5) * 0.12
        );
        a.add(g, m, null, [0.7, 0.8, 0.4]);
        g.dispose();
      }
    }
    return a.build();
  }, 'brickface');

  P(K, 'pipe_stack', () => {
    const parts = [];
    for (let row = 0; row < 3; row++) {
      const n = 4 - row;
      for (let i = 0; i < n; i++) {
        parts.push([cyl(0.115, 0.115, 1.9, 9), newTrs(-0.36 + row * 0.12 + i * 0.24, 0.12 + row * 0.21, 0, 0, 1, 1, 1, 0, Math.PI / 2)]);
      }
    }
    const g = combine(parts, 'pipes');
    weather(g, { grimeBase: 0.85, grimeHeight: 0.8, wear: 0.8, seed: 1217, up: 0.7 });
    return g;
  }, 'concrete_prop');

  /** A vent / steam grate flush with the pavement — `fx` can use it. */
  P(K, 'vent_grate', () => {
    const parts = [];
    parts.push([box(1.30, 0.05, 0.72), newTrs(0, -0.02, 0)]);
    for (let i = 0; i < 11; i++) parts.push([box(1.22, 0.028, 0.032), newTrs(0, 0.022, -0.31 + i * 0.062)]);
    parts.push([box(1.38, 0.04, 0.80), newTrs(0, -0.05, 0)]);
    const g = combine(parts, 'vent');
    weather(g, { grimeBase: 0.98, grimeHeight: 0.2, wear: 0.75, seed: 1223, up: 0.95 });
    return g;
  }, 'steel');
}
