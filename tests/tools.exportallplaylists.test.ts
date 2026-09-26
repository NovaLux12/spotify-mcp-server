import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { SpotifyClient } from '../src/client.js';
import type { SpotifyPaged } from '../src/types/spotify.js';
import { initConfig } from '../src/config.js';
import { registerPortabilityTools } from '../src/tools/portability.js';

type Responder = (path: string, params?: Record<string, string>) => unknown;
interface RegisteredTool {
  name: string;
  validate: (a: Record<string, unknown>) => Record<string, unknown>;
  handler: (a: Record<string, unknown>) => Promise<{ content: Array<{ type: string; text: string }>; structuredContent?: Record<string, unknown> }>;
}

/**
 * The stub's walk is client.getAllPagesWithTruncation verbatim (#864): the
 * truncation verdict is the walk's own, never `rows.length === cap`.
 */
function makeStubClient(responder: Responder) {
  const calls: Array<{ path: string }> = [];
  const client = {
    calls,
    async get<T>(p: string, params?: Record<string, string>): Promise<T | null> {
      calls.push({ path: p });
      return responder(p, params) as T | null;
    },
    async getAllPagesWithTruncation<T>(path: string, params?: Record<string, string>, opts?: { maxItems?: number }): Promise<{ items: T[]; truncated: boolean }> {
      const maxItems = opts?.maxItems ?? 500;
      const all: T[] = [];
      let offset = 0;
      for (;;) {
        const page = await (this as unknown as { get: (p: string, pr?: Record<string, string>) => Promise<SpotifyPaged<T> | null> }).get(path, { ...params, offset: String(offset) });
        if (!page || !Array.isArray(page.items)) break;
        all.push(...page.items);
        if (all.length >= maxItems) {
          return {
            items: all.slice(0, maxItems),
            truncated: all.length > maxItems || typeof page.total !== 'number' || all.length < page.total,
          };
        }
        const limit = typeof page.limit === 'number' && page.limit > 0 ? page.limit : page.items.length;
        offset += limit;
        if (page.items.length === 0 || page.items.length < limit) break;
        if (typeof page.total === 'number' && offset >= page.total) break;
      }
      return { items: all, truncated: false };
    },
    async getAllPages<T>(path: string, params?: Record<string, string>, opts?: { maxItems?: number }): Promise<T[]> {
      return (await this.getAllPagesWithTruncation<T>(path, params, opts)).items;
    },
  };
  return client;
}

function harness(responder: Responder) {
  const registered: RegisteredTool[] = [];
  const fakeServer = {
    tool(name: string, _d: string, schema: z.ZodRawShape, h: RegisteredTool['handler']) {
      registered.push({ name, validate: (a) => z.object(schema).parse(a), handler: h });
    },
  } as unknown as McpServer;
  const client = makeStubClient(responder);
  registerPortabilityTools(fakeServer, client as unknown as SpotifyClient);
  return {
    client,
    invoke: async (name: string, args: Record<string, unknown>) => {
      const t = registered.find((x) => x.name === name);
      assert.ok(t, `tool ${name} registered`);
      return t.handler(t.validate(args));
    },
  };
}

const textOf = (o: { content: Array<{ text: string }> }) => o.content[0].text;
const payloadOf = (o: { structuredContent?: Record<string, unknown> }) => o.structuredContent ?? {};

const withEnv = async <T,>(env: Record<string, string>, run: () => Promise<T>): Promise<T> => {
  const prev = { ...process.env };
  for (const k of ['SPOTIFY_MCP_PORTABILITY_DIR', 'SPOTIFY_MCP_FETCH_ALL_CAP']) delete process.env[k];
  Object.assign(process.env, env);
  initConfig(process.env);
  try {
    return await run();
  } finally {
    for (const k of Object.keys(process.env)) if (!(k in prev)) delete process.env[k];
    Object.assign(process.env, prev);
    initConfig(process.env);
  }
};

const track = (id: string, name: string, owner: string, total: number) => ({
  id,
  name,
  uri: `spotify:playlist:${id}`,
  owner: { id: owner },
  items: { total },
});

/** A paged item endpoint for a playlist holding `total` synthetic tracks. */
const itemsOf = (id: string, total: number) => (path: string, params?: Record<string, string>) => {
  if (path !== `/playlists/${id}/items`) return undefined;
  const offset = Number(params?.offset ?? 0);
  const limit = Number(params?.limit ?? 50);
  const items = Array.from({ length: Math.max(0, Math.min(limit, total - offset)) }, (_, i) => ({
    item: { uri: `spotify:track:${id}-${offset + i}`, name: `track ${offset + i}` },
  }));
  return { items, total, limit, offset };
};

const readDoc = async (dir: string) => JSON.parse(await readFile(join(dir, 'playlists.json'), 'utf8')) as {
  total: number;
  scope: string;
  scope_applied: boolean;
  items_included: boolean;
  cap: number;
  cap_reached: boolean;
  truncated: boolean;
  playlists_truncated: boolean;
  unreadable: Array<{ id: string; error: string }>;
  playlists: Array<{
    id: string;
    item_count: number | null;
    items_truncated: boolean;
    unreadable: boolean;
    items_error?: string;
    items: Array<{ uri: string; name: string }>;
  }>;
};

describe('export_all_playlists disclosure (#751)', () => {
  it('marks a playlist the cap cut short as truncated, naming it in the footer', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'eap-cap-'));
    try {
      const h = harness((path, params) => {
        if (path === '/me') return { id: 'me' };
        if (path === '/me/playlists') return { items: [track('big', 'Road Trip', 'me', 6)], total: 1, limit: 50, offset: 0 };
        return itemsOf('big', 6)(path, params);
      });
      const out = await withEnv({ SPOTIFY_MCP_PORTABILITY_DIR: dir, SPOTIFY_MCP_FETCH_ALL_CAP: '3' }, () =>
        h.invoke('export_all_playlists', { format: 'json' }),
      );
      const doc = await readDoc(dir);
      const row = doc.playlists[0];
      // 6 items exist; 3 were walked.
      assert.equal(row.item_count, 6);
      assert.equal(row.items.length, 3);
      assert.equal(row.items_truncated, true);
      assert.equal(row.unreadable, false);
      assert.equal(doc.cap, 3);
      assert.equal(doc.truncated, true);
      assert.equal(doc.cap_reached, true);
      assert.equal(doc.playlists_truncated, false, 'the playlist LIST was complete — only the item walk was capped');
      assert.match(textOf(out), /"Road Trip"/);
      assert.match(textOf(out), /cut off at 3 items/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('does not call a playlist truncated when the cap is exactly its length', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'eap-exact-'));
    try {
      const h = harness((path, params) => {
        if (path === '/me') return { id: 'me' };
        if (path === '/me/playlists') return { items: [track('exact', 'Exactly Three', 'me', 3)], total: 1, limit: 50, offset: 0 };
        return itemsOf('exact', 3)(path, params);
      });
      await withEnv({ SPOTIFY_MCP_PORTABILITY_DIR: dir, SPOTIFY_MCP_FETCH_ALL_CAP: '3' }, () =>
        h.invoke('export_all_playlists', { format: 'json' }),
      );
      const doc = await readDoc(dir);
      const row = doc.playlists[0];
      assert.equal(row.items.length, 3);
      // `items.length === cap` is not a verdict — nothing was cut off here.
      assert.equal(row.items_truncated, false);
      assert.equal(doc.truncated, false);
      assert.equal(doc.cap_reached, false);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('marks a playlist whose item walk 403s unreadable with the reason, not as empty', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'eap-403-'));
    try {
      const h = harness((path, params) => {
        if (path === '/me') return { id: 'me' };
        if (path === '/me/playlists') return { items: [track('locked', 'Collab', 'me', 40)], total: 1, limit: 50, offset: 0 };
        if (path === '/playlists/locked/items') throw new Error('403 Forbidden: playlist is not readable by this user');
        return itemsOf('locked', 40)(path, params);
      });
      const out = await withEnv({ SPOTIFY_MCP_PORTABILITY_DIR: dir, SPOTIFY_MCP_FETCH_ALL_CAP: '50' }, () =>
        h.invoke('export_all_playlists', { format: 'json' }),
      );
      const doc = await readDoc(dir);
      const row = doc.playlists[0];
      assert.equal(row.items.length, 0);
      assert.equal(row.unreadable, true);
      assert.match(String(row.items_error), /403/);
      assert.equal(row.item_count, 40, 'the total is still known even though the items are not');
      assert.equal(row.items_truncated, false, 'a failed walk truncated nothing');
      assert.deepEqual(doc.unreadable.map((u) => u.id), ['locked']);
      assert.match(textOf(out), /could not be read and were exported with NO items/);
      assert.deepEqual(payloadOf(out).unreadable, [{ id: 'locked', name: 'Collab', error: String(row.items_error) }]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('exports nothing and reports scope_applied: false when /me fails under scope=owned', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'eap-me-'));
    try {
      const h = harness((path, params) => {
        if (path === '/me') throw new Error('401 Unauthorized');
        if (path === '/me/playlists') {
          return { items: [track('mine', 'Mine', 'me', 2), track('theirs', 'Followed', 'someone-else', 2)], total: 2, limit: 50, offset: 0 };
        }
        return itemsOf(path.includes('mine') ? 'mine' : 'theirs', 2)(path, params);
      });
      const out = await withEnv({ SPOTIFY_MCP_PORTABILITY_DIR: dir }, () =>
        h.invoke('export_all_playlists', { format: 'json', scope: 'owned' }),
      );
      const payload = payloadOf(out);
      assert.equal(payload.ok, false);
      assert.equal(payload.scope_applied, false);
      assert.match(String(payload.error), /401/);
      assert.equal(h.client.calls.some((c) => c.path === '/me/playlists'), false, 'no playlist list was walked at all');
      await assert.rejects(() => readFile(join(dir, 'playlists.json'), 'utf8'), 'no sidecar was written');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('refuses scope=owned when /me resolves without a user id', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'eap-noid-'));
    try {
      const h = harness((path) => {
        if (path === '/me') return {};
        if (path === '/me/playlists') return { items: [track('theirs', 'Followed', 'someone-else', 2)], total: 1, limit: 50, offset: 0 };
        return undefined;
      });
      const out = await withEnv({ SPOTIFY_MCP_PORTABILITY_DIR: dir }, () =>
        h.invoke('export_all_playlists', { format: 'json', scope: 'owned' }),
      );
      assert.equal(payloadOf(out).scope_applied, false);
      assert.match(String(payloadOf(out).error), /without a user id/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('still filters to owned playlists when /me resolves, and says the scope was applied', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'eap-owned-'));
    try {
      const h = harness((path, params) => {
        if (path === '/me') return { id: 'me' };
        if (path === '/me/playlists') {
          return { items: [track('mine', 'Mine', 'me', 2), track('theirs', 'Followed', 'someone-else', 2)], total: 2, limit: 50, offset: 0 };
        }
        return itemsOf(path.includes('mine') ? 'mine' : 'theirs', 2)(path, params);
      });
      await withEnv({ SPOTIFY_MCP_PORTABILITY_DIR: dir }, () =>
        h.invoke('export_all_playlists', { format: 'json', scope: 'owned' }),
      );
      const doc = await readDoc(dir);
      assert.deepEqual(doc.playlists.map((p) => p.id), ['mine']);
      assert.equal(doc.scope, 'owned');
      assert.equal(doc.scope_applied, true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('says the items were not walked when include_items is false', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'eap-noitems-'));
    try {
      const h = harness((path) => {
        if (path === '/me') return { id: 'me' };
        if (path === '/me/playlists') return { items: [track('big', 'Road Trip', 'me', 600)], total: 1, limit: 50, offset: 0 };
        return undefined;
      });
      await withEnv({ SPOTIFY_MCP_PORTABILITY_DIR: dir }, () =>
        h.invoke('export_all_playlists', { format: 'json', include_items: false }),
      );
      const doc = await readDoc(dir);
      assert.equal(doc.items_included, false);
      assert.equal(doc.playlists[0].items_truncated, false, 'nothing was capped — nothing was read');
      assert.equal(doc.playlists[0].item_count, 600);
      assert.equal(doc.playlists[0].unreadable, false);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('reports the cap and the failed playlists in a CSV export too', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'eap-csv-'));
    try {
      const h = harness((path, params) => {
        if (path === '/me') return { id: 'me' };
        if (path === '/me/playlists') return { items: [track('locked', 'Collab', 'me', 40)], total: 1, limit: 50, offset: 0 };
        if (path === '/playlists/locked/items') throw new Error('403 Forbidden');
        return itemsOf('locked', 40)(path, params);
      });
      const out = await withEnv({ SPOTIFY_MCP_PORTABILITY_DIR: dir }, () =>
        h.invoke('export_all_playlists', { format: 'csv' }),
      );
      const payload = payloadOf(out);
      assert.equal(payload.cap, 500);
      assert.equal(payload.unreadable instanceof Array && (payload.unreadable as unknown[]).length, 1);
      assert.match(textOf(out), /could not be read/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
