/**
 * The census artifact CI installs, and the one it must never install (#1487).
 *
 * ## The defect
 *
 * `.github/workflows/ci.yml` captured the census with a shell redirect:
 *
 * ```yaml
 * run: node scripts/surface-census.mjs > .surface-census.json
 * ```
 *
 * A redirect truncates the target **before** the command runs, so a failed
 * census left an artifact behind. Three gates read that artifact and all three
 * carry `!cancelled()` (#1473), so all three read it anyway. Two different
 * second-order failures follow, and they are not the same string:
 *
 * | producer                                              | pre-fix artifact | what the reader reported |
 * |-------------------------------------------------------|------------------|--------------------------|
 * | fails before printing                                 | **0 bytes**      | `SyntaxError: Unexpected end of JSON input` |
 * | prints, then exits non-zero (`--check` drift, refusal)  | **valid JSON, not a census** | `TypeError: Cannot read properties of undefined (reading 'filter')` |
 *
 * The second row is the worse of the two and is the one the issue did not
 * record: an artifact that exists *and parses* is a plausible value for a
 * value that was never produced, so a reader gets past `JSON.parse` and dies
 * deeper in, on a field that is simply absent. It is AGENTS.md §6's class —
 * a value that could not be read, reported as something plausible.
 *
 * ## The contract these tests hold
 *
 * `--out` makes the writer hold the child's real exit status, so the
 * invariant is **the file exists if and only if the run succeeded**. There is
 * no path through it that leaves a file behind for a run that failed, in
 * either row of the table above.
 *
 * ## What is and is not covered
 *
 * The unit under test is the writer's decision, reached by driving the real
 * CLI as a subprocess — the same entry point, the same re-exec, the same exit
 * status propagation that `ci.yml` gets. The YAML step itself is not executed
 * here: there is no GitHub Actions runner in the suite, and a test that
 * asserted on the step's text would be asserting that a string is present, not
 * that the workflow behaves. What the workflow contributes is the choice of
 * `--out` over the redirect, and the negative cases below are what make that
 * choice load-bearing rather than cosmetic.
 *
 * The failure fixtures are the script's own documented `--*-fixture` routes,
 * the same ones `tests/arch-inventory.test.ts` drives to obtain a census that
 * exits non-zero. They are not the CI failure — no census in this tree fails
 * — and the test says so by asserting the exit status first, so a fixture that
 * stopped failing fails the test rather than passing it for the wrong reason.
 */
import './helpers/hermetic.js';

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { childExitCode, stderrTail } from './helpers/subprocess-outcome.js';
import type { RawChildResult } from './helpers/subprocess-outcome.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const CENSUS = join(ROOT, 'scripts', 'surface-census.mjs');

/** A name no other process in this repository writes, so its absence is evidence. */
const PROBE = 'census-1487-probe.json';

/**
 * Run the census and keep its status.
 *
 * The status *is* the thing under test, so it is never collapsed: a killed or
 * never-started child must not read as "the census rejected the input", which
 * is what `status ?? 1` would do. `childExitCode` names that case instead.
 */
function runCensus(args: readonly string[], cwd: string = ROOT): RawChildResult & { stdout: string; stderr: string } {
  try {
    const stdout = execFileSync(process.execPath, [CENSUS, ...args], {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      // The census is over 1.5 MB; the 1 MiB default would kill the child.
      maxBuffer: 32 * 1024 * 1024,
    });
    return { status: 0, stdout, stderr: '' };
  } catch (error) {
    const failure = error as RawChildResult;
    return { ...failure, stdout: failure.stdout ?? '', stderr: failure.stderr ?? '' };
  }
}

/** A scratch directory under `os.tmpdir()` (#1383), removed on the way out. */
function withScratch<T>(run: (dir: string) => T): T {
  const dir = mkdtempSync(join(tmpdir(), 'smcp-census-artifact-'));
  try {
    return run(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * A census that exits non-zero *after* printing a JSON body.
 *
 * `inspectGeneratedBlock` rejects a source with no marker pair and the route
 * prints `{ error }` on stdout before exiting 1. Pre-fix, that stdout became
 * `.surface-census.json`: a file that parses, and is not a census.
 */
function writeRejectedMarkerFixture(dir: string): string {
  const file = join(dir, 'rejected-marker.json');
  writeFileSync(file, JSON.stringify({
    source: 'no markers at all',
    file: 'README.md',
    name: 'surface-census',
    body: 'whatever',
  }));
  return file;
}

/** A census that exits non-zero *before* printing anything. */
function missingMarkerFixture(dir: string): string {
  return join(dir, 'no-such-fixture.json');
}

/** A census that exits 0 and prints one small JSON body. */
function writePassingDescriptionFixture(dir: string): string {
  const file = join(dir, 'passing-description.json');
  writeFileSync(file, JSON.stringify({
    source: '/** Registers the widget tools. Registers the widget tools. */',
    file: 'src/tools/fixture.ts',
  }));
  return file;
}

describe('#1487 the census artifact exists if and only if the census succeeded', () => {
  it('installs a census a real gate then accepts (#1487)', () => {
    withScratch((dir) => {
      const out = join(dir, '.surface-census.json');
      const produced = runCensus(['--out', out]);
      assert.equal(
        childExitCode(produced, 'a successful census run with --out'),
        0,
        `the producer must succeed on a clean tree.\nchild stderr:\n${stderrTail(produced.stderr)}`,
      );
      assert.ok(existsSync(out), '--out exited 0 without installing the artifact it was asked for');

      // Not a non-empty file — a *census*. An artifact that exists and does not
      // parse is the zero-byte case wearing a different name.
      const census = JSON.parse(readFileSync(out, 'utf8')) as { tools?: unknown; toolNames?: unknown };
      assert.equal(typeof census.tools, 'number', `--out installed something that is not a census: ${JSON.stringify(census).slice(0, 200)}`);
      assert.ok(Array.isArray(census.toolNames), 'the installed artifact carries no tool names');

      // The other half of the contract, on the real reader: the gate `ci.yml`
      // runs with `--census-file` must accept what the producer installed.
      const consumed = runCensus(['--check', '--no-prose', '--census-file', out]);
      assert.equal(
        childExitCode(consumed, 'the doc-counts gate over the installed census'),
        0,
        `the artifact --out installed is not one the reader accepts.\nchild stderr:\n${stderrTail(consumed.stderr)}`,
      );

      // The install is a rename, not a write: the temp file is not left behind.
      assert.deepEqual(readdirSync(dir), ['.surface-census.json'], 'a census artifact was left beside its temp file');
    });
  });

  it('leaves no artifact when the census fails after printing JSON (#1487)', () => {
    withScratch((dir) => {
      const fixture = writeRejectedMarkerFixture(dir);

      // The case shape, established observably: without `--out` this route
      // prints a JSON body and then exits non-zero, and that body is exactly
      // what the redirect used to install as `.surface-census.json`. Under
      // `--out` the same body is the artifact, held until the status is known,
      // so it is deliberately not on stdout — the child's stderr, which carries
      // every real diagnostic, is inherited and complete.
      const direct = runCensus(['--marker-fixture', fixture]);
      assert.notEqual(
        childExitCode(direct, 'a census over a rejected marker fixture'),
        0,
        'the fixture stopped being a failure, so the "--out" assertions below are no longer about a failed census',
      );
      assert.match(
        direct.stdout,
        /"error"/,
        'this case is specifically the one where the producer printed a JSON body before failing, '
        + 'and that body is the artifact the redirect would have written',
      );

      const out = join(dir, '.surface-census.json');
      const produced = runCensus(['--out', out, '--marker-fixture', fixture]);
      assert.notEqual(
        childExitCode(produced, 'a census over a rejected marker fixture'),
        0,
        'the fixture stopped being a failure, so the "no artifact" assertion below is no longer about a failed census',
      );
      assert.equal(existsSync(out), false, 'a census that exited non-zero left an artifact behind for the gates to read');
      assert.deepEqual(readdirSync(dir), ['rejected-marker.json'], 'a failed census left a temp or partial file behind');

      // The consumer's failure mode, which is the point of the whole change:
      // a missing file, not a file that parses into something else.
      assert.throws(
        () => readFileSync(out, 'utf8'),
        (error: unknown) => (error as { code?: string }).code === 'ENOENT',
        'a reader of the absent artifact must get ENOENT; anything else means a file was left behind',
      );
    });
  });

  it('leaves no artifact when the census fails before printing anything (#1487)', () => {
    withScratch((dir) => {
      const out = join(dir, '.surface-census.json');
      const produced = runCensus(['--out', out, '--marker-fixture', missingMarkerFixture(dir)]);

      assert.notEqual(
        childExitCode(produced, 'a census over a missing fixture'),
        0,
        'the fixture stopped being a failure, so the "no artifact" assertion below is no longer about a failed census',
      );
      assert.equal(produced.stdout, '', 'this case is specifically the one where the producer printed nothing');

      assert.equal(existsSync(out), false, 'a census that died before printing left an artifact behind');
      assert.deepEqual(readdirSync(dir), [], 'a census that died before printing left a file of any kind behind');
    });
  });

  it('names the missing artifact in the producer step, so the failure is legible where it happened (#1487)', () => {
    withScratch((dir) => {
      const out = join(dir, '.surface-census.json');
      const produced = runCensus(['--out', out, '--marker-fixture', writeRejectedMarkerFixture(dir)]);

      assert.notEqual(childExitCode(produced, 'a census over a rejected marker fixture'), 0, 'fixture must fail');
      assert.match(
        produced.stderr,
        new RegExp(`no census written to ${out.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`),
        'the producing step must say that it wrote no census, and where it would have written one — '
        + `otherwise the failure is legible only from the consumers' parse errors.\nchild stderr:\n${stderrTail(produced.stderr)}`,
      );
    });
  });

  it('resolves a relative --out against the caller, so the writer and the readers agree on one path (#1487)', () => {
    withScratch((dir) => {
      // `ci.yml` runs the producer and its three readers from the workspace
      // root, each naming `.surface-census.json`. If `--out` resolved anywhere
      // else the artifact would land in a directory no reader looks in — and a
      // missing file is exactly what a failed census now looks like, so the
      // two would be indistinguishable.
      const produced = runCensus(['--out', PROBE, '--description-fixture', writePassingDescriptionFixture(dir)], dir);
      assert.equal(
        childExitCode(produced, 'a census run from a scratch working directory'),
        0,
        `child stderr:\n${stderrTail(produced.stderr)}`,
      );
      assert.ok(existsSync(join(dir, PROBE)), `--out did not resolve against the caller's working directory: ${stderrTail(produced.stderr)}`);
      assert.equal(
        existsSync(join(ROOT, PROBE)),
        false,
        `--out wrote ${PROBE} into the repository root instead of the caller's working directory, `
        + 'which would leave an untracked entry in the repository (#1383) and put the artifact where no reader looks',
      );
    });
  });

  it('refuses --out with no path rather than writing to nothing (#1487)', () => {
    withScratch((dir) => {
      for (const args of [['--out'], ['--out', '--check']]) {
        const produced = runCensus(args, dir);
        assert.notEqual(
          childExitCode(produced, `a census run with ${args.join(' ')}`),
          0,
          'a valueless --out was accepted, so a typo silently produces no artifact at all',
        );
        assert.match(produced.stderr, /--out requires a path/, `child stderr:\n${stderrTail(produced.stderr)}`);
      }
      // `--out --check` must not become a file named `--check`, which is both
      // the #1383 untracked-entry hazard and a silent loss of the flag the
      // author meant to pass.
      assert.deepEqual(readdirSync(dir), [], 'a rejected --out still wrote something into the working directory');
    });
  });
});
