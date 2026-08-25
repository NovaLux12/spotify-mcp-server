/**
 * Tests for the follow_artists / unfollow_artists additions to
 * src/tools/following.ts (issues #34 and #35).
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

interface RegisteredTool {
  name: string;
  description: string;
  /** Validates raw args exactly like the MCP SDK would before invoking the handler. */
  validate: (args: Record<string, unknown>) => Record<string, unknown>;
  handler: (args: Record<string, unknown>) => Promise<{ content: Array<{ type: string; text: string }> }>;
}

function makeHarness() {
  const calls: RecordedCall[] = [];
  const client = {
    calls,
    async get<T>(path: string, params?: Record<string, string>): Promise<T | null> {
      calls.push({ method: 'GET', path, arg: params });
      return null;
    },
    async post<T>(path: string, body?: unknown): Promise<T | null> {
      calls.push({ method: 'POST', path, arg: body });
      return null;
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
