/**
 * Tests for #603 — resource query parameters, the audiobook/chapter resource
 * templates, and `spotify://player/devices`.
 *
 * The tests here are written to be able to fail. Two of them assert that a
 * resource read is *byte-identical* to the tool read it mirrors, which is the
 * acceptance criterion for #603 stated as a test rather than as prose: if the
 * two renderers drift, the strings stop matching and the test goes red. The
 * rest assert on the query parameters that actually reach the client, because
 * a parameter that parses correctly and is then dropped in transit is
 * invisible to any assertion made against the rendered output alone.
 *
 * Every test drives the real MCP SDK over `InMemoryTransport`, so template
 * routing is exercised the way a host exercises it — including the ordering
 * constraint that `spotify://audiobook/{id}{+qs}` would otherwise swallow
 * `spotify://audiobook/{id}/chapters`.
 */
import './helpers/hermetic.js';

import test from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { McpServer, ResourceTemplate } from '@modelcontextprotocol/sdk/server/mcp.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

import { registerResources } from '../src/resources/index.js';
import { registerTemplateResources } from '../src/resources/templates.js';
import { registerPlaybackTools } from '../src/tools/playback.js';
import { registerAudiobookTools } from '../src/tools/audiobooks.js';
import type { SpotifyClient } from '../src/client.js';

// ---------------------------------------------------------------- fixtures

type Call = { method: string; path: string; params?: Record<string, string> };

const artist = { id: 'art1', name: 'Queen', uri: 'spotify:artist:art1' };

const topTrack = (n: number) => ({
  id: `trk${n}`,
  name: `Track ${n}`,
  uri: `spotify:track:trk${n}`,
  type: 'track' as const,
  duration_ms: 200_000 + n,
  explicit: false,
  artists: [artist],
  album: { id: 'alb1', name: 'A Night at the Opera', uri: 'spotify:album:alb1', images: [] },
});

const topTracksPage = (count: number, total = 50, offset = 0) => ({
  items: Array.from({ length: count }, (_, i) => topTrack(offset + i + 1)),
  total,
  limit: count,
  offset,
  next: null,
});

const topArtistsPage = (count: number, total = 50, offset = 0) => ({
  items: Array.from({ length: count }, (_, i) => ({
    id: `art${offset + i + 1}`,
    name: `Artist ${offset + i + 1}`,
    uri: `spotify:artist:art${offset + i + 1}`,
    genres: ['rock'],
  })),
  total,
  limit: count,
  offset,
  next: null,
});

const audiobookFull = {
  id: 'bk1',
  name: 'A Long Book',
  uri: 'spotify:audiobook:bk1',
  authors: [{ name: 'An Author' }],
  narrators: [{ name: 'A Narrator' }],
  media_type: 'audio',
  // Feb-2026 removed `publisher`; #639 says fall back to the edition rather
  // than print "Unknown publisher".
  edition: 'Unabridged',
  total_chapters: 2,
  languages: ['en'],
  explicit: false,
  description: 'A book with chapters.',
  html_description: '<p>A book with chapters.</p>',
  images: [],
  copyrights: [],
  chapters: {
    total: 2,
    items: [
      {
        id: 'ch1',
        name: 'Chapter One',
        uri: 'spotify:chapter:ch1',
        chapter_number: 1,
        duration_ms: 1_800_000,
        release_date: '2026-01-01',
        explicit: false,
        description: 'The first chapter.',
        is_playable: true,
      },
    ],
  },
};

const chapterFull = {
  id: 'ch1',
  name: 'Chapter One',
  uri: 'spotify:chapter:ch1',
  chapter_number: 1,
  duration_ms: 1_800_000,
  release_date: '2026-01-01',
  explicit: false,
  description: 'The first chapter.',
  is_playable: true,
  html_description: '<p>The first chapter.</p>',
  languages: ['en'],
  images: [],
  resume_point: { fully_played: false, resume_position_ms: 600_000 },
};

const devicesResponse = {
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
      // #855: omitted on some devices, null on others. Never print 0 or
      // "undefined%"; a volume-capable device says `unknown`.
      volume_percent: null,
      supports_volume: true,
    },
    {
      id: 'dev3',
      name: 'TV',
      type: 'TV',
      is_active: false,
      is_private_session: false,
      is_restricted: false,
      supports_volume: false,
    } as unknown as { volume_percent: number | null },
  ],
};

interface StubOptions {
  getResponse?: (path: string, params?: Record<string, string>) => unknown;
  getAllPagesResponse?: (path: string) => unknown[];
}

/**
 * A recording stub. `getResponse` is consulted by path, so a test that
 * asserts on `calls` is asserting on what production actually sent.
 */
function makeClientStub(opts: StubOptions = {}): { client: SpotifyClient; calls: Call[] } {
  const calls: Call[] = [];
  const stub = {
    get: async (path: string, params?: Record<string, string>) => {
      calls.push(params === undefined ? { method: 'GET', path } : { method: 'GET', path, params });
      return opts.getResponse?.(path, params);
    },
    getAllPages: async (path: string) => opts.getAllPagesResponse?.(path) ?? [],
    getAllPagesWithTruncation: async (path: string) => ({
      items: opts.getAllPagesResponse?.(path) ?? [],
      truncated: false,
      truncatedByCap: false,
      reportedTotal: null,
    }),
    getRateLimitStatus: () => ({
      lastThrottleAt: null as number | null,
      retryAfterSec: null as number | null,
      cooldownRemainingMs: 0,
    }),
  };
  return { client: stub as unknown as SpotifyClient, calls };
}

async function connect(client: SpotifyClient, withTools = false): Promise<Client> {
  const server = new McpServer({ name: 'test', version: '0.0.0' });
  registerResources(server, client);
  registerTemplateResources(server, client);
  if (withTools) {
    registerPlaybackTools(server, client);
    registerAudiobookTools(server, client);
  }
  const mcpClient = new Client({ name: 'tester', version: '0.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(clientTransport), mcpClient.connect(serverTransport)]);
  return mcpClient;
}

function content(result: { contents: Array<{ mimeType: string; text: string }> }): {
  mimeType: string;
  text: string;
} {
  return result.contents[0];
}

function toolText(message: { content: Array<{ type: string; text?: string }> }): string {
  return message.content[0]?.text ?? '';
}

/** Rows of a device listing — the lines the two surfaces must agree on. */
function deviceRows(text: string): string[] {
  return text.split('\n').filter((line) => line.startsWith('• '));
}

// ------------------------------------------------- 1. top-items parameters

test('top tracks: ?time_range&limit reach the client and the prose reports them (#603)', async () => {
  const { client, calls } = makeClientStub({
    getResponse: (path) => (path === '/me/top/tracks' ? topTracksPage(5, 50) : undefined),
  });
  const mcp = await connect(client);

  const prose = content(await mcp.readResource({ uri: 'spotify://me/top/tracks?time_range=short_term&limit=5' }));

  // The parameters must reach Spotify, not just be echoed in the prose. This
  // is the assertion that fails if parsing happens and the result is dropped.
  assert.equal(calls.length, 1);
  assert.equal(calls[0].path, '/me/top/tracks');
  assert.equal(calls[0].params?.time_range, 'short_term');
  assert.equal(calls[0].params?.limit, '5');
  assert.equal(calls[0].params?.offset, '0');

  assert.match(prose.text, /short_term/);
  const rows = prose.text.split('\n').filter((line) => line.startsWith('  '));
  assert.equal(rows.length, 5);
  assert.match(rows[0], /"Track 1" by Queen \(3:20\)/);
});

test('top tracks: ?format=json echoes exactly the items the prose read', async () => {
  const { client } = makeClientStub({
    getResponse: (path) => (path === '/me/top/tracks' ? topTracksPage(5, 50) : undefined),
  });
  const mcp = await connect(client);

  const raw = content(await mcp.readResource({ uri: 'spotify://me/top/tracks?time_range=short_term&limit=5&format=json' }));
  assert.equal(raw.mimeType, 'application/json');
  const payload = JSON.parse(raw.text);
  assert.equal(payload.items.length, 5);
  assert.deepEqual(
    payload.items.map((t: { name: string }) => t.name),
    ['Track 1', 'Track 2', 'Track 3', 'Track 4', 'Track 5'],
  );
});

test('top tracks: the bare URI still defaults to the documented medium_term/20/0 window', async () => {
  const { client, calls } = makeClientStub({
    getResponse: (path) => (path === '/me/top/tracks' ? topTracksPage(20) : undefined),
  });
  const mcp = await connect(client);

  const prose = content(await mcp.readResource({ uri: 'spotify://me/top/tracks' }));
  assert.equal(calls[0].params?.time_range, 'medium_term');
  assert.equal(calls[0].params?.limit, '20');
  assert.equal(calls[0].params?.offset, '0');
  assert.match(prose.text, /medium_term/);
});

test('top tracks: ?offset shifts the window and the prose numbers rows from it', async () => {
  const { client, calls } = makeClientStub({
    getResponse: (path, params) =>
      path === '/me/top/tracks' ? topTracksPage(2, 50, Number(params?.offset ?? 0)) : undefined,
  });
  const mcp = await connect(client);

  const prose = content(await mcp.readResource({ uri: 'spotify://me/top/tracks?limit=2&offset=20' }));
  assert.equal(calls[0].params?.offset, '20');
  // Row numbering is absolute, not relative to the page — a host stitching
  // pages together needs one sequence, not one per page.
  assert.match(prose.text, /21\. "Track 21"/);
  assert.match(prose.text, /22\. "Track 22"/);
  assert.match(prose.text, /at offset 20/);
});

test('top tracks: an out-of-range limit is bounded, not forwarded raw (#603)', async () => {
  const { client, calls } = makeClientStub({
    getResponse: (path) => (path === '/me/top/tracks' ? topTracksPage(50) : undefined),
  });
  const mcp = await connect(client);

  await mcp.readResource({ uri: 'spotify://me/top/tracks?limit=9999' });
  // 9999 is not a Spotify page size; the OpenAPI maximum is 50.
  assert.equal(calls[0].params?.limit, '50');
});

test('top tracks: an unrecognised time_range falls back rather than 400-ing (#603)', async () => {
  const { client, calls } = makeClientStub({
    getResponse: (path) => (path === '/me/top/tracks' ? topTracksPage(20) : undefined),
  });
  const mcp = await connect(client);

  await mcp.readResource({ uri: 'spotify://me/top/tracks?time_range=last_decade' });
  // Spotify rejects an unknown time_range with a 400. Forwarding the typo
  // would turn a resource read into an error; the default still answers.
  assert.equal(calls[0].params?.time_range, 'medium_term');
});

test('top artists: the same three parameters reach the client (#603)', async () => {
  const { client, calls } = makeClientStub({
    getResponse: (path, params) =>
      path === '/me/top/artists' ? topArtistsPage(3, 30, Number(params?.offset ?? 0)) : undefined,
  });
  const mcp = await connect(client);

  const prose = content(await mcp.readResource({ uri: 'spotify://me/top/artists?time_range=long_term&limit=3&offset=6' }));
  assert.equal(calls[0].path, '/me/top/artists');
  assert.deepEqual(calls[0].params, { time_range: 'long_term', limit: '3', offset: '6' });
  assert.match(prose.text, /long_term/);
  assert.match(prose.text, /7\. Artist 7/);
});

test('top items: a full page says more is available rather than reading as the whole list', async () => {
  const { client } = makeClientStub({
    getResponse: (path) => (path === '/me/top/tracks' ? topTracksPage(5, 50) : undefined),
  });
  const mcp = await connect(client);

  const prose = content(await mcp.readResource({ uri: 'spotify://me/top/tracks?limit=5' }));
  assert.match(prose.text, /more available — re-read with \?offset=5/);
});

// ------------------------------------------ 2. recently-played is a cursor

test('recently-played: ?limit and ?after reach the client; ?offset is never sent (#603)', async () => {
  const { client, calls } = makeClientStub({
    getResponse: (path) =>
      path === '/me/player/recently-played'
        ? {
            items: [
              {
                track: topTrack(1),
                played_at: '2026-09-01T12:00:00.000Z',
              },
            ],
            cursors: { after: 'x', before: 'y' },
            limit: 1,
          }
        : undefined,
  });
  const mcp = await connect(client);

  await mcp.readResource({ uri: 'spotify://me/recently-played?limit=1&after=1756728000000' });
  assert.equal(calls[0].params?.limit, '1');
  assert.equal(calls[0].params?.after, '1756728000000');
  // GET /me/player/recently-played declares limit/after/before and NO offset.
  // Spotify 400s an undeclared query parameter, so `offset` must never appear.
  assert.equal('offset' in (calls[0].params ?? {}), false);
});

test('recently-played: a full page names the next cursor instead of claiming the end', async () => {
  const { client } = makeClientStub({
    getResponse: (path) =>
      path === '/me/player/recently-played'
        ? {
            items: [
              { track: topTrack(1), played_at: '2026-09-02T12:00:00.000Z' },
              { track: topTrack(2), played_at: '2026-09-01T12:00:00.000Z' },
            ],
            cursors: { after: 'x', before: 'y' },
            limit: 2,
          }
        : undefined,
  });
  const mcp = await connect(client);

  const prose = content(await mcp.readResource({ uri: 'spotify://me/recently-played?limit=2' }));
  // The forward cursor is the OLDEST played_at on the page, not the newest.
  assert.match(prose.text, /\?after=2026-09-01T12:00:00\.000Z|page further back with \?after=\d+/);
});

// ------------------------------------------- 3. saved-library paged windows

test('saved albums: ?limit&offset reads one page and does not claim a cap truncation (#603)', async () => {
  const albumItem = (n: number) => ({
    added_at: '2026-01-01T00:00:00Z',
    album: {
      id: `alb${n}`,
      name: `Album ${n}`,
      uri: `spotify:album:alb${n}`,
      release_date: '1975-01-01',
      total_tracks: 12,
      artists: [artist],
    },
  });
  const { client, calls } = makeClientStub({
    getResponse: (path, params) =>
      path === '/me/albums'
        ? {
            items: [albumItem(Number(params?.offset ?? 0) + 1), albumItem(Number(params?.offset ?? 0) + 2)],
            total: 40,
            limit: Number(params?.limit ?? 2),
            offset: Number(params?.offset ?? 0),
            next: 'https://api.spotify.com/v1/me/albums?offset=2',
          }
        : undefined,
    // The walk must NOT run when a window is asked for: a windowed read is a
    // page, and walking it would be the thing the prose claims it is not.
    getAllPagesResponse: () => {
      throw new Error('walk must not run for a windowed saved-albums read');
    },
  });
  const mcp = await connect(client);

  const prose = content(await mcp.readResource({ uri: 'spotify://me/saved/albums?limit=2&offset=4' }));
  assert.ok(calls.every((c) => c.path === '/me/albums'), 'no other endpoint may be read');
  assert.equal(calls[0].params?.limit, '2');
  assert.equal(calls[0].params?.offset, '4');
  assert.match(prose.text, /2 of 40, at offset 4/);
  assert.match(prose.text, /more available — re-read with \?offset=6/);
  // A page is not a truncated walk, so it must not borrow the #718 disclosure.
  assert.doesNotMatch(prose.text, /SPOTIFY_MCP_FETCH_ALL_CAP/);
});

test('saved audiobooks: ?limit&offset reads one page instead of walking (#603)', async () => {
  const row = (n: number) => ({
    added_at: '2026-02-02T00:00:00Z',
    audiobook: { id: `bk${n}`, name: `Book ${n}`, uri: `spotify:audiobook:bk${n}`, authors: [{ name: 'An Author' }] },
  });
  const { client, calls } = makeClientStub({
    getResponse: (path, params) =>
      path === '/me/audiobooks'
        ? {
            items: [row(Number(params?.offset ?? 0) + 1)],
            total: 12,
            limit: 1,
            offset: Number(params?.offset ?? 0),
            next: null,
          }
        : undefined,
    getAllPagesResponse: () => {
      throw new Error('walk must not run for a windowed saved-audiobooks read');
    },
  });
  const mcp = await connect(client);

  const prose = content(await mcp.readResource({ uri: 'spotify://me/saved/audiobooks?limit=1&offset=3' }));
  assert.ok(calls.every((c) => c.path === '/me/audiobooks'));
  assert.equal(calls[0].params?.offset, '3');
  assert.match(prose.text, /1 of 12, at offset 3/);
  assert.doesNotMatch(prose.text, /SPOTIFY_MCP_FETCH_ALL_CAP/);
});

test('saved albums: with no parameters the capped walk is still the default (#603)', async () => {
  const { client, calls } = makeClientStub({
    getAllPagesResponse: (path) =>
      path === '/me/albums'
        ? [
            {
              added_at: '2026-01-01T00:00:00Z',
              album: {
                id: 'alb1',
                name: 'A Night at the Opera',
                uri: 'spotify:album:alb1',
                release_date: '1975-10-31',
                total_tracks: 12,
                artists: [artist],
              },
            },
          ]
        : [],
  });
  const mcp = await connect(client);

  const prose = content(await mcp.readResource({ uri: 'spotify://me/saved/albums' }));
  // The walk is the reading that carries the #718 cap verdict, so it stays the
  // default; this assertion fails if the windowed path silently takes over.
  assert.equal(calls.length, 0, 'a bare read must walk, not make a single GET');
  assert.match(prose.text, /Saved albums \(1\)/);
});

// ------------------------------------------------ 4. player devices resource

test('spotify://player/devices lists the same device rows as get_devices (#603)', async () => {
  const { client } = makeClientStub({
    getResponse: (path) => (path === '/me/player/devices' ? devicesResponse : undefined),
  });
  const mcp = await connect(client, true);

  const toolOut = toolText(
    await mcp.callTool({ name: 'get_devices', arguments: { response_format: 'concise' } }),
  );
  const resourceOut = content(await mcp.readResource({ uri: 'spotify://player/devices' })).text;

  // Field-for-field: the rows are the same strings, produced by the same
  // deviceLine(). If either surface re-derives the #855 volume read, this
  // deepEqual is what notices.
  assert.deepEqual(deviceRows(resourceOut), deviceRows(toolOut));
  assert.equal(deviceRows(resourceOut).length, 3);
  assert.match(resourceOut, /• Living Room \(Computer\) \[ACTIVE\], volume: 42% — ID: dev1/);
  // volume_percent: null on a volume-capable device is `unknown`, not 0% and
  // not "undefined%".
  assert.match(resourceOut, /• Speaker \(Speaker\), volume: unknown — ID: n\/a/);
  // A device that cannot report volume at all says nothing about volume.
  assert.match(resourceOut, /• TV \(TV\) — ID: dev3/);
  assert.doesNotMatch(resourceOut, /undefined%/);
});

test('spotify://player/devices names the active device explicitly (#603)', async () => {
  const { client } = makeClientStub({
    getResponse: (path) => (path === '/me/player/devices' ? devicesResponse : undefined),
  });
  const mcp = await connect(client);

  const prose = content(await mcp.readResource({ uri: 'spotify://player/devices' })).text;
  assert.match(prose, /Active device: Living Room \(Computer\) — ID: dev1/);
});

test('spotify://player/devices with no active device says so (#603)', async () => {
  const noneActive = {
    devices: [{ ...devicesResponse.devices[1], is_active: false }],
  };
  const { client } = makeClientStub({
    getResponse: (path) => (path === '/me/player/devices' ? noneActive : undefined),
  });
  const mcp = await connect(client);

  const prose = content(await mcp.readResource({ uri: 'spotify://player/devices' })).text;
  assert.match(prose, /No active device/);
});

test('spotify://player/devices reports the empty case and its ?format=json twin (#603)', async () => {
  const { client } = makeClientStub({
    getResponse: (path) => (path === '/me/player/devices' ? { devices: [] } : undefined),
  });
  const mcp = await connect(client);

  const empty = content(await mcp.readResource({ uri: 'spotify://player/devices' }));
  assert.match(empty.text, /No devices found/);

  const { client: client2 } = makeClientStub({
    getResponse: (path) => (path === '/me/player/devices' ? devicesResponse : undefined),
  });
  const mcp2 = await connect(client2);
  const raw = content(await mcp2.readResource({ uri: 'spotify://player/devices?format=json' }));
  assert.equal(raw.mimeType, 'application/json');
  assert.deepEqual(JSON.parse(raw.text), devicesResponse);
});

// --------------------------------------------- 5. audiobook/chapter templates

test('spotify://audiobook/{id} renders byte-identically to get_audiobook (#603)', async () => {
  const { client } = makeClientStub({
    getResponse: (path) => (path === '/audiobooks/bk1' ? audiobookFull : undefined),
  });
  const mcp = await connect(client, true);

  const toolOut = toolText(
    await mcp.callTool({ name: 'get_audiobook', arguments: { id: 'bk1', market: 'US', response_format: 'concise' } }),
  );
  const resourceOut = content(await mcp.readResource({ uri: 'spotify://audiobook/bk1?market=US' })).text;

  // The resource and the tool are the same renderer (src/audiobookview.ts), so
  // this is a string equality, not a field-by-field spot check.
  assert.equal(resourceOut, toolOut);
  // #639: no "Unknown publisher" — the edition carries the credit line.
  assert.doesNotMatch(resourceOut, /Unknown publisher/);
  assert.match(resourceOut, /Unabridged \| 2 chapters/);
});

test('spotify://audiobook/{id} passes ?market through and serves its json twin (#603)', async () => {
  const { client, calls } = makeClientStub({
    getResponse: (path) => (path === '/audiobooks/bk1' ? audiobookFull : undefined),
  });
  const mcp = await connect(client);

  const raw = content(await mcp.readResource({ uri: 'spotify://audiobook/bk1?market=GB&format=json' }));
  assert.equal(calls[0].params?.market, 'GB');
  assert.equal(raw.mimeType, 'application/json');
  assert.deepEqual(JSON.parse(raw.text), audiobookFull);
});

test('spotify://audiobook/{id} omits market entirely when none is asked for', async () => {
  const { client, calls } = makeClientStub({
    getResponse: (path) => (path === '/audiobooks/bk1' ? audiobookFull : undefined),
  });
  const mcp = await connect(client);

  await mcp.readResource({ uri: 'spotify://audiobook/bk1' });
  assert.equal(calls[0].path, '/audiobooks/bk1');
  // Sending `market: undefined` upstream would be a different request; the
  // templates pass no second argument when there is no market.
  assert.equal(calls[0].params, undefined);
});

test('spotify://audiobook/{id}/chapters routes to the chapters endpoint, not the bare one (#603)', async () => {
  // This is the ordering constraint: registered after `spotify://audiobook/{id}`,
  // that pair's `{+qs}` twin compiles to `(.+)` and swallows the nested URI.
  const { client, calls } = makeClientStub({
    getResponse: (path) =>
      path === '/audiobooks/bk1/chapters'
        ? {
            items: [audiobookFull.chapters.items[0]],
            total: 2,
            limit: 20,
            offset: 0,
            next: 'https://api.spotify.com/v1/audiobooks/bk1/chapters?offset=1',
          }
        : path === '/audiobooks/bk1'
          ? audiobookFull
          : undefined,
  });
  const mcp = await connect(client);

  const prose = content(await mcp.readResource({ uri: 'spotify://audiobook/bk1/chapters' })).text;
  assert.equal(calls[0].path, '/audiobooks/bk1/chapters');
  assert.equal(calls[0].params?.limit, '20');
  assert.equal(calls[0].params?.offset, '0');
  assert.match(prose, /Chapters for audiobook bk1 \(2 total, showing 1 at offset 0\)/);
  assert.match(prose, /1\. "Chapter One" \(30:00, 2026-01-01\) \| URI: spotify:chapter:ch1/);
  assert.match(prose, /more available — re-read with \?offset=1/);
});

test('spotify://audiobook/{id}/chapters honours ?limit and ?offset (#603)', async () => {
  const { client, calls } = makeClientStub({
    getResponse: (path) =>
      path === '/audiobooks/bk1/chapters'
        ? { items: [], total: 2, limit: 5, offset: 10, next: null }
        : undefined,
  });
  const mcp = await connect(client);

  const prose = content(await mcp.readResource({ uri: 'spotify://audiobook/bk1/chapters?limit=5&offset=10' }));
  assert.equal(calls[0].params?.limit, '5');
  assert.equal(calls[0].params?.offset, '10');
  assert.match(prose.text, /No chapters found at offset 10/);
});

test('spotify://audiobook/{id}/chapters bounds limit to the API maximum (#603)', async () => {
  const { client, calls } = makeClientStub({
    getResponse: (path) =>
      path === '/audiobooks/bk1/chapters'
        ? { items: [], total: 0, limit: 50, offset: 0, next: null }
        : undefined,
  });
  const mcp = await connect(client);

  await mcp.readResource({ uri: 'spotify://audiobook/bk1/chapters?limit=500' });
  assert.equal(calls[0].params?.limit, '50');
});

test('spotify://chapter/{id} renders byte-identically to get_chapter (#603)', async () => {
  const { client } = makeClientStub({
    getResponse: (path) => (path === '/chapters/ch1' ? chapterFull : undefined),
  });
  const mcp = await connect(client, true);

  const toolOut = toolText(
    await mcp.callTool({ name: 'get_chapter', arguments: { id: 'ch1', market: 'US', response_format: 'concise' } }),
  );
  const resourceOut = content(await mcp.readResource({ uri: 'spotify://chapter/ch1?market=US' })).text;
  assert.equal(resourceOut, toolOut);
  assert.match(resourceOut, /Resume point: Resume at 10:00/);
});

test('spotify://chapter/{id} serves its json twin (#603)', async () => {
  const { client } = makeClientStub({
    getResponse: (path) => (path === '/chapters/ch1' ? chapterFull : undefined),
  });
  const mcp = await connect(client);

  const raw = content(await mcp.readResource({ uri: 'spotify://chapter/ch1?format=json' }));
  assert.equal(raw.mimeType, 'application/json');
  assert.deepEqual(JSON.parse(raw.text), chapterFull);
});

// ------------------------------------- 6. surface + description obligations

test('the new resources and templates are in resources/list and templates/list (#603)', async () => {
  const { client } = makeClientStub();
  const mcp = await connect(client);

  const uris = (await mcp.listResources()).resources.map((r) => r.uri);
  assert.ok(uris.includes('spotify://player/devices'), 'player/devices must be a listed fixed resource');

  const templates = (await mcp.listResourceTemplates()).resourceTemplates.map((t) => t.uriTemplate);
  for (const pattern of [
    'spotify://audiobook/{id}',
    'spotify://audiobook/{id}{+qs}',
    'spotify://audiobook/{id}/chapters',
    'spotify://audiobook/{id}/chapters{+qs}',
    'spotify://chapter/{id}',
    'spotify://chapter/{id}{+qs}',
  ]) {
    assert.ok(templates.includes(pattern), `missing template ${pattern}`);
  }
  for (const pattern of [
    'spotify://me/top/tracks{?format,time_range,limit,offset}',
    'spotify://me/top/artists{?format,time_range,limit,offset}',
    'spotify://me/recently-played{?format,limit,after,before}',
    'spotify://me/saved/albums{?format,limit,offset}',
  ]) {
    assert.ok(templates.includes(pattern), `missing parameterised template ${pattern}`);
  }
});

test('each new resource declares its format twin and its parameter set in its description (#603)', async () => {
  const { client } = makeClientStub();
  const mcp = await connect(client);

  const resources = (await mcp.listResources()).resources;
  const templates = (await mcp.listResourceTemplates()).resourceTemplates;
  const described = [
    ...resources.map((r) => ({ uri: r.uri, description: r.description ?? '' })),
    ...templates.map((t) => ({ uri: t.uriTemplate, description: t.description ?? '' })),
  ];

  // Every parameterized fixed resource: both entries (the bare URI and each
  // registered template) name the parameters. A parameter documented only on
  // the bare entry does not reach a host reading the template entry.
  for (const uri of [
    'spotify://me/top/tracks',
    'spotify://me/top/tracks{?format,time_range,limit,offset}',
    'spotify://me/top/tracks{+qs}',
    'spotify://me/top/artists{?format,time_range,limit,offset}',
    'spotify://me/recently-played{?format,limit,after,before}',
    'spotify://me/saved/albums{?format,limit,offset}',
    'spotify://audiobook/{id}',
    'spotify://audiobook/{id}{+qs}',
    'spotify://audiobook/{id}/chapters',
    'spotify://audiobook/{id}/chapters{+qs}',
    'spotify://chapter/{id}',
    'spotify://chapter/{id}{+qs}',
  ]) {
    const entry = described.find((d) => d.uri === uri);
    assert.ok(entry, `no listing entry for ${uri}`);
    assert.match(entry.description, /format=json/, `${uri} must document its ?format=json twin`);
    assert.match(entry.description, /Parameters: \?/, `${uri} must document its parameter set`);
  }
});

test('a bounded parameter states its bound, not just its name (#603, #883)', async () => {
  const { client } = makeClientStub();
  const mcp = await connect(client);

  const described = [
    ...(await mcp.listResources()).resources,
    ...(await mcp.listResourceTemplates()).resourceTemplates,
  ].map((e) => ({ uri: 'uri' in e ? e.uri : e.uriTemplate, description: e.description ?? '' }));

  // A parameter named without its bound is the #883 failure on the resource
  // surface. These reads NORMALISE rather than fail: `?limit=999` clamps to 50
  // and `?time_range=all_time` silently reads medium_term. A caller that
  // guessed the bound gets a different window than it asked for and no error
  // says so — so the bound has to be readable before the URI is built.
  //
  // The `[^)]*` guards are what make this test able to fail: a bare
  // `?limit` followed by an unrelated parenthetical elsewhere in the sentence
  // would otherwise satisfy a naive /\?limit/ match, and the whole assertion
  // would be decoration.
  const claims: readonly [string, RegExp][] = [
    ['?limit', /\?limit \(1-50, default 20/],
    ['?offset', /\?offset \(zero-based, default 0/],
    ['?time_range', /\?time_range \(long_term \| medium_term \| short_term/],
    ['?after', /\?after \(Unix epoch milliseconds/],
    ['?before', /\?before \(Unix epoch milliseconds/],
  ];

  for (const uri of [
    'spotify://me/top/tracks',
    'spotify://me/top/tracks{+qs}',
    'spotify://me/top/artists',
    'spotify://me/top/artists{+qs}',
    'spotify://me/recently-played',
    'spotify://me/recently-played{+qs}',
    'spotify://me/saved/albums',
    'spotify://me/saved/albums{+qs}',
    'spotify://me/saved/tracks',
    'spotify://me/saved/tracks{+qs}',
  ]) {
    const entry = described.find((d) => d.uri === uri);
    assert.ok(entry, `no listing entry for ${uri}`);
    for (const [param, bound] of claims) {
      // Only assert a bound for a parameter this entry actually advertises.
      if (!entry.description.includes(param)) continue;
      assert.match(
        entry.description,
        bound,
        `${uri} advertises ${param} without stating its bound`,
      );
    }
  }

  // And the enum resource must not merely list a parameter name: an
  // unrecognised window is rewritten to medium_term, so the legal values and
  // the fallback are both load-bearing.
  const topTracks = described.find((d) => d.uri === 'spotify://me/top/tracks');
  assert.match(topTracks!.description, /default medium_term/);
  assert.match(topTracks!.description, /any other value reads medium_term/);
});

test('an unrecognised query parameter still routes, via the {+qs} catch-all (#603)', async () => {
  const { client } = makeClientStub({
    getResponse: (path) => (path === '/me/top/tracks' ? topTracksPage(20) : undefined),
  });
  const mcp = await connect(client);

  // RFC 6570 form-style operators match only the parameters they name, so
  // without the catch-all this read would find no route at all.
  const prose = content(await mcp.readResource({ uri: 'spotify://me/top/tracks?campaign=spring' }));
  assert.match(prose.text, /Top tracks/);
});

test('the {+qs} catch-all is the routing mechanism, not a belt-and-braces twin (#603)', async () => {
  // This pins an SDK behaviour the whole design rests on, and it is stricter
  // than RFC 6570. `UriTemplate.match` compiles `{?a,b,c}` to a CONJUNCTIVE,
  // ORDERED regex:
  //
  //   ^spotify://me/top/tracks\?format=([^&]+)&time_range=([^&]+)&limit=([^&]+)&offset=([^&]+)$
  //
  // so every named parameter must be present AND in declaration order. A
  // realistic read — `?time_range=short_term&limit=5` — matches neither that
  // template nor the bare URI. `{+qs}` compiles to `(.+)` and is the only
  // thing that routes it. If a future SDK relaxes this to true RFC 6570, this
  // test goes red and says so, rather than the difference going unnoticed.
  // The SDK's own ResourceTemplate wraps the same UriTemplate, so this probes
  // the matcher the server actually routes with, through its public export.
  const matcher = (tpl: string, uri: string): unknown =>
    new ResourceTemplate(tpl, { list: undefined }).uriTemplate.match(uri);

  assert.equal(matcher('spotify://me/top/tracks{?format,time_range,limit,offset}', 'spotify://me/top/tracks?time_range=short_term&limit=5'), null);
  // It matches only the full, in-order set.
  assert.ok(matcher('spotify://me/top/tracks{?format,time_range,limit,offset}', 'spotify://me/top/tracks?format=json&time_range=short_term&limit=5&offset=0'));

  assert.ok(matcher('spotify://me/top/tracks{+qs}', 'spotify://me/top/tracks?time_range=short_term&limit=5'));

  // Consequence for the pre-existing saved-tracks registration, which
  // advertises `{?format,offset,limit}` and relies on its own `{+qs}` twin:
  assert.equal(matcher('spotify://me/saved/tracks{?format,offset,limit}', 'spotify://me/saved/tracks?offset=4&limit=2'), null);
  assert.ok(matcher('spotify://me/saved/tracks{+qs}', 'spotify://me/saved/tracks?offset=4&limit=2'));
});

test('the resource renderers are the same functions the tools call (#603)', async () => {
  // Guards the reuse requirement structurally: if someone re-inlines a field
  // read in the resource, the two copies drift and the byte-equality tests
  // above go red. This test names the shared modules so the coupling is
  // explicit rather than implied.
  const devices = await import('../src/devices.js');
  const view = await import('../src/audiobookview.js');
  assert.equal(typeof devices.deviceLine, 'function');
  assert.equal(typeof devices.DEVICES_EMPTY_MESSAGE, 'string');
  assert.equal(typeof view.audiobookDetailLines, 'function');
  assert.equal(typeof view.chapterDetailLines, 'function');
  assert.equal(typeof view.chapterListLine, 'function');

  // And the device row honours the #855 guard in the one place it is written.
  assert.equal(
    devices.deviceLine({
      id: 'd', name: 'N', type: 'T', is_active: false,
      is_private_session: false, is_restricted: false,
      supports_volume: true,
    } as never),
    '• N (T), volume: unknown — ID: d',
  );
});
