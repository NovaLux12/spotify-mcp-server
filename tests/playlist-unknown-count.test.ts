/**
 * Tests for #1556 — a playlist track count Spotify did not state must render
 * as unknown, never as 0, in `get_user_playlists` (playlists.ts),
 * `get_user_playlists_by_id` (users.ts) and the `search` PLAYLISTS section.
 *
 * The `?? 0` these three renderers used was a claim ("this playlist is empty")
 * dressed as a default. Zero is a real, stated value; the absent page is not.
 * Same class as #803 and #589: an unreadable value is reported unreadable.
 *
 * Stub MCP server + stub SpotifyClient — no network, no token file access.
 *
 * Run: node --import tsx --test tests/playlist-unknown-count.test.ts
 */

import { test } from 'node:test';
import { z } from 'zod';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { SpotifyClient } from '../src/client.js';
import { registerPlaylistTools } from '../src/tools/playlists.js';
import { registerUsersTools } from '../src/tools/users.js';
import { registerSearchTools } from '../src/tools/search.js';

// ---------------------------------------------------------------------------
// Stub plumbing (mirrors tests/tools.playlists-following.test.ts)
// ---------------------------------------------------------------------------

type ToolContent = {
  content: Array<{ type: string; text: string }>;
  structuredContent?: Record<string, unknown>;
};

interface RegisteredTool {
  name: string;
  validate: (args: Record<string, unknown>) => Record<string, unknown>;
  handler: (args: Record<string, unknown>) => Promise<ToolContent>;
}

type Responder = (path: string, arg: unknown) => unknown;
type Registrar = (server: McpServer, client: SpotifyClient) => void;

function makeStubClient(responder: Responder) {
  const client = {
    async get<T>(path: string, params?: Record<string, string>): Promise<T | null> {
      return responder(path, params) as T | null;
    },
    async post<T>(): Promise<T | null> {
      return null;
    },
    async put<T>(): Promise<T | null> {
      return null;
    },
    async putRaw(): Promise<void> {},
    async delete<T>(): Promise<T | null> {
      return null;
    },
    async getAllPages<T>(): Promise<T[]> {
      return [];
    },
    async getAllPagesWithTruncation<T>(): Promise<{ items: T[]; truncated: boolean }> {
      return { items: [], truncated: false };
    },
  };
  return client as unknown as SpotifyClient;
}

function harness(register: Registrar, responder: Responder) {
  const registered: RegisteredTool[] = [];
  const fakeServer = {
    tool(
      name: string,
      _description: string,
      schema: z.ZodRawShape,
      handler: RegisteredTool['handler'],
    ) {
      registered.push({
        name,
        validate: (args) => z.object(schema).parse(args) as Record<string, unknown>,
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
        validate: (args) =>
          (config.inputSchema ? config.inputSchema.parse(args) : args) as Record<string, unknown>,
        handler,
      });
    },
  } as unknown as McpServer;

  register(fakeServer, makeStubClient(responder));
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const tool = registered.find((t) => t.name === name);
    assert.ok(tool, `tool ${name} was not registered`);
    return tool.handler(tool.validate(args));
  };
  return { call, registered };
}

// ---------------------------------------------------------------------------
// Fixtures — three shapes of "count", only one of which Spotify actually said.
// ---------------------------------------------------------------------------

function playlistRow(
  id: string,
  name: string,
  count: { stated: number } | { missing: true } | { nulled: true } | { legacy: number },
): Record<string, unknown> {
  const base: Record<string, unknown> = {
    id,
    name,
    uri: `spotify:playlist:${id}`,
    description: null,
    owner: { id: 'owner-1', display_name: 'Someone' },
  };
  if ('stated' in count) base.items = { total: count.stated };
  if ('missing' in count) return base;
  if ('nulled' in count) base.items = null;
  // Pre-Feb-2026 spelling. `playlistItemTotal` reads it only as a fallback.
  base.tracks = { total: count.legacy };
  return base;
}

const ROWS = [
  playlistRow('empty', 'Empty', { stated: 0 }),
  playlistRow('counted', 'Counted', { stated: 42 }),
  playlistRow('uncounted', 'Uncounted', { missing: true }),
  playlistRow('nullpage', 'Null Page', { nulled: true }),
  playlistRow('legacy', 'Legacy Page', { legacy: 7 }),
];

const PAGE = { total: ROWS.length, limit: 20, offset: 0, next: null, items: ROWS };

/** The prose phrase for a count, as an unknown count must render. */
const UNKNOWN_COUNT = /unknown (?:track|item) count/i;

// ---------------------------------------------------------------------------

test('#1556 get_user_playlists never prints 0 for a count Spotify did not state', async (t) => {
  await t.test('concise prose says unknown, and states a real zero as 0', async () => {
    const { call } = harness(registerPlaylistTools, (path) => (path === '/me/playlists' ? PAGE : null));
    const out = await call('get_user_playlists');

    assert.match(out.content[0].text, /"Empty" by Someone \(0 tracks\)/);
    assert.match(out.content[0].text, /"Counted" by Someone \(42 tracks\)/);
    // The pre-Feb-2026 spelling is still a statement about the length.
    assert.match(out.content[0].text, /"Legacy Page" by Someone \(7 tracks\)/);

    for (const name of ['Uncounted', 'Null Page']) {
      assert.match(
        out.content[0].text,
        new RegExp(`"${name}" by Someone \\(${UNKNOWN_COUNT.source}\\)`),
        `${name} rendered a count Spotify never stated`,
      );
    }
    // Not one fabricated zero anywhere on the page.
    assert.doesNotMatch(out.content[0].text, /\(0 tracks\)[^)]*(Uncounted|Null Page)/);
    assert.doesNotMatch(out.content[0].text, /Uncounted" by Someone \(0/);
    assert.doesNotMatch(out.content[0].text, /Null Page" by Someone \(0/);
  });

  await t.test('structuredContent keeps the two cases apart', async () => {
    const { call } = harness(registerPlaylistTools, (path) => (path === '/me/playlists' ? PAGE : null));
    const out = await call('get_user_playlists');
    const rows = (out.structuredContent?.items ?? []) as Array<Record<string, unknown>>;

    // A stated zero is present and is 0.
    const empty = rows.find((r) => r.name === 'Empty');
    assert.deepEqual((empty?.items as { total: number }).total, 0);
    // An unstated count is absent, not 0 — the payload must not invent it.
    const uncounted = rows.find((r) => r.name === 'Uncounted');
    assert.equal(uncounted?.items, undefined);
    const nullPage = rows.find((r) => r.name === 'Null Page');
    assert.equal(nullPage?.items, null);
  });

  await t.test('json mode is the raw payload and never gains a 0', async () => {
    const { call } = harness(registerPlaylistTools, (path) => (path === '/me/playlists' ? PAGE : null));
    const out = await call('get_user_playlists', { response_format: 'json' });
    const payload = JSON.parse(out.content[0].text) as { items: Array<Record<string, unknown>> };
    const uncounted = payload.items.find((r) => r.name === 'Uncounted');
    assert.equal(uncounted?.items, undefined);
  });
});

test('#1556 get_user_playlists_by_id never prints 0 for a count Spotify did not state', async (t) => {
  const { call } = harness(registerUsersTools, (path) =>
    path === '/users/someone/playlists' ? PAGE : null,
  );

  await t.test('prose says unknown and keeps a stated zero at 0', async () => {
    const out = await call('get_user_playlists_by_id', { user_id: 'someone' });
    assert.match(out.content[0].text, /"Empty" by Someone \(0 tracks\)/);
    assert.match(out.content[0].text, /"Counted" by Someone \(42 tracks\)/);
    assert.match(out.content[0].text, new RegExp(`"Uncounted" by Someone \\(${UNKNOWN_COUNT.source}\\)`));
    assert.match(out.content[0].text, new RegExp(`"Null Page" by Someone \\(${UNKNOWN_COUNT.source}\\)`));
    assert.doesNotMatch(out.content[0].text, /Uncounted" by Someone \(0/);
    assert.doesNotMatch(out.content[0].text, /Null Page" by Someone \(0/);
  });

  await t.test('structuredContent keeps the two cases apart', async () => {
    const out = await call('get_user_playlists_by_id', { user_id: 'someone' });
    const rows = (out.structuredContent?.items ?? []) as Array<Record<string, unknown>>;
    assert.equal((rows.find((r) => r.name === 'Empty')?.items as { total: number }).total, 0);
    assert.equal(rows.find((r) => r.name === 'Uncounted')?.items, undefined);
    assert.equal(rows.find((r) => r.name === 'Null Page')?.items, null);
  });
});

test('#1556 search PLAYLISTS section never prints 0 for a count Spotify did not state', async (t) => {
  const searchResult = { playlists: { items: ROWS, total: ROWS.length, limit: 10, offset: 0, next: null } };
  const historyFile = join(await mkdtemp(join(tmpdir(), 'pl-count-')), 'search-history.json');
  process.env.SPOTIFY_MCP_SEARCH_HISTORY_FILE = historyFile;
  delete process.env.SPOTIFY_MCP_SEARCH_HISTORY;
  t.after(async () => {
    delete process.env.SPOTIFY_MCP_SEARCH_HISTORY_FILE;
    delete process.env.SPOTIFY_MCP_SEARCH_HISTORY;
    await rm(join(historyFile, '..'), { recursive: true, force: true });
  });

  const { call } = harness(registerSearchTools, (path) => (path === '/search' ? searchResult : null));

  await t.test('prose says unknown and keeps a stated zero at 0', async () => {
    const out = await call('search', { query: 'road trip', types: ['playlist'] });
    assert.match(out.content[0].text, /"Empty" by Someone \(0 tracks\)/);
    assert.match(out.content[0].text, /"Counted" by Someone \(42 tracks\)/);
    assert.match(out.content[0].text, new RegExp(`"Uncounted" by Someone \\(${UNKNOWN_COUNT.source}\\)`));
    assert.match(out.content[0].text, new RegExp(`"Null Page" by Someone \\(${UNKNOWN_COUNT.source}\\)`));
    assert.doesNotMatch(out.content[0].text, /Uncounted" by Someone \(0/);
    assert.doesNotMatch(out.content[0].text, /Null Page" by Someone \(0/);
  });

  await t.test('structuredContent keeps the two cases apart', async () => {
    const out = await call('search', { query: 'road trip', types: ['playlist'] });
    const sections = out.structuredContent?.sections as
      | Record<string, { items: Array<Record<string, unknown>> }>
      | undefined;
    const rows = sections?.playlists?.items ?? [];
    assert.equal((rows.find((r) => r.name === 'Empty')?.items as { total: number }).total, 0);
    assert.equal(rows.find((r) => r.name === 'Uncounted')?.items, undefined);
    assert.equal(rows.find((r) => r.name === 'Null Page')?.items, null);
  });
});
