import * as THREE from 'three';

/**
 * PROPS — the surface table.
 *
 * Every material a prop can wear, named once here and resolved through
 * `ctx.get('materials')` at build time (ARCHITECTURE.md rule 2 — the material
 * system is never imported). Keeping them in one table is what makes the tile
 * batcher work: geometry is merged per SURFACE KEY, so the number of draw calls
 * a tile costs is the number of entries below it actually touched.
 *
 * `scale` is metres per texture tile. Props are small, so almost everything
 * here is a prop-scale variant of a library surface — a 2 m concrete tiling on
 * a 0.9 m bollard is one sixth of a brick and reads as flat grey.
 *
 * `uvMode: 'planar'` (the library default) projects in WORLD space, which is
 * quietly one of the most valuable things in this file: two hundred identical
 * lamp posts sample two hundred different parts of the same texture, so the
 * instanced kit does not read as a stamped clone even before the per-instance
 * yaw and scale jitter goes on.
 */

/** Sodium is the signature light of this city. Everything warm keys off it. */
export const SODIUM = 0xffb266;
export const SODIUM_DEEP = 0xff8a2b;
export const MERCURY = 0xc9e2ff;

const wear = (w, g, a) => ({ wear: [w, g, a, 0] });

/**
 * THE PAINTED-METAL TRAP. `metal_painted` bakes a METALLIC ORM, so tinting it
 * for a colour that is actually paint over steel resolves to a tinted mirror
 * that returns the sky — every sign came out pale grey-blue. Paint is a
 * dielectric film: drop the metalness to a whisper (enough that the chipped
 * arris still glints) and floor the roughness at 0.34.
 */
const PAINTED = { three: { metalness: 0.09 } };

export const SURFACES = {
  // ---------------------------------------------------------- structural --
  /** Lamp columns, sign posts, railings — painted steel, chipped to primer. */
  pole_dark: {
    name: 'metal_painted', opts: {
      scale: 0.7, tint: 0x2c3230, vertexMasks: true, ...wear(0.75, 0.8, 0.55),
      roughness: [0.92, 0.05, 0.34], grime: [0.5, 2.2, 0.9, 0.35],
      detail: [0, 0.9, 0.5, 14], detailWorld: 0.20, ...PAINTED,
    },
  },
  pole_green: {
    name: 'metal_painted', opts: {
      scale: 0.7, tint: 0x2f4038, vertexMasks: true, ...wear(0.8, 0.75, 0.5),
      roughness: [0.92, 0.04, 0.34], grime: [0.5, 2.2, 0.9, 0.35], ...PAINTED,
    },
  },
  pole_grey: {
    name: 'metal_painted', opts: {
      scale: 0.8, tint: 0x9a9d99, vertexMasks: true, ...wear(0.85, 0.7, 0.5),
      roughness: [0.92, 0.08, 0.36], ...PAINTED,
    },
  },
  galv: {
    name: 'metal_brushed', opts: {
      scale: 0.6, tint: 0xa9aeb2, vertexMasks: true, ...wear(0.6, 0.85, 0.5),
      roughness: [1, 0.18, 0.22], grime: [0.6, 2.0, 1.0, 0.5],
    },
  },
  /**
   * CONDUCTOR. Weathered aluminium and black polyethylene at 18-32 mm: almost
   * no diffuse, a hard specular line down the top of every strand, and dark
   * enough that a span reads against the sky rather than glowing on it.
   */
  wire: {
    name: 'metal_brushed', opts: {
      scale: 0.35, tint: 0x2a2c2e, vertexMasks: true, ...wear(0.5, 0.9, 0.2),
      roughness: [0.7, 0.10, 0.14], normalStrength: 0.5,
      detail: [0, 0.5, 0.2, 8], meso: [0.055, 0.1, 0.05, 0],
    },
  },
  rust: {
    name: 'metal_rust', opts: {
      scale: 0.8, vertexMasks: true, ...wear(0.9, 0.9, 0.6),
      grime: [0.7, 2.6, 1.0, 0.55],
    },
  },
  steel: {
    name: 'plate_steel', opts: { scale: 1.1, vertexMasks: true, ...wear(0.7, 0.8, 0.5) },
  },
  corrugated: {
    name: 'corrugated', opts: { scale: 1.0, vertexMasks: true, ...wear(0.8, 0.9, 0.5) },
  },
  concrete_prop: {
    name: 'concrete', opts: {
      scale: 0.55, vertexMasks: true, ...wear(0.7, 0.9, 0.6),
      grime: [0.65, 1.4, 1.0, 0.4], roughness: [1, 0.05, 0.35],
    },
  },
  kerbstone: {
    name: 'kerb', opts: { scale: 0.7, vertexMasks: true, ...wear(0.8, 0.95, 0.6) },
  },
  wood_prop: {
    name: 'wood', opts: {
      scale: 0.45, vertexMasks: true, ...wear(0.85, 0.9, 0.55),
      grime: [0.6, 1.6, 1.0, 0.45], roughness: [1, 0.08, 0.3],
    },
  },
  wood_grey: {
    name: 'wood', opts: {
      scale: 0.45, tint: 0x8d8a80, vertexMasks: true, ...wear(0.9, 0.95, 0.6),
      grime: [0.75, 1.8, 1.0, 0.5],
    },
  },
  brickface: {
    name: 'pgh_brick_old', opts: { scale: 1.6, vertexMasks: true, ...wear(0.6, 0.9, 0.5) },
  },

  // ------------------------------------------------------------ plastics --
  plastic: {
    name: 'trim_plastic', opts: {
      scale: 0.5, vertexMasks: true, ...wear(0.5, 0.9, 0.5), roughness: [1, 0.05, 0.2],
    },
  },
  plastic_red: {
    name: 'trim_plastic_faded', opts: {
      scale: 0.5, tint: 0xd6503a, vertexMasks: true, ...wear(0.6, 0.85, 0.5),
      roughness: [0.95, 0.05, 0.30],
    },
  },
  plastic_blue: {
    name: 'trim_plastic_faded', opts: {
      scale: 0.5, tint: 0x3f7ec0, vertexMasks: true, ...wear(0.6, 0.85, 0.5),
      roughness: [0.95, 0.05, 0.30],
    },
  },
  plastic_green: {
    name: 'trim_plastic_faded', opts: {
      scale: 0.5, tint: 0x44855a, vertexMasks: true, ...wear(0.6, 0.85, 0.5),
      roughness: [0.95, 0.05, 0.30],
    },
  },
  bag: {
    // 0x1b1c1e (RGB 27,28,30) at 0.85 roughness caught almost no light, so a
    // refuse sack in any shadow read as a black VOID — a hole in the pavement,
    // not an object. A real bin bag is a dark charcoal that still takes a sheen
    // of skylight on its top folds. Lifted the tint to 0x33353a and dropped the
    // base roughness so the crown catches enough light to show the lumpy form.
    name: 'rubber', opts: {
      scale: 0.4, tint: 0x33353a, vertexMasks: true, ...wear(0.35, 0.7, 0.6),
      roughness: [0.72, 0.04, 0.2],
    },
  },
  tyre: {
    name: 'tyre', opts: { scale: 0.4, vertexMasks: true, ...wear(0.4, 0.9, 0.6) },
  },
  cardboard: {
    name: 'burlap', opts: {
      scale: 0.55, tint: 0xa48a68, vertexMasks: true, ...wear(0.85, 0.95, 0.5),
      roughness: [1, 0.15, 0.5],
    },
  },

  // -------------------------------------------------------------- fabric --
  awning_red: {
    name: 'fabric', opts: {
      scale: 0.9, tint: 0xb0453a, vertexMasks: true, ...wear(0.7, 0.7, 0.35),
      cloth: [0.42, 0.78, 0.25, 0], three: { side: THREE.DoubleSide },
    },
  },
  awning_green: {
    name: 'fabric', opts: {
      scale: 0.9, tint: 0x4b7458, vertexMasks: true, ...wear(0.7, 0.7, 0.35),
      cloth: [0.42, 0.78, 0.25, 0], three: { side: THREE.DoubleSide },
    },
  },
  awning_cream: {
    name: 'fabric', opts: {
      scale: 0.9, tint: 0xcfc0a0, vertexMasks: true, ...wear(0.8, 0.7, 0.35),
      cloth: [0.45, 0.8, 0.25, 0], three: { side: THREE.DoubleSide },
    },
  },

  // --------------------------------------------------------------- glass --
  glass_prop: {
    name: 'glass', opts: {
      scale: 1.2, three: { transparent: true, opacity: 0.30, side: THREE.DoubleSide },
    },
  },

  // ------------------------------------------------------------ signfaces --
  sign_white: {
    name: 'metal_painted', opts: {
      scale: 0.9, tint: 0xd8d6cf, vertexMasks: true, ...wear(0.9, 0.85, 0.4),
      roughness: [0.9, -0.05, 0.34], grime: [0.55, 3.0, 0.8, 0.6], ...PAINTED,
    },
  },
  sign_green: {
    name: 'metal_painted', opts: {
      scale: 0.9, tint: 0x1f5b3a, vertexMasks: true, ...wear(0.9, 0.8, 0.4),
      roughness: [0.9, -0.04, 0.34], ...PAINTED,
    },
  },
  sign_blue: {
    name: 'metal_painted', opts: {
      scale: 0.9, tint: 0x1d3f77, vertexMasks: true, ...wear(0.9, 0.8, 0.4),
      roughness: [0.9, -0.02, 0.34], ...PAINTED,
    },
  },
  sign_amber: {
    name: 'metal_painted', opts: {
      scale: 0.9, tint: 0xc9821c, vertexMasks: true, ...wear(0.95, 0.8, 0.4),
      roughness: [0.9, -0.02, 0.34], ...PAINTED,
    },
  },
  sign_red: {
    name: 'metal_painted', opts: {
      scale: 0.9, tint: 0x9c2018, vertexMasks: true, ...wear(0.95, 0.8, 0.4),
      roughness: [0.9, -0.02, 0.34], ...PAINTED,
    },
  },

  /**
   * SIGNBOARD FACES. Painted sheet, not a light. The first pass made the whole
   * fascia an emissive panel and by daylight every shopfront was a flat cream
   * rectangle with no texture in it — a direct hit on the "no flat/untextured
   * surfaces" rule. Only the channel letters glow.
   */
  panel_cream: {
    name: 'plaster', opts: {
      scale: 0.9, tint: 0xcfc0a4, vertexMasks: true, ...wear(0.9, 0.9, 0.4),
      roughness: [0.9, 0.02, 0.36], grime: [0.6, 3.0, 0.9, 0.6],
    },
  },
  panel_navy: {
    name: 'plaster', opts: {
      scale: 0.9, tint: 0x24384f, vertexMasks: true, ...wear(0.9, 0.9, 0.4),
      roughness: [0.9, 0.02, 0.36], grime: [0.6, 3.0, 0.9, 0.6],
    },
  },
  panel_maroon: {
    name: 'plaster', opts: {
      scale: 0.9, tint: 0x5b2622, vertexMasks: true, ...wear(0.9, 0.9, 0.4),
      roughness: [0.9, 0.02, 0.36], grime: [0.6, 3.0, 0.9, 0.6],
    },
  },
  panel_forest: {
    name: 'plaster', opts: {
      scale: 0.9, tint: 0x233c2c, vertexMasks: true, ...wear(0.9, 0.9, 0.4),
      roughness: [0.9, 0.02, 0.36], grime: [0.6, 3.0, 0.9, 0.6],
    },
  },

  // ---------------------------------------------------------- vegetation --
  bark_street: {
    name: 'bark', opts: { scale: 0.85, vertexMasks: true, ...wear(0.4, 0.9, 0.6) },
  },
  bark_plane: {
    name: 'bark_plane', opts: { scale: 0.9, vertexMasks: true, ...wear(0.4, 0.9, 0.6) },
  },
  bark_smooth: {
    name: 'bark_smooth', opts: { scale: 0.8, vertexMasks: true, ...wear(0.35, 0.85, 0.55) },
  },

  /**
   * FOLIAGE — four numbers here decide whether a tree reads, and every one of
   * them has been wrong at some point. In order of how much damage they do:
   *
   * `three.alphaTest` — THE DISTANCE FUNCTION. There is no MSAA in this
   *   renderer (HDR post, so no alpha-to-coverage) and nothing rescales the
   *   cutout's alpha down the mip chain. At 0.42 a canopy past about sixty
   *   metres kept only the texels where two blades overlapped and collapsed
   *   into chunky rectangular blocks with holes — the "blocky, ragged clumps"
   *   defect. At 0.21 the mip-averaged card fills IN instead of falling apart,
   *   so a far crown reads as a soft mass, and near the camera the leaf edge
   *   gains a fraction of a millimetre and gets softer rather than harder.
   *
   * `bake.param.y` — DENSITY, and it is the ceiling on how solid a card can be.
   *   The bake draws one ellipse of ~0.26 cell^2 per cell, so even at 1.0 a
   *   card is only a quarter covered; anything less and the crown is an
   *   early-spring tree that has not come into leaf. Held at 1.0 everywhere.
   *
   * `wear[1]` — GRIME, and `grimeColor` on this surface is a near-black soot.
   *   Leaves get dusty, not filthy: at 0.55, with a canopy that pushed the mask
   *   toward 1.0 in the crown interior, half the cards rendered at a fifth of
   *   their authored albedo, which is the "black speckle that reads as dirt or
   *   missing texels". Grime is now a third of what it was and the crown
   *   interior is darkened with AO instead — which is what is physically there.
   *
   * `cloth[0]` — TRANSMISSION. This is the OW_CLOTH forward-scatter lobe, the
   *   single thing that separates a leaf from a piece of card: a blade between
   *   the camera and the sun has to GLOW and its veins have to show as dark
   *   lines inside that glow. It had been trimmed to 0.34; the library authored
   *   0.55 and foliage wants more than that, not less.
   *
   * The WEAR channel stays near zero: `wearColor` is a grey stone tint, perfect
   * for a chipped kerb and poison for a leaf — at 0.55 the outer half of every
   * canopy washed to pale sage and the street read as a dusty olive grove.
   */
  leaf_a: {
    name: 'leaf', opts: {
      /**
       * The tint is a MULTIPLY on albedo, so a colour whose green:red ratio is
       * higher than the bake's own saturates the leaf instead of washing it.
       * Under a bright sky IBL an unmodified dark-green card renders as pale
       * sage — the canopy loses its colour long before it loses its shape.
       */
      vertexMasks: true, wear: [0.05, 0.20, 0.62, 0], tint: 0x93c95e,
      cloth: [0.48, 0.50, 0.0, 0], macro: [0.42, 0.22, 0.20, 0.55],
      bake: { param: [0.06, 1.0, 0.10, 0] }, roughness: [1, 0.05, 0.54],
      three: {
        alphaTest: 0.21, sheen: 0.14, sheenColor: 0x9ec469, sheenRoughness: 0.72,
      },
    },
  },
  leaf_b: {
    name: 'leaf', opts: {
      vertexMasks: true, wear: [0.05, 0.18, 0.60, 0], tint: 0xafd96e,
      cloth: [0.52, 0.48, 0.0, 0], macro: [0.30, 0.24, 0.22, 0.6],
      bake: { seed: 181, param: [0.02, 1.0, 0.08, 0] }, roughness: [1, 0.05, 0.54],
      three: {
        alphaTest: 0.21, sheen: 0.13, sheenColor: 0xb0cf72, sheenRoughness: 0.68,
      },
    },
  },
  leaf_c: {
    name: 'leaf', opts: {
      vertexMasks: true, wear: [0.06, 0.24, 0.58, 0], tint: 0x76a94c,
      cloth: [0.46, 0.52, 0.0, 0], macro: [0.55, 0.22, 0.18, 0.5],
      bake: { seed: 233, param: [0.18, 1.0, 0.18, 0] }, roughness: [1, 0.05, 0.56],
      three: {
        alphaTest: 0.21, sheen: 0.12, sheenColor: 0x86a05c, sheenRoughness: 0.76,
      },
    },
  },
  leaf_autumn: {
    name: 'leaf_autumn', opts: {
      vertexMasks: true, wear: [0.05, 0.22, 0.58, 0], cloth: [0.50, 0.54, 0.0, 0],
      tint: 0xe8bd86, macro: [0.45, 0.24, 0.20, 0.55], roughness: [1, 0.05, 0.54],
      bake: { param: [0.93, 1.0, 0.16, 0] },
      three: { alphaTest: 0.21, sheen: 0.14, sheenColor: 0xd7a765, sheenRoughness: 0.7 },
    },
  },
  leaf_needle: {
    name: 'leaf_needle', opts: {
      vertexMasks: true, wear: [0.05, 0.22, 0.55, 0], tint: 0x8ab478,
      cloth: [0.44, 0.48, 0.0, 0],
      bake: { param: [0.30, 1.0, 1.0, 0] },
      three: { alphaTest: 0.21 },
    },
  },
  scrub: {
    name: 'leaf', opts: {
      vertexMasks: true, wear: [0.07, 0.30, 0.52, 0], tint: 0x86b455,
      cloth: [0.48, 0.54, 0.0, 0], macro: [0.6, 0.26, 0.22, 0.5],
      bake: { seed: 311, param: [0.16, 1.0, 0.30, 0] }, roughness: [1, 0.05, 0.56],
      three: { alphaTest: 0.21, sheen: 0.12 },
    },
  },
  /**
   * GRASS BLADES. The clump is real tapered geometry now (see `kit_green.js`),
   * so this only has to supply colour along the blade — hence `uvMode: 'mesh'`,
   * which reads the narrow vertical UV streak each blade was authored with.
   * The old entry was a WORLD-PLANAR ground texture on a standing quad: a lawn
   * stood on its edge, which is precisely the "green fur" read.
   */
  grass_blade: {
    name: 'grass_verge', opts: {
      uvMode: 'mesh', scale: 1, vertexMasks: true, wear: [0.10, 0.35, 0.55, 0],
      tint: 0xbfd98a, cloth: [0.55, 0.45, 0.0, 0],
      three: { side: THREE.DoubleSide, roughness: 0.85 },
    },
  },
  grass_tuft: {
    name: 'grass_dry', opts: {
      scale: 0.5, vertexMasks: true, ...wear(0.6, 0.8, 0.4),
      three: { side: THREE.DoubleSide },
    },
  },
  verge: {
    name: 'grass_verge', opts: { scale: 1.4, vertexMasks: true, ...wear(0.5, 0.8, 0.5) },
  },
  soil: {
    name: 'mud', opts: { scale: 0.8, vertexMasks: true, ...wear(0.4, 0.9, 0.7) },
  },

  // ------------------------------------------------------ paint on walls --
  /**
   * A GHOST SIGN: half a century of weather on a hand-painted advert across a
   * brick gable. Blended, not opaque, so the brick course still reads through
   * it, and the wear mask eats it back to nothing at the arris.
   */
  ghost: {
    name: 'plaster', opts: {
      scale: 2.4, tint: 0xc8b79a, vertexMasks: true, wear: [1.0, 0.9, 0.3, 0],
      grime: [0.8, 6.0, 0.6, 0.5], roughness: [1, 0.1, 0.4],
      three: {
        transparent: true, opacity: 0.38, depthWrite: false,
        polygonOffset: true, polygonOffsetFactor: -4, polygonOffsetUnits: -4,
        side: THREE.DoubleSide,
      },
    },
  },
  /**
   * THE INK of a ghost sign. It has to be a SEPARATE surface from the field:
   * lettering drawn in the field's own material is lettering you cannot see, and
   * the gable then reads as a blank tan rectangle bolted to a brick wall — which
   * is what a critic panel logged as "blank white rectangles standing in for
   * signage". Old lead-white paint over a red field, chalked back to nothing at
   * the top where fifty years of rain got at it first.
   */
  ghost_ink: {
    name: 'plaster', opts: {
      scale: 1.7, tint: 0x6d4a3c, vertexMasks: true, wear: [1.0, 0.85, 0.25, 0],
      grime: [0.75, 6.0, 0.7, 0.55], roughness: [1, 0.12, 0.45],
      three: {
        transparent: true, opacity: 0.46, depthWrite: false,
        polygonOffset: true, polygonOffsetFactor: -6, polygonOffsetUnits: -6,
        side: THREE.DoubleSide,
      },
    },
  },
  /** Flyposting. Paper goes grey, curls and tears; four colourways of it. */
  poster_a: {
    name: 'fabric', opts: {
      scale: 0.6, tint: 0xb8452f, vertexMasks: true, ...wear(0.95, 0.9, 0.3),
      three: { side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: -3, polygonOffsetUnits: -3 },
    },
  },
  poster_b: {
    name: 'fabric', opts: {
      scale: 0.6, tint: 0x2a4f86, vertexMasks: true, ...wear(0.95, 0.9, 0.3),
      three: { side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: -3, polygonOffsetUnits: -3 },
    },
  },
  poster_c: {
    name: 'fabric', opts: {
      scale: 0.6, tint: 0xc9b871, vertexMasks: true, ...wear(0.95, 0.9, 0.3),
      three: { side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: -3, polygonOffsetUnits: -3 },
    },
  },
  poster_d: {
    name: 'fabric', opts: {
      scale: 0.6, tint: 0xdad4c8, vertexMasks: true, ...wear(0.95, 0.9, 0.3),
      three: { side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: -3, polygonOffsetUnits: -3 },
    },
  },
  /** Aerosol. Bright, flat, slightly gloss, and raised a few millimetres. */
  tag_a: {
    name: 'metal_painted', opts: {
      scale: 0.6, tint: 0xdd2f6a, vertexMasks: true, ...wear(0.8, 0.7, 0.3),
      roughness: [0.9, 0.02, 0.34], wearMaterial: [0.6, 0, 0, 0.4], ...PAINTED,
    },
  },
  tag_b: {
    name: 'metal_painted', opts: {
      scale: 0.6, tint: 0x2fd9c9, vertexMasks: true, ...wear(0.8, 0.7, 0.3),
      roughness: [0.9, 0.02, 0.34], wearMaterial: [0.6, 0, 0, 0.4], ...PAINTED,
    },
  },
  tag_c: {
    name: 'metal_painted', opts: {
      scale: 0.6, tint: 0xf0e24a, vertexMasks: true, ...wear(0.8, 0.7, 0.3),
      roughness: [0.9, 0.02, 0.34], wearMaterial: [0.6, 0, 0, 0.4], ...PAINTED,
    },
  },
  tag_d: {
    name: 'metal_painted', opts: {
      scale: 0.6, tint: 0x17181c, vertexMasks: true, ...wear(0.75, 0.7, 0.3),
      roughness: [0.95, 0.02, 0.36], wearMaterial: [0.6, 0, 0, 0.4], ...PAINTED,
    },
  },
  chalkboard: {
    name: 'metal_painted', opts: {
      scale: 0.5, tint: 0x1b201d, vertexMasks: true, ...wear(0.9, 0.8, 0.4),
      roughness: [1, 0.1, 0.5], ...PAINTED,
    },
  },

  // ---------------------------------------------------------- road decals --
  /**
   * Everything here lies ON the road, so it renders after it. `world` already
   * paints lane lines, dashes, junction crossings, stop bars, gullies, manholes
   * and cut-and-fill patches (see `world/roadmesh.js`) — the props decal layer
   * deliberately only adds what it does NOT: kerb bay lines, utility spray
   * marks, oil, skid scuff and standing water.
   */
  decal_paint: {
    name: 'road_line', opts: { scale: 1, uvMode: 'mesh' },
  },
  decal_yellow: {
    name: 'road_line_yellow', opts: { scale: 1, uvMode: 'mesh' },
  },
  decal_arrow: {
    name: 'road_arrow', opts: { scale: 1, uvMode: 'mesh' },
  },
  decal_arrow_turn: {
    name: 'road_arrow_turn', opts: { scale: 1, uvMode: 'mesh' },
  },
  decal_hatch: {
    name: 'road_hatch', opts: { scale: 1, uvMode: 'mesh' },
  },
  oil: {
    name: 'road_asphalt_worn', opts: {
      scale: 1.6, tint: 0x151417, vertexMasks: true, ...wear(0.2, 1, 0.7),
      three: { transparent: true, opacity: 0.72, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -3, polygonOffsetUnits: -3 },
    },
  },
  /**
   * STANDING WATER. Not the river material — a puddle is a thin mirror lying in
   * a hollow. Near-zero roughness so it takes the sky, the sodium lamps and
   * whatever SSR can find, and blended at the rim so it does not read as a
   * cut-out sticker.
   */
  puddle: {
    name: 'road_asphalt', opts: {
      scale: 3.0, tint: 0x141619, vertexMasks: true, wear: [0, 0.35, 0.6, 0],
      roughness: [0.05, 0.0, 0.02], normalStrength: 0.15,
      detail: [0, 0.05, 0.02, 6], meso: [0.055, 0.04, 0.02, 0.0],
      weather: [0, 0, 0, 0], wet: [1, 1, 1, 1],
      three: {
        transparent: true, opacity: 0.88, depthWrite: false, metalness: 0.0,
        polygonOffset: true, polygonOffsetFactor: -4, polygonOffsetUnits: -4,
      },
    },
  },
  tarpatch: {
    name: 'road_asphalt_patched', opts: {
      scale: 1.4, vertexMasks: true, ...wear(0.4, 0.9, 0.4),
      three: { polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 },
    },
  },
  gravelbed: {
    name: 'gravel', opts: { scale: 1.0, vertexMasks: true, ...wear(0.4, 0.8, 0.5) },
  },
};

/**
 * EMISSIVE surfaces are built here rather than fetched: `materials` produces
 * physically-shaded PBR, and a neon tube is a light source, not a surface.
 * Their intensity is driven from the sun altitude every frame — a night city is
 * thousands of signs and `q.lightSlots` is eight, so this is emissive + bloom,
 * exactly as ARCHITECTURE.md requires.
 *
 * `base` is the daytime intensity; the night multiplier is applied on top.
 */
export const EMISSIVE = {
  sodium_lamp: { color: 0xffc17a, base: 0.22, night: 5.5, rough: 0.35 },
  /**
   * The pool of light a sodium lamp throws on the road. Additive, flat on the
   * ground and deliberately timid: this is a hint that the lamp is lit, not a
   * light source. It was a volumetric cone once and a critic saw solid orange
   * wedges standing on the pavement.
   */
  sodium_glow: { color: SODIUM_DEEP, base: 0.0, night: 1.0, additive: true, peak: 0.055 },
  /**
   * INTENSITY SCALES WITH AREA, NOT WITH IMPORTANCE. A 22 mm neon tube can sit
   * five stops over white and still read as a tube, because bloom has almost
   * no area to smear. A 4 m lit sign box at the same intensity is a blown white
   * slab with no shape in it — which is exactly what the first night capture
   * showed. So the thin emitters run hot and the broad ones run cool.
   */
  neon_amber: { color: 0xff9a2e, base: 0.12, night: 3.8 },
  neon_teal: { color: 0x2ee2d0, base: 0.12, night: 3.4 },
  neon_violet: { color: 0xc07cff, base: 0.12, night: 3.4 },
  neon_red: { color: 0xff3b30, base: 0.13, night: 3.6 },
  neon_white: { color: 0xdfe8ff, base: 0.12, night: 3.0 },
  signal_red: { color: 0xff2a18, base: 0.5, night: 2.6 },
  signal_amber: { color: 0xffa018, base: 0.5, night: 2.6 },
  signal_green: { color: 0x22ff77, base: 0.5, night: 2.6 },
  /**
   * Broad area: an ad panel or an illuminated menu case.
   *
   * RE-TUNED AGAINST THE LANDED EXPOSURE FIX. These two were deliberately held
   * near zero to survive a meter that wound to 13.77 on a night frame against a
   * ceiling of 15 — at that gain any broad emitter was a white slab. `render`
   * has since added the night compensation curve (`exposure.js` uNight) and the
   * same frame now settles at ~5.3, so the compensation here is 2.5 stops of
   * darkness that nothing is asking for any more: measured on `night`, p99 is
   * 174/255 with 0.08% of pixels blown, i.e. there is headroom and the city's
   * shopfronts were simply unlit. The AREA argument above still holds, so these
   * stay well under the neon — they are just no longer invisible.
   */
  shop_lit: { color: 0xffcf93, base: 0.11, night: 0.85 },
  /**
   * The plane of light behind a shop window. It exists ONLY after dark — by day
   * it would be a flat pale rectangle sitting inside the glass.
   */
  window_glow: { color: 0xffd6a4, base: 0, night: 0.95, nightOnly: true },
};

/** Neon colour rotation per district — this is how a district reads at night. */
export const DISTRICT_NEON = {
  downtown: ['neon_teal', 'neon_white', 'neon_amber', 'neon_violet'],
  point: ['neon_teal', 'neon_white'],
  strip: ['neon_red', 'neon_amber', 'neon_white'],
  lawren: ['neon_amber', 'neon_red', 'neon_teal'],
  northsh: ['neon_teal', 'neon_white', 'neon_amber'],
  troy: ['neon_amber', 'neon_red'],
  southside: ['neon_violet', 'neon_amber', 'neon_red'],
  mtwash: ['neon_amber', 'neon_white'],
  steelrow: ['neon_amber', 'neon_red'],
  westend: ['neon_amber', 'neon_teal'],
  northside: ['neon_amber', 'neon_white'],
  hazel: ['neon_red', 'neon_amber'],
};

/**
 * DISTRICT DRESSING WEIGHTS.
 *
 * What each district actually has on its street — this is most of what makes
 * twelve districts read as twelve places rather than one kit laid down twelve
 * times. `trees` and `litter` are densities; `kind` biases which furniture and
 * signage families get picked.
 */
export const DISTRICT_STYLE = {
  downtown: { trees: 0.75, litter: 0.55, meters: 1.0, signage: 1.0, wires: 0.25, scaffold: 0.5, lampKind: 'twin', hydrant: 1.0, benches: 0.8, kind: 'core' },
  point: { trees: 1.5, litter: 0.2, meters: 0.1, signage: 0.15, wires: 0.1, scaffold: 0.05, lampKind: 'park', hydrant: 0.4, benches: 1.4, kind: 'park' },
  strip: { trees: 0.35, litter: 1.4, meters: 0.7, signage: 1.3, wires: 0.9, scaffold: 0.7, lampKind: 'cobra', hydrant: 0.9, benches: 0.4, kind: 'market' },
  lawren: { trees: 0.95, litter: 0.9, meters: 0.5, signage: 1.0, wires: 1.0, scaffold: 0.5, lampKind: 'acorn', hydrant: 1.0, benches: 0.5, kind: 'row' },
  northsh: { trees: 0.9, litter: 0.5, meters: 0.8, signage: 0.7, wires: 0.5, scaffold: 0.4, lampKind: 'cobra', hydrant: 0.8, benches: 0.9, kind: 'civic' },
  troy: { trees: 1.1, litter: 0.6, meters: 0.15, signage: 0.45, wires: 1.2, scaffold: 0.2, lampKind: 'acorn', hydrant: 0.7, benches: 0.3, kind: 'row' },
  southside: { trees: 0.55, litter: 1.1, meters: 0.4, signage: 1.1, wires: 1.1, scaffold: 0.5, lampKind: 'cobra', hydrant: 0.9, benches: 0.4, kind: 'row' },
  mtwash: { trees: 1.2, litter: 0.45, meters: 0.1, signage: 0.35, wires: 1.15, scaffold: 0.15, lampKind: 'acorn', hydrant: 0.6, benches: 0.7, kind: 'hill' },
  steelrow: { trees: 0.2, litter: 1.5, meters: 0.05, signage: 0.5, wires: 1.4, scaffold: 0.9, lampKind: 'cobra', hydrant: 0.6, benches: 0.1, kind: 'mill' },
  westend: { trees: 1.0, litter: 0.55, meters: 0.1, signage: 0.4, wires: 1.15, scaffold: 0.2, lampKind: 'acorn', hydrant: 0.6, benches: 0.4, kind: 'hill' },
  northside: { trees: 0.9, litter: 0.7, meters: 0.25, signage: 0.6, wires: 1.1, scaffold: 0.35, lampKind: 'acorn', hydrant: 0.8, benches: 0.5, kind: 'row' },
  hazel: { trees: 0.6, litter: 1.2, meters: 0.1, signage: 0.5, wires: 1.25, scaffold: 0.4, lampKind: 'cobra', hydrant: 0.7, benches: 0.25, kind: 'mill' },
};

export const DEFAULT_STYLE = DISTRICT_STYLE.lawren;

/** ARCHITECTURE.md surface tags, for the collision proxies props registers. */
export const SURFACE_TAG = {
  pole_dark: 'metal', pole_green: 'metal', pole_grey: 'metal', galv: 'metal',
  rust: 'metal', steel: 'metal', corrugated: 'metal', concrete_prop: 'concrete',
  kerbstone: 'concrete', wood_prop: 'wood', wood_grey: 'wood', brickface: 'concrete',
  plastic: 'plastic', bag: 'fabric', tyre: 'rubber', glass_prop: 'glass',
  bark_street: 'wood', bark_plane: 'wood', bark_smooth: 'wood',
  leaf_a: 'foliage', leaf_b: 'foliage', leaf_autumn: 'foliage',
  leaf_needle: 'foliage',
  leaf_c: 'foliage', scrub: 'foliage', grass_tuft: 'foliage',
  grass_blade: 'grass', verge: 'grass',
  soil: 'dirt', gravelbed: 'gravel',
};
