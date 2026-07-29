import * as THREE from 'three';
import { triCount } from '../geometry.js';

/**
 * Turn a model description (`Assembly` buckets + nodes) into a live Object3D.
 *
 * Shared by the third-person rig, the holster proxies and the standalone
 * preview page, so all three see exactly the same geometry, the same materials
 * and the same vertex masks — a weapon that looks right in the preview and
 * wrong in the game is a bug in this function, not in the model.
 *
 * WHAT IT DOES BEYOND `new THREE.Mesh`:
 *
 *  1. **Bakes curvature vertex masks.** `materials.bakeMasks` writes a convexity
 *     ramp into vColor (wear / grime / AO) and every improvised material rides
 *     it: chips on the paint, bright steel on the wrench jaw, grease in the
 *     crevices. Without it every part is uniformly clean and the whole set
 *     reads as untextured plastic.
 *  2. **Re-shapes those masks.** bakeMasks' ramp is LINEAR, which is right for
 *     architecture (a wall has interior vertices for it to fall off against)
 *     and wrong for chamfered hard-surface geometry, which has none — the ramp
 *     runs from the chamfer to the middle of the panel and the whole face reads
 *     as worn. Raising the exponent collapses it back onto the outer millimetre
 *     or two, which is the only place a real object polishes through. This is
 *     the same fix the inherited viewmodel found the expensive way; the
 *     amplitudes differ because a scavenged tool wears far harder than a rifle.
 *  3. **Buckets by material.** A whole weapon lands in 5-9 draw calls.
 */

/** Per-material-family mask shaping. Scavenged things wear hard. */
const MASK_SHAPE = {
  /* Paint chips: the highest wear amplitude in the game. A chipped enamel edge
   * is not a subtle effect — it is 40% of what makes the crowbar read. */
  paint: { wearAmp: 1.0, wearExp: 2.2, grimeAmp: 1.25, grimeExp: 1.2, aoAmp: 1.0, aoExp: 1.1 },
  /* Bare metal polishes on the corners and blacks up in the crevices. */
  metal: { wearAmp: 0.78, wearExp: 2.6, grimeAmp: 1.3, grimeExp: 1.15, aoAmp: 1.0, aoExp: 1.1 },
  /* Rust is the opposite: it lives in the LOW spots, so the grime channel does
   * most of the work and the wear channel only knocks the scabs off the ridges. */
  rust: { wearAmp: 0.55, wearExp: 1.8, grimeAmp: 1.45, grimeExp: 0.95, aoAmp: 1.05, aoExp: 1.05 },
  /* Soft surfaces scuff rather than polish — low amplitude, wide falloff. */
  soft: { wearAmp: 0.44, wearExp: 3.2, grimeAmp: 1.2, grimeExp: 1.3, aoAmp: 1.0, aoExp: 1.2 },
};

function shapeFor(matKey) {
  if (matKey.startsWith('imp_paint')) return MASK_SHAPE.paint;
  if (matKey === 'imp_rust') return MASK_SHAPE.rust;
  if (matKey.startsWith('imp_tape') || matKey === 'imp_hose' || matKey === 'imp_plastic' ||
      matKey === 'imp_rope' || matKey === 'imp_canvas' || matKey === 'imp_leather' ||
      matKey === 'imp_wood') return MASK_SHAPE.soft;
  return MASK_SHAPE.metal;
}

/**
 * Re-shape the baked masks in place. (Copied deliberately rather than imported
 * from `viewmodel.js`: that module is the retired first-person rig and this one
 * must not depend on it.)
 */
export function shapeMasks(geo, o) {
  const col = geo.getAttribute('color');
  if (!col) return geo;
  const a = col.array;
  const amp = [o.wearAmp ?? 1, o.grimeAmp ?? 1, o.aoAmp ?? 1];
  const exp = [o.wearExp ?? 1, o.grimeExp ?? 1, o.aoExp ?? 1];
  for (let i = 0; i < a.length; i += 3) {
    for (let k = 0; k < 3; k++) {
      const v = a[i + k];
      a[i + k] = v <= 0 ? 0 : amp[k] * Math.pow(v > 1 ? 1 : v, exp[k]);
    }
  }
  col.needsUpdate = true;
  return geo;
}

/**
 * @param {object} model   the return value of a build*() function
 * @param {WeaponMaterials} mats
 * @param {object} opts    { rng, bakeMasks, shadows, name }
 * @returns {{ group, parts, meshes, geometries, tris }}
 */
export function instantiate(model, mats, opts = {}) {
  const group = new THREE.Object3D();
  group.name = opts.name ?? `weapon-${model.id}`;

  const meshes = [];
  const geometries = [];
  let tris = 0;
  const bake = opts.bakeMasks ?? null;
  const rng = opts.rng ?? null;

  const build = (asm, parent) => {
    if (!asm) return;
    const map = asm.build();
    for (const [matKey, geo] of map) {
      const emissive = matKey.startsWith('glow_');
      if (bake && !emissive) {
        bake(geo, { wear: 1, grime: 1, ao: 1, edgeThreshold: 0.16, rng });
        shapeMasks(geo, shapeFor(matKey));
      }
      const mesh = new THREE.Mesh(geo, mats.get(matKey));
      mesh.name = `${asm.name}-${matKey}`;
      /* A weapon in a hand is a world object: it casts into the cascades and
       * receives them (receivers are unconditional — see ARCHITECTURE.md). An
       * emitter casts nothing: a flare tip that casts a shadow renders a hard
       * black core inside its own glow. */
      mesh.castShadow = !emissive && opts.shadows !== false;
      if (emissive) {
        mesh.userData.owNoShadow = true;
        mesh.userData.owNoPrepass = true;
        mesh.renderOrder = 3;
      }
      /* The weapon is small, animated every frame and always near the camera;
       * per-mesh frustum culling on a 12 cm part parented six transforms deep
       * costs more than it saves and pops on fast turns. */
      mesh.frustumCulled = false;
      parent.add(mesh);
      meshes.push(mesh);
      geometries.push(geo);
      tris += triCount(geo);
    }
  };

  build(model.body, group);

  const parts = {};
  for (const [name, asm] of Object.entries(model.moving ?? {})) {
    const sub = new THREE.Object3D();
    sub.name = `${model.id}-${name}`;
    const seat = model.nodes?.[`${name}Seat`];
    if (seat) {
      sub.position.fromArray(seat.pos ?? [0, 0, 0]);
      if (seat.rot) sub.rotation.fromArray(seat.rot);
    }
    group.add(sub);
    build(asm, sub);
    parts[name] = sub;
  }

  return { group, parts, meshes, geometries, tris };
}

/** Free everything `instantiate` created. Materials are shared and are not. */
export function disposeInstance(inst) {
  if (!inst) return;
  for (const g of inst.geometries) g.dispose();
  inst.geometries.length = 0;
  inst.meshes.length = 0;
  inst.group.removeFromParent();
}
