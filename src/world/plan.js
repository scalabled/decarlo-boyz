/**
 * WORLD — the city plan.
 *
 * Every authored number for Steel City lives here, already converted to world
 * metres. DESIGN.md gives legacy coordinates over a ~700 m map; the whole city
 * is scaled by K = 4 so it becomes a 3 km open world you have to drive.
 *
 * Nothing in this file builds geometry — it is data plus a couple of pure
 * helpers. `terrain.js`, `netgen.js` and `roadmesh.js` consume it.
 */

/** Legacy -> world scale. DESIGN.md: "multiply every legacy coordinate by 4". */
export const K = 4;

/** Metres, square, origin-centred. This is `world.CITY_SIZE`. */
export const CITY_SIZE = 3000;
export const HALF_CITY = CITY_SIZE / 2;

/** Streaming tile edge, metres (ARCHITECTURE.md: 128 m tiles). */
export const TILE = 128;
/** My own geometry is merged 4x4 tiles at a time so the draw count stays sane. */
export const SECTOR = TILE * 4;

/** Pool level of all three rivers. Steel City has no locks worth modelling. */
export const WATER_Y = 0;
/** Depth of the dredged channel at the centreline. */
export const RIVER_BED = -11;
/** Metres of bank between the waterline and undisturbed ground. */
export const RIVER_SHORE = 44;
/** Height of the top of the bank above the pool. */
export const RIVER_BANK = 5.2;

const p4 = (pts) => pts.map(([x, z]) => [x * K, z * K]);

/**
 * The three rivers, DESIGN.md polylines x4.
 *
 * Two deliberate departures from the table, both so that The Point reads as
 * the tip of a triangle of land rather than a puddle:
 *   - an extra vertex is inserted on the Allegheny and the Monongahela ~110 m
 *     short of the confluence, so the two channels run parallel for a moment
 *     instead of converging from 40 degrees apart and eating the whole wedge;
 *   - every river is extrapolated past the map edge so no channel simply stops.
 */
export const RIVERS = [
  {
    id: 'allegheny',
    name: 'Allegheny',
    width: 144,
    pts: [
      [1320, -1360],
      ...p4([
        [228, -252],
        [150, -196],
        [66, -136],
        [-16, -82],
        [-88, -40],
      ]),
      [-464, -72],
      [-600, 40],
    ],
  },
  {
    id: 'monongahela',
    name: 'Monongahela',
    width: 136,
    pts: [
      [1360, 1320],
      ...p4([
        [236, 232],
        [156, 182],
        [74, 132],
        [-8, 86],
        [-84, 46],
      ]),
      [-452, 148],
      [-600, 40],
    ],
  },
  {
    id: 'ohio',
    name: 'Ohio',
    width: 184,
    /**
     * THE OHIO'S OUTER END USED TO STOP AT (-1560, -620) AND THAT WAS A CRATER.
     *
     * `segDist2` clamps the segment parameter to [0, 1], so past the last
     * vertex `riverAt` measures the RADIAL distance to that vertex: the channel
     * stops being a channel and becomes a disc. A disc of radius
     * `width/2 + RIVER_SHORE` = 136 m, carved unconditionally to
     * `RIVER_BED = -11`.
     *
     * That would be harmless in low ground, which is where the Allegheny and
     * the Monongahela end — but rr = 1560 is well inside the rim-hill band
     * (`rawHeight` adds up to 236 m of ridged noise past rr = 1180), so the
     * Ohio's cap was punched through a hillside standing 100-155 m high. The
     * result was a 272 m elliptical bowl 165 m deep with a 74-degree wall, and
     * it is the crater a reviewer photographed on the right of `farview` from
     * 2.6 km away in Hazelwood.
     *
     * Carry the channel out past the rim band instead, which is what the file
     * header already claims every river does.
     */
    pts: [...p4([[-150, 10], [-214, -24], [-268, -68], [-336, -124]]), [-1560, -620], [-2560, -1010]],
  },
];

/**
 * The twelve districts, DESIGN.md x4.
 *
 * `pad` is the elevation the terrain is pulled toward inside the district and
 * `edge` how many metres it takes to get there — that is what turns Troy Hill
 * and Mt. Washington into hills with flat tops full of houses, which is what
 * Pittsburgh actually looks like from the air.
 */
export const DISTRICTS = [
  { id: 'point', name: 'THE POINT', x: -672, z: 16, r: 248, tall: 0.10, tint: [0.30, 0.36, 0.30], pad: 4, edge: 120, density: 0.15, wealth: 0.5, grid: 'park' },
  { id: 'downtown', name: 'GOLDEN TRIANGLE', x: -232, z: 64, r: 400, tall: 1.00, tint: [0.36, 0.38, 0.44], pad: 9, edge: 180, density: 1.0, wealth: 0.85, grid: 'downtown' },
  { id: 'strip', name: 'THE STRIP', x: 248, z: -184, r: 344, tall: 0.55, tint: [0.42, 0.34, 0.28], pad: 12, edge: 200, density: 0.8, wealth: 0.45, grid: 'grid' },
  { id: 'lawren', name: 'LAWRENCEVILLE', x: 680, z: -552, r: 384, tall: 0.42, tint: [0.40, 0.33, 0.30], pad: 26, edge: 260, density: 0.75, wealth: 0.5, grid: 'grid' },
  { id: 'northsh', name: 'NORTH SHORE', x: -160, z: -600, r: 416, tall: 0.50, tint: [0.31, 0.36, 0.40], pad: 10, edge: 220, density: 0.6, wealth: 0.6, grid: 'grid' },
  { id: 'troy', name: 'TROY HILL', x: 520, z: -1032, r: 360, tall: 0.30, tint: [0.34, 0.38, 0.32], pad: 74, edge: 300, density: 0.55, wealth: 0.4, grid: 'hill' },
  { id: 'southside', name: 'SOUTH SIDE', x: 160, z: 608, r: 432, tall: 0.45, tint: [0.40, 0.35, 0.30], pad: 8, edge: 210, density: 0.7, wealth: 0.45, grid: 'grid' },
  { id: 'mtwash', name: 'MT. WASHINGTON', x: -528, z: 464, r: 368, tall: 0.28, tint: [0.33, 0.37, 0.33], pad: null, edge: 0, density: 0.5, wealth: 0.55, grid: 'hill' },
  { id: 'steelrow', name: 'STEEL ROW', x: 784, z: 384, r: 400, tall: 0.62, tint: [0.44, 0.32, 0.26], pad: 7, edge: 190, density: 0.6, wealth: 0.25, grid: 'mill' },
  { id: 'westend', name: 'WEST END', x: -1032, z: 368, r: 384, tall: 0.30, tint: [0.35, 0.36, 0.33], pad: 58, edge: 300, density: 0.45, wealth: 0.4, grid: 'hill' },
  { id: 'northside', name: 'MANCHESTER', x: -984, z: -568, r: 368, tall: 0.32, tint: [0.34, 0.35, 0.38], pad: 16, edge: 240, density: 0.55, wealth: 0.4, grid: 'grid' },
  { id: 'hazel', name: 'HAZELWOOD', x: 984, z: -56, r: 344, tall: 0.36, tint: [0.40, 0.34, 0.28], pad: 34, edge: 260, density: 0.5, wealth: 0.3, grid: 'grid' },
];

export const DISTRICT_BY_ID = Object.fromEntries(DISTRICTS.map((d) => [d.id, d]));

/**
 * The Mt. Washington bluff.
 *
 * The signature view of the city is downtown seen from the top of this cliff,
 * so it is authored explicitly rather than falling out of a radial pad: a ridge
 * line roughly parallel to the south bank of the Mon, terrain climbing ~104 m
 * over 130 m of ground south of it (about 39 degrees — walkable nowhere, which
 * is why the Incline exists), then a plateau of timber houses.
 */
export const BLUFF = {
  line: [
    [-1010, 236],
    [-780, 258],
    [-560, 318],
    [-352, 404],
    [-140, 514],
    [80, 628],
    [300, 742],
  ],
  rise: 104,
  /** metres of ground the climb takes */
  run: 132,
  /** how far south the plateau extends before it falls away again */
  depth: 640,
  fall: 340,
  /** metres of taper at each end of the ridge */
  taper: 260,
};

/** Radial elevation controls that are not districts (rolling country, rim hills). */
export const HILLS = [
  { x: 1180, z: -880, r: 520, h: 96 },   // beyond Troy Hill
  { x: 1240, z: 520, r: 520, h: 78 },    // beyond Steel Row
  { x: -1300, z: 700, r: 560, h: 104 },  // beyond the West End
  { x: -1360, z: -900, r: 520, h: 88 },  // beyond Manchester
  { x: 420, z: 980, r: 480, h: 70 },     // the South Side slopes
  { x: 900, z: -180, r: 360, h: 44 },    // Hazelwood ridge
];

/**
 * THE SIX LANDMARKS — and the ground each of them stands on.
 *
 * `x, z` is the authored centre. **This table is the city's single source of
 * truth for where a landmark IS.** It is published as `world.landmarks`, and
 * `src/game/data.js` and `src/ui/data.js` already carry the same numbers;
 * `src/buildings/` adopts them at init (`adoptLandmarkSites`) rather than
 * keeping a fourth copy, because it kept a fourth copy and it disagreed —
 * see the note on `lm_point` below.
 *
 * THE POINT FOUNTAIN MOVED, AND THIS COORDINATE IS THE RIGHT ONE.
 *
 * `DESIGN.md` lists `lm_point` at legacy `(-178, 8)`, which is `(-712, 32)`
 * after the x4 scale, and `src/buildings/landmarks.js` used to build it there.
 * That is not the Point. `DESIGN.md` also puts the confluence of the three
 * rivers at legacy `(-150, 10)` -> `(-600, 40)`, and the Ohio runs WEST from
 * it — so `(-712, 32)` is 112 m DOWNSTREAM of the confluence, in the middle of
 * the Ohio's 184 m channel. Measured on the shipped terrain:
 * `heightAt(-712, 32) = -8.68 m` and `isWater(-712, 32) === true`. The
 * fountain was standing on the river bed under 8.7 m of water.
 *
 * The real Point is the TIP OF THE TRIANGLE, upstream of where the two rivers
 * join — which is what `(-452, 46)` is: `heightAt = +3.56 m`, dry, on the
 * wedge of land between the Allegheny (centreline z = -81 at this x) and the
 * Monongahela (z = 148). Legacy's `(-178, 8)` was authored against a 700 m map
 * whose channels were drawn narrower than a x4 scale of them; the scale note
 * in `DESIGN.md` does not survive contact with a real river.
 *
 * `site` is the FOOTPRINT THE LANDMARK ACTUALLY OCCUPIES, as an oriented
 * rounded box in world metres: half-extents `hx, hz` about a centre offset
 * `ox, oz` from `x, z`, rotated by `yaw`, with corner radius `r`. `hx = hz = 0`
 * makes it a disc; `hx = 0` makes it a capsule. Every one of the six was
 * MEASURED off the emitted geometry — the low triangles a bumper can reach,
 * within 4 m of the ground — not read off the builder's constants, and each
 * carries 2-5 m of margin over what was measured:
 *
 *   lm_tower    disc  r 36        podium 52 x 44 + colonnade; measured 33.6
 *   lm_stadium  box   116 x 94    pier ring 108 x 86 + masts;  measured 110.6
 *   lm_mill     disc  r 72        stack, stoves, cast house, silos, gantries;
 *                                 irregular, measured 71.1 at 45 degrees
 *   lm_incline  capsule r 16      the funicular: a 187 m trestle up the bluff.
 *               x 208 long        Its BEARING is not authored — see `uphill`
 *   lm_point    disc  r 46        basin R 30 + granite apron to 44 + bollards
 *   lm_market   box   42 x 122    the hall 30 x 96 + the head building;
 *                                 measured 66.3 to the head building's corner
 *
 * `netgen.reserveLandmarks` keeps every drivable corridor `LANDMARK_RESERVE`
 * metres clear of these, and `src/world/lmsweep.mjs` asserts it against the
 * emitted graph. Nothing else may assume a landmark is round.
 *
 * `uphill` MARKS A SITE WHOSE BEARING IS SOLVED, NOT AUTHORED — and it is here
 * because guessing it did not work. A funicular points up the hill, so
 * `buildings`' `incline()` used to DISCOVER the steepest bearing off the
 * terrain at build time. Reserving the ground under it changed the terrain
 * (a road corridor sinks the ground 0.55 m), the steepest-bearing scan is a
 * knife edge between neighbouring bearings, and the trestle swung 30 degrees —
 * straight back out of the capsule that had just been reserved for it, which
 * `roadsweep.mjs` duly reported as 20 impassable directions.
 *
 * So `world` solves it once, on the RAW terrain, before a single corridor is
 * laid — `netgen.orientLandmarkSites` — writes the answer into `site.yaw` and
 * the capsule's offset, and publishes it. `buildings` reads that bearing
 * instead of probing. Two subsystems deciding independently which way a
 * landmark faces is the same defect as two deciding where it is.
 */
export const LANDMARKS = [
  { id: 'lm_point', name: 'The Point Fountain', x: -452, z: 46, kind: 'fountain',
    site: { ox: 0, oz: 0, hx: 0, hz: 0, yaw: 0, r: 46 } },
  { id: 'lm_incline', name: 'Duquesne Incline', x: -488, z: 296, kind: 'incline',
    site: { ox: 0, oz: 96, hx: 0, hz: 96, yaw: 0, r: 16 },
    // `run` is the length of the funicular; the capsule is `hz` = run/2 + a
    // little either side, so it covers the lower station, the trestle and the
    // upper station's own 18 x 14 m footprint. Defaults point straight up +z
    // until `orientLandmarkSites` solves the real bearing.
    uphill: { run: 180, dir: [0, 1], rise: 0 } },
  { id: 'lm_stadium', name: 'Steel Bowl', x: -416, z: -512, kind: 'stadium',
    site: { ox: 0, oz: 0, hx: 36, hz: 14, yaw: 0, r: 80 } },
  { id: 'lm_mill', name: 'Old Blast Furnace', x: 872, z: 248, kind: 'mill',
    site: { ox: 0, oz: 0, hx: 0, hz: 0, yaw: 0, r: 72 } },
  { id: 'lm_tower', name: 'Steel Tower', x: -208, z: -16, kind: 'tower',
    site: { ox: 0, oz: 0, hx: 0, hz: 0, yaw: 0, r: 36 } },
  { id: 'lm_market', name: 'Strip Market', x: 352, z: -224, kind: 'market',
    site: { ox: 0, oz: -7, hx: 18, hz: 58, yaw: 0, r: 3 } },
];

/**
 * Metres of clear ground between a landmark site and the CENTRELINE of any
 * drivable corridor.
 *
 * It has to cover the widest carriageway in the city — a 6-lane parkway is
 * `corridorHalfWidth('highway', 6)` = 14.3 m from centreline to kerb face —
 * plus what the graph solver moves a point by after the corridors are laid:
 * `simplify` may cut a bend corner by up to its 1.6 m tolerance, the dedup
 * merge taper reaches 2.5 m past a centreline, and `nodeAt` welds within 7 m.
 * 24 m clears all of it with room, and the surplus reads as the apron or
 * plaza a landmark of this size would have anyway.
 */
export const LANDMARK_RESERVE = 24;

/**
 * Signed distance from (x, z) to a landmark `site`, in metres. Negative inside.
 *
 * The standard rounded-box field, which is exact for every shape in the table
 * above: disc, capsule and oriented box are all the same expression. Exactness
 * matters because both the reservation and the ring road are built off the
 * ISOLINES of this function.
 */
export function siteDist(lm, x, z) {
  const s = lm.site;
  if (!s) return Infinity;
  const dx = x - lm.x - s.ox;
  const dz = z - lm.z - s.oz;
  const c = Math.cos(s.yaw);
  const sn = Math.sin(s.yaw);
  const qx = Math.abs(dx * c + dz * sn) - s.hx;
  const qz = Math.abs(-dx * sn + dz * c) - s.hz;
  const ax = qx > 0 ? qx : 0;
  const az = qz > 0 ? qz : 0;
  const outside = Math.sqrt(ax * ax + az * az);
  const inside = Math.min(Math.max(qx, qz), 0);
  return outside + inside - s.r;
}

/** Distance to the NEAREST landmark site. Negative inside one of them. */
export function nearestSiteDist(x, z, out = null) {
  let best = Infinity;
  let which = null;
  for (const lm of LANDMARKS) {
    const d = siteDist(lm, x, z);
    if (d < best) {
      best = d;
      which = lm;
    }
  }
  if (out) out.lm = which;
  return best;
}

export const AIRFIELDS = [
  { id: 'af_county', name: 'Allegheny County Airfield', x: -1072, z: 784, runway: [600, 88], yaw: 0.30 },
  { id: 'af_rivers', name: 'Rivers Field', x: 1032, z: -784, runway: [512, 80], yaw: -0.42 },
];

/**
 * THE MILITARY AIRBASE — Ridgeline AFB, the biggest single site on the map.
 *
 * SITED BY SURVEY, NOT BY EYE (the coordinates were measured, 2026-08): a
 * 199-candidate scan of every map-edge rectangle big enough for a 1200 m
 * runway, scored on the real `Terrain` APIs (LS-fit centreline slope clamped
 * to the same 2.2% the civilian benches use, worst cut/fill over the whole
 * field, `waterDist`, `slopeAt`) and on the emitted road graph (edges whose
 * endpoint lands inside the field). The winner is the high shelf on the
 * north-west rim above Manchester: centreline fit -0.77% (inside the clamp),
 * worst residual 8.2 m, nearest water 578 m, ZERO drivable and ZERO rail
 * edges inside the field, 387 m clear of the nearest district circle,
 * 1.9 km from the nearest civilian airfield. Takeoff run is +a (east):
 * measured climb-out terrain past that end stays within 29 m of the bench,
 * against 87 m the other way into the Manchester rim.
 *
 * `runway` is [length, PAVED width] — unlike the civilian entries, whose
 * width is the whole strip. Everything else about the site (the L-shaped
 * field, fence polygon, gates, apron, parking, patrol loop) lives in
 * `src/world/airbase.js`, which is the one owner of every spatial fact here
 * — same contract as `world.airfields[].layout`.
 */
export const AIRBASE = {
  id: 'ab_ridge',
  name: 'Ridgeline AFB',
  kind: 'military',
  x: -675,
  z: -1390,
  yaw: 1.67,
  runway: [1200, 46],
};

export const DOCKS = [
  { id: 'dk_south', name: 'South Side Docks', x: -88, z: 280 },
  { id: 'dk_north', name: 'North Shore Slip', x: -24, z: -264 },
  { id: 'dk_point', name: 'Point Marina', x: -744, z: -88 },
];

export const SAFEHOUSES = [
  { id: 'sh_boathouse', name: "Carson's Boathouse", x: 88, z: 560 },
  { id: 'sh_bodyshop', name: 'DeCarlo Body Shop', x: 632, z: -464 },
  { id: 'sh_garage', name: "Dylan's Garage", x: -504, z: 432 },
  { id: 'sh_apartment', name: 'Triangle Apartment', x: -264, z: 96 },
  { id: 'sh_loft', name: 'Shore Loft', x: -192, z: -672 },
];

/**
 * The drive-in services: pumps, respray, ammo counters, diners.
 *
 * These coordinates MUST match `src/game/data.js` — `game` owns what a POI
 * DOES, `world` owns whether the ground under it is somewhere you can drive a
 * car onto and stand still. They are listed here so the terrain can give each
 * one a flat forecourt off the kerb (`netgen.applyServicePads`) and so
 * `world.pois` can answer "is this place reachable" without importing another
 * subsystem's module (ARCHITECTURE.md rule 2).
 */
export const SERVICES = [
  { id: 'gas_strip', name: 'Strip Fuel', x: 256, z: -72, kind: 'gas' },
  { id: 'gas_south', name: 'Carson St Gas', x: 144, z: 528, kind: 'gas' },
  { id: 'gas_west', name: 'West End Pumps', x: -952, z: 304, kind: 'gas' },
  { id: 'gas_north', name: 'Shore Service', x: -184, z: -544, kind: 'gas' },
  { id: 'gas_row', name: 'Steel Row Fuel', x: 760, z: 328, kind: 'gas' },
  { id: 'gas_law', name: 'Butler St Gas', x: 696, z: -512, kind: 'gas' },
  { id: 'shop_spray', name: 'Rustbelt Respray', x: -336, z: 176, kind: 'respray' },
  { id: 'shop_ammo', name: 'Foundry Supply', x: 384, z: -280, kind: 'ammo' },
  { id: 'shop_food', name: "Primo's Sandwich", x: -120, z: 24, kind: 'food' },
  { id: 'shop_ammo2', name: 'Row Hardware', x: 816, z: 464, kind: 'ammo' },
  { id: 'shop_food2', name: 'Incline Diner', x: -560, z: 504, kind: 'food' },
];

/**
 * Radius of the flat forecourt stamped into the terrain at a POI, and how many
 * metres it takes to blend back into the hillside. `game` triggers its drive-in
 * services at `R.service` = 11 m, so the pad has to be at least that.
 */
export const POI_PAD = { r: 17, blend: 26 };

/**
 * BRIDGES — the map's chokepoints.
 *
 * The rivers are the only thing splitting the city, so every one of these is a
 * place police will try to close and several missions stage on. `a` and `b` are
 * anchors on dry land; the generator finds the water crossing between them,
 * pins the deck at `deckY` and ramps the approaches.
 */
export const BRIDGES = [
  { id: 'br_fortduq', name: 'Fort Duquesne Bridge', river: 'allegheny', kind: 'highway', a: [-405, -35], b: [-520, -370], lanes: 4, deckY: 19, style: 'arch' },
  { id: 'br_sixth', name: 'Sixth Street Bridge', river: 'allegheny', kind: 'arterial', a: [-150, -20], b: [-235, -330], lanes: 4, deckY: 17, style: 'suspension' },
  { id: 'br_ninth', name: 'Ninth Street Bridge', river: 'allegheny', kind: 'arterial', a: [70, -140], b: [-15, -450], lanes: 4, deckY: 17, style: 'suspension' },
  { id: 'br_16th', name: 'Sixteenth Street Bridge', river: 'allegheny', kind: 'arterial', a: [352, -352], b: [268, -652], lanes: 4, deckY: 18, style: 'truss' },
  { id: 'br_31st', name: 'Thirty-First Street Bridge', river: 'allegheny', kind: 'arterial', a: [648, -596], b: [560, -900], lanes: 4, deckY: 18, style: 'truss' },
  { id: 'br_fortpitt', name: 'Fort Pitt Bridge', river: 'monongahela', kind: 'highway', a: [-372, 116], b: [-500, 392], lanes: 4, deckY: 21, style: 'arch' },
  { id: 'br_smithfield', name: 'Smithfield Street Bridge', river: 'monongahela', kind: 'arterial', a: [-96, 268], b: [-176, 552], lanes: 4, deckY: 17, style: 'truss' },
  { id: 'br_birmingham', name: 'Birmingham Bridge', river: 'monongahela', kind: 'arterial', a: [268, 436], b: [188, 724], lanes: 4, deckY: 19, style: 'truss' },
  { id: 'br_hotmetal', name: 'Hot Metal Bridge', river: 'monongahela', kind: 'street', a: [596, 620], b: [512, 900], lanes: 2, deckY: 15, style: 'truss' },
  { id: 'br_westend', name: 'West End Bridge', river: 'ohio', kind: 'arterial', a: [-856, -296], b: [-944, 16], lanes: 4, deckY: 20, style: 'arch' },
  { id: 'br_mckees', name: 'McKees Rocks Bridge', river: 'ohio', kind: 'arterial', a: [-1204, -520], b: [-1296, -172], lanes: 4, deckY: 20, style: 'truss' },
];

/** Lane geometry, shared by the mesh builder, traffic and the minimap. */
export const ROAD_KIND = {
  highway: { laneWidth: 3.9, shoulder: 2.6, sidewalk: 0, kerb: 0.0, speed: 33, paint: 'highway' },
  arterial: { laneWidth: 3.6, shoulder: 0.4, sidewalk: 3.4, kerb: 0.16, speed: 18, paint: 'arterial' },
  street: { laneWidth: 3.3, shoulder: 0.3, sidewalk: 2.7, kerb: 0.15, speed: 12, paint: 'street' },
  alley: { laneWidth: 3.0, shoulder: 0.0, sidewalk: 0, kerb: 0.0, speed: 7, paint: 'none' },
};

/** Carriageway half-width (kerb face to kerb face / 2) for an edge. */
export function roadHalfWidth(kind, lanes) {
  const k = ROAD_KIND[kind] ?? ROAD_KIND.street;
  return (lanes * k.laneWidth) / 2 + k.shoulder;
}

/** Total corridor half-width including pavements — what the terrain flattens to. */
export function corridorHalfWidth(kind, lanes) {
  const k = ROAD_KIND[kind] ?? ROAD_KIND.street;
  return roadHalfWidth(kind, lanes) + k.sidewalk;
}

// --------------------------------------------------------------- helpers --

export function clamp01(v) {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

export function smoothstep(t) {
  t = clamp01(t);
  return t * t * (3 - 2 * t);
}

export function smootherstep(t) {
  t = clamp01(t);
  return t * t * t * (t * (t * 6 - 15) + 10);
}

export function lerp(a, b, t) {
  return a + (b - a) * t;
}

/**
 * Squared distance from (px,pz) to segment (ax,az)-(bx,bz), plus the parameter.
 * Writes `out = { d2, t }` to avoid allocating in hot loops.
 */
export function segDist2(px, pz, ax, az, bx, bz, out) {
  const dx = bx - ax;
  const dz = bz - az;
  const l2 = dx * dx + dz * dz;
  let t = l2 > 1e-9 ? ((px - ax) * dx + (pz - az) * dz) / l2 : 0;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  const qx = ax + dx * t - px;
  const qz = az + dz * t - pz;
  out.d2 = qx * qx + qz * qz;
  out.t = t;
  return out;
}

/** Tile index of a world position. */
export function tileOf(x, z, out = { tx: 0, tz: 0 }) {
  out.tx = Math.floor(x / TILE);
  out.tz = Math.floor(z / TILE);
  return out;
}
