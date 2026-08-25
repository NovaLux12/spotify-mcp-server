/**
 * Tests for src/tools/playlistdna.ts — grow_playlist (#112 idea 6).
 *
 * grow_playlist builds co-occurrence curation from the user's own data:
 * seed set from the target playlist, inverted index over OTHER playlists,
 * scoring with an artist-name bonus, saved-library exclusion, and a
 * read-only proposal (no mutation endpoint is ever touched).
 */

import { describe, it } from 'node:test';
import { z } from 'zod';
import assert from 'node:assert/strict';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { SpotifyClient } from '../src/client.js';
import type { PlaylistItemObject, SpotifyPaged, SpotifyPlaylistSimple } from '../src/types/spotify.js';
import { registerPlaylistDnaTools, describeCandidate, ARTIST_BONUS } from '../src/tools/playlistdna.js';
import { initConfig, getConfig } from '../src/config.js';

// ---------------------------------------------------------------------------
// Stub plumbing (mirrors tests/tools.playlists-following.test.ts)
// ---------------------------------------------------------------------------

interface RecordedCall {
  method: 'GET' | 'POST' | 'PUT' | 'PUT_RAW' | 'DELETE';
  path: string;
  arg?: unknown;
}

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
  const calls: RecordedCall[] = [];
  let respond: Responder = responder;
  return {
    calls,
    async get<T>(path: string, params?: Record<string, string>): Promise<T | null> {
      calls.push({ method: 'GET', path, arg: params });
      return respond(path, params) as T | null;
    },
    async post<T>(path: string, body?: unknown): Promise<T | null> {
      calls.push({ method: 'POST', path, arg: body });
      return respond(path, body) as T | null;
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
  registerPlaylistDnaTools(fakeServer, client as unknown as SpotifyClient);
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

/** One GET /playlists/{id}/items row nesting the playable under `item`. */
const trackRow = (id: string, name: string, artistNames: string[]): PlaylistItemObject =>
  ({
    added_at: '2026-01-01T00:00:00Z',
    item: {
      id,
      name,
      uri: `spotify:track:${id}`,
      type: 'track',
      duration_ms: 200000,
      explicit: false,
      artists: artistNames.map((n) => ({ name: n })),
      album: { name: `Album ${id}` },
    },
  }) as PlaylistItemObject;

const paged = <T>(items: T[], limit = 100): SpotifyPaged<T> => ({
  items,
  total: items.length,
  limit,
  offset: 0,
  next: null,
});

const playlistSimple = (id: string, name: string): SpotifyPlaylistSimple => ({
  id,
  name,
  uri: `spotify:playlist:${id}`,
  description: null,
  owner: { id: 'me', display_name: 'Me' },
  items: { total: 2 },
});

/**
 * Fixture graph:
 *   target pl-target: t1 (Artist Alpha), t2 (Artist Beta)
 *   p1: t3 (Artist Gamma), t4 (Artist Alpha), t1  ← t1 also appears here
 *   p2: t3, t4, t1                                ← t1 reaches count 2…
 *   p3: t3                                        ← …but t1 is a seed → excluded
 * Co-occurrence over other playlists: t3 ×3 (no artist match), t4 ×2
 * (shares "Artist Alpha" with seed → bonus), t1 excluded as target member.
 */
const baseItems: Record<string, PlaylistItemObject[]> = {
  'pl-target': [trackRow('t1', 'Seed One', ['Artist Alpha']), trackRow('t2', 'Seed Two', ['Artist Beta'])],
  p1: [
    trackRow('t3', 'Co Track', ['Artist Gamma']),
    trackRow('t4', 'Bonus Track', ['Artist Alpha']),
    trackRow('t1', 'Seed One', ['Artist Alpha']),
  ],
  p2: [
    trackRow('t3', 'Co Track', ['Artist Gamma']),
    trackRow('t4', 'Bonus Track', ['Artist Alpha']),
    trackRow('t1', 'Seed One', ['Artist Alpha']),
  ],
  p3: [trackRow('t3', 'Co Track', ['Artist Gamma'])],
};

function makeResponder(opts: {
  items?: Record<string, PlaylistItemObject[]>;
  playlists?: SpotifyPlaylistSimple[];
  savedIds?: string[];
} = {}) {
  const items = opts.items ?? baseItems;
  const playlists = opts.playlists ?? [playlistSimple('p1', 'One'), playlistSimple('p2', 'Two'), playlistSimple('p3', 'Three')];
  const savedIds = opts.savedIds ?? [];
  return (path: string): unknown => {
    if (path === '/me/playlists') return paged(playlists, 50);
    if (path === '/me/tracks')
      return paged(savedIds.map((id) => ({ added_at: 'x', track: { id, name: id, uri: `spotify:track:${id}` } })), 50);
    const m = /^\/playlists\/([^/]+)\/items$/.exec(path);
    if (m) return paged(items[m[1]!] ?? []);
    return null;
  };
}

// ---------------------------------------------------------------------------
// Index build, scoring, artist bonus
// ---------------------------------------------------------------------------

describe('grow_playlist — inverted index + scoring', () => {
  it('builds the index over other playlists, scores co-occurrence with artist bonus, ranks by score', async () => {
    const h = harness(makeResponder());
    const out = await h.invoke('grow_playlist', {
      playlist_id: 'pl-target',
      exclude_saved: false,
      response_format: 'concise',
    });

    const payload = out.structuredContent!;
    const items = payload.items as Array<{
      track_id: string;
      score: number;
      playlists: number;
      shared_seed_artists: string[];
    }>;

    // t4: count 2 + ARTIST_BONUS = 4; t3: count 3, no match = 3 → t4 first.
    assert.deepEqual(
      items.map((c) => c.track_id),
      ['t4', 't3'],
    );
    assert.equal(items[0]!.score, 2 + ARTIST_BONUS);
    assert.equal(items[0]!.playlists, 2);
    assert.deepEqual(items[0]!.shared_seed_artists, ['artist alpha']);
    assert.equal(items[1]!.score, 3);
    assert.deepEqual(items[1]!.shared_seed_artists, []);
  });

  it('excludes the target playlist itself from the index (seed members never proposed)', async () => {
    // t1 reaches count 2 across p1+p2 yet must not surface as a candidate.
    const h = harness(makeResponder());
    const out = await h.invoke('grow_playlist', { playlist_id: 'pl-target', exclude_saved: false });
    const ids = (out.structuredContent!.items as Array<{ track_id: string }>).map((c) => c.track_id);
    assert.ok(!ids.includes('t1'), 'target track must not be proposed');
    assert.ok(!ids.includes('t2'));
  });

  it('renders score-evidence lines in prose', async () => {
    const h = harness(makeResponder());
    const out = await h.invoke('grow_playlist', { playlist_id: 'pl-target', exclude_saved: false });
    const text = textOf(out);
    assert.match(text, /spotify:track:t4 — in 2 of your playlists, shares artist "artist alpha" with seed/);
    assert.match(text, /\[score 4\]/);
    assert.match(text, /Read-only proposal/);
    assert.match(text, /add_to_playlist/);
  });

  it('never issues a mutating call — GET only', async () => {
    const h = harness(makeResponder());
    await h.invoke('grow_playlist', { playlist_id: 'pl-target', exclude_saved: false, dry_run: true });
    for (const c of h.client.calls) {
      assert.equal(c.method, 'GET', `unexpected ${c.method} ${c.path}`);
    }
  });
});

// ---------------------------------------------------------------------------
// Exclusion paths
// ---------------------------------------------------------------------------

describe('grow_playlist — exclusions', () => {
  it('exclude_saved defaults to true: saved candidates are dropped and counted', async () => {
    const h = harness(makeResponder({ savedIds: ['s9', 't3'] }));
    const out = await h.invoke('grow_playlist', { playlist_id: 'pl-target' });

    const ids = (out.structuredContent!.items as Array<{ track_id: string }>).map((c) => c.track_id);
    assert.ok(!ids.includes('t3'), 'saved track must be excluded by default');
    assert.deepEqual(ids, ['t4']);
    assert.equal((out.structuredContent!.scanned as Record<string, unknown>).saved_tracks_scanned, 2);
    // The saved-library walk happened exactly once.
    assert.equal(h.client.calls.filter((c) => c.path === '/me/tracks').length, 1);
  });

  it('exclude_saved: false keeps saved-but-cooccurring tracks and skips /me/tracks entirely', async () => {
    const h = harness(makeResponder({ savedIds: ['t3'] }));
    const out = await h.invoke('grow_playlist', { playlist_id: 'pl-target', exclude_saved: false });
    const ids = (out.structuredContent!.items as Array<{ track_id: string }>).map((c) => c.track_id);
    assert.ok(ids.includes('t3'));
    assert.equal(h.client.calls.some((c) => c.path === '/me/tracks'), false);
  });
});

// ---------------------------------------------------------------------------
// Cap enforcement on playlists walked
// ---------------------------------------------------------------------------

describe('grow_playlist — fetchAllCap on playlist walks', () => {
  it('stops walking other playlists at the configured cap and reports the truncation', async () => {
    initConfig({ SPOTIFY_MCP_FETCH_ALL_CAP: '2' });
    try {
      assert.equal(getConfig().fetchAllCap, 2);
      const h = harness(makeResponder());
      const out = await h.invoke('grow_playlist', { playlist_id: 'pl-target', exclude_saved: false });

      const walkedPaths = new Set(
        h.client.calls.filter((c) => c.path.startsWith('/playlists/') && !c.path.includes('pl-target')).map((c) => c.path),
      );
      // Only p1 and p2 item pages were fetched; p3 was never touched.
      assert.equal(walkedPaths.has('/playlists/p3/items'), false);

      const scanned = out.structuredContent!.scanned as Record<string, unknown>;
      assert.equal(scanned.playlists_total, 3);
      assert.equal(scanned.playlists_walked, 2);
      assert.equal(scanned.walk_capped, true);
    } finally {
      initConfig({});
    }
  });
});

// ---------------------------------------------------------------------------
// Empty-seed edge
// ---------------------------------------------------------------------------

describe('grow_playlist — empty seeds', () => {
  it('returns a graceful proposal-free result without walking any library', async () => {
    const h = harness(
      makeResponder({
        items: { 'pl-empty': [] },
        playlists: [playlistSimple('p1', 'One')],
      }),
    );
    const out = await h.invoke('grow_playlist', { playlist_id: 'pl-empty' });

    assert.deepEqual(out.structuredContent!.proposals, []);
    assert.match(textOf(out), /no tracks/i);
    // Bails out before the expensive walks.
    assert.equal(h.client.calls.some((c) => c.path === '/me/playlists'), false);
    assert.equal(h.client.calls.some((c) => c.path === '/me/tracks'), false);
  });
});

// ---------------------------------------------------------------------------
// json mode shape
// ---------------------------------------------------------------------------

describe('grow_playlist — json mode', () => {
  it('emits raw scored candidates as parseable text plus the structuredContent twin', async () => {
    const h = harness(makeResponder());
    const out = await h.invoke('grow_playlist', {
      playlist_id: 'pl-target',
      exclude_saved: false,
      response_format: 'json',
    });

    const parsed = JSON.parse(textOf(out));
    assert.equal(parsed.tool, 'grow_playlist');
    assert.equal(parsed.target_playlist.id, 'pl-target');
    assert.deepEqual(
      parsed.items.map((c: { track_id: string }) => c.track_id),
      ['t4', 't3'],
    );
    assert.equal(typeof parsed.items[0].score, 'number');
    assert.deepEqual(out.structuredContent!.items, parsed.items);
    assert.equal(parsed.next_step.includes('add_to_playlist'), true);
  });
});

// ---------------------------------------------------------------------------
// Argument shape
// ---------------------------------------------------------------------------

describe('grow_playlist — argument shape', () => {
  const setup = () => {
    const h = harness(makeResponder());
    return { validate: h.registered.find((t) => t.name === 'grow_playlist')!.validate };
  };

  it('accepts size within 5–50 and dry_run', () => {
    const { validate } = setup();
    assert.equal(validate({ playlist_id: 'x', size: 5, dry_run: true }).size, 5);
    assert.equal(validate({ playlist_id: 'x', size: 50 }).size, 50);
  });

  it('rejects out-of-range size', () => {
    const { validate } = setup();
    assert.throws(() => validate({ playlist_id: 'x', size: 4 }));
    assert.throws(() => validate({ playlist_id: 'x', size: 51 }));
    assert.throws(() => validate({ playlist_id: 'x', size: 20.5 }));
  });

  it('rejects a missing playlist_id', () => {
    const { validate } = setup();
    assert.throws(() => validate({}));
  });
});

// ---------------------------------------------------------------------------
// describeCandidate unit coverage
// ---------------------------------------------------------------------------

describe('describeCandidate', () => {
  it('mentions playlist count and the first matching seed artist', () => {
    const reason = describeCandidate({
      track_id: 'x',
      uri: 'spotify:track:x',
      name: 'X',
      artists: ['A'],
      score: 5,
      playlists: 3,
      shared_seed_artists: ['radiohead', 'björk'],
    });
    assert.equal(reason, 'in 3 of your playlists, shares artist "radiohead" with seed (+1 more)');
  });

  it('omits the artist clause when nothing matches', () => {
    const reason = describeCandidate({
      track_id: 'x',
      uri: 'spotify:track:x',
      name: 'X',
      artists: [],
      score: 2,
      playlists: 2,
      shared_seed_artists: [],
    });
    assert.equal(reason, 'in 2 of your playlists');
  });
});
