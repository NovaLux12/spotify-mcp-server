import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { registerCatalogTools } from '../src/tools/catalog.js';
import { registerExhaust2CatalogTools } from '../src/tools/exhaust2_catalog.js';
import { getConfig, initConfig } from '../src/config.js';
import type { SpotifyClient } from '../src/client.js';

/**
 * #780: `resolveMaxResults` falls back to `getConfig().maxItems`, so
 * SPOTIFY_MCP_MAX_ITEMS caps every list tool that omits max_results — not just
 * the call sites that pass the config-aware fallback themselves. Both a catalog
 * tool and an exhaust2 tool are exercised here so a regression cannot hide in
 * one module: an explicit `getConfig().maxItems` argument at a single call site
 * would make that module pass while the other keeps the old hardcoded default.
 */

type ToolResult = {
  content: Array<{ type: string; text: string }>;
  structuredContent?: Record<string, unknown>;
};
type Handler = (args: Record<string, unknown>) => Promise<ToolResult>;

const ARTIST = { id: 'a1', name: 'Artist', uri: 'spotify:artist:a1' };
const MAX_ITEMS = 5;

function albums(count: number) {
  return Array.from({ length: count }, (_, i) => ({
    id: `al${i + 1}`,
    name: `Album ${i + 1}`,
    uri: `spotify:album:al${i + 1}`,
    album_type: 'album',
    release_date: '2020-01-01',
    total_tracks: 3,
    artists: [ARTIST],
  }));
}

function tracks(count: number) {
  return Array.from({ length: count }, (_, i) => ({
    id: `t${i + 1}`,
    name: `Track ${i + 1}`,
    uri: `spotify:track:t${i + 1}`,
    duration_ms: 200_000,
    explicit: false,
    track_number: i + 1,
    artists: [ARTIST],
    album: { id: 'al1', name: 'Album 1', release_date: '2020-01-01', album_type: 'album', total_tracks: count },
  }));
}

/**
 * `get_artist_albums` without fetch_all reads one page of at most
 * ARTIST_ALBUM_PAGE_LIMIT albums, so a full page is what makes the configured
 * cap observable on the catalog side.
 */
const PAGE = 10;

function stubClient() {
  return {
    get: async (path: string, params?: Record<string, string>) => {
      if (path.endsWith('/tracks')) return { tracks: tracks(40) };
      if (path === '/albums') return { albums: [{ id: 'al1', name: 'Album 1', release_date: '2020-01-01', album_type: 'album', label: 'Label' }] };
      if (path === '/artists') return { artists: [{ id: 'a1', name: 'Artist', genres: ['pop'] }] };
      if (path.endsWith('/albums')) {
        const offset = Number(params?.offset ?? 0);
        return { items: albums(PAGE), total: 40, limit: PAGE, offset };
      }
      return null;
    },
    getAllPages: async () => albums(40),
    getAllPagesWithTruncation: async () => ({ items: tracks(40), truncated: false, pages: 1, stopped: 'exhausted' }),
    put: async () => null,
    post: async () => null,
    delete: async () => null,
  } as unknown as SpotifyClient;
}

function handlerFor(register: (server: McpServer, client: SpotifyClient) => void, name: string, client: SpotifyClient): Handler {
  let captured: Handler | undefined;
  const server = {
    tool(toolName: string, _description: string, _shape: unknown, handler: Handler) {
      if (toolName === name) captured = handler;
    },
  } as unknown as McpServer;
  register(server, client);
  if (!captured) throw new Error(`tool ${name} not registered`);
  return captured;
}

/** The zod shape a tool registered, so the advertised default can be read at runtime. */
function shapeFor(register: (server: McpServer, client: SpotifyClient) => void, name: string, client: SpotifyClient): Record<string, { description?: string }> {
  let captured: Record<string, { description?: string }> | undefined;
  const server = {
    tool(toolName: string, _description: string, shape: Record<string, { description?: string }>, _handler: Handler) {
      if (toolName === name) captured = shape;
    },
  } as unknown as McpServer;
  register(server, client);
  if (!captured) throw new Error(`tool ${name} not registered`);
  return captured;
}

/** Count the item rows a prose response actually shows, ignoring headers/footers. */
function proseRows(text: string): number {
  return text.split('\n').filter((line) => /^\s*(•|#\d+\.)/.test(line)).length;
}

function structuredRows(result: ToolResult, key: string): number {
  const rows = result.structuredContent?.[key];
  return Array.isArray(rows) ? rows.length : -1;
}

describe('SPOTIFY_MCP_MAX_ITEMS caps every tool that omits max_results (#780)', () => {
  const previous = process.env.SPOTIFY_MCP_MAX_ITEMS;

  before(() => {
    initConfig({ ...process.env, SPOTIFY_MCP_MAX_ITEMS: String(MAX_ITEMS) });
  });

  after(() => {
    if (previous === undefined) delete process.env.SPOTIFY_MCP_MAX_ITEMS;
    else process.env.SPOTIFY_MCP_MAX_ITEMS = previous;
    initConfig(process.env);
  });

  it('truncates a catalog list tool to the configured cap', async () => {
    const result = await handlerFor(registerCatalogTools, 'get_artist_albums', stubClient())({ id: 'a1' });
    assert.equal(proseRows(result.content[0].text), MAX_ITEMS, 'get_artist_albums prose');
    assert.equal(structuredRows(result, 'items'), MAX_ITEMS, 'get_artist_albums structuredContent');
  });

  it('truncates an exhaust2 list tool to the same configured cap', async () => {
    const result = await handlerFor(registerExhaust2CatalogTools, 'track_enrichment_batch', stubClient())({
      track_ids: tracks(40).map((t) => t.id),
    });
    assert.equal(proseRows(result.content[0].text), MAX_ITEMS, 'track_enrichment_batch prose');
    assert.equal(structuredRows(result, 'tracks'), MAX_ITEMS, 'track_enrichment_batch structuredContent');
  });

  it('reports the same total for both, so the two modules cannot diverge', async () => {
    const client = stubClient();
    const catalog = await handlerFor(registerCatalogTools, 'get_artist_albums', client)({ id: 'a1' });
    const exhaust = await handlerFor(registerExhaust2CatalogTools, 'track_enrichment_batch', client)({
      track_ids: tracks(40).map((t) => t.id),
    });
    assert.equal(proseRows(catalog.content[0].text), proseRows(exhaust.content[0].text));
    assert.equal(proseRows(catalog.content[0].text), MAX_ITEMS);
  });

  it('leaves an explicit max_results ahead of the configured cap', async () => {
    const result = await handlerFor(registerCatalogTools, 'get_artist_albums', stubClient())({ id: 'a1', max_results: 3 });
    assert.equal(proseRows(result.content[0].text), 3);
  });
});

/**
 * A walk-bounded tool (#337 timeline, #350 episode timeline, #349 chapter map)
 * deliberately returns its whole fetch-all walk rather than the
 * SPOTIFY_MCP_MAX_ITEMS page, so its advertised default and its payload must
 * name the bound that actually applies instead of the configured page cap.
 */
describe('walk-bounded catalog tools advertise and disclose the fetch-all bound (#780)', () => {
  const previous = process.env.SPOTIFY_MCP_MAX_ITEMS;

  before(() => {
    initConfig({ ...process.env, SPOTIFY_MCP_MAX_ITEMS: String(MAX_ITEMS) });
  });

  after(() => {
    if (previous === undefined) delete process.env.SPOTIFY_MCP_MAX_ITEMS;
    else process.env.SPOTIFY_MCP_MAX_ITEMS = previous;
    initConfig(process.env);
  });

  const WALK_BOUNDED = ['artist_discography_timeline', 'show_episode_timeline', 'audiobook_chapter_map'];

  for (const tool of WALK_BOUNDED) {
    it(`${tool} advertises the fetch-all bound, not SPOTIFY_MCP_MAX_ITEMS`, () => {
      const shape = shapeFor(registerExhaust2CatalogTools, tool, stubClient());
      assert.match(String(shape.max_results?.description), /SPOTIFY_MCP_FETCH_ALL_CAP/);
      assert.doesNotMatch(String(shape.max_results?.description), /SPOTIFY_MCP_MAX_ITEMS/);
    });
  }

  it('discloses in payload and prose when the discography walk hit the bound', async () => {
    const cap = getConfig().fetchAllCap;
    const client = { ...stubClient(), getAllPages: async () => albums(cap) } as unknown as SpotifyClient;
    const result = await handlerFor(registerExhaust2CatalogTools, 'artist_discography_timeline', client)({ artist_id: 'a1' });
    assert.equal(result.structuredContent?.fetch_all_cap, cap);
    assert.equal(result.structuredContent?.truncated_by_cap, true);
    assert.ok(result.content[0].text.includes('fetch-all cap REACHED'));
    assert.ok(proseRows(result.content[0].text) > MAX_ITEMS, 'the walk is returned whole, not capped at the page size');
  });

  it('reports a complete walk as uncapped when it stopped short of the bound', async () => {
    const cap = getConfig().fetchAllCap;
    const client = { ...stubClient(), getAllPages: async () => albums(cap - 1) } as unknown as SpotifyClient;
    const result = await handlerFor(registerExhaust2CatalogTools, 'artist_discography_timeline', client)({ artist_id: 'a1' });
    assert.equal(result.structuredContent?.truncated_by_cap, false);
    assert.ok(!result.content[0].text.includes('fetch-all cap REACHED'));
  });

  it('discloses the bound on the chapter map payload as well as in prose', async () => {
    const cap = getConfig().fetchAllCap;
    const chapters = Array.from({ length: cap }, (_, i) => ({
      id: `c${i}`,
      name: `Chapter ${i}`,
      uri: `u${i}`,
      chapter_number: i,
      duration_ms: 60_000,
      release_date: '2020',
      explicit: false,
      description: '',
      is_playable: true,
    }));
    const book = {
      id: 'ab1', name: 'Dune', uri: 'u', authors: [{ name: 'FH' }], narrators: [],
      total_chapters: cap, release_date: '2020', description: '', explicit: false,
      media_type: 'audio', languages: ['en'],
    };
    const client = {
      ...stubClient(),
      get: async (path: string) => (path.includes('/chapters') ? null : book),
      getAllPages: async () => chapters,
    } as unknown as SpotifyClient;
    const result = await handlerFor(registerExhaust2CatalogTools, 'audiobook_chapter_map', client)({ audiobook_id: 'ab1' });
    assert.equal(result.structuredContent?.fetch_all_cap, cap);
    assert.equal(result.structuredContent?.truncated_by_cap, true);
    assert.ok(result.content[0].text.includes('fetch-all cap REACHED'));
  });
});