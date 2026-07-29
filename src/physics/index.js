/**
 * PHYSICS — broadphase, raycasts, character collision, rigid bodies, ragdolls,
 * bullet penetration.
 *
 * No physics library: a binned-SAH BVH over the level's triangle soup, a swept
 * capsule character controller, an impulse rigid-body solver and a PBD ragdoll
 * solver, all stepped at 120 Hz from `fixedUpdate` and all deterministic off
 * `ctx.rng`.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * PUBLIC API  —  const phys = ctx.get('physics')
 * ────────────────────────────────────────────────────────────────────────────
 * STATIC WORLD
 *   addStatic(mesh, surfaceType?, opts?)   -> handle   (world: call me!)
 *   addStaticGroup(object3D, surfaceType?) -> handle[]  traverses children
 *   removeStatic(handleOrMesh)
 *   rebuildStatic()                        force an immediate BVH rebuild
 *
 * QUERIES  (world space, metres; `dir` need not be normalised)
 *   raycast(origin, dir, maxDist, mask?)   -> Hit   (always an object; check .hit)
 *   raycastAny(origin, dir, maxDist, mask?)-> bool  cheap visibility test
 *   lineOfSight(from, to, mask?)           -> bool
 *   sphereCast(origin, dir, radius, maxDist, mask?)  -> Hit
 *   capsuleCast(p0, p1, radius, dir, maxDist, mask?) -> Hit
 *   overlapCapsule(p0, p1, radius, mask?)  -> contact count
 *   checkCapsule(p0, p1, radius, mask?)    -> bool, true when clear
 *   groundHeight(x, z, fromY?, mask?)      -> y of the floor, or -Infinity
 *
 *   A RAY ALWAYS FINDS THE GROUND inside the city. `world` streams real
 *   collision as a 320 m patch around the camera and publishes
 *   `walkableHeightAt` for everything beyond it; `raycast` and everything
 *   built on it (groundHeight, fireBullet, explode) consume that query when no
 *   triangle is hit. See ground.js — without it 11.2% of the map answered a
 *   bullet ray, silently. `node src/physics/groundsweep.mjs` is the
 *   measurement. NOTE: capsule sweeps and overlaps are triangles only, so they
 *   still stop at world's patch — see `capsuleCast`.
 *
 *   Hit = { hit, point:Vector3, normal:Vector3, distance, surface:string,
 *           surfaceIndex, object, collider, body, ragdoll, actor, part,
 *           triangle, frontFace, fraction }
 *   Records come from a 64-deep ring pool: read or copy now, never stash.
 *
 * CHARACTER  (player / ai)
 *   createCharacter({radius, height, position, stepHeight, slopeLimit}) -> CharacterController
 *   removeCharacter(c)
 *   c.move(dx,dy,dz)  c.position  c.velocity  c.grounded  c.groundNormal
 *   c.groundSurfaceName  c.touchingCeiling  c.setHeight(h)  c.canFit(h)
 *   c.teleport(x,y,z)  c.landingSpeed  c.steppedUp  c.lastMoveBlocked
 *
 * BALLISTICS  (weapons)
 *   fireBullet({origin, dir, damage, penetration, maxDist, mask, rng}) -> impacts[]
 *   emits `bullet:impact` on entry AND exit of every layer.
 *   explode({position, radius, damage, impulse})
 *
 * DYNAMICS  (fx, weapons)
 *   addRigidBody({shape, halfExtents|radius, mass, position, velocity, ...}) -> RigidBody
 *   spawnDebris(position, velocity, {size, surface, lifetime, object3D})
 *   removeRigidBody(b)   b.applyImpulse(ix,iy,iz, px,py,pz)   b.sleeping
 *
 * RAGDOLLS  (ai)
 *   createRagdoll({bones?, transform, height, mass, velocity, impulse, point}) -> Ragdoll
 *   createRagdollFromSkeleton(skinnedMesh, {impulse, point, actor}) -> Ragdoll
 *   removeRagdoll(r)     set `physics.ignoreDeathEvents = true` to own this yourself
 *
 * HITBOXES / DYNAMIC COLLIDERS  (ai)
 *   addCollider({shape:'capsule'|'sphere'|'box', layer, surface, owner, part}) -> collider
 *   collider.setSegment(ax,ay,az,bx,by,bz)  collider.setSphere(x,y,z,r)
 *   collider.setFromObject(object3D, hx,hy,hz)   removeCollider(c)
 *
 * DEBUG
 *   setDebugDraw(bool, {triangles, nodes, rays, radius})   toggleDebugDraw()
 *   stats -> { triangles, nodes, buildMs, bodies, awake, ragdolls, ... }
 *
 * CONSTANTS
 *   phys.LAYER, phys.MASK, phys.SURFACE, phys.SURFACE_NAMES, phys.SURFACE_PROPS
 */

import * as THREE from 'three';
import { UNITS } from '../core/config.js';
import { StaticWorld } from './bvh.js';
import { GroundFallback } from './ground.js';
import { CharacterController } from './character.js';
import { RigidBody, RigidBodyWorld } from './rigidbody.js';
import { Ragdoll, humanoidSpec, specFromSkeleton } from './ragdoll.js';
import { Ballistics } from './penetration.js';
import { PhysicsDebugView } from './debug.js';
import {
  LAYER, MASK, SURFACE, SURFACE_NAMES, SURFACE_PROPS,
  surfaceIndex, surfaceName,
} from './surfaces.js';
import {
  makeHitRecord, raySphere, rayCapsule, rayObb, closestPtSegSeg, makeClosest,
} from './math.js';

const HIT_POOL = 64;
const IMPACT_POOL = 48;
/**
 * Vehicles a character can be pushed out of in one step. `vehicles.vehicles`
 * is already capped by `q.trafficBudget` and the whole set is tested per
 * character, so this only has to be larger than the budget ever gets.
 */
const MAX_BLOCKERS = 96;
/**
 * Radial bound of a vehicle, as a fraction of its longest half-dimension plus
 * a skin. A car is nothing like a circle, and that is the point: 0.72 of the
 * half-LENGTH inscribes the body comfortably at the doors and cuts the corners
 * off the nose and tail, so a player brushing past a bumper is deflected round
 * it rather than stopped square against a corner they cannot slide along.
 */
const BLOCK_R = 0.72;
const BLOCK_SKIN = 0.25;

/**
 * Frames the static BVH may stay dirty before `fixedUpdate` republishes it
 * regardless of what the callers are doing. Matched to `world`'s own 12-frame
 * debounce (`src/world/index.js`), which is the longest deliberate one — a
 * shorter number here silently defeats it. See `fixedUpdate`.
 */
const STATIC_BACKSTOP_FRAMES = 12;

function makePublicHit() {
  return {
    hit: false,
    point: new THREE.Vector3(),
    normal: new THREE.Vector3(0, 1, 0),
    distance: Infinity,
    fraction: 1,
    surface: 'concrete',
    surfaceIndex: 0,
    object: null,
    collider: null,
    body: null,
    ragdoll: null,
    actor: null,
    part: null,
    triangle: -1,
    frontFace: true,
  };
}

let _colliderId = 1;

/** A moving convex proxy — AI hitboxes, doors, dropped weapons, elevators. */
class Collider {
  constructor(opts) {
    this.id = _colliderId++;
    this.shape = opts.shape ?? 'capsule';
    this.ax = 0; this.ay = 0; this.az = 0;
    this.bx = 0; this.by = 0; this.bz = 0;
    this.radius = opts.radius ?? 0.2;
    this.hx = opts.hx ?? 0.2; this.hy = opts.hy ?? 0.2; this.hz = opts.hz ?? 0.2;
    this.matrix = new THREE.Matrix4();
    this.inverse = new THREE.Matrix4();
    this.layer = opts.layer ?? LAYER.ACTOR;
    this.surfaceIndex = surfaceIndex(opts.surface ?? 'flesh');
    this.owner = opts.owner ?? null;
    this.part = opts.part ?? null;
    this.damageScale = opts.damageScale ?? 1;
    this.enabled = opts.enabled !== false;
    this.onHit = opts.onHit ?? null;
    this.userData = opts.userData ?? null;
    if (opts.p0 && opts.p1) {
      this.setSegment(opts.p0.x, opts.p0.y, opts.p0.z, opts.p1.x, opts.p1.y, opts.p1.z);
    }
    if (opts.center) this.setSphere(opts.center.x, opts.center.y, opts.center.z, this.radius);
  }

  setSegment(ax, ay, az, bx, by, bz, r) {
    this.ax = ax; this.ay = ay; this.az = az;
    this.bx = bx; this.by = by; this.bz = bz;
    if (r !== undefined) this.radius = r;
    return this;
  }

  setSphere(x, y, z, r) {
    this.ax = this.bx = x;
    this.ay = this.by = y;
    this.az = this.bz = z;
    if (r !== undefined) this.radius = r;
    this.shape = 'sphere';
    return this;
  }

  /** Box proxy driven by an Object3D's world matrix. */
  setFromObject(obj, hx, hy, hz) {
    obj.updateWorldMatrix(true, false);
    this.matrix.copy(obj.matrixWorld);
    this.inverse.copy(this.matrix).invert();
    if (hx !== undefined) { this.hx = hx; this.hy = hy; this.hz = hz; }
    this.shape = 'box';
    return this;
  }

  setMatrix(m) {
    this.matrix.copy(m);
    this.inverse.copy(m).invert();
    return this;
  }
}

const _v = new THREE.Vector3();
const _m4 = new THREE.Matrix4();
const _m4i = new THREE.Matrix4();
const _one = new THREE.Vector3(1, 1, 1);

const SKIP_NAME =
  /(sky|skybox|light|helper|gizmo|particle|decal|tracer|muzzle|viewmodel|hud|billboard|sprite|volumetric|godray|impostor)/i;

export class PhysicsSystem {
  static id = 'physics';
  static deps = [];

  constructor() {
    this.staticWorld = new StaticWorld();
    /**
     * `world` streams real collision as a 320 m patch around the camera and
     * publishes `walkableHeightAt` for everything outside it. Nothing that
     * needs ground calls `world` though — they all call `physics` — so a ray that
     * leaves the patch is solved analytically here instead of silently finding
     * nothing. Measured: 11.2% of the city answered a bullet ray without it.
     */
    this.ground = new GroundFallback();
    this.bodies = new RigidBodyWorld(this.staticWorld, UNITS.gravity);
    this.characters = [];
    this.ragdolls = [];
    this.colliders = [];
    this.ballistics = new Ballistics(this);

    this.LAYER = LAYER;
    this.MASK = MASK;
    this.SURFACE = SURFACE;
    this.SURFACE_NAMES = SURFACE_NAMES;
    this.SURFACE_PROPS = SURFACE_PROPS;

    this.gravity = UNITS.gravity;
    /** Set true by `ai` if it wants to own ragdoll creation itself. */
    this.ignoreDeathEvents = false;
    this.maxRagdolls = 8;

    /**
     * VEHICLE BLOCKERS — why a car is a soft cylinder and not a box.
     *
     * A man on foot walked straight through every vehicle in the city. The
     * character controller resolves against the STATIC BVH and nothing else
     * (`character.js`), dynamic colliders are raycast-only hitboxes, and
     * `src/vehicles` registers no blocking collider — so there was no code path
     * anywhere that could stop a capsule at a bumper.
     *
     * The fix is one radial push per vehicle, refreshed here each fixed step
     * and consumed by `CharacterController._pushOutOfVehicles`. Radial and not
     * a full OBB, deliberately, and it is the same argument as the rest of the
     * traversal work in this file's sibling: a box has four corners to catch on
     * and a cylinder has none, so you slide round a wing mirror instead of
     * wedging against it, and a push along the line of centres can never form
     * the crease that traps a capsule. It costs one distance test per vehicle
     * per character and needs no broadphase at city scale, because
     * `vehicles.vehicles` is already budget-capped.
     *
     * Structure-of-arrays, preallocated, refilled in place — hard rule 5.
     */
    this.blockers = {
      n: 0,
      x: new Float32Array(MAX_BLOCKERS),
      y: new Float32Array(MAX_BLOCKERS),
      z: new Float32Array(MAX_BLOCKERS),
      r: new Float32Array(MAX_BLOCKERS),
      /** Half height of the body, for the vertical gate (roofs, undersides). */
      h: new Float32Array(MAX_BLOCKERS),
      /** The Vehicle itself, so a rider can be excluded. Never mutated here. */
      obj: new Array(MAX_BLOCKERS).fill(null),
    };
    this._vehicles = null;

    this._hitPool = [];
    for (let i = 0; i < HIT_POOL; i++) this._hitPool.push(makePublicHit());
    this._hitCursor = 0;

    this._impactPool = [];
    for (let i = 0; i < IMPACT_POOL; i++) {
      this._impactPool.push({
        point: new THREE.Vector3(),
        normal: new THREE.Vector3(),
        incident: new THREE.Vector3(),
        surface: 'concrete',
        surfaceIndex: 0,
        damage: 0,
        exit: false,
        object: null,
        body: null,
        actor: null,
        part: null,
      });
    }
    this._impactCursor = 0;
    this._impactResult = [];

    this._raw = makeHitRecord();
    this._raw2 = makeHitRecord();
    this._cl = makeClosest();
    this._explicitStatics = 0;
    this._autoIds = [];
    this._autoScanTimer = 0;
    this._groundStarted = false;
    this._fallbackId = -1;
    this._lastMeshCount = -1;
    this._pendingDemo = false;

    this.debug = null;
    this._loggedTris = -1;
    this._loggedAt = -1e9;
    /** Frame of the last static-BVH republish; see STATIC_BACKSTOP_FRAMES. */
    this._staticFrame = -1e9;
    /**
     * How many times a query found NO world where the world says there is
     * ground. Should stay at 0; anything else is a hole in the collision world
     * and combat stops working inside it. Never fails silently — see
     * `_noteWorldHole`.
     */
    this.worldHoleCount = 0;
    /**
     * Holes seen AFTER the ground proxy landed. This one must stay 0 — before
     * the proxy is resident the world is legitimately incomplete for a second
     * or two at boot.
     */
    this.worldHolesAfterReady = 0;
    this._holeLogs = 0;
    this._holeLogsReady = 0;
    /** Meshes handed to `addStatic` that produced no collision triangles. */
    this.rejectedStatics = 0;
    this._rejectLogs = 0;
    this.stats = {
      triangles: 0, nodes: 0, objects: 0, buildMs: 0,
      bodies: 0, awake: 0, ragdolls: 0, characters: 0, colliders: 0,
      raycasts: 0, stepMs: 0, groundFallbackHits: 0,
      truncatedContacts: 0, truncatedTraversals: 0,
      worldHoles: 0, worldHolesAfterReady: 0, rejectedStatics: 0,
      /**
       * Static-BVH work. `staticBuilds` is how many rebuilds a session paid
       * for and `staticTrisProcessed` is how much geometry went through them —
       * both load-independent, unlike a millisecond on a shared machine. See
       * `src/physics/colbench.mjs`.
       */
      staticBuilds: 0, staticTrisProcessed: 0, staticRefits: 0,
      staticCompactions: 0, staticObjects: 0, staticParts: 0, staticDeferred: 0,
    };
    this._rayCount = 0;
  }

  async init(ctx) {
    this.ctx = ctx;
    this.rng = ctx.rng.fork();
    this.ballistics.rng = this.rng;
    this.debug = new PhysicsDebugView(ctx.scene);

    this._onExplosion = (e) => this.explode(e);
    this._onDeath = (e) => this._handleDeath(e);
    ctx.events.on('explosion', this._onExplosion);
    ctx.events.on('actor:death', this._onDeath);

    // The level may not exist yet — `world` builds during its own init and can
    // stream more in later. Rescanning continues until something shows up; any explicit
    // addStatic() call takes over completely.
    this._ensureStatics(true);

    // Dev escape hatch: ?physdebug=1 turns the collision wireframe on from the
    // URL, and ?physdemo=1 also drops a ragdoll and some debris. Neither is
    // reachable in normal play.
    if (typeof location !== 'undefined') {
      const q = new URLSearchParams(location.search);
      // A/B hatch for measuring what the analytic fallback is worth:
      //   ?q=high&nogroundproxy=1
      // With it set, every query outside world's 320 m collision patch answers
      // "nothing there" again — which is the bug, not a mode. Never reachable
      // in normal play. `src/physics/groundsweep.mjs --noproxy` uses it.
      if (q.get('nogroundproxy') === '1') {
        this._groundStarted = true;
        console.warn(
          '[physics] ground fallback DISABLED by ?nogroundproxy=1 — ' +
          'rays outside the streamed patch will find nothing'
        );
      }
      /**
       * A/B hatch for the vehicle blockers, same shape and same reason:
       * `?novehicleblock=1` puts back the build where a man on foot walked
       * through every car in the city. It is the negative control for
       * `src/physics/carblock.mjs` and is never reachable in normal play.
       */
      if (q.get('novehicleblock') === '1') {
        this._noVehicleBlock = true;
        console.warn('[physics] vehicle blockers DISABLED by ?novehicleblock=1 — capsules pass through cars');
      }
      if (q.get('physdebug') === '1') this.setDebugDraw(true, { triangles: true, radius: 30 });
      if (q.get('physdemo') === '1') {
        this._pendingDemo = true;
        // Shots re-pose the camera after boot; respawn in front of the new view.
        ctx.events.on('shot:applied', () => {
          this.bodies.clear();
          for (const rd of this.ragdolls) rd.dispose();
          this.ragdolls.length = 0;
          this._pendingDemo = true;
        });
      }
    }
  }

  /* ================================================================== */
  /* Static world registration                                          */
  /* ================================================================== */

  /**
   * Register a mesh as static collision. `surfaceType` is one of the twelve
   * names in ARCHITECTURE.md; omit it and it is inferred per material group, so a
   * multi-material mesh gets per-triangle surfaces.
   * opts: { mask, layer, userData }
   */
  addStatic(mesh, surfaceType, opts = {}) {
    if (!mesh) return -1;
    if (this._autoIds.length || this._fallbackId >= 0) this._dropAutoStatics();
    const mask = opts.mask ?? opts.layer ?? LAYER.STATIC;
    const id = this.staticWorld.addMesh(mesh, surfaceType, mask, opts);
    if (id >= 0) {
      this._explicitStatics++;
      return id;
    }
    // A collider that fails to register is exactly the class of silent failure
    // that hid the terrain-streaming hole for so long: the caller believes its
    // geometry is solid and nothing anywhere says otherwise.
    this.rejectedStatics++;
    if (this._rejectLogs < 8) {
      this._rejectLogs++;
      const g = mesh.geometry;
      const why = !g ? 'no geometry'
        : !g.attributes?.position ? 'no position attribute'
        : mesh.isInstancedMesh && mesh.count === 0 ? 'InstancedMesh with count 0'
        : 'every triangle degenerate (zero area)';
      console.warn(
        `[physics] addStatic REJECTED "${mesh.name || mesh.type}" — ${why}. ` +
        `Nothing will collide with it.`
      );
    }
    return -1;
  }

  /** Register every Mesh under an Object3D. Returns the handle list. */
  addStaticGroup(root, surfaceType, opts = {}) {
    const ids = [];
    if (!root) return ids;
    root.updateWorldMatrix(true, true);
    root.traverse((o) => {
      if (!o.isMesh && !o.isInstancedMesh) return;
      if (o.userData?.collision === false || o.userData?.noCollision) return;
      const id = this.addStatic(o, surfaceType ?? o.userData?.surface, opts);
      if (id >= 0) ids.push(id);
    });
    return ids;
  }

  removeStatic(handle) {
    if (typeof handle === 'number') return this.staticWorld.removeObject(handle);
    const id = this.staticWorld.findByMesh(handle);
    return id >= 0 ? this.staticWorld.removeObject(id) : false;
  }

  /**
   * Publish everything registered since the last call. Cheap and idempotent:
   * `StaticWorld.build()` returns immediately when nothing is dirty, so many
   * callers asking in the same frame produce at most one rebuild between them.
   */
  rebuildStatic() {
    if (!this.staticWorld.dirty) return;
    this._staticFrame = this.ctx?.time?.frame ?? this._staticFrame;
    this.staticWorld.build();
    this._syncStats();
  }

  get triangleCount() {
    return this.staticWorld.triCount;
  }

  /**
   * Fallback path so the game is playable while `world` is still a stub, and so
   * a world that never calls addStatic() still collides.
   */
  _ensureStatics(force = false) {
    if (this._explicitStatics > 0) return;
    const scene = this.ctx?.scene;
    if (!scene) return;
    let meshCount = 0;
    scene.traverse((o) => {
      if (o.isMesh || o.isInstancedMesh) meshCount++;
    });
    if (!force && meshCount === this._lastMeshCount) return;
    this._lastMeshCount = meshCount;

    this._dropAutoStatics();
    if (meshCount > 0) {
      let tris = 0;
      scene.traverse((o) => {
        if (!(o.isMesh || o.isInstancedMesh)) return;
        if (tris > 400000) return;
        if (o.userData?.collision === false || o.userData?.noCollision) return;
        // `render` seeds a throwaway blockout (userData.owProbe) before the real
        // level exists and deletes it the moment anything else appears — never
        // build collision for scaffolding.
        if (o.userData?.owProbe) return;
        if (o.name && SKIP_NAME.test(o.name)) return;
        const m = o.material;
        if (m && !Array.isArray(m) && (m.isSpriteMaterial || m.isPointsMaterial)) return;
        const id = this.staticWorld.addMesh(o, undefined, LAYER.STATIC);
        if (id >= 0) {
          this._autoIds.push(id);
          tris += this.staticWorld.objects[id].triCount;
        }
      });
    }

    // Last resort: a ground plane so characters have something to stand on and
    // captures aren't taken of a player falling into the void.
    if (this._autoIds.length === 0 && this._fallbackId < 0) {
      this._fallbackId = this._addFallbackGround();
    }
  }

  _dropAutoStatics() {
    for (const id of this._autoIds) this.staticWorld.removeObject(id);
    this._autoIds.length = 0;
    if (this._fallbackId >= 0) {
      this.staticWorld.removeObject(this._fallbackId);
      this._fallbackId = -1;
    }
  }

  _addFallbackGround() {
    const S = 300;
    const tris = new Float32Array([
      -S, 0, -S, -S, 0, S, S, 0, S,
      -S, 0, -S, S, 0, S, S, 0, -S,
    ]);
    return this.staticWorld.addTriangles(tris, 2, 'concrete', LAYER.STATIC, 'physics:fallback-ground');
  }

  /* ================================================================== */
  /* Queries                                                            */
  /* ================================================================== */

  _nextHit() {
    const h = this._hitPool[this._hitCursor];
    this._hitCursor = (this._hitCursor + 1) % HIT_POOL;
    h.hit = false;
    h.distance = Infinity;
    h.fraction = 1;
    h.object = null;
    h.collider = null;
    h.body = null;
    h.ragdoll = null;
    h.actor = null;
    h.part = null;
    h.triangle = -1;
    h.frontFace = true;
    h.surfaceIndex = 0;
    return h;
  }

  /**
   * Closest-hit ray. Accepts vectors or raw scalars:
   *   raycast(origin, dir, maxDist, mask)
   *   raycast(ox, oy, oz, dx, dy, dz, maxDist, mask)
   * Always returns a Hit record — test `.hit`.
   */
  raycast(a, b, c, d, e, f, g, h) {
    let ox, oy, oz, dx, dy, dz, maxDist, mask;
    if (typeof a === 'number') {
      ox = a; oy = b; oz = c; dx = d; dy = e; dz = f; maxDist = g; mask = h;
    } else {
      ox = a.x; oy = a.y; oz = a.z;
      dx = b.x; dy = b.y; dz = b.z;
      maxDist = c; mask = d;
    }
    if (maxDist === undefined) maxDist = 1000;
    if (mask === undefined) mask = MASK.ALL;
    const out = this._nextHit();
    const l = Math.hypot(dx, dy, dz);
    if (l < 1e-9) {
      out.point.set(ox, oy, oz);
      out.distance = 0;
      return out;
    }
    dx /= l; dy /= l; dz /= l;
    this._rayCount++;
    let best = maxDist;

    const raw = this._raw;
    if (this.staticWorld.raycast(ox, oy, oz, dx, dy, dz, best, mask, raw)) {
      best = raw.t;
      out.hit = true;
      out.distance = raw.t;
      out.point.set(raw.px, raw.py, raw.pz);
      out.normal.set(raw.nx, raw.ny, raw.nz);
      out.surfaceIndex = raw.surface;
      out.triangle = raw.tri;
      out.frontFace = raw.frontFace;
      out.object = this.staticWorld.objects[raw.object]?.mesh ?? null;
    }

    // Nothing solid in the way. Outside world's streamed collision patch that
    // does not mean empty space, it means untriangulated ground, so ask the
    // analytic surface before reporting a miss.
    if (!out.hit && (mask & LAYER.STATIC) !== 0) {
      best = this._refineOnTerrain(ox, oy, oz, dx, dy, dz, best, out);
    }

    best = this._raycastColliders(ox, oy, oz, dx, dy, dz, best, mask, out);
    best = this._raycastBodies(ox, oy, oz, dx, dy, dz, best, mask, out);
    this._raycastRagdolls(ox, oy, oz, dx, dy, dz, best, mask, out);

    if (out.hit) {
      out.fraction = out.distance / maxDist;
      out.surface = surfaceName(out.surfaceIndex);
    } else {
      out.point.set(ox + dx * maxDist, oy + dy * maxDist, oz + dz * maxDist);
      out.normal.set(-dx, -dy, -dz);
      out.distance = maxDist;
      out.surface = 'concrete';
      if ((mask & LAYER.STATIC) !== 0) {
        this._noteWorldHole(ox, oy, oz, dx, dy, dz, maxDist);
      }
    }
    if (this.debug?.enabled) {
      this.debug.logRay(ox, oy, oz, out.point.x, out.point.y, out.point.z);
    }
    return out;
  }

  /**
   * Solve the ray against `world`'s analytic walkable surface. Costs nothing
   * where the streamed world exists, because a real triangle was closer and
   * this is never reached.
   */
  _refineOnTerrain(ox, oy, oz, dx, dy, dz, best, out) {
    const t = this.ground.ray(ox, oy, oz, dx, dy, dz, best);
    if (t < 0) return best;
    const g = this.ground.hit;
    out.hit = true;
    out.distance = t;
    out.point.set(g.px, g.py, g.pz);
    out.normal.set(g.nx, g.ny, g.nz);
    if (out.normal.x * dx + out.normal.y * dy + out.normal.z * dz > 0) {
      out.normal.multiplyScalar(-1);
    }
    out.surfaceIndex = surfaceIndex(g.surface, SURFACE.dirt);
    out.object = null;
    out.collider = null;
    out.body = null;
    out.ragdoll = null;
    out.actor = null;
    out.part = null;
    out.triangle = -1;
    out.frontFace = true;
    return t;
  }

  /**
   * What `world` says the ground height is. Goes through the proxy when it is
   * bound and straight to `world` otherwise, so the hole detector keeps working
   * in exactly the case where the proxy is missing — which is when you need it.
   */
  _refHeight(x, z) {
    const h = this.ground.heightAt(x, z);
    if (Number.isFinite(h)) return h;
    if (this.ground.ready) return NaN;          // genuinely off-map
    const w = this.ctx?.peek?.('world');
    return typeof w?.heightAt === 'function' ? w.heightAt(x, z) : NaN;
  }

  /**
   * A ray that found no world where the world says there IS ground is a bug —
   * it is how combat stops working with nothing in any log. Count every one and
   * say so out loud the first few times, with the position, so the next person
   * gets a lead instead of a mystery.
   */
  _noteWorldHole(ox, oy, oz, dx, dy, dz, maxDist) {
    if (dy > -0.25) return;                 // not looking for a floor
    const h = this._refHeight(ox, oz);      // NaN outside the city footprint
    if (!Number.isFinite(h)) return;
    if (oy < h) return;                     // origin already underground
    // Did the ray actually reach under the ground? A short slanted probe that
    // simply stops short is not a hole, and crying wolf about it would train
    // everyone to ignore the message that matters.
    const he = this._refHeight(ox + dx * maxDist, oz + dz * maxDist);
    if (!Number.isFinite(he) || oy + dy * maxDist > he) return;
    this.worldHoleCount++;
    const settled = this.ground.ready;
    if (settled) this.worldHolesAfterReady++;
    // Two budgets: a few lines while the world is still streaming in (expected,
    // but you should still be able to see it), and a separate, louder one once
    // the proxy is resident — at that point a hole is a genuine defect.
    const budget = settled ? this._holeLogsReady < 4 : this._holeLogs < 3;
    if (!budget) return;
    if (settled) this._holeLogsReady++; else this._holeLogs++;
    console.warn(
      `[physics] NO COLLISION WORLD at (${ox.toFixed(1)}, ${oz.toFixed(1)}): ` +
      `a ray from y=${oy.toFixed(1)} found nothing in ${maxDist.toFixed(0)} m, ` +
      `but world.heightAt says the ground is at y=${h.toFixed(1)}. ` +
      `Bullets and explosives do not work here. ` +
      (settled
        ? 'The analytic ground fallback IS armed, so this is a real defect — report it.'
        : 'Ground fallback not armed yet (world has not initialised).') +
      ` tris=${this.staticWorld.triCount}`
    );
  }

  _raycastColliders(ox, oy, oz, dx, dy, dz, best, mask, out) {
    for (let i = 0; i < this.colliders.length; i++) {
      const c = this.colliders[i];
      if (!c.enabled || (c.layer & mask) === 0) continue;
      const t = c.shape === 'box'
        ? rayObb(ox, oy, oz, dx, dy, dz, c.inverse.elements, c.hx, c.hy, c.hz, best)
        : rayCapsule(ox, oy, oz, dx, dy, dz, c.ax, c.ay, c.az, c.bx, c.by, c.bz, c.radius, best);
      if (t < 0 || t >= best) continue;
      best = t;
      out.hit = true;
      out.distance = t;
      out.point.set(ox + dx * t, oy + dy * t, oz + dz * t);
      this._colliderNormal(c, out.point, out.normal, dx, dy, dz);
      out.surfaceIndex = c.surfaceIndex;
      out.object = c.owner;
      out.collider = c;
      out.actor = c.owner;
      out.part = c.part;
      out.body = null;
      out.ragdoll = null;
      out.triangle = -1;
      out.frontFace = true;
    }
    return best;
  }

  _colliderNormal(c, point, outN, dx, dy, dz) {
    if (c.shape === 'box') {
      _v.copy(point).applyMatrix4(c.inverse);
      const ax = Math.abs(_v.x) / c.hx;
      const ay = Math.abs(_v.y) / c.hy;
      const az = Math.abs(_v.z) / c.hz;
      if (ax >= ay && ax >= az) outN.set(Math.sign(_v.x) || 1, 0, 0);
      else if (ay >= az) outN.set(0, Math.sign(_v.y) || 1, 0);
      else outN.set(0, 0, Math.sign(_v.z) || 1);
      outN.transformDirection(c.matrix);
    } else {
      closestPtSegSeg(
        point.x, point.y, point.z, point.x, point.y, point.z,
        c.ax, c.ay, c.az, c.bx, c.by, c.bz, this._cl
      );
      outN.set(point.x - this._cl.bx, point.y - this._cl.by, point.z - this._cl.bz);
      if (outN.lengthSq() < 1e-12) outN.set(-dx, -dy, -dz);
      else outN.normalize();
    }
    if (outN.x * dx + outN.y * dy + outN.z * dz > 0) outN.multiplyScalar(-1);
  }

  _raycastBodies(ox, oy, oz, dx, dy, dz, best, mask, out) {
    if ((mask & LAYER.DEBRIS) === 0) return best;
    const list = this.bodies.bodies;
    for (let i = 0; i < list.length; i++) {
      const b = list[i];
      let t;
      if (b.shape === 'sphere') {
        t = raySphere(ox, oy, oz, dx, dy, dz, b.position.x, b.position.y, b.position.z, b.radius, best);
      } else {
        _m4.compose(b.position, b.quaternion, _one);
        _m4i.copy(_m4).invert();
        t = b.shape === 'capsule'
          ? rayObb(ox, oy, oz, dx, dy, dz, _m4i.elements, b.radius, b.halfHeight + b.radius, b.radius, best)
          : rayObb(ox, oy, oz, dx, dy, dz, _m4i.elements, b.hx, b.hy, b.hz, best);
      }
      if (t < 0 || t >= best) continue;
      best = t;
      out.hit = true;
      out.distance = t;
      out.point.set(ox + dx * t, oy + dy * t, oz + dz * t);
      out.normal.set(
        out.point.x - b.position.x,
        out.point.y - b.position.y,
        out.point.z - b.position.z
      );
      if (out.normal.lengthSq() < 1e-12) out.normal.set(-dx, -dy, -dz);
      else out.normal.normalize();
      out.surfaceIndex = b.surface;
      out.object = b.object3D ?? null;
      out.body = b;
      out.collider = null;
      out.ragdoll = null;
      out.triangle = -1;
    }
    return best;
  }

  _raycastRagdolls(ox, oy, oz, dx, dy, dz, best, mask, out) {
    if ((mask & LAYER.RAGDOLL) === 0) return best;
    for (let r = 0; r < this.ragdolls.length; r++) {
      const rd = this.ragdolls[r];
      if (!segmentHitsAabb(ox, oy, oz, dx, dy, dz, best, rd.aabb, 0.2)) continue;
      for (let i = 0; i < rd.boneCount; i++) {
        const a = rd.boneHead[i], c = rd.boneTail[i];
        const t = rayCapsule(
          ox, oy, oz, dx, dy, dz,
          rd.px[a], rd.py[a], rd.pz[a],
          rd.px[c], rd.py[c], rd.pz[c],
          rd.boneRadius[i], best
        );
        if (t < 0 || t >= best) continue;
        best = t;
        out.hit = true;
        out.distance = t;
        out.point.set(ox + dx * t, oy + dy * t, oz + dz * t);
        closestPtSegSeg(
          out.point.x, out.point.y, out.point.z, out.point.x, out.point.y, out.point.z,
          rd.px[a], rd.py[a], rd.pz[a], rd.px[c], rd.py[c], rd.pz[c], this._cl
        );
        out.normal.set(
          out.point.x - this._cl.bx,
          out.point.y - this._cl.by,
          out.point.z - this._cl.bz
        );
        if (out.normal.lengthSq() < 1e-12) out.normal.set(-dx, -dy, -dz);
        else out.normal.normalize();
        out.surfaceIndex = SURFACE.flesh;
        out.ragdoll = rd;
        out.object = rd.actor;
        out.actor = rd.actor;
        out.part = rd.spec[i]?.name ?? null;
        out.collider = null;
        out.body = null;
        out.triangle = -1;
      }
    }
    return best;
  }

  /** Cheap occlusion test — statics only, no ordering, no record. */
  raycastAny(a, b, c, d, e, f, g, h) {
    let ox, oy, oz, dx, dy, dz, maxDist, mask;
    if (typeof a === 'number') {
      ox = a; oy = b; oz = c; dx = d; dy = e; dz = f; maxDist = g; mask = h;
    } else {
      ox = a.x; oy = a.y; oz = a.z;
      dx = b.x; dy = b.y; dz = b.z;
      maxDist = c; mask = d;
    }
    const l = Math.hypot(dx, dy, dz);
    if (l < 1e-9) return false;
    this._rayCount++;
    return this.staticWorld.raycastAny(
      ox, oy, oz, dx / l, dy / l, dz / l,
      maxDist ?? 1000, mask ?? MASK.SIGHT
    );
  }

  /** True when nothing blocks the straight line between two points. */
  lineOfSight(from, to, mask = MASK.SIGHT) {
    const dx = to.x - from.x, dy = to.y - from.y, dz = to.z - from.z;
    const d = Math.hypot(dx, dy, dz);
    if (d < 1e-6) return true;
    return !this.staticWorld.raycastAny(
      from.x, from.y, from.z, dx / d, dy / d, dz / d, d - 1e-3, mask
    );
  }

  sphereCast(origin, dir, radius, maxDist = 100, mask = MASK.WORLD) {
    return this.capsuleCast(origin, origin, radius, dir, maxDist, mask);
  }

  capsuleCast(p0, p1, radius, dir, maxDist = 100, mask = MASK.CHARACTER) {
    const out = this._nextHit();
    let dx = dir.x, dy = dir.y, dz = dir.z;
    const l = Math.hypot(dx, dy, dz);
    if (l < 1e-9) return out;
    dx /= l; dy /= l; dz /= l;
    this._rayCount++;
    const raw = this._raw2;
    if (this.staticWorld.sweepCapsule(
      p0.x, p0.y, p0.z, p1.x, p1.y, p1.z, radius, dx, dy, dz, maxDist, mask, raw
    )) {
      out.hit = true;
      out.distance = raw.t;
      out.fraction = raw.t / maxDist;
      out.point.set(raw.px, raw.py, raw.pz);
      out.normal.set(raw.nx, raw.ny, raw.nz);
      out.surfaceIndex = raw.surface;
      out.surface = surfaceName(raw.surface);
      out.triangle = raw.tri;
      out.object = this.staticWorld.objects[raw.object]?.mesh ?? null;
    } else {
      out.distance = maxDist;
      out.point.set(p0.x + dx * maxDist, p0.y + dy * maxDist, p0.z + dz * maxDist);
      out.normal.set(-dx, -dy, -dz);
    }
    return out;
  }

  /** Contact count; details live in `physics.staticWorld.contacts`. */
  overlapCapsule(p0, p1, radius, mask = MASK.CHARACTER) {
    return this.staticWorld.overlapCapsule(
      p0.x, p0.y, p0.z, p1.x, p1.y, p1.z, radius, mask, 0
    );
  }

  checkCapsule(p0, p1, radius, mask = MASK.CHARACTER) {
    return this.overlapCapsule(p0, p1, radius, mask) === 0;
  }

  overlapSphere(center, radius, mask = MASK.CHARACTER) {
    return this.staticWorld.overlapCapsule(
      center.x, center.y, center.z, center.x, center.y, center.z, radius, mask, 0
    );
  }

  /** Floor height under (x, z). Returns -Infinity if there is no floor. */
  groundHeight(x, z, fromY = 200, mask = MASK.WORLD) {
    const h = this.raycast(x, fromY, z, 0, -1, 0, 1000, mask);
    return h.hit ? h.point.y : -Infinity;
  }

  /* ================================================================== */
  /* Characters                                                         */
  /* ================================================================== */

  createCharacter(opts = {}) {
    const c = new CharacterController(this.staticWorld, {
      radius: UNITS.playerRadius,
      height: UNITS.playerHeight,
      blockers: this.blockers,
      ...opts,
    });
    this.characters.push(c);
    return c;
  }

  /**
   * Refresh the vehicle blocker set. Called once per fixed step, not once per
   * character: every capsule in the world reads the same snapshot.
   *
   * `vehicles` is reached through `ctx` at runtime and only ever READ — hard
   * rule 2, and `src/vehicles` has a live owner. `v.position`, `v.spec.dims`,
   * `v.driver` and `v.occupants` are the whole contract used here.
   */
  _refreshBlockers(ctx) {
    const b = this.blockers;
    b.n = 0;
    if (this._noVehicleBlock) return;
    const veh = this._vehicles ?? (this._vehicles = ctx.peek('vehicles'));
    const list = veh?.vehicles;
    if (!Array.isArray(list)) return;
    for (let i = 0; i < list.length && b.n < MAX_BLOCKERS; i++) {
      const v = list[i];
      if (!v || v.destroyed || v._staged) continue;
      /*
       * A FLYING helicopter is not a wall.
       *
       * `vehicles` publishes `blocksPeds`, which its rotor controller flips at
       * 2.0 m altitude. Without honouring it the
       * cut happens where the BOUNDING BOX says instead: a Riverhop's box is
       * 3.3 m tall, so it would go on blocking pedestrians for another 1.3 m of
       * climb, and a low pass down a street would shove people aside from above
       * the shopfronts.
       *
       * The vertical gate below independently exempts anything well overhead,
       * so this is belt and braces — but it is the half that carries the
       * authored intent, and it costs one comparison.
       */
      if (v.blocksPeds === false) continue;
      const d = v.spec?.dims;
      if (!d) continue;
      const k = b.n++;
      b.x[k] = v.position.x;
      b.y[k] = v.position.y;
      b.z[k] = v.position.z;
      b.r[k] = (Math.max(d.W, d.L) / 2) * BLOCK_R + BLOCK_SKIN;
      b.h[k] = d.H * 0.5;
      b.obj[k] = v;
    }
  }

  removeCharacter(c) {
    const i = this.characters.indexOf(c);
    if (i >= 0) this.characters.splice(i, 1);
  }

  /* ================================================================== */
  /* Ballistics                                                         */
  /* ================================================================== */

  /**
   * Trace a round through the world, penetrating what it can.
   * Emits `bullet:impact` for every entry and every exit.
   * Returns an array of impact records (reused; copy what you keep).
   */
  fireBullet(opts) {
    const n = this.ballistics.fire({ rng: this.rng, ...opts });
    const res = this._impactResult;
    res.length = 0;
    for (let i = 0; i < n; i++) res.push(this.ballistics.impacts[i]);
    return res;
  }

  emitImpact(px, py, pz, nx, ny, nz, dx, dy, dz, si, damage, exit, hit) {
    const p = this._impactPool[this._impactCursor];
    this._impactCursor = (this._impactCursor + 1) % IMPACT_POOL;
    p.point.set(px, py, pz);
    p.normal.set(nx, ny, nz);
    p.incident.set(dx, dy, dz);
    p.surfaceIndex = si;
    p.surface = surfaceName(si);
    p.damage = damage;
    p.exit = exit;
    p.object = hit?.object ?? null;
    p.body = hit?.body ?? null;
    p.actor = hit?.actor ?? null;
    p.part = hit?.part ?? null;
    this.ctx.events.emit('bullet:impact', p);

    if (p.actor && !exit) {
      this.ctx.events.emit('damage:dealt', {
        target: p.actor,
        amount: damage * (hit?.collider?.damageScale ?? 1),
        headshot: hit?.part === 'head',
        killed: false,
        point: p.point,
      });
    }
  }

  /**
   * Radial blast: shoves rigid bodies and ragdolls, occluded by the world so a
   * grenade behind a wall doesn't throw the crate in front of it.
   */
  explode(e) {
    if (!e) return;
    const pos = e.position ?? e;
    const radius = e.radius ?? 5;
    const strength = e.impulse ?? (e.damage ?? 100) * 0.9;
    this.bodies.applyRadialImpulse(pos.x, pos.y, pos.z, radius, strength * 0.06);
    for (const rd of this.ragdolls) {
      const cx = (rd.aabb.minx + rd.aabb.maxx) * 0.5;
      const cy = (rd.aabb.miny + rd.aabb.maxy) * 0.5;
      const cz = (rd.aabb.minz + rd.aabb.maxz) * 0.5;
      const dx = cx - pos.x, dy = cy - pos.y, dz = cz - pos.z;
      const d = Math.hypot(dx, dy, dz);
      if (d > radius) continue;
      _v.set(cx, cy, cz);
      if (!this.lineOfSight(pos, _v, MASK.EXPLOSION)) continue;
      const f = (1 - d / radius) * strength * 0.5;
      const inv = 1 / (d || 1e-4);
      rd.applyImpulse(pos.x, pos.y, pos.z, dx * inv * f, dy * inv * f + f * 0.4, dz * inv * f, radius);
    }
  }

  /* ================================================================== */
  /* Rigid bodies                                                       */
  /* ================================================================== */

  addRigidBody(opts = {}) {
    const b = new RigidBody(opts);
    if (opts.surfaceType) b.surface = surfaceIndex(opts.surfaceType);
    this.bodies.add(b);
    return b;
  }

  removeRigidBody(b) {
    this.bodies.remove(b);
  }

  /** Convenience for fx: a tumbling chunk with sensible defaults. */
  spawnDebris(position, velocity, opts = {}) {
    const s = opts.size ?? 0.08;
    const si = surfaceIndex(opts.surface ?? 'concrete');
    const b = this.addRigidBody({
      shape: opts.shape ?? 'box',
      halfExtents: { x: s, y: s * 0.7, z: s * 0.85 },
      radius: s,
      mass: opts.mass ?? Math.max(0.01, s * s * s * 4 * (SURFACE_PROPS[si]?.density ?? 2000)),
      position,
      velocity,
      restitution: opts.restitution ?? SURFACE_PROPS[si].restitution,
      friction: opts.friction ?? SURFACE_PROPS[si].friction,
      lifetime: opts.lifetime ?? 20,
      surface: si,
      object3D: opts.object3D ?? null,
      onImpact: opts.onImpact ?? null,
    });
    const r = this.rng;
    b.angularVelocity.set(r.signed() * 14, r.signed() * 14, r.signed() * 14);
    return b;
  }

  /* ================================================================== */
  /* Ragdolls                                                           */
  /* ================================================================== */

  createRagdoll(opts = {}) {
    while (this.ragdolls.length >= this.maxRagdolls) {
      this.ragdolls.shift()?.dispose();
    }
    const rd = new Ragdoll(this.staticWorld, { gravity: this.gravity, ...opts });
    if (opts.velocity) rd.setVelocity(opts.velocity.x, opts.velocity.y, opts.velocity.z);
    if (opts.impulse && opts.point) {
      rd.applyImpulse(
        opts.point.x, opts.point.y, opts.point.z,
        opts.impulse.x, opts.impulse.y, opts.impulse.z,
        opts.impulseRadius ?? 0.45
      );
    }
    this.ragdolls.push(rd);
    return rd;
  }

  /**
   * Take over a SkinnedMesh's skeleton. `ai` calls this on death and stops
   * driving the animation; from then on bone transforms are written every frame.
   */
  createRagdollFromSkeleton(skinnedMesh, opts = {}) {
    const skeleton = skinnedMesh?.skeleton ?? skinnedMesh;
    if (!skeleton?.bones?.length) return null;
    const { spec, boneMap } = specFromSkeleton(skeleton, opts);
    if (!spec.length) return null;
    const rd = this.createRagdoll({ ...opts, bones: spec, transform: null });
    rd.adoptSkeleton(skeleton, boneMap);
    rd.actor = opts.actor ?? skinnedMesh;
    return rd;
  }

  removeRagdoll(rd) {
    const i = this.ragdolls.indexOf(rd);
    if (i >= 0) this.ragdolls.splice(i, 1);
    rd.dispose();
  }

  _handleDeath(e) {
    if (this.ignoreDeathEvents || !e) return;
    const actor = e.actor;
    if (!actor || actor.__ragdoll) return;
    const skinned = actor.isSkinnedMesh ? actor : (actor.skinnedMesh ?? actor.mesh ?? null);
    const skeleton = actor.skeleton ?? skinned?.skeleton ?? null;
    if (!skeleton || actor.ragdoll === false) return;
    const rd = this.createRagdollFromSkeleton(skinned ?? { skeleton }, {
      actor,
      mass: actor.mass ?? 82,
    });
    if (rd) {
      actor.__ragdoll = rd;
      if (e.impulse && e.point) {
        rd.applyImpulse(e.point.x, e.point.y, e.point.z, e.impulse.x, e.impulse.y, e.impulse.z, 0.4);
      }
    }
  }

  /* ================================================================== */
  /* Dynamic colliders / hitboxes                                       */
  /* ================================================================== */

  addCollider(opts = {}) {
    const c = new Collider(opts);
    this.colliders.push(c);
    return c;
  }

  removeCollider(c) {
    const i = this.colliders.indexOf(c);
    if (i >= 0) this.colliders.splice(i, 1);
  }

  /* ================================================================== */
  /* Frame                                                              */
  /* ================================================================== */

  fixedUpdate(h, ctx) {
    const t0 = performance.now();

    // `world` initialises after `physics` (it depends on it), so the analytic
    // fallback can only be armed once it exists. Bind, no build, no triangles.
    if (!this._groundStarted) {
      const w = ctx.peek('world');
      if (w) this._groundStarted = this.ground.bind(w);
    }

    if (this._explicitStatics === 0) {
      this._autoScanTimer += h;
      if (this._autoScanTimer > 0.4) {
        this._autoScanTimer = 0;
        this._ensureStatics(false);
      }
    }
    /**
     * THE BACKSTOP, NOT THE SCHEDULER.
     *
     * This used to be a bare `if (dirty) build()`, which runs on the very next
     * PHYSICS STEP — 120 Hz. `world` debounces its own republish by 12 frames
     * on purpose, `buildings` by 0.35 s and `props` by 0.4 s, and this line
     * pre-empted all three: whoever marked dirty got a rebuild within 8 ms
     * whether they wanted one or not. With a full 329k-triangle rebuild behind
     * it that was one 139 ms freeze every 0.58 s standing still.
     *
     * Now the callers own the timing and this only guarantees the tree cannot
     * stay stale, honouring the longest deliberate debounce in the engine. The
     * one thing that still cannot wait is having NO collision at all, so a
     * world with nothing resident publishes immediately.
     */
    const sw = this.staticWorld;
    if (sw.dirty) {
      const frame = ctx.time?.frame ?? 0;
      // ARCHITECTURE.md hard rule 8: never build more than the streaming budget
      // in one frame. `world` spends the whole of `tileBuildBudgetMs` on
      // geometry in update(), so collision takes half of it and no more.
      //
      // ...EXCEPT under `deterministic` (capture mode), where 0 means "no
      // budget" and the whole pending set lands in one call. A millisecond
      // budget decides how many objects arrive per build, so on a loaded
      // machine `deferred` stays positive, `dirty` stays true — and `props`
      // will not run its wall pass against a stale BVH, so ghost signs, ivy,
      // flyposting and aerosol simply never appear in that run's photograph.
      // Same reasoning as `engine.js` skipping FIXED_STEP_BUDGET_MS: the pixel
      // gate needs the capture path to resolve identically every run.
      sw.budgetMs = ctx.config?.deterministic === true
        ? 0
        : Math.min(4, Math.max(1.5, (ctx.config?.q?.tileBuildBudgetMs ?? 4) * 0.5));
      const urgent = sw.triCount === 0;      // no floor anywhere yet
      const inFlight = sw.deferred > 0;      // the budget split the last build
      if (frame !== this._staticFrame &&
          (urgent || inFlight || frame - this._staticFrame >= STATIC_BACKSTOP_FRAMES)) {
        this._staticFrame = frame;
        sw.build();
        this._syncStats();
      }
    }

    if (this._pendingDemo && this.staticWorld.triCount > 0) {
      this._pendingDemo = false;
      this._spawnDemo();
    }

    this._refreshBlockers(ctx);

    this.bodies.step(h);
    for (let i = 0; i < this.ragdolls.length; i++) this.ragdolls[i].step(h);

    this.stats.stepMs = performance.now() - t0;
    this.stats.awake = this.bodies.awakeCount;
    this.stats.raycasts = this._rayCount;
    this._rayCount = 0;
  }

  update(dt, ctx) {
    // Interpolate rigid bodies into their render transforms using the engine's
    // physics alpha so debris never strobes when the frame rate dips.
    const alpha = ctx.time.alpha;
    const list = this.bodies.bodies;
    for (let i = 0; i < list.length; i++) {
      const b = list[i];
      const o = b.object3D;
      if (!o) continue;
      if (b.sleeping) {
        o.position.copy(b.position);
        o.quaternion.copy(b.quaternion);
      } else {
        o.position.lerpVectors(b.prevPosition, b.position, alpha);
        o.quaternion.copy(b.prevQuaternion).slerp(b.quaternion, alpha);
      }
    }
  }

  lateUpdate(dt, ctx) {
    for (let i = 0; i < this.ragdolls.length; i++) {
      const rd = this.ragdolls[i];
      if (rd.bones3D) rd.writeToSkeleton();
    }
    if (this.debug?.enabled) this.debug.rebuild(this, ctx.camera, dt);
    this.stats.bodies = this.bodies.bodies.length;
    this.stats.ragdolls = this.ragdolls.length;
    this.stats.characters = this.characters.length;
    this.stats.colliders = this.colliders.length;
    this.stats.groundFallbackHits = this.ground.hits;
    this.stats.truncatedContacts = this.staticWorld.truncations.contacts;
    this.stats.truncatedTraversals = this.staticWorld.truncations.traversal;
    this.stats.worldHoles = this.worldHoleCount;
    this.stats.worldHolesAfterReady = this.worldHolesAfterReady;
    this.stats.rejectedStatics = this.rejectedStatics;
  }

  _syncStats() {
    const bs = this.staticWorld.buildStats;
    this.stats.triangles = this.staticWorld.triCount;
    this.stats.nodes = this.staticWorld.nodeCount;
    this.stats.buildMs = this.staticWorld.buildMs;
    this.stats.staticBuilds = bs.builds;
    this.stats.staticTrisProcessed = bs.builtTris + bs.refitTris;
    this.stats.staticRefits = bs.refits;
    this.stats.staticCompactions = bs.compactions;
    this.stats.staticParts = this.staticWorld.partCount;
    this.stats.staticDeferred = this.staticWorld.deferred;
    let n = 0;
    for (const o of this.staticWorld.objects) if (o && o.alive) n++;
    this.stats.objects = n;
    this.stats.staticObjects = n;
    // One line per meaningful rebuild so other agents can see, in the capture
    // log, whether their geometry actually reached the collision world. Rate
    // limited: incremental rebuilds are cheap enough to happen several times a
    // second, and a console line per one of those is its own frame cost.
    const now = performance.now();
    if (this.stats.triangles !== this._loggedTris && now - this._loggedAt >= 500) {
      this._loggedTris = this.stats.triangles;
      this._loggedAt = now;
      const src = this._explicitStatics > 0
        ? `${this._explicitStatics} registered`
        : this._autoIds.length
          ? `${this._autoIds.length} auto-scanned`
          : 'fallback ground';
      console.info(
        `[physics] ${this.stats.triangles} tris / ${this.stats.nodes} nodes · ` +
        `${this.staticWorld.buildMs.toFixed(1)}ms · ${src}`
      );
    }
  }

  /* ================================================================== */
  /* Debug                                                              */
  /* ================================================================== */

  /**
   * Toggle the collision wireframe. Other agents: call this to see exactly what
   * physics thinks your geometry is.
   *   phys.setDebugDraw(true, { nodes: true, radius: 25 })
   */
  setDebugDraw(on, opts = {}) {
    if (!this.debug) return;
    if (opts.triangles !== undefined) this.debug.showTriangles = opts.triangles;
    if (opts.nodes !== undefined) this.debug.showNodes = opts.nodes;
    if (opts.rays !== undefined) this.debug.showRays = opts.rays;
    if (opts.radius !== undefined) this.debug.radius = opts.radius;
    this.debug.setEnabled(on);
  }

  toggleDebugDraw() {
    this.setDebugDraw(!this.debug?.enabled);
    return this.debug?.enabled ?? false;
  }

  /** Named states for dev overlays / the capture harness. */
  debugState(name) {
    if (name === 'collision') this.setDebugDraw(true, { triangles: true, nodes: false });
    else if (name === 'bvh') this.setDebugDraw(true, { triangles: false, nodes: true });
    else if (name === 'demo') this._spawnDemo();
    else if (name === 'off') this.setDebugDraw(false);
    return this.stats;
  }

  /**
   * Drop a ragdoll and a pile of debris in front of the camera and turn the
   * wireframe on. Purely a verification aid for whoever is looking at the
   * collision system; nothing in the game calls it.
   */
  _spawnDemo() {
    this.setDebugDraw(true, { triangles: true, radius: 30 });
    const cam = this.ctx.camera;
    const fwd = _v.set(0, 0, -1).applyQuaternion(cam.quaternion);
    const cx = cam.position.x + fwd.x * 6;
    const cz = cam.position.z + fwd.z * 6;
    const floor = this.groundHeight(cx, cz, cam.position.y + 20);
    const base = Number.isFinite(floor) ? floor : 0;
    const r = this.rng;
    for (let i = 0; i < 14; i++) {
      this.spawnDebris(
        { x: cx + r.signed() * 1.6, y: base + 1.2 + i * 0.22, z: cz + r.signed() * 1.6 },
        { x: r.signed() * 2, y: 0, z: r.signed() * 2 },
        { size: 0.09 + r.float() * 0.06, surface: r.pick(['concrete', 'wood', 'metal']), lifetime: 1e9 }
      );
    }
    const m = _m4.makeTranslation(cx + 1.5, base + 1.15, cz);
    const rd = this.createRagdoll({ transform: m, height: 1.82, mass: 84 });
    rd.setVelocity(-1.2, 0.2, 0.4);
    return this.stats;
  }

  dispose() {
    this.ctx?.events.off('explosion', this._onExplosion);
    this.ctx?.events.off('actor:death', this._onDeath);
    this.debug?.dispose();
    this.debug = null;
    this.ground.dispose();
    this._groundStarted = false;
    this.bodies.clear();
    for (const rd of this.ragdolls) rd.dispose();
    this.ragdolls.length = 0;
    this.characters.length = 0;
    this.colliders.length = 0;
    this.staticWorld.dispose();
  }
}

/* ------------------------------------------------------------------ */

function segmentHitsAabb(ox, oy, oz, dx, dy, dz, len, ab, pad = 0) {
  const ix = 1 / (dx !== 0 ? dx : 1e-30);
  const iy = 1 / (dy !== 0 ? dy : 1e-30);
  const iz = 1 / (dz !== 0 ? dz : 1e-30);
  let t0 = (ab.minx - pad - ox) * ix, t1 = (ab.maxx + pad - ox) * ix;
  let lo = Math.min(t0, t1), hi = Math.max(t0, t1);
  t0 = (ab.miny - pad - oy) * iy; t1 = (ab.maxy + pad - oy) * iy;
  lo = Math.max(lo, Math.min(t0, t1));
  hi = Math.min(hi, Math.max(t0, t1));
  t0 = (ab.minz - pad - oz) * iz; t1 = (ab.maxz + pad - oz) * iz;
  lo = Math.max(lo, Math.min(t0, t1));
  hi = Math.min(hi, Math.max(t0, t1));
  return hi >= Math.max(0, lo) && lo <= len;
}

export { LAYER, MASK, SURFACE, SURFACE_NAMES, SURFACE_PROPS, humanoidSpec, CharacterController, RigidBody, Ragdoll };
