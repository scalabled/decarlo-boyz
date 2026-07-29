/**
 * PEDS — outfit assembly.
 *
 * Turns one entry of `SHAPES` into a finished, skinned, material-grouped
 * geometry. One geometry per silhouette, shared by every pedestrian wearing it;
 * only the skeleton and the twelve-entry colour palette are per person.
 *
 * Parts are added in `MATERIAL_SLOTS` order — cloth, skin, gear — because the
 * order the builder first sees a material name is the order the geometry groups
 * come out in, and three sorts opaque draws by `Material.id`. Getting that
 * backwards flips the depth tie on coplanar surfaces (a shoe sole against its
 * upper, a lapel against the chest) behind the depth prepass.
 */

import * as THREE from 'three';
import { RIG } from './rig.js';
import { CharacterBuilder, Noise, SLOT, ribbon, warp } from './geo.js';
import { TILE, MATERIAL_SLOTS } from './materials.js';
import { SHAPES } from './wardrobe.js';
import * as P from './parts.js';
import { torsoFrontZ } from './parts.js';

const bp = (name) => RIG.pos(name);

/** Leg garment section radii, hip -> knee -> ankle. */
const LEG_RADII = {
  trouser: [0.092, 0.086, 0.076, 0.068, 0.062, 0.060, 0.066],
  jeans: [0.088, 0.082, 0.071, 0.062, 0.056, 0.054, 0.058],
  legging: [0.080, 0.074, 0.062, 0.053, 0.046, 0.043, 0.045],
  shorts: [0.098, 0.094, 0.088, 0.084, 0.080, 0.078, 0.076],
};

/**
 * @param shapeId  key into SHAPES
 * @param opts     { rng, lod }
 * @returns { geometry, materialNames, stats, shape }
 */
export function buildOutfit(shapeId, { rng, lod = 0 } = {}) {
  const S = SHAPES[shapeId] ?? SHAPES.jacketM;
  const nz = new Noise(rng.fork());
  const B = new CharacterBuilder(RIG, {
    noise: nz,
    materials: { cloth: { tile: TILE.cloth }, skin: { tile: TILE.skin }, gear: { tile: TILE.gear } },
  });
  const queued = [];
  const add = (mesh, o) => { if (mesh && mesh.p.length) queued.push([mesh, o]); };

  const q = lod > 0 ? 0.62 : 1;               // ring/segment budget multiplier
  const R = (n) => Math.max(4, Math.round(n * q));

  const shR = bp('UpperArmR'), elR = bp('ForearmR'), wrR = bp('HandR');
  const shL = bp('UpperArmL'), elL = bp('ForearmL'), wrL = bp('HandL');
  const hipR = bp('UpLegR'), knR = bp('LegR'), anR = bp('FootR');
  const hipL = bp('UpLegL'), knL = bp('LegL'), anL = bp('FootL');
  const head = bp('Head');

  const bulk = S.bulk ?? 1;
  const hipW = S.hipW ?? 1;
  const sleeveR = S.sleeveR ?? 0.055;
  const legs = S.legs ?? 'trouser';
  const feet = S.feet ?? 'dress';
  const ex = new Set(S.extras ?? []);
  const shellOpts = {
    hem: S.hem, bulk, flare: S.flare ?? 1, bust: S.bust ?? 0, belly: S.belly ?? 0,
    waist: S.waist ?? 1, shoulder: S.shoulder ?? 1, thick: S.thick ?? 0.008,
  };
  const frontZ = (y) => torsoFrontZ(y, shellOpts);

  /* ---------------- occlusion proxies (drive baked vertex AO) --------
   * These describe what the BODY occludes, never what a part occludes of
   * itself. A capsule laid down the arm darkens the whole sleeve — which is how
   * the first pass ended up with deltoids that read as separate black balls
   * bolted to the shoulders.
   */
  B.occlude([0, 0.94, -0.01], [0, 1.34, 0.0], 0.132 * bulk, 1.0);   // torso core
  B.occlude([0, 1.40, -0.01], [0, 1.50, -0.01], 0.078, 1.0);        // under the chin
  B.occlude([-0.132, 1.10, 0.0], [-0.140, 1.36, 0.0], 0.052, 0.9);  // right ribcage
  B.occlude([0.132, 1.10, 0.0], [0.140, 1.36, 0.0], 0.052, 0.9);    // left ribcage
  B.occlude([0, 0.90, -0.01], [0, 1.00, -0.01], 0.132 * bulk, 0.6); // waist / belt line
  B.occlude([0, 0.62, 0.0], [0, 0.92, 0.0], 0.050, 0.85);           // between the legs
  B.occlude([-0.10, 0.08, 0.02], [-0.10, 0.15, 0.02], 0.050, 0.8);  // ankle
  B.occlude([0.10, 0.08, 0.02], [0.10, 0.15, 0.02], 0.050, 0.8);
  B.occlude([wrR[0], wrR[1] + 0.02, wrR[2]], [wrR[0], wrR[1] + 0.06, wrR[2]], 0.028, 0.8);
  B.occlude([wrL[0], wrL[1] + 0.02, wrL[2]], [wrL[0], wrL[1] + 0.06, wrL[2]], 0.028, 0.8);
  B.occlude([knR[0], knR[1] - 0.02, knR[2] - 0.012], [knR[0], knR[1] + 0.02, knR[2] - 0.012], 0.058, 0.5);
  B.occlude([knL[0], knL[1] - 0.02, knL[2] - 0.012], [knL[0], knL[1] + 0.02, knL[2] - 0.012], 0.058, 0.5);
  if (S.hat || ex.has('hoodUp')) {
    B.occlude([-0.09, head[1] + 0.112, head[2] + 0.04], [0.09, head[1] + 0.112, head[2] + 0.04], 0.048, 1.0);
  }
  if (ex.has('hood')) B.occlude([0, 1.30, -0.09], [0, 1.42, -0.10], 0.09, 0.85);
  if (ex.has('pack')) B.occlude([0, 1.10, -0.13], [0, 1.34, -0.13], 0.10, 0.8);
  if (ex.has('scarf')) B.occlude([0, 1.36, 0.0], [0, 1.44, 0.0], 0.09, 0.85);
  // brow shelf over each eye: a face with no shadow in the sockets is a mask
  B.occlude([-0.048, head[1] + 0.107, head[2] + 0.060], [-0.016, head[1] + 0.107, head[2] + 0.068], 0.011, 0.85);
  B.occlude([0.016, head[1] + 0.107, head[2] + 0.068], [0.048, head[1] + 0.107, head[2] + 0.060], 0.011, 0.85);
  B.occlude([0, head[1] - 0.010, head[2] + 0.030], [0, head[1] - 0.060, head[2] + 0.010], 0.052, 0.9);

  /* ================================================================== */
  /* CLOTH                                                              */
  /* ================================================================== */

  const spine = ['Hips', 'Spine', 'Spine1', 'Spine2', 'Neck', 'ClavicleR', 'ClavicleL', 'UpperArmR', 'UpperArmL'];
  const spineBias = [1, 1, 1, 1, 0.75, 0.5, 0.5, 0.26, 0.26];
  /**
   * The two arm bones are RADIAL on a torso shell — weighted by distance from
   * the shoulder JOINT, not from the whole arm. The arm hangs beside the ribs
   * in this bind pose, so segment distance handed the coat's flank to the arm.
   * See `_bind` in geo.js.
   */
  const spineJoint = ['UpperArmR', 'UpperArmL'];

  // --- inner layer: the shirt/jumper you see at the neck and the opening ---
  add(
    P.torsoShell(nz, {
      hem: Math.max(0.86, S.hem + 0.06), bulk: bulk * 0.985, flare: 0.6,
      bust: (S.bust ?? 0) * 0.9, belly: (S.belly ?? 0) * 0.9,
      waist: S.waist ?? 1, shoulder: (S.shoulder ?? 1) * 0.96, thick: 0.0,
      rows: R(10), seg: R(22), drape: 0.8,
    }),
    {
      material: 'cloth', bones: spine, bias: spineBias, joint: spineJoint, slot: SLOT.under,
      grime: 0.55, dirt: 0.06, dust: 0.10, name: 'inner',
    }
  );

  // --- the top garment ---
  add(
    P.torsoShell(nz, { ...shellOpts, rows: R(15), seg: R(26) }),
    {
      material: 'cloth', bones: spine, bias: spineBias, joint: spineJoint, slot: SLOT.top,
      grime: 0.80, dirt: 0.26, dust: 0.28, wear: 0.10, name: 'top',
    }
  );

  // quilting on a puffa: horizontal channels, the whole silhouette cue
  if (ex.has('quilt')) {
    for (let i = 0; i < 6; i++) {
      const y = S.hem + 0.055 + i * 0.098;
      if (y > 1.36) break;
      const pts = [];
      const n = R(22);
      for (let j = 0; j <= n; j++) {
        const a = (j / n) * Math.PI * 2;
        pts.push([
          Math.sin(a) * (0.176 * bulk + 0.004),
          y + Math.sin(a * 3) * 0.004,
          Math.cos(a) * (0.132 * bulk + 0.004) - 0.004,
        ]);
      }
      const band = ribbon(pts, 0.010, 0.006, { seg: 5, up: [0, 1, 0], upright: true });
      add(band, {
        material: 'cloth', bones: ['Spine', 'Spine1', 'Spine2', 'Hips'], bias: [1, 1, 1, 0.6],
        slot: SLOT.top, shade: 0.86, grime: 1.0, dust: 0.2, name: `quilt${i}`,
      });
    }
  }

  if (ex.has('lapels')) {
    add(P.lapels(nz, { top: 1.356, notch: 1.222, hem: Math.max(S.hem, 0.70), w: (S.shoulder ?? 1), frontZ }), {
      material: 'cloth', bones: ['Spine1', 'Spine2', 'ClavicleR', 'ClavicleL'], bias: [1, 1, 0.5, 0.5],
      slot: SLOT.top, shade: 1.04, grime: 0.7, dust: 0.3, wear: 0.12, name: 'lapels',
    });
  }
  if (ex.has('collar') || ex.has('lapels')) {
    add(P.collar(nz, { y: 1.386, r: 1, open: !ex.has('lapels') }), {
      material: 'cloth', bones: ['Neck', 'Spine2', 'Head'], bias: [1, 0.8, 0.25],
      slot: ex.has('lapels') ? SLOT.top : SLOT.under,
      grime: 1.0, dust: 0.25, wear: 0.16, name: 'collar',
    });
  }
  if (ex.has('tie')) {
    add(P.tie(), {
      material: 'cloth', bones: ['Spine2', 'Spine1', 'Neck'], bias: [1, 0.8, 0.4],
      slot: SLOT.accent, grime: 0.4, dust: 0.1, name: 'tie',
    });
  }
  if (ex.has('scarf')) {
    const sc = P.collar(nz, { y: 1.352, r: 1.24 });
    add(sc, {
      material: 'cloth', bones: ['Neck', 'Spine2', 'Head'], bias: [1, 0.9, 0.2],
      slot: SLOT.accent, grime: 0.7, dust: 0.3, name: 'scarf',
    });
  }
  if (ex.has('hood')) {
    add(P.hoodDown(nz), {
      material: 'cloth', bones: ['Spine2', 'Neck', 'Spine1'], bias: [1, 0.7, 0.5],
      slot: SLOT.top, shade: 0.94, grime: 0.9, dust: 0.35, name: 'hood',
    });
  }
  if (ex.has('hoodUp')) {
    add(P.hoodUp(nz), {
      material: 'cloth', bones: ['Head', 'Neck', 'Spine2'], bias: [1, 0.8, 0.3],
      slot: SLOT.top, shade: 0.92, grime: 0.85, dust: 0.35, name: 'hoodUp',
    });
  }
  if (ex.has('apron')) {
    const ap = P.torsoShell(nz, {
      hem: 0.60, bulk: bulk * 1.02, flare: 1.1, waist: 1.0, shoulder: 0.6,
      thick: 0.004, rows: R(9), seg: R(20), capHem: false, drape: 1.2,
    });
    // keep only the front half
    warp(ap, (v) => {
      if (v.z < -0.02) v.z = -0.02 + (v.z + 0.02) * 0.05;
      if (v.y > 1.16) v.x *= 0.55;
    });
    add(ap, {
      material: 'cloth', bones: ['Hips', 'Spine', 'Spine1'], bias: [1, 1, 0.7],
      slot: SLOT.accent, shade: 0.95, grime: 1.0, dirt: 0.9, dust: 0.3, wear: 0.24, name: 'apron',
    });
  }

  // --- sleeves ---
  for (const [sh, el, wr, side, sx] of [[shR, elR, wrR, -1, 'R'], [shL, elL, wrL, 1, 'L']]) {
    add(P.shoulderCap(nz, sh, side, sleeveR * 0.95 + (S.thick ?? 0) * 0.3), {
      material: 'cloth', bones: [`Clavicle${sx}`, `UpperArm${sx}`, 'Spine2'], bias: [0.8, 1, 0.4],
      slot: SLOT.top, grime: 0.75, dirt: 0.12, dust: 0.28, wear: 0.10, name: `shoulder${sx}`,
    });
    // `sleeveR` is the BICEPS radius; the shoulder is carried by the deltoid
    // cap, not by a fat first ring — a sleeve that starts wider than the
    // shoulder is the leg-of-mutton silhouette that made the first pass read
    // as a Victorian dress.
    add(
      P.limbTube(
        nz,
        [sh[0] + side * 0.004, sh[1] + 0.006, sh[2]],
        el,
        [wr[0], wr[1] + 0.030, wr[2]],
        [0.98, 1.00, 0.90, 0.82, 0.76, 0.72, 0.70].map((v) => v * sleeveR),
        { rings: R(20), seg: R(15), fold: 0.0016, crease: 0.0030, bend: [0, 0, -1], band: 0.052 }
      ),
      {
        material: 'cloth',
        bones: [`Clavicle${sx}`, `UpperArm${sx}`, `Forearm${sx}`, `Hand${sx}`, 'Spine2'],
        bias: [0.5, 1, 1, 0.6, 0.22],
        slot: SLOT.top, grime: 0.75, dirt: 0.12, dust: 0.28, wear: 0.14, name: `sleeve${sx}`,
      }
    );
    add(P.cuff(nz, [wr[0], wr[1] + 0.036, wr[2]], [0, 1, 0], sleeveR * 0.72 + 0.003, 0.016), {
      material: 'cloth', bones: [`Forearm${sx}`, `Hand${sx}`], bias: [1, 0.6],
      slot: SLOT.top, shade: 0.94, grime: 1.0, dirt: 0.2, wear: 0.26, name: `cuff${sx}`,
    });
  }

  // --- lower body ---
  add(P.pelvis(nz, { bulk, hipW, seat: 1 }), {
    material: 'cloth', bones: ['Hips', 'Spine', 'UpLegR', 'UpLegL'], bias: [1, 0.55, 0.5, 0.5],
    slot: SLOT.bottom, grime: 0.85, dirt: 0.2, dust: 0.16, name: 'pelvis',
  });

  if (legs === 'skirt') {
    add(P.skirt(nz, { hem: S.hem < 0.7 ? 0.60 : 0.56, top: 0.99, flare: 1.0, pleats: 12 }), {
      // Radial hips, same reason as the torso shell: the thigh SEGMENTS run
      // straight down through a skirt's volume, so segment distance made the
      // fabric between the knees belong to whichever leg was nearer and tore
      // it in two when they scissored (measured 75.6 mm -> 201.2 mm walking).
      material: 'cloth', bones: ['Hips', 'UpLegR', 'UpLegL', 'Spine'], bias: [1, 0.35, 0.35, 0.4],
      joint: ['UpLegR', 'UpLegL'],
      slot: SLOT.bottom, grime: 0.8, dirt: 0.35, dust: 0.18, name: 'skirt',
    });
    // stockinged legs
    for (const [hip, kn, an, sx] of [[hipR, knR, anR, 'R'], [hipL, knL, anL, 'L']]) {
      add(
        P.limbTube(nz, [hip[0], hip[1] - 0.10, hip[2]], kn, [an[0], an[1] + 0.075, an[2] + 0.006],
          [0.062, 0.058, 0.050, 0.045, 0.040, 0.037, 0.038], { rings: R(14), seg: R(13), fold: 0.0008 }),
        {
          material: 'skin', bones: ['Hips', `UpLeg${sx}`, `Leg${sx}`, `Foot${sx}`], bias: [0.4, 1, 1, 0.5],
          slot: SLOT.skin, shade: 0.92, grime: 0.3, dirt: 0.1, name: `bareLeg${sx}`,
        }
      );
    }
  } else {
    const radii = LEG_RADII[legs] ?? LEG_RADII.trouser;
    for (const [hip, kn, an, sx] of [[hipR, knR, anR, 'R'], [hipL, knL, anL, 'L']]) {
      add(
        P.limbTube(nz, hip, kn, [an[0], an[1] + 0.078, an[2] + 0.008], radii, {
          rings: R(22), seg: R(16), fold: 0.0018,
          crease: legs === 'legging' ? 0.0016 : 0.0042,
          bend: [0, 0, -1], band: legs === 'jeans' ? 0.062 : 0.055,
        }),
        {
          material: 'cloth', bones: ['Hips', `UpLeg${sx}`, `Leg${sx}`, `Foot${sx}`], bias: [0.55, 1, 1, 0.45],
          slot: SLOT.bottom, grime: 0.8, dirt: 0.75, dust: 0.18, wear: 0.12, name: `leg${sx}`,
        }
      );
    }
  }

  // --- hi-vis over everything ---
  if (ex.has('hivis')) {
    add(P.hiVis(nz, { bulk }), {
      material: 'cloth', bones: ['Spine', 'Spine1', 'Spine2', 'Hips'], bias: [1, 1, 1, 0.5],
      slot: SLOT.accent, grime: 0.75, dirt: 0.35, dust: 0.4, wear: 0.2, name: 'hivis',
    });
  }

  // --- soft headwear ---
  if (S.hat === 'beanie') {
    add(P.beanie(nz, head), {
      material: 'cloth', bone: 'Head', slot: SLOT.hat, grime: 0.7, dust: 0.3, wear: 0.14, name: 'beanie',
    });
  } else if (S.hat === 'flat') {
    add(P.flatCap(nz, head), {
      material: 'cloth', bone: 'Head', slot: SLOT.hat, grime: 0.75, dust: 0.20, wear: 0.14, name: 'flatcap',
    });
  } else if (S.hat === 'ball') {
    add(P.ballCap(nz, head, false), {
      material: 'cloth', bone: 'Head', slot: SLOT.hat, grime: 0.8, dust: 0.20, wear: 0.16, name: 'ballcap',
    });
  }

  /* ================================================================== */
  /* SKIN                                                               */
  /* ================================================================== */

  add(P.headMesh(nz, head, { wide: S.bust ? 0.978 : 1.0, jaw: S.bust ? 0.92 : 1.0, cheek: S.bust ? 1.15 : 1 }), {
    material: 'skin', bone: 'Head', slot: SLOT.skin, grime: 0.22, dirt: 0, dust: 0.04, name: 'head',
  });
  add(P.nose(nz, head, { size: S.bust ? 0.90 : 1.0 }), {
    material: 'skin', bone: 'Head', slot: SLOT.skin, grime: 0.16, dust: 0, name: 'nose',
  });
  add(P.nostrils(head, S.bust ? 0.90 : 1.0), {
    material: 'skin', bone: 'Head', slot: SLOT.skin, shade: 0.28, grime: 0.85, dust: 0, name: 'nostrils',
  });
  if (!S.hat || S.hat === 'flat') {
    add(P.ear(nz, head, -1), { material: 'skin', bone: 'Head', slot: SLOT.skin, grime: 0.4, name: 'earR' });
    add(P.ear(nz, head, 1), { material: 'skin', bone: 'Head', slot: SLOT.skin, grime: 0.4, name: 'earL' });
  }
  add(P.lips(head), { material: 'skin', bone: 'Head', slot: SLOT.skin, shade: 0.86, grime: 0.20, dust: 0, name: 'lips' });
  add(P.mouthLine(head), { material: 'skin', bone: 'Head', slot: SLOT.skin, shade: 0.42, grime: 0.6, dust: 0, name: 'mouth' });
  add(P.neck(nz, head, S.bust ? 0.90 : 1.0), {
    material: 'skin', bones: ['Neck', 'Head', 'Spine2'], bias: [1, 0.7, 0.4], slot: SLOT.skin,
    grime: 0.4, name: 'neck',
  });

  // wrists + hands
  for (const [wr, el, side, sx] of [[wrR, elR, -1, 'R'], [wrL, elL, 1, 'L']]) {
    add(
      P.limbTube(nz, [wr[0], wr[1] + 0.056, wr[2] - 0.004], [wr[0], wr[1] + 0.030, wr[2]], wr,
        [0.032, 0.030, 0.028], { rings: 4, seg: 11, fold: 0.0006 }),
      { material: 'skin', bones: [`Forearm${sx}`, `Hand${sx}`], bias: [1, 0.8], slot: SLOT.skin,
        grime: 0.4, name: `wrist${sx}` }
    );
    const down = [
      wr[0] - el[0] || (side * -0.013),
      wr[1] - el[1],
      wr[2] - el[2],
    ];
    const dl = Math.hypot(down[0], down[1], down[2]) || 1;
    const D = [down[0] / dl, down[1] / dl, down[2] / dl];
    // palm faces the thigh: the outward palm normal points inboard
    const palmN = [-side * 0.94, 0.05, 0.34];
    add(P.hand(nz, wr, D, palmN, side, { curl: 0.60, scale: 1 }), {
      material: 'skin', bones: [`Hand${sx}`, `Fingers${sx}`, `Forearm${sx}`], bias: [1, 0.9, 0.35],
      slot: SLOT.skin, grime: 0.5, dirt: 0.1, name: `hand${sx}`,
    });
  }

  if (S.hair && S.hair !== 'bald') {
    add(P.hair(nz, head, S.hair, { recede: S.bust ? 0.18 : 0.4 }), {
      material: 'skin', bone: 'Head', slot: SLOT.hair, shade: 1.0, grime: 0.35, dust: 0.10, name: 'hair',
    });
  }
  add(P.brows(head, -1), { material: 'skin', bone: 'Head', slot: SLOT.hair, grime: 0.2, name: 'browR' });
  add(P.brows(head, 1), { material: 'skin', bone: 'Head', slot: SLOT.hair, grime: 0.2, name: 'browL' });
  add(P.eyelid(head, -1), { material: 'skin', bone: 'Head', slot: SLOT.skin, shade: 0.88, grime: 0.35, dust: 0, name: 'lidR' });
  add(P.eyelid(head, 1), { material: 'skin', bone: 'Head', slot: SLOT.skin, shade: 0.88, grime: 0.35, dust: 0, name: 'lidL' });
  add(P.lowerLid(head, -1), { material: 'skin', bone: 'Head', slot: SLOT.skin, shade: 0.92, grime: 0.3, dust: 0, name: 'lowR' });
  add(P.lowerLid(head, 1), { material: 'skin', bone: 'Head', slot: SLOT.skin, shade: 0.92, grime: 0.3, dust: 0, name: 'lowL' });
  if (!S.bust && (shapeId === 'millM' || shapeId === 'workM' || shapeId === 'oldM' || shapeId === 'jacketM')) {
    add(P.beard(nz, head, shapeId === 'oldM' ? 0.6 : 1.0), {
      material: 'skin', bone: 'Head', slot: SLOT.hair, shade: 0.9, grime: 0.3, name: 'beard',
    });
  }

  /* ================================================================== */
  /* GEAR                                                               */
  /* ================================================================== */

  for (const [an, sx] of [[anR, 'R'], [anL, 'L']]) {
    add(P.shoe(nz, an, sx === 'R' ? -1 : 1, feet), {
      material: 'gear', bones: [`Leg${sx}`, `Foot${sx}`, `Toe${sx}`], bias: [0.45, 1, 0.6],
      slot: SLOT.shoe, grime: 0.9, dirt: 0.75, dust: 0.06, wear: 0.06, name: `shoe${sx}`,
    });
    add(P.shoeSole(an, feet), {
      material: 'gear', bones: [`Foot${sx}`, `Toe${sx}`], bias: [1, 0.8],
      slot: SLOT.dark, grime: 0.9, dirt: 1.0, name: `sole${sx}`,
    });
  }
  for (const side of [-1, 1]) {
    add(P.eyeball(head, side), {
      material: 'gear', bone: 'Head', slot: SLOT.skin2, shade: 1.0, grime: 0.30, dust: 0, name: 'sclera',
    });
    add(P.iris(head, side), {
      material: 'gear', bone: 'Head', slot: SLOT.dark, shade: 1.0, grime: 0.1, dust: 0, name: 'iris',
    });
  }
  if (ex.has('belt')) {
    add(P.belt(nz, legs === 'skirt' ? 0.99 : 0.972, hipW), {
      material: 'gear', bones: ['Hips', 'Spine'], bias: [1, 0.4], slot: SLOT.shoe,
      grime: 1.0, dirt: 0.3, wear: 0.28, name: 'belt',
    });
  }
  if (ex.has('buttons')) {
    add(P.buttons(ex.has('lapels') ? 3 : 5, Math.max(S.hem + 0.08, 0.88), ex.has('lapels') ? 1.18 : 1.30, frontZ), {
      material: 'gear', bones: ['Spine', 'Spine1'], bias: [1, 1], slot: SLOT.hard,
      grime: 0.4, name: 'buttons',
    });
  }
  if (ex.has('zip')) {
    const zp = [];
    for (let i = 0; i <= 5; i++) {
      const t = i / 5;
      const zy = S.hem + 0.05 + t * (1.34 - S.hem - 0.05);
      zp.push([0.004, zy, frontZ(zy) + 0.006]);
    }
    add(ribbon(zp, 0.014, 0.005, { seg: 5, up: [0, 0, 1] }), {
      material: 'gear', bones: ['Spine', 'Spine1', 'Spine2'], bias: [1, 1, 0.7], slot: SLOT.hard,
      grime: 0.5, name: 'zip',
    });
  }
  if (S.hat === 'hard') {
    add(P.hardHat(nz, head), {
      material: 'gear', bone: 'Head', slot: SLOT.hat, grime: 0.55, dirt: 0.2, dust: 0.28, wear: 0.18,
      name: 'hardhat',
    });
  }
  if (ex.has('hivis')) {
    add(P.hiVisBands({ bulk }), {
      material: 'gear', bones: ['Spine', 'Spine1', 'Spine2', 'ClavicleR', 'ClavicleL'],
      bias: [1, 1, 1, 0.5, 0.5], slot: SLOT.extra, shade: 1.0, grime: 0.4, dust: 0.25, name: 'hivisBands',
    });
  }
  if (ex.has('pack')) {
    add(P.backpack(nz), {
      material: 'gear', bones: ['Spine1', 'Spine2', 'Spine'], bias: [1, 0.9, 0.5], slot: SLOT.extra,
      grime: 0.85, dirt: 0.2, dust: 0.4, wear: 0.26, name: 'pack',
    });
  }
  if (ex.has('bag')) {
    add(P.shoulderBag(nz, 1), {
      material: 'gear', bones: ['Spine1', 'Spine2', 'Hips', 'Spine'], bias: [1, 0.8, 0.5, 0.6],
      slot: SLOT.extra, grime: 0.8, dirt: 0.25, dust: 0.3, wear: 0.24, name: 'bag',
    });
  }

  /* ---------------- emit in material-slot order --------------------- */
  queued.sort((a, b) => MATERIAL_SLOTS.indexOf(a[1].material) - MATERIAL_SLOTS.indexOf(b[1].material));
  for (const [mesh, o] of queued) B.add(mesh, o);

  const built = B.build();
  const order = built.materialNames.join();
  const want = MATERIAL_SLOTS.filter((s) => built.materialNames.includes(s)).join();
  if (order !== want) {
    console.warn(`[peds] material slot order drifted (${order} vs ${want})`);
  }
  /**
   * THE CROWN OF THIS SILHOUETTE, from the EMITTED vertices rather than from
   * the rig. `rig.js` puts HeadTop 0.240 m over the Head bone, but a beanie, a
   * cap or a raised hood is taller than the skull it sits on — measured across
   * the wardrobe, 0.240 to 0.283 — and that difference is spent out of the
   * ~60 mm of headliner clearance `vehicles.seatAnchor` leaves a seated driver.
   * A ped seated on a budget that assumed a bare head wears his hat through the
   * roof of a low car. `ped.js` sinks the seat by whatever this exceeds.
   *
   * Costs one pass over the bind-pose vertices, once per SILHOUETTE (the pool
   * caches by `shapeId`), never per pedestrian and never per frame.
   */
  const pos = built.geometry.getAttribute('position');
  let crown = 0;
  for (let i = 0; i < pos.count; i++) {
    const y = pos.getY(i);
    if (y > crown) crown = y;
  }
  return {
    geometry: built.geometry,
    materialNames: built.materialNames,
    parts: built.parts,
    shape: S,
    shapeId,
    crown,
    stats: { vertices: built.vertices, triangles: built.triangles },
  };
}

/**
 * A far-LOD stand-in body: seven rounded capsules (head, chest, hips, two arms,
 * two legs) driven analytically from the gait phase, drawn as ONE InstancedMesh
 * for the whole distant crowd. At 55 m a pedestrian is roughly twenty pixels
 * tall; what has to be right is the silhouette, the colour and the fact that it
 * is MOVING. A geometry-accurate ped there costs a draw call and buys nothing.
 */
export function buildCrowdCapsule() {
  const g = new THREE.CapsuleGeometry(0.5, 1.0, 4, 10);
  g.computeBoundingSphere();
  return g;
}

export { MATERIAL_SLOTS };
