/**
 * #1366 — a killed server child must be reported as killed, not as a timeout.
 *
 * ## Why this file exists
 *
 * A full-suite run of `origin/main` (pinned `4554149`, 192 test files) produced
 * exactly one red:
 *
 * ```
 * x treats every documented truthy spelling as on and everything else as off (41437ms)
 *   Error: timeout waiting for tools/list
 *   stderr:
 *   [spotify-mcp] SPOTIFY_MCP_READONLY "banana" names no boolean; treating read-only mode as OFF. ...
 *       at Timeout._onTimeout (tests/env-switch-registry.test.ts:248:20)
 * ```
 *
 * The label is wrong. The watchdog in that file is 30 s and the guarded
 * operation measures ~2.1 s on the same box at the same load, so the child was
 * not slow — it was gone, and its in-flight promise had no settlement path for
 * a process that is no longer there. `stderr` cannot stand in: **a SIGKILL
 * leaves none**, so the quoted line is a config warning from before the child
 * died, which is itself evidence of a kill rather than a crash.
 *
 * ## What is being pinned
 *
 * That the two ways a request can fail stay **distinguishable at the point of
 * judgement**, and that the one naming a signal says so in the signal's own
 * vocabulary.
 *
 * These are real child processes, not hand-built outcome objects, so the shapes
 * asserted are the shapes Node produces. That matters here for the same reason
 * it did in `tests/subprocess-outcome.test.ts`: a synthetic `{signal: 'SIGKILL'}`
 * only proves the helper agrees with a shape its author imagined, and this bug
 * is precisely about a shape the author had not imagined — the *stream* going
 * quiet with no exit event wired to it.
 *
 * The red-proof is mechanical: comment out the `exit` listener in
 * `tests/helpers/stdio-child.ts` and the first case below fails after its
 * (deliberately short) watchdog with `timed out after ...` and no `SIGKILL`
 * anywhere in the message. That is the exact shape of the #1366 failure, and it
 * is the assertion that cannot pass for the wrong reason.
 */
import './helpers/hermetic.js';

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { sep } from 'node:path';
import { join } from 'node:path';

import { HERMETIC_ROOT } from './helpers/hermetic.js';
import {
  describeExit,
  describeHostPressure,
  guardedHandler,
  hermeticServerEnv,
  isOwnChild,
  StdioJsonRpcChild,
} from './helpers/stdio-child.js';

const NODE = process.execPath;

/** Await a rejection and return its message. */
async function rejectionMessage(run: () => Promise<unknown>): Promise<string> {
  try {
    await run();
  } catch (error) {
    return (error as Error).message;
  }
  assert.fail('the operation was expected to reject, and it resolved');
}

/**
 * A child that stays alive until it is killed. `2` keeps it off the server's
 * own exit paths: it prints nothing (so stderr is empty, the way a killed
 * server's is) and never answers (so the request is genuinely in flight when
 * the signal lands).
 */
const IDLE_CHILD = ['-e', 'setInterval(() => {}, 1000)'];

/** Short enough that the red-proof above is quick, long enough not to flake. */
const RED_PROOF_TIMEOUT_MS = 3_000;

function spawnIdleChild(label: string, timeoutMs: number): StdioJsonRpcChild {
  return StdioJsonRpcChild.spawn({
    label,
    command: NODE,
    args: IDLE_CHILD,
    cwd: tmpdir(),
    env: hermeticServerEnv({}, label).env,
    requestTimeoutMs: timeoutMs,
    exitGraceMs: 2_000,
  });
}

describe('a killed child is reported as killed (#1366)', () => {
  it('names the signal, the pid and the null exit code, not a timeout', async () => {
    const child = spawnIdleChild('sigkill-probe', RED_PROOF_TIMEOUT_MS);
    const started = Date.now();
    try {
      const inFlight = child.request('tools/list');
      // Let the request reach the transport so the child is provably mid-call
      // when the signal lands, rather than the request failing on a closed pipe.
      await new Promise((resolve) => setTimeout(resolve, 150));
      process.kill(child.pid!, 'SIGKILL');

      const message = await rejectionMessage(() => inFlight);

      // The signal, by name. A `code=null` alone would file an OOM kill under
      // "exited with no status", which is the misreport this closes.
      assert.match(message, /SIGKILL/, 'the failure must name the signal that killed the child');
      assert.match(message, /code=null/, 'a signalled child has no exit code, and saying so is part of the report');
      assert.match(message, new RegExp(`pid=${child.pid}\\b`), 'the failure must name the pid that was killed');
      assert.match(message, new RegExp(`killed by SIGKILL|signal=SIGKILL`), 'the outcome must be stated in #1335\'s vocabulary');
      // And explicitly NOT the mislabel.
      assert.doesNotMatch(message, /timed out/, 'a dead child is not a timeout, and the watchdog is the fallback path');
      // This is the whole point of the "not a product failure" line: the reader
      // must be told to look at the box, not at the product.
      assert.match(message, /NOT a product failure/, 'a resource failure must not read as a product defect');

      // It must be *fast*. Before the fix this case sat out the full watchdog;
      // a fix that only changed the wording would leave the run just as slow.
      const elapsed = Date.now() - started;
      assert.ok(elapsed < RED_PROOF_TIMEOUT_MS, `the rejection must land on the exit event, not the watchdog (took ${elapsed}ms)`);
    } finally {
      await child.dispose();
    }
  });

  it('rejects a request made after the child already died, without waiting out the watchdog', async () => {
    // The door the exit listener does not cover. `failAll` settles what was in
    // flight at the moment of death; a request issued *afterwards* had nothing
    // to reject it, was written to a stdin nobody reads, and surfaced a full
    // watchdog later as "timed out waiting for tools/list".
    //
    // Not hypothetical: caught in this repo's own final run. A long-lived
    // `mcp-smoke` child (spawned in `before()`) was SIGKILLed mid-file under
    // load 139, and a *later* test in the same file asked it for `tools/list`.
    // The message said "timed out", with the SIGKILL visible only in a
    // provenance line the reader has no reason to prefer over the headline.
    // The signal was therefore reported, but under the wrong name, 30s late —
    // the same defect the issue describes, through a different path.
    const child = spawnIdleChild('post-mortem-probe', RED_PROOF_TIMEOUT_MS);
    try {
      // In flight when the signal lands, so `failAll` has something to reject
      // and we prove the latch is what settles the *second* request.
      const inFlight = child.request('tools/list');
      await new Promise((resolve) => setTimeout(resolve, 150));
      process.kill(child.pid!, 'SIGKILL');
      await rejectionMessage(() => inFlight);
      assert.ok(await child.waitForExit(2_000), 'the child must be observed dead before asking it anything');

      // Now the request that used to become a 30-second timeout.
      const started = Date.now();
      const message = await rejectionMessage(() => child.request('tools/list'));
      const elapsed = Date.now() - started;

      assert.match(message, /SIGKILL/, 'the failure must still name the signal, not merely "the child is gone"');
      assert.doesNotMatch(message, /timed out/, 'a dead child is not a timeout — that is the mislabel this closes');
      // "never sent" distinguishes this from a request that was transmitted and
      // lost, which is a different (and more suspicious) thing to go looking for.
      assert.match(message, /never sent/, 'the report must say the request was never put on the wire');
      assert.ok(
        elapsed < RED_PROOF_TIMEOUT_MS,
        `the rejection must be immediate, not the watchdog (took ${elapsed}ms of a ${RED_PROOF_TIMEOUT_MS}ms budget)`,
      );
    } finally {
      await child.dispose();
    }
  });

  it('rejects every in-flight request, not just the one that was sent first', async () => {
    // The `failAll` half. A child that dies with three requests outstanding
    // must reject all three, or the other two sit until their own watchdogs
    // and the file still reports a timeout.
    const child = spawnIdleChild('multi-pending-probe', RED_PROOF_TIMEOUT_MS);
    try {
      const first = child.request('tools/list');
      const second = child.request('prompts/list');
      const third = child.request('resources/list');
      await new Promise((resolve) => setTimeout(resolve, 150));
      process.kill(child.pid!, 'SIGKILL');

      for (const pending of [first, second, third]) {
        const message = await rejectionMessage(() => pending);
        assert.match(message, /SIGKILL/, 'every in-flight request must learn how the child died');
      }
    } finally {
      await child.dispose();
    }
  });

  it('a child that exits on its own is still distinguishable from a kill', async () => {
    // The other direction, and the one that keeps the signal assertion honest:
    // if every exit produced the same message, matching on "the child died"
    // would prove nothing. `exited 0` must not be reported as a signal.
    const message = await rejectionMessage(async () => {
      const child = StdioJsonRpcChild.spawn({
        label: 'clean-exit-probe',
        command: NODE,
        args: ['-e', 'process.exit(0)'],
        cwd: tmpdir(),
        env: hermeticServerEnv({}, 'clean-exit-probe').env,
        requestTimeoutMs: RED_PROOF_TIMEOUT_MS,
      });
      try {
        await child.request('tools/list');
      } finally {
        await child.dispose();
      }
    });
    assert.match(message, /code=0/, 'a clean exit must report its code');
    assert.doesNotMatch(message, /signal=SIGKILL/, 'a clean exit is not a signal kill');
  });

  it('still fails on the watchdog when the child is alive and simply never answers', async () => {
    // The fallback must survive the promotion. Without this case, "reject on
    // exit" could be satisfied by failing fast on everything, and a wedged
    // server would hang the run forever again.
    const child = spawnIdleChild('wedged-probe', RED_PROOF_TIMEOUT_MS);
    try {
      const message = await rejectionMessage(() => child.request('tools/list'));
      assert.match(message, /timed out after 3000ms/, 'a live child that never answers must hit the watchdog');
      assert.match(message, /still running/, 'the report must say the child was alive, which is what makes it a timeout');
      assert.match(message, new RegExp(`pid=${child.pid}\\b`), 'a timeout must still name the pid it was waiting on');
    } finally {
      await child.dispose();
    }
  });

  it('names the pid, signal and stderr together in one line', () => {
    // The message shape itself, so a reader of CI output gets the whole answer
    // without cross-referencing anything.
    const text = describeExit('env-switch', 4242, null, 'SIGKILL', '[spotify-mcp] a config warning\n');
    assert.match(text, /env-switch/);
    assert.match(text, /code=null/);
    assert.match(text, /signal=SIGKILL/);
    assert.match(text, /pid=4242/);
    assert.match(text, /killed by SIGKILL/);
    assert.match(text, /a config warning/, "the child's own stderr must survive into the message");
    // A SIGKILL produces no stderr; the message must say so rather than leave
    // a blank region for the reader to interpret.
    const silent = describeExit('env-switch', 4242, null, 'SIGKILL', '');
    assert.match(silent, /<nothing on stderr>/, 'an empty stderr must be stated, not left blank');
  });

  it('names the host pressure, so a kill is separable from a code defect', () => {
    // `node --test` runs test files in parallel by default, so a run is a herd
    // of full registry boots and an OOM kill is a routine event, not an
    // exotic one. A bare `signal=SIGKILL` does not say whether the box was
    // starved, and that is the only question the reader has. This line is what
    // answers it — the measurement the #1366 failure was missing.
    const pressure = describeHostPressure();
    assert.match(pressure, /load .* over \d+ cores/, `the load average must be reported: ${pressure}`);
    assert.match(pressure, /GiB free of .* GiB/, `free memory must be reported: ${pressure}`);

    // And it must reach the message, not just exist as an export.
    const killed = describeExit('env-switch', 4242, null, 'SIGKILL', '');
    assert.match(killed, /host pressure:/, 'a signal-kill message must carry the host pressure line');
    const clean = describeExit('env-switch', 4242, 0, null, '');
    assert.match(clean, /host pressure:/, 'the pressure line belongs to every child death, not only kills');
  });

  it('reports a child death once, not twice with two different load readings', async () => {
    // Caught in this repo's own full-suite run: a post-mortem message printed
    // `child stderr:` and `host pressure:` twice, and the two load figures
    // disagreed. `describeExit` is self-contained and `provenance()` embedded it
    // whole before adding its own copy of both. A reader given two pressure
    // readings cannot tell which is current — which undermines the one line
    // this whole file exists to make trustworthy.
    //
    // Driven on the post-mortem path on purpose. An *in-flight* rejection
    // carries only `describeExit` and never renders `provenance()`, so a test
    // written against it passes with the duplication restored — which is
    // exactly what the first draft of this test did, and exactly the kind of
    // green that asserts nothing. The duplication is only visible where
    // `provenance()` is composed into a message that already has a report.
    const child = spawnIdleChild('dup-probe', RED_PROOF_TIMEOUT_MS);
    try {
      const inFlight = child.request('tools/list');
      await new Promise((resolve) => setTimeout(resolve, 150));
      process.kill(child.pid!, 'SIGKILL');
      await rejectionMessage(() => inFlight);
      assert.ok(await child.waitForExit(2_000), 'the child must be observed dead before asking it anything');

      // This message is `dead.message` (the full report) PLUS `provenance()`.
      const message = await rejectionMessage(() => child.request('tools/list'));
      assert.ok(
        message.includes('never sent'),
        'this assertion is only meaningful on the post-mortem path',
      );

      const occurrences = (needle: string): number => message.split(needle).length - 1;
      assert.equal(occurrences('host pressure:'), 1, `host pressure must be reported exactly once:\n${message}`);
      assert.equal(occurrences('child stderr:'), 1, `child stderr must be reported exactly once:\n${message}`);
      // The signal still survives the de-duplication, which is the thing that
      // would actually be lost if this were fixed by trimming too much.
      assert.match(message, /SIGKILL/, 'the report must still name the signal after de-duplication');
    } finally {
      await child.dispose();
    }
  });
});

describe('a throw inside an event handler is reported, not fatal (#1366)', () => {
  // An agent hit this today by destructuring `Promise.withResolvers()` as
  // `{promise, resolveWith, rejectWith}` — the real names are `{promise,
  // resolve, reject}`. Both callbacks came back `undefined`, the `TypeError`
  // fired inside a `child.stdout.on('data')` handler, and it killed the test
  // runner *without failing an assertion*: every test that had not yet run
  // simply never ran. A harness that owns the handler bodies owns this risk.

  it('converts a throw in a handler body into a report, not an uncaught exception', () => {
    // Driven directly, because it cannot be reached from outside. The first
    // draft of this guard was an inline try/catch and the test written for it
    // passed with that try/catch deleted — every throw reachable from a real
    // child here is caught one level down, so the wrapper was never entered. A
    // test that cannot go red is worse than no test, so the contract moved
    // somewhere it can be driven. Remove the `try` and this goes red.
    const reported: Array<{ message: string; cause: Error }> = [];
    const handler = guardedHandler(
      (message, cause) => { reported.push({ message, cause }); },
      'stdout',
      // The exact failure from that incident: `entry.resolve` is undefined.
      // Takes the chunk, like a real stdout handler does. Declared with no
      // parameters, `guardedHandler` inferred a zero-argument handler and the
      // `handler('chunk')` call below had nothing to pass it to.
      (_chunk: string) => { (undefined as unknown as () => void)(); },
    );

    // Must not throw. If it does, the throw escapes the handler and takes the
    // test process with it — which is the bug, demonstrated rather than asserted.
    assert.doesNotThrow(() => handler('chunk'), 'a handler that throws must not propagate into the runner');
    assert.equal(reported.length, 1, 'the throw must be reported exactly once');
    assert.match(reported[0]!.message, /the stdout handler threw/, 'the report must name the handler that threw');
    assert.ok(
      reported[0]!.cause instanceof TypeError,
      'the original error must be carried, not swallowed and replaced',
    );
  });

  it('runs the body with its arguments, and does not report when it does not throw', () => {
    // The `exit` and `error` handlers cannot work without their code/signal and
    // error, so a wrapper that dropped its arguments would break the two
    // load-bearing listeners while every "does not report" test stayed green.
    const seen: unknown[][] = [];
    const reported: string[] = [];
    const handler = guardedHandler((message) => { reported.push(message); }, 'exit', (...args: unknown[]) => {
      seen.push(args);
    });
    handler(null, 'SIGKILL');
    assert.deepEqual(seen, [[null, 'SIGKILL']], 'every argument must reach the body, in order');
    assert.deepEqual(reported, [], 'a body that does not throw must report nothing');
  });

  it('reports a framing failure against a real child instead of dying quietly', async () => {
    // The integration half, and it is honest about its scope: this drives
    // `onStdout`'s own framing catch, NOT the guard above (which is why the
    // guard needed its own test). It matters anyway — a child that emits a
    // line that cannot be framed used to take the runner down mid-file, ending
    // every unrun test as an apparent pass.
    const child = spawnGarbageChild('garbage-framing');
    try {
      const message = await rejectionMessage(() => child.request('tools/list'));
      assert.match(message, /unreadable line on stdout/, 'the framing failure must name itself');
      assert.match(message, /this is not json/, 'the offending line must be quoted, so it can be identified');
      assert.match(message, /harness failure, not a product failure/, 'this must not read as a product defect');
    } finally {
      await child.dispose();
    }
  });

  it('latches the failure so a later request cannot slip through green', async () => {
    // The case with nothing in flight. A failure that lands while no request is
    // outstanding has no promise to reject, so without a latch it is reported
    // exactly zero times — and the next `request()` would sit on a stream known
    // to be unframable, waiting out its own watchdog.
    const child = spawnGarbageChild('garbage-latched');
    try {
      // Let the garbage line land with nothing outstanding.
      await new Promise((resolve) => setTimeout(resolve, 250));
      const message = await rejectionMessage(() => child.request('tools/list'));
      assert.match(
        message,
        /unreadable line on stdout/,
        'a request issued after an unframed line must be told about it immediately, not after its watchdog',
      );
    } finally {
      await child.dispose();
    }
  });
});

/** Writes garbage to stdout, then stays alive so it is not an exit that saves us. */
const GARBAGE_CHILD = [
  '-e',
  "process.stdout.write('this is not json\\n'); setInterval(() => {}, 1000);",
];

function spawnGarbageChild(label: string): StdioJsonRpcChild {
  return StdioJsonRpcChild.spawn({
    label,
    command: NODE,
    args: GARBAGE_CHILD,
    cwd: tmpdir(),
    env: hermeticServerEnv({}, label).env,
    requestTimeoutMs: RED_PROOF_TIMEOUT_MS,
  });
}

describe('reaping is scoped to our own pids, never a pattern match (#1366)', () => {
  it('refuses to treat an unrelated process as a child', () => {
    // This box runs ~19 agents' copies of this suite. A reap that matched a
    // command line rather than a PID would take out their servers and
    // manufacture failures in runs that have nothing to do with us. `pid <= 1`
    // and the test process's own pid are the cheapest falsifiable cases.
    assert.equal(isOwnChild(1), false, 'init is never a child of the test runner');
    assert.equal(isOwnChild(0), false, 'pid 0 is not a signalable process here');
    assert.equal(isOwnChild(-1), false, 'a negative pid is not a process');
    assert.equal(isOwnChild(process.pid), false, 'the test runner is not its own child');
    assert.equal(isOwnChild(1.5), false, 'a non-integer pid is not a process');
  });

  it('recognises a live child it spawned itself', async () => {
    const child = spawnIdleChild('own-child-probe', RED_PROOF_TIMEOUT_MS);
    try {
      assert.ok(child.pid !== undefined, 'spawn must report a pid for the reaping to be scoped to');
      assert.equal(isOwnChild(child.pid), true, 'a pid this session spawned must be recognisable as ours');
    } finally {
      await child.dispose();
    }
  });

  it('dispose() leaves nothing running, and is safe to call twice', async () => {
    const child = spawnIdleChild('dispose-probe', RED_PROOF_TIMEOUT_MS);
    const pid = child.pid!;
    // The child is in its keep-alive interval and will not exit on stdin EOF,
    // so this exercises the kill leg rather than the polite one.
    await child.dispose();
    assert.notEqual(child.child.exitCode ?? child.child.signalCode, null, 'dispose() must leave the child reaped');
    assert.throws(() => process.kill(pid, 0), /ESRCH/, `pid ${pid} must be gone after dispose()`);
    // Idempotence matters because every call site puts dispose() in a `finally`
    // that may run after an explicit teardown.
    await child.dispose();
  });
});

describe('the hermetic sandbox survives the helper (#1366)', () => {
  it('puts HOME, the token path and every store default inside the disposable root', () => {
    const { env, home } = hermeticServerEnv({ SPOTIFY_MCP_TOOLSETS: 'playback' }, 'sandbox');
    assert.equal(env.HOME, home, 'the child must resolve homedir() to the disposable root');
    assert.equal(env.USERPROFILE, home, 'the Windows spelling must agree with HOME');
    // Not `home.startsWith(home)`, which is the tautology this assertion would
    // collapse into if the root were not actually threaded through. The claim is
    // that it lands inside HERMETIC_ROOT, and that root is what gets removed on
    // exit — so a home anywhere else is a write into the developer's real store.
    assert.ok(
      home.startsWith(HERMETIC_ROOT + sep),
      `the disposable home must live under HERMETIC_ROOT (${HERMETIC_ROOT}), got ${home}`,
    );
    assert.equal(env.SPOTIFY_CLIENT_ID, 'test-client-id');
    assert.equal(
      env.SPOTIFY_MCP_TOKEN_FILE,
      join(home, 'tokens.json'),
      'the token path must be inside the disposable home, never the real ~/.spotify-mcp',
    );
    assert.equal(env.SPOTIFY_MCP_TOOLSETS, 'playback', 'a caller override must survive');
  });

  it('gives each child its own root, so two children cannot collide', () => {
    const first = hermeticServerEnv({}, 'collision-a').home;
    const second = hermeticServerEnv({}, 'collision-b').home;
    assert.notEqual(first, second, 'a shared root would let concurrent children write over each other');
  });

  it('strips an inherited SPOTIFY_* rather than blanking it', () => {
    // Since #617 a set-but-empty value is a startup error, so 'delete' and
    // '= ""' are not the same operation. A shell that exports
    // SPOTIFY_MCP_READONLY must not decide what a test asserts.
    process.env.SPOTIFY_MCP_READONLY = 'yes';
    process.env.SPOTIFY_MCP_TOKEN_FILE = '/somewhere/real/tokens.json';
    try {
      const { env } = hermeticServerEnv();
      assert.equal('SPOTIFY_MCP_READONLY' in env, false, 'an inherited switch must be deleted, not blanked');
      assert.equal('SPOTIFY_MCP_TOKEN_FILE' in env, true, 'the helper supplies its own token path');
      assert.notEqual(env.SPOTIFY_MCP_TOKEN_FILE, '/somewhere/real/tokens.json', 'the real token path must never reach a child');
    } finally {
      delete process.env.SPOTIFY_MCP_READONLY;
      delete process.env.SPOTIFY_MCP_TOKEN_FILE;
    }
  });

  it('lets a caller override the token path, which the smoke suite needs', () => {
    const fixture = join(tmpdir(), 'stdio-child-fixture-tokens.json');
    const { env } = hermeticServerEnv({ SPOTIFY_MCP_TOKEN_FILE: fixture });
    assert.equal(env.SPOTIFY_MCP_TOKEN_FILE, fixture, 'a written fixture must win over the absent-token default');
  });
});
