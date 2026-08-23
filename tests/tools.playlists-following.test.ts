/**
 * Tests for src/tools/playlists.ts and src/tools/following.ts.
 *
 * Uses a stub MCP server + stub SpotifyClient (records every call, returns
 * canned data) — no network, no token file access, no global fetch needed.
 *
 * Run: node --import tsx --test tests/tools.playlists-following.test.ts
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { SpotifyClient } from '../src/client.js';
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
  schema: unknown;
  handler: (args: Record<string, unknown>) => Promise<{ content: Array<{ type: string; text: string }> }>;
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
    async put(path: string, body?: unknown): Promise<void> {
      calls.push({ method: 'PUT', path, arg: body });
      await respond(path, body);
    },
    async putRaw(path: string, body: string, contentType?: string): Promise<void> {
      calls.push({ method: 'PUT_RAW', path, arg: body, extra: contentType });
      await respond(path, body);
    },
    async delete(path: string, body?: unknown): Promise<void> {
      calls.push({ method: 'DELETE', path, arg: body });
      await respond(path, body);
    },
  };
  return client;
}

function harness(responder: Responder = () => null, registerFn: Registrar = registerPlaylistTools) {
  const registered: RegisteredTool[] = [];
  const fakeServer = {
    tool(
      name: string,
      description: string,
      schema: unknown,
      handler: RegisteredTool['handler'],
    ) {
      registered.push({ name, description, schema, handler });
    },
  } as unknown as McpServer;
  const client = makeStubClient(responder);
  registerFn(fakeServer, client as unknown as SpotifyClient);

  return {
    registered,
    client,
    invoke: (name: string, args: Record<string, unknown>) => {
      const tool = registered.find((t) => t.name === name);
      assert.ok(tool, `tool "${name}" should be registered`);
      return tool.handler(args);
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
  tracks: { total: trackTotal },
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

  it('fetch_all pages via offset until the 500 cap, reusing the same limit', async () => {
    // First page: 1 playlist of a claimed 1000 total. Second page: 499 more.
    // Loop stops at exactly 500 (FETCH_ALL_CAP), never requesting a third page.
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

    assert.equal(h.client.calls.length, 2);
    const text = textOf(out);
    assert.match(text, /Your playlists \(1000 total, showing 500\):/);
    assert.match(text, /"PL 498"/); // last item of the capped aggregate
  });

  it('renders each playlist line with owner fallback to owner.id', async () => {
    const h = harness(() => ({
      items: [{ ...playlistSimple('p1', 'Mix'), owner: { id: 'uid42', display_name: null } }],
      total: 1,
    }));
    const out = await h.invoke('get_user_playlists', {});
    assert.match(textOf(out), /"Mix" by uid42 \(3 tracks\) \| ID: p1 \| URI: spotify:playlist:p1/);
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
        return { items: [{ track: playableTrack('t1', 'Highway') }], total: 1 };
      }
      assert.fail(`unexpected path: ${path}`);
    });

    const out = await h.invoke('get_playlist', { id: 'pl1' });

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
        : { items: [{ track: playableTrack('t9', 'Nine') }], total: 30 },
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

    await h.invoke('update_playlist', { id: 'pl', name: 'New Name', public: false });
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
  it('converts bare IDs to spotify:artist:{id} URIs against /me/library/contains', async () => {
    const h = harness(() => [true, false, true], registerFollowingTools);

    const out = await h.invoke('check_following_artists', { ids: ['aa', 'bb', 'cc'] });

    assert.deepEqual(wireCalls(h.client.calls), [
      {
        method: 'GET',
        path: '/me/library/contains',
        arg: { uris: 'spotify:artist:aa,spotify:artist:bb,spotify:artist:cc' },
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
