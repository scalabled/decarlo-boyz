import * as THREE from 'three';

/**
 * Named camera setups the screenshot harness can request. Each shot freezes
 * input, poses the camera, and optionally forces gameplay state so critics
 * always review the same framing across iterations.
 *
 * A shot is `{ pos:[x,y,z], look:[x,y,z], fov?, time?, apply?(engine) }`.
 * `time` is hour-of-day 0..24 handed to the sky system.
 */
/**
 * Stage the police helicopter and frame its searchlight, standing `stand`
 * metres off the beam's ground spot and aiming `aimUp` of the way up the shaft.
 *
 * FRAMED RELATIVE TO THE BEAM, never from authored world coordinates. The first
 * cut of these shots used fixed `pos`/`look` pairs and produced two identical
 * frames containing no helicopter and no beam at all — a shot called
 * `searchlight` that photographed an ordinary night street. The second cut put
 * the lens hard against a brick wall filling 40% of the frame, which is the same
 * mistake that once had a critic panel reviewing a stucco slab instead of the
 * city. Standing off the beam's own ground spot cannot do either, wherever the
 * staged aircraft happens to end up.
 *
 * Deterministic: `debugStage('air')` places the aircraft as a pure function of
 * the camera pose that preceded it, and every offset here derives from that.
 */
function frameBeam(e, { stand, aimUp }) {
  const police = e.ctx.peek('police');
  if (!police?.debugStage) return;
  police.debugStage('air');
  const h = police.heli;
  const cam = e.ctx.camera;
  if (!h?.position) return;

  // Move the aim off the camera so the shaft is not pointed straight down the
  // lens. The beam re-reads the wanted meter's last-known position every frame,
  // so the aim has to move THERE — setting `heli._target` alone is overwritten
  // on the next update.
  const ax = h.position.x + 30;
  const az = h.position.z + 24;
  const ay = police.groundAt?.(ax, az, h.position.y) ?? 0;
  police.meter?.known?.set?.(ax, ay, az);
  h._target?.set?.(ax, ay, az);

  // Perpendicular to the beam's ground projection = a true side-on view.
  const bx = h.position.x - ax, bz = h.position.z - az;
  const bl = Math.hypot(bx, bz) || 1;
  const cx = ax + (-bz / bl) * stand;
  const cz = az + (bx / bl) * stand;
  const cy = (police.groundAt?.(cx, cz, h.position.y) ?? 0) + 6;
  cam.position.set(cx, cy, cz);
  cam.lookAt(ax, ay + (h.position.y - ay) * aimUp, az);
  e.ctx.peek('player')?.teleport?.(cam.position, cam.rotation);
  holdCamera(e, cam.position, { x: ax, y: ay + (h.position.y - ay) * aimUp, z: az });
}

/**
 * Frame the PLAYER, from wherever the player actually is.
 *
 * `character` used to be `pos:[2.4,1.6,3.0] look:[0,1.15,0]` — absolute
 * coordinates pointed at the world origin. The player is not at the world
 * origin, so the shot named "over-the-shoulder on a DeCarlo brother" was a
 * photograph of a blank concrete wall, and it stayed that way through an entire
 * adversarial review: four separate critics spent their pass judging it, one
 * noting only that a frame labelled `character` contained a wall.
 *
 * A shot that names its subject must derive its camera FROM that subject. This
 * is the third time absolute coordinates have produced a shot of the wrong
 * thing in this file (see also `frameBeam`), so it now has a helper.
 *
 * @param {number} dist   metres back from the actor
 * @param {number} height eye height of the camera
 * @param {number} side   metres to the actor's right (over-the-shoulder offset)
 * @param {number} aimY   height on the actor to aim at
 */
/*
 * Suppress the harness's OWN side effects before the shutter.
 *
 * An adversarial pass over 24 shots reported both of these, and was right about
 * both:
 *
 *   1. An "ENTERING GOLDEN TRIANGLE" banner was burned into 24 of 24 frames,
 *      while the minimap underneath read Lawrenceville, Steel Row, Mt.
 *      Washington, South Side, Hazelwood, The Point and North Shore. Every shot
 *      teleports the player, every teleport fires the zone toast, and the toast
 *      then sits there for its whole dwell — so every frame in the set carried a
 *      caption contradicting its own minimap.
 *   2. The first-person weapon viewmodel was composited into aerial and drone
 *      frames, which have no first-person subject at all.
 *
 * Neither is a renderer defect. Both are the capture rig photographing itself,
 * and together they polluted an entire four-lens review.
 *
 * MUST be called on BOTH apply paths. The `onRoad` branch returns early, and
 * something installed only after it silently misses `street`, `hero`, `night`,
 * `detail`, `rain` and `character` — a mistake already made once in this file
 * with `clearTraffic`.
 */
/**
 * Remember the camera a shot asked for, and put it back at the shutter.
 *
 * Setting `cam.position` inside `apply` is not enough. Several of these helpers
 * teleport the player so gameplay systems stay coherent, and the PLAYER RIG then
 * re-derives the camera from the player on the frames that follow — so the pose
 * you authored is quietly overridden before the shutter. MEASURED on the vehicle
 * beauty shot: `dist: 9.0` authored, 6.0 m at the shutter, with the framing
 * flipping from a rear three-quarter to a front one on small changes in where
 * the subject ended up.
 *
 * So record it and re-assert it in `shotChrome`, which runs at the shutter via
 * `__PRESHUTTER__`. Same lesson as freezing the sim and re-pinning the sky
 * clock: the last write before the photograph is the one that counts.
 */
function holdCamera(e, pos, target) {
  e.__shotCam = { px: pos.x, py: pos.y, pz: pos.z, tx: target.x, ty: target.y, tz: target.z };
}

function shotChrome(engine, shot) {
  engine.ctx.peek('ui')?.hideZoneToast?.();
  for (const n of document.querySelectorAll('.ow-zone, [class*="zone"]')) {
    n.style.display = 'none';
  }
  // On by default — first-person shots need it — off where the shot declares it
  // has no first-person subject.
  engine.viewScene.visible = shot.viewmodel !== false;

  /*
   * The THIRD-PERSON weapon is not parented to the character.
   *
   * `player._shotHide` hides the actor with `character.setOpacity(0)`, which
   * sets `character.root.visible = false`. But the held weapon lives under a
   * separate scene node, `weapons-thirdperson`, hung directly off the Scene —
   * so hiding the character leaves the weapon floating unsupported exactly
   * where his hands were. MEASURED in the `incline` shot: `shotHide true`,
   * `charRootVisible false`, and a fully lit pipe still in frame.
   *
   * This is not only a harness problem. The same fade runs in gameplay whenever
   * the camera is forced inside the player (tight alleys, a wall behind him),
   * so the weapon stays solid while its owner dissolves. Flagged to `weapons`;
   * hidden here so review frames are not judged on it in the meantime.
   */
  const tp = engine.scene.getObjectByName('weapons-thirdperson');
  if (tp) tp.visible = !(engine.ctx.peek('player')?._shotHide);

  // `hud: false` — marketing frames only. A screenshot in a README is a
  // photograph of a world, not of an interface. Review shots keep the HUD,
  // because a critic should be judging it too.
  engine.ctx.peek('ui')?.setHudVisible?.(shot.hud !== false);

  // Re-assert a held camera pose. See `holdCamera`.
  const c = engine.__shotCam;
  if (c) {
    engine.camera.position.set(c.px, c.py, c.pz);
    engine.camera.lookAt(c.tx, c.ty, c.tz);
  }
}

/**
 * Frame a STAGED VEHICLE, from the car itself.
 *
 * `vehicles.debugPose('beauty')` already does the hard part: it finds an empty
 * spot, nudges along the camera's forward ray until the subject has room, and
 * hides the traffic. What it cannot do is choose where you stand — and an
 * authored pos/look put a lamp post dead centre with the car behind it, which is
 * the FOURTH time absolute coordinates have photographed the wrong thing in this
 * file. So derive the camera from the car, like `frameBeam` and `frameActor`.
 *
 * Three-quarter front, low: the angle every press shot uses, because it shows a
 * flank and a face at once. A vehicle's nose is +Z (dynamics.js takes
 * forwardSpeed along +Z) — not -Z, which is a camera's basis.
 */
function frameVehicle(e, kind, { dist = 8.2, height = 1.25, swing = 0.62, aimY = 0.85 } = {}) {
  const veh = e.ctx.peek('vehicles');
  if (!veh?.debugPose) return;
  veh.debugPose('beauty', kind ? { type: kind } : {});
  const v = veh._debugSpawned?.[0] ?? null;
  const cam = e.ctx.camera;
  if (!v?.position) return;
  const q = v.quaternion;
  // The car's own nose and right, from its quaternion.
  const nx = 2 * (q.x * q.z + q.w * q.y), nz = 1 - 2 * (q.x * q.x + q.y * q.y);
  const rx = 1 - 2 * (q.y * q.y + q.z * q.z), rz = 2 * (q.x * q.y - q.w * q.z);
  // Ahead of the nose and off to one side: a three-quarter view.
  const ox = nx * Math.cos(swing) + rx * Math.sin(swing);
  const oz = nz * Math.cos(swing) + rz * Math.sin(swing);
  cam.position.set(v.position.x + ox * dist, v.position.y + height, v.position.z + oz * dist);
  e.ctx.peek('player')?.teleport?.(cam.position, cam.rotation);
  // Teleport FIRST, then aim — and record it, because the player rig re-derives
  // the camera from the player after a teleport. Authoring dist 9.0 and
  // MEASURING 6.0 m at the shutter is what that override looks like.
  cam.position.set(v.position.x + ox * dist, v.position.y + height, v.position.z + oz * dist);
  cam.lookAt(v.position.x, v.position.y + aimY, v.position.z);
  holdCamera(e, cam.position, { x: v.position.x, y: v.position.y + aimY, z: v.position.z });
}

function frameActor(e, { dist = 3.0, height = 1.62, side = 0.55, aimY = 1.45 } = {}) {
  const pl = e.ctx.peek('player');
  const cam = e.ctx.camera;
  const p = pl?.position;
  if (!p) return false;
  // The actor's facing is -Z (animator.js builds forward as -sin/-cos of yaw);
  // a vehicle's nose is +Z. They are not interchangeable — see ARCHITECTURE.
  const yaw = pl.yaw ?? 0;
  const fx = -Math.sin(yaw), fz = -Math.cos(yaw);
  const rx = Math.cos(yaw), rz = -Math.sin(yaw);
  cam.position.set(p.x - fx * dist + rx * side, p.y + height, p.z - fz * dist + rz * side);
  cam.lookAt(p.x + rx * side * 0.35, p.y + aimY, p.z + rz * side * 0.35);
  return true;
}

export const SHOTS = {
  // ---- environment / lighting ----
  hero: {
    pos: [12, 1.75, 18],
    look: [-4, 2.2, -6],
    fov: 75,
    time: 16.5,
    doc: 'Wide establishing shot down the main street — reads overall art direction.',
  },
  interior: {
    pos: [-8.5, 1.7, 3.2],
    look: [2, 1.6, -2],
    fov: 70,
    time: 16.5,
    doc: 'Interior with light shafts through windows — bounce, AO, volumetrics.',
  },
  detail: {
    pos: [3.2, 1.35, 5.0],
    look: [1.4, 1.1, 2.2],
    fov: 45,
    time: 16.5,
    doc: 'Close-up on wall/prop materials — texel density, normal maps, grime.',
  },
  sunset: {
    pos: [16, 3.2, 22],
    look: [-10, 3.0, -14],
    fov: 65,
    time: 19.2,
    doc: 'Low sun — atmospheric scattering, long shadows, god rays, bloom.',
  },
  night: {
    pos: [12, 1.75, 18],
    look: [-4, 2.2, -6],
    fov: 75,
    time: 1.5,
    doc: 'Night — artificial lights, exposure adaptation, shadow quality in the dark.',
  },

  // ---- weapon / viewmodel ----
  weapon: {
    pos: [6, 1.7, 10],
    look: [-2, 1.8, -2],
    fov: 80,
    time: 16.5,
    apply: (e) => e.ctx.peek('weapons')?.debugPose?.('idle'),
    doc: 'Hip-fire viewmodel — weapon silhouette, materials, hand rig.',
  },
  ads: {
    pos: [6, 1.7, 10],
    look: [-2, 1.8, -2],
    fov: 58,
    time: 16.5,
    apply: (e) => e.ctx.peek('weapons')?.debugPose?.('ads'),
    doc: 'Aiming down sights — optic alignment, depth of field, reticle.',
  },
  muzzle: {
    pos: [6, 1.7, 10],
    look: [-2, 1.8, -2],
    fov: 80,
    time: 16.5,
    apply: (e, o) => e.ctx.peek('weapons')?.debugPose?.('fire', o),
    doc: 'Mid-recoil with muzzle flash — flash shape, light spill, shell eject.',
  },

  // ---- combat / fx ----
  combat: {
    pos: [4, 1.7, 12],
    look: [-6, 1.7, -4],
    fov: 80,
    time: 16.5,
    apply: (e) => e.ctx.peek('peds')?.debugStage?.('firefight'),
    doc: 'Enemies mid-firefight — character quality, animation, impact FX.',
  },
  impacts: {
    pos: [2.5, 1.6, 6],
    // Squared up on the plaster wall 5.25 m away. The old aim looked down the
    // open market, so the burst was staged 20+ m out among the stalls and the
    // decals were never legible — the whole point of this shot.
    look: [-1.8, 1.5, 9.0],
    fov: 60,
    time: 16.5,
    apply: (e) => e.ctx.peek('fx')?.debugBurst?.('wall'),
    doc: 'Bullet impacts on a wall — decals, debris, dust puffs, sparks.',
  },
  hud: {
    pos: [12, 1.75, 18],
    look: [-4, 2.2, -6],
    fov: 80,
    time: 16.5,
    apply: (e) => e.ctx.peek('ui')?.debugState?.('combat'),
    doc: 'Full HUD in combat — layout, typography, readability, hit feedback.',
  },
};

/**
 * ---------------------------------------------------------------------------
 * STEEL CITY shot set.
 *
 * The inherited shots above framed a 120 m Call of Duty market street. These
 * frame the open city described in DESIGN.md. World coordinates are the legacy
 * map's coordinates x4 (DESIGN.md "Scale"), so e.g. the Golden Triangle centre
 * (-58, 16) becomes (-232, 64).
 *
 * `ground: true` makes `pos.y` and `look.y` RELATIVE to the terrain height at
 * that x/z, which keeps a shot framed correctly while `world` is still moving
 * its heightfield around underneath us.
 * ---------------------------------------------------------------------------
 */
const STEEL_CITY_SHOTS = {
  // ---- the establishing set ----
  hero: {
    pos: [-232, 6, 150], look: [-232, 24, -40], fov: 62, time: 17.4, ground: true,
    onRoad: { near: [-232, 64], eye: 5.5, aheadM: 55 },
    clearTraffic: 34,
    doc: 'Street level looking down a Golden Triangle avenue — the overall art direction read.',
  },
  skyline: {
    pos: [-528, 60, 464], look: [-232, 40, 40], fov: 50, time: 19.2, ground: true,
    viewmodel: false,
    doc: 'THE signature composition: from the Mt. Washington clifftop across the Mon to downtown, ~500 m out and ~120 m up. Tests skyline silhouette, cliff terrain, river.',
  },
  farview: {
    pos: [984, 90, -56], look: [-232, 40, 40], fov: 42, time: 18.6, ground: true,
    viewmodel: false,
    doc: 'Hazelwood to downtown — the genuinely LONG sightline at 1.2 km. This is the shot that tests LOD, impostors and aerial perspective, not `skyline`.',
  },
  point: {
    pos: [-672, 260, 360], look: [-620, 0, -40], fov: 58, time: 16.0,
    weather: 'scattered',
    viewmodel: false,
    doc: 'Aerial over The Point — all three rivers, the bridges, the city layout in one frame.',
  },
  bridge: {
    pos: [-64, 12, -328], look: [-300, 20, -120], fov: 60, time: 18.4, ground: true,
    weather: 'scattered',
    viewmodel: false,
    doc: 'On a bridge deck over the Allegheny — trusses, deck surface, the river below.',
  },
  street: {
    pos: [680, 4, -520], look: [640, 8, -600], fov: 55, time: 15.0, ground: true,
    onRoad: { near: [680, -552], eye: 2.2, ahead: 0.35 },
    clearTraffic: 34,
    weather: 'overcast',
    doc: 'Lawrenceville brick rowhouses at eye level — shopfronts, ground-floor density, no visible repetition.',
  },
  mill: {
    pos: [820, 20, 320], look: [872, 40, 248], fov: 58, time: 18.8, ground: true,
    weather: 'overcast',
    viewmodel: false,
    doc: 'Steel Row and the Old Blast Furnace — rusted mill steel, gantries, industrial silhouette.',
  },
  incline: {
    // The incline was rebuilt: it now discovers its uphill bearing by probing
    // terrain instead of extrapolating a hardcoded rise in -z, and runs from
    // about (-488, 296) up a bearing of (-0.609, +0.793) for 180 m, climbing
    // 97.8 m. The old camera here was authored against the BROKEN version that
    // ran the wrong way up the wrong hill, so it framed empty sky. Stand off to
    // the side of the new track so the climb reads as a slope.
    pos: [-430, 42, 452], look: [-556, 58, 372], fov: 55, time: 17.8, ground: true,
    weather: 'overcast',
    viewmodel: false,
    doc: 'The Duquesne Incline climbing Mt. Washington seen side-on — terrain slope, the funicular track and cars, the cliff, hillside housing. The track must sit ON the hill along its whole length.',
  },
  waterfront: {
    pos: [120, 8, 560], look: [-200, 30, 200], fov: 60, time: 7.4, ground: true,
    weather: 'scattered',
    viewmodel: false,
    doc: 'South Side riverfront at morning — water shading, river fog, industrial bank.',
  },

  // ---- lighting / weather sweeps ----
  sunset: {
    // Pulled back onto the Mt. Washington ridge and raised. The old position sat
    // hard against a downtown tower once `buildings` populated the Triangle, and
    // a critic reviewing "the money shot" got half a frame of dark curtain wall.
    pos: [-600, 150, 420], look: [-1000, 20, -60], fov: 58, time: 19.6, ground: true,
    viewmodel: false,
    doc: 'Golden hour down the Ohio from the ridge — scattering, long shadows, god rays, bloom. The money shot.',
  },
  night: {
    pos: [-232, 5, 150], look: [-232, 22, -40], fov: 62, time: 1.5, ground: true,
    onRoad: { near: [-232, 64], eye: 5.0, ahead: 0.3 },
    clearTraffic: 34,
    doc: 'Downtown at night — sodium pools on wet asphalt, lit windows, exposure adaptation, bloom.',
  },
  dawnfog: {
    pos: [-620, 24, 120], look: [-300, 30, -60], fov: 60, time: 6.2, ground: true,
    viewmodel: false,
    doc: 'River fog at dawn pooling in the valley — volumetrics, blue hour, fog that sits in the low ground.',
  },
  rain: {
    pos: [-232, 5, 150], look: [-232, 22, -40], fov: 62, time: 14.0, ground: true,
    onRoad: { near: [-232, 64], eye: 5.0, ahead: 0.3 },
    clearTraffic: 34,
    weather: 'storm',
    viewmodel: false,
    doc: 'Storm downtown — rain streaks, wet road reflections, puddles, spray. Core to this game s look.',
  },

  /*
   * ---- police searchlight ----
   *
   * WHY THESE EXIST, which is the important part.
   *
   * A player sent a night screenshot in which the helicopter searchlight had
   * washed 15-24% of the frame to a flat cream and dragged the auto-exposure
   * meter down 0.8 EV (2.28 metered under the beam vs 4.09 without), so
   * everything outside the cone went black. The frame read as a diagonal split
   * into blown-out cream and pure black — and it was ONE defect, not the two it
   * looked like.
   *
   * No shot in this set framed the searchlight. So no capture review could ever
   * have caught it: the harness had a hole, and the defect shipped through it to
   * a real player. Every shot here earns its place by covering something a
   * reviewer would otherwise never be shown.
   *
   * Reproduced at 21:21 overcast, wanted 5, because that is the frame that was
   * reported. Two framings, because neither alone is sufficient: from inside the
   * beam you see the wash but cannot judge the penumbra; from outside you can
   * judge penumbra, falloff and ground pool but never see the wash.
   */
  /*
   * NOTE ON FRAMING, learned the hard way. The first cut of these two shots used
   * `onRoad` and authored `look` targets, and produced two IDENTICAL frames with
   * no helicopter and no beam anywhere in them — a shot named `searchlight` that
   * photographed an ordinary night street. Two reasons, both worth stating:
   *
   *   1. `onRoad` REPLACES the authored aim with the lane's own direction, so
   *      the `look` target is ignored and the staged helicopter (placed from the
   *      camera's forward vector) landed at the extreme top edge of frame.
   *   2. `air` aims the beam at the camera, and the fixed beam deliberately
   *      collapses when the camera is inside the cone — that IS the fix for the
   *      wash. So the one framing that reproduces the original defect is also
   *      the framing that shows the least once it is fixed.
   *
   * Both shots therefore stage the helicopter FIRST and then aim the camera at
   * the beam, inside `apply`. Deterministic, because the staged helicopter
   * position is a pure function of the camera pose that preceded it.
   */
  searchlight: {
    pos: [-232, 6, 96], look: [-232, 20, 10], fov: 62, time: 21.35, ground: true,
    clearTraffic: 34,
    weather: 'overcast',
    apply: (e) => frameBeam(e, { stand: 17, aimUp: 0.72 }),
    doc: 'Helicopter searchlight bearing down on the player at 21:21 overcast — the frame a player reported as washed out. Judge: the shaft must have a soft penumbra rather than a hard polygon edge and must fall off along its length; surfaces under it must keep albedo, mortar and window reveals rather than flattening to one cream value; and the REST of the frame must not be crushed to black, which is what the old beam caused by dragging the exposure meter down 0.8 EV.',
  },
  searchlight_side: {
    pos: [-190, 7, 120], look: [-250, 12, 40], fov: 60, time: 21.35, ground: true,
    clearTraffic: 34,
    weather: 'overcast',
    apply: (e) => frameBeam(e, { stand: 72, aimUp: 0.5 }),
    doc: 'The same searchlight seen from OUTSIDE the cone, so the shaft reads edge-on. This is the framing that shows penumbra softness, falloff along the beam, and whether the ground pool has a lit falloff or is a flat disc. The inside view cannot show any of those.',
  },

  // ---- vehicles / driving ----
  car: {
    // Was pos:[6.2,1.35,5.4] look:[0,0.75,0] — a few metres from WORLD ORIGIN.
    // `vehicles.debugPose` stages the car relative to the camera, so all three
    // vehicle shots were staging their subject at the origin, which here is over
    // the river. Same absolute-coordinate mistake as `character` and the first
    // cut of the searchlight shots. Put the camera on a real street first.
    pos: [-232, 6, 96], look: [-232, 5, 60], fov: 45, time: 17.0, ground: true,
    onRoad: { near: [-232, 64], eye: 1.5, aheadM: 9, side: 5.6 },
    clearTraffic: 30,
    weather: 'overcast',
    viewmodel: false,
    apply: (e) => e.ctx.peek('vehicles')?.debugPose?.('beauty'),
    doc: 'Vehicle beauty 3/4 on a real street — car paint flake and clearcoat, shutlines, glass, wheels, interior behind the glass.',
  },
  driving: {
    pos: [-232, 6, 150], look: [-232, 6, -40], fov: 70, time: 17.2, ground: true,
    onRoad: { near: [-232, 64], eye: 2.2, aheadM: 40 },
    clearTraffic: 26,
    weather: 'overcast',
    viewmodel: false,
    apply: (e) => e.ctx.peek('vehicles')?.debugPose?.('chase'),
    doc: 'Chase camera behind the player car on a downtown avenue — the camera model, body roll, motion blur.',
  },
  cockpit: {
    pos: [-232, 6, 150], look: [-232, 6, -40], fov: 65, time: 17.2, ground: true,
    onRoad: { near: [-232, 64], eye: 1.6, aheadM: 30 },
    clearTraffic: 26,
    weather: 'overcast',
    apply: (e) => e.ctx.peek('vehicles')?.debugPose?.('cockpit'),
    doc: 'From the driver seat on a real street — interior modelling, dash, wheel, hands, glass from inside.',
  },

  // ---- characters / gameplay ----
  character: {
    // Placed on a real street so the brother has a city behind him rather than
    // a blank wall; the camera is then derived from the player in `apply`.
    pos: [-232, 5, 96], look: [-232, 5, 60], fov: 45, time: 16.5, ground: true,
    onRoad: { near: [-232, 64], eye: 1.7, aheadM: 8, side: 4.2 },
    clearTraffic: 20,
    weather: 'overcast',
    viewmodel: false,
    apply: (e) => { frameActor(e, { dist: 2.9, height: 1.66, side: 0.6, aimY: 1.42 }); },
    doc: 'Over-the-shoulder on a DeCarlo brother — character quality, cloth, skin, hair, third-person framing. The brother must be the subject and must fill a useful part of the frame.',
  },
  crowd: {
    pos: [-200, 4, 90], look: [-240, 3, 30], fov: 55, time: 12.5, ground: true,
    weather: 'overcast',
    viewmodel: false,
    doc: 'Pedestrians on a downtown sidewalk — crowd density, variety, animation, the city feeling alive.',
  },
  chase: {
    pos: [-180, 8, 120], look: [-260, 3, 20], fov: 65, time: 20.2, ground: true,
    apply: (e) => e.ctx.peek('police')?.debugStage?.('pursuit'),
    weather: 'scattered',
    viewmodel: false,
    doc: 'Police pursuit — cruisers, lightbars at dusk, traffic reacting, wanted HUD.',
  },
  combat: {
    pos: [-210, 4, 100], look: [-260, 3, 40], fov: 65, time: 16.5, ground: true,
    apply: (e) => e.ctx.peek('peds')?.debugStage?.('firefight'),
    weather: 'overcast',
    doc: 'Firefight on the street — third-person gunplay, impact FX, ped reactions.',
  },

  // ---- material / detail ----
  detail: {
    pos: [-232, 1.6, 40], look: [-234, 1.0, 34], fov: 38, time: 16.5, ground: true,
    onRoad: { near: [-232, 64], eye: 1.55, aheadM: 5.5, side: 7.5 },
    clearTraffic: 26,
    weather: 'overcast',
    doc: 'Close-up on road surface and kerb — texel density, road paint wear, normal maps, grime.',
  },
  hud: {
    pos: [-232, 6, 150], look: [-232, 24, -40], fov: 62, time: 17.4, ground: true,
    apply: (e) => e.ctx.peek('ui')?.debugState?.('combat'),
    viewmodel: false,
    doc: 'Full HUD — minimap, wanted stars, health/armour, weapon, typography and readability.',
  },
};

// Re-aim the shot set at Steel City. Inherited shots that no longer describe
// anything in this game (the CoD market interior, the first-person viewmodel
// poses) are dropped; the names the tooling enumerates come from __SHOTS__ so
// nothing downstream needs to change.
for (const k of ['interior', 'weapon', 'ads', 'muzzle', 'impacts']) delete SHOTS[k];
/* =======================================================================
 * MARKETING SHOTS — the set that goes in the repo's README.
 * =======================================================================
 *
 * These are NOT review shots and the difference matters.
 *
 * The review set exists for critics: it must COVER the game, so it is
 * deliberately repetitive, deliberately unflattering, and framed to expose
 * defects. A four-lens panel scored it 23/100 and its sharpest line was the
 * fairest one — "there is no evidence anyone composed these images", and
 * "fourteen of the twenty-four are the same riverfront plaza shot from roughly
 * the same eye height and yaw". That is correct, and for a review set it is
 * almost a virtue.
 *
 * A marketing set has the opposite job: one frame, one idea, composed. So every
 * shot here is authored against three rules the critic gave us for free —
 *
 *   1. A POINT OF INTEREST. Something the eye lands on. The critic's complaint
 *      was "the bottom 40-60% of the frame is a featureless flat ground plane
 *      with nothing on it" — so no shot here points at empty ground.
 *   2. READABLE DEPTH. A foreground element, a mid-ground subject and a
 *      background, so the city has kilometres in it rather than "a near layer
 *      and a cutout".
 *   3. AN AUTHORED PALETTE. Each frame commits to a time and a weather that
 *      serve the Pittsburgh brief — sodium amber, slag orange, river teal, cold
 *      steel over wet grey-brown, leaning overcast. `hero` is the one deliberate
 *      exception: a clear golden hour, because a README needs one bright frame.
 *
 * `hud: false` on all of them. A screenshot in a README is a photograph of a
 * world, not of an interface.
 *
 * Captured by `node tools/screenshots.mjs`, which writes `screenshots/` at
 * 2560x1440 and regenerates its index. They are not part of the review set and
 * critics are never shown them — judging your own marketing frames is how you
 * end up believing them.
 */
const MARKETING_SHOTS = {
  mkt_skyline: {
    pos: [-528, 62, 470], look: [-236, 44, 44], fov: 48, time: 19.35, ground: true,
    weather: 'scattered', viewmodel: false, hud: false, marketing: true,
    doc: 'THE signature composition — downtown read from the Mt. Washington clifftop across the Monongahela at golden hour, with the cliff edge as foreground.',
  },
  mkt_bridge_dusk: {
    // Reuses the review 'bridge' framing, which is known to actually contain a
    // bridge. My first authored guess did not: absolute coordinates picked from
    // the map put the lens somewhere with no bridge in it at all, which is the
    // same mistake this file has now made four times. Reuse a framing that has
    // been LOOKED AT; change only the light.
    pos: [-64, 12, -328], look: [-300, 20, -120], fov: 60, time: 20.2, ground: true,
    weather: 'overcast', viewmodel: false, hud: false, marketing: true,
    doc: 'A river crossing at last light — the forty-bridges idea in one frame, steel against a wet sky.',
  },
  mkt_mill_night: {
    pos: [790, 18, 300], look: [880, 52, 250], fov: 55, time: 21.6, ground: true,
    weather: 'fog', viewmodel: false, hud: false, marketing: true,
    doc: 'The Old Blast Furnace at night in river fog — slag orange against cold steel, the thematic heart of a rustbelt city.',
  },
  mkt_rain_street: {
    pos: [-232, 5, 132], look: [-232, 12, -30], fov: 62, time: 20.4, ground: true,
    onRoad: { near: [-232, 64], eye: 1.62, aheadM: 34 },
    clearTraffic: 0, weather: 'storm', viewmodel: false, hud: false, marketing: true,
    doc: 'Downtown in a storm at eye level — wet asphalt, lit windows, traffic left in deliberately because a living street is the point.',
  },
  mkt_incline: {
    pos: [-424, 46, 458], look: [-556, 62, 372], fov: 54, time: 7.1, ground: true,
    weather: 'fog', viewmodel: false, hud: false, marketing: true,
    doc: 'The Duquesne Incline climbing Mt. Washington out of dawn river fog — the funicular, the cliff, and the city behind it.',
  },
  mkt_searchlight: {
    // Same base and the same frameBeam parameters as the review
    // 'searchlight_side' shot, which I verified by eye shows a soft-edged shaft
    // with real falloff. My marketing variant used a different base pose, and
    // because frameBeam derives the camera from where the helicopter was
    // STAGED, a different base put the lens flat against a wall.
    pos: [-190, 7, 120], look: [-250, 12, 40], fov: 60, time: 21.35, ground: true,
    weather: 'overcast', viewmodel: false, hud: false, marketing: true,
    apply: (e) => frameBeam(e, { stand: 72, aimUp: 0.5 }),
    doc: 'A police helicopter searchlight sweeping a street at night — the wanted system as a photograph.',
  },
  mkt_point: {
    // Also reuses the review 'point' framing — an elevated look down the
    // confluence. My authored version at river level was pointed at the
    // underside of a bridge deck.
    pos: [-672, 250, 356], look: [-600, 0, -30], fov: 56, time: 6.9,
    weather: 'fog', viewmodel: false, hud: false, marketing: true,
    doc: 'The Point at dawn, where three rivers meet — the confluence and the Golden Triangle beyond.',
  },
  mkt_kessel: {
    // Dylan's car, asked for by name. Framed like a press shot: three-quarter
    // front, low, on a real street rather than a turntable.
    pos: [-232, 6, 96], look: [-232, 5, 60], fov: 52, time: 18.9, ground: true,
    onRoad: { near: [-232, 64], eye: 1.35, aheadM: 8, side: 5.2 },
    clearTraffic: 26, weather: 'overcast', viewmodel: false, hud: false, marketing: true,
    // REAR three-quarter, slightly above — the angle the reference photo uses,
    // and the only one that shows what makes this car itself: the unbroken
    // roofline sweeping into a short deck, and the full-width tail bar. A front
    // three-quarter reads as a generic wedge, which is what my first cut looked
    // like.
    apply: (e) => frameVehicle(e, 'kessel', { dist: 10.5, height: 2.6, swing: 2.42, aimY: 0.85 }),
    doc: `Dylan's Kessel GT — a front-drive fastback, three-quarter front at dusk.`,
  },
  mkt_hero: {
    pos: [-232, 6, 150], look: [-232, 24, -40], fov: 62, time: 17.4, ground: true,
    onRoad: { near: [-232, 64], eye: 5.5, aheadM: 55 },
    clearTraffic: 0, viewmodel: false, hud: false, marketing: true,
    doc: 'A Golden Triangle avenue in clear afternoon light — the one bright frame, and the closest thing to a box-art shot.',
  },
};

Object.assign(SHOTS, STEEL_CITY_SHOTS, MARKETING_SHOTS);

/** Shot ids flagged `marketing: true` — what `tools/screenshots.mjs` captures. */
export const MARKETING_IDS = Object.keys(MARKETING_SHOTS);

export function installShotApi(engine, { capture, lockstep = false } = {}) {
  window.__SHOTS__ = SHOTS;
  // Which shot was applied last, so the capture harness can re-pin that shot's
  // authored time-of-day at the shutter without being told it a second time.
  window.__LAST_SHOT__ = null;

  /**
   * `opts.grabFrame` is how many frames the harness will pump before it presses
   * the shutter. Shots whose subject is a transient (a muzzle flash lives ~52 ms)
   * need it so they can land the event on the captured frame instead of guessing.
   */
  window.__APPLY_SHOT__ = (name, opts = {}) => {
    // An inline shot: any agent can frame an arbitrary camera without editing
    // this file (which the lead owns). Pass JSON as the shot name, e.g.
    //   node tools/capture.mjs --shot='{"pos":[10,3,20],"look":[0,2,0],"time":19}'
    let shot;
    if (typeof name === 'string' && name.trim().startsWith('{')) {
      try {
        shot = JSON.parse(name);
      } catch (e) {
        return { error: `inline shot is not valid JSON: ${e.message}` };
      }
      if (!Array.isArray(shot.pos) || !Array.isArray(shot.look)) {
        return { error: 'inline shot needs pos:[x,y,z] and look:[x,y,z]' };
      }
    } else {
      shot = SHOTS[name];
    }
    if (!shot) return { error: `unknown shot "${name}"`, available: Object.keys(SHOTS) };

    // Freeze live input and hand the camera to the shot.
    engine.input.frozen = true;
    engine.input.enabled = false;
    const player = engine.ctx.peek('player');
    player?.setControlEnabled?.(false);

    const cam = engine.camera;
    cam.position.fromArray(shot.pos);
    const target = new THREE.Vector3().fromArray(shot.look);

    // `ground: true` treats the y components as heights ABOVE the terrain, so a
    // shot stays correctly framed while `world` is still reshaping its
    // heightfield. Falls back to absolute y if the world can't answer yet.
    // Installed BEFORE the `onRoad` branch, which returns early — putting this
    // after it meant every road-framed shot (i.e. every street-level review
    // shot) silently skipped it, which is why `detail` still photographed a
    // pile-up after `clearTraffic` was added to it.
    //
    // `capture.mjs` calls this again immediately before the shutter, because a
    // shot settles for ~1300 frames and traffic repopulates and crashes during
    // them. `peds` measured `--shot=hero` at 5693 draws / 16.3 M tris of cars
    // filling the frame — unusable for judging anything.
    window.__LAST_SHOT__ = name;
    window.__PRESHUTTER__ = shot.clearTraffic
      ? () => {
          const veh = engine.ctx.peek('vehicles');
          const pl = engine.ctx.peek('player');
          const mine = pl?.vehicle ?? pl?.currentVehicle ?? null;
          const r2 = shot.clearTraffic * shot.clearTraffic;
          const cp = engine.camera.position;
          let n = 0;
          if (veh?.vehicles?.length) {
            for (const v of veh.vehicles.slice()) {
              if (v === mine || v?._staged) continue;
              const dx = v.position.x - cp.x;
              const dz = v.position.z - cp.z;
              if (dx * dx + dz * dz >= r2) continue;

              // ONLY the wrecks and the stalled. Clearing ALL nearby traffic
              // was over-correction: it was added when a scratch-vector alias in
              // `traffic` spawned every car AT THE CAMERA and pile-ups filled
              // the lens. That bug is fixed (write-offs 0-5/min, big impacts
              // 36/min), and blanket-clearing then emptied the city for reviews
              // — a critic panel duly reported "a four-lane road at 15:00 with
              // zero vehicles on it", which was the harness, not the game.
              // Moving traffic is exactly what a street frame is supposed to
              // show.
              const stalled = (v.speed ?? 0) < 0.6;
              if (!v.destroyed && !stalled) continue;
              veh.despawn(v);
              n++;
            }
          }
          return n;
        }
      : null;

    /*
     * Re-apply the chrome suppression AT THE SHUTTER, not only at apply time.
     *
     * Setting `viewScene.visible = false` when the shot is applied is not
     * enough: the shot then settles for tens to hundreds of frames, and the
     * viewmodel came back every time. Whatever restores it — a camera-mode
     * update, a weapon pose refresh — runs during that settle, so the flag has
     * to be re-asserted on the last frame before the capture rather than the
     * first. Same for the zone toast, which the settle can re-trigger.
     *
     * Chained rather than replacing `__PRESHUTTER__`, so `clearTraffic` still
     * runs where a shot asks for it.
     */
    const prevShutter = window.__PRESHUTTER__;
    window.__PRESHUTTER__ = () => {
      const n = prevShutter ? prevShutter() : 0;
      shotChrome(engine, shot);
      return n;
    };
    window.__PRESHUTTER__?.();

    // `onRoad: { near:[x,z], eye, ahead }` snaps the shot onto the nearest lane
    // of the real road graph and aims it down the street.
    //
    // Hardcoded street coordinates do not survive a procedural city that is
    // still being regenerated: the first hero shots put the camera inside a
    // building and the critics spent their review on a wall two metres from the
    // lens. Resolving the framing from `world.roads` at apply time means a
    // street shot always frames an actual street, whatever the generator did.
    if (shot.onRoad) {
      const w = engine.ctx.peek('world');
      const roads = w?.roads;
      const [nx, nz] = shot.onRoad.near ?? [cam.position.x, cam.position.z];
      const hit = roads?.nearestEdge?.(nx, nz);
      if (hit?.edge != null && roads.laneCenter) {
        const eye = shot.onRoad.eye ?? 5.5;
        // `ahead` is a FRACTION of the edge, which is unpredictable because edge
        // lengths vary from an alley stub to a highway span — the `detail` shot
        // asked for 0.02 and got a camera 1.21 m from a wall, which a critic
        // panel then reported as "a windowless stucco slab" and "windows have no
        // reveal anywhere in the build". Both findings were my framing, not the
        // geometry. `aheadM` says how far to look in METRES and converts.
        let ahead = shot.onRoad.ahead ?? 0.22;
        if (shot.onRoad.aheadM != null) {
          const a = new THREE.Vector3();
          const b = new THREE.Vector3();
          roads.laneCenter(hit.edge.id ?? hit.edge, 0, 0, a);
          roads.laneCenter(hit.edge.id ?? hit.edge, 0, 1, b);
          const len = a.distanceTo(b);
          ahead = len > 1 ? THREE.MathUtils.clamp(shot.onRoad.aheadM / len, 0.01, 0.9) : 0.22;
        }
        const t = typeof hit.t === 'number' ? hit.t : 0.5;
        const lane = hit.lane ?? 0;
        const a = new THREE.Vector3();
        const b = new THREE.Vector3();
        roads.laneCenter(hit.edge.id ?? hit.edge, lane, THREE.MathUtils.clamp(t, 0, 1), a);
        roads.laneCenter(hit.edge.id ?? hit.edge, lane, THREE.MathUtils.clamp(t + ahead, 0, 1), b);
        // Degenerate parameterisation (a very short edge) would aim the camera
        // at its own position; fall back to the authored look target.
        if (a.distanceToSquared(b) > 1) {
          // `side` steps the camera perpendicular off the carriageway onto the
          // pavement. Standing on a live lane means traffic drives through the
          // lens: `render` measured a car occupying the frame in 3 of 8 shot-set
          // captures, which made two review rounds unusable for measurement.
          let sx = 0, sz = 0;
          if (shot.onRoad.side) {
            const dx = b.x - a.x, dz = b.z - a.z;
            const l = Math.hypot(dx, dz) || 1;
            sx = (-dz / l) * shot.onRoad.side;
            sz = (dx / l) * shot.onRoad.side;
          }
          cam.position.set(a.x + sx, a.y + eye, a.z + sz);
          target.set(b.x + sx, b.y + eye * 0.55, b.z + sz);
          cam.lookAt(target);
          if (shot.fov) { cam.fov = shot.fov; cam.updateProjectionMatrix(); }
          player?.teleport?.(cam.position, cam.rotation);
          engine.ctx.peek('weapons')?.debugPose?.('idle');
          engine.ctx.peek('fx')?.debugBurst?.('none');
          engine.ctx.peek('ui')?.debugState?.('clean');
          if (shot.time !== undefined) engine.ctx.peek('sky')?.setTimeOfDay?.(shot.time);
          const sky0 = engine.ctx.peek('sky');
          sky0?.setWeather?.(shot.weather ?? 'clear', { immediate: true });
          engine.__shotCam = null;
          shotChrome(engine, shot);
          shot.apply?.(engine, opts);
          engine.events.emit('shot:applied', { name, shot });
          return { applied: name, pos: cam.position.toArray(), onRoad: true, fov: shot.fov ?? engine.config.fov };
        }
      }
    }

    if (shot.ground) {
      const w = engine.ctx.peek('world');
      const h = w?.heightAt ?? w?.groundHeight;
      if (h) {
        cam.position.y += h.call(w, cam.position.x, cam.position.z) ?? 0;
        target.y += h.call(w, target.x, target.z) ?? 0;
      }
    }
    cam.lookAt(target);
    if (shot.fov) {
      cam.fov = shot.fov;
      cam.updateProjectionMatrix();
    }
    // Keep the player capsule under the camera so gameplay systems stay coherent.
    player?.teleport?.(cam.position, cam.rotation);

    // Shots are applied back to back in one browser session, so clear the
    // previous shot's *looping* debug state first. Without this the `muzzle`
    // shot's scripted burst is still emptying the magazine during `combat`, and
    // `impacts` keeps walking rounds across a wall behind the HUD shot.
    engine.ctx.peek('weapons')?.debugPose?.('idle');
    engine.ctx.peek('fx')?.debugBurst?.('none');
    engine.ctx.peek('ui')?.debugState?.('clean');

    shotChrome(engine, shot);

    // `clearTraffic: <metres>` empties the immediate area of AI vehicles. A
    // material/detail shot is about the surface, and a wrecked traffic car
    // parked across the lens has repeatedly cost a review round — one critic
    // panel judged "the detail shot" and was actually judging a van.
    if (shot.time !== undefined) engine.ctx.peek('sky')?.setTimeOfDay?.(shot.time);
    // Weather shots snap straight to the target state — the live system blends
    // over minutes, which a 90-frame capture would never reach.
    const sky = engine.ctx.peek('sky');
    if (shot.weather) sky?.setWeather?.(shot.weather, { immediate: true });
    else sky?.setWeather?.('clear', { immediate: true });
    shot.apply?.(engine, opts);

    engine.events.emit('shot:applied', { name, shot });
    return { applied: name, pos: shot.pos, fov: shot.fov ?? engine.config.fov };
  };

  if (capture) {
    engine.input.frozen = true;
    // Fixed timestep in capture mode so temporal effects converge identically.
    //
    // `this._last = fake` before each step forces rawDt to be EXACTLY 1000/60 on
    // every frame including the first, whatever else touched `_last` (Engine.start
    // and prewarm both assign performance.now() to it). Without that, frame 1's dt
    // was 0 whenever `_last` had been stamped with a real clock and 1/60 when it
    // had not — a boot-path-dependent one-frame difference in every accumulator.
    let fake = 0;
    engine.step = ((orig) =>
      function () {
        this._last = fake;
        fake += 1000 / 60;
        return orig.call(this, fake);
      })(engine.step);
  }

  /**
   * Streaming settle probe, polled by tools/capture.mjs before the shutter.
   *
   * A shot teleports the camera kilometres across a STREAMED city, so the tiles
   * around the new position have not been built yet and the amortised job queue
   * needs many frames to catch up. Capturing on a fixed frame count would
   * photograph a half-built city and hand critics a page of defects that are
   * really just "you took the picture too early".
   *
   * Returns true when `world` reports its build queue drained. Systems that
   * have not implemented `streamingIdle()` are treated as idle so this can
   * never deadlock a capture.
   */
  /*
   * SETTLED means THE PICTURE HAS STOPPED CHANGING — not that one subsystem
   * says its queue is empty.
   *
   * This used to return `world.streamingIdle()` alone. But `buildings`, `props`,
   * `peds` and `traffic` all stream in too, on their own schedules, so the
   * predicate reported "settled" while a quarter of the city was still
   * arriving. MEASURED across three captures of one shot, all three reporting
   * settled:true at 153-158 frames:
   *
   *     draw calls   2959 / 4074 / 4096
   *     triangles    8.26M / 10.94M / 10.96M
   *
   * Same seed, same shot, same tree — a 28% difference in how much city was in
   * the photograph. That is why the pixel gate was unusable: an agent measured a
   * 1.54% noise floor on one same-tree pair and 81.7% on the next, and correctly
   * threw away their own before/after result as meaningless.
   *
   * So ask the RENDERER, which is the thing the shutter actually photographs:
   * draw calls and triangle count unchanged for STABLE_FRAMES consecutive
   * frames. That is rule 12 — assert against the emitted artefact, not against
   * an intermediate flag owned by one of several contributors.
   *
   * `streamingIdle` is kept as a cheap necessary condition so we do not declare
   * stability during a lull in an amortised build queue.
   */
  const RING = 8;
  const _ring = new Array(RING).fill(0);
  const _ringT = new Array(RING).fill(0);
  let _settleFrame = 0;
  let _stableFor = 0;
  let _lastCalls = -1;
  let _lastTris = -1;
  window.__SETTLED__ = () => {
    /*
     * MEASURED trajectory for `hero`, draw calls per frame after the shot is
     * applied:
     *
     *   f0   217      f160 4041      f320 4234      f720 4257
     *   f40  562      f200 4112      f440 4156      f880 4304
     *   f80  2191     f240 4135      f600 4164
     *   f120 3340
     *
     * Almost the whole city arrives in the first ~200 frames, and the old
     * predicate fired at ~f155 — on the steepest part of that curve, where a
     * few frames of timing difference is a thousand draw calls. Past ~f240 it
     * drifts slowly (a few percent over hundreds of frames) with a jitter of
     * about +/-30 from traffic crossing the frustum edge.
     *
     * So: a MINIMUM frame count to clear the knee, then stability within a
     * tolerance wide enough to ignore moving actors but tight enough to catch a
     * subsystem still streaming.
     */
    const MIN_FRAMES = 240;
    // Consecutive CALLS, not frames. The capture driver pumps in chunks and
    // asks once per chunk, so this predicate is polled far less often than the
    // engine steps. Counting calls as if they were frames is a bug I already
    // shipped once here: with a 20-frame chunk, a 240-"frame" minimum silently
    // demanded 4800 real frames and nothing ever settled.
    const STABLE_CHECKS = 3;
    const TOL = 0.02;

    _settleFrame++;
    const engineFrame = engine.time.frame;
    // `streamingIdle` is a NECESSARY condition early on, but it flickers — it
    // reports a lull in an amortised queue, not completion — so past the knee it
    // is allowed to stop vetoing. Letting it reset the stability counter forever
    // is why this predicate never fired at all and every capture burned the
    // whole 1200-frame budget.
    if (engineFrame < MIN_FRAMES) {
      const w0 = engine.ctx.peek('world');
      if (w0 && typeof w0.streamingIdle === 'function') {
        try { if (w0.streamingIdle() !== true) _stableFor = 0; } catch { /* ignore */ }
      }
    }
    const info = engine.ctx.peek('render')?.renderer?.info;
    if (!info) return true; // nothing to measure — do not hang the harness

    /*
     * OUTSIDE CAPTURE MODE, DO NOT DEMAND PIXEL-GRADE STABILITY.
     *
     * The strict test below exists so a screenshot is reproducible. `playtest`
     * and the other in-game harnesses only need "the world is loaded enough to
     * play", and they run the LIVE game config — full traffic, full peds, no
     * lockstep — where draw calls legitimately oscillate 742-1197 (+/-20%)
     * forever. Two separate agents lost time to `playtest --quick` timing out
     * on this predicate after I tightened it, one of them reproducing it with
     * their own changes fully reverted before concluding it was not theirs.
     *
     * A harness gate that blocks unrelated work is a bug in the gate.
     */
    if (!capture) {
      const w1 = engine.ctx.peek('world');
      let idle = true;
      try { idle = !w1?.streamingIdle || w1.streamingIdle() === true; } catch { /* ignore */ }
      return idle && engineFrame >= MIN_FRAMES;
    }

    /*
     * COMPARE WINDOWS, NOT ADJACENT FRAMES.
     *
     * Some passes run on alternate frames, so the per-frame draw count
     * legitimately oscillates. MEASURED over a 700-frame trace on a fully built
     * scene: calls alternate 877 <-> 1178 EVERY frame — a 35% two-frame swing
     * that never settles and never will.
     *
     * My first cut compared frame N against frame N-1 with a 2% tolerance, so it
     * could never be satisfied. Every capture in the project then burned the
     * full 1200-frame budget and printed "world still streaming", and
     * `playtest --quick` timed out waiting on this predicate. That was my bug,
     * and it blocked every other agent's frames — worth stating plainly, because
     * a harness that fails closed is still a harness that fails.
     *
     * The oscillation is periodic, so the MAXIMUM over a window longer than its
     * period is stable once the scene is. Compare window maxima instead.
     */
    _ring[_settleFrame % RING] = info.render.calls;
    _ringT[_settleFrame % RING] = info.render.triangles;
    if (_settleFrame < RING) return false;
    const calls = Math.max(..._ring);
    const tris = Math.max(..._ringT);
    const steady =
      _lastCalls > 0 &&
      Math.abs(calls - _lastCalls) <= Math.max(4, _lastCalls * TOL) &&
      Math.abs(tris - _lastTris) <= Math.max(2000, _lastTris * TOL);
    _lastCalls = calls;
    _lastTris = tris;
    _stableFor = steady ? _stableFor + 1 : 0;
    return engineFrame >= MIN_FRAMES && _stableFor >= STABLE_CHECKS;
  };

  window.__RENDER_INFO__ = null;
  engine.events.on('resize', () => {});
  const snapInfo = () => {
    const r = engine.ctx.peek('render');
    window.__RENDER_INFO__ = {
      frame: engine.time.frame,
      calls: r?.renderer?.info.render.calls ?? 0,
      tris: r?.renderer?.info.render.triangles ?? 0,
      programs: r?.renderer?.info.programs?.length ?? 0,
      textures: r?.renderer?.info.memory.textures ?? 0,
      geometries: r?.renderer?.info.memory.geometries ?? 0,
      ms: engine.time.dt * 1000,
      // The RESOLVED camera pose. `onRoad` shots re-derive their camera from
      // the road graph at apply time, so when the graph changes — new lots, a
      // re-cut corridor — a shot silently relocates. Two capture sets then
      // compare different PLACES, and a blind A/B measures the move rather than
      // the work. Recording the pose lets the comparison detect that and drop
      // the shot instead of reporting a confounded verdict.
      camPose: [
        +engine.camera.position.x.toFixed(2),
        +engine.camera.position.y.toFixed(2),
        +engine.camera.position.z.toFixed(2),
        +engine.camera.rotation.x.toFixed(3),
        +engine.camera.rotation.y.toFixed(3),
        +engine.camera.rotation.z.toFixed(3),
      ],
    };
  };

  /**
   * LOCKSTEP CAPTURE (`?capture=1&lockstep=1`) — the determinism fix.
   *
   * The problem it solves: the engine's own rAF loop keeps stepping while the
   * driver is doing round trips (waitForFunction on __READY__, the evaluate that
   * applies the shot, the screenshot RPC itself). The number of frames that fit
   * inside those round trips is wall-clock dependent, so `engine.time.frame` at
   * the moment the shutter fires drifted 10-20 frames run to run. Everything
   * phase-locked to the absolute frame index — TAA jitter (render/index.js:1067),
   * GTAO / SSR / contact-shadow noise rotation (`frame % 64`), exposure
   * adaptation, and the cadence of every scripted transient — therefore resolved
   * differently on every run. That, not any subsystem clock read, is what made
   * two identical runs differ and what made pre-warm (which burns ~1.4 s of wall
   * clock before the loop starts) look like a visual change.
   *
   * The fix: in lockstep mode the engine NEVER schedules its own frames. Frames
   * only happen inside __PUMP__(n), which advances exactly n of them. The frame
   * index at the shutter is then a constant, and nothing at all advances while
   * the screenshot is being taken.
   */
  if (lockstep) {
    engine.start = function () { this._running = true; };
    window.__LOCKSTEP__ = true;

    /** Advance exactly `n` engine frames, one per rAF so each is presented. */
    window.__PUMP__ = (n = 1) => new Promise((resolve) => {
      let i = 0;
      const tick = () => {
        engine.step();
        snapInfo();
        if (++i >= n) resolve(engine.time.frame);
        else requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    });

    /** Yield `n` rAFs WITHOUT stepping, so the compositor picks up the last
     *  rendered frame before the screenshot. Advances no simulation state. */
    window.__PRESENT__ = (n = 2) => new Promise((resolve) => {
      let i = 0;
      const tick = () => (++i >= n ? resolve(engine.time.frame) : requestAnimationFrame(tick));
      requestAnimationFrame(tick);
    });
  } else {
    window.__LOCKSTEP__ = false;
    // Free-running: the engine drives itself, __PUMP__ just waits out n frames.
    window.__PUMP__ = (n = 1) => new Promise((resolve) => {
      let i = 0;
      const tick = () => (++i >= n ? resolve(engine.time.frame) : requestAnimationFrame(tick));
      requestAnimationFrame(tick);
    });
    window.__PRESENT__ = window.__PUMP__;
    const info = () => { snapInfo(); requestAnimationFrame(info); };
    requestAnimationFrame(info);
  }

  return { pump: window.__PUMP__, present: window.__PRESENT__, lockstep: !!lockstep };
}
