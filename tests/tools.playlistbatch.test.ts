import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { SpotifyApiError, type SpotifyClient } from '../src/client.js';
import { expandAlbumToTracks, registerPlaylistBatchTools } from '../src/tools/playlistbatch.js';
import { installGatedPathContract } from '../src/gating.js';
import { initConfig } from '../src/config.js';
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
  if (elicitResult !== undefined) { fakeServer.server = { getClientCapabilities: () => ({ elicitation: { form: {} } }), elicitInput: async () => { if (elicitResult instanceof Error) throw elicitResult; return elicitResult; } } as unknown as typeof fakeServer.server; }
  const client = makeStubClient(responder);
  registerPlaylistBatchTools(fakeServer as unknown as McpServer, client as unknown as SpotifyClient);
  return { registered, client, invoke: async (name: string, args: Record<string, unknown>) => { const tool = registered.find((t) => t.name === name); assert.ok(tool, `tool "${name}" should be registered`); return tool.handler(tool.validate(args)); } };
}
const textOf = (out: { content: Array<{ text: string }> }) => out.content[0].text;
const track = (id: string) => `spotify:track:${id}`;
const TARGET = 'T'.repeat(22);
const COPY_SOURCE = 'S'.repeat(22);
const MOVE_SOURCE = 'M'.repeat(22);
const MOVE_TARGET = 'V'.repeat(22);


describe('album source expansion', () => {
  it('returns only validated track URIs and respects the requested bound', async () => {
    const firstTrackId = '1'.repeat(22);
    const secondTrackId = '2'.repeat(22);
    const h = harness((path) => path === '/albums/a1/tracks' ? {
      items: [
        { uri: track(firstTrackId) },
        { uri: track(secondTrackId) },
        { uri: null, is_playable: false },
        { uri: 'spotify:track:blocked', is_playable: false },
        { uri: 'spotify:episode:e1' },
        { uri: 'spotify:album:a1' },
      ],
      total: 6,
      limit: 50,
      offset: 0,
      next: null,
    } : { items: [], total: 0, limit: 50, offset: 0, next: null });
    const uris = await expandAlbumToTracks(h.client as unknown as SpotifyClient, { id: 'a1', name: 'Album' }, 2);
    assert.deepEqual(uris, [track(firstTrackId), track(secondTrackId)]);
    const read = h.client.calls.find((call) => call.method === 'GET' && call.path === '/albums/a1/tracks');
    assert.deepEqual(read?.arg, { limit: '50', offset: '0' });
  });

  it('resolves an album source to track URIs before batch_add_to_playlist posts', async () => {
    const h = harness((path, _arg, method) => {
      if (method === 'POST') return { snapshot_id: 'snap' };
      if (path === '/albums/a1/tracks') {
        return { items: [{ uri: track('t1') }, { uri: null, is_playable: false }, { uri: track('t2') }], total: 3, limit: 50, offset: 0, next: null };
      }
      return { items: [], total: 0, limit: 100, offset: 0, next: null };
    });
    await h.invoke('batch_add_to_playlist', { target_playlist_id: TARGET, source_uris: ['spotify:album:a1'] });
    const add = h.client.calls.find((call) => call.method === 'POST' && call.path === `/playlists/${TARGET}/items`);
    assert.deepEqual((add?.arg as { uris: string[] }).uris, [track('t1'), track('t2')]);
  });

  it('does not post when an album source has no playable tracks', async () => {
    const h = harness((path) => path === '/albums/a1/tracks'
      ? { items: [{ uri: null, is_playable: false, restrictions: { reason: 'market' } }], total: 1, limit: 50, offset: 0, next: null }
      : { items: [], total: 0, limit: 100, offset: 0, next: null });
    const result = await h.invoke('batch_add_to_playlist', { target_playlist_id: TARGET, source_uris: ['spotify:album:a1'] });
    assert.match(textOf(result), /No tracks resolved/);
    assert.equal(h.client.calls.some((call) => call.method === 'POST'), false);
  });
});
describe('batch_add_to_playlist', () => {
  it('dedupes within batch', async () => {
    const h = harness((_, _a, method) => { if (method === 'POST') return { snapshot_id: 'snap1' } as unknown; return { items: [], total: 0, limit: 100, offset: 0, next: null } as unknown; });
    const out = await h.invoke('batch_add_to_playlist', { target_playlist_id: TARGET, source_uris: [track('A'), track('A'), track('B')] });
    const posts = h.client.calls.filter((c) => c.method === 'POST'); assert.equal(posts.length, 1); assert.deepEqual((posts[0].arg as { uris: string[] }).uris, [track('A'), track('B')]); assert.match(textOf(out), /Added 2 track/);
  });
  it('dedupes against existing target', async () => {
    let getCount = 0;
    const h = harness((path, _a, method) => {
      if (method === 'POST') return { snapshot_id: 'snap1' } as unknown;
      if (path === `/playlists/${TARGET}/items`) { getCount++; if (getCount <= 2) return { items: [{ added_at: 'x', item: { id: 'A', uri: track('A'), type: 'track', name: 't', duration_ms: 100, artists: [{ name: 'x' }], album: { id: 'al', name: 'al', uri: 'spotify:album:al', images: [] } } }], total: 1, limit: 100, offset: 0, next: null } as unknown; return { items: [], total: 1, limit: 100, offset: 0, next: null } as unknown; }
      return { items: [], total: 0, limit: 100, offset: 0, next: null } as unknown;
    });
    const out = await h.invoke('batch_add_to_playlist', { target_playlist_id: TARGET, source_uris: [track('A'), track('B')] });
    const posts = h.client.calls.filter((c) => c.method === 'POST'); assert.equal(posts.length, 1); assert.deepEqual((posts[0].arg as { uris: string[] }).uris, [track('B')]); assert.match(textOf(out), /1 track/);
  });
  it('dry_run previews without POSTing', async () => {
    const h = harness(() => ({ items: [], total: 0, limit: 100, offset: 0, next: null } as unknown));
    const out = await h.invoke('batch_add_to_playlist', { target_playlist_id: TARGET, source_uris: [track('X'), track('Y')], dry_run: true });
    assert.equal(h.client.calls.filter((c) => c.method === 'POST').length, 0); assert.match(textOf(out), /\[dry run\]/);
  });
  it('elicits for 100+ tracks and honours decline', async () => {
    const many = Array.from({ length: 101 }, (_, i) => track(`t${i}`));
    const h = harness((_, _a, method) => { if (method === 'POST') return { snapshot_id: 's' } as unknown; return { items: [], total: 0, limit: 100, offset: 0, next: null } as unknown; }, { action: 'accept', content: { confirm: false } } as unknown);
    const out = await h.invoke('batch_add_to_playlist', { target_playlist_id: TARGET, source_uris: many });
    assert.match(textOf(out), /Cancelled/); assert.equal(h.client.calls.filter((c) => c.method === 'POST').length, 0);
  });
  it('under threshold does not elicit', async () => {
    const h = harness((_, _a, method) => { if (method === 'POST') return { snapshot_id: 's' } as unknown; return { items: [], total: 0, limit: 100, offset: 0, next: null } as unknown; });
    const out = await h.invoke('batch_add_to_playlist', { target_playlist_id: TARGET, source_uris: [track('A')] });
    assert.equal(h.client.calls.filter((c) => c.method === 'POST').length, 1); assert.match(textOf(out), /Added 1/);
  });
  it('canonicalizes direct spotify:// track and episode links before posting', async () => {
    const trackId = '1'.repeat(22);
    const episodeId = '2'.repeat(22);
    const h = harness((_, _a, method) => {
      if (method === 'POST') return { snapshot_id: 'snap-links' } as unknown;
      return { items: [], total: 0, limit: 100, offset: 0, next: null } as unknown;
    });
    await h.invoke('batch_add_to_playlist', {
      target_playlist_id: TARGET,
      source_uris: [`spotify://track/${trackId}`, `spotify://episode/${episodeId}`],
    });
    const add = h.client.calls.find((call) => call.method === 'POST' && call.path === `/playlists/${TARGET}/items`);
    assert.deepEqual(add?.arg, { uris: [`spotify:track:${trackId}`, `spotify:episode:${episodeId}`] });
  });

  // #864: batch_add_to_playlist advertises dedupe "against the existing
  // playlist", but the target read is capped — a URI parked past the cap
  // looks absent and gets re-added, and the commit result said nothing about
  // the coverage that produced the answer.
  describe('capped target walks are disclosed (#864)', () => {
    const bigTarget = (count: number) =>
      Array.from({ length: count }, (_, i) => ({ item: { uri: track(`p${i}`) } }));

    it('reports the short target walk and re-adds a URI the cap could not see', async () => {
      const h = harness((path, _a, method) => {
        if (method === 'POST') return { snapshot_id: 'snap' } as unknown;
        if (path === `/playlists/${TARGET}/items`) {
          return { items: bigTarget(600), total: 600, limit: 100, offset: 0, next: null } as unknown;
        }
        return { items: [], total: 0, limit: 100, offset: 0, next: null } as unknown;
      });

      const out = await h.invoke('batch_add_to_playlist', {
        target_playlist_id: TARGET,
        source_uris: [track('p550')],
      });
      const p = out.structuredContent as Record<string, unknown>;

      assert.equal(p.target_truncated, true);
      assert.equal(p.scan_cap, 500);
      assert.match(textOf(out), /TRUNCATED/);
      // p550 sits at position 550, past the cap — the guard could not see it.
      const post = h.client.calls.find((c) => c.method === 'POST' && c.path === `/playlists/${TARGET}/items`);
      assert.deepEqual((post?.arg as { uris: string[] }).uris, [track('p550')]);
    });

    it('the dry run discloses it before anything is written', async () => {
      const h = harness((path) => {
        if (path === `/playlists/${TARGET}/items`) {
          return { items: bigTarget(600), total: 600, limit: 100, offset: 0, next: null } as unknown;
        }
        return { items: [], total: 0, limit: 100, offset: 0, next: null } as unknown;
      });

      const out = await h.invoke('batch_add_to_playlist', {
        target_playlist_id: TARGET,
        source_uris: [track('p550')],
        dry_run: true,
      });
      const p = out.structuredContent as Record<string, unknown>;

      assert.equal(h.client.calls.filter((c) => c.method === 'POST').length, 0);
      assert.equal(p.target_truncated, true);
      assert.match(textOf(out), /TRUNCATED/);
    });

    it('stays quiet when the target walk reads the whole playlist', async () => {
      const h = harness((path, _a, method) => {
        if (method === 'POST') return { snapshot_id: 'snap' } as unknown;
        if (path === `/playlists/${TARGET}/items`) {
          return { items: bigTarget(3), total: 3, limit: 100, offset: 0, next: null } as unknown;
        }
        return { items: [], total: 0, limit: 100, offset: 0, next: null } as unknown;
      });

      const out = await h.invoke('batch_add_to_playlist', {
        target_playlist_id: TARGET,
        source_uris: [track('p1')],
      });
      const p = out.structuredContent as Record<string, unknown>;

      assert.equal(p.target_truncated, false);
      assert.doesNotMatch(textOf(out), /TRUNCATED/);
    });
  });

  // #729: the receipt's `after` is the playlist's actual item count after the
  // add, not a count of matched rows inside the verification walk. On a
  // playlist larger than PLAYLIST_ITEM_PAGES_CAP * 100, fresh appends sit
  // past the cap and the pre-fix value reads 0 even though the add landed.
  describe('large-playlist add receipt reports actual total (#729)', () => {
    it('the receipt renders `after` equal to the post-add playlist size, not 0', async () => {
      // 13 source tracks committed to a 600-track target. The verification
      // walk caps at 5×100=500, so the 13 fresh rows are off-window — pre-fix
      // the receipt printed `after: 0` even though the add succeeded.
      const added = Array.from({ length: 13 }, (_, i) => track(`q${i}`));
      const targetRows = (count: number) =>
        Array.from({ length: count }, (_, i) => ({ item: { uri: track(`old${i}`) } }));
      const h = harness((path, _a, method) => {
        if (method === 'POST') return { snapshot_id: 'snap-729' } as unknown;
        if (path === `/playlists/${TARGET}/items`) {
          // Every verification page reports the full post-add total (613)
          // and a non-empty `next`, so the walk runs all 5 cap pages.
          return { items: targetRows(100), total: 613, limit: 100, offset: 0, next: '/playlists/' + TARGET + '/items?offset=100' } as unknown;
        }
        return { items: [], total: 0, limit: 100, offset: 0, next: null } as unknown;
      });

      const out = await h.invoke('batch_add_to_playlist', {
        target_playlist_id: TARGET,
        source_uris: added,
      });
      const p = out.structuredContent as Record<string, unknown>;
      const receipt = p.receipt as Record<string, unknown>;

      assert.equal(receipt.after, 613, 'receipt after should be the actual playlist total, not the walk-window count');
      assert.equal(receipt.windowExceeded, true);
      // Rendered prose mirrors the structured value, so the host sees the
      // honest number rather than the misleading zero.
      assert.match(textOf(out), /items before\/after: \?\/613/);
    });
  });
});

describe('copy_playlist', () => {
  it('preserves track order when copying', async () => {
    const order = [track('C'), track('A'), track('B')];
    const h = harness((path, _a, method) => {
      if (method === 'POST' && path === '/me/playlists') return { id: 'new123', uri: 'spotify:playlist:new123', external_urls: { spotify: 'https://open.spotify.com/playlist/new123' } } as unknown;
      if (method === 'POST' && path.includes('/playlists/new123/items')) return { snapshot_id: 'snap' } as unknown;
      if (path === `/playlists/${COPY_SOURCE}`) return { id: COPY_SOURCE, name: 'Source One', description: 'desc' } as unknown;
      if (path === `/playlists/${COPY_SOURCE}/items`) return { items: order.map((uri) => ({ added_at: 'x', item: { id: uri.split(':').pop()!, uri, type: 'track', name: uri, duration_ms: 100, artists: [{ name: 'a' }], album: { id: 'al', name: 'al', uri: 'spotify:album:al', images: [] } } })), total: 3, limit: 100, offset: 0, next: null } as unknown;
      if (path.includes('/playlists/new123/items')) return { items: order.map((uri) => ({ added_at: 'x', item: { id: uri.split(':').pop()!, uri, type: 'track', name: uri, duration_ms: 100, artists: [{ name: 'a' }], album: { id: 'al', name: 'al', uri: 'spotify:album:al', images: [] } } })), total: 3, limit: 100, offset: 0, next: null } as unknown;
      return { items: [], total: 0, limit: 100, offset: 0, next: null } as unknown;
    });
    const out = await h.invoke('copy_playlist', { source_playlist_id: COPY_SOURCE, new_name: 'Copy One' });
    const posts = h.client.calls.filter((c) => c.method === 'POST' && (c.path as string).includes('/playlists/new123/items')); assert.equal(posts.length, 1); assert.deepEqual((posts[0].arg as { uris: string[] }).uris, order); assert.match(textOf(out), /Copied playlist/);
  });
  it('dry_run reports track count without creating', async () => {
    const h = harness((path) => {
      if (path === `/playlists/${COPY_SOURCE}`) return { id: COPY_SOURCE, name: 'Source One', description: null } as unknown;
      if (path === `/playlists/${COPY_SOURCE}/items`) return { items: [{ added_at: 'x', item: { id: 't1', uri: track('t1'), type: 'track', name: 't1', duration_ms: 100, artists: [{ name: 'a' }], album: { id: 'al', name: 'al', uri: 'spotify:album:al', images: [] } } }], total: 1, limit: 100, offset: 0, next: null } as unknown;
      return { items: [], total: 0, limit: 100, offset: 0, next: null } as unknown;
    });
    const out = await h.invoke('copy_playlist', { source_playlist_id: COPY_SOURCE, new_name: 'Copy One', dry_run: true });
    assert.equal(h.client.calls.filter((c) => c.method === 'POST').length, 0); assert.match(textOf(out), /\[dry run\]/);
  });
});
describe('move_items_between_playlists', () => {
  it('mode copy adds without removing', async () => {
    const srcUris = [track('A'), track('B')];
    const h = harness((path, _a, method) => {
      if (method === 'POST') return { snapshot_id: 'sAdd' } as unknown;
      if (method === 'DELETE') throw new Error('should not delete in copy mode');
      if (path === `/playlists/${MOVE_SOURCE}/items`) return { items: srcUris.map((uri) => ({ added_at: 'x', item: { id: uri.split(':').pop()!, uri, type: 'track', name: uri, duration_ms: 100, artists: [{ name: 'a' }], album: { id: 'al', name: 'al', uri: 'spotify:album:al', images: [] } } })), total: 2, limit: 100, offset: 0, next: null } as unknown;
      if (path === `/playlists/${MOVE_TARGET}/items`) return { items: [], total: 0, limit: 100, offset: 0, next: null } as unknown;
      return { items: [], total: 0, limit: 100, offset: 0, next: null } as unknown;
    });
    const out = await h.invoke('move_items_between_playlists', { source_playlist_id: MOVE_SOURCE, target_playlist_id: MOVE_TARGET, mode: 'copy' });
    assert.match(textOf(out), /Copied 2/); assert.equal(h.client.calls.filter((c) => c.method === 'DELETE').length, 0);
  });
  it('mode move removes after adding', async () => {
    const srcUris = [track('A'), track('B')];
    const h = harness((path, _a, method) => {
      if (method === 'POST') return { snapshot_id: 'sAdd' } as unknown;
      if (method === 'DELETE') return { snapshot_id: 'sDel' } as unknown;
      if (path === `/playlists/${MOVE_SOURCE}/items`) return { items: srcUris.map((uri) => ({ added_at: 'x', item: { id: uri.split(':').pop()!, uri, type: 'track', name: uri, duration_ms: 100, artists: [{ name: 'a' }], album: { id: 'al', name: 'al', uri: 'spotify:album:al', images: [] } } })), total: 2, limit: 100, offset: 0, next: null } as unknown;
      if (path === `/playlists/${MOVE_TARGET}/items`) return { items: [], total: 0, limit: 100, offset: 0, next: null } as unknown;
      return { items: [], total: 0, limit: 100, offset: 0, next: null } as unknown;
    });
    const out = await h.invoke('move_items_between_playlists', { source_playlist_id: MOVE_SOURCE, target_playlist_id: MOVE_TARGET, mode: 'move' });
    assert.match(textOf(out), /Moved 2/); assert.equal(h.client.calls.filter((c) => c.method === 'DELETE').length, 1);
  });
  it('empty source returns gracefully', async () => {
    const h = harness((path) => { if (path === `/playlists/${MOVE_SOURCE}/items`) return { items: [], total: 0, limit: 100, offset: 0, next: null } as unknown; return { items: [], total: 0, limit: 100, offset: 0, next: null } as unknown; });
    const out = await h.invoke('move_items_between_playlists', { source_playlist_id: MOVE_SOURCE, target_playlist_id: MOVE_TARGET, mode: 'copy' });
    assert.match(textOf(out), /is empty/);
  });
  it('elicits for >50 and honours decline', async () => {
    const many = Array.from({ length: 55 }, (_, i) => track(`m${i}`));
    const h = harness((path, _a, method) => {
      if (method === 'POST' || method === 'DELETE') return { snapshot_id: 's' } as unknown;
      if (path === `/playlists/${MOVE_SOURCE}/items`) return { items: many.map((uri) => ({ added_at: 'x', item: { id: uri.split(':').pop()!, uri, type: 'track', name: uri, duration_ms: 100, artists: [{ name: 'a' }], album: { id: 'al', name: 'al', uri: 'spotify:album:al', images: [] } } })), total: 55, limit: 100, offset: 0, next: null } as unknown;
      if (path === `/playlists/${MOVE_TARGET}/items`) return { items: [], total: 0, limit: 100, offset: 0, next: null } as unknown;
      return { items: [], total: 0, limit: 100, offset: 0, next: null } as unknown;
    }, { action: 'accept', content: { confirm: false } });
    const out = await h.invoke('move_items_between_playlists', { source_playlist_id: MOVE_SOURCE, target_playlist_id: MOVE_TARGET, mode: 'copy' });
    assert.match(textOf(out), /Cancelled/);
  });
  it('filter only transfers matching', async () => {
    const h = harness((path, _a, method) => {
      if (method === 'POST') return { snapshot_id: 's' } as unknown;
      if (path === `/playlists/${MOVE_SOURCE}/items`) return { items: [{ added_at: 'x', item: { id: '1', uri: track('1'), type: 'track', name: 'Hello World', duration_ms: 100, artists: [{ name: 'Alice' }], album: { id: 'al', name: 'al', uri: 'spotify:album:al', images: [] } } }, { added_at: 'x', item: { id: '2', uri: track('2'), type: 'track', name: 'Goodbye', duration_ms: 100, artists: [{ name: 'Bob' }], album: { id: 'al', name: 'al', uri: 'spotify:album:al', images: [] } } }], total: 2, limit: 100, offset: 0, next: null } as unknown;
      if (path === `/playlists/${MOVE_TARGET}/items`) return { items: [], total: 0, limit: 100, offset: 0, next: null } as unknown;
      return { items: [], total: 0, limit: 100, offset: 0, next: null } as unknown;
    });
    const out = await h.invoke('move_items_between_playlists', { source_playlist_id: MOVE_SOURCE, target_playlist_id: MOVE_TARGET, mode: 'copy', filter: 'alice' });
    const posts = h.client.calls.filter((c) => c.method === 'POST'); assert.equal(posts.length, 1); assert.deepEqual((posts[0].arg as { uris: string[] }).uris, [track('1')]);
  });
});

// #867: per-source resolution failures were collapsed into a single
// `skipped++` counter and the artist top-tracks market was hardcoded to 'US',
// so a region-locked album, a gated artist endpoint, and a genuinely empty
// source all looked the same on the wire. The fix replaces `skipped++` with
// a `failed[]` list (typed by source and reason) and switches the artist
// market to `resolveRequestMarket`'s caller resolution.
describe('batch_add_to_playlist distinguishes per-source failures (#867)', () => {
  // The `batch_add_to_playlist` tool surfaces market on its result; install
  // the gated-path wrapper so the harness recognises a 403 on artist
  // top-tracks as gated (production installs it from src/index.ts).
  function gatedHarness(responder: Responder): ReturnType<typeof harness> {
    const h = harness(responder);
    installGatedPathContract(h.client as unknown as SpotifyClient);
    return h;
  }

  it('reports a region-locked album as `unplayable`, distinct from a generic empty source', async () => {
    // `expandAlbumToTracks` filters to playable rows and returns [] when every
    // track is blocked; the follow-up probe checks whether rows were present
    // but unplayable, so an album that exists but is unavailable in the
    // caller's market surfaces as `unplayable` rather than `empty` (#867).
    const albumId = 'a'.repeat(22);
    const h = gatedHarness((path, _a, method) => {
      if (method === 'POST') return { snapshot_id: 's' } as unknown;
      if (path === `/playlists/${TARGET}/items`) return { items: [], total: 0, limit: 100, offset: 0, next: null } as unknown;
      if (path === `/albums/${albumId}/tracks`) {
        // First call: the full probe (limit=50) — every row is unplayable.
        const arg = (_a as { limit?: string } | undefined)?.limit;
        if (arg === '50') {
          return { items: [{ uri: null, is_playable: false, restrictions: { reason: 'market' } }, { uri: null, is_playable: false }], total: 2, limit: 50, offset: 0, next: null } as unknown;
        }
        // Second call: the unplayable probe (limit=1) — at least one row exists.
        return { items: [{ uri: null, is_playable: false, restrictions: { reason: 'market' } }], total: 1, limit: 1, offset: 0, next: null } as unknown;
      }
      return { items: [], total: 0, limit: 100, offset: 0, next: null } as unknown;
    });
    const out = await h.invoke('batch_add_to_playlist', {
      target_playlist_id: TARGET,
      source_uris: [`spotify:album:${albumId}`],
    });
    const p = out.structuredContent as Record<string, unknown>;
    const failed = p.failed as Array<{ source: string; type: string; reason: string }>;
    assert.equal(failed.length, 1);
    assert.equal(failed[0].type, 'album');
    assert.equal(failed[0].reason, 'unplayable');
    assert.deepEqual(p.failed_per_source, { album: 1, artist: 0, playlist: 0 });
    assert.match(textOf(out), /region-locked/);
  });

  it('reports a genuinely empty album as `empty`, distinct from region-locked', async () => {
    const albumId = 'a'.repeat(22);
    const h = gatedHarness((path, _a, method) => {
      if (method === 'POST') return { snapshot_id: 's' } as unknown;
      if (path === `/playlists/${TARGET}/items`) return { items: [], total: 0, limit: 100, offset: 0, next: null } as unknown;
      if (path === `/albums/${albumId}/tracks`) {
        const arg = (_a as { limit?: string } | undefined)?.limit;
        if (arg === '50') {
          return { items: [], total: 0, limit: 50, offset: 0, next: null } as unknown;
        }
        return { items: [], total: 0, limit: 1, offset: 0, next: null } as unknown;
      }
      return { items: [], total: 0, limit: 100, offset: 0, next: null } as unknown;
    });
    const out = await h.invoke('batch_add_to_playlist', {
      target_playlist_id: TARGET,
      source_uris: [`spotify:album:${albumId}`],
    });
    const p = out.structuredContent as Record<string, unknown>;
    const failed = p.failed as Array<{ source: string; type: string; reason: string }>;
    assert.equal(failed.length, 1);
    assert.equal(failed[0].type, 'album');
    assert.equal(failed[0].reason, 'empty');
    assert.match(textOf(out), /empty/);
    assert.doesNotMatch(textOf(out), /region-locked/);
  });

  it('reports a 403 on artist top-tracks as `gated` when the gated-path contract annotates it', async () => {
    // The contract installs on the client during `src/index.ts` setup; the
    // test harness installs it explicitly via `gatedHarness`. Without the
    // annotation the same 403 would read as `forbidden` (#867).
    const artistId = 'a'.repeat(22);
    const h = gatedHarness((path, _a, method) => {
      if (method === 'POST') return { snapshot_id: 's' } as unknown;
      if (path === `/playlists/${TARGET}/items`) return { items: [], total: 0, limit: 100, offset: 0, next: null } as unknown;
      if (path === `/artists/${artistId}/top-tracks`) {
        throw new SpotifyApiError(403, 'Forbidden');
      }
      return { items: [], total: 0, limit: 100, offset: 0, next: null } as unknown;
    });
    const out = await h.invoke('batch_add_to_playlist', {
      target_playlist_id: TARGET,
      source_uris: [`spotify:artist:${artistId}`],
    });
    const p = out.structuredContent as Record<string, unknown>;
    const failed = p.failed as Array<{ source: string; type: string; reason: string }>;
    assert.equal(failed.length, 1);
    assert.equal(failed[0].type, 'artist');
    assert.equal(failed[0].reason, 'gated');
    assert.deepEqual(p.failed_per_source, { album: 0, artist: 1, playlist: 0 });
    assert.match(textOf(out), /not available for this app registration/);
  });

  it('reports an empty artist top-tracks as `empty`, not as a failure of the call', async () => {
    const artistId = 'a'.repeat(22);
    const h = gatedHarness((path, _a, method) => {
      if (method === 'POST') return { snapshot_id: 's' } as unknown;
      if (path === `/playlists/${TARGET}/items`) return { items: [], total: 0, limit: 100, offset: 0, next: null } as unknown;
      if (path === `/artists/${artistId}/top-tracks`) {
        return { tracks: [] } as unknown;
      }
      return { items: [], total: 0, limit: 100, offset: 0, next: null } as unknown;
    });
    const out = await h.invoke('batch_add_to_playlist', {
      target_playlist_id: TARGET,
      source_uris: [`spotify:artist:${artistId}`],
    });
    const p = out.structuredContent as Record<string, unknown>;
    const failed = p.failed as Array<{ source: string; type: string; reason: string }>;
    assert.equal(failed.length, 1);
    assert.equal(failed[0].type, 'artist');
    assert.equal(failed[0].reason, 'empty');
  });

  it('sends artist top-tracks with the caller market from SPOTIFY_MCP_MARKET, not the hardcoded US', async () => {
    // Pre-fix this was hardcoded `market: 'US'`; the fix delegates to
    // `resolveRequestMarket`, which prefers SPOTIFY_MCP_MARKET over the
    // account country. The harness resolves the market once per call, so a
    // configured SE must be the value the request carries (#867).
    initConfig({ ...process.env, SPOTIFY_MCP_MARKET: 'SE' });
    try {
      const artistId = 'a'.repeat(22);
      const h = gatedHarness((path, _a, method) => {
        if (method === 'POST') return { snapshot_id: 's' } as unknown;
        if (path === `/playlists/${TARGET}/items`) return { items: [], total: 0, limit: 100, offset: 0, next: null } as unknown;
        if (path === `/artists/${artistId}/top-tracks`) {
          return { tracks: [{ uri: track('t1') }] } as unknown;
        }
        return { items: [], total: 0, limit: 100, offset: 0, next: null } as unknown;
      });
      const out = await h.invoke('batch_add_to_playlist', {
        target_playlist_id: TARGET,
        source_uris: [`spotify:artist:${artistId}`],
      });
      const top = h.client.calls.find((c) => c.method === 'GET' && c.path === `/artists/${artistId}/top-tracks`);
      assert.equal((top?.arg as { market?: string } | undefined)?.market, 'SE');
      // The structured payload also carries the market source so a host
      // reading `structuredContent.market` can tell "from config" from
      // "from the argument" from "no market applied at all" (#867).
      const p = out.structuredContent as Record<string, unknown>;
      assert.equal(p.market, 'SE');
      assert.equal(p.market_source, 'config');
      assert.equal((p.resolved_per_source as Record<string, number>).artist, 1);
    } finally {
      initConfig(process.env);
    }
  });

  it('falls back to `from_token` when neither SPOTIFY_MCP_MARKET nor an account country is set', async () => {
    initConfig({ ...process.env, SPOTIFY_MCP_MARKET: '' });
    try {
      const artistId = 'a'.repeat(22);
      const h = gatedHarness((path, _a, method) => {
        if (method === 'POST') return { snapshot_id: 's' } as unknown;
        if (path === `/playlists/${TARGET}/items`) return { items: [], total: 0, limit: 100, offset: 0, next: null } as unknown;
        if (path === `/me`) return {} as unknown; // no country on the profile
        if (path === `/artists/${artistId}/top-tracks`) {
          return { tracks: [{ uri: track('t1') }] } as unknown;
        }
        return { items: [], total: 0, limit: 100, offset: 0, next: null } as unknown;
      });
      const out = await h.invoke('batch_add_to_playlist', {
        target_playlist_id: TARGET,
        source_uris: [`spotify:artist:${artistId}`],
      });
      const top = h.client.calls.find((c) => c.method === 'GET' && c.path === `/artists/${artistId}/top-tracks`);
      assert.equal((top?.arg as { market?: string } | undefined)?.market, 'from_token');
      const p = out.structuredContent as Record<string, unknown>;
      assert.equal(p.market, null);
      assert.equal(p.market_source, 'none');
    } finally {
      initConfig(process.env);
    }
  });

  it('surfaces per-source counts in structuredContent when the batch is empty', async () => {
    // Three differently-failing sources in one batch — every failure type
    // must show up distinctly in both prose and `structuredContent` (#867).
    const albumId = 'a'.repeat(22);
    const artistId = 'b'.repeat(22);
    const playlistId = 'c'.repeat(22);
    const h = gatedHarness((path, _a, method) => {
      if (method === 'POST') return { snapshot_id: 's' } as unknown;
      if (path === `/playlists/${TARGET}/items`) return { items: [], total: 0, limit: 100, offset: 0, next: null } as unknown;
      if (path === `/albums/${albumId}/tracks`) {
        const arg = (_a as { limit?: string } | undefined)?.limit;
        if (arg === '50') {
          return { items: [{ uri: null, is_playable: false, restrictions: { reason: 'market' } }], total: 1, limit: 50, offset: 0, next: null } as unknown;
        }
        return { items: [{ uri: null, is_playable: false }], total: 1, limit: 1, offset: 0, next: null } as unknown;
      }
      if (path === `/artists/${artistId}/top-tracks`) {
        throw new SpotifyApiError(403, 'Forbidden');
      }
      if (path === `/playlists/${playlistId}/items`) {
        return { items: [], total: 0, limit: 100, offset: 0, next: null } as unknown;
      }
      return { items: [], total: 0, limit: 100, offset: 0, next: null } as unknown;
    });
    const out = await h.invoke('batch_add_to_playlist', {
      target_playlist_id: TARGET,
      source_uris: [
        `spotify:album:${albumId}`,
        `spotify:artist:${artistId}`,
        `spotify:playlist:${playlistId}`,
      ],
    });
    const p = out.structuredContent as Record<string, unknown>;
    const failed = p.failed as Array<{ source: string; type: string; reason: string }>;
    assert.equal(failed.length, 3);
    const byType = Object.fromEntries(failed.map((f) => [f.type, f.reason]));
    assert.equal(byType.album, 'unplayable');
    assert.equal(byType.artist, 'gated');
    assert.equal(byType.playlist, 'empty');
    assert.deepEqual(p.failed_per_source, { album: 1, artist: 1, playlist: 1 });
    assert.deepEqual(p.resolved_per_source, { track: 0, episode: 0, album: 0, artist: 0, playlist: 0 });
    assert.match(textOf(out), /region-locked/);
    assert.match(textOf(out), /not available for this app registration/);
    assert.match(textOf(out), /\(playlist, empty\)/);
  });
});

// #865 — multi-chunk playlist writes must surface what already landed when a
// later chunk rejects, so a retry can resume from the right offset instead of
// duplicating committed URIs.
describe('multi-chunk write partial state (#865)', () => {
  // 150 unique source URIs → exactly 2 chunks at the 100-URI write cap;
  // chunk 0 commits cleanly, chunk 1 fails.
  const bigSource = Array.from({ length: 150 }, (_, i) => track(`t${i}`));
  const firstChunkUris = bigSource.slice(0, 100);
  const secondChunkUris = bigSource.slice(100, 150);

  // Helper for paginated source reads: the stub's getAllPages re-reads at
  // offsets 0 and 100, so the responder must slice based on the offset it
  // is asked for — otherwise the same items repeat across pages.
  function pagedSource(items: string[], params: unknown): { items: unknown[]; total: number; limit: number; offset: number; next: null } {
    const p = (params ?? {}) as Record<string, string>;
    const offset = Number(p.offset ?? 0);
    const limit = Number(p.limit ?? 100);
    const slice = items.slice(offset, offset + limit);
    return {
      items: slice.map((uri) => ({ added_at: 'x', item: { id: uri.split(':').pop()!, uri, type: 'track', name: uri, duration_ms: 100, artists: [{ name: 'a' }], album: { id: 'al', name: 'al', uri: 'spotify:album:al', images: [] } } })),
      total: items.length,
      limit,
      offset,
      next: null,
    };
  }

  it('batch_add_to_playlist reports last_committed_chunk on chunk 2 failure', async () => {
    let postCount = 0;
    // 150 URIs crosses BATCH_ADD_ELICIT_THRESHOLD=100, so we configure the
    // harness to accept the elicit gate before the write loop runs.
    const h = harness((_path, _arg, method) => {
      if (method !== 'POST') return { items: [], total: 0, limit: 100, offset: 0, next: null } as unknown;
      postCount++;
      if (postCount === 1) return { snapshot_id: 'snap-1' } as unknown;
      throw new SpotifyApiError(503, 'Service Unavailable');
    }, { action: 'accept', content: { confirm: true } });
    const out = await h.invoke('batch_add_to_playlist', { target_playlist_id: TARGET, source_uris: bigSource });
    const payload = out.structuredContent as Record<string, unknown>;
    // The contract — every key the issue names.
    assert.equal(payload.partial_write_failure, true);
    assert.equal(payload.ok, false);
    assert.equal(payload.attempted_chunks, 2);
    assert.equal(payload.failed_chunk_index, 1);
    assert.equal(payload.last_committed_chunk_index, 0);
    assert.deepEqual(payload.last_committed_chunk_uris, firstChunkUris);
    assert.equal(payload.committed_uris, 100);
    assert.equal(payload.remaining_uris, 50);
    assert.equal(payload.attempted_uris, 150);
    assert.match(payload.error as string, /Service Unavailable/);
    // Prose names the failed chunk and the committed prefix size.
    assert.match(textOf(out), /Partial write to playlist/);
    assert.match(textOf(out), /chunk 2 of 2 failed/);
    assert.match(textOf(out), /100 URI\(s\)/);
    // Exactly 2 POSTs were issued: chunk 0 succeeded, chunk 1 threw.
    const posts = h.client.calls.filter((c) => c.method === 'POST' && c.path === `/playlists/${TARGET}/items`);
    assert.equal(posts.length, 2, 'one POST per chunk; the failed one still gets issued');
    assert.deepEqual((posts[0].arg as { uris: string[] }).uris, firstChunkUris);
    assert.deepEqual((posts[1].arg as { uris: string[] }).uris, secondChunkUris);
  });

  it('batch_add_to_playlist reports nothing-committed when chunk 0 fails', async () => {
    let postCount = 0;
    const h = harness((_path, _arg, method) => {
      if (method !== 'POST') return { items: [], total: 0, limit: 100, offset: 0, next: null } as unknown;
      postCount++;
      throw new SpotifyApiError(403, 'Forbidden');
    }, { action: 'accept', content: { confirm: true } });
    const out = await h.invoke('batch_add_to_playlist', { target_playlist_id: TARGET, source_uris: bigSource });
    const payload = out.structuredContent as Record<string, unknown>;
    assert.equal(payload.partial_write_failure, true);
    assert.equal(payload.failed_chunk_index, 0);
    assert.equal(payload.last_committed_chunk_index, -1);
    assert.deepEqual(payload.last_committed_chunk_uris, []);
    assert.equal(payload.committed_uris, 0);
    assert.equal(payload.remaining_uris, 150);
    assert.match(payload.error as string, /Forbidden/);
    assert.match(textOf(out), /the first chunk failed/);
  });

  it('copy_playlist reports last_committed_chunk when a chunked add rejects', async () => {
    // 150 source URIs → 2 chunks (100 / 50); chunk 1 throws.
    const srcUris = Array.from({ length: 150 }, (_, i) => track(`c${i}`));
    let postCount = 0;
    const h = harness((path, _arg, method) => {
      if (path === `/playlists/${COPY_SOURCE}`) return { id: COPY_SOURCE, name: 'Source', description: null } as unknown;
      if (path === `/playlists/${COPY_SOURCE}/items` && method === 'GET') return pagedSource(srcUris, _arg) as unknown;
      if (method !== 'POST') return { items: [], total: 0, limit: 100, offset: 0, next: null } as unknown;
      postCount++;
      // POST 1: /me/playlists creates the destination.
      if (path === '/me/playlists') return { id: 'new1', uri: 'spotify:playlist:new1' } as unknown;
      // POST 2: chunk 0 of the add succeeds.
      if (postCount === 2) return { snapshot_id: 'snap' } as unknown;
      // POST 3: chunk 1 throws.
      throw new SpotifyApiError(500, 'Internal Server Error');
    }, { action: 'accept', content: { confirm: true } });
    const out = await h.invoke('copy_playlist', { source_playlist_id: COPY_SOURCE, new_name: 'Copy' });
    const payload = out.structuredContent as Record<string, unknown>;
    assert.equal(payload.partial_write_failure, true);
    assert.equal(payload.attempted_chunks, 2);
    assert.equal(payload.failed_chunk_index, 1);
    assert.equal(payload.last_committed_chunk_index, 0);
    assert.deepEqual(payload.last_committed_chunk_uris, srcUris.slice(0, 100));
    assert.equal(payload.committed_uris, 100);
    assert.equal(payload.attempted_uris, 150);
    assert.equal(payload.remaining_uris, 50);
    assert.match(textOf(out), /Partial copy to new playlist new1/);
  });

  it('move_items_between_playlists surfaces add-side partial state', async () => {
    // 150 source URIs → 2 chunks; the second add POST rejects. The remove
    // step must NOT run — add succeeded partially, remove would make a bad
    // partial state worse.
    let addCount = 0;
    // 150 URIs crosses MOVE_ELICIT_THRESHOLD=50, so configure the harness
    // to accept the elicit gate before the write loop runs.
    const h = harness((path, _arg, method) => {
      if (path === `/playlists/${MOVE_SOURCE}/items` && method === 'GET') return pagedSource(bigSource, _arg) as unknown;
      if (path === `/playlists/${MOVE_TARGET}/items` && method === 'GET') return { items: [], total: 0, limit: 100, offset: 0, next: null } as unknown;
      if (method === 'POST' && path === `/playlists/${MOVE_TARGET}/items`) {
        addCount++;
        if (addCount === 1) return { snapshot_id: 'snap' } as unknown;
        throw new SpotifyApiError(429, 'Rate limited');
      }
      if (method === 'DELETE') return { snapshot_id: 'snap' } as unknown;
      return { items: [], total: 0, limit: 100, offset: 0, next: null } as unknown;
    }, { action: 'accept', content: { confirm: true } });
    const out = await h.invoke('move_items_between_playlists', { source_playlist_id: MOVE_SOURCE, target_playlist_id: MOVE_TARGET, mode: 'move' });
    const payload = out.structuredContent as Record<string, unknown>;
    assert.equal(payload.partial_write_failure, true);
    assert.equal(payload.step, 'add');
    assert.equal(payload.attempted_chunks, 2);
    assert.equal(payload.failed_chunk_index, 1);
    assert.equal(payload.last_committed_chunk_index, 0);
    assert.deepEqual(payload.last_committed_chunk_uris, firstChunkUris);
    // The remove DELETE never fired.
    const deletes = h.client.calls.filter((c) => c.method === 'DELETE' && c.path === `/playlists/${MOVE_SOURCE}/items`);
    assert.equal(deletes.length, 0, 'remove step must be skipped when add fails');
  });

  it('move_items_between_playlists surfaces remove-side partial state when add succeeded', async () => {
    let deleteCount = 0;
    const h = harness((path, _arg, method) => {
      if (path === `/playlists/${MOVE_SOURCE}/items` && method === 'GET') return pagedSource(bigSource, _arg) as unknown;
      if (path === `/playlists/${MOVE_TARGET}/items` && method === 'GET') return { items: [], total: 0, limit: 100, offset: 0, next: null } as unknown;
      if (method === 'POST' && path === `/playlists/${MOVE_TARGET}/items`) return { snapshot_id: 'snap' } as unknown;
      // The harness's stub records calls as DELETE but does not pass the
      // method to the responder, so fall back to inspecting the path AND the
      // call counter when looking at DELETE-shaped writes (no POST hits this).
      if (method === undefined && path === `/playlists/${MOVE_SOURCE}/items`) {
        deleteCount++;
        if (deleteCount === 1) return { snapshot_id: 'snap' } as unknown;
        throw new SpotifyApiError(500, 'boom');
      }
      return { items: [], total: 0, limit: 100, offset: 0, next: null } as unknown;
    }, { action: 'accept', content: { confirm: true } });
    const out = await h.invoke('move_items_between_playlists', { source_playlist_id: MOVE_SOURCE, target_playlist_id: MOVE_TARGET, mode: 'move' });
    const payload = out.structuredContent as Record<string, unknown>;
    assert.equal(payload.partial_write_failure, true);
    assert.equal(payload.step, 'remove');
    assert.equal(payload.attempted_chunks, 2);
    assert.equal(payload.failed_chunk_index, 1);
    assert.equal(payload.last_committed_chunk_index, 0);
    assert.deepEqual(payload.last_committed_chunk_uris, firstChunkUris);
    assert.match(payload.error as string, /boom/);
    assert.match(textOf(out), /now exist on BOTH playlists/);
  });

  it('batch_add_to_playlist: chunk 1 success + chunk 2 failure tracks only chunk 1', async () => {
    // 150 URIs → 2 chunks (100/50); chunk 1 fails — confirms the tracker
    // updates correctly across multiple successful chunks before failure.
    const big = Array.from({ length: 150 }, (_, i) => track(`b${i}`));
    let postCount = 0;
    const h = harness((_path, _arg, method) => {
      if (method !== 'POST') return { items: [], total: 0, limit: 100, offset: 0, next: null } as unknown;
      postCount++;
      if (postCount === 1) return { snapshot_id: 'snap-1' } as unknown;
      throw new SpotifyApiError(500, 'oops');
    }, { action: 'accept', content: { confirm: true } });
    const out = await h.invoke('batch_add_to_playlist', { target_playlist_id: TARGET, source_uris: big });
    const payload = out.structuredContent as Record<string, unknown>;
    assert.equal(payload.attempted_chunks, 2);
    assert.equal(payload.failed_chunk_index, 1);
    assert.equal(payload.last_committed_chunk_index, 0);
    assert.deepEqual(payload.last_committed_chunk_uris, big.slice(0, 100));
    assert.equal(payload.committed_uris, 100);
    assert.equal(payload.remaining_uris, 50);
  });
});
