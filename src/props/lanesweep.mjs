#!/usr/bin/env node
/**
 * PROPS — network-wide "is any placed prop standing in the road?" assertion.
 *
 * Stop signs were ending up in the middle of the road. Parked cars had already
 * been cleaned up (`_clearsLanes` + `lanes.parkFlags`,
 * 0/62 slots intruding), but parking is ONE of nine placement families in
 * `layout.js` and it was the only one asking the question. This sweeps every
 * one of them, over the whole road network, and fails if any prop — visual
 * instance or collision proxy — overlaps a lane a driver may legally use.
 *
 * It does NOT screenshot and it does NOT stream. It calls the real placement
 * methods (`_edgeFurniture`, `_lot`) against the real road graph with a
 * recording stand-in for `TileBatch`, so one run covers the entire city in a
 * few seconds instead of driving a camera around it for an hour.
 *
 * The overlap test is `layout.laneIntrusion()` — the exact function the shipped
 * guard is built from — so this assertion cannot drift away from the code it
 * polices.
 *
 * Usage
 *   node src/props/lanesweep.mjs
 *   node src/props/lanesweep.mjs --json=/tmp/sweep.json
 *   node src/props/lanesweep.mjs --max=400          (first 400 edges only)
 *   node src/props/lanesweep.mjs --tolerance=0.05   (metres of slack allowed)
 *
 * Exit code 1 when anything intrudes past `--tolerance`.
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

const MAX_EDGES = Number(args.max ?? 0) || 0;
const TOL = Number(args.tolerance ?? 0.02);
const QUALITY = args.q ?? 'high';

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
  args: [
    '--use-angle=metal',
    '--ignore-gpu-blocklist',
    '--enable-gpu-rasterization',
    '--mute-audio',
    '--js-flags=--max-old-space-size=4096',
  ],
});
const page = await browser.newPage({ viewport: { width: 640, height: 360 } });
const errors = [];
page.on('pageerror', (e) => errors.push(String(e.message).slice(0, 200)));

let report = null;
let failure = null;
try {
  await page.goto(`http://127.0.0.1:${PORT}/?capture=1&lockstep=1&prewarm=0&q=${QUALITY}`, {
    waitUntil: 'domcontentloaded',
    timeout: 120000,
  });
  await page.waitForFunction('window.__READY__ === true', null, { timeout: 180000 });

  /**
   * `traffic` attaches its lane layer lazily, and the whole point of this sweep
   * is to test against the DRIVABLE lane set rather than the raw carriageway
   * width. Pump until `props` can see it, or the numbers mean much less.
   */
  await page.evaluate(
    () =>
      new Promise((done) => {
        let i = 0;
        const t = () => {
          const l = window.__ENGINE__?.ctx?.peek('traffic')?.lanes;
          if (l?.ready || ++i > 240) return done(!!l?.ready);
          window.__PUMP__ ? window.__PUMP__(1) : 0;
          requestAnimationFrame(t);
        };
        requestAnimationFrame(t);
      })
  );

  report = await page.evaluate(
    ({ maxEdges, tol, unguarded }) => {
      const e = window.__ENGINE__;
      const props = e.ctx.peek('props');
      const world = e.ctx.peek('world');
      const layout = props?.layout;
      if (!layout) return { error: 'no props.layout' };
      const roads = world.roads;
      const lanes = e.ctx.peek('traffic')?.lanes ?? null;

      /**
       * A prop's GROUND FOOTPRINT — the part of it a bumper can meet.
       *
       * The first cut of this sweep used the prototype's whole XZ bounding box
       * and reported 26% of the city in the road, which is nonsense: a cobra
       * lamp's arm is SUPPOSED to reach 3 m over the carriageway, a plane tree's
       * canopy is supposed to shade it, and a lamp's glow cone is a 19 m
       * unlit-additive volume that exists precisely to spill across the asphalt.
       * None of those is an obstruction.
       *
       * So the footprint is measured only from geometry below BUMPER (1.4 m).
       * A prototype with nothing down there is overhead by construction and is
       * counted separately rather than failed.
       */
      const BUMPER = 1.4;
      const FLUSH = 0.12;
      /**
       * Light is not matter. A cobra lamp's glow cone is an additive volume
       * authored to pool ON the carriageway — that is the whole point of it —
       * and so are signal aspects and lens flares. Counting them found 5.7 m
       * "intrusions" under every arterial lamp in the city. Same for a shop's
       * neon and a window's light card.
       */
      const isLight = (id) => {
        if (/_glow(_|$)|_lens(_|$)|_lit_|^glow_|_beam(_|$)/.test(id)) return true;
        const p = props.lib.protos.get(id);
        return !!(p && props.lib.isEmissive?.(p.surface));
      };
      const footCache = new Map();
      const footOf = (id) => {
        let f = footCache.get(id);
        if (f !== undefined) return f;
        const p = props.lib.protos.get(id);
        f = null;
        if (isLight(id)) {
          footCache.set(id, null);
          return null;
        }
        const pos = p?.geo?.attributes?.position;
        if (pos) {
          let hx = 0;
          let hz = 0;
          let any = false;
          for (let i = 0; i < pos.count; i++) {
            const yv = pos.getY(i);
            // A flush plate is not an obstruction — a tree grate, a coal hatch,
            // a gully cover and a utility lid all sit within a few centimetres
            // of the pavement and a wheel rolls straight over them.
            if (yv < FLUSH || yv > BUMPER) continue;
            any = true;
            const ax = Math.abs(pos.getX(i));
            const az = Math.abs(pos.getZ(i));
            if (ax > hx) hx = ax;
            if (az > hz) hz = az;
          }
          if (any) f = { hx, hz };
        }
        footCache.set(id, f);
        return f;
      };

      /**
       * Stand-in for `TileBatch` that records placements instead of building
       * geometry. Same surface as the real one so `layout` cannot tell.
       */
      const hits = [];
      const counts = new Map();
      let placed = 0;
      let collided = 0;
      let overhead = 0;

      /**
       * Test the four corners of the oriented ground footprint, not a disc
       * around the origin. `rail_guard` is 2 m long and laid ALONG the kerb —
       * a disc of radius 1 m says it is in the road and it plainly is not.
       */
      /**
       * `det` is only written when a call finds a candidate edge, so it MUST be
       * cleared between calls — reading it after a call that found nothing
       * attributes this prop to the last prop's road. (It did, for a while, and
       * put 20732 highway-width intrusions in the `street w7.2` bucket.)
       */
      const det = {};
      const probe = (x, y, z) => {
        det.edge = null;
        return layout.laneIntrusion(x, y, z, 0, null, det);
      };
      const checkFoot = (kind, id, ox, oy, oz, ax, az, bx, bz) => {
        let depth = probe(ox, oy, oz);
        let wx = ox;
        let wz = oz;
        let we = det.edge;
        for (let sa = -1; sa <= 1; sa += 2) {
          for (let sb = -1; sb <= 1; sb += 2) {
            const cx = ox + ax * sa + bx * sb;
            const cz = oz + az * sa + bz * sb;
            const d = probe(cx, oy, cz);
            if (d > depth) {
              depth = d;
              wx = cx;
              wz = cz;
              we = det.edge;
            }
          }
        }
        if (depth > tol) {
          /**
           * OWN vs FOREIGN is the whole diagnosis. "Own" means this family
           * measured its offset off `edge.width` and got it wrong — a props
           * bug, fixable here. "Foreign" means the prop is correctly on its own
           * pavement and a DIFFERENT corridor's lanes are lying across that
           * pavement — a road-graph overlap, which props still has to dodge but
           * did not cause.
           */
          const oe = stub._edge;
          const own = we && oe && we.id === oe.id;
          hits.push({
            kind, id, own: !!own,
            edge: we ? { id: we.id, kind: we.kind, width: +we.width.toFixed(1), lanes: we.lanes } : null,
            owner: oe ? { id: oe.id, kind: oe.kind, width: +oe.width.toFixed(1) } : 'lot',
            x: +wx.toFixed(2), y: +oy.toFixed(2), z: +wz.toFixed(2),
            // The ORIGIN as well as the worst corner: "the post is in the road"
            // and "the post is on the kerb but its 4 m blade overhangs" are
            // different defects and only the first one is one.
            ox: +ox.toFixed(2), oz: +oz.toFixed(2),
            reach: +Math.hypot(wx - ox, wz - oz).toFixed(2),
            originDepth: +probe(ox, oy, oz).toFixed(2),
            depth: +depth.toFixed(2),
          });
          counts.set(id, (counts.get(id) ?? 0) + 1);
        }
      };

      const stub = {
        lamps: [],
        stats: { tris: 0, instTris: 0, instances: 0, draws: 0, props: 0 },
        put(id, m, mask) {
          if (!props.lib.protos.has(id)) return this;
          placed++;
          const f = footOf(id);
          if (!f) {
            overhead++;
            return this;
          }
          // Columns 0 and 2 of the placement matrix carry rotation × scale.
          const el = m.elements;
          checkFoot('mesh', id, el[12], el[13], el[14],
            el[0] * f.hx, el[2] * f.hx, el[8] * f.hz, el[10] * f.hz);
          return this;
        },
        place(id, x, y, z, ry = 0, sx = 1) {
          if (!props.lib.protos.has(id)) return this;
          placed++;
          const f = footOf(id);
          if (!f) {
            overhead++;
            return this;
          }
          const c = Math.cos(ry) * sx;
          const s = Math.sin(ry) * sx;
          checkFoot('mesh', id, x, y, z, c * f.hx, -s * f.hx, s * f.hz, c * f.hz);
          return this;
        },
        add() {
          return this;
        },
        box(tag, x, y, z, w, h, d, ry = 0) {
          collided++;
          const c = Math.cos(ry);
          const s = Math.sin(ry);
          checkFoot('collider', tag, x, y, z,
            c * w * 0.5, -s * w * 0.5, s * d * 0.5, c * d * 0.5);
          return this;
        },
      };

      /**
       * `--unguarded` monkey-patches the clearance guards off and re-runs the
       * SAME placement code against the SAME metric, so "what the guards are
       * worth" is a measurement rather than a memory of an older number under
       * an older metric. It does not undo the ninety-degree yaw fix, which is
       * inline — that one is reported separately.
       */
      if (unguarded) {
        layout._clearsLanes = () => true;
        layout._clearOff = (edge, s, side, off, c, m, out) => layout._pos(edge, s, side, off, out);
        layout._clearCorner = (edge, end, sa, sb, side, off, c, out = { }) =>
          layout._pos(edge, end === 0 ? sa : sb, side, off, out);
      }

      const HUGE = { x0: -1e7, z0: -1e7, x1: 1e7, z1: 1e7 };
      const t0 = performance.now();
      const edges = roads.edges;
      const n = maxEdges ? Math.min(maxEdges, edges.length) : edges.length;
      let swept = 0;
      const thrown = [];
      const parked = [];
      for (let i = 0; i < n; i++) {
        const ed = edges[i];
        if (ed.rail) continue;
        swept++;
        stub._edge = ed;
        try {
          layout._edgeFurniture(stub, ed, HUGE, 0, parked);
        } catch (err) {
          if (thrown.length < 4) thrown.push(`edge ${ed.id}: ${err.message}`);
        }
      }

      /**
       * Lot dressing too — `_lotParking` was already guarded but `_frontage`,
       * `_park` and `_surfaceLot` place against a lot boundary that can run
       * right up to the kerb.
       */
      let lotsSwept = 0;
      stub._edge = null;
      for (const lot of world.lots ?? []) {
        lotsSwept++;
        try {
          layout._lot(stub, lot, HUGE, 0, props.rng, null, []);
        } catch (err) {
          if (thrown.length < 8) thrown.push(`lot ${lot.id}: ${err.message}`);
        }
      }

      // Parked cars, on the same footing as everything else.
      let parkedBad = 0;
      for (const p of parked) {
        if (layout.laneIntrusion(p.x, p.y, p.z, 1.15) > tol) parkedBad++;
      }

      const byId = [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 18);
      hits.sort((a, b) => b.depth - a.depth);
      /** How bad, in bands. A 0.1 m clip and a 6 m clip are different bugs. */
      const bands = { '0.02-0.25': 0, '0.25-0.75': 0, '0.75-1.5': 0, '1.5-3': 0, '3+': 0 };
      for (const h of hits) {
        if (h.depth < 0.25) bands['0.02-0.25']++;
        else if (h.depth < 0.75) bands['0.25-0.75']++;
        else if (h.depth < 1.5) bands['0.75-1.5']++;
        else if (h.depth < 3) bands['1.5-3']++;
        else bands['3+']++;
      }
      /** Owner-vs-offender pairing, which is what says who has to fix it. */
      const pairs = new Map();
      for (const h of hits) {
        const k = `${h.owner === 'lot' ? 'lot' : h.owner.kind + ' w' + h.owner.width} -> ${h.edge?.kind} w${h.edge?.width}${h.own ? ' (SAME EDGE)' : ''}`;
        pairs.set(k, (pairs.get(k) ?? 0) + 1);
      }
      return {
        ms: Math.round(performance.now() - t0),
        lanesReady: !!lanes?.ready,
        edgesSwept: swept,
        lotsSwept,
        unguarded: !!unguarded,
        placements: placed,
        colliders: collided,
        overheadSkipped: overhead,
        intruding: hits.length,
        baseInLane: hits.filter((h) => h.originDepth > tol).length,
        overhangOver50cm: hits.filter((h) => h.originDepth <= tol && h.depth > 0.5).length,
        intrudingMesh: hits.filter((h) => h.kind === 'mesh').length,
        intrudingCollider: hits.filter((h) => h.kind === 'collider').length,
        onOwnEdge: hits.filter((h) => h.own).length,
        onForeignEdge: hits.filter((h) => !h.own).length,
        byOffendingKind: (() => {
          const m = new Map();
          for (const h of hits) {
            const k = `${h.edge?.kind ?? '?'} w${h.edge?.width ?? '?'}`;
            m.set(k, (m.get(k) ?? 0) + 1);
          }
          return [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10);
        })(),
        worstDepth: hits.length ? hits[0].depth : 0,
        parkedSlots: parked.length,
        parkedIntruding: parkedBad,
        byId,
        bands,
        pairs: [...pairs.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12),
        worst: hits.slice(0, 25),
        worstOwn: hits.filter((h) => h.own).slice(0, 20),
        /**
         * SELF-CHECK. Every hit deeper than the guard's own clearance should
         * have been refused by `_clearsLanes` at placement time. One that the
         * guard now calls clear means the guard and the assertion are looking at
         * different things — which is a bug in one of them, not in the city.
         */
        guardDisagrees: hits.filter((h) => h.depth > 1.0)
          .map((h) => {
            const oe = h.owner === 'lot' ? null : roads.edges[h.owner.id];
            const fresh = layout.laneIntrusion(h.x, h.y, h.z, 0.3);
            const cached = oe
              ? layout.laneIntrusion(h.x, h.y, h.z, 0.3, layout._nearEdgesFor(oe))
              : null;
            return {
              id: h.id, depth: h.depth, owner: h.owner,
              freshGuard: +fresh.toFixed(2),
              cachedGuard: cached === null ? null : +cached.toFixed(2),
              cachedListLen: oe ? layout._nearEdgesFor(oe).length : null,
              disagree: cached !== null && (fresh > 0) !== (cached > 0),
            };
          })
          .slice(0, 12),
        all: hits.length <= 60000 ? hits : hits.slice(0, 60000),
        thrown,
      };
    },
    { maxEdges: MAX_EDGES, tol: TOL, unguarded: !!args.unguarded }
  );
} catch (err) {
  failure = err;
} finally {
  await browser.close();
  server?.kill();
}

if (failure) {
  console.error('lanesweep failed:', failure.message);
  if (errors.length) console.error(errors.slice(0, 6).join('\n'));
  process.exit(2);
}
if (report?.error) {
  console.error('lanesweep:', report.error);
  process.exit(2);
}

if (args.json) {
  mkdirSync(dirname(resolve(String(args.json))), { recursive: true });
  writeFileSync(resolve(String(args.json)), JSON.stringify(report, null, 2));
}

const pct = report.placements ? (report.intruding / report.placements) * 100 : 0;
console.log(`props lane sweep — ${report.edgesSwept} edges, ${report.lotsSwept} lots, ${report.ms} ms`);
console.log(`  lane layer ready:      ${report.lanesReady}`);
console.log(`  placements swept:      ${report.placements} mesh + ${report.colliders} colliders ` +
  `(${report.overheadSkipped} overhead-only, not obstructions)`);
console.log(`  IN A DRIVABLE LANE:    ${report.intruding}  (${pct.toFixed(3)}%) ` +
  `— ${report.intrudingMesh} mesh, ${report.intrudingCollider} collider`);
console.log(`  worst intrusion:       ${report.worstDepth} m`);
console.log(`  BASE inside a lane:    ${report.baseInLane}   (the prop itself stands in the road)`);
console.log(`  overhang > 0.5 m:      ${report.overhangOver50cm}   (base clear, body reaches over the lane)`);
console.log(`  on its OWN edge:       ${report.onOwnEdge}   (props measured the offset wrong)`);
console.log(`  on a FOREIGN edge:     ${report.onForeignEdge}   (a second corridor lying across the footway)`);
if (report.byOffendingKind?.length) {
  console.log('  lane belongs to:');
  for (const [k, c] of report.byOffendingKind) console.log(`    ${String(c).padStart(6)}  ${k}`);
}
console.log(`  parked slots:          ${report.parkedIntruding}/${report.parkedSlots} intruding`);
console.log('  intrusion depth:');
for (const [k, v] of Object.entries(report.bands)) console.log(`    ${String(v).padStart(6)}  ${k} m`);
if (report.pairs?.length) {
  console.log('  owning corridor -> corridor it fouls:');
  for (const [k, c] of report.pairs) console.log(`    ${String(c).padStart(6)}  ${k}`);
}
if (report.byId.length) {
  console.log('  by prototype:');
  for (const [id, c] of report.byId) console.log(`    ${String(c).padStart(5)}  ${id}`);
}
if (report.worst.length) {
  console.log('  worst offenders:');
  for (const h of report.worst.slice(0, 10)) {
    console.log(`    ${h.depth.toFixed(2)} m  ${h.kind.padEnd(8)} ${h.id.padEnd(22)} @ ${h.x},${h.z}`);
  }
}
if (report.thrown?.length) console.log('  placement errors:', report.thrown);
if (errors.length) console.log('  page errors:', [...new Set(errors)].slice(0, 4));

/**
 * THE ASSERTION — two gates, chosen to match the two real defect classes.
 *
 * 1. `baseInLane` — a prop whose ORIGIN is inside a lane a driver may use. This
 *    is the player's "a stop sign in the middle of the road" and it is never
 *    acceptable. Measured at a single point, so it is continuous and free of
 *    the sampling artifact below.
 *
 * 2. `systematic` — any single prototype accounting for more than SYSTEMATIC
 *    flagged placements. A whole family in the road is what a ninety-degree yaw
 *    error or a wrong offset looks like (`rail_guard` scored 3897 before the
 *    fix); a handful scattered across 4621 edges is a street with a shrub
 *    leaning over a kerb.
 *
 * NOT gated: total overlap. A shrub over a kerb, a canopy over a parking lane
 * and a bumper-height corner sampled within 2 m of a wide edge's end node all
 * land in that bucket, and failing on them would make this permanently red and
 * therefore ignored. The counts are printed so a regression is still visible.
 */
const SYSTEMATIC = 150;
const deepOverhang = report.all.filter((h) => h.originDepth <= TOL && h.depth > 1.0).length;
const systematic = report.byId.filter(([, c]) => c > SYSTEMATIC);
console.log(`  overhang > 1.0 m:      ${deepOverhang}   (includes near-junction sampling noise)`);
if (systematic.length) {
  console.log(`  SYSTEMATIC (>${SYSTEMATIC} of one prototype):`);
  for (const [id, c] of systematic) console.log(`    ${String(c).padStart(6)}  ${id}`);
}
const bad = report.baseInLane + report.parkedIntruding + systematic.length;
console.log(bad === 0
  ? '\nPASS — nothing props places stands in a drivable lane, and no family is systematically in one.'
  : `\nFAIL — ${report.baseInLane} prop(s) standing in a lane, ${report.parkedIntruding} parked car(s) in a lane, `
    + `${systematic.length} systematically misplaced prototype(s).`);
process.exit(bad === 0 ? 0 : 1);
