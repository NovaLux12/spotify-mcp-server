/**
 * Conditional reads: If-None-Match out, 304 back as a cache hit (#601).
 *
 * Covers:
 *   - Volatile reads (/me/player) revalidate with the stored ETag and a 304
 *     returns the stored payload — same shape, never null, never an error.
 *   - Catalog reads past the payload TTL revalidate too, and a 304 refreshes
 *     the cache entry's timestamp instead of falling back to a full download.
 *   - A body with no ETag supersedes any stored validator, and a mutation
 *     drops validators (a 304 must never resurrect a pre-mutation payload).
 *   - get_now_playing surfaces the hit as `unchanged: true` in
 *     structuredContent so a watch loop can branch.
 *
 * Run with: node --import tsx --test tests/conditional.test.ts
 *
 * NOTE: TOKEN_FILE is resolved at module-load time inside src/auth.ts, so the
 * env vars MUST be set before the dynamic import below.
 */

import { describe, it, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

const tokenDir = await mkdtemp(path.join(tmpdir(), 'spotify-mcp-conditional-test-'));
process.env.SPOTIFY_MCP_TOKEN_FILE = path.join(tokenDir, 'tokens.json');
process.env.SPOTIFY_CLIENT_ID = 'test-client-id';

const { SpotifyClient, SpotifyApiError } = await import('../src/client.ts');
const { TOKEN_FILE } = await import('../src/auth.ts');
const { registerPlaybackTools } = await import('../src/tools/playback.ts');
// annotations.ts reaches client.ts reaches auth.ts, so it must be imported
// dynamically too — TOKEN_FILE binds at load time, above.
const { installToolErrorBoundary } = await import('../src/tools/annotations.ts');

// Real short waits, matching the TTL tests in tests/infra.test.ts: the clock
// the cache reads is Date.now(), and a mocked clock would not move the
// deadline the cache already captured at set() time.
const sleep = (ms: number): Promise<void> => {
  const { promise, resolve } = Promise.withResolvers<void>();
  setTimeout(resolve, ms);
  return promise;
};

interface FetchCall {
  url: string;
  method: string;
  ifNoneMatch: string | null;
}

let calls: FetchCall[] = [];
let responder: (url: string, init: RequestInit) => Response | Promise<Response>;
const realFetch = globalThis.fetch;

function jsonResponse(
  body: unknown,
  status = 200,
  headers?: Record<string, string>,
): Response {
  return new Response(status === 204 ? null : JSON.stringify(body), { status, headers });
}

function headerOf(init: RequestInit | undefined, name: string): string | null {
  const headers = init?.headers as Record<string, string> | undefined;
  return headers?.[name] ?? null;
}

async function seedTokens(): Promise<void> {
  await writeFile(
    TOKEN_FILE,
    JSON.stringify({ access_token: 'tok-1', refresh_token: 'ref-1', expires_at: Date.now() + 3600_000 }),
    'utf8',
  );
}

describe('conditional reads (#601)', () => {
  beforeEach(async () => {
    calls = [];
    responder = () => jsonResponse({});
    await rm(TOKEN_FILE, { force: true });
    globalThis.fetch = (async (url: unknown, init: RequestInit) => {
      const record: FetchCall = {
        url: String(url),
        method: init.method ?? 'GET',
        ifNoneMatch: headerOf(init, 'If-None-Match'),
      };
      calls.push(record);
      return responder(String(url), init);
    }) as typeof fetch;
  });

  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  after(async () => {
    await rm(tokenDir, { recursive: true, force: true });
  });

  it('revalidates a volatile read: one 200 then one 304, same payload both times', async () => {
    await seedTokens();
    const state = { is_playing: true, item: { id: 'trk1' }, progress_ms: 1000 };
    responder = (url, init) => {
      // A 304 means "your copy is current" — answer only when we were asked.
      if (headerOf(init, 'If-None-Match') === 'W/"v1"') return new Response(null, { status: 304 });
      assert.equal(url, 'https://api.spotify.com/v1/me/player');
      return jsonResponse(state, 200, { etag: 'W/"v1"' });
    };

    const client = new SpotifyClient();
    const first = await client.get<typeof state>('/me/player');
    assert.deepEqual(first, state);
    assert.equal(calls.length, 1, 'the first read has nothing to revalidate against');
    assert.equal(calls[0].ifNoneMatch, null, 'no If-None-Match is invented for a cold key');

    let hits = 0;
    const second = await client.get<typeof state>('/me/player', undefined, {
      onNotModified: () => { hits += 1; },
    });

    assert.equal(calls.length, 2, 'a volatile read still hits the network every time');
    assert.equal(calls[1].ifNoneMatch, 'W/"v1"', 'the stored ETag is offered back to the origin');
    assert.deepEqual(second, first, 'a 304 must return the payload the ETag identifies');
    assert.notEqual(second, null, 'a 304 must never surface as a null/empty result');
    assert.equal(hits, 1, 'the caller is told the payload was validated, not re-read');
  });

  it('a 304 after the payload TTL is served as a cache hit with a refreshed timestamp', async () => {
    await seedTokens();
    const album = { id: 'alb1', name: 'A Night at the Opera' };
    responder = (url, init) => {
      if (headerOf(init, 'If-None-Match') === '"cat-1"') return new Response(null, { status: 304 });
      assert.equal(url, 'https://api.spotify.com/v1/albums/alb1');
      return jsonResponse(album, 200, { etag: '"cat-1"' });
    };

    // A 50ms payload TTL: the first entry dies before the second read, so the
    // second read can only be answered by the origin.
    const client = new SpotifyClient({ cache: { ttlMs: 50 } });
    assert.deepEqual(await client.get<typeof album>('/albums/alb1'), album);
    await sleep(80);
    assert.equal(calls.length, 1, 'the first read is the only one so far');

    let hits = 0;
    const revalidated = await client.get<typeof album>('/albums/alb1', undefined, {
      onNotModified: () => { hits += 1; },
    });
    assert.equal(calls.length, 2, 'an expired catalog entry revalidates instead of guessing');
    assert.equal(calls[1].ifNoneMatch, '"cat-1"');
    assert.deepEqual(revalidated, album);
    assert.equal(hits, 1);

    // The refreshed timestamp is the load-bearing part: inside the new TTL the
    // catalog entry is served locally again, costing no request at all.
    const servedFromCache = await client.get<typeof album>('/albums/alb1');
    assert.deepEqual(servedFromCache, album);
    assert.equal(calls.length, 2, 'the 304 refreshed the cache entry, so no third request');
  });

  it('drops a stored validator when the new body carries no ETag', async () => {
    await seedTokens();
    // A scripted origin: cold body with a tag, a 304 to the revalidation, then
    // a changed body that carries no tag at all.
    const script: Array<Response> = [
      jsonResponse({ n: 1 }, 200, { etag: '"gen-1"' }),
      new Response(null, { status: 304 }),
      jsonResponse({ n: 2 }, 200),
    ];
    // The script is exhausted: any later read is an unconditional re-read.
    responder = () => script.shift() ?? jsonResponse({ n: 2 }, 200);

    const client = new SpotifyClient();
    assert.deepEqual(await client.get<{ n: number }>('/me/top/artists'), { n: 1 });
    assert.deepEqual(await client.get<{ n: number }>('/me/top/artists'), { n: 1 }); // 304

    assert.deepEqual(await client.get<{ n: number }>('/me/top/artists'), { n: 2 });
    assert.equal(calls[2].ifNoneMatch, '"gen-1"');
    assert.equal(calls.length, 3);

    // The superseded validator is gone: nothing is offered for the fourth read.
    assert.deepEqual(await client.get<{ n: number }>('/me/top/artists'), { n: 2 });
    assert.equal(calls[3].ifNoneMatch, null, 'an unvalidated body must not revalidate with a stale tag');
  });

  it('drops validators after a mutation so a 304 cannot resurrect a pre-mutation payload', async () => {
    await seedTokens();
    // A volatile path, so every read reaches the network and the header is
    // observable — a cached catalog read would answer from memory instead.
    responder = (url, init) => {
      if (init.method && init.method !== 'GET') return jsonResponse({ snapshot_id: 'snap1' }, 200);
      if (headerOf(init, 'If-None-Match') === '"q1"') return new Response(null, { status: 304 });
      assert.equal(url, 'https://api.spotify.com/v1/me/player/queue');
      return jsonResponse({ queue: [], volume_percent: 11 }, 200, { etag: '"q1"' });
    };

    const client = new SpotifyClient();
    assert.deepEqual(await client.get<{ volume_percent: number }>('/me/player/queue'), {
      queue: [],
      volume_percent: 11,
    });
    // Control: with no mutation in between, the validator IS offered.
    await client.get('/me/player/queue');
    assert.equal(calls[1].ifNoneMatch, '"q1"');

    await client.put('/me/player/volume', { volume_percent: 55 });

    responder = () => jsonResponse({ queue: [], volume_percent: 55 }, 200, { etag: '"q2"' });
    assert.deepEqual(await client.get<{ volume_percent: number }>('/me/player/queue'), {
      queue: [],
      volume_percent: 55,
    });
    const read = calls.filter((c) => c.method === 'GET');
    assert.equal(read[2].ifNoneMatch, null, 'the mutation invalidated every stored validator');
  });

  it('reports a 304 with no stored validator as an error, never as an empty result', async () => {
    await seedTokens();
    // A body-less 304 to an unconditional GET: nothing local names it.
    responder = () => new Response(null, { status: 304 });
    const client = new SpotifyClient();
    await assert.rejects(client.get('/albums/alb1'), (err: unknown) => {
      assert.ok(err instanceof SpotifyApiError);
      assert.equal(err.status, 304);
      // Named as the unbacked-validator case, not a generic status failure:
      // a bodiless 304 to a plain GET is the origin breaking its own contract,
      // and the message has to say that rather than imply a bad argument.
      assert.match(err.message, /no stored ETag backs it/);
      return true;
    });
  });

  it('classifies the unbacked 304 as its own machine-readable failure, not a caller error', async () => {
    await seedTokens();
    // A body-less 304 to an unconditional GET: nothing local names it.
    responder = () => new Response(null, { status: 304 });
    const client = new SpotifyClient();
    const raised = await client.get('/albums/alb1').then(
      () => null,
      (err: unknown) => err,
    );
    assert.ok(raised instanceof SpotifyApiError, 'the read must fail, not return an empty result');

    // Through the real error boundary: the host is told WHICH failure this is.
    // A bare internal_error — or, worse, a "received invalid arguments" line
    // about arguments that were fine — would be unactionable: #1007's shape.
    const server = new McpServer({ name: 'conditional-classification', version: '0.0.0' });
    server.tool('read_album', 'rethrows the client error', {}, async () => { throw raised; });
    installToolErrorBoundary(server);
    const mcp = new Client({ name: 'conditional-classification-client', version: '0.0.0' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), mcp.connect(clientTransport)]);
    try {
      const result = await mcp.callTool({ name: 'read_album', arguments: {} }) as {
        isError?: boolean;
        structuredContent?: { error?: { kind: string; reason: string; status?: number } };
      };
      assert.equal(result.isError, true);
      const error = result.structuredContent?.error;
      assert.ok(error, 'structuredContent.error is required');
      assert.equal(error.status, 304, 'the true status survives, not a relabelled one');
      assert.equal(
        error.reason,
        'NOT_MODIFIED_WITHOUT_VALIDATOR',
        'a host can branch on this reason; internal_error could not be acted on',
      );
      assert.notEqual(error.kind, 'validation', 'the caller passed nothing wrong');
    } finally {
      await mcp.close().catch(() => undefined);
      await server.close().catch(() => undefined);
    }
  });

  it('get_now_playing marks a revalidated poll as unchanged and returns the same payload', async () => {
    await seedTokens();
    const state = {
      is_playing: true,
      progress_ms: 1000,
      shuffle_state: false,
      repeat_state: 'off',
      device: { id: 'dev1', name: 'Living Room', type: 'Computer', volume_percent: 42 },
      item: { id: 'trk1', name: 'Bohemian Rhapsody', uri: 'spotify:track:trk1', type: 'track' },
    };
    responder = (_url, init) => {
      if (headerOf(init, 'If-None-Match') === 'W/"np"') return new Response(null, { status: 304 });
      return jsonResponse(state, 200, { etag: 'W/"np"' });
    };

    const client = new SpotifyClient();
    const handlers = new Map<string, (args: Record<string, unknown>) => Promise<unknown>>();
    const server = {
      tool: (name: string, _d: string, _s: unknown, handler: (a: Record<string, unknown>) => Promise<unknown>) => {
        handlers.set(name, handler);
      },
    };
    registerPlaybackTools(server as never, client);
    const nowPlaying = handlers.get('get_now_playing')!;

    const first = (await nowPlaying({ response_format: 'json' })) as {
      structuredContent: Record<string, unknown>;
    };
    assert.equal(first.structuredContent.unchanged, undefined, 'a 200 says nothing about change');

    const second = (await nowPlaying({ response_format: 'json' })) as {
      structuredContent: Record<string, unknown>;
    };
    assert.equal(second.structuredContent.unchanged, true, 'a 304 is reported to the watch loop');
    const { unchanged: _dropped, ...secondPayload } = second.structuredContent;
    assert.deepEqual(secondPayload, first.structuredContent, 'the payload shape is the same on both reads');

    const prose = (await nowPlaying({})) as { content: Array<{ text: string }> };
    assert.match(prose.content[0].text, /Unchanged since your last read/);

    const reads = calls.filter((c) => c.url.includes('/me/player'));
    assert.equal(reads.length, 3);
    assert.equal(reads[0].ifNoneMatch, null);
    assert.equal(reads[1].ifNoneMatch, 'W/"np"');
    assert.equal(reads[2].ifNoneMatch, 'W/"np"');
  });
});
