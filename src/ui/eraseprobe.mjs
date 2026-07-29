#!/usr/bin/env node
/**
 * ERASE ALL PROGRESS — the brother-select screen's only destructive control.
 *
 *   node src/ui/eraseprobe.mjs        (npm run erase)
 *
 * The button lives here rather than on the pause menu: this is the only screen
 * that is about the save slots, and it sits behind a confirmation.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * WHY THE SEED IS THE MOST IMPORTANT CHECK IN THE FILE
 *
 * The obvious version of this test — click erase, assert every brother reads
 * chapter 0 — PASSES ON A BUILD WHERE THE BUTTON DOES NOTHING, because a fresh
 * profile is already all zeros. The first two runs of this probe did exactly
 * that and reported three greens off a save that had never been touched.
 *
 * So `the seed actually loaded` is asserted first and everything else hangs off
 * it. Two things had to be right before it went green: the save lives under
 * `chars`, not `boyz`, and `localStorage` is EMPTY until something writes — so
 * the seed goes through the live save and the game's own writer, then the page
 * is reloaded so the wipe has a real file to destroy. If that first line ever
 * goes red the rest of the file is meaningless, not merely failing.
 *
 * That is ARCHITECTURE.md rule 12 in its nastiest form: the gate was not
 * re-using the code's own inputs, it was asserting a postcondition that the
 * initial state already satisfied.
 */
import { startServer, stopServer } from '../../tools/lib/server.mjs';
import { chromium } from 'playwright';

const srv = await startServer();
const URL = `http://localhost:${srv.port}/?boot=1`;
const b = await chromium.launch();
const p = await b.newPage();
const atSelect = async () => {
  await p.waitForFunction(() => !!window.__ENGINE__, null, { timeout: 180000 });
  await p.waitForFunction(() => {
    const s = document.querySelector('.ow-boot-select');
    return s && getComputedStyle(s).display !== 'none';
  }, null, { timeout: 180000 });
};
const roster = () => p.evaluate(() =>
  (window.__ENGINE__.registry.peek('game').roster() ?? []).map((x) => x.chapter ?? 0));
const cards = () => p.evaluate(() =>
  [...document.querySelectorAll('.ow-boot-card')]
    .map((c) => (c.textContent.match(/NEW GAME|CHAPTER \d+ OF \d+|STORY COMPLETE/) ?? [''])[0]));

await p.goto(URL, { waitUntil: 'load' });
await atSelect();

// Seed real progress into the key the game loads from, then RELOAD so it boots with it.
await p.evaluate(() => {
  // The save lives under `chars`, and localStorage is empty until something
  // writes — so mutate the live save and persist it through the game's own
  // writer, then reload so the wipe has a real file to destroy.
  const g = window.__ENGINE__.registry.peek('game');
  for (const id of ['carson', 'aidan', 'dylan']) {
    const c = g.save.chars[id];
    if (c) { c.chapter = 4; c.cash = 9999; }
  }
  g.writer?.flush?.(g.save) ?? g.writer?.put?.(g.save);
  try { localStorage.setItem('decarloboyz.save.v2', JSON.stringify(g.save)); } catch {}
});
await p.goto(URL, { waitUntil: 'load' });
await atSelect();
const seeded = await roster();
const seededCards = await cards();

// 1. decline the confirm -> nothing happens
await p.evaluate(() => { globalThis.confirm = () => false; document.querySelector('.ow-boot-erase-btn').click(); });
await p.waitForTimeout(300);
const afterDecline = await roster();

// 2. accept -> progress is gone AND the cards re-render to say so
await p.evaluate(() => { globalThis.confirm = () => true; document.querySelector('.ow-boot-erase-btn').click(); });
await p.waitForTimeout(400);
const afterAccept = await roster();
const afterCards = await cards();
const storage = await p.evaluate(() =>
  (localStorage.getItem('decarloboyz.save.v2') ?? '').includes('9999'));

let fails = 0;
const ok = (n, c, d) => {
  if (!c) fails++;
  console.log(`  ${c ? 'ok  ' : 'FAIL'}  ${n}${d ? '   ' + d : ''}`);
};
console.log('\n=== erase-all on the brother-select screen ===');
ok('the seed actually loaded (test can fail)', seeded.every((c) => c === 4), `roster ${JSON.stringify(seeded)}`);
ok('cards showed that progress', seededCards.every((t) => /CHAPTER 5 OF/.test(t)), JSON.stringify(seededCards));
ok('declining the confirm changes nothing', afterDecline.every((c) => c === 4), `roster ${JSON.stringify(afterDecline)}`);
ok('accepting erases every brother', afterAccept.every((c) => c === 0), `roster ${JSON.stringify(afterAccept)}`);
ok('the cards re-render to NEW GAME', afterCards.every((t) => t === 'NEW GAME'), JSON.stringify(afterCards));
ok('storage no longer holds the seeded cash', storage === false, `contains 9999: ${storage}`);
await b.close();
await stopServer(srv);
console.log(`\nerase: ${6 - fails}/6`);
process.exit(fails ? 1 : 0);
