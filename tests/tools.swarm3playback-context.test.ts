/**
 * get_context_inspect (#838): playlist item rows expose the playable under
 * `item` since the Feb 2026 rename. The deprecated `track` alias must still
 * work so either projection resolves the current track's position.
 *
 * #845: the page walk advances by the RAW page length. Rows without a
 * playable uri (unavailable / local) still occupy a playlist position, so
 * dropping them made the walk re-read rows it had already seen — reporting a
 * shifted "Track N of M" or giving up. The walk is also bounded by
 * fetchAllCap, and that bound is now disclosed rather than implied.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { SpotifyClient } from '../src/client.js';
import { registerSwarm3PlaybackTools } from '../src/tools/swarm3_playback.js';
import { initConfig } from '../src/config.js';

type ToolResult = {
  content: Array<{ type: string; text: string }>;
  structuredContent?: Record<string, unknown>;
};
type Registered = {
  name: string;
  handler: (args: Record<string, unknown>) => Promise<ToolResult>;
};

function makeHarness(responder: (path: string, params?: Record<string, string>) => unknown) {
  const registered: Registered[] = [];
  const server = {
    tool(name: string, _desc: string, _schema: z.ZodRawShape, handler: Registered['handler']) {
      registered.push({ name, handler });
    },
    registerTool(name: string, config: { description?: string; inputSchema?: z.ZodType }, handler: Registered['handler']) {
      registered.push({ name, handler });
    },
  } as unknown as McpServer;
  const client = {
    async get<T>(path: string, params?: Record<string, string>): Promise<T | null> {
      return responder(path, params) as T | null;
    },
    async post<T>(): Promise<T | null> { return null; },
    async put<T>(): Promise<T | null> { return null; },
    async delete<T>(): Promise<T | null> { return null; },
    async getAllPages<T>(): Promise<T[]> { return []; },
  } as unknown as SpotifyClient;
  registerSwarm3PlaybackTools(server, client);
  return {
    async invoke(name: string, args: Record<string, unknown>): Promise<ToolResult> {
      const t = registered.find((r) => r.name === name);
      assert.ok(t, `tool ${name} not registered`);
      return t!.handler(args);
    },
  };
}

const state = {
  is_playing: true,
  progress_ms: 1000,
  timestamp: Date.parse('2026-09-01T10:00:00Z'),
  shuffle_state: false,
  repeat_state: 'off',
  device: { id: 'd1', name: 'Speaker', volume_percent: 50 },
  item: { uri: 'spotify:track:b', name: 'B', type: 'track', duration_ms: 200000, artists: [{ name: 'A' }] },
  context: { type: 'playlist', uri: 'spotify:playlist:pl1' },
};

/** Current track that does NOT sit on page 1 of the null-row fixture below. */
const sparseState = {
  ...state,
  item: { ...state.item, uri: 'spotify:track:t', name: 'T' },
};

type Row = { item: { uri: string } | null };
const track = (uri: string): Row => ({ item: { uri } });
/** An unavailable / local row: no playable uri, but it still holds a slot. */
const nullRow: Row = { item: null };
type Call = { offset: number; limit: number };

/**
 * Serves `rows` as offset-paged pages of at most `pageSize` raw rows, honouring
 * the requested `limit` — the shape of the real endpoint, so the offsets the
 * walk sends are meaningful cursors into the raw row list.
 */
function pagedPlaylist(rows: Row[], pageSize: number, calls: Call[]) {
  return (path: string, params?: Record<string, string>) => {
    if (path === '/me/player') return sparseState;
    if (path === '/playlists/pl1/items') {
      const offset = Number(params?.offset ?? 0);
      const limit = Number(params?.limit ?? 100);
      calls.push({ offset, limit });
      const end = Math.min(rows.length, offset + limit, offset + pageSize);
      return { items: rows.slice(offset, end) };
    }
    throw new Error(`unexpected GET ${path}`);
  };
}

/**
 * A playlist long enough to exhaust any cap: pages of at most `pageSize` raw
 * rows. `targetRow` is the 1-based raw row carrying the current track, or -1
 * for a playlist the current track is not in.
 */
function endlessPlaylist(pageSize: number, targetRow: number, calls: Call[]) {
  return (path: string, params?: Record<string, string>) => {
    if (path === '/me/player') return sparseState;
    if (path === '/playlists/pl1/items') {
      const offset = Number(params?.offset ?? 0);
      const limit = Number(params?.limit ?? 100);
      calls.push({ offset, limit });
      return {
        items: Array.from({ length: Math.min(limit, pageSize) }, (_, i) =>
          track(offset + i + 1 === targetRow ? 'spotify:track:t' : `spotify:track:x${offset + i}`),
        ),
      };
    }
    throw new Error(`unexpected GET ${path}`);
  };
}

describe('get_context_inspect walks by raw page length (#845)', () => {
  it('reports the true row position for a track on page 2 when page 1 has null rows', async () => {
    // Rows 1-4 = page 1 (rows 2 and 4 unavailable), rows 5-6 = page 2, with the
    // current track on row 6. Position must be 6: a cursor advancing by the
    // FILTERED page-1 count (2) re-reads from row 3 and reports 5.
    const rows = [track('spotify:track:r1'), nullRow, track('spotify:track:r3'), nullRow, track('spotify:track:r5'), track('spotify:track:t')];
    const calls: Call[] = [];
    initConfig({ SPOTIFY_MCP_FETCH_ALL_CAP: '500' });
    try {
      const h = makeHarness(pagedPlaylist(rows, 4, calls));
      const out = await h.invoke('get_context_inspect', {});
      assert.equal(out.structuredContent?.position_in_context, 6);
      assert.match(out.content.map((c) => c.text).join('\n'), /Track 6/);
      // The walk pages on the API's own row cursor: 0, then 4 (page 1's RAW
      // length), never the filtered count of 2.
      assert.deepEqual(calls.map((c) => c.offset), [0, 4]);
      assert.equal(out.structuredContent?.walked, 6);
      assert.equal(out.structuredContent?.truncated, false);
      assert.equal(out.structuredContent?.cap, 500);
    } finally {
      initConfig();
    }
  });

  it('walks on past a page whose rows all filter away', async () => {
    // Page 1 is three unavailable rows: no playable uri at all. A filtered
    // cursor sees an empty page, reports "could not be determined" and never
    // looks at row 4, where the current track actually is.
    const calls: Call[] = [];
    initConfig({ SPOTIFY_MCP_FETCH_ALL_CAP: '500' });
    try {
      const h = makeHarness(pagedPlaylist([nullRow, nullRow, nullRow, track('spotify:track:t')], 3, calls));
      const out = await h.invoke('get_context_inspect', {});
      assert.deepEqual(calls.map((c) => c.offset), [0, 3]);
      assert.equal(out.structuredContent?.position_in_context, 4);
      assert.equal(out.structuredContent?.context_enumerated, true);
    } finally {
      initConfig();
    }
  });

  it('discloses the cap when the walk stops on it without a match', async () => {
    // Endless playlist, cap 10, current track not in it: the walk must read no
    // more than `cap` rows and say that it was truncated rather than implying
    // the whole context was enumerated.
    const calls: Call[] = [];
    initConfig({ SPOTIFY_MCP_FETCH_ALL_CAP: '10' });
    try {
      const h = makeHarness(endlessPlaylist(4, -1, calls));
      const out = await h.invoke('get_context_inspect', {});
      assert.equal(out.structuredContent?.position_in_context, null);
      assert.equal(out.structuredContent?.context_enumerated, false);
      assert.equal(out.structuredContent?.walked, 10);
      assert.equal(out.structuredContent?.cap, 10);
      assert.equal(out.structuredContent?.truncated, true);
      // Each page asks only for the rows the cap still allows: 10, then 6, 2.
      assert.deepEqual(calls, [
        { offset: 0, limit: 10 },
        { offset: 4, limit: 6 },
        { offset: 8, limit: 2 },
      ]);
      assert.match(out.content.map((c) => c.text).join('\n'), /walked 10 of 10/);
    } finally {
      initConfig();
    }
  });

  it('is not truncated when the track is found on the cap row itself', async () => {
    // Same 4-row pages and cap 10, current track on playlist row 10.
    const calls: Call[] = [];
    initConfig({ SPOTIFY_MCP_FETCH_ALL_CAP: '10' });
    try {
      const h = makeHarness(endlessPlaylist(4, 10, calls));
      const out = await h.invoke('get_context_inspect', {});
      assert.equal(out.structuredContent?.position_in_context, 10);
      assert.equal(out.structuredContent?.walked, 10);
      assert.equal(out.structuredContent?.truncated, false);
      assert.match(out.content.map((c) => c.text).join('\n'), /Track 10/);
    } finally {
      initConfig();
    }
  });
});

describe('get_context_inspect reads item (not deprecated track) on playlist rows', () => {
  it('finds the current track in a row shaped { item: { uri } }', async () => {
    const h = makeHarness((path) => {
      if (path === '/me/player') return state;
      if (path === '/playlists/pl1/items') {
        return { items: [{ item: { uri: 'spotify:track:a' } }, { item: { uri: 'spotify:track:b' } }] };
      }
      throw new Error(`unexpected GET ${path}`);
    });
    const out = await h.invoke('get_context_inspect', {});
    assert.equal(out.structuredContent?.position_in_context, 2);
    assert.match(out.content.map((c) => c.text).join('\n'), /Track 2/);
  });

  it('still resolves rows shaped with the deprecated track alias', async () => {
    const h = makeHarness((path) => {
      if (path === '/me/player') return state;
      if (path === '/playlists/pl1/items') {
        return { items: [{ track: { uri: 'spotify:track:a' } }, { track: { uri: 'spotify:track:b' } }] };
      }
      throw new Error(`unexpected GET ${path}`);
    });
    const out = await h.invoke('get_context_inspect', {});
    assert.equal(out.structuredContent?.position_in_context, 2);
  });

  it('walks later pages using item on every page', async () => {
    const h = makeHarness((path, params) => {
      if (path === '/me/player') return state;
      if (path === '/playlists/pl1/items') {
        return params?.offset
          ? { items: [{ item: { uri: 'spotify:track:c' } }, { item: { uri: 'spotify:track:b' } }] }
          : { items: [{ item: { uri: 'spotify:track:a' } }] };
      }
      throw new Error(`unexpected GET ${path}`);
    });
    const out = await h.invoke('get_context_inspect', {});
    assert.equal(out.structuredContent?.position_in_context, 3);
  });
});
