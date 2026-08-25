/**
 * Tests for src/tools/playlistops.ts (issue #96): merge_playlists,
 * diff_playlists, overlap_playlists. Uses the same stub-client harness as
 * tests/tools.playlists-following.test.ts: the client is a plain object with
 * get/post/put/delete/getAllPages recording every wire call, and pagination
 * semantics live in the stub's getAllPages so paged fixtures are exercised
 * for real.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { SpotifyClient } from '../src/client.js';
import { registerPlaylistOpsTools } from '../src/tools/playlistops.js';
import type { PlaylistItemObject, SpotifyPaged } from '../src/types/spotify.js';

// ---------------------------------------------------------------------------
// Stub plumbing (mirrors tools.playlists-following.test.ts)
// ---------------------------------------------------------------------------

interface RecordedCall {
  method: 'GET' | 'POST' | 'PUT' | 'PUT_RAW' | 'DELETE';
  path: string;
  arg?: unknown;
}

type Responder = (path: string, arg: unknown, method?: string) => unknown;

interface RegisteredTool {
  name: string;
  description: string;
  /** Validates raw args exactly like the MCP SDK would before invoking the handler. */
  validate: (args: Record<string, unknown>) => Record<string, unknown>;
  handler: (
    args: Record<string, unknown>,
  ) => Promise<{
    content: Array<{ type: string; text: string }>;
    structuredContent?: Record<string, unknown>;
  }>;
}

const wireCalls = (calls: RecordedCall[]) =>
  calls.map((c) => ({ method: c.method, path: c.path, arg: c.arg }));

function makeStubClient(responder: Responder = () => null) {
  const calls: RecordedCall[] = [];
  let respond: Responder = responder;

  const client = {
    calls,
    setResponder(fn: Responder) {
      respond = fn;
    },
    async get<T>(path: string, params?: Record<string, string>): Promise<T | null> {
      calls.push({ method: 'GET', path, arg: params });
      return respond(path, params, 'GET') as T | null;
    },
    async post<T>(path: string, body?: unknown): Promise<T | null> {
      calls.push({ method: 'POST', path, arg: body });
      return respond(path, body, 'POST') as T | null;
    },
    async put<T>(path: string, body?: unknown): Promise<T | null> {
      calls.push({ method: 'PUT', path, arg: body });
      return respond(path, body) as T | null;
    },
    async putRaw(path: string, body: string): Promise<void> {
      calls.push({ method: 'PUT_RAW', path, arg: body });
    },
    async delete<T>(path: string, body?: unknown): Promise<T | null> {
      calls.push({ method: 'DELETE', path, arg: body });
      return respond(path, body) as T | null;
    },
    // Mirrors SpotifyClient.getAllPages over the stubbed get() so paged
    // fixtures are exercised against real pagination semantics.
    async getAllPages<T>(
      path: string,
      params?: Record<string, string>,
      opts?: { maxItems?: number; initialOffset?: number },
    ): Promise<T[]> {
      const maxItems = opts?.maxItems ?? 500;
      const all: T[] = [];
      let offset = opts?.initialOffset ?? 0;
      for (;;) {
        const page = await this.get<SpotifyPaged<T>>(path, { ...params, offset: String(offset) });
        if (!page || !Array.isArray(page.items)) break;
        all.push(...page.items);
        if (all.length >= maxItems) return all.slice(0, maxItems);
        const limit =
          typeof page.limit === 'number' && page.limit > 0 ? page.limit : page.items.length;
        offset += limit;
        if (page.items.length === 0 || page.items.length < limit) break;
        if (typeof page.total === 'number' && offset >= page.total) break;
      }
      return all;
    },
  };
  return client;
}

function harness(responder: Responder = () => null) {
  const registered: RegisteredTool[] = [];
  const fakeServer = {
    tool(
      name: string,
      description: string,
      schema: z.ZodRawShape,
      handler: RegisteredTool['handler'],
    ) {
      registered.push({
        name,
        description,
        validate: (args) => z.object(schema).parse(args),
        handler,
      });
    },
    registerTool(
      name: string,
      config: { description?: string; inputSchema?: z.ZodType },
      handler: RegisteredTool['handler'],
    ) {
      registered.push({
        name,
        description: config.description ?? '',
        validate: (args) => (config.inputSchema as z.ZodType).parse(args),
        handler,
      });
    },
  } as unknown as McpServer;
  const client = makeStubClient(responder);
  registerPlaylistOpsTools(fakeServer, client as unknown as SpotifyClient);

  return {
    registered,
    client,
    invoke: async (name: string, args: Record<string, unknown>) => {
      const tool = registered.find((t) => t.name === name);
      assert.ok(tool, `tool "${name}" should be registered`);
      return tool.handler(tool.validate(args));
    },
  };
}

const textOf = (out: { content: Array<{ text: string }> }) => out.content[0].text;

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** Minimal track item fixture — only fields the tools read are populated. */
const item = (id: string, name = `Track ${id}`) =>
  ({
    added_at: '2026-01-01T00:00:00Z',
    item: {
      type: 'track',
      id,
      name,
      uri: `spotify:track:${id}`,
      duration_ms: 200000,
      artists: [{ name: `Artist ${id}` }],
    },
  }) as unknown as PlaylistItemObject;

const unavailableItem = (): PlaylistItemObject =>
  ({ added_at: "2026-01-01T00:00:00Z", item: null }) as unknown as PlaylistItemObject;

/**
 * Responder serving each playlist's full item list in pages of `pageSize`,
 * so multi-page fixtures exercise real getAllPages loops. Mutating paths
 * fall through to `mutations` when provided.
 */
function playlistResponder(
  playlists: Record<string, PlaylistItemObject[]>,
  mutations: Responder = () => null,
  pageSize = 100,
): Responder {
  return (path, arg, method) => {
    // Only page-serve GETs against KNOWN playlists; mutating calls on other
    // paths fall through so fixtures can answer them.
    const match = method === 'GET' ? /^\/playlists\/([^/]+)\/items$/.exec(path) : null;
    if (match && decodeURIComponent(match[1]) in playlists) {
      const all = playlists[decodeURIComponent(match[1])] ?? [];
      const params = (arg ?? {}) as Record<string, string>;
      const offset = Number(params.offset ?? 0);
      const items = all.slice(offset, offset + pageSize);
      return { items, total: all.length, limit: pageSize, offset, next: null };
    }
    return mutations(path, arg);
  };
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

describe('playlistops registration', () => {
  it('registers merge_playlists, diff_playlists and overlap_playlists', () => {
    const h = harness();
    assert.deepEqual(
      h.registered.map((t) => t.name).sort(),
      ['diff_playlists', 'merge_playlists', 'overlap_playlists'],
    );
  });
});

// ---------------------------------------------------------------------------
// merge_playlists
// ---------------------------------------------------------------------------

describe('merge_playlists', () => {
  it('rejects when neither target_playlist_id nor new_name is given', async () => {
    const h = harness();
    await assert.rejects(() =>
      h.invoke('merge_playlists', { sources: ['aaa'] }),
    );
  });

  it('rejects when both target_playlist_id and new_name are given', async () => {
    const h = harness();
    await assert.rejects(() =>
      h.invoke('merge_playlists', { sources: ['aaa'], target_playlist_id: 't1', new_name: 'X' }),
    );
  });

  it('creates a new playlist and splits 250 unique tracks into 100/100/50 batches', async () => {
    const sourceA = Array.from({ length: 150 }, (_, i) => item(`a${String(i).padStart(3, '0')}`));
    const sourceB = Array.from({ length: 100 }, (_, i) => item(`b${String(i).padStart(3, '0')}`));
    const h = harness(
      playlistResponder(
        { srcA: sourceA, srcB: sourceB },
        (path, body) => {
          if (path === '/me/playlists') return { id: 'new-pl' };
          if (/^\/playlists\/new-pl\/items$/.test(path)) return { snapshot_id: 'snap-1' };
          return null;
        },
        // pageSize 60 forces more pages than batches: paging ≠ batching
        60,
      ),
    );

    const out = await h.invoke('merge_playlists', {
      sources: ['srcA', 'spotify:playlist:srcB'],
      new_name: 'Merged',
      public: true,
    });

    const posts = wireCalls(h.client.calls).filter((c) => c.method === 'POST');
    assert.equal(posts.length, 4); // 1 create + 3 add batches
    assert.equal(posts[0].path, '/me/playlists');
    assert.deepEqual(posts[0].arg, { name: 'Merged', public: true });

    const batchPosts = posts.slice(1);
    assert.equal(batchPosts[0].path, '/playlists/new-pl/items');
    const sizes = batchPosts.map((c) => (c.arg as { uris: string[] }).uris.length);
    assert.deepEqual(sizes, [100, 100, 50]);
    // First-seen order across sources is preserved through batching.
    assert.equal(
      (batchPosts[0].arg as { uris: string[] }).uris[0],
      'spotify:track:a000',
    );
    assert.equal(
      (batchPosts[2].arg as { uris: string[] }).uris[49],
      'spotify:track:b099',
    );
    assert.match(textOf(out), /250 unique track\(s\)/);
    assert.match(textOf(out), /Snapshot ID: snap-1/);
  });

  it('dedupes by track key preserving first-seen order across sources', async () => {
    const srcA = [item('t1'), item('t2'), item('t3')];
    const srcB = [item('t2'), item('t4'), item('t1')];
    const h = harness(
      playlistResponder({ sa: srcA, sb: srcB }, (path) =>
        /^\/playlists\/tgt/.test(path) ? { snapshot_id: 's' } : null,
      ),
    );

    await h.invoke('merge_playlists', {
      sources: ['sa', 'sb'],
      target_playlist_id: 'spotify:playlist:tgt',
    });

    const batchPosts = wireCalls(h.client.calls).filter(
      (c) => c.method === 'POST' && /\/items$/.test(c.path),
    );
    assert.deepEqual((batchPosts[0].arg as { uris: string[] }).uris, [
      'spotify:track:t1',
      'spotify:track:t2',
      'spotify:track:t3',
      'spotify:track:t4',
    ]);
  });

  it('appends to an existing target without clearing it (no PUT)', async () => {
    const srcA = [item('x1')];
    const tgt = [item('existing')];
    const h = harness(playlistResponder({ sa: srcA, tgt }, () => ({ snapshot_id: 's' })));

    await h.invoke('merge_playlists', { sources: ['sa'], target_playlist_id: 'tgt' });

    assert.equal(
      wireCalls(h.client.calls).filter((c) => c.method === 'PUT').length,
      0,
      'append semantics must never PUT/clear the target',
    );
    assert.ok(wireCalls(h.client.calls).some((c) => c.method === 'POST' && /tgt\/items$/.test(c.path)));
  });

  it('normalizes spotify:playlist: URIs into IDs on the wire', async () => {
    const h = harness(
      playlistResponder({ pl9: [item('z1')] }, () => ({ snapshot_id: 's' })),
    );
    await h.invoke('merge_playlists', {
      sources: ['spotify:playlist:pl9'],
      target_playlist_id: 'spotify:playlist:tgt2',
    });
    const gets = wireCalls(h.client.calls)
      .filter((c) => c.method === 'GET')
      .map((c) => c.path);
    assert.ok(gets.includes('/playlists/pl9/items'));
    assert.ok(gets.every((p) => !p.includes('spotify%3A')));
    assert.ok(
      wireCalls(h.client.calls).some(
        (c) => c.method === 'POST' && c.path === '/playlists/tgt2/items',
      ),
    );
  });

  it('dry_run reads sources but makes zero mutating calls and previews additions', async () => {
    const srcA = [item('d1'), item('d2')];
    const srcB = [item('d2'), unavailableItem()];
    const h = harness(playlistResponder({ da: srcA, db: srcB }));

    const out = await h.invoke('merge_playlists', {
      sources: ['da', 'db'],
      new_name: 'Preview',
      dry_run: true,
    });

    const text = textOf(out);
    assert.match(text, /^\[dry run\] merge_playlists — nothing was changed\./);
    assert.match(text, /Would create private playlist "Preview" and add 2 track\(s\)/);
    assert.match(text, /spotify:track:d1/);
    assert.match(text, /1 duplicate\(s\) across sources would be skipped/);
    assert.equal(out.structuredContent!.ok, true);
    assert.equal(out.structuredContent!.dry_run, true);
    assert.ok(Array.isArray(out.structuredContent!.changes));
    assert.ok(out.structuredContent!.changes.length >= 2);

    const methods = wireCalls(h.client.calls).map((c) => c.method);
    assert.equal(methods.filter((m) => m !== 'GET').length, 0, 'no POST/PUT/DELETE allowed');
    assert.ok(methods.filter((m) => m === 'GET').length >= 2, 'sources were read');
  });

  it('max_results caps rendered rows while totals stay accurate', async () => {
    const srcA = Array.from({ length: 5 }, (_, i) => item(`m${i}`));
    const h = harness(playlistResponder({ ma: srcA }, () => ({ snapshot_id: 's' })));

    const out = await h.invoke('merge_playlists', {
      sources: ['ma'],
      target_playlist_id: 'tgt3',
      response_format: 'concise',
      max_results: 2,
    });
    const text = textOf(out);
    assert.match(text, /5 unique track\(s\)/);
    assert.match(text, /3 more/);
    assert.equal((text.match(/spotify:track:m\d/g) ?? []).length, 5); // batchSummary previews 3 + 2 rendered rows
  });
});

// ---------------------------------------------------------------------------
// diff_playlists
// ---------------------------------------------------------------------------

describe('diff_playlists', () => {
  it('reports symmetric only-in-a / only-in-b sets and no false moved rows', async () => {
    const a = [item('a1'), item('b2'), item('c3')];
    const b = [item('b2'), item('c3'), item('d4')];
    const h = harness(playlistResponder({ pa: a, pb: b }));

    const out = await h.invoke('diff_playlists', { a: 'pa', b: 'pb' });
    const text = textOf(out);
    assert.match(text, /Only in A \(1\)/);
    assert.match(text, /a1 @ position 0/);
    assert.match(text, /Only in B \(1\)/);
    assert.match(text, /d4 @ position 2/);
    assert.match(text, /Moved \(same track, different position\) \(2\)/);
    assert.match(text, /b2 @ A:1 → B:0/);
    assert.match(text, /c3 @ A:2 → B:1/);

    // Identical playlists produce empty sections everywhere.
    const same = await h.invoke('diff_playlists', { a: 'pa', b: 'pa' });
    assert.match(textOf(same), /Only in A \(0\):\n  \(none\)/);
    assert.match(textOf(same), /Moved \(same track, different position\) \(0\)/);
  });

  it('flags shared tracks whose positions differ, with accurate totals', async () => {
    const a = [item('x1'), item('x2'), item('x3')];
    const b = [item('x3'), item('x1'), item('x2')];
    const h = harness(playlistResponder({ pa: a, pb: b }));

    const out = await h.invoke('diff_playlists', { a: 'pa', b: 'pb', response_format: 'json' });
    const data = JSON.parse(textOf(out)) as {
      a_total: number;
      b_total: number;
      only_in_a: string[];
      only_in_b: string[];
      moved: Array<{ id: string; a_position: number; b_position: number }>;
    };
    assert.equal(data.a_total, 3);
    assert.equal(data.b_total, 3);
    assert.deepEqual(data.only_in_a, []);
    assert.deepEqual(data.only_in_b, []);
    assert.deepEqual(data.moved, [
      { id: 'x1', a_position: 0, b_position: 1 },
      { id: 'x2', a_position: 1, b_position: 2 },
      { id: 'x3', a_position: 2, b_position: 0 },
    ]);
  });

  it('caps rendered rows per section via max_results but keeps totals exact', async () => {
    const a = [item('o1'), item('o2'), item('o3'), item('shared')];
    const b = [item('q1'), item('q2'), item('q3'), item('shared')];
    const h = harness(playlistResponder({ pa: a, pb: b }));

    const out = await h.invoke('diff_playlists', { a: 'pa', b: 'pb', max_results: 1 });
    const text = textOf(out);
    assert.match(text, /Only in A \(3\):/);
    assert.match(text, /Only in B \(3\):/);
    assert.match(text, /2 more/);
    // exactly one row per capped section
    assert.equal((text.match(/@ position \d+/g) ?? []).length, 2);
  });

  it('never issues mutating calls even with dry_run set', async () => {
    const a = [item('r1')];
    const b = [item('r2')];
    const h = harness(playlistResponder({ pa: a, pb: b }));
    await h.invoke('diff_playlists', { a: 'pa', b: 'pb', dry_run: true });
    assert.equal(
      wireCalls(h.client.calls).filter((c) => c.method !== 'GET').length,
      0,
    );
  });

  it('pages both playlists fully across multiple pages', async () => {
    const many = (prefix: string, n: number) =>
      Array.from({ length: n }, (_, i) => item(`${prefix}${String(i).padStart(3, '0')}`));
    const a = [...many('a', 120)];
    const b = [...many('a', 120).slice(30), ...many('b', 10)];
    const h = harness(playlistResponder({ pa: a, pb: b }, () => null, 50));

    const out = await h.invoke('diff_playlists', { a: 'pa', b: 'pb', response_format: 'json' });
    const data = JSON.parse(textOf(out)) as { a_total: number; b_total: number; only_in_b: string[] };
    assert.equal(data.a_total, 120);
    assert.equal(data.b_total, 100);
    assert.equal(data.only_in_b.length, 10);
  });
});

// ---------------------------------------------------------------------------
// overlap_playlists
// ---------------------------------------------------------------------------

describe('overlap_playlists', () => {
  const fixtures = () => ({
    p1: [item('y2'), item('x1')],
    p2: [item('y2'), item('z3')],
    p3: [item('w4'), item('y2'), item('x1')],
  });

  it('defaults threshold to all playlists and sorts by occurrence count', async () => {
    const h = harness(playlistResponder(fixtures()));
    const out = await h.invoke('overlap_playlists', {
      playlists: ['p1', 'p2', 'p3'],
    });
    const text = textOf(out);
    assert.match(text, /at least 3 of 3 playlists: 1/);
    assert.match(text, /y2 "Track y2" — in 3\/3 playlists/);
  });

  it('honors min_overlap=2 and orders most-shared first', async () => {
    const h = harness(playlistResponder(fixtures()));
    const out = await h.invoke('overlap_playlists', {
      playlists: ['p1', 'p2', 'p3'],
      min_overlap: 2,
    });
    const ids = (textOf(out).match(/• ([xyzw]\d)/g) ?? []).map((l) => l.replace('• ', ''));
    assert.deepEqual(ids, ['y2', 'x1']);
  });

  it('json mode returns raw counts per track', async () => {
    const h = harness(playlistResponder(fixtures()));
    const out = await h.invoke('overlap_playlists', {
      playlists: ['p1', 'p2', 'p3'],
      min_overlap: 1,
      response_format: 'json',
    });
    const data = JSON.parse(textOf(out)) as {
      threshold: number;
      total_shared: number;
      shared: Array<{ id: string; count: number }>;
    };
    assert.equal(data.threshold, 1);
    assert.equal(data.total_shared, 4);
    assert.deepEqual(data.shared[0], { id: 'y2', name: 'Track y2', count: 3 });
  });

  it('rejects min_overlap above the number of playlists', async () => {
    const h = harness(playlistResponder(fixtures()));
    await assert.rejects(
      () =>
        h.invoke('overlap_playlists', {
          playlists: ['p1', 'p2'],
          min_overlap: 3,
        }),
      /cannot exceed/,
    );
  });

  it('accepts URI references and requires at least two playlists', async () => {
    const h = harness(playlistResponder(fixtures()));
    const out = await h.invoke('overlap_playlists', {
      playlists: ['spotify:playlist:p1', 'spotify:playlist:p3'],
    });
    assert.match(textOf(out), /at least 2 of 2 playlists/);
    await assert.rejects(() =>
      h.invoke('overlap_playlists', { playlists: ['p1'] }),
    );
  });

  it('makes zero mutating calls even with dry_run set', async () => {
    const h = harness(playlistResponder(fixtures()));
    await h.invoke('overlap_playlists', {
      playlists: ['p1', 'p2'],
      dry_run: true,
    });
    assert.equal(
      wireCalls(h.client.calls).filter((c) => c.method !== 'GET').length,
      0,
    );
  });
});
