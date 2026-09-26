/**
 * Tests for create_smart_playlist (#172): candidate loading from three
 * sources, artist filtering, unique-per-artist, limit capping, dry_run,
 * batched creates, and empty-result error.
 */

import { describe, it, afterEach } from 'node:test';
import { z } from 'zod';
import assert from 'node:assert/strict';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { SpotifyClient } from '../src/client.js';
import {
  registerSmartTools,
  matchesArtistFilter,
  uniqueByArtist,
} from '../src/tools/smart.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function track(id: string, name: string, artists: string[] = ['Duo']): import('../src/types/spotify.js').SpotifyTrack {
  return {
    id,
    uri: `spotify:track:${id}`,
    name,
    type: 'track',
    duration_ms: 200_000,
    explicit: false,
    artists: artists.map((n, i) => ({ id: `ar${i}`, name: n })),
    album: { id: `al-${id}`, name: `Album ${id}`, uri: `spotify:album:al-${id}` },
  } as unknown as import('../src/types/spotify.js').SpotifyTrack;
}

interface RegisteredTool {
  name: string;
  validate: (args: Record<string, unknown>) => Record<string, unknown>;
  handler: (a: Record<string, unknown>) => Promise<{ content: Array<{ type: string; text: string }>; structuredContent?: Record<string, unknown> }>;
}

function harness(opts: {
  topTracks?: ReturnType<typeof track>[];
  recentTracks?: ReturnType<typeof track>[];
  savedTracks?: ReturnType<typeof track>[];
} = {}) {
  const registered: RegisteredTool[] = [];
  const posts: Array<{ path: string; body: unknown }> = [];
  const gets: string[] = [];

  const fakeServer = {
    tool(name: string, _desc: string, schema: z.ZodRawShape, handler: RegisteredTool['handler']) {
      registered.push({ name, validate: (a) => z.object(schema).parse(a), handler });
    },
  } as unknown as McpServer;

  const top = opts.topTracks ?? [];
  const recent = opts.recentTracks ?? [];
  const saved = opts.savedTracks ?? [];

  const client = {
    async get<T>(path: string, params?: Record<string, string>): Promise<T | null> {
      gets.push(`${path}?${JSON.stringify(params)}`);
      if (path === '/me/top/tracks') {
        const offset = Number(params?.offset ?? 0);
        const limit = Number(params?.limit ?? 50);
        return { items: top.slice(offset, offset + limit) } as T;
      }
      if (path === '/me/player/recently-played') {
        // The endpoint caps a page at 50, so a longer history is only reachable
        // by cursor descent — one page is all this tool reads.
        const limit = Number(params?.limit ?? 50);
        return {
          items: recent
            .slice(0, limit)
            .map((t) => ({ track: t, played_at: '2026-08-26T10:00:00Z', context: null })),
          cursors: { after: '2026-08-26T10:00:00.000Z', before: '2026-08-26T09:00:00.000Z' },
        } as T;
      }
      // receipt re-fetch for playlist_meta
      if (path.startsWith('/playlists/')) return { uri: 'spotify:playlist:pl1' } as T;
      return null;
    },
    // Mirrors SpotifyClient.getAllPagesWithTruncation over the canned library
    // so the verdict the tool reports is the real one, not a canned constant.
    async getAllPagesWithTruncation<T>(
      path: string,
      params?: Record<string, string>,
      opts?: { maxItems?: number },
    ): Promise<{ items: T[]; truncated: boolean }> {
      if (path !== '/me/tracks') return { items: [], truncated: false };
      const maxItems = opts?.maxItems ?? 500;
      const pageLimit = Number(params?.limit ?? 50);
      const all = saved
        .slice(0, Math.min(saved.length, maxItems + pageLimit))
        .map((t) => ({ added_at: '2026-01-01T00:00:00Z', track: t }));
      return {
        items: all.slice(0, maxItems) as T[],
        truncated: all.length > maxItems || all.length < saved.length,
      };
    },
    async post<T>(path: string, body: unknown): Promise<T | null> {
      posts.push({ path, body });
      if (path === '/me/playlists') {
        return { id: 'pl1', uri: 'spotify:playlist:pl1', external_urls: { spotify: 'https://open.spotify.com/playlist/pl1' } } as T;
      }
      // items add
      return { snapshot_id: 'snap1' } as T;
    },
  };

  registerSmartTools(fakeServer, client as unknown as SpotifyClient);
  return {
    registered,
    posts,
    gets,
    invoke: async (args: Record<string, unknown> = {}) => {
      const tool = registered.find((t) => t.name === 'create_smart_playlist');
      assert.ok(tool, 'tool registered');
      return tool.handler(tool.validate({ name: 'Smart Mix', ...args } as Record<string, unknown>));
    },
  };
}

const textOf = (out: { content: Array<{ text: string }> }) => out.content[0].text;

afterEach(() => {});

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

describe('create_smart_playlist helpers', () => {
  it('matchesArtistFilter is case-insensitive substring', () => {
    const t = track('x', 'Foo', ['Radiohead']);
    assert.equal(matchesArtistFilter(t as never, ['radio']), true);
    assert.equal(matchesArtistFilter(t as never, ['Miles']), false);
    assert.equal(matchesArtistFilter(track('y', 'B', ['A', 'B']) as never, ['b']), true);
  });

  it('uniqueByArtist keeps first per primary artist', () => {
    const a = track('1', 'One', ['Duo']);
    const b = track('2', 'Two', ['Duo']);
    const c = track('3', 'Three', ['Trio']);
    assert.deepEqual(uniqueByArtist([a, b, c] as never).map((t) => t.id), ['1', '3']);
  });
});

// ---------------------------------------------------------------------------
// Dry-run + filtering
// ---------------------------------------------------------------------------

describe('create_smart_playlist dry_run', () => {
  const top = [
    track('t1', 'Alpha', ['Radiohead']),
    track('t2', 'Beta', ['Radiohead']),
    track('t3', 'Gamma', ['Miles Davis']),
    track('t4', 'Delta', ['Duo']),
  ];

  it('previews without creating (no POST)', async () => {
    const h = harness({ topTracks: top });
    const out = await h.invoke({ source: 'top_tracks', dry_run: true });
    assert.equal(h.posts.length, 0);
    assert.match(textOf(out), /\[dry run\]/);
    const p = out.structuredContent as { dry_run: boolean; selected: number };
    assert.equal(p.dry_run, true);
    assert.equal(p.selected, 4);
  });

  it('caps at limit after dedupe', async () => {
    const h = harness({ topTracks: top });
    const out = await h.invoke({ source: 'top_tracks', limit: 2, dry_run: true });
    const p = out.structuredContent as { selected: number; uris: string[] };
    assert.equal(p.selected, 2);
    assert.equal(p.uris.length, 2);
  });

  it('filters by artist substring', async () => {
    const h = harness({ topTracks: top });
    const out = await h.invoke({ source: 'top_tracks', artist_filter: ['Radiohead'], dry_run: true });
    const p = out.structuredContent as { selected: number };
    assert.equal(p.selected, 2);
  });

  it('unique_artists keeps one per primary artist', async () => {
    const h = harness({ topTracks: top });
    const out = await h.invoke({ source: 'top_tracks', unique_artists: true, dry_run: true });
    const p = out.structuredContent as { selected: number };
    // Radiohead appears twice but only one kept
    assert.equal(p.selected, 3);
  });

  it('dedupes recently-played repeats', async () => {
    const dup = track('rx', 'Repeat', ['Duo']);
    const h = harness({ recentTracks: [dup, dup, track('ry', 'Other', ['Trio'])] });
    const out = await h.invoke({ source: 'recently_played', dry_run: true });
    const p = out.structuredContent as { selected: number };
    assert.equal(p.selected, 2);
  });

  it('errors when no candidate survives filtering', async () => {
    const h = harness({ topTracks: top });
    await assert.rejects(() => h.invoke({ source: 'top_tracks', artist_filter: ['Nobody'] }), /No candidate tracks matched/);
  });
});

// ---------------------------------------------------------------------------
// Real creation
// ---------------------------------------------------------------------------

describe('create_smart_playlist creation', () => {
  it('creates the playlist and adds tracks in batches', async () => {
    const many = Array.from({ length: 150 }, (_, i) => track(`m${i}`, `Song ${i}`, [`Artist${i % 10}`]));
    const h = harness({ savedTracks: many });
    const out = await h.invoke({ source: 'saved_tracks', limit: 150 });
    // POST /me/playlists + two item batches (100 + 50)
    const create = h.posts.filter((p) => p.path === '/me/playlists');
    assert.equal(create.length, 1);
    const batches = h.posts.filter((p) => p.path.startsWith('/playlists/'));
    assert.equal(batches.length, 2);
    assert.equal((batches[0].body as { uris: string[] }).uris.length, 100);
    const p = out.structuredContent as { added: number; batches_sent: number; ok: boolean };
    assert.equal(p.added, 150);
    assert.equal(p.batches_sent, 2);
    assert.equal(p.ok, true);
    assert.match(textOf(out), /Created.*Smart Mix.*150 tracks/);
  });

  it('pulls from saved_tracks when requested', async () => {
    const h = harness({ savedTracks: [track('s1', 'Saved A'), track('s2', 'Saved B')] });
    const out = await h.invoke({ source: 'saved_tracks', dry_run: true });
    const p = out.structuredContent as { selected: number };
    assert.equal(p.selected, 2);
    void out;
  });
});

// ---------------------------------------------------------------------------
// Pool ceilings (#809): a bounded read is a floor, and says so
// ---------------------------------------------------------------------------

describe('create_smart_playlist pool ceilings', () => {
  const pool = (out: { structuredContent?: Record<string, unknown> }) =>
    out.structuredContent as {
      pool_capped: boolean;
      pool_cap: number;
      candidates_scanned: number;
      truncated_at_fetch_all_cap: boolean;
    };

  const many = (n: number, p: string) =>
    Array.from({ length: n }, (_, i) => track(`${p}${i}`, `Song ${i}`, [`Artist${i}`]));

  it('names the top_tracks ceiling when the pool fills both pages', async () => {
    const h = harness({ topTracks: many(100, 't') });
    const out = await h.invoke({ source: 'top_tracks', limit: 200, dry_run: true });
    const p = pool(out);
    assert.equal(p.pool_capped, true);
    assert.equal(p.pool_cap, 100);
    assert.equal(p.candidates_scanned, 100);
    assert.match(textOf(out), /ceiling of 100/);
  });

  it('does not claim a ceiling when top_tracks ran out on its own', async () => {
    const h = harness({ topTracks: many(12, 't') });
    const out = await h.invoke({ source: 'top_tracks', dry_run: true });
    const p = pool(out);
    assert.equal(p.pool_capped, false);
    assert.equal(p.pool_cap, 100);
    assert.equal(p.candidates_scanned, 12);
    assert.doesNotMatch(textOf(out), /ceiling of/);
  });

  it('names the recently_played page ceiling instead of implying a full scan', async () => {
    // A 150-entry history; the endpoint's 50-row page is all one call can read.
    const h = harness({ recentTracks: many(150, 'r') });
    const out = await h.invoke({ source: 'recently_played', limit: 80, dry_run: true });
    const p = pool(out);
    assert.equal(p.candidates_scanned, 50);
    assert.equal(p.pool_capped, true);
    assert.equal(p.pool_cap, 50);
    assert.match(textOf(out), /ceiling of 50/);
  });

  it('reports the same pool numbers on the commit path as on the dry run', async () => {
    const h = harness({ topTracks: many(100, 't') });
    const dry = await h.invoke({ source: 'top_tracks', limit: 200, dry_run: true });
    const commit = await h.invoke({ source: 'top_tracks', limit: 200 });
    const d = pool(dry);
    const c = pool(commit);
    assert.equal(c.candidates_scanned, d.candidates_scanned);
    assert.equal(c.pool_capped, d.pool_capped);
    assert.equal(c.pool_cap, d.pool_cap);
    assert.match(textOf(commit), /ceiling of 100/);
  });

  it('a saved library that ends exactly at scan_cap is not called truncated', async () => {
    const h = harness({ savedTracks: many(500, 's') });
    const out = await h.invoke({ source: 'saved_tracks', scan_cap: 500, dry_run: true });
    const p = pool(out);
    assert.equal(p.candidates_scanned, 500);
    assert.equal(p.pool_capped, false);
    assert.equal(p.truncated_at_fetch_all_cap, false);
    assert.doesNotMatch(textOf(out), /ceiling of/);
  });

  it('a saved library past scan_cap reports the truncation', async () => {
    const h = harness({ savedTracks: many(900, 's') });
    const out = await h.invoke({ source: 'saved_tracks', scan_cap: 500, dry_run: true });
    const p = pool(out);
    assert.equal(p.candidates_scanned, 500);
    assert.equal(p.pool_capped, true);
    assert.equal(p.pool_cap, 500);
    assert.equal(p.truncated_at_fetch_all_cap, true);
    assert.match(textOf(out), /ceiling of 500/);
  });

  it('forwards time_range to the top_tracks read', async () => {
    const h = harness({ topTracks: many(3, 't') });
    await h.invoke({ source: 'top_tracks', time_range: 'long_term', dry_run: true });
    const call = h.gets.find((g) => g.startsWith('/me/top/tracks'));
    assert.ok(call, 'top_tracks was read');
    assert.match(call, /"time_range":"long_term"/);
  });

  it('sends the documented medium_term default when time_range is omitted', async () => {
    const h = harness({ topTracks: many(3, 't') });
    await h.invoke({ source: 'top_tracks', dry_run: true });
    const call = h.gets.find((g) => g.startsWith('/me/top/tracks'));
    assert.ok(call, 'top_tracks was read');
    assert.match(call, /"time_range":"medium_term"/);
  });
});
