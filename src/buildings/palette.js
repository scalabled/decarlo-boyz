/**
 * BUILDINGS — surfaces and district identity.
 *
 * `SURFACES` maps a building-kit surface key onto a name in the shared material
 * library plus the shader parameters that make it read as *that* material at
 * *that* scale. `DISTRICTS` is the content bible (DESIGN.md) turned into
 * generator inputs: which archetypes appear, which masonry, which paint, how
 * tall, how worn.
 *
 * The rule the whole file exists to serve: a player must know which district
 * they are in from a single frame.
 */

const V = (name, opts) => ({ name, opts });

/** Vertex masks are on for everything — the kit paints wear/grime/AO per vertex. */
const M = { vertexMasks: true };

/**
 * A painted, non-metallic finish. Semi-gloss, so it catches a highlight off a
 * low sun, with chipping that reveals dark primer rather than bright steel.
 */
const PAINT = (tint, scale = 1.1) =>
  V('plaster', {
    ...M,
    scale,
    tint,
    parallax: 0.004,
    detile: 0.5,
    patch: [0.22, 1.4, 0.1, -0.05],
    weather: [0.3, 0.45, 0.55, 0.4],
    wear: [0.3, 0.75, 0.55, 0],
    wearColor: 0x574f45,
    wearMaterial: [0.62, 0.0, 0, 0.55],
    // Satin, not gloss. At a 0.1 roughness floor a dark paint becomes a mirror
    // and returns the sky, which is how an entire painted shopfront ends up
    // reading as a pale grey-blue board whatever colour it is given.
    roughness: [0.88, -0.02, 0.34],
  });

/** Painted joinery — window frames, doors, fascia boards. Timber under it. */
const JOINERY = (tint, scale = 0.8) =>
  V('wood', {
    ...M,
    scale,
    tint,
    detail: [10, 0.55, 0.3, 14],
    weather: [0.3, 0.4, 0.5, 0.4],
    wear: [0.32, 0.7, 0.5, 0],
    wearColor: 0x6a5a44,
    wearMaterial: [0.6, 0.0, 0, 0.6],
    roughness: [0.86, -0.03, 0.3],
  });

export const SURFACES = {
  // ---------------------------------------------------------- masonry ------
  brick_red: V('brick', { ...M, scale: 1.35, tint: 0xd9917a, weather: [0.36, 0.42, 0.55, 0.42] }),
  brick_brown: V('brick', { ...M, scale: 1.35, tint: 0xb08570, weather: [0.4, 0.46, 0.6, 0.45] }),
  brick_buff: V('brick', { ...M, scale: 1.3, tint: 0xe0cba4, weather: [0.34, 0.4, 0.55, 0.4] }),
  brick_dark: V('brick', { ...M, scale: 1.4, tint: 0x8e6a58, weather: [0.44, 0.52, 0.65, 0.52] }),
  brick_painted: V('brick', {
    ...M,
    scale: 1.35,
    tint: 0xd2d0c6,
    patch: [0.4, 2.4, 0.16, -0.06],
    weather: [0.34, 0.42, 0.52, 0.38],
  }),

  stone_grey: V('concrete', { ...M, scale: 2.1, tint: 0xc6c1b5 }),
  stone_warm: V('concrete', { ...M, scale: 2.2, tint: 0xd6c8ab }),
  concrete_wall: V('concrete', { ...M, scale: 2.5, tint: 0xb8b7b1 }),
  concrete_dark: V('concrete', { ...M, scale: 2.6, tint: 0x8b8a86, weather: [0.4, 0.42, 0.55, 0.45] }),
  precast: V('concrete', { ...M, scale: 1.7, tint: 0xcbc6bb, patch: [0.2, 1.8, 0.1, -0.05] }),

  render_cream: V('plaster', { ...M, scale: 2.2, tint: 0xe2d7bb }),
  render_grey: V('plaster', { ...M, scale: 2.2, tint: 0xbab9b2 }),
  render_green: V('plaster', { ...M, scale: 2.2, tint: 0x8d9c8a }),
  render_blue: V('plaster', { ...M, scale: 2.2, tint: 0x8a99a6 }),
  render_ochre: V('plaster', { ...M, scale: 2.2, tint: 0xc0a068 }),
  render_rose: V('plaster', { ...M, scale: 2.2, tint: 0xc0968a }),

  // ---------------------------------------------------------- timber ------
  siding_white: V('wood', { ...M, scale: 0.9, tint: 0xeeead9, weather: [0.34, 0.4, 0.5, 0.38] }),
  siding_grey: V('wood', { ...M, scale: 0.9, tint: 0xb9c0be }),
  siding_green: V('wood', { ...M, scale: 0.9, tint: 0x9aae95 }),
  siding_yellow: V('wood', { ...M, scale: 0.9, tint: 0xe4cd8c }),
  siding_blue: V('wood', { ...M, scale: 0.9, tint: 0xa9bece }),
  siding_red: V('wood', { ...M, scale: 0.9, tint: 0xbe7c6c }),
  timber: V('wood', { ...M, scale: 1.4, tint: 0x8b7355 }),
  timber_dark: V('wood', { ...M, scale: 1.2, tint: 0x5a4638 }),

  // ----------------------------------------------------------- metal ------
  steel_dark: V('metal_painted', {
    ...M,
    scale: 1.2,
    tint: 0x59606a,
    wear: [0.4, 0.75, 0.5, 0],
    wearColor: 0x6e6a64,
    wearMaterial: [0.42, 1.0, 0, 0.6],
  }),
  steel_light: V('metal_painted', {
    ...M,
    scale: 1.2,
    tint: 0x9aa2ab,
    wear: [0.4, 0.75, 0.5, 0],
    wearColor: 0x7d7a74,
    wearMaterial: [0.42, 1.0, 0, 0.6],
  }),
  steel_green: V('metal_painted', {
    ...M,
    scale: 1.2,
    tint: 0x59695c,
    wear: [0.4, 0.75, 0.5, 0],
    wearColor: 0x6b6a60,
    wearMaterial: [0.42, 1.0, 0, 0.6],
  }),
  alu_bright: V('metal_brushed', { ...M, scale: 0.7, tint: 0x9aa0a6, roughness: [1.0, 0.06, 0.22] }),
  alu_dark: V('metal_brushed', { ...M, scale: 0.7, tint: 0x4a5058, roughness: [1.0, 0.1, 0.3] }),
  rust: V('metal_rust', { ...M, scale: 1.2 }),
  rust_deep: V('metal_rust', { ...M, scale: 1.5, tint: 0x9a6238 }),
  corrugated: V('corrugated', { ...M, scale: 2.4, tint: 0x9aa1a4 }),
  corrugated_rust: V('corrugated', { ...M, scale: 2.4, tint: 0xa0714c }),

  // ----------------------------------------------------------- roofs ------
  roof_tar: V('asphalt', { ...M, scale: 2.2, tint: 0x8b8781, weather: [0.55, 0.15, 0.1, 0.4] }),
  roof_gravel: V('gravel', { ...M, scale: 1.4, tint: 0xa8a294 }),
  roof_shingle: V('asphalt', { ...M, scale: 1.1, tint: 0x6d6866 }),
  roof_metal: V('corrugated', { ...M, scale: 1.6, tint: 0x969ba0 }),

  // ---------------------------------------------------------- glazing -----
  /**
   * Glass is deliberately NOT one material. A tower's curtain wall and a corner
   * store's window read completely differently, and the difference between them
   * is most of what tells the districts apart at 400 m.
   */
  /**
   * `roughness` here is the SHADER parameter [scale, offset, minimum] the
   * material extension applies over the baked ORM — setting `three.roughness`
   * instead is silently overwritten by it, which is how glass ends up looking
   * like matte grey plastic.
   */
  /**
   * TOWER GLAZING IS A DARK MATERIAL. This is the single value judgement the
   * whole downtown skyline rests on and it was inverted.
   *
   * These three used to run at envMapIntensity 1.3-1.5 over a light tint, which
   * makes a curtain wall return MORE light than the stone spandrels beside it.
   * The result is measurable in every wide capture: at golden hour the glazing
   * bands came back the same tan as the masonry and the tower flattened into a
   * single slab; at midday they came back white and the tower read as a
   * barcode. Either way the window grid stops describing depth, and the critic
   * verdict — "flat curtain-wall boxes, a single flat plane with horizontal
   * banding" — follows directly from it.
   *
   * A real pane reflects ~4% at normal incidence and transmits the rest into a
   * room that is always darker than a sunlit facade. It only goes bright at
   * grazing angles, and that Fresnel ramp is what makes a glass tower turn to
   * fire along one edge at sunset while its face stays dark. Tint DOWN, env
   * DOWN, opacity UP a little so the pane still owns its own colour.
   */
  glass_sky: V('glass', {
    ...M,
    scale: 2.4,
    tint: 0x4d6076,
    roughness: [0.5, -0.04, 0.05],
    three: { opacity: 0.55, envMapIntensity: 0.85, metalness: 0 },
  }),
  glass_green: V('glass', {
    ...M,
    scale: 2.4,
    tint: 0x44614f,
    roughness: [0.52, -0.04, 0.055],
    three: { opacity: 0.56, envMapIntensity: 0.8 },
  }),
  glass_bronze: V('glass', {
    ...M,
    scale: 2.4,
    tint: 0x64513a,
    roughness: [0.55, -0.03, 0.06],
    three: { opacity: 0.58, envMapIntensity: 0.78 },
  }),
  /**
   * The street-level pane, and the reason it is no longer nearly invisible.
   *
   * `transparent` + `opacity` in three scales the WHOLE fragment, specular
   * included — so an opacity of 0.22 was multiplying the pane's sky reflection
   * down to a fifth before it ever reached the frame buffer. What was left was
   * the dark room box behind the glass and nothing else, which is why a
   * magnified rowhouse elevation showed a stone sill, a stone lintel and, in
   * between them, a flat black rectangle: exactly the "windows are painted on,
   * no reveal depth" finding. There is a real modelled room behind every one of
   * these, so the pane does not need to be that transparent to show an
   * interior — it needs to be reflective enough to be glass.
   */
  glass_plain: V('glass', {
    ...M,
    scale: 1.6,
    tint: 0x9fadb4,
    roughness: [0.62, -0.02, 0.07],
    three: { opacity: 0.52, envMapIntensity: 1.45 },
  }),
  glass_grimy: V('glass', {
    ...M,
    scale: 1.6,
    tint: 0x848a80,
    roughness: [1.0, 0.04, 0.2],
    weather: [0.35, 0.55, 0.6, 0.5],
    three: { opacity: 0.55, envMapIntensity: 0.9 },
  }),
  /**
   * The far-LOD stand-in: opaque, so the skyline costs no sorting.
   *
   * A DIELECTRIC, and that is the whole point of it.
   *
   * This used to be `metal_brushed`, which bakes metalness 1 and therefore
   * resolves to a mirror that returns the sky at every angle. The consequence
   * was visible in every wide shot and nobody traced it to the material: a
   * distant tower's window bands came out BRIGHTER than the stone between them
   * — white against blue-grey at midday in `hero`, tan against tan at golden
   * hour in `skyline`. That is the exact inverse of a real curtain wall, where
   * the glass is the DARK field and the spandrels are the light one, and it is
   * why the towers were read as "a single flat plane with horizontal banding".
   * Inverting the value of the window grid destroys the read of depth no matter
   * how much geometry is behind it.
   *
   * Glass at normal incidence reflects ~4% and transmits the rest into a dark
   * room, so its far-field value is nearly its interior's: dark. The sky only
   * comes back at grazing angles, through Fresnel, which is what gives a real
   * tower its bright edge at dusk and its dark face at noon. A dark, smooth
   * dielectric reproduces both for free.
   */
  glass_solid: V('tile', {
    ...M,
    scale: 3.4,
    tint: 0x1a2027,
    weather: [0.12, 0.14, 0.3, 0.22],
    /**
     * ROUGHNESS, not tint, is what makes a far window field dark.
     *
     * At a 0.07 roughness floor the pane is a near-mirror, and under a low warm
     * sun the specular lobe swamps the albedo completely: darkening the tint
     * from 0x2b333c to 0x1a2027 changed the rendered value by under one unit,
     * because almost none of what reached the frame buffer was albedo. A real
     * curtain wall at 200 m is not one mirror either — it is a hundred panes at
     * slightly different angles with slightly different reflectance, and that
     * ensemble integrates to a broad, dim lobe. Spreading the highlight is the
     * physically honest way to get there and it costs nothing.
     */
    roughness: [0.7, 0.06, 0.26],
    three: { envMapIntensity: 0.8, metalness: 0 },
  }),
  /** The warm half of the same idea, for bronze- and green-glazed towers. */
  glass_solid_warm: V('tile', {
    ...M,
    scale: 3.4,
    tint: 0x241f18,
    weather: [0.12, 0.14, 0.3, 0.22],
    roughness: [0.72, 0.07, 0.28],
    three: { envMapIntensity: 0.75, metalness: 0 },
  }),

  /**
   * The impostor tier's own three surfaces.
   *
   * Same hues as the streamed city, so a block does not change colour when it
   * crosses the LOD boundary — but the weathering streaks and the wear breakup
   * are turned right down and the texture scale is opened out four-fold. A
   * skyline block is 60-70 m across and 0.5-1.5 km away, so a map authored for
   * a 3 m wall face repeats several hundred times inside one silhouette and
   * lands far below a pixel. That is what shredded every mid-distance elevation
   * in the `skyline` capture into a torn, dithered, dripping mess: not
   * z-fighting, not shadow acne — an aliasing map running at a thousandth of
   * the frequency the eye can resolve at that range.
   */
  sky_concrete: V('concrete', {
    ...M,
    scale: 11,
    tint: 0x8b8a86,
    weather: [0.1, 0.12, 0.28, 0.18],
  }),
  sky_brick: V('brick', {
    ...M,
    scale: 6.5,
    tint: 0x8e6a58,
    weather: [0.12, 0.14, 0.3, 0.2],
  }),
  sky_glass: V('metal_brushed', {
    ...M,
    scale: 8,
    tint: 0x3a4854,
    roughness: [0.8, 0.0, 0.1],
  }),

  /**
   * What is behind the glass. A dark box is not enough on its own — a real room
   * has a lit ceiling plane, a floor a stop darker and a back wall darker still,
   * and the eye reads those three values as depth even at 40 m.
   */
  room_dark: V('plaster', { ...M, scale: 1.4, tint: 0x4a463e, weather: [0.2, 0, 0, 0.55] }),
  room_mid: V('plaster', { ...M, scale: 1.4, tint: 0x7d7466, weather: [0.2, 0, 0, 0.4] }),
  room_office: V('plaster', { ...M, scale: 1.4, tint: 0x8e8f8a, weather: [0.15, 0, 0, 0.32] }),
  /**
   * A lit room. Emissive rather than a real light: a night skyline needs tens
   * of thousands of lit windows and `q.lightSlots` is eight. The intensity is
   * driven off the solar altitude in BuildingSystem.update(), so these are a
   * faint interior practical by day and the whole look of the city after dark.
   */
  room_lit_warm: V('plaster', {
    ...M,
    scale: 1.4,
    tint: 0xa8967a,
    weather: [0.15, 0, 0, 0.35],
    three: { emissive: 0xffb265, emissiveIntensity: 0.35 },
  }),
  room_lit_cool: V('plaster', {
    ...M,
    scale: 1.4,
    tint: 0x8e9096,
    weather: [0.15, 0, 0, 0.3],
    three: { emissive: 0xcfe0ff, emissiveIntensity: 0.3 },
  }),
  blind: V('fabric', { ...M, scale: 0.9, tint: 0x8f8776 }),
  rubber: V('rubber', { ...M, scale: 0.45 }),
  tile: V('tile', { ...M, scale: 1.5, tint: 0xa9a49a }),

  // ------------------------------------------------------------ trim ------
  trim_white: PAINT(0xd8d2c2, 1.0),
  trim_dark: JOINERY(0x53585c),
  trim_green: JOINERY(0x3f5445),
  trim_red: JOINERY(0x8a3b32),
  awning_canvas: V('fabric', { ...M, scale: 0.7, tint: 0x7a3f30 }),
  awning_green: V('fabric', { ...M, scale: 0.7, tint: 0x35583f }),
  awning_navy: V('fabric', { ...M, scale: 0.7, tint: 0x33445e }),
  shutter: V('corrugated', { ...M, scale: 0.55, tint: 0x8e8f8a }),
  door_wood: V('wood', { ...M, scale: 0.7, tint: 0x6a4a34 }),
  door_paint: JOINERY(0x2f4a3c, 0.6),

  /**
   * Shopfront paint. A high street reads as a high street because every unit
   * picked its own colour and none of them are the colour of the building
   * above. Deliberately saturated against the rustbelt grey-brown base.
   */
  /**
   * Shopfront paint. A high street reads as a high street because every unit
   * picked its own colour and none of them are the colour of the building
   * above. Deliberately saturated against the rustbelt grey-brown base.
   *
   * Based on PLASTER, not metal_painted. `metal_painted` bakes a metallic ORM,
   * so anything using it resolves to a mirror and returns whatever the sky is
   * — which turns an entire painted shopfront into a pale grey-blue board no
   * matter what tint it is given. Paint on render or timber is a dielectric.
   */
  paint_red: PAINT(0x7d2a1e),
  paint_green: PAINT(0x22422f),
  paint_blue: PAINT(0x213954),
  paint_teal: PAINT(0x1a534f),
  paint_cream: PAINT(0xb0a07c),
  paint_black: PAINT(0x232426),
  paint_ochre: PAINT(0x8c651f),
  paint_slag: PAINT(0x8a3a14),

  // --------------------------------------------------------- signage ------
  sign_board: JOINERY(0x6a5a4a, 1.1),
  neon_amber: V('metal_painted', {
    ...M,
    scale: 0.6,
    tint: 0xffb765,
    three: { emissive: 0xff9c3c, emissiveIntensity: 2.4 },
  }),
  neon_teal: V('metal_painted', {
    ...M,
    scale: 0.6,
    tint: 0x7bf0d8,
    three: { emissive: 0x2ea6a0, emissiveIntensity: 2.2 },
  }),
  neon_red: V('metal_painted', {
    ...M,
    scale: 0.6,
    tint: 0xff7a5a,
    three: { emissive: 0xd8321e, emissiveIntensity: 2.2 },
  }),

  // -------------------------------------------------------- interiors -----
  floor_board: V('wood', { ...M, scale: 1.6, tint: 0x7a5c40 }),
  floor_tile: V('tile', { ...M, scale: 1.5, tint: 0xa9a49a }),
  wall_inner: V('plaster', { ...M, scale: 2.0, tint: 0xb2a894 }),
};

export const SURFACE_TAG = {
  brick_red: 'concrete',
  brick_brown: 'concrete',
  brick_buff: 'concrete',
  brick_dark: 'concrete',
  brick_painted: 'concrete',
  stone_grey: 'concrete',
  stone_warm: 'concrete',
  concrete_wall: 'concrete',
  concrete_dark: 'concrete',
  sky_concrete: 'concrete',
  sky_brick: 'concrete',
  sky_glass: 'glass',
  precast: 'concrete',
  render_cream: 'plaster',
  render_grey: 'plaster',
  render_green: 'plaster',
  render_blue: 'plaster',
  render_ochre: 'plaster',
  render_rose: 'plaster',
  siding_white: 'wood',
  siding_grey: 'wood',
  siding_green: 'wood',
  siding_yellow: 'wood',
  siding_blue: 'wood',
  siding_red: 'wood',
  timber: 'wood',
  timber_dark: 'wood',
  steel_dark: 'metal',
  steel_light: 'metal',
  steel_green: 'metal',
  alu_bright: 'metal',
  alu_dark: 'metal',
  rust: 'metal',
  rust_deep: 'metal',
  corrugated: 'metal',
  corrugated_rust: 'metal',
  roof_tar: 'concrete',
  roof_gravel: 'gravel',
  roof_shingle: 'concrete',
  roof_metal: 'metal',
  glass_sky: 'glass',
  glass_green: 'glass',
  glass_bronze: 'glass',
  glass_plain: 'glass',
  glass_grimy: 'glass',
  glass_solid: 'glass',
  glass_solid_warm: 'glass',
  shutter: 'metal',
  door_wood: 'wood',
  door_paint: 'metal',
};

export const surfaceTagOf = (key) => SURFACE_TAG[key] ?? 'concrete';

/** Keys that must draw in the transparent pass and stay out of the prepass. */
export const TRANSPARENT = new Set([
  'glass_sky',
  'glass_green',
  'glass_bronze',
  'glass_plain',
  'glass_grimy',
]);

export const EMISSIVE = new Set(['neon_amber', 'neon_teal', 'neon_red']);

// =========================================================== districts =====
/**
 * Per DESIGN.md. `tall` and `tint` come straight from the district table; the
 * rest is the visual programme that makes each one legible.
 *
 * archetypes  weighted list the lot `kind` is resolved against
 * masonry     the body of the building
 * accents     paint/render used for a minority of buildings and for trim
 * roof        flat-roof surfaces in this district
 * age         0 fresh .. 1 derelict; drives grime, boarded windows, wear
 * clutter     0..1 how much roof and facade furniture is placed
 */
export const DISTRICTS = {
  point: {
    name: 'THE POINT',
    tall: 0.1,
    tint: [0.3, 0.36, 0.3],
    archetypes: { pavilion: 3, block: 1 },
    masonry: ['stone_grey', 'concrete_wall'],
    accents: ['render_cream', 'trim_white'],
    roof: ['roof_tar'],
    glass: ['glass_plain'],
    age: 0.2,
    clutter: 0.25,
  },
  downtown: {
    name: 'GOLDEN TRIANGLE',
    tall: 1.0,
    tint: [0.36, 0.38, 0.44],
    archetypes: { tower: 6, curtain: 5, deco: 3, block: 2 },
    masonry: ['stone_grey', 'concrete_dark', 'precast', 'stone_warm'],
    accents: ['steel_dark', 'alu_dark', 'trim_dark'],
    roof: ['roof_tar', 'roof_gravel'],
    glass: ['glass_sky', 'glass_green', 'glass_bronze'],
    age: 0.25,
    clutter: 0.8,
  },
  strip: {
    name: 'THE STRIP',
    tall: 0.55,
    tint: [0.42, 0.34, 0.28],
    archetypes: { warehouse: 4, rowhouse: 3, block: 3, market: 2 },
    masonry: ['brick_red', 'brick_brown', 'brick_painted', 'concrete_wall'],
    accents: ['render_ochre', 'trim_red', 'steel_green'],
    roof: ['roof_tar', 'roof_gravel'],
    glass: ['glass_plain', 'glass_grimy'],
    age: 0.6,
    clutter: 0.95,
  },
  lawren: {
    name: 'LAWRENCEVILLE',
    tall: 0.42,
    tint: [0.4, 0.33, 0.3],
    archetypes: { rowhouse: 8, block: 2, warehouse: 1 },
    masonry: ['brick_red', 'brick_brown', 'brick_dark'],
    accents: ['render_cream', 'trim_green'],
    roof: ['roof_tar', 'roof_shingle'],
    glass: ['glass_plain'],
    age: 0.55,
    clutter: 0.85,
  },
  northsh: {
    name: 'NORTH SHORE',
    tall: 0.5,
    tint: [0.31, 0.36, 0.4],
    archetypes: { block: 4, curtain: 2, warehouse: 2, pavilion: 1 },
    masonry: ['precast', 'concrete_wall', 'brick_buff'],
    accents: ['steel_light', 'alu_bright', 'render_blue'],
    roof: ['roof_tar', 'roof_metal'],
    glass: ['glass_sky', 'glass_plain'],
    age: 0.3,
    clutter: 0.5,
  },
  troy: {
    name: 'TROY HILL',
    tall: 0.3,
    tint: [0.34, 0.38, 0.32],
    archetypes: { house: 6, rowhouse: 3, block: 1 },
    masonry: ['siding_white', 'siding_yellow', 'brick_red', 'siding_green'],
    accents: ['trim_white', 'siding_grey', 'render_cream'],
    roof: ['roof_shingle'],
    glass: ['glass_plain'],
    age: 0.5,
    clutter: 0.5,
  },
  southside: {
    name: 'SOUTH SIDE',
    tall: 0.45,
    tint: [0.4, 0.35, 0.3],
    archetypes: { warehouse: 5, rowhouse: 3, mill: 2, block: 1 },
    masonry: ['brick_dark', 'brick_brown', 'corrugated', 'concrete_wall'],
    accents: ['rust', 'steel_green', 'brick_painted'],
    roof: ['roof_metal', 'roof_tar'],
    glass: ['glass_grimy', 'glass_plain'],
    age: 0.72,
    clutter: 0.9,
  },
  mtwash: {
    name: 'MT. WASHINGTON',
    tall: 0.28,
    tint: [0.33, 0.37, 0.33],
    archetypes: { house: 8, rowhouse: 2 },
    masonry: ['siding_white', 'siding_blue', 'siding_yellow', 'siding_red'],
    accents: ['trim_white', 'brick_red', 'siding_grey'],
    roof: ['roof_shingle'],
    glass: ['glass_plain'],
    age: 0.45,
    clutter: 0.45,
  },
  steelrow: {
    name: 'STEEL ROW',
    tall: 0.62,
    tint: [0.44, 0.32, 0.26],
    archetypes: { mill: 6, warehouse: 4, block: 1 },
    masonry: ['corrugated_rust', 'brick_dark', 'rust', 'concrete_dark'],
    accents: ['rust_deep', 'steel_dark', 'corrugated'],
    roof: ['roof_metal'],
    glass: ['glass_grimy'],
    age: 0.9,
    clutter: 1.0,
  },
  westend: {
    name: 'WEST END',
    tall: 0.3,
    tint: [0.35, 0.36, 0.33],
    archetypes: { house: 5, rowhouse: 3, warehouse: 1, block: 1 },
    masonry: ['brick_brown', 'siding_grey', 'render_grey', 'brick_red'],
    accents: ['siding_white', 'trim_dark', 'render_rose'],
    roof: ['roof_shingle', 'roof_tar'],
    glass: ['glass_plain'],
    age: 0.6,
    clutter: 0.6,
  },
  northside: {
    name: 'MANCHESTER',
    tall: 0.32,
    tint: [0.34, 0.35, 0.38],
    archetypes: { rowhouse: 6, house: 3, block: 1 },
    masonry: ['brick_red', 'brick_buff', 'brick_painted'],
    accents: ['render_cream', 'trim_white', 'stone_warm'],
    roof: ['roof_shingle', 'roof_tar'],
    glass: ['glass_plain'],
    age: 0.5,
    clutter: 0.6,
  },
  hazel: {
    name: 'HAZELWOOD',
    tall: 0.36,
    tint: [0.4, 0.34, 0.28],
    archetypes: { rowhouse: 4, house: 3, warehouse: 3, mill: 1 },
    masonry: ['brick_brown', 'brick_dark', 'siding_grey', 'corrugated_rust'],
    accents: ['rust', 'render_grey', 'brick_painted'],
    roof: ['roof_tar', 'roof_shingle'],
    glass: ['glass_grimy', 'glass_plain'],
    age: 0.75,
    clutter: 0.8,
  },
};

export const DEFAULT_DISTRICT = DISTRICTS.lawren;

export function districtStyle(id) {
  if (!id) return DEFAULT_DISTRICT;
  return DISTRICTS[id] ?? DISTRICTS[String(id).toLowerCase()] ?? DEFAULT_DISTRICT;
}

/** Weighted pick from an { key: weight } table. */
export function weightedPick(rng, table) {
  let total = 0;
  for (const k in table) total += table[k];
  let r = rng.float() * total;
  for (const k in table) {
    r -= table[k];
    if (r <= 0) return k;
  }
  return Object.keys(table)[0];
}

/**
 * Which archetype a lot becomes. The lot `kind` from `world` is authoritative
 * where it is specific; where it is generic ('block', 'lot') the district's own
 * weighting decides, which is what keeps a street varied.
 */
export function archetypeFor(rng, kind, style) {
  switch (kind) {
    case 'tower':
      return rng.float() < 0.55 ? 'curtain' : rng.float() < 0.5 ? 'tower' : 'deco';
    case 'house':
      return style.archetypes.house ? 'house' : 'rowhouse';
    case 'shop':
      return style.archetypes.rowhouse ? 'rowhouse' : 'block';
    case 'industrial':
      return rng.float() < 0.5 && style.archetypes.mill ? 'mill' : 'warehouse';
    case 'block':
    case 'lot':
    default:
      return weightedPick(rng, style.archetypes);
  }
}
