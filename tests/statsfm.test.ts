/**
 * stats.fm tools: registration surface + behavior against a stubbed
 * StatsfmClient (zero network). Route shapes mirror the live API
 * (verified 2026-09-05): `{ item }` singles, `{ items }` collections.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { StatsfmApiError } from '../src/lib/statsfm-client.js';
import { registerStatsfmTools } from '../src/tools/statsfm.js';

// ---------------------------------------------------------------- fixtures

type ToolContent = {
  content: Array<{ type: string; text: string }>;
  structuredContent?: Record<string, unknown>;
};

type RegisteredTool = {
  name: string;
  description: string;
  schema: Record<string, { safeParse(value: unknown): { success: boolean } }>;
  handler: (args: Record<string, unknown>) => Promise<ToolContent>;
};

type Call = { path: string; params?: Record<string, string> };

function makeHarness(responder: (path: string, params?: Record<string, string>) => unknown) {
  const calls: Call[] = [];
  const client = {
    get: async (path: string, params?: Record<string, string>) => {
      calls.push({ path, params });
      return responder(path, params);
    },
  };
  const registered: RegisteredTool[] = [];
  const server = {
    tool: (
      name: string,
      description: string,
      schema: RegisteredTool['schema'],
      handler: RegisteredTool['handler'],
    ) => registered.push({ name, description, schema, handler }),
  };
  registerStatsfmTools(
    server as unknown as Parameters<typeof registerStatsfmTools>[0],
    client as unknown as Parameters<typeof registerStatsfmTools>[1],
  );
  const find = (name: string) => {
    const t = registered.find((x) => x.name === name);
    assert.ok(t, `tool ${name} must be registered`);
    return t;
  };
  const text = (r: ToolContent) => r.content.map((c) => c.text).join('\n');
  return { calls, registered, find, text };
}

const EXPECTED_TOOLS = [
  'statsfm_resolve_user',
  'statsfm_top_tracks',
  'statsfm_top_artists',
  'statsfm_top_albums',
  'statsfm_top_genres',
  'statsfm_recent_streams',
  'statsfm_now_playing',
  'statsfm_track_stats',
  'statsfm_artist_stats',
  'statsfm_search',
  'statsfm_recaps',
  'statsfm_streams_stats',
  'statsfm_top_tracks_from_artist',
  'statsfm_top_albums_from_artist',
  'statsfm_top_tracks_from_album',
  'statsfm_catalog_track',
  'statsfm_catalog_artist',
  'statsfm_catalog_album',
  'statsfm_genre_artists',
  'statsfm_charts_tracks',
  'statsfm_charts_artists',
  'statsfm_charts_albums',
  'statsfm_charts_users',
  'statsfm_track_date_stats',
  'statsfm_artist_date_stats',
  'statsfm_album_date_stats',
  'statsfm_friends',
  'statsfm_friend_count',
  'statsfm_records_artists',
  'statsfm_album_stats',
];

function userFixture() {
  return {
    item: { id: 'u1', customId: 'martijn', displayName: 'Martijn', isPlus: true, orderBy: 'TIME', timezone: 'Europe/Amsterdam' },
  };
}

function topTracksFixture() {
  return {
    items: [
      { position: 1, streams: 54, playedMs: 8220700, indicator: 'UP', track: { name: 'Place To Be', artists: [{ name: 'Nick Drake' }], albums: [{ name: 'Pink Moon' }], externalIds: { spotify: ['abc'] } } },
      { position: 2, streams: 27, playedMs: 7646650, indicator: 'DOWN', track: { name: 'Wicked Game', artists: [{ name: 'Chris Isaak' }], albums: [{ name: 'Heart Shaped World' }] } },
    ],
  };
}

function streamsFixture() {
  return {
    items: [
      { id: 's1', endTime: '2026-05-13T18:29:00.000Z', playedMs: 300000, trackId: 1, trackName: 'Ya Sonra', albumId: 9, artistIds: [310770] },
      { id: 's2', endTime: '2026-05-14T18:29:00.000Z', playedMs: 200000, trackId: 1, trackName: 'Ya Sonra', albumId: 9, artistIds: [310770] },
    ],
  };
}

// ---------------------------------------------------------------- surface

test('statsfm registers exactly the 30 expected tools', () => {
  const h = makeHarness(() => ({ items: [] }));
  assert.equal(h.registered.length, 30, `got: ${h.registered.map((t) => t.name).join(', ')}`);
  for (const name of EXPECTED_TOOLS) {
    assert.ok(h.registered.some((t) => t.name === name), `missing ${name}`);
  }
  for (const t of h.registered) {
    assert.ok(t.description.length > 10, `${t.name} needs a real description`);
  }
});

// ---------------------------------------------------------------- resolve_user

test('statsfm_resolve_user renders a profile', async () => {
  const h = makeHarness((path) => {
    assert.equal(path, '/users/martijn');
    return userFixture();
  });
  const out = await h.find('statsfm_resolve_user').handler({ user_id: 'martijn' });
  assert.match(h.text(out), /Martijn/);
  assert.match(h.text(out), /@martijn/);
});

test('statsfm_resolve_user falls back to search on 404', async () => {
  const h = makeHarness((path) => {
    if (path === '/search') return { items: { users: [{ id: 'u2', customId: 'marley', displayName: 'Marley' }] } };
    throw new StatsfmApiError(404, 'User not found');
  });
  const out = await h.find('statsfm_resolve_user').handler({ user_id: 'marley' });
  assert.match(h.text(out), /Marley/);
});

test('statsfm_resolve_user rethrows non-404 errors without searching', async () => {
  const h = makeHarness(() => {
    throw new StatsfmApiError(500, 'boom');
  });
  await assert.rejects(() => h.find('statsfm_resolve_user').handler({ user_id: 'x' }), /boom/);
  assert.equal(h.calls.length, 1);
});

// ---------------------------------------------------------------- tops

test('statsfm_top_tracks passes range/limit/offset and renders rows', async () => {
  const h = makeHarness((path, params) => {
    assert.equal(path, '/users/martijn/top/tracks');
    assert.deepEqual(params, { range: 'months', limit: '5', offset: '1' });
    return topTracksFixture();
  });
  const out = await h.find('statsfm_top_tracks').handler({ user_id: 'martijn', range: 'months', limit: 5, offset: 1 });
  assert.match(h.text(out), /Place To Be/);
  assert.match(h.text(out), /Nick Drake/);
});

test('statsfm_top_tracks defaults to lifetime range', async () => {
  const h = makeHarness((_path, params) => {
    assert.equal(params?.range, 'lifetime');
    return { items: [] };
  });
  const out = await h.find('statsfm_top_tracks').handler({ user_id: 'martijn' });
  assert.match(h.text(out), /no results/);
});

test('statsfm_top_genres renders genre rows', async () => {
  const h = makeHarness(() => ({ items: [{ position: 1, streams: 320, playedMs: 86364100, genre: 'rock', previewArtists: [] }] }));
  const out = await h.find('statsfm_top_genres').handler({ user_id: 'martijn' });
  assert.match(h.text(out), /rock/);
});

// ---------------------------------------------------------------- streams

test('statsfm_recent_streams forwards after/before cursors', async () => {
  const h = makeHarness((_path, params) => {
    assert.equal(params?.after, '1000');
    assert.equal(params?.before, '2000');
    return streamsFixture();
  });
  const out = await h.find('statsfm_recent_streams').handler({ user_id: 'u', after: 1000, before: 2000 });
  assert.match(h.text(out), /Ya Sonra/);
});

test('statsfm_now_playing reports idle when item is null', async () => {
  const h = makeHarness(() => ({ item: null }));
  const out = await h.find('statsfm_now_playing').handler({ user_id: 'u' });
  assert.match(h.text(out), /Nothing playing/);
});

test('statsfm_now_playing names the current track', async () => {
  const h = makeHarness(() => ({ item: { trackName: 'Ya Sonra', playedMs: 60000, endTime: '2026-05-13T18:29:00.000Z' } }));
  const out = await h.find('statsfm_now_playing').handler({ user_id: 'u' });
  assert.match(h.text(out), /Now playing: "Ya Sonra"/);
});

test('statsfm_track_stats aggregates streams', async () => {
  const h = makeHarness((path, params) => {
    assert.equal(path, '/users/u/streams');
    assert.equal(params?.track, '5816601');
    return streamsFixture();
  });
  const out = await h.find('statsfm_track_stats').handler({ user_id: 'u', track_id: 5816601 });
  assert.match(h.text(out), /2 streams/);
  const sc = out.structuredContent as Record<string, unknown>;
  assert.equal(sc.count, 2);
  assert.equal(sc.totalMs, 500000);
});

test('statsfm_artist_stats filters by artist', async () => {
  const h = makeHarness((path, params) => {
    assert.equal(path, '/users/u/streams');
    assert.equal(params?.artist, '310770');
    return streamsFixture();
  });
  const out = await h.find('statsfm_artist_stats').handler({ user_id: 'u', artist_id: 310770 });
  assert.match(h.text(out), /2 streams/);
});

test('statsfm_album_stats filters by album', async () => {
  const h = makeHarness((path, params) => {
    assert.equal(params?.album, '796569');
    return streamsFixture();
  });
  const out = await h.find('statsfm_album_stats').handler({ user_id: 'u', album_id: 796569 });
  assert.match(h.text(out), /2 streams/);
});

// ---------------------------------------------------------------- search/recaps/stats

test('statsfm_search groups catalog results', async () => {
  const h = makeHarness((path, params) => {
    assert.equal(path, '/search');
    assert.equal(params?.query, 'test');
    return { items: { tracks: [{ id: 1, name: 'Test' }], artists: [{ id: 2, name: 'Tester' }], albums: [] } };
  });
  const out = await h.find('statsfm_search').handler({ query: 'test' });
  assert.match(h.text(out), /tracks:/);
  assert.match(h.text(out), /Test/);
});

test('statsfm_recaps windows streams/stats to the calendar year', async () => {
  const h = makeHarness((path, params) => {
    assert.equal(path, '/users/u/streams/stats');
    assert.equal(params?.after, String(Date.UTC(2024, 0, 1)));
    assert.equal(params?.before, String(Date.UTC(2025, 0, 1)));
    return { items: { count: 912, durationMs: 247615640, cardinality: { tracks: 358, artists: 124, albums: 237 } } };
  });
  const out = await h.find('statsfm_recaps').handler({ user_id: 'u', year: 2024 });
  assert.match(h.text(out), /2024 recap: 912 streams/);
});

test('statsfm_streams_stats renders totals', async () => {
  const h = makeHarness(() => ({ items: { count: 5, durationMs: 600000, cardinality: { tracks: 2, artists: 1, albums: 1 } } }));
  const out = await h.find('statsfm_streams_stats').handler({ user_id: 'u' });
  assert.match(h.text(out), /5 streams/);
});

// ---------------------------------------------------------------- scoped tops + catalog + genre

test('statsfm_top_tracks_from_artist hits the scoped path', async () => {
  const h = makeHarness((path) => {
    assert.equal(path, '/users/u/top/artists/407331/tracks');
    return topTracksFixture();
  });
  const out = await h.find('statsfm_top_tracks_from_artist').handler({ user_id: 'u', artist_id: 407331 });
  assert.match(h.text(out), /Place To Be/);
});

test('statsfm_top_albums_from_artist renders album rows', async () => {
  const h = makeHarness((path) => {
    assert.equal(path, '/users/u/top/artists/407331/albums');
    return { items: [{ position: 1, streams: 62, playedMs: 12617444, album: { name: 'Album X', artists: [{ name: 'A' }] } }] };
  });
  const out = await h.find('statsfm_top_albums_from_artist').handler({ user_id: 'u', artist_id: 407331 });
  assert.match(h.text(out), /Album X/);
});

test('statsfm_top_tracks_from_album hits the scoped path', async () => {
  const h = makeHarness((path) => {
    assert.equal(path, '/users/u/top/albums/9/tracks');
    return topTracksFixture();
  });
  const out = await h.find('statsfm_top_tracks_from_album').handler({ user_id: 'u', album_id: 9 });
  assert.match(h.text(out), /Wicked Game/);
});

test('statsfm_catalog_track looks up by id', async () => {
  const h = makeHarness((path) => {
    assert.equal(path, '/tracks/319641357');
    return { item: { id: 319641357, name: 'Test', durationMs: 90000, artists: [{ name: 'Josephwerwu' }] } };
  });
  const out = await h.find('statsfm_catalog_track').handler({ track_id: 319641357 });
  assert.match(h.text(out), /Test/);
  assert.match(h.text(out), /Josephwerwu/);
});

test('statsfm_catalog_artist surfaces genres', async () => {
  const h = makeHarness(() => ({ item: { id: 1, name: 'X', genres: ['rock'], followers: 10 } }));
  const out = await h.find('statsfm_catalog_artist').handler({ artist_id: 1 });
  assert.match(h.text(out), /rock/);
});

test('statsfm_catalog_album surfaces track count', async () => {
  const h = makeHarness(() => ({ item: { id: 9, name: 'Album X', totalTracks: 16 } }));
  const out = await h.find('statsfm_catalog_album').handler({ album_id: 9 });
  assert.match(h.text(out), /16/);
});

test('statsfm_catalog_track throws when missing', async () => {
  const h = makeHarness(() => ({ item: null }));
  await assert.rejects(() => h.find('statsfm_catalog_track').handler({ track_id: 0 }), /not found/);
});

test('statsfm_genre_artists lists artists for a genre', async () => {
  const h = makeHarness((path) => {
    assert.equal(path, '/genres/rock/artists');
    return { items: [{ id: 1, name: 'Rocky', genres: ['rock'] }] };
  });
  const out = await h.find('statsfm_genre_artists').handler({ genre: 'rock' });
  assert.match(h.text(out), /Rocky/);
});

// ---------------------------------------------------------------- charts

test('statsfm_charts_tracks forces lifetime range with indicators', async () => {
  const h = makeHarness((_path, params) => {
    assert.equal(params?.range, 'lifetime');
    return topTracksFixture();
  });
  const out = await h.find('statsfm_charts_tracks').handler({ user_id: 'u' });
  assert.match(h.text(out), /▲/);
  assert.match(h.text(out), /▼/);
});

test('statsfm_charts_artists and albums render', async () => {
  const h = makeHarness((path) => {
    if (path.endsWith('/top/artists')) return { items: [{ position: 1, streams: 129, playedMs: 28236970, artist: { name: 'Hayko' } }] };
    return { items: [{ position: 1, streams: 62, playedMs: 12617444, album: { name: 'Album X', artists: [] } }] };
  });
  const a = await h.find('statsfm_charts_artists').handler({ user_id: 'u' });
  assert.match(h.text(a), /Hayko/);
  const b = await h.find('statsfm_charts_albums').handler({ user_id: 'u' });
  assert.match(h.text(b), /Album X/);
});

test('statsfm_charts_users ranks friends by stream count', async () => {
  const h = makeHarness((path) => {
    if (path === '/users/u/friends') {
      return { items: [{ id: 'f1', displayName: 'Slow', customId: 'slow' }, { id: 'f2', displayName: 'Fast', customId: 'fast' }] };
    }
    if (path === '/users/f1/streams/stats') return { items: { count: 10 } };
    if (path === '/users/f2/streams/stats') return { items: { count: 99 } };
    throw new Error(`unexpected ${path}`);
  });
  const out = await h.find('statsfm_charts_users').handler({ user_id: 'u' });
  const txt = h.text(out);
  assert.ok(txt.indexOf('Fast') < txt.indexOf('Slow'), `expected Fast ranked first:\n${txt}`);
});

// ---------------------------------------------------------------- date stats + social + records

test('statsfm_track_date_stats passes the window through', async () => {
  const h = makeHarness((_path, params) => {
    assert.equal(params?.track, '1');
    assert.equal(params?.after, '1704067200000');
    assert.equal(params?.before, '1706745600000');
    return streamsFixture();
  });
  const out = await h.find('statsfm_track_date_stats').handler({ user_id: 'u', track_id: 1, after: 1704067200000, before: 1706745600000 });
  assert.match(h.text(out), /2 streams/);
});

test('statsfm_artist_date_stats and album_date_stats aggregate', async () => {
  const h = makeHarness(() => streamsFixture());
  const a = await h.find('statsfm_artist_date_stats').handler({ user_id: 'u', artist_id: 1 });
  assert.match(h.text(a), /2 streams/);
  const b = await h.find('statsfm_album_date_stats').handler({ user_id: 'u', album_id: 1 });
  assert.match(h.text(b), /2 streams/);
});

test('statsfm_friends marks Plus members', async () => {
  const h = makeHarness((path) => {
    assert.equal(path, '/users/u/friends');
    return { items: [{ displayName: 'Marley', customId: 'marley', isPlus: true }] };
  });
  const out = await h.find('statsfm_friends').handler({ user_id: 'u' });
  assert.match(h.text(out), /Marley/);
  assert.match(h.text(out), /★/);
});

test('statsfm_friend_count unwraps the count item', async () => {
  const h = makeHarness((path) => {
    assert.equal(path, '/users/u/friends/count');
    return { item: 7 };
  });
  const out = await h.find('statsfm_friend_count').handler({ user_id: 'u' });
  assert.match(h.text(out), /Friend count: 7/);
  assert.equal((out.structuredContent as Record<string, unknown>).count, 7);
});

test('statsfm_records_artists renders record rows', async () => {
  const h = makeHarness((path) => {
    assert.equal(path, '/users/u/records/artists');
    return { items: [{ artist: { name: 'Hayko' }, streams: 129 }] };
  });
  const out = await h.find('statsfm_records_artists').handler({ user_id: 'u' });
  assert.match(h.text(out), /Hayko/);
});

// ---------------------------------------------------------------- json envelope

test('statsfm tools honor response_format=json', async () => {
  const h = makeHarness(() => topTracksFixture());
  const out = await h.find('statsfm_top_tracks').handler({ user_id: 'u', response_format: 'json' });
  const parsed = JSON.parse(out.content[0].text) as { items: unknown[] };
  assert.equal(parsed.items.length, 2);
});
