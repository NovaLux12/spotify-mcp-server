/**
 * #879 — playlist writes verify themselves with receipts.
 *
 * Two things are asserted here, and both had to be able to FAIL:
 *
 *  1. **The grep guard.** Every module that mutates `/playlists/{id}/items`
 *     imports `receipts.js`. A new writer that skips the receipt is a silent
 *     drop the agent cannot see, so the guard walks `src/` rather than
 *     trusting a hand-kept list.
 *
 *  2. **The no-op stub.** For each committing helper, a client that accepts
 *     the write and does nothing must produce `ok: false` plus an UNVERIFIED
 *     receipt saying what was not as written — and the same test must pass
 *     when the stub actually mutates. Both halves run in one test on purpose:
 *     a receipt that cannot go red is a receipt that cannot fail, which is
 *     worse than no receipt at all.
 *
 *     What the receipt names depends on the write, because a dropped write is
 *     not always visible in the same place. An append that drops leaves rows
 *     the written uris were never in, so absence catches it. A replace that
 *     drops leaves the OLD rows, which may hold the same uris, so only the row
 *     count catches it. A REORDER that drops leaves the same rows in the
 *     original order, with the same multiset and the same count, so only the
 *     order catches it. The `reverse_playlist` pair below is what pins that
 *     last one.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { SpotifyClient } from '../src/client.js';
import { registerSwarm3PlaylistopsTools } from '../src/tools/swarm3_playlistops.js';
import { registerExhaust2PlaylistsTools } from '../src/tools/exhaust2_playlists.js';
import type { PlaylistItemObject, SpotifyPaged } from '../src/types/spotify.js';

// ---------------------------------------------------------------------------
// 1. The grep guard
// ---------------------------------------------------------------------------

const ROOT = fileURLToPath(new URL('..', import.meta.url));

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else if (entry.endsWith('.ts')) out.push(full);
  }
  return out;
}

/**
 * A playlist-items MUTATION, not a read. Two shapes count, because the
 * codebase uses both:
 *
 *   - the path literal is inline — ``client.post(`/playlists/${id}/items`, …)``
 *   - the path is hoisted   — ``const path = `/playlists/${id}/items`; client.put(path, …)``
 *
 * The window is deliberately generous: over-matching can only make the guard
 * stricter, whereas a window that clipped at the first `)` would stop inside
 * `${encodeURIComponent(id)}` and never see the `/items` that follows it.
 */
const MUTATION = /\bclient\.(post|put|delete)(?:<[^>]*>)?\(([\s\S]{0,240}?)\)\s*[;,)]/g;
const PLAYLIST_ITEMS_PATH = /\/playlists\//;
const ITEMS_SEGMENT = /\/items/;
const HOISTED = /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=]+)?=\s*([\s\S]{0,200}?);/g;

function mutatesPlaylistItems(source: string): boolean {
  const hoisted = new Set<string>();
  for (const m of source.matchAll(HOISTED)) {
    if (PLAYLIST_ITEMS_PATH.test(m[2]) && ITEMS_SEGMENT.test(m[2])) hoisted.add(m[1]);
  }
  for (const match of source.matchAll(MUTATION)) {
    const arg = (match[2] ?? '').trim();
    if (PLAYLIST_ITEMS_PATH.test(arg) && ITEMS_SEGMENT.test(arg)) return true;
    if (hoisted.has(arg.replace(/,$/, ''))) return true;
  }
  return false;
}

describe('#879 grep guard', () => {
  it('every module that mutates /playlists/{id}/items imports receipts.js', () => {
    const offenders: string[] = [];
    const writers: string[] = [];
    for (const file of walk(join(ROOT, 'src'))) {
      const source = readFileSync(file, 'utf8');
      if (!mutatesPlaylistItems(source)) continue;
      const rel = relative(ROOT, file).split(sep).join('/');
      writers.push(rel);
      if (!/from '\.\.\/receipts\.js'/.test(source)) offenders.push(rel);
    }
    // The guard is only meaningful if it actually found the writers; a regex
    // that silently matches nothing would pass forever.
    assert.ok(writers.length >= 10, `guard should find the playlist writers, found ${writers.length}: ${writers.join(', ')}`);
    assert.deepEqual(offenders, [], `playlist writers without a receipt import: ${offenders.join(', ')}`);
  });
});

// ---------------------------------------------------------------------------
// 2. The no-op stub
// ---------------------------------------------------------------------------

interface RegisteredTool {
  name: string;
  validate: (args: Record<string, unknown>) => Record<string, unknown>;
  handler: (args: Record<string, unknown>) => Promise<{
    content: Array<{ type: string; text: string }>;
    structuredContent?: Record<string, unknown>;
  }>;
}

/** In-memory playlist state, so a stub that "mutates" and one that does not
 *  differ only in whether the write touches it. */
interface PlaylistState {
  id: string;
  name: string;
  uris: string[];
}

const pad = (n: number) => String(n).padStart(2, '0');
const trackUri = (n: number) => `spotify:track:t${pad(n)}`;
const episodeUri = (n: number) => `spotify:episode:e${pad(n)}`;

const item = (uri: string): PlaylistItemObject =>
  (uri.startsWith('spotify:episode:')
    ? {
        added_at: '2026-01-01T00:00:00Z',
        item: { type: 'episode', id: uri.split(':').pop(), name: `Episode ${uri.split(':').pop()}`, uri, duration_ms: 1_800_000 },
      }
    : {
        added_at: '2026-01-01T00:00:00Z',
        item: {
          type: 'track',
          id: uri.split(':').pop(),
          name: `Track ${uri.split(':').pop()}`,
          uri,
          duration_ms: 200_000,
          artists: [{ name: 'Artist' }],
          album: { id: 'al', release_date: '2024-01-01' },
        },
      }) as unknown as PlaylistItemObject;

interface StubOptions {
  /**
   * When false the write methods resolve 2xx and change NOTHING — the silent
   * drop #879 exists to catch.
   */
  mutates: boolean;
  playlists: PlaylistState[];
}

/**
 * A stub that serves real pagination, because `issueReceipt` walks
 * `/playlists/{id}/items` in 100-row pages and reads `total` (#729). A stub
 * that returned a bare array would make every receipt look unverified and the
 * passing half of each test would be vacuous.
 */
function makeStub({ mutates, playlists }: StubOptions) {
  const byId = new Map(playlists.map((p) => [p.id, p]));
  const writes: Array<{ method: string; id: string; body: any }> = [];
  let nextId = 0;

  const resolve = (playlistId: string): PlaylistState => {
    let p = byId.get(playlistId);
    if (!p) {
      p = { id: playlistId, name: `New ${playlistId}`, uris: [] };
      byId.set(playlistId, p);
    }
    return p;
  };

  const client = {
    async get<T>(path: string, params?: Record<string, string>): Promise<T | null> {
      const itemsMatch = /^\/playlists\/([^/]+)\/items$/.exec(path);
      if (itemsMatch) {
        const p = resolve(decodeURIComponent(itemsMatch[1]));
        const limit = Number(params?.limit ?? '100');
        const offset = Number(params?.offset ?? '0');
        const page = p.uris.slice(offset, offset + limit).map(item);
        const next = offset + limit < p.uris.length;
        return {
          items: page,
          limit,
          offset,
          total: p.uris.length,
          next: next ? `offset=${offset + limit}` : null,
        } as unknown as T;
      }
      const metaMatch = /^\/playlists\/([^/]+)$/.exec(path);
      if (metaMatch) {
        const p = resolve(decodeURIComponent(metaMatch[1]));
        return { id: p.id, name: p.name, tracks: { total: p.uris.length } } as unknown as T;
      }
      if (path === '/search') {
        return {
          tracks: {
            items: [
              { type: 'track', id: 's1', name: 'Search One', uri: trackUri(91), duration_ms: 200_000, artists: [{ name: 'A' }], album: { id: 'a1', release_date: '2024-01-01' } },
              { type: 'track', id: 's2', name: 'Search Two', uri: trackUri(92), duration_ms: 200_000, artists: [{ name: 'A' }], album: { id: 'a1', release_date: '2024-01-01' } },
            ],
            total: 2,
            limit: Number(params?.limit ?? '20'),
            offset: Number(params?.offset ?? '0'),
          },
        } as unknown as T;
      }
      return null;
    },
    async getAllPages<T>(path: string, params?: Record<string, string>, opts?: { maxItems?: number }): Promise<T[]> {
      const all: T[] = [];
      let offset = 0;
      const limit = Number(params?.limit ?? '100');
      for (;;) {
        const page = await this.get<SpotifyPaged<T>>(path, { ...params, offset: String(offset) });
        if (!page || !Array.isArray(page.items)) break;
        all.push(...page.items);
        if (opts?.maxItems && all.length >= opts.maxItems) return all.slice(0, opts.maxItems);
        if (!page.next) break;
        offset += limit;
      }
      return all;
    },
    async post<T>(path: string, body?: unknown): Promise<T | null> {
      const created = /^\/me\/playlists$/.test(path);
      const addMatch = /^\/playlists\/([^/]+)\/items$/.exec(path);
      if (created) {
        const id = `new${++nextId}`;
        if (mutates) resolve(id);
        return { id, uri: `spotify:playlist:${id}`, snapshot_id: `snap-${id}` } as unknown as T;
      }
      if (addMatch) {
        const p = resolve(decodeURIComponent(addMatch[1]));
        writes.push({ method: 'POST', id: p.id, body });
        if (mutates) p.uris.push(...((body as { uris?: string[] }).uris ?? []));
        return { snapshot_id: `snap-${p.id}` } as unknown as T;
      }
      return null;
    },
    async put<T>(path: string, body?: unknown): Promise<T | null> {
      const replaceMatch = /^\/playlists\/([^/]+)\/items$/.exec(path);
      if (replaceMatch) {
        const p = resolve(decodeURIComponent(replaceMatch[1]));
        writes.push({ method: 'PUT', id: p.id, body });
        if (mutates) p.uris = [...((body as { uris?: string[] }).uris ?? [])];
        return { snapshot_id: `snap-${p.id}` } as unknown as T;
      }
      return null;
    },
    async delete<T>(path: string, body?: unknown): Promise<T | null> {
      const delMatch = /^\/playlists\/([^/]+)\/items$/.exec(path);
      if (delMatch) {
        const p = resolve(decodeURIComponent(delMatch[1]));
        writes.push({ method: 'DELETE', id: p.id, body });
        if (mutates) {
          // Remove from the tail so a chunk's own positions stay valid, the
          // same order the production code deletes in (#A6-003).
          const doomed: Array<{ uri: string; positions?: number[] }> =
            (body as { tracks?: Array<{ uri: string; positions?: number[] }> }).tracks ?? [];
          for (const track of [...doomed].reverse()) {
            if (track.positions?.length) {
              for (const pos of [...track.positions].sort((a, b) => b - a)) p.uris.splice(pos, 1);
            } else {
              for (let i = p.uris.length - 1; i >= 0; i--) if (p.uris[i] === track.uri) p.uris.splice(i, 1);
            }
          }
        }
        return { snapshot_id: `snap-${p.id}` } as unknown as T;
      }
      return null;
    },
  };
  return { client, writes, playlists: byId };
}

function harness(register: (s: McpServer, c: SpotifyClient) => void, options: StubOptions) {
  const registered: RegisteredTool[] = [];
  const fakeServer = {
    tool(name: string, _description: string, schema: z.ZodRawShape, handler: RegisteredTool['handler']) {
      registered.push({ name, validate: (a) => z.object(schema).parse(a), handler });
    },
    registerTool(name: string, config: { inputSchema?: z.ZodType }, handler: RegisteredTool['handler']) {
      registered.push({ name, validate: (a) => (config.inputSchema as z.ZodType).parse(a), handler });
    },
  } as unknown as McpServer;
  const stub = makeStub(options);
  register(fakeServer, stub.client as unknown as SpotifyClient);
  return {
    stub,
    invoke: async (name: string, args: Record<string, unknown>) => {
      const tool = registered.find((t) => t.name === name);
      assert.ok(tool, `tool "${name}" should be registered`);
      return tool.handler(tool.validate(args));
    },
  };
}

const receiptsOf = (r: { structuredContent?: Record<string, unknown> }) =>
  (r.structuredContent?.receipts ?? []) as Array<Record<string, unknown>>;
const textOf = (r: { content: Array<{ text: string }> }) => r.content.map((c) => c.text).join('\n');

/** Five-item source playlist, ids that survive `normalizePlaylistRef`. */
const sourcePlaylist = (id = 'src'): PlaylistState => ({
  id,
  name: 'Source',
  uris: [1, 2, 3, 4, 5].map(trackUri),
});

// ---------------------------------------------------------------------------

describe('#879 exhaust2 atomicReplace verifies the write', () => {
  // A dropped PUT is invisible to a uri-PRESENCE check: the replace leaves the
  // playlist on its old rows, and those already contain the episodes that
  // survive the strip. What separates the two cases is the row count — a
  // replace must end up holding exactly the rows it wrote — so the receipt
  // states that contract and the verdict reports the two numbers.
  const mixed = (): PlaylistState => ({
    id: 'mix1',
    name: 'Friday Mix',
    uris: [trackUri(1), episodeUri(1), trackUri(2), episodeUri(2), trackUri(3)],
  });
  const run = (mutates: boolean) =>
    harness(registerExhaust2PlaylistsTools, { mutates, playlists: [mixed()] });

  it('reports ok:false and an UNVERIFIED receipt when the PUT is silently dropped', async () => {
    const h = run(false);
    const out = await h.invoke('playlist_strip_episodes', {
      playlist_id: 'mix1',
      strip: 'tracks',
      dry_run: false,
      response_format: 'concise',
    });
    const sc = out.structuredContent!;
    assert.equal(sc.ok, false, 'a dropped write must not report success');
    assert.equal(sc.expected, 2, 'only the episodes survive the strip');
    assert.equal(sc.actual, 5, 'the playlist still holds all five rows');
    const receipts = receiptsOf(out);
    assert.equal(receipts.length, 1);
    assert.equal(receipts[0].verified, false);
    assert.deepEqual(receipts[0].missing, [], 'both episodes really are still there');
    assert.equal(
      receipts[0].unmet,
      'row count 5 \u2260 expected 2',
      'the receipt must name the rows it expected against the rows it found',
    );
    assert.match(textOf(out), /UNVERIFIED \(playlist_items mix1\)/);
    assert.match(textOf(out), /items before\/after: \?\/5/);
    assert.match(textOf(out), /unmet: row count 5 \u2260 expected 2/);
  });

  it('reports ok:true and a VERIFIED receipt when the PUT mutates', async () => {
    const h = run(true);
    const out = await h.invoke('playlist_strip_episodes', {
      playlist_id: 'mix1',
      strip: 'tracks',
      dry_run: false,
      response_format: 'concise',
    });
    const sc = out.structuredContent!;
    assert.equal(sc.ok, true);
    assert.equal(sc.expected, 2);
    assert.equal(sc.actual, 2);
    const receipts = receiptsOf(out);
    assert.equal(receipts[0].verified, true);
    assert.deepEqual(receipts[0].missing, []);
    assert.equal(receipts[0].after, 2);
    assert.match(textOf(out), /VERIFIED \(playlist_items mix1\)/);
  });
});

describe('#879 swarm3_playlistops atomicReplace verifies the write', () => {
  const run = (mutates: boolean) =>
    harness(registerSwarm3PlaylistopsTools, { mutates, playlists: [sourcePlaylist()] });

  // A reverse is the hard case for verification: the multiset and the row
  // count are both identical whether the PUT lands or not, and every uri is
  // still present. Only the ORDER tells them apart, so this pair of tests is
  // what pins the order check — a presence-only or count-only receipt passes
  // this scenario and would report a dropped reverse as a success.
  it('reverse_playlist reports ok:false when the PUT is silently dropped', async () => {
    const h = run(false);
    const out = await h.invoke('reverse_playlist_plan', {
      playlist_id: 'src',
      dry_run: false,
      response_format: 'concise',
    });
    const sc = out.structuredContent!;
    assert.equal(sc.ok, false);
    assert.equal(sc.expected, 5, 'five rows either way — the count cannot catch this');
    assert.equal(sc.actual, 5, 'five rows either way — the count cannot catch this');
    const receipts = receiptsOf(out);
    assert.equal(receipts[0].verified, false);
    assert.deepEqual(receipts[0].missing, [], 'every uri is present; only the order is wrong');
    assert.match(String(receipts[0].unmet), /^row 0 is spotify:track:t01, expected spotify:track:t05$/);
    assert.match(textOf(out), /UNVERIFIED \(playlist_items src\)/);
  });

  it('reverse_playlist reports ok:true when the PUT mutates', async () => {
    const h = run(true);
    const out = await h.invoke('reverse_playlist_plan', {
      playlist_id: 'src',
      dry_run: false,
      response_format: 'concise',
    });
    const sc = out.structuredContent!;
    assert.equal(sc.ok, true);
    assert.equal(sc.actual, 5);
    assert.equal(receiptsOf(out)[0].verified, true);
    assert.equal(receiptsOf(out)[0].unmet, undefined);
    assert.match(textOf(out), /VERIFIED \(playlist_items src\)/);
    assert.deepEqual(h.stub.playlists.get('src')?.uris, [5, 4, 3, 2, 1].map(trackUri));
  });
});

describe('#879 swarm3_playlistops chunked adds verify each chunk', () => {
  // 150 uris is two writes at the 100-per-request cap, so this is the
  // multi-chunk path where a per-chunk receipt matters.
  const big = (): PlaylistState => ({
    id: 'src',
    name: 'Source',
    uris: Array.from({ length: 150 }, (_, i) => trackUri(i)),
  });

  it('ok:false with two UNVERIFIED receipts when nothing lands', async () => {
    const h = harness(registerSwarm3PlaylistopsTools, { mutates: false, playlists: [big()] });
    const out = await h.invoke('playlist_clone_live', {
      playlist_id: 'src',
      new_name: 'Clone',
      dry_run: false,
      response_format: 'json',
    });
    const sc = out.structuredContent!;
    assert.equal(sc.ok, false);
    assert.equal(sc.expected, 150);
    assert.equal(sc.actual, 0);
    const receipts = receiptsOf(out);
    assert.equal(receipts.length, 2, 'one receipt per chunk, not one per call');
    assert.deepEqual(receipts.map((r) => r.verified), [false, false]);
    assert.equal((receipts[0].missing as string[]).length, 100);
    assert.equal((receipts[1].missing as string[]).length, 50);
  });

  it('ok:true with two VERIFIED receipts when the chunks land', async () => {
    const h = harness(registerSwarm3PlaylistopsTools, { mutates: true, playlists: [big()] });
    const out = await h.invoke('playlist_clone_live', {
      playlist_id: 'src',
      new_name: 'Clone',
      dry_run: false,
      response_format: 'json',
    });
    const sc = out.structuredContent!;
    assert.equal(sc.ok, true);
    assert.equal(sc.actual, 150);
    assert.deepEqual(receiptsOf(out).map((r) => r.verified), [true, true]);
    assert.deepEqual(h.stub.playlists.get('new1')?.uris, big().uris);
  });
});

describe('#879 swarm3_playlistops targeted removals verify by row', () => {
  // Two copies of the same track. A bare "is this uri gone?" check can never
  // pass here — the surviving copy is not the row that was deleted — so the
  // receipt has to verify the POSITION, and `before` is what makes that check
  // able to fail at all.
  const withDuplicate = (): PlaylistState => ({
    id: 'src',
    name: 'Source',
    uris: [trackUri(1), trackUri(2), trackUri(1), trackUri(3)],
  });

  it('ok:true on a playlist holding a duplicate of the deleted uri', async () => {
    const h = harness(registerSwarm3PlaylistopsTools, { mutates: true, playlists: [withDuplicate()] });
    const out = await h.invoke('remove_playlist_range', {
      playlist_id: 'src',
      start: 0,
      end: 1,
      dry_run: false,
      response_format: 'json',
    });
    const sc = out.structuredContent!;
    assert.equal(sc.ok, true, 'deleting one of two copies must verify, not raise a false alarm');
    const receipts = receiptsOf(out);
    assert.equal(receipts[0].verified, true);
    assert.equal(receipts[0].before, 4, 'the pre-mutation row count is what the refetch is compared against');
    assert.equal(receipts[0].after, 3);
    assert.deepEqual(h.stub.playlists.get('src')?.uris, [trackUri(2), trackUri(1), trackUri(3)]);
  });

  it('ok:false when the DELETE is silently dropped', async () => {
    const h = harness(registerSwarm3PlaylistopsTools, { mutates: false, playlists: [withDuplicate()] });
    const out = await h.invoke('remove_playlist_range', {
      playlist_id: 'src',
      start: 0,
      end: 1,
      dry_run: false,
      response_format: 'json',
    });
    const sc = out.structuredContent!;
    assert.equal(sc.ok, false, 'a dropped DELETE must not report a completed removal');
    const receipts = receiptsOf(out);
    assert.equal(receipts[0].verified, false);
    // #626: a row-count failure is reported in `unmet`, not filed into
    // `missing` — `missing` is uris the walk did not find and is consumed as
    // data. The assertion is that a human-readable reason is surfaced
    // somewhere, so it now reads the field the reason actually lives in.
    assert.match(
      (receipts[0].reason ?? '') + (receipts[0].unmet ?? '') + JSON.stringify(receipts[0].missing),
      /row count|still-present|missing/,
      'a failed receipt must say why it failed',
    );
  });
});

describe('#879 exhaust2 addUrisChunked verifies the add', () => {
  const seed = (mutates: boolean) => harness(registerExhaust2PlaylistsTools, {
    mutates,
    playlists: [{ id: 'mix1', name: 'Friday Mix', uris: [] }],
  });

  it('playlist_add_by_search: ok:false when the add is dropped, ok:true when it lands', async () => {
    const dropped = await seed(false).invoke('playlist_add_by_search', {
      playlist_id: 'mix1',
      query: 'Radiohead',
      pick: 2,
      dry_run: false,
      response_format: 'json',
    });
    assert.equal(dropped.structuredContent!.ok, false);
    assert.equal(receiptsOf(dropped)[0].verified, false);

    const landed = await seed(true).invoke('playlist_add_by_search', {
      playlist_id: 'mix1',
      query: 'Radiohead',
      pick: 2,
      dry_run: false,
      response_format: 'json',
    });
    assert.equal(landed.structuredContent!.ok, true);
    assert.equal(receiptsOf(landed)[0].verified, true);
    assert.equal(landed.structuredContent!.expected, 2);
  });
});
