import { DEFAULT_TOKEN_FILE } from './helpers/hermetic.js';

import { after, before, describe, it, mock } from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { registerExhaustMiscTools } from '../src/tools/exhaustmisc.js';
import { __resetSearchHistoryEpisode } from '../src/tools/searchhistory.js';
import { initConfig } from '../src/config.js';

/**
 * The `mock.fn` handle `node:test` attaches to a stubbed client method.
 *
 * Asserting the client's return type to a bare `SpotifyClient` erases those
 * handles, which is why each call site had to cast the method back to a
 * `{ mock: ... }` object - a cast the compiler rejects, because a method is not
 * that object. `mockedMethod` reads the handle off the value instead, and fails
 * by name if the stub is not a mock.
 */
type MockCall = { callCount(): number; calls: Array<{ arguments: unknown[] }> };

/** A `mock.fn`, as the call sites hold it: callable, with its handle on `.mock`. */
type MockedMethod = { mock: MockCall };

function mockedMethod(fn: unknown): MockedMethod {
  // A `mock.fn` IS a function with a `mock` property hung on it, so the guard
  // has to admit functions as well as objects before the handle can be read.
  assert.ok(
    typeof fn === 'function' || (typeof fn === 'object' && fn !== null),
    'a stubbed client method must be callable',
  );
  const handle = (fn as { mock?: unknown }).mock;
  assert.ok(
    typeof handle === 'object' && handle !== null,
    'the stubbed client method must be a mock.fn - without a handle, callCount() reads 0 for a call that happened',
  );
  return { mock: handle as MockCall };
}

function makeClient(overrides: Record<string, unknown> = {}) {
  const client = {
    // The real SpotifyClient always sets this at construction; a stub that
    // omits it is not a client the stores can key by (#1385).
    tokenFile: DEFAULT_TOKEN_FILE,
    get: mock.fn(async () => null),
    getAllPages: mock.fn(async () => []),
    // #731: search_within_playlist walks through the truncation-carrying
    // variant (so a capped scan is reported rather than reading as a narrow
    // result). The bare-array stub above still serves the other nine tools.
    getAllPagesWithTruncation: mock.fn(async () => ({
      items: [] as unknown[],
      truncated: false,
      truncatedByCap: false,
      reportedTotal: null as number | null,
    })),
    put: mock.fn(async () => null),
    post: mock.fn(async () => null),
    delete: mock.fn(async () => null),
    ...overrides,
  };
  return client as unknown as import('../src/client.js').SpotifyClient;
}

/**
 * A stub server whose INNER host advertises elicitation and accepts (#684).
 *
 * #1550 put `unsave_orphan_tracks` and `remove_from_library_by_playlist`
 * behind the shared confirmation gate, so a commit test that omits this is
 * testing the refusal path, not the chunking it was written for. Shape is the
 * one `elicitHost` actually resolves: the methods live on `server.server`,
 * not on the McpServer wrapper.
 */
function autoConfirmingServer(capture?: { handler?: unknown; name: string }): McpServer {
  return {
    tool(name: string, _desc: string, _shape: unknown, handler: (args: unknown) => Promise<unknown>) {
      if (capture && capture.name === name) capture.handler = handler;
    },
    server: {
      getClientCapabilities: () => ({ elicitation: {} }),
      elicitInput: mock.fn(async () => ({ action: 'accept', content: { confirm: true } })),
    },
  } as unknown as McpServer;
}

/** Capture one registered tool's handler by name, in the shape the tests use. */
type Handler = (args: unknown) => Promise<{ content: Array<{ text: string }>; structuredContent?: Record<string, unknown> }>;

function serverCapturing(name: string): { server: McpServer; handler: () => Handler } {
  let captured: unknown = null;
  const server = {
    tool(toolName: string, _desc: string, _shape: unknown, h: (args: unknown) => Promise<unknown>) {
      if (toolName === name) captured = h;
    },
  } as unknown as McpServer;
  return { server, handler: () => captured as Handler };
}

function registeredTools(client: ReturnType<typeof makeClient>): string[] {
  const names: string[] = [];
  const server = {
    tool(name: string) { names.push(name); },
  } as unknown as McpServer;
  registerExhaustMiscTools(server, client);
  return names;
}

/** Request path from a recorded client call, narrowed rather than assumed. */
function recordedPath(arg: unknown): string {
  // `assert.ok(typeof arg === 'string', …)`, not `assert.equal`: only the
  // `assert.ok` form is an assertion FUNCTION, so only it narrows — the
  // `assert.equal` spelling left `arg` as `unknown` and needed a cast after.
  assert.ok(typeof arg === 'string', `recorded request path must be a string, got ${JSON.stringify(arg)}`);
  return arg;
}

/** The `uris` array of a recorded request body, narrowed rather than assumed. */
function recordedUris(body: unknown): string[] {
  assert.ok(body !== null && typeof body === 'object' && 'uris' in body, `recorded body must carry uris: ${JSON.stringify(body)}`);
  const { uris } = body;
  assert.ok(Array.isArray(uris), `uris must be an array: ${JSON.stringify(body)}`);
  // A non-string entry is dropped rather than coerced, which makes any batch
  // mismatch fail on the caller's deepEqual instead of passing silently.
  return uris.filter((u): u is string => typeof u === 'string');
}

describe('exhaustmisc — mop-up 10 tools', () => {
  it('registers 10 tools', () => {
    const names = registeredTools(makeClient());
    assert.equal(names.length, 10);
    assert.ok(names.includes('search_within_playlist'));
    assert.ok(names.includes('search_history_stats'));
    assert.ok(names.includes('audiobook_progress'));
    assert.ok(names.includes('unsave_orphan_tracks'));
    assert.ok(names.includes('playlist_to_library'));
    assert.ok(names.includes('followed_playlists_audit'));
    assert.ok(names.includes('get_playlist_added_dates'));
    assert.ok(names.includes('split_playlist'));
    assert.ok(names.includes('find_duplicate_tracks_across_playlists'));
    assert.ok(names.includes('remove_from_library_by_playlist'));
  });

  // #1202: `row.item` was read through
  // `row.item as unknown as Record<string, unknown> | null`. A row whose `item`
  // is a bare URI string is a real thing the wire can carry, and the cast
  // declared it to be a record — from which `item.name` and `item.artists` read
  // as `undefined` with nothing objecting. `asRecord` refuses it, so the row
  // takes the path the payload supports.
  it('search_within_playlist refuses a row whose item is a bare string, and counts it', async () => {
    const { server, handler } = serverCapturing('search_within_playlist');
    const rows = [
      { added_at: '2024-01-01', item: 'spotify:track:legacy1' },
      { added_at: '2024-01-02', item: { uri: 'spotify:track:2', name: 'Hello', artists: [{ name: 'Adele' }], album: { name: '25' } } },
    ];
    registerExhaustMiscTools(server, makeClient({
      getAllPagesWithTruncation: mock.fn(async () => ({
        items: rows, truncated: false, truncatedByCap: false, reportedTotal: rows.length,
      })),
    }));
    const res = await handler()({ playlist_id: 'pl1', query: 'hello', response_format: 'concise', kind: 'any', max_results: 50 });
    const payload = res.structuredContent as { matched: number; scanned_items: number; items_of_unknown_kind?: number };
    assert.equal(payload.scanned_items, 2, 'the string row was scanned');
    assert.equal(payload.matched, 1, 'a bare string is not a searchable track object');
    assert.equal(payload.items_of_unknown_kind, 1, 'and it is counted, not silently dropped');
  });

  // The old read was `(item as { artists?: Array<{ name: string }> }).artists`
  // then `a.name.toLowerCase()` — a TypeError the moment an artist carried no
  // name, so a malformed row crashed the whole search rather than matching
  // less. The query here deliberately misses the item NAME, so the artist read
  // is actually reached.
  it('search_within_playlist survives an artist entry with no name', async () => {
    const { server, handler } = serverCapturing('search_within_playlist');
    const rows = [
      { added_at: '2024-01-01', item: { uri: 'spotify:track:1', name: 'Nameless Artist', artists: [{ id: 'ar-1' }], album: { name: '25' } } },
      { added_at: '2024-01-02', item: { uri: 'spotify:track:2', name: 'Also Nothing', artists: [{ name: 'Adele' }], album: { name: '25' } } },
    ];
    registerExhaustMiscTools(server, makeClient({
      getAllPagesWithTruncation: mock.fn(async () => ({
        items: rows, truncated: false, truncatedByCap: false, reportedTotal: rows.length,
      })),
    }));
    const res = await handler()({ playlist_id: 'pl1', query: 'adele', response_format: 'concise', kind: 'any', max_results: 50 });
    assert.equal((res.structuredContent as { matched: number }).matched, 1, 'the nameless-artist row matches nothing and does not throw');
  });

  it('search_within_playlist filters by query', async () => {
    const { server, handler } = serverCapturing('search_within_playlist');
    const client = makeClient({
      getAllPagesWithTruncation: mock.fn(async () => ({
        items: [
          { item: { uri: 'spotify:track:1', name: 'Hello World', artists: [{ name: 'Adele' }], album: { name: '25' } }, added_at: '2024-01-01' },
          { item: { uri: 'spotify:track:2', name: 'Goodbye', artists: [{ name: 'Beatles' }], album: { name: 'Abbey' } }, added_at: '2024-01-02' },
        ],
        truncated: false,
        truncatedByCap: false,
        reportedTotal: 2,
      })),
    });
    registerExhaustMiscTools(server, client);
    const res = await handler()({ playlist_id: 'pl1', query: 'hello', response_format: 'concise', max_results: 50 });
    assert.ok(res.content[0].text.includes('1 match'));
    assert.equal((res.structuredContent as { matched: number }).matched, 1);
  });

  // #731: a playlist holding both row shapes. `kind` has to split these, and
  // the row that declares neither shape has to be counted rather than filed
  // under one of them.
  const MIXED_PLAYLIST = [
    { added_at: '2024-01-01', item: { type: 'track', uri: 'spotify:track:t1', name: 'Hello Darling', artists: [{ name: 'Adele' }], album: { name: '25' } } },
    { added_at: '2024-01-02', item: { type: 'episode', uri: 'spotify:episode:e1', name: 'Hello, from the show', show: { name: 'Hello Radio' } } },
    { added_at: '2024-01-03', item: { type: 'track', uri: 'spotify:track:t2', name: 'Goodbye', artists: [{ name: 'Beatles' }], album: { name: 'Abbey' } } },
    { added_at: '2024-01-04', item: { type: 'episode', uri: 'spotify:episode:e2', name: 'Unrelated chatter', show: { name: 'Quiet Hours' } } },
  ];

  it('search_within_playlist kind splits a mixed playlist by row shape', async () => {
    const { server, handler } = serverCapturing('search_within_playlist');
    const walk = mock.fn(async () => ({
      items: MIXED_PLAYLIST,
      truncated: false,
      truncatedByCap: false,
      reportedTotal: MIXED_PLAYLIST.length,
    }));
    registerExhaustMiscTools(server, makeClient({ getAllPagesWithTruncation: walk }));

    // Expected sets are the client-side filter over the SAME window, spelled
    // out rather than recomputed from the handler's own filter.
    const expected: Record<string, string[]> = {
      any: ['spotify:track:t1', 'spotify:episode:e1'],
      track: ['spotify:track:t1'],
      episode: ['spotify:episode:e1'],
    };
    for (const [kind, uris] of Object.entries(expected)) {
      const res = await handler()({
        playlist_id: 'pl1',
        query: 'hello',
        kind,
        response_format: 'json',
        max_results: 50,
      });
      const payload = res.structuredContent as { kind: string; matched: number; items: Array<{ item: { uri: string } }> };
      assert.equal(payload.kind, kind, `kind must echo the requested filter for ${kind}`);
      assert.equal(payload.matched, uris.length, `matched count for kind=${kind}`);
      assert.deepEqual(payload.items.map((row) => row.item.uri), uris, `returned URIs for kind=${kind}`);
    }
    // The walk is read once per call and covers the whole playlist; the kind
    // filter is client-side over that window, not a narrower request.
    assert.equal(walk.mock.callCount(), 3);
  });

  it('search_within_playlist defaults to any and excludes rows of unknown kind', async () => {
    const { server, handler } = serverCapturing('search_within_playlist');
    const rows = [...MIXED_PLAYLIST, { added_at: '2024-01-05', item: { uri: 'spotify:local:x9', name: 'Hello ???' } }];
    registerExhaustMiscTools(server, makeClient({
      getAllPagesWithTruncation: mock.fn(async () => ({
        items: rows,
        truncated: false,
        truncatedByCap: false,
        reportedTotal: rows.length,
      })),
    }));

    // Omitting `kind` is the pre-#731 behaviour: every row the text matches,
    // including the one that identifies as neither shape.
    const unfiltered = await handler()({ playlist_id: 'pl1', query: 'hello', response_format: 'json', max_results: 50 });
    const anyPayload = unfiltered.structuredContent as { kind: string; items: Array<{ item: { uri: string } }>; items_of_unknown_kind?: number };
    assert.equal(anyPayload.kind, 'any', 'the default is any');
    assert.deepEqual(anyPayload.items.map((row) => row.item.uri), [
      'spotify:track:t1', 'spotify:episode:e1', 'spotify:local:x9',
    ]);

    // Asking for a kind must not quietly file that row under it. It is
    // excluded and counted, so the caller can see the result is incomplete.
    const tracks = await handler()({ playlist_id: 'pl1', query: 'hello', kind: 'track', response_format: 'concise', max_results: 50 });
    const trackPayload = tracks.structuredContent as { items: Array<{ item: { uri: string } }>; items_of_unknown_kind?: number };
    assert.deepEqual(trackPayload.items.map((row) => row.item.uri), ['spotify:track:t1']);
    assert.equal(trackPayload.items_of_unknown_kind, 1);
    assert.ok(
      tracks.content[0].text.includes('1 item(s) matched neither shape'),
      `excluded rows must be disclosed in prose: ${tracks.content[0].text}`,
    );
  });

  it('search_within_playlist reports the scanned window and a capped walk', async () => {
    initConfig({ SPOTIFY_MCP_FETCH_ALL_CAP: '2' });
    const { server, handler } = serverCapturing('search_within_playlist');
    const walk = mock.fn(async () => ({
      items: MIXED_PLAYLIST.slice(0, 2),
      truncated: true,
      truncatedByCap: true,
      reportedTotal: 4,
    }));
    registerExhaustMiscTools(server, makeClient({ getAllPagesWithTruncation: walk }));
    const res = await handler()({ playlist_id: 'pl1', query: 'hello', response_format: 'concise', max_results: 50 });
    const payload = res.structuredContent as {
      scanned_items: number;
      matched: number;
      scan_cap: number;
      scan_truncated: boolean;
      items: Array<{ item: { uri: string } }>;
    };
    // The cap is the SAME one get_playlist_items walks under, and it is
    // handed to the walk rather than applied afterwards.
    assert.deepEqual(walk.mock.calls[0].arguments, [
      '/playlists/pl1/items',
      { limit: '100' },
      { maxItems: 2 },
    ]);
    assert.equal(payload.scan_cap, 2);
    assert.equal(payload.scan_truncated, true);
    assert.equal(payload.scanned_items, 2, 'scanned_items is what the filter actually saw, not the playlist total');
    assert.equal(payload.matched, 2);
    assert.deepEqual(payload.items.map((row) => row.item.uri), ['spotify:track:t1', 'spotify:episode:e1']);
    // A capped scan that read nothing readable must not read as "2 matches, done".
    assert.ok(res.content[0].text.includes('TRUNCATED'), `capped walk must be disclosed in prose: ${res.content[0].text}`);
  });

  it('search_within_playlist accepts the shared playlist_id / id resolver', async () => {
    const { server, handler } = serverCapturing('search_within_playlist');
    // The parameters are declared because the assertion below reads them off
    // `mock.calls[0].arguments` — a double with an empty parameter list types
    // its own call record as `[]`, so reading argument 0 off it was reading
    // an element the double had promised not to have.
    const walk = mock.fn(async (path: string, params?: Record<string, string>, opts?: unknown) => {
      void path; void params; void opts;
      return { items: [], truncated: false, truncatedByCap: false, reportedTotal: 0, pages: 0 };
    });
    registerExhaustMiscTools(server, makeClient({ getAllPagesWithTruncation: walk }));

    await handler()({ id: 'pl1', query: 'hello', response_format: 'concise', max_results: 50 });
    assert.equal(walk.mock.calls[0].arguments[0], '/playlists/pl1/items');

    // Conflicting values fail before any API round-trip, as they do for
    // get_playlist_items — not after a walk against the wrong playlist.
    await assert.rejects(
      handler()({ playlist_id: 'pl1', id: 'pl2', query: 'hello', response_format: 'concise', max_results: 50 }),
      /Conflicting values/,
    );
    assert.equal(walk.mock.callCount(), 1, 'the conflicting call must not have walked the API');
  });

  // Isolate from the developer's real ~/.spotify-mcp/search-history.json.
  //
  // The sidecar path is read from process.env (src/tools/searchhistory.ts),
  // NOT from the config snapshot — `initConfig({ SPOTIFY_MCP_SEARCH_HISTORY_FILE })
  // looks like it redirects the read but is a no-op, because loadConfig models
  // only the scalar knobs and has no field for this path. That is what let this
  // block ship, and the `initConfig(...)` call that used to sit here was the
  // same no-op pointed at a fixed /tmp name. So set the variable the code
  // actually reads, at a per-run mkdtemp path (a fixed /tmp name collides
  // across concurrent runs and across worktrees), and put it back afterwards.
  //
  // Because this is a process.env redirect rather than a config field, an
  // `initConfig()` reset elsewhere in this file cannot undo it — which is the
  // property the old comment was reaching for and did not have.
  let historyDir: string;
  let historyFile: string;
  const priorHistoryFile = process.env.SPOTIFY_MCP_SEARCH_HISTORY_FILE;
  before(async () => {
    historyDir = await mkdtemp(join(tmpdir(), 'smcp-exhaustmisc-history-'));
    historyFile = join(historyDir, 'search-history.json');
    process.env.SPOTIFY_MCP_SEARCH_HISTORY_FILE = historyFile;
  });
  after(async () => {
    if (priorHistoryFile === undefined) delete process.env.SPOTIFY_MCP_SEARCH_HISTORY_FILE;
    else process.env.SPOTIFY_MCP_SEARCH_HISTORY_FILE = priorHistoryFile;
    await rm(historyDir, { recursive: true, force: true });
  });

  async function searchHistoryStats() {
    let captured: unknown = null;
    const server = {
      tool(_name: string, _desc: string, _shape: unknown, handler: (args: unknown) => Promise<unknown>) {
        if (_name === 'search_history_stats') captured = handler;
      },
    } as unknown as McpServer;
    registerExhaustMiscTools(server, makeClient());
    const handler = captured as (args: unknown) => Promise<{ content: Array<{ text: string }>; structuredContent?: Record<string, unknown> }>;
    return handler({ response_format: 'concise' });
  }

  // The positive control. Without it the missing-file test below cannot
  // distinguish "reads the path I redirected" from "reads a path that happens
  // to be empty" — it passes either way, which is the same class of defect as
  // the bug this isolation was supposed to prevent.
  //
  // It asserts the *marker* entry rather than a count. A count alone is not
  // discriminating: a developer's real sidecar can hold exactly as many entries
  // as this fixture, and then a broken redirect still passes. The marker is
  // per-run and names a query no real sidecar will contain, so only the
  // redirected file can satisfy it.
  it('search_history_stats reads the sidecar the suite redirected it to', async () => {
    const marker = `w1207-marker-${randomUUID()}`;
    // Timestamps are generated, not literal: `loadSearchHistory` drops entries
    // older than 90 days, so a fixed date would expire in the spring of 2027
    // and turn this into a failure that has nothing to do with the redirect.
    const now = Date.now();
    const daysAgo = (n: number) => new Date(now - n * 86_400_000).toISOString();
    await writeFile(historyFile, JSON.stringify([
      { id: 'sh_a', query: marker, types: ['track'], timestamp: daysAgo(1), top_result_ids: ['spotify:track:1'] },
      { id: 'sh_b', query: 'beatles abbey', types: ['track'], timestamp: daysAgo(2), top_result_ids: ['spotify:track:2'] },
    ]));
    const res = await searchHistoryStats();
    const payload = res.structuredContent as { total: number; top_queries: Array<{ query: string }> };
    assert.equal(payload.total, 2, 'the tool must read the redirected sidecar, not the real ~/.spotify-mcp one');
    assert.ok(payload.top_queries.some((q) => q.query === marker),
      `the per-run marker ${marker} must be among the top queries — a sidecar without it is not the one this suite wrote`);
    await rm(historyFile, { force: true });
  });

  it('search_history_stats handles missing file gracefully', async () => {
    await rm(historyFile, { force: true });
    const res = await searchHistoryStats();
    // Asserted on `total`, and the prose match is anchored to a word boundary.
    // The original assertion was a bare `includes('0 searches')`, which a
    // NON-empty sidecar satisfies on its own: the real prose reads
    // "Search history stats: 10 searches.", and "10 searches" CONTAINS the
    // substring "0 searches". So the assertion this replaced was passing for
    // the wrong reason on exactly the machine it was written to protect.
    const payload = res.structuredContent as { total: number; top_queries: unknown[] };
    assert.equal(payload.total, 0, 'a missing sidecar must read as zero entries, not as an error');
    assert.deepEqual(payload.top_queries, []);
    assert.match(res.content[0].text, /(?:^|\D)0 searches|no search history/);
  });

  // #839: read-only here, so nothing is destroyed — but "0 searches" is the
  // claim the user would act on, and a stats tool is where they go to find
  // out whether their history survived. Reporting zero for a file that would
  // not parse is the same coercion as any other unreadable value dressed as a
  // measurement.
  it('search_history_stats names the failure instead of reporting 0 searches', async () => {
    const truncated = JSON.stringify([
      { id: 'sh_a', query: 'beatles abbey', types: ['track'], timestamp: new Date().toISOString(), top_result_ids: [] },
    ]).slice(0, 40);
    await writeFile(historyFile, truncated);
    try {
      const res = await searchHistoryStats();
      const payload = res.structuredContent as Record<string, unknown>;
      assert.equal(payload.ok, false);
      assert.equal(payload.error, 'load_error');
      assert.equal(payload.total, null, 'null, not 0: zero is what an empty store really says');
      assert.equal(payload.top_queries, null);
      assert.match(String(payload.load_error), /is not valid JSON/);
      assert.match(res.content[0].text, /could not be read/);
      assert.doesNotMatch(res.content[0].text, /0 searches/);
      assert.equal(await readFile(historyFile, 'utf8'), truncated, 'and the file is still exactly as it was');
    } finally {
      __resetSearchHistoryEpisode();
      await rm(historyFile, { force: true });
      await rm(`${historyFile}.corrupt`, { force: true });
    }
  });

  it('audiobook_progress counts only scanned chapters and discloses coverage', async () => {
    initConfig({ SPOTIFY_MCP_FETCH_ALL_CAP: '500' });
    let captured: unknown = null;
    const server = {
      tool(_name: string, _desc: string, _shape: unknown, handler: (args: unknown) => Promise<unknown>) {
        if (_name === 'audiobook_progress') captured = handler;
      },
    } as unknown as McpServer;
    const getAllPages = mock.fn(async () => [
      { id: 'ch1', chapter_number: 1, name: 'Ch1', resume_point: { fully_played: true } },
      { id: 'ch2', chapter_number: 2, name: 'Ch2' },
    ]);
    const client = makeClient({
      getAllPages,
      get: mock.fn(async (path: string) => {
        if (path.includes('/audiobooks/') && !path.includes('/chapters')) return { id: 'ab1', name: 'Dune', total_chapters: 2 } as unknown;
        return null;
      }),
    });
    registerExhaustMiscTools(server, client);
    const handler = captured as (args: unknown) => Promise<{ content: Array<{ text: string }>; structuredContent?: Record<string, unknown> }>;
    const res = await handler({ audiobook_id: 'ab1', response_format: 'concise' });
    const payload = res.structuredContent as { chapters_scanned: number; total_chapters: number; played_chapters: number; truncated: boolean; percent_complete: number | null };
    assert.equal(payload.chapters_scanned, 2);
    assert.equal(payload.total_chapters, 2);

    assert.equal(payload.played_chapters, 1);
    assert.equal(payload.truncated, false);
    assert.equal(payload.percent_complete, 50);
    assert.ok(res.content[0].text.includes('1/2 chapters played'));
    assert.equal(getAllPages.mock.callCount(), 1);
    assert.deepEqual(getAllPages.mock.calls[0].arguments, ['/audiobooks/ab1/chapters', { limit: '50' }, { maxItems: 500 }]);
    initConfig();
  });

  it('audiobook_progress is conservative when the chapter walk reaches the cap', async () => {
    initConfig({ SPOTIFY_MCP_FETCH_ALL_CAP: '2' });
    let captured: unknown = null;
    const server = {
      tool(_name: string, _desc: string, _shape: unknown, handler: (args: unknown) => Promise<unknown>) {
        if (_name === 'audiobook_progress') captured = handler;
      },
    } as unknown as McpServer;
    const client = makeClient({
      getAllPages: mock.fn(async () => [
        { id: 'ch1', chapter_number: 1, name: 'Ch1', resume_point: { fully_played: true } },
        { id: 'ch2', chapter_number: 2, name: 'Ch2', resume_point: { fully_played: true } },
      ]),
      get: mock.fn(async (path: string) => path.includes('/audiobooks/') && !path.includes('/chapters')
        ? { id: 'ab1', name: 'Dune', total_chapters: 3 } as unknown
        : null),
    });
    registerExhaustMiscTools(server, client);
    const handler = captured as (args: unknown) => Promise<{ content: Array<{ text: string }>; structuredContent?: Record<string, unknown> }>;
    const res = await handler({ audiobook_id: 'ab1', response_format: 'concise' });
    const payload = res.structuredContent as { chapters_scanned: number; total_chapters: number; truncated: boolean; percent_complete: number | null };
    assert.equal(payload.chapters_scanned, 2);
    assert.equal(payload.total_chapters, 3);
    assert.equal(payload.truncated, true);
    assert.equal(payload.percent_complete, null);
    assert.ok(res.content[0].text.includes('incomplete'));
    initConfig();
  });

  it('unsave_orphan_tracks refuses destructive runs after a playlist walk fails', async () => {
    let captured: unknown = null;
    const server = {
      tool(_name: string, _desc: string, _shape: unknown, handler: (args: unknown) => Promise<unknown>) {
        if (_name === 'unsave_orphan_tracks') captured = handler;
      },
    } as unknown as McpServer;
    const client = makeClient({
      getAllPages: mock.fn(async (path: string) => {
        if (path === '/me/tracks') return [{ track: { uri: 'spotify:track:orphan', id: 'orphan', name: 'Orphan' } }];
        if (path === '/me/playlists') return [{ id: 'private-playlist' }];
        throw new Error('playlist unavailable');
      }),
      delete: mock.fn(async () => null),
    });
    registerExhaustMiscTools(server, client);
    const handler = captured as (args: unknown) => Promise<unknown>;
    await assert.rejects(
      handler({ dry_run: false, response_format: 'concise' }),
      /Refusing to remove orphan tracks/,
    );
    const deleteMock = mockedMethod(client.delete);
    assert.equal(deleteMock.mock.callCount(), 0);
  });

  // #638 removed `DELETE /me/tracks` (50 ids per request). The chunking
  // contract survives; the endpoint and the batch size do not, so the old
  // "chunks at 50 IDs" assertion is replaced rather than repointed:
  // `/me/library` takes 40 uris, so 51 orphans are 40 + 11.
  it('unsave_orphan_tracks chunks destructive removals at the 40-uri /me/library cap', async () => {
    const captured: { handler?: unknown; name: string } = { name: 'unsave_orphan_tracks' };
    const server = autoConfirmingServer(captured);
    const saved = Array.from({ length: 51 }, (_, i) => ({
      track: { uri: `spotify:track:${i}`, id: `id-${i}`, name: `Track ${i}` },
    }));
    const client = makeClient({
      getAllPages: mock.fn(async (path: string) => path === '/me/tracks' ? saved : []),
      delete: mock.fn(async () => null),
    });
    registerExhaustMiscTools(server, client);
    const handler = captured.handler as (args: unknown) => Promise<unknown>;
    await handler({ dry_run: false, max_remove: 51, response_format: 'concise' });
    const deleteMock = mockedMethod(client.delete);
    assert.equal(deleteMock.mock.callCount(), 2);
    const batches = deleteMock.mock.calls.map((call) => {
      const path = recordedPath(call.arguments[0]);
      assert.match(path, /^\/me\/library\?/, `removal must go through /me/library, got ${path}`);
      const uris = new URL(`https://example.test${path}`).searchParams.get('uris');
      assert.ok(uris !== null, `/me/library request must carry a uris query param: ${path}`);
      return uris.split(',').filter(Boolean);
    });
    assert.deepEqual(batches.map((uris) => uris.length), [40, 11]);
    // Every orphan lands exactly once, in order: a dropped URI is a track the
    // caller asked to unsave and did not get.
    assert.deepEqual(batches.flat(), saved.map((s) => s.track.uri));
  });

  // #330: the documented /me/tracks/contains is on the #329 registration-gated
  // surface — contains-checks must go through the ungated unified endpoint.
  it('playlist_to_library dedupes via /me/library/contains (ungated drop-in)', async () => {
    let captured: unknown = null;
    const server = {
      tool(_name: string, _desc: string, _shape: unknown, handler: (args: unknown) => Promise<unknown>) {
        if (_name === 'playlist_to_library') captured = handler;
      },
    } as unknown as McpServer;
    const calls: Array<{ path: string; params?: Record<string, string> }> = [];
    const client = makeClient({
      getAllPages: mock.fn(async () => [{ item: { uri: 'spotify:track:t1', name: 'One' } }, { item: { uri: 'spotify:track:t2', name: 'Two' } }]),
      get: mock.fn(async (path: string, params?: Record<string, string>) => {
        calls.push({ path, params });
        if (path === '/me/library/contains') return [true, false];
        return null;
      }),
      put: mock.fn(async () => null),
    });
    registerExhaustMiscTools(server, client);
    const handler = captured as (args: unknown) => Promise<unknown>;
    await handler({ playlist_id: 'pl1', dry_run: true, response_format: 'concise' });
    const contains = calls.filter((c) => c.path.includes('/contains'));
    assert.equal(contains.length, 1);
    assert.equal(contains[0].path, '/me/library/contains');
    assert.equal(contains[0].params?.uris, 'spotify:track:t1,spotify:track:t2');
    assert.ok(!calls.some((c) => c.path.includes('/me/tracks/contains')));
  });

  // #638: the WRITE half of the same tool moved too — `PUT /me/tracks` (50 per
  // request) is gone, and `/me/library` takes 40. 100 tracks is the boundary
  // that tells the two apart: 2 requests at 50, 3 at 40.
  it('playlist_to_library saves through PUT /me/library at the 40-uri cap, covering every track once', async () => {
    let captured: unknown = null;
    const server = {
      tool(_name: string, _desc: string, _shape: unknown, handler: (args: unknown) => Promise<unknown>) {
        if (_name === 'playlist_to_library') captured = handler;
      },
    } as unknown as McpServer;
    const tracks = Array.from({ length: 100 }, (_, i) => ({ item: { uri: `spotify:track:t${i}`, name: `T${i}` } }));
    const client = makeClient({
      getAllPages: mock.fn(async () => tracks),
      // The dedupe read finds nothing saved, so every track is written.
      get: mock.fn(async (path: string, params?: Record<string, string>) => {
        if (path === '/me/library/contains') {
          return (params?.uris ?? '').split(',').filter(Boolean).map(() => false);
        }
        return null;
      }),
      put: mock.fn(async () => null),
    });
    registerExhaustMiscTools(server, client);
    const handler = captured as (args: unknown) => Promise<{ content: Array<{ text: string }>; structuredContent?: Record<string, unknown> }>;
    const res = await handler({ playlist_id: 'pl1', dry_run: false, response_format: 'concise' });

    const putMock = mockedMethod(client.put);
    assert.equal(putMock.mock.callCount(), 3, '100 uris is 3 requests at the 40-uri cap, not 2 at 50');
    const batches = putMock.mock.calls.map((call) => {
      const path = recordedPath(call.arguments[0]);
      assert.match(path, /^\/me\/library\?/, `save must go through /me/library, got ${path}`);
      const uris = new URL(`https://example.test${path}`).searchParams.get('uris');
      assert.ok(uris !== null, `/me/library request must carry a uris query param: ${path}`);
      return uris.split(',').filter(Boolean);
    });
    assert.deepEqual(batches.map((uris) => uris.length), [40, 40, 20]);
    assert.deepEqual(batches.flat(), tracks.map((t) => t.item.uri), 'every track saved exactly once, in order');
    assert.equal((res.structuredContent as { to_save: number }).to_save, 100);
  });

  it('remove_from_library_by_playlist checks saved state via /me/library/contains', async () => {    let captured: unknown = null;
    const server = {
      tool(_name: string, _desc: string, _shape: unknown, handler: (args: unknown) => Promise<unknown>) {
        if (_name === 'remove_from_library_by_playlist') captured = handler;
      },
    } as unknown as McpServer;
    const calls: Array<{ path: string; params?: Record<string, string> }> = [];
    const client = makeClient({
      getAllPages: mock.fn(async () => [{ item: { uri: 'spotify:track:t1', name: 'One' } }]),
      get: mock.fn(async (path: string, params?: Record<string, string>) => {
        calls.push({ path, params });
        if (path === '/me/library/contains') return [true];
        return null;
      }),
      delete: mock.fn(async () => null),
    });
    registerExhaustMiscTools(server, client);
    const handler = captured as (args: unknown) => Promise<unknown>;
    await handler({ playlist_id: 'pl1', dry_run: true, response_format: 'concise' });
    const contains = calls.filter((c) => c.path.includes('/contains'));
    assert.equal(contains.length, 1);
    assert.equal(contains[0].path, '/me/library/contains');
    assert.equal(contains[0].params?.uris, 'spotify:track:t1');
    assert.ok(!calls.some((c) => c.path.includes('/me/tracks/contains')));
  });

  // #819: the description advertises "public, follower totals" — the payload
  // must carry the rollups it names, summed from the rows actually read.
  it('followed_playlists_audit reports the public/private and follower totals it advertises', async () => {
    let captured: unknown = null;
    const server = {
      tool(_name: string, _desc: string, _shape: unknown, handler: (args: unknown) => Promise<unknown>) {
        if (_name === 'followed_playlists_audit') captured = handler;
      },
    } as unknown as McpServer;
    const rows = [
      { id: 'pl-a', name: 'A', owner: { id: 'other-1' }, collaborative: false, public: true, followers: { total: 5 }, tracks: { total: 10 } },
      { id: 'pl-b', name: 'B', owner: { id: 'other-2' }, collaborative: true, public: false, followers: { total: 7 }, tracks: { total: 20 } },
      { id: 'pl-c', name: 'C', owner: { id: 'other-3' }, collaborative: false, public: true, followers: { total: 0 }, tracks: { total: 30 } },
    ];
    const client = makeClient({
      get: mock.fn(async (path: string) => (path === '/me' ? { id: 'me' } : null)),
      getAllPages: mock.fn(async (path: string) => (path === '/me/playlists' ? rows : [])),
    });
    registerExhaustMiscTools(server, client);
    const handler = captured as (args: unknown) => Promise<{ content: Array<{ text: string }>; structuredContent?: Record<string, unknown> }>;
    const res = await handler({ only_followed: true, response_format: 'concise', max_results: 50 });
    const sc = res.structuredContent as {
      followed: number;
      public: { count: number; private: number; unknown: number };
      followers: { total: number; reported: number; unknown: number; per_playlist?: unknown };
    };
    assert.equal(sc.followed, 3);
    assert.deepEqual(sc.public, { count: 2, private: 1, unknown: 0 });
    // 5 + 7 + 0 from the fixture, summed by hand rather than recomputed from
    // the code under test.
    assert.equal(sc.followers.total, 12);
    assert.equal(sc.followers.reported, 3);
    assert.equal(sc.followers.unknown, 0);
    // `items` already carries each row verbatim under the truncateItems cap; a
    // second full-length per-playlist copy would walk past the `returned` count
    // the payload itself advertises.
    assert.equal(sc.followers.per_playlist, undefined);
    const prose = res.content[0].text;
    assert.ok(prose.includes('2 public'), prose);
    assert.ok(prose.includes('1 private'), prose);
    assert.ok(prose.includes('12 follower(s)'), prose);
  });

  // A row that reports neither field must land in the unknown buckets, not be
  // silently coerced to "private" or to "0 followers" (#750: never publish a
  // total that was never fetched).
  it('followed_playlists_audit separates unreported visibility and follower counts from reported ones', async () => {
    let captured: unknown = null;
    const server = {
      tool(_name: string, _desc: string, _shape: unknown, handler: (args: unknown) => Promise<unknown>) {
        if (_name === 'followed_playlists_audit') captured = handler;
      },
    } as unknown as McpServer;
    const rows = [
      { id: 'pl-known', name: 'Known', owner: { id: 'other-1' }, collaborative: false, public: true, followers: { total: 4 }, tracks: { total: 1 } },
      { id: 'pl-bare', name: 'Bare', owner: { id: 'other-2' }, collaborative: false, public: null, tracks: { total: 1 } },
    ];
    const client = makeClient({
      get: mock.fn(async (path: string) => (path === '/me' ? { id: 'me' } : null)),
      getAllPages: mock.fn(async (path: string) => (path === '/me/playlists' ? rows : [])),
    });
    registerExhaustMiscTools(server, client);
    const handler = captured as (args: unknown) => Promise<{ content: Array<{ text: string }>; structuredContent?: Record<string, unknown> }>;
    const res = await handler({ response_format: 'concise', max_results: 50 });
    const sc = res.structuredContent as {
      public: { count: number; private: number; unknown: number };
      followers: { total: number; reported: number; unknown: number };
    };
    assert.deepEqual(sc.public, { count: 1, private: 0, unknown: 1 });
    assert.equal(sc.followers.total, 4);
    // A `?? 0` default would report 2/0 here — the bare row's count was never
    // fetched, so it must not be counted as a reported zero.
    assert.equal(sc.followers.reported, 1);
    assert.equal(sc.followers.unknown, 1);
    assert.ok(res.content[0].text.includes('4 follower(s) across 1/2 playlist(s)'), res.content[0].text);
  });

  // #820: creation and item writes must use the modern pair; the legacy
  // /users/{id}/playlists + /playlists/{id}/tracks paths are retired for
  // post-Nov-2024 app registrations.
  it('split_playlist writes through /me/playlists and /playlists/{id}/items only', async () => {
    let captured: unknown = null;
    const server = {
      tool(_name: string, _desc: string, _shape: unknown, handler: (args: unknown) => Promise<unknown>) {
        if (_name === 'split_playlist') captured = handler;
      },
    } as unknown as McpServer;
    const items = Array.from({ length: 205 }, (_, i) => ({ item: { uri: `spotify:track:t${i}` } }));
    const created: string[] = [];
    const client = makeClient({
      get: mock.fn(async (path: string) => {
        if (path === '/me') return { id: 'me' };
        if (path === '/playlists/src') return { id: 'src', name: 'Source' };
        return null;
      }),
      getAllPages: mock.fn(async () => items),
      post: mock.fn(async (path: string) => {
        if (path === '/me/playlists') {
          const id = `new-${created.length}`;
          created.push(id);
          return { id };
        }
        return null;
      }),
    });
    registerExhaustMiscTools(server, client);
    const handler = captured as (args: unknown) => Promise<unknown>;
    await handler({ playlist_id: 'src', parts: 2, dry_run: false });
    const postMock = mockedMethod(client.post);
    const calls = postMock.mock.calls;
    const paths = calls.map((c) => recordedPath(c.arguments[0]));
    assert.equal(paths.filter((p) => p === '/me/playlists').length, 2);
    assert.ok(
      paths.every((p) => p === '/me/playlists' || /^\/playlists\/new-\d+\/items$/.test(p)),
      paths.join(', '),
    );
    assert.ok(!paths.some((p) => /^\/users\/.+\/playlists$/.test(p)), paths.join(', '));
    assert.ok(!paths.some((p) => /\/tracks$/.test(p)), paths.join(', '));
    // The allow-list above only PERMITS `/items`; it does not require it, so a
    // handler that created the parts and then wrote nothing at all would still
    // pass. Require the writes: 205 uris over parts=2 chunks to [103, 102], each
    // appended in CHUNK_CAPS.playlist_writes (100) batches, so 4 item posts
    // carrying [100, 3, 100, 2] uris — every source URI written exactly once, in
    // order, to the playlist created for its own part.
    const itemCalls = calls.filter((c) => recordedPath(c.arguments[0]).endsWith('/items'));
    assert.equal(itemCalls.length, 4);
    assert.deepEqual(itemCalls.map((c) => recordedUris(c.arguments[1]).length), [100, 3, 100, 2]);
    assert.deepEqual(itemCalls.map((c) => recordedPath(c.arguments[0])), [
      '/playlists/new-0/items',
      '/playlists/new-0/items',
      '/playlists/new-1/items',
      '/playlists/new-1/items',
    ]);
    // The written set is the source set, in source order — a dropped or
    // reordered batch changes this, and so does a write to the wrong part.
    assert.deepEqual(itemCalls.flatMap((c) => recordedUris(c.arguments[1])), items.map((i) => i.item.uri));
  });

  it('split_playlist fails with a named error when the profile cannot be read', async () => {
    let captured: unknown = null;
    const server = {
      tool(_name: string, _desc: string, _shape: unknown, handler: (args: unknown) => Promise<unknown>) {
        if (_name === 'split_playlist') captured = handler;
      },
    } as unknown as McpServer;
    const client = makeClient({
      get: mock.fn(async (path: string) => (path === '/playlists/src' ? { id: 'src', name: 'Source' } : null)),
      getAllPages: mock.fn(async () => [{ item: { uri: 'spotify:track:t1' } }]),
      post: mock.fn(async () => ({ id: 'new' })),
    });
    registerExhaustMiscTools(server, client);
    const handler = captured as (args: unknown) => Promise<unknown>;
    await assert.rejects(
      handler({ playlist_id: 'src', parts: 2, dry_run: false }),
      /Could not read the current user profile/,
    );
    const postMock = mockedMethod(client.post);
    assert.equal(postMock.mock.callCount(), 0);
  });

  it('split_playlist reports the same chunk plan on the dry-run and commit paths', async () => {
    let captured: unknown = null;
    const server = {
      tool(_name: string, _desc: string, _shape: unknown, handler: (args: unknown) => Promise<unknown>) {
        if (_name === 'split_playlist') captured = handler;
      },
    } as unknown as McpServer;
    const items = Array.from({ length: 205 }, (_, i) => ({ item: { uri: `spotify:track:t${i}` } }));
    const client = makeClient({
      get: mock.fn(async (path: string) => {
        if (path === '/me') return { id: 'me' };
        if (path === '/playlists/src') return { id: 'src', name: 'Source' };
        return null;
      }),
      getAllPages: mock.fn(async () => items),
      post: mock.fn(async (path: string) => (path === '/me/playlists' ? { id: 'new' } : null)),
    });
    registerExhaustMiscTools(server, client);
    const handler = captured as (args: unknown) => Promise<{ structuredContent?: Record<string, unknown> }>;
    const dry = await handler({ playlist_id: 'src', parts: 3, dry_run: true });
    const commit = await handler({ playlist_id: 'src', parts: 3, dry_run: false });
    // 205 uris over 3 parts: ceil(205/3) = 69 per part, last part takes the remainder.
    assert.deepEqual(dry.structuredContent!.chunk_sizes, [69, 69, 67]);
    assert.deepEqual(commit.structuredContent!.chunk_sizes, [69, 69, 67]);
  });
});

/**
 * #1550 — the bulk-removal half of this module.
 *
 * `unsave_orphan_tracks` and `remove_from_library_by_playlist` both declared
 * the OPT-IN `DryRun` fragment, which publishes no default, while their
 * handlers read `args.dry_run ?? true`. The runtime therefore previewed but
 * the schema said nothing — and a host reads the schema. Neither had any
 * confirmation gate, and between them they can unsave every saved copy of a
 * playlist (unbounded) or up to 5,000 orphan tracks (`max_remove`).
 */
describe('exhaustmisc — #1550 bulk removal defaults and gate', () => {
  const savedTracks = (n: number) =>
    Array.from({ length: n }, (_, i) => ({
      track: { uri: `spotify:track:${i}`, id: `id-${i}`, name: `Track ${i}` },
    }));

  it('unsave_orphan_tracks with NO dry_run key deletes nothing', async () => {
    const captured: { handler?: unknown; name: string } = { name: 'unsave_orphan_tracks' };
    const server = autoConfirmingServer(captured);
    const client = makeClient({
      getAllPages: mock.fn(async (path: string) => (path === '/me/tracks' ? savedTracks(30) : [])),
      delete: mock.fn(async () => null),
    });
    registerExhaustMiscTools(server, client);
    const handler = captured.handler as (a: unknown) => Promise<{ structuredContent?: Record<string, unknown> }>;
    const res = await handler({ response_format: 'concise' });

    assert.equal((client.delete as unknown as { mock: { callCount(): number } }).mock.callCount(), 0,
      'an omitted dry_run unsaved 30 tracks');
    assert.equal(res.structuredContent?.dry_run, true, 'the result must report a preview');
  });

  it('unsave_orphan_tracks still commits on an explicit dry_run=false', async () => {
    const captured: { handler?: unknown; name: string } = { name: 'unsave_orphan_tracks' };
    const server = autoConfirmingServer(captured);
    const client = makeClient({
      getAllPages: mock.fn(async (path: string) => (path === '/me/tracks' ? savedTracks(3) : [])),
      delete: mock.fn(async () => null),
    });
    registerExhaustMiscTools(server, client);
    const handler = captured.handler as (a: unknown) => Promise<unknown>;
    await handler({ dry_run: false, response_format: 'concise' });
    assert.equal((client.delete as unknown as { mock: { callCount(): number } }).mock.callCount(), 1);
  });

  it('unsave_orphan_tracks refuses at 10+ when the client cannot be asked', async () => {
    // No elicitation advertised: the fail-closed `unsupported` arm.
    const captured: { handler?: unknown; name: string } = { name: 'unsave_orphan_tracks' };
    const server = {
      tool(name: string, _d: string, _s: unknown, h: (a: unknown) => Promise<unknown>) {
        if (name === 'unsave_orphan_tracks') captured.handler = h;
      },
    } as unknown as McpServer;
    const client = makeClient({
      getAllPages: mock.fn(async (path: string) => (path === '/me/tracks' ? savedTracks(10) : [])),
      delete: mock.fn(async () => null),
    });
    registerExhaustMiscTools(server, client);
    const handler = captured.handler as (a: unknown) => Promise<{ structuredContent?: Record<string, unknown> }>;
    const res = await handler({ dry_run: false, response_format: 'concise' });

    assert.equal((client.delete as unknown as { mock: { callCount(): number } }).mock.callCount(), 0,
      '10 orphans unsaved with no way to ask a human');
    assert.equal(res.structuredContent?.reason, 'confirmation_unavailable');
  });

  it('unsave_orphan_tracks stays ungated below the threshold (9 orphans)', async () => {
    const captured: { handler?: unknown; name: string } = { name: 'unsave_orphan_tracks' };
    const server = {
      tool(name: string, _d: string, _s: unknown, h: (a: unknown) => Promise<unknown>) {
        if (name === 'unsave_orphan_tracks') captured.handler = h;
      },
    } as unknown as McpServer;
    const client = makeClient({
      getAllPages: mock.fn(async (path: string) => (path === '/me/tracks' ? savedTracks(9) : [])),
      delete: mock.fn(async () => null),
    });
    registerExhaustMiscTools(server, client);
    const handler = captured.handler as (a: unknown) => Promise<unknown>;
    await handler({ dry_run: false, response_format: 'concise' });
    assert.equal((client.delete as unknown as { mock: { callCount(): number } }).mock.callCount(), 1);
  });

  it('remove_from_library_by_playlist publishes default:true for dry_run', async () => {
    // The schema half: a host reading tools/list must be able to see the
    // default without reading the handler.
    const captured: { handler?: unknown; name: string; shape?: unknown } = { name: 'remove_from_library_by_playlist' };
    const server = autoConfirmingServer(captured) as unknown as { tool: (n: string, d: string, s: unknown, h: unknown) => void };
    const original = server.tool.bind(server);
    server.tool = (n, d, s, h) => { if (n === 'remove_from_library_by_playlist') captured.shape = s; original(n, d, s, h); };
    registerExhaustMiscTools(server as unknown as McpServer, makeClient());
    const shape = z.object(captured.shape as z.ZodRawShape);
    // `.default(true)` is what makes the published JSON Schema carry the
    // default; assert the parse, not the source text.
    assert.equal(shape.parse({ playlist_id: 'pl1' }).dry_run, true);
    assert.equal(shape.parse({ playlist_id: 'pl1', dry_run: false }).dry_run, false);
  });

  it('remove_from_library_by_playlist refuses a 10-track removal with no way to ask', async () => {
    const rows = Array.from({ length: 10 }, (_, i) => ({ item: { uri: `spotify:track:${i}` } }));
    const captured: { handler?: unknown; name: string } = { name: 'remove_from_library_by_playlist' };
    const server = {
      tool(name: string, _d: string, _s: unknown, h: (a: unknown) => Promise<unknown>) {
        if (name === 'remove_from_library_by_playlist') captured.handler = h;
      },
    } as unknown as McpServer;
    const client = makeClient({
      getAllPages: mock.fn(async () => rows),
      get: mock.fn(async (path: string) => (path === '/me/library/contains' ? Array(10).fill(true) : null)),
      delete: mock.fn(async () => null),
    });
    registerExhaustMiscTools(server, client);
    const handler = captured.handler as (a: unknown) => Promise<{ structuredContent?: Record<string, unknown> }>;
    const res = await handler({ playlist_id: 'pl1', dry_run: false, response_format: 'concise' });

    assert.equal((client.delete as unknown as { mock: { callCount(): number } }).mock.callCount(), 0,
      'a 10-track library removal committed without a confirmation');
    assert.equal(res.structuredContent?.reason, 'confirmation_unavailable');
  });
});
