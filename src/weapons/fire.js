import * as THREE from 'three';

/**
 * FIRE — what a marine flare does after it lands.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS IS NOT `fx.spawnFire()`
 * ---------------------------------------------------------------------------
 * It was. `ballistics.js` called `fx.spawnFire(point, seconds)` on a flare
 * impact and `fx` has never had that method, so the call was a silent no-op
 * behind an optional chain: the tracer burned all the way down, lit the street
 * on the way, and then landed on nothing. `REVIEW.md` lists it as an open
 * defect against `fx`, but `ignites` is THIS subsystem's behaviour, and waiting
 * for another subsystem to grow an API for it is how a feature stays broken
 * indefinitely.
 *
 * So the fire is assembled here, at runtime, out of the `fx` API that DOES
 * exist — the same primitives a burning wreck already uses:
 *
 *   fx.addSmokeColumn(x,y,z,{ fire, ember, … })  flame at the root, smoke above
 *   fx.removeSmokeSource(tag)                    when it burns out
 *   fx.scorch(x,y,z,r)                           the soot ring it leaves
 *   fx.haze(...)                                 heat shimmer over the flame
 *   render.submitLight(...)                      it LIGHTS the street
 *
 * Every one of those is optional-chained. If `fx` is absent (the weapon preview
 * page, a harness with no FX system) the fire still exists as a gameplay
 * volume and still burns whoever stands in it — it is simply invisible. Nothing
 * here can throw into the frame loop.
 *
 * ---------------------------------------------------------------------------
 * IT IS A GAMEPLAY OBJECT, NOT A DECAL
 * ---------------------------------------------------------------------------
 * A fire that only looks like a fire is worth nothing: the Flare Gun's whole
 * pitch is that you can deny a doorway with it. So every `TICK` seconds each
 * live fire burns everything inside its radius — pedestrians, police, and the
 * player himself if he is standing in his own — through the canonical
 * `damage:dealt`, which the TARGET's own listener applies (ARCHITECTURE.md:
 * "damage is applied by the target's own listener, never by the emitter as
 * well"). The first tick also panics the street, because a fire is a thing
 * people run from.
 */

/** Seconds between damage applications. */
const TICK = 0.5;
/** Damage per tick to anything standing in it. */
const BURN = 6;
/** How far the flame reaches, metres. */
const RADIUS = 1.5;
/** Simultaneous fires. The flare carries 40 rounds; four alight is plenty. */
const SLOTS = 4;

export class FireField {
  constructor(ctx) {
    this.ctx = ctx;
    this.fires = [];
    for (let i = 0; i < SLOTS; i++) {
      this.fires.push({
        active: false, x: 0, y: 0, z: 0, until: -1, born: 0,
        radius: RADIUS, tag: null, nextTick: 0, key: `wfire${i}`,
      });
    }
    /* Preallocated — a fire ticks every frame and may not allocate (rule 5). */
    this._point = new THREE.Vector3();
    this._incident = new THREE.Vector3(0, 1, 0);
    this._payload = {
      target: null, amount: 0, headshot: false, part: 'torso', killed: false,
      point: this._point, incident: this._incident, source: 'fire', burn: true,
    };
    this._cursor = 0;
    this.stats = { lit: 0, ticks: 0, burned: 0 };
  }

  get fx() {
    if (this._fx === undefined) this._fx = this.ctx.peek('fx') ?? null;
    return this._fx;
  }

  get live() {
    let n = 0;
    for (const f of this.fires) if (f.active) n++;
    return n;
  }

  /**
   * Light a fire where a burning projectile came to rest.
   *
   * @param {THREE.Vector3} point   the impact point
   * @param {number} seconds        how long it burns (`def.burnSeconds`)
   * @param {THREE.Vector3} [normal] the surface it landed on, so the flame sits
   *                                 on the face rather than inside it
   */
  ignite(point, seconds = 6, normal = null) {
    let slot = null;
    for (const f of this.fires) if (!f.active) { slot = f; break; }
    if (!slot) {
      /* All alight: reclaim the oldest, so the twenty-fifth flare does not
       * quietly fail to burn. */
      slot = this.fires[0];
      for (const f of this.fires) if (f.born < slot.born) slot = f;
      this._extinguish(slot);
    }
    const now = this.ctx.time.elapsed;
    slot.active = true;
    slot.born = now;
    slot.until = now + Math.max(0.5, seconds);
    slot.radius = RADIUS;
    slot.nextTick = now;
    slot.x = point.x + (normal ? normal.x * 0.04 : 0);
    slot.y = point.y + (normal ? normal.y * 0.04 : 0.03);
    slot.z = point.z + (normal ? normal.z * 0.04 : 0);

    const fx = this.fx;
    /* Flame at the root, smoke off the top, embers riding it. `dark` is the
     * smoke's own albedo: a magnesium flare makes pale grey smoke, not soot. */
    slot.tag = fx?.addSmokeColumn?.(slot.x, slot.y, slot.z, {
      duration: seconds,
      rate: 14,
      radius: 0.26,
      rise: 1.35,
      dark: 0.22,
      life: 1.7,
      growth: 2.9,
      ember: 0.85,
      haze: 0.4,
      fire: 0.9,
      wind: 0.55,
      alpha: 0.6,
      cull: 190,
    }) ?? null;
    fx?.scorch?.(slot.x, slot.y, slot.z, 0.85);
    /* People run from fire. One panic on ignition, not one per tick. */
    this._point.copy(point);
    this.ctx.peek('peds')?.panic?.(this._point, 11, 0.8);
    this.stats.lit++;
    return slot;
  }

  _extinguish(f) {
    if (f.tag !== null && f.tag !== undefined) this.fx?.removeSmokeSource?.(f.tag);
    f.tag = null;
    f.active = false;
    f.until = -1;
  }

  /**
   * Called from `weapons.lateUpdate`. Lights, shimmer and the burn tick.
   *
   * The light is submitted EVERY rendered frame, like the flare in flight:
   * `render.submitLight` is a per-frame candidate for one of `q.lightSlots`
   * real point lights, so skipping a frame is a light that strobes.
   */
  lateUpdate() {
    let any = false;
    for (const f of this.fires) if (f.active) { any = true; break; }
    if (!any) return;

    const now = this.ctx.time.elapsed;
    const r = this.ctx.peek('render');
    const fx = this.fx;

    for (const f of this.fires) {
      if (!f.active) continue;
      if (now >= f.until) { this._extinguish(f); continue; }

      /* Fade the last half second out rather than switching the light off. */
      const left = f.until - now;
      const fade = left < 0.6 ? left / 0.6 : 1;
      /* Deterministic flicker: two incommensurate sines, phased per slot, so
       * two fires never pulse in step and a replayed capture is identical. */
      const ph = f.born * 3.1;
      const flick = 0.78 + 0.22 * Math.sin(now * 17.3 + ph) * Math.sin(now * 6.7 + ph * 1.7);
      r?.submitLight?.(
        f.x, f.y + 0.30, f.z, 0xff7326, 150 * flick * fade, 9.5, 2, f.key
      );
      /* Heat over the flame. `addHeatSource` is permanent — `fx` has no removal
       * for it — so a transient fire emits its own shimmer instead of leaking
       * one source per shot. */
      if (fx?.haze && (now * 8) % 1 < 0.14) {
        fx.haze(f.x, f.y + 0.45, f.z, 0.42, 2.2, 1.4, 0.55 * fade);
      }

      if (now < f.nextTick) continue;
      f.nextTick = now + TICK;
      this._burn(f);
    }
  }

  /** Everything standing in the flame takes a tick of damage. */
  _burn(f) {
    this.stats.ticks++;
    const pay = this._payload;
    pay.amount = BURN;
    pay.killed = false;
    this._point.set(f.x, f.y + 0.6, f.z);
    this._incident.set(0, 1, 0);

    const peds = this.ctx.peek('peds');
    const list = peds?.inRadius?.(f.x, f.z, f.radius);
    if (list) {
      for (let i = 0; i < list.length; i++) {
        const ped = list[i];
        if (!ped?.alive) continue;
        const dy = ped.position.y - f.y;
        if (dy < -1.2 || dy > 2.2) continue;
        const dx = ped.position.x - f.x;
        const dz = ped.position.z - f.z;
        if (dx * dx + dz * dz > f.radius * f.radius) continue;
        pay.target = ped;
        pay.killed = false;
        this.ctx.events.emit('damage:dealt', pay);
        this.stats.burned++;
      }
    }

    /* Your own fire burns you. Standing in it is a decision. */
    const player = this.ctx.peek('player');
    const pp = player?.position;
    if (pp && !player.inVehicle && !player.dead) {
      const dx = pp.x - f.x;
      const dz = pp.z - f.z;
      const dy = pp.y - f.y;
      if (dx * dx + dz * dz < f.radius * f.radius && dy > -1.2 && dy < 2.2) {
        pay.target = player;
        pay.killed = false;
        this.ctx.events.emit('damage:dealt', pay);
        this.stats.burned++;
      }
    }
    pay.target = null;
  }

  clear() {
    for (const f of this.fires) if (f.active) this._extinguish(f);
  }

  dispose() { this.clear(); }
}

export { RADIUS as FIRE_RADIUS, BURN as FIRE_BURN, TICK as FIRE_TICK };
