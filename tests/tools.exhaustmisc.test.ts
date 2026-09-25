import { describe, it, mock } from 'node:test';
import assert from 'node:assert/strict';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { registerExhaustMiscTools } from '../src/tools/exhaustmisc.js';
import { initConfig } from '../src/config.js';

function makeClient(overrides: Record<string, unknown> = {}) {
  return {
    get: mock.fn(async () => null),
    getAllPages: mock.fn(async () => []),
    put: mock.fn(async () => null),
    post: mock.fn(async () => null),
    delete: mock.fn(async () => null),
    ...overrides,
  } as unknown as import('../src/client.js').SpotifyClient;
}

function registeredTools(client: ReturnType<typeof makeClient>): string[] {
  const names: string[] = [];
  const server = {
    tool(name: string) { names.push(name); },
  } as unknown as McpServer;
  registerExhaustMiscTools(server, client);
  return names;
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

  it('search_within_playlist filters by query', async () => {
    let captured: unknown = null;
    const server = {
      tool(_name: string, _desc: string, _shape: unknown, handler: (args: unknown) => Promise<unknown>) {
        if (_name === 'search_within_playlist') captured = handler;
      },
    } as unknown as McpServer;
    const client = makeClient({
      getAllPages: mock.fn(async () => [
        { item: { uri: 'spotify:track:1', name: 'Hello World', artists: [{ name: 'Adele' }], album: { name: '25' } }, added_at: '2024-01-01' },
        { item: { uri: 'spotify:track:2', name: 'Goodbye', artists: [{ name: 'Beatles' }], album: { name: 'Abbey' } }, added_at: '2024-01-02' },
      ]),
    });
    registerExhaustMiscTools(server, client);
    const handler = captured as (args: unknown) => Promise<{ content: Array<{ text: string }>; structuredContent?: Record<string, unknown> }>;
    const res = await handler({ playlist_id: 'pl1', query: 'hello', response_format: 'concise', max_results: 50 });
    assert.ok(res.content[0].text.includes('1 match'));
    assert.equal((res.structuredContent as { matched: number }).matched, 1);
  });

  // Isolate from the developer's real ~/.spotify-mcp/search-history.json. This
  // test passes only because nothing used to write there; now that the search
  // tools record history, a non-empty home sidecar makes it fail on any machine.
  initConfig({ SPOTIFY_MCP_SEARCH_HISTORY_FILE: '/tmp/smcp-exhaustmisc-test-search-history.json' });

  it('search_history_stats handles missing file gracefully', async () => {
    let captured: unknown = null;
    const server = {
      tool(_name: string, _desc: string, _shape: unknown, handler: (args: unknown) => Promise<unknown>) {
        if (_name === 'search_history_stats') captured = handler;
      },
    } as unknown as McpServer;
    const client = makeClient();
    registerExhaustMiscTools(server, client);
    const handler = captured as (args: unknown) => Promise<{ content: Array<{ text: string }> }>;
    const res = await handler({ response_format: 'concise' });
    assert.ok(res.content[0].text.includes('0 searches') || res.content[0].text.includes('no search history'));
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
    const deleteMock = client.delete as { mock: { callCount(): number } };
    assert.equal(deleteMock.mock.callCount(), 0);
  });

  it('unsave_orphan_tracks chunks destructive removals at 50 IDs', async () => {
    let captured: unknown = null;
    const server = {
      tool(_name: string, _desc: string, _shape: unknown, handler: (args: unknown) => Promise<unknown>) {
        if (_name === 'unsave_orphan_tracks') captured = handler;
      },
    } as unknown as McpServer;
    const saved = Array.from({ length: 51 }, (_, i) => ({
      track: { uri: `spotify:track:${i}`, id: `id-${i}`, name: `Track ${i}` },
    }));
    const client = makeClient({
      getAllPages: mock.fn(async (path: string) => path === '/me/tracks' ? saved : []),
      delete: mock.fn(async () => null),
    });
    registerExhaustMiscTools(server, client);
    const handler = captured as (args: unknown) => Promise<unknown>;
    await handler({ dry_run: false, max_remove: 51, response_format: 'concise' });
    const deleteMock = client.delete as { mock: { callCount(): number; calls: Array<{ arguments: unknown[] }> } };
    assert.equal(deleteMock.mock.callCount(), 2);
    const firstIds = new URL(`https://example.test${deleteMock.mock.calls[0].arguments[0]}`).searchParams.get('ids')!.split(',');
    const secondIds = new URL(`https://example.test${deleteMock.mock.calls[1].arguments[0]}`).searchParams.get('ids')!.split(',');
    assert.equal(firstIds.length, 50);
    assert.equal(secondIds.length, 1);
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

  it('remove_from_library_by_playlist checks saved state via /me/library/contains', async () => {
    let captured: unknown = null;
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
});
