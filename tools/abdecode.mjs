#!/usr/bin/env node
/**
 * Decode a counterbalanced blind A/B and separate real preference from position bias.
 *
 *   node tools/abdecode.mjs --key=shots/ab-3/_key.json --votes='{"hero__1":"A","hero__2":"B",...}'
 *   node tools/abdecode.mjs --key=shots/ab-3/_key.json --votesFile=/tmp/votes.json
 *
 * Each shot was shown twice with the sides swapped. For a pair:
 *   - the critic named the same BUILD both times  -> a real preference, counted
 *   - the critic named the same SIDE both times   -> position bias, DISCARDED
 *   - one vote is a tie                           -> counted as a tie
 *
 * This exists because the first real run came back 5-0 for side "A", and the
 * critic itself pointed out that a clean sweep to one label is indistinguishable
 * from simply always picking the left-hand image. It was right, and without
 * counterbalancing the whole comparison is unfalsifiable.
 */
import { readFileSync } from 'node:fs';
import { resolve, basename } from 'node:path';

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const m = a.match(/^--([^=]+)(?:=(.*))?$/);
    return m ? [m[1], m[2] ?? true] : [a, true];
  })
);

const key = JSON.parse(readFileSync(resolve(args.key ?? 'shots/ab/_key.json'), 'utf8'));
const votes = args.votesFile
  ? JSON.parse(readFileSync(resolve(args.votesFile), 'utf8'))
  : JSON.parse(args.votes ?? '{}');

if (!key.counterbalanced) {
  console.error('WARNING: this key is not counterbalanced. Result cannot be separated from position bias.');
}

const label = (p) => (p === key.left ? 'LEFT_DIR' : p === key.right ? 'RIGHT_DIR' : p);
const short = (p) => basename(p);

// Group the two presentations of each shot.
const byShot = new Map();
for (const [img, meta] of Object.entries(key.pairs)) {
  const shot = meta.shot ?? img.replace(/__\d$/, '');
  if (!byShot.has(shot)) byShot.set(shot, []);
  byShot.get(shot).push({ img, meta });
}

let realLeft = 0, realRight = 0, ties = 0, biased = 0, incomplete = 0;
const rows = [];

for (const [shot, presentations] of byShot) {
  const seen = presentations.filter((p) => votes[p.img]);
  if (seen.length < presentations.length) { incomplete++; rows.push([shot, 'INCOMPLETE', '', '']); continue; }

  const picks = seen.map((p) => ({ side: votes[p.img], build: p.meta[votes[p.img]] }));

  if (picks.some((p) => p.side === 'tie')) { ties++; rows.push([shot, 'tie', '', '']); continue; }

  const sameSide = picks.every((p) => p.side === picks[0].side);
  const sameBuild = picks.every((p) => p.build === picks[0].build);

  if (presentations.length > 1 && sameSide && !sameBuild) {
    biased++;
    rows.push([shot, 'POSITION BIAS (discarded)', `always ${picks[0].side}`, '']);
    continue;
  }
  if (sameBuild) {
    const b = picks[0].build;
    if (b === key.left) realLeft++; else realRight++;
    rows.push([shot, 'real preference', short(b), label(b)]);
    continue;
  }
  // Disagreed across presentations without being pure side-bias: inconsistent.
  ties++;
  rows.push([shot, 'inconsistent (counted tie)', '', '']);
}

const w = Math.max(...rows.map((r) => r[0].length), 6);
console.log('shot'.padEnd(w), 'verdict');
console.log('-'.repeat(w + 40));
for (const r of rows) console.log(r[0].padEnd(w), r[1], r[2] ? `-> ${r[2]}` : '', r[3] ? `(${r[3]})` : '');

const decided = realLeft + realRight;
console.log('\n' + '='.repeat(60));
console.log(`${short(key.left)}  won ${realLeft}`);
console.log(`${short(key.right)} won ${realRight}`);
console.log(`ties/inconsistent ${ties} · position-biased (discarded) ${biased} · incomplete ${incomplete}`);
if (!decided) {
  console.log('\nVERDICT: NO USABLE SIGNAL. Every pair was a tie or position-biased.');
} else {
  const winner = realLeft > realRight ? key.left : realRight > realLeft ? key.right : null;
  console.log(
    winner
      ? `\nVERDICT: ${short(winner)} preferred, ${Math.max(realLeft, realRight)}/${decided} decided pairs.`
      : `\nVERDICT: dead heat across ${decided} decided pairs.`
  );
}
