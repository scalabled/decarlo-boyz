# DECARLO BOYZ — content bible

Companion to `ARCHITECTURE.md`. That file says *how* to write code; this one says
*what the game is*. Every content decision — a district's palette, a car's
silhouette, a mission's beat — comes from here. This file is the canonical
source of truth for names, dialogue and stats.

## Premise

**Steel City** — a Pittsburgh built of three rivers, forty bridges, hillside
inclines and a dying mill economy. You play the **DeCarlo brothers**, switching
between them GTA V-style. Each has eight story chapters, his own turf, his own
rival, his own weapons and his own way of moving through the city.

## The DeCarlo Boyz

| | **Carson** | **Aidan** | **Dylan** |
|---|---|---|---|
| role | River hand · eldest | Body man · middle | Courier · youngest |
| turf | South Side / the water | Lawrenceville / Butler St | Mt. Washington / the hill |
| home | Carson's Boathouse | DeCarlo Body Shop | Dylan's Garage |
| rival | THE HARBORMASTER | DUKE MARROW | VIPER LANE |
| colour | `#2ea6a0` teal / `#7bf0d8` | `#ff6a12` slag / `#ffc93c` | `#c07cff` violet / `#5fd0ff` |
| build | heaviest, slowest, toughest | middle, best all-rounder | lightest, fastest, most fragile |
| hp / armour | 130 / 60 | 115 / 75 | 100 / 55 |
| run speed | 6.4 | 6.9 | 7.9 |
| vehicle grip | 1.06 | 1.12 | 1.22 |
| boat speed | 1.25 | 1.00 | 1.05 |
| starts with | fists, dock pipe | fists, body wrench | fists, crowbar |
| unlocks | flare, speargun, harpoon, depth charge | nail gun, paint cannon, rivet gun, nitro launcher | tack cannon, EMP coil, shop SMG, scrap rocket |
| body | skin `#f0cdae`, shirt `#1f6f6a`, pants `#26303c`, hair `#3b2a1c` | skin `#f4d4b6`, shirt `#c2410c`, pants `#1f2733`, hair `#8a5a2a` | skin `#eec9a8`, shirt `#7c3aed`, pants `#1a1f2b`, hair `#221812` |

They talk to each other constantly, on missions and over the phone. Carson is
terse and dry; Aidan is blunt and practical; Dylan never stops talking. The banter in the `story[].intro` / `.done` arrays of `src/game/data.js` is the
voice — match its register when writing new lines.

## Scale

The map table spans roughly x ∈ [-340, 270], z ∈ [-260, 235] — about 700 m.
**Multiply every map-table coordinate by 4.** `world.CITY_SIZE = 3000` metres.
That turns a walkable town into something you have to drive, which is the whole
point of the genre, while preserving the layout that the districts, rivers,
bridges and missions were authored against.

### Real sightlines — measured, not assumed

An earlier draft of this file called the Mt. Washington → downtown view "2 km".
That was wrong. Measured in world coordinates:

| view | distance |
|---|---|
| Mt. Washington clifftop → Golden Triangle | **498 m** |
| Hazelwood → downtown | **1 222 m** |
| Allegheny County Airfield → downtown | **1 106 m** |

Mt. Washington and downtown are *neighbours across one river* — which is exactly
what they are in the real Pittsburgh, and the reason that view is famous is the
600 m drop and the river in between, not the distance. Keep it as the signature
composition, but the genuinely long looks that test LOD, impostors and aerial
perspective are Hazelwood and the airfields. Draw distance still has to hold to
`q.drawDistance` because the hills beyond the city are further again.

## Geography

Three rivers meet at **The Point** (map `(-150, 10)` → world `(-600, 40)`).

| river | width (map → world) | path (map coords, ×4 for world) |
|---|---|---|
| Allegheny | 36 → 144 | `(228,-252) (150,-196) (66,-136) (-16,-82) (-88,-40) (-150,10)` |
| Monongahela | 34 → 136 | `(236,232) (156,182) (74,132) (-8,86) (-84,46) (-150,10)` |
| Ohio | 46 → 184 | `(-150,10) (-214,-24) (-268,-68) (-336,-124)` |

The rivers cut the city into three land masses; **bridges are the only road
crossings** and are therefore the map's chokepoints — police roadblocks, chases
and several missions are staged on them. Mt. Washington rises steeply on the
south bank with the Duquesne Incline climbing it; downtown sits in the triangle.

## Districts

Map-table coords, ×4 for world. `tall` is the relative building-height multiplier
that `buildings` should honour; `tint` biases the district palette.

| id | name | x, z | r | tall | tint |
|---|---|---|---|---|---|
| `point` | THE POINT | -168, 4 | 62 | 0.10 | 0.30 0.36 0.30 |
| `downtown` | GOLDEN TRIANGLE | -58, 16 | 100 | 1.00 | 0.36 0.38 0.44 |
| `strip` | THE STRIP | 62, -46 | 86 | 0.55 | 0.42 0.34 0.28 |
| `lawren` | LAWRENCEVILLE | 170, -138 | 96 | 0.42 | 0.40 0.33 0.30 |
| `northsh` | NORTH SHORE | -40, -150 | 104 | 0.50 | 0.31 0.36 0.40 |
| `troy` | TROY HILL | 130, -258 | 90 | 0.30 | 0.34 0.38 0.32 |
| `southside` | SOUTH SIDE | 40, 152 | 108 | 0.45 | 0.40 0.35 0.30 |
| `mtwash` | MT. WASHINGTON | -132, 116 | 92 | 0.28 | 0.33 0.37 0.33 |
| `steelrow` | STEEL ROW | 196, 96 | 100 | 0.62 | 0.44 0.32 0.26 |
| `westend` | WEST END | -258, 92 | 96 | 0.30 | 0.35 0.36 0.33 |
| `northside` | MANCHESTER | -246, -142 | 92 | 0.32 | 0.34 0.35 0.38 |
| `hazel` | HAZELWOOD | 246, -14 | 86 | 0.36 | 0.40 0.34 0.28 |

Each district needs a **readable identity from a distance**: Golden Triangle is
glass towers; Steel Row is a mill site of rust, gantries and a blast furnace;
Lawrenceville is brick rowhouses and shopfronts; Mt. Washington is timber houses
on a cliff with the city view; South Side is flat industrial riverfront; the
North Shore has the stadium.

## Landmarks

**These are MAP-TABLE coordinates and they are NOT the shipped ones.** They are the
original single-file map's numbers; the world is that map at ×4 (see "Scale").
`src/world/plan.js` is the source of truth for where a landmark actually is —
read it, do not multiply this table by four.

| id | name | map x, z | ×4 | SHIPPED (`world/plan.js`) | kind |
|---|---|---|---|---|---|
| `lm_point` | The Point Fountain | -178, 8 | ~~-712, 32~~ | **-452, 46** | fountain |
| `lm_incline` | Duquesne Incline | -122, 74 | -488, 296 | -488, 296 | incline (working funicular up Mt. Washington) |
| `lm_stadium` | Steel Bowl | -104, -128 | -416, -512 | -416, -512 | stadium |
| `lm_mill` | Old Blast Furnace | 218, 62 | 872, 248 | 872, 248 | mill |
| `lm_tower` | Steel Tower | -52, -4 | -208, -16 | -208, -16 | tower (tallest building, dark steel) |
| `lm_market` | Strip Market | 88, -56 | 352, -224 | 352, -224 | market |

**Why `lm_point` breaks the rule.** The naive ×4 puts the fountain at
(-712, 32), which is `heightAt = -8.68 m` and `isWater = true` — 112 m
DOWNSTREAM of the confluence, in the middle of the Ohio's 184 m channel. The
scaling does not survive rivers that were widened to match the new scale. The
shipped (-452, 46) is dry at +3.56 m, on the wedge between the Allegheny and the
Monongahela: the actual tip of the triangle, which is the whole point of The
Point.

`src/buildings/landmarks.js` carried the ×4 value and was the lone dissenter
against `plan.js`, `game/data.js` and `ui/data.js`; it now adopts the sites from
`world` rather than duplicating them. **Any other coordinate in this document is
suspect in the same way** — if it lands in a river or on a cliff, the ×4 is the
reason, and `plan.js` wins.

Airfields: **Allegheny County Airfield** (-268, 196, runway 150×22) and **Rivers
Field** (258, -196, runway 128×20). Docks: South Side Docks (-22, 70), North
Shore Slip (-6, -66), Point Marina (-186, -22).

Safehouses (save + wardrobe + garage): Carson's Boathouse (22, 140), DeCarlo Body
Shop (158, -116), Dylan's Garage (-126, 108), Triangle Apartment (-66, 24),
Shore Loft (-48, -168).

Shops: Rustbelt Respray (-84, 44, respray to lose heat), Foundry Supply
(96, -70, ammo), Row Hardware (204, 116, ammo), Primo's Sandwich (-30, 6, health),
Incline Diner (-140, 126, health). Six gas stations — see `GAS_STATIONS`.

Collectibles: **12 hidden packages**, `HIDDEN_PACKAGES`.
Race circuits: `triangle`, `riverloop`, `southrun` — `RACE_TRACKS`.

## Vehicles

The map-table stats are arcade units; `vehicles` should reinterpret them as real
dynamics (kg, Nm, tyre loads) while preserving the **relative** feel and the
silhouettes. Every class must be recognisable in silhouette alone.

| id | name | L×W×H | mass | top | accel | grip | steer | seats | notes |
|---|---|---|---|---|---|---|---|---|---|
| `sports` | Peregrine GT | 4.6×2.0×1.15 | 1.00 | 47 | 26 | 9.5 | 0.70 | 2 | low wedge |
| `muscle` | Ironside 440 | 5.1×2.15×1.28 | 1.25 | 44 | 24 | 7.4 | 0.62 | 2 | long bonnet, squat |
| `sedan` | Allegheny 4dr | 4.8×2.05×1.40 | 1.10 | 34 | 18 | 8.2 | 0.66 | 4 | the traffic default |
| `van` | Foundry Van | 5.6×2.3×2.3 | 1.60 | 30 | 15 | 6.6 | 0.55 | 2 | tall box, rolls |
| `truck` | Millhand 6 | 7.2×2.6×2.9 | 2.60 | 27 | 12 | 5.6 | 0.44 | 2 | flatbed, mill livery |
| `police` | Precinct Cruiser | 5.0×2.1×1.45 | 1.15 | 45 | 25 | 9.0 | 0.68 | 4 | black/white, lightbar |
| `bike` | Slagbolt | 2.3×0.9×1.2 | 0.45 | 52 | 34 | 8.0 | 0.95 | 1 | leans, rider exposed |
| `boat` | Riverjack | 6.4×2.4×1.5 | 1.40 | 36 | 15 | 2.2 | 0.60 | 3 | planes at speed, wake |

Boats matter — Carson's whole arc is on the water, and the rivers are a third of
the map. Buoyancy, planing, wake and spray are not optional.

## Weapons

Improvised, industrial, blue-collar. Nothing military. Full table in
`WEAPON_LIB` (`src/game/data.js`); the shape of it:

- **Melee** — fists, Dock Pipe, Body Wrench, Crowbar.
- **Light** — Nail Gun, Tack Cannon, Paint Cannon (spread), Shop SMG.
- **Heavy/precise** — Flare Gun (burning tracer), Spear Gun, Rivet Gun, Harpoon.
- **Explosive** — Nitro Launcher, Depth Charge, Scrap Rocket, EMP Coil (kills
  engines and lights — the signature toy).

## Mission structure

24 story chapters — 8 per brother — plus free-roam side activities. Chapter data
(names, zones, dialogue, cash, respect, unlocks, difficulty) is in
`BOYZ.<id>.story` (`src/game/data.js`). The mission **track types** the `game` system must implement:

`deliver` · `timedDeliver` · `race` (checkpoint circuits, laps) · `chase` (run a
target down) · `escape` (shed N wanted stars) · `escort` (protect a slow ally) ·
`collect` (N pickups in time) · `goons` / `brawl` (kill N) · `survive` (hold for
N seconds) · `rampage` (destroy N targets on a clock) · `boss`.

Bosses: THE HARBORMASTER (1400 hp, 3 phases, brute, armour on his front — flank
him), BRICK (Duke's enforcer), DUKE MARROW, VIPER LANE. Full table in `BOSSES`
(`src/game/data.js`).

Economy: cash + **respect**. Chapters pay $700 → $7,200. Respect unlocks
weapons, vehicles and safehouses.

## Wanted system

Stars 1–5. Escalation: 1★ single cruiser → 2★ two cars, active pursuit → 3★
roadblocks and spike strips → 4★ heavy units, helicopter → 5★ the bridge is
closed and they will ram you. **Respray at Rustbelt Respray clears heat**;
so does breaking line of sight long enough outside a search cone. Bridges are the
natural chokepoint — police prefer to block them.

## Radio

Six synthesized stations, each a generative loop (scale, bpm, waveform, root):

| id | station | bpm | feel |
|---|---|---|---|
| `grease` | GREASE FM | 118 | garage rock, sawtooth |
| `gold` | BLACK & GOLD | 92 | soul, triangle |
| `redline` | REDLINE | 146 | drum machine, square |
| `slack` | SLACKWATER | 68 | ambient, sine |
| `furnace` | FURNACE 101 | 132 | industrial, sawtooth |
| `incline` | INCLINE AM | 84 | old country, triangle |

Each brother has his own station rotation — see `BOYZ.*.radio`.

## Art direction

Palette: **sodium-lamp amber, molten slag orange, river teal, cold steel**, over
a wet grey-brown rustbelt base. Not Los Santos pastel — this is a colder,
heavier, more industrial city, and the contrast with GTA V's palette is the point
of difference. Signature motif: the **Slag Ring**, the cast-iron minimap bezel
that heats to molten orange as the wanted level climbs.

Weather leans wet: overcast, river fog at dawn, rain that makes the asphalt
mirror the sodium lamps, steam from grates and mill stacks. Golden hour over the
Ohio is the money shot; night downtown with wet streets is the second.
