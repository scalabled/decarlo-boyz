import * as THREE from 'three';

/**
 * MATERIALS FOR THE IMPROVISED ARSENAL.
 *
 * The inherited set in `materials.js` describes a factory-built black rifle:
 * hard-anodised aluminium, glass-filled nylon, parkerised steel. Three surfaces,
 * all near-black, all calibrated for a FIRST-PERSON viewmodel that sees a
 * quarter of the sky (`ENV_OCCLUSION`).
 *
 * Nothing in this game is factory-built and nothing is 30 cm from the eye. A
 * Dock Pipe is a rusted galvanised water pipe with tape on it; a Nail Gun is
 * safety-yellow tool plastic over a chromed air cylinder; an EMP Coil is a car
 * battery, a capacitor bank and 40 turns of enamelled copper. So this file adds
 * a SECOND palette, authored against three rules:
 *
 *  1. **Hue separation before value separation.** The failure mode is
 *     "barrel, rail, polymer handguard and optic housing all share one flat
 *     diffuse grey". Every material here is placed on a hue wheel — rust is
 *     orange-red, galvanising is cool blue-grey with a green cast, safety paint
 *     is saturated, tape is neutral, wood is warm brown, copper is copper. Two
 *     adjacent parts on any weapon in this set are never the same hue.
 *  2. **Honest albedo.** 0.02-0.9 linear, per ARCHITECTURE's quality bar. These
 *     live in the WORLD scene under the real sun, not in a private view scene
 *     with its own exposure, so `env` is 1 and the numbers have to be the real
 *     ones. Bare rust is genuinely bright (0.09-0.14); zinc is brighter still.
 *  3. **Wear that means something.** Paint chips to the metal underneath
 *     (`wearColor` is a steel, not a lighter version of the paint). Tape goes
 *     grey and picks up grease at the edges. Cast iron polishes only where a
 *     hand has been. The vertex curvature masks (see `Assembly` -> bakeMasks)
 *     put all of it on the edges, which is where it belongs.
 *
 * `env: 1` on every entry is load-bearing: these materials are lit by
 * `ctx.scene.environment` at full strength because a weapon in a character's
 * hand really does see the whole sky.
 */

const c = (r, g, b) => new THREE.Color(r, g, b);

/**
 * Shared base. Same triplanar/local-space projection as the inherited set — a
 * merged procedural weapon has no UV unwrap — but the world-space weathering
 * channels are back ON. A pipe in a fist IS in the world: rain streaks down it
 * and it collects dust the same way a railing does, and disabling that was only
 * ever right for something welded to the camera.
 */
const BASE = {
  uvMode: 'triplanar',
  localSpace: true,
  vertexMasks: true,
  // [dust, rainStreak, groundSplash, cavityGrime]
  weather: [0.18, 0.12, 0, 0.7],
  macro: [0.6, 0.06, 0.08, 0.07],
  aoStrength: 1,
};

/** Tool-scale detail: a 0.5 m object needs its micro layer alive at 2 m. */
const DETAIL_NEAR = 8;

/**
 * key -> [libraryName, opts, { env }]
 *
 * Deliberately ordered by substance family so the palette reads as a set:
 * ferrous · plated · painted · soft · organic · electrical.
 */
export const IMPROVISED_MATERIALS = {
  /* ==================================================================== */
  /*  FERROUS                                                             */
  /* ==================================================================== */

  /**
   * Mild steel with mill scale — welded box sections, the SMG receiver, angle
   * iron, anything cut from stock and never finished. Blue-grey, low albedo,
   * matte, with the weld-spatter and grinder marks living in the detail layer.
   */
  imp_steel: [
    'metal_brushed',
    {
      ...BASE,
      bake: { size: 512, seed: 4021, relief: 0.008 },
      scale: 0.09,
      // Metal: this is F0. Hot-rolled steel is a genuinely dark reflector.
      tint: c(0.225, 0.232, 0.252),
      roughness: [0.66, 0.30, 0.46],
      normalStrength: 1.35,
      detail: [17, 1.1, 0.5, DETAIL_NEAR],
      // Handled steel polishes on the corners — this is the "used tool" cue.
      wear: [0.3, 0.6, 0.5, 0],
      wearColor: 0x8d9199,
      wearMaterial: [0.2, 1.0, 0, 0.85],
      grimeColor: 0x120e09,
      three: { anisotropy: 0.22 },
    },
    { env: 1 },
  ],

  /**
   * RUST. The signature surface of this whole game — Steel Row, the mill, the
   * barges, and four of the sixteen weapons.
   *
   * Rust is not "dark metal". It is a porous, completely non-metallic iron oxide
   * powder: metalness 0, albedo 0.10-0.16 linear, strongly red-orange, and it
   * scatters rather than reflects. Rendering it as a metal is the single most
   * common way to make a rusted object look like painted plastic, because a
   * metal has no diffuse term at all and rust is nothing BUT diffuse.
   */
  imp_rust: [
    'metal_rust',
    {
      ...BASE,
      bake: { size: 1024, seed: 4093, relief: 0.05 },
      scale: 0.16,
      tint: c(1.62, 1.02, 0.62),
      roughness: [0.80, 0.14, 0.66],
      normalStrength: 1.7,
      detail: [11, 1.3, 0.6, DETAIL_NEAR],
      // Bare metal shows through where the rust has been knocked off — high
      // spots on a pipe that gets swung into things.
      wear: [0.34, 0.55, 0.45, 0],
      wearColor: 0x6e6a66,
      wearMaterial: [0.3, 0.85, 0, 0.75],
      grimeColor: 0x1a0f06,
      three: { physical: true, metalness: 0.0, specularIntensity: 0.35 },
    },
    { env: 1 },
  ],

  /**
   * GALVANISED — hot-dip zinc, the finish on every water pipe, conduit, bucket
   * and dock fitting in Pittsburgh. Bright, cool, slightly GREEN-grey (that
   * green is the giveaway that separates zinc from aluminium), matte from the
   * spangle crystals, and it dulls to a chalky white oxide with age.
   */
  imp_galv: [
    'metal_brushed',
    {
      ...BASE,
      bake: { size: 512, seed: 3301, relief: 0.012 },
      scale: 0.075,
      tint: c(0.325, 0.352, 0.334),
      // Zinc spangle is matte: this is the roughest metal in the set.
      roughness: [0.60, 0.42, 0.58],
      normalStrength: 1.5,
      detail: [21, 1.25, 0.62, DETAIL_NEAR],
      wear: [0.35, 0.5, 0.4, 0],
      wearColor: 0xb9c2bd,
      wearMaterial: [0.42, 1.0, 0, 0.7],
      grimeColor: 0x141310,
      three: { anisotropy: 0.1 },
    },
    { env: 1 },
  ],

  /**
   * Drop-forged tool steel — wrench, crowbar, the harpoon head. A forging has a
   * skin of dark scale left from the hammer, and it wears to a bright bar-steel
   * polish exactly on the working faces: jaw, claw, chisel. Neutral in hue on
   * purpose so the orange paint and the wood handle read against it.
   */
  imp_forged: [
    'metal_brushed',
    {
      ...BASE,
      bake: { size: 512, seed: 5171, relief: 0.007 },
      scale: 0.055,
      tint: c(0.235, 0.238, 0.248),
      roughness: [0.60, 0.26, 0.36],
      normalStrength: 1.1,
      detail: [22, 0.9, 0.45, DETAIL_NEAR],
      // The strongest wear in the set — a wrench jaw is bright bare steel.
      wear: [0.52, 0.72, 0.55, 0],
      wearColor: 0xa9aeb6,
      wearMaterial: [0.16, 1.0, 0, 0.9],
      grimeColor: 0x0d0b09,
      three: { anisotropy: 0.35 },
    },
    { env: 1 },
  ],

  /**
   * Greasy black iron — the inside of a shop, a mechanic's tool that lives in an
   * oil pan. Near-black, but WARM near-black with a wet sheen, not the cool
   * matte of the anodised rifle. Used for the moving parts of the improvised
   * guns: bolts, hammers, springs, linkage.
   */
  imp_grease: [
    'metal_brushed',
    {
      ...BASE,
      bake: { size: 512, seed: 6211, relief: 0.005 },
      scale: 0.05,
      tint: c(0.085, 0.079, 0.072),
      // Oil film: LOW roughness on a dark base is what reads as greasy.
      roughness: [0.34, 0.22, 0.16],
      normalStrength: 0.9,
      detail: [26, 0.7, 0.4, DETAIL_NEAR],
      wear: [0.22, 0.6, 0.5, 0],
      wearColor: 0x5c5f64,
      wearMaterial: [0.24, 1.0, 0, 0.85],
      grimeColor: 0x070605,
      three: { anisotropy: 0.28 },
    },
    { env: 1 },
  ],

  /* ==================================================================== */
  /*  PLATED / BRIGHT                                                     */
  /* ==================================================================== */

  /** Cheap chrome plate — an air cylinder, a jubilee clip, a socket. */
  imp_chrome: [
    'metal_brushed',
    {
      ...BASE,
      bake: { size: 512, seed: 7717, relief: 0.003 },
      scale: 0.045,
      tint: c(0.40, 0.412, 0.432),
      roughness: [0.42, 0.18, 0.16],
      normalStrength: 0.6,
      detail: [30, 0.5, 0.3, DETAIL_NEAR],
      // Chrome pits and flakes rather than polishing — the wear layer here is
      // the rust bleeding through the plating.
      wear: [0.24, 0.5, 0.45, 0],
      wearColor: 0x6b4a2e,
      wearMaterial: [0.6, 0.3, 0, 0.4],
      grimeColor: 0x0a0908,
      three: { anisotropy: 0.4 },
    },
    { env: 1 },
  ],

  /** Yellow-passivated zinc plating — every hardware-store bolt and washer. */
  imp_zinc: [
    'metal_brushed',
    {
      ...BASE,
      bake: { size: 256, seed: 8123, relief: 0.004 },
      scale: 0.028,
      tint: c(0.44, 0.345, 0.168),
      roughness: [0.55, 0.28, 0.32],
      normalStrength: 0.7,
      detail: [34, 0.6, 0.35, DETAIL_NEAR],
      wear: [0.4, 0.55, 0.45, 0],
      wearColor: 0xb9a878,
      wearMaterial: [0.3, 1.0, 0, 0.8],
      three: { anisotropy: 0.2 },
    },
    { env: 1 },
  ],

  /** Brass — flare shells, gauge bodies, hose fittings, the harpoon collar. */
  imp_brass: [
    'metal_brushed',
    {
      ...BASE,
      bake: { size: 256, seed: 8231, relief: 0.004 },
      scale: 0.035,
      tint: c(0.40, 0.288, 0.135),
      roughness: [0.52, 0.24, 0.3],
      normalStrength: 0.7,
      detail: [28, 0.6, 0.34, DETAIL_NEAR],
      // Brass goes green-black in the crevices and polishes gold on the ribs.
      wear: [0.55, 0.45, 0.4, 0],
      wearColor: 0xe4c07a,
      wearMaterial: [0.18, 1.0, 0, 0.85],
      grimeColor: 0x0d1408,
      three: { anisotropy: 0.15 },
    },
    { env: 1 },
  ],

  /** Bare copper — the EMP coil windings and the jumper lugs. */
  imp_copper: [
    'metal_brushed',
    {
      ...BASE,
      bake: { size: 256, seed: 8317, relief: 0.005 },
      scale: 0.02,
      tint: c(0.46, 0.242, 0.155),
      roughness: [0.50, 0.22, 0.28],
      normalStrength: 0.9,
      detail: [40, 0.7, 0.36, DETAIL_NEAR],
      wear: [0.5, 0.4, 0.4, 0],
      wearColor: 0xe08a54,
      wearMaterial: [0.2, 1.0, 0, 0.85],
      grimeColor: 0x0a1410,
      three: { anisotropy: 0.5 },
    },
    { env: 1 },
  ],

  /* ==================================================================== */
  /*  PAINTED — the colour in the set                                     */
  /* ==================================================================== */

  /**
   * Safety orange over steel. Every one of these paints is a DIELECTRIC over a
   * metal, so `wearColor` is the steel showing through the chips and
   * `wearMaterial` flips metalness to 1 in exactly those pixels. That flip is
   * the whole trick: a chip in paint is not a lighter patch of paint, it is a
   * different substance, and the eye reads it instantly.
   *
   * See the REVIEW.md trap: `metal_painted` bakes a metallic ORM and anything
   * tinting it for a non-metal resolves to a mirror. All of these are based on
   * `rubber`, which is an honest dielectric.
   */
  imp_paint_orange: [
    'rubber',
    {
      ...BASE,
      bake: { size: 512, seed: 9011, relief: 0.006 },
      scale: 0.07,
      // ~0.31/0.075/0.012 linear — a saturated industrial enamel.
      tint: c(9.2, 2.25, 0.36),
      roughness: [0.5, 0.24, 0.3],
      normalStrength: 1.15,
      detail: [19, 0.9, 0.45, DETAIL_NEAR],
      wear: [0.42, 0.62, 0.5, 0],
      wearColor: 0x8c8f96,
      wearMaterial: [0.28, 1.0, 0, 0.85],
      grimeColor: 0x100b06,
      three: { physical: true, specularIntensity: 0.4, clearcoat: 0.18, clearcoatRoughness: 0.6 },
    },
    { env: 1 },
  ],

  /** Tool-body yellow — the nail gun, the tack cannon shell, hazard stripes. */
  imp_paint_yellow: [
    'rubber',
    {
      ...BASE,
      bake: { size: 512, seed: 9091, relief: 0.007 },
      scale: 0.05,
      tint: c(10.4, 6.4, 0.5),
      roughness: [0.44, 0.26, 0.3],
      normalStrength: 1.3,
      // Moulded ABS carries the strongest micro-stipple of anything here.
      detail: [27, 1.15, 0.55, DETAIL_NEAR],
      // Plastic scuffs pale and grey rather than exposing metal.
      wear: [0.3, 0.55, 0.5, 0],
      wearColor: 0x9c8f5c,
      wearMaterial: [0.5, 0.0, 0, 0.45],
      grimeColor: 0x120e05,
      three: { physical: true, specularIntensity: 0.34, clearcoat: 0.12, clearcoatRoughness: 0.7 },
    },
    { env: 1 },
  ],

  /** Oxide red / shop primer — the crowbar, the scrap rocket, painted angle. */
  imp_paint_red: [
    'rubber',
    {
      ...BASE,
      bake: { size: 512, seed: 9173, relief: 0.008 },
      scale: 0.085,
      tint: c(6.1, 1.05, 0.55),
      roughness: [0.62, 0.2, 0.42],
      normalStrength: 1.25,
      detail: [15, 1.0, 0.5, DETAIL_NEAR],
      // Primer is thin and chips badly — the most exposed metal of the paints.
      wear: [0.55, 0.7, 0.55, 0],
      wearColor: 0x83868c,
      wearMaterial: [0.3, 1.0, 0, 0.85],
      grimeColor: 0x0e0805,
      three: { physical: true, specularIntensity: 0.28 },
    },
    { env: 1 },
  ],

  /** Capacitor / battery-case blue. Cold, and the only cool saturated hue. */
  imp_paint_blue: [
    'rubber',
    {
      ...BASE,
      bake: { size: 512, seed: 9227, relief: 0.005 },
      scale: 0.045,
      tint: c(0.6, 1.9, 5.4),
      roughness: [0.42, 0.22, 0.28],
      normalStrength: 1.0,
      detail: [24, 0.9, 0.45, DETAIL_NEAR],
      wear: [0.26, 0.5, 0.5, 0],
      wearColor: 0x7d8794,
      wearMaterial: [0.44, 0.0, 0, 0.5],
      grimeColor: 0x08090c,
      three: { physical: true, specularIntensity: 0.36, clearcoat: 0.2, clearcoatRoughness: 0.55 },
    },
    { env: 1 },
  ],

  /** Boathouse teal — Carson's gear, and the DESIGN.md river palette. */
  imp_paint_teal: [
    'rubber',
    {
      ...BASE,
      bake: { size: 512, seed: 9311, relief: 0.007 },
      scale: 0.08,
      tint: c(0.75, 3.6, 3.3),
      roughness: [0.56, 0.22, 0.38],
      normalStrength: 1.2,
      detail: [17, 1.0, 0.5, DETAIL_NEAR],
      wear: [0.5, 0.66, 0.52, 0],
      wearColor: 0x87898e,
      wearMaterial: [0.3, 1.0, 0, 0.85],
      grimeColor: 0x0a0d0c,
      three: { physical: true, specularIntensity: 0.3 },
    },
    { env: 1 },
  ],

  /* ==================================================================== */
  /*  SOFT — tape, hose, plastic                                          */
  /* ==================================================================== */

  /**
   * Silver cloth duct tape. Half the arsenal is held together with it, so it has
   * to look like tape and not like paint: a visible woven scrim under a matte
   * polyethylene film, edges that go dark with grease, and a value close enough
   * to bare metal that the WEAVE is what tells them apart.
   */
  imp_tape_duct: [
    'fabric',
    {
      ...BASE,
      bake: { size: 512, seed: 9403, relief: 0.018, tintA: 0x8c9195, tintB: 0x5a5f63 },
      scale: 0.055,
      tint: c(0.88, 0.89, 0.91),
      roughness: [0.66, 0.16, 0.5],
      // The scrim weave is the whole read. Full amplitude, tight tile.
      normalStrength: 1.9,
      detail: [46, 1.35, 0.5, DETAIL_NEAR],
      wear: [0.2, 0.4, 0.5, 0],
      wearColor: 0x8b8f92,
      wearMaterial: [0.7, 0.0, 0, 0.3],
      grimeColor: 0x0b0a08,
      weather: [0.3, 0.1, 0, 0.85],
      three: { physical: true, sheen: 0.25, sheenRoughness: 0.9, specularIntensity: 0.3 },
    },
    { env: 1 },
  ],

  /** Black cloth / friction tape — grip wraps, cable lashings. */
  imp_tape_black: [
    'fabric',
    {
      ...BASE,
      bake: { size: 512, seed: 9461, relief: 0.020, tintA: 0x24262a, tintB: 0x121316 },
      scale: 0.045,
      tint: c(1.0, 0.98, 1.0),
      roughness: [0.82, 0.1, 0.6],
      normalStrength: 2.0,
      detail: [52, 1.4, 0.5, DETAIL_NEAR],
      wear: [0.16, 0.45, 0.55, 0],
      wearColor: 0x4a4c50,
      wearMaterial: [0.7, 0.0, 0, 0.25],
      grimeColor: 0x060505,
      three: { physical: true, sheen: 0.3, sheenRoughness: 0.85, specularIntensity: 0.22 },
    },
    { env: 1 },
  ],

  /** Air hose / cable jacket — soft black rubber with a moulded rib. */
  imp_hose: [
    'rubber',
    {
      ...BASE,
      bake: { size: 512, seed: 9533, relief: 0.011 },
      scale: 0.03,
      tint: c(0.5, 0.5, 0.53),
      roughness: [0.7, 0.16, 0.46],
      normalStrength: 1.5,
      detail: [30, 1.0, 0.5, DETAIL_NEAR],
      wear: [0.2, 0.5, 0.5, 0],
      wearColor: 0x4c4e52,
      wearMaterial: [0.6, 0.0, 0, 0.3],
      grimeColor: 0x080807,
      three: { physical: true, specularIntensity: 0.24 },
    },
    { env: 1 },
  ],

  /** Hard tool plastic — the dark half of a two-shot moulding, battery cases. */
  imp_plastic: [
    'rubber',
    {
      ...BASE,
      bake: { size: 512, seed: 9601, relief: 0.008 },
      scale: 0.04,
      tint: c(0.72, 0.7, 0.72),
      roughness: [0.5, 0.24, 0.34],
      normalStrength: 1.4,
      detail: [26, 1.1, 0.55, DETAIL_NEAR],
      wear: [0.24, 0.5, 0.5, 0],
      wearColor: 0x6e7076,
      wearMaterial: [0.5, 0.0, 0, 0.45],
      grimeColor: 0x090908,
      three: { physical: true, specularIntensity: 0.3, clearcoat: 0.1, clearcoatRoughness: 0.7 },
    },
    { env: 1 },
  ],

  /* ==================================================================== */
  /*  ORGANIC                                                             */
  /* ==================================================================== */

  /** Hickory / ash handle — sweat-darkened at the grip, splintered at the end. */
  imp_wood: [
    'wood',
    {
      ...BASE,
      /**
       * `scale` is the metres one tile of the library's `wood` covers, and that
       * material is authored for BUILDING SIDING: its macro layer lays out
       * planks with a groove between them. At 0.12 m a plank was 15 mm, so a
       * 90 mm pistol grip came out looking like five courses of brick — the
       * single worst material read in the arsenal. 0.55 m puts one plank across
       * the whole grip, which is what a hickory handle is: one piece of wood.
       * The grain then comes from `detail`, not from the macro tiling.
       */
      bake: { size: 512, seed: 9677, relief: 0.018 },
      scale: 0.55,
      macro: [0.9, 0.03, 0.05, 0.05],
      tint: c(1.25, 0.92, 0.62),
      roughness: [0.7, 0.2, 0.5],
      normalStrength: 1.2,
      /* Grain, at handle scale: fine, strongly directional, alive at 2 m. */
      detail: [34, 1.25, 0.55, DETAIL_NEAR],
      // A used handle POLISHES where the hand goes; it does not expose metal.
      wear: [0.55, 0.6, 0.45, 0],
      wearColor: 0xb08a55,
      wearMaterial: [0.36, 0.0, 0, 0.55],
      grimeColor: 0x160f07,
      three: { physical: true, specularIntensity: 0.35, clearcoat: 0.15, clearcoatRoughness: 0.65 },
    },
    { env: 1 },
  ],

  /** Manila rope / hemp lashing — the harpoon line and the dock-pipe lanyard. */
  imp_rope: [
    'burlap',
    {
      ...BASE,
      bake: { size: 512, seed: 9743, relief: 0.03 },
      scale: 0.05,
      tint: c(0.82, 0.68, 0.47),
      roughness: [0.86, 0.1, 0.6],
      normalStrength: 2.0,
      detail: [34, 1.3, 0.55, DETAIL_NEAR],
      wear: [0.3, 0.4, 0.5, 0],
      wearColor: 0xbaa583,
      wearMaterial: [0.75, 0.0, 0, 0.2],
      grimeColor: 0x140f08,
      three: { physical: true, sheen: 0.5, sheenRoughness: 0.95 },
    },
    { env: 1 },
  ],

  /** Canvas webbing — slings, straps, the tool belt the mag hangs off. */
  imp_canvas: [
    'fabric',
    {
      ...BASE,
      bake: { size: 512, seed: 9811, relief: 0.02, tintA: 0x4a4436, tintB: 0x2f2c24 },
      scale: 0.04,
      tint: c(1.0, 0.98, 0.94),
      roughness: [0.84, 0.1, 0.6],
      normalStrength: 1.8,
      detail: [40, 1.2, 0.5, DETAIL_NEAR],
      wear: [0.24, 0.4, 0.5, 0],
      wearColor: 0x736a55,
      wearMaterial: [0.72, 0.0, 0, 0.25],
      grimeColor: 0x0d0b07,
      three: { physical: true, sheen: 0.45, sheenRoughness: 0.9 },
    },
    { env: 1 },
  ],

  /** Cork / leather pad — the harpoon shoulder rest, the depth-charge collar. */
  imp_leather: [
    'rubber',
    {
      ...BASE,
      bake: { size: 512, seed: 9887, relief: 0.018 },
      scale: 0.05,
      tint: c(1.5, 0.95, 0.6),
      roughness: [0.72, 0.16, 0.5],
      normalStrength: 1.7,
      detail: [22, 1.2, 0.55, DETAIL_NEAR],
      wear: [0.45, 0.5, 0.45, 0],
      wearColor: 0xa07a4e,
      wearMaterial: [0.5, 0.0, 0, 0.4],
      grimeColor: 0x120b06,
      three: { physical: true, specularIntensity: 0.28 },
    },
    { env: 1 },
  ],
};

/**
 * EMISSIVE / SPECIAL materials with no library equivalent. These are owned and
 * disposed by `WeaponMaterials`.
 *
 * They are `MeshBasicMaterial` on purpose: a flare tip, an arc and a hot filament
 * are LIGHT SOURCES, not lit surfaces, and running them through the standard
 * lit path would let the sun's own exposure curve dim them. The values are HDR
 * (>1) so bloom picks them up; `render`'s tonemap turns them into a white core
 * with a coloured halo, which is what a burning magnesium flare looks like.
 */
export const IMPROVISED_EMISSIVE = {
  /* Flare composition burning — magnesium/strontium, blinding white-orange. */
  glow_flare: { color: [9.0, 3.4, 0.75], opacity: 1 },
  /* Electric arc — a spark gap runs blue-white and is brighter than anything. */
  glow_arc: { color: [3.2, 6.6, 14.0], opacity: 1 },
  /* Charged capacitor bank / coil idle — a dull cyan pulse. */
  glow_charge: { color: [0.5, 2.4, 3.4], opacity: 1 },
  /* Nitro bottle burner + rocket motor — deep orange with soot. */
  glow_burn: { color: [7.5, 2.1, 0.35], opacity: 1 },
  /* Pilot / power LED on the tool bodies — small, green, cheap. */
  glow_led: { color: [0.4, 3.0, 0.9], opacity: 1 },
};

export { BASE as IMPROVISED_BASE };
