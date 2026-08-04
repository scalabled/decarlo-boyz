/**
 * PEDS — THE CREW.
 *
 * Three brothers is the premise of this game, and without this system they are
 * three *save slots*: switching to one makes the other two vanish. Here the two
 * brothers you are not playing walk around with you and fight beside you, and
 * that single system is the reason the game reads as being about a family
 * rather than about a lone protagonist. It is built on top of the crowd tech in
 * this directory: a companion is a real `Ped` — same rig, same skinned body,
 * same ragdoll, same foot IK — with a different brain.
 *
 * ---------------------------------------------------------------------------
 * THE FOUR BEHAVIOURS, AND THE NUMBERS THEY ARE TUNED TO
 * ---------------------------------------------------------------------------
 *
 * 1. FOLLOW at `TUNING.follow` (5 m), preferring the pavement network. Over
 *    open ground they cut the corner; past `SIDEWALK_AT` metres they steer via
 *    a point on `SidewalkNet` so they walk the street rather than through the
 *    middle of the carriageway or into the Monongahela. They board a vehicle
 *    with the player from `TUNING.board` (30 m) and reappear beside it on exit.
 *
 * 2. FIGHT, BUT NEVER CARRY THE FIGHT. They engage a hostile inside
 *    `TUNING.engage` (20 m) and deal `TUNING.damage` (7) on a `TUNING.cycle`
 *    (1.5 s) — deliberately so, and the rule is worth stating outright:
 *    *"allies chip in but never carry the fight"*. Seven damage
 *    every second and a half kills a 60 hp goon in thirteen seconds. That is
 *    presence, not a solution. A companion that clears the room ruins the
 *    encounter, so these two numbers are the most load-bearing in the file.
 *
 * 3. GO DOWN, DON'T DIE. A brother never dies in free roam. He ragdolls into
 *    `STATE.DOWN`, says a line, and picks himself up `TUNING.revive` (8 s)
 *    later next to you. `setGuard(id, x, z)` pins one in place for a `protect`
 *    chapter and `noRevive` turns that chapter into something you can fail.
 *
 * 4. ADVICE. Every 18–32 s a brother has a 55% chance to say a line. The lines
 *    do three jobs at once — teach a mechanic, teach a control, and characterise
 *    the family — which is why the game needs no tutorial mode. Routed
 *    through `ui.say(id, text)`, so the speaker's name and colour come from the
 *    HUD's own brother table and this file never touches the DOM.
 *
 * ---------------------------------------------------------------------------
 * WHY THE COMPANION IS A `Ped` AND NOT A NEW ACTOR CLASS
 * ---------------------------------------------------------------------------
 * Everything expensive is already built: twenty silhouettes, the palette
 * shader, the layered animator, foot IK, hit capsules on `LAYER.ACTOR` so the
 * engine's own ballistics can hit them, and a ragdoll solver. A parallel actor
 * would have to re-earn all of it and would look wrong next to the crowd. The
 * cost of the decision is two small hooks in `ped.js` (`STATE.CREW` in the
 * steering exclusion list, and damage routed here so a brother goes down
 * instead of dying) and about 30 µs a frame for two of them.
 */

import * as THREE from 'three';
import { makeOutfit } from './wardrobe.js';
import { Ped, STATE } from './ped.js';

/* ==================================================================== */
/* tuning — every number the crew is built on, in one place             */
/* ==================================================================== */

export const TUNING = {
  follow: 5.0,       // trail distance on foot, metres
  guardHold: 2.0,    // how close a guarding brother stays to his anchor
  engage: 20.0,      // hostile acquisition radius
  strike: 9.0,       // he will take a shot from here
  close: 2.4,        // inside this he stops advancing and swings
  damage: 7.0,       // per hit. NOT a knob to turn up.
  cycle: 1.5,        // seconds between hits
  /**
   * Every ally starts from a flat 140. Each brother's own pool in
   * `BROTHERS` is this scaled by his DESIGN.md health column (130/115/100), so
   * Carson takes a beating and Dylan does not — 158 / 140 / 124. Deliberately
   * NOT hp+armour: that comes to 190/190/155 and flattens two of the three,
   * which throws away the one line of the table a player can feel. Nothing
   * reads this at runtime; it is the provenance of those three numbers.
   */
  hp: 140,
  revive: 8.0,       // seconds face-down before he gets himself up
  board: 30.0,       // he will run to the car from this far
  leash: 92.0,       // beyond this he gives up and catches up off-screen
  adviceMin: 18.0,
  adviceMax: 32.0,
  adviceChance: 0.55,
  incoming: 4.0,     // damage a hostile in his face deals back
  incomingCycle: 1.6,
  /**
   * THE CATCH-UP CEILING, not a brother's speed.
   *
   * Each brother runs at his OWN `BROTHERS[id].run` from DESIGN.md — Carson
   * 6.4, Aidan 6.9, Dylan 7.9 — because "heaviest and slowest" versus "lightest
   * and fastest" is a whole column of the content bible and a companion who
   * moves like everyone else throws it away. Carson visibly labours; Dylan is
   * ahead of you at every kerb.
   *
   * But Carson at 6.4 can never close on a sprinting Dylan at 7.9, so a gap
   * past `catchUpAt` metres unlocks this ceiling. That is the standard trick:
   * the overspeed only happens when he is far enough back that you cannot see
   * his legs disagreeing with his velocity.
   */
  runSpeed: 7.4,
  catchUpAt: 12.0,   // metres of gap that unlock the ceiling
  walkSpeed: 1.95,

  /* ---- the three ways a companion becomes a LIABILITY, and their knobs ---- */

  /**
   * CATCH-UP. Boarding anyone within `board` on the instant you get in and
   * abandoning the rest forever is fine in a 700 m town and wrong in
   * a 3 km city: the brother you left behind either never returns, or — worse,
   * and this is what the first build actually did — trips the `leash` and is
   * WARPED ONTO THE CARRIAGEWAY four metres from a car doing 140 km/h, over and
   * over, because the anchor he is warping to is the car. He caught eight
   * separate 8.4-damage vehicle hits that way.
   *
   * So: while you are driving, a brother who is not aboard keeps running at the
   * car, and after `catchUp` seconds of not making it he is simply in the back.
   * "He caught up off-screen" is the oldest trick in the genre and it is the
   * right one — the alternative is a man sprinting down a motorway forever.
   */
  catchUp: 5.0,

  /**
   * THE FIRING LANE. A companion who walks in front of your barrel eats the
   * burst you meant for the goon, and then YOU are the reason he is on the
   * floor. He yields out of a corridor `fireLane` metres either side of the
   * player's aim, for `fireLaneLen` metres down it. Only while the player is
   * actually aiming or has just fired — a brother who dodges the camera
   * direction at all times looks skittish and never walks beside you.
   */
  fireLane: 1.6,
  fireLaneLen: 22.0,
  fireYield: 2.9,      // steering weight of the sidestep
  fireHot: 1.1,        // seconds after a shot the lane is still hot

  /**
   * PARKED CARS. `physics` blocks capsules against vehicles (`carblock.mjs`)
   * but `Ped._move` integrates position directly and is not a capsule, so a
   * brother walks THROUGH a parked sedan. He now reads the same
   * `physics.blockers` snapshot the character controller uses and steers round
   * it — one distance test per car per brother, on an array that is already
   * budget-capped and already refreshed once per fixed step.
   */
  carClear: 0.45,      // metres outside the block radius he aims to stay
  carAvoid: 2.4,       // steering weight

  /**
   * FRIENDLY FIRE. See `Ped.applyDamage`. A round that lands on a brother
   * inside `ffWindow` of the PLAYER pulling the trigger is the player's, and it
   * costs a tenth. It still flinches him, it still says a line, and forty
   * deliberate rounds will still put him down — but a burst that clips him
   * cannot. `weapon:fire` is emitted by `src/weapons` only, which is the
   * player's gun; hostiles and the crew both deliberately avoid raising it.
   */
  friendlyFire: 0.10,
  ffWindow: 0.25,
};

/** Past this range from the anchor, follow the pavement instead of the crow. */
const SIDEWALK_AT = 13;
/** How often the follow waypoint is recomputed. A held waypoint reads calmer. */
const WAYPOINT_HZ = 3.2;

export const CREW_MAX = 2;

/* ==================================================================== */
/* who they are                                                          */
/* ==================================================================== */

/**
 * sRGB -> linear, then a per-slot gain. `DESIGN.md` gives the brothers as web
 * hex, and the ped palette is LINEAR ALBEDO (see the header of `wardrobe.js`):
 * a naive conversion puts Aidan's skin at 0.87, which is brighter than snow.
 * The gains land each slot inside the ranges the wardrobe's own tables use —
 * skin 0.05-0.37, hair 0.01-0.26, cloth 0.02-0.4.
 */
function lin(hex, gain = 1) {
  const n = parseInt(hex.slice(1), 16);
  const out = new Array(3);
  for (let i = 0; i < 3; i++) {
    const s = ((n >> ((2 - i) * 8)) & 0xff) / 255;
    const l = s <= 0.04045 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
    out[i] = Math.max(0.008, l * gain);
  }
  return out;
}

/**
 * A brother's signature colour AS DYED CLOTH.
 *
 * The straight conversion of `#7c3aed` is (0.13, 0.03, 0.56) linear, which is a
 * brighter blue than a hi-vis vest and reads on screen as a flat slab of pure
 * pigment standing in a rustbelt street — the first pass looked like two
 * primary-colour placeholders next to a crowd of wool and denim. Real dyed
 * cotton has a much lower dynamic range than a web hex: the brightest channel
 * lands around 0.30, the darkest never reaches zero because the weave scatters,
 * and the hue is a little desaturated by the yarn itself.
 *
 * `lumTarget` is the LUMINANCE the finished cloth sits at; `desat` how far the
 * colour is pulled toward its own luminance. The HUE — which is how the player
 * tells Carson from Dylan at fifty metres — is preserved exactly.
 *
 * NORMALISE TO LUMINANCE, NOT TO THE PEAK CHANNEL. The first version pinned the
 * BRIGHTEST CHANNEL to a target, which is a trap for saturated hues: only one
 * channel is near the peak and the rest are tiny, so the actual brightness lands
 * far below it — and the more the hue leans on a low-luminance channel the worse
 * it gets, because luminance weights green 0.72 and BLUE ONLY 0.07. Measured on
 * the three brothers under the old peak rule: Carson's teal shirt came out at
 * 0.111 luminance, Aidan's orange at 0.053 (as dark as wet asphalt) and Dylan's
 * blue-violet at 0.025 — HALF the reflectance of the pavement, i.e. his one
 * identifying colour rendered as a black hoodie. That is the "muddy clothing /
 * colours look off" defect, and it hit the most saturated brother hardest.
 * Normalising to luminance lands all three at a believable, comparable dyed
 * brightness while the hue still tells them apart. A physical ceiling keeps a
 * pale hue from blowing out — no dyed garment reflects past ~0.55 on a channel.
 */
function cloth(hex, lumTarget = 0.16, desat = 0.16) {
  const c = lin(hex);
  const y = c[0] * 0.2126 + c[1] * 0.7152 + c[2] * 0.0722;
  const out = new Array(3);
  for (let i = 0; i < 3; i++) out[i] = c[i] * (1 - desat) + y * desat;
  const yOut = out[0] * 0.2126 + out[1] * 0.7152 + out[2] * 0.0722;
  let k = lumTarget / Math.max(1e-6, yOut);
  const max = Math.max(out[0], out[1], out[2]);
  if (max * k > 0.55) k = 0.55 / max; // physical ceiling on the brightest channel
  for (let i = 0; i < 3; i++) out[i] = Math.max(0.014, out[i] * k);
  return out;
}

/**
 * The three of them. `shape` is the silhouette from `wardrobe.js` that reads as
 * the man: Carson in a river hand's quilted coat, Aidan in the body shop's
 * work shirt and jeans, Dylan in a courier's hoodie. Heights follow the build
 * column in DESIGN.md — heaviest/slowest, middle, lightest/fastest.
 */
export const BROTHERS = {
  carson: {
    id: 'carson', name: 'Carson', shape: 'puffaM', height: 1.855, bulk: 1.06,
    colour: '#2ea6a0', accent: '#7bf0d8', run: 6.4,
    skin: lin('#f0cdae', 0.42), hair: lin('#3b2a1c'), shirt: cloth('#1f6f6a', 0.150),
    pants: lin('#26303c'), accentRgb: cloth('#7bf0d8', 0.220, 0.30), hat: lin('#26303c', 1.4),
    hp: 158, gait: { strideK: 0.94, armSwing: 0.62, bounce: 0.72, sway: 0.62, lean: 1.2, stoop: 1.6 },
  },
  aidan: {
    id: 'aidan', name: 'Aidan', shape: 'jacketM', height: 1.795, bulk: 1.0,
    colour: '#ff6a12', accent: '#ffc93c', run: 6.9,
    skin: lin('#f4d4b6', 0.42), hair: lin('#8a5a2a', 0.85), shirt: cloth('#c2410c', 0.150),
    pants: lin('#1f2733'), accentRgb: cloth('#ffc93c', 0.230, 0.26), hat: lin('#1f2733', 1.4),
    hp: 140, gait: { strideK: 1.02, armSwing: 0.95, bounce: 0.9, sway: 0.8, lean: 2.0, stoop: 0.4 },
  },
  dylan: {
    id: 'dylan', name: 'Dylan', shape: 'hoodieM', height: 1.735, bulk: 0.95,
    colour: '#c07cff', accent: '#5fd0ff', run: 7.9,
    skin: lin('#eec9a8', 0.42), hair: lin('#221812'), shirt: cloth('#7c3aed', 0.140, 0.26),
    pants: lin('#1a1f2b'), accentRgb: cloth('#5fd0ff', 0.210, 0.30), hat: lin('#1a1f2b', 1.4),
    hp: 124, gait: { strideK: 1.12, armSwing: 1.25, bounce: 1.12, sway: 0.95, lean: 3.0, stoop: -0.8 },
  },
};

export const BROTHER_IDS = Object.keys(BROTHERS);

/* ==================================================================== */
/* the advice system                                                     */
/* ==================================================================== */

/**
 * THE BEST IDEA IN THE GAME, and the cheapest system in this file.
 *
 * Every line has to do at least two of three jobs: teach a mechanic, teach a
 * control, or tell you something about this family. A line that only does the
 * first is a tooltip; a line that only does the third is filler. The voices are
 * fixed by DESIGN.md and are not interchangeable — **Carson is terse and dry,
 * Aidan is blunt and practical, Dylan never stops talking** — so a line that
 * would fit either of two brothers is in the wrong list.
 *
 * Controls quoted here are the GTA layout in `CONTROLS.md`: F is the one
 * contextual action, E/Q cycle weapons, V camera, H horn, M map, X the switch
 * wheel, Shift sprint.
 */
export const ADVICE = {
  carson: [
    'Heat gets bad, Rustbelt Respray. New paint, new man.',
    'Bridges are chokepoints. Cops know it too.',
    'Stand in the shop ring. It fixes the car and it fixes you. No button.',
    'Mom called. Kali says dinner Sunday. No excuses.',
    'Press F at a boat and the river becomes a road. Nobody blocks the river.',
    "Aunt Jessica's brakes are still going. Family rate. Which means free.",
    'M for the map when you are lost. You are lost.',
    'Health is the red arc, armour is the blue. Watch the blue go first.',
    'The Mon runs slower than it looks. So do you.',
    'X switches to one of us. We keep living while you are gone.',
  ],
  aidan: [
    'F does whatever makes sense — get in, get out, drag him out of the seat.',
    'E and Q walk the weapons. Do it before the fight, not during it.',
    'Hold Shift. In a car that is the nitro, and it is the difference.',
    'Pick the pickups up. Cash, health, armour, ammo — they come back in six seconds.',
    'Aim for the engine block. A dead car is a dead chase.',
    'Bring the car to the shop before it is a shape. I am good, not a magician.',
    'Lauren wants Primanti\'s on the way home. That is not optional either.',
    'V changes the camera. Use the close one indoors or you will eat a wall.',
    'H is the horn. Traffic moves for it more than you would think.',
    'Do not take a fight in the open when there is a doorway ten feet away.',
    'Mom asked after you. I said you were busy. Do not make me a liar again.',
    'Mike offered to bankroll the shop. A DeCarlo pays his own way. Politely.',
  ],
  dylan: [
    'The minimap shows pickups, cops, everything — USE it, that is why it glows!',
    'Okay okay okay so Shift is sprint, and in a car it is nitro, and nitro is FREE SPEED—',
    'Red dots are people who want to hit you. Blue-ish dots are us. Try to remember which.',
    'The ring at the shop repairs, refuels AND heals. Three things! For standing still!',
    'Gas stations are on the map. I have run dry twice. It is not funny, stop laughing.',
    'Mt. Washington to downtown is one river. One! Everyone thinks it is miles.',
    'Kali says happy birthday month, by the way. Cake Sunday at Mike\'s, do not be late.',
    'You can grab a pickup from the car — bigger radius, I checked, I actually checked.',
    'Tab is the weapon wheel, X is us, P is the phone. I read the whole thing.',
    'Bubfather says good luck. Don just grunted. I am choosing to take that as good luck.',
  ],
};

/** Lines a brother says as he goes down, and as he gets back up. */
const DOWN_LINES = [
  "I'm down — give me a second!",
  'Cover me, cover me!',
  "That's my ribs. That's definitely my ribs.",
  'Down! Do not leave me here!',
];
const UP_LINES = [
  "Back in it. Let's go.",
  "Okay — I'm good. I'm good.",
  "You can't keep a DeCarlo down.",
  'Right. Where were we.',
];
/** The line when he first spots something worth shooting at. */
const ENGAGE_LINES = [
  'On him!',
  "I've got the one on the left.",
  'Contact — moving!',
  'Say when. Actually, never mind.',
];

/* ==================================================================== */
/* one brother                                                           */
/* ==================================================================== */

class CrewMember {
  constructor(spec) {
    this.id = spec.id;
    this.name = spec.name;
    this.spec = spec;
    this.colour = spec.colour;

    this.ped = null;
    this.active = false;

    this.maxHp = spec.hp;
    this.hp = spec.hp;
    /** `up` is "on his feet". A brother is never `dead`. */
    this.up = true;

    /** Mission flags `game` drives. */
    this.guard = new THREE.Vector3();
    this.hasGuard = false;
    this.noRevive = false;
    this.isWard = false;

    this.reviveCd = 0;
    this.atkCd = 0;
    this.hurtCd = 0;
    this.talkCd = 0;
    this.target = null;
    this.engaged = false;
    this.inCar = false;
    this.vehicle = null;
    /** Seconds spent stranded while the player drives. See `TUNING.catchUp`. */
    this.catchUp = 0;
    /** Which way he stepped out of the firing lane; 0 = not in it. */
    this.laneSide = 0;
    this.inLane = false;
    /** Rounds of the player's own that landed on him. */
    this.friendlyHits = 0;

    this.wp = new THREE.Vector3();
    this.hasWp = false;
    this.wpCd = 0;
    /** His OWN face target. Sharing the manager's scratch made two brothers
     *  look wherever the second one was looking. */
    this.face = new THREE.Vector3();
    this.deck = [];
    this.deckAt = 0;
    /** The card just played, so a reshuffle cannot deal it again. */
    this.lastIdx = -1;

    /* counters the harness reads — cheap, and they cost nothing to keep */
    this.hits = 0;
    this.damageDealt = 0;
    this.downs = 0;
    this.revives = 0;
    this.lines = 0;
  }

  get position() {
    return this.ped ? this.ped.position : this.guard;
  }
}

/* ==================================================================== */
/* the manager                                                           */
/* ==================================================================== */

export class Crew {
  /** @param {import('./index.js').PedSystem} sys */
  constructor(sys) {
    this.sys = sys;
    this.ctx = sys.ctx;
    this.rng = sys.rng.fork();

    /** @type {CrewMember[]} live companions, at most CREW_MAX */
    this.members = [];
    /** @type {Ped[]} the dedicated ped slots, reused across spawn/despawn */
    this.pool = [];
    this.enabled = true;
    this.adviceEnabled = true;

    this._playerVehicle = null;
    this._boardToast = false;
    this._leaderId = null;
    /** Set true by a harness to prove the catch-up is what lands a brother. */
    this.catchUpEnabled = true;
    /** Set false by a harness to prove the yield is what clears the barrel. */
    this.fireLaneEnabled = true;
    this.carAvoidEnabled = true;
    this.stranded = 0;             // brothers on foot while the player drives
    /**
     * `Ped.applyDamage` reads both of these off this object rather than
     * importing `TUNING` back out of the module that imports it. A harness sets
     * `friendlyFireScale = 1` for the negative control, which is the build
     * where your own burst floors your brother.
     */
    this.friendlyFireScale = TUNING.friendlyFire;
    this.ffWindow = TUNING.ffWindow;

    /* scratch — nothing below allocates per frame */
    this._v = new THREE.Vector3();
    this._v2 = new THREE.Vector3();
    this._v3 = new THREE.Vector3();
    this._anchor = new THREE.Vector3();
    this._fwd = new THREE.Vector3(0, 0, -1);
    this._link = {};
    this._hostiles = [];
    this._blips = [];
    this._state = [];
    this._dmg = { target: null, amount: 0, headshot: false, killed: false, point: null, from: null, source: null };
    this._tracer = { from: new THREE.Vector3(), to: new THREE.Vector3(), speed: 420 };
    this.stats = { members: 0, up: 0, down: 0, inCar: 0, engaged: 0, hits: 0, lines: 0, ms: 0 };
  }

  /* ================================================================== */
  /* lifecycle                                                          */
  /* ================================================================== */

  /**
   * Spawn the companions. With no argument this is "the two brothers you are
   * not playing", read from whichever of `game` / `player` can tell us who is
   * on screen — which is the whole point of the feature.
   */
  spawn(ids = null) {
    const want = this._resolveIds(ids);
    // reconcile rather than rebuild: a character switch changes one of the two
    // and rebuilding both would pop a body that is standing in frame
    for (let i = this.members.length - 1; i >= 0; i--) {
      if (!want.includes(this.members[i].id)) this._remove(this.members[i]);
    }
    for (const id of want) {
      if (this.members.some((m) => m.id === id)) continue;
      const m = this._add(id);
      if (!m) break;
    }
    this.stats.members = this.members.length;
    return this.members.length;
  }

  despawn() {
    for (let i = this.members.length - 1; i >= 0; i--) this._remove(this.members[i]);
    this.stats.members = 0;
  }

  _resolveIds(ids) {
    if (Array.isArray(ids) && ids.length) {
      return ids.filter((id) => BROTHERS[id]).slice(0, CREW_MAX);
    }
    const active = this.activeBrother();
    const out = [];
    for (const id of BROTHER_IDS) if (id !== active) out.push(id);
    return out.slice(0, CREW_MAX);
  }

  /** Who the player is. Duck-typed across `game` and `player`. */
  activeBrother() {
    const g = this.ctx.peek('game');
    const fromGame = g?.character ?? g?.characters?.activeId ?? null;
    if (fromGame && BROTHERS[fromGame]) return fromGame;
    const p = this.ctx.peek('player');
    const fromPlayer = p?.brother?.id ?? p?.brotherId ?? null;
    if (fromPlayer && BROTHERS[fromPlayer]) return fromPlayer;
    return 'aidan';
  }

  _add(id) {
    const spec = BROTHERS[id];
    if (!spec || this.members.length >= CREW_MAX) return null;
    const ped = this._takePed();
    if (!ped) return null;

    const m = new CrewMember(spec);
    m.ped = ped;
    m.active = true;
    m.hp = m.maxHp;
    m.talkCd = this.rng.range(7, 15);

    const outfit = this._outfit(spec);
    this.sys._anchor(this._anchor);
    const a = this.rng.range(-Math.PI, Math.PI);
    const r = 2.2 + this.rng.float() * 1.6;
    this._v.set(this._anchor.x + Math.cos(a) * r, this._anchor.y, this._anchor.z + Math.sin(a) * r);
    this._v.y = this.sys.groundAt(this._v.x, this._v.z, this._v.y + 6);

    ped.spawn(outfit, this._v, a, this.rng.fork());
    this._dressPed(ped, m);
    this.members.push(m);
    this.ctx.events.emit('crew:spawn', { id: m.id, name: m.name });
    return m;
  }

  _remove(m) {
    const i = this.members.indexOf(m);
    if (i >= 0) this.members.splice(i, 1);
    if (m.ped) {
      this.sys._releaseBody(m.ped);
      m.ped.crew = null;
      m.ped.isCrew = false;
      m.ped.despawn();
    }
    m.ped = null;
    m.active = false;
  }

  /** A ped slot that the ambient streamer can never see, reused forever. */
  _takePed() {
    for (const p of this.pool) if (!p.active) return p;
    if (this.pool.length >= CREW_MAX) return null;
    const p = new Ped(this.sys);
    this.pool.push(p);
    return p;
  }

  /**
   * A brother's outfit: a normal wardrobe draw for the gait, props and
   * proportions, with the twelve-slot palette overwritten from `DESIGN.md`.
   * That keeps them inside the crowd's own material system — three draws, the
   * same shader, the same wet/dry response — while being unmistakably them.
   */
  _outfit(spec) {
    const rng = this.rng.fork();
    const o = makeOutfit(rng, 'street', { shape: spec.shape, rain: 0 });
    const p = o.palette;
    p[0] = spec.skin.slice();
    p[1] = spec.hair.slice();
    p[2] = spec.shirt.slice();
    p[3] = spec.pants.slice();       // jumper under the coat, reads as dark
    p[4] = spec.pants.slice();
    p[6] = spec.accentRgb.slice();   // collar / trim / the colour on the minimap
    p[7] = spec.hat.slice();
    p[11] = spec.accentRgb.slice();
    o.height = spec.height;
    o.scale = spec.height / 1.75;
    o.props = {};                    // no phone, no umbrella, no cigarette
    o.jogger = false;
    o.idle = ['wait'];
    o.speed = [TUNING.walkSpeed, spec.run];
    Object.assign(o.gait, spec.gait);
    return o;
  }

  _dressPed(ped, m) {
    ped.crew = m;
    ped.isCrew = true;
    ped.isFriendly = true;
    ped.state = STATE.CREW;
    ped.navMode = 'crew';
    ped.baseSpeed = TUNING.walkSpeed;
    ped.runSpeed = m.spec.run;
    ped.health = m.hp;
    ped.wanderTarget = null;
    ped.animator?.clearActs();
  }

  /* ================================================================== */
  /* the public surface `game`, `player` and `ui` use                    */
  /* ================================================================== */

  /** Pin a brother in place — `protect` chapters. Pass null to release. */
  setGuard(id, x, z) {
    const m = this.byId(id);
    if (!m) return false;
    if (x === null || x === undefined) {
      m.hasGuard = false;
      return true;
    }
    m.guard.set(x, this.sys.groundAt(x, z, 80), z);
    m.hasGuard = true;
    return true;
  }

  /**
   * Designate a mission ward: he holds a spot, he does not get himself up, and
   * `game` gets `crew:down` when the chapter is lost. `opts.noRevive` defaults
   * true because a ward that revives cannot be failed.
   */
  setWard(id, opts = {}) {
    const m = this.byId(id);
    if (!m) return null;
    for (const o of this.members) o.isWard = false;
    m.isWard = true;
    m.noRevive = opts.noRevive !== false;
    if (Number.isFinite(opts.x) && Number.isFinite(opts.z)) this.setGuard(id, opts.x, opts.z);
    if (opts.heal !== false) {
      m.hp = m.maxHp;
      if (!m.up) this.revive(m.id, true);
    }
    return m;
  }

  clearWard() {
    for (const m of this.members) {
      if (!m.isWard) continue;
      m.isWard = false;
      m.noRevive = false;
      m.hasGuard = false;
    }
  }

  byId(id) {
    for (const m of this.members) if (m.id === id) return m;
    return null;
  }

  /** Ids of the brothers currently on their feet. */
  alive(out = this._blips) {
    out.length = 0;
    for (const m of this.members) if (m.up) out.push(m.id);
    return out;
  }

  /**
   * Everything a HUD, a minimap or a mission needs, in a REUSED array of
   * REUSED records — call it every frame if you like.
   */
  state(out = this._state) {
    while (out.length < this.members.length) out.push({});
    out.length = this.members.length;
    for (let i = 0; i < this.members.length; i++) {
      const m = this.members[i];
      const r = out[i];
      const p = m.position;
      r.id = m.id;
      r.name = m.name;
      r.colour = m.colour;
      r.x = p.x;
      r.z = p.z;
      r.y = p.y;
      r.up = m.up;
      r.hp = m.hp;
      r.maxHp = m.maxHp;
      r.health = m.maxHp > 0 ? m.hp / m.maxHp : 0;
      r.inCar = m.inCar;
      r.guarding = m.hasGuard;
      r.ward = m.isWard;
      r.engaged = m.engaged;
      r.distance = this.sys.hasPlayer ? Math.hypot(p.x - this.sys.playerPos.x, p.z - this.sys.playerPos.z) : 0;
    }
    return out;
  }

  /** Force a line out of a brother. `game` uses this for scripted beats. */
  say(id, line) {
    const m = this.byId(id) ?? { id, name: BROTHERS[id]?.name ?? id };
    const ui = this.ctx.peek('ui');
    if (ui?.say) {
      try { ui.say(m.id, line); } catch { /* the HUD is not our problem */ }
    }
    this.ctx.events.emit('crew:line', { id: m.id, line });
    if (m.lines !== undefined) m.lines++;
    this.stats.lines++;
    return true;
  }

  /** The whole advice pool for a brother — for `game`, the phone, and tests. */
  linesFor(id) {
    return ADVICE[id] ?? null;
  }

  /** One advice line from this brother's pool, shuffled, no repeats in a lap. */
  advise(id) {
    const m = this.byId(id);
    if (!m) return false;
    const pool = ADVICE[m.id];
    if (!pool || !pool.length) return false;
    if (m.deckAt >= m.deck.length) {
      m.deck.length = 0;
      for (let i = 0; i < pool.length; i++) m.deck.push(i);
      for (let i = m.deck.length - 1; i > 0; i--) {
        const j = this.rng.u32() % (i + 1);
        const t = m.deck[i]; m.deck[i] = m.deck[j]; m.deck[j] = t;
      }
      /**
       * THE LAP BOUNDARY. A shuffled deck cannot repeat WITHIN a lap, which is
       * the property everybody remembers to check — and it is not the property
       * the player hears. He hears two consecutive lines, and the last card of
       * one deck and the first card of the next are consecutive. One shuffle in
       * `pool.length` (about 1 in 10) said the same thing twice in a row.
       */
      if (m.deck.length > 1 && m.deck[0] === m.lastIdx) {
        const t = m.deck[0]; m.deck[0] = m.deck[1]; m.deck[1] = t;
      }
      m.deckAt = 0;
    }
    m.lastIdx = m.deck[m.deckAt++];
    return this.say(m.id, pool[m.lastIdx]);
  }

  /* ================================================================== */
  /* damage — routed here from `Ped.applyDamage` so a brother goes DOWN  */
  /* ================================================================== */

  /**
   * A brother never dies. `Ped.applyDamage` and `Ped.hitByVehicle` hand their
   * damage here instead of to the health field, and the worst outcome is
   * `STATE.DOWN` — a real ragdoll, on the pavement, that gets itself up.
   * `scale` halves splash damage.
   */
  hurt(m, amount, point, dir, scale = 1) {
    if (!m || !m.up || !m.active) return false;
    const dmg = Math.max(0, amount) * scale;
    if (dmg <= 0) return false;
    m.hp -= dmg;
    const ped = m.ped;
    if (ped) {
      ped.health = m.hp;
      ped.animator?.flinch(1.1);
    }
    this.ctx.events.emit('crew:hurt', { id: m.id, amount: dmg, hp: m.hp, maxHp: m.maxHp });
    if (m.hp <= 0) this.down(m.id, point, dir);
    return true;
  }

  /** Put a brother on the floor. Public: a scripted beat may want this. */
  down(id, point, dir) {
    const m = typeof id === 'string' ? this.byId(id) : id;
    if (!m || !m.up) return false;
    m.up = false;
    m.hp = 0;
    m.reviveCd = TUNING.revive;
    m.engaged = false;
    m.target = null;
    m.downs++;
    const ped = m.ped;
    if (ped) {
      ped.health = 1;
      // `_down(..., lethal=false)` is the real ragdoll path: colliders drop,
      // the animator hands the pose to physics and the body lands where it was
      // standing. It also emits `actor:death`, which we do NOT want for a
      // brother — so go through the non-lethal door and re-flag afterwards.
      this._v.copy(point ?? ped.position);
      this._v2.copy(dir ?? this._v3.set(0, 0, 1));
      if (this._v2.lengthSq() < 1e-6) this._v2.set(0, 0, 1);
      this._v2.normalize().multiplyScalar(2.4);
      ped._down(this._v, this._v2, false);
      ped.alive = true;               // a downed brother is not a corpse
      ped.state = STATE.DOWN;
      ped._downTime = -1e6;           // block Ped's own get-up timer; we own it
    }
    this.say(m.id, DOWN_LINES[this.rng.u32() % DOWN_LINES.length]);
    this.ctx.events.emit('crew:down', {
      id: m.id, name: m.name, ward: m.isWard, noRevive: m.noRevive,
      x: m.position.x, z: m.position.z,
    });
    return true;
  }

  /** He gets himself up, next to you, and says so. */
  revive(id, silent = false) {
    const m = typeof id === 'string' ? this.byId(id) : id;
    if (!m || m.up) return false;
    m.up = true;
    m.hp = m.maxHp;
    m.reviveCd = 0;
    m.atkCd = 0;
    m.revives++;
    const ped = m.ped;
    if (ped) {
      if (ped.ragdoll) {
        this.sys.phys?.removeRagdoll(ped.ragdoll);
        ped.ragdoll = null;
        ped.__ragdoll = null;
      }
      // beside the player, not where the body fell — a brother who gets up
      // 60 m behind you might as well be dead
      const a = this.sys._anchor(this._anchor);
      const ang = this.rng.range(-Math.PI, Math.PI);
      const r = 2.0 + this.rng.float() * 1.6;
      ped.position.set(a.x + Math.cos(ang) * r, a.y, a.z + Math.sin(ang) * r);
      ped.position.y = this.sys.groundAt(ped.position.x, ped.position.z, ped.position.y + 6);
      ped.groundY = ped.position.y;
      ped.alive = true;
      ped.health = m.maxHp;
      ped.state = STATE.CREW;
      ped.speed = 0;
      ped.velocity.set(0, 0, 0);
      ped._downTime = 0;
      ped._deadTime = 0;
      ped.fear = 0;
      if (ped.animator) {
        ped.animator.enabled = true;
        ped.animator.clearActs();
      }
      if (ped.body) ped._makeColliders();
    }
    if (!silent) this.say(m.id, UP_LINES[this.rng.u32() % UP_LINES.length]);
    this.ctx.events.emit('crew:revive', { id: m.id, name: m.name });
    return true;
  }

  /* ================================================================== */
  /* frame                                                              */
  /* ================================================================== */

  /**
   * Runs BEFORE the ped update loop: it writes `_steer`, `desiredSpeed` and
   * `faceTarget` on each companion's ped, and `Ped._move` — which leaves
   * `STATE.CREW` steering alone, exactly as it does for FLEE and FIGHT —
   * integrates them with the crowd's own avoidance and ground following.
   */
  update(dt, anchor) {
    const t0 = performance.now();
    if (!this.members.length) {
      this.stats.ms = 0;
      return;
    }
    this._vehicleTick(dt);
    const hostiles = this._gatherHostiles(anchor);
    this._readAim();

    let up = 0, downCount = 0, inCar = 0, engaged = 0;
    for (let i = 0; i < this.members.length; i++) {
      const m = this.members[i];
      if (!m.active || !m.ped) continue;
      if (m.ped._vehHitCd > 0) m.ped._vehHitCd -= dt;

      if (m.inCar) {
        this._rideAlong(m);
        inCar++;
        continue;
      }
      if (!m.up) {
        downCount++;
        this._tickDown(m, dt);
        continue;
      }
      up++;
      this._think(m, dt, anchor, hostiles);
      if (m.engaged) engaged++;
      this._tickTalk(m, dt);
    }

    this.stats.up = up;
    this.stats.down = downCount;
    this.stats.inCar = inCar;
    this.stats.engaged = engaged;
    this.stats.members = this.members.length;
    this.stats.ms = performance.now() - t0;
  }

  _tickDown(m, dt) {
    // A ward with `noRevive` stays down. That is the whole point: it is what
    // makes a `protect` chapter something you can actually lose.
    if (m.noRevive) return;
    m.reviveCd -= dt;
    if (m.reviveCd <= 0) this.revive(m);
  }

  /* ---- brain ---------------------------------------------------------- */

  _think(m, dt, anchor, hostiles) {
    const ped = m.ped;

    /* --- leash. A brother who has been left 90 m behind is not fun to watch
       jog; he catches up off-screen and is simply there.

       EXCEPT when the player is DRIVING, and this is the bug that made the
       crew a liability. The anchor is the player, the player is the car, so
       the warp put a man on foot four metres from a moving vehicle — which
       `_vehicleThreats` then hit, at 8.4 damage a time, repeatedly. While the
       player is in a car the catch-up in `_board` owns the reunion and it puts
       him in the back seat, not on the tarmac. --- */
    const ax = m.hasGuard ? m.guard.x : anchor.x;
    const az = m.hasGuard ? m.guard.z : anchor.z;
    const dAnchor = Math.hypot(ped.position.x - ax, ped.position.z - az);
    if (dAnchor > TUNING.leash) {
      if (this._playerVehicle && !m.hasGuard) {
        // keep him running the right way, so that if you stop he is closing
        this._follow(m, dt, ax, az);
        return;
      }
      this._warpTo(m, ax, az);
      return;
    }

    /* --- pick a fight --- */
    const target = this._acquire(m, hostiles);
    if (target && !m.engaged) {
      m.engaged = true;
      if (this.rng.float() < 0.5) this.say(m.id, ENGAGE_LINES[this.rng.u32() % ENGAGE_LINES.length]);
    } else if (!target) {
      m.engaged = false;
    }
    m.target = target;

    if (target) this._fight(m, dt, target);
    else this._follow(m, dt, ax, az);

    /* --- and then get out of the way. Both brains above steer at something;
       this is the only thing in the file that steers AWAY, and it is what
       stops a companion being a liability. --- */
    this._yield(m);

    /* --- and take some back. `game`'s hostiles only ever swing at the
       player, so without this a brother in the middle of a brawl is
       invulnerable and `noRevive` means nothing. --- */
    if (target) {
      m.hurtCd -= dt;
      const d = Math.hypot(target.x - ped.position.x, target.z - ped.position.z);
      if (d < 3.2 && m.hurtCd <= 0) {
        m.hurtCd = TUNING.incomingCycle;
        this._v.set(target.x, ped.position.y + 1.1, target.z);
        this._v3.copy(ped.position).sub(this._v).setY(0);
        this.hurt(m, TUNING.incoming, this._v, this._v3);
      }
    } else {
      m.hurtCd = 0;
    }
  }

  /**
   * FOLLOW. Direct steering close in; a pavement waypoint past `SIDEWALK_AT`
   * so a brother crossing three blocks walks the street network instead of
   * ploughing a straight line through the middle of the carriageway — or into
   * the river, which is a third of this map.
   */
  _follow(m, dt, ax, az) {
    const ped = m.ped;
    // put the hands down: `film` is the aim layer `_fight` raises, and it eases
    // rather than snapping, so clearing it here is what makes him lower the
    // weapon when the last hostile drops instead of walking home still aiming
    ped.animator?.setAct('film', 0);
    const hold = m.hasGuard ? TUNING.guardHold : TUNING.follow;
    const dx = ax - ped.position.x;
    const dz = az - ped.position.z;
    const d = Math.hypot(dx, dz);

    if (d <= hold) {
      ped.desiredSpeed = 0;
      ped._steer.set(0, 0, 0);
      m.hasWp = false;
      // stand facing roughly the way the player is facing, not at his back
      ped.faceTarget = null;
      return;
    }

    let tx = ax, tz = az;
    m.wpCd -= dt;
    if (d > SIDEWALK_AT) {
      if (m.wpCd <= 0) {
        m.wpCd = 1 / WAYPOINT_HZ;
        m.hasWp = this._pavementWaypoint(ped.position, ax, az, m.wp);
      }
      if (m.hasWp) { tx = m.wp.x; tz = m.wp.z; }
    } else {
      m.hasWp = false;
    }

    const sx = tx - ped.position.x;
    const sz = tz - ped.position.z;
    const sd = Math.hypot(sx, sz) || 1;
    ped._steer.set(sx / sd, 0, sz / sd);

    // Speed scales with how far behind he is — a companion who sprints to
    // close a two-metre gap and then stops dead looks like a bug. He runs on
    // his own legs up close; the catch-up ceiling only once he is properly behind
    const cap = d > TUNING.catchUpAt ? TUNING.runSpeed : m.spec.run;
    const want = Math.min(d * 0.62, cap);
    ped.desiredSpeed = want < TUNING.walkSpeed * 0.8 ? want : Math.max(want, TUNING.walkSpeed);
    ped.faceTarget = null;
  }

  /* ---- getting out of the way ------------------------------------------ */

  /**
   * Cache the player's firing line for this frame. The lane is only HOT while
   * he is aiming or has fired inside `fireHot` seconds: a companion that
   * dodges the camera direction permanently never walks beside you, which is
   * worse than the problem it solves.
   */
  _readAim() {
    this._aimHot = false;
    const p = this._player ?? (this._player = this.ctx.peek('player'));
    if (!p || p.inVehicle || p.dead) return;
    const t = this.ctx.time?.elapsed ?? 0;
    const sinceShot = t - (this.sys.playerShotAt ?? -1e9);
    if (!p.aiming && sinceShot > TUNING.fireHot) return;
    const f = p.forward;
    if (!f) return;
    this._fwd.set(f.x, 0, f.z);
    if (this._fwd.lengthSq() < 1e-6) return;
    this._fwd.normalize();
    this._aimHot = true;
  }

  /**
   * THE ONE STEERING TERM THAT POINTS AWAY.
   *
   * Two contributions, summed into the ped's steer before `Ped._move` runs its
   * own crowd avoidance and normalises:
   *
   *   FIRING LANE  a corridor `fireLane` metres either side of the player's aim
   *                for `fireLaneLen` down it. He picks a side ONCE on entering
   *                and holds it (`m.laneSide`) — recomputing the sign every
   *                frame makes a man on the axis vibrate across it.
   *   PARKED CARS  `physics.blockers`, the same snapshot `CharacterController`
   *                uses, with a radial push AND a tangent chosen to agree with
   *                wherever he was already going — a pure radial term makes him
   *                stand off the bumper of the car between him and you instead
   *                of walking round it.
   *
   * He also has to actually MOVE to clear either, so this raises `desiredSpeed`
   * off zero for a brother who was standing at his follow distance.
   */
  _yield(m) {
    const ped = m.ped;
    let ax = 0;
    let az = 0;

    m.inLane = false;
    if (this._aimHot && this.fireLaneEnabled && this.sys.hasPlayer) {
      const fx = this._fwd.x;
      const fz = this._fwd.z;
      const dx = ped.position.x - this.sys.playerPos.x;
      const dz = ped.position.z - this.sys.playerPos.z;
      const along = dx * fx + dz * fz;          // down the barrel
      const perp = dx * fz - dz * fx;           // across it, signed
      const lane = TUNING.fireLane + ped.radius;
      if (along > 0.5 && along < TUNING.fireLaneLen && Math.abs(perp) < lane) {
        m.inLane = true;
        // the side is chosen ONCE on entering and held until he leaves;
        // recomputing the sign every frame makes a man on the axis vibrate
        // across it instead of committing to a direction
        if (!m.laneSide) m.laneSide = perp >= 0 ? 1 : -1;
        // urgency peaks on the axis and near the muzzle, where it matters
        const near = 1 - Math.min(1, along / TUNING.fireLaneLen) * 0.55;
        const w = TUNING.fireYield * (1 - Math.abs(perp) / lane) * near * m.laneSide;
        ax += fz * w;
        az += -fx * w;
      }
    }
    if (!m.inLane) m.laneSide = 0;

    if (this.carAvoidEnabled) {
      const phys = this._phys ?? (this._phys = this.ctx.peek('physics'));
      const b = phys?.blockers;
      if (b && b.n) {
        const py = ped.position.y + 0.9;
        for (let i = 0; i < b.n; i++) {
          if (b.obj[i] === this._playerVehicle) continue;   // not your own ride
          const dx = ped.position.x - b.x[i];
          const dz = ped.position.z - b.z[i];
          const R = b.r[i] + ped.radius + TUNING.carClear;
          const d2 = dx * dx + dz * dz;
          if (d2 >= R * R || d2 < 1e-6) continue;
          if (Math.abs(py - b.y[i]) > b.h[i] + 1.5) continue;  // a deck overhead is not a wall
          const d = Math.sqrt(d2);
          /* Sharpened falloff. A plain linear ramp gave 0.33 of steer against
             a goal direction of 1.0 at the point it mattered, so a brother at
             a jog simply curved slightly and clipped the rear wing anyway.
             `t*(1+2t)` leaves the gentle outer nudge alone and triples the
             term once he is properly close. */
          const t = 1 - d / R;
          const w = TUNING.carAvoid * t * (1 + 2 * t);
          ax += (dx / d) * w;
          az += (dz / d) * w;
          const tx = -dz / d;
          const tz = dx / d;
          const sgn = tx * ped._steer.x + tz * ped._steer.z >= 0 ? 1 : -1;
          ax += tx * sgn * w * 0.85;
          az += tz * sgn * w * 0.85;
        }
      }
    }

    if (ax === 0 && az === 0) return;
    ped._steer.x += ax;
    ped._steer.z += az;
    const mag = Math.hypot(ax, az);
    ped.desiredSpeed = Math.max(ped.desiredSpeed, Math.min(m.spec.run, 1.7 + mag * 1.3));
  }

  /**
   * THE HARD FLOOR, applied AFTER `Ped._move` has integrated.
   *
   * Steering alone can only bend a path. This is the SAME resolution
   * `CharacterController._pushOutOfVehicles` gives the player's own capsule:
   * the same `blockers` snapshot, the same radius, the same 0.10 m per-step
   * cap. A brother is therefore exactly as solid to a car as you are — no
   * better, and, which is the point, no worse.
   *
   * The first version pushed only out of the body box's INSCRIBED circle and
   * left him grazing 0.72 m into the panels while the player's capsule reaches
   * 0.18 m (measured by `src/physics/carblock.mjs`). That gap was a shoulder
   * through a rear wing.
   *
   * `blockers.r` is a CIRCLE of `max(W,L)/2 * 0.72` and is deliberately shorter
   * than the nose, so a small head-on overlap survives by design and is what
   * `carblock.mjs` ratchets. That is a property of the blocker set, not of this
   * code, and it goes away the day blockers become boxes.
   */
  depenetrate(ped) {
    const phys = this._phys ?? (this._phys = this.ctx.peek('physics'));
    const b = phys?.blockers;
    if (!b || !b.n) return;
    const footY = ped.position.y;
    const headY = ped.position.y + 1.8;
    for (let i = 0; i < b.n; i++) {
      const v = b.obj[i];
      if (!v || v === this._playerVehicle) continue;
      const R = b.r[i] + ped.radius;
      const dx = ped.position.x - b.x[i];
      const dz = ped.position.z - b.z[i];
      const d2 = dx * dx + dz * dz;
      if (d2 >= R * R) continue;
      // the controller's own vertical gate: a roof is ground, a deck overhead
      // is not a wall
      if (footY > b.y[i] + b.h[i] * 0.8) continue;
      if (headY < b.y[i] - b.h[i]) continue;
      const d = Math.sqrt(d2);
      let ux, uz;
      if (d > 1e-4) { ux = dx / d; uz = dz / d; }
      else { ux = 1; uz = 0; }              // dead centre has no line of centres
      const pen = Math.min(0.10, R - d);
      ped.position.x += ux * pen;
      ped.position.z += uz * pen;
    }
  }

  /**
   * A point on the sidewalk network that is on the way to the anchor. Probes
   * the mid-point of the direct line: if the pavement there is closer to the
   * anchor than we are, take it; otherwise walk the crow and let `Ped._move`'s
   * water check turn us round.
   */
  _pavementWaypoint(from, ax, az, out) {
    const net = this.sys.net;
    if (!net.ready) return false;
    const mx = from.x + (ax - from.x) * 0.55;
    const mz = from.z + (az - from.z) * 0.55;
    const link = net.nearestLink(mx, mz, this._link);
    if (!link || !link.edge) return false;
    net.pointOn(link.edge, link.side, link.t, out);
    if (!Number.isFinite(out.x)) return false;
    // never accept a waypoint that walks us away from the player
    const dNow = Math.hypot(from.x - ax, from.z - az);
    const dWp = Math.hypot(out.x - ax, out.z - az);
    if (dWp > dNow - 2) return false;
    if (this.sys.isWaterAt(out.x, out.z)) return false;
    return true;
  }

  /**
   * FIGHT — and this is the part everybody gets wrong. Seven damage every
   * 1.5 s. He closes, he keeps the pressure on, he is unmistakably helping,
   * and he will not finish the fight for you. Do not raise these numbers.
   */
  _fight(m, dt, target) {
    const ped = m.ped;

    /**
     * FLANK, DO NOT CHARGE THROUGH THE MUZZLE.
     *
     * The lateral shove in `_yield` is not enough on its own, and the trace
     * that proved it is worth keeping: with a hostile standing 16 m dead ahead
     * of an aiming player, both brothers were pushed out to 1.7 m off the
     * axis in the first second — and then walked straight back onto it,
     * -1.7 -> -1.1 -> -0.4, because the point they were closing on WAS the
     * axis. A push cannot win against a goal; the goal has to move.
     *
     * So while the lane is hot the standoff point is offset sideways by the
     * corridor's own half-width plus a margin, on whichever side he already
     * chose. He still closes, still strikes from `strike` metres, and arrives
     * beside the target rather than in front of the player's barrel.
     */
    let gx = target.x;
    let gz = target.z;
    if (this._aimHot && this.fireLaneEnabled && this.sys.hasPlayer) {
      if (!m.laneSide) {
        const side = (ped.position.x - this.sys.playerPos.x) * this._fwd.z -
                     (ped.position.z - this.sys.playerPos.z) * this._fwd.x;
        m.laneSide = side >= 0 ? 1 : -1;
      }
      const off = (TUNING.fireLane + ped.radius + 1.0) * m.laneSide;
      gx += this._fwd.z * off;
      gz += -this._fwd.x * off;
    }

    /* `dGoal` is what he steers and paces to; `d` is the distance to the MAN
       and is what the strike gate, the punch-vs-tracer choice and the aim
       layer all read. Conflating the two would make a flanking brother refuse
       to swing because his standoff point is 2 m further away than the goon. */
    const dx = gx - ped.position.x;
    const dz = gz - ped.position.z;
    const dGoal = Math.hypot(dx, dz) || 1;
    const d = Math.hypot(target.x - ped.position.x, target.z - ped.position.z) || 1;
    ped._steer.set(dx / dGoal, 0, dz / dGoal);

    if (dGoal > TUNING.close) {
      ped.desiredSpeed = Math.min(m.spec.run, 3.4 + dGoal * 0.22);
    } else {
      ped.desiredSpeed = 0;
      m.face.set(target.x, ped.position.y + 1.1, target.z);
      ped.faceTarget = m.face;
    }
    // the aim layer the officer pool also uses; hands come up, torso squares
    ped.animator?.setAct('film', d > TUNING.close ? 0.45 : 0.95);

    m.atkCd -= dt;
    if (d >= TUNING.strike || m.atkCd > 0) return;
    m.atkCd = TUNING.cycle;
    this._strike(m, target, d);
  }

  _strike(m, target, d) {
    const ped = m.ped;
    const from = this._tracer.from;
    const to = this._tracer.to;
    from.set(ped.position.x, ped.position.y + 1.32, ped.position.z);
    to.set(target.x, (target.y ?? ped.position.y) + 1.08, target.z);

    if (d <= TUNING.close + 0.4) {
      ped.animator?.punchNow(this.rng.float() < 0.5 ? -1 : 1);
    } else {
      // tracer only: emitting `weapon:fire` would send the whole crowd into a
      // panic and tell `police` the PLAYER just fired, every 1.5 seconds
      this.ctx.events.emit('bullet:tracer', this._tracer);
    }

    const p = this._dmg;
    p.target = target.ref;
    p.amount = TUNING.damage;
    p.headshot = false;
    p.killed = false;
    p.point = to;
    p.from = from;
    p.source = ped;
    this.ctx.events.emit('damage:dealt', p);

    m.hits++;
    m.damageDealt += TUNING.damage;
    this.stats.hits++;
  }

  /* ---- targeting ------------------------------------------------------ */

  /**
   * Anything that wants the player dead: `game`'s mission hostiles, and the
   * police once the player is actually wanted. Rebuilt once a frame into a
   * pooled array of flat records so the two brains below never touch another
   * subsystem's object layout twice.
   */
  _gatherHostiles(anchor) {
    const out = this._hostiles;
    const pool = this._hostPool ?? (this._hostPool = []);
    out.length = 0;
    let n = 0;
    const push = (ref, x, y, z) => {
      if (!Number.isFinite(x)) return;
      if (Math.hypot(x - anchor.x, z - anchor.z) > TUNING.engage + 26) return;
      let r = pool[n];
      if (!r) pool[n] = r = { ref: null, x: 0, y: 0, z: 0 };
      n++;
      r.ref = ref; r.x = x; r.y = y; r.z = z;
      out.push(r);
    };

    const game = this._game ?? (this._game = this.ctx.peek('game'));
    const live = game?.hostiles?.live;
    if (live && typeof live.length === 'number') {
      for (let i = 0; i < live.length; i++) {
        const h = live[i];
        if (!h || !h.active || h.dead) continue;
        const p = h.position;
        if (p) push(h, p.x, p.y, p.z);
      }
    }

    // Cops are only hostile when you are wanted. Shooting a patrolman who is
    // directing traffic is not "chipping in".
    const police = this._police ?? (this._police = this.ctx.peek('police'));
    if (police && (police.level ?? 0) > 0) {
      const peds = this.sys.live;
      for (let i = 0; i < peds.length; i++) {
        const p = peds[i];
        if (!p.isPolice || !p.alive || p.isCrew) continue;
        push(p, p.position.x, p.position.y, p.position.z);
      }
    }
    return out;
  }

  _acquire(m, hostiles) {
    if (!hostiles.length) return null;
    const ped = m.ped;
    let best = null;
    let bd = TUNING.engage * TUNING.engage;
    // a guarding brother does not chase; he defends his post
    const reach = m.hasGuard ? Math.min(TUNING.engage, 14) : TUNING.engage;
    const r2 = reach * reach;
    for (let i = 0; i < hostiles.length; i++) {
      const h = hostiles[i];
      const dx = h.x - ped.position.x;
      const dz = h.z - ped.position.z;
      const d2 = dx * dx + dz * dz;
      if (d2 > r2 || d2 > bd) continue;
      bd = d2;
      best = h;
    }
    return best;
  }

  /* ---- vehicles ------------------------------------------------------- */

  /**
   * "The crew hops in with you" — `CONTROLS.md` calls this a signature of the
   * premise, and it is. Polled rather than driven off `vehicle:enter` because
   * that event is raised by `vehicles.setDriver` OR by `player`, and a missed
   * or doubled edge would leave a brother invisible in a car that is no longer
   * there.
   *
   * TWO doors, not one, and the second is the whole difference between a crew
   * and a pair of stragglers:
   *
   *   the ENTER EDGE   everyone inside `board` (30 m) is in, instantly. This is
   *                    what the player feels: you press F, the doors thunk,
   *                    you all leave.
   *   RIDING ON        a brother who missed it keeps running at the car, and
   *                    boards the moment he is inside 30 m — you slow for a
   *                    junction and he is in. If the car simply outruns him for
   *                    `catchUp` seconds he is in anyway, off-screen.
   *
   * Without the second door the leash in `_think` fires instead and drops him
   * in front of the car. See `TUNING.catchUp`.
   */
  _vehicleTick(dt) {
    const p = this._player ?? (this._player = this.ctx.peek('player'));
    const v = p && p.inVehicle ? (p.vehicle ?? null) : null;

    if (v !== this._playerVehicle) {
      const prev = this._playerVehicle;
      this._playerVehicle = v;
      for (const m of this.members) m.catchUp = 0;
      if (v) this._board(v, true, 0);
      else this._disembark(prev);
      return;
    }
    if (!v) {
      this.stranded = 0;
      return;
    }
    this._board(v, false, dt);
  }

  /**
   * @param {*} v         the player's vehicle
   * @param {boolean} edge true on the frame he got in — instant, 30 m, no timer
   * @param {number} dt    seconds, for the catch-up clock
   */
  _board(v, edge, dt) {
    const vp = v.position ?? v.object3D?.position ?? null;
    if (!vp) return;
    let seat = 0;
    for (const m of this.members) if (m.inCar) seat++;

    let boarded = 0;
    let stranded = 0;
    for (const m of this.members) {
      if (!m.active || !m.ped || m.inCar) continue;
      // a brother holding a post does not abandon it, and a brother on the
      // floor is not climbing into anything
      if (m.hasGuard || !m.up) { m.catchUp = 0; continue; }
      stranded++;
      const d = Math.hypot(m.ped.position.x - vp.x, m.ped.position.z - vp.z);
      if (d <= TUNING.board) {
        this._seat(m, v, seat++);
        boarded++;
        stranded--;
        continue;
      }
      if (edge || !this.catchUpEnabled) { m.catchUp = 0; continue; }
      m.catchUp += dt;
      if (m.catchUp < TUNING.catchUp) continue;
      this._seat(m, v, seat++);
      boarded++;
      stranded--;
    }
    this.stranded = stranded;
    if (!boarded) return;
    const ui = this.ctx.peek('ui');
    try {
      ui?.notify?.(boarded > 1 ? 'THE CREW HOPPED IN' : `${this.members.find((m) => m.inCar)?.name.toUpperCase()} HOPPED IN`,
        null, 'slag');
    } catch { /* HUD optional */ }
    this.ctx.events.emit('crew:board', { count: boarded, vehicle: v, caught: !edge });
  }

  /** Put one brother in the car: body released, out of the crowd grid. */
  _seat(m, v, seat) {
    m.inCar = true;
    m.catchUp = 0;
    m.vehicle = v;
    m.engaged = false;
    m.target = null;
    m.hasWp = false;
    const ped = m.ped;
    ped.vehicle = v;
    ped.state = STATE.DRIVING;
    ped.seat = 1 + seat;
    ped.isDriver = false;
    ped.speed = 0;
    ped.velocity.set(0, 0, 0);
    ped._steer.set(0, 0, 0);
    ped.desiredSpeed = 0;
    this.sys._releaseBody(ped);
  }

  _disembark(v) {
    const vp = v?.position ?? v?.object3D?.position ?? null;
    let k = 0;
    for (const m of this.members) {
      if (!m.inCar || !m.ped) continue;
      m.inCar = false;
      m.vehicle = null;
      m.catchUp = 0;
      const ped = m.ped;
      ped.vehicle = null;
      ped.seat = -1;
      ped.state = STATE.CREW;
      const a = this.sys._anchor(this._anchor);
      const bx = vp?.x ?? a.x;
      const bz = vp?.z ?? a.z;
      const side = k === 0 ? -1 : 1;
      ped.position.set(bx + side * 1.9, a.y, bz + 1.4);
      ped.position.y = this.sys.groundAt(ped.position.x, ped.position.z, ped.position.y + 6);
      ped.groundY = ped.position.y;
      ped.speed = 0;
      ped.velocity.set(0, 0, 0);
      ped.animator?.clearActs();
      k++;
    }
    if (k) this.ctx.events.emit('crew:exit', { count: k, vehicle: v });
  }

  /** Riding along: the body is away, but the position tracks so the map does. */
  _rideAlong(m) {
    const v = m.vehicle;
    const vp = v?.position ?? v?.object3D?.position ?? null;
    if (!vp || !this._playerVehicle) {
      this._disembark(v);
      return;
    }
    m.ped.position.set(vp.x, vp.y, vp.z);
  }

  _warpTo(m, ax, az) {
    const ped = m.ped;
    const ang = this.rng.range(-Math.PI, Math.PI);
    const r = 4 + this.rng.float() * 2;
    ped.position.set(ax + Math.cos(ang) * r, ped.position.y, az + Math.sin(ang) * r);
    ped.position.y = this.sys.groundAt(ped.position.x, ped.position.z, ped.position.y + 40);
    ped.groundY = ped.position.y;
    ped.speed = 0;
    ped.velocity.set(0, 0, 0);
    ped._steer.set(0, 0, 0);
    ped.desiredSpeed = 0;
    m.hasWp = false;
  }

  /* ---- the advice timer ----------------------------------------------- */

  _tickTalk(m, dt) {
    if (!this.adviceEnabled) return;
    m.talkCd -= dt;
    if (m.talkCd > 0) return;
    m.talkCd = this.rng.range(TUNING.adviceMin, TUNING.adviceMax);
    if (this.rng.float() >= TUNING.adviceChance) return;
    this.advise(m.id);
  }

  /* ================================================================== */

  dispose() {
    this.despawn();
    this.pool.length = 0;
  }
}
