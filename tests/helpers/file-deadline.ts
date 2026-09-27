/**
 * A whole-file bound for a test file that spawns real child processes (#1365).
 *
 * ## The defect this exists to close
 *
 * `tests/mcp.smoke.test.ts` armed a 30 s watchdog in `before()` and cleared it at
 * the top of `after()`. That looks like a bound on the file and is a bound on
 * nothing: it only covered the handshake, and `npm test` invokes the runner as
 *
 * ```
 * node --import tsx --test 'tests/*.test.ts'
 * ```
 *
 * with **no `--test-timeout`**, so the runner's own default is unbounded and
 * nothing else would ever end the file. Four runs were reported sitting on this
 * one file for 47–60 minutes at **0.0 % CPU** — blocked, not slow.
 *
 * The obvious repair is to raise the 30 s. That is the wrong one, twice over. The
 * repo's own measurement is `initialize: 2046ms`, `tools/list: 2125ms` under load
 * ~48, so 30 s is already ~14x the real cost and the slack is deliberate; raising
 * it does not add information, it converts a diagnosable red into an unbounded
 * one. And it would still be cleared by the same `after()`, so it would still
 * bound nothing.
 *
 * ## Why the file could block at all
 *
 * The 0 % CPU is the tell, and it is not the watchdog. Killing a child settles
 * that child's requests, but it does not close a pipe descriptor the child
 * *inherited* — and Node keeps a `PipeWrap` registered for every stdio stream it
 * handed out. If anything in the child's tree still holds the write end, the
 * parent's read end never reaches EOF, the handle stays in the event loop, and
 * the test file cannot drain. Measured directly against this repo's own
 * `StdioJsonRpcChild` (the reproduction is `tests/file-deadline.test.ts`):
 *
 * ```
 * dispose() returned. active handles now: ["PipeWrap","PipeWrap","ProcessWrap"]
 * *** LEAK DETECTED: loop still held after dispose() ***        (exit 7)
 * ```
 *
 * `dispose()` fixed the child and released none of its pipes. So this helper is
 * the second half of the fix: `dispose()` now destroys the streams
 * (`stdio-child.ts`), and this module guarantees the *file* still cannot
 * outlive its budget if something else leaks.
 *
 * ## Why the timer is `unref`'d — this is load-bearing, not a style choice
 *
 * The deadline is armed with `timer.unref()`. That inverts the usual watchdog
 * into something strictly better for a test file:
 *
 * - **It can never cause a hang.** An `unref`'d timer does not keep the event
 *   loop alive, so a file that finishes on time pays nothing and exits the
 *   instant its last test ends.
 * - **It fires if and only if something else is holding the loop open.** That is
 *   exactly the failure being bounded, and it means a clean run cannot trip it
 *   by being slow, because a slow-but-progressing run is not a leak.
 *
 * Both halves were measured before being relied on (`tests/file-deadline.test.ts`
 * pins the second): a `Timeout` armed and `unref`'d with nothing else pending
 * lets the process exit immediately; the same timer fires on schedule when a
 * leaked `PipeWrap` is holding the loop.
 *
 * ## There is deliberately no way to disarm it
 *
 * `armFileDeadline` returns `void`. The old watchdog was a variable that
 * `after()` cleared, and *that line was the bug* — a bound that a later edit can
 * clear from a teardown hook is not a bound. With nothing to clear, the deadline
 * is not a thing this file maintains; it is a property the process has for as
 * long as it is alive. A source guard
 * (`tests/file-deadline.test.ts`) fails if the arming call is deleted or moved
 * below the first hook.
 *
 * ## A timer cannot bound a synchronous child
 *
 * Measured, not assumed: while `execFileSync` is on the stack the event loop does
 * not run, so a deadline timer armed at 200 ms did not fire until a 1.5 s
 * `execFileSync` returned. This file runs `npm pack`, whose `prepack` is a full
 * `tsc`, so the *synchronous* children are bounded by their own
 * `timeout`/`killSignal` in `execFileBoundedSync` (`subprocess-outcome.ts`) and
 * the whole-file deadline covers the asynchronous remainder. Two independent
 * bounds because one mechanism cannot cover both.
 *
 * ## Reaping
 *
 * Reaped **by recorded PID only** (`killNow()`, which re-checks
 * `isOwnChild`). Never a pattern match: this box is shared with ~19 other agents
 * running this same suite, and a `pkill -f "import tsx"` would take out their
 * servers and manufacture failures in runs that have nothing to do with us.
 */

import { writeSync } from 'node:fs';

import { describeHostPressure } from './stdio-child.js';

/**
 * The slice of `StdioJsonRpcChild` the deadline needs. Structural, so a test can
 * drive the breach without booting a registry — and so this module does not have
 * to import the class it is meant to police.
 */
export interface DeadlineChild {
  /** Names the child in the breach report. */
  readonly label: string;
  readonly pid: number | undefined;
  /** Everything the child managed to print. A signal kill leaves none. */
  readonly stderr: string;
  /** Latched by the client's `exit` handler; `undefined` while it is alive. */
  readonly outcomeDescription: string | undefined;
  isRunning(): boolean;
  /** SIGKILL by recorded PID, and only if the OS still says the PID is ours. */
  killNow(): void;
}

export interface FileDeadlineOptions {
  /** The file, as it should read in a CI log. */
  readonly label: string;
  readonly budgetMs: number;
  /**
   * Called when the file is still alive at the budget. Defaults to writing the
   * report to fd 2 and exiting non-zero. Overridable so a test can read the
   * report instead of ending the test process.
   */
  readonly onBreach?: (report: string) => void;
}

export interface BreachOptions {
  readonly label: string;
  readonly budgetMs: number;
  readonly children: readonly DeadlineChild[];
  readonly onBreach?: (report: string) => void;
}

/** What a breached child contributes to the report. */
function childLine(child: DeadlineChild, signalledHere: boolean): string {
  const head = signalledHere
    // The deadline did this, so the outcome is known without waiting for the
    // `exit` event to be delivered. Naming the signal is the point: a bare
    // "killed" is indistinguishable from a crash.
    ? `${child.label}: killed by SIGKILL (code=null signal=SIGKILL pid=${child.pid ?? 'unknown'})`
    : `${child.label}: ${child.outcomeDescription ?? 'still running when the budget expired'}`
      + ` (pid=${child.pid ?? 'unknown'})`;
  const tail = child.stderr.trim().slice(-2000);
  return `  - ${head}\n      stderr: ${tail || '<nothing on stderr — consistent with a signal kill, which leaves no trace>'}`;
}

/**
 * The report, as a pure function of the facts.
 *
 * Split out from the killing so the *content* is assertable without ending the
 * test process — the same reason `describeExit` and `describeOutcome` are
 * exported and driven directly in `tests/stdio-child.test.ts` and
 * `tests/subprocess-outcome.test.ts`.
 */
export function describeFileDeadlineBreach(
  options: Omit<BreachOptions, 'onBreach'>,
  signalledPids: ReadonlySet<number | undefined>,
): string {
  const children = options.children.length === 0
    ? '  (this file had no live children registered — the handle outliving the child is not one of ours)'
    : options.children.map((c) => childLine(c, signalledPids.has(c.pid))).join('\n');
  // The smoking gun. `getActiveResourcesInfo()` names the *kind* of handle that
  // refused to let the loop drain, which is the one fact that separates "a child
  // of ours leaked a pipe" from "something in the harness leaked" — and the
  // reported hangs had no such line at all.
  const handles = process.getActiveResourcesInfo();
  return [
    `${options.label}: exceeded its ${options.budgetMs}ms whole-file budget.`,
    '',
    'This is not a slow test and not a product failure. The process was still alive with the',
    'event loop unable to drain, which means a handle outlived whatever created it; on its own',
    'this file would sit here indefinitely at 0% CPU and the runner has no test timeout.',
    '',
    'Children this file spawned, reaped by recorded pid only (never a pattern match):',
    children,
    '',
    `Handles still registered when the budget expired: ${handles.length === 0 ? '<none>' : [...new Set(handles)].sort().join(', ')}`,
    `host pressure: ${describeHostPressure()}`,
  ].join('\n');
}

/**
 * End the file: reap every child, then report and exit non-zero.
 *
 * Returns the report. Returns rather than never, so a caller that supplied
 * `onBreach` gets it — the `process.exit` on the default path is what a breach
 * means, and a test that passes `onBreach` has taken responsibility for ending
 * its own run.
 */
export function breachFileDeadline(options: BreachOptions): string {
  // Snapshot liveness *before* killing: afterwards a child may be mid-`exit`, and
  // the report must say which deaths this deadline caused rather than inferring
  // it from a race.
  const running = options.children.filter((c) => c.isRunning());
  for (const child of running) child.killNow();

  const report = describeFileDeadlineBreach(
    { label: options.label, budgetMs: options.budgetMs, children: options.children },
    new Set(running.map((c) => c.pid)),
  );

  if (options.onBreach) {
    options.onBreach(report);
    return report;
  }
  // `writeSync` on fd 2, not `process.stderr.write`: the next statement is
  // `process.exit`, and a piped stderr write is not guaranteed to have drained
  // by then. A breach report that is lost is the one artifact the run was
  // guaranteed to produce.
  writeSync(2, `${report}\n`);
  process.exit(1);
}

/**
 * Arm the whole-file bound. Returns nothing, and that is the design.
 *
 * @param children Read at breach time, not now: the file spawns children inside
 *   its tests, long after this is called.
 */
export function armFileDeadline(
  options: FileDeadlineOptions & { readonly children: () => readonly DeadlineChild[] },
): void {
  const timer = setTimeout(() => {
    breachFileDeadline({
      label: options.label,
      budgetMs: options.budgetMs,
      children: options.children(),
      ...(options.onBreach ? { onBreach: options.onBreach } : {}),
    });
  }, options.budgetMs);
  // See the header. Without this the timer would itself be a reason the file
  // never exits — the exact failure it is installed to prevent.
  timer.unref();
}
