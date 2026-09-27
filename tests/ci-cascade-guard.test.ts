/**
 * #1473 — the surface-census step was unguarded, so an unrelated red above it
 * cascaded into a misleading `ENOENT` below it.
 *
 * ## The run this came from
 *
 * `main` was red on run `36313342863` for a reason that had nothing to do with
 * documentation. `Test-tree typecheck budget` failed (#1408), and because
 * `Generate finalized surface census` carried no `if:`, GitHub Actions skipped
 * it — so `.surface-census.json` was never written. `Check documented tool
 * names` below it *did* carry `if: ${{ !cancelled() }}`, so it kept running
 * against the file the skipped step was supposed to produce, and reported:
 *
 * ```
 * Error: ENOENT: no such file or directory,
 *   open '/…/spotify-mcp-server/.surface-census.json'
 *     at file:///…/scripts/check-doc-tool-names.mjs:18:5
 * ```
 *
 * The two real problems with that run are that the message names a
 * documentation regression that is not there, and that the actual cause sits
 * nine steps above it. A red that reports its own cause is cheap; a red that
 * reports `ENOENT` costs an investigation every time it happens.
 *
 * Worth being precise about the shape, because the issue this came from calls
 * it "two misleading ENOENTs" and the run reports one. The census step and
 * `Check generated documentation inventory` were both *skipped* — a third
 * failure mode, and a quieter one, because a skipped gate says nothing at all.
 * `Check documented tool names` is the one that was guarded, and it is the one
 * that died on `ENOENT`. The fix is the same either way; the count is not.
 *
 * ## Why this file does not name the two steps
 *
 * #1462 fixed this same bug class for the tag-fetch step, and its test asserts
 * two steps *by name*. That is the right test for that issue and the wrong
 * shape for this one: a named list is a snapshot, so the next step to lose its
 * guard joins a queue nobody is watching. Every rule below is derived from the
 * workflow instead — from which steps exist, from which files they write, and
 * from what GitHub Actions does with a step that has no `if:`.
 *
 * Three rules, each catching a distinct shape:
 *
 * 1. **No running step reads a file no running step writes.** This is the
 *    cascade itself, expressed operationally: the step conclusions are
 *    *simulated* for every possible single failure point, and the file
 *    dependency graph is checked against the result. It fires on any
 *    producer/consumer pair, in any order, whether or not anyone named them.
 * 2. **Every step from the first guard onward carries a guard.** Once a job has
 *    declared "a failure above must not silence the gates below", a step that
 *    drops out of that run is a gate that silently stops reporting. This is
 *    what catches an unguarded step that is *not* part of a file chain — the
 *    case rule 1 structurally cannot see.
 * 3. **A producer and every step that reads its output agree about the guard.**
 *    The invariant a maintainer reasons in, and the one that survives the
 *    chain being moved above the first guard, where rule 2 no longer reaches.
 *
 * ## The simulation is checked against a real run, not against my reading
 *
 * `simulate()` encodes one rule from the GitHub Actions docs: a step with no
 * `if:` runs only if every earlier step succeeded, and `!cancelled()` opts out
 * of that. Fed the `36313342863` step list with `Test-tree typecheck budget`
 * as the failure, it reproduces that run's conclusions step for step — the
 * four gates between the failure and the tag fetch skipped, the census step
 * and `Check generated documentation inventory` skipped, and
 * `Check documented tool names`, `Registry schema conformance gate` and the
 * test step all running past the failure. The mutation tests below then show
 * the same predicate rejecting a workflow that has had a guard taken out.
 *
 * ## The rules do not claim more than they check
 *
 * Rule 1's file graph is built from paths a step *names in its `run:`*. That
 * is a declared dependency, not an inferred one: `Install dependencies` really
 * is a prerequisite of the census step, but `npm ci` never mentions
 * `node_modules`, so no rule here claims a guard on it — and adding one would
 * be wrong, because `npm ci` failing is already loud and guarding it would
 * trade two misleading failures for ten. The limit is stated so a future
 * reader does not mistake silence for a clean bill of health.
 */
import './helpers/hermetic.js';

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const WORKFLOW_PATH = join(ROOT, '.github/workflows/ci.yml');

/** The job these steps live in. #1473's body calls it `check`; it is `test`. */
const JOB = 'test';

interface WorkflowStep {
  /** The step's `name:`, or its `uses:` when it has no name. */
  name: string;
  /** Whether the step carries a condition that keeps it running after a failure above. */
  guarded: boolean;
  /** The step's `run:` script, with a block scalar unwrapped. */
  script: string;
}

const workflow = (): string => readFileSync(WORKFLOW_PATH, 'utf8');

// ---------------------------------------------------------------------------
// Reading the workflow
//
// There is no YAML parser in this repository's dependency tree (`js-yaml` and
// `yaml` are both absent), and adding one to read two fields of a file CI
// already executes is not a trade worth making. So this reads the job's step
// list directly, and `parseSteps` is pinned by a precondition suite below — a
// parser that silently returned nothing would make every rule vacuously true,
// which is the failure mode §6 of AGENTS.md is about.
// ---------------------------------------------------------------------------

/** A step begins at a `- ` entry indented six spaces; its block ends at the next. */
function parseSteps(source: string, job: string): WorkflowStep[] {
  const lines = source.split('\n');

  const jobStart = lines.findIndex((line) => line === `  ${job}:`);
  assert.notEqual(jobStart, -1, `precondition: ci.yml has no job named ${JSON.stringify(job)}`);

  const stepsKey = lines.findIndex((line, i) => i > jobStart && line === '    steps:');
  assert.notEqual(stepsKey, -1, `precondition: ci.yml job ${JSON.stringify(job)} has no steps`);

  // The job's body ends at the next key indented less than four spaces, so this
  // stays correct if a second job is ever appended below this one.
  const rest = lines.slice(stepsKey + 1);
  const jobEnd = rest.findIndex((line) => /^ {0,3}\S/.test(line));
  const body = jobEnd === -1 ? rest : rest.slice(0, jobEnd);

  const starts: number[] = [];
  body.forEach((line, i) => {
    if (/^ {6}- /.test(line)) starts.push(i);
  });

  return starts.map((start, i) => {
    const block = body.slice(start, starts[i + 1] ?? body.length);
    return { name: stepName(block), guarded: hasGuard(block), script: readRun(block) };
  });
}

/** The step's label, with any trailing `# comment` and YAML quoting removed. */
function stepName(block: string[]): string {
  const first = block[0].replace(/^ {6}- /, '').trim();
  const match = /^(?:name|uses):\s*(.+?)\s*$/.exec(first);
  assert.ok(match, `precondition: ci.yml step does not open with a name or a uses: ${first}`);
  return match[1].replace(/\s+#.*$/, '').replace(/^["']|["']$/g, '');
}

/**
 * Whether a step carries `if: ${{ !cancelled() }}`.
 *
 * Comment lines are dropped first: the tag-fetch step's own comment block
 * explains this very rule in prose, and a comment that happened to contain the
 * string would otherwise count as the guard it is describing.
 */
function hasGuard(block: string[]): boolean {
  return block.some((line) => !/^\s*#/.test(line) && /^\s*if:[^\n]*!cancelled\(\)/.test(line));
}

/** A step's `run:` value, unwrapping the block scalar the test step uses. */
function readRun(block: string[]): string {
  const at = block.findIndex((line) => /^\s*run:/.test(line));
  if (at === -1) return '';

  const inline = block[at].replace(/^\s*run:\s*/, '');
  if (inline !== '' && !/^[|>][-+]?\d*$/.test(inline)) return inline;

  const keyIndent = block[at].length - block[at].trimStart().length;
  const script: string[] = [];
  for (const line of block.slice(at + 1)) {
    if (line.trim() === '') {
      script.push('');
      continue;
    }
    if (line.length - line.trimStart().length <= keyIndent) break;
    script.push(line.trim());
  }
  return script.join('\n');
}

// ---------------------------------------------------------------------------
// The file dependency graph, as the workflow declares it
// ---------------------------------------------------------------------------

/** Files a step creates: a shell redirect target, or a `tee` target. */
function writtenBy(script: string): string[] {
  const written = new Set<string>();
  for (const [, file] of script.matchAll(/(?:^|[^0-9<>|])>\s*([^\s|&;<>()]+)/g)) written.add(file);
  for (const [, file] of script.matchAll(/\btee\s+(?:-a\s+)?([^\s|&;<>()]+)/g)) written.add(file);
  return [...written];
}

/**
 * Files a step names, as its inputs and its outputs alike.
 *
 * A path needs a dot to count, which is what keeps `node`, `npx`, `--tags` and
 * `ubuntu-latest` out while admitting `.surface-census.json` — whose leading
 * dot is the whole reason the pattern cannot be `^\w`.
 */
function namedBy(script: string): string[] {
  const named = new Set<string>();
  for (const token of script.split(/[\s"'|&;<>()]+/)) {
    if (/^[.\w][\w./-]*\.[\w.-]+$/.test(token)) named.add(token);
  }
  return [...named];
}

/** Every file the job's own steps create, mapped to the indexes that create it. */
function producedArtifacts(steps: WorkflowStep[]): Map<string, number[]> {
  const produced = new Map<string, number[]>();
  steps.forEach((step, i) => {
    for (const file of writtenBy(step.script)) {
      produced.set(file, [...(produced.get(file) ?? []), i]);
    }
  });
  return produced;
}

// ---------------------------------------------------------------------------
// GitHub Actions' own rule, and what it does to a step's output
// ---------------------------------------------------------------------------

type Conclusion = 'success' | 'failure' | 'skipped';

/**
 * The guard, as it is written in the workflow.
 *
 * Named rather than inlined because `${{` opens an interpolation inside a
 * template literal, so a message that quotes the guard verbatim cannot hold it
 * as a plain string.
 */
const GUARD = 'if: ${{ !cancelled() }}';

/**
 * `conclusions[i]` is what Actions reports for step `i`, given that exactly the
 * step at `failing` fails and every other step succeeds.
 *
 * A step with no `if:` runs only while nothing above it has failed; one
 * carrying `!cancelled()` runs regardless. A step that *runs* and fails still
 * ran, so its shell redirect still created whatever it was redirecting into —
 * which is why `failure` counts as ran below, and why only `skipped` is able to
 * leave a file missing.
 */
function simulate(steps: WorkflowStep[], failing: number): Conclusion[] {
  const conclusions: Conclusion[] = [];
  let failedAbove = false;
  steps.forEach((step, i) => {
    if (!step.guarded && failedAbove) {
      conclusions.push('skipped');
      return;
    }
    if (i === failing) {
      conclusions.push('failure');
      failedAbove = true;
      return;
    }
    conclusions.push('success');
  });
  return conclusions;
}

/** The indexes of the steps Actions would actually run. */
function runningIndexes(conclusions: Conclusion[]): number[] {
  const running: number[] = [];
  conclusions.forEach((conclusion, i) => {
    if (conclusion !== 'skipped') running.push(i);
  });
  return running;
}

/**
 * Rule 1 — for every single point of failure, no step that still runs may read
 * a file that no step that still runs writes.
 *
 * One string per violation, each naming the failure that triggers it and the
 * two steps involved, because the message is the part a reader meets first.
 */
function cascadeFailures(steps: WorkflowStep[]): string[] {
  const produced = producedArtifacts(steps);
  const problems: string[] = [];

  for (let failing = 0; failing < steps.length; failing++) {
    const running = new Set(runningIndexes(simulate(steps, failing)));

    for (let i = 0; i < steps.length; i++) {
      if (!running.has(i)) continue;
      for (const file of namedBy(steps[i].script)) {
        const writers = produced.get(file) ?? [];
        if (writers.length === 0) continue; // an input, not an output of this job
        if (writers.some((w) => running.has(w))) continue;
        problems.push(
          `with ${JSON.stringify(steps[failing].name)} failing, ` +
            `${JSON.stringify(steps[i].name)} still runs and reads ${JSON.stringify(file)}, ` +
            `but the step that writes it (${writers.map((w) => JSON.stringify(steps[w].name)).join(', ')}) is skipped — ` +
            `CI reports the missing file instead of the failure that caused it`,
        );
      }
    }
  }
  return problems;
}

/** Rule 2 — the steps that fall out of the run the first guard started. */
function unguardedAfterFirstGuard(steps: WorkflowStep[]): string[] {
  const first = steps.findIndex((step) => step.guarded);
  if (first === -1) return [];
  const dropped: string[] = [];
  steps.slice(first).forEach((step) => {
    if (!step.guarded) dropped.push(step.name);
  });
  return dropped;
}

/** Rule 3 — a writer and a reader of the same file must agree about the guard. */
function guardDisagreements(steps: WorkflowStep[]): string[] {
  const produced = producedArtifacts(steps);
  const problems: string[] = [];

  for (const [file, writers] of produced) {
    for (let r = 0; r < steps.length; r++) {
      if (writers.includes(r)) continue;
      if (!namedBy(steps[r].script).includes(file)) continue;
      for (const w of writers) {
        if (steps[w].guarded === steps[r].guarded) continue;
        problems.push(
          `${JSON.stringify(steps[w].name)} writes ${JSON.stringify(file)} and ` +
            `${JSON.stringify(steps[r].name)} reads it, but one carries ` +
            `${GUARD} and the other does not — ` +
            `a failure above runs the reader against a file the writer never produced, ` +
            `or skips a gate that exists to report one`,
        );
      }
    }
  }
  return problems;
}

/** All three rules, in the order a reader should meet them. */
function problems(steps: WorkflowStep[]): string[] {
  return [
    ...cascadeFailures(steps),
    ...unguardedAfterFirstGuard(steps).map(
      (name) => `${JSON.stringify(name)} follows a step carrying ${GUARD} but has no guard, so it is silently skipped whenever anything above it fails`,
    ),
    ...guardDisagreements(steps),
  ];
}

// ---------------------------------------------------------------------------
// Mutation
// ---------------------------------------------------------------------------

/**
 * The workflow text with one step's `if:` line deleted — the shape that step
 * had before #1473.
 *
 * The line range is recomputed from the *mutated* source rather than carried
 * over from the original parse, so this cannot quietly edit the wrong step if
 * the file moves underneath it.
 */
function withoutGuard(source: string, name: string): string {
  const lines = source.split('\n');
  const start = stepStartLine(source, name);
  const stop = blockEndLine(lines, start);

  const kept = lines.slice(start, stop).filter((line) => !/^\s*if:/.test(line));
  assert.notEqual(kept.length, stop - start, `precondition: ${JSON.stringify(name)} had no if: line to remove`);
  return [...lines.slice(0, start), ...kept, ...lines.slice(stop)].join('\n');
}

/**
 * The line a step's `- name:` / `- uses:` entry starts on.
 *
 * Found by re-parsing each candidate header rather than by string-matching
 * ``- name: <name>``, because the checkout step has no `name:` at all and its
 * label comes from `uses:` with a trailing `# v7` comment the parse strips.
 */
function stepStartLine(source: string, name: string): number {
  const at = source.split('\n').findIndex((line) => /^ {6}- /.test(line) && stepName([line]) === name);
  assert.notEqual(at, -1, `precondition: ci.yml has no step named ${JSON.stringify(name)}`);
  return at;
}

/**
 * The workflow text with `if: ${{ !cancelled() }}` added to a step that lacks
 * one, placed before the step's `run:` — the order the file already uses.
 */
function withGuard(source: string, name: string): string {
  const lines = source.split('\n');
  const start = stepStartLine(source, name);
  const end = blockEndLine(lines, start);

  assert.ok(
    !lines.slice(start, end).some((line) => /^\s*if:/.test(line)),
    `precondition: ${JSON.stringify(name)} already carries an if:`,
  );

  const run = lines.slice(start, end).findIndex((line) => /^\s*run:/.test(line));
  const insertAt = run === -1 ? start + 1 : start + run;

  return [...lines.slice(0, insertAt), `        ${GUARD}`, ...lines.slice(insertAt)].join('\n');
}

/**
 * The line a step's block ends on: the next step's entry, or the end of file.
 *
 * Every mutation below searches *within* this range. A `run:` search that ran
 * to the end of the job would find the next step's `run:` instead and edit that
 * step, which is the kind of mutation that appears to work and proves nothing.
 */
function blockEndLine(lines: string[], start: number): number {
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((line) => /^ {6}- /.test(line));
  return end === -1 ? lines.length : start + 1 + end;
}

/** The same job with a guard on every step in it. */
function allGuarded(source: string): string {
  return parseSteps(source, JOB)
    .map((step) => step.name)
    .reduce((text, name) => (parseSteps(text, JOB).find((step) => step.name === name)?.guarded ? text : withGuard(text, name)), source);
}

/** The workflow text with one more step appended to the job, and no guard on it. */
function withAppendedStep(source: string, name: string, run: string): string {
  return `${source.replace(/\s*$/, '')}\n      - name: ${name}\n        run: ${run}\n`;
}

// ---------------------------------------------------------------------------
// Preconditions
// ---------------------------------------------------------------------------

const CENSUS_FILE = '.surface-census.json';
/** The step that writes the census, and the two that read it. */
const CENSUS_PRODUCER = 'Generate finalized surface census';
const CENSUS_READER = 'Check generated documentation inventory';
/** A guarded step in no file chain — the only way to exercise rule 2 alone. */
const UNCHAINED_STEP = 'Registry schema conformance gate';

describe('the workflow is read at all (#1473)', () => {
  const steps = parseSteps(workflow(), JOB);
  const produced = producedArtifacts(steps);

  it('finds the job, its steps, and the guards among them', () => {
    // Every rule below is an assertion about this list, so an empty or
    // truncated list makes all of them vacuously true — the parser would
    // "prove" the cascade is fixed by not finding anything to cascade.
    assert.ok(steps.length >= 12, `precondition: parsed only ${steps.length} step(s) from the ${JOB} job`);
    assert.ok(
      steps.every((step) => step.name.length > 0),
      'precondition: a step parsed with no name',
    );
    assert.ok(
      steps.some((step) => step.guarded),
      'precondition: no step carries if: ${{ !cancelled() }}, so no rule here has anything to assert',
    );
  });

  it('sees the census artifact as one writer and more than one reader', () => {
    // Rule 1 is only as good as the graph it walks. If the artifact stopped
    // being written into `run:`, or its name moved out of a `run:` line, the
    // cascade would be invisible to every rule in this file — and they would
    // all still pass.
    const writers = produced.get(CENSUS_FILE) ?? [];
    assert.deepEqual(
      writers.map((i) => steps[i].name),
      [CENSUS_PRODUCER],
      'precondition: the census artifact is no longer written by exactly the one step this file names',
    );

    const readers = steps.filter((step, i) => !writers.includes(i) && namedBy(step.script).includes(CENSUS_FILE));
    assert.ok(readers.length >= 2, `precondition: only ${readers.length} step(s) read ${CENSUS_FILE}`);
    assert.deepEqual(
      readers.map((step) => step.name),
      [CENSUS_READER, 'Check documented tool names'],
      'precondition: the census artifact is no longer read by the two steps this file names',
    );
  });

  it('unwraps a block-scalar `run:` rather than reading only its first line', () => {
    // The test step's script is a `|` block that both writes and reads
    // `test-results.tap`. If the reader stopped there, the artifact would look
    // unproduced and rule 1 would be reasoning about a graph that is wrong in
    // the one direction that cannot be noticed.
    const testStep = steps.find((step) => step.name.startsWith('Test with count and coverage gates'));
    assert.ok(testStep, 'precondition: the test step was not found');
    assert.match(testStep.script, /coverage/, 'precondition: the block scalar was not unwrapped');
    assert.ok(
      (produced.get('test-results.tap') ?? []).length === 1,
      'precondition: `tee test-results.tap` in the block scalar was not read as a write',
    );
  });
});

// ---------------------------------------------------------------------------
// The fix
// ---------------------------------------------------------------------------

describe('an unrelated red does not cascade into a missing census file (#1473)', () => {
  it('the real workflow has no cascade, no silently-skipped gate, and no guard disagreement', () => {
    const steps = parseSteps(workflow(), JOB);
    const found = problems(steps);
    assert.deepEqual(
      found,
      [],
      `ci.yml's ${JOB} job misreports its own failures:\n  - ${found.join('\n  - ')}`,
    );
  });

  it('the census chain runs unless cancelled', () => {
    // The direct statement of the fix, so a reader who wants the claim rather
    // than the derivation can find it. The three rules above are what keep it
    // true as the job changes; this is the assertion they all imply here.
    const steps = parseSteps(workflow(), JOB);
    for (const name of [CENSUS_PRODUCER, CENSUS_READER, 'Check documented tool names']) {
      const step = steps.find((candidate) => candidate.name === name);
      assert.ok(step, `precondition: ci.yml has no step named ${JSON.stringify(name)}`);
      assert.ok(
        step.guarded,
        `ci.yml step ${JSON.stringify(name)} is skipped when an earlier step fails, so the census it depends on never arrives`,
      );
    }
  });
});

// ---------------------------------------------------------------------------
// Proof the checks can fail
//
// Every subtest below repairs the workflow to a state where no rule can fire,
// then breaks exactly one thing and asserts that exactly the right rule
// notices. Building the base that way rather than reading the checked-in
// workflow is deliberate: it makes each subtest a claim about the *rule* —
// "remove this guard and this check rejects it" — instead of a claim about
// today's file, which would quietly stop meaning anything the day someone
// edited a step this file had never heard of.
// ---------------------------------------------------------------------------

describe('the cascade checks reject a workflow that has lost a guard (#1473)', () => {
  const checkedIn = workflow();
  /** The same job with a guard on every step: the state no cascade survives. */
  const repaired = allGuarded(checkedIn);

  it('a fully-guarded job has nothing for any of the three rules to report', () => {
    // The premise the four subtests below rest on. Without it, "the mutation
    // produced a problem" could mean the mutation found one, or that the file
    // was already carrying it.
    assert.deepEqual(problems(parseSteps(repaired, JOB)), []);
    assert.deepEqual(problems(parseSteps(checkedIn, JOB)), [], 'precondition: the checked-in workflow is not fixed yet');
  });

  it('takes the guard off the census step and the cascade reappears', () => {
    // The regression, restored. Rule 1 is the one that has to catch it: with
    // the census step skipped, a guarded reader below it still runs and reads
    // a file nothing wrote. That is the shape of run `36313342863`, where
    // `Check documented tool names` failed on `ENOENT: … .surface-census.json`
    // because this step had been skipped.
    const broken = withoutGuard(repaired, CENSUS_PRODUCER);
    const steps = parseSteps(broken, JOB);

    assert.notEqual(broken, repaired, 'precondition: the mutation changed nothing');
    assert.ok(
      !steps.find((step) => step.name === CENSUS_PRODUCER)!.guarded,
      'precondition: the mutation left the census step guarded, so it proved nothing',
    );
    assert.ok(
      cascadeFailures(steps).some((problem) => problem.includes(CENSUS_FILE) && problem.includes('instead of the failure')),
      'the cascade check accepted a workflow whose census step is skipped while a guarded reader still runs, so it cannot detect #1473',
    );
    assert.ok(
      unguardedAfterFirstGuard(steps).includes(CENSUS_PRODUCER),
      'the contiguity check accepted a workflow whose census step lost its guard',
    );
    assert.ok(
      guardDisagreements(steps).some((problem) => problem.includes(CENSUS_FILE)),
      'the agreement check accepted a guarded reader fed by an unguarded writer',
    );
  });

  it('takes the guard off a reader and the agreement check notices', () => {
    // The mirror image, and a different failure: no cascade (the writer runs,
    // the reader is skipped) but a gate that stops reporting. Rule 1 is
    // structurally blind to it, which is why rule 3 exists — and this is the
    // subtest that would go green silently if rule 3 were dropped.
    const broken = withoutGuard(repaired, CENSUS_READER);
    const steps = parseSteps(broken, JOB);

    assert.notEqual(broken, repaired, 'precondition: the mutation changed nothing');
    assert.ok(
      !steps.find((step) => step.name === CENSUS_READER)!.guarded,
      'precondition: the mutation left the reader guarded, so it proved nothing',
    );
    assert.deepEqual(
      cascadeFailures(steps),
      [],
      'precondition: this shape is not a cascade, so rule 1 must stay quiet and only rule 3 can catch it',
    );
    assert.ok(
      guardDisagreements(steps).some((problem) => problem.includes(CENSUS_READER)),
      'the agreement check accepted a census writer and a census reader that disagree about the guard',
    );
    assert.ok(
      unguardedAfterFirstGuard(steps).includes(CENSUS_READER),
      'the contiguity check accepted a reader that dropped out of the guarded run',
    );
  });

  it('takes the guard off a step in no file chain, and only the contiguity check notices', () => {
    // Rule 1 walks a file dependency graph, so a step that writes and reads
    // nothing is structurally invisible to it. This subtest is what keeps rule
    // 2 honest: if the contiguity rule were removed, this failure would have
    // no check at all.
    const broken = withoutGuard(repaired, UNCHAINED_STEP);
    const steps = parseSteps(broken, JOB);

    assert.notEqual(broken, repaired, 'precondition: the mutation changed nothing');
    assert.ok(
      !steps.find((step) => step.name === UNCHAINED_STEP)!.guarded,
      'precondition: the mutation left the step guarded, so it proved nothing',
    );
    assert.deepEqual(cascadeFailures(steps), [], 'precondition: this step is in no file chain');
    assert.deepEqual(guardDisagreements(steps), [], 'precondition: this step shares no artifact');
    assert.ok(
      unguardedAfterFirstGuard(steps).includes(UNCHAINED_STEP),
      'the contiguity check accepted a guarded-tail step with no guard, so an unrelated red silently skips a gate',
    );
  });

  it('catches a step that does not exist yet, without being told its name', () => {
    // The reason none of the rules above enumerate steps. #1462's test named
    // the two steps it cared about, which is right for a fix and wrong for a
    // guard: the next unguarded step joins a queue nobody is watching. So
    // here is a step this file has never heard of, appended to a fully-guarded
    // job with no `if:` of its own — the exact shape of #1473, one release
    // from now. Two rules catch it, and neither needed to be told the name.
    const futureStep = 'Check census provenance';
    const broken = withAppendedStep(
      repaired,
      futureStep,
      'node scripts/check-census-provenance.mjs --census-file .surface-census.json',
    );
    const steps = parseSteps(broken, JOB);

    assert.ok(
      steps.some((step) => step.name === futureStep),
      'precondition: the appended step was not parsed, so the rules had nothing to see',
    );
    assert.ok(
      unguardedAfterFirstGuard(steps).includes(futureStep),
      'the contiguity check accepted a new unguarded step in the guarded tail',
    );
    assert.ok(
      guardDisagreements(steps).some((problem) => problem.includes(futureStep) && problem.includes(CENSUS_FILE)),
      'the agreement check accepted a new unguarded census reader beside a guarded writer',
    );
  });
});
