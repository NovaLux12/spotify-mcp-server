/**
 * Issue #903 — the map/set conversions in three hot loops.
 *
 * Two jobs per loop, and the pair matters:
 *
 *  1. RESULT IDENTITY. Each test recomputes the expected value with the
 *     PRE-refactor algorithm transcribed verbatim below and deep-equals it
 *     against what the tool now returns. The reference is a frozen copy of
 *     the old loop, not a call into the new one, so it cannot drift with it.
 *
 *  2. MECHANISM. A pure speedup has no observable output difference, so
 *     result identity alone cannot tell a map from a scan. Each test also
 *     counts `Array.prototype.find` / `.includes` calls across the invocation
 *     and asserts the linear scan is gone. Revert the source and the counter
 *     test fails; the identity tests keep passing, which is exactly why both
 *     exist.
 *
 * Loops covered: overlap_playlists name resolution (src/tools/playlistops.ts),
 * the balance_playlist_pairs commit path (src/tools/swarm3_playlistops.ts),
 * and groupSessions de-duplication (src/tools/statsfm_taste.ts).
 */
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { SpotifyClient } from '../src/client.js';
import { registerPlaylistOpsTools } from '../src/tools/playlistops.js';
import { registerSwarm3PlaylistopsTools } from '../src/tools/swarm3_playlistops.js';
import { groupSessions } from '../src/tools/statsfm_taste.js';
import type { TasteStream } from '../src/tools/statsfm_taste.js';
import { initConfig } from '../src/config.js';
import { capFor } from '../src/chunk.js';
import type { PlaylistItemObject, SpotifyPaged } from '../src/types/spotify.js';

// ---------------------------------------------------------------------------
// Linear-scan counters
// ---------------------------------------------------------------------------

interface ScanCounts {
  find: number;
  includes: number;
}

/**
 * Run `fn` with `Array.prototype.find`/`.includes` wrapped in counters, then
 * restore. Both the old hot loops and any surviving scan go through these two
 * methods, so a non-zero count means a linear scan is still on the path.
 */
async function countScans(fn: () => Promise<unknown>): Promise<{ counts: ScanCounts }> {
  const realFind = Array.prototype.find;
  const realIncludes = Array.prototype.includes;
  const counts: ScanCounts = { find: 0, includes: 0 };
  Array.prototype.find = function patchedFind(
    this: unknown[],
    ...args: Parameters<typeof realFind>
  ): unknown {
    counts.find++;
    return (realFind as (...a: unknown[]) => unknown).apply(this, args);
  };
  Array.prototype.includes = function patchedIncludes(
    this: unknown[],
    ...args: Parameters<typeof realIncludes>
  ): unknown {
    counts.includes++;
    return (realIncludes as (...a: unknown[]) => unknown).apply(this, args);
  };
  try {
    await fn();
    return { counts };
  } finally {
    Array.prototype.find = realFind;
    Array.prototype.includes = realIncludes;
  }
}

// ---------------------------------------------------------------------------
// Fixtures / stub clients
// ---------------------------------------------------------------------------

/** Playlist entry with the fields the balancer's row model reads. */
const entry = (id: string, name: string, durationMs = 180_000): PlaylistItemObject =>
  ({
    added_at: '2026-01-01T00:00:00Z',
    item: {
      type: 'track',
      id,
      uri: `spotify:track:${id}`,
      name,
      duration_ms: durationMs,
      artists: [{ id: `artist-${id}`, name: `Artist ${id}` }],
      album: { id: `album-${id}`, name: `Album ${id}` },
    },
  }) as unknown as PlaylistItemObject;

interface ToolOut {
  content: Array<{ type: string; text: string }>;
  structuredContent?: Record<string, unknown>;
}

interface RecordedWrite {
  method: 'POST' | 'PUT' | 'DELETE';
  path: string;
  body: unknown;
}

/**
 * Stub client that page-serves playlist items and records writes. Metadata GETs
 * answer with the fixture's name so the balancer's backup path has something
 * to record.
 */
function makeClient(playlists: Record<string, PlaylistItemObject[]>, pageSize = 100) {
  const writes: RecordedWrite[] = [];
  const client = {
    writes,
    async get<T>(path: string, params?: Record<string, string>): Promise<T | null> {
      const meta = /^\/playlists\/([^/]+)$/.exec(path);
      if (meta) {
        const id = decodeURIComponent(meta[1]);
        return { id, name: `Playlist ${id}` } as T;
      }
      const items = /^\/playlists\/([^/]+)\/items$/.exec(path);
      if (!items) return null;
      const all = playlists[decodeURIComponent(items[1])] ?? [];
      const offset = Number(params?.offset ?? 0);
      const page = all.slice(offset, offset + pageSize);
      return {
        items: page,
        total: all.length,
        limit: pageSize,
        offset,
        next: null,
      } as unknown as SpotifyPaged<T>;
    },
    async post<T>(path: string, body?: unknown): Promise<T | null> {
      writes.push({ method: 'POST', path, body });
      return { snapshot_id: 'snap' } as T;
    },
    async put<T>(path: string, body?: unknown): Promise<T | null> {
      writes.push({ method: 'PUT', path, body });
      return { snapshot_id: 'snap' } as T;
    },
    async delete<T>(path: string, body?: unknown): Promise<T | null> {
      writes.push({ method: 'DELETE', path, body });
      return null;
    },
    /** Mirrors SpotifyClient.getAllPages over the stubbed get(), so the real
     *  pagination loop runs against paged fixtures. */
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
        const limit = typeof page.limit === 'number' && page.limit > 0 ? page.limit : page.items.length;
        offset += limit;
        if (page.items.length === 0 || page.items.length < limit) break;
        if (typeof page.total === 'number' && offset >= page.total) break;
      }
      return all;
    },
    /** #899: playlistops reports its read cost off this walk's request count.
     *  Delegates to the stub above rather than re-implementing the loop, so the
     *  paged fixtures and the recorded GETs stay defined in one place. Forwards
     *  `params` and `opts`: dropping `maxItems` here silently caps every walk at
     *  the stub's 500-row default, which reads as a source-side regression. */
    async getAllPagesWithTruncation<T>(
      path: string,
      params?: Record<string, string>,
      opts?: { maxItems?: number; initialOffset?: number },
    ): Promise<{
      items: T[];
      truncated: boolean;
      truncatedByCap: boolean;
      reportedTotal: number | null;
      pages: number;
    }> {
      const items = await this.getAllPages<T>(path, params, opts);
      return { items, truncated: false, truncatedByCap: false, reportedTotal: null, pages: 1 };
    },
  };
  return client;
}

function fakeServer(registered: Registered) {
  return {
    tool(
      name: string,
      _description: string,
      schema: z.ZodRawShape,
      handler: (a: Record<string, unknown>) => Promise<ToolOut>,
    ) {
      registered.push({ name, validate: (a) => z.object(schema).parse(a), handler });
    },
    registerTool(
      name: string,
      config: { description?: string; inputSchema?: z.ZodType },
      handler: (a: Record<string, unknown>) => Promise<ToolOut>,
    ) {
      registered.push({
        name,
        validate: (a) => (config.inputSchema as z.ZodType).parse(a),
        handler,
      });
    },
  } as unknown as McpServer;
}

type Registered = Array<{
  name: string;
  validate: (a: Record<string, unknown>) => Record<string, unknown>;
  handler: (a: Record<string, unknown>) => Promise<ToolOut>;
}>;

/**
 * Tool lookup WITHOUT Array.prototype.find — the scan counters below must
 * measure the tool's own hot loops, not this harness's bookkeeping.
 */
function pick(registered: Registered, name: string): Registered[number] {
  for (const t of registered) if (t.name === name) return t;
  throw new assert.AssertionError({ message: `tool ${name} should be registered` });
}

const invoke = (registered: Registered, name: string, args: Record<string, unknown>): Promise<ToolOut> => {
  const tool = pick(registered, name);
  return tool.handler(tool.validate(args));
};

const OVERLAP_1 = '1'.repeat(22);
const OVERLAP_2 = '2'.repeat(22);
const OVERLAP_3 = '3'.repeat(22);

/** Deterministic 22-char base62 playlist id: Spotify references demand exactly 22. */
const pid = (n: number, tag: string) => tag + String(n).padStart(22 - tag.length, '0');

// ---------------------------------------------------------------------------
// overlap_playlists
// ---------------------------------------------------------------------------

/**
 * The PRE-#903 overlap algorithm, transcribed: presence sets, occurrence
 * counts, then a per-shared-entry rescan of every playlist array with
 * `.find`. The name it resolves is the first hit in playlist order.
 */
function referenceOverlap(
  itemLists: PlaylistItemObject[][],
  threshold: number,
): Array<{ id: string; name: string; count: number }> {
  const presence = itemLists.map((items) => {
    const ids = new Set<string>();
    for (const item of items) {
      const id = item.item?.id;
      if (id) ids.add(id);
    }
    return ids;
  });
  interface Shared {
    id: string;
    name: string;
    count: number;
    firstSeen: number;
  }
  const counts = new Map<string, Shared>();
  let firstSeen = 0;
  for (const ids of presence) {
    for (const id of ids) {
      const e = counts.get(id);
      if (e) e.count++;
      else counts.set(id, { id, name: '', count: 1, firstSeen: firstSeen++ });
    }
  }
  const shared = [...counts.values()]
    .filter((e) => e.count >= threshold)
    .sort((a, b) => b.count - a.count || a.firstSeen - b.firstSeen);
  for (const entryRow of shared) {
    for (const items of itemLists) {
      const hit = items.find((i) => i.item?.id === entryRow.id);
      if (hit?.item) {
        entryRow.name = hit.item.name;
        break;
      }
    }
  }
  return shared.map(({ id, name, count }) => ({ id, name, count }));
}

/**
 * 3 x 5,000 items with 2,000 shared tracks (the #903 acceptance fixture).
 * A shared id carries a DIFFERENT name in each playlist, so the resolved name
 * proves which playlist's copy won — the first one, in both implementations.
 */
function overlapFixture() {
  const sharedIds = Array.from({ length: 2000 }, (_, i) => `s${String(i).padStart(4, '0')}`);
  const perPlaylistUnique = 3000;
  const mk = (playlistIndex: number): PlaylistItemObject[] => {
    const rows: PlaylistItemObject[] = [];
    for (let i = 0; i < sharedIds.length; i++) {
      rows.push(entry(sharedIds[i], `Name P${playlistIndex} ${sharedIds[i]}`));
    }
    for (let i = 0; i < perPlaylistUnique; i++) {
      rows.push(entry(`p${playlistIndex}u${String(i).padStart(4, '0')}`, `Unique P${playlistIndex} ${i}`));
    }
    return rows;
  };
  return {
    [OVERLAP_1]: mk(1),
    [OVERLAP_2]: mk(2),
    [OVERLAP_3]: mk(3),
  };
}

function overlapHarness(playlists: Record<string, PlaylistItemObject[]>) {
  const registered: Registered = [];
  const server = fakeServer(registered);
  const client = makeClient(playlists);
  registerPlaylistOpsTools(server, client as unknown as SpotifyClient);
  return { registered, client, run: (args: Record<string, unknown>) => invoke(registered, 'overlap_playlists', args) };
}

describe('overlap_playlists name resolution (#903)', () => {
  // The default SPOTIFY_MCP_FETCH_ALL_CAP is 500, which would silently shrink
  // the 3 x 5,000 acceptance fixture to 500 rows per playlist. Raise it for
  // this file and restore the process-wide snapshot afterwards.
  before(() => {
    initConfig({ ...process.env, SPOTIFY_MCP_FETCH_ALL_CAP: '5000' });
  });

  after(() => {
    initConfig();
  });

  it('produces byte-identical output to the pre-refactor algorithm on 3 x 5,000 items', async () => {
    const fixtures = overlapFixture();
    const refs = [OVERLAP_1, OVERLAP_2, OVERLAP_3];
    const expected = referenceOverlap([fixtures[OVERLAP_1], fixtures[OVERLAP_2], fixtures[OVERLAP_3]], 3);

    for (const threshold of [3, 1]) {
      const h = overlapHarness(fixtures);
      const out = await h.run({ playlists: refs, min_overlap: threshold, response_format: 'json' });
      const data = JSON.parse(out.content[0].text) as { shared: Array<{ id: string; name: string; count: number }> };
      const want = threshold === 3 ? expected : referenceOverlap([fixtures[OVERLAP_1], fixtures[OVERLAP_2], fixtures[OVERLAP_3]], 1);

      // Same rows, same order, same names — including that a shared id takes
      // its name from the FIRST playlist that holds it.
      assert.deepEqual(data.shared, want);
      assert.equal(data.shared[0].name, 'Name P1 s0000');
      assert.equal(data.shared[0].count, 3);
    }
  });

  it('renders prose identically to the pre-refactor algorithm', async () => {
    const fixtures = overlapFixture();
    const refs = [OVERLAP_1, OVERLAP_2, OVERLAP_3];
    const h = overlapHarness(fixtures);
    const out = await h.run({ playlists: refs, min_overlap: 3, max_results: 5 });
    const text = out.content[0].text;
    const expected = referenceOverlap([fixtures[OVERLAP_1], fixtures[OVERLAP_2], fixtures[OVERLAP_3]], 3);
    assert.match(text, /Tracks present in at least 3 of 3 playlists: 2000/);
    for (const row of expected.slice(0, 5)) {
      assert.ok(text.includes(`• ${row.id} "Name P1 ${row.id}" — in 3/3 playlists`), `row ${row.id} rendered`);
    }
    // A structuredContent row set matches the reference too.
    const structured = out.structuredContent as { shared: Array<{ id: string; name: string; count: number }> };
    assert.deepEqual(structured.shared, expected);
  });

  it('resolves names from the first playlist that holds a repeated id', async () => {
    // Playlist 2's copy of s0 has no item payload at all; the map must skip it
    // exactly as the old scan did rather than blanking the name.
    const withNull = [
      [entry('s0', 'First wins'), { added_at: '2026-01-01T00:00:00Z', item: null } as unknown as PlaylistItemObject],
      [entry('s0', 'Second playlist copy'), entry('only2', 'Two')],
    ];
    const fixtures = { [OVERLAP_1]: withNull[0], [OVERLAP_2]: withNull[1] };
    const h = overlapHarness(fixtures);
    const out = await h.run({ playlists: [OVERLAP_1, OVERLAP_2], min_overlap: 1, response_format: 'json' });
    const data = JSON.parse(out.content[0].text) as { shared: Array<{ id: string; name: string; count: number }> };
    assert.deepEqual(data.shared, referenceOverlap([fixtures[OVERLAP_1], fixtures[OVERLAP_2]], 1));
  });

  it('no longer rescans the playlist arrays to resolve a name', async () => {
    const fixtures = overlapFixture();
    const h = overlapHarness(fixtures);
    const { counts } = await countScans(() => h.run({ playlists: [OVERLAP_1, OVERLAP_2, OVERLAP_3] }));
    assert.equal(counts.find, 0, 'overlap_playlists must not call Array.prototype.find');
  });
});

// ---------------------------------------------------------------------------
// balance_playlist_pairs
// ---------------------------------------------------------------------------

interface RefRow {
  uri: string;
  name: string;
  position: number;
}

interface RefBucket {
  id: string;
  name: string | null;
  size: number;
  rows: RefRow[];
}

interface RefMove {
  uri: string;
  name: string;
  from_playlist: string;
  from_name: string;
  to_playlist: string;
  to_name: string;
}

/**
 * The PRE-#903 balancer, transcribed end to end: the same donor/receiver walk
 * for the plan, then the commit stage's two linear scans (`buckets.find` then
 * `donorBucket.rows.find`) and a per-receiver `moves.filter(...)`. What the
 * tool must still emit is exactly what this produces.
 */
function referenceBalance(buckets: RefBucket[]) {
  const total = buckets.reduce((s, b) => s + b.size, 0);
  const target = Math.floor(total / buckets.length);
  const received = new Map<string, number>();
  const needOf = (b: RefBucket): number => target - b.size - (received.get(b.id) ?? 0);
  const moves: RefMove[] = [];
  const movedUris = new Set<string>();
  const donors = [...buckets].filter((b) => b.size > target).sort((a, b) => b.size - a.size);
  const receivers = [...buckets].filter((b) => b.size < target);
  let ri = 0;
  for (const donor of donors) {
    let surplus = donor.size - target;
    let i = donor.rows.length - 1;
    while (surplus > 0 && i >= 0 && ri < receivers.length) {
      if (needOf(receivers[ri]) <= 0) {
        ri++;
        continue;
      }
      const row = donor.rows[i];
      if (!movedUris.has(row.uri)) {
        movedUris.add(row.uri);
        received.set(receivers[ri].id, (received.get(receivers[ri].id) ?? 0) + 1);
        moves.push({
          uri: row.uri,
          name: row.name,
          from_playlist: donor.id,
          from_name: donor.name ?? donor.id,
          to_playlist: receivers[ri].id,
          to_name: receivers[ri].name ?? receivers[ri].id,
        });
        surplus -= 1;
      }
      i--;
    }
  }

  // Commit stage, as it was: two linear scans per move, then a rescan of every
  // move per receiver.
  const outboundBySrc = new Map<string, RefRow[]>();
  for (const m of moves) {
    const donorBucket = buckets.find((b) => b.id === m.from_playlist);
    if (!donorBucket) continue;
    const row = donorBucket.rows.find((r) => r.uri === m.uri);
    if (!row) continue;
    const list = outboundBySrc.get(m.from_playlist) ?? [];
    if (list.length === 0) outboundBySrc.set(m.from_playlist, list);
    list.push(row);
  }
  const writeCap = capFor('playlist_writes');
  const deletes: Array<{ playlist: string; uri: string; position: number }> = [];
  for (const [srcId, rows] of outboundBySrc) {
    const descending = [...rows].sort((a, b) => b.position - a.position);
    for (let start = 0; start < descending.length; start += writeCap) {
      for (const r of descending.slice(start, start + writeCap)) {
        deletes.push({ playlist: srcId, uri: r.uri, position: r.position });
      }
    }
  }
  const adds: Array<{ playlist: string; uris: string[] }> = [];
  for (const recv of receivers) {
    const inbound = moves.filter((m) => m.to_playlist === recv.id).map((m) => m.uri);
    for (let start = 0; start < inbound.length; start += writeCap) {
      adds.push({ playlist: recv.id, uris: inbound.slice(start, start + writeCap) });
    }
  }
  return { total, target, moves, deletes, adds };
}

describe('balance_playlist_pairs commit path (#903)', () => {
  let backupDir: string;
  let previousBackupDir: string | undefined;

  before(() => {
    backupDir = mkdtempSync(join(tmpdir(), 'w903-'));
    previousBackupDir = process.env.SPOTIFY_MCP_BACKUP_DIR;
    process.env.SPOTIFY_MCP_BACKUP_DIR = backupDir;
    // Fixtures below exceed the default 500-row fetch-all cap.
    initConfig({ ...process.env, SPOTIFY_MCP_FETCH_ALL_CAP: '5000' });
  });

  after(() => {
    if (previousBackupDir === undefined) delete process.env.SPOTIFY_MCP_BACKUP_DIR;
    else process.env.SPOTIFY_MCP_BACKUP_DIR = previousBackupDir;
    rmSync(backupDir, { recursive: true, force: true });
    initConfig();
  });

  /**
   * 8 playlists of very different sizes over disjoint track pools, so the
   * planner produces a real move set and the commit stage deletes real
   * positions.
   */
  function balanceFixture() {
    const playlists: Record<string, PlaylistItemObject[]> = {};
    for (let p = 0; p < 8; p++) {
      const size = 20 + p * 25;
      playlists[pid(p, 'bal')] = Array.from({ length: size }, (_, i) =>
        entry(`b${p}t${String(i).padStart(3, '0')}`, `Track ${p}-${i}`, 120_000 + i * 1000),
      );
    }
    return playlists;
  }

  function balanceHarness(playlists: Record<string, PlaylistItemObject[]>) {
    const registered: Registered = [];
    const server = fakeServer(registered);
    const client = makeClient(playlists);
    registerSwarm3PlaylistopsTools(server, client as unknown as SpotifyClient);
    return {
      registered,
      writes: client.writes,
      run: (args: Record<string, unknown>) => invoke(registered, 'balance_playlist_pairs', args),
    };
  }

  const ids = (n: number) => Array.from({ length: n }, (_, i) => pid(i, 'bal'));

  it('plans and commits exactly what the pre-refactor linear scans resolved', async () => {
    const playlists = balanceFixture();
    const h = balanceHarness(playlists);
    const out = await h.run({ playlists: ids(8), dry_run: false, response_format: 'json' });

    const buckets: RefBucket[] = ids(8).map((id) => ({
      id,
      name: `Playlist ${id}`,
      size: playlists[id].length,
      rows: playlists[id].map((e, position) => ({
        uri: e.item?.uri as string,
        name: e.item?.name as string,
        position,
      })),
    }));
    const { total, target, moves, deletes, adds } = referenceBalance(buckets);
    assert.ok(moves.length > 0, 'the fixture must produce a real plan');

    // The plan is identical, row for row and in order.
    const payload = JSON.parse(out.content[0].text) as {
      total: number;
      target: number;
      moves: RefMove[];
    };
    assert.equal(payload.total, total);
    assert.equal(payload.target, target);
    assert.deepEqual(payload.moves, moves);

    // Every DELETE carries the same (playlist, uri, position) triples the two
    // linear scans produced, in the same chunk order, and every receiver is
    // appended the same uris in the same order.
    const actualDeletes: Array<{ playlist: string; uri: string; position: number }> = [];
    const actualAdds: Array<{ playlist: string; uris: string[] }> = [];
    for (const w of h.writes) {
      const playlist = decodeURIComponent(w.path.replace('/playlists/', '').replace('/items', ''));
      if (w.method === 'DELETE') {
        for (const t of (w.body as { tracks: Array<{ uri: string; positions: number[] }> }).tracks) {
          actualDeletes.push({ playlist, uri: t.uri, position: t.positions[0] });
        }
      } else if (w.method === 'POST') {
        actualAdds.push({ playlist, uris: (w.body as { uris: string[] }).uris });
      }
    }
    assert.deepEqual(actualDeletes, deletes);
    assert.deepEqual(actualAdds, adds);
    assert.ok(actualDeletes.length > 0, 'the fixture must produce real deletes');
  });

  it('caps structuredContent moves to max_results and discloses the withheld count', async () => {
    const h = balanceHarness(balanceFixture());
    const out = await h.run({ playlists: ids(8), dry_run: true, max_results: 3 });
    const payload = out.structuredContent as Record<string, number> & { moves: unknown[] };

    assert.ok(Array.isArray(payload.moves));
    assert.equal(payload.moves.length, 3);
    assert.equal(payload.moves_total, payload.moves_total);
    assert.ok(payload.moves_total > 3, 'fixture must exceed the cap');
    assert.equal(payload.moves_returned, payload.moves.length);
    assert.equal(payload.moves_withheld, payload.moves_total - payload.moves_returned);
    assert.equal(payload.moves_truncated, true);
  });

  it('payload size tracks the cap, not the total move count', async () => {
    // Fixture A: a few hundred planned moves.
    const a = balanceHarness(balanceFixture());
    const aOut = await a.run({ playlists: ids(8), dry_run: true, max_results: 20 });

    // Fixture B: the same cap, but a plan several times longer — one 900-track
    // donor feeding nine single-track receivers.
    const donorId = pid(0, 'don');
    const receiverIds = Array.from({ length: 9 }, (_, i) => pid(i, 'rcv'));
    const b: Record<string, PlaylistItemObject[]> = {
      [donorId]: Array.from({ length: 900 }, (_, i) => entry(`bigt${String(i).padStart(4, '0')}`, `Big ${i}`)),
    };
    for (let p = 0; p < receiverIds.length; p++) {
      b[receiverIds[p]] = [entry(`s${p}t0`, `Small ${p} 0`)];
    }
    const bAll = balanceHarness(b);
    const bOut = await bAll.run({ playlists: [donorId, ...receiverIds], dry_run: true, max_results: 20 });
    const bJson = await balanceHarness(b).run({
      playlists: [donorId, ...receiverIds],
      dry_run: true,
      max_results: 20,
      response_format: 'json',
    });

    const pa = aOut.structuredContent as { moves: unknown[]; moves_total: number };
    const pb = bOut.structuredContent as { moves: unknown[]; moves_total: number };
    assert.ok(pb.moves_total > pa.moves_total * 3, `fixture must scale: ${pa.moves_total} vs ${pb.moves_total}`);

    // Both payloads carry the cap, so a plan 3x longer costs about the same.
    assert.equal(pa.moves.length, 20);
    assert.equal(pb.moves.length, 20);
    const bytes = (o: ToolOut) => JSON.stringify(o.structuredContent).length;
    assert.ok(
      bytes(bOut) < bytes(aOut) * 1.2,
      `payload grew with move count: ${bytes(aOut)} -> ${bytes(bOut)} (${pa.moves_total} vs ${pb.moves_total} moves)`,
    );

    // And the withheld moves genuinely left the payload: the json opt-in is
    // orders of magnitude larger and carries a URI the capped one does not.
    const jsonMoves = (bJson.structuredContent as { moves: Array<{ uri: string }> }).moves;
    const withheld = jsonMoves[jsonMoves.length - 1].uri;
    assert.ok(bytes(bJson) > bytes(bOut) * 10, `json payload ${bytes(bJson)} vs capped ${bytes(bOut)}`);
    assert.doesNotMatch(JSON.stringify(bOut.structuredContent), new RegExp(withheld));
  });

  it('response_format json still returns every move', async () => {
    const h = balanceHarness(balanceFixture());
    const out = await h.run({ playlists: ids(8), dry_run: true, max_results: 3, response_format: 'json' });
    const payload = out.structuredContent as { moves: unknown[]; moves_total: number; moves_withheld: number; moves_truncated: boolean };

    assert.equal(payload.moves.length, payload.moves_total);
    assert.equal(payload.moves_withheld, 0);
    assert.equal(payload.moves_truncated, false);
    // The json text body carries the same complete plan.
    const body = JSON.parse(out.content[0].text) as { moves: unknown[] };
    assert.equal(body.moves.length, payload.moves_total);
  });

  it('no longer scans buckets or rows per planned move', async () => {
    const h = balanceHarness(balanceFixture());
    const { counts } = await countScans(() => h.run({ playlists: ids(8), dry_run: false }));
    assert.equal(counts.find, 0, 'balance_playlist_pairs must not call Array.prototype.find');
  });
});

// ---------------------------------------------------------------------------
// groupSessions
// ---------------------------------------------------------------------------

/** The PRE-#903 grouper, transcribed: `tracks.includes` for membership. */
function referenceGroupSessions(streams: TasteStream[], gapMinutes = 30) {
  const sessions: Array<{ startMs: number; endMs: number; streams: number; tracks: string[] }> = [];
  let current: { startMs: number; endMs: number; streams: number; tracks: string[] } | null = null;
  const gapMs = Math.max(1, gapMinutes) * 60_000;
  for (const s of streams) {
    if (!current || s.playedAtMs - current.endMs > gapMs) {
      current = { startMs: s.playedAtMs, endMs: s.playedAtMs, streams: 0, tracks: [] };
      sessions.push(current);
    }
    current.endMs = s.playedAtMs;
    current.streams += 1;
    if (s.trackName !== 'unknown track' && !current.tracks.includes(s.trackName)) {
      current.tracks.push(s.trackName);
    }
  }
  return sessions;
}

describe('groupSessions de-duplication (#903)', () => {
  const base = Date.parse('2026-01-01T00:00:00Z');

  /** 500 streams over 40 track names, in 25 sessions, with repeats inside each. */
  function streamFixture(): TasteStream[] {
    const out: TasteStream[] = [];
    for (let i = 0; i < 500; i++) {
      const session = Math.floor(i / 20);
      const withinSession = i % 20;
      // 40 names over 20 slots per session guarantees repeats within a session.
      const name = `track-${(session * 7 + withinSession * 3) % 40}`;
      const trackName = i % 37 === 0 ? 'unknown track' : name;
      out.push({
        trackId: `id-${i}`,
        trackName,
        artistNames: ['X'],
        playedAtMs: base + session * 60 * 60_000 + withinSession * 60_000,
      });
    }
    return out;
  }

  it('produces identical tracks[] ordering on a 500-stream fixture', () => {
    const streams = streamFixture();
    const actual = groupSessions(streams);
    const expected = referenceGroupSessions(streams);

    assert.equal(actual.length, 25);
    assert.deepEqual(actual, expected);
    // The shape the caller serialises carries no extra field.
    assert.deepEqual(Object.keys(actual[0]).sort(), ['endMs', 'startMs', 'streams', 'tracks']);
    // Ordering is load-bearing and matches the reference exactly, name for
    // name; "unknown track" is never collected, so the first collected track
    // is the session's earliest *named* stream.
    assert.deepEqual(actual.map((s) => s.tracks), expected.map((s) => s.tracks));
    assert.equal(actual[0].tracks[0], expected[0].tracks[0]);
    assert.equal(actual[0].tracks[0], streams[1].trackName);
    assert.equal(actual.every((s) => !s.tracks.includes('unknown track')), true);
  });

  it('stops using Array.prototype.includes for membership', () => {
    const streams = streamFixture();
    let calls = 0;
    const real = Array.prototype.includes;
    Array.prototype.includes = function patched(this: unknown[], ...args: Parameters<typeof real>): unknown {
      calls++;
      return (real as (...a: unknown[]) => unknown).apply(this, args);
    };
    try {
      groupSessions(streams);
    } finally {
      Array.prototype.includes = real;
    }
    assert.equal(calls, 0, 'groupSessions must not call Array.prototype.includes');
  });

  it('matches the reference across gap thresholds', () => {
    const streams = streamFixture();
    for (const gap of [1, 5, 30, 120]) {
      assert.deepEqual(groupSessions(streams, gap), referenceGroupSessions(streams, gap), `gap ${gap}`);
    }
  });
});
