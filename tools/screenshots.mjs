#!/usr/bin/env node
/**
 * Capture the marketing set into `screenshots/`, and write its index.
 *
 *   node tools/screenshots.mjs              # all of them, 2560x1440
 *   node tools/screenshots.mjs --w=1920 --h=1080
 *   node tools/screenshots.mjs --only=mkt_skyline,mkt_mill_night
 *
 * ────────────────────────────────────────────────────────────────────────────
 * WHY THIS IS NOT `tools/shotset.mjs`
 *
 * `shotset` captures the REVIEW set: it covers the game, it is deliberately
 * repetitive, and it is framed to expose defects. This captures the MARKETING
 * set — the frames that go in the repo README — which has the opposite job.
 * Mixing them costs you both: a review set that flatters is useless, and a
 * marketing set chosen for coverage is why a critic panel said of ours that
 * "marketing could not cut a ten-second reel from this set".
 *
 * The shots live in `src/dev/shots.js` flagged `marketing: true`, with the
 * composition rules written beside them. They carry `hud: false`.
 *
 * Determinism comes free from `capture.mjs`: lockstep frames, a frozen sim at
 * the shutter, a re-pinned sky clock, a reset TAA jitter sequence, and a
 * work-budgeted (not wall-clock) streaming build. Two runs of an unchanged tree
 * produce byte-identical PNGs, so re-running this is a no-op unless the game
 * actually changed.
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync, existsSync, statSync } from 'node:fs';
import { resolve, join } from 'node:path';

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const m = a.match(/^--([^=]+)(?:=(.*))?$/);
    return m ? [m[1], m[2] ?? true] : [a, true];
  })
);

const ROOT = resolve(import.meta.dirname, '..');
const OUT = resolve(args.out ?? join(ROOT, 'screenshots'));
const W = Number(args.w ?? 2560);
const H = Number(args.h ?? 1440);

/**
 * The set and its captions, mirrored from `src/dev/shots.js`.
 *
 * Deliberately duplicated rather than imported: this file is a node script and
 * `shots.js` is browser module that pulls in three. The order here is the order
 * they appear in the README, which is an editorial decision and not the same as
 * the order they happen to be declared in.
 */
const SET = [
  ['mkt_skyline', 'Downtown from the Mt. Washington clifftop', 'The signature view: the Golden Triangle read across the Monongahela at golden hour.'],
  ['mkt_rain_street', 'Downtown in a storm', 'Wet asphalt, lit windows, and traffic that was deliberately left in.'],
  ['mkt_mill_night', 'The Old Blast Furnace', 'Slag orange against cold steel in river fog — the thematic heart of a rustbelt city.'],
  ['mkt_searchlight', 'Police searchlight', 'Five stars, and a helicopter sweeping the street below.'],
  ['mkt_bridge_dusk', 'A tied-arch bridge at last light', 'Three rivers and forty bridges, in one frame.'],
  ['mkt_incline', 'The Duquesne Incline at dawn', 'The funicular climbing out of river fog.'],
  ['mkt_point', 'The Point', 'Where three rivers meet.'],
  ['mkt_kessel', "Dylan's Kessel GT", 'A front-drive fastback — the fast brother\u2019s own car.'],
  ['mkt_hero', 'A Golden Triangle avenue', 'Clear afternoon light, at street level.'],
];

const only = args.only ? String(args.only).split(',').map((s) => s.trim()) : null;
const shots = only ? SET.filter(([id]) => only.includes(id)) : SET;

mkdirSync(OUT, { recursive: true });

const done = [];
const failed = [];
for (const [id, title, caption] of shots) {
  const out = join(OUT, `${id.replace(/^mkt_/, '')}.png`);
  process.stdout.write(`  ${id} ... `);
  try {
    execFileSync(
      process.execPath,
      [join(ROOT, 'tools/capture.mjs'), `--shot=${id}`, `--out=${out}`, `--w=${W}`, `--h=${H}`],
      { stdio: 'pipe', cwd: ROOT }
    );
    const kb = existsSync(out) ? Math.round(statSync(out).size / 1024) : 0;
    // A frame that renders as a flat colour compresses to almost nothing. That
    // is the cheapest possible check that the shutter caught a real image, and
    // it has caught a black frame in this project before.
    if (kb < 80) throw new Error(`suspiciously small (${kb} KB) — probably a blank frame`);
    console.log(`ok (${kb} KB)`);
    done.push([id, title, caption, `${id.replace(/^mkt_/, '')}.png`]);
  } catch (e) {
    console.log('FAILED');
    failed.push([id, String(e.message ?? e).split('\n')[0].slice(0, 140)]);
  }
}

const md = [
  '# Steel City — screenshots',
  '',
  '**DeCarlo Boyz** — an open-world game built in Three.js. Everything here is',
  'generated at runtime: no art files, no textures on disk, no CDN, no network.',
  'The city, its materials, its vehicles and its three brothers are all',
  'procedural, and the whole thing runs in a browser tab.',
  '',
  `Captured at ${W}x${H} by \`node tools/screenshots.mjs\`. The capture path is`,
  'deterministic — lockstep frames, a frozen simulation at the shutter and a',
  'work-budgeted streaming build — so two runs of an unchanged tree produce',
  'byte-identical images.',
  '',
];
for (const [, title, caption, file] of done) {
  md.push(`### ${title}`, '', `![${title}](${file})`, '', `*${caption}*`, '');
}
if (failed.length) {
  md.push('', '<!-- not captured this run:', ...failed.map(([id, why]) => `     ${id}: ${why}`), '-->', '');
}
writeFileSync(join(OUT, 'README.md'), md.join('\n'));

console.log(`\n${done.length}/${shots.length} captured into ${OUT}`);
if (failed.length) {
  console.error('\nfailed:');
  for (const [id, why] of failed) console.error(`  ${id}  ${why}`);
  process.exit(1);
}
