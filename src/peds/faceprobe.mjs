#!/usr/bin/env node
/**
 * FACE GATE — "can you see this pedestrian's eyes, and is his head a head?"
 *
 * The peds answer to `src/player/character/headprobe.mjs`, and built the same
 * way: it renders nothing, takes the geometry `buildOutfit()` actually emits,
 * and ray-casts it. Screenshots only prove the angles you remembered to shoot;
 * a ray sweep proves all of them at once.
 *
 * It runs over ALL 20 silhouettes, because the defect it was written for is
 * per-outfit: six of the seven hatted shapes shipped with headgear whose front
 * rim came down THROUGH the eyeball.
 *
 *   1 RIGID   every vertex of the skull, ears, brows, eyes, lids, nose, lips,
 *             hair, beard and headgear is weighted 100% to the `Head` bone.
 *             This is what makes 2-6 pose-independent: a single-bone assembly
 *             can only be moved by a rigid transform, and a rigid transform
 *             cannot change what occludes what. If it ever fails, every other
 *             gate here silently narrows to the bind pose.
 *   2 HAT     from a fan of camera directions at conversational height, the
 *             nearest surface on the line to each eye is never HEADGEAR.
 *             The failure this exists for.
 *   3 EYES    ...and it IS the eye often enough to read as a face. Catches the
 *             opposite bug — an eyeball sunk inside the skull.
 *   4 SCALP   no bare cranium above the target hairline. Included because the
 *             skull, the hair and the hats share a boundary, and the player
 *             character has now regressed on that boundary twice by having one
 *             side of it moved without the other (ARCHITECTURE.md rule 9).
 *   5 SHAPE   the emitted skull's width/height and depth/height against
 *             anthropometry. A head 5% too wide and 13% too shallow is what
 *             "faces look squished" means, and it is measurable.
 *   6 RELIEF  how far the nose, the brow and the lips stand proud of the
 *             skull. This is the "reads as a doll under 4 m" defect.
 *
 * The eye, brow and skull geometry are all DERIVED FROM THE EMITTED VERTICES
 * (the `sclera`, `browR/L` and `head` parts), never from the constants
 * `parts.js` places them with — rule 12. The targets below are anthropometric
 * and are held here, deliberately not equal to what the code currently builds.
 *
 *   node src/peds/faceprobe.mjs
 *   node src/peds/faceprobe.mjs --shape=puffaM --map
 *   node src/peds/faceprobe.mjs --legacy        # NEGATIVE CONTROL, must fail
 */
import { RIG } from './rig.js';
import { buildOutfit } from './builder.js';
import { FACE_LEGACY } from './parts.js';
import { SHAPE_IDS, SHAPES } from './wardrobe.js';
import { Rng } from '../core/rng.js';

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const m = a.match(/^--([^=]+)(?:=(.*))?$/);
    return m ? [m[1], m[2] ?? true] : [a, true];
  })
);

/**
 * NEGATIVE CONTROL. `--legacy` puts the four shipped defects back — level hat
 * rims, the long-hair curtain pinned at eye height, the undersized hair shell
 * and the flat skull — and the gate must go red on all of them. Without this
 * the numbers below are just a description of whatever the code does.
 */
FACE_LEGACY.on = !!args.legacy;

/** Parts that are HEADGEAR: they may never be the nearest thing to an eye. */
const HEADGEAR = new Set(['beanie', 'flatcap', 'ballcap', 'hardhat', 'hoodUp']);
/** Parts that make up the head assembly, for the rigidity gate. */
const HEAD_PARTS = new Set([
  'head', 'nose', 'nostrils', 'earR', 'earL', 'lips', 'mouth', 'hair', 'beard',
  'browR', 'browL', 'lidR', 'lidL', 'lowR', 'lowL', 'sclera', 'iris', 'neck',
  ...HEADGEAR,
]);
const EYE_PARTS = new Set(['sclera', 'iris']);

/**
 * TARGETS — anthropometry, not a copy of the section table in `parts.js`.
 *
 * Adult head, chin point to crown 0.23 m: maximum breadth 0.152-0.158, length
 * glabella-to-occiput 0.190-0.200. Those give w/h 0.66-0.69 and d/h 0.83-0.87.
 * A head at the top of the width band and the bottom of the depth band is the
 * one that reads as squashed, so both are gated, both ways.
 */
const SHAPE_T = {
  wideMin: 0.630, wideMax: 0.700,
  deepMin: 0.800, deepMax: 0.900,
};

/**
 * RELIEF, metres of protrusion beyond the skull surface at the same height.
 * RATCHET (rule 13) — these record this pass, not the goal. A real nose stands
 * ~0.021 m proud of the cheek plane and a brow ridge ~0.005 m; the numbers here
 * are what the current head achieves. Lower them never; RAISE them (this is the
 * one metric where more is better) only when the modelling improves.
 */
const RELIEF_T = { nose: 0.018, brow: 0.0035, lips: 0.0015 };

/**
 * THE TARGET HAIRLINE, head-local metres against azimuth u (0 = dead ahead,
 * 0.5 = the ear, 1 = the nape). Skin found above this curve is a bald patch.
 * Deliberately looser than what `parts.js` builds so the gate is not a
 * tautology — same trick, and same reason, as `headprobe.mjs`.
 */
const MUST_COVER = [
  [0.00, 0.148], // forehead — the anatomical hairline, well above the brow ridge
  [0.30, 0.136],
  [0.50, 0.115], // temple, above the ear
  [0.75, 0.100],
  [1.00, 0.085], // the NAPE must be covered, not just the crown
];

/**
 * The camera fan for gates 2 and 3: azimuth +/-70 degrees off the ped's face,
 * elevation -20 to +15. That is the envelope a third-person chase camera
 * actually looks at a pedestrian's face from. Above +15 a cap peak may hide the
 * eyes and that is correct behaviour for a cap, so asserting over the whole
 * sphere would be asserting something false.
 */
const FAN = { az: 70, elLo: -20, elHi: 15, nAz: 29, nEl: 13 };

/* ------------------------------------------------------------------ */

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

function nearest(tris, ox, oy, oz, dx, dy, dz) {
  let best = Infinity, hit = null;
  for (let i = 0; i < tris.length; i++) {
    const d = rayTri(ox, oy, oz, dx, dy, dz, tris[i]);
    if (d >= 0 && d < best) { best = d; hit = tris[i]; }
  }
  if (!hit) return null;
  // Face normal, so a caller can tell a surface it is LOOKING AT from one it is
  // inside. `rayTri` is deliberately two-sided (a back face still occludes),
  // but "bare scalp" means a front face: a ray that has entered the head
  // through the jaw and struck the inside of the cranium has seen nothing.
  const e1x = hit[3] - hit[0], e1y = hit[4] - hit[1], e1z = hit[5] - hit[2];
  const e2x = hit[6] - hit[0], e2y = hit[7] - hit[1], e2z = hit[8] - hit[2];
  const nx = e1y * e2z - e1z * e2y, ny = e1z * e2x - e1x * e2z, nz = e1x * e2y - e1y * e2x;
  return { part: hit[9], dist: best, facing: dx * nx + dy * ny + dz * nz < 0 };
}

/**
 * What may NOT be the nearest thing to an eye. Hair belongs here with the hats:
 * the player character's first hair bug was a fringe hanging over the eyes, and
 * the long-hair curtain here was doing exactly the same thing to every woman in
 * the crowd — measured at 75% of the camera fan on `coatF`.
 */
const BLOCKERS = new Set([...HEADGEAR, 'hair']);

/* ------------------------------------------------------------------ */

function analyse(shapeId) {
  const built = buildOutfit(shapeId, { rng: new Rng(0xfacade ^ (shapeId.length * 7919)), lod: 0 });
  const geo = built.geometry;
  const pos = geo.attributes.position.array;
  const idx = geo.index.array;
  const si = geo.attributes.skinIndex.array;
  const sw = geo.attributes.skinWeight.array;

  /* vertex -> part name */
  const partOf = new Array(pos.length / 3).fill(null);
  for (const p of built.parts) {
    for (let v = p.start; v < p.start + p.count; v++) partOf[v] = p.name;
  }

  const base = RIG.pos('Head');
  const L = (v, k) => pos[v * 3 + k] - base[k];

  /* ---- 1 RIGID ---- */
  const HEAD_BONE = RIG.index('Head');
  // `hoodUp` is deliberately NOT rigid — it is weighted Head/Neck/Spine2 so a
  // hood follows the shoulders. It is still gated for occlusion, in bind pose.
  // `hoodUp` and `neck` are deliberately NOT rigid — both are weighted across
  // Head/Neck/Spine2 so they follow the shoulders. Both are still in the ray
  // set, because both can occlude, and the sweep is evaluated in bind pose.
  const RIGID_PARTS = new Set([...HEAD_PARTS].filter((n) => n !== 'hoodUp' && n !== 'neck'));
  let loose = 0, headVerts = 0;
  for (let v = 0; v < partOf.length; v++) {
    if (!RIGID_PARTS.has(partOf[v])) continue;
    headVerts++;
    let w = 0;
    for (let k = 0; k < 4; k++) if (si[v * 4 + k] === HEAD_BONE) w += sw[v * 4 + k];
    if (Math.abs(w - 1) > 1e-4) loose++;
  }

  /* ---- derive the eyes and the brow from the EMITTED vertices ---- */
  const eye = { R: null, L: null };
  for (const side of ['R', 'L']) {
    const s = side === 'R' ? -1 : 1;
    let n = 0, cx = 0, cy = 0, cz = 0, r = 0;
    for (let v = 0; v < partOf.length; v++) {
      if (partOf[v] !== 'sclera') continue;
      if (Math.sign(L(v, 0)) !== s) continue;
      cx += L(v, 0); cy += L(v, 1); cz += L(v, 2); n++;
    }
    if (!n) continue;
    cx /= n; cy /= n; cz /= n;
    for (let v = 0; v < partOf.length; v++) {
      if (partOf[v] !== 'sclera' || Math.sign(L(v, 0)) !== s) continue;
      r = Math.max(r, Math.hypot(L(v, 0) - cx, L(v, 1) - cy, L(v, 2) - cz));
    }
    eye[side] = { x: cx, y: cy, z: cz, r };
  }
  let browTop = -Infinity;
  for (let v = 0; v < partOf.length; v++) {
    if (partOf[v] === 'browR' || partOf[v] === 'browL') browTop = Math.max(browTop, L(v, 1));
  }

  /* ---- head triangles, tagged with their part ---- */
  const tris = [];
  const R2 = 0.30 * 0.30;
  for (let i = 0; i < idx.length; i += 3) {
    const a = idx[i], b = idx[i + 1], c = idx[i + 2];
    const name = partOf[a];
    if (!HEAD_PARTS.has(name)) continue;
    let near = false;
    for (const o of [a, b, c]) {
      if (L(o, 0) ** 2 + L(o, 1) ** 2 + L(o, 2) ** 2 <= R2) { near = true; break; }
    }
    if (!near) continue;
    tris.push([
      pos[a * 3], pos[a * 3 + 1], pos[a * 3 + 2],
      pos[b * 3], pos[b * 3 + 1], pos[b * 3 + 2],
      pos[c * 3], pos[c * 3 + 1], pos[c * 3 + 2],
      name,
    ]);
  }

  /* ---- 2 HAT + 3 EYES: the camera fan ---- */
  const D2R = Math.PI / 180;
  const blocked = [];
  let eyeHits = 0, fanRays = 0, worstHat = null;
  const occluders = new Map();
  for (const side of ['R', 'L']) {
    const e = eye[side];
    if (!e) continue;
    for (let i = 0; i < FAN.nAz; i++) {
      const az = (-FAN.az + (2 * FAN.az * i) / (FAN.nAz - 1)) * D2R;
      for (let j = 0; j < FAN.nEl; j++) {
        const el = (FAN.elLo + ((FAN.elHi - FAN.elLo) * j) / (FAN.nEl - 1)) * D2R;
        // the character faces +Z (see rig.js), so "in front" is +Z
        const dx = Math.sin(az) * Math.cos(el);
        const dy = Math.sin(el);
        const dz = Math.cos(az) * Math.cos(el);
        const ox = base[0] + e.x + dx * 0.9;
        const oy = base[1] + e.y + dy * 0.9;
        const oz = base[2] + e.z + dz * 0.9;
        /**
         * Only the NEAR eye is gated. From 70 degrees off-axis a long-haired
         * person really does have hair across the FAR eye, and asserting
         * otherwise would be asserting something false — the same trap as
         * gating a cap peak from directly above. The near eye is the one on the
         * camera's side; dead ahead, both count.
         */
        const near = Math.abs(az) < 10 * D2R || Math.sign(e.x) === Math.sign(dx);
        if (!near) continue;
        const hit = nearest(tris, ox, oy, oz, -dx, -dy, -dz);
        fanRays++;
        if (!hit) continue;
        if (BLOCKERS.has(hit.part)) {
          const hy = oy - dy * hit.dist - base[1];
          blocked.push({ side, az: az / D2R, el: el / D2R, part: hit.part, y: hy });
          if (!worstHat || hy < worstHat.y) worstHat = { side, az: az / D2R, el: el / D2R, part: hit.part, y: hy };
        } else if (EYE_PARTS.has(hit.part)) {
          eyeHits++;
        }
        occluders.set(hit.part, (occluders.get(hit.part) ?? 0) + 1);
      }
    }
  }
  fanRays = Math.max(1, fanRays);

  /* ---- 4 SCALP ----
   * A bald shape has no hair to cover anything with, so the gate does not
   * apply: `oldM` is meant to be bald under his flat cap. */
  const balding = !SHAPES[shapeId].hair || SHAPES[shapeId].hair === 'bald';
  const SKIN_HEAD = new Set(['head']);
  let scalp = 0, scalpWorst = 0, scalpAt = null;
  const N = 4000;
  const golden = Math.PI * (3 - Math.sqrt(5));
  const cy = 0.120; // mid-skull, head-local; only used as a ray origin centre
  for (let i = 0; i < N; i++) {
    const y = 1 - (i / (N - 1)) * 2;
    const rr = Math.sqrt(Math.max(0, 1 - y * y));
    const th = golden * i;
    const d = [Math.cos(th) * rr, y, Math.sin(th) * rr];
    const hit = nearest(
      tris,
      base[0] + d[0] * 0.55, base[1] + cy + d[1] * 0.55, base[2] + d[2] * 0.55,
      -d[0], -d[1], -d[2]
    );
    if (balding || !hit || !hit.facing || !SKIN_HEAD.has(hit.part)) continue;
    const px = base[0] + d[0] * 0.55 - d[0] * hit.dist - base[0];
    const py = base[1] + cy + d[1] * 0.55 - d[1] * hit.dist - base[1];
    const pz = base[2] + d[2] * 0.55 - d[2] * hit.dist - base[2];
    // the ped rig faces +Z (rig.js), so the FRONT of the skull is +z and u = 0
    const u = Math.atan2(Math.abs(px) / 0.084, (pz + 0.005) / 0.096) / Math.PI;
    const want = prof(u, MUST_COVER);
    if (py > want) {
      scalp++;
      if (py - want > scalpWorst) {
        scalpWorst = py - want;
        scalpAt = { u, y: py, want, x: px, z: pz, d, dist: hit.dist };
      }
    }
  }

  /* ---- 5 SHAPE, from the emitted skull only ---- */
  let mnx = Infinity, mxx = -Infinity, mny = Infinity, mxy = -Infinity, mnz = Infinity, mxz = -Infinity;
  for (let v = 0; v < partOf.length; v++) {
    if (partOf[v] !== 'head') continue;
    mnx = Math.min(mnx, L(v, 0)); mxx = Math.max(mxx, L(v, 0));
    mny = Math.min(mny, L(v, 1)); mxy = Math.max(mxy, L(v, 1));
    mnz = Math.min(mnz, L(v, 2)); mxz = Math.max(mxz, L(v, 2));
  }
  const H = mxy - mny, Wd = mxx - mnx, Dp = mxz - mnz;

  /* ---- 6 RELIEF: how far a feature stands proud of the skull ---- */
  /**
   * The frontmost point of the SKULL at a given height. Banding on y only, not
   * on x: the skull's front is on the midline at every height, so this is well
   * defined everywhere, whereas an x band is empty wherever the loft happens to
   * have no vertex column and then silently answers with the BACK of the head.
   */
  const skullFrontZ = (y) => {
    let best = -Infinity;
    for (let v = 0; v < partOf.length; v++) {
      if (partOf[v] !== 'head') continue;
      if (Math.abs(L(v, 1) - y) > 0.010) continue;
      best = Math.max(best, L(v, 2));
    }
    return best;
  };
  const reliefOf = (name) => {
    let worst = -Infinity;
    for (let v = 0; v < partOf.length; v++) {
      if (partOf[v] !== name) continue;
      const s = skullFrontZ(L(v, 1));
      if (s > -Infinity) worst = Math.max(worst, L(v, 2) - s);
    }
    return worst === -Infinity ? 0 : worst;
  };
  const relief = { nose: reliefOf('nose'), brow: reliefOf('browR'), lips: reliefOf('lips') };

  return {
    shapeId, hat: SHAPES[shapeId].hat ?? (SHAPES[shapeId].extras?.includes('hoodUp') ? 'hoodUp' : null),
    loose, headVerts, eye, browTop, blocked, worstHat, eyeHits, fanRays,
    scalp, scalpWorst, scalpAt, balding, H, Wd, Dp, relief, tris: tris.length, occluders,
  };
}

/* ------------------------------------------------------------------ */

const shapes = args.shape ? [String(args.shape)] : SHAPE_IDS;
let failures = 0;
const rows = [];

for (const id of shapes) {
  const r = analyse(id);
  rows.push(r);
  const eyeFrac = r.eyeHits / r.fanRays;
  const wr = r.Wd / r.H, dr = r.Dp / r.H;
  const bad = [];
  if (r.loose > 0) bad.push(`RIGID ${r.loose}`);
  if (r.blocked.length) bad.push(`HAT ${r.blocked.length}/${r.fanRays} (${r.worstHat.part})`);
  if (eyeFrac < 0.25) bad.push(`EYES ${(eyeFrac * 100).toFixed(0)}%`);
  if (r.scalp > 0) bad.push(`SCALP ${r.scalp}`);
  if (wr < SHAPE_T.wideMin || wr > SHAPE_T.wideMax) bad.push(`WIDE ${wr.toFixed(3)}`);
  if (dr < SHAPE_T.deepMin || dr > SHAPE_T.deepMax) bad.push(`DEEP ${dr.toFixed(3)}`);
  for (const k of Object.keys(RELIEF_T)) {
    if (r.relief[k] < RELIEF_T[k]) bad.push(`RELIEF ${k} ${(r.relief[k] * 1000).toFixed(1)}mm`);
  }

  const hatTag = r.hat ? `hat=${r.hat}` : 'bare';
  console.log(`\n=== ${id} (${hatTag}) — ${r.tris} head tris ===`);
  console.log(`  1 RIGID  head verts not 100% on the Head bone : ${r.loose} of ${r.headVerts}  (want 0)`);
  console.log(`  2 HAT    fan rays to an eye blocked by hat/hair: ${r.blocked.length} of ${r.fanRays}  (want 0)` +
    (r.worstHat ? `   lowest '${r.worstHat.part}' at head-local y ${r.worstHat.y.toFixed(4)}, az ${r.worstHat.az.toFixed(0)} el ${r.worstHat.el.toFixed(0)}` : ''));
  const occ = [...r.occluders].sort((a, b) => b[1] - a[1]).slice(0, 5)
    .map(([n, c]) => `${n} ${((c / r.fanRays) * 100).toFixed(0)}%`).join('  ');
  console.log(`  3 EYES   fan rays whose nearest surface is eye: ${(eyeFrac * 100).toFixed(1)}%  (want >= 25%)`);
  console.log(`           what the fan actually sees            : ${occ}`);
  console.log(`  4 SCALP  bare cranium above target hairline   : ${r.balding ? 'n/a (bald)' : r.scalp}` +
    (r.scalp && r.scalpAt ? `  worst ${(r.scalpWorst * 1000).toFixed(1)} mm over at u ${r.scalpAt.u.toFixed(2)} (x ${r.scalpAt.x.toFixed(3)} y ${r.scalpAt.y.toFixed(3)} z ${r.scalpAt.z.toFixed(3)}, target ${r.scalpAt.want.toFixed(3)}, dir ${r.scalpAt.d.map((q) => q.toFixed(2)).join(',')}, dist ${r.scalpAt.dist.toFixed(3)})` : '') + '  (want 0)');
  console.log(`  5 SHAPE  skull ${(r.Wd * 1000).toFixed(0)} w x ${(r.H * 1000).toFixed(0)} h x ${(r.Dp * 1000).toFixed(0)} d mm` +
    `  ->  w/h ${wr.toFixed(3)} (want ${SHAPE_T.wideMin}-${SHAPE_T.wideMax})  d/h ${dr.toFixed(3)} (want ${SHAPE_T.deepMin}-${SHAPE_T.deepMax})`);
  console.log(`  6 RELIEF nose ${(r.relief.nose * 1000).toFixed(1)}  brow ${(r.relief.brow * 1000).toFixed(1)}  lips ${(r.relief.lips * 1000).toFixed(1)} mm` +
    `  (want >= ${(RELIEF_T.nose * 1000).toFixed(1)} / ${(RELIEF_T.brow * 1000).toFixed(1)} / ${(RELIEF_T.lips * 1000).toFixed(1)})`);
  if (bad.length) {
    failures++;
    console.log(`  FAIL: ${bad.join(', ')}`);
    if (r.blocked.length && args.map) {
      for (const b of r.blocked.slice(0, 10)) {
        console.log(`    '${b.part}' hides the ${b.side} eye from az ${b.az.toFixed(0)} el ${b.el.toFixed(0)}`);
      }
    }
  } else {
    console.log('  PASS');
  }
}

const hatted = rows.filter((r) => r.hat);
console.log(`\nheadgear shapes with an eye blocked: ${hatted.filter((r) => r.blocked.length).length}/${hatted.length}`);
console.log(failures ? `FAIL (${failures}/${rows.length} silhouettes)` : `PASS (${rows.length}/${rows.length} silhouettes)`);
process.exit(failures ? 1 : 0);
