import test from 'node:test';
import assert from 'node:assert/strict';
import { registerCatalogTools, resetProfileCountryCache as resetCatalogMarketCache } from '../src/tools/catalog.js';
import { SpotifyApiError } from '../src/client.js';
import { registerAudiobookTools, resetProfileCountryCache as resetAudiobooksMarketCache } from '../src/tools/audiobooks.js';

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

type Call = { method: string; path: string; params?: Record<string, string> };

interface ClientOptions {
  getResponse?: (path: string, params?: Record<string, string>) => unknown;
  getError?: (path: string, params?: Record<string, string>) => unknown;
}

const artist = { id: 'art1', name: 'Queen', uri: 'spotify:artist:art1' };
const albumSimple = {
  id: 'alb1',
  name: 'A Night at the Opera',
  uri: 'spotify:album:alb1',
  images: [] as Array<{ url: string; height: number | null; width: number | null }>,
};

function trackFixture(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: 'trk1',
    name: 'Bohemian Rhapsody',
    uri: 'spotify:track:trk1',
    type: 'track' as const,
    duration_ms: 355000,
    explicit: false,
    artists: [artist],
    album: albumSimple,
    ...overrides,
  };
}

function trackSimpleFixture(overrides: Partial<Record<string, unknown>> = {}) {
  return trackFixture({ track_number: 1, ...overrides });
}

function showSimpleFixture() {
  return {
    id: 'shw1',
    name: 'Great Podcast',
    uri: 'spotify:show:shw1',
    description: 'A great show',
    publisher: 'Acme Media',
    total_episodes: 12,
    languages: ['en'],
    media_type: 'audio',
  };
}

function episodeSimpleFixture(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: 'ep1',
    name: 'Episode One',
    uri: 'spotify:episode:ep1',
    duration_ms: 1800000,
    release_date: '2026-01-01',
    explicit: false,
    description: 'The first episode',
    show: showSimpleFixture(),
    resume_point: undefined,
    ...overrides,
  };
}
function albumFullFixture() {
  return {
    id: 'alb1',
    name: 'A Night at the Opera',
    uri: 'spotify:album:alb1',
    release_date: '1975-10-31',
    total_tracks: 1,
    artists: [artist],
    tracks: { items: [trackSimpleFixture()], total: 1 },
  };
}


function makeHarness(
  register: (server: never, client: never) => void,
  opts: ClientOptions = {},
) {
  const calls: Call[] = [];
  const client = {
    get: async (path: string, params?: Record<string, string>) => {
      const err = opts.getError?.(path, params);
      if (err !== undefined) {
        calls.push(params === undefined ? { method: 'GET', path } : { method: 'GET', path, params });
        throw err;
      }
      calls.push(params === undefined ? { method: 'GET', path } : { method: 'GET', path, params });
      return opts.getResponse ? opts.getResponse(path, params) : null;
    },
    post: async (path: string) => {
      calls.push({ method: 'POST', path });
      return null;
    },
    put: async (path: string, body?: unknown) => {
      calls.push({ method: 'PUT', path, body });
    },
    delete: async (path: string) => {
      calls.push({ method: 'DELETE', path });
    },
    getAllPages: async () => [],
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
  register(server as never, client as never);
  return { registered, calls };
}

function findTool(registered: RegisteredTool[], name: string): RegisteredTool {
  const tool = registered.find((t) => t.name === name);
  assert.ok(tool, `expected tool ${name} to be registered`);
  return tool;
}

async function invoke(tool: RegisteredTool, args: Record<string, unknown> = {}) {
  return (tool.handler as (a: Record<string, unknown>) => Promise<ToolContent>)(args);
}

function text(result: ToolContent): string {
  return result.content.map((c) => c.text).join('\n');
}

// ------------------------------------------------------------------ get_track

test('get_track fetches /tracks/{id} and renders details', async () => {
  const { registered, calls } = makeHarness(registerCatalogTools, {
    getResponse: (path) => (path === '/tracks/trk1' ? trackFixture() : undefined),
  });

  const out = text(await invoke(findTool(registered, 'get_track'), { id: 'trk1' }));

  assert.deepEqual(calls, [{ method: 'GET', path: '/tracks/trk1' }]);
  assert.match(out, /"Bohemian Rhapsody" by Queen/);
  assert.match(out, /Album: A Night at the Opera/);
  // 355000ms -> 5:55
  assert.match(out, /Duration: 5:55/);
  assert.match(out, /Explicit: no/);
  assert.match(out, /URI: spotify:track:trk1/);
});

test('get_track url-encodes special characters in ids', async () => {
  const { registered, calls } = makeHarness(registerCatalogTools, {
    getResponse: (path) => (path === '/tracks/a%2Fb' ? trackFixture() : undefined),
  });

  await invoke(findTool(registered, 'get_track'), { id: 'a/b' });

  assert.equal(calls[0].path, '/tracks/a%2Fb');
});

test('get_artist renders genres or a fallback when none listed', async () => {
  const artistFull = {
    id: 'art1',
    name: 'Queen',
    uri: 'spotify:artist:art1',
    genres: ['classic rock', 'glam rock'],
    followers: { total: 1000 },
    images: [],
  };
  const { registered, calls } = makeHarness(registerCatalogTools, {
    getResponse: (path) => (path === '/artists/art1' ? artistFull : undefined),
  });

  const out = text(await invoke(findTool(registered, 'get_artist'), { id: 'art1' }));

  assert.deepEqual(calls, [{ method: 'GET', path: '/artists/art1' }]);
  assert.match(out, /Artist: Queen/);
  assert.match(out, /Genres: classic rock, glam rock/);

  const noGenresHarness = makeHarness(registerCatalogTools, {
    getResponse: (path) => (path === '/artists/art2' ? { ...artistFull, id: 'art2', genres: [] } : undefined),
  });
  const outNone = text(await invoke(findTool(noGenresHarness.registered, 'get_artist'), { id: 'art2' }));
  assert.match(outNone, /Genres: none listed/);
});

// --------------------------------------------------------- get_artist_albums

test('get_artist_albums sends default include_groups and limit params', async () => {
  const response = {
    items: [
      {
        id: 'alb1',
        name: 'A Night at the Opera',
        uri: 'spotify:album:alb1',
        album_type: 'album',
        release_date: '1975-10-31',
        total_tracks: 12,
        artists: [artist],
      },
    ],
    total: 15,
  };
  resetCatalogMarketCache();
  const { registered, calls } = makeHarness(registerCatalogTools, {
    getResponse: (path) => (path === '/artists/art1/albums' ? response : undefined),
  });

  const out = text(await invoke(findTool(registered, 'get_artist_albums'), { id: 'art1' }));

  // No market supplied: a /me preflight resolves the account country (undefined
  // here), so no market param is sent.
  assert.deepEqual(calls, [
    { method: 'GET', path: '/me' },
    {
      method: 'GET',
      path: '/artists/art1/albums',
      params: { include_groups: 'album,single', limit: '10', offset: '0' },
    },
  ]);
  assert.match(out, /Albums for artist \(15 total\)/);
  assert.match(out, /"A Night at the Opera" by Queen \(album, 1975-10-31, 12 tracks\)/);
});

test('get_artist_albums forwards custom include_groups and limit', async () => {
  resetCatalogMarketCache();
  const { registered, calls } = makeHarness(registerCatalogTools, {
    getResponse: (path) =>
      path === '/artists/art1/albums' ? { items: [], total: 0 } : undefined,
  });

  await invoke(findTool(registered, 'get_artist_albums'), {
    id: 'art1',
    include_groups: ['appears_on', 'compilation'],
    limit: 50,
  });

  assert.deepEqual(calls.find((c) => c.path === '/artists/art1/albums')!.params, {
    include_groups: 'appears_on,compilation',
    limit: '50',
    offset: '0',
  });
});

// ------------------------------------------------------------------ get_album

test('get_album fetches /albums/{id} and lists embedded tracks', async () => {
  const albumFull = {
    id: 'alb1',
    name: 'A Night at the Opera',
    uri: 'spotify:album:alb1',
    release_date: '1975-10-31',
    total_tracks: 2,
    artists: [artist],
    tracks: {
      items: [
        trackSimpleFixture(),
        trackSimpleFixture({ id: 'trk2', name: "Death on Two Legs", track_number: 2 }),
      ],
      total: 2,
    },
  };
  resetCatalogMarketCache();
  const { registered, calls } = makeHarness(registerCatalogTools, {
    getResponse: (path) => (path === '/albums/alb1' ? albumFull : undefined),
  });

  const out = text(await invoke(findTool(registered, 'get_album'), { id: 'alb1' }));

  assert.deepEqual(calls, [
    { method: 'GET', path: '/me' },
    { method: 'GET', path: '/albums/alb1', params: {} },
  ]);
  assert.match(out, /"A Night at the Opera" by Queen/);
  assert.match(out, /Released: 1975-10-31 \| 2 tracks/);
  assert.match(out, /1\. "Bohemian Rhapsody" by Queen \(5:55\)/);
  assert.match(out, /2\. "Death on Two Legs"/);
});

// ------------------------------------------------------------ get_album_tracks

test('get_album_tracks paginates with default limit/offset', async () => {
  resetCatalogMarketCache();
  const { registered, calls } = makeHarness(registerCatalogTools, {
    getResponse: (path) =>
      path === '/albums/alb1/tracks' ? { items: [trackSimpleFixture()], total: 30 } : undefined,
  });

  const out = text(await invoke(findTool(registered, 'get_album_tracks'), { id: 'alb1' }));

  assert.deepEqual(calls, [
    { method: 'GET', path: '/me' },
    { method: 'GET', path: '/albums/alb1/tracks', params: { limit: '20', offset: '0' } },
  ]);
  assert.match(out, /Tracks for album \(30 total\)/);
});

test('get_album_tracks forwards custom pagination params', async () => {
  resetCatalogMarketCache();
  const { registered, calls } = makeHarness(registerCatalogTools, {
    getResponse: (path) => (path === '/albums/alb1/tracks' ? { items: [], total: 0 } : undefined),
  });

  await invoke(findTool(registered, 'get_album_tracks'), { id: 'alb1', limit: 50, offset: 50 });

  assert.deepEqual(calls.find((c) => c.path === '/albums/alb1/tracks')!.params, {
    limit: '50',
    offset: '50',
  });
});

// ------------------------------------------------------------------- get_show

test('get_show forwards market param and renders show details with recent episodes', async () => {
  const showFull = {
    ...showSimpleFixture(),
    explicit: true,
    languages: ['en'],
    media_type: 'audio',
    episodes: {
      items: [episodeSimpleFixture({ resume_point: { fully_played: true, resume_position_ms: 0 } })],
      total: 12,
    },
  };
  const { registered, calls } = makeHarness(registerCatalogTools, {
    getResponse: (path) => (path === '/shows/shw1' ? showFull : undefined),
  });

  const out = text(await invoke(findTool(registered, 'get_show'), { id: 'shw1', market: 'US' }));

  assert.equal(calls[0].path, '/shows/shw1');
  assert.deepEqual(calls[0].params, { market: 'US' });
  assert.match(out, /"Great Podcast" by Acme Media/);
  assert.match(out, /Episodes: 12 \| Explicit: yes/);
  assert.match(out, /Recent episodes:/);
  assert.match(out, /"Episode One" \(30:00, 2026-01-01\) \[played\]/);
});

test('get_show defaults market to profile country when not provided (#29)', async () => {
  resetCatalogMarketCache();
  const { registered, calls } = makeHarness(registerCatalogTools, {
    getResponse: (path) => {
      if (path === '/me') return { country: 'SE' };
      if (path === '/shows/shw1') return showSimpleFixture();
      return undefined;
    },
  });

  await invoke(findTool(registered, 'get_show'), { id: 'shw1' });

  // Market-gated lookup is defaulted to the account's country from /me.
  const meCall = calls.find((c) => c.path === '/me');
  assert.ok(meCall, 'expected a /me preflight to resolve the account country');
  assert.deepEqual(calls.find((c) => c.path === '/shows/shw1')!.params, { market: 'SE' });
});

// --------------------------------------------------------- get_show_episodes

test('get_show_episodes sends limit, offset, and market params', async () => {
  const { registered, calls } = makeHarness(registerCatalogTools, {
    getResponse: (path) =>
      path === '/shows/shw1/episodes'
        ? { items: [episodeSimpleFixture()], total: 12 }
        : undefined,
  });

  const out = text(await invoke(findTool(registered, 'get_show_episodes'), {
    id: 'shw1',
    limit: 10,
    offset: 20,
    market: 'GB',
  }));

  assert.deepEqual(calls, [
    {
      method: 'GET',
      path: '/shows/shw1/episodes',
      params: { limit: '10', offset: '20', market: 'GB' },
    },
  ]);
  assert.match(out, /Episodes \(12 total\)/);
  assert.match(out, /"Episode One" \(30:00, 2026-01-01\) \| URI: spotify:episode:ep1/);
});

test('get_show_episodes defaults pagination and forwards profile-country market', async () => {
  resetCatalogMarketCache();
  const { registered, calls } = makeHarness(registerCatalogTools, {
    getResponse: (path) => {
      if (path === '/me') return { country: 'FR' };
      if (path === '/shows/shw1/episodes') return { items: [], total: 0 };
      return undefined;
    },
  });

  await invoke(findTool(registered, 'get_show_episodes'), { id: 'shw1' });

  assert.deepEqual(calls.find((c) => c.path === '/shows/shw1/episodes')!.params, {
    limit: '20',
    offset: '0',
    market: 'FR',
  });
});

test('get_show_episodes description documents user-read-playback-position scope', () => {
  const { registered } = makeHarness(registerCatalogTools);
  const tool = findTool(registered, 'get_show_episodes');
  assert.match(tool.description, /user-read-playback-position/);
});

// ---------------------------------------------------------------- get_episode

test('get_episode forwards market param and renders full episode payload', async () => {
  const episodeFull = {
    id: 'ep1',
    name: 'Episode One',
    uri: 'spotify:episode:ep1',
    duration_ms: 1800000,
    release_date: '2026-01-01',
    explicit: true,
    description: 'Deep dive into testing',
    languages: ['en'],
    audio_preview_url: 'https://example.com/preview.mp3',
    resume_point: { fully_played: false, resume_position_ms: 65000 },
    show: { id: 'shw1', name: 'Great Podcast', uri: 'spotify:show:shw1' },
  };
  const { registered, calls } = makeHarness(registerCatalogTools, {
    getResponse: (path) => (path === '/episodes/ep1' ? episodeFull : undefined),
  });

  const out = text(await invoke(findTool(registered, 'get_episode'), { id: 'ep1', market: 'US' }));

  assert.equal(calls[0].path, '/episodes/ep1');
  assert.deepEqual(calls[0].params, { market: 'US' });
  assert.match(out, /"Episode One"/);
  assert.match(out, /Show: Great Podcast/);
  assert.match(out, /Deep dive into testing/);
  assert.match(out, /Duration: 30:00 \| Released: 2026-01-01/);
  assert.match(out, /Explicit: yes \| Languages: en/);
  assert.match(out, /Resume point: Resume at 1:05/); // 65000ms
});

test('get_episode marks fully played resume points', async () => {
  const episodeFull = {
    id: 'ep2',
    name: 'Finale',
    uri: 'spotify:episode:ep2',
    duration_ms: 600000,
    release_date: '2026-02-02',
    explicit: false,
    description: 'd',
    languages: ['en'],
    audio_preview_url: null,
    resume_point: { fully_played: true, resume_position_ms: 600000 },
    show: showSimpleFixture(),
  };
  const { registered } = makeHarness(registerCatalogTools, {
    getResponse: (path) => (path === '/episodes/ep2' ? episodeFull : undefined),
  });

  const out = text(await invoke(findTool(registered, 'get_episode'), { id: 'ep2' }));
  assert.match(out, /Resume point: Fully played/);
  assert.doesNotMatch(out, /Preview:/); // null preview omitted
});

// -------------------------------------------------------------------- get_me

test('get_me renders display_name, country, and product from /me', async () => {
  const profile = {
    id: 'user1',
    display_name: 'Jack',
    uri: 'spotify:user:user1',
    email: 'jack@example.com',
    country: 'GB',
    product: 'premium',
  };
  const { registered, calls } = makeHarness(registerCatalogTools, {
    getResponse: (path) => (path === '/me' ? profile : undefined),
  });

  const out = text(await invoke(findTool(registered, 'get_me')));

  assert.deepEqual(calls, [{ method: 'GET', path: '/me' }]);
  assert.match(out, /Display name: Jack/);
  assert.match(out, /User ID: user1/);
  assert.match(out, /Email: jack@example\.com/);
  assert.match(out, /Country: GB/);
  assert.match(out, /Product: premium/);
  assert.match(out, /URI: spotify:user:user1/);
});

test('get_me handles missing display_name and omitted optional fields', async () => {
  const profile = { id: 'user2', display_name: null, uri: 'spotify:user:user2' };
  const { registered } = makeHarness(registerCatalogTools, {
    getResponse: (path) => (path === '/me' ? profile : undefined),
  });

  const out = text(await invoke(findTool(registered, 'get_me')));
  assert.match(out, /Display name: not set/);
  assert.doesNotMatch(out, /Email:/);
  assert.doesNotMatch(out, /Country:/);
  assert.doesNotMatch(out, /Product:/);
});

// -------------------------------------------------------- get_artist_top_tracks

test('get_artist_top_tracks fetches /artists/{id}/top-tracks with explicit market', async () => {
  const { registered, calls } = makeHarness(registerCatalogTools, {
    getResponse: (path) =>
      path === '/artists/art1/top-tracks'
        ? { tracks: [trackFixture(), trackFixture({ id: 'trk2', name: 'Killer Queen', duration_ms: 180000, uri: 'spotify:track:trk2' })] }
        : undefined,
  });

  const out = text(await invoke(findTool(registered, 'get_artist_top_tracks'), { id: 'art1', market: 'US' }));
  assert.deepEqual(calls, [
    { method: 'GET', path: '/artists/art1/top-tracks', params: { market: 'US' } },
  ]);
  assert.match(out, /Top tracks \(2\):/);
  assert.match(out, /1\. "Bohemian Rhapsody" by Queen \(5:55\)/);
  assert.match(out, /2\. "Killer Queen" by Queen \(3:00\)/);
});

test('get_artist_top_tracks defaults market to profile country', async () => {
  resetCatalogMarketCache();
  const { registered, calls } = makeHarness(registerCatalogTools, {
    getResponse: (path) => {
      if (path === '/me') return { country: 'GB' };
      if (path === '/artists/art1/top-tracks') return { tracks: [] };
      return undefined;
    },
  });

  await invoke(findTool(registered, 'get_artist_top_tracks'), { id: 'art1' });

  assert.deepEqual(calls.find((c) => c.path === '/artists/art1/top-tracks')!.params, { market: 'GB' });
});

test('get_artist_top_tracks handles a 403 gracefully with the Spotify message (#38)', async () => {
  const { registered, calls } = makeHarness(registerCatalogTools, {
    getError: (path) =>
      path === '/artists/art1/top-tracks' ? new SpotifyApiError(403, 'Deprecated endpoint') : undefined,
  });

  await assert.rejects(
    invoke(findTool(registered, 'get_artist_top_tracks'), { id: 'art1', market: 'US' }),
    (err: Error) => {
      assert.match(err.message, /403/);
      assert.match(err.message, /Deprecated endpoint/);
      return true;
    },
  );
  assert.equal(calls[0].path, '/artists/art1/top-tracks');
});

test('get_artist_top_tracks passes non-403 API errors through unchanged', async () => {
  const { registered } = makeHarness(registerCatalogTools, {
    getError: (path) =>
      path === '/artists/art1/top-tracks' ? new SpotifyApiError(500, 'Boom') : undefined,
  });

  await assert.rejects(
    invoke(findTool(registered, 'get_artist_top_tracks'), { id: 'art1', market: 'US' }),
    (err: unknown) => err instanceof SpotifyApiError && err.status === 500 && err.message === 'Boom',
  );
});

// --------------------------------------------------------- get_available_markets

test('get_available_markets fetches /markets and renders name/code entries (#49)', async () => {
  const { registered, calls } = makeHarness(registerCatalogTools, {
    getResponse: (path) =>
      path === '/markets'
        ? { markets: [{ name: 'United Kingdom', codes: ['GB'] }, { name: 'Japan', codes: ['JP'] }] }
        : undefined,
  });

  const out = text(await invoke(findTool(registered, 'get_available_markets')));

  assert.deepEqual(calls, [{ method: 'GET', path: '/markets' }]);
  assert.match(out, /Available markets \(2\):/);
  assert.match(out, /United Kingdom \(GB\)/);
  assert.match(out, /Japan \(JP\)/);
});

test('get_available_markets tolerates plain string code entries', async () => {
  const { registered } = makeHarness(registerCatalogTools, {
    getResponse: (path) => (path === '/markets' ? { markets: ['GB', 'US'] } : undefined),
  });

  const out = text(await invoke(findTool(registered, 'get_available_markets')));

  assert.match(out, /Available markets \(2\):/);
  assert.match(out, /• GB/);
  assert.match(out, /• US/);
});

// ------------------------------------------------------------------ several_*

function severalIds(count: number): string[] {
  return Array.from({ length: count }, (_, i) => `id${i}`);
}

const severalTrack = (id: string) => trackFixture({ id, uri: `spotify:track:${id}` });

test('get_several_tracks issues one joined request under the cap', async () => {
  const { registered, calls } = makeHarness(registerCatalogTools, {
    getResponse: (path, params) => {
      if (path !== '/tracks') return undefined;
      return { tracks: params!.ids.split(',').map(severalTrack) };
    },
  });

  const out = text(await invoke(findTool(registered, 'get_several_tracks'), { ids: ['trk1', 'trk2'] }));

  assert.deepEqual(calls, [
    { method: 'GET', path: '/tracks', params: { ids: 'trk1,trk2' } },
  ]);
  assert.match(out, /Tracks \(2\):/);
  assert.match(out, /"Bohemian Rhapsody".*5:55.*URI: spotify:track:trk1/);
  assert.match(out, /URI: spotify:track:trk2/);
});

test('get_several_tracks chunks beyond 50 into queued calls and merges in order', async () => {
  const { registered, calls } = makeHarness(registerCatalogTools, {
    getResponse: (path, params) => {
      if (path !== '/tracks') return undefined;
      const chunkIds = params!.ids.split(',');
      // Second chunk: last ID unresolvable — must be dropped from the merge.
      const resolved = chunkIds.length === 10 ? chunkIds.slice(0, 9) : chunkIds;
      return { tracks: resolved.map(severalTrack) };
    },
  });

  // #53: explicit max_results override lifts the default cap so the merged
  // order across both chunked requests stays fully observable.
  const out = text(
    await invoke(findTool(registered, 'get_several_tracks'), {
      ids: severalIds(60),
      max_results: 59,
    }),
  );

  assert.equal(calls.length, 2);
  assert.equal(calls[0].params!.ids.split(',').length, 50);
  assert.equal(calls[1].params!.ids.split(',').length, 10);
  assert.match(out, /Tracks \(59\):/); // 60 requested − 1 unresolvable
  assert.match(out, /URI: spotify:track:id0/);
  assert.match(out, /URI: spotify:track:id49/);
  assert.match(out, /URI: spotify:track:id58/);
});

test('get_several_tracks truncates merged results to the #53 default cap', async () => {
  const { registered } = makeHarness(registerCatalogTools, {
    getResponse: (path, params) =>
      path === '/tracks' ? { tracks: params!.ids.split(',').map(severalTrack) } : undefined,
  });

  const result = await invoke(findTool(registered, 'get_several_tracks'), { ids: severalIds(60) });

  assert.match(text(result), /Tracks \(60\):/);
  assert.match(text(result), /\(10 more — pass offset or fetch_all\)/);
  assert.ok(!text(result).includes('spotify:track:id59'));
  assert.deepEqual(result.structuredContent.pagination, {
    total: 60,
    offset: 0,
    limit: null,
    next_offset: null,
  });
  assert.equal(result.structuredContent.items.length, 50);
});

test('get_several_albums chunks at 20 per request (#43 cap)', async () => {
  const { registered, calls } = makeHarness(registerCatalogTools, {
    getResponse: (path, params) => {
      if (path !== '/albums') return undefined;
      return {
        albums: params!.ids.split(',').map((id) => ({
          id,
          name: `Album ${id}`,
          uri: `spotify:album:${id}`,
          album_type: 'album',
          release_date: '2026-01-01',
          total_tracks: 3,
          artists: [artist],
        })),
      };
    },
  });

  const out = text(await invoke(findTool(registered, 'get_several_albums'), { ids: severalIds(25) }));

  assert.equal(calls.length, 2);
  assert.equal(calls[0].params!.ids.split(',').length, 20);
  assert.equal(calls[1].params!.ids.split(',').length, 5);
  assert.match(out, /Albums \(25\):/);
  assert.match(out, /"Album id24" by Queen \(album, 2026-01-01, 3 tracks\)/);
});

test('remaining get_several_* tools hit their plural endpoints with joined ids', async () => {
  const anyItem = {
    name: 'Item',
    uri: '',
    genres: [] as string[],
    duration_ms: 60000,
    release_date: '2026-01-01',
    publisher: 'Pub',
    authors: [{ name: 'Author' }],
    total_chapters: 5,
    chapter_number: 1,
  };
  const cases = [
    { tool: 'get_several_artists', path: '/artists', key: 'artists', singular: 'artist' },
    { tool: 'get_several_episodes', path: '/episodes', key: 'episodes', singular: 'episode' },
    { tool: 'get_several_shows', path: '/shows', key: 'shows', singular: 'show' },
    { tool: 'get_several_audiobooks', path: '/audiobooks', key: 'audiobooks', singular: 'audiobook' },
    { tool: 'get_several_chapters', path: '/chapters', key: 'chapters', singular: 'chapter' },
  ];

  for (const c of cases) {
    const { registered, calls } = makeHarness(registerCatalogTools, {
      getResponse: (path, params) => {
        if (path !== c.path) return undefined;
        return {
          [c.key]: params!.ids.split(',').map(() => ({ ...anyItem, uri: `spotify:${c.singular}:x` })),
        };
      },
    });

    const out = text(await invoke(findTool(registered, c.tool), { ids: ['a', 'b'] }));

    assert.deepEqual(calls, [{ method: 'GET', path: c.path, params: { ids: 'a,b' } }]);
    assert.match(out, /\(2\):/);
    assert.match(out, /Item/);
  }
});

test('get_several_* schemas reject empty lists and non-string ids', () => {
  const { registered } = makeHarness(registerCatalogTools);
  for (const name of [
    'get_several_tracks',
    'get_several_albums',
    'get_several_artists',
    'get_several_episodes',
    'get_several_shows',
    'get_several_audiobooks',
    'get_several_chapters',
  ]) {
    const schema = findTool(registered, name).schema.ids;
    assert.equal(schema.safeParse([]).success, false, `${name} should reject an empty list`);
    assert.equal(schema.safeParse(['ok']).success, true, `${name} should accept a single id`);
    assert.equal(schema.safeParse([42]).success, false, `${name} should reject non-string ids`);
  }
});

// --------------------------------------------- #47 parameter completeness

test('get_artist_albums forwards explicit market and offset without preflight (#47)', async () => {
  const { registered, calls } = makeHarness(registerCatalogTools, {
    getResponse: (path) => (path === '/artists/art1/albums' ? { items: [], total: 0 } : undefined),
  });

  await invoke(findTool(registered, 'get_artist_albums'), { id: 'art1', market: 'US', offset: 100 });

  assert.deepEqual(calls, [
    {
      method: 'GET',
      path: '/artists/art1/albums',
      params: { include_groups: 'album,single', limit: '10', offset: '100', market: 'US' },
    },
  ]);
});

test('get_album forwards market without profile preflight (#47)', async () => {
  const { registered, calls } = makeHarness(registerCatalogTools, {
    getResponse: (path) => (path === '/albums/alb1' ? albumFullFixture() : undefined),
  });

  await invoke(findTool(registered, 'get_album'), { id: 'alb1', market: 'DE' });

  assert.deepEqual(calls, [
    { method: 'GET', path: '/albums/alb1', params: { market: 'DE' } },
  ]);
});

test('get_album_tracks forwards market alongside pagination (#47)', async () => {
  const { registered, calls } = makeHarness(registerCatalogTools, {
    getResponse: (path) => (path === '/albums/alb1/tracks' ? { items: [], total: 0 } : undefined),
  });

  await invoke(findTool(registered, 'get_album_tracks'), { id: 'alb1', market: 'AU', limit: 10, offset: 5 });

  assert.deepEqual(
    calls.find((c) => c.path === '/albums/alb1/tracks')!.params,
    { limit: '10', offset: '5', market: 'AU' },
  );
});

// --------------------------------------------- removed tools stay absent

test('catalog registration list contains NO removed audio-feature tools', () => {
  const { registered } = makeHarness(registerCatalogTools);
  const names = registered.map((t) => t.name);

  assert.equal(names.includes('get_audio_features'), false);
  assert.equal(names.includes('get_audio_analysis'), false);
  assert.equal(names.some((n) => n.toLowerCase().includes('audio_feature')), false);
  assert.equal(names.some((n) => n.toLowerCase().includes('audio_analysis')), false);
  // sanity: expected tools are present
  for (const expected of [
    'get_track',
    'get_artist',
    'get_artist_albums',
    'get_album',
    'get_album_tracks',
    'get_show',
    'get_show_episodes',
    'get_episode',
    'get_me',
  ]) {
    assert.ok(names.includes(expected), `expected ${expected} to be registered`);
  }
});

// ---------------------------------------------------------------- audiobooks

const MARKET_NOTE_FRAGMENT =
  'only available in the US, UK, Canada, Ireland, New Zealand and Australia markets';

test('all four audiobook tools are registered with market gating notes in descriptions', () => {
  const { registered } = makeHarness(registerAudiobookTools);
  const names = registered.map((t) => t.name);

  for (const expected of ['get_audiobook', 'get_audiobook_chapters', 'get_chapter', 'get_saved_audiobooks']) {
    assert.ok(names.includes(expected), `expected ${expected} to be registered`);
  }

  const gated = ['get_audiobook', 'get_audiobook_chapters', 'get_chapter'];
  for (const name of gated) {
    assert.match(
      findTool(registered, name).description,
      new RegExp(MARKET_NOTE_FRAGMENT),
      `${name} description should carry the market gating note`,
    );
  }
  assert.match(
    findTool(registered, 'get_saved_audiobooks').description,
    /user-library-read/,
  );
});

test('get_audiobook hits /audiobooks/{id} with optional market param', async () => {
  const audiobook = {
    id: 'ab1',
    name: 'Project Hail Mary',
    uri: 'spotify:audiobook:ab1',
    authors: [{ name: 'Andy Weir' }],
    narrators: [{ name: 'Ray Porter' }],
    publisher: 'Audible Studios',
    edition: 'Unabridged',
    total_chapters: 32,
    explicit: false,
    languages: ['en'],
    description: 'A lone astronaut must save the earth.',
    chapters: {
      items: [
        {
          id: 'ch1',
          name: 'Chapter 1',
          uri: 'spotify:chapter:ch1',
          chapter_number: 1,
          duration_ms: 1500000,
        },
      ],
    },
  };
  const { registered, calls } = makeHarness(registerAudiobookTools, {
    getResponse: (path) => (path === '/audiobooks/ab1' ? audiobook : undefined),
  });

  const out = text(await invoke(findTool(registered, 'get_audiobook'), { id: 'ab1', market: 'US' }));

  assert.equal(calls[0].path, '/audiobooks/ab1');
  assert.deepEqual(calls[0].params, { market: 'US' });
  assert.match(out, /"Project Hail Mary" by Andy Weir, narrated by Ray Porter/);
  assert.match(out, /Audible Studios \(Unabridged\) \| 32 chapters/);
  assert.match(out, /Chapters:/);
  assert.match(out, /1\. "Chapter 1" \(25:00\)/);
});

test('get_audiobook_chapters paginates /audiobooks/{id}/chapters', async () => {
  const { registered, calls } = makeHarness(registerAudiobookTools, {
    getResponse: (path) =>
      path === '/audiobooks/ab1/chapters'
        ? {
            items: [
              {
                id: 'ch1',
                name: 'Chapter 1',
                uri: 'spotify:chapter:ch1',
                chapter_number: 1,
                duration_ms: 1500000,
                release_date: '2021-05-04',
                explicit: false,
                description: '',
                is_playable: false,
              },
            ],
            total: 32,
          }
        : undefined,
  });

  const out = text(await invoke(findTool(registered, 'get_audiobook_chapters'), {
    id: 'ab1',
    limit: 5,
    offset: 10,
    market: 'GB',
  }));

  assert.deepEqual(calls, [
    {
      method: 'GET',
      path: '/audiobooks/ab1/chapters',
      params: { limit: '5', offset: '10', market: 'GB' },
    },
  ]);
  assert.match(out, /Chapters for audiobook \(32 total\)/);
  assert.match(out, /\[not playable\]/);
});

test('get_audiobook_chapters defaults pagination and forwards profile-country market', async () => {
  resetAudiobooksMarketCache();
  const { registered, calls } = makeHarness(registerAudiobookTools, {
    getResponse: (path) => {
      if (path === '/me') return { country: 'AU' };
      if (path === '/audiobooks/ab1/chapters') return { items: [], total: 0 };
      return undefined;
    },
  });

  await invoke(findTool(registered, 'get_audiobook_chapters'), { id: 'ab1' });

  assert.deepEqual(calls.find((c) => c.path === '/audiobooks/ab1/chapters')!.params, {
    limit: '20',
    offset: '0',
    market: 'AU',
  });
});

test('get_chapter fetches /chapters/{id} and renders chapter details', async () => {
  const chapter = {
    id: 'ch3',
    name: 'The Tunnel',
    uri: 'spotify:chapter:ch3',
    chapter_number: 3,
    duration_ms: 2100000,
    release_date: '2021-05-04',
    explicit: false,
    description: 'Grace digs in.',
    is_playable: true,
    html_description: '<p>Grace digs in.</p>',
    languages: ['en'],
    images: [],
    audio_preview_url: null,
    resume_point: { fully_played: false, resume_position_ms: 120000 },
  };
  const { registered, calls } = makeHarness(registerAudiobookTools, {
    getResponse: (path) => (path === '/chapters/ch3' ? chapter : undefined),
  });

  const out = text(await invoke(findTool(registered, 'get_chapter'), { id: 'ch3', market: 'AU' }));

  assert.equal(calls[0].path, '/chapters/ch3');
  assert.deepEqual(calls[0].params, { market: 'AU' });
  assert.match(out, /Chapter 3: "The Tunnel"/);
  assert.match(out, /Playable in given market: yes/);
  assert.match(out, /Resume point: Resume at 2:00/);
});

test('get_saved_audiobooks lists /me/audiobooks with default pagination', async () => {
  const { registered, calls } = makeHarness(registerAudiobookTools, {
    getResponse: (path) =>
      path === '/me/audiobooks'
        ? {
            items: [
              {
                added_at: '2026-03-01T00:00:00Z',
                audiobook: {
                  id: 'ab1',
                  name: 'Project Hail Mary',
                  uri: 'spotify:audiobook:ab1',
                  authors: [{ name: 'Andy Weir' }],
                  total_chapters: 32,
                },
              },
            ],
            total: 1,
          }
        : undefined,
  });

  const out = text(await invoke(findTool(registered, 'get_saved_audiobooks')));

  assert.deepEqual(calls, [{ method: 'GET', path: '/me/audiobooks', params: { limit: '20', offset: '0' } }]);
  assert.match(out, /Saved audiobooks \(1 total\)/);
  assert.match(out, /"Project Hail Mary" by Andy Weir \(32 chapters, saved 2026-03-01T00:00:00Z\)/);
});

// --------------------------------------- #51/#52/#53 shared response shaping

test('get_track json mode returns parseable JSON of the raw API object (#51)', async () => {
  const rawTrack = trackFixture({ popularity: 87, album: { ...albumSimple, release_date: '1975-10-31' } });
  const { registered } = makeHarness(registerCatalogTools, {
    getResponse: (path) => (path === '/tracks/trk1' ? rawTrack : undefined),
  });

  const result = await invoke(findTool(registered, 'get_track'), { id: 'trk1', response_format: 'json' });

  const parsed = JSON.parse(result.content[0].text);
  assert.equal(parsed.name, 'Bohemian Rhapsody');
  assert.equal(parsed.popularity, 87);
  assert.equal(parsed.album.release_date, '1975-10-31');
  // structuredContent mirrors the same payload for programmatic consumers.
  assert.equal((result.structuredContent as Record<string, unknown>).name, 'Bohemian Rhapsody');
});

test('get_track detailed mode appends fields the concise prose drops (#51)', async () => {
  const rawTrack = trackFixture({ popularity: 87, album: { ...albumSimple, release_date: '1975-10-31' } });
  const { registered } = makeHarness(registerCatalogTools, {
    getResponse: (path) => (path === '/tracks/trk1' ? rawTrack : undefined),
  });

  const out = text(
    await invoke(findTool(registered, 'get_track'), { id: 'trk1', response_format: 'detailed' }),
  );

  assert.match(out, /More details:/);
  assert.match(out, /Released: 1975-10-31/);
  assert.match(out, /Popularity: 87/);
});

test('default (concise) get_track output is byte-for-byte unchanged (#51)', async () => {
  const { registered } = makeHarness(registerCatalogTools, {
    getResponse: (path) => (path === '/tracks/trk1' ? trackFixture({ popularity: 87 }) : undefined),
  });

  const out = text(await invoke(findTool(registered, 'get_track'), { id: 'trk1' }));

  assert.equal(
    out,
    [
      '"Bohemian Rhapsody" by Queen',
      'Album: A Night at the Opera',
      'Duration: 5:55',
      'Explicit: no',
      'URI: spotify:track:trk1',
    ].join('\n'),
  );
  assert.ok(!out.includes('Popularity'));
});

test('get_artist_albums truncates to max_results with the shared footer math (#53)', async () => {
  const albums = Array.from({ length: 5 }, (_, i) => ({
    id: `alb${i}`,
    name: `Album ${i}`,
    uri: `spotify:album:alb${i}`,
    album_type: 'album',
    release_date: '2026-01-01',
    total_tracks: 3,
    artists: [artist],
  }));
  const { registered, calls } = makeHarness(registerCatalogTools, {
    getResponse: (path, params) =>
      path === '/artists/art1/albums'
        ? { items: albums, total: 12, limit: params?.limit, offset: params?.offset }
        : undefined,
  });

  const result = await invoke(findTool(registered, 'get_artist_albums'), {
    id: 'art1',
    max_results: 2,
  });
  const out = text(result);

  // Footer math: 5 fetched − 2 shown = 3 more.
  assert.match(out, /Albums for artist \(12 total\):/);
  assert.equal(out.match(/• "Album \d+"/g)?.length, 2);
  assert.match(out, /\(3 more — pass offset or fetch_all\)/);
  // structuredContent carries the truncated page plus server-side pagination (#52).
  assert.deepEqual(result.structuredContent!.pagination, {
    total: 12,
    offset: 0,
    limit: 10,
    next_offset: 2,
  });
  assert.equal(result.structuredContent!.items.length, 2);
  // No extra API calls were made — truncation is local shaping only.
  assert.equal(calls.length, 1);
});

test('get_artist_albums json mode returns the raw paged response as JSON (#51)', async () => {
  const paged = { items: [{ id: 'alb0', name: 'Album 0', uri: 'spotify:album:alb0' }], total: 9 };
  const { registered, calls } = makeHarness(registerCatalogTools, {
    getResponse: (path) => (path === '/artists/art1/albums' ? paged : undefined),
  });

  const result = await invoke(findTool(registered, 'get_artist_albums'), {
    id: 'art1',
    response_format: 'json',
  });

  const parsed = JSON.parse(result.content[0].text);
  assert.equal(parsed.total, 9);
  assert.equal(parsed.items[0].id, 'alb0');
  assert.deepEqual(result.structuredContent, parsed);
  assert.ok(!text(result).includes('•')); // no prose rendering in json mode
});

test('list tools advertise the shared shaping params in their schemas (#51/#53)', () => {
  const { registered } = makeHarness(registerCatalogTools, {});

  for (const name of ['get_track', 'get_me']) {
    const schema = findTool(registered, name).schema;
    assert.ok(schema.response_format, `${name} must accept response_format`);
    assert.ok(schema.response_format.safeParse('json').success);
    assert.ok(schema.response_format.safeParse('verbose').success === false);
  }
  const listSchema = findTool(registered, 'get_artist_albums').schema;
  assert.ok(listSchema.max_results.safeParse(25).success);
  assert.ok(listSchema.max_results.safeParse(0).success === false);
});

test('get_saved_audiobooks emits structuredContent with pagination (#52)', async () => {
  const savedBook = {
    added_at: '2026-03-01T00:00:00Z',
    audiobook: {
      id: 'ab1',
      name: 'Project Hail Mary',
      uri: 'spotify:audiobook:ab1',
      authors: [{ name: 'Andy Weir' }],
      total_chapters: 32,
    },
  };
  const { registered } = makeHarness(registerAudiobookTools, {
    getResponse: (path) =>
      path === '/me/audiobooks'
        ? { items: [savedBook], total: 21, limit: '20', offset: '0' }
        : undefined,
  });

  const result = await invoke(findTool(registered, 'get_saved_audiobooks'));

  assert.deepEqual(result.structuredContent!.pagination, {
    total: 21,
    offset: 0,
    limit: 20,
    next_offset: 1,
  });
  assert.equal(result.structuredContent!.items.length, 1);
  assert.match(text(result), /More pages available — pass offset=1 \(20 items left\)/);
});

test('get_audiobook_chapters json mode returns the raw chapter page (#51)', async () => {
  const chapters = {
    items: [
      {
        id: 'ch1',
        name: 'Chapter One',
        uri: 'spotify:chapter:ch1',
        chapter_number: 1,
        duration_ms: 60000,
        release_date: '2026-01-01',
        is_playable: true,
      },
    ],
    total: 1,
  };
  const { registered } = makeHarness(registerAudiobookTools, {
    getResponse: (path) => (path === '/audiobooks/ab1/chapters' ? chapters : undefined),
  });

  const result = await invoke(findTool(registered, 'get_audiobook_chapters'), {
    id: 'ab1',
    response_format: 'json',
  });

  const parsed = JSON.parse(result.content[0].text);
  assert.equal(parsed.items[0].chapter_number, 1);
  assert.equal(parsed.total, 1);
});

test('get_several_tracks explains the Feb 2026 removal on 403 instead of a raw error (issue #85)', async () => {
  const { registered } = makeHarness(registerCatalogTools, {
    getError: (path) => (path.startsWith('/tracks?') || path === '/tracks' ? new SpotifyApiError(403, 'Forbidden') : undefined),
  });

  await assert.rejects(
    invoke(findTool(registered, 'get_several_tracks'), { ids: ['trk1', 'trk2'] }),
    (err: Error) => {
      assert.match(err.message, /403/);
      assert.match(err.message, /February 2026/);
      assert.match(err.message, /grandfathered/);
      return true;
    },
  );
});
