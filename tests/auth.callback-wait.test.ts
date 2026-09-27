/**
 * Bounded callback wait + actionable start-up failure (#614).
 *
 * The browser flow's promise used to settle only on an incoming callback, so
 * an abandoned flow (tab closed, consent screen dismissed, redirect URI not
 * registered) held port 8888 forever and had to be killed. The next attempt
 * then died on a raw `listen EADDRINUSE ... :::8888` that never mentioned the
 * previous run, so the two failures — "your port is taken" and "you closed the
 * tab" — were indistinguishable from the operator's side.
 *
 * What these tests hold:
 *
 *  - the wait is bounded by a named constant, and `SPOTIFY_AUTH_TIMEOUT_MS`
 *    moves it (and only a sane value moves it);
 *  - expiry rejects with a message that names the redirect, the port and the
 *    bound, and explicitly does NOT blame the port;
 *  - a busy port rejects with a different message that names EADDRINUSE, the
 *    port, and the default redirect URI;
 *  - the bound is cleared on every settle, so a finished login does not leave a
 *    five-minute timer holding the process open;
 *  - `spotify-mcp auth` end to end exits non-zero on expiry instead of hanging.
 *
 * Two deliberate choices keep the suite honest and quick:
 *
 *  - **The clock is injected.** `waitForCallback` takes an `AuthTimer`; the
 *    fake below fires expiry synchronously. Nothing in this file sleeps for the
 *    bound, so the 5-minute default is provable in milliseconds.
 *  - **No fixed port.** Every listener here binds an OS-assigned loopback port
 *    resolved immediately beforehand (or a port a blocker already holds). Port
 *    8888 is never bound by a test, and no request ever leaves loopback.
 *
 * Assertions quote literal substrings of the emitted message rather than
 * calling the message builders: an assertion derived from the same source as
 * the code under it cannot fail when the code is wrong (AGENTS.md §6).
 *
 * Every case carries an explicit `timeout`, because the failure mode this file
 * exists to catch is a promise that never settles. Without a per-test deadline
 * that failure wedges the whole run instead of reporting one red test — which
 * is also exactly what it did to the CLI before the bound existed.
 */

import './helpers/hermetic.js';

import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

// Env MUST be set before importing src/auth.ts: TOKEN_FILE binds at load time.
const dataDir = mkdtempSync(path.join(tmpdir(), 'spotify-mcp-auth-wait-'));
process.env.SPOTIFY_MCP_TOKEN_FILE = path.join(dataDir, 'tokens.json');
process.env.SPOTIFY_CLIENT_ID = 'test-client-id';
delete process.env.SPOTIFY_AUTH_TIMEOUT_MS;

const {
  DEFAULT_AUTH_CALLBACK_TIMEOUT_MS,
  DEFAULT_REDIRECT_URI,
  resolveAuthCallbackTimeoutMs,
  waitForCallback,
} = await import('../src/auth.ts');
type AuthTimer = import('../src/auth.ts').AuthTimer;
type CallbackWaitOptions = import('../src/auth.ts').CallbackWaitOptions;

// ---------------------------------------------------------------------------
// Test doubles
// ---------------------------------------------------------------------------

interface FakeTimer {
  readonly timer: AuthTimer;
  /** True while a bound is armed — the leak this file exists to catch. */
  isArmed(): boolean;
  /** The bound last passed to `set`, in ms. */
  readonly lastDelay: number;
  /** Fire the bound as if it had elapsed. No-op when nothing is armed. */
  fire(): void;
}

function fakeTimer(): FakeTimer {
  let pending: (() => void) | undefined;
  let lastDelay = -1;
  return {
    timer: {
      set(fn, ms) {
        pending = fn;
        lastDelay = ms;
      },
      clear() {
        pending = undefined;
      },
    },
    isArmed: () => pending !== undefined,
    get lastDelay() {
      return lastDelay;
    },
    fire() {
      const fn = pending;
      pending = undefined;
      fn?.();
    },
  };
}

/** Bind port 0 on loopback, read what the OS assigned, release it. */
function freeLoopbackPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.on('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const addr = probe.address();
      const port = typeof addr === 'object' && addr !== null ? addr.port : 0;
      probe.close(() => {
        if (port === 0) reject(new Error('probe did not receive a port'));
        else resolve(port);
      });
    });
  });
}

const openServers: Server[] = [];

/** Close every server a test created, so nothing is left listening. */
async function closeAll(): Promise<void> {
  await Promise.all(
    openServers.splice(0).map(
      (s) =>
        new Promise<void>((resolve) => {
          s.close(() => resolve());
        }),
    ),
  );
}

/** A server that holds a port for the duration of the test. */
async function occupyLoopbackPort(): Promise<{ port: number; release: () => void }> {
  const blocker = createServer((_req, res) => {
    res.writeHead(200);
    res.end('held');
  });
  openServers.push(blocker);
  const port = await new Promise<number>((resolve, reject) => {
    blocker.on('error', reject);
    blocker.listen(0, '127.0.0.1', () => {
      const addr = blocker.address();
      resolve(typeof addr === 'object' && addr !== null ? addr.port : 0);
    });
  });
  return { port, release: () => openServers.splice(openServers.indexOf(blocker), 1) };
}

/** Base options for a wait that will never receive a callback. */
function baseOptions(port: number, timer: AuthTimer): CallbackWaitOptions {
  return {
    state: 'state-under-test',
    codeVerifier: 'verifier-under-test',
    clientId: 'test-client-id',
    redirectUri: `http://127.0.0.1:${port}/callback`,
    hosts: ['127.0.0.1'],
    port,
    timeoutMs: DEFAULT_AUTH_CALLBACK_TIMEOUT_MS,
    timer,
  };
}

/**
 * Attach handlers to the wait promise the moment it is created.
 *
 * Without this, a wait that rejects while the test is still driving the fake
 * timer is briefly unhandled, and node's runner reports that window as a
 * failure of whichever test happens to be running.
 */
type Outcome = { ok: true; value: unknown } | { ok: false; error: unknown };

function guard(promise: Promise<unknown>): Promise<Outcome> {
  return promise.then(
    (value) => ({ ok: true as const, value }),
    (error: unknown) => ({ ok: false as const, error }),
  );
}

/** The settled rejection message, or a throw if the wait resolved instead. */
async function rejectionMessage(outcome: Promise<Outcome>): Promise<string> {
  const settled = await outcome;
  if (settled.ok) {
    assert.fail('wait resolved; expected a rejection');
  }
  return settled.error instanceof Error ? settled.error.message : String(settled.error);
}

/** Await a guard that must have resolved. */
async function resolvedValue(outcome: Promise<Outcome>): Promise<unknown> {
  const settled = await outcome;
  if (!settled.ok) {
    assert.fail(`wait rejected; expected it to resolve: ${String(settled.error)}`);
  }
  return settled.value;
}

afterEach(async () => {
  await closeAll();
});

/**
 * Run `spotify-mcp auth` to completion and report how it ended.
 *
 * The assertions live in the test body rather than in an execFile callback: a
 * throw inside that callback is swallowed by the event loop and the run stays
 * green, which is the "test that cannot fail" shape AGENTS.md §6 calls out.
 * The hard `timeout` is the backstop for the bug itself — before the bound
 * existed this child never exited and the test hung instead of failing.
 */
function runAuthCli(
  port: number,
  tokenDir: string,
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    execFile(
      process.execPath,
      ['--import', 'tsx', 'src/index.ts', 'auth'],
      {
        cwd: ROOT,
        timeout: 30_000,
        killSignal: 'SIGKILL',
        env: {
          PATH: '',
          SPOTIFY_CLIENT_ID: 'test-client-id',
          SPOTIFY_MCP_TOKEN_FILE: path.join(tokenDir, 'tokens.json'),
          SPOTIFY_REDIRECT_URI: `http://127.0.0.1:${port}/callback`,
          SPOTIFY_AUTH_TIMEOUT_MS: '400',
        },
      },
      (err, stdout, stderr) => {
        const code = (err as (NodeJS.ErrnoException & { code?: number }) | null)?.code ?? null;
        resolve({ code, stdout, stderr });
      },
    );
  });
}

// ---------------------------------------------------------------------------

describe('callback wait bound (#614)', () => {
  it('has a finite named default rather than an unbounded wait', { timeout: 10_000 }, () => {
    assert.equal(
      DEFAULT_AUTH_CALLBACK_TIMEOUT_MS,
      300_000,
      'the default wait bound changed; the comment on the constant explains the trade-off',
    );
    assert.ok(
      Number.isFinite(DEFAULT_AUTH_CALLBACK_TIMEOUT_MS) && DEFAULT_AUTH_CALLBACK_TIMEOUT_MS > 0,
      'the wait bound must be a positive finite number, not Infinity',
    );
  });

  it('arms the bound at the configured value, so the wait cannot outlive it', { timeout: 10_000 }, async () => {
    const clock = fakeTimer();
    const port = await freeLoopbackPort();
    const outcome = guard(waitForCallback({ ...baseOptions(port, clock.timer), timeoutMs: 1234 }));
    await new Promise((r) => setImmediate(r));

    assert.equal(clock.lastDelay, 1234, 'the timer was not armed with the configured bound');
    assert.equal(clock.isArmed(), true, 'no bound was armed before the wait');

    clock.fire();
    await rejectionMessage(outcome);
  });

  it('times out with a message naming the redirect, the port and the bound', { timeout: 10_000 }, async () => {
    const clock = fakeTimer();
    const port = await freeLoopbackPort();
    const outcome = guard(waitForCallback({ ...baseOptions(port, clock.timer), timeoutMs: 4242 }));
    await new Promise((r) => setImmediate(r));

    clock.fire();
    const message = await rejectionMessage(outcome);

    assert.ok(
      message.includes(`http://127.0.0.1:${port}/callback`),
      `timeout message does not name the redirect URI the operator must match:\n${message}`,
    );
    assert.ok(
      message.includes(String(port)),
      `timeout message does not name the port that was released:\n${message}`,
    );
    assert.ok(
      message.includes('4242'),
      `timeout message does not report the bound that elapsed:\n${message}`,
    );
    assert.ok(
      /not a port conflict/i.test(message),
      `timeout message must rule out a port conflict, since the listener did bind:\n${message}`,
    );
  });

  it('closes the listener and disarms the bound on expiry', { timeout: 10_000 }, async () => {
    const clock = fakeTimer();
    const port = await freeLoopbackPort();
    let listening: boolean | undefined;
    const outcome = guard(
      waitForCallback({
        ...baseOptions(port, clock.timer),
        onListening: () => {
          listening = true;
        },
      }),
    );
    await new Promise((r) => setImmediate(r));
    assert.equal(listening, true, 'the listener never came up, so expiry was never exercised');

    clock.fire();
    await rejectionMessage(outcome);

    assert.equal(
      clock.isArmed(),
      false,
      'the bound stayed armed after expiry; it would hold the process open',
    );
    // The port must be free again, otherwise the next run still fails to bind.
    await new Promise<void>((resolve, reject) => {
      const probe = createServer();
      probe.on('error', (err: NodeJS.ErrnoException) =>
        reject(
          err.code === 'EADDRINUSE'
            ? new Error(`port ${port} was still held after the wait expired`)
            : err,
        ),
      );
      probe.listen(port, '127.0.0.1', () => probe.close(() => resolve()));
    });
  });

  it('does not emit the port-busy message when the callback simply never came', { timeout: 10_000 }, async () => {
    const clock = fakeTimer();
    const port = await freeLoopbackPort();
    const outcome = guard(waitForCallback(baseOptions(port, clock.timer)));
    await new Promise((r) => setImmediate(r));

    clock.fire();
    const message = await rejectionMessage(outcome);

    assert.equal(
      message.includes('EADDRINUSE'),
      false,
      `an expired wait must not claim the port was taken; it bound successfully:\n${message}`,
    );
  });

  it('clears the bound when the browser reports an error instead of a code', { timeout: 10_000 }, async () => {
    const clock = fakeTimer();
    const port = await freeLoopbackPort();
    const outcome = guard(waitForCallback(baseOptions(port, clock.timer)));
    await new Promise((r) => setImmediate(r));

    const redirect = new URL(`http://127.0.0.1:${port}/callback`);
    redirect.searchParams.set('state', 'state-under-test');
    redirect.searchParams.set('error', 'access_denied');
    await fetch(redirect);

    const message = await rejectionMessage(outcome);
    assert.ok(
      message.includes('access_denied'),
      `the provider error was not surfaced:\n${message}`,
    );
    assert.equal(
      clock.isArmed(),
      false,
      'the bound stayed armed after a request-driven rejection',
    );
  });

  it('clears the bound on a successful login, so it cannot hold the process open', { timeout: 10_000 }, async () => {
    const clock = fakeTimer();
    const port = await freeLoopbackPort();
    const realFetch = globalThis.fetch;
    // Loopback callback only — no request leaves the machine.
    globalThis.fetch = (async (url: unknown, init?: RequestInit) => {
      const target = String(url);
      if (target.startsWith('http://127.0.0.1')) {
        return realFetch(target, init);
      }
      if (target.startsWith('https://accounts.spotify.com/api/token')) {
        return new Response(
          JSON.stringify({
            access_token: 'access-under-test',
            refresh_token: 'refresh-under-test',
            expires_in: 3600,
            scope: 'user-read-private',
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      }
      throw new Error(`unexpected network call in a unit test: ${target}`);
    });

    try {
      const outcome = guard(waitForCallback(baseOptions(port, clock.timer)));
      await new Promise((r) => setImmediate(r));

      const redirect = new URL(`http://127.0.0.1:${port}/callback`);
      redirect.searchParams.set('state', 'state-under-test');
      redirect.searchParams.set('code', 'code-under-test');
      await realFetch(redirect);

      const tokens = (await resolvedValue(outcome)) as { access_token: string };
      assert.equal(tokens.access_token, 'access-under-test');
      assert.equal(
        clock.isArmed(),
        false,
        'the bound stayed armed after a successful login; the CLI would hang for the rest of it',
      );
    } finally {
      globalThis.fetch = realFetch;
    }
  });
});

describe('callback listener start-up failure (#614)', () => {
  it('names EADDRINUSE, the port and the default redirect when the port is taken', { timeout: 10_000 }, async () => {
    const held = await occupyLoopbackPort();
    const clock = fakeTimer();

    const message = await rejectionMessage(
      guard(waitForCallback(baseOptions(held.port, clock.timer))),
    );

    assert.ok(
      message.includes('EADDRINUSE'),
      `a busy port must be named as such:\n${message}`,
    );
    assert.ok(
      message.includes(String(held.port)),
      `the busy port must be named so the operator can look it up:\n${message}`,
    );
    assert.ok(
      message.includes(DEFAULT_REDIRECT_URI),
      `the message must name the default redirect URI the operator is expected to be using:\n${message}`,
    );
    assert.ok(
      message.includes('127.0.0.1') && message.includes('localhost'),
      `the message must keep the loopback host and the localhost distinction visible:\n${message}`,
    );
    assert.equal(
      clock.isArmed(),
      false,
      'the bound stayed armed after a failed bind; it would hold the process open',
    );
  });

  it('points at the previous auth run, not just at the port', { timeout: 10_000 }, async () => {
    const held = await occupyLoopbackPort();
    const message = await rejectionMessage(guard(waitForCallback(baseOptions(held.port, fakeTimer().timer))));

    assert.ok(
      message.includes('spotify-mcp auth'),
      `a busy port is usually a stale auth run and the message should say so:\n${message}`,
    );
    assert.ok(
      /not a port conflict|is already in use/i.test(message),
      `the message must state the port is taken, rather than leaving it implied:\n${message}`,
    );
  });

  it('does not emit the expired-wait message when the listener never bound', { timeout: 10_000 }, async () => {
    const held = await occupyLoopbackPort();
    const message = await rejectionMessage(guard(waitForCallback(baseOptions(held.port, fakeTimer().timer))));

    assert.equal(
      message.includes('not a port conflict'),
      false,
      `a failed bind is the opposite of a successful bind that timed out:\n${message}`,
    );
    assert.equal(
      message.includes('no callback request arrived'),
      false,
      `the failure was at bind time, so no callback was ever awaited:\n${message}`,
    );
  });
});

describe('SPOTIFY_AUTH_TIMEOUT_MS (#614)', () => {
  it('reads the bound from the environment', { timeout: 10_000 }, () => {
    assert.equal(resolveAuthCallbackTimeoutMs('1500'), 1500);
  });

  it('falls back to the default when unset, blank, non-numeric or non-positive', { timeout: 10_000 }, () => {
    for (const raw of [undefined, '', '   ', 'soon', '0', '-1', 'NaN', 'Infinity']) {
      assert.equal(
        resolveAuthCallbackTimeoutMs(raw),
        DEFAULT_AUTH_CALLBACK_TIMEOUT_MS,
        `a bad bound (${JSON.stringify(raw)}) must not disable the wait`,
      );
    }
  });

  it('is read by the auth CLI end to end, which exits non-zero instead of hanging', { timeout: 10_000 }, async () => {
    // Ephemeral loopback port, so the CLI never binds 8888 during the suite.
    const port = await freeLoopbackPort();
    const dataDirRun = mkdtempSync(path.join(tmpdir(), 'spotify-mcp-auth-cli-'));
    // PATH is emptied so the browser step cannot spawn an xdg-open on the test
    // host; the flow must fail that step into its own catch and carry on waiting.
    const { code, stdout, stderr } = await runAuthCli(port, dataDirRun);

    assert.equal(code, 1, `auth must exit 1 on an expired wait. stdout:\n${stdout}`);
    assert.ok(
      stderr.includes(`http://127.0.0.1:${port}/callback`),
      `the CLI did not report the redirect it was waiting on:\n${stderr}`,
    );
    assert.ok(
      stderr.includes('400'),
      `the CLI did not report the bound that elapsed:\n${stderr}`,
    );
  });
});
