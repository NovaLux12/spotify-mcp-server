import test, { afterEach, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { registerCatalogTools, resetProfileCountryCache as resetCatalogMarketCache } from '../src/tools/catalog.js';
import { SpotifyApiError } from '../src/client.js';
import { registerAudiobookTools, resetProfileCountryCache as resetAudiobooksMarketCache } from '../src/tools/audiobooks.js';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';

// The typed-search factory records every executed search to the local
// sidecar (#766). Point it at a temp file so the suite never writes to the
// developer's real ~/.spotify-mcp/search-history.json.
let historyDir: string;
let historyFile: string;
beforeEach(async () => {
  historyDir = await mkdtemp(join(tmpdir(), 'cat-sh-'));
  historyFile = join(historyDir, 'search-history.json');
  process.env.SPOTIFY_MCP_SEARCH_HISTORY_FILE = historyFile;
  delete process.env.SPOTIFY_MCP_SEARCH_HISTORY;
});
afterEach(async () => {
  delete process.env.SPOTIFY_MCP_SEARCH_HISTORY_FILE;
  delete process.env.SPOTIFY_MCP_SEARCH_HISTORY;
  await rm(historyDir, { recursive: true, force: true });
});

const HISTORY_ENTRY = z.object({
  query: z.string(),
  types: z.array(z.string()).optional(),
  top_result_ids: z.array(z.string()),
  limit: z.number().optional(),
  market: z.string().optional(),
  offset: z.number().optional(),
});

async function readHistory() {
  return z.array(HISTORY_ENTRY).parse(JSON.parse(await readFile(historyFile, 'utf8')));
}

// ---------------------------------------------------------------- fixtures

type ToolContent = {
  content: Array<{ type: string; text: string }>;
  structuredContent?: Record<string, unknown>;
};

type RegisteredTool = {
  name: string;
  description: string;
  schema: Record<string, { safeParse(value: unknown): { success: boolean; data?: unknown } }>;
  handler: (args: Record<string, unknown>) => Promise<ToolContent>;
};

type Call = { method: string; path: string; params?: Record<string, string> };

interface ClientOptions {
  getResponse?: (path: string, params?: Record<string, string>) => unknown;
  getError?: (path: string, params?: Record<string, string>) => unknown;
}

// A real 22-character Spotify id. The shared resolver grammar (#789) is strict
// by design, so every catalog reference fixture must be a real id rather than
// a convenient placeholder.
const REF_ID = '4uLU6hMCjMI75M1A2tKUQC';

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

/**
 * Run args through the tool's zod schema the way the MCP SDK does before the
 * handler is called. Reference normalisation (URI/URL → bare id) happens in
 * the schema, so a handler-level call would bypass it entirely.
 */
function parseArgs(tool: RegisteredTool, args: Record<string, unknown>): Record<string, unknown> {
  const parsed: Record<string, unknown> = {};
  for (const [name, value] of Object.entries(args)) {
    const field = tool.schema[name];
    assert.ok(field, `missing schema field ${name}`);
    const result = field.safeParse(value);
    assert.equal(result.success, true, `invalid ${name}: ${JSON.stringify(value)}`);
    parsed[name] = result.data;
  }
  return parsed;
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

test('get_artist_albums forwards custom groups with the canonical page limit', async () => {
  resetCatalogMarketCache();
  const { registered, calls } = makeHarness(registerCatalogTools, {
    getResponse: (path) =>
      path === '/artists/art1/albums' ? { items: [], total: 0 } : undefined,
  });

  await invoke(findTool(registered, 'get_artist_albums'), {
    id: 'art1',
    include_groups: ['appears_on', 'compilation'],
    limit: 10,
  });

  assert.deepEqual(calls.find((c) => c.path === '/artists/art1/albums')!.params, {
    include_groups: 'appears_on,compilation',
    limit: '10',
    offset: '0',
  });
});

test('get_artist_albums schema rejects limits above the canonical page cap', () => {
  const { registered } = makeHarness(registerCatalogTools);
  const schema = findTool(registered, 'get_artist_albums').schema;
  assert.equal(schema.limit.safeParse(11).success, false);
  assert.equal(schema.limit.safeParse(10).success, true);
});

test('get_artist_albums fetch_all pages at 10 and omits an absent market', async () => {
  resetCatalogMarketCache();
  const calls: Call[] = [];
  const client = {
    get: async (path: string, params?: Record<string, string>) => {
      calls.push({ method: 'GET', path, ...(params === undefined ? {} : { params }) });
      return null;
    },
    getAllPages: async (path: string, params?: Record<string, string>) => {
      calls.push({ method: 'GET', path, params });
      assert.equal(params?.limit, '10');
      assert.equal(params?.market, undefined);
      return [];
    },
    post: async () => null,
    put: async () => undefined,
    delete: async () => undefined,
  };
  const registered: RegisteredTool[] = [];
  const server = {
    tool: (name: string, description: string, schema: RegisteredTool['schema'], handler: RegisteredTool['handler']) => registered.push({ name, description, schema, handler }),
  };
  registerCatalogTools(server as never, client as never);
  await invoke(findTool(registered, 'get_artist_albums'), { id: 'art1', fetch_all: true });
  assert.deepEqual(calls, [{ method: 'GET', path: '/artists/art1/albums', params: { include_groups: 'album,single', limit: '10' } }]);
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
    // #789: the six entity kinds now share the strict resolver grammar, so a
    // valid fixture is a real 22-character id. get_several_chapters has no
    // resolver kind and keeps accepting short strings.
    assert.equal(schema.safeParse([REF_ID]).success, true, `${name} should accept a single id`);
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

// ---------------------------- exhaust catalog gap-fill: 15 new tools

test('get_category fetches /browse/categories/{id} and renders', async () => {
  const cat = { id: 'mood', name: 'Mood', href: 'https://api.spotify.com/v1/browse/categories/mood', icons: [{ url: 'https://example.com/icon.png', height: null, width: null }] };
  const { registered, calls } = makeHarness(registerCatalogTools, { getResponse: (p) => (p === '/browse/categories/mood' ? cat : undefined) });
  const out = text(await invoke(findTool(registered, 'get_category'), { category_id: 'mood' }));
  assert.equal(calls[0].path, '/browse/categories/mood');
  assert.match(out, /Category: Mood/);
  assert.match(out, /mood/);
});

test('get_category forwards country and locale', async () => {
  const cat = { id: 'mood', name: 'Mood', href: 'h', icons: [] };
  const { registered, calls } = makeHarness(registerCatalogTools, { getResponse: (p) => (p === '/browse/categories/mood' ? cat : undefined) });
  await invoke(findTool(registered, 'get_category'), { category_id: 'mood', country: 'US', locale: 'en_US' });
  assert.deepEqual(calls[0].params, { country: 'US', locale: 'en_US' });
});

test('search_tracks locks type=track and renders', async () => {
  const { registered, calls } = makeHarness(registerCatalogTools, { getResponse: (p, params) => { if (p === '/search') { assert.equal(params.type, 'track'); return { tracks: { items: [{ id: 't1', name: 'Song', uri: 'spotify:track:t1', artists: [{ name: 'A' }], album: { name: 'Alb' }, duration_ms: 200000 }], total: 1 } }; } return undefined; } });
  const out = text(await invoke(findTool(registered, 'search_tracks'), { query: 'hello' }));
  assert.match(out, /Search tracks for "hello"/);
  assert.match(out, /Song/);
  assert.equal(calls[0].params.q, 'hello');
});

test('search_artists / search_albums / search_playlists / search_shows / search_episodes / search_audiobooks registered and type-locked', async () => {
  const kinds: Array<{ tool: string; type: string; key: string }> = [
    { tool: 'search_artists', type: 'artist', key: 'artists' },
    { tool: 'search_albums', type: 'album', key: 'albums' },
    { tool: 'search_playlists', type: 'playlist', key: 'playlists' },
    { tool: 'search_shows', type: 'show', key: 'shows' },
    { tool: 'search_episodes', type: 'episode', key: 'episodes' },
    { tool: 'search_audiobooks', type: 'audiobook', key: 'audiobooks' },
  ];
  for (const k of kinds) {
    const { registered, calls } = makeHarness(registerCatalogTools, { getResponse: (p, params) => { if (p === '/search') { assert.equal(params.type, k.type); return { [k.key]: { items: [{ id: 'x1', name: 'Found', uri: `spotify:${k.type}:x1`, artists: [{ name: 'A' }], owner: { display_name: 'Owner', id: 'o1' }, publisher: 'Pub', show: { name: 'Show' }, authors: [{ name: 'Author' }], duration_ms: 1000 }], total: 1 } }; } return undefined; } });
    const out = text(await invoke(findTool(registered, k.tool), { query: 'q' }));
    assert.match(out, /Found/);
    assert.equal(calls[0].params.type, k.type);
  }
});

test('search_tracks json mode returns raw', async () => {
  const raw = { tracks: { items: [{ id: 't1', name: 'Song', uri: 'spotify:track:t1' }], total: 1 } };
  const { registered } = makeHarness(registerCatalogTools, { getResponse: (p) => (p === '/search' ? raw : undefined) });
  const res = await invoke(findTool(registered, 'search_tracks'), { query: 'hi', response_format: 'json' });
  const parsed = JSON.parse(res.content[0].text);
  assert.equal(parsed.tracks.total, 1);
});

test('search_tracks handles no results', async () => {
  const { registered } = makeHarness(registerCatalogTools, { getResponse: (p) => (p === '/search' ? { tracks: { items: [], total: 0 } } : undefined) });
  const out = text(await invoke(findTool(registered, 'search_tracks'), { query: 'zzz' }));
  assert.match(out, /No results/);
});

test('catalog_batch_lookup partitions mixed URIs', async () => {
  const { registered, calls } = makeHarness(registerCatalogTools, { getResponse: (p, params) => { if (p === '/tracks') return { tracks: params.ids.split(',').map((id) => ({ id, name: `Track ${id}`, uri: `spotify:track:${id}` })) }; if (p === '/artists') return { artists: params.ids.split(',').map((id) => ({ id, name: `Artist ${id}`, uri: `spotify:artist:${id}` })) }; return undefined; } });
  const out = text(await invoke(findTool(registered, 'catalog_batch_lookup'), { uris: ['spotify:track:t1', 'spotify:artist:a1'] }));
  assert.match(out, /Batch lookup/);
  assert.match(out, /Track t1/);
  assert.match(out, /Artist a1/);
  assert.equal(calls.length, 2);
});

test('catalog_batch_lookup reports invalid URIs', async () => {
  const { registered } = makeHarness(registerCatalogTools, { getResponse: (p) => (p === '/tracks' ? { tracks: [{ id: 't1', name: 'Track t1', uri: 'spotify:track:t1' }] } : undefined) });
  const out = text(await invoke(findTool(registered, 'catalog_batch_lookup'), { uris: ['spotify:track:t1', 'not-a-uri'] }));
  assert.match(out, /invalid/i);
});

test('get_artist_singles calls include_groups=single', async () => {
  const { registered, calls } = makeHarness(registerCatalogTools, { getResponse: (p) => (p === '/artists/art1/albums' ? { items: [{ id: 's1', name: 'Single 1', uri: 'spotify:album:s1', album_type: 'single', release_date: '2026-01-01', total_tracks: 1 }], total: 1 } : undefined) });
  const out = text(await invoke(findTool(registered, 'get_artist_singles'), { artist_id: 'art1' }));
  assert.match(out, /Singles for artist/);
  assert.match(out, /Single 1/);
  assert.equal(calls.find((c) => c.path === '/artists/art1/albums').params.include_groups, 'single');
});

test('get_artist_appearances calls include_groups=appears_on', async () => {
  const { registered, calls } = makeHarness(registerCatalogTools, { getResponse: (p) => (p === '/artists/art1/albums' ? { items: [{ id: 'ap1', name: 'Feat 1', uri: 'spotify:album:ap1', album_type: 'appears_on', release_date: '2026-01-01' }], total: 1 } : undefined) });
  const out = text(await invoke(findTool(registered, 'get_artist_appearances'), { artist_id: 'art1' }));
  assert.match(out, /Appearances/);
  assert.equal(calls.find((c) => c.path === '/artists/art1/albums').params.include_groups, 'appears_on');
});

test('market_validate validates codes', async () => {
  const { registered } = makeHarness(registerCatalogTools, { getResponse: (p) => { if (p === '/markets') return { markets: ['US', 'GB', 'DE'] }; return undefined; } });
  const out = text(await invoke(findTool(registered, 'market_validate'), { markets: ['US', 'XX'] }));
  assert.match(out, /Valid: US/);
  assert.match(out, /Invalid: XX/);
});

test('market_validate with no markets lists valid', async () => {
  const { registered } = makeHarness(registerCatalogTools, { getResponse: (p) => (p === '/markets' ? { markets: ['US', 'GB'] } : undefined) });
  const out = text(await invoke(findTool(registered, 'market_validate'), {}));
  assert.match(out, /Valid markets/);
  assert.match(out, /US/);
});

test('market_validate handles 403 gracefully', async () => {
  const { registered } = makeHarness(registerCatalogTools, { getError: (p) => (p === '/markets' ? new SpotifyApiError(403, 'Forbidden') : undefined) });
  const out = text(await invoke(findTool(registered, 'market_validate'), { markets: ['US'] }));
  assert.match(out, /403|removed|unavailable/i);
});

test('browse_category_deepdive fetches category + playlists', async () => {
  const { registered, calls } = makeHarness(registerCatalogTools, { getResponse: (p) => { if (p === '/browse/categories/mood') return { id: 'mood', name: 'Mood', href: 'h', icons: [] }; if (p === '/browse/categories/mood/playlists') return { playlists: { items: [{ id: 'pl1', name: 'Chill Hits', uri: 'spotify:playlist:pl1' }], total: 1 } }; return undefined; } });
  const out = text(await invoke(findTool(registered, 'browse_category_deepdive'), { category_id: 'mood' }));
  assert.match(out, /Category: Mood/);
  assert.match(out, /Chill Hits/);
  assert.equal(calls.length, 2);
});

// The peek reads /playlists/{id}/items, whose rows are { added_at, item }.
// #773: the legacy /tracks path returned plain track rows, so the peek
// rendered a table of `unknown` for every row.
test('browse_category_deepdive peek reads /playlists/{id}/items rows', async () => {
  const { registered, calls } = makeHarness(registerCatalogTools, {
    getResponse: (p) => {
      if (p === '/browse/categories/mood') return { id: 'mood', name: 'Mood', href: 'h', icons: [] };
      if (p === '/browse/categories/mood/playlists') return { playlists: { items: [{ id: 'pl1', name: 'Chill Hits', uri: 'spotify:playlist:pl1' }], total: 1 } };
      if (p === '/playlists/pl1/items') {
        return {
          items: [
            { added_at: '2026-01-01T00:00:00Z', item: { id: 'trkA', name: 'Sunset Drive', uri: 'spotify:track:trkA', type: 'track' } },
            { added_at: '2026-01-01T00:00:00Z', item: { id: 'trkB', name: 'Night Bus', uri: 'spotify:track:trkB', type: 'track' } },
          ],
          total: 2,
        };
      }
      return undefined;
    },
  });
  const result = await invoke(findTool(registered, 'browse_category_deepdive'), { category_id: 'mood', peek_items: true });
  const out = text(result);
  assert.match(out, /Sunset Drive/);
  assert.match(out, /spotify:track:trkA/);
  assert.match(out, /Night Bus/);
  assert.ok(!/unknown/.test(out), `peek rendered unknown rows: ${out}`);
  assert.equal(result.structuredContent?.peek_error, null);
  const peekCall = calls.find((c) => c.path === '/playlists/pl1/items');
  assert.ok(peekCall, `expected a peek on /playlists/pl1/items, saw ${JSON.stringify(calls)}`);
  assert.equal(peekCall?.params?.additional_types, 'track');
});

// A peek that could not be read is unknown, not an empty playlist.
test('browse_category_deepdive reports peek_error instead of an empty peek', async () => {
  const { registered } = makeHarness(registerCatalogTools, {
    getResponse: (p) => {
      if (p === '/browse/categories/mood') return { id: 'mood', name: 'Mood', href: 'h', icons: [] };
      if (p === '/browse/categories/mood/playlists') return { playlists: { items: [{ id: 'pl1', name: 'Chill Hits', uri: 'spotify:playlist:pl1' }], total: 1 } };
      return undefined;
    },
    getError: (p) => (p === '/playlists/pl1/items' ? new SpotifyApiError(403, 'Forbidden') : undefined),
  });
  const result = await invoke(findTool(registered, 'browse_category_deepdive'), { category_id: 'mood', peek_items: true });
  const out = text(result);
  assert.equal(result.structuredContent?.peek, null);
  assert.equal(typeof result.structuredContent?.peek_error, 'string');
  assert.match(String(result.structuredContent?.peek_error), /Forbidden/);
  assert.match(out, /preview unavailable/);
  assert.ok(!/Peek \(first playlist/.test(out), `failed peek must not read as a populated peek: ${out}`);
});

test('browse_category_deepdive peek_error is present in json mode', async () => {
  const { registered } = makeHarness(registerCatalogTools, {
    getResponse: (p) => {
      if (p === '/browse/categories/mood') return { id: 'mood', name: 'Mood', href: 'h', icons: [] };
      if (p === '/browse/categories/mood/playlists') return { playlists: { items: [{ id: 'pl1', name: 'Chill Hits', uri: 'spotify:playlist:pl1' }], total: 1 } };
      return undefined;
    },
    getError: (p) => (p === '/playlists/pl1/items' ? new SpotifyApiError(500, 'boom') : undefined),
  });
  const result = await invoke(findTool(registered, 'browse_category_deepdive'), { category_id: 'mood', peek_items: true, response_format: 'json' });
  const parsed = JSON.parse(text(result)) as Record<string, unknown>;
  assert.ok('peek_error' in parsed, 'json payload must carry peek_error');
  assert.match(String(parsed.peek_error), /boom/);
});

test('show_episode_search filters by query', async () => {
  const { registered } = makeHarness(registerCatalogTools, { getResponse: (p) => (p === '/shows/shw1/episodes' ? { items: [episodeSimpleFixture({ id: 'ep1', name: 'AMA with Jack', description: 'ask me anything' }), episodeSimpleFixture({ id: 'ep2', name: 'Other', description: 'nothing' })], total: 2 } : undefined) });
  const out = text(await invoke(findTool(registered, 'show_episode_search'), { show_id: 'shw1', query: 'AMA' }));
  assert.match(out, /AMA with Jack/);
  assert.ok(!out.includes('"Other"'));
});

test('show_episode_search reports no matches', async () => {
  const { registered } = makeHarness(registerCatalogTools, { getResponse: (p) => (p === '/shows/shw1/episodes' ? { items: [episodeSimpleFixture({ name: 'Other' })], total: 1 } : undefined) });
  const out = text(await invoke(findTool(registered, 'show_episode_search'), { show_id: 'shw1', query: 'zzz' }));
  assert.match(out, /No episodes matching/);
});

// A show whose even-numbered episode titles match "Match": the fixture pages
// like the real endpoint so a walk can be counted.
function pagedShow(total: number) {
  return (_path: string, params?: Record<string, string>) => {
    const off = Number(params?.offset ?? 0);
    const lim = Number(params?.limit ?? 20);
    const end = Math.min(total, off + lim);
    const items = [];
    for (let i = off; i < end; i += 1) {
      items.push(episodeSimpleFixture({
        id: `ep${i}`,
        name: i % 2 === 0 ? `Match ${i}` : `Filler ${i}`,
        description: 'episode body',
      }));
    }
    return { items, total, offset: off, limit: lim, next_offset: end < total ? end : null };
  };
}

test('show_episode_search fetch_all reports the 500-episode safety cap instead of a full-show claim (#790)', async () => {
  const { registered, calls } = makeHarness(registerCatalogTools, { getResponse: pagedShow(1200) });
  const result = await invoke(findTool(registered, 'show_episode_search'), { show_id: 'shw1', query: 'Match', fetch_all: true });
  // The walk's request pattern comes first: pre-fix it requested 11 pages of 50
  // (550 episodes) and reported nothing about how far it got.
  assert.equal(calls.length, 25, 'walk must stop at the cap, not overshoot it');
  const scannedFromCalls = calls.reduce((sum, c) => sum + Number(c.params?.limit ?? 0), 0);
  assert.equal(scannedFromCalls, 500, 'no request may overshoot the safety cap');
  const sc = result.structuredContent as Record<string, unknown>;
  assert.equal(sc.scanned_episodes, 500);
  assert.equal(sc.safety_cap_hit, true);
  assert.equal(sc.total_episodes, 1200);
  const out = text(result);
  assert.match(out, /500-episode safety cap/);
  assert.match(out, /not every match/);
});

test('show_episode_search fetch_all starts at the caller offset with the caller page size (#790)', async () => {
  const { registered, calls } = makeHarness(registerCatalogTools, { getResponse: pagedShow(30) });
  const result = await invoke(findTool(registered, 'show_episode_search'), { show_id: 'shw1', query: 'Match', fetch_all: true, offset: 10, limit: 5 });
  assert.deepEqual(calls[0].params, { limit: '5', offset: '10' });
  const sc = result.structuredContent as Record<string, unknown>;
  assert.equal(sc.scanned_episodes, 20, 'walk covers episodes 10-29 of a 30-episode show');
  assert.equal(sc.scanned_from, 10);
  assert.equal(sc.scanned_to, 30);
  assert.equal(sc.safety_cap_hit, false);
  assert.equal(sc.pagination, undefined, 'a fetch_all walk is not a page: no next_offset by construction');
});

test('show_episode_search max_results trims rows without bounding the walk (#790)', async () => {
  const { registered, calls } = makeHarness(registerCatalogTools, { getResponse: pagedShow(1200) });
  const result = await invoke(findTool(registered, 'show_episode_search'), { show_id: 'shw1', query: 'Match', fetch_all: true, max_results: 3 });
  const sc = result.structuredContent as Record<string, unknown>;
  assert.equal(calls.length, 25, 'max_results must not shorten the scan');
  assert.equal(sc.scanned_episodes, 500);
  assert.equal((sc.matches as unknown[]).length, 3);
  const out = text(result);
  assert.match(out, /\(247 more — raise max_results, continue with offset\)/);
  assert.ok(!/fetch_all/.test(out), 'footer must not advise the flag the caller already set');
});

test('show_episode_search page mode reports the episode window it scanned (#790)', async () => {
  const { registered } = makeHarness(registerCatalogTools, { getResponse: pagedShow(10) });
  const result = await invoke(findTool(registered, 'show_episode_search'), { show_id: 'shw1', query: 'Match', offset: 2, limit: 4 });
  const sc = result.structuredContent as Record<string, unknown>;
  assert.deepEqual(sc.pagination, { total: 10, offset: 2, limit: 4, returned: 4, next_offset: 6 });
  assert.equal(sc.scanned_episodes, 4);
  assert.equal(sc.safety_cap_hit, false);
});

// --------------------------------------------------- catalog_batch_lookup

test('catalog_batch_lookup rejects >50 URIs via schema before any client call', async () => {
  const { registered } = makeHarness(registerCatalogTools);
  const tooMany = Array.from({ length: 51 }, (_, i) => `spotify:track:${String(i).padStart(22, '0')}`);
  const schema = findTool(registered, 'catalog_batch_lookup').schema.uris;
  assert.equal(schema.safeParse(tooMany).success, false, 'schema max(50) must reject 51 URIs');
});

test('catalog_batch_lookup accepts exactly 50 URIs and fans out per type', async () => {
  // Use 22-char IDs so parseSpotifyUri resolves them correctly
  const trackCount = 25;
  const albumCount = 20; // albums chunk at 20, so 20 = exactly 1 chunk → 1 call
  const tracks = Array.from({ length: trackCount }, (_, i) => ({
    id: String(i).padStart(22, '0'),
    name: `Track ${i}`,
    uri: `spotify:track:${String(i).padStart(22, '0')}`,
  }));
  const albums = Array.from({ length: albumCount }, (_, i) => ({
    id: String(100 + i).padStart(22, '0'),
    name: `Album ${i}`,
    uri: `spotify:album:${String(100 + i).padStart(22, '0')}`,
  }));
  const trackIds = tracks.map((t) => t.id);
  const albumIds = albums.map((a) => a.id);
  const { registered, calls } = makeHarness(registerCatalogTools, {
    getResponse: (p, params) => {
      if (p === '/tracks') {
        const ids = params!.ids.split(',');
        return { tracks: ids.map((id) => tracks.find((t) => t.id === id) ?? { id, name: `Track ${id}`, uri: `spotify:track:${id}` }) };
      }
      if (p === '/albums') {
        const ids = params!.ids.split(',');
        return { albums: ids.map((id) => albums.find((a) => a.id === id) ?? { id, name: `Album ${id}`, uri: `spotify:album:${id}` }) };
      }
      return undefined;
    },
  });
  const uris = [...tracks.map((t) => t.uri), ...albums.map((a) => a.uri)];
  const out = text(await invoke(findTool(registered, 'catalog_batch_lookup'), { uris }));
  // One chunk per type group: 1 tracks call + 1 albums call
  assert.equal(calls.filter((c) => c.path === '/tracks').length, 1);
  assert.equal(calls.filter((c) => c.path === '/albums').length, 1);
  assert.match(out, /Batch lookup/);
  assert.match(out, /Track 0/);
  assert.match(out, /Album 0/);
});

test('catalog_batch_lookup skips unsupported types (playlists) and reports them as invalid', async () => {
  const { registered } = makeHarness(registerCatalogTools, {
    getResponse: (p) => {
      if (p === '/tracks') return { tracks: [{ id: 't1', name: 'Track 1', uri: 'spotify:track:t1' }] };
      return undefined;
    },
  });
  const out = text(await invoke(findTool(registered, 'catalog_batch_lookup'), {
    uris: ['spotify:track:t1', 'spotify:playlist:pl1'],
  }));
  assert.match(out, /Invalid URIs skipped/i);
  assert.match(out, /spotify:playlist:pl1/);
  assert.match(out, /Track 1/);
});


// ---------------------------------------------------------------------------
// #789: catalog id params share the resolver grammar (bare id / URI / URL)
// ---------------------------------------------------------------------------


/** The three input forms every catalog reference must accept interchangeably. */
const threeForms = (kind: string) => [
  REF_ID,
  `spotify:${kind}:${REF_ID}`,
  `https://open.spotify.com/${kind}/${REF_ID}`,
];

/**
 * One regression per changed tool: for each of the three input forms the wire
 * call must carry the bare id, never the URI or URL the caller supplied.
 */
async function assertWireCarriesBareId(
  tool: string,
  argName: string,
  kind: string,
  expectedPath: (id: string) => string,
  extraArgs: Record<string, unknown> = {},
  response: (path: string, params?: Record<string, string>) => unknown = () => ({}),
): Promise<void> {
  for (const form of threeForms(kind)) {
    const { registered, calls } = makeHarness(registerCatalogTools, {
      getResponse: response,
    });
    const target = findTool(registered, tool);
    await invoke(target, parseArgs(target, { [argName]: form, ...extraArgs }));
    // Market-gated tools preflight GET /me for the account country; only the
    // entity call itself is under test here.
    const entityCalls = calls.filter((c) => c.path !== '/me');
    assert.deepEqual(
      entityCalls.map((c) => c.path),
      [expectedPath(REF_ID)],
      `${tool} must send the bare id for input form ${form}`,
    );
  }
}

test('#789 get_track accepts id, URI and URL and always calls /tracks/{bare id}', async () => {
  await assertWireCarriesBareId(
    'get_track', 'id', 'track',
    (id) => `/tracks/${id}`,
    {},
    (path) => (path.startsWith('/tracks/') ? trackFixture({ id: REF_ID }) : undefined),
  );
});

test('#789 get_artist accepts id, URI and URL and always calls /artists/{bare id}', async () => {
  await assertWireCarriesBareId(
    'get_artist', 'id', 'artist',
    (id) => `/artists/${id}`,
    {},
    (path) => (path.startsWith('/artists/') ? { id: REF_ID, name: 'Queen', uri: `spotify:artist:${REF_ID}`, genres: [] } : undefined),
  );
});

test('#789 get_artist_albums accepts id, URI and URL and always calls /artists/{bare id}/albums', async () => {
  resetCatalogMarketCache();
  await assertWireCarriesBareId(
    'get_artist_albums', 'id', 'artist',
    (id) => `/artists/${id}/albums`,
    {},
    (path) => (path.endsWith('/albums') ? { items: [], total: 0 } : undefined),
  );
});

test('#789 get_album accepts id, URI and URL and always calls /albums/{bare id}', async () => {
  await assertWireCarriesBareId(
    'get_album', 'id', 'album',
    (id) => `/albums/${id}`,
    {},
    (path) => (path.startsWith('/albums/') ? albumFullFixture() : undefined),
  );
});

test('#789 get_album_tracks accepts id, URI and URL and always calls /albums/{bare id}/tracks', async () => {
  await assertWireCarriesBareId(
    'get_album_tracks', 'id', 'album',
    (id) => `/albums/${id}/tracks`,
    {},
    (path) => (path.endsWith('/tracks') ? { items: [], total: 0 } : undefined),
  );
});

test('#789 get_show accepts id, URI and URL and always calls /shows/{bare id}', async () => {
  resetCatalogMarketCache();
  await assertWireCarriesBareId(
    'get_show', 'id', 'show',
    (id) => `/shows/${id}`,
    {},
    (path) => (path.startsWith('/shows/') ? { ...showSimpleFixture(), id: REF_ID } : undefined),
  );
});

test('#789 get_episode accepts id, URI and URL and always calls /episodes/{bare id}', async () => {
  resetCatalogMarketCache();
  await assertWireCarriesBareId(
    'get_episode', 'id', 'episode',
    (id) => `/episodes/${id}`,
    {},
    (path) => (path.startsWith('/episodes/') ? { ...episodeSimpleFixture(), id: REF_ID, languages: ['en'], show: { name: 'Pod' } } : undefined),
  );
});

test('#789 get_artist_top_tracks accepts id, URI and URL and always calls /artists/{bare id}/top-tracks', async () => {
  resetCatalogMarketCache();
  await assertWireCarriesBareId(
    'get_artist_top_tracks', 'id', 'artist',
    (id) => `/artists/${id}/top-tracks`,
    {},
    (path) => (path.endsWith('/top-tracks') ? { tracks: [] } : undefined),
  );
});

test('#789 get_several_tracks accepts id, URI and URL and joins bare ids on the wire', async () => {
  for (const form of threeForms('track')) {
    const { registered, calls } = makeHarness(registerCatalogTools, {
      getResponse: (path, params) => (path === '/tracks'
        ? { tracks: (params!.ids as string).split(',').map((id) => trackFixture({ id })) }
        : undefined),
    });
    const target = findTool(registered, 'get_several_tracks');
    await invoke(target, parseArgs(target, { ids: [form] }));
    assert.deepEqual(calls, [{ method: 'GET', path: '/tracks', params: { ids: REF_ID } }],
      `get_several_tracks must join the bare id for input form ${form}`);
  }
});

test('#789 get_artist_singles accepts artist_id, URI and URL and always calls /artists/{bare id}/albums', async () => {
  resetCatalogMarketCache();
  await assertWireCarriesBareId(
    'get_artist_singles', 'artist_id', 'artist',
    (id) => `/artists/${id}/albums`,
    {},
    (path) => (path.endsWith('/albums') ? { items: [], total: 0 } : undefined),
  );
});

test('#789 get_artist_appearances accepts artist_id, URI and URL and always calls /artists/{bare id}/albums', async () => {
  resetCatalogMarketCache();
  await assertWireCarriesBareId(
    'get_artist_appearances', 'artist_id', 'artist',
    (id) => `/artists/${id}/albums`,
    {},
    (path) => (path.endsWith('/albums') ? { items: [], total: 0 } : undefined),
  );
});

test('#789 show_episode_search accepts show_id, URI and URL and always calls /shows/{bare id}/episodes', async () => {
  for (const form of threeForms('show')) {
    const { registered, calls } = makeHarness(registerCatalogTools, {
      getResponse: (path) => (path.endsWith('/episodes') ? { items: [], total: 0 } : undefined),
    });
    const target = findTool(registered, 'show_episode_search');
    await invoke(target, parseArgs(target, { show_id: form, query: 'needle' }));
    assert.deepEqual(calls.map((c) => c.path), [`/shows/${REF_ID}/episodes`],
      `show_episode_search must page the bare show id for input form ${form}`);
  }
});

test('#789 get_several_chapters keeps plain string ids — chapters have no resolver kind', () => {
  const { registered } = makeHarness(registerCatalogTools);
  const schema = findTool(registered, 'get_several_chapters').schema.ids;
  // Documented divergence from the six migrated get_several_* siblings: a
  // `spotify:chapter:` URI is not a real Spotify URI form, so this schema
  // stays permissive rather than inventing a kind that refs.ts does not have.
  assert.equal(schema.safeParse([REF_ID]).success, true);
  assert.equal(schema.safeParse(['chapter-ish-id']).success, true);
});

/**
 * One regression per changed get_several_* tool: for each of the three input
 * forms the batched `ids` query parameter must carry bare ids, comma-joined.
 */
async function assertSeveralJoinsBareIds(tool: string, kind: string, path: string, key: string): Promise<void> {
  for (const form of threeForms(kind)) {
    const { registered, calls } = makeHarness(registerCatalogTools, {
      getResponse: (p, params) => (p === path
        ? { [key]: (params!.ids as string).split(',').map((id) => ({ id, name: `Item ${id}`, uri: `spotify:${kind}:${id}`, genres: [], duration_ms: 60000, release_date: '2026-01-01', publisher: 'Pub', authors: [{ name: 'A' }], total_chapters: 1, chapter_number: 1 })) }
        : undefined),
    });
    const target = findTool(registered, tool);
    await invoke(target, parseArgs(target, { ids: [form] }));
    assert.deepEqual(calls, [{ method: 'GET', path, params: { ids: REF_ID } }],
      `${tool} must join the bare id for input form ${form}`);
  }
}

test('#789 get_several_albums accepts id, URI and URL and joins bare ids on the wire', async () => {
  await assertSeveralJoinsBareIds('get_several_albums', 'album', '/albums', 'albums');
});

test('#789 get_several_artists accepts id, URI and URL and joins bare ids on the wire', async () => {
  await assertSeveralJoinsBareIds('get_several_artists', 'artist', '/artists', 'artists');
});

test('#789 get_several_episodes accepts id, URI and URL and joins bare ids on the wire', async () => {
  await assertSeveralJoinsBareIds('get_several_episodes', 'episode', '/episodes', 'episodes');
});

test('#789 get_several_shows accepts id, URI and URL and joins bare ids on the wire', async () => {
  await assertSeveralJoinsBareIds('get_several_shows', 'show', '/shows', 'shows');
});

test('#789 get_several_audiobooks accepts id, URI and URL and joins bare ids on the wire', async () => {
  await assertSeveralJoinsBareIds('get_several_audiobooks', 'audiobook', '/audiobooks', 'audiobooks');
});

// ------------------------------------------------- search history recording

test('a typed search records exactly one history entry, not one per registered tool (#766)', async () => {
  const { registered } = makeHarness(registerCatalogTools, {
    getResponse: (p) => (p === '/search' ? { tracks: { items: [{ id: 't1', name: 'Song', uri: 'spotify:track:t1' }], total: 1 } } : undefined),
  });
  // Seven typed search tools come from this one factory; one call must record
  // one entry, and the other six must record nothing.
  assert.equal(registered.filter((t) => t.name.startsWith('search_')).length, 7);
  await invoke(findTool(registered, 'search_tracks'), { query: 'hello' });
  const entries = await readHistory();
  assert.equal(entries.length, 1);
  assert.equal(entries[0]!.query, 'hello');
  assert.deepEqual(entries[0]!.types, ['track']);
  assert.deepEqual(entries[0]!.top_result_ids, ['spotify:track:t1']);
});

test('a typed search records its market, offset and limit scope (#766)', async () => {
  const { registered } = makeHarness(registerCatalogTools, {
    getResponse: (p) => (p === '/search' ? { artists: { items: [{ id: 'ar1', name: 'Queen', uri: 'spotify:artist:ar1' }], total: 1 } } : undefined),
  });
  // MARKET_CODE uppercases before the handler runs; this harness calls the
  // handler directly, so pass the normalised form the MCP layer would deliver.
  await invoke(findTool(registered, 'search_artists'), { query: 'queen', market: 'DE', offset: 30, limit: 4 });
  const [entry] = await readHistory();
  assert.equal(entry!.market, 'DE');
  assert.equal(entry!.offset, 30);
  assert.equal(entry!.limit, 4);
  assert.deepEqual(entry!.types, ['artist']);
});

test('a typed search in json mode still records the search (#766)', async () => {
  const { registered } = makeHarness(registerCatalogTools, {
    getResponse: (p) => (p === '/search' ? { albums: { items: [{ id: 'al1', name: 'Album', uri: 'spotify:album:al1' }], total: 1 } } : undefined),
  });
  await invoke(findTool(registered, 'search_albums'), { query: 'a night', response_format: 'json' });
  const entries = await readHistory();
  assert.equal(entries.length, 1);
  assert.deepEqual(entries[0]!.types, ['album']);
});

test('a typed search that returns nothing records nothing (#766)', async () => {
  const { registered } = makeHarness(registerCatalogTools, {
    getResponse: (p) => (p === '/search' ? { tracks: { items: [], total: 0 } } : undefined),
  });
  await invoke(findTool(registered, 'search_tracks'), { query: 'zzz' });
  await assert.rejects(readFile(historyFile, 'utf8'), { code: 'ENOENT' });
});

test('SPOTIFY_MCP_SEARCH_HISTORY=0 leaves the typed searches unrecorded (#766)', async () => {
  process.env.SPOTIFY_MCP_SEARCH_HISTORY = '0';
  const { registered } = makeHarness(registerCatalogTools, {
    getResponse: (p) => (p === '/search' ? { tracks: { items: [{ id: 't1', name: 'Song', uri: 'spotify:track:t1' }], total: 1 } } : undefined),
  });
  const out = text(await invoke(findTool(registered, 'search_tracks'), { query: 'hello' }));
  assert.match(out, /Song/);
  await assert.rejects(readFile(historyFile, 'utf8'), { code: 'ENOENT' });
});
