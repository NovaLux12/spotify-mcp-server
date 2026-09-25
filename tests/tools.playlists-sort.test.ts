/**
 * Regression tests for #861 — playlist sort keys that carry no comparable
 * value.
 *
 * `playlist_sort` advertised `popularity_desc`, a field the API no longer
 * returns on playlist items: every row read as 0, the comparator returned 0
 * for every pair, and the tool still ran its destructive full replace and
 * reported "Sorted N item(s) by popularity_desc". Both sort paths now compare
 * the key values BEFORE the write and refuse a constant key.
 *
 * Run: node --import tsx --test tests/tools.playlists-sort.test.ts
 */

import { describe, it } from 'node:test';
import { z } from 'zod';
import assert from 'node:assert/strict';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { SpotifyClient } from '../src/client.js';
import type { PlaylistItemObject, SpotifyPaged } from '../src/types/spotify.js';
import { registerPlaylistTools } from '../src/tools/playlists.js';
import { registerSwarm4PlaylistsTools } from '../src/tools/swarm4_playlists.js';

type ToolResult = {
  content: Array<{ type: string; text: string }>;
  structuredContent?: Record<string, unknown>;
};

interface RegisteredTool {
  name: string;
  description: string;
  validate: (args: Record<string, unknown>) => Record<string, unknown>;
  handler: (args: Record<string, unknown>) => Promise<ToolResult>;
}

interface RecordedCall {
  method: 'GET' | 'POST' | 'PUT' | 'PUT_RAW' | 'DELETE';
  path: string;
  arg?: unknown;
}

const writes = (calls: RecordedCall[]) =>
  calls.filter((c) => c.method === 'PUT' || c.method === 'POST' || c.method === 'DELETE');

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const trackRow = (id: string, name: string, ms = 200_000): PlaylistItemObject =>
  ({
    added_at: '2026-01-01T00:00:00Z',
    item: {
      type: 'track',
      uri: `spotify:track:${id}`,
      name,
      duration_ms: ms,
      artists: [{ id: `artist-${id}`, name: `Artist ${id}` }],
      album: { id: `album-${id}`, name: `Album ${id}` },
    },
  }) as unknown as PlaylistItemObject;

/** Episode rows carry no album, so an album sort over them has no key at all. */
const episodeRow = (id: string, name: string): PlaylistItemObject =>
  ({
    added_at: '2026-01-01T00:00:00Z',
    item: {
      type: 'episode',
      uri: `spotify:episode:${id}`,
      name,
      duration_ms: 1_800_000,
      show: { id: `show-${id}`, name: `Show ${id}` },
    },
  }) as unknown as PlaylistItemObject;

// ---------------------------------------------------------------------------
// Harness: stub MCP server + stub SpotifyClient recording every call
// ---------------------------------------------------------------------------

function harness(items: PlaylistItemObject[]) {
  const registered: RegisteredTool[] = [];
  const calls: RecordedCall[] = [];
  const server = {
    tool(name: string, description: string, schema: z.ZodRawShape, handler: RegisteredTool['handler']) {
      registered.push({ name, description, validate: (a) => z.object(schema).parse(a), handler });
    },
    registerTool(
      name: string,
      config: { description?: string; inputSchema?: z.ZodType },
      handler: RegisteredTool['handler'],
    ) {
      registered.push({
        name,
        description: config.description ?? '',
        validate: (a) => (config.inputSchema as z.ZodType).parse(a),
        handler,
      });
    },
  } as unknown as McpServer;

  const client = {
    calls,
    async get<T>(path: string, params?: Record<string, string>): Promise<T | null> {
      calls.push({ method: 'GET', path, arg: params });
      if (path.includes('/items')) {
        const offset = Number(params?.offset ?? 0);
        return { items: items.slice(offset, offset + 100), total: items.length, limit: 100, offset } as unknown as T;
      }
      const id = decodeURIComponent(path.replace('/playlists/', ''));
      return { id, name: `Playlist ${id}` } as unknown as T;
    },
    async post<T>(path: string, body?: unknown): Promise<T | null> {
      calls.push({ method: 'POST', path, arg: body });
      return { snapshot_id: 'snap-post' } as unknown as T;
    },
    async put<T>(path: string, body?: unknown): Promise<T | null> {
      calls.push({ method: 'PUT', path, arg: body });
      return { snapshot_id: 'snap-put' } as unknown as T;
    },
    async putRaw(): Promise<void> {},
    async delete<T>(): Promise<T | null> {
      return null;
    },
    // Mirrors SpotifyClient.getAllPages over the stubbed get so the sort
    // tools see the same rows a real walk would.
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
        const limit = typeof page.limit === 'number' && page.limit > 0 ? page.limit : page.items.length;
        offset += limit;
        if (page.items.length === 0 || page.items.length < limit) break;
        if (typeof page.total === 'number' && offset >= page.total) break;
      }
      return all;
    },
  };

  const typed = client as unknown as SpotifyClient;
  registerPlaylistTools(server, typed);
  registerSwarm4PlaylistsTools(server, typed);

  return {
    calls,
    descriptionOf: (name: string) => registered.find((t) => t.name === name)?.description ?? '',
    // Schema-validating invoke: mirrors how the MCP server screens args
    // before a handler ever sees them.
    async invoke(name: string, args: Record<string, unknown> = {}): Promise<ToolResult> {
      const tool = registered.find((t) => t.name === name);
      assert.ok(tool, `tool "${name}" should be registered`);
      return tool.handler(tool.validate(args));
    },
  };
}

const textOf = (out: ToolResult) => out.content[0].text;

/** Spotify playlist IDs are 22 base62 characters. */
const PLAYLIST = 'A'.repeat(22);

// ---------------------------------------------------------------------------
// playlist_sort
// ---------------------------------------------------------------------------

describe('playlist_sort refuses a key with no comparable values (#861)', () => {
  it('rejects popularity_desc at the schema before any request is issued', async () => {
    const h = harness([trackRow('a', 'Alpha'), trackRow('b', 'Beta')]);

    await assert.rejects(
      () => h.invoke('playlist_sort', { playlist_id: PLAYLIST, sort_by: 'popularity_desc', dry_run: false }),
      (e: unknown) => {
        assert.ok(e instanceof z.ZodError, 'popularity_desc must fail input validation');
        const issue = e.issues.find((i) => i.path.join('.') === 'sort_by');
        assert.ok(issue, `the rejected field must be sort_by, got ${JSON.stringify(e.issues)}`);
        assert.equal(issue.code, 'invalid_value');
        // The rejection names the allowed keys, so the caller learns which
        // fields Spotify still returns instead of retrying a dead key.
        assert.match(issue.message, /duration_desc/);
        return true;
      },
    );
    // The destructive path is unreachable: no read, no replace, no snapshot.
    assert.deepEqual(h.calls, []);
  });

  it('issues no replace and reports ok:false when every row shares the key value', async () => {
    // Same duration on every row: `duration_asc` is a constant, exactly the
    // shape the removed popularity key produced (every row read as 0).
    const h = harness([
      trackRow('a', 'Alpha', 200_000),
      trackRow('b', 'Beta', 200_000),
      trackRow('c', 'Gamma', 200_000),
    ]);

    const out = await h.invoke('playlist_sort', {
      playlist_id: PLAYLIST,
      sort_by: 'duration_asc',
      dry_run: false,
    });

    assert.deepEqual(writes(h.calls), [], 'a constant key must not rewrite the playlist');
    assert.equal(out.structuredContent?.ok, false);
    assert.equal(out.structuredContent?.reason, 'no_comparable_values');
    assert.equal(out.structuredContent?.sort_by, 'duration_asc');
    assert.equal(out.structuredContent?.items, 3);
    assert.equal(out.structuredContent?.changed, false);
    assert.match(textOf(out), /no comparable values/);
    assert.doesNotMatch(textOf(out), /Sorted 3 item\(s\)/);
  });

  it('discloses the refusal on a dry run too, rather than previewing a no-op sort', async () => {
    const h = harness([trackRow('a', 'Alpha', 10_000), trackRow('b', 'Beta', 10_000)]);

    const out = await h.invoke('playlist_sort', { playlist_id: PLAYLIST, sort_by: 'duration_desc' });

    assert.deepEqual(writes(h.calls), []);
    assert.equal(out.structuredContent?.ok, false);
    assert.equal(out.structuredContent?.dry_run, undefined, 'dry_run defaults to unset (falsy)');
    assert.match(textOf(out), /no comparable values/);
  });

  it('still sorts and rewrites when the key does vary', async () => {
    const h = harness([trackRow('c', 'Gamma'), trackRow('a', 'Alpha'), trackRow('b', 'Beta')]);

    const out = await h.invoke('playlist_sort', {
      playlist_id: PLAYLIST,
      sort_by: 'name_asc',
      dry_run: false,
    });

    const put = writes(h.calls).find((c) => c.method === 'PUT');
    assert.ok(put, 'a varying key still commits');
    assert.deepEqual(put.arg, { uris: ['spotify:track:a', 'spotify:track:b', 'spotify:track:c'] });
    assert.match(textOf(out), /Sorted 3 item\(s\) by name_asc/);
  });

  it('sorts descending on a varying numeric key', async () => {
    const h = harness([trackRow('a', 'Alpha', 10_000), trackRow('b', 'Beta', 30_000), trackRow('c', 'Gamma', 20_000)]);

    await h.invoke('playlist_sort', { playlist_id: PLAYLIST, sort_by: 'duration_desc', dry_run: false });

    const put = writes(h.calls).find((c) => c.method === 'PUT');
    assert.ok(put);
    assert.deepEqual(put.arg, { uris: ['spotify:track:b', 'spotify:track:c', 'spotify:track:a'] });
  });
});

// ---------------------------------------------------------------------------
// playlist_resequence (sibling path, swarm4)
// ---------------------------------------------------------------------------

describe('playlist_resequence refuses a key with no comparable values (#861)', () => {
  it('issues no replace for an album sort over an all-episode playlist', async () => {
    // Episodes carry no album, so the album key is null on every row.
    const h = harness([episodeRow('e1', 'Ep One'), episodeRow('e2', 'Ep Two'), episodeRow('e3', 'Ep Three')]);

    const out = await h.invoke('playlist_resequence', {
      playlist_id: PLAYLIST,
      sort_by: 'album',
      dry_run: false,
    });

    assert.deepEqual(writes(h.calls), []);
    assert.equal(out.structuredContent?.ok, false);
    assert.equal(out.structuredContent?.reason, 'no_comparable_values');
    assert.equal(out.structuredContent?.sort_by, 'album');
    assert.equal(out.structuredContent?.items, 3);
    assert.equal(out.structuredContent?.changed, false);
    assert.match(textOf(out), /no comparable values/);
    assert.doesNotMatch(textOf(out), /^Sorted /m);
  });

  it('still resequences when the key varies', async () => {
    const h = harness([trackRow('c', 'Gamma'), trackRow('a', 'Alpha'), trackRow('b', 'Beta')]);

    const out = await h.invoke('playlist_resequence', {
      playlist_id: PLAYLIST,
      sort_by: 'name',
      direction: 'asc',
      dry_run: false,
    });

    const put = writes(h.calls).find((c) => c.method === 'PUT');
    assert.ok(put, 'a varying key still commits');
    assert.deepEqual(put.arg, { uris: ['spotify:track:a', 'spotify:track:b', 'spotify:track:c'] });
    assert.match(textOf(out), /Sorted "Playlist A{22}" by name \(asc\)/);
  });
});
