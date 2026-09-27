/**
 * Tests for src/tools/playlistops.ts (issue #96): merge_playlists,
 * diff_playlists, overlap_playlists. Uses the same stub-client harness as
 * tests/tools.playlists-following.test.ts: the client is a plain object with
 * get/post/put/delete/getAllPages recording every wire call, and pagination
 * semantics live in the stub's getAllPages so paged fixtures are exercised
 * for real.
 */
import './helpers/hermetic.js';

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { StubFromResponder } from './helpers/stub-client.js';
import type { LegacyResponder } from './helpers/stub-client.js';
import type { SpotifyClient } from '../src/client.js';
import { SpotifyApiError } from '../src/client.js';
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

/** Per-call walk options, matching the real client's `GetAllPagesOptions`. */
interface PageWalkOptions {
  maxItems?: number;
  initialOffset?: number;
  onPage?: (info: { page: number; fetched: number }) => void;
}

function makeStubClient(responder: Responder = () => null) {
  // #659: the shared stub. `getAllPages` is INHERITED from SpotifyClient, so the
  // cap comes from `getConfig().fetchAllCap` and the short-page / total breaks
  // are the production ones. This file's hand-copied loop (hardcoded `?? 500`)
  // could not catch a regression in any of that.
  const client = new StubFromResponder(responder as LegacyResponder, {
    writes: {
    POST: responder as LegacyResponder,
    PUT: responder as LegacyResponder,
    DELETE: responder as LegacyResponder,
    PUT_RAW: () => undefined,
    },
  });
  return { calls: client.calls, client };
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
  const stub = makeStubClient(responder);
  registerPlaylistOpsTools(fakeServer, stub.client);

  return {
    registered,
    client: stub.client,
    calls: stub.calls,
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

const SRC_A = 'A'.repeat(22);
const SRC_B = 'B'.repeat(22);
const SRC_C = 'C'.repeat(22);
const SRC_D = 'F'.repeat(22);
const TARGET = 'T'.repeat(22);
const PL9 = 'P'.repeat(22);
const TARGET_2 = 'U'.repeat(22);
const DRY_A = 'D'.repeat(22);
const DRY_B = 'E'.repeat(22);
const MAX_A = 'M'.repeat(22);
const PAIR_A = 'Q'.repeat(22);
const PAIR_B = 'R'.repeat(22);
const OVERLAP_1 = '1'.repeat(22);
const OVERLAP_2 = '2'.repeat(22);
const OVERLAP_3 = '3'.repeat(22);
const PARTIAL_A = 'N'.repeat(22);


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
// #902 fixtures: a server that honours `fields`, and tracks nested reads
// ---------------------------------------------------------------------------

/** The exact `fields` merge_playlists must send on every source item page. */
const MERGE_ITEM_FIELDS = 'items(item(uri,name)),limit,next,total';

/** Fields a projection-agnostic walk needs for its end-of-data and truncation tests. */
const PAGE_META_FIELDS = ['limit', 'total'];

/**
 * An item whose nested track payload is behind getters that record every
 * read. A merge that projects down to `uri`/`name` never touches them, so
 * the log stays empty; a merge that reaches into `album`/`artists` is caught
 * even when the surrounding rows happen to be correct.
 */
function trackedItem(touches: string[], id: string, name = `Track ${id}`): PlaylistItemObject {
  const track: Record<string, unknown> = {
    type: 'track',
    id,
    name,
    uri: `spotify:track:${id}`,
    duration_ms: 200000,
  };
  const nested: Record<string, unknown> = {
    album: { name: 'Nested Album', images: [{ url: 'https://example.invalid/c.jpg' }] },
    artists: [{ name: 'Nested Artist' }],
    added_at: '2026-01-01T00:00:00Z',
    external_ids: { isrc: 'ISRC0' },
  };
  for (const [key, value] of Object.entries(nested)) {
    Object.defineProperty(track, key, {
      enumerable: true,
      configurable: true,
      get() {
        touches.push(key);
        return value;
      },
    });
  }
  return { added_at: '2026-01-01T00:00:00Z', item: track } as unknown as PlaylistItemObject;
}

/**
 * A responder that behaves the way Spotify does with a `fields` filter: a
 * projected page comes back with ONLY the requested item fields, an
 * unprojected one with the full track objects.
 *
 * `DECOY` is the point. If the merge stopped sending `fields`, it would be
 * served the unprojected rows and every name would arrive suffixed — so the
 * assertion on merged names fails instead of passing by luck on data the
 * two payloads happen to share.
 */
function projectingResponder(
  playlists: Record<string, PlaylistItemObject[]>,
  mutations: Responder = () => null,
  pageSize = 100,
): Responder {
  return (path, arg, method) => {
    const match = method === 'GET' ? /^\/playlists\/([^/]+)\/items$/.exec(path) : null;
    if (match && decodeURIComponent(match[1]) in playlists) {
      const all = playlists[decodeURIComponent(match[1])] ?? [];
      const params = (arg ?? {}) as Record<string, string>;
      const offset = Number(params.offset ?? 0);
      const page = all.slice(offset, offset + pageSize);
      const fields = typeof params.fields === 'string' ? params.fields : null;
      const projected = fields !== null && fields.includes('item(uri,name)');
      const kept = (name: string) =>
        fields === null || fields.split(',').some((f) => f.trim() === name);
      const meta: Record<string, unknown> = {};
      // A real `fields` filter drops anything not asked for, page metadata
      // included — so a projection that forgot `limit`/`total` would come
      // back without them here, exactly as it would from Spotify.
      for (const name of PAGE_META_FIELDS) {
        if (kept(name)) meta[name] = name === 'total' ? all.length : pageSize;
      }
      if (kept('next')) meta.next = null;
      const items = page.map((row) => {
        const track = row.item as unknown as Record<string, unknown> | null;
        if (track === null) return { item: null } as unknown as PlaylistItemObject;
        if (projected) {
          return { item: { uri: track.uri, name: track.name } } as unknown as PlaylistItemObject;
        }
        // Unprojected: the whole track object, name decorated. The clone
        // copies property DESCRIPTORS, so it carries the same nested getters
        // without invoking them here.
        const full = Object.create(
          Object.getPrototypeOf(track),
          Object.getOwnPropertyDescriptors(track),
        ) as Record<string, unknown>;
        full.name = `${String(track.name)} DECOY`;
        return { item: full } as unknown as PlaylistItemObject;
      });
      return { items, ...meta };
    }
    return mutations(path, arg);
  };
}

/** GETs against a playlist's items, in the order the client issued them. */
const itemPageGets = (calls: RecordedCall[]) =>
  wireCalls(calls).filter((c) => c.method === 'GET' && /\/items$/.test(c.path));

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
      h.invoke('merge_playlists', { sources: [SRC_A] }),
    );
  });

  it('rejects when both target_playlist_id and new_name are given', async () => {
    const h = harness();
    await assert.rejects(() =>
      h.invoke('merge_playlists', { sources: [SRC_A], target_playlist_id: TARGET, new_name: 'X' }),
    );
  });

  it('creates a new playlist and splits 250 unique tracks into 100/100/50 batches', async () => {
    const sourceA = Array.from({ length: 150 }, (_, i) => item(`a${String(i).padStart(3, '0')}`));
    const sourceB = Array.from({ length: 100 }, (_, i) => item(`b${String(i).padStart(3, '0')}`));
    const h = harness(
      playlistResponder(
        { [SRC_A]: sourceA, [SRC_B]: sourceB },
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
      sources: [SRC_A, `spotify:playlist:${SRC_B}`],
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
      playlistResponder({ [SRC_A]: srcA, [SRC_B]: srcB }, (path) =>
        path.startsWith(`/playlists/${TARGET}`) ? { snapshot_id: 's' } : null,
      ),
    );

    await h.invoke('merge_playlists', {
      sources: [SRC_A, SRC_B],
      target_playlist_id: `spotify:playlist:${TARGET}`,
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
    const h = harness(playlistResponder({ [SRC_A]: srcA, [TARGET]: tgt }, () => ({ snapshot_id: 's' })));

    await h.invoke('merge_playlists', { sources: [SRC_A], target_playlist_id: TARGET });

    assert.equal(
      wireCalls(h.client.calls).filter((c) => c.method === 'PUT').length,
      0,
      'append semantics must never PUT/clear the target',
    );
    assert.ok(wireCalls(h.client.calls).some((c) => c.method === 'POST' && c.path === `/playlists/${TARGET}/items`));
  });

  it('normalizes spotify:playlist: URIs into IDs on the wire', async () => {
    const h = harness(
      playlistResponder({ [PL9]: [item('z1')] }, () => ({ snapshot_id: 's' })),
    );
    await h.invoke('merge_playlists', {
      sources: [`spotify:playlist:${PL9}`],
      target_playlist_id: `spotify:playlist:${TARGET_2}`,
    });
    const gets = wireCalls(h.client.calls)
      .filter((c) => c.method === 'GET')
      .map((c) => c.path);
    assert.ok(gets.includes(`/playlists/${PL9}/items`));
    assert.ok(gets.every((p) => !p.includes('spotify%3A')));
    assert.ok(
      wireCalls(h.client.calls).some(
        (c) => c.method === 'POST' && c.path === `/playlists/${TARGET_2}/items`,
      ),
    );
  });

  it('dry_run reads sources but makes zero mutating calls and previews additions', async () => {
    const srcA = [item('d1'), item('d2')];
    const srcB = [item('d2'), unavailableItem()];
    const h = harness(playlistResponder({ [DRY_A]: srcA, [DRY_B]: srcB }));

    const out = await h.invoke('merge_playlists', {
      sources: [DRY_A, DRY_B],
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

  it('honors scan_cap and reports truncated source walks', async () => {
    const h = harness(playlistResponder({
      [DRY_A]: [item('d1'), item('d2')],
      [DRY_B]: [item('d3')],
    }));
    const out = await h.invoke('merge_playlists', {
      playlists: [DRY_A, DRY_B],
      new_name: 'Capped',
      dry_run: true,
      scan_cap: 1,
    });
    assert.equal(out.structuredContent?.truncated, true);
    assert.equal(out.structuredContent?.scan_cap, 1);
    // DRY_A holds 2 rows and DRY_B holds 1, so the combined total is 3 and
    // the cap leaves 2 — the disclosure must name both, not the cap alone.
    assert.equal(out.structuredContent?.rows_read, 2);
    assert.equal(out.structuredContent?.reported_total, 3);
    assert.match(textOf(out), /cap of 1 row\(s\) per source/);
    assert.match(textOf(out), /read 2 of 3 row\(s\)/);
  });

  it('max_results caps rendered rows while totals stay accurate', async () => {
    const srcA = Array.from({ length: 5 }, (_, i) => item(`m${i}`));
    const h = harness(playlistResponder({ [MAX_A]: srcA }, () => ({ snapshot_id: 's' })));

    const out = await h.invoke('merge_playlists', {
      sources: [MAX_A],
      target_playlist_id: TARGET,
      response_format: 'concise',
      max_results: 2,
    });
    const text = textOf(out);
    assert.match(text, /5 unique track\(s\)/);
    assert.match(text, /3 more/);
    assert.equal((text.match(/spotify:track:m\d/g) ?? []).length, 5); // batchSummary previews 3 + 2 rendered rows
  });

  // #865 — the unguarded batch loop left no way to tell a partial merge
  // from a complete one when a later batch rejected.
  describe('partial write state (#865)', () => {
    const bigSource = Array.from({ length: 150 }, (_, i) => item(`p${String(i).padStart(3, '0')}`));
    const bigUris = bigSource.map((it) => (it.item as { uri: string }).uri);

    it('reports the committed prefix when a later batch rejects', async () => {
      let batchCount = 0;
      const h = harness(
        playlistResponder({ [PARTIAL_A]: bigSource }, (path) => {
          if (path === `/playlists/${TARGET}/items`) {
            batchCount++;
            if (batchCount === 1) return { snapshot_id: 'snap-1' };
            throw new SpotifyApiError(503, 'Service Unavailable');
          }
          return { snapshot_id: 's' };
        }),
      );

      const out = await h.invoke('merge_playlists', {
        sources: [PARTIAL_A],
        target_playlist_id: TARGET,
      });
      const p = out.structuredContent!;
      assert.equal(p.partial_write_failure, true);
      assert.equal(p.attempted_chunks, 2);
      assert.equal(p.failed_chunk_index, 1);
      assert.equal(p.last_committed_chunk_index, 0);
      assert.deepEqual(p.last_committed_chunk_uris, bigUris.slice(0, 100));
      assert.equal(p.committed_uris, 100);
      assert.equal(p.remaining_uris, 50);
      assert.equal(p.attempted_uris, 150);
      assert.match(String(p.error), /Service Unavailable/);
      assert.match(textOf(out), /Partial merge into playlist/);
      assert.match(textOf(out), /batch 2 of 2 failed/);
      // The helper aborts at the failing chunk — no further batch was issued.
      assert.equal(batchCount, 2);
    });

    it('reports nothing committed when the first batch rejects', async () => {
      const h = harness(
        playlistResponder({ [PARTIAL_A]: bigSource }, (path) => {
          if (path === `/playlists/${TARGET}/items`) throw new SpotifyApiError(403, 'Forbidden');
          return { snapshot_id: 's' };
        }),
      );

      const out = await h.invoke('merge_playlists', {
        sources: [PARTIAL_A],
        target_playlist_id: TARGET,
      });
      const p = out.structuredContent!;
      assert.equal(p.partial_write_failure, true);
      assert.equal(p.failed_chunk_index, 0);
      assert.equal(p.last_committed_chunk_index, -1);
      assert.deepEqual(p.last_committed_chunk_uris, []);
      assert.equal(p.committed_uris, 0);
      assert.equal(p.remaining_uris, 150);
      assert.match(textOf(out), /aborted before any track landed/);
    });

    it('reports the committed prefix in json response_format too', async () => {
      let batchCount = 0;
      const h = harness(
        playlistResponder({ [PARTIAL_A]: bigSource }, (path) => {
          if (path === `/playlists/${TARGET}/items`) {
            batchCount++;
            if (batchCount === 1) return { snapshot_id: 'snap-1' };
            throw new SpotifyApiError(429, 'Rate limited');
          }
          return { snapshot_id: 's' };
        }),
      );

      const out = await h.invoke('merge_playlists', {
        sources: [PARTIAL_A],
        target_playlist_id: TARGET,
        response_format: 'json',
      });
      const parsed = JSON.parse(textOf(out));
      assert.equal(parsed.partial_write_failure, true);
      assert.equal(parsed.failed_chunk_index, 1);
      assert.equal(parsed.committed_uris, 100);
      assert.equal(out.structuredContent!.partial_write_failure, true);
    });
  });
});

// ---------------------------------------------------------------------------
// merge_playlists — streaming read phase (#902)
// ---------------------------------------------------------------------------

describe('merge_playlists source walk (#902)', () => {
  it('interleaves the source walks: every source\'s first page is requested before any second page', async () => {
    // Four sources, two pages each (pageSize 60 over 120 items). A serial
    // walk would issue A/0, A/60, B/0, B/60 …; the interleaved one puts all
    // four first pages in flight in the same tick.
    const sources = [SRC_A, SRC_B, SRC_C, SRC_D];
    const playlists: Record<string, PlaylistItemObject[]> = {};
    sources.forEach((id, s) => {
      playlists[id] = Array.from({ length: 120 }, (_, i) => item(`${id}${i}`));
    });
    const h = harness(playlistResponder(playlists, () => ({ snapshot_id: 's' }), 60));

    const out = await h.invoke('merge_playlists', {
      sources,
      target_playlist_id: TARGET,
      response_format: 'json',
    });

    const gets = itemPageGets(h.client.calls);
    const opening = gets.slice(0, 4);
    assert.deepEqual(
      opening.map((c) => c.path),
      sources.map((id) => `/playlists/${id}/items`),
      'all four sources must have their first page requested before any second page',
    );
    assert.deepEqual(opening.map((c) => (c.arg as Record<string, string>).offset), ['0', '0', '0', '0']);
    // 4 sources x 2 pages: the interleaving must not add or drop requests.
    assert.equal(gets.length, 8);
    assert.equal(out.structuredContent!.requests_read, 8);
    assert.equal(out.structuredContent!.added, 480);
  });

  it('keeps first-seen order across sources even though the walks interleave', async () => {
    const h = harness(
      playlistResponder(
        {
          [SRC_A]: [item('t1'), item('t2'), item('t3')],
          [SRC_B]: [item('t2'), item('t4'), item('t1')],
          [SRC_C]: [item('t5')],
        },
        () => ({ snapshot_id: 's' }),
        2,
      ),
    );

    await h.invoke('merge_playlists', {
      sources: [SRC_A, SRC_B, SRC_C],
      target_playlist_id: TARGET,
    });

    const batch = wireCalls(h.client.calls).find(
      (c) => c.method === 'POST' && /\/items$/.test(c.path),
    );
    assert.deepEqual((batch!.arg as { uris: string[] }).uris, [
      'spotify:track:t1',
      'spotify:track:t2',
      'spotify:track:t3',
      'spotify:track:t4',
      'spotify:track:t5',
    ]);
  });

  it('reads only uri/name off a source item, never the nested track payload', async () => {
    // This responder serves the FULL track objects, nested fields and all,
    // so the getters behind album/artists/added_at/external_ids are reachable
    // and every read of one is recorded. The merge must never make one.
    const touches: string[] = [];
    const srcA = Array.from({ length: 3 }, (_, i) => trackedItem(touches, `p${i}`, `P${i}`));
    const srcB = Array.from({ length: 2 }, (_, i) => trackedItem(touches, `q${i}`, `Q${i}`));
    const h = harness(playlistResponder({ [SRC_A]: srcA, [SRC_B]: srcB }, () => ({ snapshot_id: 's' }), 2));

    const out = await h.invoke('merge_playlists', {
      sources: [SRC_A, SRC_B],
      target_playlist_id: TARGET,
    });

    assert.deepEqual(
      touches,
      [],
      'the merge consumed only uri/name — no album/artists/added_at/external_ids was read',
    );
    assert.equal(out.structuredContent!.added, 5);
  });

  it('projects every source item page down to uri+name on the wire', async () => {
    const touches: string[] = [];
    const srcA = Array.from({ length: 3 }, (_, i) => trackedItem(touches, `p${i}`, `P${i}`));
    const srcB = Array.from({ length: 2 }, (_, i) => trackedItem(touches, `q${i}`, `Q${i}`));
    const h = harness(
      projectingResponder({ [SRC_A]: srcA, [SRC_B]: srcB }, () => ({ snapshot_id: 's' }), 2),
    );

    const out = await h.invoke('merge_playlists', {
      sources: [SRC_A, SRC_B],
      target_playlist_id: TARGET,
    });

    const gets = itemPageGets(h.client.calls);
    assert.ok(gets.length >= 3, 'sources really are multi-page here');
    for (const get of gets) {
      assert.equal(
        (get.arg as Record<string, string>).fields,
        MERGE_ITEM_FIELDS,
        `source page ${get.path} must carry the fields projection`,
      );
    }
    // Names came from the PROJECTED payload. `projectingResponder` suffixes
    // every name with DECOY when a page is requested unprojected, so a merge
    // that stopped sending `fields` fails here instead of matching by luck.
    assert.equal(out.structuredContent!.added, 5);
    assert.match(textOf(out), /spotify:track:p0 "P0"/);
    assert.doesNotMatch(textOf(out), /DECOY/);
  });

  it('reports requests_read as the measured page count, including capped walks', async () => {
    // Source A: 5 rows at pageSize 2 → 3 pages (the last is short).
    // Source B: 3 rows at pageSize 2 → 2 pages.
    const h = harness(
      playlistResponder(
        {
          [SRC_A]: Array.from({ length: 5 }, (_, i) => item(`r${i}`)),
          [SRC_B]: Array.from({ length: 3 }, (_, i) => item(`s${i}`)),
        },
        () => ({ snapshot_id: 's' }),
        2,
      ),
    );

    const out = await h.invoke('merge_playlists', {
      sources: [SRC_A, SRC_B],
      target_playlist_id: TARGET,
    });
    assert.equal(itemPageGets(h.client.calls).length, 5);
    assert.equal(out.structuredContent!.requests_read, 5);
    assert.match(textOf(out), /after 5 source page request\(s\)/);
  });

  it('reports requests_read in the dry-run payload, where it is the whole cost', async () => {
    const h = harness(
      playlistResponder({ [SRC_A]: [item('d1'), item('d2')] }, () => null, 1),
    );

    const out = await h.invoke('merge_playlists', {
      sources: [SRC_A],
      new_name: 'Preview',
      dry_run: true,
    });
    assert.equal(itemPageGets(h.client.calls).length, 2);
    assert.equal(out.structuredContent!.requests_read, 2);
  });

  it('counts a capped walk as the pages it actually spent, not the pages the cap implies', async () => {
    // scan_cap 1 asks for one row; the walk still spends exactly one page
    // because the cap is applied to what it accumulates, not to how it pages.
    const h = harness(
      playlistResponder({ [SRC_A]: [item('c1'), item('c2'), item('c3')] }, () => null, 2),
    );

    const out = await h.invoke('merge_playlists', {
      sources: [SRC_A],
      new_name: 'Capped',
      dry_run: true,
      scan_cap: 1,
    });
    assert.equal(out.structuredContent!.truncated, true);
    assert.equal(out.structuredContent!.requests_read, 1);
  });

  // ---------------------------------------------------------------------
  // #902: the cap is per SOURCE, so the combined total is a sum. These are
  // the tests that make a per-source cap which is never accumulated across
  // sources impossible to ship — a single source cannot catch that class,
  // because one source's cap and the combined cap are the same number.
  // ---------------------------------------------------------------------

  it('caps each source separately and discloses the TRUE combined total', async () => {
    // 4 sources x 25 rows, pageSize 5, scan_cap 10. The cap binds on every
    // source, so each walk stops at 10 of its own 25 — 40 rows read against a
    // true combined 100. A merge that treated the cap as a budget for the
    // whole merge would read 10 rows total and report success; a merge that
    // reported the cap alone would claim 10 rows when 100 exist.
    const sources = [SRC_A, SRC_B, SRC_C, SRC_D];
    const playlists: Record<string, PlaylistItemObject[]> = {};
    sources.forEach((id, s) => {
      playlists[id] = Array.from({ length: 25 }, (_, i) => item(`s${s}r${i}`));
    });
    const h = harness(playlistResponder(playlists, () => ({ snapshot_id: 's' }), 5));

    const out = await h.invoke('merge_playlists', {
      sources,
      target_playlist_id: TARGET,
      scan_cap: 10,
    });

    const sc = out.structuredContent!;
    assert.equal(sc.truncated, true);
    assert.equal(sc.truncated_by_cap, true);
    // The SUM, not the cap and not one source's count.
    assert.equal(sc.rows_read, 40);
    assert.equal(sc.reported_total, 100);
    // 4 sources x 3 pages each (the cap binds on the third).
    assert.equal(sc.requests_read, 12);
    assert.equal(sc.added, 40);

    // The disclosure names both numbers, and says the missing rows are absent
    // from the merge rather than hinting the totals might be off.
    const note = textOf(out);
    assert.match(note, /read 40 of 100 row\(s\)/);
    assert.match(note, /60 row\(s\) are NOT in this result/);
    assert.match(note, /cap of 10 row\(s\) per source/);
    // The cap applies per source, so the destination gets 10 from EACH.
    const posted = wireCalls(h.client.calls)
      .filter((c) => c.method === 'POST' && /\/items$/.test(c.path))
      .flatMap((c) => (c.arg as { uris: string[] }).uris);
    assert.equal(posted.length, 40);
    assert.deepEqual(
      posted,
      sources.flatMap((_, s) => Array.from({ length: 10 }, (_, i) => `spotify:track:s${s}r${i}`)),
      'each source contributed its own capped prefix, in the order listed',
    );
  });

  it('previews the same combined total under dry_run, where the cap decides the answer', async () => {
    const sources = [SRC_A, SRC_B, SRC_C];
    const playlists: Record<string, PlaylistItemObject[]> = {};
    sources.forEach((id, s) => {
      playlists[id] = Array.from({ length: 20 }, (_, i) => item(`p${s}r${i}`));
    });
    const h = harness(playlistResponder(playlists, () => null, 5));

    const out = await h.invoke('merge_playlists', {
      sources,
      new_name: 'Preview',
      dry_run: true,
      scan_cap: 10,
    });

    const sc = out.structuredContent!;
    assert.equal(sc.rows_read, 30);
    assert.equal(sc.reported_total, 60);
    assert.equal(sc.truncated, true);
    assert.match(textOf(out), /read 30 of 60 row\(s\)/);
    assert.match(textOf(out), /30 row\(s\) are NOT in this result/);
  });

  it('leaves the combined total unknown — never overstated — when a source reports no total', async () => {
    // A page with no `total` (#718): the sum cannot be computed, so the
    // disclosure must not fall back to the 40 rows it happened to read and
    // call the walk whole. Unknown stays unknown.
    const sources = [SRC_A, SRC_B];
    const playlists: Record<string, PlaylistItemObject[]> = {};
    sources.forEach((id, s) => {
      playlists[id] = Array.from({ length: 30 }, (_, i) => item(`u${s}r${i}`));
    });
    const withoutTotals: Responder = (path, arg, method) => {
      const match = method === 'GET' ? /^\/playlists\/([^/]+)\/items$/.exec(path) : null;
      if (match && decodeURIComponent(match[1]) in playlists) {
        const all = playlists[decodeURIComponent(match[1])] ?? [];
        const offset = Number(((arg ?? {}) as Record<string, string>).offset ?? 0);
        return { items: all.slice(offset, offset + 5), limit: 5, offset, next: null };
      }
      return null;
    };
    const h = harness(withoutTotals);

    const out = await h.invoke('merge_playlists', {
      sources,
      target_playlist_id: TARGET,
      scan_cap: 10,
    });

    const sc = out.structuredContent!;
    assert.equal(sc.reported_total, null);
    assert.equal(sc.rows_read, 20);
    assert.equal(sc.truncated, true);
    assert.match(textOf(out), /totals may be incomplete/);
    assert.doesNotMatch(textOf(out), /read 20 of 20 row\(s\)/);
  });

  it('says nothing about truncation when the sources really were read whole', async () => {
    const sources = [SRC_A, SRC_B];
    const playlists: Record<string, PlaylistItemObject[]> = {};
    sources.forEach((id, s) => {
      playlists[id] = Array.from({ length: 7 }, (_, i) => item(`w${s}r${i}`));
    });
    const h = harness(playlistResponder(playlists, () => ({ snapshot_id: 's' }), 5));

    const out = await h.invoke('merge_playlists', {
      sources,
      target_playlist_id: TARGET,
      scan_cap: 10,
    });

    const sc = out.structuredContent!;
    assert.equal(sc.truncated, false);
    assert.equal(sc.rows_read, 14);
    assert.equal(sc.reported_total, 14);
    assert.doesNotMatch(textOf(out), /NOT in this result|totals may be incomplete/);
  });
});

// ---------------------------------------------------------------------------
// diff_playlists
// ---------------------------------------------------------------------------

describe('diff_playlists', () => {
  it('reports symmetric only-in-a / only-in-b sets and no false moved rows', async () => {
    const a = [item('a1'), item('b2'), item('c3')];
    const b = [item('b2'), item('c3'), item('d4')];
    const h = harness(playlistResponder({ [PAIR_A]: a, [PAIR_B]: b }));

    const out = await h.invoke('diff_playlists', { a: PAIR_A, b: PAIR_B });
    const text = textOf(out);
    assert.match(text, /Only in A \(1\)/);
    assert.match(text, /a1 @ position 0/);
    assert.match(text, /Only in B \(1\)/);
    assert.match(text, /d4 @ position 2/);
    assert.match(text, /Moved \(same track, different position\) \(2\)/);
    assert.match(text, /b2 @ A:1 → B:0/);
    assert.match(text, /c3 @ A:2 → B:1/);

    // Identical playlists produce empty sections everywhere.
    const same = await h.invoke('diff_playlists', { a: PAIR_A, b: PAIR_A });
    assert.match(textOf(same), /Only in A \(0\):\n  \(none\)/);
    assert.match(textOf(same), /Moved \(same track, different position\) \(0\)/);
  });

  it('flags shared tracks whose positions differ, with accurate totals', async () => {
    const a = [item('x1'), item('x2'), item('x3')];
    const b = [item('x3'), item('x1'), item('x2')];
    const h = harness(playlistResponder({ [PAIR_A]: a, [PAIR_B]: b }));

    const out = await h.invoke('diff_playlists', { a: PAIR_A, b: PAIR_B, response_format: 'json' });
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
    const h = harness(playlistResponder({ [PAIR_A]: a, [PAIR_B]: b }));

    const out = await h.invoke('diff_playlists', { a: PAIR_A, b: PAIR_B, max_results: 1 });
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
    const h = harness(playlistResponder({ [PAIR_A]: a, [PAIR_B]: b }));
    await h.invoke('diff_playlists', { a: PAIR_A, b: PAIR_B, dry_run: true });
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
    const h = harness(playlistResponder({ [PAIR_A]: a, [PAIR_B]: b }, () => null, 50));

    const out = await h.invoke('diff_playlists', { a: PAIR_A, b: PAIR_B, response_format: 'json' });
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
    [OVERLAP_1]: [item('y2'), item('x1')],
    [OVERLAP_2]: [item('y2'), item('z3')],
    [OVERLAP_3]: [item('w4'), item('y2'), item('x1')],
  });

  it('defaults threshold to all playlists and sorts by occurrence count', async () => {
    const h = harness(playlistResponder(fixtures()));
    const out = await h.invoke('overlap_playlists', {
      playlists: [OVERLAP_1, OVERLAP_2, OVERLAP_3],
    });
    const text = textOf(out);
    assert.match(text, /at least 3 of 3 playlists: 1/);
    assert.match(text, /y2 "Track y2" — in 3\/3 playlists/);
  });

  it('honors min_overlap=2 and orders most-shared first', async () => {
    const h = harness(playlistResponder(fixtures()));
    const out = await h.invoke('overlap_playlists', {
      playlists: [OVERLAP_1, OVERLAP_2, OVERLAP_3],
      min_overlap: 2,
    });
    const ids = (textOf(out).match(/• ([xyzw]\d)/g) ?? []).map((l) => l.replace('• ', ''));
    assert.deepEqual(ids, ['y2', 'x1']);
  });

  it('json mode returns raw counts per track', async () => {
    const h = harness(playlistResponder(fixtures()));
    const out = await h.invoke('overlap_playlists', {
      playlists: [OVERLAP_1, OVERLAP_2, OVERLAP_3],
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
          playlists: [OVERLAP_1, OVERLAP_2],
          min_overlap: 3,
        }),
      /cannot exceed/,
    );
  });

  it('accepts URI references and requires at least two playlists', async () => {
    const h = harness(playlistResponder(fixtures()));
    const out = await h.invoke('overlap_playlists', {
      playlists: [`spotify:playlist:${OVERLAP_1}`, `spotify:playlist:${OVERLAP_3}`],
    });
    assert.match(textOf(out), /at least 2 of 2 playlists/);
    await assert.rejects(() =>
      h.invoke('overlap_playlists', { playlists: [OVERLAP_1] }),
    );
  });

  it('makes zero mutating calls even with dry_run set', async () => {
    const h = harness(playlistResponder(fixtures()));
    await h.invoke('overlap_playlists', {
      playlists: [OVERLAP_1, OVERLAP_2],
      dry_run: true,
    });
    assert.equal(
      wireCalls(h.client.calls).filter((c) => c.method !== 'GET').length,
      0,
    );
  });
});

// ---------------------------------------------------------------------------
// #899 — bounded array arguments and the read cost they imply
// ---------------------------------------------------------------------------

describe('#899 bounded array arguments', () => {
  // Ten distinct valid 22-char playlist ids, so an over-limit list is rejected
  // for its LENGTH and never for a malformed reference.
  const ten = Array.from({ length: 10 }, (_, i) => String(i).repeat(22));
  const eleven = [...ten, 'z'.repeat(22)];

  it('rejects an 11-source merge naming the 10-source limit and why it exists', async () => {
    const h = harness(playlistResponder({}));
    // The bound is a read-cost ceiling; a message that only said "max 10"
    // would leave the reader unable to tell a Spotify limit from a typo.
    await assert.rejects(
      () => h.invoke('merge_playlists', { sources: eleven, target_playlist_id: TARGET }),
      (err: Error) => {
        assert.match(err.message, /max 10 per call/);
        assert.match(err.message, /merge_playlists pages every source before it writes/);
        return true;
      },
    );
  });

  it('rejects an 11-playlist overlap naming the 10-playlist limit', async () => {
    const h = harness(playlistResponder({}));
    await assert.rejects(
      () => h.invoke('overlap_playlists', { playlists: eleven }),
      (err: Error) => {
        assert.match(err.message, /max 10 per call/);
        // The reason the ceiling exists, asserted on the real shared-helper
        // text rather than a copy of it, so renaming the constant cannot
        // quietly turn this into a vacuous pass.
        assert.match(err.message, /read-cost ceiling/);
        assert.match(err.message, /one paged walk per playlist/);
        return true;
      },
    );
  });

  it('accepts a comma-separated source string and behaves identically to the array form', async () => {
    const playlists = { [SRC_A]: [item('t1'), item('t2')], [SRC_B]: [item('t3')] };
    const h = harness(playlistResponder(playlists));

    const asArray = await h.invoke('merge_playlists', {
      sources: [SRC_A, SRC_B],
      target_playlist_id: TARGET,
      dry_run: true,
    });
    const asCsv = await h.invoke('merge_playlists', {
      // A host that can only send a scalar must reach the SAME bound, not
      // bypass it — so this is the string that has to normalise first.
      sources: `${SRC_A}, ${SRC_B}`,
      target_playlist_id: TARGET,
      dry_run: true,
    });

    assert.equal(textOf(asCsv), textOf(asArray));
    assert.equal(
      asCsv.structuredContent?.playlists?.length,
      asArray.structuredContent?.playlists?.length,
    );
  });

  it('bounds a CSV source string by the same 10-item limit as the array form', async () => {
    const h = harness(playlistResponder({}));
    await assert.rejects(
      () => h.invoke('merge_playlists', { sources: eleven.join(','), target_playlist_id: TARGET }),
      /max 10 per call/,
    );
  });

  it('reports requests_read for a 10-source merge, counted from the pages walked', async () => {
    // Ten sources, each holding 250 items at a 100-item page size = 3 pages
    // per source. The reported total must be the requests actually spent, so
    // this asserts against the wire, not against an expected constant typed
    // next to the arithmetic.
    const many = Object.fromEntries(
      ten.map((id) => [id, Array.from({ length: 250 }, (_, i) => item(`${id}-${i}`))]),
    );
    const h = harness(playlistResponder(many));
    const out = await h.invoke('merge_playlists', {
      sources: ten,
      target_playlist_id: TARGET,
      dry_run: true,
    });

    const reported = out.structuredContent?.requests_read;
    assert.equal(typeof reported, 'number', 'requests_read must be present in structuredContent');

    const getCalls = wireCalls(h.client.calls).filter((c) => c.method === 'GET').length;
    assert.equal(
      reported,
      getCalls,
      'requests_read must equal the GETs the merge actually issued, not a derived guess',
    );
    assert.ok(reported > ten.length, 'a 10-source walk costs more requests than sources');

    // The prose has to say it too: a cost buried in structuredContent alone
    // does not reach a reader who only sees the text.
    assert.match(textOf(out), /Read cost: \d+ paged read request\(s\) across 10 source playlist\(s\)/);
  });

  it('reports requests_read on a real (non-dry-run) merge', async () => {
    const playlists = { [SRC_A]: [item('t1')], [SRC_B]: [item('t2')] };
    const h = harness(playlistResponder(playlists, (path) =>
      path === '/me/playlists' ? { id: TARGET_2 } : { snapshot_id: 'snap1' },
    ));
    const out = await h.invoke('merge_playlists', {
      sources: [SRC_A, SRC_B],
      new_name: 'merged',
    });
    assert.equal(typeof out.structuredContent?.requests_read, 'number');
    assert.match(textOf(out), /Read cost: \d+ paged read request\(s\)/);
  });

  it('reports requests_read for overlap_playlists, whose reads ARE the cost', async () => {
    const playlists = {
      [OVERLAP_1]: [item('s1'), item('s2')],
      [OVERLAP_2]: [item('s2'), item('s3')],
    };
    const h = harness(playlistResponder(playlists));
    const out = await h.invoke('overlap_playlists', { playlists: [OVERLAP_1, OVERLAP_2] });
    const getCalls = wireCalls(h.client.calls).filter((c) => c.method === 'GET').length;
    assert.equal(out.structuredContent?.requests_read, getCalls);
    assert.match(textOf(out), /Read cost: \d+ paged read request\(s\) across 2 playlist\(s\)/);
  });

  it('reports requests_read for diff_playlists as the sum of both walks', async () => {
    const playlists = { [PAIR_A]: [item('d1')], [PAIR_B]: [item('d2')] };
    const h = harness(playlistResponder(playlists));
    const out = await h.invoke('diff_playlists', { playlist_a: PAIR_A, playlist_b: PAIR_B });
    const getCalls = wireCalls(h.client.calls).filter((c) => c.method === 'GET').length;
    assert.equal(out.structuredContent?.requests_read, getCalls);
  });
});
