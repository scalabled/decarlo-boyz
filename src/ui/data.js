/**
 * ===========================================================================
 * STEEL CITY — the HUD's own copy of the world's atlas
 * ===========================================================================
 *
 * The map, the character wheel, the weapon wheel and the radio all need to name
 * places and things. `ui` may not import `src/world/plan.js` (hard rule 1/2), so
 * the tables DESIGN.md declares are mirrored here, already at WORLD scale
 * (map units x4). Everything is frozen, flat and allocation-free to read.
 *
 * When the `world` subsystem is up we prefer *its* answers — `world.roads`,
 * `world.districtAt()` — and these tables become the labels and the fallback,
 * so a capture taken before the city has streamed still shows a real map of
 * Steel City rather than an empty plate.
 */

/** Map-table units -> world metres. */
export const K = 4;
export const CITY_SIZE = 3000;
export const HALF_CITY = CITY_SIZE / 2;

/* ------------------------------------------------------------- the boyz -- */

/**
 * Each brother carries a `title`, a `tagline` and an `intro` line as well as his
 * stats, because the boot flow (`src/ui/boot.js`) shows a per-character card in
 * his own colour before the world appears. The copy lives in the game def and
 * the screen is a dumb reader of it.
 */
export const BOYZ = [
  {
    id: 'carson',
    name: 'CARSON',
    title: "CARSON'S CREW",
    role: 'River hand · eldest',
    turf: 'SOUTH SIDE / THE WATER',
    home: "Carson's Boathouse",
    rival: 'THE HARBORMASTER',
    colour: '#2ea6a0',
    accent: '#7bf0d8',
    hp: 130,
    armour: 60,
    blurb: 'Knows every current, slip and sunken barge on three rivers.',
    tagline: 'The river remembers everything.',
    intro: 'Eldest. Slowest. Hardest to put down. Carson works the South Side '
      + 'wharves, and the Harbormaster has been taxing every load off them for '
      + 'nine years. That stops this season.',
    stats: [['SPEED', 0.62], ['TOUGH', 0.92], ['DRIVE', 0.68], ['AIM', 0.74]],
    weapons: ['fists', 'pipe', 'flare', 'speargun', 'harpoon', 'depth'],
    radio: ['slack', 'gold', 'furnace', 'incline'],
    body: { skin: '#f0cdae', shirt: '#1f6f6a', pants: '#26303c', hair: '#3b2a1c' },
  },
  {
    id: 'aidan',
    name: 'AIDAN',
    title: "AIDAN'S WORLD",
    role: 'Body man · middle',
    turf: 'LAWRENCEVILLE / BUTLER ST',
    home: 'DeCarlo Body Shop',
    rival: 'DUKE MARROW',
    colour: '#ff6a12',
    accent: '#ffc93c',
    hp: 115,
    armour: 75,
    blurb: 'Straightens metal for a living and people for free.',
    tagline: 'Everything bent can be beaten straight.',
    intro: 'The middle brother and the best all-rounder of the three. Aidan '
      + 'runs the family body shop on Butler Street. Duke Marrow wants the '
      + 'block, the lease and the name over the door.',
    stats: [['SPEED', 0.74], ['TOUGH', 0.78], ['DRIVE', 0.86], ['AIM', 0.8]],
    weapons: ['fists', 'wrench', 'nailgun', 'sprayer', 'rivetgun', 'launcher'],
    radio: ['grease', 'gold', 'redline', 'furnace'],
    body: { skin: '#f4d4b6', shirt: '#c2410c', pants: '#1f2733', hair: '#8a5a2a' },
  },
  {
    id: 'dylan',
    name: 'DYLAN',
    title: "DYLAN'S RUN",
    role: 'Courier · youngest',
    turf: 'MT. WASHINGTON / THE HILL',
    home: "Dylan's Garage",
    rival: 'VIPER LANE',
    colour: '#c07cff',
    accent: '#5fd0ff',
    hp: 100,
    armour: 55,
    blurb: 'Knows every shortcut, including the ones that are not roads.',
    tagline: 'Down the hill, and never the long way.',
    intro: 'Youngest, fastest, and the easiest to break. Dylan couriers off the '
      + 'Mt. Washington ridge on anything with wheels. Viper Lane owns the '
      + 'inclines and has never once been caught.',
    stats: [['SPEED', 0.94], ['TOUGH', 0.6], ['DRIVE', 0.98], ['AIM', 0.66]],
    weapons: ['fists', 'crowbar', 'tackgun', 'emp', 'smg', 'rocket'],
    radio: ['redline', 'furnace', 'grease', 'slack'],
    body: { skin: '#eec9a8', shirt: '#7c3aed', pants: '#1a1f2b', hair: '#221812' },
  },
];

export const BOY_BY_ID = Object.fromEntries(BOYZ.map((b) => [b.id, b]));

/* ------------------------------------------------------------- weapons --- */

/**
 * The improvised arsenal. `slot` groups the weapon wheel:
 * 0 melee · 1 light · 2 precise · 3 heavy · 4 explosive · 5 special.
 * `glyph` is drawn by `weaponGlyph()` in weapon.js — no image assets exist.
 */
export const WEAPONS = {
  fists: { name: 'FISTS', slot: 0, glyph: 'fist', mag: 0, melee: true, dmg: 14 },
  pipe: { name: 'DOCK PIPE', slot: 0, glyph: 'bar', mag: 0, melee: true, dmg: 28 },
  wrench: { name: 'BODY WRENCH', slot: 0, glyph: 'wrench', mag: 0, melee: true, dmg: 30 },
  crowbar: { name: 'CROWBAR', slot: 0, glyph: 'crow', mag: 0, melee: true, dmg: 26 },

  nailgun: { name: 'NAIL GUN', slot: 1, glyph: 'pistol', mag: 30, ammo: 90, dmg: 20 },
  tackgun: { name: 'TACK CANNON', slot: 1, glyph: 'pistol', mag: 40, ammo: 140, dmg: 18 },
  sprayer: { name: 'PAINT CANNON', slot: 1, glyph: 'shotgun', mag: 8, ammo: 60, dmg: 15 },
  smg: { name: 'SHOP SMG', slot: 1, glyph: 'smg', mag: 40, ammo: 260, dmg: 16 },

  flare: { name: 'FLARE GUN', slot: 2, glyph: 'flare', mag: 1, ammo: 40, dmg: 46 },
  speargun: { name: 'SPEAR GUN', slot: 2, glyph: 'spear', mag: 1, ammo: 30, dmg: 62 },
  rivetgun: { name: 'RIVET GUN', slot: 2, glyph: 'rifle', mag: 24, ammo: 120, dmg: 40 },
  harpoon: { name: 'HARPOON', slot: 2, glyph: 'spear', mag: 1, ammo: 22, dmg: 90 },

  launcher: { name: 'NITRO LAUNCHER', slot: 3, glyph: 'tube', mag: 1, ammo: 8, dmg: 180 },
  depth: { name: 'DEPTH CHARGE', slot: 3, glyph: 'drum', mag: 1, ammo: 8, dmg: 190 },
  rocket: { name: 'SCRAP ROCKET', slot: 3, glyph: 'tube', mag: 1, ammo: 7, dmg: 200 },
  emp: { name: 'EMP COIL', slot: 3, glyph: 'coil', mag: 1, ammo: 44, dmg: 34 },
};

/* --------------------------------------------------------------- radio --- */

export const STATIONS = [
  { id: 'grease', name: 'GREASE FM', genre: 'GARAGE ROCK', freq: '96.1', bpm: 118, colour: '#ff6a12' },
  { id: 'gold', name: 'BLACK & GOLD', genre: 'SOUL', freq: '101.7', bpm: 92, colour: '#ffc93c' },
  { id: 'redline', name: 'REDLINE', genre: 'DRUM MACHINE', freq: '88.3', bpm: 146, colour: '#ff3b4e' },
  { id: 'slack', name: 'SLACKWATER', genre: 'AMBIENT', freq: '104.9', bpm: 68, colour: '#2ea6a0' },
  { id: 'furnace', name: 'FURNACE 101', genre: 'INDUSTRIAL', freq: '101.1', bpm: 132, colour: '#ffb03a' },
  { id: 'incline', name: 'INCLINE AM', genre: 'OLD COUNTRY', freq: 'AM 1320', bpm: 84, colour: '#c07cff' },
];

/* ----------------------------------------------------------- geography --- */

/** Three rivers. `pts` are world metres; `width` is the channel width. */
export const RIVERS = [
  {
    id: 'allegheny',
    name: 'ALLEGHENY',
    width: 144,
    pts: [1320, -1360, 912, -1008, 600, -784, 264, -544, -64, -328, -352, -160, -464, -72, -600, 40],
  },
  {
    id: 'monongahela',
    name: 'MONONGAHELA',
    width: 136,
    pts: [1360, 1320, 944, 928, 624, 728, 296, 528, -32, 344, -336, 184, -452, 148, -600, 40],
  },
  {
    id: 'ohio',
    name: 'OHIO',
    width: 184,
    pts: [-600, 40, -856, -96, -1072, -272, -1344, -496, -1560, -620],
  },
];

export const DISTRICTS = [
  { id: 'point', name: 'THE POINT', x: -672, z: 16, r: 248, tint: '#39442f' },
  { id: 'downtown', name: 'GOLDEN TRIANGLE', x: -232, z: 64, r: 400, tint: '#3c4356' },
  { id: 'strip', name: 'THE STRIP', x: 248, z: -184, r: 344, tint: '#4a3a2e' },
  { id: 'lawren', name: 'LAWRENCEVILLE', x: 680, z: -552, r: 384, tint: '#463830' },
  { id: 'northsh', name: 'NORTH SHORE', x: -160, z: -600, r: 416, tint: '#333f49' },
  { id: 'troy', name: 'TROY HILL', x: 520, z: -1032, r: 360, tint: '#374133' },
  { id: 'southside', name: 'SOUTH SIDE', x: 160, z: 608, r: 432, tint: '#463c30' },
  { id: 'mtwash', name: 'MT. WASHINGTON', x: -528, z: 464, r: 368, tint: '#364035' },
  { id: 'steelrow', name: 'STEEL ROW', x: 784, z: 384, r: 400, tint: '#4e3529' },
  { id: 'westend', name: 'WEST END', x: -1032, z: 368, r: 384, tint: '#3a3d35' },
  { id: 'northside', name: 'MANCHESTER', x: -984, z: -568, r: 368, tint: '#383a41' },
  { id: 'hazel', name: 'HAZELWOOD', x: 984, z: -56, r: 344, tint: '#463a2e' },
];

export const LANDMARKS = [
  { id: 'lm_point', name: 'THE POINT FOUNTAIN', x: -452, z: 46, kind: 'fountain' },
  { id: 'lm_incline', name: 'DUQUESNE INCLINE', x: -488, z: 296, kind: 'incline' },
  { id: 'lm_stadium', name: 'STEEL BOWL', x: -416, z: -512, kind: 'stadium' },
  { id: 'lm_mill', name: 'OLD BLAST FURNACE', x: 872, z: 248, kind: 'mill' },
  { id: 'lm_tower', name: 'STEEL TOWER', x: -208, z: -16, kind: 'tower' },
  { id: 'lm_market', name: 'STRIP MARKET', x: 352, z: -224, kind: 'market' },
];

export const SAFEHOUSES = [
  { id: 'sh_boathouse', name: "CARSON'S BOATHOUSE", x: 88, z: 560, owner: 'carson' },
  { id: 'sh_bodyshop', name: 'DECARLO BODY SHOP', x: 632, z: -464, owner: 'aidan' },
  { id: 'sh_garage', name: "DYLAN'S GARAGE", x: -504, z: 432, owner: 'dylan' },
  { id: 'sh_apartment', name: 'TRIANGLE APARTMENT', x: -264, z: 96, owner: null },
  { id: 'sh_loft', name: 'SHORE LOFT', x: -192, z: -672, owner: null },
];

export const SHOPS = [
  { id: 'shop_spray', name: 'RUSTBELT RESPRAY', x: -336, z: 176, kind: 'spray' },
  { id: 'shop_ammo', name: 'FOUNDRY SUPPLY', x: 384, z: -280, kind: 'ammo' },
  { id: 'shop_ammo2', name: 'ROW HARDWARE', x: 816, z: 464, kind: 'ammo' },
  { id: 'shop_food', name: "PRIMO'S SANDWICH", x: -120, z: 24, kind: 'food' },
  { id: 'shop_food2', name: 'INCLINE DINER', x: -560, z: 504, kind: 'food' },
];

export const GAS = [
  { id: 'gas_strip', name: 'STRIP FUEL', x: 256, z: -72 },
  { id: 'gas_south', name: 'CARSON ST GAS', x: 144, z: 528 },
  { id: 'gas_west', name: 'WEST END PUMPS', x: -952, z: 304 },
  { id: 'gas_north', name: 'SHORE SERVICE', x: -184, z: -544 },
  { id: 'gas_row', name: 'STEEL ROW FUEL', x: 760, z: 328 },
  { id: 'gas_law', name: 'BUTLER ST GAS', x: 696, z: -512 },
];

export const DOCKS = [
  { id: 'dk_south', name: 'SOUTH SIDE DOCKS', x: -88, z: 280 },
  { id: 'dk_north', name: 'NORTH SHORE SLIP', x: -24, z: -264 },
  { id: 'dk_point', name: 'POINT MARINA', x: -744, z: -88 },
];

export const AIRFIELDS = [
  { id: 'af_county', name: 'ALLEGHENY COUNTY AIRFIELD', x: -1072, z: 784, runway: [600, 88], yaw: 0.3 },
  { id: 'af_rivers', name: 'RIVERS FIELD', x: 1032, z: -784, runway: [512, 80], yaw: -0.42 },
];

/** The pin sits on the MAIN GATE — the rest of the base is behind the wire. */
export const MILITARY = [
  { id: 'ab_ridge', name: 'RIDGELINE AFB', x: -321, z: -1166 },
];

/** The map's chokepoints — police close these first. */
export const BRIDGES = [
  { id: 'br_fortduq', name: 'FORT DUQUESNE BRIDGE', a: [-405, -35], b: [-520, -370], kind: 'highway' },
  { id: 'br_sixth', name: 'SIXTH STREET BRIDGE', a: [-150, -20], b: [-235, -330], kind: 'arterial' },
  { id: 'br_ninth', name: 'NINTH STREET BRIDGE', a: [70, -140], b: [-15, -450], kind: 'arterial' },
  { id: 'br_16th', name: 'SIXTEENTH STREET BRIDGE', a: [352, -352], b: [268, -652], kind: 'arterial' },
  { id: 'br_31st', name: 'THIRTY-FIRST ST BRIDGE', a: [648, -596], b: [560, -900], kind: 'arterial' },
  { id: 'br_fortpitt', name: 'FORT PITT BRIDGE', a: [-372, 116], b: [-500, 392], kind: 'highway' },
  { id: 'br_smithfield', name: 'SMITHFIELD ST BRIDGE', a: [-96, 268], b: [-176, 552], kind: 'arterial' },
  { id: 'br_birmingham', name: 'BIRMINGHAM BRIDGE', a: [268, 436], b: [188, 724], kind: 'arterial' },
  { id: 'br_hotmetal', name: 'HOT METAL BRIDGE', a: [596, 620], b: [512, 900], kind: 'street' },
  { id: 'br_westend', name: 'WEST END BRIDGE', a: [-856, -296], b: [-944, 16], kind: 'arterial' },
  { id: 'br_mckees', name: 'MCKEES ROCKS BRIDGE', a: [-1204, -520], b: [-1296, -172], kind: 'arterial' },
];

/** Twelve hidden packages, at world scale (map units x4). */
export const PACKAGES = [
  { id: 'pk1', x: -720, z: 160 }, { id: 'pk2', x: 432, z: -384 },
  { id: 'pk3', x: -56, z: 712 }, { id: 'pk4', x: 944, z: 512 },
  { id: 'pk5', x: -1144, z: -432 }, { id: 'pk6', x: 704, z: -864 },
  { id: 'pk7', x: -400, z: -800 }, { id: 'pk8', x: 1072, z: 96 },
  { id: 'pk9', x: -1200, z: 592 }, { id: 'pk10', x: 80, z: -928 },
  { id: 'pk11', x: -744, z: 704 }, { id: 'pk12', x: 488, z: 832 },
];

/** Race circuits, world metres. */
export const RACES = {
  triangle: { name: 'TRIANGLE CIRCUIT', pts: [-224, 208, 96, 104, 312, -120, 32, -248, -368, -152, -552, 96] },
  riverloop: { name: 'RIVER LOOP', pts: [480, 240, 784, 416, 920, 128, 680, -160, 384, -32] },
  southrun: { name: 'SOUTH RUN', pts: [-160, 480, 176, 632, 528, 720, 312, 448, -16, 384] },
};

/* -------------------------------------------------------------- lookup --- */

/** Nearest district to a world point. Never allocates. */
export function districtAt(x, z) {
  let best = DISTRICTS[0];
  let bd = Infinity;
  for (let i = 0; i < DISTRICTS.length; i++) {
    const d = DISTRICTS[i];
    const dd = (d.x - x) ** 2 + (d.z - z) ** 2;
    if (dd < bd) {
      bd = dd;
      best = d;
    }
  }
  return best;
}

/**
 * Map icon vocabulary. `c` is the blip colour, `p` the priority when two blips
 * collide, `g` the glyph drawn by `drawIcon()` in citymap.js.
 */
export const POI_STYLE = {
  safehouse: { c: '#41e08a', g: 'home', p: 6, label: 'SAFEHOUSE' },
  gas: { c: '#ffc93c', g: 'fuel', p: 2, label: 'FUEL' },
  spray: { c: '#c07cff', g: 'spray', p: 5, label: 'RESPRAY — CLEARS HEAT' },
  ammo: { c: '#ff6a12', g: 'ammo', p: 4, label: 'AMMU-NATION' },
  food: { c: '#ff8ab0', g: 'food', p: 3, label: 'FOOD — RESTORES HEALTH' },
  landmark: { c: '#9aa7b8', g: 'star', p: 3, label: 'LANDMARK' },
  airport: { c: '#5fd0ff', g: 'plane', p: 3, label: 'AIRFIELD' },
  military: { c: '#8aa062', g: 'plane', p: 4, label: 'MILITARY BASE — RESTRICTED' },
  dock: { c: '#2ea6a0', g: 'boat', p: 3, label: 'BOAT DOCK' },
  bridge: { c: '#8894a4', g: 'bridge', p: 1, label: 'BRIDGE' },
  package: { c: '#ffe36e', g: 'pkg', p: 7, label: 'HIDDEN PACKAGE' },
  mission: { c: '#ffb03a', g: 'mission', p: 9, label: 'MISSION' },
  waypoint: { c: '#ff3b8a', g: 'flag', p: 10, label: 'WAYPOINT' },
  race: { c: '#7bf0d8', g: 'flag', p: 5, label: 'STREET RACE' },
  cop: { c: '#4c9dff', g: 'dot', p: 8, label: 'POLICE' },
  enemy: { c: '#ff3b4e', g: 'dot', p: 8, label: 'HOSTILE' },
  friend: { c: '#41e08a', g: 'dot', p: 6, label: 'ALLY' },
};

/**
 * Everything the pause map can label, built once. Blips the game adds at
 * runtime (missions, waypoints, packages found) are layered on top.
 */
export function buildPoiList() {
  const out = [];
  for (const s of SAFEHOUSES) out.push({ x: s.x, z: s.z, kind: 'safehouse', name: s.name, owner: s.owner });
  for (const s of SHOPS) out.push({ x: s.x, z: s.z, kind: s.kind, name: s.name });
  for (const s of GAS) out.push({ x: s.x, z: s.z, kind: 'gas', name: s.name });
  for (const s of LANDMARKS) out.push({ x: s.x, z: s.z, kind: 'landmark', name: s.name });
  for (const s of DOCKS) out.push({ x: s.x, z: s.z, kind: 'dock', name: s.name });
  for (const s of AIRFIELDS) out.push({ x: s.x, z: s.z, kind: 'airport', name: s.name });
  for (const s of MILITARY) out.push({ x: s.x, z: s.z, kind: 'military', name: s.name });
  for (const b of BRIDGES) {
    out.push({
      x: (b.a[0] + b.b[0]) * 0.5,
      z: (b.a[1] + b.b[1]) * 0.5,
      kind: 'bridge',
      name: b.name,
    });
  }
  return out;
}

/* ------------------------------------------------------- sample dialogue -- */

/**
 * The brothers' voice, as authored. `mission.js` plays these as subtitle lines;
 * `game` will hand its own once it exists.
 */
export const SAMPLE_SCENE = {
  chapter: 'CH 3',
  title: 'AGAINST THE CURRENT',
  zone: 'THREE RIVERS',
  lines: [
    { who: 'dylan', text: "Harbormaster's crew runs the bridge circuit for pinks." },
    { who: 'carson', text: "Then I'll take theirs." },
  ],
};
