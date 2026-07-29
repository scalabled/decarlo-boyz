#!/usr/bin/env node
/**
 * Hard rule 10, SECOND HABITAT.
 *
 * `tools/lintticks.mjs` finds a backtick inside a GLSL or CSS template literal —
 * the shape that has broken the boot four times. But it only scans `src/**.js`
 * for that one pattern, and the same class of bug has another home:
 *
 *   THE HEADLESS HARNESSES SEND PAGE SNIPPETS AS TEMPLATE LITERALS.
 *
 * `src/game/playtest.mjs`, `tools/playprobe.mjs`, every `*probe.mjs` and
 * `*sweep.mjs` — they all do `page.evaluate(\`...\`)` with real code inside the
 * literal. A backtick in a comment in one of those closes it exactly the same
 * way, and the file simply fails to parse. Nothing in the gate noticed, because
 * lintticks does not read `.mjs` and `vite build` does not bundle the harnesses.
 *
 * A harness that will not parse is worse than a failing one: `npm run build`
 * stays green, `npm run gate` stays green, and the check silently stops running.
 *
 * `node --check` is the whole answer and it costs milliseconds per file. It
 * catches the backtick case and every other syntax error besides — which is the
 * point, since the next instance of this will not necessarily be a backtick.
 *
 *   node tools/syntaxcheck.mjs
 *   node tools/syntaxcheck.mjs --quiet
 */
import { readdirSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';

const ROOT = resolve(import.meta.dirname, '..');
const quiet = process.argv.includes('--quiet');

/** Every executable script in the repo — the harnesses `vite build` never touches. */
function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === 'dist' || name.startsWith('.')) continue;
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) walk(p, out);
    else if (name.endsWith('.mjs')) out.push(p);
  }
  return out;
}

const files = [...walk(join(ROOT, 'src')), ...walk(join(ROOT, 'tools'))];
let bad = 0;

for (const f of files) {
  try {
    execFileSync(process.execPath, ['--check', f], { stdio: 'pipe' });
  } catch (e) {
    bad++;
    const msg = String(e.stderr ?? e.message)
      .split('\n')
      .filter((l) => l.trim() && !l.startsWith('    at '))
      .slice(0, 4)
      .join('\n      ');
    console.error(`${relative(ROOT, f)}\n      ${msg}`);
  }
}

if (bad) {
  console.error(
    `\n${bad} harness file(s) do not parse. They are NOT bundled by \`vite build\`, so the\n` +
    `build stays green while the check silently stops running. See hard rule 10 —\n` +
    `a backtick inside a page-snippet template literal closes it early.`
  );
  process.exit(1);
}
if (!quiet) console.log(`syntaxcheck: ${files.length} harness files parse`);
