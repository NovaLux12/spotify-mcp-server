import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { registerQueueOpsTools } from '../src/tools/queueops.js';
import type { SpotifyClient } from '../src/client.js';

function track(id: string) { return { id, uri: `spotify:track:${id}`, name: `T ${id}`, type: 'track', duration_ms: 200000, artists: [{ id: 'a', name: 'A' }], album: { id: 'al', name: 'Al', uri: 'spotify:album:al' } } as any; }

function harness(overrides: Partial<{ playlistItems: any[]; albumTracks: any[]; topTracks: any[] }> = {}) {
  const registered: any[] = []; const posts: string[] = []; const puts: string[] = []; const dels: string[] = [];
  const fakeServer = { tool(name: string, _d: string, schema: any, handler: any) { registered.push({ name, schema, handler }); } } as unknown as McpServer;
  const client = {
    async get(path: string) {
      if (path.startsWith('/albums/')) return { items: overrides.albumTracks ?? [track('t1'), track('t2')], total: 2 } as any;
      if (path.includes('/top-tracks')) return { tracks: overrides.topTracks ?? [track('tt1')] } as any;
      return null;
    },
    async getAllPages(path: string) {
      if (path.includes('/playlists/')) return overrides.playlistItems ?? [{ item: track('p1') }, { item: track('p2') }];
      return [];
    },
    async post(path: string) { posts.push(path); return null; },
    async put(path: string) { puts.push(path); throw Object.assign(new Error('no endpoint'), { status: 404 }); },
    async delete(path: string) { dels.push(path); throw Object.assign(new Error('no endpoint'), { status: 404 }); },
  };
  registerQueueOpsTools(fakeServer, client as unknown as SpotifyClient);
  const find = (n: string) => registered.find((r: any) => r.name === n);
  const invoke = async (name: string, args: any) => {
    const t = find(name); assert.ok(t); const parsed = z.object(t.schema).parse(args); return t.handler(parsed);
  };
  return { registered, posts, puts, dels, invoke };
}

describe('queueops', () => {
  it('registers 4 tools', () => {
    const h = harness();
    assert.equal(h.registered.length, 4);
    assert.ok(h.registered.some((r: any) => r.name === 'queue_playlist'));
    assert.ok(h.registered.some((r: any) => r.name === 'queue_clear'));
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
  it('queue_reorder returns guidance on 404', async () => {
    const h = harness();
    const out = await h.invoke('queue_reorder', { uri: 'spotify:track:t1', position: 0 });
    assert.match(out.content[0].text, /no.*endpoint|guidance|clear\+rebuild/i);
  });
  it('queue_clear returns guidance', async () => {
    const h = harness();
    const out = await h.invoke('queue_clear', {});
    assert.match(out.content[0].text, /no.*endpoint|guidance|clear\+rebuild/i);
  });
});
