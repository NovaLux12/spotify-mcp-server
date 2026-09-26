/**
 * Tests for src/tools/following.ts (issues #34, #35, and wave-B shaping
 * #51/#52/#53/#57/#58).
 *
 * Same stub harness pattern as tests/tools.playlists-following.test.ts:
 * stub MCP server + stub SpotifyClient that records every call.
 *
 * Run: node --import tsx --test tests/tools.following.test.ts
 */

import { describe, it } from 'node:test';
import { z } from 'zod';
import assert from 'node:assert/strict';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { readFile } from 'node:fs/promises';
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

/**
 * The `uris` query/body of a recorded call, split into individual URIs.
 * Narrowed at runtime rather than cast, so a call that sent some other shape
 * fails the assertion instead of reading `undefined` and passing quietly.
 */
function urisOf(call: RecordedCall): string[] {
  const arg: unknown = call.arg;
  assert.ok(arg !== null && typeof arg === 'object' && 'uris' in arg, 'call must carry a `uris` param');
  const uris: unknown = arg.uris;
  assert.ok(typeof uris === 'string', '`uris` must be a string');
  return uris.split(',');
}

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
  // #594: PUT /me/following was removed in February 2026, and the documented
  // replacement — PUT /me/library — does NOT accept spotify:artist: URIs
  // (supported: track, album, episode, show, audiobook, user, playlist).
  // No call can follow an artist, so the tool refuses instead of issuing a
  // request that looks migrated while following nothing.
  it('refuses without issuing any request', async () => {
    const h = makeHarness();
    await assert.rejects(
      () => h.invoke('follow_artists', { ids: ['artist1', 'artist2', 'artist3'] }),
      /follow_artists cannot run/,
    );
    assert.equal(h.calls.length, 0, 'no request may be issued — there is no endpoint to call');
  });

  it('names the real blocker rather than blaming a scope', async () => {
    const h = makeHarness();
    await assert.rejects(
      () => h.invoke('follow_artists', { ids: ['a'] }),
      (err: Error) => {
        assert.match(err.message, /PUT\/DELETE \/me\/library/);
        assert.match(err.message, /does not accept spotify:artist: URIs/);
        return true;
      },
    );
  });

  it('refuses dry_run too — a preview of an impossible write would mislead', async () => {
    const h = makeHarness();
    await assert.rejects(
      () => h.invoke('follow_artists', { ids: ['a'], dry_run: true }),
      /follow_artists cannot run/,
    );
    assert.equal(h.calls.length, 0);
  });

  it('still rejects a wrong-kind reference by name before refusing', async () => {
    const h = makeHarness();
    await assert.rejects(
      () => h.invoke('follow_artists', { ids: ['spotify:track:x'] }),
      /Invalid artist reference "spotify:track:x".*expected artist/,
    );
    assert.equal(h.calls.length, 0, 'the rejected reference never reached Spotify');
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
});

// ---------------------------------------------------------------------------
// unfollow_artists (#35)
// ---------------------------------------------------------------------------

describe('unfollow_artists', () => {
  // #594: DELETE /me/following is gone and DELETE /me/library does not accept
  // spotify:artist: URIs either, so there is no call that can unfollow one.
  it('refuses without issuing any request', async () => {
    const h = makeHarness();
    await assert.rejects(
      () => h.invoke('unfollow_artists', { ids: ['artist1', 'artist2'] }),
      /unfollow_artists cannot run/,
    );
    assert.equal(h.calls.length, 0, 'no request may be issued — there is no endpoint to call');
  });

  it('refuses dry_run rather than previewing an impossible write', async () => {
    const h = makeHarness();
    await assert.rejects(
      () => h.invoke('unfollow_artists', { ids: ['a'], dry_run: true }),
      /unfollow_artists cannot run/,
    );
    assert.equal(h.calls.length, 0);
  });

  it('still rejects a wrong-kind reference by name before refusing', async () => {
    const h = makeHarness();
    await assert.rejects(
      () => h.invoke('unfollow_artists', { ids: ['spotify:album:x'] }),
      /Invalid artist reference "spotify:album:x".*expected artist/,
    );
    assert.equal(h.calls.length, 0);
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

// ---------------------------------------------------------------------------
// #594 — the follow-state check migrated to GET /me/library/contains.
// These assert the ACTUAL request path and URI form on the wire. A stubbed
// client answers whatever path it is handed, so a test that only asserted the
// returned booleans would have passed happily against the removed
// GET /me/following/contains — the path and the `uris` form are the contract.
// ---------------------------------------------------------------------------

describe('check_following_artists wire migration (#594)', () => {
  it('requests /me/library/contains with spotify:artist: URIs, never /me/following/contains', async () => {
    const h = makeHarness(() => [true, false, true]);
    await h.invoke('check_following_artists', { ids: ['a', 'b', 'c'] });

    assert.equal(h.calls.length, 1);
    assert.equal(h.calls[0].method, 'GET');
    // The exact migrated path — this is what the test exists to pin.
    assert.equal(h.calls[0].path, '/me/library/contains');
    // The exact URI form: /me/library/contains takes `uris`, not `ids`+`type`.
    assert.deepEqual(h.calls[0].arg, {
      uris: 'spotify:artist:a,spotify:artist:b,spotify:artist:c',
    });
    // The removed endpoint and the old query shape must both be gone.
    assert.ok(!JSON.stringify(h.calls).includes('/me/following/contains'));
    assert.ok(!JSON.stringify(h.calls).includes('"type":"artist"'));
  });

  it('sends the boolean flags through in order, one per requested URI', async () => {
    const h = makeHarness(() => [false, true]);
    const out = await h.invoke('check_following_artists', { ids: ['x', 'y'] });

    // Position matters: the response array is positional against `uris`.
 assert.equal(h.calls[0].path, '/me/library/contains');
    assert.deepEqual(h.calls[0].arg, { uris: 'spotify:artist:x,spotify:artist:y' });
    const sc = out.structuredContent as { items: Array<{ id: string; follows: boolean }> };
    assert.deepEqual(sc.items, [
      { id: 'x', uri: 'spotify:artist:x', follows: false },
      { id: 'y', uri: 'spotify:artist:y', follows: true },
    ]);
  });

  it('chunks at the documented 40-URI cap of /me/library/contains', async () => {
    // 50 ids are accepted by the schema; the endpoint takes at most 40 URIs
    // per request, so a single 50-URI request would be rejected by Spotify.
    const ids = Array.from({ length: 50 }, (_, i) => `a${i}`);
    const h = makeHarness((_path, arg) => {
      assert.ok(arg !== null && typeof arg === 'object' && 'uris' in arg);
      return String(arg.uris).split(',').map(() => true);
    });
    await h.invoke('check_following_artists', { ids });

    assert.equal(h.calls.length, 2, '50 URIs must split into 40 + 10, not one 50-URI call');
    for (const call of h.calls) {
      assert.equal(call.path, '/me/library/contains');
      const uris = urisOf(call);
      assert.ok(uris.length <= 40, `chunk of ${uris.length} exceeds the documented 40 cap`);
      for (const uri of uris) assert.match(uri, /^spotify:artist:a\d+$/);
    }
    assert.equal(urisOf(h.calls[0]).length, 40);
    assert.equal(urisOf(h.calls[1]).length, 10);
  });

  it('reassembles chunked flags back onto the right artists', async () => {
    const ids = Array.from({ length: 45 }, (_, i) => `a${i}`);
    const h = makeHarness((_path, arg) => {
      assert.ok(arg !== null && typeof arg === 'object' && 'uris' in arg);
      return String(arg.uris)
        .split(',')
        // Only the 41st artist (index 40, first of chunk two) is followed.
        .map((uri) => uri === 'spotify:artist:a40');
    });
    const out = await h.invoke('check_following_artists', { ids });

    const sc = out.structuredContent as { items: Array<{ id: string; follows: boolean }> };
    const followed = sc.items.filter((i) => i.follows);
    assert.deepEqual(followed.map((i) => i.id), ['a40'], 'flags must not shift across the chunk boundary');
  });

  it('fails rather than reporting false for a short /me/library/contains reply (#594)', async () => {
    // Three URIs sent, one boolean back. The old `flags[i] ?? false` spread
    // reported `follows: false` for b and c — two artists nobody read — and
    // across the 40-chunk boundary it attributed a40's answer to a39. A short
    // reply is a failed read, not a row of negatives.
    const h = makeHarness(() => [true]);
    await assert.rejects(
      () => h.invoke('check_following_artists', { ids: ['a', 'b', 'c'] }),
      /expected 3 flag\(s\) for 3 URI\(s\), got 1/,
    );
  });

  it('fails on a short chunk rather than misattributing across the boundary (#594)', async () => {
    // 45 ids: chunk one is 40. If chunk one came back one short, spreading it
    // would slide every later flag left and report a39 as the followed artist.
    const ids = Array.from({ length: 45 }, (_, i) => `a${i}`);
    let call = 0;
    const h = makeHarness((_path, arg) => {
      assert.ok(arg !== null && typeof arg === 'object' && 'uris' in arg);
      const uris = String(arg.uris).split(',');
      call += 1;
      // Chunk one is deliberately one flag short of the 40 URIs it was sent.
      return call === 1 ? uris.slice(0, uris.length - 1).map(() => false) : uris.map(() => true);
    });
    await assert.rejects(
      () => h.invoke('check_following_artists', { ids }),
      /expected 40 flag\(s\) for 40 URI\(s\), got 39/,
    );
  });

  it('fails when the reply is not an array at all', async () => {
    const h = makeHarness(() => null);
    await assert.rejects(
      () => h.invoke('check_following_artists', { ids: ['a', 'b'] }),
      /got no array/,
    );
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
  // Spotify artist ids are 22 characters, so the fixtures below pad to that.
  const idA = 'a'.repeat(22);
  const idB = 'b'.repeat(22);
  const idC = 'c'.repeat(22);
  // #594: the write tools no longer reach the wire, so normalisation is
  // asserted through check_following_artists — the remaining tool in this
  // family that actually issues a request. The point is unchanged: a URI, a
  // bare id and a URL are one id on the wire.
  it('sends canonical spotify:artist: URIs when the caller passes mixed forms', async () => {
    // One flag per URI: the endpoint's reply is positional, and a short
    // array is now a hard failure rather than a row of invented `false`s.
    const h = makeHarness(() => [true, true, true]);
    const out = await h.invoke('check_following_artists', {
      ids: [
        `spotify:artist:${idA}`,
        idB,
        `https://open.spotify.com/artist/${idC}`,
      ],
    });

    assert.equal(h.calls.length, 1);
    assert.equal(h.calls[0].path, '/me/library/contains');
    assert.deepEqual(urisOf(h.calls[0]), [
      `spotify:artist:${idA}`,
      `spotify:artist:${idB}`,
      `spotify:artist:${idC}`,
    ]);
    // …and the normalised ids are echoed so the caller can see what was sent.
    const sc = out.structuredContent as { items: Array<{ id: string; uri: string }> };
    assert.deepEqual(
      sc.items.map((i) => i.id),
      [idA, idB, idC],
    );
  });

  it('accepts a CSV string and rejects a wrong-kind reference by name', async () => {
    const h = makeHarness(() => [true, false]);

    // Hosts that serialise array params as CSV hand us one string.
    const out = await h.invoke('check_following_artists', { ids: `${idA},spotify:artist:${idB}` });
    assert.deepEqual(urisOf(h.calls[0]), [`spotify:artist:${idA}`, `spotify:artist:${idB}`]);
    const sc = out.structuredContent as { items: Array<{ id: string; follows: boolean }> };
    assert.deepEqual(sc.items.map((i) => i.id), [idA, idB]);

    await assert.rejects(
      () => h.invoke('check_following_artists', { ids: ['spotify:track:x'] }),
      /Invalid artist reference "spotify:track:x".*expected artist/,
    );
    assert.equal(h.calls.length, 1, 'the rejected reference never reached Spotify');
  });
});

// ---------------------------------------------------------------------------
// following_analytics — batch /artists?ids= removed in Feb 2026 (#594)
// ---------------------------------------------------------------------------

describe('following_analytics batch-endpoint removal (#594)', () => {
  /** One short `/me/following` page so the cursor walk ends after a single call. */
  const onePage = (artists: Array<{ id: string; name: string; genres: string[] }>) => ({
    artists: {
      items: artists,
      total: artists.length,
      cursors: null,
      next: null,
    },
  });

  it('rolls up the walk itself — no per-artist fan-out, no removed batch endpoint', async () => {
    const h = makeHarness((path) => {
      if (path === '/me/following') {
        return onePage([
          { id: 'a1', name: 'A1', genres: ['rock'] },
          { id: 'b2', name: 'B2', genres: ['rock', 'jazz'] },
        ]);
      }
      return null;
    });

    const out = await h.invoke('following_analytics', { group_by: 'genre' });

    // The walk already carries `genres` on every item, so a per-artist
    // GET /artists/{id} would buy nothing and cost N requests (N reaches
    // fetchAllCap = 500). The rollup must read what the walk returned.
    assert.deepEqual(
      h.calls.map((c) => c.path),
      ['/me/following'],
      'following_analytics must issue only the walk — no per-artist enrichment',
    );
    // The removed batch endpoint must appear nowhere, in any form.
    assert.ok(
      !h.calls.some((c) => c.path === '/artists' || String(c.path).includes('ids=')),
      'no call may target the removed batch /artists?ids= endpoint',
    );
    assert.match(textOf(out), /rock: 2/);
  });

  it('reports total_artists as the artists it measured, not an enriched subset (#594)', async () => {
    // The old per-id fan-out silently dropped artists whose /artists/{id}
    // read failed, so total_artists and every bucket counted a subset with
    // no disclosure. The denominator must be the walked count.
    const h = makeHarness((path) => {
      if (path === '/me/following') {
        return onePage([
          { id: 'a1', name: 'A1', genres: ['rock'] },
          { id: 'b2', name: 'B2', genres: ['rock'] },
          { id: 'c3', name: 'C3', genres: ['jazz'] },
        ]);
      }
      return null;
    });

    const out = await h.invoke('following_analytics', { group_by: 'genre' });
    const payload = out.structuredContent as Record<string, unknown>;
    assert.equal(payload.total_artists, 3, 'all three walked artists are counted');
    assert.match(textOf(out), /\(3 artists, by genre\)/);
  });

  it('refuses popularity and followers rollups — those Artist fields no longer exist', async () => {
    // Spotify removed `popularity` and `followers` from Artist objects in the
    // same February 2026 release. The old code defaulted both to 0, which
    // reported every artist as "0-24"/"<10K" — a named rollup full of lies.
    for (const group_by of ['popularity', 'followers']) {
      const h = makeHarness(() => onePage([]));
      await assert.rejects(
        () => h.invoke('following_analytics', { group_by }),
        (err: Error) => {
          assert.match(err.message, /removed the popularity|followers field/);
          assert.match(err.message, /group_by="genre"/);
          return true;
        },
      );
      assert.equal(h.calls.length, 0, `${group_by} must be refused before any request`);
    }
  });
});

// ---------------------------------------------------------------------------
// #594 — module-wide guard: no code path may reach a removed endpoint.
// A stub client answers whatever path it is handed, so the only way to prove
// a removed endpoint is unreachable is to drive every tool and inspect what
// actually went out on the wire.
// ---------------------------------------------------------------------------

const REMOVED_ENDPOINTS: Array<{ label: string; match: (c: RecordedCall) => boolean }> = [
  { label: 'PUT /me/following', match: (c) => c.method === 'PUT' && c.path.startsWith('/me/following') },
  {
    label: 'DELETE /me/following',
    match: (c) => c.method === 'DELETE' && c.path.startsWith('/me/following'),
  },
  {
    label: 'GET /me/following/contains',
    match: (c) => c.method === 'GET' && c.path === '/me/following/contains',
  },
  {
    // The per-id replacement is `/artists/{id}`; only the batch collection
    // request was removed — whether the ids rode in the query string or in
    // the params object. `/artists/{id}` is a surviving, supported call.
    label: 'GET /artists?ids=',
    match: (c) => c.path === '/artists' || c.path.startsWith('/artists?'),
  },
];

describe('no removed follow/artist-batch endpoint is reachable (#594)', () => {
  it('drives every registered tool and records zero removed-endpoint calls', async () => {
    const h = makeHarness((path, arg) => {
      if (path === '/me/following') {
        return {
          artists: { items: [{ id: 'a1', name: 'A1', uri: 'spotify:artist:a1', genres: ['rock'] }], total: 1, cursors: null },
        };
      }
      if (path === '/me/library/contains') {
        // One flag per URI: the reply is positional, and the tool now refuses
        // a short one rather than inventing `false` for the missing rows.
        const uris = arg !== null && typeof arg === 'object' && 'uris' in arg ? String(arg.uris).split(',') : [];
        return uris.map(() => true);
      }
      return [];
    });

    const id = 'a'.repeat(22);
    // Every tool in the module, with arguments valid for its schema.
    const invocations: Array<[string, Record<string, unknown>]> = [
      ['get_followed_artists', {}],
      ['get_followed_artists', { fetch_all: true }],
      ['check_following_artists', { ids: [id] }],
      ['follow_artists', { ids: [id] }],
      ['follow_artists', { ids: [id], dry_run: true }],
      ['unfollow_artists', { ids: [id] }],
      ['unfollow_artists', { ids: [id], dry_run: true }],
      ['following_analytics', { group_by: 'genre' }],
    ];

    for (const [name, args] of invocations) {
      // The two write tools now refuse by design; every other call must succeed.
      const refuses = name === 'follow_artists' || name === 'unfollow_artists';
      if (refuses) {
        await assert.rejects(() => h.invoke(name, args), /cannot run/);
      } else {
        await h.invoke(name, args);
      }
    }

    // The read path still works, so this is not vacuously empty.
    assert.ok(h.calls.length > 0, 'the guard must actually exercise the tools');
    for (const call of h.calls) {
      for (const removed of REMOVED_ENDPOINTS) {
        assert.ok(
          !removed.match(call),
          `${removed.label} was called (${call.method} ${call.path}) — it was removed in Feb 2026`,
        );
      }
    }
  });

  it('issues no removed endpoint from any client call site in its own source', async () => {
    // Structural invariant, in the repo's established grep-guard style
    // (see tests/mutations.conformance.test.ts:112-116), but extracting the
    // actual call sites rather than scanning for bare substrings. Scanning for
    // substrings cannot work here: this module deliberately NAMES the removed
    // endpoints in its tool descriptions and error messages, and a pattern
    // that also has to see past `client.get<T>(...)` generic arguments would
    // either match that prose or silently never match anything.
    const source = await readFile(new URL('../src/tools/following.ts', import.meta.url), 'utf8');
    // The path literal is the first argument of a real client call. Optional
    // `<...>` covers the explicit type arguments these calls pass.
    const callSite = /client\.(get|put|post|delete|putRaw)(?:<[^>]*>)?\(\s*(['"`])((?:[^\\]|\\.)*?)\2/g;
    const paths = [...source.matchAll(callSite)].map((m) => m[3] as string);

    // The module's call sites are exactly the two surviving reads: the
    // followed-artist walk and the migrated library check. Asserting the exact
    // set (not a floor) is what keeps this guard from being satisfied by a
    // weakened extractor or a silently dropped call.
    assert.deepEqual(
      [...new Set(paths)].sort(),
      ['/me/following', '/me/library/contains'],
      `the module must call only these two endpoints, found ${[...new Set(paths)].sort().join(', ')}`,
    );

    for (const path of paths) {
      assert.ok(
        !/^\/me\/following(\?|\/contains)/.test(path),
        `removed follow endpoint issued: ${path}`,
      );
      assert.ok(
        path !== '/artists' && !path.startsWith('/artists?'),
        `removed batch /artists endpoint issued: ${path}`,
      );
    }

    // The still-supported list endpoint must remain reachable.
    assert.ok(
      paths.includes('/me/following'),
      'GET /me/following is still available and must stay',
    );
    // …and so must the migrated read that replaced the removed contains call.
    assert.ok(
      paths.includes('/me/library/contains'),
      'check_following_artists must read follow state via GET /me/library/contains',
    );
    // The per-id /artists/{id} fan-out is gone: the walk carries `genres`, so
    // enrichment bought nothing and cost one request per followed artist.
    assert.ok(
      !paths.some((p) => p.startsWith('/artists/')),
      'following_analytics must not re-introduce a per-artist GET /artists/{id} fan-out',
    );
  });
});
