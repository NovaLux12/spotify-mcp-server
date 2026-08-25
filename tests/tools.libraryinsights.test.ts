/**
 * Tests for src/tools/libraryinsights.ts (issue #112 idea 1 — sidecar variant).
 *
 * Uses a stub MCP server + stub SpotifyClient (records every call, returns
 * canned multi-page fixtures) — no network, no real library access. The tag
 * sidecar is redirected to a temp file via SPOTIFY_MCP_GENRE_TAGS_FILE and
 * removed between tests.
 *
 * Run: node --import tsx --test tests/tools.libraryinsights.test.ts
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import { z } from 'zod';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { SpotifyClient } from '../src/client.js';
import type { SpotifyPaged } from '../src/types/spotify.js';
import { registerLibraryInsightsTools, loadGenreTags } from '../src/tools/libraryinsights.js';

// ---------------------------------------------------------------------------
// Stub plumbing (mirrors tests/tools.playlists-following.test.ts)
// ---------------------------------------------------------------------------

interface RecordedCall {
  method: 'GET' | 'POST' | 'PUT' | 'PUT_RAW' | 'DELETE';
  path: string;
  arg?: unknown;
}

type Responder = (path: string, params?: Record<string, string>) => unknown;

interface RegisteredTool {
  name: string;
  description: string;
  validate: (args: Record<string, unknown>) => Record<string, unknown>;
  handler: (
    args: Record<string, unknown>,
  ) => Promise<{
    content: Array<{ type: string; text: string }>;
    structuredContent?: Record<string, unknown>;
  }>;
}

type Registrar = (server: McpServer, client: SpotifyClient) => void;

function makeStubClient(responder: Responder = () => null) {
  const calls: RecordedCall[] = [];
  const client = {
    calls,
    async get<T>(path: string, params?: Record<string, string>): Promise<T | null> {
      calls.push({ method: 'GET', path, arg: params });
      return responder(path, params) as T | null;
    },
    // Mirrors SpotifyClient.getAllPages over the stubbed get() so pagination
    // semantics (offset stepping, short-page stop, total stop) are real.
    async getAllPages<T>(
      path: string,
      params?: Record<string, string>,
      opts?: { maxItems?: number },
    ): Promise<T[]> {
      const maxItems = opts?.maxItems ?? 500;
      const all: T[] = [];
      let offset = Number(params?.offset ?? 0);
      for (;;) {
        const pageParams = { ...params, offset: String(offset) };
        const page = await this.get<SpotifyPaged<T>>(path, pageParams);
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

function harness(responder: Responder = () => null) {
  const registered: RegisteredTool[] = [];
  const fakeServer = {
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
  } as unknown as McpServer;
  const client = makeStubClient(responder);
  registerLibraryInsightsTools(fakeServer, client as unknown as SpotifyClient);

  return {
    registered,
    client,
    invoke: async (name: string, args: Record<string, unknown>) => {
      const tool = registered.find((t) => t.name === name);
      assert.ok(tool, `tool "${name}" should be registered`);
      return tool.handler(tool.validate(args));
    },
  };
}

const textOf = (out: { content: Array<{ text: string }> }) => out.content[0].text;

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const trackItem = (id: string, artistNames: string[]) => ({
  added_at: '2026-01-01T00:00:00Z',
  track: {
    id,
    name: `Track ${id}`,
    uri: `spotify:track:${id}`,
    artists: artistNames.map((name) => ({ name })),
    album: { id: `alb-${id}`, name: `Album ${id}` },
  },
});

const albumItem = (id: string, artistNames: string[]) => ({
  added_at: '2026-01-02T00:00:00Z',
  album: {
    id,
    name: `Album ${id}`,
    uri: `spotify:album:${id}`,
    artists: artistNames.map((name) => ({ name })),
    total_tracks: 10,
  },
});

/** Paged responder: splits a fixture list into pages of `perPage` per path. */
function pagedResponder(fixtures: Record<string, unknown[]>, perPage = 2): Responder {
  return (path, params) => {
    const items = fixtures[path] ?? [];
    const offset = Number(params?.offset ?? 0);
    const limit = perPage;
    return {
      items: items.slice(offset, offset + limit),
      total: items.length,
      limit,
      offset,
      next:
        offset + limit < items.length
          ? `https://api.spotify.com/v1${path}?offset=${offset + limit}&limit=${limit}`
          : null,
    };
  };
}

// ---------------------------------------------------------------------------
// Sidecar lifecycle: every test runs against an isolated temp store
// ---------------------------------------------------------------------------

let sidecarDir: string;
let sidecarPath: string;
const savedEnv = process.env.SPOTIFY_MCP_GENRE_TAGS_FILE;

beforeEach(() => {
  sidecarDir = mkdtempSync(join(tmpdir(), 'genre-tags-'));
  sidecarPath = join(sidecarDir, 'genre-tags.json');
  process.env.SPOTIFY_MCP_GENRE_TAGS_FILE = sidecarPath;
});

afterEach(() => {
  rmSync(sidecarDir, { recursive: true, force: true });
  if (savedEnv === undefined) delete process.env.SPOTIFY_MCP_GENRE_TAGS_FILE;
  else process.env.SPOTIFY_MCP_GENRE_TAGS_FILE = savedEnv;
});

// ---------------------------------------------------------------------------
// Registration surface
// ---------------------------------------------------------------------------

describe('registration', () => {
  it('registers the three tools', () => {
    const h = harness();
    assert.deepEqual(
      h.registered.map((t) => t.name).sort(),
      ['filter_by_genre', 'library_genre_report', 'tag_management'],
    );
  });
});

// ---------------------------------------------------------------------------
// tag_management
// ---------------------------------------------------------------------------

describe('tag_management', () => {
  it('add writes tags to the sidecar, preserving first-seen casing on later adds', async () => {
    const h = harness();
    await h.invoke('tag_management', { action: 'add', artist: 'Aurora', tags: ['pop'] });
    await h.invoke('tag_management', { action: 'add', artist: 'aurora', tags: ['indie'] });

    const store = loadGenreTags(sidecarPath);
    assert.deepEqual(store.tags['Aurora'], ['pop', 'indie']);
  });

  it('add without tags throws', async () => {
    const h = harness();
    await assert.rejects(h.invoke('tag_management', { action: 'add', artist: 'X' }), /at least one tag/);
  });

  it('remove with tags drops only those tags; zero remaining tags drops the entry', async () => {
    const h = harness();
    await h.invoke('tag_management', { action: 'add', artist: 'Sigur Ros', tags: ['post-rock', 'ambient'] });
    await h.invoke('tag_management', { action: 'remove', artist: 'sigur ros', tags: ['post-rock'] });
    assert.deepEqual(loadGenreTags(sidecarPath).tags['Sigur Ros'], ['ambient']);

    await h.invoke('tag_management', { action: 'remove', artist: 'sigur ros', tags: ['ambient'] });
    assert.deepEqual(loadGenreTags(sidecarPath).tags, {}); // zero tags → entry dropped
  });

  it('remove without tags deletes the artist entry entirely', async () => {
    const h = harness();
    await h.invoke('tag_management', { action: 'add', artist: 'Nils', tags: ['jazz'] });
    await h.invoke('tag_management', { action: 'remove', artist: 'nils' });
    assert.deepEqual(loadGenreTags(sidecarPath).tags, {});
  });

  it('dry_run previews add without touching the sidecar', async () => {
    const h = harness();
    const out = await h.invoke('tag_management', {
      action: 'add',
      artist: 'Fleetwood Mac',
      tags: ['rock'],
      dry_run: true,
    });

    assert.match(textOf(out), /\[dry run\]/);
    assert.equal(out.structuredContent?.dry_run, true);
    assert.deepEqual(loadGenreTags(sidecarPath).tags, {});
  });

  it('reports nothing-to-remove for unknown artists', async () => {
    const h = harness();
    const out = await h.invoke('tag_management', { action: 'remove', artist: 'Nobody' });
    assert.match(textOf(out), /nothing to remove/i);
    assert.deepEqual(loadGenreTags(sidecarPath).tags, {});
  });
});

// ---------------------------------------------------------------------------
// library_genre_report
// ---------------------------------------------------------------------------

describe('library_genre_report', () => {
  it('pages both saved endpoints fully and counts per genre once per item', async () => {
    // Tracks: 3 items across two pages (limit 2). t3 carries BOTH Aurora (pop)
    // and Nils (jazz), so pop must count 3 tracks.
    const h = harness(
      pagedResponder({
        '/me/tracks': [
          trackItem('t1', ['Aurora']),
          trackItem('t2', ['Aurora']),
          trackItem('t3', ['Nils', 'Aurora']),
        ],
        '/me/albums': [albumItem('a1', ['Nils'])],
      }),
    );
    await h.invoke('tag_management', { action: 'add', artist: 'Aurora', tags: ['pop'] });
    await h.invoke('tag_management', { action: 'add', artist: 'Nils', tags: ['jazz'] });
    h.client.calls.length = 0; // ignore the tag_management GETs

    const out = await h.invoke('library_genre_report', {});

    // Pagination walk: /me/tracks offsets 0 then 2 (short final page); same for albums.
    const trackOffsets = h.client.calls.filter((c) => c.path === '/me/tracks').map((c) => c.arg?.offset);
    assert.deepEqual(trackOffsets, ['0', '2']);
    const albumOffsets = h.client.calls.filter((c) => c.path === '/me/albums').map((c) => c.arg?.offset);
    assert.deepEqual(albumOffsets, ['0']);

    const rows = out.structuredContent?.items as Array<{
      genre: string;
      tracks: number;
      albums: number;
      total: number;
      artists: string[];
    }>;
    assert.deepEqual(rows, [
      { genre: 'pop', tracks: 3, albums: 0, total: 3, artists: ['Aurora'] },
      { genre: 'jazz', tracks: 1, albums: 1, total: 2, artists: ['Nils'] },
    ]);
    assert.equal(out.structuredContent?.library.saved_tracks_total, 3);
    assert.equal(out.structuredContent?.library.saved_albums_total, 1);
  });

  it('dedupes repeated artists within one item: genre counted once even with duplicate artists', async () => {
    const h = harness(
      pagedResponder({
        '/me/tracks': [trackItem('t1', ['Aurora', 'Aurora'])],
        '/me/albums': [],
      }),
    );
    await h.invoke('tag_management', { action: 'add', artist: 'Aurora', tags: ['pop'] });
    h.client.calls.length = 0;

    const out = await h.invoke('library_genre_report', {});
    const rows = out.structuredContent?.items as Array<{ genre: string; tracks: number }>;
    assert.equal(rows[0].tracks, 1);
    assert.deepEqual(rows[0].artists, ['Aurora']); // deduplicated in the artist list too
  });

  it('respects max_results truncation with accurate totals and footer', async () => {
    const prep = harness(pagedResponder({ '/me/tracks': [], '/me/albums': [] }));
    for (const g of ['a', 'b', 'c']) {
      await prep.invoke('tag_management', { action: 'add', artist: `Artist ${g}`, tags: [`genre-${g}`] });
    }
    // One item per genre via distinct artists on one saved track each.
    const h = harness(
      pagedResponder({
        '/me/tracks': [
          trackItem('t1', ['Artist a']),
          trackItem('t2', ['Artist b']),
          trackItem('t3', ['Artist c']),
        ],
        '/me/albums': [],
      }),
    );

    const out = await h.invoke('library_genre_report', { max_results: 2 });
    const text = textOf(out);
    assert.match(text, /1 more/);
    const sc = out.structuredContent as {
      items: unknown[];
      pagination: { total: number; next_offset: number | null };
    };
    assert.equal(sc.pagination.total, 3);
    assert.equal(sc.items.length, 2);
    assert.equal(sc.pagination.next_offset, 2);
  });

  it('json mode returns raw payload text matching structuredContent', async () => {
    const prep = harness(pagedResponder({ '/me/tracks': [], '/me/albums': [] }));
    await prep.invoke('tag_management', { action: 'add', artist: 'Aurora', tags: ['pop'] });
    const h = harness(pagedResponder({ '/me/tracks': [trackItem('t1', ['Aurora'])], '/me/albums': [] }));

    const out = await h.invoke('library_genre_report', { response_format: 'json' });
    const parsed = JSON.parse(textOf(out));
    assert.deepEqual(parsed, out.structuredContent);
    assert.equal(parsed.library.saved_tracks_total, 1);
  });

  it('empty library edge: zero saved items yields an empty report, not an error', async () => {
    const h = harness(pagedResponder({}));
    const out = await h.invoke('library_genre_report', {});
    assert.match(textOf(out), /empty/i);
    assert.deepEqual(out.structuredContent?.items, []);
    assert.equal(out.structuredContent?.library.saved_tracks_total, 0);
    assert.equal(out.structuredContent?.library.saved_albums_total, 0);
  });

  it('non-empty library with no tags lists untagged artists instead of rows', async () => {
    const h = harness(
      pagedResponder({
        '/me/tracks': [trackItem('t1', ['Untagged One'])],
        '/me/albums': [],
      }),
    );
    const out = await h.invoke('library_genre_report', {});
    assert.match(textOf(out), /Untagged artists \(1\): Untagged One/);
    assert.deepEqual(out.structuredContent?.untagged_artists, ['Untagged One']);
    assert.deepEqual(out.structuredContent?.items, []);
  });
});

// ---------------------------------------------------------------------------
// filter_by_genre
// ---------------------------------------------------------------------------

describe('filter_by_genre', () => {
  it('returns matching saved track URIs ready for create_playlist/add_to_playlist', async () => {
    const h = harness(
      pagedResponder({
        '/me/tracks': [trackItem('t1', ['Aurora']), trackItem('t2', ['Nils'])],
        '/me/albums': [albumItem('a1', ['Aurora'])],
      }),
    );
    await h.invoke('tag_management', { action: 'add', artist: 'Aurora', tags: ['Pop'] }); // case differs
    h.client.calls.length = 0;

    const out = await h.invoke('filter_by_genre', { genre: 'pop', kind: 'tracks' });
    assert.deepEqual(out.structuredContent?.items, ['spotify:track:t1']);
    assert.equal(out.structuredContent?.pagination.total, 1);
    assert.equal(out.structuredContent?.kind, 'tracks');
    // Only the requested collection is walked.
    assert.ok(h.client.calls.every((c) => c.path === '/me/tracks'));
  });

  it('filters albums by kind', async () => {
    const h = harness(
      pagedResponder({
        '/me/tracks': [trackItem('t1', ['Aurora'])],
        '/me/albums': [albumItem('a1', ['Aurora']), albumItem('a2', ['Nils'])],
      }),
    );
    await h.invoke('tag_management', { action: 'add', artist: 'Aurora', tags: ['dream-pop'] });
    await h.invoke('tag_management', { action: 'add', artist: 'Nils', tags: ['dream-pop'] });
    h.client.calls.length = 0;

    const out = await h.invoke('filter_by_genre', { genre: 'DREAM-POP', kind: 'albums' });
    assert.deepEqual(out.structuredContent?.items, ['spotify:album:a1', 'spotify:album:a2']);
  });

  it('no matches returns empty list with zero totals and no error', async () => {
    const h = harness(
      pagedResponder({ '/me/tracks': [trackItem('t1', ['Aurora'])], '/me/albums': [] }),
    );
    await h.invoke('tag_management', { action: 'add', artist: 'Aurora', tags: ['pop'] });
    h.client.calls.length = 0;

    const out = await h.invoke('filter_by_genre', { genre: 'techno', kind: 'tracks' });
    assert.deepEqual(out.structuredContent?.items, []);
    assert.equal(out.structuredContent?.pagination.total, 0);
    assert.match(textOf(out), /matching genre "techno": 0/m);
  });

  it('truncates to max_results while reporting the full match count', async () => {
    const prep = harness(pagedResponder({ '/me/tracks': [], '/me/albums': [] }));
    await prep.invoke('tag_management', { action: 'add', artist: 'a', tags: ['rock'] });
    const h = harness(
      pagedResponder({
        '/me/tracks': [trackItem('t1', ['a']), trackItem('t2', ['a']), trackItem('t3', ['a'])],
        '/me/albums': [],
      }),
    );

    const out = await h.invoke('filter_by_genre', { genre: 'rock', kind: 'tracks', max_results: 2 });
    const sc = out.structuredContent as {
      items: string[];
      pagination: { total: number; next_offset: number | null };
    };
    assert.deepEqual(sc.items, ['spotify:track:t1', 'spotify:track:t2']);
    assert.equal(sc.pagination.total, 3);
    assert.equal(sc.pagination.next_offset, 2);
    assert.match(textOf(out), /1 more/);
  });
});

// ---------------------------------------------------------------------------
// Sidecar robustness
// ---------------------------------------------------------------------------

describe('sidecar robustness', () => {
  it('missing file reads as an empty store and reports no tags', async () => {
    assert.deepEqual(loadGenreTags(sidecarPath).tags, {});
    const h = harness(pagedResponder({ '/me/tracks': [trackItem('t1', ['X'])], '/me/albums': [] }));
    const out = await h.invoke('library_genre_report', {});
    assert.match(textOf(out), /Untagged artists \(1\): X/);
  });

  it('corrupt file is tolerated as an empty store rather than crashing tools', async () => {
    writeFileSync(sidecarPath, '{not json', 'utf8');
    assert.deepEqual(loadGenreTags(sidecarPath).tags, {});
  });
});
