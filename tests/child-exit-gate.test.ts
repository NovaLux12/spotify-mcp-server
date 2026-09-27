import './helpers/hermetic.js';

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { classifySpawnSite, scanTestSuite } from './helpers/child-exit-gate.js';
import { StdioJsonRpcChild } from './helpers/stdio-child.js';

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));

// ---------------------------------------------------------------------------
// 1. The rule, driven in both directions.
//
// A scan with no negative fixture cannot fail (AGENTS.md §6), so every arm of
// the rule below is a synthetic source string. None of these fixtures is a
// file on disk; they exist so the classifier is exercised rather than merely
// invoked.
// ---------------------------------------------------------------------------

/** The #1404 shape verbatim: pending map, watchdog, no `exit` listener. */
const NO_EXIT_LISTENER = `
import { spawn } from 'node:child_process';
const child = spawn('node', ['server.js'], { stdio: ['pipe', 'pipe', 'pipe'] });
child.stdout.on('data', () => {});
child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }) + '\\n');
setTimeout(() => reject(new Error('timed out after 20s')), 20_000);
`;

/** The #1405 shape verbatim: a listener that takes \`code\` and drops \`signal\`. */
const EXIT_LISTENER_DROPS_SIGNAL = `
import { spawn } from 'node:child_process';
const child = spawn('node', ['server.js'], { stdio: ['pipe', 'pipe', 'pipe'] });
child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }) + '\\n');
child.on('exit', (code) => { reject(new Error(\`exited with code \${code}\`)); });
`;

/** A signal kill delivered by a harness to its own child. */
const KILL_DELIBERATELY = `
import { spawn } from 'node:child_process';
const child = spawn('node', ['server.js'], { stdio: ['pipe', 'pipe', 'pipe'] });
child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }) + '\\n');
child.on('exit', (_code, signal) => { reject(new Error(\`killed by \${signal}\`)); });
`;

/**
 * A file that delegates: no `spawn(` call of its own, so `stdio-child.ts`
 * registers the exit listener on its behalf. This is what `wire-registry.ts` and
 * `exhaust2_enggating.test.ts` became.
 */
const DELEGATES_TO_SHARED_HELPER = `
import { StdioJsonRpcChild } from './helpers/stdio-child.js';
const session = StdioJsonRpcChild.spawn({
  label: 'wire', command: 'node', args: ['server.js'], cwd: '.', env: {},
});
session.request('tools/list').then(serve).catch(fail);
`;

/**
 * A synchronous spawn. `status` and `signal` come back on the return value, so
 * there is no separate exit listener to forget — the rule must not fire.
 */
const SYNCHRONOUS_SPAWN = `
import { spawnSync } from 'node:child_process';
spawnSync('node', ['server.js']);
process.stdout.write(JSON.stringify({ jsonrpc: '2.0' }));
`;

/**
 * A child that is never asked anything. This is the `guard-sweep-loop` shape: a
 * `bash` script whose exit status *is* the assertion, plus a `stdio: 'ignore'`
 * helper that is killed in a `finally` and has no promise to reject. Requiring a
 * listener here would be a rule about spelling.
 */
const SPAWNS_BUT_NEVER_ASKS = `
import { spawn } from 'node:child_process';
const child = spawn('bash', ['scripts/sweep-loop.sh'], { stdio: ['pipe', 'pipe', 'ignore'] });
const latecomer = spawn('bash', ['-c', 'sleep 0.5'], { stdio: 'ignore' });
child.stdout.on('data', (c) => { seen += c; });
try { run(); } finally { latecomer.kill(); }
`;

test('#1404 the classifier accepts every compliant shape', () => {
  for (const [name, source] of [
    ['a signal-naming exit listener', KILL_DELIBERATELY],
    ['delegation to the shared helper', DELEGATES_TO_SHARED_HELPER],
  ] as const) {
    const verdict = classifySpawnSite(`fixture/${name}.ts`, source);
    assert.equal(verdict.compliant, true, `${name} must be compliant: ${verdict.reason ?? ''}`);
  }
});

test('#1404 the classifier rejects both live instances of the class', () => {
  // These two strings are the code as it was on `origin/main`, so this arm goes
  // red the moment the rule stops recognising them.
  for (const [name, source] of [
    ['no exit listener', NO_EXIT_LISTENER],
    ['exit listener that drops the signal', EXIT_LISTENER_DROPS_SIGNAL],
  ] as const) {
    const verdict = classifySpawnSite(`fixture/${name}.ts`, source);
    assert.equal(verdict.inScope, true, `${name} is in scope and the scan must say so`);
    assert.equal(verdict.compliant, false, `${name} must be rejected — this is the defect`);
    assert.match(verdict.reason ?? '', /stdio-child/, `${name} must say what to do about it`);
  }
});

test('#1404 an exit listener that drops the signal is NOT the same as no listener', () => {
  // The distinction #1405 exists for. A gate that only counted listeners would
  // pass `EXIT_LISTENER_DROPS_SIGNAL`, and `wire-registry.ts` had exactly that
  // listener on the day the issue was filed.
  const noListener = classifySpawnSite('a.ts', NO_EXIT_LISTENER);
  const dropsSignal = classifySpawnSite('b.ts', EXIT_LISTENER_DROPS_SIGNAL);
  const namesSignal = classifySpawnSite('c.ts', KILL_DELIBERATELY);

  assert.equal(noListener.exitListenerNamesSignal, false);
  assert.equal(dropsSignal.exitListenerNamesSignal, false);
  assert.equal(namesSignal.exitListenerNamesSignal, true);
});

test('#1404 the rule is scoped, so it does not fire on children it cannot help', () => {
  // Two ways to be out of scope, and both are load-bearing. A rule that fired
  // on these would be satisfied by a listener that records nothing, which is
  // the shape #1404 is about.
  for (const [name, source] of [
    ['a synchronous spawn', SYNCHRONOUS_SPAWN],
    ['a child that is never asked anything', SPAWNS_BUT_NEVER_ASKS],
  ] as const) {
    assert.equal(
      classifySpawnSite(`fixture/${name}.ts`, source).inScope,
      false,
      `${name} is out of scope and the scan must say so`,
    );
  }
});

// ---------------------------------------------------------------------------
// 2. The scan, over the real tree.
// ---------------------------------------------------------------------------

test('every tests/ file that speaks JSON-RPC to a spawned child can report how it died', () => {
  const offenders = scanTestSuite().filter((v) => !v.compliant);
  assert.deepEqual(
    offenders.map((v) => `${v.file}: ${v.reason}`),
    [],
    'these files call spawn() themselves, ask the child something over JSON-RPC, '
      + 'and cannot say how it died — a killed child settles nothing and is '
      + 'reported as a timeout',
  );
});

test('the scan has a non-empty scope, so it is not passing vacuously', () => {
  // A gate that matches nothing is indistinguishable from a gate that passes.
  // These two still own a `spawn(` call, so the scan must still find them — if
  // the rule stopped matching, this arm would pass with an empty list and the
  // scan above would be decoration.
  const inScope = scanTestSuite().filter((v) => v.inScope).map((v) => v.file.replace(`${REPO_ROOT}tests/`, ''));
  for (const expected of [
    // #1404: given its own `(code, signal) => …` handler, because it cannot use
    // the shared helper — it deliberately skips `initialize` and races a record
    // file the child writes to disk.
    'lazy-module-loading.test.ts',
    // The known-good control from the #1404 scan table.
    'branding-notice-guard.test.ts',
  ]) {
    assert.ok(inScope.includes(expected), `the scan must still find ${expected}; it found ${JSON.stringify(inScope)}`);
  }
});

test('the two routes out of the class are each represented, so neither is untested', () => {
  const inScope = scanTestSuite().filter((v) => v.inScope);
  // Route A: wire your own signal-naming listener. `lazy-module-loading.test.ts`.
  assert.ok(
    inScope.some((v) => v.exitListenerNamesSignal),
    'no in-scope file wires its own signal-naming exit listener, so that route is untested against the real tree',
  );
  // Route B: delegate. A delegating file is out of scope because it has no
  // `spawn(` of its own, so the route is observable by the absence instead —
  // and the two files that took it are named here, which is what keeps the
  // migration from being silently reverted.
  const delegating = scanTestSuite()
    .filter((v) => v.usesSharedHelper && !v.inScope)
    .map((v) => v.file.replace(`${REPO_ROOT}tests/`, ''));
  for (const expected of ['wire-registry.ts', 'exhaust2_enggating.test.ts']) {
    assert.ok(delegating.includes(expected), `${expected} must delegate to the shared helper; delegating files: ${JSON.stringify(delegating)}`);
  }
});

test('the shared helper itself satisfies the rule it delegates to', () => {
  // This is what makes delegation safe rather than merely asserted. If the
  // helper's own exit handler stopped naming the signal, every file that
  // delegates would inherit a silent harness and this scan would still be green
  // — because delegating files are out of scope by construction.
  const helper = scanTestSuite().find((v) => v.file.endsWith('helpers/stdio-child.ts'));
  assert.ok(helper, 'the shared helper must be inside the scanned tree');
  assert.equal(helper.inScope, true, 'the helper calls spawn() and speaks JSON-RPC, so the rule applies to it');
  assert.equal(helper.exitListenerNamesSignal, true, 'the helper must register an exit listener that names the signal');
});

// ---------------------------------------------------------------------------
// 3. The consequence, made observable.
//
// Everything above is a statement about source text. This drives a real child
// to a real signal death and asserts the harness names the signal — the string
// the #1405 code would have printed was `exited with code null`.
// ---------------------------------------------------------------------------

/**
 * A child that accepts a JSON-RPC request and is then SIGKILLed from outside.
 *
 * `killFromOutside` is the point: the parent does not decide to kill it, so
 * nothing the child can report on its own way reaches the harness. This is the
 * OOM-killer shape, and the only evidence is the signal.
 */
const SUICIDE_AFTER_ACK = `
const write = (o) => process.stdout.write(JSON.stringify(o) + '\\n');
write({ jsonrpc: '2.0', id: 1, result: { instructions: 'up' } });
setInterval(() => {}, 1000); // stay alive until something kills us
`;

test('a signal-killed child is reported as killed by that signal, not as a timeout (#1404/#1405)', async () => {
  const home = mkdtempSync(join(tmpdir(), 'child-exit-proof-'));
  const entry = join(home, 'suicide.mjs');
  writeFileSync(entry, SUICIDE_AFTER_ACK);

  const child = StdioJsonRpcChild.spawn({
    label: 'signal-proof',
    command: process.execPath,
    args: [entry],
    cwd: home,
    // Minimal, so nothing in the developer's shell can reach the child.
    env: { PATH: process.env.PATH ?? '' },
    requestTimeoutMs: 20_000,
  });

  try {
    // A health check, so the child is *proven* alive and answering before it
    // dies. Without this the test could pass on a child that never started.
    const init = await child.request('initialize');
    assert.equal(init.error, undefined, 'the fixture child must answer before it is killed');

    // Now the request that will never be answered, plus the kill.
    const inFlight = child.request('tools/list', {}, 20_000);
    // Give the write a tick to reach the pipe before the process disappears.
    await new Promise((r) => setTimeout(r, 50));
    assert.ok(child.isRunning(), 'the fixture child must still be running when it is killed');

    // Scoped to the PID this session just spawned — never a pattern match, on a
    // box where other agents run their own suites.
    const pid = child.pid;
    assert.ok(typeof pid === 'number', 'a spawned child has a pid');
    process.kill(pid, 'SIGKILL');

    const failure = await inFlight.then(
      () => assert.fail('a killed child must not resolve its in-flight request'),
      (err: Error) => err,
    );
    const message = failure.message;

    // The three assertions that separate this from the pre-fix behaviour.
    assert.match(message, /SIGKILL/, 'the rejection must name the signal');
    assert.doesNotMatch(
      message,
      /code null/,
      'a signal-kill has no exit code, and printing one is the #1405 defect',
    );
    assert.doesNotMatch(
      message,
      /timed out after 20000ms/,
      'the watchdog must not be what settles a request whose child was killed',
    );
  } finally {
    // Unconditional: a failed assertion must not leave the child running, or it
    // holds this test file's event loop open and the run HANGS instead of
    // reporting a failure.
    await child.dispose();
  }
});

test('a child already dead rejects the NEXT request too, with the recorded cause', async () => {
  // The second door the pre-fix `ServerSession` did not cover: `failAll` settles
  // what is in flight *at the moment of death*, and a request issued afterwards
  // lands in a map with nothing left to reject it. That one is written to a
  // stdin nobody is reading and is reported a full watchdog later as a timeout.
  const home = mkdtempSync(join(tmpdir(), 'child-exit-late-'));
  const entry = join(home, 'suicide.mjs');
  writeFileSync(entry, SUICIDE_AFTER_ACK);

  const child = StdioJsonRpcChild.spawn({
    label: 'late-request',
    command: process.execPath,
    args: [entry],
    cwd: home,
    env: { PATH: process.env.PATH ?? '' },
    requestTimeoutMs: 20_000,
  });

  try {
    await child.request('initialize');
    const pid = child.pid;
    assert.ok(typeof pid === 'number');
    process.kill(pid, 'SIGKILL');
    // Reap it before the next request, so the exit listener has run.
    assert.equal(await child.waitForExit(5_000), true, 'the fixture child must actually die');

    await assert.rejects(
      child.request('tools/list'),
      (err: Error) => {
        assert.match(err.message, /already dead/, 'a late request must say the child was gone');
        assert.match(err.message, /SIGKILL/, 'and it must carry the cause, not a timeout');
        return true;
      },
    );
  } finally {
    await child.dispose();
  }
});
