/**
 * Unit tests for the opt-in HTTP transport's configuration and guards (#599).
 *
 * ## Why these are pure-function tests
 *
 * Every refusal in `src/http.ts` — no token, a short token, a non-loopback bind
 * with no second opt-in, an unknown transport name — happens before a socket
 * exists. That is deliberate: a listener that starts and then refuses is a
 * window in which something is listening. So `resolveHttpConfig` reads an env
 * object and throws, and these tests drive it directly rather than spawning a
 * process and reading its exit code. The spawned-process proofs that the
 * refusals actually stop a server from starting live in
 * `tests/http.security.test.ts`.
 *
 * ## The direction that matters most
 *
 * `resolveHttpConfig` returns the disabled config for an unset
 * `SPOTIFY_MCP_TRANSPORT` **without reading any other `SPOTIFY_MCP_HTTP_*`
 * variable** — not even to validate one. If it did, a stdio host carrying a
 * stale `SPOTIFY_MCP_HTTP_TOKEN` in its environment would fail to start over a
 * variable the transport never touches, and "opt-in" would stop meaning
 * opt-in. The first test below is the one that pins that.
 */
import './helpers/hermetic.js';

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';

import {
  DEFAULT_HTTP_BIND,
  DEFAULT_HTTP_MAX_BODY_BYTES,
  DEFAULT_HTTP_MAX_SESSIONS,
  DEFAULT_HTTP_PATH,
  DEFAULT_HTTP_PORT,
  DEFAULT_HTTP_RATE_LIMIT_PER_MINUTE,
  HttpConfigError,
  MIN_HTTP_TOKEN_LENGTH,
  RequestRateLimiter,
  extractBearerToken,
  isLoopbackHost,
  readBodyLimited,
  resolveHttpConfig,
  secretsMatch,
} from '../src/http.ts';

/** A token that clears the length and character rules. */
const GOOD_TOKEN = 'test-bearer-token-0123456789abcdef';

/** An env with the HTTP transport on, and nothing else set. */
function httpEnv(extra: Record<string, string | undefined> = {}): NodeJS.ProcessEnv {
  return { SPOTIFY_MCP_TRANSPORT: 'http', SPOTIFY_MCP_HTTP_TOKEN: GOOD_TOKEN, ...extra };
}

function tempTokenFile(contents: string, mode = 0o600): string {
  const dir = mkdtempSync(join(tmpdir(), 'x599-tok-'));
  const file = join(dir, 'http-token.txt');
  writeFileSync(file, contents, 'utf8');
  chmodSync(file, mode);
  return file;
}

describe('the transport is opt-in (default OFF) (#599)', () => {
  it('is disabled with no SPOTIFY_MCP_TRANSPORT at all', () => {
    assert.equal(resolveHttpConfig({}).enabled, false);
  });

  it('is disabled for an explicit stdio, case- and whitespace-insensitively', () => {
    for (const value of ['stdio', 'STDIO', '  stdio  ']) {
      assert.equal(resolveHttpConfig({ SPOTIFY_MCP_TRANSPORT: value }).enabled, false, value);
    }
  });

  it('reads NO other HTTP variable while disabled', () => {
    // The point of the assertion is the THROW, not the return value: if the
    // stdio branch validated any of these, a stdio host with a stale HTTP token
    // in its environment would refuse to start over a variable the transport
    // never touches. Every one of these is a refusal on the http path.
    const config = resolveHttpConfig({
      SPOTIFY_MCP_TRANSPORT: 'stdio',
      SPOTIFY_MCP_HTTP_TOKEN: 'short',
      SPOTIFY_MCP_HTTP_TOKEN_FILE: '/nonexistent/path/that/would/throw',
      SPOTIFY_MCP_HTTP_BIND: '0.0.0.0',
      SPOTIFY_MCP_HTTP_PORT: 'not-a-number',
      SPOTIFY_MCP_HTTP_PATH: 'no-leading-slash',
      SPOTIFY_MCP_HTTP_RATE_LIMIT: '-5',
    });
    assert.equal(config.enabled, false);
    assert.equal(config.token, '', 'a disabled config must not carry a credential');
  });

  it('refuses an unknown transport name instead of falling back to stdio', () => {
    // Falling back would hand a host that asked for HTTP a stdio process that
    // looks healthy, and the symptom would be a client retrying forever.
    assert.throws(
      () => resolveHttpConfig({ SPOTIFY_MCP_TRANSPORT: 'https' }),
      (error: unknown) => error instanceof HttpConfigError
        && /Unknown SPOTIFY_MCP_TRANSPORT/.test((error as Error).message)
        && /stdio/.test((error as Error).message)
        && /http/.test((error as Error).message),
    );
  });

  it('reports its defaults, so the resolved config is checkable', () => {
    const config = resolveHttpConfig(httpEnv());
    assert.equal(config.bind, DEFAULT_HTTP_BIND);
    assert.equal(config.bind, '127.0.0.1');
    assert.equal(config.port, DEFAULT_HTTP_PORT);
    assert.equal(config.path, DEFAULT_HTTP_PATH);
    assert.equal(config.maxBodyBytes, DEFAULT_HTTP_MAX_BODY_BYTES);
    assert.equal(config.rateLimitPerMinute, DEFAULT_HTTP_RATE_LIMIT_PER_MINUTE);
    assert.equal(config.maxSessions, DEFAULT_HTTP_MAX_SESSIONS);
    assert.equal(config.nonLoopbackAllowed, false);
    assert.equal(config.token, GOOD_TOKEN);
  });
});

describe('the listener cannot start unauthenticated (#599)', () => {
  it('refuses with no token at all, and names both ways to set one', () => {
    assert.throws(
      () => resolveHttpConfig({ SPOTIFY_MCP_TRANSPORT: 'http' }),
      (error: unknown) => error instanceof HttpConfigError
        && /SPOTIFY_MCP_HTTP_TOKEN/.test((error as Error).message)
        && /SPOTIFY_MCP_HTTP_TOKEN_FILE/.test((error as Error).message)
        && /no default and no anonymous mode/.test((error as Error).message),
    );
  });

  it('refuses a token shorter than the minimum', () => {
    assert.throws(
      () => resolveHttpConfig(httpEnv({ SPOTIFY_MCP_HTTP_TOKEN: 'x'.repeat(MIN_HTTP_TOKEN_LENGTH - 1) })),
      (error: unknown) => error instanceof HttpConfigError
        && /at least 16 are required/.test((error as Error).message),
    );
  });

  it('accepts a token of exactly the minimum length', () => {
    const token = 'y'.repeat(MIN_HTTP_TOKEN_LENGTH);
    assert.equal(resolveHttpConfig(httpEnv({ SPOTIFY_MCP_HTTP_TOKEN: token })).token, token);
  });

  it('refuses a token a header could not carry', () => {
    // A space cannot appear in the credential of an Authorization header, and
    // CR/LF is request splitting. Both are startup errors, not a 401 waiting to
    // happen on the first connection.
    for (const bad of ['has space here', 'has\nnewline', 'has\rcr', 'has\ttab']) {
      assert.throws(
        () => resolveHttpConfig(httpEnv({ SPOTIFY_MCP_HTTP_TOKEN: bad })),
        HttpConfigError,
        `expected a refusal for ${JSON.stringify(bad)}`,
      );
    }
  });

  it('refuses both token sources at once rather than silently picking one', () => {
    assert.throws(
      () => resolveHttpConfig({
        SPOTIFY_MCP_TRANSPORT: 'http',
        SPOTIFY_MCP_HTTP_TOKEN: GOOD_TOKEN,
        SPOTIFY_MCP_HTTP_TOKEN_FILE: tempTokenFile(GOOD_TOKEN),
      }),
      (error: unknown) => error instanceof HttpConfigError && /not both/.test((error as Error).message),
    );
  });

  it('reads a token from a file, trimming exactly one trailing newline', () => {
    const file = tempTokenFile(`${GOOD_TOKEN}\n`);
    const config = resolveHttpConfig({
      SPOTIFY_MCP_TRANSPORT: 'http',
      SPOTIFY_MCP_HTTP_TOKEN_FILE: file,
    });
    assert.equal(config.token, GOOD_TOKEN, 'the newline is a line ending, not part of the secret');
  });

  it('refuses an unreadable token file, naming the variable and the path', () => {
    // A read failure is a startup error, not a warning, and the message has to
    // be actionable — so it names SPOTIFY_MCP_HTTP_TOKEN_FILE and the path. What
    // it must never contain is a secret, and there is none to contain: nothing
    // on this path ever holds one.
    const dir = mkdtempSync(join(tmpdir(), 'x599-tokdir-'));
    for (const path of [dir, join(dir, 'does-not-exist.txt')]) {
      assert.throws(
        () => resolveHttpConfig({ SPOTIFY_MCP_TRANSPORT: 'http', SPOTIFY_MCP_HTTP_TOKEN_FILE: path }),
        (error: unknown) => error instanceof HttpConfigError
          && /SPOTIFY_MCP_HTTP_TOKEN_FILE could not be read/.test((error as Error).message)
          && (error as Error).message.includes(path),
        `expected a refusal for ${path}`,
      );
    }
  });
});

describe('the listener is loopback unless a second opt-in says otherwise (#599)', () => {
  it('treats the whole of 127.0.0.0/8, localhost and ::1 as loopback', () => {
    for (const host of ['127.0.0.1', '127.0.0.2', '127.1.2.3', 'localhost', 'LOCALHOST', '::1', '[::1]', '0:0:0:0:0:0:0:1']) {
      assert.equal(isLoopbackHost(host), true, host);
    }
  });

  it('treats the unspecified addresses and everything else as NOT loopback', () => {
    // 0.0.0.0 and :: are what a listener binds when asked to accept every
    // interface, so calling them "loopback" because they are "local" would
    // defeat the only check standing between a typo and an exposed server.
    for (const host of ['0.0.0.0', '::', '[::]', '192.168.1.10', '10.0.0.1', 'example.com', '127.0.0.1.evil.com', '', '  ']) {
      assert.equal(isLoopbackHost(host), false, JSON.stringify(host));
    }
  });

  it('refuses a non-loopback bind without the second opt-in', () => {
    assert.throws(
      () => resolveHttpConfig(httpEnv({ SPOTIFY_MCP_HTTP_BIND: '0.0.0.0' })),
      (error: unknown) => error instanceof HttpConfigError
        && /not a loopback address/.test((error as Error).message)
        && /SPOTIFY_MCP_HTTP_ALLOW_NON_LOOPBACK/.test((error as Error).message),
    );
  });

  it('accepts a non-loopback bind only once BOTH settings are present', () => {
    const config = resolveHttpConfig(httpEnv({
      SPOTIFY_MCP_HTTP_BIND: '0.0.0.0',
      SPOTIFY_MCP_HTTP_ALLOW_NON_LOOPBACK: '1',
    }));
    assert.equal(config.enabled, true);
    assert.equal(config.nonLoopbackAllowed, true);
  });

  it('does not treat a non-loopback ALLOW as permission to bind loopback by accident', () => {
    // The reverse direction is the one a copy-paste produces: the opt-in set,
    // the bind left at its default. That must still be a loopback bind.
    const config = resolveHttpConfig(httpEnv({ SPOTIFY_MCP_HTTP_ALLOW_NON_LOOPBACK: 'yes' }));
    assert.equal(config.bind, '127.0.0.1');
    assert.equal(config.nonLoopbackAllowed, true);
  });
});

describe('the knob surface refuses nonsense rather than falling back (#599)', () => {
  it('rejects a non-integer or out-of-range port', () => {
    for (const port of ['not-a-number', '-1', '70000', '80.5']) {
      assert.throws(
        () => resolveHttpConfig(httpEnv({ SPOTIFY_MCP_HTTP_PORT: port })),
        (error: unknown) => error instanceof HttpConfigError && /SPOTIFY_MCP_HTTP_PORT/.test((error as Error).message),
        `expected a refusal for port ${port}`,
      );
    }
  });

  it('accepts port 0 so a caller can take a kernel-assigned port', () => {
    assert.equal(resolveHttpConfig(httpEnv({ SPOTIFY_MCP_HTTP_PORT: '0' })).port, 0);
  });

  it('rejects a body ceiling, rate limit or session cap outside its range', () => {
    assert.throws(() => resolveHttpConfig(httpEnv({ SPOTIFY_MCP_HTTP_MAX_BODY_BYTES: '10' })), HttpConfigError);
    assert.throws(() => resolveHttpConfig(httpEnv({ SPOTIFY_MCP_HTTP_RATE_LIMIT: '0' })), HttpConfigError);
    assert.throws(() => resolveHttpConfig(httpEnv({ SPOTIFY_MCP_HTTP_MAX_SESSIONS: '0' })), HttpConfigError);
  });

  it('rejects a path that is not absolute', () => {
    assert.throws(
      () => resolveHttpConfig(httpEnv({ SPOTIFY_MCP_HTTP_PATH: 'mcp' })),
      (error: unknown) => error instanceof HttpConfigError && /must start with/.test((error as Error).message),
    );
  });
});

describe('the credential comparison (#599)', () => {
  it('accepts the scheme case-insensitively, as RFC 7235 requires', () => {
    for (const header of [`Bearer ${GOOD_TOKEN}`, `bearer ${GOOD_TOKEN}`, `BEARER ${GOOD_TOKEN}`]) {
      assert.equal(extractBearerToken(header), GOOD_TOKEN, header);
    }
  });

  it('returns null for a missing, empty or non-bearer credential', () => {
    for (const header of [undefined, '', 'Bearer', 'Bearer   ', 'Basic abcdef', GOOD_TOKEN, `Token ${GOOD_TOKEN}`]) {
      assert.equal(extractBearerToken(header), null, JSON.stringify(header));
    }
  });

  it('does not treat a duplicated Authorization header as a way in', () => {
    // Node surfaces repeated headers as an array for some fields. Taking the
    // first element is a decision; letting the shape decide is a bypass.
    assert.equal(extractBearerToken([`Bearer ${GOOD_TOKEN}`]), GOOD_TOKEN);
    assert.equal(extractBearerToken([`Bearer wrong`, `Bearer ${GOOD_TOKEN}`]), 'wrong');
  });

  it('matches only the exact secret', () => {
    assert.equal(secretsMatch(GOOD_TOKEN, GOOD_TOKEN), true);
    assert.equal(secretsMatch(`${GOOD_TOKEN}x`, GOOD_TOKEN), false);
    assert.equal(secretsMatch(GOOD_TOKEN.slice(0, -1), GOOD_TOKEN), false);
    assert.equal(secretsMatch('', GOOD_TOKEN), false);
  });

  it('compares without throwing on a length mismatch', () => {
    // `timingSafeEqual` refuses unequal lengths. A guard that threw on a short
    // guess would turn "wrong token" into a 500, which is both a fingerprint
    // and a free oracle.
    assert.equal(secretsMatch('a', GOOD_TOKEN.repeat(40)), false);
  });
});

describe('the request rate limiter (#599)', () => {
  it('refuses once the budget is spent and recovers as it refills', () => {
    let now = 0;
    const limiter = new RequestRateLimiter(60, { now: () => now, capacity: 2 });
    assert.equal(limiter.tryConsume('a'), true);
    assert.equal(limiter.tryConsume('a'), true);
    assert.equal(limiter.tryConsume('a'), false, 'the third request exhausts the budget');
    now += 1_000; // 60/min is one per second, so this is a full refill.
    assert.equal(limiter.tryConsume('a'), true);
  });

  it('budgets each client address separately', () => {
    let now = 0;
    const limiter = new RequestRateLimiter(60, { now: () => now, capacity: 1 });
    assert.equal(limiter.tryConsume('a'), true);
    assert.equal(limiter.tryConsume('a'), false);
    assert.equal(limiter.tryConsume('b'), true, 'one client exhausting its budget is not another client’s problem');
  });

  it('caps the number of tracked addresses rather than growing without bound', () => {
    // A per-key map is itself a memory-exhaustion vector: fresh source
    // addresses would grow it until the process dies. Past the cap an unseen
    // key is charged to a SHARED bucket, so flooding costs the flooder.
    let now = 0;
    const limiter = new RequestRateLimiter(60, { now: () => now, capacity: 1 });
    for (let i = 0; i < 5_000; i += 1) limiter.tryConsume(`addr-${i}`);
    assert.ok(limiter.trackedKeys <= 4_096, `tracked ${limiter.trackedKeys} keys`);
    assert.equal(limiter.tryConsume('never-seen-before'), false, 'the overflow bucket is spent by the flood');
  });
});

describe('the request body ceiling (#599)', () => {
  /** A real IncomingMessage is awkward to synthesise; a readable stream is not. */
  function requestOf(chunks: string[], headers: Record<string, string> = {}): import('node:http').IncomingMessage {
    const stream = Readable.from(chunks.map((c) => Buffer.from(c, 'utf8'))) as unknown as import('node:http').IncomingMessage;
    stream.headers = headers;
    return stream;
  }

  it('accepts a body under the ceiling', async () => {
    const result = await readBodyLimited(requestOf(['{"jsonrpc"']), 1_024);
    assert.equal(result.ok, true);
    assert.equal(result.ok && result.raw, '{"jsonrpc"');
  });

  it('refuses on content-length before reading a byte', async () => {
    const result = await readBodyLimited(requestOf([], { 'content-length': '999999' }), 1_024);
    assert.equal(result.ok, false);
    assert.equal(!result.ok && result.status, 413);
  });

  it('refuses a body that under-declares and keeps streaming', async () => {
    // content-length is a claim. A slow-loris that never sends one is only
    // stopped by counting the stream, which is what this asserts.
    const chunks = ['x'.repeat(600), 'y'.repeat(600)];
    const result = await readBodyLimited(requestOf(chunks, { 'content-length': '10' }), 1_024);
    assert.equal(result.ok, false);
    assert.equal(!result.ok && result.status, 413);
  });

  it('joins multi-chunk bodies back into the original bytes', async () => {
    const result = await readBodyLimited(requestOf(['{"a"', ':1}']), 1_024);
    assert.equal(result.ok && result.raw, '{"a":1}');
  });
});
