import * as THREE from 'three';
import { CONCRETE, BRICK, PLASTER, TILE } from './glsl/surfaces-arch.js';
import { ASPHALT, SAND, DIRT, GRAVEL } from './glsl/surfaces-ground.js';
import { METAL_RUST, METAL_PAINTED, METAL_BRUSHED, CORRUGATED } from './glsl/surfaces-metal.js';
import { WOOD, FABRIC, BURLAP, FOLIAGE, RUBBER, GLASS } from './glsl/surfaces-organic.js';
import {
  ROAD_ASPHALT,
  ROAD_CONCRETE,
  COBBLE,
  STREET_BRICK,
  ROAD_PAINT,
  KERB,
  IRON_COVER,
  TRAM_RAIL,
  SIDEWALK,
} from './glsl/surfaces-road.js';
import { CARPAINT, AUTOGLASS, CHROME, TRIM_PLASTIC, TYRE, ALLOY } from './glsl/surfaces-vehicle.js';
import {
  PGH_BRICK,
  CURTAIN_GLASS,
  PRECAST,
  STONE_CLAD,
  SIDING,
  MILL_STEEL,
  SHINGLE,
  TAR_ROOF,
  STUCCO,
} from './glsl/surfaces-building.js';
import { GRASS, MUD, RIVER_SILT, BARK, LEAF_CARD } from './glsl/surfaces-nature.js';
import { WATER_BAKES } from './water.js';
import { WET_PRESETS } from './wetness.js';

/**
 * The surface library.
 *
 * `bake`  — how the texture set is generated (resolution, the metres the tile
 *           spans, and the peak-to-trough relief that sets the normal slope).
 * `mat`   — parameters for the material shader extension (see shader.js).
 * `three` — properties applied straight to the THREE material.
 * `surface` — the shared physics/FX surface vocabulary from ARCHITECTURE.md.
 *
 * `mat.wet` is the per-surface wetting response — see wetness.js. It defaults
 * to the porous-mineral preset, which is right for most of a city; anything
 * sealed, glazed, hydrophobic or indoors overrides it.
 */
const W = WET_PRESETS;
export const LIBRARY = {
  // ------------------------------------------------------------ masonry ----
  concrete: {
    glsl: CONCRETE,
    surface: 'concrete',
    bake: { size: 1024, worldSize: 2.5, relief: 0.09, seed: 11, param: [1, 0, 0, 0] },
    mat: {
      scale: 2.5,
      parallax: 0.016,
      detile: 0.4,
      detail: [9, 0.95, 0.58, 26],
      macro: [0.085, 0.62, 0.24, 0.45],
      // 3-4 m pour/wash variation at real contrast plus a 12 m band, so a long
      // retaining wall or a barrier run is not one value end to end.
      macroBig: [2.05, 0.130, 0.028, 0],
      // 1-4 m belly in a poured wall — see OW_MACRO_RELIEF in shader.js
      macroRelief: 0.30,
      patch: [0.28, 2.0, 0.145, -0.08],
      weather: [0.42, 0.4, 0.55, 0.5],
      grime: [0.26, 2.8, 0.85, 0.45],
      wearColor: 0x9a978f,
      dustColor: 0x8b7f6a,
      grimeColor: 0x2b2823,
      roughness: [0.98, -0.01, 0.24],
    },
  },
  concrete_floor: {
    glsl: CONCRETE,
    surface: 'concrete',
    bake: { size: 1024, worldSize: 2.5, relief: 0.075, seed: 47, param: [0, 1, 0, 0] },
    mat: {
      scale: 3.2,
      parallax: 0.01,
      detile: 0,
      detail: [9, 0.90, 0.52, 26],
      macro: [0.075, 0.48, 0.18, 0.3],
      macroRelief: 0.3,
      weather: [0.55, 0.1, 0.15, 0.5],
      roughness: [1.0, 0.0, 0.22],
    },
  },
  brick: {
    glsl: BRICK,
    surface: 'concrete',
    bake: { size: 1024, worldSize: 1.35, relief: 0.055, seed: 23 },
    mat: {
      scale: 1.35,
      zone: [0.85, 13, 0.15, 0.48],
      detailRot: 0.63,
      // 0.12 of height range x 0.024 m = ~2.5 mm of mortar parallax
      parallax: 0.024,
      parallaxLayers: 24,
      detile: 0,
      detail: [7, 0.88, 0.48, 22],
      macro: [0.09, 0.58, 0.22, 0.55],
      macroBig: [1.95, 0.115, 0.03, 0],
      macroRelief: 0.26,
      weather: [0.4, 0.5, 0.6, 0.55],
      grime: [0.24, 2.6, 0.9, 0.4],
      wearColor: 0xa08678,
      grimeColor: 0x241f19,
      roughness: [0.98, -0.01, 0.26],
    },
  },
  plaster: {
    glsl: PLASTER,
    surface: 'plaster',
    bake: { size: 1024, worldSize: 2.2, relief: 0.06, seed: 5 },
    mat: {
      scale: 2.2,
      zone: [0.9, 12, 0.22, 0.30],
      detailRot: 0.71,
      parallax: 0.014,
      detile: 0.8,
      detail: [10, 0.95, 0.54, 24],
      // 0.085 puts the coarsest band of the macro map at ~4 m; the contrast
      // expansion is what turns it from a 5% wash into a real 20% swing, and the
      // second band at 0.026 zones the facade at ~13 m. Between them a 12 m
      // elevation reads as damp/dry/bleached areas instead of one flat colour.
      macro: [0.085, 0.72, 0.26, 0.5],
      macroBig: [2.15, 0.150, 0.026, 0],
      macroRelief: 0.34,
      // ~18% of every facade is a replastered rectangle at +/-17% value.
      // A 12 m elevation seen at 3 m is mostly ONE surface, so the only thing
      // that can stop it reading as flat colour is structure at 1-4 m.
      patch: [0.34, 2.2, 0.175, -0.10],
      // streaks are gated by the runoff model now, so the amplitude can be real
      weather: [0.34, 0.5, 0.6, 0.5],
      grime: [0.26, 2.6, 0.85, 0.45],
      wearColor: 0xb0a692,
      dustColor: 0x9c8a6c,
      grimeColor: 0x2a251d,
      roughness: [0.97, -0.02, 0.26],
    },
  },
  tile: {
    glsl: TILE,
    surface: 'concrete',
    bake: { size: 1024, worldSize: 1.5, relief: 0.03, seed: 31 },
    mat: {
      scale: 1.5,
      // 0.06 of height range x 0.03 m = ~1.8 mm of grout recess
      parallax: 0.03,
      parallaxLayers: 20,
      detail: [8, 0.6, 0.36, 18],
      macro: [0.09, 0.40, 0.16, 0.3],
      // tiled walls are laid in batches: whole areas came from a different kiln
      macroBig: [1.7, 0.075, 0.032, 0],
      patch: [0.14, 1.7, 0.10, -0.05],
      weather: [0.3, 0.2, 0.3, 0.5],
      roughness: [0.9, -0.04, 0.16],
    },
  },

  // ------------------------------------------------------------- ground ----
  asphalt: {
    glsl: ASPHALT,
    surface: 'concrete',
    bake: { size: 1024, worldSize: 3.0, relief: 0.075, seed: 71 },
    mat: {
      scale: 3.0,
      parallax: 0.014,
      detile: 1.0,
      // micro detail is gone by 16 m, so the near ground gains detail instead
      // of shimmering at range
      detail: [8, 0.8, 0.42, 18],
      macro: [0.062, 0.52, 0.22, 0.25],
      macroRelief: 0.55,
      weather: [0.45, 0.05, 0.1, 0.26],
      dustColor: 0x8b8071,
      grimeColor: 0x232120,
      roughness: [0.98, -0.02, 0.3],
    },
  },
  sand: {
    glsl: SAND,
    surface: 'sand',
    bake: { size: 1024, worldSize: 2.5, relief: 0.10, seed: 91 },
    mat: {
      uvMode: 'triplanar',
      scale: 2.5,
      detile: 0,
      detail: [8, 0.7, 0.30, 18],
      macro: [0.050, 0.44, 0.14, 0.35],
      macroRelief: 0.45,
      weather: [0.15, 0.0, 0.0, 0.18],
      dustColor: 0xa89066,
      grimeColor: 0x4c4132,
      roughness: [1.0, 0.0, 0.3],
    },
  },
  dirt: {
    glsl: DIRT,
    surface: 'dirt',
    bake: { size: 1024, worldSize: 2.5, relief: 0.12, seed: 13 },
    mat: {
      uvMode: 'triplanar',
      scale: 2.5,
      detail: [7, 0.85, 0.36, 18],
      macro: [0.055, 0.48, 0.18, 0.4],
      macroRelief: 0.6,
      weather: [0.2, 0.0, 0.0, 0.22],
      dustColor: 0x94805c,
      grimeColor: 0x37301f,
      roughness: [0.98, -0.02, 0.3],
    },
  },
  gravel: {
    glsl: GRAVEL,
    // 1K, not 512: at 512 the 9 mm grade was 2.5 texels wide and baked as
    // noise. Aggregate has to be resolved in the tile or it cannot be resolved
    // at all — the mip chain only ever removes information.
    bake: { size: 1024, worldSize: 1.6, relief: 0.055, seed: 57 },
    surface: 'dirt',
    mat: {
      uvMode: 'triplanar',
      scale: 1.6,
      detail: [6, 0.8, 0.34, 20],
      macro: [0.070, 0.44, 0.2, 0.3],
      macroRelief: 0.7,
      // Cavity grime on a surface whose height field IS its aggregate turns
      // every gap between stones into a black pit; 0.5 was most of the
      // bimodal histogram the critics measured on the road.
      weather: [0.2, 0.0, 0.0, 0.16],
      dustColor: 0xa2947a,
      grimeColor: 0x4a4238,
      roughness: [0.96, -0.03, 0.28],
    },
  },

  // -------------------------------------------------------------- metal ----
  metal_rust: {
    glsl: METAL_RUST,
    surface: 'metal',
    bake: { size: 1024, worldSize: 1.2, relief: 0.035, seed: 37 },
    mat: {
      detailSet: 2,
      detailRot: 0.109,
      scale: 1.2,
      parallax: 0.004,
      detail: [9, 0.7, 0.36, 16],
      macro: [0.10, 0.30, 0.14, 0.4],
      weather: [0.25, 0.4, 0.5, 0.35],
      wearColor: 0x8c8f93,
      wearMaterial: [0.28, 1.0, 0, 0.85],
    },
  },
  metal_painted: {
    glsl: METAL_PAINTED,
    surface: 'metal',
    bake: {
      size: 1024,
      worldSize: 1.5,
      relief: 0.018,
      seed: 61,
      tintA: 0x4a5340,
      tintB: 0x2a2f26,
    },
    mat: {
      detailSet: 2,
      detailRot: 0.156,
      scale: 1.5,
      parallax: 0.003,
      detail: [10, 0.6, 0.32, 16],
      macro: [0.10, 0.28, 0.14, 0.35],
      weather: [0.3, 0.45, 0.35, 0.35],
      grime: [0.20, 2.2, 0.9, 0.4],
      wearColor: 0x8f9296,
      wearMaterial: [0.3, 1.0, 0, 0.9],
      // painted metal has to stay glossy enough to glint, but never mirror
      roughness: [0.92, -0.03, 0.22],
    },
  },
  metal_brushed: {
    glsl: METAL_BRUSHED,
    surface: 'metal',
    bake: { size: 512, worldSize: 0.8, relief: 0.004, seed: 83 },
    mat: {
      detailSet: 2,
      detailRot: 0.903,
      scale: 0.8,
      detail: [8, 0.25, 0.15, 8],
      macro: [0.09, 0.14, 0.1, 0.2],
      weather: [0.15, 0.15, 0.2, 0.2],
      wearColor: 0xb9bcc0,
      wearMaterial: [0.16, 1.0, 0, 0.9],
    },
    three: { anisotropy: 0.65, anisotropyRotation: 0, physical: true },
  },
  corrugated: {
    glsl: CORRUGATED,
    surface: 'metal',
    bake: { size: 1024, worldSize: 2.4, relief: 0.075, seed: 29 },
    mat: {
      detailSet: 2,
      detailRot: 0.226,
      scale: 2.4,
      parallax: 0.03,
      parallaxLayers: 24,
      detail: [10, 0.6, 0.32, 18],
      macro: [0.09, 0.26, 0.12, 0.3],
      weather: [0.3, 0.5, 0.5, 0.4],
      grime: [0.22, 2.4, 0.9, 0.45],
      wearColor: 0x9aa0a4,
      wearMaterial: [0.32, 1.0, 0, 0.85],
    },
  },

  // ------------------------------------------------------------ organic ----
  wood: {
    glsl: WOOD,
    surface: 'wood',
    bake: { size: 1024, worldSize: 2.0, relief: 0.038, seed: 19 },
    mat: {
      scale: 2.0,
      parallax: 0.008,
      detail: [10, 0.8, 0.42, 18],
      macro: [0.085, 0.34, 0.14, 0.5],
      weather: [0.3, 0.35, 0.5, 0.45],
      grime: [0.22, 2.0, 0.9, 0.4],
      wearColor: 0xa88b62,
      wearMaterial: [0.5, 0.0, 0, 0.7],
    },
  },
  fabric: {
    glsl: FABRIC,
    surface: 'fabric',
    // The weave carries ~0.3 of the height range, so 0.011 m of relief over a
    // 0.7 m tile is a ~1.5-2 mm thread bump at the 0.26 m mapping the awnings
    // use — a real weave, not a painted grid.
    bake: { size: 512, worldSize: 0.7, relief: 0.008, seed: 43, tintA: 0x5a5445, tintB: 0x3a3830 },
    mat: {
      detailSet: 1,
      detailRot: 0.803,
      scale: 0.7,
      detail: [6, 0.42, 0.28, 10],
      // 1.4 m macro at real contrast: sun-bleached panels and damp panels
      macro: [0.12, 0.34, 0.12, 0.3],
      macroBig: [1.8, 0.07, 0.09, 0],
      weather: [0.25, 0.2, 0.3, 0.35],
      normalStrength: 1.15,
      /**
       * Canvas passes 18% of the beam, its underside sits ~0.75 stops under its
       * top, and the drape structure is a 10 cm fold field. This is the whole
       * difference between fabric and painted cardboard.
       */
      cloth: [0.20, 0.72, 0.26, 0],
    },
    three: { physical: true, sheen: 0.55, sheenRoughness: 0.85, sheenColor: 0x8a8272 },
  },
  burlap: {
    glsl: BURLAP,
    surface: 'fabric',
    // hessian is coarse: a fat, visible thread bump
    bake: { size: 512, worldSize: 0.5, relief: 0.018, seed: 67 },
    mat: {
      detailSet: 1,
      detailRot: 0.641,
      scale: 0.5,
      parallax: 0.003,
      detail: [6, 0.4, 0.28, 9],
      macro: [0.14, 0.32, 0.12, 0.35],
      macroBig: [1.7, 0.06, 0.11, 0],
      weather: [0.4, 0.15, 0.35, 0.4],
      dustColor: 0x9c8760,
      normalStrength: 1.15,
      // a filled bag transmits far less than a stretched canvas
      cloth: [0.06, 0.86, 0.10, 0],
    },
    three: { physical: true, sheen: 0.4, sheenRoughness: 0.95, sheenColor: 0x9c8b68 },
  },
  foliage: {
    glsl: FOLIAGE,
    surface: 'foliage',
    bake: { size: 512, worldSize: 0.6, relief: 0.02, seed: 79 },
    mat: {
      uvMode: 'mesh',
      scale: 1,
      alphaMask: true,
      detail: [4, 0.25, 0.15, 8],
      meso: [0.055, 0, 0, 0],
      macro: [0.16, 0.3, 0.08, 0.6],
      weather: [0.15, 0.0, 0.0, 0.2],
      /**
       * LEAF TRANSLUCENCY. A leaf between the camera and the sun glows; the
       * same leaf with the sun behind the camera does not. Without this term a
       * canopy renders identically on both sides and reads as cardboard, which
       * is exactly what an adversarial critic measured on the inherited build.
       * [ transmission, underside multiplier, fold amount, unused ] — the lobe
       * is summed over every directional light in shader.js (OW_CLOTH).
       */
      cloth: [0.5, 0.74, 0.0, 0],
      wet: W.organic,
    },
    three: {
      side: THREE.DoubleSide,
      alphaTest: 0.45,
      physical: true,
      sheen: 0.3,
      sheenRoughness: 0.8,
      sheenColor: 0x9fbd6a,
    },
  },
  rubber: {
    glsl: RUBBER,
    surface: 'rubber',
    bake: { size: 512, worldSize: 0.5, relief: 0.013, seed: 97 },
    mat: {
      scale: 0.45,
      detail: [7, 0.62, 0.42, 13],
      // A tyre stack is a dark mass low in the frame, so it has nothing but its
      // own variation to read by: bleached crowns, damp black sidewalls and the
      // road dust that fills the tread. Without these it is a grey lozenge.
      macro: [0.16, 0.36, 0.20, 0.18],
      macroBig: [1.8, 0.10, 0.11, 0],
      weather: [0.40, 0.18, 0.22, 0.45],
      dustColor: 0x8d8478,
      grimeColor: 0x181715,
      tint: 0xfffaf2,
      normalStrength: 1.25,
      roughness: [0.94, -0.03, 0.34],
    },
  },
  glass: {
    glsl: GLASS,
    surface: 'glass',
    bake: { size: 512, worldSize: 2.0, relief: 0.0008, seed: 3 },
    mat: {
      scale: 2.0,
      detail: [3, 0.06, 0.05, 6],
      macro: [0.05, 0.1, 0.06, 0.1],
      weather: [0.1, 0.3, 0.4, 0.15],
      normalStrength: 0.35,
      roughness: [0.9, -0.01, 0.03],
    },
    three: {
      physical: true,
      transparent: true,
      opacity: 0.22,
      side: THREE.DoubleSide,
      envMapIntensity: 1.6,
      ior: 1.52,
      specularIntensity: 1,
      depthWrite: false,
    },
  },
};

// ===========================================================================
//  STEEL CITY — the surfaces added for the open world.
//  Everything above this line was authored for a Middle-Eastern market street
//  and is still consumed by five other subsystems, so it is extended, never
//  changed.
// ===========================================================================

/** Shared road defaults: nothing on a carriageway takes edge wear from the
 *  vertex mask (on a 100 m plane it just brightens every stone crown), and
 *  everything on one pools water hard. */
const ROAD_MAT = {
  vertexMasks: true,
  wear: [0, 0.5, 0.45, 0],
  wet: W.road,
  detile: 0.85,
};

Object.assign(LIBRARY, {
  // ------------------------------------------------------------- roads ----
  /**
   * The default city carriageway, world-projected. No lane-aligned features:
   * a world tile cannot know which way the road runs, and baking wheel tracks
   * into it would run them north-south across the whole map.
   */
  road_asphalt: {
    glsl: ROAD_ASPHALT,
    surface: 'asphalt',
    bake: { size: 1024, worldSize: 4.0, relief: 0.016, seed: 71, param: [0.55, 0.45, 0.30, 0] },
    mat: {
      ...ROAD_MAT,
      scale: 4.0,
      parallax: 0.016,
      parallaxLayers: 20,
      detail: [8, 0.42, 0.34, 22],
      macro: [0.055, 0.50, 0.24, 0.18],
      macroBig: [2.1, 0.085, 0.024, 0],
      macroRelief: 0.6,
      weather: [0.25, 0.05, 0.10, 0.24],
      dustColor: 0x8b8071,
      grimeColor: 0x1e1d1c,
      roughness: [0.98, -0.02, 0.28],
    },
  },
  road_asphalt_fresh: {
    glsl: ROAD_ASPHALT,
    surface: 'asphalt',
    bake: { size: 1024, worldSize: 4.0, relief: 0.013, seed: 12, param: [0.06, 0.10, 0.03, 0] },
    mat: {
      ...ROAD_MAT,
      scale: 4.0,
      parallax: 0.012,
      detail: [8, 0.80, 0.42, 22],
      macro: [0.055, 0.40, 0.20, 0.14],
      macroRelief: 0.35,
      weather: [0.15, 0.03, 0.06, 0.20],
      roughness: [0.96, -0.04, 0.30],
    },
  },
  road_asphalt_worn: {
    glsl: ROAD_ASPHALT,
    surface: 'asphalt',
    bake: { size: 1024, worldSize: 4.0, relief: 0.021, seed: 93, param: [0.92, 0.60, 0.55, 0] },
    mat: {
      ...ROAD_MAT,
      scale: 4.0,
      parallax: 0.022,
      parallaxLayers: 24,
      detail: [8, 0.46, 0.36, 22],
      macro: [0.055, 0.58, 0.26, 0.20],
      macroBig: [2.2, 0.10, 0.024, 0],
      macroRelief: 0.75,
      weather: [0.30, 0.05, 0.12, 0.26],
      roughness: [0.98, -0.02, 0.26],
    },
  },
  /** Utility cuts and skin patches everywhere — the alley / back-street mix. */
  road_asphalt_patched: {
    glsl: ROAD_ASPHALT,
    surface: 'asphalt',
    bake: { size: 1024, worldSize: 4.0, relief: 0.018, seed: 37, param: [0.70, 1.0, 0.40, 0] },
    mat: {
      ...ROAD_MAT,
      scale: 4.0,
      parallax: 0.020,
      detail: [8, 0.45, 0.36, 22],
      macro: [0.055, 0.55, 0.25, 0.18],
      macroRelief: 0.7,
      weather: [0.28, 0.05, 0.12, 0.26],
    },
  },
  /** Potholed and cracked to pieces — Hazelwood, the mill approach roads. */
  road_asphalt_broken: {
    glsl: ROAD_ASPHALT,
    surface: 'asphalt',
    bake: { size: 1024, worldSize: 4.0, relief: 0.030, seed: 59, param: [0.95, 0.70, 1.0, 0] },
    mat: {
      ...ROAD_MAT,
      scale: 4.0,
      parallax: 0.030,
      parallaxLayers: 26,
      detail: [8, 0.50, 0.38, 22],
      macro: [0.055, 0.60, 0.28, 0.20],
      macroRelief: 0.85,
      weather: [0.32, 0.06, 0.14, 0.28],
    },
  },
  /**
   * The lane-aligned carriageway. MESH UVs, with v ALONG the road: this is the
   * one that carries wheel polish, the oil line down the lane centre and the
   * paver's cold joint. `world` should map its road ribbons at roughly
   * (width / 4 m) across and (length / 4 m) along, then use `scale` to trim.
   */
  road_lane: {
    glsl: ROAD_ASPHALT,
    surface: 'asphalt',
    bake: { size: 1024, worldSize: 4.0, relief: 0.017, seed: 71, param: [0.55, 0.45, 0.30, 1] },
    mat: {
      ...ROAD_MAT,
      uvMode: 'mesh',
      scale: 1,
      /**
       * De-tiling was OFF here because the ordinary rotated second sample would
       * drag the wheel-polish bands off the lane. `detileLane` mirrors and
       * rescales along the road only, so the across-the-road structure is
       * untouched and the along-the-road repeat — potholes, utility cuts, tar
       * snakes — stops landing on a 4 m grid down the whole street.
       */
      detile: 0.75,
      detileLane: true,
      parallax: 0.016,
      parallaxLayers: 20,
      detail: [22, 0.42, 0.34, 22],
      detailWorld: 0,
      detailRot: 0.11,
      macro: [0.055, 0.50, 0.24, 0.18],
      macroBig: [2.1, 0.085, 0.024, 0],
      macroRelief: 0.6,
      weather: [0.25, 0.05, 0.10, 0.24],
      grimeColor: 0x1e1d1c,
      roughness: [0.98, -0.02, 0.28],
    },
  },
  road_lane_worn: {
    glsl: ROAD_ASPHALT,
    surface: 'asphalt',
    bake: { size: 1024, worldSize: 4.0, relief: 0.022, seed: 93, param: [0.90, 0.60, 0.50, 1] },
    mat: {
      ...ROAD_MAT,
      uvMode: 'mesh',
      scale: 1,
      detile: 0.8,
      detileLane: true,
      parallax: 0.022,
      detail: [22, 0.46, 0.36, 22],
      detailWorld: 0,
      detailRot: 0.29,
      macro: [0.055, 0.58, 0.26, 0.20],
      macroRelief: 0.75,
      weather: [0.30, 0.05, 0.12, 0.26],
    },
  },

  /** Concrete highway slab, world-projected (ramps, aprons, hard standing). */
  concrete_slab: {
    glsl: ROAD_CONCRETE,
    surface: 'concrete',
    bake: { size: 1024, worldSize: 4.5, relief: 0.035, seed: 41, param: [0.85, 2, 0.45, 0] },
    mat: {
      ...ROAD_MAT,
      scale: 4.5,
      parallax: 0.016,
      parallaxLayers: 22,
      detail: [9, 0.90, 0.46, 24],
      macro: [0.050, 0.46, 0.22, 0.16],
      macroBig: [2.0, 0.075, 0.022, 0],
      macroRelief: 0.35,
      weather: [0.30, 0.10, 0.15, 0.30],
      roughness: [0.98, -0.01, 0.24],
    },
  },
  /** The interstate itself — mesh UVs, v along the carriageway. */
  highway_slab: {
    glsl: ROAD_CONCRETE,
    surface: 'concrete',
    bake: { size: 1024, worldSize: 4.5, relief: 0.038, seed: 41, param: [0.9, 2, 0.5, 1] },
    mat: {
      ...ROAD_MAT,
      uvMode: 'mesh',
      scale: 1,
      detile: 0,
      parallax: 0.016,
      parallaxLayers: 22,
      detail: [24, 0.90, 0.46, 24],
      detailWorld: 0,
      macro: [0.050, 0.46, 0.22, 0.16],
      macroRelief: 0.3,
      weather: [0.30, 0.10, 0.15, 0.30],
      roughness: [0.98, -0.01, 0.24],
    },
  },

  /** Granite setts — the old districts, the alleys, the incline approaches. */
  cobble: {
    glsl: COBBLE,
    surface: 'concrete',
    bake: { size: 1024, worldSize: 2.4, relief: 0.048, seed: 13, param: [0, 0.35, 0.65, 0] },
    mat: {
      ...ROAD_MAT,
      scale: 2.4,
      detile: 0.5,
      parallax: 0.030,
      parallaxLayers: 26,
      detail: [7, 0.80, 0.44, 20],
      macro: [0.060, 0.46, 0.22, 0.18],
      macroBig: [2.0, 0.075, 0.028, 0],
      macroRelief: 0.5,
      weather: [0.25, 0.05, 0.12, 0.30],
      grimeColor: 0x161512,
      roughness: [0.98, -0.02, 0.20],
    },
  },
  /** Laid in a fan around a crown, as the older streets were. */
  cobble_fan: {
    glsl: COBBLE,
    surface: 'concrete',
    bake: { size: 1024, worldSize: 2.4, relief: 0.050, seed: 29, param: [1, 0.25, 0.80, 0] },
    mat: {
      ...ROAD_MAT,
      scale: 2.4,
      detile: 0.5,
      parallax: 0.030,
      parallaxLayers: 26,
      detail: [7, 0.80, 0.44, 20],
      macro: [0.060, 0.46, 0.22, 0.18],
      macroRelief: 0.5,
      weather: [0.25, 0.05, 0.12, 0.30],
      grimeColor: 0x161512,
      roughness: [0.98, -0.02, 0.20],
    },
  },
  /** Joints flooded with bitumen where the street was half-resurfaced. */
  cobble_tar: {
    glsl: COBBLE,
    surface: 'concrete',
    bake: { size: 1024, worldSize: 2.4, relief: 0.044, seed: 47, param: [0, 0.9, 0.85, 0.15] },
    mat: {
      ...ROAD_MAT,
      scale: 2.4,
      detile: 0.5,
      parallax: 0.026,
      detail: [7, 0.78, 0.42, 20],
      macro: [0.060, 0.44, 0.22, 0.16],
      macroRelief: 0.45,
      weather: [0.25, 0.05, 0.12, 0.28],
      grimeColor: 0x141310,
    },
  },
  /** Warm sandstone setts — the Mt. Washington and Troy Hill lanes. */
  sett_sandstone: {
    glsl: COBBLE,
    surface: 'concrete',
    bake: { size: 1024, worldSize: 2.4, relief: 0.050, seed: 61, param: [0.25, 0.30, 0.5, 1] },
    mat: {
      ...ROAD_MAT,
      scale: 2.4,
      detile: 0.5,
      parallax: 0.030,
      detail: [7, 0.82, 0.44, 20],
      macro: [0.060, 0.48, 0.22, 0.20],
      macroRelief: 0.5,
      weather: [0.28, 0.05, 0.14, 0.30],
    },
  },

  /** Vitrified clay paver street — Lawrenceville and the South Side flats. */
  street_brick: {
    glsl: STREET_BRICK,
    surface: 'concrete',
    bake: { size: 1024, worldSize: 2.0, relief: 0.038, seed: 83, param: [1, 0.70, 0.20, 0] },
    mat: {
      ...ROAD_MAT,
      scale: 2.0,
      detile: 0.45,
      parallax: 0.024,
      parallaxLayers: 24,
      detail: [7, 0.82, 0.44, 20],
      macro: [0.065, 0.46, 0.22, 0.30],
      macroBig: [2.0, 0.080, 0.028, 0],
      macroRelief: 0.4,
      weather: [0.25, 0.06, 0.14, 0.30],
      grimeColor: 0x171310,
      roughness: [0.98, -0.02, 0.16],
    },
  },
  street_brick_worn: {
    glsl: STREET_BRICK,
    surface: 'concrete',
    bake: { size: 1024, worldSize: 2.0, relief: 0.042, seed: 17, param: [1, 0.95, 0.65, 0] },
    mat: {
      ...ROAD_MAT,
      scale: 2.0,
      detile: 0.45,
      parallax: 0.024,
      detail: [7, 0.82, 0.44, 20],
      macro: [0.065, 0.50, 0.22, 0.30],
      macroRelief: 0.45,
      weather: [0.28, 0.06, 0.16, 0.32],
      grimeColor: 0x171310,
    },
  },

  // ------------------------------------------------------- road markings --
  /**
   * Markings are DECALS: mesh UVs, one quad per glyph, alpha-tested, with a
   * polygon offset so they sit on the road without z-fighting. `props` places
   * them; `world` decides where. u runs across the mark, v along it.
   *
   * They WEAR THROUGH at the wheel line — that is the point of the surface.
   * `junction` variants scrub much harder, because traffic turns across them.
   */
  road_line: {
    glsl: ROAD_PAINT,
    surface: 'asphalt',
    bake: { size: 512, worldSize: 1.0, relief: 0.004, seed: 5, param: [0, 0.35, 0, 0] },
    mat: {
      meso: [0.055, 0, 0, 0],
      uvMode: 'mesh',
      scale: 1,
      alphaMask: true,
      detail: [6, 0.6, 0.40, 14],
      detailWorld: 0,
      macro: [0.14, 0.32, 0.20, 0.15],
      weather: [0.1, 0.0, 0.0, 0.12],
      wet: W.sealed,
      roughness: [0.98, -0.02, 0.18],
    },
    three: {
      alphaTest: 0.42,
      polygonOffset: true,
      polygonOffsetFactor: -2,
      polygonOffsetUnits: -4,
    },
  },
  road_line_dash: {
    glsl: ROAD_PAINT,
    surface: 'asphalt',
    bake: { size: 512, worldSize: 1.0, relief: 0.004, seed: 5, param: [1, 0.35, 0, 0] },
    mat: { $ref: 'road_line' },
  },
  road_line_double: {
    glsl: ROAD_PAINT,
    surface: 'asphalt',
    bake: { size: 512, worldSize: 1.0, relief: 0.004, seed: 5, param: [2, 0.30, 1, 0] },
    mat: { $ref: 'road_line' },
  },
  road_line_yellow: {
    glsl: ROAD_PAINT,
    surface: 'asphalt',
    bake: { size: 512, worldSize: 1.0, relief: 0.004, seed: 5, param: [0, 0.32, 1, 0] },
    mat: { $ref: 'road_line' },
  },
  road_arrow: {
    glsl: ROAD_PAINT,
    surface: 'asphalt',
    bake: { size: 512, worldSize: 1.0, relief: 0.004, seed: 9, param: [3, 0.45, 0, 0.70] },
    mat: { $ref: 'road_line' },
  },
  road_arrow_turn: {
    glsl: ROAD_PAINT,
    surface: 'asphalt',
    bake: { size: 512, worldSize: 1.0, relief: 0.004, seed: 9, param: [4, 0.50, 0, 0.80] },
    mat: { $ref: 'road_line' },
  },
  road_crossing: {
    glsl: ROAD_PAINT,
    surface: 'asphalt',
    bake: { size: 512, worldSize: 1.0, relief: 0.004, seed: 15, param: [5, 0.55, 0, 0.90] },
    mat: { $ref: 'road_line' },
  },
  road_stopbar: {
    glsl: ROAD_PAINT,
    surface: 'asphalt',
    bake: { size: 512, worldSize: 1.0, relief: 0.004, seed: 15, param: [6, 0.60, 0, 1.0] },
    mat: { $ref: 'road_line' },
  },
  road_hatch: {
    glsl: ROAD_PAINT,
    surface: 'asphalt',
    bake: { size: 512, worldSize: 1.0, relief: 0.004, seed: 21, param: [7, 0.42, 1, 0.55] },
    mat: { $ref: 'road_line' },
  },

  // ----------------------------------------------------- street furniture --
  kerb: {
    glsl: KERB,
    surface: 'concrete',
    bake: { size: 1024, worldSize: 3.6, relief: 0.055, seed: 27, param: [0, 0.65, 0] },
    mat: {
      vertexMasks: true,
      scale: 3.6,
      parallax: 0.014,
      detail: [8, 0.85, 0.44, 18],
      macro: [0.075, 0.42, 0.20, 0.20],
      macroBig: [1.9, 0.070, 0.035, 0],
      weather: [0.25, 0.20, 0.18, 0.34],
      wear: [0.35, 0.7, 0.5, 0],
      wearColor: 0xb4b0a6,
      grimeColor: 0x191712,
      wet: W.kerb,
      roughness: [0.98, -0.02, 0.20],
    },
  },
  kerb_concrete: {
    glsl: KERB,
    surface: 'concrete',
    bake: { size: 1024, worldSize: 3.6, relief: 0.050, seed: 55, param: [1, 0.55, 0] },
    mat: { $ref: 'kerb' },
  },
  kerb_painted: {
    glsl: KERB,
    surface: 'concrete',
    bake: { size: 1024, worldSize: 3.6, relief: 0.055, seed: 73, param: [0, 0.75, 1] },
    mat: { $ref: 'kerb' },
  },
  sidewalk: {
    glsl: SIDEWALK,
    surface: 'sidewalk',
    bake: { size: 1024, worldSize: 2.4, relief: 0.032, seed: 35, param: [2, 0.50, 0.25, 0] },
    mat: {
      vertexMasks: true,
      scale: 2.4,
      detile: 0.5,
      parallax: 0.018,
      parallaxLayers: 22,
      detail: [9, 0.95, 0.50, 20],
      macro: [0.070, 0.50, 0.22, 0.22],
      macroBig: [2.0, 0.080, 0.030, 0],
      macroRelief: 0.35,
      weather: [0.30, 0.08, 0.14, 0.30],
      wear: [0, 0.55, 0.45, 0],
      grimeColor: 0x1c1a16,
      wet: W.walk,
      grime: [0.30, 1.2, 0.9, 0.35],
      roughness: [0.98, -0.01, 0.26],
    },
  },
  sidewalk_old: {
    glsl: SIDEWALK,
    surface: 'sidewalk',
    bake: { size: 1024, worldSize: 2.4, relief: 0.038, seed: 77, param: [2, 0.90, 0.65, 0] },
    mat: { $ref: 'sidewalk' },
  },
  manhole: {
    glsl: IRON_COVER,
    surface: 'metal',
    bake: { size: 512, worldSize: 0.95, relief: 0.030, seed: 3, param: [0, 0.70, 0] },
    mat: {
      detailSet: 2,
      detailRot: 0.6,
      meso: [0.055, 0, 0, 0],
      uvMode: 'mesh',
      scale: 1,
      detail: [10, 0.75, 0.38, 14],
      detailWorld: 0,
      macro: [0.30, 0.24, 0.16, 0.15],
      weather: [0.20, 0.05, 0.05, 0.34],
      wet: W.metal,
      roughness: [0.98, -0.02, 0.10],
    },
    three: { polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -4 },
  },
  drain_grate: {
    glsl: IRON_COVER,
    surface: 'metal',
    bake: { size: 512, worldSize: 0.95, relief: 0.045, seed: 7, param: [1, 0.60, 0.55] },
    mat: { $ref: 'manhole' },
    three: { polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -4 },
  },
  utility_lid: {
    glsl: IRON_COVER,
    surface: 'metal',
    bake: { size: 512, worldSize: 0.75, relief: 0.028, seed: 11, param: [2, 0.60, 0.1] },
    mat: { $ref: 'manhole' },
    three: { polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -4 },
  },
  tram_rail: {
    glsl: TRAM_RAIL,
    surface: 'metal',
    bake: { size: 1024, worldSize: 2.4, relief: 0.07, seed: 19, param: [0, 0.85] },
    mat: {
      detailSet: 2,
      detailRot: 0.334,
      uvMode: 'mesh',
      scale: 1,
      detail: [16, 0.75, 0.40, 18],
      detailWorld: 0,
      macro: [0.10, 0.34, 0.18, 0.15],
      weather: [0.2, 0.05, 0.08, 0.30],
      wet: [1, 0.85, 0.9, 1],
      roughness: [0.98, -0.02, 0.06],
    },
  },
  tram_rail_asphalt: {
    glsl: TRAM_RAIL,
    surface: 'metal',
    bake: { size: 1024, worldSize: 2.4, relief: 0.07, seed: 23, param: [1, 0.85] },
    mat: { $ref: 'tram_rail' },
  },

  // ---------------------------------------------------------- vehicles ----
  /**
   * The layered automotive paint model. The bake is deliberately quiet — the
   * flake, the flop and the clearcoat's orange peel are all view-dependent and
   * live in the shader (OW_CARPAINT). Ask for a colour with
   * `materials.carPaint(0xb2231a, { finish: 'metallic' })`.
   */
  carpaint: {
    glsl: CARPAINT,
    surface: 'carpaint',
    bake: {
      size: 512,
      worldSize: 1.2,
      relief: 0.004,
      seed: 31,
      tintA: 0xb2231a,
      param: [1, 0.30, 0.30, 0],
    },
    mat: {
      detailSet: 2,
      detailRot: 0.869,
      meso: [0.055, 0, 0, 0],
      uvMode: 'mesh',
      scale: 1,
      detail: [3, 0.10, 0.06, 10],
      detailWorld: 0,
      macro: [0.55, 0.10, 0.06, 0.05],
      weather: [0, 0, 0, 0.06],
      normalStrength: 0.55,
      carPaint: [0.85, 780, 240, 0.5],
      carFlop: [0.52, 0.50, 0.58, 0.45],
      wet: W.clearcoat,
      roughness: [1, 0, 0.030],
    },
    three: {
      physical: true,
      clearcoat: 1.0,
      clearcoatRoughness: 0.045,
      envMapIntensity: 1.5,
      // Automotive clear is ~1.5 IOR over a base coat; giving it its own IOR is
      // what puts a second, tighter specular lobe on top of the base lobe.
      ior: 1.5,
      specularIntensity: 1,
    },
  },
  carpaint_matte: {
    glsl: CARPAINT,
    surface: 'carpaint',
    bake: {
      size: 512, worldSize: 1.2, relief: 0.004, seed: 33, tintA: 0x2b2f33, param: [2, 0.30, 0.30, 0],
    },
    mat: {
      meso: [0.055, 0, 0, 0],
      uvMode: 'mesh', scale: 1,
      detail: [5, 0.30, 0.14, 10], detailWorld: 0,
      macro: [0.55, 0.12, 0.10, 0.05],
      weather: [0, 0, 0, 0.08],
      carPaint: [0, 780, 300, 0.25],
      carFlop: [0.72, 0.72, 0.75, 0.20],
      wet: [1, 0.35, 0.15, 1],
      roughness: [1, 0, 0.35],
    },
    three: { physical: true, clearcoat: 0.25, clearcoatRoughness: 0.55, envMapIntensity: 1.1 },
  },
  carpaint_primer: {
    glsl: CARPAINT,
    surface: 'carpaint',
    bake: {
      size: 512, worldSize: 1.2, relief: 0.005, seed: 35, tintA: 0x6d6a68, param: [3, 0.55, 0.45, 0],
    },
    mat: {
      meso: [0.055, 0, 0, 0],
      uvMode: 'mesh', scale: 1,
      detail: [6, 0.45, 0.24, 10], detailWorld: 0,
      macro: [0.55, 0.16, 0.14, 0.06],
      weather: [0, 0, 0, 0.10],
      carPaint: [0, 780, 300, 0.15],
      wet: [1, 0.6, 0.2, 1],
      roughness: [1, 0, 0.55],
    },
    three: { physical: true, clearcoat: 0.05, clearcoatRoughness: 0.7 },
  },
  carpaint_faded: {
    glsl: CARPAINT,
    surface: 'carpaint',
    bake: {
      size: 512, worldSize: 1.2, relief: 0.005, seed: 37, tintA: 0x9c4f3a, param: [4, 0.80, 0.45, 0],
    },
    mat: {
      meso: [0.055, 0, 0, 0],
      uvMode: 'mesh', scale: 1,
      detail: [5, 0.28, 0.16, 10], detailWorld: 0,
      macro: [0.55, 0.18, 0.16, 0.08],
      weather: [0, 0, 0, 0.10],
      carPaint: [0.30, 780, 300, 0.30],
      carFlop: [0.68, 0.66, 0.70, 0.25],
      wet: [1, 0.45, 0.2, 1],
      roughness: [1, 0, 0.10],
    },
    three: { physical: true, clearcoat: 0.30, clearcoatRoughness: 0.35, envMapIntensity: 1.2 },
  },
  carpaint_rusted: {
    glsl: CARPAINT,
    surface: 'carpaint',
    bake: {
      size: 512, worldSize: 1.2, relief: 0.010, seed: 39, tintA: 0x7c5c4a, param: [5, 0.90, 0.60, 0],
    },
    mat: {
      meso: [0.055, 0, 0, 0],
      uvMode: 'mesh', scale: 1,
      detail: [7, 0.60, 0.32, 10], detailWorld: 0,
      macro: [0.55, 0.22, 0.20, 0.10],
      weather: [0, 0, 0, 0.14],
      carPaint: [0.15, 780, 300, 0.20],
      wet: [1, 0.7, 0.25, 1],
      roughness: [1, 0, 0.08],
    },
    three: { physical: true, clearcoat: 0.20, clearcoatRoughness: 0.45 },
  },
  carpaint_dirty: {
    glsl: CARPAINT,
    surface: 'carpaint',
    bake: {
      size: 512, worldSize: 1.2, relief: 0.005, seed: 41, tintA: 0x2f5d78, param: [6, 0.55, 0.95, 0],
    },
    mat: {
      meso: [0.055, 0, 0, 0],
      uvMode: 'mesh', scale: 1,
      detail: [5, 0.35, 0.20, 10], detailWorld: 0,
      macro: [0.55, 0.16, 0.14, 0.06],
      weather: [0, 0, 0, 0.10],
      carPaint: [0.55, 780, 240, 0.4],
      carFlop: [0.55, 0.54, 0.60, 0.35],
      wet: W.clearcoat,
      roughness: [1, 0, 0.035],
    },
    three: { physical: true, clearcoat: 0.75, clearcoatRoughness: 0.14, envMapIntensity: 1.3 },
  },

  auto_glass: {
    glsl: AUTOGLASS,
    surface: 'glass',
    bake: { size: 512, worldSize: 1.4, relief: 0.001, seed: 13, param: [0.25, 0, 0.45, 0] },
    mat: {
      meso: [0.055, 0, 0, 0],
      uvMode: 'mesh',
      scale: 1,
      detail: [3, 0.05, 0.04, 8],
      detailWorld: 0,
      macro: [0.5, 0.08, 0.05, 0.05],
      weather: [0, 0, 0, 0.05],
      normalStrength: 0.30,
      // 6 mm of laminated glass; the Fresnel edge boost is what makes a side
      // window opaque at a glancing angle and see-through head on.
      autoGlass: [0.006, 0.34, 1.0, 0],
      glassAbsorb: [26, 5.5, 20],
      wet: W.glass,
      roughness: [1, 0, 0.02],
    },
    three: {
      physical: true,
      transparent: true,
      opacity: 1,
      side: THREE.DoubleSide,
      envMapIntensity: 1.8,
      ior: 1.52,
      specularIntensity: 1,
      depthWrite: false,
    },
  },
  auto_glass_tinted: {
    glsl: AUTOGLASS,
    surface: 'glass',
    bake: { size: 512, worldSize: 1.4, relief: 0.001, seed: 17, param: [0.85, 0.8, 0.4, 0] },
    mat: {
      meso: [0.055, 0, 0, 0],
      uvMode: 'mesh', scale: 1,
      detail: [3, 0.05, 0.04, 8], detailWorld: 0,
      macro: [0.5, 0.08, 0.05, 0.05],
      weather: [0, 0, 0, 0.05],
      normalStrength: 0.30,
      autoGlass: [0.012, 0.62, 1.0, 0],
      glassAbsorb: [34, 12, 28],
      wet: W.glass,
      roughness: [1, 0, 0.02],
    },
    three: {
      physical: true, transparent: true, opacity: 1, side: THREE.DoubleSide,
      envMapIntensity: 1.8, ior: 1.52, specularIntensity: 1, depthWrite: false,
    },
  },
  chrome: {
    glsl: CHROME,
    surface: 'metal',
    bake: { size: 512, worldSize: 0.6, relief: 0.003, seed: 43, param: [0.30, 0.35, 0, 0] },
    mat: {
      detailSet: 2,
      detailRot: 0.048,
      meso: [0.055, 0, 0, 0],
      uvMode: 'mesh',
      scale: 1,
      detail: [8, 0.22, 0.12, 10],
      detailWorld: 0,
      macro: [0.45, 0.12, 0.10, 0.05],
      weather: [0, 0, 0, 0.10],
      normalStrength: 0.55,
      wet: W.metal,
      wearColor: 0xc8ccd0,
      wearMaterial: [0.10, 1.0, 0, 0.7],
      roughness: [1, 0, 0.020],
    },
    three: { envMapIntensity: 1.8 },
  },
  chrome_pitted: {
    glsl: CHROME,
    surface: 'metal',
    bake: { size: 512, worldSize: 0.6, relief: 0.006, seed: 47, param: [0.90, 0.65, 0, 0] },
    mat: { $ref: 'chrome' },
    three: { envMapIntensity: 1.6 },
  },
  trim_plastic: {
    glsl: TRIM_PLASTIC,
    surface: 'rubber',
    bake: { size: 512, worldSize: 0.45, relief: 0.0035, seed: 51, param: [0.35, 0.30, 0.35, 0] },
    mat: {
      // Moulded plastic grain: the mineral family with its own rotation, not
      // the metal one — corrosion pitting on a bumper is nonsense.
      detailSet: 0,
      detailRot: 0.108,
      meso: [0.055, 0, 0, 0],
      uvMode: 'mesh',
      scale: 1,
      detail: [8, 0.70, 0.34, 12],
      detailWorld: 0,
      macro: [0.50, 0.16, 0.14, 0.06],
      weather: [0, 0, 0, 0.20],
      normalStrength: 1.15,
      wet: [1, 0.30, 0.15, 0.8],
      roughness: [1, 0, 0.24],
    },
  },
  trim_plastic_faded: {
    glsl: TRIM_PLASTIC,
    surface: 'rubber',
    bake: { size: 512, worldSize: 0.45, relief: 0.0035, seed: 53, param: [0.65, 0.90, 0.60, 0] },
    mat: { $ref: 'trim_plastic' },
  },
  /**
   * TYRE SIDEWALL. Roughness is floored at 0.72 in the generator and the
   * material floor is set here as well — a shiny tyre is the first thing a
   * critic looks for and the fastest way to lose a frame.
   */
  tyre: {
    glsl: TYRE,
    surface: 'rubber',
    bake: { size: 1024, worldSize: 0.55, relief: 0.012, seed: 97, param: [0, 0.45, 0.45, 0] },
    mat: {
      meso: [0.055, 0, 0, 0],
      uvMode: 'mesh',
      scale: 1,
      detail: [7, 0.75, 0.40, 12],
      detailWorld: 0,
      macro: [0.42, 0.22, 0.14, 0.08],
      macroBig: [1.7, 0.06, 0.22, 0],
      weather: [0, 0, 0, 0.28],
      normalStrength: 1.25,
      grimeColor: 0x161513,
      dustColor: 0x8d8478,
      // Rubber is hydrophobic: it darkens a little in rain and it NEVER
      // becomes a mirror, so the pooling and sheen terms are near zero.
      wet: W.rubber,
      roughness: [1, 0, 0.72],
    },
  },
  tyre_tread: {
    glsl: TYRE,
    surface: 'rubber',
    bake: { size: 1024, worldSize: 0.55, relief: 0.030, seed: 99, param: [1, 0.40, 0.65, 0] },
    mat: {
      meso: [0.055, 0, 0, 0],
      uvMode: 'mesh', scale: 1,
      detail: [7, 0.70, 0.36, 12], detailWorld: 0,
      macro: [0.42, 0.20, 0.12, 0.08],
      weather: [0, 0, 0, 0.32],
      normalStrength: 1.15,
      grimeColor: 0x161513,
      wet: W.rubber,
      roughness: [1, 0, 0.72],
    },
  },
  alloy: {
    glsl: ALLOY,
    surface: 'metal',
    bake: { size: 512, worldSize: 0.5, relief: 0.004, seed: 57, param: [0, 0.25, 0.55, 0] },
    mat: {
      detailSet: 2,
      detailRot: 0.456,
      meso: [0.055, 0, 0, 0],
      uvMode: 'mesh',
      scale: 1,
      detail: [7, 0.35, 0.20, 10],
      detailWorld: 0,
      macro: [0.45, 0.14, 0.12, 0.05],
      weather: [0, 0, 0, 0.22],
      wet: W.metal,
      roughness: [1, 0, 0.09],
    },
    three: { envMapIntensity: 1.4 },
  },
  alloy_painted: {
    glsl: ALLOY,
    surface: 'metal',
    bake: { size: 512, worldSize: 0.5, relief: 0.004, seed: 59, param: [1, 0.40, 0.70, 0] },
    mat: { $ref: 'alloy' },
  },
  alloy_dark: {
    glsl: ALLOY,
    surface: 'metal',
    bake: { size: 512, worldSize: 0.5, relief: 0.004, seed: 61, param: [2, 0.35, 0.60, 0] },
    mat: { $ref: 'alloy' },
  },

  // --------------------------------------------------------- buildings ----
  pgh_brick: {
    glsl: PGH_BRICK,
    surface: 'concrete',
    bake: { size: 1024, worldSize: 1.35, relief: 0.060, seed: 23, param: [0, 0.40, 0.30, 0] },
    mat: {
      vertexMasks: true,
      // Pittsburgh rowhouse frontages are 6-10 m. Heavy soot load, and about
      // one in five has been painted at some point since the mill closed.
      zone: [1, 13, 0.18, 0.55],
      detailRot: 0.07,
      scale: 1.35,
      parallax: 0.026,
      parallaxLayers: 24,
      detail: [7, 0.95, 0.52, 22],
      macro: [0.090, 0.60, 0.24, 0.55],
      macroBig: [2.0, 0.120, 0.030, 0],
      macroRelief: 0.28,
      patch: [0.16, 2.4, 0.10, -0.05],
      weather: [0.35, 0.55, 0.70, 0.55],
      grime: [0.28, 3.0, 0.9, 0.5],
      wearColor: 0xa08678,
      grimeColor: 0x171512,
      wet: W.wall,
      roughness: [0.98, -0.01, 0.24],
    },
  },
  /** Common bond with a header course, eroded joints — the older rowhouses. */
  pgh_brick_old: {
    glsl: PGH_BRICK,
    surface: 'concrete',
    bake: { size: 1024, worldSize: 1.35, relief: 0.075, seed: 67, param: [1, 0.85, 0.45, 0] },
    mat: { $ref: 'pgh_brick' },
  },
  /** A century of coke smoke: black in the shelter, scoured on the washed face. */
  brick_sooted: {
    glsl: PGH_BRICK,
    surface: 'concrete',
    bake: { size: 1024, worldSize: 1.35, relief: 0.070, seed: 89, param: [1, 0.70, 0.95, 0.15] },
    mat: { $ref: 'pgh_brick' },
  },
  brick_buff: {
    glsl: PGH_BRICK,
    surface: 'concrete',
    bake: { size: 1024, worldSize: 1.35, relief: 0.060, seed: 31, param: [0, 0.45, 0.25, 0.5] },
    mat: { $ref: 'pgh_brick' },
  },
  brick_dark: {
    glsl: PGH_BRICK,
    surface: 'concrete',
    bake: { size: 1024, worldSize: 1.35, relief: 0.062, seed: 43, param: [0, 0.50, 0.55, 1.0] },
    mat: { $ref: 'pgh_brick' },
  },

  curtain_glass: {
    glsl: CURTAIN_GLASS,
    surface: 'glass',
    bake: { size: 1024, worldSize: 5.4, relief: 0.030, seed: 7, param: [4, 0.30, 0.55, 0.35] },
    mat: {
      scale: 5.4,
      parallax: 0.010,
      parallaxLayers: 16,
      detail: [8, 0.28, 0.16, 20],
      macro: [0.055, 0.20, 0.14, 0.10],
      macroBig: [1.8, 0.055, 0.020, 0],
      weather: [0.10, 0.30, 0.20, 0.20],
      normalStrength: 0.75,
      wet: W.glass,
      roughness: [1, 0, 0.020],
    },
    three: { envMapIntensity: 1.9 },
  },
  curtain_glass_bronze: {
    glsl: CURTAIN_GLASS,
    surface: 'glass',
    bake: { size: 1024, worldSize: 5.4, relief: 0.030, seed: 11, param: [4, 0.35, 0.90, 0.55] },
    mat: { $ref: 'curtain_glass' },
    three: { envMapIntensity: 1.9 },
  },
  curtain_glass_clear: {
    glsl: CURTAIN_GLASS,
    surface: 'glass',
    bake: { size: 1024, worldSize: 5.4, relief: 0.030, seed: 19, param: [4, 0.18, 0.12, 0.20] },
    mat: { $ref: 'curtain_glass' },
    three: { envMapIntensity: 1.7 },
  },

  precast: {
    glsl: PRECAST,
    surface: 'concrete',
    bake: { size: 1024, worldSize: 2.8, relief: 0.065, seed: 53, param: [0, 0, 0.45, 1] },
    mat: {
      vertexMasks: true,
      // Panels are cast in batches and a whole elevation comes from one pour.
      zone: [0.7, 16, 0.05, 0.36],
      detailRot: 0.19,
      scale: 2.8,
      parallax: 0.016,
      parallaxLayers: 20,
      detail: [9, 0.95, 0.50, 24],
      macro: [0.070, 0.55, 0.24, 0.30],
      macroBig: [2.1, 0.110, 0.026, 0],
      macroRelief: 0.32,
      patch: [0.14, 2.6, 0.09, -0.05],
      weather: [0.40, 0.50, 0.60, 0.45],
      grime: [0.25, 3.5, 0.85, 0.55],
      grimeColor: 0x1e1c19,
      wet: W.wall,
      roughness: [0.98, -0.01, 0.24],
    },
  },
  precast_aggregate: {
    glsl: PRECAST,
    surface: 'concrete',
    bake: { size: 1024, worldSize: 2.8, relief: 0.085, seed: 71, param: [1, 0, 0.55, 1] },
    mat: { $ref: 'precast' },
  },
  precast_ribbed: {
    glsl: PRECAST,
    surface: 'concrete',
    bake: { size: 1024, worldSize: 2.8, relief: 0.10, seed: 79, param: [0, 1, 0.50, 1] },
    mat: { $ref: 'precast' },
  },

  stone_clad: {
    glsl: STONE_CLAD,
    surface: 'concrete',
    bake: { size: 1024, worldSize: 2.4, relief: 0.055, seed: 61, param: [1.0, 0.15, 0.35, 0] },
    mat: {
      vertexMasks: true,
      zone: [0.6, 15, 0.04, 0.45],
      detailRot: 0.31,
      scale: 2.4,
      parallax: 0.020,
      parallaxLayers: 22,
      detail: [8, 0.45, 0.36, 22],
      macro: [0.075, 0.52, 0.22, 0.35],
      macroBig: [2.0, 0.100, 0.028, 0],
      macroRelief: 0.26,
      weather: [0.35, 0.55, 0.70, 0.50],
      grime: [0.30, 3.5, 1.0, 0.5],
      grimeColor: 0x161513,
      wet: W.wall,
      roughness: [0.98, -0.01, 0.22],
    },
  },
  stone_clad_rock: {
    glsl: STONE_CLAD,
    surface: 'concrete',
    bake: { size: 1024, worldSize: 2.4, relief: 0.11, seed: 83, param: [0.7, 1.0, 0.45, 1] },
    mat: { $ref: 'stone_clad' },
  },
  stone_clad_sooted: {
    glsl: STONE_CLAD,
    surface: 'concrete',
    bake: { size: 1024, worldSize: 2.4, relief: 0.060, seed: 91, param: [1.0, 0.45, 0.95, 0] },
    mat: { $ref: 'stone_clad' },
  },

  siding: {
    glsl: SIDING,
    surface: 'wood',
    bake: {
      size: 1024, worldSize: 1.35, relief: 0.048, seed: 29,
      tintA: 0xb8bcb4, param: [0, 9, 0.45, 0],
    },
    mat: {
      vertexMasks: true,
      // Timber houses get repainted, badly, roughly every generation.
      zone: [1, 10, 0.34, 0.24],
      detailRot: 0.43,
      scale: 1.35,
      parallax: 0.018,
      parallaxLayers: 22,
      detail: [8, 0.90, 0.46, 20],
      macro: [0.085, 0.50, 0.22, 0.35],
      macroBig: [2.0, 0.105, 0.032, 0],
      macroRelief: 0.30,
      weather: [0.30, 0.50, 0.60, 0.45],
      grime: [0.24, 2.4, 0.8, 0.45],
      wearColor: 0xa89a86,
      grimeColor: 0x1a1815,
      wet: W.wall,
      roughness: [0.98, -0.02, 0.22],
    },
  },
  siding_batten: {
    glsl: SIDING,
    surface: 'wood',
    bake: {
      size: 1024, worldSize: 1.35, relief: 0.050, seed: 37,
      tintA: 0x8a6f52, param: [1, 6, 0.55, 0],
    },
    mat: { $ref: 'siding' },
  },
  siding_vinyl: {
    glsl: SIDING,
    surface: 'plaster',
    bake: {
      size: 1024, worldSize: 1.35, relief: 0.040, seed: 47,
      tintA: 0xa8b0b4, param: [0, 9, 0.05, 1],
    },
    mat: { $ref: 'siding' },
  },
  siding_peeling: {
    glsl: SIDING,
    surface: 'wood',
    bake: {
      size: 1024, worldSize: 1.35, relief: 0.030, seed: 59,
      tintA: 0xc0c2ba, param: [0, 9, 0.95, 0],
    },
    mat: { $ref: 'siding' },
  },

  mill_steel: {
    glsl: MILL_STEEL,
    surface: 'metal',
    bake: {
      size: 1024, worldSize: 2.0, relief: 0.045, seed: 73,
      tintA: 0x4e5f52, param: [1, 0.55, 0.45, 0.35],
    },
    mat: {
      detailSet: 2,
      detailRot: 0.29,
      vertexMasks: true,
      scale: 2.0,
      parallax: 0.012,
      parallaxLayers: 20,
      detail: [9, 0.85, 0.42, 20],
      macro: [0.085, 0.34, 0.18, 0.30],
      macroBig: [1.9, 0.085, 0.030, 0],
      macroRelief: 0.34,
      weather: [0.25, 0.55, 0.55, 0.40],
      grime: [0.22, 3.0, 0.9, 0.4],
      wearColor: 0x8c8f93,
      wearMaterial: [0.28, 1.0, 0, 0.85],
      grimeColor: 0x121110,
      wet: W.metal,
      roughness: [0.98, -0.01, 0.14],
    },
  },
  mill_steel_rusted: {
    glsl: MILL_STEEL,
    surface: 'metal',
    bake: {
      size: 1024, worldSize: 2.0, relief: 0.060, seed: 79,
      tintA: 0x5a4a3a, param: [1, 0.95, 0.10, 0.15],
    },
    mat: { $ref: 'mill_steel' },
  },
  /** Bridge green over red lead, still mostly holding. */
  bridge_steel: {
    glsl: MILL_STEEL,
    surface: 'metal',
    bake: {
      size: 1024, worldSize: 2.0, relief: 0.042, seed: 87,
      tintA: 0xc8a13c, param: [1, 0.30, 0.85, 0.25],
    },
    mat: { $ref: 'mill_steel' },
  },
  /** Bare structural plate: no paint, blue mill scale, light surface rust. */
  plate_steel: {
    glsl: MILL_STEEL,
    surface: 'metal',
    bake: {
      size: 1024, worldSize: 2.0, relief: 0.035, seed: 95,
      tintA: 0x5a5f62, param: [0.35, 0.30, 0.0, 0.85],
    },
    mat: { $ref: 'mill_steel' },
  },

  shingle: {
    glsl: SHINGLE,
    surface: 'concrete',
    bake: {
      size: 1024, worldSize: 1.6, relief: 0.055, seed: 17,
      tintA: 0x40403c, tintB: 0x24241f, param: [5, 0.45, 0.35, 0],
    },
    mat: {
      vertexMasks: true,
      scale: 1.6,
      parallax: 0.022,
      parallaxLayers: 22,
      detail: [8, 0.90, 0.46, 20],
      macro: [0.085, 0.46, 0.20, 0.20],
      macroBig: [1.9, 0.080, 0.030, 0],
      macroRelief: 0.30,
      weather: [0.35, 0.10, 0.10, 0.40],
      grimeColor: 0x16150f,
      wet: [1, 1, 0.35, 1],
      roughness: [0.98, -0.01, 0.30],
    },
  },
  shingle_old: {
    glsl: SHINGLE,
    surface: 'concrete',
    bake: {
      size: 1024, worldSize: 1.6, relief: 0.065, seed: 27,
      tintA: 0x4a463e, tintB: 0x2b2a24, param: [5, 0.90, 0.85, 0],
    },
    mat: { $ref: 'shingle' },
  },
  shingle_red: {
    glsl: SHINGLE,
    surface: 'concrete',
    bake: {
      size: 1024, worldSize: 1.6, relief: 0.055, seed: 39,
      tintA: 0x6b3a2c, tintB: 0x40241c, param: [5, 0.55, 0.40, 0],
    },
    mat: { $ref: 'shingle' },
  },

  tar_roof: {
    glsl: TAR_ROOF,
    surface: 'concrete',
    bake: { size: 1024, worldSize: 3.0, relief: 0.055, seed: 51, param: [0, 0.60, 0.55, 0] },
    mat: {
      vertexMasks: true,
      scale: 3.0,
      detile: 0.7,
      parallax: 0.018,
      parallaxLayers: 20,
      detail: [8, 0.90, 0.46, 20],
      macro: [0.070, 0.48, 0.22, 0.20],
      macroBig: [2.0, 0.090, 0.026, 0],
      macroRelief: 0.55,
      weather: [0.45, 0.05, 0.10, 0.32],
      grimeColor: 0x131211,
      wet: [1, 0.9, 1.2, 1],
      roughness: [0.98, -0.01, 0.28],
    },
  },
  tar_roof_smooth: {
    glsl: TAR_ROOF,
    surface: 'concrete',
    bake: { size: 1024, worldSize: 3.0, relief: 0.045, seed: 63, param: [0.5, 0.75, 0.70, 0] },
    mat: { $ref: 'tar_roof' },
  },
  tar_roof_rolled: {
    glsl: TAR_ROOF,
    surface: 'concrete',
    bake: { size: 1024, worldSize: 3.0, relief: 0.050, seed: 75, param: [1, 0.55, 0.45, 0] },
    mat: { $ref: 'tar_roof' },
  },

  stucco: {
    glsl: STUCCO,
    surface: 'plaster',
    bake: {
      size: 1024, worldSize: 2.2, relief: 0.055, seed: 33,
      tintA: 0xbfb6a2, param: [0.5, 0.45, 0, 0],
    },
    mat: {
      vertexMasks: true,
      zone: [1, 11, 0.30, 0.28],
      detailRot: 0.55,
      scale: 2.2,
      parallax: 0.020,
      parallaxLayers: 22,
      detail: [9, 1.0, 0.54, 22],
      macro: [0.085, 0.66, 0.24, 0.45],
      macroBig: [2.1, 0.135, 0.026, 0],
      macroRelief: 0.36,
      patch: [0.28, 2.2, 0.14, -0.08],
      weather: [0.34, 0.50, 0.60, 0.48],
      grime: [0.26, 2.6, 0.85, 0.5],
      wearColor: 0xb0a692,
      grimeColor: 0x1c1a16,
      wet: W.wall,
      roughness: [0.97, -0.02, 0.24],
    },
  },
  stucco_dash: {
    glsl: STUCCO,
    surface: 'plaster',
    bake: {
      size: 1024, worldSize: 2.2, relief: 0.075, seed: 45,
      tintA: 0xa89e8c, param: [1.0, 0.55, 3, 0],
    },
    mat: { $ref: 'stucco' },
  },
  stucco_float: {
    glsl: STUCCO,
    surface: 'plaster',
    bake: {
      size: 1024, worldSize: 2.2, relief: 0.040, seed: 57,
      tintA: 0xcfc6b0, param: [0.0, 0.35, 2, 0],
    },
    mat: { $ref: 'stucco' },
  },

  // ------------------------------------------------------------ nature ----
  grass: {
    glsl: GRASS,
    surface: 'grass',
    bake: { size: 1024, worldSize: 1.6, relief: 0.075, seed: 5, param: [0.75, 0.20, 0.35, 0.30] },
    mat: {
      uvMode: 'triplanar',
      scale: 1.6,
      detail: [7, 0.95, 0.48, 18],
      macro: [0.055, 0.55, 0.26, 0.35],
      macroBig: [2.1, 0.095, 0.024, 0],
      macroRelief: 0.75,
      weather: [0.12, 0.0, 0.0, 0.22],
      wear: [0, 0.45, 0.45, 0],
      dustColor: 0x8a7f5e,
      grimeColor: 0x241f14,
      normalStrength: 1.30,
      wet: W.organic,
      roughness: [0.98, -0.02, 0.32],
    },
  },
  grass_dry: {
    glsl: GRASS,
    surface: 'grass',
    bake: { size: 1024, worldSize: 1.6, relief: 0.070, seed: 15, param: [0.22, 0.45, 0.25, 0.45] },
    mat: { $ref: 'grass' },
  },
  grass_verge: {
    glsl: GRASS,
    surface: 'grass',
    bake: { size: 1024, worldSize: 1.6, relief: 0.090, seed: 25, param: [0.65, 0.15, 0.95, 0.55] },
    mat: { $ref: 'grass' },
  },
  grass_worn: {
    glsl: GRASS,
    surface: 'grass',
    bake: { size: 1024, worldSize: 1.6, relief: 0.065, seed: 35, param: [0.45, 0.80, 0.20, 0.35] },
    mat: { $ref: 'grass' },
  },
  mud: {
    glsl: MUD,
    surface: 'dirt',
    bake: { size: 1024, worldSize: 2.4, relief: 0.11, seed: 45, param: [0.55, 0.60, 0.45, 0] },
    mat: {
      uvMode: 'triplanar',
      scale: 2.4,
      detail: [8, 0.90, 0.44, 18],
      macro: [0.055, 0.52, 0.22, 0.30],
      macroBig: [2.0, 0.090, 0.024, 0],
      macroRelief: 0.85,
      weather: [0.15, 0.0, 0.0, 0.22],
      wear: [0, 0.45, 0.45, 0],
      grimeColor: 0x231b12,
      wet: [1, 1, 1.3, 1],
      roughness: [0.98, -0.02, 0.06],
    },
  },
  mud_wet: {
    glsl: MUD,
    surface: 'dirt',
    bake: { size: 1024, worldSize: 2.4, relief: 0.12, seed: 55, param: [0.95, 0.85, 0.70, 0] },
    mat: { $ref: 'mud' },
  },
  river_silt: {
    glsl: RIVER_SILT,
    surface: 'dirt',
    bake: { size: 1024, worldSize: 2.4, relief: 0.09, seed: 65, param: [0.45, 0.55, 0, 0] },
    mat: {
      uvMode: 'triplanar',
      scale: 2.4,
      detail: [8, 0.90, 0.44, 18],
      macro: [0.055, 0.50, 0.22, 0.25],
      macroBig: [2.0, 0.085, 0.024, 0],
      macroRelief: 0.7,
      weather: [0.12, 0.0, 0.0, 0.20],
      wear: [0, 0.45, 0.45, 0],
      grimeColor: 0x1c1913,
      wet: [1, 1, 1.35, 1],
      roughness: [0.98, -0.02, 0.05],
    },
  },
  river_silt_wet: {
    glsl: RIVER_SILT,
    surface: 'dirt',
    bake: { size: 1024, worldSize: 2.4, relief: 0.085, seed: 75, param: [0.90, 0.65, 0, 0] },
    mat: { $ref: 'river_silt' },
  },
  bark: {
    glsl: BARK,
    surface: 'wood',
    bake: { size: 1024, worldSize: 1.2, relief: 0.075, seed: 85, param: [0.0, 0.45, 0.65, 0] },
    mat: {
      uvMode: 'triplanar',
      scale: 1.2,
      detail: [8, 1.0, 0.50, 16],
      macro: [0.12, 0.40, 0.20, 0.30],
      macroBig: [1.9, 0.075, 0.10, 0],
      weather: [0.20, 0.15, 0.20, 0.45],
      normalStrength: 1.25,
      grimeColor: 0x181410,
      wet: W.organic,
      roughness: [0.98, -0.01, 0.36],
    },
  },
  bark_plane: {
    glsl: BARK,
    surface: 'wood',
    bake: { size: 1024, worldSize: 1.2, relief: 0.055, seed: 95, param: [0.5, 0.35, 0.50, 0] },
    mat: { $ref: 'bark' },
  },
  bark_smooth: {
    glsl: BARK,
    surface: 'wood',
    bake: { size: 1024, worldSize: 1.2, relief: 0.030, seed: 105, param: [1.0, 0.25, 0.35, 0] },
    mat: { $ref: 'bark' },
  },
  /**
   * LEAF CARD with translucency. The transmission term is the OW_CLOTH lobe in
   * shader.js: it sums a forward-scatter over every directional light, so a
   * leaf between the camera and the sun GLOWS and its veins show as dark lines
   * inside that glow. A canopy without it is cardboard.
   */
  leaf: {
    glsl: LEAF_CARD,
    surface: 'foliage',
    bake: { size: 512, worldSize: 0.55, relief: 0.012, seed: 79, param: [0.5, 0.85, 0.15, 0] },
    mat: {
      meso: [0.055, 0, 0, 0],
      uvMode: 'mesh',
      scale: 1,
      alphaMask: true,
      detail: [5, 0.35, 0.20, 10],
      detailWorld: 0,
      macro: [0.30, 0.34, 0.16, 0.55],
      weather: [0.10, 0.0, 0.0, 0.18],
      // [ transmission, underside multiplier, fold amount, unused ]
      cloth: [0.55, 0.72, 0.0, 0],
      wet: W.organic,
      roughness: [1, 0, 0.28],
    },
    three: {
      side: THREE.DoubleSide,
      alphaTest: 0.42,
      physical: true,
      sheen: 0.35,
      sheenRoughness: 0.65,
      sheenColor: 0xa8c274,
    },
  },
  leaf_autumn: {
    glsl: LEAF_CARD,
    surface: 'foliage',
    bake: { size: 512, worldSize: 0.55, relief: 0.012, seed: 89, param: [0.95, 0.80, 0.20, 0] },
    mat: { $ref: 'leaf' },
    three: {
      side: THREE.DoubleSide, alphaTest: 0.42, physical: true,
      sheen: 0.30, sheenRoughness: 0.7, sheenColor: 0xc79a55,
    },
  },
  leaf_needle: {
    glsl: LEAF_CARD,
    surface: 'foliage',
    bake: { size: 512, worldSize: 0.55, relief: 0.010, seed: 99, param: [0.35, 0.95, 1.0, 0] },
    mat: { $ref: 'leaf' },
    three: {
      side: THREE.DoubleSide, alphaTest: 0.42, physical: true,
      sheen: 0.25, sheenRoughness: 0.75, sheenColor: 0x86a468,
    },
  },

  // ------------------------------------------------------------- water ----
  // Internal: consumed by water.js, not meant to be fetched as a material.
  water_normal: {
    glsl: WATER_BAKES.water_normal.glsl,
    surface: 'water',
    bake: WATER_BAKES.water_normal.bake,
    mat: { scale: 6, weather: [0, 0, 0, 0], wet: W.dry },
    internal: true,
  },
  water_foam: {
    glsl: WATER_BAKES.water_foam.glsl,
    surface: 'water',
    bake: WATER_BAKES.water_foam.bake,
    mat: { scale: 3, alphaMask: true, weather: [0, 0, 0, 0], wet: W.dry },
    internal: true,
  },
});

/**
 * Resolve the `$ref` shorthand above. A variant that differs only in its BAKE
 * shares its parent's material parameters verbatim, which keeps the family
 * consistent and stops a tuning fix landing on one variant out of five.
 */
for (const key in LIBRARY) {
  const def = LIBRARY[key];
  const ref = def.mat?.$ref;
  if (!ref) continue;
  const parent = LIBRARY[ref];
  if (!parent) {
    console.warn(`[materials] "${key}" references unknown parent "${ref}"`);
    delete def.mat.$ref;
    continue;
  }
  const own = { ...def.mat };
  delete own.$ref;
  def.mat = { ...parent.mat, ...own };
  if (!def.three && parent.three) def.three = parent.three;
}

/**
 * Wetting response for the surfaces that were here before the wetness system.
 * Additive: the global wetness starts at 0, so nothing moves until it rains.
 */
const WET_OVERRIDES = {
  glass: W.glass,
  rubber: W.rubber,
  foliage: W.organic,
  fabric: [1, 0.7, 0.15, 0.7],
  burlap: [1, 0.85, 0.15, 0.6],
  metal_rust: [1, 0.55, 0.30, 1],
  metal_painted: W.sealed,
  metal_brushed: W.metal,
  corrugated: [1, 0.35, 0.25, 1],
  wood: [1, 0.9, 0.25, 1],
  brick: W.wall,
  plaster: W.wall,
  tile: [1, 0.35, 0.45, 1],
  concrete: W.wall,
  concrete_floor: W.mineral,
  asphalt: W.road,
  gravel: [1, 1, 1.2, 1],
  dirt: [1, 1, 1.1, 1],
  sand: [1, 1, 0.9, 1],
};
for (const key in WET_OVERRIDES) {
  if (LIBRARY[key]) LIBRARY[key].mat.wet = WET_OVERRIDES[key];
}

/**
 * Alias -> library key, so callers can ask for the physics surface name.
 *
 * NOTE for anyone extending this: `stucco` and `leaf` used to be aliases onto
 * `plaster` and `foliage`. They are now real surfaces, and `resolveName()`
 * prefers a real library key over an alias, so both silently upgraded. That is
 * deliberate and it is the only behaviour change to an existing name in the
 * whole extension.
 */
export const ALIASES = {
  metal: 'metal_painted',
  steel: 'metal_brushed',
  rust: 'metal_rust',
  sandbag: 'burlap',
  ground: 'dirt',
  road: 'asphalt',
  wall: 'concrete',
  floor: 'concrete_floor',
  plank: 'wood',
  window: 'glass',

  // ---- Steel City ----
  street: 'road_asphalt',
  tarmac: 'road_asphalt',
  carriageway: 'road_lane',
  highway: 'highway_slab',
  pavement: 'sidewalk',
  curb: 'kerb',
  setts: 'cobble',
  belgian_block: 'cobble',
  paver: 'street_brick',
  lane_line: 'road_line',
  crosswalk: 'road_crossing',
  zebra: 'road_crossing',
  stop_line: 'road_stopbar',
  drain: 'drain_grate',
  rail: 'tram_rail',

  carpaint_gloss: 'carpaint',
  paint: 'carpaint',
  windscreen: 'auto_glass',
  windshield: 'auto_glass',
  car_glass: 'auto_glass',
  bumper_trim: 'trim_plastic',
  wheel: 'alloy',
  rim: 'alloy',

  redbrick: 'pgh_brick',
  sooted_brick: 'brick_sooted',
  tower_glass: 'curtain_glass',
  spandrel: 'curtain_glass',
  panel: 'precast',
  ashlar: 'stone_clad',
  limestone: 'stone_clad',
  clapboard: 'siding',
  weatherboard: 'siding',
  vinyl: 'siding_vinyl',
  girder: 'mill_steel',
  gantry: 'mill_steel',
  bridge: 'bridge_steel',
  roof: 'shingle',
  flat_roof: 'tar_roof',
  render: 'stucco',

  turf: 'grass',
  lawn: 'grass',
  silt: 'river_silt',
  mudbank: 'river_silt',
  tree: 'bark',
  trunk: 'bark',
  foliage_leaf: 'leaf',
  canopy: 'leaf',
};

export function resolveName(name) {
  return LIBRARY[name] ? name : (ALIASES[name] ?? name);
}
