#!/usr/bin/env node
/**
 * A module that stays registered under `SPOTIFY_MCP_READONLY` must not contain
 * a mutating call (#1604).
 *
 * ## Why this is a gate and not a convention
 *
 * The read/write classification in this server is carried by two things, and
 * only one of them is checked. `MUTATING_PREFIXES` in `src/tools/annotations.ts`
 * matches a tool's **name**; a module marked `readOnlySafe: true` is the second
 * input, and it is the one that keeps a whole family registered when
 * `SPOTIFY_MCP_READONLY=1` is set.
 *
 * Both are conventions about text, and neither looks at the code that runs. A
 * module can gain a `client.post` and every derived signal stays exactly as it
 * was — the name did not change, the `readOnlySafe` flag did not change, and
 * the census does not move. The stats.fm family is the worked example:
 * `taste_to_playlist` was documented as the single writer in an otherwise
 * read-only family, and `src/tools/statsfm_jukebox.ts` grew a second one
 * (`client.delete` on `/playlists/{id}/items`, with a `client.post` beside it),
 * with the family still documented as read-only. Nothing fired, because nothing
 * read the handler.
 *
 * This asks the question a name cannot answer: **does the code behind a
 * read-only module actually write to Spotify?**
 *
 * ## Scope, and what it deliberately does not claim
 *
 * This is a source-level check, not a semantic one.
 *
 * It DOES establish: a module that survives `SPOTIFY_MCP_READONLY=1` contains no
 * POST/PUT/PATCH/DELETE against a client-shaped receiver. That is the property
 * that actually bit, and it is the guarantee `readOnlySafe` implies and does not
 * currently enforce.
 *
 * It does NOT establish that a description's prose matches its handler. Whether
 * a read tool's *output* is described accurately is not machine-checkable today
 * and is not claimed here — claiming it would be a gate that reads as broader
 * than it is, which is the failure mode AGENTS.md §6 warns about.
 *
 * Known blind spots, each named rather than glossed:
 *
 *   - A write through a helper this scan does not follow. The patterns match on
 *     the *receiver* (`client.post`, `api.delete`, …), so a local wrapper with a
 *     different shape is invisible. The summary line prints the total call
 *     count, so a family silently dropping to zero is visible as a number
 *     rather than as a quiet pass.
 *   - A computed method name (`client[verb](…)`) is not matched.
 *   - A write on a rare branch is still caught: the scan is over source text,
 *     not over an executed path.
 *
 * Run: node --import tsx scripts/check-readonly-tools.mjs [--json]
 * Exits non-zero on any violation, naming the module, its file and the calls.
 */
import { readFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const asJson = process.argv.includes('--json');

/**
 * Mutating HTTP verbs as a method call on a client-shaped receiver.
 *
 * `get` is deliberately absent: reading is the normal case, and including it
 * would flag every module. The Spotify Web API's write surface is exactly
 * POST/PUT/PATCH/DELETE, so those four are the whole of it.
 */
const CLIENT_CALL = /\b(client|api|spotify|rest|http|fetchJson)\s*\.\s*(post|put|patch|delete)\s*\(/gi;

/**
 * The same verbs destructured onto a bare name, e.g. `const { post } = client`.
 *
 * Matched only at the start of a line, so `delete(` inside prose or an object
 * key does not count.
 */
const BARE_CALL = /^[ \t]*(?:await[ \t]+)?(post|put|patch|delete)\s*\(/gmi;

/**
 * Blank out comments and string/template literals, preserving offsets.
 *
 * A mutating call named in a doc comment or a code fence is not a write, and a
 * scanner that cannot tell the difference produces false positives that train
 * people to ignore it. Offsets are preserved by replacing with spaces rather
 * than deleting, so a reported line number still points at the right line.
 */
function blank(source) {
  const keepNewlines = (m) => m.replace(/[^\n]/g, ' ');
  return source
    .replace(/\/\*[\s\S]*?\*\//g, keepNewlines)
    .replace(/(^|[^:\\])\/\/[^\n]*/g, (m, p1) => p1 + ' '.repeat(Math.max(0, m.length - p1.length)))
    .replace(/'(?:\\.|[^'\\\n])*'/g, (m) => "'" + ' '.repeat(Math.max(0, m.length - 2)) + "'")
    .replace(/"(?:\\.|[^"\\\n])*"/g, (m) => '"' + ' '.repeat(Math.max(0, m.length - 2)) + '"')
    .replace(/`(?:\\.|[^`\\])*`/g, (m) => '`' + ' '.repeat(Math.max(0, m.length - 2)) + '`');
}

function lineOf(source, index) {
  return source.slice(0, index).split('\n').length;
}

function callsIn(file) {
  const raw = readFileSync(file, 'utf8');
  const source = blank(raw);
  const found = [];
  for (const m of source.matchAll(CLIENT_CALL)) {
    found.push({ line: lineOf(source, m.index), text: m[0].replace(/\s+/g, ' ').trim() });
  }
  for (const m of source.matchAll(BARE_CALL)) {
    found.push({ line: lineOf(source, m.index), text: m[1].toLowerCase() });
  }
  return found.sort((a, b) => a.line - b.line);
}

async function manifest() {
  // Read the TypeScript source, not compiled `dist/`, and say why.
  //
  // The first version of this gate imported `dist/tools/annotations.js` and
  // told the reader to run `npm run build` first. That is wrong twice over: the
  // `test:` job runs this step BEFORE any build, so it threw
  // `dist/tools/annotations.js is missing` on a perfectly good checkout — a
  // gate that fails on the tree it was written to defend. And the census in
  // this same job already reads the manifest the other way, via
  // `await import('../src/tools/annotations.ts')` under tsx.
  //
  // Reading the source also removes the ordering dependency entirely: the gate
  // no longer cares where `npm run build` sits in the job, so it cannot be
  // broken again by a step being moved. It still cannot drift from
  // `src/tools/annotations.ts` — that file is now the thing being read.
  const source = new URL('../src/tools/annotations.ts', import.meta.url).href;
  const mod = await import(source).catch((error) => {
    throw new Error(
      `could not load ${source}: ${error.message}\n`
        + 'This gate imports the TypeScript source, so it must run under tsx: '
        + '`node --import tsx scripts/check-readonly-tools.mjs`.',
    );
  });
  return mod.REGISTRAR_MANIFEST;
}

const entries = await manifest();
const violations = [];
let scannedModules = 0;
let totalCalls = 0;

for (const entry of entries) {
  if (entry.readOnlySafe !== true) continue;
  scannedModules += 1;
  const file = join(ROOT, entry.file);
  let calls;
  try {
    calls = callsIn(file);
  } catch (error) {
    throw new Error(`${entry.file} is listed in the manifest but could not be read: ${error.message}`);
  }
  if (calls.length === 0) continue;
  totalCalls += calls.length;
  violations.push({
    module: entry.key,
    file: entry.file,
    name: entry.name,
    calls,
  });
}

if (asJson) {
  process.stdout.write(`${JSON.stringify({ scannedModules, totalCalls, violations }, null, 2)}\n`);
} else if (violations.length === 0) {
  process.stdout.write(
    `read-only modules: ${scannedModules} scanned, 0 contain a mutating call.\n`,
  );
} else {
  process.stderr.write(
    `A module marked readOnlySafe contains a mutating call (#1604).\n\n`
      + `These modules stay registered when SPOTIFY_MCP_READONLY=1 is set, so a write\n`
      + `in one defeats the flag. The classification is derived from the module's name\n`
      + `and its readOnlySafe marker; neither moves when a write is added, which is why\n`
      + `this is checked against the source.\n\n`,
  );
  for (const v of violations) {
    process.stderr.write(`  ${v.module}  (${v.file})\n`);
    for (const c of v.calls) {
      process.stderr.write(`      ${relative(ROOT, join(ROOT, v.file))}:${c.line}  ${c.text}\n`);
    }
    process.stderr.write(
      `\n      Fix: drop the write, move the tool into a module that is not readOnlySafe,\n`
        + `      or — if the module genuinely only writes behind a confirmation gate that\n`
        + `      SPOTIFY_MCP_READONLY still permits — say so in a comment here and re-run.\n\n`,
    );
  }
  process.stderr.write(
    `Read the flag's guarantee in src/tools/annotations.ts (readOnlySafe) before\n`
      + `changing either side: the point of the flag is that nothing behind it writes.\n`,
  );
}

process.exit(violations.length === 0 ? 0 : 1);
