import { buildFists, buildPipe, buildWrench, buildCrowbar } from './melee.js';
import { buildNailGun, buildTackCannon, buildPaintCannon, buildShopSmg } from './light.js';
import { buildFlareGun, buildSpearGun, buildRivetGun, buildHarpoon } from './precise.js';
import { buildNitroLauncher, buildDepthCharge, buildScrapRocket, buildEmpCoil } from './explosive.js';

/**
 * The sixteen improvised weapons, by id.
 *
 * Every builder takes a deterministic `Rng` (ARCHITECTURE rule 4) and returns:
 *
 *   {
 *     id, label,
 *     body:   Assembly,                     static geometry, bucketed by material
 *     moving: { trigger, mag, bolt, ... },  sub-Assemblies the rig animates
 *     nodes: {
 *       muzzle:   [x,y,z]      where the projectile leaves and the flash spawns
 *       muzzleDir:[x,y,z]      optional; defaults to -Z
 *       eject:    [x,y,z]      where a case / hull / nail strip leaves
 *       ejectDir: [x,y,z]
 *       head:     [x,y,z]      melee: the impact point
 *       edge:     [[a],[b]]    melee: the contact SEGMENT, for the sweep test
 *       gripL:    [x,y,z]      support-hand IK target in weapon space
 *       hand:     {pos,rot}    weapon -> right-hand-bone offset
 *       holster:  {pos,rot}    weapon -> spine offset when not drawn
 *       glow:     [{pos, mat, r}]  optional emitter points
 *     },
 *     span: metres              longest dimension, for the preview framing
 *   }
 *
 * Ids match `src/game/data.js` and `src/ui/data.js` exactly. Nothing here may
 * rename one.
 */
export const MODEL_BUILDERS = {
  fists: buildFists,
  pipe: buildPipe,
  wrench: buildWrench,
  crowbar: buildCrowbar,

  nailgun: buildNailGun,
  tackgun: buildTackCannon,
  sprayer: buildPaintCannon,
  smg: buildShopSmg,

  flare: buildFlareGun,
  speargun: buildSpearGun,
  rivetgun: buildRivetGun,
  harpoon: buildHarpoon,

  launcher: buildNitroLauncher,
  depth: buildDepthCharge,
  rocket: buildScrapRocket,
  emp: buildEmpCoil,
};

export const MODEL_IDS = Object.keys(MODEL_BUILDERS);

export function buildModel(id, rng) {
  const fn = MODEL_BUILDERS[id];
  if (!fn) return null;
  return fn(rng);
}
