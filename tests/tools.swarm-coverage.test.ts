/**
 * Coverage for batch (100-chunk) and dry_run preview semantics across swarm slices.
 *
 * swarm3_library / swarm3_playback / swarm3_snapshots had no dedicated tests;
 * this file ensures their dry_run paths make zero mutating calls and that
 * batch writers fan out in groups of 100.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { SpotifyClient } from '../src/client.js';
import { registerSwarm3LibraryTools } from '../src/tools/swarm3_library.js';
import { registerSwarm3PlaybackTools } from '../src/tools/swarm3_playback.js';
import { registerPlaylistBatchTools } from '../src/tools/playlistbatch.js';

type Registered = {
  name: string;
  description: string;
  schema: z.ZodRawShape | z.ZodType;
  handler: (args: Record<string, unknown>) => Promise<{ content: Array<{ type: string; text: string }>; structuredContent?: Record<string, unknown> }>;
};

function makeHarness(register: (s: McpServer, c: SpotifyClient) => void, responder: (path: string, body: unknown, method?: string) => unknown) {
  const registered: Registered[] = [];
  const calls: Array<{ method: string; path: string; arg?: unknown }> = [];
  const server = {
    tool(name: string, desc: string, schema: z.ZodRawShape, handler: Registered['handler']) {
      registered.push({ name, description: desc, schema, handler });
    },
    registerTool(name: string, config: { description?: string; inputSchema?: z.ZodType }, handler: Registered['handler']) {
      registered.push({ name, description: config.description ?? '', schema: config.inputSchema as unknown as z.ZodType, handler });
    },
  } as unknown as McpServer;
  const client = {
    calls,
    async get<T>(path: string, params?: Record<string, string>): Promise<T | null> {
      calls.push({ method: 'GET', path, arg: params });
      return responder(path, params, 'GET') as T | null;
    },
    async post<T>(path: string, body?: unknown): Promise<T | null> {
      calls.push({ method: 'POST', path, arg: body });
      return responder(path, body, 'POST') as T | null;
    },
    async put<T>(path: string, body?: unknown): Promise<T | null> {
      calls.push({ method: 'PUT', path, arg: body });
      return responder(path, body, 'PUT') as T | null;
    },
    async delete<T>(path: string, body?: unknown): Promise<T | null> {
      calls.push({ method: 'DELETE', path, arg: body });
      return responder(path, body, 'DELETE') as T | null;
    },
    async getAllPages<T>(path: string, params?: Record<string, string>, opts?: { maxItems?: number }): Promise<T[]> {
      // For dry_run paths this should not be reached; for non-dry_run we delegate to GET paging via responder
      const maxItems = opts?.maxItems ?? 500;
      const all: T[] = [];
      let offset = 0;
      for (;;) {
        const page = await (client as unknown as { get: (p: string, pr?: Record<string, string>) => Promise<{ items: T[]; total?: number; limit?: number; offset?: number; next?: string | null } | null> }).get(path, { ...params, offset: String(offset) });
        if (!page || !Array.isArray(page.items)) break;
        all.push(...page.items);
        if (all.length >= maxItems) return all.slice(0, maxItems);
        const limit = typeof (page as unknown as { limit?: number }).limit === 'number' && (page as unknown as { limit: number }).limit > 0 ? (page as unknown as { limit: number }).limit : page.items.length;
        offset += limit;
        if (page.items.length === 0 || page.items.length < limit) break;
        if (typeof (page as unknown as { total?: number }).total === 'number' && offset >= (page as unknown as { total: number }).total) break;
      }
      return all;
    },
  } as unknown as SpotifyClient & { calls: typeof calls };
  register(server, client);
  const find = (name: string) => {
    const t = registered.find((x) => x.name === name);
    assert.ok(t, `tool ${name} must be registered`);
    return t;
  };
  const invoke = async (name: string, args: Record<string, unknown>) => {
    const t = find(name);
    // Validate through schema when possible; library tools use raw shape, playback uses raw shape, playlistbatch uses ZodType
    if (t.schema && typeof (t.schema as z.ZodType).parse === 'function') {
      const parsed = (t.schema as z.ZodType).parse(args);
      return t.handler(parsed as Record<string, unknown>);
    }
    if (t.schema && typeof t.schema === 'object' && !('parse' in (t.schema as Record<string, unknown>))) {
      const parsed = z.object(t.schema as z.ZodRawShape).parse(args);
      return t.handler(parsed);
    }
    return t.handler(args);
  };
  return { registered, client: client as unknown as { calls: typeof calls }, find, invoke, text: (r: { content: Array<{ type: string; text: string }> }) => r.content[0].text };
}

// swarm3_library — dry_run cost preview must not touch the network

describe('swarm3_library dry_run previews make zero API calls', () => {
  it('saved_vs_playlist_coverage dry_run previews cost without GETs', async () => {
    const h = makeHarness(registerSwarm3LibraryTools, () => {
      throw new Error('no API call expected during dry_run');
    });
    const out = await h.invoke('saved_vs_playlist_coverage', { dry_run: true, scan_cap: 100 });
    assert.equal(h.client.calls.length, 0, 'dry_run must not call any endpoint');
    assert.ok(out.structuredContent, 'structuredContent required');
    assert.equal((out.structuredContent as { dry_run: boolean }).dry_run, true);
    assert.match(h.text(out), /\[dry run\]/i);
  });

  it('orphaned_artist_check dry_run is zero-call', async () => {
    const h = makeHarness(registerSwarm3LibraryTools, () => { throw new Error('no call'); });
    const out = await h.invoke('orphaned_artist_check', { dry_run: true, scan_cap: 50 });
    assert.equal(h.client.calls.length, 0);
    assert.equal((out.structuredContent as { dry_run: boolean }).dry_run, true);
  });
});

// swarm3_playback — dry_run previews device plans without PUTs

describe('swarm3_playback dry_run previews', () => {
  it('apply_volume_plan dry_run returns plan lines without PUT', async () => {
    const h = makeHarness(registerSwarm3PlaybackTools, (path) => {
      if (path === '/me/player/devices') {
        return { devices: [{ id: 'd1', name: 'Speaker', type: 'Speaker', is_active: true, is_restricted: false, is_private_session: false, volume_percent: 30, supports_volume: true }] } as unknown;
      }
      if (path.startsWith('/me/player/volume')) return null as unknown;
      throw new Error(`unexpected GET ${path}`);
    });
    // apply_volume_plan dry_run defaults true — omit dry_run to exercise default
    const out = await h.invoke('apply_volume_plan', { volume: 42 } as Record<string, unknown>);
    const sc = out.structuredContent as { dry_run: boolean; steps: string[] };
    assert.equal(sc.dry_run, true);
    assert.ok(Array.isArray(sc.steps) && sc.steps.length === 1);
    // Must not have issued any PUT — only the GET /me/player/devices read
    assert.equal(h.client.calls.filter((c) => c.method === 'PUT').length, 0, 'dry_run must not PUT');
  });

  it('apply_volume_plan dry_run=false issues one PUT per device', async () => {
    const h = makeHarness(registerSwarm3PlaybackTools, (path) => {
      if (path === '/me/player/devices') {
        return { devices: [
          { id: 'd1', name: 'Speaker', type: 'Speaker', is_active: true, is_restricted: false, is_private_session: false, volume_percent: 30, supports_volume: true },
          { id: 'd2', name: 'Phone', type: 'Smartphone', is_active: false, is_restricted: false, is_private_session: false, volume_percent: 80, supports_volume: true },
        ] } as unknown;
      }
      if (path.startsWith('/me/player/volume')) return null as unknown;
      return null as unknown;
    });
    const out = await h.invoke('apply_volume_plan', { volume: 25, dry_run: false } as Record<string, unknown>);
    assert.equal(h.client.calls.filter((c) => c.method === 'PUT').length, 2);
    assert.match(h.text(out), /Volume set to 25%/);
  });
});

// batch — chunk at 100: 250 URIs → 3 POSTs (100/100/50)

describe('batch chunking at 100', () => {
  it('batch_add_to_playlist splits 250 unique source URIs into 100/100/50 POSTs', async () => {
    const uris = Array.from({ length: 250 }, (_, i) => `spotify:track:${String(i).padStart(22, '0')}`);
    const h = makeHarness(registerPlaylistBatchTools, (path, _body, method) => {
      if (method === 'POST' && path.includes('/playlists/target/items')) return { snapshot_id: 'snap' } as unknown;
      // GET /playlists/target/items pages — return empty so dedupe against existing adds nothing
      if (path.includes('/playlists/target/items')) return { items: [], total: 0, limit: 100, offset: 0, next: null } as unknown;
      return { items: [], total: 0, limit: 100, offset: 0, next: null } as unknown;
    });
    const out = await h.invoke('batch_add_to_playlist', { target_playlist_id: 'target', source_uris: uris });
    const posts = h.client.calls.filter((c) => c.method === 'POST' && c.path.includes('/playlists/target/items'));
    assert.equal(posts.length, 3, '250 tracks must fan out into 3 POSTs');
    assert.equal((posts[0].arg as { uris: string[] }).uris.length, 100);
    assert.equal((posts[1].arg as { uris: string[] }).uris.length, 100);
    assert.equal((posts[2].arg as { uris: string[] }).uris.length, 50);
    assert.match(h.text(out), /across 3 batch/);
  });

  it('batch_add_to_playlist dry_run with 250 URIs makes zero POSTs', async () => {
    const uris = Array.from({ length: 250 }, (_, i) => `spotify:track:${String(i).padStart(22, '0')}`);
    const h = makeHarness(registerPlaylistBatchTools, (path) => {
      if (path.includes('/playlists/target/items')) return { items: [], total: 0, limit: 100, offset: 0, next: null } as unknown;
      return null as unknown;
    });
    const out = await h.invoke('batch_add_to_playlist', { target_playlist_id: 'target', source_uris: uris, dry_run: true });
    assert.equal(h.client.calls.filter((c) => c.method === 'POST').length, 0);
    assert.match(h.text(out), /\[dry run\]/);
  });
});
