/**
 * stats.fm tools: registration surface + behavior against a stubbed
 * StatsfmClient (zero network). Route shapes mirror the live API
 * (verified 2026-09-05): `{ item }` singles, `{ items }` collections.
 */
import './helpers/hermetic.js';

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  StatsfmApiError,
  StatsfmClient,
  __resetStatsfmSleepImpl,
  __setStatsfmSleepImpl,
} from '../src/lib/statsfm-client.js';
import { registerStatsfmTools } from '../src/tools/statsfm.js';
import {
  __resetStatsfmFetchImpl,
  __setStatsfmFetchImpl,
  registerStatsfmTasteTools,
} from '../src/tools/statsfm_taste.js';

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

test('StatsfmClient preserves typed 404 and 429 metadata', async () => {
  const missing = new StatsfmClient(async () => new Response(
    JSON.stringify({ message: 'raw /private/user', error: { reason: 'RESOURCE_NOT_FOUND' } }),
    { status: 404, headers: { 'content-type': 'application/json' } },
  ));
  await assert.rejects(
    () => missing.get('/users/missing'),
    (error: unknown) => error instanceof StatsfmApiError && error.status === 404 && error.reason === 'RESOURCE_NOT_FOUND',
  );

  // `sleepFn` is stubbed to nothing: since #907 the client waits out the
  // advertised Retry-After before its one retry, and 23s of wall clock says
  // nothing about the metadata under assertion here.
  const limited = new StatsfmClient(
    async () => new Response(
      JSON.stringify({ message: 'raw /private/rate', reason: 'QUOTA_EXCEEDED' }),
      { status: 429, headers: { 'content-type': 'application/json', 'retry-after': '23' } },
    ),
    { sleepFn: async () => {} },
  );
  await assert.rejects(
    () => limited.get('/users/busy'),
    (error: unknown) => error instanceof StatsfmApiError && error.status === 429 && error.retryAfterSec === 23 && error.reason === 'QUOTA_EXCEEDED',
  );
});

test('StatsfmClient redacts response messages and preserves classified failure metadata', async () => {
  const cases = [
    { status: 401, reason: 'AUTHENTICATION_REQUIRED' },
    { status: 403, reason: 'ACCESS_FORBIDDEN' },
    { status: 404, reason: 'RESOURCE_NOT_FOUND' },
    { status: 429, reason: 'QUOTA_EXCEEDED', retryAfter: 29 },
    { status: 503, reason: 'SERVICE_UNAVAILABLE' },
  ] as const;

  for (const expected of cases) {
    const client = new StatsfmClient(
      async () => new Response(
        JSON.stringify({
          message: 'private https://example.test/users/alice?token=secret',
          reason: expected.reason,
        }),
        {
          status: expected.status,
          headers: {
            'content-type': 'application/json',
            ...(expected.retryAfter === undefined ? {} : { 'retry-after': String(expected.retryAfter) }),
          },
        },
      ),
      // The 429/503 rows now earn one backoff wait before their retry; the
      // wait's duration is asserted in statsfm-shims.test.ts.
      { sleepFn: async () => {} },
    );
    await assert.rejects(
      () => client.get('/users/alice'),
      (error: unknown) => {
        assert.ok(error instanceof StatsfmApiError);
        assert.equal(error.status, expected.status);
        assert.equal(error.reason, expected.reason);
        assert.equal(error.retryAfterSec, expected.retryAfter);
        assert.doesNotMatch(error.message, /example\.test|alice|token|secret/);
        return true;
      },
    );
  }
});

test('StatsfmClient converts rejected fetches to redacted transport errors', async () => {
  const client = new StatsfmClient(async () => {
    throw new TypeError('fetch failed for https://example.test/private?token=secret');
  });
  await assert.rejects(
    () => client.get('/private'),
    (error: unknown) => {
      assert.ok(error instanceof StatsfmApiError);
      assert.equal(error.status, 0);
      assert.equal(error.reason, 'transport_error');
      assert.equal(error.retryAfterSec, undefined);
      assert.doesNotMatch(error.message, /example\.test|private|token|secret/);
      return true;
    },
  );
});


test('taste tools normalize injected transport failures to shared errors', async () => {
  __setStatsfmFetchImpl(async () => {
    throw new TypeError('private https://example.test/users/alice?token=secret');
  });
  try {
    const handlers = new Map<string, (args: Record<string, unknown>) => Promise<ToolContent>>();
    const server = {
      tool: (name: string, _description: string, _schema: RegisteredTool['schema'], handler: RegisteredTool['handler']) => {
        handlers.set(name, handler);
      },
    };
    registerStatsfmTasteTools(
      server as unknown as Parameters<typeof registerStatsfmTasteTools>[0],
      {} as unknown as Parameters<typeof registerStatsfmTasteTools>[1],
    );
    const handler = handlers.get('statsfm_taste_profile');
    assert.ok(handler);
    await assert.rejects(
      () => handler({ statsfm_user: 'alice' }),
      (error: unknown) => {
        assert.ok(error instanceof StatsfmApiError);
        assert.equal(error.status, 0);
        assert.equal(error.reason, 'transport_error');
        assert.doesNotMatch(error.message, /example\.test|alice|token|secret/);
        return true;
      },
    );
  } finally {
    __resetStatsfmFetchImpl();
  }
});

test('taste tools normalize non-2xx responses and preserve typed metadata', async () => {
  const originalFetch = globalThis.fetch;
  const seen: string[] = [];
  globalThis.fetch = async (url: string | URL | Request) => {
    seen.push(typeof url === 'string' ? url : String(url));
    return new Response(
      JSON.stringify({
        message: 'private https://example.test/users/alice?token=secret',
        reason: 'QUOTA_EXCEEDED',
      }),
      { status: 429, headers: { 'content-type': 'application/json', 'retry-after': '31' } },
    );
  };
  // The wait itself is stubbed; that there IS one, and that it is the
  // advertised 31s, is asserted in statsfm-shims.test.ts. Here the point is
  // that the LIVE default transport — not an injected stub — reaches the taste
  // tools, and that a 429 now costs two dispatches rather than one.
  __setStatsfmSleepImpl(async () => {});
  try {
    const handlers = new Map<string, (args: Record<string, unknown>) => Promise<ToolContent>>();
    const server = {
      tool: (name: string, _description: string, _schema: RegisteredTool['schema'], handler: RegisteredTool['handler']) => {
        handlers.set(name, handler);
      },
    };
    registerStatsfmTasteTools(
      server as unknown as Parameters<typeof registerStatsfmTasteTools>[0],
      {} as unknown as Parameters<typeof registerStatsfmTasteTools>[1],
    );
    const handler = handlers.get('statsfm_taste_profile');
    assert.ok(handler);
    await assert.rejects(
      () => handler({ statsfm_user: 'alice' }),
      (error: unknown) => {
        assert.ok(error instanceof StatsfmApiError);
        assert.equal(error.status, 429);
        assert.equal(error.reason, 'QUOTA_EXCEEDED');
        assert.equal(error.retryAfterSec, 31);
        assert.doesNotMatch(error.message, /example\.test|alice|token|secret/);
        return true;
      },
    );
    // The taste profile tool reads several endpoints and every one of them is
    // a 429 here, so the count is per-path, not a single number: each read is
    // dispatched exactly twice — the original and the one retry — before the
    // error reaches the tool.
    const perPath = new Map<string, number>();
    for (const u of seen) perPath.set(u, (perPath.get(u) ?? 0) + 1);
    assert.ok(perPath.size >= 1, 'the tool dispatched nothing at all');
    for (const [url, dispatches] of perPath) {
      assert.equal(dispatches, 2, `${url} should be dispatched once and retried once`);
    }
  } finally {
    __resetStatsfmSleepImpl();
    __resetStatsfmFetchImpl();
    globalThis.fetch = originalFetch;
  }
});

test('taste tools normalize HTTP 200 error envelopes through the shared client', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(
    JSON.stringify({
      status: 503,
      message: 'private https://example.test/users/alice?token=secret',
      reason: 'SERVICE_UNAVAILABLE',
    }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  );
  __setStatsfmSleepImpl(async () => {});
  try {
    const handlers = new Map<string, (args: Record<string, unknown>) => Promise<ToolContent>>();
    const server = {
      tool: (name: string, _description: string, _schema: RegisteredTool['schema'], handler: RegisteredTool['handler']) => {
        handlers.set(name, handler);
      },
    };
    registerStatsfmTasteTools(
      server as unknown as Parameters<typeof registerStatsfmTasteTools>[0],
      {} as unknown as Parameters<typeof registerStatsfmTasteTools>[1],
    );
    const handler = handlers.get('statsfm_taste_profile');
    assert.ok(handler);
    await assert.rejects(
      () => handler({ statsfm_user: 'alice' }),
      (error: unknown) => {
        assert.ok(error instanceof StatsfmApiError);
        assert.equal(error.status, 503);
        assert.equal(error.reason, 'SERVICE_UNAVAILABLE');
        assert.equal(error.retryAfterSec, undefined);
        assert.doesNotMatch(error.message, /example\.test|alice|token|secret/);
        return true;
      },
    );
  } finally {
    __resetStatsfmSleepImpl();
    __resetStatsfmFetchImpl();
    globalThis.fetch = originalFetch;
  }
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

// ------------------------------------------- per-entity totals (#1006)

/**
 * The entity ids the per-entity tests read.
 */
const ENTITY = { track: 5816601, album: 796569, artist: 310770 };

/**
 * A per-entity aggregate, in the envelope stats.fm actually uses for it.
 *
 * Verified live 2026-09-27: `/users/{id}/streams/tracks/{id}/stats` and the
 * artist route answer `{ items: {...} }`, while the album route answers
 * `{ item: {...} }`. `durationMs` and `count` are the entity's real totals.
 *
 * The name mirrors `src/tools/statsfm.ts`'s own module-private `J`
 * (`Record<string, any>`), which is deliberately not exported — so this file
 * named a type that existed nowhere. tsx strips type positions, so the
 * annotation vanished at runtime and nothing failed until `tests/` was
 * typechecked (#1408). Declared here, next to the fixtures that use it.
 */
type J = Record<string, any>;

function aggregateStats(
  count: number,
  envelope: 'items' | 'item' = 'items',
  cardinality: J | null = { tracks: 1, artists: 1, albums: 1 },
) {
  const stats: J = {
    durationMs: count * 200_000,
    count,
    playedMs: { count, min: 1, max: 200_000, avg: count > 0 ? 200_000 : null, sum: count * 200_000 },
  };
  if (cardinality !== null) stats.cardinality = cardinality;
  return envelope === 'items' ? { items: stats } : { item: stats };
}

/** The entity's own plays, newest first, as the entity-scoped route serves them. */
function entityPlays(count: number) {
  const newest = Date.UTC(2026, 0, 2, 12, 0, 0);
  return Array.from({ length: count }, (_, i) => ({
    id: `e${i}`,
    endTime: new Date(newest - i * 60_000).toISOString(),
    playedMs: 200_000,
    trackId: ENTITY.track,
    trackName: 'Ya Sonra',
    albumId: ENTITY.album,
    artistIds: [ENTITY.artist],
  }));
}

/**
 * Answers the two routes a per-entity read makes: the aggregate, then the play
 * list. `failSample: 'http'` stages a play list that cannot be read at all.
 */
function perEntityResponder(count: number, opts: { plays?: number; failSample?: 'http' } = {}) {
  return (path: string, params?: Record<string, string>) => {
    if (path.endsWith('/stats')) {
      return aggregateStats(count, path.includes('/albums/') ? 'item' : 'items');
    }
    if (opts.failSample === 'http') throw new StatsfmApiError(429, 'stats.fm HTTP 429', 3);
    const limit = Number(params?.limit);
    return { items: entityPlays(opts.plays ?? count).slice(0, limit) };
  };
}

test('the per-entity total is read from stats.fm\'s own aggregate, not a page (#1006)', async () => {
  const h = makeHarness(perEntityResponder(162));
  const out = await h.find('statsfm_track_stats').handler({ user_id: 'u', track_id: ENTITY.track });
  const sc = out.structuredContent as Record<string, unknown>;

  assert.equal(h.calls[0].path, `/users/u/streams/tracks/${ENTITY.track}/stats`);
  assert.equal(sc.count, 162, 'the count is stats.fm\'s aggregate, read whole');
  assert.equal(sc.totalMs, 162 * 200_000);
  assert.equal(sc.source, 'stats.fm per-entity aggregate');
  // The route that silently drops the entity filter cannot answer a per-entity
  // question, so reaching for it would reinstate the page-as-total defect.
  assert.ok(
    !h.calls.some((c) => c.path === '/users/u/streams'),
    'no read may fall back to the unfiltered profile page',
  );
});

test('all six per-entity tools read their own nested route and its own envelope (#1006)', async () => {
  const cases = [
    ['statsfm_track_stats', { track_id: ENTITY.track }, 'tracks', ENTITY.track],
    ['statsfm_artist_stats', { artist_id: ENTITY.artist }, 'artists', ENTITY.artist],
    ['statsfm_album_stats', { album_id: ENTITY.album }, 'albums', ENTITY.album],
    ['statsfm_track_date_stats', { track_id: ENTITY.track, after: 0, before: 4102444800000 }, 'tracks', ENTITY.track],
    ['statsfm_artist_date_stats', { artist_id: ENTITY.artist, after: 0, before: 4102444800000 }, 'artists', ENTITY.artist],
    ['statsfm_album_date_stats', { album_id: ENTITY.album, after: 0, before: 4102444800000 }, 'albums', ENTITY.album],
  ] as const;
  for (const [name, args, segment, id] of cases) {
    const h = makeHarness(perEntityResponder(7));
    const out = await h.find(name).handler({ user_id: 'u', ...args });
    const sc = out.structuredContent as Record<string, unknown>;
    assert.equal(h.calls[0].path, `/users/u/streams/${segment}/${id}/stats`, `${name} must read its own nested route`);
    assert.equal(sc.count, 7, `${name} must report the aggregate's count, not a page of it`);
    assert.match(h.text(out), new RegExp(`^\\S+ ${id}: 7 streams,`), `${name} prose must lead with the measured count`);
  }
});

test('the album aggregate is unwrapped from `item`, not `items` (#1006)', async () => {
  // Reading every kind as `items` leaves the album envelope with no count at
  // all, so the album total would be lost or refused.
  const h = makeHarness((path) =>
    path.endsWith('/stats') ? (path.includes('/albums/') ? aggregateStats(174, 'item') : aggregateStats(1)) : { items: [] },
  );
  const out = await h.find('statsfm_album_stats').handler({ user_id: 'u', album_id: ENTITY.album });
  const sc = out.structuredContent as Record<string, unknown>;
  assert.equal(sc.count, 174, 'the album total must come out of the item envelope');
  assert.equal(sc.totalMs, 174 * 200_000);
});

test('an aggregate with no usable count fails the read instead of reporting zero (#803, #804)', async () => {
  const unreadable = [
    { durationMs: 5 },
    { count: null, durationMs: 5 },
    { count: '162', durationMs: 5 },
    { count: -1, durationMs: 5 },
    { count: 1.5, durationMs: 5 },
    { count: Number.NaN, durationMs: 5 },
    { count: 162 },
    { count: 162, durationMs: 'lots' },
    { count: 162, durationMs: -5 },
  ];
  for (const stats of unreadable) {
    const h = makeHarness((path) => (path.endsWith('/stats') ? { items: stats } : { items: [] }));
    await assert.rejects(
      () => h.find('statsfm_track_stats').handler({ user_id: 'u', track_id: ENTITY.track }),
      /invalid response/,
      `count ${JSON.stringify((stats as J).count)} / durationMs ${JSON.stringify((stats as J).durationMs)} must not read as a total`,
    );
  }
});

test('a measured zero is reported as zero, because stats.fm computed it (#1006)', async () => {
  const h = makeHarness((path) => (path.endsWith('/stats') ? aggregateStats(0) : { items: [] }));
  const out = await h.find('statsfm_track_stats').handler({ user_id: 'u', track_id: 1 });
  const txt = h.text(out);
  const sc = out.structuredContent as Record<string, unknown>;
  assert.equal(sc.count, 0, 'a server-computed zero is a real answer, not a failed read');
  assert.match(txt, /^track 1: 0 streams, 0m total/m);
  assert.match(txt, /Lifetime total/);
  assert.doesNotMatch(txt, /avg/, 'a mean over zero plays is undefined, and 0m would read as a measurement');
  assert.equal(
    sc.avgMs,
    null,
    'the payload must not report avgMs: 0 for an entity with no plays. A mean over zero plays does ' +
      'not exist; 0 is a number that reads as a measurement of a play that never happened. The prose ' +
      'half already omits the mean here, so 0 would make the payload contradict its own text (#804).',
  );
});

test('a windowless read says lifetime; a windowed read names its window (#1006)', async () => {
  const plain = makeHarness(perEntityResponder(162));
  const a = await plain.find('statsfm_track_stats').handler({ user_id: 'u', track_id: ENTITY.track });
  const aSc = a.structuredContent as Record<string, unknown>;
  assert.equal(aSc.lifetime, true);
  assert.equal(aSc.scope, 'lifetime');
  assert.match(plain.text(a), /Lifetime total for this track, computed by stats\.fm/);

  const windowed = makeHarness(perEntityResponder(23));
  const b = await windowed.find('statsfm_track_date_stats').handler({
    user_id: 'u',
    track_id: ENTITY.track,
    after: 1767225600000,
    before: 1769904000000,
  });
  const bSc = b.structuredContent as Record<string, unknown>;
  assert.equal(bSc.lifetime, false, 'a windowed read must not claim to be a lifetime total');
  assert.equal(bSc.scope, 'after 2026-01-01T00:00:00.000Z → before 2026-02-01T00:00:00.000Z');
  assert.match(windowed.text(b), /Total for the after .* → before .* window, computed by stats\.fm for this track/);
  assert.doesNotMatch(windowed.text(b), /Lifetime/, 'windowed prose must not describe the read as lifetime');
  // The window has to reach both reads, or the play list sits beside a total
  // for a different period.
  assert.equal(plain.calls[0].params?.after, undefined, 'a windowless read must not send a window');
  for (const call of windowed.calls) {
    assert.equal(call.params?.after, '1767225600000');
    assert.equal(call.params?.before, '1769904000000');
  }
});

test('a play list that cannot be read leaves the measured total standing and names the reason (#803)', async () => {
  const h = makeHarness(perEntityResponder(162, { failSample: 'http' }));
  const out = await h.find('statsfm_track_stats').handler({ user_id: 'u', track_id: ENTITY.track });
  const txt = h.text(out);
  const sc = out.structuredContent as Record<string, unknown>;
  assert.equal(sc.count, 162, 'the total was read, so a lost sample must not lose it');
  assert.equal(sc.sample_unreadable_reason, 'rate limited (429, retry after 3s)');
  assert.equal(sc.sample_returned, 0);
  assert.deepEqual(sc.streams, []);
  assert.equal(sc.sample_oldest, null);
  assert.match(txt, /could not be read \(rate limited \(429, retry after 3s\)\)/);
  assert.match(txt, /the total above is unaffected/);
});

test('a failed aggregate read is never papered over by counting the play sample (#803)', async () => {
  const h = makeHarness((path) => {
    if (path.endsWith('/stats')) throw new StatsfmApiError(404, 'stats.fm HTTP 404');
    return { items: entityPlays(50) };
  });
  await assert.rejects(
    () => h.find('statsfm_track_stats').handler({ user_id: 'u', track_id: ENTITY.track }),
    /stats\.fm HTTP 404/,
  );
  assert.equal(h.calls.length, 1, 'a total that could not be read must not be replaced by one that could be counted');
});

test('a malformed play list fails the tool rather than being filed as an upstream failure', async () => {
  // A 200-status StatsfmApiError is this module's own envelope assertion, so
  // swallowing it as "the sample is unreadable" would hide a code fault.
  const h = makeHarness((path) => (path.endsWith('/stats') ? aggregateStats(162) : { nope: true }));
  await assert.rejects(
    () => h.find('statsfm_track_stats').handler({ user_id: 'u', track_id: ENTITY.track }),
    /invalid response/,
  );
});

test('the play sample is disclosed as a sample, and its limit reaches the wire (#1006)', async () => {
  for (const limit of [25, 50, 100]) {
    const h = makeHarness(perEntityResponder(162));
    const out = await h.find('statsfm_track_stats').handler({ user_id: 'u', track_id: ENTITY.track, limit });
    const txt = h.text(out);
    const sc = out.structuredContent as Record<string, unknown>;
    assert.equal(sc.count, 162, `limit=${limit} sizes a sample, so it must not move the total`);
    assert.equal(h.calls[1].params?.limit, String(limit), 'the sample limit must reach the wire');
    assert.equal(sc.sample_returned, limit);
    assert.equal(sc.sample_truncated, true);
    assert.match(txt, new RegExp(`Sampled the ${limit} most recent of 162 plays`));
    assert.match(txt, /sampled span/, 'the span must be named as the sample\'s, not the history\'s');
  }
});

test('a play sample smaller than the limit is the whole set, not a cut (#1006)', async () => {
  const h = makeHarness(perEntityResponder(4));
  const out = await h.find('statsfm_track_stats').handler({ user_id: 'u', track_id: ENTITY.track, limit: 50 });
  const txt = h.text(out);
  const sc = out.structuredContent as Record<string, unknown>;
  assert.equal(sc.sample_returned, 4);
  assert.equal(sc.sample_truncated, false);
  assert.match(txt, /All 4 plays \(sampled span /);
  assert.doesNotMatch(txt, /most recent of/);
});

test('the aggregate cardinality is carried through, and an absent one reads as null', async () => {
  const withCard = makeHarness((path) =>
    path.endsWith('/stats')
      ? { items: { durationMs: 9 * 200_000, count: 9, cardinality: { tracks: 66, artists: 14, albums: 31 } } }
      : { items: [] },
  );
  const a = await withCard.find('statsfm_artist_stats').handler({ user_id: 'u', artist_id: ENTITY.artist });
  assert.deepEqual((a.structuredContent as Record<string, unknown>).cardinality, { tracks: 66, artists: 14, albums: 31 });

  const without = makeHarness((path) => (path.endsWith('/stats') ? aggregateStats(9, 'items', null) : { items: [] }));
  const b = await without.find('statsfm_artist_stats').handler({ user_id: 'u', artist_id: ENTITY.artist });
  assert.equal((b.structuredContent as Record<string, unknown>).cardinality, null, 'an absent cardinality is null, not {}');
});

test('json responses carry the same measured total as the prose (#1006)', async () => {
  const h = makeHarness(perEntityResponder(162));
  const out = await h.find('statsfm_track_stats').handler({
    user_id: 'u',
    track_id: ENTITY.track,
    response_format: 'json',
  });
  const parsed = JSON.parse(h.text(out)) as Record<string, unknown>;
  const sc = out.structuredContent as Record<string, unknown>;
  assert.equal(parsed.count, 162);
  assert.equal(parsed.totalMs, sc.totalMs);
  assert.equal(parsed.scope, sc.scope);
  assert.equal(parsed.lifetime, sc.lifetime);
  assert.equal((parsed.streams as unknown[]).length, sc.sample_returned, 'json carries the sample, not a page');
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

test('statsfm_charts_users reports an unreadable friend instead of ranking it as 0 (#803)', async () => {
  const h = makeHarness((path) => {
    if (path === '/users/u/friends') {
      return {
        items: [
          { id: 'f1', displayName: 'Readable', customId: 'readable' },
          { id: 'f2', displayName: 'Secretive', customId: 'secretive' },
          { id: 'f3', displayName: 'Idle', customId: 'idle' },
        ],
      };
    }
    if (path === '/users/f1/streams/stats') return { items: { count: 42 } };
    if (path === '/users/f2/streams/stats') throw new StatsfmApiError(403, 'stats.fm HTTP 403');
    if (path === '/users/f3/streams/stats') return { items: { count: 0 } };
    throw new Error(`unexpected ${path}`);
  });
  const out = await h.find('statsfm_charts_users').handler({ user_id: 'u' });
  const txt = h.text(out);

  // A friend that looked and found nothing is still a real, ranked 0.
  assert.match(txt, /Idle — 0 streams/);
  // A friend we could not read is named with a reason, never with a count.
  assert.doesNotMatch(txt, /Secretive — 0 streams/);
  assert.match(txt, /Secretive — unreadable \(private or gated profile \(403\)\)/);
  // The summary says the chart is partial and how many friends are missing.
  assert.match(txt, /1 of 3 unreadable — partial result/);
  assert.match(txt, /Unreadable — stream count unknown, not zero \(1, excluded from the ranking\)/);

  const sc = out.structuredContent as Record<string, unknown>;
  assert.equal(sc.unreadable_count, 1);
  assert.deepEqual((sc.unreadable as Array<Record<string, unknown>>).map((u) => u.customId), ['secretive']);
  const items = sc.items as Array<Record<string, unknown>>;
  assert.deepEqual(items.map((i) => i.customId), ['readable', 'idle']);

  // No retry: a failed lookup is reported, not hammered again.
  assert.equal(h.calls.filter((c) => c.path === '/users/f2/streams/stats').length, 1);
});

test('statsfm_charts_users marks a throttled friend unreadable without a stream count (#803)', async () => {
  const h = makeHarness((path) => {
    if (path === '/users/u/friends') return { items: [{ id: 'f1', displayName: 'Busy', customId: 'busy' }] };
    if (path === '/users/f1/streams/stats') throw new StatsfmApiError(429, 'stats.fm HTTP 429', 30, 'QUOTA_EXCEEDED');
    throw new Error(`unexpected ${path}`);
  });
  const out = await h.find('statsfm_charts_users').handler({ user_id: 'u' });
  const txt = h.text(out);
  assert.match(txt, /no friend profile could be read/);
  assert.match(txt, /Busy — unreadable \(rate limited \(429, retry after 30s\)\)/);
  assert.doesNotMatch(txt, /0 streams/);
  assert.equal(h.calls.length, 2, 'friends list + one stats attempt; no retry into the rate limit');
});

test('statsfm_charts_users claims nothing unreadable when the friend list is empty (#803)', async () => {
  const h = makeHarness((path) => {
    if (path === '/users/u/friends') return { items: [] };
    throw new Error(`unexpected ${path}`);
  });
  const out = await h.find('statsfm_charts_users').handler({ user_id: 'u' });
  const txt = h.text(out);
  // An empty friend list is a complete answer, not a set of unreadable
  // profiles — claiming otherwise would be the same fabrication #803 removes.
  assert.doesNotMatch(txt, /unreadable/);
  assert.doesNotMatch(txt, /could be read/);
  assert.equal((out.structuredContent as Record<string, unknown>).unreadable_count, 0);
  assert.equal(h.calls.length, 1, 'no per-friend lookups when there are no friends');
});

// ---------------------------------------------------------------- date stats + social + records

test('a date-windowed read passes the window to the aggregate, not as an entity filter (#1006)', async () => {
  const h = makeHarness((path) => {
    assert.equal(path, `/users/u/streams/tracks/${ENTITY.track}/stats`);
    return aggregateStats(23);
  });
  const out = await h.find('statsfm_track_date_stats').handler({
    user_id: 'u',
    track_id: ENTITY.track,
    after: 1704067200000,
    before: 1706745600000,
  });
  assert.equal(h.calls[0].params?.after, '1704067200000');
  assert.equal(h.calls[0].params?.before, '1706745600000');
  // The entity is in the path now, so it must not also travel as a query
  // parameter — that parameter was the one stats.fm silently dropped.
  assert.equal(h.calls[0].params?.track, undefined);
  assert.match(h.text(out), /23 streams/);
});

test('the windowed artist and album tools report their own aggregates (#1006)', async () => {
  const a = makeHarness((path) => (path.endsWith('/stats') ? aggregateStats(31) : { items: [] }));
  const artistOut = await a.find('statsfm_artist_date_stats').handler({ user_id: 'u', artist_id: ENTITY.artist });
  assert.equal(a.calls[0].path, `/users/u/streams/artists/${ENTITY.artist}/stats`);
  assert.equal((artistOut.structuredContent as Record<string, unknown>).count, 31);

  const b = makeHarness((path) => (path.endsWith('/stats') ? aggregateStats(12, 'item') : { items: [] }));
  const albumOut = await b.find('statsfm_album_date_stats').handler({ user_id: 'u', album_id: ENTITY.album });
  assert.equal(b.calls[0].path, `/users/u/streams/albums/${ENTITY.album}/stats`);
  assert.equal((albumOut.structuredContent as Record<string, unknown>).count, 12);
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

test('statsfm rejects malformed and structurally invalid collection responses', async () => {
  for (const body of [null, [], { items: null }, { items: {} }]) {
    const h = makeHarness(() => body);
    await assert.rejects(
      () => h.find('statsfm_top_tracks').handler({ user_id: 'u' }),
      (error: unknown) => error instanceof StatsfmApiError && /invalid response/.test(error.message),
    );
  }
});

test('statsfm rejects wrong JSON types for single, search, and stats responses', async () => {
  const cases = [
    ['statsfm_resolve_user', { user_id: 'u' }, null],
    ['statsfm_search', { query: 'x' }, []],
    ['statsfm_streams_stats', { user_id: 'u' }, { items: [] }],
  ] as const;
  for (const [name, args, body] of cases) {
    const h = makeHarness(() => body);
    await assert.rejects(
      () => h.find(name).handler(args),
      (error: unknown) => error instanceof StatsfmApiError && /invalid response/.test(error.message),
    );
  }
});

test('statsfm preserves a legitimate null now-playing item', async () => {
  const h = makeHarness(() => ({ item: null }));
  const out = await h.find('statsfm_now_playing').handler({ user_id: 'u', response_format: 'json' });
  assert.deepEqual(JSON.parse(out.content[0].text), null);
  assert.deepEqual(out.structuredContent, { item: null });
});

// ------------------------------------------------- #1297 scoped-top paging
//
// The three scoped top routes ignore `limit`/`offset` upstream: their swagger
// entry declares `"parameters": []`, and live probes on 2026-09-27 returned
// byte-identical bodies for limit=1, limit=5, limit=1000 and offset=40. The
// tests below drive that upstream behaviour — a stub that ignores the
// parameters exactly as stats.fm does — and assert what the CALLER gets back.

/** An upstream that ignores limit/offset, as the three scoped routes do. */
function ignoresBounds(count: number) {
  return () => ({
    items: Array.from({ length: count }, (_unused, i) => ({
      position: i + 1,
      streams: 1000 - i,
      playedMs: 60000,
      indicator: null,
      track: { name: `Track ${i + 1}`, artists: [{ name: 'A' }], albums: [{ name: 'Alb' }] },
    })),
  });
}

test('scoped top honours limit the caller asked for (#1297)', async () => {
  const h = makeHarness(ignoresBounds(91));
  const out = await h.find('statsfm_top_tracks_from_artist').handler({ user_id: 'u', artist_id: 1, limit: 1 });
  const page = (out.structuredContent?.items ?? []) as Array<{ track: { name: string } }>;
  assert.equal(page.length, 1, 'a limit of 1 must return one row, not the whole ranking');
  assert.equal(page[0].track.name, 'Track 1');
  assert.doesNotMatch(h.text(out), /Track 2\b/, 'row 2 is outside the requested page');
});

test('scoped top reports the true total, not the page length (#1297)', async () => {
  const h = makeHarness(ignoresBounds(91));
  const out = await h.find('statsfm_top_tracks_from_artist').handler({ user_id: 'u', artist_id: 1, limit: 3 });
  const page = (out.structuredContent?.items ?? []) as unknown[];
  assert.equal(page.length, 3, 'three rows were asked for and returned');
  const pagination = out.structuredContent?.pagination as { total: number | null; offset: number };
  assert.equal(pagination.total, 91, 'the 91-row ranking is complete here, so 91 is the real total');
  assert.match(h.text(out), /showing 3 of 91/, 'the prose must show the page against the whole set');
});

test('scoped top offset pages into the ranking (#1297)', async () => {
  const h = makeHarness(ignoresBounds(91));
  const out = await h.find('statsfm_top_tracks_from_artist').handler({ user_id: 'u', artist_id: 1, limit: 2, offset: 40 });
  const page = (out.structuredContent?.items ?? []) as Array<{ track: { name: string } }>;
  assert.deepEqual(page.map((r) => r.track.name), ['Track 41', 'Track 42'], 'offset=40 is the 41st row');
  // Rows are numbered from the caller's offset, not restarted at 1.
  assert.match(h.text(out), /^\s*41\. /m);
  assert.match(h.text(out), /^\s*42\. /m);
  assert.doesNotMatch(h.text(out), /^\s*1\. /m, 'the list must not restart its numbering at the page');
});

test('scoped top next_offset points at the following page (#1297)', async () => {
  const h = makeHarness(ignoresBounds(91));
  const out = await h.find('statsfm_top_tracks_from_artist').handler({ user_id: 'u', artist_id: 1, limit: 10 });
  const pagination = out.structuredContent?.pagination as { next_offset: number | null };
  assert.equal(pagination.next_offset, 10);
});

test('scoped top at the upstream ceiling refuses to invent a total (#1297)', async () => {
  // 100 rows is the ceiling observed on the scoped routes. The ranking may be
  // larger, so 100 must NOT be reported as the total.
  const h = makeHarness(ignoresBounds(100));
  const out = await h.find('statsfm_top_tracks_from_artist').handler({ user_id: 'u', artist_id: 1, limit: 5 });
  const page = (out.structuredContent?.items ?? []) as unknown[];
  assert.equal(page.length, 5, 'the page is still bounded');
  const pagination = out.structuredContent?.pagination as { total: number | null; next_offset: number | null };
  assert.equal(pagination.total, null, 'a ceiling-sized response is not a readable total');
  assert.equal(out.structuredContent?.total_unreadable, true);
  assert.equal(out.structuredContent?.received, 100);
  assert.match(h.text(out), /at least 100/);
  assert.match(h.text(out), /limit\/offset/);
});

test('scoped top below the ceiling still reports its real total (#1297)', async () => {
  const h = makeHarness(ignoresBounds(99));
  const out = await h.find('statsfm_top_tracks_from_artist').handler({ user_id: 'u', artist_id: 1, limit: 5 });
  const pagination = out.structuredContent?.pagination as { total: number | null };
  assert.equal(pagination.total, 99, '99 is under the ceiling, so the set is complete and 99 is the total');
  assert.equal(out.structuredContent?.total_unreadable, undefined);
});

test('all three scoped tops window the same way (#1297)', async () => {
  const cases = [
    ['statsfm_top_tracks_from_artist', { user_id: 'u', artist_id: 1 }],
    ['statsfm_top_albums_from_artist', { user_id: 'u', artist_id: 1 }],
    ['statsfm_top_tracks_from_album', { user_id: 'u', album_id: 9 }],
  ] as const;
  for (const [name, args] of cases) {
    const h = makeHarness(() => ({
      items: Array.from({ length: 91 }, (_unused, i) => ({
        position: i + 1,
        streams: 1000 - i,
        playedMs: 60000,
        album: { name: `Album ${i + 1}`, artists: [{ name: 'A' }] },
        track: { name: `Track ${i + 1}`, artists: [{ name: 'A' }] },
      })),
    }));
    const out = await h.find(name).handler({ ...args, limit: 1, offset: 4 });
    const page = (out.structuredContent?.items ?? []) as unknown[];
    assert.equal(page.length, 1, `${name} must return the one row asked for`);
    const pagination = out.structuredContent?.pagination as { total: number | null; offset: number };
    assert.equal(pagination.total, 91, `${name} must report the whole ranking`);
    assert.equal(pagination.offset, 4);
  }
});

test('a small ranking is not sliced twice (#1297)', async () => {
  // 3 rows, limit 10: the whole set fits the page, so every row is returned.
  const h = makeHarness(ignoresBounds(3));
  const out = await h.find('statsfm_top_tracks_from_artist').handler({ user_id: 'u', artist_id: 1, limit: 10 });
  const page = (out.structuredContent?.items ?? []) as unknown[];
  assert.equal(page.length, 3);
});

test('offset past the end yields no rows, not a wrapped page (#1297)', async () => {
  const h = makeHarness(ignoresBounds(91));
  const out = await h.find('statsfm_top_tracks_from_artist').handler({ user_id: 'u', artist_id: 1, limit: 5, offset: 500 });
  const page = (out.structuredContent?.items ?? []) as unknown[];
  assert.equal(page.length, 0, 'an out-of-range offset returns nothing rather than wrapping to the top');
});

test('scoped top json carries pagination and the page (#1297)', async () => {
  const h = makeHarness(ignoresBounds(91));
  const out = await h.find('statsfm_top_tracks_from_artist').handler({
    user_id: 'u', artist_id: 1, limit: 2, response_format: 'json',
  });
  const parsed = JSON.parse(out.content[0].text) as {
    items: unknown[];
    pagination: { total: number | null; returned: number; next_offset: number | null };
  };
  assert.equal(parsed.items.length, 2, 'json must carry the page, not all 91 rows');
  assert.equal(parsed.pagination.total, 91);
  assert.equal(parsed.pagination.returned, 2);
  assert.equal(parsed.pagination.next_offset, 2);
});

test('scoped top still sends limit/offset on the wire (#1297)', async () => {
  // They are inert upstream today, but dropping them would mean a stats.fm that
  // starts honouring them silently changes the page.
  const h = makeHarness(ignoresBounds(91));
  await h.find('statsfm_top_tracks_from_artist').handler({ user_id: 'u', artist_id: 1, limit: 3, offset: 6 });
  const call = h.calls.at(-1);
  assert.equal(call?.params?.limit, '3');
  assert.equal(call?.params?.offset, '6');
});

test('the flat top routes are untouched by the scoped window (#1297)', async () => {
  // statsfm_top_tracks does honour limit upstream, so its payload must reach the
  // caller exactly as received — no client-side re-slicing, and no ceiling
  // disclosure it has no reason to make.
  const h = makeHarness(() => ({
    items: Array.from({ length: 4 }, (_unused, i) => ({
      position: i + 1, streams: 10 - i, playedMs: 1000,
      track: { name: `T${i + 1}`, artists: [{ name: 'A' }] },
    })),
  }));
  const out = await h.find('statsfm_top_tracks').handler({ user_id: 'u', limit: 2, offset: 1 });
  const page = (out.structuredContent?.items ?? []) as Array<{ track: { name: string } }>;
  assert.equal(page.length, 4, 'the flat route is passed through as upstream returned it');
  assert.equal(out.structuredContent?.total_unreadable, undefined, 'no ceiling claim on a route that does not need one');
});
