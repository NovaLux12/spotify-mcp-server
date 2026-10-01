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
 * end of batch, a quota wall, completion, a process that dies before it records
 * anything, and a report truncated mid-write. Nothing here asserts that the
 * script merely mentions a marker or an option: the assertions are on exit
 * codes, on the argv the gauntlet actually received, on the report mode and
 * the paths a shimmed `mkdir` was really called with, and on what a concurrent
 * reader can observe at the report path.
 */

import './helpers/hermetic.js';

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  spawn, spawnSync, type ChildProcess, type ChildProcessWithoutNullStreams, type SpawnSyncReturns,
} from 'node:child_process';
import {
  chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync,
  statSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { armFileDeadline, FLEET_FILE_BUDGET_MS, type DeadlineChild } from './helpers/file-deadline.js';
import { isOwnChild } from './helpers/stdio-child.js';

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
// The real gauntlet writes the report *after* its end-of-batch line and writes
// nothing at all on the SWEEP_COMPLETE fast path; the steps below that write
// first do so because no assertion here depends on the ordering — the ordering
// that is load bearing (die-mid-write) is modelled the way the real one runs.
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
if (step === 'truncated-silent') {
  // A report file that does not parse, with no end-of-batch line and a
  // non-zero exit: the batch lost its report, which is one failing batch —
  // not two, whatever the loop counts.
  writeFileSync(reportPath, '{\\n  "results": [');
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
if (step === 'mutation-detected') {
  // #1346. The exact shape the loop swallowed: the gauntlet reached the end of
  // the batch, so it printed the banner and wrote a report it published
  // perfectly well — and then exited 1, because its own mutation proof said
  // MUTATIONS_DETECTED. The old guard asked for the banner to be ABSENT before
  // it would call a non-zero exit a failure, so this reported success.
  write('complete-batch');
  console.log('batch run finished after 3 calls (0 resumed, 3 recorded this run)');
  console.log('mutations detected: 1 (account-state diff: 4 field(s) read before and after, 0 unreadable)');
  console.log('  MUTATED playlist_count: 12 -> 13 (observed by get_user_playlists; single unguarded mutating call in this run)');
  console.log('mutation proof: MUTATIONS_DETECTED');
  process.exit(1);
}
if (step === 'unverified') {
  // The other status the gauntlet refuses to exit 0 on. Same swallowed shape.
  write('complete-batch');
  console.log('batch run finished after 3 calls (0 resumed, 3 recorded this run)');
  console.log('mutations detected: 0 (account-state diff: 4 field(s) read before and after, 0 unreadable)');
  console.log('  UNVERIFIED create_playlist: response carried no structuredContent.dry_run === true; a prose "[dry run]" is not confirmation');
  console.log('mutation proof: UNVERIFIED');
  process.exit(1);
}
if (step === 'fails-only') {
  // The other half of what exit 1 means: 'counts.FAIL || proofBlocksExit(proof)'
  // in live-gauntlet.mjs, so a tool that FAILED — a quota wall, a gated
  // endpoint — also exits 1. It published a report and --resume retries those
  // tools on a later batch, so this is a normal, resumable batch. Calling every
  // non-zero exit a failure would break this case, which is why the guard reads
  // the proof line rather than the exit code alone.
  write('complete-batch');
  console.log('batch run finished after 3 calls (0 resumed, 3 recorded this run)');
  console.log('1 PASS failed / 1 failed / 2 skipped');
  console.log('mutation proof: INCOMPLETE');
  process.exit(1);
}
if (step === 'no-proof') {
  // Banner printed, report written and published, non-zero exit — and no proof
  // line at all, because the process died between the two. The banner says
  // "reached the end of a batch", which is progress, not a verdict; a verdict
  // that was never recorded is not a pass, and must not read as one.
  write('complete-batch');
  console.log('batch run finished after 3 calls (0 resumed, 3 recorded this run)');
  process.exit(1);
}
if (step === 'complete-mutated') {
  // The completion path of the same defect. The real gauntlet prints
  // SWEEP_COMPLETE and then exits 'proofBlocksExit(completeProof) ? 1 : 0', so
  // a sweep whose cumulative proof is MUTATIONS_DETECTED announces completion
  // and exits 1. The loop read the marker alone and printed "SWEEP DONE".
  console.log('SWEEP_COMPLETE: every registered tool is recorded in the report (no FAILs to retry)');
  console.log('mutations detected: 1 (account-state diff: 4 field(s) read before and after, 0 unreadable)');
  console.log('mutation proof: MUTATIONS_DETECTED');
  process.exit(1);
}
write('complete-batch');
console.log('batch run finished after 3 calls (0 resumed, 3 recorded this run)');
console.log('mutation proof: INCOMPLETE');
process.exit(0);
`;

type StubStep = string | { step: string; ms?: number };

type StubCall = { run: number; batch?: string; resume?: string; report?: string; step: string };

type Run = { status: number | null; output: string; invocations: StubCall[] };

/** A loop still in flight: its pid, its output so far, and how it ended. */
type Running = { pid: number; output(): string; done: Promise<Run> };

type Sandbox = {
  dir: string;
  report: string;
  lock: string;
  invocations(): StubCall[];
  run(env?: Record<string, string>): Run;
  start(env?: Record<string, string>): Running;
  /**
   * Puts an executable named `name` earlier in PATH and returns the PATH to
   * run the loop with, so a test can observe how a real tool was called
   * instead of asserting that the script mentions an option. The shim strips
   * its own directory off PATH before delegating, so it cannot recurse.
   */
  shim(name: string, body: string): string;
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

  const collect = (child: ChildProcessWithoutNullStreams): { output(): string; done: Promise<Run> } => {
    const { promise, resolve, reject } = Promise.withResolvers<Run>();
    let seen = '';
    child.stdout.on('data', (chunk) => { seen += String(chunk); });
    child.stderr.on('data', (chunk) => { seen += String(chunk); });
    child.on('error', reject);
    child.on('close', (status) => resolve({ status, output: seen, invocations: invocations() }));
    return { output: () => seen, done: promise };
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
    start: (env = {}) => {
      const child = spawn('bash', ['scripts/sweep-loop.sh'], {
        cwd: dir,
        // No `encoding` here: it is a `spawnSync` option only, and the async
        // `spawn` has no such key — it was silently inert, and its presence
        // defeated overload resolution so the child typed as `never`. Output
        // decoding is `collect`'s job (`String(chunk)`), unchanged.
        env: { ...process.env, ...baseEnv, ...env },
        // Its own process group, so a signal test can signal the loop alone but
        // still clean up after it. A loop that ignores a signal has to be
        // SIGKILLed, and SIGKILL cannot reach the `sleep` it left running: that
        // orphan keeps the inherited stdout pipe open, and this test file would
        // hang on teardown instead of reporting a failure.
        detached: true,
      });
      // assert.ok, not assert.equal: it is an assertion function, so the pid
      // narrows to a number and the `!` below is not needed to read it.
      assert.ok(typeof child.pid === 'number', 'the loop must be startable so its pid can be signalled');
      // Named by the sandbox, which is unique per `sandbox()` call, so a breach
      // report traces a leaked pipe back to the test that created it rather than
      // to this file in general.
      adoptLoop(child, `sweep-loop.sh in ${basename(dir)}`);
      return { pid: child.pid, ...collect(child) };
    },
    shim: (name, body) => {
      const bin = join(dir, 'shim-bin');
      mkdirSync(bin, { recursive: true });
      const file = join(bin, name);
      writeFileSync(file, `#!/usr/bin/env bash\nPATH=\${PATH#*:}\n${body}\n`);
      chmodSync(file, 0o755);
      return `${bin}:${process.env['PATH'] ?? ''}`;
    },
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

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
};

/**
 * Waits for a signalled process to go away, and says so if it does not.
 *
 * The point of the signal tests is that the loop *stops promptly*, so the wait
 * is bounded well under the pause it is being interrupted from. A loop that
 * ignores the signal is killed and the assertion fails on that, rather than
 * being left behind to outlive the test run.
 */
async function waitForExit(pid: number, timeoutMs = 8_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!alive(pid)) return true;
    const { promise, resolve } = Promise.withResolvers<void>();
    setTimeout(resolve, 25);
    await promise;
  }
  // The group, not just the pid: see the `detached` note on Sandbox.start. The
  // negative group signal reaps the sleep the loop left behind, so this test
  // fails with a message rather than hanging on an inherited pipe.
  try {
    process.kill(-pid, 'SIGKILL');
  } catch { /* no group left, or already gone */ }
  try {
    process.kill(pid, 'SIGKILL');
  } catch { /* already gone */ }
  return false;
}

function markerOf(report: string): string {
  return (JSON.parse(readFileSync(report, 'utf8')) as { marker: string }).marker;
}

/**
 * Every asynchronous child this file spawns, so the whole-file deadline can name
 * and reap all of them rather than only the ones a hook happened to register
 * (#1653).
 *
 * This accessor was `() => []`, which is not the same as this file spawning no
 * children. It spawns a detached `bash` per `start()` — a real process tree with
 * inherited stdio — so on a #1365 wedge the breach report could name the *kind*
 * of handle still registered (`PipeWrap`) and nothing about *whose* it was. The
 * report said so in as many words: "this file registered no children with the
 * deadline, so the handles below cannot be attributed to one".
 *
 * `run()` is deliberately absent. It is `spawnSync` with its own `RUN_TIMEOUT_MS`,
 * so it is bounded before the deadline can fire and reaps itself on return;
 * registering it would put a child in the list that is already gone, and a report
 * that lists dead pids teaches a reader to distrust the live ones.
 */
const spawned: DeadlineChild[] = [];

/**
 * Adapt a spawned `bash` into the slice the deadline needs, and register it.
 *
 * The one place this deliberately departs from `StdioJsonRpcChild.killNow` is
 * that it signals the **process group**, not the pid. This file spawns `detached:
 * true` so a signal test can hit the loop alone and still clean up, and its own
 * comment records the consequence: a loop that ignores SIGTERM has to be
 * SIGKILLed, and "SIGKILL cannot reach the `sleep` it left running: that orphan
 * keeps the inherited stdout pipe open, and this test file would hang on
 * teardown". A pid-only kill would therefore leave behind precisely the leaked
 * write end this deadline exists to catch, while appearing to have cleaned up.
 *
 * The group is only signalled once `isOwnChild` has confirmed the leader is still
 * ours, so a recycled pid is never signalled.
 */
function adoptLoop(child: ChildProcess, what: string): void {
  const pid = child.pid;
  let stderrText = '';
  // `stdio: 'ignore'` gives a null stderr, and `child.stderr.on` would throw on
  // it — so this is a real branch, not defensive padding. Cast the child to
  // `ChildProcessWithoutNullStreams` here and the latecomer path dies on its
  // first spawn with a `TypeError` that no type error predicted.
  child.stderr?.on('data', (chunk) => { stderrText += String(chunk); });
  let outcome: string | undefined;
  child.on('close', (code, signal) => {
    outcome = `code=${code} signal=${signal ?? 'none'}`;
  });
  spawned.push({
    label: what,
    get pid() { return pid; },
    get stderr() { return stderrText; },
    get outcomeDescription() { return outcome; },
    // `exitCode`/`signalCode` are latched by Node, so this stays correct for a
    // child that has exited but whose pipes have not yet reached EOF — which is
    // the whole #1365 case, and why `closed` cannot stand in for it here.
    isRunning: () => child.exitCode === null && child.signalCode === null,
    killNow: () => {
      if (pid === undefined || pid === process.pid || !isOwnChild(pid)) return;
      try {
        // Negative pid = the whole group, which is what reaps the orphan `sleep`.
        process.kill(-pid, 'SIGKILL');
      } catch {
        // ESRCH: the group is already gone. Fall through to the leader alone in
        // case it exited but left its group behind.
        try {
          process.kill(pid, 'SIGKILL');
        } catch {
          // Gone. The `close` handler has already said so.
        }
      }
    },
  });
}

/**
 * The whole-file bound (#1569).
 *
 * This file spawns real child processes, so a child whose tree still holds an
 * inherited stdio write end can keep this process's `PipeWrap` registered and the
 * loop undrainable — the #1365 failure, which is silent and unbounded because the
 * runner is invoked with no `--test-timeout`. See `helpers/file-deadline.ts`.
 *
 * Armed at module scope, above every hook, because a bound a teardown can clear is
 * not a bound. The timer is `unref`'d, so it cannot itself delay this file.
 */
/**
 * The armed options object, kept so the registration test below can assert on the
 * accessor the deadline actually reads.
 *
 * Asserting on `spawned` instead would prove the array grows while leaving the
 * thing that matters unpinned: `children: () => []` reads that same array and
 * discards it, and a test watching the array stays green when the guard goes
 * blind. That is the decorative guard this issue exists to remove, so the test
 * calls the accessor's own return value.
 */
const deadlineOptions = {
  label: 'tests/guard-sweep-loop.test.ts',
  budgetMs: FLEET_FILE_BUDGET_MS,
  children: (): readonly DeadlineChild[] => spawned,
};
armFileDeadline(deadlineOptions);

describe('sweep-loop.sh guard (#656)', () => {
  // #1653. `children: () => []` is a guard that reports nothing, and it passed
  // for as long as this file spawned detached children holding inherited stdio —
  // the breach report could name `PipeWrap` and not one owner. Asserting the
  // registration is the only thing that stops the empty literal coming back,
  // because nothing else about this file changes when it does.
  it('registers every async child it spawns with the whole-file deadline (#1653)', () => {
    const before = deadlineOptions.children().length;
    const box = sandbox(['normal']);
    const loop = box.start();
    const registered = deadlineOptions.children().slice(before);
    try {
      assert.equal(
        registered.length,
        1,
        `start() must register exactly one child with the deadline; it registered ${registered.length}`,
      );
      const [child] = registered;
      assert.match(child.label, /sweep-loop\.sh in /, 'the label must name the sandbox, so a breach traces to one test');
      assert.equal(child.pid, loop.pid, 'the registered pid must be the loop the caller was handed');
      assert.equal(typeof child.isRunning, 'function', 'the deadline calls isRunning() at breach time');
      assert.equal(typeof child.killNow, 'function', 'the deadline reaps with killNow()');
    } finally {
      for (const child of registered) child.killNow();
    }
    // Still returned *after* death. The breach report reads this accessor to
    // name a child that outlived its work, so unregistering on `close` would
    // erase the one entry the report exists to print.
    assert.equal(
      deadlineOptions.children().length,
      before + 1,
      'a child must stay registered after it exits, or a breach cannot name it',
    );
  });

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
    // This host's pid_max exactly (4194304). The kernel hands out 1..pid_max-1
    // and wraps to 1, so pid_max itself is never assigned — unlike pid_max-1,
    // which is a real, assignable pid and only unreachable by luck.
    writeFileSync(join(box.lock, 'pid'), '4194304\n');

    const result = box.run();

    assert.match(result.output, /reclaiming the lock left by dead pid 4194304/);
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
    assert.match(result.output, /failed 3 batches running \(last exit=1, last failure: no report\)/);
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

  it('reads a zero-padded knob as decimal, so a value above the maximum is still clamped', () => {
    // $(( 099 )) is a parse error in bash, not a comparison — and a parse
    // error raised inside (( )) is swallowed by the if, so both the minimum
    // check and the clamp are skipped and the raw digits reach the gauntlet,
    // whose parseInt(_, 10) turns 099 into 99 calls.
    const overPage = sandbox(['normal']).run({ BATCH: '099' });
    assert.match(overPage.output, /BATCH=099 is above the supported maximum 50 — clamping/, overPage.output);
    assert.doesNotMatch(overPage.output, /value too great for base/, 'no arithmetic parse error may reach the operator');
    assert.equal(overPage.status, 3, overPage.output);
    assert.equal(overPage.invocations[0]?.batch, '50', '099 is above the API page size, so the clamp has to reach the gauntlet');

    const overPageOctalShape = sandbox(['normal']).run({ BATCH: '055' });
    assert.equal(overPageOctalShape.invocations[0]?.batch, '50', overPageOctalShape.output);

    const ten = sandbox(['normal']).run({ BATCH: '010' });
    assert.equal(ten.invocations[0]?.batch, '10', 'BATCH=010 is ten, not the octal eight $(( )) reads it as');

    const belowMin = sandbox(['normal']).run({ BATCH: '0000' });
    assert.equal(belowMin.status, 2, belowMin.output);
    assert.match(belowMin.output, /BATCH must be at least 1/);
    assert.deepEqual(belowMin.invocations, []);
  });

  it('does the quota backoff in decimal, so a padded INTERVAL still pauses', () => {
    const box = sandbox(['quota']);

    const result = box.run({ INTERVAL: '090', MAX_BATCHES: '1' });

    assert.match(result.output, /quota wall detected — backing off 180s/, result.output);
    assert.equal(result.status, 3, result.output);
    assert.doesNotMatch(result.output, /value too great for base/, result.output);
  });

  it('rejects an empty REPORT instead of sweeping onto the git-tracked default', () => {
    const box = sandbox(['normal']);

    const result = box.run({ REPORT: '' });

    assert.equal(result.status, 2, result.output);
    assert.match(result.output, /REPORT must not be empty/);
    assert.deepEqual(result.invocations, [], 'nothing may run when the path is unusable');
    assert.equal(
      existsSync(box.report),
      false,
      'an exported-but-empty REPORT is the operator mistake this guard exists for, not a request for the default path',
    );
    assert.equal(existsSync(join(box.dir, 'memory')), false, 'the default directory must not even be created');
  });

  it('derives the report directory of a root-level path instead of handing mkdir an empty operand', () => {
    const box = sandbox(['normal']);
    const log = join(box.dir, 'mkdir-calls.log');
    const path = box.shim('mkdir', `printf '%s\\n' "$*" >> "$SWEEP_MKDIR_LOG"\nexec mkdir "$@"`);
    // A path whose only slash is the leading one: ${REPORT%/*} is empty, and an
    // empty operand is what the raw tool rejected with an undocumented exit 1.
    const rootReport = `/sweep-loop-guard-${process.pid}.json`;

    try {
      const result = box.run({ PATH: path, SWEEP_MKDIR_LOG: log, REPORT: rootReport, MAX_BATCHES: '1' });
      const calls = readFileSync(log, 'utf8').split('\n').filter(Boolean);
      assert.ok(calls.includes('-p -- /'), `the root directory has to be created explicitly; mkdir saw: ${calls.join(' | ')}`);
      assert.ok(
        calls.every((call) => call.trim() !== '-p --' && call.trim() !== '--'),
        `mkdir was handed an empty operand: ${calls.join(' | ')}`,
      );
      assert.notEqual(result.status, 1, `a raw mkdir failure is not a documented exit code:\n${result.output}`);
    } finally {
      rmSync(rootReport, { force: true });
    }
  });

  it('passes -- down the whole report-path chain, so a leading dash or a space is a usable path', () => {
    const dashed = sandbox(['normal']);
    const dashResult = dashed.run({ REPORT: '-x/r.json' });
    assert.equal(dashResult.status, 3, dashResult.output);
    assert.equal(
      markerOf(join(dashed.dir, '-x/r.json')),
      'complete-batch',
      'every mkdir, mktemp, mv and rm in the chain has to take the path as an operand, not an option',
    );
    assert.deepEqual(readdirSync(join(dashed.dir, '-x')), ['r.json'], 'the lock and the staging file must not survive');

    const spaced = sandbox(['normal']);
    const spaceResult = spaced.run({ REPORT: 'memory dir/live report.json' });
    assert.equal(spaceResult.status, 3, spaceResult.output);
    assert.equal(markerOf(join(spaced.dir, 'memory dir/live report.json')), 'complete-batch', spaceResult.output);
  });

  it('exits 5 rather than 3 when the run ends with a batch that recorded nothing', () => {
    // MAX_BATCHES 1 and 2 are below the three-batches threshold, so a gauntlet
    // that dies every batch used to exit 3 — telling automation to re-run
    // something that cannot succeed.
    for (const max of ['1', '2']) {
      const box = sandbox(['crash']);
      const result = box.run({ MAX_BATCHES: max });
      assert.equal(result.status, 5, `MAX_BATCHES=${max} must not report a crash as resumable:\n${result.output}`);
      assert.match(result.output, /MAX_BATCHES \(\d+\) reached with \d+ batch\(es\) running that failed \(last failure: no report\)/, result.output);
      assert.doesNotMatch(result.output, /run again later to continue/, 'the resumable message must not be printed for a failing run');
    }

    const clean = sandbox(['normal']).run({ MAX_BATCHES: '1' });
    assert.equal(clean.status, 3, `a run where every batch was accounted for stays resumable:\n${clean.output}`);
  });

  it('does not claim the report is unchanged when a batch of the run did publish', () => {
    // A flaky sweep loses a batch *among* good ones — the ordinary case, and
    // the one a plan of nothing but crashes never reaches. Both exit-5 paths
    // used to end "the report is unchanged" here, so the message denied that
    // the run had advanced the very artifact the script exists to protect.
    const lostLast = sandbox(['crash', 'normal']);
    const maxBatches = lostLast.run({ MAX_BATCHES: '2' });

    assert.equal(maxBatches.status, 5, maxBatches.output);
    assert.equal(
      markerOf(lostLast.report),
      'complete-batch',
      'the surviving batch must have been published — otherwise there is nothing for the message to be honest about',
    );
    assert.doesNotMatch(
      maxBatches.output,
      /the report is unchanged/,
      `batch 2 published over the report, so this claim is false:\n${maxBatches.output}`,
    );
    assert.match(maxBatches.output, /the report is left at its last complete batch/, maxBatches.output);

    const lostThird = sandbox(['crash', 'normal', 'crash', 'crash']);
    const threshold = lostThird.run({ MAX_BATCHES: '10' });

    assert.equal(threshold.status, 5, threshold.output);
    assert.equal(
      markerOf(lostThird.report),
      'complete-batch',
      'the three-batches-running path reaches the same false claim: batch 2 published before the crashes',
    );
    assert.doesNotMatch(
      threshold.output,
      /the report is unchanged/,
      `the threshold message is just as wrong once any batch has published:\n${threshold.output}`,
    );
    assert.match(
      threshold.output,
      /failed 3 batches running \(last exit=1, last failure: no report\); the report is left at its last complete batch/,
      threshold.output,
    );
  });

  // #1346. The regression is anchored on the case that currently slips
  // through — a batch that COMPLETED, banner and all — because a test that
  // merely says "a mutation fails the loop" is worth little if it would also
  // pass with the grep condition removed in the other direction.
  it('fails a completed batch whose mutation proof blocks, banner present or not', () => {
    // The old guard was `code != 0 && ! grep -q 'batch run finished'`, and the
    // banner is printed before the report is written — so on a completed batch
    // it is always present and the guard could never fire. MAX_BATCHES 1 puts
    // the threshold out of reach, so this is decided entirely by whether the
    // blocking proof fails the batch on its own.
    const mutated = sandbox(['mutation-detected']);

    const result = mutated.run({ MAX_BATCHES: '1' });

    assert.equal(result.status, 5, `a detected mutation must not read as a resumable stop:\n${result.output}`);
    assert.match(
      result.output,
      /recorded mutation proof MUTATIONS_DETECTED — it completed the batch \(present\) and still could not show the account was left alone/,
      result.output,
    );
    assert.doesNotMatch(
      result.output,
      /run again later to continue/,
      `the resumable message must not be printed for a batch that detected a mutation:\n${result.output}`,
    );
    // The report is the evidence and is published, not discarded: the failure
    // is that the account was mutated, not that the loop lost the artifact.
    assert.equal(markerOf(mutated.report), 'complete-batch', result.output);
  });

  it('fails a completed batch whose proof is UNVERIFIED, and names that status', () => {
    const unverified = sandbox(['unverified']);

    const result = unverified.run({ MAX_BATCHES: '1' });

    assert.equal(result.status, 5, result.output);
    assert.match(result.output, /recorded mutation proof UNVERIFIED — it completed the batch \(present\)/, result.output);
  });

  it('fails a completed batch that detected a mutation even when it is the last batch of the run', () => {
    // Same verdict at MAX_BATCHES: a blocking proof must not be reported as
    // the run's resumable stop.
    const mutated = sandbox(['mutation-detected', 'mutation-detected']);

    const result = mutated.run({ MAX_BATCHES: '2' });

    assert.equal(result.status, 5, result.output);
    assert.match(result.output, /reached with 2 batch\(es\) running that failed \(last failure: mutation proof MUTATIONS_DETECTED\)/, result.output);
    assert.equal(result.invocations.length, 2, result.output);
  });

  it('does not read SWEEP_COMPLETE as a clean finish when the gauntlet exited non-zero', () => {
    // The completion path of the same defect: the real gauntlet prints
    // SWEEP_COMPLETE and then exits 'proofBlocksExit(completeProof) ? 1 : 0', so
    // a sweep whose cumulative proof blocks announces completion and exits 1.
    // The loop read the marker alone, so the one batch that carries the whole
    // run's verdict was the one that could not fail.
    const box = sandbox(['complete-mutated']);
    seedReport(box, 'previous-batch');

    const result = box.run({ MAX_BATCHES: '1' });

    assert.equal(result.status, 5, `a completed-but-mutating sweep is not a clean sweep:\n${result.output}`);
    assert.doesNotMatch(result.output, /SWEEP DONE/, result.output);
    assert.match(
      result.output,
      /reported SWEEP_COMPLETE but exited 1 — every tool is recorded and its mutation proof \(MUTATIONS_DETECTED\) does not allow a claim/,
      result.output,
    );
    // The completion fast path writes no report, so the last complete one stands.
    assert.equal(markerOf(box.report), 'previous-batch', result.output);
  });

  it('still reports a completed sweep as done when the gauntlet exits 0', () => {
    // The other direction: the fix must not turn a genuinely clean finish into
    // a failure. A blocking proof is the discriminator, not the exit code.
    const box = sandbox(['complete']);

    const result = box.run({ MAX_BATCHES: '1' });

    assert.equal(result.status, 0, result.output);
    assert.match(result.output, /SWEEP DONE after 1 batches/, result.output);
  });

  it('keeps a completed batch whose only non-zero cause is a recorded tool FAIL resumable', () => {
    // `counts.FAIL || proofBlocksExit(proof)` — exit 1 also means a tool FAILED
    // (a quota wall, a gated endpoint). That batch published its report and
    // --resume retries those tools later, which is precisely what exit 3 means.
    // Treating every non-zero exit as a failed batch would make one bad tool
    // count toward the three-batch threshold and stop a healthy sweep.
    const box = sandbox(['fails-only', 'fails-only', 'fails-only', 'fails-only']);

    const result = box.run({ MAX_BATCHES: '4' });

    assert.equal(result.status, 3, `recorded FAILs are resumable, not a failure:\n${result.output}`);
    assert.match(result.output, /MAX_BATCHES \(4\) reached — run again later to continue/, result.output);
    assert.equal(result.invocations.length, 4, 'a recorded FAIL must not trip the three-batch threshold');
  });

  it('does not read a printed banner as a verdict when the proof line is missing', () => {
    // The banner is printed before the report is written and the proof line is
    // rendered after it, so a process killed in between leaves a log that looks
    // like a finished batch. "Reached the end of a batch" is progress; whether
    // the account was left alone is a separate claim, and an unrecorded one is
    // not a pass.
    const box = sandbox(['no-proof']);

    const result = box.run({ MAX_BATCHES: '1' });

    assert.equal(result.status, 5, `a batch with no recorded verdict is not a resumable pause:\n${result.output}`);
    assert.match(
      result.output,
      /printed its end-of-batch banner \(present\) but no "mutation proof:" line/,
      result.output,
    );
    assert.doesNotMatch(result.output, /run again later to continue/, result.output);
  });

  it('counts a batch that lost its report once, so the threshold really is three batches', () => {
    const box = sandbox(['truncated-silent']);

    const result = box.run({ MAX_BATCHES: '4' });

    assert.equal(result.status, 5, result.output);
    assert.match(result.output, /failed 3 batches running \(last exit=1, last failure: no report\)/, result.output);
    assert.equal(
      result.invocations.length,
      3,
      'a truncated report and a non-zero exit are one failed batch, not two — otherwise the threshold trips half as early',
    );
  });

  it('names the live owner when reclaiming a dead lock loses the race', () => {
    const box = sandbox(['normal']);
    mkdirSync(box.lock, { recursive: true });
    // The never-assigned pid: this host's pid_max itself, so no live process
    // can own it (see the sibling test for why pid_max-1 will not do).
    writeFileSync(join(box.lock, 'pid'), '4194304\n');
    // Force the window between the reclaiming rm and the second mkdir: the
    // shim puts the lock back, held by this test's own (live) pid.
    const marker = join(box.dir, 'race-won');
    const path = box.shim('rm', [
      'target=""',
      'for a in "$@"; do target=$a; done',
      'if [[ $target == *.sweep-loop.lock ]] && [[ ! -e $SWEEP_RACE_MARKER ]]; then',
      '  rm -rf -- "$target"',
      '  mkdir -p -- "$target"',
      '  printf \'%s\\n\' "$SWEEP_RACE_PID" > "$target/pid"',
      '  : > "$SWEEP_RACE_MARKER"',
      '  exit 0',
      'fi',
      'exec rm "$@"',
    ].join('\n'));

    const result = box.run({
      PATH: path,
      SWEEP_RACE_PID: String(process.pid),
      SWEEP_RACE_MARKER: marker,
      MAX_BATCHES: '1',
    });

    assert.equal(result.status, 4, result.output);
    assert.match(
      result.output,
      new RegExp(`another sweep loop \\(pid ${process.pid}\\) already holds`),
      `the refusal has to name the loop that is actually holding the lock:\n${result.output}`,
    );
    assert.doesNotMatch(result.output, /pid 4194304 already holds/, 'that pid was just reclaimed as dead; reporting it is unactionable');
    assert.deepEqual(result.invocations, [], 'the refused loop must not drive a gauntlet');
  });

  it('publishes the report with the mode the in-place write left, not mktemp\'s 0600', () => {
    const box = sandbox(['normal']);
    seedReport(box, 'previous-batch');
    chmodSync(box.report, 0o644);

    const result = box.run();

    assert.equal(result.status, 3, result.output);
    assert.equal(
      statSync(box.report).mode & 0o777,
      0o644,
      'mktemp creates 0600 and the rename keeps it, which would narrow the tracked report to its owner',
    );
  });

  it('reclaims a lock that names no owner, which is what a crash between mkdir and the pid write leaves', () => {
    // `mkdir "$LOCK"` and the write of the pid into it are two syscalls, so a
    // loop killed in between leaves a lock directory that owns nothing. Nothing
    // in it matches ^[0-9]+$, so the dead-owner test had no pid to test and no
    // path to reclaim on: the lock was unreclaimable for ever, and every later
    // run refused with "pid unknown" until an operator removed it by hand. A
    // lock that outlives the loop that leaked it is the one failure mode the
    // lock exists to prevent.
    for (const damage of [
      { label: 'no pid file at all', write: () => {} },
      { label: 'an empty pid file', write: (lock: string) => writeFileSync(join(lock, 'pid'), '') },
      { label: 'a pid file holding two pids', write: (lock: string) => writeFileSync(join(lock, 'pid'), '4194304\n41\n') },
      { label: 'a pid file holding something that is not a pid', write: (lock: string) => writeFileSync(join(lock, 'pid'), 'not-a-pid\n') },
    ]) {
      const box = sandbox(['normal']);
      mkdirSync(box.lock, { recursive: true });
      damage.write(box.lock);

      const result = box.run();

      assert.match(result.output, /reclaiming .*\.sweep-loop\.lock/, `${damage.label}: ${result.output}`);
      assert.equal(result.invocations.length, 1, `${damage.label}: the sweep has to actually run\n${result.output}`);
      assert.equal(result.status, 3, `${damage.label}: ${result.output}`);
    }
  });

  it('respects a lock whose owner identifies itself just after the mkdir, so the reclaim wait is not a hole', () => {
    // The fix above has to tell two locks apart: wreckage, and a competing loop
    // that won the mkdir microseconds ago and has not written its pid yet. The
    // second is a live loop, so reclaiming it would run two sweeps against one
    // report — the exact interleaving the lock exists to prevent. This is the
    // guard on that distinction.
    const box = sandbox(['normal']);
    mkdirSync(box.lock, { recursive: true });
    const latecomer = spawn(
      'bash',
      ['-c', `sleep 0.5\nprintf '%s\\n' "${process.pid}" > "$1/pid"`, 'bash', box.lock],
      { stdio: 'ignore' },
    );
    // `stdio: 'ignore'` means this one cannot leak a `PipeWrap`, but it is still
    // a live child holding a pid, and the deadline reaps by recorded pid — so it
    // belongs in the list. Skipping it would leave a `sleep` behind on a breach.
    adoptLoop(latecomer, `latecomer lock-claimer in ${basename(box.dir)}`);

    try {
      const result = box.run();

      assert.equal(result.status, 4, result.output);
      assert.match(
        result.output,
        new RegExp(`another sweep loop \\(pid ${process.pid}\\) already holds`),
        `the owner that did name itself has to be the pid reported, not "unknown":\n${result.output}`,
      );
      assert.deepEqual(result.invocations, [], 'a refused loop must not drive a gauntlet');
    } finally {
      latecomer.kill();
    }
  });

  it('releases the lock and keeps its exit code when a cleanup step fails', () => {
    // cleanup() runs under `set -e`, so a single failing `rm` used to abort the
    // function with the lock still on disk — the artefact outliving the run
    // that leaked it — and with the script's exit status replaced by the rm's.
    // The SWEEP_COMPLETE path is the one that leaves a staging file behind for
    // cleanup to deal with, so that is where the failure is staged.
    const box = sandbox(['complete']);
    const shim = box.shim('rm', [
      'target=""',
      'for a in "$@"; do target=$a; done',
      'if [[ $target == *.tmp.* ]]; then echo "rm: cannot remove \'$target\': Permission denied" >&2; exit 1; fi',
      'exec rm "$@"',
    ].join('\n'));

    const result = box.run({ PATH: shim });

    assert.equal(
      result.status,
      0,
      `a completed sweep is 0 whatever the cleanup had to do; a failing rm must not relabel it:\n${result.output}`,
    );
    assert.equal(
      existsSync(box.lock),
      false,
      'the lock has to be released even when an earlier cleanup step fails',
    );
  });

  it('honours a signal during the inter-batch pause instead of waiting the pause out', async () => {
    // bash services a trap only between commands, so a foreground `sleep` made
    // a signal land whenever the pause happened to end — up to INTERVAL seconds
    // away, and twice that after a quota wall. The operator's only way out was
    // kill -9, which cannot run a trap either and so leaves the lock behind.
    const box = sandbox(['normal']);
    const child = box.start({ INTERVAL: '3600', MAX_BATCHES: '5' });

    // The line is printed immediately before the pause begins, so it is the
    // point at which the loop is provably in a 3600s sleep.
    await until(() => /sleeping 3600s before next batch/.test(child.output()));
    assert.ok(alive(child.pid), 'the loop must still be paused, not already past it');

    const ended = Date.now();
    process.kill(child.pid, 'SIGTERM');
    const stopped = await waitForExit(child.pid);
    const elapsed = Date.now() - ended;

    assert.ok(stopped, `the loop ignored SIGTERM for ${elapsed}ms of a 3600s pause`);
    const result = await child.done;
    assert.equal(result.status, 143, result.output);
    assert.match(result.output, /terminated/, result.output);
    assert.equal(
      existsSync(box.lock),
      false,
      'a signalled loop must still release the lock, or the next run refuses for ever',
    );
    assert.ok(
      elapsed < 5_000,
      `a signalled loop stopped in ${elapsed}ms, which is not "at once" — the pause is still blocking the trap`,
    );
  });
});
