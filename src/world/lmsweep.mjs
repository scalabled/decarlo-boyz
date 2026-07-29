#!/usr/bin/env node
/**
 * WORLD — "is there a road through a landmark?" assertion, over the whole
 * emitted road graph.
 *
 * `src/buildings/roadsweep.mjs` measured 114 drivable directions with every
 * lane blocked at one station, and every one of them was a road this file's
 * subsystem laid across one of the six hand-authored landmark sites whose
 * coordinates `world/plan.js` publishes: three highway segments and an alley
 * through the Steel Bowl's pier ring, a street 4.4 m from the centre of the
 * Strip Market, a parkway whose lane edge sits 2.2 m inside the Steel Tower's
 * podium. `netgen.reserveLandmarks` now cuts those corridors and lays a ring
 * road on the reserve isoline instead. This is the gate on that.
 *
 * WHAT IT MEASURES, AND WHY IT IS NOT CIRCULAR (ARCHITECTURE.md rule 12)
 *
 * The reservation runs on CORRIDOR POLYLINES, before the planar solver. What
 * comes out the far end is a different object: `dedupeCorridors` cuts and
 * merge-tapers, `buildGraph` splits every corridor at every intersection,
 * `simplify` drops vertices within 1.6 m of the chord, `nodeAt` WELDS any two
 * points within 7 m into one node, `limitGrades` and `relaxHeights` move
 * heights, and `pruneIslands` deletes whole fragments. Any of those can put a
 * node back inside a site that the corridor pass took out of it.
 *
 * So nothing here reads a corridor, a reserve distance, or `plan.js`'s own
 * `siteDist`. It reads `world.roads` — the EMITTED nodes and edges — walks
 * every lane a driver can be in via `roads.laneCenter`, and measures those
 * positions against the published site table with a rounded-box field written
 * independently in this file. If `plan.js` and this file disagree about what
 * `yaw` means, this goes red.
 *
 * Three assertions:
 *
 *   carriageway   no emitted edge's carriageway (its own `width`, the number
 *                 `roadmesh` paves and `traffic` drives) overlaps a site
 *   driver        no lane centre `roads.laneCenter` hands out, widened by half
 *                 a truck, reaches into a site. This is the player-facing one:
 *                 it is the same 2.6 m corridor `roadsweep.mjs` uses, so the
 *                 two gates are asking the same question of the road graph and
 *                 of the emitted triangles
 *   connected     reserving ground must not island a district. Union over the
 *                 drivable (non-rail) edges: share of nodes and of kilometres
 *                 in the largest component, and every bridge deck and every
 *                 POI node in it
 *
 * ...plus a SELF-CHECK that fires on every run: a synthetic lane sample is
 * planted at the centre of each site and the same measurement must report it
 * as a violation. A gate that cannot be made to fail is decorative, and this
 * one says so out loud before it reports a pass.
 *
 * Usage
 *   node src/world/lmsweep.mjs
 *   node src/world/lmsweep.mjs --json=/tmp/lm.json
 *   node src/world/lmsweep.mjs --width=2.6        vehicle width, metres
 *
 * NEGATIVE CONTROL — lay every corridor as authored, straight through the six
 * sites, and watch it go red:
 *   node src/world/lmsweep.mjs --noreserve
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

/** The widest thing a player drives: `truck` is 2.6 m across. Same as roadsweep. */
const VEH_W = Number(args.width ?? 2.6);
const STEP = Number(args.step ?? 1.0);
const NORESERVE = !!args.noreserve;

/**
 * RATCHET (ARCHITECTURE.md rule 13). The share of the drivable network that
 * has to sit in ONE connected component.
 *
 * The goal is 100%, and the residual is not the reservation's doing. Measured
 * on the build this landed on, the same seven islands and the same 46 stranded
 * nodes appear in BOTH arms — a grid rail that runs off the map edge at
 * (-1409,-908), one that dies on the West End hillside, and five smaller ones:
 *
 *   reservation ON   3228 nodes / 174.12 km   98.57% of nodes, 98.73% of km
 *   reservation OFF  3244 nodes / 177.24 km   98.58% of nodes, 98.75% of km
 *
 * So reserving the six sites cost 0.01 percentage points of node connectivity
 * and islanded nothing: the island list is identical in both arms, down to the
 * node counts. That is what the ring roads are for — every street cut at a
 * site runs into the road round it instead of dead-ending at a wall.
 *
 * LOWER THESE WHEN YOU IMPROVE THEM; NEVER RAISE ONE TO GO GREEN.
 */
const MIN_NODE_SHARE = 98.5;
const MIN_KM_SHARE = 98.7;

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
  const extra = NORESERVE ? '&nolmreserve=1' : '';
  await page.goto(`http://127.0.0.1:${PORT}/?capture=1&lockstep=1&prewarm=0&q=high${extra}`, {
    waitUntil: 'domcontentloaded',
    timeout: 120000,
  });
  await page.waitForFunction('window.__READY__ === true', null, { timeout: 240000 });

  report = await page.evaluate(
    ({ vehW, step }) => {
      const w = window.__ENGINE__?.ctx?.peek('world');
      const roads = w?.roads;
      if (!roads) return { error: 'no world/roads' };
      const sites = (w.landmarks ?? []).filter((l) => l.site);
      if (!sites.length) return { error: 'world publishes no landmark sites' };

      /**
       * The rounded-box field, written here rather than imported, so this gate
       * is an independent reading of the published spec and not an echo of the
       * production code's own arithmetic. Exact for a disc (hx = hz = 0), a
       * capsule (hx = 0) and an oriented box.
       */
      const sd = (lm, x, z) => {
        const s = lm.site;
        const dx = x - lm.x - s.ox;
        const dz = z - lm.z - s.oz;
        const c = Math.cos(s.yaw);
        const sn = Math.sin(s.yaw);
        const px = Math.abs(dx * c + dz * sn) - s.hx;
        const pz = Math.abs(dz * c - dx * sn) - s.hz;
        const ax = px > 0 ? px : 0;
        const az = pz > 0 ? pz : 0;
        return Math.sqrt(ax * ax + az * az) + Math.min(Math.max(px, pz), 0) - s.r;
      };

      const HALF = vehW * 0.5;
      const perSite = {};
      for (const lm of sites) {
        perSite[lm.id] = {
          id: lm.id, name: lm.name, x: lm.x, z: lm.z,
          minCarriage: Infinity, minDriver: Infinity, minCentre: Infinity,
          tightest: null,
          carriageHits: 0, driverHits: 0, nearestLane: Infinity, nearestEdge: null,
        };
      }

      /**
       * One lane sample against every site. `need` is how much clear ground
       * this sample demands; the shortfall is reported in metres so a failure
       * says how far in it reached, not merely that it did.
       */
      const worstCarriage = [];
      const worstDriver = [];
      const measure = (x, z, ed, lane, t, carriageNeed, driverNeed) => {
        for (const lm of sites) {
          const d = sd(lm, x, z);
          const p = perSite[lm.id];
          if (d < p.minCentre) p.minCentre = d;
          if (d - carriageNeed < p.minCarriage) {
            p.minCarriage = d - carriageNeed;
            p.tightest = { edge: ed, lane, x: +x.toFixed(1), z: +z.toFixed(1) };
          }
          if (d - driverNeed < p.minDriver) p.minDriver = d - driverNeed;
          if (d < carriageNeed) {
            p.carriageHits++;
            if (worstCarriage.length < 400) {
              worstCarriage.push({
                site: lm.id, edge: ed, lane, t: +t.toFixed(3),
                x: +x.toFixed(1), z: +z.toFixed(1),
                into: +(carriageNeed - d).toFixed(2),
              });
            }
          }
          if (d < driverNeed) {
            p.driverHits++;
            if (worstDriver.length < 400) {
              worstDriver.push({
                site: lm.id, edge: ed, lane, t: +t.toFixed(3),
                x: +x.toFixed(1), z: +z.toFixed(1),
                into: +(driverNeed - d).toFixed(2),
              });
            }
          }
        }
      };

      /* ---- 1 + 2. every lane of every drivable edge ---------------------- */
      const out = { x: 0, y: 0, z: 0 };
      let edgesSwept = 0;
      let lanesSwept = 0;
      let samples = 0;
      for (const ed of roads.edges) {
        if (ed.rail) continue;
        const len = ed.len ?? 0;
        if (len < 0.5) continue;
        edgesSwept++;
        const na = roads.nodes[ed.a];
        const nb = roads.nodes[ed.b];
        if (!na || !nb) continue;
        const nS = Math.max(2, Math.ceil(len / step));
        // The CARRIAGEWAY is measured on the centreline, using the edge's own
        // emitted `width` — the number roadmesh paves and nearestEdge answers
        // with. The DRIVER is measured on each lane centre the graph hands out.
        const halfW = (ed.width ?? 8) * 0.5;
        for (let s = 0; s <= nS; s++) {
          const t = s / nS;
          const cx = na.x + (nb.x - na.x) * t;
          const cz = na.z + (nb.z - na.z) * t;
          measure(cx, cz, ed.id, -1, t, halfW, -1e9);
          samples++;
        }
        for (let lane = 0; lane < ed.lanes; lane++) {
          lanesSwept++;
          const need = (ed.laneWidth ?? 3.3) * 0.5 + HALF;
          for (let s = 0; s <= nS; s++) {
            const t = s / nS;
            roads.laneCenter(ed, lane, t, out);
            measure(out.x, out.z, ed.id, lane, t, -1e9, need);
            samples++;
          }
        }
      }

      /* ---- how close a car can still get to each landmark ---------------- */
      for (const lm of sites) {
        const p = perSite[lm.id];
        for (const ed of roads.edges) {
          if (ed.rail) continue;
          const na = roads.nodes[ed.a];
          const nb = roads.nodes[ed.b];
          if (!na || !nb) continue;
          const dx = nb.x - na.x;
          const dz = nb.z - na.z;
          const l2 = dx * dx + dz * dz || 1;
          let t = ((lm.x - na.x) * dx + (lm.z - na.z) * dz) / l2;
          t = t < 0 ? 0 : t > 1 ? 1 : t;
          const d = Math.hypot(na.x + dx * t - lm.x, na.z + dz * t - lm.z);
          if (d < p.nearestLane) {
            p.nearestLane = d;
            p.nearestEdge = { id: ed.id, kind: ed.kind, corridor: ed.corridor ?? null };
          }
        }
      }

      /* ---- 3. connectivity over the drivable graph ----------------------- */
      const N = roads.nodes.length;
      const comp = new Int32Array(N).fill(-1);
      const compKm = [];
      const compN = [];
      const stack = [];
      let nc = 0;
      let liveNodes = 0;
      let totalKm = 0;
      for (const ed of roads.edges) if (!ed.rail) totalKm += ed.len ?? 0;
      for (let i = 0; i < N; i++) {
        const n0 = roads.nodes[i];
        if (comp[i] !== -1) continue;
        let drivable = false;
        for (const eid of n0.links) if (!roads.edges[eid].rail) drivable = true;
        if (!drivable) continue;
        let size = 0;
        let km = 0;
        stack.length = 0;
        stack.push(i);
        comp[i] = nc;
        while (stack.length) {
          const cur = stack.pop();
          size++;
          const node = roads.nodes[cur];
          for (const eid of node.links) {
            const e2 = roads.edges[eid];
            if (e2.rail) continue;
            km += (e2.len ?? 0) * 0.5; // each edge is walked from both ends
            const o = e2.a === cur ? e2.b : e2.a;
            if (comp[o] === -1) {
              comp[o] = nc;
              stack.push(o);
            }
          }
        }
        compN.push(size);
        compKm.push(km);
        liveNodes += size;
        nc++;
      }
      let main = 0;
      for (let i = 1; i < nc; i++) if (compN[i] > compN[main]) main = i;
      const islands = [];
      for (let i = 0; i < nc; i++) {
        if (i === main) continue;
        let ex = 0;
        let ez = 0;
        for (let k = 0; k < N; k++) {
          if (comp[k] === i) {
            ex = roads.nodes[k].x;
            ez = roads.nodes[k].z;
            break;
          }
        }
        islands.push({ nodes: compN[i], km: +(compKm[i] / 1000).toFixed(2), x: Math.round(ex), z: Math.round(ez) });
      }
      islands.sort((a, b) => b.nodes - a.nodes);

      // Every bridge deck and every POI has to be ON the main component: a
      // reserved site that islands a crossing is a worse defect than the one
      // being fixed.
      const bridgesOff = [];
      const seenBr = new Set();
      for (const ed of roads.edges) {
        if (!ed.bridge || !ed.bridgeId || seenBr.has(ed.bridgeId)) continue;
        seenBr.add(ed.bridgeId);
        if (comp[ed.a] !== main && comp[ed.b] !== main) bridgesOff.push(ed.bridgeId);
      }
      const poisOff = [];
      for (const p of w.pois ?? []) {
        if (!p.ok) {
          poisOff.push({ id: p.id, why: 'unresolved' });
          continue;
        }
        if (p.node >= 0 && comp[p.node] !== main) poisOff.push({ id: p.id, why: 'islanded' });
      }

      /* ---- SELF-CHECK: the measurement must be able to say no ------------ */
      const selftest = [];
      for (const lm of sites) {
        const cx = lm.x + lm.site.ox;
        const cz = lm.z + lm.site.oz;
        const d = sd(lm, cx, cz);
        // A lane laid across the middle of the site: the field must report the
        // sample as inside by at least the site's own corner radius.
        selftest.push({ id: lm.id, atCentre: +d.toFixed(2), fires: d < -1 });
      }

      return {
        noreserve: !!new URLSearchParams(location.search).get('nolmreserve'),
        reserveOn: roads.landmarkReserve?.on !== false,
        reserve: roads.landmarkReserve ?? null,
        clearance: w.landmarkClearance ?? null,
        vehW,
        edgesSwept,
        lanesSwept,
        samples,
        sites: Object.values(perSite).map((p) => ({
          ...p,
          minCarriage: +p.minCarriage.toFixed(2),
          minDriver: +p.minDriver.toFixed(2),
          minCentre: +p.minCentre.toFixed(2),
          nearestLane: +p.nearestLane.toFixed(1),
        })),
        carriageHits: worstCarriage.length ? Object.values(perSite).reduce((s, p) => s + p.carriageHits, 0) : 0,
        driverHits: Object.values(perSite).reduce((s, p) => s + p.driverHits, 0),
        worstCarriage: worstCarriage.sort((a, b) => b.into - a.into).slice(0, 16),
        worstDriver: worstDriver.sort((a, b) => b.into - a.into).slice(0, 16),
        conn: {
          nodes: liveNodes,
          edges: roads.edges.filter((e) => !e.rail).length,
          km: +(totalKm / 1000).toFixed(2),
          components: nc,
          mainNodes: compN[main] ?? 0,
          mainKm: +((compKm[main] ?? 0) / 1000).toFixed(2),
          nodeShare: +((100 * (compN[main] ?? 0)) / Math.max(1, liveNodes)).toFixed(2),
          kmShare: +((100 * (compKm[main] ?? 0)) / Math.max(1, totalKm)).toFixed(2),
          islands: islands.slice(0, 10),
          bridgesOff,
          poisOff,
        },
        selftest,
      };
    },
    { vehW: VEH_W, step: STEP }
  );
} catch (e) {
  failure = e;
} finally {
  await browser.close();
  server.kill();
}

if (failure) {
  console.error(`[lmsweep] FAILED: ${failure.message}`);
  if (errors.length) console.error(errors.slice(0, 8).join('\n'));
  process.exit(2);
}
if (report?.error) {
  console.error(`[lmsweep] ${report.error}`);
  if (errors.length) console.error(errors.slice(0, 6).join('\n'));
  process.exit(2);
}

if (args.json) {
  mkdirSync(dirname(resolve(String(args.json))), { recursive: true });
  writeFileSync(resolve(String(args.json)), JSON.stringify(report, null, 2));
}

const arm = report.noreserve || !report.reserveOn
  ? 'NEGATIVE CONTROL — landmark reservation OFF (?nolmreserve=1)'
  : 'shipped';
console.log(`world landmark sweep — ${arm}`);
console.log(`  reserve:               ${report.clearance} m clear of every site` +
  (report.reserve?.on
    ? `, cut ${report.reserve.cutKm.toFixed(2)} km from ${report.reserve.cut} corridors, ` +
      `${report.reserve.dropped} stubs dropped, ${report.reserve.exempt} exempt corridor(s) crossing`
    : ' — OFF'));
console.log(`  swept:                 ${report.edgesSwept} drivable edges, ${report.lanesSwept} lanes, ` +
  `${report.samples} samples at ${STEP} m`);
console.log('');
console.log(`  per site (clearance in metres; negative = the road is IN the site)`);
// `closest` is the raw distance of the nearest sampled point of any kind, so
// the two clearance columns can be read against how far the road actually is.
console.log('    ' + 'site'.padEnd(13) + 'carriageway'.padStart(12) + 'driver'.padStart(10) +
  'closest'.padStart(12) + 'nearest lane'.padStart(14) + '  hits');
for (const s of report.sites) {
  console.log('    ' + s.id.padEnd(13) +
    s.minCarriage.toFixed(2).padStart(12) +
    s.minDriver.toFixed(2).padStart(10) +
    s.minCentre.toFixed(2).padStart(12) +
    `${s.nearestLane.toFixed(1)} m`.padStart(14) +
    `  ${s.carriageHits} / ${s.driverHits}` +
    (s.nearestEdge ? `   (${s.nearestEdge.kind} #${s.nearestEdge.id} ${s.nearestEdge.corridor ?? ''})` : ''));
  if (s.tightest) {
    console.log('                 tightest carriageway: edge ' +
      `${s.tightest.edge} @ ${s.tightest.x},${s.tightest.z}`);
  }
}
if (report.worstCarriage.length) {
  console.log('    worst carriageway intrusions:');
  for (const h of report.worstCarriage.slice(0, 10)) {
    console.log(`      ${h.into.toFixed(2)} m into ${h.site}  edge ${h.edge} @ ${h.x},${h.z}`);
  }
}
if (report.worstDriver.length) {
  console.log('    worst driver-corridor intrusions:');
  for (const h of report.worstDriver.slice(0, 10)) {
    console.log(`      ${h.into.toFixed(2)} m into ${h.site}  edge ${h.edge} lane ${h.lane} @ ${h.x},${h.z}`);
  }
}
console.log('');
const C = report.conn;
console.log('  CONNECTIVITY over the drivable graph');
console.log(`    ${C.nodes} nodes / ${C.edges} edges / ${C.km} km in ${C.components} component(s)`);
console.log(`    largest component:   ${C.mainNodes} nodes (${C.nodeShare}%), ${C.mainKm} km (${C.kmShare}%)`);
if (C.islands.length) {
  console.log('    islands: ' + C.islands.map((i) => `${i.nodes}n/${i.km}km @(${i.x},${i.z})`).join(' · '));
}
console.log(`    bridges off the main component: ${C.bridgesOff.length ? C.bridgesOff.join(', ') : 'none'}`);
console.log(`    POIs off it or unresolved:      ${C.poisOff.length ? JSON.stringify(C.poisOff) : 'none'}`);
console.log('');
const selfOk = report.selftest.every((s) => s.fires);
console.log(`  SELF-CHECK — a lane planted at each site centre must read as a violation: ` +
  `${selfOk ? 'all 6 fire' : 'BROKEN'}  ` +
  report.selftest.map((s) => `${s.id}:${s.atCentre}`).join(' '));

const fails = [];
if (!selfOk) fails.push('the site field does not report a lane at a site centre as inside it — this gate is decorative');
const carriage = report.sites.reduce((s, p) => s + p.carriageHits, 0);
const driver = report.sites.reduce((s, p) => s + p.driverHits, 0);
if (carriage > 0) fails.push(`${carriage} carriageway sample(s) inside a landmark site`);
if (driver > 0) fails.push(`${driver} driver-corridor sample(s) inside a landmark site`);
if (C.nodeShare < MIN_NODE_SHARE) {
  fails.push(`only ${C.nodeShare}% of drivable nodes are in one component (RATCHET ${MIN_NODE_SHARE}%)`);
}
if (C.kmShare < MIN_KM_SHARE) {
  fails.push(`only ${C.kmShare}% of drivable km is in one component (RATCHET ${MIN_KM_SHARE}%)`);
}
if (C.bridgesOff.length) fails.push(`bridge(s) islanded: ${C.bridgesOff.join(', ')}`);
if (C.poisOff.length) fails.push(`POI(s) islanded or unresolved: ${C.poisOff.map((p) => p.id).join(', ')}`);

console.log('');
if (fails.length === 0) {
  console.log('LANDMARK GATE PASSED — no drivable carriageway and no lane a truck could use ' +
    'reaches into any of the six published landmark sites, and the city is still one network.');
} else {
  console.log(`LANDMARK GATE FAILED — ${fails.join('; ')}`);
}
if (errors.length) console.log('  page errors:', [...new Set(errors)].slice(0, 4));
process.exit(fails.length === 0 ? 0 : 1);
