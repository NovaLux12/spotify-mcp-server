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
    const postMock = client.post as { mock: { calls: Array<{ arguments: unknown[] }> } };
    const paths = postMock.mock.calls.map((c) => c.arguments[0] as string);
    assert.equal(paths.filter((p) => p === '/me/playlists').length, 2);
    assert.ok(
      paths.every((p) => p === '/me/playlists' || /^\/playlists\/new-\d+\/items$/.test(p)),
      paths.join(', '),
    );
    assert.ok(!paths.some((p) => /^\/users\/.+\/playlists$/.test(p)), paths.join(', '));
    assert.ok(!paths.some((p) => /\/tracks$/.test(p)), paths.join(', '));
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
    const postMock = client.post as { mock: { callCount(): number } };
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
