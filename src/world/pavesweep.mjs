#!/usr/bin/env node
/**
 * WORLD — "does the pavement read as a pavement?" assertion.
 *
 * The footway used to read as a set of disconnected, ragged polygon shards
 * lying across the carriageway at varying heights: every junction corner in the
 * city built its kerb and footway as a RADIAL
 * extrusion of the junction boundary, which is not a parallel offset of a
 * straight kerb line, so the corner never met the straight run it was supposed
 * to continue. See `_place` in `roadmesh.js`.
 *
 * WHY THIS GATE LOOKS AT TRIANGLES AND NOT AT THE ROAD GRAPH.
 *
 * The obvious invariant — "compute where the footway should be from the graph,
 * then check the builder put it there" — is worthless, because it is the same
 * arithmetic on both sides of the equals sign. A previous probe in this area
 * did exactly that and reported a 34.4% defect rate that turned out to be its
 * own measurement artefact (the real figure was 1.14%), and `buildings` shipped
 * an invariant that re-sampled terrain at the placer's own x/z and passed while
 * 53 of 57 impostors hung in the air. So everything below is measured on the
 * EMITTED `road_walk_*` / `road_kerb_*` triangles: their own vertices, their own
 * connectivity, their own heights. The road graph is used only to say where a
 * lane is — the one fact the footway geometry does not contain.
 *
 * Four assertions:
 *
 *   intrusion   no footway or kerb triangle whose centre lies inside a lane a
 *               driver may legally use
 *   fragments   the footway must be a few large connected surfaces, not a
 *               confetti of small ones. This is the shard defect, measured
 *               directly: union-find over the emitted triangles, welded by
 *               position, and the share of footway AREA sitting in a component
 *               under `--minpiece` square metres
 *   steps       no vertical discontinuity greater than one kerb height between
 *               neighbouring footway samples, and no two layers of footway
 *               stacked at the same place
 *   kerbheight  every emitted kerb face, measured as the rise between the two
 *               coincident-in-plan vertices that make it, within tolerance of
 *               the authored KERB_H (allowing settle, chipping and the dropped
 *               kerb at a junction mouth)
 *
 * WHAT THIS GATE CANNOT SEE, AND WHERE THAT IS COVERED INSTEAD.
 *
 * All five assertions are measures of the footway triangles that ARE THERE.
 * None of them can see an ABSENCE: a lattice cell with no footway is simply not
 * a cell, so a strip `roadmesh` declined to emit contributes to no numerator
 * and no denominator anywhere above. This gate reported ALL CHECKS PASSED with
 * 0.02% intrusion and 1.90% steps on the build where a player fell into a
 * 0.70 m trench between two pavements and could not climb out.
 *
 * The absence is `src/physics/walksweep.mjs`'s job. It walks a real
 * `CharacterController` down the emitted pavement and counts what happens to
 * it, at the scale of the 0.32 m capsule rather than the 0.5 m lattice. Run
 * both: this one says the pavement is shaped like a pavement, that one says a
 * man can walk on it, and neither implies the other.
 *
 * Usage
 *   node src/world/pavesweep.mjs
 *   node src/world/pavesweep.mjs --json=/tmp/pave.json
 *   node src/world/pavesweep.mjs --sites=downtown,lawrenceville
 *   OW_PAVE_LEGACY=1 node src/world/pavesweep.mjs     the negative control:
 *                                                     restores the radial
 *                                                     fillet and must go RED
 *
 * Exit code 1 on any failed assertion.
 */

import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import net from 'node:net';

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const m = a.match(/^--([^=]+)(?:=(.*))?$/);
    return m ? [m[1], m[2] ?? true] : [a, true];
  })
);

/** Sites are chosen for road-network variety, not for looks. */
const SITES = [
  { id: 'downtown', x: -232, z: 64, doc: 'Golden Triangle — the densest grid, on a grade' },
  { id: 'lawrenceville', x: 682, z: -548, doc: 'Lawrenceville rowhouse streets and the mill spur' },
  { id: 'strip', x: 248, z: -184, doc: 'The Strip — market blocks, alleys, rail' },
  { id: 'southside', x: 160, z: 608, doc: 'South Side — riverfront industrial, wide arterials' },
  { id: 'mtwash', x: -528, z: 464, doc: 'Mt. Washington — hillside switchbacks and dead ends' },
];
const WANT = args.sites ? String(args.sites).split(',') : null;
const sites = SITES.filter((s) => !WANT || WANT.includes(s.id));
const RADIUS = Number(args.radius ?? 190);
const MIN_PIECE = Number(args.minpiece ?? 6);
/** A footway triangle may come this close to a lane edge and no closer. */
const LANE_TOL = Number(args.lanetol ?? 0.05);

const portOpen = (port) =>
  new Promise((res) => {
    const s = net.connect({ port, host: '127.0.0.1' }, () => (s.destroy(), res(true)));
    s.on('error', () => res(false));
    s.setTimeout(400, () => (s.destroy(), res(false)));
  });

async function freePort() {
  for (let i = 0; i < 300; i++) {
    // 6000-6999 contains chromium's ERR_UNSAFE_PORT list (6000, 6665-6669, ...).
    const p = 5200 + Math.floor(Math.random() * 700);
    if (!(await portOpen(p))) return p;
  }
  throw new Error('no free port');
}

const PORT = await freePort();
const root = resolve(import.meta.dirname, '../..');
const server = spawn(resolve(root, 'node_modules/.bin/vite'), ['--port', String(PORT), '--strictPort'], {
  cwd: root,
  stdio: 'ignore',
  env: { ...process.env, OW_NO_HMR: '1' },
});
for (let i = 0; i < 200; i++) {
  await new Promise((r) => setTimeout(r, 200));
  if (await portOpen(PORT)) break;
}

const browser = await chromium.launch({
  headless: true,
  args: ['--use-angle=metal', '--ignore-gpu-blocklist', '--mute-audio', '--js-flags=--max-old-space-size=4096'],
});
const page = await browser.newPage({ viewport: { width: 480, height: 270 } });
const errors = [];
page.on('pageerror', (e) => errors.push(String(e.message).slice(0, 200)));

const LEGACY = process.env.OW_PAVE_LEGACY === '1';
let report = null;
let failure = null;
try {
  await page.goto(
    `http://127.0.0.1:${PORT}/?capture=1&lockstep=1&prewarm=0&q=high${LEGACY ? '&paveold=1' : ''}`,
    { waitUntil: 'domcontentloaded', timeout: 120000 }
  );
  await page.waitForFunction('window.__READY__ === true', null, { timeout: 180000 });

  const out = [];
  for (const s of sites) {
    await page.evaluate(async ([x, z]) => {
      const e = window.__ENGINE__;
      const w = e.ctx.peek('world');
      e.ctx.camera.position.set(x, (w.walkableHeightAt(x, z) ?? 0) + 2.2, z);
      // `lockstep=1` means frames only advance when the harness asks, and the
      // streamer only builds on a frame. Pump, or the sweep photographs an
      // empty scene and every assertion passes on nothing.
      //
      // The camera is re-pinned EVERY frame because `player` drives it: set it
      // once and the rig puts it back, the streamer never hears about the new
      // site, and the sweep silently measures 600 triangles of whatever was
      // already resident. That is exactly the shape of gate this file exists to
      // warn about, so it is worth a comment: the first cut of this loop did it
      // and reported "0 defects" for four of the five sites.
      for (let i = 0; i < 1400; i++) {
        const y = (w.walkableHeightAt(x, z) ?? 0) + 2.2;
        e.ctx.camera.position.set(x, y, z);
        e.ctx.camera.updateMatrixWorld();
        if (window.__PUMP__) window.__PUMP__(1);
        await new Promise((r) => requestAnimationFrame(r));
        if (i > 120 && window.__SETTLED__?.() === true) break;
      }
    }, [s.x, s.z]);
    const r = await page.evaluate(sweepSite, { x: s.x, z: s.z, radius: RADIUS, minPiece: MIN_PIECE, laneTol: LANE_TOL });
    out.push({ site: s.id, doc: s.doc, ...r });
  }
  report = { legacy: LEGACY, minPiece: MIN_PIECE, laneTol: LANE_TOL, radius: RADIUS, sites: out };
} catch (e) {
  failure = e;
} finally {
  await browser.close();
  server.kill();
}

if (failure) {
  console.error(`[pavesweep] FAILED: ${failure.message}`);
  if (errors.length) console.error(errors.slice(0, 8).join('\n'));
  process.exit(1);
}

/* ------------------------------------------------------------- reporting -- */

const T = report.sites;
const sum = (k) => T.reduce((a, b) => a + b[k], 0);
const walkArea = sum('walkArea');
const intrusions = sum('intrusions');
const intrusionArea = sum('intrusionArea');
const smallArea = sum('smallArea');
const steps = sum('steps');
const stacks = sum('stacks');
const kerbBad = sum('kerbBad');
const kerbFaces = sum('kerbFaces');
const cells = sum('cells');
const pieces = sum('pieces');
const worstIntrusion = T.reduce((a, b) => (b.worstIntrusion > a ? b.worstIntrusion : a), 0);

const pct = (a, b) => (b ? (100 * a) / b : 0);
const F = [];
const check = (ok, name, detail) => F.push({ ok, name, detail });

check(
  pct(intrusionArea, walkArea) < 0.25,
  'no footway in a drivable lane',
  `${intrusions} of ${sum('tris')} emitted footway/kerb triangles centre inside a lane ` +
    `(${intrusionArea.toFixed(1)} m2 of ${walkArea.toFixed(0)} m2 = ${pct(intrusionArea, walkArea).toFixed(2)}%), ` +
    `worst ${worstIntrusion.toFixed(2)} m past the lane edge`
);
const boundary = sum('boundary');
check(
  boundary / Math.max(1, walkArea) < 1.1,
  'the footway is not ragged',
  `${(boundary / Math.max(1, walkArea)).toFixed(3)} m of open boundary per m2 of footway ` +
    `(${boundary.toFixed(0)} m round ${walkArea.toFixed(0)} m2). A continuous 2.7 m strip is about 0.75.`
);
check(
  pct(smallArea, walkArea) < 4,
  'the footway is continuous, not shards',
  `${pct(smallArea, walkArea).toFixed(2)}% of footway area (${smallArea.toFixed(0)} m2) sits in a connected ` +
    `component smaller than ${MIN_PIECE} m2; ${pieces} components over ${walkArea.toFixed(0)} m2 ` +
    `(${(walkArea / Math.max(1, pieces)).toFixed(0)} m2 each, ${sum('bigPieces')} over 40 m2, ` +
    `largest ${T.reduce((a, b) => Math.max(a, b.maxPiece), 0).toFixed(0)} m2)`
);
check(
  // NOT a claim of zero. What is left after the two clips above is `netgen`'s
  // corridor-overlap residual — pairs of streets 8-14 m apart whose footways
  // graze each other at their back edges, which `dedupeCorridors` deliberately
  // leaves alone below its 60 m coverage threshold. Re-cutting the road graph
  // is a far larger change than this one and `traffic`, `police`, `peds` and
  // the minimap all key off it. The bar is set to hold the line: the negative
  // control (OW_PAVE_LEGACY=1) sits above it.
  pct(steps + stacks, cells) < 2.5,
  'no step or stacked layer in the footway',
  `${steps} neighbouring footway cells differ by more than one kerb height and ${stacks} cells carry two ` +
    `layers of footway, over ${cells} sampled cells (${pct(steps + stacks, cells).toFixed(2)}%); ` +
    `${sum('decks')} more are a deck over a deck and are not counted`
);
check(
  pct(kerbBad, kerbFaces) < 1,
  'kerb height is the authored height',
  `${kerbBad} of ${kerbFaces} emitted kerb faces are outside the authored band ` +
    `(${pct(kerbBad, kerbFaces).toFixed(2)}%)`
);

const worst = T.flatMap((s) => (s.samples ?? []).map((v) => ({ site: s.site, ...v }))).slice(0, 12);

console.log('');
console.log(`[pavesweep] ${report.legacy ? 'LEGACY (negative control)' : 'current'} — ${T.length} sites, r=${RADIUS} m`);
for (const s of T) {
  console.log(
    `  ${s.site.padEnd(14)} ${String(s.tris).padStart(7)} tris  ` +
      `intrude ${pct(s.intrusionArea, s.walkArea).toFixed(2)}%  ` +
      `ragged ${(s.boundary / Math.max(1, s.walkArea)).toFixed(3)}  ` +
      `shards ${pct(s.smallArea, s.walkArea).toFixed(2)}%  ` +
      `pieces ${String(s.pieces).padStart(5)}  ` +
      `steps ${String(s.steps + s.stacks).padStart(5)}  ` +
      `kerbH ${pct(s.kerbBad, s.kerbFaces).toFixed(2)}%`
  );
}
console.log('');
let bad = 0;
for (const f of F) {
  console.log(`${f.ok ? '  ok  ' : '  FAIL'} ${f.name}`);
  console.log(`        ${f.detail}`);
  if (!f.ok) bad++;
}
const hist = {};
const kinds = {};
for (const s of T) {
  for (const k of Object.keys(s.depthHist)) hist[k] = (hist[k] ?? 0) + s.depthHist[k];
  for (const k of Object.keys(s.intoKind)) kinds[k] = (kinds[k] ?? 0) + s.intoKind[k];
}
const r1 = (o) => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, +v.toFixed(0)]));
console.log(`\n  intrusion area by depth band (m2): ${JSON.stringify(r1(hist))}`);
console.log(`  intrusion area by road kind (m2):  ${JSON.stringify(r1(kinds))}`);
if (worst.length) console.log(`  worst intrusions: ${JSON.stringify(worst.slice(0, 4))}`);
console.log('');
console.log(bad === 0 ? '[pavesweep] ALL CHECKS PASSED' : `[pavesweep] ${bad} CHECK(S) FAILED`);

if (args.json) {
  mkdirSync(dirname(String(args.json)), { recursive: true });
  writeFileSync(String(args.json), JSON.stringify({ ...report, checks: F }, null, 2));
}
process.exit(bad === 0 ? 0 : 1);

/* ------------------------------------------------------------ in the page -- */

function sweepSite({ x: cx, z: cz, radius, minPiece, laneTol }) {
  const e = window.__ENGINE__;
  const w = e.ctx.peek('world');
  const roads = w.roads;

  /**
   * The DRIVABLE width, which is not the carriageway width: the shoulder is
   * not a lane, and a kerb stone standing in the shoulder is a kerb stone in
   * the right place. Same table `plan.js` publishes.
   */
  const LANE_W = { highway: 3.9, arterial: 3.6, street: 3.3, alley: 3.0 };
  const laneHalf = (ed) => (ed.lanes * (LANE_W[ed.kind] ?? 3.3)) / 2;

  const CELL = 64;
  const cells = new Map();
  const ckey = (a, b) => (a * 73856093) ^ (b * 19349663);
  for (const ed of roads.edges) {
    if (ed.rail) continue;
    const na = roads.nodes[ed.a];
    const nb = roads.nodes[ed.b];
    const s = {
      ax: na.x, az: na.z, ay: na.y, bx: nb.x, bz: nb.z, by: nb.y,
      lh: laneHalf(ed), id: ed.id, kind: ed.kind,
    };
    const x0 = Math.floor((Math.min(s.ax, s.bx) - CELL) / CELL);
    const x1 = Math.floor((Math.max(s.ax, s.bx) + CELL) / CELL);
    const z0 = Math.floor((Math.min(s.az, s.bz) - CELL) / CELL);
    const z1 = Math.floor((Math.max(s.az, s.bz) + CELL) / CELL);
    for (let z = z0; z <= z1; z++) {
      for (let xx = x0; xx <= x1; xx++) {
        const k = ckey(xx, z);
        let l = cells.get(k);
        if (!l) cells.set(k, (l = []));
        l.push(s);
      }
    }
  }
  const det = { id: 0, kind: '' };
  const laneDepth = (x, y, z) => {
    const l = cells.get(ckey(Math.floor(x / CELL), Math.floor(z / CELL)));
    if (!l) return 0;
    let worst = 0;
    for (let i = 0; i < l.length; i++) {
      const s = l[i];
      const dx = s.bx - s.ax;
      const dz = s.bz - s.az;
      const l2 = dx * dx + dz * dz;
      let t = l2 > 1e-9 ? ((x - s.ax) * dx + (z - s.az) * dz) / l2 : 0;
      if (t < 0 || t > 1) continue;
      const d = Math.hypot(x - (s.ax + dx * t), z - (s.az + dz * t));
      const depth = s.lh - d;
      if (depth <= worst) continue;
      // A deck over a quay is not paving the quay.
      if (Math.abs(y - (s.ay + (s.by - s.ay) * t)) > 2.0) continue;
      worst = depth;
      det.id = s.id;
      det.kind = s.kind;
    }
    return worst;
  };

  /* ---- harvest the emitted triangles ----------------------------------- */

  const px = [];
  const py = [];
  const pz = [];
  const isWalk = [];
  const va = [];
  const vb = [];
  const vc = [];
  const weld = new Map();
  const wkey = (x, y, z) =>
    `${Math.round(x * 100)},${Math.round(y * 100)},${Math.round(z * 100)}`;
  let verts = 0;

  let tris = 0;
  let kerbFaces = 0;
  let kerbBad = 0;
  const kerbHs = [];
  const kerbPair = new Map();

  e.ctx.scene.traverse((o) => {
    if (!o.isMesh || !o.name) return;
    const m = /^road_(walk|kerb)_/.exec(o.name);
    if (!m) return;
    const walk = m[1] === 'walk';
    const g = o.geometry;
    const pos = g.attributes.position;
    const idx = g.index;
    if (!pos || !idx) return;
    for (let i = 0; i < idx.count; i += 3) {
      const i0 = idx.getX(i);
      const i1 = idx.getX(i + 1);
      const i2 = idx.getX(i + 2);
      const x0 = pos.getX(i0);
      const y0 = pos.getY(i0);
      const z0 = pos.getZ(i0);
      const x1 = pos.getX(i1);
      const y1 = pos.getY(i1);
      const z1 = pos.getZ(i1);
      const x2 = pos.getX(i2);
      const y2 = pos.getY(i2);
      const z2 = pos.getZ(i2);
      const mx = (x0 + x1 + x2) / 3;
      const mz = (z0 + z1 + z2) / 3;
      if (Math.hypot(mx - cx, mz - cz) > radius) continue;
      tris++;
      // Weld by position so a strip built as separate quads is still one piece.
      const ids = [0, 0, 0];
      const xs = [x0, x1, x2];
      const ys = [y0, y1, y2];
      const zs = [z0, z1, z2];
      for (let k = 0; k < 3; k++) {
        const kk = wkey(xs[k], ys[k], zs[k]);
        let id = weld.get(kk);
        if (id === undefined) {
          id = verts++;
          weld.set(kk, id);
        }
        ids[k] = id;
      }
      va.push(ids[0]);
      vb.push(ids[1]);
      vc.push(ids[2]);
      px.push(mx);
      py.push((y0 + y1 + y2) / 3);
      pz.push(mz);
      isWalk.push(walk ? 1 : 0);

      // ---- kerb face height, measured off the emitted vertices -----------
      //
      // The two vertices that make a kerb face are coincident in plan and
      // differ only in y, so the face's own rise IS the kerb height. Nothing
      // here consults KERB_H except the pass/fail band.
      if (!walk) {
        for (let k = 0; k < 3; k++) {
          const a = k;
          const b = (k + 1) % 3;
          if (Math.abs(xs[a] - xs[b]) < 0.004 && Math.abs(zs[a] - zs[b]) < 0.004) {
            const dy = Math.abs(ys[a] - ys[b]);
            if (dy > 0.02) {
              const pk = `${Math.round(xs[a] * 50)},${Math.round(zs[a] * 50)}`;
              if (!kerbPair.has(pk)) {
                kerbPair.set(pk, dy);
                kerbFaces++;
                kerbHs.push(dy);
                // Authored: KERB_H 0.152, minus the 2.8 cm chamfer that the
                // face itself does not include, plus/minus 3 cm of settle,
                // minus 5.5 cm where a stone is chipped, scaled to 0.4 in the
                // 1.35 m dropped run at a junction mouth.
                const full = 0.152 - 0.028;
                if (dy > full + 0.05 || dy < full * 0.4 - 0.075) kerbBad++;
              }
            }
          }
        }
      }
    }
  });

  const n = px.length;

  /* ---- intrusion -------------------------------------------------------- */

  let intrusions = 0;
  let intrusionArea = 0;
  let worstIntrusion = 0;
  const samples = [];
  /** XZ area of each welded triangle, from the emitted vertices. */
  const ax = [];

  /* ---- fragments: union-find over shared welded vertices ---------------- */

  const parent = new Int32Array(n);
  for (let i = 0; i < n; i++) parent[i] = i;
  const find = (a) => {
    let r = a;
    while (parent[r] !== r) r = parent[r];
    while (parent[a] !== r) {
      const nx2 = parent[a];
      parent[a] = r;
      a = nx2;
    }
    return r;
  };
  const union = (a, b) => {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent[ra] = rb;
  };
  const owner = new Int32Array(verts).fill(-1);
  for (let i = 0; i < n; i++) {
    for (const v of [va[i], vb[i], vc[i]]) {
      if (owner[v] < 0) owner[v] = i;
      else union(owner[v], i);
    }
  }

  // Areas, needed by both the fragment and the intrusion report. Recomputed
  // here from the welded triangle corners, which are the emitted positions.
  {
    // Rebuild corner coordinates from the weld map (id -> position).
    const vx = new Float64Array(verts);
    const vy = new Float64Array(verts);
    const vz = new Float64Array(verts);
    for (const [k, id] of weld) {
      const p = k.split(',');
      vx[id] = +p[0] / 100;
      vy[id] = +p[1] / 100;
      vz[id] = +p[2] / 100;
    }
    for (let i = 0; i < n; i++) {
      const a = va[i];
      const b = vb[i];
      const c = vc[i];
      ax[i] = Math.abs((vx[b] - vx[a]) * (vz[c] - vz[a]) - (vx[c] - vx[a]) * (vz[b] - vz[a])) * 0.5;
    }
    void vy;
  }

  let walkArea = 0;
  // How deep, and into what: a metre-deep intrusion is a corridor overlap and
  // a 10 cm one is a rounding error, and lumping them together hides both.
  const depthHist = { '0.05': 0, '0.25': 0, '0.6': 0, '1.5': 0, '4': 0, deep: 0 };
  const intoKind = {};
  for (let i = 0; i < n; i++) {
    if (isWalk[i]) walkArea += ax[i];
    const d = laneDepth(px[i], py[i], pz[i]);
    if (d > laneTol) {
      intrusions++;
      intrusionArea += ax[i];
      const b = d < 0.25 ? '0.05' : d < 0.6 ? '0.25' : d < 1.5 ? '0.6' : d < 4 ? '1.5' : d < 8 ? '4' : 'deep';
      depthHist[b] += ax[i];
      intoKind[det.kind] = (intoKind[det.kind] ?? 0) + ax[i];
      if (d > worstIntrusion) worstIntrusion = d;
      if (samples.length < 6 && d > 0.4) {
        samples.push({
          x: +px[i].toFixed(1), y: +py[i].toFixed(2), z: +pz[i].toFixed(1),
          depth: +d.toFixed(2), edge: det.id, kind: det.kind, walk: !!isWalk[i],
        });
      }
    }
  }

  let boundary = 0;
  const compArea = new Map();
  for (let i = 0; i < n; i++) {
    if (!isWalk[i]) continue;
    const r = find(i);
    compArea.set(r, (compArea.get(r) ?? 0) + ax[i]);
  }
  let smallArea = 0;
  let maxPiece = 0;
  let bigPieces = 0;
  for (const a of compArea.values()) {
    if (a < minPiece) smallArea += a;
    if (a > 40) bigPieces++;
    if (a > maxPiece) maxPiece = a;
  }

  /* ---- raggedness: open boundary per square metre ------------------------ */
  //
  // The sharpest single number for "is this a strip or a heap of offcuts".
  // A continuous 2.7 m footway has two long open edges and two ends, so about
  // 0.75 m of boundary per square metre. A detached 1.5 x 2.7 m corner fillet
  // has 2.1. Shattering a surface cannot change its area but multiplies its
  // perimeter, so this rises even when the pieces are too big to be counted as
  // shards — which is exactly the hole the piece-size test alone left.
  {
    const seen = new Map();
    const ek = (a, b) => (a < b ? `${a}_${b}` : `${b}_${a}`);
    for (let i = 0; i < n; i++) {
      if (!isWalk[i]) continue;
      const t = [va[i], vb[i], vc[i]];
      for (let k = 0; k < 3; k++) {
        const key = ek(t[k], t[(k + 1) % 3]);
        seen.set(key, (seen.get(key) ?? 0) + 1);
      }
    }
    const vx = new Float64Array(verts);
    const vz2 = new Float64Array(verts);
    for (const [k, id] of weld) {
      const p = k.split(',');
      vx[id] = +p[0] / 100;
      vz2[id] = +p[2] / 100;
    }
    let bl = 0;
    for (const [k, c] of seen) {
      if (c !== 1) continue;
      const p = k.split('_');
      const a = +p[0];
      const b = +p[1];
      bl += Math.hypot(vx[a] - vx[b], vz2[a] - vz2[b]);
    }
    boundary = bl;
  }

  /* ---- steps and stacked layers ---------------------------------------- */
  //
  // A 0.5 m grid over the footway triangle centres, keyed BY CONNECTED PIECE.
  //
  // The naive version of this — "neighbouring cells must not differ by more
  // than a kerb height" — measures the footway's own cross-fall as a defect.
  // On the Mt. Washington switchbacks the back of the footway is allowed to
  // climb 0.6 m across 2.7 m to reach the hillside, and that legitimate 22%
  // slope trips a flat 15 cm threshold every time. What makes something a TEAR
  // rather than a slope is that the two surfaces are not the same surface: a
  // slab standing proud in the road, or two layers of pavement stacked at one
  // place, are always a different connected piece. So the comparison is only
  // ever made BETWEEN pieces, which is both stricter about real tears and blind
  // to honest terrain.
  const G = 0.5;
  const grid = new Map();
  const gkey = (a, b) => `${a},${b}`;
  for (let i = 0; i < n; i++) {
    if (!isWalk[i]) continue;
    const k = gkey(Math.floor(px[i] / G), Math.floor(pz[i] / G));
    let c = grid.get(k);
    if (!c) grid.set(k, (c = new Map()));
    const r = find(i);
    const e2 = c.get(r);
    if (!e2) c.set(r, { lo: py[i], hi: py[i] });
    else {
      if (py[i] < e2.lo) e2.lo = py[i];
      if (py[i] > e2.hi) e2.hi = py[i];
    }
  }
  const KH = 0.152;
  /**
   * A footway six metres above another footway is a BRIDGE, not a tear. The
   * same exclusion `probe.mjs` makes for junction pads: measured here, the
   * worst "stacked layers" in downtown were 6.2-7.7 m apart, which is the
   * Fort Duquesne approach ramp passing over the quay. Anything past this is
   * counted as a deck and reported, never failed.
   */
  const DECK = 2.5;
  const stackAt = [];
  let stacks = 0;
  let steps = 0;
  let decks = 0;
  const gapOf = (a, b) => Math.max(0, Math.max(a.lo - b.hi, b.lo - a.hi));
  for (const [k, c] of grid) {
    if (c.size > 1) {
      // Two different pieces of footway occupying the same half metre.
      let worstGap = 0;
      const es = [...c.values()];
      for (let i = 0; i < es.length; i++) {
        for (let j = i + 1; j < es.length; j++) worstGap = Math.max(worstGap, gapOf(es[i], es[j]));
      }
      if (worstGap > DECK) decks++;
      else if (worstGap > KH) {
        stacks++;
        if (stackAt.length < 8) {
          const p2 = k.split(',');
          stackAt.push({ x: +(+p2[0] * G).toFixed(1), z: +(+p2[1] * G).toFixed(1), gap: +worstGap.toFixed(2), n: c.size });
        }
      }
    }
    const p = k.split(',');
    const gx = +p[0];
    const gz = +p[1];
    for (const [dx, dz] of [[1, 0], [0, 1]]) {
      const c2 = grid.get(gkey(gx + dx, gz + dz));
      if (!c2) continue;
      let worstGap = Infinity;
      for (const [ra, ea] of c) {
        for (const [rb, eb] of c2) {
          // Same piece adjoining itself is a slope, not a step.
          worstGap = Math.min(worstGap, ra === rb ? 0 : gapOf(ea, eb));
        }
      }
      if (worstGap > DECK) decks++;
      else if (worstGap > KH) steps++;
    }
  }

  return {
    tris: n,
    walkArea,
    intrusions,
    intrusionArea,
    worstIntrusion,
    pieces: compArea.size,
    boundary,
    bigPieces,
    maxPiece,
    smallArea,
    cells: grid.size,
    steps,
    stacks,
    decks,
    stackAt,
    depthHist,
    intoKind,
    kerbFaces,
    kerbBad,
    meanKerbH: kerbHs.length ? kerbHs.reduce((a, b) => a + b, 0) / kerbHs.length : 0,
    samples,
  };
}
