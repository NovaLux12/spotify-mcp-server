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

/**
 * Endless playlist whose page starting at `failAt` throws, as a 502 does. The
 * rows before it are served normally, so the walk has real rows behind it and
 * the failure lands mid-walk.
 */
function failingPagePlaylist(pageSize: number, failAt: number, calls: Call[]) {
  return (path: string, params?: Record<string, string>) => {
    if (path === '/me/player') return sparseState;
    if (path === '/playlists/pl1/items') {
      const offset = Number(params?.offset ?? 0);
      const limit = Number(params?.limit ?? 100);
      calls.push({ offset, limit });
      if (offset === failAt) throw new Error('502 Bad Gateway');
      return {
        items: Array.from({ length: Math.min(limit, pageSize) }, (_, i) => track(`spotify:track:x${offset + i}`)),
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
      assert.equal(out.structuredContent?.walk_stopped_at_cap, false);
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
      assert.equal(out.structuredContent?.walk_stopped_at_cap, true);
      assert.equal(out.structuredContent?.walk_complete, false);
      assert.equal(out.structuredContent?.walk_failed, false);
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
      assert.equal(out.structuredContent?.walk_stopped_at_cap, false);
      assert.equal(out.structuredContent?.walk_complete, false);
      assert.match(out.content.map((c) => c.text).join('\n'), /Track 10/);
    } finally {
      initConfig();
    }
  });
});

/**
 * The "could not be determined" sentence may only describe an enumeration the
 * tool actually performed. An `artist` context issues no request at all, an
 * album is read in one un-paged request, and a page that throws leaves rows
 * unread — none of those may claim the context was enumerated (#845).
 */
describe('get_context_inspect reports what the walk established, not an assumed enumeration (#845)', () => {
  it('does not claim enumeration when a 60-track album was only half read', async () => {
    // `/albums/{id}/tracks` is fetched once with limit=50 and never paged, so a
    // current track at #60 of 60 was never in a page the tool read.
    const albumCalls: Array<Record<string, string> | undefined> = [];
    const albumState = { ...sparseState, context: { type: 'album', uri: 'spotify:album:al1' } };
    initConfig({ SPOTIFY_MCP_FETCH_ALL_CAP: '500' });
    try {
      const h = makeHarness((path, params) => {
        if (path === '/me/player') return albumState;
        if (path === '/albums/al1/tracks') {
          albumCalls.push(params);
          return {
            total_tracks: 60,
            tracks: { items: Array.from({ length: 50 }, (_, i) => ({ uri: `spotify:track:a${i + 1}` })) },
          };
        }
        throw new Error(`unexpected GET ${path}`);
      });
      const out = await h.invoke('get_context_inspect', {});
      const text = out.content.map((c) => c.text).join('\n');
      assert.equal(out.structuredContent?.position_in_context, null);
      assert.equal(out.structuredContent?.context_total, 60);
      assert.equal(out.structuredContent?.walked, 50);
      assert.equal(out.structuredContent?.walk_complete, false);
      assert.equal(out.structuredContent?.walk_stopped_at_cap, false);
      // One un-paged request at the endpoint's own limit: nothing was paged in.
      assert.deepEqual(albumCalls, [{ limit: '50' }]);
      assert.match(text, /read the first 50 of 60 album tracks; the context was not enumerated/);
      assert.doesNotMatch(text, /enumerated context/);
    } finally {
      initConfig();
    }
  });

  it('does not claim enumeration for an artist context, which issues no request', async () => {
    const requested: string[] = [];
    const artistState = { ...sparseState, context: { type: 'artist', uri: 'spotify:artist:ar1' } };
    initConfig({ SPOTIFY_MCP_FETCH_ALL_CAP: '500' });
    try {
      const h = makeHarness((path) => {
        requested.push(path);
        if (path === '/me/player') return artistState;
        throw new Error(`unexpected GET ${path}`);
      });
      const out = await h.invoke('get_context_inspect', {});
      const text = out.content.map((c) => c.text).join('\n');
      assert.deepEqual(requested, ['/me/player']);
      assert.equal(out.structuredContent?.position_in_context, null);
      assert.equal(out.structuredContent?.walked, 0);
      assert.equal(out.structuredContent?.walk_complete, false);
      assert.match(text, /the artist context is not enumerable/);
      assert.doesNotMatch(text, /enumerated/);
    } finally {
      initConfig();
    }
  });

  it('reports a mid-walk page failure as unread rows, not as a negative finding', async () => {
    // Page 2 answers 502 after 100 clean rows. The position is genuinely
    // undetermined — the remaining rows may hold the track — so the tool must
    // not turn a transport failure into "the track is not in this playlist".
    const calls: Call[] = [];
    initConfig({ SPOTIFY_MCP_FETCH_ALL_CAP: '500' });
    try {
      const h = makeHarness(failingPagePlaylist(100, 100, calls));
      const out = await h.invoke('get_context_inspect', {});
      const text = out.content.map((c) => c.text).join('\n');
      assert.deepEqual(calls, [
        { offset: 0, limit: 100 },
        { offset: 100, limit: 100 },
      ]);
      assert.equal(out.structuredContent?.position_in_context, null);
      assert.equal(out.structuredContent?.walked, 100);
      assert.equal(out.structuredContent?.walk_failed, true);
      assert.equal(out.structuredContent?.walk_complete, false);
      assert.equal(out.structuredContent?.walk_stopped_at_cap, false);
      assert.match(text, /playlist page request failed after 100 rows \(cap 500\)/);
      assert.doesNotMatch(text, /enumerated context|complete; cap not reached/);
    } finally {
      initConfig();
    }
  });

  it('says the walk stopped at the cap for a playlist of exactly cap rows', async () => {
    // 10 rows, cap 10, no match: the walk did stop at the cap, but nothing is
    // known to be missing, so the flag must not read as "rows are missing".
    const calls: Call[] = [];
    initConfig({ SPOTIFY_MCP_FETCH_ALL_CAP: '10' });
    try {
      const h = makeHarness(pagedPlaylist(Array.from({ length: 10 }, (_, i) => track(`spotify:track:r${i + 1}`)), 10, calls));
      const out = await h.invoke('get_context_inspect', {});
      const text = out.content.map((c) => c.text).join('\n');
      assert.deepEqual(calls, [{ offset: 0, limit: 10 }]);
      assert.equal(out.structuredContent?.position_in_context, null);
      assert.equal(out.structuredContent?.walked, 10);
      assert.equal(out.structuredContent?.walk_stopped_at_cap, true);
      assert.equal(out.structuredContent?.walk_complete, false);
      assert.equal(out.structuredContent?.walk_failed, false);
      assert.match(text, /walked 10 of 10 playlist rows and stopped at the fetch-all cap/);
      assert.doesNotMatch(text, /enumerated context/);
    } finally {
      initConfig();
    }
  });

  it('claims a complete enumeration only when the walk reached the end of the playlist', async () => {
    // 6 rows under a cap of 500, no match: the walk paged to a short page, so
    // the context really was enumerated and really does not hold the track.
    const calls: Call[] = [];
    initConfig({ SPOTIFY_MCP_FETCH_ALL_CAP: '500' });
    try {
      const h = makeHarness(pagedPlaylist(Array.from({ length: 6 }, (_, i) => track(`spotify:track:r${i + 1}`)), 4, calls));
      const out = await h.invoke('get_context_inspect', {});
      const text = out.content.map((c) => c.text).join('\n');
      assert.deepEqual(calls.map((c) => c.offset), [0, 4, 6]);
      assert.equal(out.structuredContent?.walked, 6);
      assert.equal(out.structuredContent?.walk_complete, true);
      assert.equal(out.structuredContent?.walk_stopped_at_cap, false);
      assert.equal(out.structuredContent?.walk_failed, false);
      assert.match(text, /fetched 6 playlist rows, cap 500 — complete; cap not reached/);
      assert.match(text, /the current track is not among them/);
    } finally {
      initConfig();
    }
  });
  it('does not claim enumeration when the album response omits total_tracks', async () => {
    // `total_tracks` is typed optional and the call site nulls it when absent,
    // so an album response carrying only `tracks` is a contemplated input.
    // Nothing proves the 50 rows read were the whole album, so the sentence
    // must not call the album fully enumerated beside walk_complete: false.
    const albumState = { ...sparseState, context: { type: 'album', uri: 'spotify:album:al1' } };
    initConfig({ SPOTIFY_MCP_FETCH_ALL_CAP: '500' });
    try {
      const h = makeHarness((path) => {
        if (path === '/me/player') return albumState;
        if (path === '/albums/al1/tracks') {
          return { tracks: { items: Array.from({ length: 50 }, (_, i) => ({ uri: `spotify:track:a${i + 1}` })) } };
        }
        throw new Error(`unexpected GET ${path}`);
      });
      const out = await h.invoke('get_context_inspect', {});
      const text = out.content.map((c) => c.text).join('\n');
      assert.equal(out.structuredContent?.position_in_context, null);
      assert.equal(out.structuredContent?.context_total, null);
      assert.equal(out.structuredContent?.walked, 50);
      assert.equal(out.structuredContent?.walk_complete, false);
      assert.doesNotMatch(text, /fully enumerated/);
      assert.match(text, /the album's total track count was not reported, so the context was not enumerated/);
    } finally {
      initConfig();
    }
  });

  it('does not claim enumeration for an album context that carries no uri', async () => {
    // The album walk is entered on `ctx.type` alone but needs `ctx.uri` to
    // issue its request, so this reads zero rows. Reporting a full enumeration
    // of zero rows is the one claim no flag backs.
    const requested: string[] = [];
    const noUriState = { ...sparseState, context: { type: 'album' } };
    initConfig({ SPOTIFY_MCP_FETCH_ALL_CAP: '500' });
    try {
      const h = makeHarness((path) => {
        requested.push(path);
        if (path === '/me/player') return noUriState;
        throw new Error(`unexpected GET ${path}`);
      });
      const out = await h.invoke('get_context_inspect', {});
      const text = out.content.map((c) => c.text).join('\n');
      assert.deepEqual(requested, ['/me/player']);
      assert.equal(out.structuredContent?.position_in_context, null);
      assert.equal(out.structuredContent?.walked, 0);
      assert.equal(out.structuredContent?.walk_complete, false);
      assert.match(text, /the playback state carried no album uri, so nothing was read/);
      assert.doesNotMatch(text, /fully enumerated|enumerated context/);
    } finally {
      initConfig();
    }
  });

  it('names the cap as a bound, not as the playlist row total, on a mid-walk failure', async () => {
    // A 150-row playlist and a 5000-row one both fail at row 100 under the same
    // cap, and the tool never fetches a playlist total — so "100 of 500 rows"
    // would assert a length nothing measured.
    const calls: Call[] = [];
    initConfig({ SPOTIFY_MCP_FETCH_ALL_CAP: '500' });
    try {
      const h = makeHarness(failingPagePlaylist(100, 100, calls));
      const out = await h.invoke('get_context_inspect', {});
      const text = out.content.map((c) => c.text).join('\n');
      assert.equal(out.structuredContent?.walked, 100);
      assert.equal(out.structuredContent?.walk_failed, true);
      assert.match(text, /failed after 100 rows \(cap 500\)/);
      assert.doesNotMatch(text, /of 500 rows/);
    } finally {
      initConfig();
    }
  });
});

/**
 * The album branch counts positions on the same basis as `walked`. An
 * unavailable / local track has no playable uri but still holds a track
 * position, so its slot must be kept — the same 1:1 rule the playlist walk
 * uses after #845.
 */
describe('get_context_inspect positions albums on the raw row count (#845)', () => {
  it('counts an unplayable album row as holding a position', async () => {
    // 3 rows, the first without a uri, current track on row 2. Position must be
    // 2: dropping the empty slot shifts it to 1 and puts it on a different
    // basis than the `walked: 3` reported beside it.
    const albumState = { ...sparseState, context: { type: 'album', uri: 'spotify:album:al1' } };
    initConfig({ SPOTIFY_MCP_FETCH_ALL_CAP: '500' });
    try {
      const h = makeHarness((path) => {
        if (path === '/me/player') return albumState;
        if (path === '/albums/al1/tracks') {
          return {
            total_tracks: 3,
            tracks: { items: [{}, { uri: 'spotify:track:t' }, { uri: 'spotify:track:a3' }] },
          };
        }
        throw new Error(`unexpected GET ${path}`);
      });
      const out = await h.invoke('get_context_inspect', {});
      const text = out.content.map((c) => c.text).join('\n');
      assert.equal(out.structuredContent?.position_in_context, 2);
      assert.equal(out.structuredContent?.context_total, 3);
      assert.equal(out.structuredContent?.walked, 3);
      assert.match(text, /Track 2 of 3 in the context/);
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
