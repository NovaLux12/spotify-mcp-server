/**
 * The one harness for tests that run a **one-shot CLI subcommand** (#1378, #1379).
 *
 * ## Why this is a sibling of `stdio-child.ts` and not a second half of it
 *
 * `tests/helpers/stdio-child.ts` owns the stdio **MCP server** harness: a
 * long-lived child, newline-framed JSON-RPC over its stdin, a pending map, a
 * per-request watchdog. A CLI subcommand is a different job on every axis that
 * matters — the child *exits*, its stdout is the whole answer, and the exit
 * code is a verdict rather than a transport error. `doctor` exits 1 on every
 * failing check, so "exited non-zero" is the normal case, not a failure.
 *
 * Merging the two would produce the failure #1379 names: a helper that claims
 * to cover both and silently does neither well. Two named exports in
 * `tests/helpers/`, one per job, sharing one vocabulary for how a child died.
 *
 * The shared vocabulary is the load-bearing part. `classifyChild`,
 * `describeOutcome` and `stderrTail` are #1335's, and `describeHostPressure` is
 * #1366's; a second way to say "killed by SIGKILL" in this repo is exactly the
 * drift these helpers exist to stop. A `SIGKILL` reads the same here as it does
 * in `stdio-child.ts`.
 *
 * ## The defect this closes (#1378)
 *
 * The harness this was promoted from lived inside
 * `tests/branding-notice-guard.test.ts`, where it caught every failure of the
 * child and returned `e.stdout ?? ''`. Its own doc comment claimed that was
 * deliberate and correct:
 *
 * > …which is why a killed child returns its stdout instead of an empty string.
 *
 * That claim is not true as a rule. It held only for a child that had already
 * reached the banner. A child killed earlier — during module load, under load —
 * has an `err.stdout` of `''` exactly as a child that printed nothing has, and
 * `e.stdout ?? ''` handed both to the notice assertion as the same empty string.
 * The result was a red that read as *the product dropped its non-affiliation
 * notice* when the truth was *the box was too busy to finish starting the
 * child*, and a green that could not distinguish them either.
 *
 * #1378 attributed the empty result to `killSignal: 'SIGKILL'` leaving
 * `err.stdout` **`undefined`**. That is not what Node does. Measured against
 * Node 24.21.0 on this box, the async `execFile` error object always *has* a
 * `stdout` property, and it holds whatever the child managed to flush:
 *
 * | child outcome              | `err.stdout` | `err.code` | `err.signal` | `err.killed` |
 * |----------------------------|--------------|------------|--------------|--------------|
 * | ran, exited 1, printed     | `'HELLO\n'`  | `1`        | `null`       | `false`      |
 * | killed by SIGKILL, printed | `'HELLO\n'`  | `null`     | `'SIGKILL'`  | `false`      |
 * | killed by SIGKILL, silent  | `''`         | `null`     | `'SIGKILL'`  | `false`      |
 * | killed by the deadline     | `'HELLO\n'`  | `null`     | `'SIGKILL'`  | `true`       |
 * | never started (ENOENT)     | `''`         | `'ENOENT'` | `undefined`  | —            |
 *
 * So the comment was right for a child that had already reached the banner and
 * wrong for one killed during module load — which is the one that happens under
 * load. The empty string is reachable either way; that is the defect, and it
 * survives the correction to the mechanism. AGENTS.md §6: a correctly named
 * payload field can still lie about its value. `stdout` was named for the
 * banner and was reporting "nothing arrived, for reasons this discards".
 *
 * The measured table also shows the timeout and the signal are the *same three
 * fields* — `code: null`, `signal: 'SIGKILL'` — separated only by `killed`.
 * Handing a raw async error to `classifyChild` would therefore file this
 * harness's own deadline as `killed by SIGKILL` and send the next reader
 * hunting an OOM killer they caused themselves. That is what
 * `spawnFailure()` below exists to prevent.
 *
 * ## What is preserved here
 *
 * The three outcomes stay distinguishable **at the point of judgement**, each
 * naming itself, and each driven by a real child process rather than a
 * hand-built object — the shapes asserted in `tests/cli-child.test.ts` are the
 * shapes Node produces, which is the whole lesson of the table above.
 *
 * ## What the caller still owns
 *
 * The env. This helper does not build one: it takes `env` and `cwd` from the
 * caller, because "which HOME, and does a token file exist in it" is a property
 * of the *test* (`hermeticServerEnv` for most, a bespoke fixture for the notice
 * guard), and a helper that grew its own would quietly become a second place
 * that answer lives. `tests/helpers/hermetic.ts` remains the one source of a
 * disposable root.
 */

import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { describeHostPressure } from './stdio-child.js';
import { classifyChild, describeOutcome, stderrTail, type ChildOutcome, type RawChildResult } from './subprocess-outcome.js';

const run = promisify(execFile);

/** The repo's measured cost of a full registry boot is ~2.1 s; 30 s is slack, not a budget. */
export const CLI_TIMEOUT_MS = 30_000;

/**
 * What a one-shot CLI run produced.
 *
 * `ok: true` means the child **exited** — any code, including a non-zero one,
 * because `doctor` exits 1 whenever any check fails and with a fixture token it
 * always will. Its stdout is the thing under test, and an empty one is a
 * legitimate answer.
 *
 * `ok: false` means the child never reached a verdict at all, and `reason` says
 * which of the three ways that happened. The distinction is the whole point:
 * collapsing `ok: false` into `stdout: ''` reports a box that was starved as a
 * product that dropped whatever the output was supposed to say.
 */
export type CliRun =
  | { readonly ok: true; readonly stdout: string; readonly code: number }
  | { readonly ok: false; readonly reason: string };

/** What to run, and what to run it with. */
export interface CliSubcommandOptions {
  /** The module to run, as a path relative to `cwd` or absolute. */
  readonly entry: string;
  readonly cwd: string;
  /**
   * The child's environment, from the caller.
   *
   * Required, not defaulted: a child that inherits the developer's real `HOME`
   * writes into the real `~/.spotify-mcp`, which is the leak
   * `tests/helpers/hermetic.ts` exists to prevent. Making the caller pass it
   * means no test can pick up the ambient environment by forgetting.
   */
  readonly env: NodeJS.ProcessEnv;
  /** Subcommand and flags, e.g. `['doctor']` or `['--help']`. */
  readonly args?: readonly string[];
  /** The harness deadline. Shorter in a test that must not wait 30 s for a hang. */
  readonly timeoutMs?: number;
  /** Names the run in the failure report. Derived from `args` when omitted. */
  readonly label?: string;
}

/** The spawn-failure half of the async error, in `classifyChild`'s vocabulary. */
function spawnFailure(err: { readonly code?: number | string | null; readonly killed?: boolean }): RawChildResult['error'] {
  // Checked before `signal` for the reason #1335 documents: a timed-out child
  // carries BOTH a signal (this harness's own `killSignal`) and a deadline, and
  // `classifyChild` reads `error` first, so the deadline has to be spelled here
  // or it is lost and the watchdog is filed as an unexplained kill.
  if (err.killed === true) return { code: 'ETIMEDOUT' };
  // Async `execFile` reports a fork/exec failure as a *string* `code`
  // (`'ENOENT'`), where the sync APIs nest it under `error`. Measured, not
  // assumed — the table in the header is reproduced against real children by
  // `tests/cli-child.test.ts`.
  if (typeof err.code === 'string') return { code: err.code };
  return undefined;
}

/**
 * Re-spell an async `execFile` failure in the vocabulary `classifyChild` reads.
 *
 * The sync and async APIs do not report the same three events the same way, and
 * the differences are precisely the ones that decide the diagnosis:
 *
 * | child outcome         | async `execFile` error                              | `classifyChild` reads   |
 * |-----------------------|------------------------------------------------------|-------------------------|
 * | ran, exited N         | `code: N`, `signal: null`                            | `status: N`             |
 * | killed by a signal    | `code: null`, `signal: 'SIGKILL'`, `killed: false`   | `signal`                |
 * | killed by the deadline| `code: null`, `signal: <killSignal>`, `killed: true` | `error.code: 'ETIMEDOUT'` |
 * | never started         | `code: 'ENOENT'`, `signal: undefined`                | `error.code: 'ENOENT'`  |
 *
 * The timeout row cannot be passed through. Async `execFile` attaches **no**
 * `error` property at all on any of these paths, so a raw hand-off files the
 * 30 s watchdog as `killed by SIGKILL` — the same conflation #1335 fixed for
 * the sync APIs, re-entering through the async door, and a reader sent to look
 * for an OOM kill that their own deadline caused.
 */
export function classifyCliChild(err: unknown): { readonly raw: RawChildResult; readonly outcome: ChildOutcome } {
  const e = err as {
    readonly code?: number | string | null;
    readonly signal?: NodeJS.Signals | null;
    readonly killed?: boolean;
    readonly stdout?: string;
    readonly stderr?: string;
  };
  const raw: RawChildResult = {
    error: spawnFailure(e),
    signal: e.signal ?? null,
    status: typeof e.code === 'number' ? e.code : null,
    stdout: e.stdout,
    stderr: e.stderr,
  };
  return { raw, outcome: classifyChild(raw) };
}

/**
 * What kind of death this was, stated so it cannot be read as a defect in the
 * product. Split from the facts above so a message carrying both says each once.
 */
function explainCliFailure(outcome: ChildOutcome, timeoutMs: number): string {
  if (outcome.kind === 'signalled') {
    return 'A signal kill is a resource/process failure, NOT a compliance failure. Nothing the CLI could have\n'
      + 'printed was lost in the product — a signal takes the process with it before it reaches the banner —\n'
      + 'so the notice assertion that would have run here never got output to judge. Check the host pressure\n'
      + 'line before concluding the notice is missing from the product.';
  }
  if (outcome.kind === 'not-started' && outcome.reason === 'ETIMEDOUT') {
    return `The child ran for the full ${timeoutMs}ms deadline and was ended by this harness's own killSignal.\n`
      + 'That is a hang, not an unexplained kill, and it is a different thing to go looking for: check whether\n'
      + 'the child is still booting at this load before reading anything into the notice.';
  }
  return `The child never started (${outcome.reason}), so no line of the code under test ever ran. This is a\n`
    + 'harness/environment failure, not a statement about the notice.';
}

/** The self-describing report for a CLI child that never reached an exit code. */
function describeCliFailure(
  label: string,
  command: readonly string[],
  raw: RawChildResult,
  outcome: ChildOutcome,
  timeoutMs: number,
): string {
  return [
    `${label}: the CLI child ${describeOutcome(outcome)} `
      + `(code=${raw.status ?? 'null'} signal=${raw.signal ?? 'null'}), so it produced no output to check.`,
    explainCliFailure(outcome, timeoutMs),
    `command: ${command.join(' ')}`,
    `host pressure: ${describeHostPressure()}`,
    `child stderr:\n${stderrTail(raw.stderr ?? '')}`,
  ].join('\n');
}

/**
 * Run a one-shot CLI subcommand and report **how it ended**, not just what it printed.
 *
 * A non-zero exit is a verdict and is returned as one: `doctor` exits 1 whenever
 * any check fails, and with a fixture token it always will. Whatever the caller
 * is asserting about was printed on the banner *before* the report is
 * collected, so the partial output of a child that ran and failed is genuinely
 * the thing under test.
 *
 * What is **not** returned is the reason the previous version of this function
 * claimed. It said a killed child "returns its stdout instead of an empty
 * string", and that was false as a rule — see the header.
 */
export async function runCliSubcommand(options: CliSubcommandOptions): Promise<CliRun> {
  const { entry, cwd, env, timeoutMs = CLI_TIMEOUT_MS } = options;
  const args = [...(options.args ?? [])];
  const argv = ['--import', 'tsx/esm', entry, ...args];
  // With no subcommand the binary prints its help, so `--help` is what the run
  // *is* — naming it that way beats an empty label in a failure report.
  const label = options.label ?? `spotify-mcp ${args.length > 0 ? args.join(' ') : '--help'}`;
  try {
    const { stdout } = await run(process.execPath, argv, {
      cwd,
      encoding: 'utf8',
      timeout: timeoutMs,
      killSignal: 'SIGKILL',
      env,
    });
    return { ok: true, stdout, code: 0 };
  } catch (err) {
    const { raw, outcome } = classifyCliChild(err);
    // A child that ran and exited is a verdict, crash or not: `doctor` exits 1
    // on every failing check, and that is the case the output assertions exist
    // to cover.
    if (outcome.kind === 'exited') {
      return { ok: true, stdout: outcome.stdout, code: outcome.code };
    }
    return { ok: false, reason: describeCliFailure(label, [process.execPath, ...argv], raw, outcome, timeoutMs) };
  }
}

/**
 * The stdout of a run that reached a verdict, failing with the child's own cause
 * if it did not.
 *
 * This is the call site every assertion about a child's output goes through, so
 * the failure it raises is what a reader sees instead of `expected <text>, got ''`.
 */
export function cliStdout(result: CliRun): string {
  if (!result.ok) assert.fail(result.reason);
  return result.stdout;
}
