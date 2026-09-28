/**
 * Tests for src/tools/following.ts (issues #34, #35, and wave-B shaping
 * #51/#52/#53/#57/#58).
 *
 * #638 removed the follow WRITE tools: `follow_artists` and
 * `unfollow_artists` targeted `PUT`/`DELETE /me/following?type=artist`, which
 * Spotify deleted in February 2026 with no replacement. `check_following_artists`
 * survives on the migrated read, `GET /me/library/contains`, and its strict
 * response validation is pinned below.
 *
 * Same stub harness pattern as tests/tools.playlists-following.test.ts:
 * stub MCP server + stub SpotifyClient that records every call.
 *
 * Run: node --import tsx --test tests/tools.following.test.ts
 */

import './helpers/hermetic.js';

import { describe, it, beforeEach, afterEach } from 'node:test';
import { z } from 'zod';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { SpotifyClient } from '../src/client.js';
import { registerFollowingTools } from '../src/tools/following.js';

// ---------------------------------------------------------------------------
// Stub plumbing (mirrors tests/tools.playlists-following.test.ts)
// ---------------------------------------------------------------------------

interface RecordedCall {
  method: 'GET' | 'POST' | 'PUT' | 'PUT_RAW' | 'DELETE';
  path: string;
  arg?: unknown;
}

type Responder = (path: string, arg: unknown) => unknown;

interface RegisteredTool {
  name: string;
  description: string;
  /** Validates raw args exactly like the MCP SDK would before invoking the handler. */
  validate: (args: Record<string, unknown>) => Record<string, unknown>;
  handler: (args: Record<string, unknown>) => Promise<{ content: Array<{ type: string; text: string }>; structuredContent?: unknown }>;
}

function makeHarness(responder: Responder = () => null) {
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
    },
    async putRaw(path: string, body: string, contentType?: string): Promise<void> {
      calls.push({ method: 'PUT_RAW', path, arg: body });
    },
    async delete(path: string, body?: unknown): Promise<void> {
      calls.push({ method: 'DELETE', path, arg: body });
    },
  };

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
    registerTool(
      name: string,
      config: { description?: string; inputSchema?: z.ZodType<Record<string, unknown>> },
      handler: RegisteredTool['handler'],
    ) {
      registered.push({
        name,
        description: config.description ?? '',
        validate: (args) => (config.inputSchema as z.ZodType<Record<string, unknown>>).parse(args),
        handler,
      });
    },
  } as unknown as McpServer;

  registerFollowingTools(fakeServer, client as unknown as SpotifyClient);

  return {
    calls,
    registered,
    invoke: async (name: string, args: Record<string, unknown>) => {
      const tool = registered.find((t) => t.name === name);
      assert.ok(tool, `tool "${name}" should be registered`);
      return tool.handler(tool.validate(args));
    },
  };
}

const textOf = (out: { content: Array<{ text: string }> }) => out.content[0].text;

const followedArtist = (id: string, name: string, genres: string[] = []) => ({
  id,
  name,
  uri: `spotify:artist:${id}`,
  genres,
});

// ---------------------------------------------------------------------------
// Registration: the three read-side tools that survive #638
// ---------------------------------------------------------------------------

describe('following module registrations', () => {
  it('registers exactly the three surviving read tools and neither removed write tool', () => {
    const h = makeHarness();
    const names = h.registered.map((t) => t.name);

    assert.deepEqual(names, [
      'get_followed_artists',
      'check_following_artists',
      'following_analytics',
    ]);
    // #638: the follow/unfollow WRITE tools are gone, not merely renamed.
    // They targeted PUT/DELETE /me/following?type=artist, which Spotify
    // removed in February 2026 with no replacement, so nothing can carry
    // their contract forward under another name.
    assert.ok(!names.includes('follow_artists'), 'follow_artists must not be registered');
    assert.ok(!names.includes('unfollow_artists'), 'unfollow_artists must not be registered');
  });
});

// ---------------------------------------------------------------------------
// Shared shaping: response_format (#51), truncation + structuredContent
// (#52/#53), dry_run (#57), batch summaries (#58)
// ---------------------------------------------------------------------------

describe('get_followed_artists shaping (#51/#52/#53)', () => {
  it('renders artists, keeps the cursor hint, and attaches structuredContent', async () => {
    const h = makeHarness(() => ({
      artists: {
        items: [followedArtist('a1', 'One'), followedArtist('a2', 'Two')],
        total: 2,
        cursors: { after: 'a2' },
        next: null,
      },
    }));

    const out = await h.invoke('get_followed_artists', {});

    const text = textOf(out);
    assert.match(text, /^Followed artists \(2 total, showing 2\):/);
    assert.match(text, /• One — no genres listed \| URI: spotify:artist:a1/);
    assert.match(text, /Next page cursor: a2/);

    const sc = out.structuredContent as Record<string, any>;
    assert.equal(sc.items.length, 2);
    assert.equal(sc.pagination.total, 2);
    assert.equal(sc.next_cursor, 'a2');
  });

  it('json mode parses to items + pagination without prose headers (#51)', async () => {
    const h = makeHarness(() => ({
      artists: { items: [followedArtist('a1', 'One')], total: 9, cursors: null, next: null },
    }));
    const out = await h.invoke('get_followed_artists', { response_format: 'json' });

    const payload = JSON.parse(out.content[0].text);
    assert.equal(payload.items.length, 1);
    assert.equal(payload.pagination.total, 9);
    assert.deepEqual(out.structuredContent, payload);
    assert.ok(!out.content[0].text.startsWith('Followed artists'));
  });

  it('max_results slices the listing and appends the more-footer (#53)', async () => {
    const items = Array.from({ length: 5 }, (_, i) => followedArtist(`a${i}`, `Artist ${i}`));
    const h = makeHarness(() => ({
      artists: { items, total: 5, cursors: null, next: null },
    }));

    const out = await h.invoke('get_followed_artists', { max_results: 2 });

    const text = textOf(out);
    assert.match(text, /^Followed artists \(5 total, showing 2\):/);
    assert.match(text, /\(3 more — pass max_results to raise this call's cap\)/);
    assert.ok(!text.includes('Artist 2'));
    // No cursor line when there is no cursor.
    assert.ok(!text.includes('Next page cursor'));
  });

  it('detailed mode appends artist IDs (#51)', async () => {
    const h = makeHarness(() => ({
      artists: {
        items: [followedArtist('a1', 'One', ['pop'])],
        total: 1,
        cursors: null,
        next: null,
      },
    }));
    const out = await h.invoke('get_followed_artists', { response_format: 'detailed' });
    assert.match(textOf(out), /URI: spotify:artist:a1 \| ID: a1/);
  });

  it('empty listing still emits a structured payload', async () => {
    const h = makeHarness(() => ({ artists: null }));
    const out = await h.invoke('get_followed_artists', {});
    assert.match(textOf(out), /Followed artists \(0 total, showing 0\)\./);
    const sc = out.structuredContent as Record<string, any>;
    assert.deepEqual(sc.items, []);
    assert.equal(sc.next_cursor, null);
  });
});

describe('check_following_artists shaping (#51/#52/#53)', () => {
  it('truncates its per-ID listing via max_results and exposes structured checks', async () => {
    const h = makeHarness(() => [true, false, true]);
    const out = await h.invoke('check_following_artists', {
      ids: ['a', 'b', 'c'],
      max_results: 2,
    });

    // #638: the read half of following migrated to the library contains read.
    assert.equal(h.calls.length, 1);
    assert.equal(h.calls[0].method, 'GET');
    assert.equal(h.calls[0].path, '/me/library/contains');
    assert.deepEqual(h.calls[0].arg, { uris: 'spotify:artist:a,spotify:artist:b,spotify:artist:c' });

    const text = textOf(out);
    assert.match(text, /^Following check:/);
    assert.match(text, /✓ spotify:artist:a \(id: a\)/);
    assert.match(text, /✗ spotify:artist:b \(id: b\)/);
    assert.ok(!text.includes('✓ c'));
    assert.match(text, /\(1 more — pass offset or fetch_all\)/);

    const sc = out.structuredContent as { items: Array<{ id: string; follows: boolean }> };
    assert.deepEqual(sc.items, [
      { id: 'a', uri: 'spotify:artist:a', follows: true },
      { id: 'b', uri: 'spotify:artist:b', follows: false },
    ]);
  });

  it('json mode parses to items + pagination (#51)', async () => {
    const h = makeHarness(() => [false]);
    const out = await h.invoke('check_following_artists', {
      ids: ['x'],
      response_format: 'json',
    });
    const payload = JSON.parse(out.content[0].text);
    assert.deepEqual(payload.items, [{ id: 'x', uri: 'spotify:artist:x', follows: false }]);
    assert.deepEqual(out.structuredContent, payload);
  });
});

// ---------------------------------------------------------------------------
// #638: the read half of following migrated from GET /me/following/contains
// (removed by Spotify's February 2026 changes) to GET /me/library/contains.
// The write half has no target at all, so these tests pin both the endpoint
// move and the strict shape validation that replaced the old
// `if (!result) throw` + `result[i] ?? false` — which reported every artist
// as "✗ not followed" whenever the body was anything but a clean boolean
// array.
// ---------------------------------------------------------------------------

describe('check_following_artists reads GET /me/library/contains (#638)', () => {
  it('sends one spotify:artist: URI per requested id, in request order, and never touches /me/following/contains', async () => {
    const h = makeHarness(() => [true, true, true]);

    await h.invoke('check_following_artists', { ids: ['a1', 'a2', 'a3'] });

    // The removed endpoint is not called under any spelling.
    assert.ok(
      !h.calls.some((c) => c.path.includes('/me/following/contains')),
      'the removed /me/following/contains endpoint must not be called',
    );
    assert.equal(h.calls.length, 1, 'one library-contains read covers the whole batch');
    assert.equal(h.calls[0].method, 'GET');
    assert.equal(h.calls[0].path, '/me/library/contains');
    assert.deepEqual(
      h.calls[0].arg,
      { uris: 'spotify:artist:a1,spotify:artist:a2,spotify:artist:a3' },
      'order is preserved so each boolean lines up with the id that asked for it',
    );
  });

  it('rejects rather than reporting every row as not followed when the body is not an array', async () => {
    // Spotify's error body for this endpoint has shipped as a truthy object;
    // the old guard (`if (!result) throw`) let it through, and the old
    // `result[i] ?? false` then reported all three artists as not followed.
    const h = makeHarness(() => ({ error: { status: 403, message: 'Forbidden' } }));

    await assert.rejects(
      () => h.invoke('check_following_artists', { ids: ['a', 'b', 'c'] }),
      (err: Error) => {
        assert.match(err.message, /Could not check following status/);
        assert.match(err.message, /GET \/me\/library\/contains returned a non-array body/);
        assert.match(err.message, /3 requested URI\(s\)/);
        return true;
      },
    );
  });

  it('rejects when the boolean array is shorter than the requested ids', async () => {
    const h = makeHarness(() => [true]);

    await assert.rejects(
      () => h.invoke('check_following_artists', { ids: ['a', 'b', 'c'] }),
      (err: Error) => {
        assert.match(err.message, /Could not check following status/);
        assert.match(err.message, /returned 1 booleans for 3 requested URI\(s\)/);
        return true;
      },
    );
  });

  it('rejects when the boolean array is longer than the requested ids', async () => {
    const h = makeHarness(() => [true, false, true, true]);

    await assert.rejects(
      () => h.invoke('check_following_artists', { ids: ['a', 'b', 'c'] }),
      /returned 4 booleans for 3 requested URI\(s\)/,
    );
  });

  it('rejects when an element is not a boolean', async () => {
    // A null or object element at the right length is still an unread body:
    // coercing it would invent a follow verdict.
    const h = makeHarness(() => [true, null, false]);

    await assert.rejects(
      () => h.invoke('check_following_artists', { ids: ['a', 'b', 'c'] }),
      (err: Error) => {
        assert.match(err.message, /Could not check following status/);
        assert.match(err.message, /returned a non-boolean element/);
        return true;
      },
    );
  });

  it('reports a well-formed response, including a genuine false row', async () => {
    const h = makeHarness(() => [true, false, true]);

    const out = await h.invoke('check_following_artists', { ids: ['a', 'b', 'c'] });

    const text = textOf(out);
    assert.match(text, /^Following check:/);
    assert.match(text, /✓ spotify:artist:a \(id: a\)/);
    // The false row is a real answer from the server, not a default.
    assert.match(text, /✗ spotify:artist:b \(id: b\)/);
    assert.match(text, /✓ spotify:artist:c \(id: c\)/);
    assert.ok(!text.includes('(id: d)'));

    const sc = out.structuredContent as { items: Array<{ id: string; follows: boolean }> };
    assert.deepEqual(sc.items, [
      { id: 'a', uri: 'spotify:artist:a', follows: true },
      { id: 'b', uri: 'spotify:artist:b', follows: false },
      { id: 'c', uri: 'spotify:artist:c', follows: true },
    ]);
  });
});

// ---------------------------------------------------------------------------
// get_followed_artists fetch_all (#744)
// ---------------------------------------------------------------------------

describe('get_followed_artists fetch_all (#744)', () => {
  /** One `/me/following` page: `n` artists, an `after` cursor, a reported total. */
  const followedPage = (from: number, n: number, total: number, after: string | null) => ({
    artists: {
      items: Array.from({ length: n }, (_, i) => followedArtist(`a${from + i}`, `Artist ${from + i}`)),
      total,
      cursors: after === null ? null : { after },
      next: null,
    },
  });

  it('walks every `after` page and returns all three pages in one result', async () => {
    // 120 follows over 50 + 50 + 20: the third page is short, which is the
    // only signal that the cursor is exhausted.
    const pages = [
      followedPage(0, 50, 120, 'cur-1'),
      followedPage(50, 50, 120, 'cur-2'),
      followedPage(100, 20, 120, null),
    ];
    let call = 0;
    const h = makeHarness(() => {
      const page = pages[call++];
      assert.ok(page, 'the walk must not ask for a fourth page');
      return page;
    });

    const out = await h.invoke('get_followed_artists', { fetch_all: true });

    // The exact wire calls: one full page per request, each carrying the
    // previous response's cursor, and no manual limit/after of the caller's.
    assert.equal(h.calls.length, 3);
    assert.ok(h.calls.every((c) => c.method === 'GET' && c.path === '/me/following'));
    assert.deepEqual(h.calls.map((c) => c.arg), [
      { type: 'artist', limit: '50' },
      { type: 'artist', limit: '50', after: 'cur-1' },
      { type: 'artist', limit: '50', after: 'cur-2' },
    ]);

    const sc = out.structuredContent as { items: unknown[]; truncated_by_cap: boolean; next_cursor: string | null };
    assert.equal(sc.items.length, 120, 'every followed artist is returned in the one call');
    assert.equal(sc.truncated_by_cap, false);
    assert.equal(sc.next_cursor, null);
    assert.match(textOf(out), /^Followed artists \(120 fetched, showing 120\):/);
  });

  it('reports truncated_by_cap instead of stopping silently at the fetch-all cap', async () => {
    // More follows than SPOTIFY_MCP_FETCH_ALL_CAP (500) and an endless cursor.
    let call = 0;
    const h = makeHarness(() => followedPage(call++ * 50, 50, 900, `cur-${call}`));

    const out = await h.invoke('get_followed_artists', { fetch_all: true });

    // The walk stops at the cap rather than paging forever.
    assert.equal(h.calls.length, 10, '500 rows at 50 per page is 10 requests, never an 11th');
    const sc = out.structuredContent as { items: unknown[]; truncated_by_cap: boolean; next_cursor: string | null };
    assert.equal(sc.items.length, 500);
    assert.equal(sc.truncated_by_cap, true);
    assert.equal(sc.next_cursor, 'cur-10', 'the caller can resume from the cursor the walk stopped on');
    assert.match(textOf(out), /500 fetched of 900, showing 500/);
    assert.match(textOf(out), /\(400 more — fetch-all cap REACHED; pass after=cur-10 to continue\)/);
  });
});

// ---------------------------------------------------------------------------
// Artist reference normalisation in check_following_artists (#745)
// ---------------------------------------------------------------------------

describe('check_following_artists normalises artist references (#745)', () => {
  it('sends one spotify:artist: URI per requested id when the caller passes URIs', async () => {
    const h = makeHarness(() => [true, false]);
    const out = await h.invoke('check_following_artists', {
      ids: ['spotify:artist:a', 'b'],
    });

    // The URI and the bare id reach the same wire call, and the rows echo the
    // normalised ids so the caller can see what was sent.
    assert.equal(h.calls.length, 1);
    assert.deepEqual(h.calls[0].arg, {
      uris: 'spotify:artist:a,spotify:artist:b',
    });
    const sc = out.structuredContent as { items: Array<{ id: string; uri: string }> };
    assert.deepEqual(sc.items, [
      { id: 'a', uri: 'spotify:artist:a', follows: true },
      { id: 'b', uri: 'spotify:artist:b', follows: false },
    ]);
  });

  it('accepts a CSV string and rejects a wrong-kind reference by name', async () => {
    const h = makeHarness(() => [true, false]);

    // Hosts that serialise array params as CSV hand us one string.
    await h.invoke('check_following_artists', { ids: 'a,spotify:artist:b' });
    assert.deepEqual(h.calls[0].arg, {
      uris: 'spotify:artist:a,spotify:artist:b',
    });

    await assert.rejects(
      () => h.invoke('check_following_artists', { ids: ['spotify:track:x'] }),
      /Invalid artist reference "spotify:track:x".*expected artist/,
    );
    assert.equal(h.calls.length, 1, 'the rejected reference never reached Spotify');
  });
});

// ---------------------------------------------------------------------------
// following_analytics — group_by over the tag sidecar (#733). Spotify no
// longer returns artist `genres`, `popularity`, or `followers` on the followed
// artist object. The only remaining dimension is `genre` (sourced from the
// sidecar); `popularity` and `followers` report `available:false` with no
// coerced zeros.
// ---------------------------------------------------------------------------

// Sidecar helpers. Each test runs against an isolated temp store so a malformed
// file left over from another test cannot poison this one (#1053-style blast
// radius — same pattern as tests/tools.libraryinsights.test.ts).
const savedSidecarEnv = process.env.SPOTIFY_MCP_GENRE_TAGS_FILE;
let sidecarDir: string;
let sidecarPath: string;

beforeEach(() => {
  sidecarDir = mkdtempSync(join(tmpdir(), 'following-tags-'));
  sidecarPath = join(sidecarDir, 'genre-tags.json');
  process.env.SPOTIFY_MCP_GENRE_TAGS_FILE = sidecarPath;
});

afterEach(() => {
  rmSync(sidecarDir, { recursive: true, force: true });
  if (savedSidecarEnv === undefined) delete process.env.SPOTIFY_MCP_GENRE_TAGS_FILE;
  else process.env.SPOTIFY_MCP_GENRE_TAGS_FILE = savedSidecarEnv;
});

function seedTags(entries: Record<string, string[]>): void {
  writeFileSync(sidecarPath, `${JSON.stringify({ version: 1, tags: entries }, null, 2)}\n`, 'utf8');
}

/** One followed-artist page with `n` artists named `Artist <i>`. */
function followedPage(n: number) {
  return {
    artists: {
      items: Array.from({ length: n }, (_, i) => followedArtist(`a${i}`, `Artist ${i}`)),
      total: n,
      cursors: null,
      next: null,
    },
  };
}

describe('following_analytics', () => {
  it('group_by=genre: sources counts from the tag sidecar with no artist.genres on the wire', async () => {
    seedTags({ 'Artist 0': ['pop'], 'Artist 1': ['pop', 'indie'], 'Artist 2': ['indie'] });
    const h = makeHarness(() => followedPage(3));
    const out = await h.invoke('following_analytics', { group_by: 'genre' });
    const sc = out.structuredContent as {
      available: boolean; source: string;
      items: Array<{ key: string; count: number }>;
      total_artists: number; tagged_artists: number;
    };
    assert.equal(sc.available, true);
    assert.equal(sc.source, 'user-declared tags');
    assert.equal(sc.total_artists, 3);
    assert.equal(sc.tagged_artists, 3, 'every followed artist had a sidecar entry');
    // pop = 2 (Artist 0 + Artist 1), indie = 2 (Artist 1 + Artist 2). Ties
    // broken by key so pop precedes indie alphabetically.
    assert.deepEqual(sc.items.slice(0, 2).map((i) => i.key), ['indie', 'pop']);
    assert.equal(sc.items.find((i) => i.key === 'pop')?.count, 2);
    assert.equal(sc.items.find((i) => i.key === 'indie')?.count, 2);
    assert.match(textOf(out), /user-declared tags/);
  });

  it('group_by=genre: returns available:false when the sidecar has no entries', async () => {
    seedTags({});
    const h = makeHarness(() => followedPage(2));
    const out = await h.invoke('following_analytics', { group_by: 'genre' });
    const sc = out.structuredContent as {
      available: boolean; reason: string; source: string;
      items: unknown[]; tagged_artists: number;
    };
    assert.equal(sc.available, false, 'an empty sidecar makes the dimension unavailable');
    assert.match(sc.reason, /Spotify no longer returns artist genres/);
    // The acceptance clause: no bucket key derived from coerced zeros.
    // Specifically the writer does not invent "Artist 0" or "0-24" rows.
    assert.deepEqual(sc.items, []);
    assert.equal(sc.tagged_artists, 0);
    assert.match(textOf(out), /no followed artist has a tag declared/);
  });

  it('group_by=genre: returns available:false when no walked artist has a tag declared', async () => {
    // Sidecar has entries, but none of them are followed artists.
    seedTags({ 'Unrelated': ['rock'] });
    const h = makeHarness(() => followedPage(2));
    const out = await h.invoke('following_analytics', { group_by: 'genre' });
    const sc = out.structuredContent as { available: boolean; tagged_artists: number };
    assert.equal(sc.available, false);
    assert.equal(sc.tagged_artists, 0);
  });

  it('group_by=popularity: returns available:false with no coerced bucket keys (#733)', async () => {
    const h = makeHarness(() => followedPage(3));
    const out = await h.invoke('following_analytics', { group_by: 'popularity' });
    const sc = out.structuredContent as {
      available: boolean; group_by: string; items: unknown[]; total_artists: number;
    };
    assert.equal(sc.available, false, 'popularity has no source on the wire — refuse to coerce zeros');
    assert.equal(sc.group_by, 'popularity');
    // The acceptance clause: no bucket key derived from coerced zeros. The
    // old `{ "75-100": N }` output would be a number-lie here.
    assert.deepEqual(sc.items, [], 'no bucket keys appear');
    assert.match(textOf(out), /Spotify no longer returns .*popularity/);
  });

  it('group_by=followers: returns available:false with no coerced bucket keys (#733)', async () => {
    const h = makeHarness(() => followedPage(3));
    const out = await h.invoke('following_analytics', { group_by: 'followers' });
    const sc = out.structuredContent as { available: boolean; items: unknown[] };
    assert.equal(sc.available, false);
    assert.deepEqual(sc.items, []);
    assert.match(textOf(out), /Spotify no longer returns.*follower counts/);
  });
});
