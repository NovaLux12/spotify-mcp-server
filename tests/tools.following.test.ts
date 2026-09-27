/**
 * Tests for src/tools/following.ts (issues #34, #35, and wave-B shaping
 * #51/#52/#53/#57/#58).
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
// follow_artists (#34)
// ---------------------------------------------------------------------------

describe('follow_artists', () => {
  it('sends PUT /me/following with type=artist and comma-joined ids in the query string', async () => {
    const h = makeHarness();
    await h.invoke('follow_artists', { ids: ['artist1', 'artist2', 'artist3'] });

    assert.equal(h.calls.length, 1);
    assert.equal(h.calls[0].method, 'PUT');
    assert.equal(h.calls[0].path, '/me/following?type=artist&ids=artist1,artist2,artist3');
  });

  it('sends no request body', async () => {
    const h = makeHarness();
    await h.invoke('follow_artists', { ids: ['solo'] });

    assert.equal(h.calls[0].arg, undefined);
  });

  it('rejects an empty ids array and more than 50 ids via schema bounds', () => {
    const h = makeHarness();
    const tool = h.registered.find((t) => t.name === 'follow_artists');
    assert.ok(tool);

    assert.throws(() => tool.validate({ ids: [] }));
    assert.throws(() => tool.validate({ ids: Array.from({ length: 51 }, (_, i) => `a${i}`) }));
    // Boundary: exactly 50 must pass validation.
    assert.doesNotThrow(() =>
      tool.validate({ ids: Array.from({ length: 50 }, (_, i) => `a${i}`) }),
    );
  });

  it('confirms the number of artists followed', async () => {
    const h = makeHarness();
    const out = await h.invoke('follow_artists', { ids: ['a', 'b'] });

    assert.match(textOf(out), /Followed 2 artist/);
  });

  it('dry_run makes zero client calls and previews artist URIs (#57)', async () => {
    const h = makeHarness();
    const out = await h.invoke('follow_artists', { ids: ['a'], dry_run: true });

    assert.equal(h.calls.length, 0, 'dry_run must not touch the API');
    const text = textOf(out);
    assert.match(text, /^\[dry run\] follow_artists on <<untrusted: followed artists >> — nothing was changed\./);
    assert.match(text, /Would affect 1 item:/);
    assert.ok(text.includes('spotify:artist:a'));

    const sc = out.structuredContent as Record<string, unknown>;
    assert.equal(sc.dry_run, true);
    assert.deepEqual(sc.would_affect, ['spotify:artist:a']);
  });
});

// ---------------------------------------------------------------------------
// unfollow_artists (#35)
// ---------------------------------------------------------------------------

describe('unfollow_artists', () => {
  it('sends DELETE /me/following with type=artist and comma-joined ids in the query string', async () => {
    const h = makeHarness();
    await h.invoke('unfollow_artists', { ids: ['artist1', 'artist2'] });

    assert.equal(h.calls.length, 1);
    assert.equal(h.calls[0].method, 'DELETE');
    assert.equal(h.calls[0].path, '/me/following?type=artist&ids=artist1,artist2');
  });

  it('sends no request body', async () => {
    const h = makeHarness();
    await h.invoke('unfollow_artists', { ids: ['solo'] });

    assert.equal(h.calls[0].arg, undefined);
  });

  it('rejects an empty ids array and more than 50 ids via schema bounds', () => {
    const h = makeHarness();
    const tool = h.registered.find((t) => t.name === 'unfollow_artists');
    assert.ok(tool);

    assert.throws(() => tool.validate({ ids: [] }));
    assert.throws(() => tool.validate({ ids: Array.from({ length: 51 }, (_, i) => `a${i}`) }));
    // Boundary: exactly 50 must pass validation.
    assert.doesNotThrow(() =>
      tool.validate({ ids: Array.from({ length: 50 }, (_, i) => `a${i}`) }),
    );
  });

  it('confirms the number of artists unfollowed', async () => {
    const h = makeHarness();
    const out = await h.invoke('unfollow_artists', { ids: ['a', 'b', 'c'] });

    assert.match(textOf(out), /Unfollowed 3 artist/);
  });
});

// ---------------------------------------------------------------------------
// Registration alongside the existing read-side tools
// ---------------------------------------------------------------------------

describe('following module registrations', () => {
  it('registers both new write tools next to the existing read tools', () => {
    const h = makeHarness();
    const names = h.registered.map((t) => t.name);

    for (const expected of [
      'get_followed_artists',
      'check_following_artists',
      'follow_artists',
      'unfollow_artists',
    ]) {
      assert.ok(names.includes(expected), `expected "${expected}" to be registered`);
    }
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

describe('mutation summaries + dry_run on follow tools (#57/#58)', () => {
  it('follow_artists echoes "{n} items affected" with artist URIs (#58)', async () => {
    const h = makeHarness();
    const out = await h.invoke('follow_artists', { ids: ['a', 'b'] });
    assert.match(
      textOf(out),
      /2 items affected: spotify:artist:a, spotify:artist:b/,
    );
  });

  it('unfollow_artists echoes the removed URIs (#58)', async () => {
    const h = makeHarness();
    const out = await h.invoke('unfollow_artists', { ids: ['only1'] });
    assert.match(textOf(out), /1 item affected: spotify:artist:only1/);
  });

  it('unfollow_artists dry_run makes zero client calls and previews artist URIs (#57)', async () => {
    const h = makeHarness();
    const out = await h.invoke('unfollow_artists', { ids: ['a', 'b'], dry_run: true });

    assert.equal(h.calls.length, 0, 'dry_run must not touch the API');
    const text = textOf(out);
    assert.match(text, /^\[dry run\] unfollow_artists on <<untrusted: followed artists >> — nothing was changed\./);
    assert.match(text, /Would affect 2 items:/);
    assert.ok(text.includes('spotify:artist:a') && text.includes('spotify:artist:b'));

    const sc = out.structuredContent as Record<string, unknown>;
    assert.equal(sc.dry_run, true);
    assert.deepEqual(sc.would_affect, ['spotify:artist:a', 'spotify:artist:b']);
  });

  it('follow_artists json output reports ok/affected (#51)', async () => {
    const h = makeHarness();
    const out = await h.invoke('follow_artists', { ids: ['a'], response_format: 'json' });
    const payload = JSON.parse(out.content[0].text);
    assert.equal(payload.ok, true);
    assert.equal(payload.affected, 1);
    assert.deepEqual(payload.uris, ['spotify:artist:a']);
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
// Artist reference normalisation in the follow family (#745)
// ---------------------------------------------------------------------------

describe('follow family normalises artist references (#745)', () => {
  it('sends bare ids on the wire when the caller passes spotify:artist: URIs', async () => {
    const h = makeHarness();
    const out = await h.invoke('follow_artists', { ids: ['spotify:artist:a', 'b'] });

    // The URI and the bare id reach the same wire call.
    assert.equal(h.calls.length, 1);
    assert.equal(h.calls[0].method, 'PUT');
    assert.equal(h.calls[0].path, '/me/following?type=artist&ids=a,b');
    // …and the normalised ids are echoed so the caller can see what was sent.
    const sc = out.structuredContent as { affected: number; uris: string[] };
    assert.equal(sc.affected, 2);
    assert.deepEqual(sc.uris, ['spotify:artist:a', 'spotify:artist:b']);
  });

  it('normalises unfollow_artists and check_following_artists the same way', async () => {
    const h = makeHarness(() => [true]);

    await h.invoke('unfollow_artists', { ids: ['spotify:artist:xyz789'] });
    assert.equal(h.calls[0].method, 'DELETE');
    assert.equal(h.calls[0].path, '/me/following?type=artist&ids=xyz789');

    const out = await h.invoke('check_following_artists', { ids: ['spotify:artist:xyz789'] });
    assert.deepEqual(h.calls[1].arg, { type: 'artist', ids: 'xyz789' });
    const sc = out.structuredContent as { items: Array<{ id: string; uri: string }> };
    assert.deepEqual(sc.items, [{ id: 'xyz789', uri: 'spotify:artist:xyz789', follows: true }]);
  });

  it('accepts a CSV string and rejects a wrong-kind reference by name', async () => {
    const h = makeHarness(() => [true, false]);

    // Hosts that serialise array params as CSV hand us one string.
    await h.invoke('follow_artists', { ids: 'a,spotify:artist:b' });
    assert.equal(h.calls[0].path, '/me/following?type=artist&ids=a,b');

    await assert.rejects(
      () => h.invoke('follow_artists', { ids: ['spotify:track:x'] }),
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
