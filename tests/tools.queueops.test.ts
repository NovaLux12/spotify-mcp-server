import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { registerQueueOpsTools } from '../src/tools/queueops.js';
import { installGatedPathContract } from '../src/gating.js';
import { SpotifyApiError } from '../src/client.js';
import type { SpotifyClient } from '../src/client.js';

function track(id: string) { return { id, uri: `spotify:track:${id}`, name: `T ${id}`, type: 'track', duration_ms: 200000, artists: [{ id: 'a', name: 'A' }], album: { id: 'al', name: 'Al', uri: 'spotify:album:al' } } as any; }
function episode(id: string) { return { uri: `spotify:episode:${id}`, type: 'episode', id } as any; }

function harness(overrides: Partial<{
  playlistItems: any[]; albumTracks: any[]; topTracks: any[];
  artistAlbums: Array<{ id: string }>;
  /** Thrown by the `/artists/{id}/top-tracks` read (the gated family, #1225). */
  topTracksError?: Error;
  /** Thrown by the `/artists/{id}/albums` read — a missing artist, say. */
  artistAlbumsError?: Error;
  /**
   * Whether `src/gating.ts`'s contract is installed on the fake client. It is
   * on every real client; `false` reproduces a host that skipped it, where the
   * gated 403 arrives un-annotated.
   */
  installContract?: boolean;
  queueData: any; meResponse: any; createPlaylistResponse: any;
  postErrorFor?: (path: string, index: number) => Error | undefined;
}> = {}) {
  const registered: any[] = []; const posts: string[] = []; const postBodies: any[] = [];
  const getCalls: string[] = [];
  // Rows a write actually landed, keyed by playlist id. The playlist writers
  // now re-read /playlists/{id}/items to verify themselves (#879), so a stub
  // that answered nothing there would make a committed write look dropped.
  const rows = new Map<string, any[]>();
  const itemsPath = /^\/playlists\/([^/]+)\/items$/;
  const fakeServer = { tool(name: string, _d: string, schema: any, handler: any) { registered.push({ name, schema, handler }); } } as unknown as McpServer;
  const client = {
    async get(path: string) {
      getCalls.push(path);
      if (path === '/me/player/queue') return overrides.queueData ?? { currently_playing: track('cur'), queue: [track('q1'), track('q2')] };
      if (path === '/me' && overrides.meResponse) return overrides.meResponse;
      if (path === '/me') return { id: 'user123' } as any;
      if (path.includes('/top-tracks')) {
        if (overrides.topTracksError) throw overrides.topTracksError;
        return { tracks: overrides.topTracks ?? [track('tt1')] } as any;
      }
      if (path.includes('/artists/') && path.endsWith('/albums')) {
        if (overrides.artistAlbumsError) throw overrides.artistAlbumsError;
        return { items: overrides.artistAlbums ?? [], total: (overrides.artistAlbums ?? []).length } as any;
      }
      if (path.startsWith('/albums/')) return { items: overrides.albumTracks ?? [track('t1'), track('t2')], total: 2 } as any;
      const items = itemsPath?.exec(path);
      if (items) {
        const list = rows.get(decodeURIComponent(items[1])) ?? [];
        return { items: list, total: list.length, next: null } as any;
      }
      return null;
    },
    async getAllPages(path: string) {
      if (path.includes('/playlists/')) return overrides.playlistItems ?? [{ item: track('p1') }, { item: track('p2') }];
      return [];
    },
    async post(path: string, body?: unknown) {
      posts.push(path); postBodies.push(body);
      const queueError = path.startsWith('/me/player/queue?')
        ? overrides.postErrorFor?.(path, posts.length - 1)
        : undefined;
      if (queueError) throw queueError;
      if (path.includes('/users/') && path.includes('/playlists')) {
        const created = overrides.createPlaylistResponse ?? { id: 'newPlId', external_urls: { spotify: 'https://open.spotify.com/playlist/newPlId' }, snapshot_id: 'snap1' };
        if (!rows.has(created.id)) rows.set(created.id, []);
        return created as any;
      }
      const write = itemsPath.exec(path);
      if (write) {
        const list = rows.get(decodeURIComponent(write[1])) ?? [];
        for (const uri of ((body as any)?.uris ?? []) as string[]) list.push({ item: { uri } });
        rows.set(decodeURIComponent(write[1]), list);
        return { snapshot_id: 'snap2' } as any;
      }
      if (path.includes('/playlists/') && path.includes('/tracks')) {
        // Legacy /tracks path is retired (#840). Any tool that still POSTs
        // here is broken; surface the regression as a 404 so the assertion
        // fails loudly.
        throw Object.assign(new Error('legacy /playlists/{id}/tracks is retired, use /items'), { status: 404 });
      }
      return null;
    },
    async put(path: string) { throw Object.assign(new Error('no endpoint'), { status: 404 }); },
    async delete(path: string) { throw Object.assign(new Error('no endpoint'), { status: 404 }); },
  };
  // The real client is wrapped by src/gating.ts at construction, so a gated
  // 403 arrives ANNOTATED. Tests that assert on the gated class need that
  // annotation to be present, or they would only be exercising the fallback
  // predicate's status check.
  if (overrides.installContract !== false) installGatedPathContract(client as unknown as SpotifyClient);
  registerQueueOpsTools(fakeServer, client as unknown as SpotifyClient);
  const find = (n: string) => registered.find((r: any) => r.name === n);
  const invoke = async (name: string, args: any) => {
    const t = find(name); assert.ok(t, `tool ${name} not found`); const parsed = z.object(t.schema).parse(args); return t.handler(parsed);
  };
  return { registered, posts, postBodies, getCalls, invoke };
}

describe('queueops', () => {
  it('registers exactly 3 tools (queue_playlist + save_queue_as_playlist + batch_add_to_queue)', () => {
    const h = harness();
    assert.equal(h.registered.length, 3);
    assert.ok(h.registered.some((r: any) => r.name === 'queue_playlist'));
    assert.ok(h.registered.some((r: any) => r.name === 'save_queue_as_playlist'));
    assert.ok(h.registered.some((r: any) => r.name === 'batch_add_to_queue'));
  });
  it('does not register phantom queue_reorder/remove/clear tools', () => {
    const h = harness();
    const names = h.registered.map((r: any) => r.name);
    assert.ok(!names.includes('queue_reorder'), 'queue_reorder should be removed');
    assert.ok(!names.includes('queue_remove'), 'queue_remove should be removed');
    assert.ok(!names.includes('queue_clear'), 'queue_clear should be removed');
  });
  it('queue_playlist dry_run previews without POST', async () => {
    const h = harness({ playlistItems: [{ item: track('x1') }, { item: track('x2') }] });
    const out = await h.invoke('queue_playlist', { source_uri: 'spotify:playlist:pl1', mode: 'append', dry_run: true });
    assert.match(out.content[0].text, /dry run/i);
    assert.equal(h.posts.length, 0);
  });
  it('queue_playlist append POSTs per track', async () => {
    const h = harness({ playlistItems: [{ item: track('a1') }, { item: track('a2') }] });
    const out = await h.invoke('queue_playlist', { source_uri: 'spotify:playlist:pl1', mode: 'append' });
    assert.equal(h.posts.length, 2);
    assert.match(out.content[0].text, /Queued 2/);
  });
  it('queue_playlist reports each failed URI with an actionable reason', async () => {
    const h = harness({
      playlistItems: [
        { item: track('a1') },
        { item: track('a2') },
        { item: track('a3') },
        { item: track('a4') },
        { item: track('a5') },
      ],
      postErrorFor: (_path, index) => index === 1
        ? new SpotifyApiError(429, 'slow down')
        : index === 3
          ? Object.assign(new Error('track unavailable'), { status: 404 })
          : undefined,
    });
    const out = await h.invoke('queue_playlist', { source_uri: 'spotify:playlist:pl1', mode: 'append' });
    const structured = out.structuredContent as { queued: number; failed: Array<{ uri: string; reason: string }>; dominant_cause: string | null } | undefined;
    assert.ok(structured);
    assert.equal(structured.queued, 3);
    assert.equal(structured.dominant_cause, '429 rate limited');
    assert.deepEqual(structured.failed, [
      { uri: 'spotify:track:a2', reason: '429 rate limited: slow down' },
      { uri: 'spotify:track:a4', reason: '404 not found: track unavailable' },
    ]);
    assert.match(out.content[0].text, /dominant: 429 rate limited/);
    assert.match(out.content[0].text, /spotify:track:a2/);
    assert.match(out.content[0].text, /spotify:track:a4/);
  });

  // #1225 — /artists/{id}/top-tracks is app-registration-gated (src/gating.ts).
  // Whether it answers is a property of the registration, not of the artist, so
  // a gated/removed answer must reach the albums fallback that already sits
  // under the read -- and must be disclosed, because an album-derived queue
  // reported as a top-tracks selection is the #803 class.
  const gated = (extra: Record<string, unknown> = {}) => ({
    artistAlbums: [{ id: 'al1' }],
    albumTracks: [track('alt1'), track('alt2')],
    ...extra,
  });

  it('#1225 falls back to the albums walk when artist top-tracks is registration-gated', async () => {
    const h = harness(gated({ topTracksError: new SpotifyApiError(403, 'Forbidden') }));
    const out = await h.invoke('queue_playlist', { source_uri: 'spotify:artist:ar1', mode: 'append' });
    assert.ok(h.getCalls.includes('/artists/ar1/albums'), 'the albums fallback must actually run');
    assert.deepEqual(h.posts, ['/me/player/queue?uri=spotify%3Atrack%3Aalt1', '/me/player/queue?uri=spotify%3Atrack%3Aalt2']);
    const structured = out.structuredContent as { ok: boolean; queued: number; resolved_via: string | null } | undefined;
    assert.equal(structured?.ok, true);
    assert.equal(structured?.queued, 2);
    assert.equal(structured?.resolved_via, 'albums');
  });

  it('#1225 discloses which read failed, in prose and in the payload', async () => {
    const h = harness(gated({ topTracksError: new SpotifyApiError(403, 'Forbidden') }));
    const out = await h.invoke('queue_playlist', { source_uri: 'spotify:artist:ar1', mode: 'append' });
    const structured = out.structuredContent as { note: string | null } | undefined;
    assert.ok(structured?.note, 'a failed read must carry a note, not report as a plain top-tracks pick');
    assert.match(structured.note, /\/artists\/\{id\}\/top-tracks/);
    assert.match(structured.note, /403/);
    // The note has to say the tracks did NOT come from top-tracks, or the
    // reader cannot tell a fallback apart from a real selection.
    assert.match(structured.note, /NOT from a top-tracks read/);
    assert.match(out.content[0].text, /NOT from a top-tracks read/);
  });

  it('#1225 carries the same disclosure through a dry run', async () => {
    const h = harness(gated({ topTracksError: new SpotifyApiError(403, 'Forbidden') }));
    const out = await h.invoke('queue_playlist', { source_uri: 'spotify:artist:ar1', mode: 'append', dry_run: true });
    assert.match(out.content[0].text, /dry run/i);
    assert.match(out.content[0].text, /NOT from a top-tracks read/);
    assert.equal(h.posts.length, 0);
  });

  it('#1225 a bare, un-annotated 403 is the same class as an annotated one', async () => {
    // A host that somehow skipped src/gating.ts still gets a plain 403 from
    // this path. It must not be the one case that hard-fails.
    const h = harness(gated({ topTracksError: new SpotifyApiError(403, 'Forbidden'), installContract: false }));
    const out = await h.invoke('queue_playlist', { source_uri: 'spotify:artist:ar1', mode: 'append' });
    assert.equal((out.structuredContent as { resolved_via: string | null })?.resolved_via, 'albums');
  });

  it('#1225 the removed-endpoint answer (404/410) also reaches the fallback', async () => {
    const h = harness(gated({ topTracksError: new SpotifyApiError(410, 'Gone') }));
    const out = await h.invoke('queue_playlist', { source_uri: 'spotify:artist:ar1', mode: 'append' });
    const structured = out.structuredContent as { resolved_via: string | null; note: string | null } | undefined;
    assert.equal(structured?.resolved_via, 'albums');
    assert.match(structured?.note ?? '', /410/);
    assert.match(structured?.note ?? '', /REMOVED/);
  });

  it('#1225 an unrelated failure still throws — the fallback is not a blanket catch', async () => {
    const h = harness(gated({ topTracksError: new SpotifyApiError(500, 'Boom') }));
    await assert.rejects(
      () => h.invoke('queue_playlist', { source_uri: 'spotify:artist:ar1', mode: 'append' }),
      /Boom/,
    );
    assert.equal(h.getCalls.includes('/artists/ar1/albums'), false, 'a 500 must not be degraded into the fallback');
    assert.equal(h.posts.length, 0);
  });

  it('#1225 a genuinely missing artist still surfaces (the albums read 404s too)', async () => {
    const h = harness(gated({ topTracksError: new SpotifyApiError(404, 'Not Found'), artistAlbumsError: new SpotifyApiError(404, 'Not Found') }));
    await assert.rejects(
      () => h.invoke('queue_playlist', { source_uri: 'spotify:artist:nope', mode: 'append' }),
      /Not Found/,
    );
    assert.equal(h.posts.length, 0, 'a missing artist must not queue an empty queue');
  });

  it('#1225 an unreadable top-tracks read is never reported as 0 top tracks', async () => {
    // The empty-but-200 answer DOES mean "the artist has no top tracks here",
    // so it walks the albums with no note. Only a failed read carries one --
    // that difference is the whole disclosure.
    const h = harness(gated({ topTracks: [] }));
    const out = await h.invoke('queue_playlist', { source_uri: 'spotify:artist:ar1', mode: 'append' });
    const structured = out.structuredContent as { resolved_via: string | null; note: string | null } | undefined;
    assert.equal(structured?.resolved_via, 'albums');
    assert.equal(structured?.note, null);
    assert.doesNotMatch(out.content[0].text, /top-tracks/);
  });

  it('#1225 a healthy top-tracks read reports top_tracks and no note', async () => {
    const h = harness({ topTracks: [track('tt1'), track('tt2')] });
    const out = await h.invoke('queue_playlist', { source_uri: 'spotify:artist:ar1', mode: 'append' });
    const structured = out.structuredContent as { resolved_via: string | null; note: string | null } | undefined;
    assert.equal(structured?.resolved_via, 'top_tracks');
    assert.equal(structured?.note, null);
    assert.equal(h.getCalls.includes('/artists/ar1/albums'), false, 'a healthy read must not pay for the fallback');
  });

  it('#1225 a non-artist source is untouched by the gating fallback', async () => {
    const h = harness({ playlistItems: [{ item: track('p1') }] });
    const out = await h.invoke('queue_playlist', { source_uri: 'spotify:playlist:pl1', mode: 'append' });
    const structured = out.structuredContent as { resolved_via: string | null; note: string | null } | undefined;
    assert.equal(structured?.resolved_via, null);
    assert.equal(structured?.note, null);
  });
  it('queue_playlist handles album source', async () => {
    const h = harness({ albumTracks: [track('al1'), track('al2')] });
    const out = await h.invoke('queue_playlist', { source_uri: 'spotify:album:alb1', mode: 'append' });
    assert.equal(h.posts.length, 2);
  });
  it('queue_playlist mode=replace refuses with ok:false (never silently appends)', async () => {
    const h = harness({ playlistItems: [{ item: track('a1') }] });
    const out = await h.invoke('queue_playlist', { source_uri: 'spotify:playlist:pl1', mode: 'replace' });
    assert.equal((out.structuredContent as any)?.ok, false);
    assert.match(out.content[0].text, /no.*queue-clear|replace cannot be honoured/i);
    assert.equal(h.posts.length, 0);
  });
  it('save_queue_as_playlist dry_run does not create playlist', async () => {
    const h = harness({ queueData: { currently_playing: track('cur'), queue: [track('q1')] } });
    const out = await h.invoke('save_queue_as_playlist', { name: 'My Queue', dry_run: true });
    assert.match(out.content[0].text, /dry run/i);
    assert.equal(h.posts.length, 0);
  });
  it('save_queue_as_playlist creates playlist and adds queue URIs', async () => {
    const h = harness({ queueData: { currently_playing: track('cur'), queue: [track('q1'), track('q2')] } });
    const out = await h.invoke('save_queue_as_playlist', { name: 'My Queue' });
    // First POST creates playlist, second POST adds items via /items (not legacy /tracks, #840).
    assert.ok(h.posts.some((p) => p.includes('/users/') && p.includes('/playlists')));
    assert.ok(h.posts.some((p) => p.includes('/items')));
    assert.ok(!h.posts.some((p) => p.includes('/playlists/') && p.includes('/tracks')), 'must not POST to legacy /playlists/{id}/tracks');
    assert.match(out.content[0].text, /Saved 3 items/);
    assert.equal((out.structuredContent as any)?.ok, true);
  });
  it('save_queue_as_playlist empty queue returns friendly message', async () => {
    const h = harness({ queueData: { currently_playing: null, queue: [] } });
    const out = await h.invoke('save_queue_as_playlist', { name: 'Empty' });
    assert.match(out.content[0].text, /Queue is empty/i);
    assert.equal((out.structuredContent as any)?.empty, true);
  });
  it('save_queue_as_playlist appends to target_playlist_id', async () => {
    const h = harness({ queueData: { currently_playing: track('cur'), queue: [track('q1')] } });
    const out = await h.invoke('save_queue_as_playlist', { target_playlist_id: 'existingPl' });
    // /items path (#840), not the retired /tracks.
    assert.ok(h.posts.some((p) => p.includes('existingPl/items')));
    assert.ok(!h.posts.some((p) => p.includes('existingPl/tracks')), 'must not POST to legacy /playlists/{id}/tracks');
    assert.match(out.content[0].text, /Appended 2 items/i);
  });
  it('batch_add_to_queue POSTs each URI and returns a summary', async () => {
    const h = harness();
    const out = await h.invoke('batch_add_to_queue', { uris: ['spotify:track:a1', 'spotify:track:a2', 'spotify:episode:e1'] });
    assert.equal(h.posts.length, 3);
    assert.match(out.content[0].text, /Queued 3/);
    assert.equal((out.structuredContent as any)?.ok, true);
  });
  it('batch_add_to_queue dry_run does not POST', async () => {
    const h = harness();
    const out = await h.invoke('batch_add_to_queue', { uris: ['spotify:track:a1'], dry_run: true });
    assert.match(out.content[0].text, /dry run/i);
    assert.equal(h.posts.length, 0);
  });
  it('batch_add_to_queue rejects invalid URIs', async () => {
    const h = harness();
    await assert.rejects(() => h.invoke('batch_add_to_queue', { uris: ['not-a-uri'] }), /Invalid Spotify track\/episode URI/);
  });
  it('save_queue_as_playlist include_episodes=false skips episodes', async () => {
    const h = harness({ queueData: { currently_playing: episode('ep1'), queue: [track('t1'), episode('ep2')] } });
    const out = await h.invoke('save_queue_as_playlist', { name: 'Tracks Only', include_episodes: false });
    // Should only save t1
    assert.equal((out.structuredContent as any)?.count, 1);
  });
  it('no registered tool POSTs/PUTs the retired /playlists/{id}/tracks (#840)', async () => {
    // Drive every registered handler with a minimal valid invocation; if any
    // of them writes through the legacy path, the harness throws 404 and the
    // outer promise rejects, failing this test.
    const h = harness();
    const minimal: Record<string, unknown> = {
      queue_playlist: { source_uri: 'spotify:playlist:pl1', mode: 'append' },
      save_queue_as_playlist: { name: 'X' },
      batch_add_to_queue: { uris: ['spotify:track:t1'] },
    };
    for (const r of h.registered) {
      const args = minimal[(r as any).name];
      if (!args) continue;
      await (r as any).handler(z.object((r as any).schema).parse(args));
    }
    const legacyPosts = h.posts.filter((p) => /\/playlists\/[^/]+\/tracks(\?|$)/.test(p));
    assert.deepEqual(legacyPosts, [], `legacy /playlists/{id}/tracks POST(s) detected: ${legacyPosts.join(', ')}`);
  });
});
