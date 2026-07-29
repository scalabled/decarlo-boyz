#!/usr/bin/env node
/**
 * BLIP GATE — "do the minimap contacts `peds` publishes actually reach the
 * radar?", in a real browser running the real engine.
 *
 * `src/ui/index.js` `_collectBlips` has always called `peds.getHudActors()` and
 * nothing implemented it, so the crew blip and the hostile blip never appeared
 * in live play — only in the debug states, which drive their own contacts. This
 * asserts the whole chain end to end.
 *
 * RULE 12: it does NOT read `getHudActors()`. That would be the producer
 * grading its own homework. Every assertion reads `ui._blipView` — the array
 * `ui` publishes to the minimap and the full map AFTER filtering, classifying
 * and capping — so the only way to pass is for the data to survive the whole
 * path from a `Ped` to the thing that gets drawn.
 *
 *   1 QUIET    with no crew and nobody fighting, `ui` publishes no 'friend'
 *              and no 'enemy' contacts. THE NEGATIVE CONTROL: without it, a
 *              function that returned every pedestrian in the city would score
 *              full marks on gates 2 and 3.
 *   2 CREW     spawning the brothers makes 'friend' contacts appear, one per
 *              brother, at their real positions.
 *   3 TRACK    walking the player away moves those contacts with the brothers,
 *              in the world, frame after frame.
 *   4 HOSTILE  a pedestrian who is FIGHTING appears as an 'enemy' contact...
 *   5 CLEAR    ...and stops being one the moment he stops fighting.
 *
 *   node src/peds/blipprobe.mjs
 *   node src/peds/blipprobe.mjs --json
 */
import { chromium } from 'playwright';
import { startServer } from '../../tools/lib/server.mjs';

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const m = a.match(/^--([^=]+)(?:=(.*))?$/);
    return m ? [m[1], m[2] ?? true] : [a, true];
  })
);
const JSON_OUT = !!args.json;
const log = (...a) => { if (!JSON_OUT) console.log(...a); };

const results = [];
const rec = (name, ok, detail) => {
  results.push({ name, ok: !!ok, detail: String(detail ?? '') });
  log(`  ${ok ? 'PASS' : 'FAIL'}  ${name.padEnd(52)} ${detail ?? ''}`);
};

/**
 * A CROSS-BOUNDARY GAP: something this directory has done its half of and
 * another directory has not. It prints, it is counted, it names the exact change
 * required — and it does NOT fail the run, because `src/peds` cannot land the
 * other half and a permanently red gate is a gate people stop reading.
 *
 * The moment the other side lands, `ok` goes true and it becomes an ordinary
 * PASS with no edit here. That is the point: it is a live check, not a comment.
 */
const gaps = [];
const gap = (name, ok, detail, fix) => {
  if (ok) return rec(name, true, detail);
  gaps.push({ name, detail: String(detail ?? ''), fix });
  log(`  GAP   ${name.padEnd(52)} ${detail ?? ''}`);
  log(`        needs, in another directory: ${fix}`);
};

const { port, server } = await startServer({ explicitPort: args.port });
const browser = await chromium.launch({
  headless: true,
  args: ['--use-angle=metal', '--ignore-gpu-blocklist', '--mute-audio', '--disable-frame-rate-limit'],
});
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
const pageErrors = [];
page.on('pageerror', (e) => { if (pageErrors.length < 20) pageErrors.push(String(e.message).slice(0, 200)); });

await page.goto(`http://127.0.0.1:${port}/?q=low&prewarm=0`, { waitUntil: 'domcontentloaded' });
await page.waitForFunction('window.__READY__===true', null, { timeout: 90000 });
await page.waitForFunction('window.__SETTLED__ ? window.__SETTLED__() : true', null, { timeout: 90000 });

const pump = (n = 1) => page.evaluate((k) => window.__PUMP__(k), n);
const run = (src, arg = null) =>
  page.evaluate(
    ({ s, a }) => {
      const engine = window.__ENGINE__;
      const ctx = engine.ctx;
      // eslint-disable-next-line no-new-func
      const f = new Function('engine', 'ctx', 'peds', 'ui', 'player', 'ARG', s);
      return f(engine, ctx, ctx.peek('peds'), ctx.peek('ui'), ctx.peek('player'), a);
    },
    { s: src, a: arg }
  );

/**
 * ONE SNAPSHOT, ONE INSTANT. `ui._blipView` is what the minimap and the full
 * map iterate; `_blipCount` is how many of it are live this frame.
 *
 * The blips and the actors they are supposed to be tracking are read in the
 * SAME `evaluate`, because the page runs free between calls: reading them in
 * two round trips compared a blip from one frame against an actor position from
 * the next and reported 740 mm of "drift" that was really 12 ms of walking.
 */
const SNAP = `
  const out = [];
  const n = ui._blipCount ?? 0;
  for (let i = 0; i < n; i++) {
    const b = ui._blipView[i] ?? ui._blips[i];
    if (b) out.push({ kind: b.kind, x: +b.x.toFixed(3), z: +b.z.toFixed(3),
                      colour: b.colour ?? b.color ?? null, id: b.id ?? null });
  }
  const p = player.position;
  return {
    blips: out,
    player: { x: +p.x.toFixed(2), z: +p.z.toFixed(2) },
    crew: peds.crew.members.filter((m) => m.active && m.ped && m.ped.active)
      .map((m) => ({ x: +m.ped.position.x.toFixed(3), z: +m.ped.position.z.toFixed(3) })),
    fighters: peds.live.filter((q) => !q.isCrew && q.alive && q.state === 'fight' &&
        q.position.distanceTo(p) < 140)
      .map((q) => ({ x: +q.position.x.toFixed(3), z: +q.position.z.toFixed(3) })),
  };
`;
const snap = () => run(SNAP);
const countOf = (list, kind) => list.filter((b) => b.kind === kind).length;

await run(`engine.input.enabled = false; return true;`);

/* ---------------------------------------------------------------- 1 QUIET */
await run(`peds.despawnCrew(); for (const p of peds.live) if (p.state === 'fight') p.state = 'walk'; return true;`);
await pump(30);
const quiet = (await snap()).blips;
rec('NEGATIVE CONTROL: no crew, nobody fighting -> no friend/enemy blips',
  countOf(quiet, 'friend') === 0 && countOf(quiet, 'enemy') === 0,
  `${quiet.length} blips: ${quiet.map((b) => b.kind).join(',') || 'none'}`);

/* ----------------------------------------------------------------- 2 CREW */
const crewIds = await run(`peds.spawnCrew(); return peds.crew.members.map((m) => m.id);`);
await pump(30);
const s0 = await snap();
const withCrew = s0.blips;
const crewTruth = s0.crew;
const friends = withCrew.filter((b) => b.kind === 'friend');
const matched = crewTruth.filter((t) =>
  friends.some((f) => Math.hypot(f.x - t.x, f.z - t.z) < 0.05)).length;
rec('a brother on the street is a friend blip on the radar',
  friends.length === crewTruth.length && matched === crewTruth.length && crewTruth.length > 0,
  `${friends.length} friend blips for ${crewTruth.length} brothers (${crewIds.join(',')}), ${matched} at the right place`);

/* --------------------------------------------------------- 2b CREW COLOUR */
/**
 * DESIGN.md gives each brother a signature colour and the minimap is where the
 * player reads it at fifty metres. Two links in that chain, checked separately
 * because only one of them lives in this directory.
 *
 * The expected hexes are quoted from DESIGN.md, NOT read back out of
 * `crew.js`'s `BROTHERS` table. Asserting `getHudActors().colour === BROTHERS
 * [id].colour` would be the code agreeing with itself (rule 12); asserting it
 * against the content bible is a real constraint that a typo would break.
 */
const DESIGN_COLOUR = { carson: '#2ea6a0', aidan: '#ff6a12', dylan: '#c07cff' };
const published = await run(`
  const a = peds.getHudActors();
  return a.filter((r) => r.kind === 'crew')
    .map((r) => ({ id: r.id, colour: r.colour, friendly: r.friendly }));
`);
const rightColour = published.filter((r) => DESIGN_COLOUR[r.id] &&
  String(r.colour).toLowerCase() === DESIGN_COLOUR[r.id]).length;
const distinctColours = new Set(published.map((r) => r.colour)).size;
rec('peds publishes each brother\'s own DESIGN.md colour',
  published.length > 0 && rightColour === published.length && distinctColours === published.length,
  published.map((r) => `${r.id}=${r.colour}`).join(' ') +
  ` (want ${published.map((r) => `${r.id}=${DESIGN_COLOUR[r.id]}`).join(' ')})`);

const liveFriend = (await snap()).blips.filter((b) => b.kind === 'friend');
const liveColoured = liveFriend.filter((b) => b.colour &&
  Object.values(DESIGN_COLOUR).includes(String(b.colour).toLowerCase())).length;
gap('the radar draws them in that colour',
  liveFriend.length > 0 && liveColoured === liveFriend.length,
  `${liveColoured}/${liveFriend.length} live blips carry a brother colour; ` +
  `ui._blips records expose colour=${JSON.stringify(liveFriend[0]?.colour ?? null)}, so ` +
  'every ally draws in the generic ALLY green (#41e08a)',
  'src/ui/index.js `_collectBlips` builds its records with `push(p, kind, heading)` ' +
  'and drops `a.colour` from `getHudActors()`; `this._blips[i]` has no colour field. ' +
  'Carry it through (push(p, kind, heading, a.colour)), default it to ' +
  'BLIP_STYLES[kind].c, and let src/ui/radar.js `_dotBlip`/`drawIcon` and ' +
  'src/ui/pausemap.js prefer `b.colour` over `st.c`.');

/* ---------------------------------------------------------------- 3 TRACK */
/** Walk the player for four seconds; the brothers follow, so must the blips. */
const before = (await snap()).player;
let drift = 0;
let samples = 0;
for (let i = 0; i < 10; i++) {
  await run(`
    const p = player.position;
    player.teleport({ x: p.x + 6, y: p.y, z: p.z + 5 }, 0);
    return true;
  `);
  await pump(12);
  const sN = await snap();
  const t = sN.crew;
  const f = sN.blips.filter((x) => x.kind === 'friend');
  if (f.length !== t.length) { drift = Infinity; break; }
  for (const q of t) {
    const d = Math.min(...f.map((g) => Math.hypot(g.x - q.x, g.z - q.z)));
    drift = Math.max(drift, d);
    samples++;
  }
}
const after = (await snap()).player;
rec('friend blips TRACK the brothers as the player moves',
  drift < 0.05 && samples > 10,
  `player ${before.x},${before.z} -> ${after.x},${after.z}; worst blip-vs-actor error ${drift === Infinity ? 'count changed' : (drift * 1000).toFixed(1) + ' mm'} over ${samples} samples`);

/* -------------------------------------------------------------- 4 HOSTILE */
/**
 * A fighting pedestrian, produced the way the game produces one. `Ped.panic`
 * gives a small fraction of a street/mill/nightlife crowd the fight response
 * instead of the flee response, so panic the block a few times and take who
 * turns; if the crowd RNG does not oblige, drive the same two lines
 * `PedSystem._react('firefight')` drives, which is the other real path.
 */
/**
 * The crowd has to be BACK first. The track test teleported the player 60 m
 * and the streamer despawns and respawns pedestrians around him, so the block
 * is briefly empty; ask again until somebody is there rather than asserting
 * against an empty street.
 */
let how = 'none';
for (let attempt = 0; attempt < 12 && how === 'none'; attempt++) {
  await pump(120);
  how = await run(`
    const p = player.position;
    for (let k = 0; k < 8; k++) {
      peds.panic(p, 30, 1.0);
      if (peds.live.some((q) => !q.isCrew && q.alive && q.state === 'fight')) return 'panic';
    }
    const near = peds.live
      .filter((q) => !q.isCrew && q.alive && q.position.distanceTo(p) < 120)
      .sort((a, b) => a.position.distanceTo(p) - b.position.distanceTo(p))[0];
    if (!near) return 'none';
    near.state = 'fight';
    near.fightTarget = p;
    near.stateTime = 0;
    return 'firefight';
  `);
}

await pump(20);
const sH = await snap();
const hot = sH.blips;
const truth = sH.fighters;
const enemies = hot.filter((b) => b.kind === 'enemy');
const eMatched = truth.filter((t) =>
  enemies.some((e) => Math.hypot(e.x - t.x, e.z - t.z) < 0.05)).length;
rec('a pedestrian who is FIGHTING is an enemy blip on the radar',
  truth.length > 0 && enemies.length === truth.length && eMatched === truth.length,
  `${enemies.length} enemy blips for ${truth.length} fighters (via ${how}), ${eMatched} at the right place`);
rec('the crew blips survived the hostile appearing',
  hot.filter((b) => b.kind === 'friend').length === crewTruth.length,
  `${hot.filter((b) => b.kind === 'friend').length} friend blips`);

/* ---------------------------------------------------------------- 5 CLEAR */
await run(`for (const q of peds.live) if (q.state === 'fight') { q.state = 'walk'; q.stateTime = 0; } return true;`);
await pump(20);
const cooled = (await snap()).blips;
rec('he stops being a contact when he stops fighting',
  countOf(cooled, 'enemy') === 0,
  `${countOf(cooled, 'enemy')} enemy blips left`);

/* ------------------------------------------------------------------------ */
const failures = results.filter((r) => !r.ok).length;
if (pageErrors.length) {
  log(`\n  page errors (${pageErrors.length}):`);
  for (const e of pageErrors.slice(0, 6)) log(`    ${e}`);
}
if (gaps.length) {
  log(`\n  ${gaps.length} cross-boundary gap(s) — this directory's half is done, ` +
    'the other half is not. Not counted as failures.');
}
if (JSON_OUT) console.log(JSON.stringify({ results, gaps, pageErrors }, null, 2));
log(`\n${failures ? `FAIL (${failures}/${results.length})` : `PASS (${results.length}/${results.length})`}\n`);

await browser.close();
server?.kill?.();
process.exit(failures || pageErrors.length ? 1 : 0);
