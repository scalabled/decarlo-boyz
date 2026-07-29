import { DEG } from './mathx.js';

/**
 * THE IMPROVISED ARSENAL — sixteen weapons.
 *
 * ---------------------------------------------------------------------------
 * THE CONTRACT WITH `game` AND `ui`
 * ---------------------------------------------------------------------------
 * `src/game/data.js` and `src/ui/data.js` both carry a copy of the weapon table
 * and drive the economy, the ammo shops, the weapon wheel and the HUD off it.
 * The five numbers in that table are AUTHORITATIVE and are reproduced verbatim
 * in the `lib` block of every entry below:
 *
 *     dmg      damage per projectile (per PELLET for the Paint Cannon)
 *     rate     seconds between shots  ->  rpm = 60 / rate
 *     range    effective range in metres, and the damage-falloff scale
 *     ammo     total rounds carried
 *     pellets / splash / melee / emp   behaviour flags
 *
 * Magazine sizes come from `src/ui/data.js` so the HUD's pip strip and this
 * system's reload agree; everything else on this page is the engine-side
 * interpretation needed to actually FIRE the thing: muzzle velocity, drag,
 * penetration, spread, recoil and handling times.
 *
 * ---------------------------------------------------------------------------
 * HOW THE AUTHORED NUMBERS BECOME BALLISTICS
 * ---------------------------------------------------------------------------
 * The authored numbers describe hitscan with a flat range cut-off. This engine
 * simulates every projectile with gravity and drag (see `ballistics.js`), so
 * `range` has to be re-expressed as a velocity that gets a projectile there on
 * a believable arc rather than as a number compared against a distance:
 *
 *     a 46 m nail    at  105 m/s  drops 0.10 m and takes 0.44 s
 *     a 70 m spear   at   58 m/s  drops 0.72 m and takes 1.21 s
 *     a 95 m harpoon at   72 m/s  drops 0.86 m and takes 1.32 s
 *     a 95 m nitro   at   38 m/s  drops 3.1  m and takes 2.5  s   (a LOB)
 *
 * That is the whole design of this arsenal: nothing here is a rifle. The fast
 * flat weapon in the set (Rivet Gun, 240 m/s) is still a third of an M4's
 * muzzle velocity, so leading a moving target is a skill in every one of them,
 * and the heavy explosives are thrown in an arc you have to judge.
 *
 * `dropoff` is the fraction of damage still on the projectile at `range`;
 * `maxRange` is where it is deleted, set to 1.6x `range` so a shot past the
 * effective distance still connects, just weakly.
 *
 * ---------------------------------------------------------------------------
 * WHO CARRIES WHAT (DESIGN.md)
 * ---------------------------------------------------------------------------
 *   Carson  fists · pipe   -> flare, speargun, harpoon, depth
 *   Aidan   fists · wrench -> nailgun, sprayer, rivetgun, launcher
 *   Dylan   fists · crowbar-> tackgun, emp, smg, rocket
 */

/* Shared handling defaults, overridden per weapon. */
const HANDLE = {
  drawTime: 0.5,
  holsterTime: 0.34,
  reloadTac: 2.0,
  reloadEmpty: 2.6,
  adsTime: 0.24,
  adsFov: 0.82,
  swayScale: 1,
  tracerEvery: 2,
  penetration: 0.4,
  dragK: 0.35,
  pellets: 1,
  splash: 0,
  emp: false,
  melee: false,
  modes: ['semi'],
};

/**
 * Recoil defaults. `pitch`/`yaw` are radians of CAMERA climb per shot — in a
 * third-person game the recoil that the player feels is the camera and the
 * character's upper body, not a viewmodel, so these numbers are bigger than a
 * first-person rig's and the weapon's own kick is derived from them.
 */
const REC = {
  pitch: 0.009,
  yaw: 0.0022,
  roll: 0.02,
  punch: 0.3,
  /* metres the weapon travels rearward in the hand */
  kickBack: 0.02,
  kickUp: 0.008,
  freq: 9,
  damping: 0.45,
  patternLength: 24,
  patternSeed: 0x51a6d1,
  climbShape: [1.3, 1.15, 1.05, 1.0],
  drift: 0.7,
  /* how much of the kick is pushed into the CHARACTER's upper body */
  body: 1,
  /* screen trauma (camera shake) added on top of the deterministic climb */
  trauma: 0,
};

const def = (o) => ({ ...HANDLE, ...o, recoil: { ...REC, ...(o.recoil ?? {}) } });

export const WEAPONS = {
  /* ==================================================================== */
  /*  MELEE — no ammunition, a swing arc, and damage on the contact frame  */
  /* ==================================================================== */

  fists: def({
    id: 'fists', label: 'Fists', cls: 'melee', hold: 'fists',
    lib: { dmg: 14, rate: 0.34, range: 3.0, ammo: Infinity, melee: true },
    melee: true,
    /* Reach measured from the SHOULDER, which is what `range` means for a
     * punch: 3.0 m is a generous brawling radius, kept as-is so the mission
     * `brawl` beats play at the tuned distance. */
    reach: 3.0, arcDeg: 62, damage: 14, rate: 0.34,
    /* Alternating left/right hooks; the contact frame is 44% into the swing. */
    swing: { wind: 0.10, strike: 0.13, recover: 0.11, contact: 0.44, alternate: true },
    stagger: 0.35, knockback: 2.2,
    drawTime: 0.28, holsterTime: 0.2,
  }),

  pipe: def({
    id: 'pipe', label: 'Dock Pipe', cls: 'melee', hold: 'melee2',
    lib: { dmg: 28, rate: 0.42, range: 4.0, ammo: Infinity, melee: true },
    melee: true,
    reach: 4.0, arcDeg: 108, damage: 28, rate: 0.42,
    /* A metre of water pipe is heavy and slow: the longest wind-up in the set
     * and the widest arc, so it clears a group. */
    swing: { wind: 0.16, strike: 0.14, recover: 0.14, contact: 0.46, alternate: false },
    stagger: 0.85, knockback: 5.4,
    drawTime: 0.55, holsterTime: 0.4,
  }),

  wrench: def({
    id: 'wrench', label: 'Body Wrench', cls: 'melee', hold: 'melee1',
    lib: { dmg: 30, rate: 0.46, range: 3.8, ammo: Infinity, melee: true },
    melee: true,
    reach: 3.8, arcDeg: 88, damage: 30, rate: 0.46,
    /* Highest single-hit damage of the melee set — all the mass is in the head,
     * so it is an overhead chop rather than a sweep. */
    swing: { wind: 0.18, strike: 0.13, recover: 0.15, contact: 0.5, alternate: false, overhead: 0.7 },
    stagger: 0.9, knockback: 4.2,
    drawTime: 0.5, holsterTime: 0.36,
  }),

  crowbar: def({
    id: 'crowbar', label: 'Crowbar', cls: 'melee', hold: 'melee1',
    lib: { dmg: 26, rate: 0.38, range: 3.6, ammo: Infinity, melee: true },
    melee: true,
    reach: 3.6, arcDeg: 82, damage: 26, rate: 0.38,
    /* The fastest of the three tools — lighter, and Dylan is the quick brother. */
    swing: { wind: 0.12, strike: 0.12, recover: 0.12, contact: 0.45, alternate: true },
    stagger: 0.6, knockback: 3.4,
    drawTime: 0.44, holsterTime: 0.3,
  }),

  /* ==================================================================== */
  /*  LIGHT — high rate, low damage, short range                          */
  /* ==================================================================== */

  nailgun: def({
    id: 'nailgun', label: 'Nail Gun', cls: 'light', hold: 'oneHand',
    lib: { dmg: 20, rate: 0.22, range: 46, ammo: 90 },
    magSize: 30, reserve: 90, damage: 20, rate: 0.22,
    /* 3.3" framing nail, ~7 g, driven by 120 psi. 105 m/s is what a real
     * framing nailer does through air and it crosses 46 m in 0.44 s. */
    muzzleVelocity: 105, dragK: 0.75, dropoff: 0.45, penetration: 0.7,
    range: 46, projectile: 'nail', eject: 'none',
    spreadHip: 2.4, spreadAds: 0.55, spreadPerShot: 0.28, spreadMax: 4.2, spreadDecay: 4.0,
    recoil: { pitch: 0.0062, yaw: 0.0021, kickBack: 0.016, kickUp: 0.006, punch: 0.22, body: 0.7 },
    modes: ['auto', 'semi'],
    reloadTac: 1.9, reloadEmpty: 2.4, drawTime: 0.42, holsterTime: 0.3,
    /* The compressor has to catch up: an audible whine between strips. */
    dryClick: 'hiss',
  }),

  tackgun: def({
    id: 'tackgun', label: 'Tack Cannon', cls: 'light', hold: 'twoHand',
    lib: { dmg: 18, rate: 0.16, range: 42, ammo: 140 },
    magSize: 40, reserve: 140, damage: 18, rate: 0.16,
    /* Upholstery tacks out of a hopper: lighter than a nail, so slower, draggier
     * and it loses more of its damage over the distance. */
    muzzleVelocity: 88, dragK: 1.05, dropoff: 0.38, penetration: 0.45,
    range: 42, projectile: 'tack', eject: 'none',
    spreadHip: 3.0, spreadAds: 0.85, spreadPerShot: 0.22, spreadMax: 4.8, spreadDecay: 4.6,
    recoil: { pitch: 0.0044, yaw: 0.0026, kickBack: 0.012, kickUp: 0.0044, punch: 0.16, body: 0.55, drift: 1.1 },
    modes: ['auto'],
    reloadTac: 2.2, reloadEmpty: 2.8, drawTime: 0.48, holsterTime: 0.34,
  }),

  sprayer: def({
    id: 'sprayer', label: 'Paint Cannon', cls: 'light', hold: 'twoHand',
    lib: { dmg: 15, rate: 0.55, range: 22, ammo: 60, pellets: 7 },
    magSize: 8, reserve: 60, damage: 15, rate: 0.55,
    /* SEVEN pellets at 15 each — 105 damage if the whole pattern lands, which
     * only happens inside about 6 m. This is the game's shotgun and the shortest
     * ranged thing in it. Gobs of pressurised enamel: heavy, very draggy. */
    pellets: 7, muzzleVelocity: 42, dragK: 2.3, dropoff: 0.2, penetration: 0.1,
    range: 22, projectile: 'paint', eject: 'none',
    /* The cone is the weapon. 5.2 deg at the hip is a 2 m pattern at 11 m. */
    spreadHip: 5.2, spreadAds: 3.1, spreadPerShot: 0.5, spreadMax: 7.0, spreadDecay: 5.0,
    recoil: { pitch: 0.016, yaw: 0.004, kickBack: 0.038, kickUp: 0.014, punch: 0.55, body: 1.35, trauma: 0.1 },
    reloadTac: 2.6, reloadEmpty: 3.2, drawTime: 0.55, holsterTime: 0.4,
    /* Paint blinds: a hit smears the target's view and marks them for the FX. */
    marks: true,
    /* The pressure handle strokes once per shot — the rig animates it. */
    pump: true,
  }),

  smg: def({
    id: 'smg', label: 'Shop SMG', cls: 'light', hold: 'twoHand',
    lib: { dmg: 16, rate: 0.09, range: 55, ammo: 260 },
    magSize: 40, reserve: 260, damage: 16, rate: 0.09,
    /* 667 rpm out of an open bolt somebody welded in a body shop. 9x19 at a
     * genuine 370 m/s — the only round in the arsenal that behaves like a
     * bullet, and the only one that ejects brass. */
    muzzleVelocity: 370, dragK: 0.42, dropoff: 0.5, penetration: 0.55,
    range: 55, projectile: 'bullet', eject: 'brass',
    shell: { caseLen: 0.0192, rimR: 0.00478 },
    /* An open-bolt gun with no buffer walks off target fast. */
    spreadHip: 3.4, spreadAds: 0.7, spreadPerShot: 0.3, spreadMax: 5.4, spreadDecay: 4.8,
    recoil: { pitch: 0.0072, yaw: 0.0031, kickBack: 0.017, kickUp: 0.0062, punch: 0.26, body: 0.85, drift: 1.2 },
    modes: ['auto', 'semi'],
    reloadTac: 2.0, reloadEmpty: 2.7, drawTime: 0.5, holsterTime: 0.34,
  }),

  /* ==================================================================== */
  /*  PRECISE — one heavy projectile, long range, slow                    */
  /* ==================================================================== */

  flare: def({
    id: 'flare', label: 'Flare Gun', cls: 'precise', hold: 'oneHand',
    lib: { dmg: 46, rate: 0.70, range: 52, ammo: 40 },
    magSize: 1, reserve: 40, damage: 46, rate: 0.70,
    /* A 25 mm marine flare: slow, arcing, and BURNING the whole way. The tracer
     * is the point of this weapon — it is the only light source you carry. */
    muzzleVelocity: 62, dragK: 0.55, dropoff: 0.7, penetration: 0.15,
    range: 52, projectile: 'flare', eject: 'flare-hull',
    tracerEvery: 1, ignites: true, burnSeconds: 6.5,
    spreadHip: 2.2, spreadAds: 0.5, spreadPerShot: 0, spreadMax: 2.2, spreadDecay: 6,
    recoil: { pitch: 0.019, yaw: 0.004, kickBack: 0.03, kickUp: 0.014, punch: 0.5, body: 1.1, trauma: 0.06 },
    /* Break-open, single shot: the reload IS the cycle. */
    reloadTac: 1.45, reloadEmpty: 1.45, autoCycle: true,
    drawTime: 0.4, holsterTime: 0.3,
  }),

  speargun: def({
    id: 'speargun', label: 'Spear Gun', cls: 'precise', hold: 'twoHand',
    lib: { dmg: 62, rate: 0.85, range: 70, ammo: 30 },
    magSize: 1, reserve: 30, damage: 62, rate: 0.85,
    /* Rubber-powered: 58 m/s, and it pins what it hits to whatever is behind it.
     * Silent — no muzzle flash, no report, no `wanted:heat`. */
    muzzleVelocity: 58, dragK: 0.16, dropoff: 0.86, penetration: 1.2,
    range: 70, projectile: 'spear', eject: 'none',
    silent: true, pins: true, tracerEvery: 1,
    spreadHip: 1.4, spreadAds: 0.12, spreadPerShot: 0, spreadMax: 1.4, spreadDecay: 8,
    /* Bands, not powder: almost no recoil, just the shaft leaving the rail. */
    recoil: { pitch: 0.004, yaw: 0.001, kickBack: 0.012, kickUp: 0.004, punch: 0.14, body: 0.4 },
    /* Reloading is loading a shaft and pulling two bands back by hand. */
    reloadTac: 2.35, reloadEmpty: 2.35, autoCycle: true,
    drawTime: 0.6, holsterTime: 0.42,
  }),

  rivetgun: def({
    id: 'rivetgun', label: 'Rivet Gun', cls: 'precise', hold: 'twoHand',
    lib: { dmg: 40, rate: 0.20, range: 88, ammo: 120 },
    magSize: 24, reserve: 120, damage: 40, rate: 0.20,
    /* The flat-shooting weapon of the set. A structural rivet out of a
     * pneumatic hammer at 240 m/s drops 6 cm over 88 m, so it is the one you
     * can aim at a distant head — and it punches through sheet metal, which is
     * what makes it the anti-vehicle option before the explosives unlock. */
    muzzleVelocity: 240, dragK: 0.22, dropoff: 0.78, penetration: 1.35,
    range: 88, projectile: 'rivet', eject: 'none',
    spreadHip: 1.9, spreadAds: 0.16, spreadPerShot: 0.32, spreadMax: 3.0, spreadDecay: 5.0,
    recoil: { pitch: 0.0115, yaw: 0.0024, kickBack: 0.026, kickUp: 0.0095, punch: 0.38, body: 1.0 },
    modes: ['semi', 'auto'],
    reloadTac: 2.3, reloadEmpty: 2.9, drawTime: 0.55, holsterTime: 0.38,
  }),

  harpoon: def({
    id: 'harpoon', label: 'Harpoon', cls: 'precise', hold: 'shoulder',
    lib: { dmg: 90, rate: 1.1, range: 95, ammo: 22 },
    magSize: 1, reserve: 22, damage: 90, rate: 1.1,
    /* 90 damage is a one-hit kill on anything without armour, and the line
     * stays attached — a hit drags a light body toward you. Carson's weapon. */
    muzzleVelocity: 72, dragK: 0.12, dropoff: 0.92, penetration: 1.8,
    range: 95, projectile: 'harpoon', eject: 'none',
    pins: true, tethered: true, tracerEvery: 1,
    spreadHip: 1.6, spreadAds: 0.1, spreadPerShot: 0, spreadMax: 1.6, spreadDecay: 8,
    recoil: { pitch: 0.026, yaw: 0.005, kickBack: 0.055, kickUp: 0.02, punch: 0.8, body: 1.7, trauma: 0.14 },
    reloadTac: 2.9, reloadEmpty: 2.9, autoCycle: true,
    drawTime: 0.75, holsterTime: 0.5,
  }),

  /* ==================================================================== */
  /*  EXPLOSIVE — splash damage, arcing, and very little ammunition        */
  /* ==================================================================== */

  launcher: def({
    id: 'launcher', label: 'Nitro Launcher', cls: 'explosive', hold: 'shoulder',
    lib: { dmg: 180, rate: 1.5, range: 95, ammo: 8, splash: 9 },
    magSize: 1, reserve: 8, damage: 180, rate: 1.5, splash: 9,
    /* A nitrous bottle out of a welded tube. 38 m/s is a LOB: it drops 3 m over
     * 40 and you have to aim over cover, which is the whole skill of it. */
    muzzleVelocity: 38, dragK: 0.1, dropoff: 1, penetration: 0.2,
    range: 95, projectile: 'nitro', eject: 'none',
    explodes: true, fuse: 0, tracerEvery: 1, gravityScale: 1,
    spreadHip: 1.8, spreadAds: 0.35, spreadPerShot: 0, spreadMax: 1.8, spreadDecay: 8,
    recoil: { pitch: 0.03, yaw: 0.006, kickBack: 0.06, kickUp: 0.022, punch: 0.9, body: 1.8, trauma: 0.2 },
    reloadTac: 3.0, reloadEmpty: 3.0, autoCycle: true,
    drawTime: 0.8, holsterTime: 0.55,
  }),

  depth: def({
    id: 'depth', label: 'Depth Charge', cls: 'explosive', hold: 'twoHand',
    lib: { dmg: 190, rate: 1.6, range: 60, ammo: 8, splash: 11 },
    magSize: 1, reserve: 8, damage: 190, rate: 1.6, splash: 11,
    /* The biggest blast radius in the game and the shortest throw. A drum rolled
     * off a stern: it ARMS ON A FUSE, so it bounces once and then goes up, which
     * is how you get it around a corner. Detonates instantly underwater. */
    muzzleVelocity: 24, dragK: 0.06, dropoff: 1, penetration: 0,
    range: 60, projectile: 'drum', eject: 'none',
    explodes: true, fuse: 1.6, bounces: true, waterTrigger: true, tracerEvery: 0,
    spreadHip: 2.4, spreadAds: 1.0, spreadPerShot: 0, spreadMax: 2.4, spreadDecay: 8,
    recoil: { pitch: 0.012, yaw: 0.004, kickBack: 0.03, kickUp: 0.012, punch: 0.4, body: 1.0 },
    reloadTac: 3.2, reloadEmpty: 3.2, autoCycle: true,
    drawTime: 0.85, holsterTime: 0.6,
  }),

  rocket: def({
    id: 'rocket', label: 'Scrap Rocket', cls: 'explosive', hold: 'shoulder',
    lib: { dmg: 200, rate: 1.7, range: 110, ammo: 7, splash: 10 },
    magSize: 1, reserve: 7, damage: 200, rate: 1.7, splash: 10,
    /* The only projectile in the game with a MOTOR: it leaves at 40 m/s and
     * accelerates to 130 under thrust, so it starts as a lob and straightens
     * out. Highest single-hit damage and the longest reach. */
    muzzleVelocity: 40, thrust: 118, thrustTime: 0.85, topSpeed: 130,
    dragK: 0.05, dropoff: 1, penetration: 0.3,
    range: 110, projectile: 'rocket', eject: 'backblast',
    explodes: true, fuse: 0, tracerEvery: 1, gravityScale: 0.25,
    spreadHip: 2.0, spreadAds: 0.4, spreadPerShot: 0, spreadMax: 2.0, spreadDecay: 8,
    recoil: { pitch: 0.028, yaw: 0.006, kickBack: 0.05, kickUp: 0.02, punch: 0.85, body: 1.7, trauma: 0.22 },
    reloadTac: 3.4, reloadEmpty: 3.4, autoCycle: true,
    drawTime: 0.9, holsterTime: 0.6,
  }),

  emp: def({
    id: 'emp', label: 'EMP Coil', cls: 'explosive', hold: 'twoHand',
    lib: { dmg: 34, rate: 0.9, range: 34, ammo: 44, emp: true },
    magSize: 1, reserve: 44, damage: 34, rate: 0.9,
    /* THE SIGNATURE TOY. 34 damage is almost incidental — what it does is dump a
     * capacitor bank into whatever it touches and kill the electrics: engines
     * stall, headlights and lightbars die, and a pursuing cruiser coasts to a
     * stop. Short ranged (34 m) and slow, so you have to be close.
     *
     * `empRadius` is the discharge, not the damage splash: the slug does its 34
     * on contact like any other round, then arcs to every vehicle inside 9 m. */
    muzzleVelocity: 56, dragK: 0.4, dropoff: 0.6, penetration: 0.25,
    range: 34, projectile: 'coil', eject: 'none',
    emp: true, empRadius: 9, empSeconds: 9.5, tracerEvery: 1,
    spreadHip: 2.6, spreadAds: 0.6, spreadPerShot: 0, spreadMax: 2.6, spreadDecay: 8,
    recoil: { pitch: 0.015, yaw: 0.004, kickBack: 0.032, kickUp: 0.012, punch: 0.45, body: 1.1, trauma: 0.12 },
    /* Swapping a capacitor and letting the bank charge — the whine is the tell
     * that you are about to be able to fire again. */
    reloadTac: 1.9, reloadEmpty: 1.9, autoCycle: true,
    drawTime: 0.7, holsterTime: 0.48,
  }),
};

/** Ordered exactly as the weapon wheel groups them (see `ui/data.js` slots). */
export const WEAPON_ORDER = [
  'fists', 'pipe', 'wrench', 'crowbar',
  'nailgun', 'tackgun', 'sprayer', 'smg',
  'flare', 'speargun', 'rivetgun', 'harpoon',
  'launcher', 'depth', 'rocket', 'emp',
];

export const WEAPON_CLASSES = ['melee', 'light', 'precise', 'explosive'];

/** One representative per class, for `debugPose('melee')` etc. */
export const CLASS_EXEMPLAR = {
  melee: 'pipe',
  light: 'nailgun',
  precise: 'harpoon',
  explosive: 'emp',
};

/**
 * Who carries what. Byte-identical to `src/ui/data.js`'s per-brother wheel
 * slots and to `src/game/data.js`'s `weapons` lists — the three tables have to
 * agree or the wheel offers a weapon the engine cannot draw. DESIGN.md is the
 * source: every brother starts with fists plus his own melee tool and unlocks
 * four more across his eight chapters.
 */
export const BROTHER_LOADOUT = {
  carson: ['fists', 'pipe', 'flare', 'speargun', 'harpoon', 'depth'],
  aidan: ['fists', 'wrench', 'nailgun', 'sprayer', 'rivetgun', 'launcher'],
  dylan: ['fists', 'crowbar', 'tackgun', 'emp', 'smg', 'rocket'],
};

/**
 * THE WEAPON EACH BROTHER IS HOLDING WHEN YOU TAKE CONTROL OF HIM.
 *
 * This used to be `loadout[1]`, which is the brother's MELEE TOOL for all three
 * of them — so every frame of the game ever captured, and every frame the
 * playtester saw, had a length of dock pipe (or a wrench, or a crowbar) in
 * hand. That single index is the whole reason the report reads "all 3 boys have
 * the same weapons and you seem to have removed the other ones (e.g. nailgun)":
 * the nail gun was there the entire time, four key presses away, behind a HUD
 * that said DOCK PIPE.
 *
 * Each brother now comes up holding the firearm that states what he is:
 *
 *   carson  Flare Gun    one-handed, break-open, a burning 25 mm tracer he can
 *                        watch arc onto a boat deck. He is the heavy, slow,
 *                        single-shot brother — his whole set (flare, spear,
 *                        harpoon, depth) is one big hit at a time, and that is
 *                        the tank's identity, not an omission.
 *   aidan   Nail Gun     the body-shop tool, semi OR 273 rpm auto, one-handed
 *                        so he keeps his mobility. The all-rounder's gun.
 *   dylan   Shop SMG     667 rpm out of an open bolt. The true automatic, on
 *                        the fastest and most fragile brother, which is the
 *                        trade: he can close and spray but he cannot take the
 *                        return fire.
 */
export const BROTHER_SIGNATURE = {
  carson: 'flare',
  aidan: 'nailgun',
  dylan: 'smg',
};

/**
 * HOW EACH BROTHER HANDLES A WEAPON.
 *
 * DESIGN.md gives the three of them different hp / armour / run speed, and the
 * `BOYZ.<id>.stats` block gives them different `aim`, `tough` and `speed`.
 * None of that used to reach a trigger: all three shot every weapon with
 * byte-identical spread, recoil, draw and reload, so the choice of brother
 * changed the health bar and nothing about combat.
 *
 * These are multipliers applied on top of the weapon's own numbers, derived
 * from those stats rather than invented:
 *
 *            aim   tough  speed        spread  recoil  settle  handling reload
 *   carson   0.74   0.92   0.62         0.95    0.80    0.90    1.18     1.12
 *   aidan    0.80   0.78   0.74         0.85    0.94    1.18    1.00     0.84
 *   dylan    0.66   0.60   0.94         1.20    1.24    1.00    0.80     1.00
 *
 *   spread    multiplies the resting cone AND the per-shot bloom (`aim`)
 *   recoil    multiplies the camera climb the shot puts into the player. A
 *             130 kg river hand eats a harpoon's kick; Dylan gets thrown by it
 *             (`tough`)
 *   settle    multiplies `spreadDecay` — how fast the cone closes again
 *   handling  multiplies drawTime / holsterTime / adsTime / swap time. Dylan
 *             gets a weapon up 20% faster than Carson, which is what `speed`
 *             means when you are not running (`speed`)
 *   reload    multiplies reloadTac / reloadEmpty. Aidan straightens panels for
 *             a living — he is the fastest pair of hands in the family
 *
 * The result, played back to back: Carson can hold a Harpoon on a target
 * through the recoil and is slow to bring anything up; Aidan is the one who
 * hits what he aims at and is back in the fight first after an empty mag;
 * Dylan whips a weapon out fastest and sprays widest, which suits a 667 rpm
 * open-bolt SMG and punishes him on anything precise.
 */
export const BROTHER_HANDLING = {
  carson: { spread: 0.95, recoil: 0.80, settle: 0.90, handling: 1.18, reload: 1.12 },
  aidan: { spread: 0.85, recoil: 0.94, settle: 1.18, handling: 1.00, reload: 0.84 },
  dylan: { spread: 1.20, recoil: 1.24, settle: 1.00, handling: 0.80, reload: 1.00 },
};

/** Applied when the active character is unknown (menus, the preview page). */
export const NEUTRAL_HANDLING = { spread: 1, recoil: 1, settle: 1, handling: 1, reload: 1 };

/**
 * WHAT EACH BROTHER OWNS BEFORE HE HAS EARNED ANYTHING.
 *
 * DESIGN.md, "starts with": fists plus his own melee tool. The other four in
 * `BROTHER_LOADOUT` are the eight chapters' rewards and are NOT his until the
 * save says so — see `WeaponSystem._resolveUnlocks`, which asks
 * `game.economy` rather than deciding for itself. Byte-identical to the
 * `start` arrays in `src/game/data.js`.
 */
export const BROTHER_START = {
  carson: ['fists', 'pipe'],
  aidan: ['fists', 'wrench'],
  dylan: ['fists', 'crowbar'],
};

/**
 * How the flash and the report are chosen.
 *
 * `fx/muzzle.js` looks its profile up by SUBSTRING against its own eight names
 * and `audio/weapons.js` does the same, so handing either of them the def's
 * `cls` ('light', 'precise', 'explosive') matches nothing and everything in the
 * arsenal silently gets an assault-rifle flash and an assault-rifle crack.
 * These two columns are the translation, authored per weapon rather than
 * derived, because a nail gun and a paint cannon are both `light` and they
 * sound and flash nothing like each other.
 *
 *   fx      one of fx/muzzle.js MUZZLE_PROFILES
 *   audio   one of audio/weapons.js WEAPON_PROFILES
 *   flash   multiplier on the flash size, 0 for a weapon with no combustion
 */
const SIGNATURE = {
  fists: { fx: 'suppressed', audio: 'suppressed', flash: 0 },
  pipe: { fx: 'suppressed', audio: 'suppressed', flash: 0 },
  wrench: { fx: 'suppressed', audio: 'suppressed', flash: 0 },
  crowbar: { fx: 'suppressed', audio: 'suppressed', flash: 0 },
  /* 120 psi of air, not powder: a hard mechanical bark and a puff, no fireball. */
  nailgun: { fx: 'pistol', audio: 'pistol', flash: 0.35 },
  tackgun: { fx: 'smg', audio: 'smg', flash: 0.3 },
  /* Pressurised enamel out of a wide bore — the shotgun signature, minus heat. */
  sprayer: { fx: 'shotgun', audio: 'shotgun', flash: 0.55 },
  smg: { fx: 'smg', audio: 'smg', flash: 1.0 },
  /* A 25 mm marine flare: a big, slow, ORANGE bloom rather than a crack. */
  flare: { fx: 'shotgun', audio: 'pistol', flash: 1.5 },
  /* Rubber bands. No flash, no report, no `wanted:heat`. */
  speargun: { fx: 'suppressed', audio: 'suppressed', flash: 0 },
  rivetgun: { fx: 'rifle', audio: 'rifle', flash: 0.7 },
  harpoon: { fx: 'sniper', audio: 'sniper', flash: 0.9 },
  launcher: { fx: 'sniper', audio: 'sniper', flash: 1.9 },
  /* Rolled off a stern, not fired: almost nothing at the muzzle. */
  depth: { fx: 'suppressed', audio: 'shotgun', flash: 0.2 },
  rocket: { fx: 'sniper', audio: 'sniper', flash: 2.1 },
  /* A spark gap dumping a capacitor bank — bright, short, and blue. */
  emp: { fx: 'shotgun', audio: 'shotgun', flash: 1.1 },
};

/**
 * Finalise a def: derive the numbers the engine actually reads from the
 * authored ones, so `rate` and `dmg` stay the single source of truth and
 * nothing can drift out of sync with `game`'s economy table.
 */
export function finalizeWeapon(id) {
  const d = { ...WEAPONS[id] };
  d.id = id;
  /* rate (seconds/shot) IS the fire cycle. rpm exists only for the burst
   * machinery and the audio system's loop rate. */
  d.cycleTime = d.rate ?? d.lib.rate;
  d.rpm = 60 / d.cycleTime;
  d.damage = d.damage ?? d.lib.dmg;
  d.range = d.range ?? d.lib.range;
  d.maxRange = d.melee ? d.reach : d.range * 1.6;
  d.reserve = d.reserve ?? (Number.isFinite(d.lib.ammo) ? d.lib.ammo : 0);
  d.magSize = d.magSize ?? 0;
  d.splash = d.splash ?? d.lib.splash ?? 0;
  d.pellets = d.pellets ?? d.lib.pellets ?? 1;
  d.infinite = !Number.isFinite(d.lib.ammo);
  d.class = d.cls;
  const sig = SIGNATURE[id] ?? SIGNATURE.smg;
  d.fxClass = sig.fx;
  d.audioProfile = sig.audio;
  d.flashScale = sig.flash;
  d.modes = d.modes ?? ['semi'];
  d.spreadHip = d.spreadHip ?? 2;
  d.spreadAds = d.spreadAds ?? 0.4;
  d.spreadPerShot = d.spreadPerShot ?? 0.2;
  d.spreadMax = d.spreadMax ?? 4;
  d.spreadDecay = d.spreadDecay ?? 4;
  d.viewFov = d.adsFov;
  return d;
}

export const ALL_WEAPONS = (() => {
  const out = {};
  for (const id of WEAPON_ORDER) out[id] = finalizeWeapon(id);
  return out;
})();

/**
 * Deterministic per-shot recoil pattern — the part of the kick a player can
 * learn and counter. Identical machinery to the inherited `defs.js`, kept
 * because it is genuinely the right model; only the inputs changed.
 */
export function buildRecoilPattern(d, Rng) {
  const r = d.recoil;
  const n = Math.max(1, r.patternLength);
  const rng = new Rng((r.patternSeed ^ hashId(d.id)) >>> 0);
  const out = new Float32Array(n * 2);
  const phase = rng.float() * Math.PI * 2;
  const phase2 = rng.float() * Math.PI * 2;
  const bias = rng.signed() * 0.35;
  for (let i = 0; i < n; i++) {
    const climb = r.climbShape[Math.min(i, r.climbShape.length - 1)];
    const sig = 0.88 + rng.float() * 0.24;
    out[i * 2] = r.pitch * climb * sig;
    const t = i / Math.max(1, n - 1);
    const snake =
      Math.sin(phase + t * Math.PI * 2.6) * 0.75 + Math.sin(phase2 + t * Math.PI * 5.1) * 0.35;
    out[i * 2 + 1] = r.yaw * (snake * r.drift * 3.2 + bias + rng.signed() * 0.25);
  }
  return out;
}

function hashId(s) {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** Stance / movement multipliers on the resting spread cone. */
export const SPREAD_MODS = {
  crouch: 0.76,
  prone: 0.6,
  still: 0.84,
  walking: 1.18,
  sprinting: 2.3,
  airborne: 2.1,
  aim: 1,
};

export const DEG2RAD = DEG;
