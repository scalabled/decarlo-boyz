/**
 * PEDS — pedestrian crowds for Steel City.
 *
 * WHAT LIVES WHERE
 *   rig.js        25-bone civilian skeleton, relaxed bind pose, ragdoll spec
 *   geo.js        loft/tube/ribbon toolkit, skin binder, baked vertex shading
 *   parts.js      bodies and clothes: coats, sleeves, trousers, skirts, hair,
 *                 hands with real fingers, shoes, hats, bags, umbrellas
 *   materials.js  three baked PBR sets + the twelve-slot palette shader
 *   wardrobe.js   the silhouettes, the district archetypes, one person's draw
 *   builder.js    outfit -> one shared skinned geometry
 *   clips.js      hand-authored pose layers, all parameterised per person
 *   animator.js   layered blending + look-at and foot IK
 *   nav.js        sidewalks derived from world.roads, crossings, crowd grid
 *   ped.js        one pedestrian: state machine, reactions, ragdoll death
 *   crowdfx.js    contact shadows, the far-LOD capsule crowd, carried props
 *   crew.js       THE CREW — the two brothers who follow, fight and talk
 *   hostile.js    MISSION ENEMIES — a ped with a brain and a physics capsule
 *
 * THE GATES. Five numeric probes, in the style of
 * `src/player/character/headprobe.mjs`. Run them before handing work back; the
 * first two need no browser and take seconds.
 *
 *   node src/peds/crowdprobe.mjs    what a pedestrian IS: area-weighted albedo
 *                                   off the emitted geometry, darkest garment,
 *                                   top/bottom contrast, silhouette and hue
 *                                   variety. Offline.
 *   node src/peds/gaitprobe.mjs     does a planted foot stay planted: drives
 *                                   the real animator over the real rig and
 *                                   measures world-space foot slide, stance
 *                                   duty, stride reach and toe clearance.
 *                                   Offline.
 *   node src/peds/streetprobe.mjs   the same questions in the running game,
 *                                   plus crowd density, spacing and pavement
 *                                   use, per shot.
 *   node src/peds/lightprobe.mjs    sweeps the engine's indirect budget and
 *                                   checks a pedestrian's radiance tracks the
 *                                   pavement's. This is the one that proved
 *                                   the "black blob" was a surface problem and
 *                                   not a lighting one.
 *   node src/peds/coverprobe.mjs    CAN YOU TAKE COVER FROM A MISSION GOON:
 *                                   spawns one across a building whose footprint
 *                                   is rasterised off the DRAWN mesh (never off
 *                                   the collider he resolves against) and
 *                                   asserts his path never enters it and never
 *                                   leaves the ground band. Has a negative
 *                                   control, `--legacy`.
 *
 * PUBLIC API — `const peds = ctx.get('peds')`
 *   peds.nearest(x, y, z, radius)          nearest live ped, for melee/carjack
 *   peds.panic(position, radius, severity) scare everyone in a radius
 *   peds.pullFromVehicle(vehicle, point)   drag the driver out — `player` calls this
 *   peds.driverOf(vehicle)                 who is behind the wheel
 *   peds.debugStage('crowd'|'firefight'|'panic'|'none')
 *   peds.prewarmMaterials(ctx)
 *   peds.stats                             { live, bodies, far, target, ms }
 *
 * THE CREW — `game` and `player` drive the companions through these:
 *   peds.spawnCrew(ids?)          the two brothers you are NOT playing, by
 *                                 default; pass ids to override
 *   peds.despawnCrew()
 *   peds.crewState()              [{id,name,colour,x,z,up,hp,maxHp,inCar,…}]
 *                                 REUSED array — for the minimap and the HUD
 *   peds.crewAlive()              ids of the brothers on their feet
 *   peds.setCrewGuard(id, x, z)   pin one in place; (id, null) releases
 *   peds.setCrewWard(id, opts)    designate a `protect` ward (noRevive)
 *   peds.clearCrewWard()
 *   peds.crewSay(id, line)        a scripted line, in his own colour
 *   peds.downCrew(id) / peds.reviveCrew(id)
 *   peds.crew                     the manager, for anything else
 *
 * MISSION HOSTILES — `game/hostiles.js` is an ADAPTER over these:
 *   peds.spawnHostile(position, opts)   `{hp,dmg,ranged,range,speed,scale,tag,leash}`
 *                                       returns the `Ped`; that IS the handle
 *   peds.despawnHostile(ped)
 *   peds.clearHostiles()
 *   peds.hurtHostile(ped, amount, headshot?, point?)
 *   peds.hostileCount                   enemies on their feet
 *   peds.hostiles                       the manager (`.live`, `.onKill`,
 *                                       `.targetAlive`, `.kills`)
 *
 * A hostile is a real pedestrian carrying a `physics.createCharacter()` capsule
 * — the ONLY population in this system that resolves its own movement against
 * the world, because it is the only one that walks at you rather than down a
 * pavement. `node src/peds/coverprobe.mjs` is the gate on that. See
 * `hostile.js` for what it replaced and why.
 *
 * EVENTS consumed: weapon:fire, bullet:impact, explosion, damage:dealt,
 *   wanted:heat, time:hour, weather:change, game:character
 * EVENTS emitted: actor:death, damage:dealt (a ped or a brother landing a
 *   hit), vehicle:exit (a driver dragged out), bullet:tracer (a brother
 *   shooting), crew:spawn, crew:down, crew:revive, crew:hurt, crew:board,
 *   crew:exit, crew:line, crew:friendlyfire
 *
 * `crew:friendlyfire` — `{ id, amount }`, raised when a round of the PLAYER'S
 * lands on a brother. The damage is already attenuated when it fires. It is
 * here rather than in ARCHITECTURE.md's table because none of the `crew:*`
 * events are in that table and ARCHITECTURE.md is lead-owned; the whole family
 * wants adding there in one go.
 *
 * ------------------------------------------------------------------------
 * THE BUDGET CONTRACT
 * ------------------------------------------------------------------------
 * `q.pedBudget` bounds the live ambient population (110 on ultra). A hard cap
 * bounds how many of those get a skinned body — everyone else is drawn by the
 * far-LOD capsule crowd in one instanced draw, so the draw-call cost is flat in
 * the population and linear only in the number of people close enough to read.
 *
 * The crew's side of that bargain, in three parts, all gated by
 * `src/peds/crewtest.mjs` (group `roster`):
 *
 *   1. IT PAYS. `_targetPopulation` subtracts `crew.members.length` from the
 *      ambient target, so two brothers are two fewer strangers and a quality
 *      preset means what it says.
 *   2. IT NEVER BORROWS. Companions live in `crew.pool`, a separate array of
 *      at most `CREW_MAX` Peds. `_freePed()` — which is what `attachDriver()`
 *      hands to `traffic` and `police` — only ever scans `this.peds`, so the
 *      crew cannot take a slot a cop needs. This is deliberately the mirror of
 *      the bug `police` had: it borrowed bodies and never gave them back, and
 *      starved `spawnCop`. The crew borrows nothing, so it can starve nothing,
 *      and it therefore needs no give-back path at all.
 *   3. IT KEEPS ITS BODIES. `maxBodies = ambientBodies + CREW_MAX`, so a
 *      brother is never demoted to a far-LOD capsule to make room for a
 *      stranger, and is never streamed or distance-culled.
 */

import * as THREE from 'three';
import { RIG } from './rig.js';
import { PedMaterials, MATERIAL_SLOTS } from './materials.js';
import { buildOutfit } from './builder.js';
import { SHAPE_IDS, SHAPES, makeOutfit, densityAt, archetypeAt } from './wardrobe.js';
import { SidewalkNet, Wander, CrowdGrid, airfieldSpawnBlocked } from './nav.js';
import { Ped, STATE } from './ped.js';
import { GroundShadows, FarCrowd, PropPool } from './crowdfx.js';
import { Crew, CREW_MAX } from './crew.js';
import { PedHostiles, HOSTILE_MAX, HOSTILE_BODIES } from './hostile.js';

const LOD0 = 20;   // full skinned body, foot IK, every frame
const LOD1 = 58;   // skinned body, half rate, no foot IK
const DESPAWN = 145;

/**
 * Minimap blip budget and radius. The radar clamps a contact to its rim, so
 * anything past the radius is drawn in the same place as everything else on
 * that bearing and costs a record for nothing; the cap keeps a riot from
 * pushing the whole crowd through `ui` every frame.
 */
const HUD_BLIP_RADIUS = 140;
const HUD_BLIP_MAX = 24;

export class PedSystem {
  static id = 'peds';
  static deps = ['world', 'physics', 'materials'];

  async init(ctx) {
    this.ctx = ctx;
    this.rng = ctx.rng.fork();
    this.q = ctx.config.q;

    this.root = new THREE.Group();
    this.root.name = 'peds';
    ctx.scene.add(this.root);

    const t0 = performance.now();
    this.materials = new PedMaterials(this.rng.fork(), {
      size: this.q.anisotropy >= 8 ? 512 : 256,
      anisotropy: this.q.anisotropy ?? 8,
    });

    /* ---- population budgets ----
     * `ambientBodies` is the crowd's share of the skinned-body cap. The crew
     * gets CREW_MAX slots of its own on top, because a brother who drops to a
     * capsule the moment a busy street fills the pool is exactly the failure
     * this feature exists to avoid — and two extra skinned bodies is six draw
     * calls out of ~2 400.
     */
    this.budget = Math.max(4, this.q.pedBudget ?? 40);
    this.ambientBodies = Math.max(6, Math.min(38, Math.round(this.budget * 0.36)));
    /**
     * The crew's two slots and the hostiles' ten are ADDED, never taken out of
     * the crowd's share — same bargain, same reason. A goon denied a body
     * because the pavement behind him is busy is the failure the reservation
     * exists to prevent, and ten skinned bodies is thirty draws out of ~2 400.
     * Hostiles past the ten are drawn by the far-LOD capsule crowd in the same
     * instanced draw as everybody else.
     */
    this.maxBodies = this.ambientBodies + CREW_MAX + HOSTILE_BODIES;
    this.lodScale = this.q.lodBias ?? 1;

    /* ---- pools ---- */
    this.peds = [];
    for (let i = 0; i < this.budget; i++) this.peds.push(new Ped(this));
    this.live = [];
    /** Preallocated minimap blip records — see `getHudActors`. */
    this._hudActors = [];
    this._hudActorCount = 0;
    this._free = [];               // idle bodies, any silhouette
    this._all = [];                // every body ever made, for dispose()
    this._variants = new Map();    // shapeId -> built geometry
    this._bodyCount = 0;

    this.net = new SidewalkNet();
    this.grid = new CrowdGrid(4);
    this.ground = new GroundShadows(this.root, this.maxBodies + 8);
    /**
     * A/B switches for the ground-contact pool. Hard rule 12: the only honest
     * way to say what this pool is worth — and the only way to prove the blend
     * fix in `crowdfx.js` is what moved the pixels — is to photograph THE SAME
     * FRAME with it reverted and measure. `?owPedShadowLerp=1` restores the
     * historical alpha-blend-towards-a-constant and changes nothing else;
     * `?owNoPedShadow=1` removes the pool entirely.
     */
    if (typeof location !== 'undefined') {
      const qs = new URLSearchParams(location.search);
      if (qs.has('owNoPedShadow')) this.ground.setMode('off');
      else if (qs.has('owPedShadowLerp')) this.ground.setMode('lerp');
    }
    this.far = new FarCrowd(this.root, this.budget + CREW_MAX + HOSTILE_MAX, this._farMaterial());
    this.props = new PropPool(this.root, Math.max(8, this.maxBodies), this._propMaterials());

    /**
     * Live negative-control hatch for the airfield keep-out (the
     * `debugIgnorePause` pattern). When true, `_spawnNear` stops excluding the
     * runway/apron/field and the perimeter ring — ambient peds flood the
     * airport again. Flipped by `src/peds/airpedprobe.mjs`; never set in play.
     */
    this.debugIgnoreAirfields = false;

    /* ---- the crew: two brothers, their own pool, never streamed ---- */
    this.crew = new Crew(this);
    this.crewAuto = true;          // spawn them as soon as there is a player
    this._crewTimer = 0;

    /* ---- mission hostiles: their own pool, their own capsules ---- */
    this.hostiles = new PedHostiles(this);

    /* ---- scratch: nothing below may allocate per frame ---- */
    this.playerPos = new THREE.Vector3();
    this.hasPlayer = false;
    /** `ctx.time.elapsed` of the player's last shot. See the `weapon:fire`
     *  listener in `_wireEvents` — this is how a round is known to be his. */
    this.playerShotAt = -1e9;
    this._v = new THREE.Vector3();
    this._v2 = new THREE.Vector3();
    this._v3 = new THREE.Vector3();
    /**
     * The explosion listener's private copy of a `grid.query` result. `query`
     * hands back ONE array that it clears and refills on every call, and an
     * explosion kills people, and a death re-enters the grid — see the comment
     * on the `explosion` listener in `_wireEvents`. Filled in place, never
     * resized down, so it costs one growth to the largest crowd ever caught in
     * a blast and nothing afterwards (hard rule 5).
     */
    this._blast = [];
    this._spawnPos = new THREE.Vector3();
    this._link = {};
    this._probe = { y: 0, nx: 0, ny: 1, nz: 0, hit: false };
    this._ground = { surface: 'concrete' };
    this._propOffset = new THREE.Matrix4();
    this._phoneOffset = new THREE.Matrix4().compose(
      new THREE.Vector3(0, 0.085, -0.028),
      new THREE.Quaternion().setFromEuler(new THREE.Euler(-0.35, 0, 0)),
      new THREE.Vector3(1, 1, 1)
    );
    // a cigarette between the first two fingers, pointing away from the palm
    this._cigOffset = new THREE.Matrix4().compose(
      new THREE.Vector3(0.006, 0.108, -0.030),
      new THREE.Quaternion().setFromEuler(new THREE.Euler(-1.15, 0, 0)),
      new THREE.Vector3(1, 1, 1)
    );
    this._cigColour = [0.44, 0.42, 0.38];
    this._umbrellaOffset = new THREE.Matrix4().compose(
      new THREE.Vector3(0, 0.62, 0.02),
      new THREE.Quaternion(),
      new THREE.Vector3(1, 1, 1)
    );
    this._sortBuf = [];
    this._vehBuf = [];
    this._farPhase = new Float32Array(this.budget + CREW_MAX + HOSTILE_MAX);
    this.probeFn = (x, z, fromY, out) => this._probeGround(x, z, fromY, out);

    this.stats = { live: 0, bodies: 0, far: 0, target: 0, ms: 0, shapes: 0, crew: 0, crewMs: 0 };
    this._staged = false;
    this._streamTimer = 0;
    this._netTimer = 0;
    this._hour = 12;
    this._rain = 0;

    /* ---- geometry: every silhouette, once, at boot ----
     * A pedestrian geometry is 3-6k vertices and takes single-digit
     * milliseconds; building all of them here (rather than on the frame a new
     * archetype first walks on screen) is the difference between a smooth
     * street and a 200 ms hitch when the player turns a corner into Steel Row.
     */
    for (const id of SHAPE_IDS) this._variant(id);
    this.stats.shapes = this._variants.size;

    this._wireEvents(ctx);

    let verts = 0;
    let tris = 0;
    for (const v of this._variants.values()) {
      verts += v.stats.vertices;
      tris += v.stats.triangles;
    }
    console.info(
      `[peds] ${this._variants.size} silhouettes · ${(verts / 1000).toFixed(1)}k verts · ` +
        `${(tris / 1000).toFixed(1)}k tris · materials ${this.materials.bakeMs.toFixed(0)}ms · ` +
        `budget ${this.budget} (${this.maxBodies} skinned) · ${(performance.now() - t0).toFixed(0)}ms`
    );
  }

  /* ================================================================== */
  /* assets                                                             */
  /* ================================================================== */

  _variant(shapeId) {
    let v = this._variants.get(shapeId);
    if (!v) {
      v = buildOutfit(shapeId, { rng: this.rng.fork() });
      this._variants.set(shapeId, v);
    }
    return v;
  }

  _farMaterial() {
    const m = new THREE.MeshStandardMaterial({
      color: 0xffffff,
      roughness: 0.86,
      metalness: 0,
      dithering: true,
    });
    m.name = 'ped_far';
    return m;
  }

  _propMaterials() {
    const mk = (name, rough) => {
      const m = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: rough, metalness: 0 });
      m.name = `ped_prop_${name}`;
      return m;
    };
    const phone = mk('phone', 0.24);
    return { phone, umbrella: mk('umbrella', 0.62), cane: mk('cane', 0.5), cig: mk('cig', 0.72) };
  }

  /**
   * One reusable body: a skeleton, a SkinnedMesh, and its own palette uniform
   * plus the three materials that read it.
   *
   * A body is NOT tied to a silhouette. Every outfit shares the same rig and
   * emits its groups in the same material order, so re-pointing `mesh.geometry`
   * is all it takes to turn this body into a different person. Pooling per
   * shape instead fragments: with twenty silhouettes and a cap of thirty-eight
   * bodies, a pedestrian in a hi-vis coat would find the free list full of
   * office workers and silently fall back to the capsule LOD — which is how the
   * first pass ended up unable to ragdoll a ped that was eight metres away.
   */
  _makeBody() {
    const { bones, skeleton, root } = RIG.createSkeleton();
    const palette = this.materials.createPalette();
    const fabric = this.materials.createFabric();
    const set = this.materials.createSet(palette, fabric);
    const mesh = new THREE.SkinnedMesh(this._variant(SHAPE_IDS[0]).geometry, set);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    mesh.frustumCulled = true;
    const group = new THREE.Group();
    group.name = 'ped_body';
    group.add(root);
    group.add(mesh);
    mesh.bind(skeleton);
    group.visible = false;
    this.root.add(group);

    const r = this.ctx.peek('render');
    if (r?.patcher) for (const m of set) r.patcher.patch(m);

    this._bodyCount++;
    return { shapeId: null, group, mesh, bones, skeleton, palette, fabric, materials: set };
  }

  /** Point an existing body at a different silhouette. */
  _retarget(body, shapeId) {
    if (body.shapeId === shapeId) return;
    const v = this._variant(shapeId);
    body.mesh.geometry = v.geometry;
    body.mesh.material = v.materialNames.map((n) => body.materials[MATERIAL_SLOTS.indexOf(n)]);
    body.shapeId = shapeId;
    // What the tallest vertex of THIS silhouette is, bind-pose, hat included.
    // `Ped._resolveSeat` needs it to keep a hat out of a car's headliner.
    body.crown = v.crown ?? 1.752;
  }

  /** Give a ped a skinned body, or return false if the budget is spent. */
  _acquireBody(ped) {
    if (ped.body) return true;
    let body = this._free.pop();
    if (!body) {
      if (this._bodyCount >= this.maxBodies) return false;
      body = this._makeBody();
      this._all.push(body);
    }
    this._retarget(body, ped.outfit.shape);
    // the skeleton may have been left in a ragdoll pose by its last owner
    for (let i = 0; i < body.bones.length; i++) {
      body.bones[i].position.copy(RIG.localPos[i]);
      body.bones[i].quaternion.copy(RIG.localQuat[i]);
      body.bones[i].updateMatrix();
    }
    const pal = body.palette.value;
    const c = ped.outfit.palette;
    for (let i = 0; i < pal.length; i++) pal[i].setRGB(c[i][0], c[i][1], c[i][2]);
    // and what each of those twelve slots is MADE of — see wardrobe.makeFabric
    const fab = body.fabric.value;
    const f = ped.outfit.fabric;
    if (f) for (let i = 0; i < fab.length; i++) fab[i].set(f[i][0], f[i][1], f[i][2], f[i][3]);
    ped.attachBody(body);
    return true;
  }

  _releaseBody(ped) {
    const body = ped.detachBody();
    if (body) this._free.push(body);
  }

  /* ================================================================== */
  /* world queries                                                      */
  /* ================================================================== */

  get world() {
    return this._world ?? (this._world = this.ctx.peek('world'));
  }

  get phys() {
    return this._phys ?? (this._phys = this.ctx.peek('physics'));
  }

  /** Traffic light phase at a junction, or null when traffic has no opinion. */
  lightAt(nodeId) {
    const t = this._traffic ?? (this._traffic = this.ctx.peek('traffic'));
    if (!t || typeof t.lightAt !== 'function' || nodeId === undefined) return null;
    try {
      return t.lightAt(nodeId);
    } catch {
      return null;
    }
  }

  _probeGround(x, z, fromY, out) {
    const phys = this.phys;
    if (!phys) return false;
    const h = phys.raycast(x, fromY, z, 0, -1, 0, 3.0, phys.MASK.WORLD);
    if (!h.hit) return false;
    out.y = h.point.y;
    out.nx = h.normal.x;
    out.ny = h.normal.y;
    out.nz = h.normal.z;
    out.hit = true;
    return true;
  }

  /**
   * Floor height under (x, z). `out.surface` comes back as the physics surface
   * name so callers can refuse to stand on the river — three rivers are a third
   * of this map and a crowd walking on the Monongahela is the single most
   * obvious way this system can embarrass itself.
   */
  groundAt(x, z, fromY = 60, out = this._ground) {
    if (out) out.surface = 'concrete';
    const phys = this.phys;
    if (phys) {
      const h = phys.raycast(x, fromY, z, 0, -1, 0, 140, phys.MASK.WORLD);
      if (h.hit) {
        if (out) out.surface = h.surface;
        return h.point.y;
      }
    }
    const w = this.world;
    const f = w?.heightAt ?? w?.groundHeight;
    if (f) {
      const y = f.call(w, x, z);
      if (Number.isFinite(y)) {
        if (out && w.isWater?.(x, z)) out.surface = 'water';
        return y;
      }
    }
    return 0;
  }

  /** True where a pedestrian must not be: open water. */
  isWaterAt(x, z) {
    const w = this.world;
    if (w?.isWater?.(x, z)) return true;
    if (w?.surfaceAt) {
      try { if (w.surfaceAt(x, z) === 'water') return true; } catch { /* not ready */ }
    }
    this.groundAt(x, z, 80, this._ground);
    return this._ground.surface === 'water';
  }

  _anchor(out) {
    const p = this.ctx.peek('player');
    const src = p?.position ?? p?.capsulePosition ?? null;
    if (src && Number.isFinite(src.x)) {
      out.set(src.x, src.y, src.z);
      this.hasPlayer = true;
      return out;
    }
    out.setFromMatrixPosition(this.ctx.camera.matrixWorld);
    this.hasPlayer = false;
    return out;
  }

  /* ================================================================== */
  /* streaming                                                          */
  /* ================================================================== */

  /**
   * How many people should be on this street, right now. District identity and
   * the clock both matter: the Golden Triangle at one in the afternoon is
   * shoulder to shoulder, an industrial street in Steel Row at four in the
   * morning has one millhand walking to a shift.
   */
  _targetPopulation(anchor) {
    const w = this.world;
    let district = null;
    if (w?.districtAt) {
      try { district = w.districtAt(anchor.x, anchor.z); } catch { district = null; }
    }
    const k = densityAt(this._hour, district);
    const wet = 1 - this._rain * 0.42;       // rain empties a street
    const dens = Math.min(1.4, district?.density ?? 0.7);
    // The crew comes out of `q.pedBudget` — two brothers are two fewer
    // strangers, which is the honest accounting and keeps the promise that a
    // quality preset means what it says.
    const room = Math.max(2, this.budget - this.crew.members.length);
    return Math.min(room, Math.round(this.budget * k * wet * (0.45 + 0.62 * dens)));
  }

  _stream(dt, anchor) {
    if (this._staged) return;
    this._streamTimer -= dt;
    if (this._streamTimer > 0) return;
    this._streamTimer = 0.28;

    // despawn anything that has walked out of the world we care about
    for (let i = 0; i < this.peds.length; i++) {
      const p = this.peds[i];
      if (!p.active) continue;
      const d = Math.hypot(p.position.x - anchor.x, p.position.z - anchor.z);
      if (d > DESPAWN || (!p.alive && p._deadTime > 26) || p._waterTime > 3) {
        this._despawn(p);
      }
    }

    const target = this._targetPopulation(anchor);
    this.stats.target = target;
    let liveCount = 0;
    for (const p of this.peds) if (p.active) liveCount++;
    let want = target - liveCount;
    if (want <= 0) return;
    if (want > 6) want = 6;              // amortise: never a wall of spawns
    for (let i = 0; i < want; i++) this._spawnNear(anchor);
  }

  _spawnNear(anchor) {
    const ped = this._freePed();
    if (!ped) return null;
    const rng = this.rng;

    // Prefer the pavement network. It only exists once `world` has published a
    // road graph, so everything below has a wander fallback.
    let pos = null;
    let link = null;
    const w = this.world;
    if (this.net.ready) {
      link = this.net.sampleLink(rng, anchor, 9, 92, this._link);
      if (link) {
        pos = this.net.pointOn(link.edge, link.side, link.t, this._spawnPos);
      }
    }
    if (!pos) {
      const a = rng.float() * Math.PI * 2;
      const r = 26 + rng.float() * 52;
      pos = this._spawnPos.set(anchor.x + Math.cos(a) * r, anchor.y, anchor.z + Math.sin(a) * r);
      if (w?.isOpen && !w.isOpen(pos.x, pos.z, 0.6)) return null;
    }
    // Never spawn in the middle of a carriageway or in the river if `world`
    // can tell us what the surface is.
    const surf = w?.surfaceAt;
    if (surf) {
      let sf = null;
      try { sf = surf.call(w, pos.x, pos.z); } catch { sf = null; }
      if (sf === 'water') return null;
      if (!link && sf === 'asphalt') return null;
    }
    /**
     * AIRFIELD / AIRBASE keep-out. An airfield is open, restricted ground: no
     * ambient pedestrian on the runway/apron/field, and only a sparse few on
     * the perimeter ring road `netgen` diverts round each field — otherwise
     * the ring's city sidewalks encircle the airport with a crowd. See
     * `airfieldSpawnBlocked` in `nav.js`. Assault guards go through
     * `spawnHostile`, a different path, and are untouched. `debugIgnoreAirfields`
     * is the live negative-control hatch (`src/peds/airpedprobe.mjs`).
     */
    if (!this.debugIgnoreAirfields && airfieldSpawnBlocked(w, pos.x, pos.z, rng)) return null;
    const y = this.groundAt(pos.x, pos.z, anchor.y + 30, this._ground);
    if (!Number.isFinite(y) || y < -400) return null;
    if (this._ground.surface === 'water') return null;
    pos.y = y;
    /**
     * THE HOLE ROUND THE PLAYER.
     *
     * The near limit used to be a flat 22 m on the pavement sampler plus this
     * 14 m rejection, so the only way anyone could be within 22 m of the
     * player was to walk in from outside it. The frame in front of the camera
     * — the only frame anybody ever sees — was therefore the emptiest part of
     * the city, and `streetprobe.mjs` measured the nearest pedestrian in the
     * Lawrenceville street shot at 38 m with 70 people alive.
     *
     * The real constraint was never distance, it is VISIBILITY: a person must
     * not appear out of nothing in shot. So the near limit is now 9 m for a
     * spawn point that is behind the camera or well outside the frame, and the
     * old 22 m for one that is in view. Someone rounding the corner behind you
     * is what fills a pavement.
     */
    const d = Math.hypot(pos.x - anchor.x, pos.z - anchor.z);
    if (d < 9) return null;
    if (d < 24) {
      const cam = this.ctx.camera;
      const f = this._v.set(0, 0, -1).applyQuaternion(cam.quaternion);
      f.y = 0;
      if (f.lengthSq() > 1e-6) {
        f.normalize();
        const ex = pos.x - cam.position.x;
        const ez = pos.z - cam.position.z;
        const len = Math.hypot(ex, ez) || 1;
        // cos 52 degrees: comfortably outside a 60-degree frame's half-angle
        // plus a margin for the chase camera swinging round behind the player.
        if ((ex * f.x + ez * f.z) / len > 0.62) return null;
      }
    }

    let district = null;
    if (w?.districtAt) {
      try { district = w.districtAt(pos.x, pos.z); } catch { district = null; }
    }
    const arch = archetypeAt(rng, this._hour, district);
    const outfit = makeOutfit(rng.fork(), arch, { rain: this._rain });
    const yaw = link ? this.net.headingOf(link) : rng.range(-Math.PI, Math.PI);

    ped.spawn(outfit, pos, yaw, rng.fork());
    ped.wander = ped.wander ?? new Wander();
    ped.lateral = rng.range(-0.55, 0.55);
    if (link) {
      ped.setLink(link);
    } else {
      ped.navMode = 'wander';
      ped.wander.reset(ped.rng, pos, 30);
      ped.wanderTarget = ped.wander.target;
    }
    return ped;
  }

  _freePed() {
    for (let i = 0; i < this.peds.length; i++) if (!this.peds[i].active) return this.peds[i];
    return null;
  }

  _despawn(ped) {
    this._releaseBody(ped);
    ped.despawn();
  }

  /* ================================================================== */
  /* events                                                             */
  /* ================================================================== */

  _wireEvents(ctx) {
    this._off = [];
    const on = (t, fn) => this._off.push(ctx.events.on(t, fn));

    on('time:hour', (e) => { if (e && Number.isFinite(e.hour)) this._hour = e.hour; });
    on('weather:change', (e) => { if (e) this._rain = e.rain ?? 0; });

    // A gunshot in a city street is the loudest thing that will happen all day.
    on('weapon:fire', (e) => {
      if (!e || !e.origin) return;
      /**
       * The timestamp of THE PLAYER'S last trigger pull, and the only thing in
       * the engine that identifies a round as his. `src/weapons` is the
       * player's gun and is the only emitter of `weapon:fire`: `crew.js` says
       * so in `_strike` (raising it would tell `police` the player just fired,
       * every 1.5 s) and `game/hostiles.js` emits `damage:dealt` directly.
       *
       * `Ped.applyDamage` and `Crew._readAim` both read this — the first to
       * make an accidental burst into a brother cost a tenth, the second to
       * walk him out of the barrel in the first place.
       */
      this.playerShotAt = this.ctx.time?.elapsed ?? 0;
      const near = this.grid.query(e.origin.x, e.origin.z, 70);
      for (let i = 0; i < near.length; i++) {
        const p = near[i];
        if (!p.alive) continue;
        const d = p.position.distanceTo(e.origin);
        const sev = d < 10 ? 1.15 : d < 24 ? 0.75 : d < 45 ? 0.42 : 0.2;
        p.startle(e.origin, sev);
      }
    });

    on('bullet:impact', (e) => {
      if (!e || !e.point) return;
      const near = this.grid.query(e.point.x, e.point.z, 14);
      for (let i = 0; i < near.length; i++) {
        const p = near[i];
        if (!p.alive) continue;
        const d = p.position.distanceTo(e.point);
        if (d < 4) p.startle(e.point, 1.0);
        else p.startle(e.point, 0.35);
      }
    });

    /**
     * ──────────────────────────────────────────────────────────────────────
     * EXPLOSIONS. RADIAL DAMAGE SPLITS FOUR WAYS AND THIS IS THE ACTOR HALF.
     * ──────────────────────────────────────────────────────────────────────
     * The canonical model, entire:
     *
     *   enemies   inside radius        damage * (1 - d / radius)
     *   peds      inside radius        killed outright       -- NO FALLOFF
     *   vehicles  inside radius * 1.2  damage * (1 - d / (r * 1.2))
     *   player    inside radius        damage * 0.55 * (1 - d / r),
     *                                  and only when NOT in a vehicle
     *
     * A CIVILIAN INSIDE THE RADIUS DIES. Not "takes a lot" — dies. That branch
     * is the one with no falloff in it at all, and ours was `dmg * f * f` into
     * a 100 HP body: a SQUARED falloff, on the one population the model applies
     * no falloff to at all.
     *
     * MEASURED through this listener before the change, with payloads nothing
     * here authors — the Scrap Rocket's 200 damage / 10 m splash out of
     * `weapons/lib.js`, and the wreck's 55 / 7 m as `vehicles/damage.js`
     * emits it off its own fuse:
     *
     *   Scrap Rocket   lethal out to 2.9 m of a 10 m splash  (8% of the area)
     *   car wreck      lethal NOWHERE: 47.4 of 100 HP at half a metre, and
     *                  falling to 1.1 HP at 6 m
     *
     * So an explosion in a crowded street did essentially nothing to the
     * crowd, which is the opposite of the one thing an explosion is for.
     * `node src/peds/blastprobe.mjs` is the gate.
     *
     * WHICH POPULATION IS WHICH. The model above has two actor lists; this
     * engine has four kinds of pedestrian, so the mapping is written down
     * rather than left to be inferred:
     *
     *   ambient civilian     -> peds     -> killed outright
     *   `isHostile` goon     -> enemies  -> linear falloff
     *   `isPolice` officer   -> enemies  -> linear falloff (an officer is an
     *                           enemy with 70 HP)
     *   crew brother         -> neither  -> linear falloff, halved
     *
     * The enemy branch carries as much weight as the civilian one. A boss is a
     * 400-1600 HP `Ped` on this same path, and "everything inside the radius
     * dies" would have made one rocket the answer to every chapter in the
     * game. The halved ally share is kept as it was: a grenade that floors
     * both brothers every time turns the crew into a liability.
     *
     * IN A CAR, THE BLAST DOES NOT TOUCH YOU — THE CAR TAKES IT. The rule is
     * stated for the player in the model above, and the mechanism is that his
     * car is a vehicle and eats the damage on his behalf. AI cars here carry
     * occupants too, so they get the same rule for the same reason.
     * `vehicles._explosionDamage` damages the car, `traffic` bails the driver
     * out on `vehicle:destroyed`, and nothing ragdolls inside a moving car.
     *
     * SNAPSHOT BEFORE WALKING. `CrowdGrid.query` returns ONE array that it
     * clears and refills on every call (`nav.js`), and this loop can now kill
     * people — `Ped._down` ends in `sys.panic(...)`, and `panic` is another
     * `grid.query`. So the loop was walking a buffer being rewritten under it.
     * MEASURED on the code as it stood, one 200 / 10 m blast into 24 people:
     * FIVE `grid.query` calls for one explosion, and 5 of the 21 in range took
     * the blast TWICE (2.00x the falloff the same code computed for them). It
     * was survivable only because deaths were rare; every kill re-enters, so
     * the fix below would have turned an oddity into the common case.
     */
    on('explosion', (e) => {
      if (!e || !e.position) return;
      const radius = e.radius ?? 6;
      const dmg = e.damage ?? 110;
      const near = this.grid.query(e.position.x, e.position.z, radius * 5 + 20);
      const hit = this._blast;
      const n = near.length;
      for (let i = 0; i < n; i++) hit[i] = near[i];

      for (let i = 0; i < n; i++) {
        const p = hit[i];
        if (!p.alive) continue;
        const d = p.position.distanceTo(e.position);
        if (d >= radius) {
          p.panic(e.position, Math.max(0.5, 2.2 - d / (radius * 3)));
          continue;
        }
        if (p.vehicle) continue;                 // his car is taking this
        /**
         * The shove direction, FLATTENED. `p.position` is a pedestrian's feet
         * and a detonation is typically a metre or so off the ground, so the
         * unflattened `p - e` used here before pointed DOWNWARD — every body a
         * blast threw was thrown into the pavement. `die()` applies the
         * impulse along this vector with no vertical term of its own, so this
         * is the only place that could be fixed.
         */
        this._v.copy(p.position).sub(e.position);
        this._v.y = 0;
        if (this._v.lengthSq() < 1e-8) this._v.set(0, 0, 1);
        else this._v.normalize();
        const f = 1 - d / radius;
        if (p.isHostile || p.isPolice || p.isCrew) {
          p.applyDamage(dmg * f * (p.isCrew ? 0.5 : 1), 'torso', e.position, this._v);
        } else {
          /**
           * `killPed`. The falloff survives in the SHOVE and nowhere else:
           * `die()` sizes the ragdoll impulse off the amount it is handed, so
           * the man at the epicentre is thrown hardest and the man at the rim
           * drops where he stood. Health is zeroed first because `die()` does
           * not touch the pool, and a corpse reading 100 HP is a lie anything
           * downstream would be entitled to believe.
           */
          p.health = 0;
          p.die(e.position, this._v, dmg * f);
        }
      }
      // Do not pin bodies the streamer wants to recycle. Length is untouched.
      for (let i = 0; i < n; i++) hit[i] = null;
    });

    on('damage:dealt', (e) => {
      if (!e || !e.target || !(e.target instanceof Ped)) return;
      const p = e.target;
      if (!p.alive) return;
      p.applyDamage(e.amount ?? 25, e.headshot ? 'head' : e.part ?? 'torso', e.point ?? p.position, e.incident);
      if (!p.alive) e.killed = true;
    });

    on('wanted:heat', (e) => {
      if (!e || !e.position) return;
      this.panic(e.position, (e.radius ?? 30), 0.55);
    });

    on('vehicle:destroyed', (e) => {
      if (e?.point) this.panic(e.point, 26, 1.2);
    });

    // The brother you switch TO stops following and the one you left starts.
    // `Crew.spawn()` reconciles, so the man who is a companion either side of
    // the switch keeps his body, his position and his advice deck.
    on('game:character', () => {
      if (this.crewAuto) this._crewTimer = 0;
    });
  }

  /* ================================================================== */
  /* public API                                                         */
  /* ================================================================== */

  /** Nearest living pedestrian to a point — melee targeting, carjack, missions. */
  nearest(x, y, z, radius = 3) {
    const near = this.grid.query(x, z, radius);
    let best = null;
    let bd = radius * radius;
    for (let i = 0; i < near.length; i++) {
      const p = near[i];
      if (!p.alive || !p.active) continue;
      const dx = p.position.x - x;
      const dy = (p.position.y + 0.9) - y;
      const dz = p.position.z - z;
      const d = dx * dx + dy * dy * 0.4 + dz * dz;
      if (d < bd) { bd = d; best = p; }
    }
    return best;
  }

  /** Every living ped inside a radius. Returns a REUSED array. */
  inRadius(x, z, radius) {
    return this.grid.query(x, z, radius);
  }

  /**
   * Scare everyone inside a radius. `severity` 0..2: below ~0.55 they flinch
   * and look; above it they scatter, a few freeze and a very few square up.
   */
  panic(position, radius = 25, severity = 1) {
    if (!position) return 0;
    const near = this.grid.query(position.x, position.z, radius);
    let n = 0;
    for (let i = 0; i < near.length; i++) {
      const p = near[i];
      if (!p.alive) continue;
      const d = p.position.distanceTo(position);
      const s = severity * (1 - Math.min(1, d / Math.max(1, radius)) * 0.55);
      if (s < 0.5) p.startle(position, s);
      else p.panic(position, s);
      n++;
    }
    return n;
  }

  /* ================================================================== */
  /* MISSION HOSTILES — the API `game/hostiles.js` was written waiting for */
  /* ================================================================== */

  /**
   * Put a mission enemy on the ground. THE handle is the `Ped`, so everything
   * the engine already does to a pedestrian — ballistics against its hit
   * capsules, `damage:dealt`, ragdoll death, `actor:death`, minimap contacts,
   * being run over — happens to a goon with no special case anywhere.
   *
   * @param {{x:number,y:number,z:number}} position
   * @param {object} [opts] `{ hp, dmg, ranged, range, speed, scale, tag, leash }`
   * @returns {Ped|null} null when the hostile pool is spent.
   */
  spawnHostile(position, opts) {
    return this.hostiles.spawn(position, opts);
  }

  /** Take one off the street. Safe with a handle that is already gone. */
  despawnHostile(ped) {
    this.hostiles.despawn(ped);
  }

  /** Every mission enemy off the street — end of chapter, abort, death. */
  clearHostiles() {
    this.hostiles.clear();
  }

  /** Damage one through the same path a bullet takes. True if that killed him. */
  hurtHostile(ped, amount, headshot = false, point = null) {
    return this.hostiles.hurt(ped, amount, headshot, point);
  }

  /** Mission enemies on their feet. */
  get hostileCount() {
    return this.hostiles.aliveCount;
  }

  /* ---- carjacking: what `player` needs to pull a driver out ---- */

  driverOf(vehicle) {
    if (!vehicle) return null;
    for (let i = 0; i < this.peds.length; i++) {
      const p = this.peds[i];
      if (p.active && p.vehicle === vehicle && p.isDriver) return p;
    }
    return null;
  }

  /**
   * Drag whoever is driving `vehicle` out of it and leave them terrified on the
   * road. Returns the ped, or null when the car was empty. Safe to call with a
   * car nobody is in.
   */
  pullFromVehicle(vehicle, doorPoint) {
    const ped = this.driverOf(vehicle);
    if (!ped) return null;
    this._v.copy(doorPoint ?? ped.position);
    ped.ejectFrom(vehicle, this._v);
    this.panic(this._v, 20, 1.1);
    return ped;
  }

  /* ---- THE CREW: what `game` and `player` drive ---- */

  /**
   * Put the crew on the street. With no argument this is "the two brothers you
   * are not playing", which is the default and the point. Idempotent.
   * @returns {number} how many companions are live
   */
  spawnCrew(ids = null) {
    this.crewAuto = ids === null;
    return this.crew.spawn(ids);
  }

  /** Take the crew off the street — a solo chapter, a cutscene, a title card. */
  despawnCrew() {
    this.crewAuto = false;
    this.crew.despawn();
  }

  /** REUSED array of REUSED records. Safe to call every frame. */
  crewState() { return this.crew.state(); }

  /** Ids of the brothers on their feet. REUSED array. */
  crewAlive() { return this.crew.alive(); }

  /** Pin a brother to a spot for a `protect` chapter. `(id, null)` releases. */
  setCrewGuard(id, x, z) { return this.crew.setGuard(id, x, z); }

  /** Designate the mission ward: he holds, and by default he does NOT revive. */
  setCrewWard(id, opts) { return this.crew.setWard(id, opts); }

  clearCrewWard() { this.crew.clearWard(); }

  /** A scripted line, spoken in his own colour through `ui.say`. */
  crewSay(id, line) { return this.crew.say(id, line); }

  /** Force one of the ambient advice lines out of him. */
  crewAdvise(id) { return this.crew.advise(id); }

  downCrew(id) { return this.crew.down(id); }
  reviveCrew(id) { return this.crew.revive(id); }

  /** Put a brother's HP where you want it. Returns the member record. */
  hurtCrew(id, amount) {
    const m = this.crew.byId(id);
    if (m) this.crew.hurt(m, amount, m.position, null);
    return m;
  }

  /**
   * MINIMAP / MAP BLIPS. `ui._collectBlips` polls this every frame and reads
   * `{ position, friendly, heading, alive }` off each entry.
   *
   * Two populations, because those are the two `peds` owns and neither of them
   * had any way of reaching the radar:
   *
   *   - a brother, `friendly: true`, carrying his own signature colour so the
   *     map can draw him teal/orange/violet rather than a generic green.
   *   - anyone actually trying to hit you, `friendly: false`: a civilian who
   *     squared up, and a mission enemy. A frightened bystander is not a
   *     contact and putting the whole crowd on the radar would bury the two
   *     blips that matter under forty that do not.
   *
   * Police blips come from `police.cops`; this does not duplicate them. Mission
   * hostiles are HERE and nowhere else — `ui._collectBlips` draws enemies from
   * this method alone, and while they lived in `game/hostiles.js` they had no
   * route to the radar at all, so a goon behind you was invisible on it.
   *
   * ALLOCATES NOTHING. The array and its records are built once and mutated,
   * because `ui` calls this on every frame of every mode — the same contract
   * `getHudState()` carries elsewhere. `position` is a live `Vector3` owned by
   * the actor, so the consumer must read it, never keep it.
   *
   * `node src/peds/blipprobe.mjs` drives a real crowd and asserts the blips
   * appear, track, and disappear.
   */
  getHudActors() {
    const out = this._hudActors;
    let n = 0;
    const R2 = HUD_BLIP_RADIUS * HUD_BLIP_RADIUS;
    const px = this.playerPos.x, pz = this.playerPos.z;

    const take = () => {
      if (n >= HUD_BLIP_MAX) return null;
      while (out.length <= n) {
        out.push({ position: null, friendly: false, heading: 0, alive: true, kind: '', id: null, colour: null });
      }
      return out[n++];
    };

    for (let i = 0; i < this.crew.members.length; i++) {
      const m = this.crew.members[i];
      if (!m.active || !m.ped || !m.ped.active) continue;
      const r = take();
      if (!r) break;
      r.position = m.ped.position;
      r.friendly = true;
      r.heading = m.ped.yaw;
      r.alive = m.up;
      r.kind = 'crew';
      r.id = m.id;
      r.colour = m.colour;
    }

    for (let i = 0; i < this.live.length; i++) {
      const p = this.live[i];
      if (p.isCrew || !p.alive) continue;
      // Somebody actually trying to hit you: a civilian who squared up, or a
      // mission enemy. A frightened bystander is not a contact.
      if (p.state !== STATE.FIGHT && p.state !== STATE.HOSTILE) continue;
      const dx = p.position.x - px, dz = p.position.z - pz;
      if (dx * dx + dz * dz > R2) continue;
      const r = take();
      if (!r) break;
      r.position = p.position;
      r.friendly = false;
      r.heading = p.yaw;
      r.alive = true;
      r.kind = 'hostile';
      r.id = p.id;
      r.colour = null;
    }

    out.length = Math.max(out.length, n);
    this._hudActorCount = n;
    // `ui` iterates the array, so hand back a view of exactly what is live.
    // Splicing would allocate; a length assignment on the SAME array does not,
    // and the records past `n` are reused on the next call.
    if (out.length !== n) out.length = n;
    return out;
  }

  /** Put a ped in a car as its driver — `traffic` calls this when it has one. */
  attachDriver(vehicle, seat = 0, opts = {}) {
    const ped = this._freePed();
    if (!ped) return null;
    const pos = vehicle?.position ?? this._v.set(0, 0, 0);
    const arch = opts.archetype ?? 'street';
    const outfit = makeOutfit(this.rng.fork(), arch, { rain: this._rain });
    ped.spawn(outfit, this._v3.set(pos.x, pos.y, pos.z), 0, this.rng.fork());
    ped.wander = ped.wander ?? new Wander();
    ped.vehicle = vehicle;
    ped.seat = seat;
    ped.isDriver = seat === 0;
    ped.state = STATE.DRIVING;
    /**
     * Sit him down NOW, not on the next `update()`. He was spawned at the car's
     * centre of mass, and the LOD sort, the crowd grid and `_seatSweep`'s own
     * distance test all run off `position` before anything else touches him —
     * so one frame of "a standing man at the chassis COM" is one frame in which
     * he can be drawn there. `_seatPose(false)` is the physics-pose form, which
     * is the only one available outside `lateUpdate`.
     */
    ped.speed = 0;
    ped.velocity.set(0, 0, 0);
    ped.animator?.clearActs();
    ped._seatPose(false);
    return ped;
  }

  /* ================================================================== */
  /* frame                                                              */
  /* ================================================================== */

  update(dt, ctx) {
    const t0 = performance.now();
    const anchor = this._anchor(this.playerPos);

    // the road graph appears when `world` publishes it, which may be long after
    // we booted; re-check cheaply
    this._netTimer -= dt;
    if (this._netTimer <= 0) {
      this._netTimer = 1.0;
      this.net.attach(this.world?.roads ?? null);
      const sky = this._sky ?? (this._sky = ctx.peek('sky'));
      if (sky) {
        if (Number.isFinite(sky.timeOfDay)) this._hour = sky.timeOfDay;
        if (Number.isFinite(sky.rain)) this._rain = sky.rain;
      }
    }

    this._stream(dt, anchor);
    this._crewStream(dt);

    // rebuild the spatial index, then everything else reads it. The crew is
    // appended here and NOWHERE else: `this.peds` is the ambient pool that the
    // streamer despawns from and that `traffic`/`police` take drivers and
    // officers out of, and a brother must never be reachable from any of them.
    this.live.length = 0;
    for (let i = 0; i < this.peds.length; i++) if (this.peds[i].active) this.live.push(this.peds[i]);
    for (let i = 0; i < this.crew.members.length; i++) {
      const m = this.crew.members[i];
      if (m.active && m.ped && !m.inCar) this.live.push(m.ped);
    }
    // Mission hostiles, same rule and for the same reason: their pool is
    // private, so this is the ONLY place they join the crowd's LOD pass, its
    // spatial index and its draw.
    for (let i = 0; i < this.hostiles.live.length; i++) {
      const h = this.hostiles.live[i];
      if (h.active) this.live.push(h);
    }
    this.grid.rebuild(this.live);

    this._assignLod(anchor);
    // the crew brain runs BEFORE the ped loop: it writes steering that
    // `Ped._move` then integrates with the crowd's own avoidance
    this.crew.update(dt, anchor);
    this.hostiles.update(dt, anchor);
    this._vehicleThreats(dt);

    for (let i = 0; i < this.live.length; i++) {
      const p = this.live[i];
      p.decayLook(dt);
      p.update(dt);
    }
    this._interest(dt, anchor);

    this.stats.live = this.live.length;
    this.stats.crew = this.crew.members.length;
    this.stats.crewMs = this.crew.stats.ms;
    this.stats.ms = performance.now() - t0;
  }

  /**
   * Bring the crew into being once there is a player to follow, and keep the
   * roster in step with whichever brother is on screen. Cheap and idempotent —
   * `Crew.spawn()` reconciles rather than rebuilding, so the brother who is
   * still a companion after a switch never loses his body.
   */
  _crewStream(dt) {
    if (!this.crewAuto) return;
    this._crewTimer -= dt;
    if (this._crewTimer > 0) return;
    this._crewTimer = 1.0;
    if (!this.hasPlayer) return;
    const want = this.crew._resolveIds(null);
    if (this.crew.members.length === want.length &&
        want.every((id) => this.crew.byId(id))) return;
    this.crew.spawn(want);
  }

  /**
   * Distance LOD plus body assignment.
   *
   * Bodies are handed to the closest pedestrians, not the first ones to spawn,
   * and the list is only re-sorted when it needs to be — a ped that already has
   * a body keeps it until somebody meaningfully closer wants one, so a crowd
   * does not flicker between representations as the player turns.
   */
  _assignLod(anchor) {
    const list = this._sortBuf;
    list.length = 0;
    const bias = this.lodScale;
    for (let i = 0; i < this.live.length; i++) {
      const p = this.live[i];
      p.dist = Math.hypot(p.position.x - anchor.x, p.position.z - anchor.z);
      list.push(p);
    }
    list.sort(cmpDist);

    let bodies = 0;
    for (let i = 0; i < list.length; i++) {
      const p = list[i];
      // hysteresis: keeping a body costs less than the pop of losing one
      const ambient = this.ambientBodies;
      // A hostile draws on the reserved slots, like a brother — a mission enemy
      // that is a capsule while he is punching you is not a mission enemy. He
      // still obeys the distance rule below, so a leashed wave 90 m away costs
      // the same as the crowd does.
      const cap = (p.isCrew || p.isHostile) ? this.maxBodies
        : this._forceFar ? 0 : (p.body ? ambient : ambient - 2);
      // A brother is never demoted to a capsule and never distance-culled: he
      // sorts first (see `cmpDist`) and reads as near whatever the range.
      const near = p.isCrew || p.dist < LOD1 * bias || (!p.alive && p.dist < LOD1 * bias * 1.6);
      if (near && bodies < cap && this._acquireBody(p)) {
        bodies++;
        p.lod = p.dist < LOD0 * bias ? 0 : 1;
        if (p.mesh) p.mesh.userData.owNoShadow = p.lod !== 0;
        continue;
      }
      // never take a body off someone the ragdoll solver is still driving
      if (p.body && p.alive) this._releaseBody(p);
      else if (p.body) { bodies++; p.lod = 1; continue; }
      p.lod = 2;
    }
    this.stats.bodies = bodies;
  }

  /**
   * Cars are the thing pedestrians in an open-world game are most obviously
   * wrong about. Every frame each moving vehicle sweeps the crowd grid ahead of
   * it: anything inside the swept corridor either dives clear or gets hit, with
   * the car's momentum, a ragdoll launch and an injury — never a despawn.
   */
  _vehicleThreats(dt) {
    const list = this._collectVehicles();
    if (!list.length) return;
    for (let i = 0; i < list.length; i++) {
      const v = list[i];
      const speed = Math.hypot(v.vx, v.vz);
      if (speed < 2.2) continue;
      const look = Math.min(22, 1.2 + speed * 1.5);
      const cx = v.x + (v.vx / speed) * look * 0.5;
      const cz = v.z + (v.vz / speed) * look * 0.5;
      const near = this.grid.query(cx, cz, look * 0.5 + 3);
      const nx = v.vx / speed, nz = v.vz / speed;
      for (let j = 0; j < near.length; j++) {
        const p = near[j];
        if (!p.alive || p.state === STATE.DRIVING || p.state === STATE.DOWN) continue;
        const dx = p.position.x - v.x;
        const dz = p.position.z - v.z;
        const along = dx * nx + dz * nz;
        if (along < -1.2 || along > look) continue;
        const lat = -dx * nz + dz * nx;
        const half = v.halfWidth + p.radius;
        if (Math.abs(lat) > half + 1.5) continue;
        const ttc = along / speed;
        if (Math.abs(lat) <= half && along < Math.max(1.2, speed * 0.18)) {
          this._v.set(v.vx, 0, v.vz);
          this._v2.set(p.position.x, p.position.y + 0.9, p.position.z);
          p.hitByVehicle(this._v, this._v2, v.mass);
          continue;
        }
        if (ttc < 1.5) {
          p.dodge(this._v3.set(v.x, p.position.y, v.z), lat >= 0 ? 1 : -1, ttc);
        } else if (ttc < 2.6) {
          p.glanceAt(this._v3.set(v.x, p.position.y + 1.2, v.z), 0.8, 1.2);
        }
      }
    }
  }

  /**
   * Vehicles, however `vehicles` chooses to expose them. This reads
   * defensively and returns an empty list rather than throwing when the shape
   * is not what was expected.
   */
  _collectVehicles() {
    const out = this._vehBuf;
    const pool = this._vehPool ?? (this._vehPool = []);
    out.length = 0;
    let n = 0;
    const vs = this._veh ?? (this._veh = this.ctx.peek('vehicles'));
    if (!vs) return out;
    const src = vs.vehicles ?? vs.list ?? vs.actors ?? vs.all ?? null;
    if (!src || typeof src.length !== 'number') return out;
    for (let i = 0; i < src.length; i++) {
      const v = src[i];
      if (!v) continue;
      const p = v.position ?? v.object3D?.position ?? v.group?.position;
      const vel = v.velocity ?? v.linearVelocity ?? null;
      if (!p || !Number.isFinite(p.x)) continue;
      const vx = vel?.x ?? 0;
      const vz = vel?.z ?? 0;
      if (!Number.isFinite(vx)) continue;
      let rec = pool[n];
      if (!rec) pool[n] = rec = { ref: null, x: 0, z: 0, vx: 0, vz: 0, halfWidth: 1, mass: 1400 };
      n++;
      rec.ref = v;
      rec.x = p.x;
      rec.z = p.z;
      rec.vx = vx;
      rec.vz = vz;
      rec.halfWidth = (v.width ?? (v.halfWidth ? v.halfWidth * 2 : 2.0)) * 0.5;
      rec.mass = v.mass ?? 1400;
      out.push(rec);
    }
    return out;
  }

  /**
   * What a pedestrian is looking at. Cheap, throttled and deliberately shallow:
   * a head that tracks the player as they walk past, a head that turns to
   * follow a car, a head that stays on whatever just frightened them. This is
   * the single cheapest thing that makes a crowd stop reading as a diorama.
   */
  _interest(dt, anchor) {
    const n = this.live.length;
    if (!n) return;
    // a slice of the crowd per frame, so the whole crowd is refreshed at ~6 Hz
    const slice = Math.max(1, Math.ceil(n / 10));
    this._interestCursor = (this._interestCursor ?? 0) % n;
    for (let k = 0; k < slice; k++) {
      const p = this.live[(this._interestCursor + k) % n];
      if (!p.alive || p.lod > 1) continue;
      if (p.fear > 0.3 && p.hasThreat) {
        p.glanceAt(p.threat, 1, 1.6);
        continue;
      }
      if (p._lookHold > 0) continue;
      const dx = anchor.x - p.position.x;
      const dz = anchor.z - p.position.z;
      const d2 = dx * dx + dz * dz;
      if (d2 < 144 && d2 > 1) {
        // only if the player is roughly in front of them — nobody walks
        // backwards staring
        const fx = Math.sin(p.yaw), fz = Math.cos(p.yaw);
        const d = Math.sqrt(d2);
        if ((dx * fx + dz * fz) / d > -0.25) {
          this._v.set(anchor.x, anchor.y + 1.5, anchor.z);
          p.glanceAt(this._v, Math.min(1, 1.4 - d / 12), 1.4);
        }
      }
    }
    this._interestCursor += slice;
  }

  lateUpdate(dt, ctx) {
    const t0 = performance.now();
    const elapsed = ctx.time.elapsed;
    this.ground.begin();
    this.far.begin();
    this.props.begin();

    for (let i = 0; i < this.live.length; i++) {
      const p = this.live[i];
      /**
       * A DRIVER HAS NO SHADOW ON THE ROAD AND NO CIGARETTE.
       *
       * `ground.addPed` drops a contact blob at `p.position`, which for a
       * seated ped is the seat — a smear of shade hanging in mid-air half a
       * metre up, INSIDE a car that is already casting its own shadow. And a
       * prop is emitted from a hand bone: an umbrella opened at the wheel is
       * a canopy through the roof. Neither had anywhere to go wrong before,
       * because nothing was ever seated.
       */
      const seated = p.state === STATE.DRIVING && p.vehicle;
      if (p.body) {
        p.updateVisual(dt, elapsed);
        p.syncColliders();
        if (!seated) {
          this.ground.addPed(p);
          this._emitProps(p);
        }
      } else if (seated) {
        // far LOD, seated: the standing capsule figure stacks 0.985 of a body
        // height off `p.position`, so at LOD2 the driver stood up through the
        // roof exactly as the skinned one used to. Same seat, half a body.
        // The seat is recomposed here rather than in `update()` for the same
        // reason the skinned path does it in `updateVisual` — this is the phase
        // in which the car's DRAWN pose exists.
        p._seatPose(true);
        if (p.alive) this.far.addSeated(p);
      } else {
        // far LOD: advance the stride phase from real ground speed, exactly as
        // the skinned animator does, so a ped that walks into body range does
        // not pop mid-step
        const idx = p.id % this._farPhase.length;
        const stride = Math.max(0.6, (0.62 + 0.155 * p.speed) * p.height);
        this._farPhase[idx] = (this._farPhase[idx] + (dt * p.speed) / stride) % 1;
        if (p.alive) this.far.addPed(p, this._farPhase[idx]);
      }
    }

    this.ground.end();
    this.far.end();
    this.props.end();
    this.stats.far = this.far._n / 7;
    this.stats.ms += performance.now() - t0;
  }

  _emitProps(ped) {
    const an = ped.animator;
    if (!an || !ped.alive) return;
    const props = ped.outfit.props;
    const pal = ped.outfit.palette;
    if (props.umbrella && an.act.umbrella > 0.4) {
      this.props.add('umbrella', an.boneMatrix('HandR'), this._umbrellaOffset, pal[6]);
    } else if (props.umbrellaClosed && ped.lod === 0) {
      this.props.add('cane', an.boneMatrix('HandR'), this._umbrellaOffset, pal[8]);
    }
    if (props.cigarette && an.act.smoke > 0.25 && ped.lod === 0) {
      this.props.add('cig', an.boneMatrix(an.actSide.smoke > 0 ? 'HandL' : 'HandR'),
        this._cigOffset, this._cigColour);
    }
    if (props.phone && (an.act.phone > 0.35 || an.act.film > 0.35)) {
      const bone = an.act.film > 0.35 ? 'HandR' : an.actSide.phone > 0 ? 'HandL' : 'HandR';
      this.props.add('phone', an.boneMatrix(bone), this._phoneOffset, pal[8]);
    }
  }

  /** Release any instanced prop a ped was holding (called when they go down). */
  releaseProps() { /* props are rebuilt every frame; nothing to release */ }

  /** A ped landed a punch. */
  onPedPunch(ped, targetPos) {
    const player = this.ctx.peek('player');
    const anchor = this.playerPos;
    if (!this.hasPlayer) return;
    if (anchor.distanceTo(ped.position) > 2.2) return;
    this._v.copy(anchor).sub(ped.position).normalize();
    this.ctx.events.emit('damage:dealt', {
      target: player ?? 'player',
      amount: 7,
      headshot: false,
      killed: false,
      point: anchor,
      from: ped.position,
      source: ped,
    });
  }

  /* ================================================================== */
  /* pre-warm                                                           */
  /* ================================================================== */

  /**
   * Compile every program the crowd can ask for, without spawning a single
   * pedestrian. Three programs: the skinned palette material (one per material
   * slot, all sharing a cache key per slot), the far-crowd instanced capsule
   * and the instanced props — plus the CSM depth variant of the skinned one,
   * which `compileAsync` cannot reach on its own because it only ever looks at
   * `object.material`.
   */
  async prewarmMaterials(ctx = this.ctx) {
    if (this._prewarmed) return this._prewarmed;
    const out = { ok: false, materials: 0, programs: 0, ms: 0 };
    this._prewarmed = out;
    const t0 = performance.now();
    try {
      const r = ctx.peek('render');
      const renderer = r?.renderer;
      // one representative material set, patched exactly as a live one is
      const palette = this.materials.createPalette();
      const set = this.materials.createSet(palette, this.materials.createFabric());
      out.materials = set.length + 4;
      if (r?.patcher) {
        for (const m of set) r.patcher.patch(m);
        r.patcher.patch(this.far.material);
        for (const k in this.props.meshes) r.patcher.patch(this.props.meshes[k].material);
      }
      if (!renderer) return out;
      const before = renderer.info.programs?.length ?? 0;

      const scene = new THREE.Scene();
      const { skeleton, root } = RIG.createSkeleton();
      const geo = this._dummySkinGeometry();
      const mesh = new THREE.SkinnedMesh(geo, set);
      mesh.frustumCulled = false;
      scene.add(root);
      scene.add(mesh);
      mesh.bind(skeleton);

      const compile = async (target) => {
        try {
          await renderer.compileAsync(scene, ctx.camera, target);
        } catch {
          try { renderer.compile(scene, ctx.camera, target); } catch { /* driver */ }
        }
      };
      await compile(ctx.scene);
      const depth = r.csm?.depthMaterial;
      if (depth) {
        const prev = mesh.material;
        mesh.material = depth;
        await compile(ctx.scene);
        mesh.material = prev;
      }
      scene.remove(mesh);

      // the instanced crowd and props are their own permutation (instancing +
      // instanceColor), and they are what a distant street is made of
      const inst = new THREE.InstancedMesh(this.far.geo, this.far.material, 1);
      inst.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(3), 3);
      inst.frustumCulled = false;
      scene.add(inst);
      await compile(ctx.scene);
      scene.remove(inst);
      inst.dispose();

      for (const k in this.props.meshes) {
        const pm = this.props.meshes[k];
        const one = new THREE.InstancedMesh(pm.geometry, pm.material, 1);
        one.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(3), 3);
        one.frustumCulled = false;
        scene.add(one);
        await compile(ctx.scene);
        scene.remove(one);
        one.dispose();
      }

      /**
       * The ground-contact pools are their own permutation — instancing plus
       * the `owFade` attribute patched in by `onBeforeCompile` — and they were
       * never in here, so they compiled on whichever frame the first
       * pedestrian happened to come into view. Warm the REAL meshes rather
       * than stand-ins: their geometry carries the custom attribute, and a
       * stand-in without it would warm a program the game never uses.
       */
      for (const pool of [this.ground.body, this.ground.feet]) {
        const one = new THREE.InstancedMesh(pool.geo, pool.mat, 1);
        one.frustumCulled = false;
        scene.add(one);
        await compile(ctx.scene);
        scene.remove(one);
        one.dispose();
      }
      out.materials += 2;

      geo.dispose();
      skeleton.dispose?.();
      out.programs = (renderer.info.programs?.length ?? 0) - before;
      out.ok = true;
    } catch (err) {
      out.error = String(err?.message ?? err);
    }
    out.ms = Math.round(performance.now() - t0);
    console.info(`[peds] prewarmMaterials ${JSON.stringify(out)}`);
    return out;
  }

  _dummySkinGeometry() {
    const g = new THREE.BufferGeometry();
    const n = 3;
    g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(n * 3), 3));
    g.setAttribute('normal', new THREE.BufferAttribute(new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1]), 3));
    g.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(n * 2), 2));
    g.setAttribute('color', new THREE.BufferAttribute(new Float32Array(n * 3).fill(1), 3));
    g.setAttribute('owTint', new THREE.BufferAttribute(new Float32Array(n * 3), 3));
    g.setAttribute('skinIndex', new THREE.BufferAttribute(new Uint16Array(n * 4), 4));
    const w = new Float32Array(n * 4);
    for (let i = 0; i < n; i++) w[i * 4] = 1;
    g.setAttribute('skinWeight', new THREE.BufferAttribute(w, 4));
    g.setIndex(new THREE.BufferAttribute(new Uint16Array([0, 1, 2]), 1));
    g.addGroup(0, 3, 0);
    return g;
  }

  /* ================================================================== */
  /* staged tableaux for the capture harness                            */
  /* ================================================================== */

  /**
   * `debugStage(name)` composes a crowd in front of whatever camera the shot
   * API has just set, so a capture does not depend on the player happening to
   * be standing somewhere busy.
   */
  debugStage(name) {
    if (name === 'none' || name === 'clean') {
      this._staged = false;
      for (const p of this.peds) if (p.active) this._despawn(p);
      return this.stats;
    }
    // 'far' is a dev stage: the same crowd with every skinned body withheld, so
    // the capsule LOD can be judged on its own.
    if (name === 'far') {
      this._forceFar = true;
      name = 'crowd';
    } else {
      this._forceFar = false;
    }
    if (name !== 'crowd' && name !== 'firefight' && name !== 'panic') return this.stats;

    for (const p of this.peds) if (p.active) this._despawn(p);
    this._staged = true;
    this.net.attach(this.world?.roads ?? null);

    const cam = this.ctx.camera;
    const F = this._v.set(0, 0, -1).applyQuaternion(cam.quaternion);
    F.y = 0;
    if (F.lengthSq() < 1e-6) F.set(0, 0, 1);
    F.normalize();
    const rx = F.z, rz = -F.x;
    const rng = this.rng;

    const count = Math.min(this.budget, name === 'crowd' ? 34 : 30);
    const placed = [];
    const nearDepth = name === 'crowd' ? 4.5 : 5.0;
    const farDepth = name === 'crowd' ? 30 : 40;
    let made = 0;
    const link = {};
    for (let i = 0; i < count * 8 && made < count; i++) {
      let x;
      let z;
      let staged = null;
      // Prefer the pavement network — it puts the tableau where people would
      // actually be, and it is the only thing that guarantees nobody is staged
      // in the middle of a carriageway or off a wharf.
      if (this.net.ready && this.net.sampleLink(rng, cam.position, nearDepth, farDepth + 20, link)) {
        const pt = this.net.pointOn(link.edge, link.side, link.t, this._v2);
        x = pt.x;
        z = pt.z;
        staged = link;
      } else {
        const depth = nearDepth + Math.sqrt(rng.float()) * (farDepth - nearDepth);
        const spread = 2.4 + depth * 0.52;
        const lateral = rng.signed() * spread;
        x = cam.position.x + F.x * depth + rx * lateral;
        z = cam.position.z + F.z * depth + rz * lateral;
      }
      // must be in front of the camera and inside the band
      const ex = x - cam.position.x;
      const ez = z - cam.position.z;
      const depth = ex * F.x + ez * F.z;
      if (depth < nearDepth || depth > farDepth + 18) continue;
      let tooClose = false;
      for (const q of placed) {
        if ((q[0] - x) ** 2 + (q[1] - z) ** 2 < 1.35) { tooClose = true; break; }
      }
      if (tooClose) continue;
      const y = this.groundAt(x, z, cam.position.y + 40, this._ground);
      if (!Number.isFinite(y) || y < -400) continue;
      if (Math.abs(y - cam.position.y) > 14) continue;
      if (this._ground.surface === 'water' || this.isWaterAt(x, z)) continue;

      const ped = this._freePed();
      if (!ped) break;
      let district = null;
      if (this.world?.districtAt) {
        try { district = this.world.districtAt(x, z); } catch { district = null; }
      }
      const arch = archetypeAt(rng, this._hour, district);
      const outfit = makeOutfit(rng.fork(), arch, { rain: this._rain });
      const yaw = staged ? this.net.headingOf(staged) : rng.range(-Math.PI, Math.PI);
      ped.spawn(outfit, this._v3.set(x, y, z), yaw, rng.fork());
      ped.wander = ped.wander ?? new Wander();
      if (staged) {
        ped.setLink({ edge: staged.edge, side: staged.side, dir: staged.dir, t: staged.t });
      } else {
        ped.navMode = 'wander';
        ped.wander.reset(ped.rng, ped.position, 22);
        ped.wanderTarget = ped.wander.target;
      }
      // stagger the walk so nobody is in step with anybody else
      ped.animator.phase = rng.float();
      ped.animator.idlePhase = rng.float();
      ped.speed = ped.baseSpeed * rng.range(0.75, 1.05);
      placed.push([x, z]);
      made++;
    }

    // give every staged ped a body if the budget allows, and settle the pose
    this.live.length = 0;
    for (const p of this.peds) if (p.active) this.live.push(p);
    this.grid.rebuild(this.live);
    this._assignLod(cam.position);
    // settle the walk so the shutter never catches a crowd mid-blend
    for (let step = 0; step < 30; step++) {
      for (const p of this.live) {
        p.update(1 / 60);
        if (p.body) p.updateVisual(1 / 60, step / 60);
      }
      this.grid.rebuild(this.live);
    }

    if (name === 'firefight' || name === 'panic') {
      const at = this._v3
        .copy(cam.position)
        .addScaledVector(F, name === 'panic' ? 16 : 11);
      at.y = this.groundAt(at.x, at.z, cam.position.y + 20);
      let k = 0;
      for (const p of this.live) {
        const d = p.position.distanceTo(at);
        if (d > 42) continue;
        // a spread of honest reactions rather than one canned pose
        const roll = (k++ * 7 + p.id) % 10;
        if (roll < 5) p.panic(at, 1.4);
        else if (roll < 7) { p.state = STATE.COWER; p.stateTime = 0; p.fear = 1.6; p.hasThreat = true; p.threat.copy(at); }
        else if (roll < 9) {
          p.state = STATE.GAWK;
          p.stateTime = 0;
          p.hasThreat = true;
          p.threat.copy(at);
          p._gawkFilm = roll === 8 && !!p.outfit.props.phone;
          p._gawkDist = 8 + (p.id % 5);
        } else if (name === 'firefight') {
          p.state = STATE.FIGHT;
          p.fightTarget = at;
          p.stateTime = 0;
        }
        p.startle(at, 1.2);
        p.glanceAt(at, 1, 6);
      }
      // Let the reactions DEVELOP. A panic is a second and a half of body
      // language — the flinch, the turn, the first three strides — and a
      // tableau shot on frame zero catches a street of people standing to
      // attention. The behaviour weights ease over ~0.4 s, so the animator has
      // to be stepped alongside the state machine, not once at the end.
      for (let step = 0; step < 96; step++) {
        const t = step / 60;
        for (const p of this.live) {
          p.decayLook(1 / 60);
          p.update(1 / 60);
          if (p.body) p.updateVisual(1 / 60, t);
        }
        this.grid.rebuild(this.live);
      }
    }

    this.stats.live = this.live.length;
    return this.stats;
  }

  /* ================================================================== */

  dispose() {
    for (const off of this._off ?? []) off();
    this.crew?.dispose();
    this.hostiles?.dispose();
    for (const p of this.peds) if (p.active) this._despawn(p);
    this.ground?.dispose();
    this.far?.dispose();
    this.props?.dispose();
    this.far?.material?.dispose();
    for (const b of this._all) {
      b.group.parent?.remove(b.group);
      for (const m of b.materials) m.dispose();
    }
    this._all.length = 0;
    this._free.length = 0;
    for (const v of this._variants.values()) v.geometry.dispose();
    this._variants.clear();
    this.materials?.dispose();
    this.root.parent?.remove(this.root);
  }
}

/**
 * Nearest first, EXCEPT the crew, who are always first. A brother is the one
 * pedestrian in the scene the player is guaranteed to be looking at.
 */
function cmpDist(a, b) {
  if (a.isCrew !== b.isCrew) return a.isCrew ? -1 : 1;
  return a.dist - b.dist;
}

export { Ped, STATE, SHAPES };
export { Crew, BROTHERS, ADVICE, TUNING as CREW_TUNING } from './crew.js';
export { PedHostiles, HOSTILE_MAX, HOSTILE_BODIES } from './hostile.js';
