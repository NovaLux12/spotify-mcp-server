/**
 * #597 — the poll must re-FETCH, and this is the test that says so.
 *
 * ## Why this file exists separately from resource-subscriptions.test.ts
 *
 * That file stubs `client.get`, so it proves the poll compares vectors and
 * sends the right notifications — but it cannot prove the thing the whole
 * watchable set rests on: that the poll's read actually goes to the network
 * rather than being answered from the TTL payload cache.
 *
 * This matters because a poll against a cached resource is worse than useless.
 * The cache serves the same stored body until it goes stale, so the poll would
 * re-read a body against itself, see no change, and report nothing for as long
 * as the cache entry lived — while a real change was sitting in the API. The
 * subscription would look alive, be correctly silent, and be wrong.
 *
 * So the assertion is not "the poll notifies" (that is the other file's job).
 * It is: **while a subscription is live and idle, the endpoint is hit again and
 * again.** A poll served from cache hits it exactly once. The count is the
 * claim.
 *
 * ## The real client, a stubbed fetch, and no network
 *
 * `SpotifyClient` is production code here; only `globalThis.fetch` is
 * replaced. That is the arrangement `resources-cap-disclosure.test.ts` uses,
 * and it is the only one that exercises the cache layer rather than assuming
 * what it does.
 *
 * The three API-backed watchables live under `/me/player*`, which
 * `shouldBypassCache` exempts. That exemption is asserted here rather than
 * trusted: `spotify://me/recently-played` is the interesting case, because its
 * vector is a *list*, and a cache that served the previous page would produce a
 * vector that never changes — the exact silent-wrongness described above. If
 * someone ever moved that endpoint out from under the prefix, this test fails
 * on the request count rather than in production.
 *
 * `spotify://me/rate-limit` reads no API at all, so there is nothing to
 * re-fetch and it is covered by the vector tests instead.
 *
 * ## Hermeticity
 *
 * `import './helpers/hermetic.js'` is FIRST, and the dynamic imports below
 * happen after `SPOTIFY_MCP_TOKEN_FILE` is pointed at a temp file — the same
 * seam `resources-cap-disclosure.test.ts` documents, and the reason it uses
 * top-level `await import` rather than a static one. Nothing here reads or
 * writes the real `~/.spotify-mcp/`.
 */
import './helpers/hermetic.js';

import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, before, beforeEach, describe, it } from 'node:test';

const tokenDir = await mkdtemp(path.join(tmpdir(), 'spotify-mcp-subs-cache-'));
process.env.SPOTIFY_MCP_TOKEN_FILE = path.join(tokenDir, 'tokens.json');
process.env.SPOTIFY_CLIENT_ID = 'test-client-id';

const { SpotifyClient } = await import('../src/client.ts');
const { initConfig } = await import('../src/config.ts');
const { registerResources } = await import('../src/resources/index.ts');
const { createResourceReadRegistry, createSubscriptionManager, WATCHABLE_RESOURCES } =
  await import('../src/resources/subscriptions.ts');
const { McpServer } = await import('@modelcontextprotocol/sdk/server/mcp.js');

initConfig();

const realFetch = globalThis.fetch;
const POLL_MS = 20;

/** Every API path the stubbed fetch has been asked for, in order. */
let hits: string[] = [];

function playerState(itemUri: string): Record<string, unknown> {
  return {
    is_playing: true,
    progress_ms: 1_234,
    timestamp: 1_700_000_000_000,
    shuffle_state: false,
    repeat_state: 'off',
    device: { id: 'dev1', name: 'Living Room', type: 'Computer', volume_percent: 42 },
    item: { uri: itemUri, type: 'track', name: 'Track', duration_ms: 200_000 },
  };
}

function recentlyPlayed(n: number): Record<string, unknown> {
  return {
    items: Array.from({ length: n }, (_, i) => ({
      played_at: `2026-01-0${i + 1}T00:00:00.000Z`,
      track: { uri: `spotify:track:trk${i}` },
      context: null,
    })),
    cursors: { before: null, after: 'after-cursor' },
    next: null,
  };
}

before(async () => {
  await writeFile(
    process.env.SPOTIFY_MCP_TOKEN_FILE!,
    JSON.stringify({ access_token: 'tok', refresh_token: 'ref', expires_at: Date.now() + 3_600_000 }),
    'utf8',
  );
});

beforeEach(() => {
  hits = [];
  globalThis.fetch = (async (url: unknown) => {
    const requestPath = new URL(String(url)).pathname.replace(/^\/v1/, '');
    hits.push(requestPath);
    const body = requestPath === '/me/player/recently-played'
      ? recentlyPlayed(3)
      : playerState('spotify:track:trk1');
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof fetch;
});

after(() => {
  globalThis.fetch = realFetch;
  return rm(tokenDir, { recursive: true, force: true });
});

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

async function until(predicate: () => boolean, what: string, budgetMs = 4_000): Promise<void> {
  const deadline = Date.now() + budgetMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await sleep(4);
  }
  assert.fail(`timed out after ${budgetMs}ms waiting for: ${what}`);
}

describe('#597 the poll re-fetches rather than reading the cache', () => {
  for (const uri of ['spotify://player/state', 'spotify://me/recently-played']) {
    it(`${uri} hits the endpoint again on every poll`, async () => {
      // The production renderer, the production registry, the production
      // client. Only fetch is replaced.
      const server = new McpServer({ name: 'test', version: '0.0.0' });
      const client = new SpotifyClient();
      const reads = createResourceReadRegistry();
      registerResources(server, client, reads);

      const sent: string[] = [];
      const manager = createSubscriptionManager({
        enabled: true,
        pollMs: POLL_MS,
        reads,
        send: async (subscribed) => {
          sent.push(subscribed);
        },
      });
      try {
        manager.subscribe(uri);
        await until(
          () => manager.snapshot()[0]?.vector !== null,
          `the first vector for ${uri}`,
        );

        const afterFirst = hits.length;
        assert.ok(afterFirst > 0, 'the first poll must have reached the endpoint at all');

        // Ten poll intervals of a resource that does not change. The window
        // is a second rather than 200ms because the client's request funnel
        // paces starts ~100ms apart, so a short window measures the PACING and
        // not the caching — which would make this a test of a different thing
        // wearing this one's name. A second admits ~8-10 paced requests.
        const WINDOW_MS = 1_000;
        await sleep(WINDOW_MS);
        const rereads = hits.length - afterFirst;

        // A cache-served poll reads once and then compares a body to itself.
        // A live poll reads on every paced start. The threshold is loose on
        // purpose — a shared box, a paced funnel — but it is three, and a
        // cached poll scores one.
        assert.ok(
          rereads >= 3,
          `${uri}: expected repeated fetches over ${WINDOW_MS}ms, saw ${rereads} (a cache-served poll would make 1)`,
        );
        // And the repeats are to the SAME endpoint: a re-read that wandered
        // to another path would satisfy the count without re-reading the
        // watched resource.
        const watched = uri === 'spotify://player/state' ? '/me/player' : '/me/player/recently-played';
        const repeats = hits.filter((path) => path === watched).length - 1;
        assert.ok(repeats >= 3, `${uri}: ${repeats} repeats against ${watched} over ${WINDOW_MS}ms`);
        // Silence is still the contract: the resource never changed.
        assert.deepEqual(sent, [], `${uri}: an unchanging resource must not notify, however often it is re-read`);
      } finally {
        manager.stopAll();
      }
    });
  }

  it('every API-backed watchable sits under a cache-exempt prefix', async () => {
    // The structural half of the claim above, asserted directly rather than
    // inferred. A watchable that is NOT exempt is a watchable whose poll can be
    // answered from the cache — and that is a resource the set must not
    // contain, because the failure is silent rather than loud.
    //
    // `spotify://me/rate-limit` is the documented exception: it reads no
    // endpoint at all, so there is no cache entry for it to be served from.
    const { shouldBypassCache } = await import('../src/cache.ts');
    const ENDPOINTS: Record<string, string> = {
      'spotify://player/state': '/me/player',
      'spotify://player/queue': '/me/player/queue',
      'spotify://me/recently-played': '/me/player/recently-played',
    };
    for (const watchable of WATCHABLE_RESOURCES) {
      const endpoint = ENDPOINTS[watchable.uri];
      if (endpoint === undefined) {
        assert.equal(
          watchable.uri,
          'spotify://me/rate-limit',
          `${watchable.uri} reads no endpoint, so it is exempt by having nothing to cache — a new one must say which`,
        );
        continue;
      }
      assert.equal(
        shouldBypassCache('GET', endpoint),
        true,
        `${watchable.uri} reads ${endpoint}, which the TTL cache would serve — a poll against it could report no change for an unchanged cached body`,
      );
    }
  });
});
