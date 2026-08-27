import { describe, it, mock } from 'node:test';
import assert from 'node:assert/strict';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { registerExhaust2CatalogTools } from '../src/tools/exhaust2_catalog.js';
import { SpotifyApiError } from '../src/client.js';

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

const EXPECTED_TOOLS = 19;

describe('exhaust2_catalog — registry', () => {
  it('registers exactly 19 tools', () => {
    const names = allToolNames(makeClient());
    assert.equal(names.length, EXPECTED_TOOLS);
    assert.equal(new Set(names).size, EXPECTED_TOOLS);
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
        if (path === '/tracks') return { tracks: [trackPayload()] };
        if (path === '/albums') return { albums: [{ id: 'alb1', name: 'Album', uri: 'u', album_type: 'album', release_date: '2021-03-05', total_tracks: 3, artists: [artist], images: [], label: 'Big Records', tracks: { items: [], total: 3 } }] };
        if (path === '/artists') return { artists: [{ ...artist, genres: ['indie rock'] }] };
        return null;
      }),
    });
    const res = await handlerFor('track_enrichment_batch', client)({ track_ids: ['t1'], response_format: 'concise' });
    assert.ok(res.content[0].text.includes('Big Records'));
    const row = (res.structuredContent as { tracks: Array<{ artist_genres: Record<string, string[]> }> }).tracks[0];
    assert.deepEqual(row.artist_genres.Artist, ['indie rock']);
  });
});

describe('statistics + local-compute tools', () => {
  it('albums_runtime_batch computes totals and means, flags partial', async () => {
    const client = makeClient({
      get: mock.fn(async () => ({
        albums: [{ id: 'alb1', name: 'Album', uri: 'u', album_type: 'album', release_date: '2021', total_tracks: 3, artists: [artist], images: [], tracks: { items: [
          { id: 't1', name: 'a', uri: 'u', duration_ms: 60_000, explicit: false, track_number: 1, artists: [artist] },
          { id: 't2', name: 'b', uri: 'u', duration_ms: 120_000, explicit: false, track_number: 2, artists: [artist] },
        ], total: 2 } }],
      })),
    });
    const res = await handlerFor('albums_runtime_batch', client)({ album_ids: ['alb1'], response_format: 'concise' });
    assert.ok(res.content[0].text.includes('total 3:00'));
    assert.ok(res.content[0].text.includes('mean 1:30'));
    assert.equal((res.structuredContent as { albums: Array<{ partial_estimate: boolean }> }).albums[0].partial_estimate, false);
  });

  it('album_track_stats returns min/max/mean/median + longest', async () => {
    const client = makeClient({
      get: mock.fn(async (path: string) => {
        if (path.includes('/tracks')) {
          return { items: [
            { id: 't1', name: 'Short', uri: 'u', duration_ms: 60_000, explicit: false, track_number: 1, artists: [artist] },
            { id: 't2', name: 'Long', uri: 'u', duration_ms: 300_000, explicit: false, track_number: 2, artists: [artist] },
            { id: 't3', name: 'Mid', uri: 'u', duration_ms: 180_000, explicit: false, track_number: 3, artists: [artist] },
          ], total: 3 };
        }
        return { id: 'alb1', name: 'Album', uri: 'u', album_type: 'album', release_date: '2021', total_tracks: 3, artists: [artist], images: [] };
      }),
    });
    const res = await handlerFor('album_track_stats', client)({ album_id: 'alb1', response_format: 'concise' });
    const stats = (res.structuredContent as { stats: { min_ms: number; max_ms: number; mean_ms: number; median_ms: number } }).stats;
    assert.equal(stats.min_ms, 60_000);
    assert.equal(stats.max_ms, 300_000);
    assert.equal(stats.median_ms, 180_000);
    assert.ok(res.content[0].text.includes('"Long" (5:00)'));
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
    const gated = makeClient({
      get: mock.fn(async () => { throw new SpotifyApiError(403, 'Forbidden'); }),
    });
    const res = await handlerFor('category_resolver', gated)({ text: 'chill', response_format: 'concise' });
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

  it('artist_collab_network falls back to albums when top-tracks is gated', async () => {
    const client = makeClient({
      get: mock.fn(async (path: string) => {
        if (path.includes('/top-tracks')) throw new SpotifyApiError(403, 'Forbidden');
        if (path.startsWith('/artists/') && !path.includes('/albums')) return { ...artist, genres: [] };
        return null;
      }),
      getAllPages: mock.fn(async () => [
        { id: 'alb1', name: 'Collab LP', uri: 'u', album_type: 'album', release_date: '2022', total_tracks: 1, artists: [artist, { id: 'a2', name: 'Guest', uri: 'spotify:artist:a2' }], images: [], tracks: { items: [
          { id: 't1', name: 'Duet', uri: 'u', duration_ms: 100_000, explicit: false, track_number: 1, artists: [artist, { id: 'a2', name: 'Guest', uri: 'spotify:artist:a2' }, { id: 'a3', name: 'Third', uri: 'spotify:artist:a3' }] },
        ], total: 1 } },
      ]),
    });
    const res = await handlerFor('artist_collab_network', client)({ artist_id: 'a1', response_format: 'concise' });
    const structured = res.structuredContent as { collaborators: Array<{ name: string; co_appearances: number }>; top_tracks_available: boolean };
    assert.equal(structured.top_tracks_available, false);
    assert.equal(structured.collaborators[0].name, 'Guest');
    assert.equal(structured.collaborators[0].co_appearances, 2);
    assert.ok(res.content[0].text.includes('app-registration gated'));
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
      get: mock.fn(async () => ({ artists: [
        { ...artist, genres: ['pop'] },
        { id: 'a2', name: 'Untagged', uri: 'u', genres: [] },
      ] })),
    });
    const res = await handlerFor('artist_genres_compact', client)({ artist_ids: ['a1', 'a2'], response_format: 'concise' });
    assert.ok(res.content[0].text.includes('Untagged'));
    assert.ok(res.content[0].text.includes('no genres'));
    assert.equal((res.structuredContent as { counts: { without_genres: number } }).counts.without_genres, 1);
  });
});
