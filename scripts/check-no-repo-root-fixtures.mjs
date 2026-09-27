#!/usr/bin/env node
/**
 * Test-fixture-location guard (#1383).
 *
 * A test that creates a directory *inside the repository* leaves the working
 * tree dirty the moment it is killed before its cleanup runs, and an OOM kill at
 * load 60-90 is routine on this box. The leak is not the problem — the
 * misreading is. `git status --porcelain` being clean is this repo's standing
 * assertion that no generated block is stale, so an untracked
 * `.census-fixture-*` makes a correct change read as a stale one, and every
 * plausible next step (`--write`, a hand-reconciled block) touches the one thing
 * that must never be hand-edited. The census's marker scan skips dot-entries
 * (#1238), so the census never noticed; only the check whose whole job is to
 * notice a change on disk did.
 *
 * So every `mkdtemp` / `mkdtempSync` under `tests/` must be rooted at
 * `os.tmpdir()`, directly or through a name that is itself defined that way.
 * The derived-name step is what keeps the gate honest without a hand-kept
 * allowlist: `HERMETIC_ROOT` is `mkdtempSync(join(tmpdir(), …))` in
 * `tests/helpers/hermetic.ts`, so it is accepted because the source says so,
 * not because this file says so. A name that stops resolving to `tmpdir()`
 * drops out of the derived set and its call sites become hits.
 *
 * Two properties of that derivation are load-bearing, and both came from the
 * gate reporting a clean tree over the defect it exists to catch:
 *
 *  - It is **per file**, not pooled. `tests/store-bounds.test.ts` defines its
 *    own `const ROOT = await mkdtemp(join(tmpdir(), …))`; pooled across the
 *    tree, that name licensed `join(ROOT, …)` everywhere, which is the #1383
 *    call site. See `tmpdirDerivedRoots`.
 *  - It **follows relative imports** rather than rejecting them.
 *    `tests/helpers/stdio-child.ts` roots a child home at the imported
 *    `HERMETIC_ROOT`, which is correct — that home has to live under the
 *    hermetic root for the helper's own cleanup to remove it. "Fixing" it to a
 *    bare `tmpdir()` would be changing working code to satisfy a gate.
 *
 * A bare import specifier, or one that leaves `tests/`, stays unproven and its
 * call sites become hits. That is the conservative direction: a false positive
 * costs one edit, a false negative costs an agent a hand-edit of a generated
 * block.
 *
 * Comments and string bodies are blanked before the call scan, so a test that
 * documents this defect — or embeds a child's source in a template — is not a
 * hit. `${…}` holes stay visible, so a call smuggled into an interpolation is
 * still caught. The *import* scan deliberately reads raw source, because the
 * specifier it needs is a string literal and blanking erases exactly that; see
 * `tmpdirDerivedRoots`.
 *
 * `--check-fixture <path>` runs the same collector over one file and exits
 * non-zero on a hit, so the gate can be proved to fire rather than assumed to.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import { blankNonCode } from './blank-non-code.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const GUARDED_DIR = 'tests';

/** `mkdtemp(` / `mkdtempSync(`, not `fs.mkdtemp` re-exported under a namespace. */
const MKDEMP_CALL = /(?<![\w$.])mkdtemp(?:Sync)?\s*\(/g;

/**
 * `MKDEMP_CALL` widened to also match `mkdir` / `mkdirSync`.
 *
 * **Not a gate.** It exists so the cost of widening can be measured against the
 * real tree — see `widenedMkdirMeasurements`. Every call it matches today is a
 * false positive, which is the entire justification for the `mkdtemp`-only
 * scope, so the number belongs somewhere it can be re-derived rather than in a
 * docstring that goes stale the next time a test is added.
 */
const WIDENED_MKDEMP_CALL = /(?<![\w$.])(?:mkdtemp|mkdir)(?:Sync)?\s*\(/g;

/** `const NAME = mkdtemp(…)` — the definitions a derived root can come from. */
const MKDEMP_DEFINITION =
  /(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=]+)?=\s*(?:await\s+)?mkdtemp(?:Sync)?\s*\(/g;

/**
 * A named import clause: `import { A, B as C } from './helpers/hermetic.js'`.
 *
 * Only relative specifiers are matched. A bare specifier cannot be resolved to a
 * file under `tests/`, so a name it exports stays unproven and its call sites
 * become hits — the conservative direction (see `tmpdirDerivedRoots`).
 */
const RELATIVE_NAMED_IMPORT =
  /import\s*(?:type\s*)?\{([^}]*)\}\s*from\s*['"](\.[^'"]*)['"]/g;

/** An `export … from` re-export clause, so a derived root can travel one hop. */
const RELATIVE_REEXPORT = /export\s*(?:\*|\{[^}]*\})\s*from\s*['"](\.[^'"]*)['"]/g;

/**
 * The names a file imports relatively, as `specifier → Set<localName>`.
 *
 * Both halves are needed and they are not the same thing. The specifier says
 * *which module* a name came from; the local name is the one a call site in
 * this file can use, which is the `as` alias when there is one. Conflating the
 * two — resolving the local name as if it were the specifier — sends
 * `import { hermeticServerEnv } from './helpers/stdio-child.js'` looking for a
 * module named `hermeticServerEnv`, which resolves to nothing and silently
 * drops the edge. That is what the first version did.
 */
function relativeImports(code) {
  const bySpecifier = new Map();
  for (const match of code.matchAll(RELATIVE_NAMED_IMPORT)) {
    const [, clauseText, specifier] = match;
    if (!bySpecifier.has(specifier)) bySpecifier.set(specifier, new Set());
    const names = bySpecifier.get(specifier);
    for (const clause of clauseText.split(',')) {
      const parts = clause.trim().replace(/^type\s+/, '').split(/\s+as\s+/);
      const local = (parts[1] ?? parts[0] ?? '').trim();
      if (local) names.add(local);
    }
  }
  return bySpecifier;
}

/**
 * The relative specifier a file re-exports *everything* from, or `''`.
 *
 * `export * from './x.js'` propagates each name the target derives, so the
 * target is applied as an edge for every name this file binds from a `mkdtemp`.
 * A *named* re-export (`export { A } from './x.js'`) is not handled: nothing in
 * this tree uses one for a derived root, and guessing at it would mean
 * re-parsing the clause for a case with no instance to check against.
 */
function reexportSpecifier(code) {
  const star = /export\s*\*\s*from\s*['"](\.[^'"]*)['"]/.exec(code);
  return star ? star[1] : '';
}

/**
 * The text of the call that opens at `open` (the index of its `(`), up to and
 * including the `)` that balances it.
 *
 * A regex cannot do this: the first argument contains template literals and
 * nested calls (`mkdtemp(join(tmpdir(), \`run-${n}-\`))`), and stopping at the
 * first `)` would read `join(tmpdir()` as the whole argument — which is exactly
 * the shape that must be accepted. It also counts brackets and braces, so a
 * `)` inside `${…}` does not end the call.
 */
function callBody(code, open) {
  const pairs = { '(': ')', '[': ']', '{': '}' };
  const stack = [];
  for (let i = open; i < code.length; i++) {
    const c = code[i];
    if (c === '(' || c === '[' || c === '{') stack.push(pairs[c]);
    else if (c === ')' || c === ']' || c === '}') {
      const expected = stack.pop();
      if (expected !== c) return null;
      if (stack.length === 0) return code.slice(open + 1, i);
    }
  }
  return null;
}

/**
 * The first argument of a call body: everything before the first comma at depth
 * zero, or the whole body when there is no comma.
 */
function firstArgument(body) {
  let depth = 0;
  for (let i = 0; i < body.length; i++) {
    const c = body[i];
    if (c === '(' || c === '[' || c === '{') depth++;
    else if (c === ')' || c === ']' || c === '}') depth--;
    else if (c === ',' && depth === 0) return body.slice(0, i);
  }
  return body;
}

/** Strip `await`, whitespace, and a `path.` / `os.` namespace qualifier. */
function normalize(arg) {
  return arg
    .trim()
    .replace(/^await\s+/, '')
    .replace(/\s+/g, ' ')
    .replace(/^path\./, '')
    .replace(/^os\./, '');
}

/**
 * The directory a `mkdtemp` argument roots at, or `null` when it is something
 * this guard cannot prove escapes the repository.
 *
 * Accepts `join(tmpdir(), …)`, `join(os.tmpdir(), …)` and `mkdtemp(tmpdir())`.
 * A `join(<name>, …)` yields `<name>`. Anything else — a variable, a literal, a
 * computed expression — yields `null` and becomes a hit, because the gate cannot
 * prove such a path escapes the repository.
 *
 * The base is read by structure rather than by regex: `tmpdir()` is itself a
 * call, so a character class that excluded parentheses could never match the one
 * argument shape this guard exists to accept.
 */
function rootOf(argument) {
  const arg = normalize(argument);
  if (/^tmpdir\s*\(\s*\)$/.test(arg)) return 'tmpdir';
  const joined = /^join\s*\(/.exec(arg);
  if (!joined) return null;
  const inner = firstArgument(callBody(arg, joined.index + joined[0].length - 1) ?? '');
  const base = normalize(inner);
  if (/^tmpdir\s*\(\s*\)$/.test(base)) return 'tmpdir';
  return /^[A-Za-z_$][\w$]*$/.test(base) ? base : null;
}

/**
 * The names usable as a `mkdtemp` root in one file: `tmpdir` itself, plus any
 * name that file assigns from a `tmpdir()`-rooted `mkdtemp`, or imports from a
 * module that does (`HERMETIC_ROOT`). Resolved to a fixed point so a chain
 * resolves, and across imports so a helper's root licenses its consumers.
 *
 * Two scoping decisions are load-bearing, and both came from the negative
 * fixture failing to fail.
 *
 * **Per file, not global.** `tests/store-bounds.test.ts` defines its own
 * `const ROOT = await mkdtemp(join(tmpdir(), …))`. A name-based allowlist pooled
 * across the tree accepts that `ROOT` as a tmpdir root *everywhere* — and
 * `join(ROOT, …)` is precisely the #1383 call site — so the gate reported the
 * tree clean while passing the pre-fix fixture. Deriving per file means a name
 * licenses only the file that defines it or explicitly imports it.
 *
 * **Followed through imports, not rejected.** Per-file scoping alone flags
 * `tests/helpers/stdio-child.ts`, which roots a child home at the imported
 * `HERMETIC_ROOT`. That call is correct — the child home must live under the
 * hermetic root so the helper's own cleanup removes it — and "fixing" it to a
 * bare `tmpdir()` would be changing working code to satisfy a gate. So the
 * resolution walks the import instead. A bare specifier, or a file outside
 * `tests/`, stays unproven and its call sites become hits: that is the
 * conservative direction, since a false positive costs one edit and a false
 * negative costs an agent a hand-edit of a generated block.
 */
function tmpdirDerivedRoots(file, sources, seen = new Set()) {
  const entry = sources.get(file);
  if (!entry || seen.has(file)) return new Set();
  seen.add(file);
  // Raw source, not blanked. The import specifier this function has to read is
  // a string literal, and `blankNonCode` erases string literals — blanking here
  // makes every relative import invisible, so the one legal cross-file shape
  // (`HERMETIC_ROOT` rooted in `tests/helpers/hermetic.ts`) comes back a
  // finding. The definition and call scans run on raw text for the same reason;
  // the price is that a *comment* naming `const X = mkdtemp(join(tmpdir(), …))`
  // counts as a definition, which can only ever widen the accepted set by a
  // name the same file also has to reach.
  const code = entry.code;

  const definitions = new Map();
  for (const match of code.matchAll(MKDEMP_DEFINITION)) {
    const open = code.indexOf('(', match.index + match[0].length - 1);
    const body = callBody(code, open);
    if (body === null) continue;
    if (!definitions.has(match[1])) definitions.set(match[1], rootOf(firstArgument(body)));
  }
  // A name imported from another file resolves to whatever that file resolves,
  // and `export * from` propagates a name the same way. Both are ordinary
  // fixed-point edges: the loop below grows `derived` until it stops changing,
  // and `seen` breaks an import cycle by treating the revisit as unproven.
  const edges = new Map();
  for (const [specifier, names] of relativeImports(code)) {
    const target = resolveSpecifier(file, specifier, sources);
    if (target) for (const name of names) edges.set(name, target);
  }
  const star = reexportSpecifier(code);
  if (star) {
    const target = resolveSpecifier(file, star, sources);
    if (target) for (const name of definitions.keys()) edges.set(name, target);
  }

  const derived = new Set(['tmpdir']);
  // Each pass can only add a name whose own root — or whose import target's
  // name — already resolved, so the loop terminates; the bound only guards
  // against a future change to the definition pattern making it non-monotonic.
  for (let pass = 0; pass <= definitions.size + edges.size; pass++) {
    let changed = false;
    for (const [name, root] of definitions) {
      if (!derived.has(name) && root !== null && derived.has(root)) {
        derived.add(name);
        changed = true;
      }
    }
    for (const [name, target] of edges) {
      if (!derived.has(name) && tmpdirDerivedRoots(target, sources, seen).has(name)) {
        derived.add(name);
        changed = true;
      }
    }
    if (!changed) break;
  }
  return derived;
}

/**
 * The `tests/`-relative path a relative import specifier names, or `''` when it
 * escapes the guarded tree.
 *
 * `from` is repo-relative (that is how `loadGuarded` keys the map), so it is
 * joined onto `ROOT` before being related back — resolving a relative path
 * against `process.cwd()` would silently miss whenever the guard runs from
 * anywhere but the repository root. `.js` is rewritten to `.ts` because that is
 * how this repo's ESM TypeScript spells an intra-tree import. A path outside
 * `tests/` returns `''`, which the caller reads as "unproven" rather than "fine".
 */
function resolveSpecifier(from, specifier, sources) {
  const base = join(ROOT, dirname(from), specifier.replace(/\.js$/, '.ts'));
  const normalized = normalizeRepoPath(relative(ROOT, base));
  return sources.has(normalized) ? normalized : '';
}

/** Repo-relative, forward-slashed — the same spelling `loadGuarded` uses. */
function normalizeRepoPath(path) {
  return path.split(sep).join('/');
}

/**
 * The map key for a file, whether the caller named it absolutely (the CLI's
 * `--check-fixture` passes a resolved path) or repo-relative (the tree walk).
 *
 * A key that misses the map would silently resolve no imports *and* no local
 * definitions, so every call in that file becomes a hit — including
 * `join(tmpdir(), …)`. That is how the first `--check-fixture` run reported the
 * fixed call site as a finding, so the fixture is added to the map under its
 * own key rather than trusted to be found in it.
 */
function sourceKey(file, sources) {
  if (sources.has(file)) return file;
  const relativeKey = normalizeRepoPath(relative(ROOT, resolve(file)));
  return sources.has(relativeKey) ? relativeKey : file;
}

/**
 * Every `mkdtemp` in one source file that is not rooted at `tmpdir()`, as
 * `file:line: text`. Returns `[]` when the file is clean — that empty array is
 * the comparison the gate turns on, so it is computed here rather than injected
 * by a caller.
 *
 * **Scope: `mkdtemp`, not `mkdir`.** `mkdtemp` is the primitive that creates a
 * fixture *root* — the directory whose whole subtree is scratch, and the one
 * call whose argument *is* the root. `mkdir` is nearly always called on a
 * subdirectory of such a root (`mkdir(join(dir, 'docs'))`, where `dir` came
 * from a tmpdir `mkdtemp` a line earlier), so there is no anchor: deciding
 * those calls safe means resolving a local across statements, and a wrong
 * resolution is a false red, which is how a gate gets ignored. Widening the
 * pattern to match `mkdir` as well therefore reports dozens of findings on a
 * tree that is in fact clean. That count is deliberately **not** written here:
 * it moves every time a test is added, so a figure in this paragraph would be
 * wrong within a release — the exact rot §6 of AGENTS.md describes. Measure it
 * instead, with `widenedMkdirMeasurements` below, which re-runs this collector
 * with the call pattern widened. A false positive costs one edit; a false
 * negative costs an agent a hand-edit of a generated block.
 *
 * **The residual risk, stated honestly.** A `mkdir` rooted directly at the
 * repository is not covered, and the two things that used to be named as its
 * backstop do not hold it up:
 *
 *  - The census marker scan skips *dot-entries* (#1238). `scanGeneratedMarkers`
 *    skips an entry when `entry.name.startsWith('.')`, so a fixture directory
 *    named `.census-fixture-…` is invisible to it — but that is a property of
 *    the *name*, not of its being a leak. A `mkdir(join(ROOT, 'scratch'))` is
 *    not a dot-entry and the scan walks straight into it. The dot-skip is not a
 *    mitigation for an uncovered `mkdir`; it is a mitigation for the one leak
 *    that happened to be named like a dot-entry.
 *  - `git status --porcelain` does not report an **empty** untracked directory,
 *    because git does not track empty directories at all. A `mkdir` that is
 *    killed before its first write leaves no entry to report, so the signal
 *    only exists once something has been written into the directory.
 *
 * What is left is the honest version: the static gate covers `mkdtemp`, and a
 * repo-rooted `mkdir` is caught by a reviewer reading the diff, not by this
 * file. No test in this tree roots a `mkdir` at the repository — every widened
 * finding resolves to a `tmpdir()` root, which `widenedMkdirMeasurements`
 * re-derives on each run rather than a comment asserting it.
 */
export function collectRepoRootFixtureErrors(source, file, sources = new Map()) {
  return collectWithPattern(source, file, sources, MKDEMP_CALL);
}

/**
 * The same collector, with the call pattern supplied by the caller.
 *
 * This exists so the `mkdir` boundary can be *measured* rather than asserted in
 * prose. `WIDENED_MKDEMP_CALL` matches `mkdir` as well, and running it over the
 * real tree reproduces the false-positive count the docstring above cites — so
 * if a future change makes widening viable (every `mkdir` in `tests/` rooted at
 * a resolvable `tmpdir()`), the measurement falls and the boundary is
 * re-arguable from evidence instead of from a number nobody rechecked. A
 * boundary justified by a hand-typed figure is the same rot §6 of AGENTS.md
 * describes, one level down.
 */
export function collectWithPattern(source, file, sources = new Map(), pattern = MKDEMP_CALL) {
  const code = blankNonCode(source);
  const key = sourceKey(file, sources);
  // Judge the file against the real tree, with itself present: a fixture that
  // imports `HERMETIC_ROOT` must resolve exactly as the file it stands in for.
  // The map stores *raw* source — `tmpdirDerivedRoots` reads it unblanked,
  // because the import specifier it needs is a string literal.
  const tree = sources.has(key) ? sources : new Map(sources).set(key, { file: key, code: source });
  const allowed = tmpdirDerivedRoots(key, tree);
  const lines = source.split('\n');
  const found = [];
  for (const match of code.matchAll(pattern)) {
    const open = code.indexOf('(', match.index);
    const body = callBody(code, open);
    if (body === null) continue;
    const root = rootOf(firstArgument(body));
    if (root !== null && allowed.has(root)) continue;
    const line = code.slice(0, match.index).split('\n').length;
    found.push({ line, text: lines[line - 1]?.trim() ?? '', root });
  }
  return found.map(
    (hit) => `${file}:${hit.line}: fixture directory is not rooted at os.tmpdir() (${hit.root ?? 'unrecognised root'}) — ${hit.text}`,
  );
}

/**
 * What widening the gate to `mkdir` would cost, as `file:line` strings over the
 * real `tests/` tree. Not a gate — a measurement, consumed by the boundary test.
 *
 * Every entry is a *false* positive today: the `mkdir` is on a subdirectory of a
 * fixture root, which the guard resolves only for `mkdtemp`. That is the whole
 * argument for the boundary, so it is worth being able to re-run rather than
 * quote. Exported so the test measures the real tree instead of asserting a
 * count that drifts.
 */
export function widenedMkdirMeasurements(sources) {
  const findings = [];
  for (const { file, code } of sources.values()) {
    for (const error of collectWithPattern(code, file, sources, WIDENED_MKDEMP_CALL)) {
      findings.push(error.split(' — ')[0].replace(/ \(.*\)$/, ''));
    }
  }
  return findings;
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

/** Every `.ts` under `tests/`, keyed by repo-relative path. */
function loadGuarded() {
  return new Map(
    walk(join(ROOT, GUARDED_DIR))
      .sort()
      .map((file) => {
        const key = normalizeRepoPath(relative(ROOT, file));
        return [key, { file: key, code: readFileSync(file, 'utf8') }];
      }),
  );
}

const fixtureIndex = process.argv.indexOf('--check-fixture');
if (fixtureIndex >= 0) {
  if (!process.argv[fixtureIndex + 1]) {
    throw new Error('--check-fixture requires a file path');
  }
  const path = resolve(process.argv[fixtureIndex + 1]);
  // The fixture is resolved against the real tree, not scoped to itself: a
  // fixture that imports `HERMETIC_ROOT` has to be judged the way the file it
  // stands in for would be.
  const sources = loadGuarded();
  const found = collectRepoRootFixtureErrors(readFileSync(path, 'utf8'), path, sources);
  for (const error of found) console.error(error);
  process.exit(found.length > 0 ? 1 : 0);
}

const guarded = loadGuarded();
const errors = [...guarded.values()].flatMap(({ file, code }) =>
  collectRepoRootFixtureErrors(code, file, guarded));

if (errors.length > 0) {
  console.error(`Test fixture-location guard failed (${errors.length} call${errors.length === 1 ? '' : 's'} under ${GUARDED_DIR}):\n${errors.map((line) => `- ${line}`).join('\n')}`);
  console.error('Root the fixture at os.tmpdir(). A directory created inside the repository survives a kill as an untracked entry, and a dirty `git status --porcelain` is this repo\'s signal that a generated block is stale — so a correct change ends up reading as a stale one.');
  process.exitCode = 1;
} else {
  console.log(`Every mkdtemp under ${GUARDED_DIR} is rooted at os.tmpdir() (${guarded.size} files checked).`);
}
