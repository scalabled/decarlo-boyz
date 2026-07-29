/**
 * Damage: panel deformation, glass, and the death spiral.
 *
 * Panels dent for real — the impact pushes the paint mesh's vertices in along
 * the impact normal with a smooth falloff, plus a ring of pucker around the
 * crater so it reads as sheet metal folding rather than as a dent decal. The
 * geometry is shared between every instance of a class, so the first hit
 * triggers a copy-on-write clone; an undamaged traffic car never pays for it.
 *
 * Glass goes through three states: intact -> cracked (a fracture texture is
 * stamped over it and it stops being clear) -> gone, with a shower of debris.
 *
 * As the health falls the bonnet buckles into a tent, the wheels lose camber,
 * white smoke turns black, and at zero it burns and then goes up.
 */

import * as THREE from 'three';

const _v = new THREE.Vector3();
const _n = new THREE.Vector3();
const _q = new THREE.Quaternion();

/** Seconds a wreck burns before it goes up. Reference-shaped; unchanged. */
const FUSE_SECONDS = 3.2;

/**
 * How fast a write-off catches (per second, saturating at 1) and how fast a
 * wounded-but-alive engine smokes up and clears. Same rates these ran at in
 * `Vehicle._postStep`; only their HOME has changed. See the block comment on
 * `_postStep` for why they cannot live inside the physics step.
 */
const BURN_RATE = 0.35;
const SMOKE_RATE = 0.4;
const SMOKE_CLEAR = 0.2;
/** Health fraction below which an engine starts smoking. */
const SMOKE_AT = 0.35;

/**
 * ────────────────────────────────────────────────────────────────────────────
 * WHAT A WRECK IS WORTH WHEN IT GOES UP
 * ────────────────────────────────────────────────────────────────────────────
 * These are ACTOR points, like every other `explosion` payload in the game —
 * `peds`, `player` and `police` all read `e.damage` as damage to a man, and
 * `vehicles._explosionDamage` converts to the body scale with
 * `ACTOR_TO_VEHICLE`.
 *
 * The radius was already 7. The damage was 140, which is nobody's number: once
 * the missing factor of ten is restored on the vehicle side it is enough to
 * write off a HEALTHY neighbour parked 2.06 m away, which is inside the spacing
 * of a real pile-up. That is the runaway `_explosionDamage` was maimed to
 * prevent, and it is much better prevented here, at the source.
 *
 * At 55 the arithmetic is convergent by construction: 55% of a 1000-point body
 * at zero distance, ~41% at a parking bay's 2.8 m. One wreck can never take a
 * healthy car with it; it finishes a car that has already been shot up, and a
 * rocket into a car park sets several off at once because the ROCKET is 200.
 */
const WRECK_BLAST_RADIUS = 7;
const WRECK_BLAST_DAMAGE = 55;

/**
 * ────────────────────────────────────────────────────────────────────────────
 * COLLISION DAMAGE, AND THE ONLY SOURCE IN THE GAME THAT DID NOT SCALE WITH
 * THE BODY IT WAS HITTING
 * ────────────────────────────────────────────────────────────────────────────
 * `impulse / mass` is a CLOSING SPEED, so the old `dmg = (impulse/mass) * 24 *
 * crumple` produced the same absolute number of points whatever it hit. Every
 * other damage source is priced against `body.hp`; this one was priced against
 * nothing, and `crumple` (0.5 to 2.2) was left carrying a durability spread
 * that `hp` states as 90 to 3000. The arithmetic that falls out is not a
 * balance opinion, it is broken:
 *
 *   a Towpath bicycle (90 hp, crumple 2.2) hit the 45% single-hit CAP at a
 *   closing speed of 0.77 m/s — walking pace — so three contacts of any kind,
 *   at any speed at all, wrote it off;
 *   a Steelhauler 30 (3000 hp, crumple 0.5) needed 112 m/s to reach that same
 *   cap, three times: 400 km/h, three times. The bus was indestructible by
 *   collision and the bicycle was destroyed by being parked badly.
 *
 * MEASURED on the emitted health, one wall hit, before -> after: the bicycle
 * lost 45% (the CAP) at every speed tested including 20 km/h, and now loses
 * 13.1% at 20 and 24.5% at its 37 km/h top speed. The bus lost 5.3% at 50 km/h
 * and now loses 9.9%. Neither number came from a per-class table; both fall out
 * of pricing the hit against the body it landed on.
 *
 * So the damage is a fraction of THIS body's own life, and `crumple` goes back
 * to meaning what its name says: how much softer or stiffer this shell is than
 * a baseline one. `CRASH_KILL_DV` is the closing speed at which one hit would
 * take a whole baseline body (crumple 1.0) if the cap were not there.
 *
 * The value is set from the emitted curve, not from taste. MEASURED by driving
 * a real `Vehicle` into a wall through the real `_collide`, sedan, health lost
 * in one hit:
 *
 *      20 km/h   30      40      50      80      100 km/h
 *   old  11.9%   20.1%   28.1%   35.8%   45.0%   45.0%   (both at the cap)
 *   new   6.6%   11.2%   15.7%   20.0%   32.4%   40.5%
 *
 * A third of a car for a 50 km/h shunt is not "it dents"; a fifth is. And the
 * old curve saturated the cap by 80 km/h, which means every crash from a
 * town-centre prang upwards cost exactly the same — three of anything and you
 * had a fireball. The 45% cap stays, so a write-off is still never one impact.
 */
const CRASH_KILL_DV = 67;
/** No single impact may take more than this fraction of the body. */
const CRASH_MAX_FRAC = 0.45;

/**
 * ────────────────────────────────────────────────────────────────────────────
 * WHAT A CRASH BREAKS, AS A FRACTION OF THE BODY
 * ────────────────────────────────────────────────────────────────────────────
 * These were absolute point thresholds (2.2 / 14 / 18 / 26 / 30) authored
 * against a ~900 hp sedan, which had the same class-blindness as the damage
 * itself: 26 points is 29% of a bicycle and 0.9% of a bus, so the bicycle lost
 * a wheel to a kerb and the bus never lost one at all.
 *
 * The levels are also deliberately higher than the old sedan equivalents. At
 * 26 absolute points a sedan bent a wheel at a closing speed of 0.99 m/s —
 * 3.5 km/h, i.e. reversing into a bollard cambered a wheel — and that reads to
 * a player as exactly the "these cars are made of glass" the whole re-tune is
 * about. A parking bump now dents, a 20 km/h prang cracks the screen and pops
 * the bonnet, and it takes a 30 km/h hit to bend a wheel.
 */
const DENT_AT = 0.004;
const CRACK_GLASS_AT = 0.025;
const BONNET_AT = 0.04;
const WHEEL_AT = 0.07;
const SHATTER_AT = 0.09;
/** Below this fraction the hit is noise and is not worth a panel clone. */
const IGNORE_AT = 0.0004;

/**
 * A crater is sized in MILLIMETRES and a body's hp is a balance number, so the
 * hit is first expressed as "what this would have been on a 100-point car"
 * before it becomes geometry. Same trick, same reason and same constant as
 * `VehicleSystem.damage` — see the note there.
 */
const REFERENCE_BODY_HP = 100;

export class DamageModel {
  constructor(vehicle, mats, rng) {
    this.v = vehicle;
    this.mats = mats;
    this.rng = rng;
    this.deformed = false;
    this.glassState = 0; // 0 intact, 1 cracked, 2 gone
    this.bonnetPop = 0;
    this.dents = 0;
    this._cloned = new Set();
    this._acc = 0;
  }

  /**
   * @param impulse  N.s of the impact
   * @param point    world point
   * @param normal   world normal pointing OUT of the thing that was hit
   */
  impact(impulse, point, normal, ctx) {
    const v = this.v;
    if (v.destroyed) return 0;
    const spec = v.spec;
    const maxHp = v.maxHealth ?? spec.hp ?? 100;
    // The closing speed the crumple structure had to absorb, and the fraction
    // of THIS body it costs. See `CRASH_KILL_DV` — the old form was absolute
    // points and so hit a bicycle and a bus equally hard.
    //
    // THE HISTORY, because the direction of travel is the whole story. This was
    // `(impulse/mass) * 62 * crumple` and it made the city destroy itself: AI
    // traffic bumps constantly (measured: 491 "big impacts" per simulated minute
    // across a district), and at 62 a couple of those wrote a car off — which
    // detonated it, which damaged its neighbours, which detonated them. A street
    // capture with no player input came back with a block on fire and two wanted
    // stars nobody had earned. It went to 24, and cars still exploded too
    // easily. In GTA V a car survives a great many collisions and only burns
    // after sustained punishment; a fender-bender never explodes.
    //
    // A SINGLE IMPACT ALSO CANNOT FINISH A CAR. Capping one hit at 45% of max
    // health means a write-off always takes at least three separate impacts, so
    // wrecks are the result of a real pile-up rather than one unlucky nudge —
    // and it removes the last path by which one blast instantly kills a whole
    // queue through the collisions it causes.
    const dv = impulse / spec.mass;
    let frac = (dv / CRASH_KILL_DV) * spec.body.crumple;
    if (frac < IGNORE_AT) return 0;
    if (frac > CRASH_MAX_FRAC) frac = CRASH_MAX_FRAC;
    const dmg = maxHp * frac;
    /** The same hit expressed on a 100-point body. Geometry only. */
    const ref = frac * REFERENCE_BODY_HP;

    v.health = Math.max(0, v.health - dmg);
    // Anything that took damage has something happening to it. See `wake()`.
    v.wake?.();
    this.dents++;

    if (frac > DENT_AT) this.dent(point, normal, Math.min(0.22, ref * 0.012), Math.min(1.5, 0.35 + ref * 0.03));

    if (frac > CRACK_GLASS_AT && this.glassState === 0) this.crackGlass();
    if (frac > SHATTER_AT && this.glassState === 1) this.shatterGlass(ctx);

    // Front-end hits pop the bonnet.
    _v.copy(point).sub(v.position).applyQuaternion(_q.copy(v.quaternion).invert());
    if (_v.z > spec.half.z * 0.35 && frac > BONNET_AT) {
      this.bonnetPop = Math.min(1, this.bonnetPop + ref * 0.02);
      this.buckleBonnet();
    }

    // Wheels take a set from big side/corner impacts.
    if (frac > WHEEL_AT) {
      for (const w of v.wheels) {
        const dz = _v.z - w.hp.z;
        const dx = _v.x - w.hp.x;
        if (Math.hypot(dx, dz) < 1.1 && !w.broken) {
          w.broken = true;
          w.camber += (this.rng.signed() > 0 ? 1 : -1) * (0.18 + this.rng.float() * 0.2);
        }
      }
    }

    if (v.health <= 0 && !v.destroyed) this.destroy(ctx);
    return dmg;
  }

  /** Copy-on-write so undamaged instances keep sharing class geometry. */
  _own(mesh) {
    if (this._cloned.has(mesh)) return mesh.geometry;
    const g = mesh.geometry.clone();
    g.userData.owBase = mesh.geometry.attributes.position.array.slice();
    mesh.geometry = g;
    this._cloned.add(mesh);
    return g;
  }

  /**
   * Push the paint shell in around a world-space point.
   * `depth` metres at the centre, `radius` metres of influence.
   */
  dent(worldPoint, worldNormal, depth, radius) {
    const v = this.v;
    _q.copy(v.quaternion).invert();
    _v.copy(worldPoint).sub(v.position).applyQuaternion(_q);
    _n.copy(worldNormal).applyQuaternion(_q).normalize();
    const lx = _v.x, ly = _v.y, lz = _v.z;
    const r2 = radius * radius;

    for (const panel of v.model.panels) {
      if (panel.lod > 1) continue;
      const geo = this._own(panel.mesh);
      const pos = geo.attributes.position;
      const arr = pos.array;
      let touched = false;
      for (let i = 0; i < pos.count; i++) {
        const dx = arr[i * 3] - lx;
        const dy = arr[i * 3 + 1] - (ly + v.spec.comY);
        const dz = arr[i * 3 + 2] - lz;
        const d2 = dx * dx + dy * dy + dz * dz;
        if (d2 > r2) continue;
        const t = 1 - Math.sqrt(d2) / radius;
        // Crater plus a raised pucker ring at the edge: real sheet metal has
        // to put the displaced material somewhere.
        const f = t * t * (3 - 2 * t) - 0.34 * Math.sin(t * Math.PI) * (1 - t);
        arr[i * 3] += _n.x * depth * f;
        arr[i * 3 + 1] += _n.y * depth * f;
        arr[i * 3 + 2] += _n.z * depth * f;
        touched = true;
      }
      if (touched) {
        pos.needsUpdate = true;
        geo.computeVertexNormals();
        geo.computeBoundingSphere();
      }
    }
    this.deformed = true;
  }

  /** The bonnet buckles into a tent and lifts at the rear edge. */
  buckleBonnet() {
    const v = this.v;
    const s = v.spec.style;
    if (!s.cowlZ) return;
    const z0 = s.cowlZ;
    const z1 = s.archF.z + s.archF.r * 0.6;
    const amp = this.bonnetPop * 0.26;
    for (const panel of v.model.panels) {
      if (panel.lod > 1) continue;
      const geo = this._own(panel.mesh);
      const pos = geo.attributes.position;
      const arr = pos.array;
      const base = geo.userData.owBase;
      let touched = false;
      for (let i = 0; i < pos.count; i++) {
        const z = base ? base[i * 3 + 2] : arr[i * 3 + 2];
        if (z < z1 || z > z0) continue;
        const y = arr[i * 3 + 1];
        if (y < s.beltY - 0.1) continue;
        const t = (z - z1) / Math.max(1e-3, z0 - z1);
        const lift = Math.sin(t * Math.PI) * amp;
        arr[i * 3 + 1] += lift;
        arr[i * 3 + 2] -= lift * 0.35;
        arr[i * 3] *= 1 - lift * 0.1;
        touched = true;
      }
      if (touched) {
        pos.needsUpdate = true;
        geo.computeVertexNormals();
      }
    }
  }

  crackGlass() {
    if (this.glassState !== 0) return;
    this.glassState = 1;
    const mat = this.mats.glass({ tint: 0x9aa6b4, opacity: 0.86 });
    const cracked = mat.clone();
    cracked.map = this.mats.cracksTexture();
    cracked.transparent = true;
    cracked.opacity = 0.72;
    cracked.roughness = 0.42;
    cracked.color.set(0x6e7a88);
    this._crackMat = cracked;
    for (const m of this.v.model.glassMeshes) m.material = cracked;
  }

  shatterGlass(ctx) {
    if (this.glassState >= 2) return;
    this.glassState = 2;
    for (const m of this.v.model.glassMeshes) m.visible = false;
    const phys = this.v.sys.physics;
    const fx = ctx?.peek?.('fx');
    const p = this.v.position;
    for (let i = 0; i < 10; i++) {
      const r = this.rng;
      phys?.spawnDebris?.(
        { x: p.x + r.signed() * 0.7, y: p.y + 0.4 + r.float() * 0.5, z: p.z + r.signed() * 1.2 },
        { x: r.signed() * 3, y: 1 + r.float() * 3, z: r.signed() * 3 },
        { size: 0.05, surface: 'glass', lifetime: 6 }
      );
    }
    fx?.addDecal?.(p, { x: 0, y: 1, z: 0 }, { radius: 0.6, kind: 'glass' });
  }

  destroy(ctx) {
    const v = this.v;
    if (v.destroyed) return;
    v.destroyed = true;
    v.engineOn = false;
    v.health = 0;
    /**
     * A write-off is a change of PHYSICAL configuration, not just of a number:
     * every wheel is broken and re-cambered below, so the body has to settle
     * onto them. A sleeping vehicle is never stepped, so a parked car written
     * off in its bay used to stay pinned in its showroom pose forever — and
     * `vehicle:engine`, which is what `fx` stages fire and smoke off, is
     * likewise skipped for a sleeper, so it never even caught light.
     */
    v.wake?.();
    this.shatterGlass(ctx);
    this.buckleBonnet();
    for (const w of v.wheels) {
      w.broken = true;
      w.camber += this.rng.signed() * 0.22;
    }
    // Scorch the paint.
    for (const panel of v.model.panels) {
      panel.mesh.material = this.mats.paint(0x141312, { finish: 'matte', flake: 0 });
    }
  }

  /**
   * Undo damage, in health points — Aidan's body shop hammering the dents out
   * while you sit in it.
   *
   * The panels physically un-dent: `_own()` already keeps `owBase`, the
   * pristine vertex positions, because the copy-on-write clone needs them for
   * `buckleBonnet`. Pulling the live positions back towards that base in step
   * with the health means you WATCH the car straighten instead of it snapping
   * from wrecked to mint in one frame.
   *
   * @returns the health actually restored.
   */
  repair(amount, ctx) {
    const v = this.v;
    const maxHp = v.maxHealth ?? 100;
    if (v.health >= maxHp && !this.deformed && this.glassState === 0) return 0;
    const before = v.health;
    v.health = Math.min(maxHp, v.health + amount);
    const gained = v.health - before;
    const frac = v.health / maxHp;

    if (v.destroyed && frac > 0.3) {
      v.destroyed = false;
      v.burning = 0;
      v.smoke = 0;
      v._deathEmitted = false;
      this._acc = 0;
      v.engineOn = !v.fuelDry;
      for (const panel of v.model.panels) panel.mesh.material = v.model.paintMat;
    }

    // Wheels come off the ramp straight.
    if (frac > 0.55) {
      for (const w of v.wheels) {
        if (!w.broken) continue;
        w.broken = false;
        w.camber = w.hp.camber;
      }
    }

    // Glass goes back in.
    if (frac > 0.6 && this.glassState !== 0) {
      this.glassState = 0;
      const clear = this.mats.glass();
      for (const m of this.v.model.glassMeshes) {
        m.visible = true;
        m.material = clear;
      }
    }

    if (this.deformed || this.bonnetPop > 0) {
      // Straighten in proportion to the health returned, and snap exactly to
      // the base once the car is whole so no residual creep survives.
      const done = v.health >= maxHp - 1e-4;
      const t = done ? 1 : Math.min(1, (gained / maxHp) * 2.6);
      if (t > 0) {
        for (const mesh of this._cloned) {
          const geo = mesh.geometry;
          const base = geo.userData.owBase;
          const pos = geo.attributes?.position;
          if (!base || !pos) continue;
          const arr = pos.array;
          for (let i = 0; i < arr.length; i++) arr[i] += (base[i] - arr[i]) * t;
          pos.needsUpdate = true;
          geo.computeVertexNormals();
          geo.computeBoundingSphere();
        }
      }
      if (done) {
        this.deformed = false;
        this.bonnetPop = 0;
        this.dents = 0;
      }
    }
    return gained;
  }

  /**
   * Called every frame while the vehicle is alive.
   *
   * ---------------------------------------------------------------------
   * THE FUSE THAT HAD NEVER ONCE BURNED THROUGH
   * ---------------------------------------------------------------------
   * This used to read `v.destroyed && v.burning > 0.02 && v.burning < 1`, and
   * that last clause made the whole thing unreachable. `Vehicle._postStep`
   * ramps `burning` at 0.35 per second, so it SATURATES at 1 after 2.857 s —
   * before `_acc` can pass a 3.2 s fuse, and once it saturates the guard is
   * false forever and `_acc` stops accumulating. Measured on the shipped code:
   * after sixty seconds of burning, `burning 1, _acc 2.800, explosions emitted
   * 0`. Every wreck in Steel City has burned quietly and gone out.
   *
   * That is the same failure shape as a gate that cannot fail: the upper bound
   * was written as "while it is still catching fire", but it is fed by a value
   * that reaches its ceiling first, so the window closed before the timer
   * arrived. The condition is now the one actually meant — it is wrecked, it
   * has caught, and it has not already gone up (`_acc` is parked at -1e9 after
   * the one detonation, and `repair()` puts it back to 0).
   *
   * ---------------------------------------------------------------------
   * ...AND THE LOWER BOUND, WHICH SURVIVED THAT FIX
   * ---------------------------------------------------------------------
   * `v.burning > 0.02` reads a value that WAS ramped in `Vehicle._postStep`,
   * i.e. inside the physics step — which `VehicleSystem.fixedUpdate` skips
   * outright for a sleeping vehicle. A parked car is asleep by definition, and
   * nothing woke it, so `burning` stayed at exactly 0 and the fuse could not
   * start. Measured on a genuinely-asleep sedan written off in its bay:
   * `burning 0.000, _acc 0.00, explosions emitted 0` after fifteen seconds.
   * Every number the previous agent published for this feature was taken on a
   * FRESHLY SPAWNED car, which is the one case that never sleeps.
   *
   * Both halves are now fixed at the root rather than at the guard: damage
   * wakes the vehicle (`Vehicle.wake`), and the burn clock lives HERE, in the
   * per-frame update that runs for every vehicle whether it is being stepped
   * or not. `burning` is what the car looks like, not what the solver did.
   */
  update(dt, ctx) {
    const v = this.v;

    if (v.destroyed) {
      v.burning = Math.min(1, v.burning + dt * BURN_RATE);
    } else if (v.health < v.maxHealth * SMOKE_AT) {
      v.smoke = Math.min(1, v.smoke + dt * SMOKE_RATE);
    } else if (v.smoke > 0) {
      v.smoke = Math.max(0, v.smoke - dt * SMOKE_CLEAR);
    }

    if (v.destroyed && v.burning > 0.02 && this._acc >= 0) {
      this._acc += dt;
      if (this._acc > FUSE_SECONDS) {
        this._acc = -1e9;
        ctx.events.emit('explosion', {
          position: v.position.clone(),
          radius: WRECK_BLAST_RADIUS,
          damage: WRECK_BLAST_DAMAGE,
        });
      }
    }
  }
}
