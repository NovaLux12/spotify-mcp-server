import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { SpotifyClient } from '../src/client.js';
import type { PlaylistItemObject } from '../src/types/spotify.js';
import { registerPlaylistHealthTools } from '../src/tools/playlisthealth.js';
interface RegisteredTool { name: string; validate: (args: Record<string, unknown>) => Record<string, unknown>; handler: (args: Record<string, unknown>) => Promise<{ content: Array<{ type: string; text: string }>; structuredContent?: Record<string, unknown> }>; }
type Responder = (path: string, arg: unknown) => unknown;
function makeHarness(responder: Responder) {
  const registered: RegisteredTool[] = [];
  const fakeServer = { tool(name: string, _desc: string, schema: z.ZodRawShape, handler: RegisteredTool['handler']) { registered.push({ name, validate: (args) => z.object(schema).parse(args), handler }); }, registerTool(name: string, config: { description?: string; inputSchema?: z.ZodType }, handler: RegisteredTool['handler']) { registered.push({ name, validate: (args) => (config.inputSchema as z.ZodType).parse(args), handler }); }, } as unknown as McpServer;
  const client = { async get<T>(path: string, params?: Record<string, string>): Promise<T | null> { return responder(path, params) as T | null; }, async getAllPages<T>(path: string, _params?: Record<string, string>): Promise<T[]> { const result = responder(path, _params); if (Array.isArray(result)) return result as T[]; return []; }, async delete<T>(path: string, body?: unknown): Promise<T | null> { return responder(path, { body }) as T | null; }, } as unknown as SpotifyClient;
  return { registered, client, server: fakeServer, invoke: async (name: string, args: Record<string, unknown>) => { const tool = registered.find((t) => t.name === name)!; assert.ok(tool, `tool ${name} registered`); return tool.handler(tool.validate(args)); }, };
}
const mkTrack = (id: string, overrides: Record<string, unknown> = {}) => ({ added_at: '2026-01-15T10:00:00Z', added_by: { id: 'user1' }, item: { type: 'track' as const, id, name: `Track ${id}`, uri: `spotify:track:${id}`, duration_ms: 200000, artists: [{ name: `Artist ${id}` }], ...overrides }, }) as unknown as PlaylistItemObject;
const mkUnavailable = () => ({ added_at: '2026-01-15T10:00:00Z', item: null }) as unknown as PlaylistItemObject;
const mkLocal = () => ({ added_at: '2026-01-15T10:00:00Z', item: { type: 'track', id: 'local1', name: 'Local', uri: 'spotify:local:Artist:Album:Track:123', duration_ms: 180000, artists: [{ name: 'Local Artist' }], is_local: true }, }) as unknown as PlaylistItemObject;
let tmpDir = ''; let origDataDir: string | undefined;
beforeEach(() => { tmpDir = mkdtempSync(join(tmpdir(), 'ph-test-')); origDataDir = process.env.SPOTIFY_MCP_DATA_DIR; process.env.SPOTIFY_MCP_DATA_DIR = tmpDir; });
afterEach(() => { if (origDataDir === undefined) delete process.env.SPOTIFY_MCP_DATA_DIR; else process.env.SPOTIFY_MCP_DATA_DIR = origDataDir; try { rmSync(tmpDir, { recursive: true, force: true }); } catch {} });
describe('playlist_health_check', () => {
  it('healthy playlist — no issues', async () => { const items = [mkTrack('a'), mkTrack('b'), mkTrack('c')]; const h = makeHarness(() => items); registerPlaylistHealthTools(h.server as unknown as McpServer, h.client); const out = await h.invoke('playlist_health_check', { playlist_id: 'pl1' }); const sc = out.structuredContent as { healthy: boolean; issues: unknown[]; total: number }; assert.equal(sc.healthy, true); assert.equal(sc.issues.length, 0); assert.equal(sc.total, 3); });
  it('detects unavailable items', async () => { const items = [mkTrack('a'), mkUnavailable(), mkTrack('c')]; const h = makeHarness(() => items); registerPlaylistHealthTools(h.server as unknown as McpServer, h.client); const out = await h.invoke('playlist_health_check', { playlist_id: 'pl1' }); const sc = out.structuredContent as { issues: Array<{ type: string; positions: number[] }> }; const unav = sc.issues.find((i) => i.type === 'unavailable')!; assert.ok(unav); assert.deepEqual(unav.positions, [1]); });
  it('detects local files', async () => { const items = [mkTrack('a'), mkLocal()]; const h = makeHarness(() => items); registerPlaylistHealthTools(h.server as unknown as McpServer, h.client); const out = await h.invoke('playlist_health_check', { playlist_id: 'pl1' }); const sc = out.structuredContent as { issues: Array<{ type: string }> }; assert.ok(sc.issues.some((i) => i.type === 'local')); });
  it('detects duplicates', async () => { const items = [mkTrack('a'), mkTrack('b'), mkTrack('a')]; const h = makeHarness(() => items); registerPlaylistHealthTools(h.server as unknown as McpServer, h.client); const out = await h.invoke('playlist_health_check', { playlist_id: 'pl1' }); const sc = out.structuredContent as { issues: Array<{ type: string; positions: number[] }>; duplicate_groups: unknown[] }; const dup = sc.issues.find((i) => i.type === 'duplicate')!; assert.ok(dup); assert.deepEqual(dup.positions.sort((a,b)=>a-b), [0,2]); assert.equal(sc.duplicate_groups.length, 1); });
  it('empty playlist', async () => { const h = makeHarness(() => []); registerPlaylistHealthTools(h.server as unknown as McpServer, h.client); const out = await h.invoke('playlist_health_check', { playlist_id: 'pl1' }); const sc = out.structuredContent as { issues: Array<{ type: string }>; healthy: boolean }; assert.equal(sc.healthy, false); assert.ok(sc.issues.some((i) => i.type === 'empty')); });
});
describe('get_playlist_followers', () => {
  it('returns follower count', async () => { const h = makeHarness((path) => { if (path === '/playlists/pl1') return { id: 'pl1', name: 'My Mix', followers: { total: 42 }, owner: { id: 'owner1', display_name: 'Owner' } }; return null; }); registerPlaylistHealthTools(h.server as unknown as McpServer, h.client); const out = await h.invoke('get_playlist_followers', { playlist_id: 'pl1' }); const sc = out.structuredContent as { followers_total: number }; assert.equal(sc.followers_total, 42); });
  it('includes owner profile when requested', async () => { const h = makeHarness((path) => { if (path === '/playlists/pl1') return { id: 'pl1', name: 'My Mix', followers: { total: 5 }, owner: { id: 'owner1', display_name: 'Owner' } }; if (path === '/users/owner1') return { id: 'owner1', display_name: 'Owner' }; return null; }); registerPlaylistHealthTools(h.server as unknown as McpServer, h.client); const out = await h.invoke('get_playlist_followers', { playlist_id: 'pl1', include_profiles: true }); const sc = out.structuredContent as { owner_profile: unknown }; assert.ok(sc.owner_profile); });
});
describe('playlist_collaboration_report', () => {
  it('rolls up contributors with counts and timestamps', async () => { const items: PlaylistItemObject[] = [ { added_at: '2026-01-01T00:00:00Z', added_by: { id: 'alice' } as unknown as PlaylistItemObject['added_by'], item: { type: 'track', id: 't1', name: 'T1', uri: 'spotify:track:t1', duration_ms: 1000, artists: [] } as unknown as PlaylistItemObject extends { item?: infer I } ? I : never } as unknown as PlaylistItemObject, { added_at: '2026-01-02T00:00:00Z', added_by: { id: 'bob' } as unknown as PlaylistItemObject['added_by'], item: { type: 'track', id: 't2', name: 'T2', uri: 'spotify:track:t2', duration_ms: 1000, artists: [] } as unknown as PlaylistItemObject extends { item?: infer I } ? I : never } as unknown as PlaylistItemObject, { added_at: '2026-01-03T00:00:00Z', added_by: { id: 'alice' } as unknown as PlaylistItemObject['added_by'], item: { type: 'track', id: 't3', name: 'T3', uri: 'spotify:track:t3', duration_ms: 1000, artists: [] } as unknown as PlaylistItemObject extends { item?: infer I } ? I : never } as unknown as PlaylistItemObject, ]; const h = makeHarness(() => items); registerPlaylistHealthTools(h.server as unknown as McpServer, h.client); const out = await h.invoke('playlist_collaboration_report', { playlist_id: 'pl1' }); const sc = out.structuredContent as { contributors: Array<{ user_id: string; count: number }>; most_active: string }; assert.equal(sc.contributors.length, 2); assert.equal(sc.contributors[0].user_id, 'alice'); assert.equal(sc.contributors[0].count, 2); assert.equal(sc.most_active, 'alice'); });
});
describe('find_duplicate_playlists dry_run + quota', () => {
  it('dry_run returns cost estimate without calls', async () => {
    let calls = 0;
    const h = makeHarness(() => { calls++; return []; });
    registerPlaylistHealthTools(h.server as unknown as McpServer, h.client);
    const out = await h.invoke('find_duplicate_playlists', { dry_run: true, max_playlists: 10, scan_cap: 100 });
    assert.equal(calls, 0);
    assert.equal((out.structuredContent as Record<string, unknown>).dry_run, true);
    assert.equal((out.structuredContent as Record<string, unknown>).estimated_requests, 11);
    assert.match(out.content[0].text, /dry run/);
  });
  it('quota partial recovery returns groups so far', async () => {
    const { SpotifyApiError } = await import('../src/client.js');
    const h2 = makeHarness(() => []);
    let calls2 = 0;
    (h2.client as unknown as Record<string, unknown>).getAllPages = async (path: string) => {
      if (path === '/me/playlists') return [{ id: 'pl1', name: 'P1' }, { id: 'pl2', name: 'P2' }] as unknown[];
      if (path.startsWith('/playlists/')) {
        calls2++;
        if (calls2 === 2) throw new SpotifyApiError(429, 'quota', 30);
        return [{ item: { uri: 'spotify:track:t1' } }] as unknown[];
      }
      return [];
    };
    h2.registered.length = 0;
    const { registerPlaylistHealthTools: reg2 } = await import('../src/tools/playlisthealth.js');
    // need fresh server to avoid duplicate registration from before
    const h3 = makeHarness(() => []);
    let c3 = 0;
    (h3.client as unknown as Record<string, unknown>).getAllPages = async (path: string) => {
      if (path === '/me/playlists') return [{ id: 'pl1', name: 'P1' }, { id: 'pl2', name: 'P2' }] as unknown[];
      if (path.startsWith('/playlists/')) { c3++; if (c3 === 2) throw new SpotifyApiError(429, 'quota', 30); return [{ item: { uri: 'spotify:track:t1' } }] as unknown[]; }
      return [];
    };
    reg2(h3.server as unknown as McpServer, h3.client);
    const out = await h3.invoke('find_duplicate_playlists', { max_playlists: 2 });
    assert.equal((out.structuredContent as Record<string, unknown>).quota_hit, true);
    assert.match(out.content[0].text, /quota hit/i);
  });
});

describe('snapshot + diff + list', () => {
  it('snapshot round-trip creates file and list finds it', async () => { const items = [mkTrack('a'), mkTrack('b')]; const h = makeHarness(() => items); registerPlaylistHealthTools(h.server as unknown as McpServer, h.client); const snap = await h.invoke('snapshot_playlist', { playlist_id: 'pl1', snapshot_id: 'snap1' }); const sc = snap.structuredContent as { snapshot_id: string }; assert.equal(sc.snapshot_id, 'snap1'); const list = await h.invoke('list_playlist_snapshots', { playlist_id: 'pl1' }); const lsc = list.structuredContent as { count: number }; assert.equal(lsc.count, 1); });
  it('diff detects added, removed, and reordered', async () => { const initialItems = [mkTrack('a'), mkTrack('b'), mkTrack('c')]; let currentItems: PlaylistItemObject[] = initialItems; const h = makeHarness(() => currentItems); registerPlaylistHealthTools(h.server as unknown as McpServer, h.client); await h.invoke('snapshot_playlist', { playlist_id: 'pl1', snapshot_id: 'snap1' }); currentItems = [mkTrack('c'), mkTrack('a'), mkTrack('d')]; const diff = await h.invoke('diff_since_snapshot', { playlist_id: 'pl1', snapshot_id: 'snap1' }); const sc = diff.structuredContent as { added: unknown[]; removed: unknown[]; reordered: unknown[] }; assert.equal(sc.added.length, 1); assert.equal(sc.removed.length, 1); assert.ok(sc.reordered.length > 0); });
});

  it('redacts filesystem errors and caller-provided URL or path sentinels', async () => {
    const h = makeHarness(() => []);
    registerPlaylistHealthTools(h.server as unknown as McpServer, h.client);
    await assert.rejects(
      h.invoke('diff_since_snapshot', {
        playlist_id: 'https://example.test/SENTINEL_PLAYLIST?token=secret',
        snapshot_id: '/home/alice/SENTINEL_SNAPSHOT.json',
      }),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.equal(error.message, 'Snapshot could not be read.');
        return true;
      },
    );
  });

describe('remove_unavailable_playlist_items', () => {
  it('deletes only validated unavailable positions highest first and verifies the rescan', async () => {
    let items: PlaylistItemObject[] = [mkTrack('a'), mkUnavailable(), mkTrack('b'), mkUnavailable(), mkTrack('c')];
    const writes: Array<Record<string, unknown>> = [];
    const h = makeHarness((path, arg) => {
      if (arg && typeof arg === 'object' && 'body' in arg) {
        const body = arg.body as { tracks: Array<{ positions: number[] }> };
        const position = body.tracks[0].positions[0];
        writes.push(body);
        items.splice(position, 1);
        return { snapshot_id: 'snap1' };
      }
      assert.equal(path, '/playlists/pl1/items');
      return items;
    });
    registerPlaylistHealthTools(h.server as unknown as McpServer, h.client);
    const out = await h.invoke('remove_unavailable_playlist_items', { playlist_id: 'pl1', max_removals: 2 });
    const sc = out.structuredContent as { ok: boolean; removed: number; removed_positions: number[] };
    assert.equal(sc.ok, true);
    assert.equal(sc.removed, 2);
    assert.deepEqual(writes.map((body) => (body.tracks as Array<{ positions: number[] }>)[0].positions[0]), [3, 1]);
    assert.ok(writes.every((body) => !('uri' in (body.tracks as Array<Record<string, unknown>>)[0])));
    assert.deepEqual(sc.removed_positions, [1, 3]);
  });

  it('returns failure when DELETE does not change the unavailable rows', async () => {
    const h = makeHarness((_path, arg) => arg && typeof arg === 'object' && 'body' in arg
      ? { snapshot_id: 'snap1' }
      : [mkUnavailable(), mkTrack('a')]);
    registerPlaylistHealthTools(h.server as unknown as McpServer, h.client);
    const out = await h.invoke('remove_unavailable_playlist_items', { playlist_id: 'pl1' });
    const sc = out.structuredContent as { ok: boolean; removed: number; remaining_unavailable: number; remaining_positions: number[] };
    assert.equal(sc.ok, false);
    assert.equal(sc.removed, 0);
    assert.equal(sc.remaining_unavailable, 1);
    assert.deepEqual(sc.remaining_positions, [0]);
  });

  it('defaults the destructive cap to all detected unavailable rows with the explicit automation bypass', async () => {
    const previousConfirm = process.env.SPOTIFY_MCP_CONFIRM;
    process.env.SPOTIFY_MCP_CONFIRM = 'never';
    try {
      let items: PlaylistItemObject[] = Array.from({ length: 101 }, mkUnavailable);
      let writes = 0;
      const h = makeHarness((_path, arg) => {
        if (arg && typeof arg === 'object' && 'body' in arg) {
          writes++;
          items = [];
          return { snapshot_id: 'snap1' };
        }
        return items;
      });
      registerPlaylistHealthTools(h.server as unknown as McpServer, h.client);
      const out = await h.invoke('remove_unavailable_playlist_items', { playlist_id: 'pl1' });
      assert.equal(writes, 101);
      assert.equal((out.structuredContent as { ok: boolean }).ok, true);
    } finally {
      if (previousConfirm === undefined) delete process.env.SPOTIFY_MCP_CONFIRM;
      else process.env.SPOTIFY_MCP_CONFIRM = previousConfirm;
    }
  });

  it('does not write during dry run', async () => {
    let writes = 0;
    const h = makeHarness((_path, arg) => {
      if (arg && typeof arg === 'object' && 'body' in arg) { writes++; return {}; }
      return [mkUnavailable(), mkTrack('a')];
    });
    registerPlaylistHealthTools(h.server as unknown as McpServer, h.client);
    const out = await h.invoke('remove_unavailable_playlist_items', { playlist_id: 'pl1', dry_run: true });
    assert.equal(writes, 0);
    assert.equal((out.structuredContent as { dry_run: boolean }).dry_run, true);
  });

  it('reports verification unavailable when the post-write rescan fails', async () => {
    let gets = 0;
    const h = makeHarness((_path, arg) => {
      if (arg && typeof arg === 'object' && 'body' in arg) return { snapshot_id: 'snap1' };
      gets++;
      if (gets === 1) return [mkUnavailable(), mkTrack('a')];
      throw new Error('SENTINEL_HEALTH https://example.test/raw?token=secret /home/alice/private.json', { cause: new Error('nested private path') });
    });
    registerPlaylistHealthTools(h.server as unknown as McpServer, h.client);
    const out = await h.invoke('remove_unavailable_playlist_items', { playlist_id: 'pl1' });
    const sc = out.structuredContent as { ok: boolean; verification: string; removed: null };
    assert.equal(sc.ok, false);
    assert.equal(sc.verification, 'unavailable');
    assert.equal(sc.removed, null);
    const publicText = JSON.stringify(out);
    for (const secret of ['SENTINEL_HEALTH', 'token=secret', '/home/alice', 'nested private path']) {
      assert.equal(publicText.includes(secret), false, `post-write failure leaked ${secret}`);
    }
  });
});
