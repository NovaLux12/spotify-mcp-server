/**
 * Tests for src/tools/libraryhygiene.ts (#112 idea 5 — album completion &
 * consolidation hygiene).
 *
 * Same stub harness approach as tests/tools.playlists-following.test.ts:
 * stub MCP server + stub SpotifyClient recording every call — no network.
 *
 * Run: node --import tsx --test tests/tools.libraryhygiene.test.ts
 */

import { describe, it } from 'node:test';
import { z } from 'zod';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { SpotifyClient } from '../src/client.js';
import { SpotifyApiError } from '../src/client.js';
import type { SavedTrackItem, SpotifyAlbumFull } from '../src/types/spotify.js';
import { registerLibraryHygieneTools } from '../src/tools/libraryhygiene.js';

// ---------------------------------------------------------------------------
// Stub plumbing
// ---------------------------------------------------------------------------

type Responder = (path: string, arg: unknown) => unknown;

interface RegisteredTool {
  name: string;
  description: string;
  validate: (args: Record<string, unknown>) => Record<string, unknown>;
  handler: (
    args: Record<string, unknown>,
  ) => Promise<{
    content: Array<{ type: string; text: string }>;
    structuredContent?: Record<string, unknown>;
  }>;
}

function makeStubClient(responder: Responder = () => null) {
  const calls: Array<{ method: string; path: string; arg?: unknown }> = [];
  let respond: Responder = responder;
  const client = {
    calls,
    async get<T>(path: string, params?: Record<string, string>): Promise<T | null> {
      calls.push({ method: 'GET', path, arg: params });
      return respond(path, params) as T | null;
    },
    // Mirrors SpotifyClient.getAllPages over the stubbed get().
    async getAllPages<T>(
      path: string,
      params?: Record<string, string>,
      opts?: { maxItems?: number },
    ): Promise<T[]> {
      const maxItems = opts?.maxItems ?? 500;
      const all: T[] = [];
      let offset = 0;
      for (;;) {
        const page = await this.get<{ items: T[]; total?: number; limit?: number }>(path, {
          ...params,
          offset: String(offset),
        });
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
  } as unknown as McpServer;
  const client = makeStubClient(responder);
  registerLibraryHygieneTools(fakeServer, client as unknown as SpotifyClient);
  return {
    registered,
    client,
    invoke: async (name: string, args: Record<string, unknown> = {}) => {
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

interface TrackSpec {
  id: string;
  name?: string;
  artistId: string;
  albumId: string;
}

const likedTrack = (spec: TrackSpec): SavedTrackItem => ({
  added_at: '2026-01-01T00:00:00Z',
  track: {
    id: spec.id,
    name: spec.name ?? `Track ${spec.id}`,
    uri: `spotify:track:${spec.id}`,
    type: 'track',
    duration_ms: 200000,
    explicit: false,
    artists: [{ id: spec.artistId, name: `Artist ${spec.artistId}` }],
    album: { id: spec.albumId, name: `Album ${spec.albumId}`, uri: `spotify:album:${spec.albumId}` },
  },
});

const albumFull = (
  id: string,
  opts: {
    total_tracks?: number;
    album_type?: string;
    trackIds?: string[];
    artistIds?: string[];
  } = {},
): SpotifyAlbumFull => ({
  id,
  name: `Album ${id}`,
  uri: `spotify:album:${id}`,
  album_type: opts.album_type ?? 'album',
  release_date: '2026-01-01',
  total_tracks: opts.total_tracks ?? (opts.trackIds?.length ?? 1),
  artists: (opts.artistIds ?? ['a1']).map((aid) => ({ id: aid, name: `Artist ${aid}` })),
  images: [],
  tracks: {
    items: (opts.trackIds ?? []).map((tid) => ({
      id: tid,
      name: `Track ${tid}`,
      uri: `spotify:track:${tid}`,
      duration_ms: 200000,
      explicit: false,
      track_number: 1,
      artists: [{ id: opts.artistIds?.[0] ?? 'a1', name: `Artist ${opts.artistIds?.[0] ?? 'a1'}` }],
    })),
    total: opts.trackIds?.length ?? 0,
  },
});

/**
 * Responder serving a /me/tracks library of exactly `tracks` in pages of 50,
 * plus the per-id `GET /albums/{id}` fan-in. The removed `GET /albums?ids=`
 * route is deliberately NOT served, and `batchAlbumCalls` asserts it is never
 * asked for: a regression to the batch route must fail loudly rather than be
 * quietly absorbed by a fixture.
 */
function libraryResponder(
  tracks: SavedTrackItem[],
  albums: Record<string, SpotifyAlbumFull>,
  opts: { throttleIds?: readonly string[]; retryAfterSec?: number } = {},
) {
  const throttled = new Set(opts.throttleIds ?? []);
  return (path: string, params?: Record<string, string>) => {
    if (path === '/me/tracks') {
      const limit = 50;
      const offset = Number(params?.offset ?? 0);
      return {
        items: tracks.slice(offset, offset + limit),
        total: tracks.length,
        limit,
        offset,
      };
    }
    const single = /^\/albums\/(.+)$/.exec(path);
    if (single) {
      const id = decodeURIComponent(single[1]);
      if (throttled.has(id)) {
        throw new SpotifyApiError(
          429,
          'Rate limited — Retry-After exceeded the in-queue wait cap; retry later.',
          opts.retryAfterSec ?? 9,
        );
      }
      if (!albums[id]) throw new SpotifyApiError(404, 'Not found');
      return albums[id];
    }
    return null;
  };
}

/**
 * #1224: the per-id album reads, in call order. `batchAlbumCalls` is the
 * assertion that matters most — the removed `?ids=` route must never be asked
 * for, and it is deliberately not served by `libraryResponder` so a
 * regression surfaces as a 404 rather than a passing test.
 */
const perIdAlbumCalls = (calls: Array<{ path: string }>) =>
  calls.filter((c) => /^\/albums\/[^/]+$/.test(c.path));

const albumIdsRequested = (calls: Array<{ path: string }>) =>
  perIdAlbumCalls(calls).map((c) => decodeURIComponent(c.path.replace('/albums/', '')));

/** Calls to the removed batch route — must always be empty after #1224. */
const batchAlbumCalls = (calls: Array<{ path: string }>) =>
  calls.filter((c) => c.path === '/albums');

// ---------------------------------------------------------------------------
// Grouping + lookup caching
// ---------------------------------------------------------------------------

describe('library_hygiene grouping and album lookups', () => {
  it('groups liked tracks by album id and requests each distinct album id once', async () => {
    const tracks = [
      likedTrack({ id: 't1', artistId: 'a1', albumId: 'alb1' }),
      likedTrack({ id: 't2', artistId: 'a1', albumId: 'alb1' }),
      likedTrack({ id: 't3', artistId: 'a1', albumId: 'alb1' }),
      likedTrack({ id: 't4', artistId: 'a2', albumId: 'alb2' }),
      likedTrack({ id: 't5', artistId: 'a2', albumId: 'alb2' }),
      likedTrack({ id: 't6', artistId: 'a3', albumId: 'alb3' }),
    ];
    const albums: Record<string, SpotifyAlbumFull> = {
      alb1: albumFull('alb1', { total_tracks: 10, trackIds: ['t1'] }),
      alb2: albumFull('alb2', { total_tracks: 12, trackIds: ['t4'] }),
      alb3: albumFull('alb3', { total_tracks: 8, trackIds: ['t6'] }),
    };
    const h = harness(libraryResponder(tracks, albums));
    const out = await h.invoke('library_hygiene', {});
    const payload = out.structuredContent!;

    // One per-id read for every DISTINCT album id, despite alb1 holding three
    // liked tracks. Busiest-first ordering puts alb1 first.
    assert.deepEqual(albumIdsRequested(h.client.calls), ['alb1', 'alb2', 'alb3']);
    // #1224: the removed batch route is never requested.
    assert.deepEqual(batchAlbumCalls(h.client.calls), []);

    const groups = payload.groups as Array<Record<string, unknown>>;
    assert.equal(groups.length, 3);
    const byAlbum = new Map(groups.map((g) => [g.album_id, g]));
    assert.equal(byAlbum.get('alb1')!.liked_count, 3);
    assert.equal(byAlbum.get('alb2')!.liked_count, 2);
    assert.equal(byAlbum.get('alb3')!.liked_count, 1);
    // Total_tracks filled from the lookups; coverage computed.
    assert.equal(byAlbum.get('alb1')!.total_tracks, 10);
    assert.ok(Math.abs((byAlbum.get('alb1')!.coverage as number) - 0.3) < 1e-9);
    assert.deepEqual(payload.counts, { near_complete: 0, orphaned_singles: 0 });
  });

  it('reads an album id exactly once, so repeated ids cannot be double-looked-up', async () => {
    // Two liked entries with the same album id arrive via different tracks; the
    // group key collapses them, so the album id is read once even if a future
    // refactor iterates tracks directly.
    const tracks = [
      likedTrack({ id: 't1', artistId: 'a1', albumId: 'alb1' }),
      likedTrack({ id: 't2', artistId: 'a1', albumId: 'alb1' }),
    ];
    const albums = { alb1: albumFull('alb1', { total_tracks: 4, trackIds: ['t1', 't2'] }) };
    const h = harness(libraryResponder(tracks, albums));
    await h.invoke('library_hygiene', {});
    assert.deepEqual(albumIdsRequested(h.client.calls), ['alb1']);
  });
});

// ---------------------------------------------------------------------------
// Coverage ratio boundaries
// ---------------------------------------------------------------------------

describe('library_hygiene coverage boundaries', () => {
  const buildCase = async (liked: number, total: number) => {
    const tracks = Array.from({ length: liked }, (_, i) =>
      likedTrack({ id: `t${i}`, artistId: 'a1', albumId: 'albX' }),
    );
    const albums = {
      albX: albumFull('albX', { total_tracks: total, trackIds: tracks.map((t) => t.track.id) }),
    };
    const h = harness(libraryResponder(tracks, albums));
    return h.invoke('library_hygiene', {});
  };

  it('includes albums at exactly 0.7 coverage (inclusive lower bound)', async () => {
    const out = await buildCase(7, 10);
    const payload = out.structuredContent!;
    assert.equal(payload.counts.near_complete, 1);
    const finding = (payload.near_complete as Array<Record<string, unknown>>)[0];
    assert.equal(finding.coverage, 0.7);
    assert.match(String(finding.suggestion), /prune the 7 singles/);
  });

  it('excludes albums below 0.7 coverage', async () => {
    const out = await buildCase(6, 10);
    assert.equal(out.structuredContent!.counts.near_complete, 0);
  });

  it('excludes fully-liked albums (coverage 1.0)', async () => {
    const out = await buildCase(10, 10);
    assert.equal(out.structuredContent!.counts.near_complete, 0);
  });

  it('excludes albums just above completeness boundary only up to <1.0', async () => {
    const out = await buildCase(9, 10); // 0.9 → included
    assert.equal(out.structuredContent!.counts.near_complete, 1);
  });
});

// ---------------------------------------------------------------------------
// Caps + truncation notes
// ---------------------------------------------------------------------------

describe('library_hygiene caps and truncation notes', () => {
  it('fans a 210-album library as 200 per-id reads at a bounded width (#763, #1224)', async () => {
    // #763 collapsed 200 serial GET /albums/{id} round trips into 10 batch
    // calls. #1224 had to undo that — the `?ids=` route is removed — so the
    // request count is honestly back to one per album. What must NOT come back
    // with it is the serial loop: the fan-out is width-bounded, and the count
    // published in the payload is the real one.
    const tracks = Array.from({ length: 210 }, (_, i) =>
      likedTrack({ id: `t${i}`, artistId: 'a1', albumId: `alb${i}` }),
    );
    const albums: Record<string, SpotifyAlbumFull> = {};
    for (let i = 0; i < 210; i++) {
      albums[`alb${i}`] = albumFull(`alb${i}`, { total_tracks: 2, trackIds: [`t${i}`] });
    }
    let inFlight = 0;
    let peakInFlight = 0;
    const base = libraryResponder(tracks, albums);
    const h = harness(async (path: string, params?: Record<string, string>) => {
      inFlight++;
      peakInFlight = Math.max(peakInFlight, inFlight);
      // Yield so overlapping reads are observable rather than collapsed into a
      // synchronous responder that could never show a width above 1.
      await Promise.resolve();
      inFlight--;
      return base(path, params);
    });
    await h.invoke('library_hygiene', {});

    const ids = albumIdsRequested(h.client.calls);
    assert.equal(ids.length, 200);
    // 200 distinct album ids requested exactly once, in one budgeted sweep.
    assert.equal(new Set(ids).size, 200);
    assert.deepEqual(batchAlbumCalls(h.client.calls), []);

    const lookups = (await h.invoke('library_hygiene', {})).structuredContent!
      .album_lookups as Record<string, unknown>;
    assert.equal(lookups.made, 200);
    assert.equal(lookups.requests, 200);
    assert.equal(lookups.request_mode, 'per_id');
    assert.deepEqual(lookups.unresolved, []);
    // Bounded, not serial: the old pre-#763 loop was 200 round trips one at a
    // time, and this fix must not reinstate it under a new justification.
    assert.ok(
      peakInFlight > 1,
      `the per-id reads ran one at a time (peak ${peakInFlight}) — that is the pre-#763 serial loop`,
    );
  });

  it('stops album lookups at the 200 cap and notes the truncation', async () => {
    const tracks = Array.from({ length: 210 }, (_, i) =>
      likedTrack({ id: `t${i}`, artistId: 'a1', albumId: `alb${i}` }),
    );
    const albums: Record<string, SpotifyAlbumFull> = {};
    for (let i = 0; i < 210; i++) {
      albums[`alb${i}`] = albumFull(`alb${i}`, { total_tracks: 2, trackIds: [`t${i}`] });
    }
    const h = harness(libraryResponder(tracks, albums));
    const out = await h.invoke('library_hygiene', {});
    const payload = out.structuredContent!;

    assert.equal(perIdAlbumCalls(h.client.calls).length, 200);
    assert.equal(albumIdsRequested(h.client.calls).length, 200);
    const lookups = payload.album_lookups as Record<string, unknown>;
    assert.equal(lookups.made, 200);
    assert.equal(lookups.cap, 200);
    assert.equal(lookups.truncated_by_cap, true);
    assert.match(textOf(out), /cap 200 REACHED/);
  });

  it('reports exact-cap libraries as complete, not truncated', async () => {
    const tracks = Array.from({ length: 500 }, (_, i) =>
      likedTrack({ id: `t${i}`, artistId: 'a1', albumId: `alb${i}` }),
    );
    const albums: Record<string, SpotifyAlbumFull> = {};
    for (let i = 0; i < 500; i++) {
      albums[`alb${i}`] = albumFull(`alb${i}`, { total_tracks: 1, trackIds: [`t${i}`] });
    }
    const h = harness(libraryResponder(tracks, albums));
    const out = await h.invoke('library_hygiene', {});
    const scanned = out.structuredContent!.scanned as Record<string, unknown>;
    assert.equal(scanned.liked_tracks, 500);
    assert.equal(scanned.fetched, 500);
    assert.equal(scanned.cap, 500);
    assert.equal(scanned.fetch_all_cap, 500);
    assert.equal(scanned.snapshot_state, 'complete');
    assert.equal(scanned.complete, true);
    assert.equal(scanned.tracks_truncated_by_cap, false);
    assert.match(textOf(out), /fetched 500 liked tracks, cap 500 — complete; cap not reached/);
  });

  it('reports cap-plus-one libraries as partial and truncated', async () => {
    const tracks = Array.from({ length: 501 }, (_, i) =>
      likedTrack({ id: `t${i}`, artistId: 'a1', albumId: `alb${i}` }),
    );
    const albums: Record<string, SpotifyAlbumFull> = {};
    for (let i = 0; i < 501; i++) {
      albums[`alb${i}`] = albumFull(`alb${i}`, { total_tracks: 1, trackIds: [`t${i}`] });
    }
    const h = harness(libraryResponder(tracks, albums));
    const out = await h.invoke('library_hygiene', {});
    const scanned = out.structuredContent!.scanned as Record<string, unknown>;
    assert.equal(scanned.fetched, 500);
    assert.equal(scanned.cap, 500);
    assert.equal(scanned.snapshot_state, 'partial');
    assert.equal(scanned.complete, false);
    assert.equal(scanned.tracks_truncated_by_cap, true);
    assert.match(textOf(out), /fetched 500 liked tracks, cap 500 — TRUNCATED/);
  });

  it('reports cap not reached for small libraries', async () => {
    const tracks = [likedTrack({ id: 't1', artistId: 'a1', albumId: 'alb1' })];
    const albums = { alb1: albumFull('alb1', { total_tracks: 1, trackIds: ['t1'] }) };
    const h = harness(libraryResponder(tracks, albums));
    const out = await h.invoke('library_hygiene', {});
    const scanned = out.structuredContent!.scanned as Record<string, unknown>;
    assert.equal(scanned.tracks_truncated_by_cap, false);
    assert.doesNotMatch(textOf(out), /REACHED/);
  });
});

// ---------------------------------------------------------------------------
// Orphaned singles
// ---------------------------------------------------------------------------

describe('library_hygiene orphaned singles', () => {
  it('flags a lone single whose release and artist have nothing else liked (low confidence)', async () => {
    const tracks = [likedTrack({ id: 's1', artistId: 'lonely', albumId: 'sing1' })];
    const albums = {
      sing1: albumFull('sing1', { album_type: 'single', total_tracks: 1, trackIds: ['s1'] }),
    };
    const h = harness(libraryResponder(tracks, albums));
    const out = await h.invoke('library_hygiene', {});
    const payload = out.structuredContent!;
    assert.equal(payload.counts.orphaned_singles, 1);
    const finding = (payload.orphaned_singles as Array<Record<string, unknown>>)[0];
    assert.equal(finding.confidence, 'low');
    assert.equal(finding.track_id, 's1');
    assert.match(textOf(out), /LOW CONFIDENCE/);
  });

  it('does NOT flag when another liked track shares the single\u2019s artist', async () => {
    const tracks = [
      likedTrack({ id: 's1', artistId: 'busy', albumId: 'sing1' }),
      likedTrack({ id: 'x1', artistId: 'busy', albumId: 'albFull' }),
    ];
    const albums = {
      sing1: albumFull('sing1', { album_type: 'single', total_tracks: 1, trackIds: ['s1'] }),
      albFull: albumFull('albFull', { total_tracks: 10, trackIds: ['x1'] }),
    };
    const h = harness(libraryResponder(tracks, albums));
    const out = await h.invoke('library_hygiene', {});
    assert.equal(out.structuredContent!.counts.orphaned_singles, 0);
  });

  it('does NOT flag when another track of the SAME release is liked under a different album id', async () => {
    // t_b lives on the deluxe edition (different album id) but appears on the
    // single's own track listing — the release is not "orphaned".
    const tracks = [
      likedTrack({ id: 't_a', artistId: 'duo', albumId: 'sing2' }),
      likedTrack({ id: 't_b', artistId: 'duo', albumId: 'sing2-deluxe' }),
    ];
    const albums = {
      sing2: albumFull('sing2', { album_type: 'single', total_tracks: 2, trackIds: ['t_a', 't_b'] }),
    };
    const h = harness(libraryResponder(tracks, albums));
    const out = await h.invoke('library_hygiene', {});
    assert.equal(out.structuredContent!.counts.orphaned_singles, 0);
  });

  it('treats short releases (total_tracks <= 3) as singles regardless of album_type', async () => {
    const tracks = [likedTrack({ id: 'w1', artistId: 'hermit', albumId: 'short1' })];
    const albums = {
      short1: albumFull('short1', { album_type: 'compilation', total_tracks: 3, trackIds: ['w1'] }),
    };
    const h = harness(libraryResponder(tracks, albums));
    const out = await h.invoke('library_hygiene', {});
    assert.equal(out.structuredContent!.counts.orphaned_singles, 1);
  });
});

// ---------------------------------------------------------------------------
// Empty library + json shape
// ---------------------------------------------------------------------------

describe('library_hygiene edges and shapes', () => {
  it('handles an empty library gracefully with zero album lookups', async () => {
    const h = harness(libraryResponder([], {}));
    const out = await h.invoke('library_hygiene', {});
    const payload = out.structuredContent!;
    assert.deepEqual(payload.counts, { near_complete: 0, orphaned_singles: 0 });
    assert.equal(perIdAlbumCalls(h.client.calls).length, 0);
    assert.equal(batchAlbumCalls(h.client.calls).length, 0);
    assert.match(textOf(out), /No liked tracks found/);
  });

  it('json mode returns raw groups + findings arrays with the documented shape', async () => {
    const tracks = [
      likedTrack({ id: 't1', artistId: 'a1', albumId: 'alb1' }),
      likedTrack({ id: 't2', artistId: 'a1', albumId: 'alb1' }),
      likedTrack({ id: 't3', artistId: 'a1', albumId: 'alb1' }),
    ];
    const albums = {
      alb1: albumFull('alb1', { total_tracks: 4, trackIds: ['t1', 't2', 't3'] }),
    };
    const h = harness(libraryResponder(tracks, albums));
    const out = await h.invoke('library_hygiene', { response_format: 'json' });

    // json mode: content text IS the serialized payload.
    const parsed = JSON.parse(textOf(out));
    assert.deepEqual(Object.keys(parsed).sort(), [
      'album_lookups',
      'counts',
      'groups',
      'near_complete',
      'ok',
      'orphaned_singles',
      'scanned',
    ]);
    assert.equal(parsed.ok, true);
    assert.equal(parsed.groups.length, 1);
    const group = parsed.groups[0];
    for (const key of [
      'album_id',
      'album_name',
      'album_uri',
      'album_type',
      'artist_ids',
      'artist_names',
      'liked_count',
      'liked_tracks',
      'total_tracks',
      'coverage',
    ]) {
      assert.ok(key in group, `group missing ${key}`);
    }
    assert.equal(parsed.groups[0].liked_tracks[0].id, 't1');
    assert.equal(parsed.near_complete.length, 1);
    assert.deepEqual(
      Object.keys(parsed.near_complete[0]).sort(),
      [
        'album_id',
        'album_name',
        'album_uri',
        'artist_names',
        'confidence',
        'coverage',
        'kind',
        'liked_count',
        'suggestion',
        'total_tracks',
      ],
    );
    assert.equal(parsed.orphaned_singles.length, 0);
  });

  it('prose totals stay accurate under max_results truncation', async () => {
    // Three near-complete albums (coverages 0.9, 0.8, 0.75) → sorted desc.
    const mk = (i: number, liked: number, total: number) => ({
      tracks: Array.from({ length: liked }, (_, k) =>
        likedTrack({ id: `t${i}_${k}`, artistId: `a${i}`, albumId: `alb${i}` }),
      ),
      album: albumFull(`alb${i}`, {
        total_tracks: total,
        trackIds: Array.from({ length: total }, (_, k) => `filler_${k}`),
      }),
    });
    const parts = [mk(1, 9, 10), mk(2, 8, 10), mk(3, 6, 8)]; // 0.9, 0.8, 0.75
    const tracks = parts.flatMap((p) => p.tracks);
    const albums = Object.fromEntries(parts.map((p) => [p.album.id, p.album]));

    const h = harness(libraryResponder(tracks, albums));
    const out = await h.invoke('library_hygiene', { max_results: 2 });
    const prose = textOf(out);

    assert.match(prose, /NEAR-COMPLETE ALBUMS \(3\)/); // accurate total
    assert.match(prose, /0\/10|9\/10/); // top finding rendered
    const renderedBullets = prose.split('\n').filter((l) => l.trim().startsWith('•'));
    assert.equal(renderedBullets.length, 2); // truncated to max_results=2
    assert.match(prose, /1 more/); // continuation footer present

    // Structured payload keeps ALL findings regardless of prose truncation.
    const payload = out.structuredContent!;
    assert.equal((payload.near_complete as unknown[]).length, 3);

    // Sorted by coverage ratio descending: 0.9 first.
    assert.match(renderedBullets[0], /9\/10/);
  });
});

// ---------------------------------------------------------------------------
// #763 — batched fan-in cost preview + rate-limit partials
// ---------------------------------------------------------------------------

describe('library_hygiene dry_run cost preview (#763)', () => {
  it('issues zero API calls and reports the estimated request count', async () => {
    const h = harness(libraryResponder([], {}));
    const out = await h.invoke('library_hygiene', { dry_run: true });
    const payload = out.structuredContent!;

    assert.deepEqual(h.client.calls, []);
    assert.equal(payload.dry_run, true);
    assert.equal(payload.requests_made, 0);
    assert.equal(payload.album_lookup_cap, 200);
    assert.equal(payload.request_mode, 'per_id');
    // #1224: one request per album, so the budgeted upper bound is the cap
    // itself, plus the /me/tracks walk (500 / 50).
    assert.equal(payload.estimated_album_requests, 200);
    assert.equal(payload.track_walk_requests, 10);
    assert.equal(payload.estimated_requests, 210);
    assert.match(textOf(out), /\[dry run\] library_hygiene would walk \/me\/tracks/);
    assert.match(textOf(out), /per-id GET \/albums\/\{id\} requests/);
  });

  it('previews without walking even when a full library is served', async () => {
    const tracks = Array.from({ length: 210 }, (_, i) =>
      likedTrack({ id: `t${i}`, artistId: 'a1', albumId: `alb${i}` }),
    );
    const albums = Object.fromEntries(
      Array.from({ length: 210 }, (_, i) => [
        `alb${i}`,
        albumFull(`alb${i}`, { total_tracks: 2, trackIds: [`t${i}`] }),
      ]),
    );
    const h = harness(libraryResponder(tracks, albums));
    const out = await h.invoke('library_hygiene', { dry_run: true });

    // The whole point of the preview: a 210-album library costs 0 calls, not 21.
    assert.deepEqual(h.client.calls, []);
    assert.equal(out.structuredContent!.estimated_requests, 210);
    assert.match(textOf(out), /0 made/);
  });
});

describe('library_hygiene rate-limited partials (#763)', () => {
  // #1224 moved the album read from `GET /albums?ids=` to per-id GETs, and the
  // #763 point-4 degradation is the one behaviour that must survive the move:
  // a 429 has to become a partial with Retry-After messaging, not a throw.
  it('keeps the reads that resolved and reports the 429 Retry-After instead of aborting', async () => {
    const tracks = Array.from({ length: 60 }, (_, i) =>
      likedTrack({ id: `t${i}`, artistId: 'a1', albumId: `alb${i}` }),
    );
    const albums = Object.fromEntries(
      tracks.map((t) => {
        const id = t.track.album.id;
        return [id, albumFull(id, { total_tracks: 2, trackIds: [t.track.id] })];
      }),
    );
    // A middle slice of the ids throttles; the reads on either side still land.
    const throttled = tracks.slice(20, 40).map((t) => t.track.album.id);
    const h = harness(libraryResponder(tracks, albums, { throttleIds: throttled, retryAfterSec: 11 }));
    const out = await h.invoke('library_hygiene', {});
    const payload = out.structuredContent!;

    assert.equal(payload.album_lookups.rate_limited, true);
    assert.equal(payload.album_lookups.retry_after_sec, 11);
    assert.match(payload.album_lookups.rate_limit_message, /Rate limited/);
    assert.match(textOf(out), /PARTIAL: album lookups were rate limited/);
    assert.match(textOf(out), /wait ~11s/);

    // 40 of 60 albums resolved; the 20 throttled reads stay unresolved rather
    // than the whole run being lost.
    const resolved = (payload.groups as Array<{ total_tracks: number | null }>)
      .filter((g) => g.total_tracks !== null);
    assert.equal(resolved.length, 40);
    assert.equal((payload.groups as Array<{ total_tracks: number | null }>)
      .filter((g) => g.total_tracks === null).length, 20);
    // #1224: the throttled ids are named with their reason, so a caller can
    // tell a rate-limited read from an album with no track total.
    const unresolved = payload.album_lookups.unresolved as Array<{ id: string; status: number | null }>;
    assert.deepEqual(unresolved.map((u) => u.id).sort(), [...throttled].sort());
    assert.ok(unresolved.every((u) => u.status === 429));
    assert.match(textOf(out), /20 album reads failed/);
  });
});

describe('library_hygiene source guards (#763, #1224)', () => {
  it('never calls the removed GET /albums?ids= route', () => {
    const src = readFileSync(
      new URL('../src/tools/libraryhygiene.ts', import.meta.url),
      'utf8',
    );
    // #1224 inverts #763's original source guard on purpose. The batch route
    // is removed by Spotify's Feb 2026 changelog, so the per-album read is now
    // the supported one and the batch call is the regression to guard against.
    // The `fetchAlbumsPerId` fan-out it replaced is width-bounded, which is
    // what keeps this from being the pre-#763 serial loop.
    assert.doesNotMatch(src, /get<[^>]*>\(\s*'\/albums'/);
    assert.match(src, /fetchAlbumsPerId/);
  });
});
