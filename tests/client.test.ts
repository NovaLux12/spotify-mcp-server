/**
 * Tests for src/client.ts (SpotifyClient, SpotifyApiError) and the TOKEN_FILE
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
 *   - getAllPages: full walk, explicit maxItems cap, configured fetch-all
 *     cap (SPOTIFY_MCP_FETCH_ALL_CAP via initConfig), malformed-page break,
 *     per-page progress events (#65).
 *   - Queue serialization: overlapping calls dispatch sequentially.
 *
 * Run with: node --import tsx --test tests/client.test.ts
 *
 * NOTE: TOKEN_FILE is resolved at module-load time inside src/auth.ts, so the
 * env vars MUST be set before the dynamic import below. Tokens are only ever
 * written under os.tmpdir().
 */

import { describe, it, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

// ---------------------------------------------------------------------------
// Env setup MUST precede importing src modules (TOKEN_FILE binds at load time)
// ---------------------------------------------------------------------------

const tokenDir = await mkdtemp(path.join(tmpdir(), 'spotify-mcp-client-test-'));
process.env.SPOTIFY_MCP_TOKEN_FILE = path.join(tokenDir, 'tokens.json');
process.env.SPOTIFY_CLIENT_ID = 'test-client-id';

const { SpotifyClient, SpotifyApiError } = await import('../src/client.ts');
const { TOKEN_FILE } = await import('../src/auth.ts');
const { initConfig } = await import('../src/config.ts');

// Guard the isolation contract: if TOKEN_FILE ever resolved outside tmpdir
// (e.g. a static import racing ahead of the env var), fail loudly instead of
// touching ~/.spotify-mcp/tokens.json.
describe('TOKEN_FILE contract', () => {
  it('resolves inside os.tmpdir(), never the real ~/.spotify-mcp home', () => {
    assert.ok(
      TOKEN_FILE.startsWith(tmpdir()),
      `TOKEN_FILE must live under ${tmpdir()}, got: ${TOKEN_FILE}`,
    );
    assert.ok(!TOKEN_FILE.includes('.spotify-mcp'), 'must not target the default token path');
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
  await writeFile(TOKEN_FILE, JSON.stringify(tokens), 'utf8');
}

describe('SpotifyClient', () => {
  beforeEach(async () => {
    calls = [];
    responder = () => jsonResponse({});
    // Never touch anything outside tmpdir; start each test from a clean slate.
    await rm(TOKEN_FILE, { force: true });
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
      const persisted = JSON.parse(await readFile(TOKEN_FILE, 'utf8')) as {
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
        assert.equal(err.status, 400);
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
      assert.equal(timer.delays[0], 1000, 'Retry-After=1s honoured');
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
      assert.equal(timer.delays[0], 1000, 'default backoff is 1s');
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

    it('falls back to the generic 503 message when the body is unparseable', async () => {
      await seedTokens();
      responder = () => new Response('Gateway fell over', { status: 503 });

      const client = new SpotifyClient();
      await assert.rejects(client.get('/me'), (err: unknown) => {
        assert.ok(err instanceof SpotifyApiError);
        assert.equal(err.status, 503);
        assert.equal(
          err.message,
          'Spotify service is temporarily unavailable — try again shortly',
        );
        return true;
      });
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
    interface RecordedProgress {
      walkId: number;
      page: number;
      fetched: number;
      total?: number;
    }

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
});
