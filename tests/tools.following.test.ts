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
    assert.match(text, /✓ a/);
    assert.match(text, /✗ b/);
    assert.ok(!text.includes('\n  ✓ c'));
    assert.match(text, /\(1 more — pass offset or fetch_all\)/);

    const sc = out.structuredContent as { items: Array<{ id: string; follows: boolean }> };
    assert.deepEqual(sc.items, [
      { id: 'a', follows: true },
      { id: 'b', follows: false },
    ]);
  });

  it('json mode parses to items + pagination (#51)', async () => {
    const h = makeHarness(() => [false]);
    const out = await h.invoke('check_following_artists', {
      ids: ['x'],
      response_format: 'json',
    });
    const payload = JSON.parse(out.content[0].text);
    assert.deepEqual(payload.items, [{ id: 'x', follows: false }]);
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
    assert.match(text, /^\[dry run\] unfollow_artists on followed artists — nothing was changed\./);
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
