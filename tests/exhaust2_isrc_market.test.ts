/**
 * #777 — `search_by_isrc` and `find_canonical_track` declare a `market`
 * parameter and never sent it, so every /search they issued ran against the
 * token's default market while the caller believed a market was applied.
 *
 * The assertions are on the request parameters the client actually received,
 * not on an echo of the tool's own args, so they fail on the pre-fix handler
 * where the param is simply absent.
 */
import { describe, it, mock } from 'node:test';
import assert from 'node:assert/strict';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { registerExhaust2CatalogTools } from '../src/tools/exhaust2_catalog.js';
import { getConfig, initConfig } from '../src/config.js';
import type { SpotifyClient } from '../src/client.js';

type Handler = (args: Record<string, unknown>) => Promise<{
  content: Array<{ type: string; text: string }>;
  structuredContent?: Record<string, unknown>;
}>;

function trackPayload(overrides: Record<string, unknown> = {}) {
  return {
    id: 't1', uri: 'spotify:track:t1', name: 'Song', type: 'track', duration_ms: 200_000, explicit: false,
    artists: [{ id: 'a1', name: 'Artist', uri: 'spotify:artist:a1' }],
    album: { id: 'alb1', name: 'Album', uri: 'spotify:album:alb1', images: [], release_date: '2021-03-05', album_type: 'album', total_tracks: 3 },
    external_ids: { isrc: 'USUM71703861' },
    ...overrides,
  };
}

/** Client that records every /search request it is handed. */
function recordingClient(response: (q: string) => unknown) {
  const calls: Array<Record<string, string>> = [];
  const client = {
    get: mock.fn(async (path: string, params?: Record<string, string>) => {
      if (path === '/search') calls.push({ path, ...(params ?? {}) });
      return response(params?.q ?? '');
    }),
    getAllPages: mock.fn(async () => []),
    put: mock.fn(async () => null),
    post: mock.fn(async () => null),
    delete: mock.fn(async () => null),
  } as unknown as SpotifyClient;
  return { client, calls };
}

function handlerFor(name: string, client: SpotifyClient): Handler {
  let captured: Handler | undefined;
  const server = {
    tool(n: string, _desc: string, _shape: unknown, h: Handler) {
      if (n === name) captured = h;
    },
  } as unknown as McpServer;
  registerExhaust2CatalogTools(server, client);
  if (!captured) throw new Error(`tool ${name} not registered`);
  return captured;
}

describe('#777 search_by_isrc honours market', () => {
  it('sends the requested market on its /search call and echoes it back', async () => {
    const { client, calls } = recordingClient(() => ({ tracks: { items: [trackPayload()], total: 1 } }));
    const res = await handlerFor('search_by_isrc', client)({
      isrc: 'USUM71703861', market: 'GB', response_format: 'concise',
    });
    assert.equal(calls.length, 1, 'one /search call expected');
    assert.deepEqual(calls.map((c) => c.market), ['GB']);
    assert.equal(res.structuredContent?.market_used, 'GB');
    assert.ok(res.content[0].text.includes('GB'), 'prose must name the searched market');
  });

  it('reports the SPOTIFY_MCP_MARKET default as the market searched when none is supplied', async () => {
    initConfig({ ...process.env, SPOTIFY_MCP_MARKET: 'DE' });
    try {
      const { client, calls } = recordingClient(() => ({ tracks: { items: [trackPayload()], total: 1 } }));
      const res = await handlerFor('search_by_isrc', client)({
        isrc: 'USUM71703861', response_format: 'concise',
      });
      assert.equal(getConfig().market, 'DE', 'the env default is installed for this case');
      assert.deepEqual(calls.map((c) => c.market), ['DE']);
      assert.equal(res.structuredContent?.market_used, 'DE');
    } finally {
      initConfig(process.env);
    }
  });

  it('names the token default when neither an argument nor the env supplies one', async () => {
    initConfig({ ...process.env, SPOTIFY_MCP_MARKET: undefined });
    try {
      const { client, calls } = recordingClient(() => ({ tracks: { items: [trackPayload()], total: 1 } }));
      const res = await handlerFor('search_by_isrc', client)({
        isrc: 'USUM71703861', response_format: 'concise',
      });
      assert.equal(getConfig().market, null, 'no config market is installed for this case');
      assert.deepEqual(calls.map((c) => c.market), [undefined], 'no market param is sent — the API falls back to the token');
      assert.equal(res.structuredContent?.market_used, 'from_token');
    } finally {
      initConfig(process.env);
    }
  });
});

describe('#777 find_canonical_track honours market', () => {
  it('sends the requested market on both the precise and the broad-fallback search', async () => {
    const { client, calls } = recordingClient((q) => (
      q.startsWith('track:') ? { tracks: { items: [], total: 0 } } : { tracks: { items: [trackPayload()], total: 1 } }
    ));
    const res = await handlerFor('find_canonical_track', client)({
      title: 'Song', artist: 'Artist', market: 'DE', response_format: 'concise',
    });
    assert.equal(calls.length, 2, 'precise search + broad fallback expected');
    assert.deepEqual(calls.map((c) => c.market), ['DE', 'DE']);
    assert.equal(res.structuredContent?.fallback_search, true);
    assert.equal(res.structuredContent?.market_used, 'DE');
    assert.ok(res.content[0].text.includes('DE'), 'prose must name the searched market');
  });
});
