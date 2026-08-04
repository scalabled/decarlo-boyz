/**
 * PEDS — body and clothing parts for the procedural pedestrian.
 *
 * Everything returns a mesh record in the actor's bind space (metres, feet on
 * y = 0, facing +Z, the character's right at -X). `builder.js` decides which
 * parts an outfit wears and hands them to the CharacterBuilder along with the
 * bones they bind to and the palette slot they take their colour from.
 *
 * The design rule throughout: a garment is a LOFTED SHELL with real section
 * changes (waist, chest, shoulder yoke, hem) plus a crease field parameterised
 * along the garment, never an isotropic noise bump on a cylinder. That is the
 * difference between "cloth" and "a rendered tube", and it is the single thing
 * a crowd cannot fake — at 10 m the only cue that a coat is a coat is the way
 * the hem swings clear of the hips and the way the fabric gathers at the elbow.
 */

import * as THREE from 'three';
import {
  emptyMesh, loft, tube, ribbon, ellipsoid, boxRound, superEllipse,
  ellipseProfile, appendMesh, computeNormals, displace, warp, transformMesh,
} from './geo.js';

/** Cylindrical wrap about the Y axis — bends flat slabs around the torso. */
export function bendY(mesh, radius, centreZ = 0) {
  return warp(mesh, (v) => {
    const r = radius + (v.z - centreZ);
    const a = v.x / radius;
    v.x = Math.sin(a) * r;
    v.z = centreZ + Math.cos(a) * r - radius;
  });
}

export function place(mesh, x, y, z, rx = 0, ry = 0, rz = 0, sx = 1, sy = 1, sz = 1) {
  const m = new THREE.Matrix4().compose(
    new THREE.Vector3(x, y, z),
    new THREE.Quaternion().setFromEuler(new THREE.Euler(rx, ry, rz, 'YXZ')),
    new THREE.Vector3(sx, sy, sz)
  );
  computeNormals(mesh);
  return transformMesh(mesh, m);
}

const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
const smoothstep = (e0, e1, x) => {
  const t = clamp01((x - e0) / (e1 - e0));
  return t * t * (3 - 2 * t);
};

/* ================================================================== */
/* Torso                                                              */
/* ================================================================== */

/**
 * The garment shell everything hangs on.
 *
 * `p.hem` is where the garment stops (0.60 long coat, 0.80 hip jacket, 0.88
 * tucked shirt). `p.bust` swells the chest and narrows the waist for a female
 * silhouette; `p.belly` does the opposite for a heavy one. `p.flare` swings the
 * hem out — the single most legible difference between an overcoat and a
 * anorak at 20 m.
 *
 * Sections are (y, halfWidth, halfDepth, zOffset, cornerExponent).
 */
/**
 * Torso section table, measured rather than guessed.
 *
 * `b` runs 0 at the crotch (y = 0.86) to 1 at the base of the neck (y = 1.44),
 * and the entries are HALF width and HALF depth in metres for an average adult
 * male at the 1.75 m reference height. A 38 cm biacromial breadth, a 34 cm
 * chest, a 30 cm waist and a 33 cm hip — the numbers a tailor would use.
 *
 * Getting these wrong is the single loudest defect on a procedural human: the
 * first pass here ran a 45 cm chest and every pedestrian read as an inflated
 * mannequin from twenty metres away.
 */
const TORSO = [
  //  b     halfW   halfD   zOff   corner
  [0.00, 0.150, 0.107, -0.008, 2.8],  // hip
  [0.14, 0.145, 0.103, -0.008, 2.8],
  [0.28, 0.137, 0.098, -0.006, 2.7],  // natural waist
  [0.42, 0.144, 0.103, 0.000, 2.6],   // lower ribs
  [0.56, 0.155, 0.111, 0.004, 2.5],
  [0.70, 0.162, 0.117, 0.006, 2.5],   // chest
  [0.82, 0.156, 0.114, 0.006, 2.7],   // armpit — the shell STOPS at the
  [0.90, 0.168, 0.108, 0.004, 3.0],   //   deltoid; the sleeve and the cap
  [0.96, 0.142, 0.096, -0.002, 2.8],  //   carry the shoulder out from here
  [1.00, 0.094, 0.080, -0.006, 2.5],  // neck base
  [1.06, 0.064, 0.062, -0.006, 2.4],  // collar
];

function torsoAt(b, out) {
  const n = TORSO.length;
  if (b <= TORSO[0][0]) { out[0] = TORSO[0][1]; out[1] = TORSO[0][2]; out[2] = TORSO[0][3]; out[3] = TORSO[0][4]; return out; }
  for (let i = 1; i < n; i++) {
    if (b <= TORSO[i][0] || i === n - 1) {
      const a = TORSO[i - 1];
      const c = TORSO[i];
      const t = clamp01((b - a[0]) / (c[0] - a[0]));
      const s = t * t * (3 - 2 * t);
      out[0] = a[1] + (c[1] - a[1]) * s;
      out[1] = a[2] + (c[2] - a[2]) * s;
      out[2] = a[3] + (c[3] - a[3]) * s;
      out[3] = a[4] + (c[4] - a[4]) * s;
      return out;
    }
  }
  return out;
}

const _sec = [0, 0, 0, 0];

/**
 * Where the FRONT surface of a torso shell is at height `y`, for the same
 * options the shell was built with. Lapels, buttons, zips and hi-vis bands all
 * have to sit a few millimetres proud of this; the first pass hard-coded them
 * and every one of them ended up buried inside the coat.
 */
export function torsoFrontZ(y, p = {}) {
  const b = (y - 0.86) / (1.44 - 0.86);
  torsoAt(b, _sec);
  let hz = _sec[1];
  const zo = _sec[2];
  const hem = p.hem ?? 0.80;
  const flare = p.flare ?? 1;
  if (y < 0.94) {
    const d = clamp01((0.94 - y) / Math.max(0.03, 0.94 - hem));
    hz += d * d * 0.026 * flare;
  }
  const waistK = Math.exp(-((b - 0.30) ** 2) / 0.030);
  hz *= 1 - (1 - (p.waist ?? 1)) * waistK * 0.8;
  if (p.bust > 0) hz += p.bust * 0.034 * Math.exp(-((b - 0.60) ** 2) / 0.012);
  if (p.belly > 0) hz += p.belly * 0.048 * Math.exp(-((b - 0.26) ** 2) / 0.045);
  const close = smoothstep(0.90, 1.03, b);
  hz = hz * (p.bulk ?? 1) + (p.thick ?? 0) * (1 - close * 0.75);
  // the chest-forward warp the shell applies after lofting
  const t = clamp01((y - 1.14) / 0.24);
  return hz + zo + 0.012 * t;
}

export function torsoShell(nz, p = {}) {
  const hem = p.hem ?? 0.80;
  const bulk = p.bulk ?? 1;
  const flare = p.flare ?? 1;
  const bust = p.bust ?? 0;
  const belly = p.belly ?? 0;
  const shoulder = p.shoulder ?? 1;
  const thick = p.thick ?? 0.0;      // garment thickness over the body
  const waistIn = p.waist ?? 1;      // < 1 = nipped waist

  const S = [];
  const top = 1.475;
  const rows = p.rows ?? 15;
  for (let i = 0; i < rows; i++) {
    const t = i / (rows - 1);
    const y = hem + (top - hem) * t;
    const b = (y - 0.86) / (1.44 - 0.86);
    torsoAt(b, _sec);
    let hx = _sec[0];
    let hz = _sec[1];
    const zo0 = _sec[2];
    const corner = _sec[3];
    // the shoulder yoke is where a garment's cut shows: a suit squares it, a
    // puffa rounds it, a woman's coat narrows it
    const yoke = smoothstep(0.72, 0.94, b);
    hx *= 1 + (shoulder - 1) * yoke;
    // hem: below the natural waist a coat HANGS, it does not follow the body
    if (y < 0.94) {
      const d = clamp01((0.94 - y) / Math.max(0.03, 0.94 - hem));
      hx += d * d * 0.034 * flare;
      hz += d * d * 0.026 * flare;
    }
    const waistK = Math.exp(-((b - 0.30) ** 2) / 0.030);
    hx *= 1 - (1 - waistIn) * waistK;
    hz *= 1 - (1 - waistIn) * waistK * 0.8;
    if (bust > 0) {
      const k = Math.exp(-((b - 0.60) ** 2) / 0.012);
      hz += bust * 0.034 * k;
      hx += bust * 0.007 * k;
    }
    if (belly > 0) {
      const k = Math.exp(-((b - 0.26) ** 2) / 0.045);
      hz += belly * 0.048 * k;
      hx += belly * 0.030 * k;
    }
    // above the shoulder line the shell closes onto the neck and the thickness
    // has to go with it or a coat grows a barrel collar
    const close = smoothstep(0.90, 1.03, b);
    const th = thick * (1 - close * 0.75);
    hx = hx * bulk + th;
    hz = hz * bulk + th;
    S.push([y, hx, hz, zo0, corner]);
  }

  const seg = p.seg ?? 24;
  const rings = S.map(([y, hx, hz, zo, n]) => ({
    pts: superEllipse(hx, hz, n, seg),
    o: [0, y, zo],
  }));
  // The top is CAPPED. An open tube shows its own backfaces at the neck, which
  // renders as a hole straight through the character.
  const m = loft(rings, { capStart: p.capHem !== false, capEnd: true });
  computeNormals(m);

  // chest deeper at the front than the back; trapezius slope on the shoulders
  warp(m, (v) => {
    const t = clamp01((v.y - 1.14) / 0.24);
    if (v.z > 0) v.z += 0.012 * t;
    else v.z -= 0.005 * t;
    if (v.y > 1.34) v.y -= 0.026 * Math.min(1, Math.abs(v.x) / 0.17) ** 2;
  });
  computeNormals(m);

  // cloth: horizontal gather at the waist, vertical drape below it, and a
  // broad fold field that never repeats
  const drape = p.drape ?? 1;
  displace(m, (x, y, z) => {
    const fold = nz.fbm3(x * 20, y * 13, z * 20, 3);
    const vertical = Math.sin(Math.atan2(x, z) * 9 + fold * 3.2) * 0.5 + 0.5;
    const below = clamp01((0.96 - y) / 0.28);
    const waist = Math.exp(-((y - 1.02) ** 2) / 0.005);
    const shoulderPull = Math.exp(-((y - 1.33) ** 2) / 0.010) * Math.max(0, 1 - Math.abs(x) / 0.22);
    return (
      (fold * 0.0034 +
        vertical * below * 0.0042 +
        waist * 0.0026 +
        shoulderPull * 0.0018 +
        nz.fbm3(x * 44, y * 44, z * 44, 2) * 0.0009) * drape
    );
  });
  return m;
}

/** Pelvis / seat block so the hips read solid under a short jacket. */
export function pelvis(nz, p = {}) {
  const bulk = p.bulk ?? 1;
  const hipW = p.hipW ?? 1;
  const seg = 22;
  const rings = [
    [0.800, 0.126 * hipW, 0.094],
    [0.848, 0.136 * hipW, 0.100],
    [0.900, 0.144 * hipW, 0.104],
    [0.952, 0.144 * hipW, 0.101],
    [1.002, 0.136 * hipW, 0.094],
  ].map(([y, hx, hz]) => ({ pts: superEllipse(hx * bulk, hz * bulk, 3.0, seg), o: [0, y, -0.006] }));
  const m = loft(rings, { capStart: true, capEnd: true });
  computeNormals(m);
  // seat: a real backside, not a cylinder
  warp(m, (v) => {
    const k = Math.exp(-((v.y - 0.90) ** 2) / 0.004) * Math.max(0, -v.z / 0.1);
    v.z -= k * 0.028 * (p.seat ?? 1);
  });
  computeNormals(m);
  displace(m, (x, y, z) => nz.fbm3(x * 24, y * 18, z * 24, 3) * 0.0035);
  return m;
}

/**
 * Sleeve / trouser leg. A tube down a 3-point bone chain with an elliptical
 * section, plus a crease field parameterised by arc length so the folds run
 * AROUND the limb, bunch at the joint and stack at the cuff — which is what
 * cloth does and what isotropic noise never does.
 */
export function limbTube(nz, a, b, c, radii, opts = {}) {
  const pts = [];
  const N = opts.rings ?? 11;
  const segs = opts.seg ?? 14;
  const A = new THREE.Vector3(...a), B = new THREE.Vector3(...b), C = new THREE.Vector3(...c);
  const tmp = new THREE.Vector3();
  const mid = new THREE.Vector3().addVectors(A, C).multiplyScalar(0.5);
  for (let i = 0; i < N; i++) {
    const t = i / (N - 1);
    if (t <= 0.5) tmp.lerpVectors(A, B, t * 2);
    else tmp.lerpVectors(B, C, (t - 0.5) * 2);
    if (t > 0.34 && t < 0.66) {
      const k = 1 - Math.abs(t - 0.5) / 0.16;
      tmp.lerp(mid, 0.06 * k);
    }
    pts.push([tmp.x, tmp.y, tmp.z]);
  }
  const flat = opts.flat ?? 0.88;
  const m = tube(
    pts,
    (t) => {
      const r = radiusAt(radii, t);
      return opts.square
        ? superEllipse(r, r * flat, opts.square, segs)
        : ellipseProfile(r, r * flat, segs);
    },
    { capStart: opts.capStart ?? false, capEnd: opts.capEnd ?? false, up: opts.up ?? [0, 0, 1] }
  );
  computeNormals(m);
  const amp = opts.fold ?? 0.0016;
  const crease = opts.crease ?? 0;
  if (crease > 0) {
    const AB = new THREE.Vector3().subVectors(B, A);
    const BC = new THREE.Vector3().subVectors(C, B);
    const lAB = AB.length(), lBC = BC.length();
    const uAB = AB.clone().divideScalar(Math.max(1e-5, lAB));
    const uBC = BC.clone().divideScalar(Math.max(1e-5, lBC));
    const total = lAB + lBC;
    const bend = new THREE.Vector3(...(opts.bend ?? [0, 0, -1])).normalize();
    const q = new THREE.Vector3();
    const band = opts.band ?? 0.055;
    displace(m, (x, y, z, nx, ny, nzc) => {
      const tAB = Math.max(0, Math.min(lAB, q.set(x, y, z).sub(A).dot(uAB)));
      const tBC = Math.max(0, Math.min(lBC, q.set(x, y, z).sub(B).dot(uBC)));
      const s = tAB < lAB - 1e-4 ? tAB : lAB + tBC;
      const u = s / total;
      const jit = nz.fbm3(x * 6, y * 5, z * 6, 2) - 0.5;
      const bnd = Math.abs(Math.sin((s / band + jit * 0.9) * Math.PI));
      const ridged = 1 - bnd ** 0.65;
      const joint = Math.exp(-((u - 0.5) ** 2) / 0.012);
      const cuff = Math.exp(-((u - 0.94) ** 2) / 0.004);
      const inner = Math.max(0, bend.x * nx + bend.y * ny + bend.z * nzc);
      const gather = 1 + joint * (0.6 + 1.8 * inner) + cuff * 0.8;
      const broad = nz.fbm3(x * 9, y * 7 + u * 3.1, z * 9, 3) - 0.5;
      return crease * (ridged * gather * 0.9 + broad * 1.1);
    });
    computeNormals(m);
  }
  displace(m, (x, y, z) => {
    const f = nz.fbm3(x * 11, y * 9, z * 11, 3);
    const fine = nz.fbm3(x * 34, y * 30, z * 34, 2);
    return f * amp + fine * amp * 0.3;
  });
  return m;
}

function radiusAt(radii, t) {
  const n = radii.length - 1;
  const s = t * n;
  const i = Math.min(n - 1, Math.floor(s));
  const f = s - i;
  return radii[i] + (radii[i + 1] - radii[i]) * f;
}

/** Deltoid cap so the shoulder is round rather than a tube socket. */
/**
 * The deltoid: the rounded END of the sleeve, sized off the sleeve radius so it
 * is flush with it rather than a separate ball bolted to the shoulder. The
 * teardrop taper tucks it under at the bottom, which is where the armpit is.
 */
export function shoulderCap(nz, shoulder, side, r = 0.052) {
  // Sized to the sleeve, NOT to the shoulder: this is the rounded end of the
  // sleeve, so it has to be flush with it. A cap larger than the tube it caps
  // reads as a ball joint, which is exactly what the first pass looked like.
  // capStart, or the clipped ellipsoid is an OPEN BOWL and the back faces of
  // its rim cull away — which renders as a dark hole at the point of the
  // shoulder and reads as a puffed Victorian sleeve.
  const m = ellipsoid(r, r * 1.02, r, { seg: 18, rows: 11, v0: 0.26, v1: 1, capStart: true });
  computeNormals(m);
  warp(m, (v) => {
    const k = clamp01(-v.y / (r * 1.02));
    v.x *= 1 - 0.22 * k * k;
    v.z *= 1 - 0.16 * k * k;
  });
  place(m, shoulder[0] - side * 0.006, shoulder[1] - 0.018, shoulder[2], 0, 0, -side * 0.09);
  displace(m, (x, y, z) => nz.fbm3(x * 30, y * 30, z * 30, 3) * 0.0028);
  return m;
}

/** Cuff band at the wrist or ankle — a doubled hem that catches the light. */
export function cuff(nz, centre, dir, r, width) {
  const d = new THREE.Vector3(...dir).normalize();
  const pts = [
    [centre[0] - d.x * width, centre[1] - d.y * width, centre[2] - d.z * width],
    [centre[0], centre[1], centre[2]],
    [centre[0] + d.x * width, centre[1] + d.y * width, centre[2] + d.z * width],
  ];
  const m = tube(pts, () => ellipseProfile(r, r * 0.9, 14), { capStart: false, capEnd: false });
  computeNormals(m);
  displace(m, (x, y, z) => nz.fbm3(x * 60, y * 46, z * 60, 2) * 0.0022);
  return m;
}

/* ================================================================== */
/* Skirt / dress                                                      */
/* ================================================================== */

export function skirt(nz, p = {}) {
  const hem = p.hem ?? 0.54;
  const top = p.top ?? 0.99;
  const flare = p.flare ?? 1;
  const rows = 9;
  const seg = 26;
  const rings = [];
  for (let i = 0; i < rows; i++) {
    const t = i / (rows - 1);
    const y = hem + (top - hem) * t;
    const d = 1 - t;
    const hx = 0.144 + d * d * 0.072 * flare;
    const hz = 0.104 + d * d * 0.056 * flare;
    rings.push({ pts: superEllipse(hx, hz, 2.6, seg), o: [0, y, -0.004] });
  }
  const m = loft(rings, { capStart: true, capEnd: false });
  computeNormals(m);
  // vertical pleats: the shape cue that says skirt at any distance
  const pleats = p.pleats ?? 11;
  displace(m, (x, y, z) => {
    const a = Math.atan2(x, z);
    const t = clamp01((y - hem) / (top - hem));
    const jit = nz.fbm3(x * 5, y * 4, z * 5, 2) - 0.5;
    const w = Math.sin(a * pleats + jit * 1.4) * 0.5 + 0.5;
    return (1 - t) ** 0.6 * (w * 0.0075 + 0.0018) + nz.fbm3(x * 26, y * 20, z * 26, 3) * 0.0022;
  });
  return m;
}

/* ================================================================== */
/* Head                                                               */
/* ================================================================== */

/**
 * Head sections: (y above the Head bone, halfWidth, halfDepth, zOffset,
 * superellipse exponent). y = 0 is the point of the chin, 0.240 the crown.
 */
/**
 * NEGATIVE-CONTROL SWITCH for `faceprobe.mjs`.
 *
 * A gate that has never failed is not evidence (ARCHITECTURE.md rule 12), so
 * the face gate has to be able to put the defects BACK. Setting `on` restores
 * the four shipped values this pass changed — the level hat rims, the long-hair
 * curtain pinned at eye height, the undersized hair shell and the flat skull —
 * and every one of them must turn the gate red. Boot-time only; nothing reads
 * it per frame, and the game never sets it.
 */
export const FACE_LEGACY = { on: false };

/**
 * WIDTH AND DEPTH ARE ANTHROPOMETRY, NOT TASTE.
 *
 * An adult head is 0.152-0.158 broad and 0.190-0.200 long (glabella to
 * occiput) over a 0.23 m chin-to-crown, i.e. width/height 0.66-0.69 and
 * depth/height 0.83-0.87. The emitted skull used to measure 163 x 241 x 193 mm
 * — w/h 0.678 and d/h 0.801 — a head at the top of the width band and BELOW
 * the depth band, which is exactly the profile that reads as "squished": too
 * broad across the cheekbones and too flat front to back. The halfWidth column
 * is now 0.97x and the halfDepth column 1.06x what it was, giving 158 x 241 x
 * 205 mm, w/h 0.657 and d/h 0.849. `faceprobe.mjs` gate 5 measures this on the
 * EMITTED geometry and holds both ratios inside the anthropometric band.
 *
 * The hair and hat shells in this file enclose the skull with a measured
 * margin; anything that changes this table changes that boundary too, so run
 * `node src/peds/faceprobe.mjs` (gate 4 SCALP) after touching it.
 */
const HEAD_S_NEW = [
  [0.000, 0.0369, 0.0530, 0.019, 3.0],
  [0.018, 0.0534, 0.0710, 0.014, 2.9],
  [0.040, 0.0669, 0.0795, 0.006, 2.7],
  [0.070, 0.0728, 0.0859, 0.001, 2.4],
  [0.095, 0.0795, 0.0912, -0.002, 2.4],
  [0.119, 0.0815, 0.0933, -0.005, 2.4],
  [0.146, 0.0786, 0.0922, -0.009, 2.4],
  [0.176, 0.0718, 0.0848, -0.012, 2.4],
  [0.205, 0.0582, 0.0678, -0.014, 2.4],
  [0.228, 0.0349, 0.0413, -0.014, 2.4],
  [0.240, 0.0107, 0.0127, -0.014, 2.4],
];
/** What shipped: 3% wider and 6% shallower — w/h 0.678, d/h 0.801. */
const HEAD_S_OLD = HEAD_S_NEW.map(([y, hx, hz, zo, n]) => [y, hx / 0.97, hz / 1.06, zo, n]);
/** The live section table. A function, not a constant, only so that
 *  `FACE_LEGACY` can restore the shipped proportions for the gate's negative
 *  control; it is read at build time, never per frame. */
const headTable = () => (FACE_LEGACY.on ? HEAD_S_OLD : HEAD_S_NEW);

function headSection(y, out) {
  const T = headTable();
  const n = T.length;
  if (y <= T[0][0]) { out[0] = T[0][1]; out[1] = T[0][2]; out[2] = T[0][3]; out[3] = T[0][4]; return out; }
  for (let i = 1; i < n; i++) {
    if (y <= T[i][0] || i === n - 1) {
      const a = T[i - 1], c = T[i];
      const t = clamp01((y - a[0]) / (c[0] - a[0]));
      out[0] = a[1] + (c[1] - a[1]) * t;
      out[1] = a[2] + (c[2] - a[2]) * t;
      out[2] = a[3] + (c[3] - a[3]) * t;
      out[3] = a[4] + (c[4] - a[4]) * t;
      return out;
    }
  }
  return out;
}

const _hs = [0, 0, 0, 0];

/**
 * Where the FRONT of the face is, in head-local coordinates, at (x, y) —
 * including the brow ridge, the eye socket and the cheekbone the head warp
 * applies after lofting.
 *
 * Every facial feature is placed against this. The first pass hard-coded z
 * values guessed off the section table and put the eyes, the brows and the
 * mouth 5-8 mm INSIDE the head, which is why the faces came out blank.
 */
export function headSurfaceZ(x, y, wide = 1, jaw = 1) {
  headSection(y, _hs);
  const jw = y < 0.05 ? jaw : 1;
  const hx = _hs[0] * wide * jw;
  const hz = _hs[1] * (y < 0.05 ? jaw : 1);
  const zo = _hs[2];
  const n = _hs[3];
  const ax = Math.min(0.999, Math.abs(x) / Math.max(1e-4, hx));
  let z = hz * Math.max(0, 1 - ax ** n) ** (1 / n);
  // the same feature warp headMesh() applies
  const front = 1;
  const brow = Math.exp(-((y - 0.113) ** 2) / 0.00016) * Math.exp(-(x * x) / 0.006);
  const socket =
    Math.exp(-((Math.abs(x) - 0.033) ** 2) / 0.00035) * Math.exp(-((y - 0.098) ** 2) / 0.00022);
  const cheek =
    Math.exp(-((Math.abs(x) - 0.055) ** 2) / 0.0009) * Math.exp(-((y - 0.070) ** 2) / 0.0007);
  const temple =
    Math.exp(-((y - 0.150) ** 2) / 0.0016) * Math.exp(-((Math.abs(x) - 0.082) ** 2) / 0.0006);
  const chin = Math.exp(-(y * y) / 0.00035);
  const scale = 1 + 0.05 * brow - 0.10 * socket + 0.05 * cheek - 0.06 * temple;
  z = z * scale + 0.006 * brow + 0.004 * chin * jaw + zo;
  return z;
}

/** Skull + jaw, lofted from anatomical sections. `base` = Head bone position. */
export function headMesh(nz, base, p = {}) {
  const w = p.wide ?? 1;
  const jaw = p.jaw ?? 1;
  const S = headTable().map(([y, hx, hz, zo, n]) => [
    y, hx * w * (y < 0.05 ? jaw : 1), hz * (y < 0.05 ? jaw : 1), zo, n,
  ]);
  const seg = 24;
  const rings = S.map(([y, hx, hz, zo, n]) => ({
    pts: superEllipse(hx, hz, n, seg),
    o: [base[0], base[1] + y, base[2] + zo],
  }));
  // capEnd too: the top ring is 21 mm across and leaving it open made the
  // skull a tube, so a ray straight down the crown threaded the hair's own
  // degenerate pole and landed on the INSIDE of the cranium.
  const m = loft(rings, { capStart: true, capEnd: true });
  computeNormals(m);

  const bx = base[0], by = base[1], bz = base[2];
  warp(m, (v) => {
    const x = v.x - bx, y = v.y - by, z = v.z - bz;
    const front = Math.max(0, z / 0.093);
    const brow = Math.exp(-((y - 0.111) ** 2) / 0.00016) * front * Math.exp(-(x * x) / 0.006);
    const socket =
      Math.exp(-((Math.abs(x) - 0.032) ** 2) / 0.00035) *
      Math.exp(-((y - 0.096) ** 2) / 0.00022) * front;
    const cheek =
      Math.exp(-((Math.abs(x) - 0.053) ** 2) / 0.0009) *
      Math.exp(-((y - 0.068) ** 2) / 0.0007) * Math.max(0, z / 0.06);
    const temple = Math.exp(-((y - 0.148) ** 2) / 0.0016) * Math.exp(-((Math.abs(x) - 0.080) ** 2) / 0.0006);
    const chin = Math.exp(-(y * y) / 0.00035) * front;
    const occ = Math.exp(-((y - 0.163) ** 2) / 0.0018) * Math.max(0, -z / 0.093);
    const scale = 1 + 0.05 * brow - 0.10 * socket + 0.05 * cheek * (p.cheek ?? 1) - 0.06 * temple;
    v.x = bx + x * (1 - 0.05 * socket - 0.05 * temple);
    v.y = by + y;
    v.z = bz + z * scale + 0.006 * brow + 0.004 * chin * jaw - 0.008 * occ;
  });
  computeNormals(m);
  displace(m, (x, y, z) => nz.fbm3(x * 70, y * 70, z * 70, 3) * 0.0011);
  return m;
}

export function nose(nz, base, p = {}) {
  const k = p.size ?? 1;
  const bx = base[0], by = base[1], bz = base[2];
  // (y, protrusion beyond the face surface, halfWidth, halfDepth). Placing the
  // rings against `headSurfaceZ` is the whole trick: guessed z values put the
  // first pass's nose 8 mm inside the skull at the bridge and 25 mm proud at
  // the tip, which is a beak on a blank face.
  const S = [
    [0.126, -0.004, 0.009 * k, 0.008 * k],
    [0.110, 0.002, 0.013 * k, 0.011 * k],
    [0.094, 0.010, 0.017 * k, 0.014 * k],
    [0.079, 0.018, 0.023 * k, 0.017 * k],
    [0.069, 0.021, 0.030 * k, 0.016 * k],
    [0.061, 0.012, 0.029 * k, 0.011 * k],
    [0.056, -0.004, 0.024 * k, 0.008 * k],
  ];
  // ring centre = face surface + protrusion - halfDepth, so the BACK of the
  // ring is inside the skull and exactly `protrusion` sticks out
  const rings = S.map(([y, out, hx, hz]) => ({
    pts: superEllipse(hx, hz, 2.4, 14),
    o: [bx, by + y, bz + headSurfaceZ(0, y) + out - hz],
  }));
  const m = loft(rings, { capStart: false, capEnd: true });
  computeNormals(m);
  displace(m, (x, y, z) => nz.fbm3(x * 90, y * 90, z * 90, 2) * 0.0009);
  return m;
}

/** Nostrils: two dark dimples under the tip — what actually reads as a nose. */
export function nostrils(base, k = 1) {
  const out = emptyMesh();
  const bx = base[0], by = base[1], bz = base[2];
  for (const side of [-1, 1]) {
    const m = ellipsoid(0.0050 * k, 0.0032 * k, 0.0044 * k, { seg: 10, rows: 6 });
    computeNormals(m);
    place(m, bx + side * 0.0148 * k, by + 0.0602, bz + headSurfaceZ(0, 0.060) + 0.0165, 0.55, 0, 0);
    appendMesh(out, m);
  }
  return out;
}

export function ear(nz, base, side) {
  const m = ellipsoid(0.0085, 0.030, 0.021, { seg: 14, rows: 10 });
  computeNormals(m);
  warp(m, (v) => {
    const t = v.y / 0.030;
    // helix: the rim rolls forward at the top and the lobe hangs free
    v.z += t * 0.008 - Math.max(0, -t) * 0.004;
    v.x *= 1 + Math.max(0, t) * 0.35;
    // scaphoid hollow
    const bowl = Math.exp(-((t - 0.05) ** 2) / 0.35) * Math.max(0, -v.x / 0.009);
    v.x += bowl * 0.005;
  });
  computeNormals(m);
  place(m, base[0] + side * 0.079, base[1] + 0.094, base[2] - 0.006, 0.12, side * 0.30, side * -0.06);
  displace(m, (x, y, z) => nz.fbm3(x * 100, y * 100, z * 100, 2) * 0.0009);
  return m;
}

/**
 * The eye, in two pieces: a pale sclera sphere set into the socket and a dark
 * iris disc on the front of it. One dark bead in a smooth socket reads as a
 * mannequin at any distance; the value step between the two is what makes a
 * face look back at you.
 *
 * Everything below is placed against `headSurfaceZ`, so no feature can end up
 * buried inside the skull.
 */
const EYE_X = 0.0315;
const EYE_Y = 0.0965;
const EYE_R = 0.0130;

/**
 * Drop every triangle that lies ENTIRELY behind local z = `zMin`, then compact
 * the mesh. Used to keep only the forward cap of the sclera: the rear hemisphere
 * of a full eyeball is buried in the skull, contributes nothing the face ever
 * shows, and is the exact geometry that reads as "an eye through the back of the
 * head" the instant anything (a socket that is too shallow, a mirrored draw, a
 * head that is scaled narrower than the eye placement assumed) lets it out. An
 * eye that has no rear hemisphere cannot show one. Front is +z in head-local.
 */
function keepFrontCap(m, zMin) {
  const remap = new Int32Array(m.p.length / 3).fill(-1);
  const np = [], nn = [], nuv = [], ni = [];
  const keep = (v) => {
    if (remap[v] === -1) {
      remap[v] = np.length / 3;
      np.push(m.p[v * 3], m.p[v * 3 + 1], m.p[v * 3 + 2]);
      if (m.n.length) nn.push(m.n[v * 3] || 0, m.n[v * 3 + 1] || 0, m.n[v * 3 + 2] || 0);
      if (m.uv.length) nuv.push(m.uv[v * 2] || 0, m.uv[v * 2 + 1] || 0);
    }
    return remap[v];
  };
  for (let t = 0; t < m.i.length; t += 3) {
    const a = m.i[t], b = m.i[t + 1], c = m.i[t + 2];
    if (Math.max(m.p[a * 3 + 2], m.p[b * 3 + 2], m.p[c * 3 + 2]) < zMin) continue;
    ni.push(keep(a), keep(b), keep(c));
  }
  m.p = np; m.n = nn; m.uv = nuv; m.i = ni;
  return m;
}

export function eyeball(base, side) {
  const m = ellipsoid(EYE_R, EYE_R, EYE_R, { seg: 14, rows: 9 });
  // Only the forward cap — the socket buries everything past the equator, and
  // the visible eye reaches no further round than ~30 deg off dead-ahead, so a
  // cap kept a little past the equator is identical from every angle a viewer
  // can occupy while carrying no rear hemisphere to leak out of the skull.
  keepFrontCap(m, -EYE_R * 0.2);
  computeNormals(m);
  const zc = headSurfaceZ(side * EYE_X, EYE_Y) - EYE_R + 0.0030;
  place(m, base[0] + side * EYE_X, base[1] + EYE_Y, base[2] + zc);
  return m;
}

export function iris(base, side) {
  const m = ellipsoid(0.0066, 0.0066, 0.0034, { seg: 12, rows: 6 });
  computeNormals(m);
  const zc = headSurfaceZ(side * EYE_X, EYE_Y) + 0.0018;
  place(m, base[0] + side * (EYE_X + 0.0006), base[1] + EYE_Y, base[2] + zc, 0, side * -0.14, 0);
  return m;
}

/** Upper lid: the fold that covers the top third of the eyeball. */
export function eyelid(base, side) {
  const bx = base[0], by = base[1], bz = base[2];
  const pts = [];
  for (let i = 0; i <= 6; i++) {
    const a = (i / 6 - 0.5) * 2;
    const x = side * (EYE_X + a * 0.0185);
    const y = EYE_Y + 0.0082 - a * a * 0.0035;
    pts.push([bx + x, by + y, bz + headSurfaceZ(x, y) + 0.0022]);
  }
  const m = ribbon(pts, 0.0130, 0.0080, { seg: 6, up: [0, 1, 0] });
  computeNormals(m);
  return m;
}

/** Lower lid: the crease under the eye that stops it floating in the cheek. */
export function lowerLid(base, side) {
  const bx = base[0], by = base[1], bz = base[2];
  const pts = [];
  for (let i = 0; i <= 6; i++) {
    const a = (i / 6 - 0.5) * 2;
    const x = side * (EYE_X + a * 0.0175);
    const y = EYE_Y - 0.0100 + a * a * 0.0028;
    pts.push([bx + x, by + y, bz + headSurfaceZ(x, y) + 0.0016]);
  }
  const m = ribbon(pts, 0.0078, 0.0050, { seg: 5, up: [0, 1, 0] });
  computeNormals(m);
  return m;
}

/** Brows: the strongest horizontal in a face and the last thing to mip away. */
export function brows(base, side) {
  const bx = base[0], by = base[1], bz = base[2];
  const pts = [];
  for (let i = 0; i <= 5; i++) {
    const t = i / 5;
    const x = side * (0.0125 + t * 0.040);
    const y = 0.1150 + Math.sin(t * Math.PI) * 0.0035 - t * 0.0055;
    pts.push([bx + x, by + y, bz + headSurfaceZ(x, y) + 0.0022]);
  }
  const m = ribbon(pts, 0.0098, 0.0050, { seg: 5, up: [0, 1, 0] });
  computeNormals(m);
  return m;
}


/** Lips: an upper and a lower, both sitting on the face surface. */
export function lips(base) {
  const out = emptyMesh();
  const bx = base[0], by = base[1], bz = base[2];
  const put = (a, y, dz) => {
    const x = a * 0.026;
    return [bx + x, by + y, bz + headSurfaceZ(x, y) + dz];
  };
  const up = [];
  for (let i = 0; i <= 8; i++) {
    const a = (i / 8 - 0.5) * 2;
    up.push(put(a, 0.0398 - Math.exp(-(a * a) / 0.06) * 0.0020 - a * a * 0.0024, 0.0022));
  }
  const u = ribbon(up, 0.0078, 0.0062, { seg: 7, up: [0, 1, 0], upright: true });
  computeNormals(u);
  appendMesh(out, u);
  const lo = [];
  for (let i = 0; i <= 8; i++) {
    const a = (i / 8 - 0.5) * 2;
    lo.push(put(a * 0.94, 0.0314 - a * a * 0.0012, 0.0030));
  }
  const l = ribbon(lo, 0.0102, 0.0082, { seg: 7, up: [0, 1, 0], upright: true });
  computeNormals(l);
  appendMesh(out, l);
  return out;
}

/** The mouth line itself: a dark crease between the lips. */
export function mouthLine(base) {
  const bx = base[0], by = base[1], bz = base[2];
  const pts = [];
  for (let i = 0; i <= 8; i++) {
    const a = (i / 8 - 0.5) * 2;
    const x = a * 0.0268;
    const y = 0.0356 - a * a * 0.0012;
    pts.push([bx + x, by + y, bz + headSurfaceZ(x, y) + 0.0038]);
  }
  const m = ribbon(pts, 0.0042, 0.0032, { seg: 5, up: [0, 1, 0], upright: true });
  computeNormals(m);
  return m;
}


export function neck(nz, base, r = 1) {
  const m = limbTube(
    nz,
    [base[0], base[1] - 0.112, base[2] - 0.014],
    [base[0], base[1] - 0.056, base[2] - 0.008],
    [base[0], base[1] - 0.004, base[2]],
    [0.058 * r, 0.055 * r, 0.051 * r],
    { rings: 5, seg: 14, fold: 0.0009 }
  );
  return m;
}

/* ================================================================== */
/* Hair                                                               */
/* ================================================================== */

/**
 * Hair. Not a cap: a shell that follows the skull with a real hairline, plus a
 * silhouette-defining mass (a bun, a ponytail, a bob). At 25 m the hairline and
 * the outline are the only parts that survive, so both are geometry.
 */
export function hair(nz, base, style = 'short', p = {}) {
  const out = emptyMesh();
  const bx = base[0], by = base[1], bz = base[2];
  if (style === 'bald') return out;

  // 0.008, not 0.005, on a buzz: the strand displacement is +/-4 mm, so a
  // 5 mm shell over the occiput is inside its own noise and the skull showed
  // through in patches (38 bare rays on `joggerM` at 0.005).
  const thick = style === 'buzz' ? (FACE_LEGACY.on ? 0.005 : 0.008)
    : style === 'short' ? 0.010 : 0.016;
  /**
   * A shell around the cranium, not a cone. The skull's widest section is 0.084
   * at y+0.119 and its crown is at y+0.240, so the hair ellipsoid has to be
   * centred on the cranium and reach just past both — the first pass tapered
   * linearly to a point and every pedestrian wore a wizard hat.
   *
   * THE Z RADIUS USED TO BE 0.090 AND THE OCCIPUT IS AT 0.1035. Buzz hair
   * (thick 0.005) therefore sat 3 mm INSIDE the back of the skull, and short
   * hair cleared it by 2.5 mm against a +/-4 mm strand displacement — so the
   * bare cranium showed through the hair in patches across the back of the
   * head. `faceprobe.mjs` counted 479 of 4000 rays landing on bare skull above
   * the hairline on `joggerM` before this. Same defect the player character
   * shipped twice (ARCHITECTURE.md rule 9); 0.098 gives 5.5 mm of real margin
   * on the thinnest style. Anything that grows the SKULL has to grow this too.
   */
  const grow = FACE_LEGACY.on ? 0 : 1;
  const dome = ellipsoid(
    0.086 + thick + 0.004 * grow,
    0.118 + thick + 0.002 * grow,
    0.090 + thick + 0.010 * grow,
    { seg: 22, rows: 12, v0: 0.40, v1: 1 }
  );
  computeNormals(dome);
  place(dome, bx, by + 0.126, bz - 0.006 - 0.004 * grow);

  // hairline: high at the temples, a widow's peak at the centre, down the nape
  warp(dome, (v) => {
    const x = v.x - bx, y = v.y - by, z = v.z - bz;
    if (y > 0.175) return;
    const a = Math.atan2(x, z);
    const front = Math.max(0, Math.cos(a));
    const side = Math.abs(Math.sin(a));
    const back = Math.max(0, -Math.cos(a));
    const temple = side ** 2.5 * (p.recede ?? 0.35);
    const peak = Math.exp(-(x * x) / 0.0010) * front;
    const lift = front * (0.052 + temple * 0.030) - peak * 0.020 + side * 0.006;
    /**
     * The nape drop is FADED OUT above the ear line. Sliding the whole back of
     * the shell down by 30-52 mm brings a narrower part of the hair ellipsoid
     * to a wider part of the skull, and the upper occiput came back out through
     * it — 25 bare rays after the skull was deepened, at 8-9 cm up the back of
     * the head. Below y 0.09 the drop is full (that IS the nape hairline);
     * above 0.15 it is gone and the shell keeps its own geometry.
     */
    const napeK = FACE_LEGACY.on ? 1 : clamp01((0.150 - y) / 0.060);
    const drop = back * (style === 'long' || style === 'bob' ? 0.052 : 0.030) * napeK;
    v.y += lift - drop;
  });
  computeNormals(dome);
  displace(dome, (x, y, z) => {
    const strand = nz.ridge3(x * 110, y * 52, z * 110, 3);
    const clump = nz.fbm3(x * 24, y * 18, z * 24, 3);
    return (strand - 0.5) * 0.0030 + (clump - 0.5) * 0.0050;
  });
  appendMesh(out, dome);

  if (style === 'bob' || style === 'long') {
    const drop = style === 'long' ? 0.30 : 0.15;
    const dr = [];
    const nr = 8;
    for (let i = 0; i < nr; i++) {
      const t = i / (nr - 1);
      const y = 0.130 - t * drop;
      const k = 1 + t * 0.20;
      dr.push({ pts: superEllipse(0.094 * k, 0.098 * k, 2.5, 22), o: [bx, by + y, bz - 0.008 - t * 0.014] });
    }
    const curtain = loft(dr, { capStart: false, capEnd: true });
    computeNormals(curtain);
    /**
     * PART IT OFF THE FACE. The curtain used to be pinned at head-local 0.115
     * dead ahead and only started lifting inside 60 degrees of azimuth, so at
     * 40-60 degrees it hung at eye height right across the socket. Measured:
     * the hair was the nearest surface to an eye on 75% of the camera fan for
     * `coatF`, and the eye was visible on 0% — long-haired pedestrians had no
     * faces at all. Pinning at 0.132 (above the brow ridge) and opening from
     * 71 degrees puts the fall behind the cheekbone, where hair goes.
     */
    warp(curtain, (v) => {
      const x = v.x - bx, z = v.z - bz;
      const front = Math.max(0, Math.cos(Math.atan2(x, z)));
      // The fall sits BEHIND the cheekbone. The ring was 0.098 deep at the
      // front while the face surface at eye height is 0.075 and the eyeball
      // reaches 0.088, so a lock of hair hung 3 mm proud of the eye at
      // x = 0.058 and every long-haired pedestrian was looking through it.
      if (!FACE_LEGACY.on && z > 0) v.z = bz + z * 0.55;
      // ...and it is parted off the brow, not pinned level with the eyes.
      const pin = FACE_LEGACY.on ? 0.115 : 0.132;
      const open = FACE_LEGACY.on ? 0.5 : 0.32;
      if (front > open && v.y < by + pin) {
        v.y = by + pin + (v.y - by - pin) * (1 - (front - open) / (1 - open)) * 0.55;
      }
    });
    computeNormals(curtain);
    displace(curtain, (x, y, z) => {
      const strand = nz.ridge3(x * 80, y * 32, z * 80, 3);
      return (strand - 0.5) * 0.006 + (nz.fbm3(x * 18, y * 12, z * 18, 3) - 0.5) * 0.007;
    });
    appendMesh(out, curtain);
  } else if (style === 'bun') {
    const bun = ellipsoid(0.050, 0.044, 0.046, { seg: 14, rows: 10 });
    computeNormals(bun);
    place(bun, bx, by + 0.198, bz - 0.084, 0.3, 0, 0);
    displace(bun, (x, y, z) => (nz.ridge3(x * 80, y * 80, z * 80, 3) - 0.5) * 0.005);
    appendMesh(out, bun);
  } else if (style === 'tail') {
    const path = [];
    for (let i = 0; i <= 5; i++) {
      const t = i / 5;
      path.push([bx + Math.sin(t * 2.1) * 0.012, by + 0.152 - t * 0.20, bz - 0.088 - t * 0.026]);
    }
    const tail = tube(path, (t) => ellipseProfile(0.030 - t * 0.013, 0.028 - t * 0.012, 12), {
      capStart: false, capEnd: true,
    });
    computeNormals(tail);
    displace(tail, (x, y, z) => (nz.ridge3(x * 70, y * 34, z * 70, 3) - 0.5) * 0.005);
    appendMesh(out, tail);
  }
  computeNormals(out);
  return out;
}

/** Stubble / beard mass on the jaw. */
export function beard(nz, base, k = 1) {
  const bx = base[0], by = base[1], bz = base[2];
  const seg = 22;
  const rings = [];
  const rows = 9;
  // A shell 3 mm off the jaw, from the jawline up to the sideburns and across
  // the top lip. Built from the same section table as the head so it can never
  // drift off it — the first pass lofted its own cone and produced a black
  // bandit mask across the whole lower face.
  for (let r = 0; r < rows; r++) {
    const t = r / (rows - 1);
    const y = 0.002 + t * 0.062;
    headSection(y, _hs);
    const hx = _hs[0] + 0.0048;
    const hz = _hs[1] + 0.0048;
    rings.push({ pts: superEllipse(hx, hz, _hs[3], seg), o: [bx, by + y, bz + _hs[2]] });
  }
  const m = loft(rings, { capStart: true, capEnd: false });
  computeNormals(m);
  // keep the front and the sides, drop the throat, and open the mouth
  warp(m, (v) => {
    const x = v.x - bx, y = v.y - by, z = v.z - bz;
    const a = Math.atan2(x, z);
    const front = Math.cos(a);
    if (front < -0.25) {
      // collapse the back of the shell inside the head so it never draws
      v.x = bx + x * 0.55;
      v.z = bz + z * 0.55;
      v.y = by + Math.min(y, 0.02);
      return;
    }
    // The beard's upper edge: just under the lower lip at the front, up the
    // jawline to a sideburn at the sides. Anything above it collapses inside
    // the head so it never draws — which is what stops a beard becoming a mask
    // across the nose.
    const topY = 0.026 + 0.034 * Math.abs(Math.sin(a)) ** 1.4;
    const over = clamp01((y - topY) / 0.014);
    const shrink = 1 - over * 0.55;
    v.x = bx + x * shrink;
    v.z = bz + z * shrink;
    if (over >= 1) v.y = by + topY + 0.014;
  });
  computeNormals(m);
  displace(m, (x, y, z) => (nz.ridge3(x * 150, y * 150, z * 150, 3) - 0.5) * 0.0026 * k);
  return m;
}


/**
 * HEADGEAR RIMS ARE NOT LEVEL.
 *
 * Every hat here started as a body of revolution, so its rim came out at ONE
 * height all the way round — and that height had to be low enough to cover the
 * ears and the nape, which put it straight through the eyes at the front. The
 * beanie was the worst: its dome ended at head-local y 0.0675, 29 mm BELOW the
 * eye centre and 16 mm below the bottom of the eyeball, so it was not a hat, it
 * was a blindfold. Measured with `faceprobe.mjs`, over a fan of 754 camera
 * directions at conversational height, before this: the beanie was the nearest
 * surface to an eye on 85% of them and the eye was visible on 0%.
 *
 * `RIM_LIFT` raises the FRONT of a rim and leaves the sides and the back where
 * they were, which is how a real hat sits: brow at the front, ears at the side.
 * `front` is 1 dead ahead and 0 at the ear; `low` fades the lift out over the
 * upper part of the shell so the crown keeps its shape.
 */
function rimLift(m, bx, by, bz, lift, topY, span, power = 1.5) {
  if (FACE_LEGACY.on) return m;
  warp(m, (v) => {
    const x = v.x - bx, y = v.y - by, z = v.z - bz;
    if (y > topY) return;
    const a = Math.atan2(x, z);
    const front = Math.max(0, Math.cos(a)) ** power;
    const low = clamp01((topY - y) / span);
    v.y += lift * front * low;
  });
  return m;
}

export function beanie(nz, base) {
  const out = emptyMesh();
  const bx = base[0], by = base[1], bz = base[2];
  const dome = ellipsoid(0.106, 0.132, 0.124, { seg: 20, rows: 11, v0: 0.36, v1: 1 });
  computeNormals(dome);
  place(dome, bx, by + 0.122, bz - 0.012);
  // front rim 0.0675 -> 0.126, above the brow ridge; ears and nape untouched
  rimLift(dome, bx, by, bz, 0.0585, 0.160, 0.100, 1.0);
  computeNormals(dome);
  displace(dome, (x, y, z) => {
    const rib = Math.sin(Math.atan2(x - bx, z - bz) * 26) * 0.5 + 0.5;
    return rib * 0.0028 + (nz.fbm3(x * 30, y * 24, z * 30, 3) - 0.5) * 0.004;
  });
  appendMesh(out, dome);
  // rolled brim — follows the same line, so it still covers the dome's edge
  const pts = [];
  for (let i = 0; i <= 24; i++) {
    const a = (i / 24) * Math.PI * 2;
    const front = Math.max(0, Math.cos(a));
    pts.push([
      bx + Math.sin(a) * 0.106,
      by + 0.126 + front * (FACE_LEGACY.on ? 0 : 0.030),
      bz - 0.012 + Math.cos(a) * 0.124,
    ]);
  }
  const brim = ribbon(pts, 0.040, 0.020, { seg: 8, up: [0, 1, 0], upright: true });
  computeNormals(brim);
  displace(brim, (x, y, z) => {
    const rib = Math.sin(Math.atan2(x - bx, z - bz) * 26) * 0.5 + 0.5;
    return rib * 0.0026;
  });
  appendMesh(out, brim);
  return out;
}

export function flatCap(nz, base) {
  const out = emptyMesh();
  const bx = base[0], by = base[1], bz = base[2];
  const crown = ellipsoid(0.108, 0.074, 0.122, { seg: 20, rows: 9, v0: 0.42, v1: 1 });
  computeNormals(crown);
  warp(crown, (v) => { v.z += Math.max(0, v.y) * 0.35; });
  place(crown, bx, by + 0.146, bz - 0.026, -0.10, 0, 0);
  displace(crown, (x, y, z) => (nz.fbm3(x * 34, y * 30, z * 34, 3) - 0.5) * 0.004);
  appendMesh(out, crown);
  // stiff peak
  const peak = boxRound(0.072, 0.006, 0.052, { n: 3.0, seg: 16, rows: 4, roundY: 0.6 });
  place(peak, bx, by + 0.132, bz + 0.118, -0.22, 0, 0);
  bendY(peak, 0.16, 0.118);
  computeNormals(peak);
  appendMesh(out, peak);
  return out;
}

export function ballCap(nz, base, backwards = false) {
  const out = emptyMesh();
  const bx = base[0], by = base[1], bz = base[2];
  const crown = ellipsoid(0.102, 0.092, 0.118, { seg: 20, rows: 10, v0: 0.40, v1: 1 });
  computeNormals(crown);
  place(crown, bx, by + 0.126, bz - 0.012);
  // front rim 0.0988 -> 0.126: a cap sits ON the brow, it does not cover it
  rimLift(crown, bx, by, bz, 0.0272, 0.155, 0.070, 1.0);
  computeNormals(crown);
  displace(crown, (x, y, z) => {
    const panel = Math.abs(Math.sin(Math.atan2(x - bx, z - bz) * 3));
    return -(1 - panel) * 0.0016 + (nz.fbm3(x * 40, y * 34, z * 40, 2) - 0.5) * 0.0025;
  });
  appendMesh(out, crown);
  const s = backwards ? -1 : 1;
  const peak = boxRound(0.066, 0.005, 0.058, { n: 3.0, seg: 16, rows: 4, roundY: 0.6 });
  place(peak, bx, by + 0.134, bz + s * 0.122, -s * 0.16, backwards ? Math.PI : 0, 0);
  bendY(peak, 0.17, s * 0.122);
  computeNormals(peak);
  appendMesh(out, peak);
  return out;
}

export function hardHat(nz, base) {
  const out = emptyMesh();
  const bx = base[0], by = base[1], bz = base[2];
  // v0 0.40 put the shell rim at head-local 0.0894 — through the middle of the
  // eyeball, all the way round. 0.478 puts it at 0.1187, on the brow line,
  // which is where a hard hat's suspension band actually sits.
  const shell = ellipsoid(0.114, 0.116, 0.132, { seg: 22, rows: 11, v0: FACE_LEGACY.on ? 0.40 : 0.478, v1: 1 });
  computeNormals(shell);
  place(shell, bx, by + 0.124, bz - 0.010);
  // centre ridge
  warp(shell, (v) => {
    const x = v.x - bx;
    v.y += Math.exp(-(x * x) / 0.0006) * 0.008;
  });
  computeNormals(shell);
  displace(shell, (x, y, z) => (nz.fbm3(x * 60, y * 60, z * 60, 2) - 0.5) * 0.0016);
  appendMesh(out, shell);
  // full brim
  const pts = [];
  for (let i = 0; i <= 28; i++) {
    const a = (i / 28) * Math.PI * 2;
    const front = Math.max(0, Math.cos(a));
    pts.push([
      bx + Math.sin(a) * (0.116 + front * 0.014),
      by + 0.134 - front * 0.004,
      bz - 0.010 + Math.cos(a) * (0.124 + front * 0.026),
    ]);
  }
  const brim = ribbon(pts, 0.030, 0.008, { seg: 6, up: [0, 1, 0] });
  computeNormals(brim);
  appendMesh(out, brim);
  return out;
}

/** Hood, worn down: a bunched mass sitting on the shoulders behind the neck. */
export function hoodDown(nz, p = {}) {
  const out = emptyMesh();
  const rings = [];
  for (let i = 0; i < 7; i++) {
    const t = i / 6;
    const y = 1.24 + t * 0.16;
    const r = 0.118 - t * t * 0.038;
    rings.push({ pts: superEllipse(r * 1.06, r * 0.72, 2.6, 20), o: [0, y, -0.088 - t * 0.020] });
  }
  const m = loft(rings, { capStart: true, capEnd: true });
  computeNormals(m);
  displace(m, (x, y, z) => {
    const gather = Math.sin(Math.atan2(x, z) * 8 + y * 24) * 0.5 + 0.5;
    return gather * 0.006 + (nz.fbm3(x * 22, y * 18, z * 22, 3) - 0.5) * 0.006;
  });
  appendMesh(out, m);
  return out;
}

/** Hood, worn up. */
export function hoodUp(nz) {
  const out = emptyMesh();
  const dome = ellipsoid(0.128, 0.152, 0.142, { seg: 20, rows: 12, v0: 0.30, v1: 1 });
  computeNormals(dome);
  place(dome, 0, 1.552, -0.020);
  warp(dome, (v) => {
    // open the face
    const a = Math.atan2(v.x, v.z + 0.02);
    const front = Math.max(0, Math.cos(a));
    // The opening used to be pinned at world y 1.62 — head-local 0.108, which
    // is 8 mm BELOW the brow and over the top of the eyeball — and only opened
    // at all within 53 degrees of dead ahead. 1.640 clears the brow; opening
    // from `front > 0.35` (69 degrees) clears the eyes at the edge of the
    // camera fan too.
    const pin = FACE_LEGACY.on ? 1.62 : 1.646;
    const open = FACE_LEGACY.on ? 0.6 : 0.28;
    if (front > open && v.y < pin) v.y = pin + (v.y - pin) * (1 - (front - open) / (1 - open)) * 0.6;
  });
  computeNormals(dome);
  displace(dome, (x, y, z) => (nz.fbm3(x * 20, y * 16, z * 20, 3) - 0.5) * 0.007);
  appendMesh(out, dome);
  return out;
}

/* ================================================================== */
/* Garment detail                                                     */
/* ================================================================== */

/** Coat lapels + the placket down the front. */
export function lapels(nz, p = {}) {
  const out = emptyMesh();
  const top = p.top ?? 1.372;
  const notch = p.notch ?? 1.230;
  const w = p.w ?? 1;
  const fz = p.frontZ ?? ((y) => 0.118);
  const lift = 0.006;
  for (const side of [-1, 1]) {
    const pts = [
      [side * 0.055 * w, top, fz(top) - 0.030],
      [side * 0.082 * w, top - 0.042, fz(top - 0.042) + lift * 0.5],
      [side * 0.062 * w, notch, fz(notch) + lift],
      [side * 0.024 * w, notch - 0.076, fz(notch - 0.076) + lift],
    ];
    const l = ribbon(pts, 0.060, 0.011, { seg: 6, up: [0, 0, 1] });
    computeNormals(l);
    displace(l, (x, y, z) => (nz.fbm3(x * 30, y * 26, z * 30, 3) - 0.5) * 0.0022);
    appendMesh(out, l);
  }
  // the front edge of the coat, offset off the centreline like a real overlap
  const hem = p.hem ?? 0.66;
  const pl = [];
  const n = 6;
  for (let i = 0; i <= n; i++) {
    const t = i / n;
    const y = notch - 0.076 - t * (notch - 0.076 - hem);
    pl.push([0.020, y, fz(y) + lift]);
  }
  const placket = ribbon(pl, 0.046, 0.009, { seg: 5, up: [0, 0, 1] });
  computeNormals(placket);
  displace(placket, (x, y, z) => (nz.fbm3(x * 26, y * 22, z * 26, 3) - 0.5) * 0.0024);
  appendMesh(out, placket);
  return out;
}

/** Collar band standing at the neck. */
export function collar(nz, p = {}) {
  const seg = 22;
  const y0 = p.y ?? 1.398;
  const r = p.r ?? 1;
  const rings = [
    [y0, 0.104 * r, 0.092 * r],
    [y0 + 0.034, 0.094 * r, 0.086 * r],
    [y0 + 0.062, 0.090 * r, 0.084 * r],
    [y0 + 0.076, 0.096 * r, 0.090 * r],
  ].map(([y, hx, hz]) => ({ pts: superEllipse(hx, hz, 2.6, seg), o: [0, y, -0.006] }));
  const m = loft(rings, { capStart: false, capEnd: true });
  computeNormals(m);
  // open at the front for a shirt collar
  if (p.open) {
    warp(m, (v) => {
      const a = Math.atan2(v.x, v.z);
      const front = Math.max(0, Math.cos(a));
      if (front > 0.4) v.y -= (front - 0.4) * 0.10;
      v.z += front * 0.006;
    });
    computeNormals(m);
  }
  displace(m, (x, y, z) => nz.fbm3(x * 40, y * 30, z * 40, 2) * 0.0026);
  return m;
}

export function tie() {
  const out = emptyMesh();
  const knot = boxRound(0.017, 0.020, 0.012, { n: 3.4, seg: 12, rows: 5, roundY: 0.5 });
  place(knot, 0, 1.398, 0.088, -0.12, 0, 0);
  computeNormals(knot);
  appendMesh(out, knot);
  const pts = [];
  for (let i = 0; i <= 5; i++) {
    const t = i / 5;
    pts.push([0, 1.380 - t * 0.30, 0.092 + Math.sin(t * 2.4) * 0.012 - t * 0.006]);
  }
  const blade = tube(pts, (t) => superEllipse(0.012 + t * 0.014, 0.005, 3.2, 10), {
    capStart: true, capEnd: true,
  });
  computeNormals(blade);
  appendMesh(out, blade);
  return out;
}

export function buttons(count, y0, y1, frontZ, r = 0.0085) {
  const out = emptyMesh();
  for (let i = 0; i < count; i++) {
    const t = count === 1 ? 0 : i / (count - 1);
    const y = y0 + (y1 - y0) * t;
    const b = ellipsoid(r, r * 0.35, r, { seg: 10, rows: 5 });
    computeNormals(b);
    place(b, 0.020, y, frontZ(y) + 0.010, Math.PI / 2, 0, 0);
    appendMesh(out, b);
  }
  return out;
}

export function belt(nz, y = 0.972, r = 1) {
  const out = emptyMesh();
  const pts = [];
  const n = 24;
  for (let i = 0; i <= n; i++) {
    const a = (i / n) * Math.PI * 2;
    pts.push([Math.sin(a) * 0.150 * r, y, Math.cos(a) * 0.108 * r - 0.006]);
  }
  const b = ribbon(pts, 0.040, 0.014, { seg: 7, up: [0, 1, 0], upright: true });
  computeNormals(b);
  displace(b, (x, y2, z) => nz.fbm3(x * 40, y2 * 40, z * 40, 2) * 0.0015);
  appendMesh(out, b);
  const buckle = boxRound(0.020, 0.016, 0.006, { n: 3.4, seg: 10, rows: 4, roundY: 0.5 });
  place(buckle, 0, y, 0.104 * r, 0, 0, 0);
  computeNormals(buckle);
  appendMesh(out, buckle);
  return out;
}

/** Hi-vis waistcoat over the torso, with two reflective bands. */
export function hiVis(nz, p = {}) {
  const out = emptyMesh();
  const rows = 9;
  const seg = 24;
  const rings = [];
  for (let i = 0; i < rows; i++) {
    const t = i / (rows - 1);
    const y = 0.900 + t * 0.470;
    const b = t;
    const hx = 0.172 + 0.016 * smoothstep(0.35, 0.9, b) - 0.010 * Math.exp(-((b - 0.28) ** 2) / 0.04);
    const hz = 0.120 + 0.014 * smoothstep(0.35, 0.9, b);
    rings.push({ pts: superEllipse(hx * (p.bulk ?? 1), hz * (p.bulk ?? 1), 2.7, seg), o: [0, y, 0.002] });
  }
  const m = loft(rings, { capStart: false, capEnd: false });
  computeNormals(m);
  // cut the armholes and open the front
  warp(m, (v) => {
    const a = Math.atan2(v.x, v.z);
    const side = Math.abs(Math.sin(a));
    if (v.y > 1.28 && side > 0.86) v.y = 1.28 + (v.y - 1.28) * 0.2;
  });
  computeNormals(m);
  displace(m, (x, y, z) => (nz.fbm3(x * 26, y * 22, z * 26, 3) - 0.5) * 0.004);
  appendMesh(out, m);
  return out;
}

/** Two reflective bands round the vest — their own palette slot. */
export function hiVisBands(p = {}) {
  const out = emptyMesh();
  for (const y of [1.028, 1.140]) {
    const pts = [];
    const n = 26;
    for (let i = 0; i <= n; i++) {
      const a = (i / n) * Math.PI * 2;
      pts.push([Math.sin(a) * 0.180 * (p.bulk ?? 1), y, Math.cos(a) * 0.128 * (p.bulk ?? 1) + 0.002]);
    }
    const band = ribbon(pts, 0.042, 0.005, { seg: 5, up: [0, 1, 0], upright: true });
    computeNormals(band);
    appendMesh(out, band);
  }
  // shoulder bands
  for (const side of [-1, 1]) {
    const pts = [
      [side * 0.070, 1.352, 0.100],
      [side * 0.104, 1.386, 0.010],
      [side * 0.092, 1.352, -0.086],
    ];
    const b = ribbon(pts, 0.040, 0.005, { seg: 5, up: [0, 1, 0] });
    computeNormals(b);
    appendMesh(out, b);
  }
  return out;
}

/* ================================================================== */
/* Hands                                                              */
/* ================================================================== */

/**
 * A relaxed human hand — palm, four separately modelled fingers with two
 * phalanges each, and an opposed thumb. The "hands are mittens" note is the
 * cheapest thing to fail and the most obvious at 2 m, so the fingers are real
 * tapered tubes with knuckle swells, splayed slightly and curled by `curl`.
 *
 * `down` is the direction the fingers point, `palmN` the palm's outward normal.
 */
export function hand(nz, wrist, down, palmN, side, opts = {}) {
  const out = emptyMesh();
  const W = new THREE.Vector3(...wrist);
  const D = new THREE.Vector3(...down).normalize();
  const N = new THREE.Vector3(...palmN).normalize();
  const S = new THREE.Vector3().crossVectors(D, N).normalize(); // across the hand
  const curl = opts.curl ?? 0.5;
  const k = opts.scale ?? 1;

  // ---- palm: a tapered slab, wider at the knuckles than at the wrist
  const palmRings = [];
  const nP = 6;
  for (let i = 0; i < nP; i++) {
    const t = i / (nP - 1);
    const hx = (0.021 + t * 0.019) * k;   // across
    const hz = (0.017 - t * 0.005) * k;   // through
    palmRings.push({
      pts: superEllipse(hx, hz, 3.0, 14),
      o: [
        W.x + D.x * t * 0.084 * k,
        W.y + D.y * t * 0.084 * k,
        W.z + D.z * t * 0.084 * k,
      ],
      q: quatFromBasis(S, D, N),
    });
  }
  const palm = loft(palmRings, { capStart: true, capEnd: false });
  computeNormals(palm);
  // thenar eminence: the pad at the base of the thumb
  const thumbSide = -side;
  displace(palm, (x, y, z, nx, ny, nz3) => {
    const q = new THREE.Vector3(x - W.x, y - W.y, z - W.z);
    const alongS = q.dot(S) * thumbSide;
    const alongD = q.dot(D);
    const pad = Math.exp(-((alongS - 0.016 * k) ** 2) / (0.0004 * k * k)) *
      Math.exp(-((alongD - 0.030 * k) ** 2) / (0.0012 * k * k));
    return pad * 0.008 * k + nz.fbm3(x * 90, y * 90, z * 90, 2) * 0.0009;
  });
  computeNormals(palm);
  appendMesh(out, palm);

  // ---- fingers
  const lens = [0.078, 0.084, 0.079, 0.062].map((v) => v * k);
  const rads = [0.0098, 0.0102, 0.0096, 0.0082].map((v) => v * k);
  for (let f = 0; f < 4; f++) {
    const across = (f - 1.5) * 0.0175 * k * side;
    const base = W.clone()
      .addScaledVector(D, 0.084 * k)
      .addScaledVector(S, across)
      .addScaledVector(N, -0.001 * k);
    const pts = [];
    const nSeg = 5;
    const L = lens[f];
    // curl: the fingers roll around an axis parallel to S
    for (let i = 0; i <= nSeg; i++) {
      const u = i / nSeg;
      const ang = curl * (0.55 + u * 1.25);
      const p = base.clone()
        .addScaledVector(D, Math.cos(ang) * L * u)
        .addScaledVector(N, -Math.sin(ang) * L * u * 0.85)
        .addScaledVector(S, across * u * 0.28);
      pts.push([p.x, p.y, p.z]);
    }
    const fin = tube(
      pts,
      (u) => {
        const knuckle = 1 + 0.16 * Math.exp(-((u - 0.36) ** 2) / 0.012) + 0.12 * Math.exp(-((u - 0.72) ** 2) / 0.010);
        const r = rads[f] * (1 - u * 0.30) * knuckle;
        return ellipseProfile(r, r * 0.92, 8);
      },
      { capStart: false, capEnd: true }
    );
    computeNormals(fin);
    appendMesh(out, fin);
  }

  // ---- thumb: out of the side of the palm and forward
  {
    const base = W.clone()
      .addScaledVector(D, 0.032 * k)
      .addScaledVector(S, thumbSide * 0.024 * k)
      .addScaledVector(N, -0.004 * k);
    const pts = [];
    for (let i = 0; i <= 4; i++) {
      const u = i / 4;
      const p = base.clone()
        .addScaledVector(D, u * 0.052 * k)
        .addScaledVector(S, thumbSide * u * 0.020 * k)
        .addScaledVector(N, -Math.sin(u * curl * 1.3) * 0.026 * k);
      pts.push([p.x, p.y, p.z]);
    }
    const th = tube(pts, (u) => {
      const r = 0.0118 * k * (1 - u * 0.26) * (1 + 0.15 * Math.exp(-((u - 0.55) ** 2) / 0.02));
      return ellipseProfile(r, r * 0.9, 8);
    }, { capStart: true, capEnd: true });
    computeNormals(th);
    appendMesh(out, th);
  }

  computeNormals(out);
  displace(out, (x, y, z) => nz.fbm3(x * 120, y * 120, z * 120, 2) * 0.0007);
  return out;
}

function quatFromBasis(x, y, z) {
  const m = new THREE.Matrix4().makeBasis(x, y, z);
  return new THREE.Quaternion().setFromRotationMatrix(m);
}

/* ================================================================== */
/* Feet                                                               */
/* ================================================================== */

/**
 * Footwear. `kind` changes the silhouette, which is the only thing that reads
 * at range: 'dress' low and pointed, 'boot' with an ankle shaft, 'trainer'
 * chunky with a thick midsole, 'heel' with a raised heel block.
 */
export function shoe(nz, ankle, side, kind = 'dress') {
  const out = emptyMesh();
  const ax = ankle[0], ay = ankle[1], az = ankle[2];
  const K = {
    dress: { h: 0.052, w: 0.045, toe: 0.132, back: -0.070, taper: 0.55, sole: 0.012 },
    boot: { h: 0.062, w: 0.050, toe: 0.126, back: -0.072, taper: 0.70, sole: 0.020 },
    trainer: { h: 0.062, w: 0.052, toe: 0.130, back: -0.074, taper: 0.75, sole: 0.026 },
    heel: { h: 0.046, w: 0.040, toe: 0.136, back: -0.062, taper: 0.42, sole: 0.008 },
    work: { h: 0.068, w: 0.054, toe: 0.128, back: -0.076, taper: 0.80, sole: 0.028 },
  }[kind] ?? { h: 0.052, w: 0.045, toe: 0.132, back: -0.070, taper: 0.55, sole: 0.012 };

  const S = [
    [K.back, K.w * 0.78, K.h * 0.72, 0.050],
    [K.back * 0.62, K.w * 0.96, K.h * 0.94, 0.058],
    [-0.014, K.w, K.h, 0.055],
    [0.032, K.w * 0.99, K.h * 0.92, 0.046],
    [0.074, K.w * 0.94, K.h * 0.76, 0.036],
    [0.106, K.w * 0.82, K.h * 0.56, 0.028],
    [K.toe, K.w * K.taper, K.h * 0.34, 0.022],
  ];
  const seg = 18;
  const q = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), Math.PI / 2);
  const rings = S.map(([z, hx, hy, cy]) => ({
    pts: superEllipse(hx, hy, 2.7, seg),
    o: [ax, ay - 0.082 + cy, az + z],
    q,
  }));
  const upper = loft(rings, { capStart: true, capEnd: true });
  computeNormals(upper);
  displace(upper, (x, y, z) => {
    const crease = Math.abs(Math.sin((z - az) * 60)) ** 0.7;
    const flex = Math.exp(-((z - az - 0.05) ** 2) / 0.0012);
    return -crease * flex * 0.0018 + nz.fbm3(x * 60, y * 60, z * 60, 3) * 0.0018;
  });
  appendMesh(out, upper);

  if (kind === 'boot' || kind === 'work') {
    const shaft = tube(
      [
        [ax, ay + 0.008, az - 0.004],
        [ax, ay + 0.062, az - 0.002],
        [ax, ay + 0.112, az + 0.004],
      ],
      (t) => ellipseProfile(0.056 - 0.004 * t, 0.050 - 0.002 * t, 16),
      { capStart: false, capEnd: false }
    );
    computeNormals(shaft);
    displace(shaft, (x, y, z) => nz.fbm3(x * 44, y * 44, z * 44, 3) * 0.0024);
    appendMesh(out, shaft);
  }
  return out;
}

/** Sole + heel block, its own (rubber) material. */
export function shoeSole(ankle, kind = 'dress') {
  const K = {
    dress: { th: 0.011, heel: 0.014, w: 0.045, toe: 0.130, back: -0.068 },
    boot: { th: 0.018, heel: 0.020, w: 0.050, toe: 0.124, back: -0.070 },
    trainer: { th: 0.026, heel: 0.014, w: 0.053, toe: 0.128, back: -0.072 },
    heel: { th: 0.008, heel: 0.062, w: 0.040, toe: 0.134, back: -0.058 },
    work: { th: 0.028, heel: 0.020, w: 0.055, toe: 0.126, back: -0.074 },
  }[kind] ?? { th: 0.011, heel: 0.014, w: 0.045, toe: 0.130, back: -0.068 };
  const ax = ankle[0], ay = ankle[1], az = ankle[2];
  const S = [
    [K.back, K.w * 0.80],
    [K.back * 0.6, K.w * 0.98],
    [-0.014, K.w],
    [0.036, K.w * 0.99],
    [0.084, K.w * 0.93],
    [K.toe, K.w * 0.62],
  ];
  const q = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), Math.PI / 2);
  const rings = S.map(([z, hx]) => ({
    pts: superEllipse(hx, K.th * 0.5, 3.6, 16),
    o: [ax, ay - 0.082 + K.th * 0.5 + 0.001, az + z],
    q,
  }));
  const m = loft(rings, { capStart: true, capEnd: true });
  computeNormals(m);
  const heel = boxRound(K.w * 0.72, K.heel * 0.5, kind === 'heel' ? 0.020 : 0.030, {
    n: 4, seg: 12, rows: 4, roundY: 0.35,
  });
  place(heel, ax, ay - 0.082 + K.heel * 0.5, az - 0.048);
  appendMesh(m, heel);
  computeNormals(m);
  return m;
}

/* ================================================================== */
/* Carried things                                                     */
/* ================================================================== */

export function backpack(nz) {
  const out = emptyMesh();
  const body = boxRound(0.135, 0.190, 0.092, { n: 3.6, seg: 18, rows: 9, roundY: 0.34 });
  place(body, 0, 1.212, -0.196);
  computeNormals(body);
  displace(body, (x, y, z) => (nz.fbm3(x * 34, y * 30, z * 34, 3) - 0.5) * 0.004);
  appendMesh(out, body);
  // lid pocket
  const lid = boxRound(0.104, 0.052, 0.040, { n: 3.6, seg: 14, rows: 5, roundY: 0.5 });
  place(lid, 0, 1.288, -0.258, 0.18, 0, 0);
  computeNormals(lid);
  appendMesh(out, lid);
  // straps over the shoulders
  for (const side of [-1, 1]) {
    const pts = [
      [side * 0.084, 1.360, -0.114],
      [side * 0.096, 1.394, 0.006],
      [side * 0.082, 1.300, 0.098],
      [side * 0.062, 1.180, 0.088],
    ];
    const s = ribbon(pts, 0.048, 0.014, { seg: 6, up: [0, 1, 0] });
    computeNormals(s);
    appendMesh(out, s);
  }
  return out;
}

export function shoulderBag(nz, side = 1) {
  const out = emptyMesh();
  const body = boxRound(0.108, 0.086, 0.048, { n: 3.4, seg: 16, rows: 8, roundY: 0.38 });
  place(body, side * 0.150, 0.986, -0.024, 0, side * 0.22, side * 0.10);
  computeNormals(body);
  displace(body, (x, y, z) => (nz.fbm3(x * 40, y * 36, z * 40, 3) - 0.5) * 0.004);
  appendMesh(out, body);
  const strap = ribbon(
    [
      [side * 0.148, 1.052, 0.026],
      [side * 0.132, 1.220, 0.062],
      [side * 0.020, 1.372, 0.036],
      [-side * 0.058, 1.372, -0.038],
      [-side * 0.020, 1.300, -0.086],
    ],
    0.030,
    0.008,
    { seg: 5, up: [0, 1, 0] }
  );
  computeNormals(strap);
  appendMesh(out, strap);
  return out;
}
