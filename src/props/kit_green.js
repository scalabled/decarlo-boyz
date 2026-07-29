import * as THREE from 'three';
import {
  Accum, box, chamferBox, cyl, card, ground, lathe, extrude, ngon, tube,
  combine, weather, paint, newTrs, clamp01, lerp, TAU, hash3i,
} from './geom.js';

/**
 * PROPS — vegetation.
 *
 * THE FOLIAGE CONTRACT. Read this before touching a number in here; four of the
 * five defects a critic panel measured on the last build were caused by getting
 * one of these wrong, and three of them are invisible in code review.
 *
 *  1. LEAF SCALE IS SET BY THE UVs, NOT BY THE CARD SIZE. The `leaf` bake lays a
 *     4x4 lattice of leaf blades across UV 0..1, so a card whose UVs run 0..1
 *     draws exactly four leaves across its own width — a 1.2 m card therefore
 *     draws 30 cm leaves and the tree reads as a rubber plant. Every card here
 *     is UV-mapped from a LEAF PITCH IN METRES (`pitch`, ~0.11 m), so the blade
 *     size is a property of the species and the card size is free to vary.
 *  2. THE BAKE ONLY COVERS ~25 % OF A CARD. That is the ceiling: the blades are
 *     ellipses of ~0.26 cell^2 in a 1x1 cell. A canopy therefore gets its mass
 *     from overlapping cards, and a card that is mostly empty is mostly wasted
 *     fill — which is why the cards are lobed octagons rather than quads (-22 %
 *     area, and no axis-aligned silhouette steps).
 *  3. ALPHA TEST IS A DISTANCE FUNCTION. The mip chain averages the cutout, so
 *     with a high alphaTest a canopy past ~60 m loses every texel that is not
 *     part of an overlap and collapses into chunky rectangular blocks. The
 *     foliage surfaces in `palette.js` run a LOW alphaTest for exactly this
 *     reason: near, the leaf edge is soft; far, the card fills in and the crown
 *     reads as a soft mass instead of falling apart. There is no MSAA in this
 *     renderer (`render` runs HDR post, so alpha-to-coverage is not available),
 *     so this is the only lever there is.
 *  4. THE SHADING NORMAL IS NOT THE CARD NORMAL. Cards with their own normals
 *     shade as a collage: every card is lit by where it happens to point, so the
 *     crown has no top and no bottom and reads as flat dark green. Every card's
 *     normals are blended 55 % toward the OUTWARD direction of the crown shell,
 *     so the whole canopy shades like the volume it is meant to be — lit on top,
 *     in its own shadow underneath, with the `cloth` transmission lobe glowing
 *     through the rim when the sun is behind it.
 *
 * Beyond that: the library's `leaf` surface carries the OW_CLOTH transmission
 * lobe (a card facing AWAY from the sun glows, hardest when the camera looks
 * down the beam), `cloth[1]` is the underside multiplier, and the shader hashes
 * each card's own world position (~0.6 m cell) for per-card tint and gloss — so
 * cards have to be SPREAD IN SPACE and FOLDED or the hash has nothing to bite on.
 */

const _m = new THREE.Matrix4();
const _v = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _q2 = new THREE.Quaternion();
const _e = new THREE.Euler();
const _one = new THREE.Vector3(1, 1, 1);
const _zp = new THREE.Vector3(0, 0, 1);

function P(K, id, factory, surface, opts) {
  K.proto(id, factory, surface, opts);
  return id;
}

/* --------------------------------------------------------------- leaves -- */

/**
 * ONE FOLIAGE CARD: a lobed octagon, folded about its own midrib and drooping
 * toward the tip, UV-mapped so the baked blades come out at `pitch` metres
 * whatever size the card is.
 *
 * Nine vertices and eight triangles — the same budget as the `PlaneGeometry(2,2)`
 * this replaced, but with 22 % less area to shade and, crucially, no straight
 * edge anywhere on the silhouette. The rectangular card was the single loudest
 * tell in the canopy: a crown made of quads has a silhouette made of chunky
 * right-angled bites, and no amount of texture work hides it.
 */
function leafSpray(w, h, seed, opts = {}) {
  const fold = opts.fold ?? 0.16;
  const droop = opts.droop ?? 0.14;
  const pitch = opts.pitch ?? 0.115;
  // 4 blade cells span 1.0 in UV, so this is UV-per-metre.
  const k = 0.25 / pitch;
  const uo = hash3i(seed, 3, 71);
  const vo = hash3i(seed, 4, 71);
  const mir = hash3i(seed, 5, 71) < 0.5 ? -1 : 1;
  const N = 8;
  const pos = new Float32Array((N + 1) * 3);
  const uv = new Float32Array((N + 1) * 2);
  const idx = [];
  const half = w * 0.5;
  const put = (i, x, y) => {
    const u = y / h + 0.5;
    const z = -Math.abs(x / half) * fold * w - u * u * droop * h * 0.5;
    pos[i * 3] = x;
    pos[i * 3 + 1] = y;
    pos[i * 3 + 2] = z;
    uv[i * 2] = 0.5 + mir * x * k + uo;
    uv[i * 2 + 1] = 0.5 + y * k + vo;
  };
  put(0, 0, 0);
  for (let i = 0; i < N; i++) {
    const th = (i / N) * TAU + hash3i(seed, i, 72) * 0.28;
    // per-vertex radius wobble: an outline that is never twice the same shape
    const rr = 0.66 + 0.52 * hash3i(seed, i, 73);
    put(i + 1, Math.cos(th) * half * rr, Math.sin(th) * h * 0.5 * rr);
    idx.push(0, i + 1, ((i + 1) % N) + 1);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

/** Blend the normals written since vertex `from` toward a world direction. */
function biasNormals(a, from, ox, oy, oz, amount) {
  for (let i = from; i < a.verts; i++) {
    const o = i * 3;
    let nx = a.nrm[o] + ox * amount;
    let ny = a.nrm[o + 1] + oy * amount;
    let nz = a.nrm[o + 2] + oz * amount;
    const l = Math.hypot(nx, ny, nz) || 1;
    a.nrm[o] = nx / l;
    a.nrm[o + 1] = ny / l;
    a.nrm[o + 2] = nz / l;
  }
}

/**
 * A CANOPY: cards distributed through a volume of overlapping LOBES, not over
 * one smooth ellipsoid.
 *
 * A single shell gives a ball, and a ball is what makes a procedural tree read
 * as procedural however good the leaf is — real crowns are four to seven masses
 * of foliage hung on separate limbs, with sky between them. The lobes are what
 * put notches in the silhouette and gaps for the light to come through.
 *
 * Card size runs with depth: small at the rim (fine silhouette, cheap fill),
 * large in the interior (mass and self-shadowing for almost no extra silhouette
 * cost, because nothing there is on the outline).
 */
function canopy(n, rx, ry, rz, seed, opts = {}) {
  const a = new Accum('canopy');
  const size = opts.size ?? 0.95;
  const lift = opts.lift ?? 0;
  const inner = opts.inner ?? 0.30;
  const pitch = opts.pitch ?? 0.115;
  const lobes = opts.lobes ?? 5;
  const bias = opts.bias ?? 0.55;
  const flat = opts.flat ?? 0;   // 1 = conical/columnar bias, 0 = round
  const cy = ry + lift;

  const L = [];
  /**
   * FOLIAGE GROWS ON BRANCHES. When the caller hands in the limb plan, every
   * lobe is centred on a limb tip, so there is wood behind every mass of leaves
   * and no limb ends in open sky. Without a plan (shrubs, hedges) the lobes
   * fall back to a ring.
   */
  const at = opts.lobesAt ?? null;
  if (at && at.length) {
    /**
     * PRIMARY limbs only. Hanging a lobe on every tip — primaries AND the two
     * secondaries each throws — spread the same card budget over nineteen
     * masses, and nineteen thin masses read as a tree that has dropped half its
     * leaves. Six fat ones on the six real limbs is what a crown looks like,
     * and the secondaries are inside them anyway.
     */
    for (let l = 0; l < at.length; l++) {
      const h0 = hash3i(seed, l, 41);
      L.push({
        x: at[l].x * 0.94,
        y: at[l].y - cy + ry * 0.06,
        z: at[l].z * 0.94,
        r: 0.56 + 0.24 * h0,
      });
    }
  } else {
    for (let l = 0; l < lobes; l++) {
      const h0 = hash3i(seed, l, 41);
      const h1 = hash3i(seed, l, 42);
      const h2 = hash3i(seed, l, 43);
      const th = (l / lobes) * TAU + (h0 - 0.5) * 1.1;
      const rad = 0.26 + 0.44 * h1;
      const yy = (h2 - 0.5) * 1.5 * (1 - flat * 0.5);
      L.push({
        x: Math.cos(th) * rx * rad,
        y: yy * ry * 0.62 - flat * ry * 0.1,
        z: Math.sin(th) * rz * rad,
        r: 0.40 + 0.26 * h0,
      });
    }
  }
  // a central mass, so the crown has an interior rather than a ring of lobes
  L.push({ x: 0, y: -ry * 0.08, z: 0, r: 0.62 });

  for (let i = 0; i < n; i++) {
    const lb = L[i % L.length];
    const h0 = hash3i(seed, i, 1);
    const h1 = hash3i(seed, i, 2);
    const h2 = hash3i(seed, i, 3);
    const h3 = hash3i(seed, i, 4);
    const h4 = hash3i(seed, i, 5);
    const h5 = hash3i(seed, i, 6);

    const th = h0 * TAU;
    const ph = Math.acos(1 - 2 * (0.06 + 0.90 * h1));
    const rr = inner + (1 - inner) * Math.cbrt(h2);
    let px = lb.x + Math.sin(ph) * Math.cos(th) * rx * lb.r * rr;
    let py = lb.y + Math.cos(ph) * ry * lb.r * rr * (1 - flat * 0.25);
    let pz = lb.z + Math.sin(ph) * Math.sin(th) * rz * lb.r * rr;

    // keep the whole thing inside the species' crown envelope
    let q = Math.hypot(px / rx, py / ry, pz / rz);
    if (q > 1) {
      const s = 1 / q;
      px *= s;
      py *= s;
      pz *= s;
      q = 1;
    }
    // a columnar species is narrow low down and full at the top
    if (flat > 0) py += flat * ry * 0.18;

    // outward direction of the crown SHELL at this card — the shading normal
    // is blended toward it so the crown lights like a volume
    let ox = px / rx;
    let oy = py / ry + 0.30;
    let oz = pz / rz;
    const ol = Math.hypot(ox, oy, oz) || 1;
    ox /= ol;
    oy /= ol;
    oz /= ol;

    /**
     * Cards near the rim are small so the silhouette breaks up at leaf scale,
     * not at card scale. Interior cards are large: they carry the mass, they
     * self-shadow, and none of them is on the outline.
     */
    const depth = clamp01(1 - q);
    const s = size * (0.68 + 0.62 * depth) * (0.76 + 0.48 * h3);
    const g = leafSpray(1.02 * s, 0.80 * s, seed * 31 + i, {
      fold: 0.12 + 0.22 * h4,
      droop: 0.08 + 0.22 * h0,
      pitch,
    });

    // face roughly outward, then twist hard so no two cards share a normal
    _v.set(
      ox + (h3 - 0.5) * 1.5,
      oy + (h4 - 0.5) * 1.3,
      oz + (h5 - 0.5) * 1.5
    ).normalize();
    _q.setFromUnitVectors(_zp, _v);
    _e.set(0, 0, (h1 - 0.5) * TAU, 'XYZ');
    _q2.setFromEuler(_e);
    _q.multiply(_q2);
    const m = new THREE.Matrix4();
    m.compose(_v2.set(px, py + cy, pz), _q, _one);

    /**
     * MASK TRIPLE — (wear, grime, AO).
     *
     * Grime used to run to 1.0 in here. `grimeColor` for the leaf surface is a
     * near-black soot, so a fully grimed card renders at about a fifth of the
     * albedo it was authored at, and a canopy of them is the "black and very
     * dark speckle that reads as dirt or missing texels" a critic measured.
     * Leaves get DUSTY, not filthy: grime stays low and the interior of the
     * crown is darkened with AO instead, which is what is actually happening.
     */
    const outward = clamp01(q * 1.1);
    const mul = [
      0.15 + 0.55 * h2 * outward,
      0.10 + 0.26 * h1 + 0.12 * (1 - outward),
      0.16 + 0.78 * (1 - outward) * (1 - outward),
    ];
    const v0 = a.verts;
    a.add(g, m, null, mul);
    biasNormals(a, v0, ox, oy, oz, bias);
    g.dispose();
  }
  return a.build();
}

/* ---------------------------------------------------------------- wood --- */

/**
 * Pull a point back inside the crown envelope.
 *
 * WITHOUT THIS THE TREE IS A BARE SKELETON WITH A TUFT IN IT. Branch reach,
 * secondary fork and twig length are all independent random draws, so their
 * product routinely lands 60 % beyond the crown radius — and a stick sticking
 * out of a canopy against the sky is far more visible than the canopy itself.
 * Real limbs end INSIDE their own foliage; only a few dead ones do not.
 */
function contain(p, env, lim) {
  if (!env) return p;
  const dy = p.y - env.cy;
  const q = Math.hypot(p.x / env.rx, dy / env.ry, p.z / env.rz);
  if (q <= lim) return p;
  const s = lim / q;
  return { x: p.x * s, y: env.cy + dy * s, z: p.z * s };
}

/**
 * A trunk that leans, tapers, flares at the root, forks into primaries and
 * secondaries, and puts TWIGS up inside the crown volume.
 *
 * The twigs are the reason this is not just a stick with a cloud on it. A real
 * crown is full of visible structure — you see branch against sky through every
 * gap — and the gaps are exactly where a procedural tree gets caught, because
 * there is nothing behind the leaves at all. They are radial-3 tubes at 3-5 cm,
 * so a whole armature of twenty of them is under 300 triangles.
 */
/**
 * THE ARMATURE, SOLVED ONCE AND SHARED WITH THE CANOPY.
 *
 * This is the fix for the defect that survived every other fix: bare sticks
 * poking out of the foliage against the sky. Containing the limbs inside the
 * crown ENVELOPE is not enough, because the crown is built from a handful of
 * LOBES and a limb aimed into the gap between two of them is still naked. So
 * the limbs are planned first and the canopy hangs its lobes on the limb tips —
 * foliage grows on branches, which is the one thing about a tree that a viewer
 * checks without knowing they are checking it.
 */
function branchPlan(h, seed, opts = {}) {
  const lean = (hash3i(seed, 0, 9) - 0.5) * 0.16;
  const twist = hash3i(seed, 1, 9) * TAU;
  const segs = 6;
  const pts = [];
  for (let i = 0; i <= segs; i++) {
    const t = i / segs;
    pts.push({
      x: Math.cos(twist) * lean * h * t * t + Math.sin(t * 3 + seed) * 0.05,
      y: t * h,
      z: Math.sin(twist) * lean * h * t * t,
    });
  }
  const nb = opts.branches ?? 5;
  const top = pts[segs];
  const reachB = opts.reach ?? 1.5;
  const riseB = opts.rise ?? 1.5;
  const env = opts.crown ?? null;
  const prim = [];
  const tips = [];
  for (let i = 0; i < nb; i++) {
    const t = 0.52 + 0.44 * hash3i(seed, i, 13);
    const base = {
      x: lerp(0, top.x, t * t),
      y: t * h,
      z: lerp(0, top.z, t * t),
    };
    const a = (i / nb) * TAU + hash3i(seed, i, 14) * 1.3;
    const reach = reachB * (0.6 + 0.8 * hash3i(seed, i, 15));
    const rise = riseB * (0.6 + 0.7 * hash3i(seed, i, 16));
    const tip = contain({
      x: base.x + Math.cos(a) * reach,
      y: base.y + rise,
      z: base.z + Math.sin(a) * reach,
    }, env, 0.78);
    const sec = [];
    for (let k = 0; k < 2; k++) {
      const hk = hash3i(seed, i * 7 + k, 17);
      const a2 = a + (k ? 0.85 : -0.85) * (0.5 + hk);
      const r2 = reach * (0.40 + 0.30 * hk);
      const y2 = rise * (0.30 + 0.40 * hk);
      const from = {
        x: lerp(base.x, tip.x, 0.62),
        y: lerp(base.y, tip.y, 0.72),
        z: lerp(base.z, tip.z, 0.62),
      };
      const tip2 = contain({
        x: from.x + Math.cos(a2) * r2,
        y: from.y + y2,
        z: from.z + Math.sin(a2) * r2,
      }, env, 0.84);
      sec.push({ from, tip: tip2 });
      tips.push(tip2);
    }
    tips.push(tip);
    prim.push({ base, tip, sec });
  }
  return { pts, prim, tips, env };
}

function trunkAndBranches(h, r0, seed, opts = {}) {
  const parts = [];
  const plan = opts.plan ?? branchPlan(h, seed, opts);
  const pts = plan.pts;
  const segs = pts.length - 1;
  parts.push([tube(pts, r0, 8, { taper: opts.taper ?? 0.34, mg: 0.55 }), null]);

  /**
   * ROOT FLARE. Seven buttresses, not five, and they start wider and land
   * lower: the join between a trunk and the ground is the one part of a tree
   * the player walks right up to, and a cylinder meeting a pavement in a clean
   * circle is the tell that survives every other improvement.
   */
  for (let i = 0; i < 7; i++) {
    const a = (i / 7) * TAU + hash3i(seed, i, 11) * 0.8;
    const rr = r0 * (1.7 + hash3i(seed, i, 12) * 1.3);
    parts.push([tube([
      { x: Math.cos(a) * rr, y: -0.04, z: Math.sin(a) * rr },
      { x: Math.cos(a) * rr * 0.62, y: r0 * 0.9, z: Math.sin(a) * rr * 0.62 },
      { x: Math.cos(a) * rr * 0.26, y: r0 * 2.2, z: Math.sin(a) * rr * 0.26 },
      { x: 0, y: r0 * 4.0, z: 0 },
    ], r0 * 0.46, 5, { taper: 0.42, mg: 0.9 }), null]);
  }

  const env = plan.env;
  for (const b of plan.prim) {
    const { base, tip } = b;
    parts.push([tube([
      base,
      { x: lerp(base.x, tip.x, 0.36), y: lerp(base.y, tip.y, 0.48), z: lerp(base.z, tip.z, 0.36) },
      { x: lerp(base.x, tip.x, 0.74), y: lerp(base.y, tip.y, 0.84), z: lerp(base.z, tip.z, 0.74) },
      tip,
    ], r0 * 0.44, 5, { taper: 0.24, mg: 0.4 }), null]);
    for (const s of b.sec) {
      const from = s.from;
      const tip2 = s.tip;
      parts.push([tube([
        from,
        { x: lerp(from.x, tip2.x, 0.5), y: lerp(from.y, tip2.y, 0.58), z: lerp(from.z, tip2.z, 0.5) },
        tip2,
      ], r0 * 0.20, 4, { taper: 0.22, mg: 0.35 }), null]);
    }
  }
  const tips = plan.tips;

  // twigs: short, thin, thrown from every tip and kept inside the foliage
  const nt = opts.twigs ?? 0;
  for (let i = 0; i < nt; i++) {
    const src = tips[i % tips.length];
    if (!src) break;
    const h0 = hash3i(seed, i, 18);
    const h1 = hash3i(seed, i, 19);
    const h2 = hash3i(seed, i, 20);
    const a = h0 * TAU;
    const len = (opts.twigLen ?? 0.7) * (0.45 + 0.9 * h1);
    const end = contain({
      x: src.x + Math.cos(a) * len,
      y: src.y + len * (0.3 + 0.8 * h2),
      z: src.z + Math.sin(a) * len,
    }, env, 0.92);
    parts.push([tube([
      { x: src.x, y: src.y, z: src.z },
      { x: lerp(src.x, end.x, 0.55), y: lerp(src.y, end.y, 0.5), z: lerp(src.z, end.z, 0.55) },
      end,
    ], r0 * 0.10, 3, { taper: 0.2, mg: 0.3 }), null]);
  }

  const g = combine(parts, 'trunk');
  weather(g, { grimeBase: 0.55, grimeHeight: 2.4, wear: 0.3, seed, up: 0.2, down: 0.3 });
  return g;
}

/* ================================================================= trees == */

/**
 * Five street species, four crown variants each. Pittsburgh street planting is
 * London plane, red maple, honey locust and callery pear over and over, with a
 * young replacement in every fourth pit; the hills and the riverbank get the
 * scrub form and the conifer.
 *
 * `pitch` is the blade size in metres and it is the species' strongest single
 * identity cue after the silhouette: a plane leaf really is three times a honey
 * locust leaflet, and getting that ratio right is most of what makes two trees
 * on the same street read as two species rather than two random seeds.
 */
const SPECIES = [
  {
    id: 'plane', h: 6.6, r: 0.20, bark: 'bark_plane', crown: [2.7, 2.0, 2.6],
    n: 176, size: 1.18, pitch: 0.150, branches: 6, reach: 2.0, rise: 1.7,
    twigs: 11, lobes: 5, lift: 0.56,
  },
  {
    id: 'maple', h: 5.4, r: 0.17, bark: 'bark_street', crown: [2.3, 1.95, 2.2],
    n: 162, size: 1.08, pitch: 0.120, branches: 5, reach: 1.6, rise: 1.7,
    twigs: 10, lobes: 5, lift: 0.54,
  },
  {
    id: 'locust', h: 7.4, r: 0.16, bark: 'bark_street', crown: [2.4, 1.5, 2.3],
    n: 142, size: 0.96, pitch: 0.075, branches: 6, reach: 2.2, rise: 1.2,
    twigs: 12, lobes: 6, lift: 0.62,
  },
  {
    id: 'pear', h: 5.8, r: 0.15, bark: 'bark_smooth', crown: [1.55, 2.35, 1.5],
    n: 150, size: 0.94, pitch: 0.105, branches: 6, reach: 0.95, rise: 2.3,
    twigs: 11, lobes: 4, flat: 1, lift: 0.50,
  },
  {
    id: 'young', h: 3.6, r: 0.080, bark: 'bark_street', crown: [1.05, 1.0, 1.0],
    n: 58, size: 0.72, pitch: 0.095, branches: 4, reach: 0.75, rise: 0.95,
    twigs: 6, twigLen: 0.5, lobes: 3, lift: 0.58,
  },
];

const LEAVES = ['leaf_a', 'leaf_b', 'leaf_c', 'leaf_autumn'];

export function registerTrees(K) {
  for (const sp of SPECIES) {
    for (let v = 0; v < 4; v++) {
      const seed = (sp.id.charCodeAt(0) * 131 + v * 977) | 0;
      const th = sp.h * (0.88 + v * 0.11);
      const crx = sp.crown[0] * (0.92 + v * 0.09);
      const cry = sp.crown[1] * (0.94 + v * 0.06);
      const crz = sp.crown[2] * (0.95 + v * 0.07);
      const env = { rx: crx, ry: cry, rz: crz, cy: cry + th * sp.lift };
      const plan = branchPlan(th, seed, {
        branches: sp.branches, reach: sp.reach, rise: sp.rise, crown: env,
      });
      P(K, `tree_${sp.id}_${v}_wood`, () => trunkAndBranches(th, sp.r, seed, {
        twigs: sp.twigs, twigLen: sp.twigLen, plan,
      }), sp.bark);

      /**
       * ONE CANOPY GEOMETRY, FOUR MATERIALS.
       *
       * This used to build a separate 1 500-triangle canopy for every leaf
       * variant, so the kit carried sixty-four crowns to show sixteen. The
       * geometry does not care which green it is painted, so the four leaf
       * protos share one mesh and the saving buys the card count and the twig
       * armature that make the crown read at all. `ProtoLibrary.dispose`
       * de-duplicates, so a shared geometry is freed exactly once.
       */
      const geo = canopy(sp.n, crx, cry, crz, seed, {
        size: sp.size, lift: th * sp.lift, inner: 0.52,
        pitch: sp.pitch, lobes: sp.lobes, flat: sp.flat ?? 0, lobesAt: plan.prim.map((b) => b.tip),
      });
      for (let li = 0; li < LEAVES.length; li++) {
        K.proto(`tree_${sp.id}_${v}_leaf${li}`, null, LEAVES[li], { geo, shared: true });
      }
    }

    /**
     * THE FAR TIER. Tiles past `nearRadius` used to instance the full crown, so
     * a boulevard two hundred metres away cost the same fill as the one under
     * the camera while resolving to twenty pixels. The far crown is a third of
     * the cards at 1.7x the size with a coarser blade pitch, which is also the
     * right answer visually: past ~90 m the mip chain averages fine blades away
     * and a few big soft cards read as a mass where many small ones read as
     * noise.
     */
    const fseed = (sp.id.charCodeAt(0) * 131 + 6151) | 0;
    const fenv = {
      rx: sp.crown[0], ry: sp.crown[1], rz: sp.crown[2], cy: sp.crown[1] + sp.h * sp.lift,
    };
    const fplan = branchPlan(sp.h, fseed, {
      branches: Math.max(3, sp.branches - 2), reach: sp.reach, rise: sp.rise, crown: fenv,
    });
    P(K, `tree_${sp.id}_far_wood`, () => trunkAndBranches(sp.h, sp.r, fseed, {
      twigs: 0, plan: fplan,
    }), sp.bark);
    const fgeo = canopy(Math.max(22, Math.round(sp.n * 0.30)), sp.crown[0], sp.crown[1], sp.crown[2], fseed, {
      size: sp.size * 1.7, lift: sp.h * sp.lift, inner: 0.30,
      pitch: sp.pitch * 1.9, lobes: 4, flat: sp.flat ?? 0, bias: 0.75,
      lobesAt: fplan.prim.map((b) => b.tip),
    });
    for (let li = 0; li < LEAVES.length; li++) {
      K.proto(`tree_${sp.id}_far_leaf${li}`, null, LEAVES[li], { geo: fgeo, shared: true });
    }
  }

  // Conifer, for the park and the hill districts.
  P(K, 'tree_pine_wood', () => trunkAndBranches(7.2, 0.17, 4241, {
    branches: 9, reach: 1.1, rise: 0.5, taper: 0.18, twigs: 10, twigLen: 0.45,
    // the needle whorls below taper from r 2.05 at y 1.35 to r 0.4 at y 6.85;
    // this envelope is the ellipsoid that fits inside that cone
    crown: { rx: 1.75, ry: 3.0, rz: 1.75, cy: 3.5 },
  }), 'bark_street');
  P(K, 'tree_pine_leaf', () => {
    const a = new Accum('pine');
    for (let tier = 0; tier < 7; tier++) {
      const t = tier / 6;
      const y = 1.35 + t * 5.5;
      const r = 2.05 * (1 - t * 0.80);
      const n = 20 - tier * 2;
      for (let i = 0; i < n; i++) {
        const h0 = hash3i(4241, tier * 13 + i, 3);
        const h1 = hash3i(4241, tier * 13 + i, 4);
        const th = (i / n) * TAU + tier * 0.7 + h0 * 0.6;
        const rr = r * (0.55 + 0.5 * h1);
        const g = leafSpray(0.95 * (0.7 + 0.5 * h0), 0.62, 4241 + tier * 97 + i,
          { fold: 0.24, droop: 0.32, pitch: 0.085 });
        const px = Math.cos(th) * rr;
        const pz = Math.sin(th) * rr;
        // needles hang off a drooping whorl: the normal is outward and DOWN
        let ox = px / (r + 0.2);
        let oy = -0.35 + t * 0.5;
        let oz = pz / (r + 0.2);
        const ol = Math.hypot(ox, oy, oz) || 1;
        ox /= ol; oy /= ol; oz /= ol;
        const m = new THREE.Matrix4();
        m.compose(
          new THREE.Vector3(px, y - h1 * 0.2, pz),
          new THREE.Quaternion().setFromEuler(new THREE.Euler(0.55 + h0 * 0.5, th, (h0 - 0.5) * 0.9, 'YXZ')),
          new THREE.Vector3(1, 1, 1)
        );
        const v0 = a.verts;
        a.add(g, m, null, [0.12 + 0.3 * h0, 0.14 + 0.2 * h1, 0.30 + 0.55 * (1 - t)]);
        biasNormals(a, v0, ox, oy, oz, 0.5);
        g.dispose();
      }
    }
    return a.build();
  }, 'leaf_needle');
}

/* ============================================================ understorey == */

export function registerGreen(K) {
  registerTrees(K);

  /* ---- planters and tree pits ---------------------------------------- */
  P(K, 'planter_concrete', () => {
    const g = extrude(ngon(8, 0.62, { wob: 0.025, seed: 21 }), 0.62, { topScale: 1.12, floor: true, floorY: 0.48 });
    weather(g, { grimeBase: 0.85, grimeHeight: 0.8, wear: 0.7, seed: 211, up: 0.6 });
    return g;
  }, 'concrete_prop');
  P(K, 'planter_timber', () => {
    const parts = [];
    for (let i = 0; i < 4; i++) {
      const a = (i / 4) * TAU;
      for (let k = 0; k < 3; k++) {
        parts.push([box(1.06, 0.16, 0.05), newTrs(Math.sin(a) * 0.52, 0.06 + k * 0.18, Math.cos(a) * 0.52, a)]);
      }
      parts.push([box(0.09, 0.62, 0.09), newTrs(Math.sin(a + 0.785) * 0.72, 0, Math.cos(a + 0.785) * 0.72, a)]);
    }
    const g = combine(parts, 'planterwood');
    weather(g, { grimeBase: 0.8, grimeHeight: 0.7, wear: 0.85, seed: 223, up: 0.6 });
    return g;
  }, 'wood_grey');
  P(K, 'planter_soil', () => {
    const g = ngon(9, 0.52, { wob: 0.04, seed: 23 });
    const geo = extrude(g, 0.50, { topScale: 1.0 });
    weather(geo, { grimeBase: 0.95, grimeHeight: 0.6, wear: 0.2, seed: 227, up: 0.9 });
    return geo;
  }, 'soil');

  /* ---- shrubs / hedge blocks ----------------------------------------- */
  const shrub = (n, rx, ry, seed, size, pitch) =>
    canopy(n, rx, ry, rx, seed, { size, lift: 0, inner: 0.16, pitch, lobes: 3, bias: 0.6 });
  P(K, 'shrub_a', () => shrub(40, 0.78, 0.50, 301, 0.62, 0.075), 'leaf_c');
  P(K, 'shrub_b', () => shrub(32, 0.60, 0.42, 307, 0.55, 0.062), 'leaf_a');
  P(K, 'shrub_c', () => shrub(46, 0.92, 0.60, 311, 0.68, 0.085), 'leaf_b');
  P(K, 'hedge_2m', () => {
    const a = new Accum('hedge');
    for (let i = 0; i < 52; i++) {
      const h0 = hash3i(331, i, 1);
      const h1 = hash3i(331, i, 2);
      const h2 = hash3i(331, i, 3);
      const g = leafSpray(0.58, 0.48, 331 + i, { fold: 0.2, droop: 0.1, pitch: 0.065 });
      const px = -0.9 + h0 * 1.8;
      const py = 0.22 + h1 * 0.66;
      const pz = (h2 - 0.5) * 0.52;
      const m = new THREE.Matrix4();
      m.compose(
        new THREE.Vector3(px, py, pz),
        new THREE.Quaternion().setFromEuler(new THREE.Euler((h1 - 0.5) * 1.2, h0 * TAU, (h2 - 0.5) * 1.6, 'YXZ')),
        new THREE.Vector3(1, 1, 1)
      );
      // a clipped hedge is a box: the shell normal points out of the face it is on
      let ox = pz > 0 ? 0.5 : -0.5;
      let oy = 0.7 * clamp01((py - 0.3) / 0.5) + 0.15;
      const ol = Math.hypot(ox, oy, pz) || 1;
      const v0 = a.verts;
      a.add(g, m, null, [0.12 + 0.4 * h0, 0.12 + 0.22 * h1, 0.25 + 0.6 * (1 - h1)]);
      biasNormals(a, v0, ox / ol, oy / ol, (pz * 2) / ol, 0.55);
      g.dispose();
    }
    return a.build();
  }, 'leaf_c');

  /* ---- scrub on waste ground and the riverbank ------------------------ */
  P(K, 'scrub_clump', () => {
    const a = new Accum('scrub');
    for (let i = 0; i < 20; i++) {
      const h0 = hash3i(401, i, 1);
      const h1 = hash3i(401, i, 2);
      const h2 = hash3i(401, i, 3);
      const g = leafSpray(0.42 + h0 * 0.34, 0.56 + h1 * 0.34, 401 + i,
        { fold: 0.28, droop: 0.22, pitch: 0.058 });
      const px = (h0 - 0.5) * 0.72;
      const py = 0.22 + h1 * 0.46;
      const pz = (h1 - 0.5) * 0.72;
      const m = new THREE.Matrix4();
      m.compose(
        new THREE.Vector3(px, py, pz),
        new THREE.Quaternion().setFromEuler(new THREE.Euler(0.10 + h1 * 0.5, h0 * TAU, (h0 - 0.5) * 0.8, 'YXZ')),
        new THREE.Vector3(1, 1, 1)
      );
      const v0 = a.verts;
      a.add(g, m, null, [0.18 + 0.4 * h0, 0.16 + 0.3 * h2, 0.20 + 0.5 * (1 - h1)]);
      biasNormals(a, v0, px * 1.4, 0.55, pz * 1.4, 0.55);
      g.dispose();
    }
    return a.build();
  }, 'scrub');

  /** Riverbank willow scrub — taller, looser, hangs toward the water. */
  P(K, 'scrub_bank', () => {
    const a = new Accum('bank');
    for (let i = 0; i < 34; i++) {
      const h0 = hash3i(409, i, 1);
      const h1 = hash3i(409, i, 2);
      const h2 = hash3i(409, i, 3);
      const g = leafSpray(0.40 + h0 * 0.30, 0.72 + h1 * 0.42, 409 + i,
        { fold: 0.30, droop: 0.42, pitch: 0.050 });
      const th = h0 * TAU;
      const rr = 0.15 + 0.75 * Math.sqrt(h2);
      const px = Math.cos(th) * rr;
      const pz = Math.sin(th) * rr;
      const py = 0.30 + h1 * 1.35 * (1 - rr * 0.5);
      const m = new THREE.Matrix4();
      m.compose(
        new THREE.Vector3(px, py, pz),
        new THREE.Quaternion().setFromEuler(new THREE.Euler(0.3 + h1 * 0.7, th + (h0 - 0.5) * 1.4, (h2 - 0.5) * 1.2, 'YXZ')),
        new THREE.Vector3(1, 1, 1)
      );
      const v0 = a.verts;
      a.add(g, m, null, [0.14 + 0.4 * h0, 0.14 + 0.26 * h2, 0.22 + 0.55 * (1 - h1)]);
      biasNormals(a, v0, px * 1.2, 0.6, pz * 1.2, 0.55);
      g.dispose();
    }
    return a.build();
  }, 'scrub');

  P(K, 'weed_tuft', () => {
    const a = new Accum('weeds');
    for (let i = 0; i < 11; i++) {
      const h0 = hash3i(419, i, 1);
      const h1 = hash3i(419, i, 2);
      const g = leafSpray(0.20 + h0 * 0.18, 0.28 + h1 * 0.22, 419 + i,
        { fold: 0.34, droop: 0.24, pitch: 0.040 });
      const px = (h0 - 0.5) * 0.22;
      const pz = (h1 - 0.5) * 0.22;
      const m = new THREE.Matrix4();
      m.compose(
        new THREE.Vector3(px, 0.10 + h1 * 0.16, pz),
        new THREE.Quaternion().setFromEuler(new THREE.Euler(0.15 + h0 * 0.5, h1 * TAU, (h0 - 0.5) * 0.7, 'YXZ')),
        new THREE.Vector3(1, 1, 1)
      );
      const v0 = a.verts;
      a.add(g, m, null, [0.2 + 0.4 * h1, 0.26, 0.18]);
      biasNormals(a, v0, px * 2, 0.8, pz * 2, 0.5);
      g.dispose();
    }
    return a.build();
  }, 'scrub', { castShadow: false });

  /**
   * GRASS: real blades, not a green card.
   *
   * This was three crossed quads carrying an OPAQUE top-down grass-field
   * texture, which is the "green fur" defect exactly — a lawn texture stood on
   * its edge has no silhouette, no translucency and no direction, and at a
   * metre away it is unmistakably a rectangle. A blade is four triangles: a
   * tapered, curved strip that ends in a point, so the silhouette is geometry
   * and the material only has to supply colour. Fourteen of them is 56
   * triangles for a tuft the player can stand on top of.
   */
  P(K, 'grass_clump', () => {
    const a = new Accum('grass');
    const N = 10;
    for (let i = 0; i < N; i++) {
      const h0 = hash3i(431, i, 1);
      const h1 = hash3i(431, i, 2);
      const h2 = hash3i(431, i, 3);
      const len = 0.17 + 0.20 * h0;
      const wid = 0.017 + 0.011 * h1;
      const bend = (0.25 + 0.6 * h2) * len;
      const SEG = 3;
      const g = new Accum('blade');
      const verts = [];
      // the UV window: a narrow vertical streak of the grass bake per blade, so
      // one blade is one coherent run of colour rather than a tiled field
      const u0 = h1 * 0.9;
      for (let s = 0; s <= SEG; s++) {
        const t = s / SEG;
        const w = wid * (1 - t * 0.92);
        const y = len * t;
        // a blade arcs over: the tip is well out from the root
        const z = bend * t * t;
        // tangent along the blade is (0, dy, dz); the face normal is (0,-dz,dy)
        const dy = len / SEG;
        const dz = 2 * bend * t / SEG;
        const nl = Math.hypot(dy, dz) || 1;
        const ny = dz / nl;
        const nz = dy / nl;
        verts.push([
          g.vert(-w, y, z, 0, ny, nz, u0, 0.08 + t * 0.5, 0.2, 0.3, 0.5 * (1 - t)),
          g.vert(w, y, z, 0, ny, nz, u0 + 0.05, 0.08 + t * 0.5, 0.2, 0.3, 0.5 * (1 - t)),
        ]);
      }
      for (let s = 0; s < SEG; s++) {
        g.quad(verts[s][0], verts[s + 1][0], verts[s + 1][1], verts[s][1]);
      }
      const geo = g.build();
      const th = h0 * TAU + (i / N) * TAU;
      const m = new THREE.Matrix4();
      m.compose(
        new THREE.Vector3(Math.cos(th) * 0.09 * h1, 0, Math.sin(th) * 0.09 * h1),
        new THREE.Quaternion().setFromEuler(new THREE.Euler((h2 - 0.5) * 0.5, th, (h1 - 0.5) * 0.5, 'YXZ')),
        new THREE.Vector3(1, 1, 1)
      );
      const v0 = a.verts;
      a.add(geo, m, null, [0.3, 0.35 + 0.45 * h0, 0.6]);
      biasNormals(a, v0, 0, 0.9, 0, 0.5);
      geo.dispose();
    }
    return a.build();
  }, 'grass_blade', { castShadow: false });

  /* ---- ivy: a wall panel of leaves that hangs off a gable -------------- */
  P(K, 'ivy_panel', () => {
    const a = new Accum('ivy');
    for (let i = 0; i < 64; i++) {
      const h0 = hash3i(457, i, 1);
      const h1 = hash3i(457, i, 2);
      const h2 = hash3i(457, i, 3);
      // denser at the bottom, ragged at the top: ivy climbs, it does not fall
      const y = (1 - Math.sqrt(h1)) * 3.2;
      const g = leafSpray(0.30 + h0 * 0.22, 0.26 + h2 * 0.20, 457 + i,
        { fold: 0.22, droop: 0.16, pitch: 0.052 });
      const m = new THREE.Matrix4();
      m.compose(
        new THREE.Vector3((h0 - 0.5) * 2.6, y + 0.15, 0.04 + h2 * 0.14),
        new THREE.Quaternion().setFromEuler(new THREE.Euler((h1 - 0.5) * 1.0, (h0 - 0.5) * 1.6, (h2 - 0.5) * 2.2, 'YXZ')),
        new THREE.Vector3(1, 1, 1)
      );
      const v0 = a.verts;
      a.add(g, m, null, [0.15 + 0.35 * h0, 0.15 + 0.25 * h2, 0.20 + 0.5 * (1 - y / 3.2)]);
      biasNormals(a, v0, 0, 0.25, 0.97, 0.55);
      g.dispose();
    }
    return a.build();
  }, 'leaf_c', { castShadow: false });
}
