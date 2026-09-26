#!/usr/bin/env node
/**
 * Test-source debug-output guard (#664).
 *
 * A `console.log` left in a test is not a log line, it is an assertion that
 * never fails: the run stays green, the value is printed once into whatever
 * CI log buffer happens to be around, and the next reader has to decide whether
 * it is evidence of anything. One shipped in `exhaust2_misc.test.ts` dumped a
 * structured payload on the same line as the `assert.equal` beside it, so the
 * assertion was unreadable during review and the payload was unowned noise in
 * every run.
 *
 * The fix is the deletion, not the convention — but the convention needs a gate
 * or the next one lands. This fails on the debug channels only:
 * `console.log`, `console.debug`, `console.info`, `console.trace`, and on a
 * `debugger` statement.
 *
 * Deliberately NOT guarded:
 *
 * - `console.error` / `console.warn`. Real failures are reported through them,
 *   and three tests in this repo *replace* `console.error` to capture a
 *   handler's output and restore it after. A test that legitimately produces
 *   output to assert on does it by assigning over the function, so an
 *   assignment — not a call — is the shape this gate must tolerate.
 * - `process.stdout.write`. Same reason, and one step further from a
 *   human-readable debug channel.
 *
 * Comments, string literals and template-literal bodies are blanked before the
 * search, so a test that *documents* a debug statement, embeds a child
 * process's source in a template, or asserts on the text of one is not a hit.
 * `${…}` holes stay visible, so a statement smuggled into an interpolation is
 * still caught.
 *
 * `--check-fixture <path>` runs the same collector over one file and exits
 * non-zero on a hit, so the gate can be proved to fire instead of assumed to.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { blankNonCode } from './blank-non-code.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const GUARDED_DIR = 'tests';

/** A debug-channel call. `console?.log(` is the same call. */
const DEBUG_CALL =
  /(?<![\w$.])console\s*\??\.\s*(?:log|debug|info|trace)\s*\(/g;

/** A `debugger;` statement. */
const DEBUGGER_STATEMENT = /(?<![\w$.])debugger\s*;/g;

const PATTERNS = [
  { name: 'debug output', re: DEBUG_CALL },
  { name: 'debugger statement', re: DEBUGGER_STATEMENT },
];

/**
 * Every debug statement in one source file, as `file:line: text`. Returns `[]`
 * when the file is clean — that empty array is the comparison the gate turns
 * on, so it is computed here rather than injected by a caller.
 */
export function collectDebugOutputErrors(source, file) {
  const code = blankNonCode(source);
  const lines = source.split('\n');
  const found = [];
  for (const { name, re } of PATTERNS) {
    for (const match of code.matchAll(re)) {
      const line = code.slice(0, match.index).split('\n').length;
      found.push({ name, line, text: lines[line - 1]?.trim() ?? '' });
    }
  }
  found.sort((a, b) => a.line - b.line);
  return found.map((hit) => `${file}:${hit.line}: ${hit.name} — ${hit.text}`);
}

function walk(directory) {
  const files = [];
  for (const entry of readdirSync(directory)) {
    const file = join(directory, entry);
    if (statSync(file).isDirectory()) files.push(...walk(file));
    else if (file.endsWith('.ts')) files.push(file);
  }
  return files;
}

function checkFile(file) {
  return collectDebugOutputErrors(readFileSync(file, 'utf8'), relative(ROOT, file));
}

const fixtureIndex = process.argv.indexOf('--check-fixture');
if (fixtureIndex >= 0) {
  if (!process.argv[fixtureIndex + 1]) {
    throw new Error('--check-fixture requires a file path');
  }
  const found = checkFile(resolve(process.argv[fixtureIndex + 1]));
  for (const error of found) console.error(error);
  process.exit(found.length > 0 ? 1 : 0);
}

const guarded = walk(join(ROOT, GUARDED_DIR)).sort();
const errors = guarded.flatMap(checkFile);

if (errors.length > 0) {
  console.error(`Test debug-output guard failed (${errors.length} statement${errors.length === 1 ? '' : 's'} under ${GUARDED_DIR}):\n${errors.map((line) => `- ${line}`).join('\n')}`);
  console.error('Delete the statement. If the value matters, assert on it — a print that cannot fail is not a test. To capture output a tool produced, assign over the function and restore it afterwards, which this gate allows.');
  process.exitCode = 1;
} else {
  console.log(`No debug output in ${GUARDED_DIR} (${guarded.length} files checked).`);
}
