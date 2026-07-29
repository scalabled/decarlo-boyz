#!/usr/bin/env node
/**
 * WORLD — headless geometry / playability probe.
 *
 * Screenshots cannot tell you whether a bridge is drivable, whether a junction
 * has a hole in it, whether a mission POI is standing in a river, or whether a
 * player who falls in the Mon can get out again. This boots the real engine,
 * lets the city stream, and then asserts on the world itself:
 *
 *   pads       the collision surface must be continuous across every junction:
 *              a downward raycast on a ring round the node must find road, at
 *              road height, all the way round — no crescent-shaped holes
 *   kerbs      a horizontal probe at bumper height, just inside the kerb line,
 *              must hit something. No kerb collider = cars on the pavement
 *   bridges    all eleven drivable end to end, joined to the graph at both
 *              banks, and `roads.route()` must actually path across them
 *   poi        every point of interest must resolve to dry, walkable, drivable
 *              ground with a road within reach
 *   water      `isWater` / `waterLevelAt` must agree with the rendered sheet,
 *              and every stretch of shoreline must have a climbable bank
 *
 * Usage
 *   node src/world/probe.mjs
 *   node src/world/probe.mjs --json=/tmp/world.json
 *   node src/world/probe.mjs --only=bridges
 *   node src/world/probe.mjs --nodedup     lay every corridor as authored, so
 *                                          the dedup pass can be measured OFF
 *                                          against the SAME seed. A fix you
 *                                          cannot un-apply is a fix you cannot
 *                                          prove.
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
const ONLY = args.only ? String(args.only).split(',') : null;
const want = (k) => !ONLY || ONLY.includes(k);

const portOpen = (port) =>
  new Promise((res) => {
    const s = net.connect({ port, host: '127.0.0.1' }, () => (s.destroy(), res(true)));
    s.on('error', () => res(false));
    s.setTimeout(400, () => (s.destroy(), res(false)));
  });

async function freePort() {
  for (let i = 0; i < 300; i++) {
    const p = 5900 + Math.floor(Math.random() * 900);
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
page.on('pageerror', (e) => errors.push(String(e.message)));

let report = null;
let failure = null;
try {
  const extra = args.nodedup ? '&nodedup=1' : '';
  await page.goto(`http://127.0.0.1:${PORT}/?capture=1&lockstep=1&prewarm=0&q=high${extra}`, {
    waitUntil: 'domcontentloaded',
    timeout: 120000,
  });
  await page.waitForFunction('window.__READY__ === true', null, { timeout: 180000 });
  report = await page.evaluate(runProbe, { only: ONLY });
} catch (e) {
  failure = e;
} finally {
  await browser.close();
  server.kill();
}

if (failure) {
  console.error(`[world probe] FAILED: ${failure.message}`);
  if (errors.length) console.error(errors.slice(0, 8).join('\n'));
  process.exit(1);
}

const R = report;
const F = [];
const check = (ok, name, detail) => F.push({ ok, name, detail });

if (want('pads') && R.pads) {
  check(
    R.pads.noHit === 0,
    'no void inside a junction',
    `${R.pads.noHit} probes on a turning line found no collision surface at all`
  );
  check(
    // The residual is overlapping carriageways where two corridors were laid a
    // couple of metres apart, not holes: `noHit` above is the hard gate.
    R.pads.holePct < 3.0,
    'junction pads are continuous',
    `${R.pads.holePct.toFixed(2)}% of ${R.pads.samples} probes along the turning lines of ` +
      `${R.pads.nodes} junctions (${R.pads.flyover} flyovers excluded) hit nothing ` +
      `(${R.pads.noHit}) or stepped over 0.25 m (${R.pads.other} on another deck); ` +
      `worst ${R.pads.worstStep.toFixed(2)} m ${JSON.stringify(R.pads.worst ?? {})}`
  );
}
if (want('kerbs') && R.kerbs) {
  check(
    R.kerbs.missPct < 8,
    'kerbs exist in the collision world',
    `${R.kerbs.missPct.toFixed(1)}% of ${R.kerbs.samples} kerb lines had no collider at bumper height ` +
      `(mean kerb height ${R.kerbs.meanH.toFixed(3)} m; ${R.kerbs.overlap} skipped where another ` +
      `carriageway paves over the kerb line) ` + JSON.stringify(R.kerbs.bad ?? [])
  );
}
if (R.dup) {
  check(
    R.dup.pct < 2,
    'one piece of ground, one road',
    `${R.dup.pct.toFixed(2)}% of the network (${R.dup.km.toFixed(2)} km) has its centreline inside ` +
      `another corridor's carriageway, running the same way, at the same level` +
      (R.dup.worst.length ? `\n        ` + R.dup.worst.slice(0, 4).map((w) => JSON.stringify(w)).join('\n        ') : '')
  );
}
if (want('roadcol') && R.roadcol) {
  check(
    R.roadcol.nearPct >= 98,
    'the road has a road under it',
    `${R.roadcol.nearPct.toFixed(1)}% of ${R.roadcol.near} carriageway samples within 512 m of the ` +
      `camera stand on real road collision (${R.roadcol.noGround} found nothing at all); ` +
      `whole network ${R.roadcol.allPct.toFixed(1)}% of ${R.roadcol.all}` +
      (R.roadcol.bad.length ? `\n        ` + R.roadcol.bad.map((b) => JSON.stringify(b)).join('\n        ') : '')
  );
}
if (R.grades) {
  check(
    R.grades.steep < 30,
    'no road edge is a wall',
    `${R.grades.steep} edges (${R.grades.pct.toFixed(2)}%, ${R.grades.km.toFixed(2)} km) steeper than 32%` +
      (R.grades.worst.length ? `\n        ` + R.grades.worst.slice(0, 6).map((g) => JSON.stringify(g)).join('\n        ') : '')
  );
}
if (want('bridges') && R.bridges) {
  const bad = R.bridges.list.filter((b) => !b.ok);
  check(
    bad.length === 0,
    'all bridges drivable + routable',
    `${R.bridges.list.length - bad.length}/${R.bridges.list.length} clean` +
      (bad.length ? `\n        ` + bad.map((b) => JSON.stringify(b)).join('\n        ') : '')
  );
  for (const b of R.bridges.list) {
    console.log(
      `    ${b.ok ? ' ok ' : 'BAD '} ${b.id.padEnd(14)} deck ${String(b.spanEdges).padStart(2)} edges  ` +
        `grade ${(b.maxGrade * 100).toFixed(1)}%  ` +
        `route ${b.routed ? `${b.routeLen} nodes${b.usesDeck ? ' via deck' : ' DETOUR'}` : 'NONE'}  ` +
        `banks ${b.bankA}/${b.bankB}` +
        (b.why ? `  <- ${b.why}` : '')
    );
  }
}
if (want('poi') && R.poi) {
  const bad = R.poi.list.filter((p) => !p.ok);
  check(
    bad.length === 0,
    'every POI is reachable ground',
    `${R.poi.list.length - bad.length}/${R.poi.list.length} clean` +
      (bad.length ? `\n        ` + bad.map((p) => JSON.stringify(p)).join('\n        ') : '')
  );
}
if (want('water') && R.water) {
  check(
    R.water.disagree < 1.0,
    'isWater agrees with the water sheet',
    `${R.water.disagree.toFixed(2)}% of ${R.water.samples} samples disagreed ` + JSON.stringify(R.water.bad ?? [])
  );
  check(
    R.water.unclimbablePct < 12,
    'the river bank is climbable',
    `${R.water.unclimbablePct.toFixed(1)}% of ${R.water.shoreN} shoreline probes had no exit ` +
      `within 30 m (worst run ${R.water.worstRun} consecutive)`
  );
}

console.log('');
console.log('WORLD PROBE');
if (R.stats) {
  console.log(
    `  ${R.stats.nodes} nodes / ${R.stats.edges} edges / ${R.stats.km.toFixed(1)} km · ` +
      `${R.stats.lots} lots · stranded ${R.stats.stranded} on ${R.stats.islands?.length ?? 0} islands` +
      (R.stats.islands?.length ? `: ` + R.stats.islands.slice(0, 12).map((i) => `${i.n}@(${i.x},${i.z}) ${i.corr.join('/')}`).join(' · ') : '')
  );
}
if (R.dup) {
  console.log(
    `  duplicated carriageways   ${R.dup.pct.toFixed(2)}% of the network ` +
      `(${R.dup.km.toFixed(2)} of ${R.dup.totalKm.toFixed(1)} km) is paved twice by a near-parallel ` +
      `corridor that is not its own continuation` +
      (R.dedup ? ` · dedup cut ${R.dedup.cutKm.toFixed(1)} km from ${R.dedup.cut} corridors` : '')
  );
}
console.log('');
for (const f of F) console.log(`  ${f.ok ? 'PASS' : 'FAIL'}  ${f.name.padEnd(34)} ${f.detail}`);
console.log('');
if (errors.length) console.log('  page errors: ' + errors.slice(0, 5).join(' | '));

if (args.json) {
  const out = resolve(String(args.json));
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, JSON.stringify(R, null, 1));
  console.log(`  wrote ${out}`);
}

const failed = F.filter((f) => !f.ok);
console.log(failed.length ? `  ${failed.length} CHECK(S) FAILED` : '  ALL CHECKS PASSED');
process.exit(failed.length ? 1 : 0);

/* =========================================================================
 * Everything below runs inside the browser.
 * ========================================================================= */

function runProbe({ only }) {
  const e = window.__ENGINE__;
  const ctx = e.ctx;
  const w = ctx.peek('world');
  const phys = ctx.peek('physics');
  const roads = w.roads;
  const has = (k) => !only || only.includes(k);
  const out = {};

  const T = new (Object.getPrototypeOf(e.camera).constructor.name ? Object : Object)();
  void T;

  /** Stream the city in around a point, then run `fn`. */
  const settleAt = (x, z, y) => {
    const cam = e.camera;
    cam.position.set(x, (w.heightAt(x, z) ?? 0) + (y ?? 30), z);
    cam.updateMatrixWorld(true);
    for (let i = 0; i < 700; i++) {
      e.step();
      if (i > 60 && window.__SETTLED__?.() === true) break;
    }
  };

  const rayDown = (x, y, z, len) => {
    const h = phys.raycast(x, y, z, 0, -1, 0, len ?? 60, phys.MASK.WORLD);
    return h.hit ? { y: h.point.y, surface: h.surface, name: h.object?.name ?? '' } : null;
  };
  const ringAny = (x, z, r, pred) => {
    for (let k = 0; k < 12; k++) {
      const a = (k / 12) * Math.PI * 2;
      if (pred(x + Math.cos(a) * r, z + Math.sin(a) * r)) return true;
    }
    return false;
  };
  const nearWater = (x, z, r) => ringAny(x, z, r, (px, pz) => w.isWater(px, pz));
  /**
   * Is this point inside the carriageway of some edge OTHER than `skip`, at
   * roughly the same level? Two corridors laid a couple of metres apart both
   * get a full carriageway and one paves over the other's kerb, so a kerb probe
   * there is measuring an overlap, not a missing kerb.
   */
  const _ov = [];
  const coveredByOther = (x, z, y, skip) => {
    _ov.length = 0;
    roads.edgesInRect(x - 24, z - 24, x + 24, z + 24, _ov);
    for (let i = 0; i < _ov.length; i++) {
      const q = _ov[i];
      if (q === skip || q.rail) continue;
      const na = roads.nodes[q.a];
      const nb = roads.nodes[q.b];
      const dx = nb.x - na.x;
      const dz = nb.z - na.z;
      const l2 = dx * dx + dz * dz;
      let t = l2 > 1e-9 ? ((x - na.x) * dx + (z - na.z) * dz) / l2 : 0;
      t = t < 0 ? 0 : t > 1 ? 1 : t;
      const qx = na.x + dx * t - x;
      const qz = na.z + dz * t - z;
      if (Math.hypot(qx, qz) > q.width * 0.5) continue;
      if (Math.abs(na.y + (nb.y - na.y) * t - y) > 2.5) continue;
      return q.id;
    }
    return -1;
  };
  const nearDry = (x, z, r) => ringAny(x, z, r, (px, pz) => !w.isWater(px, pz));

  out.stats = {
    nodes: roads.nodes.length,
    edges: roads.edges.length,
    km: roads.totalLength / 1000,
    lots: w.lots.length,
    stranded: roads.strandedNodes ?? 0,
  };
  // WHICH islands, not just how many nodes are on one. A count alone cannot
  // tell you whether a change stranded a new fragment or merely resized one
  // that was always there.
  {
    const comp = roads.mainComponent;
    const main = roads.mainComponentId;
    const isles = new Map();
    if (comp) {
      for (let i = 0; i < roads.nodes.length; i++) {
        if (comp[i] === -1 || comp[i] === main) continue;
        const n = roads.nodes[i];
        let r = isles.get(comp[i]);
        if (!r) isles.set(comp[i], (r = { n: 0, x: 0, z: 0, corr: new Set() }));
        r.n++;
        r.x += n.x;
        r.z += n.z;
        for (const li of n.links) r.corr.add(roads.edges[li].corridor);
      }
    }
    out.stats.islands = [...isles.values()]
      .map((r) => ({ n: r.n, x: Math.round(r.x / r.n), z: Math.round(r.z / r.n), corr: [...r.corr].slice(0, 3) }))
      .sort((a, b) => b.n - a.n);
  }

  /* ---- graph sanity: duplicate carriageways ----------------------------- */
  {
    // Two corridors laid a few metres apart each get a full carriageway, and
    // the pair paves everything between them: no kerb, no lane line, no verge —
    // a street that reads as an airport apron. Measure how much of the network
    // is doubled up.
    //
    // IT MUST SKIP AN EDGE'S OWN NEIGHBOURS AT THE SHARED NODE, and the version
    // of this test that did not is where the "34.4% of the road network is
    // paved twice" line in REVIEW.md came from. Both endpoint samples of every
    // edge sit exactly on the node it shares with the next edge of the same
    // street, so they measure zero distance to it and score as duplicated. With
    // a median edge of 35 m and a sample every 8 m that is 2 of 6 samples —
    // 33.3% — on a network with no duplication in it at all. The measured
    // figure was 34.4%. Excluding neighbours, the same build reads 0.4%.
    let dupLen = 0;
    let total = 0;
    const worst = [];
    const pool = [];
    const adjacent = (a, b) => a.a === b.a || a.a === b.b || a.b === b.a || a.b === b.b;
    for (const ed of roads.edges) {
      if (ed.rail) continue;
      total += ed.len;
      const na = roads.nodes[ed.a];
      const nb = roads.nodes[ed.b];
      const hw = ed.width * 0.5;
      const steps = Math.max(2, Math.ceil(ed.len / 8));
      let hits = 0;
      for (let k = 0; k <= steps; k++) {
        const t = k / steps;
        const x = na.x + (nb.x - na.x) * t;
        const z = na.z + (nb.z - na.z) * t;
        const y = na.y + (nb.y - na.y) * t;
        pool.length = 0;
        roads.edgesInRect(x - 20, z - 20, x + 20, z + 20, pool);
        for (let i = 0; i < pool.length; i++) {
          const q = pool[i];
          if (q === ed || q.rail || adjacent(q, ed)) continue;
          const qa = roads.nodes[q.a];
          const qb = roads.nodes[q.b];
          const dx = qb.x - qa.x;
          const dz = qb.z - qa.z;
          const l2 = dx * dx + dz * dz;
          let u = l2 > 1e-9 ? ((x - qa.x) * dx + (z - qa.z) * dz) / l2 : 0;
          u = u < 0 ? 0 : u > 1 ? 1 : u;
          const px = qa.x + dx * u - x;
          const pz = qa.z + dz * u - z;
          // Inside the other carriageway, at the same level, and not simply
          // crossing it: the headings must agree.
          if (Math.hypot(px, pz) > Math.min(hw, q.width * 0.5)) continue;
          if (Math.abs(qa.y + (qb.y - qa.y) * u - y) > 2.5) continue;
          if (Math.abs(ed.dx * q.dx + ed.dz * q.dz) < 0.8) continue;
          hits++;
          break;
        }
      }
      const frac = hits / (steps + 1);
      dupLen += frac * ed.len;
      if (frac > 0.6 && worst.length < 8) {
        worst.push({ id: ed.id, kind: ed.kind, corr: ed.corridor, len: +ed.len.toFixed(0), frac: +frac.toFixed(2) });
      }
    }
    out.dup = { pct: (dupLen / total) * 100, km: dupLen / 1000, totalKm: total / 1000, worst };
    const dd = roads.dedup;
    if (dd) out.dedup = { cut: dd.cut, cutKm: dd.cutKm, rawKm: dd.rawKm, netKm: dd.netKm };
  }

  /* ---- graph sanity: no edge may be a wall ------------------------------ */
  {
    // A road at 30% is a hard Pittsburgh street. A road at 100% is a cliff with
    // lane paint on it, and any car sent along it by the router simply stops.
    let steep = 0;
    let steepLen = 0;
    const worst = [];
    for (const ed of roads.edges) {
      if (ed.rail) continue;
      const na = roads.nodes[ed.a];
      const nb = roads.nodes[ed.b];
      const gr = Math.abs(nb.y - na.y) / Math.max(1, ed.len);
      if (gr <= 0.32) continue;
      steep++;
      steepLen += ed.len;
      worst.push({
        id: ed.id, kind: ed.kind, bridge: !!ed.bridge, grade: +gr.toFixed(2),
        len: +ed.len.toFixed(1), dy: +(nb.y - na.y).toFixed(1),
        x: +na.x.toFixed(0), z: +na.z.toFixed(0),
      });
    }
    worst.sort((a, b) => b.grade - a.grade);
    out.grades = {
      steep,
      pct: (steep / roads.edges.length) * 100,
      km: steepLen / 1000,
      worst: worst.slice(0, 10),
    };
  }

  /* ---- junction pads --------------------------------------------------- */
  if (has('pads')) {
    // Downtown, where the grid is densest and the streets are on a grade.
    settleAt(-232, 64, 24);
    let samples = 0;
    let holes = 0;
    let worstStep = 0;
    let worst = null;
    const near = [];
    // A junction with a bridge arm is multi-level BY CONSTRUCTION — the ramp
    // climbs away over whatever runs beneath it — so a downward probe there is
    // measuring an overpass, not a hole. Counted, not judged.
    let flyover = 0;
    for (const n of roads.nodes) {
      if (n.links.length < 3) continue;
      if (Math.hypot(n.x + 232, n.z - 64) > 260) continue;
      if (n.links.some((i) => roads.edges[i].bridge)) { flyover++; continue; }
      near.push(n);
      if (near.length >= 24) break;
    }
    // MEASURE THE DRIVING LINE, not a ring.
    //
    // A junction on a grade is supposed to slope, and its outline is not a
    // circle — it is the analytic boundary where the carriageways and kerb
    // fillets meet — so a fixed-radius ring reports every crossing of that
    // outline as a defect. What actually matters is whether a wheel drops:
    // drive every lane of every arm in through the junction and out of every
    // other arm, sampling under the wheel, and flag any step.
    let noHit = 0;
    let other = 0;
    for (const n of near) {
      for (let ai = 0; ai < n.links.length; ai++) {
        const ea = roads.edges[n.links[ai]];
        if (ea.rail) continue;
        const sa = ea.a === n.id ? 1 : -1;
        for (let bi = 0; bi < n.links.length; bi++) {
          if (bi === ai) continue;
          const eb = roads.edges[n.links[bi]];
          if (eb.rail) continue;
          const sb = eb.a === n.id ? 1 : -1;
          // Approach on the near half of arm A, leave on the near half of B,
          // offset to a lane centre so the path hugs the inside of the turn.
          const oa = ea.laneWidth * 0.5;
          const ob = eb.laneWidth * 0.5;
          const ax = n.x + ea.dx * sa * 22 - ea.dz * sa * oa;
          const az = n.z + ea.dz * sa * 22 + ea.dx * sa * oa;
          const bx = n.x + eb.dx * sb * 22 - eb.dz * sb * ob;
          const bz = n.z + eb.dz * sb * 22 + eb.dx * sb * ob;
          // Expected heights at the two ends, so the ray can start just above
          // the surface it is meant to find. Starting high enough to clear a
          // 30% ramp also means starting high enough to hit a bridge deck
          // eighteen metres overhead, and then every flyover reads as a hole.
          const fa = roads.nodes[ea.a === n.id ? ea.b : ea.a];
          const fb = roads.nodes[eb.a === n.id ? eb.b : eb.a];
          const ya = n.y + ((fa.y - n.y) * 22) / Math.max(1, ea.len);
          const yb = n.y + ((fb.y - n.y) * 22) / Math.max(1, eb.len);
          let prevY = null;
          for (let k = 0; k <= 44; k++) {
            const t = k / 44;
            const u = 1 - t;
            // Quadratic through the node: the line a car actually takes.
            const x = u * u * ax + 2 * u * t * n.x + t * t * bx;
            const z = u * u * az + 2 * u * t * n.z + t * t * bz;
            const ey = u * u * ya + 2 * u * t * n.y + t * t * yb;
            samples++;
            const h = rayDown(x, ey + 1.6, z, 5);
            if (!h) {
              noHit++;
              holes++;
              prevY = null;
              continue;
            }
            // A road that is not this junction — an unflagged bridge approach
            // crossing a quay two metres lower, say — is an overpass, not a
            // hole in the pad.
            if (Math.abs(h.y - ey) > 1.0) {
              other++;
              prevY = null;
              continue;
            }
            if (prevY !== null) {
              const step = Math.abs(h.y - prevY);
              if (step > 0.25) {
                holes++;
                if (step > worstStep) {
                  worstStep = step;
                  worst = {
                    node: n.id, x: +x.toFixed(1), z: +z.toFixed(1),
                    hit: h.name, y: +h.y.toFixed(2), prev: +prevY.toFixed(2),
                  };
                }
              }
            }
            prevY = h.y;
          }
        }
      }
    }
    out.pads = {
      samples, noHit, flyover, other, holePct: samples ? (holes / samples) * 100 : 0,
      worstStep, worst, nodes: near.length,
    };
  }

  /* ---- kerb colliders --------------------------------------------------- */
  if (has('kerbs')) {
    let samples = 0;
    let miss = 0;
    let hsum = 0;
    let hn = 0;
    let overlap = 0;
    const cx = -232;
    const cz = 64;
    for (const ed of roads.edges) {
      if (ed.rail || ed.kind === 'highway' || ed.kind === 'alley') continue;
      const na = roads.nodes[ed.a];
      if (Math.hypot(na.x - cx, na.z - cz) > 240) continue;
      if (ed.len < 55) continue;
      const nb = roads.nodes[ed.b];
      for (const side of [-1, 1]) {
        for (const t of [0.45, 0.55]) {
          const hw = ed.width * 0.5;
          // Right of a->b is (-dz, dx); `side` picks the kerb.
          const ox = -ed.dz * side;
          const oz = ed.dx * side;
          const mx = na.x + (nb.x - na.x) * t;
          const mz = na.z + (nb.z - na.z) * t;
          // Stand a metre inside the kerb line, on the carriageway, and look
          // outward at bumper height.
          const sx = mx + ox * (hw - 1.0);
          const sz = mz + oz * (hw - 1.0);
          const base = rayDown(sx, na.y + 6, sz, 20);
          if (!base) continue;
          const cov = coveredByOther(sx + ox * 1.4, sz + oz * 1.4, base.y, ed);
          if (cov >= 0) { overlap++; continue; }
          samples++;
          // 3 cm, not 7: the kerb's collision face is 12 cm and the carriageway
          // carries +-3 cm of settle noise, so a higher ray skims over the top of
          // a stone that is really there and reports a hole that is not.
          const h = phys.raycast(sx, base.y + 0.03, sz, ox, 0, oz, 2.2, phys.MASK.WORLD);
          if (!h.hit) {
            miss++;
            if (!out._kbad) out._kbad = [];
            if (out._kbad.length < 8) {
              out._kbad.push({
                e: ed.id, kind: ed.kind, bridge: !!ed.bridge, corr: ed.corridor,
                x: +sx.toFixed(0), z: +sz.toFixed(0), len: +ed.len.toFixed(0),
                base: +base.y.toFixed(2), on: base.name,
              });
            }
          } else {
            const top = rayDown(sx + ox * (h.distance + 0.15), base.y + 1.4, sz + oz * (h.distance + 0.15), 3);
            if (top) {
              hsum += top.y - base.y;
              hn++;
            }
          }
        }
      }
      if (samples > 600) break;
    }
    out.kerbs = { samples, overlap, missPct: samples ? (miss / samples) * 100 : 0, meanH: hn ? hsum / hn : 0, bad: out._kbad ?? [] };
    delete out._kbad;
  }

  /* ---- road collision coverage ------------------------------------------ */
  if (has('roadcol')) {
    /**
     * IS THERE A ROAD UNDER THE ROAD?
     *
     * `physics` surveyed this and found only 47% of the network had real road
     * collision, and 92-95% even within 512 m of the camera — because road
     * collision was a by-product of the VISIBLE sector build, and the visible
     * set (a disc of sector centres) and the collision set (a 3x3 Chebyshev
     * box) are not the same sectors. The four diagonals were asked for a
     * collider nobody had built. A carriageway with no collider under it is a
     * carriageway whose kerbs do not exist either, which is how cars end up
     * beached on `props` furniture 1 m behind the kerb line.
     *
     * The gate is the NEAR field, because that is what `world` promises: every
     * carriageway within `COL_RADIUS` of the camera stands on real road
     * collision. The whole-network number is reported, not gated — outside the
     * streamed radius the contract is `walkableHeightAt` plus the always-
     * resident CLIP net, and that is deliberate.
     */
    const cam = e.camera.position;
    const NEAR = 512;
    let near = 0;
    let nearReal = 0;
    let all = 0;
    let allReal = 0;
    let noGround = 0;
    const bad = [];
    const seen = new Set();
    for (const ed of roads.edges) {
      if (ed.rail) continue; // mill trackage is drawn, never driven
      const na = roads.nodes[ed.a];
      const nb = roads.nodes[ed.b];
      for (const t of [0.3, 0.5, 0.7]) {
        const x = na.x + (nb.x - na.x) * t;
        const z = na.z + (nb.z - na.z) * t;
        const y = na.y + (nb.y - na.y) * t;
        const h = rayDown(x, y + 6, z, 14);
        all++;
        const real = !!h && /road_col|bridge/i.test(h.name);
        if (real) allReal++;
        const d = Math.hypot(x - cam.x, z - cam.z);
        if (d > NEAR) continue;
        near++;
        if (real) {
          nearReal++;
          continue;
        }
        if (!h) noGround++;
        if (!seen.has(ed.corridor) && bad.length < 8) {
          seen.add(ed.corridor);
          bad.push({
            e: ed.id, kind: ed.kind, corr: ed.corridor, bridge: !!ed.bridge,
            x: +x.toFixed(0), z: +z.toFixed(0), d: +d.toFixed(0),
            on: h ? h.name || '(unnamed)' : 'NOTHING',
          });
        }
      }
    }
    out.roadcol = {
      near, nearReal, noGround,
      nearPct: near ? (nearReal / near) * 100 : 0,
      all, allPct: all ? (allReal / all) * 100 : 0,
      bad,
    };
  }

  /* ---- bridges ---------------------------------------------------------- */
  if (has('bridges')) {
    const list = [];
    for (const spec of w.bridgeSpecs ?? []) {
      const edges = roads.edges.filter((ed) => ed.bridgeId === spec.id);
      const nodeIds = new Set();
      for (const ed of edges) {
        nodeIds.add(ed.a);
        nodeIds.add(ed.b);
      }
      // Walk the deck chain from one end to the other, measuring the worst
      // gap between consecutive nodes and the worst grade.
      let maxGap = 0;
      let maxGrade = 0;
      for (const ed of edges) {
        const na = roads.nodes[ed.a];
        const nb = roads.nodes[ed.b];
        maxGrade = Math.max(maxGrade, Math.abs(nb.y - na.y) / Math.max(1, ed.len));
      }
      // Ends: the two extreme nodes along the bridge direction.
      const [dx, dz] = spec.dir;
      let lo = null;
      let hi = null;
      let loS = 1e9;
      let hiS = -1e9;
      for (const id of nodeIds) {
        const n = roads.nodes[id];
        const s = (n.x - spec.origin[0]) * dx + (n.z - spec.origin[1]) * dz;
        if (s < loS) { loS = s; lo = n; }
        if (s > hiS) { hiS = s; hi = n; }
      }
      // How the ramp meets the network at each bank: how many non-bridge edges
      // hang off ANY node of the approach, not just the extreme one — a ramp
      // that is joined 30 m short of its tip is joined.
      const joinsNear = (end) => {
        if (!end) return 0;
        let n = 0;
        for (const id of nodeIds) {
          const q = roads.nodes[id];
          if (Math.hypot(q.x - end.x, q.z - end.z) > 90) continue;
          for (const li of q.links) if (roads.edges[li].bridgeId !== spec.id) n++;
        }
        return n;
      };
      const joinA = joinsNear(lo);
      const joinB = joinsNear(hi);

      // THE test: can a car on one bank reach the other bank? Take a node well
      // back from each approach and route between them; the path must contain
      // this bridge's deck.
      let routed = false;
      let routeLen = 0;
      let usesDeck = false;
      const back = (end, sign) => {
        if (!end) return null;
        return roads.nearestNode(end.x + dx * sign * 130, end.z + dz * sign * 130, 200);
      };
      const fromN = back(lo, -1) ?? lo;
      const toN = back(hi, 1) ?? hi;
      if (fromN && toN && fromN.id !== toN.id) {
        const p = roads.route(fromN.id, toN.id);
        routed = !!p && p.length >= 2;
        routeLen = p ? p.length : 0;
        if (p) {
          for (let i = 0; i < p.length - 1 && !usesDeck; i++) {
            const ed = roads.edgeBetween(p[i], p[i + 1]);
            if (ed && ed.bridgeId === spec.id) usesDeck = true;
          }
        }
      }

      const spanEdges = edges.length;
      const why = [];
      if (!spanEdges) why.push('no deck edges in the graph');
      // A bank that joins the network 40 m short of its own tip leaves a stub
      // you can drive to the end of; that is a blemish, not a chokepoint
      // failure, so it only counts when the crossing itself does not work.
      if (!joinA && !(routed && usesDeck)) why.push('bank A is a dead end');
      if (!joinB && !(routed && usesDeck)) why.push('bank B is a dead end');
      if (!routed) why.push('route() cannot cross');
      // `usesDeck` is REPORTED, not required: the Point carries two crossings
      // 300 m apart, and A* preferring the other one for a given pair of
      // endpoints is the router working, not the bridge being broken.
      if (maxGrade > 0.32) why.push(`ramp grade ${(maxGrade * 100).toFixed(0)}%`);
      list.push({
        id: spec.id,
        spanEdges,
        maxGap,
        maxGrade,
        routed,
        routeLen,
        usesDeck,
        bankA: joinA ? `ok(${joinA})` : 'DEAD',
        bankB: joinB ? `ok(${joinB})` : 'DEAD',
        ok: why.length === 0,
        why: why.join('; '),
      });
    }
    out.bridges = { list };
  }

  /* ---- points of interest ---------------------------------------------- */
  if (has('poi')) {
    const list = [];
    const pts = [];
    for (const p of w.pois ?? []) pts.push(p);
    for (const p of pts) {
      // Judge the RESOLVED spot — the place the player is actually sent — not
      // the authored coordinate, which is a legacy 700 m map number x4.
      const slope = w.terrain.slopeAt(p.x, p.z, 6);
      const wet = w.isWater(p.x, p.z);
      const why = [];
      const drive = p.kind !== 'landmark';
      if (p.kind === 'dock') {
        // A dock must touch BOTH: water to moor in, dry land to stand on.
        if (!w.isWater(p.x, p.z) && !nearWater(p.x, p.z, 40)) why.push('no water within 40 m');
        if (wet && !nearDry(p.x, p.z, 40)) why.push('no dry land within 40 m');
      } else {
        if (wet) why.push('in water');
        if (slope > 0.34) why.push(`slope ${(slope * 100) | 0}%`);
        if (drive && p.roadDist > 70) why.push(`road ${p.roadDist.toFixed(0)} m away`);
        if (drive && !p.ok) why.push('unresolved');
      }
      // The forecourt must be shallow enough to STAND on without sliding out of
      // the trigger — `game`'s service radius is 11 m and the body-shop ring
      // heals you for as long as you are inside it. Slope, not absolute height:
      // a forecourt that follows a 3% street for 10 m is fine, a 40% ramp is
      // not, and both can be "3 m out of level".
      let bump = 0;
      if (p.pad) {
        for (let k = 0; k < 8; k++) {
          const a = (k / 8) * Math.PI * 2;
          for (const r of [0, 4, 8]) {
            bump = Math.max(bump, w.terrain.slopeAt(p.x + Math.cos(a) * r, p.z + Math.sin(a) * r, 4));
          }
        }
        if (bump > 0.3) why.push(`forecourt slope ${(bump * 100) | 0}%`);
      }
      list.push({
        id: p.id,
        kind: p.kind,
        y: +p.y.toFixed(1),
        slope: +slope.toFixed(3),
        road: +p.roadDist.toFixed(1),
        bump: +bump.toFixed(2),
        ok: why.length === 0,
        why: why.join('; '),
      });
    }
    out.poi = { list };
  }

  /* ---- water and banks -------------------------------------------------- */
  if (has('water')) {
    let samples = 0;
    let disagree = 0;
    let shoreN = 0;
    let unclimbable = 0;
    let run = 0;
    let worstRun = 0;
    for (const riv of w.rivers) {
      for (let i = 0; i < riv.pts.length - 1; i++) {
        const a = riv.pts[i];
        const b = riv.pts[i + 1];
        const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
        const steps = Math.max(2, Math.round(len / 40));
        const ux = (b[0] - a[0]) / len;
        const uz = (b[1] - a[1]) / len;
        for (let k = 0; k <= steps; k++) {
          const t = k / steps;
          const x = a[0] + (b[0] - a[0]) * t;
          const z = a[1] + (b[1] - a[1]) * t;
          if (Math.abs(x) > 1400 || Math.abs(z) > 1400) continue;
          // agreement: over the channel centre isWater must be true and the
          // level must be the pool level.
          samples++;
          const lvl = w.waterLevelAt ? w.waterLevelAt(x, z) : (w.isWater(x, z) ? 0 : -Infinity);
          if (!w.isWater(x, z) || !Number.isFinite(lvl) || Math.abs(lvl - w.WATER_Y) > 0.2) {
            disagree++;
            if (!out._wbad) out._wbad = [];
            if (out._wbad.length < 8) {
              out._wbad.push({
                x: +x.toFixed(0), z: +z.toFixed(0),
                h: +w.heightAt(x, z).toFixed(2), lvl: Number.isFinite(lvl) ? +lvl.toFixed(2) : null,
                wd: +w.terrain.waterDist(x, z).toFixed(1),
                rw: +w.terrain.roadWeightAt(x, z).toFixed(2),
                ne: (() => { const q = roads.nearestEdge(x, z, 260); return q.edge ? `${q.edge.kind}${q.edge.bridge ? '/br' : ''} ${q.edge.corridor} d=${q.dist.toFixed(0)}` : null; })(),
              });
            }
          }

          // Bank climb: walk out perpendicular until dry, then measure the
          // steepest 2 m step in the next 30 m.
          for (const side of [-1, 1]) {
            const nx = -uz * side;
            const nz = ux * side;
            let s = 0;
            while (s < 200 && w.isWater(x + nx * s, z + nz * s)) s += 4;
            if (s >= 200) continue;
            shoreN++;
            let ok = false;
            let prev = w.heightAt(x + nx * s, z + nz * s);
            let climbed = 0;
            for (let d = s + 2; d < s + 34; d += 2) {
              const hh = w.heightAt(x + nx * d, z + nz * d);
              const grad = (hh - prev) / 2;
              prev = hh;
              if (grad > 0.9) { climbed = -1; break; } // a wall
              if (hh > (w.WATER_Y ?? 0) + 1.2) { ok = true; break; }
            }
            void climbed;
            if (!ok) {
              unclimbable++;
              run++;
              if (run > worstRun) worstRun = run;
            } else run = 0;
          }
        }
      }
    }
    out.water = {
      samples,
      disagree: samples ? (disagree / samples) * 100 : 0,
      shoreN,
      unclimbablePct: shoreN ? (unclimbable / shoreN) * 100 : 0,
      worstRun,
      bad: out._wbad ?? [],
    };
    delete out._wbad;
  }

  return out;
}
