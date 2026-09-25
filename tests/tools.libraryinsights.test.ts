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
import {
  chmodSync,
  createReadStream,
  closeSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { SpotifyClient } from '../src/client.js';
import type { SpotifyPaged } from '../src/types/spotify.js';
import { registerLibraryInsightsTools, loadGenreTags, type GenreTagStore } from '../src/tools/libraryinsights.js';
import { initConfig } from '../src/config.js';

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

/** Run `fn` with env/config overrides applied, restoring both afterwards. */
async function withEnv(env: Record<string, string>, fn: () => Promise<void>): Promise<void> {
  const saved = { ...process.env };
  try {
    Object.assign(process.env, env);
    initConfig(process.env);
    await fn();
  } finally {
    for (const key of Object.keys(env)) delete process.env[key];
    Object.assign(process.env, saved);
    initConfig(process.env);
  }
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

  it('discloses the fetch-all cap and that it was REACHED (#755)', async () => {
    // Cap of 2 with 5 saved tracks: the walk stops at 2 and the report must
    // say so rather than presenting 2 as the whole library.
    await withEnv({ SPOTIFY_MCP_FETCH_ALL_CAP: '2' }, async () => {
      const prep = harness(pagedResponder({ '/me/tracks': [], '/me/albums': [] }));
      await prep.invoke('tag_management', { action: 'add', artist: 'Aurora', tags: ['pop'] });
      const h = harness(
        pagedResponder(
          {
            '/me/tracks': [
              trackItem('t1', ['Aurora']),
              trackItem('t2', ['Aurora']),
              trackItem('t3', ['Aurora']),
              trackItem('t4', ['Aurora']),
              trackItem('t5', ['Aurora']),
            ],
            '/me/albums': [],
          },
          2,
        ),
      );

      const out = await h.invoke('library_genre_report', {});
      const text = textOf(out);
      // Prose names the cap, says TRUNCATED, and says tracks were not analyzed.
      assert.match(text, /cap 2/);
      assert.match(text, /TRUNCATED/);
      assert.match(text, /older saved tracks were not analyzed/);
      // The untuncated album walk is reported as complete, not truncated.
      assert.match(text, /saved albums — fetched 0[\s\S]*?complete; cap not reached/);

      // Structured payload carries the same accounting, per collection.
      const library = out.structuredContent?.library as {
        saved_tracks: { fetched: number; cap: number; truncated_by_cap: boolean };
        saved_albums: { fetched: number; cap: number; truncated_by_cap: boolean };
        complete: boolean;
      };
      assert.deepEqual(library.saved_tracks, { fetched: 2, cap: 2, truncated_by_cap: true });
      assert.deepEqual(library.saved_albums, { fetched: 0, cap: 2, truncated_by_cap: false });
      assert.equal(library.complete, false);
      assert.equal(library.saved_tracks_total, 2);
    });
  });

  it('reports a walk below the cap as complete (#755)', async () => {
    await withEnv({ SPOTIFY_MCP_FETCH_ALL_CAP: '10' }, async () => {
      const prep = harness(pagedResponder({ '/me/tracks': [], '/me/albums': [] }));
      await prep.invoke('tag_management', { action: 'add', artist: 'Aurora', tags: ['pop'] });
      const h = harness(
        pagedResponder({ '/me/tracks': [trackItem('t1', ['Aurora'])], '/me/albums': [] }, 2),
      );

      const out = await h.invoke('library_genre_report', {});
      const text = textOf(out);
      assert.match(text, /fetched 1 saved tracks, cap 10 — complete; cap not reached/);
      assert.doesNotMatch(text, /TRUNCATED/);
      const library = out.structuredContent?.library as {
        saved_tracks: { fetched: number; cap: number; truncated_by_cap: boolean };
        complete: boolean;
      };
      assert.deepEqual(library.saved_tracks, { fetched: 1, cap: 10, truncated_by_cap: false });
      assert.equal(library.complete, true);
    });
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

  it('discloses the fetch-all cap and that it was REACHED (#755)', async () => {
    await withEnv({ SPOTIFY_MCP_FETCH_ALL_CAP: '2' }, async () => {
      const prep = harness(pagedResponder({ '/me/tracks': [], '/me/albums': [] }));
      await prep.invoke('tag_management', { action: 'add', artist: 'a', tags: ['rock'] });
      const h = harness(
        pagedResponder(
          {
            '/me/tracks': [
              trackItem('t1', ['a']),
              trackItem('t2', ['a']),
              trackItem('t3', ['a']),
              trackItem('t4', ['a']),
            ],
            '/me/albums': [],
          },
          2,
        ),
      );

      const out = await h.invoke('filter_by_genre', { genre: 'rock', kind: 'tracks' });
      const text = textOf(out);
      assert.match(text, /cap 2/);
      assert.match(text, /TRUNCATED/);
      assert.match(text, /older saved tracks were not analyzed/);

      const scan = out.structuredContent?.scan as {
        fetched: number;
        cap: number;
        truncated_by_cap: boolean;
        subject: string;
        complete: boolean;
      };
      assert.deepEqual(scan, {
        fetched: 2,
        cap: 2,
        truncated_by_cap: true,
        subject: 'saved tracks',
        complete: false,
      });
      // The URI list itself stays a correct lower bound of the matches.
      assert.deepEqual(out.structuredContent?.items, ['spotify:track:t1', 'spotify:track:t2']);
    });
  });

  it('reports a walk below the cap as complete (#755)', async () => {
    await withEnv({ SPOTIFY_MCP_FETCH_ALL_CAP: '10' }, async () => {
      const prep = harness(pagedResponder({ '/me/tracks': [], '/me/albums': [] }));
      await prep.invoke('tag_management', { action: 'add', artist: 'a', tags: ['rock'] });
      const h = harness(
        pagedResponder({ '/me/tracks': [trackItem('t1', ['a'])], '/me/albums': [] }, 2),
      );

      const out = await h.invoke('filter_by_genre', { genre: 'rock', kind: 'tracks' });
      assert.match(textOf(out), /fetched 1 saved tracks, cap 10 — complete; cap not reached/);
      assert.doesNotMatch(textOf(out), /TRUNCATED/);
      const scan = out.structuredContent?.scan as {
        truncated_by_cap: boolean;
        complete: boolean;
      };
      assert.equal(scan.truncated_by_cap, false);
      assert.equal(scan.complete, true);
    });
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

  // #759 — a corrupt sidecar is SURFACED, never coerced to an empty store.
  // The old behaviour (swallow the parse error, read as "no tags") let the very
  // next tag_management write replace a hand-curated store with a one-entry
  // stub and report success, destroying it.
  it('corrupt JSON surfaces the parse error instead of reading as an empty store', () => {
    writeFileSync(sidecarPath, '{not json', 'utf8');
    assert.throws(() => loadGenreTags(sidecarPath), /is not valid JSON/);
  });

  it('a zero-length sidecar — the crash-mid-write signature — is corruption, not empty', () => {
    // A non-atomic writeFileSync truncates the target open(); a crash before the
    // bytes land leaves exactly this. Reading it as "no tags" destroys the store.
    writeFileSync(sidecarPath, '', 'utf8');
    assert.throws(() => loadGenreTags(sidecarPath), /is not valid JSON/);
  });

  it('valid JSON that is not a genre tag store is surfaced too', () => {
    writeFileSync(sidecarPath, JSON.stringify({ unrelated: true }), 'utf8');
    assert.throws(() => loadGenreTags(sidecarPath), /is not a genre tag store/);
  });

  it('tagging against a corrupt sidecar errors and does NOT overwrite the file', async () => {
    const corrupt = '{not json';
    writeFileSync(sidecarPath, corrupt, 'utf8');
    const h = harness();
    await assert.rejects(
      h.invoke('tag_management', { action: 'add', artist: 'Aurora', tags: ['pop'] }),
      /is not valid JSON/,
    );
    // The hand-curated bytes are still on disk, byte for byte.
    assert.equal(readFileSync(sidecarPath, 'utf8'), corrupt);
  });

  it('reading the sidecar is never itself destructive', async () => {
    const corrupt = '{"version":1,"tags":{"Sigur Ros":["ambient"]},,';
    writeFileSync(sidecarPath, corrupt, 'utf8');
    const h = harness(pagedResponder({ '/me/tracks': [], '/me/albums': [] }));
    await assert.rejects(h.invoke('library_genre_report', {}), /is not valid JSON/);
    assert.equal(readFileSync(sidecarPath, 'utf8'), corrupt);
  });

  // Umask-proof: a fresh create could pass 0600 by luck if CI runs umask 077.
  // Pre-seeding a world-readable store proves the writer re-asserts owner-only
  // rather than relying on the creation-time mode, and fails on the old code.
  it('a pre-existing world-readable store is tightened to 0600 on write', async () => {
    writeFileSync(sidecarPath, JSON.stringify({ version: 1, tags: { X: ['pop'] } }), 'utf8');
    chmodSync(sidecarPath, 0o644);
    const h = harness();
    await h.invoke('tag_management', { action: 'add', artist: 'Aurora', tags: ['pop'] });
    assert.equal(statSync(sidecarPath).mode & 0o777, 0o600);
  });

  it('a malformed tag entry is corruption, not a silently dropped artist', () => {
    // Dropping this would resolve to a smaller plausible set, and the next
    // write would persist that loss away and report success.
    writeFileSync(sidecarPath, JSON.stringify({ version: 1, tags: { Sigur: 'ambient' } }), 'utf8');
    assert.throws(() => loadGenreTags(sidecarPath), /malformed entry for "Sigur"/);
  });

  it('a non-string tag value is corruption, not filtered out', () => {
    writeFileSync(sidecarPath, JSON.stringify({ version: 1, tags: { Sigur: ['ambient', 7] } }), 'utf8');
    assert.throws(() => loadGenreTags(sidecarPath), /malformed entry for "Sigur"/);
  });

  it('an emptied tag list is a legitimate empty set, not corruption', () => {
    // Retracting every tag is normal and leaves an entry with nothing in it.
    writeFileSync(sidecarPath, JSON.stringify({ version: 1, tags: { Sigur: [] } }), 'utf8');
    assert.deepEqual(loadGenreTags(sidecarPath).tags, {});
  });

  it('a second corrupt state does not destroy the first preserved copy', () => {
    const first = '{"version":1,"tags":{"A":["x"]},,';
    const second = '{"version":1,"tags":{"B":["y"]';
    writeFileSync(sidecarPath, first, 'utf8');
    assert.throws(() => loadGenreTags(sidecarPath), /is not valid JSON/);
    // The user is told to repair from the copy, so that copy must survive the
    // next distinct corruption rather than being clobbered last-write-wins.
    writeFileSync(sidecarPath, second, 'utf8');
    assert.throws(() => loadGenreTags(sidecarPath), /is not valid JSON/);

    assert.equal(readFileSync(`${sidecarPath}.corrupt`, 'utf8'), first);
    assert.equal(readFileSync(`${sidecarPath}.corrupt.2`, 'utf8'), second);
  });

  it('a write interrupted before the rename leaves the previous store intact', async () => {
    const h = harness();
    await h.invoke('tag_management', { action: 'add', artist: 'Aurora', tags: ['pop'] });
    const before = readFileSync(sidecarPath, 'utf8');

    // Occupy the temp path so the pre-rename write fails exactly the way a crash
    // between the write and the rename would. Because the rename is the only
    // step that touches the real path, the previous store must survive intact.
    mkdirSync(`${sidecarPath}.tmp`);
    await assert.rejects(
      h.invoke('tag_management', { action: 'add', artist: 'Aurora', tags: ['indie'] }),
      /EISDIR|illegal operation on a directory/i,
    );
    assert.equal(readFileSync(sidecarPath, 'utf8'), before);
  });

  it('a successful write swaps the store in wholesale and strands no temp file', async () => {
    const h = harness();
    await h.invoke('tag_management', { action: 'add', artist: 'Aurora', tags: ['pop'] });
    // The rename replaces the inode, so no residue of the old file survives.
    await h.invoke('tag_management', { action: 'add', artist: 'Aurora', tags: ['indie'] });
    const onDisk = JSON.parse(readFileSync(sidecarPath, 'utf8')) as GenreTagStore;
    assert.deepEqual(onDisk.tags, { Aurora: ['pop', 'indie'] });
    assert.equal(existsSync(`${sidecarPath}.tmp`), false);
  });

  // #759 acceptance: a hand-corrupted file warns AND the subsequent write keeps
  // a `.corrupt` copy. We honour that byte-preservation intent without letting
  // the write proceed: the read quarantines the bytes and still throws, so the
  // payload survives twice and no mutation is ever authorised over it.
  it('preserves the corrupt bytes at <path>.corrupt, 0600, and names the file', () => {
    const corrupt = '{"version":1,"tags":{"Sigur Ros":["ambient"]},,';
    writeFileSync(sidecarPath, corrupt, 'utf8');
    assert.throws(() => loadGenreTags(sidecarPath), (err: Error) => {
      // The warning must name the file the user has to repair…
      assert.match(err.message, new RegExp(sidecarPath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
      // …and point at the preserved copy.
      assert.match(err.message, /\.corrupt/);
      return true;
    });
    const backup = `${sidecarPath}.corrupt`;
    assert.equal(existsSync(backup), true);
    assert.equal(readFileSync(backup, 'utf8'), corrupt); // byte-for-byte
    assert.equal(statSync(backup).mode & 0o777, 0o600);
    assert.equal(readFileSync(sidecarPath, 'utf8'), corrupt); // original untouched
  });

  it('quarantine does not fire for a valid store or a missing file', () => {
    assert.equal(existsSync(`${sidecarPath}.corrupt`), false); // missing → no copy
    writeFileSync(sidecarPath, JSON.stringify({ version: 1, tags: { X: ['pop'] } }), 'utf8');
    assert.deepEqual(loadGenreTags(sidecarPath).tags, { X: ['pop'] });
    assert.equal(existsSync(`${sidecarPath}.corrupt`), false);
  });

  // A write is a REPLACEMENT, never an in-place truncate: the rename publishes a
  // new inode. Same inode across a write is the old truncate-in-place bug.
  it('each write replaces the store by rename, not by truncating it in place', async () => {
    const h = harness();
    await h.invoke('tag_management', { action: 'add', artist: 'Aurora', tags: ['pop'] });
    const ino = statSync(sidecarPath).ino;
    await h.invoke('tag_management', { action: 'add', artist: 'Aurora', tags: ['indie'] });
    assert.notEqual(statSync(sidecarPath).ino, ino);
  });

  // The window the atomic write exists to protect: write started, process dies
  // before the rename. This drives the REAL production writer (the registered
  // tag_management tool, not a hand-rolled imitation) in a child process and
  // SIGKILLs it while it is blocked mid-write.
  //
  // The block is real, not a sleep: the temp path is a FIFO, so the writer's
  // open blocks until this process opens the read end, and its write then
  // blocks again once the 64 KiB pipe buffer fills. Reading a byte proves the
  // write is genuinely in flight; only then do we kill.
  it('killing the real writer mid-write leaves the published sidecar intact', { timeout: 60_000 }, async () => {
    // A store far larger than the pipe buffer, so the writer cannot finish its
    // write without a reader draining it.
    const seeded = { version: 1, tags: {} as Record<string, string[]> };
    for (let i = 0; i < 4000; i += 1) seeded.tags[`Artist ${i}`] = ['genre-number-' + i];
    const before = `${JSON.stringify(seeded, null, 2)}\n`;
    writeFileSync(sidecarPath, before, 'utf8');
    assert.ok(before.length > 128 * 1024, 'seed must exceed the pipe buffer');

    // A FIFO at the temp path: the writer can only proceed via the temp file.
    const fifo = `${sidecarPath}.tmp`;
    spawnSync("mkfifo", ["-m", "600", fifo]);

    const child = spawn(
      process.execPath,
      [
        '--import', 'tsx', '--input-type=module', '-e',
        // Real production path: register the tools and dispatch tag_management.
        // Dynamic import is required, not stylistic: this string is the SOURCE of
        // a separate OS process that must load the production module at runtime,
        // so no static import can reach it. This is a module-loading boundary.
        [
          // Configured by ENV, not argv: under `-e` the script is not an argv
          // entry, so argv indices are mode-dependent and easy to get wrong.
          'const base = "file://" + process.env.CHILD_ROOT + "/";',
          'const { registerLibraryInsightsTools } = await import(base + "src/tools/libraryinsights.ts");',
          'const { initConfig } = await import(base + "src/config.ts");',
          'initConfig(process.env);',
          'let handler;',
          'const server = { tool: (n, d, s, h) => { if (n === "tag_management") handler = h; } };',
          'registerLibraryInsightsTools(server, {});',
          'await handler({ action: "add", artist: "Killer", tags: ["x"], response_format: "json" });',
          'process.stdout.write("committed\\n");',
        ].join('\n'),
      ],
      {
        stdio: ['pipe', 'pipe', 'pipe'],
        cwd: process.cwd(),
        env: {
          ...process.env,
          CHILD_ROOT: process.cwd(),
          SPOTIFY_MCP_GENRE_TAGS_FILE: sidecarPath,
        },
      },
    );

    // 'r+' (O_RDWR) so this open NEVER blocks waiting for a writer — 'r' would
    // hang the suite if the child died before reaching its open(). Holding the
    // write end ourselves also releases the child's open immediately.
    const fd = openSync(fifo, 'r+');
    const reader = createReadStream(fifo, { fd });
    let killed = false;
    try {
      const flow = Promise.withResolvers<{ kind: 'bytes' | 'exited' }>();
      reader.on('readable', () => {
        if (reader.read(1) !== null) flow.resolve({ kind: 'bytes' });
      });
      child.on('exit', () => flow.resolve({ kind: 'exited' }));
      child.stdout.on('data', () => { /* drain so the child never blocks on us */ });

      // "exited" means the writer never went through the temp path at all — it
      // wrote the live sidecar directly. That is precisely the old bug, and it
      // is what makes this test fail on origin/main.
      assert.equal((await flow.promise).kind, 'bytes');

      child.kill('SIGKILL');
      killed = true;
      await new Promise((resolve) => child.on('exit', resolve));

      // The store is byte-for-byte the pre-kill version and still valid: the
      // half-written payload never reached it because the rename never ran.
      assert.equal(readFileSync(sidecarPath, 'utf8'), before);
      const surviving = JSON.parse(readFileSync(sidecarPath, 'utf8')) as GenreTagStore;
      assert.equal(Object.keys(surviving.tags).length, 4000);
      assert.equal(surviving.tags['Killer'], undefined); // the killed add never landed
    } finally {
      // Unconditional: a failed assertion must still release the child and the
      // FIFO handle, or the open pipe keeps the event loop alive and the whole
      // run hangs long after this test has reported.
      if (!killed && child.exitCode === null) child.kill('SIGKILL');
      reader.destroy();
    }
  });
});
