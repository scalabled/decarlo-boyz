#!/usr/bin/env node
/**
 * EYE GATE — "can you ever see an eye from behind (or the side of) the head?"
 *
 * The head/hair gate (`src/player/character/headprobe.mjs`) rays the PLAYER
 * brother's head and checks the fringe never buries the eyes FROM THE FRONT.
 * Nothing checked the pedestrian head, and nothing checked the eyes from the
 * BACK — the failure mode where a full-sphere eyeball set too shallow, mirrored,
 * or on a head scaled narrower than the eye placement assumed, shows its white
 * sclera through the skull.
 *
 * This rebuilds each pedestrian silhouette's head from the SAME part functions
 * `builder.js` emits (skull, nose, ears, neck, hair, lids, brows, eyes — all
 * rigidly on the Head bone, so bind-pose geometry is the drawn geometry at every
 * animation state), fires a Fibonacci sphere of rays at it and asks, for each
 * ray, what the NEAREST surface is. It then asserts:
 *
 *   1 REAR   no ray arriving from behind the head (origin on the -Z hemisphere)
 *            has an eye surface as its nearest hit.
 *   2 ARC    no eye is the nearest hit beyond MAX_ARC degrees off dead-ahead —
 *            an eye lives on the face, not round the side of the skull.
 *
 * This measures the EMITTED eye and skull triangles against each other
 * (ARCHITECTURE.md rule 12); it does not consult the placement arithmetic. The
 * skull is the occluder and the eye is the occludee, and neither is told what
 * the other decided.
 *
 *   node src/peds/eyeprobe.mjs
 *   node src/peds/eyeprobe.mjs --mirror   # NEGATIVE CONTROL, must fail
 *
 * `--mirror` adds a second eyeball mirrored onto the BACK of the skull, proud of
 * it — the "eyes on the back of the head" defect made real — and the gate goes
 * red, which is what proves it has teeth.
 */
import { RIG } from './rig.js';
import { Noise, ellipsoid, computeNormals } from './geo.js';
import * as P from './parts.js';
import { SHAPES, SHAPE_IDS } from './wardrobe.js';
import { Rng } from '../core/rng.js';

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const m = a.match(/^--([^=]+)(?:=(.*))?$/);
    return m ? [m[1], m[2] ?? true] : [a, true];
  })
);

const bp = (n) => RIG.pos(n);
const NDIR = Number(args.dirs ?? 12000);
const MAX_ARC = 55;     // degrees off dead-ahead an eye may still be visible
const EYE_X = 0.0315, EYE_Y = 0.0965, EYE_R = 0.0130;

function rayTri(ox, oy, oz, dx, dy, dz, a) {
  const e1x = a[3] - a[0], e1y = a[4] - a[1], e1z = a[5] - a[2];
  const e2x = a[6] - a[0], e2y = a[7] - a[1], e2z = a[8] - a[2];
  const px = dy * e2z - dz * e2y, py = dz * e2x - dx * e2z, pz = dx * e2y - dy * e2x;
  const det = e1x * px + e1y * py + e1z * pz;
  if (det > -1e-12 && det < 1e-12) return -1;
  const inv = 1 / det;
  const tx = ox - a[0], ty = oy - a[1], tz = oz - a[2];
  const u = (tx * px + ty * py + tz * pz) * inv;
  if (u < 0 || u > 1) return -1;
  const qx = ty * e1z - tz * e1y, qy = tz * e1x - tx * e1z, qz = tx * e1y - ty * e1x;
  const v = (dx * qx + dy * qy + dz * qz) * inv;
  if (v < 0 || u + v > 1) return -1;
  const d = (e2x * qx + e2y * qy + e2z * qz) * inv;
  return d > 1e-6 ? d : -1;
}

function trisInto(out, mesh, label) {
  if (!mesh || !mesh.p || !mesh.p.length) return;
  const p = mesh.p, idx = mesh.i;
  for (let k = 0; k < idx.length; k += 3) {
    const a = idx[k] * 3, b = idx[k + 1] * 3, c = idx[k + 2] * 3;
    out.push([p[a], p[a + 1], p[a + 2], p[b], p[b + 1], p[b + 2], p[c], p[c + 1], p[c + 2], label]);
  }
}

function fibonacci(n) {
  const out = [];
  const g = Math.PI * (3 - Math.sqrt(5));
  for (let i = 0; i < n; i++) {
    const y = 1 - (i / (n - 1)) * 2;
    const r = Math.sqrt(Math.max(0, 1 - y * y));
    const th = g * i;
    out.push([Math.cos(th) * r, y, Math.sin(th) * r]);
  }
  return out;
}

/** The "eyes on the back of the head" defect, built on purpose for the control:
 *  the eyeball reflected through z=0 and set proud of the rear skull surface. */
function mirroredEye(head, side) {
  const m = ellipsoid(EYE_R, EYE_R, EYE_R, { seg: 14, rows: 9 });
  computeNormals(m);
  const p = m.p;
  for (let i = 0; i < p.length; i += 3) {
    p[i] += head[0] + side * EYE_X;
    p[i + 1] += head[1] + EYE_Y;
    p[i + 2] += head[2] - 0.108; // proud of the rear cranium at eye height
  }
  return m;
}

let rearHits = 0, worstArc = 0, worstWhere = '';
const dirs = fibonacci(NDIR);

for (const shapeId of SHAPE_IDS) {
  const S = SHAPES[shapeId];
  const nz = new Noise(new Rng(0x9051e ^ (shapeId.length * 6151)).fork());
  const head = bp('Head');
  const wide = S.bust ? 0.978 : 1.0, jaw = S.bust ? 0.92 : 1.0, cheek = S.bust ? 1.15 : 1;

  const tris = [];
  trisInto(tris, P.headMesh(nz, head, { wide, jaw, cheek }), 'skull');
  trisInto(tris, P.nose(nz, head, { size: S.bust ? 0.9 : 1 }), 'skull');
  if (!S.hat || S.hat === 'flat') {
    trisInto(tris, P.ear(nz, head, -1), 'skull');
    trisInto(tris, P.ear(nz, head, 1), 'skull');
  }
  trisInto(tris, P.neck(nz, head, S.bust ? 0.9 : 1), 'skull');
  if (S.hair && S.hair !== 'bald') trisInto(tris, P.hair(nz, head, S.hair, { recede: S.bust ? 0.18 : 0.4 }), 'hair');
  trisInto(tris, P.lips(head), 'skull');
  trisInto(tris, P.eyelid(head, -1), 'skull');
  trisInto(tris, P.eyelid(head, 1), 'skull');
  trisInto(tris, P.lowerLid(head, -1), 'skull');
  trisInto(tris, P.lowerLid(head, 1), 'skull');
  trisInto(tris, P.brows(head, -1), 'skull');
  trisInto(tris, P.brows(head, 1), 'skull');
  for (const side of [-1, 1]) {
    trisInto(tris, P.eyeball(head, side), 'eye');
    trisInto(tris, P.iris(head, side), 'eye');
    if (args.mirror) trisInto(tris, mirroredEye(head, side), 'eye');
  }

  const cx = head[0], cy = head[1] + 0.09, cz = head[2] + 0.01;
  const R = 0.5;
  for (const d of dirs) {
    const ox = cx + d[0] * R, oy = cy + d[1] * R, oz = cz + d[2] * R;
    let best = Infinity, lab = '';
    for (const t of tris) {
      const dd = rayTri(ox, oy, oz, -d[0], -d[1], -d[2], t);
      if (dd >= 0 && dd < best) { best = dd; lab = t[9]; }
    }
    if (lab !== 'eye') continue;
    // front is +z; behind = origin on the rear hemisphere
    if (d[2] < -0.35) rearHits++;
    const arc = Math.abs(Math.atan2(d[0], d[2]) * 180 / Math.PI);
    if (arc > worstArc) { worstArc = arc; worstWhere = shapeId; }
  }
}

console.log(`\n=== eyeprobe — ${SHAPE_IDS.length} silhouettes x ${NDIR} rays` +
  `${args.mirror ? '  \x1b[31m[MIRROR / NEGATIVE CONTROL]\x1b[0m' : ''} ===\n`);
console.log(`  1 REAR  eye is nearest hit from behind the head : ${rearHits}  (want 0)`);
console.log(`  2 ARC   widest bearing an eye is the nearest hit : ${worstArc.toFixed(0)} deg ${worstWhere}  (want <= ${MAX_ARC})`);

const bad = [];
if (rearHits > 0) bad.push(`REAR ${rearHits}`);
if (worstArc > MAX_ARC) bad.push(`ARC ${worstArc.toFixed(0)}deg`);
console.log(bad.length ? `\nFAIL: ${bad.join(', ')}\n` : '\nPASS\n');
process.exit(bad.length ? 1 : 0);
