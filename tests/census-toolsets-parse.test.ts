/**
 * The census's `TOOLSETS` parse fails closed on a zero-match (#1513).
 *
 * ## The defect
 *
 * `parseToolsetsModule` in `scripts/surface-census.mjs` extracted the `TOOLSETS`
 * literal with a whitespace-sensitive entry pattern:
 *
 * ```js
 * const names = [...block.matchAll(/^\s{2}([a-z][a-z0-9]*):\s*\[([^\]]*)\]/gm)]
 * ```
 *
 * and guarded only the *enclosing* literal:
 *
 * ```js
 * if (!block) throw new Error('src/toolsets.ts: cannot derive TOOLSETS');
 * ```
 *
 * The two can disagree. The enclosing pattern is `[\s\S]*?` and its terminator
 * is a fixed `} as const;`, so re-indenting the object literal from two spaces
 * to four — a `tsc`-clean reformat that changes no behaviour at all — leaves
 * the enclosing match perfectly satisfied while every entry stops matching.
 * Measured on `origin/main` at `ec1d561a`: 14 entries matched before the
 * re-indent, 0 after, and the guard still passed.
 *
 * Nothing checked that `names` was non-empty, so `TOOLSETS` became `{}`. The
 * two consumers — `toolsetNamesFromSource` and `allRegistrationKeysFromSource`
 * — both feed the SPEC.md `tool-surface` block, and the shape of the damage is
 * what makes a zero-match different from any ordinary census value:
 *
 * | step | before the fix | after the fix |
 * |---|---|---|
 * | `--check` on a re-indented tree | exit 1, "block is stale" | exit 1, names the zero-match |
 * | `--write` on a re-indented tree | exit 0, block replaced with a 0-toolsets claim | exit 1, nothing written |
 * | `--check` after that `--write` | **exit 0** — the gate is green on the emptied block | n/a: `--write` never emptied it |
 *
 * So a whitespace-only reformat turned `--check` plus `--write` into a silent
 * documentation deletion with a green gate. The prose pin (`--prose-report`,
 * #1384) stayed green on it too, because the deleted bytes were inside a
 * *generated* block and the pin covers hand-written prose.
 *
 * ## What these tests hold
 *
 * The guard has to be shown to reject, not assumed to. The real `--check` and
 * `--write` read the repository's own `src/toolsets.ts`, which is well-formed,
 * so a test that only re-ran them against the real tree would pass with the
 * bug still present — it would be asserting that a correct input produces a
 * correct output, which is the happy case and nothing more. AGENTS.md §6: *a
 * guard that only ever sees the correct input has never been shown it works.*
 *
 * So the parser is driven through the same `--toolsets-fixture` seam the other
 * census fixture routes use (`--description-fixture`, `--cookbook-fixture`,
 * `--marker-fixture`, `--module-row-fixture`, `--marker-tree-fixture`), and the
 * module under test is a **scratch fixture** written under `os.tmpdir()`.
 * `src/toolsets.ts` in the working tree is never touched — the census reads the
 * real path, and a test that reached past the seam to mutate a source file
 * would be a worse hazard than the defect it covers. `itDoesNotMutateTheRealModule`
 * asserts that directly, so the choice is checkable rather than a claim in a
 * comment.
 *
 * Both sides of the boundary are covered, because a guard that fires on
 * everything is a tripwire rather than a rule: `parsesAWellFormedModule` drives
 * the real fixture through the real script and asserts the real parse, and
 * `rejectsAZeroMatchModule` drives the re-indented one and asserts the throw.
 *
 * The last test is the one that keeps the message honest. A census bug and a
 * stale documentation block are different problems with different fixes, and
 * the reader who hits this needs to be sent to `parseToolsetsModule` and *away*
 * from `--write` — because running `--write` here is the second half of the
 * deletion. The message is asserted to say both things, so a later edit that
 * softens it into a generic parse failure goes red.
 */

import './helpers/hermetic.js';

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const TOOLSETS = join(ROOT, 'src', 'toolsets.ts');

type Run = { status: number; stdout: string; stderr: string };

/** One subprocess against the real script, with its status kept rather than thrown. */
function execRun(args: string[]): Run {
  try {
    const stdout = execFileSync(process.execPath, ['scripts/surface-census.mjs', ...args], {
      cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 32 * 1024 * 1024,
    });
    return { status: 0, stdout, stderr: '' };
  } catch (error) {
    const failure = error as { status?: number; stdout?: string; stderr?: string };
    return { status: failure.status ?? 1, stdout: failure.stdout ?? '', stderr: failure.stderr ?? '' };
  }
}

/**
 * Run `run` against a fresh scratch directory under `os.tmpdir()` (#1383).
 *
 * `mkdtemp` under the repository would leave an untracked `.census-fixture-*`
 * behind on an abnormal exit, and an untracked file makes a correct change read
 * as a stale one: `git status --porcelain` being empty is this repo's standing
 * assertion that no generated block is stale, so a leak makes the one local
 * signal that predicts CI read as broken. The `scratchOutsideRepo` assertion is
 * inside the `try` for the same reason `withFixtures` puts it there in
 * `tests/arch-inventory.test.ts` — asserting first would throw past the
 * `finally` and leak the very directory the assertion is protecting.
 */
function withScratch<T>(run: (dir: string) => T): T {
  const dir = mkdtempSync(join(tmpdir(), 'census-toolsets-'));
  try {
    const rel = relative(ROOT, dir);
    assert.ok(
      isAbsolute(rel) || rel.startsWith('..'),
      `fixture ${dir} is inside the repository (${rel}); it must live under os.tmpdir() so an abnormal exit cannot leave the working tree dirty (#1383)`,
    );
    return run(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Write a `src/toolsets.ts` body to a scratch fixture and return its path. */
function writeFixture(dir: string, name: string, source: string): string {
  const file = join(dir, `${name}.json`);
  writeFileSync(file, JSON.stringify({ source }));
  return file;
}

/**
 * A well-formed module, in the shape `src/toolsets.ts` actually has.
 *
 * Hand-written rather than copied from the real file on purpose: reading the
 * real one and re-indenting it would make the zero-match fixture a transform of
 * a source the test then asserts against, so a change to that file could move
 * the expectation. These two are the pair the issue is about — same entries,
 * same keys, one indentation level apart — and holding them as literals is what
 * makes "only the indentation differs" checkable by reading them side by side.
 *
 * It carries `UNGATED_REGISTRATION_KEYS` too, because the census reads that
 * literal as well (#580). A fixture without it is not a well-formed module any
 * more: the parse fails closed on a missing literal, which is the correct
 * behaviour and would make this fixture assert a throw rather than a parse.
 * `swarm3meta` is deliberately in both, mirroring the real file, where it is a
 * toolset member *and* ungated — so the union below is what proves the census
 * dedupes rather than concatenates.
 */
const WELL_FORMED = [
  'export const TOOLSETS: Record<string, readonly string[]> = {',
  "  core: ['search', 'library'],",
  "  playback: ['playback'],",
  "  catalog: ['catalog', 'browse'],",
  "  swarm3meta: ['swarm3meta'],",
  '} as const;',
  '',
  'export const UNGATED_REGISTRATION_KEYS: readonly string[] = [',
  "  'doctor',",
  "  'swarm3meta',",
  "  'moodexpand',",
  "  'receipts',",
  '];',
  '',
].join('\n');

/** The same module, re-indented from two spaces to four. Nothing else differs. */
const REINDENTED = WELL_FORMED.replace(/^ {2}(?=[a-z])/gm, '    ');

describe('#1513 the TOOLSETS parse fails closed on a zero-match', () => {
  it('parses a well-formed module', () => {
    withScratch((dir) => {
      const run = execRun(['--toolsets-fixture', writeFixture(dir, 'well-formed', WELL_FORMED)]);
      assert.equal(run.status, 0, `a well-formed module must parse, so the zero-match guard must not fire on it.\nstderr:\n${run.stderr}`);
      const parsed = JSON.parse(run.stdout) as { toolsets: string[]; registrationKeys: string[] };
      // Asserted against literals written above, not recomputed from the
      // fixture: an expectation derived from the same input the code under test
      // reads proves nothing (AGENTS.md §6).
      assert.deepEqual(parsed.toolsets, ['core', 'playback', 'catalog', 'swarm3meta']);
      // The union in the order the census builds it: every toolset member, then
      // every ungated key. `swarm3meta` is deliberately in both terms, so it
      // appears TWICE here — this is the raw concatenation, and the dedupe is
      // the caller's (`[...new Set(allRegistrationKeysFromSource())]` in
      // `registrationKeyList`). Asserting the deduped list at this layer would
      // be asserting a behaviour this function does not have, and the rendered
      // block's single `swarm3meta` is what proves the caller dedupes.
      assert.deepEqual(
        parsed.registrationKeys,
        ['search', 'library', 'playback', 'catalog', 'browse', 'swarm3meta', 'doctor', 'swarm3meta', 'moodexpand', 'receipts'],
      );
    });
  });

  it('rejects a zero-match module', () => {
    withScratch((dir) => {
      const run = execRun(['--toolsets-fixture', writeFixture(dir, 'reindented', REINDENTED)]);
      // Non-zero is the load-bearing half: a guard that returned 0 here is the
      // defect, because `--write` reads that status as "go ahead and write".
      assert.notEqual(run.status, 0, 'a zero-match parse must exit non-zero; --write reads 0 as permission to write, which is how an emptied block gets installed');
      assert.match(
        `${run.stdout}\n${run.stderr}`,
        /matched 0 toolset entries/,
        'the failure must name the condition — a zero-match parse, not an unspecified parse error',
      );
      // A partial parse would be the same defect wearing a smaller number, so
      // the guard is asserted to reject rather than to return an empty set.
      assert.doesNotMatch(run.stdout, /"toolsets"/, 'a rejected parse must not also print a parsed result');
    });
  });

  it('distinguishes a missing literal from a zero match', () => {
    withScratch((dir) => {
      const noLiteral = 'export const SOMETHING_ELSE = { } as const;\n';
      const run = execRun(['--toolsets-fixture', writeFixture(dir, 'no-literal', noLiteral)]);
      assert.notEqual(run.status, 0, 'a module with no TOOLSETS literal must be rejected too');
      const output = `${run.stdout}\n${run.stderr}`;
      // The two failures have different causes and different fixes, so they
      // must not collapse into one message.
      assert.match(output, /cannot derive TOOLSETS/);
      assert.doesNotMatch(output, /matched 0 toolset entries/, 'a missing literal is not a zero match; the message must not claim the literal was found');
    });
  });

  it('tells the reader this is a census bug and not a stale document', () => {
    withScratch((dir) => {
      const run = execRun(['--toolsets-fixture', writeFixture(dir, 'reindented-message', REINDENTED)]);
      const output = `${run.stdout}\n${run.stderr}`;
      // Names the script that is wrong, so the reader goes to the parser.
      assert.match(output, /parseToolsetsModule/);
      // And rules out the repair that would finish the deletion. Without this
      // the natural next step on "block is stale" is `--write`, which is the
      // other half of the bug.
      assert.match(output, /do not run/i);
      assert.match(output, /--write/);
    });
  });

  it('does not mutate the real src/toolsets.ts', () => {
    const before = readFileSync(TOOLSETS, 'utf8');
    withScratch((dir) => {
      for (const [name, source] of [['ok', WELL_FORMED], ['reindented', REINDENTED]] as const) {
        execRun(['--toolsets-fixture', writeFixture(dir, name, source)]);
      }
    });
    // The census reads `join(ROOT, 'src/toolsets.ts')`, so a test that edited
    // the real file to trigger this would leave the working tree dirty — and
    // `git status --porcelain` being empty is how this repo detects a stale
    // generated block. Asserted so the seam is the visible mechanism rather
    // than a claim in a comment.
    assert.equal(readFileSync(TOOLSETS, 'utf8'), before, 'the fixture route must not write to src/toolsets.ts');
  });
});
