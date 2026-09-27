/**
 * #1365 — `tests/mcp.smoke.test.ts` can block forever.
 *
 * ## What was reported
 *
 * Four independent runs, in four different worktrees, on this one file:
 *
 * ```
 * pid=1174368 elapsed=59:46 cpu=0.0% cwd=/home/jack/wt/x1310
 * pid=1183975 elapsed=59:12 cpu=0.0% cwd=/home/jack/wt/x710
 * pid=1199591 elapsed=58:15 cpu=0.0% cwd=/home/jack/wt/x608
 * pid=1351646 elapsed=47:17 cpu=0.0% cwd=/home/jack/wt/x629
 * ```
 *
 * 0.0 % CPU is the load-bearing detail. These were not slow, they were blocked,
 * and they never returned — which on a shared box is worse than slow, because a
 * wedged file holds its concurrency slot forever.
 *
 * ## Why nothing bounded them
 *
 * `npm test` runs `node --import tsx --test 'tests/*.test.ts'`. There is no
 * `--test-timeout` in this repo, so the runner's own default applies and it is
 * unbounded. That left the file's 30 s watchdog as the only deadline — and it
 * was armed in `before()` and cleared at the top of `after()`, so it bounded the
 * handshake and nothing after it. The clear was not incidental: it is the bug.
 *
 * The obvious repair was to raise the 30 s, and it is the wrong one. The repo's
 * own measurement is `initialize: 2046ms` / `tools/list: 2125ms` under load ~48,
 * so 30 s is already ~14x the real cost and the slack is deliberate. Raising it
 * adds no information, converts a diagnosable red into an unbounded one, and
 * would still have been cleared by the same `after()`.
 *
 * ## What actually held the loop open
 *
 * Not the missing timeout — a missing timeout does not produce 0.0 % CPU, it
 * produces a test that waits. The 0.0 % came from a reaped child that had not
 * released its pipes. `StdioJsonRpcChild.dispose()` killed the child and
 * returned, leaving one `PipeWrap` registered per stdio stream. If anything
 * still held the inherited write end, the read end never reached EOF and the
 * test file's event loop could never drain.
 *
 * Reproduced against this repo's own helper, unmodified, before writing any of
 * the fix:
 *
 * ```
 * dispose() returned. active handles now: ["PipeWrap","PipeWrap","ProcessWrap"]
 * *** LEAK DETECTED: loop still held after dispose() ***     (exit 7)
 * ```
 *
 * That is the shape the fix removes, and the first test below pins it: the same
 * scenario must come back with the handle count at its baseline.
 *
 * ## The two bounds, and why there are two
 *
 * A deadline timer cannot bound a *synchronous* child. Measured, not inferred:
 * a timer armed for 200 ms did not fire until a 1.5 s `execFileSync` returned,
 * because the event loop does not run while one is on the stack. This file runs
 * `npm pack`, whose `prepack` is a full `tsc`. So the file deadline covers the
 * asynchronous remainder and `execFileBoundedSync` covers the synchronous part.
 * Both are pinned here.
 *
 * ## Red-proofs
 *
 * Each case names the one-line source change that turns it red, and each was run:
 *
 *   - delete `releaseStreams()` from `dispose()` → "releases the pipes" fails,
 *     with the leaked handle count named in the assertion;
 *   - delete `timer.unref()` → "cannot itself hold the loop open" fails;
 *   - drop the `children` from the breach → "names every child it reaped" fails;
 *   - revert `execFileBoundedSync` to a raw `execFileSync` → "reports a timed-out
 *     synchronous child as killed" fails on the missing `SIGKILL`.
 */
import './helpers/hermetic.js';

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { HERMETIC_ROOT } from './helpers/hermetic.js';
import {
  armFileDeadline,
  breachFileDeadline,
  describeFileDeadlineBreach,
  type DeadlineChild,
} from './helpers/file-deadline.js';
import { hermeticServerEnv, StdioJsonRpcChild } from './helpers/stdio-child.js';
import { execFileBounded } from './helpers/subprocess-outcome.js';

const NODE = process.execPath;
const REPO_ROOT = join(import.meta.dirname, '..');
const SMOKE = join(import.meta.dirname, 'mcp.smoke.test.ts');

/** Short enough to keep the red-proof quick, long enough not to flake. */
const BREACH_BUDGET_MS = 2_000;
/** The unref'd-timer cases need this to be comfortably longer than the wait. */
const IDLE_BUDGET_MS = 30_000;

const handleCount = (kind: string): number =>
  process.getActiveResourcesInfo().filter((r) => r === kind).length;

const wait = (ms: number): Promise<void> => new Promise((r) => { setTimeout(r, ms); });

/** How long {@link settledHandleCount} waits for the global count to stop moving. */
const SETTLE_BUDGET_MS = 10_000;
/** Consecutive equal samples that count as "stopped moving". */
const SETTLE_STABLE_SAMPLES = 3;
const SETTLE_POLL_MS = 25;

/**
 * `handleCount`, sampled until it stops moving.
 *
 * `process.getActiveResourcesInfo()` is **process-global**: it reports handles
 * belonging to every concurrent thing in this process, not to the child a test
 * spawned. A baseline captured at T0 and an assertion at T0+250ms are two
 * samples of a moving quantity, and the interval between them contains the
 * warm-up child's own asynchronous release — so the count could rise for
 * reasons that have nothing to do with the code under test. That is not
 * hypothetical: it produced `2 !== 3` on Node 22 in CI while Node 24 passed on
 * the same commit, and it is the reason this file must not assert a raw global
 * count across a fixed sleep (#1413).
 *
 * "Stopped moving" is two consecutive equal samples rather than one, so a
 * single unlucky read cannot satisfy the poll. The deadline is a real bound:
 * this returns the last reading when it expires rather than spinning forever,
 * because a poll that cannot terminate is the very hang this file exists to
 * prevent (#1365). An unsettled reading still fails the caller's comparison,
 * so a timeout degrades to a red rather than to a false green.
 */
async function settledHandleCount(kind: string): Promise<number> {
  const deadline = Date.now() + SETTLE_BUDGET_MS;
  let previous = handleCount(kind);
  let stable = 0;
  while (Date.now() < deadline) {
    await wait(SETTLE_POLL_MS);
    const current = handleCount(kind);
    stable = current === previous ? stable + 1 : 0;
    previous = current;
    if (stable >= SETTLE_STABLE_SAMPLES) return current;
  }
  return previous;
}

/**
 * A child that leaves a **grandchild** holding the inherited stdout pipe, then
 * exits 0 immediately.
 *
 * This is the reported hang's mechanism, built on purpose. The direct child is
 * reaped promptly and cleanly — `dispose()` has nothing to complain about and no
 * signal to report — yet the parent's read end stays open, because a process the
 * parent never spawned and cannot signal still holds the write end. The
 * grandchild exits on its own so the case cannot leak a process across runs.
 */
const GRANDCHILD_HOLDER = [
  '-e',
  `const { spawn } = require('node:child_process');
   spawn(process.execPath, ['-e', 'setTimeout(() => process.exit(0), 1500)'],
         { stdio: ['ignore', 1, 2] }).unref();
   process.exit(0);`,
];

function spawnGrandchildHolder(label: string): StdioJsonRpcChild {
  return StdioJsonRpcChild.spawn({
    label,
    command: NODE,
    args: GRANDCHILD_HOLDER,
    cwd: tmpdir(),
    env: hermeticServerEnv({}, label).env,
    requestTimeoutMs: BREACH_BUDGET_MS,
  });
}

/** A live child that ignores stdin EOF, so a reap has to mean a signal. */
function spawnIdleChild(label: string): StdioJsonRpcChild {
  return StdioJsonRpcChild.spawn({
    label,
    command: NODE,
    args: ['-e', 'setInterval(() => {}, 1000)'],
    cwd: tmpdir(),
    env: hermeticServerEnv({}, label).env,
    requestTimeoutMs: BREACH_BUDGET_MS,
  });
}

/**
 * The message from an operation that is expected to throw.
 *
 * `run` is typed `() => unknown` rather than `() => Promise<unknown>` because
 * half of what this file checks is *synchronous* — `execFileBounded` wraps
 * `execFileSync`, and a `Promise` signature would not accept it.
 */
async function rejectionMessage(run: () => unknown): Promise<string> {
  try {
    await run();
  } catch (error) {
    return (error as Error).message;
  }
  assert.fail('the operation was expected to reject, and it resolved');
}

/**
 * Blank comments, string literals, template literals and regex literals to
 * spaces, preserving length and line structure.
 *
 * The source guards in the last describe block need to read `mcp.smoke.test.ts`
 * as **code**. The first draft of those guards read it as text and matched this
 * file's own prose — it fails on `clearTimeout(watchdog)`, and it fires the
 * "first hook" search on the word "before" inside a docblock. An assertion that
 * reads the same text it is documenting cannot be trusted to be about the
 * program: it goes red for the wrong reason and, worse, it could be made green
 * by editing a comment instead of the code. That is the AGENTS.md §6 trap one
 * layer down, so the guards scan this instead.
 *
 * Length-preserving on purpose: the "armed above every hook" guard compares
 * character offsets, and blanking with removal would silently shift them.
 *
 * Regex literals are handled with the standard prev-token heuristic because a
 * *missed* regex is not a no-op — `#!/usr/bin/env node` (line 394 of the smoke
 * file) begins with a `!` followed by a `/`, which reads as a regex opener, and
 * an unhandled one would eat the rest of that line.
 *
 * Driven on real inputs by `the stripper distinguishes code from prose` below,
 * including the two inputs that broke the first draft of these guards.
 */
function stripCommentsAndLiterals(source: string): string {
  const out = source.split('');
  const blank = (from: number, to: number): void => {
    for (let i = from; i < to; i += 1) {
      if (out[i] !== '\n' && out[i] !== '\r') out[i] = ' ';
    }
  };

  // Trailing significant text, so `/` can be classified as division vs regex.
  // Only kept (non-blanked) characters feed this, so a `/` inside a comment
  // cannot influence how the next one is read.
  let tail = '';
  const keep = (ch: string): void => { tail = (tail + ch).slice(-16); };
  const regexAllowed = (): boolean =>
    tail.trimEnd() === ''
    || '(,=:[!&|?{};+-*%<>~^'.includes(tail.trimEnd().slice(-1))
    || /\b(return|typeof|case|of|in|new|delete|void|instanceof|do|else|yield|await)$/
      .test(tail.trimEnd());

  let i = 0;
  while (i < source.length) {
    const ch = source[i]!;
    const next = source[i + 1];

    if (ch === '/' && next === '/') {
      const end = source.indexOf('\n', i);
      const stop = end === -1 ? source.length : end;
      blank(i, stop);
      i = stop;
      continue;
    }
    if (ch === '/' && next === '*') {
      const close = source.indexOf('*/', i + 2);
      const stop = close === -1 ? source.length : close + 2;
      blank(i, stop);
      i = stop;
      continue;
    }
    if (ch === "'" || ch === '"' || ch === '`') {
      const stop = scanQuoted(source, i, ch);
      blank(i, stop);
      // The closing quote feeds `tail`, so a `/` straight after a string reads
      // as division — the overwhelmingly common case (`"a" / 2`).
      keep(ch);
      i = stop;
      continue;
    }
    if (ch === '/' && regexAllowed()) {
      const stop = scanRegex(source, i);
      if (stop > i) {
        blank(i, stop);
        keep('/');
        i = stop;
        continue;
      }
    }
    keep(ch);
    i += 1;
  }
  return out.join('');
}

/** The index just past the literal opened at `start`, honouring `\\` escapes. */
function scanQuoted(source: string, start: number, quote: string): number {
  for (let i = start + 1; i < source.length; i += 1) {
    if (source[i] === '\\') { i += 1; continue; }
    if (source[i] === quote) return i + 1;
    if (source[i] === '\n' && quote !== '`') return i; // unterminated; do not run away
  }
  return source.length;
}

/**
 * The index just past the regex literal at `start`, or `start` if this `/` is
 * really a division operator. Character classes and escapes are handled so a
 * `/` inside `[...]` cannot end the literal early.
 */
function scanRegex(source: string, start: number): number {
  let inClass = false;
  for (let i = start + 1; i < source.length; i += 1) {
    const ch = source[i]!;
    if (ch === '\\') { i += 1; continue; }
    if (ch === '\n') return start; // regex literals cannot span lines
    if (ch === '[') inClass = true;
    else if (ch === ']') inClass = false;
    else if (ch === '/' && !inClass) {
      // Consume the flags; a `/x` that is really division lands here with a
      // following identifier, and the caller only accepts non-flag chars.
      let j = i + 1;
      while (j < source.length && /[a-z]/.test(source[j]!)) j += 1;
      const flags = source.slice(i + 1, j);
      if (!/^[dgimsuvy]*$/.test(flags)) return start;
      return j;
    }
  }
  return start;
}

describe('a reaped child must not leave its handles behind (#1365)', () => {
  it('releases the pipes a grandchild inherited, so the file can drain', async () => {
    // The direct regression for the reported hang, against the real helper.
    //
    // The baseline is measured around a spawn/dispose of a *cooperative* child
    // first, so the delta being asserted is this child's contribution and not
    // whatever the runner happened to be holding when the test started. Without
    // that, a pass could come from an unrelated handle appearing or vanishing.
    const warmup = spawnIdleChild('warmup-probe');
    await warmup.dispose();
    // Both baselines are settled, not sampled. The warm-up child's own streams
    // are released asynchronously, so a raw reading here can be taken before
    // that release lands — which is exactly how this assertion produced
    // `2 !== 3` on Node 22 while Node 24 passed (#1413). Settling the baseline
    // *and* the measurement the same way is what makes the comparison mean
    // "this child's contribution" rather than "what the runner was holding when
    // the clock happened to read".
    const baselinePipes = await settledHandleCount('PipeWrap');
    const baselineProcs = await settledHandleCount('ProcessWrap');

    const child = spawnGrandchildHolder('inherited-pipe-probe');
    const pid = child.pid;
    await child.dispose();

    // Settle rather than sleep a fixed 250ms: the grandchild's inherited write
    // end has to be the only thing that could still be holding the read end
    // open, and a fixed sleep cannot establish that. Three consecutive equal
    // samples can.
    const afterPipes = await settledHandleCount('PipeWrap');
    const afterProcs = await settledHandleCount('ProcessWrap');

    assert.equal(
      afterPipes,
      baselinePipes,
      'dispose() must release every stdio pipe it opened: a grandchild holding the '
      + 'inherited write end keeps the read end from reaching EOF, and the file then '
      + 'sits at 0% CPU forever. Red-proof: delete releaseStreams() from dispose().',
    );
    // `ProcessWrap` is released asynchronously after the exit event, so the
    // count can *fall* below the baseline between the two measurements and an
    // equality here would be a race with the runner's own cleanup. The claim is
    // "no ProcessWrap accumulated", so that is what is asserted — and it can
    // still fail: a `dispose()` that returned without reaping would leave this
    // child running and the count strictly above the baseline.
    assert.ok(
      afterProcs <= baselineProcs,
      `the child itself must be reaped: ${afterProcs} ProcessWraps against a baseline of ${baselineProcs}`,
    );

    // And the child is genuinely gone, not merely unreferenced.
    assert.notEqual(child.child.exitCode ?? child.child.signalCode, null, 'dispose() must reap the child');
    if (pid !== undefined) {
      assert.throws(() => process.kill(pid, 0), /ESRCH/, `pid ${pid} must be gone after dispose()`);
    }
  });

  it('releases the pipes of a child that was killed rather than closed', async () => {
    // The other `dispose()` path. A child that ignores stdin EOF is reaped by
    // signal, and that is the case where a `dispose()` written to return early
    // on "the child is gone" would most plausibly skip its cleanup.
    const warmup = spawnIdleChild('warmup-probe-2');
    await warmup.dispose();
    const baselinePipes = await settledHandleCount('PipeWrap');

    const child = spawnIdleChild('killed-probe');
    await child.dispose();
    const afterPipes = await settledHandleCount('PipeWrap');

    assert.equal(child.child.signalCode, 'SIGKILL', 'this child must have been reaped by signal');
    assert.equal(
      afterPipes,
      baselinePipes,
      'a signalled child must release its pipes too, not only a politely closed one',
    );
  });

  it('is idempotent, so a second dispose() cannot re-arm or double-destroy', async () => {
    // `after()` in the smoke file now disposes every tracked child, and two tests
    // dispose children the `finally` blocks also dispose. Idempotence is what
    // makes that safe, so it is asserted rather than assumed.
    const child = spawnIdleChild('idempotent-probe');
    await child.dispose();
    const after = await settledHandleCount('PipeWrap');
    await child.dispose();
    assert.equal(
      await settledHandleCount('PipeWrap'),
      after,
      'a repeated dispose() must not change the handle count',
    );
    assert.equal(child.isRunning(), false, 'a disposed child is not running');
  });
});

describe('the whole-file bound cannot be the reason a file hangs (#1365)', () => {
  it('does not itself hold the event loop open', async () => {
    // The load-bearing property of `timer.unref()`, and the reason this is a
    // deadline rather than a sleep: a bound that held the loop would guarantee a
    // hang in every clean run, which is the failure it is installed to prevent.
    //
    // Driven in a real child process, because "the process exited on its own" is
    // the only honest witness. In-process the test runner's own handles hold the
    // loop, so the assertion would be measuring the runner rather than the timer.
    const probe = mkdtempSync(join(tmpdir(), 'deadline-unref-'));
    const script = join(probe, 'probe.mts');
    // `await` on the dynamic import keeps the module load off the critical path,
    // then nothing at all is scheduled: a ref'd timer would hold the loop for the
    // full budget, an unref'd one lets the process fall out of the bottom.
    writeFileSync(script, `
      import { armFileDeadline } from ${JSON.stringify(join(import.meta.dirname, 'helpers', 'file-deadline.ts'))};
      armFileDeadline({ label: 'unref-probe', budgetMs: ${IDLE_BUDGET_MS}, children: () => [] });
    `);

    const child = StdioJsonRpcChild.spawn({
      label: 'unref-probe',
      command: NODE,
      args: ['--import', 'tsx', script],
      cwd: REPO_ROOT,
      env: hermeticServerEnv({}, 'unref-probe').env,
      requestTimeoutMs: BREACH_BUDGET_MS,
    });
    try {
      const started = Date.now();
      const exited = await child.waitForExit(IDLE_BUDGET_MS + 10_000);
      const elapsed = Date.now() - started;
      assert.ok(
        exited,
        `the probe must exit on its own; the budget was ${IDLE_BUDGET_MS}ms and it was still alive after `
        + `${elapsed}ms, so the deadline timer is holding the event loop open. Red-proof: delete timer.unref().`,
      );
      // The budget was 30 s. Landing near it means the timer held the loop.
      assert.ok(
        elapsed < 20_000,
        `an unref'd deadline must not delay exit (took ${elapsed}ms of a ${IDLE_BUDGET_MS}ms budget)`,
      );
    } finally {
      await child.dispose();
      rmSync(probe, { recursive: true, force: true });
    }
  });

  it('fires on schedule when something else is holding the loop open', async () => {
    // The other half, and it is what makes the bound worth arming: an `unref`'d
    // timer does not fire on a clean drain, so the only way to reach this is for
    // something to be holding the loop. The grandchild-holder does exactly that.
    //
    // Red-proof: delete `timer.unref()` and this case still passes, so the two
    // cases together are the property — this one proves the bound is live, the
    // one above proves it is free.
    const child = spawnGrandchildHolder('bound-fires-probe');
    const reports: string[] = [];
    // Leak the pipes the way the pre-fix `dispose()` did, so the loop is held by
    // something real rather than by a synthetic timer we would then be testing.
    await child.dispose();
    child.child.stdin.destroy();
    armFileDeadline({
      label: 'bound-fires-probe',
      budgetMs: 500,
      children: () => [child],
      onBreach: (report) => { reports.push(report); },
    });

    await wait(2_000);

    assert.equal(reports.length, 1, 'the deadline must fire exactly once while the loop is held open');
    const report = reports[0]!;
    assert.match(report, /exceeded its 500ms whole-file budget/, 'the report must name the budget it exceeded');
    assert.doesNotMatch(report, /still running when the budget expired/, 'the child had already exited, so it must not be reported as live');
    // The `children` wiring, which is the only path that goes through
    // `armFileDeadline` rather than calling `breachFileDeadline` directly.
    //
    // The first draft of this case asserted nothing about *which* children the
    // breach saw, and that made it vacuous: replacing `children: options.children()`
    // with `children: []` in `armFileDeadline` left the test green, while a real
    // breach would have reported "no live children registered" — i.e. the one
    // thing the report exists to rule out. Both assertions below fail on that
    // mutation, and only on that mutation.
    assert.match(report, /bound-fires-probe/, 'the report must name the child the caller registered');
    assert.doesNotMatch(
      report,
      /no live children registered/,
      'a breach with a registered child must never claim it had none — red-proof: drop the children from the breach',
    );
  });
});

describe('a breach reports what it killed, by signal (#1365)', () => {
  it('names the signal, the pid and the stderr of every child it reaped', async () => {
    // The definition of done for this issue, driven end to end: real children,
    // a real SIGKILL, and an assertion that the failure names the signal.
    const alive = spawnIdleChild('breach-alive');
    const alreadyDead = spawnIdleChild('breach-dead');
    // Provably dead before the breach, so the report has to distinguish a child
    // this deadline killed from one that exited on its own. Without that second
    // child, "everything says SIGKILL" would pass for the wrong reason.
    await alreadyDead.dispose();
    const reports: string[] = [];

    const report = breachFileDeadline({
      label: 'tests/file-deadline.test.ts',
      budgetMs: BREACH_BUDGET_MS,
      children: [alive, alreadyDead],
      onBreach: (r) => { reports.push(r); },
    });

    assert.equal(reports.length, 1, 'onBreach must be called exactly once');
    assert.match(report, /alive: killed by SIGKILL \(code=null signal=SIGKILL pid=\d+\)/,
      'a child this deadline killed must be named by signal and pid — red-proof: drop the children from the breach');

    // `killNow()` sends the signal; `signalCode` is only populated when the
    // `exit` event is delivered, so the assertion below is read *after* the event
    // rather than after the syscall. Asserting it immediately would be racing
    // the event loop, and it would fail intermittently for a child that really
    // was killed — which is how a test teaches you to ignore it.
    assert.ok(await alive.waitForExit(IDLE_BUDGET_MS), 'the breach must actually have killed the child');
    assert.notEqual(alive.child.signalCode, null, 'the child must have died by signal');
    assert.equal(alive.child.signalCode, 'SIGKILL', 'and it must have been SIGKILL, not a polite close');
    assert.equal(alive.child.exitCode, null, 'a signalled child has no exit code');

    // The contrast case: a child that was already reaped reports how it ended
    // rather than claiming this deadline killed it.
    assert.doesNotMatch(report, /dead: killed by SIGKILL/,
      'a child that had already been reaped must not be reported as killed by this breach');

    assert.match(report, /exceeded its 2000ms whole-file budget/, 'the budget must be named');
    assert.match(report, /reaped by recorded pid only/, 'the report must state the reaping was PID-scoped');
    assert.match(report, /host pressure:/, 'a breach must carry the host pressure line');
    assert.match(report, /Handles still registered/, 'the report must name the handles that refused to drain');
    assert.match(report, /not a product failure/, 'a resource failure must not read as a defect');
  });

  it('says so plainly when the handle outliving the child is not one of ours', () => {
    // The report's own blind spot. A breach with no tracked children means the
    // leak is in the harness, not in a server — and a report that listed nothing
    // would read as "no children, nothing wrong".
    const report = describeFileDeadlineBreach(
      { label: 'tests/empty.test.ts', budgetMs: 1000, children: [] },
      new Set(),
    );
    assert.match(report, /no live children registered/, 'an empty child list must be stated, not shown as blank');
    assert.match(report, /not one of ours/, 'and it must say where the leak therefore is');
  });

  it('quotes a signal-killed child\'s empty stderr rather than leaving a blank', () => {
    // A SIGKILL produces no stderr. The blank has to be explained, or the next
    // reader decides for themselves that the child said nothing because it had
    // nothing to say. Driven through the structural `DeadlineChild` shape rather
    // than a real child, because the state being asserted — a child that died by
    // signal and left nothing behind — cannot be produced on demand any other way.
    const report = describeFileDeadlineBreach(
      {
        label: 'tests/stderr.test.ts',
        budgetMs: 1000,
        children: [{
          label: 'silent', pid: 4242, stderr: '', outcomeDescription: 'killed by SIGKILL',
          isRunning: () => false, killNow: () => {},
        } satisfies DeadlineChild],
      },
      new Set(),
    );
    assert.match(report, /<nothing on stderr — consistent with a signal kill/, 'empty stderr must be stated');
    assert.match(report, /pid=4242/, 'and the pid must still be named');
    assert.match(report, /silent: killed by SIGKILL/, 'the child must be reported by signal, not as merely gone');
  });
});

describe('a synchronous child is bounded by its own timeout (#1365)', () => {
  it('reports a timed-out synchronous child as killed, not as never started', async () => {
    // `npm pack`'s `prepack` is a full `tsc`, and no timer can bound it: the
    // event loop is blocked for its duration. The `timeout` option is the only
    // bound, and the shape it produces is the thing worth pinning — a raw
    // `execFileSync` surfaces `ETIMEDOUT` and a reader cannot tell a slow build
    // from a killed one.
    //
    // Red-proof: revert `execFileBounded` to a bare `execFileSync` and this
    // fails on the missing SIGKILL.
    const message = await rejectionMessage(() => execFileBounded(
      NODE,
      ['-e', 'setTimeout(() => {}, 60000)'],
      { label: 'slow-tsc-probe', timeoutMs: 400, cwd: tmpdir() },
    ));
    assert.match(message, /killed by SIGKILL/, 'a timed-out synchronous child must be reported as signalled');
    assert.match(message, /exceeding its 400ms budget/, 'the report must name the budget it exceeded');
    // The message is hard-wrapped, so this matches the half of the sentence on
    // one line rather than the phrase across the break.
    assert.match(message, /bounded by a timer/, 'it must say why the child had to carry its own bound');
    assert.match(message, /event loop is blocked/, 'and name the mechanism, so the next reader can verify it');
    assert.match(message, /NOT a product failure/, 'and it must not read as a product defect');
  });

  it('reports a child that never started as never started', async () => {
    // The other branch, so `ETIMEDOUT` cannot be the only outcome the helper
    // knows: a missing binary must not be filed as a killed process.
    const message = await rejectionMessage(() => execFileBounded(
      join(tmpdir(), 'no-such-binary-1365'),
      [],
      { label: 'missing-probe', timeoutMs: 5_000, cwd: tmpdir() },
    ));
    assert.match(message, /never started/, 'a binary that does not exist must say so');
    assert.doesNotMatch(message, /exceeding its/, 'and must not be reported as a timeout');
  });

  it('returns the output of a child that succeeds inside its budget', async () => {
    // The success path, which is the one every call site in the smoke file
    // actually takes. Without it, a helper that always failed would satisfy the
    // two cases above.
    const out = execFileBounded(NODE, ['-e', 'process.stdout.write("packed-ok")'], {
      label: 'pack-probe', timeoutMs: 30_000, cwd: tmpdir(),
    });
    assert.equal(out, 'packed-ok', 'a bounded child that succeeds must return its stdout');
  });
});

describe('the bound is armed, and above every hook (#1365)', () => {
  // The guards below read the file as **code**, not as prose.
  //
  // This file's own header explains the old `clearTimeout(watchdog)` line in
  // detail, and the first draft of this guard matched *that comment* and failed
  // on code that was already correct. An assertion that reads the same text it
  // is documenting is the AGENTS.md §6 trap one layer down: it does not check
  // the program, it checks its own explanation of the program, and it goes red
  // for the wrong reason while being unable to go green for the right one.
  // Comments and template literals are blanked to spaces so offsets stay
  // comparable and a comment can never satisfy — or fail — a guard.
  const code = stripCommentsAndLiterals(readFileSync(SMOKE, 'utf8'));

  it('the stripper is not a no-op, or these guards would be vacuous', () => {
    // The anti-vacuity case for the stripper itself. A stripper that silently
    // blanked everything would make every guard below pass for the wrong reason,
    // which is worse than having no guard. Anchors on both sides: the prose that
    // must be gone, and the code that must survive.
    const raw = readFileSync(SMOKE, 'utf8');
    assert.equal(code.length, raw.length, 'blanking must preserve length so offsets stay valid');
    assert.ok(code.length > 1000, 'the stripped source must still contain the file');
    assert.match(raw, /clearTimeout/, 'the raw file still discusses the old watchdog in prose');
    assert.doesNotMatch(code, /clearTimeout/, 'but the code does not contain it — that is what makes the guard meaningful');
    for (const anchor of ['import ', 'describe(', 'armFileDeadline(', 'spawnTracked(', 'execFileBounded(']) {
      assert.ok(code.includes(anchor), `real code must survive the stripper: ${anchor}`);
    }
  });

  it('arms the whole-file deadline at module scope', () => {
    // A source invariant, because the failure this fixes was a *placement*
    // failure: a watchdog inside `before()` bounds the handshake, and one that
    // `after()` clears bounds nothing. Position is the whole claim, so it is
    // checked positionally rather than by "does the identifier appear".
    const arm = code.indexOf('armFileDeadline(');
    assert.ok(arm !== -1, 'the smoke file must arm a whole-file deadline');
    const firstHook = Math.min(
      ...['before(', 'beforeEach(', 'describe(']
        .map((token) => code.indexOf(token))
        .filter((i) => i !== -1),
    );
    assert.ok(firstHook !== -1, 'the smoke file must register a hook or a suite, or this proves nothing');
    assert.ok(
      arm < firstHook,
      `the deadline must be armed above every hook (armed at ${arm}, first hook at ${firstHook})`,
    );
  });

  it('cannot be cleared from a teardown hook', () => {
    // `armFileDeadline` returns `void`, so there is nothing to hold and nothing
    // to clear. This guards the *old* shape specifically, because that line is
    // what the reported hangs came through.
    assert.doesNotMatch(
      code,
      /clearTimeout\s*\(/,
      'a bound this file can clear from a teardown hook is not a bound — the old watchdog was cleared in after()',
    );
    assert.doesNotMatch(
      code,
      /setTimeout\s*\(/,
      'the old file-level kill timer must be gone, replaced by the whole-file deadline',
    );
  });

  it('reaps every spawned child in teardown, not just the one from before()', () => {
    // The old `after()` disposed a single `client`. The two children spawned
    // inside tests were outside its reach, so either could be the one still
    // holding the event loop open.
    assert.match(code, /for \(const child of spawned\)/, 'teardown must iterate every tracked child');
    assert.match(code, /await child\.dispose\(\)/, 'and dispose each one');
    // Exactly one direct call, and it has to be the wrapper's own — a second one
    // is a child that escaped tracking, so the deadline can neither name nor
    // reap it. The `typeof` annotation in the wrapper's signature is *not* a
    // call site and is not counted, which is why this is a count and not a
    // `doesNotMatch`.
    const direct = code.match(/StdioJsonRpcChild\s*\.\s*spawn\s*\(/g) ?? [];
    assert.equal(
      direct.length,
      1,
      `only the tracking wrapper may call the spawner directly, found ${direct.length}`,
    );
    // Three call sites in the file: the handshake server, the packed entry and
    // the read-only surface. All three must be `spawnTracked({…})`.
    const callSites = code.match(/\bspawn\w*\s*\(\s*\{/g) ?? [];
    assert.equal(
      callSites.length,
      3,
      `all three spawn sites must go through the tracking wrapper, found ${callSites.length}`,
    );
    for (const site of callSites) {
      assert.ok(site.startsWith('spawnTracked'), `every call site must be spawnTracked, found ${site}`);
    }
  });

  it('bounds npm pack on its own, because a timer cannot', () => {
    // Both bounds, and the reason there are two.
    assert.match(code, /execFileBounded\(/, 'the synchronous npm pack call must go through the bounded helper');
    assert.equal(
      (code.match(/execFileBounded\(/g) ?? []).length,
      2,
      'both synchronous children (npm pack and tar) must be bounded',
    );
    assert.match(code, /PACK_TIMEOUT_MS/, 'and must carry an explicit timeout');
    assert.match(code, /FILE_BUDGET_MS/, 'the whole-file deadline must still exist for the async remainder');
    assert.doesNotMatch(
      code,
      /\bexecFileSync\s*\(/,
      'no raw execFileSync may remain: it is unbounded and unclassified',
    );
  });
});

describe('the stripper distinguishes code from prose (#1365)', () => {
  // The stripper is load-bearing for the four guards above, so it is tested on
  // its own terms rather than trusted. Every case here is one that actually bit
  // during this fix, and each is paired with a red-proof note.
  it('blanks line comments, block comments and both docblock styles', () => {
    // Red-proof: a stripper that handles only `/* */` leaves `//` prose in and
    // `doesNotMatch(code, /setTimeout\s*\(/)` goes red on this file's own text.
    const code = stripCommentsAndLiterals([
      'const a = 1; // clearTimeout(watchdog)',
      'const b = 2;',
      '/* armFileDeadline( is discussed here */',
      '/**',
      ' * before( is a hook, and this is prose',
      ' */',
      'const c = 3;',
    ].join('\n'));
    assert.doesNotMatch(code, /clearTimeout/, 'line comment prose must be blanked');
    assert.doesNotMatch(code, /armFileDeadline/, 'block comment prose must be blanked');
    assert.doesNotMatch(code, /before\(/, 'a docblock must be blanked like any other comment');
    assert.match(code, /const a = 1;/, 'and real code must survive');
    assert.match(code, /const c = 3;/, 'including the line after a block comment');
  });

  it('blanks string and template literals, so a path cannot fake a call site', () => {
    // `setTimeout(` inside a message string is not a call site. A guard that
    // cannot tell the difference will pass a file that really does call it.
    const code = stripCommentsAndLiterals([
      "const msg = 'clearTimeout(watchdog) and setTimeout( are forbidden';",
      'const tpl = `armFileDeadline( in a template`;',
      'const dq = "StdioJsonRpcChild.spawn(";',
      'const real = setTimeout(1);',
    ].join('\n'));
    assert.equal(code.match(/setTimeout\s*\(/g)?.length, 1, 'only the real call may survive');
    assert.doesNotMatch(code, /clearTimeout/, 'string prose must be blanked');
    assert.doesNotMatch(code, /armFileDeadline/, 'template prose must be blanked');
    assert.doesNotMatch(code, /StdioJsonRpcChild/, 'double-quoted prose must be blanked');
  });

  it('does not mistake a shebang-style path for a regex literal', () => {
    // The real line from the smoke file, and the exact input that made a
    // string-blind scanner eat the remainder of the line. Red-proof: without
    // string handling the `!` reads as a regex opener and everything after the
    // `/usr/bin/env node` shebang comparison is blanked as a literal.
    const raw = "assert.equal(firstLine, '#!/usr/bin/env node', 'npm tarball must contain the shebang');\nconst after = 1;";
    const code = stripCommentsAndLiterals(raw);
    assert.equal(code.length, raw.length, 'length must be preserved');
    assert.match(code, /const after = 1;/, 'the line after a shebang-looking string must survive');
    assert.doesNotMatch(code, /usr\/bin/, 'and the shebang string itself must be blanked');
  });

  it('handles a real regex literal, and real division', () => {
    // Red-proof: a scanner with no regex support blanks `a / b` style division
    // as a literal, and a scanner that always treats `/` as division blanks
    // every regex. Both errors are invisible in the output, so both are pinned.
    const withRegex = stripCommentsAndLiterals("const ok = /^\\/\\.spotify-mcp/.test(uri);\nconst after = 1;");
    assert.doesNotMatch(withRegex, /spotify-mcp/, 'a regex literal must be blanked whole');
    assert.match(withRegex, /\.test\(uri\)/, 'and the call it feeds must survive');
    assert.match(withRegex, /const after = 1;/, 'and the blank must not run past the literal\'s end');

    const withDivision = stripCommentsAndLiterals('const half = total / 2;\nconst ratio = a / b / c;\nconst done = 1;');
    assert.match(withDivision, /const half = total \/ 2;/, 'division must survive intact');
    assert.match(withDivision, /const done = 1;/, 'and repeated division must not open a literal');
  });

  it('preserves length and newlines exactly, so offsets stay comparable', () => {
    // The positional guard compares character offsets, so a stripper that
    // removed characters instead of blanking them would make that guard compare
    // two different files.
    const raw = readFileSync(SMOKE, 'utf8');
    const code = stripCommentsAndLiterals(raw);
    assert.equal(code.length, raw.length, 'length must be preserved');
    assert.equal(
      code.split('\n').length,
      raw.split('\n').length,
      'line count must be preserved',
    );
    assert.equal(
      code.indexOf('armFileDeadline('),
      raw.indexOf('armFileDeadline('),
      'an identifier in code must sit at the same offset in both',
    );
  });
});

describe('the sandbox is still airtight (#1365)', () => {
  it('keeps every child home inside the disposable root', () => {
    // The breach report prints child stderr and host pressure; a child whose
    // `HOME` were the developer's real one would make that report a channel for
    // reading their `~/.spotify-mcp`.
    const { home } = hermeticServerEnv({}, 'breach-sandbox');
    assert.ok(home.startsWith(HERMETIC_ROOT), `every child home must be disposable, got ${home}`);
  });
});
