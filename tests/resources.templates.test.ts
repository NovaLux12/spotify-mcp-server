/**
 * Tests for src/resources/templates.ts (#111 pattern 2):
 *
 *  - template registration inventory (5 base patterns + {+qs} twins)
 *  - URI parsing: valid ids route to the right API path; malformed URIs error
 *  - prose vs ?format=json rendering per template through real SDK routing
 *  - artist-albums pagination respects the Feb-2026 cap (limit=10/page,
 *    ≤5 pages) and surfaces a truncation footer
 *  - ?market passthrough for show/episode single-get endpoints
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

import { registerTemplateResources } from '../src/resources/templates.js';
import type { SpotifyClient } from '../src/client.js';
import type {
  SpotifyArtistFull,
  SpotifyAlbumItem,
  SpotifyAlbumFull,
  SpotifyShowFull,
  SpotifyEpisodeFull,
} from '../src/types/spotify.js';

// ---------------------------------------------------------------- fixtures

type Call = { method: string; path: string; params?: Record<string, string> };

const artistFull: SpotifyArtistFull = { id: 'art1', name: 'Queen', uri: 'spotify:artist:art1', genres: [] };

const albumItem = (n: number): SpotifyAlbumItem => ({
  id: `alb${n}`,
  name: `Album ${n}`,
  uri: `spotify:album:alb${n}`,
  album_type: 'album',
  release_date: '1975-01-01',
  total_tracks: 12,
  artists: [{ id: 'art1', name: 'Queen', uri: 'spotify:artist:art1' }],
  images: [],
});

const albumFull: SpotifyAlbumFull = {
  id: 'alb1',
  name: 'A Night at the Opera',
  uri: 'spotify:album:alb1',
  album_type: 'album',
  release_date: '1975-11-21',
  total_tracks: 12,
  artists: [{ id: 'art1', name: 'Queen', uri: 'spotify:artist:art1' }],
  images: [],
  tracks: {
    items: [
      {
        id: 'trk1',
        name: 'Bohemian Rhapsody',
        uri: 'spotify:track:trk1',
        duration_ms: 355000,
        explicit: false,
        track_number: 11,
        artists: [{ id: 'art1', name: 'Queen', uri: 'spotify:artist:art1' }],
      },
    ],
    total: 1,
  },
};

const showFull: SpotifyShowFull = {
  id: 'sh1',
  name: 'The Daily',
  uri: 'spotify:show:sh1',
  description: 'News from The New York Times.',
  publisher: 'The New York Times',
  explicit: false,
  total_episodes: 500,
  languages: ['en'],
  media_type: 'audio',
};

const episodeFull: SpotifyEpisodeFull = {
  id: 'ep1',
  name: 'Episode One',
  uri: 'spotify:episode:ep1',
  duration_ms: 1800000,
  release_date: '2026-08-20T00:00:00Z',
  explicit: false,
  description: 'The first episode.',
  languages: ['en'],
  resume_point: { fully_played: false, resume_position_ms: 300000 },
  show: { id: 'sh1', name: 'The Daily', uri: 'spotify:show:sh1' },
};

interface StubOptions {
  getResponse?: (path: string, params?: Record<string, string>) => unknown;
}

function makeClientStub(opts: StubOptions = {}): { client: SpotifyClient; calls: Call[] } {
  const calls: Call[] = [];
  const stub = {
    get: async (path: string, params?: Record<string, string>) => {
      calls.push(params === undefined ? { method: 'GET', path } : { method: 'GET', path, params });
      return opts.getResponse?.(path, params);
    },
  };
  // Test seam: template resources only need client.get.
  return { client: stub as unknown as SpotifyClient, calls };
}

async function connect(client: SpotifyClient): Promise<Client> {
  const server = new McpServer({ name: 'test', version: '0.0.0' });
  registerTemplateResources(server, client);
  const mcpClient = new Client({ name: 'tester', version: '0.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(clientTransport), mcpClient.connect(serverTransport)]);
  return mcpClient;
}

// ------------------------------------------------------- registration list

test('registers 5 catalog templates plus their {+qs} query twins', async () => {
  const { client } = makeClientStub();
  const mcp = await connect(client);
  const templates = await mcp.listResourceTemplates();
  const uris = templates.resourceTemplates.map((t) => t.uriTemplate).sort();

  assert.deepEqual(uris, [
    'spotify://album/{id}',
    'spotify://album/{id}{+qs}',
    'spotify://artist/{id}',
    'spotify://artist/{id}/albums',
    'spotify://artist/{id}/albums{+qs}',
    'spotify://artist/{id}{+qs}',
    'spotify://episode/{id}',
    'spotify://episode/{id}{+qs}',
    'spotify://playlist/{id}',
    'spotify://playlist/{id}{+qs}',
    'spotify://show/{id}',
    'spotify://show/{id}{+qs}',
    'spotify://track/{id}',
    'spotify://track/{id}{+qs}',
  ]);
});

// ------------------------------------------------------------ URI parsing

test('valid ids route to the correct single-get API paths', async () => {
  const { client, calls } = makeClientStub({
    getResponse: (path) => {
      if (path.startsWith('/artists/') && path.endsWith('/albums')) {
        return { items: [], total: 0, limit: 10, offset: 0 };
      }
      if (path === '/artists/art%201') return artistFull;
      if (path === '/artists/art1') return artistFull;
      return null;
    },
  });
  const mcp = await connect(client);

  const res = await mcp.readResource({ uri: 'spotify://artist/art1' });
  assert.match(res.contents[0]?.text ?? '', /Artist: Queen/);
  assert.equal(calls[0]?.path, '/artists/art1');

  // Encoded id stays encoded end-to-end.
  await mcp.readResource({ uri: 'spotify://artist/art%201' });
  assert.equal(calls[1]?.path, '/artists/art%201');
});

test('malformed or non-matching URIs are rejected without an API call', async () => {
  const { client, calls } = makeClientStub({
    getResponse: () => ({ items: [], total: 0, limit: 10, offset: 0 }),
  });
  const mcp = await connect(client);

  // Wrong shape entirely: no template matches, SDK errors before any fetch.
  await assert.rejects(mcp.readResource({ uri: 'spotify://artist' }));
  await assert.rejects(mcp.readResource({ uri: 'spotify://unknown/art1' }));
  assert.equal(calls.length, 0);
});

test('empty id segment cannot reach the API', async () => {
  const { client, calls } = makeClientStub({
    getResponse: () => artistFull,
  });
  const mcp = await connect(client);

  // 'spotify://episode/' has an empty capture — must not resolve to GET /episodes/.
  await assert.rejects(
    mcp.readResource({ uri: 'spotify://episode/' }),
    (err: Error) => !/Could not retrieve/.test(err.message),
  );
  assert.equal(calls.filter((c) => c.path === '/episodes/').length, 0);
});

// ------------------------------------------- prose vs json per template

test('bare URIs render prose; ?format=json returns raw payload per template', async () => {
  const { client } = makeClientStub({
    getResponse: (path) => {
      if (path === '/artists/art1') return artistFull;
      if (path === '/artists/art1/albums')
        return { items: [albumItem(1)], total: 1, limit: 10, offset: 0 };
      if (path === '/albums/alb1') return albumFull;
      if (path === '/shows/sh1') return showFull;
      if (path === '/episodes/ep1') return episodeFull;
      return null;
    },
  });
  const mcp = await connect(client);

  // Artist
  const artistProse = await mcp.readResource({ uri: 'spotify://artist/art1' });
  assert.equal(artistProse.contents[0]?.mimeType, 'text/plain');
  assert.match(artistProse.contents[0]?.text ?? '', /^Artist: Queen\nID: art1\nURI: spotify:artist:art1$/);

  const artistJson = await mcp.readResource({ uri: 'spotify://artist/art1?format=json' });
  assert.equal(artistJson.contents[0]?.mimeType, 'application/json');
  assert.deepEqual(JSON.parse(artistJson.contents[0]?.text ?? '{}'), artistFull);

  // Album
  const albumProse = await mcp.readResource({ uri: 'spotify://album/alb1' });
  assert.equal(albumProse.contents[0]?.mimeType, 'text/plain');
  assert.match(albumProse.contents[0]?.text ?? '', /Album: A Night at the Opera/);
  assert.match(albumProse.contents[0]?.text ?? '', /Bohemian Rhapsody/);

  const albumJson = await mcp.readResource({ uri: 'spotify://album/alb1?format=json' });
  assert.equal(albumJson.contents[0]?.mimeType, 'application/json');
  assert.deepEqual(JSON.parse(albumJson.contents[0]?.text ?? '{}'), albumFull);

  // Show
  const showProse = await mcp.readResource({ uri: 'spotify://show/sh1' });
  assert.equal(showProse.contents[0]?.mimeType, 'text/plain');
  assert.match(showProse.contents[0]?.text ?? '', /Show: The Daily/);
  assert.match(showProse.contents[0]?.text ?? '', /Publisher: The New York Times/);

  const showJson = await mcp.readResource({ uri: 'spotify://show/sh1?format=json' });
  assert.deepEqual(JSON.parse(showJson.contents[0]?.text ?? '{}'), showFull);

  // Episode
  const episodeProse = await mcp.readResource({ uri: 'spotify://episode/ep1' });
  assert.equal(episodeProse.contents[0]?.mimeType, 'text/plain');
  assert.match(episodeProse.contents[0]?.text ?? '', /Episode: Episode One/);
  assert.match(episodeProse.contents[0]?.text ?? '', /Show: The Daily/);
  assert.match(episodeProse.contents[0]?.text ?? '', /Resume point: 5:00/);

  const episodeJson = await mcp.readResource({ uri: 'spotify://episode/ep1?format=json' });
  assert.deepEqual(JSON.parse(episodeJson.contents[0]?.text ?? '{}'), episodeFull);
});

test('artist-albums prose lists albums; ?format=json aggregates pages with truncation flag', async () => {
  const { client } = makeClientStub({
    getResponse: (_path, params) => {
      const offset = Number(params?.offset ?? '0');
      // Total 12: one full page of 10, then a partial page of 2.
      const count = Math.min(10, Math.max(0, 12 - offset));
      return {
        items: Array.from({ length: count }, (_, i) => albumItem(offset + i + 1)),
        total: 12,
        limit: 10,
        offset,
      };
    },
  });
  const mcp = await connect(client);

  const albumsJson = await mcp.readResource({ uri: 'spotify://artist/art1/albums?format=json' });
  const payload = JSON.parse(albumsJson.contents[0]?.text ?? '{}') as {
    id: string;
    total: number;
    retrieved: number;
    truncated: boolean;
    items: SpotifyAlbumItem[];
  };
  assert.equal(payload.id, 'art1');
  assert.equal(payload.total, 12);
  assert.equal(payload.retrieved, 12);
  assert.equal(payload.items.length, 12);
  assert.equal(payload.truncated, false); // fully fetched within the cap

  const albumsProse = await mcp.readResource({ uri: 'spotify://artist/art1/albums' });
  assert.equal(albumsProse.contents[0]?.mimeType, 'text/plain');
  assert.match(albumsProse.contents[0]?.text ?? '', /Albums for artist art1/);
  assert.match(albumsProse.contents[0]?.text ?? '', /showing 12 of 12/);
  assert.match(albumsProse.contents[0]?.text ?? '', /"Album 1"/);
  assert.doesNotMatch(albumsProse.contents[0]?.text ?? '', /truncated/);
});

// ------------------------------------------------- pagination cap (#111)

test('artist-albums walks at most 5 pages of limit=10 and stops when complete', async () => {
  let callCount = 0;
  const { client, calls } = makeClientStub({
    getResponse: (path, params) => {
      void path;
      callCount += 1;
      const offset = Number(params?.offset ?? '0');
      // Total 35: pages at offsets 0,10,20 cover everything; page 3 is partial.
      const remaining = Math.max(0, 35 - offset);
      const count = Math.min(10, remaining);
      return {
        items: Array.from({ length: count }, (_, i) => albumItem(offset + i + 1)),
        total: 35,
        limit: 10,
        offset,
      };
    },
  });
  const mcp = await connect(client);
  const res = await mcp.readResource({ uri: 'spotify://artist/art1/albums' });

  // Complete within the cap: 4 pages requested (0,10,20,30), last partial → stop.
  assert.ok(callCount <= 5, `expected ≤5 page requests, got ${callCount}`);
  assert.deepEqual(
    calls.map((c) => c.params?.offset),
    ['0', '10', '20', '30'],
  );
  for (const c of calls) assert.equal(c.params?.limit, '10');

  const body = res.contents[0]?.text ?? '';
  assert.match(body, /showing 35 of 35/);
  assert.doesNotMatch(body, /truncated/);
});

test('artist-albums caps at exactly 5 pages with truncation footer when total exceeds reach', async () => {
  const { client, calls } = makeClientStub({
    getResponse: (_path, params) => {
      const offset = Number(params?.offset ?? '0');
      return {
        items: Array.from({ length: 10 }, (_, i) => albumItem(offset + i + 1)),
        total: 1000,
        limit: 10,
        offset,
      };
    },
  });
  const mcp = await connect(client);
  const res = await mcp.readResource({ uri: 'spotify://artist/art1/albums' });

  // Hard cap: exactly 5 full pages, never a 6th request.
  assert.equal(calls.length, 5);
  assert.deepEqual(
    calls.map((c) => c.params?.offset),
    ['0', '10', '20', '30', '40'],
  );

  const body = res.contents[0]?.text ?? '';
  assert.match(body, /showing 50 of 1000/);
  assert.match(body, /\.\.\. and 950 more — truncated at 5 pages × 10 albums/);
});

// ------------------------------------------------------ market passthrough

test('?market passes through to show and episode endpoints; absent market omits params', async () => {
  const { client, calls } = makeClientStub({
    getResponse: (path) => (path === '/shows/sh1' ? showFull : path === '/episodes/ep1' ? episodeFull : null),
  });
  const mcp = await connect(client);

  await mcp.readResource({ uri: 'spotify://show/sh1?market=US&format=json' });
  assert.deepEqual(calls[0], { method: 'GET', path: '/shows/sh1', params: { market: 'US' } });

  await mcp.readResource({ uri: 'spotify://show/sh1' });
  assert.deepEqual(calls[1], { method: 'GET', path: '/shows/sh1' });

  await mcp.readResource({ uri: 'spotify://episode/ep1?market=GB' });
  assert.deepEqual(calls[2], { method: 'GET', path: '/episodes/ep1', params: { market: 'GB' } });

  await mcp.readResource({ uri: 'spotify://episode/ep1' });
  assert.deepEqual(calls[3], { method: 'GET', path: '/episodes/ep1' });
});

test('show/episode templates expose argument completions from saved library (#111)', async () => {
  // The stub server records ResourceTemplate objects; assert the complete map
  // exists and returns saved IDs through the client.
  const savedShow = { added_at: '', show: { id: 'shw9', name: 'S' } };
  const savedEp = { added_at: '', episode: { id: 'ep9', name: 'E' } };
  const { registered } = await (async () => {
    const names: Array<{ name: string; template: unknown }> = [];
    const server = {
      resource: (name: string, template: unknown) => {
        names.push({ name, template });
      },
    };
    const client = {
      get: async () => null,
      getAllPages: async (path: string) =>
        path === '/me/shows' ? [savedShow] : path === '/me/episodes' ? [savedEp] : [],
    };
    registerTemplateResources(
      server as unknown as Parameters<typeof registerTemplateResources>[0],
      client as unknown as Parameters<typeof registerTemplateResources>[1],
    );
    return { registered: names };
  })();

  // The SDK stores completions on the private _callbacks map; access through
  // the public completeCallback(variable) accessor instead.
  const idCompleter = (name: string) => {
    const t = registered.find((r) => r.name === name)!.template as {
      completeCallback: (v: string) => (() => Promise<string[]>) | undefined;
    };
    return t.completeCallback('id');
  };

  assert.deepEqual(await idCompleter('show')?.(), ['shw9']);
  assert.deepEqual(await idCompleter('episode')?.(), ['ep9']);
  assert.equal(idCompleter('album'), undefined, 'albums have no cheap enumerable source');
});
