#!/usr/bin/env node
/**
 * Head coverage gate — the mechanical answer to "can you ever see scalp?".
 *
 * Renders nothing. It takes the geometry `buildBody()` actually emits, fires a
 * ray at the head from every direction on a Fibonacci sphere and asks what the
 * NEAREST surface is, then checks four things that have each been shipped
 * broken at least once:
 *
 *   1 SCALP     no bare skin anywhere on the cranium, measured against an
 *               anatomical target hairline held in THIS file — deliberately not
 *               the one mesh.js builds to, so the test cannot pass by agreeing
 *               with the bug. Failed the whole back and both temples before the
 *               2nd hair fix.
 *   2 FRINGE    no hair below the eyebrows at the front. Failed before the 1st
 *               hair fix, when the fringe hung over the eyes and the nose came
 *               back out through it.
 *   3 BROWS     the eyebrows are actually visible from the front. Also failed
 *               before the 1st fix — every brow vertex sat inside the head.
 *   4 EARS      the hair shell has not swallowed the ears. This is the failure
 *               the 1st fix was AVOIDING when it shrank the cap into a swim cap
 *               and caused defect 1, so it is now measured rather than traded.
 *   5 RIGID     every vertex of the skull, ears, brows, eyes and hair is
 *               weighted 100% to the `head` bone. This is what makes 1-4
 *               animation-independent: a single-bone assembly can only ever be
 *               moved by a RIGID transform, which cannot change what occludes
 *               what. If this ever fails, 1-4 stop covering every pose and the
 *               head has to be re-checked per animation state.
 *
 * Why a ray probe and not screenshots: a screenshot only proves the angles you
 * remembered to shoot. This proves all of them at once, and because the whole
 * head assembly — skull, ears, eyes, brows, hair — is weighted rigidly to one
 * bone (`single('head')`), the result is invariant under every animation state,
 * every LOD and every camera position by construction.
 *
 *   node src/player/character/headprobe.mjs           # gate, exits non-zero
 *   node src/player/character/headprobe.mjs --map     # + an ASCII sphere map
 *   node src/player/character/headprobe.mjs --dirs=60000
 */
import { buildBody, MAT, BONE_INDEX } from './mesh.js';
import { BROTHERS } from '../brothers.js';

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const m = a.match(/^--([^=]+)(?:=(.*))?$/);
    return m ? [m[1], m[2] ?? true] : [a, true];
  })
);

const NDIR = Number(args.dirs ?? 24000);
const SKIN = new Set([MAT.skin, MAT.face]);

/**
 * THE TARGET HAIRLINE — head-local metres against azimuth u, where u = 0 is
 * dead ahead, 0.5 is the ear and 1 is the nape. Everything on the skull ABOVE
 * this curve must be covered by hair; skin found above it is a bald patch.
 *
 * These are anatomy, and they are deliberately looser than the hairline mesh.js
 * actually builds (front 0.070-0.072, ear 0.040-0.043, nape -0.036..-0.074), so
 * there is real margin in every direction and the gate is not a tautology.
 */
const MUST_COVER = [
  [0.00, 0.080], // forehead — above the brow ridge, hair from here up
  [0.26, 0.070],
  [0.42, 0.052], // temple, above the ear (whose helix tops out at +0.037)
  [0.58, 0.050],
  [0.70, 0.006], // behind the ear the hairline is already at lobe height
  [1.00, -0.022], // the NAPE must be covered, not just the crown
];

/**
 * The ear, for gate 4 only. Position alone is not enough — the side of the
 * skull lives in the same box — so an ear triangle is one that also stands
 * PROUD of the skull ellipsoid, which is the one thing the cranium never does.
 *
 * Gate 1 needs no ear exemption: the helix tops out at y = +0.037 and the
 * target hairline over the ear is +0.046, so an ear can never be mistaken for
 * exposed scalp.
 */
const EAR_BOX = { x: 0.052, y: [-0.045, 0.045], z: [-0.020, 0.035], bulge: 1.03 };

/** Cosine-interpolated piecewise profile — the same one mesh.js authors with. */
function prof(t, keys) {
  if (t <= keys[0][0]) return keys[0][1];
  const last = keys.length - 1;
  if (t >= keys[last][0]) return keys[last][1];
  let i = 0;
  while (i < last && t > keys[i + 1][0]) i++;
  const f = (t - keys[i][0]) / (keys[i + 1][0] - keys[i][0]);
  const e = 0.5 - 0.5 * Math.cos(f * Math.PI);
  return keys[i][1] + (keys[i + 1][1] - keys[i][1]) * e;
}

/** Head-local frame for one brother, mirroring buildHead(). */
function headFrame(build, positions) {
  const S = build.scale ?? 1;
  const hs = (build.headScale ?? 1) * S;
  const hb = positions.head;
  return { hs, c: [hb[0], hb[1] + 0.096 * hs, hb[2] + 0.004 * hs] };
}

/** Azimuth round the skull: 0 dead ahead, 0.5 at the ear, 1 at the nape. */
function azim(x, z) {
  return Math.atan2(Math.abs(x) / 0.0715, -z / 0.0935) / Math.PI;
}

/** Triangles within `radius` of the head centre, tagged with their material. */
function headTriangles(geometry, c, hs, radius) {
  const pos = geometry.attributes.position.array;
  const idx = geometry.index.array;
  const tris = [];
  const r2 = radius * radius;
  for (const g of geometry.groups) {
    for (let i = g.start; i < g.start + g.count; i += 3) {
      const a = idx[i] * 3, b = idx[i + 1] * 3, k = idx[i + 2] * 3;
      let near = false;
      for (const o of [a, b, k]) {
        const dx = pos[o] - c[0], dy = pos[o + 1] - c[1], dz = pos[o + 2] - c[2];
        if (dx * dx + dy * dy + dz * dz <= r2) { near = true; break; }
      }
      if (!near) continue;
      const cx = (pos[a] + pos[b] + pos[k]) / 3 - c[0];
      const cy = (pos[a + 1] + pos[b + 1] + pos[k + 1]) / 3 - c[1];
      const cz = (pos[a + 2] + pos[b + 2] + pos[k + 2]) / 3 - c[2];
      const lx = cx / hs, ly = cy / hs, lz = cz / hs;
      const bulge = (lx / 0.0715) ** 2 + (ly / 0.108) ** 2 + (lz / 0.0935) ** 2;
      const isEar = g.materialIndex === MAT.face && Math.abs(lx) > EAR_BOX.x &&
        ly > EAR_BOX.y[0] && ly < EAR_BOX.y[1] &&
        lz > EAR_BOX.z[0] && lz < EAR_BOX.z[1] && bulge > EAR_BOX.bulge;
      tris.push([
        pos[a], pos[a + 1], pos[a + 2],
        pos[b], pos[b + 1], pos[b + 2],
        pos[k], pos[k + 1], pos[k + 2],
        g.materialIndex, isEar ? 1 : 0, lx, ly, lz,
      ]);
    }
  }
  return tris;
}

/** Moller-Trumbore, two-sided: a back-facing hit still occludes visually. */
function rayTri(ox, oy, oz, dx, dy, dz, t) {
  const e1x = t[3] - t[0], e1y = t[4] - t[1], e1z = t[5] - t[2];
  const e2x = t[6] - t[0], e2y = t[7] - t[1], e2z = t[8] - t[2];
  const px = dy * e2z - dz * e2y, py = dz * e2x - dx * e2z, pz = dx * e2y - dy * e2x;
  const det = e1x * px + e1y * py + e1z * pz;
  if (det > -1e-12 && det < 1e-12) return -1;
  const inv = 1 / det;
  const tx = ox - t[0], ty = oy - t[1], tz = oz - t[2];
  const u = (tx * px + ty * py + tz * pz) * inv;
  if (u < 0 || u > 1) return -1;
  const qx = ty * e1z - tz * e1y, qy = tz * e1x - tx * e1z, qz = tx * e1y - ty * e1x;
  const v = (dx * qx + dy * qy + dz * qz) * inv;
  if (v < 0 || u + v > 1) return -1;
  const d = (e2x * qx + e2y * qy + e2z * qz) * inv;
  return d > 1e-6 ? d : -1;
}

/**
 * Nearest surface along a ray. The classification uses the actual HIT POINT,
 * not the triangle centroid — a skull quad is ~8 mm tall, so a centroid is up
 * to 3 mm off, which is the same order as the margins this gate measures.
 */
function nearest(tris, ox, oy, oz, dx, dy, dz, c, hs) {
  let best = Infinity, hit = null;
  for (let i = 0; i < tris.length; i++) {
    const d = rayTri(ox, oy, oz, dx, dy, dz, tris[i]);
    if (d >= 0 && d < best) { best = d; hit = tris[i]; }
  }
  if (!hit) return null;
  return {
    mat: hit[9],
    ear: hit[10] === 1,
    t: hit,
    dist: best,
    x: (ox + dx * best - c[0]) / hs,
    y: (oy + dy * best - c[1]) / hs,
    z: (oz + dz * best - c[2]) / hs,
  };
}

function fibonacci(n) {
  const out = [];
  const golden = Math.PI * (3 - Math.sqrt(5));
  for (let i = 0; i < n; i++) {
    const y = 1 - (i / (n - 1)) * 2;
    const r = Math.sqrt(Math.max(0, 1 - y * y));
    const th = golden * i;
    out.push([Math.cos(th) * r, y, Math.sin(th) * r]);
  }
  return out;
}

/** Direction -> a human bearing in the character's frame (-Z is forward). */
function bearing(d) {
  const az = (Math.atan2(d[0], -d[2]) * 180) / Math.PI;
  const el = (Math.asin(Math.max(-1, Math.min(1, d[1]))) * 180) / Math.PI;
  const side = Math.abs(az) < 45 ? 'front' : Math.abs(az) > 135 ? 'BACK' : az > 0 ? 'right' : 'left';
  return `${side.padEnd(5)} az ${String(az.toFixed(0)).padStart(4)} el ${String(el.toFixed(0)).padStart(3)}`;
}

function asciiMap(samples) {
  const ROWS = 24, COLS = 72;
  const grid = Array.from({ length: ROWS }, () => new Array(COLS).fill(' '));
  for (const s of samples) {
    const el = Math.asin(Math.max(-1, Math.min(1, s.d[1])));
    const az = Math.atan2(s.d[0], -s.d[2]);
    const row = Math.min(ROWS - 1, Math.max(0, Math.floor((0.5 - el / Math.PI) * ROWS)));
    const col = Math.min(COLS - 1, Math.max(0, Math.floor((az / (Math.PI * 2) + 0.5) * COLS)));
    const ch = s.bad ? 'X' : s.hit === null ? ' ' : s.hit.mat === MAT.hair ? '#'
      : s.hit.ear ? 'e' : SKIN.has(s.hit.mat) ? '.' : 'o';
    const cur = grid[row][col];
    // Priority so nothing hides a defect: X > . > e > # > o
    const rank = { X: 5, '.': 4, e: 3, '#': 2, o: 1, ' ': 0 };
    if ((rank[ch] ?? 0) > (rank[cur] ?? 0)) grid[row][col] = ch;
  }
  return grid.map((r) => r.join('')).join('\n');
}

function run(id) {
  const spec = BROTHERS[id];
  const { geometry, skeleton } = buildBody(spec.build);
  const { c, hs } = headFrame(spec.build, skeleton.positions);
  const tris = headTriangles(geometry, c, hs, 0.25 * (spec.build.scale ?? 1));
  const R = 0.6 * (spec.build.scale ?? 1);

  /* ---- 1 + 4: sphere sweep ---- */
  const samples = [];
  let scalp = 0, earHits = { L: 0, R: 0 }, hairHits = 0, skinHits = 0;
  for (const d of fibonacci(NDIR)) {
    const hit = nearest(tris, c[0] + d[0] * R, c[1] + d[1] * R, c[2] + d[2] * R, -d[0], -d[1], -d[2], c, hs);
    let bad = false;
    if (hit) {
      if (hit.mat === MAT.hair) hairHits++;
      else if (SKIN.has(hit.mat)) skinHits++;
      if (hit.ear) earHits[hit.t[11] > 0 ? 'R' : 'L']++;
      if (SKIN.has(hit.mat) && hit.y > prof(azim(hit.x, hit.z), MUST_COVER)) bad = true;
    }
    if (bad) scalp++;
    samples.push({ d, hit, bad });
  }

  /* ---- 2: the fringe has not swallowed the face again ----
   * Straight-on rays at the features the old fringe buried. Each one names the
   * material it must land on; hair there is the first hair bug, reappearing. */
  const front = (x, y) => nearest(tris, c[0] + x * hs, c[1] + y * hs, c[2] - 0.6 * hs, 0, 0, 1, c, hs);
  const FACE_RAYS = [
    ['eyeR', 0.0305, 0.008, MAT.eye],
    ['eyeL', -0.0305, 0.008, MAT.eye],
    ['bridge', 0, 0.010, MAT.face],
    ['noseTip', 0, -0.026, MAT.face],
    ['cheekR', 0.040, -0.010, MAT.face],
    ['cheekL', -0.040, -0.010, MAT.face],
  ];
  const buried = [];
  for (const [name, x, y, want] of FACE_RAYS) {
    const hit = front(x, y);
    if (!hit || hit.mat !== want) buried.push(name);
  }

  /* ---- 3: the eyebrows are visible from the front ----
   * They were once 100% buried inside the brow ridge. Sweep the brow band and
   * count the rays that actually land on hair. */
  const brows = { R: 0, L: 0 };
  let browRays = 0;
  for (const s of [1, -1]) {
    for (let i = 0; i <= 10; i++) {
      for (let j = 0; j <= 4; j++) {
        browRays++;
        const x = s * (0.008 + (i / 10) * 0.040);
        const y = 0.020 + (j / 4) * 0.014;
        const hit = front(x, y);
        if (hit && hit.mat === MAT.hair) brows[s > 0 ? 'R' : 'L']++;
      }
    }
  }
  browRays /= 2;

  /* ---- 5: the head assembly is rigid ---- */
  const HEAD_BONE = BONE_INDEX.head;
  const si = geometry.attributes.skinIndex.array;
  const sw = geometry.attributes.skinWeight.array;
  const idx = geometry.index.array;
  let loose = 0, headVerts = 0;
  const seen = new Set();
  for (const g of geometry.groups) {
    for (let i = g.start; i < g.start + g.count; i++) {
      const v = idx[i];
      if (seen.has(v)) continue;
      const ly = (geometry.attributes.position.array[v * 3 + 1] - c[1]) / hs;
      // Everything above the top of the neck tube: skull, ears, eyes, brows,
      // hair. The neck itself legitimately blends chest -> neck -> head.
      const isHead = g.materialIndex === MAT.hair || g.materialIndex === MAT.eye ||
        (g.materialIndex === MAT.face && ly > -0.045);
      if (!isHead) continue;
      seen.add(v);
      headVerts++;
      let w = 0;
      for (let k = 0; k < 4; k++) if (si[v * 4 + k] === HEAD_BONE) w += sw[v * 4 + k];
      if (Math.abs(w - 1) > 1e-4) loose++;
    }
  }

  return { id, spec, samples, scalp, buried, brows, browRays, earHits, hairHits, skinHits, tris, loose, headVerts };
}

const FACE_RAY_NAMES = 'eyes,bridge,noseTip,cheeks';

let failures = 0;
for (const id of ['carson', 'aidan', 'dylan']) {
  const r = run(id);
  const ears = r.earHits.L + r.earHits.R;
  const earMin = Math.round(NDIR * 0.002);
  const browMin = Math.round(r.browRays * 0.25);
  const bad = [];
  if (r.scalp > 0) bad.push(`SCALP ${r.scalp}`);
  if (r.buried.length) bad.push(`FACE ${r.buried.join('/')}`);
  if (r.brows.R < browMin || r.brows.L < browMin) bad.push(`BROWS ${r.brows.R}+${r.brows.L}`);
  if (r.earHits.L < earMin || r.earHits.R < earMin) bad.push(`EARS ${r.earHits.L}+${r.earHits.R}`);
  if (r.loose > 0) bad.push(`RIGID ${r.loose}`);

  console.log(`\n=== ${id} (${r.spec.build.hair}) — ${NDIR} rays, ${r.tris.length} head tris ===`);
  console.log(`  nearest surface: hair ${r.hairHits}  skin ${r.skinHits}  ear ${ears}`);
  console.log(`  1 SCALP bare cranium above the target hairline : ${r.scalp}  (want 0)`);
  console.log(`  2 FACE  features buried by the fringe          : ${r.buried.length ? r.buried.join(',') : 'none'}  (want none of ${FACE_RAY_NAMES})`);
  console.log(`  3 BROWS frontal rays landing on eyebrow hair   : R ${r.brows.R} L ${r.brows.L} of ${r.browRays}  (want >= ${browMin} each)`);
  console.log(`  4 EARS  rays whose nearest surface is an ear   : R ${r.earHits.R} L ${r.earHits.L}  (want >= ${earMin} each)`);
  console.log(`  5 RIGID head verts not 100% on the head bone   : ${r.loose} of ${r.headVerts}  (want 0)`);
  if (bad.length) {
    failures++;
    console.log(`  FAIL: ${bad.join(', ')}`);
    for (const s of r.samples.filter((x) => x.bad).slice(0, 8)) {
      const u = azim(s.hit.x, s.hit.z);
      console.log(`    scalp at ${bearing(s.d)}  head-local y ${s.hit.y.toFixed(4)} u ${u.toFixed(3)} (target ${prof(u, MUST_COVER).toFixed(4)}, over by ${((s.hit.y - prof(u, MUST_COVER)) * 1000).toFixed(1)} mm)`);
    }
  } else {
    console.log('  PASS');
  }
  if (args.map) console.log(asciiMap(r.samples));
}
console.log(`\n${failures ? `FAIL (${failures}/3 brothers)` : 'PASS (3/3 brothers)'}`);
process.exit(failures ? 1 : 0);
