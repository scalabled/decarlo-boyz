/**
 * Model assembly: geometry groups -> a four-level LOD chain of real meshes.
 *
 * Geometry is CACHED PER (class, lod) and shared by every instance, so forty
 * traffic cars cost forty transforms and no extra vertices. Paint materials are
 * cached per colour. What is per-vehicle is only what has to be: the lamp
 * materials (this car's brake lights, not the one in front) and the number
 * plate.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * WHY THE LOD CHAIN IS LAZY
 * ────────────────────────────────────────────────────────────────────────────
 * This file used to build ALL FOUR levels as real meshes the moment a car
 * spawned, and hang them all off the root with only one level `visible`. That
 * is 57 `THREE.Mesh` nodes per car of which at most eleven are ever submitted.
 * With 52 cars alive it put 2988 mesh nodes in the scene graph — the single
 * largest object population in the game, larger than every building in the
 * city put together — and `drawbreak` attributed the whole unplayable frame to
 * it. Hidden nodes are not free: `traverseVisible` still walks the parent, the
 * cull book-keeping still touches them, and the four hidden LODs of a car
 * 300 m away were four times the cost of the one level that could be seen.
 *
 * So a level is now MATERIALISED ON DEMAND (`ensureLod`) and RELEASED after it
 * has gone unused for `RELEASE_AFTER` seconds. The geometry and the materials
 * are cached per class, so building a level is a handful of `new THREE.Mesh`
 * and releasing one frees nothing but the nodes: rebuilding costs microseconds
 * and never touches the GPU. A traffic car that lives its whole life 200 m away
 * now costs FOUR nodes instead of fifty-seven.
 *
 * The exception is a car that has been damaged: dents live in copy-on-write
 * geometry owned by one mesh, so `pin()` freezes that car's chain in place.
 *
 * WHEELS ARE INSTANCED. Four wheels are the same geometry four times with four
 * transforms, which is the textbook `InstancedMesh`: three draws instead of
 * twelve at LOD0, two instead of eight at LOD1. Past 52 m the wheels are BAKED
 * into the body's dark group at their static ride height — suspension travel
 * and wheel spin are both well under a pixel there, and it takes the far LOD
 * from eight nodes to four.
 *
 * Draw-call budget per vehicle:
 *   LOD0  ~20  (0-22 m, the hero car and whatever the player is next to)
 *   LOD1   ~7  (22-52 m)
 *   LOD2    4  (52-130 m, wheels baked in)
 *   LOD3    4  (beyond, wheels baked in)
 */

import * as THREE from 'three';
import { buildCarBody } from './body.js';
import { buildWheel, buildBikeChassis } from './wheels.js';
import { buildInterior, buildBoatInterior } from './interior.js';
import { buildBoatHull } from './boat.js';
import { buildHeliBody } from './heli.js';
import { buildPlaneBody } from './plane.js';
import { buildJetBody } from './jet.js';
import { buildTankBody } from './tank.js';
import { buildTramBody } from './tram.js';
import { mergeAll, transform, triCount, bakeBoxUV, bakePolarUV } from './geom.js';

const LOD_COUNT = 4;

/** Cached geometry, keyed `${classId}|${lod}`. */
const GEO_CACHE = new Map();

export function clearGeometryCache() {
  for (const entry of GEO_CACHE.values()) {
    for (const k in entry.body) disposeList(entry.body[k]);
    for (const k in entry.wheel) disposeList(entry.wheel[k]);
    for (const d of entry.doors ?? []) d.geo?.dispose?.();
    for (const r of entry.rotors ?? []) r.geo?.dispose?.();
    entry.turret?.geo?.dispose?.();
    entry.turret?.gun?.geo?.dispose?.();
  }
  GEO_CACHE.clear();
}

function disposeList(v) {
  if (!v) return;
  if (Array.isArray(v)) for (const g of v) g?.dispose?.();
  else if (v.lamps) for (const k in v.lamps) disposeList(v.lamps[k]);
  else v.dispose?.();
}

/* ------------------------------------------------------------------ */

function geometryFor(spec, lod) {
  const key = `${spec.id}|${lod}`;
  let e = GEO_CACHE.get(key);
  if (e) return e;

  let body;
  if (spec.kind === 'bike') body = buildBikeChassis(spec, lod);
  else if (spec.kind === 'boat') body = buildBoatHull(spec, lod);
  else if (spec.kind === 'heli') body = buildHeliBody(spec, lod);
  // Two airframes ride `kind: 'plane'` — the shape picks the builder, the
  // kind picks the flight model, so the jet flies `stepPlane` in a fighter's
  // metal without a third dynamics branch.
  else if (spec.kind === 'plane') {
    body = spec.style.shape === 'jet' ? buildJetBody(spec, lod) : buildPlaneBody(spec, lod);
  } else if (spec.kind === 'tank') body = buildTankBody(spec, lod);
  else if (spec.kind === 'tram') body = buildTramBody(spec, lod);
  else body = buildCarBody(spec, lod);

  // The helicopter carries its own cabin (floor, seats, sticks) inside
  // `buildHeliBody`, for the same reason the bike does: `buildInterior` builds a
  // CAR — a dashboard across a cowl, a headliner under a roofline, door cards
  // against a sill — and a glazed pod has none of those surfaces to hang them on.
  const interior =
    spec.kind === 'boat' ? buildBoatInterior(spec, lod)
      : spec.kind === 'bike' || spec.kind === 'heli' || spec.kind === 'plane' ||
        spec.kind === 'tram' || spec.kind === 'tank'
        ? { seat: [], leather: [], dash: [], trim: [], chrome: [], cavity: [] }
        : buildInterior(spec, lod);

  // Fold the interior into the body's material groups.
  const merged = {
    paint: mergeAll(body.paint ?? []),
    trim: mergeAll([...(body.trim ?? []), ...(interior.trim ?? [])]),
    chrome: mergeAll([...(body.chrome ?? []), ...(interior.chrome ?? [])]),
    cavity: mergeAll([...(body.cavity ?? []), ...(interior.cavity ?? [])]),
    glass: mergeAll(body.glass ?? []),
    grilleMesh: mergeAll(body.grilleMesh ?? []),
    plate: mergeAll(body.plate ?? []),
    disc: mergeAll(body.disc ?? []),
    seat: mergeAll(interior.seat ?? []),
    leather: mergeAll(interior.leather ?? []),
    dash: mergeAll(interior.dash ?? []),
    lamps: {},
  };
  for (const k in body.lamps ?? {}) merged.lamps[k] = mergeAll(body.lamps[k]);

  /**
   * ONE COORDINATE SYSTEM PER MATERIAL GROUP.
   *
   * The merged paint group is ~40 geometries from six builders with four
   * mutually incompatible uv conventions (see `bakeBoxUV`), which is the reason
   * `paint.js` could never bind an albedo map. Re-project the groups that take
   * projected micro-detail — paint, trim, cavity — into object-space metres,
   * AFTER the merge so every part lands in the same space.
   *
   * Deliberately NOT re-projected: plate, dash, seat, leather, glass, lamps and
   * grilleMesh all carry an AUTHORED uv that a texture depends on (a number
   * plate, two gauge dials, a windscreen frit that has to sit on the pane's own
   * edge). At LOD >= 1 those groups are folded into `trim` and re-projected with
   * it, which is correct: the material they are drawn with there has no map that
   * cares, and past 22 m a gauge dial is a quarter of a pixel.
   */
  bakeBoxUV(merged.paint);
  bakeGrime(merged.paint, spec);
  bakeWear(merged.paint, spec);

  // Distant LODs collapse to two groups.
  if (lod >= 2) {
    const dark = mergeAll([
      merged.trim, merged.chrome, merged.cavity, merged.grilleMesh,
      merged.plate, merged.disc, merged.seat, merged.leather, merged.dash,
    ]);
    merged.trim = dark;
    merged.chrome = new THREE.BufferGeometry();
    merged.cavity = new THREE.BufferGeometry();
    merged.grilleMesh = new THREE.BufferGeometry();
    merged.plate = new THREE.BufferGeometry();
    merged.disc = new THREE.BufferGeometry();
    merged.seat = new THREE.BufferGeometry();
    merged.leather = new THREE.BufferGeometry();
    merged.dash = new THREE.BufferGeometry();
    if (spec.kind === 'tram') {
      /**
       * The tram's lit CABIN is a 12 m `drl` strip behind the window band
       * (see tram.js). Folding it into the single red brake cluster here
       * would paint the whole window row brake-red from 52 m out at night —
       * so this one class keeps the LOD1 front/rear split. One extra draw
       * call, on one vehicle, only when it is far away.
       */
      const front = [];
      const rear = [];
      for (const k in merged.lamps) {
        (k === 'head' || k === 'drl' || k === 'indicator' ? front : rear).push(merged.lamps[k]);
      }
      merged.lamps = { drl: mergeAll(front), brake: mergeAll(rear) };
    } else {
      const lampAll = [];
      for (const k in merged.lamps) lampAll.push(merged.lamps[k]);
      merged.lamps = { brake: mergeAll(lampAll) };
    }
  } else if (lod === 1) {
    /**
     * Beyond ~22 m nothing here resolves as a separate material, so collapse
     * everything that is not paint, glass or a lamp into one dark group. Draw
     * calls, not triangles, are what forty traffic cars cost: this takes LOD1
     * from 24 calls to 12, which is the difference between traffic being free
     * and traffic being the frame budget.
     */
    merged.trim = mergeAll([
      merged.trim, merged.chrome, merged.cavity, merged.grilleMesh,
      merged.plate, merged.disc, merged.seat, merged.leather, merged.dash,
    ]);
    for (const k of ['chrome', 'cavity', 'grilleMesh', 'plate', 'disc', 'seat', 'leather', 'dash']) {
      merged[k] = new THREE.BufferGeometry();
    }
    // Lamps collapse to front (white) and rear (red) clusters.
    const front = [];
    const rear = [];
    for (const k in merged.lamps) {
      (k === 'head' || k === 'drl' || k === 'indicator' ? front : rear).push(merged.lamps[k]);
    }
    merged.lamps = { drl: mergeAll(front), brake: mergeAll(rear) };
  }

  // AFTER the LOD collapse, never before: `mergeAll` strips every attribute
  // except position/normal/uv, so a uv or a wear mask baked ahead of the
  // collapse is silently thrown away and the merged dark group inherits four
  // different uv conventions again.
  if (merged.trim.attributes?.position) {
    bakeBoxUV(merged.trim);
    bakeGrime(merged.trim, spec, 0.5);
    bakeWear(merged.trim, spec, 0.5);
  }
  if (merged.cavity.attributes?.position) bakeBoxUV(merged.cavity);

  // The tram's rail wheels are part of the body (tram.js builds them into the
  // bogies), so it takes no road-wheel chain either. Nor does the tank: its
  // road wheels live under the skirts, built by `buildTankBody` into `trim`.
  const wheelGeo = spec.kind === 'boat' || spec.kind === 'heli' ||
    spec.kind === 'plane' || spec.kind === 'tram' || spec.kind === 'tank'
    ? null : buildWheelGeo(spec, lod);

  // Doors are their own meshes — they have to move independently — and are
  // built for LOD0 only. Same class-level cache as everything else, so forty
  // parked cars share one pair of door panels.
  const doors = (body.doors ?? []).map((d) => {
    bakeBoxUV(d.geo);
    bakeGrime(d.geo, spec);
    bakeWear(d.geo, spec);
    darkenInnerFaces(d.geo, d.side);
    return d;
  });

  /**
   * Rotors. Cached with the class like everything else, but kept OUT of the
   * merged material groups on purpose: a merged rotor is welded to the airframe
   * and cannot turn. Same treatment as a door, and for the same reason.
   * Dropped past LOD2 — at 130 m a blade is well under a pixel wide, and the
   * disc reads from the fuselage silhouette alone.
   */
  const rotors = lod <= 2
    ? (body.rotors ?? []).map((r) => {
      bakeBoxUV(r.geo);
      return r;
    })
    : [];

  /**
   * The tank's turret. Same treatment as a rotor — merged into nothing, so it
   * can traverse — but TWO nested pivots (ring, then trunnion), and kept at
   * EVERY LOD: a turret welded straight ahead past 130 m would visibly snap
   * back the moment an emplacement tracking the player crossed the boundary.
   */
  let turret = null;
  if (body.turret) {
    bakeBoxUV(body.turret.geo);
    bakeGrime(body.turret.geo, spec, 0.6);
    bakeWear(body.turret.geo, spec, 0.6);
    bakeBoxUV(body.turret.gun.geo);
    turret = body.turret;
  }

  e = {
    body: merged, wheel: wheelGeo, doors, rotors, turret,
    anchors: body.anchors ?? {}, surface: body.surface ?? null,
  };
  GEO_CACHE.set(key, e);
  return e;
}

function buildWheelGeo(spec, lod) {
  const w = buildWheel(spec, lod, true);
  const rimR = spec.wheel.radius * spec.wheel.rimFrac;
  const spokes = spec.wheel.spokes ?? 5;
  /**
   * The rim's own natural parameterisation, not the union of a cylinder unwrap,
   * a lathe unwrap, N hand-built spokes with no uv at all and a torus. See
   * `bakePolarUV`: u around the axle one tile per spoke bay, v out from the hub.
   * The tyre is NOT re-projected — its uv is already the right one (u the
   * circumference, v across the section) and the sidewall lettering depends on
   * it.
   */
  if (lod >= 2) {
    return { rubber: mergeAll([...w.rubber, ...w.rim, ...w.disc, ...w.caliper]), rim: null, disc: null };
  }
  if (lod === 1) {
    return {
      rubber: mergeAll(w.rubber),
      rim: bakePolarUV(mergeAll([...w.rim, ...w.disc, ...w.caliper]), rimR, spokes),
      disc: null,
    };
  }
  /**
   * A CLASS MAY PAINT ITS CALIPERS. `paint.js` has had `mats.caliper(color)`
   * since the wheel was written and nothing ever called it with an argument —
   * the caliper geometry was merged into the disc and drawn in cast iron, so
   * every car in the fleet had grey calipers whatever its spec said.
   *
   * Split only at LOD0 and only when a class asks. LOD1 bakes the whole wheel
   * into one polar-UV mesh and LOD2 into one, and a coloured caliper is a
   * detail you cannot resolve at either distance — so nothing that did not ask
   * gains a draw call, and nothing at all gains one past 0.
   */
  if (spec.wheel.caliper) {
    return {
      rubber: mergeAll(w.rubber),
      rim: bakePolarUV(mergeAll(w.rim), rimR, spokes),
      disc: mergeAll(w.disc),
      caliper: mergeAll(w.caliper),
    };
  }
  return {
    rubber: mergeAll(w.rubber),
    rim: bakePolarUV(mergeAll(w.rim), rimR, spokes),
    disc: mergeAll([...w.disc, ...w.caliper]),
  };
}

/**
 * Road film, baked as vertex colour.
 *
 * A clean car is a CG car. Multiply-only vertex colour can darken but not
 * lighten, which is exactly right for the things that actually matter: the
 * shadowed film under the sills, the spray fan behind each arch, and the grime
 * that collects in the shutlines and around the lower bumper corners.
 */
function bakeGrime(geo, spec, strength = 1) {
  const p = geo?.attributes?.position;
  if (!p) return geo;
  const n = p.count;
  const col = new Float32Array(n * 3);
  const s = spec.style;
  const sillY = (s.sillY ?? 0.3) + (s.groundY ?? 0.1);
  const archs = [s.archF?.z ?? 1.4, s.archR?.z ?? -1.4];
  for (let i = 0; i < n; i++) {
    const x = p.getX(i);
    const y = p.getY(i);
    const z = p.getZ(i);
    // Height falloff: everything below the sill is filthy, fading out by the
    // shoulder line.
    let d = smoothstep(sillY + 0.55, sillY - 0.12, y);
    // Spray fan behind each wheel: strongest just aft of the arch.
    for (const az of archs) {
      const dz = az - z;
      if (dz > 0 && dz < 1.15) {
        d += (1 - dz / 1.15) * 0.55 * smoothstep(sillY + 0.9, sillY - 0.1, y);
      }
    }
    // Horizontal surfaces stay cleaner than vertical ones (rain washes them).
    d *= 0.55 + 0.45 * Math.min(1, Math.abs(x) / (s.hwMax ?? 1));
    d = Math.min(1, d) * 0.34 * strength;
    const v = 1 - d;
    col[i * 3] = v;
    col[i * 3 + 1] = v * (1 - d * 0.06);
    col[i * 3 + 2] = v * (1 - d * 0.13);
  }
  geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
  return geo;
}

/**
 * THE WEAR MASKS — where a rustbelt car actually rots.
 *
 * `bakeGrime` above writes a MULTIPLY-ONLY vertex colour, and that is all the
 * weathering these cars have ever had. Multiply can darken and nothing else, so
 * it cannot express road salt (a pale bloom that LIGHTENS), rust (an orange
 * that is not a darker version of the paint) or a replacement panel (a small
 * hue shift). This writes three MASKS instead and lets the fragment shader in
 * `paint.js` do the compositing, where adding and hue-shifting are possible.
 *
 *   aWear.x  road film — the spray fan behind each arch, the sill band, the
 *            streaks the rain pulls down the doors
 *   aWear.y  rust — Pittsburgh salts its roads. Steel rots from the INSIDE out
 *            and it always starts in the same four places: the arch lips (stone
 *            chips let water in), the sill below the door seal (where the drain
 *            holes block), the bottom edge of every door, and the seam under the
 *            boot lid. Scattering rust uniformly over a body is the tell of a
 *            procedural car; putting it exactly here is what a photograph shows.
 *   aWear.z  panel id — constant across a whole panel so a repaired door shifts
 *            as one piece. Quantised on z, split by side, so the two doors on
 *            one flank get different ids and the two on opposite flanks do too.
 *
 * The masks are LIKELIHOODS, not amounts: the shader scales them by the
 * finish's own `owWearP`, so the same geometry is a clean company car in gloss
 * and a rotting beater in primer without a second bake.
 */
function bakeWear(geo, spec, scale = 1) {
  const p = geo?.attributes?.position;
  if (!p) return geo;
  const n = p.count;
  const w = new Float32Array(n * 3);
  const s = spec.style;
  const g = s.groundY ?? 0.1;
  const sillY = (s.sillY ?? 0.3) + g;
  const archF = s.archF ?? { z: 1.4, r: 0.42 };
  const archR = s.archR ?? { z: -1.4, r: 0.42 };
  const archY = (s.archF?.y ?? sillY - 0.1);
  const hw = s.hwMax ?? 1;
  const splits = s.doorSplit ?? [];

  for (let i = 0; i < n; i++) {
    const x = p.getX(i);
    const y = p.getY(i);
    const z = p.getZ(i);

    // ---- road film ------------------------------------------------------
    // A TIGHT band on the lower body, not a gradient over the whole flank.
    // The first cut ran this from the sill to 72 cm above it, which on a low
    // car reaches the bonnet — the result was a uniformly filthy vehicle, which
    // is exactly as wrong as a uniformly clean one and much uglier. Spray comes
    // off a tyre and lands within about 35 cm of the sill.
    let film = smoothstep(sillY + 0.36, sillY - 0.10, y);
    // Spray fan behind each arch, strongest just aft of the opening.
    for (const az of [archF.z, archR.z]) {
      const dz = az - z;
      if (dz > 0 && dz < 1.15) {
        film += (1 - dz / 1.15) * 0.5 * smoothstep(sillY + 0.60, sillY - 0.08, y);
      }
    }
    // Verticals hold film; horizontals are rinsed by the rain.
    film *= 0.42 + 0.58 * Math.min(1, Math.abs(x) / hw);
    // ...except the very back panel, which collects the low-pressure wake and
    // is the dirtiest surface on any hatchback in the wet.
    if (z < archR.z - 0.5) film += 0.28 * smoothstep(sillY + 0.95, sillY + 0.05, y);

    // ---- rust -----------------------------------------------------------
    // Arch lips: within ~9 cm of the opening's rim, all the way round.
    let rust = 0;
    for (const a of [archF, archR]) {
      const d = Math.hypot(z - a.z, y - archY) - (a.r ?? 0.42);
      // A 7 cm lip, not a 15 cm annulus: the first cut swallowed the whole
      // arch flare and turned every wheel arch on every car solid brown.
      if (d > -0.01 && d < 0.07) rust = Math.max(rust, (1 - Math.abs(d - 0.03) / 0.045) * 0.8);
    }
    // Sill band: a hard 10 cm strip under the door seal, not a soft gradient.
    // Rot has an edge in real life because the seam has an edge.
    const sill = 1 - Math.min(1, Math.abs(y - (sillY - 0.03)) / 0.10);
    rust = Math.max(rust, sill * 0.9 * Math.min(1, Math.abs(x) / (hw * 0.7)));
    // Bottom edge of each door, and the rear valance seam.
    if (splits.length >= 1 && z < splits[0] + 0.1 && z > splits[splits.length - 1] - 0.9) {
      rust = Math.max(rust, smoothstep(sillY + 0.22, sillY + 0.02, y) * 0.55);
    }
    if (z < archR.z - 0.65) rust = Math.max(rust, smoothstep(sillY + 0.34, sillY - 0.05, y) * 0.6);
    // Nothing rots on the roof, and nothing rots on a bonnet. Rot lives in the
    // bottom 30 cm of a car because that is where the water sits.
    rust *= smoothstep(sillY + 0.48, sillY + 0.06, y);

    // ---- panel id -------------------------------------------------------
    // Quantise z on the door splits where there are any, otherwise on a coarse
    // 0.9 m grid, and fold the side in so left and right differ.
    let band = Math.floor((z + 6) / 0.9);
    for (let k = 0; k < splits.length; k++) if (z < splits[k]) band += 3 * (k + 1);
    const pid = ((band * 7 + (x < 0 ? 3 : 11)) % 17) / 17;

    w[i * 3] = Math.min(1, film) * scale;
    w[i * 3 + 1] = Math.max(0, Math.min(1, rust)) * scale;
    w[i * 3 + 2] = pid;
  }
  geo.setAttribute('aWear', new THREE.BufferAttribute(w, 3));
  return geo;
}

function smoothstep(a, b, x) {
  const t = Math.max(0, Math.min(1, (x - a) / (b - a || 1e-6)));
  return t * t * (3 - 2 * t);
}

/**
 * A door panel is skinned on both sides off one paint material — one draw call
 * instead of two — so the INNER card is darkened through the same multiply-only
 * vertex colour that carries the road film. Inward-facing vertices are the ones
 * whose normal points back towards the car's centreline.
 */
function darkenInnerFaces(geo, side) {
  const p = geo?.attributes?.position;
  const n = geo?.attributes?.normal;
  const c = geo?.attributes?.color;
  if (!p || !n || !c) return geo;
  for (let i = 0; i < p.count; i++) {
    // side = -1 is the left flank, whose OUTWARD normal points to -x.
    if (n.getX(i) * side > -0.25) continue;
    c.setXYZ(i, c.getX(i) * 0.30, c.getY(i) * 0.28, c.getZ(i) * 0.27);
  }
  c.needsUpdate = true;
  return geo;
}

/* ------------------------------------------------------------------ */

/**
 * Build one vehicle's scene graph.
 *
 * @returns {{ root, lodGroups, wheels, lampMats, paintMat, panels, bounds }}
 */
export function buildVehicleModel(spec, mats, opts = {}) {
  const { paint, finish = 'gloss', flake = 0.5, wear = 0, plate = 'DCB 000', livery = null, rimStyle } = opts;
  const paintMat = mats.paint(paint, { finish, flake, wear, clearcoat: finish === 'gloss' ? 1 : 0.2 });
  const plateMat = mats.plate(plate);
  const rimMat = mats.rim(rimStyle ?? (spec.wheel.style === 'steel' || spec.wheel.style === 'lorry' ? 'steel' : 'alloy'));

  const root = new THREE.Group();
  root.name = `vehicle_${spec.id}`;
  const bodyRoot = new THREE.Group();
  bodyRoot.position.y = -spec.comY;
  root.add(bodyRoot);

  const lampMats = {};
  const lampKind = (k) => (lampMats[k] = lampMats[k] ?? mats.lamp(k));

  // Sparse: a slot stays null until something actually asks to SEE that level.
  const lodGroups = new Array(LOD_COUNT).fill(null);
  const panels = [];
  const glassMeshes = [];
  /** Hinged door pivots, materialised with LOD0. See `VehicleSystem.setDoor`. */
  const doors = [];
  /** Rotor pivots — the helicopter's, and nothing else's. */
  const rotors = [];
  /** Turret pivots — the tank's. `{ pivot, gun, lod }` per materialised LOD. */
  const turrets = [];
  // Anchors are read off the cached LOD0 geometry, which costs nothing to look
  // up; LOD0's meshes are NOT built just to get them.
  const anchors = geometryFor(spec, 0).anchors;

  const buildBodyLod = (lod) => {
    const e = geometryFor(spec, lod);
    const g = new THREE.Group();
    g.name = `lod${lod}`;
    g.visible = false;
    bodyRoot.add(g);

    const add = (geo, mat, name, extra) => {
      if (!geo?.attributes?.position || geo.attributes.position.count === 0) return null;
      const m = new THREE.Mesh(geo, mat);
      m.name = name;
      m.matrixAutoUpdate = false;
      m.updateMatrix();
      if (extra) Object.assign(m, extra);
      g.add(m);
      return m;
    };

    const body = e.body;
    const pm = add(body.paint, paintMat, 'paint');
    if (pm) panels.push({ mesh: pm, lod });
    add(body.trim, mats.trim('dark'), 'trim');
    add(body.chrome, mats.chrome(), 'chrome');
    add(body.cavity, mats.cavity(), 'cavity');
    add(body.grilleMesh, mats.grilleMesh(), 'grille');
    add(body.plate, plateMat, 'plate');
    add(body.disc, mats.disc(), 'discs');
    add(body.seat, mats.seat(), 'seats');
    add(body.leather, mats.leather(), 'leather');
    add(body.dash, mats.dash(), 'dash');
    if (livery) {
      const lv = liveryPanels(spec, mats.livery(livery));
      if (lv && lod < 2) g.add(lv);
    }
    for (const k in body.lamps) {
      const m = add(body.lamps[k], lampKind(k), `lamp_${k}`);
      if (m) m.userData.owNoShadow = true;
    }
    const gm = add(body.glass, mats.glass(), 'glass', { renderOrder: 3 });
    if (gm) {
      gm.userData.owNoShadow = true;
      gm.userData.owNoPrepass = true;
      glassMeshes.push(gm);
    }
    // ---- doors ------------------------------------------------------------
    // A pivot group at the hinge with the panel translated back into it, so the
    // geometry stays in body space and can be shared by every instance of the
    // class while each car swings its own door.
    for (const d of e.doors ?? []) {
      if (!d.geo?.attributes?.position?.count) continue;
      const pivot = new THREE.Group();
      pivot.name = `doorPivot_${d.side < 0 ? 'l' : 'r'}`;
      pivot.position.set(d.hinge.x, d.hinge.y, d.hinge.z);
      const m = new THREE.Mesh(d.geo, paintMat);
      m.name = `door_${d.side < 0 ? 'l' : 'r'}`;
      m.position.set(-d.hinge.x, -d.hinge.y, -d.hinge.z);
      m.matrixAutoUpdate = false;
      m.updateMatrix();
      pivot.add(m);
      g.add(pivot);
      doors.push({ pivot, mesh: m, side: d.side, lod });
    }

    // ---- rotors ----------------------------------------------------------
    // A pivot per rotor at the hub, spun by `Vehicle.syncTransforms` off the
    // governor's phase. Registered per LOD so a level built later still turns.
    for (const r of e.rotors ?? []) {
      if (!r.geo?.attributes?.position?.count) continue;
      const pivot = new THREE.Group();
      pivot.name = `rotor_${r.axis}`;
      pivot.position.set(r.pos[0], r.pos[1], r.pos[2]);
      const m = new THREE.Mesh(r.geo, mats.trim('dark'));
      m.name = `rotorBlades_${r.axis}`;
      pivot.add(m);
      g.add(pivot);
      rotors.push({ pivot, mesh: m, axis: r.axis, lod });
    }

    // ---- turret ----------------------------------------------------------
    // Two nested pivots: the ring traverses about y, the gun elevates about x
    // at the trunnion inside it. `Vehicle.syncTransforms` drives both off
    // `turretYaw`/`gunPitch`, per LOD, exactly like the rotors above.
    if (e.turret) {
      const t = e.turret;
      const ring = new THREE.Group();
      ring.name = 'turretRing';
      ring.position.set(t.pos[0], t.pos[1], t.pos[2]);
      // Deliberately NOT in `panels`: `DamageModel.dent` displaces vertices in
      // BODY space, and this mesh lives inside a rotating pivot — a dent
      // stamped while the turret was traversed would land on the wrong face.
      // Forty-five tonnes of armour not showing small-arms dents is correct.
      const shell = new THREE.Mesh(t.geo, paintMat);
      shell.name = 'turret';
      shell.matrixAutoUpdate = false;
      shell.updateMatrix();
      ring.add(shell);
      const trunnion = new THREE.Group();
      trunnion.name = 'gunTrunnion';
      trunnion.position.set(t.gun.pos[0], t.gun.pos[1], t.gun.pos[2]);
      const barrel = new THREE.Mesh(t.gun.geo, mats.trim('dark'));
      barrel.name = 'gun';
      trunnion.add(barrel);
      ring.add(trunnion);
      g.add(ring);
      turrets.push({ pivot: ring, gun: trunnion, mesh: shell, lod });
    }

    if (lod >= 2) for (const c of g.children) c.userData.owNoShadow = lod === 3;
    lodGroups[lod] = g;
    return g;
  };

  // ---- wheels ------------------------------------------------------------
  const wheels = [];
  if (spec.kind !== 'boat' && spec.kind !== 'heli' && spec.kind !== 'plane' &&
      spec.kind !== 'tram') {
    for (const hp of spec.wheels) {
      const node = new THREE.Group();
      node.name = `wheel${hp.index}`;
      node.position.set(hp.x, hp.top - hp.staticLen, hp.z);
      root.add(node);
      const spin = new THREE.Group();
      node.add(spin);
      const lods = new Array(LOD_COUNT).fill(null);
      const buildWheelLod = (lod) => {
        const e = geometryFor(spec, lod);
        const gw = new THREE.Group();
        gw.visible = false;
        gw.rotation.y = hp.x < 0 ? Math.PI : 0;
        spin.add(gw);
        const wg = e.wheel;
        if (wg) {
          if (wg.rubber?.attributes?.position?.count) {
            const m = new THREE.Mesh(wg.rubber, lod >= 2 ? mats.trim('dark') : mats.rubber());
            m.matrixAutoUpdate = false;
            m.updateMatrix();
            if (lod === 3) m.userData.owNoShadow = true;
            gw.add(m);
          }
          if (wg.rim?.attributes?.position?.count) {
            const m = new THREE.Mesh(wg.rim, rimMat);
            m.matrixAutoUpdate = false;
            m.updateMatrix();
            gw.add(m);
          }
          if (wg.disc?.attributes?.position?.count) {
            const m = new THREE.Mesh(wg.disc, mats.disc());
            m.matrixAutoUpdate = false;
            m.updateMatrix();
            gw.add(m);
          }
          if (wg.caliper?.attributes?.position?.count) {
            const m = new THREE.Mesh(wg.caliper, mats.caliper(spec.wheel.caliper));
            m.matrixAutoUpdate = false;
            m.updateMatrix();
            gw.add(m);
          }
        }
        lods[lod] = gw;
        // Dual rear wheels on the truck: a second tyre outboard. Only LOD0
        // carries it, so it is built with LOD0 rather than at spawn.
        if (lod === 0 && spec.wheel.dually && !hp.front) {
          const outer = new THREE.Group();
          outer.position.x = Math.sign(hp.x) * spec.wheel.width * 1.02;
          outer.rotation.y = hp.x < 0 ? Math.PI : 0;
          if (e.wheel?.rubber) {
            const m = new THREE.Mesh(e.wheel.rubber, mats.rubber());
            m.matrixAutoUpdate = false;
            m.updateMatrix();
            outer.add(m);
          }
          if (e.wheel?.rim) {
            const m = new THREE.Mesh(e.wheel.rim, rimMat);
            m.matrixAutoUpdate = false;
            m.updateMatrix();
            outer.add(m);
          }
          spin.add(outer);
          gw.userData.dually = outer;
        }
        return gw;
      };
      wheels.push({ node, spin, lods, hp, build: buildWheelLod });
    }
  }

  const bounds = new THREE.Box3(
    new THREE.Vector3(-spec.half.x, -spec.comY, -spec.half.z),
    new THREE.Vector3(spec.half.x, spec.dims.H - spec.comY, spec.half.z)
  );

  const model = {
    root, bodyRoot, lodGroups, wheels, lampMats, paintMat, panels, glassMeshes,
    doors, rotors, turrets, bounds, anchors, buildBodyLod, lod: -1,
  };
  // Nothing is materialised yet. `setVehicleLod` builds the first level the
  // moment the LOD selector picks one, which is on the vehicle's first update.
  return model;
}

/**
 * Show exactly one LOD, materialising it on first use.
 *
 * THE BUG THIS FIXES. `buildVehicleModel` used to build all four levels as real
 * meshes at spawn and hang them all off the root with one level `visible`. That
 * is ~57 `THREE.Mesh` nodes per car of which at most eleven are ever submitted.
 * `tools/drawbreak.mjs` measured 3042 vehicle mesh nodes against 337k triangles
 * — the largest object population in the game, bigger than every building put
 * together, and the single reason the adaptive governor collapsed the whole game
 * to the `low` preset and still only reached 26 fps. Hidden nodes are not free:
 * the scene walk, the cull book-keeping and the shadow-caster gather all still
 * touch them every frame.
 *
 * Levels are never RELEASED once built, deliberately. `damage.js` holds direct
 * references to panel meshes through copy-on-write geometry, so tearing a level
 * down under it would either lose dents or need a pinning protocol across two
 * subsystems. Never releasing means a car that drives from the horizon to your
 * bumper ends up with the same node count it used to have — but a traffic car
 * that lives its whole life at 200 m now costs FOUR nodes instead of fifty-seven,
 * and that is the overwhelming majority of them.
 */
export function setVehicleLod(model, lod) {
  if (!model || model.lod === lod) return;
  if (!model.lodGroups[lod]) model.buildBodyLod(lod);
  for (let l = 0; l < LOD_COUNT; l++) {
    const g = model.lodGroups[l];
    if (g) g.visible = l === lod;
  }
  for (const w of model.wheels) {
    if (!w.lods[lod]) w.build(lod);
    for (let l = 0; l < LOD_COUNT; l++) {
      const g = w.lods[l];
      if (g) g.visible = l === lod;
    }
  }
  model.lod = lod;
}

function liveryPanels(spec, mat) {
  const s = spec.style;
  const g = new THREE.Group();
  const splits = s.doorSplit ?? [];
  const z = splits.length >= 2 ? (splits[0] + splits[1]) * 0.5 : s.archF.z - 0.9;
  for (const side of [-1, 1]) {
    const p = new THREE.PlaneGeometry(1.5, 0.52);
    const m = new THREE.Mesh(p, mat);
    m.position.set(side * (s.hwMax + 0.012), s.creaseY + 0.12, z);
    m.rotation.y = side * Math.PI * 0.5;
    m.scale.z = side;
    m.userData.owNoShadow = true;
    g.add(m);
  }
  // bonnet
  const bp = new THREE.PlaneGeometry(0.9, 0.36);
  const bm = new THREE.Mesh(bp, mat);
  bm.position.set(0, s.cowlY + 0.02, s.archF.z + 0.3);
  bm.rotation.x = -Math.PI / 2;
  bm.userData.owNoShadow = true;
  g.add(bm);
  return g;
}

export function modelStats(spec) {
  let tris = 0;
  for (let lod = 0; lod < LOD_COUNT; lod++) {
    const e = geometryFor(spec, lod);
    for (const k in e.body) {
      if (k === 'lamps') {
        for (const l in e.body.lamps) tris += safeTris(e.body.lamps[l]);
      } else tris += safeTris(e.body[k]);
    }
  }
  const e0 = geometryFor(spec, 0);
  let lod0 = 0;
  for (const k in e0.body) {
    if (k === 'lamps') for (const l in e0.body.lamps) lod0 += safeTris(e0.body.lamps[l]);
    else lod0 += safeTris(e0.body[k]);
  }
  for (const d of e0.doors ?? []) { lod0 += safeTris(d.geo); tris += safeTris(d.geo); }
  for (const r of e0.rotors ?? []) { lod0 += safeTris(r.geo); tris += safeTris(r.geo); }
  if (e0.turret) {
    const t = safeTris(e0.turret.geo) + safeTris(e0.turret.gun.geo);
    lod0 += t; tris += t;
  }
  if (e0.wheel) lod0 += (safeTris(e0.wheel.rubber) + safeTris(e0.wheel.rim) + safeTris(e0.wheel.disc)) * 4;
  return { allLods: tris, lod0 };
}

function safeTris(g) {
  return g?.attributes?.position?.count ? triCount(g) : 0;
}

export { LOD_COUNT };
