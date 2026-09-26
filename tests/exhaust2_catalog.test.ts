import { describe, it, mock } from 'node:test';
import assert from 'node:assert/strict';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerExhaust2CatalogTools } from '../src/tools/exhaust2_catalog.js';
import { registerArtistWatchTools } from '../src/tools/artistwatch.js';
import { SpotifyApiError, SpotifyClient } from '../src/client.js';
import { installGatedPathContract } from '../src/gating.js';
import { PER_ID_FANOUT_WIDTH } from '../src/tools/catalog.js';
import { initConfig } from '../src/config.js';

type Handler = (args: Record<string, unknown>) => Promise<{
  content: Array<{ type: string; text: string }>;
  structuredContent?: Record<string, unknown>;
}>;

function makeClient(overrides: Record<string, unknown> = {}) {
  return {
    get: mock.fn(async () => null),
    getAllPages: mock.fn(async () => []),
    put: mock.fn(async () => null),
    post: mock.fn(async () => null),
    delete: mock.fn(async () => null),
    ...overrides,
  } as unknown as import('../src/client.js').SpotifyClient;
}

function handlerFor(name: string, client: ReturnType<typeof makeClient>): Handler {
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

/**
 * The declared input shape for a tool, rebuilt as a real zod object. The MCP
 * server validates arguments against this before the handler runs
 * (see installToolErrorBoundary), so schema-level behaviour has to be probed
 * here rather than through `handlerFor`, which hands args straight to the
 * handler and would bypass validation entirely.
 */
function shapeFor(name: string, client: SpotifyClient): z.ZodObject<z.ZodRawShape> {
  let captured: unknown;
  const server = {
    tool(n: string, _desc: string, shape: unknown, _h: Handler) {
      if (n === name) captured = shape;
    },
  } as unknown as McpServer;
  registerExhaust2CatalogTools(server, client);
  if (!captured) throw new Error(`tool ${name} not registered`);
  return z.object(captured as z.ZodRawShape);
}

/**
 * The first offending parameter name, mirroring annotations.ts `validationParam`,
 * which is what the error boundary reports back to the caller.
 */
function offendingParam(error: { issues: ReadonlyArray<{ path: ReadonlyArray<unknown> }> }): string | undefined {
  for (const issue of error.issues) {
    const first = issue.path[0];
    if (typeof first === 'string' && first.length > 0) return first;
  }
  return undefined;
}

function allToolNames(client: ReturnType<typeof makeClient>): string[] {
  const names: string[] = [];
  const server = { tool(name: string) { names.push(name); } } as unknown as McpServer;
  registerExhaust2CatalogTools(server, client);
  return names;
}

const artist = { id: 'a1', name: 'Artist', uri: 'spotify:artist:a1' };

function trackPayload(overrides: Record<string, unknown> = {}) {
  return {
    id: 't1', uri: 'spotify:track:t1', name: 'Song', type: 'track', duration_ms: 200_000, explicit: false,
    artists: [artist],
    album: { id: 'alb1', name: 'Album', uri: 'spotify:album:alb1', images: [], release_date: '2021-03-05', album_type: 'album', total_tracks: 3 },
    external_ids: { isrc: 'USXXX0000001' },
    ...overrides,
  };
}

/**
 * #1224: the album payload a single `GET /albums/{id}` read returns. The
 * `?ids=` batch route is gone, so every fixture below serves this per id
 * rather than a `{ albums: [...] }` array.
 */
function albumPayload(overrides: Record<string, unknown> = {}) {
  return {
    id: 'alb1', name: 'Album', uri: 'spotify:album:alb1', album_type: 'album',
    release_date: '2021-03-05', total_tracks: 3, artists: [artist], images: [],
    label: 'Big Records', tracks: { items: [], total: 3 },
    ...overrides,
  };
}

/**
 * A real-walk client for #774: `get` serves genuinely paginated album-track
 * responses and the PROTOTYPE `getAllPagesWithTruncation` does the walking, so
 * these tests exercise the production paging loop and its truncation verdict
 * rather than a re-implementation of it. Track i+1 has duration (i+1)ms, so
 * the expected statistics are computable by hand.
 */
function pagedAlbumClient(rowCount: number, albumTotalTracks: number) {
  const rows = Array.from({ length: rowCount }, (_, i) => ({
    id: `t${i + 1}`, name: `Track ${i + 1}`, uri: `spotify:track:t${i + 1}`,
    duration_ms: (i + 1) * 1000, explicit: false, track_number: i + 1, artists: [artist],
  }));
  const offsets: string[] = [];
  const client = Object.create(SpotifyClient.prototype) as unknown as {
    get: (path: string, params?: Record<string, string>) => Promise<unknown>;
    fetchAllCap?: number;
    walkCounter: number;
    progressReporter: null;
  };
  client.get = async (path: string, params?: Record<string, string>) => {
    if (!path.endsWith('/tracks')) {
      return {
        id: 'alb1', name: 'Album', uri: 'spotify:album:alb1', album_type: 'album',
        release_date: '2021', artists: [artist], images: [],
        total_tracks: albumTotalTracks, tracks: { items: [], total: albumTotalTracks },
      };
    }
    const offset = Number(params?.offset ?? 0);
    const limit = Number(params?.limit ?? 50);
    offsets.push(String(offset));
    return { items: rows.slice(offset, offset + limit), total: rows.length, limit, offset };
  };
  client.walkCounter = 0;
  client.progressReporter = null;
  return { client, rows, offsets };
}

/** Install a fetch-all cap for the duration of `fn`, then restore the env snapshot. */
async function withFetchAllCap<T>(cap: number, fn: () => Promise<T>): Promise<T> {
  initConfig({ ...process.env, SPOTIFY_MCP_FETCH_ALL_CAP: String(cap) });
  try {
    return await fn();
  } finally {
    initConfig(process.env);
  }
}

const EXPECTED_TOOLS = 19;

/** Every exhaust2 tool that declares a `market` parameter, sorted. */
const MARKET_TOOLS = [
  'album_track_stats',
  'albums_runtime_batch',
  'artist_collab_network',
  'audiobooks_by_author',
  'episode_context_bundle',
  'find_canonical_track',
  'search_advanced',
  'search_by_isrc',
  'search_fresh',
  'show_episode_timeline',
  'show_runtime_stats',
  'track_album_bundle',
];

describe('exhaust2_catalog — registry', () => {
  it('registers exactly 19 tools', () => {
    const names = allToolNames(makeClient());
    assert.equal(names.length, EXPECTED_TOOLS);
    assert.equal(new Set(names).size, EXPECTED_TOOLS);
  });

  // #775: these 12 tools each declared their own `z.string().optional()`
  // market, so a lowercase code was forwarded verbatim and "usa" became an
  // opaque Spotify 400 instead of a schema rejection.
  it('validates and uppercases market on every tool that takes one', () => {
    type Field = { safeParse(v: unknown): { success: boolean; data?: unknown } };
    const shapes = new Map<string, Record<string, Field>>();
    const server = {
      tool(name: string, _desc: string, shape: Record<string, Field>) { shapes.set(name, shape); },
    } as unknown as McpServer;
    registerExhaust2CatalogTools(server, makeClient());

    const withMarket = [...shapes.entries()].filter(([, shape]) => shape.market);
    assert.deepEqual(
      withMarket.map(([name]) => name).sort(),
      MARKET_TOOLS,
      'these are the exhaust2 tools that declare a market parameter',
    );
    for (const [name, shape] of withMarket) {
      assert.equal(shape.market.safeParse('usa').success, false, `${name} must reject "usa"`);
      assert.equal(shape.market.safeParse('english').success, false, `${name} must reject "english"`);
      assert.equal(shape.market.safeParse('U').success, false, `${name} must reject a 1-letter code`);
      assert.equal(shape.market.safeParse('us').data, 'US', `${name} must uppercase "us"`);
      assert.equal(shape.market.safeParse('gb').data, 'GB', `${name} must uppercase "gb"`);
    }
  });
});

describe('catalog tools (#335-#342)', () => {
  it('search_advanced composes filters and errors with no fields', async () => {
    const client = makeClient({
      get: mock.fn(async (_p: string, params?: Record<string, string>) => {
        assert.equal(params?.q, 'artist:"Adele" year:2000-2010 tag:new');
        assert.equal(params?.type, 'track');
        return { tracks: { items: [trackPayload()], total: 1 } };
      }),
    });
    const res = await handlerFor('search_advanced', client)({
      fields: { artist: 'Adele', year_range: { from: 2000, to: 2010 }, tag: 'new' },
      response_format: 'concise',
    });
    assert.ok(res.content[0].text.includes('Advanced search'));
    await assert.rejects(handlerFor('search_advanced', makeClient())({ fields: {}, response_format: 'concise' }));
  });

  it('track_album_bundle merges track + album tracks', async () => {
    const client = makeClient({
      get: mock.fn(async (path: string) => {
        if (path.startsWith('/tracks/')) return trackPayload();
        if (path.includes('/albums/alb1/tracks')) {
          return { items: [
            { id: 't1', name: 'Song', uri: 'spotify:track:t1', duration_ms: 200_000, explicit: false, track_number: 1, artists: [artist] },
            { id: 't2', name: 'Other', uri: 'spotify:track:t2', duration_ms: 100_000, explicit: false, track_number: 2, artists: [artist] },
          ], total: 2 };
        }
        return null;
      }),
    });
    const res = await handlerFor('track_album_bundle', client)({ track_id: 't1', response_format: 'concise' });
    assert.ok(res.content[0].text.includes('Album: Album (2021)'));
    assert.ok(res.content[0].text.includes('← this track'));
assert.equal((res.structuredContent as { album_tracks: unknown[] }).album_tracks.length, 2);
  });

  it('artist_discography_timeline sorts newest first and honors since_year', async () => {
    const client = makeClient({
      getAllPages: mock.fn(async () => [
        { id: 'a', name: 'Old', uri: 'u', album_type: 'album', release_date: '1999-01-01', total_tracks: 10, artists: [artist], images: [] },
        { id: 'b', name: 'New', uri: 'u', album_type: 'single', release_date: '2023-05-01', total_tracks: 2, artists: [artist], images: [] },
      ]),
    });
    const res = await handlerFor('artist_discography_timeline', client)({ artist_id: 'a1', since_year: 2000, response_format: 'concise' });
    const text = res.content[0].text;
    assert.ok(text.includes('New') && text.includes('2023-05-01'));
    assert.ok(!text.includes('Old'));
  });

  it('search_fresh appends tag:new to the query', async () => {
    const client = makeClient({
      get: mock.fn(async (_p: string, params?: Record<string, string>) => {
        assert.equal(params?.q, 'Noise Pop tag:new');
        return { albums: { items: [], total: 0 }, tracks: { items: [], total: 0 } };
      }),
    });
    const res = await handlerFor('search_fresh', client)({ query: 'Noise Pop', response_format: 'concise' });
    assert.ok(res.content[0].text.includes('nothing in the last ~2 weeks'));
  });

  it('track_enrichment_batch fans in albums and artists', async () => {
    const client = makeClient({
      get: mock.fn(async (path: string) => {
        if (path === '/tracks/t1') return trackPayload();
        if (path === '/albums/alb1') return albumPayload();
        if (path === '/artists/a1') return { ...artist, genres: ['indie rock'] };
        return null;
      }),
    });
    const res = await handlerFor('track_enrichment_batch', client)({ track_ids: ['t1'], response_format: 'concise' });
    assert.ok(res.content[0].text.includes('Big Records'));
    const row = (res.structuredContent as { tracks: Array<{ artist_genres: Record<string, string[]> }> }).tracks[0];
    assert.deepEqual(row.artist_genres.Artist, ['indie rock']);
  });

  // #1004: `GET /artists?ids=` is one of the endpoints Spotify's February 2026
  // changelog removed outright. A removed route can only fail, and the old
  // graceful-403 wrapper would have degraded it into a quiet "this artist has
  // no genres" answer. Every artist read in this module has to go out as
  // `GET /artists/{id}` or not at all — this asserts the call log, so a
  // reintroduced batch call fails here rather than in production.
  // #1224 widened it to the album and track routes, which had no per-id
  // fallback at all and hard-failed rather than degrading.
  it('never requests the removed batch artist/album/track routes (#1004, #1224)', async () => {
    const paths: string[] = [];
    const client = makeClient({
      get: mock.fn(async (path: string) => {
        paths.push(path);
        if (path === '/tracks/t1') return trackPayload();
        if (path === '/albums/alb1') return albumPayload();
        // The removed routes answer with a perfectly good batch payload here,
        // on purpose. A fixture that 404s them would make the tools fail for a
        // second, unrelated reason and bury the real signal; this way the
        // ONLY thing that can fail the test is a tool actually asking for one.
        if (path === '/artists' || path.startsWith('/artists?')) {
          return { artists: [{ ...artist, genres: ['indie rock'] }] };
        }
        if (path === '/tracks') return { tracks: [trackPayload()] };
        if (path === '/albums') return { albums: [albumPayload()] };
        if (path === '/artists/a1') return { ...artist, genres: ['indie rock'] };
        return null;
      }),
    });
    await handlerFor('track_enrichment_batch', client)({ track_ids: ['t1'], response_format: 'json' });
    await handlerFor('artist_genres_compact', client)({ artist_ids: ['a1'], response_format: 'json' });
    const batchReads = paths.filter((p) => ['/artists', '/tracks', '/albums'].includes(p.split('?')[0]));
    assert.deepEqual(batchReads, [], `a removed-endpoint request went out: ${paths.join(', ')}`);
    assert.ok(paths.includes('/artists/a1'), 'the per-id read is what replaced it');
    assert.ok(paths.includes('/tracks/t1'), 'the track leg reads per id');
    assert.ok(paths.includes('/albums/alb1'), 'the album leg reads per id');
  });

  // #1004: the per-id leg costs one request per distinct artist, so the tool
  // has to publish that number. Quoting the batch endpoint's old "one call"
  // would be a false claim about a request count the caller pays for.
  it('track_enrichment_batch publishes the per-id request count (#1004)', async () => {
    const client = makeClient({
      get: mock.fn(async (path: string) => {
        if (path === '/tracks/t1') return trackPayload({ id: 't1', artists: [{ id: 'a1', name: 'A', uri: 'u' }] });
        if (path === '/tracks/t2') return trackPayload({ id: 't2', artists: [{ id: 'a1', name: 'A', uri: 'u' }, { id: 'a2', name: 'B', uri: 'u' }] });
        if (path === '/tracks/t3') return trackPayload({ id: 't3', artists: [{ id: 'a3', name: 'C', uri: 'u' }] });
        if (path === '/albums/alb1') return albumPayload();
        if (path === '/artists/a1') return { id: 'a1', name: 'A', uri: 'u', genres: ['pop'] };
        if (path === '/artists/a2') return { id: 'a2', name: 'B', uri: 'u', genres: ['jazz'] };
        if (path === '/artists/a3') return { id: 'a3', name: 'C', uri: 'u', genres: ['soul'] };
        return null;
      }),
    });
    const res = await handlerFor('track_enrichment_batch', client)({ track_ids: ['t1', 't2', 't3'], response_format: 'json' });
    const counts = (res.structuredContent as { counts: Record<string, unknown> }).counts;
    // Three distinct artists, not four rows: a2 appears on one track only.
    assert.equal(counts.artist_requests, 3);
    assert.equal(counts.artists_fetched, 3);
    assert.deepEqual(counts.artist_ids_unresolved, []);
    // #1224: the album leg is a fan-out too, so it publishes its own count
    // rather than borrowing the batch endpoint's old "one call".
    assert.equal(counts.album_requests, 1);
    assert.deepEqual(counts.album_ids_unresolved, []);
  });

  // #1004: an artist whose per-id read failed must be named, with its reason.
  // A row reporting `artist_genres: []` for an unread artist is
  // indistinguishable from an artist Spotify simply has no tags for.
  it('track_enrichment_batch names the artists it could not read (#1004)', async () => {
    const client = makeClient({
      get: mock.fn(async (path: string) => {
        if (path === '/tracks/t1') return trackPayload({ id: 't1', artists: [{ id: 'a1', name: 'A', uri: 'u' }, { id: 'dead', name: 'Dead', uri: 'u' }] });
        if (path === '/artists/a1') return { id: 'a1', name: 'A', uri: 'u', genres: ['pop'] };
        if (path === '/artists/dead') throw new SpotifyApiError(404, 'Not found');
        return null;
      }),
    });
    const res = await handlerFor('track_enrichment_batch', client)({ track_ids: ['t1'], response_format: 'json' });
    const counts = (res.structuredContent as { counts: Record<string, unknown> }).counts;
    assert.deepEqual(counts.artist_ids_unresolved, ['dead']);
    assert.equal(counts.artists_fetched, 1);
    const reasons = counts.artist_unresolved as Array<{ id: string; reason: string }>;
    assert.equal(reasons.length, 1);
    assert.match(reasons[0].reason, /Not found/);
  });

  // #1093: counts already existed for this tool (#335), but the missing_ids
  // list was not. Without it the caller cannot distinguish a smaller lookup
  // from a fully-resolved one — the counts alone do not say which ids were
  // dropped.
  it('track_enrichment_batch names the ids it could not resolve (#1093)', async () => {
    const DEAD = '0000000000000000000001';
    const client = makeClient({
      get: mock.fn(async (path: string) => {
        if (path === '/tracks/t1') return trackPayload();
        if (path === `/tracks/${DEAD}`) throw new SpotifyApiError(404, 'Not found');
        if (path === '/albums/alb1') return albumPayload();
        if (path === '/artists/a1') return { ...artist, genres: ['indie rock'] };
        return null;
      }),
    });
    const res = await handlerFor('track_enrichment_batch', client)({
      track_ids: ['t1', DEAD],
      response_format: 'concise',
    });
    const counts = (res.structuredContent as { counts: Record<string, unknown> }).counts;
    assert.deepEqual(counts.missing_ids, [DEAD]);
    assert.equal(counts.requested, 2);
    assert.equal(counts.resolved, 1);
    // requested == resolved + missing_ids.length must hold, so the counts are
    // self-consistent and a caller can trust them.
    assert.equal(
      (counts.requested as number),
      (counts.resolved as number) + (counts.missing_ids as string[]).length,
    );
    // #1224: the ids are still named WITH the reason they could not be read,
    // which a positional null slot could not carry.
    const trackUnresolved = counts.track_unresolved as Array<{ id: string; reason: string; status: number }>;
    assert.deepEqual(trackUnresolved.map((u) => u.id), [DEAD]);
    assert.match(trackUnresolved[0].reason, /Not found/);
  });
});

describe('statistics + local-compute tools', () => {
  it('albums_runtime_batch computes totals and means, flags partial', async () => {
    const client = makeClient({
      get: mock.fn(async (path: string) => {
        if (path !== '/albums/alb1') return null;
        return albumPayload({
          id: 'alb1', uri: 'u', release_date: '2021', total_tracks: 3, tracks: { items: [
            { id: 't1', name: 'a', uri: 'u', duration_ms: 60_000, explicit: false, track_number: 1, artists: [artist] },
            { id: 't2', name: 'b', uri: 'u', duration_ms: 120_000, explicit: false, track_number: 2, artists: [artist] },
          ], total: 2 },
        });
      }),
    });
    const res = await handlerFor('albums_runtime_batch', client)({ album_ids: ['alb1'], response_format: 'concise' });
    assert.ok(res.content[0].text.includes('total 3:00'));
    assert.ok(res.content[0].text.includes('mean 1:30'));
    assert.equal((res.structuredContent as { albums: Array<{ partial_estimate: boolean }> }).albums[0].partial_estimate, false);
  });

  // #1093: a null slot is an id the endpoint could not resolve. The header
  // still says "(N albums)" for the resolved count, but the prose must name
  // the unresolved ids and structuredContent must account for them — a
  // resolved count alone leaves the caller unable to tell "Spotify dropped it"
  // from "the caller never asked for it". Mirrors the #778 several-* pattern.
  // #1224 changed the read to per id, so the "unresolvable" id is now a failed
  // request rather than a null slot; the accounting is asserted unchanged.
  it('albums_runtime_batch names unresolved ids in prose and counts (#1093)', async () => {
    const DEAD = '0000000000000000000000';
    const client = makeClient({
      get: mock.fn(async (path: string) => {
        if (path === '/albums/alb1') {
          return albumPayload({ id: 'alb1', uri: 'u', release_date: '2021', total_tracks: 1, tracks: { items: [
            { id: 't1', name: 'a', uri: 'u', duration_ms: 60_000, explicit: false, track_number: 1, artists: [artist] },
          ], total: 1 } });
        }
        if (path === `/albums/${DEAD}`) throw new SpotifyApiError(404, 'Not found');
        return null;
      }),
    });
    const res = await handlerFor('albums_runtime_batch', client)({
      album_ids: ['alb1', DEAD],
      response_format: 'concise',
    });
    const text = res.content[0].text;
    // The header still reports the resolved count (matches #778 several-*
    // convention), and the unresolved note names the dropped id.
    assert.match(text, /Runtime per album \(1 album\):/);
    assert.match(text, new RegExp(`1 id unresolved: ${DEAD}`));
    // structuredContent counts the request honestly: requested = 2, resolved
    // = 1, missing_ids carries the dropped id. requested == resolved +
    // missing_ids.length must always hold.
    assert.deepEqual((res.structuredContent as { counts: Record<string, unknown> }).counts, {
      requested: 2,
      resolved: 1,
      missing_ids: [DEAD],
    });
    // ...and the reason travels with the id, so the caller never has to guess
    // whether Spotify dropped it or the request failed.
    const unresolved = (res.structuredContent as { album_unresolved: Array<{ id: string; reason: string }> }).album_unresolved;
    assert.deepEqual(unresolved.map((u) => u.id), [DEAD]);
    assert.match(unresolved[0].reason, /Not found/);
  });

  it('albums_runtime_batch with no unresolved ids reports an empty missing_ids (#1093)', async () => {
    const client = makeClient({
      get: mock.fn(async (path: string) => {
        if (path !== '/albums/alb1') return null;
        return albumPayload({ id: 'alb1', uri: 'u', release_date: '2021', total_tracks: 1, tracks: { items: [
          { id: 't1', name: 'a', uri: 'u', duration_ms: 60_000, explicit: false, track_number: 1, artists: [artist] },
        ], total: 1 } });
      }),
    });
    const res = await handlerFor('albums_runtime_batch', client)({ album_ids: ['alb1'], response_format: 'concise' });
    const text = res.content[0].text;
    assert.ok(!/unresolved/.test(text), 'nothing was dropped, so nothing is disclosed');
    assert.deepEqual((res.structuredContent as { counts: Record<string, unknown> }).counts, {
      requested: 1,
      resolved: 1,
      missing_ids: [],
    });
  });

  it('album_track_stats returns min/max/mean/median + longest', async () => {
    const { client } = pagedAlbumClient(3, 3);
    const res = await handlerFor('album_track_stats', client as never)({ album_id: 'alb1', response_format: 'concise' });
    const stats = (res.structuredContent as { stats: { min_ms: number; max_ms: number; mean_ms: number; median_ms: number } }).stats;
    assert.equal(stats.min_ms, 1_000);
    assert.equal(stats.max_ms, 3_000);
    assert.equal(stats.median_ms, 2_000);
    assert.ok(res.content[0].text.includes('"Track 3"'));
  });

  // #774: a short album is complete and says so — no partial flag. Cannot pass
  // vacuously: the fixture reports tracks.total = 3 and the walk returns 3.
  it('album_track_stats reports no partial flag for a fully-walked short album', async () => {
    const { client, offsets } = pagedAlbumClient(3, 3);
    const res = await handlerFor('album_track_stats', client as never)({ album_id: 'alb1', response_format: 'concise' });
    const stats = (res.structuredContent as { stats: { track_count: number; tracks_listed: number; partial_estimate: boolean } }).stats;
    assert.equal(stats.track_count, 3);
    assert.equal(stats.tracks_listed, 3);
    assert.equal(stats.partial_estimate, false);
    assert.deepEqual(offsets, ['0']);
    assert.ok(!res.content[0].text.includes('PARTIAL'));
  });

  // #774: 120 tracks over 3 pages. Pre-fix this read ONE page of 50 and
  // reported track_count 50 with no completeness signal.
  it('album_track_stats walks every page: 120 tracks over 3 pages', async () => {
    const { client, offsets } = pagedAlbumClient(120, 120);
    const res = await handlerFor('album_track_stats', client as never)({ album_id: 'alb1', response_format: 'concise' });
    const stats = (res.structuredContent as {
      stats: { track_count: number; tracks_listed: number; partial_estimate: boolean; min_ms: number; max_ms: number; mean_ms: number; median_ms: number; total_runtime_ms: number };
    }).stats;
    assert.deepEqual(offsets, ['0', '50', '100']);
    assert.equal(stats.track_count, 120);
    assert.equal(stats.tracks_listed, 120);
    assert.equal(stats.partial_estimate, false);
    // Hand-computed over all 120 durations (1000..120000 ms).
    assert.equal(stats.min_ms, 1_000);
    assert.equal(stats.max_ms, 120_000);
    assert.equal(stats.mean_ms, 60_500);
    assert.equal(stats.median_ms, 60_500);
    assert.equal(stats.total_runtime_ms, 7_260_000);
    assert.ok(res.content[0].text.includes('(120 listed tracks)'));
    assert.ok(!res.content[0].text.includes('PARTIAL'));
  });

  // #774: when the walk IS cut off by the cap, the numbers cover only the
  // walked window and the payload plus the prose must say so.
  it('album_track_stats flags a cap-truncated walk instead of reporting it as the album', async () => {
    const { client, offsets } = pagedAlbumClient(200, 200);
    const res = await withFetchAllCap(60, () =>
      handlerFor('album_track_stats', client as never)({ album_id: 'alb1', response_format: 'concise' }));
    const stats = (res.structuredContent as {
      stats: { track_count: number; tracks_listed: number; partial_estimate: boolean; total_runtime_ms: number };
    }).stats;
    assert.equal(stats.track_count, 60);
    assert.equal(stats.tracks_listed, 200);
    assert.equal(stats.partial_estimate, true);
    assert.equal((res.structuredContent as { fetch_all_cap: number }).fetch_all_cap, 60);
    // Only the first 60 durations (1000..60000 ms) are in these numbers.
    assert.equal(stats.total_runtime_ms, 1_830_000);
    assert.ok(res.content[0].text.includes('PARTIAL'));
    assert.ok(res.content[0].text.includes('60'));
    assert.ok(res.content[0].text.includes('200'));
    assert.deepEqual(offsets, ['0', '50']);
  });

  // #774: an album read that carried no track count is UNKNOWN, not silently
  // filled in with the walked length.
  it('album_track_stats reports tracks_listed as null when the album read carried no count', async () => {
    const { client } = pagedAlbumClient(3, 3);
    const bare = client as { get: (path: string, params?: Record<string, string>) => Promise<unknown> };
    const realGet = bare.get;
    bare.get = async (path: string, params?: Record<string, string>) =>
      (path.endsWith('/tracks') ? realGet(path, params) : null);
    const res = await handlerFor('album_track_stats', bare as never)({ album_id: 'alb1', response_format: 'concise' });
    const stats = (res.structuredContent as { stats: { track_count: number; tracks_listed: number | null; partial_estimate: boolean } }).stats;
    assert.equal(stats.track_count, 3);
    assert.equal(stats.tracks_listed, null);
    assert.equal(stats.partial_estimate, false);
  });

  it('artist_discography_stats reports counts, rate, longest gap', async () => {
    const client = makeClient({
      get: mock.fn(async (path: string) => (path.startsWith('/artists/') && !path.includes('/albums') ? { ...artist, genres: [] } : null)),
      getAllPages: mock.fn(async () => [
        { id: 'a1', name: 'First', uri: 'u', album_type: 'album', release_date: '2010-01-01', total_tracks: 10, artists: [artist], images: [] },
        { id: 'a2', name: 'Second', uri: 'u', album_type: 'single', release_date: '2014-06-01', total_tracks: 1, artists: [artist], images: [] },
        { id: 'a3', name: 'Third', uri: 'u', album_type: 'album', release_date: '2015-06-01', total_tracks: 12, artists: [artist], images: [] },
      ]),
    });
    const res = await handlerFor('artist_discography_stats', client)({ artist_id: 'a1', response_format: 'concise' });
    assert.ok(res.content[0].text.includes('2 albums, 1 single'));
    assert.ok(res.content[0].text.includes('longest silence: 1612'));
    assert.equal((res.structuredContent as { counts_by_type: Record<string, number> }).counts_by_type.album, 2);
  });

  it('show_runtime_stats computes runtime and cadence', async () => {
    const client = makeClient({
      get: mock.fn(async (path: string) => (path.startsWith('/shows/') && !path.includes('/episodes') ? { id: 'sh1', name: 'Show', uri: 'u', description: '', total_episodes: 3 } : null)),
      getAllPages: mock.fn(async () => [
        { id: 'e1', name: 'one', uri: 'u', duration_ms: 1_800_000, release_date: '2024-01-01', explicit: false, description: '', show: { id: 'sh1', name: 'Show', uri: 'u', description: '', total_episodes: 3 } },
        { id: 'e2', name: 'two', uri: 'u', duration_ms: 1_800_000, release_date: '2024-01-08', explicit: false, description: '', show: { id: 'sh1', name: 'Show', uri: 'u', description: '', total_episodes: 3 } },
        { id: 'e3', name: 'three', uri: 'u', duration_ms: 3_000_000, release_date: '2024-01-15', explicit: false, description: '', show: { id: 'sh1', name: 'Show', uri: 'u', description: '', total_episodes: 3 } },
      ]),
    });
    const res = await handlerFor('show_runtime_stats', client)({ show_id: 'sh1', response_format: 'concise' });
    assert.ok(res.content[0].text.includes('total runtime: 1:50:00'));
    assert.ok(res.content[0].text.includes('7 days between episodes'));
  });

  it('show_episode_timeline flags hiatus gaps', async () => {
    const client = makeClient({
      get: mock.fn(async (path: string) => (path.startsWith('/shows/') && !path.includes('/episodes') ? { id: 'sh1', name: 'Show', uri: 'u', description: '', total_episodes: 2 } : null)),
      getAllPages: mock.fn(async () => [
        { id: 'e1', name: 'one', uri: 'u', duration_ms: 600_000, release_date: '2024-01-01', explicit: false, description: '', show: { id: 'sh1', name: 'S', uri: 'u', description: '', total_episodes: 2 } },
        { id: 'e2', name: 'two', uri: 'u', duration_ms: 600_000, release_date: '2024-02-13', explicit: false, description: '', show: { id: 'sh1', name: 'S', uri: 'u', description: '', total_episodes: 2 } },
      ]),
    });
    const res = await handlerFor('show_episode_timeline', client)({ show_id: 'sh1', response_format: 'concise' });
    assert.ok(res.content[0].text.includes('no episode for 43 days'));
assert.equal((res.structuredContent as { gaps_flagged: unknown[] }).gaps_flagged.length, 1);
  });

  it('category_resolver fuzzy-matches and short-circuits on 403 gate', async () => {
    const okClient = makeClient({
      get: mock.fn(async () => ({ categories: { items: [{ id: 'chill', name: 'Chill' }, { id: 'workout', name: 'Workout' }], total: 2 } })),
    });
    const ok = await handlerFor('category_resolver', okClient)({ text: 'chill vibes', response_format: 'concise' });
    assert.equal((ok.structuredContent as { best_match: { id: string } }).best_match.id, 'chill');
    // #765: isGatedError now requires the gated-path annotation the contract
    // installs, so the test must run the contract against the gated client to
    // exercise the real production shape (the production entry point in
    // src/index.ts installs it unconditionally).
    const gatedClient = makeClient({
      get: mock.fn(async () => { throw new SpotifyApiError(403, 'Forbidden'); }),
    });
    installGatedPathContract(gatedClient);
    const res = await handlerFor('category_resolver', gatedClient)({ text: 'chill', response_format: 'concise' });
    assert.equal((res.structuredContent as { gated: boolean }).gated, true);
    assert.ok(res.content[0].text.includes('app-registration gated'));
  });

  it('search_by_isrc resolves and validates', async () => {
    const client = makeClient({
      get: mock.fn(async (_p: string, params?: Record<string, string>) => {
        assert.equal(params?.q, 'isrc:USUM71703861');
        return { tracks: { items: [trackPayload({ id: 't9', uri: 'spotify:track:t9', external_ids: { isrc: 'USUM71703861' } })], total: 1 } };
      }),
    });
    const res = await handlerFor('search_by_isrc', client)({ isrc: 'usum-717-03861', response_format: 'concise' });
    assert.ok(res.content[0].text.includes('ISRC USUM71703861 resolved'));
    await assert.rejects(handlerFor('search_by_isrc', makeClient())({ isrc: 'not-an-isrc', response_format: 'concise' }));
  });

  it('find_canonical_track ranks studio over live and returns variant table', async () => {
    const client = makeClient({
      get: mock.fn(async () => ({
        tracks: { items: [
          trackPayload({ id: 'live', uri: 'spotify:track:live', name: 'Song (Live)', album: { id: 'alb2', name: 'Live Album', uri: 'u', images: [], release_date: '2020-01-01', album_type: 'album' } }),
          trackPayload({ id: 'studio', uri: 'spotify:track:studio', name: 'Song' }),
        ], total: 2 },
      })),
    });
    const res = await handlerFor('find_canonical_track', client)({ title: 'Song', artist: 'Artist', response_format: 'concise' });
    const canonical = res.structuredContent!.canonical as { uri: string };
    assert.equal(canonical.uri, 'spotify:track:studio');
    assert.ok(res.content[0].text.includes('⭐ canonical'));
    assert.ok(res.content[0].text.includes('All versions (2)'));
  });

  // #777: both tools declare `market` but used to drop it, so every /search
  // ran against the token's default market. The requests themselves are the
  // assertion — a stub that never sees `market` fails here.
  it('search_by_isrc sends the requested market on /search and reports market_used', async () => {
    const seen: Array<Record<string, string | undefined>> = [];
    const client = makeClient({
      get: mock.fn(async (_p: string, params?: Record<string, string>) => {
        seen.push(params ?? {});
        return { tracks: { items: [trackPayload({ external_ids: { isrc: 'USUM71703861' } })], total: 1 } };
      }),
    });
    const res = await handlerFor('search_by_isrc', client)({
      isrc: 'USUM71703861', market: 'GB', response_format: 'concise',
    });
    assert.equal(seen.length, 1);
    assert.deepEqual(seen.map((p) => p.market), ['GB']);
    assert.equal(res.structuredContent!.market_used, 'GB');
    assert.ok(res.content[0].text.includes('market GB'));
  });

  it('search_by_isrc reports from_token and sends no market when none is given', async () => {
    const seen: Array<Record<string, string | undefined>> = [];
    const client = makeClient({
      get: mock.fn(async (_p: string, params?: Record<string, string>) => {
        seen.push(params ?? {});
        return { tracks: { items: [], total: 0 } };
      }),
    });
    const res = await handlerFor('search_by_isrc', client)({ isrc: 'USUM71703861', response_format: 'concise' });
    assert.equal(seen.length, 1);
    assert.equal(seen[0].market, undefined);
    assert.equal(res.structuredContent!.market_used, 'from_token');
    assert.ok(res.content[0].text.includes('no track found in market from_token'));
  });

  // #781: `emitSearchResult` hardcoded `offset: 0, limit: null`, so no matter
  // what page the tool actually read, `pagination.next_offset` came back null
  // and the prose carried no way to continue. Both search-backed tools below
  // now report the page they asked for, in prose and in the payload.

  it('search_by_isrc reports a real next_offset when the ISRC matches more than one track (#781)', async () => {
    const seen: Array<Record<string, string | undefined>> = [];
    const client = makeClient({
      get: mock.fn(async (_p: string, params?: Record<string, string>) => {
        seen.push(params ?? {});
        return {
          tracks: {
            items: [
              trackPayload({ id: 't1', uri: 'spotify:track:t1', name: 'First' }),
              trackPayload({ id: 't2', uri: 'spotify:track:t2', name: 'Second' }),
            ],
            total: 7,
          },
        };
      }),
    });
    const res = await handlerFor('search_by_isrc', client)({ isrc: 'USUM71703861', response_format: 'concise' });
    assert.equal(seen[0].offset, undefined, 'the first page asks for no offset');
    assert.deepEqual(res.structuredContent!.pagination, { total: 7, offset: 0, limit: 5, returned: 2, next_offset: 2 });
    assert.match(res.content[0].text, /^Next page: offset=2$/m);
  });

  it('search_by_isrc omits the paging signal on the last page (#781)', async () => {
    const client = makeClient({
      get: mock.fn(async () => ({ tracks: { items: [trackPayload()], total: 1 } })),
    });
    const res = await handlerFor('search_by_isrc', client)({ isrc: 'USUM71703861', response_format: 'concise' });
    assert.doesNotMatch(res.content[0].text, /Next page:/);
    assert.deepEqual(res.structuredContent!.pagination, { total: 1, offset: 0, limit: 5, returned: 1, next_offset: null });
  });

  it('search_by_isrc forwards the caller offset and reports the page it read (#781)', async () => {
    const seen: Array<Record<string, string | undefined>> = [];
    const client = makeClient({
      get: mock.fn(async (_p: string, params?: Record<string, string>) => {
        seen.push(params ?? {});
        return { tracks: { items: [trackPayload()], total: 40 } };
      }),
    });
    const res = await handlerFor('search_by_isrc', client)({ isrc: 'USUM71703861', offset: 10, response_format: 'concise' });
    assert.equal(seen[0].offset, '10', 'the offset has to reach the request or the page is not reachable');
    assert.deepEqual(res.structuredContent!.pagination, { total: 40, offset: 10, limit: 5, returned: 1, next_offset: 11 });
    assert.match(res.content[0].text, /^Next page: offset=11$/m);
  });

  it('search_by_isrc declares the offset its paging signal points at (#781)', async () => {
    // Without a declared `offset` the truncation boundary treats the emitted
    // next_offset as advice the caller cannot act on and strips it, so the
    // schema has to carry the control the signal names.
    const shape = shapeFor('search_by_isrc', makeClient());
    assert.ok('offset' in shape.shape, 'the schema must accept the offset the paging line names');
    assert.equal(shape.safeParse({ isrc: 'USUM71703861', offset: 5 }).success, true);
    assert.equal(shape.safeParse({ isrc: 'USUM71703861', offset: -1 }).success, false, 'a negative offset is not a page');
  });

  it('audiobooks_by_author reports a real next_offset when the author has more titles (#781)', async () => {
    const seen: Array<Record<string, string | undefined>> = [];
    const client = makeClient({
      get: mock.fn(async (_p: string, params?: Record<string, string>) => {
        seen.push(params ?? {});
        return {
          audiobooks: {
            items: [
              { id: 'ab1', name: 'One', uri: 'u', authors: [{ name: 'A' }], narrators: [], total_chapters: 1, release_date: '2020', description: '', explicit: false, media_type: 'audio', languages: ['en'] },
              { id: 'ab2', name: 'Two', uri: 'u', authors: [{ name: 'A' }], narrators: [], total_chapters: 2, release_date: '2021', description: '', explicit: false, media_type: 'audio', languages: ['en'] },
            ],
            total: 12,
          },
        };
      }),
    });
    const res = await handlerFor('audiobooks_by_author', client)({ author: 'A', limit: 5, offset: 5, response_format: 'concise' });
    assert.equal(seen[0].offset, '5');
    assert.equal(seen[0].limit, '5', 'the reported page is the one the request asked for');
    assert.deepEqual(res.structuredContent!.pagination, { total: 12, offset: 5, limit: 5, returned: 2, next_offset: 7 });
    assert.match(res.content[0].text, /^Next page: offset=7$/m);
  });

  it('audiobooks_by_author omits the paging signal on the last page (#781)', async () => {
    const client = makeClient({
      get: mock.fn(async () => ({
        audiobooks: {
          items: [
            { id: 'ab1', name: 'Only', uri: 'u', authors: [{ name: 'A' }], narrators: [], total_chapters: 1, release_date: '2020', description: '', explicit: false, media_type: 'audio', languages: ['en'] },
          ],
          total: 3,
        },
      })),
    });
    // The same rows one page earlier do print a line, so the absence below is
    // the end of the walk rather than the tool never emitting one.
    const mid = await handlerFor('audiobooks_by_author', client)({ author: 'A', limit: 5, response_format: 'concise' });
    assert.match(mid.content[0].text, /^Next page: offset=1$/m);
    assert.deepEqual(mid.structuredContent!.pagination, { total: 3, offset: 0, limit: 5, returned: 1, next_offset: 1 });

    const last = await handlerFor('audiobooks_by_author', client)({ author: 'A', limit: 5, offset: 2, response_format: 'concise' });
    assert.doesNotMatch(last.content[0].text, /Next page:/);
    assert.deepEqual(last.structuredContent!.pagination, { total: 3, offset: 2, limit: 5, returned: 1, next_offset: null });
  });

  it('audiobooks_by_author declares the offset its paging signal points at (#781)', async () => {
    const shape = shapeFor('audiobooks_by_author', makeClient());
    assert.ok('offset' in shape.shape);
    assert.equal(shape.safeParse({ author: 'A', offset: 5 }).success, true);
  });

  it('find_canonical_track sends the market on both the precise and fallback searches', async () => {
    const seen: Array<Record<string, string | undefined>> = [];
    let calls = 0;
    const client = makeClient({
      get: mock.fn(async (_p: string, params?: Record<string, string>) => {
        seen.push(params ?? {});
        calls += 1;
        // Precise filter comes back empty so the broad fallback also runs.
        return calls === 1
          ? { tracks: { items: [], total: 0 } }
          : { tracks: { items: [trackPayload({ id: 'de', uri: 'spotify:track:de' })], total: 1 } };
      }),
    });
    const res = await handlerFor('find_canonical_track', client)({
      title: 'Song', artist: 'Artist', market: 'DE', response_format: 'concise',
    });
    assert.equal(seen.length, 2);
    assert.deepEqual(seen.map((p) => p.market), ['DE', 'DE']);
    assert.equal(res.structuredContent!.market_used, 'DE');
    assert.equal(res.structuredContent!.fallback_search, true);
  });

  it('find_canonical_track reports from_token when no market is supplied', async () => {
    const seen: Array<Record<string, string | undefined>> = [];
    const client = makeClient({
      get: mock.fn(async (_p: string, params?: Record<string, string>) => {
        seen.push(params ?? {});
        return { tracks: { items: [trackPayload()], total: 1 } };
      }),
    });
    const res = await handlerFor('find_canonical_track', client)({ title: 'Song', artist: 'Artist', response_format: 'concise' });
    assert.equal(seen.length, 1);
    assert.equal(seen[0].market, undefined);
    assert.equal(res.structuredContent!.market_used, 'from_token');
    assert.ok(res.content[0].text.includes('market searched: from_token'));
  });

  it('audiobook_chapter_map totals runtime and finds midpoint', async () => {
    const client = makeClient({
      get: mock.fn(async (path: string) => (path.startsWith('/audiobooks/') && !path.includes('/chapters')
        ? { id: 'ab1', name: 'Dune', uri: 'u', authors: [{ name: 'FH' }], narrators: [], total_chapters: 2, description: '', explicit: false, media_type: 'audio', languages: ['en'] }
        : null)),
      getAllPages: mock.fn(async () => [
        { id: 'c1', name: 'Part 1', uri: 'u', chapter_number: 1, duration_ms: 3_600_000, release_date: '2020', explicit: false, description: '', is_playable: true },
        { id: 'c2', name: 'Part 2', uri: 'u', chapter_number: 2, duration_ms: 3_600_000, release_date: '2020', explicit: false, description: '', is_playable: true },
      ]),
    });
    const res = await handlerFor('audiobook_chapter_map', client)({ audiobook_id: 'ab1', response_format: 'concise' });
    assert.ok(res.content[0].text.includes('Total runtime: 2:00:00'));
    assert.ok(res.content[0].text.includes('#2 "Part 2"'));
  });

  // The documented /artists/{id}/albums shape is a SIMPLIFIED album object —
  // no `tracks` key (#770). The old fixture invented one, which is why the
  // impossible album-track read passed CI.
  const guest = { id: 'a2', name: 'Guest', uri: 'spotify:artist:a2' };
  const third = { id: 'a3', name: 'Third', uri: 'spotify:artist:a3' };
  const simplifiedAlbum = {
    id: 'alb1', name: 'Collab LP', uri: 'spotify:album:alb1', album_type: 'album',
    release_date: '2022', total_tracks: 1, artists: [artist, guest], images: [],
  };
  type CollabRow = { id: string; name: string; co_appearances: number; on_top_tracks: boolean; on_album_tracks: boolean };
  type CollabStructured = {
    collaborators: CollabRow[];
    top_tracks_available: boolean;
    credits_source: string;
    track_features_included: boolean;
    unreadable_count?: number;
    track_features_partial?: boolean;
    unreadable_albums?: Array<{ album_id: string; album_name: string | null; reason: string }>;
    albums_credited?: number;
    truncated_count?: number;
    truncated_albums?: Array<{ album_id: string; album_name: string | null; tracks_read: number; tracks_reported: number | null }>;
  };

  it('artist_collab_network falls back to albums when top-tracks is gated', async () => {
    const client = makeClient({
      get: mock.fn(async (path: string) => {
        if (path.includes('/top-tracks')) throw new SpotifyApiError(403, 'Forbidden');
        if (path.startsWith('/artists/') && !path.includes('/albums')) return { ...artist, genres: [] };
        return null;
      }),
      getAllPages: mock.fn(async () => [simplifiedAlbum]),
    });
    // #765: the contract annotates the gated 403 in place so the tool
    // handler's isGatedError branch still matches -- install it before
    // driving the handler, the way src/index.ts does on every startup.
    installGatedPathContract(client);
    const res = await handlerFor('artist_collab_network', client)({ artist_id: 'a1', response_format: 'concise' });
    const structured = res.structuredContent as CollabStructured;
    assert.equal(structured.top_tracks_available, false);
    assert.equal(structured.collaborators[0].name, 'Guest');
    // One album credit only: the old fixture counted a second "co-appearance"
    // out of a track list the endpoint never returns.
    assert.equal(structured.collaborators[0].co_appearances, 1);
    assert.equal(structured.collaborators[0].on_album_tracks, false);
    assert.ok(res.content[0].text.includes('app-registration gated'));
  });

  it('artist_collab_network claims no track-level collaborator by default', async () => {
    const client = makeClient({
      get: mock.fn(async (path: string) => {
        if (path.endsWith('/top-tracks')) return { tracks: [trackPayload({ artists: [artist] })] };
        if (path.startsWith('/artists/') && !path.includes('/albums')) return { ...artist, genres: [] };
        return null;
      }),
      getAllPages: mock.fn(async () => [simplifiedAlbum]),
    });
    const res = await handlerFor('artist_collab_network', client)({ artist_id: 'a1', response_format: 'concise' });
    const structured = res.structuredContent as CollabStructured;
    assert.equal(structured.track_features_included, false);
    assert.equal(structured.credits_source, 'album_credits');
    // Third appears only inside the (non-existent) embedded track list, so a
    // tool that still trusted `al.tracks` would report it here.
    assert.equal(structured.collaborators.some((c) => c.name === 'Third'), false);
    assert.ok(res.content[0].text.includes('Album-level co-billing only'));
  });

  it('artist_collab_network include_track_features reports the featured artist from a real album-tracks call', async () => {
    const client = makeClient({
      get: mock.fn(async (path: string) => {
        if (path === '/albums/alb1/tracks') {
          return { items: [{ id: 't1', name: 'Duet', uri: 'u', duration_ms: 100_000, explicit: false, track_number: 1, artists: [artist, guest, third] }] };
        }
        if (path.endsWith('/top-tracks')) return { tracks: [trackPayload({ artists: [artist] })] };
        if (path.startsWith('/artists/') && !path.includes('/albums')) return { ...artist, genres: [] };
        return null;
      }),
      getAllPages: mock.fn(async () => [simplifiedAlbum]),
    });
    const res = await handlerFor('artist_collab_network', client)({ artist_id: 'a1', include_track_features: true, response_format: 'concise' });
    const structured = res.structuredContent as CollabStructured;
    // Asserted FIRST: against the pre-fix source the featured artist is simply
    // absent, so this line — not a metadata flag — is what proves the credit
    // really came from a GET /albums/{id}/tracks the old code never made.
    const featured = structured.collaborators.find((c) => c.name === 'Third');
    assert.ok(featured, 'Third is credited on the album track and must be reported');
    assert.equal(featured.on_album_tracks, true);
    assert.equal(structured.track_features_included, true);
    assert.equal(structured.credits_source, 'album_and_track_credits');
    // Album credit + track credit = 2 distinct appearances for Guest.
    const guestRow = structured.collaborators.find((c) => c.name === 'Guest');
    assert.equal(guestRow?.co_appearances, 2);
    // A complete read: nothing here is undisclosed, so no partial flag.
    assert.equal(structured.track_features_partial, undefined);
    assert.equal(structured.albums_credited, 1);
  });

  it('artist_collab_network lists an unreadable album with its reason instead of zero collaborators', async () => {
    const client = makeClient({
      get: mock.fn(async (path: string) => {
        if (path === '/albums/alb1/tracks') throw new SpotifyApiError(403, 'Forbidden');
        if (path.endsWith('/top-tracks')) return { tracks: [trackPayload({ artists: [artist] })] };
        if (path.startsWith('/artists/') && !path.includes('/albums')) return { ...artist, genres: [] };
        return null;
      }),
      getAllPages: mock.fn(async () => [simplifiedAlbum]),
    });
    const res = await handlerFor('artist_collab_network', client)({ artist_id: 'a1', include_track_features: true, response_format: 'concise' });
    const structured = res.structuredContent as CollabStructured;
    assert.equal(structured.track_features_partial, true);
    assert.equal(structured.unreadable_count, 1);
    assert.deepEqual(structured.unreadable_albums, [
      { album_id: 'alb1', album_name: 'Collab LP', reason: 'forbidden or app-registration gated (403)' },
    ]);
    // Every credit count here is observed, not assumed: the only read failed.
    assert.equal(structured.albums_credited, 0);
    // The readable album credit is still reported — the bad one did not poison it.
    assert.ok(structured.collaborators.some((c) => c.name === 'Guest'));
    assert.ok(res.content[0].text.includes('not zero'));
  });

  // A 204 (client.get -> null) and a 200 with no `items` are the same defect
  // as a throw: the credits are unknown, not empty. Both used to fold into
  // `page?.items ?? []` and report a complete read (the #803 class).
  it('artist_collab_network reports a short (non-throwing) album-tracks page as unreadable, not as a complete read', async () => {
    const second = { ...simplifiedAlbum, id: 'alb2', name: 'Second LP' };
    const client = makeClient({
      get: mock.fn(async (path: string) => {
        if (path === '/albums/alb1/tracks') return null; // HTTP 204
        if (path === '/albums/alb2/tracks') return {}; // HTTP 200, no items
        if (path.endsWith('/top-tracks')) return { tracks: [trackPayload({ artists: [artist] })] };
        if (path.startsWith('/artists/') && !path.includes('/albums')) return { ...artist, genres: [] };
        return null;
      }),
      getAllPages: mock.fn(async () => [simplifiedAlbum, second]),
    });
    const res = await handlerFor('artist_collab_network', client)({ artist_id: 'a1', include_track_features: true, response_format: 'concise' });
    const structured = res.structuredContent as CollabStructured;
    assert.equal(structured.track_features_partial, true);
    assert.equal(structured.unreadable_count, 2);
    assert.deepEqual(structured.unreadable_albums, [
      { album_id: 'alb1', album_name: 'Collab LP', reason: 'no track list in the response' },
      { album_id: 'alb2', album_name: 'Second LP', reason: 'no track list in the response' },
    ]);
    // Neither read happened, so no album is counted as credited and no album
    // credit is claimed to have come off a track list.
    assert.equal(structured.albums_credited, 0);
    assert.equal(structured.collaborators.every((c) => !c.on_album_tracks), true);
    assert.ok(res.content[0].text.includes('not zero'));
  });

  // A genuine empty track list IS a read that observed zero collaborators, so
  // it must not be swept into the unreadable bucket alongside the short pages.
  it('artist_collab_network treats a real empty track list as a complete zero, not an unreadable album', async () => {
    const client = makeClient({
      get: mock.fn(async (path: string) => {
        if (path === '/albums/alb1/tracks') return { items: [], total: 0 };
        if (path.endsWith('/top-tracks')) return { tracks: [trackPayload({ artists: [artist] })] };
        if (path.startsWith('/artists/') && !path.includes('/albums')) return { ...artist, genres: [] };
        return null;
      }),
      getAllPages: mock.fn(async () => [simplifiedAlbum]),
    });
    const res = await handlerFor('artist_collab_network', client)({ artist_id: 'a1', include_track_features: true, response_format: 'concise' });
    const structured = res.structuredContent as CollabStructured;
    assert.equal(structured.unreadable_count, undefined);
    assert.equal(structured.track_features_partial, undefined);
    assert.equal(structured.albums_credited, 1);
    assert.ok(structured.collaborators.some((c) => c.name === 'Guest' && !c.on_album_tracks));
  });

  // limit: '50' means a long album is only partly read; the album-level cap is
  // disclosed, so the track-level one has to be too.
  it('artist_collab_network discloses an album whose track credits were truncated at the page size', async () => {
    const client = makeClient({
      get: mock.fn(async (path: string) => {
        if (path === '/albums/alb1/tracks') {
          return {
            items: [{ id: 't1', name: 'Opener', uri: 'u', duration_ms: 100_000, explicit: false, track_number: 1, artists: [artist, third] }],
            total: 120,
            next: 'https://api.spotify.com/v1/albums/alb1/tracks?offset=1',
          };
        }
        if (path.endsWith('/top-tracks')) return { tracks: [trackPayload({ artists: [artist] })] };
        if (path.startsWith('/artists/') && !path.includes('/albums')) return { ...artist, genres: [] };
        return null;
      }),
      getAllPages: mock.fn(async () => [simplifiedAlbum]),
    });
    const res = await handlerFor('artist_collab_network', client)({ artist_id: 'a1', include_track_features: true, response_format: 'concise' });
    const structured = res.structuredContent as CollabStructured;
    assert.equal(structured.truncated_count, 1);
    assert.deepEqual(structured.truncated_albums, [
      { album_id: 'alb1', album_name: 'Collab LP', tracks_read: 1, tracks_reported: 120 },
    ]);
    // A truncated read is not a failed one: the credit it did return stands.
    assert.equal(structured.unreadable_count, undefined);
    assert.equal(structured.track_features_partial, true);
    assert.equal(structured.albums_credited, 1);
    assert.ok(structured.collaborators.some((c) => c.name === 'Third'));
    assert.ok(res.content[0].text.includes('Partial'));
  });

  // A `next` cursor without a numeric `total` says "this page is not the last
  // one" and nothing about how much is left. Reporting tracks_read as the total
  // would put "1 of 1" inside the very list that exists to say credits are
  // missing, so the unknown has to survive as null.
  it('artist_collab_network reports an unknown total as unknown rather than inventing one from the page it read', async () => {
    const client = makeClient({
      get: mock.fn(async (path: string) => {
        if (path === '/albums/alb1/tracks') {
          return {
            items: [{ id: 't1', name: 'Opener', uri: 'u', duration_ms: 100_000, explicit: false, track_number: 1, artists: [artist, third] }],
            next: 'https://api.spotify.com/v1/albums/alb1/tracks?offset=1',
          };
        }
        if (path.endsWith('/top-tracks')) return { tracks: [trackPayload({ artists: [artist] })] };
        if (path.startsWith('/artists/') && !path.includes('/albums')) return { ...artist, genres: [] };
        return null;
      }),
      getAllPages: mock.fn(async () => [simplifiedAlbum]),
    });
    const res = await handlerFor('artist_collab_network', client)({ artist_id: 'a1', include_track_features: true, response_format: 'concise' });
    const structured = res.structuredContent as CollabStructured;
    assert.equal(structured.truncated_count, 1);
    assert.deepEqual(structured.truncated_albums, [
      { album_id: 'alb1', album_name: 'Collab LP', tracks_read: 1, tracks_reported: null },
    ]);
    // The credit this page did return still stands, and the disclosure still
    // fires — only the invented total is gone.
    assert.equal(structured.unreadable_count, undefined);
    assert.equal(structured.track_features_partial, true);
    assert.equal(structured.albums_credited, 1);
    assert.ok(structured.collaborators.some((c) => c.name === 'Third'));
    const text = res.content[0].text;
    assert.ok(text.includes('Collab LP (1 tracks, total unknown)'), text);
    assert.equal(text.includes('1 of 1 tracks'), false, text);
  });

  it('search_market_diff splits result sets by market', async () => {
    const client = makeClient({
      get: mock.fn(async (_p: string, params?: Record<string, string>) => {
        const usRow = trackPayload({ id: 'us', uri: 'spotify:track:us', name: 'US Only' });
        const gbRow = trackPayload({ id: 'gb', uri: 'spotify:track:gb', name: 'GB Only' });
        const shared = trackPayload({ id: 'x', uri: 'spotify:track:x', name: 'Shared' });
        const items = params?.market === 'US' ? [usRow, shared] : [gbRow, shared];
        return { tracks: { items, total: items.length } };
      }),
    });
    const res = await handlerFor('search_market_diff', client)({ query: 'q', market_a: 'US', market_b: 'GB', response_format: 'concise' });
    const structured = res.structuredContent as { only_in_a: Array<{ name: string }>; only_in_b: Array<{ name: string }> };
    assert.equal(structured.only_in_a[0].name, 'US Only');
    assert.equal(structured.only_in_b[0].name, 'GB Only');
    assert.ok(res.content[0].text.includes('both markets: 1'));
  });

  // #776: `types` accepted two entries but only `types[0]` was ever searched,
  // so a second type was dropped without a word in the payload. The cap is now
  // 1, which makes the excess a schema failure the caller can see and act on.
  it('search_market_diff rejects two requested types and names the parameter', async () => {
    const shape = shapeFor('search_market_diff', makeClient());
    const two = await shape.safeParseAsync({
      query: 'q', market_a: 'US', market_b: 'GB', response_format: 'concise', types: ['track', 'album'],
    });
    assert.equal(two.success, false, 'a two-type request must not validate');
    // The error boundary reports `issue.path[0]` back to the caller, so the
    // rejection is only actionable if it points at `types`.
    assert.equal(offendingParam(two.error), 'types');
  });

  it('search_market_diff rejects a CSV types string rather than guessing at it', async () => {
    const shape = shapeFor('search_market_diff', makeClient());
    const csv = await shape.safeParseAsync({
      query: 'q', market_a: 'US', market_b: 'GB', response_format: 'concise', types: 'track,album',
    });
    assert.equal(csv.success, false, 'a CSV string must not be silently split or coerced');
    assert.equal(offendingParam(csv.error), 'types');
  });

  // Non-vacuous guard for the single-type path: the section reported back must
  // be the type actually requested, and every search must have asked for it.
  // A handler that ignored `types` and always searched 'track' fails both.
  it('search_market_diff searches and reports exactly the one requested type', async () => {
    const requested: Array<string | undefined> = [];
    const client = makeClient({
      get: mock.fn(async (_p: string, params?: Record<string, string>) => {
        requested.push(params?.type);
        // Distinct identity per market: the diff keys on uri/id, so sharing
        // one would dedupe into `both` and leave `only_in_a` empty.
        const us = params?.market === 'US';
        const items = [{ id: us ? 'a-us' : 'a-gb', uri: `spotify:album:a-${us ? 'us' : 'gb'}`, name: us ? 'US Album' : 'GB Album' }];
        // Only the albums section is populated, so reading the wrong section
        // yields no items rather than a plausible-looking wrong answer.
        return { albums: { items, total: items.length } };
      }),
    });
    const res = await handlerFor('search_market_diff', client)({
      query: 'q', market_a: 'US', market_b: 'GB', response_format: 'concise', types: ['album'],
    });
    const structured = res.structuredContent as { type: string; only_in_a: Array<{ name: string }> };
    assert.equal(structured.type, 'album');
    assert.deepEqual(requested, ['album', 'album']);
    assert.equal(structured.only_in_a[0].name, 'US Album');
  });

  it('search_market_diff still defaults to track when types is omitted', async () => {
    const requested: Array<string | undefined> = [];
    const client = makeClient({
      get: mock.fn(async (_p: string, params?: Record<string, string>) => {
        requested.push(params?.type);
        return { tracks: { items: [], total: 0 } };
      }),
    });
    const res = await handlerFor('search_market_diff', client)({
      query: 'q', market_a: 'US', market_b: 'GB', response_format: 'concise',
    });
    const structured = res.structuredContent as { type: string };
    assert.equal(structured.type, 'track');
    assert.deepEqual(requested, ['track', 'track']);
  });

  it('episode_context_bundle finds prev/next neighbours', async () => {
    const client = makeClient({
      get: mock.fn(async (path: string) => {
        if (path.startsWith('/episodes/')) {
          return { id: 'e2', name: 'Middle', uri: 'u', duration_ms: 600_000, release_date: '2024-01-08', description: 'desc', show: { id: 'sh1', name: 'Show', uri: 'u' } };
        }
        if (path.includes('/episodes')) {
          return { items: [
            { id: 'e1', name: 'First', uri: 'u', duration_ms: 1, release_date: '2024-01-01', explicit: false, description: '', show: { id: 'sh1', name: 'Show', uri: 'u', description: '', total_episodes: 3 } },
            { id: 'e2', name: 'Middle', uri: 'u', duration_ms: 1, release_date: '2024-01-08', explicit: false, description: '', show: { id: 'sh1', name: 'Show', uri: 'u', description: '', total_episodes: 3 } },
            { id: 'e3', name: 'Last', uri: 'u', duration_ms: 1, release_date: '2024-01-15', explicit: false, description: '', show: { id: 'sh1', name: 'Show', uri: 'u', description: '', total_episodes: 3 } },
          ], total: 3 };
        }
        return null;
      }),
    });
    const res = await handlerFor('episode_context_bundle', client)({ episode_id: 'e2', response_format: 'concise' });
    const structured = res.structuredContent as { previous: { name: string } | null; next: { name: string } | null };
    assert.equal(structured.previous.name, 'First');
    assert.equal(structured.next.name, 'Last');
    assert.ok(res.content[0].text.includes('← previous: "First"'));
  });

  it('audiobooks_by_author sorts by release and by length', async () => {
    const client = makeClient({
      get: mock.fn(async () => ({
        audiobooks: { items: [
          { id: 'ab2', name: 'Late Book', uri: 'u', authors: [{ name: 'A' }], narrators: [], total_chapters: 5, release_date: '2022', description: '', explicit: false, media_type: 'audio', languages: ['en'] },
          { id: 'ab1', name: 'Early Book', uri: 'u', authors: [{ name: 'A' }], narrators: [], total_chapters: 20, release_date: '2015', description: '', explicit: false, media_type: 'audio', languages: ['en'] },
        ], total: 2 },
      })),
    });
    const h = handlerFor('audiobooks_by_author', client);
    const byRelease = await h({ author: 'A', sort: 'release', response_format: 'concise' });
    assert.ok(byRelease.content[0].text.indexOf('Early Book') < byRelease.content[0].text.indexOf('Late Book'));
    const byLength = await h({ author: 'A', sort: 'length', response_format: 'concise' });
    assert.ok(byLength.content[0].text.indexOf('Early Book') < byLength.content[0].text.indexOf('Late Book'));
  });

  it('artist_genres_compact projects name·genres columns', async () => {
    const client = makeClient({
      get: mock.fn(async (path: string) => {
        if (path === '/artists/a1') return { ...artist, genres: ['pop'] };
        if (path === '/artists/a2') return { id: 'a2', name: 'Untagged', uri: 'u', genres: [] };
        return null;
      }),
    });
    const res = await handlerFor('artist_genres_compact', client)({ artist_ids: ['a1', 'a2'], response_format: 'concise' });
    assert.ok(res.content[0].text.includes('Untagged'));
    assert.ok(res.content[0].text.includes('no genres'));
    assert.equal((res.structuredContent as { counts: { without_genres: number } }).counts.without_genres, 1);
  });

  // #1093: counts already existed here (#357) but missing_ids was not, so the
  // resolved count could not be cross-checked against the requested list.
  it('artist_genres_compact names the ids it could not resolve (#1093, #1004)', async () => {
    const DEAD = '0000000000000000000002';
    const client = makeClient({
      get: mock.fn(async (path: string) => {
        if (path === '/artists/a1') return { ...artist, genres: ['pop'] };
        if (path === `/artists/${DEAD}`) throw new SpotifyApiError(404, 'Not found');
        return null;
      }),
    });
    const res = await handlerFor('artist_genres_compact', client)({
      artist_ids: ['a1', DEAD],
      response_format: 'concise',
    });
    const counts = (res.structuredContent as { counts: Record<string, unknown> }).counts;
    assert.deepEqual(counts.missing_ids, [DEAD]);
    assert.equal(counts.requested, 2);
    assert.equal(counts.resolved, 1);
    assert.equal(counts.without_genres, 0);
    // Self-consistency: requested == resolved + missing_ids.length.
    assert.equal(
      (counts.requested as number),
      (counts.resolved as number) + (counts.missing_ids as string[]).length,
    );
    // #1004: the fan-out's real cost, plus why each id could not be read —
    // "missing" must not be readable as "Spotify has no such artist".
    assert.equal(counts.requests, 2);
    const unresolved = counts.unresolved as Array<{ id: string; reason: string }>;
    assert.deepEqual(unresolved.map((u) => u.id), [DEAD]);
    assert.match(unresolved[0].reason, /Not found/);
  });

  // #1004: a per-id read that returns 200 with no id is an unread, not an
  // artist. Keying it on the requested id would report a roster row the
  // payload never confirmed — the same failure as a coerced 0-streams value,
  // one field over.
  it('artist_genres_compact reports a payload with no id as unreadable (#1004)', async () => {
    const client = makeClient({
      get: mock.fn(async (path: string) => {
        if (path === '/artists/a1') return { ...artist, genres: ['pop'] };
        if (path === '/artists/a2') return { name: 'Nameless', genres: ['pop'] };
        return null;
      }),
    });
    const res = await handlerFor('artist_genres_compact', client)({ artist_ids: ['a1', 'a2'], response_format: 'json' });
    const counts = (res.structuredContent as { counts: Record<string, unknown> }).counts;
    assert.equal(counts.resolved, 1);
    assert.deepEqual(counts.missing_ids, ['a2']);
  });

  it('track_enrichment_batch fans out per id, bounded, and preserves order', async () => {
    const artistPaths: string[] = [];
    let inFlight = 0;
    let peakInFlight = 0;
    const client = makeClient({
      get: mock.fn(async (path: string, _params?: Record<string, string>) => {
        // Every read is per id, so concurrency is observable: an unbounded
        // `Promise.all` over 21 ids would show 21 in flight at once, which is
        // how a removed-endpoint fix turns into a self-inflicted 429.
        inFlight++;
        peakInFlight = Math.max(peakInFlight, inFlight);
        try {
          await Promise.resolve();
          const track = /^\/tracks\/(.+)$/.exec(path);
          if (track) {
            const i = Number(track[1].slice(1));
            return trackPayload({ id: track[1], uri: `spotify:track:${track[1]}`, name: `Track ${i}`, album: { id: `album${i}`, name: `Album ${i}`, uri: `spotify:album:album${i}`, images: [], release_date: '2021-01-01', album_type: 'album', total_tracks: 1 }, artists: [{ id: `artist${i}`, name: `Artist ${i}`, uri: `spotify:artist:artist${i}` }] });
          }
          const album = /^\/albums\/(.+)$/.exec(path);
          if (album) {
            return { id: album[1], name: `Album ${album[1]}`, uri: `spotify:album:${album[1]}`, release_date: '2021-01-01', label: `Label ${album[1]}`, artists: [], tracks: { items: [], total: 0 } };
          }
          // #1004: one per-id read per artist, and no batch route at all.
          const single = /^\/artists\/(.+)$/.exec(path);
          if (single) {
            artistPaths.push(path);
            const id = decodeURIComponent(single[1]);
            return { id, name: `Artist ${id}`, uri: `spotify:artist:${id}`, genres: [id] };
          }
          return null;
        } finally {
          inFlight--;
        }
      }),
    });
    const trackIds = Array.from({ length: 21 }, (_, i) => `t${i}`);
    const res = await handlerFor('track_enrichment_batch', client)({ track_ids: trackIds, response_format: 'json' });
    const rows = (res.structuredContent as { tracks: Array<{ id: string; label: string | null; artist_genres: Record<string, string[]> }> }).tracks;
    assert.deepEqual(rows.map((row) => row.id), trackIds);
    // 21 tracks -> 21 distinct albums -> 21 per-id album reads, not "2 chunks".
    assert.equal(
      artistPaths.length,
      21,
      'all 21 per-id artist reads must go out, not just the first window',
    );
    assert.deepEqual(
      artistPaths.slice().sort(),
      Array.from({ length: 21 }, (_, i) => `/artists/artist${i}`).sort(),
    );
    // Every row still carries its genres, joined back by id.
    assert.deepEqual(rows[7].artist_genres['Artist 7'], ['artist7']);
    // The fan-out is width-bounded. Without a bound this is 21, and the fix
    // would trade a 403 for a 429.
    assert.ok(
      peakInFlight <= PER_ID_FANOUT_WIDTH,
      `fan-out ran ${peakInFlight} requests wide, above the ${PER_ID_FANOUT_WIDTH} cap`,
    );
    assert.ok(peakInFlight > 1, `fan-out ran serially (peak ${peakInFlight}); it should batch up to the width`);
  });
});

describe('save_artist_new_releases saved-state safety', () => {
  function saveHandler(get: (path: string, params?: Record<string, string>) => unknown, calls: Array<{ method: string; path: string }>) {
    let handler!: Handler;
    const client = makeClient({
      get: mock.fn(async (path: string, params?: Record<string, string>) => { calls.push({ method: 'GET', path }); return get(path, params); }),
      put: mock.fn(async (path: string) => { calls.push({ method: 'PUT', path }); }),
    });
    const server = { tool: (name: string, _d: string, _s: unknown, h: Handler) => { if (name === 'save_artist_new_releases') handler = h; } } as unknown as McpServer;
    registerArtistWatchTools(server, client);
    return handler;
  }

  it('does not PUT when contains cardinality is wrong', async () => {
    const calls: Array<{ method: string; path: string }> = [];
    const handler = saveHandler((path) => path.includes('/albums') ? { items: [{ id: 'a1' }, { id: 'a2' }] } : [false], calls);
    await assert.rejects(handler({ artist_id: 'art1' }), /Unable to verify Your Library saved state/);
    assert.equal(calls.filter((c) => c.method === 'PUT').length, 0);
  });

  it('does not PUT when contains contains a non-boolean value', async () => {
    const calls: Array<{ method: string; path: string }> = [];
    const handler = saveHandler((path) => path.includes('/albums') ? { items: [{ id: 'a1' }] } : [null], calls);
    await assert.rejects(handler({ artist_id: 'art1' }), /Unable to verify Your Library saved state/);
    assert.equal(calls.filter((c) => c.method === 'PUT').length, 0);
  });

  it('does not PUT when contains lookup errors', async () => {
    const calls: Array<{ method: string; path: string }> = [];
    const handler = saveHandler((path) => {
      if (path.includes('/albums')) return { items: [{ id: 'a1' }] };
      throw new Error('contains unavailable');
    }, calls);
    await assert.rejects(handler({ artist_id: 'art1' }), /contains unavailable/);
    assert.equal(calls.filter((c) => c.method === 'PUT').length, 0);
  });
});
