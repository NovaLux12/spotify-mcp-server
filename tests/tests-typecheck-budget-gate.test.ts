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
 * The three halves that matter:
 *
 *  1. The real tree is within its budget — asserted against a measurement the
 *     gate itself takes from a live `tsc`, not from a stored constant.
 *  2. The gate FIRES when the count goes UP — driven by lowering the baseline
 *     beneath reality, by introducing a real type error in a scratch project,
 *     and by handing the CLI a project it cannot read.
 *  3. The gate fires when the count goes DOWN (#1478) — a baseline entry the
 *     tree has outgrown, in both the zero case the issue measured and the
 *     partially-improved case. This is the direction the gate did not have,
 *     and it is the one that let 5 errors of unclaimable "slack" accumulate
 *     while the gate reported a comfortable pass.
 *
 * If any of those returned 0, the gate would be decoration and everything
 * else would be worthless.
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

/**
 * One run of the real gate against the real tree, shared by the assertions
 * that read the same verdict.
 *
 * A full pass costs ~13s and the CLI takes one per invocation, so the two
 * assertions below used to pay for it twice. They ask one question of one run
 * — did it pass, and what count did it print — so there is no second run to
 * justify.
 */
let realGateRun: { code: number; stdout: string; stderr: string } | undefined;
function runGateOnRealTree() {
  if (!realGateRun) realGateRun = runGate();
  return realGateRun;
}

// Scratch-project fixtures, shared by every describe that drives the real CLI
// through a failure path. File-level `before`/`after` rather than per-describe:
// node:test runs sibling describes concurrently, so a per-describe tmpdir would
// be a second set of shared mutable state to reason about for no benefit.
let dir: string;

before(() => {
  dir = mkdtempSync(join(tmpdir(), 'typecheck-budget-'));
});

after(() => rmSync(dir, { recursive: true, force: true }));

/**
 * A two-file scratch project: one file carrying exactly one type error, one
 * clean. Measuring this instead of the real tree costs milliseconds rather
 * than the ~13s a full `src` + `tests` pass costs, and it lets these tests
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

/**
 * Write a baseline for a scratch project into the scratch directory, and
 * return the `--baseline` flag that points the gate at it.
 *
 * Deliberately NOT the checked-in `tsconfig.tests-baseline.json`. node:test
 * runs sibling describes concurrently, so an earlier version of this file
 * that doctored the real baseline to prove the gate fires raced the
 * "the real tree is accepted" describe, which then read whichever write
 * landed last and failed on a baseline of 0. Sharing mutable state between
 * concurrently-running tests is the defect, not the restore hook that papered
 * over it — the `--baseline` flag removes the sharing entirely, and the `name`
 * keeps two concurrently-running tests off each other's file as well.
 */
function withBaseline(name: string, total: number, byFile: Record<string, number>) {
  const path = join(dir, `${name}.baseline.json`);
  writeFileSync(path, JSON.stringify({ total, byFile }, null, 2));
  return ['--baseline', path];
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
function probeKey(name: string, file = 'bad.ts'): string {
  return relative(ROOT, join(dir, name, file));
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
    const { code, stdout, stderr } = runGateOnRealTree();
    assert.equal(code, 0, `the gate failed on the tree it is supposed to accept:\n${stdout}${stderr}`);
    assert.match(stdout, /tests\/ typecheck within budget/);
  });

  it('the count it reports is the number of diagnostics tsc actually printed', () => {
    // Guards the reporting line against becoming a constant. The gate's own
    // parser is exercised against real tsc output, and the total it derives
    // must equal what the diagnostic lines contain.
    const { stdout } = runGateOnRealTree();
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

  it('the checked-in baseline IS the measurement, entry for entry (#1478)', () => {
    // The assertion #1478 asked for, stated independently of the gate: the
    // checked-in file is compared against a live `tsc` run, not against what
    // the gate decided to print. Two documents that must agree are compared;
    // each is not merely validated on its own.
    //
    // On the tree this landed on, the baseline claimed 651 across 114 files
    // while `tsc` emitted 636 across 111: three entries for files that had
    // been fixed some time earlier, plus one entry still carrying ten errors
    // its file had already paid off. Reading the baseline alone showed nothing
    // wrong with it; only the two side by side did. (651 - 636 = 15 = 5 + 10.)
    const baseline = JSON.parse(readFileSync(BASELINE, 'utf8'));
    const measured = measureRealTree();

    assert.equal(
      baseline.total,
      measured.total,
      `the baseline claims ${baseline.total} errors and the tree carries ${measured.total}; the difference is slack nobody can spend`,
    );
    assert.deepEqual(
      [...measured.byFile.keys()].sort(),
      Object.keys(baseline.byFile).sort(),
      'the baseline and the tree disagree about WHICH files carry errors — one list is stale, in one direction or the other',
    );
    for (const [file, count] of measured.byFile) {
      assert.equal(
        baseline.byFile[file],
        count,
        `${file}: the baseline allows ${baseline.byFile[file]} and the tree carries ${count}`,
      );
    }
  });
});

describe('#1408 — the gate fails when the count goes up', () => {
  // A gate that only ever passes proves nothing. These drive the real CLI
  // through its failure paths, and each asserts a NON-ZERO exit.

  it('exits non-zero and names the file when the baseline is one below reality', () => {
    // The probe measures 1 error in `bad.ts`; the baseline claims 0. Both the
    // total and the per-file entry are set below what was measured, so this
    // is a genuine regression rather than a new-file case.
    const project = writeProbe('one-below', { 'bad.ts': 'export const n: number = "s";\n' });
    const key = probeKey('one-below');
    const args = ['--project', project, ...withBaseline('one-below', 0, { [key]: 0 })];

    const { code, stderr } = runGate(args);
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
    const args = ['--project', project, ...withBaseline('new-file', 1, {})];

    const { code, stderr } = runGate(args);
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
    const args = ['--project', project, ...withBaseline('clean', 0, {})];

    const { code, stdout, stderr } = runGate(args);
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
    const args = ['--project', project, ...withBaseline('grew', 1, { [key]: 0 })];

    const { code, stderr } = runGate(args);
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
    const { code, stderr } = runGate([
      '--project',
      join(dir, 'does-not-exist.json'),
      ...withBaseline('unreadable', 0, {}),
    ]);
    assert.notEqual(code, 0, 'the gate passed on a project it could not read');
    assert.ok(stderr.length > 0, 'a failed measurement must say so, not exit quietly');
  });
});

describe('#1478 — the baseline is a measurement, not a one-way ceiling', () => {
  // #1478: the comparison failed only when the count went UP, so an allowance
  // outlived the errors it allowed. On `main` that was three entries totalling
  // 5 errors for files that typechecked clean — the exact "5 to give back"
  // the gate printed, while staying rc=0.
  //
  // The design decision these tests pin is the WIDE one: the baseline has to
  // describe this tree, so drift in either direction is a failure. The narrow
  // alternative — fail only on entries that have reached zero — reclaims those
  // 5 errors and leaves every partially-improved file's slack exactly where it
  // was. The "improved but not clean" test below is the one that separates
  // them, and it is here so that narrowing the rule later is a deliberate act
  // against a test that says so, rather than a quiet simplification.

  it('exits non-zero when a baselined file now typechecks CLEAN', () => {
    // The case #1478 measured. The probe is clean, so the baseline's one-error
    // allowance for it is slack nothing can spend, and the gate used to call
    // that a pass.
    const project = writeProbe('fixed', { 'ok.ts': 'export const n: number = 1;\n' });
    const key = probeKey('fixed', 'ok.ts');
    const args = ['--project', project, ...withBaseline('fixed', 1, { [key]: 1 })];

    const { code, stderr } = runGate(args);
    assert.notEqual(code, 0, 'the gate passed on a baseline that still allows an error the file no longer has');
    assert.match(stderr, /baseline is stale/);
    assert.ok(stderr.includes(key), `the failure must name the file whose allowance is dead:\n${stderr}`);
    assert.match(stderr, /the tree measures 0/);
  });

  it('exits non-zero when a file improved but is NOT yet clean', () => {
    // The test that decides the design. A gate that fails only on entries that
    // reached zero passes this — and then reports a 3-error ceiling as a
    // current measurement when the file carries 1, which is the same defect
    // #1478 reports with a smaller number in it.
    const project = writeProbe('improved', { 'bad.ts': 'export const n: number = "s";\n' });
    const key = probeKey('improved');
    const args = ['--project', project, ...withBaseline('improved', 3, { [key]: 3 })];

    const { code, stderr } = runGate(args);
    assert.notEqual(code, 0, 'the gate accepted a baseline that overstates this tree by two errors');
    assert.match(stderr, /baseline is stale/);
    assert.ok(
      stderr.includes(`${key}: tree measures 1, baseline allows 3`),
      `the stale entry must be named with both figures:\n${stderr}`,
    );
  });

  it('exits non-zero when a ceiling names a file the tree no longer measures', () => {
    // The same condition seen from the other side: an entry with no measured
    // errors at all. The file may be fixed, deleted, or gone from the project
    // — the gate cannot tell those apart and does not claim to, so it reports
    // the state that is common to all three.
    const project = writeProbe('vanished', { 'ok.ts': 'export const n: number = 1;\n' });
    const key = probeKey('vanished', 'ok.ts');
    const args = ['--project', project, ...withBaseline('vanished', 2, { [key]: 1, 'deleted.ts': 1 })];

    const { code, stderr } = runGate(args);
    assert.notEqual(code, 0, 'the gate passed on a baseline that allows errors in a file that measures none');
    assert.ok(
      stderr.includes('deleted.ts'),
      `the dead ceiling must be named, not just counted:\n${stderr}`,
    );
    assert.match(stderr, /fixed, deleted, or no longer part of the project/);
  });

  it('accepts a baseline that matches the tree exactly, so the rules above are not trivially red', () => {
    // The negative control for the two above. Both of those would be
    // satisfied by a gate that fails for any reason at all; this is the input
    // the same rules must let through, with a real type error present and the
    // ceiling matching it.
    const project = writeProbe('exact', { 'bad.ts': 'export const n: number = "s";\n' });
    const key = probeKey('exact');
    const args = ['--project', project, ...withBaseline('exact', 1, { [key]: 1 })];

    const { code, stdout, stderr } = runGate(args);
    assert.equal(code, 0, `the gate rejected an exact match:\n${stdout}${stderr}`);
    assert.match(stdout, /the baseline is a current measurement/);
  });

  it('--write reclaims a stale entry, and the re-baselined tree is then accepted', () => {
    // The legitimate path. A ratchet that can only be tightened by hand is a
    // ratchet people route around, so the fix has to be a real round trip
    // through the real CLI: refused, written, then accepted.
    const project = writeProbe('roundtrip', { 'ok.ts': 'export const n: number = 1;\n' });
    const key = probeKey('roundtrip', 'ok.ts');
    const baseline = withBaseline('roundtrip', 3, { [key]: 3 });

    const before = runGate(['--project', project, ...baseline]);
    assert.notEqual(before.code, 0, 'precondition: the stale baseline is rejected');

    const written = runGate(['--project', project, ...baseline, '--write']);
    assert.equal(written.code, 0, `--write refused a write that only lowers the budget:\n${written.stderr}`);

    const after = JSON.parse(readFileSync(baseline[1], 'utf8'));
    // `widened` is read BEFORE the deepEqual, and that order is load-bearing:
    // assert/deepEqual narrows its actual argument to the expected shape, and
    // that shape has no `widened` key to read afterwards.
    assert.equal(after.widened, undefined, 'a write that only lowers must not record a widening');
    assert.deepEqual(after, { total: 0, byFile: {} }, '`--write` did not reclaim the stale entry');

    const checked = runGate(['--project', project, ...baseline]);
    assert.equal(checked.code, 0, `the re-baselined tree is still rejected:\n${checked.stdout}${checked.stderr}`);
  });

  it('--write REFUSES to widen the budget, and does not touch the file when it does', () => {
    // Without this, `--write` is a one-command escape from the budget it
    // maintains: a PR that added three type errors could raise the ceiling
    // without ever saying so, and the gate that exists to stop the count
    // growing would have helped it along.
    const project = writeProbe('widen', { 'bad.ts': 'export const n: number = "s";\n' });
    const key = probeKey('widen');
    const baseline = withBaseline('widen', 0, {});
    const before = readFileSync(baseline[1], 'utf8');

    const { code, stderr } = runGate(['--project', project, ...baseline, '--write']);
    assert.notEqual(code, 0, '`--write` silently raised the budget');
    assert.match(stderr, /Refusing to write a baseline that WIDENS/);
    assert.match(stderr, /--allow-increase/, 'the refusal must name the way through, or it is a dead end');
    assert.equal(readFileSync(baseline[1], 'utf8'), before, 'a refused write still modified the baseline');
  });

  it('--write with --allow-increase raises a PER-FILE ceiling only with a recorded reason', () => {
    // The total can hold still while an individual ceiling rises: a file
    // improves by one and a new broken file appears carrying exactly what it
    // gave back. The headline figure never moves, so a guard that only watched
    // the total would wave this through — and the new file's ceiling is
    // exactly the kind of allowance #1478 is about.
    const project = writeProbe('swap', {
      'a.ts': 'export const n: number = "s";\n',
      'b.ts': 'export const n: number = "s";\n',
    });
    const keyA = probeKey('swap', 'a.ts');
    const keyB = probeKey('swap', 'b.ts');
    const baseline = withBaseline('swap', 2, { [keyA]: 2 });

    const { code, stderr } = runGate(['--project', project, ...baseline, '--write']);
    assert.notEqual(code, 0, '`--write` raised a per-file ceiling while the total held still');
    assert.match(stderr, /Refusing to write a baseline that WIDENS/);
    assert.ok(stderr.includes(keyB), `the refusal must name the ceiling it refused to raise:\n${stderr}`);
    assert.doesNotMatch(stderr, /total:/, 'the total did not move here — the refusal is about the per-file ceiling');
  });
});

describe('#1478 — the widening escape hatch is recorded, not silent', () => {
  it('--write with --allow-increase raises the budget and records the reason', () => {
    const project = writeProbe('allow', { 'bad.ts': 'export const n: number = "s";\n' });
    const key = probeKey('allow');
    const baseline = withBaseline('allow', 0, {});
    const reason = 'rebased onto main, which landed 1 new error in tests/foo.test.ts';

    const { code, stderr } = runGate(['--project', project, ...baseline, '--write', '--allow-increase', reason]);
    assert.equal(code, 0, `--allow-increase did not let a deliberate widening through:\n${stderr}`);

    const after = JSON.parse(readFileSync(baseline[1], 'utf8'));
    assert.equal(after.total, 1);
    assert.equal(after.byFile[key], 1);
    assert.equal(after.widened.reason, reason, 'the reason for widening was not recorded in the baseline');
    assert.equal(after.widened.totalFrom, 0);
    assert.equal(after.widened.totalTo, 1);
    assert.match(after.widened.date, /^\d{4}-\d{2}-\d{2}$/, 'the widening is not dated');
  });

  it('rejects --allow-increase on its own, because a flag that does nothing is not a flag', () => {
    // It returns before `tsc` runs, so this is the one assertion here that
    // costs no measurement at all.
    const { code, stderr } = runGate(['--allow-increase', 'because I said so']);
    assert.notEqual(code, 0, '--allow-increase was accepted without --write, so it read as an authorised widening');
    assert.match(stderr, /only means something with --write/);
  });

  it('drops a recorded widening on the next write that does not widen', () => {
    // The record describes the act that produced THIS baseline. Once a later
    // write holds or lowers the count, the file it describes is not the file on
    // disk, and a stale justification in a budget file is worse than none.
    const project = writeProbe('unwiden', { 'ok.ts': 'export const n: number = 1;\n' });
    const baseline = withBaseline('unwiden', 0, {});
    const widened = runGate([
      '--project',
      writeProbe('unwiden-bad', { 'bad.ts': 'export const n: number = "s";\n' }),
      ...baseline,
      '--write',
      '--allow-increase',
      'first write',
    ]);
    assert.equal(widened.code, 0, `precondition: the widening write was refused\n${widened.stderr}`);
    assert.equal(JSON.parse(readFileSync(baseline[1], 'utf8')).widened.reason, 'first write');

    const second = runGate(['--project', project, ...baseline, '--write']);
    assert.equal(second.code, 0, `the lowering write was refused\n${second.stderr}`);
    const after = JSON.parse(readFileSync(baseline[1], 'utf8'));
    assert.deepEqual(after, { total: 0, byFile: {} }, 'a stale widening record survived a write that did not widen');
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
