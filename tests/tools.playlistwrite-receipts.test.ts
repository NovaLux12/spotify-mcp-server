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

import './helpers/hermetic.js';

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { SpotifyClient } from '../src/client.js';
import { StubFromResponder } from './helpers/stub-client.js';
import type { LegacyResponder } from './helpers/stub-client.js';
import { registerSwarm3PlaylistopsTools } from '../src/tools/swarm3_playlistops.js';
import { registerExhaust2PlaylistsTools } from '../src/tools/exhaust2_playlists.js';
import { initConfig } from '../src/config.js';
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
  /**
   * Which spelling of the item total `/playlists/{id}` serves (#1529).
   *
   *  - `legacy`   — `tracks.total` only (the pre-Feb-2026 shape; the default
   *                 so every existing fixture keeps its baseline)
   *  - `canonical`— `items.total` only, the replacement field
   *  - `none`     — neither; a body that states no count at all
   */
  metaPage?: 'legacy' | 'canonical' | 'none';
}

/**
 * A stub that serves real pagination, because `issueReceipt` walks
 * `/playlists/{id}/items` in 100-row pages and reads `total` (#729). A stub
 * that returned a bare array would make every receipt look unverified and the
 * passing half of each test would be vacuous.
 */
function makeStub({ mutates, playlists, metaPage = 'legacy' }: StubOptions) {
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

  // #659: this file's walk stopped on `!page.next` and applied no cap at all,
  // so neither the production cap nor its short-page break could reach it. The
  // shared stub runs the real loop over these same fixtures.
  const read: LegacyResponder = (path, rawParams) => {
    const params = rawParams as Record<string, string> | undefined;
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
        };
      }
      const metaMatch = /^\/playlists\/([^/]+)$/.exec(path);
      if (metaMatch) {
        const p = resolve(decodeURIComponent(metaMatch[1]));
        // The item total is spelled `items` (canonical since Feb 2026) or
        // `tracks` (the deprecated page some payloads still carry), and a body
        // can state neither. Which one is served is a property of the FIXTURE,
        // not of the tool under test, so it is a stub option (#1529).
        if (metaPage === 'canonical') return { id: p.id, name: p.name, items: { total: p.uris.length } };
        if (metaPage === 'none') return { id: p.id, name: p.name };
        return { id: p.id, name: p.name, tracks: { total: p.uris.length } };
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
        };
      }
      return null;
  };
  const writePost: LegacyResponder = (path, body) => {
      const created = /^\/me\/playlists$/.test(path);
      const addMatch = /^\/playlists\/([^/]+)\/items$/.exec(path);
      if (created) {
        const id = `new${++nextId}`;
        if (mutates) resolve(id);
        return { id, uri: `spotify:playlist:${id}`, snapshot_id: `snap-${id}` };
      }
      if (addMatch) {
        const p = resolve(decodeURIComponent(addMatch[1]));
        writes.push({ method: 'POST', id: p.id, body });
        if (mutates) p.uris.push(...((body as { uris?: string[] }).uris ?? []));
        return { snapshot_id: `snap-${p.id}` };
      }
      return null;
  };
  const writePut: LegacyResponder = (path, body) => {
      const replaceMatch = /^\/playlists\/([^/]+)\/items$/.exec(path);
      if (replaceMatch) {
        const p = resolve(decodeURIComponent(replaceMatch[1]));
        writes.push({ method: 'PUT', id: p.id, body });
        if (mutates) p.uris = [...((body as { uris?: string[] }).uris ?? [])];
        return { snapshot_id: `snap-${p.id}` };
      }
      return null;
  };
  const writeDelete: LegacyResponder = (path, body) => {
      const delMatch = /^\/playlists\/([^/]+)\/items$/.exec(path);
      if (delMatch) {
        const p = resolve(decodeURIComponent(delMatch[1]));
        writes.push({ method: 'DELETE', id: p.id, body });
        if (mutates) {
          const doomed: Array<{ uri: string; positions?: number[] }> =
            (body as { tracks?: Array<{ uri: string; positions?: number[] }> }).tracks ?? [];
          // Every `positions` entry in one request refers to the playlist as it
          // stood BEFORE the request, so the whole set has to come off
          // tail-first in one pass. This used to splice row-by-row in the
          // order the body listed them, which was right only for an ASCENDING
          // body — and the production callers send descending (`doomedDesc`,
          // #A6-003), so a multi-row chunk silently deleted every other row.
          // Invisible at one row per chunk, which is all this file used to
          // send; #1529's multi-chunk case is what exposed it.
          const byPosition = doomed.flatMap((t) => t.positions ?? []);
          if (byPosition.length > 0) {
            for (const pos of byPosition.sort((a, b) => b - a)) p.uris.splice(pos, 1);
          } else {
            for (const track of doomed) {
              for (let i = p.uris.length - 1; i >= 0; i--) if (p.uris[i] === track.uri) p.uris.splice(i, 1);
            }
          }
        }
        return { snapshot_id: `snap-${p.id}` };
      }
      return null;
  };
  const client = new StubFromResponder(read, {
    writes: { POST: writePost, PUT: writePut, DELETE: writeDelete },
  });
  return { client, writes, playlists: byId };
}

function harness(register: (s: McpServer, c: SpotifyClient) => void, options: StubOptions) {
  const registered: RegisteredTool[] = [];
  const fakeServer = {
    tool(name: string, _description: string, schema: z.ZodRawShape, handler: RegisteredTool['handler']) {
      registered.push({ name, validate: (a) => z.object(schema).parse(a), handler });
    },
    registerTool(name: string, config: { inputSchema?: z.ZodType<Record<string, unknown>> }, handler: RegisteredTool['handler']) {
      registered.push({ name, validate: (a) => (config.inputSchema as z.ZodType<Record<string, unknown>>).parse(a), handler });
    },
  } as unknown as McpServer;
  const stub = makeStub(options);
  register(fakeServer, stub.client);
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
    // `reason` and `unmet` are `unknown` on an untyped receipt row, so each is
    // read only when it is actually a string. Concatenating `unknown` is what
    // the previous line did, and it produced `{}` for both fields.
    const why = [receipts[0].reason, receipts[0].unmet]
      .map((value) => (typeof value === 'string' ? value : ''))
      .join('');
    assert.match(
      why + JSON.stringify(receipts[0].missing),
      /row count|still-present|missing/,
      'a failed receipt must say why it failed',
    );
  });
});

// ---------------------------------------------------------------------------
// 3. #1529 — the playlist total is read, not guessed
// ---------------------------------------------------------------------------

/**
 * A capped item walk, so the row count `loadPlaylistFull` returns is
 * demonstrably NOT the playlist's size. Five rows in the playlist, a walk that
 * reads two of them, and `SPOTIFY_MCP_FETCH_ALL_CAP=2` to make the cap bind —
 * the shape of every playlist over 500 items.
 */
async function withCappedWalk<T>(fn: () => Promise<T>): Promise<T> {
  initConfig({ ...process.env, SPOTIFY_MCP_FETCH_ALL_CAP: '2' });
  try {
    return await fn();
  } finally {
    initConfig();
  }
}

/** Five rows, of which the capped walk reads two. */
const cappedPlaylist = (): PlaylistState => ({
  id: 'src',
  name: 'Source',
  uris: [1, 2, 3, 4, 5].map(trackUri),
});

/** Delete row 0. The playlist then holds four rows, which both stubs can prove. */
const removeFirstRow = { playlist_id: 'src', start: 0, end: 1, dry_run: false, response_format: 'json' } as const;

describe('#1529 swarm3_playlistops reads the playlist total, never the row count', () => {
  // The two assertions that make these load-bearing: `before` is the
  // pre-mutation row count the receipt compares the re-read against, and 2 is
  // the number the capped walk saw. Any implementation that substitutes the
  // walk's row count puts 2 there — and then the receipt reports
  // `row count 4 ≠ expected 1` for a delete that landed.
  it('reads items.total when the body carries only the canonical page', async () => {
    await withCappedWalk(async () => {
      const h = harness(registerSwarm3PlaylistopsTools, {
        mutates: true,
        playlists: [cappedPlaylist()],
        metaPage: 'canonical',
      });
      const out = await h.invoke('remove_playlist_range', { ...removeFirstRow });
      const receipts = receiptsOf(out);
      assert.equal(receipts.length, 1);
      assert.equal(
        receipts[0].before,
        5,
        'items.total is the playlist size; the walk read 2 and that is not an answer',
      );
      assert.equal(receipts[0].after, 4, 'the row really is gone');
      assert.equal(receipts[0].verified, true, 'a landed write must not be reported as a row-count mismatch');
      assert.equal(out.structuredContent!.ok, true);
    });
  });

  it('still reads the legacy tracks.total when only the deprecated page is served', async () => {
    await withCappedWalk(async () => {
      const h = harness(registerSwarm3PlaylistopsTools, {
        mutates: true,
        playlists: [cappedPlaylist()],
        metaPage: 'legacy',
      });
      const out = await h.invoke('remove_playlist_range', { ...removeFirstRow });
      const receipts = receiptsOf(out);
      assert.equal(receipts[0].before, 5, 'the deprecated page is still a real count when it is the only one served');
      assert.equal(receipts[0].verified, true);
    });
  });

  it('reads NO total when the body states none, instead of the capped row count', async () => {
    await withCappedWalk(async () => {
      const h = harness(registerSwarm3PlaylistopsTools, {
        mutates: true,
        playlists: [cappedPlaylist()],
        metaPage: 'none',
      });
      const out = await h.invoke('remove_playlist_range', { ...removeFirstRow });
      const receipts = receiptsOf(out);
      assert.equal(receipts.length, 1);
      assert.equal(
        receipts[0].before,
        undefined,
        'the walk read 2 rows; reporting that as the playlist size is the #1529 defect',
      );
      assert.ok(!('before' in receipts[0]), 'an unread count is absent, not present-and-undefined');
      // The write landed, and the receipt says so in the only way that is true:
      // it could not run its comparison. That is the difference #1529 is about
      // — "I could not read the total" versus "the write failed".
      assert.equal(receipts[0].verified, false);
      assert.match(
        String(receipts[0].unmet),
        /no baseline/,
        'the reason must name the missing baseline, not a row count nobody read',
      );
      assert.doesNotMatch(
        String(receipts[0].unmet),
        /row count \d+ ≠ expected \d+/,
        'a row-count mismatch would name a number this body never stated',
      );
      assert.equal(receipts[0].after, 4, 'the re-read still reports the real size; only the baseline is missing');
      assert.deepEqual(h.stub.playlists.get('src')?.uris, [2, 3, 4, 5].map(trackUri), 'the delete landed');
    });
  });

  // A tail-first delete decrements the running baseline per chunk. With no
  // baseline, `undefined - 100` is `NaN`, and `NaN - 100` stays `NaN` — so the
  // SECOND chunk is where a naive decrement would first be visible, printing
  // `row count 50 ≠ expected NaN` for a write that landed. 150 doomed rows is
  // two chunks at the 100-per-request cap.
  it('does not print NaN as a row count on the second chunk of a multi-chunk delete', async () => {
    // #1568: a 150-row range removal is above REMOVE_ELICIT_THRESHOLD, so the
    // commit now asks. This test is about the receipt arithmetic, not the
    // gate, and its harness supplies a server that cannot prompt — so the
    // documented automation bypass is what lets the write reach the two
    // chunks under test. The gate itself is asserted from both sides of its
    // threshold in tests/tools.bulk-removal-gates.test.ts.
    const priorConfirm = process.env.SPOTIFY_MCP_CONFIRM;
    process.env.SPOTIFY_MCP_CONFIRM = 'never';
    initConfig({ ...process.env, SPOTIFY_MCP_FETCH_ALL_CAP: '200' });
    try {
      const h = harness(registerSwarm3PlaylistopsTools, {
        mutates: true,
        playlists: [{ id: 'src', name: 'Source', uris: Array.from({ length: 150 }, (_, i) => trackUri(i)) }],
        metaPage: 'none',
      });
      const out = await h.invoke('remove_playlist_range', {
        playlist_id: 'src',
        start: 0,
        end: 150,
        dry_run: false,
        response_format: 'json',
      });
      const receipts = receiptsOf(out);
      assert.equal(receipts.length, 2, '150 rows is two chunks at the playlist_writes cap of 100');
      for (const [i, r] of receipts.entries()) {
        assert.equal(r.before, undefined, `chunk ${i} has no baseline to state`);
        assert.doesNotMatch(String(r.unmet), /NaN/, `chunk ${i} must not name a number arithmetic invented`);
        assert.match(String(r.unmet), /no baseline/, `chunk ${i} must name the missing baseline`);
      }
      // The write did land in both cases — the point of this line is that a
      // non-zero remainder would be the #A6-003 ORDERING, not a chunk that
      // failed to arrive. Under ascending positions the first chunk removes
      // rows 0-99, the second chunk's positions then address shifted rows, and
      // 50 of the 150 survive: a `50 !== 0` failure under a message about
      // DELIVERY sends a maintainer to the chunking loop while the sort that
      // broke is `doomedDesc`, in another file. #1616. The property itself is
      // asserted directly in the `#A6-003` describe below.
      assert.equal(
        h.stub.playlists.get('src')?.uris.length,
        0,
        'all 150 rows are gone. A remainder here is the tail-first ordering, not chunk delivery: a chunk '
        + 'that lands shifts every position after it, so the sends must run descending (doomedDesc in '
        + 'src/tools/swarm3_playlistops.ts) for the later chunk to still address the rows it names.',
      );
    } finally {
      if (priorConfirm === undefined) delete process.env.SPOTIFY_MCP_CONFIRM;
      else process.env.SPOTIFY_MCP_CONFIRM = priorConfirm;
      initConfig();
    }
  });
});

// ---------------------------------------------------------------------------
// #1616 — the tail-first ordering, asserted as the property it is
// ---------------------------------------------------------------------------

/**
 * #A6-003 is a claim about ORDER, and nothing in the tree asserted it.
 *
 * `remove_playlist_range` deletes by POSITION, and a position is an index into
 * the playlist *as it stands when the request lands*. So a chunk that lands
 * shifts every position below it by the number of rows it removed, and any
 * later request carrying a pre-shift index addresses a different row. Sending
 * the doomed rows in descending order keeps every later index valid, because
 * the rows a later chunk names all sit ABOVE the rows an earlier chunk removed.
 * That is what the comment above `doomedDesc` in `swarm3_playlistops.ts` argues,
 * and the only assertion anywhere that touches it read the FINAL ROW COUNT.
 *
 * A final-row-count assertion does catch the regression — but by accident, and
 * it misnames the cause. Under ascending order the first chunk removes rows
 * 0–99, the second chunk's positions then address shifted rows, 50 of the 150
 * survive, and the failure reads `50 !== 0` under a message about chunk
 * DELIVERY. A maintainer reading that is sent to the chunking loop, while the
 * sort that actually broke sits in another file.
 *
 * So the property is stated here directly: the removals go out in strictly
 * descending position order, and replaying that sequence against a model of
 * the playlist shows every position was in range at the instant it was sent.
 * The second half is what makes the first one mean something — descending is
 * only correct relative to what the earlier chunks removed.
 */
describe('#A6-003 remove_playlist_range deletes tail-first', () => {
  /**
   * The positions one DELETE body carried, in the order the body listed them.
   *
   * `tracks[].positions` is the whole wire contract for a positional delete, so
   * this is the level the property lives at — not the stub's spliced result,
   * which is the thing under suspicion.
   */
  const positionsOf = (body: unknown): number[] => {
    const tracks = (body as { tracks?: unknown } | null)?.tracks;
    if (!Array.isArray(tracks)) return [];
    return tracks.flatMap((t) => {
      const positions = (t as { positions?: unknown } | null)?.positions;
      return Array.isArray(positions) ? positions.map(Number) : [];
    });
  };

  /** 150 rows, the size #1529 uses — two chunks at the 100-per-request cap. */
  const wideSource = () => Array.from({ length: 150 }, (_, i) => trackUri(i));

  async function deleteWholeRange() {
    // Above REMOVE_ELICIT_THRESHOLD, so the commit asks. The documented
    // automation bypass is what lets the write reach the two chunks; the gate
    // itself is asserted from both sides in tests/tools.bulk-removal-gates.test.ts.
    const priorConfirm = process.env.SPOTIFY_MCP_CONFIRM;
    process.env.SPOTIFY_MCP_CONFIRM = 'never';
    initConfig({ ...process.env, SPOTIFY_MCP_FETCH_ALL_CAP: '200' });
    try {
      const h = harness(registerSwarm3PlaylistopsTools, {
        mutates: true,
        playlists: [{ id: 'src', name: 'Source', uris: wideSource() }],
      });
      const out = await h.invoke('remove_playlist_range', {
        playlist_id: 'src',
        start: 0,
        end: 150,
        dry_run: false,
        response_format: 'json',
      });
      const chunks = h.stub.writes
        .filter((w) => w.method === 'DELETE' && w.id === 'src')
        .map((w) => positionsOf(w.body));
      return { h, chunks, out };
    } finally {
      if (priorConfirm === undefined) delete process.env.SPOTIFY_MCP_CONFIRM;
      else process.env.SPOTIFY_MCP_CONFIRM = priorConfirm;
      initConfig();
    }
  }

  it('sends every removal in descending position order, so no chunk invalidates the next', async () => {
    const { chunks } = await deleteWholeRange();
    assert.equal(chunks.length, 2, '150 rows is two chunks at the playlist_writes cap of 100');

    const sent = chunks.flat();
    assert.equal(sent.length, 150, 'every doomed row is addressed exactly once');
    for (const [i, position] of sent.entries()) {
      const previous = i === 0 ? undefined : sent[i - 1]!;
      assert.ok(
        previous === undefined || position < previous,
        `removal ${i} sent position ${position} after ${previous}. Positions are indices into the `
        + 'playlist AS IT STANDS, so a chunk that lands shifts every later index down: sending them '
        + 'ascending makes the second chunk address the wrong rows. The sort that has to be descending '
        + 'is `doomedDesc` in src/tools/swarm3_playlistops.ts — not the chunking, and not delivery.',
      );
    }
  });

  it('keeps each chunk valid against the playlist as it stands when that chunk lands', async () => {
    const { chunks } = await deleteWholeRange();

    // Replay the requests against a model of the playlist, exactly as the
    // endpoint would: each request's positions refer to the rows present when
    // it lands, and a position that names a row already gone is a request the
    // server would answer with a snapshot that deleted the wrong thing.
    const model = wideSource();
    const stale: number[] = [];
    for (const chunk of chunks) {
      for (const position of [...chunk].sort((a, b) => b - a)) {
        if (position < 0 || position >= model.length) {
          stale.push(position);
          continue;
        }
        model.splice(position, 1);
      }
    }

    assert.deepEqual(
      stale,
      [],
      `these positions named no row at the moment they were sent: ${stale.join(', ')}. Every send is `
      + 'an index into the CURRENT playlist, so the rows have to leave from the tail backwards '
      + '(doomedDesc in src/tools/swarm3_playlistops.ts) for the later chunks to still be addressing '
      + 'the rows they name.',
    );
    assert.equal(
      model.length,
      0,
      'replaying the requests that were sent removes all 150 rows; any remainder is a position that '
      + 'addressed a shifted row, which is the tail-first ordering failing, not a dropped write',
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
