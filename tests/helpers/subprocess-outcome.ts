/**
 * Subprocess outcome classification (#1335).
 *
 * ## The defect this exists to close
 *
 * Four test files were reported failing in a full parallel `npm test` run and
 * passing in isolation, with the cause unestablished (#1335). One of the quoted
 * failures was:
 *
 * ```
 * AssertionError: doctor misreported SPOTIFY_MCP_READONLY="ON" as off
 *     at tests/config-readonly.test.ts:284
 * ```
 *
 * That message is a **claim about the product** — it says the server reported
 * the wrong flag state. It is not evidence of that. The assertion reads
 * `result.stdout`, and `stdout` is empty whenever the child did not get far
 * enough to print anything. Under load on a memory-starved box that is exactly
 * what a doctor subprocess does: it is killed or fails during module load, it
 * exits without printing the Configuration block, `stdout` is `''`, and the
 * regex does not match. The test then reports a product defect that does not
 * exist.
 *
 * The prior guard could not tell the two apart:
 *
 * ```ts
 * assert.equal(result.signal, null, `doctor must exit, not be killed (${result.signal})`);
 * return result.stdout;
 * ```
 *
 * `spawnSync` reports `signal: null` for a child that was never killed at all.
 * Measured shapes (Node 24.21.0, this helper's own test drives each one):
 *
 * | child outcome              | `error.code` | `signal` | `status` | `stdout` |
 * |----------------------------|--------------|----------|----------|----------|
 * | ran, exited 0              | —            | `null`   | `0`      | `''`      |
 * | ran, exited 7              | —            | `null`   | `7`      | `''`      |
 * | killed by SIGKILL          | —            | SIGKILL  | `null`   | `''`      |
 * | killed by SIGABRT (heap)   | —            | SIGABRT  | `null`   | `''`      |
 * | never started (ENOENT)     | ENOENT       | `null`   | `null`   | undefined |
 * | timed out                  | ETIMEDOUT    | SIGTERM  | `null`   | `''`      |
 *
 * So `signal === null` covers *both* "ran and exited 7" and "never started".
 * A guard written against it passes a child that never executed a single line
 * of the code under test. And because the helper returned `stdout` and dropped
 * `stderr`, the one stream that would have said `FATAL ERROR: Reached heap
 * limit` was discarded before the assertion could quote it.
 *
 * ## Why this is a correctness fix and not a diagnostics nicety
 *
 * AGENTS.md §6: *a correctly named payload field can still lie about its
 * value.* The failure here is the same shape one layer out. The field is
 * `stdout`, the declared type is "the doctor's report", and the value is
 * "whatever the child managed to print before it died" — a string whose
 * emptiness carries no information about the product. A test that reads it and
 * reports the shortfall as a product bug is manufacturing a defect report out
 * of a resource condition.
 *
 * That is the expensive failure. An agent that cannot tell a contention
 * artifact from a real bug has to spend hours — or file a false issue, as
 * happened with #1339 — to separate them. So the fix is not to make the
 * assertion more tolerant. It is to make the two cases **name themselves**: a
 * child that never produced a report fails as *the subprocess did not run*,
 * carrying its stderr, and never reaches the product assertion at all.
 *
 * ## What this deliberately does not do
 *
 * It does not retry, does not raise a timeout, and does not relax any
 * assertion. `assertChildRan` throwing on a dead child makes the suite *more*
 * likely to go red on a loaded box, not less — which is the correct direction.
 * A contention artifact should be a loud, self-describing failure, never a
 * quiet one wearing a product bug's clothes.
 */

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';

/** How a child process ended, as reported by `spawnSync`/`execFileSync`. */
export type ChildOutcome =
  /** The child ran to completion and exited with this code. */
  | { readonly kind: 'exited'; readonly code: number; readonly stdout: string; readonly stderr: string }
  /** The child was terminated by a signal (`SIGKILL`, `SIGABRT`, …). */
  | { readonly kind: 'signalled'; readonly signal: string; readonly stdout: string; readonly stderr: string }
  /** The child never started: fork/exec failed, or the timeout elapsed. */
  | { readonly kind: 'not-started'; readonly reason: string; readonly stdout: string; readonly stderr: string };

/** The subset of a `SpawnSyncReturns`/`ExecFileSync` error this reads. */
export interface RawChildResult {
  readonly error?: { readonly code?: string; readonly message?: string } | undefined;
  readonly signal?: string | null | undefined;
  readonly status?: number | null | undefined;
  readonly stdout?: string | null | undefined;
  readonly stderr?: string | null | undefined;
}

/**
 * Classify a child result into the three outcomes that actually differ.
 *
 * The ordering matters and is load-bearing. `error` is checked first because a
 * timed-out child carries BOTH `error.code === 'ETIMEDOUT'` **and**
 * `signal === 'SIGTERM'`, and a child that never started carries
 * `error.code === 'ENOENT'` with `signal === null`. Checking `signal` first
 * would file the timeout under "killed", and checking `signal === null` as the
 * success test — the bug this replaces — files the never-started child under
 * "ran fine".
 */
export function classifyChild(result: RawChildResult): ChildOutcome {
  const stdout = result.stdout ?? '';
  const stderr = result.stderr ?? '';

  if (result.error) {
    const reason = result.error.code ?? result.error.message ?? 'unknown error';
    return { kind: 'not-started', reason, stdout, stderr };
  }
  if (result.signal) {
    return { kind: 'signalled', signal: result.signal, stdout, stderr };
  }
  return { kind: 'exited', code: result.status ?? 0, stdout, stderr };
}

/**
 * A one-line, greppable description of how a child died.
 *
 * `SIGABRT` from a heap exhaustion and `SIGKILL` from the OOM killer are the
 * two that matter on a shared box, and both are named rather than summarised,
 * because the reader's next question is always "was this the box or the code?"
 */
export function describeOutcome(outcome: ChildOutcome): string {
  switch (outcome.kind) {
    case 'exited':
      return `exited ${outcome.code}`;
    case 'signalled':
      return `killed by ${outcome.signal}`;
    case 'not-started':
      return `never started (${outcome.reason})`;
  }
}

/**
 * The stderr tail, so a fatal error in the child is quoted rather than dropped.
 *
 * Exported so a caller that reports a child's death *itself* — rather than
 * through `assertChildRan` — quotes stderr the same way. Two definitions of
 * "how much stderr, and what to print when there is none" is a second
 * convention, and the drift between the two is invisible until a message
 * arrives with a blank region a reader has to interpret.
 */
export function stderrTail(stderr: string, limit = 2000): string {
  const trimmed = stderr.trim();
  if (trimmed.length === 0) return '<child wrote nothing to stderr>';
  return trimmed.length > limit ? `${trimmed.slice(0, limit)}\n… (truncated)` : trimmed;
}

/**
 * Assert the child actually ran, and hand back its stdout.
 *
 * Throws with the child's own stderr attached when it did not, so a loaded box
 * produces a failure that says *the subprocess died* rather than one that says
 * *the product is wrong*. The caller's product assertion is only ever reached
 * with a report the child actually produced.
 */
export function assertChildRan(result: RawChildResult, label: string): string {
  const outcome = classifyChild(result);
  if (outcome.kind === 'exited') return outcome.stdout;

  assert.fail(
    `${label}: the subprocess ${describeOutcome(outcome)}, so it produced no report to check.\n`
    + 'This is a subprocess/resource failure, NOT a product failure — the assertion that would\n'
    + 'have run here never got a result to judge. Check the box for load, memory and fd pressure\n'
    + 'before reading anything into the product.\n'
    + `child stderr:\n${stderrTail(outcome.stderr)}`,
  );
}

/**
 * The exit code of a child that was *expected* to succeed.
 *
 * A non-zero exit from a child that should have passed is a real failure and is
 * reported as one, with stderr. This is the `result.status ?? 1` shape done
 * honestly: the old `?? 1` silently mapped a signal-killed child (status
 * `null`) onto "exited 1", which is indistinguishable from a gate that ran and
 * correctly rejected a document.
 */
export function childExitCode(result: RawChildResult, label: string): number {
  const outcome = classifyChild(result);
  if (outcome.kind === 'exited') return outcome.code;
  assert.fail(
    `${label}: the subprocess ${describeOutcome(outcome)} instead of exiting, so its verdict is unknown.\n`
    + 'A killed or never-started child must not be read as a gate that ran and rejected.\n'
    + `child stderr:\n${stderrTail(outcome.stderr)}`,
  );
}

export interface BoundedExecOptions {
  readonly label: string;
  /** Wall-clock budget. A synchronous child is bounded by this or by nothing. */
  readonly timeoutMs: number;
  readonly cwd?: string;
  readonly env?: NodeJS.ProcessEnv;
  /** Defaults to `SIGKILL`: a timeout must not be negotiable by the child. */
  readonly killSignal?: NodeJS.Signals;
}

/**
 * `execFileSync` with a deadline, reported through this file's vocabulary.
 *
 * ## Why this exists rather than a `setTimeout` around a call (#1365)
 *
 * A `setTimeout` **cannot** bound a synchronous child, and that is a measured
 * fact rather than an inference. While `execFileSync` is on the stack the event
 * loop does not run, so a timer armed for 200 ms did not fire until a 1.5 s
 * `execFileSync` had returned:
 *
 * ```
 * execFileSync returned at 1522 | timer fired during it? false
 * timer fired at 1523
 * ```
 *
 * This matters because `tests/mcp.smoke.test.ts` runs `npm pack`, whose
 * `prepack` is a full `tsc`. A whole-file watchdog, however it is armed, is
 * inert for the duration of that call — so the only bound that covers a
 * synchronous child is the `timeout` option on the call itself.
 *
 * The error is then classified rather than propagated raw, because a timeout
 * arrives as `code: 'ETIMEDOUT'` **and** `signal: 'SIGKILL'` with `status: null`
 * (Node 24.21.0, this function's own test drives it). Left raw, the caller sees
 * an opaque `spawnSync … ETIMEDOUT` and cannot tell a slow `tsc` from a killed
 * one.
 */
export function execFileBounded(
  file: string,
  args: readonly string[],
  options: BoundedExecOptions,
): string {
  try {
    return execFileSync(file, [...args], {
      encoding: 'utf8',
      timeout: options.timeoutMs,
      killSignal: options.killSignal ?? 'SIGKILL',
      ...(options.cwd !== undefined ? { cwd: options.cwd } : {}),
      ...(options.env !== undefined ? { env: options.env } : {}),
    });
  } catch (error) {
    const result = error as RawChildResult;
    const timedOut = (error as { code?: string }).code === 'ETIMEDOUT';
    // `ETIMEDOUT` wins over the generic "never started" reading: the child *did
    // start* and was killed by our own deadline, and a report that says
    // otherwise sends the reader looking for a missing binary.
    const outcome: ChildOutcome = timedOut
      ? { kind: 'signalled', signal: result.signal ?? options.killSignal ?? 'SIGKILL', stdout: result.stdout ?? '', stderr: result.stderr ?? '' }
      : classifyChild(result);
    assert.fail(
      `${options.label}: the subprocess ${describeOutcome(outcome)}`
      + `${timedOut ? ` after exceeding its ${options.timeoutMs}ms budget` : ''}, so it produced no output to check.\n`
      + 'This is a subprocess/resource failure, NOT a product failure. A synchronous child is not\n'
      + 'bounded by a timer — the event loop is blocked while it runs — so this budget is the only\n'
      + 'thing that can end it, and the load on the machine is the first thing to check.\n'
      + `child stderr:\n${stderrTail(outcome.stderr)}`,
    );
  }
}
