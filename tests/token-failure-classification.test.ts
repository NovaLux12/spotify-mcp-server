/**
 * #677: token-endpoint failures are classified by what actually happened.
 *
 * Before the fix, every failure that was not `invalid_grant` — a refused client
 * id, a wrong redirect_uri, a dead refresh token, an unreachable network, a
 * 429, a 5xx — collapsed into one "Spotify token service temporarily
 * unavailable" string. An operator with a misconfigured SPOTIFY_CLIENT_ID was
 * told to wait and retry, which no retry can fix, and an agent fed that string
 * retries in a loop.
 *
 * The contract these tests pin, in the order the issue states it:
 *
 *   1. A 4xx carries a machine-readable `error` code. Read it, classify by it.
 *   2. A network-layer failure has NO body. Classify it from the thrown
 *      error's own shape, and never merge it with the response-borne classes.
 *   3. A 5xx is transient and rides out a still-valid access token.
 *   4. A 429 keeps its own status and carries `Retry-After` as `retryAfterSec`.
 *   5. A failure with no evidence is reported as UNCLASSIFIED. Never mapped to
 *      the nearest plausible-looking category — an unclassified error is a true
 *      statement; a misclassified one sends someone down the wrong path.
 *   6. Every token-failure message names the token file, so a multi-profile
 *      install can tell which install is broken.
 *
 * NOTE: TOKEN_FILE is resolved at module-load time inside src/auth.ts, so the
 * env vars MUST be set before the dynamic import below. Tokens are only ever
 * written under os.tmpdir().
 *
 * Run with: node --import tsx --test tests/token-failure-classification.test.ts
 */

import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

const tokenDir = await mkdtemp(path.join(tmpdir(), 'spotify-mcp-token-class-'));
process.env.SPOTIFY_MCP_TOKEN_FILE = path.join(tokenDir, 'tokens.json');
process.env.SPOTIFY_CLIENT_ID = 'test-client-id';

const { SpotifyClient, SpotifyApiError, isTokenFailureReason } = await import('../src/client.ts');
const { TOKEN_FILE } = await import('../src/auth.ts');
const { installToolErrorBoundary } = await import('../src/tools/annotations.ts');
const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
const { InMemoryTransport } = await import('@modelcontextprotocol/sdk/inMemory.js');
const { McpServer } = await import('@modelcontextprotocol/sdk/server/mcp.js');

const realFetch = globalThis.fetch;
const originalConsoleError = console.error;
console.error = () => {};

interface FetchCall {
  url: string;
  init: RequestInit;
}

let calls: FetchCall[] = [];
/** What the token endpoint does: a Response, or a throw (a transport failure). */
let tokenEndpoint: (url: string, init: RequestInit) => Response | Promise<Response>;

/** Everything the client knows about one refresh failure. */
interface Classified {
  status: number;
  reason: string | undefined;
  message: string;
  retryAfterSec: number | undefined;
}

function jsonResponse(body: unknown, status = 200, headers?: Record<string, string>): Response {
  return new Response(JSON.stringify(body), { status, headers });
}

function apiCalls(): FetchCall[] {
  return calls.filter((c) => !c.url.startsWith('https://accounts.spotify.com/'));
}

function tokenCalls(): FetchCall[] {
  return calls.filter((c) => c.url.startsWith('https://accounts.spotify.com/'));
}

/**
 * Seed a token file. `expires_at` defaults to already-expired so the pre-request
 * refresh fires; tests about riding out a transient failure pass a future one.
 */
async function seedTokens(expiresAt = Date.now() - 1000): Promise<void> {
  await writeFile(
    TOKEN_FILE,
    JSON.stringify({
      access_token: 'tok-initial',
      refresh_token: 'ref-initial',
      expires_at: expiresAt,
    }),
    'utf8',
  );
}

/**
 * Drive a real `client.get('/me')` and capture the classified failure it threw.
 * `random: () => 0` pins the backoff jitter so a retrying refresh spends a
 * predictable 250ms + 500ms instead of a random slice.
 */
async function captureRefreshFailure(): Promise<Classified> {
  const client = new SpotifyClient({ disableCache: true, random: () => 0 });
  try {
    await client.get('/me');
  } catch (err) {
    assert.ok(err instanceof SpotifyApiError, `expected a SpotifyApiError, got ${String(err)}`);
    return {
      status: err.status,
      reason: err.reason,
      message: err.message,
      retryAfterSec: err.retryAfterSec,
    };
  }
  throw new assert.AssertionError({ message: 'the refresh was expected to fail, but it succeeded' });
}

/** Assert the failure names the token file, as issue item 2 requires. */
function assertNamesTokenFile(message: string): void {
  assert.ok(
    message.includes(TOKEN_FILE),
    `token-failure message must name the token file for multi-profile installs; got: ${message}`,
  );
}

/** Assert the message does not claim a Spotify outage it has no evidence for. */
function assertNotAnOutageClaim(message: string): void {
  assert.doesNotMatch(
    message,
    /temporarily unavailable/i,
    `a non-5xx token failure must not be reported as a service outage; got: ${message}`,
  );
}

beforeEach(async () => {
  calls = [];
  tokenEndpoint = () => jsonResponse({ error: 'invalid_grant' }, 400);
  await rm(TOKEN_FILE, { force: true });
  globalThis.fetch = (async (url: unknown, init: RequestInit) => {
    const call: FetchCall = { url: String(url), init };
    calls.push(call);
    if (call.url.startsWith('https://accounts.spotify.com/')) return tokenEndpoint(call.url, call.init);
    return jsonResponse({ ok: true });
  }) as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = realFetch;
  console.error = originalConsoleError;
});

// ---------------------------------------------------------------------------
// 1. A 4xx with a machine-readable body is classified by the code it carries
// ---------------------------------------------------------------------------

describe('token-endpoint 4xx classification (#677)', () => {
  it('names SPOTIFY_CLIENT_ID when the body says invalid_client', async () => {
    await seedTokens();
    tokenEndpoint = () => jsonResponse({ error: 'invalid_client' }, 400);

    const failure = await captureRefreshFailure();

    assert.equal(failure.reason, 'TOKEN_INVALID_CLIENT');
    assert.match(failure.message, /SPOTIFY_CLIENT_ID/);
    assert.match(failure.message, /Developer Dashboard/);
    // 401, not the endpoint's 400: this call passed no tool arguments, and
    // publicFailure maps 400 to "invalid arguments" (#1007).
    assert.equal(failure.status, 401);
    assertNamesTokenFile(failure.message);
    assertNotAnOutageClaim(failure.message);
    assert.equal(apiCalls().length, 0, 'no API call after a refused client id');
  });

  it('keeps the re-auth message for invalid_grant', async () => {
    await seedTokens();
    tokenEndpoint = () => jsonResponse({ error: 'invalid_grant' }, 400);

    const failure = await captureRefreshFailure();

    assert.equal(failure.reason, 'TOKEN_INVALID_GRANT');
    assert.match(failure.message, /re-run "spotify-mcp auth"/);
    assert.equal(failure.status, 401);
    assertNamesTokenFile(failure.message);
  });

  it('quotes a named code it has no fix for, rather than guessing a cause', async () => {
    await seedTokens();
    tokenEndpoint = () => jsonResponse({ error: 'invalid_request' }, 400);

    const failure = await captureRefreshFailure();

    assert.equal(failure.reason, 'TOKEN_REQUEST_REJECTED');
    assert.match(failure.message, /invalid_request/);
    // The code was reported, not folded into the two codes that do have fixes.
    assert.doesNotMatch(failure.message, /invalid_client|invalid_grant/);
    assert.doesNotMatch(failure.message, /SPOTIFY_CLIENT_ID/);
    assertNamesTokenFile(failure.message);
  });

  it('does not read the Web API error object as a grant code', async () => {
    // `{"error": {...}}` is the Web API's shape, not the token endpoint's
    // `{"error": "code"}`. Its message is prose about an API call; reading it
    // as a grant code would invent a classification.
    await seedTokens();
    tokenEndpoint = () => jsonResponse({ error: { status: 400, message: 'invalid_client is bad' } }, 400);

    const failure = await captureRefreshFailure();

    assert.equal(failure.reason, 'TOKEN_UNCLASSIFIED');
    assert.doesNotMatch(failure.message, /SPOTIFY_CLIENT_ID/);
    assertNotAnOutageClaim(failure.message);
  });
});

// ---------------------------------------------------------------------------
// 2. A 429 keeps its status and its Retry-After
// ---------------------------------------------------------------------------

describe('token-endpoint 429 (#677)', () => {
  it('parses Retry-After into retryAfterSec instead of an outage with no wait', async () => {
    await seedTokens();
    tokenEndpoint = () => new Response(JSON.stringify({ error: 'temporarily_unavailable' }), {
      status: 429,
      headers: { 'Content-Type': 'application/json', 'Retry-After': '30' },
    });

    const failure = await captureRefreshFailure();

    assert.equal(failure.retryAfterSec, 30);
    assert.equal(failure.status, 429);
    assert.equal(failure.reason, 'TOKEN_RATE_LIMITED');
    assert.match(failure.message, /rate limited/i);
    assert.match(failure.message, /30s/);
    assertNamesTokenFile(failure.message);
    // A rate limit is not retried here: the wait belongs in the error, not in a
    // serialized queue, and re-sending sooner is what prolongs the limit.
    assert.equal(tokenCalls().length, 1, 'a 429 must not be retried inside the refresh');
  });

  it('says so when the 429 sent no Retry-After rather than inventing a wait', async () => {
    await seedTokens();
    tokenEndpoint = () => jsonResponse({ error: 'too_many' }, 429);

    const failure = await captureRefreshFailure();

    assert.equal(failure.reason, 'TOKEN_RATE_LIMITED');
    assert.match(failure.message, /absent/);
    assertNamesTokenFile(failure.message);
  });
});

// ---------------------------------------------------------------------------
// 3. A 5xx is transient, rides out a valid token, and is bounded when it isn't
// ---------------------------------------------------------------------------

describe('token-endpoint 5xx (#677)', () => {
  it('rides out a 5xx on a still-valid access token', async () => {
    // Inside the 60s pre-request refresh window, but the access token itself
    // has not expired: the request must proceed rather than fail.
    await seedTokens(Date.now() + 30_000);
    tokenEndpoint = () => jsonResponse({ error: 'server_error' }, 503);

    const client = new SpotifyClient({ disableCache: true });
    const result = await client.get<{ ok: boolean }>('/me');

    assert.deepEqual(result, { ok: true });
    assert.equal(apiCalls().length, 1);
    assert.equal(
      (apiCalls()[0].init.headers as Record<string, string>).Authorization,
      'Bearer tok-initial',
      'the old access token rode it out',
    );
  });

  it('reports a 5xx with no valid token as a Spotify-side server error', async () => {
    await seedTokens();
    tokenEndpoint = () => jsonResponse({ error: 'server_error' }, 503);

    const failure = await captureRefreshFailure();

    assert.equal(failure.reason, 'TOKEN_SERVER_ERROR');
    assert.equal(failure.status, 503, 'a genuine 5xx is the one failure entitled to an availability status');
    assert.match(failure.message, /HTTP 503/);
    assert.match(failure.message, /server-side failure at Spotify/);
    assertNamesTokenFile(failure.message);
  });

  it('bounds a 5xx refresh to the shared attempt budget', async () => {
    // A 5xx is retried, but on the same MAX_ATTEMPTS budget the API path uses:
    // an unbounded retry against a permanently unhealthy Spotify is its own
    // outage.
    await seedTokens();
    tokenEndpoint = () => jsonResponse({ error: 'server_error' }, 500);

    const failure = await captureRefreshFailure();

    assert.equal(failure.reason, 'TOKEN_SERVER_ERROR');
    assert.match(failure.message, /HTTP 500/);
    assert.equal(tokenCalls().length, 3, 'exactly MAX_ATTEMPTS dispatches, then the failure surfaces');
  });
});

// ---------------------------------------------------------------------------
// 4. A network-layer failure has no body and is classified from the throw
// ---------------------------------------------------------------------------

describe('token-endpoint transport failure (#677)', () => {
  it('names the cause from the thrown error and never calls it a Spotify outage', async () => {
    await seedTokens();
    // undici nests the real syscall failure under `Error: fetch failed`.
    tokenEndpoint = () => {
      const err = new TypeError('fetch failed');
      (err as { cause?: unknown }).cause = Object.assign(new Error('getaddrinfo ENOTFOUND accounts.spotify.com'), {
        code: 'ENOTFOUND',
      });
      throw err;
    };

    const failure = await captureRefreshFailure();

    assert.equal(failure.reason, 'TOKEN_NETWORK_UNREACHABLE');
    assert.match(failure.message, /ENOTFOUND/, 'the cause the error actually carried is reported');
    assert.match(failure.message, /no HTTP response was received/);
    assert.match(failure.message, /not a Spotify outage/);
    // The decisive one: no response arrived, so nothing here is a 5xx and the
    // outage wording is not available to it.
    assertNotAnOutageClaim(failure.message);
    assertNamesTokenFile(failure.message);
  });

  it('reads a cause off an AggregateError chain', async () => {
    await seedTokens();
    tokenEndpoint = () => {
      throw new AggregateError(
        [Object.assign(new Error('queryA ENOTFOUND'), { code: 'ENOTFOUND' })],
        'all DNS attempts failed',
      );
    };

    const failure = await captureRefreshFailure();

    assert.equal(failure.reason, 'TOKEN_NETWORK_UNREACHABLE');
    assert.match(failure.message, /ENOTFOUND/);
  });

  it('classifies our own abort as a timeout, not as an unreachable host', async () => {
    await seedTokens();
    // fetchWithTimeout owns the signal, so an abort from it can only be the
    // timeout it armed — a fact about the call, not a guess about the network.
    tokenEndpoint = () =>
      new Promise<Response>((_resolve, reject) => {
        setTimeout(() => {
          reject(Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' }));
        }, 5);
      });

    const failure = await captureRefreshFailure();

    assert.equal(failure.reason, 'TOKEN_NETWORK_UNREACHABLE');
    assert.equal(failure.status, 408, 'our own abort is a timeout, not an unreachable service');
    assert.match(failure.message, /timed out after \d+s/);
    assert.match(failure.message, /SPOTIFY_REQUEST_TIMEOUT_MS/);
    assertNotAnOutageClaim(failure.message);
    assertNamesTokenFile(failure.message);
    // Already a full timeout wait, so re-sending it three times would hold the
    // serialized queue for three timeouts.
    assert.equal(tokenCalls().length, 1, 'a timeout is not retried inside the refresh');
  });

  it('rides out a network failure on a still-valid access token', async () => {
    await seedTokens(Date.now() + 30_000);
    tokenEndpoint = () => {
      throw new TypeError('fetch failed');
    };

    const client = new SpotifyClient({ disableCache: true });
    const result = await client.get<{ ok: boolean }>('/me');

    assert.deepEqual(result, { ok: true });
    assert.equal(apiCalls().length, 1);
  });

  it('says "no cause reported" rather than inventing one', async () => {
    await seedTokens();
    tokenEndpoint = () => {
      throw new Error('');
    };

    const failure = await captureRefreshFailure();

    assert.equal(failure.reason, 'TOKEN_NETWORK_UNREACHABLE');
    assert.match(failure.message, /no cause reported/);
  });
});

// ---------------------------------------------------------------------------
// 5. An unclassifiable failure is reported as unclassified, not guessed
// ---------------------------------------------------------------------------

describe('unclassifiable token failure (#677)', () => {
  it('says the cause could not be classified when the body is not JSON', async () => {
    await seedTokens();
    // A 4xx with an HTML error page: a status, and no machine-readable error.
    tokenEndpoint = () => new Response('<html><body>Bad Request</body></html>', {
      status: 400,
      headers: { 'Content-Type': 'text/html' },
    });

    const failure = await captureRefreshFailure();

    assert.equal(failure.reason, 'TOKEN_UNCLASSIFIED');
    assert.match(failure.message, /could not be classified/);
    assert.match(failure.message, /body that is not JSON/);
    assertNamesTokenFile(failure.message);
    assertNotAnOutageClaim(failure.message);
  });

  it('distinguishes "unreadable body" from "readable body naming no cause"', async () => {
    await seedTokens();
    tokenEndpoint = () => jsonResponse({ error_description: 'nope' }, 403);

    const failure = await captureRefreshFailure();

    assert.equal(failure.reason, 'TOKEN_UNCLASSIFIED');
    assert.match(failure.message, /no string "error" field/);
    assert.doesNotMatch(failure.message, /body that is not JSON/);
  });

  it('never maps an unclassifiable failure onto a named category', async () => {
    await seedTokens();
    tokenEndpoint = () => new Response('gateway said no', { status: 418 });

    const failure = await captureRefreshFailure();

    assert.equal(failure.reason, 'TOKEN_UNCLASSIFIED');
    // The three causes it must NOT be reported as, each of which a
    // nearest-plausible-category mapping would have produced.
    assert.doesNotMatch(failure.message, /SPOTIFY_CLIENT_ID|spotify-mcp auth/);
    assert.doesNotMatch(failure.message, /rate limit/i);
    assertNotAnOutageClaim(failure.message);
  });
});

// ---------------------------------------------------------------------------
// 6. The four shapes stay distinguishable from one another
// ---------------------------------------------------------------------------

describe('the classification distinguishes the failures it claims to (#677)', () => {
  /**
   * The mutation check for the whole feature: a classifier that always returned
   * one string would pass any single case, so all four are produced here and
   * asserted pairwise distinct. Reverting src/client.ts makes this fail.
   */
  it('produces a distinct class, reason and message per failure shape', async () => {
    const shapes: Array<{ name: string; setup: () => void; expectedReason: string }> = [
      {
        name: 'invalid credentials (4xx with a body)',
        setup: () => {
          tokenEndpoint = () => jsonResponse({ error: 'invalid_client' }, 400);
        },
        expectedReason: 'TOKEN_INVALID_CLIENT',
      },
      {
        name: 'server error (5xx)',
        setup: () => {
          tokenEndpoint = () => jsonResponse({ error: 'server_error' }, 503);
        },
        expectedReason: 'TOKEN_SERVER_ERROR',
      },
      {
        name: 'network-layer throw (no body)',
        setup: () => {
          tokenEndpoint = () => {
            throw Object.assign(new TypeError('fetch failed'), {
              cause: Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' }),
            });
          };
        },
        expectedReason: 'TOKEN_NETWORK_UNREACHABLE',
      },
      {
        name: 'unclassifiable (4xx, unreadable body)',
        setup: () => {
          tokenEndpoint = () => new Response('nope', { status: 400 });
        },
        expectedReason: 'TOKEN_UNCLASSIFIED',
      },
    ];

    const seen: Classified[] = [];
    for (const shape of shapes) {
      await rm(TOKEN_FILE, { force: true });
      await seedTokens();
      shape.setup();
      const failure = await captureRefreshFailure();
      assert.equal(failure.reason, shape.expectedReason, `wrong class for: ${shape.name}`);
      seen.push(failure);
    }

    for (let i = 0; i < seen.length; i++) {
      for (let j = i + 1; j < seen.length; j++) {
        assert.notEqual(seen[i].reason, seen[j].reason, `reasons must differ: ${shapes[i].name} vs ${shapes[j].name}`);
        assert.notEqual(seen[i].message, seen[j].message, `messages must differ: ${shapes[i].name} vs ${shapes[j].name}`);
      }
    }

    // Status is deliberately NOT asserted to differ: a refused client id and an
    // unclassifiable 4xx are both "this call could not authenticate" and both
    // surface as 401. That shared status is the whole reason the reason code
    // exists — it is what the boundary reads to tell them apart. What must
    // differ is the class, and the two transport/availability classes must not
    // borrow the 401 that means "the grant is not usable".
    const byName = new Map(shapes.map((s, i) => [s.name, seen[i]!]));
    assert.equal(byName.get('invalid credentials (4xx with a body)')!.status, 401);
    assert.equal(byName.get('unclassifiable (4xx, unreadable body)')!.status, 401);
    assert.equal(byName.get('server error (5xx)')!.status, 503);
    assert.equal(byName.get('network-layer throw (no body)')!.status, 503);
  });

  it('marks every reason it mints as a token-failure reason', async () => {
    await seedTokens();
    tokenEndpoint = () => jsonResponse({ error: 'invalid_client' }, 400);
    const failure = await captureRefreshFailure();
    assert.equal(isTokenFailureReason(failure.reason), true);
    assert.equal(isTokenFailureReason('QUOTA_EXCEEDED'), false, 'an API-path reason is not a token reason');
  });
});

// ---------------------------------------------------------------------------
// 7. The operator-facing envelope reports the cause, not an outage
// ---------------------------------------------------------------------------

interface ErrorEnvelope {
  tool: string;
  kind: string;
  status?: number;
  reason: string;
  fix: string;
  retryAfterSec?: number;
}

interface ErrorResult {
  content: Array<{ type: string; text?: string }>;
  structuredContent?: { error?: ErrorEnvelope };
  isError?: boolean;
}

let closeHarness: (() => Promise<void>) | undefined;

/** A server whose one tool performs a real authenticated GET /me. */
async function harness(): Promise<Client> {
  const server = new McpServer({ name: 'token-classification', version: '0.0.0' });
  server.tool('get_me', 'Read the current user.', async () => {
    const client = new SpotifyClient({ disableCache: true });
    return await client.get('/me');
  });
  installToolErrorBoundary(server);

  const client = new Client({ name: 'token-classification-client', version: '0.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  closeHarness = async () => {
    await client.close().catch(() => undefined);
    await server.close().catch(() => undefined);
  };
  return client;
}

function envelope(result: ErrorResult): ErrorEnvelope {
  assert.equal(result.isError, true);
  const error = result.structuredContent?.error;
  assert.ok(error, 'structuredContent.error is required');
  return error;
}

describe('the error boundary reports the classified cause (#677)', () => {
  afterEach(async () => {
    await closeHarness?.();
    closeHarness = undefined;
    globalThis.fetch = realFetch;
    console.error = originalConsoleError;
  });

  it('tells the operator to fix the client id, not to retry', async () => {
    await seedTokens();
    tokenEndpoint = () => jsonResponse({ error: 'invalid_client' }, 400);

    const client = await harness();
    const result = await client.callTool({ name: 'get_me', arguments: {} }) as ErrorResult;
    const error = envelope(result);

    assert.equal(error.kind, 'auth');
    assert.equal(error.reason, 'TOKEN_INVALID_CLIENT');
    assert.match(error.fix, /SPOTIFY_CLIENT_ID/);
    assert.doesNotMatch(error.fix, /[Rr]etry shortly/);
    // The text a caller reads is the claim that matters: the outage wording is
    // what sent an agent into a retry loop it could not win (#677).
    assert.doesNotMatch(resultText(result), /unavailable|outage/);
  });

  it('carries the rate-limit wait through the boundary', async () => {
    await seedTokens();
    tokenEndpoint = () => new Response(JSON.stringify({ error: 'temporarily_unavailable' }), {
      status: 429,
      headers: { 'Content-Type': 'application/json', 'Retry-After': '30' },
    });

    const client = await harness();
    const result = await client.callTool({ name: 'get_me', arguments: {} }) as ErrorResult;
    const error = envelope(result);

    assert.equal(error.kind, 'rate_limited');
    assert.equal(error.status, 429);
    assert.equal(error.retryAfterSec, 30);
    assert.match(error.fix, /30 seconds/);
    assert.match(resultText(result), /30 seconds/);
  });

  it('says the cause is unknown when the response classified nothing', async () => {
    await seedTokens();
    tokenEndpoint = () => new Response('<html>nope</html>', { status: 400 });

    const client = await harness();
    const error = envelope(await client.callTool({ name: 'get_me', arguments: {} }) as ErrorResult);

    assert.equal(error.reason, 'TOKEN_UNCLASSIFIED');
    assert.match(error.fix, /cause is unknown|server log/i);
  });

  it('keeps a 429 classified when the refresh was triggered mid-flight by a 401', async () => {
    // The 401 branch re-wraps the refresh failure. Before this fix it forced
    // every refresh failure to a bare 401, so a 429 lost its status and its
    // wait and the agent retried into the limit it was already inside.
    await seedTokens(Date.now() + 3_600_000);
    const seen = { apiCalls: 0 };
    globalThis.fetch = (async (url: unknown, init: RequestInit) => {
      const call: FetchCall = { url: String(url), init };
      calls.push(call);
      if (call.url.startsWith('https://accounts.spotify.com/')) return tokenEndpoint(call.url, call.init);
      seen.apiCalls++;
      if (seen.apiCalls === 1) {
        return jsonResponse({ error: { status: 401, message: 'The access token expired' } }, 401);
      }
      return jsonResponse({ ok: true });
    }) as typeof fetch;
    tokenEndpoint = () => new Response(JSON.stringify({ error: 'temporarily_unavailable' }), {
      status: 429,
      headers: { 'Content-Type': 'application/json', 'Retry-After': '45' },
    });

    const client = await harness();
    const error = envelope(await client.callTool({ name: 'get_me', arguments: {} }) as ErrorResult);

    assert.equal(error.kind, 'rate_limited');
    assert.equal(error.status, 429);
    assert.equal(error.retryAfterSec, 45);
    assert.match(error.fix, /45 seconds/);
  });
});

function resultText(result: ErrorResult): string {
  return result.content.map((c) => c.text ?? '').join('\n');
}

process.on('exit', () => {
  globalThis.fetch = realFetch;
  console.error = originalConsoleError;
  void rm(tokenDir, { recursive: true, force: true });
});
