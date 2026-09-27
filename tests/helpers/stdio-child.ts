/**
 * The one exit-aware stdio JSON-RPC harness for tests that spawn a real server
 * process (#1366).
 *
 * ## The defect this exists to close
 *
 * `tests/env-switch-registry.test.ts` and `tests/tool.surface.test.ts` each
 * hand-rolled a `request()` whose only negative settlement path was a
 * `setTimeout`. There was no `child.on('exit')` and no `child.on('error')`. A
 * child that is *killed* therefore never rejects its in-flight promise: the
 * request waits out the full watchdog — 30 s in that file, 20 s in the other —
 * and is then reported as
 *
 * ```
 * Error: timeout waiting for tools/list
 * stderr:
 * [spotify-mcp] SPOTIFY_MCP_READONLY "banana" names no boolean; ...
 * ```
 *
 * which is the wrong label for what happened, and it discards the cause. The
 * watchdog is roughly 14x the measured cost of the guarded operation
 * (`initialize: 2046ms`, `tools/list: 2125ms` on the same box at load ~48), so
 * "timed out" is not a statement about the server at all.
 *
 * `stderr` cannot substitute for the exit event, and that is not a stylistic
 * preference: **a SIGKILL leaves no stderr**. A child reaped by the OOM killer
 * is quiet by construction, so the captured stderr is at best a config warning
 * from before it died — which is itself evidence of a kill rather than a crash.
 * The one stream that could distinguish them is the one a signal takes away.
 *
 * Corroboration, observed while working #1335: a full parallel run on an
 * untouched worktree reported `server exited early (code=null signal=SIGKILL)`
 * from a test that passes in isolation and on the next run. #1335's helper
 * (`subprocess-outcome.ts`) established that a child must name its own outcome;
 * this is the async, streaming half of the same rule.
 *
 * ## The `exit` handler is load-bearing, and this is why
 *
 * Preserved from `tests/mcp.smoke.test.ts`, where it was the only correct part
 * of that harness and the rest of the suite is written around it:
 *
 * > One neighbouring guarantee is deliberately NOT re-asserted here because the
 * > harness already fails the run before any assertion could: a dead process.
 * > The client's `exit` handler calls `failAll`, which rejects every in-flight
 * > request, so a `process.exit` inside the tool rejects this call with "server
 * > exited early" rather than returning a payload to assert on.
 *
 * That is the property being promoted here. A test that awaits a reply from a
 * process that has already died is not testing the product; it is testing the
 * length of a timer, and whatever it concludes is concluded about the box.
 *
 * ## What this deliberately does not do
 *
 * **It does not raise the watchdog, and it does not retry.** The 30 s in
 * `env-switch-registry.test.ts` is ~14x the real cost, so it is slack, not a
 * budget worth spending: raising it would convert a loud, self-describing
 * failure into a slower one. A contention artifact should be loud and named
 * immediately, not patient — see the same reasoning in `subprocess-outcome.ts`.
 * A watchdog remains, because the server is a separate OS process whose timers
 * cannot be faked from the test, and a genuinely wedged child still has to fail
 * rather than hang the run. It is the *second* settlement path now, not the
 * only one.
 *
 * ## Reaping
 *
 * `dispose()` reaps **by PID only** — the PID `spawn` handed back, and only
 * that. Never a pattern match. This box is shared with ~19 other agents running
 * the same suite, and a `pkill -f "import tsx"` aimed at "our" children would
 * take out theirs and manufacture failures in runs that have nothing to do with
 * us. A recorded PID is the strongest scoping available: it names one process
 * and no other.
 *
 * This also replaces `setTimeout(() => child.kill('SIGKILL'), 1500).unref()`,
 * which every hand-rolled copy used. That pattern had two defects: it left a
 * fully-booted server resident for 1.5 s after every case (in a file that
 * spawns 20 of them, that is 20 registry boots' worth of memory overlapping
 * the next one), and because the timer is `unref`'d it never fires at all if
 * the test file finishes first — so the child was *orphaned*, not reaped.
 */

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { availableParallelism, freemem, loadavg, totalmem } from 'node:os';
import { join } from 'node:path';

import { HERMETIC_ROOT } from './hermetic.js';
import { classifyChild, describeOutcome } from './subprocess-outcome.js';

export interface JsonRpcResponse {
  id?: number | string | null;
  result?: Record<string, unknown>;
  error?: { code: number; message: string; data?: unknown };
}

interface Pending {
  readonly method: string;
  readonly resolve: (value: JsonRpcResponse) => void;
  readonly reject: (error: Error) => void;
  readonly timer: NodeJS.Timeout;
}

export interface StdioChildOptions {
  /** Names the child in every failure message it can produce. */
  readonly label: string;
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly env: NodeJS.ProcessEnv;
  /** Per-request deadline. See the header: this is the fallback, not the guard. */
  readonly requestTimeoutMs?: number;
  /** How long a child gets to exit on stdin EOF before it is killed. */
  readonly exitGraceMs?: number;
}

/** The repo's measured `initialize` + `tools/list` cost is ~2.1 s (see header). */
const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
const DEFAULT_EXIT_GRACE_MS = 2_000;

/** `mkdtempSync` prefixes must be safe as a single path segment. */
function safePrefix(label: string): string {
  return label.replace(/[^A-Za-z0-9._-]/g, '-').slice(0, 40) || 'child';
}

/**
 * What the box was doing when the child died.
 *
 * This is the line every one of these failures was missing. A `SIGKILL` from
 * the OOM killer and a `SIGKILL` from a test harness are the same three
 * characters on the wire, and the reader's first question is always "was this
 * the box or the code?" — which nothing in a bare `signal=SIGKILL` answers.
 * `node --test` runs test *files* in parallel by default, so a run on a shared
 * machine is a herd of full registry boots, and free memory at the moment of
 * death is the measurement that separates the two.
 *
 * **What the pressure looked like, since nobody will reproduce it on demand.**
 * The box #1366 was reported from ran at load **82–123 against 12 cores** with
 * **~250 node processes** — and the load was largely self-inflicted: a dozen
 * agents each re-running `tests/mcp.smoke.test.ts` in parallel, which is
 * exactly this failure mode feeding itself. Free memory during those runs
 * measured **1–7 GiB of 30 GiB**. A quiet box measures load ~1–4 and the same
 * tests complete in seconds. So: a load number in the tens against 12 cores, or
 * free memory in single digits, is the fingerprint. A `SIGKILL` with no stderr
 * under those numbers is the OOM killer, and the product is not implicated.
 * Quote this line in the failure report and the next reader does not have to
 * reconstruct it.
 *
 * `loadavg()` reports `[0, 0, 0]` on platforms that do not publish it (Windows).
 * Printing those zeros would read as "idle" — the opposite of the truth, and
 * the worst possible way to be wrong in a diagnostic — so they are reported as
 * unavailable instead.
 */
export function describeHostPressure(): string {
  const [one, five, fifteen] = loadavg();
  const freeGiB = freemem() / 2 ** 30;
  const totalGiB = totalmem() / 2 ** 30;
  const load = one === 0 && five === 0 && fifteen === 0
    ? 'load average not published on this platform'
    : `load ${one.toFixed(1)}/${five.toFixed(1)}/${fifteen.toFixed(1)} over ${availableParallelism()} cores`;
  const memory = `${freeGiB.toFixed(1)} GiB free of ${totalGiB.toFixed(1)} GiB (${Math.round((freeGiB / totalGiB) * 100)}%)`;
  return `${load}; ${memory}`;
}

/**
 * The environment a server child starts from, with the hermetic sandbox made
 * airtight in one place.
 *
 * Every `SPOTIFY_*` variable the developer's shell happens to carry is
 * **deleted**, not blanked: since #617 a set-but-empty value is a startup
 * error, so assigning `''` is not the same as unsetting. `HOME` and
 * `USERPROFILE` both point at a fresh `mkdtemp` under `HERMETIC_ROOT`, so the
 * `join(homedir(), '.spotify-mcp', …)` defaults resolve into a disposable root
 * — including the stores that have no override of their own. The token path is
 * stated explicitly and left **absent**: an absent token file resolves to an
 * empty granted-scope set, which the scope filter fails open on, and two of the
 * three callers' expectations are derived from that default.
 *
 * `tests/mcp.smoke.test.ts` needs a real fixture token, so a caller that passes
 * `SPOTIFY_MCP_TOKEN_FILE` wins over the default.
 */
export function hermeticServerEnv(
  overrides: Readonly<Record<string, string | undefined>> = {},
  label = 'server',
): { env: NodeJS.ProcessEnv; home: string } {
  const home = mkdtempSync(join(HERMETIC_ROOT, `${safePrefix(label)}-`));
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const key of Object.keys(env)) {
    if (key.startsWith('SPOTIFY_')) delete env[key];
  }
  env.HOME = home;
  env.USERPROFILE = home;
  env.SPOTIFY_CLIENT_ID = 'test-client-id';
  env.SPOTIFY_MCP_TOKEN_FILE = join(home, 'tokens.json');
  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined) delete env[key];
    else env[key] = value;
  }
  return { env, home };
}

/**
 * Is `pid` a live child of *this* process?
 *
 * The reaping in `dispose()` only ever aims at a PID `spawn` just returned, so
 * the common case is trivially true. This exists for the case where it is not
 * trivially true: a suite that boots twenty servers over a long run can outlive
 * a PID, and a recycled PID belongs to somebody else — on this box, quite
 * possibly another agent's test. So where the OS will tell us, we ask, and
 * refuse to signal a process that is not ours.
 *
 * Returns `true` on platforms with no answer to give (macOS, Windows): the
 * recorded-PID scoping in `dispose()` is already the primary guarantee, and this
 * is the belt to its braces, not the braces themselves.
 */
export function isOwnChild(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 1) return false;
  let stat: string;
  try {
    stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
  } catch {
    return true; // no /proc (macOS/Windows): fall back to the recorded PID alone
  }
  // Field 4 is ppid, but fields 2 (`comm`) may contain spaces and parentheses,
  // so split after the LAST ')'.
  const afterComm = stat.slice(stat.lastIndexOf(')') + 1).trim();
  const ppid = Number(afterComm.split(/\s+/)[1]);
  return Number.isInteger(ppid) && ppid === process.pid;
}

/**
 * Run an event-handler body where a throw is **reported**, not fatal.
 *
 * A throw inside a `child.stdout.on('data')` handler is an uncaught
 * exception: it takes the whole test process down, prints a stack trace that
 * names no test, and **fails no assertion**. Every test that had not yet run
 * simply does not run, and the run ends looking like a pass for all of them.
 * That is the worst shape a check can have — it looks green and asserts
 * nothing, which is worse than a red test because nothing prompts a look.
 *
 * It is a live hazard in a harness that owns the handler bodies, not a
 * hypothetical. An agent destructured `Promise.withResolvers()` as
 * `{promise, resolveWith, rejectWith}` — the real names are `{promise, resolve,
 * reject}` — so both callbacks were `undefined`, and the `TypeError` on the
 * first reply fired inside a `data` handler and killed the runner with no
 * failing assertion anywhere in the output.
 *
 * **Exported so it can be tested directly, and that is the whole reason it is
 * not an inline try/catch.** The first draft of the guard here was inline, and
 * the test written for it *passed with the try/catch deleted* — because every
 * throw reachable from a real child in this harness is already caught one level
 * down (`onStdout` frames its own JSON errors), so the wrapper was never
 * entered. A green test that cannot go red is worse than no test, so the
 * contract now lives somewhere it can be driven: hand it a body that throws and
 * assert the report. `tests/stdio-child.test.ts` does exactly that, and it goes
 * red the moment the `try` is removed.
 */
export function guardedHandler<A extends unknown[]>(
  report: (message: string, cause: Error) => void,
  what: string,
  body: (...args: A) => void,
): (...args: A) => void {
  return (...args: A): void => {
    try {
      body(...args);
    } catch (error) {
      report(`the ${what} handler threw`, error as Error);
    }
  };
}

export class StdioJsonRpcChild {
  readonly child: ChildProcessWithoutNullStreams;
  private readonly label: string;
  private readonly requestTimeoutMs: number;
  private readonly exitGraceMs: number;
  private readonly pending = new Map<number, Pending>();
  private buffer = '';
  private stderrText = '';
  private closed = false;
  /** How the child ended, or `undefined` while it is still running. */
  private outcome: string | undefined;
  /** A handler failure, latched so it can never be reported zero times. */
  private fatal: Error | undefined;
  /**
   * The child's death, latched for the same reason `failAll` is not enough on
   * its own. `failAll` settles what was in flight *at the moment of death*; a
   * request issued afterwards lands in `pending` with nothing left to reject
   * it, is written to a stdin nobody is reading, and is reported a full
   * watchdog later as a timeout. That is the #1366 misreport arriving through
   * the one door the exit listener does not cover, and it is not rare: a
   * suite that boots a long-lived server in `before()` and keeps using it from
   * later tests will do this whenever the child dies mid-file. Observed for
   * real here — a SIGKILLed `mcp-smoke` child, then a `tools/list` on it from
   * a *different* test 30s later, reported as "timed out waiting for
   * tools/list" with the SIGKILL visible only in a provenance line the reader
   * has no reason to trust over the headline.
   */
  private dead: Error | undefined;
  /** The signal that killed the child, kept so a later message can classify the death. */
  private deadSignal: NodeJS.Signals | null = null;
  private nextId = 0;

  static spawn(options: StdioChildOptions): StdioJsonRpcChild {
    return new StdioJsonRpcChild(
      spawn(options.command, [...options.args], {
        cwd: options.cwd,
        env: options.env,
        stdio: ['pipe', 'pipe', 'pipe'],
      }),
      options,
    );
  }

  private constructor(child: ChildProcessWithoutNullStreams, options: StdioChildOptions) {
    this.child = child;
    this.label = options.label;
    this.requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    this.exitGraceMs = options.exitGraceMs ?? DEFAULT_EXIT_GRACE_MS;

    // @modelcontextprotocol/sdk StdioServerTransport frames messages as
    // newline-delimited JSON (its ReadBuffer splits on '\n') — no Content-Length
    // headers.
    this.child.stdout.setEncoding('utf8');
    this.child.stderr.setEncoding('utf8');
    this.child.stdout.on('data', this.guard('stdout', (chunk: string) => this.onStdout(chunk)));
    this.child.stderr.on('data', this.guard('stderr', (chunk: string) => { this.stderrText += chunk; }));

    // ---- the three load-bearing listeners. See the header. ----------------
    this.child.on('error', this.guard('spawn', (err: Error) => {
      this.die(new Error(`${this.label}: spawn failed: ${err.message}`));
    }));
    this.child.on('exit', this.guard('exit', (code: number | null, signal: NodeJS.Signals | null) => {
      // Two forms on purpose: `outcome` is the one line `provenance()` quotes
      // (so it must not repeat stderr or pressure), while the rejection below
      // carries the full self-contained `describeExit` report.
      this.outcome = exitSummary(this.label, this.child.pid, code, signal, this.stderrText);
      this.deadSignal = signal;
      // A signal is the whole point: `code` is null and only `signal` says the
      // child was killed. Reporting `code=null` alone would file an OOM kill
      // under "exited with no status", which is the misreport this closes.
      this.die(new Error(describeExit(this.label, this.child.pid, code, signal, this.stderrText)));
    }));
    // Writing to a dead child's stdin raises EPIPE on the *stream*, not on the
    // process. Unhandled, that 'error' event takes down the test process
    // itself, so a killed child would abort the run instead of failing one case.
    this.child.stdin.on('error', this.guard('stdin', (err: Error) => {
      this.die(new Error(`${this.label}: stdin broke (${err.message}) — the child is gone\n${this.provenance()}`));
    }));
  }

  /**
   * Record the child's death, then reject everything in flight. Latched before
   * `failAll` so a request racing the exit event cannot observe a window where
   * the child is gone but nothing rejects it. First cause wins: a stdin EPIPE
   * that follows a SIGKILL is a symptom of the kill, not a second cause, and
   * replacing the signal with `EPIPE` would undo the whole point.
   */
  private die(error: Error): void {
    this.dead ??= error;
    this.failAll(this.dead);
  }

  /**
   * Run an event-handler body where a throw is *reported* rather than fatal.
   *
   * Delegates to the exported `guardedHandler` so the contract is directly
   * testable — the first draft of this was an inline try/catch, and the test
   * written for it passed with the try/catch deleted, because every reachable
   * throw in this harness is already caught one level down. See that function.
   */
  private guard<A extends unknown[]>(what: string, body: (...args: A) => void): (...args: A) => void {
    return guardedHandler(
      (message, cause) => { this.reportFatal(message, cause); },
      what,
      // Once something has gone fatally wrong, stop touching a session that is
      // already reporting itself as untrustworthy. Args are forwarded: the
      // `exit` and `error` handlers cannot work without their code/signal/err.
      (...args: A) => { if (this.fatal === undefined) body(...args); },
    );
  }

  /** Record a failure that must be visible, and settle everything in flight. */
  private reportFatal(message: string, cause?: Error): Error {
    this.fatal = new Error(
      `${this.label}: ${message}.\n`
      + 'This is a harness failure, not a product failure. It is reported here rather than allowed to\n'
      + 'escape into the test runner, where a throw inside an event handler kills the process and no\n'
      + 'assertion ever runs — a run that dies quietly is a check that asserts nothing.\n'
      + (cause ? `${cause.stack ?? cause.message}\n` : '')
      + this.provenance(),
    );
    // Even with nothing in flight, this cannot pass unnoticed.
    process.emitWarning(this.fatal.message, 'StdioJsonRpcChildHarnessFailure');
    this.failAll(this.fatal);
    return this.fatal;
  }

  get pid(): number | undefined {
    return this.child.pid;
  }

  get stderr(): string {
    return this.stderrText;
  }

  /** What is known about the child right now, for any failure message. */
  private provenance(): string {
    // `this.outcome` is deliberately the SHORT line, not `describeExit`'s full
    // report. `describeExit` is self-contained — it already carries its own
    // stderr and its own host-pressure reading — so embedding it here printed
    // both of those a second time, with a *different* load figure each time.
    // A reader faced with two pressure readings has no way to tell which is
    // current, which is worse than not printing pressure at all.
    return [
      // `pid=` rather than `pid `, so it reads the same as `describeExit` and one
      // grep finds the child in either message.
      `child pid=${this.pid ?? 'unknown'}: ${this.outcome ?? 'still running'}`,
      `child stderr:\n${this.stderrText.trim() || '<nothing on stderr — consistent with a signal kill, which leaves no trace>'}`,
      `host pressure: ${describeHostPressure()}`,
    ].join('\n');
  }

  private onStdout(chunk: string): void {
    this.buffer += chunk;
    let idx: number;
    while ((idx = this.buffer.indexOf('\n')) !== -1) {
      const line = this.buffer.slice(0, idx).trim();
      this.buffer = this.buffer.slice(idx + 1);
      if (!line) continue;
      let message: JsonRpcResponse;
      try {
        message = JSON.parse(line) as JsonRpcResponse;
      } catch (err) {
        // Unreadable framing is a latch, not a one-off: after it, this session's
        // stdout stream cannot be trusted, so nothing further is answered off it.
        this.reportFatal(
          `unreadable line on stdout (${(err as Error).message}); the stream cannot be framed from here\n  ${line.slice(0, 400)}`,
        );
        return;
      }
      if (typeof message.id !== 'number') continue;
      const entry = this.pending.get(message.id);
      if (!entry) continue;
      this.settle(message.id);
      entry.resolve(message);
    }
  }

  private settle(id: number): Pending | undefined {
    const entry = this.pending.get(id);
    if (entry) {
      clearTimeout(entry.timer);
      this.pending.delete(id);
    }
    return entry;
  }

  private failAll(error: Error): void {
    for (const id of [...this.pending.keys()]) {
      const entry = this.settle(id);
      entry?.reject(error);
    }
  }

  /**
   * Send a request. Rejects on a JSON-RPC error, on the child dying (naming the
   * code, the signal and the stderr), or on the watchdog — in that order of
   * *information*, not of likelihood.
   */
  request(
    method: string,
    params: Record<string, unknown> = {},
    timeoutMs: number = this.requestTimeoutMs,
  ): Promise<JsonRpcResponse> {
    if (this.closed) {
      return Promise.reject(new Error(`${this.label}: ${method} was requested on a closed session\n${this.provenance()}`));
    }
    // A latched handler failure rejects the *next* request too, so a throw that
    // happened while nothing was in flight still cannot pass unnoticed.
    if (this.fatal !== undefined) return Promise.reject(this.fatal);
    // Same reasoning for a child that is already gone. Rejecting here — with
    // the recorded cause and the word "dead" — is what keeps this a killed-child
    // report rather than a 30-second "timeout waiting for <method>" whose only
    // clue is a provenance line below it.
    if (this.dead !== undefined) {
      return Promise.reject(new Error([
        `${this.label}: ${method} was requested on a child that is already dead — the request was never sent`,
        // `this.dead.message` is deliberately NOT spliced in here: it is the
        // full `describeExit` report, which already carries stderr and a host
        // pressure reading. `provenance()` below carries its own copy of both,
        // so quoting the report too printed each of them twice — with two
        // different load figures, leaving the reader unable to tell which is
        // current. `provenance()` quotes the one-line summary; the paragraph
        // that classifies the death is added here so it survives exactly once.
        explainExit(this.deadSignal),
        this.provenance(),
      ].join('\n')));
    }
    const id = ++this.nextId;
    return new Promise<JsonRpcResponse>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.settle(id);
        reject(new Error(
          `${this.label}: timed out after ${timeoutMs}ms waiting for ${method}\n`
          + `Unanswered ${method} in ${timeoutMs}ms. The watchdog is ~14x the measured cost of this call, so\n`
          + 'a child that is still running here is starving, not slow. Read the pid line below first:\n'
          + `${this.provenance()}`,
        ));
      }, timeoutMs);
      // The wait is event-driven — the child keeps the loop alive — so the timer
      // must not be what holds the process open.
      timer.unref();
      this.pending.set(id, { method, resolve, reject, timer });
      this.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    });
  }

  /** Fire-and-forget notification. No id, so nothing to settle. */
  notify(method: string, params: Record<string, unknown> = {}): void {
    this.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method, params })}\n`);
  }

  /** `initialize` then `notifications/initialized`, as the protocol requires. */
  async initialize(
    clientName: string,
    protocolVersion = '2024-11-05',
  ): Promise<JsonRpcResponse> {
    const init = await this.request('initialize', {
      protocolVersion,
      capabilities: {},
      clientInfo: { name: clientName, version: '1.0.0' },
    });
    if (init.error !== undefined) {
      throw new Error(`${this.label}: initialize failed: ${JSON.stringify(init.error)}\n${this.provenance()}`);
    }
    this.notify('notifications/initialized');
    return init;
  }

  /** Names in a `tools/list` result, sorted. */
  async toolNames(): Promise<string[]> {
    const listed = await this.request('tools/list');
    if (listed.error !== undefined) {
      throw new Error(`${this.label}: tools/list failed: ${JSON.stringify(listed.error)}\n${this.provenance()}`);
    }
    const tools = listed.result?.tools;
    if (!Array.isArray(tools) || tools.length === 0) {
      throw new Error(`${this.label}: tools/list must return a non-empty array`);
    }
    return tools.map((t) => (t as Record<string, unknown>).name as string).sort();
  }

  /**
   * End stdin, then make sure the child is actually gone.
   *
   * Bounded on both legs, and the kill is aimed at the PID this session
   * spawned. Idempotent.
   */
  async dispose(): Promise<void> {
    this.closed = true;
    if (this.child.exitCode !== null || this.child.signalCode !== null) return;
    this.child.stdin.end();
    if (await this.waitForExit(this.exitGraceMs)) return;
    const pid = this.child.pid;
    // Scoped to the PID `spawn` returned. A pattern match here would reach other
    // agents' processes on this shared box; see the header.
    if (pid !== undefined && pid !== process.pid && isOwnChild(pid)) {
      try {
        process.kill(pid, 'SIGKILL');
      } catch {
        // ESRCH: it exited between the check and the signal. Nothing to reap.
      }
      await this.waitForExit(this.exitGraceMs);
    }
  }

  /**
   * Kill the child now, by PID, and let the `exit` handler do the reporting.
   *
   * For a watchdog that fires with nothing in flight: a session-level deadline
   * needs to end the child even when there is no promise to reject, and killing
   * rather than throwing means the failure arrives as a *named* one — signal,
   * pid, stderr, host pressure — instead of a bare "the deadline passed".
   */
  killNow(): void {
    const pid = this.child.pid;
    if (pid === undefined || pid === process.pid || !isOwnChild(pid)) return;
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      // ESRCH: already gone. The exit handler has said so already.
    }
  }

  /**
   * Close stdin without closing the session.
   *
   * For the child that is *meant* to exit on EOF — a server that refuses to
   * start, say. `request` stays usable in principle, so this is deliberately
   * not the same thing as `dispose`.
   */
  closeStdin(): void {
    this.child.stdin.end();
  }

  /** Resolve true if the child exits within `ms`. False means it is still up. */
  async waitForExit(ms: number = this.exitGraceMs): Promise<boolean> {
    if (this.child.exitCode !== null || this.child.signalCode !== null) return true;
    let timer: NodeJS.Timeout;
    const deadline = new Promise<'timeout'>((resolve) => {
      timer = setTimeout(() => resolve('timeout'), ms);
      timer.unref();
    });
    try {
      return (await Promise.race([once(this.child, 'exit').then(() => true as const), deadline])) === true;
    } finally {
      clearTimeout(timer!);
    }
  }
}

/**
 * The one sentence a reader needs after a child dies: how it died, which PID,
 * and whatever it managed to say first.
 *
 * `classifyChild`/`describeOutcome` do the naming so the vocabulary matches
 * #1335's — a `SIGKILL` reads "killed by SIGKILL" here for the same reason it
 * does there, and neither helper invents a second way to say it. The explicit
 * `code=` and `signal=` are added because `describeOutcome` reports one or the
 * other and a reader chasing a flake wants both.
 */
export function exitSummary(
  label: string,
  pid: number | undefined,
  code: number | null,
  signal: NodeJS.Signals | null,
  stderr: string,
): string {
  const outcome = describeOutcome(classifyChild({ signal, status: code, stderr }));
  return `${label}: the server process ${outcome} (code=${code} signal=${signal} pid=${pid ?? 'unknown'})`;
}

/**
 * The paragraph that says what kind of death this is, separate from the facts
 * so that a message carrying both a summary and a `provenance()` block can say
 * it exactly once. Composing the two without this is how a reader ends up with
 * two `child stderr:` blocks and two disagreeing load readings in one message.
 */
export function explainExit(signal: NodeJS.Signals | null): string {
  return signal
    ? 'This is a resource/process failure, NOT a product failure. Nothing the server could have said'
      + ' was lost — a signal takes its stderr with it. Check the host pressure line below, and the'
      + ' load on the machine, before reading anything into the product.'
    : 'The child ended on its own; the assertion that would have run here never got a result to judge.';
}

export function describeExit(
  label: string,
  pid: number | undefined,
  code: number | null,
  signal: NodeJS.Signals | null,
  stderr: string,
): string {
  const tail = stderr.trim().slice(-2000);
  return [
    exitSummary(label, pid, code, signal, stderr),
    explainExit(signal),
    `host pressure: ${describeHostPressure()}`,
    `child stderr:\n${tail || '<nothing on stderr>'}`,
  ].join('\n');
}
