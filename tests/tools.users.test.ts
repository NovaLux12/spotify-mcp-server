/**
 * Tests for src/tools/users.ts (issues #39, #40).
 *
 * Uses a stub MCP server + stub SpotifyClient (records every call, returns
 * canned data) — no network, no token file access, no global fetch needed.
 *
 * Run: node --import tsx --test tests/tools.users.test.ts
 */

import { describe, it } from 'node:test';
import { z } from 'zod';
import assert from 'node:assert/strict';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { SpotifyClient } from '../src/client.js';
import { registerUsersTools } from '../src/tools/users.js';

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
  handler: (args: Record<string, unknown>) => Promise<{ content: Array<{ type: string; text: string }> }>;
}

function makeStubClient(responder: Responder = () => null) {
  const calls: RecordedCall[] = [];

  const client = {
    calls,
    async get<T>(path: string, params?: Record<string, string>): Promise<T | null> {
      calls.push({ method: 'GET', path, arg: params });
      return responder(path, params) as T | null;
    },
    async post<T>(path: string, body?: unknown): Promise<T | null> {
      calls.push({ method: 'POST', path, arg: body });
      return responder(path, body) as T | null;
    },
    async put(_path: string, _body?: unknown): Promise<void> {},
    async putRaw(_path: string, _body: string, _contentType?: string): Promise<void> {},
    async delete(_path: string, _body?: unknown): Promise<void> {},
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
  const client = makeStubClient(responder);
  registerUsersTools(fakeServer, client as unknown as SpotifyClient);

  return {
    registered,
    client,
    invoke: async (name: string, args: Record<string, unknown>) => {
      const tool = registered.find((t) => t.name === name);
      assert.ok(tool, `tool "${name}" should be registered`);
      // Async so schema-validation throws surface as rejections.
      return tool.handler(tool.validate(args));
    },
  };
}

const textOf = (out: { content: Array<{ text: string }> }) => out.content[0].text;

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const publicProfile = () => ({
  id: 'spotifyuser',
  display_name: 'Sample User',
  uri: 'spotify:user:spotifyuser',
  external_urls: { spotify: 'https://open.spotify.com/user/spotifyuser' },
  followers: { total: 1234 },
  images: [{ url: 'https://i.scdn.co/image/profile', height: 640, width: 640 }],
});

const playlistSimple = (id: string, name: string, trackTotal = 3) => ({
  id,
  name,
  uri: `spotify:playlist:${id}`,
  description: null,
  owner: { id: `owner-${id}`, display_name: `Owner ${id}` },
  tracks: { total: trackTotal },
});

// ---------------------------------------------------------------------------
// Module registrations
// ---------------------------------------------------------------------------

describe('users module registrations', () => {
  it('registers get_user_profile and get_user_playlists_by_id', () => {
    const { registered } = harness();
    assert.deepEqual(
      registered.map((t) => t.name).sort(),
      ['get_user_playlists_by_id', 'get_user_profile'],
    );
    for (const t of registered) {
      assert.equal(typeof t.description, 'string');
      assert.ok(t.description.length > 0, `${t.name} has a non-empty description`);
    }
  });
});

// ---------------------------------------------------------------------------
// get_user_profile
// ---------------------------------------------------------------------------

describe('get_user_profile', () => {
  it('requests GET /users/{id} with no query params', async () => {
    const { client, invoke } = harness(() => publicProfile());
    await invoke('get_user_profile', { user_id: 'spotifyuser' });

    assert.deepEqual(client.calls, [
      { method: 'GET', path: '/users/spotifyuser', arg: undefined },
    ]);
  });

  it('encodes special characters in user_id', async () => {
    const { client, invoke } = harness(() => publicProfile());
    await invoke('get_user_profile', { user_id: 'a b/c' });
    assert.equal(client.calls[0].path, '/users/a%20b%2Fc');
  });

  it('renders display name, follower count and image URL', async () => {
    const { invoke } = harness(() => publicProfile());
    const text = textOf(await invoke('get_user_profile', { user_id: 'spotifyuser' }));

    assert.match(text, /User: Sample User/);
    assert.match(text, /ID: spotifyuser/);
    assert.match(text, /URI: spotify:user:spotifyuser/);
    assert.match(text, /Followers: 1234/);
    assert.match(text, /Profile image: https:\/\/i\.scdn\.co\/image\/profile/);
    assert.match(text, /URL: https:\/\/open\.spotify\.com\/user\/spotifyuser/);
  });

  it('falls back to id when display_name is null and omits missing followers/images', async () => {
    const { invoke } = harness(() => ({
      id: 'bare',
      display_name: null,
      uri: 'spotify:user:bare',
      external_urls: { spotify: 'https://open.spotify.com/user/bare' },
      followers: null,
      images: [],
    }));
    const text = textOf(await invoke('get_user_profile', { user_id: 'bare' }));

    assert.match(text, /User: bare\nID: bare/);
    assert.doesNotMatch(text, /Followers:/);
    assert.doesNotMatch(text, /Profile image:/);
  });

  it('throws a clear error when Spotify returns no body', async () => {
    const { invoke } = harness();
    await assert.rejects(
      invoke('get_user_profile', { user_id: 'ghost' }),
      /not found/,
    );
  });

  it('rejects empty user_id via schema bounds', async () => {
    const { invoke } = harness(() => publicProfile());
    await assert.rejects(invoke('get_user_profile', { user_id: '' }));
  });
});

// ---------------------------------------------------------------------------
// get_user_playlists_by_id
// ---------------------------------------------------------------------------

describe('get_user_playlists_by_id', () => {
  it('requests GET /users/{id}/playlists with limit/offset forwarded as strings', async () => {
    const { client, invoke } = harness(() => ({
      items: [playlistSimple('p1', 'List One')],
      total: 1,
      limit: 20,
      offset: 0,
    }));
    await invoke('get_user_playlists_by_id', {
      user_id: 'otheruser',
      limit: 5,
      offset: 10,
    });

    assert.deepEqual(client.calls, [
      {
        method: 'GET',
        path: '/users/otheruser/playlists',
        arg: { limit: '5', offset: '10' },
      },
    ]);
  });

  it('applies default limit=20 and omits offset when not provided', async () => {
    const { client, invoke } = harness(() => ({ items: [], total: 0, limit: 20, offset: 0 }));
    await invoke('get_user_playlists_by_id', { user_id: 'otheruser' });

    assert.deepEqual(client.calls, [
      {
        method: 'GET',
        path: '/users/otheruser/playlists',
        arg: { limit: '20' },
      },
    ]);
  });

  it('renders playlists with owner fallback style like get_user_playlists', async () => {
    const { invoke } = harness(() => ({
      items: [playlistSimple('p1', 'List One'), playlistSimple('p2', 'List Two', 7)],
      total: 42,
      limit: 2,
      offset: 0,
    }));
    const text = textOf(
      await invoke('get_user_playlists_by_id', { user_id: 'otheruser', limit: 2 }),
    );

    const lines = text.split('\n');
    assert.match(lines[0], /Playlists owned by otheruser \(42 total, showing 2\):/);
    assert.match(
      lines[1],
      /• "List One" by Owner p1 \(3 tracks\) \| ID: p1 \| URI: spotify:playlist:p1/,
    );
    assert.match(
      lines[2],
      /• "List Two" by Owner p2 \(7 tracks\) \| ID: p2 \| URI: spotify:playlist:p2/,
    );
  });

  it('falls back to owner.id when display_name is missing', async () => {
    const pl = playlistSimple('p9', 'Anonymous Owner List');
    pl.owner.display_name = null;
    const { invoke } = harness(() => ({ items: [pl], total: 1, limit: 20, offset: 0 }));

    const text = textOf(await invoke('get_user_playlists_by_id', { user_id: 'u' }));
    assert.match(text, /by owner-p9 \(3 tracks\)/);
  });

  it('handles an empty listing gracefully', async () => {
    const { invoke } = harness(() => ({ items: [], total: 0, limit: 20, offset: 0 }));
    const text = textOf(await invoke('get_user_playlists_by_id', { user_id: 'quiet' }));

    assert.match(text, /\(0 total, showing 0\)/);
    assert.equal(text.split('\n').length, 1);
  });

  it('throws a clear error when Spotify returns no body', async () => {
    const { invoke } = harness();
    await assert.rejects(
      invoke('get_user_playlists_by_id', { user_id: 'ghost' }),
      /Could not retrieve playlists/,
    );
  });

  const badInputs: Array<[string, Record<string, unknown>]> = [
    ['limit below minimum', { user_id: 'u', limit: 0 }],
    ['limit above maximum', { user_id: 'u', limit: 51 }],
    ['negative offset', { user_id: 'u', offset: -1 }],
    ['non-integer limit', { user_id: 'u', limit: 2.5 }],
    ['empty user_id', { user_id: '' }],
  ];
  for (const [label, badArgs] of badInputs) {
    it(`schema rejects ${label}`, async () => {
      const { invoke, client } = harness(() => ({
        items: [playlistSimple('p1', 'L')],
        total: 1,
        limit: 20,
        offset: 0,
      }));
      await assert.rejects(invoke('get_user_playlists_by_id', badArgs));
      assert.equal(client.calls.length, 0, 'no request should be made on invalid input');
    });
  }
});
