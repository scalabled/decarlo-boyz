import * as THREE from 'three';

/**
 * Where the fog pools.
 *
 * DESIGN.md asks for fog that sits in the river valleys at dawn and clings
 * BELOW the Mt. Washington clifftop. Two independent things have to be true for
 * that, and each is handled in a different place:
 *
 *   vertically    the ground fog already has an exponential height profile with
 *                 an absolute base, so a 130 m clifftop is four e-foldings up
 *                 and sits above the layer for free. Nothing to do here.
 *   horizontally  fog forms over water and drains downhill into the valley
 *                 floor. That is a property of the TERRAIN, and the sky has no
 *                 business knowing the terrain — so it asks `world` for it once
 *                 and bakes the answer into a small texture.
 *
 * The bake is amortised over frames because `world.heightAt` is a real query
 * (the new world may sample a noise stack or a heightfield) and a 128x128 grid
 * is sixteen thousand of them. Eight rows a frame finishes in two seconds and
 * costs nothing measurable on any of them.
 *
 * Everything is guarded. `world` is being rewritten in parallel, so this runs
 * against whichever of `heightAt` / `groundHeight` / `isWater` / `CITY_SIZE`
 * happens to exist, and falls back to a uniform field — which is the correct
 * degenerate answer for a map with no valleys in it.
 */

const SIZE = 128;
const ROWS_PER_FRAME = 8;
/** Metres of altitude above the valley floor over which the fog thins out. */
const VALLEY_SPAN = 55;

export class ValleyFog {
  constructor(shared) {
    this.shared = shared;
    this.size = SIZE;
    this.data = new Uint8Array(SIZE * SIZE * 4);
    this.height = new Float32Array(SIZE * SIZE);
    // Uniform field until the world answers: a map with no terrain query is a
    // map with no valleys, and a flat 1 is exactly right for that.
    this.data.fill(255);

    this.texture = new THREE.DataTexture(this.data, SIZE, SIZE, THREE.RGBAFormat);
    this.texture.name = 'sky-valley-fog';
    this.texture.minFilter = THREE.LinearFilter;
    this.texture.magFilter = THREE.LinearFilter;
    this.texture.wrapS = THREE.ClampToEdgeWrapping;
    this.texture.wrapT = THREE.ClampToEdgeWrapping;
    this.texture.needsUpdate = true;
    shared.uValleyMap.value = this.texture;

    this.extent = 3000;
    this.origin = -1500;
    this._row = 0;
    this._state = 'idle'; // idle -> sampling -> reducing -> done
    this._minH = Infinity;
    this._checkAccum = 0;
  }

  /** Kick a rebuild (world streamed in, or the city changed size). */
  rebuild(extent) {
    this.extent = extent;
    this.origin = -extent * 0.5;
    this._row = 0;
    this._minH = Infinity;
    this._state = 'sampling';
    this.shared.uValleyRect.value.set(this.origin, this.origin, 1 / extent, extent);
  }

  update(ctx) {
    if (this._state === 'idle') {
      // Poll cheaply for the world becoming queryable. Once a second is plenty:
      // the first ring of tiles takes longer than that to stream in anyway.
      this._checkAccum += 1;
      if (this._checkAccum < 60) return;
      this._checkAccum = 0;
      const w = ctx.peek('world');
      if (!w) return;
      if (!w.heightAt && !w.groundHeight && !w.isWater) return;
      this.rebuild(w.CITY_SIZE ?? w.bounds?.max?.x * 2 ?? 3000);
      return;
    }
    if (this._state === 'sampling') this._sample(ctx);
    else if (this._state === 'reducing') this._reduce();
  }

  _sample(ctx) {
    const w = ctx.peek('world');
    if (!w) {
      this._state = 'idle';
      return;
    }
    const heightAt = w.heightAt?.bind(w) ?? w.groundHeight?.bind(w) ?? null;
    const isWater = w.isWater?.bind(w) ?? null;
    const step = this.extent / (SIZE - 1);
    const end = Math.min(SIZE, this._row + ROWS_PER_FRAME);

    for (let j = this._row; j < end; j++) {
      const z = this.origin + j * step;
      for (let i = 0; i < SIZE; i++) {
        const x = this.origin + i * step;
        const k = j * SIZE + i;
        let h = heightAt ? heightAt(x, z) : 0;
        if (!Number.isFinite(h)) h = 0;
        // Water is the fog's source: mark it by pushing the sampled height well
        // under the valley floor so the affinity saturates there.
        if (isWater && isWater(x, z)) h -= VALLEY_SPAN;
        this.height[k] = h;
        if (h < this._minH) this._minH = h;
      }
    }
    this._row = end;
    if (this._row >= SIZE) {
      this._row = 0;
      this._state = 'reducing';
    }
  }

  _reduce() {
    const base = Number.isFinite(this._minH) ? this._minH : 0;
    const d = this.data;
    const h = this.height;
    // Affinity, then one separable box blur. The blur is not cosmetic: an
    // unsmoothed field puts a hard edge along every contour line, and a fog
    // density with a hard edge in it reads as a decal on the ground.
    for (let k = 0; k < SIZE * SIZE; k++) {
      const t = THREE.MathUtils.clamp(1 - (h[k] - base) / VALLEY_SPAN, 0, 1);
      // Squared: fog does not fill a valley linearly, it fills the bottom of it.
      d[k * 4] = Math.round(t * t * 255);
    }
    for (let j = 0; j < SIZE; j++) {
      for (let i = 0; i < SIZE; i++) {
        let s = 0;
        let n = 0;
        for (let o = -2; o <= 2; o++) {
          const ii = i + o;
          if (ii < 0 || ii >= SIZE) continue;
          s += d[(j * SIZE + ii) * 4];
          n++;
        }
        d[(j * SIZE + i) * 4 + 1] = Math.round(s / n);
      }
    }
    for (let j = 0; j < SIZE; j++) {
      for (let i = 0; i < SIZE; i++) {
        let s = 0;
        let n = 0;
        for (let o = -2; o <= 2; o++) {
          const jj = j + o;
          if (jj < 0 || jj >= SIZE) continue;
          s += d[(jj * SIZE + i) * 4 + 1];
          n++;
        }
        d[(j * SIZE + i) * 4] = Math.round(s / n);
      }
    }
    this.texture.needsUpdate = true;
    this._state = 'done';
  }

  dispose() {
    this.texture.dispose();
  }
}
