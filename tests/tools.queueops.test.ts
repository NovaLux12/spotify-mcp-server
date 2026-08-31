import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { registerQueueOpsTools } from '../src/tools/queueops.js';
import type { SpotifyClient } from '../src/client.js';

function track(id: string) { return { id, uri: `spotify:track:${id}`, name: `T ${id}`, type: 'track', duration_ms: 200000, artists: [{ id: 'a', name: 'A' }], album: { id: 'al', name: 'Al', uri: 'spotify:album:al' } } as any; }
function episode(id: string) { return { uri: `spotify:episode:${id}`, type: 'episode', id } as any; }

function harness(overrides: Partial<{
  playlistItems: any[]; albumTracks: any[]; topTracks: any[];
  queueData: any; meResponse: any; createPlaylistResponse: any;
}> = {}) {
  const registered: any[] = []; const posts: string[] = []; const postBodies: any[] = [];
  const fakeServer = { tool(name: string, _d: string, schema: any, handler: any) { registered.push({ name, schema, handler }); } } as unknown as McpServer;
  const client = {
    async get(path: string) {
      if (path === '/me/player/queue') return overrides.queueData ?? { currently_playing: track('cur'), queue: [track('q1'), track('q2')] };
      if (path === '/me' && overrides.meResponse) return overrides.meResponse;
      if (path === '/me') return { id: 'user123' } as any;
      if (path.startsWith('/albums/')) return { items: overrides.albumTracks ?? [track('t1'), track('t2')], total: 2 } as any;
      if (path.includes('/top-tracks')) return { tracks: overrides.topTracks ?? [track('tt1')] } as any;
      return null;
    },
    async getAllPages(path: string) {
      if (path.includes('/playlists/')) return overrides.playlistItems ?? [{ item: track('p1') }, { item: track('p2') }];
      return [];
    },
    async post(path: string, body?: any) {
      posts.push(path); postBodies.push(body);
      if (path.includes('/users/') && path.includes('/playlists')) {
        return (overrides.createPlaylistResponse ?? { id: 'newPlId', external_urls: { spotify: 'https://open.spotify.com/playlist/newPlId' }, snapshot_id: 'snap1' }) as any;
      }
      if (path.includes('/playlists/') && path.includes('/tracks')) return { snapshot_id: 'snap2' } as any;
      return null;
    },
    async put(path: string) { throw Object.assign(new Error('no endpoint'), { status: 404 }); },
    async delete(path: string) { throw Object.assign(new Error('no endpoint'), { status: 404 }); },
  };
  registerQueueOpsTools(fakeServer, client as unknown as SpotifyClient);
  const find = (n: string) => registered.find((r: any) => r.name === n);
  const invoke = async (name: string, args: any) => {
    const t = find(name); assert.ok(t, `tool ${name} not found`); const parsed = z.object(t.schema).parse(args); return t.handler(parsed);
  };
  return { registered, posts, postBodies, invoke };
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
    // First POST creates playlist, second POST adds tracks
    assert.ok(h.posts.some((p) => p.includes('/users/') && p.includes('/playlists')));
    assert.ok(h.posts.some((p) => p.includes('/tracks')));
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
    assert.ok(h.posts.some((p) => p.includes('existingPl/tracks')));
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
});
