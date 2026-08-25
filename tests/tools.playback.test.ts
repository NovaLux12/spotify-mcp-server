import test from 'node:test';
import assert from 'node:assert/strict';
import { registerPlaybackTools } from '../src/tools/playback.js';

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

type Call = { method: string; path: string; params?: Record<string, string>; body?: unknown };

interface ClientOptions {
  getResponse?: (path: string, params?: Record<string, string>) => unknown;
}

function trackFixture(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: 'trk1',
    name: 'Bohemian Rhapsody',
    uri: 'spotify:track:trk1',
    type: 'track',
    duration_ms: 355000,
    explicit: false,
    artists: [{ id: 'art1', name: 'Queen', uri: 'spotify:artist:art1' }],
    album: {
      id: 'alb1',
      name: 'A Night at the Opera',
      uri: 'spotify:album:alb1',
      images: [{ url: 'https://example.com/art.jpg', height: 640, width: 640 }],
    },
    ...overrides,
  };
}

function episodeFixture(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: 'ep1',
    name: 'Episode One',
    uri: 'spotify:episode:ep1',
    type: 'episode',
    duration_ms: 1800000,
    explicit: false,
    description: 'The first episode',
    release_date: '2026-01-01',
    show: { id: 'shw1', name: 'Great Podcast', uri: 'spotify:show:shw1' },
    ...overrides,
  };
}

function playbackStateFixture(item: unknown) {
  return {
    is_playing: true,
    progress_ms: 185000,
    shuffle_state: true,
    repeat_state: 'track',
    timestamp: 1750000000000,
    device: {
      id: 'dev1',
      name: 'Living Room',
      type: 'Computer',
      is_active: true,
      is_private_session: false,
      is_restricted: false,
      volume_percent: 42,
      supports_volume: true,
    },
    item,
    currently_playing_type: item && (item as { type: string }).type === 'track' ? 'track' : 'episode',
    context: null,
  };
}

function makeHarness(opts: ClientOptions = {}) {
  const calls: Call[] = [];
  const client = {
    get: async (path: string, params?: Record<string, string>) => {
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
  registerPlaybackTools(
    server as unknown as Parameters<typeof registerPlaybackTools>[0],
    client as unknown as Parameters<typeof registerPlaybackTools>[1],
  );
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

// ------------------------------------------------------------ get_now_playing

test('get_now_playing renders full track state', async () => {
  const state = playbackStateFixture(trackFixture());
  const { registered, calls } = makeHarness({
    getResponse: (path) => (path === '/me/player' ? state : undefined),
  });

  const result = await invoke(findTool(registered, 'get_now_playing'));

  assert.deepEqual(calls, [
    { method: 'GET', path: '/me/player', params: { additional_types: 'track,episode' } },
  ]);
  const out = text(result);
  assert.match(out, /Now playing: "Bohemian Rhapsody" by Queen/);
  assert.match(out, /Album: A Night at the Opera/);
  assert.match(out, /Art: https:\/\/example\.com\/art\.jpg/);
  // progress 185000ms -> 3:05, duration 355000ms -> 5:55
  assert.match(out, /Progress: 3:05 \/ 5:55/);
  assert.match(out, /Device: Living Room \(Computer\)/);
  assert.match(out, /Volume: 42%/);
  assert.match(out, /Shuffle: on \| Repeat: track/);
  assert.match(out, /URI: spotify:track:trk1/);
});

test('get_now_playing formats paused episode payload via show.name path', async () => {
  const ep = episodeFixture();
  const state = playbackStateFixture(ep);
  state.is_playing = false;
  state.device.volume_percent = null;
  const { registered } = makeHarness({
    getResponse: (path) => (path === '/me/player' ? state : undefined),
  });

  const out = text(await invoke(findTool(registered, 'get_now_playing')));

  assert.match(out, /Now paused: "Episode One"/);
  assert.match(out, /Show: Great Podcast/);
  assert.match(out, /Progress: 3:05 \/ 30:00/);
});

test('get_now_playing returns friendly message on 204/null response', async () => {
  const { registered, calls } = makeHarness(); // get -> null

  const out = text(await invoke(findTool(registered, 'get_now_playing')));

  assert.equal(calls.length, 1);
  assert.equal(text(await invoke(findTool(registered, 'get_now_playing'))), 'Nothing is currently playing.');
});

// ------------------------------------------------------ get_currently_playing

test('get_currently_playing renders compact track summary', async () => {
  const { registered, calls } = makeHarness({
    getResponse: (path) =>
      path === '/me/player/currently-playing'
        ? { item: trackFixture(), progress_ms: 60000, is_playing: true }
        : undefined,
  });

  const out = text(await invoke(findTool(registered, 'get_currently_playing')));

  assert.equal(calls[0].path, '/me/player/currently-playing');
  assert.match(out, /^Playing: "Bohemian Rhapsody" by Queen \(5:55\)$/m);
  assert.match(out, /Progress: 1:00 \/ 5:55/);
  assert.match(out, /URI: spotify:track:trk1/);
});

test('get_currently_playing formats episode with em dash and show name', async () => {
  const { registered } = makeHarness({
    getResponse: (path) =>
      path === '/me/player/currently-playing'
        ? { item: episodeFixture(), progress_ms: 30000, is_playing: false }
        : undefined,
  });

  const out = text(await invoke(findTool(registered, 'get_currently_playing')));

  assert.match(out, /^Paused: "Episode One" — Great Podcast \(30:00\)$/m);
});

test('get_currently_playing handles 204/null and null progress', async () => {
  const { registered } = makeHarness({
    getResponse: (path) =>
      path === '/me/player/currently-playing'
        ? { item: trackFixture(), progress_ms: null, is_playing: false }
        : undefined,
  });
  const tool = findTool(registered, 'get_currently_playing');

  const outWithProgress = text(await invoke(tool));
  assert.match(outWithProgress, /Progress: 0:00 \/ 5:55/);

  const { registered: emptyRegistered } = makeHarness();
  const outEmpty = text(await invoke(findTool(emptyRegistered, 'get_currently_playing')));
  assert.equal(outEmpty, 'Nothing is currently playing.');
});

// ------------------------------------------- player-state read params (#48)

test('get_now_playing forwards default additional_types and omits market when not supplied', async () => {
  const { registered, calls } = makeHarness();
  await invoke(findTool(registered, 'get_now_playing'));
  const call = calls.find((c) => c.path === '/me/player');
  assert.deepEqual(call?.params, { additional_types: 'track,episode' });
});

test('get_now_playing forwards explicit market and additional_types override', async () => {
  const { registered, calls } = makeHarness();
  await invoke(findTool(registered, 'get_now_playing'), {
    market: 'GB',
    additional_types: ['episode'],
  });
  const call = calls.find((c) => c.path === '/me/player');
  assert.deepEqual(call?.params, { additional_types: 'episode', market: 'GB' });
});

test('get_currently_playing forwards default additional_types to the endpoint', async () => {
  const { registered, calls } = makeHarness({
    getResponse: () => ({ item: trackFixture(), progress_ms: null, is_playing: false }),
  });
  await invoke(findTool(registered, 'get_currently_playing'));
  const call = calls.find((c) => c.path === '/me/player/currently-playing');
  assert.deepEqual(call?.params, { additional_types: 'track,episode' });
});

test('get_currently_playing forwards explicit market and additional_types override', async () => {
  const { registered, calls } = makeHarness({
    getResponse: () => ({ item: trackFixture(), progress_ms: null, is_playing: false }),
  });
  await invoke(findTool(registered, 'get_currently_playing'), {
    market: 'US',
    additional_types: ['track'],
  });
  const call = calls.find((c) => c.path === '/me/player/currently-playing');
  assert.deepEqual(call?.params, { additional_types: 'track', market: 'US' });
});

test('additional_types rejects values outside track/episode via zod schema', () => {
  const { registered } = makeHarness();
  const schema = findTool(registered, 'get_now_playing').schema;
  assert.equal(schema.additional_types.safeParse(['track']).success, true);
  assert.equal(schema.additional_types.safeParse(['album']).success, false);
});

// ----------------------------------------------------------------------- play

test('play maps context_uri, offset, position_ms into request body', async () => {
  const { registered, calls } = makeHarness();
  await invoke(findTool(registered, 'play'), {
    context_uri: 'spotify:album:alb1',
    offset: 3,
    position_ms: 45000,
  });

  assert.deepEqual(calls, [
    {
      method: 'PUT',
      path: '/me/player/play',
      body: { context_uri: 'spotify:album:alb1', offset: { position: 3 }, position_ms: 45000 },
    },
  ]);
});

test('play sends ad-hoc uris list', async () => {
  const { registered, calls } = makeHarness();
  await invoke(findTool(registered, 'play'), {
    uris: ['spotify:track:a', 'spotify:track:b'],
  });

  assert.equal(calls[0].method, 'PUT');
  assert.deepEqual((calls[0].body as { uris: string[] }).uris, ['spotify:track:a', 'spotify:track:b']);
  assert.equal((calls[0].body as Record<string, unknown>).context_uri, undefined);
});

test('play omits body entirely when no arguments given', async () => {
  const { registered, calls } = makeHarness();
  const result = await invoke(findTool(registered, 'play'), {});

  assert.deepEqual(calls, [{ method: 'PUT', path: '/me/player/play', body: undefined }]);
  assert.equal(text(result), 'Playback started.');
});

test('play forwards device_id as encoded query parameter', async () => {
  const { registered, calls } = makeHarness();
  await invoke(findTool(registered, 'play'), { device_id: 'dev with space' });

  assert.equal(calls[0].path, '/me/player/play?device_id=dev%20with%20space');
});

test('play rejects uris arrays over 100 entries via zod max(100)', () => {
  const { registered } = makeHarness();
  const play = findTool(registered, 'play');
  const hundred = Array.from({ length: 100 }, (_, i) => `spotify:track:t${i}`);
  assert.equal(play.schema.uris.safeParse(hundred).success, true);
  const hundredOne = Array.from({ length: 101 }, (_, i) => `spotify:track:t${i}`);
  assert.equal(play.schema.uris.safeParse(hundredOne).success, false);
});

test('play treats an empty uris array as conflicting with context_uri (issue #23)', async () => {
  const { registered, calls } = makeHarness();
  await assert.rejects(
    invoke(findTool(registered, 'play'), {
      context_uri: 'spotify:album:alb1',
      uris: [],
    }),
    /Provide either context_uri or uris, not both\./,
  );
  assert.equal(calls.some((c) => c.method === 'PUT'), false);
});

test('play rejects a standalone empty uris array (issue #23)', async () => {
  const { registered, calls } = makeHarness();
  await assert.rejects(
    invoke(findTool(registered, 'play'), { uris: [] }),
    /uris must contain at least one track\/episode URI\./,
  );
  assert.equal(calls.some((c) => c.method === 'PUT'), false);
});

test('play rejects numeric offset on artist contexts, accepts offset_uri instead (issue #24)', async () => {
  const { registered, calls } = makeHarness();
  await assert.rejects(
    invoke(findTool(registered, 'play'), {
      context_uri: 'spotify:artist:art1',
      offset: 2,
    }),
    /Numeric offset is not valid for artist contexts/,
  );

  await invoke(findTool(registered, 'play'), {
    context_uri: 'spotify:artist:art1',
    offset_uri: 'spotify:track:trk9',
  });
  const put = calls.find((c) => c.method === 'PUT');
  assert.ok(put, 'expected a PUT for the offset_uri variant');
  assert.deepEqual(put.body, {
    context_uri: 'spotify:artist:art1',
    offset: { uri: 'spotify:track:trk9' },
  });
});

// ---------------------------------------------------- transport-style controls

test('seek sends position_ms and optional device_id in query string', async () => {
  const { registered, calls } = makeHarness();
  const tool = findTool(registered, 'seek');

  await invoke(tool, { position_ms: 90000 });
  await invoke(tool, { position_ms: 125000, device_id: 'dev9' });

  assert.deepEqual(
    calls.map((c) => c.path),
    ['/me/player/seek?position_ms=90000', '/me/player/seek?position_ms=125000&device_id=dev9'],
  );
  assert.ok(calls.every((c) => c.method === 'PUT'));
});

test('seek rejects negative position_ms via zod schema', () => {
  const { registered } = makeHarness();
  const schema = findTool(registered, 'seek').schema;
  assert.equal(schema.position_ms.safeParse(-1).success, false);
  assert.equal(schema.position_ms.safeParse(0).success, true);
});

test('set_volume validates range 0–100 and forwards query params', async () => {
  const { registered, calls } = makeHarness();
  const tool = findTool(registered, 'set_volume');

  // zod rejects out-of-range values
  assert.equal(tool.schema.volume_percent.safeParse(101).success, false);
  assert.equal(tool.schema.volume_percent.safeParse(-1).success, false);
  assert.equal(tool.schema.volume_percent.safeParse(100).success, true);

  const result = await invoke(tool, { volume_percent: 50, device_id: 'dev1' });

  assert.equal(calls[0].method, 'PUT');
  assert.equal(calls[0].path, '/me/player/volume?volume_percent=50&device_id=dev1');
  assert.match(text(result), /Volume set to 50%/);
});

test('set_repeat rejects bogus mode and forwards valid ones', async () => {
  const { registered, calls } = makeHarness();
  const tool = findTool(registered, 'set_repeat');

  assert.equal(tool.schema.state.safeParse('bogus').success, false);
  assert.equal(tool.schema.state.safeParse('off').success, true);
  assert.equal(tool.schema.state.safeParse('context').success, true);
  assert.equal(tool.schema.state.safeParse('track').success, true);

  await invoke(tool, { state: 'context' });

  assert.equal(calls[0].method, 'PUT');
  assert.equal(calls[0].path, '/me/player/repeat?state=context');
});

test('set_shuffle serialises boolean state into query string', async () => {
  const { registered, calls } = makeHarness();
  const tool = findTool(registered, 'set_shuffle');

  const result = await invoke(tool, { state: true });

  assert.equal(calls[0].method, 'PUT');
  assert.equal(calls[0].path, '/me/player/shuffle?state=true');
  assert.equal(text(result), 'Shuffle on.');
});

// ----------------------------------------------------------- queue & transfer

test('add_to_queue posts uri and optional device_id as query params', async () => {
  const { registered, calls } = makeHarness();

  await invoke(findTool(registered, 'add_to_queue'), { uri: 'spotify:track:abc' });
  await invoke(findTool(registered, 'add_to_queue'), { uri: 'spotify:episode:xyz', device_id: 'd1' });

  assert.deepEqual(
    calls.map((c) => ({ method: c.method, path: c.path })),
    [
      { method: 'POST', path: '/me/player/queue?uri=spotify%3Atrack%3Aabc' },
      { method: 'POST', path: '/me/player/queue?uri=spotify%3Aepisode%3Axyz&device_id=d1' },
    ],
  );
});

test('transfer_playback wraps device id in device_ids array', async () => {
  const { registered, calls } = makeHarness();

  const result = await invoke(findTool(registered, 'transfer_playback'), {
    device_id: 'dev2',
    play: true,
  });

  assert.equal(calls[0].method, 'PUT');
  assert.equal(calls[0].path, '/me/player');
  assert.deepEqual(calls[0].body, { device_ids: ['dev2'], play: true });
  assert.match(text(result), /transferred to device dev2/);

  const { registered: r2, calls: c2 } = makeHarness();
  await invoke(findTool(r2, 'transfer_playback'), { device_id: 'dev2' });
  assert.deepEqual(c2[0].body, { device_ids: ['dev2'] }); // play omitted when unset
});

// ---------------------------------------------------------------- get_devices

test('get_devices lists devices with active marker, volume, and ids', async () => {
  const { registered, calls } = makeHarness({
    getResponse: (path) =>
      path === '/me/player/devices'
        ? {
            devices: [
              {
                id: 'dev1',
                name: 'Living Room',
                type: 'Computer',
                is_active: true,
                is_private_session: false,
                is_restricted: false,
                volume_percent: 42,
                supports_volume: true,
              },
              {
                id: null,
                name: 'Speaker',
                type: 'Speaker',
                is_active: false,
                is_private_session: false,
                is_restricted: false,
                volume_percent: null,
                supports_volume: false,
              },
            ],
          }
        : undefined,
  });

  const out = text(await invoke(findTool(registered, 'get_devices')));

  assert.equal(calls[0].path, '/me/player/devices');
  assert.match(out, /Devices:/);
  assert.match(out, /• Living Room \(Computer\) \[ACTIVE\], volume: 42% — ID: dev1/);
  assert.match(out, /• Speaker \(Speaker\) — ID: n\/a/); // null id and volume rendered safely
});

test('get_devices reports helpful message when list is empty or null', async () => {
  const { registered } = makeHarness({
    getResponse: (path) => (path === '/me/player/devices' ? { devices: [] } : undefined),
  });
  assert.match(text(await invoke(findTool(registered, 'get_devices'))), /No devices found/);

  const { registered: nullReg } = makeHarness(); // null (204) response
  assert.match(text(await invoke(findTool(nullReg, 'get_devices'))), /No devices found/);
});

// ----------------------------------------------------------- play_from_search

test('play_from_search searches with limit 10, forwards market, and skips null rows', async () => {
  const match = trackFixture();
  const { registered, calls } = makeHarness({
    getResponse: (path) => {
      if (path !== '/search') return undefined;
      // Issue #28: Spotify returns literal null rows inside items[].
      return {
        tracks: { items: [null, match, trackFixture({ id: 'trk2', name: 'Other' })], total: 2 },
      };
    },
  });

  const result = await invoke(findTool(registered, 'play_from_search'), {
    query: 'bohemian rhapsody',
    search_type: 'track',
    market: 'GB',
  });

  const searchCall = calls.find((c) => c.path === '/search');
  assert.ok(searchCall, 'expected a call to /search');
  assert.deepEqual(searchCall.params, {
    q: 'bohemian rhapsody',
    type: 'track',
    limit: '10',
    market: 'GB',
  });

  const playCall = calls.find((c) => c.path === '/me/player/play');
  assert.ok(playCall, 'expected a PUT to /me/player/play');
  assert.equal(playCall.method, 'PUT');
  // First NON-NULL track row is played, not the leading null slot.
  assert.deepEqual(playCall.body, { uris: ['spotify:track:trk1'] });

  const out = text(result);
  assert.match(out, /Now playing: "Bohemian Rhapsody" by Queen/);
  assert.match(out, /from the album "A Night at the Opera"/);
});

test('play_from_search omits market param when caller supplies none', async () => {
  const { registered, calls } = makeHarness({
    getResponse: (path) =>
      path === '/search' ? { tracks: { items: [trackFixture()], total: 1 } } : undefined,
  });

  await invoke(findTool(registered, 'play_from_search'), {
    query: 'queen',
    search_type: 'track',
  });

  const searchCall = calls.find((c) => c.path === '/search');
  assert.ok(searchCall, 'expected a call to /search');
  assert.equal(searchCall.params?.market, undefined);
});

test('play_from_search plays first episode result for search_type episode', async () => {
  const ep = { ...episodeFixture() };
  const { registered, calls } = makeHarness({
    getResponse: (path) =>
      path === '/search'
        ? { episodes: { items: [{ ...ep, show: { ...ep.show } }] }, total: 1 }
        : undefined,
  });

  const result = await invoke(findTool(registered, 'play_from_search'), {
    query: 'episode one',
    search_type: 'episode',
  });

  const searchCall = calls.find((c) => c.path === '/search');
  assert.equal(searchCall?.params?.type, 'episode');

  const playCall = calls.find((c) => c.path === '/me/player/play');
  assert.deepEqual(playCall?.body, { uris: ['spotify:episode:ep1'] });
  assert.match(text(result), /"Episode One" — Great Podcast/);
  assert.doesNotMatch(text(result), /from the album/); // episodes have no album clause
});

test('play_from_search targets requested device in play url', async () => {
  const { registered, calls } = makeHarness({
    getResponse: (path) => (path === '/search' ? { tracks: { items: [trackFixture()], total: 1 } } : undefined),
  });


  await invoke(findTool(registered, 'play_from_search'), {
    query: 'x',
    search_type: 'track',
    device_id: 'dev7',
  });
  assert.ok(calls.some((c) => c.path === '/me/player/play?device_id=dev7'));
});

test('play_from_search zero results returns normal content, not an exception', async () => {
  const { registered, calls } = makeHarness({
    getResponse: (path) => (path === '/search' ? { tracks: { items: [], total: 0 } } : undefined),
  });
  const result =
    await invoke(findTool(registered, 'play_from_search'), { query: 'zzzznope', search_type: 'track' });
  assert.equal(calls.some((c) => c.path === '/me/player/play'), false); // nothing played
  assert.match(text(result), /^No playable results found for zzzznope$/);
});
// --------------------------------------- shared shaping (#51/#52/#53/#57/#58)

test('get_now_playing json mode returns the raw API state as parseable JSON (#51)', async () => {
  const { registered } = makeHarness({
    getResponse: () => playbackStateFixture(trackFixture()),
  });
  const result = await invoke(findTool(registered, 'get_now_playing'), {
    response_format: 'json',
  });
  const parsed = JSON.parse(text(result)) as { is_playing: boolean; item: { name: string } };
  assert.equal(parsed.is_playing, true);
  assert.equal(parsed.item.name, 'Bohemian Rhapsody');
  assert.deepEqual(result.structuredContent, parsed);
});

test('set_volume json mode echoes the mutation as machine-readable content (#51/#58)', async () => {
  const { registered } = makeHarness();
  const result = await invoke(findTool(registered, 'set_volume'), {
    volume_percent: 40,
    response_format: 'json',
  });
  const parsed = JSON.parse(text(result)) as Record<string, unknown>;
  // JSON.stringify drops the undefined device_id
  assert.deepEqual(parsed, { action: 'set_volume', volume_percent: 40 });
});

test('play with uris appends a batch-summary audit echo (#58)', async () => {
  const { registered } = makeHarness();
  const result = await invoke(findTool(registered, 'play'), {
    uris: ['spotify:track:a', 'spotify:track:b', 'spotify:track:c', 'spotify:track:d'],
  });
  assert.match(text(result), /Playback started\./);
  assert.match(
    text(result),
    /4 items affected: spotify:track:a, spotify:track:b, spotify:track:c…/,
  );
});

test('play dry_run previews what would be queued with NO endpoint call (#57)', async () => {
  const { registered, calls } = makeHarness();
  const result = await invoke(findTool(registered, 'play'), {
    context_uri: 'spotify:album:alb1',
    offset: 3,
    dry_run: true,
  });
  assert.equal(calls.length, 0); // nothing hit the API — not even reads
  assert.match(
    text(result),
    /\[dry run\] start playback on spotify:album:alb1 — nothing was changed\./,
  );
  assert.match(text(result), /queue spotify:album:alb1/);
  assert.match(text(result), /start at index 3/);
});

test('play dry_run still validates and rejects malformed URIs before any call (#57)', async () => {
  const { registered, calls } = makeHarness();
  await assert.rejects(
    invoke(findTool(registered, 'play'), { uris: ['spotify:track:a', 'garbage'], dry_run: true }),
    /Invalid Spotify URI/,
  );
  assert.equal(calls.length, 0);
});

test('skip_next dry_run consumes nothing and makes no POST call (#57)', async () => {
  const { registered, calls } = makeHarness();
  const result = await invoke(findTool(registered, 'skip_next'), { dry_run: true });
  assert.equal(calls.length, 0);
  assert.match(text(result), /\[dry run\] skip to next track on the active device/);
});

test('add_to_queue dry_run validates track/episode URIs and previews without POSTing (#57)', async () => {
  const { registered, calls } = makeHarness();
  const result = await invoke(findTool(registered, 'add_to_queue'), {
    uri: 'spotify:episode:ep1',
    dry_run: true,
  });
  assert.equal(calls.length, 0);
  assert.match(text(result), /\[dry run\] add to queue on spotify:episode:ep1/);

  await assert.rejects(
    invoke(findTool(registered, 'add_to_queue'), { uri: 'spotify:artist:nope', dry_run: true }),
    /Invalid Spotify track\/episode URI/,
  );
});

test('play_from_search dry_run resolves the match read-only but never plays it (#57)', async () => {
  const { registered, calls } = makeHarness({
    getResponse: (path) =>
      path === '/search' ? { tracks: { items: [trackFixture()], total: 1 } } : undefined,
  });
  const result = await invoke(findTool(registered, 'play_from_search'), {
    query: 'bohemian',
    search_type: 'track', // direct invocation bypasses the zod default
    dry_run: true,
  });
  assert.equal(calls.some((c) => c.method === 'PUT'), false);
  assert.ok(calls.every((c) => c.method === 'GET'));
  assert.match(text(result), /\[dry run\] start playback on spotify:track:trk1/);
});

test('transfer_playback dry_run previews the move without PUT /me/player (#57)', async () => {
  const { registered, calls } = makeHarness();
  const result = await invoke(findTool(registered, 'transfer_playback'), {
    device_id: 'dev2',
    play: true,
    dry_run: true,
  });
  assert.equal(calls.length, 0);
  assert.match(text(result), /\[dry run\] transfer playback on dev2/);
  assert.match(text(result), /force play on arrival/);
});

test('get_queue truncates to max_results with shared footer + pagination structuredContent (#52/#53)', async () => {
  const items = Array.from({ length: 8 }, (_, i) =>
    trackFixture({ name: `Q${i}`, uri: `spotify:track:q${i}` }),
  );
  const { registered } = makeHarness({
    getResponse: () => ({ currently_playing: trackFixture(), queue: items }),
  });
  const result = await invoke(findTool(registered, 'get_queue'), { max_results: 3 });
  assert.match(text(result), /\(5 more — pass offset or fetch_all\)/);
  const sc = result.structuredContent as {
    items: unknown[];
    truncated: boolean;
    remaining: number;
    pagination: { total: number };
  };
  assert.equal(sc.items.length, 3);
  assert.equal(sc.pagination.total, 8);
  assert.equal(sc.truncated, true);
  assert.equal(sc.remaining, 5);
});

test('handoff preserves position: transfer, resume at offset, set volume (issue #112)', async () => {
    const state = playbackStateFixture(trackFixture());
    const h = makeHarness({ getResponse: (path) => (path === '/me/player' ? state : undefined) });

    await invoke(findTool(h.registered, 'handoff'), { device_id: 'dev2', volume: 30 });

    const puts = h.calls.filter((c) => c.method === 'PUT');
    assert.equal(puts.length, 3, JSON.stringify(h.calls));
    assert.deepEqual(puts[0], { method: 'PUT', path: '/me/player', body: { device_ids: ['dev2'] } });
    assert.equal(puts[1].path, '/me/player/play?device_id=dev2');
    const playBody = puts[1].body as { position_ms: number };
    assert.equal(playBody.position_ms, 185000);
    assert.equal(puts[2].path, '/me/player/volume?volume=30&device_id=dev2');
  });


test('handoff dry_run performs zero calls and lists the steps (issue #112)', async () => {
    const h = makeHarness({ getResponse: (path) => (path === '/me/player' ? playbackStateFixture(trackFixture()) : undefined) });

    const out = text(await invoke(findTool(h.registered, 'handoff'), { device_id: 'dev2', dry_run: true }));

    assert.equal(h.calls.length, 1, 'only the state read; no mutations');
    assert.match(out, /\[dry run\] handoff/);
    assert.match(out, /Resume at 3:05 into/);
  });
