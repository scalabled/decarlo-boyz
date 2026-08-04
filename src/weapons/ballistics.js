import * as THREE from 'three';
import { latheZ, rodZ, tubeZ, extrude, mergeAll } from './geometry.js';
import { VehicleHitTest } from './vehiclehit.js';

/**
 * BALLISTICS — every shot in this game is a travelling body, not a hitscan.
 *
 * ---------------------------------------------------------------------------
 * WHY THAT MATTERS MORE HERE THAN IN A MILITARY SHOOTER
 * ---------------------------------------------------------------------------
 * The fastest thing in the improvised arsenal is a structural rivet at 240 m/s,
 * which is a THIRD of an assault rifle's muzzle velocity. The slowest is a
 * depth charge at 24 m/s, which you throw like a bowling ball. Nothing in the
 * set can be modelled as an instantaneous line, and none of it should be:
 * leading a moving target and judging a lob over cover IS the skill of these
 * weapons, and a projectile that takes 2.5 s to arrive is a projectile the
 * player watches. So the heavy ordnance carries a real MESH — you see a nitrous
 * bottle tumbling through the air, not an orange streak.
 *
 * ---------------------------------------------------------------------------
 * WHERE THE NUMBERS COME FROM
 * ---------------------------------------------------------------------------
 * `lib.js` derives everything from the weapon's `lib` row: `dmg` is the
 * damage carried, `range` sets the muzzle velocity that gets it there on a
 * believable arc, and `dropoff` is the fraction of damage still on it at
 * `range`. `maxRange` (1.6x `range`) is where it is deleted, so a shot past the
 * effective distance still connects — just weakly.
 *
 * ---------------------------------------------------------------------------
 * BEHAVIOURS
 * ---------------------------------------------------------------------------
 *   plain      nail / tack / rivet / bullet — contact, then `physics`
 *   mark       paint — contact, then a splat and a blinded target (`paint.js`)
 *   burn       flare — a light source in flight, and it keeps burning where it
 *              lands (`ignites`, `burnSeconds` -> `fire.js`)
 *   pin        spear / harpoon — sticks into what it hits and stays there
 *   tether     harpoon — a real distance constraint reels the target in and
 *              holds it at arm's length (`tether.js`)
 *   motor      rocket — accelerates under thrust, so the lob straightens out
 *   fuse       depth charge — BOUNCES, arms on a timer, detonates on water
 *   emp        coil — 34 on contact, then the capacitor bank arcs to every
 *              vehicle within `empRadius`
 *
 * Terminal effects go to `physics.fireBullet()` so wall penetration, spall and
 * `bullet:impact` stay in one place; explosions go out as the canonical
 * `explosion` event, which `physics`, `vehicles`, `peds`, `police`, `fx`, `ui`
 * and `traffic` all already consume.
 */

const GRAVITY = -9.81;
const MAX_LIVE = 96;
/** Water is at y = 0 in this world (`world` puts the rivers on the plane). */
const SEA_LEVEL = 0;

class Projectile {
  constructor() {
    this.alive = false;
    this.pos = new THREE.Vector3();
    this.prev = new THREE.Vector3();
    this.vel = new THREE.Vector3();
    this.dir = new THREE.Vector3();
    this.spin = new THREE.Vector3();
    this.damage = 30;
    this.penetration = 1;
    this.dragK = 0.3;
    this.travelled = 0;
    this.maxRange = 400;
    this.age = 0;
    this.dropoff = 0.5;
    this.weapon = null;
    this.mask = undefined;
    this.kind = 'bullet';
    this.gravityScale = 1;
    /* explosive */
    this.explodes = false;
    this.splash = 0;
    this.fuse = 0;
    this.bounces = false;
    this.waterTrigger = false;
    this.bounced = 0;
    /* motor */
    this.thrust = 0;
    this.thrustTime = 0;
    this.topSpeed = 0;
    /* special */
    this.emp = false;
    this.empRadius = 0;
    this.empSeconds = 0;
    this.tethered = false;
    this.pins = false;
    this.ignites = false;
    this.marks = false;
    this.visual = null;
    this.light = 0;
  }
}

/* ========================================================================== */
/*  Flying ordnance you can actually see                                      */
/* ========================================================================== */

/**
 * Pooled meshes for the projectiles that are slow and large enough to read in
 * flight, plus the ones that stay in the world after they land.
 *
 * Everything shares the material instances the sixteen weapon models already
 * use, which matters for two reasons: the programs are compiled by the time the
 * first shot leaves the barrel (the weapon in the hand warmed them), and the
 * pool costs nine geometries and zero materials.
 */
const ARCHETYPE = {
  gob: { count: 24, mat: 'imp_paint_teal' },
  burn: { count: 5, mat: 'glow_flare' },
  shaft: { count: 8, mat: 'imp_steel' },
  bottle: { count: 4, mat: 'imp_paint_blue' },
  drum: { count: 4, mat: 'imp_rust' },
  rocket: { count: 4, mat: 'imp_galv' },
  orb: { count: 5, mat: 'glow_arc' },
};

const KIND_VISUAL = {
  paint: 'gob',
  flare: 'burn',
  spear: 'shaft',
  harpoon: 'shaft',
  nitro: 'bottle',
  drum: 'drum',
  rocket: 'rocket',
  coil: 'orb',
};

function archetypeGeometry(name) {
  switch (name) {
    case 'gob': {
      /* An irregular gob of enamel, not a sphere: it is a thrown liquid. */
      const g = new THREE.SphereGeometry(0.026, 7, 5);
      const p = g.attributes.position;
      for (let i = 0; i < p.count; i++) {
        const s = 1 + Math.sin(i * 2.399) * 0.22;
        p.setXYZ(i, p.getX(i) * s, p.getY(i) * (2 - s) * 0.9, p.getZ(i) * s);
      }
      g.computeVertexNormals();
      return g;
    }
    case 'burn':
      return new THREE.SphereGeometry(0.055, 10, 8);
    case 'orb':
      return new THREE.SphereGeometry(0.048, 10, 8);
    case 'shaft': {
      /* 0.72 m of 8 mm stainless with a barbed head — the harpoon and the
       * spear share it; the harpoon is scaled up 1.25x at acquire time. */
      const rod = rodZ(0.004, 0.004, 0.62, 8, 0.0006);
      rod.translate(0, 0, 0.31);
      const head = latheZ([[0, 0], [-0.085, 0.0125], [-0.05, 0.0135], [0, 0.004]], 8);
      const barb = extrude([[0, 0], [0.05, -0.014], [0.052, -0.006], [0.006, 0.006]], 0.0022);
      barb.rotateY(Math.PI / 2);
      barb.translate(0, 0.006, -0.02);
      const barb2 = barb.clone();
      barb2.rotateZ(Math.PI);
      return mergeAll([rod, head, barb, barb2]);
    }
    case 'bottle': {
      /* A 10 lb nitrous bottle, the same silhouette as the one strapped to the
       * launcher — the round IS the thing you can see riding on the weapon. */
      const b = latheZ(
        [[-0.135, 0], [-0.132, 0.026], [-0.124, 0.042], [-0.116, 0.052],
          [0.10, 0.052], [0.112, 0.044], [0.122, 0.026], [0.128, 0.016],
          [0.142, 0.014], [0.142, 0]],
        12
      );
      return b;
    }
    case 'drum': {
      const d = latheZ(
        [[-0.145, 0], [-0.145, 0.09], [-0.128, 0.098], [-0.09, 0.098],
          [-0.085, 0.104], [-0.05, 0.104], [-0.045, 0.098], [0.045, 0.098],
          [0.05, 0.104], [0.085, 0.104], [0.09, 0.098], [0.128, 0.098],
          [0.145, 0.09], [0.145, 0]],
        14
      );
      return d;
    }
    case 'rocket': {
      const body = latheZ(
        [[-0.28, 0], [-0.28, 0.028], [-0.05, 0.030], [0.10, 0.030],
          [0.16, 0.024], [0.20, 0.010], [0.205, 0]],
        12
      );
      const fins = [];
      for (let i = 0; i < 4; i++) {
        const f = extrude([[0, 0], [0.09, 0], [0.06, 0.046], [0, 0.05]], 0.0018);
        f.rotateY(Math.PI / 2);
        f.rotateZ((i / 4) * Math.PI * 2);
        f.translate(0, 0, -0.26);
        fins.push(f);
      }
      return mergeAll([body, ...fins]);
    }
    default:
      return new THREE.SphereGeometry(0.03, 6, 4);
  }
}

class VisualPool {
  constructor(ctx, mats) {
    this.ctx = ctx;
    this.geoms = [];
    this.pools = new Map();
    this.root = new THREE.Object3D();
    this.root.name = 'weapon-projectiles';
    ctx.scene.add(this.root);

    for (const name in ARCHETYPE) {
      const spec = ARCHETYPE[name];
      const geo = archetypeGeometry(name);
      this.geoms.push(geo);
      const mat = mats.get(spec.mat);
      const list = [];
      const emissive = spec.mat.startsWith('glow_');
      for (let i = 0; i < spec.count; i++) {
        const m = new THREE.Mesh(geo, mat);
        m.visible = false;
        m.castShadow = !emissive;
        m.frustumCulled = false;
        m.userData.owNoPrepass = true;
        if (emissive) {
          m.userData.owNoShadow = true;
          m.renderOrder = 3;
        }
        this.root.add(m);
        list.push(m);
      }
      this.pools.set(name, list);
    }
  }

  acquire(kind) {
    const name = KIND_VISUAL[kind];
    if (!name) return null;
    const list = this.pools.get(name);
    if (!list) return null;
    for (let i = 0; i < list.length; i++) {
      if (!list[i].visible) {
        list[i].visible = true;
        list[i].scale.setScalar(kind === 'harpoon' ? 1.25 : 1);
        return list[i];
      }
    }
    return null;
  }

  release(mesh) {
    if (mesh) mesh.visible = false;
  }

  dispose() {
    for (const g of this.geoms) g.dispose();
    this.geoms.length = 0;
    this.root.removeFromParent();
  }
}

/* ========================================================================== */
/*  Things that stay where they landed                                        */
/* ========================================================================== */

/**
 * A spear in a wall is worth more than any impact decal: it is a piece of
 * authored detail that the player put there, it stays for half a minute, and
 * it is the only physical record that the harpoon is a harpoon. Eight of them
 * ride a ring buffer, so the twenty-fifth shot silently reclaims the oldest.
 */
class StuckPool {
  constructor(ctx, mats, geo, count = 8) {
    this.ctx = ctx;
    this.items = [];
    this.root = new THREE.Object3D();
    this.root.name = 'weapon-stuck';
    ctx.scene.add(this.root);
    const mat = mats.get('imp_steel');
    for (let i = 0; i < count; i++) {
      const m = new THREE.Mesh(geo, mat);
      m.visible = false;
      m.castShadow = true;
      m.frustumCulled = false;
      this.root.add(m);
      this.items.push({ mesh: m, until: -1 });
    }
    this.cursor = 0;
    this._q = new THREE.Quaternion();
    this._up = new THREE.Vector3(0, 0, 1);
  }

  place(point, dir, scale, seconds) {
    let slot = null;
    for (const it of this.items) if (it.until < 0) { slot = it; break; }
    if (!slot) { slot = this.items[this.cursor]; this.cursor = (this.cursor + 1) % this.items.length; }
    slot.mesh.position.copy(point);
    /* Buried to just past the barbs, pointing the way it was travelling. */
    slot.mesh.position.addScaledVector(dir, -0.16 * scale);
    this._q.setFromUnitVectors(this._up, dir);
    slot.mesh.quaternion.copy(this._q);
    slot.mesh.scale.setScalar(scale);
    slot.mesh.visible = true;
    slot.until = this.ctx.time.elapsed + seconds;
  }

  update() {
    const now = this.ctx.time.elapsed;
    for (const it of this.items) {
      if (it.until >= 0 && now > it.until) {
        it.until = -1;
        it.mesh.visible = false;
      }
    }
  }

  dispose() { this.root.removeFromParent(); }
}

/* ========================================================================== */

export class ProjectileSim {
  constructor(ctx, mats) {
    this.ctx = ctx;
    this.mats = mats;
    this.pool = [];
    for (let i = 0; i < MAX_LIVE; i++) this.pool.push(new Projectile());
    this.live = [];
    this.visuals = mats ? new VisualPool(ctx, mats) : null;
    this.stuck = null;
    if (mats) {
      this._stuckGeo = archetypeGeometry('shaft');
      this.stuck = new StuckPool(ctx, mats, this._stuckGeo, 8);
    }
    this.emp = null;
    /** Set by `WeaponSystem.init` — the flare's fire and the sprayer's paint. */
    this.fire = null;
    this.paint = null;
    /** Set by `WeaponSystem.init` — the harpoon's line. */
    this.tether = null;

    this._seg = new THREE.Vector3();
    this._hitDir = new THREE.Vector3();
    this._tmp = new THREE.Vector3();
    this._tracerFrom = new THREE.Vector3();
    this._tracerTo = new THREE.Vector3();
    this._tracerPayload = { from: this._tracerFrom, to: this._tracerTo, speed: 800, weapon: null };
    this._boomPayload = { position: new THREE.Vector3(), radius: 8, damage: 120, source: 'weapon' };
    this._q = new THREE.Quaternion();
    this._axis = new THREE.Vector3(0, 0, 1);
    /* Cars are not in `physics`. See vehiclehit.js — without this every round
     * in the game passed through every vehicle in Steel City. */
    this.cars = new VehicleHitTest(ctx);
    /* NEGATIVE CONTROL for tracerprobe.mjs — see `_emitTracer`. Never set in
     * gameplay. */
    this.debugTracerNoCars = false;
    this.stats = { fired: 0, impacts: 0, live: 0, detonations: 0, carHits: 0, carDamage: 0 };
  }

  get physics() {
    if (!this._physics) this._physics = this.ctx.peek('physics');
    return this._physics;
  }

  /**
   * @param {object} o origin, dir (unit), speed, damage, penetration, dragK,
   *                   maxRange, dropoff, weapon (the finalised def), tracer
   */
  spawn(o) {
    let p = null;
    for (let i = 0; i < this.pool.length; i++) {
      if (!this.pool[i].alive) { p = this.pool[i]; break; }
    }
    if (!p) {
      p = this.live[0];
      if (!p) return null;
      this._retire(p);
      this.live.shift();
    }
    const d = o.weapon ?? null;
    p.alive = true;
    p.pos.copy(o.origin);
    p.prev.copy(o.origin);
    p.dir.copy(o.dir).normalize();
    p.vel.copy(p.dir).multiplyScalar(o.speed ?? 800);
    p.damage = o.damage ?? 30;
    p.penetration = o.penetration ?? 1;
    p.dragK = o.dragK ?? 0.3;
    p.dropoff = o.dropoff ?? 0.5;
    p.maxRange = o.maxRange ?? 400;
    p.travelled = 0;
    p.age = 0;
    p.bounced = 0;
    p.weapon = d;
    p.mask = o.mask;
    p.kind = d?.projectile ?? 'bullet';
    p.gravityScale = d?.gravityScale ?? 1;
    p.explodes = d?.explodes === true;
    p.splash = d?.splash ?? 0;
    p.fuse = d?.fuse ?? 0;
    p.bounces = d?.bounces === true;
    p.waterTrigger = d?.waterTrigger === true;
    p.thrust = d?.thrust ?? 0;
    p.thrustTime = d?.thrustTime ?? 0;
    p.topSpeed = d?.topSpeed ?? 0;
    p.emp = d?.emp === true;
    p.empRadius = d?.empRadius ?? 0;
    p.empSeconds = d?.empSeconds ?? 0;
    p.tethered = d?.tethered === true;
    p.pins = d?.pins === true;
    p.ignites = d?.ignites === true;
    p.marks = d?.marks === true;
    /* A tumbling drum and a spinning bottle: the spin is deterministic per
     * shot so a replayed capture produces the same frame. */
    const s = (this.stats.fired % 7) * 0.9 - 2.7;
    p.spin.set(s * 0.8, s * 0.35, s * 1.4);
    p.visual = this.visuals?.acquire(p.kind) ?? null;
    if (p.visual) {
      p.visual.position.copy(p.pos);
      p.visual.quaternion.setFromUnitVectors(this._axis, p.dir);
    }
    this.live.push(p);
    this.stats.fired++;

    if (o.tracer) this._emitTracer(p, o.speed ?? 800);
    return p;
  }

  /**
   * A tracer for the FAST rounds only: muzzle to wherever the round will land.
   * Anything slow enough to watch has a mesh instead, and drawing an instant
   * streak to the impact point of a 38 m/s nitrous bottle would arrive two and
   * a half seconds before the bottle does.
   *
   * THE STREAK HAS TO END WHERE THE ROUND ENDS, NOT WHERE THE MUZZLE RAY DOES.
   * The visible line is drawn muzzle -> `to`, and the muzzle sits a metre below
   * and left of the optic (see defs.js), so a line that runs parallel to the
   * camera reads at a visibly wrong angle — "the bullets go somewhere other than
   * the crosshair". The cure is to terminate the streak on the point the shot
   * actually strikes, so the drawn segment CONVERGES on the impact and reads as
   * "going where I aimed". `p.dir` already points from the muzzle at the aim
   * convergence point (see `WeaponSystem._fireOnce`), so the only thing left is
   * to find the true first contact along it.
   *
   * That first contact is the SAME nearest-of(physics, vehicles) the round's own
   * integration takes in `fixedUpdate`. VEHICLES ARE NOT IN THE PHYSICS RAY (see
   * the note there), so a phys-only cast tunnels straight through a car and lands
   * the streak on the wall behind it while the bullet stops at the bodywork —
   * the exact parallel-to-camera divergence this exists to avoid. Cast both and
   * keep whichever is nearer.
   */
  _emitTracer(p, speed) {
    if (p.visual && speed < 150) return;
    const phys = this.physics;
    this._tracerFrom.copy(p.pos);
    let dist = Math.min(p.maxRange, 260);
    if (phys) {
      const hit = phys.raycast(p.pos, p.dir, dist, phys.MASK?.BULLET);
      if (hit?.hit) dist = hit.distance;
    }
    /* Cars live outside `phys`; without this the streak overshoots every vehicle
     * it is aimed at. Take the nearer of the wall and the bodywork.
     * `debugTracerNoCars` is the NEGATIVE CONTROL for tracerprobe.mjs only — it
     * restores the phys-only streak that tunnels through vehicles, and the gate
     * asserts that reintroducing it drives the tracer END off the impact point.
     * It leaves the round's OWN vehicle test (fixedUpdate) untouched, so the car
     * still reports a real impact to measure the broken tracer against. */
    if (!this.debugTracerNoCars) {
      const car = this.cars.cast(p.pos, p.dir, dist);
      if (car && car.distance < dist) dist = car.distance;
    }
    this._tracerTo.copy(p.pos).addScaledVector(p.dir, dist);
    this._tracerPayload.speed = speed;
    this._tracerPayload.weapon = p.weapon;
    this.ctx.events.emit('bullet:tracer', this._tracerPayload);
  }

  fixedUpdate(h) {
    const phys = this.physics;
    for (let i = this.live.length - 1; i >= 0; i--) {
      const p = this.live[i];
      p.prev.copy(p.pos);

      /* ---- integrate --------------------------------------------------- */
      if (p.thrust > 0 && p.age < p.thrustTime) {
        /* The only round in the game with a motor. Thrust along the CURRENT
         * velocity, so the lob it left on straightens out as it accelerates. */
        this._tmp.copy(p.vel);
        const sp = this._tmp.length();
        if (sp > 1e-4) {
          this._tmp.divideScalar(sp);
          const target = p.topSpeed > 0 ? p.topSpeed : sp + p.thrust * h;
          p.vel.addScaledVector(this._tmp, Math.min(p.thrust * h, Math.max(0, target - sp)));
        }
      }
      p.vel.y += GRAVITY * p.gravityScale * h;
      const decay = Math.max(0, 1 - p.dragK * h);
      p.vel.multiplyScalar(decay);
      p.pos.addScaledVector(p.vel, h);
      p.age += h;

      this._seg.copy(p.pos).sub(p.prev);
      const segLen = this._seg.length();
      p.travelled += segLen;

      /* ---- water: a depth charge arms and goes off the moment it is wet -- */
      if (p.waterTrigger && p.pos.y <= SEA_LEVEL && p.prev.y > SEA_LEVEL) {
        this._tmp.copy(p.pos);
        this._tmp.y = SEA_LEVEL;
        this._detonate(p, this._tmp);
        this._kill(p, i);
        continue;
      }

      /* ---- contact ------------------------------------------------------ */
      if (segLen > 1e-6 && phys) {
        this._hitDir.copy(this._seg).divideScalar(segLen);
        let hit = phys.raycast(p.prev, this._hitDir, segLen, phys.MASK?.BULLET);
        /**
         * VEHICLES ARE NOT IN THE PHYSICS RAY. Test them separately and take
         * whichever is nearer, so a cruiser between the muzzle and a wall stops
         * the round instead of the wall behind it. See vehiclehit.js.
         */
        const car = this.cars.cast(p.prev, this._hitDir, segLen);
        if (car && (!hit?.hit || car.distance < hit.distance)) {
          if (p.explodes) {
            this._detonate(p, car.point);
          } else {
            const range01 = Math.min(1, p.travelled / p.maxRange);
            const falloff = 1 - (1 - p.dropoff) * range01 * range01;
            const dealt = this.cars.apply(car.vehicle, p.damage * falloff, car.point);
            this.stats.carHits++;
            this.stats.carDamage += dealt;
            /**
             * TWO SCALES ON THIS LINE. `dealt` is VEHICLE points (90-3000 body
             * hp); `emitImpact`'s `damage` slot is ACTOR points, which is what
             * `fx` and `audio` size a spark burst and an impact report against.
             * They differ by `vehicles.actorDamageScale` — 10 — so handing it
             * `dealt` pinned every round on every car at the 1.7 spark ceiling.
             * `cars.dealt` publishes both, named; read it now, never stash it.
             * See the third-scale note in vehiclehit.js.
             *
             * `fx`, `audio` and the decal system all listen for this; a round
             * that damages a car with no spark and no report is worse than one
             * that passes through, because the player cannot tell it landed.
             */
            this.physics?.emitImpact?.(
              car.point.x, car.point.y, car.point.z,
              car.normal.x, car.normal.y, car.normal.z,
              this._hitDir.x, this._hitDir.y, this._hitDir.z,
              phys.SURFACE?.carpaint ?? car.surfaceIndex ?? 0,
              this.cars.dealt.actorPoints, false, car
            );
            this.stats.impacts++;
            if (p.pins && this.stuck) {
              this.stuck.place(car.point, this._hitDir, p.kind === 'harpoon' ? 1.25 : 1, 34);
            }
            if (p.emp && this.emp) this.emp.discharge(car.point, p.empRadius, p.empSeconds);
          }
          this._kill(p, i);
          continue;
        }
        if (hit?.hit) {
          if (p.bounces && p.fuse > 0 && p.age < p.fuse && p.bounced < 3 && !hit.actor) {
            /* A drum rolled off a stern does not go off where it lands — it
             * bounces once and then goes up, which is how you get it round a
             * corner. Reflect, bleed most of the energy, and keep the fuse. */
            this._bounce(p, hit);
            continue;
          }
          this._impact(p, hit, segLen, phys);
          this._kill(p, i);
          continue;
        }
      }

      /* ---- fuse --------------------------------------------------------- */
      if (p.fuse > 0 && p.age >= p.fuse) {
        this._detonate(p, p.pos);
        this._kill(p, i);
        continue;
      }

      /* ---- visual ------------------------------------------------------- */
      if (p.visual) {
        p.visual.position.copy(p.pos);
        if (p.kind === 'spear' || p.kind === 'harpoon' || p.kind === 'rocket') {
          /* Fin-stabilised: it points where it is going. */
          this._tmp.copy(p.vel).normalize();
          p.visual.quaternion.setFromUnitVectors(this._axis, this._tmp);
        } else {
          p.visual.rotateX(p.spin.x * h);
          p.visual.rotateY(p.spin.y * h);
          p.visual.rotateZ(p.spin.z * h);
        }
      }

      if (p.travelled > p.maxRange || p.age > 9 || p.pos.y < -80) {
        if (p.explodes && p.age > 9) this._detonate(p, p.pos);
        this._kill(p, i);
      }
    }
    this.stats.live = this.live.length;
  }

  /**
   * A burning flare is the only light source the player carries, so it has to
   * be submitted every RENDERED frame, not every fixed step. Same for the
   * rocket motor.
   */
  update() {
    this.stuck?.update();
    /* Nothing in the air is the common case by a wide margin — do not even
     * reach for `render` on those frames. */
    if (this.live.length === 0) return;
    const r = this.ctx.peek('render');
    if (!r?.submitLight) return;
    for (let i = 0; i < this.live.length; i++) {
      const p = this.live[i];
      if (p.kind === 'flare') {
        r.submitLight(p.pos.x, p.pos.y, p.pos.z, 0xff8a2b, 190, 22, 2, 'flare' + i);
      } else if (p.kind === 'rocket' && p.age < p.thrustTime) {
        r.submitLight(p.pos.x, p.pos.y, p.pos.z, 0xffb057, 130, 16, 2, 'motor' + i);
      } else if (p.kind === 'coil') {
        r.submitLight(p.pos.x, p.pos.y, p.pos.z, 0x8fd0ff, 90, 12, 1, 'coil' + i);
      }
    }
  }

  _bounce(p, hit) {
    p.bounced++;
    p.pos.copy(hit.point).addScaledVector(hit.normal, 0.06);
    const vn = p.vel.dot(hit.normal);
    p.vel.addScaledVector(hit.normal, -2 * vn);
    p.vel.multiplyScalar(0.34);
    p.spin.multiplyScalar(1.6);
    /* Announce the clang so `fx` and `audio` have something to react to. */
    this.physics?.emitImpact?.(
      hit.point.x, hit.point.y, hit.point.z,
      hit.normal.x, hit.normal.y, hit.normal.z,
      p.vel.x, p.vel.y, p.vel.z,
      hit.surfaceIndex ?? 0, 0, false, hit
    );
  }

  _impact(p, hit, segLen, phys) {
    const range01 = Math.min(1, p.travelled / p.maxRange);
    const falloff = 1 - (1 - p.dropoff) * range01 * range01;

    if (p.explodes) {
      this._detonate(p, hit.point);
      return;
    }

    phys.fireBullet({
      origin: p.prev,
      dir: this._hitDir,
      maxDist: Math.min(24, Math.max(1.5, p.maxRange - p.travelled + segLen)),
      damage: p.damage * falloff,
      penetration: p.penetration,
      dropoff: 1,
      impulse: p.pins ? 26 : 6,
      mask: p.mask,
    });
    this.stats.impacts++;

    /* ---- the harpoon line ----------------------------------------------
     * A real distance constraint that reels the target in, and it attaches to
     * anything — including a man who is not a ragdoll YET, which is every
     * pedestrian this weapon hits. See the header of `tether.js` for the two
     * bugs the old single-impulse version had. */
    if (p.tethered && this.tether) this.tether.attach(hit);

    /* ---- it stays where it landed --------------------------------------- */
    if (p.pins && this.stuck && !hit.ragdoll) {
      this.stuck.place(hit.point, this._hitDir, p.kind === 'harpoon' ? 1.25 : 1, 34);
    }

    /* ---- the coil dumps its bank ---------------------------------------- */
    if (p.emp && this.emp) {
      this.emp.discharge(hit.point, p.empRadius, p.empSeconds);
    }

    /* ---- a flare goes on burning where it lands -------------------------- */
    if (p.ignites && this.fire) {
      this.fire.ignite(hit.point, p.weapon?.burnSeconds ?? 6, hit.normal);
    }

    /* ---- a gob of enamel blinds and marks -------------------------------- */
    if (p.marks && this.paint) {
      this.paint.splat(hit, this._hitDir, 0.28 + Math.min(0.22, p.damage * 0.006));
    }
  }

  /**
   * The canonical `explosion` event. `physics` applies the impulse, `vehicles`
   * and `peds` apply the damage, `fx` draws it, `police` books you for it.
   * Radius is the def's `splash` straight out of the weapon table.
   */
  _detonate(p, at) {
    const b = this._boomPayload;
    b.position.copy(at);
    b.radius = p.splash > 0 ? p.splash : 6;
    b.damage = p.damage;
    b.source = p.weapon?.id ?? 'weapon';
    this.ctx.events.emit('explosion', b);
    this.stats.detonations++;
    if (p.emp && this.emp) this.emp.discharge(at, p.empRadius, p.empSeconds);
  }

  _kill(p, i) {
    this._retire(p);
    this.live.splice(i, 1);
  }

  _retire(p) {
    p.alive = false;
    p.weapon = null;
    if (p.visual) {
      this.visuals?.release(p.visual);
      p.visual = null;
    }
  }

  clear() {
    for (const p of this.live) this._retire(p);
    this.live.length = 0;
  }

  dispose() {
    this.clear();
    this.visuals?.dispose();
    this.stuck?.dispose();
    this._stuckGeo?.dispose();
  }
}
