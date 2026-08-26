/**
 * Auth hardening tests (#109):
 *  - atomic token persistence (tmp write + rename, no stray .tmp)
 *  - actionable error for a corrupted tokens.json
 *  - cross-process refresh race guard (fresher on-disk token adopted, no network)
 *  - refresh-failure classification (invalid_grant vs transient vs other)
 *  - malformed expires_in guarded (NaN => immediately expired)
 */

import { describe, it, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

// ---------------------------------------------------------------------------
// Env setup MUST precede importing src modules (TOKEN_FILE binds at load time)
// ---------------------------------------------------------------------------

const tokenDir = await mkdtemp(path.join(tmpdir(), 'spotify-mcp-auth-hardening-'));
process.env.SPOTIFY_MCP_TOKEN_FILE = path.join(tokenDir, 'tokens.json');
process.env.SPOTIFY_CLIENT_ID = 'test-client-id';

const { loadTokens, saveTokens, TOKEN_FILE } = await import('../src/auth.ts');
const { SpotifyClient, SpotifyApiError } = await import('../src/client.ts');
const { initConfig, getConfig } = await import('../src/config.ts');

interface FetchCall {
  url: string;
  init: RequestInit;
}

let calls: FetchCall[] = [];
let responder: (url: string, init: RequestInit) => Response | Promise<Response>;

const realFetch = globalThis.fetch;

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
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

/** Install the fetch stub recording every call and answering via `responder`. */
function installStub(): void {
  globalThis.fetch = (async (url: unknown, init: RequestInit) => {
    const call: FetchCall = { url: String(url), init };
    calls.push(call);
    return responder(call.url, call.init);
  }) as typeof fetch;
}

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

async function storedTokens(): Promise<{
  access_token: string;
  refresh_token: string;
  expires_at: number;
}> {
  return JSON.parse(await readFile(TOKEN_FILE, 'utf8'));
}

afterEach(() => {
  globalThis.fetch = realFetch;
});

after(async () => {
  await rm(tokenDir, { recursive: true, force: true });
});

describe('atomic token persistence (#109)', () => {
  afterEach(async () => {
    await rm(TOKEN_FILE, { force: true });
  });

  it('saveTokens writes the target and leaves no .tmp behind', async () => {
    await saveTokens({
      access_token: 'tok-a',
      refresh_token: 'ref-a',
      expires_at: Date.now() + 1000,
    });

    const st = await stat(TOKEN_FILE);
    assert.equal(st.mode & 0o777, 0o600, 'tokens file must be owner-only');
    await assert.rejects(stat(`${TOKEN_FILE}.tmp`), { code: 'ENOENT' }, 'no .tmp may survive');

    const stored = await storedTokens();
    assert.equal(stored.access_token, 'tok-a');
  });

  it('saveTokens atomically replaces a pre-existing (looser) file', async () => {
    // Pre-existing file with loose permissions, as an older release may have left.
    await writeFile(TOKEN_FILE, '{"access_token":"stale"}', { mode: 0o644 });

    await saveTokens({
      access_token: 'tok-b',
      refresh_token: 'ref-b',
      expires_at: Date.now() + 1000,
    });

    const st = await stat(TOKEN_FILE);
    assert.equal(st.mode & 0o777, 0o600, 'replacement tightens permissions too');
    const stored = await storedTokens();
    assert.equal(stored.access_token, 'tok-b');
    await assert.rejects(stat(`${TOKEN_FILE}.tmp`), { code: 'ENOENT' });
  });

  it('loadTokens turns a corrupted tokens.json into an actionable error', async () => {
    await writeFile(TOKEN_FILE, '{not json at all', 'utf8');
    await assert.rejects(
      loadTokens(),
      { message: 'Saved Spotify tokens are corrupted — run `npm run auth` again.' },
    );
  });
});

describe('refresh resilience (#109)', () => {
  afterEach(async () => {
    await rm(TOKEN_FILE, { force: true });
  });

  it('adopts a fresher on-disk token and skips the network entirely', async () => {
    // Phase 1: put a near-expiry token into the client's memory (and disk)
    // via a real network refresh, so the next request enters doRefreshTokens.
    await seedTokens({ expires_at: Date.now() - 1000 });
    responder = (url) => {
      if (isAccountsUrl(url)) {
        return jsonResponse({ access_token: 'tok-stale', expires_in: 30 });
      }
      return jsonResponse({ ok: true });
    };
    installStub();

    const client = new SpotifyClient();
    await client.get<{ ok: boolean }>('/me');
    assert.equal(calls.filter((c) => isAccountsUrl(c.url)).length, 1);
    assert.equal((await storedTokens()).access_token, 'tok-stale');

    // Phase 2: another process persists a much fresher token to disk. Our
    // in-memory copy sits inside the 60s refresh window -> the race guard
    // must adopt the on-disk token instead of hitting the network again.
    calls = [];
    responder = (url) => {
      if (isAccountsUrl(url)) {
        throw new assert.AssertionError({ message: 'token endpoint must not be hit' });
      }
      return jsonResponse({ ok: true });
    };
    await writeFile(
      TOKEN_FILE,
      JSON.stringify({
        access_token: 'tok-fresher',
        refresh_token: 'ref-fresher',
        expires_at: Date.now() + 3600_000,
      }),
      'utf8',
    );

    // A different path than phase 1 so the client's TTL cache can't serve it.
    const result = await client.get<{ ok: boolean }>('/me/playlists');
    assert.deepEqual(result, { ok: true });
    assert.equal(authHeaderOf(calls[0]), 'Bearer tok-fresher');
    assert.equal(calls.length, 1, 'zero requests to the token endpoint');
  });

  it('keeps the still-unexpired old token when refresh answers 5xx', async () => {
    // Inside the 60s refresh window but the access token itself is valid.
    await seedTokens({ expires_at: Date.now() + 30_000 });
    calls = [];
    responder = (url) => {
      if (isAccountsUrl(url)) return jsonResponse({ error: 'service_unavailable' }, 503);
      return jsonResponse({ ok: true });
    };
    installStub();

    const client = new SpotifyClient();
    const result = await client.get<{ ok: boolean }>('/me');
    assert.deepEqual(result, { ok: true });
    assert.equal(authHeaderOf(apiCalls()[0]), 'Bearer tok-initial', 'old access token rode it out');
    // Old token untouched on disk — nothing bogus persisted.
    assert.equal((await storedTokens()).access_token, 'tok-initial');
  });

  it('throws the actionable re-auth message on invalid_grant', async () => {
    await seedTokens({ expires_at: Date.now() + 30_000 });
    calls = [];
    responder = () => jsonResponse({ error: 'invalid_grant' }, 400);
    installStub();

    const client = new SpotifyClient();
    await assert.rejects(client.get('/me'), (err: unknown) => {
      assert.ok(err instanceof SpotifyApiError);
      assert.equal(err.status, 400);
      assert.match(err.message, /re-run "spotify-mcp auth"/);
      return true;
    });
    assert.equal(apiCalls().length, 0, 'no API call after a fatal grant rejection');
  });

  it('throws "temporarily unavailable" for unclassified failures with an unexpired token', async () => {
    await seedTokens({ expires_at: Date.now() + 30_000 });
    calls = [];
    responder = () => jsonResponse({ error: 'invalid_client' }, 400);
    installStub();

    const client = new SpotifyClient();
    await assert.rejects(client.get('/me'), (err: unknown) => {
      assert.ok(err instanceof SpotifyApiError);
      assert.match(err.message, /Spotify token service temporarily unavailable/);
      return true;
    });
  });

  it('throws "temporarily unavailable" when the network dies and the old token is expired', async () => {
    await seedTokens({ expires_at: Date.now() - 1000 });
    calls = [];
    responder = () => {
      throw new TypeError('fetch failed');
    };
    installStub();

    const client = new SpotifyClient();
    await assert.rejects(client.get('/me'), (err: unknown) => {
      assert.ok(err instanceof SpotifyApiError);
      assert.match(err.message, /Spotify token service temporarily unavailable/);
      return true;
    });
    assert.equal(apiCalls().length, 0);
  });

  it('treats a non-finite expires_in as already expired', async () => {
    await seedTokens({ expires_at: Date.now() - 1000 });
    calls = [];
    responder = (url) => {
      if (isAccountsUrl(url)) {
        // JSON has no NaN — the wire form of a broken expires_in is null/garbage.
        return new Response('{"access_token":"tok-nan","expires_in":null}', {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      return jsonResponse({ ok: true });
    };
    installStub();

    const client = new SpotifyClient();
    const result = await client.get<{ ok: boolean }>('/me');
    assert.deepEqual(result, { ok: true });

    const stored = await storedTokens();
    assert.equal(stored.access_token, 'tok-nan');
    // expires_at collapsed to "now" instead of being poisoned by NaN*1000.
    assert.ok(
      stored.expires_at <= Date.now() + 1000,
      `expires_at must be ~now, got ${stored.expires_at}`,
    );
  });
});

describe('request timeout config (#109)', () => {
  it('defaults SPOTIFY_REQUEST_TIMEOUT_MS to 30000 via the config snapshot', () => {
    initConfig({});
    assert.equal(getConfig().spotifyRequestTimeoutMs, 30_000);
  });

  it('honours a SPOTIFY_REQUEST_TIMEOUT_MS override end-to-end', async () => {
    let keepAlive: NodeJS.Timeout | undefined;
    try {
      initConfig({ ...process.env, SPOTIFY_REQUEST_TIMEOUT_MS: '1234' });
      assert.equal(getConfig().spotifyRequestTimeoutMs, 1234);

      await seedTokens();
      calls = [];
      responder = () => jsonResponse({ ok: true });
      // Hangs until aborted — exactly what a wedged connection does to real
      // fetch, including honouring init.signal.
      globalThis.fetch = ((_url: unknown, init: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init.signal?.addEventListener('abort', () => {
            const err = new Error('This operation was aborted');
            err.name = 'TimeoutError';
            reject(err);
          });
        })) as typeof fetch;
      // AbortSignal.timeout's arm is an unref'd native timer that mock/fake
      // timers cannot drive, so hold a ref'd timer to keep the event loop
      // alive until the ~1.2s abort fires (real platform clock required).
      keepAlive = setTimeout(() => {}, 5_000);

      const client = new SpotifyClient();
      await assert.rejects(client.get('/me'), (err: unknown) => {
        assert.ok(err instanceof SpotifyApiError);
        assert.equal(err.status, 408);
        assert.match(err.message, /timed out after 1s/);
        return true;
      });
    } finally {
      clearTimeout(keepAlive);
      initConfig(process.env); // restore the process-wide snapshot
    }
  });
});
