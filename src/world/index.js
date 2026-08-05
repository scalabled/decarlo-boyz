import * as THREE from 'three';
import { PALETTE } from './palette.js';
import {
  CITY_SIZE, TILE, SECTOR, WATER_Y, RIVERS, DISTRICTS, LANDMARKS, AIRFIELDS,
  DOCKS, SAFEHOUSES, BRIDGES, ROAD_KIND, LANDMARK_RESERVE, roadHalfWidth,
  siteDist, nearestSiteDist, tileOf as tileOfXZ,
} from './plan.js';
import { Terrain } from './terrain.js';
import { TerrainMesh } from './terrainmesh.js';
import { generateCity } from './netgen.js';
import { subdivide, resetLotIds } from './lots.js';
import { RoadMeshBuilder, noGapFix } from './roadmesh.js';
import { Water } from './water.js';
import { buildBridges } from './bridges.js';
import { buildAirfieldPaving, airfieldPavedAt, airfieldDeckAt } from './airfield.js';
import {
  buildAirbasePaving, airbasePavedAt, airbaseDeckAt, finaliseAirbase,
} from './airbase.js';
import { AIRBASE } from './plan.js';
import { JobQueue, RingTracker } from './streaming.js';
import { publishInclineTracks } from './incline.js';

/** `?owNoWarmFix=1` reverts this subsystem's pre-warm to the pre-fix behaviour,
 *  so the two arms can be interleaved in one measurement session. */
const NO_WARM_FIX =
  typeof location !== 'undefined' &&
  new URLSearchParams(location.search).has('owNoWarmFix');

/**
 * DETERMINISTIC STREAMING BUDGET — jobs per frame, capture mode only.
 *
 * See the header of `streaming.js` for why a millisecond budget cannot be used
 * under `config.deterministic`. This is the number that replaces it.
 *
 * SIZED, not guessed. MEASURED on `hero` at `ultra`, the whole ring around the
 * shot is 2 966 jobs, and the wall-clock path (8 ms/frame on an idle machine)
 * drained it in ~180 frames — an average of ~16 jobs per frame, with the mix
 * running from 100 tiny jobs in one 8 ms slice early on down to 4 heavy ones
 * later. 32 is that average doubled: it drains the same work in ~100 frames, so
 * a capture reaches full content EARLIER than the wall-clock path did on a fast
 * machine, and identically on a slow one.
 *
 * Higher is not free — one frame's worth of heavy sector jobs at 2 ms each is a
 * 64 ms frame — but capture is pumped frame by frame and nothing in it is
 * rate-sensitive, which is the same trade `engine.js` makes when it drops
 * `FIXED_STEP_BUDGET_MS` in capture mode.
 *
 * `?owBuildJobs=N` overrides it and `?owWallClockBuild=1` restores the play
 * budget in capture mode — the A/B hatch that gives this fix its negative
 * control (revert it and the 2959/4074/4096 spread comes straight back).
 */
const DET_JOBS_PER_FRAME = 32;

const _qs = typeof location !== 'undefined' ? new URLSearchParams(location.search) : null;
/** Force the wall-clock budget even under `deterministic`. Negative control. */
const WALL_CLOCK_BUILD = _qs?.get('owWallClockBuild') === '1';
const DET_JOBS_OVERRIDE = Number(_qs?.get('owBuildJobs')) || 0;

/**
 * Run `fn` with a render target bound, so every program compiled inside it gets
 * the cache key a REAL frame asks for.
 *
 * three folds `outputColorSpace` AND `toneMapping` into the program cache key
 * and reads both off the CURRENTLY BOUND target: with the canvas bound (which is
 * what `core/prewarm.js` leaves bound when it calls the subsystem hooks) every
 * program compiled is the `srgb` + tone-mapped variant, but the world is drawn
 * into an HDR target, which needs `srgb-linear` + NoToneMapping. The pre-warmed
 * program is then never asked for and the real one compiles during play.
 *
 * MEASURED on this subsystem's own output: of 42 programs compiling mid-play,
 * 24 differed from an already-warm program in NOTHING BUT `srgb -> srgb-linear`.
 *
 * ARCHITECTURE.md documents this trap under "Pre-warm"; `src/fx` and
 * `core/prewarm.js`'s own `compileAsync` step already do this. The three
 * streamed-city hooks (world / buildings / props) did not.
 *
 * A 1x1 target is enough to get the key; nothing is ever rendered into it.
 */
async function withFrameTarget(renderer, fn) {
  if (NO_WARM_FIX) return fn();
  const prevRt = renderer.getRenderTarget();
  const prevFace = renderer.getActiveCubeFace?.() ?? 0;
  const prevMip = renderer.getActiveMipmapLevel?.() ?? 0;
  const rt = new THREE.WebGLRenderTarget(1, 1, { depthBuffer: false, stencilBuffer: false });
  try {
    renderer.setRenderTarget(rt);
    return await fn();
  } finally {
    renderer.setRenderTarget(prevRt, prevFace, prevMip);
    rt.dispose();
  }
}

/**
 * WORLD — Steel City.
 *
 * A 3 km square, origin centred, of three river valleys meeting at The Point,
 * a 104 m bluff on the south bank, twelve districts, eleven bridges and about
 * a hundred kilometres of connected road.
 *
 * WHAT LIVES WHERE
 *   plan.js        every authored number: rivers, districts, bridges, landmarks
 *   terrain.js     the analytic heightfield + the 8 m bake everything reads
 *   terrainmesh.js the geometry clipmap — 7 meshes for +-6 km of ground
 *   netgen.js      corridors -> planar road graph -> blocks -> road height field
 *   roadgraph.js   the RoadGraph traffic/police/peds/minimap drive on
 *   lots.js        block subdivision into the `Lot` records `buildings` eats
 *   roadmesh.js    the road SURFACE: camber, kerbs, worn paint, drains, rail
 *   bridges.js     truss / arch / suspension superstructure, piers, parapets
 *   water.js       the river sheet and its scrolling normal layers
 *   streaming.js   the amortised job queue + ring bookkeeping
 *
 * PUBLIC API — `const w = ctx.get('world')`, see ARCHITECTURE.md
 *   w.CITY_SIZE  w.heightAt  w.surfaceAt  w.roads  w.districtAt  w.lotsInTile
 *   w.schedule   w.tileOf    w.isWater    w.streamingIdle
 * plus the pre-existing helpers other subsystems still call: groundHeight,
 * spawn, isOpen, levelToWorld/worldToLevel, overlapCapsule, queryAabb,
 * sweepCapsule, prewarmMaterials, getHudState.
 */

/** Fixed punctual-light slot count. See ARCHITECTURE.md, "the point-light count". */
const LIGHT_SLOTS = 12;

/** Sectors of my own road geometry kept resident. */
const SECTOR_RADIUS_MAX = 520;
/**
 * ROAD COLLISION IS ITS OWN STREAM, WITH ITS OWN RADIUS.
 *
 * It used to be a by-product of the visible sector: `SectorBuild` emitted a
 * collider alongside the geometry, and whatever happened to be resident and
 * within one sector of the camera got registered. Those two sets do not agree.
 * The visible set is a DISC — `RingTracker` accepts a sector whose CENTRE is
 * inside `SECTOR_RADIUS_MAX + 0.75 * SECTOR` — while collision was taken over
 * the 3x3 CHEBYSHEV neighbourhood, so the four diagonal sectors were asked for
 * a collider that had never been built. `physics` measured what that costs:
 * only 92-95% of the carriageway within 512 m of the camera had real road
 * collision under it, and arterials — the fast roads — were the worst of it.
 *
 * Now: every sector whose bounds are within `COL_RADIUS` of the camera gets a
 * collision-only build, whether or not it is drawn. `COL_MARGIN` covers the
 * fact that an edge is filed under the sector containing its MIDPOINT, so its
 * geometry can reach up to half its length past that sector's bounds.
 * `COL_DROP` is hysteresis: a camera idling on a sector line must not thrash
 * two colliders in and out and rebuild the BVH every frame.
 */
const COL_RADIUS = 512;
const COL_MARGIN = 96;
const COL_DROP = 72;
/**
 * Half-size and spacing of the terrain collision patch that follows the camera.
 *
 * 192 m was too tight to be the world's floor: `physics` reported a downward
 * ray at (-504, 432) finding no ground in 200 m, and anything that asks the
 * collision world a question about somewhere it is not standing — a mission
 * placing a crate, a director scoring a spawn, a helicopter — got the same
 * answer. 320 m at the same 8 m spacing is 6561 vertices and 12 800 triangles,
 * which is nothing against a city, and it covers `q.streamRadius` at every
 * preset. For a query further out than this there IS no collision by design;
 * use `world.walkableHeightAt`, which is analytic and always available.
 */
const TCOL_HALF = 320;
const TCOL_STEP = 8;

/**
 * THE SAFETY NET — a coarse ground sheet over the WHOLE city, resident from
 * boot to shutdown, registered on `LAYER.CLIP`.
 *
 * `physics` measured the hole this closes: a dropped capsule found a floor on
 * **11.4%** of the map, because real triangles only exist inside `TCOL_HALF`.
 * Its analytic fallback closed the RAY path (bullets, explosions, wheel probes,
 * `groundHeight`) to 100%, but a sweep cannot be answered analytically — so
 * anything simulated at distance still fell out of the world, silently.
 *
 * Two decisions make this safe to leave switched on everywhere:
 *
 *   1. **`LAYER.CLIP`, not `LAYER.STATIC`.** CLIP is in `MASK.CHARACTER` and
 *      `MASK.DEBRIS` and in neither `MASK.WORLD` nor `MASK.BULLET`. So capsules
 *      and ragdolls land on it and bullets, cameras, cover queries, decals and
 *      `groundHeight` never see it — the analytic surface stays the authority
 *      for every question that wants an accurate height. Registering this on
 *      STATIC would have swapped a 0.16% "hit below the visible ground" rate
 *      for a ~90% one.
 *   2. **It is provably UNDER the real ground.** Each vertex takes the MINIMUM
 *      of the terrain over the cells it corners, so the interpolated sheet is a
 *      convex combination of values that are each at or below the ground inside
 *      that cell. It can therefore never win against real geometry: within
 *      `TCOL_HALF` the 8 m patch is always the higher surface, and the net is
 *      only ever reached by something that would otherwise have fallen forever.
 *
 * 25 m spacing over +-1600 m is 16 641 vertices and 32 768 triangles, ~15% on
 * top of the resident static world, built once and never rebuilt.
 */
const NET_HALF = 1600;
const NET_STEP = 25;
/** Never let the net hang further than this below the point it is under. */
const NET_MAX_DROP = 12;

/**
 * THE CORRIDOR FLOOR — the same idea as the safety net, at street scale.
 *
 * The net above closes "there is no collision out here at all". It cannot close
 * the worse defect — floating sidewalks with a hole between them that a walker
 * gets stuck in — because that one happens where collision IS resident and IS
 * dense.
 *
 * `netgen.rasteriseRoads` sinks the terrain 0.55 m under every corridor so it
 * can never come up through the tarmac, and `roadmesh` then lays carriageway,
 * kerb and footway on top. Wherever `roadmesh` declines to lay a footway — and
 * it declines wherever a strip would stand in another corridor's lane or on
 * another corridor's pavement, which in a hand-cut road graph is a lot of
 * places — the only collider left is that sunk terrain. A footway is 0.70 m
 * above it. So the city was full of TRENCHES up to 3.7 m wide and 0.70 m deep,
 * running between a carriageway and the pavement beside it: deeper than any
 * step-up assist, walled on both sides, and therefore a man-trap.
 *
 * `roadmesh` now lays a graded skirt instead of nothing (see `SKIRT_LIP`
 * there), which closes the strips it owns. This closes the rest — junction
 * corners, mouths, the seams between two corridors that overlap, and every gap
 * that has not been invented yet — with one sheet that does not care WHY the
 * surface above it is missing:
 *
 *   a flat quad over every non-bridge corridor, node to node, out to the back
 *   of the footway, at the carriageway plane minus `FLOOR_SINK`.
 *
 * Same two safety arguments as the net, and they are what make it free:
 *
 *   1. **`LAYER.CLIP`.** Characters and ragdolls stand on it; `MASK.WORLD` and
 *      `MASK.BULLET` cannot see it, so no vehicle wheel ray, no bullet, no
 *      camera, no decal and no `groundHeight` answer changes by a millimetre.
 *      A sheet that closed a pedestrian hole by putting a new lip under a car
 *      would be trading one subsystem's bug for another's.
 *   2. **Provably under every ROAD surface.** The real carriageway is
 *      `roadY + camber + roadWob`, worst case `roadY - 0.052`; kerb tops and
 *      footways are 0.15 m above that again. `FLOOR_SINK` is larger than the
 *      worst wob, so a downward query inside the corridor always finds real
 *      geometry first and this sheet is reached only where there is none.
 *
 * It is deliberately NOT under the sunk terrain — that is the entire point, and
 * it is the one place this differs from the net. `FLOOR_LIFT` bounds how far it
 * may float above real ground OUTSIDE the graded corridor (a Mt. Washington cut
 * where the hillside falls away past the kerb), and it is set below the 0.70 m
 * trench it removes, so the worst case is strictly better than the status quo.
 *
 * MEASURED with `node src/physics/walksweep.mjs`, 450 walkers over 8 760 m of
 * pavement in five districts, this sheet plus the `roadmesh` skirt together:
 * capsule traps 1 -> 0, walkers stopping dead on pavement 0.89% -> 0.22%,
 * unrequested falls over 0.40 m 2.72 -> 0.27 per 100 m covered, and
 * capsule-scale steps in the walkable surface 7.13% -> 2.14%. `?nogapfix=1`
 * reverts both halves and is the negative control.
 *
 * THE LIMIT OF IT, stated because someone will need this: `--noclip` on that
 * sweep reports the real-triangle layer alone — 6.55% steps and 6 traps — and
 * that is the world a VEHICLE lives in, because CLIP is not in `MASK.WORLD`.
 * The skirt improves it (7.13 -> 6.55) but only the sheet closes it, and
 * putting the sheet on `STATIC` is a decision about car handling, not
 * pedestrians. It belongs to `src/vehicles`, not here.
 */
const FLOOR_SINK = 0.12;
const FLOOR_LIFT = 0.58;
/**
 * Metres between rows along an edge. The road plane is exactly linear between
 * two nodes, so rows exist only for the OUTER columns, which track ground that
 * has fallen away past the corridor — and inside the corridor that ground is
 * graded flat, so they rarely move. 18 m and an 8-segment junction fan is
 * 88k triangles over 179 km of street; 12 m and a 10-segment fan was 118k for
 * no measurable change in what the sheet covers.
 */
const FLOOR_ROW = 18;
const FLOOR_FAN = 8;

export class WorldSystem {
  static id = 'world';
  static deps = ['materials', 'physics'];

  async init(ctx) {
    this.ctx = ctx;
    this.rng = ctx.rng.fork();
    const materials = ctx.get('materials');
    const physics = ctx.peek('physics');
    this.physics = physics;
    this.materials = materials;

    this.CITY_SIZE = CITY_SIZE;
    this.TILE = TILE;
    this.SECTOR = SECTOR;
    this.WATER_Y = WATER_Y;

    this.root = new THREE.Group();
    this.root.name = 'world';
    this.root.matrixAutoUpdate = false;
    ctx.scene.add(this.root);
    materials.setGroundLevel?.(0);

    const t0 = performance.now();

    /* ---- 1. terrain ---------------------------------------------------- */
    this.terrain = new Terrain({ cell: 8, extent: 1792 });
    this.terrain.bake();
    const tBake = performance.now();

    /* ---- 2. the city plan --------------------------------------------- */
    resetLotIds();
    const city = generateCity(this.terrain, this.rng.fork());
    this.roads = city.graph;
    this.blocks = city.blocks;
    this.bridgeSpecs = city.bridges;
    const { lots, byTile } = subdivide(city.blocks, this.terrain, this.rng.fork());
    this.lots = lots;
    this._lotsByTile = byTile;
    /**
     * Resolved points of interest — see `netgen.applyPoiPads`. Each is
     * `{ id, name, kind, x, z, y, yaw, roadDist, edge, node, ok }` and stands on
     * ground that has been levelled for it. `game` reads these through
     * `poi(id)` / `poiSpot(x, z)`.
     */
    this.pois = city.pois ?? [];
    this._poiById = new Map(this.pois.map((p) => [p.id, p]));
    const tPlan = performance.now();

    /* ---- 3. renderers -------------------------------------------------- */
    this.terrainMesh = new TerrainMesh({
      terrain: this.terrain,
      materials,
      palette: PALETTE,
      root: this.root,
      rng: this.rng.fork(),
    });
    this.roadMesh = new RoadMeshBuilder({
      graph: this.roads,
      terrain: this.terrain,
      materials,
      palette: PALETTE,
      rng: this.rng.fork(),
    });
    this.water = new Water({ ctx, root: this.root, rng: this.rng.fork(), terrain: this.terrain });

    /* ---- 4. streaming state -------------------------------------------- */
    this.queue = new JobQueue();
    this._tiles = new RingTracker(TILE);
    this._sectors = new RingTracker(SECTOR);
    this._far = new Map(); // sectorKey -> mesh (low-detail road ribbon)
    this._colSectors = new Map(); // sectorKey -> { sx, sz, job, colMesh, handle }
    this._colJobs = 0;
    this._colX = NaN;
    this._colZ = NaN;
    this._diff = { add: [], drop: [] };
    this._ready = false;
    this._idleFrames = 0;
    this._physDirty = false;
    this._physFrame = -999;
    this._sectorJobs = 0;
    this._stats = { sectors: 0, tiles: 0, tris: 0, buildMs: 0 };
    this._now = typeof performance !== 'undefined' ? () => performance.now() : () => Date.now();
    this._camPos = new THREE.Vector3();
    this._v = new THREE.Vector3();
    this._box = new THREE.Box3();

    /* ---- 5. bridges: landmarks, never streamed ------------------------- */
    const br = buildBridges(this.bridgeSpecs, materials, PALETTE, this.root);
    this.bridgeGroup = br.group;
    if (br.colMesh && physics) {
      this.root.add(br.colMesh);
      this._bridgeHandle = physics.addStatic(br.colMesh, 'metal');
      this._physDirty = true;
    }

    /* ---- 5b. the two airfields: paving + collision, never streamed ------ */
    // The graded bench went into the terrain inside `generateCity`
    // (`netgen` step 0b); this is the emitted half — runway, taxiways, apron,
    // markings, edge lamps, and an always-resident 'asphalt' collision sheet
    // so a wheel or gear ray finds pavement wherever the aircraft is. See
    // `src/world/airfield.js`; gated by `src/world/airsweep.mjs`.
    this._airfields = [];
    this._airfieldHandles = [];
    for (const af of AIRFIELDS) {
      const built = buildAirfieldPaving(af, {
        terrain: this.terrain,
        roads: this.roads,
        mat: (k) => this.roadMesh._mat(k),
      });
      if (!built) continue;
      this.root.add(built.group);
      if (built.colMesh && physics) {
        this.root.add(built.colMesh);
        const h = physics.addStatic(built.colMesh, 'asphalt');
        if (h >= 0) this._airfieldHandles.push(h);
        this._physDirty = true;
      }
      this._airfields.push(built);
    }

    /* ---- 5c. Ridgeline AFB: paving + collision, never streamed ---------- */
    // The military airbase's ground half, same contract as 5b — bench went in
    // at `netgen` step 0c, this is the emitted paving and its 'asphalt'
    // collision sheet. The structures (hangars, tower, radar, fence) are
    // `buildings`' half, off the layout PUBLISHED here on `world.airbase`.
    // Gated by `src/world/basesweep.mjs`; `?noairbase=1` is the hatch.
    {
      const built = buildAirbasePaving(AIRBASE, {
        terrain: this.terrain,
        roads: this.roads,
        mat: (k) => this.roadMesh._mat(k),
      });
      if (built) {
        this.root.add(built.group);
        if (built.colMesh && physics) {
          this.root.add(built.colMesh);
          const h = physics.addStatic(built.colMesh, 'asphalt');
          if (h >= 0) this._airfieldHandles.push(h);
          this._physDirty = true;
        }
        this._airfields.push(built);
      }
    }

    /* ---- 6. the far road network, so the city reads to the horizon ----- */
    this._queueFarSectors();

    /* ---- 7. spawns, collision, lights ---------------------------------- */
    this._makeSpawns();
    this._initTerrainCollider();
    this._initGroundNet();
    this._initCorridorFloor();
    this._addBallast();

    // `bounds` is the LOCAL gameplay volume around the spawn, not the city:
    // `ai` builds a dense 0.8 m nav grid from it and a 3 km box would be 14 M
    // cells. The full extent is `cityBounds`.
    const sp = this.spawnPoints[0].position;
    this.bounds = new THREE.Box3(
      new THREE.Vector3(sp.x - 64, sp.y - 12, sp.z - 64),
      new THREE.Vector3(sp.x + 64, sp.y + 34, sp.z + 64)
    );
    this.cityBounds = new THREE.Box3(
      new THREE.Vector3(-CITY_SIZE / 2, -20, -CITY_SIZE / 2),
      new THREE.Vector3(CITY_SIZE / 2, 320, CITY_SIZE / 2)
    );
    /** Kept for `ui/minimap` and `render._updateRooms`, which probe it. */
    this.buildings = [];
    /**
     * THE PUBLISHED LANDMARK TABLE. `world` is the authority on where
     * everything is, so this — not a copy in another subsystem — is where a
     * landmark's coordinate comes from. Each entry carries the ground it
     * occupies as `site` (see `plan.js`), and `netgen.reserveLandmarks` keeps
     * every drivable corridor `landmarkClearance` metres outside it.
     */
    this.landmarks = LANDMARKS;
    /**
     * The incline's funicular track descriptor, solved once off the RAW
     * terrain (same field `orientLandmarkSites` scored the bearing against)
     * and published as `landmarks[].funicular.track`. `buildings` emits the
     * trestle and rails from it; the `funicular` subsystem rides the cars on
     * it. One authority — see `src/world/incline.js`.
     */
    publishInclineTracks(this.landmarks, (ix, iz) => this.terrain.heightAt(ix, iz));
    this.landmarkClearance = LANDMARK_RESERVE;
    this.districts = DISTRICTS;
    this.rivers = RIVERS;
    this.bridges = BRIDGES;
    this.airfields = AIRFIELDS;
    /**
     * THE PUBLISHED AIRBASE — Ridgeline AFB. `finaliseAirbase` attaches the
     * world-space perimeter polygon, gates (drivable gaps), runway start +
     * heading for jet takeoffs, tagged apron parking slots (jet/tank/jeep),
     * guard patrol waypoints and `insidePerimeter(x, z)`. When the
     * `?noairbase=1` hatch is up, `airbase.pad` is null and every published
     * field above is null — consumers must check `pad` first, exactly as
     * they do for `world.airfields[i]`.
     */
    this.airbase = finaliseAirbase(AIRBASE) ?? AIRBASE;
    this.docks = DOCKS;
    this.safehouses = SAFEHOUSES;

    // Build the first ring synchronously enough that frame 1 is not empty: the
    // queue is pumped from update(), but the clipmap needs a centre now.
    this.terrainMesh.update(sp.x, sp.z, (fn, p) => this.queue.push(fn, p));

    const s = this.roads.stats();
    console.info(
      `[world] Steel City ${CITY_SIZE} m — terrain bake ${(tBake - t0).toFixed(0)}ms, ` +
        `plan ${(tPlan - tBake).toFixed(0)}ms · ${s.nodes} nodes / ${s.edges} edges / ` +
        `${s.km.toFixed(1)} km of road · ${this.blocks.length} blocks · ${lots.length} lots · ` +
        `${this.bridgeSpecs.length} bridges (${(br.tris / 1000).toFixed(0)}k tris) · ` +
        `dedup cut ${(this.roads.dedup?.cutKm ?? 0).toFixed(1)} km from ` +
        `${this.roads.dedup?.cut ?? 0} doubled corridors · ` +
        (this.roads.landmarkReserve?.on
          ? `landmark reserve cut ${(this.roads.landmarkReserve.cutKm ?? 0).toFixed(2)} km from ` +
            `${this.roads.landmarkReserve.cut} corridors (${this.roads.landmarkReserve.dropped} stubs dropped)`
          : 'landmark reserve OFF')
    );
  }

  /* ==================================================================== */
  /* streaming                                                            */
  /* ==================================================================== */

  update(dt, ctx) {
    const cam = ctx.camera;
    cam.getWorldPosition(this._camPos);
    const cx = this._camPos.x;
    const cz = this._camPos.z;

    this.water.update(dt);
    this.terrainMesh.update(cx, cz, this._schedule);

    const q = ctx.config.q;
    this._streamTiles(cx, cz, q.streamRadius);
    this._streamSectors(cx, cz, Math.min(q.streamRadius, SECTOR_RADIUS_MAX));
    this._streamRoadCollision(cx, cz);
    this._updateTerrainCollider(cx, cz);

    const t0 = this._now();
    // Capture mode budgets the queue in JOBS, not milliseconds — see
    // DET_JOBS_PER_FRAME. Play keeps its wall-clock budget untouched, because a
    // frame that overruns is a stutter.
    this.queue.run(q.tileBuildBudgetMs ?? 5, this._now, this._jobBudget(ctx));
    this._stats.buildMs = this._now() - t0;

    if (this._physDirty && ctx.time.frame - this._physFrame > 12) {
      this._physFrame = ctx.time.frame;
      this._physDirty = false;
      this.physics?.rebuildStatic?.();
    }

    // Idle bookkeeping for `streamingIdle()` / the capture harness.
    if (this.queue.pending === 0 && this._sectorJobs === 0 && this._colJobs === 0 && this.terrainMesh.ready) {
      this._idleFrames++;
      if (!this._ready) {
        this._ready = true;
        ctx.events.emit('world:ready', {});
      }
    } else {
      this._idleFrames = 0;
    }
  }

  lateUpdate(dt, ctx) {
    this._stabiliseLightCount(ctx);
  }

  /**
   * Jobs allowed off the queue this frame, or 0 to use the wall clock.
   *
   * 0 in play — ALWAYS, and the `deterministic` test is the only thing that can
   * change that, exactly as `engine.js` gates `FIXED_STEP_BUDGET_MS`.
   */
  _jobBudget(ctx) {
    if (ctx.config.deterministic !== true || WALL_CLOCK_BUILD) return 0;
    return DET_JOBS_OVERRIDE > 0 ? DET_JOBS_OVERRIDE : DET_JOBS_PER_FRAME;
  }

  /** ARCHITECTURE.md: amortised build job, respects the frame budget. */
  schedule(fn, priority = 4) {
    this.queue.push(fn, priority);
    return this;
  }

  _schedule = (fn, priority) => this.queue.push(fn, priority);

  /**
   * True only when every tile and sector inside the stream radius is finished
   * AND the queue — which is also where `buildings` and `props` put their work —
   * has been empty for a couple of frames. `tools/capture.mjs` gates the
   * shutter on this so a shot is never taken of a half-built city.
   */
  streamingIdle() {
    return (
      this._ready &&
      this.queue.pending === 0 &&
      this._sectorJobs === 0 &&
      this._colJobs === 0 &&
      this.terrainMesh.ready &&
      this._idleFrames >= 3
    );
  }

  _streamTiles(x, z, radius) {
    const d = this._tiles.diff(x, z, radius, this._diff);
    if (!d) return;
    const events = this.ctx.events;
    for (const rec of d.drop) {
      this._tiles.live.delete(this._tiles.key(rec.tx, rec.tz));
      events.emit('world:tile:unload', { tx: rec.tx, tz: rec.tz });
    }
    for (const [tx, tz, d2] of d.add) {
      const rec = { tx, tz };
      this._tiles.live.set(this._tiles.key(tx, tz), rec);
      const lots = this.lotsInTile(tx, tz);
      const bounds = new THREE.Box3(
        new THREE.Vector3(tx * TILE, -40, tz * TILE),
        new THREE.Vector3((tx + 1) * TILE, 400, (tz + 1) * TILE)
      );
      const pri = d2 < TILE * TILE * 4 ? 1 : d2 < TILE * TILE * 25 ? 3 : 5;
      this.queue.push(() => events.emit('world:tile:load', { tx, tz, lots, bounds }), pri);
    }
    this._stats.tiles = this._tiles.live.size;
  }

  _streamSectors(x, z, radius) {
    const d = this._sectors.diff(x, z, radius, this._diff);
    if (d) {
      for (const rec of d.drop) {
        this._sectors.live.delete(this._sectors.key(rec.sx, rec.sz));
        this._dropSector(rec);
      }
      for (const [sx, sz, d2] of d.add) {
        const rec = { sx, sz, group: null, job: null };
        this._sectors.live.set(this._sectors.key(sx, sz), rec);
        if (!this.roadMesh.hasWork(sx, sz)) continue;
        this._sectorJobs++;
        rec.job = this.roadMesh.begin(sx, sz);
        const pri = d2 < SECTOR * SECTOR ? 0 : d2 < SECTOR * SECTOR * 6 ? 2 : 4;
        const pump = () => {
          // `_dropSector` nulls the job and does the decrement itself, so a
          // stale pump left in the queue must do nothing at all.
          if (rec.job === null) return;
          if (!this._sectors.live.has(this._sectors.key(sx, sz))) {
            rec.job = null;
            this._sectorJobs--;
            return;
          }
          if (!rec.job.step(8)) {
            this.queue.push(pump, pri);
            return;
          }
          const out = rec.job.finish();
          rec.job = null;
          rec.group = out.group;
          this.root.add(out.group);
          this._stats.tris += out.tris;
          const far = this._far.get(`${sx},${sz}`);
          if (far) far.visible = false;
          this._sectorJobs--;
        };
        this.queue.push(pump, pri);
      }
      this._stats.sectors = this._sectors.live.size;
    }
  }

  /**
   * Road collision, streamed independently of what is drawn. See `COL_RADIUS`.
   *
   * Distance is measured to the sector's BOUNDS, not its centre, so "every
   * carriageway within `COL_RADIUS` of the camera has a collider under it" is a
   * guarantee rather than an average.
   */
  _streamRoadCollision(x, z) {
    if (!this.physics) return;
    // Re-evaluating every frame would be wasted work; a third of a sector of
    // movement cannot change the answer, and the terrain patch (which is the
    // one thing that must never lag a teleport) has its own jump path.
    if (Math.abs(x - this._colX) < 24 && Math.abs(z - this._colZ) < 24) return;
    this._colX = x;
    this._colZ = z;

    const S = SECTOR;
    const keep = COL_RADIUS + COL_MARGIN;
    const drop = keep + COL_DROP;
    const dist = (sx, sz) => {
      const dx = Math.max(sx * S - x, 0, x - (sx + 1) * S);
      const dz = Math.max(sz * S - z, 0, z - (sz + 1) * S);
      return Math.hypot(dx, dz);
    };

    for (const [k, rec] of this._colSectors) {
      if (dist(rec.sx, rec.sz) <= drop) continue;
      this._dropColSector(rec);
      this._colSectors.delete(k);
    }

    const r = Math.ceil(keep / S) + 1;
    const csx = Math.floor(x / S);
    const csz = Math.floor(z / S);
    for (let dz = -r; dz <= r; dz++) {
      for (let dx = -r; dx <= r; dx++) {
        const sx = csx + dx;
        const sz = csz + dz;
        const d = dist(sx, sz);
        if (d > keep) continue;
        const k = `${sx},${sz}`;
        if (this._colSectors.has(k)) continue;
        if (!this.roadMesh.hasWork(sx, sz)) {
          this._colSectors.set(k, { sx, sz, job: null, colMesh: null, handle: -1 });
          continue;
        }
        const rec = { sx, sz, job: this.roadMesh.begin(sx, sz, 'collision'), colMesh: null, handle: -1 };
        this._colSectors.set(k, rec);
        this._colJobs++;
        // The sector the camera stands in is the floor the player's car is on;
        // everything else can wait behind the geometry the frame is drawing.
        const pri = d <= 0 ? 0 : d < S ? 2 : 4;
        const pump = () => {
          if (rec.job === null) return;
          if (this._colSectors.get(k) !== rec) {
            rec.job = null;
            this._colJobs--;
            return;
          }
          if (!rec.job.step(24)) {
            this.queue.push(pump, pri);
            return;
          }
          const out = rec.job.finish();
          rec.job = null;
          this._colJobs--;
          if (!out.colMesh) return;
          rec.colMesh = out.colMesh;
          this.root.add(out.colMesh);
          rec.handle = this.physics.addStatic(out.colMesh, 'asphalt');
          this._physDirty = true;
        };
        this.queue.push(pump, pri);
      }
    }
  }

  _dropColSector(rec) {
    if (rec.job) {
      rec.job = null;
      this._colJobs = Math.max(0, this._colJobs - 1);
    }
    if (rec.handle >= 0) {
      this.physics?.removeStatic(rec.handle);
      rec.handle = -1;
      this._physDirty = true;
    }
    rec.colMesh?.geometry?.dispose();
    rec.colMesh?.parent?.remove(rec.colMesh);
    rec.colMesh = null;
  }

  _dropSector(rec) {
    if (rec.job) {
      rec.job = null;
      this._sectorJobs = Math.max(0, this._sectorJobs - 1);
    }
    if (rec.group) {
      for (const m of rec.group.children) m.geometry?.dispose();
      rec.group.parent?.remove(rec.group);
      rec.group = null;
    }
    const far = this._far.get(`${rec.sx},${rec.sz}`);
    if (far) far.visible = true;
  }

  /** One flat-ribbon mesh per sector for the whole map: the horizon road net. */
  _queueFarSectors() {
    const n = Math.ceil(CITY_SIZE / SECTOR / 2) + 1;
    for (let sz = -n; sz <= n; sz++) {
      for (let sx = -n; sx <= n; sx++) {
        this.queue.push(() => {
          const mesh = this.roadMesh.buildFar(sx, sz);
          if (!mesh) return;
          this._far.set(`${sx},${sz}`, mesh);
          if (this._sectors.has(sx, sz)) {
            const rec = this._sectors.live.get(this._sectors.key(sx, sz));
            if (rec?.group) mesh.visible = false;
          }
          this.root.add(mesh);
        }, 6);
      }
    }
  }

  /* ==================================================================== */
  /* collision                                                            */
  /* ==================================================================== */

  _initTerrainCollider() {
    const n = Math.round((TCOL_HALF * 2) / TCOL_STEP) + 1;
    this._tcN = n;
    const pos = new Float32Array(n * n * 3);
    const idx = new Uint32Array((n - 1) * (n - 1) * 6);
    let k = 0;
    for (let j = 0; j < n - 1; j++) {
      for (let i = 0; i < n - 1; i++) {
        const a = j * n + i;
        idx[k++] = a;
        idx[k++] = a + n;
        idx[k++] = a + n + 1;
        idx[k++] = a;
        idx[k++] = a + n + 1;
        idx[k++] = a + 1;
      }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    g.setIndex(new THREE.BufferAttribute(idx, 1));
    this._tcMesh = new THREE.Mesh(g, INVISIBLE);
    this._tcMesh.name = 'terrain_col';
    this._tcMesh.visible = false;
    this._tcMesh.matrixAutoUpdate = false;
    this._tcMesh.userData.surface = 'dirt';
    this.root.add(this._tcMesh);
    this._tcHandle = -1;
    this._tcx = NaN;
    this._tcz = NaN;
  }

  /**
   * Build the always-resident CLIP safety net. See `NET_HALF` above for why it
   * exists, why it is on CLIP and why it is deliberately sunk.
   */
  _initGroundNet() {
    const phys = this.physics;
    if (!phys) return;
    const CLIP = phys.LAYER?.CLIP;
    if (!CLIP) {
      // Better a missing net than a net on the wrong layer paving over the
      // analytic surface every bullet ray in the game depends on.
      console.warn('[world] physics exposes no LAYER.CLIP — ground safety net not built');
      return;
    }
    const t0 = this._now();
    const n = Math.round((NET_HALF * 2) / NET_STEP) + 1;
    const pos = new Float32Array(n * n * 3);
    const idx = new Uint32Array((n - 1) * (n - 1) * 6);
    let k = 0;
    for (let j = 0; j < n - 1; j++) {
      for (let i = 0; i < n - 1; i++) {
        const a = j * n + i;
        idx[k++] = a;
        idx[k++] = a + n;
        idx[k++] = a + n + 1;
        idx[k++] = a;
        idx[k++] = a + n + 1;
        idx[k++] = a + 1;
      }
    }
    const t = this.terrain;
    const h = NET_STEP * 0.5;
    for (let j = 0; j < n; j++) {
      const z = -NET_HALF + j * NET_STEP;
      for (let i = 0; i < n; i++) {
        const x = -NET_HALF + i * NET_STEP;
        // Minimum over the four cells this vertex corners: every value the
        // sheet interpolates to inside a cell is then at or below the ground
        // there, so the net can never lift an actor off real geometry.
        const here = t.heightAt(x, z);
        let lo = here;
        for (let b = -1; b <= 1; b++) {
          for (let a = -1; a <= 1; a++) {
            if (a === 0 && b === 0) continue;
            const v = t.heightAt(x + a * h, z + b * h);
            if (v < lo) lo = v;
          }
        }
        const p = (j * n + i) * 3;
        pos[p] = x;
        pos[p + 1] = Math.max(lo - 0.8, here - NET_MAX_DROP);
        pos[p + 2] = z;
      }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    g.setIndex(new THREE.BufferAttribute(idx, 1));
    g.computeBoundingSphere();
    const mesh = new THREE.Mesh(g, INVISIBLE);
    mesh.name = 'ground_net';
    mesh.visible = false;
    mesh.matrixAutoUpdate = false;
    mesh.userData.surface = 'dirt';
    this.root.add(mesh);
    this._netMesh = mesh;
    this._netHandle = phys.addStatic(mesh, 'dirt', { mask: CLIP });
    this._physDirty = true;
    console.info(
      `[world] ground safety net ${n}x${n} @ ${NET_STEP} m on LAYER.CLIP — ` +
        `${((n - 1) * (n - 1) * 2 / 1000).toFixed(0)}k tris, ${(this._now() - t0).toFixed(0)}ms`
    );
  }

  /**
   * Build the always-resident CLIP corridor floor. See `FLOOR_SINK` above for
   * what it is for, why it is on CLIP and why it is deliberately ABOVE the sunk
   * terrain when the safety net is deliberately below it.
   *
   * Geometry: four columns per row — back of footway, kerb line, kerb line,
   * back of footway — because the outer pair has to be free to follow ground
   * that has fallen away past the corridor while the inner pair stays pinned to
   * the road plane. Nodes get a fan, since a junction corner belongs to no
   * edge's strip and is exactly where a player walking round a block meets one.
   */
  _initCorridorFloor() {
    const phys = this.physics;
    const CLIP = phys?.LAYER?.CLIP;
    if (!CLIP || !this.roads || noGapFix()) return;
    const t0 = this._now();
    const terrain = this.terrain;
    const pos = [];
    const idx = [];
    const vert = (x, y, z) => (pos.push(x, y, z), pos.length / 3 - 1);
    const quad = (a, b, c, d) => idx.push(a, b, c, a, c, d);

    /** Outer column: the road plane, but never more than FLOOR_LIFT off ground. */
    const outerY = (x, z, roadY) => Math.min(roadY - FLOOR_SINK, terrain.heightAt(x, z) + FLOOR_LIFT);

    let strips = 0;
    for (const e of this.roads.edges) {
      // Rail has no carriageway and never had a collider. A bridge deck is a
      // solid structure with its own — and a sheet at deck level reaching out
      // to a footway width the deck does not have is a ledge over the river.
      if (e.rail || e.bridge) continue;
      const na = this.roads.nodes[e.a];
      const nb = this.roads.nodes[e.b];
      const L = Math.hypot(nb.x - na.x, nb.z - na.z);
      if (L < 0.5) continue;
      const k = ROAD_KIND[e.kind] ?? ROAD_KIND.street;
      const hw = roadHalfWidth(e.kind, e.lanes);
      const fw = hw + 0.33 + k.sidewalk;
      const dx = (nb.x - na.x) / L;
      const dz = (nb.z - na.z) / L;
      const rx = -dz;
      const rz = dx;
      const rows = Math.max(1, Math.round(L / FLOOR_ROW));
      let prev = null;
      for (let r = 0; r <= rows; r++) {
        const t = r / rows;
        const x = na.x + dx * L * t;
        const z = na.z + dz * L * t;
        // The carriageway plane is exactly linear between the two node heights,
        // which is the same interpolation `roadmesh` sweeps its cross section
        // along — so the inner pair is parallel to the real road, sunk.
        const roadY = na.y + (nb.y - na.y) * t;
        const y = roadY - FLOOR_SINK;
        const ox = x - rx * fw;
        const oz = z - rz * fw;
        const px = x + rx * fw;
        const pz = z + rz * fw;
        const cur = [
          vert(ox, outerY(ox, oz, roadY), oz),
          vert(x - rx * hw, y, z - rz * hw),
          vert(x + rx * hw, y, z + rz * hw),
          vert(px, outerY(px, pz, roadY), pz),
        ];
        if (prev) for (let c = 0; c < 3; c++) quad(prev[c], cur[c], cur[c + 1], prev[c + 1]);
        prev = cur;
      }
      strips++;
    }

    // Junction corners. Radius is the widest corridor meeting here, so the disc
    // reaches the back of every arm's footway and the arms' strips overlap it.
    let fans = 0;
    for (const n of this.roads.nodes) {
      if (!n.links.length) continue;
      let r = 0;
      let solid = false;
      for (const eid of n.links) {
        const e = this.roads.edges[eid];
        if (!e || e.rail || e.bridge) continue;
        const k = ROAD_KIND[e.kind] ?? ROAD_KIND.street;
        r = Math.max(r, roadHalfWidth(e.kind, e.lanes) + 0.33 + k.sidewalk);
        solid = true;
      }
      if (!solid || r <= 0) continue;
      const y = n.y - FLOOR_SINK;
      const c = vert(n.x, y, n.z);
      const ring = [];
      for (let i = 0; i < FLOOR_FAN; i++) {
        const a = (i / FLOOR_FAN) * Math.PI * 2;
        const x = n.x + Math.cos(a) * r;
        const z = n.z + Math.sin(a) * r;
        ring.push(vert(x, outerY(x, z, n.y), z));
      }
      for (let i = 0; i < FLOOR_FAN; i++) idx.push(c, ring[i], ring[(i + 1) % FLOOR_FAN]);
      fans++;
    }
    if (!idx.length) return;

    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setIndex(pos.length / 3 > 65535 ? new THREE.Uint32BufferAttribute(idx, 1) : new THREE.Uint16BufferAttribute(idx, 1));
    g.computeBoundingSphere();
    const mesh = new THREE.Mesh(g, INVISIBLE);
    mesh.name = 'corridor_floor';
    mesh.visible = false;
    mesh.matrixAutoUpdate = false;
    mesh.userData.surface = 'concrete';
    this.root.add(mesh);
    this._floorMesh = mesh;
    this._floorHandle = phys.addStatic(mesh, 'concrete', { mask: CLIP });
    this._physDirty = true;
    console.info(
      `[world] corridor floor on LAYER.CLIP — ${strips} strips + ${fans} junction fans, ` +
        `${(idx.length / 3000).toFixed(1)}k tris, ${(this._now() - t0).toFixed(0)}ms`
    );
  }

  /**
   * The terrain collision patch that follows the camera.
   *
   * IT MUST NOT BE AMORTISED WHEN THE CAMERA TELEPORTS. The patch is 192 m
   * either side of wherever it was last built, and `game` spawns the player
   * hundreds of metres from where the camera starts — so for the handful of
   * frames the queued rebuild took, there was NO GROUND ANYWHERE UNDER HIM.
   * He fell out of the world before the job ran, which is the intermittent
   * "spawned and dropped through" that `REVIEW.md` has open. Streaming a
   * kilometre of road can wait a frame; the floor cannot.
   */
  _updateTerrainCollider(x, z) {
    const snap = 48;
    const cx = Math.round(x / snap) * snap;
    const cz = Math.round(z / snap) * snap;
    if (cx === this._tcx && cz === this._tcz) return;
    const jumped =
      !Number.isFinite(this._tcx) ||
      Math.abs(cx - this._tcx) > TCOL_HALF * 0.5 ||
      Math.abs(cz - this._tcz) > TCOL_HALF * 0.5;
    this._tcx = cx;
    this._tcz = cz;
    const build = () => {
      const n = this._tcN;
      const pos = this._tcMesh.geometry.getAttribute('position');
      const arr = pos.array;
      const t = this.terrain;
      for (let j = 0; j < n; j++) {
        const zz = cz - TCOL_HALF + j * TCOL_STEP;
        for (let i = 0; i < n; i++) {
          const xx = cx - TCOL_HALF + i * TCOL_STEP;
          const k = (j * n + i) * 3;
          arr[k] = xx;
          let yy = t.heightAt(xx, zz) - 0.06;
          /**
           * On airfield pavement the patch rides just under the DECK, not
           * under the bench. An aircraft's contact rays cast from the contact
           * point itself; a competing collider 0.12 m below the deck catches
           * the ray of a gear leg pressed under the pavement and the machine
           * comes to rest wheels-deep in the runway (measured — see
           * `airfieldDeckAt`). 2 cm below the deck keeps this sheet the
           * loser against the real paving everywhere a query starts above it.
           */
          const deck = airfieldDeckAt(xx, zz) ?? airbaseDeckAt(xx, zz);
          if (deck !== null && yy < deck - 0.02) yy = deck - 0.02;
          arr[k + 1] = yy;
          arr[k + 2] = zz;
        }
      }
      pos.needsUpdate = true;
      this._tcMesh.geometry.computeBoundingSphere();
      if (this.physics) {
        if (this._tcHandle >= 0) this.physics.removeStatic(this._tcHandle);
        this._tcHandle = this.physics.addStatic(this._tcMesh, 'dirt');
        this._physDirty = true;
      }
    };
    if (jumped) {
      build();
      // And publish it THIS frame, not in twelve: `_physDirty` is normally
      // rate-limited, which is fine for a road tile and not fine for the floor.
      this._physDirty = false;
      this._physFrame = this.ctx.time.frame;
      this.physics?.rebuildStatic?.();
    } else {
      this.queue.push(build, 1);
    }
  }

  /* ==================================================================== */
  /* spawns                                                               */
  /* ==================================================================== */

  _makeSpawns() {
    const rng = this.rng.fork();
    // Downtown, on a pavement, looking down the avenue.
    const anchor = this.roads.nearestNode(-232, 64, 500) ?? this.roads.nodes[0];
    this.spawnPoints = [];
    const seen = new Set();
    const push = (x, z, yaw, tag) => {
      const y = Math.max(this.heightAt(x, z), WATER_Y + 0.5);
      this.spawnPoints.push({ position: new THREE.Vector3(x, y + 0.05, z), yaw, tag });
    };
    // Spread the first few along the anchor's own edges so `ai`'s nav grid (a
    // 128 m box around spawn 0) still contains all of them.
    push(anchor.x, anchor.z, 0, 'downtown');
    for (const eid of anchor.links) {
      if (this.spawnPoints.length >= 5) break;
      const e = this.roads.edges[eid];
      if (seen.has(e.corridor)) continue;
      seen.add(e.corridor);
      const p = this.roads.laneCenter(e, 0, e.a === anchor.id ? 0.28 : 0.72, this._v ?? new THREE.Vector3());
      push(p.x, p.z, this.roads.laneYaw(e, 0), e.name ?? 'street');
    }
    let guard = 0;
    while (this.spawnPoints.length < 8 && guard++ < 40) {
      const s = this.roads.sampleSpawn(rng, { x: anchor.x, z: anchor.z }, 20, 60);
      if (!s) break;
      push(s.position.x, s.position.z, s.yaw, 'block');
    }
    if (!this.spawnPoints.length) push(0, 0, 0, 'origin');

    // A wider set for mission / traffic / police directors.
    this.citySpawnPoints = [];
    for (const d of DISTRICTS) {
      const n = this.roads.nearestNode(d.x, d.z, 600);
      if (!n) continue;
      this.citySpawnPoints.push({
        position: new THREE.Vector3(n.x, this.heightAt(n.x, n.z) + 0.05, n.z),
        yaw: 0,
        tag: d.name,
        district: d.id,
      });
    }
  }

  spawn(i = 0) {
    const n = this.spawnPoints.length;
    return this.spawnPoints[((i % n) + n) % n];
  }

  /* ==================================================================== */
  /* the world contract                                                   */
  /* ==================================================================== */

  heightAt(x, z) {
    return this.terrain.heightAt(x, z);
  }

  isWater(x, z) {
    return this.terrain.isWater(x, z);
  }

  /**
   * Signed distance in metres from (x, z) to the ground a landmark occupies.
   * Negative inside it. Pass an entry of `world.landmarks`.
   *
   * Anything that places something on the ground — props, parked cars,
   * roadblocks, spawn points — can ask this instead of guessing a radius, and
   * the six sites are not all discs: the Steel Bowl is a 116 x 94 m box and
   * the Duquesne Incline is a 208 m capsule up the bluff.
   */
  landmarkSiteDist(lm, x, z) {
    return siteDist(lm, x, z);
  }

  /** Distance to the nearest landmark site. Negative inside one of them. */
  nearestLandmarkSite(x, z) {
    return nearestSiteDist(x, z);
  }

  /**
   * Height of the water SURFACE at (x, z), or -Infinity on dry land.
   *
   * `player.movement` looks for exactly this and falls back to `WATER_Y`
   * whenever `isWater` is true, which is subtly wrong in two places: the
   * rendered sheet sits at `WATER_Y - 0.012` (and 6 mm per river above that so
   * the three do not z-fight at The Point), and `isWater` needs the ground to
   * be a quarter of a metre under the pool before it says yes — so there is a
   * 25 cm band of shallows where the water is drawn and the swimmer is not in
   * it. Answering from the same test the sheet is built from closes both, and
   * gives `player` a real depth to run buoyancy and the breath meter off.
   */
  waterLevelAt(x, z) {
    const t = this.terrain;
    if (t.waterDist(x, z) > 6) return -Infinity;
    // The sheet is drawn wherever the ground is under the pool; match it.
    return t.heightAt(x, z) < WATER_Y - 0.012 ? WATER_Y : -Infinity;
  }

  /** Metres of water over the ground here; 0 on dry land. Never negative. */
  waterDepthAt(x, z) {
    const lvl = this.waterLevelAt(x, z);
    return Number.isFinite(lvl) ? Math.max(0, lvl - this.terrain.heightAt(x, z)) : 0;
  }

  /**
   * The nearest place a swimmer can get OUT, written into `out`.
   *
   * The rivers are a third of the map and Carson's whole arc is on them, so
   * "you fell in and now you are stuck" is a real failure mode: the Mon runs
   * along the foot of the Mt. Washington bluff, where the bank climbs 104 m in
   * 132 and there is nothing to climb out onto for hundreds of metres. This
   * walks the eight compass bearings out from the point and returns the closest
   * bearing on which the ground breaks the surface with a gradient a character
   * controller can actually walk up.
   *
   * @returns {{x:number,z:number,y:number,dist:number,ok:boolean}}
   */
  shoreExit(x, z, maxDist = 140, out = (this._shore ??= { x: 0, z: 0, y: 0, dist: 0, ok: false })) {
    out.ok = false;
    out.dist = Infinity;
    const t = this.terrain;
    const STEP = 4;
    for (let k = 0; k < 16; k++) {
      const a = (k / 16) * Math.PI * 2;
      const dx = Math.cos(a);
      const dz = Math.sin(a);
      let prev = t.heightAt(x, z);
      for (let d = STEP; d <= maxDist; d += STEP) {
        const px = x + dx * d;
        const pz = z + dz * d;
        const h = t.heightAt(px, pz);
        const grad = (h - prev) / STEP;
        prev = h;
        // A cut bank or a retaining wall is not an exit.
        if (grad > 0.85) break;
        if (h > WATER_Y + 0.35) {
          if (d < out.dist) {
            out.dist = d;
            out.x = px;
            out.z = pz;
            out.y = h;
            out.ok = true;
          }
          break;
        }
      }
    }
    return out;
  }

  /* ---------------------------------------------------------------- POI -- */

  /** A resolved point of interest by id, or null. */
  poi(id) {
    return this._poiById.get(id) ?? null;
  }

  /**
   * The usable spot for a point of interest given only its authored position —
   * levelled ground, off the kerb, with the heading that faces the road.
   * `game`'s POI table and mine share coordinates (`plan.SERVICES`), so an id
   * lookup hits; anything else falls back to the nearest resolved spot within
   * 40 m and finally to a live solve against the road graph.
   */
  poiSpot(x, z, out = (this._poiOut ??= { x: 0, z: 0, y: 0, yaw: 0, roadDist: 0, ok: false })) {
    let best = null;
    let bd = 40 * 40;
    for (let i = 0; i < this.pois.length; i++) {
      const p = this.pois[i];
      const d = (p.x - x) ** 2 + (p.z - z) ** 2;
      if (d < bd) {
        bd = d;
        best = p;
      }
    }
    if (best) {
      out.x = best.x;
      out.z = best.z;
      out.y = best.y;
      out.yaw = best.yaw;
      out.roadDist = best.roadDist;
      out.ok = best.ok;
      return out;
    }
    const hit = this.roads.nearestEdge(x, z, 220);
    out.x = x;
    out.z = z;
    out.y = this.heightAt(x, z);
    out.yaw = 0;
    out.roadDist = hit.edge ? hit.dist : Infinity;
    out.ok = false;
    if (hit.edge) {
      const e = hit.edge;
      const na = this.roads.nodes[e.a];
      const nb = this.roads.nodes[e.b];
      const cx = na.x + (nb.x - na.x) * hit.t;
      const cz = na.z + (nb.z - na.z) * hit.t;
      out.yaw = Math.atan2(cx - x, cz - z);
      out.ok = !this.isWater(x, z) && this.terrain.slopeAt(x, z, 6) < 0.34 && hit.dist < 80;
    }
    return out;
  }

  tileOf(x, z, out) {
    return tileOfXZ(x, z, out ?? { tx: 0, tz: 0 });
  }

  lotsInTile(tx, tz) {
    return this._lotsByTile.get(`${tx},${tz}`) ?? EMPTY;
  }

  /**
   * 'asphalt' | 'sidewalk' | 'dirt' | 'grass' | 'water' | 'sand'
   * Shared vocabulary for footsteps, tyre grip, impact FX and audio.
   *
   * Pass `y` when you have it. Without it, standing on the Sixth Street Bridge
   * reports the surface of the quay eighteen metres below, and standing on that
   * quay reports the bridge — the same 2D ambiguity that was throwing traffic
   * off the carriageway.
   */
  surfaceAt(x, z, y = NaN) {
    const onDeck = Number.isFinite(y) && y > WATER_Y + 4;
    if (!onDeck && this.isWater(x, z)) return 'water';
    const ne = this.roads.nearestEdge(x, z, 70, y);
    if (ne.edge && (!Number.isFinite(y) || Math.abs(ne.dy) < 3)) {
      const e = ne.edge;
      const hw = roadHalfWidth(e.kind, e.lanes);
      if (ne.dist <= hw) return e.rail ? 'dirt' : 'asphalt';
      const k = ROAD_KIND[e.kind] ?? ROAD_KIND.street;
      const sw = e.bridge ? Math.max(k.sidewalk, 1.0) : k.sidewalk;
      if (sw > 0 && ne.dist <= hw + 0.34 + sw) return 'sidewalk';
      // Past the footway of a bridge is the parapet, not a riverbank.
      if (e.bridge && ne.dist <= e.width) return 'sidewalk';
    }
    // Airfield pavement: runway, taxiways, apron. Checked after roads so a
    // street crossing the strip keeps its own surface at the crossing.
    if (airfieldPavedAt(x, z)) return 'asphalt';
    if (airbasePavedAt(x, z)) return 'asphalt';
    if (this.isWater(x, z)) return 'water';
    const wd = this.terrain.waterDist(x, z);
    if (wd < 26) return 'sand';
    if (this.terrain.slopeAt(x, z, 4) > 0.55) return 'dirt';
    const d = this.districtAt(x, z);
    if (d && (d.id === 'steelrow' || d.id === 'southside' || d.id === 'strip')) return 'dirt';
    return 'grass';
  }

  /** `{ id, name, density, wealth, palette }` — nearest district by d/r. */
  districtAt(x, z) {
    let best = null;
    let bestT = Infinity;
    for (const d of DISTRICTS) {
      const t = Math.hypot(x - d.x, z - d.z) / d.r;
      if (t < bestT) {
        bestT = t;
        best = d;
      }
    }
    if (!best) return null;
    this._district ??= {};
    const o = this._district;
    o.id = best.id;
    o.name = best.name;
    o.density = best.density * (bestT > 1 ? Math.max(0.15, 2 - bestT) : 1);
    o.wealth = best.wealth;
    o.palette = best.tint;
    o.tall = best.tall;
    o.x = best.x;
    o.z = best.z;
    o.r = best.r;
    o.t = bestT;
    return o;
  }

  /* ==================================================================== */
  /* compatibility surface (other subsystems already call these)          */
  /* ==================================================================== */

  /**
   * The height of the surface a MAN OR A CAR STANDS ON, analytically.
   *
   * `heightAt` is the terrain, and the terrain is not where you stand. Under
   * every corridor `netgen.rasteriseRoads` deliberately sinks it 0.55 m so it
   * can never come up through the tarmac, and the kerb and footway stand
   * another 15 cm above that — so `heightAt` on a pavement is most of a metre
   * BELOW the pavement. Anything that placed an actor from it put him inside
   * the road: measured as the player spawning 0.86 m under the footway he was
   * meant to be standing on, being pushed through the collider by the character
   * controller, and falling out of the world.
   *
   * This reproduces the profile `roadmesh` actually builds — cambered
   * carriageway, kerb, footway — so it is right BEFORE the sector's collision
   * has streamed in, which is exactly when a spawn happens. Pass `y` if you
   * have it; without it a bridge deck more than a couple of metres off the
   * ground is ignored, which is what you want under a bridge and what you do
   * not want on one.
   */
  walkableHeightAt(x, z, y = NaN) {
    const t = this.terrain.heightAt(x, z);
    // Airfield pavement: the deck is the surface you stand on, `LIFT` above
    // the bench (see `airfieldDeckAt` for the burial this closes). A road
    // corridor crossing the strip still wins below — the crossing is the
    // road's ground, and both sit on the same bench.
    const deck = airfieldDeckAt(x, z) ?? airbaseDeckAt(x, z);
    const ne = this.roads.nearestEdge(x, z, 40, y);
    const e = ne.edge;
    if (!e || e.rail) return deck ?? t;
    const hw = roadHalfWidth(e.kind, e.lanes);
    const k = ROAD_KIND[e.kind] ?? ROAD_KIND.street;
    const sw = e.bridge ? Math.max(k.sidewalk, 1.0) : k.sidewalk;
    if (ne.dist > hw + 0.33 + sw) return deck ?? t;
    // A deck overhead is not the floor. With a `y` the query already rejected
    // it; without one, anything far off the ground is a flyover.
    if (!Number.isFinite(y) && Math.abs(ne.y - t) > 2.5) return deck ?? t;
    if (ne.dist <= hw) {
      const u = ne.dist / hw;
      return ne.y + hw * 0.021 * (1 - u * u);
    }
    return ne.y + 0.152 + Math.min(sw, ne.dist - hw - 0.33) * 0.02;
  }

  /** Analytic floor height. Physics owns the exact answer; this is a hint. */
  groundHeight(x, z, y = NaN) {
    return this.walkableHeightAt(x, z, y);
  }

  /** True where a character can stand outdoors. */
  isOpen(x, z, margin = 0.4) {
    if (this.terrain.isWater(x, z)) return false;
    if (this.terrain.slopeAt(x, z, 3) > 0.62) return false;
    if (margin <= 0) return true;
    // Not inside a building lot.
    const tx = Math.floor(x / TILE);
    const tz = Math.floor(z / TILE);
    const lots = this._lotsByTile.get(`${tx},${tz}`);
    if (lots) {
      for (let i = 0; i < lots.length; i++) {
        const l = lots[i];
        if (l.kind === 'park' || l.kind === 'lot') continue;
        if (Math.abs(l.cx - x) > 60 || Math.abs(l.cz - z) > 60) continue;
        if (pointInPoly(x, z, l.footprint, margin)) return false;
      }
    }
    return true;
  }

  /** The city is authored in world space; the level transform is the identity. */
  levelToWorld(x, y, z, out = new THREE.Vector3()) {
    return out.set(x, y, z);
  }

  worldToLevel(x, y, z, out = new THREE.Vector3()) {
    return out.set(x, y, z);
  }

  overlapCapsule(p0, p1, radius, mask) {
    return this.physics?.overlapCapsule(p0, p1, radius, mask) ?? 0;
  }

  sweepCapsule(...args) {
    return this.physics?.sweepCapsule?.(...args) ?? false;
  }

  queryAabb(...args) {
    return this.physics?.staticWorld?.queryAabb?.(...args) ?? 0;
  }

  get candidates() {
    return this.physics?.staticWorld?.candidates;
  }

  get pos() {
    return this.physics?.staticWorld?.pos;
  }

  get nrm() {
    return this.physics?.staticWorld?.nrm;
  }

  get triCount() {
    return this.physics?.staticWorld?.triCount ?? 0;
  }

  /** Minimap / HUD snapshot. Preallocated — polled every frame by `ui`. */
  getHudState(out = (this._hud ??= {})) {
    const p = this._camPos;
    const d = this.districtAt(p.x, p.z);
    const ne = this.roads.nearestEdge(p.x, p.z, 90, p.y);
    out.x = p.x;
    out.z = p.z;
    out.district = d?.name ?? '';
    out.districtId = d?.id ?? '';
    out.street = ne.edge?.name ?? '';
    out.onBridge = !!ne.edge?.bridge;
    out.bridge = ne.edge?.bridge ? ne.edge.bridgeId : '';
    out.water = this.isWater(p.x, p.z);
    out.tx = Math.floor(p.x / TILE);
    out.tz = Math.floor(p.z / TILE);
    out.citySize = CITY_SIZE;
    return out;
  }

  /** Diagnostics for the dev overlay and `tools/profile.mjs`. */
  get stats() {
    return {
      tiles: this._tiles.live.size,
      sectors: this._sectors.live.size,
      colSectors: this._colSectors.size,
      queued: this.queue.pending,
      jobsRun: this.queue.totalRan,
      buildMs: +this._stats.buildMs.toFixed(2),
      roadTris: this._stats.tris,
      lots: this.lots.length,
      nodes: this.roads.nodes.length,
      edges: this.roads.edges.length,
      idle: this.streamingIdle(),
    };
  }

  /* ==================================================================== */
  /* lights: hold the shader permutation still                            */
  /* ==================================================================== */

  _addBallast() {
    this._ballast = [];
    for (let i = 0; i < LIGHT_SLOTS + 4; i++) {
      const l = new THREE.PointLight(0x000000, 0, 0.01, 2);
      l.name = `world_light_ballast_${i}`;
      l.castShadow = false;
      l.visible = false;
      l.userData.owBallast = true;
      l.position.set(0, -4000, 0);
      this.root.add(l);
      this._ballast.push(l);
    }
    this._pointLights = [];
    this._pointLightsFrame = -1e9;
    this._lightTarget = LIGHT_SLOTS;
    this._lightRanges = new Map();
    this._collectPointLight = (o) => {
      if (o.isPointLight === true && o.userData.owBallast !== true) this._pointLights.push(o);
    };
  }

  /**
   * A point light crossing its cull radius changes `numPointLights`, which is a
   * shader-permutation key: every lit material in the scene recompiles on that
   * frame (measured at +33 to +36 programs, 640-900 ms). Black, zero-intensity
   * ballast lights top the visible count up to a constant, which cannot move a
   * pixel and costs nothing. See ARCHITECTURE.md.
   */
  _stabiliseLightCount(ctx) {
    const list = this._pointLights;
    if (!list) return;
    const render = this._render ?? (this._render = ctx.peek('render'));
    if (ctx.time.frame - this._pointLightsFrame >= 90) {
      this._pointLightsFrame = ctx.time.frame;
      list.length = 0;
      ctx.scene.traverse(this._collectPointLight);
      this._lightRanges.clear();
      for (const e of render?.lights ?? []) {
        if (e.light?.isPointLight === true) this._lightRanges.set(e.light, e.range);
      }
    }
    ctx.camera.getWorldPosition(this._camPos);
    let n = 0;
    for (let i = 0; i < list.length; i++) {
      const l = list[i];
      const range = this._lightRanges.get(l);
      if (range === undefined) {
        if (l.visible === true) n++;
        continue;
      }
      const d = l.position.distanceTo(this._camPos);
      if (1 - THREE.MathUtils.smoothstep(d, range * 0.75, range * 1.15) > 0.002) n++;
    }
    if (n > this._lightTarget) this._lightTarget = n;
    const want = this._lightTarget - n;
    const pool = this._ballast;
    for (let i = 0; i < pool.length; i++) {
      const v = i < want;
      if (pool[i].visible !== v) pool[i].visible = v;
    }
  }

  /* ==================================================================== */
  /* pre-warm                                                             */
  /* ==================================================================== */

  /**
   * Compile every shader permutation the world can produce before the frame
   * loop starts. `renderer.compileAsync` alone reaches only the forward lit
   * variant; the CSM cascades and the MRT prepass draw the same geometry
   * through override materials, and each is a separate program.
   */
  async prewarmMaterials(ctx = this.ctx) {
    const render = ctx.peek?.('render') ?? ctx.get?.('render');
    const renderer = render?.renderer;
    if (!renderer) return { ok: false, reason: 'no renderer' };
    const before = renderer.info.programs?.length ?? 0;
    const t0 = performance.now();

    // Every material the world can emit must exist before we compile, or the
    // first street to stream in compiles mid-frame.
    const probe = new THREE.Group();
    probe.name = 'world_prewarm';
    const geo = new THREE.PlaneGeometry(1, 1);
    geo.rotateX(-Math.PI / 2);
    geo.setAttribute('color', new THREE.Float32BufferAttribute(new Float32Array(geo.getAttribute('position').count * 3).fill(0.5), 3));
    const keys = [
      'road', 'road_pad', 'road_patch', 'walk', 'kerb', 'verge', 'verge_riser',
      'line_white', 'line_dash', 'line_yellow', 'mark_cross', 'mark_stop',
      'drain', 'cover', 'ballast', 'rail_steel', 'sleeper',
      'terrain_grass', 'terrain_dirt', 'terrain_silt', 'terrain_rock',
      'bridge_concrete', 'bridge_steel', 'bridge_rail',
      'runway', 'apron_slab', 'runway_paint', 'runway_lamp',
    ];
    // All THREE mesh forms per surface. `instancing` and `instancingColor` are
    // separate bits of three's program cache key, so a surface warmed only as a
    // plain Mesh still pays a compile the first time it streams in as an
    // InstancedMesh — and vice versa. Measured: 5 of the programs still landing
    // mid-play after the colour-space fix differed from a warm one by nothing
    // but those two bits.
    const insts = [];
    for (const k of keys) {
      const def = PALETTE[k];
      if (!def) continue;
      const mat = this.materials.get(def.name, def.opts);
      const m = new THREE.Mesh(geo, mat);
      m.position.set(0, -3000, 0);
      probe.add(m);
      if (NO_WARM_FIX) continue;
      for (const withColor of [false, true]) {
        const im = new THREE.InstancedMesh(geo, mat, 1);
        im.setMatrixAt(0, new THREE.Matrix4());
        im.instanceMatrix.needsUpdate = true;
        if (withColor) {
          im.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array([1, 1, 1]), 3);
        }
        im.position.set(0, -3000, 0);
        im.frustumCulled = false;
        probe.add(im);
        insts.push(im);
      }
    }
    this.root.add(probe);

    render.patchMaterials?.(this.root);
    this._stabiliseLightCount(ctx);
    const dirVis = this._settleSunCount(ctx, render);

    const scene = ctx.scene;
    const camera = ctx.camera;
    const prevOverride = scene.overrideMaterial;
    try {
      await withFrameTarget(renderer, async () => {
        await this._compile(renderer, scene, camera);
        for (const over of [render.csm?.depthMaterial, render.gbuffer?.material]) {
          if (!over) continue;
          scene.overrideMaterial = over;
          await this._compile(renderer, scene, camera);
        }
      });
    } finally {
      scene.overrideMaterial = prevOverride;
      for (const im of insts) im.dispose(); // instance buffers only; mat/geo are shared
      probe.parent?.remove(probe);
      geo.dispose();
    }
    return {
      ok: true,
      ms: Math.round(performance.now() - t0),
      compiled: (renderer.info.programs?.length ?? 0) - before,
      lightTarget: this._lightTarget,
      dirVis,
    };
  }

  /**
   * Make the VISIBLE DIRECTIONAL count during pre-warm equal the count the
   * frame loop will use. Sibling of `_stabiliseLightCount`, and necessary for
   * exactly the same reason: `numDirLights` is a field of three's program cache
   * key, so a pre-warm that compiles at a different count compiles programs the
   * frame loop then throws away and re-compiles mid-play.
   *
   * MEASURED: 3 visible directional lights during pre-warm, 2 after one real
   * frame. The third is `render`'s `ow-fallback-sun`, which exists so the world
   * is never lit by nothing and hides itself inside `render._syncSun` the moment
   * a brighter sun (sky's) shows up. `_syncSun` runs every frame, but during
   * pre-warm it only runs from `render.prewarmMaterials({shadow:true})` — and
   * that step is disabled (`RENDER_SHADOW_WARM = false` in core/prewarm.js)
   * because it was measured not to be pixel-neutral. So nothing settled the sun
   * before the compile, and every lit program was keyed to a light count that
   * frame 1 immediately invalidated.
   *
   * This is a WORKAROUND for a `render`-owned issue, applied from here. The
   * proper fix is one line in `render`: settle the fallback sun at the end of
   * init, or run `_syncSun` unconditionally from `render.prewarmMaterials`.
   *
   * Calling `render._syncSun()` directly does NOT work here and was measured not
   * to: it decides from `render._dirLights`, a cache only filled by `_collect()`
   * during a frame, so before frame 1 it sees no lights, concludes nobody owns
   * the sun and KEEPS the fallback visible. Hence the independent scene walk
   * below — it applies `_syncSun`'s own rule (brightest non-fallback directional
   * wins if its intensity clears 0.01) to the live scene graph rather than to
   * render's frame cache.
   *
   * Only `visible` is touched, and only in the direction frame 1 would move it
   * anyway, so this is idempotent and pixel-neutral: it moves the takeover
   * earlier, it never invents a state the next frame would not have computed.
   * `activeSun` / `castShadow` are deliberately left to frame 1 — they are not
   * part of the program cache key.
   */
  _settleSunCount(ctx, render) {
    const fallback = render?.sun ?? null;
    if (!NO_WARM_FIX && fallback) {
      let bestI = -1;
      ctx.scene.traverse((o) => {
        if (!o.isDirectionalLight || o === fallback || !o.visible) return;
        if (o.intensity > bestI) bestI = o.intensity;
      });
      // `_syncSun`'s own threshold. Below it the fallback IS the sun and frame 1
      // would keep it on, so hiding it here would create the very mismatch this
      // routine exists to remove.
      if (bestI > 0.01 && fallback.visible) fallback.visible = false;
    }
    let n = 0;
    ctx.scene.traverse((o) => {
      if (o.isDirectionalLight && o.visible) n++;
    });
    return n;
  }

  async _compile(renderer, scene, camera) {
    try {
      await renderer.compileAsync(scene, camera);
    } catch {
      try {
        renderer.compile(scene, camera);
      } catch {
        /* a driver we cannot pre-warm on; boot must still proceed */
      }
    }
  }

  dispose() {
    this.queue.clear();
    for (const rec of this._sectors.live.values()) this._dropSector(rec);
    this._sectors.live.clear();
    for (const rec of this._colSectors.values()) this._dropColSector(rec);
    this._colSectors.clear();
    for (const m of this._far.values()) {
      m.geometry.dispose();
      m.parent?.remove(m);
    }
    this._far.clear();
    this.terrainMesh?.dispose();
    this.water?.dispose();
    for (const m of this.bridgeGroup?.children ?? []) m.geometry?.dispose();
    this.bridgeGroup?.parent?.remove(this.bridgeGroup);
    for (const h of this._airfieldHandles ?? []) this.physics?.removeStatic(h);
    for (const a of this._airfields ?? []) {
      for (const m of a.group?.children ?? []) m.geometry?.dispose();
      a.group?.parent?.remove(a.group);
      a.colMesh?.geometry?.dispose();
      a.colMesh?.parent?.remove(a.colMesh);
    }
    this._airfields = null;
    this._tcMesh?.geometry?.dispose();
    if (this._netHandle >= 0) this.physics?.removeStatic(this._netHandle);
    this._netMesh?.geometry?.dispose();
    if (this._floorHandle >= 0) this.physics?.removeStatic(this._floorHandle);
    this._floorMesh?.geometry?.dispose();
    this.root?.parent?.remove(this.root);
    for (const l of this._ballast ?? []) l.parent?.remove(l);
    this._ballast = null;
    this._pointLights = null;
  }
}

const EMPTY = [];
const INVISIBLE = new THREE.MeshBasicMaterial({ visible: false });

function pointInPoly(x, z, poly, margin) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i];
    const b = poly[j];
    if (a[1] > z !== b[1] > z && x < ((b[0] - a[0]) * (z - a[1])) / (b[1] - a[1]) + a[0]) inside = !inside;
  }
  return inside;
}

export { CITY_SIZE, TILE, SECTOR, DISTRICTS, LANDMARKS, RIVERS, BRIDGES };
