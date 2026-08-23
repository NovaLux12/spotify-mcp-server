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

    // limit/offset must NOT be sent; market survives.
    assert.deepEqual(h.client.calls[0].arg, { market: 'US' });

    const text = out.content[0].text;
    assert.match(text, /^Liked Songs \(3 fetched, capped at 500\):/);
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
      assert.deepEqual(h.client.calls[0].arg, {}, `${tool} should send no paging params`);
      assert.match(out.content[0].text, /0 fetched, capped at 500/);
    }
  });
});

// ---------------------------------------------------------------------------
// Mutations: save / remove / check
// ---------------------------------------------------------------------------

describe('save_items / remove_saved_items / check_saved_items', () => {
  it('save_items sends URIs in the PUT body to /me/library', async () => {
    const h = harness();
    const uris = ['spotify:track:abc', 'spotify:album:xyz'];

    const out = await h.invoke('save_items', { uris });

    assert.deepEqual(wireCalls(h.client.calls), [
      { method: 'PUT', path: '/me/library', arg: { uris } },
    ]);
    assert.match(out.content[0].text, /Saved 2 item\(s\) to library\./);
  });

  it('remove_saved_items sends URIs in the DELETE body to /me/library', async () => {
    const h = harness();

    const out = await h.invoke('remove_saved_items', { uris: ['spotify:show:r1'] });

    assert.deepEqual(wireCalls(h.client.calls), [
      { method: 'DELETE', path: '/me/library', arg: { uris: ['spotify:show:r1'] } },
    ]);
    assert.match(out.content[0].text, /Removed 1 item\(s\) from library\./);
  });

  it('check_saved_items joins URIs comma-separated against /me/library/contains', async () => {
    const h = harness(() => [true, false]);

    const out = await h.invoke('check_saved_items', {
      uris: ['spotify:track:yep', 'spotify:album:nope'],
    });

    assert.deepEqual(wireCalls(h.client.calls), [
      {
        method: 'GET',
        path: '/me/library/contains',
        arg: { uris: 'spotify:track:yep,spotify:album:nope' },
      },
    ]);

    const text = out.content[0].text;
    assert.match(text, /✓ spotify:track:yep/);
    assert.match(text, /✗ spotify:album:nope/);
    // Input order preserved in output.
    assert.ok(text.indexOf('yep') < text.indexOf('nope'));
  });

  it('check_saved_items reports ✗ for false results without flipping order', async () => {
    const h = harness(() => [false, true]);
    const out = await h.invoke('check_saved_items', {
      uris: ['spotify:episode:first', 'spotify:track:second'],
    });
    const text = out.content[0].text;
    assert.match(text, /✗ spotify:episode:first/);
    assert.match(text, /✓ spotify:track:second/);
  });
});

// ---------------------------------------------------------------------------
// Zod-enforced max bounds (validation happens at the MCP layer via schema)
// ---------------------------------------------------------------------------

describe('zod schema bounds (50/50/40)', () => {
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

  it('check_saved_items accepts 40 URIs and rejects 41', () => {
    const h = harness();
    const shape = h.shape('check_saved_items');
    const forty = Array.from({ length: 40 }, (_, i) => `spotify:track:id${i}`);
    assert.equal(shape.safeParse({ uris: forty }).success, true);
    assert.equal(shape.safeParse({ uris: [...forty, 'x'] }).success, false);
  });

  it('all three reject empty URI arrays (min 1)', () => {
    const h = harness();
    assert.equal(h.shape('save_items').safeParse({ uris: [] }).success, false);
    assert.equal(h.shape('remove_saved_items').safeParse({ uris: [] }).success, false);
    assert.equal(h.shape('check_saved_items').safeParse({ uris: [] }).success, false);
  });
});
