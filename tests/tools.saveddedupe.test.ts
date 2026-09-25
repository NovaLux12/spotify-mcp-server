/**
 * Tests for src/tools/saveddedupe.ts (#156 — find_duplicate_saved_tracks).
 *
 * Covers: exact duplicate groups, remaster near-duplicates (flag-gated),
 * distinct songs never grouped, oldest→newest save ordering, empty library,
 * json payload shape, and fetch-all cap enforcement.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerSavedDedupeTools } from '../src/tools/saveddedupe.js';
import type { SavedTrackItem, SpotifyTrack } from '../src/types/spotify.js';

// ---------------------------------------------------------------------------
// Stub plumbing (mirrors tests/tools.libraryhygiene.test.ts)
// ---------------------------------------------------------------------------

type Responder = (path: string, params?: Record<string, string>) => unknown;

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
  const client = {
    calls,
    async get<T>(path: string, params?: Record<string, string>): Promise<T | null> {
      calls.push({ method: 'GET', path, arg: params });
      return responder(path, params) as T | null;
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
  registerSavedDedupeTools(fakeServer, client as unknown as SpotifyClient);
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
  artistNames?: string[];
  durationMs: number;
  addedAt: string;
  albumName?: string;
  albumId?: string;
  isrc?: string | null;
}

const savedTrack = (spec: TrackSpec): SavedTrackItem => {
  const isrc = spec.isrc === undefined ? 'USRC17607839' : spec.isrc;
  const albumId = spec.albumId ?? 'al-shared';
  const track = {
    id: spec.id,
    name: spec.name ?? spec.id,
    uri: `spotify:track:${spec.id}`,
    type: 'track',
    duration_ms: spec.durationMs,
    explicit: false,
    artists: (spec.artistNames ?? ['Artist A']).map((name, i) => ({
      id: `ar${i}`,
      name,
    })),
    album: {
      id: albumId,
      name: spec.albumName ?? `Album ${albumId}`,
      uri: `spotify:album:${albumId}`,
    },
    ...(isrc ? { external_ids: { isrc } } : {}),
  } as SpotifyTrack & { external_ids?: { isrc: string } };
  return { added_at: spec.addedAt, track };
};

/** Responder serving a /me/tracks library of exactly `tracks` in pages of 50. */
function libraryResponder(tracks: SavedTrackItem[]) {
  return (path: string, params?: Record<string, string>) => {
    if (path === '/me/tracks') {
      const limit = Number(params?.limit ?? 50);
      const offset = Number(params?.offset ?? 0);
      return {
        items: tracks.slice(offset, offset + limit),
        total: tracks.length,
        limit,
        offset,
      };
    }
    return null;
  };
}

type InvokeOut = Awaited<ReturnType<ReturnType<typeof harness>['invoke']>>;
interface Payload {
  ok: boolean;
  scanned: {
    saved_tracks: number;
    skipped_unplayable: number;
    fetched: number;
    cap: number;
    fetch_all_cap: number;
    snapshot_state: 'complete' | 'partial';
    complete: boolean;
    truncated_by_cap: boolean;
    playlist_id?: string;
    playlist_name?: string | null;
    playlist_tracks?: number;
  };
  counts: {
    exact_groups: number;
    near_duplicate_groups: number;
    removable_tracks: number;
    groups_with_playlist_overlap: number;
  };
  groups: Array<{
    kind: 'exact' | 'near_duplicate';
    match_basis:
      | 'same_isrc_album_duration_within_2000ms'
      | 'same_title_artist_different_recording_or_version';
    normalized_name: string;
    artist_names: string[];
    members: Array<{
      uri: string;
      added_at: string;
      duration_ms: number;
      album_id: string | null;
      isrc: string | null;
    }>;
    kept_uri: string | null;
    removable_uris: string[];
    playlist_overlap_uris: string[];
    suggestion: string;
  }>;
}
const payloadOf = (out: InvokeOut): Payload =>
  out.structuredContent as unknown as Payload;

// ---------------------------------------------------------------------------
// Registration + defaults
// ---------------------------------------------------------------------------

describe('find_duplicate_saved_tracks registration', () => {
  it('registers a read-only tool with include_near_duplicates defaulting false', async () => {
    const h = harness(libraryResponder([]));
    const tool = h.registered.find((t) => t.name === 'find_duplicate_saved_tracks');
    assert.ok(tool, 'tool registered');
    const validated = tool.validate({});
    assert.equal(validated.include_near_duplicates, false);
    assert.equal(validated.response_format, 'concise');
    // Read-only: only GET /me/tracks is reachable.
    await h.invoke('find_duplicate_saved_tracks');
    for (const call of h.client.calls) {
      assert.equal(call.method, 'GET');
      assert.equal(call.path, '/me/tracks');
    }
  });
});

// ---------------------------------------------------------------------------
// Exact duplicates
// ---------------------------------------------------------------------------

describe('find_duplicate_saved_tracks exact duplicates', () => {
  it('groups same-ISRC, same-album saves within the duration tolerance', async () => {
    const tracks = [
      savedTrack({ id: 'dupe1', name: 'Same Song', artistNames: ['Duo'], durationMs: 200_000, addedAt: '2026-01-01T00:00:00Z', albumId: 'album-dupe', isrc: 'USRC17607839' }),
      savedTrack({ id: 'other', name: 'Unrelated', artistNames: ['Trio'], durationMs: 180_000, addedAt: '2026-01-02T00:00:00Z', albumId: 'album-other', isrc: 'USRC99999999' }),
      savedTrack({ id: 'dupe2', name: 'same SONG!', artistNames: ['duo'], durationMs: 201_500, addedAt: '2026-02-01T00:00:00Z', albumId: 'album-dupe', isrc: 'usrc17607839' }),
    ];
    const out = await harness(libraryResponder(tracks)).invoke('find_duplicate_saved_tracks');
    const p = payloadOf(out);
    assert.equal(p.counts.exact_groups, 1);
    const group = p.groups[0];
    assert.equal(group.kind, 'exact');
    assert.equal(group.match_basis, 'same_isrc_album_duration_within_2000ms');
    assert.equal(group.normalized_name, 'same song');
    assert.deepEqual(group.artist_names, ['duo']);
    assert.deepEqual(group.members.map((m) => m.uri), [
      'spotify:track:dupe1',
      'spotify:track:dupe2',
    ]);
    assert.deepEqual(group.members.map((m) => m.album_id), ['album-dupe', 'album-dupe']);
    assert.deepEqual(group.members.map((m) => m.isrc), ['USRC17607839', 'USRC17607839']);
    assert.equal(group.kept_uri, 'spotify:track:dupe1');
    assert.deepEqual(group.removable_uris, ['spotify:track:dupe2']);
    assert.match(group.suggestion, /keep oldest, remove the rest/);
    assert.match(textOf(out), /same non-null ISRC, same album id/);
    assert.match(textOf(out), /spotify:track:dupe2/);
  });

  it('does not group distinct songs even when names are close', async () => {
    const tracks = [
      savedTrack({ id: 'a', name: 'Ocean Breeze', artistNames: ['Duo'], durationMs: 200_000, addedAt: '2026-01-01T00:00:00Z' }),
      savedTrack({ id: 'b', name: 'Mountain High', artistNames: ['Duo'], durationMs: 200_000, addedAt: '2026-01-02T00:00:00Z' }),
      savedTrack({ id: 'c', name: 'Ocean Breeze', artistNames: ['Someone Else'], durationMs: 200_000, addedAt: '2026-01-03T00:00:00Z' }),
    ];
    const out = await harness(libraryResponder(tracks)).invoke('find_duplicate_saved_tracks');
    const p = payloadOf(out);
    assert.equal(p.counts.exact_groups, 0);
    assert.deepEqual(p.groups, []);
    assert.match(textOf(out), /No duplicates found/);
  });
});

// ---------------------------------------------------------------------------
// Near duplicates (remasters) — flag-gated
// ---------------------------------------------------------------------------

describe('find_duplicate_saved_tracks near duplicates', () => {
  const remasteredLibrary = () => [
    savedTrack({ id: 'orig', name: 'Classic', artistNames: ['Legend'], durationMs: 210_000, addedAt: '2025-06-01T00:00:00Z', albumName: 'Original Album', albumId: 'album-original', isrc: 'USRC11111111' }),
    savedTrack({ id: 'remaster', name: 'Classic', artistNames: ['Legend'], durationMs: 224_000, addedAt: '2026-03-01T00:00:00Z', albumName: 'Remaster', albumId: 'album-remaster', isrc: 'USRC22222222' }),
  ];

  it('is not reported by default (include_near_duplicates=false)', async () => {
    const out = await harness(libraryResponder(remasteredLibrary())).invoke('find_duplicate_saved_tracks');
    const p = payloadOf(out);
    assert.equal(p.counts.exact_groups, 0);
    assert.equal(p.counts.near_duplicate_groups, 0);
    assert.deepEqual(p.groups, []);
  });

  it('is reported as near_duplicate when include_near_duplicates=true', async () => {
    const out = await harness(libraryResponder(remasteredLibrary())).invoke(
      'find_duplicate_saved_tracks',
      { include_near_duplicates: true },
    );
    const p = payloadOf(out);
    assert.equal(p.counts.exact_groups, 0);
    assert.equal(p.counts.near_duplicate_groups, 1);
    const group = p.groups[0];
    assert.equal(group.kind, 'near_duplicate');
    assert.equal(group.match_basis, 'same_title_artist_different_recording_or_version');
    assert.equal(group.normalized_name, 'classic');
    assert.deepEqual(group.artist_names, ['legend']);
    assert.deepEqual(group.members.map((m) => m.added_at), [
      '2025-06-01T00:00:00Z',
      '2026-03-01T00:00:00Z',
    ]);
    assert.equal(group.kept_uri, null);
    assert.deepEqual(group.removable_uris, []);
    assert.match(group.suggestion, /review - different ISRC, release, or duration/);
    assert.match(textOf(out), /NEAR-DUPLICATE/);
    assert.match(textOf(out), /review-only/);
    assert.doesNotMatch(textOf(out), /remove:/);
  });

  it('reports an exact cluster alongside the near group without double-counting members', async () => {
    const tracks = [
      ...remasteredLibrary(),
      savedTrack({ id: 'twice1', name: 'Twice Saved', artistNames: ['Band'], durationMs: 190_000, addedAt: '2026-01-05T00:00:00Z' }),
      savedTrack({ id: 'twice2', name: 'Twice Saved', artistNames: ['Band'], durationMs: 191_000, addedAt: '2026-04-05T00:00:00Z' }),
    ];
    const out = await harness(libraryResponder(tracks)).invoke(
      'find_duplicate_saved_tracks',
      { include_near_duplicates: true },
    );
    const p = payloadOf(out);
    assert.equal(p.counts.exact_groups, 1);
    assert.equal(p.counts.near_duplicate_groups, 1);
    assert.equal(p.counts.removable_tracks, 1);
    assert.equal(new Set(p.groups.flatMap((group) => group.removable_uris)).size, 1);
  });

  it('treats same-title tracks with different ISRCs as distinct saved recordings', async () => {
    const tracks = [
      savedTrack({ id: 'single', name: 'Versioned Song', artistNames: ['Artist'], durationMs: 200_000, addedAt: '2026-01-01T00:00:00Z', albumId: 'single-release', isrc: 'USRC11111111' }),
      savedTrack({ id: 'album', name: 'Versioned Song', artistNames: ['Artist'], durationMs: 201_500, addedAt: '2026-02-01T00:00:00Z', albumId: 'album-release', isrc: 'USRC22222222' }),
    ];
    const out = await harness(libraryResponder(tracks)).invoke(
      'find_duplicate_saved_tracks',
      { include_near_duplicates: true },
    );
    const p = payloadOf(out);
    assert.equal(p.counts.exact_groups, 0);
    assert.equal(p.counts.near_duplicate_groups, 1);
    assert.equal(p.counts.removable_tracks, 0);
    assert.equal(p.groups[0].kind, 'near_duplicate');
    assert.equal(p.groups[0].kept_uri, null);
    assert.deepEqual(p.groups[0].removable_uris, []);
    assert.deepEqual(p.groups[0].members.map((member) => member.album_id), [
      'single-release',
      'album-release',
    ]);
    assert.deepEqual(p.groups[0].members.map((member) => member.isrc), [
      'USRC11111111',
      'USRC22222222',
    ]);
    assert.match(textOf(out), /different recording or release\. These are distinct saved tracks; review only/);
    assert.doesNotMatch(textOf(out), /remove:/);
  });

  it('does not claim an exact match when Spotify omits the ISRC', async () => {
    const tracks = [
      savedTrack({ id: 'unknown-a', name: 'Unknown Recording', artistNames: ['Artist'], durationMs: 200_000, addedAt: '2026-01-01T00:00:00Z', albumId: 'shared-release', isrc: null }),
      savedTrack({ id: 'unknown-b', name: 'Unknown Recording', artistNames: ['Artist'], durationMs: 200_000, addedAt: '2026-02-01T00:00:00Z', albumId: 'shared-release', isrc: null }),
    ];
    const out = await harness(libraryResponder(tracks)).invoke(
      'find_duplicate_saved_tracks',
      { include_near_duplicates: true },
    );
    const p = payloadOf(out);
    assert.equal(p.counts.exact_groups, 0);
    assert.equal(p.counts.near_duplicate_groups, 1);
    assert.equal(p.counts.removable_tracks, 0);
    assert.deepEqual(p.groups[0].removable_uris, []);
    assert.doesNotMatch(p.groups[0].suggestion, /remove the rest/);
    assert.match(textOf(out), /ISRC: unavailable/);
  });

  it('computes disjoint removals for separate recording buckets and counts their union', async () => {
    const tracks = [
      savedTrack({ id: 'version-a1', name: 'Shared Title', artistNames: ['Band'], durationMs: 200_000, addedAt: '2026-01-01T00:00:00Z', albumId: 'release-a', isrc: 'USRCAAAAAAAA' }),
      savedTrack({ id: 'version-a2', name: 'Shared Title', artistNames: ['Band'], durationMs: 200_000, addedAt: '2026-02-01T00:00:00Z', albumId: 'release-a', isrc: 'USRCAAAAAAAA' }),
      savedTrack({ id: 'version-b1', name: 'Shared Title', artistNames: ['Band'], durationMs: 200_500, addedAt: '2026-03-01T00:00:00Z', albumId: 'release-b', isrc: 'USRCBBBBBBBB' }),
      savedTrack({ id: 'version-b2', name: 'Shared Title', artistNames: ['Band'], durationMs: 200_500, addedAt: '2026-04-01T00:00:00Z', albumId: 'release-b', isrc: 'USRCBBBBBBBB' }),
    ];
    const out = await harness(libraryResponder(tracks)).invoke(
      'find_duplicate_saved_tracks',
      { include_near_duplicates: true },
    );
    const p = payloadOf(out);
    const exactGroups = p.groups.filter((group) => group.kind === 'exact');
    const removableUris = exactGroups.flatMap((group) => group.removable_uris);
    assert.equal(exactGroups.length, 2);
    assert.deepEqual(removableUris, [
      'spotify:track:version-a2',
      'spotify:track:version-b2',
    ]);
    assert.equal(new Set(removableUris).size, removableUris.length);
    assert.equal(p.counts.removable_tracks, new Set(removableUris).size);
    assert.deepEqual(
      p.groups.filter((group) => group.kind === 'near_duplicate').flatMap((group) => group.removable_uris),
      [],
    );
  });
});

// ---------------------------------------------------------------------------
// Save-date ordering
// ---------------------------------------------------------------------------

describe('find_duplicate_saved_tracks save-date ordering', () => {
  it('lists group members oldest save first regardless of scan order', async () => {
    const tracks = [
      savedTrack({ id: 'newest', name: 'Echo', artistNames: ['Loop'], durationMs: 200_000, addedAt: '2026-05-10T00:00:00Z' }),
      savedTrack({ id: 'middle', name: 'Echo', artistNames: ['Loop'], durationMs: 200_500, addedAt: '2026-02-10T00:00:00Z' }),
      savedTrack({ id: 'oldest', name: 'echo!!', artistNames: ['loop'], durationMs: 199_800, addedAt: '2024-12-31T00:00:00Z' }),
    ];
    const out = await harness(libraryResponder(tracks)).invoke('find_duplicate_saved_tracks');
    const p = payloadOf(out);
    const group = p.groups[0];
    assert.deepEqual(group.members.map((m) => m.uri), [
      'spotify:track:oldest',
      'spotify:track:middle',
      'spotify:track:newest',
    ]);
    // Keep the oldest, remove the other two.
    assert.deepEqual(group.removable_uris, [
      'spotify:track:middle',
      'spotify:track:newest',
    ]);
  });

  it('orders an undated save after a dated save and never keeps it by default', async () => {
    const tracks = [
      savedTrack({ id: 'undated', name: 'Dated Echo', artistNames: ['Loop'], durationMs: 180_000, addedAt: '' }),
      savedTrack({ id: 'dated', name: 'Dated Echo', artistNames: ['Loop'], durationMs: 180_000, addedAt: '2026-01-01T00:00:00Z' }),
    ];
    const out = await harness(libraryResponder(tracks)).invoke('find_duplicate_saved_tracks');
    const group = payloadOf(out).groups[0];
    assert.deepEqual(group.members.map((member) => member.uri), [
      'spotify:track:dated',
      'spotify:track:undated',
    ]);
    assert.equal(group.kept_uri, 'spotify:track:dated');
    assert.deepEqual(group.removable_uris, ['spotify:track:undated']);
    assert.match(group.suggestion, /keep oldest, remove the rest/);
    assert.match(textOf(out), /remove: saved unknown date/);
  });

  it('uses URI ordering when every duplicate save is undated', async () => {
    const tracks = ['z-save', 'a-save', 'm-save'].map((id) =>
      savedTrack({ id, name: 'Undated Trio', artistNames: ['Loop'], durationMs: 180_000, addedAt: '' }),
    );
    const out = await harness(libraryResponder(tracks)).invoke('find_duplicate_saved_tracks');
    const group = payloadOf(out).groups[0];
    assert.deepEqual(group.members.map((member) => member.uri), [
      'spotify:track:a-save',
      'spotify:track:m-save',
      'spotify:track:z-save',
    ]);
    assert.equal(group.kept_uri, 'spotify:track:a-save');
    assert.deepEqual(group.removable_uris, [
      'spotify:track:m-save',
      'spotify:track:z-save',
    ]);
    assert.match(group.suggestion, /save dates unavailable, keep lowest URI/);
  });
});

// ---------------------------------------------------------------------------
// Empty library
// ---------------------------------------------------------------------------

describe('find_duplicate_saved_tracks edges', () => {
  it('handles an empty library', async () => {
    const out = await harness(libraryResponder([])).invoke('find_duplicate_saved_tracks');
    const p = payloadOf(out);
    assert.equal(p.scanned.saved_tracks, 0);
    assert.deepEqual(p.groups, []);
    assert.match(textOf(out), /No saved tracks found/);
  });

  it('skips unplayable/local entries without crashing', async () => {
    const partial = savedTrack({ id: 'ok1', name: 'Fine', artistNames: ['A'], durationMs: 100_000, addedAt: '2026-01-01T00:00:00Z' });
    const partialAgain = savedTrack({ id: 'ok2', name: 'Fine', artistNames: ['A'], durationMs: 100_000, addedAt: '2026-01-02T00:00:00Z' });
    const broken = { added_at: '2026-01-03T00:00:00Z', track: null } as unknown as SavedTrackItem;
    const out = await harness(libraryResponder([partial, broken, partialAgain])).invoke('find_duplicate_saved_tracks');
    const p = payloadOf(out);
    assert.equal(p.scanned.skipped_unplayable, 1);
    assert.equal(p.counts.exact_groups, 1);
  });
});

// ---------------------------------------------------------------------------
// JSON shape
// ---------------------------------------------------------------------------

describe('find_duplicate_saved_tracks json mode', () => {
  it('returns raw groups as structuredContent twin of the text payload', async () => {
    const tracks = [
      savedTrack({ id: 'j1', name: 'Json Song', artistNames: ['Data'], durationMs: 200_000, addedAt: '2026-01-01T00:00:00Z' }),
      savedTrack({ id: 'j2', name: 'Json Song', artistNames: ['Data'], durationMs: 200_400, addedAt: '2026-02-01T00:00:00Z' }),
    ];
    const out = await harness(libraryResponder(tracks)).invoke('find_duplicate_saved_tracks', {
      response_format: 'json',
    });
    const raw = JSON.parse(textOf(out)) as Payload;
    // Raw text and structuredContent carry the identical payload.
    assert.deepEqual(raw, payloadOf(out));
    assert.equal(raw.ok, true);
    assert.equal(raw.counts.exact_groups, 1);
    assert.equal(raw.groups.length, 1);
    assert.equal(raw.groups[0].kind, 'exact');
    assert.equal(raw.groups[0].match_basis, 'same_isrc_album_duration_within_2000ms');
    assert.equal(raw.groups[0].kept_uri, 'spotify:track:j1');
    assert.match(raw.groups[0].suggestion, /keep oldest, remove the rest \(exact match: same ISRC/);
    for (const member of raw.groups[0].members) {
      assert.equal(typeof member.uri, 'string');
      assert.equal(typeof member.duration_ms, 'number');
      assert.equal(typeof member.added_at, 'string');
    }
  });
});

// ---------------------------------------------------------------------------
// #161: playlist cross-reference
// ---------------------------------------------------------------------------

/** Responder serving a library plus one playlist (meta + items). */
function libraryAndPlaylistResponder(
  tracks: SavedTrackItem[],
  playlistId: string,
  playlistItems: Array<{ item: { type: string; uri: string } | null }>,
  playlistName = 'Road Trip',
): Responder {
  return (path, params) => {
    if (path === '/me/tracks') {
      const limit = Number(params?.limit ?? 50);
      const offset = Number(params?.offset ?? 0);
      return {
        items: tracks.slice(offset, offset + limit),
        total: tracks.length,
        limit,
        offset,
      };
    }
    if (path === `/playlists/${playlistId}`) return { id: playlistId, name: playlistName };
    if (path === `/playlists/${playlistId}/items`) {
      const limit = Number(params?.limit ?? 100);
      const offset = Number(params?.offset ?? 0);
      return {
        items: playlistItems.slice(offset, offset + limit),
        total: playlistItems.length,
        limit,
        offset,
      };
    }
    return null;
  };
}

describe('find_duplicate_saved_tracks playlist cross-reference (#161)', () => {
  const dupeLibrary = () => [
    savedTrack({ id: 'x1', name: 'Overlap Song', artistNames: ['Duo'], durationMs: 200_000, addedAt: '2026-01-01T00:00:00Z' }),
    savedTrack({ id: 'x2', name: 'Overlap Song', artistNames: ['Duo'], durationMs: 200_500, addedAt: '2026-02-01T00:00:00Z' }),
    savedTrack({ id: 'y1', name: 'Solo Song', artistNames: ['Trio'], durationMs: 180_000, addedAt: '2026-03-01T00:00:00Z' }),
  ];

  it('flags duplicate-group members that also appear in the playlist', async () => {
    const responder = libraryAndPlaylistResponder(dupeLibrary(), 'pl1', [
      // Only the NEWER save is curated into the playlist.
      { item: { type: 'track', uri: 'spotify:track:x2' } },
      { item: { type: 'track', uri: 'spotify:track:y1' } },
    ]);
    const out = await harness(responder).invoke('find_duplicate_saved_tracks', {
      playlist_id: 'pl1',
    });
    const p = payloadOf(out);
    assert.equal(p.scanned.playlist_id, 'pl1');
    assert.equal(p.scanned.playlist_name, 'Road Trip');
    assert.equal(p.scanned.playlist_tracks, 2);
    assert.equal(p.counts.exact_groups, 1);
    assert.equal(p.counts.groups_with_playlist_overlap, 1);
    const group = p.groups[0];
    assert.deepEqual(group.playlist_overlap_uris, ['spotify:track:x2']);
    // Prose marks the overlapping member and names the playlist.
    assert.match(textOf(out), /Cross-referenced against "Road Trip" \(2 items\)/);
    assert.match(textOf(out), /remove:.*\[in playlist\].*spotify:track:x2/);
    assert.doesNotMatch(textOf(out), /keep:.*\[in playlist\]/);
  });

  it('skips episodes and unavailable entries when collecting playlist track uris', async () => {
    const responder = libraryAndPlaylistResponder(dupeLibrary(), 'pl2', [
      { item: { type: 'episode', uri: 'spotify:episode:ep1' } },
      { item: null },
      { item: { type: 'track', uri: 'spotify:track:x1' } },
    ]);
    const out = await harness(responder).invoke('find_duplicate_saved_tracks', {
      playlist_id: 'pl2',
    });
    const p = payloadOf(out);
    // 3 total items walked, but only the track overlaps the dupes.
    assert.equal(p.scanned.playlist_tracks, 3);
    assert.deepEqual(p.groups[0].playlist_overlap_uris, ['spotify:track:x1']);
  });

  it('reports zero overlap when the playlist shares nothing with the dupes', async () => {
    const responder = libraryAndPlaylistResponder(dupeLibrary(), 'pl3', [
      { item: { type: 'track', uri: 'spotify:track:elsewhere' } },
    ]);
    const out = await harness(responder).invoke('find_duplicate_saved_tracks', {
      playlist_id: 'pl3',
    });
    const p = payloadOf(out);
    assert.equal(p.counts.groups_with_playlist_overlap, 0);
    assert.deepEqual(p.groups[0].playlist_overlap_uris, []);
    assert.match(textOf(out), /0 groups overlap/);
  });

  it('fails fast with a clear error for an unknown playlist id', async () => {
    const h = harness(libraryResponder(dupeLibrary()));
    await assert.rejects(
      () => h.invoke('find_duplicate_saved_tracks', { playlist_id: 'nope' }),
      /Playlist "nope" not found/,
    );
  });

  it('omits playlist fields entirely when no playlist_id is passed', async () => {
    const h = harness(libraryResponder(dupeLibrary()));
    const out = await h.invoke('find_duplicate_saved_tracks');
    const p = payloadOf(out);
    assert.equal(p.scanned.playlist_id, undefined);
    assert.equal(p.scanned.playlist_tracks, undefined);
    assert.equal(p.counts.groups_with_playlist_overlap, 0);
    assert.deepEqual(p.groups[0].playlist_overlap_uris, []);
    assert.doesNotMatch(textOf(out), /Cross-referenced/);
    // Read-only: only /me/tracks was touched.
    for (const call of h.client.calls) {
      assert.equal(call.path, '/me/tracks');
    }
  });
});

// ---------------------------------------------------------------------------
// Cap enforcement
// ---------------------------------------------------------------------------

describe('find_duplicate_saved_tracks cap enforcement', () => {
  it('stops paging at the fetch-all cap and flags truncation', async () => {
    // Build a library larger than the default cap by serving many pages.
    const bigLibrary: SavedTrackItem[] = Array.from({ length: 600 }, (_, i) =>
      savedTrack({
        id: `t${i}`,
        name: `Song ${i % 300}`, // pairs of dupes across the cap boundary
        artistNames: ['Cap'],
        durationMs: 200_000,
        addedAt: new Date(Date.UTC(2026, 0, 1 + i)).toISOString(),
      }),
    );
    const responder: Responder = (path, params) => {
      if (path === '/me/tracks') {
        const limit = Number(params?.limit ?? 50);
        const offset = Number(params?.offset ?? 0);
        return {
          items: bigLibrary.slice(offset, offset + limit),
          total: bigLibrary.length,
          limit,
          offset,
        };
      }
      return null;
    };
    const h = harness(responder);
    // Default fetchAllCap comes from env/config; find what the stub walked to.
    const out = await h.invoke('find_duplicate_saved_tracks');
    const p = payloadOf(out);
    const walked = h.client.calls.filter((c) => c.path === '/me/tracks').length;
    assert.ok(walked >= 1, 'at least one page fetched');
    // Whatever the cap is, the tool reports it and never walks past it.
    assert.equal(p.scanned.cap, p.scanned.fetch_all_cap);
    assert.equal(p.scanned.fetched, p.scanned.cap);
    assert.equal(p.scanned.snapshot_state, 'partial');
    assert.equal(p.scanned.complete, false);
    assert.equal(p.scanned.truncated_by_cap, true);
    assert.ok(p.scanned.saved_tracks < bigLibrary.length, 'cap truncated the walk');
    assert.match(textOf(out), /fetched 500 saved tracks, cap 500 — TRUNCATED/);
    void out;
  });

  it('distinguishes exactly-at-cap from cap-plus-one', async () => {
    const exact = Array.from({ length: 500 }, (_, i) =>
      savedTrack({ id: `exact${i}`, name: `Exact ${i}`, durationMs: 200_000, addedAt: '2026-01-01' }),
    );
    const exactOut = await harness(libraryResponder(exact)).invoke('find_duplicate_saved_tracks');
    const exactPayload = payloadOf(exactOut);
    assert.equal(exactPayload.scanned.fetched, 500);
    assert.equal(exactPayload.scanned.cap, 500);
    assert.equal(exactPayload.scanned.snapshot_state, 'complete');
    assert.equal(exactPayload.scanned.complete, true);
    assert.equal(exactPayload.scanned.truncated_by_cap, false);
    assert.match(textOf(exactOut), /fetched 500 saved tracks, cap 500 — complete; cap not reached/);

    const over = [...exact, savedTrack({
      id: 'over', name: 'Over', durationMs: 200_000, addedAt: '2026-01-02',
    })];
    const overOut = await harness(libraryResponder(over)).invoke('find_duplicate_saved_tracks');
    const overPayload = payloadOf(overOut);
    assert.equal(overPayload.scanned.fetched, 500);
    assert.equal(overPayload.scanned.snapshot_state, 'partial');
    assert.equal(overPayload.scanned.complete, false);
    assert.equal(overPayload.scanned.truncated_by_cap, true);
    assert.match(textOf(overOut), /fetched 500 saved tracks, cap 500 — TRUNCATED/);
  });
});
