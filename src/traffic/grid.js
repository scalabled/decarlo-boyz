/**
 * TRAFFIC — uniform-grid broadphase over live vehicles.
 *
 * Rebuilt once per control tick from `vehicles.vehicles`. Every driver then
 * asks for the handful of cars inside its own sensing radius instead of walking
 * the whole list, which keeps the neighbour cost O(n) rather than O(n^2) once
 * `police` starts adding cruisers on top of the traffic budget.
 *
 * Results land in a shared, preallocated index buffer — drivers run one at a
 * time, so a single buffer is enough and nothing allocates per frame.
 */

const CELL = 26;
const CAP = 640;

export class VehicleGrid {
  constructor(cap = CAP) {
    this._cells = new Map();
    this._free = [];
    this.list = [];
    /** Query results: indices into `this.list`. */
    this.hits = new Int32Array(cap);
    this.count = 0;
  }

  clear() {
    for (const arr of this._cells.values()) {
      arr.length = 0;
      this._free.push(arr);
    }
    this._cells.clear();
    this.list.length = 0;
  }

  /** Rebuild from a vehicle array. Vehicles are stored by index into `list`. */
  build(vehicles) {
    this.clear();
    const n = Math.min(vehicles.length, this.hits.length);
    for (let i = 0; i < n; i++) {
      const v = vehicles[i];
      if (!v) continue;
      const idx = this.list.length;
      this.list.push(v);
      const key = this._key(v.position.x, v.position.z);
      let arr = this._cells.get(key);
      if (!arr) {
        arr = this._free.pop() ?? [];
        this._cells.set(key, arr);
      }
      arr.push(idx);
    }
    return this.list.length;
  }

  _key(x, z) {
    return (Math.floor(x / CELL) * 73856093) ^ (Math.floor(z / CELL) * 19349663);
  }

  /**
   * Fill `hits`/`count` with every vehicle within `r` of (x,z), excluding
   * `skip` (a Vehicle) when given.
   */
  query(x, z, r, skip = null) {
    this.count = 0;
    const rings = Math.max(1, Math.ceil(r / CELL));
    const cx = Math.floor(x / CELL);
    const cz = Math.floor(z / CELL);
    const r2 = r * r;
    for (let dz = -rings; dz <= rings; dz++) {
      for (let dx = -rings; dx <= rings; dx++) {
        const arr = this._cells.get(((cx + dx) * 73856093) ^ ((cz + dz) * 19349663));
        if (!arr) continue;
        for (let i = 0; i < arr.length; i++) {
          const idx = arr[i];
          const v = this.list[idx];
          if (v === skip) continue;
          const ex = v.position.x - x;
          const ez = v.position.z - z;
          if (ex * ex + ez * ez > r2) continue;
          if (this.count >= this.hits.length) return this.count;
          this.hits[this.count++] = idx;
        }
      }
    }
    return this.count;
  }
}
