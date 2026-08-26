/**
 * Tests for src/tools/playlists.ts and src/tools/following.ts.
 *
 * Uses a stub MCP server + stub SpotifyClient (records every call, returns
 * canned data) — no network, no token file access, no global fetch needed.
 *
 * Run: node --import tsx --test tests/tools.playlists-following.test.ts
 */

import { describe, it } from 'node:test';
import { z } from 'zod';
import assert from 'node:assert/strict';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { SpotifyClient } from '../src/client.js';
import type { SpotifyPaged } from '../src/types/spotify.js';
import { registerPlaylistTools } from '../src/tools/playlists.js';
import { registerFollowingTools } from '../src/tools/following.js';

// ---------------------------------------------------------------------------
// Stub plumbing
// ---------------------------------------------------------------------------

interface RecordedCall {
  method: 'GET' | 'POST' | 'PUT' | 'PUT_RAW' | 'DELETE';
  path: string;
  arg?: unknown;
  extra?: unknown;
}

type Responder = (path: string, arg: unknown) => unknown;

interface RegisteredTool {
  name: string;
  description: string;
  /** Validates raw args exactly like the MCP SDK would before invoking the handler. */
  validate: (args: Record<string, unknown>) => Record<string, unknown>;
  handler: (
    args: Record<string, unknown>,
  ) => Promise<{
    content: Array<{ type: string; text: string }>;
    // #52: list-type tools attach machine-readable payloads alongside text.
    structuredContent?: Record<string, unknown>;
  }>;
}

type Registrar = (server: McpServer, client: SpotifyClient) => void;

// Compare only method/path/arg; `extra` (putRaw content type) is asserted
// separately where relevant.
const wireCalls = (calls: RecordedCall[]) =>
  calls.map((c) => ({ method: c.method, path: c.path, arg: c.arg }));

function makeStubClient(responder: Responder = () => null) {
  const calls: RecordedCall[] = [];
  let respond: Responder = responder;

  const client = {
    calls,
    setResponder(fn: Responder) {
      respond = fn;
    },
    async get<T>(path: string, params?: Record<string, string>): Promise<T | null> {
      calls.push({ method: 'GET', path, arg: params });
      return respond(path, params) as T | null;
    },
    async post<T>(path: string, body?: unknown): Promise<T | null> {
      calls.push({ method: 'POST', path, arg: body });
      return respond(path, body) as T | null;
    },
    async put<T>(path: string, body?: unknown): Promise<T | null> {
      calls.push({ method: 'PUT', path, arg: body });
      return respond(path, body) as T | null;
    },
    async putRaw(path: string, body: string, contentType?: string): Promise<void> {
      calls.push({ method: 'PUT_RAW', path, arg: body, extra: contentType });
      await respond(path, body);
    },
    async delete<T>(path: string, body?: unknown): Promise<T | null> {
      calls.push({ method: 'DELETE', path, arg: body });
      return respond(path, body) as T | null;
    },
    // Mirrors SpotifyClient.getAllPages over the stubbed get() so fetch_all
    // refactors (issue #67) are exercised against real pagination semantics.
    async getAllPages<T>(
      path: string,
      params?: Record<string, string>,
      opts?: { maxItems?: number; initialOffset?: number },
    ): Promise<T[]> {
      const maxItems = opts?.maxItems ?? 500;
      const all: T[] = [];
      let offset = opts?.initialOffset ?? 0;
      for (;;) {
        const page = await this.get<SpotifyPaged<T>>(path, { ...params, offset: String(offset) });
        if (!page || !Array.isArray(page.items)) break;
        all.push(...page.items);
        if (all.length >= maxItems) return all.slice(0, maxItems);
        const limit =
          typeof page.limit === 'number' && page.limit > 0 ? page.limit : page.items.length;
        offset += limit;
        if (page.items.length === 0 || page.items.length < limit) break;
        if (typeof page.total === 'number' && offset >= page.total) break;
      }
      return all;
    },
  };
  return client;
}

function harness(
  responder: Responder = () => null,
  registerFn: Registrar = registerPlaylistTools,
  // When set, the stub server advertises elicitation and elicitInput resolves
  // to this value (or throws when it is an Error instance).
  elicitResult?: unknown,
) {
  const registered: RegisteredTool[] = [];
  const fakeServer = {
    // Legacy SDK shape: (name, description, ZodRawShape, handler)
    tool(
      name: string,
      description: string,
      schema: z.ZodRawShape,
      handler: RegisteredTool['handler'],
    ) {
      registered.push({
        name,
        description,
        validate: (args) => z.object(schema).parse(args),
        handler,
      });
    },
    ...(elicitResult !== undefined
      ? {
          getServerCapabilities: () => ({ elicitation: {} }),
          async elicitInput() {
            if (elicitResult instanceof Error) throw elicitResult;
            return elicitResult;
          },
        }
      : {}),
    // Newer SDK shape: (name, { description, inputSchema: full ZodObject }, handler)
    registerTool(
      name: string,
      config: { description?: string; inputSchema?: z.ZodType },
      handler: RegisteredTool['handler'],
    ) {
      registered.push({
        name,
        description: config.description ?? '',
        validate: (args) => (config.inputSchema as z.ZodType).parse(args),
        handler,
      });
    },
  } as unknown as McpServer;
  const client = makeStubClient(responder);
  registerFn(fakeServer, client as unknown as SpotifyClient);

  return {
    registered,
    client,
    invoke: async (name: string, args: Record<string, unknown>) => {
      const tool = registered.find((t) => t.name === name);
      assert.ok(tool, `tool "${name}" should be registered`);
      // Async so schema-validation throws surface as rejections, matching
      // how the real MCP server surfaces them to assert.rejects.
      return tool.handler(tool.validate(args));
    },
  };
}

const textOf = (out: { content: Array<{ text: string }> }) => out.content[0].text;

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const playlistSimple = (id: string, name: string, trackTotal = 3) => ({
  id,
  name,
  uri: `spotify:playlist:${id}`,
  owner: { id: `owner-${id}`, display_name: `Owner ${id}` },
  items: { total: trackTotal },
});

const playableTrack = (id: string, name: string, ms = 200000) => ({
  type: 'track',
  name,
  uri: `spotify:track:${id}`,
  duration_ms: ms,
  artists: [{ name: `Artist ${id}` }],
});

// ---------------------------------------------------------------------------
// get_user_playlists
// ---------------------------------------------------------------------------

describe('get_user_playlists', () => {
  it('forwards limit/offset as strings on a single page fetch', async () => {
    const h = harness((path) => {
      assert.equal(path, '/me/playlists');
      return { items: [playlistSimple('p1', 'Chill')], total: 1 };
    });

    await h.invoke('get_user_playlists', { limit: 30, offset: 60 });

    assert.deepEqual(h.client.calls[0].arg, { limit: '30', offset: '60' });
  });

  it('defaults to limit 20 with no offset when args are omitted', async () => {
    const h = harness(() => ({ items: [], total: 0 }));
    await h.invoke('get_user_playlists', {});
    assert.deepEqual(h.client.calls[0].arg, { limit: '20' });
  });

  it('#53 fetch_all caps rendering at max_results with a continuation footer', async () => {
    // First page: 1 playlist of a claimed 1000 total. Second page: 499 more.
    // Loop stops at exactly 500 (FETCH_ALL_CAP), never requesting a third page;
    // the default SPOTIFY_MCP_MAX_ITEMS cap then trims what is rendered.
    const h = harness((path, params) => {
      assert.equal(path, '/me/playlists');
      if (h.client.calls.length === 1) {
        return { items: [playlistSimple('p0', 'First')], total: 1000 };
      }
      assert.deepEqual(params, { limit: '20', offset: '1' });
      return {
        items: Array.from({ length: 499 }, (_, i) => playlistSimple(`p${i + 1}`, `PL ${i + 1}`)),
        total: 1000,
      };
    });

    const out = await h.invoke('get_user_playlists', { fetch_all: true });

    // Still exactly two upstream pages even though only 50 rows render.
    assert.equal(h.client.calls.length, 2);
    const text = textOf(out);
    assert.match(text, /Your playlists \(1000 total, showing 50\):/);
    assert.match(text, /\(450 more — pass offset or fetch_all\)/);
  });

  it('#53 max_results override lifts the rendering cap without extra API pages', async () => {
    const h = harness((_path, _params) => ({
      items: Array.from({ length: 120 }, (_, i) => playlistSimple(`p${i}`, `PL ${i}`)),
      total: 120,
    }));

    const out = await h.invoke('get_user_playlists', { max_results: 200 });

    assert.equal(h.client.calls.length, 1);
    const text = textOf(out);
    assert.match(text, /Your playlists \(120 total, showing 120\):/);
    assert.match(text, /"PL 119"/);
    assert.ok(!text.includes('more —'), 'no footer when everything fits under max_results');
  });

  it('renders each playlist line with owner fallback to owner.id', async () => {
    const h = harness(() => ({
      items: [{ ...playlistSimple('p1', 'Mix'), owner: { id: 'uid42', display_name: null } }],
      total: 1,
    }));
    const out = await h.invoke('get_user_playlists', {});
    assert.match(textOf(out), /"Mix" by uid42 \(3 tracks\) \| ID: p1 \| URI: spotify:playlist:p1/);
  });

  it('#67 fetch_all resumes pagination from the absolute offset via getAllPages', async () => {
    // First page (offset 40) yields one playlist of a claimed 43 total; the
    // follow-up walk must continue at absolute offset 41, not restart at 0.
    const h = harness((path, params) => {
      assert.equal(path, '/me/playlists');
      if (h.client.calls.length === 1) {
        assert.deepEqual(params, { limit: '20', offset: '40' });
        return { items: [playlistSimple('p40', 'First')], total: 43 };
      }
      assert.deepEqual(params, { limit: '20', offset: '41' });
      return {
        items: [playlistSimple('p41', 'Second'), playlistSimple('p42', 'Third')],
        total: 43,
      };
    });

    const out = await h.invoke('get_user_playlists', { fetch_all: true, offset: 40 });

    assert.equal(h.client.calls.length, 2);
    assert.match(textOf(out), /Your playlists \(43 total, showing 3\):/);
  });
});

// ---------------------------------------------------------------------------
// get_playlist
// ---------------------------------------------------------------------------

describe('get_playlist (metadata + items two-call flow)', () => {
  it('fetches metadata AND items, surfaces embedded cover URL, no images call', async () => {
    const h = harness((path) => {
      if (path === '/playlists/pl1') {
        return {
          ...playlistSimple('pl1', 'Roadtrip'),
          description: 'Songs for driving',
          images: [{ url: 'https://i.scdn.co/image/cover-300', width: 300, height: 300 }],
        };
      }
      if (path === '/playlists/pl1/items') {
        return { items: [{ item: playableTrack('t1', 'Highway') }], total: 1 };
      }
      assert.fail(`unexpected path: ${path}`);
    });

    const out = await h.invoke('get_playlist', { playlist_id: 'pl1' });

    // Exactly two upstream calls: metadata + first items page.
    assert.deepEqual(
      h.client.calls.map((c) => `${c.method} ${c.path}`),
      ['GET /playlists/pl1', 'GET /playlists/pl1/items'],
    );
    assert.deepEqual(h.client.calls[1].arg, { limit: '50' }); // default item limit

    const text = textOf(out);
    assert.match(text, /"Roadtrip" by Owner pl1/);
    assert.match(text, /Description: Songs for driving/);
    assert.match(text, /URI: spotify:playlist:pl1/);
    assert.match(text, /Cover image: https:\/\/i\.scdn\.co\/image\/cover-300/);
    assert.match(text, /Tracks \(1 total, showing 1\):/);
    assert.match(text, /1\. "Highway" by Artist t1 \(3:20\) \| URI: spotify:track:t1/);
  });

  it('falls back to the images endpoint when metadata has no cover', async () => {
    const h = harness((path) => {
      if (path === '/playlists/pl2') {
        return { ...playlistSimple('pl2', 'NoArt'), images: [] };
      }
      if (path === '/playlists/pl2/items') {
        return { items: [], total: 0 };
      }
      if (path === '/playlists/pl2/images') {
        return [{ url: 'https://example.com/fallback.jpg' }];
      }
      assert.fail(`unexpected path: ${path}`);
    });

    const out = await h.invoke('get_playlist', { id: 'pl2' });

    assert.ok(h.client.calls.some((c) => c.path === '/playlists/pl2/images'));
    assert.match(textOf(out), /Cover image: https:\/\/example\.com\/fallback\.jpg/);
    assert.match(textOf(out), /Playlist is empty\./);
  });

  it('honours custom item limit and offset', async () => {
    const h = harness((path) =>
      path === '/playlists/pl3'
        ? { ...playlistSimple('pl3', 'X'), images: null }
        : { items: [{ item: playableTrack('t9', 'Nine') }], total: 30 },
    );
    const out = await h.invoke('get_playlist', { id: 'pl3', limit: 10, offset: 20 });

    assert.deepEqual(h.client.calls[1].arg, { limit: '10', offset: '20' });
    assert.match(textOf(out), /21\. "Nine"/); // numbering accounts for offset
  });
});

// ---------------------------------------------------------------------------
// get_playlist_cover
// ---------------------------------------------------------------------------

describe('get_playlist_cover', () => {
  it('returns friendly message for an empty images array', async () => {
    const h = harness((path) => {
      assert.equal(path, '/playlists/p9/images');
      return [];
    });
    const out = await h.invoke('get_playlist_cover', { playlist_id: 'p9' });
    assert.equal(textOf(out), 'This playlist has no custom cover image.');
  });

  it('returns null response the same way as an empty array', async () => {
    const h = harness(() => null);
    const out = await h.invoke('get_playlist_cover', { playlist_id: 'p9' });
    assert.equal(textOf(out), 'This playlist has no custom cover image.');
  });

  it('lists all URLs with dimensions where present', async () => {
    const h = harness(() => [
      { url: 'https://img/large', width: 640, height: 640 },
      { url: 'https://img/small', width: null, height: null },
    ]);
    const out = await h.invoke('get_playlist_cover', { playlist_id: 'pc' });
    const text = textOf(out);
    assert.match(text, /Cover images \(2\):/);
    assert.match(text, /• https:\/\/img\/large \(640x640\)/);
    assert.match(text, /• https:\/\/img\/small\n|\n?\s*• https:\/\/img\/small$/m);
  });
});

// ---------------------------------------------------------------------------
// upload_playlist_cover
// ---------------------------------------------------------------------------

describe('upload_playlist_cover', () => {
  const jpegBytes = (n: number) => {
    const buf = Buffer.alloc(n);
    buf[0] = 0xff;
    buf[1] = 0xd8;
    buf[2] = 0xff; // JPEG SOI + marker → base64 starts with "/9j"
    return buf.toString('base64');
  };

  it('rejects payloads without the /9j JPEG prefix before any client call', async () => {
    const h = harness();
    const notJpeg = Buffer.from('this is a PNG, honestly').toString('base64');
    assert.ok(!notJpeg.startsWith('/9j'));

    await assert.rejects(() =>
      h.invoke('upload_playlist_cover', { playlist_id: 'pl', jpeg_base64: notJpeg }),
    );

    assert.equal(h.client.calls.length, 0, 'no network call may be made for invalid input');
  });

  it('rejects decoded sizes above the 256 KB cap without any client call', async () => {
    const h = harness();
    const tooBig = jpegBytes(256 * 1024 + 1);
    assert.ok(tooBig.startsWith('/9j'));

    await assert.rejects(
      () => h.invoke('upload_playlist_cover', { playlist_id: 'pl', jpeg_base64: tooBig }),
      /256 KB/,
    );
    assert.equal(h.client.calls.length, 0);
  });

  it('accepts exactly 256 KB decoded and calls putRaw on the images endpoint', async () => {
    const h = harness();
    const exact = jpegBytes(256 * 1024);

    const out = await h.invoke('upload_playlist_cover', {
      playlist_id: 'my list',
      jpeg_base64: exact,
    });

    assert.deepEqual(wireCalls(h.client.calls), [
      {
        method: 'PUT_RAW',
        path: '/playlists/my%20list/images',
        arg: exact,
      },
    ]);
    // Handler passes only two args — the 'image/jpeg' content type is
    // SpotifyClient.putRaw's default, never an explicit third argument.
    assert.equal(h.client.calls[0].extra, undefined);
    assert.match(textOf(out), /Cover image uploaded\./);
  });
});

// ---------------------------------------------------------------------------
// create_playlist
// ---------------------------------------------------------------------------

describe('create_playlist', () => {
  it('POSTs exactly once to /me/playlists with full body (never /users/{id}/playlists)', async () => {
    const h = harness((_path, body) => ({
      id: 'new1',
      uri: 'spotify:playlist:new1',
      external_urls: { spotify: 'https://open.spotify.com/playlist/new1' },
      ...(body as object),
    }));

    const out = await h.invoke('create_playlist', {
      name: 'Focus',
      description: 'Deep work',
      public: true,
      collaborative: false,
    });

    assert.equal(h.client.calls.length, 1, 'must be exactly one POST');
    const call = h.client.calls[0];
    assert.equal(call.method, 'POST');
    assert.equal(call.path, '/me/playlists');
    assert.deepEqual(call.arg, {
      name: 'Focus',
      description: 'Deep work',
      public: true,
      collaborative: false,
    });

    const text = textOf(out);
    assert.match(text, /Created playlist "Focus"/);
    assert.match(text, /ID: new1/);
    assert.match(text, /URL: https:\/\/open\.spotify\.com\/playlist\/new1/);
  });

  it('defaults public/collaborative to false and omits empty description', async () => {
    const h = harness(() => ({ id: 'n', uri: 'u', external_urls: { spotify: 's' } }));
    await h.invoke('create_playlist', { name: 'Bare' });

    assert.deepEqual(h.client.calls[0].arg, {
      name: 'Bare',
      public: false,
      collaborative: false,
    });
    assert.equal(Object.hasOwn(h.client.calls[0].arg as object, 'description'), false);
  });

  it('#26 rejects public=true + collaborative=true via superRefine, before any client call', async () => {
    const h = harness(() => ({ id: 'n', uri: 'u', external_urls: { spotify: 's' } }));

    await assert.rejects(
      () => h.invoke('create_playlist', { name: 'Both', public: true, collaborative: true }),
      /cannot be both public and collaborative/,
    );
    assert.equal(h.client.calls.length, 0, 'invalid combination must never reach the API');
  });

  it('#26 accepts collaborative=true when public is false', async () => {
    const h = harness((_path, body) => ({
      id: 'collab1',
      uri: 'spotify:playlist:collab1',
      external_urls: { spotify: 'https://open.spotify.com/playlist/collab1' },
      ...(body as object),
    }));

    await h.invoke('create_playlist', { name: 'Shared', public: false, collaborative: true });

    assert.deepEqual(h.client.calls[0].arg, {
      name: 'Shared',
      public: false,
      collaborative: true,
    });
  });
});

// ---------------------------------------------------------------------------
// Playlist item mutations
// ---------------------------------------------------------------------------

describe('add_to_playlist / remove_from_playlist / update_playlist / reorder_playlist_items', () => {
  it('add_to_playlist POSTs uris (and position when given) to /playlists/{id}/items', async () => {
    const h = harness();
    const uris = ['spotify:track:a', 'spotify:episode:b'];

    await h.invoke('add_to_playlist', { playlist_id: 'pl', uris, position: 7 });
    assert.deepEqual(wireCalls(h.client.calls).slice(0, 1), [
      { method: 'POST', path: '/playlists/pl/items', arg: { uris, position: 7 } },
    ]);

    await h.invoke('add_to_playlist', { playlist_id: 'pl', uris });
    assert.deepEqual(h.client.calls[1].arg, { uris }, 'position omitted when not provided');
  });

  it('remove_from_playlist DELETEs wrapped track objects to /playlists/{id}/items', async () => {
    const h = harness();

    const out = await h.invoke('remove_from_playlist', {
      playlist_id: 'pl',
      uris: ['spotify:track:x', 'spotify:track:y'],
    });

    assert.deepEqual(wireCalls(h.client.calls), [
      {
        method: 'DELETE',
        path: '/playlists/pl/items',
        arg: { tracks: [{ uri: 'spotify:track:x' }, { uri: 'spotify:track:y' }] },
      },
    ]);
    assert.match(textOf(out), /Removed 2 item\(s\) from playlist\./);
  });

  it('update_playlist PUTs only provided fields to /playlists/{id}', async () => {
    const h = harness();

    await h.invoke('update_playlist', { playlist_id: 'pl', name: 'New Name', public: false });
    assert.deepEqual(wireCalls(h.client.calls).slice(0, 1), [
      { method: 'PUT', path: '/playlists/pl', arg: { name: 'New Name', public: false } },
    ]);

    await h.invoke('update_playlist', {
      id: 'pl',
      description: 'd',
      collaborative: true,
    });
    assert.deepEqual(h.client.calls[1].arg, { description: 'd', collaborative: true });
  });

  it('update_playlist throws without any client call when no fields given', async () => {
    const h = harness();
    await assert.rejects(
      () => h.invoke('update_playlist', { id: 'pl' }),
      /Provide at least one field/,
    );
    assert.equal(h.client.calls.length, 0);
  });

  it('reorder_playlist_items PUTs range_start/insert_before (+range_length) to /playlists/{id}/items', async () => {
    const h = harness();

    await h.invoke('reorder_playlist_items', {
      playlist_id: 'pl',
      range_start: 2,
      insert_before: 10,
    });
    assert.deepEqual(wireCalls(h.client.calls).slice(0, 1), [
      { method: 'PUT', path: '/playlists/pl/items', arg: { range_start: 2, insert_before: 10 } },
    ]);

    await h.invoke('reorder_playlist_items', {
      playlist_id: 'pl',
      range_start: 0,
      range_length: 5,
      insert_before: 3,
    });
    assert.deepEqual(h.client.calls[1].arg, {
      range_start: 0,
      insert_before: 3,
      range_length: 5,
    });
  });

  it('#25 remove_from_playlist rejects more than 100 uris before any client call', async () => {
    const h = harness();
    const tooMany = Array.from({ length: 101 }, (_, i) => `spotify:track:t${i}`);

    await assert.rejects(
      () => h.invoke('remove_from_playlist', { playlist_id: 'pl', uris: tooMany }),
      (err: unknown) => err instanceof z.ZodError,
    );
    assert.equal(h.client.calls.length, 0, 'over-cap request must never reach the API');
  });

  it('#25 remove_from_playlist accepts exactly 100 uris', async () => {
    const h = harness(() => null);
    const exactly100 = Array.from({ length: 100 }, (_, i) => `spotify:track:t${i}`);

    await h.invoke('remove_from_playlist', { playlist_id: 'pl', uris: exactly100 });

    assert.equal(h.client.calls.length, 1);
    assert.equal(h.client.calls[0].method, 'DELETE');
    assert.deepEqual(h.client.calls[0].arg, { tracks: exactly100.map((uri) => ({ uri })) });
  });

  it('#25 add_to_playlist enforces the same 100-uri cap via schema validation', async () => {
    const h = harness();
    const tooMany = Array.from({ length: 101 }, (_, i) => `spotify:track:t${i}`);

    await assert.rejects(
      () => h.invoke('add_to_playlist', { playlist_id: 'pl', uris: tooMany }),
      (err: unknown) => err instanceof z.ZodError,
    );
    assert.equal(h.client.calls.length, 0);
  });
});

// ---------------------------------------------------------------------------
// get_playlist_items (#42)
// ---------------------------------------------------------------------------

describe('get_playlist_items', () => {
  it('GETs /playlists/{id}/items forwarding market/fields/additional_types and default limit 100', async () => {
    const h = harness((path) => {
      assert.equal(path, '/playlists/pl1/items');
      return { items: [], total: 0, limit: 100, offset: 0 };
    });

    // #110: lowercase market is normalised to uppercase on the wire, and
    // additional_types arrives as an enum array but serialises to a
    // comma-separated string.
    await h.invoke('get_playlist_items', {
      playlist_id: 'pl1',
      market: 'gb',
      fields: 'total,items(track(name,uri))',
      additional_types: ['track', 'episode'],
    });
    assert.deepEqual(h.client.calls[0].arg, {
      limit: '100',
      market: 'GB',
      fields: 'total,items(track(name,uri))',
      additional_types: 'track,episode',
    });
  });

  it('rejects a malformed market code before any client call (#110)', async () => {
    const h = harness();

    await assert.rejects(
      () => h.invoke('get_playlist_items', { playlist_id: 'pl1', market: 'USA' }),
      (err: unknown) => err instanceof z.ZodError,
    );
    await assert.rejects(
      () => h.invoke('get_playlist_items', { playlist_id: 'pl1', market: 'g' }),
      (err: unknown) => err instanceof z.ZodError,
    );
    assert.equal(h.client.calls.length, 0);
  });

  it('forwards explicit limit and offset and numbers rows from the absolute offset', async () => {
    const h = harness((path) => {
      assert.equal(path, '/playlists/pl2/items');
      return {
        items: [
          { item: playableTrack('t1', 'One') },
          {
            item: {
              type: 'episode',
              name: 'Episode One',
              uri: 'spotify:episode:e1',
              duration_ms: 100000,
              show: { name: 'Show' },
            },
          },
          { item: null },
        ],
        total: 30,
        limit: 10,
        offset: 20,
      };
    });

    const out = await h.invoke('get_playlist_items', { playlist_id: 'pl2', limit: 10, offset: 20 });

    assert.deepEqual(h.client.calls[0].arg, { limit: '10', offset: '20' });
    const text = textOf(out);
    assert.match(text, /Playlist items \(30 total, showing 3\):/);
    assert.match(text, /21\. "One" by Artist t1 \(3:20\) \| URI: spotify:track:t1/);
    assert.match(text, /22\. "Episode One" — Show \(1:40\) \| URI: spotify:episode:e1/);
    assert.match(text, /23\. \[unavailable in this market\]/);
  });

  it('rejects out-of-range limits before any client call', async () => {
    const h = harness();
    await assert.rejects(
      () => h.invoke('get_playlist_items', { playlist_id: 'pl', limit: 101 }),
      (err: unknown) => err instanceof z.ZodError,
    );
    await assert.rejects(
      () => h.invoke('get_playlist_items', { playlist_id: 'pl', limit: 0 }),
      (err: unknown) => err instanceof z.ZodError,
    );
    assert.equal(h.client.calls.length, 0);
  });
});

// ---------------------------------------------------------------------------
// replace_playlist_items (#41)
// ---------------------------------------------------------------------------

describe('replace_playlist_items', () => {
  it('atomically PUTs the URI list when it fits in a single request', async () => {
    const h = harness();
    const uris = ['spotify:track:a', 'spotify:episode:b'];

    const out = await h.invoke('replace_playlist_items', { playlist_id: 'pl', uris });

    assert.deepEqual(wireCalls(h.client.calls), [
      { method: 'PUT', path: '/playlists/pl/items', arg: { uris } },
    ]);
    assert.match(textOf(out), /Replaced playlist contents with 2 item\(s\) across 1 request\(s\)\./);
  });

  it('chunks longer lists: one atomic PUT followed by POST appends of at most 100 URIs', async () => {
    const h = harness();
    const uris = Array.from({ length: 250 }, (_, i) => `spotify:track:t${i}`);

    const out = await h.invoke('replace_playlist_items', { playlist_id: 'pl', uris });

    // A second PUT would wipe the first chunk — appends must be POSTs.
    assert.deepEqual(wireCalls(h.client.calls), [
      { method: 'PUT', path: '/playlists/pl/items', arg: { uris: uris.slice(0, 100) } },
      { method: 'POST', path: '/playlists/pl/items', arg: { uris: uris.slice(100, 200) } },
      { method: 'POST', path: '/playlists/pl/items', arg: { uris: uris.slice(200) } },
    ]);
    assert.match(textOf(out), /Replaced playlist contents with 250 item\(s\) across 3 request\(s\)\./);
  });

  it('surfaces the snapshot_id from the final chunk response', async () => {
    const h = harness((_path, body) =>
      JSON.stringify(body).includes('t0') ? { snapshot_id: 'snap-put' } : { snapshot_id: 'snap-post' },
    );
    const uris = Array.from({ length: 150 }, (_, i) => `spotify:track:t${i}`);

    const out = await h.invoke('replace_playlist_items', { playlist_id: 'pl', uris });

    assert.match(textOf(out), /Snapshot ID: snap-post$/);
  });

  it('rejects an empty URI list before any client call', async () => {
    const h = harness();
    await assert.rejects(
      () => h.invoke('replace_playlist_items', { playlist_id: 'pl', uris: [] }),
      (err: unknown) => err instanceof z.ZodError,
    );
    assert.equal(h.client.calls.length, 0);
  });
});

// ---------------------------------------------------------------------------
// Mutation snapshot precision (#50)
// ---------------------------------------------------------------------------

describe('#50 snapshot precision on playlist mutations', () => {
  it('add_to_playlist surfaces the returned snapshot_id', async () => {
    const h = harness(() => ({ snapshot_id: 'snap-add' }));

    const out = await h.invoke('add_to_playlist', {
      playlist_id: 'pl',
      uris: ['spotify:track:a'],
    });
    assert.match(
      textOf(out),
      /^Added 1 item\(s\) to playlist\.\n1 item affected: spotify:track:a\nSnapshot ID: snap-add$/,
    );
  });

  it('remove_from_playlist sends positions[] objects and optional snapshot_id', async () => {
    const h = harness();

    const out = await h.invoke('remove_from_playlist', {
      playlist_id: 'pl',
      uris: ['spotify:track:a', { uri: 'spotify:track:b', positions: [2, 7] }],
      snapshot_id: 'snap-base',
    });

    assert.deepEqual(h.client.calls[0].arg, {
      tracks: [{ uri: 'spotify:track:a' }, { uri: 'spotify:track:b', positions: [2, 7] }],
      snapshot_id: 'snap-base',
    });
    assert.match(
      textOf(out),
      /^Removed 2 item\(s\) from playlist\.\n2 items affected: spotify:track:a, spotify:track:b$/,
    );
  });

  it('remove_from_playlist surfaces the new snapshot_id after removal', async () => {
    const h = harness(() => ({ snapshot_id: 'snap-del' }));

    const out = await h.invoke('remove_from_playlist', {
      playlist_id: 'pl',
      uris: ['spotify:track:a'],
    });
    assert.match(textOf(out), /Snapshot ID: snap-del$/);
  });

  it('reorder_playlist_items surfaces the returned snapshot_id', async () => {
    const h = harness(() => ({ snapshot_id: 'snap-reorder' }));

    const out = await h.invoke('reorder_playlist_items', {
      playlist_id: 'pl',
      range_start: 0,
      insert_before: 2,
    });
    // Reorder moves a range, not URIs — the batch echo is a bare count.
    assert.match(
      textOf(out),
      /^Playlist items reordered\.\n1 item affected\nSnapshot ID: snap-reorder$/,
    );
  });

  it('positions entries must be non-negative integers and non-empty', async () => {
    const h = harness();

    await assert.rejects(
      () =>
        h.invoke('remove_from_playlist', {
          playlist_id: 'pl',
          uris: [{ uri: 'spotify:track:a', positions: [-1] }],
        }),
      (err: unknown) => err instanceof z.ZodError,
    );
    await assert.rejects(
      () =>
        h.invoke('remove_from_playlist', {
          playlist_id: 'pl',
          uris: [{ uri: 'spotify:track:a', positions: [] }],
        }),
      (err: unknown) => err instanceof z.ZodError,
    );
    assert.equal(h.client.calls.length, 0);
  });
});

// ---------------------------------------------------------------------------
// following module
// ---------------------------------------------------------------------------

describe('following module registrations', () => {
  it('does NOT register deprecated follow_artist/unfollow_artist tools', () => {
    const h = harness(() => null, registerFollowingTools);
    const names = h.registered.map((t) => t.name);
    assert.equal(names.includes('follow_artist'), false, 'follow_artist must be absent');
    assert.equal(names.includes('unfollow_artist'), false, 'unfollow_artist must be absent');
  });
});

describe('get_followed_artists', () => {
  it('forwards cursor param (`after`) alongside type=artist and limit', async () => {
    const h = harness(
      () => ({
        artists: {
          items: [{ name: 'Aphex Twin', uri: 'spotify:artist:afx', genres: ['idm', 'ambient'] }],
          total: 1,
          cursors: { after: 'cursor-abc' },
          next: null,
        },
      }),
      registerFollowingTools,
    );

    const out = await h.invoke('get_followed_artists', { limit: 30, after: 'prev-cursor-id' });

    assert.deepEqual(
      { method: h.client.calls[0].method, path: h.client.calls[0].path, arg: h.client.calls[0].arg },
      { method: 'GET', path: '/me/following', arg: { type: 'artist', limit: '30', after: 'prev-cursor-id' } },
    );
    const text = textOf(out);
    assert.match(text, /Followed artists \(1 total, showing 1\)/);
    assert.match(text, /Aphex Twin — idm, ambient \| URI: spotify:artist:afx/);
    assert.match(text, /Next page cursor: cursor-abc/);
  });

  it('defaults limit to 20 and omits `after` when no cursor given', async () => {
    const h = harness(
      () => ({ artists: { items: [], total: 0, cursors: null, next: null } }),
      registerFollowingTools,
    );
    await h.invoke('get_followed_artists', {});
    assert.deepEqual(h.client.calls[0].arg, { type: 'artist', limit: '20' });
  });

  it('survives a null artists payload (zero followed artists)', async () => {
    const h = harness(() => ({ artists: null }), registerFollowingTools);
    const out = await h.invoke('get_followed_artists', {});
    assert.match(textOf(out), /Followed artists \(0 total, showing 0\)/);
  });
});

describe('check_following_artists', () => {
  it('sends bare IDs to /me/following/contains with type=artist', async () => {
    const h = harness(() => [true, false, true], registerFollowingTools);

    const out = await h.invoke('check_following_artists', { ids: ['aa', 'bb', 'cc'] });

    assert.deepEqual(wireCalls(h.client.calls), [
      {
        method: 'GET',
        path: '/me/following/contains',
        arg: { type: 'artist', ids: 'aa,bb,cc' },
      },
    ]);

    const text = textOf(out);
    assert.match(text, /Following check:/);
    assert.match(text, /✓ aa/);
    assert.match(text, /✗ bb/);
    assert.match(text, /✓ cc/);
    // Booleans map back in INPUT order, not result-sorted order.
    const idxAa = text.indexOf('aa');
    const idxBb = text.indexOf('bb');
    const idxCc = text.indexOf('cc');
    assert.ok(idxAa < idxBb && idxBb < idxCc);
  });

  it('renders ✗ for every-false results', async () => {
    const h = harness(() => [false], registerFollowingTools);
    const out = await h.invoke('check_following_artists', { ids: ['zzz'] });
    assert.match(textOf(out), /✗ zzz/);
  });
});

// ---------------------------------------------------------------------------
// #51/#52/#53 shaping on playlist listings
// ---------------------------------------------------------------------------

describe('playlist listings shaping (#51/#52/#53)', () => {
  it('get_user_playlists attaches structuredContent with pagination', async () => {
    const h = harness(() => ({
      items: [playlistSimple('p1', 'A'), playlistSimple('p2', 'B'), playlistSimple('p3', 'C')],
      total: 10,
    }));

    const out = await h.invoke('get_user_playlists', { offset: 0, limit: 3 });

    const sc = out.structuredContent;
    assert.ok(sc, 'structuredContent must be present');
    // listStructuredContent shape: { items, pagination: { total, offset, limit, next_offset } }
    assert.deepEqual(sc.pagination, { total: 10, offset: 0, limit: 3, next_offset: 3 });
    assert.equal(Array.isArray(sc.items), true);
    assert.deepEqual(sc.items, [
      playlistSimple('p1', 'A'),
      playlistSimple('p2', 'B'),
      playlistSimple('p3', 'C'),
    ]);
  });

  it('get_playlist_items truncates to max_results and reports next_offset in structuredContent', async () => {
    const items = Array.from({ length: 5 }, (_, i) => ({ item: playableTrack(`t${i}`, `T${i}`) }));
    const h = harness(() => ({ items, total: 40, limit: 100, offset: 0 }));

    const out = await h.invoke('get_playlist_items', { playlist_id: 'pl', max_results: 3 });

    const text = textOf(out);
    assert.match(text, /Playlist items \(40 total, showing 3\):/);
    // Footer counts rows collected by THIS call (the single fetched page),
    // while the header shows the playlist-wide total.
    assert.match(text, /\(2 more — pass offset or fetch_all\)/);
    const sc = out.structuredContent;
    assert.ok(sc);
    assert.deepEqual(sc.pagination, {
      total: 40,
      offset: 0,
      limit: 100,
      next_offset: 3,
    });
    assert.deepEqual(sc.items, items.slice(0, 3));
  });

  it('get_playlist_items response_format=json returns the raw API page', async () => {
    const page = { items: [{ item: playableTrack('t1', 'One') }], total: 1, limit: 100, offset: 0 };
    const h = harness(() => page);

    const out = await h.invoke('get_playlist_items', { playlist_id: 'pl', response_format: 'json' });

    assert.deepEqual(JSON.parse(textOf(out)), page);
  });

  it('get_playlist response_format=json dumps metadata plus fetched items', async () => {
    const metadata = { ...playlistSimple('pl9', 'JsonView'), images: [] };
    const h = harness((path) =>
      path === '/playlists/pl9' ? metadata : { items: [], total: 0 },
    );

    const out = await h.invoke('get_playlist', { id: 'pl9', response_format: 'json' });

    const parsed = JSON.parse(textOf(out));
    assert.equal(parsed.playlist.id, 'pl9');
    // Raw API shape: items arrive as the paged /items response object.
    assert.deepEqual(parsed.items, { items: [], total: 0 });
  });
});

// ---------------------------------------------------------------------------
// add_to_playlist dedupe awareness (#63)
// ---------------------------------------------------------------------------

describe('add_to_playlist check_duplicates (#63)', () => {
  const existingItems = [
    { item: playableTrack('t1', 'Already There') },
    { item: playableTrack('t2', 'Also There') },
  ];

  it('skips URIs already present and POSTs only the remainder', async () => {
    const h = harness((path) => {
      if (path === '/playlists/pl/items' && h.client.calls.length === 1) {
        return { items: existingItems, total: 2, limit: 100, offset: 0 };
      }
      return { snapshot_id: 'snap-add' };
    });

    const out = await h.invoke('add_to_playlist', {
      playlist_id: 'pl',
      uris: ['spotify:track:t1', 'spotify:track:new'],
      check_duplicates: true,
    });

    // First call is the prefetch GET, second the filtered POST.
    assert.equal(h.client.calls[0].method, 'GET');
    assert.equal(h.client.calls[0].path, '/playlists/pl/items');
    assert.deepEqual(wireCalls(h.client.calls.slice(1)), [
      { method: 'POST', path: '/playlists/pl/items', arg: { uris: ['spotify:track:new'] } },
    ]);
    const text = textOf(out);
    assert.match(text, /^Added 1 item\(s\) to playlist\./);
    assert.match(text, /Skipped 1 duplicate\(s\) already in the playlist\./);
    assert.match(text, /1 item affected: spotify:track:new/);
    assert.match(text, /Snapshot ID: snap-add$/);
  });

  it('POSTs nothing when every URI is already present', async () => {
    const h = harness((path) => {
      if (h.client.calls.length === 1) {
        return { items: existingItems, total: 2, limit: 100, offset: 0 };
      }
      assert.fail(`no mutating call expected, saw ${path}`);
    });

    const out = await h.invoke('add_to_playlist', {
      playlist_id: 'pl',
      uris: ['spotify:track:t1', 'spotify:track:t2'],
      check_duplicates: true,
    });

    assert.equal(h.client.calls.length, 1, 'only the prefetch GET may happen');
    assert.match(textOf(out), /All 2 URI\(s\) already present in playlist — nothing added\./);
  });

  it('defaults check_duplicates to false: appends blindly with a single request', async () => {
    const h = harness(() => null);

    await h.invoke('add_to_playlist', { playlist_id: 'pl', uris: ['spotify:track:a'] });

    assert.deepEqual(wireCalls(h.client.calls), [
      { method: 'POST', path: '/playlists/pl/items', arg: { uris: ['spotify:track:a'] } },
    ]);
  });
});

// ---------------------------------------------------------------------------
// find_duplicates_in_playlist (#63)
// ---------------------------------------------------------------------------

describe('find_duplicates_in_playlist (#63)', () => {
  it('groups exact-URI repeats with their positions', async () => {
    const items = [
      { item: playableTrack('t1', 'Song A') },
      { item: playableTrack('t2', 'Song B') },
      { item: playableTrack('t1', 'Song A') }, // exact repeat of t1
      { item: playableTrack('t3', 'Song C') },
      { item: playableTrack('t1', 'Song A') }, // third occurrence
    ];
    const h = harness((_path, params) => {
      // Single page carries everything; the walk must stop after it.
      assert.equal((params as Record<string, string>).limit, '100');
      return { items, total: items.length, limit: 100, offset: 0 };
    });

    const out = await h.invoke('find_duplicates_in_playlist', { playlist_id: 'pl' });

    assert.equal(h.client.calls.length, 1);
    const text = textOf(out);
    assert.match(text, /Found 1 duplicate group\(s\) across 5 scanned item\(s\):/);
    assert.match(text, /1\. "Song A" by Artist t1 — 3 occurrence\(s\) \[same URI\]/);
    assert.match(text, /URI: spotify:track:t1/);
    assert.match(text, /Positions \(0-based\): 0, 2, 4/);
    assert.match(text, /remove_from_playlist using \{ uri, positions \}/);
  });

  it('groups relinked duplicates: same name+artist under different URIs', async () => {
    const relinked = (id: string) => ({
      type: 'track',
      name: 'Same Song',
      uri: `spotify:track:${id}`,
      duration_ms: 200000,
      artists: [{ name: 'The Artist' }],
    });
    const items = [
      { item: relinked('original') },
      { item: playableTrack('other', 'Different Song') },
      { item: relinked('relinked-gb') },
    ];
    const h = harness(() => ({ items, total: items.length, limit: 100, offset: 0 }));

    const out = await h.invoke('find_duplicates_in_playlist', { playlist_id: 'pl' });

    const text = textOf(out);
    assert.match(text, /Found 1 duplicate group\(s\) across 3 scanned item\(s\):/);
    assert.match(text, /"Same Song" by The Artist — 2 occurrence\(s\) \[relinked \/ different URIs\]/);
    assert.match(text, /URIs: spotify:track:original, spotify:track:relinked-gb/);
    assert.match(text, /Positions \(0-based\): 0, 2/);
  });

  it('does not double-report single-URI identity repeats as relinked groups', async () => {
    const same = () => playableTrack('t1', 'Only One URI');
    const items = [{ item: same() }, { item: same() }];
    const h = harness(() => ({ items, total: items.length, limit: 100, offset: 0 }));

    const out = await h.invoke('find_duplicates_in_playlist', { playlist_id: 'pl' });

    const text = textOf(out);
    assert.match(text, /Found 1 duplicate group\(s\)/);
    assert.match(text, /\[same URI\]/);
    assert.ok(!text.includes('[relinked'), 'single-URI repeats must stay exact-uri groups');
  });

  it('reports no duplicates for a clean playlist', async () => {
    const items = [
      { item: playableTrack('t1', 'A') },
      { item: playableTrack('t2', 'B') },
    ];
    const h = harness(() => ({ items, total: items.length, limit: 100, offset: 0 }));

    const out = await h.invoke('find_duplicates_in_playlist', { playlist_id: 'pl' });

    assert.equal(textOf(out), 'No duplicates found across 2 scanned item(s).');
  });

  it('keeps unavailable (null-track) items occupying positions', async () => {
    const items = [
      { item: playableTrack('t1', 'A') },
      { track: null },
      { item: playableTrack('t1', 'A') },
    ];
    const h = harness(() => ({ items, total: items.length, limit: 100, offset: 0 }));

    const out = await h.invoke('find_duplicates_in_playlist', { playlist_id: 'pl' });

    assert.match(textOf(out), /Positions \(0-based\): 0, 2/);
  });
});

describe('create_playlist dry_run (issue #79)', () => {
  it('previews without any client call when dry_run=true', async () => {
    const h = harness();

    const out = await h.invoke('create_playlist', {
      name: 'Focus',
      description: 'Deep work',
      public: true,
      dry_run: true,
    });

    assert.equal(h.client.calls.length, 0, 'dry run must not call the API');
    assert.match(textOf(out), /\[dry run\] create_playlist/);
    assert.match(textOf(out), /"Focus"/);
  });
});

describe('get_playlist_items / get_playlist_cover id alias (issue #80)', () => {
  it('accepts { id } in place of playlist_id on both read tools', async () => {
    const h = harness((path: string) => (path.endsWith('/images') ? [] : { items: [], total: 0 }));

    await h.invoke('get_playlist_items', { id: 'pl1' });
    await h.invoke('get_playlist_cover', { id: 'pl1' });

    const paths = wireCalls(h.client.calls).map((c: { path: string }) => c.path);
    assert.ok(paths.some((p: string) => p.startsWith('/playlists/pl1/items')), paths.join(','));
    assert.ok(paths.some((p: string) => p === '/playlists/pl1/images'), paths.join(','));
  });

  it('rejects calls with neither playlist_id nor id', async () => {
    const h = harness();
    await assert.rejects(() => h.invoke('get_playlist_items', {}), /playlist_id/);
    await assert.rejects(() => h.invoke('get_playlist_cover', {}), /playlist_id/);
  });
});

describe('#110 playlist_id naming standardisation', () => {
  const readResponder = (path: string) => {
    if (path.endsWith('/images')) return [];
    if (path.endsWith('/items')) return { items: [], total: 0 };
    const id = path.split('/')[2];
    return playlistSimple(id, 'PL');
  };

  it('accepts canonical playlist_id on every tool that previously required id', async () => {
    const h = harness(readResponder);
    await h.invoke('get_playlist', { playlist_id: 'pl1' });
    await h.invoke('update_playlist', { playlist_id: 'pl1', name: 'X' });
    await h.invoke('get_playlist_items', { playlist_id: 'pl1' });
    await h.invoke('get_playlist_cover', { playlist_id: 'pl1' });

    assert.ok(h.client.calls.length >= 3, 'every invocation should reach the API');
    assert.ok(h.client.calls.every((c) => c.path.startsWith('/playlists/pl1')));
  });

  it('keeps the legacy id alias working on all four tools', async () => {
    const h = harness(readResponder);
    await h.invoke('get_playlist', { id: 'pl2' });
    await h.invoke('update_playlist', { id: 'pl2', name: 'Y' });
    await h.invoke('get_playlist_items', { id: 'pl2' });
    await h.invoke('get_playlist_cover', { id: 'pl2' });

    assert.ok(h.client.calls.every((c) => c.path.startsWith('/playlists/pl2')));
  });

  it('accepts id and playlist_id together when they agree', async () => {
    const h = harness(readResponder);
    await h.invoke('get_playlist_items', { playlist_id: 'pl3', id: 'pl3' });
    assert.equal(h.client.calls.length, 1);
    assert.equal(h.client.calls[0].path, '/playlists/pl3/items');
  });

  it('rejects conflicting id and playlist_id values before any API call', async () => {
    for (const tool of ['get_playlist', 'update_playlist', 'get_playlist_items', 'get_playlist_cover']) {
      const h = harness();
      await assert.rejects(
        () => h.invoke(tool, { playlist_id: 'aaa', id: 'bbb' }),
        /Conflicting values: playlist_id \("aaa"\) and id \("bbb"\)/,
        `${tool} must reject conflicting ids`,
      );
      assert.equal(h.client.calls.length, 0, `${tool} must not call the API on conflict`);
    }
  });

  it('error when neither parameter is supplied names both accepted params', async () => {
    for (const tool of ['get_playlist', 'update_playlist', 'get_playlist_items', 'get_playlist_cover']) {
      const h = harness();
      await assert.rejects(
        () => h.invoke(tool, {}),
        /playlist_id/,
        `${tool} missing-id error must name playlist_id`,
      );
      await assert.rejects(
        () => h.invoke(tool, {}),
        /\bid\b/,
        `${tool} missing-id error must name id`,
      );
    }
  });
});

describe('dry_run coverage for mutating playlist tools (issue #110)', () => {
  it('remove_from_playlist dry_run lists targets with zero mutating calls', async () => {
    const h = harness();
    const out = await h.invoke('remove_from_playlist', {
      playlist_id: 'pl1',
      uris: ['spotify:track:a', { uri: 'spotify:track:b', positions: [3, 7] }],
      dry_run: true,
    });
    const mut = wireCalls(h.client.calls).filter((c) => c.method === 'DELETE');
    assert.equal(mut.length, 0);
    assert.match(textOf(out), /\[dry run\] remove from playlist/);
    assert.match(textOf(out), /spotify:track:b @ 3,7/);
  });

  it('replace_playlist_items dry_run previews the overwrite without calls', async () => {
    const h = harness();
    const out = await h.invoke('replace_playlist_items', {
      playlist_id: 'pl2',
      uris: ['spotify:track:x', 'spotify:track:y'],
      dry_run: true,
    });
    assert.equal(h.client.calls.length, 0);
    assert.match(textOf(out), /Overwrite ALL existing items with 2 URI/);
  });

  it('update_playlist dry_run echoes changed fields', async () => {
    const h = harness((_p, _b) => ({ id: 'pl3' }));
    const out = await h.invoke('update_playlist', { id: 'pl3', name: 'New Name', public: false, dry_run: true });
    assert.equal(h.client.calls.length, 0);
    assert.match(textOf(out), /name → "New Name"/);
  });
});

// ---------------------------------------------------------------------------
// Elicitation-gated destructive playlist mutations (#111 item 5)
// ---------------------------------------------------------------------------

const accept = { action: 'accept', content: { confirm: true } };

describe('elicitation-gated destructive mutations (#111 item 5)', () => {
  it('remove_from_playlist with >=10 uris elicits then DELETEs on confirm', async () => {
    const h = harness(() => ({ snapshot_id: 'snap1' }), registerPlaylistTools, accept);
    const uris = Array.from({ length: 10 }, (_, i) => `spotify:track:r${i}`);
    const out = await h.invoke('remove_from_playlist', { playlist_id: 'pl1', uris });
    assert.equal(wireCalls(h.client.calls).filter((c) => c.method === 'DELETE').length, 1);
    assert.match(textOf(out), /Removed 10 item\(s\)/);
  });

  it('remove_from_playlist declining stub → zero DELETEs + cancelled result', async () => {
    const h = harness(
      () => ({ snapshot_id: 'snap1' }),
      registerPlaylistTools,
      { action: 'decline' },
    );
    const uris = Array.from({ length: 12 }, (_, i) => `spotify:track:r${i}`);
    const out = await h.invoke('remove_from_playlist', { playlist_id: 'pl1', uris });
    assert.equal(h.client.calls.length, 0);
    assert.match(textOf(out), /Cancelled — nothing was changed\./);
    assert.deepEqual(out.structuredContent, { ok: false, cancelled: true });
  });

  it('remove_from_playlist under threshold never elicits (no capability stub)', async () => {
    // Default harness has no elicitation support; a throw would surface as
    // rejection only if elicitInput were called — it must not be.
    const h = harness(() => ({ snapshot_id: 'snap1' }));
    const out = await h.invoke('remove_from_playlist', {
      playlist_id: 'pl1',
      uris: ['spotify:track:a'],
    });
    assert.equal(wireCalls(h.client.calls).filter((c) => c.method === 'DELETE').length, 1);
    assert.match(textOf(out), /Removed 1 item\(s\)/);
  });

  it('replace_playlist_items with >=50 uris elicits then PUTs on confirm', async () => {
    const h = harness(() => ({ snapshot_id: 'snap2' }), registerPlaylistTools, accept);
    const uris = Array.from({ length: 50 }, (_, i) => `spotify:track:n${i}`);
    const out = await h.invoke('replace_playlist_items', { playlist_id: 'pl2', uris });
    assert.equal(wireCalls(h.client.calls).filter((c) => c.method === 'PUT').length, 1);
    assert.match(textOf(out), /Replaced playlist contents with 50 item/);
  });

  it('replace_playlist_items declining stub → zero calls + cancelled result', async () => {
    const h = harness(
      () => ({ snapshot_id: 'snap2' }),
      registerPlaylistTools,
      { action: 'cancel' },
    );
    const uris = Array.from({ length: 60 }, (_, i) => `spotify:track:n${i}`);
    const out = await h.invoke('replace_playlist_items', { playlist_id: 'pl2', uris });
    assert.equal(h.client.calls.length, 0);
    assert.deepEqual(out.structuredContent, { ok: false, cancelled: true });
  });

  it('replace_playlist_items under threshold never elicits', async () => {
    const h = harness(() => ({ snapshot_id: 'snap3' }));
    const uris = ['spotify:track:a', 'spotify:track:b'];
    const out = await h.invoke('replace_playlist_items', { playlist_id: 'pl2', uris });
    assert.equal(h.client.calls.filter((c) => c.method === 'PUT').length, 1);
    assert.match(textOf(out), /Replaced playlist contents with 2 item/);
  });

  it('dry_run preview runs before any elicitation even at scale', async () => {
    const h = harness(undefined, registerPlaylistTools, new Error('must not elicit'));
    const uris = Array.from({ length: 15 }, (_, i) => `spotify:track:d${i}`);
    const out = await h.invoke('remove_from_playlist', { playlist_id: 'pl1', uris, dry_run: true });
    assert.equal(h.client.calls.length, 0);
    assert.match(textOf(out), /\[dry run\] remove from playlist/);
  });
});
