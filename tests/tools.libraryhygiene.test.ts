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
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { SpotifyClient } from '../src/client.js';
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

/** Responder serving a /me/tracks library of exactly `tracks` in pages of 50. */
function libraryResponder(tracks: SavedTrackItem[], albums: Record<string, SpotifyAlbumFull>) {
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
    if (path.startsWith('/albums/')) {
      const id = decodeURIComponent(path.slice('/albums/'.length));
      return albums[id] ?? null;
    }
    return null;
  };
}

const albumCalls = (calls: Array<{ path: string }>) =>
  calls.filter((c) => c.path.startsWith('/albums/'));

// ---------------------------------------------------------------------------
// Grouping + lookup caching
// ---------------------------------------------------------------------------

describe('library_hygiene grouping and album lookups', () => {
  it('groups liked tracks by album id and issues exactly one GET per album id', async () => {
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

    // One GET per DISTINCT album id despite alb1 holding three liked tracks.
    const paths = albumCalls(h.client.calls).map((c) => c.path);
    assert.deepEqual(paths.sort(), ['/albums/alb1', '/albums/alb2', '/albums/alb3']);

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

  it('caches album lookups across groups sharing an album id is impossible by construction — cache map still dedupes repeated ids defensively', async () => {
    // Two liked entries with the same album id arrive via different tracks; the
    // group key collapses them, but the cache guarantees at most one GET even
    // if a future refactor iterates tracks directly.
    const tracks = [
      likedTrack({ id: 't1', artistId: 'a1', albumId: 'alb1' }),
      likedTrack({ id: 't2', artistId: 'a1', albumId: 'alb1' }),
    ];
    const albums = { alb1: albumFull('alb1', { total_tracks: 4, trackIds: ['t1', 't2'] }) };
    const h = harness(libraryResponder(tracks, albums));
    await h.invoke('library_hygiene', {});
    assert.equal(albumCalls(h.client.calls).length, 1);
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

    assert.equal(albumCalls(h.client.calls).length, 200);
    const lookups = payload.album_lookups as Record<string, unknown>;
    assert.equal(lookups.made, 200);
    assert.equal(lookups.cap, 200);
    assert.equal(lookups.truncated_by_cap, true);
    assert.match(textOf(out), /cap 200 REACHED/);
  });

  it('notes when the /me/tracks walk reaches the fetch-all cap (500 default)', async () => {
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
    assert.equal(scanned.fetch_all_cap, 500);
    assert.equal(scanned.tracks_truncated_by_cap, true);
    assert.match(textOf(out), /Fetch-all cap 500 REACHED/);
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
    assert.equal(albumCalls(h.client.calls).length, 0);
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
