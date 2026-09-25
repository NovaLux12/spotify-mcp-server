/**
 * Tests for the saved-count and saved-search correctness fixes in
 * src/tools/library.ts:
 *
 *   #749 — get_saved_counts reported 0 for a collection whose read failed, so
 *          a throttled (429) or gated (403) collection looked empty. It must
 *          distinguish "read it, it was empty" from "could not read it",
 *          exclude the unreadable collection from the total, and say how many
 *          were unreadable. Rate limits are surfaced, never retried.
 *   #750 — search_saved_tracks / search_saved_albums accepted added_after /
 *          added_before without validating them, so a malformed date silently
 *          matched nothing (albums) or everything (tracks). Both must reject a
 *          bad bound with an error naming the parameter, before spending a walk.
 *
 * Stub MCP server + stub SpotifyClient — no network, no token file access.
 *
 * Run: node --import tsx --test tests/tools.librarycounts.test.ts
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { SpotifyClient } from '../src/client.js';
import { registerLibraryTools } from '../src/tools/library.js';

// ---------------------------------------------------------------------------
// Stub plumbing
// ---------------------------------------------------------------------------

interface RecordedCall {
  method: 'GET' | 'GET_ALL_PAGES';
  path: string;
  arg?: unknown;
}

type Responder = (path: string, arg: unknown) => unknown;

interface RegisteredTool {
  name: string;
  handler: (args: Record<string, unknown>) => Promise<{
    content: Array<{ type: string; text: string }>;
    structuredContent?: Record<string, unknown>;
  }>;
}

/**
 * Mirrors the real SpotifyApiError's public surface (client.ts:26-40) without
 * importing that module for its side effects. The production code duck-types
 * these fields, so this exercises the same path a real 429/403 takes.
 */
class FakeSpotifyApiError extends Error {
  constructor(
    public readonly status: number,
    message: string,
    public readonly retryAfterSec?: number,
    public readonly reason?: string,
  ) {
    super(message);
    this.name = 'SpotifyApiError';
  }
}

interface UnreadableDetail {
  message: string;
  status?: number;
  reason?: string;
  retry_after_sec?: number;
}

function harness(responder: Responder) {
  const calls: RecordedCall[] = [];
  const client = {
    calls,
    async get<T>(path: string, params?: Record<string, string>): Promise<T | null> {
      calls.push({ method: 'GET', path, arg: params });
      return responder(path, params) as T | null;
    },
    async getAllPages<T>(path: string, params?: Record<string, string>): Promise<T[]> {
      calls.push({ method: 'GET_ALL_PAGES', path, arg: params });
      return responder(path, params) as T[];
    },
  };

  const registered: RegisteredTool[] = [];
  const fakeServer = {
    tool(name: string, _desc: string, _schema: unknown, handler: RegisteredTool['handler']) {
      registered.push({ name, handler });
    },
  } as unknown as McpServer;
  registerLibraryTools(fakeServer, client as unknown as SpotifyClient);

  return {
    calls,
    invoke: (name: string, args: Record<string, unknown>) => {
      const tool = registered.find((t) => t.name === name);
      assert.ok(tool, `tool "${name}" should be registered`);
      return tool.handler(args);
    },
  };
}

const COUNT_PATHS = [
  '/me/tracks',
  '/me/albums',
  '/me/shows',
  '/me/episodes',
  '/me/audiobooks',
  '/me/playlists',
];

/** Every collection reads fine with the given totals. */
const totalsResponder = (totals: Record<string, number>): Responder => (path) => ({
  total: totals[path] ?? 0,
});

// ---------------------------------------------------------------------------
// #749 — unreadable collections are not zeros
// ---------------------------------------------------------------------------

describe('get_saved_counts: a collection that could not be read is not 0 (#749)', () => {
  it('reports a throttled collection as unreadable and excludes it from the total', async () => {
    const h = harness((path) => {
      if (path === '/me/shows') {
        throw new FakeSpotifyApiError(429, 'Rate limited — retry later.', 30, 'QUOTA_EXCEEDED');
      }
      return { total: 10 };
    });

    const res = await h.invoke('get_saved_counts', { response_format: 'concise' });
    const payload = res.structuredContent as Record<string, never>;
    const counts = payload.counts as unknown as Record<string, number>;
    const unreadable = payload.unreadable as unknown as Record<string, UnreadableDetail>;

    // "could not read" is reported as unreadable — never as a count of 0.
    assert.equal(Object.hasOwn(counts, 'shows'), false);
    assert.equal(counts.shows, undefined);
    assert.match(unreadable.shows.message, /Rate limited/);

    // The API's own diagnosis rides along structurally, so a caller can tell a
    // throttled read from a gated one without parsing prose.
    assert.equal(unreadable.shows.status, 429);
    assert.equal(unreadable.shows.reason, 'QUOTA_EXCEEDED');
    assert.equal(unreadable.shows.retry_after_sec, 30);

    // The total covers only what was actually read.
    assert.equal(payload.total, 50); // 5 readable collections x 10
    assert.equal(payload.collections_read, 5);
    assert.equal(payload.collections_total, 6);
    assert.equal(payload.unreadable_count, 1);
    assert.equal(payload.total_is_partial, true);

    // The summary says how many were unreadable and names them.
    assert.match(res.content[0].text, /shows: unreadable/);
    assert.match(res.content[0].text, /1 unreadable \(shows\) and excluded/);
  });

  it('distinguishes a gated (403) collection from a throttled (429) one', async () => {
    const h = harness((path) => {
      if (path === '/me/shows') throw new FakeSpotifyApiError(403, 'Forbidden — Premium required.');
      if (path === '/me/episodes') throw new FakeSpotifyApiError(429, 'Rate limited.');
      return { total: 2 };
    });

    const res = await h.invoke('get_saved_counts', { response_format: 'concise' });
    const unreadable = (res.structuredContent as Record<string, never>)
      .unreadable as unknown as Record<string, UnreadableDetail>;

    assert.equal(unreadable.shows.status, 403, 'a gated read is not the same failure as a throttled one');
    assert.equal(unreadable.episodes.status, 429);
    // Fields the client had no value for are absent, not zeroed.
    assert.equal(Object.hasOwn(unreadable.shows, 'retry_after_sec'), false);
  });

  it('does not retry a rate-limited collection', async () => {
    const h = harness((path) => {
      if (path === '/me/shows') throw new Error('Rate limited — retry later.');
      return { total: 3 };
    });

    await h.invoke('get_saved_counts', { response_format: 'concise' });

    const showsCalls = h.calls.filter((c) => c.path === '/me/shows');
    assert.equal(showsCalls.length, 1, 'a rate-limited collection must be attempted once, not retried');
    assert.equal(h.calls.length, COUNT_PATHS.length, 'each collection is read exactly once');
  });

  it('distinguishes a genuinely empty collection from an unreadable one', async () => {
    const h = harness((path) => {
      if (path === '/me/shows') throw new Error('Forbidden — Premium required.');
      return { total: path === '/me/tracks' ? 0 : 7 };
    });

    const res = await h.invoke('get_saved_counts', { response_format: 'concise' });
    const payload = res.structuredContent as Record<string, never>;
    const counts = payload.counts as unknown as Record<string, number>;

    // Looked and found zero.
    assert.equal(counts.tracks, 0);
    assert.match(res.content[0].text, /tracks: 0/);
    assert.doesNotMatch(res.content[0].text, /tracks: unreadable/);

    // Could not read.
    assert.equal(Object.hasOwn(counts, 'shows'), false);
    assert.match(res.content[0].text, /shows: unreadable/);
  });

  it('treats a response with no usable total as unreadable, not as 0', async () => {
    const h = harness((path) => {
      if (path === '/me/audiobooks') return null; // no body — nothing was learned
      if (path === '/me/playlists') return { total: 'many' }; // not a number
      return { total: 4 };
    });

    const res = await h.invoke('get_saved_counts', { response_format: 'concise' });
    const payload = res.structuredContent as Record<string, never>;
    const counts = payload.counts as unknown as Record<string, number>;
    const unreadable = payload.unreadable as unknown as Record<string, UnreadableDetail>;

    assert.equal(Object.hasOwn(counts, 'audiobooks'), false);
    assert.equal(Object.hasOwn(counts, 'playlists'), false);
    assert.match(unreadable.audiobooks.message, /no usable total/);
    assert.match(unreadable.playlists.message, /no usable total/);
    assert.equal(payload.unreadable_count, 2);
    assert.equal(payload.total, 16); // only tracks/albums/shows/episodes
  });

  it('reports a complete snapshot as complete when every read succeeds', async () => {
    const h = harness(
      totalsResponder({
        '/me/tracks': 1,
        '/me/albums': 2,
        '/me/shows': 0,
        '/me/episodes': 4,
        '/me/audiobooks': 5,
        '/me/playlists': 6,
      }),
    );

    const res = await h.invoke('get_saved_counts', { response_format: 'concise' });
    const payload = res.structuredContent as Record<string, never>;

    assert.equal(payload.total, 18);
    assert.equal(payload.unreadable_count, 0);
    assert.equal(payload.total_is_partial, false);
    assert.deepEqual(payload.unreadable, {});
    assert.match(res.content[0].text, /^Total: 18$/m);
    assert.doesNotMatch(res.content[0].text, /unreadable/);
  });
});

// ---------------------------------------------------------------------------
// #750 — added_after / added_before are validated
// ---------------------------------------------------------------------------

const savedTrack = (id: string, name: string, addedAt: string) => ({
  added_at: addedAt,
  track: {
    name,
    uri: `spotify:track:${id}`,
    duration_ms: 200000,
    artists: [{ name: 'Artist X' }],
  },
});

const savedAlbum = (id: string, name: string, addedAt: string) => ({
  added_at: addedAt,
  album: {
    name,
    uri: `spotify:album:${id}`,
    total_tracks: 10,
    release_date: '2025-05-05',
    artists: [{ name: 'Artist X' }],
  },
});

describe('search_saved_*: malformed date bounds are rejected, naming the parameter (#750)', () => {
  it('search_saved_albums rejects a malformed added_after instead of matching nothing', async () => {
    const h = harness(() => [
      savedAlbum('a1', 'One', '2026-01-01T00:00:00Z'),
      savedAlbum('a2', 'Two', '2026-06-01T00:00:00Z'),
    ]);

    await assert.rejects(
      h.invoke('search_saved_albums', { added_after: 'last tuesday', response_format: 'concise' }),
      (err: Error) => {
        assert.match(err.message, /added_after is not a valid date/);
        assert.match(err.message, /last tuesday/);
        return true;
      },
    );

    // The bad bound is caught before the walk, so it costs no API calls.
    assert.equal(h.calls.length, 0);
  });

  it('search_saved_tracks rejects a malformed added_after, naming added_after', async () => {
    const h = harness(() => [savedTrack('t1', 'One', '2026-01-01T00:00:00Z')]);

    await assert.rejects(
      h.invoke('search_saved_tracks', { added_after: '2026-13-45', response_format: 'concise' }),
      (err: Error) => {
        assert.match(err.message, /added_after is not a valid date/);
        assert.doesNotMatch(err.message, /added_before is not a valid date/);
        return true;
      },
    );
    assert.equal(h.calls.length, 0);
  });

  it('search_saved_tracks rejects a malformed added_before, naming added_before', async () => {
    const h = harness(() => [savedTrack('t1', 'One', '2026-01-01T00:00:00Z')]);

    // Pre-fix this silently dropped the filter and returned every match.
    await assert.rejects(
      h.invoke('search_saved_tracks', { added_before: 'yesterday', response_format: 'concise' }),
      (err: Error) => {
        assert.match(err.message, /added_before is not a valid date/);
        return true;
      },
    );
    assert.equal(h.calls.length, 0);
  });

  it('still filters correctly on a valid added_after', async () => {
    const h = harness(() => [
      savedTrack('t1', 'Old', '2026-01-01T00:00:00Z'),
      savedTrack('t2', 'New', '2026-06-01T00:00:00Z'),
    ]);

    const res = await h.invoke('search_saved_tracks', {
      added_after: '2026-03-01T00:00:00Z',
      response_format: 'concise',
    });
    const payload = res.structuredContent as Record<string, never>;

    assert.equal(payload.total_matches, 1);
    assert.equal(
      (payload.items as unknown as Array<{ track: { name: string } }>)[0].track.name,
      'New',
    );
  });

  it('still filters correctly on a valid added_after for albums', async () => {
    const h = harness(() => [
      savedAlbum('a1', 'Old', '2026-01-01T00:00:00Z'),
      savedAlbum('a2', 'New', '2026-06-01T00:00:00Z'),
    ]);

    const res = await h.invoke('search_saved_albums', {
      added_after: '2026-03-01',
      response_format: 'concise',
    });
    const payload = res.structuredContent as Record<string, never>;

    assert.equal(payload.matched, 1);
  });
});
