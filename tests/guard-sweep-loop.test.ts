/**
 * Guard for `scripts/sweep-loop.sh` (#656).
 *
 * The loop is the documented way to finish a live sweep (`npm run sweep:loop`),
 * so an operator typo or a second terminal must not be able to corrupt the
 * cumulative report. The script is exercised for real — the repository's own
 * `scripts/sweep-loop.sh` is copied into a sandbox beside a stub gauntlet that
 * honours the same `--batch/--resume/--report` contract, so every batch, lock
 * and rename the loop performs is observed rather than asserted about.
 *
 * The stub deliberately reproduces the ways the real gauntlet can end: a normal
 * end of batch, a quota wall, completion, and a process that dies before it
 * records anything. Nothing here asserts that the script merely mentions a
 * marker: the assertions are on exit codes, on the argv the gauntlet actually
 * received, and on what a concurrent reader can observe at the report path.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  spawn, spawnSync, type ChildProcessWithoutNullStreams, type SpawnSyncReturns,
} from 'node:child_process';
import {
  copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const SWEEP_LOOP = join(ROOT, 'scripts/sweep-loop.sh');
const RUN_TIMEOUT_MS = 30_000;

/** Stands in for `scripts/live-gauntlet.mjs`; see the module comment. */
const STUB = `
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';

const argv = process.argv.slice(2);
const flag = (name) => {
  const hit = argv.find((a) => a.startsWith('--' + name + '='));
  return hit === undefined ? undefined : hit.slice(name.length + 3);
};
const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

const reportPath = flag('report');
const logPath = process.env.SWEEP_STUB_LOG;
const plan = JSON.parse(process.env.SWEEP_STUB_PLAN || '[]');
const run = logPath && existsSync(logPath)
  ? readFileSync(logPath, 'utf8').split('\\n').filter(Boolean).length
  : 0;
const step = plan[run] ?? plan[plan.length - 1] ?? 'normal';
if (logPath) {
  appendFileSync(logPath, JSON.stringify({ run: run + 1, batch: flag('batch'), resume: flag('resume'), report: reportPath, step }) + '\\n');
}

const write = (marker) => writeFileSync(reportPath, JSON.stringify({ marker, run: run + 1 }, null, 2) + '\\n');

if (step === 'complete') {
  write('complete');
  console.log('SWEEP_COMPLETE: every registered tool is recorded in the report (no FAILs to retry)');
  process.exit(0);
}
if (step === 'quota') {
  write('quota');
  console.log('QUOTA_WALL: 3 consecutive failures - aborting this batch; sweep-loop will back off');
  process.exit(0);
}
if (step === 'crash') {
  // Dies before writing a report and without reaching any of its own
  // end-of-batch markers - the real gauntlet behaves this way when it throws.
  console.error('Error: stub gauntlet died before recording the batch');
  process.exit(1);
}
if (step === 'die-mid-write') {
  // The real gauntlet announces the end of a batch and only then calls
  // writeFileSync, so a kill in between leaves a clean-looking log and a
  // truncated report.
  console.log('batch run finished after 3 calls (0 resumed, 3 recorded this run)');
  writeFileSync(reportPath, '{\\n  "generated_at": "2026-01-01T00:00:00.000Z",\\n  "results": [');
  process.exit(1);
}
if (step === 'partial-slow') {
  writeFileSync(reportPath, '{"marker":"partial","entries": [');
  sleep(Number(process.env.SWEEP_STUB_MS || 600));
  write('complete-batch');
  console.log('batch run finished after 3 calls (0 resumed, 3 recorded this run)');
  process.exit(0);
}
if (step === 'slow') {
  sleep(Number(process.env.SWEEP_STUB_MS || 1500));
  write('slow');
  console.log('batch run finished after 3 calls (0 resumed, 3 recorded this run)');
  process.exit(0);
}
write('complete-batch');
console.log('batch run finished after 3 calls (0 resumed, 3 recorded this run)');
process.exit(0);
`;

type StubStep = string | { step: string; ms?: number };

type StubCall = { run: number; batch?: string; resume?: string; report?: string; step: string };

type Run = { status: number | null; output: string; invocations: StubCall[] };

type Sandbox = {
  dir: string;
  report: string;
  lock: string;
  invocations(): StubCall[];
  run(env?: Record<string, string>): Run;
  start(env?: Record<string, string>): { done: Promise<Run> };
};

function sandbox(plan: StubStep[]): Sandbox {
  const dir = mkdtempSync(join(tmpdir(), 'sweep-loop-'));
  mkdirSync(join(dir, 'scripts'), { recursive: true });
  copyFileSync(SWEEP_LOOP, join(dir, 'scripts/sweep-loop.sh'));
  writeFileSync(join(dir, 'scripts/live-gauntlet.mjs'), STUB);

  const log = join(dir, 'stub.log');
  const report = join(dir, 'memory/live-sweep-report.json');
  const lock = join(dir, 'memory/.sweep-loop.lock');
  const timing = plan.find((entry): entry is { step: string; ms?: number } => typeof entry !== 'string');
  const baseEnv = {
    SWEEP_STUB_LOG: log,
    SWEEP_STUB_PLAN: JSON.stringify(plan.map((entry) => (typeof entry === 'string' ? entry : entry.step))),
    SWEEP_STUB_MS: String(timing?.ms ?? 1500),
    MAX_BATCHES: '1',
    INTERVAL: '0',
  };

  const invocations = (): StubCall[] =>
    (existsSync(log) ? readFileSync(log, 'utf8') : '')
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line) as StubCall);

  const collect = (child: ChildProcessWithoutNullStreams): Promise<Run> => {
    const { promise, resolve, reject } = Promise.withResolvers<Run>();
    let output = '';
    child.stdout.on('data', (chunk) => { output += String(chunk); });
    child.stderr.on('data', (chunk) => { output += String(chunk); });
    child.on('error', reject);
    child.on('close', (status) => resolve({ status, output, invocations: invocations() }));
    return promise;
  };

  const run = (env: Record<string, string> = {}): Run => {
    const result: SpawnSyncReturns<string> = spawnSync('bash', ['scripts/sweep-loop.sh'], {
      cwd: dir,
      encoding: 'utf8',
      timeout: RUN_TIMEOUT_MS,
      env: { ...process.env, ...baseEnv, ...env },
    });
    assert.equal(result.error, undefined, `the loop failed to launch: ${String(result.error)}`);
    return { status: result.status, output: `${result.stdout}\n${result.stderr}`, invocations: invocations() };
  };

  return {
    dir,
    report,
    lock,
    invocations,
    run,
    start: (env = {}) => ({
      done: collect(spawn('bash', ['scripts/sweep-loop.sh'], {
        cwd: dir,
        encoding: 'utf8',
        env: { ...process.env, ...baseEnv, ...env },
      })),
    }),
  };
}

/**
 * Real time, deliberately: the guarantees under test are what a second reader
 * observes while a real child process holds the report, so the test has to span
 * that window rather than fake it. Polls the condition, never a fixed wait.
 */
async function until(predicate: () => boolean, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    const { promise, resolve } = Promise.withResolvers<void>();
    setTimeout(resolve, 20);
    await promise;
  }
  assert.fail('timed out waiting for the loop to reach the expected state');
}

function seedReport(box: Sandbox, marker: string): void {
  mkdirSync(join(box.dir, 'memory'), { recursive: true });
  writeFileSync(box.report, JSON.stringify({ marker }, null, 2) + '\n');
}

function markerOf(report: string): string {
  return (JSON.parse(readFileSync(report, 'utf8')) as { marker: string }).marker;
}

describe('sweep-loop.sh guard (#656)', () => {
  it('rejects a non-numeric BATCH with a usage error and never starts node', () => {
    const box = sandbox(['normal']);

    const result = box.run({ BATCH: 'abc' });

    assert.equal(result.status, 2, result.output);
    assert.match(result.output, /BATCH must be a whole number, got 'abc'/);
    assert.match(result.output, /usage: BATCH=/);
    assert.deepEqual(result.invocations, [], 'a usage error must not reach the gauntlet');
  });

  it('rejects a zero batch size, a fractional interval and a report path that is not a file', () => {
    const zeroBatch = sandbox(['normal']).run({ BATCH: '0' });
    assert.equal(zeroBatch.status, 2, zeroBatch.output);
    assert.match(zeroBatch.output, /BATCH must be at least 1/);
    assert.deepEqual(zeroBatch.invocations, []);

    const fractionalInterval = sandbox(['normal']).run({ INTERVAL: '1.5' });
    assert.equal(fractionalInterval.status, 2, fractionalInterval.output);
    assert.match(fractionalInterval.output, /INTERVAL must be a whole number/);
    assert.deepEqual(fractionalInterval.invocations, []);

    const noBatches = sandbox(['normal']).run({ MAX_BATCHES: '0' });
    assert.equal(noBatches.status, 2, noBatches.output);
    assert.match(noBatches.output, /MAX_BATCHES must be at least 1/);

    const dirReport = sandbox(['normal']);
    mkdirSync(join(dirReport.dir, 'memory'), { recursive: true });
    const ontoDir = dirReport.run({ REPORT: 'memory' });
    assert.equal(ontoDir.status, 2, ontoDir.output);
    assert.match(ontoDir.output, /REPORT is an existing directory/);
    assert.deepEqual(ontoDir.invocations, []);

    const twoLine = sandbox(['normal']).run({ REPORT: 'memory/live.json\nsweep.json' });
    assert.equal(twoLine.status, 2, twoLine.output);
    assert.match(twoLine.output, /REPORT must be a single line/);
    assert.deepEqual(twoLine.invocations, []);
  });

  it('clamps BATCH to the API page size instead of handing the gauntlet a batch it cannot honour', () => {
    const box = sandbox(['normal']);

    const result = box.run({ BATCH: '500' });

    assert.match(result.output, /BATCH=500 is above the supported maximum 50 — clamping/);
    assert.equal(result.invocations.length, 1, result.output);
    assert.equal(
      result.invocations[0]!.batch,
      '50',
      'the clamp has to reach the gauntlet as argv; a warning alone would leave BATCH=500 in flight',
    );
  });

  it('refuses a second concurrent loop on the same report', async () => {
    const box = sandbox([{ step: 'slow', ms: 2000 }]);
    const first = box.start();
    await until(() => box.invocations().length === 1);

    const second = box.run();

    assert.equal(second.status, 4, second.output);
    assert.match(second.output, /already holds .*\.sweep-loop\.lock — refusing to start/);
    assert.deepEqual(
      second.invocations.map((call) => call.run),
      [1],
      'the refused loop must not have driven a second gauntlet against the shared quota and report',
    );

    const finished = await first.done;
    assert.equal(finished.status, 3, finished.output);
  });

  it('reclaims a lock left behind by a dead loop', () => {
    const box = sandbox(['normal']);
    mkdirSync(box.lock, { recursive: true });
    // Above the default pid_max, so no live process can own it.
    writeFileSync(join(box.lock, 'pid'), '4194303\n');

    const result = box.run();

    assert.match(result.output, /reclaiming the lock left by dead pid 4194303/);
    assert.equal(result.invocations.length, 1, result.output);
  });

  it('reports a MAX_BATCHES stop as resumable (3), keeps the report and releases the lock', () => {
    const box = sandbox(['normal']);

    const result = box.run();

    assert.equal(result.status, 3, result.output);
    assert.match(result.output, /MAX_BATCHES \(1\) reached — run again later to continue/);
    assert.equal(markerOf(box.report), 'complete-batch');
    assert.equal(existsSync(box.lock), false, 'the trap must remove the lock on a normal exit');

    // The lock is gone, so the documented "run again later" actually resumes.
    const again = box.run();
    assert.equal(again.status, 3, again.output);
    assert.equal(again.invocations.length, 2, again.output);
  });

  it('reports a finished sweep as 0 and a quota wall as a resumable 3', () => {
    const complete = sandbox(['complete']).run();
    assert.equal(complete.status, 0, complete.output);
    assert.match(complete.output, /SWEEP DONE after 1 batches/);

    const quota = sandbox(['quota']).run();
    assert.equal(quota.status, 3, quota.output);
    assert.match(quota.output, /quota wall detected/);
  });

  it('never exposes a partial report: the path holds only whole batches', async () => {
    const box = sandbox([{ step: 'partial-slow', ms: 700 }]);
    // What the previous batch published: complete, and the loop must not
    // regress it to anything else at any point during the next one.
    seedReport(box, 'previous-batch');

    const child = box.start();
    const observed: string[] = [];
    const poll = setInterval(() => {
      if (existsSync(box.report)) observed.push(readFileSync(box.report, 'utf8'));
    }, 10);
    const result = await child.done;
    clearInterval(poll);

    assert.ok(observed.length > 5, `expected to observe the report mid-batch, saw ${observed.length} reads`);
    // Every readable state of the path is a parseable document. The stub
    // truncates its write on purpose, so a report written in place surfaces
    // here as a JSON parse error rather than as a passing test.
    const markers = observed.map((content) => (JSON.parse(content) as { marker: string }).marker);
    assert.ok(markers.includes('previous-batch'), 'the report was never sampled during the batch');
    assert.ok(
      markers.every((marker) => marker === 'previous-batch' || marker === 'complete-batch'),
      `the report showed a state no batch ever published: ${markers.filter((marker, at) => markers.indexOf(marker) === at).join(', ')}`,
    );

    assert.equal(markerOf(box.report), 'complete-batch', 'the finished batch must be published once it is whole');
    assert.equal(result.status, 3, result.output);
    assert.deepEqual(
      readdirSync(join(box.dir, 'memory')),
      ['live-sweep-report.json'],
      'the staging file and the lock must not survive the run',
    );
  });

  it('leaves the last complete report alone when the gauntlet keeps dying, and exits 5', () => {
    const box = sandbox(['crash', 'crash', 'crash']);
    seedReport(box, 'previous-batch');

    const result = box.run({ MAX_BATCHES: '30' });

    assert.equal(result.status, 5, result.output);
    assert.match(result.output, /failed 3 batches running without recording a batch \(last exit=1\)/);
    assert.equal(result.invocations.length, 3, 'a dead gauntlet is not retried 30 times');
    assert.equal(markerOf(box.report), 'previous-batch', 'a batch that never wrote a report must leave the published one alone');
  });

  it('refuses to publish a report the gauntlet died in the middle of writing', () => {
    // The gauntlet prints its end-of-batch line before writeFileSync, so this
    // batch looks clean in the log while the file it left is truncated JSON.
    // Publishing it on "non-empty" alone would corrupt the tracked report.
    const box = sandbox(['die-mid-write', 'die-mid-write', 'die-mid-write']);
    seedReport(box, 'previous-batch');

    const result = box.run({ MAX_BATCHES: '30' });

    assert.equal(result.status, 5, result.output);
    assert.match(result.output, /died mid-write — its partial report is discarded/);
    assert.equal(result.invocations.length, 3, result.output);
    assert.equal(
      readFileSync(box.report, 'utf8'),
      JSON.stringify({ marker: 'previous-batch' }, null, 2) + '\n',
      'the truncated report must never replace the last complete one',
    );
    assert.deepEqual(readdirSync(join(box.dir, 'memory')), ['live-sweep-report.json']);
  });
});
