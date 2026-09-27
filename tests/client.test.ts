/**
 * Tests for src/client.ts (SpotifyClient, SpotifyApiError) and the tokenPath
 * contract from src/auth.ts.
 *
 * Covers:
 *   - Token injection: Bearer header sourced from the token file
 *     (SPOTIFY_MCP_TOKEN_FILE points at a temp fixture).
 *   - Pre-request refresh: expired expires_at triggers a refresh POST to
 *     accounts.spotify.com before the API call; refreshed tokens persisted.
 *   - 401 mid-flight: single 401 -> refresh -> retry succeeds once; double
 *     401 surfaces SpotifyApiError.
 *   - 429: Retry-After honoured (value '1') under mock timers, retried once.
 *   - Error mapping: structured {error:{message}} bodies win; missing bodies
 *     fall back to per-status generic messages (403/404/503).
 *   - 204 No Content on GET returns null (never parses empty JSON).
 *   - The read cache (#660): a repeated read costs one fetch, a mutation drops
 *     the reads it could have changed, a volatile path never caches, and
 *     `disableCache` turns the whole thing off. Each asserts an EXACT fetch
 *     count — a hit, a miss and a bypass are indistinguishable in a body that
 *     merely came back the same.
 *   - Unreadable mutation bodies (#674): a 2xx write whose body will not parse
 *     resolves to null, never throws a raw SyntaxError, still invalidates the
 *     read cache and still lands in the history ledger; a rejected write
 *     invalidates nothing; an unreadable READ body still errors.
 *   - getAllPages: full walk, explicit maxItems cap, configured fetch-all
 *     cap (SPOTIFY_MCP_FETCH_ALL_CAP via initConfig), malformed-page break,
 *     per-page progress events (#65).
 *   - Queue serialization: overlapping calls dispatch sequentially.
 *
 * Run with: node --import tsx --test tests/client.test.ts
 *
 * NOTE: the token path is resolved per CALL by getTokenFilePath(), so env
 * env vars MUST be set before the dynamic import below. Tokens are only ever
 * written under os.tmpdir().
 */

import './helpers/hermetic.js';

import { describe, it, before, after, beforeEach, afterEach, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

// ---------------------------------------------------------------------------
// Env setup MUST precede anything that reads a token (getTokenFilePath()
// resolves per call, so ordering no longer matters for the BINDING — only for
// the value read).
// ---------------------------------------------------------------------------

const tokenDir = await mkdtemp(path.join(tmpdir(), 'spotify-mcp-client-test-'));
process.env.SPOTIFY_MCP_TOKEN_FILE = path.join(tokenDir, 'tokens.json');
process.env.SPOTIFY_CLIENT_ID = 'test-client-id';

/**
 * One progress event as a test records it. Declared at module scope, not
 * inside the `getAllPages progress reporting` describe: the sibling
 * `getAllPages per-call onPage hook (#902)` block annotates its own arrays
 * with it, and from inside that sibling the interface was simply not in scope.
 * tsx strips types, so the annotation vanished at runtime and the array was
 * left untyped rather than wrong — nothing failed until `tests/` was
 * typechecked (#1408).
 */
interface RecordedProgress {
  walkId: number;
  page: number;
  fetched: number;
  total?: number;
}

const { SpotifyClient, SpotifyApiError, selectNextLaneTask, parseRetryAfter } = await import('../src/client.ts');
const { getTokenFilePath } = await import('../src/auth.ts');
const tokenPath = getTokenFilePath();
const { initConfig } = await import('../src/config.ts');

// Guard the isolation contract: if tokenPath ever resolved outside tmpdir
// (e.g. a static import racing ahead of the env var), fail loudly instead of
// touching ~/.spotify-mcp/tokens.json.
describe('tokenPath contract', () => {
  it('resolves inside os.tmpdir(), never the real ~/.spotify-mcp home', () => {
    assert.ok(
      tokenPath.startsWith(tmpdir()),
      `tokenPath must live under ${tmpdir()}, got: ${tokenPath}`,
    );
    assert.ok(!tokenPath.includes('.spotify-mcp'), 'must not target the default token path');
  });
});


// ---------------------------------------------------------------------------
// Retry-After parsing (RFC 9110 §10.2.3) — pure, no clock, no network
// ---------------------------------------------------------------------------

describe('parseRetryAfter', () => {
  // A fixed `now` so every HTTP-date expectation is exact.
  const now = Date.parse('Sun, 06 Nov 1994 08:49:37 GMT');

  it('reads delta-seconds', () => {
    assert.equal(parseRetryAfter('5', now), 5);
    assert.equal(parseRetryAfter('0', now), 0);
    assert.equal(parseRetryAfter('  45  ', now), 45, 'tolerates surrounding whitespace');
  });

  it('reads a fractional delta instead of truncating it to zero', () => {
    // parseInt('0.5') is 0 — a header asking for half a second would have
    // become a zero-length wait.
    assert.equal(parseRetryAfter('0.5', now), 0.5);
  });

  it('reads an IMF-fixdate Retry-After as seconds from now', () => {
    assert.equal(parseRetryAfter('Sun, 06 Nov 1994 08:50:07 GMT', now), 30);
  });

  it('reads the RFC 850 and asctime HTTP-date forms too', () => {
    assert.equal(parseRetryAfter('Sunday, 06-Nov-94 08:50:07 GMT', now), 30);
    assert.equal(parseRetryAfter('Sun Nov  6 08:50:07 1994', now), 30);
  });

  it('treats a past HTTP-date as retry-now, not a backwards wait', () => {
    assert.equal(parseRetryAfter('Sun, 06 Nov 1994 08:49:07 GMT', now), 0);
  });

  it('falls back to 1s for an absent or unparsable header', () => {
    assert.equal(parseRetryAfter(null, now), 1);
    assert.equal(parseRetryAfter('', now), 1);
    assert.equal(parseRetryAfter('   ', now), 1);
    assert.equal(parseRetryAfter('soon', now), 1);
    assert.equal(parseRetryAfter('12:30', now), 1);
  });

  it('falls back to 1s for a negative or signed number, which is not an HTTP-date', () => {
    // Date.parse('-5') is a real date in 2001, so without a guard this would
    // quietly become a 0s wait — an immediate retry in exactly the situation
    // the backoff exists to prevent.
    assert.equal(parseRetryAfter('-5', now), 1);
    assert.equal(parseRetryAfter('+5', now), 1);
  });

  it('never returns NaN, so it cannot poison a sleep or a cooldown deadline', () => {
    for (const header of [null, '', ' ', 'soon', '-5', 'NaN', '1e9', '0x10', 'Sun, 99 Xxx 9999']) {
      const value = parseRetryAfter(header, now);
      assert.ok(
        Number.isFinite(value) && value >= 0,
        `parseRetryAfter(${JSON.stringify(header)}) must be a finite non-negative number, got ${value}`,
      );
    }
  });
});

// ---------------------------------------------------------------------------
// Fetch stub harness
// ---------------------------------------------------------------------------

interface FetchCall {
  url: string;
  init: RequestInit;
}

let calls: FetchCall[] = [];
let responder: (url: string, init: RequestInit) => Response | Promise<Response>;

const realFetch = globalThis.fetch;

function jsonResponse(body: unknown, status = 200, headers?: Record<string, string>): Response {
  return new Response(JSON.stringify(body), { status, headers });
}

function apiUrl(pathname: string): string {
  return `https://api.spotify.com/v1${pathname}`;
}

function isAccountsUrl(url: string): boolean {
  return url.startsWith('https://accounts.spotify.com/');
}

function apiCalls(): FetchCall[] {
  return calls.filter((c) => !isAccountsUrl(c.url));
}

function authHeaderOf(call: FetchCall): string {
  return (call.init.headers as Record<string, string>).Authorization;
}

/** Yield to the event loop so pending promise chains can schedule work. */
function nextTick(): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
  setImmediate(resolve);
  return promise;
}

/**
 * Drain the event loop until `check()` turns true, with a generous guard
 * against a permanently-stalled chain. Pure draining: no mocked-clock
 * movement, so it can never accidentally fire a pending backoff sleep.
 */
async function waitFor(check: () => boolean): Promise<void> {
  let guard = 0;
  while (!check() && guard++ < 10_000) {
    await nextTick();
  }
}

/**
 * Wrap the current globalThis.setTimeout with a pass-through recorder so a
 * test observes exactly when the client schedules its backoff sleep (and with
 * which delay) instead of guessing with fixed-size clock ticks. Must be
 * installed AFTER mock timers are enabled; restore() before the test ends.
 */
function spyOnSetTimeout(): { delays: number[]; restore: () => void } {
  const inner = globalThis.setTimeout;
  const delays: number[] = [];
  globalThis.setTimeout = ((fn: (...args: never[]) => void, ms?: number, ...rest: unknown[]) => {
    delays.push(ms ?? 0);
    return inner(fn as never, ms ?? 0, ...(rest as []));
  }) as unknown as typeof setTimeout;
  return {
    delays,
    restore: () => {
      globalThis.setTimeout = inner;
    },
  };
}

/**
 * Release `count` pending backoff sleeps against the mocked clock, draining
 * the event loop before and after each tick so the client's promise chain can
 * schedule the next one. Every wait is virtual: a test never spends real time
 * on a backoff. Asserts that each expected sleep was actually scheduled, so a
 * client that stopped retrying fails here rather than hanging on a tick.
 */
async function releaseBackoffs(
  t: TestContext,
  timer: { delays: number[] },
  count: number,
  isSettled: () => boolean,
): Promise<void> {
  for (let released = 0; released < count; released++) {
    await waitFor(() => timer.delays.length > released || isSettled());
    assert.ok(
      timer.delays.length > released,
      `expected backoff sleep #${released + 1} before the request settled`,
    );
    // Tick past anything the client could legally wait for (the in-queue cap
    // is 10s); extra time is harmless when the scheduled sleep is shorter.
    t.mock.timers.tick(11_000);
    await nextTick();
  }
  await waitFor(() => isSettled());
}

/**
 * Assert a scheduled backoff waits out the remainder of a Retry-After window
 * (#892).
 *
 * The wait is the REMAINDER of the window, not the window. The cooldown
 * deadline is stamped when the 429 is read, and the re-queued attempt claims
 * its start slot some microseconds later, so the honest value is
 * `Retry-After` minus that gap — 999 or 1000 for a 1s header, a number that
 * drifts with scheduler noise. Asserting an exact 1000 asserts a millisecond
 * of scheduler luck; asserting only "at most Retry-After" would pass a client
 * that ignored the header and slept 0ms. The band is what actually pins the
 * behaviour: the wait is neither zero nor longer than Spotify asked for.
 */
function assertRetryAfterHonoured(delayMs: number, retryAfterSec: number): void {
  const target = retryAfterSec * 1000;
  assert.ok(
    delayMs <= target && delayMs > target - 100,
    `Retry-After=${retryAfterSec}s honoured: waited ${delayMs}ms, expected ~${target}ms`,
  );
}

/** Seed a valid token fixture into the temp token file. */
async function seedTokens(
  overrides: Partial<{ access_token: string; refresh_token: string; expires_at: number }> = {},
): Promise<void> {
  const tokens = {
    access_token: 'tok-initial',
    refresh_token: 'ref-initial',
    expires_at: Date.now() + 3600_000,
    ...overrides,
  };
  await writeFile(tokenPath, JSON.stringify(tokens), 'utf8');
}

describe('SpotifyClient', () => {
  beforeEach(async () => {
    calls = [];
    responder = () => jsonResponse({});
    // Never touch anything outside tmpdir; start each test from a clean slate.
    await rm(tokenPath, { force: true });
    globalThis.fetch = (async (url: unknown, init: RequestInit) => {
      const call: FetchCall = { url: String(url), init };
      calls.push(call);
      return responder(call.url, call.init);
    }) as typeof fetch;
  });

  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  after(async () => {
    await rm(tokenDir, { recursive: true, force: true });
  });

  // -------------------------------------------------------------------------
  // 1. Token injection
  // -------------------------------------------------------------------------

  describe('token injection', () => {
    it('sends the Bearer token loaded from SPOTIFY_MCP_TOKEN_FILE', async () => {
      await seedTokens({ access_token: 'tok-from-file' });
      responder = () => jsonResponse({ display_name: 'tester' });

      const client = new SpotifyClient();
      const result = await client.get<{ display_name: string }>('/me');

      assert.deepEqual(result, { display_name: 'tester' });
      const sent = apiCalls();
      assert.equal(sent.length, 1);
      assert.equal(sent[0].url, apiUrl('/me'));
      assert.equal(sent[0].init.method, 'GET');
      assert.equal(authHeaderOf(sent[0]), 'Bearer tok-from-file');
    });

    it('rejects with a helpful error when the token file does not exist', async () => {
      const client = new SpotifyClient();
      await assert.rejects(client.get('/me'), { message: /Not authenticated/ });
      assert.equal(calls.length, 0, 'no network traffic without a token');
    });
  });

  // -------------------------------------------------------------------------
  // 2. Pre-request refresh
  // -------------------------------------------------------------------------

  describe('pre-request refresh', () => {
    it('refreshes an expired token before the API call and persists the result', async () => {
      await seedTokens({ expires_at: Date.now() - 1000 }); // expired
      responder = (url) => {
        if (isAccountsUrl(url)) {
          return jsonResponse({ access_token: 'tok-refreshed', expires_in: 3600 });
        }
        return jsonResponse({ ok: true });
      };

      const client = new SpotifyClient();
      await client.get('/me');

      // Refresh POST happened first, to the accounts endpoint.
      assert.equal(calls.length, 2);
      assert.ok(isAccountsUrl(calls[0].url), 'first request must be the token refresh');
      assert.equal(calls[0].init.method, 'POST');

      // Refresh body is form-encoded with grant_type, refresh_token, client_id.
      const form = new URLSearchParams(String(calls[0].init.body));
      assert.equal(form.get('grant_type'), 'refresh_token');
      assert.equal(form.get('refresh_token'), 'ref-initial');
      assert.equal(form.get('client_id'), 'test-client-id');

      // The API call used the refreshed token.
      assert.equal(authHeaderOf(calls[1]), 'Bearer tok-refreshed');

      // Refreshed tokens persisted back to the temp file.
      const persisted = JSON.parse(await readFile(tokenPath, 'utf8')) as {
        access_token: string;
        refresh_token: string;
        expires_at: number;
      };
      assert.equal(persisted.access_token, 'tok-refreshed');
      // refresh_token absent from the refresh response -> old one retained.
      assert.equal(persisted.refresh_token, 'ref-initial');
      assert.ok(
        persisted.expires_at > Date.now() + 3000_000,
        'persisted expires_at reflects expires_in from the refresh response',
      );
    });

    it('throws SpotifyApiError and makes no API call when the refresh itself fails', async () => {
      await seedTokens({ expires_at: Date.now() - 1000 });
      responder = () => jsonResponse({ error: 'invalid_grant' }, 400);

      const client = new SpotifyClient();
      await assert.rejects(client.get('/me'), (err: unknown) => {
        assert.ok(err instanceof SpotifyApiError);
        // 401, not the token endpoint's own 400 (#1007).
        assert.equal(err.status, 401);
        assert.match(err.message, /Token refresh failed/);
        return true;
      });
      assert.equal(apiCalls().length, 0);
    });
  });

  // -------------------------------------------------------------------------
  // 3. 401 mid-flight
  // -------------------------------------------------------------------------

  describe('401 mid-flight', () => {
    it('refreshes once on 401 and the retry succeeds', async () => {
      await seedTokens();
      let apiCount = 0;
      responder = (url) => {
        if (isAccountsUrl(url)) {
          return jsonResponse({ access_token: 'tok-mid', expires_in: 3600 });
        }
        apiCount++;
        if (apiCount === 1) {
          return jsonResponse({ error: { message: 'The access token expired' } }, 401);
        }
        return jsonResponse({ retried: true });
      };

      const client = new SpotifyClient();
      const result = await client.get<{ retried: boolean }>('/me');
      assert.deepEqual(result, { retried: true });

      // initial API call + refresh + retry
      assert.equal(calls.length, 3);
      assert.equal(isAccountsUrl(calls[1].url), true);
      assert.equal(authHeaderOf(calls[0]), 'Bearer tok-initial');
      assert.equal(authHeaderOf(calls[2]), 'Bearer tok-mid');
    });

    it('surfaces SpotifyApiError after a double 401 (no infinite retry)', async () => {
      await seedTokens();
      let apiCount = 0;
      responder = (url) => {
        // Refresh succeeds; the API endpoint keeps rejecting.
        if (isAccountsUrl(url)) {
          return jsonResponse({ access_token: 'tok-still-bad', expires_in: 3600 });
        }
        apiCount++;
        return new Response('still unauthorized', { status: 401 }); // non-JSON body
      };
      const client = new SpotifyClient();
      await assert.rejects(client.get('/me'), (err: unknown) => {
        assert.ok(err instanceof SpotifyApiError);
        assert.equal(err.status, 401);
        assert.equal(err.message, 'Spotify API error 401'); // generic fallback
        return true;
      });
      // initial + refresh + exactly ONE retry — no further attempts.
      assert.equal(calls.length, 3);
      assert.equal(apiCalls().length, 2);
    });
  });

  // -------------------------------------------------------------------------
  // 4. 429 rate limiting
  // -------------------------------------------------------------------------

  describe('429 rate limiting', () => {
    it('honours Retry-After=1, sleeps, and retries once successfully', async (t) => {
      await seedTokens();
      let apiCount = 0;
      responder = (url) => {
        if (isAccountsUrl(url)) throw new Error('unexpected refresh during 429 test');
        apiCount++;
        if (apiCount === 1) {
          return new Response('', { status: 429, headers: { 'Retry-After': '1' } });
        }
        return jsonResponse({ after429: true });
      };

      // Mock only setTimeout so the Retry-After sleep is virtual.
      t.mock.timers.enable({ apis: ['setTimeout'] });

      // Pass-through spy: observe exactly when the backoff sleep is scheduled
      // and with which delay, independent of real-world scheduler speed.
      const timer = spyOnSetTimeout();
      t.after(() => timer.restore());

      let settled = false;
      const pending = new SpotifyClient()
        .get<{ after429: boolean }>('/me')
        .finally(() => {
          settled = true;
        });
      // Drain (without moving the mocked clock) until the client schedules
      // its backoff sleep, then verify it honoured Retry-After=1s...
      await waitFor(() => timer.delays.length > 0 || settled);
      assert.equal(timer.delays.length, 1, 'exactly one backoff sleep scheduled');
      assertRetryAfterHonoured(timer.delays[0], 1);
      // ...then advance past it and drain until the retry resolves.
      t.mock.timers.tick(1000);
      await waitFor(() => settled);
      assert.ok(settled, 'request settled after virtual backoff');

      const result = await pending;
      assert.deepEqual(result, { after429: true });
      assert.equal(apiCalls().length, 2, 'exactly one retry after 429');
      assert.equal(apiCount, 2);
    });

    it('defaults to a 1s backoff when Retry-After header is missing', async (t) => {
      await seedTokens();
      let apiCount = 0;
      responder = () => {
        apiCount++;
        if (apiCount === 1) return new Response('', { status: 429 });
        return jsonResponse({ ok: true });
      };

      t.mock.timers.enable({ apis: ['setTimeout'] });
      // Pass-through spy: observe exactly when the backoff sleep is scheduled
      // without having to tick the clock while waiting for it.
      const timer = spyOnSetTimeout();
      t.after(() => timer.restore());
      let settled = false;
      const pending = new SpotifyClient()
        .get('/me')
        .finally(() => {
          settled = true;
        });

      // Wait (pure event-loop draining, zero clock movement) until the client
      // schedules its default backoff sleep...
      await waitFor(() => timer.delays.length > 0 || settled);
      assert.equal(timer.delays.length, 1, 'exactly one backoff sleep scheduled');
      assertRetryAfterHonoured(timer.delays[0], 1);
      // ...then confirm a sub-second advance does NOT release the retry...
      t.mock.timers.tick(400);
      await nextTick();
      assert.equal(apiCount, 1, 'retry must not fire before ~1s of backoff');
      // ...and that advancing past 1s completes it.
      t.mock.timers.tick(600);
      await waitFor(() => settled);
      assert.ok(settled, 'request settled after full backoff');
      await pending;
      assert.equal(apiCount, 2);
    });
    it('throws immediately with reason on QUOTA_EXCEEDED (issue #108)', async (t) => {
      await seedTokens();
      let apiCount = 0;
      responder = () => {
        apiCount++;
        return jsonResponse(
          { error: { status: 429, message: 'Too many requests', reason: 'QUOTA_EXCEEDED' } },
          429,
          { 'Retry-After': '3600' },
        );
      };

      t.mock.timers.enable({ apis: ['setTimeout'] });
      const timer = spyOnSetTimeout();
      t.after(() => timer.restore());

      await assert.rejects(
        new SpotifyClient().get('/me'),
        (err: unknown) => {
          const e = err as SpotifyApiError;
          return (
            e instanceof SpotifyApiError &&
            e.status === 429 &&
            e.reason === 'QUOTA_EXCEEDED' &&
            e.retryAfterSec === 3600 &&
            /quota exceeded/i.test(e.message)
          );
        },
      );
      // No in-queue sleep may have been scheduled for a quota wall.
      assert.equal(timer.delays.length, 0, 'no backoff sleep for QUOTA_EXCEEDED');
      assert.equal(apiCount, 1, 'no retry after quota exhaustion');
    });

    it('fails fast without sleeping when Retry-After exceeds the burst cap (issue #108)', async (t) => {
      await seedTokens();
      let apiCount = 0;
      responder = () => {
        apiCount++;
        return new Response('', { status: 429, headers: { 'Retry-After': '45' } });
      };

      t.mock.timers.enable({ apis: ['setTimeout'] });
      const timer = spyOnSetTimeout();
      t.after(() => timer.restore());

      await assert.rejects(
        new SpotifyClient().get('/me'),
        (err: unknown) => {
          const e = err as SpotifyApiError;
          return (
            e instanceof SpotifyApiError &&
            e.status === 429 &&
            e.retryAfterSec === 45 &&
            /retry later/i.test(e.message)
          );
        },
      );
      assert.equal(timer.delays.length, 0, 'no in-queue sleep beyond the cap');
      assert.equal(apiCount, 1);
    });

    it('parses Retry-After and attaches retryAfterSec on a 429 that lands after a 401-refresh retry (issue #671)', async (t) => {
      await seedTokens();
      let apiCount = 0;
      responder = (url) => {
        if (isAccountsUrl(url)) {
          return jsonResponse({ access_token: 'tok-refreshed', expires_in: 3600 });
        }
        apiCount++;
        if (apiCount === 1) {
          // First API call: expired token, forces a 401-refresh retry.
          return jsonResponse({ error: { message: 'The access token expired' } }, 401);
        }
        if (apiCount === 2) {
          // Second API call (after refresh): Spotify answers 429 with
          // Retry-After=5. The bug is that this used to fall through to the
          // generic non-ok throw and silently drop Retry-After.
          return new Response('', { status: 429, headers: { 'Retry-After': '5' } });
        }
        // If anything ever reaches this third call, the 429 branch has been
        // reactivated as a retry loop — fail loudly so the regression is
        // obvious instead of a quiet infinite wait.
        throw new Error(`unexpected third API call (apiCount=${apiCount})`);
      };

      t.mock.timers.enable({ apis: ['setTimeout'] });
      const timer = spyOnSetTimeout();
      t.after(() => timer.restore());

      const client = new SpotifyClient();
      await assert.rejects(client.get('/me'), (err: unknown) => {
        const e = err as SpotifyApiError;
        return (
          e instanceof SpotifyApiError &&
          e.status === 429 &&
          e.retryAfterSec === 5 &&
          /Rate limited/i.test(e.message) &&
          /Retry-After 5s/.test(e.message)
        );
      });
      // Refresh happened exactly once; we did not loop.
      assert.equal(
        calls.filter((c) => isAccountsUrl(c.url)).length,
        1,
        'exactly one refresh',
      );
      // First 401 + second 429 — no third API call (200 is never reached).
      assert.equal(apiCount, 2, 'no infinite 429 retry after the 401-refresh');
      // The 429 on a retried attempt must not schedule an in-queue sleep; we
      // have already used our one retry budget and must throw instead.
      assert.equal(timer.delays.length, 0, 'no in-queue sleep on a retried 429');
    });

    it('still fires cooldown accounting when a 429 lands on a retried attempt (issue #671)', async (t) => {
      await seedTokens();
      let apiCount = 0;
      responder = (url) => {
        if (isAccountsUrl(url)) {
          return jsonResponse({ access_token: 'tok-refreshed', expires_in: 3600 });
        }
        apiCount++;
        if (apiCount === 1) {
          return jsonResponse({ error: { message: 'expired' } }, 401);
        }
        return new Response('', { status: 429, headers: { 'Retry-After': '7' } });
      };

      const client = new SpotifyClient();
      await assert.rejects(client.get('/me'), (err: unknown) => {
        assert.ok(err instanceof SpotifyApiError);
        assert.equal(err.status, 429);
        return true;
      });
      // The cooldown window is observable through the rate-limit resource
      // (#904). It must reflect the 429 we just observed, even though it
      // arrived on a retried attempt — otherwise the queue would happily
      // dispatch the next request straight back into another 429. Note that
      // `_lastThrottle` is reserved for the first-429 sleep+retry path (the
      // "we actually waited" notice consumed by takeThrottleNotice), so it
      // stays null on a retried 429 by design.
      const status = client.getRateLimitStatus();
      assert.ok(
        status.cooldownRemainingMs > 0,
        `cooldown must be set after a retried 429, got ${status.cooldownRemainingMs}ms`,
      );
    });

  });

  // -------------------------------------------------------------------------
  // 4b. Bounded 5xx / transport retry (#675)
  // -------------------------------------------------------------------------

  describe('5xx and transport retry', () => {
    /** A DNS failure / connection reset as `fetch` actually surfaces it. */
    function connectionReset(): TypeError {
      return Object.assign(new TypeError('fetch failed'), {
        cause: Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' }),
      });
    }

    it('retries a 503 once and succeeds, honouring its Retry-After', async (t) => {
      await seedTokens();
      let apiCount = 0;
      responder = () => {
        apiCount++;
        if (apiCount === 1) {
          return new Response('', { status: 503, headers: { 'Retry-After': '2' } });
        }
        return jsonResponse({ after503: true });
      };

      t.mock.timers.enable({ apis: ['setTimeout'] });
      const timer = spyOnSetTimeout();
      t.after(() => timer.restore());

      let settled = false;
      const pending = new SpotifyClient()
        .get<{ after503: boolean }>('/me')
        .finally(() => {
          settled = true;
        });
      await releaseBackoffs(t, timer, 1, () => settled);

      assert.equal(timer.delays.length, 1, 'exactly one backoff sleep scheduled');
      assert.equal(timer.delays[0], 2000, 'Retry-After=2s honoured on the 5xx backoff');
      assert.deepEqual(await pending, { after503: true });
      assert.equal(apiCount, 2, 'exactly one retry after the 503');
    });

    it('honours an HTTP-date Retry-After on a 5xx instead of the 1s fallback', async (t) => {
      await seedTokens();
      let apiCount = 0;
      responder = () => {
        apiCount++;
        if (apiCount === 1) {
          return new Response('', {
            status: 503,
            // RFC 9110's second Retry-After form. The old parseInt read this as
            // NaN and fell to the 1s floor, so the wait below would have been
            // 1s instead of ~5s. Kept under the 10s in-queue cap so the retry
            // actually happens; the 30s case is pinned in parseRetryAfter's
            // own unit tests.
            headers: { 'Retry-After': new Date(Date.now() + 5_000).toUTCString() },
          });
        }
        return jsonResponse({ afterDate: true });
      };

      t.mock.timers.enable({ apis: ['setTimeout'] });
      const timer = spyOnSetTimeout();
      t.after(() => timer.restore());

      let settled = false;
      const pending = new SpotifyClient()
        .get('/me')
        .finally(() => {
          settled = true;
        });
      await releaseBackoffs(t, timer, 1, () => settled);
      await pending;

      assert.equal(timer.delays.length, 1);
      // toUTCString truncates to whole seconds, so allow a second of slack.
      // The discriminator is the 1s fallback: 1000 would mean the HTTP-date
      // was not parsed.
      assert.ok(
        Math.abs((timer.delays[0] ?? 0) - 5_000) <= 1000,
        `HTTP-date Retry-After should wait ~5s, waited ${timer.delays[0]}ms`,
      );
      assert.equal(apiCount, 2);
    });

    it('stops at the attempt budget rather than retrying a 503 forever', async (t) => {
      await seedTokens();
      let apiCount = 0;
      responder = () => {
        apiCount++;
        return new Response('', { status: 503 });
      };

      t.mock.timers.enable({ apis: ['setTimeout'] });
      const timer = spyOnSetTimeout();
      t.after(() => timer.restore());

      let settled = false;
      const pending = new SpotifyClient()
        .get('/me')
        .catch(() => undefined)
        .finally(() => {
          settled = true;
        });
      await releaseBackoffs(t, timer, 2, () => settled);
      await pending;

      // Bounded: 1 initial dispatch + 2 retries, and no fourth attempt.
      assert.equal(apiCount, 3, 'the retry budget bounds a permanently unhealthy Spotify');
      assert.equal(timer.delays.length, 2, 'one backoff per retry, not a tight loop');
    });

    it('does not retry a 500 — Spotify\'s own logic failing is not transient', async (t) => {
      await seedTokens();
      let apiCount = 0;
      responder = () => {
        apiCount++;
        return new Response('', { status: 500 });
      };

      t.mock.timers.enable({ apis: ['setTimeout'] });
      const timer = spyOnSetTimeout();
      t.after(() => timer.restore());

      await assert.rejects(new SpotifyClient().get('/me'), SpotifyApiError);
      assert.equal(apiCount, 1, '500 is outside the retryable gateway set');
      assert.equal(timer.delays.length, 0, 'no backoff sleep for a 500');
    });

    it('fails fast without sleeping when a 5xx Retry-After exceeds the in-queue cap', async (t) => {
      await seedTokens();
      let apiCount = 0;
      responder = () => {
        apiCount++;
        return new Response('', { status: 503, headers: { 'Retry-After': '60' } });
      };

      t.mock.timers.enable({ apis: ['setTimeout'] });
      const timer = spyOnSetTimeout();
      t.after(() => timer.restore());

      await assert.rejects(new SpotifyClient().get('/me'), (err: unknown) => {
        const e = err as SpotifyApiError;
        assert.ok(e instanceof SpotifyApiError);
        assert.equal(e.status, 503);
        // The message must name the long wait, not "try again shortly" —
        // a server that says a minute must never be reported as a short one.
        assert.match(e.message, /Retry-After 60s/);
        assert.match(e.message, /10s in-queue wait cap/);
        return true;
      });
      assert.equal(timer.delays.length, 0, 'no in-queue sleep beyond the cap');
      assert.equal(apiCount, 1);
    });

    it('spreads the 5xx backoff with jitter, not just base doubling', async (t) => {
      await seedTokens();
      t.mock.timers.enable({ apis: ['setTimeout'] });
      const timer = spyOnSetTimeout();
      t.after(() => timer.restore());

      /** Delays a client schedules for `random` before giving up on a 503. */
      const backoffsFor = async (random: () => number): Promise<number[]> => {
        let apiCount = 0;
        responder = () => {
          apiCount++;
          return new Response('', { status: 503 });
        };
        timer.delays.length = 0;
        let settled = false;
        const pending = new SpotifyClient({ random })
          .get('/me')
          .catch(() => undefined)
          .finally(() => {
            settled = true;
          });
        await releaseBackoffs(t, timer, 2, () => settled);
        await pending;
        assert.equal(apiCount, 3, 'every run is bounded by the same budget');
        return [...timer.delays];
      };

      // 250ms * 2^n, plus random() * 250ms of jitter. The first retry already
      // differs across the three jitter draws (250 / 375 / 500), so the spread
      // is the jitter itself rather than the base doubling two retries apart.
      assert.deepEqual(await backoffsFor(() => 0), [250, 500]);
      assert.deepEqual(await backoffsFor(() => 0.5), [375, 625]);
      assert.deepEqual(await backoffsFor(() => 1), [500, 750]);
    });

    it('does NOT retry a POST that lost its connection — a mutation must not be re-sent', async (t) => {
      await seedTokens();
      let apiCount = 0;
      responder = () => {
        apiCount++;
        throw connectionReset();
      };

      t.mock.timers.enable({ apis: ['setTimeout'] });
      const timer = spyOnSetTimeout();
      t.after(() => timer.restore());

      await assert.rejects(
        new SpotifyClient().post('/me/player/queue', { uris: ['spotify:track:1'] }),
        (err: unknown) => {
          // Not a raw TypeError: the error boundary classifies an untyped
          // throw as `internal` and advises a blind re-run of the tool, which
          // is the retry that would double-apply the mutation.
          assert.ok(
            err instanceof SpotifyApiError,
            `expected SpotifyApiError, got ${err?.constructor?.name}: ${err}`,
          );
          const e = err as SpotifyApiError;
          assert.equal(e.status, 503, 'a network blip is unavailable, not internal');
          assert.match(e.message, /^POST https:\/\/api\.spotify\.com\/v1\/me\/player\/queue failed: fetch failed/);
          return true;
        },
      );
      assert.equal(apiCount, 1, 'the POST was never re-sent');
      assert.equal(timer.delays.length, 0, 'no backoff sleep for a non-idempotent transport failure');
    });

    it('retries an idempotent GET through a connection reset, then reports a typed 503', async (t) => {
      await seedTokens();
      let apiCount = 0;
      responder = () => {
        apiCount++;
        throw connectionReset();
      };

      t.mock.timers.enable({ apis: ['setTimeout'] });
      const timer = spyOnSetTimeout();
      t.after(() => timer.restore());

      let settled = false;
      let thrown: unknown;
      const pending = new SpotifyClient()
        .get('/me')
        .catch((err: unknown) => {
          thrown = err;
        })
        .finally(() => {
          settled = true;
        });
      await releaseBackoffs(t, timer, 2, () => settled);
      await pending;

      const err = thrown as SpotifyApiError;
      assert.ok(err instanceof SpotifyApiError, `expected SpotifyApiError, got ${err}`);
      assert.equal(err.status, 503);
      assert.match(err.message, /^GET https:\/\/api\.spotify\.com\/v1\/me failed: fetch failed/);
      assert.equal(apiCount, 3, 'a GET is idempotent, so it is retried within budget');
    });

    it('leaves the shared quota cooldown alone — a 5xx backoff is per-request', async (t) => {
      await seedTokens();
      responder = () => new Response('', { status: 503, headers: { 'Retry-After': '2' } });

      t.mock.timers.enable({ apis: ['setTimeout'] });
      const timer = spyOnSetTimeout();
      t.after(() => timer.restore());

      const client = new SpotifyClient();
      let settled = false;
      const pending = client
        .get('/me')
        .catch(() => undefined)
        .finally(() => {
          settled = true;
        });
      await releaseBackoffs(t, timer, 2, () => settled);
      await pending;

      // Arming _rateLimitUntil here would make quotaPreflight() block every
      // queued call behind one flaky route. Only a 429 owns that window.
      assert.equal(
        client.getRateLimitStatus().cooldownRemainingMs,
        0,
        'a 503 backoff must not arm the shared quota cooldown',
      );
    });
  });

  // -------------------------------------------------------------------------
  // 5. Error mapping
  // -------------------------------------------------------------------------

  describe('error mapping', () => {
    it("carries the status and Spotify's own message from {error:{message}}", async () => {
      await seedTokens();
      responder = () =>
        jsonResponse({ error: { status: 500, message: 'Oops, something broke upstream' } }, 500);

      const client = new SpotifyClient();
      await assert.rejects(client.get('/me'), (err: unknown) => {
        assert.ok(err instanceof SpotifyApiError);
        assert.equal(err.name, 'SpotifyApiError');
        assert.equal(err.status, 500);
        assert.equal(err.message, 'Oops, something broke upstream');
        return true;
      });
    });

    it('falls back to the generic 403 message when the body carries no message', async () => {
      await seedTokens();
      responder = () => jsonResponse({}, 403);

      const client = new SpotifyClient();
      await assert.rejects(client.get('/me'), (err: unknown) => {
        assert.ok(err instanceof SpotifyApiError);
        assert.equal(err.status, 403);
        assert.match(err.message, /Spotify returned 403/);
        assert.match(err.message, /OAuth scope/);
        return true;
      });
    });

    it('falls back to the generic 404 message when the body is not JSON', async () => {
      await seedTokens();
      responder = () => new Response('<html>404</html>', { status: 404 });

      const client = new SpotifyClient();
      await assert.rejects(client.get('/nope'), (err: unknown) => {
        assert.ok(err instanceof SpotifyApiError);
        assert.equal(err.status, 404);
        assert.equal(err.message, 'The requested resource was not found on Spotify');
        return true;
      });
    });

    it('maps a player-namespace 404 to a no-active-device message with a next step (#849)', async () => {
      await seedTokens();
      responder = () =>
        jsonResponse(
          {
            error: {
              status: 404,
              message: 'Player command failed: No active device found',
              reason: 'NO_ACTIVE_DEVICE',
            },
          },
          404,
        );

      const client = new SpotifyClient();
      await assert.rejects(client.put('/me/player/play', { uris: [] }), (err: unknown) => {
        assert.ok(err instanceof SpotifyApiError);
        assert.equal(err.status, 404);
        assert.match(err.message, /no active spotify device/i);
        assert.match(err.message, /next step/i);
        assert.match(err.message, /device_health/);
        // The bare not-found line would send the agent hunting for a missing
        // object; the device diagnosis must replace it.
        assert.doesNotMatch(err.message, /requested resource was not found/i);
        return true;
      });
      assert.equal(apiCalls().at(-1)?.url, apiUrl('/me/player/play'));
    });

    it('maps a "Player command failed: Device not found" 404 to the device message (#849)', async () => {
      await seedTokens();
      responder = () =>
        jsonResponse({ error: { status: 404, message: 'Player command failed: Device not found' } }, 404);

      const client = new SpotifyClient();
      await assert.rejects(client.post('/me/player/next'), (err: unknown) => {
        assert.ok(err instanceof SpotifyApiError);
        assert.match(err.message, /no active spotify device/i);
        return true;
      });
    });

    it('leaves a genuinely missing resource 404 on the generic not-found mapping (#849)', async () => {
      await seedTokens();
      responder = () => jsonResponse({ error: { status: 404, message: 'Not found.' } }, 404);

      const client = new SpotifyClient();
      await assert.rejects(client.get('/playlists/37i9dQ'), (err: unknown) => {
        assert.ok(err instanceof SpotifyApiError);
        assert.equal(err.status, 404);
        assert.equal(err.message, 'Not found.');
        assert.doesNotMatch(err.message, /no active spotify device/i);
        return true;
      });
    });

    it('keeps a non-device "Player command failed" 404 verbatim (#849)', async () => {
      await seedTokens();
      responder = () =>
        jsonResponse({ error: { status: 404, message: 'Player command failed: Restriction violated' } }, 404);

      const client = new SpotifyClient();
      await assert.rejects(client.put('/me/player/shuffle', { state: true }), (err: unknown) => {
        assert.ok(err instanceof SpotifyApiError);
        assert.equal(err.message, 'Player command failed: Restriction violated');
        return true;
      });
    });

    it('names the rejected device_id in the no-active-device message (#849)', async () => {
      await seedTokens();
      responder = () =>
        jsonResponse(
          {
            error: {
              status: 404,
              message: 'Player command failed: No active device found',
              reason: 'NO_ACTIVE_DEVICE',
            },
          },
          404,
        );

      const client = new SpotifyClient();
      // The id is the one Spotify actually rejected — the agent must be able
      // to see it, otherwise "start playback in the app" is followed by a
      // re-send of the same dead id.
      await assert.rejects(
        client.put(`/me/player/pause?device_id=${encodeURIComponent('dead-device-9f2c')}`),
        (err: unknown) => {
          assert.ok(err instanceof SpotifyApiError);
          assert.equal(err.status, 404);
          assert.match(err.message, /no active spotify device/i);
          assert.ok(
            err.message.includes('dead-device-9f2c'),
            `message must name the rejected device_id, got: ${err.message}`,
          );
          assert.match(err.message, /device_health/);
          return true;
        },
      );
    });

    it('does not invent a device_id clause when the call passed none (#849)', async () => {
      await seedTokens();
      responder = () =>
        jsonResponse({ error: { status: 404, message: 'Player command failed: No active device found' } }, 404);

      const client = new SpotifyClient();
      await assert.rejects(client.put('/me/player/pause'), (err: unknown) => {
        assert.ok(err instanceof SpotifyApiError);
        assert.match(err.message, /no active spotify device/i);
        // Nothing was rejected by id, so nothing is named: the base message
        // is the whole truth here.
        assert.doesNotMatch(err.message, /Spotify rejected device_id/);
        return true;
      });
    });

    it('falls back to the generic 503 message when the body is unparseable', async (t) => {
      await seedTokens();
      responder = () => new Response('Gateway fell over', { status: 503 });

      // A 503 is now retried with backoff (#675), so the clock is mocked to
      // keep those waits virtual instead of spending them in real time.
      t.mock.timers.enable({ apis: ['setTimeout'] });
      const timer = spyOnSetTimeout();
      t.after(() => timer.restore());

      const client = new SpotifyClient();
      let settled = false;
      let thrown: unknown;
      const pending = client
        .get('/me')
        .catch((err: unknown) => {
          thrown = err;
        })
        .finally(() => {
          settled = true;
        });
      await releaseBackoffs(t, timer, 2, () => settled);
      await pending;

      const err = thrown as SpotifyApiError;
      assert.ok(err instanceof SpotifyApiError);
      assert.equal(err.status, 503);
      assert.equal(
        err.message,
        'Spotify service is temporarily unavailable — try again shortly',
      );
    });

    it('uses the generic fallback when the message field is blank whitespace', async () => {
      await seedTokens();
      responder = () => jsonResponse({ error: { message: '   ' } }, 500);

      const client = new SpotifyClient();
      await assert.rejects(client.get('/me'), (err: unknown) => {
        assert.ok(err instanceof SpotifyApiError);
        assert.equal(err.message, 'Spotify API error 500');
        return true;
      });
    });
  });

  // -------------------------------------------------------------------------
  // 6. 204 No Content
  // -------------------------------------------------------------------------

  describe('204 No Content', () => {
    it('returns null on GET 204 instead of parsing an empty body as JSON', async () => {
      await seedTokens();
      responder = () => new Response(null, { status: 204 });

      const client = new SpotifyClient();
      const result = await client.get('/me/player');
      assert.equal(result, null);
      assert.equal(apiCalls().length, 1);
    });
  });

  // -------------------------------------------------------------------------
  // 6a. The read cache (#660)
  //
  // The cache is the one part of `get` the rest of this file cannot see. Every
  // other test here counts requests as though each read reached the network,
  // which is a fine assumption for a hit and a fine assumption for a miss —
  // and the two are exactly what this block separates.
  //
  // Why fetch counts and not equality assertions: "two reads returned the same
  // object" is satisfied by a client with no cache at all, and "the re-read
  // differs from the first" is satisfied by a client that always refetches.
  // Only the number of requests on the wire distinguishes serving an entry
  // from going to Spotify, so every test below pins that number exactly. The
  // bodies are stamped with a generation counter for the second half of the
  // same reason: when a count alone cannot say WHICH body came back (a
  // revalidation, a raced fill), the generation says whether the value served
  // is the one the pre-mutation read saw or the post-mutation one.
  //
  // These go through the real `get`, not `tests/helpers/stub-client.ts`. That
  // helper overrides `get` itself and constructs with `disableCache: true`,
  // both deliberately: it exists so tool tests get the production PAGING walk
  // without a token file, a retry queue or a cache. The cache is inside the
  // method it overrides, so a stub that answered `get` directly could not
  // reach the hit branch, the fill, or the invalidation — there is nothing to
  // stub here that would not be the code under test.
  // -------------------------------------------------------------------------

  describe('read cache (#660)', () => {
    /**
     * A responder whose GET bodies carry a fresh generation number.
     *
     * A write answers with a snapshot id and does NOT consume a generation, so
     * "generation 2" always means the second GET Spotify saw — the counter
     * measures reads, which is what the assertions are about.
     */
    function generationResponder(state: { reads: number }): (url: string, init: RequestInit) => Response {
      return (_url, init) =>
        (init.method ?? 'GET').toUpperCase() === 'GET'
          ? jsonResponse({ generation: ++state.reads })
          : jsonResponse({ snapshot_id: 'snap-1' });
    }

    it('serves a repeated catalog read from the entry: two GETs, one fetch', async () => {
      await seedTokens();
      const state = { reads: 0 };
      responder = generationResponder(state);

      const client = new SpotifyClient();
      const first = await client.get<{ generation: number }>('/albums/A1');
      const second = await client.get<{ generation: number }>('/albums/A1');

      assert.equal(state.reads, 1, `two identical reads must cost one fetch, saw ${state.reads}`);
      assert.deepEqual(first, { generation: 1 });
      // The generation is the point: a second fetch would answer 2 here, and
      // this is what makes the count above mean "served from the entry" rather
      // than "the two reads happened to look alike".
      assert.deepEqual(second, { generation: 1 }, 'the second read was answered from the entry, not refetched');
      assert.equal(client.cache?.size, 1);
    });

    it('keys the entry on the whole path, so a different resource is a different read', async () => {
      // A key that dropped the id — or kept only the path's first segment —
      // would answer this second read with the first album's body, and a test
      // that only compared the two results would see one plausible object and
      // pass. The generation counter is what makes the collision visible.
      await seedTokens();
      const state = { reads: 0 };
      responder = generationResponder(state);

      const client = new SpotifyClient();
      const first = await client.get<{ generation: number }>('/albums/A1');
      const second = await client.get<{ generation: number }>('/albums/B2');

      assert.equal(state.reads, 2, 'two different albums are two reads');
      assert.deepEqual(first, { generation: 1 });
      assert.deepEqual(second, { generation: 2 }, 'the second read returned the second album, not the first');
    });

    it('a library write drops the library read it could have changed: the re-read refetches', async () => {
      await seedTokens();
      const state = { reads: 0 };
      responder = generationResponder(state);

      const client = new SpotifyClient();
      const first = await client.get<{ generation: number }>('/me/tracks', { limit: '50', offset: '0' });
      const cached = await client.get<{ generation: number }>('/me/tracks', { limit: '50', offset: '0' });
      assert.equal(state.reads, 1, 'control: the pre-write read really was cached');
      assert.deepEqual(cached, first);

      // `PUT /me/library` is the post-February-2026 save endpoint (AGENTS.md
      // §2). Every cacheable `/me/` read is in its blast radius.
      await client.put('/me/library', { uris: ['spotify:track:t1'] });

      const after = await client.get<{ generation: number }>('/me/tracks', { limit: '50', offset: '0' });
      assert.equal(state.reads, 2, 'the re-read after the write must reach the network');
      // The failure this guards is not a crash but a plausible wrong answer:
      // the pre-write body, served as if it were current, for the whole TTL.
      assert.deepEqual(after, { generation: 2 }, 'the value served is the one Spotify sent AFTER the write');
    });

    it('a write the plan does not classify clears every cached read (fail-closed)', async () => {
      // The other half of `afterMutation`, and the one that owns the
      // `this.cache?.clear()` the scoped path replaced: a write endpoint
      // nothing has classified has an unknown blast radius, so it drops
      // everything rather than guess. cache.test.ts asserts the entry count
      // reaches zero; this asserts the consequence — the next read actually
      // goes to the network and comes back with the new body.
      await seedTokens();
      const state = { reads: 0 };
      responder = generationResponder(state);

      const client = new SpotifyClient();
      await client.get('/albums/A1');
      await client.get('/artists/B2/albums', { limit: '20' });
      assert.equal(state.reads, 2);

      // Not a real endpoint on purpose: it stands for any write a future
      // Spotify release adds, which is exactly the case no rule covers.
      await client.post('/some/future/endpoint', {});

      const after = await client.get<{ generation: number }>('/artists/B2/albums', { limit: '20' });
      assert.equal(state.reads, 3, 'an unclassified write must not leave a readable entry behind');
      assert.deepEqual(after, { generation: 3 });
      assert.equal(client.cache?.size, 1, 'only the re-read remains');
    });

    it('bypasses the cache for /me/player: two GETs, two fetches', async () => {
      // Playback state changes out from under the server, so a cached read of
      // it is a stale "now playing" an agent then acts on. The generations
      // make the point that the count alone cannot: the two answers differ,
      // so the second one demonstrably came from Spotify.
      await seedTokens();
      const state = { reads: 0 };
      responder = generationResponder(state);

      const client = new SpotifyClient();
      const first = await client.get<{ generation: number }>('/me/player');
      const second = await client.get<{ generation: number }>('/me/player');

      assert.equal(state.reads, 2, 'playback state must be re-read, not replayed from an entry');
      assert.deepEqual(first, { generation: 1 });
      assert.deepEqual(second, { generation: 2 });
      assert.equal(client.cache?.size, 0, 'a volatile read is never retained');

      // Same rule for the nested volatile path.
      await client.get('/me/player/recently-played', { limit: '20' });
      await client.get('/me/player/recently-played', { limit: '20' });
      assert.equal(state.reads, 4, 'recently-played is /me/player*, so it bypasses too');
      assert.equal(client.cache?.size, 0);
    });

    it('bypasses the cache for a volatile path that carries a query string', async () => {
      // The query is the part that can defeat a prefix check. A bypass written
      // as a comparison against the raw target (or one that matched only the
      // path before the caller added params) would cache this read and freeze
      // playback state for the TTL.
      await seedTokens();
      const state = { reads: 0 };
      responder = generationResponder(state);

      const client = new SpotifyClient();
      const first = await client.get<{ generation: number }>('/me/player', { market: 'US' });
      const second = await client.get<{ generation: number }>('/me/player', { market: 'US' });

      // Pin that the request really did carry the query, so this cannot pass by
      // testing a bare `/me/player` twice.
      assert.equal(apiCalls()[0]?.url, apiUrl('/me/player?market=US'));
      assert.equal(state.reads, 2, 'a volatile path with a query string must still bypass');
      assert.deepEqual(first, { generation: 1 });
      assert.deepEqual(second, { generation: 2 });
      assert.equal(client.cache?.size, 0);
    });

    it('bypasses the cache for /me/top, the personal charts', async () => {
      await seedTokens();
      const state = { reads: 0 };
      responder = generationResponder(state);

      const client = new SpotifyClient();
      const first = await client.get<{ generation: number }>('/me/top/artists', { limit: '20' });
      const second = await client.get<{ generation: number }>('/me/top/artists', { limit: '20' });

      assert.equal(state.reads, 2, 'personal charts move under the server; they are not cached');
      assert.deepEqual(first, { generation: 1 });
      assert.deepEqual(second, { generation: 2 });
      assert.equal(client.cache?.size, 0);
    });

    it('the volatile prefixes do not widen into the rest of /me/', async () => {
      // The mirror of the three tests above, and the guard on the fix for
      // them. `startsWith('/me/player')` is a deliberate, narrow claim: widen
      // it to `/me/play` and every library read silently stops being cached
      // too, which costs a refetch per read and looks like a performance
      // regression rather than a policy change. Nothing else in the suite
      // would notice.
      await seedTokens();
      const state = { reads: 0 };
      responder = generationResponder(state);

      const client = new SpotifyClient();
      const first = await client.get<{ generation: number }>('/me/playlists', { limit: '50' });
      const second = await client.get<{ generation: number }>('/me/playlists', { limit: '50' });

      assert.equal(state.reads, 1, '/me/playlists is not a volatile path and must still be cached');
      assert.deepEqual(second, first);
      assert.equal(client.cache?.size, 1);
    });

    it('disableCache: true makes two identical reads two fetches', async () => {
      // Carries its own control. A test that only asserted "two fetches" for
      // the disabled client would also pass if the harness never cached
      // anything; the enabled client in the same test is what makes the
      // contrast mean something.
      await seedTokens();
      const state = { reads: 0 };
      responder = generationResponder(state);

      const enabled = new SpotifyClient();
      const disabled = new SpotifyClient({ disableCache: true });
      assert.notEqual(enabled.cache, null, 'control: the default client has a cache');
      assert.equal(disabled.cache, null, 'disableCache is a missing cache, not an empty one');

      await enabled.get('/albums/A1');
      await enabled.get('/albums/A1');
      assert.equal(state.reads, 1, 'control: the default client answered the second read from the entry');

      await disabled.get('/albums/A1');
      await disabled.get('/albums/A1');
      assert.equal(state.reads, 3, 'a client with the cache disabled must not answer the second read');
    });
  });

  // -------------------------------------------------------------------------
  // 6b. Unreadable mutation bodies (#674)
  // -------------------------------------------------------------------------

  describe('unreadable mutation bodies (#674)', () => {
    // The hazard this covers is not a crash, it is a lie: a 2xx write that
    // Spotify applied, reported back to the caller as a failure. The caller
    // retries and double-applies (queue duplicates, double playlist adds,
    // duplicate library saves), and the stale read cache plus the history line
    // are skipped with it.

    /** 200 + a JSON content-type, delivering `body` as the exact bytes. */
    function jsonBodyResponse(body: string): Response {
      return new Response(body, { status: 200, headers: { 'content-type': 'application/json' } });
    }

    it('resolves a 200 + application/json + empty body to null instead of throwing', async () => {
      await seedTokens();
      responder = () => jsonBodyResponse('');

      const client = new SpotifyClient();
      const result = await client.post('/me/player/queue', { uri: 'spotify:track:x' });
      assert.equal(result, null, 'an empty body is not a failed write');
      assert.equal(apiCalls().length, 1);
      assert.equal(apiCalls()[0].init.method, 'POST');
    });

    it('resolves a torn JSON body to null instead of throwing', async () => {
      await seedTokens();
      responder = () => jsonBodyResponse('{"a":');

      const client = new SpotifyClient();
      const result = await client.post('/playlists/p1/items', { uris: ['spotify:track:x'] });
      assert.equal(result, null);
    });

    it('still parses a well-formed body and carries its snapshot_id', async () => {
      await seedTokens();
      responder = () => jsonResponse({ snapshot_id: 'snap-1' }, 200, { 'content-type': 'application/json' });

      const client = new SpotifyClient();
      const result = await client.delete<{ snapshot_id: string }>('/me/tracks?ids=x');
      assert.deepEqual(result, { snapshot_id: 'snap-1' });
    });

    it('gives every write method the same guard, not just post', async () => {
      await seedTokens();
      responder = () => jsonBodyResponse('{"torn":');

      const client = new SpotifyClient();
      // put / delete share post's helper; putRaw sends no parseable body at all.
      assert.equal(await client.put('/me/player/volume?volume_percent=50', { volume_percent: 50 }), null);
      assert.equal(await client.delete('/me/player/devices/current', null), null);
      await client.putRaw('/playlists/p1/images', 'binary-bytes');
      assert.deepEqual(
        apiCalls().map((c) => `${c.init.method} ${new URL(c.url).pathname}`),
        [
          'PUT /v1/me/player/volume',
          'DELETE /v1/me/player/devices/current',
          'PUT /v1/playlists/p1/images',
        ],
      );
    });

    it('invalidates the read cache after a write whose body would not parse', async () => {
      await seedTokens();
      let reads = 0;
      responder = (_url, init) => {
        if (init.method === 'POST') return jsonBodyResponse('');
        reads++;
        return jsonResponse({ items: [{ id: `read-${reads}` }], total: 1, limit: 1, offset: 0 });
      };

      const client = new SpotifyClient();
      // A playlist read, because the write below targets that playlist: since
      // #893 a write invalidates the reads it could have changed rather than
      // the whole cache, so a queue write would (correctly) leave this entry
      // alone and would no longer exercise the #674 behaviour under test.
      const first = await client.get<{ items: { id: string }[] }>('/playlists/p1/items');
      const cached = await client.get<{ items: { id: string }[] }>('/playlists/p1/items');
      assert.deepEqual(cached, first);
      assert.equal(reads, 1, 'the second read was a cache hit');

      assert.equal(await client.post('/playlists/p1/items', { uris: ['spotify:track:x'] }), null);

      const after = await client.get<{ items: { id: string }[] }>('/playlists/p1/items');
      assert.equal(reads, 2, 'the accepted write dropped the cached read despite its unreadable body');
      assert.notDeepEqual(after, first, 'the post-write read is not the pre-write payload');
    });

    it('does not invalidate the cache for a write Spotify rejected', async () => {
      await seedTokens();
      let albumReads = 0;
      responder = (_url, init) => {
        if (init.method === 'POST') return jsonResponse({ error: { message: 'Not found.' } }, 404);
        albumReads++;
        return jsonResponse({ items: [{ id: `read-${albumReads}` }], total: 1, limit: 1, offset: 0 });
      };

      const client = new SpotifyClient();
      await client.get('/albums');
      await assert.rejects(client.post('/me/player/nope'), (err: unknown) => {
        assert.ok(err instanceof SpotifyApiError);
        assert.equal(err.status, 404);
        // Spotify's own message, not a rewritten one (#1/#6).
        assert.equal(err.message, 'Not found.');
        return true;
      });

      await client.get('/albums');
      assert.equal(albumReads, 1, 'a rejected write changed nothing, so the cache stands');
    });

    it('surfaces a torn token-refresh body as a SpotifyApiError, not a SyntaxError', async () => {
      await seedTokens({ expires_at: Date.now() - 1000 }); // forces the pre-request refresh
      responder = (url) =>
        isAccountsUrl(url) ? jsonBodyResponse('{"access_token":') : jsonResponse({ display_name: 'tester' });

      const client = new SpotifyClient();
      await assert.rejects(client.get('/me'), (err: unknown) => {
        assert.ok(
          err instanceof SpotifyApiError,
          `expected SpotifyApiError, got ${(err as Error)?.name}: ${(err as Error)?.message}`,
        );
        assert.equal(err.status, 503);
        return true;
      });
    });

    it('rides out an unreadable token refresh on a still-valid access token', async () => {
      // Inside the 60s pre-expiry refresh window but not yet expired.
      await seedTokens({ expires_at: Date.now() + 30_000 });
      responder = (url) =>
        isAccountsUrl(url) ? jsonBodyResponse('not json at all') : jsonResponse({ display_name: 'tester' });

      const client = new SpotifyClient();
      const result = await client.get<{ display_name: string }>('/me');
      assert.deepEqual(result, { display_name: 'tester' });
      assert.equal(apiCalls().length, 1);
      assert.equal(authHeaderOf(apiCalls()[0]), 'Bearer tok-initial', 'the old token carried the call');
    });

    it('still reports an unreadable READ body as an error, not as a null payload', async () => {
      await seedTokens();
      responder = () => jsonBodyResponse('{"a":');

      const client = new SpotifyClient();
      await assert.rejects(client.get('/albums'), (err: unknown) => {
        assert.ok(err instanceof SpotifyApiError, 'a read has no safe null to fall back to');
        assert.match(err.message, /non-JSON body/);
        return true;
      });
    });

    // -- history: a mutation whose body never parsed must still be in the trail

    // Scoped to the one test that reads the ledger rather than set for the whole
    // block: appendHistory is fire-and-forget, so a per-test unlink of the file
    // races the previous test's in-flight write and surfaces as a spurious
    // "[spotify-mcp] history write failed" line in the suite output.
    const histDir = path.join(tokenDir, 'history-674');
    const ledger = path.join(histDir, 'mutations.jsonl');

    async function withHistory<T>(fn: () => Promise<T>): Promise<T> {
      const savedHistory = process.env.SPOTIFY_MCP_HISTORY;
      const savedHistoryDir = process.env.SPOTIFY_MCP_HISTORY_DIR;
      process.env.SPOTIFY_MCP_HISTORY = '1';
      process.env.SPOTIFY_MCP_HISTORY_DIR = histDir;
      await rm(histDir, { recursive: true, force: true });
      try {
        return await fn();
      } finally {
        if (savedHistory === undefined) delete process.env.SPOTIFY_MCP_HISTORY;
        else process.env.SPOTIFY_MCP_HISTORY = savedHistory;
        if (savedHistoryDir === undefined) delete process.env.SPOTIFY_MCP_HISTORY_DIR;
        else process.env.SPOTIFY_MCP_HISTORY_DIR = savedHistoryDir;
      }
    }

    it('appends a history line for a mutation whose body would not parse', async () => {
      await withHistory(async () => {
        await seedTokens();
        responder = () => jsonBodyResponse('');
        const client = new SpotifyClient();

        assert.equal(await client.post('/me/player/queue', { uri: 'spotify:track:x' }), null);

        // afterMutation appends off the critical path, so poll for the line.
        let lines: string[] = [];
        let guard = 0;
        while (lines.length < 1 && guard++ < 1_000) {
          try {
            const raw = await readFile(ledger, 'utf8');
            lines = raw.split('\n').filter((l) => l.trim().length > 0);
          } catch {
            lines = [];
          }
          if (lines.length < 1) await nextTick();
        }
        assert.equal(lines.length, 1, 'the write is in the audit trail');
        const record = JSON.parse(lines[0]) as { method: string; path: string };
        assert.equal(record.method, 'POST');
        assert.equal(record.path, '/me/player/queue');
      });
    });
  });

  // -------------------------------------------------------------------------
  // 7. getAllPages
  // -------------------------------------------------------------------------

  describe('getAllPages', () => {
    function pagedResponder(itemsPerPage: Map<number, unknown[]>, total: number, limit: number) {
      return (url: string): Response => {
        const params = new URL(url).searchParams;
        const offset = Number(params.get('offset') ?? 0);
        const items = itemsPerPage.get(offset);
        if (!items) throw new Error(`unexpected page offset ${offset} requested`);
        return jsonResponse({ items, total, limit, offset });
      };
    }

    it('walks an offset-paginated endpoint fully', async () => {
      await seedTokens();
      responder = pagedResponder(
        new Map([
          [0, [{ id: 0 }, { id: 1 }]],
          [2, [{ id: 2 }, { id: 3 }]],
          [4, [{ id: 4 }]],
        ]),
        5,
        2,
      );

      const client = new SpotifyClient();
      const all = await client.getAllPages<{ id: number }>('/me/tracks');

      assert.deepEqual(all.map((i) => i.id), [0, 1, 2, 3, 4]);
      const offsets = apiCalls().map((c) => new URL(c.url).searchParams.get('offset'));
      assert.deepEqual(offsets, ['0', '2', '4']);
    });

    it('stops at the explicit maxItems cap and slices the overflow', async () => {
      await seedTokens();
      responder = pagedResponder(
        new Map([
          [0, [{ id: 0 }, { id: 1 }, { id: 2 }]],
          [3, [{ id: 3 }, { id: 4 }, { id: 5 }]],
        ]),
        10,
        3,
      );

      const client = new SpotifyClient();
      const all = await client.getAllPages<{ id: number }>('/me/tracks', {}, { maxItems: 5 });

      assert.equal(all.length, 5);
      assert.deepEqual(all.map((i) => i.id), [0, 1, 2, 3, 4]);
      const offsets = apiCalls().map((c) => new URL(c.url).searchParams.get('offset'));
      assert.deepEqual(offsets, ['0', '3'], 'walk stops once the cap is reached');
    });

    it('applies the configured fetch-all cap when no maxItems option is given', async () => {
      // Default config: DEFAULT_FETCH_ALL_CAP = 500 (SPOTIFY_MCP_FETCH_ALL_CAP unset).
      await seedTokens();
      responder = (url) => {
        const params = new URL(url).searchParams;
        const offset = Number(params.get('offset') ?? 0);
        const items = Array.from({ length: 100 }, (_, i) => ({ id: offset + i }));
        return jsonResponse({ items, total: 100_000, limit: 100, offset });
      };

      const client = new SpotifyClient();
      const all = await client.getAllPages<{ id: number }>('/me/tracks');
      assert.equal(all.length, 500);
      assert.equal(all[499].id, 499);
    });

    it('honours SPOTIFY_MCP_FETCH_ALL_CAP bound through initConfig (#55)', async () => {
      await seedTokens();
      responder = (url) => {
        const params = new URL(url).searchParams;
        const offset = Number(params.get('offset') ?? 0);
        const items = Array.from({ length: 100 }, (_, i) => ({ id: offset + i }));
        return jsonResponse({ items, total: 100_000, limit: 100, offset });
      };

      initConfig({ ...process.env, SPOTIFY_MCP_FETCH_ALL_CAP: '7' });
      try {
        // The cap binds at SpotifyClient construction time from getConfig().
        const client = new SpotifyClient();
        const all = await client.getAllPages<{ id: number }>('/me/tracks');
        assert.equal(all.length, 7);
        assert.equal(all[6].id, 6);
        assert.deepEqual(
          apiCalls().map((c) => new URL(c.url).searchParams.get('offset')),
          ['0'],
          'a single full page covers the cap; no follow-up offset',
        );
      } finally {
        initConfig(); // restore the process-wide snapshot for later tests
      }
    });

    it('breaks cleanly when a page is malformed (items missing)', async () => {
      await seedTokens();
      responder = () => jsonResponse({ total: 10 }); // no items array

      const client = new SpotifyClient();
      const all = await client.getAllPages('/me/tracks');
      assert.deepEqual(all, []);
      assert.equal(apiCalls().length, 1, 'no follow-up page requested after a malformed page');
    });

    it('returns what it gathered so far when a later page is malformed', async () => {
      await seedTokens();
      responder = (url) => {
        const offset = new URL(url).searchParams.get('offset');
        if (offset === '0') {
          return jsonResponse({ items: [{ id: 0 }], total: 10, limit: 1, offset: 0 });
        }
        return jsonResponse({ total: 10, limit: 1, offset: 1 }); // items vanished
      };

      const client = new SpotifyClient();
      const all = await client.getAllPages<{ id: number }>('/me/tracks');
      assert.deepEqual(all, [{ id: 0 }]);
      assert.equal(apiCalls().length, 2);
    });

    // #864: `getAllPages` returns a bare T[], so a caller that must REPORT
    // truncation uses `getAllPagesWithTruncation`. These pin WHEN the verdict
    // is allowed to fire, and that it belongs to the walk that produced it.

    it('reports truncated when the cap leaves rows behind', async () => {
      await seedTokens();
      responder = (url) => {
        const offset = Number(new URL(url).searchParams.get('offset') ?? 0);
        const items = Array.from({ length: 100 }, (_, i) => ({ id: offset + i }));
        return jsonResponse({ items, total: 1_204, limit: 100, offset });
      };

      const client = new SpotifyClient();
      const walk = await client.getAllPagesWithTruncation<{ id: number }>(
        '/me/tracks',
        {},
        { maxItems: 500 },
      );

      assert.equal(walk.items.length, 500);
      assert.equal(walk.truncated, true, '1204 rows behind a 500 cap is a truncation');
    });

    it('reports not truncated when the cap lands exactly on the reported total', async () => {
      await seedTokens();
      responder = (url) => {
        const offset = Number(new URL(url).searchParams.get('offset') ?? 0);
        return jsonResponse({
          items: Array.from({ length: 5 }, (_, i) => ({ id: offset + i })),
          total: 5,
          limit: 5,
          offset,
        });
      };

      const client = new SpotifyClient();
      const walk = await client.getAllPagesWithTruncation<{ id: number }>(
        '/me/tracks',
        {},
        { maxItems: 5 },
      );

      assert.equal(walk.items.length, 5);
      assert.equal(
        walk.truncated,
        false,
        'the walk reached the server-reported total, so the cap cut nothing off',
      );
    });

    it('reports conservatively when the endpoint reports no total', async () => {
      await seedTokens();
      responder = (url) => {
        const offset = Number(new URL(url).searchParams.get('offset') ?? 0);
        // No `total` key at all — nothing to prove completeness against.
        return jsonResponse({ items: Array.from({ length: 5 }, (_, i) => ({ id: offset + i })), limit: 5, offset });
      };

      const client = new SpotifyClient();
      const walk = await client.getAllPagesWithTruncation<{ id: number }>(
        '/me/tracks',
        {},
        { maxItems: 5 },
      );

      assert.equal(walk.truncated, true);
    });

    it('reports a complete walk as complete after a truncated one', async () => {
      await seedTokens();
      responder = (url) => {
        const offset = Number(new URL(url).searchParams.get('offset') ?? 0);
        const size = offset === 0 ? 100 : 10;
        return jsonResponse({
          items: Array.from({ length: size }, (_, i) => ({ id: offset + i })),
          total: 110,
          limit: 100,
          offset,
        });
      };

      const client = new SpotifyClient();
      const capped = await client.getAllPagesWithTruncation<{ id: number }>(
        '/me/tracks',
        {},
        { maxItems: 50 },
      );
      assert.equal(capped.truncated, true, 'precondition: first walk was cut short');

      const complete = await client.getAllPagesWithTruncation<{ id: number }>(
        '/me/tracks',
        {},
        { maxItems: 500 },
      );
      assert.equal(complete.items.length, 110);
      assert.equal(
        complete.truncated,
        false,
        'a walk that read everything must not inherit the previous walk verdict',
      );
    });

    // #718: the verdict and the cause are separate answers, and a caller that
    // has to write "truncated at SPOTIFY_MCP_FETCH_ALL_CAP" needs to know the
    // cap is WHY. A walk that ends on a short page while the server's own
    // `total` still counts more rows is the case that separates them: rows are
    // missing, and the cap never bound the walk.
    it('reports rows missing without blaming the cap when a short page undercounts the total', async () => {
      await seedTokens();
      responder = (url) => {
        const offset = Number(new URL(url).searchParams.get('offset') ?? 0);
        const size = offset === 0 ? 50 : 2;
        return jsonResponse({
          items: Array.from({ length: size }, (_, i) => ({ id: offset + i })),
          total: 500,
          limit: 50,
          offset,
        });
      };

      const client = new SpotifyClient();
      const walk = await client.getAllPagesWithTruncation<{ id: number }>(
        '/me/tracks',
        {},
        { maxItems: 500 },
      );

      assert.equal(walk.items.length, 52, 'precondition: the walk stopped on a short page');
      assert.equal(walk.truncated, true, '52 collected against a reported 500 is not a complete read');
      assert.equal(walk.truncatedByCap, false, 'a 500 cap never bound a 52-row walk');
      assert.equal(walk.reportedTotal, 500, "the server's own count travels with the verdict");
    });

    it('attributes a cap-stopped walk to the cap and carries the reported total', async () => {
      await seedTokens();
      responder = (url) => {
        const offset = Number(new URL(url).searchParams.get('offset') ?? 0);
        const items = Array.from({ length: 100 }, (_, i) => ({ id: offset + i }));
        return jsonResponse({ items, total: 1_204, limit: 100, offset });
      };

      const client = new SpotifyClient();
      const walk = await client.getAllPagesWithTruncation<{ id: number }>(
        '/me/tracks',
        {},
        { maxItems: 500 },
      );

      assert.equal(walk.truncatedByCap, true, 'the cap is what ended this walk');
      assert.equal(walk.reportedTotal, 1_204, 'and the total the server reported is not lost');
    });

    // #899: a composite read costs requests, not just rows. `pages` is what
    // lets a tool report that cost, so it is counted where the request fires
    // rather than derived from the row total — a walk that ends on a short
    // page, or one whose last GET returns nothing, spends a request the row
    // count cannot see.

    it('counts the requests a capped walk actually issued', async () => {
      await seedTokens();
      responder = (url) => {
        const offset = Number(new URL(url).searchParams.get('offset') ?? 0);
        const items = Array.from({ length: 100 }, (_, i) => ({ id: offset + i }));
        return jsonResponse({ items, total: 1_204, limit: 100, offset });
      };

      const client = new SpotifyClient();
      const before = apiCalls().length;
      const walk = await client.getAllPagesWithTruncation<{ id: number }>(
        '/me/tracks',
        {},
        { maxItems: 500 },
      );
      const spent = apiCalls().length - before;

      // 5 full 100-row pages reach the 500 cap, then the cap ends the walk.
      assert.equal(walk.pages, spent, 'pages must equal the GETs the walk issued');
      assert.equal(walk.pages, 5);
      assert.ok(walk.pages < walk.items.length / 100 + 2, 'sanity: pages tracks requests, not rows');
    });

    it('counts the final request of a walk that ends on a short page', async () => {
      await seedTokens();
      responder = (url) => {
        const offset = Number(new URL(url).searchParams.get('offset') ?? 0);
        if (offset > 0) return jsonResponse({ items: [], total: 150, limit: 100, offset });
        return jsonResponse({
          items: Array.from({ length: 100 }, (_, i) => ({ id: i })),
          total: 150,
          limit: 100,
          offset,
        });
      };

      const client = new SpotifyClient();
      const before = apiCalls().length;
      const walk = await client.getAllPagesWithTruncation<{ id: number }>(
        '/me/tracks',
        {},
        { maxItems: 500 },
      );
      const spent = apiCalls().length - before;

      // A short page that yields nothing is still a request spent.
      assert.equal(walk.pages, spent);
      assert.ok(spent >= 2, 'the walk really did issue more than one request');
    });

    it('reports an unknown total as null, never the walked count', async () => {
      await seedTokens();
      responder = (url) => {
        const offset = Number(new URL(url).searchParams.get('offset') ?? 0);
        // No `total` key at all: the walk can say nothing about the size.
        return jsonResponse({ items: Array.from({ length: 5 }, (_, i) => ({ id: offset + i })), limit: 5, offset });
      };

      const client = new SpotifyClient();
      const walk = await client.getAllPagesWithTruncation<{ id: number }>(
        '/me/tracks',
        {},
        { maxItems: 5 },
      );

      assert.equal(walk.truncated, true);
      assert.equal(
        walk.reportedTotal,
        null,
        'a total nobody reported must stay null rather than become the 5 rows walked',
      );
    });

    it('leaves reportedTotal null on a short-page walk that reported no total', async () => {
      // The end-of-data branch, with no `total` anywhere: there is nothing to
      // reconcile against, so the walk reports unknown rather than passing the
      // rows it collected off as the size of the collection.
      await seedTokens();
      responder = (url) => {
        const offset = Number(new URL(url).searchParams.get('offset') ?? 0);
        const size = offset === 0 ? 50 : 3;
        return jsonResponse({
          items: Array.from({ length: size }, (_, i) => ({ id: offset + i })),
          limit: 50,
          offset,
        });
      };

      const client = new SpotifyClient();
      const walk = await client.getAllPagesWithTruncation<{ id: number }>(
        '/me/tracks',
        {},
        { maxItems: 500 },
      );

      assert.equal(walk.items.length, 53, 'precondition: the walk ended on a short page');
      assert.equal(walk.truncated, false, 'with no total reported, a short page is the end of the data');
      assert.equal(walk.truncatedByCap, false);
      assert.equal(
        walk.reportedTotal,
        null,
        'a total nobody reported must stay null rather than become the 53 rows walked',
      );
    });

    // The MCP SDK dispatches `tools/call` without awaiting — protocol.js fires
    // `_onrequest` straight from the transport's onmessage — so two overlapping
    // calls interleave their awaits on ONE shared client. A verdict stored on
    // the instance would then answer with whichever walk finished last, in
    // both directions. Driven through the real client's request queue with
    // only `fetch` stubbed.
    it('gives each overlapping walk its own verdict, in both directions', async () => {
      await seedTokens();
      // /small reads 200 rows behind a 500 cap (complete); /big reports 600
      // and dies at 500 (truncated). Both walks are started before either is
      // awaited, so their page fetches land in each other's await gaps.
      responder = (url) => {
        const parsed = new URL(url);
        const offset = Number(parsed.searchParams.get('offset') ?? 0);
        // BASE_URL is https://api.spotify.com/v1, so the walk path is the tail.
        const total = parsed.pathname.endsWith('/big') ? 600 : 200;
        const items = Array.from({ length: 100 }, (_, i) => ({ id: offset + i }));
        return jsonResponse({ items, total, limit: 100, offset });
      };

      const client = new SpotifyClient();
      const smallWalk = client.getAllPagesWithTruncation<{ id: number }>(
        '/small',
        {},
        { maxItems: 500 },
      );
      const bigWalk = client.getAllPagesWithTruncation<{ id: number }>(
        '/big',
        {},
        { maxItems: 500 },
      );
      const [small, big] = await Promise.all([smallWalk, bigWalk]);

      assert.equal(small.items.length, 200);
      assert.equal(
        small.truncated,
        false,
        'a 200-row walk behind a 500 cap is complete; the interleaved capped walk must not flip it',
      );
      assert.equal(big.items.length, 500);
      assert.equal(
        big.truncated,
        true,
        '600 rows behind a 500 cap is truncated; the interleaved complete walk must not clear it',
      );
    });
  });

  // -------------------------------------------------------------------------
  // 8. Queue serialization
  // -------------------------------------------------------------------------

  describe('request queue serialization', () => {
    it('dispatches overlapping calls strictly sequentially', async () => {
      await seedTokens();

      // Record the exact moment each request was dispatched to fetch.
      const dispatchLog: Array<{ url: string; at: number }> = [];
      responder = (url) => {
        dispatchLog.push({ url, at: Date.now() });
        const deadline = Date.now() + 5; // simulate ~5ms of server-side work
        while (Date.now() < deadline) {
          /* busy-wait */
        }
        return jsonResponse({ url });
      };

      const client = new SpotifyClient();
      const [a, b, c] = await Promise.all([
        client.get<{ url: string }>('/alpha'),
        client.get<{ url: string }>('/beta'),
        client.get<{ url: string }>('/gamma'),
      ]);
      assert.deepEqual([a!.url, b!.url, c!.url], [
        apiUrl('/alpha'),
        apiUrl('/beta'),
        apiUrl('/gamma'),
      ]);

      // Dispatch order follows call order...
      assert.deepEqual(
        dispatchLog.map((d) => d.url),
        [apiUrl('/alpha'), apiUrl('/beta'), apiUrl('/gamma')],
      );

      // ...and dispatches never overlap: the queue enforces an inter-request
      // gap (100ms), so each dispatch happens well after the previous one.
      for (let i = 1; i < dispatchLog.length; i++) {
        assert.ok(
          dispatchLog[i].at - dispatchLog[i - 1].at >= 50,
          `dispatch ${i} must start after dispatch ${i - 1} completes`,
        );
      }
    });

    it('lets a later caller proceed after an earlier one rejects', async () => {
      await seedTokens();
      responder = (url) => {
        if (new URL(url).pathname.endsWith('/boom')) {
          return jsonResponse({ error: { message: 'boom' } }, 500);
        }
        return jsonResponse({ url });
      };

      const client = new SpotifyClient();
      const results = await Promise.allSettled([client.get('/boom'), client.get('/fine')]);
      assert.equal(results[0].status, 'rejected');
      assert.equal(results[1].status, 'fulfilled', 'failure did not poison the queue');
      assert.equal(apiCalls().length, 2);
    });
  });
  // -------------------------------------------------------------------------
  // 9. getAllPages progress reporting (#65)
  // -------------------------------------------------------------------------

  describe('getAllPages progress reporting', () => {
    it('emits one PageProgress event per page with a shared walkId', async () => {
      await seedTokens();
      responder = (url) => {
        const offset = Number(new URL(url).searchParams.get('offset') ?? 0);
        return jsonResponse({ items: [{ id: offset }], total: 3, limit: 1, offset });
      };

      const events: RecordedProgress[] = [];
      const client = new SpotifyClient();
      client.setProgressReporter((info) => events.push({ ...info }));

      await client.getAllPages<{ id: number }>('/me/tracks');

      assert.equal(events.length, 3, 'one event per fetched page');
      assert.ok(events.every((e) => e.walkId === events[0].walkId), 'one walkId across the walk');
      assert.deepEqual(events.map((e) => e.page), [1, 2, 3]);
      assert.deepEqual(events.map((e) => e.fetched), [1, 2, 3]);
      assert.ok(events.every((e) => e.total === 3), 'server-reported total is forwarded');
    });

    it('uses fresh monotonic walkIds for successive walks on one client', async () => {
      await seedTokens();
      responder = () => jsonResponse({ items: [{ id: 0 }], total: 1, limit: 1, offset: 0 });

      const events: RecordedProgress[] = [];
      const client = new SpotifyClient();
      client.setProgressReporter((info) => events.push({ ...info }));

      await client.getAllPages('/me/tracks');
      await client.getAllPages('/me/tracks');

      assert.equal(events.length, 2);
      assert.ok(events[1].walkId > events[0].walkId, 'walkIds increase monotonically');
    });

    it('a throwing reporter never breaks the walk', async () => {
      await seedTokens();
      responder = (url) => {
        const offset = Number(new URL(url).searchParams.get('offset') ?? 0);
        return jsonResponse({ items: [{ id: offset }], total: 2, limit: 1, offset });
      };

      const client = new SpotifyClient();
      client.setProgressReporter(() => {
        throw new Error('reporter exploded');
      });

      const all = await client.getAllPages<{ id: number }>('/me/tracks');
      assert.deepEqual(all.map((i) => i.id), [0, 1], 'walk completed despite reporter throw');
    });

    it('works with no reporter installed (default null)', async () => {
      await seedTokens();
      responder = () => jsonResponse({ items: [{ id: 0 }], total: 1, limit: 1, offset: 0 });

      const client = new SpotifyClient();
      const all = await client.getAllPages('/me/tracks');
      assert.deepEqual(all, [{ id: 0 }]);
    });
  });

  // -------------------------------------------------------------------------
  // 10. The per-call onPage hook (#902)
  // -------------------------------------------------------------------------

  // The hook is the PRODUCTION half of #902's `requests_read`: a tool counts
  // the pages its own walk spent. The playlistops tests exercise a STUB client
  // that re-implements this walk, so they cannot fail if the hook here stops
  // firing — these drive the real SpotifyClient, which is the only place the
  // contract is actually implemented.

  describe('getAllPages per-call onPage hook (#902)', () => {
    it('calls onPage once per fetched page, with the same event the reporter gets', async () => {
      await seedTokens();
      responder = (url) => {
        const offset = Number(new URL(url).searchParams.get('offset') ?? 0);
        return jsonResponse({ items: [{ id: offset }], total: 3, limit: 1, offset });
      };

      const reported: RecordedProgress[] = [];
      const hooked: RecordedProgress[] = [];
      const client = new SpotifyClient();
      client.setProgressReporter((info) => reported.push({ ...info }));

      await client.getAllPages<{ id: number }>('/me/tracks', {}, {
        onPage: (info) => hooked.push({ ...info }),
      });

      assert.equal(hooked.length, 3, 'one call per fetched page — the page count requests_read reports');
      assert.deepEqual(hooked, reported, 'the hook and the global reporter see the same event');
    });

    it('counts the pages a CAPPED walk actually spent, not the pages the cap implies', async () => {
      await seedTokens();
      responder = (url) => {
        const offset = Number(new URL(url).searchParams.get('offset') ?? 0);
        return jsonResponse({ items: [{ id: offset }], total: 100, limit: 1, offset });
      };

      let requests = 0;
      const client = new SpotifyClient();
      // cap+1 is the shape merge_playlists uses: the walk stops the moment it
      // holds cap+1 rows, so it spends 6 pages to prove the 7th was clipped.
      await client.getAllPages<{ id: number }>('/me/tracks', {}, {
        maxItems: 6,
        onPage: () => { requests++; },
      });

      assert.equal(requests, 6, 'measured pages, not the 100 the server reports');
      assert.equal(apiCalls().length, requests, 'the count matches the requests actually sent');
    });

    it('is per-call: a second walk on one client starts its own count', async () => {
      await seedTokens();
      responder = (url) => {
        const offset = Number(new URL(url).searchParams.get('offset') ?? 0);
        return jsonResponse({ items: [{ id: offset }], total: 2, limit: 1, offset });
      };

      const client = new SpotifyClient();
      const counts: number[] = [];
      for (const _ of [0, 1]) {
        let n = 0;
        await client.getAllPages('/me/tracks', {}, { onPage: () => { n++; } });
        counts.push(n);
      }

      // The reason this is an argument and not client state: concurrent walks
      // share one client, and a stored counter would report whichever walk
      // finished last.
      assert.deepEqual(counts, [2, 2], 'each walk counts its own pages; neither inherits the other');
    });

    it('a throwing onPage hook never breaks the walk', async () => {
      await seedTokens();
      responder = (url) => {
        const offset = Number(new URL(url).searchParams.get('offset') ?? 0);
        return jsonResponse({ items: [{ id: offset }], total: 2, limit: 1, offset });
      };

      const client = new SpotifyClient();
      const all = await client.getAllPages<{ id: number }>('/me/tracks', {}, {
        onPage: () => { throw new Error('hook exploded'); },
      });

      assert.deepEqual(all.map((i) => i.id), [0, 1], 'walk completed despite hook throw');
    });

    it('a walk with no onPage hook still completes (the hook is optional)', async () => {
      await seedTokens();
      responder = (url) => {
        const offset = Number(new URL(url).searchParams.get('offset') ?? 0);
        return jsonResponse({ items: [{ id: offset }], total: 2, limit: 1, offset });
      };

      const client = new SpotifyClient();
      const all = await client.getAllPages<{ id: number }>('/me/tracks', {}, { maxItems: 10 });
      assert.deepEqual(all.map((i) => i.id), [0, 1]);
    });
  });
});

describe('lane aging selection (#133)', () => {
  it('promotes an aged LOW task ahead of queued NORMAL tasks', () => {
    const mk = (name: string, enqueuedAt: number) => ({
      run: async () => name,
      resolve: () => {},
      reject: () => {},
      enqueuedAt,
      // Carried by LaneTask since #892 (the scheduler owns the retry budget and
      // the lane a throttled attempt is re-queued onto). This selection is pure
      // over `enqueuedAt`, so neither is read here — they are present only to
      // satisfy the shape.
      attempts: 0,
      priority: 'normal' as const,
    });
    const now = 1_000_000;
    const n1 = mk('n1', now), n2 = mk('n2', now);
    const oldTask = mk('old', now - 16_000), newTask = mk('new', now - 100);
    const normal = [n1, n2];
    const low = [oldTask, newTask];

    // Aged LOW is promoted ahead of queued NORMAL tasks.
    const agedPick = selectNextLaneTask(normal, low, now, 15_000);
    assert.equal(agedPick, oldTask);
    assert.deepEqual(normal, [n1, n2]);
    assert.deepEqual(low, [newTask]);

    // Without aging, NORMAL wins and the fresh LOW task stays queued.
    const freshPick = selectNextLaneTask([n1], [newTask], now, 15_000);
    assert.equal(freshPick, n1);
  });

  it('keeps NORMAL priority while no LOW task has aged past the threshold', () => {
    const mk = (name: string, enqueuedAt: number) => ({
      run: async () => name,
      resolve: () => {},
      reject: () => {},
      enqueuedAt,
      // Carried by LaneTask since #892 (the scheduler owns the retry budget and
      // the lane a throttled attempt is re-queued onto). This selection is pure
      // over `enqueuedAt`, so neither is read here — they are present only to
      // satisfy the shape.
      attempts: 0,
      priority: 'normal' as const,
    });
    const now = 1_000_000;
    const n1 = mk('n1', now);
    const fresh = mk('fresh', now - 1_000);
    const normal = [n1];
    const low = [fresh];

    const picked = selectNextLaneTask(normal, low, now, 15_000);
    assert.equal(picked, n1);
    assert.equal(low.length, 1);
  });
});
