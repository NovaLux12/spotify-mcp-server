import { describe, it, mock } from 'node:test';
import assert from 'node:assert/strict';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { registerExhaustMiscTools } from '../src/tools/exhaustmisc.js';

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

  it('audiobook_progress returns structured payload', async () => {
    let captured: unknown = null;
    const server = {
      tool(_name: string, _desc: string, _shape: unknown, handler: (args: unknown) => Promise<unknown>) {
        if (_name === 'audiobook_progress') captured = handler;
      },
    } as unknown as McpServer;
    const client = makeClient({
      get: mock.fn(async (path: string) => {
        if (path.includes('/audiobooks/') && !path.includes('/chapters')) return { id: 'ab1', name: 'Dune', total_chapters: 10 } as unknown;
        if (path.includes('/chapters')) return { items: [{ id: 'ch1', chapter_number: 1, name: 'Ch1', resume_point: { fully_played: true } }, { id: 'ch2', chapter_number: 2, name: 'Ch2' }] } as unknown;
        return null;
      }),
    });
    registerExhaustMiscTools(server, client);
    const handler = captured as (args: unknown) => Promise<{ content: Array<{ text: string }>; structuredContent?: Record<string, unknown> }>;
    const res = await handler({ audiobook_id: 'ab1', response_format: 'concise' });
    assert.ok(res.content[0].text.includes('Dune'));
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
