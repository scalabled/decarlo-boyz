/**
 * VEHICLES — dynamics, procedural meshes, damage, lights.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * PUBLIC API  —  const veh = ctx.get('vehicles')
 * ────────────────────────────────────────────────────────────────────────────
 *   spawn(type, position, yaw, opts?) -> Vehicle    types: see DESIGN.md
 *   despawn(vehicle)
 *   nearest(x, y, z, radius, filter?) -> Vehicle | null
 *   setInput(vehicle, { throttle, brake, steer, handbrake, reverse, horn, boost })
 *   applyHero(vehicle, on)            attach the driver's grip / gearing / boat
 *   activeBrother()                   the brother `applyHero` reads, or null
 *   seatAnchor(vehicle, seat) -> { position, enter, yaw, local }
 *   setDoor(vehicle, seat, open01)    swing a door   / doorState(vehicle, seat)
 *   refuel(vehicle, tankPercent) -> percent actually added   (gas stations)
 *   repair(vehicle, healthPoints) -> health actually restored (body shop)
 *   setHorn(vehicle, on)
 *   getHudState() -> { fuel, fuelDry, health, speedKmh, rpm, gear, ... } | null
 *   vehicles                          live Vehicle[]
 *   classes                           the eight class ids
 *   specOf(type)                      the finalised spec
 *   setDriver(vehicle, actor, seat)   / clearDriver(vehicle)
 *   damage(vehicle, amount, point)    external damage (bullets, explosions)
 *   telemetry(vehicle)                speed / slip / loads, for tools + HUD
 *   prewarmMaterials(ctx)
 *
 * A Vehicle exposes: position, quaternion, velocity, speed, forwardSpeed,
 * slipAngle, rpm, health, destroyed, fuel (0-100), fuelDry, horn, wheels[],
 * model.root, spec — plus, since the parity pass:
 *
 *   altitude     metres above the ground beneath it. ZERO on anything with
 *                wheels, and it stays zero, so a consumer never has to ask what
 *                kind of vehicle it has.
 *   blocksPeds   FALSE while a helicopter is above `rotor.pedBlockAlt` (2 m).
 *                See CONTRACTS below.
 *   submerged    fraction of the body under the waterline, 0..1
 *   drowned      the engine has ingested the river; `repair()` is what undoes it
 *   hero         { id, grip, top, boat } — the driver's own modifiers, identity
 *                for every AI, parked and benched vehicle
 *
 * EVENTS EMITTED (see ARCHITECTURE.md)
 *   vehicle:collision { vehicle, other, point, normal, impulse, speed }
 *   vehicle:skid      { vehicle, wheel, point, normal, slip, surface }
 *   vehicle:engine    { vehicle, rpm, throttle, gear, load, speed }
 *   vehicle:destroyed { vehicle, point }
 *   vehicle:horn      { vehicle, on, position }             edges only
 *   vehicle:fuel      { vehicle, fuel, dry, player }        edges only
 *   vehicle:drowned   { vehicle, position, player }    NEW — edges only
 *
 * The last three are not in ARCHITECTURE.md's table; that file sits outside
 * this directory (hard rule 1), so they are reported up instead rather than
 * edited in. `audio` should play a horn on `vehicle:horn`, `traffic`/`peds`
 * can react to it, `ui` can toast on `vehicle:fuel` with `dry: true`, and
 * `audio` should cough and cut the engine loop on `vehicle:drowned`.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * CONTRACTS OWED BY OTHER SUBSYSTEMS — reported, not edited
 * ────────────────────────────────────────────────────────────────────────────
 *   physics   `_refreshBlockers` should skip a vehicle with `blocksPeds ===
 *             false`, one line beside the existing `v.destroyed || v._staged`
 *             test. Without it the cut happens where the box says rather than
 *             at the specified 2 m: `_pushOutOfVehicles`'s vertical
 *             gate already exempts a machine whose underside clears a standing
 *             man, which for this airframe is 3.3 m rather than 2.0. Nobody is
 *             shoved from the air either way; the flag makes the boundary
 *             stated instead of inferred. `drivetest.mjs` gates both halves.
 *   traffic   the three new classes are NOT in `DISTRICT_MIX`, so none of them
 *             can appear in ambient traffic by accident. A bus belongs on
 *             arterials only; a bicycle belongs on the flat riverfront and not
 *             in the rain (`pickClass` already halves `bike` for wetness); a
 *             helicopter belongs at a pad, not on a lane.
 *   game      free-roam placement of the helicopter, the boats at the three
 *             DOCK markers and a bicycle or two is a spawn-director decision:
 *             `vehicles` owns the vehicle, `game`/`traffic` own where one is.
 *   audio     `engineProfileFor` matches on the class name and has no entry for
 *             `bus`, `bicycle` or `heli`; all three currently fall back to the
 *             sedan's inline four. A bicycle should be SILENT (`spec.nogas`
 *             is the flag), a bus wants a big slow diesel, and a helicopter
 *             wants a rotor, not an engine — `v.rotorSpin` is 0..1 and
 *             `v.rotorPhase` is the blade angle.
 *   player    the HUD gauge labelled NITRO is a STAMINA bar on a bicycle
 *             (`getHudState().noFuel` is true and there is no tank to draw
 *             either), and on the helicopter SHIFT is the collective rather
 *             than a bottle. `getHudState()` publishes `flying`, `altitude`,
 *             `climbRate` and `rotor` for an altimeter.
 *   camera    the bus is `bus`, 9.6 x 2.55 x 3.15 m, half-length 4.8 m; the
 *             helicopter is `heli`, 9.0 x 2.24 x 3.05 m with a 10 m rotor disc
 *             that is NOT bodywork; the bicycle is `bicycle`, 1.82 x 0.56 x
 *             1.12 m. A 9.6 m bus needs a noticeably larger camera radius than
 *             a car does to frame at all.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * THERE IS DELIBERATELY NO `eject()`
 * ────────────────────────────────────────────────────────────────────────────
 * `player`'s carjack used to call `vehicles.eject()`, which never existed, so
 * "PULL OUT" played the whole animation and left the driver sitting there. The
 * fix is not to add the method. A driver is an ACTOR — a ped with a skeleton, a
 * navmesh position, a panic state and a ragdoll — and this subsystem owns none
 * of that; it could only ever have cleared the seat and left a body inside a
 * closed car. The working call is `peds.pullFromVehicle(vehicle, doorPoint)`,
 * which `player` now makes, with `traffic.abandon()` to release the AI driver.
 * `clearDriver()` covers the half that IS this subsystem's (seat, engine, fuel flag,
 * `vehicle:exit`). A half-implemented `eject()` would just re-create the
 * original silent no-op with a name that promises otherwise.
 */

import * as THREE from 'three';
import {
  VEHICLE_SPECS, CLASS_IDS, PAINTS, finalizeSpec, SURFACE_GRIP, WET_SENS, wetGrip,
  heroMods, HERO,
} from './specs.js';
import { VehicleMaterials } from './paint.js';
import { buildVehicleModel, modelStats, clearGeometryCache, LOD_COUNT, setVehicleLod } from './build.js';
import { Vehicle } from './dynamics.js';
import { DamageModel } from './damage.js';
import { VehicleGroundShadows } from './groundshadow.js';

const LOD_DIST = [22, 52, 130];
/** How far a door swings at `open = 1`, radians. 62 degrees. */
const DOOR_ANGLE = 1.08;

/**
 * ────────────────────────────────────────────────────────────────────────────
 * THE HP SCALE, AND THE ONE NUMBER THAT CONVERTS INTO IT
 * ────────────────────────────────────────────────────────────────────────────
 * Vehicle bodies are priced 90-3000 (`specs.js` `body.hp`). ACTORS —
 * pedestrian, enemy, player — are priced at roughly 100 apiece, close enough to
 * each other that one blast number can be handed out and mean the same thing to
 * a man as to a van.
 *
 * The wide vehicle scale is deliberate: it is what carries the per-class
 * durability spread (a Steelhauler is 33 times a Towpath bicycle) and
 * `DamageModel.impact`'s collision coefficient was derived against it. Actors
 * stay at ~100. So the two scales are a factor of ten apart,
 * and EVERY damage source that is authored in actor points — a weapon's
 * `damage`, an `explosion` payload, a melee `dmg` — has to be converted before
 * it may touch a body.
 *
 * That conversion was missing everywhere except collisions, and one missing
 * factor of ten broke three separate features at once:
 *
 *   - a 90-round Nail Gun magazine could not wreck a parked sedan (75 nails
 *     measured, 16.5 s of continuous fire),
 *   - all seven Scrap Rockets fired point blank left the sedan alive (11
 *     measured to wreck one),
 *   - and a wrecked car did ~3% of its neighbour's health, so the chain
 *     detonation this file has always listened for could never fire.
 *
 * ONE number, published on the system so that `weapons` does not have to
 * hard-code the vehicle HP scale (`weapons/vehiclehit.js` reads
 * `veh.actorDamageScale`) and so there is exactly one place to change it if the
 * body scale ever moves. Anything that already speaks in vehicle points —
 * `DamageModel.impact`, `game/tracks.js`'s scripted mission damage,
 * `police/tune.js`'s own `vehicleScale` — must NOT be multiplied by it again.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * ...AND IT IS 2.5, NOT 10, BECAUSE THIS IS NOT THE RATIO OF THE TWO SCALES
 * ────────────────────────────────────────────────────────────────────────────
 * It was set to 10 on the reasoning above — 900-point bodies, 100-point actors,
 * therefore ten. That fixed a real bug (see the three broken features listed
 * above; they were all measured and all genuinely broken) and it overshot,
 * because "how many points is this body worth" and "how much of an actor point
 * does this body eat" are different questions and only the first one is ten.
 *
 * Setting them equal asserts that a car is exactly as easy to shoot out as nine
 * men standing in a row. It is not: a car is a steel box and small-arms fire is
 * the WRONG TOOL against it. MEASURED at 10, on the real ray/OBB solve into a
 * real `Vehicle`: six Nail Gun rounds — 1.3 seconds of fire — wrecked a parked
 * sedan, and a wreck detonates, so every car anyone shot at exploded.
 *
 * 2.5 is deliberately the geometric middle of the two states this project has
 * now shipped, both of which were wrong: 83 nails before the conversion
 * existed, 6 after. It lands at 23 nails / 25 SMG rounds on a sedan — most of a
 * magazine, four seconds of fire, a car you have to commit to killing.
 *
 * THE EXPLOSIVE PATH IS NOT PART OF THIS. `BLAST_TRANSFER` is raised by exactly
 * the same factor below, so blast damage to a vehicle comes out unchanged —
 * `damageprobe`'s BLAST and CHAIN sections print the same numbers either side
 * of this edit. That half was verified live and was never the defect; a rocket
 * must still write a car off.
 *
 * MIRROR TO PATCH, outside this directory: `src/police/tune.js` keeps
 * `vehicleScale: 10` as a copy of this constant (its own comment says so, and
 * `node src/police/copfireprobe.mjs` exists to report the drift). It must
 * become 2.5 in the same wave or police rounds will be the only actor-scale
 * source in the game still doing four times what everything else does.
 */
export const ACTOR_TO_VEHICLE = 2.5;

/**
 * The nominal 100-point car body. This is NOT a damage conversion — `damage()`
 * is handed this file's own points and keeps them. It is the yardstick the
 * panel-dent COEFFICIENTS were authored against, so a hit can be expressed as
 * "what this would have been on a 100-point car" before being turned into
 * millimetres of sheet metal. Deliberately separate from `ACTOR_TO_VEHICLE`: one is about how
 * much health a bullet takes, the other about how big the hole looks, and
 * tying them together made the crater a function of a bookkeeping constant.
 */
const REFERENCE_BODY_HP = 100;

/**
 * Blast damage to a vehicle, as a fraction of the blast's actor-scale damage at
 * the epicentre. A vehicle takes the FULL number, falling off linearly with
 * distance across `radius * 1.2`, so the rule is 1: a car in the fireball takes
 * what a man in the fireball takes, on its own scale.
 *
 * It used to be 0.5 ON TOP OF the missing factor of ten, which is how the
 * epicentre of a 140-point car wreck came to be worth 70 points against a
 * 900-point sedan.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * IT IS 4.0 SO THAT `ACTOR_TO_VEHICLE * BLAST_TRANSFER` IS STILL 10
 * ────────────────────────────────────────────────────────────────────────────
 * The rule is "the full number, on the vehicle's own scale", and the vehicle's
 * own scale is a factor of ten off the actor scale — that product is the thing
 * the rule pins down, and it is 10. `ACTOR_TO_VEHICLE` has since
 * been re-purposed from "the ratio of the scales" into "what a car eats of an
 * actor-scale point", which is 2.5 for a bullet and is NOT 2.5 for a blast: a
 * fireball wraps a four-metre steel box, it does not have to find a way in.
 *
 * So this carries the difference, and the arithmetic is deliberately arranged
 * so that 2.5 * 4.0 = 10 and EVERY blast number in the game — one rocket to a
 * sedan, the 40.7% bite a wreck takes out of the car parked beside it, five of
 * six in a car park going up — comes out identical to every digit
 * `damageprobe` prints. That half was verified live and was correct; only the
 * small-arms half overshot. If you change one of these two, look at the other.
 */
const BLAST_TRANSFER = 4.0;

/**
 * How far past `radius` blast DAMAGE reaches a vehicle. Vehicles get a wider
 * envelope than actors (`radius * 1.2` vs
 * `radius`) because a car is a four-metre object being asked about by its
 * centre point. The IMPULSE keeps its own, wider reach below — being shoved by
 * a blast you were not damaged by is correct and looks right.
 */
const BLAST_DAMAGE_REACH = 1.2;
/** ...and the reach of the shove. Unchanged; this was never the defect. */
const BLAST_SHOVE_REACH = 1.35;

/**
 * ────────────────────────────────────────────────────────────────────────────
 * WHICH SIDE THE DRIVER SITS ON. STEEL CITY IS PITTSBURGH: THE LEFT.
 * ────────────────────────────────────────────────────────────────────────────
 * A vehicle's nose is local +Z. In three's right-handed basis a body facing +Z
 * has its RIGHT along -X — the same derivation `traffic/driver.js` writes out in
 * its header and the same one the steering section of `drivetest.mjs` measures
 * off the camera basis. So the car's LEFT is local +X.
 *
 * `seatAnchor` used to hand seat 0 a side of -1, which is the car's right, and
 * `interior.js` put the steering wheel, the binnacle and the column at the same
 * -X. They agreed with each other, so nothing looked inconsistent from inside
 * the code — the fleet was simply RIGHT-HAND DRIVE, in an American city, which
 * is what the player saw. The entry animation, the door that swings, the exit
 * probe and the cockpit camera all follow the anchor's `side`, so this constant
 * is the single place the layout is decided.
 *
 * `+1` = the driver sits on the car's LEFT (local +X), i.e. left-hand drive.
 * `drivetest.mjs`'s `layout` section asserts the sign geometrically, against a
 * right-vector it derives from three's camera basis rather than from this file,
 * so a mirrored layout cannot pass it.
 */
const DRIVER_SIDE = 1;

/* ---- seating package, see `seatAnchor` -------------------------------- */
/** How far the driver's head centre sits above the belt line (bottom of glass). */
const HEAD_OVER_BELT = 0.20;
/**
 * How far `player`'s SEATED rig stacks the crown over the head bone. From
 * `src/player/character/mesh.js` BONE_SPEC via `src/player/drivetest.mjs`:
 * crown 1.79 - head 1.548 = 0.242, and `_poseDriving`'s hip drop moves both
 * together so the difference is invariant.
 */
const CROWN_OVER_HEAD = 0.242;
/** Air between the crown and the headliner. */
const CROWN_CLEAR = 0.06;
/** Anthropometric cap: head centre over the floor he is sitting above. */
const HEAD_OVER_FLOOR = 1.05;

/**
 * Car-to-car contact stiffness, newtons per metre of overlap. Sized so a car
 * leaning on the one in front with its whole 8 kN of traction sinks about 3 cm
 * into it before the push balances — visible as a nudge, not as interpenetration
 * — and so the pair's contact frequency is ~2.5 Hz, comfortably inside a 120 Hz
 * step. See the note in `_pairResolve`.
 */
const CONTACT_K = 3.0e5;

const _v = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _v3 = new THREE.Vector3();
const _n = new THREE.Vector3();
const _cam = new THREE.Vector3();
const _fwd = new THREE.Vector3();

/**
 * Per-instance paint tones. Value scale plus a small warm/cool shift — the two
 * things that actually differ between two cars ordered in "the same" colour ten
 * years apart, one of which has lived under a tree and one in a garage.
 * Index 2 is the catalogue colour exactly.
 */
const PAINT_TONES = [
  { v: 0.84, w: 0.98 },
  { v: 1.00, w: 1.00 },
  { v: 1.15, w: 1.03 },
];
/** Condition steps: how much road film and rust the shader composites. */
const PAINT_WEARS = [0, 0.5];

/**
 * EVERY paint the spawner can produce, enumerated ONCE.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * WHY THIS IS A FUNCTION AND NOT TWO LISTS
 * ────────────────────────────────────────────────────────────────────────────
 * `prewarmMaterials` and `_choosePaint` used to derive the paint key
 * independently, and they DID NOT AGREE — so a large fraction of the fleet was
 * being warmed with keys no car ever asks for while the keys cars do ask for
 * compiled during play. Two concrete mismatches, both pre-existing:
 *
 *   - the pre-warm passed `clearcoat: p.c` from the PAINTS table, but
 *     `buildVehicleModel` overrides it to `finish === 'gloss' ? 1 : 0.2`. Every
 *     colour in the `work` pool (fleet white, mill grey, foundry blue, primer,
 *     rust brown — carried by vans, trucks and lorries) has `c` between 0.10
 *     and 0.40, so all five were warmed at the wrong key and none of them was
 *     ever warmed at the right one.
 *   - beaters — one car in six — spawn as `matte`/`primer` at `flake: 0.04` in
 *     a POOL colour, while the pre-warm only built matte and primer in three
 *     hardcoded greys at `flake: 0`. Not one beater in the game was covered.
 *
 * A miss is not free even though every one of these shares a single program:
 * three still runs `initMaterial` and binds a fresh uniform list the first time
 * a material is drawn, and that lands as a hitch in the middle of play, on a
 * build whose p99 is already the thing everyone is chasing.
 *
 * So there is now one generator, `_choosePaint` INDEXES INTO IT and
 * `prewarmMaterials` ITERATES IT, and they cannot drift apart. The set is
 * deliberately small — 3 tones x 2 condition steps x 21 catalogue colours,
 * plus one beater pair per colour — because every entry is a material object
 * that has to be built and bound at boot even though they all share one
 * program.
 */
function paintVariants() {
  const out = [];
  for (const poolName of Object.keys(PAINTS)) {
    for (const p of PAINTS[poolName]) {
      for (let t = 0; t < PAINT_TONES.length; t++) {
        for (const w of PAINT_WEARS) {
          out.push({
            pool: poolName, paintName: p.name, tone: t,
            paint: tonePaint(p.color, t), finish: 'gloss', flake: p.f, wear: w,
          });
        }
      }
      // Beaters keep the catalogue tone — a car that has been resprayed matte
      // or left in primer is already visually distinct without a second axis.
      for (const f of ['matte', 'primer']) {
        out.push({
          pool: poolName, paintName: p.name, tone: 1,
          paint: tonePaint(p.color, 1), finish: f, flake: 0.04, wear: PAINT_WEARS[PAINT_WEARS.length - 1],
        });
      }
    }
  }
  return out;
}

const _tc = new THREE.Color();
/** Built once, at module load: the spawner picks from it, the pre-warm builds it. */
let VARIANTS = null;
/** Deterministic, quantised tone shift. Returns a plain sRGB hex. */
function tonePaint(hex, tone) {
  const t = PAINT_TONES[tone] ?? PAINT_TONES[2];
  _tc.setHex(hex, THREE.SRGBColorSpace);
  // In linear space, so the shift is a real exposure change rather than a
  // gamma-space smear that desaturates dark colours into grey.
  const r = Math.min(1, _tc.r * t.v * t.w);
  const g = Math.min(1, _tc.g * t.v);
  const b = Math.min(1, _tc.b * t.v * (2 - t.w));
  _tc.setRGB(r, g, b, THREE.LinearSRGBColorSpace);
  return _tc.getHex(THREE.SRGBColorSpace);
}
const _q = new THREE.Quaternion();

export class VehicleSystem {
  static id = 'vehicles';
  static deps = ['physics', 'materials', 'render'];

  /**
   * PUBLISHED: multiply an actor-scale damage number by this before handing it
   * to `damage()`. See `ACTOR_TO_VEHICLE`. It lives on the instance so that
   * `weapons` can read it through `ctx.peek('vehicles')` instead of importing
   * this module (hard rule 2) or keeping a second copy of the number, which is
   * how two subsystems end up owning one fact.
   */
  actorDamageScale = ACTOR_TO_VEHICLE;

  /**
   * PUBLISHED, and it is a DIFFERENT number from `actorDamageScale` — read this
   * one if what you hold is a blast rather than a round.
   *
   * A car eats a quarter of what a man eats from small-arms fire and all of it
   * from a fireball, so the two questions have two answers (see
   * `ACTOR_TO_VEHICLE` and `BLAST_TRANSFER`). Until this pass they were the same
   * number and every caller could get away with not knowing which it had.
   *
   * `_explosionDamage` uses it. `police/tune.js` keeps a hand-copied mirror of
   * the OLD single number (`vehicleScale: 10`), which is why a cop's round is
   * currently worth four times what the player's identical round is worth
   * against the same car — the mirror is now the blast answer applied to
   * bullets. The fix belongs in `src/police/`.
   */
  blastDamageScale = ACTOR_TO_VEHICLE * BLAST_TRANSFER;

  async init(ctx) {
    this.ctx = ctx;
    this.rng = ctx.rng.fork();
    this.physics = ctx.peek('physics');
    this.render = ctx.peek('render');
    this.vehicles = [];
    this.classes = CLASS_IDS;

    this._specs = new Map();
    for (const id of CLASS_IDS) this._specs.set(id, finalizeSpec(VEHICLE_SPECS[id]));

    this.mats = new VehicleMaterials(ctx).build();
    if (!VARIANTS) VARIANTS = paintVariants();

    this.root = new THREE.Group();
    this.root.name = 'vehicles';
    ctx.scene.add(this.root);

    /**
     * Ground contact. See `groundshadow.js` for the measurement that motivated
     * it — the road UNDER a parked car was reading 15% brighter than the open
     * asphalt beside it, because nothing occluded it at all. Two InstancedMesh
     * draws for the whole fleet; the per-tyre pool is sized off the traffic
     * budget so a busy junction cannot overrun it.
     */
    const shadowCars = Math.min(64, Math.max(12, (ctx.config?.q?.trafficBudget ?? 40)));
    this.groundShadows = new VehicleGroundShadows(shadowCars, 64);
    ctx.scene.add(this.groundShadows.group);
    /**
     * A/B switch, `?owNoCarShadow=1`. Hard rule 12: the only honest way to say
     * what this pool is worth is to photograph THE SAME FRAME with it off and
     * measure the pixels, because the staged camera is re-derived from the
     * subject every frame and a car that has settled two centimetres puts the
     * road under a different pixel. Comparing absolute pixel coordinates across
     * two captures would have measured the settle, not the shadow.
     */
    if (typeof location !== 'undefined' &&
        new URLSearchParams(location.search).has('owNoCarShadow')) {
      this.groundShadows.group.visible = false;
      this._noCarShadow = true;
    }

    this._engineTimer = 0;
    this._debugSpawned = [];
    this._stats = { count: 0, lod: [0, 0, 0, 0], stepMs: 0 };

    this._buildHeadlightPool(ctx);

    // Capture hook: an inline shot may carry `"veh": "<stage>"` and this
    // subsystem stages itself. Lets any camera in the repo see vehicles without
    // editing a file outside this directory.
    this._onShot = (e) => {
      const stage = e?.shot?.veh;
      // `shot.apply` runs BEFORE this event, so a shot that posed a hero car
      // through `debugPose` must not have it torn down again a tick later.
      const posed = this._poseStaged;
      this._poseStaged = false;
      if (stage) this.debugStage(stage, e.shot);
      else if (this._debugSpawned.length && !posed) this.debugStage('none');
    };
    ctx.events.on('shot:applied', this._onShot);

    this._onExplosion = (e) => this._explosionDamage(e);
    ctx.events.on('explosion', this._onExplosion);

    /**
     * WET ROADS. `sky` owns the wetness integral and pushes it on
     * `weather:change` at up to 4 Hz; here it becomes the tyre's friction
     * coefficient, per surface, through `WET_SENS`. This is the hook that made
     * the weather system a GAMEPLAY system: at full soak an asphalt road gives
     * back 30% less grip, so the same corner at the same speed understeers, the
     * same braking marker arrives 40% too late, and a rear-drive car will step
     * out on the throttle where it would not have in the dry.
     *
     * It is one shared table rather than a per-wheel multiply so that the cost
     * is a handful of multiplies when the weather changes, and zero per frame.
     */
    this.wetness = 0;
    this.gripTable = {};
    for (const k in SURFACE_GRIP) this.gripTable[k] = { ...SURFACE_GRIP[k] };
    this._onWeather = (e) => {
      if (e && typeof e.wetness === 'number') this.setWetness(e.wetness);
    };
    ctx.events.on('weather:change', this._onWeather);
    const sky = ctx.peek('sky');
    if (sky && typeof sky.wetness === 'number') this.setWetness(sky.wetness);

    /**
     * `player/vehicle.js` emits `vehicle:enter` / `vehicle:exit` DIRECTLY and
     * never calls `setDriver`, so keying the fuel flag off `setDriver` alone
     * meant the player's car never burned a drop. Listen to the events as well
     * — both paths are idempotent.
     */
    this._onEnter = (e) => {
      if (!e?.vehicle || (e.seat ?? 0) !== 0) return;
      if (this._isPlayerActor(e.actor)) {
        e.vehicle.burnsFuel = true;
        // Two pedals on a keyboard: arm hold-brake-to-reverse. AI drivers never
        // get it — see `drivetrain.js`.
        e.vehicle.autoReverse = true;
        this.applyHero(e.vehicle, true);
      }
    };
    this._onExit = (e) => {
      if (!e?.vehicle) return;
      if (this._isPlayerActor(e.actor)) {
        e.vehicle.burnsFuel = false;
        e.vehicle.autoReverse = false;
        this.applyHero(e.vehicle, false);
      }
      this.setHorn(e.vehicle, false);
    };
    ctx.events.on('vehicle:enter', this._onEnter);
    ctx.events.on('vehicle:exit', this._onExit);

    /**
     * PER-HERO VEHICLE MODIFIERS. `game` switches brother mid-session — at a
     * wardrobe, on the switch wheel, and scripted between chapters — and the
     * player can be at the wheel when it happens, so the modifiers have to
     * follow the brother rather than only being read at the door. Both events
     * are listened for because `game` owns one and `player` owns the other and
     * either can lead depending on how the switch was started; re-applying is
     * idempotent.
     */
    this._onHeroChange = () => this.refreshHero();
    ctx.events.on('game:character', this._onHeroChange);
    ctx.events.on('player:brother', this._onHeroChange);

    if (typeof location !== 'undefined') {
      const q = new URLSearchParams(location.search);
      const d = q.get('veh');
      if (d) this._pendingStage = d;
    }
  }

  /* ================================================================== */
  /* Spawning                                                           */
  /* ================================================================== */

  specOf(type) {
    return this._specs.get(type) ?? this._specs.get('sedan');
  }

  /**
   * Spawn a vehicle. `opts`: { paint, finish, plate, livery, parked, rng }.
   * Returns the Vehicle handle (null only for an unknown type).
   */
  spawn(type, position, yaw = 0, opts = {}) {
    const spec = this._specs.get(type);
    if (!spec) {
      console.warn(`[vehicles] unknown type "${type}"`);
      return null;
    }
    const rng = opts.rng ?? this.rng;
    const paintOpts = this._choosePaint(spec, rng, opts);
    const plate = opts.plate ?? this._makePlate(rng);

    const model = buildVehicleModel(spec, this.mats, {
      ...paintOpts,
      plate,
      livery: opts.livery ?? spec.livery ?? null,
    });
    this.root.add(model.root);
    this.render?.patchMaterials?.(model.root);

    const v = new Vehicle(this, spec, model, opts);
    v.plate = plate;
    v.paintName = paintOpts.paintName;
    v.damage = new DamageModel(v, this.mats, rng.fork ? rng.fork() : this.rng);
    // -1, NOT 0. See `_selectLod`: the update loop only materialises a level
    // when the SELECTED level differs from `v.lod`, so seeding this with a real
    // level makes that level's meshes unbuildable.
    v.lod = -1;

    const p = position?.isVector3 ? position : new THREE.Vector3(
      position?.x ?? position?.[0] ?? 0,
      position?.y ?? position?.[1] ?? 0,
      position?.z ?? position?.[2] ?? 0
    );
    v.setPose(p, yaw);
    v.syncTransforms(1, 0);
    // Materialise a level NOW rather than waiting for the next `update()`. A
    // car must never exist for a frame with no meshes, and `props` spawns
    // parked cars a couple of metres from the lens.
    this._selectLod(v, true);
    this.vehicles.push(v);
    return v;
  }

  /**
   * Pick and materialise this vehicle's LOD from its distance to the camera.
   *
   * ────────────────────────────────────────────────────────────────────────
   * THE BUG THIS FIXES — every vehicle inside 22 m was INVISIBLE.
   * ────────────────────────────────────────────────────────────────────────
   * `build.js` materialises a level on demand, and the only thing that calls
   * `setVehicleLod` is this selector, gated on `lod !== v.lod`. `spawn()` used
   * to seed `v.lod = 0` while the model's own `lod` was -1 and NOTHING was
   * built — so a vehicle whose selected level was also 0 (i.e. anything the
   * player can walk up to) matched the guard on every frame it ever lived,
   * `setVehicleLod` was never called, and the car had literally zero meshes.
   *
   * It read as a far-LOD bug rather than an invisibility bug because the only
   * cars you could see near the camera were ones that had DRIVEN in from
   * beyond 22 m: they got a level the first time they crossed a boundary, and
   * the LOD0 crossing then worked normally. Anything that SPAWNED close —
   * every parked car `props` dresses the kerb with, every traffic car the
   * director pops in around you, every debug-staged beauty shot — never
   * appeared at all. A probe on the `detail` shot found three sedans at 1.3 m,
   * 2.4 m and 2.6 m from the lens with `meshes: 0`.
   *
   * Seeding -1 alone would leave a one-frame hole at spawn, so `spawn()` calls
   * this directly and the frame loop reuses it.
   */
  _selectLod(v, refreshCam = false) {
    if (refreshCam) this.ctx.camera.getWorldPosition(_cam);
    const bias = this.ctx.config.q.lodBias ?? 1;
    const d = _cam.distanceTo(v.position);
    const hys = v.lod;
    let lod = 0;
    // 12% hysteresis so a car hovering at a boundary does not strobe.
    if (d > (LOD_DIST[2] / bias) * (hys >= 3 ? 0.88 : 1)) lod = 3;
    else if (d > (LOD_DIST[1] / bias) * (hys >= 2 ? 0.88 : 1)) lod = 2;
    else if (d > (LOD_DIST[0] / bias) * (hys >= 1 ? 0.88 : 1)) lod = 1;
    if (lod !== v.lod) {
      // Materialises the level on first use — see setVehicleLod in build.js.
      setVehicleLod(v.model, lod);
      v.lod = lod;
    }
    return lod;
  }

  /**
   * Remove a vehicle from the world.
   *
   * ──────────────────────────────────────────────────────────────────────────
   * THE ONE VEHICLE NOBODY MAY DESPAWN
   * ──────────────────────────────────────────────────────────────────────────
   * This is the single chokepoint EVERY cull path funnels through — `traffic`
   * recycles a far car here, `props` streams a parked car out here, `police`
   * retires a cruiser here, `game` tears a finished mission down here, the dev
   * shot harness clears staged cars here. So the guard that protects the
   * player's own car has to live HERE and not in each of those callers, because
   * a guard that lives in the caller is a guard the next caller forgets — the
   * bug that motivated this had five callers and a guard in three of them.
   *
   * TWO handles are pinned:
   *
   *   (a) THE VEHICLE THE PLAYER OCCUPIES. `player.vehicle` is set the instant
   *       the enter sequence begins (`player/vehicle.js` `tryEnter`) and is not
   *       cleared until the exit animation completes, so it is the authority on
   *       "which car is the player in" across the WHOLE open/jack/in/drive/out
   *       lifetime. Every despawner of a game-spawned mission vehicle was
   *       instead trusting a per-caller guard keyed on `game.playerVehicle()`
   *       (`mission.cleanup`, `characters._parkCar`) or a private `_playerCar`
   *       (`traffic`), and `game.playerVehicle()` returns
   *       `player?.inVehicle ? player.vehicle : null` — so it yields NULL the
   *       moment `player` is unavailable (a scene teardown between chapters) or
   *       the derived `inVehicle` flag is out of step with the seat, and the
   *       guard then despawns the car out from under a seated player. Nothing
   *       steps a handle that has left `this.vehicles`, so the car freezes;
   *       `player/vehicle.js` reacts only to `.destroyed`, never to "streamed
   *       out", so the player is left in a limbo seated state with
   *       "LEAVE THE <car>" still on the HUD — the reported bug exactly. Keying
   *       the guard off the vehicle handle + seat here, at the one point every
   *       caller passes through, is strictly wider than any of those and cannot
   *       be forgotten by the next caller. Measured live and in
   *       `src/vehicles/despawnprobe.mjs`.
   *
   *   (b) ANY VEHICLE CARRYING AN ACTIVE MISSION TAG (`v.isMission`, set by
   *       `game/mission.js` on everything `g.spawnVehicle(M, ...)` produces). A
   *       cull may never take the delivery van, the escort ally or the chase
   *       target while the job is live.
   *
   * `{ force: true }` bypasses (b) only — mission cleanup is the one caller that
   * legitimately removes a mission vehicle, and it must still be refused a car
   * the player is sitting in, so (a) holds even under force. `{ hard: true }`
   * (full-system `dispose()`) bypasses both.
   */
  despawn(v, opts) {
    if (!v) return;
    const o = opts === true ? { force: true } : (opts || {});
    const hard = o.hard === true;
    const force = hard || o.force === true;
    // (a) NEVER rip the car out from under a seated player. Not even a forced
    // mission teardown — the player exits first. Only a hard dispose overrides.
    if (!hard && this._playerAboard(v)) {
      if (!this._warnedOccupiedDespawn) {
        this._warnedOccupiedDespawn = true;
        console.warn('[vehicles] refused to despawn the vehicle the player occupies');
      }
      return;
    }
    // (b) A live mission vehicle survives every cull; only authorized teardown
    // (mission cleanup, dispose) may remove it.
    if (!force && v.isMission === true) return;
    const i = this.vehicles.indexOf(v);
    if (i >= 0) this.vehicles.splice(i, 1);
    const h = this._hidden?.indexOf(v) ?? -1;
    if (h >= 0) this._hidden.splice(h, 1);
    v.model.root.parent?.remove(v.model.root);
    // Only per-vehicle resources are freed; class geometry is shared.
    for (const p of v.model.panels) {
      if (v.damage?._cloned.has(p.mesh)) p.mesh.geometry.dispose();
    }
    for (const k in v.model.lampMats) v.model.lampMats[k].dispose();
  }

  /**
   * Is the local player currently in `v` — climbing in, driving or climbing
   * out? `player.vehicle` is the authority and is non-null across the whole
   * sequence; the seat and occupant list are checked too so a frame where the
   * player reference is momentarily out of step with the animation cannot open
   * a hole.
   */
  _playerAboard(v) {
    if (!v) return false;
    if (v === this._playerVehicle()) return true;
    if (v.driver && this._isPlayerActor(v.driver)) return true;
    const occ = v.occupants;
    if (Array.isArray(occ)) {
      for (let i = 0; i < occ.length; i++) {
        if (this._isPlayerActor(occ[i])) return true;
      }
    }
    return false;
  }

  /**
   * COLOUR AND CONDITION VARIATION BETWEEN INSTANCES.
   *
   * Twenty-one paints for a whole city means a traffic stream in which every
   * third car is a pixel-exact colour match for another one in the same frame,
   * and — worse for a rustbelt street — every car of a given colour is in
   * exactly the same condition. Real traffic varies in BOTH, and the two are
   * not independent: a sun-bleached car is lighter and less saturated as well
   * as dirtier.
   *
   * The variation is QUANTISED rather than continuous, deliberately. A material
   * is cached per key, so a continuous jitter would mint one material per car
   * and defeat both the cache and the pre-warm. Five tones x three condition
   * steps takes the fleet from 21 distinct looks to 315 while adding ZERO
   * shader permutations — every one of them shares one program, because the
   * variation is in uniform values, not in defines — and `prewarmMaterials`
   * enumerates the whole set, so none of it compiles during play.
   */
  _choosePaint(spec, rng, opts) {
    if (opts.paint !== undefined && opts.paint !== null) {
      return {
        paint: opts.paint,
        finish: opts.finish ?? 'gloss',
        flake: opts.flake ?? 0.5,
        wear: opts.wear ?? 0,
        paintName: 'custom',
      };
    }
    const pools = spec.paints ?? ['common'];
    const poolName = pools[rng.u32() % pools.length];
    const pool = PAINTS[poolName] ?? PAINTS.common;
    const p = pool[rng.u32() % pool.length];
    // One car in six on a rustbelt street is a resprayed beater. Police cars
    // are fleet-maintained: one colour, one tone, no wear.
    const fleet = spec.id === 'police';
    const beater = !fleet && rng.float() < 0.17;
    const finish = opts.finish ?? (beater ? (rng.float() < 0.4 ? 'primer' : 'matte') : 'gloss');
    const tone = fleet ? 1 : rng.u32() % PAINT_TONES.length;
    const wear = fleet ? PAINT_WEARS[0] : PAINT_WEARS[rng.u32() % PAINT_WEARS.length];
    // Pick from the SAME enumerated set the pre-warm built, so a spawn can only
    // ever ask for a material that already exists and is already bound. The
    // draws are made BEFORE the lookup so the predicate is pure and the rng
    // stream stays deterministic regardless of where the match lands.
    const want =
      VARIANTS.find((v) =>
        v.paintName === p.name && v.finish === finish &&
        (finish !== 'gloss' || (v.tone === tone && v.wear === wear))
      ) ?? VARIANTS[0];
    return { paint: want.paint, finish: want.finish, flake: want.flake, wear: want.wear, paintName: p.name };
  }

  _makePlate(rng) {
    const L = 'ABCDEFGHJKLMNPRSTUVWXYZ';
    const a = L[rng.u32() % L.length] + L[rng.u32() % L.length] + L[rng.u32() % L.length];
    const n = String(100 + (rng.u32() % 900));
    return `${a} ${n}`;
  }

  /* ================================================================== */
  /* Queries used by player / traffic / police                          */
  /* ================================================================== */

  nearest(x, y, z, radius = 6, filter = null) {
    let best = null;
    let bestD = radius * radius;
    for (let i = 0; i < this.vehicles.length; i++) {
      const v = this.vehicles[i];
      if (filter && !filter(v)) continue;
      const dx = v.position.x - x;
      const dy = v.position.y - y;
      const dz = v.position.z - z;
      const d = dx * dx + dy * dy + dz * dz;
      if (d < bestD) { bestD = d; best = v; }
    }
    return best;
  }

  setInput(v, input) {
    if (!v || !input) return;
    const i = v.input;
    i.throttle = clamp01(input.throttle ?? 0);
    i.brake = clamp01(input.brake ?? 0);
    i.steer = Math.max(-1, Math.min(1, input.steer ?? 0));
    i.handbrake = !!input.handbrake;
    /**
     * `reverse` is the AI channel for backing up: hold it and the car selects
     * reverse and drives out, braking to a stop first if it is still rolling
     * forwards. `traffic` and `police` should reach for this instead of
     * re-routing or recycling a car that has nosed into something — a human
     * would simply back up. A PLAYER never needs it: holding the brake at a
     * standstill selects reverse on its own (see `drivetrain.js`).
     */
    i.reverse = clamp01(input.reverse ?? 0);
    if (input.boost !== undefined) i.boost = clamp01(input.boost);
    // `horn` is optional so an AI driver that never sets it does not silence
    // the player's, but `traffic` can lean on it at a junction.
    if (input.horn !== undefined) this.setHorn(v, !!input.horn);
    // `boost` wakes it too. Without that, a parked helicopter whose only
    // take-off control IS the boost channel could never leave the ground: it
    // would be asleep, and a sleeping vehicle is not stepped at all.
    if (v.sleeping && (i.throttle > 0.01 || i.brake > 0.01 || i.reverse > 0.01 ||
      i.handbrake || i.boost > 0.01)) {
      v._sleepTimer = 0;
      v.sleeping = false;
    }
  }

  /* ================================================================== */
  /* Fuel, horn and repair — the gameplay surface `game` drives          */
  /* ================================================================== */

  /**
   * Add fuel, in tank-percent. `game` calls this per frame while the player is
   * stopped at a pump: `veh.refuel(v, 34 * dt)`, i.e. a full tank in about
   * three seconds. Returns how much actually went in, so a station can charge
   * for it.
   */
  refuel(v, amount) {
    if (!v || !(amount > 0)) return 0;
    const before = v.fuel;
    v.fuel = Math.min(v.maxFuel, v.fuel + amount);
    if (v.fuel > 0 && v.fuelDry) {
      v.fuelDry = false;
      v.engineOn = !v.destroyed;
      this.onFuelState(v, false);
    }
    return v.fuel - before;
  }

  /**
   * Repair, in health points. Panels un-dent as the health comes back — the
   * damage model keeps the original vertex positions for exactly this — so a
   * body shop visibly hammers the car straight. Returns the health restored.
   */
  repair(v, amount) {
    if (!v || !(amount > 0)) return 0;
    const done = v.damage?.repair(amount, this.ctx) ?? 0;
    /**
     * A DROWNED ENGINE IS A REPAIR, and this is the only thing that undoes it.
     * `_stepWater` cuts it when the intake goes under and deliberately never
     * restores it on the way out — driving into the Allegheny has to cost
     * something, and "wait on the bank until it dries" is not a cost. Once the
     * body shop has put health back in, the engine turns over again.
     */
    if (done > 0 && v.drowned && v.health > v.maxHealth * 0.25) {
      v.drowned = false;
      v.drowning = 0;
      v.flooded = 0;
      v.engineOn = !v.destroyed && !v.fuelDry;
    }
    return done;
  }

  /** Sound (or silence) a vehicle's horn. Idempotent; only edges are emitted. */
  setHorn(v, on) {
    if (!v) return;
    const want = !!on && !v.destroyed;
    v.input.horn = want;
    if (want === v.horn) return;
    v.horn = want;
    this.ctx.events.emit('vehicle:horn', {
      vehicle: v,
      on: want,
      position: v.position,
    });
  }

  /** Called by the dynamics when the tank runs dry or is filled again. */
  onFuelState(v, dry) {
    if (dry) v.engineOn = false;
    this.ctx?.events.emit('vehicle:fuel', {
      vehicle: v,
      fuel: v.fuel,
      dry,
      player: v === this._playerVehicle(),
    });
  }

  /**
   * The engine has ingested the Monongahela. `_stepWater` calls this once, on
   * the edge, so `audio` can cough and cut the engine loop and `ui` can say why
   * the throttle stopped answering.
   *
   * NOT in ARCHITECTURE.md's event table yet — that file sits outside this
   * directory, so this is reported up alongside `vehicle:horn` and
   * `vehicle:fuel` rather than added there directly.
   */
  onEngineDrowned(v) {
    this.ctx?.events.emit('vehicle:drowned', {
      vehicle: v,
      position: v.position,
      player: v === this._playerVehicle(),
    });
  }

  /** Fuel / condition of the player's vehicle, for the HUD. */
  getHudState() {
    const v = this._playerVehicle();
    if (!v) return null;
    const flying = v.spec.kind === 'heli' || v.spec.kind === 'plane';
    return {
      inVehicle: true,
      type: v.type ?? v.spec.id,
      name: v.spec.name,
      fuel: +(v.fuel / v.maxFuel).toFixed(4),
      fuelDry: !!v.fuelDry,
      /**
       * `ui` should draw NO fuel gauge when this is true. The bicycle has no
       * tank, and a gauge pinned at full is worse than no gauge — it reads as a
       * broken instrument rather than as an absent one.
       */
      noFuel: !!v.spec.nogas,
      health: +(v.health / v.maxHealth).toFixed(4),
      speedKmh: Math.round(v.speed * 3.6),
      rpm: Math.round(v.drivetrain.rpm),
      redline: v.spec.engine.redline,
      gear: flying ? '—' : v.drivetrain.gearLabel,
      horn: !!v.horn,
      /** Flight, for the altimeter and the "SHIFT climbs" prompt. */
      flying,
      altitude: flying ? +v.altitude.toFixed(2) : 0,
      climbRate: flying ? +v.velocity.y.toFixed(2) : 0,
      rotor: flying ? +v.rotorSpin.toFixed(3) : 0,
      /** Water, for the drowning warning. */
      submerged: +(v.submerged ?? 0).toFixed(3),
      drowned: !!v.drowned,
    };
  }

  _playerVehicle() {
    const player = this.ctx.peek('player');
    return player?.vehicle ?? player?.currentVehicle ?? null;
  }

  /* ================================================================== */
  /* Per-hero vehicle modifiers                                          */
  /* ================================================================== */

  /**
   * The active brother's stat block, fetched AT RUNTIME from `player` — never
   * imported, hard rule 2. `player.brother` is the live spec (see
   * `src/player/brothers.js`); `game.character` is the id and is the fallback
   * for a build where `player` has not settled yet.
   */
  activeBrother() {
    const p = this.ctx.peek('player');
    if (p?.brother?.vehicleGrip !== undefined) return p.brother;
    // `game`'s copy of the same DESIGN.md row, under its other field name
    // (`vehGrip` in `src/game/data.js`, `vehicleGrip` in `src/player/`).
    const boy = this.ctx.peek('game')?.characters?.boy;
    if (boy?.vehGrip !== undefined) {
      return { id: boy.id ?? null, vehicleGrip: boy.vehGrip, boatSpeed: boy.boatSpeed };
    }
    return null;
  }

  /**
   * Attach or detach the driver's own grip / top gear / boat speed. `on: false`
   * restores `HERO.none`, which is exactly the behaviour every AI, parked and
   * benched vehicle has, so nothing but the player's vehicle is ever modified.
   *
   * Public so a mission that hands the player a car can set it explicitly, and
   * so `drivetest.mjs` can drive the same entry point the game does rather than
   * poking the field.
   */
  applyHero(v, on = true) {
    if (!v) return HERO.none;
    v.hero = on ? heroMods(this.activeBrother()) : HERO.none;
    return v.hero;
  }

  /** Re-read the brother for every vehicle that currently has one. */
  refreshHero() {
    const mods = heroMods(this.activeBrother());
    for (const v of this.vehicles) {
      if (v.hero && v.hero !== HERO.none) v.hero = mods;
    }
  }

  /** Is this actor the local player (rather than a ped or a cop)? */
  _isPlayerActor(actor) {
    if (!actor) return false;
    if (actor === 'player' || actor?.isPlayer === true) return true;
    return actor === this.ctx.peek('player');
  }

  /**
   * Where an actor stands to get in, and where they sit.
   * seat 0 = driver, 1 = front passenger, 2/3 = rear.
   *
   * ────────────────────────────────────────────────────────────────────────
   * `local`/`position` IS THE OCCUPANT'S HEAD, in every class.
   *
   * That is how this file already consumed it — `debugPose('cockpit')` puts the
   * first-person camera at `position + 12 cm` — but the three branches did not
   * agree with each other: the car returned a head, while the bike returned a
   * point 28 cm over the saddle and the boat 50 cm over the deck, both of which
   * are HIPS. Anything deriving a body from the anchor therefore got a rider
   * sunk into the machine, and the bike's cockpit camera looked out from the
   * fuel tank. `player` places the driver's whole body from this point
   * (`player/vehicle.js`), so one meaning across the classes is the contract,
   * not a tidy-up.
   *
   * For the car the offset over the hip is 0.42 m rather than an upright 0.60 m
   * — a low roof makes you slouch, and the roofline is what actually has to be
   * cleared. `src/player/drivetest.mjs` measures the crown against `roofY` for
   * every class and is the check that keeps these numbers honest.
   *
   * ────────────────────────────────────────────────────────────────────────
   * THE HEAD HAS TO BE IN THE WINDOW, NOT ON THE SILL.
   * ────────────────────────────────────────────────────────────────────────
   * The hip-plus-a-torso construction above derives everything from `sillY` —
   * the bottom of the door aperture — and then adds a FIXED 0.42 m, so it never
   * looks at where the glass actually starts. Measured against each class's own
   * belt line (`style.beltY`, the bottom edge of the side glass), that put the
   * driver's head at:
   *
   *   sedan  +0.11 m over the belt   sports +0.10   muscle +0.13
   *   van    -0.07 m                 truck  -0.25
   *
   * i.e. at or BELOW the window line in every class, and a quarter of a metre
   * under it in the truck — which has 1.23 m of unused headroom above him. Only
   * the crown of his head is in the aperture, so from outside the cabin reads as
   * empty, and `debugPose('cockpit')` (anchor + 12 cm) looks out at the top of
   * the door card. That is half of "the player is not shown sitting in the
   * driver's seat": the body IS placed and IS rendered, it is just below the
   * only hole you could see it through.
   *
   * So the head is now placed against the GLASS and capped against the
   * HEADLINER, with the old hip construction as the floor:
   *
   *   head = max(hip + 0.42, min(beltY + 0.20, roofY - 0.30, floor + 1.05))
   *
   * - `beltY + 0.20` puts the head and the top of the shoulders in the glass.
   * - `roofY - 0.30` keeps the CROWN under the headliner: `player`'s seated rig
   *   stacks the crown 0.242 m over the head bone, so this leaves ~6 cm of
   *   clearance and the existing `crown < roofY` assertion keeps its margin.
   * - `floor + 1.05` is the anthropometric cap — a seated adult's head centre is
   *   about a metre over the floor he is sitting above — so a tall van or truck
   *   cabin does not stand him up to reach its own roof.
   * - the `max` means no class is ever LOWERED by this; a car whose roofline is
   *   too low to satisfy the belt rule (the sports car and the muscle car) keeps
   *   exactly the number it had.
   */
  seatAnchor(v, seat = 0) {
    if (!v) return null;
    const s = v.spec;
    const st = s.style;
    const side = DRIVER_SIDE * (seat % 2 === 0 ? 1 : -1);
    const row = seat < 2 ? 0 : 1;
    let local;
    if (s.kind === 'bike') {
      // Sitting ON the saddle: hip is the seat, head is a torso above it.
      local = new THREE.Vector3(0, st.seatY - s.comY + 0.62, st.tankZ - 0.35);
    } else if (s.kind === 'heli') {
      /**
       * The cockpit. Seated on the cabin floor pan, head in the bubble —
       * `floorY + 0.20` is the seat pan and a seated adult's head centre is
       * about a metre over the floor he is sitting on, which is the same
       * `HEAD_OVER_FLOOR` the car branch uses.
       *
       * PILOT ON THE LEFT, and that is a game convention rather than an
       * aviation one: a helicopter's pilot-in-command sits on the RIGHT. Every
       * other class in this fleet puts the driver on the left, `player`'s entry
       * animation, door swing, exit probe and cockpit camera all follow the
       * anchor's side, and `drivetest.mjs`'s layout section asserts it
       * geometrically for the whole fleet. One aircraft is not worth a second
       * convention in five subsystems.
       */
      local = new THREE.Vector3(
        side * 0.42,
        st.floorY + HEAD_OVER_FLOOR - s.comY,
        (st.cabinZ1 ?? 2) - 1.05 - row * 0.9
      );
    } else if (s.kind === 'boat') {
      // Seated at the console: hip ~0.45 over the deck, head above that.
      local = new THREE.Vector3(side * 0.4, st.deckY - s.comY + 1.05, st.consoleZ - 0.6 - row * 0.8);
    } else {
      const floor = st.groundY + Math.max(0.1, st.sillY - 0.16);
      const hip = floor + 0.22;
      const slouched = hip + 0.42;
      const inGlass = Math.min(
        (st.beltY ?? hip + 0.31) + HEAD_OVER_BELT,
        (st.roofY ?? hip + 0.83) - CROWN_OVER_HEAD - CROWN_CLEAR,
        floor + HEAD_OVER_FLOOR
      );
      local = new THREE.Vector3(
        side * st.hwMax * 0.46,
        Math.max(slouched, inGlass) - s.comY,
        st.cowlZ - 0.95 - row * 1.0
      );
    }
    const position = local.clone().applyQuaternion(v.quaternion).add(v.position);
    const enter = new THREE.Vector3(side * (s.half.x + 0.55), -s.comY + 0.05, local.z)
      .applyQuaternion(v.quaternion)
      .add(v.position);
    const q = v.quaternion;
    const yaw = Math.atan2(2 * (q.w * q.y + q.x * q.z), 1 - 2 * (q.y * q.y + q.x * q.x));
    return { position, enter, yaw, local, seat, side };
  }

  /**
   * Swing a door. `open` is 0 (shut) to 1 (wide), and `player` pushes it every
   * frame of the enter / jack / exit sequence — this is the single most-used
   * interaction in the game and until now the method did not exist, so the
   * actor climbed in through a solid flank.
   *
   * Seats map to sides exactly as `seatAnchor` does — driver's side for the
   * even seats, off side for the odd ones, both keyed off `DRIVER_SIDE`, so the
   * door that swings is always the one the actor is walking to. A rear
   * passenger uses the front door of his own side, because that is the one that
   * exists as geometry. Safe to call on a bike, a boat, a car whose LOD0 has
   * not been materialised yet, or a wreck.
   *
   * Returns the angle actually commanded, so a caller can tell whether the
   * vehicle has a door at all.
   */
  setDoor(v, seat = 0, open = 0) {
    if (!v) return 0;
    const side = DRIVER_SIDE * ((seat | 0) % 2 === 0 ? 1 : -1);
    const want = open < 0 ? 0 : open > 1 ? 1 : open;
    if (!v.doorTarget) {
      v.doorTarget = [0, 0];
      v.doorOpen = [0, 0];
    }
    const i = side < 0 ? 0 : 1;
    v.doorTarget[i] = want;
    // Any door that stops being driven eases itself shut — otherwise an
    // aborted sequence, or a ped that never reports back, leaves the fleet
    // driving around with a door hanging open.
    v._doorTouch = this.ctx.time.elapsed;
    return want;
  }

  /** Current swing of a door, 0..1. */
  doorState(v, seat = 0) {
    if (!v?.doorOpen) return 0;
    return v.doorOpen[(seat | 0) % 2 === 0 ? 0 : 1];
  }

  /**
   * Drive the hinges. Rate-limited rather than snapped so a caller that jumps
   * from 0 to 1 in one frame still gets a swing, and the auto-shut above reads
   * as a door falling closed.
   */
  _updateDoors(v, dt, now) {
    const nodes = v.model.doors;
    if (!nodes?.length || !v.doorTarget) return;
    const stale = now - (v._doorTouch ?? -9) > 1.2;
    let moving = false;
    for (let i = 0; i < 2; i++) {
      const target = stale ? 0 : v.doorTarget[i];
      const cur = v.doorOpen[i];
      if (Math.abs(target - cur) > 1e-4) {
        const step = dt * 3.6;
        v.doorOpen[i] = cur + Math.max(-step, Math.min(step, target - cur));
        moving = true;
      } else if (cur !== target) {
        v.doorOpen[i] = target;
        moving = true;
      }
    }
    if (!moving && !v._doorDirty) return;
    v._doorDirty = moving;
    for (const n of nodes) {
      const a = v.doorOpen[n.side < 0 ? 0 : 1] * DOOR_ANGLE;
      // Left door (x < 0) swings to -x as it opens, right door to +x.
      n.pivot.rotation.y = -n.side * a;
    }
  }

  setDriver(v, actor, seat = 0) {
    if (!v) return;
    v.driver = actor;
    if (!v.occupants.includes(actor)) v.occupants.push(actor);
    v.engineOn = !v.destroyed && !v.fuelDry;
    v._sleepTimer = 0;
    // Only the player's car burns fuel. An AI cab that runs dry in a junction
    // is a blocked road, not a mechanic.
    if (seat === 0 && this._isPlayerActor(actor)) {
      v.burnsFuel = true;
      v.autoReverse = true;
      this.applyHero(v, true);
    }
    this.ctx.events.emit('vehicle:enter', { vehicle: v, actor, seat });
  }

  clearDriver(v, actor = null) {
    if (!v) return;
    const a = actor ?? v.driver;
    v.driver = null;
    v.occupants = v.occupants.filter((o) => o !== a);
    v.input.throttle = 0;
    v.input.brake = 1;
    v.input.steer = 0;
    v.input.reverse = 0;
    v.input.boost = 0;
    v.autoReverse = false;
    if (this._isPlayerActor(a)) {
      v.burnsFuel = false;
      this.applyHero(v, false);
    }
    this.setHorn(v, false);
    this.ctx.events.emit('vehicle:exit', { vehicle: v, actor: a });
  }

  /**
   * External damage — bullets, explosions, melee.
   *
   * `amount` is in THIS VEHICLE'S health points, not actor points. Callers that
   * hold an actor-scale number (a weapon's `damage`, an `explosion` payload)
   * multiply by `ACTOR_TO_VEHICLE` first; `weapons/vehiclehit.js` reads it off
   * `actorDamageScale` rather than keeping a copy.
   */
  damage(v, amount, point) {
    if (!v || v.destroyed || v._staged) return;
    v.health = Math.max(0, v.health - amount);
    /**
     * WAKE IT. `fixedUpdate` skips the whole step for a sleeping vehicle and
     * `_sleepTimer` is only written inside that step, so `sleeping` is a latch
     * — see `Vehicle.wake`. Every other consequence of being shot (settling on
     * broken wheels, the burn ramp, the `vehicle:engine` telemetry `fx` stages
     * fire and smoke off) is downstream of the step, and a parked car is
     * asleep by definition. This is the entry point EVERY external damage
     * source comes through, which is why the wake belongs here and not in the
     * explosion path that happened to expose it.
     */
    v.wake?.();
    if (point && amount > 8) {
      /**
       * THE DENT IS A VISUAL AND IT IS SIZED IN METRES, so it does NOT ride the
       * health scale. Its coefficients were authored against hit sizes on a
       * 100-point body (a 16-point nail leaving 3 cm), so the conversion is
       * this vehicle's OWN body scale — not
       * `ACTOR_TO_VEHICLE`, which is about damage bookkeeping and says nothing
       * about how deep a crater is. Dividing by the constant instead was only
       * ever right for a ~1000 HP car: it gave a 90 HP bicycle and a 3000 HP
       * bus the same crater for the same absolute hit, and it meant re-tuning
       * the damage scale silently resized every dent in the game.
       */
      _n.copy(point).sub(v.position);
      const off = _n.length();
      /**
       * NO DIRECTION, NO CRATER — and no copy-on-write clone either.
       *
       * A caller that has no located impact passes the body's own centre —
       * `police/roadblock.js:402` spike strips, and every scripted write-off in
       * `game/playtest.mjs` and `weapons/arsenalprobe.mjs` — and
       * `point - position` is then exactly the zero vector, because `point` is
       * frequently the very `v.position` object. `normalize()` leaves a zero
       * vector zero, so `dent()` displaced every vertex by zero metres —
       * MEASURED at 0.00 mm of vertex movement — while still cloning every
       * panel's geometry and running `computeVertexNormals` over all of it.
       * That is the whole cost of a dent for none of the picture, at every
       * car that crosses a strip. Bail before paying it.
       *
       * Note what this means for the spike strip specifically: its crater did
       * NOT shrink from 6 cm to 6 mm. It has always been
       * 0 mm. And the drowning path (`dynamics.js`) passes `point: null`, so it
       * has never reached this branch at all.
       */
      if (off > 1e-3) {
        _n.multiplyScalar(-1 / off);
        const ref = amount / Math.max(1e-3, v.maxHealth / REFERENCE_BODY_HP);
        v.damage.dent(point, _n, Math.min(0.1, ref * 0.002), 0.5);
      }
    }
    if (v.health <= 0) {
      v.damage.destroy(this.ctx);
      if (!v._deathEmitted) {
        v._deathEmitted = true;
        this.ctx.events.emit('vehicle:destroyed', { vehicle: v, point: v.position.clone() });
      }
    }
  }

  /* ================================================================== */
  /* World interface                                                    */
  /* ================================================================== */

  _world() {
    if (this._worldSys === undefined) this._worldSys = this.ctx.peek('world');
    return this._worldSys;
  }

  /**
   * How wet the roads are, 0..1. Pushed by `sky` on `weather:change`; also
   * public so `game` can force it for a mission or a tool can sweep it.
   */
  setWetness(w) {
    const v = w < 0 ? 0 : w > 1 ? 1 : w;
    // `sky` pushes at 4 Hz and the value is an integral, so it arrives in tiny
    // increments; only rebuild the table when it has actually moved.
    if (this.gripTable && Math.abs(v - this.wetness) < 0.004) return;
    this.wetness = v;
    // Same integral, both consumers: the tyre's friction coefficient AND the
    // paint. A car in the rain has to LOOK wet as well as drive wet, and the
    // shared uniform means this is one write for every paint material alive.
    this.mats?.setWetness(v);
    for (const k in this.gripTable) {
      const base = SURFACE_GRIP[k];
      const g = this.gripTable[k];
      const sens = WET_SENS[k] ?? 0.6;
      g.mu = wetGrip(base.mu, v * sens);
      // A wet surface breaks away with less of a warning and squeals less, so
      // the skid FX gain goes UP even as the grip goes down — that is the
      // "everything is greasy" read `fx` and `audio` want off `vehicle:skid`.
      g.skid = base.skid * (1 + 0.5 * v * sens);
      // Standing water adds a little drag and rolling resistance.
      g.roll = base.roll * (1 + 0.10 * v * sens);
      g.drag = base.drag + 0.012 * v * sens;
    }
  }

  /** Live (wetness-adjusted) grip entry for a surface tag. */
  gripOf(name) {
    return this.gripTable[name] ?? this.gripTable.asphalt;
  }

  /**
   * Surface under a wheel. `world.surfaceAt` is authoritative; the physics
   * per-triangle tag is the fallback so this works before world exposes it.
   */
  surfaceAt(x, z, fallback = 'asphalt') {
    const w = this._world();
    if (w?.surfaceAt) {
      const s = w.surfaceAt(x, z);
      if (s) return s;
    }
    return fallback;
  }

  /**
   * Water SURFACE height at (x,z), or null when there is no water there.
   *
   * ────────────────────────────────────────────────────────────────────────
   * `waterLevelAt` IS THE ONE TO ASK, AND IT WAS NOT IN THE CHAIN.
   * ────────────────────────────────────────────────────────────────────────
   * `world` publishes `waterLevelAt(x, z)` — "height of the water SURFACE, or
   * -Infinity on dry land" — and this chain did not know about it. It tried
   * `waterHeightAt` (which `world` does not have), then `waterLevel` (which it
   * does not have either), and landed on `heightAt`, WHICH IS THE RIVERBED.
   *
   * A riverbed answer is the worst possible one, because it is a plausible
   * number rather than a null: the surface and the bed come out at the same
   * height, so every depth is zero, no hull sample is ever under the waterline
   * and no car is ever submerged. The boat has been floating on the mud and the
   * new water rules would never have fired once in the real game — while
   * passing every headless assertion, because the harness supplies its own.
   * `-Infinity` is normalised to null here so the callers keep one contract.
   */
  waterHeightAt(x, z) {
    const w = this._world();
    if (!w) return null;
    if (w.isWater && !w.isWater(x, z) && !w.waterLevelAt) return null;
    let y = null;
    if (w.waterHeightAt) y = w.waterHeightAt(x, z);
    else if (w.waterLevelAt) y = w.waterLevelAt(x, z);
    else if (w.waterLevel !== undefined) y = w.waterLevel;
    else if (w.isWater && w.heightAt) y = w.heightAt(x, z);
    return Number.isFinite(y) ? y : null;
  }

  lodOf(v) {
    return v.lod ?? 0;
  }

  /* ================================================================== */
  /* Frame                                                              */
  /* ================================================================== */

  fixedUpdate(h, ctx) {
    const t0 = performance.now();
    const list = this.vehicles;
    for (let i = 0; i < list.length; i++) {
      const v = list[i];
      if (v._sleepTimer > 1.2 && !v.driver && v.grounded >= v.wheels.length - 1) {
        v.prevPosition.copy(v.position);
        v.prevQuaternion.copy(v.quaternion);
        v.sleeping = true;
        continue;
      }
      v.sleeping = false;
      v.fixedStep(h, ctx);
    }
    this._vehicleCollisions(h);
    // Debug staging only: hold a posed hero car on its mark. Suspension, pitch
    // and roll still solve — only the horizontal drift is removed.
    const pa = this._poseAnchor;
    if (pa) {
      pa.v.position.x = pa.x;
      pa.v.position.z = pa.z;
      pa.v.prevPosition.x = pa.x;
      pa.v.prevPosition.z = pa.z;
      pa.v.velocity.x = 0;
      pa.v.velocity.z = 0;
      pa.v.angularVelocity.y = 0;
      /**
       * The `chase` and `cockpit` poses used to be given 21 m/s and left to it.
       * A capture settles for twenty seconds of sim, so the subject drove 420 m
       * before the shutter — which is why `driving.png` contained NO CAR AT ALL
       * and `cockpit.png` photographed the car from sixty metres behind, with
       * the camera still parked where the seat had been. Both frames shipped in
       * that state.
       *
       * Pin the car like the beauty shot, and spin the wheels kinematically so
       * it still reads as rolling. `_emitWheelFx` opts out (above) because the
       * resulting slip is an artefact of the staging.
       */
      if (pa.roll) {
        for (const w of pa.v.wheels) w.omega = pa.roll / (w.hp.radius || 0.34);
      }
    }
    this._stats.stepMs = performance.now() - t0;
  }

  /**
   * Vehicle vs vehicle. Three spheres down the length of each body is enough
   * for cars to shunt each other convincingly and costs a fraction of a real
   * convex solver at forty instances.
   */
  _vehicleCollisions(dt) {
    const list = this.vehicles;
    const n = list.length;
    for (let i = 0; i < n; i++) {
      const a = list[i];
      for (let j = i + 1; j < n; j++) {
        const b = list[j];
        if (a.sleeping && b.sleeping) continue;
        // Debug staging: a chocked hero car parked in a live lane would be
        // shunted (and its neighbours detonated) for the whole settle.
        if (a._staged || b._staged || a._noCollide || b._noCollide) continue;
        const dx = b.position.x - a.position.x;
        const dy = b.position.y - a.position.y;
        const dz = b.position.z - a.position.z;
        const rr = a.boundingRadius + b.boundingRadius;
        if (dx * dx + dy * dy + dz * dz > rr * rr) continue;
        this._pairResolve(a, b, dt);
      }
    }
  }

  _pairResolve(a, b, dt) {
    const ra = a.spec.half.x * 1.02;
    const rb = b.spec.half.x * 1.02;
    for (let ia = -1; ia <= 1; ia++) {
      _v.set(0, 0, ia * a.spec.half.z * 0.62).applyQuaternion(a.quaternion).add(a.position);
      for (let ib = -1; ib <= 1; ib++) {
        _v2.set(0, 0, ib * b.spec.half.z * 0.62).applyQuaternion(b.quaternion).add(b.position);
        _n.subVectors(_v2, _v);
        const d = _n.length();
        const sum = ra + rb;
        if (d >= sum || d < 1e-5) continue;
        _n.multiplyScalar(1 / d);
        const depth = sum - d;

        const im = 1 / (a.mass + b.mass);
        a.position.addScaledVector(_n, -depth * (b.mass * im) * 0.6);
        b.position.addScaledVector(_n, depth * (a.mass * im) * 0.6);
        a.sleeping = false;
        b.sleeping = false;
        a._sleepTimer = 0;
        b._sleepTimer = 0;
        // Suspend both cars' creep dampers for a few steps: a bumper is not
        // numerical noise. See `dynamics._stepWheels`.
        a._pressed = 3;
        b._pressed = 3;

        /**
         * ────────────────────────────────────────────────────────────────────
         * SUSTAINED CONTACT — you can SHOVE the car in front of you.
         * ────────────────────────────────────────────────────────────────────
         * Everything below this point is a restitution impulse, and it is gated
         * on `vn < 0`: it answers "how hard did they bang into each other". A
         * car standing on the throttle against a parked one is not banging into
         * anything — the approach velocity is zero and the two are simply
         * pressing — so it got NOTHING but the positional split above, which
         * teleports the pusher back by 47% of the overlap every step and pins it
         * exactly where it stands.
         *
         * That is a "the car will not move" report all on its own, and it is
         * the residual one: measured on a lane-centre spawn 0.5 m off a parked
         * Millhand 6, the sedan made 7.6 kN at the contact patches (the weight
         * transfer proves it — front load 2.9 kN, rear 5.2 kN), had zero static
         * contacts, and travelled 0.04 m/s for three seconds. Reverse worked
         * perfectly, which is the tell: something was in FRONT of it.
         *
         * A penalty spring along the normal fixes it and is Newton's third law
         * rather than a special case: the pusher penetrates until the spring
         * balances its thrust (about 3 cm at 8 kN) and the same force goes into
         * the car in front, which then rolls. Depth is clamped so a deep overlap
         * from a spawn or a teleport cannot fire a car across the street.
         */
        const press = Math.min(depth, 0.2) * CONTACT_K * dt;
        a.velocity.addScaledVector(_n, -press * a.invMass);
        b.velocity.addScaledVector(_n, press * b.invMass);

        _v3.subVectors(b.velocity, a.velocity);
        const vn = _v3.dot(_n);
        if (vn >= 0) continue;
        const j = (-(1 + 0.16) * vn) / (a.invMass + b.invMass);
        a.velocity.addScaledVector(_n, -j * a.invMass);
        b.velocity.addScaledVector(_n, j * b.invMass);
        // A shunt should also spin you.
        _v.set(0, 0, ia * a.spec.half.z * 0.62).applyQuaternion(a.quaternion);
        a.angularVelocity.y -= (_v.x * _n.z - _v.z * _n.x) * j * 0.0016;
        _v2.set(0, 0, ib * b.spec.half.z * 0.62).applyQuaternion(b.quaternion);
        b.angularVelocity.y += (_v2.x * _n.z - _v2.z * _n.x) * j * 0.0016;

        if (j > a.mass * 0.4 && a._impactCool <= 0) {
          a._impactCool = 0.12;
          b._impactCool = 0.12;
          _v3.copy(a.position).lerp(b.position, 0.5);
          this.reportCollision(a, b, _v3.x, _v3.y, _v3.z, _n.x, _n.y, _n.z, j);
          this.reportCollision(b, a, _v3.x, _v3.y, _v3.z, -_n.x, -_n.y, -_n.z, j);
        }
        return;
      }
    }
  }

  reportCollision(v, other, px, py, pz, nx, ny, nz, impulse) {
    const point = new THREE.Vector3(px, py, pz);
    const normal = new THREE.Vector3(nx, ny, nz);
    const dealt = v.damage?.impact(impulse, point, normal, this.ctx) ?? 0;
    this.ctx.events.emit('vehicle:collision', {
      vehicle: v,
      other: other ?? null,
      point,
      normal,
      impulse,
      speed: v.speed,
      damage: dealt,
    });
    if (v.destroyed && !v._deathEmitted) {
      v._deathEmitted = true;
      this.ctx.events.emit('vehicle:destroyed', { vehicle: v, point });
    }
  }

  /**
   * Blast damage to nearby vehicles.
   *
   * ---------------------------------------------------------------------
   * THE RUNAWAY THIS STILL GUARDS AGAINST
   * ---------------------------------------------------------------------
   * The multiplier here was once `f * 1.2`, so a car next to a blast took MORE
   * than the blast's own damage — the chain GAINED energy at every hop and
   * could never converge. One fender-bender in a queue detonated the queue,
   * then the street: `traffic`'s harness measured 90-250 write-offs per
   * simulated MINUTE with no player input, and a routine street capture came
   * back with a whole block on fire and two wanted stars nobody had earned.
   *
   * ---------------------------------------------------------------------
   * ...AND THE DEAD FEATURE THIS FIXES, WHICH IS THE OPPOSITE PROBLEM
   * ---------------------------------------------------------------------
   * The cure for that runaway was applied on the wrong axis. Damage was cut to
   * `e.damage * f * 0.5` with a QUADRATIC falloff — on top of the missing
   * actor-to-vehicle conversion (see `ACTOR_TO_VEHICLE`). The result was 70
   * points at the epicentre of a car wreck against a 900-point sedan: measured
   * at a parking bay's spacing, a wrecked car did **0%** of its neighbour's
   * health, eleven Scrap Rockets were needed to wreck one parked sedan, and the
   * 1.2 s refractory window was guarding a cascade that was arithmetically
   * impossible.
   *
   * The rule is now full transfer on the vehicle's own scale:
   *
   *     damage = dmg * (1 - d / (radius * 1.2))        linear, full transfer
   *
   * CONVERGENCE NO LONGER RESTS ON THE TRANSFER BEING SMALL. It rests on the
   * emitted numbers: a wrecked car emits 55 actor points (`damage.js`), i.e.
   * 55% of a 1000-point body at zero distance and ~41% at a parking bay's 2.8
   * m, so ONE wreck can never write off a HEALTHY neighbour and the chain has
   * nowhere to gain energy. It can finish a car that has already been shot up,
   * which is the feature. `src/vehicles/damageprobe.mjs` gates both halves —
   * the bite, and the row of eight healthy cars that must not burn down.
   *
   * Physical impulse is deliberately NOT attenuated and keeps its own, wider
   * reach — cars should still be thrown convincingly by a blast that barely
   * scratched them.
   */
  _explosionDamage(e) {
    if (!e?.position) return;
    const r = e.radius ?? 6;
    const now = this.ctx?.time?.elapsed ?? 0;
    const shoveReach = r * BLAST_SHOVE_REACH;
    const dmgReach = r * BLAST_DAMAGE_REACH;
    for (const v of this.vehicles) {
      if (v._staged) continue;
      const d = v.position.distanceTo(e.position);
      if (d > shoveReach) continue;
      /* Two falloffs, deliberately: the shove keeps the quadratic curve it has
       * always had, the damage takes a linear one. */
      const shove = 1 - Math.min(1, d / shoveReach);
      const f = shove * shove;
      v.sleeping = false;
      v._sleepTimer = 0;

      // Refractory window: absorb the shove, but no damage from a second blast
      // arriving within 1.2 s. Without it, N cars in a heap all detonate each
      // other inside a single frame regardless of the per-hop decay.
      if (d <= dmgReach && !(now - (v._lastBlastDmgAt ?? -99) < 1.2)) {
        v._lastBlastDmgAt = now;
        const falloff = 1 - d / dmgReach;
        /* The constants, not `this.blastDamageScale`: the headless probes call
         * this method on a stub `sys` (damageprobe, wreckprobe, toughprobe),
         * and a class field is not on the prototype, so reading it off `this`
         * would silently be `undefined` there. The published field exists for
         * OTHER subsystems to read; the product is stated here. */
        this.damage(v, (e.damage ?? 100) * ACTOR_TO_VEHICLE * BLAST_TRANSFER * falloff, e.position);
      }

      _n.copy(v.position).sub(e.position).normalize();
      v.velocity.addScaledVector(_n, f * 9);
      v.velocity.y += f * 6;
      v.angularVelocity.x += this.rng.signed() * f * 3;
      v.angularVelocity.z += this.rng.signed() * f * 3;
    }
  }

  update(dt, ctx) {
    if (this._pendingStage && this.physics?.staticWorld?.triCount > 0) {
      const s = this._pendingStage;
      this._pendingStage = null;
      this.debugStage(s, {});
    }

    // `_selectLod` reads this shared temp; refreshed once per frame here.
    ctx.camera.getWorldPosition(_cam);
    const alpha = ctx.time.alpha;
    const lodCount = [0, 0, 0, 0];
    this.groundShadows.begin();

    for (let i = 0; i < this.vehicles.length; i++) {
      const v = this.vehicles[i];
      v.syncTransforms(alpha, dt);

      // ---- LOD ------------------------------------------------------------
      lodCount[this._selectLod(v)]++;

      // ---- ground contact -------------------------------------------------
      // Skipped for anything the hide-zone has taken out of a staged shot: an
      // invisible car casting a visible shadow is the classic version of this
      // bug, and `_applyHideZone` only hides the model root.
      if (v.model.root.visible) {
        // 90 m, not 160: past that a contact patch is a couple of pixels of
        // transparent fill that nobody can see, and transparent fill is the
        // only thing this pool costs.
        const d2 = _cam.distanceToSquared(v.position);
        if (d2 < 90 * 90) {
          _fwd.set(0, 0, 1).applyQuaternion(v.quaternion);
          this.groundShadows.add(v, Math.atan2(_fwd.x, _fwd.z), d2 < 42 * 42);
        }
      }

      this._updateLamps(v, dt, ctx);
      this._updateDoors(v, dt, ctx.time.elapsed);
      v.damage?.update(dt, ctx);
      this._emitWheelFx(v, dt, ctx);
    }
    this.groundShadows.end();

    this._stats.count = this.vehicles.length;
    this._stats.lod = lodCount;
    if (this._poseAnchor?.cam) this._applyPoseCamera(ctx.camera);
    if (this._hideZone) this._applyHideZone();
    this._restageWhenStreamed();
    this._pollHorn(ctx);

    // Engine telemetry for audio / UI, at 30 Hz.
    this._engineTimer += dt;
    if (this._engineTimer > 1 / 30) {
      this._engineTimer = 0;
      for (const v of this.vehicles) {
        if (v.sleeping && !v.driver) continue;
        ctx.events.emit('vehicle:engine', {
          vehicle: v,
          rpm: v.drivetrain.rpm,
          throttle: v.input.throttle,
          gear: v.drivetrain.gearLabel,
          load: v.drivetrain.load,
          speed: v.speed,
        });
      }
    }

    this._updateHeadlights(ctx);
  }

  /**
   * The horn key.
   *
   * `src/core/input.js` binds `horn: ['KeyH']` — the control scheme was still
   * Call of Duty's until recently and had no horn at all. It is read here
   * rather than in `player` because the horn belongs to the VEHICLE: an AI
   * driver leaning on it at a junction goes through exactly the same
   * `setHorn` path, and both end up as one `vehicle:horn` edge that `audio`,
   * `traffic` and `peds` can react to.
   */
  _pollHorn(ctx) {
    const v = this._playerVehicle();
    if (this._hornVehicle && this._hornVehicle !== v) {
      this.setHorn(this._hornVehicle, false);
      this._hornVehicle = null;
    }
    if (!v || v.destroyed) return;
    const input = ctx.input;
    if (!input || input.frozen || input.enabled === false) return;
    this._hornVehicle = v;
    this.setHorn(v, !!input.action?.('horn'));
  }

  /* ================================================================== */
  /* Lights                                                             */
  /* ================================================================== */

  /**
   * A FIXED pool of two spot lights, created once at init and never made
   * invisible — only their intensity moves. Per ARCHITECTURE.md the number of
   * VISIBLE lights is a shader permutation key, so a headlight that switched
   * `visible` would recompile every lit material in the scene the moment the
   * player got into a car at night.
   */
  _buildHeadlightPool(ctx) {
    this.headlights = [];
    if ((ctx.config.q.lightSlots ?? 4) < 4) return;
    for (let i = 0; i < 2; i++) {
      const l = new THREE.SpotLight(0xfff0d8, 0, 62, 0.62, 0.42, 1.3);
      l.name = `vehicle_headlight_${i}`;
      l.castShadow = false;
      l.visible = true;
      l.position.set(0, -900, 0);
      l.target.position.set(0, -900, 1);
      this.root.add(l);
      this.root.add(l.target);
      this.headlights.push(l);
    }
  }

  _updateHeadlights(ctx) {
    if (!this.headlights?.length) return;
    const sky = ctx.peek('sky');
    const alt = sky?.sunAltitude ?? 0.6;
    const night = Math.max(0, Math.min(1, 1 - (alt + 0.02) / 0.14));
    const v = this._lightHost(ctx);
    if (!v || night < 0.02) {
      for (const l of this.headlights) l.intensity = 0;
      return;
    }
    const s = v.spec.style;
    const hl = s.headlight;
    const y = (hl?.y ?? 0.7) - v.spec.comY;
    const z = (s.noseZ ?? v.spec.half.z) - 0.1;
    const x = (s.hwMax ?? 1) * (s.noseHw ?? 1) - (hl?.inset ?? 0.3);
    for (let i = 0; i < this.headlights.length; i++) {
      const l = this.headlights[i];
      _v.set(i === 0 ? -x : x, y, z).applyQuaternion(v.quaternion).add(v.position);
      l.position.copy(_v);
      _v2.set(i === 0 ? -x * 1.5 : x * 1.5, y - 3.2, z + 26).applyQuaternion(v.quaternion).add(v.position);
      l.target.position.copy(_v2);
      l.target.updateMatrixWorld();
      l.intensity = v.destroyed ? 0 : 46 * night;
    }
  }

  _lightHost(ctx) {
    const player = ctx.peek('player');
    const pv = player?.vehicle ?? player?.currentVehicle ?? null;
    if (pv && !pv.destroyed) return pv;
    for (const v of this.vehicles) if (v.driver) return v;
    return null;
  }

  /** Brake / tail / indicator / reverse / lightbar emissives. */
  _updateLamps(v, dt, ctx) {
    const m = v.model.lampMats;
    if (!m) return;
    const sky = ctx.peek('sky');
    const alt = sky?.sunAltitude ?? 0.6;
    const night = Math.max(0, Math.min(1, 1 - (alt + 0.02) / 0.14));
    const on = v.destroyed ? 0 : 1;
    const lightsOn = night;

    if (m.head) m.head.emissiveIntensity = on * lightsOn * 5.5;
    if (m.drl) m.drl.emissiveIntensity = on * (0.9 + lightsOn * 2.2);
    if (m.tail) m.tail.emissiveIntensity = on * lightsOn * 2.6;
    if (m.brake) {
      // `control`, not `input`: in reverse the pedals are crossed, so a player
      // backing up on S must not have the brake lights on the whole time.
      const braking = v.control.brake > 0.06 || (v.input.handbrake && v.speed > 0.4);
      m.brake.emissiveIntensity = on * (braking ? 7.5 : lightsOn * 2.2);
    }
    if (m.reverse) {
      // A real car lights these on GEAR, not on throttle.
      m.reverse.emissiveIntensity = on * (v.drivetrain.inReverse ? 5 : 0);
    }
    if (m.indicator) {
      const want = Math.abs(v.input.steer) > 0.35 && v.speed < 16;
      const blink = want ? (Math.floor(ctx.time.elapsed * 1.6) % 2 === 0 ? 1 : 0) : 0;
      m.indicator.emissiveIntensity = on * blink * 6;
    }
    if (m.policeRed || m.policeBlue) {
      const active = v.lightbarOn ?? false;
      const ph = ctx.time.elapsed * 7.5;
      if (m.policeRed) m.policeRed.emissiveIntensity = active ? (Math.sin(ph) > 0.1 ? 9 : 0.2) : 0;
      if (m.policeBlue) m.policeBlue.emissiveIntensity = active ? (Math.sin(ph + Math.PI) > 0.1 ? 9 : 0.2) : 0;
    }
  }

  /** Skid events for fx (tyre smoke, skid marks) and audio (squeal). */
  _emitWheelFx(v, dt, ctx) {
    if (v.sleeping || v.lod > 1) return;
    // A staged car whose wheels are driven kinematically is at 100% longitudinal
    // slip by construction. Letting that reach `fx` fills the shot with tyre
    // smoke and skid marks that describe the staging, not the car.
    if (v._stagedRoll) return;
    for (let i = 0; i < v.wheels.length; i++) {
      const w = v.wheels[i];
      if (!w.skidding || !w.grounded) continue;
      w.lastEmit += dt;
      if (w.lastEmit < 0.045) continue;
      w.lastEmit = 0;
      ctx.events.emit('vehicle:skid', {
        vehicle: v,
        wheel: i,
        point: w.contact,
        normal: w.normal,
        slip: w.combined,
        surface: w.surface,
      });
    }
  }

  /* ================================================================== */
  /* Debug staging (capture harness)                                    */
  /* ================================================================== */

  /**
   * Stage vehicles for a screenshot without touching a file outside this directory:
   *   node tools/capture.mjs --shot='{"pos":[…],"look":[…],"veh":"lineup"}'
   * `veh` may be 'lineup', 'row', 'damage', 'none', or a class id, optionally
   * with a paint: 'sports:0xff2200'.
   */
  debugStage(kind, shot = {}) {
    for (const v of this._debugSpawned) this.despawn(v);
    this._debugSpawned.length = 0;
    this._unhideAll();
    if (!kind || kind === 'none') return { staged: 0 };

    const look = shot.look ?? [0, 0, 0];
    const cx = look[0];
    const cz = look[2];
    const spacing = shot.spacing ?? 3.4;
    const yaw = shot.vehYaw !== undefined ? shot.vehYaw : Math.PI * 0.5;
    const rng = this.rng;
    // A staged frame is a studio frame: live traffic driving through the
    // subject (and shunting it) is not what the shot is asking about.
    this._hideNear(cx, cz, shot.clear ?? 24);

    const place = (type, ox, oz, opts) => {
      const spec = this._specs.get(type);
      if (!spec) return null;
      const x = cx + ox;
      const z = cz + oz;
      const g = this._groundAt(x, z, (shot.pos?.[1] ?? 2) + 14);
      const v = this.spawn(type, new THREE.Vector3(x, g + spec.comY + 0.02, z), yaw, opts);
      if (v) {
        // Studio subjects: not shunted, not detonated by the live street.
        // `debugStage('damage')` calls `damage.impact` directly, which is
        // deliberately not gated on this.
        v._staged = true;
        this._debugSpawned.push(v);
      }
      return v;
    };

    if (kind === 'lineup') {
      CLASS_IDS.forEach((id, i) => {
        place(id, (i - (CLASS_IDS.length - 1) / 2) * spacing, 0, {
          rng, paint: shot.paint, finish: shot.finish,
        });
      });
    } else if (kind === 'row') {
      const ids = shot.types ?? ['sports', 'muscle', 'sedan', 'police'];
      ids.forEach((id, i) => place(id, (i - (ids.length - 1) / 2) * spacing, 0, { rng }));
    } else if (kind === 'damage') {
      const v = place(shot.type ?? 'sedan', 0, 0, { rng, paint: shot.paint });
      if (v) {
        _v.set(v.position.x + 1.4, v.position.y + 0.2, v.position.z + 1.8);
        _n.set(-0.5, -0.1, -0.86).normalize();
        v.damage.impact(v.mass * 5.5, _v, _n, this.ctx);
        _v.set(v.position.x - 1.2, v.position.y + 0.3, v.position.z - 1.4);
        _n.set(0.6, -0.1, 0.8).normalize();
        v.damage.impact(v.mass * 4, _v, _n, this.ctx);
      }
    } else {
      const [type, paint] = String(kind).split(':');
      place(type, 0, 0, {
        rng,
        paint: paint ? Number(paint) : shot.paint,
        finish: shot.finish,
      });
    }
    return { staged: this._debugSpawned.length };
  }

  /**
   * The API `src/dev/shots.js` actually calls.
   *
   * The `car`, `driving` and `cockpit` shots have always run
   * `ctx.peek('vehicles')?.debugPose?.(...)` — and this subsystem only ever
   * implemented `debugStage`, so the optional-call silently did nothing and
   * three of the shot set's vehicle frames were photographs of an empty street.
   * `shots.js` is outside this directory, so the method has to appear here.
   *
   * Everything is derived from the camera the shot has ALREADY posed, so a
   * pose stays correct if the shot's framing is retuned.
   */
  debugPose(kind = 'beauty', opts = {}) {
    for (const v of this._debugSpawned) this.despawn(v);
    this._debugSpawned.length = 0;
    this._unhideAll();
    // `_onShot` fires immediately after this and would otherwise clear the
    // staging again.
    this._poseStaged = true;
    if (!kind || kind === 'none') return { staged: 0 };

    const cam = this.ctx.camera;
    cam.updateMatrixWorld();
    cam.getWorldPosition(_cam);
    // Camera forward, flattened to the ground plane.
    _v.set(0, 0, -1).applyQuaternion(cam.getWorldQuaternion(_q));
    _v.y = 0;
    if (_v.lengthSq() < 1e-6) _v.set(0, 0, -1);
    _v.normalize();

    const type = opts.type ?? (kind === 'beauty' ? 'sports' : 'muscle');
    const spec = this._specs.get(type) ?? this._specs.get('sedan');
    const dist = opts.dist ?? (kind === 'beauty' ? 7.6 : 8.5);
    let x = _cam.x + _v.x * dist;
    let z = _cam.z + _v.z * dist;

    /**
     * A beauty shot has to stand somewhere EMPTY. The shot's camera lands in
     * the middle of a live street, so the first version of this put the hero
     * car inside a traffic sedan: `_pairResolve` depenetrated the overlap on
     * the next fixed step and threw a car over the lens. Nudge along the
     * camera's forward ray until the subject has room, then hide whatever
     * traffic is still in the frame — this is a studio shot, not a street.
     *
     * ────────────────────────────────────────────────────────────────────────
     * "EMPTY" HAS TO MEAN THE WHOLE WORLD, NOT JUST THE TRAFFIC
     * ────────────────────────────────────────────────────────────────────────
     * It used to mean `this.vehicles` and nothing else, and traffic is the one
     * thing in a street that MOVES OUT OF THE WAY. Everything that does not —
     * lamp posts, bollards, hydrants, benches, bins, trees, walls — was
     * invisible to the test, so the spiral would happily settle on a spot with
     * a lamp column standing through the roof, which it did in both framings of
     * `mkt_kessel`. A pole through the subject is the same class of failure as
     * framing the shot at world origin: the picture is of the pole.
     *
     * The static world is now asked directly, and asked about the volume the
     * BODY will occupy rather than about a point:
     *
     *  - `overlapCapsule` on `MASK.WORLD` (STATIC | PROP — props register their
     *    colliders through `physics.addStatic`, which defaults to STATIC).
     *  - The capsule is LIFTED 0.3 m off the ground it is standing on. The road
     *    surface, the kerb and the pavement are static geometry too, and a
     *    capsule that touches the floor reports every candidate as blocked.
     *  - Line of sight from where the lens will end up. A wall between camera
     *    and subject ruins the frame exactly as thoroughly as a pole in it, and
     *    it is the same query.
     *
     * Scored rather than filtered, because on a dense pavement every candidate
     * may be blocked and the least-blocked one is still the shot.
     */
    const phys = this.ctx.peek?.('physics') ?? this.physics ?? null;
    const MASK_WORLD = phys?.MASK?.WORLD ?? 0x3;
    // Nose back towards the lens, swung round for a three-quarter. Resolved
    // BEFORE the spiral because the clearance probe wants the yaw the body will
    // actually be given.
    const toCam = Math.atan2(-_v.x, -_v.z);
    const yaw = opts.yaw ?? (kind === 'beauty' ? toCam - 0.66 : toCam + Math.PI);
    const fx = Math.sin(yaw);
    const fz = Math.cos(yaw);

    /**
     * Static contacts inside the volume the BODY will fill at (tx, tz).
     *
     * Three thin capsules laid along the car's own axis rather than one fat
     * one, and the radius matters more than it looks. A single capsule sized
     * off the half-width (0.98 m) is a 1.96 m TALL pill — it reaches a third of
     * a metre above the roof of the car it is standing in for, so it collects
     * awnings, sign faces, wires and tree canopies and reports 18 contacts on
     * an empty pavement. Every candidate then scores the same and the search
     * silently degrades to "keep the first one", which is the behaviour it
     * replaced. MEASURED at the `mkt_kessel` spot: 18 contacts at every lift
     * from 0.1 m to 0.6 m, and the thing actually in the way was 0.38 m from
     * the centreline.
     *
     * 0.52 m capsules at three lateral offsets cover a 4.9 x 2.0 x 1.04 m box
     * starting 0.30 m off the ground — the body, and not the road under it.
     */
    const halfLen = Math.max(1.0, spec.dims.L * 0.5 - 0.52);
    // `?owNoPoseClear=1` reverts to the traffic-only test, so `poseprobe.mjs`
    // can A/B the fix rather than assert that the current code agrees with
    // itself. Same convention as `?owNoLightLock=1` in `src/render/`.
    const staticClear = typeof location === 'undefined'
      || !/[?&]owNoPoseClear=1/.test(location.search);
    const blockedAt = (tx, tz, gy) => {
      if (!staticClear || !phys?.overlapCapsule) return 0;
      let n = 0;
      const cy = gy + 0.30 + 0.52;
      for (const lat of [-0.5, 0, 0.5]) {
        const ox = tx + fz * lat;
        const oz = tz - fx * lat;
        _v2.set(ox - fx * halfLen, cy, oz - fz * halfLen);
        _v3.set(ox + fx * halfLen, cy, oz + fz * halfLen);
        n += phys.overlapCapsule(_v2, _v3, 0.52, MASK_WORLD);
      }
      return n;
    };

    /**
     * How far the ground moves under the footprint, metres.
     *
     * The FLOOR is street furniture too. Dodging a lamp post is worthless if
     * the spot it dodges to has a kerb or a planter edge running under one
     * flank: the car is chocked but the suspension still settles into the step,
     * the body rolls, and `frameVehicle` has already aimed the lens at where a
     * level car would have been. Costed at one static contact per 10 cm of
     * step, so a genuinely flat spot beats a stepped clear one — but banded at
     * 12 cm rather than 10, because a city pavement has 8 cm of camber and
     * drainage fall in it everywhere and charging for that reframes every shot
     * that was already fine. A kerb is 15 cm; that is the thing being caught.
     */
    const stepAt = (tx, tz) => {
      if (!staticClear) return 0;
      let lo = Infinity;
      let hi = -Infinity;
      const hw = spec.dims.W * 0.5;
      for (const [a, b] of [[halfLen, hw], [halfLen, -hw], [-halfLen, hw], [-halfLen, -hw]]) {
        const h = this._groundAt(tx + fx * a + fz * b, tz + fz * a - fx * b, _cam.y + 12);
        if (!Number.isFinite(h)) continue;
        if (h < lo) lo = h;
        if (h > hi) hi = h;
      }
      return hi > lo ? hi - lo : 0;
    };

    let bestClear = -1;
    let bestBlocked = Infinity;
    let g = this._groundAt(x, z, _cam.y + 12);
    const scan = [];
    /**
     * Candidates in order of INCREASING DISPLACEMENT from the authored spot,
     * and the order is the whole design.
     *
     * A spiral that varies the forward distance fastest reaches for "further
     * down the street" before it reaches for "a metre to the left", so the
     * first clear spot it finds can be five metres from where the shot was
     * aimed — and `frameVehicle` derives the lens FROM the car, so the whole
     * composition moves with it. Sorted by |offset|, a lamp post costs the
     * subject 2.3 m sideways instead of 4.8 m up the road.
     */
    const OFFSETS = [
      [0, 0], [0, -2.3], [0, 2.3],
      [2.4, 0], [2.4, -2.3], [2.4, 2.3],
      [0, -4.6], [0, 4.6], [4.8, 0],
      [2.4, -4.6], [2.4, 4.6], [4.8, -2.3], [4.8, 2.3],
      [4.8, -4.6], [4.8, 4.6],
    ];
    for (let i = 0; i < OFFSETS.length; i++) {
      const dd = dist + OFFSETS[i][0];
      const lat = OFFSETS[i][1];
      const tx = _cam.x + _v.x * dd - _v.z * lat;
      const tz = _cam.z + _v.z * dd + _v.x * lat;
      let clear = 1e9;
      for (const o of this.vehicles) {
        const d2 = (o.position.x - tx) ** 2 + (o.position.z - tz) ** 2;
        if (d2 < clear) clear = d2;
      }
      const gy = this._groundAt(tx, tz, _cam.y + 12);
      const step = stepAt(tx, tz);
      const blocked = blockedAt(tx, tz, gy) + Math.floor(step / 0.12);
      scan.push({
        x: +tx.toFixed(2), z: +tz.toFixed(2), blocked,
        step: +step.toFixed(2), clear: +Math.sqrt(clear).toFixed(2),
      });
      // Street furniture first, then traffic: a lamp post cannot be hidden and
      // a traffic car can — `_hideNear` runs immediately below.
      if (blocked < bestBlocked || (blocked === bestBlocked && clear > bestClear)) {
        bestBlocked = blocked;
        bestClear = clear;
        x = tx; z = tz; g = gy;
      }
      if (blocked === 0 && clear > 8 * 8) break;
    }
    /** Read by `src/vehicles/poseprobe.mjs`. Staging only; never per frame. */
    const tris = this.physics?.stats?.triangles ?? 0;
    this._poseScan = {
      scan, chose: { x: +x.toFixed(2), z: +z.toFixed(2) }, blocked: bestBlocked, tris,
    };
    // Ask again once the city under the camera has actually arrived. See
    // `_restageWhenStreamed` — this is the difference between querying the
    // world and querying an empty BVH.
    this._poseRestage = staticClear && !opts._restage
      ? { kind, opts: { ...opts, _restage: true }, tris }
      : null;
    this._hideNear(x, z, 30);

    const v = this.spawn(type, new THREE.Vector3(x, g + spec.comY + 0.02, z), yaw, {
      rng: this.rng,
      paint: opts.paint ?? (kind === 'beauty' ? 0x7d1b16 : undefined),
      finish: opts.finish ?? (kind === 'beauty' ? 'gloss' : undefined),
      flake: opts.flake ?? (kind === 'beauty' ? 0.8 : undefined),
      plate: 'DCB 440',
    });
    if (!v) return { staged: 0 };
    this._debugSpawned.push(v);
    v.engineOn = true;
    // A studio subject does not get written off by the street it is parked in.
    v._staged = true;

    if (kind === 'beauty') {
      // Reframe: the clear ground may not be where the shot was aimed, so put
      // the lens at a fixed three-quarter offset from the SUBJECT instead of
      // trusting the authored look target.
      const a = yaw + 0.66;
      const r = opts.camDist ?? 7.0;
      cam.position.set(x + Math.sin(a) * r, g + 1.5, z + Math.cos(a) * r);
      cam.lookAt(x, g + spec.dims.H * 0.52, z);
      cam.updateMatrixWorld();
      // A capture settles for hundreds of frames — twenty seconds of sim. The
      // first version of this framed the car and then watched it coast 10 m
      // down the camber and out of shot. Chock it.
      v.input.brake = 1;
      v.input.handbrake = true;
      this._poseAnchor = { v, x, z, cam: null };
    } else if (kind === 'chase' || kind === 'driving') {
      // Rolling, so the wheels are spun up and the body is loaded. The car is
      // PINNED (see `_poseAnchor` in the fixed step) and the wheels are turned
      // kinematically: left free it drove 420 m during the settle and out of
      // every frame it was staged for.
      const sp = opts.speed ?? 21;
      v.input.throttle = 0.85;
      v.input.steer = 0.12;
      v._stagedRoll = sp;
      for (const w of v.wheels) w.omega = sp / (w.hp.radius || 0.34);
      this._poseAnchor = { v, x, z, cam: 'chase', roll: sp, g };
      this._applyPoseCamera(cam);
    } else if (kind === 'cockpit') {
      const sp = opts.speed ?? 12;
      v.input.throttle = 0.4;
      v._stagedRoll = sp;
      for (const w of v.wheels) w.omega = sp / (w.hp.radius || 0.34);
      this._poseAnchor = { v, x, z, cam: 'cockpit', roll: sp, g };
      this._applyPoseCamera(cam);
    }
    // The camera may have moved; re-pick the level from where it ended up.
    this._selectLod(v, true);
    return { staged: 1, type, pos: [x, g, z] };
  }

  /**
   * Re-derive the staged camera from the subject EVERY FRAME.
   *
   * `debugPose` used to place the camera once. The car then moved — under
   * throttle in `chase`/`cockpit`, and even in `beauty` the suspension settles
   * and the body pitches over the couple of hundred frames a capture takes — so
   * by the time the shutter fired the camera was aimed at where the car had
   * been. Deriving it from the subject each frame is the only version of this
   * that is correct at shutter time rather than at staging time.
   */
  _applyPoseCamera(cam = this.ctx.camera) {
    const pa = this._poseAnchor;
    if (!pa?.cam) return;
    const v = pa.v;
    _fwd.set(0, 0, 1).applyQuaternion(v.quaternion);
    if (pa.cam === 'chase') {
      // Behind, above, and slightly inboard — a chase rig, not a drone.
      cam.position.set(
        v.position.x - _fwd.x * 6.6 + _fwd.z * 0.9,
        pa.g + 2.25,
        v.position.z - _fwd.z * 6.6 - _fwd.x * 0.9
      );
      cam.lookAt(
        v.position.x + _fwd.x * 6,
        pa.g + 1.05,
        v.position.z + _fwd.z * 6
      );
    } else {
      /**
       * NOT `seatAnchor`, for two reasons. It allocates four Vector3s per call
       * and this runs every frame (hard rule 5), and it returns the DRIVER'S
       * HEAD — which on a muscle car is 35 cm behind the steering wheel, so a
       * 65-degree lens parked there is 90% steering wheel. A cockpit camera
       * belongs at the headrest, not at the eyeballs: back another 27 cm and up
       * 10, which puts the rim across the bottom third and the road through the
       * screen where the shot is asking for them.
       */
      const st = v.spec.style;
      const hip = st.groundY + Math.max(0.1, st.sillY - 0.16) + 0.22;
      _v2.set(-st.hwMax * 0.46, hip - v.spec.comY + 0.55, st.cowlZ - 1.14)
        .applyQuaternion(v.quaternion)
        .add(v.position);
      cam.position.copy(_v2);
      /**
       * Aim THROUGH THE WINDSCREEN APERTURE, not along a fixed pitch. The
       * aperture's height differs by 40 cm between a wedge and a van, so a
       * hardcoded "8 m ahead and 0.55 m down" points at the headliner on one
       * class and at the bonnet on another — the first cut of this framed the
       * inside of the roof lining with the road nowhere in it. Deriving the
       * target from `beltY` and `cowlZ`, the two numbers that define the
       * aperture, makes it correct on every class by construction.
       */
      _v3.set(0, st.beltY - v.spec.comY + 0.55, st.cowlZ + 14)
        .applyQuaternion(v.quaternion)
        .add(v.position);
      cam.lookAt(_v3);
    }
    cam.updateMatrixWorld();
  }

  /**
   * Hide (never despawn) live traffic around a staged subject. `traffic` owns
   * those vehicles and holds references to them, so the root is only made
   * invisible and restored by `_unhideAll` when the next shot is staged.
   */
  /**
   * ────────────────────────────────────────────────────────────────────────
   * THE CLEAR-SPOT TEST HAS TO RUN AGAINST A WORLD THAT EXISTS
   * ────────────────────────────────────────────────────────────────────────
   * `shot.apply` fires the moment the camera is posed, and the camera has just
   * teleported kilometres. `world` has not streamed the tiles under it yet, so
   * `physics.staticWorld` is still holding the collision from wherever the
   * player used to be — and every capsule query the search makes comes back
   * clean because there is nothing there to hit yet. The search then reports
   * "candidate 0, blocked 0" with total confidence and parks the car in a lamp
   * post, which is the same defect the search was written to fix, one layer
   * further in.
   *
   * MEASURED on `mkt_kessel`: the search saw 560 126 static triangles by the
   * time the shutter fired and 0 when it ran. Its own probe said blocked = 0;
   * an independent ray fan out of the settled body found concrete at 0.22 m and
   * the car sitting at 14.7 degrees of roll against a plaza wall.
   *
   * `tools/capture.mjs` already refuses to press the shutter until
   * `world.streamingIdle()` — so re-run the search once, on the first frame
   * where the streaming queue has drained AND the static triangle count has
   * actually moved. Once, guarded, and never in play: `_poseRestage` is only
   * ever set by `debugPose`.
   */
  _restageWhenStreamed() {
    const req = this._poseRestage;
    if (!req) return;
    const w = this._world();
    if (w?.streamingIdle && !w.streamingIdle()) return;
    const tris = this.physics?.stats?.triangles ?? 0;
    if (tris === req.tris) {
      // Nothing new arrived; the first answer was against the real world.
      this._poseRestage = null;
      return;
    }
    this._poseRestage = null;
    this.debugPose(req.kind, req.opts);
  }

  _hideNear(x, z, radius) {
    this._hideZone = { x, z, r2: radius * radius };
    this._applyHideZone();
  }

  /**
   * Re-evaluated every frame while a pose is staged: a capture settles for a
   * couple of hundred frames, and traffic keeps driving into the shot for all
   * of them.
   */
  _applyHideZone() {
    const zn = this._hideZone;
    if (!zn) return;
    const hidden = (this._hidden ??= []);
    for (const o of this.vehicles) {
      if (this._debugSpawned.includes(o)) continue;
      const inside = (o.position.x - zn.x) ** 2 + (o.position.z - zn.z) ** 2 <= zn.r2;
      if (inside === !o.model.root.visible) continue;
      o.model.root.visible = !inside;
      // Hidden means hidden: an invisible shunt still throws dust, sparks and
      // a fireball into the frame being photographed.
      o._noCollide = inside;
      if (inside) hidden.push(o);
    }
  }

  _unhideAll() {
    this._hideZone = null;
    this._poseAnchor = null;
    if (!this._hidden?.length) return;
    for (const o of this._hidden) {
      o.model.root.visible = true;
      o._noCollide = false;
    }
    this._hidden.length = 0;
  }

  _groundAt(x, z, fromY = 30) {
    const h = this.physics?.groundHeight?.(x, z, fromY);
    if (h !== undefined && Number.isFinite(h)) return h;
    const w = this._world();
    return w?.groundHeight?.(x, z) ?? w?.heightAt?.(x, z) ?? 0;
  }

  /** Telemetry for tools/playtest and the dev overlay. */
  telemetry(v) {
    if (!v) return null;
    return {
      type: v.type,
      speedKmh: +(v.speed * 3.6).toFixed(1),
      forward: +v.forwardSpeed.toFixed(2),
      slipDeg: +((v.slipAngle * 180) / Math.PI).toFixed(1),
      rpm: Math.round(v.drivetrain.rpm),
      gear: v.drivetrain.gearLabel,
      grounded: v.grounded,
      health: Math.round(v.health),
      fuel: +v.fuel.toFixed(2),
      fuelDry: !!v.fuelDry,
      burnsFuel: !!v.burnsFuel,
      horn: !!v.horn,
      loads: v.wheels.map((w) => Math.round(w.load)),
      slips: v.wheels.map((w) => +w.combined.toFixed(2)),
      susp: v.wheels.map((w) => +w.len.toFixed(3)),
      comAboveGround: +(v.position.y - (v.diag.groundY ?? 0)).toFixed(3),
      diag: {
        contacts: v.diag.contacts,
        pushY: +v.diag.pushY.toFixed(4),
        rayLen: +v.diag.rayLen.toFixed(3),
        surface: v.diag.raySurface,
        obj: v.diag.rayObj,
      },
      pitchDeg: +((Math.asin(clampAbs(fwdY(v), 1)) * 180) / Math.PI).toFixed(2),
      rollDeg: +((Math.asin(clampAbs(rightY(v), 1)) * 180) / Math.PI).toFixed(2),
    };
  }

  get stats() {
    return this._stats;
  }

  /* ================================================================== */
  /* Pre-warm                                                           */
  /* ================================================================== */

  /**
   * Build and compile every material this subsystem can produce, without
   * spawning gameplay objects. Proxy meshes in a throwaway scene are enough:
   * a program's cache key depends on the material's defines and the light
   * counts, not on which geometry is in front of it.
   */
  async prewarmMaterials(ctx = this.ctx) {
    const render = ctx.peek?.('render');
    const renderer = render?.renderer;
    if (!renderer) return { ok: false, reason: 'no renderer' };
    const before = renderer.info.programs?.length ?? 0;
    const t0 = performance.now();

    const scene = new THREE.Scene();
    scene.environment = ctx.scene.environment;
    const cam = new THREE.PerspectiveCamera(50, 1, 0.1, 100);
    cam.position.set(0, 0, 4);

    const box = new THREE.BoxGeometry(1, 1, 1);
    const plane = new THREE.PlaneGeometry(1, 1);
    const boxVC = box.clone();
    const n = boxVC.attributes.position.count;
    boxVC.setAttribute('color', new THREE.BufferAttribute(new Float32Array(n * 3).fill(1), 3));
    /**
     * The proxy MUST carry `aWear`, the weathering mask attribute the paint
     * extension declares (see `installWear` in paint.js). A missing attribute
     * does not change the program on its own — WebGL falls back to a constant
     * generic attribute — but compiling against a geometry that has it is what
     * keeps this warm-up honest about the real draw, and it costs 24 floats.
     */
    boxVC.setAttribute('aWear', new THREE.BufferAttribute(new Float32Array(n * 3).fill(0.5), 3));

    const mats = [];
    /**
     * Every paint the spawner can produce, INCLUDING the per-instance colour
     * and wear variants: `_choosePaint` jitters a base colour into one of
     * `PAINT_TONES` tones and one of `PAINT_WEARS` condition steps, so the
     * cache key set is (pool colours x tones x wears) and all of it has to be
     * built here or the first traffic car of an unseen combination compiles
     * during play. They all share ONE program — the variation is uniform
     * values, not defines — so this is ~300 cheap cache hits, not 300 compiles.
     */
    /**
     * The SAME list `_choosePaint` picks from, built with the SAME argument
     * expression `buildVehicleModel` uses — including the `clearcoat` override
     * that the old pre-warm got wrong for every colour in the `work` pool and
     * for every beater in the game. See `paintVariants`.
     */
    for (const v of (VARIANTS ??= paintVariants())) {
      mats.push([
        this.mats.paint(v.paint, {
          finish: v.finish, flake: v.flake, wear: v.wear,
          clearcoat: v.finish === 'gloss' ? 1 : 0.2,
        }),
        boxVC,
      ]);
    }
    // The staged beauty paint, which `debugPose` asks for by hand.
    mats.push([this.mats.paint(0x7d1b16, { finish: 'gloss', flake: 0.8, clearcoat: 1, wear: 0 }), boxVC]);
    for (const m of [
      this.mats.glass(), this.mats.glass({ tint: 0x9aa6b4, opacity: 0.86 }),
      this.mats.rubber(), this.mats.rim('alloy'), this.mats.rim('steel'),
      this.mats.disc(), this.mats.caliper(), this.mats.chrome(),
      this.mats.trim('dark'), this.mats.trim('grey'), this.mats.cavity(),
      this.mats.grilleMesh(), this.mats.rustMetal(), this.mats.seat(),
      this.mats.leather(), this.mats.dash(), this.mats.livery('police'),
      this.mats.distant(),
    ]) mats.push([m, box]);
    /**
     * Every PAINTED CALIPER any class declares. Derived from the spec table
     * rather than listed here, so a class that adds one cannot forget to warm
     * it — the failure mode being a shader compile the first time the player
     * walks past that car. Colour is a uniform and not a define, so these all
     * share the default caliper's program and cost a cache hit each.
     */
    for (const s of this._specs.values()) {
      if (s.wheel?.caliper) mats.push([this.mats.caliper(s.wheel.caliper), box]);
    }
    for (const k of ['head', 'drl', 'tail', 'brake', 'indicator', 'reverse', 'policeRed', 'policeBlue']) {
      mats.push([this.mats.lamp(k), box]);
    }
    mats.push([this.mats.plate('AAA 000'), plane]);

    let x = 0;
    for (const [m, g] of mats) {
      const mesh = new THREE.Mesh(g, m);
      mesh.position.set((x % 20) * 1.5 - 15, Math.floor(x / 20) * 1.5, 0);
      scene.add(mesh);
      x++;
    }
    render.patchMaterials?.(scene);

    const prevOverride = scene.overrideMaterial;
    try {
      await this._compile(renderer, scene, cam);
      for (const over of [render.csm?.depthMaterial, render.gbuffer?.material]) {
        if (!over) continue;
        scene.overrideMaterial = over;
        await this._compile(renderer, scene, cam);
      }
    } finally {
      scene.overrideMaterial = prevOverride;
      scene.clear();
      box.dispose();
      boxVC.dispose();
      plane.dispose();
    }

    return {
      ok: true,
      ms: Math.round(performance.now() - t0),
      compiled: (renderer.info.programs?.length ?? 0) - before,
      materials: mats.length,
    };
  }

  async _compile(renderer, scene, camera) {
    try {
      await renderer.compileAsync(scene, camera);
    } catch {
      try { renderer.compile(scene, camera); } catch { /* driver cannot warm */ }
    }
  }

  dispose() {
    this.ctx?.events.off('shot:applied', this._onShot);
    this.ctx?.events.off('explosion', this._onExplosion);
    this.ctx?.events.off('vehicle:enter', this._onEnter);
    this.ctx?.events.off('vehicle:exit', this._onExit);
    this.ctx?.events.off('weather:change', this._onWeather);
    this.ctx?.events.off('game:character', this._onHeroChange);
    this.ctx?.events.off('player:brother', this._onHeroChange);
    for (const v of [...this.vehicles]) this.despawn(v, { hard: true });
    this.vehicles.length = 0;
    clearGeometryCache();
    this.mats?.dispose();
    this.groundShadows?.group.parent?.remove(this.groundShadows.group);
    this.groundShadows?.dispose();
    this.groundShadows = null;
    this.root?.parent?.remove(this.root);
  }
}

function clamp01(v) {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}
function clampAbs(v, m) {
  return v > m ? m : v < -m ? -m : v;
}
function fwdY(v) {
  const q = v.quaternion;
  return 2 * (q.y * q.z + q.w * q.x);
}
function rightY(v) {
  const q = v.quaternion;
  return 2 * (q.x * q.y - q.w * q.z);
}

export { VEHICLE_SPECS, CLASS_IDS, SURFACE_GRIP, modelStats };
