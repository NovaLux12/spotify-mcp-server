#!/usr/bin/env node
/**
 * Duplicate-config-accessor guard (#1625).
 *
 * `getConfig()` is the single source of truth for the `SPOTIFY_MCP_*` family,
 * and the natural way to consume one field from a tool module is
 * `getConfig().fetchAllCap` at the point of use. That is fine. What is not fine
 * is hoisting it into a module-scope binding, and the reason is that a
 * module-scope binding is a SECOND place the setting is named.
 *
 * Three modules each declared their own `const FETCH_ALL_CAP = () =>
 * getConfig().fetchAllCap` — byte-identical, and each carrying a comment
 * asserting it was the same as the others. By then the name `FETCH_ALL_CAP`
 * meant two things: the environment variable, and a local re-binding of it. A
 * reader could not tell which a file meant, and a fourth declaration would have
 * looked like the other three rather than like the problem it was.
 *
 * Why the whole test suite did not catch it: roughly ten test files reference
 * `FETCH_ALL_CAP`, and every one of them references the ENVIRONMENT VARIABLE in
 * a string — the contract, not the constant. A fourth copy of the declaration
 * passes every assertion in the repository.
 *
 * So this gate watches the shape, not the name. A name check would be defeated
 * by the obvious response (call the fourth one `FETCH_ALL_LIMIT`), and it would
 * also fire on the dozens of places that legitimately name the environment
 * variable in prose and in `.describe()` text. What actually distinguishes a
 * duplicate is a module-scope binding whose initialiser reads a config field,
 * so that is what this looks for — anchored at column 0, because the ~40
 * legitimate call sites are all function-local `const cap = getConfig()...` and
 * a rule that could not tell the two apart would be a gate nobody could keep
 * green.
 *
 * SCOPE: this walk covers `src/` only. A re-binding staged in `scripts/`, or in
 * a top-level directory added later, is NOT policed — `--guarded-dir` can
 * point the walk elsewhere by hand, but nothing in CI does. Stated here because
 * the alternative is a reader assuming a coverage the walk does not have.
 *
 * The remedy is a shared accessor in `src/config.ts` — `fetchAllCap()` for the
 * value, `scanCapFloor(requested)` for the clamp that applies it.
 *
 * FAIL-CLOSED, in the two ways it could otherwise pass without having learned
 * anything:
 *   1. the walk finds no `.ts` files at all (exit 2) — the same refusal
 *      `check-script-syntax.mjs` makes, and for the same reason: a gate pointed
 *      at an empty directory reports success, which is the one thing a gate
 *      must never do;
 *   2. the tree contains no `getConfig(` anywhere. The rule below is a pattern
 *      over a call shape; rename that function and the pattern still compiles,
 *      still matches nothing, and still reports "No ... re-bindings" — a clean
 *      bill of health for a scanner that can no longer see its own subject. A
 *      count of zero is the measurable form of that, so it is measured.
 *
 * `--check-fixture <path>` runs the same collector over one file and exits
 * non-zero on a hit, so the gate can be proved to fire instead of assumed to.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { blankNonCode } from './blank-non-code.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const GUARDED_DIR = 'src';

const fixtureIndex = process.argv.indexOf('--check-fixture');
if (fixtureIndex >= 0 && !process.argv[fixtureIndex + 1]) {
  throw new Error('--check-fixture requires a file path');
}

// Points the walk at a different subtree: a repository-relative path, which is
// what CI and a local run use, or an absolute one. It exists so the two
// refusals above — zero files, and no `getConfig(` anywhere — can be driven by a
// test rather than described in a comment, since neither is reachable by
// editing a file in a repository that has files in it. The absolute form is
// what lets that test stage its trees under os.tmpdir() instead of inside the
// checkout, which scripts/check-no-repo-root-fixtures.mjs forbids.
const dirIndex = process.argv.indexOf('--guarded-dir');
if (dirIndex >= 0 && !process.argv[dirIndex + 1]) {
  throw new Error('--guarded-dir requires a directory path');
}
const guardedDir = dirIndex >= 0 ? process.argv[dirIndex + 1] : GUARDED_DIR;

/**
 * A module-scope binding of one `getConfig()` field.
 *
 * The `^` with the `m` flag is the whole scoping decision: it admits only
 * declarations at column 0. A function-local `const cap = getConfig().x` is the
 * ordinary way to read a setting once per call and is indented, so it never
 * matches. The optional `() =>` wrapper is admitted because that is the shape
 * the three duplicates actually took — a thunk rather than a capture, since
 * `initConfig` re-binds the snapshot and a module-scope capture would be stale
 * by construction.
 */
const MODULE_SCOPE_CONFIG_BINDING =
  /^(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=\n]+)?=\s*(?:\(\s*\)\s*=>\s*)?getConfig\s*\(\s*\)\s*\.\s*([A-Za-z_$][\w$]*)/gm;

/**
 * Destructuring the whole config object: `const { fetchAllCap: CAP } = getConfig()`.
 *
 * The most idiomatic way a fourth author would re-bind the setting, and the one
 * the pattern above cannot see: there is no `.field` on the right-hand side to
 * anchor to, so the first version of this gate matched it only if the author
 * happened to write a member access. Same column-0 scoping, same reason.
 */
const MODULE_SCOPE_CONFIG_DESTRUCTURE =
  /^(?:export\s+)?(?:const|let|var)\s*\{([^}]*)\}\s*(?::[^=\n]+)?=\s*getConfig\s*\(\s*\)/gm;

/**
 * A bare module-scope assignment: `let CAP; … CAP = getConfig().maxItems;`.
 *
 * No declaration on the line, so the declaration pattern cannot reach it. Kept
 * to a bare identifier with no `.` before the `=`, which is what keeps
 * `someObject.cap = getConfig().x` — a property write on someone else's object,
 * which names no config field of its own — out of the results.
 */
const MODULE_SCOPE_CONFIG_ASSIGNMENT =
  /^([A-Za-z_$][\w$]*)\s*=\s*(?:\(\s*\)\s*=>\s*)?getConfig\s*\(\s*\)\s*\.\s*([A-Za-z_$][\w$]*)/gm;

/**
 * Column-0 openers whose BODY is module scope even though its members are
 * indented: an object literal bound to a module-scope name, and a class body.
 * Without this, `{ cap: () => getConfig().x }` is a re-binding that is indented
 * and therefore invisible to every `^`-anchored rule above.
 */
const MODULE_SCOPE_CONTAINER =
  /^(?:export\s+)?(?:const|let|var)\s+[A-Za-z_$][\w$]*\s*(?::[^=\n]+)?=\s*\{|^(?:export\s+)?(?:abstract\s+)?class\s+[A-Za-z_$][\w$]*/gm;

/**
 * A direct member of such a container whose value reads a config field, as two
 * patterns rather than one.
 *
 * They have to be two. A single pattern with an optional type annotation
 * (`: Type =`) cannot also allow a thunk value (`: () => getConfig().x`),
 * because the annotation's `[^=\n]` happily swallows ` () ` and then matches
 * the `=` of the arrow — leaving `>` where `getConfig` was expected, so the
 * exact shape this gate exists to catch is the one shape it silently missed.
 * The thunk form is therefore tried first, and neither pattern may contain a
 * bare `=` ahead of `getConfig` for the other to trip over.
 */
const CONTAINER_MEMBER_THUNK =
  /^\s*(?:readonly\s+)?(?:["'][^"']*["']|[A-Za-z_$][\w$]*)\s*:\s*(?:\(\s*\)\s*=>\s*)?getConfig\s*\(\s*\)\s*\.\s*([A-Za-z_$][\w$]*)/;

/** The assigned form: a class field, or a member with an explicit type. */
const CONTAINER_MEMBER_ASSIGNED =
  /^\s*(?:(?:public|private|protected|readonly|declare|static)\s+)*#?[A-Za-z_$][\w$]*\s*(?::[^=\n>]+)?=\s*(?:\(\s*\)\s*=>\s*)?getConfig\s*\(\s*\)\s*\.\s*([A-Za-z_$][\w$]*)/;

/**
 * The config property each destructured element reads, or `null` for a rest
 * element (`...rest`), which names no single setting and so cannot be reported
 * as one. The line is reported either way — the reader sees the declaration.
 */
function destructuredFields(body) {
  return body
    .split(',')
    .map((part) => {
      const key = part.trim().replace(/^\.\.\./, '').split(':')[0].split('=')[0].trim();
      return /^["']?([A-Za-z_$][\w$]*)["']?$/.exec(key)?.[1] ?? null;
    })
    .filter((field) => field !== null);
}

/** The index just past the `}` matching the `{` at `open`, or -1. */
function closingBrace(code, open) {
  let depth = 0;
  for (let i = open; i < code.length; i += 1) {
    if (code[i] === '{') depth += 1;
    else if (code[i] === '}') {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/**
 * The DIRECT members of a container body — the ones a `{` or `,` or `;` at
 * depth 0 separates. Members nested inside a function body or a sub-object sit
 * at depth ≥ 1 and are deliberately excluded: those are the ~40 legitimate
 * function-local reads this gate exists not to fire on.
 */
function directMembers(body) {
  const members = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < body.length; i += 1) {
    const ch = body[i];
    if (ch === '{' || ch === '(' || ch === '[') depth += 1;
    else if (ch === '}' || ch === ')' || ch === ']') depth -= 1;
    else if (depth === 0 && (ch === ',' || ch === ';')) {
      members.push({ text: body.slice(start, i), offset: start });
      start = i + 1;
    }
  }
  members.push({ text: body.slice(start), offset: start });
  return members;
}

/**
 * Every module-scope config-accessor re-binding in one blanked source file, as
 * `{ index, fields }` — `index` into the blanked text (which preserves offsets
 * and newlines, so it resolves to a line in the original), `fields` the config
 * settings it re-bound.
 *
 * Computed once and consumed by both exported collectors, so the error list and
 * the field list cannot disagree about what was found — the failure mode where
 * the gate names a line and the field report names a different setting.
 */
function findDuplicateConfigAccessors(code) {
  const found = [];
  for (const match of code.matchAll(MODULE_SCOPE_CONFIG_BINDING)) {
    found.push({ index: match.index, fields: [match[2]] });
  }
  for (const match of code.matchAll(MODULE_SCOPE_CONFIG_DESTRUCTURE)) {
    const fields = destructuredFields(match[1]);
    if (fields.length > 0) found.push({ index: match.index, fields });
  }
  for (const match of code.matchAll(MODULE_SCOPE_CONFIG_ASSIGNMENT)) {
    found.push({ index: match.index, fields: [match[2]] });
  }
  for (const match of code.matchAll(MODULE_SCOPE_CONTAINER)) {
    const open = code.indexOf('{', match.index);
    if (open < 0) continue;
    const close = closingBrace(code, open);
    if (close < 0) continue;
    for (const member of directMembers(code.slice(open + 1, close))) {
      const read = CONTAINER_MEMBER_THUNK.exec(member.text) ?? CONTAINER_MEMBER_ASSIGNED.exec(member.text);
      if (read) found.push({ index: open + 1 + member.offset, fields: [read[1]] });
    }
  }
  return found.sort((a, b) => a.index - b.index);
}

/**
 * Every module-scope config-accessor re-binding in one source file, as
 * `file:line: text`. Returns `[]` when the file is clean — that empty array is
 * the comparison the gate turns on, so it is computed by the collector rather
 * than injected by a caller.
 *
 * The premise the pattern rests on is asserted back to the caller, not assumed:
 * if `getConfig` does not appear in the blanked code at all there is nothing
 * here to find, and reporting "clean" for that would be a scanner claiming a
 * thing is absent because it could not see it. The fixture mode below is what
 * turns that into a hard failure instead of a shrug.
 */
export function collectDuplicateConfigAccessorErrors(source, file) {
  const code = blankNonCode(source);
  const found = [];
  for (const hit of findDuplicateConfigAccessors(code)) {
    const line = code.slice(0, hit.index).split('\n').length;
    const text = source.split('\n')[line - 1]?.trim() ?? '';
    found.push(`${file}:${line}: ${text}`);
  }
  return found;
}

/** The field names this gate has seen re-bound, as `file:field` strings. */
export function collectReboundFields(source, file) {
  const code = blankNonCode(source);
  return findDuplicateConfigAccessors(code).flatMap((hit) => hit.fields.map((field) => `${file}:${field}`));
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

if (fixtureIndex >= 0) {
  const fixturePath = resolve(process.argv[fixtureIndex + 1]);
  const found = collectDuplicateConfigAccessorErrors(readFileSync(fixturePath, 'utf8'), relative(ROOT, fixturePath));
  for (const error of found) console.error(error);
  process.exit(found.length > 0 ? 1 : 0);
}

const guarded = walk(resolve(ROOT, guardedDir)).sort();
if (guarded.length === 0) {
  console.error(
    `Duplicate-config-accessor guard: found no .ts files under ${guardedDir}. That is a gate looking at nothing, not a passing gate.\n`,
  );
  process.exit(2);
}

const errors = guarded.flatMap((file) => collectDuplicateConfigAccessorErrors(readFileSync(file, 'utf8'), relative(ROOT, file)));

// The premise, measured rather than assumed: the rule matches on `getConfig(`
// and nothing else. If that call shape is gone from the tree, "no re-bindings"
// is not a finding — it is the absence of a finding, from a rule that has
// nothing left to match.
const premiseHits = guarded.reduce((total, file) => (
  total + [...blankNonCode(readFileSync(file, 'utf8')).matchAll(/\bgetConfig\s*\(/g)].length
), 0);
if (premiseHits === 0) {
  console.error(
    `Duplicate-config-accessor guard: no \`getConfig(\` call anywhere under ${guardedDir}. This gate matches on that call shape, so it can no longer see the thing it exists to police, and "no re-bindings" would be a claim about nothing. Update MODULE_SCOPE_CONFIG_BINDING in scripts/check-no-duplicate-config-accessors.mjs to whatever reads the config now.\n`,
  );
  process.exit(2);
}

if (errors.length > 0) {
  console.error(`Duplicate-config-accessor guard failed (${errors.length} module-scope re-binding${errors.length === 1 ? '' : 's'} under ${guardedDir}):\n${errors.map((line) => `- ${line}`).join('\n')}`);
  console.error('A config setting has one home. Import the shared accessor from src/config.ts (`fetchAllCap()` for the value, `scanCapFloor(requested)` for the clamp) and read it at the point of use; a module-scope binding makes the name mean two things and is a snapshot taken at import time.');
  process.exitCode = 1;
} else {
  console.log(`No module-scope config-accessor re-bindings under ${guardedDir} (${guarded.length} files checked).`);
}
