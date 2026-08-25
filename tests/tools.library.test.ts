/**
 * Tests for src/tools/library.ts (library tools: saved tracks/albums/shows/
 * episodes, save/remove/check items).
 *
 * Uses a stub MCP server + stub SpotifyClient (records every call, returns
 * canned data) — no network, no token file access, no global fetch needed.
 *
 * Run: node --import tsx --test tests/tools.library.test.ts
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { SpotifyClient } from '../src/client.js';
import { registerLibraryTools } from '../src/tools/library.js';

// ---------------------------------------------------------------------------
// Stub plumbing
// ---------------------------------------------------------------------------

interface RecordedCall {
  method: 'GET' | 'POST' | 'PUT' | 'PUT_RAW' | 'DELETE' | 'GET_ALL_PAGES';
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
    async getAllPages<T>(
      path: string,
      params?: Record<string, string>,
      opts?: { maxItems?: number },
    ): Promise<T[]> {
      calls.push({ method: 'GET_ALL_PAGES', path, arg: params, extra: opts });
      return respond(path, params) as T[];
    },
  };
  return client;
}

function harness(responder: Responder = () => null) {
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
  registerLibraryTools(fakeServer, client as unknown as SpotifyClient);

  return {
    registered,
    client,
    invoke: (name: string, args: Record<string, unknown>) => {
      const tool = registered.find((t) => t.name === name);
      assert.ok(tool, `tool "${name}" should be registered`);
      return tool.handler(args);
    },
    shape: (name: string) => {
      const tool = registered.find((t) => t.name === name);
      assert.ok(tool, `tool "${name}" should be registered`);
      return z.object(tool.schema as z.ZodRawShape);
    },
  };
}

// ---------------------------------------------------------------------------
// Fixture builders
// ---------------------------------------------------------------------------

const savedTrack = (id: string, name: string, ms = 200000) => ({
  added_at: '2026-01-01T00:00:00Z',
  track: {
    name,
    uri: `spotify:track:${id}`,
    duration_ms: ms,
    artists: [{ name: `Artist ${id}` }],
  },
});

const savedAlbum = (id: string, name: string) => ({
  added_at: '2026-01-01T00:00:00Z',
  album: {
    name,
    uri: `spotify:album:${id}`,
    total_tracks: 10,
    release_date: '2025-05-05',
    artists: [{ name: `Artist ${id}` }],
  },
});

const savedShow = (id: string, name: string) => ({
  added_at: '2026-01-01T00:00:00Z',
  show: {
    name,
    uri: `spotify:show:${id}`,
    publisher: 'Pub Co',
    total_episodes: 42,
  },
});

const savedEpisode = (id: string, name: string) => ({
  added_at: '2026-01-01T00:00:00Z',
  episode: {
    name,
    uri: `spotify:episode:${id}`,
    duration_ms: 1800000,
    release_date: '2026-02-02',
    show: { name: 'Show X' },
  },
});

// ---------------------------------------------------------------------------
// Single-page mode: params forwarded + output shape
// ---------------------------------------------------------------------------

describe('get_saved_* single-page mode (param forwarding + output shape)', () => {
  it('get_saved_tracks forwards limit/offset/market and renders item lines', async () => {
    const h = harness((path) => {
      assert.equal(path, '/me/tracks');
      return {
        items: [savedTrack('t1', 'Song One')],
        total: 99,
        limit: 10,
        offset: 5,
        next: null,
        previous: null,
      };
    });

    const out = await h.invoke('get_saved_tracks', { limit: 10, offset: 5, market: 'US' });

    assert.equal(h.client.calls.length, 1);
    assert.deepEqual(wireCalls(h.client.calls), [
      { method: 'GET', path: '/me/tracks', arg: { limit: '10', offset: '5', market: 'US' } },
    ]);

    const text = out.content[0].text;
    assert.match(text, /^Liked Songs \(99 total, showing 1\):\n/);
    assert.match(text, /"Song One" by Artist t1 \(3:20\) \| URI: spotify:track:t1/);
  });

  it('get_saved_albums forwards limit/offset/market and renders album lines', async () => {
    const h = harness((path) => {
      assert.equal(path, '/me/albums');
      return { items: [savedAlbum('a1', 'Album One')], total: 7 };
    });

    const out = await h.invoke('get_saved_albums', { limit: 25, offset: 50, market: 'GB' });

    assert.deepEqual(wireCalls(h.client.calls), [
      { method: 'GET', path: '/me/albums', arg: { limit: '25', offset: '50', market: 'GB' } },
    ]);
    const text = out.content[0].text;
    assert.match(text, /^Saved albums \(7 total, showing 1\):/);
    assert.match(text, /"Album One" by Artist a1 \(10 tracks, 2025-05-05\) \| URI: spotify:album:a1/);
  });

  it('get_saved_shows forwards limit/offset (no market param exists) and renders shows', async () => {
    const h = harness((path) => {
      assert.equal(path, '/me/shows');
      return { items: [savedShow('s1', 'Show One')], total: 3 };
    });

    const out = await h.invoke('get_saved_shows', { limit: 5, offset: 15 });

    assert.deepEqual(wireCalls(h.client.calls), [
      { method: 'GET', path: '/me/shows', arg: { limit: '5', offset: '15' } },
    ]);
    const text = out.content[0].text;
    assert.match(text, /^Saved shows \(3 total, showing 1\):/);
    assert.match(text, /"Show One" by Pub Co \(42 episodes\) \| URI: spotify:show:s1/);
  });

  it('get_saved_episodes forwards market and renders episodes', async () => {
    const h = harness((path) => {
      assert.equal(path, '/me/episodes');
      return { items: [savedEpisode('e1', 'Ep One')], total: 12 };
    });

    const out = await h.invoke('get_saved_episodes', { market: 'DE' });

    assert.deepEqual(wireCalls(h.client.calls), [
      { method: 'GET', path: '/me/episodes', arg: { limit: '20', market: 'DE' } },
    ]);
    const text = out.content[0].text;
    assert.match(text, /^Saved episodes \(12 total, showing 1\):/);
    assert.match(text, /"Ep One" — Show X \(30:00, 2026-02-02\) \| URI: spotify:episode:e1/);
  });

  it('applies documented defaults (limit 20, no offset) when args are omitted', async () => {
    const h = harness(() => ({ items: [], total: 0 }));
    await h.invoke('get_saved_tracks', {});
    assert.deepEqual(h.client.calls[0].arg, { limit: '20' });
  });

  it('throws when the API returns null (no result)', async () => {
    const h = harness(() => null);
    await assert.rejects(
      () => h.invoke('get_saved_tracks', {}),
      /Could not retrieve saved tracks/,
    );
  });
});

// ---------------------------------------------------------------------------
// fetch_all mode
// ---------------------------------------------------------------------------

describe('get_saved_* fetch_all mode (getAllPages switch)', () => {
  it('routes to getAllPages, drops limit/offset, keeps market, and aggregates', async () => {
    const h = harness((path) => {
      assert.equal(path, '/me/tracks');
      return [savedTrack('t1', 'One'), savedTrack('t2', 'Two'), savedTrack('t3', 'Three')];
    });

    const out = await h.invoke('get_saved_tracks', {
      limit: 10,
      offset: 5,
      market: 'US',
      fetch_all: true,
    });

    // getAllPages used, plain get NOT used.
    const methods = h.client.calls.map((c) => c.method);
    assert.deepEqual(methods, ['GET_ALL_PAGES']);
    assert.equal(h.client.calls[0].path, '/me/tracks');

    // fetch_all now forces limit=50; offset is dropped, market survives.
    assert.deepEqual(h.client.calls[0].arg, { market: 'US', limit: '50' });

    const text = out.content[0].text;
    assert.match(text, /^Liked Songs \(3 fetched, showing 3\):/);
    assert.match(text, /"Three" by Artist t3/);
  });

  it('getAllPages mode for albums/shows/episodes hits the right endpoints', async () => {
    for (const [tool, endpoint] of [
      ['get_saved_albums', '/me/albums'],
      ['get_saved_shows', '/me/shows'],
      ['get_saved_episodes', '/me/episodes'],
    ] as const) {
      const h = harness((path) => {
        assert.equal(path, endpoint);
        return [];
      });
      const out = await h.invoke(tool, { fetch_all: true, limit: 1, offset: 9 });
      assert.deepEqual(h.client.calls.map((c) => c.method), ['GET_ALL_PAGES'], tool);
      assert.deepEqual(h.client.calls[0].arg, { limit: '50' }, `${tool} should send limit=50 and no paging offset`);
      assert.match(out.content[0].text, /0 fetched, showing 0/);
    }
  });
});

// ---------------------------------------------------------------------------
// Mutations: save / remove / check
// ---------------------------------------------------------------------------

describe('save_items / remove_saved_items / check_saved_items', () => {
  it('save_items sends track/album ids in the PUT body but show ids as ?ids= (#12)', async () => {
    const h = harness();
    const uris = ['spotify:track:abc', 'spotify:album:xyz', 'spotify:show:r1'];

    const out = await h.invoke('save_items', { uris });

    assert.deepEqual(wireCalls(h.client.calls), [
      { method: 'PUT', path: '/me/tracks', arg: { ids: ['abc'] } },
      { method: 'PUT', path: '/me/albums', arg: { ids: ['xyz'] } },
      // Shows take ids ONLY as a query param: any body ids are ignored by Spotify.
      { method: 'PUT', path: '/me/shows?ids=r1', arg: undefined },
    ]);
    assert.match(out.content[0].text, /Saved 3 item\(s\) to library/);
  });

  it('remove_saved_items sends show ids as DELETE ?ids= query param, not body (#12)', async () => {
    const h = harness();

    const out = await h.invoke('remove_saved_items', { uris: ['spotify:show:r1'] });

    assert.deepEqual(wireCalls(h.client.calls), [
      { method: 'DELETE', path: '/me/shows?ids=r1', arg: undefined },
    ]);
    assert.match(out.content[0].text, /Removed 1 item\(s\) from library\./);
  });

  it('check_saved_items joins URIs comma-separated against /me/library/contains', async () => {
    const h = harness((path) => (path === '/me/tracks/contains' ? [true] : [false]));

    const out = await h.invoke('check_saved_items', {
      uris: ['spotify:track:yep', 'spotify:album:nope'],
    });

    assert.deepEqual(wireCalls(h.client.calls), [
      {
        method: 'GET',
        path: '/me/tracks/contains',
        arg: { ids: 'yep' },
      },
      {
        method: 'GET',
        path: '/me/albums/contains',
        arg: { ids: 'nope' },
      },
    ]);

    const text = out.content[0].text;
    assert.match(text, /✓ spotify:track:yep/);
    assert.match(text, /✗ spotify:album:nope/);
    // Input order preserved in output.
    assert.ok(text.indexOf('yep') < text.indexOf('nope'));
  });

  it('check_saved_items reports ✗ for false results without flipping order', async () => {
    const h = harness((path) => (path === '/me/tracks/contains' ? [true] : [false]));
    const out = await h.invoke('check_saved_items', {
      uris: ['spotify:episode:first', 'spotify:track:second'],
    });
    const text = out.content[0].text;
    assert.match(text, /✗ spotify:episode:first/);
    assert.match(text, /✓ spotify:track:second/);
  });

  it('save_items routes audiobook ids via PUT /me/audiobooks?ids= (#36)', async () => {
    const h = harness();

    const out = await h.invoke('save_items', {
      uris: ['spotify:track:abc', 'spotify:audiobook:a1', 'spotify:audiobook:a2'],
    });

    assert.deepEqual(wireCalls(h.client.calls), [
      { method: 'PUT', path: '/me/tracks', arg: { ids: ['abc'] } },
      // Audiobooks take ids ONLY as a query param, like shows (#12, #36).
      { method: 'PUT', path: '/me/audiobooks?ids=a1%2Ca2', arg: undefined },
    ]);
    assert.match(out.content[0].text, /Saved 3 item\(s\) to library.*2 audiobooks/);
  });

  it('remove_saved_items sends audiobook ids as DELETE ?ids= query param (#36)', async () => {
    const h = harness();

    const out = await h.invoke('remove_saved_items', { uris: ['spotify:audiobook:a1'] });

    assert.deepEqual(wireCalls(h.client.calls), [
      { method: 'DELETE', path: '/me/audiobooks?ids=a1', arg: undefined },
    ]);
    assert.match(out.content[0].text, /Removed 1 item\(s\) from library\./);
  });

  it('check_saved_items checks audiobooks via GET /me/audiobooks/contains (#36)', async () => {
    const h = harness((path) => (path === '/me/audiobooks/contains' ? [true] : [false]));

    const out = await h.invoke('check_saved_items', {
      uris: ['spotify:audiobook:hitchhikers'],
    });

    assert.deepEqual(wireCalls(h.client.calls), [
      { method: 'GET', path: '/me/audiobooks/contains', arg: { ids: 'hitchhikers' } },
    ]);
    assert.match(out.content[0].text, /✓ spotify:audiobook:hitchhikers/);
  });
});

// ---------------------------------------------------------------------------
// Zod-enforced max bounds (validation happens at the MCP layer via schema)
// ---------------------------------------------------------------------------

describe('zod schema bounds (50/50/50)', () => {
  it('save_items accepts 50 URIs and rejects 51', () => {
    const h = harness();
    const shape = h.shape('save_items');
    const fifty = Array.from({ length: 50 }, (_, i) => `spotify:track:id${i}`);
    assert.equal(shape.safeParse({ uris: fifty }).success, true);
    const fiftyOne = [...fifty, 'spotify:track:extra'];
    assert.equal(shape.safeParse({ uris: fiftyOne }).success, false);
  });

  it('remove_saved_items accepts 50 URIs and rejects 51', () => {
    const h = harness();
    const shape = h.shape('remove_saved_items');
    const fifty = Array.from({ length: 50 }, (_, i) => `spotify:track:id${i}`);
    assert.equal(shape.safeParse({ uris: fifty }).success, true);
    assert.equal(shape.safeParse({ uris: [...fifty, 'x'] }).success, false);
  });

  it('check_saved_items accepts 50 URIs and rejects 51 (#66)', () => {
    const h = harness();
    const shape = h.shape('check_saved_items');
    const fifty = Array.from({ length: 50 }, (_, i) => `spotify:track:id${i}`);
    assert.equal(shape.safeParse({ uris: fifty }).success, true);
    assert.equal(shape.safeParse({ uris: [...fifty, 'x'] }).success, false);
  });

  it('all three reject empty URI arrays (min 1)', () => {
    const h = harness();
    assert.equal(h.shape('save_items').safeParse({ uris: [] }).success, false);
    assert.equal(h.shape('remove_saved_items').safeParse({ uris: [] }).success, false);
    assert.equal(h.shape('check_saved_items').safeParse({ uris: [] }).success, false);
  });
});

// ---------------------------------------------------------------------------
// Unified library endpoints (#37): save_to_library / remove_from_library /
// check_in_library against PUT|DELETE /me/library and GET /me/library/contains
// ---------------------------------------------------------------------------

describe('unified library tools (save_to_library / remove_from_library / check_in_library)', () => {
  it('save_to_library sends full URIs comma-separated as ?uris= on PUT /me/library', async () => {
    const h = harness();
    const uris = [
      'spotify:track:abc',
      'spotify:album:xyz',
      'spotify:audiobook:a1',
      'spotify:user:wanda',
      'spotify:playlist:p1',
    ];

    const out = await h.invoke('save_to_library', { uris });

    assert.deepEqual(wireCalls(h.client.calls), [
      {
        method: 'PUT',
        path: `/me/library?uris=${encodeURIComponent(uris.join(','))}`,
        arg: undefined,
      },
    ]);
    assert.match(out.content[0].text, /Saved 5 item\(s\) to library\./);
  });

  it('remove_from_library sends full URIs comma-separated as ?uris= on DELETE /me/library', async () => {
    const h = harness();
    const uris = ['spotify:show:s1', 'spotify:episode:e1', 'spotify:user:wanda'];

    const out = await h.invoke('remove_from_library', { uris });

    assert.deepEqual(wireCalls(h.client.calls), [
      {
        method: 'DELETE',
        path: `/me/library?uris=${encodeURIComponent(uris.join(','))}`,
        arg: undefined,
      },
    ]);
    assert.match(out.content[0].text, /Removed 3 item\(s\) from library\./);
  });

  it('check_in_library queries /me/library/contains once, accepting artist/user/playlist URIs in order', async () => {
    const h = harness(() => [true, false, true]);
    const uris = ['spotify:artist:art1', 'spotify:user:wanda', 'spotify:playlist:p1'];

    const out = await h.invoke('check_in_library', { uris });

    assert.deepEqual(wireCalls(h.client.calls), [
      { method: 'GET', path: '/me/library/contains', arg: { uris: uris.join(',') } },
    ]);
    const text = out.content[0].text;
    assert.match(text, /✓ spotify:artist:art1/);
    assert.match(text, /✗ spotify:user:wanda/);
    assert.match(text, /✓ spotify:playlist:p1/);
    // Input order preserved in output.
    assert.ok(
      text.indexOf('art1') < text.indexOf('wanda') && text.indexOf('wanda') < text.indexOf('p1'),
    );
  });

  it('rejects artist URIs on save/remove — PUT/DELETE /me/library do not accept artists', async () => {
    const h = harness();
    await assert.rejects(
      h.invoke('save_to_library', { uris: ['spotify:artist:x'] }),
      /Unsupported URI type: spotify:artist:x/,
    );
    await assert.rejects(
      h.invoke('remove_from_library', { uris: ['spotify:artist:x'] }),
      /Unsupported URI type/,
    );
    // …but the same URI is fine on contains.
    const h2 = harness(() => [true]);
    await h2.invoke('check_in_library', { uris: ['spotify:artist:x'] });
  });

  it('rejects non-spotify URIs with a helpful message listing supported types', async () => {
    const h = harness();
    await assert.rejects(
      h.invoke('check_in_library', { uris: ['https://open.spotify.com/track/x'] }),
      /Unsupported URI type.*supported:/i,
    );
  });
});

// ---------------------------------------------------------------------------
// Zod-enforced max bounds for unified tools (API caps at 40 URIs)
// ---------------------------------------------------------------------------

describe('zod schema bounds for unified tools (40 max)', () => {
  it('save_to_library accepts 40 URIs and rejects 41', () => {
    const h = harness();
    const shape = h.shape('save_to_library');
    const forty = Array.from({ length: 40 }, (_, i) => `spotify:track:id${i}`);
    assert.equal(shape.safeParse({ uris: forty }).success, true);
    assert.equal(shape.safeParse({ uris: [...forty, 'x'] }).success, false);
  });

  it('remove_from_library accepts 40 URIs and rejects 41', () => {
    const h = harness();
    const shape = h.shape('remove_from_library');
    const forty = Array.from({ length: 40 }, (_, i) => `spotify:track:id${i}`);
    assert.equal(shape.safeParse({ uris: forty }).success, true);
    assert.equal(shape.safeParse({ uris: [...forty, 'x'] }).success, false);
  });

  it('check_in_library accepts 40 URIs and rejects 41', () => {
    const h = harness();
    const shape = h.shape('check_in_library');
    const forty = Array.from({ length: 40 }, (_, i) => `spotify:artist:id${i}`);
    assert.equal(shape.safeParse({ uris: forty }).success, true);
    assert.equal(shape.safeParse({ uris: [...forty, 'x'] }).success, false);
  });

  it('all three reject empty URI arrays (min 1)', () => {
    const h = harness();
    assert.equal(h.shape('save_to_library').safeParse({ uris: [] }).success, false);
    assert.equal(h.shape('remove_from_library').safeParse({ uris: [] }).success, false);
    assert.equal(h.shape('check_in_library').safeParse({ uris: [] }).success, false);
  });
});

// ---------------------------------------------------------------------------
// Shared shaping: response_format (#51), truncation + structuredContent
// (#52/#53), dry_run (#57), batch summaries (#58)
// ---------------------------------------------------------------------------

describe('response_format json mode returns machine-readable payloads (#51)', () => {
  it('get_saved_tracks json mode parses to items + pagination', async () => {
    const h = harness(() => ({
      items: [savedTrack('t1', 'One')],
      total: 99,
      limit: 20,
      offset: 0,
      next: null,
      previous: null,
    }));
    const out = await h.invoke('get_saved_tracks', { response_format: 'json' });

    const payload = JSON.parse(out.content[0].text);
    assert.equal(payload.items.length, 1);
    assert.equal(payload.items[0].track.uri, 'spotify:track:t1');
    assert.equal(payload.pagination.total, 99);
    assert.equal(payload.pagination.offset, 0);
    assert.equal(payload.pagination.next_offset, 1);
    assert.deepEqual(out.structuredContent, payload);
    // No prose header in json mode.
    assert.ok(!out.content[0].text.startsWith('Liked Songs'));
  });

  it('mutation json output reports ok/affected/uris', async () => {
    const h = harness();
    const out = await h.invoke('save_items', {
      uris: ['spotify:track:abc'],
      response_format: 'json',
    });
    const payload = JSON.parse(out.content[0].text);
    assert.equal(payload.ok, true);
    assert.equal(payload.affected, 1);
    assert.deepEqual(payload.uris, ['spotify:track:abc']);
  });
});

describe('max_results truncation + pagination info (#52/#53)', () => {
  it('get_saved_tracks slices to max_results and appends the more-footer', async () => {
    const many = Array.from({ length: 5 }, (_, i) => savedTrack(`t${i}`, `Song ${i}`));
    const h = harness(() => ({ items: many, total: 5, limit: 50, offset: 0 }));

    const out = await h.invoke('get_saved_tracks', { max_results: 2 });

    const text = out.content[0].text;
    assert.match(text, /^Liked Songs \(5 total, showing 2\):/);
    assert.match(text, /\(3 more — pass offset or fetch_all\)/);
    assert.ok(!text.includes('Song 2'));
    const sc = out.structuredContent as { items: unknown[]; pagination: Record<string, unknown> };
    assert.equal(sc.items.length, 2);
    assert.equal(sc.pagination.next_offset, 2);
  });

  it('single-page results carry a next-offset hint when the API page is shorter than total', async () => {
    const h = harness(() => ({
      items: [savedTrack('t1', 'One'), savedTrack('t2', 'Two')],
      total: 10,
      limit: 2,
      offset: 0,
    }));
    const out = await h.invoke('get_saved_tracks', { limit: 2, offset: 0 });
    assert.match(out.content[0].text, /\(More available — pass offset=2 for the next page\)/);
  });

  it('fetch_all respects max_results with a max_results-specific footer', async () => {
    const all = Array.from({ length: 4 }, (_, i) => savedTrack(`t${i}`, `Song ${i}`));
    const h = harness(() => all);
    const out = await h.invoke('get_saved_tracks', { fetch_all: true, max_results: 3 });
    const text = out.content[0].text;
    assert.match(text, /^Liked Songs \(4 fetched, showing 3\):/);
    assert.match(text, /\(1 more — pass max_results to raise this call's cap\)/);
  });

  it('check_saved_items truncates its per-URI listing via max_results', async () => {
    const h = harness((path) => (path === '/me/tracks/contains' ? [true] : [false]));
    const out = await h.invoke('check_saved_items', {
      uris: ['spotify:track:a', 'spotify:album:b', 'spotify:show:c'],
      max_results: 2,
    });
    const text = out.content[0].text;
    assert.match(text, /✓ spotify:track:a/);
    assert.match(text, /✗ spotify:album:b/);
    assert.ok(!text.includes('spotify:show:c'));
    assert.match(text, /\(1 more — pass offset or fetch_all\)/);
    const sc = out.structuredContent as { items: Array<{ uri: string; saved: boolean }> };
    assert.deepEqual(sc.items, [
      { uri: 'spotify:track:a', saved: true },
      { uri: 'spotify:album:b', saved: false },
    ]);
  });

  it('check_in_library truncates identically and keeps input order', async () => {
    const h = harness(() => [true, false, true]);
    const uris = ['spotify:artist:a1', 'spotify:user:wanda', 'spotify:playlist:p1'];
    const out = await h.invoke('check_in_library', { uris, max_results: 2 });
    const text = out.content[0].text;
    assert.ok(!text.includes('p1'));
    assert.match(text, /\(1 more — pass offset or fetch_all\)/);
    const sc = out.structuredContent as { pagination: { next_offset: number | null } };
    assert.equal(sc.pagination.next_offset, 2);
  });
});

describe('dry_run previews destructive operations without any mutating call (#57)', () => {
  it('remove_saved_items dry_run makes zero client calls and previews every URI', async () => {
    const h = harness();
    const uris = ['spotify:track:abc', 'spotify:album:xyz'];

    const out = await h.invoke('remove_saved_items', { uris, dry_run: true });

    assert.equal(h.client.calls.length, 0, 'dry_run must not touch the API');
    const text = out.content[0].text;
    assert.match(text, /^\[dry run\] remove_saved_items on user library — nothing was changed\./);
    assert.match(text, /Would affect 2 items:/);
    for (const uri of uris) assert.ok(text.includes(uri));
    const sc = out.structuredContent as Record<string, unknown>;
    assert.equal(sc.dry_run, true);
    assert.deepEqual(sc.would_affect, uris);
  });

  it('remove_saved_items dry_run still rejects unsupported URI types before previewing', async () => {
    const h = harness();
    await assert.rejects(
      h.invoke('remove_saved_items', { uris: ['https://not-a-uri'], dry_run: true }),
      /Unsupported URI type/,
    );
    assert.equal(h.client.calls.length, 0);
  });

  it('remove_from_library dry_run makes zero client calls and previews every URI', async () => {
    const h = harness();
    const uris = ['spotify:playlist:p1', 'spotify:user:wanda'];

    const out = await h.invoke('remove_from_library', { uris, dry_run: true });
    assert.equal(h.client.calls.length, 0, 'dry_run must not touch the API');
    const text = out.content[0].text;
    assert.match(text, /^\[dry run\] remove_from_library on user library — nothing was changed\./);
    for (const uri of uris) assert.ok(text.includes(uri));
  });

  it('remove_from_library without dry_run still performs the DELETE', async () => {
    const h = harness();
    await h.invoke('remove_from_library', { uris: ['spotify:playlist:p1'] });
    assert.equal(h.client.calls.length, 1);
    assert.equal(h.client.calls[0].method, 'DELETE');
  });
});

describe('confirmation-friendly batch summaries on mutations (#58)', () => {
  it('save_items echoes "{n} items affected" with the first URIs', async () => {
    const h = harness();
    const uris = ['spotify:track:abc', 'spotify:album:xyz', 'spotify:show:r1'];
    const out = await h.invoke('save_items', { uris });
    assert.match(
      out.content[0].text,
      /3 items affected: spotify:track:abc, spotify:album:xyz, spotify:show:r1/,
    );
  });

  it('long batches are abbreviated after three URIs with an ellipsis', async () => {
    const h = harness();
    const four = Array.from({ length: 4 }, (_, i) => `spotify:track:id${i}`);
    const out = await h.invoke('save_to_library', { uris: four });
    const summaryLine = out.content[0].text.split('\n')[1];
    assert.equal(
      summaryLine,
      '4 items affected: spotify:track:id0, spotify:track:id1, spotify:track:id2…',
    );
  });

  it('remove_saved_items echoes the removed count and URIs', async () => {
    const h = harness();
    const out = await h.invoke('remove_saved_items', { uris: ['spotify:audiobook:a1'] });
    assert.match(out.content[0].text, /Removed 1 item\(s\) from library\./);
    assert.match(out.content[0].text, /1 item affected: spotify:audiobook:a1/);
  });
});
