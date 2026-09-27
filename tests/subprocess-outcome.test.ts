/**
 * #1335 — a contention artifact must not be reportable as a product defect.
 *
 * ## Why this file exists
 *
 * A full parallel `npm test` run reported four test files failing, all of them
 * passing in isolation, with the cause unestablished. The most informative
 * failure was an assertion that read:
 *
 * ```
 * doctor misreported SPOTIFY_MCP_READONLY="ON" as off
 * ```
 *
 * That sentence asserts something about the server: that it reported the wrong
 * flag. It was not evidence of that. The assertion read the doctor
 * subprocess's `stdout`, and `stdout` is empty whenever the child did not get
 * far enough to print — which is what a doctor subprocess does on a
 * memory-starved, heavily loaded box. It died during module load, printed no
 * Configuration block, the regex did not match, and the suite reported a
 * product bug.
 *
 * The guard that should have caught it could not:
 *
 * ```ts
 * assert.equal(result.signal, null, `doctor must exit, not be killed (${result.signal})`);
 * ```
 *
 * `spawnSync` reports `signal: null` for a child that was never started. So the
 * guard passed a subprocess that had not executed a line, and the helper
 * returned `stdout` while dropping `stderr` — discarding the one stream that
 * said `FATAL ERROR: Reached heap limit Allocation failed`.
 *
 * The same shape appeared inverted in `tests/doc-figures.test.ts`, where
 * `result.status ?? 1` mapped a signal-killed child (`status: null`) onto
 * "exited 1" — at that line, indistinguishable from a gate that ran and
 * correctly rejected a document. (Those three callers each also assert on the
 * output, so the effect there was a failure against an empty string rather
 * than a silent false pass. Same misreport, less severe.)
 *
 * ## What is being pinned
 *
 * That a dead child and a child that ran are **distinguishable at the point of
 * judgement**, in both directions, and that the distinguishing failure carries
 * the child's stderr. This is a fix to how the suite *reports*, and its
 * regression test has to fail for the right reason: reintroduce the old
 * `signal === null` / `status ?? 1` logic and the first two `it`s below go
 * red, while the real-subprocess cases stay green.
 *
 * The last `describe` is the part that cannot be faked: it runs a genuine
 * child process and kills it, so the shapes asserted above are the shapes Node
 * actually produces rather than the shapes a hand-written object claims.
 */
import './helpers/hermetic.js';

import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';

import {
  assertChildRan,
  childExitCode,
  classifyChild,
  describeOutcome,
  type RawChildResult,
} from './helpers/subprocess-outcome.js';

/** Run `body` and return the `assert.throws` message it produced. */
function failureMessage(run: () => unknown): string {
  try {
    run();
  } catch (error) {
    return (error as Error).message;
  }
  return assert.fail('expected this to throw, and it did not');
}

describe('a child that never ran is not a child that answered (#1335)', () => {
  it('does not read a never-started child as a clean exit', () => {
    // The exact shape `spawnSync` returns when fork/exec fails. `signal` is
    // `null` here — that is the whole point, and the reason the old
    // `assert.equal(result.signal, null, …)` guard could not catch it.
    const neverStarted: RawChildResult = { error: { code: 'ENOENT' }, signal: null, status: null };
    assert.equal(classifyChild(neverStarted).kind, 'not-started');
    assert.match(describeOutcome(classifyChild(neverStarted)), /never started/);
  });

  it('separates a signal-killed child from one that exited non-zero', () => {
    // Both have empty stdout, and the old `status ?? 1` collapsed them.
    // A doctor subprocess killed by the OOM killer and one that legitimately
    // exits 1 (no token file — the normal case) must stay distinct.
    const killed: RawChildResult = { signal: 'SIGKILL', status: null, stdout: '', stderr: '' };
    const exitedOne: RawChildResult = { signal: null, status: 1, stdout: '', stderr: '' };
    assert.equal(classifyChild(killed).kind, 'signalled');
    assert.equal(classifyChild(exitedOne).kind, 'exited');
    // And the exit code really is preserved rather than flattened to 1.
    assert.equal(childExitCode(exitedOne, 'doctor'), 1);
  });

  it('reports a dead child as a subprocess failure, never as a product one', () => {
    // This is the assertion the issue quoted, re-run against a child that
    // never started. Before the fix this reached the product assertion and
    // produced "doctor misreported SPOTIFY_MCP_READONLY=… as off".
    const died: RawChildResult = {
      error: { code: 'ENOMEM' },
      signal: null,
      status: null,
      stderr: 'FATAL ERROR: Reached heap limit Allocation failed - JavaScript heap out of memory',
    };
    const message = failureMessage(() => assertChildRan(died, 'spotify-mcp doctor'));
    assert.match(message, /subprocess never started \(ENOMEM\)/);
    assert.match(message, /produced no report to check/);
    // The child's own reason must survive into the message, or the next agent
    // is back to guessing — which is what happened in #1335.
    assert.match(message, /Reached heap limit/, 'the child stderr must be quoted, not discarded');
    // And it must NOT read as a defect report against the product.
    assert.doesNotMatch(message, /misreported SPOTIFY_MCP_READONLY/);
  });

  it('refuses to read a killed child as a gate that rejected', () => {
    // The doc-figures direction. `assert.notEqual(code, 0)` must not be
    // reachable by a gate that never ran.
    const killed: RawChildResult = { signal: 'SIGABRT', status: null, stdout: '', stderr: 'out of memory' };
    const message = failureMessage(() => childExitCode(killed, 'check-doc-tool-counts'));
    assert.match(message, /killed by SIGABRT/);
    assert.match(message, /instead of exiting, so its verdict is unknown/);
    assert.match(message, /must not be read as a gate that ran and rejected/);
  });

  it('treats a timeout as never-started, not as a kill', () => {
    // A timed-out child carries BOTH `error.code === 'ETIMEDOUT'` AND
    // `signal === 'SIGTERM'`. Classifying on `signal` first would file the
    // timeout under "killed", which is a different diagnosis and sends the
    // reader looking in the wrong place.
    const timedOut: RawChildResult = { error: { code: 'ETIMEDOUT' }, signal: 'SIGTERM', status: null };
    assert.equal(classifyChild(timedOut).kind, 'not-started');
    assert.match(describeOutcome(classifyChild(timedOut)), /ETIMEDOUT/);
  });

  it('still returns a report from a child that ran and exited non-zero', () => {
    // The anti-overcorrection. Doctor exits 1 with no token file as a matter of
    // course, and the callers assert on its stdout. A fix that required exit 0
    // would have broken every doctor test in the suite, and a fix that gave up
    // on non-zero exits would have stopped checking the flag at all.
    const real: RawChildResult = {
      signal: null,
      status: 1,
      stdout: 'Configuration:\n  readonly          yes\n',
      stderr: 'Doctor found problems.',
    };
    assert.equal(assertChildRan(real, 'spotify-mcp doctor'), 'Configuration:\n  readonly          yes\n');
  });
});

/**
 * The same boundaries, against real child processes.
 *
 * Everything above is a hand-built object, so it can only prove the classifier
 * agrees with the shapes its author believed in. These run actual children and
 * kill them, which is what makes the table in the helper's header a measurement
 * rather than an assumption.
 */
describe('the shapes above are the shapes Node produces (#1335)', () => {
  const node = process.execPath;

  it('a SIGKILLed child reports status null and a non-null signal', () => {
    const killed = spawnSync(node, ['-e', 'process.kill(process.pid, "SIGKILL")'], { encoding: 'utf8' });
    const outcome = classifyChild(killed);
    assert.equal(outcome.kind, 'signalled');
    assert.equal(outcome.signal, 'SIGKILL');
    assert.equal(killed.status, null, 'a signalled child has no exit status — this is what `?? 1` swallowed');
  });

  it('a never-started child reports signal null, exactly as the old guard assumed', () => {
    // The load-bearing measurement. If this ever stops holding, the bug this
    // file fixes was never the bug, and the helper's header is wrong.
    const missing = spawnSync('/nonexistent/binary/doctor', [], { encoding: 'utf8' });
    // `SpawnSyncReturns.error` is typed as a bare `Error`, which has no
    // `code`. The runtime value is a `NodeJS.ErrnoException`; naming that
    // type keeps the read checked, where `as any` would have let any
    // property through.
    assert.equal((missing.error as NodeJS.ErrnoException | undefined)?.code, 'ENOENT');
    assert.equal(missing.signal, null, 'a child that never ran still reports signal === null');
    assert.equal(classifyChild(missing).kind, 'not-started');
    // So the pre-fix guard would have passed it and returned `undefined` stdout.
    assert.equal(missing.stdout, undefined);
  });

  it('a child that exits non-zero is `exited`, not `signalled`', () => {
    const exited = spawnSync(node, ['-e', 'process.exit(7)'], { encoding: 'utf8' });
    assert.equal(classifyChild(exited).kind, 'exited');
    assert.equal(childExitCode(exited, 'doctor'), 7);
  });

  it('execFileSync reports the same shapes, so both call sites are covered', () => {
    // `doc-figures` uses execFileSync and `config-readonly` uses spawnSync, so
    // the classifier has to hold for the error object as well as the return
    // value. They are the same shape, which is why one helper covers both.
    let thrown: RawChildResult | undefined;
    try {
      execFileSync(node, ['-e', 'process.kill(process.pid, "SIGKILL")'], { encoding: 'utf8' });
    } catch (error) {
      thrown = error as RawChildResult;
    }
    assert.ok(thrown, 'a signalled child must make execFileSync throw');
    assert.equal(thrown.signal, 'SIGKILL');
    assert.equal(thrown.status, null);
    assert.equal(classifyChild(thrown).kind, 'signalled');
    assert.throws(() => childExitCode(thrown!, 'gate'), /killed by SIGKILL/);
  });
});

/**
 * The end-to-end check: the real doctor helper, against a real doctor that
 * failed to start.
 *
 * `config-readonly.test.ts` builds its own `runDoctor`, so the wiring between
 * that call site and the helper is not covered by either file alone. This
 * drives the same helper against the same command with a `cwd` that does not
 * exist, which is a failure mode a loaded box can produce on its own (a
 * worktree moved or a bind mount dropped mid-run) and which no amount of
 * checking inside the child would ever report.
 */
describe('the doctor call site reports a failed subprocess as such (#1335)', () => {
  const node = process.execPath;

  it('a doctor that cannot start fails as a subprocess, not as a flag verdict', () => {
    const result = spawnSync(
      node,
      ['--import', 'tsx', 'src/index.ts', 'doctor'],
      {
        encoding: 'utf8',
        // A cwd that does not exist: node exits non-zero having printed
        // nothing, which is the same observable shape as a child killed during
        // module load, and is fully deterministic.
        cwd: '/nonexistent/cwd/for/1335',
        env: { ...process.env, HOME: '/nonexistent/home/for/1335' },
      },
    );
    const message = failureMessage(() => assertChildRan(result, 'spotify-mcp doctor'));
    assert.match(message, /spotify-mcp doctor: the subprocess (exited \d+|never started|killed by)/);
    assert.match(message, /NOT a product failure/);
  });
});

after(() => {
  // Nothing to tear down: every child in this file is synchronous and has
  // already been reaped by the time its assertion returns. The `after` exists
  // so a future async child added here has an obvious home rather than none.
  assert.ok(true);
});
