/**
 * stats.fm tools: registration surface + behavior against a stubbed
 * StatsfmClient (zero network). Route shapes mirror the live API
 * (verified 2026-09-05): `{ item }` singles, `{ items }` collections.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { StatsfmApiError, StatsfmClient } from '../src/lib/statsfm-client.js';
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

  const limited = new StatsfmClient(async () => new Response(
    JSON.stringify({ message: 'raw /private/rate', reason: 'QUOTA_EXCEEDED' }),
    { status: 429, headers: { 'content-type': 'application/json', 'retry-after': '23' } },
  ));
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
    const client = new StatsfmClient(async () => new Response(
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
    ));
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
  globalThis.fetch = async () => new Response(
    JSON.stringify({
      message: 'private https://example.test/users/alice?token=secret',
      reason: 'QUOTA_EXCEEDED',
    }),
    { status: 429, headers: { 'content-type': 'application/json', 'retry-after': '31' } },
  );
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
  } finally {
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

test('statsfm_track_stats aggregates streams', async () => {
  const h = makeHarness((path, params) => {
    assert.equal(path, '/users/u/streams');
    assert.equal(params?.track, '1');
    return streamsFixture();
  });
  const out = await h.find('statsfm_track_stats').handler({ user_id: 'u', track_id: 1 });
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
    assert.equal(params?.album, '9');
    return streamsFixture();
  });
  const out = await h.find('statsfm_album_stats').handler({ user_id: 'u', album_id: 9 });
  assert.match(h.text(out), /2 streams/);
});

// ------------------------------------------- page-bounded stream stats (#810)

/**
 * A profile's stream history, newest first, as stats.fm returns it: at most
 * `limit` entries per call, `before`/`after` bounds honoured inclusively, and
 * both `offset` and the entity filter silently dropped (verified against the
 * live API 2026-09-25). Nothing here is derived from the caller's arguments
 * except the paging the endpoint really honours, so every page mixes plays of
 * the requested entity with plays of anything else — one page of N is N
 * streams of the profile, not N plays of the entity.
 */
const ENTITY = { track: 5816601, album: 796569, artist: 310770 };

function streamHistory(count: number, matchesEvery = 3) {
  const newest = Date.UTC(2026, 0, 2, 12, 0, 0);
  return Array.from({ length: count }, (_, i) => {
    const mine = i % matchesEvery === 0;
    return {
      id: `h${i}`,
      endTime: new Date(newest - i * 60_000).toISOString(),
      playedMs: 200_000,
      trackId: mine ? ENTITY.track : 900_000 + i,
      trackName: mine ? 'Ya Sonra' : 'Something Else',
      albumId: mine ? ENTITY.album : 800_000 + i,
      artistIds: [mine ? ENTITY.artist : 700_000 + i],
    };
  });
}

/** How many of the first `pageSize` history rows are plays of the entity. */
function matchingIn(history: ReturnType<typeof streamHistory>, pageSize: number, matchesEvery = 3): number {
  return history.slice(0, pageSize).filter((_, i) => i % matchesEvery === 0).length;
}

function streamsPageResponder(history: ReturnType<typeof streamHistory>) {
  return (path: string, params?: Record<string, string>) => {
    assert.equal(path, '/users/u/streams');
    const limit = Number(params?.limit);
    assert.ok(Number.isInteger(limit) && limit > 0, `limit must reach the wire: ${JSON.stringify(params)}`);
    const after = params?.after === undefined ? -Infinity : Number(params.after);
    const before = params?.before === undefined ? Infinity : Number(params.before);
    return {
      items: history
        .filter((s) => Date.parse(s.endTime) >= after && Date.parse(s.endTime) <= before)
        .slice(0, limit),
    };
  };
}

/** The count a reader of the prose would take away. */
function proseCount(text: string): number {
  const lead = /^[^:\n]+: (\d+) streams,/m.exec(text);
  assert.ok(lead, `prose must lead with the stream count it reports: ${text}`);
  return Number(lead[1]);
}

test('a full page is disclosed as partial, and is not a total of the entity (#810)', async () => {
  const history = streamHistory(300);
  const h = makeHarness(streamsPageResponder(history));
  const out = await h.find('statsfm_track_stats').handler({ user_id: 'u', track_id: ENTITY.track });
  const txt = h.text(out);
  const sc = out.structuredContent as Record<string, unknown>;

  // Wire: one page of 50, and no reliance on `offset` (upstream ignores it).
  assert.equal(h.calls.length, 1);
  assert.equal(h.calls[0].params?.limit, '50');
  assert.equal(h.calls[0].params?.offset, undefined);

  // The page held 50 streams, but only some are plays of the track: the
  // reported figure is the part actually read, and it is flagged partial.
  const expected = matchingIn(history, 50);
  assert.equal(sc.streams_read, 50);
  assert.equal(sc.page_size, 50);
  assert.equal(sc.capped, true);
  assert.equal(sc.count, expected);
  assert.notEqual(sc.count, 50, 'a page of 50 streams is not 50 plays of the track');
  assert.equal(sc.totalMs, expected * 200_000, 'only the matching streams are totalled');
  assert.match(txt, new RegExp(`${expected} of the 50 streams`));
  assert.match(txt, /not a lifetime total/);
  assert.match(txt, /page span:/);
  assert.equal(proseCount(txt), sc.count, 'prose and structuredContent must agree on the count');
});

test('a history shorter than the page reports its true count with no capped flag (#810)', async () => {
  const h = makeHarness(streamsPageResponder(streamHistory(7, 1)));
  const out = await h.find('statsfm_track_stats').handler({ user_id: 'u', track_id: ENTITY.track });
  const txt = h.text(out);
  const sc = out.structuredContent as Record<string, unknown>;

  assert.equal(h.calls[0].params?.limit, '50');
  assert.equal(sc.count, 7, 'the whole exposed history fits, so the count is the real one');
  assert.equal('capped' in sc, false, 'a short page is not a truncated read');
  assert.equal(sc.page_size, 50);
  assert.equal(sc.streams_read, 7);
  assert.doesNotMatch(txt, /Partial:/);
  assert.equal(proseCount(txt), sc.count, 'prose and structuredContent must agree on the count');
});

test('a complete read that holds no play of the entity says so, not "0 lifetime plays" (#810)', async () => {
  const h = makeHarness(streamsPageResponder(streamHistory(6, 3)));
  const out = await h.find('statsfm_track_stats').handler({ user_id: 'u', track_id: 4242424 });
  const txt = h.text(out);
  const sc = out.structuredContent as Record<string, unknown>;
  assert.equal(sc.count, 0);
  assert.equal('capped' in sc, false);
  assert.match(txt, /include none for this track/);
  assert.equal(proseCount(txt), 0);
});

test('the reported page size follows the limit that actually went out on the wire (#810)', async () => {
  const history = streamHistory(300);
  for (const limit of [25, 50, 100]) {
    const h = makeHarness(streamsPageResponder(history));
    const out = await h.find('statsfm_track_stats').handler({ user_id: 'u', track_id: ENTITY.track, limit });
    const txt = h.text(out);
    const sc = out.structuredContent as Record<string, unknown>;
    assert.equal(h.calls[0].params?.limit, String(limit));
    assert.equal(sc.page_size, limit, `page_size must mirror the requested page (limit=${limit})`);
    assert.equal(sc.streams_read, limit, `limit=${limit} reads exactly one page of that size`);
    assert.equal(sc.count, matchingIn(history, limit), `limit=${limit} counts only the entity's plays on that page`);
    assert.equal(sc.capped, true, `a full page of ${limit} leaves older history unread`);
    assert.match(txt, new RegExp(`${sc.count} of the ${limit} streams`));
    assert.equal(proseCount(txt), sc.count);
  }
});

test('a page that exactly fills the limit is still not read as the whole history (#810)', async () => {
  // The endpoint exposes no total, so a full page is indistinguishable from a
  // truncated one: it must be reported as partial rather than as a total.
  const h = makeHarness(streamsPageResponder(streamHistory(50, 1)));
  const out = await h.find('statsfm_track_stats').handler({ user_id: 'u', track_id: ENTITY.track, limit: 50 });
  const sc = out.structuredContent as Record<string, unknown>;
  assert.equal(sc.count, 50);
  assert.equal(sc.capped, true);
  assert.match(h.text(out), /not a lifetime total/);
});

test('all six per-entity stats tools disclose a truncated page (#810)', async () => {
  const cases = [
    ['statsfm_track_stats', { track_id: ENTITY.track }, 'track'],
    ['statsfm_artist_stats', { artist_id: ENTITY.artist }, 'artist'],
    ['statsfm_album_stats', { album_id: ENTITY.album }, 'album'],
    ['statsfm_track_date_stats', { track_id: ENTITY.track, after: 0, before: 4102444800000 }, 'track'],
    ['statsfm_artist_date_stats', { artist_id: ENTITY.artist, after: 0, before: 4102444800000 }, 'artist'],
    ['statsfm_album_date_stats', { album_id: ENTITY.album, after: 0, before: 4102444800000 }, 'album'],
  ] as const;
  const history = streamHistory(300);
  for (const [name, args, filter] of cases) {
    const h = makeHarness(streamsPageResponder(history));
    const out = await h.find(name).handler({ user_id: 'u', ...args });
    const txt = h.text(out);
    const sc = out.structuredContent as Record<string, unknown>;
    assert.equal(sc.capped, true, `${name} must flag a full page as truncated`);
    assert.equal(sc.count, matchingIn(history, sc.page_size as number), `${name} counts only this ${filter}'s plays on the page`);
    assert.equal(proseCount(txt), sc.count, `${name} prose must agree with its payload`);
    // Deliberately NOT asserting which page was read. The six tools do not share
    // a read shape: the plain ones take the profile's newest page, the
    // *_date_stats ones pass an after/before window. A qualifier naming "the
    // profile's newest page" is false for the second group, so this asserts the
    // claim that holds for both, and pins the false one out.
    assert.match(txt, new RegExp(`are this ${filter}\\.`), `${name} must say how many of the read are this ${filter}`);
    assert.match(txt, /this read returned/, `${name} must not claim which page was read`);
    assert.doesNotMatch(txt, /newest page/, `${name} must not describe a windowed read as the newest page`);
    assert.match(txt, /not a lifetime total/, `${name} prose must not read as a lifetime total`);
    if (name.endsWith('_date_stats')) {
      const params = h.calls[0].params ?? {};
      assert.equal(params.after, String(args.after), `${name} must forward the window start`);
      assert.equal(params.before, String(args.before), `${name} must forward the window end`);
    }
  }
});

test('json responses carry the same page disclosure as the prose (#810)', async () => {
  const history = streamHistory(300);
  const h = makeHarness(streamsPageResponder(history));
  const out = await h.find('statsfm_track_stats').handler({
    user_id: 'u',
    track_id: ENTITY.track,
    response_format: 'json',
  });
  const sc = out.structuredContent as Record<string, unknown>;
  assert.equal(sc.capped, true);
  assert.equal(sc.page_size, 50);
  assert.equal(sc.count, matchingIn(history, 50));
  assert.equal((sc.streams as unknown[]).length, sc.count, 'the json body carries only the entity\'s streams');
  const parsed = JSON.parse(h.text(out)) as Record<string, unknown>;
  assert.equal(parsed.count, sc.count);
  assert.equal(parsed.capped, sc.capped);
  assert.equal(parsed.page_size, sc.page_size);
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
  const a = await h.find('statsfm_artist_date_stats').handler({ user_id: 'u', artist_id: 310770 });
  assert.match(h.text(a), /2 streams/);
  const b = await h.find('statsfm_album_date_stats').handler({ user_id: 'u', album_id: 9 });
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
