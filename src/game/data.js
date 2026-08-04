/**
 * GAME — authored content.
 *
 * Every number and every line of dialogue in this file is authored content.
 * The banter between Carson, Aidan and Dylan is the voice of the game.
 *
 * TRACK VARIETY. The arcs are balanced around an eight-chapter shape: fetch,
 * fight, timed run, RECOVER (marked cars to a home ring), PROTECT (a named
 * brother through waves), PARTNER (a rescue-and-repair date-night chapter),
 * the boss with an escape phase, and a zero-reward FINAL drive home into the
 * ending slides. Every one of the twelve track types appears somewhere in the
 * twenty-four chapters.
 *
 * COORDINATES. The story content was authored against a ~700 m map; Steel City
 * is 3 km, so DESIGN.md fixes the scale factor at 4. Everything here is already
 * in world metres — `K` is recorded only so a reader can check the arithmetic.
 * The safehouse/dock/landmark/airfield positions agree with `src/world/plan.js`
 * to the metre, which is the cross-check that the scaling is right; the ids
 * differ (world calls Carson's place `sh_boathouse`, here it is `sh_carson`),
 * so each record carries a `worldId` pointing at its counterpart over there.
 *
 * RADII are NOT scaled by 4. A "you have arrived" radius of 11 units on a
 * 700 m map becomes an absurd 44 m trigger on a 3 km one. They are authored
 * here as real-world distances — a delivery bay is ~16 m across whatever the
 * map scale is.
 */

/** Authoring scale -> world metres, so the numbers below can be checked. */
export const K = 4;

/* ===================================================================== */
/* trigger radii, in real metres                                          */
/* ===================================================================== */

export const R = {
  /** Race checkpoint gate. Driven through at 40 m/s, so it has to be generous. */
  checkpoint: 26,
  /** Delivery / escort arrival. */
  dropoff: 18,
  /** Walk-up range for a shop counter. */
  poi: 14,
  /**
   * Drive-in services — the forecourt you have to actually pull onto. A flat
   * 11 m for the body shop, the pumps and the respray, which reads correctly
   * at this map's scale: a whole forecourt, but not the street outside it.
   */
  service: 11,
  /**
   * Safehouse ring.
   *
   * The authored value is 5.5 m, and 5.5 m does not survive the scale-up. A
   * ~700 m map is effectively flat; Steel City is four times that and has real
   * terrain, so several safehouse POIs sit on a slope — Carson's is a BOATHOUSE
   * on a riverbank. A player who stands at the door slides a couple of metres in
   * the first second, which dropped him out of a 5.5 m ring between the heal
   * starting and his pressing F to sleep. Measured, not guessed:
   * `src/game/interactprobe.mjs` caught exactly that.
   */
  safehouse: 8,
  /** Reach for "Take the <car>" on foot. */
  enter: 5.5,
  /** Reach for "Switch to the <car>" from the driver's seat. */
  swap: 5.2,
  /** Above this speed you are driving past, not pulling in. */
  swapSpeed: 9,
  /**
   * ...and at or below THIS you are parked, so the action is EXIT, not SWITCH.
   * Without a lower bound, `F` cannot get you out of a stationary car whenever
   * anything is parked within `swap` of it — which on a city kerb is always.
   */
  swapMin: 1.5,
  /** Hidden package pickup. */
  package: 5,
  /** Mission crate pickup. */
  crate: 7,
  /** Boss arena leash. */
  arena: 200,
  /** How far you may stray from a brawl before the mission scolds you. */
  brawlLeash: 110,
  /** How far you may stray from a survive hold point. */
  holdLeash: 130,
  /** Chase target escape distance. */
  chaseLose: 620,
  /**
   * `partner` phase flip — how close "you made it to them" is. At Steel City
   * scale the partner is a person by a landmark, not a district, so this is a
   * see-them-across-the-street distance.
   */
  partnerZone: 60,
  /** Stand-here-on-foot range for the partner repair minigame. */
  repair: 4.5,
  /** How close a hostile must be to a protect ward to be hurting him. */
  wardAttack: 4.2,
  /** The final chapter's home ring — about a front yard. */
  finalZone: 26,
};

/**
 * Countdown added to un-timed story tracks when the difficulty says
 * `timedStory` (hard and steel). Base seconds, scaled by `DIFFS.timerMul`:
 * deliver 120 s, recover 260 s, partner 100 s.
 */
export const TIMED_STORY = { deliver: 120, recover: 260, partner: 100 };

/** Objective-vehicle glow colours. */
export const MARK_GREEN = 0x37e07a; // fetch it
export const MARK_AMBER = 0xffd34e; // fetch it, on a clock

/** Seconds of standing in the ring that fills the partner repair to 100%. */
export const REPAIR_TIME = 6;

/* ===================================================================== */
/* points of interest                                                     */
/* ===================================================================== */

export const GAS_STATIONS = [
  { id: 'gas_strip', name: 'Strip Fuel', x: 256, z: -72 },
  { id: 'gas_south', name: 'Carson St Gas', x: 144, z: 528 },
  { id: 'gas_west', name: 'West End Pumps', x: -952, z: 304 },
  { id: 'gas_north', name: 'Shore Service', x: -184, z: -544 },
  { id: 'gas_row', name: 'Steel Row Fuel', x: 760, z: 328 },
  { id: 'gas_law', name: 'Butler St Gas', x: 696, z: -512 },
];

export const SAFEHOUSES = [
  { id: 'sh_aidan', name: 'DeCarlo Body Shop', x: 632, z: -464, owner: 'aidan', worldId: 'sh_bodyshop' },
  { id: 'sh_carson', name: "Carson's Boathouse", x: 88, z: 560, owner: 'carson', worldId: 'sh_boathouse' },
  { id: 'sh_dylan', name: "Dylan's Garage", x: -504, z: 432, owner: 'dylan', worldId: 'sh_garage' },
  { id: 'sh_dt', name: 'Triangle Apartment', x: -264, z: 96, owner: null, worldId: 'sh_apartment', respect: 300 },
  { id: 'sh_north', name: 'Shore Loft', x: -192, z: -672, owner: null, worldId: 'sh_loft', respect: 600 },
];

export const SHOPS = [
  { id: 'shop_spray', name: 'Rustbelt Respray', x: -336, z: 176, kind: 'spray', price: 200 },
  { id: 'shop_ammo', name: 'Foundry Supply', x: 384, z: -280, kind: 'ammo', price: 8 },
  { id: 'shop_food', name: "Primo's Sandwich", x: -120, z: 24, kind: 'food', price: 45 },
  { id: 'shop_ammo2', name: 'Row Hardware', x: 816, z: 464, kind: 'ammo', price: 8 },
  { id: 'shop_food2', name: 'Incline Diner', x: -560, z: 504, kind: 'food', price: 45 },
];

export const DOCKS = [
  { id: 'dock_south', name: 'South Side Docks', x: -88, z: 280, worldId: 'dk_south' },
  { id: 'dock_north', name: 'North Shore Slip', x: -24, z: -264, worldId: 'dk_north' },
  { id: 'dock_point', name: 'Point Marina', x: -744, z: -88, worldId: 'dk_point' },
];

export const AIRPORTS = [
  { id: 'ap_west', name: 'Allegheny County Airfield', x: -1072, z: 784, worldId: 'af_county' },
  { id: 'ap_east', name: 'Rivers Field', x: 1032, z: -784, worldId: 'af_rivers' },
];

export const LANDMARKS = [
  { id: 'lm_point', name: 'The Point Fountain', x: -452, z: 46 },
  { id: 'lm_incline', name: 'Duquesne Incline', x: -488, z: 296 },
  { id: 'lm_stadium', name: 'Steel Bowl', x: -416, z: -512 },
  { id: 'lm_mill', name: 'Old Blast Furnace', x: 872, z: 248 },
  { id: 'lm_tower', name: 'Steel Tower', x: -208, z: -16 },
  { id: 'lm_market', name: 'Strip Market', x: 352, z: -224 },
];

/**
 * Shops bucketed by kind, built once. `nearestShop(x, z, kind)` runs every
 * frame the player is near a counter, and `SHOPS.filter(...)` in there would
 * allocate an array per frame — ARCHITECTURE.md rule 5.
 */
export const SHOPS_BY_KIND = {
  spray: SHOPS.filter((s) => s.kind === 'spray'),
  ammo: SHOPS.filter((s) => s.kind === 'ammo'),
  food: SHOPS.filter((s) => s.kind === 'food'),
};

/** Every id a mission's `dest` field may name. Built once, read every mission. */
export const POI = new Map();
for (const list of [GAS_STATIONS, SAFEHOUSES, SHOPS, DOCKS, AIRPORTS, LANDMARKS]) {
  for (const p of list) POI.set(p.id, p);
}

/** 12 hidden packages. */
export const HIDDEN_PACKAGES = [
  { id: 'pk1', x: -720, z: 160 },
  { id: 'pk2', x: 432, z: -384 },
  { id: 'pk3', x: -56, z: 712 },
  { id: 'pk4', x: 944, z: 512 },
  { id: 'pk5', x: -1144, z: -432 },
  { id: 'pk6', x: 704, z: -864 },
  { id: 'pk7', x: -400, z: -800 },
  { id: 'pk8', x: 1072, z: 96 },
  { id: 'pk9', x: -1200, z: 592 },
  { id: 'pk10', x: 80, z: -928 },
  { id: 'pk11', x: -744, z: 704 },
  { id: 'pk12', x: 488, z: 832 },
];

/** Race circuits. Checkpoint loops that use bridges. */
export const RACE_TRACKS = {
  triangle: {
    id: 'triangle',
    name: 'THE TRIANGLE',
    blurb: 'Downtown loop, both river bridges.',
    laps: 2,
    par: 175,
    reward: 1200,
    points: [
      { x: -224, z: 208 }, { x: 96, z: 104 }, { x: 312, z: -120 },
      { x: 32, z: -248 }, { x: -368, z: -152 }, { x: -552, z: 96 },
    ],
  },
  riverloop: {
    id: 'riverloop',
    name: 'RIVER LOOP',
    blurb: 'Steel Row to Hazelwood and back along the Mon.',
    laps: 1,
    par: 108,
    reward: 900,
    points: [
      { x: 480, z: 240 }, { x: 784, z: 416 }, { x: 920, z: 128 },
      { x: 680, z: -160 }, { x: 384, z: -32 },
    ],
  },
  southrun: {
    id: 'southrun',
    name: 'SOUTH RUN',
    blurb: 'Carson Street flat out, then up the hill.',
    laps: 1,
    par: 95,
    reward: 750,
    points: [
      { x: -160, z: 480 }, { x: 176, z: 632 }, { x: 528, z: 720 },
      { x: 312, z: 448 }, { x: -16, z: 384 },
    ],
  },
};

/* ===================================================================== */
/* weapons                                                                */
/* ===================================================================== */

export const WEAPON_LIB = {
  fists: { name: 'Fists', dmg: 14, rate: 0.34, range: 3.0, ammo: Infinity, melee: true, price: 0 },
  wrench: { name: 'Body Wrench', dmg: 30, rate: 0.46, range: 3.8, ammo: Infinity, melee: true, price: 0 },
  pipe: { name: 'Dock Pipe', dmg: 28, rate: 0.42, range: 4.0, ammo: Infinity, melee: true, price: 0 },
  crowbar: { name: 'Crowbar', dmg: 26, rate: 0.38, range: 3.6, ammo: Infinity, melee: true, price: 0 },
  nailgun: { name: 'Nail Gun', dmg: 20, rate: 0.22, range: 46, ammo: 90, price: 6 },
  tackgun: { name: 'Tack Cannon', dmg: 18, rate: 0.16, range: 42, ammo: 140, price: 5 },
  flare: { name: 'Flare Gun', dmg: 46, rate: 0.7, range: 52, ammo: 40, price: 14 },
  speargun: { name: 'Spear Gun', dmg: 62, rate: 0.85, range: 70, ammo: 30, price: 18 },
  sprayer: { name: 'Paint Cannon', dmg: 15, rate: 0.55, range: 22, ammo: 60, pellets: 7, price: 10 },
  rivetgun: { name: 'Rivet Gun', dmg: 40, rate: 0.2, range: 88, ammo: 120, price: 9 },
  smg: { name: 'Shop Smg', dmg: 16, rate: 0.09, range: 55, ammo: 260, price: 7 },
  emp: { name: 'EMP Coil', dmg: 34, rate: 0.9, range: 34, ammo: 44, emp: true, price: 22 },
  harpoon: { name: 'Harpoon', dmg: 90, rate: 1.1, range: 95, ammo: 22, price: 26 },
  launcher: { name: 'Nitro Launcher', dmg: 180, rate: 1.5, range: 95, ammo: 8, splash: 9, price: 90 },
  depth: { name: 'Depth Charge', dmg: 190, rate: 1.6, range: 60, ammo: 8, splash: 11, price: 95 },
  rocket: { name: 'Scrap Rocket', dmg: 200, rate: 1.7, range: 110, ammo: 7, splash: 10, price: 110 },
};

/* ===================================================================== */
/* difficulty                                                             */
/* ===================================================================== */

/**
 * `timerMul` scales EVERY mission clock and `timedStory` adds countdowns to
 * the tracks that have none (deliver / recover / partner — see `TIMED_STORY`)
 * on hard and steel. `time` is kept as an alias of `timerMul` for any older
 * reader.
 */
export const DIFFS = {
  easy: { dmgIn: 0.6, dmgOut: 1.35, time: 1.3, timerMul: 1.3, timedStory: false, enemy: 0.8, label: 'Easy' },
  normal: { dmgIn: 1.0, dmgOut: 1.0, time: 1.0, timerMul: 1.0, timedStory: false, enemy: 1.0, label: 'Normal' },
  hard: { dmgIn: 1.45, dmgOut: 0.85, time: 0.85, timerMul: 0.85, timedStory: true, enemy: 1.25, label: 'Hard' },
  steel: { dmgIn: 2.0, dmgOut: 0.75, time: 0.72, timerMul: 0.72, timedStory: true, enemy: 1.5, label: 'Steel' },
};

/* ===================================================================== */
/* the three brothers + 24 chapters                                       */
/* ===================================================================== */

export const SPEAKERS = {
  carson: { name: 'CARSON', color: '#2ea6a0' },
  aidan: { name: 'AIDAN', color: '#ff6a12' },
  dylan: { name: 'DYLAN', color: '#c07cff' },
  gabby: { name: 'GABBY', color: '#ff9ecb' },
  boss: { name: '???', color: '#ff3b4e' },
  radio: { name: 'RADIO', color: '#ffc93c' },
  cop: { name: 'DISPATCH', color: '#5fd0ff' },
};

export const BOY_ORDER = ['carson', 'aidan', 'dylan'];

export const BOYZ = {
  carson: {
    id: 'carson',
    name: 'Carson',
    role: 'River hand · eldest',
    color: '#2ea6a0',
    accent: '#7bf0d8',
    home: 'sh_carson',
    district: 'southside',
    blurb: 'Runs freight on the three rivers and knows every current, slip and sunken barge. Steadiest hands, shortest fuse.',
    stats: { speed: 0.62, tough: 0.92, drive: 0.68, aim: 0.74 },
    body: { skin: '#f0cdae', shirt: '#1f6f6a', pants: '#26303c', hair: '#3b2a1c' },
    hp: 130, armorMax: 60, runSpeed: 6.4, vehGrip: 1.06, boatSpeed: 1.25,
    rival: 'THE HARBORMASTER',
    weapons: ['fists', 'pipe', 'flare', 'speargun', 'harpoon', 'depth'],
    start: ['fists', 'pipe', 'flare', 'speargun'],
    radio: ['slack', 'gold', 'furnace', 'incline'],
    car: 'truck',
    intro: {
      title: 'CARSON',
      sub: 'Eight chapters on the water',
      body: "You're Carson, oldest of the three. The rivers pay in cash and bruises. Somebody has started charging a toll on water that never belonged to them — and your brothers are already in it up to their necks.",
      tag: 'Boats handle differently. Learn the current.',
    },
    story: [
      { no: 'CH 1', name: 'Slackwater', zone: 'SOUTH SIDE DOCKS', teaser: 'A quiet run down the Mon.',
        track: 'deliver', vehType: 'boat', from: 'dock_south', dest: 'dock_north', cash: 700, respect: 20, difficulty: 1,
        intro: [['carson', 'First light on the Mon. Best part of the day.'],
                ['dylan', "Boat's loaded, Cars. Drop it at the North Shore slip."],
                ['carson', "Tell Aidan I'll be back before the shop opens."]],
        done: [['carson', 'Delivered. Easy money.'], ['dylan', "Nothing's ever this easy twice."]] },
      { no: 'CH 2', name: 'Toll Collectors', zone: 'NORTH SHORE SLIP', teaser: "Somebody's charging for the river.",
        track: 'goons', goal: 5, at: 'dock_north', cash: 1200, respect: 40, difficulty: 1,
        intro: [['boss', "River's mine now, kid. Every hull pays."],
                ['carson', "You don't own water."],
                ['boss', 'I own everyone who floats on it.']],
        done: [['carson', "Tell your boss the Mon's still free."]] },
      { no: 'CH 3', name: 'Against the Current', zone: 'THREE RIVERS', teaser: 'Race the tide through five bridges.',
        track: 'race', trackId: 'riverloop', laps: 1, baseTimer: 108, cash: 1500, respect: 45, difficulty: 2,
        intro: [['dylan', "Harbormaster's crew runs the bridge circuit for pinks."],
                ['carson', "Then I'll take theirs."]],
        done: [['dylan', 'Told you the old man could drive.']] },
      { no: 'CH 4', name: 'Salvage Rights', zone: 'OHIO CHANNEL', teaser: 'Pull six crates out of the water before they do.',
        track: 'collect', goal: 6, spread: 520, water: true, at: 'lm_point', baseTimer: 150, cash: 2200, respect: 65, difficulty: 2,
        intro: [['carson', "Barge went down at the Point. Cargo's still floating."],
                ['aidan', "Half the city's out there fishing for it."],
                ['carson', "Then I'd better be quick."]],
        done: [['carson', 'Salvage law. Finders keepers.']] },
      { no: 'CH 5', name: 'Bridge Toll', zone: 'SMITHFIELD CROSSING', teaser: "Wreck the toll convoy — clock's running.",
        track: 'rampage', goal: 6, spread: 420, at: 'dock_south', baseTimer: 105, cash: 3400, respect: 80, unlock: 'harpoon', difficulty: 3,
        intro: [['boss', 'Six trucks. My money. Try it.'],
                ['carson', 'I intend to.']],
        done: [['carson', "Convoy's scrap. He'll come himself now."]] },
      { no: 'CH 6', name: 'Nobody Touches Family', zone: 'SOUTH SIDE DOCKS', teaser: 'They came for Dylan. Bad idea.',
        track: 'protect', ward: 'dylan', goal: 8, at: 'dock_south', cash: 2800, respect: 95, unlock: 'depth', difficulty: 4,
        intro: [['boss', 'You cost me a convoy, Carson. So I priced up your little brother.'],
                ['dylan', "Cars — they've got me boxed in at the South Side slip!"],
                ['carson', 'Stand behind me, Dylan. Nobody touches this family.']],
        done: [['dylan', 'I had it handled. Mostly.'],
               ['carson', "Aye. 'Mostly' is why I came."]] },
      { no: 'CH 7', name: 'The Harbormaster', zone: 'POINT MARINA', teaser: 'He owns the water. Change that.',
        track: 'boss', bossId: 'harbormaster', cash: 6500, respect: 180, difficulty: 5,
        escapeAlly: 'dylan', escapeLine: 'He bought half the river cops — lose the heat, Cars!',
        intro: [['boss', 'Three rivers, Carson. I dredged every one.'],
                ['carson', 'And you never once got in one.'],
                ['dylan', "Cars — his armour's on the front. Get behind him."],
                ['aidan', "We're right here, big brother."]],
        done: [['carson', "River's free. Costs nothing to float."],
               ['aidan', "Costs plenty, from where I'm standing."],
               ['carson', 'Aye. Worth it.']] },
      { no: 'CH 8', name: 'Slack Tide', zone: 'SOUTH SIDE', teaser: 'No cargo, no clock. Just come home.',
        track: 'final', dest: 'sh_carson', cash: 0, respect: 0, difficulty: 1,
        intro: [['aidan', 'Carson. Come down to the boathouse, will you?'],
                ['dylan', 'No jobs. No tolls. Get here before the light goes.'],
                ['carson', 'On my way. Somebody put the kettle on.']],
        done: null },
    ],
    ending: [
      { icon: 'anchor', title: 'THE RIVER HAND', year: '',
        msg: 'The tolls came down and the barges ran free, dawn to dark. Carson kept the first run of every morning for himself — first light on the Mon, best part of the day.' },
      { icon: 'home', title: 'THE BOATHOUSE', year: '',
        msg: 'The whole family on the dock: Aidan working the grill, Dylan telling the story wrong on purpose, and every boat on the three rivers sounding its horn as it passed.' },
      { icon: 'star', title: "HERE'S TO THE BOYS", year: '2026',
        msg: "Here's to Carson, to the DeCarlo Boys, and to the Steel City that raised them. The river belongs to the river — and it costs nothing to float." },
    ],
  },

  aidan: {
    id: 'aidan',
    name: 'Aidan',
    role: 'Body man · middle',
    color: '#ff6a12',
    accent: '#ffc93c',
    home: 'sh_aidan',
    district: 'lawren',
    blurb: 'Straightens metal for a living and people for free. Best panel-beater in the Burgh, worst at leaving well enough alone.',
    stats: { speed: 0.74, tough: 0.78, drive: 0.86, aim: 0.8 },
    body: { skin: '#f4d4b6', shirt: '#c2410c', pants: '#1f2733', hair: '#8a5a2a' },
    hp: 115, armorMax: 75, runSpeed: 6.9, vehGrip: 1.12, boatSpeed: 1.0,
    rival: 'DUKE MARROW',
    partner: { id: 'gabby', name: 'Gabby', color: '#ff9ecb' },
    weapons: ['fists', 'wrench', 'nailgun', 'sprayer', 'rivetgun', 'launcher'],
    start: ['fists', 'wrench', 'nailgun', 'rivetgun'],
    radio: ['grease', 'gold', 'redline', 'furnace'],
    car: 'muscle',
    intro: {
      title: 'AIDAN',
      sub: 'Eight chapters of hammered metal',
      body: "You're Aidan, the middle boy, and the body shop on Butler Street is yours. Duke Marrow's chop crew wants the block. They're going to learn what a man with a slide hammer can do.",
      tag: 'Best driver of the three. Use it.',
    },
    story: [
      { no: 'CH 1', name: 'Open for Business', zone: 'LAWRENCEVILLE', teaser: 'First job of the morning.',
        track: 'deliver', vehType: 'sports', dest: 'sh_aidan', cash: 750, respect: 22, difficulty: 1,
        intro: [['carson', "Customer's car is two blocks over and it's not walking home."],
                ['aidan', 'Neither am I.'],
                ['dylan', 'Try not to add dents on the way, panel-beater.']],
        done: [['aidan', 'Straight as the day it left the factory.'], ['carson', 'Show-off.']] },
      { no: 'CH 2', name: "Duke's Boys", zone: 'BUTLER STREET', teaser: 'Five men, one wrench.',
        track: 'brawl', goal: 5, at: 'sh_aidan', cash: 1250, respect: 42, difficulty: 1,
        intro: [['boss', 'Nice shop. Be a shame if it took a knock.'],
                ['aidan', "It's taken plenty. So have I."],
                ['boss', 'Boys — show him.']],
        done: [['aidan', 'Sweep up on your way out.'], ['dylan', 'That was art.']] },
      { no: 'CH 3', name: 'Hot Parts', zone: 'THE STRIP', teaser: 'A rush order across two bridges.',
        track: 'timedDeliver', vehType: 'van', dest: 'shop_ammo', baseTimer: 88, cash: 1400, respect: 46, unlock: 'sprayer', difficulty: 2,
        intro: [['carson', "Foundry Supply closes in ninety seconds and the van's full."],
                ['aidan', "Then I'd better take the bridge."]],
        done: [['aidan', 'Signed for.'], ['carson', 'You went over the Sixteenth at what speed?']] },
      { no: 'CH 4', name: 'The Big Recovery', zone: 'LAWRENCEVILLE', teaser: "Steal back what's yours, one ride at a time.",
        track: 'recover', goal: 3, at: 'sh_aidan', dest: 'sh_aidan', cash: 2100, respect: 65, difficulty: 2,
        intro: [['carson', "Duke's crew stashed stolen rides all over the Burgh."],
                ['dylan', 'Three of them, marked in green. Bring each one back to the shop ring.'],
                ['aidan', "They took cars off MY street. I'm taking them back."]],
        done: [['aidan', "Three rides home. Duke's going to be furious."],
               ['dylan', 'Let him be.']] },
      { no: 'CH 5', name: 'The Long Haul', zone: 'FORT PITT BRIDGE', teaser: 'Get Dylan across the river alive.',
        track: 'escort', from: 'sh_aidan', dest: 'sh_dylan', cash: 2900, respect: 82, unlock: 'launcher', difficulty: 3,
        intro: [['dylan', "I'm in the truck, I'm slow, and they're shooting."],
                ['aidan', "Stay on my bumper and don't be clever."],
                ['dylan', "That's my only setting."]],
        done: [['dylan', 'Never doing that again.'], ['aidan', "You'll do it Thursday."]] },
      { no: 'CH 6', name: 'Date Night Rescue', zone: 'GOLDEN TRIANGLE', teaser: "Gabby's car died downtown. Husband to the rescue.",
        track: 'partner', partner: 'gabby', dest: 'lm_tower', cash: 900, respect: 35, difficulty: 2,
        partnerLine: "My hero. Fix it fast — I'm not missing pierogi night.",
        intro: [['gabby', 'Aidan? The car just died by the Steel Tower — and we have reservations tonight.'],
                ['dylan', "Go save date night, bro. She's waiting!"],
                ['aidan', 'On my way, Gabby. Nobody panic.']],
        done: [['gabby', "Best husband in Pittsburgh. Now drive — we're late!"],
               ['dylan', 'Smooth save.'],
               ['carson', "And THAT'S why she married you."]] },
      { no: 'CH 7', name: 'Duke Marrow', zone: 'OLD BLAST FURNACE', teaser: 'Finish it in the furnace yard.',
        track: 'boss', bossId: 'duke', cash: 7000, respect: 190, difficulty: 5,
        escapeAlly: 'dylan', escapeLine: "Duke's crooked cops are coming — lose the heat!",
        intro: [['boss', "I built this row out of other people's scrap."],
                ['aidan', "You built it out of other people's lives."],
                ['carson', "We're on the gate, Aidan."],
                ['dylan', 'And I brought the loud one.']],
        done: [['aidan', "Butler Street's ours again."],
               ['carson', 'It always was.'],
               ['dylan', "Somebody's paying for my tyres though."]] },
      { no: 'CH 8', name: 'The Anniversary Drive', zone: 'LAWRENCEVILLE', teaser: "One last drive home — Gabby's planned a surprise.",
        track: 'final', dest: 'sh_aidan', cash: 0, respect: 0, difficulty: 1,
        intro: [['gabby', 'Aidan... come home. The whole family is here.'],
                ['carson', 'Drive to Butler Street, brother. Trust us.'],
                ['dylan', 'Go on! And act surprised!']],
        done: null },
    ],
    ending: [
      { icon: 'heart', title: 'AIDAN & GABBY', year: '',
        msg: 'Gabby had the porch lights strung and the grill going — an anniversary surprise looking clean over Butler Street. Married to the love of his life, king of the body shop.' },
      { icon: 'cake', title: 'THE DECARLO COOKOUT', year: '',
        msg: 'The whole family rolled in — three trays of pierogies, Terrible Towels off the porch, and the shop sign burning gold past midnight.' },
      { icon: 'ring', title: "HERE'S TO FOREVER", year: '2026',
        msg: "Here's to Aidan and Gabby, to the DeCarlo Boys, and to the Steel City that raised them. Live it loud." },
    ],
  },

  dylan: {
    id: 'dylan',
    name: 'Dylan',
    role: 'Courier · youngest',
    color: '#c07cff',
    accent: '#5fd0ff',
    home: 'sh_dylan',
    district: 'mtwash',
    blurb: 'Fastest hands on a wheel in three counties and absolutely no impulse control. Knows every shortcut, including the ones that aren\'t roads.',
    stats: { speed: 0.94, tough: 0.6, drive: 0.98, aim: 0.66 },
    body: { skin: '#eec9a8', shirt: '#7c3aed', pants: '#1a1f2b', hair: '#221812' },
    hp: 100, armorMax: 55, runSpeed: 7.9, vehGrip: 1.22, boatSpeed: 1.05,
    rival: 'VIPER LANE',
    weapons: ['fists', 'crowbar', 'tackgun', 'emp', 'smg', 'rocket'],
    start: ['fists', 'crowbar', 'tackgun', 'smg'],
    radio: ['redline', 'furnace', 'grease', 'slack'],
    // Dylan's own car, named specifically. A front-drive fastback: the only
    // class in the fleet with its mass over the driven axle (comZ 0.60 against
    // the Allegheny's 0.45), so it hooks up where a rear-drive car spins and
    // washes wide at the limit instead of stepping out. Fits the fast brother
    // without making him the muscle brother.
    car: 'kessel',
    intro: {
      title: 'DYLAN',
      sub: 'Eight chapters at redline',
      body: "You're Dylan, the baby of the family, and you have never once arrived somewhere on time by accident. Viper Lane runs the hill circuit and thinks it belongs to her. Prove otherwise, preferably sideways.",
      tag: 'Fragile, but nothing on wheels can catch you.',
    },
    story: [
      { no: 'CH 1', name: 'Hill Start', zone: 'MT. WASHINGTON', teaser: 'Learn the incline the hard way.',
        track: 'race', trackId: 'southrun', laps: 1, baseTimer: 95, cash: 800, respect: 24, difficulty: 1,
        intro: [['dylan', 'Five checkpoints, one hill, no brakes.'],
                ['aidan', 'There are brakes, Dylan.'],
                ['dylan', 'There are. I said no brakes.']],
        done: [['dylan', 'Beat it by nine seconds.'], ['aidan', 'Beat what by nine seconds?']] },
      { no: 'CH 2', name: 'Package Run', zone: 'GOLDEN TRIANGLE', teaser: 'Four drops, one clock.',
        track: 'collect', goal: 4, spread: 380, at: 'lm_tower', baseTimer: 105, cash: 1300, respect: 42, difficulty: 1,
        intro: [['carson', 'Four parcels, downtown, before the bridges back up.'],
                ['dylan', "Bridges don't back up if you don't stop."]],
        done: [['dylan', 'All four. Tip?'], ['carson', 'No.']] },
      { no: 'CH 3', name: "Viper's Line", zone: 'THE STRIP', teaser: "She's been racing your route.",
        track: 'chase', at: 'lm_market', cash: 1600, respect: 46, difficulty: 2,
        intro: [['boss', 'Cute little hatchback. Does it turn?'],
                ['dylan', "Let's find out at the same time."]],
        done: [['dylan', "She's fast. She's not that fast."]] },
      { no: 'CH 4', name: 'Hot Wheels', zone: 'SOUTH SIDE', teaser: 'Six units, three stars, no scratches.',
        track: 'escape', stars: 4, cash: 2000, respect: 58, unlock: 'emp', difficulty: 3,
        intro: [['aidan', 'Dylan. Why are there six cruisers on Carson Street?'],
                ['dylan', 'Statistically, some of them are just passing through.'],
                ['aidan', 'LOSE THEM.']],
        done: [['dylan', 'Told you. Passing through.']] },
      { no: 'CH 5', name: 'Air Mail', zone: 'RIVERS FIELD', teaser: 'Beat the flight out of the east field.',
        track: 'timedDeliver', vehType: 'muscle', dest: 'ap_east', baseTimer: 96, cash: 2800, respect: 78, difficulty: 3,
        intro: [['carson', 'That crate has to be wheels-up in a minute and a half.'],
                ['dylan', 'A minute and a half is generous.']],
        done: [['dylan', 'Forty seconds spare. I stopped for a sandwich.']] },
      { no: 'CH 6', name: 'The Long Way Down', zone: 'MT. WASHINGTON', teaser: "Survive Viper's ambush on the incline.",
        track: 'survive', duration: 90, at: 'lm_incline', cash: 3000, respect: 88, unlock: 'rocket', difficulty: 4,
        intro: [['boss', 'Nowhere to run on a hill, courier.'],
                ['dylan', "Hills are just ramps you're too scared to use."]],
        done: [['dylan', 'I want that on my headstone.']] },
      { no: 'CH 7', name: 'Viper Lane', zone: 'FORT DUQUESNE BRIDGE', teaser: 'She brought the whole crew. Good.',
        track: 'boss', bossId: 'viper', cash: 7200, respect: 200, difficulty: 5,
        escapeAlly: 'aidan', escapeLine: "She's got the traffic division in her pocket — shake them, kid!",
        intro: [['boss', "You're quick. You're not finished."],
                ['dylan', "Neither are you. That's the fun part."],
                ['carson', "Dylan — she's armoured up front."],
                ['aidan', 'Hit the wheels, kid. Like I taught you.']],
        done: [['dylan', "Hill's ours."],
               ['aidan', 'The hill was always ours.'],
               ['carson', 'The hill belongs to the hill. Get in the boat.']] },
      { no: 'CH 8', name: 'Redline Home', zone: 'MT. WASHINGTON', teaser: 'No clock, no cops, no race. Just come home.',
        track: 'final', dest: 'sh_dylan', cash: 0, respect: 0, difficulty: 1,
        intro: [['carson', 'Dylan. Garage. Now. Good news for once.'],
                ['aidan', "We're all up here. Bring the hatchback — the hill misses you."],
                ['dylan', 'First one to the incline buys the sandwiches.']],
        done: null },
    ],
    ending: [
      { icon: 'flag', title: 'KING OF THE HILL', year: '',
        msg: 'The hill circuit went quiet after Viper left town, so Dylan raced the only driver still worth beating — yesterday\'s Dylan. He is currently down by nine seconds.' },
      { icon: 'home', title: 'THE GARAGE', year: '',
        msg: 'Carson brought the boat trailer, Aidan brought the tools, and the youngest DeCarlo finally arrived somewhere on time — on purpose, sideways, to applause.' },
      { icon: 'star', title: 'THE DECARLO BOYS', year: '2026',
        msg: "Here's to Dylan, to the brothers who never once let him crash alone, and to the Steel City that raised them all. Flat out, forever." },
    ],
  },
};

/* ===================================================================== */
/* bosses                                                                 */
/* ===================================================================== */

export const BOSSES = {
  harbormaster: {
    id: 'harbormaster',
    name: 'THE HARBORMASTER', sub: 'Owner of nothing, taker of everything',
    hp: 1400, phases: 3, kind: 'brute', color: '#1d6f6a', scale: 1.35,
    weak: 'Armour plate is bolted to his chest — hit him from behind',
    attacks: ['slam', 'sweep', 'charge'], minions: [3, 4, 5],
    arena: { x: -744, z: -88, r: 176 },
  },
  brick: {
    id: 'brick',
    name: 'BRICK', sub: "Duke's enforcer",
    hp: 900, phases: 2, kind: 'brute', color: '#7a2e12', scale: 1.25,
    weak: 'He telegraphs the haymaker — dodge, then punish',
    attacks: ['haymaker', 'sweep'], minions: [2, 3],
    arena: { x: 984, z: -56, r: 152 },
  },
  duke: {
    id: 'duke',
    name: 'DUKE MARROW', sub: 'Chop-shop king of Steel Row',
    hp: 1600, phases: 3, kind: 'gunner', color: '#8a1b2b', scale: 1.2,
    weak: "He reloads after six shots — that's your window",
    attacks: ['volley', 'grenade', 'call'], minions: [4, 5, 6],
    arena: { x: 872, z: 248, r: 184 },
  },
  viper: {
    id: 'viper',
    name: 'VIPER LANE', sub: 'Queen of the hill circuit',
    hp: 1500, phases: 3, kind: 'driver', color: '#5b21b6', scale: 1,
    weak: 'Front is plated — wreck the rear wheels',
    attacks: ['ram', 'spread', 'smoke'], minions: [3, 4, 4],
    arena: { x: -240, z: -280, r: 240 },
  },
};

/** Which boss belongs to which brother — used by the switch-wheel blurb. */
export const RIVAL_OF = { carson: 'harbormaster', aidan: 'duke', dylan: 'viper' };

/* ===================================================================== */
/* objective copy                                                         */
/* ===================================================================== */

export const TRACK_LABEL = {
  deliver: 'Delivery', timedDeliver: 'Timed delivery', goons: 'Combat', brawl: 'Brawl',
  race: 'Race', chase: 'Pursuit', escape: 'Lose the heat', collect: 'Collection',
  survive: 'Survival', escort: 'Escort', rampage: 'Rampage', boss: 'Boss fight',
  recover: 'Recovery', protect: 'Protection', partner: 'Rescue', final: 'Homecoming',
};

export function defaultObjective(c) {
  switch (c.track) {
    case 'deliver': return 'Bring the marked vehicle to the drop';
    case 'timedDeliver': return 'Beat the clock to the drop';
    case 'goons': return 'Take down ' + (c.goal ?? 5) + ' of them';
    case 'brawl': return 'Fists and steel only — drop ' + (c.goal ?? 5);
    case 'race': return 'Hit every checkpoint';
    case 'chase': return 'Run the target down';
    case 'escape': return 'Lose the police';
    case 'collect': return 'Collect ' + (c.goal ?? 4) + ' crates';
    case 'survive': return 'Hold the ground';
    case 'escort': return 'Keep the truck alive';
    case 'rampage': return 'Wreck ' + (c.goal ?? 6) + ' targets';
    case 'boss': return 'Finish it';
    case 'recover': return 'Bring the ' + (c.goal ?? 3) + ' marked cars home';
    case 'protect': return 'Keep him alive — drop ' + (c.goal ?? 8) + ' of them';
    case 'partner': return 'Get to the car';
    case 'final': return 'Drive home';
    default: return 'Do the job';
  }
}

/* ===================================================================== */
/* respect unlocks                                                        */
/* ===================================================================== */

/**
 * Respect is the second currency. Cash buys consumables; respect opens doors.
 * Chapter unlocks are handled by the chapter's own `unlock` field — these are
 * the free-roam rewards that accrue no matter which brother earns them.
 */
export const RESPECT_UNLOCKS = [
  { at: 100, kind: 'note', label: 'Word is getting around' },
  { at: 300, kind: 'safehouse', id: 'sh_dt', label: 'Triangle Apartment' },
  { at: 600, kind: 'safehouse', id: 'sh_north', label: 'Shore Loft' },
  { at: 900, kind: 'note', label: 'The DeCarlo name carries weight' },
];

/** Cash tiers a shop will sell at once you have the respect for them. */
export const SHOP_STOCK = {
  ammo: ['nailgun', 'tackgun', 'sprayer', 'smg', 'rivetgun', 'flare', 'speargun', 'emp', 'harpoon'],
};

/** Starting float. */
export const START_CASH = 500;

/** Hidden package payout. */
export const PACKAGE_CASH = 600;
export const PACKAGE_RESPECT = 8;
/** All twelve found unlocks the Nitro Launcher. */
export const PACKAGE_REWARD_WEAPON = 'launcher';
