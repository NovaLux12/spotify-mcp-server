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
}

const savedTrack = (spec: TrackSpec): SavedTrackItem => ({
  added_at: spec.addedAt,
  track: {
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
      id: `al-${spec.id}`,
      name: spec.albumName ?? `Album ${spec.id}`,
      uri: `spotify:album:al-${spec.id}`,
    },
  } satisfies SpotifyTrack,
});

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
  scanned: { saved_tracks: number; skipped_unplayable: number; fetch_all_cap: number; truncated_by_cap: boolean };
  counts: { exact_groups: number; near_duplicate_groups: number; removable_tracks: number };
  groups: Array<{
    kind: 'exact' | 'near_duplicate';
    normalized_name: string;
    artist_names: string[];
    members: Array<{ uri: string; added_at: string; duration_ms: number }>;
    removable_uris: string[];
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
  it('groups double-saves of the same song (same name+artists, ±2000ms)', async () => {
    const tracks = [
      savedTrack({ id: 'dupe1', name: 'Same Song', artistNames: ['Duo'], durationMs: 200_000, addedAt: '2026-01-01T00:00:00Z' }),
      savedTrack({ id: 'other', name: 'Unrelated', artistNames: ['Trio'], durationMs: 180_000, addedAt: '2026-01-02T00:00:00Z' }),
      savedTrack({ id: 'dupe2', name: 'same SONG!', artistNames: ['duo'], durationMs: 201_500, addedAt: '2026-02-01T00:00:00Z' }),
    ];
    const out = await harness(libraryResponder(tracks)).invoke('find_duplicate_saved_tracks');
    const p = payloadOf(out);
    assert.equal(p.counts.exact_groups, 1);
    const group = p.groups[0];
    assert.equal(group.kind, 'exact');
    assert.equal(group.normalized_name, 'same song');
    assert.deepEqual(group.artist_names, ['duo']);
    assert.deepEqual(group.members.map((m) => m.uri), [
      'spotify:track:dupe1',
      'spotify:track:dupe2',
    ]);
    assert.deepEqual(group.removable_uris, ['spotify:track:dupe2']);
    assert.match(group.suggestion, /keep oldest, remove the rest/);
    assert.match(textOf(out), /EXACT/);
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
    savedTrack({ id: 'orig', name: 'Classic', artistNames: ['Legend'], durationMs: 210_000, addedAt: '2025-06-01T00:00:00Z', albumName: 'Original Album' }),
    savedTrack({ id: 'remaster', name: 'Classic', artistNames: ['Legend'], durationMs: 224_000, addedAt: '2026-03-01T00:00:00Z', albumName: 'Remaster' }),
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
    assert.equal(group.normalized_name, 'classic');
    assert.deepEqual(group.artist_names, ['legend']);
    assert.deepEqual(group.members.map((m) => m.added_at), [
      '2025-06-01T00:00:00Z',
      '2026-03-01T00:00:00Z',
    ]);
    assert.deepEqual(group.removable_uris, ['spotify:track:remaster']);
    assert.match(textOf(out), /NEAR-DUPLICATE/);
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
    assert.equal(p.counts.removable_tracks, 2);
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
    const broken = { added_at: '2026-01-02T00:00:00Z', track: null } as unknown as SavedTrackItem;
    const out = await harness(libraryResponder([partial, broken, partial])).invoke('find_duplicate_saved_tracks');
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
    for (const member of raw.groups[0].members) {
      assert.equal(typeof member.uri, 'string');
      assert.equal(typeof member.duration_ms, 'number');
      assert.equal(typeof member.added_at, 'string');
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
    assert.equal(p.scanned.fetch_all_cap >= p.scanned.saved_tracks, true);
    if (p.scanned.truncated_by_cap) {
      assert.ok(p.scanned.saved_tracks < bigLibrary.length, 'cap truncated the walk');
      assert.match(textOf(out), /REACHED/);
    } else {
      assert.equal(p.scanned.saved_tracks, bigLibrary.length);
    }
    void out;
  });
});
