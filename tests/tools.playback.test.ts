import './helpers/hermetic.js';

import test from 'node:test';
import assert from 'node:assert/strict';
import { registerPlaybackTools } from '../src/tools/playback.js';

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// A search inside a tool records to the real ~/.spotify-mcp/search-history.json
// unless the path is redirected. Unredirected, this file created the user's own
// data file from test fixtures, and its existence then broke an unrelated
// "missing file" test in tests/exhaust2_misc.test.ts. Redirect for the whole
// module so no test in this file can reach the real store.
const REAL_HISTORY = process.env.SPOTIFY_MCP_SEARCH_HISTORY_FILE;
const scratchDir = mkdtempSync(join(tmpdir(), 'smcp-playback-test-'));
process.env.SPOTIFY_MCP_SEARCH_HISTORY_FILE = join(scratchDir, 'search-history.json');
process.on('exit', () => {
  rmSync(scratchDir, { recursive: true, force: true });
  if (REAL_HISTORY === undefined) delete process.env.SPOTIFY_MCP_SEARCH_HISTORY_FILE;
  else process.env.SPOTIFY_MCP_SEARCH_HISTORY_FILE = REAL_HISTORY;
});

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

type Call = { method: string; path: string; params?: Record<string, string>; body?: unknown };

interface ClientOptions {
  getResponse?: (path: string, params?: Record<string, string>) => unknown;
  /**
   * The device list `GET /me/player/devices` returns.
   *
   * #848 made `transfer_playback` resolve its target through the shared
   * resolver, so the tool now needs a device list where it used to take the
   * caller's word for a bare id. It is an option rather than a default so that
   * a test which does not care about resolution cannot pass by accident: a
   * silent `[]` would make every transfer refuse with "no device matched", and
   * a refusal is a passing result for a test that only checks the error text.
   */
  devices?: unknown;
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
      if (path === '/me/player/devices' && opts.devices !== undefined) return opts.devices;
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

// #852: `currently_playing_type` admits 'ad' and 'unknown'; the renderers used
// to dereference item.show and threw a TypeError mid-playback.
test('get_now_playing renders an ad item without throwing', async () => {
  const state = {
    ...playbackStateFixture({ type: 'ad', uri: 'spotify:ad:spotify:1' }),
    currently_playing_type: 'ad',
  };
  const { registered } = makeHarness({ getResponse: () => state });

  const out = text(await invoke(findTool(registered, 'get_now_playing')));

  assert.match(out, /^Now playing: "Untitled" \(ad\)$/m);
  assert.match(out, /^Progress: 3:05 \/ unknown$/m);
  assert.match(out, /^URI: spotify:ad:spotify:1$/m);
  assert.doesNotMatch(out, /undefined/);
});

test('get_now_playing renders a named unknown item without throwing', async () => {
  const state = {
    ...playbackStateFixture({ type: 'unknown', name: 'Mystery Item', uri: 'spotify:item:x' }),
    currently_playing_type: 'unknown',
  };
  const { registered } = makeHarness({ getResponse: () => state });

  const out = text(await invoke(findTool(registered, 'get_now_playing')));

  assert.match(out, /^Now playing: "Mystery Item" \(unknown\)$/m);
  assert.doesNotMatch(out, /undefined/);
});

test('get_currently_playing renders an ad item without throwing', async () => {
  const { registered } = makeHarness({
    getResponse: () => ({
      item: { type: 'ad', name: 'Advertisement', uri: 'spotify:ad:spotify:1' },
      progress_ms: 5000,
      is_playing: true,
    }),
  });

  const out = text(await invoke(findTool(registered, 'get_currently_playing')));

  assert.match(out, /^Playing: "Advertisement" \(ad\)$/m);
  assert.match(out, /^Progress: 0:05 \/ unknown$/m);
  assert.doesNotMatch(out, /undefined/);
});

test('get_currently_playing renders an unknown item without a uri', async () => {
  const { registered } = makeHarness({
    getResponse: () => ({ item: { type: 'unknown' }, progress_ms: null, is_playing: false }),
  });

  const out = text(await invoke(findTool(registered, 'get_currently_playing')));

  assert.match(out, /^Paused: "Untitled" \(unknown\)$/m);
  assert.match(out, /^URI: unknown$/m);
  assert.doesNotMatch(out, /undefined/);
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

test('market input is normalised: lowercase is uppercased on the wire, non-2-letter codes rejected (#110)', () => {
  const { registered } = makeHarness();

  const nowPlaying = findTool(registered, 'get_now_playing');
  const parsed = nowPlaying.schema.market.safeParse('gb');
  assert.equal(parsed.success, true);
  assert.equal(parsed.data, 'GB');
  assert.equal(nowPlaying.schema.market.safeParse('USA').success, false);
  assert.equal(nowPlaying.schema.market.safeParse('g').success, false);
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

test('offset vs offset_uri without context_uri produce separate actionable errors (#110)', async () => {
  const { registered } = makeHarness();

  await assert.rejects(
    invoke(findTool(registered, 'play'), { offset_uri: 'spotify:track:trk9' }),
    /offset_uri requires a context_uri/,
  );
  await assert.rejects(
    invoke(findTool(registered, 'play'), { offset: 3 }),
    /offset requires a context_uri/,
  );
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

// #848: the surviving transfer tool takes a NAME-OR-ID `device` and resolves
// it, so a target that is not an exact id costs a device read first. The write
// itself is unchanged: one PUT, ids wrapped, `play` only when asked for.
/**
 * The one device the #848 transfer tests target.
 *
 * `resolveDeviceHint` matches an EXACT id without reading the sidecar, so a
 * single-entry list keeps these tests to a deterministic number of GETs: a
 * hint that needed the label step would add a disk read whose result depends on
 * whatever `~/.spotify-mcp` state the ambient environment holds.
 */
const TARGET_DEVICE = {
  id: 'dev2',
  name: 'Study',
  type: 'Computer',
  is_active: false,
  is_private_session: false,
  is_restricted: false,
  volume_percent: 42,
  supports_volume: true,
};

test('transfer_playback wraps the resolved device id in device_ids array', async () => {
  const { registered, calls } = makeHarness({ devices: { devices: [TARGET_DEVICE] } });

  const result = await invoke(findTool(registered, 'transfer_playback'), {
    device: 'dev2',
    play: true,
  });

  const put = calls.find((c) => c.method === 'PUT');
  assert.equal(put?.path, '/me/player');
  assert.deepEqual(put?.body, { device_ids: ['dev2'], play: true });
  assert.match(text(result), /Playback transferred to Study/);

  const { registered: r2, calls: c2 } = makeHarness({ devices: { devices: [TARGET_DEVICE] } });
  await invoke(findTool(r2, 'transfer_playback'), { device: 'dev2' });
  assert.deepEqual(c2.find((c) => c.method === 'PUT')?.body, { device_ids: ['dev2'] }); // play omitted when unset
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

// #855: a device whose `volume_percent` the API omits rendered as the literal
// "volume: undefined%" — a confident-looking number. Absent must read as absent.
test('get_devices never prints "undefined%" when a device omits volume_percent', async () => {
  const { registered } = makeHarness({
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
                supports_volume: true, // volume_percent key absent entirely
              },
              {
                id: 'dev2',
                name: 'TV',
                type: 'TV',
                is_active: false,
                is_private_session: false,
                is_restricted: false,
                supports_volume: false, // no volume concept at all
              },
            ],
          }
        : undefined,
  });

  const out = text(await invoke(findTool(registered, 'get_devices')));

  assert.doesNotMatch(out, /undefined/);
  assert.doesNotMatch(out, /%/); // no half-formed percentage anywhere
  assert.match(out, /• Living Room \(Computer\) \[ACTIVE\], volume: unknown — ID: dev1/);
  assert.match(out, /• TV \(TV\) — ID: dev2/);
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
    /\[dry run\] start playback on <<untrusted: spotify:album:alb1 >> — nothing was changed\./,
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
  assert.match(text(result), /\[dry run\] skip to next track on <<untrusted: the active device >>/);
});

test('add_to_queue dry_run validates track/episode URIs and previews without POSTing (#57)', async () => {
  const { registered, calls } = makeHarness();
  const result = await invoke(findTool(registered, 'add_to_queue'), {
    uri: 'spotify:episode:ep1',
    dry_run: true,
  });
  assert.equal(calls.length, 0);
  assert.match(text(result), /\[dry run\] add to queue on <<untrusted: spotify:episode:ep1 >>/);

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
  assert.match(text(result), /\[dry run\] start playback on <<untrusted: spotify:track:trk1 >>/);
});

// #848 changed what "no calls" can mean for this one: the target is now a
// NAME-or-ID that has to be resolved, so a dry run reads the device list. The
// claim #57 is protecting is that a preview writes nothing, so that is what is
// asserted. A device read is a GET, and a preview that PUT nothing cannot have
// moved playback — which is the harm the flag exists to prevent.
test('transfer_playback dry_run previews the move without PUT /me/player (#57)', async () => {
  const { registered, calls } = makeHarness({ devices: { devices: [TARGET_DEVICE] } });
  const result = await invoke(findTool(registered, 'transfer_playback'), {
    device: 'dev2',
    play: true,
    dry_run: true,
  });
  assert.deepEqual(
    calls.filter((c) => c.method !== 'GET'),
    [],
    'a dry run resolves its target and writes nothing',
  );
  assert.match(text(result), /\[dry run\] transfer playback on <<untrusted: Study \(dev2\) >>/);
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
    pagination: { total: number | null; next_offset: number | null };
  };
  assert.equal(sc.items.length, 3);
  // #110 finding 13: /me/player/queue has no paging — the snapshot must not
  // advertise a fake total or a next_offset.
  assert.equal(sc.pagination.total, null);
  assert.equal(sc.pagination.next_offset, null);
  assert.equal(sc.truncated, true);
  assert.equal(sc.remaining, 5);
});

// #848: the retired `handoff` forwards to `transfer_playback` with
// `preserve_position: true`, so this is the behaviour `handoff` had and the
// behaviour its name now buys. The forwarding itself is asserted in
// tests/tools.playback-collapse.test.ts; what is asserted HERE is that the
// surviving tool still produces the call sequence `handoff` promised.
test('transfer_playback with preserve_position transfers, resumes at offset, sets volume (issue #112)', async () => {
    const state = playbackStateFixture(trackFixture());
    const h = makeHarness({
      devices: { devices: [TARGET_DEVICE] },
      getResponse: (path) => (path === '/me/player' ? state : undefined),
    });

    await invoke(findTool(h.registered, 'transfer_playback'), {
      device: 'dev2',
      preserve_position: true,
      volume: 30,
    });

    const puts = h.calls.filter((c) => c.method === 'PUT');
    assert.equal(puts.length, 3, JSON.stringify(h.calls));
    assert.deepEqual(puts[0], { method: 'PUT', path: '/me/player', body: { device_ids: ['dev2'] } });
    assert.equal(puts[1].path, '/me/player/play?device_id=dev2');
    const playBody = puts[1].body as { position_ms: number };
    assert.equal(playBody.position_ms, 185000);
    assert.equal(puts[2].path, '/me/player/volume?volume_percent=30&device_id=dev2');
  });

// #830: Spotify declares volume_percent as the required query parameter; the
// `volume` spelling is silently rejected, so handoff reported a volume it
// never applied.
test('a preserved transfer normalizes volume with volume_percent, not volume (#830)', async () => {
  const h = makeHarness({
    devices: { devices: [TARGET_DEVICE] },
    getResponse: (path) => (path === '/me/player' ? playbackStateFixture(trackFixture()) : undefined),
  });

  await invoke(findTool(h.registered, 'transfer_playback'), {
    device: 'dev2',
    preserve_position: true,
    volume: 30,
  });

  const vol = h.calls.find((c) => c.method === 'PUT' && c.path.startsWith('/me/player/volume'));
  assert.ok(vol, 'the transfer must PUT the requested volume');
  const qs = new URLSearchParams(vol!.path.split('?')[1]);
  assert.equal(qs.get('volume_percent'), '30');
  assert.equal(qs.get('device_id'), 'dev2');
  assert.equal(qs.get('volume'), null, `Spotify does not accept \`volume\`: ${vol!.path}`);
});


test('a preserved transfer dry_run performs no mutations and lists the steps (issue #112)', async () => {
    const h = makeHarness({
      devices: { devices: [TARGET_DEVICE] },
      getResponse: (path) => (path === '/me/player' ? playbackStateFixture(trackFixture()) : undefined),
    });

    const out = text(
      await invoke(findTool(h.registered, 'transfer_playback'), {
        device: 'dev2',
        preserve_position: true,
        dry_run: true,
      }),
    );

    assert.deepEqual(
      h.calls.filter((c) => c.method !== 'GET'),
      [],
      'dry run reads the devices and the player, and writes nothing',
    );
    assert.match(out, /\[dry run\]/);
    assert.match(out, /Resume at 3:05 into/);
  });

// ------------------------------------------------- transfer plan parity (#841)

type WireCall = { method: string; path: string; body: unknown };

/** The dry-run payload's advertised plan, reduced to what a wire call is. */
function advertisedPlan(sc: Record<string, unknown>): WireCall[] {
  const plan = sc.plan as Array<{ method: string; path: string; body?: unknown }>;
  return plan.map((s) => ({ method: s.method, path: s.path, body: s.body ?? null }));
}

/** What the client actually observed on the committing call, minus the state read. */
function performedCalls(calls: Call[]): WireCall[] {
  return calls
    .filter((c) => c.method !== 'GET')
    .map((c) => ({ method: c.method, path: c.path, body: c.body ?? null }));
}

/**
 * #848 collapsed the four transfer tools onto `transfer_playback`, so the #841
 * plan-parity property now has to survive on the survivor. `preserve_position`
 * is on in every case because that is the mode the old `handoff` used and the
 * mode whose plan is non-trivial: it is the one with a resume step, and a
 * resume step is what a plan that disagrees with its commit would lie about.
 */
const PRESERVING = { device: 'dev2', preserve_position: true } as const;

async function planFor(state: unknown, args: Record<string, unknown> = {}) {
  const h = makeHarness({
    devices: { devices: [TARGET_DEVICE] },
    getResponse: (path) => (path === '/me/player' ? state : undefined),
  });
  const preview = await invoke(findTool(h.registered, 'transfer_playback'), {
    ...PRESERVING,
    ...args,
    dry_run: true,
  });
  return { h, sc: preview.structuredContent ?? {}, out: text(preview) };
}

async function commitFor(state: unknown, args: Record<string, unknown> = {}) {
  const h = makeHarness({
    devices: { devices: [TARGET_DEVICE] },
    getResponse: (path) => (path === '/me/player' ? state : undefined),
  });
  await invoke(findTool(h.registered, 'transfer_playback'), { ...PRESERVING, ...args });
  return h.calls;
}

// The preview and the commit are compared as OBSERVED: the plan comes from the
// dry-run payload, the execution from the client's recorded wire traffic. The
// two sides never share a helper, so a divergence in the tool is a failure
// here (#841).
for (const [label, state] of [
  ['playing', playbackStateFixture(trackFixture())],
  ['paused', { ...playbackStateFixture(trackFixture()), is_playing: false }],
  ['paused with a context', { ...playbackStateFixture(trackFixture()), is_playing: false, context: { uri: 'spotify:playlist:pl1' } }],
  ['playing with a context', { ...playbackStateFixture(trackFixture()), context: { uri: 'spotify:playlist:pl1' } }],
  ['paused at position zero', { ...playbackStateFixture(trackFixture()), is_playing: false, progress_ms: 0 }],
  ['nothing playing', { ...playbackStateFixture(null), is_playing: false, progress_ms: null, item: null }],
  ['playing with an empty item uri', { ...playbackStateFixture(trackFixture()), item: { uri: '' } }],
  ['paused with an empty item uri', { ...playbackStateFixture(trackFixture()), is_playing: false, item: { uri: '' } }],
] as Array<[string, unknown]>) {
  test(`preserving transfer dry-run plan equals the calls the commit performs (${label}, #841)`, async () => {
    const { h, sc, out } = await planFor(state, { volume: 30 });
    assert.deepEqual(
      h.calls.filter((c) => c.method !== 'GET'),
      [],
      'dry run performs no mutations',
    );

    const advertised = advertisedPlan(sc);

    // The advertised flag must agree with the plan it describes, or an agent
    // reading `will_resume` is told something the call list contradicts.
    assert.equal(
      sc.will_resume,
      advertised.some((c) => c.path.startsWith('/me/player/play')),
      'will_resume must be true exactly when the plan contains the play call',
    );
    assert.ok(advertised.length > 0, 'dry run must advertise a plan');
    assert.deepEqual(advertised, performedCalls(await commitFor(state, { volume: 30 })));

    // The plan is also readable as prose, and every line describes a real call.
    const planText = (sc.plan as Array<{ text: string }>).map((s) => s.text);
    for (const line of planText) assert.match(out, new RegExp(line.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    assert.equal(planText.length, advertised.length);
  });
}

test('a preserved transfer from a paused session advertises no resume and issues no play call (#841)', async () => {
  const paused = { ...playbackStateFixture(trackFixture()), is_playing: false };
  const { out, sc } = await planFor(paused);

  assert.equal(sc.will_resume, false);
  assert.equal(sc.was_playing, false);
  assert.doesNotMatch(out, /Resume at/);
  assert.doesNotMatch(out, /3:05/);

  const played = await commitFor(paused);
  assert.deepEqual(performedCalls(played), [
    { method: 'PUT', path: '/me/player', body: { device_ids: ['dev2'] } },
  ]);
});

test('preserved-transfer plans differ between paused and playing sessions in the promised direction (#841)', async () => {
  const playing = playbackStateFixture(trackFixture());
  const paused = { ...playing, is_playing: false };

  const playPlan = advertisedPlan((await planFor(playing)).sc);
  const pausePlan = advertisedPlan((await planFor(paused)).sc);

  assert.equal(playPlan.some((c) => c.path.startsWith('/me/player/play')), true);
  assert.equal(pausePlan.some((c) => c.path.startsWith('/me/player/play')), false);
  // The transfer is common to both; the resume is the only difference.
  assert.deepEqual(pausePlan, playPlan.slice(0, 1));

  const playCalls = performedCalls(await commitFor(playing));
  assert.equal(playCalls.filter((c) => c.path.startsWith('/me/player/play')).length, 1);
  assert.equal(performedCalls(await commitFor(paused)).filter((c) => c.path.startsWith('/me/player/play')).length, 0);
});

test('a preserved transfer with play:true resumes a paused session and the plan says so (#841)', async () => {
  const paused = { ...playbackStateFixture(trackFixture()), is_playing: false };
  const { out, sc } = await planFor(paused, { play: true });

  assert.equal(sc.will_resume, true);
  assert.match(out, /Resume at 3:05 into spotify:track:trk1/);
  assert.deepEqual(advertisedPlan(sc), performedCalls(await commitFor(paused, { play: true })));
});

test('a preserved transfer with play:false preserves the session state rather than forcing a stop (#841)', async () => {
  const playing = playbackStateFixture(trackFixture());
  const { sc } = await planFor(playing, { play: false });

  // `play` overrides a PAUSED session only; a running one is preserved either
  // way, and the plan still matches what the commit does.
  assert.equal(sc.will_resume, true);
  assert.deepEqual(advertisedPlan(sc), performedCalls(await commitFor(playing, { play: false })));
});

// #848: `play` is deliberately DROPPED from the transfer body when a position
// is being preserved, because the resume below is what starts playback and a
// `play: true` here would restart the very track the resume seeks into. Before
// the collapse these were two tools with two different bodies; after it they are
// one body, so the interaction is a claim the tool now has to keep.
test('preserving a position drops play from the transfer body but keeps it for a bare transfer', async () => {
  const state = playbackStateFixture(trackFixture());

  const preserved = makeHarness({
    devices: { devices: [TARGET_DEVICE] },
    getResponse: (path) => (path === '/me/player' ? state : undefined),
  });
  await invoke(findTool(preserved.registered, 'transfer_playback'), {
    device: 'dev2',
    play: true,
    preserve_position: true,
  });
  const preservePut = preserved.calls.find((c) => c.method === 'PUT' && c.path === '/me/player');
  assert.deepEqual(preservePut?.body, { device_ids: ['dev2'] });
  assert.ok(
    preserved.calls.some((c) => c.method === 'PUT' && c.path.startsWith('/me/player/play?')),
    'the resume is what starts playback in preserve mode',
  );

  const bare = makeHarness({ devices: { devices: [TARGET_DEVICE] } });
  await invoke(findTool(bare.registered, 'transfer_playback'), { device: 'dev2', play: true });
  assert.deepEqual(
    bare.calls.find((c) => c.method === 'PUT' && c.path === '/me/player')?.body,
    { device_ids: ['dev2'], play: true },
  );
});
