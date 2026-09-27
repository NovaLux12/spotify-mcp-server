/**
 * Tests for src/tools/library.ts (library tools: saved tracks/albums/shows/
 * episodes, counts, search, and the unified /me/library save/remove/check).
 *
 * #638 removed the three per-type tools — `save_items`, `remove_saved_items`
 * and `check_saved_items` — because every endpoint they addressed was removed
 * by Spotify in February 2026. The tests that asserted those endpoints went
 * with them; what is left here pins the unified surface and the absences.
 *
 * Uses a stub MCP server + stub SpotifyClient (records every call, returns
 * canned data) — no network, no token file access, no global fetch needed.
 *
 * Run: node --import tsx --test tests/tools.library.test.ts
 */

import './helpers/hermetic.js';

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { SpotifyApiError, type SpotifyClient } from '../src/client.js';
import { registerLibraryTools } from '../src/tools/library.js';
import { registerUndoTools } from '../src/tools/undo.js';

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

function harness(responder: Responder = () => null, opts: { withUndo?: boolean } = {}) {
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
    // The confirmation gate resolves the INNER host, exactly as McpServer does
    // (#684), so `withUndo` is given a host that advertises elicitation and
    // accepts — the same stand-in tests/tools.undo.test.ts uses, and the only
    // shape in which an undo reaches the wire instead of failing closed.
    ...(opts.withUndo
      ? {
          server: {
            getClientCapabilities: () => ({ elicitation: {} }),
            elicitInput: async () => ({ action: 'accept', content: { confirm: true } }),
          },
        }
      : {}),
  } as unknown as McpServer;
  const client = makeStubClient(responder);
  registerLibraryTools(fakeServer, client as unknown as SpotifyClient);
  if (opts.withUndo) registerUndoTools(fakeServer, client as unknown as SpotifyClient);

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
// Unified library endpoints (#37): save_to_library / remove_from_library /
// check_in_library against PUT|DELETE /me/library and GET /me/library/contains
// ---------------------------------------------------------------------------

describe('unified library tools (save_to_library / remove_from_library / check_in_library)', () => {
  it('save_to_library sends full URIs comma-separated as ?uris= on PUT /me/library and verifies via a receipt', async () => {
    const uris = [
      'spotify:track:abc',
      'spotify:album:xyz',
      'spotify:audiobook:a1',
      'spotify:user:wanda',
      'spotify:playlist:p1',
    ];
    const h = harness((path) =>
      path === '/me/library/contains' ? uris.map(() => true) : undefined,
    );

    const out = await h.invoke('save_to_library', { uris });

    const wires = wireCalls(h.client.calls);
    assert.deepEqual(wires.filter((c) => c.method === 'PUT'), [
      {
        method: 'PUT',
        path: `/me/library?uris=${encodeURIComponent(uris.join(','))}`,
        arg: undefined,
      },
    ]);
    // Receipt verification refetches /me/library/contains (one chunk, ≤50).
    const contains = wires.filter((c) => c.method === 'GET' && c.path === '/me/library/contains');
    assert.equal(contains.length, 1);
    assert.match(out.content[0].text, /Saved 5 item\(s\) to library\./);
    assert.match(out.content[0].text, /verified/i);
    const sc = out.structuredContent as { receipt?: { verified: boolean } };
    assert.equal(sc.receipt?.verified, true);
  });

  it('remove_from_library sends full URIs comma-separated as ?uris= on DELETE /me/library and verifies via a receipt', async () => {
    const uris = ['spotify:show:s1', 'spotify:episode:e1', 'spotify:user:wanda'];
    const h = harness((path) =>
      path === '/me/library/contains' ? uris.map(() => false) : undefined,
    );

    const out = await h.invoke('remove_from_library', { uris });

    assert.deepEqual(
      wireCalls(h.client.calls).filter((c) => c.method === 'DELETE'),
      [
        {
          method: 'DELETE',
          path: `/me/library?uris=${encodeURIComponent(uris.join(','))}`,
          arg: undefined,
        },
      ],
    );
    assert.match(out.content[0].text, /Removed 3 item\(s\) from library\./);
    // Post-removal contains returns false for everything → verified.
    const sc = out.structuredContent as { receipt?: { verified: boolean; missing: string[] } };
    assert.equal(sc.receipt?.verified, true);
    assert.deepEqual(sc.receipt?.missing, []);
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

  // #638: `contains[i]` is matched POSITIONALLY to `uris[i]`, so a body that is
  // not one boolean per requested URI is not a partial answer — it is a
  // mislabelled one. `?? false` used to turn the unmatchable rows into a
  // confident "✗ not saved", which is the #803 shape: a read that failed
  // reported as a read that found nothing. It now fails closed.
  it('check_in_library rejects a body whose length does not match the request, short or long', async () => {
    const uris = ['spotify:track:a', 'spotify:album:b', 'spotify:playlist:c'];
    for (const [label, body] of [
      ['short', [true, false]],
      ['long', [true, false, true, false]],
    ] as const) {
      const h = harness(() => body);
      await assert.rejects(
        h.invoke('check_in_library', { uris }),
        new RegExp(
          `Could not check library state: GET /me/library/contains returned ${body.length} of ${uris.length} ` +
            `for ${uris.length} URIs, so the per-URI flags cannot be matched to the request\\.`,
        ),
        `${label} body must not be read as per-URI flags`,
      );
    }
  });

  it('check_in_library rejects a non-array body instead of treating it as all-unsaved', async () => {
    const uris = ['spotify:track:a', 'spotify:album:b', 'spotify:playlist:c'];
    // A body Spotify would never send, but a proxy or a cached response might:
    // an object is truthy, so the old `if (!contains) throw` guard passed it.
    const h = harness(() => ({ items: [] }));
    await assert.rejects(
      h.invoke('check_in_library', { uris }),
      /Could not check library state: GET \/me\/library\/contains returned object for 3 URIs/,
    );
  });

  it('check_in_library rejects a body carrying a non-boolean flag', async () => {
    const uris = ['spotify:track:a', 'spotify:album:b', 'spotify:playlist:c'];
    // Right length, untyped contents. A truthy 'yes' would read as "saved";
    // a nullish one would read as "not saved". Neither is an answer.
    const h = harness(() => [true, 'yes', false]);
    await assert.rejects(
      h.invoke('check_in_library', { uris }),
      /Could not check library state: GET \/me\/library\/contains returned a non-boolean flag\./,
    );
  });

  it('check_in_library still reports a well-formed false as "not saved"', async () => {
    const h = harness(() => [true, false, true]);
    const out = await h.invoke('check_in_library', {
      uris: ['spotify:track:a', 'spotify:album:b', 'spotify:playlist:c'],
    });
    // The case that must NOT start throwing: `false` is a real answer, and the
    // fail-closed guard is about a body that cannot be read, not one that
    // says "no".
    assert.match(out.content[0].text, /✗ spotify:album:b/);
    const sc = out.structuredContent as { items: Array<{ uri: string; saved: boolean }> };
    assert.deepEqual(sc.items, [
      { uri: 'spotify:track:a', saved: true },
      { uri: 'spotify:album:b', saved: false },
      { uri: 'spotify:playlist:c', saved: true },
    ]);
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
    const out = await h.invoke('save_to_library', {
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
  it('remove_from_library dry_run makes zero client calls and previews every URI', async () => {
    const h = harness();
    const uris = ['spotify:track:abc', 'spotify:album:xyz'];

    const out = await h.invoke('remove_from_library', { uris, dry_run: true });

    assert.equal(h.client.calls.length, 0, 'dry_run must not touch the API');
    const text = out.content[0].text;
    assert.match(text, /^\[dry run\] remove_from_library on <<untrusted: user library >> — nothing was changed\./);
    assert.match(text, /Would affect 2 items:/);
    for (const uri of uris) assert.ok(text.includes(uri));
    const sc = out.structuredContent as Record<string, unknown>;
    assert.equal(sc.dry_run, true);
    assert.deepEqual(sc.would_affect, uris);
  });

  it('remove_from_library dry_run still rejects unsupported URI types before previewing', async () => {
    const h = harness();
    await assert.rejects(
      h.invoke('remove_from_library', { uris: ['https://not-a-uri'], dry_run: true }),
      /Unsupported URI type/,
    );
    assert.equal(h.client.calls.length, 0);
  });

  it('remove_from_library dry_run previews the playlist/user URI mix without any call', async () => {
    const h = harness();
    const uris = ['spotify:playlist:p1', 'spotify:user:wanda'];

    const out = await h.invoke('remove_from_library', { uris, dry_run: true });
    assert.equal(h.client.calls.length, 0, 'dry_run must not touch the API');
    const text = out.content[0].text;
    assert.match(text, /^\[dry run\] remove_from_library on <<untrusted: user library >> — nothing was changed\./);
    for (const uri of uris) assert.ok(text.includes(uri));
  });

  it('remove_from_library without dry_run still performs the DELETE (plus the receipt contains-check)', async () => {
    const h = harness((path) =>
      path === '/me/library/contains' ? [false] : undefined,
    );
    await h.invoke('remove_from_library', { uris: ['spotify:playlist:p1'] });
    assert.equal(
      h.client.calls.filter((c) => c.method === 'DELETE').length,
      1,
      'exactly one DELETE',
    );
  });
});

describe('confirmation-friendly batch summaries on mutations (#58)', () => {
  it('save_to_library echoes "{n} items affected" with the first URIs', async () => {
    const h = harness();
    const uris = ['spotify:track:abc', 'spotify:album:xyz', 'spotify:show:r1'];
    const out = await h.invoke('save_to_library', { uris });
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

  it('remove_from_library echoes the removed count and URIs', async () => {
    const h = harness();
    const out = await h.invoke('remove_from_library', { uris: ['spotify:audiobook:a1'] });
    assert.match(out.content[0].text, /Removed 1 item\(s\) from library\./);
    assert.match(out.content[0].text, /1 item affected: spotify:audiobook:a1/);
  });
});

describe('mutation receipts in json mode (#112 idea 11)', () => {
  it('json mode keeps the text payload parseable while the receipt rides structuredContent', async () => {
    const uris = ['spotify:track:rc1'];
    const h = harness((path) =>
      path === '/me/library/contains' ? [true] : undefined,
    );

    const out = await h.invoke('save_to_library', { uris, response_format: 'json' });

    // The text channel must remain valid JSON despite the appended receipt.
    const parsed = JSON.parse(out.content[0].text) as { ok: boolean; affected: number };
    assert.equal(parsed.ok, true);
    assert.equal(parsed.affected, 1);
    const sc = out.structuredContent as {
      receipt?: { verified: boolean };
    };
    assert.equal(sc.receipt?.verified, true);
  });
});

// ---------------------------------------------------------------------------
// #748: the write landed, the receipt read did not
//
// Promoted out of the `partial per-type writes (#748)` block when that block
// went with the per-type write tools (#638). The behaviour is the unified
// path's own: a failed verification read is a missing receipt, never a
// retracted write.
// ---------------------------------------------------------------------------

describe('a landed write survives a failed receipt read (#748)', () => {
  it('save_to_library keeps reporting the landed write when the receipt read fails', async () => {
    const h = harness((path) => {
      if (path === '/me/library/contains') throw new SpotifyApiError(403, 'No unified library access');
      return null;
    });

    const out = await h.invoke('save_to_library', { uris: ['spotify:track:t1'] });
    const sc = out.structuredContent as {
      ok: boolean;
      affected: number;
      receipt: unknown;
      receipt_error?: string;
    };

    assert.equal(sc.ok, true);
    assert.equal(sc.affected, 1);
    assert.equal(sc.receipt, null);
    assert.equal(sc.receipt_error, 'No unified library access');
    assert.match(out.content[0].text, /No receipt: verification failed \(No unified library access\)\./);
  });
});

// ---------------------------------------------------------------------------
// #638: `save_items` / `remove_saved_items` / `check_saved_items` are gone
//
// The first two wrote to `PUT`/`DELETE /me/{tracks,albums,shows,episodes,
// audiobooks}` and the third read `GET /me/{type}s/contains` — all removed in
// February 2026, with `/me/library` named as the replacement. What survives is
// the unified pair — as the mutator and as the only way to invert a library
// receipt.
// ---------------------------------------------------------------------------

/** The per-type library paths, matched without their query string. */
const PER_TYPE_LIBRARY = /^\/me\/(tracks|albums|shows|episodes|audiobooks)(\?|$)/;

describe('library registration after the per-type endpoint removal (#638)', () => {
  it('registers the unified tools and no longer registers save_items / remove_saved_items / check_saved_items', () => {
    const h = harness();

    const names = h.registered.map((t) => t.name);
    assert.deepEqual(
      [...names].sort(),
      [
        'check_in_library',
        'get_saved_albums',
        'get_saved_counts',
        'get_saved_episodes',
        'get_saved_shows',
        'get_saved_tracks',
        'remove_from_library',
        'save_to_library',
        'search_saved_albums',
        'search_saved_audiobooks',
        'search_saved_episodes',
        'search_saved_shows',
        'search_saved_tracks',
      ],
      'the library module registers exactly this set — no per-type library tool survives',
    );
    // Stated separately so a regression names the tools it lost.
    for (const removed of ['save_items', 'remove_saved_items', 'check_saved_items']) {
      assert.equal(
        names.includes(removed),
        false,
        `${removed} addressed per-type endpoints Spotify removed in Feb 2026`,
      );
    }
  });

  it('inverts a library receipt through /me/library only — never a per-type path', async () => {
    const uris = ['spotify:track:t1', 'spotify:show:s1', 'spotify:audiobook:b1'];
    const saved = new Set<string>();
    const h = harness(
      (path) => (path === '/me/library/contains' ? uris.map((uri) => saved.has(uri)) : undefined),
      { withUndo: true },
    );

    // Track the library the way a real account would, so the verification read
    // that follows each write observes the write that landed.
    const put = h.client.put.bind(h.client);
    const del = h.client.delete.bind(h.client);
    const applyWrite = (add: boolean, path: string) => {
      if (!path.startsWith('/me/library?')) return;
      const sent = new URLSearchParams(path.split('?')[1] ?? '').get('uris') ?? '';
      for (const uri of sent.split(',').filter(Boolean)) {
        if (add) saved.add(uri); else saved.delete(uri);
      }
    };
    h.client.put = async (path: string, body?: unknown) => { applyWrite(true, path); await put(path, body); };
    h.client.delete = async (path: string, body?: unknown) => { applyWrite(false, path); await del(path, body); };

    const receiptOf = (out: { structuredContent?: Record<string, unknown> }) => {
      const receipt = (out.structuredContent as { receipt?: { receipt_id: string; writes?: unknown } } | undefined)?.receipt;
      assert.ok(receipt?.receipt_id, 'the mutation issued a receipt');
      // The field undo used to branch on went with the tools that set it, so
      // there is nothing on a receipt that could route an inversion elsewhere.
      assert.equal(receipt.writes, undefined, 'a library receipt records no per-type buckets');
      return receipt.receipt_id;
    };

    const added = await h.invoke('save_to_library', { uris });
    const beforeUndo = h.client.calls.length;
    const undoneAdd = await h.invoke('undo_mutation', { receipt_id: receiptOf(added), dry_run: false });
    assert.equal(undoneAdd.structuredContent?.ok, true, undoneAdd.content[0]?.text);
    assert.deepEqual(
      wireCalls(h.client.calls.slice(beforeUndo)).filter((c) => c.method !== 'GET'),
      [{ method: 'DELETE', path: `/me/library?uris=${encodeURIComponent(uris.join(','))}`, arg: undefined }],
      'an added receipt inverts with DELETE /me/library, URI-encoded',
    );

    const removed = await h.invoke('remove_from_library', { uris });
    const beforeReAdd = h.client.calls.length;
    const undoneRemove = await h.invoke('undo_mutation', { receipt_id: receiptOf(removed), dry_run: false });
    assert.equal(undoneRemove.structuredContent?.ok, true, undoneRemove.content[0]?.text);
    assert.deepEqual(
      wireCalls(h.client.calls.slice(beforeReAdd)).filter((c) => c.method !== 'GET'),
      [{ method: 'PUT', path: `/me/library?uris=${encodeURIComponent(uris.join(','))}`, arg: undefined }],
      'a removed receipt re-adds with PUT /me/library, URI-encoded',
    );

    // The regression itself: across the whole mutate-then-undo round trip, no
    // per-type library path reaches the wire in either direction.
    assert.deepEqual(
      h.client.calls.filter((c) => PER_TYPE_LIBRARY.test(c.path)).map((c) => `${c.method} ${c.path}`),
      [],
      'undo_mutation has one library write to invert through, and it is /me/library',
    );
    assert.deepEqual([...saved].sort(), [...uris].sort(), 'both inversions landed');
  });
});
