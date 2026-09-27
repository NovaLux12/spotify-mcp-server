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
import { join } from 'node:path';
// Ahead of every src import on purpose (#1274): every store default in this
// server resolves through homedir(), so the redirect has to land before any
// module that could read one. ES module imports are hoisted and evaluated in
// source order, so the position in this block is the whole point rather than a
// style preference.
import { HERMETIC_ROOT } from './helpers/hermetic.js';
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
  return { call };
}

// ---------------------------------------------------------------------------
// Fixtures — four shapes of "count", of which only two are a number Spotify
// stated. The other two are the case the fix is about, and they are different
// from each other on the wire: no `items` key at all, and `items: null`.
// ---------------------------------------------------------------------------

const OWNER = { id: 'owner-1', display_name: 'Someone' };

function row(id: string, name: string, page: Record<string, unknown>): Record<string, unknown> {
  return {
    id,
    name,
    uri: `spotify:playlist:${id}`,
    description: null,
    owner: OWNER,
    ...page,
  };
}

const ROWS = [
  // Spotify stated a real zero. This is a claim, and it is true.
  row('empty', 'Empty', { items: { total: 0 } }),
  row('counted', 'Counted', { items: { total: 42 } }),
  // Pre-Feb-2026 spelling only; `playlistItemTotal` reads it as a fallback, so
  // this row used to render as a second false 0.
  row('legacy', 'Legacy Page', { tracks: { total: 7 } }),
  // No page at all.
  row('uncounted', 'Uncounted', {}),
  // Page key present, value null.
  row('nullpage', 'Null Page', { items: null }),
];

const PAGE = { total: ROWS.length, limit: 20, offset: 0, next: null, items: ROWS };

/** The two rows whose count Spotify never stated, and the phrase each must now carry. */
const UNSTATED = ['Uncounted', 'Null Page'];
const UNKNOWN_COUNT = 'unknown track count';
const phraseFor = (name: string) => `"${name}" by Someone \\(${UNKNOWN_COUNT}\\)`;

// ---------------------------------------------------------------------------

/**
 * The one rule, asserted against whichever tool's prose is handed in. A stated
 * zero must still read as `0 tracks` — the fix is not "never print 0", it is
 * "print 0 only when Spotify said 0" — and a row whose page never arrived must
 * read as unknown rather than as the empty playlist it was reported to be.
 */
function assertPlaylistRowProse(text: string, tool: string): void {
  const where = (msg: string) => `${tool}: ${msg}`;
  assert.match(text, /"Empty" by Someone \(0 tracks\)/, where('a stated zero stopped reading as 0'));
  assert.match(text, /"Counted" by Someone \(42 tracks\)/, where('a stated count changed shape'));
  // The pre-Feb-2026 `tracks` spelling is still a statement about the length,
  // and used to be a second false 0 because only `items` was read.
  assert.match(text, /"Legacy Page" by Someone \(7 tracks\)/, where('the legacy page is no longer read'));
  for (const name of UNSTATED) {
    assert.match(
      text,
      new RegExp(phraseFor(name)),
      where(`${name} rendered a count Spotify never stated`),
    );
  }
}

/** The same distinction in the machine payload: absent is not 0. */
function assertRowsKeepTheTwoApart(rows: Array<Record<string, unknown>>, tool: string): void {
  const where = (msg: string) => `${tool}: ${msg}`;
  const page = (name: string) => rows.find((r) => r.name === name)?.items;
  assert.deepEqual(page('Empty'), { total: 0 }, where('a stated zero is no longer 0'));
  assert.equal(page('Uncounted'), undefined, where('an absent page became something else'));
  assert.equal(page('Null Page'), null, where('a null page became something else'));
}

test('#1556 get_user_playlists never prints 0 for a count Spotify did not state', async (t) => {
  const make = () =>
    harness(registerPlaylistTools, (path) => (path === '/me/playlists' ? PAGE : null));

  await t.test('concise prose says unknown, and states a real zero as 0', async () => {
    const out = await make().call('get_user_playlists');
    assertPlaylistRowProse(out.content[0].text, 'get_user_playlists');
  });

  await t.test('structuredContent keeps the two cases apart', async () => {
    const out = await make().call('get_user_playlists');
    const rows = (out.structuredContent?.items ?? []) as Array<Record<string, unknown>>;
    assertRowsKeepTheTwoApart(rows, 'get_user_playlists');
  });

  await t.test('json mode is the raw payload and never gains a 0', async () => {
    const out = await make().call('get_user_playlists', { response_format: 'json' });
    const payload = JSON.parse(out.content[0].text) as { items: Array<Record<string, unknown>> };
    assertRowsKeepTheTwoApart(payload.items, 'get_user_playlists (json)');
  });
});

test('#1556 get_user_playlists_by_id never prints 0 for a count Spotify did not state', async (t) => {
  const { call } = harness(registerUsersTools, (path) =>
    path === '/users/someone/playlists' ? PAGE : null,
  );
  const invoke = () => call('get_user_playlists_by_id', { user_id: 'someone' });

  await t.test('prose says unknown and keeps a stated zero at 0', async () => {
    const out = await invoke();
    assertPlaylistRowProse(out.content[0].text, 'get_user_playlists_by_id');
  });

  await t.test('structuredContent keeps the two cases apart', async () => {
    const out = await invoke();
    const rows = (out.structuredContent?.items ?? []) as Array<Record<string, unknown>>;
    assertRowsKeepTheTwoApart(rows, 'get_user_playlists_by_id');
  });
});

test('#1556 search PLAYLISTS section never prints 0 for a count Spotify did not state', async (t) => {
  const searchResult = { playlists: { items: ROWS, total: ROWS.length, limit: 10, offset: 0, next: null } };
  // `search` records executed queries to a local sidecar (#766). The opt-in flag
  // is off, so nothing is written; naming a path under the hermetic home keeps
  // that true even if a future run turns it on.
  process.env.SPOTIFY_MCP_SEARCH_HISTORY_FILE = join(HERMETIC_ROOT, 'search-history.json');
  delete process.env.SPOTIFY_MCP_SEARCH_HISTORY;
  t.after(() => {
    delete process.env.SPOTIFY_MCP_SEARCH_HISTORY_FILE;
    delete process.env.SPOTIFY_MCP_SEARCH_HISTORY;
  });

  const { call } = harness(registerSearchTools, (path) => (path === '/search' ? searchResult : null));
  const invoke = () => call('search', { query: 'road trip', types: ['playlist'] });

  await t.test('prose says unknown and keeps a stated zero at 0', async () => {
    const out = await invoke();
    assertPlaylistRowProse(out.content[0].text, 'search PLAYLISTS');
  });

  await t.test('structuredContent keeps the two cases apart', async () => {
    const out = await invoke();
    const sections = out.structuredContent?.sections as
      | Record<string, { items: Array<Record<string, unknown>> }>
      | undefined;
    assertRowsKeepTheTwoApart(sections?.playlists?.items ?? [], 'search PLAYLISTS');
  });
});
