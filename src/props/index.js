import * as THREE from 'three';
import { ProtoLibrary, TileBatch, releaseTile } from './batch.js';
import { SURFACES, EMISSIVE, DISTRICT_STYLE, SODIUM } from './palette.js';
import { registerStreetKit } from './kit_street.js';
import { registerGreen } from './kit_green.js';
import { registerSignKit } from './kit_sign.js';
import { registerJunkKit } from './kit_junk.js';
import { registerWireKit } from './wires.js';
import { Layout } from './layout.js';

/** `?owNoWarmFix=1` reverts this subsystem's pre-warm to the pre-fix behaviour,
 *  so the two arms can be interleaved in one measurement session. */
const NO_WARM_FIX =
  typeof location !== 'undefined' &&
  new URLSearchParams(location.search).has('owNoWarmFix');

/**
 * DETERMINISTIC BUILD BUDGETS — counts, not milliseconds, in capture mode only.
 *
 * `config.deterministic` means the pixel gate is watching, and a wall-clock
 * budget makes how much city gets built a function of how loaded the machine
 * was. `src/world/streaming.js` carries the full write-up and the measured
 * 2959 / 4074 / 4096 draw-call spread it fixes; both of the loops below are the
 * same hazard inside `props`.
 *
 * TILES, not jobs: each unit here is one tile's worth of work, which is much
 * coarser than a `world` queue job, so the numbers are much smaller. Sized off
 * a `hero` capture, where the whole wall queue is at most a few dozen tiles and
 * the local queue is never used at all while `world` is up.
 *
 * `?owWallClockBuild=1` restores the play budget — the A/B hatch, matching
 * `world`'s.
 */
const DET_WALL_TILES_PER_FRAME = 4;
const DET_LOCAL_JOBS_PER_FRAME = 32;
const WALL_CLOCK_BUILD =
  typeof location !== 'undefined' &&
  new URLSearchParams(location.search).get('owWallClockBuild') === '1';

/** `?owLampRankKey=1` restores the rank-derived light keys in `_submitLamps` —
 *  the teleporting-handover bug `src/props/lampprobe.mjs` exists to catch —
 *  kept as that probe's negative control. */
const LAMP_RANK_KEY =
  typeof location !== 'undefined' &&
  new URLSearchParams(location.search).get('owLampRankKey') === '1';
/** True when streamed construction must resolve identically every run. */
const detBuild = (ctx) => ctx.config.deterministic === true && !WALL_CLOCK_BUILD;

/**
 * Run `fn` with a render target bound, so every program compiled inside it gets
 * the cache key a REAL frame asks for.
 *
 * three folds `outputColorSpace` and `toneMapping` into the program cache key
 * and reads both off the CURRENTLY BOUND target. `core/prewarm.js` leaves the
 * CANVAS bound when it calls the subsystem hooks, so everything compiled here
 * was the `srgb` + tone-mapped variant — while props are drawn into an HDR
 * target, which needs `srgb-linear` + NoToneMapping. The warm program was never
 * asked for and the real one compiled during play.
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
 * PROPS — everything that dresses the street.
 *
 * A GTA V street frame carries three to four times the number of distinct
 * authored object types that a bare procedural city does. This subsystem is the
 * difference. It owns:
 *
 *   kit_street.js  lamps, signals, signs, meters, hydrants, bins, benches,
 *                  shelters, bollards, phone boxes, newsboxes, hatches, stoops
 *   wires.js       the overhead network — poles, catenary spans, transformers,
 *                  insulators, service drops, guys, trolley wire
 *   kit_green.js   street trees, park planting, scrub, ivy, weeds, verges
 *   kit_sign.js    fascias, blade signs, neon, awnings, menu boards, A-boards,
 *                  posters, aerosol, ghost signs on brick gables
 *   kit_junk.js    sacks, pallets, crates, cones, roadworks, scaffolding,
 *                  skips, puddles, drains, chained bikes, condensers
 *   layout.js      where all of it goes, and why no two of them are alike
 *   batch.js       how a tile of eight hundred props becomes ~25 draw calls
 *
 * STREAMING. Built on `world:tile:load`, freed on `world:tile:unload`, every
 * job pushed through `world.schedule()` so `world.streamingIdle()` — which the
 * capture harness blocks on — can see the work. A tile is built a couple of
 * road edges at a time so no single job can blow `q.tileBuildBudgetMs`.
 *
 * LIGHT. Sodium and neon are emissive materials plus bloom, driven off the sun
 * altitude once per change. A downtown block carries hundreds of lamps and
 * `q.lightSlots` is eight; a punctual light per lamp would recompile every lit
 * material in the scene the moment one crossed its cull radius (see
 * ARCHITECTURE.md, "the point-light count is a shader permutation key").
 */

const SODIUM_LIGHT = new THREE.Color(SODIUM);

export class PropSystem {
  static id = 'props';
  static deps = ['materials', 'render', 'world'];

  async init(ctx) {
    this.ctx = ctx;
    this.materials = ctx.get('materials');
    this.world = ctx.peek('world');
    this.render = ctx.peek('render');
    this.physics = ctx.peek('physics');
    this.rng = ctx.rng.fork();

    this.root = new THREE.Group();
    this.root.name = 'props';
    this.root.matrixAutoUpdate = false;
    ctx.scene.add(this.root);

    const t0 = performance.now();
    this.lib = new ProtoLibrary(this.materials);
    registerStreetKit(this.lib);
    registerWireKit(this.lib);
    registerGreen(this.lib);
    registerSignKit(this.lib);
    registerJunkKit(this.lib);
    const ls = this.lib.stats();

    this.layout = new Layout({
      world: this.world, lib: this.lib, peek: (id) => ctx.peek(id), q: ctx.config.q,
    });
    this.layout.setDecalGlyphs(this._probeWorldDecals());

    const q = ctx.config.q;
    /**
     * Two prop horizons. Inside `nearRadius` a tile gets the whole kit; out to
     * `midRadius` it gets the skeleton (lamps, trees, poles and wire), which is
     * what stops a boulevard of trees popping into existence 190 m ahead of the
     * car. Beyond that, nothing: `buildings` L1 and the road network carry it.
     *
     * These are draw-call budgets as much as distances. A full tile costs ~40
     * draws and a skeleton tile ~7, so 8 near + 30 mid is ~540 — which is what
     * the frame can afford now that draw calls are the binding cost.
     */
    this.nearRadius = q.streamRadius >= 700 ? 195 : q.streamRadius >= 450 ? 175 : 140;
    this.midRadius = Math.min(q.streamRadius ?? 520, this.nearRadius + 230);
    this.parkedBudget = Math.max(6, Math.round((q.trafficBudget ?? 26) * 0.7));

    this.tiles = new Map();
    this._pending = 0;
    this._camXZ = new THREE.Vector3();
    this._colDirty = false;
    this._colTimer = 0;
    this._litMix = -1;
    this._promoteTimer = 0;
    this._parkTimer = 0;
    this._parked = [];
    this._wallQ = [];
    this._wallGuard = false;
    this.stats = {
      tiles: 0, near: 0, draws: 0, instances: 0, tris: 0, instTris: 0,
      protos: ls.protos, protoTris: ls.tris, parked: 0,
    };

    this._onLoad = (e) => this._tileLoad(e);
    this._onUnload = (e) => this._tileUnload(e);
    ctx.events.on('world:tile:load', this._onLoad);
    ctx.events.on('world:tile:unload', this._onUnload);

    console.info(
      `[props] kit ready — ${ls.protos} prototypes, ${(ls.tris / 1000).toFixed(1)}k prototype tris, ` +
        `${Object.keys(SURFACES).length} surfaces + ${Object.keys(EMISSIVE).length} emissives ` +
        `(${(performance.now() - t0).toFixed(0)}ms)`
    );
  }

  /**
   * Ask `world` what it already paints on the road so the decal layer does not
   * lay the same glyph twice. `world/roadmesh.js` draws lane lines, dashes,
   * double yellows, zebra crossings, stop bars, gully gratings, manhole covers
   * and cut-and-fill patches; whatever is left over is ours. This reads the
   * live palette rather than trusting a copy of it.
   */
  _probeWorldDecals() {
    const used = new Set();
    const pal = this.world?.roadMesh?.palette ?? this.world?.palette ?? null;
    if (pal) {
      for (const k in pal) {
        const n = pal[k]?.name;
        if (typeof n === 'string') used.add(n);
      }
    }
    const free = (name) => (pal ? !used.has(name) : true);
    const glyphs = {
      arrow: free('road_arrow'),
      arrowTurn: free('road_arrow_turn'),
      hatch: free('road_hatch'),
      yellow: free('road_line_yellow'),
      // The bay ticks are a short cross-stroke `world` never draws, so the
      // plain line surface is safe to share — sharing the MATERIAL is good, it
      // is drawing the same MARKING twice that is the defect.
      bay: true,
    };
    if (pal) {
      const mine = Object.entries(glyphs).filter(([, v]) => v).map(([k]) => k).join(', ');
      console.info(`[props] road decals — world owns ${used.size} surfaces; props adds ${mine}`);
    }
    return glyphs;
  }

  /* ==================================================================== */
  /* streaming                                                            */
  /* ==================================================================== */

  schedule(fn, priority = 4) {
    const w = this.world;
    this._pending++;
    const wrapped = () => {
      this._pending--;
      fn();
    };
    if (typeof w?.schedule === 'function') w.schedule(wrapped, priority);
    else (this._local ??= []).push(wrapped);
  }

  pendingJobs() {
    return this._pending;
  }

  /** Mirrors `world.streamingIdle()`: false while any prop work is queued. */
  streamingIdle() {
    return this._pending === 0 && this._wallQ.length === 0;
  }

  _key(tx, tz) {
    return `${tx},${tz}`;
  }

  _lodFor(tx, tz) {
    const cam = this._camXZ;
    const cx = (tx + 0.5) * 128;
    const cz = (tz + 0.5) * 128;
    const d = Math.hypot(cx - cam.x, cz - cam.z);
    if (d <= this.nearRadius) return 0;
    if (d <= this.midRadius) return 1;
    return 2;
  }

  _tileLoad({ tx, tz, lots, bounds }) {
    const key = this._key(tx, tz);
    if (this.tiles.has(key)) return;
    const bx = bounds
      ? { x0: bounds.min.x, z0: bounds.min.z, x1: bounds.max.x, z1: bounds.max.z }
      : { x0: tx * 128, z0: tz * 128, x1: (tx + 1) * 128, z1: (tz + 1) * 128 };
    const rec = {
      key, tx, tz, bx, lots: lots ?? [], lod: this._lodFor(tx, tz),
      alive: true, group: null, meshes: null, colliders: null, batch: null,
      handles: [], parked: [], parkedCars: [], built: false, stats: null, cullOff: null,
      lamps: null, wall: [],
    };
    this.tiles.set(key, rec);
    if (rec.lod >= 2) return; // beyond the prop horizon; nothing to build
    this._queueBuild(rec);
  }

  _queueBuild(rec) {
    const pri = rec.lod === 0 ? 3 : 6;
    const batch = new TileBatch(this.lib, `p${rec.tx}_${rec.tz}`);
    rec.batch = batch;
    const layout = this.layout;
    const roads = this.world.roads;

    this.schedule(() => {
      if (!rec.alive) return;
      const edges = [];
      roads.edgesInRect(rec.bx.x0 - 40, rec.bx.z0 - 40, rec.bx.x1 + 40, rec.bx.z1 + 40, edges);
      // One job per few edges: an edge is a fraction of a millisecond, a whole
      // tile is not, and rule 8 is a per-frame budget.
      const CH = rec.lod === 0 ? 2 : 6;
      for (let i = 0; i < edges.length; i += CH) {
        const slice = edges.slice(i, i + CH);
        this.schedule(() => {
          if (!rec.alive) return;
          for (const e of slice) {
            if (e.rail) continue;
            try {
              layout._edgeFurniture(batch, e, rec.bx, rec.lod, rec.parked);
              layout._edgeWires(batch, e, rec.bx, rec.lod);
              if (rec.lod === 0) layout._edgeDecals(batch, e, rec.bx);
            } catch (err) {
              console.error('[props] edge dressing failed', err);
            }
          }
        }, pri);
      }
      const lots = rec.lots;
      for (let i = 0; i < lots.length; i += 4) {
        const slice = lots.slice(i, i + 4);
        this.schedule(() => {
          if (!rec.alive) return;
          for (const l of slice) {
            try {
              layout._lot(batch, l, rec.bx, rec.lod, this.rng, rec.parked, rec.wall);
            } catch (err) {
              console.error('[props] lot dressing failed', err);
            }
          }
        }, pri);
      }
      if (rec.lod === 0) {
        this.schedule(() => {
          if (!rec.alive) return;
          try {
            layout._wasteGround(batch, rec.bx, rec.lots, this.rng);
          } catch (err) {
            console.error('[props] waste ground failed', err);
          }
        }, pri);
      }
      /**
       * A tile whose lots carry wall-mounted dressing cannot be assembled yet:
       * that dressing raycasts at the wall to find out where the wall IS, and
       * this tile's own buildings are still sitting in the static-collision
       * queue. Hand the half-filled batch to the wall pass, which finishes it
       * once the BVH is current.
       *
       * It goes into the SAME batch deliberately. An earlier cut built the wall
       * dressing into a second `TileBatch` bolted onto the same group, which
       * works but splits every shared surface — fascia board, panel, awning,
       * neon, poster — into two merged meshes and cost +300 draw calls and
       * 2.3 fps across the frame. One batch, built late, costs nothing.
       */
      this.schedule(() => {
        if (!rec.alive) return;
        if (rec.wall.length) this._wallQ.push(rec);
        else this._finishTile(rec);
      }, pri);
    }, pri);
  }

  _finishTile(rec) {
    if (!rec.alive || !rec.batch) return;
    const group = new THREE.Group();
    group.name = `props_${rec.tx}_${rec.tz}`;
    group.matrixAutoUpdate = false;
    this.root.add(group);
    const cx0 = (rec.bx.x0 + rec.bx.x1) * 0.5;
    const cz0 = (rec.bx.z0 + rec.bx.z1) * 0.5;
    const out = rec.batch.build(group, {
      // The skeleton tier carries no detail layer at all, so it needs no LOD.
      lod: rec.lod === 0,
      center: new THREE.Vector3(cx0, (this.world.heightAt?.(cx0, cz0) ?? 0) + 2, cz0),
    });
    rec.group = group;
    rec.meshes = out.meshes;
    rec.colliders = out.colliders;
    rec.lodNode = out.lod;
    rec.lamps = out.lamps ?? [];
    rec.built = true;
    rec.stats = { ...out.stats };
    rec.batch = null;
    this.render?.patchMaterials?.(group);

    /**
     * HIERARCHICAL CULLING. Props are the densest instanced population in the
     * city, so one bounding-sphere test per tile instead of a per-object scene
     * walk is the single biggest thing this subsystem can do for the frame.
     * The sphere has to be generous vertically: a tile carries 10 m lamp
     * columns, 12 m utility poles and signs three storeys up.
     */
    const cx = cx0;
    const cz = cz0;
    const cy = (this.world.heightAt?.(cx, cz) ?? 0) + 8;
    rec.cullOff = this.render?.registerCullGroup?.(group, {
      center: [cx, cy, cz],
      radius: 128 * 0.72 + 14,
      // A skeleton tile is only lamps, trees and wires; there is no point
      // drawing it past the mid radius even if the far plane would allow it.
      maxDistance: rec.lod === 0 ? 0 : this.midRadius + 90,
    }) ?? null;

    // Nothing in this kit moves, so none of it needs per-frame velocity
    // bookkeeping (ARCHITECTURE.md render integration).
    for (const m of out.meshes) m.userData.owStatic = true;

    if (rec.lod === 0 && this.physics?.addStatic) {
      for (const c of out.colliders) {
        group.add(c.mesh);
        rec.handles.push(this.physics.addStatic(c.mesh, c.tag));
      }
      if (out.colliders.length) this._colDirty = true;
    }
    this._recount();
  }

  /* ==================================================================== */
  /* deferred wall pass                                                   */
  /* ==================================================================== */

  /**
   * Build the wall-mounted dressing for queued tiles, now that `physics` can
   * answer "where is the wall". Budgeted like any other build job.
   *
   * This is the fix for the defect that put ghost signs, ivy, flyposting and
   * aerosol in mid-air wherever `buildings` inset its ground volume and buried
   * them in brick wherever it did not — the layout solver only ever had the LOT
   * FOOTPRINT to go on, and the footprint is not the building.
   */
  _drainWalls(budgetMs, tileBudget = 0) {
    const counted = tileBudget > 0;
    const t0 = performance.now();
    let ran = 0;
    while (this._wallQ.length && (counted ? ran < tileBudget : performance.now() - t0 < budgetMs)) {
      ran++;
      const rec = this._wallQ.shift();
      if (!rec.alive || !rec.batch) continue;
      for (const lot of rec.wall) {
        try {
          this.layout.lotWalls(rec.batch, lot, rec.bx);
        } catch (err) {
          console.error('[props] wall dressing failed', err);
        }
      }
      rec.wall.length = 0;
      this._finishTile(rec);
    }
  }

  /**
   * Hold `world`'s build queue open while wall work is outstanding, so
   * `streamingIdle()` — which is what `tools/capture.mjs` blocks the shutter on
   * — cannot report a settled city that is still missing every shopfront. One
   * job per frame at most: the queue drains within a frame, so re-arming from
   * inside the job itself would spin on the frame's whole build budget.
   */
  _armWallGuard() {
    if (this._wallGuard) return;
    this._wallGuard = true;
    this.schedule(() => {
      this._wallGuard = false;
    }, 9);
  }

  _tileUnload({ tx, tz }) {
    const key = this._key(tx, tz);
    const rec = this.tiles.get(key);
    if (!rec) return;
    rec.alive = false;
    this.tiles.delete(key);
    this._freeTile(rec);
  }

  _freeTile(rec) {
    const wq = this._wallQ.indexOf(rec);
    if (wq >= 0) this._wallQ.splice(wq, 1);
    rec.wall.length = 0;
    if (rec.cullOff) {
      rec.cullOff();
      rec.cullOff = null;
    } else if (rec.group) {
      this.render?.unregisterCullGroup?.(rec.group);
    }
    for (const h of rec.handles) this.physics?.removeStatic?.(h);
    if (rec.handles.length) this._colDirty = true;
    rec.handles.length = 0;
    if (rec.meshes || rec.colliders) releaseTile(rec);
    rec.lodNode?.parent?.remove(rec.lodNode);
    rec.lodNode = null;
    rec.group?.parent?.remove(rec.group);
    rec.group = null;
    rec.batch = null;
    const veh = this._veh();
    for (const v of rec.parkedCars) {
      const i = this._parked.indexOf(v);
      if (i >= 0) this._parked.splice(i, 1);
      veh?.despawn?.(v);
    }
    rec.parkedCars.length = 0;
    this._recount();
  }

  _recount() {
    let draws = 0;
    let inst = 0;
    let tris = 0;
    let instTris = 0;
    let near = 0;
    for (const r of this.tiles.values()) {
      if (!r.stats) continue;
      draws += r.stats.draws;
      inst += r.stats.instances;
      tris += r.stats.tris;
      instTris += r.stats.instTris;
      if (r.lod === 0) near++;
    }
    this.stats.tiles = this.tiles.size;
    this.stats.near = near;
    this.stats.draws = draws;
    this.stats.instances = inst;
    this.stats.tris = tris;
    this.stats.instTris = instTris;
  }

  /* ==================================================================== */
  /* per frame                                                            */
  /* ==================================================================== */

  update(dt, ctx) {
    ctx.camera.getWorldPosition(this._camXZ);
    this._driveLights(ctx);

    if (this._local?.length) {
      // Fallback queue: only ever used when `world` has no scheduler. Budgeted
      // in jobs under `deterministic`, in milliseconds in play.
      if (detBuild(ctx)) {
        for (let i = 0; i < DET_LOCAL_JOBS_PER_FRAME && this._local.length; i++) this._local.shift()();
      } else {
        const t0 = performance.now();
        const budget = ctx.config.q.tileBuildBudgetMs ?? 5;
        while (this._local.length && performance.now() - t0 < budget) this._local.shift()();
      }
    }

    // Promote a tile the camera has walked into, one at a time so the rebuild
    // never lands as a spike.
    this._promoteTimer += dt;
    if (this._promoteTimer > 0.45 && this._pending === 0) {
      this._promoteTimer = 0;
      for (const rec of this.tiles.values()) {
        const want = this._lodFor(rec.tx, rec.tz);
        if (want < rec.lod && want < 2 && rec.built) {
          this._freeTile(rec);
          rec.lod = want;
          rec.built = false;
          rec.stats = null;
          rec.parked.length = 0;
          this._queueBuild(rec);
          break;
        }
      }
    }

    this._submitLamps(ctx);

    this._parkTimer += dt;
    if (this._parkTimer > 0.35) {
      this._parkTimer = 0;
      this._driveParked();
    }

    // RECONCILE. `world` queues its `tile:load` emit but fires `tile:unload`
    // immediately, so a tile that is dropped while its load job is still in the
    // queue arrives AFTER its own unload and would never be freed. Rather than
    // reach into `world`'s private ring, sweep by distance: anything well
    // outside the stream radius cannot be wanted.
    this._reconcileTimer = (this._reconcileTimer ?? 0) + dt;
    if (this._reconcileTimer > 1.0) {
      this._reconcileTimer = 0;
      const far = (ctx.config.q.streamRadius ?? 520) + 260;
      for (const [key, rec] of this.tiles) {
        const dx = (rec.tx + 0.5) * 128 - this._camXZ.x;
        const dz = (rec.tz + 0.5) * 128 - this._camXZ.z;
        if (dx * dx + dz * dz > far * far) {
          rec.alive = false;
          this.tiles.delete(key);
          this._freeTile(rec);
        }
      }
    }

    /**
     * STATIC COLLISION, then the wall pass. The order matters: a wall raycast
     * against a BVH that has not absorbed this tile's buildings answers "there
     * is no wall here" and the dressing is dropped. `staticWorld.dirty` is set
     * by whoever added geometry — us, `buildings` or `world` — and cleared by
     * the rebuild, so it is the honest test for "is a query current".
     */
    // `physics` is not in our deps, so at init() it may not exist yet. The wall
    // pass depends on it, so keep asking until it does.
    if (!this.physics) this.physics = ctx.peek('physics') ?? null;
    this._colTimer += dt;
    const stale = this.physics?.staticWorld?.dirty === true;
    if ((this._colDirty || (this._wallQ.length && stale)) && this._colTimer > 0.4) {
      this._colTimer = 0;
      this._colDirty = false;
      this.physics?.rebuildStatic?.();
    }
    if (this._wallQ.length) {
      if (this.physics?.staticWorld?.dirty !== true) {
        this._drainWalls(
          ctx.config.q.tileBuildBudgetMs ?? 5,
          detBuild(ctx) ? DET_WALL_TILES_PER_FRAME : 0
        );
      }
      if (this._wallQ.length) this._armWallGuard();
    }
  }

  /**
   * Sodium and neon. One material write per change drives every lamp, sign and
   * shopfront in the city.
   */
  _driveLights(ctx) {
    const sky = this._sky ?? (this._sky = ctx.peek('sky'));
    const alt = sky?.sunAltitude ?? 0.4;
    const mix = 1 - Math.min(1, Math.max(0, (alt + 0.05) / 0.19));
    if (Math.abs(mix - this._litMix) < 0.015) return;
    this._litMix = mix;
    for (const m of this.lib.emissiveList) {
      const d = m.userData.owEmissive;
      if (!d) continue;
      if (d.additive) {
        // The pool on the road: nothing at all by day, a hint at midnight.
        m.opacity = (d.peak ?? 0.055) * mix * mix;
        m.visible = mix > 0.08;
      } else {
        m.emissiveIntensity = d.base + d.night * mix;
        if (d.nightOnly) m.visible = mix > 0.12;
      }
    }
  }

  /**
   * THE TWO OR THREE NEAREST LAMPS ARE REAL LIGHTS.
   *
   * Every other lamp in the city is emissive plus bloom, which is the only way
   * a night city fits inside `q.lightSlots`. But an emissive lens cannot put a
   * pool on the road, and "wet asphalt that mirrors the sodium lamps" is the
   * money shot in DESIGN.md. `render.submitLight` scores requests into a FIXED
   * pool every frame, so this cannot move the visible-light count and cannot
   * trigger the shader-permutation recompile that a per-lamp PointLight would.
   *
   * Each submission is keyed by the LAMP'S IDENTITY (tile key + index in that
   * tile's lamp list), never by its rank in the pick. Rank is a property of
   * the camera: keying by it meant a reshuffle moved the rank-key's POSITION
   * to a different lamp with no key change, so the slot never saw a handover
   * and the sodium pool teleported instead of crossfading. With a stable key,
   * a handover is a genuine key change and rides the renderer's ~0.15 s fade.
   * `src/props/lampprobe.mjs` measures this on pixels; `?owLampRankKey=1` is
   * its negative control.
   */
  _submitLamps(ctx) {
    const r = this.render;
    if (!r?.submitLight) return;
    if (this._litMix < 0.10) return;
    const cam = this._camXZ;
    const pick = (this._lampPick ??= []);
    pick.length = 0;
    const R2 = 46 * 46;
    for (const rec of this.tiles.values()) {
      if (rec.lod !== 0 || !rec.lamps) continue;
      for (let j = 0; j < rec.lamps.length; j++) {
        const l = rec.lamps[j];
        const x = l.x + Math.cos(l.yaw) * l.r;
        const z = l.z + Math.sin(l.yaw) * l.r;
        const dx = x - cam.x;
        const dz = z - cam.z;
        const d2 = dx * dx + dz * dz;
        if (d2 > R2) continue;
        pick.push({ d2, x, y: l.y, z, key: l.key ?? (l.key = `lamp:${rec.key}:${j}`) });
      }
    }
    if (!pick.length) return;
    pick.sort((a, b) => a.d2 - b.d2);
    const n = Math.min(3, pick.length);
    for (let i = 0; i < n; i++) {
      const p = pick[i];
      r.submitLight(p.x, p.y, p.z, SODIUM_LIGHT, 46 * this._litMix, 26, 2,
        LAMP_RANK_KEY ? 9000 + i : p.key);
    }
  }

  /* ==================================================================== */
  /* parked cars — `vehicles` owns the mesh, we own the kerb              */
  /* ==================================================================== */

  _veh() {
    if (this._vehSys === undefined) this._vehSys = this.ctx.peek('vehicles') ?? null;
    return this._vehSys;
  }

  /**
   * Duck-typed by `traffic` (see `traffic/index.js` `propsHasParking`) so the
   * two systems never place a bay in the same three metres of kerb. It is a
   * PURE function of the edge — no state to go stale as tiles stream — and it
   * answers the same question the layout solver asks itself.
   */
  parkedOnEdge(edgeId, side) {
    const e = this.world?.roads?.edges?.[edgeId];
    if (!e) return false;
    try {
      return this.layout.parksOn(e, side);
    } catch {
      return false;
    }
  }

  /**
   * An empty kerb reads as a film set, so every street gets cars standing on
   * it. `props` never builds a car — it asks `vehicles` for one and hands it a
   * pose off the kerb line, exactly as the layout solver computed it.
   */
  _driveParked() {
    const veh = this._veh();
    if (!veh?.spawn) return;
    const cam = this._camXZ;
    const R = Math.min(this.nearRadius, 165);
    const R2 = R * R;

    for (let i = this._parked.length - 1; i >= 0; i--) {
      const v = this._parked[i];
      const p = v.position ?? v.model?.root?.position;
      if (!p) continue;
      const d2 = (p.x - cam.x) ** 2 + (p.z - cam.z) ** 2;
      if (d2 > (R * 1.55) ** 2) {
        this._parked.splice(i, 1);
        const rec = v.userData?.owPropTile;
        if (rec) {
          const k = rec.parkedCars.indexOf(v);
          if (k >= 0) rec.parkedCars.splice(k, 1);
          const slot = v.userData.owPropSlot;
          if (slot) slot.used = false;
        }
        veh.despawn(v);
      }
    }
    if (this._parked.length >= this.parkedBudget) {
      this.stats.parked = this._parked.length;
      return;
    }

    let spawned = 0;
    for (const rec of this.tiles.values()) {
      if (rec.lod !== 0 || !rec.built) continue;
      for (const slot of rec.parked) {
        if (slot.used) continue;
        const d2 = (slot.x - cam.x) ** 2 + (slot.z - cam.z) ** 2;
        // Never materialise a two-tonne static object on top of the player:
        // `vehicles.nearest` sees cars, not a pedestrian, and the camera is the
        // one place we know somebody is standing.
        if (d2 > R2 || d2 < 144) continue;
        const type = slot.type ?? 'sedan';
        const spec = veh.specOf?.(type);
        const y = slot.y + (spec?.comY ?? 0.6) + 0.02;
        /**
         * IS THE SLOT ACTUALLY EMPTY? A bay sits alongside a live lane, and a
         * driver that has drifted wide, one pulling out of a `traffic` bay, or
         * the player kerbing it, is standing in that space right now. The first
         * pass never asked and materialised a static car inside a moving one —
         * an instant heavy impact, and a measurable share of the ~200 per
         * simulated minute the fleet was recording.
         */
        const clear = (spec?.dims?.L ?? 4.8) * 0.5 + 1.5;
        if (veh.nearest?.(slot.x, y, slot.z, clear)) continue;
        slot.used = true;
        let v = null;
        try {
          v = veh.spawn(type, new THREE.Vector3(slot.x, y, slot.z), slot.yaw, {
            parked: true, rng: this.rng,
          });
        } catch (err) {
          console.error('[props] parked spawn failed', err);
        }
        if (!v) {
          slot.used = false;
          continue;
        }
        v.userData = v.userData ?? {};
        v.userData.owPropTile = rec;
        v.userData.owPropSlot = slot;
        v.userData.owParked = true;
        rec.parkedCars.push(v);
        this._parked.push(v);
        if (++spawned >= 2 || this._parked.length >= this.parkedBudget) break;
      }
      if (spawned >= 2 || this._parked.length >= this.parkedBudget) break;
    }
    this.stats.parked = this._parked.length;
  }

  /**
   * DEV: lay every prototype out on a grid so the whole kit can be reviewed in
   * one frame. `node tools/capture.mjs` cannot see inside a prototype, and a
   * geometry error on a 40 cm object is invisible from the street until it is
   * multiplied by four hundred instances. Returns the board's bounds.
   */
  debugBoard(origin = { x: 0, y: 0, z: 0 }, opts = {}) {
    const spacing = opts.spacing ?? 4.5;
    const cols = opts.columns ?? 20;
    if (this._board) {
      this._board.parent?.remove(this._board);
      this._board = null;
    }
    const g = new THREE.Group();
    g.name = 'props_debug_board';
    const ids = [...this.lib.protos.keys()].filter((k) => !opts.filter || k.includes(opts.filter));
    const batch = new TileBatch(this.lib, 'board');
    ids.forEach((id, i) => {
      const x = origin.x + (i % cols) * spacing;
      const z = origin.z + Math.floor(i / cols) * spacing;
      batch.put(id, new THREE.Matrix4().setPosition(x, origin.y, z), [0.7, 0.7, 0.5]);
    });
    // Force everything into merged batches so nothing is hidden by instancing.
    const out = batch.build(g);
    this.root.add(g);
    this._board = g;
    this.render?.patchMaterials?.(g);
    return {
      count: ids.length,
      cols,
      rows: Math.ceil(ids.length / cols),
      spacing,
      ids,
      x0: origin.x, z0: origin.z,
      x1: origin.x + cols * spacing,
      z1: origin.z + Math.ceil(ids.length / cols) * spacing,
    };
  }

  /* ==================================================================== */
  /* pre-warm                                                             */
  /* ==================================================================== */

  /**
   * Compile every program this subsystem can produce before the first frame.
   * Both mesh forms matter: `USE_INSTANCING` is a permutation key, so a surface
   * warmed only as a merged Mesh still costs a compile the first time it
   * appears as an InstancedMesh.
   */
  async prewarmMaterials(ctx = this.ctx) {
    const render = ctx.peek?.('render') ?? ctx.get?.('render');
    const renderer = render?.renderer;
    if (!renderer) return { ok: false, reason: 'no renderer' };
    const before = renderer.info.programs?.length ?? 0;
    const t0 = performance.now();

    const probe = new THREE.Group();
    probe.name = 'props_prewarm';
    probe.position.set(0, -3000, 0);
    const geo = new THREE.PlaneGeometry(1, 1);
    geo.setAttribute('color', new THREE.Float32BufferAttribute(
      new Float32Array(geo.getAttribute('position').count * 3).fill(0.5), 3));

    const keys = [...Object.keys(SURFACES), ...Object.keys(EMISSIVE)];
    const instanced = [];
    for (const k of keys) {
      let mat = null;
      try {
        mat = this.lib.matFor(k);
      } catch (err) {
        console.warn('[props] prewarm surface failed', k, err);
      }
      if (!mat) continue;
      probe.add(new THREE.Mesh(geo, mat));
      // BOTH instanced flavours. `instancing` and `instancingColor` are separate
      // bits of three's program cache key, and this loop used to build only the
      // with-colour one — so every surface that streams in as a plain
      // InstancedMesh (no per-instance tint) still compiled during play.
      for (const withColor of NO_WARM_FIX ? [true] : [false, true]) {
        const im = new THREE.InstancedMesh(geo, mat, 1);
        im.setMatrixAt(0, new THREE.Matrix4());
        im.instanceMatrix.needsUpdate = true;
        if (withColor) {
          im.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array([1, 1, 1]), 3);
        }
        im.frustumCulled = false;
        probe.add(im);
        instanced.push(im);
      }
    }
    this.root.add(probe);
    render.patchMaterials?.(this.root);

    const scene = ctx.scene;
    const camera = ctx.camera;
    const prev = scene.overrideMaterial;
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
      scene.overrideMaterial = prev;
      for (const im of instanced) im.dispose();
      probe.parent?.remove(probe);
      geo.dispose();
    }
    return {
      ok: true,
      ms: Math.round(performance.now() - t0),
      compiled: (renderer.info.programs?.length ?? 0) - before,
      surfaces: keys.length,
    };
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
    this.ctx?.events?.off?.('world:tile:load', this._onLoad);
    this.ctx?.events?.off?.('world:tile:unload', this._onUnload);
    for (const rec of this.tiles.values()) {
      rec.alive = false;
      this._freeTile(rec);
    }
    this.tiles.clear();
    this.lib?.dispose();
    this.root?.parent?.remove(this.root);
    this.root = null;
  }
}

export default PropSystem;
