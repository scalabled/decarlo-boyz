#!/usr/bin/env node
/**
 * Hard rule 10 as a gate.
 *
 * A backtick inside a template literal CLOSES it. Everything after is parsed as
 * JavaScript, so you get `ReferenceError: someGlslVariable is not defined`
 * pointing at a line of shader or CSS that is completely valid, and the boot
 * dies. It is invisible in review and expensive to find.
 *
 * It has now broken the build in THREE separate subsystems:
 *   src/sky/clouds.js        — a JSDoc comment quoting `uViewPos`
 *   src/materials/shader.js  — a comment quoting `* owUpFace`
 *   src/ui/style.js          — a CSS comment quoting `.ow-hud`
 * Each cost roughly ten minutes of every other agent's time, because a red boot
 * blocks everyone's captures at once.
 *
 * This finds them in one pass, before anyone runs a build.
 *
 *   node tools/lintticks.mjs          # exits non-zero on a finding
 *   node tools/lintticks.mjs --quiet  # only prints findings
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '..');
const SRC = join(ROOT, 'src');
const quiet = process.argv.includes('--quiet');

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) walk(p, out);
    else if (name.endsWith('.js')) out.push(p);
  }
  return out;
}

/**
 * Find the shape every real instance of this bug has taken: a comment written
 * in the template's OWN language — GLSL or CSS — that quotes an identifier in
 * backticks the way a JSDoc would.
 *
 * Note what is deliberately NOT modelled. Asking "what does the JS parser see
 * here?" finds nothing, because to the parser there is no comment and no bug —
 * the first stray backtick simply ends the literal and the file parses fine, all
 * the way to a ReferenceError at boot. The defect lives in the gap between what
 * the author meant and what JS read, so the scanner tracks the author's intent
 * and reports where the two disagree.
 *
 * `--selftest` pins both directions: the three real build breaks must flag, and
 * the legal shapes that once produced eleven false positives must not.
 */

/** An ESCAPED backtick is legal inside a template literal — only bare ones close it. */
const hasBareTick = (s) => /(^|[^\\])`/.test(s);

function scan(src) {
  const hits = [];
  let i = 0;
  let line = 1;

  /**
   * A STACK, not a counter — and this distinction is the whole scanner.
   *
   * Inside template TEXT the only special characters are a backslash, a closing
   * backtick and `${`. A quote is not a quote and `//` is not a comment. Track
   * it with a depth counter and apply the ordinary code rules throughout, and
   * `` `${name.toUpperCase()}'S STORY` `` desyncs you permanently: the
   * apostrophe in "'S" opens a string that runs forward and swallows the
   * template's own closing backtick, so every comment in the remaining 500
   * lines of the file is reported as being inside a template. MEASURED: eleven
   * false positives from one apostrophe, in a file that compiles.
   *
   * Frames alternate: 'code' (the file, and the inside of any `${ }`) and
   * 'tmpl' (template text). `${` pushes a code frame; its matching close brace
   * pops back into the template.
   */
  const stack = [{ type: 'code', braces: 0 }];
  const top = () => stack[stack.length - 1];


  while (i < src.length) {
    const c = src[i];
    const n = src[i + 1];

    if (c === '\n') { line++; i++; continue; }

    // --- template TEXT: almost nothing is special in here ---
    if (top().type === 'tmpl') {
      if (c === '\\') { i += 2; continue; }

      // A comment in the template's OWN language — GLSL or CSS.
      //
      // JavaScript does not see a comment here, and that is precisely the bug:
      // the author is writing shader or stylesheet source, reaches for a
      // backtick to quote an identifier the way they would in a JSDoc, and JS
      // reads it as the end of the literal. So this deliberately does NOT
      // model what the JS parser does — it models what the author meant,
      // because the gap between the two IS the defect. Scanning for the JS behaviour finds
      // nothing at all: the first stray backtick simply closes the template and
      // everything looks well-formed.
      if (c === '/' && (n === '/' || n === '*')) {
        const isLine = n === '/';
        const end = isLine ? src.indexOf('\n', i) : src.indexOf('*/', i + 2);
        const stop = end < 0 ? src.length : (isLine ? end : end + 2);
        const text = src.slice(i, stop);
        if (hasBareTick(text)) {
          const lines = text.split('\n');
          const rel = Math.max(0, lines.findIndex((l) => hasBareTick(l)));
          hits.push({
            line: line + rel,
            kind: isLine ? 'line comment' : 'block comment',
            text: (lines[rel] || '').trim().slice(0, 90),
          });
        }
        line += (text.match(/\n/g) || []).length;
        i = stop;
        continue;
      }

      if (c === '`') { stack.pop(); i++; continue; }
      if (c === '$' && n === '{') { stack.push({ type: 'code', braces: 0 }); i += 2; continue; }
      i++;
      continue;
    }

    // --- comments at CODE level: skipped, never flagged ---
    //
    // These are real JavaScript comments — either at file scope or inside a
    // `${ }` interpolation — and the parser ignores backticks in both. Quoting
    // an identifier here is correct style and flagging it is how the first cut
    // of this file produced eleven findings in a file that compiles.
    if (c === '/' && (n === '/' || n === '*')) {
      const isLine = n === '/';
      const end = isLine ? src.indexOf('\n', i) : src.indexOf('*/', i + 2);
      const stop = end < 0 ? src.length : (isLine ? end : end + 2);
      if (!isLine) line += (src.slice(i, stop).match(/\n/g) || []).length;
      i = stop;
      continue;
    }

    // --- plain string ---
    if (c === '"' || c === "'") {
      i++;
      while (i < src.length && src[i] !== c) {
        if (src[i] === '\\') i++;
        else if (src[i] === '\n') line++;
        i++;
      }
      i++;
      continue;
    }

    // --- a template literal opens ---
    if (c === '`') { stack.push({ type: 'tmpl' }); i++; continue; }

    // Brace tracking exists only so an interpolation knows where it ends: the
    // close brace that matches no open brace is the one that returns the scan
    // to template text.
    if (c === '{') { top().braces++; i++; continue; }
    if (c === '}') {
      if (top().braces === 0 && stack.length > 1) stack.pop();
      else top().braces--;
      i++;
      continue;
    }

    if (c === '\\') i++;
    i++;
  }
  return hits;
}

/**
 * `node tools/lintticks.mjs --selftest`
 *
 * A linter that reports "clean" is only worth anything if you can show it is
 * not clean VACUOUSLY. The first version of this file reported eleven findings
 * in a file that compiles — all of them from one apostrophe — so the cases that
 * must not regress are pinned here: the three real build breaks on one side,
 * and on the other the legal shapes that produced those false positives.
 */
if (process.argv.includes('--selftest')) {
  const CASES = [
    // --- must FLAG: the three that actually broke the boot ---
    ['clouds.js  — JSDoc quoting a uniform', 'const s = `\n  /** uses `uViewPos` */\n  void main(){}\n`;', 1],
    ['shader.js  — line comment quoting a varying', 'const s = `\n  // sets `owUpFace`\n  void main(){}\n`;', 1],
    ['style.js   — CSS comment quoting a selector', 'const css = `\n  /* `.ow-hud` sits above */\n  .a{color:red}\n`;', 1],

    // --- must NOT flag: legal code ---
    ["apostrophe in template text", "const s = `${n.toUpperCase()}'S STORY`;\n// a `tick` in a later comment\n", 0],
    ['escaped tick inside a template', 'const s = `see \\`receiveShadow\\` docs`;', 0],
    ['tick in a comment OUTSIDE any template', '// `heightAt` is not `walkableHeightAt`\nconst s = `plain`;', 0],
    ['tick inside a normal string', "const s = 'quotes `game` here';\n// `also fine`\n", 0],
    ['nested template inside ${ }', 'const s = `a${ `b${ c }d` }e`;\n// `fine`\n', 0],
    ['double quote inside template text', 'const s = `save "${x}" now`;\n// `fine`\n', 0],
    ['a brace-heavy interpolation', 'const s = `${ (() => { const o = {a:{b:1}}; return o.a.b; })() }`;\n// `fine`\n', 0],
  ];
  let failed = 0;
  for (const [name, src, want] of CASES) {
    const got = scan(src).length;
    const ok = got === want;
    if (!ok) failed++;
    console.log(`${ok ? 'ok  ' : 'FAIL'}  ${name}  (expected ${want}, got ${got})`);
  }
  console.log(failed ? `\n${failed}/${CASES.length} self-test case(s) failed` : `\nall ${CASES.length} self-test cases pass`);
  process.exit(failed ? 1 : 0);
}

let bad = 0;
let files = 0;
for (const file of walk(SRC)) {
  files++;
  let src;
  try { src = readFileSync(file, 'utf8'); } catch { continue; }
  if (!src.includes('`')) continue;
  const hits = scan(src);
  for (const h of hits) {
    bad++;
    console.error(`${relative(ROOT, file)}:${h.line}  backtick inside a template literal (${h.kind})`);
    console.error(`    ${h.text}`);
  }
}

if (bad) {
  console.error(
    `\n${bad} finding(s). A backtick inside a template literal CLOSES it — everything after is\n` +
    `parsed as JavaScript and the boot dies with a ReferenceError pointing at valid shader/CSS.\n` +
    `Quote identifiers in these comments with plain text or single quotes instead.`
  );
  process.exit(1);
}
if (!quiet) console.log(`lintticks: ${files} files clean`);
