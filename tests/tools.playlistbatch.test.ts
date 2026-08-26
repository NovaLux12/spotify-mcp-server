import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { SpotifyClient } from '../src/client.js';
import { registerPlaylistBatchTools } from '../src/tools/playlistbatch.js';
import type { SpotifyPaged } from '../src/types/spotify.js';
interface RecordedCall { method: string; path: string; arg?: unknown; }
type Responder = (path: string, arg: unknown, method?: string) => unknown;
interface RegisteredTool { name: string; description: string; validate: (args: Record<string, unknown>) => Record<string, unknown>; handler: (args: Record<string, unknown>) => Promise<{ content: Array<{ type: string; text: string }>; structuredContent?: Record<string, unknown> }>; }
function makeStubClient(responder: Responder) {
  const calls: RecordedCall[] = []; let respond: Responder = responder;
  const client = {
    calls, setResponder(fn: Responder) { respond = fn; },
    async get<T>(path: string, params?: Record<string, string>): Promise<T | null> { calls.push({ method: 'GET', path, arg: params }); return respond(path, params, 'GET') as T | null; },
    async post<T>(path: string, body?: unknown): Promise<T | null> { calls.push({ method: 'POST', path, arg: body }); return respond(path, body, 'POST') as T | null; },
    async put<T>(path: string, body?: unknown): Promise<T | null> { calls.push({ method: 'PUT', path, arg: body }); return respond(path, body) as T | null; },
    async putRaw(path: string, body: string): Promise<void> { calls.push({ method: 'PUT_RAW', path, arg: body }); },
    async delete<T>(path: string, body?: unknown): Promise<T | null> { calls.push({ method: 'DELETE', path, arg: body }); return respond(path, body) as T | null; },
    async getAllPages<T>(path: string, params?: Record<string, string>, opts?: { maxItems?: number; initialOffset?: number }): Promise<T[]> {
      const maxItems = opts?.maxItems ?? 500; const all: T[] = []; let offset = opts?.initialOffset ?? 0;
      for (;;) { const page = await this.get<SpotifyPaged<T>>(path, { ...params, offset: String(offset) }); if (!page || !Array.isArray(page.items)) break; all.push(...page.items); if (all.length >= maxItems) return all.slice(0, maxItems); const limit = typeof page.limit === 'number' && page.limit > 0 ? page.limit : page.items.length; offset += limit; if (page.items.length === 0 || page.items.length < limit) break; if (typeof page.total === 'number' && offset >= page.total) break; } return all;
    },
  }; return client;
}
function harness(responder: Responder = () => null, elicitResult?: unknown) {
  const registered: RegisteredTool[] = []; const fakeServer: Record<string, unknown> = {
    tool(name: string, desc: string, schema: z.ZodRawShape, handler: RegisteredTool['handler']) { registered.push({ name, description: desc, validate: (a) => z.object(schema).parse(a), handler }); },
    registerTool(name: string, config: { description?: string; inputSchema?: z.ZodType }, handler: RegisteredTool['handler']) { registered.push({ name, description: config.description ?? '', validate: (a) => (config.inputSchema as z.ZodType).parse(a), handler }); },
  };
  if (elicitResult !== undefined) { fakeServer.server = { getClientCapabilities: () => ({ elicitation: { form: {} } }) }; (fakeServer as Record<string, unknown>).elicitInput = async () => { if (elicitResult instanceof Error) throw elicitResult; return elicitResult; }; }
  const client = makeStubClient(responder);
  registerPlaylistBatchTools(fakeServer as unknown as McpServer, client as unknown as SpotifyClient);
  return { registered, client, invoke: async (name: string, args: Record<string, unknown>) => { const tool = registered.find((t) => t.name === name); assert.ok(tool, `tool "${name}" should be registered`); return tool.handler(tool.validate(args)); } };
}
const textOf = (out: { content: Array<{ text: string }> }) => out.content[0].text;
const track = (id: string) => `spotify:track:${id}`;
describe('batch_add_to_playlist', () => {
  it('dedupes within batch', async () => {
    const h = harness((_, _a, method) => { if (method === 'POST') return { snapshot_id: 'snap1' } as unknown; return { items: [], total: 0, limit: 100, offset: 0, next: null } as unknown; });
    const out = await h.invoke('batch_add_to_playlist', { target_playlist_id: 'target', source_uris: [track('A'), track('A'), track('B')] });
    const posts = h.client.calls.filter((c) => c.method === 'POST'); assert.equal(posts.length, 1); assert.deepEqual((posts[0].arg as { uris: string[] }).uris, [track('A'), track('B')]); assert.match(textOf(out), /Added 2 track/);
  });
  it('dedupes against existing target', async () => {
    let getCount = 0;
    const h = harness((path, _a, method) => {
      if (method === 'POST') return { snapshot_id: 'snap1' } as unknown;
      if (path.includes('/playlists/target/items')) { getCount++; if (getCount <= 2) return { items: [{ added_at: 'x', item: { id: 'A', uri: track('A'), type: 'track', name: 't', duration_ms: 100, artists: [{ name: 'x' }], album: { id: 'al', name: 'al', uri: 'spotify:album:al', images: [] } } }], total: 1, limit: 100, offset: 0, next: null } as unknown; return { items: [], total: 1, limit: 100, offset: 0, next: null } as unknown; }
      return { items: [], total: 0, limit: 100, offset: 0, next: null } as unknown;
    });
    const out = await h.invoke('batch_add_to_playlist', { target_playlist_id: 'target', source_uris: [track('A'), track('B')] });
    const posts = h.client.calls.filter((c) => c.method === 'POST'); assert.equal(posts.length, 1); assert.deepEqual((posts[0].arg as { uris: string[] }).uris, [track('B')]); assert.match(textOf(out), /1 track/);
  });
  it('dry_run previews without POSTing', async () => {
    const h = harness(() => ({ items: [], total: 0, limit: 100, offset: 0, next: null } as unknown));
    const out = await h.invoke('batch_add_to_playlist', { target_playlist_id: 'target', source_uris: [track('X'), track('Y')], dry_run: true });
    assert.equal(h.client.calls.filter((c) => c.method === 'POST').length, 0); assert.match(textOf(out), /\[dry run\]/);
  });
  it('elicits for 100+ tracks and honours decline', async () => {
    const many = Array.from({ length: 101 }, (_, i) => track(`t${i}`));
    const h = harness((_, _a, method) => { if (method === 'POST') return { snapshot_id: 's' } as unknown; return { items: [], total: 0, limit: 100, offset: 0, next: null } as unknown; }, { action: 'accept', content: { confirm: false } } as unknown);
    const out = await h.invoke('batch_add_to_playlist', { target_playlist_id: 'target', source_uris: many });
    assert.match(textOf(out), /Cancelled/); assert.equal(h.client.calls.filter((c) => c.method === 'POST').length, 0);
  });
  it('under threshold does not elicit', async () => {
    const h = harness((_, _a, method) => { if (method === 'POST') return { snapshot_id: 's' } as unknown; return { items: [], total: 0, limit: 100, offset: 0, next: null } as unknown; });
    const out = await h.invoke('batch_add_to_playlist', { target_playlist_id: 'target', source_uris: [track('A')] });
    assert.equal(h.client.calls.filter((c) => c.method === 'POST').length, 1); assert.match(textOf(out), /Added 1/);
  });
});
describe('copy_playlist', () => {
  it('preserves track order when copying', async () => {
    const order = [track('C'), track('A'), track('B')];
    const h = harness((path, _a, method) => {
      if (method === 'POST' && path === '/me/playlists') return { id: 'new123', uri: 'spotify:playlist:new123', external_urls: { spotify: 'https://open.spotify.com/playlist/new123' } } as unknown;
      if (method === 'POST' && path.includes('/playlists/new123/items')) return { snapshot_id: 'snap' } as unknown;
      if (path === '/playlists/src1') return { id: 'src1', name: 'Source One', description: 'desc' } as unknown;
      if (path.includes('/playlists/src1/items')) return { items: order.map((uri) => ({ added_at: 'x', item: { id: uri.split(':').pop()!, uri, type: 'track', name: uri, duration_ms: 100, artists: [{ name: 'a' }], album: { id: 'al', name: 'al', uri: 'spotify:album:al', images: [] } } })), total: 3, limit: 100, offset: 0, next: null } as unknown;
      if (path.includes('/playlists/new123/items')) return { items: order.map((uri) => ({ added_at: 'x', item: { id: uri.split(':').pop()!, uri, type: 'track', name: uri, duration_ms: 100, artists: [{ name: 'a' }], album: { id: 'al', name: 'al', uri: 'spotify:album:al', images: [] } } })), total: 3, limit: 100, offset: 0, next: null } as unknown;
      return { items: [], total: 0, limit: 100, offset: 0, next: null } as unknown;
    });
    const out = await h.invoke('copy_playlist', { source_playlist_id: 'src1', new_name: 'Copy One' });
    const posts = h.client.calls.filter((c) => c.method === 'POST' && (c.path as string).includes('/playlists/new123/items')); assert.equal(posts.length, 1); assert.deepEqual((posts[0].arg as { uris: string[] }).uris, order); assert.match(textOf(out), /Copied playlist/);
  });
  it('dry_run reports track count without creating', async () => {
    const h = harness((path) => {
      if (path === '/playlists/src1') return { id: 'src1', name: 'Source One', description: null } as unknown;
      if (path.includes('/playlists/src1/items')) return { items: [{ added_at: 'x', item: { id: 't1', uri: track('t1'), type: 'track', name: 't1', duration_ms: 100, artists: [{ name: 'a' }], album: { id: 'al', name: 'al', uri: 'spotify:album:al', images: [] } } }], total: 1, limit: 100, offset: 0, next: null } as unknown;
      return { items: [], total: 0, limit: 100, offset: 0, next: null } as unknown;
    });
    const out = await h.invoke('copy_playlist', { source_playlist_id: 'src1', new_name: 'Copy One', dry_run: true });
    assert.equal(h.client.calls.filter((c) => c.method === 'POST').length, 0); assert.match(textOf(out), /\[dry run\]/);
  });
});
describe('move_items_between_playlists', () => {
  it('mode copy adds without removing', async () => {
    const srcUris = [track('A'), track('B')];
    const h = harness((path, _a, method) => {
      if (method === 'POST') return { snapshot_id: 'sAdd' } as unknown;
      if (method === 'DELETE') throw new Error('should not delete in copy mode');
      if (path.includes('/playlists/src/items')) return { items: srcUris.map((uri) => ({ added_at: 'x', item: { id: uri.split(':').pop()!, uri, type: 'track', name: uri, duration_ms: 100, artists: [{ name: 'a' }], album: { id: 'al', name: 'al', uri: 'spotify:album:al', images: [] } } })), total: 2, limit: 100, offset: 0, next: null } as unknown;
      if (path.includes('/playlists/tgt/items')) return { items: [], total: 0, limit: 100, offset: 0, next: null } as unknown;
      return { items: [], total: 0, limit: 100, offset: 0, next: null } as unknown;
    });
    const out = await h.invoke('move_items_between_playlists', { source_playlist_id: 'src', target_playlist_id: 'tgt', mode: 'copy' });
    assert.match(textOf(out), /Copied 2/); assert.equal(h.client.calls.filter((c) => c.method === 'DELETE').length, 0);
  });
  it('mode move removes after adding', async () => {
    const srcUris = [track('A'), track('B')];
    const h = harness((path, _a, method) => {
      if (method === 'POST') return { snapshot_id: 'sAdd' } as unknown;
      if (method === 'DELETE') return { snapshot_id: 'sDel' } as unknown;
      if (path.includes('/playlists/src/items')) return { items: srcUris.map((uri) => ({ added_at: 'x', item: { id: uri.split(':').pop()!, uri, type: 'track', name: uri, duration_ms: 100, artists: [{ name: 'a' }], album: { id: 'al', name: 'al', uri: 'spotify:album:al', images: [] } } })), total: 2, limit: 100, offset: 0, next: null } as unknown;
      if (path.includes('/playlists/tgt/items')) return { items: [], total: 0, limit: 100, offset: 0, next: null } as unknown;
      return { items: [], total: 0, limit: 100, offset: 0, next: null } as unknown;
    });
    const out = await h.invoke('move_items_between_playlists', { source_playlist_id: 'src', target_playlist_id: 'tgt', mode: 'move' });
    assert.match(textOf(out), /Moved 2/); assert.equal(h.client.calls.filter((c) => c.method === 'DELETE').length, 1);
  });
  it('empty source returns gracefully', async () => {
    const h = harness((path) => { if (path.includes('/playlists/src/items')) return { items: [], total: 0, limit: 100, offset: 0, next: null } as unknown; return { items: [], total: 0, limit: 100, offset: 0, next: null } as unknown; });
    const out = await h.invoke('move_items_between_playlists', { source_playlist_id: 'src', target_playlist_id: 'tgt', mode: 'copy' });
    assert.match(textOf(out), /is empty/);
  });
  it('elicits for >50 and honours decline', async () => {
    const many = Array.from({ length: 55 }, (_, i) => track(`m${i}`));
    const h = harness((path, _a, method) => {
      if (method === 'POST' || method === 'DELETE') return { snapshot_id: 's' } as unknown;
      if (path.includes('/playlists/src/items')) return { items: many.map((uri) => ({ added_at: 'x', item: { id: uri.split(':').pop()!, uri, type: 'track', name: uri, duration_ms: 100, artists: [{ name: 'a' }], album: { id: 'al', name: 'al', uri: 'spotify:album:al', images: [] } } })), total: 55, limit: 100, offset: 0, next: null } as unknown;
      if (path.includes('/playlists/tgt/items')) return { items: [], total: 0, limit: 100, offset: 0, next: null } as unknown;
      return { items: [], total: 0, limit: 100, offset: 0, next: null } as unknown;
    }, { action: 'accept', content: { confirm: false } });
    const out = await h.invoke('move_items_between_playlists', { source_playlist_id: 'src', target_playlist_id: 'tgt', mode: 'copy' });
    assert.match(textOf(out), /Cancelled/);
  });
  it('filter only transfers matching', async () => {
    const h = harness((path, _a, method) => {
      if (method === 'POST') return { snapshot_id: 's' } as unknown;
      if (path.includes('/playlists/src/items')) return { items: [{ added_at: 'x', item: { id: '1', uri: track('1'), type: 'track', name: 'Hello World', duration_ms: 100, artists: [{ name: 'Alice' }], album: { id: 'al', name: 'al', uri: 'spotify:album:al', images: [] } } }, { added_at: 'x', item: { id: '2', uri: track('2'), type: 'track', name: 'Goodbye', duration_ms: 100, artists: [{ name: 'Bob' }], album: { id: 'al', name: 'al', uri: 'spotify:album:al', images: [] } } }], total: 2, limit: 100, offset: 0, next: null } as unknown;
      if (path.includes('/playlists/tgt/items')) return { items: [], total: 0, limit: 100, offset: 0, next: null } as unknown;
      return { items: [], total: 0, limit: 100, offset: 0, next: null } as unknown;
    });
    const out = await h.invoke('move_items_between_playlists', { source_playlist_id: 'src', target_playlist_id: 'tgt', mode: 'copy', filter: 'alice' });
    const posts = h.client.calls.filter((c) => c.method === 'POST'); assert.equal(posts.length, 1); assert.deepEqual((posts[0].arg as { uris: string[] }).uris, [track('1')]);
  });
});
