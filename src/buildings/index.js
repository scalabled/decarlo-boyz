import * as THREE from 'three';
import { Rng } from '../core/rng.js';
import { ProtoLibrary, TileBuilder, releaseTile } from './tile.js';
import { planBuilding, buildLot, buildLotLod, blockPalette } from './archetypes.js';
import { districtStyle, SURFACES } from './palette.js';
import { buildLandmark, LANDMARKS, landmarkClaims, adoptLandmarkSites } from './landmarks.js';
import { buildAirfield } from './airfield.js';
import { buildAirbase } from './airbase.js';
import { Skyline } from './skyline.js';
import { syntheticTiles, syntheticLots, SYNTH_TILE } from './debug.js';
import { clipHalfPlane, polyArea, polyCentroid } from './geom.js';

/** `?owNoWarmFix=1` reverts this subsystem's pre-warm to the pre-fix behaviour,
 *  so the two arms can be interleaved in one measurement session. */
const NO_WARM_FIX =
  typeof location !== 'undefined' &&
  new URLSearchParams(location.search).has('owNoWarmFix');

/**
 * DETERMINISTIC BUILD BUDGET — jobs, not milliseconds, in capture mode only.
 *
 * `_drain` below is the LOCAL fallback queue, used only when `world` has no
 * scheduler (the `preview.html` harnesses and the synthetic-lot path). In the
 * game every job goes through `world.schedule`, which has the same fix. Both
 * paths are covered so neither can reintroduce the hazard.
 *
 * A wall-clock budget under `config.deterministic` makes how much city gets
 * built a function of machine load, which is what made two captures of one
 * unchanged shot differ by 28% in draw calls. See the header of
 * `src/world/streaming.js`. `?owWallClockBuild=1` restores the play budget.
 */
const DET_JOBS_PER_FRAME = 32;

/**
 * `?owNoKerbGuard=1` builds the city without the emitted-geometry keep-out, so
 * a capture can be taken from both arms in one session and compared with RMSE.
 * See `_keepOutFor` and `src/buildings/roadsweep.mjs`.
 */
const NO_KERB_GUARD =
  typeof location !== 'undefined' &&
  new URLSearchParams(location.search).get('owNoKerbGuard') === '1';
const WALL_CLOCK_BUILD =
  typeof location !== 'undefined' &&
  new URLSearchParams(location.search).get('owWallClockBuild') === '1';

/**
 * Run `fn` with a render target bound, so every program compiled inside it gets
 * the cache key a REAL frame asks for.
 *
 * three folds `outputColorSpace` and `toneMapping` into the program cache key
 * and reads both off the CURRENTLY BOUND target. `core/prewarm.js` leaves the
 * CANVAS bound when it calls the subsystem hooks, so every program compiled
 * here was the `srgb` + tone-mapped variant — while buildings are drawn into an
 * HDR target, which needs `srgb-linear` + NoToneMapping. The warm program was
 * never asked for and the real one compiled during play.
 *
 * See the long note in `src/world/index.js`; ARCHITECTURE.md documents the trap
 * under "Pre-warm" and `src/fx` already does this for itself.
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
 * BUILDINGS — the built environment of Steel City.
 *
 * Consumes the `Lot` stream from `world` (ARCHITECTURE.md, "The world
 * contract") and produces every building in the city:
 *
 *   archetypes.js  lot -> plan -> massing, both levels of detail
 *   facade.js      the elevation grammar: openings, reveals, ground floors
 *   kit.js         the instanced parts every facade repeats
 *   landmarks.js   the six hand-authored buildings from DESIGN.md
 *   skyline.js     the city-wide silhouette, resident beyond the stream radius
 *   tile.js        per-tile merge + instancing + collision + teardown
 *
 * LOD chain, three levels:
 *   L0  full facade system              built on demand inside `nearRadius`
 *   L1  massing + recessed window bands  built for every streamed tile
 *   L2  the skyline field                built once, covers the whole city
 *
 * Amortisation goes through `world.schedule()` so `world.streamingIdle()` can
 * see it and a capture never photographs a half-built block. If `world` has no
 * scheduler, the local queue below takes over and `pendingJobs()` exposes the
 * same information.
 */

const TAU = Math.PI * 2;

/**
 * How far a facade stands back from the KERB FACE of each road class, in
 * metres. `edge.width` is the carriageway (kerb face to kerb face), so this is
 * the pavement `world` draws outside it plus a hand's width of margin: a
 * building lands at the back of its own pavement, which is where `props` is
 * already putting lamp columns, hydrants and bins.
 */
const STREET_SETBACK = {
  highway: 3.2, // no pavement — a verge, and nothing hard against a 33 m/s lane
  arterial: 3.9,
  street: 3.2,
  /**
   * An alley used to get 0.7 m, which is a kerb and nothing else, and it is why
   * 111 of the 528 impassable directions `roadsweep` first measured were
   * alleys. `buildLot` hangs a plinth 0.34 m proud of the wall, a kerb course
   * 0.34 m proud of that, stoops, door surrounds and shopfront bulkheads — none
   * of which the lot polygon knows about — so a setback that only just clears
   * the carriageway clears nothing once the building is actually built.
   * 1.6 m still reads as a service alley and leaves the dressing somewhere to
   * go. See `roadsweep.mjs`.
   */
  alley: 1.6,
};

/** What the setbacks were before `roadsweep.mjs`. Used only by `legacyClip`. */
const LEGACY_SETBACK = { highway: 3.2, arterial: 3.9, street: 3.2, alley: 0.7 };

/**
 * How close to the carriageway EMITTED geometry may stand, past the kerb face.
 *
 * The setbacks above apply to the lot POLYGON. This applies to the triangles,
 * and it is the backstop for everything the polygon cannot see: the +/-0.011 rad
 * plan yaw, the plinth courses, and every piece `dressIndustrial`, `dressRoof`
 * and the landmark builders place relative to a bounding BOX rather than the
 * footprint itself — which, on a city whose twelve district grids run at twelve
 * different angles, is routinely metres outside the building.
 */
const KERB_MARGIN = 0.30;
/**
 * The vertical band a vehicle occupies over the deck it is standing on.
 * `roadsweep.mjs` asserts against 0.15 .. 1.6 m; the guard uses the wider
 * -0.05 .. 1.9 m so it is strictly stronger than the thing policing it.
 */
const GUARD_UNDER = 0.05;
const GUARD_OVER = 1.9;

/**
 * Half the ground a carriageway occupies.
 *
 * `edge.width` is the authored kerb-to-kerb figure and `lanes * laneWidth` is
 * what `traffic` actually lays out on it. They agree on almost every edge, and
 * on the ones where they do not the wider of the two is the one a driver uses.
 */
function carriagewayHalf(e) {
  return Math.max(e.width ?? 8, (e.lanes ?? 2) * (e.laneWidth ?? 3.5)) * 0.5;
}

/**
 * How far each landmark's geometry can reach from its authored centre, for
 * gathering the roads its keep-out has to respect. Generous on purpose — the
 * cost of over-reaching is a few extra edges in a list, and the cost of
 * under-reaching is a carriageway nobody checked.
 */
const LM_REACH = {
  lm_tower: 90,
  lm_stadium: 190,
  lm_mill: 150,
  lm_incline: 240,
  lm_point: 110,
  lm_market: 130,
};

/**
 * Does a piece spanning `[yMin, yMax]` occupy the volume a vehicle needs, over
 * the stretch of deck it lies alongside?
 *
 * The deck height is taken at BOTH ends of the overlap and the band opened to
 * the wider of the two. A single midpoint sample is not good enough and the
 * error is not academic: a stadium seating wedge twenty metres long, over a
 * street climbing through the bowl, sat 0.1 m outside a midpoint band and 0.4 m
 * inside the band at the station that was actually blocked. Thirteen impassable
 * directions survived the first cut of this guard on exactly that margin.
 *
 * The band is also deliberately WIDER than the one `roadsweep.mjs` asserts with
 * (-0.05..+1.9 against its 0.15..1.6). A guard that is only as strict as the
 * gate polices nothing at the boundary; this one has to be strictly stronger,
 * or the two disagree about marginal pieces and the marginal pieces are exactly
 * the ones in dispute.
 */
function spansDeck(e, na, nb, len, sMin, sMax, yMin, yMax) {
  const inv = len > 1e-3 ? 1 / len : 0;
  const a0 = Math.max(0, Math.min(len, sMin));
  const a1 = Math.max(0, Math.min(len, sMax));
  const y0 = (na.y ?? 0) + ((nb.y ?? 0) - (na.y ?? 0)) * (a0 * inv);
  const y1 = (na.y ?? 0) + ((nb.y ?? 0) - (na.y ?? 0)) * (a1 * inv);
  const lo = Math.min(y0, y1);
  const hi = Math.max(y0, y1);
  return yMax > lo - GUARD_UNDER && yMin < hi + GUARD_OVER;
}

/** Local scratch for the keep-out — module scope so it never allocates. */
const _kx = new Float64Array(8);
const _ky = new Float64Array(8);
const _kz = new Float64Array(8);

export class BuildingSystem {
  static id = 'buildings';
  static deps = ['materials', 'render', 'world'];

  async init(ctx) {
    this.ctx = ctx;
    this.materials = ctx.get('materials');
    this.physics = ctx.peek('physics');
    this.world = ctx.peek('world');
    this.render = ctx.peek('render');
    this.rng = ctx.rng.fork();

    // `world` is the authority on where everything is. Adopt its landmark
    // coordinates before ANY of them is read — `landmarkClaims`, the skyline
    // and `_buildLandmarks` all consult the table below this line.
    adoptLandmarkSites(this.world?.landmarks);

    this.root = new THREE.Group();
    this.root.name = 'buildings';
    this.root.matrixAutoUpdate = false;
    ctx.scene.add(this.root);

    this.lib = new ProtoLibrary(this.materials);
    this.tiles = new Map();
    this._jobs = [];
    this._failed = 0;
    this._colDirty = false;
    this._colTimer = 0;
    this._camXZ = new THREE.Vector3();
    this._litMats = [];
    this._litMix = -1;

    const q = ctx.config.q;
    this.budgetMs = q.tileBuildBudgetMs ?? 6;
    /** Streamed construction must resolve identically every run (capture mode). */
    this._detBuild = ctx.config.deterministic === true && !WALL_CLOCK_BUILD;
    // Full-detail radius. Everything past it is the L1 mesh, which carries the
    // same massing and the same colours, so the swap is a change of density
    // rather than a change of shape.
    // A dense downtown tile is ~65 merged/instanced batches, and every one of
    // them is drawn again in the prepass and again in each shadow cascade. The
    // full-detail ring is therefore deliberately tight: L1 carries the same
    // massing, the same colours and recessed glazing bands, so what is lost
    // past this radius is facade furniture, not the building.
    this.nearRadius = q.streamRadius >= 700 ? 155 : q.streamRadius >= 450 ? 130 : 100;
    this.midRadius = Math.min(q.streamRadius ?? 520, q.drawDistance ?? 2600);
    /**
     * Past this the far tile stops drawing its facade banding (the reveal
     * piers, spandrels and glazing bands) and keeps only its massing, cornice
     * and roof. Authored in metres for a 1080p / 60-degree frame — `render`
     * rescales it by `q.lodBias`, FOV and resolution.
     */
    this.farDetailDist = 520;

    this._clipDropped = 0;
    this._clipTrimmed = 0;
    this._clipWhy = { straddle: 0, sliver: 0, empty: 0 };
    /** Debug switch for `_clipToStreets`; see the comment there. */
    this.clipStreets = true;
    /** Debug switch for the emitted-geometry kerb guard; see `_keepOutFor`. */
    this.kerbGuard = !NO_KERB_GUARD;
    /**
     * THE GUARD IS NOT APPLIED TO LANDMARKS, AND IT NO LONGER NEEDS TO BE.
     *
     * `roadsweep.mjs` used to measure 114 drivable directions blocked by roads
     * running straight through five of the six authored landmark sites: three
     * highway segments and an alley across the Steel Bowl's 108 x 86 m pier
     * ring, a street 4.4 m from the centre of the Strip Market, a parkway
     * whose lane edge was 2.2 m inside the Steel Tower's podium.
     *
     * Turning the guard on for landmarks DID clear them — it took the residual
     * to zero — but by deleting hand-authored structure: measured over the
     * mill, 15 pieces including two 40 m hot-blast stoves. That is not a fix,
     * it is a second defect, and it was refused. The road graph was the right
     * place: `world/netgen.js` now reserves the six sites it publishes
     * (`reserveLandmarks` + a ring road on the reserve isoline), and
     * `src/world/lmsweep.mjs` gates it.
     *
     * The switch stays because it is what priced the trade-off, and because a
     * future landmark that grows past its published site would need it again
     * for the ten minutes before the site is re-measured.
     */
    this.landmarkGuard = false;
    /**
     * Reverts the two PLACEMENT-side road fixes — the elevation gates in
     * `_clipToStreets` and the alley setback — without touching the kerb guard,
     * so `roadsweep.mjs` can price each of them separately instead of reporting
     * one number for three changes. Nothing sets it in the game.
     */
    this.legacyClip = false;
    this._keptOut = 0;
    this.stats = {
      tiles: 0, near: 0, tris: 0, instTris: 0, instances: 0, draws: 0, lots: 0,
      cullGroups: 0, failed: 0, clipDropped: 0, clipTrimmed: 0, keptOut: 0,
    };

    ctx.events.on('world:tile:load', (e) => this._onTileLoad(e));
    ctx.events.on('world:tile:unload', (e) => this._onTileUnload(e));

    // The skyline is resident: it is what makes downtown read from Mt.
    // Washington at 2 km, which is this city's signature view.
    this.skyline = new Skyline(this.lib, this.rng.fork());
    this.skyline.build(this.world, this.root);

    // Landmarks are hand-authored and always resident — they are the
    // silhouette, and they must not pop in behind a stream radius.
    this._buildLandmarks();

    // The airfield structures (hangars, terminal, windsock, beacon, fence)
    // stand on the sites `world` grades and publishes on `world.airfields`.
    // Always resident, like the landmarks — a 600 m runway with pop-in sheds
    // is worse than none.
    this._buildAirfields();

    // Ridgeline AFB: hangars, tower, radar dome, bunkers, tanks and the
    // collision-backed perimeter fence, on the site `world` publishes as
    // `world.airbase`. Resident for the same reason as the airfields.
    this._buildAirbase();

    // If `world` is still a stub (no lot stream), drive a synthetic city so the
    // generators can be developed and reviewed in isolation. Self-removing: the
    // moment `world` exposes lotsInTile, this path is never taken.
    this.synthetic = typeof this.world?.lotsInTile !== 'function';
    if (this.synthetic) {
      console.info('[buildings] world has no lot stream yet — running synthetic lots');
      this._synthTiles = new Set();
    }
  }

  // ------------------------------------------------------------ scheduling --
  /**
   * Route amortised work through `world` when it has a scheduler so
   * `world.streamingIdle()` sees our pending jobs; otherwise run a local queue
   * with the same frame budget.
   */
  schedule(fn, priority = 0) {
    const w = this.world;
    if (typeof w?.schedule === 'function') {
      w.schedule(fn, priority);
      this._usedWorldQueue = true;
    } else {
      this._jobs.push({ fn, priority });
      if (this._jobs.length > 1) this._jobs.sort((a, b) => b.priority - a.priority);
    }
  }

  /** How much building work is still queued. `world` may poll this. */
  pendingJobs() {
    return this._jobs.length;
  }

  /** True when nothing is left to build. Mirrors `world.streamingIdle()`. */
  streamingIdle() {
    return this._jobs.length === 0;
  }

  _drain(dt) {
    if (!this._jobs.length) return;
    // Capture mode budgets in JOBS so the result is a pure function of the
    // queue; play keeps the wall clock, where an overrun is a stutter.
    const counted = this._detBuild ? DET_JOBS_PER_FRAME : 0;
    const t0 = performance.now();
    let ran = 0;
    while (this._jobs.length && (counted ? ran < counted : performance.now() - t0 < this.budgetMs)) {
      ran++;
      const j = this._jobs.shift();
      try {
        j.fn();
      } catch (err) {
        console.error('[buildings] build job failed', err);
      }
    }
  }

  // --------------------------------------------------------------- streaming --
  _key(tx, tz) {
    return `${tx},${tz}`;
  }

  _onTileLoad({ tx, tz, lots, bounds }) {
    const key = this._key(tx, tz);
    if (this.tiles.has(key)) return;
    const size = spanOf(bounds) || SYNTH_TILE;
    const cx = bounds ? centreOf(bounds, 'x') : (tx + 0.5) * size;
    const cz = bounds ? centreOf(bounds, 'z') : (tz + 0.5) * size;
    const group = new THREE.Group();
    group.name = `btile_${key}`;
    group.matrixAutoUpdate = false;
    group.updateMatrix();
    this.root.add(group);
    const rec = {
      tx,
      tz,
      key,
      lots: lots ?? [],
      cx,
      cz,
      size,
      // The XZ radius used by the LOD test: the half-DIAGONAL of the tile, so
      // "is any part of this tile inside nearRadius" is the question it
      // actually answers. The old `size * 0.75 + 40` over-reached by ~46 m in
      // every direction, which quietly made the full-detail ring 90 m wider
      // than the number it is authored as and put sixteen tiles at L0.
      radius: size * 0.7072 + 2,
      group,
      cullOff: null,
      cullR: size * 0.7072 + 30,
      cullY: 14,
      far: null,
      near: null,
      nearBuilding: false,
      plans: null,
    };
    this.tiles.set(key, rec);
    this.stats.tiles = this.tiles.size;
    this.skyline?.suppress(cx, cz, size);
    this._registerCull(rec);

    this.schedule(() => this._buildFar(rec), 1);
  }

  /**
   * HIERARCHICAL CULLING. One sphere test per tile decides the fate of every
   * mesh under it, instead of `traverseVisible` descending into 260 streamed
   * tiles and three running a leaf frustum test on each of ~1800 meshes
   * (ARCHITECTURE.md, render integration). Re-registering the same object
   * updates the entry in place, so this is called again once the far mesh has
   * been built and the real vertical extent of the tile is known.
   */
  _registerCull(rec) {
    if (!this.render?.registerCullGroup || !rec.group) return;
    const off = this.render.registerCullGroup(rec.group, {
      center: rec.cullC ?? [rec.cx, this._groundAt(rec.cx, rec.cz) + rec.cullY, rec.cz],
      radius: rec.cullR,
      // No point drawing a streamed tile past the radius the far mesh is
      // authored for, even when the draw distance would allow it — the skyline
      // field covers everything beyond.
      maxDistance: this.midRadius + rec.size,
    });
    if (!rec.cullOff) rec.cullOff = off;
    this.stats.cullGroups = this.render.stats?.cullGroups ?? 0;
  }

  _onTileUnload({ tx, tz }) {
    const key = this._key(tx, tz);
    const rec = this.tiles.get(key);
    if (!rec) return;
    // Drop the cull registration BEFORE the group leaves the scene: the culler
    // holds a reference and would keep testing a detached tile forever.
    if (rec.cullOff) rec.cullOff();
    else this.render?.unregisterCullGroup?.(rec.group);
    rec.cullOff = null;
    releaseTile(rec.far, this.physics);
    releaseTile(rec.near, this.physics);
    rec.group?.parent?.remove(rec.group);
    rec.group = null;
    this.skyline?.restore(rec.cx, rec.cz, rec.size);
    this.tiles.delete(key);
    this.stats.tiles = this.tiles.size;
    this._colDirty = true;
  }

  /**
   * Is this record still the live one for its key?
   *
   * THE BUG THIS EXISTS FOR. Build jobs are amortised, so a job holds a `rec`
   * across many frames. A player driving along a tile boundary can unload a
   * tile and load it again before that job runs, and `_onTileLoad` makes a
   * BRAND NEW record for the same key. The old guard was
   * `this.tiles.has(rec.key)` — a KEY test, which the reloaded tile passes — so
   * the stale job ran to completion against a record whose `far.group` had
   * already been nulled by `releaseTile`, and died on
   * `rec.far.group.visible = false` with "Cannot set properties of null".
   * `world`'s job queue catches and logs the throw, so the only visible symptom
   * was a tile that had quietly attached a second, orphaned copy of its
   * geometry to the scene root that nothing would ever free or hide.
   */
  _live(rec) {
    return this.tiles.get(rec.key) === rec;
  }

  /**
   * A uniform grid over `world.roads.edges`, built once, so "which roads can
   * reach this lot" is a handful of bucket lookups instead of a boundary sweep
   * of `nearestEdge` calls inside the streaming budget. Each edge is stamped
   * into every cell its corridor AABB touches, so a query on the lot's own
   * (expanded) AABB is exact, not approximate.
   */
  _roadGrid() {
    const roads = this.world?.roads;
    const edges = roads?.edges;
    if (!edges) return null;
    if (this._rgrid && this._rgridN === edges.length) return this._rgrid;
    const cell = 64;
    const grid = new Map();
    for (const e of edges) {
      const na = roads.nodes[e.a];
      const nb = roads.nodes[e.b];
      if (!na || !nb) continue;
      const pad = (e.width ?? 8) * 0.5 + 6;
      const x0 = Math.floor((Math.min(na.x, nb.x) - pad) / cell);
      const x1 = Math.floor((Math.max(na.x, nb.x) + pad) / cell);
      const z0 = Math.floor((Math.min(na.z, nb.z) - pad) / cell);
      const z1 = Math.floor((Math.max(na.z, nb.z) + pad) / cell);
      for (let z = z0; z <= z1; z++) {
        for (let x = x0; x <= x1; x++) {
          const k = x * 73856093 ^ (z * 19349663);
          let list = grid.get(k);
          if (!list) grid.set(k, (list = []));
          list.push(e);
        }
      }
    }
    this._rgridN = edges.length;
    this._rgridCell = cell;
    return (this._rgrid = grid);
  }

  /** Every road edge whose corridor can reach this polygon. */
  _roadsNear(poly) {
    const grid = this._roadGrid();
    if (!grid) return [];
    const cell = this._rgridCell;
    let x0 = Infinity;
    let x1 = -Infinity;
    let z0 = Infinity;
    let z1 = -Infinity;
    for (const p of poly) {
      if (p[0] < x0) x0 = p[0];
      if (p[0] > x1) x1 = p[0];
      if (p[1] < z0) z0 = p[1];
      if (p[1] > z1) z1 = p[1];
    }
    const out = [];
    const seen = this._rgSeen ?? (this._rgSeen = new Set());
    seen.clear();
    const cx0 = Math.floor((x0 - 4) / cell);
    const cx1 = Math.floor((x1 + 4) / cell);
    const cz0 = Math.floor((z0 - 4) / cell);
    const cz1 = Math.floor((z1 + 4) / cell);
    for (let z = cz0; z <= cz1; z++) {
      for (let x = cx0; x <= cx1; x++) {
        const list = grid.get(x * 73856093 ^ (z * 19349663));
        if (!list) continue;
        for (const e of list) {
          if (seen.has(e)) continue;
          seen.add(e);
          out.push(e);
        }
      }
    }
    return out;
  }

  /**
   * Keep a lot out of the road.
   *
   * THE DEFECT THIS EXISTS FOR. `traffic` measured 6-12% of AI car-frames
   * constrained by a `bcol_concrete` collider ON THE CARRIAGEWAY — cars braking
   * for a building, blacklisting the edge and re-routing round the block. It is
   * not a collision-authoring bug: the collision proxies sit exactly inside the
   * wall line. The lots themselves are in the road. Measured over 75 streamed
   * tiles: **365 of 482 buildable lots had at least one footprint corner inside
   * a running lane**, worst case 14.26 m past the kerb — the centreline of a
   * 28.6 m highway. The `detail` capture proved it from the other end: its
   * camera is snapped onto a real lane centre by the shot rig and there was a
   * building wall 1.21 m in front of the lens, which is why that frame is a
   * featureless slab and why the critic read it as "windowless stucco".
   *
   * `world` owns lot subdivision and this file may not reach into it, so the
   * fix is on the consuming side: clip the footprint to the back-of-pavement
   * line of every road that runs past it before anything is planned from it.
   * Clipping (rather than nudging vertices) keeps the frontage straight and
   * parallel to its street.
   */
  _clipToStreets(lot) {
    const roads = this.world?.roads;
    const foot = lot.footprint;
    if (!this.clipStreets) return foot;
    if (!roads?.nearestEdge || !roads.nodes || !Array.isArray(foot) || foot.length < 3) return foot;

    let poly = foot;
    const c0 = polyCentroid(poly);

    /**
     * THE HEIGHT THIS COMPARES AGAINST IS THE BUILDING'S, NOT THE TERRAIN'S.
     *
     * This used to ask two terrain questions — is the deck high above the
     * ground UNDER THE DECK (a viaduct), and is the ground at the lot CENTROID
     * high above the deck (a clifftop) — and skip the road on either. Both are
     * proxies, and both are wrong on a hill:
     *
     *   - `_plans` sits the building on the LOWEST corner of its footprint, not
     *     on the centroid. Measured on a hillside house, the centroid was
     *     12.5 m uphill of a base that sat 0.3 m under the road it was
     *     blocking, so the clifftop test fired on a building standing in the
     *     carriageway.
     *   - A road climbing an embankment reads as a viaduct against the terrain
     *     beneath it while still being an ordinary at-grade street beside the
     *     lot. Eleven lots kept a wall in a live lane that way, up to 6.4 m in.
     *
     * The question that actually matters is whether the DECK passes through the
     * volume the building will occupy: `[baseY, baseY + height]`. That is the
     * same quantity `_plans` uses for `plan.groundY` and the same one
     * `props.laneIntrusion` gates on, so the clip and the assertion that
     * polices it are asking about the same thing.
     */
    let baseY = Infinity;
    for (const p of poly) {
      const h = this._groundAt(p[0], p[1]);
      if (h < baseY) baseY = h;
    }
    if (!Number.isFinite(baseY)) baseY = this._groundAt(c0[0], c0[1]);
    // Conservative: an unknown lot is treated as tall, so an unknown road
    // overhead is clipped against rather than ignored.
    const topY = Math.max(lot.height ?? 0, (lot.floors ?? 0) * 3.6, 9);

    /**
     * Candidate roads come from our own grid rather than from
     * `roads.nearestEdge`, and that is a correctness fix as much as a speed one.
     * `nearestEdge` answers with ONE edge — the nearest — so probing the
     * boundary can only ever discover the roads that happen to win at a sample
     * point, and it misses the second road at a corner. Worse, clipping
     * introduces NEW vertices, so the probe set has to be recollected and the
     * whole thing iterated to a fixed point; six passes of boundary probing
     * cost enough streaming CPU to trip the frame governor down a tier.
     *
     * The grid returns every edge whose corridor can reach the lot, so ONE
     * pass is exact: the result is the intersection of the lot with every
     * half-plane, and intersection does not care about order.
     */
    const cands = this._roadsNear(poly);
    for (const e of cands) {
      const na = roads.nodes[e.a];
      const nb = roads.nodes[e.b];
      if (!na || !nb) continue;
      const dx = e.dx;
      const dz = e.dz;
      if (!Number.isFinite(dx) || !Number.isFinite(dz)) continue;

      /**
       * The deck height AT THIS LOT, not at the segment's midpoint — a road
       * climbing 12 m over its own length is a different height at each end,
       * and the midpoint is neither.
       */
      const len = e.len ?? 0;
      let tt = (c0[0] - na.x) * dx + (c0[1] - na.z) * dz;
      tt = tt < 0 ? 0 : tt > len ? len : tt;
      const roadY = (na.y ?? 0) + ((nb.y ?? 0) - (na.y ?? 0)) * (len > 1e-3 ? tt / len : 0);
      if (this.legacyClip) {
        // The pre-fix gates, kept only so the fix can be priced. See above.
        const dg = this._groundAt((na.x + nb.x) * 0.5, (na.z + nb.z) * 0.5);
        const mid = ((na.y ?? 0) + (nb.y ?? 0)) * 0.5;
        if (mid - dg > 5) continue;
        if (this._groundAt(c0[0], c0[1]) - mid > 9) continue;
      } else {
        // A road below the building's foundations cannot be fouled by it.
        if (roadY < baseY - 3) continue;
        // Nor can a viaduct that passes clear over the roof.
        if (roadY > baseY + topY + 2) continue;
      }
      const setb = this.legacyClip
        ? (LEGACY_SETBACK[e.kind] ?? LEGACY_SETBACK.street)
        : (STREET_SETBACK[e.kind] ?? STREET_SETBACK.street);
      const need = (this.legacyClip ? (e.width ?? 8) * 0.5 : carriagewayHalf(e)) + setb;

      /**
       * Longitudinal guard: the half-plane is infinite, the road is not. Only
       * clip when the lot lies alongside the segment ITSELF.
       *
       * The tolerance is deliberately tight. A road is a polyline of short
       * segments (`nodes` are bends as well as junctions), so a generous
       * tolerance lets the extended line of a segment that turns away at a
       * junction cut straight through the middle of the next block. At ±8 m
       * that cost an extra 15% of the city's footprint area; at ±2 m a corner
       * lot is still clipped by both of its streets, because at a junction the
       * two arms genuinely overlap the lot's own span.
       */
      let sMin = Infinity;
      let sMax = -Infinity;
      let latC = 0;
      for (const p of poly) {
        const px = p[0] - na.x;
        const pz = p[1] - na.z;
        const s = px * dx + pz * dz;
        if (s < sMin) sMin = s;
        if (s > sMax) sMax = s;
        latC += -dz * px + dx * pz;
      }
      latC /= poly.length;
      if (sMax < -2 || sMin > (e.len ?? 0) + 2) continue;

      // Which side of the road is the building on? A lot whose centroid is
      // essentially ON the centreline is not a lot, it is a mistake.
      if (Math.abs(latC) < 0.5) {
        this._clipWhy.straddle++;
        return null;
      }
      const sgn = latC > 0 ? 1 : -1;
      // keep  sgn * (-dz*(x-na.x) + dx*(z-na.z)) >= need
      const nx = -dz * sgn;
      const nz = dx * sgn;
      const d = need + nx * na.x + nz * na.z;
      poly = clipHalfPlane(poly, nx, nz, d);
      if (poly.length < 3) {
        this._clipWhy.empty++;
        return null;
      }
    }

    if (poly === foot) return foot;
    /**
     * A sliver is worse than a gap: it builds a 2 m wedge of facade standing on
     * the pavement. But the threshold has to be generous — a corner lot legally
     * loses a third of its area to two kerb lines, and dropping those was what
     * emptied 187 of 435 lots on the first pass. Area floor plus a minimum
     * on-street dimension, not a ratio.
     */
    const a1 = Math.abs(polyArea(poly));
    let span = 0;
    for (let i = 0; i < poly.length; i++) {
      const a = poly[i];
      const b = poly[(i + 1) % poly.length];
      span = Math.max(span, Math.hypot(b[0] - a[0], b[1] - a[1]));
    }
    if (a1 < 24 || span < 4) {
      this._clipWhy.sliver++;
      return null;
    }
    return poly;
  }

  /**
   * THE KERB KEEP-OUT — the guard that works on what is BUILT, not on the lot.
   *
   * `_clipToStreets` trims the lot POLYGON. Nothing downstream of it was
   * checked, and `roadsweep.mjs` measured what that costs: of 458 buildings
   * with emitted geometry inside a drivable lane, only 13 had a clipped
   * polygon corner in one. The other 445 were built correctly on a correctly
   * clipped plan and then had something hung off them:
   *
   *   - `dressIndustrial` places silos at `bounds.x0 - r * 1.2` and pipe-rack
   *     legs at `bounds.z0 - 2.4` — DELIBERATELY outside the footprint's
   *     bounding box, which on a lot that is not axis-aligned is already
   *     metres outside the footprint itself. Measured reach past `plan.foot`:
   *     16.25 m.
   *   - `buildPlinth` steps two courses out, 0.14 m and 0.34 m.
   *   - `planBuilding` yaws the whole plan by up to +/-0.011 rad about its
   *     centroid, which moves a corner of a 60 m lot by half a metre.
   *   - Every landmark in `landmarks.js` is placed at an authored coordinate
   *     and clipped against nothing at all.
   *
   * So the guard is applied at the point the geometry is handed to the tile.
   * It is deliberately a DIFFERENT question from the polygon clip — "is this
   * piece standing on the carriageway", asked of the piece's own vertices —
   * and it drops rather than moves, because a silo that has nowhere legal to
   * stand should not be built at all.
   *
   * It is written to be unable to eat a wall. The cheap test is the piece's
   * transformed bounding box; a piece that trips it is then re-tested against
   * its ACTUAL vertices, so a `polyPrism` whose local bounding box is the
   * footprint's AABB — the plinth, the roof deck — is judged on the polygon it
   * really is rather than on the box that encloses it. On a lot rotated 30
   * degrees off the world axes those are not remotely the same shape, and
   * judging on the box would delete the plinth from half the city.
   *
   * @param {Array} edges candidate road edges (from `_roadsNear`)
   * @returns {Function|null} `(bbox, matrix, geo) => boolean`, true to drop
   */
  _keepOutFor(edges) {
    if (!this.kerbGuard || !edges || edges.length === 0) return null;
    const roads = this.world?.roads;
    if (!roads?.nodes) return null;
    const self = this;

    /** Do the 8 points in `_kx/_ky/_kz` stand on any candidate carriageway? */
    const testPoints = (n) => {
      for (let i = 0; i < edges.length; i++) {
        const e = edges[i];
        if (e.rail) continue;
        const na = roads.nodes[e.a];
        const nb = roads.nodes[e.b];
        if (!na || !nb) continue;
        const len = e.len ?? 0;
        const lim = carriagewayHalf(e) + KERB_MARGIN;
        let sMin = Infinity;
        let sMax = -Infinity;
        let latMin = Infinity;
        let latMax = -Infinity;
        let yMin = Infinity;
        let yMax = -Infinity;
        for (let k = 0; k < n; k++) {
          const px = _kx[k] - na.x;
          const pz = _kz[k] - na.z;
          const s = px * e.dx + pz * e.dz;
          const lat = -e.dz * px + e.dx * pz;
          if (s < sMin) sMin = s;
          if (s > sMax) sMax = s;
          if (lat < latMin) latMin = lat;
          if (lat > latMax) latMax = lat;
          if (_ky[k] < yMin) yMin = _ky[k];
          if (_ky[k] > yMax) yMax = _ky[k];
        }
        // Alongside this segment at all? Edges meet end to end, so the
        // neighbour owns the ground past the node; only a short slop here.
        if (sMax < -2 || sMin > len + 2) continue;
        // Across the carriageway band?
        if (latMin >= lim || latMax <= -lim) continue;
        // At the deck's own height? A cornice twelve metres up and a basement
        // vault four metres down are both free to overlap in plan.
        if (!spansDeck(e, na, nb, len, sMin, sMax, yMin, yMax)) continue;
        return true;
      }
      return false;
    };

    return (bbox, matrix, geo) => {
      if (!bbox) return false;
      const lo = bbox.min;
      const hi = bbox.max;
      let n = 0;
      for (let i = 0; i < 8; i++) {
        const x = i & 1 ? hi.x : lo.x;
        const y = i & 2 ? hi.y : lo.y;
        const z = i & 4 ? hi.z : lo.z;
        if (matrix) {
          const m = matrix.elements;
          _kx[n] = m[0] * x + m[4] * y + m[8] * z + m[12];
          _ky[n] = m[1] * x + m[5] * y + m[9] * z + m[13];
          _kz[n] = m[2] * x + m[6] * y + m[10] * z + m[14];
        } else {
          _kx[n] = x;
          _ky[n] = y;
          _kz[n] = z;
        }
        n++;
      }
      if (!testPoints(8)) return false;
      // The bounding box says it might be in the road. Ask the geometry.
      return self._keepOutExact(edges, matrix, geo);
    };
  }

  /**
   * Second opinion, on the real vertices. Only ever reached by a piece whose
   * bounding box already trips the guard, so the cost is paid by the handful
   * of pieces near a kerb rather than by the whole city.
   */
  _keepOutExact(edges, matrix, geo) {
    const roads = this.world.roads;
    const pa = geo?.getAttribute?.('position');
    if (!pa) return true;
    const P = pa.array;
    const m = matrix ? matrix.elements : null;
    for (let i = 0; i < edges.length; i++) {
      const e = edges[i];
      if (e.rail) continue;
      const na = roads.nodes[e.a];
      const nb = roads.nodes[e.b];
      if (!na || !nb) continue;
      const len = e.len ?? 0;
      const lim = carriagewayHalf(e) + KERB_MARGIN;
      let sMin = Infinity;
      let sMax = -Infinity;
      let latMin = Infinity;
      let latMax = -Infinity;
      let yMin = Infinity;
      let yMax = -Infinity;
      for (let v = 0; v < P.length; v += 3) {
        let x = P[v];
        let y = P[v + 1];
        let z = P[v + 2];
        if (m) {
          const nx = m[0] * x + m[4] * y + m[8] * z + m[12];
          const ny = m[1] * x + m[5] * y + m[9] * z + m[13];
          const nz = m[2] * x + m[6] * y + m[10] * z + m[14];
          x = nx;
          y = ny;
          z = nz;
        }
        const px = x - na.x;
        const pz = z - na.z;
        const s = px * e.dx + pz * e.dz;
        const lat = -e.dz * px + e.dx * pz;
        if (s < sMin) sMin = s;
        if (s > sMax) sMax = s;
        if (lat < latMin) latMin = lat;
        if (lat > latMax) latMax = lat;
        if (y < yMin) yMin = y;
        if (y > yMax) yMax = y;
      }
      if (sMax < -2 || sMin > len + 2) continue;
      if (latMin >= lim || latMax <= -lim) continue;
      if (!spansDeck(e, na, nb, len, sMin, sMax, yMin, yMax)) continue;
      return true;
    }
    return false;
  }

  /**
   * Build ONE plan into a tile, guarded.
   *
   * Both LOD builds go through here and so does `roadsweep.mjs`, which is the
   * point: an assertion that reimplements the two lines around `buildLot` is an
   * assertion of something the game does not do, and the kerb guard would have
   * been invisible to it. (It was, on the first run — the sweep reported the
   * unguarded numbers and looked like the fix had done nothing.)
   *
   * `lod` 0 = full detail, 1 = massing.
   */
  buildPlan(T, plan, lod = 0) {
    const rng = new Rng(plan.rngSeed ^ (lod ? 0x9e37 : 0x51ed));
    // One keep-out per building, from that building's own neighbourhood of
    // roads. Cleared afterwards so a plan can never inherit the last one's.
    T.setKeepOut(this._keepOutFor(plan.nearRoads ?? this._roadsNear(plan.foot)));
    try {
      if (lod) buildLotLod(T, this.lib, plan, rng, plan.groundY);
      else buildLot(T, this.lib, plan, rng, plan.groundY);
    } finally {
      T.setKeepOut(null);
    }
    return T;
  }

  /**
   * Build ONE landmark into a tile, guarded the same way. See the note in
   * `_buildLandmarks` about why landmarks need this more than lots do.
   */
  buildLandmarkPlan(T, lm) {
    const r = LM_REACH[lm.id] ?? 160;
    T.setKeepOut(this.landmarkGuard
      ? this._keepOutFor(this._roadsNear([
        [lm.x - r, lm.z - r], [lm.x + r, lm.z - r],
        [lm.x + r, lm.z + r], [lm.x - r, lm.z + r],
      ]))
      : null);
    try {
      buildLandmark(T, this.lib, lm, new Rng(lm.seed), this._groundAt(lm.x, lm.z),
        (px, pz) => this._groundAt(px, pz));
    } finally {
      T.setKeepOut(null);
    }
    return T;
  }

  /** Plans are shared by both LODs so the two meshes cannot disagree. */
  _plans(rec) {
    if (rec.plans) return rec.plans;
    const plans = [];
    const tileSeed = (Math.imul(rec.tx | 0, 0x27d4eb2d) ^ Math.imul(rec.tz | 0, 0x165667b1)) >>> 0;
    const blocks = new Map();
    for (const lot of rec.lots) {
      if (!lot || lot.kind === 'park' || lot.kind === 'lot') continue;
      // Never build a generated lot through a landmark.
      const fp = lot.footprint?.[0];
      if (fp && landmarkClaims(fp[0], fp[1])) continue;
      /**
       * Clipped once per tile load — `_plans` is memoised on the record and
       * both LOD builds read the same list, so the two meshes cannot disagree
       * about where the building is.
       */
      const clipped = this._clipToStreets(lot);
      if (!clipped) {
        this.stats.clipDropped = ++this._clipDropped;
        this.stats.clipWhy = this._clipWhy;
        continue;
      }
      if (clipped !== lot.footprint) this.stats.clipTrimmed = ++this._clipTrimmed;
      const rng = new Rng((lot.seed ?? hashLot(lot)) >>> 0);
      const did = lot.district?.id ?? lot.district;
      const style = districtStyle(did);
      let block = blocks.get(did);
      if (!block) blocks.set(did, (block = blockPalette(Rng, tileSeed, style)));
      let plan;
      try {
        plan = planBuilding({ ...lot, footprint: clipped }, style, rng, block);
      } catch (err) {
        continue;
      }
      plan.rngSeed = (lot.seed ?? hashLot(lot)) >>> 0;
      // Gathered once and shared by both LOD builds, so the two meshes cannot
      // be guarded against different sets of roads.
      plan.nearRoads = this._roadsNear(plan.foot);
      // Sit on the LOWEST corner of the footprint, not the centroid. On a hill
      // a centroid-height pad floats a whole storey clear of the pavement on
      // the downhill side, and Steel City is built on hills.
      let gy = Infinity;
      for (const c of plan.foot) gy = Math.min(gy, this._groundAt(c[0], c[1]));
      if (!Number.isFinite(gy)) gy = this._groundAt(plan.centroid[0], plan.centroid[1]);
      plan.groundY = gy - 0.12;
      plans.push(plan);
    }
    rec.plans = plans;
    this.stats.lots += plans.length;
    return plans;
  }

  /**
   * Terrain height. ONLY `heightAt` — the documented world contract. The old
   * corridor world's `groundHeight` is authored for a 120 m level and returns
   * nonsense two kilometres out, which would drop half the city through the
   * floor while `world` is mid-rewrite.
   */
  _groundAt(x, z) {
    const h = this.world?.heightAt?.(x, z);
    return Number.isFinite(h) ? h : 0;
  }

  _buildFar(rec) {
    if (!this._live(rec)) return;
    let built = null;
    try {
      const plans = this._plans(rec);
      const T = new TileBuilder(this.lib, `far_${rec.key}`);
      for (const plan of plans) {
        try {
          this.buildPlan(T, plan, 1);
        } catch (err) {
          console.error(`[buildings] far lot failed in tile ${rec.key}`, err);
        }
      }
      built = T.build(null, {
        lodDistance: this.farDetailDist,
        lodCenter: [rec.cx, this._groundAt(rec.cx, rec.cz) + 10, rec.cz],
      });
    } catch (err) {
      this._buildFailed(rec, 'far', err);
      return;
    }
    // The tile may have been unloaded (or unloaded AND reloaded) while this job
    // sat in the queue. Free what we just made rather than orphaning it.
    if (!this._live(rec)) {
      releaseTile(built, null);
      return;
    }
    setVisible(built, true);
    rec.far = built;
    rec.group.add(built.group);
    this.render?.patchMaterials?.(built.group);
    this._refreshCull(rec, built);
    this._accum(built.stats);
  }

  _buildNear(rec) {
    if (!this._live(rec)) return;
    rec.nearBuilding = false;
    let built = null;
    try {
      const plans = this._plans(rec);
      const T = new TileBuilder(this.lib, `near_${rec.key}`);
      for (const plan of plans) {
        try {
          this.buildPlan(T, plan, 0);
        } catch (err) {
          console.error(`[buildings] near lot failed in tile ${rec.key}`, err);
        }
      }
      built = T.build(this._live(rec) ? this.physics : null);
    } catch (err) {
      this._buildFailed(rec, 'near', err);
      return;
    }
    if (!this._live(rec)) {
      releaseTile(built, this.physics);
      return;
    }
    setVisible(built, true);
    rec.near = built;
    rec.group.add(built.group);
    this.render?.patchMaterials?.(built.group);
    this._colDirty = true;
    this._accum(built.stats);
    this._refreshCull(rec, built);
    setVisible(rec.far, false);
  }

  /**
   * A build that threw is a HOLE IN THE CITY — the player drives through a
   * block that is not there. Name the tile, keep the frame up, and keep a
   * counter so `stats.failed !== 0` is visible to the profiler and the debug
   * HUD instead of scrolling past in a console nobody is reading.
   */
  _buildFailed(rec, which, err) {
    this._failed++;
    this.stats.failed = this._failed;
    console.error(
      `[buildings] ${which} tile ${rec.key} (${rec.tx},${rec.tz}) at ` +
        `${rec.cx.toFixed(0)},${rec.cz.toFixed(0)} FAILED TO BUILD — ` +
        `${rec.lots?.length ?? 0} lots, this block will be missing`,
      err
    );
    if (which === 'near') rec.nearBuilding = false;
  }

  /**
   * Size the cull sphere from the geometry that was actually emitted. The
   * sphere must ENCLOSE both LOD meshes, so it only ever grows — the far mesh
   * lands first and the near mesh, which carries balconies, fire escapes and
   * roof furniture hanging past the massing, lands later.
   */
  _refreshCull(rec, built) {
    const s = built?.sphere;
    if (!s || !this.render?.registerCullGroup) return;
    const c = rec.cullC;
    let r = s.radius + 3;
    let cx = s.center.x;
    let cy = s.center.y;
    let cz = s.center.z;
    if (c) {
      // Union of the existing sphere and the new one.
      const d = Math.hypot(cx - c[0], cy - c[1], cz - c[2]);
      if (d + r <= rec.cullR) return; // already contained
      if (d + rec.cullR > r) {
        const R = (rec.cullR + r + d) * 0.5;
        const t = d > 1e-4 ? (R - rec.cullR) / d : 0;
        cx = c[0] + (cx - c[0]) * t;
        cy = c[1] + (cy - c[1]) * t;
        cz = c[2] + (cz - c[2]) * t;
        r = R;
      }
    }
    rec.cullC = [cx, cy, cz];
    rec.cullR = Math.max(r, rec.size * 0.7072 + 4);
    this._registerCull(rec);
  }

  _accum(s) {
    if (s.keptOut) this.stats.keptOut = this._keptOut += s.keptOut;
    this.stats.tris += s.tris;
    this.stats.instTris += s.instTris;
    this.stats.instances += s.instances;
    this.stats.draws += s.draws;
  }

  // -------------------------------------------------------------- landmarks --
  _buildLandmarks() {
    this.landmarkTiles = [];
    for (const lm of LANDMARKS) {
      // One landmark is one indivisible job — a blast furnace cannot be built
      // half a stove at a time — so they go through the scheduler at the
      // highest priority and land in the first few frames.
      this.schedule(() => {
        const T = new TileBuilder(this.lib, `lm_${lm.id}`);
        const y = this._groundAt(lm.x, lm.z);
        /**
         * Landmarks get the kerb guard too, and for them it is the ONLY thing
         * standing between a hand-authored coordinate and a live carriageway:
         * `world`'s district grids are laid without reserving the landmark
         * sites, so roads run straight through the Steel Bowl, the Steel Tower
         * plaza and the Strip Market. See the note in `roadsweep.mjs`.
         */
        try {
          // Some landmarks span hundreds of metres of hillside and cannot be
          // built from a single ground sample — see `incline()`.
          this.buildLandmarkPlan(T, lm);
        } catch (err) {
          console.error(`[buildings] landmark ${lm.id} failed`, err);
          return;
        }
        const built = T.build(this.physics);
        this.root.add(built.group);
        this.render?.patchMaterials?.(built.group);
        this.landmarkTiles.push(built);
        this._accum(built.stats);
        this._colDirty = true;
        // Landmarks ARE the silhouette, so they keep the global draw distance
        // rather than the tile radius — but they still take a frustum test, and
        // a stadium behind the camera is six batches nobody is looking at.
        const s = built.sphere;
        built.cullOff =
          this.render?.registerCullGroup?.(built.group, {
            center: s ? [s.center.x, s.center.y, s.center.z] : [lm.x, y + 40, lm.z],
            radius: s ? s.radius + 4 : 220,
          }) ?? null;
      }, 9);
    }
  }

  // -------------------------------------------------------------- airfields --
  /**
   * One indivisible job per airfield, same shape as `_buildLandmarks`. The
   * site (bench plane, layout rects, helpers) is read off `world.airfields`
   * — published by `world/airfield.js`, never re-derived here — and the
   * builder in `./airfield.js` checks every structure against the emitted
   * road graph before standing it up. The kerb keep-out guard is applied on
   * top, belt-and-braces, with a reach that covers the whole field.
   */
  _buildAirfields() {
    this.airfieldTiles = [];
    this.airfieldReports = [];
    for (const af of this.world?.airfields ?? []) {
      if (!af?.pad || !af.layout) continue;
      this.schedule(() => {
        const T = new TileBuilder(this.lib, `af_${af.id}`);
        const lay = af.layout;
        const reach = Math.max(lay.field.a1, lay.field.d1) + 20;
        T.setKeepOut(this._keepOutFor(this._roadsNear([
          [af.x - reach, af.z - reach], [af.x + reach, af.z - reach],
          [af.x + reach, af.z + reach], [af.x - reach, af.z + reach],
        ])));
        let report = null;
        try {
          report = buildAirfield(
            T, this.lib, af, new Rng((af.id.length * 0x9e37 + af.x) >>> 0),
            (px, pz) => this._groundAt(px, pz), this.world.roads
          );
        } catch (err) {
          console.error(`[buildings] airfield ${af.id} failed`, err);
          return;
        } finally {
          T.setKeepOut(null);
        }
        if (!report) return;
        const built = T.build(this.physics);
        this.root.add(built.group);
        this.render?.patchMaterials?.(built.group);
        this.airfieldTiles.push(built);
        this.airfieldReports.push(report);
        this._accum(built.stats);
        this._colDirty = true;
        const s = built.sphere;
        built.cullOff =
          this.render?.registerCullGroup?.(built.group, {
            center: s ? [s.center.x, s.center.y, s.center.z] : [af.x, 20, af.z],
            radius: s ? s.radius + 4 : 420,
          }) ?? null;
      }, 8);
    }
  }

  // --------------------------------------------------------------- airbase --
  /**
   * Ridgeline AFB, one indivisible job — same shape as `_buildAirfields`.
   * The site (bench, layout rects, fence polygon, gates) is read off
   * `world.airbase`, published by `world/airbase.js`, never re-derived.
   * Gated by `src/world/basesweep.mjs`; absent under `?noairbase=1`.
   */
  _buildAirbase() {
    this.airbaseTile = null;
    this.airbaseReport = null;
    const ab = this.world?.airbase;
    if (!ab?.pad || !ab.layout) return;
    this.schedule(() => {
      const T = new TileBuilder(this.lib, 'ab_ridge');
      const reach = 720;
      T.setKeepOut(this._keepOutFor(this._roadsNear([
        [ab.x - reach, ab.z - reach], [ab.x + reach, ab.z - reach],
        [ab.x + reach, ab.z + reach], [ab.x - reach, ab.z + reach],
      ])));
      let report = null;
      try {
        report = buildAirbase(
          T, this.lib, ab, new Rng((ab.id.length * 0x9e37 + ab.x) >>> 0),
          (px, pz) => this._groundAt(px, pz), this.world.roads
        );
      } catch (err) {
        console.error('[buildings] airbase failed', err);
        return;
      } finally {
        T.setKeepOut(null);
      }
      if (!report) return;
      const built = T.build(this.physics);
      this.root.add(built.group);
      this.render?.patchMaterials?.(built.group);
      this.airbaseTile = built;
      this.airbaseReport = report;
      this._accum(built.stats);
      this._colDirty = true;
      const s = built.sphere;
      built.cullOff =
        this.render?.registerCullGroup?.(built.group, {
          center: s ? [s.center.x, s.center.y, s.center.z] : [ab.x, 24, ab.z],
          radius: s ? s.radius + 4 : 760,
        }) ?? null;
    }, 8);
  }

  // ---------------------------------------------------------------- runtime --
  update(dt, ctx) {
    this._drain(dt);
    ctx.camera.getWorldPosition(this._camXZ);
    const cam = this._camXZ;

    if (this.synthetic) this._synthStream(cam);

    // LOD selection. One distance test per tile, no allocation.
    let near = 0;
    for (const rec of this.tiles.values()) {
      const dx = rec.cx - cam.x;
      const dz = rec.cz - cam.z;
      const d = Math.sqrt(dx * dx + dz * dz) - rec.radius;
      const wantNear = d < this.nearRadius;
      if (wantNear && !rec.near && !rec.nearBuilding) {
        rec.nearBuilding = true;
        this.schedule(() => this._buildNear(rec), 4);
      } else if (!wantNear && rec.near && d > this.nearRadius * 1.35) {
        releaseTile(rec.near, this.physics);
        rec.near = null;
        this._colDirty = true;
        setVisible(rec.far, true);
      }
      const showNear = !!rec.near;
      setVisible(rec.near, true);
      setVisible(rec.far, !showNear && d < this.midRadius);
      if (showNear) near++;
    }
    this.stats.near = near;
    this.stats.cullGroups = this.render?.stats?.cullGroups ?? 0;

    // Suppress skyline instances only where streamed tiles actually cover the
    // ground; suppressing out to `midRadius` while the synthetic streamer only
    // reaches 288 m would punch a hole in the city.
    this.skyline?.update(cam, this.synthetic ? 3 * SYNTH_TILE : this.midRadius);
    this._driveLights(ctx);

    // The BVH rebuild is O(tris); doing it per tile would cost more than the
    // whole build. Coalesce.
    this._colTimer += dt;
    if (this._colDirty && this._colTimer > 0.35) {
      this._colTimer = 0;
      this._colDirty = false;
      this.physics?.rebuildStatic?.();
    }
  }

  /**
   * Lit windows are emissive materials, not point lights — a night skyline
   * needs tens of thousands of them and `q.lightSlots` is eight. One uniform
   * write per material per change drives the whole city.
   */
  _driveLights(ctx) {
    if (!this._litMats.length) {
      for (const k of ['room_lit_warm', 'room_lit_cool', 'neon_amber', 'neon_teal', 'neon_red']) {
        const m = this.lib._mats.get(k);
        if (m) this._litMats.push({ m, base: SURFACES[k]?.opts?.three?.emissiveIntensity ?? 1 });
      }
      if (!this._litMats.length) return;
    }
    const sky = this._sky ?? (this._sky = ctx.peek('sky'));
    const alt = sky?.sunAltitude ?? 0.5;
    const mix = 1 - Math.min(1, Math.max(0, (alt + 0.06) / 0.2));
    if (Math.abs(mix - this._litMix) < 0.02) return;
    this._litMix = mix;
    for (const e of this._litMats) e.m.emissiveIntensity = e.base * (0.22 + 5.2 * mix);
  }

  // ------------------------------------------------- synthetic development --
  /**
   * A stand-in lot stream while `world` is mid-rewrite. It streams around the
   * camera exactly as `world` will, and feeds the SAME `world:tile:load`
   * handler, so nothing downstream of it is a special case.
   */
  _synthStream(cam) {
    const R = 3;
    const ctx0 = Math.floor(cam.x / SYNTH_TILE);
    const ctz0 = Math.floor(cam.z / SYNTH_TILE);
    const want = new Set();
    for (let tz = ctz0 - R; tz <= ctz0 + R; tz++) {
      for (let tx = ctx0 - R; tx <= ctx0 + R; tx++) {
        const dx = (tx + 0.5) * SYNTH_TILE - cam.x;
        const dz = (tz + 0.5) * SYNTH_TILE - cam.z;
        if (Math.hypot(dx, dz) > R * SYNTH_TILE) continue;
        const k = this._key(tx, tz);
        want.add(k);
        if (this.tiles.has(k)) continue;
        this._onTileLoad(syntheticTiles(tx, tz));
      }
    }
    for (const k of [...this.tiles.keys()]) {
      if (want.has(k)) continue;
      const rec = this.tiles.get(k);
      this._onTileUnload({ tx: rec.tx, tz: rec.tz });
    }
  }

  // --------------------------------------------------------------- pre-warm --
  /**
   * Compile every material this subsystem can produce, before the frame loop
   * starts (ARCHITECTURE.md "Pre-warm"). Building one of everything into a
   * scratch scene is the only way to reach the real permutations: instanced vs
   * merged, with and without instanceColor, opaque and transparent — through
   * the forward pass, the CSM depth override and the MRT prepass.
   *
   * Pixel-neutral by construction: it compiles, it never draws, and the
   * scratch scene is disposed before it returns.
   */
  async prewarmMaterials(ctx = this.ctx) {
    const render = ctx.peek?.('render') ?? ctx.get?.('render');
    const renderer = render?.renderer;
    if (!renderer) return { ok: false, reason: 'no renderer' };
    const t0 = performance.now();
    const before = renderer.info.programs?.length ?? 0;

    const scene = new THREE.Scene();
    const built = [];
    // One building per archetype in each district: reaches every material the
    // generators can select, and every geometry path they can take.
    const lots = syntheticLots(0, 0, { exhaustive: true });
    const T = new TileBuilder(this.lib, 'prewarm');
    for (const lot of lots) {
      const style = districtStyle(lot.district);
      const r = new Rng((lot.seed ?? 1) >>> 0);
      try {
        const plan = planBuilding(lot, style, r);
        buildLot(T, this.lib, plan, new Rng(3), 0);
        buildLotLod(T, this.lib, plan, new Rng(4), 0);
      } catch {
        /* a shape we cannot plan must not take the boot down */
      }
    }
    const rec = T.build(null);
    scene.add(rec.group);
    built.push(rec);

    // Anything the streamed path never sees but a landmark does.
    for (const lm of LANDMARKS) {
      const T2 = new TileBuilder(this.lib, `pw_${lm.id}`);
      try {
        buildLandmark(T2, this.lib, lm, new Rng(lm.seed), 0);
      } catch {
        continue;
      }
      const r2 = T2.build(null);
      scene.add(r2.group);
      built.push(r2);
    }

    // ...and the airfield structures, which are likewise resident-only.
    for (const af of this.world?.airfields ?? []) {
      if (!af?.pad || !af.layout || !this.world?.roads) continue;
      const T3 = new TileBuilder(this.lib, `pw_${af.id}`);
      try {
        buildAirfield(T3, this.lib, af, new Rng(7), (px, pz) => this._groundAt(px, pz), this.world.roads);
      } catch {
        continue;
      }
      const r3 = T3.build(null);
      scene.add(r3.group);
      built.push(r3);
    }

    // ...and the airbase, whose palette keys (mil_drab, mil_concrete,
    // hazard_yellow) appear nowhere else in the city.
    {
      const ab = this.world?.airbase;
      if (ab?.pad && ab.layout && this.world?.roads) {
        const T4 = new TileBuilder(this.lib, 'pw_ab');
        try {
          buildAirbase(T4, this.lib, ab, new Rng(11), (px, pz) => this._groundAt(px, pz), this.world.roads);
          const r4 = T4.build(null);
          scene.add(r4.group);
          built.push(r4);
        } catch { /* prewarm never blocks boot */ }
      }
    }

    /**
     * The impostor tier's three surfaces are used ONLY by the resident skyline
     * field, which is built in `init()` and never goes through `TileBuilder` —
     * so nothing above reaches them and the first rendered frame would pay for
     * three fresh programs plus their depth and prepass variants. One
     * single-instance stand-in each is enough to warm the cache.
     */
    const warmInst = [];
    for (const e of this.skyline?.meshes ?? []) {
      const im = new THREE.InstancedMesh(e.im.geometry, e.im.material, 1);
      im.setMatrixAt(0, new THREE.Matrix4());
      im.instanceMatrix.needsUpdate = true;
      im.frustumCulled = false;
      scene.add(im);
      warmInst.push(im);
    }

    /**
     * EVERY MESH FORM for every material the scratch build produced.
     *
     * `instancing` and `instancingColor` are two separate bits of three's
     * program cache key, so the form a surface happens to take in the synthetic
     * tile above is not the only form the streamed city will draw it in — a
     * facade merged into one Mesh here can arrive as a per-building
     * InstancedMesh there, and each unseen combination is a compile mid-play.
     *
     * Enumerating the forms off the MATERIALS THAT WERE ACTUALLY BUILT, rather
     * than off a hand-written surface list, is what makes this complete: it
     * cannot drift when a generator starts emitting a new surface.
     */
    const forms = [];
    if (!NO_WARM_FIX) {
      const seen = new Set();
      const unit = new THREE.PlaneGeometry(1, 1);
      unit.setAttribute('color', new THREE.Float32BufferAttribute(
        new Float32Array(unit.getAttribute('position').count * 3).fill(0.5), 3));
      forms.push({ dispose: () => unit.dispose() });
      const mats = [];
      scene.traverse((o) => {
        if (!o.material) return;
        for (const m of (Array.isArray(o.material) ? o.material : [o.material])) {
          if (m && !seen.has(m.uuid)) { seen.add(m.uuid); mats.push(m); }
        }
      });
      for (const m of mats) {
        for (const withColor of [false, true]) {
          const im = new THREE.InstancedMesh(unit, m, 1);
          im.setMatrixAt(0, new THREE.Matrix4());
          im.instanceMatrix.needsUpdate = true;
          if (withColor) {
            im.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array([1, 1, 1]), 3);
          }
          im.frustumCulled = false;
          scene.add(im);
          forms.push(im);
        }
        const plain = new THREE.Mesh(unit, m);
        plain.frustumCulled = false;
        scene.add(plain);
      }
    }

    render.patchMaterials?.(scene);
    const prevOverride = ctx.scene.overrideMaterial;
    try {
      await withFrameTarget(renderer, async () => {
        await compile(renderer, scene, ctx.camera);
        for (const over of [render.csm?.depthMaterial, render.gbuffer?.material]) {
          if (!over) continue;
          scene.overrideMaterial = over;
          await compile(renderer, scene, ctx.camera);
        }
      });
    } finally {
      scene.overrideMaterial = prevOverride;
    }

    for (const b of built) releaseTile(b, null);
    // Instance buffers only — the geometry and materials belong to the skyline.
    for (const im of warmInst) im.dispose();
    // Same for the mesh-form stand-ins: the shared unit geometry is disposed by
    // its own entry, the materials belong to the proto library.
    for (const f of forms) f.dispose();
    scene.clear();

    return {
      ok: true,
      ms: Math.round(performance.now() - t0),
      compiled: (renderer.info.programs?.length ?? 0) - before,
      protos: this.lib.protos.size,
    };
  }

  dispose() {
    for (const rec of this.tiles.values()) {
      rec.cullOff?.();
      rec.cullOff = null;
      releaseTile(rec.far, this.physics);
      releaseTile(rec.near, this.physics);
      rec.group?.parent?.remove(rec.group);
    }
    this.tiles.clear();
    for (const b of this.landmarkTiles ?? []) {
      b.cullOff?.();
      releaseTile(b, this.physics);
    }
    this.landmarkTiles = null;
    for (const b of this.airfieldTiles ?? []) {
      b.cullOff?.();
      releaseTile(b, this.physics);
    }
    this.airfieldTiles = null;
    if (this.airbaseTile) {
      this.airbaseTile.cullOff?.();
      releaseTile(this.airbaseTile, this.physics);
      this.airbaseTile = null;
    }
    this._rgrid = null;
    this._rgSeen = null;
    this.skyline?.dispose();
    this.lib.dispose();
    this.root?.parent?.remove(this.root);
    this._jobs.length = 0;
  }
}

/**
 * Show or hide a built tile. `releaseTile` nulls the record's `group`, so a
 * record that is still referenced somewhere after release is truthy with a null
 * group — writing `.visible` through it is exactly the crash this fixes.
 */
function setVisible(built, v) {
  const g = built?.group;
  if (g) g.visible = v;
}

async function compile(renderer, scene, camera) {
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

function spanOf(b) {
  if (!b) return 0;
  if (b.min && b.max) return Math.max(b.max.x - b.min.x, b.max.z - b.min.z);
  if (b.x0 !== undefined && b.x1 !== undefined) return Math.max(b.x1 - b.x0, (b.z1 ?? 0) - (b.z0 ?? 0));
  if (b.size) return b.size;
  return 0;
}

function centreOf(b, axis) {
  if (b.min && b.max) return (b.min[axis] + b.max[axis]) * 0.5;
  const lo = b[`${axis}0`];
  const hi = b[`${axis}1`];
  if (lo !== undefined && hi !== undefined) return (lo + hi) * 0.5;
  return b[axis] ?? 0;
}

function hashLot(lot) {
  const p = lot.footprint?.[0] ?? [lot.x ?? 0, lot.z ?? 0];
  return (Math.imul(Math.round(p[0] * 8) | 0, 0x27d4eb2d) ^ Math.imul(Math.round(p[1] * 8) | 0, 0x165667b1)) >>> 0;
}

export { TAU };
