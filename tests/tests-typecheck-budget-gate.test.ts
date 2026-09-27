/**
 * Test-tree typecheck budget gate (#1408).
 *
 * `tsconfig.json` includes only `src`, so the `tsc --noEmit` CI runs has never
 * seen a test file, and `tsx` strips types instead of checking them. A test
 * that named a type which did not exist, called a generic with a type argument
 * its receiver did not accept, or referenced a variable out of scope all ran
 * and passed. Every one of those shipped. This is the gate that makes the
 * class visible, and the count is baselined rather than zero.
 *
 * A budget gate has a specific failure mode worth naming: it is easy to write
 * one that always passes. If it trusts a precomputed verdict, or compares the
 * measurement against itself, or swallows a failed `tsc` as "no errors", then
 * it reports a number forever and defends nothing — and this repository has
 * already shipped two tests that could not fail (#637's budget gate trusted an
 * injected `withinBudget` flag; a later assertion recomputed its expected value
 * from the census fields it was checking). So the assertions below are shaped
 * around the same rule: drive the real code, and prove the failure path fires.
 *
 * The two halves that matter:
 *
 *  1. The real tree is within its budget — asserted against a measurement the
 *     gate itself takes from a live `tsc`, not from a stored constant.
 *  2. The gate FIRES. Driven by lowering the baseline beneath reality, by
 *     introducing a real type error in a scratch project, and by handing the
 *     CLI a project it cannot read. If any of those returned 0, the gate
 *     would be decoration and everything in (1) would be worthless.
 */

import './helpers/hermetic.js';

import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

import { parseDiagnostics } from '../scripts/check-tests-typecheck.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const GATE = join(ROOT, 'scripts', 'check-tests-typecheck.mjs');
const BASELINE = join(ROOT, 'tsconfig.tests-baseline.json');
const PROJECT = join(ROOT, 'tsconfig.tests.json');

/** Run the real CLI. Returns the exit code and both streams; never throws. */
function runGate(args: string[] = []) {
  try {
    const stdout = execFileSync(process.execPath, [GATE, ...args], {
      encoding: 'utf8',
      cwd: ROOT,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { code: 0, stdout, stderr: '' };
  } catch (err) {
    const e = err as { status: number | null; stdout: string; stderr: string };
    return { code: e.status ?? -1, stdout: e.stdout ?? '', stderr: e.stderr ?? '' };
  }
}

/**
 * One measurement of the real project, shared by the assertions that need it.
 *
 * A full `tsc` pass over `src` + `tests` is ~12s, and the CLI shells out to one
 * per invocation. Taking it twice for two assertions that ask the same question
 * of the same tree doubles the cost of this file for no extra evidence, so it
 * is taken once and both assertions read it.
 */
let realTree: { total: number; byFile: Map<string, number> } | undefined;
function measureRealTree() {
  if (realTree) return realTree;
  // `tsc` exits 1 when it reports type errors, which is the expected case here,
  // so this cannot be execFileSync — that throws and discards the output.
  const run = spawnSync(
    process.execPath,
    [join(ROOT, 'node_modules', 'typescript', 'bin', 'tsc'), '--noEmit', '--pretty', 'false', '-p', PROJECT],
    { encoding: 'utf8', cwd: ROOT },
  );
  assert.equal(run.status, 1, `expected tsc to report type errors, got status ${run.status}`);
  realTree = parseDiagnostics(run.stdout);
  return realTree!;
}

describe('#1408 — the tests/ typecheck budget holds the real tree', () => {
  it('the baseline is a real measurement of the real project, not a guess', () => {
    const baseline = JSON.parse(readFileSync(BASELINE, 'utf8'));
    assert.equal(
      typeof baseline.total,
      'number',
      'the baseline has no total, so there is nothing to compare against',
    );
    assert.ok(baseline.total > 0, 'a baseline of 0 means the gate is not measuring anything');
    assert.ok(
      Object.keys(baseline.byFile).length > 0,
      'the baseline lists no files, so a new broken file would not be caught',
    );
    // Every baselined file must be under tests/ — this project covers the test
    // tree. A baseline entry elsewhere would mean the gate had been pointed at
    // something else.
    const outside = Object.keys(baseline.byFile).filter((file) => !file.startsWith('tests/'));
    assert.deepEqual(outside, [], `the baseline covers files outside tests/: ${outside.join(', ')}`);
  });

  it('exits zero on the real tree, because the real tree is within budget', () => {
    const { code, stdout, stderr } = runGate();
    assert.equal(code, 0, `the gate failed on the tree it is supposed to accept:\n${stdout}${stderr}`);
    assert.match(stdout, /tests\/ typecheck within budget/);
  });

  it('the count it reports is the number of diagnostics tsc actually printed', () => {
    // Guards the reporting line against becoming a constant. The gate's own
    // parser is exercised against real tsc output, and the total it derives
    // must equal what the diagnostic lines contain.
    const { stdout } = runGate();
    const reported = Number(/within budget: (\d+) error\(s\)/.exec(stdout)?.[1]);
    assert.ok(Number.isInteger(reported), `could not read a count from: ${stdout}`);

    const measured = measureRealTree();
    assert.ok(measured.total > 0, 'tsc emitted no diagnostics, so this proves nothing');
    assert.equal(
      reported,
      measured.total,
      'the gate printed a count that does not match the diagnostics tsc emitted',
    );
  });
});

describe('#1408 — the gate fails when the count goes up', () => {
  // A gate that only ever passes proves nothing. These drive the real CLI
  // through its failure paths, and each asserts a NON-ZERO exit.
  let dir: string;
  const BASELINE_BACKUP = join(tmpdir(), `tsc-baseline-backup-${process.pid}.json`);

  before(() => {
    dir = mkdtempSync(join(tmpdir(), 'typecheck-budget-'));
    writeFileSync(BASELINE_BACKUP, readFileSync(BASELINE, 'utf8'));
  });

  after(() => {
    // Always restore, even if an assertion above threw: a gate test that
    // leaves a doctored baseline behind turns the next run red for a reason
    // that has nothing to do with the change under test.
    writeFileSync(BASELINE, readFileSync(BASELINE_BACKUP, 'utf8'));
    rmSync(BASELINE_BACKUP, { force: true });
    rmSync(dir, { recursive: true, force: true });
  });

  /**
   * A two-file scratch project: one file carrying exactly one type error, one
   * clean. Measuring this instead of the real tree costs milliseconds rather
   * than the ~12s a full `src` + `tests` pass costs, and it lets these tests
   * state the exact error count they are reasoning about instead of a number
   * that drifts every time an unrelated test file is fixed.
   */
  function writeProbe(name: string, files: Record<string, string>): string {
    const probeDir = join(dir, name);
    mkdirSync(probeDir, { recursive: true });
    const project = join(probeDir, 'tsconfig.json');
    writeFileSync(
      project,
      JSON.stringify({
        compilerOptions: { noEmit: true, strict: true, types: [], rootDir: '.', target: 'ES2022' },
        include: ['*.ts'],
      }),
    );
    for (const [file, source] of Object.entries(files)) writeFileSync(join(probeDir, file), source);
    return project;
  }

  /** Point the baseline at a scratch project's measurement, then re-arm it. */
  function withBaseline(total: number, byFile: Record<string, number>) {
    writeFileSync(BASELINE, JSON.stringify({ total, byFile }, null, 2));
  }

  /**
   * The key `tsc` reports a probe file under.
   *
   * The probe project lives outside the repo, so tsc prints its path relative
   * to the CWD the gate runs in — `../../.tmp/…/bad.ts`, not `bad.ts`. The
   * baseline has to be keyed the same way or the "not in the baseline" rule
   * fires instead of the per-file rule under test, and the test would pass for
   * the wrong reason.
   */
  function probeKey(name: string): string {
    return relative(ROOT, join(dir, name, 'bad.ts'));
  }

  it('exits non-zero and names the file when the baseline is one below reality', () => {
    // The probe measures 1 error in `bad.ts`; the baseline claims 0. Both the
    // total and the per-file entry are set below what was measured, so this
    // is a genuine regression rather than a new-file case.
    const project = writeProbe('one-below', { 'bad.ts': 'export const n: number = "s";\n' });
    const key = probeKey('one-below');
    withBaseline(0, { [key]: 0 });

    const { code, stderr } = runGate(['--project', project]);
    assert.notEqual(code, 0, 'the gate returned success on a tree above its own baseline');
    assert.match(stderr, /budget exceeded/);
    assert.ok(stderr.includes(key), `the failure must name the regressing file:\n${stderr}`);
    assert.match(stderr, /baseline allows 0/);
  });

  it('exits non-zero on a type error in a NEW file, which the baseline cannot allow', () => {
    // The half a total-count comparison would miss: a brand-new test file
    // carrying its own errors. The per-file map has no entry for it, so this
    // is caught by the "not in the baseline" rule rather than by arithmetic.
    // The total is set to match what the probe measures, so the total rule
    // cannot be what fires.
    const project = writeProbe('new-file', { 'broken.ts': 'export const n: number = "s";\n' });
    withBaseline(1, {});

    const { code, stderr } = runGate(['--project', project]);
    assert.notEqual(code, 0, 'the gate accepted a project with a type error in a new file');
    assert.match(stderr, /not in the baseline/);
    assert.match(stderr, /broken\.ts/);
    assert.doesNotMatch(stderr, /^- total:/m, 'the total is unchanged here, so only the per-file rule should fire');
  });

  it('measures that same probe project when it is CLEAN, so the rule above is not trivially red', () => {
    // The negative case for the test above. A rule that fires on every input
    // is not a rule; without this, "exits non-zero" could be satisfied by the
    // gate failing for any reason at all.
    const project = writeProbe('clean', { 'ok.ts': 'export const n: number = 1;\n' });
    withBaseline(0, {});

    const { code, stdout, stderr } = runGate(['--project', project]);
    // A clean project measures 0 errors, at its baseline, so the gate passes —
    // proving the per-file rule keys on the error, not on the file simply
    // being unfamiliar to the baseline.
    assert.equal(code, 0, `the gate rejected a clean project:\n${stdout}${stderr}`);
    assert.match(stdout, /tests\/ typecheck within budget: 0 error\(s\)/);
  });

  it('exits non-zero when a type error is ADDED to an existing baselined file', () => {
    // The regression the budget exists to catch: an existing file already
    // carrying N errors now carries N+1. The total is left correct here, so
    // ONLY the per-file rule can catch it — a total-only comparison would
    // pass this, and the file would be named by neither.
    const project = writeProbe('grew', { 'bad.ts': 'export const n: number = "s";\n' });
    const key = probeKey('grew');
    withBaseline(1, { [key]: 0 });

    const { code, stderr } = runGate(['--project', project]);
    assert.notEqual(code, 0, 'the gate accepted a file with more errors than its baseline allows');
    assert.ok(
      stderr.includes(`${key}: 1 error(s), baseline allows 0`),
      `the per-file rule must fire by name, not the "not in the baseline" rule:\n${stderr}`,
    );
    assert.doesNotMatch(stderr, /^- total:/m, 'the total is unchanged here, so only the per-file rule should fire');
  });

  it('exits non-zero rather than passing when the project cannot be read', () => {
    // Fail-closed. A budget gate handed a config it cannot parse has not
    // measured anything, and reporting that as "within budget" is precisely
    // the defect this gate exists to prevent.
    const { code, stderr } = runGate(['--project', join(dir, 'does-not-exist.json')]);
    assert.notEqual(code, 0, 'the gate passed on a project it could not read');
    assert.ok(stderr.length > 0, 'a failed measurement must say so, not exit quietly');
  });
});

describe('#1408 — the diagnostic parser reads real tsc output', () => {
  it('counts one diagnostic per file(line,col) line', () => {
    const output = [
      "tests/a.test.ts(1,2): error TS2345: Argument of type 'string'.",
      "tests/b.test.ts(3,4): error TS2339: Property 'x' does not exist.",
    ].join('\n');
    const parsed = parseDiagnostics(output);
    assert.equal(parsed.total, 2);
    assert.deepEqual([...parsed.byFile].sort(), [['tests/a.test.ts', 1], ['tests/b.test.ts', 1]]);
  });

  it('does not double-count the continuation lines of a multi-line diagnostic', () => {
    // TS2339 prints a follow-up "  Property 'x' does not exist on type …"
    // line. Counting that as a second error would inflate the total and make
    // the budget drift upward on its own.
    const output = [
      "tests/a.test.ts(1,2): error TS2339: Property 'Authorization' does not exist.",
      "  Property 'Authorization' does not exist on type 'HeadersInit'.",
    ].join('\n');
    assert.equal(parseDiagnostics(output).total, 1, 'a continuation line was counted as its own error');
  });

  it('ignores a line that is not a diagnostic', () => {
    assert.equal(parseDiagnostics('Found 3 errors in 2 files.').total, 0);
    assert.equal(parseDiagnostics('').total, 0);
  });

  it('the continuation-line rule is the one real tsc output needs', () => {
    // Asserted against a genuine multi-line diagnostic taken from this tree's
    // own output, so the rule is anchored to the shape tsc actually emits
    // rather than to a shape invented here.
    const sample = [
      "tests/auth.tokenpath.test.ts(248,29): error TS2339: Property 'Authorization' does not exist on type 'HeadersInit'.",
      "  Property 'Authorization' does not exist on type '[string, string][]'.",
    ].join('\n');
    const parsed = parseDiagnostics(sample);
    assert.equal(parsed.total, 1);
    assert.equal(parsed.byFile.get('tests/auth.tokenpath.test.ts'), 1);
  });
});
