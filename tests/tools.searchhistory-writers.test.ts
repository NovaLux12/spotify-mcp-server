/**
 * #592 — every search path writes the sidecar.
 *
 * `tools.searchhistory.test.ts` proves the readers work and that `search` feeds
 * them. It does not prove the other search tools do: a tool that searches the
 * catalog but never calls the writer leaves `search_history` and
 * `search_history_stats` empty, and no assertion in this file before #592 could
 * see it. These tests drive the tools themselves over a fake client, then read
 * the sidecar back.
 *
 * Every test here is red on a tree where the call site's `searchAndRecord` is
 * absent: the tool still runs and still returns results, and the sidecar stays
 * empty (or, for the paging and opt-out cases, holds the wrong number of
 * entries).
 */
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { SpotifyClient } from '../src/client.js';
import { registerSearchHistoryTools, loadSearchHistory } from '../src/tools/searchhistory.js';
import { registerExhaust2CatalogTools } from '../src/tools/exhaust2_catalog.js';
import { registerExhaust2ExtraTools } from '../src/tools/exhaust2_extra.js';
import { registerExhaust2PlaylistsTools } from '../src/tools/exhaust2_playlists.js';
import { registerSwarm3ShowsTools } from '../src/tools/swarm3_shows.js';
import { registerSwarm3bDiscoveryTools } from '../src/tools/swarm3b_discovery.js';
import { registerSwarm3DiscoveryTools } from '../src/tools/swarm3_discovery.js';
import { registerExhaustMiscTools } from '../src/tools/exhaustmisc.js';

type ToolResult = {
  content: Array<{ type: 'text'; text: string }>;
  structuredContent?: Record<string, unknown>;
};
type Registered = {
  name: string;
  schema: Record<string, z.ZodTypeAny>;
  handler: (args: unknown) => Promise<ToolResult>;
};
type Module = (server: McpServer, client: SpotifyClient) => void;
type Route = (path: string, params?: Record<string, string>) => unknown;

let dir: string;
let historyFile: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'shw-'));
  historyFile = join(dir, 'search-history.json');
  process.env.SPOTIFY_MCP_SEARCH_HISTORY_FILE = historyFile;
  delete process.env.SPOTIFY_MCP_SEARCH_HISTORY;
});
afterEach(async () => {
  delete process.env.SPOTIFY_MCP_SEARCH_HISTORY_FILE;
  delete process.env.SPOTIFY_MCP_SEARCH_HISTORY;
  await rm(dir, { recursive: true, force: true });
});

/**
 * Register the search-history readers over one fake client, plus whichever tool
 * modules the test drives. `getAllPages` returns nothing, so any walk inside a
 * tool is empty and a test only ever exercises the search it means to.
 */
function harness(route: Route, ...modules: Module[]) {
  const registered: Registered[] = [];
  const gets: Array<{ path: string; params?: Record<string, string> }> = [];
  const client = {
    async get(path: string, params?: Record<string, string>) {
      gets.push({ path, params });
      return route(path, params);
    },
    async getAllPages(path: string, params?: Record<string, string>) {
      gets.push({ path, params });
      return [];
    },
  } as unknown as SpotifyClient;
  const server = {
    tool(name: string, _description: string, schema: Record<string, z.ZodTypeAny>, handler: (args: unknown) => Promise<ToolResult>) {
      registered.push({ name, schema, handler });
    },
  } as unknown as McpServer;
  for (const m of modules) m(server, client);
  registerSearchHistoryTools(server, client);
  const invoke = async (name: string, args: Record<string, unknown> = {}): Promise<ToolResult> => {
    const tool = registered.find((r) => r.name === name);
    assert.ok(tool, `expected tool ${name} to be registered`);
    return tool.handler(z.object(tool.schema).parse(args));
  };
  return { invoke, gets, searchGets: () => gets.filter((g) => g.path === '/search') };
}

async function sidecarExists(): Promise<boolean> {
  try {
    await readFile(historyFile, 'utf8');
    return true;
  } catch {
    return false;
  }
}

const track = (id: string) => ({ id, name: `Track ${id}`, uri: `spotify:track:${id}`, duration_ms: 180_000, artists: [{ name: 'Queen' }], album: { name: 'A Night at the Opera', release_date: '1975-10-31' } });
const album = (id: string) => ({ id, name: `Album ${id}`, uri: `spotify:album:${id}`, album_type: 'album', release_date: '2026-01-09', artists: [{ name: 'Beta Band' }], total_tracks: 10 });
const show = (id: string) => ({ id, name: `Show ${id}`, publisher: 'Wondery', uri: `spotify:show:${id}` });
const artist = (id: string) => ({ id, name: `Artist ${id}`, uri: `spotify:artist:${id}`, genres: ['shoegaze'], popularity: 40 });

describe('search-history writers (#592)', () => {
  it('search_fresh records the composed tag:new query, not the bare one', async () => {
    // The sidecar exists so a rerun reproduces the call. Storing "noise pop"
    // would replay it without the filter that made it a *fresh* search.
    const h = harness(
      (path) => (path === '/search' ? { albums: { items: [album('a1')], total: 1 } } : undefined),
      registerExhaust2CatalogTools,
    );
    await h.invoke('search_fresh', { query: 'noise pop', types: ['album'], limit: 3, market: 'us' });

    const entries = await loadSearchHistory();
    assert.equal(entries.length, 1);
    assert.equal(entries[0]!.query, 'noise pop tag:new');
    assert.deepEqual(entries[0]!.types, ['album']);
    assert.equal(entries[0]!.limit, 3);
    // The sidecar's market must be the market that actually went on the wire:
    // a stored 'us' next to a sent 'US' would replay a different scope than the
    // one the caller was shown.
    assert.equal(entries[0]!.market, h.searchGets()[0]!.params?.market);
    assert.equal(entries[0]!.market, 'US');
    assert.deepEqual(entries[0]!.top_result_ids, ['spotify:album:a1']);
  });

  it('search_advanced records the composed filter query', async () => {
    const h = harness(
      (path) => (path === '/search' ? { albums: { items: [album('a2')], total: 1 } } : undefined),
      registerExhaust2CatalogTools,
    );
    await h.invoke('search_advanced', { fields: { artist: 'Björk', album: 'Post' }, types: ['album'], limit: 4 });

    const [entry] = await loadSearchHistory();
    assert.ok(entry, 'search_advanced wrote nothing to the sidecar');
    assert.equal(entry!.query, 'artist:"Björk" album:"Post"');
    assert.deepEqual(entry!.types, ['album']);
    assert.equal(entry!.limit, 4);
    assert.deepEqual(entry!.top_result_ids, ['spotify:album:a2']);
  });

  it('find_show_by_publisher records the publisher query with its market and offset', async () => {
    const h = harness(
      (path) => (path === '/search' ? { shows: { items: [show('s1')], total: 30 } } : undefined),
      registerSwarm3ShowsTools,
    );
    await h.invoke('find_show_by_publisher', { query: 'Wondery', market: 'us', limit: 4, offset: 10 });

    const [entry] = await loadSearchHistory();
    assert.ok(entry, 'find_show_by_publisher wrote nothing to the sidecar');
    assert.equal(entry!.query, 'Wondery');
    assert.deepEqual(entry!.types, ['show']);
    assert.equal(entry!.limit, 4);
    assert.equal(entry!.market, 'US');
    assert.equal(entry!.offset, 10);
    assert.deepEqual(entry!.top_result_ids, ['spotify:show:s1']);
  });

  it('genre_dive_search records the ids the response carried, not the trimmed rows', async () => {
    // The tool's own rows are {id, name, genres} — the id survives but the uri
    // does not. A writer fed those rows would store bare ids, and a rerun
    // would have nothing to recognise the hit by.
    const h = harness(
      (path) => (path === '/search' ? { artists: { items: [artist('ar1')], total: 1 } } : undefined),
      registerSwarm3bDiscoveryTools,
    );
    await h.invoke('genre_dive_search', { genre: 'shoegaze' });

    const [entry] = await loadSearchHistory();
    assert.ok(entry, 'genre_dive_search wrote nothing to the sidecar');
    assert.equal(entry!.query, 'genre:"shoegaze"');
    assert.deepEqual(entry!.types, ['artist']);
    assert.equal(entry!.limit, 10);
    assert.deepEqual(entry!.top_result_ids, ['spotify:artist:ar1']);
  });

  it('playlist_add_by_search records the query behind the added track', async () => {
    const h = harness(
      (path) => (path === '/search' ? { tracks: { items: [track('t9')], total: 1 } } : { name: 'Chill Mix' }),
      registerExhaust2PlaylistsTools,
    );
    await h.invoke('playlist_add_by_search', { playlist_id: 'pl1', query: 'Radiohead Paranoid Android', dry_run: true });

    const [entry] = await loadSearchHistory();
    assert.ok(entry, 'playlist_add_by_search wrote nothing to the sidecar');
    assert.equal(entry!.query, 'Radiohead Paranoid Android');
    assert.deepEqual(entry!.types, ['track']);
    assert.equal(entry!.limit, 10);
    assert.deepEqual(entry!.top_result_ids, ['spotify:track:t9']);
  });

  it('playlist_fill_from_search records one entry per query, not one per page', async () => {
    // Two queries cycled round-robin until 25 picks exist: four /search calls
    // are issued, at offsets 0, 0, 10 and 10. Only the first window of each
    // query is a search the user ran; the rest are that search continued, and
    // recording them would put four rows in `search_history` for two queries.
    const h = harness(
      (path, params) => {
        if (path !== '/search') return path === '/playlists/pl1' ? { id: 'pl1', name: 'Grow' } : undefined;
        // A full page with more to come, so `hasMore` is true and the tool
        // comes back for the second window of each query.
        return { tracks: { items: Array.from({ length: 10 }, (_, i) => track(`p${params?.offset ?? '0'}-${i}`)), total: 100 } };
      },
      registerExhaust2ExtraTools,
    );

    await h.invoke('playlist_fill_from_search', {
      playlist_id: 'pl1',
      queries: ['shoegaze', 'post-rock'],
      target_count: 25,
      dry_run: true,
    });

    assert.equal(h.searchGets().length, 4, 'both queries were paged twice — the second window is the point of the test');

    const entries = await loadSearchHistory();
    const queries = entries.map((e) => e.query).sort();
    assert.deepEqual(queries, ['post-rock', 'shoegaze'], 'one entry per query, and nothing for a continuation page');
  });

  it('a name→id resolution inside another tool is not recorded as a search', async () => {
    // find_collaborations searches for artist B only to learn its id, then
    // discards the rows. Recording that would put a plumbing query in a
    // history the user reads as "what I searched for" — so the /search runs
    // and the sidecar stays absent.
    const h = harness(
      (path) => {
        if (path === '/search') return { artists: { items: [{ id: 'B1', name: 'Beta Band', uri: 'spotify:artist:B1' }], total: 1 } };
        if (path.startsWith('/artists/')) return { id: 'A1', name: 'Alpha Band' };
        return undefined;
      },
      registerSwarm3DiscoveryTools,
    );
    await h.invoke('find_collaborations', { artist_a: '4aXy9bQw2LmN0pQrStUvWx', artist_b: 'Beta Band' });

    assert.ok(h.searchGets().length >= 1, 'the tool did resolve artist B through /search');
    assert.equal(await sidecarExists(), false, 'an id resolution must not land in the search history');
  });

  it('a search that returns nothing on a wired path records nothing', async () => {
    const h = harness(
      (path) => (path === '/search' ? { albums: { items: [], total: 0 } } : undefined),
      registerExhaust2CatalogTools,
    );
    const out = await h.invoke('search_fresh', { query: 'nothing at all', types: ['album'] });
    assert.match(out.content[0]!.text, /No tag:new matches/i);
    assert.equal(await sidecarExists(), false);
  });

  it('search_history and search_history_stats both report a search run through a wired tool', async () => {
    const h = harness(
      (path) => (path === '/search' ? { albums: { items: [album('a1')], total: 1 } } : undefined),
      registerExhaust2CatalogTools,
      registerExhaustMiscTools,
    );
    await h.invoke('search_fresh', { query: 'noise pop', types: ['album'] });

    const history = await h.invoke('search_history', {});
    assert.match(history.content[0]!.text, /noise pop tag:new/);

    const stats = await h.invoke('search_history_stats', {});
    assert.equal(stats.structuredContent?.total, 1, 'the stats reader counts the wired tool\'s search');
    assert.deepEqual(stats.structuredContent?.top_queries, [{ query: 'noise pop tag:new', count: 1 }]);
  });
});
