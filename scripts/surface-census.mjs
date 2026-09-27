#!/usr/bin/env node
/**
 * Enumerate the finalized default production MCP registry without network I/O.
 *
 * The authoritative surface is the real `src/index.ts` stdio entry, driven by
 * the MCP client SDK. Registration gates and production finalizers therefore
 * run exactly as they do for a host. The same shared registrar manifest used
 * by startup supplies module attribution and schema measurements; its owned
 * names must equal the finalized `tools/list` names exactly.
 *
 * Plain `node scripts/surface-census.mjs` prints JSON. `--write` refreshes
 * generated documentation blocks and `--check` guards them in CI.
 */
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, extname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  contradictedByUpstream,
  gitProvenanceIn,
  proseDrift,
  proseProvenanceVerdict,
  proseSyncRefusals,
  readFilesAtRef,
  short,
  stampProvenance,
  syncProseManifest,
} from './prose-manifest.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const requireFromRoot = createRequire(join(ROOT, 'package.json'));
let localModules;
try {
  localModules = realpathSync(join(ROOT, 'node_modules'));
} catch {
  throw new Error('surface census requires repository-local dependencies; run npm install before census');
}
const zodEntry = requireFromRoot.resolve('zod');
if (!zodEntry.startsWith(`${localModules}${sep}`)) {
  throw new Error(`surface census resolved zod outside repository dependencies: ${zodEntry}`);
}
const args = process.argv.slice(2);
/**
 * The members of the `SeveralKind` union that `fetchSeveral` in
 * `src/tools/catalog.ts` reads as the computed path `/${kind}`.
 *
 * Declared here, at module scope, rather than beside `gatedCallSites()`:
 * `checkDocumentation()` runs at import time and reaches this before the
 * function declarations below are hoisted past their `const` initializers. A
 * `const` declared next to its only consumer throws a TDZ `ReferenceError`
 * from the top-level census run, which reads as a crash rather than a gate.
 */
const SEVERAL_KINDS = ['tracks', 'albums', 'artists', 'episodes', 'shows', 'audiobooks', 'chapters'];

/**
 * File extensions that can carry a generated block (#1238).
 *
 * An allowlist rather than "read everything": the census is a gate that runs on
 * every `--check`, and the repository also holds images and a lockfile. A
 * generated block in some other file type is not a shape this project uses —
 * `blocks` writes Markdown and one `//`-commented TypeScript module.
 *
 * Declared here, beside `SEVERAL_KINDS`, for the reason that comment gives:
 * `checkDocumentation()` runs at import time and reaches these through
 * `scanGeneratedMarkers`, so a `const` left beside its only consumer throws a
 * TDZ `ReferenceError` that reads as a crash rather than a gate.
 */
const MARKER_SCAN_EXTENSIONS = new Set([
  '.md', '.mdx', '.txt', '.ts', '.tsx', '.js', '.mjs', '.cjs', '.json', '.yaml', '.yml',
]);

/**
 * Directories skipped wholesale, in addition to every dot-entry (#1238).
 *
 * Dot-entries are skipped because they are VCS and tool metadata (`.git`,
 * `.github`, `.gitignore`) that is not authored prose, and because the hazard
 * they carry is concurrent-write safety, not any particular fixture (#1238).
 * This scan is a gate that other processes write to underneath it: any
 * directory the repository does not version — a fixture root, a scratch tree,
 * an editor's swap directory — can be created and populated by a sibling
 * process while the scan is walking, so reading one can observe a half-written
 * file and report a marker pair that does not exist, or miss one that does. Test
 * files here run in parallel against a shared working tree, which is one
 * instance of that; it is not the only one, and a justification that named a
 * single call site would go stale the moment that call site moved.
 *
 * The invariant, then, is: *skip everything the repository does not version.*
 * A dot-entry is untracked by construction, so it is skipped for that reason
 * and not because a particular test once wrote into one. The named directories
 * below are the tracked-but-generated ones — a dependency tree, a build
 * output, a coverage report — which are unversioned in the same way even
 * though their names do not begin with a dot. That is also why a *future*
 * non-dot fixture directory in the repository is NOT covered by this rule and
 * will be walked; see the residual-risk note in `check-no-repo-root-fixtures.mjs`.
 * Same TDZ reason as above for being module-scope.
 */
const MARKER_SCAN_SKIP = new Set(['node_modules', 'dist', 'coverage', 'outbox', 'logs', 'backups']);

/**
 * A single `BEGIN:generated` / `END:generated` marker line, in whichever of the
 * two syntaxes the file uses (#1238).
 *
 * The trailing ` -->` is optional so a *malformed* marker still registers as a
 * marker. A stray `<!-- BEGIN:generated foo` with no closer is exactly the
 * orphan #1238 is about; matching only the well-formed spelling would let it
 * through unnoticed, which is the defect the issue describes. Module scope for
 * the same TDZ reason as the two sets above.
 */
const MARKER_LINE = /^[ \t]*(?:\/\/[ \t]*|<!--[ \t]*)(BEGIN|END):generated ([a-z0-9][a-z0-9-]*)[ \t]*(?:-->)?[ \t]*$/gm;

/**
 * Character classes for the gated-endpoint scan's lexer (`lexSource`), plus
 * the two dispatch sets keyed off registration shape.
 *
 * Module scope for the same TDZ reason as the sets above: `--gated-calls`
 * reaches the scan at import time, and a `const` left beside its only consumer
 * throws a `ReferenceError` that reads as a crash rather than a gate.
 */
const TS_IDENT_START = /[A-Za-z_$]/;
const TS_IDENT_PART = /[A-Za-z0-9_$]/;
const TS_WHITESPACE = /\s/;
const TS_DIGIT = /[0-9]/;

const OPEN_TO_CLOSE = { '(': ')', '[': ']', '{': '}' };

const REGISTRATION_METHODS = new Set(['tool', 'registerTool']);

const CLIENT_READ_METHODS = new Set(['get', 'getAllPages']);
const FUNCTION_NAME_PRECEDER = new Set(['function', '=', '{', ',', ';', 'async', 'static', 'public', 'private', 'protected', 'get', 'set', '*']);

const TS_REGEX_AFTER_KEYWORD = new Set([
  'return', 'typeof', 'instanceof', 'in', 'of', 'new', 'delete', 'void',
  'throw', 'case', 'do', 'else', 'yield', 'await',
]);

/**
 * Call shapes the gated-endpoint scan cannot follow, each one named (#1278).
 *
 * Before #1278 the per-FILE verdict made this tolerance implicit: a family was
 * satisfied by one gated call in any of its files, so a call site no tool could
 * be held to inherited the status of an unrelated tool in the same file, and a
 * call in no tool at all was indistinguishable from a call in every tool. The
 * per-tool gate has no such fallback, so every shape the scan cannot attribute
 * has to be written down here — with the tool it serves and why — or the gate
 * reports it as unattributed and fails.
 *
 * That is the trade the issue names: a smaller, honest allow-list instead of a
 * larger, silent one. An entry is itself gated, so it cannot rot unnoticed —
 * `checkGatedEndpointTruth` fails an entry whose tool is no longer declared by
 * the family, is not registered by the file the entry names, or has become
 * visible to the scan (at which point the entry is stale and must be deleted).
 *
 * Module scope for the same TDZ reason as the sets above.
 */
const GATED_SCAN_EXCEPTIONS = [
  {
    family: 'artist-top-tracks',
    file: 'catalog.ts',
    tool: 'get_artist_top_tracks',
    reason: 'the path is passed as an ARGUMENT to `getWithMarketFallback` (src/markets.ts), '
      + 'not to `client.get`, and that wrapper is outside the scanned tree — so this tool has no '
      + 'gated `client.get` call site for the scan to attribute at all.',
  },
];

if (!process.env.SPOTIFY_MCP_SURFACE_CENSUS) {
  const child = spawnSync(process.execPath, ['--import', 'tsx/esm', fileURLToPath(import.meta.url), ...args], {
    cwd: ROOT,
    env: { ...process.env, SPOTIFY_MCP_SURFACE_CENSUS: '1' },
    stdio: 'inherit',
  });
  process.exit(child.status ?? 1);
}
const CENSUS_ENV = Object.freeze({
  SPOTIFY_CLIENT_ID: 'surface-census',
  SPOTIFY_MCP_SURFACE_CENSUS: '1',
  SPOTIFY_MCP_TOKEN_FILE: '',
  SPOTIFY_MCP_TOOLSETS: 'all',
  SPOTIFY_MCP_ENABLE_TOOLS: '',
  SPOTIFY_MCP_DISABLE_TOOLS: '',
  SPOTIFY_MCP_READONLY: '0',
  SPOTIFY_MCP_CONFIRM: 'never',
  SPOTIFY_MCP_MAX_ITEMS: '50',
  SPOTIFY_MCP_FETCH_ALL_CAP: '500',
  SPOTIFY_MCP_FRESHNESS_BUDGET: '25',
  SPOTIFY_MCP_HISTORY: '0',
  SPOTIFY_MCP_PROFILE: '',
  SPOTIFY_MCP_MARKET: '',
});
for (const key of Object.keys(process.env)) {
  if (key.startsWith('SPOTIFY_')) delete process.env[key];
}
Object.assign(process.env, CENSUS_ENV);
// SPOTIFY_SCOPES is deliberately absent rather than blanked with '': since #617 a
// set-but-empty value is a hard error (it used to read as "unset" and quietly
// request the widest default scope set). The sweep above already removed it.

const {
  moduleToolNames,
  loadManifestRegistrars,
  registerManifestModule,
  applyToolAnnotations,
  assertToolNamingPolicy,
  collectAggregateSurfaceMeasurement,
  AGGREGATE_SURFACE_LIMITS,
  REGISTRAR_MANIFEST,
  TOOL_SURFACE_BUDGET,
} = await import('../src/tools/annotations.ts');
// The per-call response cap (#895). Read from the constant so the doc's figure
// is generated rather than hand-typed: a prose figure here is exactly what
// `tests/doc-figures.test.ts` fails on, and a cap that changes must move the
// doc in the same commit.
const { MAX_RESPONSE_BYTES } = await import('../src/shaping.ts');
// `module.name` is the registrar's export name, carried as data since the
// loader is a thunk with no `.name` to read (#906). Two rows changed here:
// `statsfm` and `receipts` used to print their module key because their
// registrars were inline arrows; both now name a real export.
const productionManifest = REGISTRAR_MANIFEST.map((module) => ({
  registrar: module.name || module.key,
  file: normalizeRepoPath(module.file),
  key: module.registrationKey,
  ungated: module.alwaysActive === true,
}));
const markerFixtureIndex = args.indexOf('--marker-fixture');
if (markerFixtureIndex >= 0) {
  const fixturePath = args[markerFixtureIndex + 1];
  if (!fixturePath) throw new Error('--marker-fixture requires a JSON file');
  const fixture = JSON.parse(readFileSync(resolve(fixturePath), 'utf8'));
  const error = inspectGeneratedBlock(fixture.source, fixture.file, fixture.name, fixture.body);
  console.log(JSON.stringify({ error }));
  process.exit(error ? 1 : 0);
}
const descriptionFixtureIndex = args.indexOf('--description-fixture');
if (descriptionFixtureIndex >= 0) {
  // Drives `firstDescription` directly, so the #1258 regression test can feed
  // it a header comment and assert what comes back. A test that only re-ran the
  // generator over the current tree would pass with the bug still present,
  // because the generator produced the truncated text (AGENTS.md §6).
  const fixturePath = args[descriptionFixtureIndex + 1];
  if (!fixturePath) throw new Error('--description-fixture requires a JSON file');
  const fixture = JSON.parse(readFileSync(resolve(fixturePath), 'utf8'));
  const description = firstDescription(
    fixture.source,
    fixture.fallback ?? 'src/tools/fixture.ts',
    new Intl.Segmenter('en', { granularity: 'sentence' }),
  );
  console.log(JSON.stringify({ description }));
  process.exit(0);
}
/**
 * Drives `readCookbookRecipes` against a supplied cookbook source (#1288), so
 * the recipe-count measurement can be shown to reject a gapped or repeated set
 * of recipe headings.
 *
 * The counting logic being correct in isolation proves nothing if nothing ever
 * asks it to fail. This is the same fixture-route shape as
 * `--description-fixture` above, and it exists for the same reason: the real
 * `--check` reads the repository's own `docs/cookbook.md`, which is correct, so
 * the only way to observe the negative case is to hand the function a document
 * that is wrong.
 */
const cookbookFixtureIndex = args.indexOf('--cookbook-fixture');
if (cookbookFixtureIndex >= 0) {
  if (!args[cookbookFixtureIndex + 1]) throw new Error('--cookbook-fixture requires a JSON file');
  const fixture = JSON.parse(readFileSync(resolve(args[cookbookFixtureIndex + 1]), 'utf8'));
  const measured = readCookbookRecipes(fixture.source);
  console.log(JSON.stringify({ count: measured.count, ordinals: measured.ordinals, errors: measured.errors }));
  process.exit(measured.errors.length > 0 ? 1 : 0);
}
const markerTreeFixtureIndex = args.indexOf('--marker-tree-fixture');
if (markerTreeFixtureIndex >= 0) {
  const fixturePath = args[markerTreeFixtureIndex + 1];
  if (!fixturePath) throw new Error('--marker-tree-fixture requires a JSON file');
  const fixture = JSON.parse(readFileSync(resolve(fixturePath), 'utf8'));
  const report = markerTreeReport(fixture.markers ?? [], fixture.blocks ?? []);
  console.log(JSON.stringify({ errors: report.errors, markerCount: report.markerCount, claimedCount: report.claimedCount, files: report.files }));
  process.exit(report.errors.length > 0 ? 1 : 0);
}

/**
 * The hand-maintained prose pin (#1384).
 *
 * It lives beside the checker rather than inside a generated block on purpose.
 * `scripts/doc-prose-manifest.json` is the file `--prose-sync` owns and
 * `--write` must never touch; see `scripts/prose-manifest.mjs` for why a
 * generated pin would have been defeated by the documented recovery for a
 * conflicted document.
 */
const PROSE_MANIFEST = proseManifestPath();

function proseManifestPath() {
  // `--prose-manifest <path>` exists so a test can drive the gate over a copy
  // of the pin instead of the real one. That is not a convenience: `--prose-sync`
  // *writes* this file, so a test that pointed it at the repository's own
  // manifest would rewrite a checked-in artifact — and would rewrite it
  // precisely when the gate is broken and the write is not refused, which is
  // the one moment the pin must not move. The same reason `--census-file` exists.
  const index = args.indexOf('--prose-manifest');
  if (index < 0) return join(ROOT, 'scripts', 'doc-prose-manifest.json');
  if (!args[index + 1]) throw new Error('--prose-manifest requires a JSON file');
  return resolve(args[index + 1]);
}

/** The `--retire "<reason>"` argument, or undefined when the flag is absent. */
function proseRetireReason() {
  const index = args.indexOf('--retire');
  if (index < 0) return undefined;
  const reason = args[index + 1];
  // A value starting with `-` is the next flag, not a reason — which is what
  // `--retire --prose-manifest x` hands over, and a shell that ate the quotes
  // hands over `undefined`. Both used to be accepted, and a retirement record
  // with no reason is the one artefact the whole mechanism exists to prevent.
  if (!reason || reason.startsWith('-')) {
    throw new Error(
      '--retire requires a reason, e.g. --retire "removed the stale batch-receipt paragraph". '
      + 'A retirement without one is indistinguishable from prose quietly disappearing.',
    );
  }
  return reason;
}

/**
 * The `--allow-stale "<why>"` argument, or undefined when the flag is absent (#1440).
 *
 * Same validation as `--retire` for the same reason: a flag that is easy to pass
 * with an empty value is a flag that gets passed with one. The difference is
 * what it is allowed to unlock — `proseSyncRefusals` splits its refusals into
 * hard and soft, and this only reaches the soft ones.
 */
function proseAllowStale() {
  const index = args.indexOf('--allow-stale');
  if (index < 0) return undefined;
  const why = args[index + 1];
  if (!why || why.startsWith('-')) {
    throw new Error(
      '--allow-stale requires a reason, e.g. --allow-stale "docs PR #1402 landed after this branch started; '
      + 'these paragraphs are gone from the merged result too".\n'
      + 'The reason is written into the manifest\'s provenance block. An acknowledgement with no reason is '
      + 'indistinguishable from having not looked.',
    );
  }
  return why;
}

/**
 * Provenance of the tree the pin is being written from, or read against (#1440).
 *
 * `--prose-provenance <file>` substitutes a captured reading, for the same
 * reason `--census-file` exists: `gitProvenanceIn` shells out, and a test that
 * wants to observe the *refusal* — the branch of the code that only runs when
 * the tree is behind or dirty — cannot arrange a real repository to be behind
 * without moving the real `origin/main`. The substitute has to reach the real
 * decision code, not a test-only copy of it, or the test proves the wrong
 * function refuses.
 */
function provenanceUnderTest(docFiles) {
  const index = args.indexOf('--prose-provenance');
  if (index >= 0) {
    if (!args[index + 1]) throw new Error('--prose-provenance requires a JSON file');
    return JSON.parse(readFileSync(resolve(args[index + 1]), 'utf8'));
  }
  return gitProvenanceIn(ROOT, {
    docFiles,
    manifestPath: relative(ROOT, PROSE_MANIFEST),
  });
}

/**
 * Is `sha` provably an ancestor of `HEAD`? `null` when git cannot tell.
 *
 * The null is load-bearing, and it is wider than it first looks.
 * `git merge-base --is-ancestor` exits 0 for "yes", 1 for "no", and 128 for "no
 * such object" — and this repository's CI checks out with `fetch-depth: 1`, so
 * the obvious reading ("only 128 is uncertain") is wrong in exactly the case
 * that matters.
 *
 * **A shallow checkout whose `HEAD` is a graft point answers 1 for commits it
 * cannot see.** The walk stops at the shallow boundary and reports "not an
 * ancestor" rather than admitting it ran out of history, so exit 1 there means
 * "not provable", not "no". Verified against this repository's own CI shape: a
 * `fetch-depth: 1` checkout of `pull/<n>/merge` has the merge commit as a
 * shallow root, so `git rev-list --count HEAD` is 1, and a pin stamped on the
 * branch is a real ancestor of that merge commit in a full clone (exit 0) while
 * the same query in the shallow clone exits 1.
 *
 * Collapsing either 128 or a grafted-1 into "no" turns every shallow CI run
 * red, and a gate that is always red is a gate nobody reads. So: exit 0 is
 * "yes"; anything else is a yes/no only when this checkout can actually walk
 * the history, and `null` — unverifiable, not an error — when it cannot.
 */
function headContains(sha) {
  const result = spawnSync('git', ['-C', ROOT, 'merge-base', '--is-ancestor', sha, 'HEAD'], {
    encoding: 'utf8',
  });
  if (result.error) return null;
  if (result.status === 0) return true;
  if (result.status !== 1) return null;
  // Exit 1 is only a real "no" if the walk could have reached the answer. A
  // shallow repository whose HEAD is a graft point cannot, so a "no" from one
  // is the absence of evidence rather than evidence of absence.
  if (shallowHeadCannotWalk()) return null;
  return false;
}

/**
 * Is this checkout a shallow clone whose `HEAD` is a graft point — the state in
 * which an `--is-ancestor` walk is truncated at `HEAD` and cannot answer "no"?
 *
 * `git rev-parse --is-shallow-repository` alone is not enough: a shallow clone
 * that *has* fetched past the commit in question answers correctly. What breaks
 * the walk is `HEAD` itself sitting on the shallow boundary, so this asks
 * whether `HEAD` is listed in the shallow-boundary file.
 *
 * That file is read from the **common** git dir, not the per-worktree one: a
 * linked worktree's `--absolute-git-dir` is `.git/worktrees/<name>`, which has
 * no `shallow` file of its own, so reading it there would report every
 * worktree as a full clone and reintroduce the false "no" on exactly the
 * checkouts this repository is developed in.
 */
let shallowHeadCached;
function shallowHeadCannotWalk() {
  if (shallowHeadCached !== undefined) return shallowHeadCached;
  const commonDir = spawnSync('git', ['-C', ROOT, 'rev-parse', '--path-format=absolute', '--git-common-dir'], { encoding: 'utf8' });
  if (commonDir.error || commonDir.status !== 0) return (shallowHeadCached = false);
  let boundary;
  try {
    boundary = readFileSync(join(commonDir.stdout.trim(), 'shallow'), 'utf8');
  } catch {
    // No shallow-boundary file at all: a full clone, so a "no" is a real "no".
    return (shallowHeadCached = false);
  }
  const head = spawnSync('git', ['-C', ROOT, 'rev-parse', 'HEAD'], { encoding: 'utf8' });
  if (head.error || head.status !== 0) return (shallowHeadCached = false);
  const onBoundary = boundary.split('\n').some((line) => line.trim() === head.stdout.trim());
  return (shallowHeadCached = onBoundary);
}

function readProseManifest({ required = true } = {}) {
  try {
    return JSON.parse(readFileSync(PROSE_MANIFEST, 'utf8'));
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
    // `--prose-sync` is how the pin is created, so an absent file is the one
    // case where starting from nothing is the correct answer rather than a
    // hole: there is nothing pinned yet, so nothing can have gone missing.
    if (!required) return { files: {} };
    // Everywhere else, a missing pin is a gate that has never run, not a gate
    // that has nothing to say. Reporting "clean" would let the first `--check`
    // after a fresh clone pass on prose nobody has ever pinned.
    throw new Error(
      `${relative(ROOT, PROSE_MANIFEST)}: the prose-integrity pin is missing, so hand-written prose in mixed files is ungated.\n`
      + 'Recreate it with `npm run count:tools -- --prose-sync` and commit the result.',
    );
  }
}

function reportUnitCount(manifest) {
  return Object.values(manifest.files ?? {}).reduce((total, entries) => total + entries.length, 0);
}

/**
 * Extra roots merged into the marker tree scan, so a test can plant a marker
 * pair in a scratch directory and drive the *real* `--check` over it (#1238).
 *
 * This is the wiring proof. `--marker-tree-fixture` above can only show the
 * classifier is correct in isolation; nothing about it demonstrates that
 * `checkDocumentation` calls the classifier at all, which is the failure this
 * whole issue is about — a correct check that was never reached.
 */
const markerTreeExtraIndex = args.indexOf('--marker-tree-extra');
if (markerTreeExtraIndex >= 0 && !args[markerTreeExtraIndex + 1]) {
  throw new Error('--marker-tree-extra requires a directory');
}
const markerScanRoots = markerTreeExtraIndex >= 0
  ? [ROOT, resolve(args[markerTreeExtraIndex + 1])]
  : [ROOT];

/**
 * Serve one repository document from a different file on disk (#1384).
 *
 * The prose gate reads `ARCHITECTURE.md` from the working tree, which is
 * correct, so the only way to observe it reject anything is to hand it a
 * document that is actually wrong. `--marker-tree-extra` does the equivalent
 * job for marker structure by planting new files; prose loss is the opposite
 * shape — the file stays, its contents shrink — so this substitutes a
 * document's body instead. The format is `<repo-relative-path>=<file>`, and
 * the gate still runs the real comparison against the real manifest, which is
 * the wiring proof that `checkDocumentation` reaches it at all.
 */
const proseOverrideIndex = args.indexOf('--prose-override');
if (proseOverrideIndex >= 0 && !args[proseOverrideIndex + 1]) {
  throw new Error('--prose-override requires <repo-path>=<file>');
}
const proseOverrides = new Map();
if (proseOverrideIndex >= 0) {
  const [target, from] = args[proseOverrideIndex + 1].split('=');
  if (!target || !from) throw new Error('--prose-override requires <repo-path>=<file>');
  proseOverrides.set(normalizeRepoPath(target), resolve(from));
}

/**
 * Every repository document that mixes hand-written prose with generated
 * blocks, as a `{ path: source }` map (#1384).
 *
 * Derived by walking the tree for generated blocks rather than by reading a
 * hand-listed array of files, for the reason #1238 established: a file on a
 * list is a file somebody remembered, and a file nobody remembered is exactly
 * the one whose prose can be lost with nothing noticing. Only Markdown is in
 * scope — `src/toolsets.ts` carries a `// BEGIN:generated` block, but pinning
 * source code as though it were documentation is not the same hazard and would
 * make the pin unkeepable.
 *
 * ## The exclusion above is not an ungated block (#1438)
 *
 * This `.md` filter was read, correctly from the prose half and incorrectly
 * from the staleness half, as meaning `src/toolsets.ts` has no gate on it. It
 * does not, and the two halves are separate mechanisms:
 *
 *  - **This one** reconciles `scripts/doc-prose-manifest.json` against the
 *    documents. It answers "was hand-written prose lost to a whole-file
 *    conflict resolution", and `src/toolsets.ts` is a source module, so
 *    pinning it would be unkeepable — the exact wording above, and still true.
 *  - **Staleness** is `checkDocumentation()`'s per-block loop over the `blocks`
 *    array, which is extension-agnostic. `src/toolsets.ts` is a `blocks` entry,
 *    so a figure in it that falls out of step with the registry is reported as
 *    `src/toolsets.ts: generated surface-census block is stale`, on a plain
 *    `--check` and in CI.
 *
 * The exclusion is enumerated and asserted rather than left implicit:
 * `EXPECTED_FILES` in `tests/doc-prose-integrity.test.ts` pins this list, and
 * `EXPECTED_FILES` in `tests/generated-block-tree-guard.test.ts` pins
 * `src/toolsets.ts` as a claimed generated block. A second file joining either
 * side without a decision goes red on both tests instead of passing by default.
 */
function proseDocuments(roots = markerScanRoots) {
  const files = [...new Set(scanGeneratedMarkers(roots)
    .filter((marker) => marker.file.endsWith('.md'))
    .map((marker) => marker.file))]
    .sort();
  const documents = {};
  for (const file of files) {
    // `markerPathLabel` returns a repository-relative path for files inside the
    // tree and the *absolute* path for anything outside it — which is how a
    // `--marker-tree-extra` scratch directory ends up in the scan at all.
    // `resolve` resets on an absolute segment where `join` would concatenate,
    // so it is the only one of the two that reads both correctly.
    documents[file] = readFileSync(resolve(ROOT, file), 'utf8');
  }
  return documents;
}

/**
 * The same documents, with any `--prose-override` substitutions applied.
 *
 * One function for all three callers, because the override has to mean the
 * same thing to `--check`, `--prose-report` and `--prose-sync`. A hook that
 * only the gate honours would let a test prove the gate rejects a truncated
 * document while the command that rewrites the pin went on reading the intact
 * one — which is precisely the pairing that has to agree for this gate to be
 * worth anything.
 */
function proseDocumentsUnderTest() {
  const documents = proseDocuments();
  for (const [file, from] of proseOverrides) documents[file] = readFileSync(from, 'utf8');
  return documents;
}

/**
 * Print the prose-integrity verdict without writing anything (#1384).
 *
 * Exists for the same reason as `--marker-tree-report`: a test that only
 * asserted "the gate passed" would pass just as happily against a comparison
 * that read no documents at all. The unit count and the file list are what
 * make "covered the repository" distinguishable from "found nothing", and a
 * scan that quietly stopped covering a file loses an entry here and goes red.
 */
const proseReportIndex = args.indexOf('--prose-report');
if (proseReportIndex >= 0) {
  const documents = proseDocumentsUnderTest();
  const manifest = readProseManifest();
  const report = proseDrift(manifest, documents);
  const provenance = proseProvenanceVerdict(manifest, { ancestor: headContains });
  console.log(JSON.stringify({
    errors: report.errors,
    currentCount: report.currentCount,
    pinnedCount: report.pinnedCount,
    files: report.files,
    // Which tree the pin was generated from, and whether this checkout can
    // still confirm it. A reader who is told "verified" can trust the pin; one
    // told "unverifiable" knows the answer was not produced rather than found.
    provenance: {
      ...(manifest.provenance ?? {}),
      status: provenance.status,
      detail: provenance.detail,
    },
  }, null, 2));
  process.exit(report.errors.length > 0 || provenance.error ? 1 : 0);
}

/**
 * Rebuild the prose manifest, refusing to drop anything that disappeared
 * unless the run says why (#1384).
 *
 * This is the only thing in the repository that rewrites the pin, and it is
 * deliberately not reachable from `--write`. A generated pin would have been
 * refreshed by the documented recovery for a conflicted file, so the gate
 * would have gone green one command after the prose was lost.
 */
if (args.includes('--prose-sync')) {
  const documents = proseDocumentsUnderTest();
  // `retire` and `reason` are the same string by construction here, and both are
  // forwarded: `retire` is the mode flag and `reason` is what lands in the
  // manifest. Passing only the flag produced retirement records with no reason
  // on them, which is the one field the record exists to carry.
  const reason = proseRetireReason();
  const allowStale = proseAllowStale();
  const previous = readProseManifest({ required: false });

  // Computed before the provenance decision, not after it, and the ordering is
  // load-bearing. `syncProseManifest` is pure — it returns the manifest it would
  // have written and writes nothing — so running it first costs nothing, and it
  // is the only way the refusal below can name the paragraphs the author was
  // about to retire. A refusal that says "this tree cannot be attested" and
  // stops there tells the reader nothing about what was at stake, and the path
  // of least resistance from there is `--allow-stale` without reading anything.
  const result = syncProseManifest(previous, documents, {
    retire: reason,
    reason,
    date: new Date().toISOString().slice(0, 10),
  });

  // #1440: refuse before the pin is rewritten, not after. A manifest that has
  // already been written with a false reason is worse than one that was not
  // written at all, because the false reason is then indistinguishable from a
  // true one to everyone downstream.
  const provenance = provenanceUnderTest(Object.keys(documents));
  const refusals = proseSyncRefusals(provenance, { allowStale });
  if (refusals.hard.length > 0 || refusals.soft.length > 0) {
    // Evidence, not a second gate. A retirement reason is a claim about *why* a
    // paragraph left; when that claim is "upstream reworded it" and the paragraph
    // is still sitting unchanged in the file on the branch this merges into, the
    // claim cannot be true — the change it names is not in this tree yet. That is
    // #1439 exactly, and it is worth showing the author which of their pending
    // retirements are contradicted rather than letting them pass `--allow-stale`
    // over all of them. Matched by content hash, so a genuine partial reword
    // upstream — same opening, new tail — is not flagged.
    const contradicted = provenance.upstream
      ? contradictedByUpstream(
        result.dropped,
        readFilesAtRef(ROOT, provenance.upstream, [...new Set(result.dropped.map((entry) => entry.file))]),
      )
      : [];
    console.error(
      `Refusing to rewrite the prose manifest: this tree cannot be attested (#1440).\n\n`
      + [...refusals.hard, ...refusals.soft].map((line) => `${line}\n`).join('\n')
      + (result.dropped.length > 0
        ? `\nThis run would have retired ${result.dropped.length} pinned prose block(s):\n`
          + result.dropped.map((entry) => `- ${entry.file}: "${entry.label}"`).join('\n')
          + '\nThey are still pinned, and still in the gate. Resolve the tree question first, then re-run.\n'
        : '')
      + (contradicted.length > 0
        ? `\nAnd ${contradicted.length} of them are still present in their file at ${short(provenance.upstream)}:\n`
          + contradicted.map((entry) => `- ${entry.file}: "${entry.label}"`).join('\n')
          + '\nA retirement whose reason is about something *else* — a reword upstream, a conflict resolved on\n'
          + 'another branch — cannot be true of a paragraph that is sitting in the branch you are merging into.\n'
          + 'Merge or rebase, then re-run; if the paragraph really is gone once you have, `--allow-stale` is\n'
          + 'not what you want, `--retire "<the real reason>"` is.\n'
        : ''),
    );
    process.exit(1);
  }

  if (result.refused) {
    console.error(
      `Refusing to rewrite the prose manifest: ${result.dropped.length} pinned prose block(s) are no longer in their file.\n`
      + result.dropped.map((entry) => `- ${entry.file}: "${entry.label}"`).join('\n')
      + '\n\nA reword or a deliberate deletion is legitimate — re-run with --retire "<reason>" to record it.'
      + '\nProse that vanished because a conflict in a mixed file was resolved with --ours or --theirs is not:'
      + ' the generator only owns the text between the markers and cannot restore it.'
      + '\nRecover the prose by hand from the side you dropped (`git show <ref>:ARCHITECTURE.md`),'
      + ' and only then re-run `npm run count:tools -- --write` — `--write` repairs generated blocks'
      + ' and exits 1 for as long as a pinned paragraph is missing.'
      + '\n`npm run count:tools -- --prose-report` names the paragraphs that are gone without writing anything.',
    );
    process.exit(1);
  }
  // Stamped last, from the same reading that was just accepted, so the recorded
  // tree and the recorded pins cannot disagree. `allowStale` is carried in the
  // block rather than in the retirement reason, because it qualifies the tree
  // and not the prose: a reviewer asking "why might this reason be wrong" looks
  // at the retirement, and this is what answers it.
  const stamped = stampProvenance(result.manifest, {
    head: provenance.head,
    upstream: provenance.upstream,
    behind: Boolean(provenance.behind),
  });
  if (allowStale) stamped.provenance.allowStale = allowStale;
  writeFileSync(PROSE_MANIFEST, `${JSON.stringify(stamped, null, 2)}\n`);
  console.error(
    `Wrote ${PROSE_MANIFEST}: ${Object.keys(stamped.files).length} file(s), `
    + `${reportUnitCount(stamped)} pinned unit(s)`
    + (result.retired.length > 0 ? `, ${result.retired.length} retired with a recorded reason` : '')
    + (allowStale ? `, synced from a tree behind origin/main (acknowledged: ${allowStale})` : ''),
  );
  process.exit(0);
}
const censusFileIndex = args.indexOf('--census-file');
if (censusFileIndex >= 0 && !args[censusFileIndex + 1]) {
  throw new Error('--census-file requires a JSON file');
}

/**
 * `--no-prose` scopes `--check` to the generated blocks (#1436).
 *
 * `checkDocumentation()` reconciles two different things, and a caller only
 * sometimes wants both. The generated blocks are the census's own output and
 * are stale the moment the registry moves. The prose reconciliation is a
 * comparison against `scripts/doc-prose-manifest.json` — a hand-maintained
 * documentation artifact, written by `--prose-sync` and owned by
 * `tests/doc-prose-integrity.test.ts`.
 *
 * A test asserting the *architecture* (which modules register, which keys
 * exist, that the module map is current) went red while that manifest was
 * mid-edit, and the reflex on a red you cannot explain is to re-run it or relax
 * it — so the coupling is worth removing rather than documenting. The test's
 * input set should be no wider than the thing it checks.
 *
 * Declared here, beside the other `args` reads, for the same reason the marker
 * sets are module-scope: `checkDocumentation()` runs at import time and reaches
 * this through the call at the bottom of the file. `--check` without this flag
 * is byte-for-byte what it was before.
 */
const checkProse = !args.includes('--no-prose');

const { GATED_FAMILIES, GATED_PATH_PATTERNS, isGatedPath } = await import('../src/gating.ts');
/**
 * Extra directories whose `.ts` files join the gated-endpoint scan (#1278).
 *
 * This is the wiring proof for the per-tool attribution. Driving the real
 * `--check` over a scratch tree lets a test plant a tool that calls a gated
 * endpoint without declaring the family — or a file that provably cannot
 * violate anything — and observe the verdict the production gate would give.
 * A test that only asserted "`--check` passed" would pass just as happily
 * against a scan that attributes nothing (AGENTS.md §6).
 *
 * Files here contribute call sites only. The registration-coverage identity
 * below deliberately reads the real `src/tools` tree, so a planted fixture can
 * never make the production coverage count look complete.
 */
const gatedScanExtraIndex = args.indexOf('--gated-scan-extra');
if (gatedScanExtraIndex >= 0 && !args[gatedScanExtraIndex + 1]) {
  throw new Error('--gated-scan-extra requires a directory');
}
const gatedScanExtraRoots = gatedScanExtraIndex >= 0
  ? [resolve(args[gatedScanExtraIndex + 1])]
  : [];
const gatedCallsIndex = args.indexOf('--gated-calls');
if (gatedCallsIndex >= 0) {
  console.log(JSON.stringify({ hits: gatedCallSites() }, null, 2));
  process.exit(0);
}
const census = censusFileIndex >= 0
  ? JSON.parse(readFileSync(resolve(args[censusFileIndex + 1]), 'utf8'))
  : await readProductionRegistry();
/**
 * The DEFAULT surface, measured rather than derived (#889).
 *
 * Since #889 an unset `SPOTIFY_MCP_TOOLSETS` no longer means "everything", so
 * every generated sentence that called the full surface "the default" became a
 * claim about a surface no session actually gets. The fix is a second real
 * handshake with the key DELETED, not arithmetic over the full list: filtering
 * the 581 measured names by the default sets would be a second, weaker
 * implementation of the gate that `src/index.ts` owns, and it would report
 * whatever that filter says even if the server disagreed.
 *
 * The bytes figure is the same projection `assertAggregateSurfaceBudget`
 * budgets — name, title, description, inputSchema, annotations, execution and
 * _meta — so "the default costs a host N bytes" means the same thing here as
 * it does at the startup gate.
 */
const defaultSurface = await readProductionRegistry({ SPOTIFY_MCP_TOOLSETS: undefined });
const defaultSurfaceBytes = Buffer.byteLength(
  JSON.stringify(defaultSurface.toolDefinitions.map((tool) => ({
    name: tool.name,
    title: tool.title,
    description: tool.description,
    inputSchema: tool.inputSchema,
    annotations: tool.annotations,
    execution: tool.execution,
    _meta: tool._meta,
  }))),
  'utf8',
);
const { namesByModule: moduleNames, manifestToolNames, schemaMeasurements, aggregateSurface } = await attributeToolsToModules(census.toolNames, census.toolDefinitions);
const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));

const perModule = countModuleTools(moduleNames);
const toolModuleFiles = Object.keys(perModule).filter((file) => file.startsWith('src/tools/')).length;
const manifestRegistrationKeys = [...new Set(productionManifest.map(({ key }) => key))].sort();
const toolsetRegistrationKeys = [...new Set(allRegistrationKeysFromSource())].sort();
// Ungated keys come from the manifest's own alwaysActive flag, not a hand-kept
// list: `doctor` and `swarm3meta` are both alwaysActive, and a hard-coded
// array silently stops covering the second one when the manifest changes.
const unconditionalRegistrationKeys = [...new Set(productionManifest.filter((module) => module.ungated === true).map((module) => module.key))].sort();
const registrationKeyNames = [...new Set([...manifestRegistrationKeys, ...toolsetRegistrationKeys, ...unconditionalRegistrationKeys])].sort();
const schemaBudgets = REGISTRAR_MANIFEST.map((module) => ({
  module: module.key,
  registrationKey: module.registrationKey,
  file: normalizeRepoPath(module.file),
  baselineToolCount: module.baseline.toolCount,
  baselineSchemaBytes: module.baseline.schemaBytes,
  maxToolCount: module.ceiling.toolCount,
  maxSchemaBytes: module.ceiling.schemaBytes,
}));
/**
 * The cookbook's recipe count (#1288).
 *
 * `README.md` and `docs/cookbook.md` both used to say "eleven" in prose. That
 * is the #1241/#1247 class: a figure nothing holds in place. Adding recipe 12 —
 * an ordinary thing to do — left both files saying eleven and nothing failed.
 *
 * Counted off the recipes themselves rather than typed anywhere: the numbered
 * `## N. ` headings in `docs/cookbook.md` ARE the recipes, so the number of
 * headings is the number of recipes. The ordinals are checked as well as
 * counted, because a file whose headings read 1..11,13,14 still has thirteen
 * headings while its prose is describing a different set — a gap is the shape
 * this check has to see, and a count alone cannot.
 */
const cookbook = readCookbookRecipes();

function readCookbookRecipes(fixtureSource) {
  const source = fixtureSource ?? readFileSync(join(ROOT, 'docs', 'cookbook.md'), 'utf8');
  const ordinals = [...source.matchAll(/^## (\d+)\. /gm)].map((match) => Number(match[1]));
  const expected = Array.from({ length: ordinals.length }, (_, index) => index + 1);
  return {
    count: ordinals.length,
    ordinals,
    // A gap, a repeat, or a zero. Reported by name so a failure says which way
    // the headings are wrong rather than just that they are.
    errors: ordinals.length === 0
      ? ['docs/cookbook.md: no numbered `## N. ` recipe headings were found, so the recipe count would be 0']
      : JSON.stringify(ordinals) === JSON.stringify(expected)
        ? []
        : [`docs/cookbook.md: recipe headings are numbered ${ordinals.join(', ')}; expected 1-${ordinals.length} with no gaps or repeats`],
  };
}

/**
 * The aggregate surface figures (#1241).
 *
 * `maxCeilingBytes` and `maxEnforcedBytes` are read straight off the two
 * exported code constants, not retyped here: a second copy of 620_000 in this
 * script would be the same drift the issue is about, one file over. The
 * measurement is `collectAggregateSurfaceMeasurement` — the exact call
 * `assertAggregateSurfaceBudget` gates on in `src/index.ts` — applied to this
 * census's own fully-registered server after the same finalizers run.
 *
 * It is deliberately NOT `Buffer.byteLength(JSON.stringify(census.toolDefinitions))`.
 * Re-serializing the census payload is a reconstruction: it has been measured
 * ~1.9KB away from the gated number, and not consistently in one direction, so
 * a doc figure derived that way would be a number nobody ever enforced.
 */
const perModuleSchemaBytesTotal = schemaMeasurements.reduce((total, row) => total + row.schemaBytes, 0);
const aggregateSurfaceFacts = Object.freeze({
  maxTools: AGGREGATE_SURFACE_LIMITS.maxTools,
  maxCeilingBytes: TOOL_SURFACE_BUDGET.defaultMaxBytes,
  maxEnforcedBytes: AGGREGATE_SURFACE_LIMITS.maxBytes,
  annotationAllowanceBytes: AGGREGATE_SURFACE_LIMITS.maxBytes - TOOL_SURFACE_BUDGET.defaultMaxBytes,
  measuredToolCount: aggregateSurface.toolCount,
  measuredBytes: aggregateSurface.schemaBytes,
  headroomBytes: AGGREGATE_SURFACE_LIMITS.maxBytes - aggregateSurface.schemaBytes,
  headroomPercent: ((AGGREGATE_SURFACE_LIMITS.maxBytes - aggregateSurface.schemaBytes) / AGGREGATE_SURFACE_LIMITS.maxBytes) * 100,
  verdict: aggregateSurfaceVerdict(AGGREGATE_SURFACE_LIMITS.maxBytes - aggregateSurface.schemaBytes, AGGREGATE_SURFACE_LIMITS.maxBytes),
  // The per-call response cap (#895) and the ratio that justifies it. Both are
  // generated so the page cannot drift from the constant: a cap raised in
  // `src/shaping.ts` must move this table in the same commit, which is what
  // `tests/doc-figures.test.ts` enforces by forbidding the figure in prose.
  responseCapBytes: MAX_RESPONSE_BYTES,
  responseCapRatio: MAX_RESPONSE_BYTES / TOOL_SURFACE_BUDGET.defaultMaxBytes,
  responseCapCallsForParity: Math.round(TOOL_SURFACE_BUDGET.defaultMaxBytes / MAX_RESPONSE_BYTES),
  // The share of the budgeted payload the per-module table cannot see: tool
  // names, titles, annotations and boundary metadata. The page used to assert
  // "roughly 11.5%" in prose; that is a live ratio, so it is measured here.
  perModuleSchemaBytesTotal,
  metadataOverheadBytes: aggregateSurface.schemaBytes - perModuleSchemaBytesTotal,
  metadataOverheadPercent: ((aggregateSurface.schemaBytes - perModuleSchemaBytesTotal) / aggregateSurface.schemaBytes) * 100,
});
/**
 * The opt-in surface, measured (#695) — registered twice, diffed.
 *
 * Hoisted to module scope because the gated scan needs it too: eleven tools are
 * written literally in their module and registered only under the flag, so a
 * static scan of `src/tools` finds a `server.tool('x', …)` the default
 * `tools/list` this script reads never served. The measurement is the
 * authority for "that registration is real, it is conditional", computed once
 * so the emitted census and the gate cannot disagree.
 */
const measuredGatedToolNames = await measureGatedToolNames();
const result = {
  tools: census.toolNames.length,
  // #889: the curated surface a server registers with no env set. Reported
  // beside the full-surface `tools` figure so neither can be read as the other.
  defaultTools: defaultSurface.toolNames.length,
  defaultBytes: defaultSurfaceBytes,
  defaultToolNames: defaultSurface.toolNames,
  toolModuleFiles,
  registrationKeys: registrationKeyNames.length,
  resources: census.resourceUris.length,
  resourceTemplates: census.resourceTemplateUris.length,
  prompts: census.promptNames.length,
  toolNames: census.toolNames,
  manifestToolNames,
  // Measured, never declared (#695). The default surface is what every table
  // above reports, so the opt-in's eleven names have to be derived by
  // registering both ways; see `measureGatedToolNames`.
  gatedToolNames: measuredGatedToolNames,
  parameterNames: census.parameterNames,
  toolInputSchemas: census.toolInputSchemas,
  toolDefinitions: census.toolDefinitions,
  resourceUris: census.resourceUris,
  resourceTemplateUris: census.resourceTemplateUris,
  promptNames: census.promptNames,
  registrationKeyNames,
  manifestRegistrationKeys,
  toolsetRegistrationKeys,
  unconditionalRegistrationKeys,
  registrationUnits: productionManifest,
  perModule,
  perModuleSchemaBytes: Object.fromEntries(schemaMeasurements.map((row) => [row.module, row.schemaBytes])),
  schemaMeasurements,
  schemaBudgets,
  toolsetNames: toolsetNamesFromSource(),
  aggregateSurface: aggregateSurfaceFacts,
  // The cookbook's recipe count (#1288), read off its own `## N. ` headings.
  // Carried in the JSON so the guard can compare the rendered block against a
  // measurement rather than against a number typed into the test.
  cookbookRecipes: { count: cookbook.count, ordinals: cookbook.ordinals },
  registrySource: 'src/index.ts via stdio tools/list after production finalizers',
};

const architecture = moduleInventory(result);
const packageExcerpt = JSON.stringify({
  type: pkg.type,
  engines: pkg.engines,
  dependencies: pkg.dependencies,
  devDependencies: pkg.devDependencies,
  scripts: pkg.scripts,
}, null, 2);
const shortSurface = `A server started with no \`SPOTIFY_MCP_TOOLSETS\` registers **${result.defaultTools} tools** (${result.defaultBytes.toLocaleString('en-US')} bytes of schema) — the curated default surface (#889). \`SPOTIFY_MCP_TOOLSETS=all\` registers all **${result.tools} tools**, along with **${result.resources} fixed resources**, **${result.resourceTemplates} resource templates**, and **${result.prompts} prompts**. Toolsets and production gates can trim a configured host further; both figures describe a real production \`tools/list\` after finalizers.`;
/**
 * #1241 did NOT generate the README's 2.0-upgrade tool count, and the reason
 * is worth keeping: the sentence lives inside a numbered list item, and a
 * generated block's end marker always renders at column 0. That terminates the
 * list item — verified with a CommonMark renderer, which emits `</ol>` before
 * the closing comment and restarts the list. The count was therefore removed
 * from the prose and replaced with a pointer at the generated `surface-census`
 * block a few hundred lines up. Retyping 591 -> 592 would have been the same
 * bug with a smaller number; generating it there would have broken the README.
 */

/**
 * The cookbook's recipe count, rendered for `docs/cookbook.md` (#1288).
 *
 * The block lives in the cookbook rather than the README because of the
 * list-marker constraint recorded above: README's "eleven copy-paste agent
 * recipes" sits in a bullet-list item, and a generated block's end marker
 * renders at column 0 and terminates that list. So the README carries no count
 * at all — a figure-free list item cannot drift — and the count that used to be
 * hand-typed in both files now has exactly one home, next to the recipes it
 * counts.
 *
 * The whole introductory sentence is generated, not just the figure, because a
 * generated block replaces its body wholesale: leaving the rest of the
 * paragraph in hand-written prose would have `--write` delete it. "Recipe 1" is
 * safe to state here — the ordinal check above refuses a cookbook whose
 * headings are not 1..N, so recipe 1 always exists and is always the first.
 */
const cookbookIntro = `**${cookbook.count}** recipes you can paste to an agent (or run turn by turn) against SpotifyMCP. Each states the tools it uses and what you get. Recipe 1 is the flagship: stats.fm taste in, Spotify playlist out.`;

/**
 * The 3.0 headline, rendered for `docs/v3-roadmap.md`.
 *
 * A "what's coming" page is exactly where a hand-typed figure rots, because
 * the default surface moves with almost every registry change and the page
 * would go stale without anybody noticing until a reader counted the tools
 * themselves. So the figures are measured here, in the same run that measures
 * everything else, and the block is regenerated on any registry change.
 *
 * The gap between the two tool counts is a subtraction of two figures measured
 * in this same run — not a figure reconstructed from anywhere else, which is
 * the distinction that matters when a number is published as fact.
 */
const v3Headline = `Measured on this branch, just now: a default 3.0 session puts **${result.defaultTools} tools** in front of the model — ${result.defaultBytes.toLocaleString('en-US')} bytes of schema — drawn from **${result.tools}** this server knows how to register. The other ${result.tools - result.defaultTools} are one environment variable away, waiting behind \`SPOTIFY_MCP_TOOLSETS\` alongside **${result.resourceTemplates}** resource templates and **${result.prompts}** prompts.`;

const blocks = [
  ['README.md', 'surface-census', shortSurface],
  ['README.md', 'gated-endpoints', gatedEndpointTable()],
  ['ARCHITECTURE.md', 'surface-census', `${shortSurface} The tool surface is attributed to ${result.toolModuleFiles} files under \`src/tools/\`.`],
  ['ARCHITECTURE.md', 'module-map', architecture],
  ['SPEC.md', 'package-contract', ['```json', packageExcerpt, '```'].join('\n')],
  ['SPEC.md', 'tool-surface', toolSurface(result)],
  ['SPEC.md', 'resource-surface', resourceSurface(result)],
  ['SPEC.md', 'prompt-surface', promptSurface(result)],
  ['docs/schema-budgets.md', 'schema-budget-table', schemaBudgetTable(result)],
  ['docs/schema-budgets.md', 'aggregate-budget', aggregateBudgetBlock(result)],
  ['docs/schema-budgets.md', 'response-cap', responseCapBlock(result)],
  ['docs/wave2-composites.md', 'surface-census', wave2Surface(result)],
  ['docs/distribution.md', 'surface-census', distributionSurface(result)],
  ['docs/cookbook.md', 'recipe-index', cookbookIntro],
  ['docs/v3-roadmap.md', 'v3-headline', v3Headline],
  ['skills/spotify-exhaustive-feature-sweep/SKILL.md', 'surface-census', skillSurface(result)],
  ['skills/spotify-mcp-competitor-comparison/SKILL.md', 'surface-census', skillSurface(result)],
  ['src/toolsets.ts', 'surface-census', [
    '// Production surface (generated; run `npm run count:tools -- --write` after registry changes):',
    `// ${result.tools} tools, ${result.resources} fixed resources, ${result.resourceTemplates} resource templates, and ${result.prompts} prompts.`,
  ].join('\n')],
];
// AGENTS.md §3 used to hand-type a copy of this inventory, which is how it
// came to say 13 while the array held 14 and to omit a block entirely (#1231).
// The list is now one of the generated blocks, so it cannot drift from `blocks`.
// It excludes its own entry: a list that claimed to contain itself would
// describe 15 blocks when 14 sit outside it.
blocks.push(['AGENTS.md', 'generated-blocks', generatedBlockList(blocks)]);

const markerTreeReportIndex = args.indexOf('--marker-tree-report');
if (markerTreeReportIndex >= 0) {
  // Reconciles the real tree against the real `blocks` array and prints the
  // verdict, writing nothing.
  //
  // This exists for observability. A non-vacuity test that only asserted
  // "--check passed" would pass just as happily against a scan that found
  // nothing at all — and a scan that finds nothing is precisely the #1238
  // failure, because a gate that inspects an empty set reports green forever
  // (AGENTS.md §6). Here the marker count is a concrete number a test can pin,
  // so a scan that silently stopped covering the repository goes red instead.
  const report = markerTreeReport(scanGeneratedMarkers(markerScanRoots), blocks);
  console.log(JSON.stringify({ errors: report.errors, markerCount: report.markerCount, claimedCount: report.claimedCount, files: report.files }, null, 2));
  process.exit(report.errors.length > 0 ? 1 : 0);
}

const drift = checkDocumentation(blocks);
if (args.includes('--write')) {
  for (const [file, name, body] of blocks) writeBlock(join(ROOT, file), name, body);
  const remainingDrift = checkDocumentation(blocks);
  if (remainingDrift.length > 0) {
    console.error(`Documentation remains out of sync after --write (default tools/list: ${result.tools}):\n${remainingDrift.map((line) => `- ${line}`).join('\n')}`);
    process.exitCode = 1;
  }
} else if (args.includes('--check') && drift.length > 0) {
  console.error(`Documentation drift from the finalized production registry (default tools/list: ${result.tools}):\n${drift.map((line) => `- ${line}`).join('\n')}`);
  console.error('Run `npm run count:tools -- --write` after reviewing registry changes.');
  process.exitCode = 1;
}

console.log(JSON.stringify(result, null, 2));
if (process.exitCode) process.exit(process.exitCode);

/**
 * One real stdio handshake against `src/index.ts`, returning exactly what a
 * host receives.
 *
 * `overrides` is applied AFTER {@link CENSUS_ENV} and an `undefined` value
 * DELETES the key rather than blanking it. That distinction is load-bearing:
 * `SPOTIFY_MCP_TOOLSETS` set-but-empty and unset are the same spec, but
 * `SPOTIFY_SCOPES` set-but-empty has been a hard startup error since #617, and
 * a helper that could only set values would have no way to express "the caller
 * did not configure this".
 */
async function readProductionRegistry(overrides = {}) {
  const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
  const { StdioClientTransport } = await import('@modelcontextprotocol/sdk/client/stdio.js');
  const tempDir = mkdtempSync(join(tmpdir(), 'spotify-mcp-census-'));
  const tokenFile = join(tempDir, 'tokens.json');
  writeFileSync(tokenFile, JSON.stringify({
    access_token: 'surface-census',
    refresh_token: 'surface-census',
    expires_at: Date.now() + 60 * 60 * 1000,
  }), { mode: 0o600 });
  const env = {
    PATH: process.env.PATH,
    HOME: tempDir,
    ...CENSUS_ENV,
    SPOTIFY_MCP_TOKEN_FILE: tokenFile,
  };
  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined) delete env[key];
    else env[key] = value;
  }
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ['--import', 'tsx/esm', 'src/index.ts'],
    cwd: ROOT,
    stderr: 'pipe',
    env,
  });
  const client = new Client({ name: 'surface-census-client', version: '0.0.0' });
  let stderr = '';
  transport.stderr?.on('data', (chunk) => { stderr += chunk.toString(); });
  try {
    await client.connect(transport);
    const [toolPage, resourcePage, templatePage, promptPage] = await Promise.all([
      client.listTools(),
      client.listResources(),
      client.listResourceTemplates(),
      client.listPrompts(),
    ]);
    return {
      toolNames: toolPage.tools.map(({ name }) => name).sort(),
      parameterNames: [...new Set(toolPage.tools.flatMap((tool) => Object.keys(tool.inputSchema?.properties ?? {})))].sort(),
      toolInputSchemas: Object.fromEntries(toolPage.tools.map(({ name, inputSchema }) => [name, inputSchema])),
      toolDefinitions: toolPage.tools,
      resourceUris: resourcePage.resources.map(({ uri }) => uri).sort(),
      resourceTemplateUris: templatePage.resourceTemplates.map(({ uriTemplate }) => uriTemplate).sort(),
      promptNames: promptPage.prompts.map(({ name }) => name).sort(),
    };
  } catch (error) {
    const detail = stderr.trim();
    throw new Error(`production tools/list failed: ${error instanceof Error ? error.message : error}${detail ? `\n${detail}` : ''}`);
  } finally {
    await client.close().catch(() => undefined);
    rmSync(tempDir, { recursive: true, force: true });
  }
}

/**
 * Attribute the finalized live names through the same shared manifest used by
 * src/index.ts. The direct registration pass also measures each module's
 * current tool count and schema bytes for the generated budget table.
 */
async function attributeToolsToModules(liveToolNames, finalizedTools) {
  const { McpServer } = await import('@modelcontextprotocol/sdk/server/mcp.js');
  const server = new McpServer({ name: 'module-census', version: '0.0.0' });
  const clientStub = {
    get: async () => null,
    post: async () => null,
    put: async () => null,
    delete: async () => null,
    getAllPages: async () => [],
    getRateLimitStatus: () => ({ lastThrottleAt: null, retryAfterSec: null, cooldownRemainingMs: 0 }),
  };
  const namesByModule = new Map(REGISTRAR_MANIFEST.map((module) => [normalizeRepoPath(module.file), []]));
  const attributed = new Map();

  try {
    // The census measures the whole default surface, so it loads every module
    // (#906). It asks for the resolved manifest explicitly rather than going
    // through `registerManifestModules`, which would gate on the census's own
    // context — this loop registers unconditionally to attribute every name.
    const censusContext = { readOnly: false, isModuleActive: () => true, scopeBlocked: () => false };
    const loaded = await loadManifestRegistrars(REGISTRAR_MANIFEST, censusContext);
    for (const module of loaded) {
      registerManifestModule(server, clientStub, module, censusContext);
      for (const name of moduleToolNames(server, module.key)) {
        const file = normalizeRepoPath(module.file);
        const owners = attributed.get(name) ?? [];
        owners.push(file);
        attributed.set(name, owners);
        namesByModule.get(file).push(name);
      }
    }

    const live = new Set(liveToolNames);
    const missing = liveToolNames.filter((name) => !attributed.has(name));
    const extra = [...attributed.keys()].filter((name) => !live.has(name)).sort();
    if (missing.length > 0) {
      throw new Error(`finalized tools/list contains ${missing.length} name(s) absent from the shared registrar manifest: ${missing.join(', ')}`);
    }
    if (extra.length > 0) {
      throw new Error(`shared registrar manifest owns ${extra.length} name(s) absent from finalized tools/list: ${extra.join(', ')}`);
    }
    const ambiguous = [...attributed].filter(([, owners]) => owners.length > 1);
    if (ambiguous.length > 0) {
      throw new Error(`finalized tool names have ambiguous module attribution: ${ambiguous.map(([name, owners]) => `${name} (${owners.join(', ')})`).join('; ')}`);
    }

    const finalizedByName = new Map(finalizedTools.map((tool) => [tool.name, tool]));
    const schemaMeasurements = REGISTRAR_MANIFEST.map((module) => {
      const names = namesByModule.get(normalizeRepoPath(module.file)) ?? [];
      const schemaBytes = names.reduce((total, name) => total + serializedFinalizedSchemaBytes(finalizedByName.get(name)), 0);
      return {
        module: module.key,
        registrationKey: module.registrationKey,
        file: normalizeRepoPath(module.file),
        status: 'active',
        toolCount: names.length,
        schemaBytes,
        withinBudget: names.length <= module.ceiling.toolCount && schemaBytes <= module.ceiling.schemaBytes,
      };
    });
    // The aggregate figures (#1241) must come from the same measurement
    // `assertAggregateSurfaceBudget` gates on, which is taken *after* the
    // naming-policy check and the annotation pass — not from the wire payload
    // the stdio read above returns. Run the same two steps `src/index.ts` runs
    // in the same order, then measure.
    const registeredNames = Object.keys(server._registeredTools ?? {});
    assertToolNamingPolicy(registeredNames);
    applyToolAnnotations(server);
    const aggregateSurface = collectAggregateSurfaceMeasurement(server);
    if (aggregateSurface.toolCount !== live.size) {
      throw new Error(`census server measured ${aggregateSurface.toolCount} tools but the finalized stdio registry reported ${live.size}`);
    }
    return { namesByModule, manifestToolNames: [...attributed.keys()].sort(), schemaMeasurements, aggregateSurface };
  } finally {
    await server.close().catch(() => undefined);
  }
}

/**
 * MEASURE which tool names the SPOTIFY_MCP_EXPERIMENTAL_ANALYTICS opt-in adds
 * (#695), rather than reading them off a list.
 *
 * The census deliberately blanks every SPOTIFY_* variable, so the surface it
 * reports — and every generated table built from it — is the DEFAULT one. That
 * is right for the budget baselines, and it means the eleven withheld tool names
 * appear nowhere in the census output. Two consumers need them anyway:
 * `tests/registry-pin.test.ts` and `scripts/check-doc-tool-names.mjs`, both of
 * which would otherwise have to carry a hand-typed copy of a list the source
 * already owns. A hand-typed copy is exactly the thing that goes stale: a
 * renamed tool would keep validating as a known name for a tool that no longer
 * exists.
 *
 * So the list is derived the only honest way — register everything twice, once
 * with the opt-in off and once with it on, and take the difference. The env
 * flip is restored in a `finally` because the census runs in-process and a
 * leaked `1` would silently resize every number printed after this.
 */
async function measureGatedToolNames() {
  const { McpServer } = await import('@modelcontextprotocol/sdk/server/mcp.js');
  const clientStub = {
    get: async () => null,
    post: async () => null,
    put: async () => null,
    delete: async () => null,
    getAllPages: async () => [],
    getRateLimitStatus: () => ({ lastThrottleAt: null, retryAfterSec: null, cooldownRemainingMs: 0 }),
  };
  const censusContext = { readOnly: false, isModuleActive: () => true, scopeBlocked: () => false };
  const namesFor = async () => {
    const server = new McpServer({ name: 'gated-census', version: '0.0.0' });
    try {
      for (const module of await loadManifestRegistrars(REGISTRAR_MANIFEST, censusContext)) {
        registerManifestModule(server, clientStub, module, censusContext);
      }
      return Object.keys(server._registeredTools ?? {});
    } finally {
      await server.close().catch(() => undefined);
    }
  };

  const prior = process.env.SPOTIFY_MCP_EXPERIMENTAL_ANALYTICS;
  let optedIn;
  let off;
  try {
    delete process.env.SPOTIFY_MCP_EXPERIMENTAL_ANALYTICS;
    off = new Set(await namesFor());
    process.env.SPOTIFY_MCP_EXPERIMENTAL_ANALYTICS = '1';
    optedIn = new Set(await namesFor());
  } finally {
    if (prior === undefined) delete process.env.SPOTIFY_MCP_EXPERIMENTAL_ANALYTICS;
    else process.env.SPOTIFY_MCP_EXPERIMENTAL_ANALYTICS = prior;
  }
  // Only names the opt-in ADDS are gated. A name missing from both passes is a
  // manifest bug and is reported by the attribution cross-check above, not
  // silently absorbed into this list.
  return [...optedIn].filter((name) => !off.has(name)).sort();
}

function serializedFinalizedSchemaBytes(tool) {
  if (!tool) return 0;
  return Buffer.byteLength(JSON.stringify({
    description: String(tool.description ?? ''),
    inputSchema: tool.inputSchema ?? {},
    // `outputSchema` was measured out of existence here for the same reason it
    // was out of the aggregate measurement (#1376): the field is on the
    // finalized wire tool, so excluding it reported a per-module byte count
    // that no host ever received. The `...(x ? {} : null)` form omits the key
    // entirely when there is no output schema, which is what `JSON.stringify`
    // does with `undefined` and what keeps a no-schema tool byte-identical to
    // its pre-#1376 measurement.
    ...(tool.outputSchema === undefined ? null : { outputSchema: tool.outputSchema }),
  }), 'utf8');
}

function normalizeRepoPath(file) {
  return file.split(sep).join('/');
}

function countModuleTools(namesByModule) {
  return Object.fromEntries([...namesByModule].map(([file, names]) => [file, names.length]));
}


function schemaBudgetTable(census) {
  const measured = new Map(census.schemaMeasurements.map((row) => [row.module, row]));
  const rows = census.schemaBudgets.map((budget) => {
    const live = measured.get(budget.module);
    return `| ${budget.module} | ${live?.toolCount ?? 0} | ${formatInteger(live?.schemaBytes ?? 0)} | ${budget.baselineToolCount} | ${formatInteger(budget.baselineSchemaBytes)} | ${budget.maxToolCount} | ${formatInteger(budget.maxSchemaBytes)} |`;
  });
  return [
    '| Module | Tools | Schema bytes | Baseline tools | Baseline bytes | Effective tool ceiling | Effective byte ceiling |',
    '|---|---:|---:|---:|---:|---:|---:|',
    ...rows,
  ].join('\n');
}

function formatInteger(value) {
  return String(value).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

/**
 * The budget's own verdict, derived from the measurement rather than asserted
 * in prose (#1241). The doc used to say "the budget is effectively exhausted"
 * from a hand-copied 285B figure that was stale by two orders of magnitude;
 * the honest version is a function of the headroom actually left, so the next
 * 10KB of surface moves the sentence by itself.
 */
function aggregateSurfaceVerdict(headroomBytes, maxBytes) {
  if (headroomBytes < 0) return 'over budget';
  const ratio = headroomBytes / maxBytes;
  if (ratio < 0.01) return 'effectively exhausted';
  if (ratio < 0.05) return 'tight';
  return 'within budget';
}

/**
 * The `docs/schema-budgets.md` aggregate block (#1241).
 *
 * Every figure here is read from code or measured — the ceiling and the
 * enforced limit are the exported constants, the payload is
 * `collectAggregateSurfaceMeasurement`, and the conclusion is a band over the
 * headroom ratio. Nothing in the surrounding prose quotes a number, because
 * prose is not gated and a quoted number is stale within one release.
 */
function aggregateBudgetBlock(census) {
  const facts = census.aggregateSurface;
  const rows = [
    `| \`TOOL_SURFACE_BUDGET.defaultMaxTools\` | ${formatInteger(facts.maxTools)} tools | code constant, \`src/tools/annotations.ts\` |`,
    `| \`TOOL_SURFACE_BUDGET.defaultMaxBytes\` | ${formatInteger(facts.maxCeilingBytes)}B | code constant, \`src/tools/annotations.ts\` |`,
    `| \`AGGREGATE_SURFACE_LIMITS.maxBytes\` (enforced) | ${formatInteger(facts.maxEnforcedBytes)}B | the ceiling plus ${formatInteger(facts.annotationAllowanceBytes)}B of post-registration annotation metadata |`,
    `| Measured \`tools/list\` payload | ${formatInteger(facts.measuredBytes)}B | \`collectAggregateSurfaceMeasurement\` over the finalized registry, after annotations |`,
    `| Of which outside the per-module table | ${formatInteger(facts.metadataOverheadBytes)}B | ${facts.metadataOverheadPercent.toFixed(1)}% of the payload — tool names, titles, annotations and boundary metadata |`,
    `| Headroom | ${formatInteger(facts.headroomBytes)}B | ${facts.headroomPercent.toFixed(1)}% of the enforced limit |`,
  ];
  return [
    '| Figure | Value | Where it comes from |',
    '|---|---:|---|',
    ...rows,
    '',
    `Headroom is **${formatInteger(facts.headroomBytes)}B** of the ${formatInteger(facts.maxEnforcedBytes)}B enforced limit — ${facts.headroomPercent.toFixed(1)}% — so the aggregate budget is **${facts.verdict}**.`,
    '',
    'Regenerate with `npm run count:tools -- --write`. `--check` fails when any',
    'figure above stops matching the constants or the live measurement, so a',
    'ceiling raise lands in this file as a diff you can read, not as prose that',
    'quietly keeps describing the old one.',
  ].join('\n');
}

function responseCapBlock(census) {
  const facts = census.aggregateSurface;
  return [
    '| | what it bounds | how often the host pays | ceiling |',
    '|---|---|---|---|',
    `| Schema budget (above) | \`tools/list\` — every tool's description and input schema | once per session | ${formatInteger(facts.maxCeilingBytes)}B |`,
    `| Response cap (\`MAX_RESPONSE_BYTES\`) | one \`tools/call\` result's json text + \`structuredContent\` | once per **call**, repeatable | ${formatInteger(facts.responseCapBytes)}B |`,
    '',
    `\`MAX_RESPONSE_BYTES\` is ~1/${facts.responseCapCallsForParity} of the schema budget: ${facts.responseCapCallsForParity} capped calls cost about what the schema surface cost once. That is the whole argument for the ratio.`,
  ].join('\n');
}

function checkSchemaBudgetTruth(census) {
  const errors = [];
  const measurements = new Map(census.schemaMeasurements.map((row) => [row.module, row]));
  for (const budget of census.schemaBudgets) {
    const measured = measurements.get(budget.module);
    if (!measured) {
      errors.push(`docs/schema-budgets.md: shared registrar manifest module ${budget.module} has no registry measurement`);
      continue;
    }
    if (measured.toolCount !== budget.baselineToolCount || measured.schemaBytes !== budget.baselineSchemaBytes) {
      errors.push(`src/tools/annotations.ts: ${budget.module} baseline is ${budget.baselineToolCount} tools/${budget.baselineSchemaBytes}B, measured ${measured.toolCount} tools/${measured.schemaBytes}B`);
    }
  }
  return errors;
}

/**
 * The aggregate figures in `docs/schema-budgets.md` (#1241) are generated, so
 * `--check` already compares them against these values. What this adds is the
 * *relationship* between them: the enforced limit must still be the ceiling
 * plus a non-negative annotation allowance, the measurement must still be
 * inside the enforced limit, and the headroom must be the arithmetic the
 * verdict band was derived from. A code change that breaks any of those fails
 * here rather than shipping a doc block that is internally consistent and
 * wrong.
 */
function checkAggregateSurfaceTruth(census) {
  const facts = census.aggregateSurface;
  const errors = [];
  if (facts.measuredToolCount !== census.tools) {
    errors.push(`docs/schema-budgets.md: aggregate measurement covers ${facts.measuredToolCount} tools, finalized registry reports ${census.tools}`);
  }
  if (facts.annotationAllowanceBytes < 0) {
    errors.push(`src/tools/annotations.ts: enforced limit ${formatInteger(facts.maxEnforcedBytes)}B is below the ceiling ${formatInteger(facts.maxCeilingBytes)}B`);
  }
  if (facts.measuredBytes > facts.maxEnforcedBytes) {
    errors.push(`docs/schema-budgets.md: measured surface ${formatInteger(facts.measuredBytes)}B exceeds the enforced limit ${formatInteger(facts.maxEnforcedBytes)}B`);
  }
  if (facts.headroomBytes !== facts.maxEnforcedBytes - facts.measuredBytes) {
    errors.push(`docs/schema-budgets.md: headroom ${formatInteger(facts.headroomBytes)}B is not enforced-minus-measured`);
  }
  if (facts.verdict !== aggregateSurfaceVerdict(facts.headroomBytes, facts.maxEnforcedBytes)) {
    errors.push(`docs/schema-budgets.md: verdict "${facts.verdict}" does not match the measured headroom ratio`);
  }
  return errors;
}

function allRegistrationKeysFromSource() {
  const { allRegistrationKeys } = parseToolsetsModule();
  return allRegistrationKeys;
}

function toolsetNamesFromSource() {
  const { TOOLSETS } = parseToolsetsModule();
  return Object.keys(TOOLSETS).length;
}

function parseToolsetsModule() {
  const source = readFileSync(join(ROOT, 'src/toolsets.ts'), 'utf8');
  const block = /export const TOOLSETS:[\s\S]*?= \{([\s\S]*?)\} as const;/.exec(source)?.[1];
  if (!block) throw new Error('src/toolsets.ts: cannot derive TOOLSETS');
  const names = [...block.matchAll(/^\s{2}([a-z][a-z0-9]*):\s*\[([^\]]*)\]/gm)].map((match) => [match[1], [...match[2].matchAll(/'([^']+)'/g)].map((key) => key[1])]);
  return {
    TOOLSETS: Object.fromEntries(names),
    allRegistrationKeys: names.flatMap(([, keys]) => keys),
  };
}

function moduleInventory(census) {
  const files = inventoryFiles();
  const sentenceSegmenter = new Intl.Segmenter('en', { granularity: 'sentence' });
  const rows = files.map((file) => {
    const source = readFileSync(join(ROOT, file), 'utf8');
    const description = firstDescription(source, file, sentenceSegmenter)
      .replaceAll('|', '\\|')
      .replace(/\s+/g, ' ');
    const registered = census.perModule[file] ?? 0;
    const noun = registered === 1 ? 'tool' : 'tools';
    return `| \`${file}\` | ${description} (${registered} registered ${noun}) | ${source.split('\n').length - 1} |`;
  });
  return ['| File | Responsibility | LOC |', '|---|---|---:|', ...rows].join('\n');
}

function inventoryFiles() {
  return walkFiles(join(ROOT, 'src'))
    .filter((file) => file.endsWith('.ts'))
    .map((file) => normalizeRepoPath(relative(ROOT, file))).sort()
}

function firstDescription(source, fallback, segmenter) {
  const doc = /^\/\*\*\s*\n([\s\S]*?)\n\s*\*\//.exec(source);
  const leadingComments = /^(?:\/\/[^\n]*\n)+/.exec(source)?.[0];
  const lines = doc
    ? doc[1].split('\n').map((line) => line.replace(/^\s*\* ?/, '').trim())
    : (leadingComments ?? '').split('\n').map((line) => line.replace(/^\/\/ ?/, '').trim());
  while (lines.length > 0 && lines[0] === '') lines.shift();
  const paragraph = [];
  for (const line of lines) {
    if (line === '') break;
    paragraph.push(line);
  }
  const text = paragraph.join(' ').replace(/\s+/g, ' ').trim();
  if (text === '') return `Runtime module for ${fallback}.`;
  const first = [...segmenter.segment(text)][0];
  return first && isSentenceTerminal(text, first) ? first.segment.trim() : text;
}

/**
 * Whether a segment boundary is safe to cut a documentation claim at (#1258).
 *
 * The old code took the first `Intl.Segmenter` segment unconditionally, so a
 * boundary the segmenter chose for typographic reasons could land *inside* a
 * URL and the row would quote half an endpoint. `episodemgmt.ts` header names
 * the real replacement for a removed call, and the segmenter breaks the run at
 * the `?` in `PUT /me/episodes?ids= to save` — the row rendered as a claim about
 * `PUT /me/episodes`, dropping the `ids` parameter that makes it real. A reader
 * could not tell which endpoint was meant, and `--check` passed forever because
 * the generator produced exactly that text.
 *
 * So a cut is accepted only when it is a real sentence end. Two conditions:
 *
 *  1. The segment ends in sentence-terminal punctuation, optionally wrapped in
 *     closing brackets/quotes.
 *  2. That punctuation is not glued to a following character. `?` and `!` are
 *     terminal only when the segmenter was not breaking mid-token — in a query
 *     string the next character is a word character, not whitespace. This is
 *     the general form of the defect: the query string is the case that
 *     happened to occur, and the same break is reachable after any `?` or `!`
 *     inside a path.
 *
 * When a cut is rejected, the whole opening paragraph is returned. A long cell
 * is a cosmetic cost; a mangled platform claim is a correctness one (AGENTS.md
 * §6 — "the summary is not the contract"). Note this deliberately does not
 * touch the source doc comment, which is complete and correct: reordering it
 * would hide the generator bug rather than fix it.
 */
function isSentenceTerminal(text, segment) {
  // `Intl.Segmenter` includes each segment's trailing whitespace, so the
  // terminal-punctuation test has to run on the trimmed segment. Skipping this
  // made every well-formed first sentence look non-terminal and widened the
  // whole module map — the segmenter cuts cleanly at "…reads (#54). " and the
  // bug was invisible until the generated table grew 18 rows.
  const trimmed = segment.segment.trimEnd();
  if (!/[.!?:][\])}"']*$/.test(trimmed)) return false;
  if (!/[?!]$/.test(trimmed)) return true;
  // The offset has to point just past the punctuation, not past the segment's
  // trailing space, or a genuine "…is it a tool? Yes." would read as glued.
  const next = text[segment.index + trimmed.length];
  return next === undefined || /\s/.test(next);
}

function toolSurface(census) {
  return `The full MCP registry exposes **${census.tools} tools** (all ${census.tools} attributed to the ${census.toolModuleFiles} files under \`src/tools/\`), organized by ${census.registrationKeys} registration keys and ${census.toolsetNames} named toolsets; the curated default surface a server registers with no \`SPOTIFY_MCP_TOOLSETS\` is **${census.defaultTools} tools** / ${Number(census.defaultBytes).toLocaleString('en-US')} bytes (#889), and \`SPOTIFY_MCP_TOOLSETS=all\` restores the full one. Registration keys: ${census.registrationKeyNames.map((key) => `\`${key}\``).join(', ')}. \`node scripts/surface-census.mjs\` derives the authoritative inventory by starting the real \`src/index.ts\` stdio entry and calling \`tools/list\`, \`resources/list\`, \`resources/templates/list\`, and \`prompts/list\` after production gates and finalizers, without network access — twice, once for the full surface and once with \`SPOTIFY_MCP_TOOLSETS\` unset, so neither figure is inferred from the other.`;
}

function resourceSurface(census) {
  return `The finalized default registry contains **${census.resources} fixed resources** and **${census.resourceTemplates} resource templates**. Fixed URIs: ${census.resourceUris.map((uri) => `\`${uri}\``).join(', ')}. Template URIs: ${census.resourceTemplateUris.map((uri) => `\`${uri}\``).join(', ')}.`;
}

function promptSurface(census) {
  return `The finalized default registry exposes **${census.prompts} prompts**: ${census.promptNames.map((name) => `\`${name}\``).join(', ')}.`;
}

function distributionSurface(census) {
  return `- Surface: ${census.tools} tools, ${census.resources} fixed resources, ${census.resourceTemplates} resource templates, and ${census.prompts} prompts in the finalized default production registry (toolsets can trim a configured host); aligned with Spotify's current Web API plus the stats.fm public API (read-only, no auth). The registry-derived counts replace historical release snapshots; v1.30.0 added the taste composite briefs, playlist specs, and reports described in \`docs/wave2-composites.md\`.`;
}

function wave2Surface(census) {
  return `Current default production surface: **${census.tools} tools**, including the shipped taste composites documented below. Earlier release totals in this page's history are not current registry truth; regenerate this block with \`npm run count:tools -- --write\`.`;
}

function skillSurface(census) {
  return `Current default production baseline: **${census.tools} tools**, **${census.resources} fixed resources**, **${census.resourceTemplates} resource templates**, and **${census.prompts} prompts**. Regenerate with \`npm run count:tools -- --write\`; never substitute historical prose.`;
}

/**
 * The README's registration-gated table, rendered from `GATED_FAMILIES` in
 * `src/gating.ts` (#605).
 *
 * Generating this is the whole fix. The prose version was a hand-maintained
 * copy of a list that also lives in code, and it had already drifted: it
 * advertised `/recommendations`, `/me/apps` and `/me/chapters` as responses a
 * caller would see, none of which any shipped tool can produce, and it
 * described the `/me/{type}/contains` family as fully wrapped after #862 had
 * migrated the playlist-follow check onto `GET /me/library/contains`. Deriving
 * the table means a family added to `GATED_FAMILIES` shows up here on the next
 * `--write`, and `checkGatedEndpointTruth` fails `--check` when a family's
 * hand-maintained `tools` list stops matching the real call sites.
 */
function gatedEndpointTable() {
  const rows = GATED_FAMILIES.map((family) => {
    const tools = family.tools.length
      ? family.tools.map((t) => `\`${t}\``).join(', ')
      : family.id === 'browse-new-releases'
        ? '*(none — no shipped tool reads this path)*'
        : '*(none — migrated to `GET /me/library/contains`)*';
    // `fallback` answers "what does the tool do". `reason` is deliberately NOT
    // a column: every family here is a Feb 2026 changelog removal, so a column
    // of eight identical cells would assert a distinction the data does not
    // make. `checkGatedEndpointTruth` still validates the field, and a family
    // that is only observed-gated (not removed) will show up here the moment
    // one exists -- the summary line below the table is derived from this.
    const behaviour = family.tools.length === 0
      ? 'Replaced; no call site'
      : family.fallback === 'replaced'
        ? 'Replaced with per-id reads'
        : '403 explained';
    return `| \`${family.id}\` — ${family.label} | ${tools} | ${behaviour} |`;
  });
  const removed = GATED_FAMILIES.filter((f) => f.reason === 'removal').length;
  const observed = GATED_FAMILIES.length - removed;
  // A blank line first: without it the sentence is absorbed into the table's
  // last row by every Markdown renderer.
  const summary = observed === 0
    ? `\n\nAll ${removed} families above are operations Spotify's February 2026 changelog marks \`[REMOVED]\`.`
    : `\n\n${removed} of ${GATED_FAMILIES.length} families above are operations Spotify's February 2026 changelog marks \`[REMOVED]\`; the other ${observed} answer 403 without being listed as removed.`;
  return [
    '| Endpoint family | Shipped tools that call it | On a current registration |',
    '|---|---|---|',
    ...rows,
  ].join('\n') + summary;
}

/**
 * Static scan for gated `client.get` / `client.getAllPages` call sites under
 * `src/tools/`, and for the TOOL each one belongs to (#605, #1278).
 *
 * This exists so the `tools` column above cannot rot into a claim, and — since
 * #1278 — so it cannot rot into a *wrong* claim either. A family is served by
 * exactly the tools that issue a request against it, and a file that registers
 * a dozen tools is not the same thing as a family those twelve tools serve: the
 * previous shape recorded the FILE a call was found in, so one genuine call
 * satisfied the whole column and every other tool in that file inherited a
 * status it was never checked for. That is how `get_user_playlists` came to
 * sit in the `user-profile` family: it reads `GET /me/playlists`, never
 * `/users/{id}`, and nothing objected because a different tool in the same file
 * made the real `/users/{id}` call.
 *
 * So a call site is attributed to a tool, and a family is only satisfied by
 * its own tools. Three limits are deliberate, and all three fail CLOSED —
 * an unattributable call is reported, never silently absorbed:
 *
 *   - It only reads files that construct against `SpotifyClient`.
 *     `src/tools/statsfm.ts` issues `/users/{id}`-shaped paths against the
 *     **stats.fm** API -- a different host, not covered by
 *     `installGatedPathContract` -- which must not be counted here.
 *   - `src/tools/catalog.ts` reaches the batch family through the computed
 *     path `/${kind}`, which a string-literal scan cannot read. The
 *     `SEVERAL_KINDS` expansion below covers that one case explicitly.
 *   - A call reached through a wrapper the scan cannot follow — today exactly
 *     `getWithMarketFallback` in `src/markets.ts`, which is outside the
 *     scanned tree — is named in `GATED_SCAN_EXCEPTIONS` with the reason,
 *     rather than being the default the whole column silently falls back to.
 */

/**
 * A minimal TypeScript lexer, and only the parts the gated scan needs.
 *
 * A regular expression cannot answer the two questions this scan now asks:
 * where a `server.tool(...)` registration ENDS (so a `client.get` in a
 * module-level helper declared *after* it is not mistaken for part of it), and
 * which function a call site sits in (so the helper's callers can be followed
 * one level up to their registrations). It also cannot skip a comment, which is
 * how the previous `client.get`-reading regex could in principle match prose.
 *
 * Comments, string literals, template literals (with `${...}` nesting) and
 * regular-expression literals are consumed as single tokens, so none of them
 * can contribute a stray bracket. This is a lexer, not a parser: it makes no
 * attempt to type-check, and anything it cannot resolve surfaces as an
 * unattributed call site rather than as a pass.
 */
/** Keywords after which a `/` opens a regex literal rather than dividing. */

/** Unescape the handful of single-character escapes a path literal can carry. */
function unescapeBasicLiteral(raw) {
  return raw.replace(/\\(.)/g, (_, ch) => ({ n: '\n', t: '\t', r: '\r' })[ch] ?? ch);
}

function lexSource(source) {
  const tokens = [];
  const length = source.length;
  let index = 0;
  let previous = null;
  const emit = (kind, start, end, extra) => {
    const token = { kind, start, end, text: source.slice(start, end), ...extra };
    tokens.push(token);
    previous = token;
    return token;
  };
  const regexCanStart = () => {
    if (previous === null) return true;
    if (previous.kind === 'punct') return ![')', ']', '}'].includes(previous.text);
    if (previous.kind === 'ident') return TS_REGEX_AFTER_KEYWORD.has(previous.text);
    return false;
  };
  while (index < length) {
    const char = source[index];
    if (TS_WHITESPACE.test(char)) { index += 1; continue; }
    const start = index;
    if (char === '/' && source[index + 1] === '/') { while (index < length && source[index] !== '\n') index += 1; continue; }
    if (char === '/' && source[index + 1] === '*') {
      index += 2;
      while (index < length && !(source[index] === '*' && source[index + 1] === '/')) index += 1;
      index = Math.min(length, index + 2);
      continue;
    }
    if (char === "'" || char === '"') {
      index += 1;
      while (index < length) {
        if (source[index] === '\\') { index += 2; continue; }
        if (source[index] === char) { index += 1; break; }
        index += 1;
      }
      emit('string', start, index, { value: unescapeBasicLiteral(source.slice(start + 1, index - 1)) });
      continue;
    }
    if (char === '`') {
      // The literal chunks between `${...}` substitutions. A substitution is an
      // opaque path segment to the classifier, so the probe rejoins them with
      // the same `x` the previous regex-based scan used.
      const chunks = [];
      let chunkStart = index + 1;
      index += 1;
      while (index < length) {
        const inner = source[index];
        if (inner === '\\') { index += 2; continue; }
        if (inner === '`') { chunks.push(source.slice(chunkStart, index)); index += 1; break; }
        if (inner === '$' && source[index + 1] === '{') {
          chunks.push(source.slice(chunkStart, index));
          index += 2;
          let depth = 1;
          while (index < length) {
            if (source[index] === '{') depth += 1;
            else if (source[index] === '}') { depth -= 1; if (depth === 0) { index += 1; break; } }
            index += 1;
          }
          chunkStart = index;
          continue;
        }
        index += 1;
      }
      emit('template', start, index, { chunks });
      continue;
    }
    if (char === '/' && regexCanStart()) {
      index += 1;
      let inCharacterClass = false;
      while (index < length) {
        const inner = source[index];
        if (inner === '\\') { index += 2; continue; }
        if (inner === '\n') break;
        if (inner === '[') inCharacterClass = true;
        else if (inner === ']') inCharacterClass = false;
        else if (inner === '/' && !inCharacterClass) { index += 1; break; }
        index += 1;
      }
      while (index < length && /[a-z]/.test(source[index])) index += 1;
      emit('regex', start, index);
      continue;
    }
    if (TS_IDENT_START.test(char)) {
      index += 1;
      while (index < length && TS_IDENT_PART.test(source[index])) index += 1;
      emit('ident', start, index);
      continue;
    }
    if (TS_DIGIT.test(char)) {
      while (index < length && /[0-9a-zA-Z_.]/.test(source[index])) index += 1;
      emit('number', start, index);
      continue;
    }
    index += 1;
    emit('punct', start, index);
  }
  return tokens;
}

/**
 * The token index just past the delimiter opened at `open`, or -1 when the
 * source is unbalanced. Every bracket is a token, so counting is enough.
 */
function matchingDelimiter(tokens, open) {
  const close = OPEN_TO_CLOSE[tokens[open].text];
  let depth = 0;
  for (let index = open; index < tokens.length; index += 1) {
    if (tokens[index].kind !== 'punct') continue;
    if (tokens[index].text === tokens[open].text) depth += 1;
    else if (tokens[index].text === close) { depth -= 1; if (depth === 0) return index; }
  }
  return -1;
}

/**
 * The token index of the `(` that opens the argument list of a call whose
 * method name sits at `nameIndex`, or -1 when there is not one there.
 *
 * The type arguments are the whole reason this is not `tokens[nameIndex + 1]`:
 * every read in this repository is spelled `client.get<SomeType>('/path')`,
 * and the type itself can nest (`client.get<{ categories: Paged<CategoryItem> }>`),
 * so the `(` is not the next token and a `<...>` skip has to be balanced too.
 * Bracketed groups inside the type arguments are skipped whole, which is what
 * keeps a `<...>` carrying a function type from being counted as its close.
 *
 * Bailing out returns -1 rather than guessing, so a shape this cannot read is
 * an absent call site — which the gate reports — not a misattributed one.
 */
function callArgumentList(tokens, nameIndex) {
  let index = nameIndex + 1;
  if (tokens[index]?.text === '<') {
    let depth = 0;
    let budget = 128;
    while (index < tokens.length && budget > 0) {
      const token = tokens[index];
      if (token.kind === 'punct') {
        if (['(', '[', '{'].includes(token.text)) {
          const close = matchingDelimiter(tokens, index);
          if (close === -1) return -1;
          index = close + 1;
          continue;
        }
        if (token.text === ';') return -1;
        if (token.text === '<') depth += 1;
        else if (token.text === '>') { depth -= 1; if (depth === 0) { index += 1; break; } }
      }
      index += 1;
      budget -= 1;
    }
  }
  return tokens[index]?.text === '(' ? index : -1;
}

/**
 * Every `server.tool('name', ...)` / `server.registerTool('name', ...)` call,
 * with the token span that covers the whole registration.
 *
 * `name` is null when the first argument is not a string literal — a loop
 * factory (`server.tool(cfg.name, ...)`) or a lookup (`server.tool(meta.tool,
 * ...)`). Those registrations are counted by the coverage check below, which
 * is what keeps a scan that has silently stopped naming tools from reading as
 * a clean run.
 */
function registrationSpans(tokens) {
  const spans = [];
  for (let index = 0; index < tokens.length; index += 1) {
    if (tokens[index].text !== 'server') continue;
    if (tokens[index + 1]?.text !== '.') continue;
    if (!REGISTRATION_METHODS.has(tokens[index + 2]?.text)) continue;
    if (tokens[index + 3]?.text !== '(') continue;
    const close = matchingDelimiter(tokens, index + 3);
    if (close === -1) continue;
    const first = tokens[index + 4];
    spans.push({
      name: first && first.kind === 'string' ? first.value : null,
      from: index,
      to: close,
    });
  }
  return spans;
}

/**
 * Every named function body in the file, as `{ name, from, to }` token spans.
 *
 * Only bodies are recorded, and only where the signature is followed by a
 * brace-delimited block — which is why an arrow returning an expression
 * contributes nothing: the scan follows a helper into the tools that CALL it,
 * and the call sites it needs to follow are all inside blocks.
 */
function functionSpans(tokens) {
  const spans = [];
  for (let index = 0; index < tokens.length; index += 1) {
    if (tokens[index].kind !== 'ident') continue;
    if (tokens[index - 1]?.text === '.') continue;
    if (!FUNCTION_NAME_PRECEDER.has(tokens[index - 1]?.text)) continue;
    // `const name = async (…) => {` and `function name<T>(…) {` both put a
    // qualifier between the name and its parameter list.
    let cursor = index + 1;
    if (tokens[cursor]?.text === 'async') cursor += 1;
    if (tokens[cursor]?.text === '<') {
      const generic = angleGroupEnd(tokens, cursor);
      if (generic === -1) continue;
      cursor = generic + 1;
    }
    if (tokens[cursor]?.text !== '(') continue;
    const close = matchingDelimiter(tokens, cursor);
    if (close === -1) continue;
    const body = blockBodyStart(tokens, close + 1);
    if (body === -1) continue;
    const bodyEnd = matchingDelimiter(tokens, body);
    if (bodyEnd === -1) continue;
    spans.push({ name: tokens[index].text, from: body, to: bodyEnd });
  }
  return spans;
}

/** The token index just past the `>` closing the type arguments at `open`. */
function angleGroupEnd(tokens, open) {
  let depth = 0;
  for (let index = open; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token.kind !== 'punct') continue;
    if (['(', '[', '{'].includes(token.text)) {
      const close = matchingDelimiter(tokens, index);
      if (close === -1) return -1;
      index = close;
      continue;
    }
    if (token.text === '<') depth += 1;
    else if (token.text === '>') { depth -= 1; if (depth === 0) return index; }
  }
  return -1;
}

/**
 * The token index of the `{` that opens a function body whose parameter list
 * ended at `after`, or -1 when the function has no block body.
 *
 * Between the two sit a return-type annotation (`: Promise<ResolvedUris>`) and,
 * for an arrow, the `=>`. Bracketed groups in between are skipped whole so an
 * object literal in a return-type position cannot be mistaken for the body.
 */
function blockBodyStart(tokens, after) {
  let index = after;
  for (let budget = 64; index < tokens.length && budget > 0; index += 1, budget -= 1) {
    const token = tokens[index];
    if (token.kind !== 'punct') continue;
    if (token.text === ';') return -1;
    if (['(', '['].includes(token.text)) {
      const close = matchingDelimiter(tokens, index);
      if (close === -1) return -1;
      index = close;
      continue;
    }
    if (token.text === '<') {
      // A generic return type (`: Promise<{ items: T[] }>`) carries a `{` that
      // belongs to the TYPE, not to the body. Skipping the whole angle group is
      // what keeps `fetchSeveral<T>(…): Promise<{…}> {` from starting its body
      // inside its own signature.
      const generic = angleGroupEnd(tokens, index);
      if (generic === -1) return -1;
      index = generic;
      continue;
    }
    if (token.text === '{') return index;
  }
  return -1;
}

/**
 * `const NAME = <path literal>` bindings, so a call that reads its path through
 * a local variable (`const categoryPath = '/browse/categories/…'`) is still a
 * path this scan can classify. Unresolvable variables contribute no call site
 * rather than a guessed one.
 */
function constPathBindings(tokens) {
  const bindings = [];
  for (let index = 0; index < tokens.length; index += 1) {
    if (tokens[index].kind !== 'ident') continue;
    if (tokens[index - 1]?.text === '.') continue;
    let cursor = index + 1;
    // Allow a type annotation between the name and the `=`.
    let limit = 0;
    while (cursor < tokens.length && tokens[cursor].text !== '=' && limit < 12) {
      if ([';', ',', '('].includes(tokens[cursor].text)) break;
      cursor += 1;
      limit += 1;
    }
    if (tokens[cursor]?.text !== '=') continue;
    const value = tokens[cursor + 1];
    if (value?.kind === 'string') bindings.push({ name: tokens[index].text, at: cursor + 1, path: value.value });
    else if (value?.kind === 'template') bindings.push({ name: tokens[index].text, at: cursor + 1, path: value.chunks.join('x') });
  }
  return bindings;
}


/**
 * Every `client.get(...)` / `client.getAllPages(...)` call whose first argument
 * is a path this scan can read — a string literal, a template literal, or an
 * identifier bound to one.
 */
function clientReadCallSites(tokens, bindings) {
  const sites = [];
  for (let index = 0; index < tokens.length; index += 1) {
    if (tokens[index].text !== 'client') continue;
    if (tokens[index + 1]?.text !== '.') continue;
    if (!CLIENT_READ_METHODS.has(tokens[index + 2]?.text)) continue;
    const open = callArgumentList(tokens, index + 2);
    if (open === -1) continue;
    const first = tokens[open + 1];
    if (first === undefined) continue;
    if (first.kind === 'string') { sites.push({ at: index, path: first.value }); continue; }
    if (first.kind === 'template') { sites.push({ at: index, path: first.chunks.join('x') }); continue; }
    if (first.kind !== 'ident') continue;
    // The nearest preceding binding of that name, which is how the same-file
    // `const` scoping resolves in practice. No binding, no call site.
    let resolved = null;
    for (const binding of bindings) {
      if (binding.name !== first.text) continue;
      if (binding.at >= index) continue;
      if (!resolved || binding.at > resolved.at) resolved = binding;
    }
    if (resolved) sites.push({ at: index, path: resolved.path, viaVariable: first.text });
  }
  return sites;
}

/**
 * The tool names a call site can be attributed to, in the file `source`.
 *
 * Three tiers, in order of confidence:
 *
 *   1. The call is lexically inside a `server.tool(...)` registration — the
 *      overwhelming majority, and unambiguous.
 *   2. The call sits in a module-level helper, and that helper is CALLED from
 *      inside at least one registration in this file. One level of
 *      indirection, which is as far as a lexer can honestly go: a helper
 *      reached only through another helper reports no tool and is reported as
 *      unattributed rather than guessed at.
 *   3. Nothing reaches it. The caller records `tools: []` and the gate says so.
 */
function attributeCallSite(tokens, registrations, functions, callAt) {
  const containing = registrations.filter((span) => span.from <= callAt && callAt <= span.to && span.name !== null);
  if (containing.length > 0) return [...new Set(containing.map((span) => span.name))];
  const bodies = functions.filter((span) => span.from <= callAt && callAt <= span.to);
  if (bodies.length === 0) return [];
  const helper = bodies.reduce((innermost, span) => (span.from > innermost.from ? span : innermost));
  const reached = new Set();
  for (let index = 0; index < tokens.length; index += 1) {
    if (tokens[index].text !== helper.name) continue;
    if (tokens[index - 1]?.text === 'function' || tokens[index - 1]?.text === '.') continue;
    // `fetchSeveral<T>(…)` is a call just as much as `resolveUris(…)` is, so
    // the argument list is located the same way a read's is.
    const open = callArgumentList(tokens, index);
    if (open === -1 || open <= index) continue;
    for (const span of registrations) {
      if (span.name === null) continue;
      if (span.from <= index && index <= span.to) reached.add(span.name);
    }
  }
  return [...reached];
}

/**
 * Scan one source file: the gated call sites it contains and the tools each
 * one is attributed to.
 */
function gatedScanFile(file, source) {
  const tokens = lexSource(source);
  const registrations = registrationSpans(tokens);
  const functions = functionSpans(tokens);
  const bindings = constPathBindings(tokens);
  const lineStarts = [0];
  for (let index = 0; index < source.length; index += 1) {
    if (source[index] === '\n') lineStarts.push(index + 1);
  }
  const lineAt = (offset) => {
    let low = 0;
    let high = lineStarts.length - 1;
    while (low < high) {
      const mid = (low + high + 1) >> 1;
      if (lineStarts[mid] <= offset) low = mid;
      else high = mid - 1;
    }
    return low + 1;
  };
  const hits = [];
  for (const call of clientReadCallSites(tokens, bindings)) {
    const path = call.path.split('?')[0];
    const record = (family) => {
      if (!family) return;
      hits.push({
        family: family.id,
        file,
        line: lineAt(tokens[call.at].start),
        tools: attributeCallSite(tokens, registrations, functions, call.at),
        path: call.viaVariable ? `${path} (via \`${call.viaVariable}\`)` : path,
      });
    };
    record(GATED_FAMILIES.find((family) => family.pattern.test(path)));
    // `fetchSeveral` reads the batch family as the computed path `/${kind}`,
    // which no literal scan can read. Expand the seven members of the
    // `SeveralKind` union so the family is actually seen, and name the shape
    // the hit came from so a reader is not left guessing which literal it was.
    if (path === '/x') {
      for (const kind of SEVERAL_KINDS) {
        const family = GATED_FAMILIES.find((entry) => entry.pattern.test(`/${kind}`));
        if (!family) continue;
        hits.push({
          family: family.id,
          file,
          line: lineAt(tokens[call.at].start),
          tools: attributeCallSite(tokens, registrations, functions, call.at),
          path: `/${kind} (via the computed \`/\${kind}\` in fetchSeveral)`,
        });
      }
    }
  }
  return {
    hits,
    registrations,
    lineAt,
  };
}

/** The directories the gated scan reads, real tree first. */
function gatedScanRoots() {
  return [join(ROOT, 'src', 'tools'), ...gatedScanExtraRoots];
}

/**
 * Every gated call site under `src/tools/`, each carrying the tools it is
 * attributed to. `tools: []` means the scan could not reach a registration —
 * see `GATED_SCAN_EXCEPTIONS`.
 */
function gatedCallSites() {
  const hits = [];
  for (const root of gatedScanRoots()) {
    for (const file of readdirSync(root).filter((name) => name.endsWith('.ts')).sort()) {
      const source = readFileSync(join(root, file), 'utf8');
      // `statsfm.ts` targets api.stats.fm. It names `StatsfmClient` and never
      // `SpotifyClient`, which is the whole of the host test: a file that does
      // not construct against the Spotify client cannot be calling a Spotify
      // endpoint, whatever path shapes its literals have. Applied to every
      // scanned root, not just the real one, so a planted fixture is held to
      // the same rule as the tree it joins.
      if (!source.includes('SpotifyClient')) continue;
      hits.push(...gatedScanFile(file, source).hits);
    }
  }
  return hits;
}

/**
 * Renders the generated-block inventory as AGENTS.md §3's list, grouped by
 * file in `blocks` order. `AGENTS.md`/`generated-blocks` is skipped: this is
 * the block that renders the list, so listing it would make the list claim to
 * contain its own container.
 */
function generatedBlockList(blocks) {
  const byFile = new Map();
  for (const [file, name] of blocks) {
    if (file === 'AGENTS.md' && name === 'generated-blocks') continue;
    const names = byFile.get(file) ?? [];
    names.push(name);
    byFile.set(file, names);
  }
  return [...byFile]
    .map(([file, names]) => `- \`${file}\`: ${names.map((name) => `\`${name}\``).join(', ')}`)
    .join('\n');
}

function markers(file, name) {
  if (file.endsWith('.ts')) {
    return [`// BEGIN:generated ${name}`, `// END:generated ${name}`];
  }
  return [`<!-- BEGIN:generated ${name} -->`, `<!-- END:generated ${name} -->`];
}

function renderedBlock(file, name, body) {
  const [start, end] = markers(file, name);
  return `${start}\n${body}\n${end}`;
}

/** Repository-relative for files inside the repo, absolute for anything outside it. */
function markerPathLabel(file) {
  const rel = relative(ROOT, file);
  return rel.startsWith('..') ? file : rel;
}

/**
 * Every generated-block marker line under each given root (#1238).
 *
 * Deliberately scans the *tree*, not the files `blocks` happens to name. The
 * gate's whole claim is "a stale generated block fails the build", and that
 * claim is only true for blocks someone remembered to register — a marker pair
 * in a file no `blocks` entry mentions is precisely the block nobody is
 * maintaining, and it stays stale and ungated forever while `--check` is green.
 * Restricting the scan to the registered files would reproduce the same blind
 * spot one level down, so the scope here is the whole repository.
 */
function scanGeneratedMarkers(roots = [ROOT]) {
  const found = [];
  const walk = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (entry.name.startsWith('.') || MARKER_SCAN_SKIP.has(entry.name)) continue;
      const file = join(directory, entry.name);
      if (entry.isDirectory()) {
        walk(file);
        continue;
      }
      if (!MARKER_SCAN_EXTENSIONS.has(extname(entry.name))) continue;
      for (const match of readFileSync(file, 'utf8').matchAll(MARKER_LINE)) {
        found.push({
          file: markerPathLabel(file),
          kind: match[1] === 'BEGIN' ? 'begin' : 'end',
          name: match[2],
        });
      }
    }
  };
  for (const root of roots) walk(root);
  return found;
}

/**
 * Reconcile the markers present in the tree against the entries in `blocks`
 * (#1238). Four failure classes, all previously invisible to `--check`:
 *
 *  - **orphan** — a marker pair exists in the tree that no `blocks` entry
 *    claims. Nothing regenerates it, so it cannot be kept current, and the
 *    staleness check has nothing to run against.
 *  - **phantom** — a `blocks` entry names a block that has no marker pair.
 *    `inspectGeneratedBlock` already counted `0`, but reported it as a marker
 *    count; this names the direction that went wrong.
 *  - **unbalanced** — a `BEGIN` with no `END` (or the reverse) in a file that
 *    does not otherwise have a pair. A half-open block is a file the writer
 *    would splice across the rest of the document.
 *  - **double-claimed** — two `blocks` entries for the same file and name.
 *    They would render different bodies into the same markers; the second write
 *    would silently win.
 *
 * Returns the messages alongside the derived sets so `checkDocumentation` can
 * suppress `inspectGeneratedBlock`'s blunter "found 0 markers" line for a
 * phantom it has already reported precisely.
 */
export function markerTreeReport(found, blockEntries) {
  const claims = new Map();
  for (const [file, name] of blockEntries) {
    const key = `${file}:${name}`;
    claims.set(key, (claims.get(key) ?? 0) + 1);
  }

  const opens = new Map();
  const closes = new Map();
  const bump = (map, key) => map.set(key, (map.get(key) ?? 0) + 1);
  for (const marker of found) {
    bump(marker.kind === 'begin' ? opens : closes, `${marker.file}:${marker.name}`);
  }

  const errors = [];
  const phantoms = new Set();

  for (const [key, count] of claims) {
    if (count > 1) {
      errors.push(`blocks array claims generated ${key} by ${count} entries; each block must be claimed exactly once`);
    }
    if (!opens.has(key)) {
      phantoms.add(key);
      errors.push(`blocks array declares generated ${key} but no BEGIN:generated marker pair exists in the tree (phantom entry — it will make --write throw)`);
    }
  }

  for (const key of new Set([...opens.keys(), ...closes.keys()])) {
    const starts = opens.get(key) ?? 0;
    const ends = closes.get(key) ?? 0;
    if (starts !== ends) {
      errors.push(`${key} has ${starts} BEGIN and ${ends} END marker(s); a generated block needs exactly one of each (unbalanced)`);
      continue;
    }
    if (!claims.has(key)) {
      errors.push(`${key} is a generated block in the tree that no blocks array entry claims (orphan) — nothing regenerates it, so --check can never report it stale`);
    }
  }

  return {
    errors,
    phantoms,
    markerCount: found.length,
    claimedCount: claims.size,
    // Which files the scan actually read. A count alone cannot tell "covered
    // the repository" from "covered three files that happen to hold every
    // marker" — the coverage claim is the one #1238 is actually about, so the
    // report has to carry it.
    files: [...new Set(found.map((marker) => marker.file))].sort(),
  };
}

export function inspectGeneratedBlock(source, file, name, body) {
  const [start, end] = markers(file, name);
  const startCount = source.split(start).length - 1;
  const endCount = source.split(end).length - 1;
  if (startCount !== 1) return `${file}: expected exactly one ${start} marker, found ${startCount}`;
  if (endCount !== 1) return `${file}: expected exactly one ${end} marker, found ${endCount}`;
  const startAt = source.indexOf(start);
  const endAt = source.indexOf(end);
  if (endAt <= startAt) return `${file}: generated ${name} end marker precedes its start marker`;
  const actual = source.slice(startAt, endAt + end.length);
  if (actual !== renderedBlock(file, name, body)) return `${file}: generated ${name} block is stale`;
  return null;
}

function checkDocumentation(blocks) {
  const errors = [];
  // #1238: walk the tree, not just `blocks`. Runs first so a phantom/orphan
  // verdict exists before any per-block staleness comparison, which lets the
  // loop below stay quiet about a block the tree pass has already named.
  const tree = markerTreeReport(scanGeneratedMarkers(markerScanRoots), blocks);
  errors.push(...tree.errors);
  // #1384: the generated blocks above are the half of a mixed document the
  // generator owns. This is the other half — the prose it has no copy of, so a
  // whole-file conflict resolution deletes it with nothing downstream able to
  // restore or report it. Runs next to the tree pass for the same reason: it is
  // a reconciliation against a checked-in expectation, not a formatting rule.
  //
  // Skipped by `--no-prose` (#1436), which is the whole reason that flag
  // exists: `scripts/doc-prose-manifest.json` is a documentation artifact, and
  // a caller asserting the *architecture* must not go red because somebody
  // reworded ARCHITECTURE.md. See `checkProse` at the flag's declaration. The
  // provenance verdict below is scoped with it, because it is a question about
  // the same file: answering it under `--no-prose` would reintroduce exactly
  // the coupling #1436 removed.
  if (checkProse) {
    const proseManifest = readProseManifest();
    errors.push(...proseDrift(proseManifest, proseDocumentsUnderTest()).errors);
    // #1440: the pin says which tree it was generated from, so a rebase or amend
    // after the sync is a check-time error rather than a fact the next reader has
    // to reconstruct. Only the `rewritten` verdict fires the gate; `unverifiable`
    // is the normal state of a `fetch-depth: 1` checkout and is reported by
    // `--prose-report` instead, because a gate that is red whenever the clone is
    // shallow is a gate that gets ignored.
    const provenance = proseProvenanceVerdict(proseManifest, { ancestor: headContains });
    if (provenance.error) errors.push(provenance.error);
  }
  for (const [file, name, body] of blocks) {
    if (tree.phantoms.has(`${file}:${name}`)) continue;
    const error = inspectGeneratedBlock(readFileSync(join(ROOT, file), 'utf8'), file, name, body);
    if (error) errors.push(error);
  }
  errors.push(...checkSchemaBudgetTruth(result));
  errors.push(...checkAggregateSurfaceTruth(result));
  errors.push(...cookbook.errors);
  errors.push(...checkSpecStructure());
  errors.push(...checkDocReachability());
  errors.push(...checkGatedEndpointTruth());
  return errors;
}

function checkSpecStructure() {
  const spec = readFileSync(join(ROOT, 'SPEC.md'), 'utf8');
  const toc = [...spec.matchAll(/^(\d+)\. \[[^\]]+\]\(#(\d+)-/gm)].map((match) => [Number(match[1]), Number(match[2])]);
  const sections = [...spec.matchAll(/^## (\d+)\. /gm)].map((match) => Number(match[1]));
  const expected = Array.from({ length: 13 }, (_, index) => index + 1);
  const errors = [];
  if (toc.some(([ordinal, target]) => ordinal !== target)) errors.push('SPEC.md: TOC ordinal does not match its heading target');
  if (JSON.stringify(sections) !== JSON.stringify(expected)) errors.push(`SPEC.md: top-level sections are ${sections.join(', ')}; expected ${expected.join(', ')}`);

  const references = [];
  const referenceFiles = [join(ROOT, 'ARCHITECTURE.md'), ...walkFiles(join(ROOT, 'src')).filter((file) => file.endsWith('.ts')), ...readdirSync(join(ROOT, 'skills')).map((name) => join(ROOT, 'skills', name, 'SKILL.md'))];
  for (const file of referenceFiles) {
    const source = readFileSync(file, 'utf8');
    for (const match of source.matchAll(/SPEC(?:\s+section|\s*§)\s*(\d+(?:\.\d+)?)/gi)) references.push({ file, section: match[1] });
  }
  const headings = new Set([...spec.matchAll(/^#{2,4}\s+(\d+(?:\.\d+)*)(?:\.|\s)/gm)].map((match) => match[1]));
  for (const { file, section } of references) {
    if (!headings.has(section)) errors.push(`${relative(ROOT, file)}: SPEC section ${section} does not exist`);
  }
  return errors;
}

function walkFiles(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const file = join(directory, entry.name);
    return entry.isDirectory() ? walkFiles(file) : [file];
  });
}

function checkDocReachability() {
  const readme = readFileSync(join(ROOT, 'README.md'), 'utf8');
  const errors = [];
  for (const file of readdirSync(join(ROOT, 'docs')).filter((name) => name.endsWith('.md')).sort()) {
    if (!readme.includes(`](docs/${file})`)) errors.push(`README.md: docs/${file} is not reachable from the Docs list`);
  }
  return errors;
}

/**
 * What the gated scan actually read, and whether it could name anything
 * (#1278) — the anti-vacuity half of the per-tool gate.
 *
 * Per-tool attribution is only meaningful if the scan can still SEE the
 * registrations and still reach every call. Three things can stop it, and all
 * three look like success from inside the family rules above, because a family
 * whose tools are all unattributed is shaped exactly like a family with no
 * calls: a lexer that stopped matching `server.tool(`, a module that registers
 * through a local alias (`statsfm_taste.ts` calls `s.tool(...)` off a cast of
 * `server`), or a file whose gated call no registration reaches. So the counts
 * are reported here rather than left implicit, and three properties are
 * asserted against the registry the census itself produced by running the real
 * registrars — never against a number typed into a test.
 *
 *   1. No phantom names. Every tool name the scan reads off a
 *      `server.tool('...')` must be a name the finalized registry serves; a
 *      match in a comment or a string fails here.
 *   2. Reach. Every gated call site resolves to at least one registered tool, or
 *      the family carries an explicit `GATED_SCAN_EXCEPTIONS` entry for the
 *      file it sits in. A scan that attributes nothing is a scan that reports
 *      success over an empty set.
 *   3. Not empty. A run that reads no registrations and no call sites is a scan
 *      that has stopped working, and says so instead of passing.
 *
 * Reads `src/tools` directly and ignores `--gated-scan-extra`, so a planted
 * fixture can never make the production counts look complete.
 */
function checkGatedScanCoverage(hits) {
  const errors = [];
  const toolsDir = join(ROOT, 'src', 'tools');
  // A `server.tool('x', …)` line is a REGISTRATION, and this scan exists to
  // catch a name that is not one. Since #695 some registrations are
  // conditional: eleven tools are written literally in their module and
  // registered only when SPOTIFY_MCP_EXPERIMENTAL_ANALYTICS is set, so they
  // are absent from the default `tools/list` this scan reads.
  //
  // They are joined to the known set rather than excepted by hand. The set is
  // the MEASURED one (`gatedToolNames`, above — the census registers every
  // module both ways and diffs), so a genuinely phantom name still fails and a
  // renamed tool cannot linger here as a stale exception. An `excepted` list
  // would be exactly the hand-typed copy this avoids elsewhere.
  const registered = new Set(census.toolNames);
  const conditionallyRegistered = new Set(measuredGatedToolNames);
  const files = readdirSync(toolsDir).filter((name) => name.endsWith('.ts')).sort();
  let registrations = 0;
  const phantoms = [];
  for (const file of files) {
    const source = readFileSync(join(toolsDir, file), 'utf8');
    for (const span of registrationSpans(lexSource(source))) {
      registrations += 1;
      if (span.name !== null && !registered.has(span.name) && !conditionallyRegistered.has(span.name)) {
        phantoms.push(`${file}: ${span.name}`);
      }
    }
  }
  for (const phantom of phantoms) {
    errors.push(`gated scan coverage: read tool name ${phantom}, which is in neither the finalized production registry nor the measured opt-in surface — the scan is matching something that is not a registration`);
  }
  const exceptionsFor = (familyId, file) => GATED_SCAN_EXCEPTIONS.some(
    (entry) => entry.family === familyId && entry.file === file,
  );
  for (const hit of hits) {
    if (hit.tools.length > 0) {
      for (const tool of hit.tools) {
        if (!registered.has(tool) && !conditionallyRegistered.has(tool)) {
          errors.push(`gated scan coverage: attributed the gated call at ${hit.file}:${hit.line} to ${tool}, which is in neither the finalized production registry nor the measured opt-in surface`);
        }
      }
      continue;
    }
    if (exceptionsFor(hit.family, hit.file)) continue;
    errors.push(`gated scan coverage: the gated call at ${hit.file}:${hit.line} (${hit.path}) reaches no registered tool`);
  }
  if (registrations === 0) {
    errors.push(`gated scan coverage: read 0 server.tool()/server.registerTool() registrations from ${files.length} file(s) under src/tools; the scan is not reading registrations at all`);
  }
  if (hits.length === 0) {
    errors.push(`gated scan coverage: found 0 gated call sites under src/tools; the scan is reading no call sites at all`);
  }
  return errors;
}

function checkGatedEndpointTruth() {
  const readme = readFileSync(join(ROOT, 'README.md'), 'utf8');
  const spec = readFileSync(join(ROOT, 'SPEC.md'), 'utf8');
  const errors = [];
  const cases = [
    ['/browse/categories', true], ['/browse/categories/party/playlists', true],
    ['/browse/new-releases', true], ['/markets', true],
    ['/artists/artist-id/top-tracks', true], ['/users/user-id', true],
    ['/me/albums/contains', true], ['/me/tracks/contains', true],
    ['/me/episodes/contains', true], ['/me/shows/contains', true],
    ['/me/audiobooks/contains', true], ['/me/following/contains', true],
    ['/playlists/playlist-id/followers/contains', true],
    // #725: the multi-id batch endpoints. After the query string is stripped,
    // the bare plural paths land in the gated class so a 403 lets
    // `fetchSeveral` fall back to per-item GETs.
    ['/tracks', true], ['/albums', true], ['/artists', true],
    ['/episodes', true], ['/shows', true], ['/audiobooks', true], ['/chapters', true],
    ['/me/player/playback-state', false], ['/tracks/track-id', false],
    ['/albums/album-id', false], ['/artists/artist-id', false],
  ];
  for (const [path, expected] of cases) {
    if (isGatedPath(path) !== expected) errors.push(`GATED_PATH_PATTERNS: ${path} classified as ${isGatedPath(path)}, expected ${expected}`);
  }
  // #725: the batch-endpoint pattern is the eighth entry. The shared
  // surface-census mjs is the only place this length is pinned; tests
  // (#329 / #725) check the same constant via isGatedPath case rows.
  if (GATED_PATH_PATTERNS.length !== 8) errors.push(`GATED_PATH_PATTERNS: expected 8 exported patterns, found ${GATED_PATH_PATTERNS.length}`);

  // #605: every family's documented example must be accepted by its own
  // pattern. Without this the table could name a path the classifier rejects,
  // which is how a hand-maintained list drifts away from the code.
  for (const family of GATED_FAMILIES) {
    if (!family.pattern.test(family.example)) {
      errors.push(`GATED_FAMILIES[${family.id}]: documented example ${family.example} is not matched by its own pattern`);
    }
  }

  // #605, #1278: the hand-maintained `tools` column must match the real call
  // sites, and it is checked PER TOOL in both directions.
  //
  // The previous shape recorded the FILE a call was found in, so the verdict
  // was `live.size === 0` — one gated call anywhere in one of the family's
  // files satisfied the whole column. That both missed a tool that calls a
  // gated endpoint without declaring it, and let an unrelated tool in the same
  // file inherit a disclosure it had no business carrying: `get_user_playlists`
  // sat in `user-profile` because a DIFFERENT tool in the same file made the
  // real `/users/{id}` call. A column of tools is checked as a set of tools.
  const registered = new Set(census.toolNames);
  const attributed = new Map();
  const orphans = new Map();
  for (const hit of gatedCallSites()) {
    const bucket = hit.tools.length === 0 ? orphans : attributed;
    if (!bucket.has(hit.family)) bucket.set(hit.family, new Map());
    const byTool = bucket.get(hit.family);
    const key = hit.tools.length === 0 ? hit.file : hit.tools;
    for (const name of Array.isArray(key) ? key : [key]) {
      if (!byTool.has(name)) byTool.set(name, []);
      byTool.get(name).push(hit);
    }
  }
  const exceptionsFor = (familyId) => GATED_SCAN_EXCEPTIONS.filter((entry) => entry.family === familyId);
  for (const family of GATED_FAMILIES) {
    const live = attributed.get(family.id) ?? new Map();
    const unattributed = orphans.get(family.id) ?? new Map();
    const exceptions = exceptionsFor(family.id);
    const declared = new Set(family.tools);
    if (family.tools.length === 0 && live.size + unattributed.size > 0) {
      errors.push(`GATED_FAMILIES[${family.id}]: declares no shipped tools, but gated call sites exist in ${[...live.keys(), ...unattributed.keys()].join(', ')}`);
    }
    if (family.tools.length > 0 && live.size + unattributed.size === 0) {
      errors.push(`GATED_FAMILIES[${family.id}]: claims tools [${family.tools.join(', ')}] but no gated client.get call site was found in src/tools/`);
    }
    for (const tool of family.tools) {
      if (!registered.has(tool)) {
        errors.push(`GATED_FAMILIES[${family.id}]: names tool ${tool}, which is not in the finalized production registry`);
      }
      // The direction the per-FILE shape could not express: a declared tool
      // that no gated call site is attributed to.
      if (!live.has(tool) && !exceptions.some((entry) => entry.tool === tool)) {
        errors.push(`GATED_FAMILIES[${family.id}]: declares tool ${tool}, but no gated client.get call site is attributed to it (attributed: ${live.size === 0 ? 'none' : [...live.keys()].join(', ')}); if the scan cannot see its call, add a GATED_SCAN_EXCEPTIONS entry saying so`);
      }
    }
    // The other direction: a tool that DOES call the family and does not say
    // so. This is the one that catches the `get_user_playlists` substitution.
    for (const tool of live.keys()) {
      if (!declared.has(tool)) {
        const where = live.get(tool).map((hit) => `${hit.file}:${hit.line}`).join(', ');
        errors.push(`GATED_FAMILIES[${family.id}]: gated call at ${where} is attributed to tool ${tool}, which the family does not declare`);
      }
    }
    // A call no registration reaches is reported, never absorbed: the
    // tolerance is the named list, not the default.
    for (const [file, hits] of unattributed) {
      if (exceptions.some((entry) => entry.file === file)) continue;
      const where = hits.map((hit) => `${file}:${hit.line}`).join(', ');
      errors.push(`GATED_FAMILIES[${family.id}]: gated call at ${where} is not attributed to any registered tool and ${file} has no GATED_SCAN_EXCEPTIONS entry; add one naming the tools it serves, or make the call reachable from a registration`);
    }
  }
  // The exception list is a gate, not a comment: every entry is checked, and
  // an entry the scan can now see is stale rather than harmless.
  for (const entry of GATED_SCAN_EXCEPTIONS) {
    const family = GATED_FAMILIES.find((candidate) => candidate.id === entry.family);
    const label = `GATED_SCAN_EXCEPTIONS[${entry.family}/${entry.tool}]`;
    if (!family) { errors.push(`${label}: no such GATED_FAMILIES id`); continue; }
    if (!family.tools.includes(entry.tool)) errors.push(`${label}: the ${entry.family} family does not declare ${entry.tool}, so nothing is being tolerated`);
    if (!registered.has(entry.tool)) errors.push(`${label}: ${entry.tool} is not in the finalized production registry`);
    if (typeof entry.reason !== 'string' || entry.reason.trim().length === 0) errors.push(`${label}: an exception must say why the scan cannot follow this call`);
    const owners = moduleNames.get(`src/tools/${entry.file}`) ?? [];
    if (!owners.includes(entry.tool)) {
      errors.push(`${label}: names file src/tools/${entry.file}, which does not register ${entry.tool} (it registers ${owners.length === 0 ? 'nothing' : owners.join(', ')})`);
    }
    if (attributed.get(entry.family)?.has(entry.tool)) {
      errors.push(`${label}: ${entry.tool} is now attributed to a gated call site, so this exception is stale — delete it`);
    }
  }
  errors.push(...checkGatedScanCoverage(gatedCallSites()));

  // #605: the README table is generated, so the substantive claim to check is
  // that the framing around it no longer asserts the absolutes that made the
  // three README statements contradict each other.
  for (const banned of [
    'No zombie tools for endpoints Spotify removed',
    'Every non-deprecated endpoint',
  ]) {
    if (readme.includes(banned)) {
      errors.push(`README.md: still claims "${banned}", which the generated gated-endpoints table contradicts`);
    }
  }
  for (const endpoint of ['/artists/{id}/top-tracks', '/me/{type}/contains']) {
    if (!readme.includes(endpoint)) errors.push(`README.md: missing gated endpoint ${endpoint}`);
  }
  if (!spec.includes('GATED_PATH_PATTERNS') || !spec.includes('/artists/{id}/top-tracks') || !spec.includes('/me/{type}/contains')) {
    errors.push('SPEC.md: endpoint constraints do not name GATED_PATH_PATTERNS and the gated batch/top-tracks families');
  }
  if (!readme.includes('### Registration-gated endpoints')) {
    errors.push('README.md: missing Registration-gated endpoints heading/anchor');
  }
  return errors;
}

function writeBlock(file, name, body) {
  const [start, end] = markers(file, name);
  const expected = `${start}\n${body}\n${end}`;
  const source = readFileSync(file, 'utf8');
  const startCount = source.split(start).length - 1;
  const endCount = source.split(end).length - 1;
  if (startCount !== 1 || endCount !== 1) {
    // #1238: the old message was a bare `found 0/0` count, which reads as a
    // counting bug rather than "this file has no skeleton for this block" — and
    // it is why a `blocks` entry for a block nobody had added markers for was
    // invisible until the crash. Name the missing skeleton and the way out.
    if (startCount === 0 && endCount === 0) {
      throw new Error(
        `${relative(ROOT, file)}: no marker skeleton for generated block "${name}" — expected exactly one \`${start}\` and one \`${end}\` in the file, found none.\n`
        + 'Add the markers around the block, or drop the blocks array entry if this block should not exist.',
      );
    }
    throw new Error(
      `${relative(ROOT, file)}: generated block "${name}" has ${startCount}/${endCount} markers — expected exactly one \`${start}\` and one \`${end}\`.`,
    );
  }
  const pattern = new RegExp(`${escapeRegExp(start)}[\\s\\S]*?${escapeRegExp(end)}`);
  writeFileSync(file, source.replace(pattern, expected));
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
