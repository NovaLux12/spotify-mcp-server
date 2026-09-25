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
        // Newest-first page; `before` is an index into the history and
        // `cursors.after` is the argument the next (older) page takes.
        const offset = Number(params?.before ?? 0);
        const limit = Number(params?.limit ?? 50);
        const rows = recent.slice(offset, offset + limit);
        const end = offset + rows.length;
        return {
          items: rows.map((t, i) => ({
            track: t,
            played_at: new Date(Date.UTC(2026, 7, 26, 10, 0, 0) - (offset + i) * 60_000).toISOString(),
            context: null,
          })),
          cursors: { after: String(end), before: String(Math.max(0, offset - limit)) },
          next: end < recent.length ? String(end) : null,
        } as T;
      }
      // receipt re-fetch for playlist_meta
      if (path.startsWith('/playlists/')) return { uri: 'spotify:playlist:pl1' } as T;
      return null;
    },
    async getAllPages<T>(path: string): Promise<T[]> {
      if (path === '/me/tracks') {
        return saved.map((t) => ({ added_at: '2026-01-01T00:00:00Z', track: t }) as unknown as T);
      }
      return [];
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
// #809 — candidate pool caps are disclosed whenever they truncate the ranking.
// Every source reads a bounded pool: top_tracks stops at 100, recently_played
// walks the newest-first cursor chain until `limit` candidates exist, and
// saved_tracks stops at scan_cap. A caller must never read a capped pool as a
// complete ranking, so the bound is named in BOTH the payload and the prose,
// and the dry-run and commit paths must agree about it.
// ---------------------------------------------------------------------------

interface PoolPayload {
  candidates_scanned: number;
  pool_capped: boolean;
  pool_cap: number | null;
  truncated_at_fetch_all_cap: boolean;
}

describe('create_smart_playlist pool cap disclosure (#809)', () => {
  it('top_tracks: a full 100-candidate pool reports pool_capped with cap 100', async () => {
    // 150 ranked tracks exist; the source only reads two pages of 50.
    const ranked = Array.from({ length: 150 }, (_, i) => track(`tt${i}`, `Ranked ${i}`, [`Artist${i}`]));
    const h = harness({ topTracks: ranked });
    const out = await h.invoke({ source: 'top_tracks', limit: 150, dry_run: true });
    const p = out.structuredContent as PoolPayload & { selected: number };
    assert.equal(p.candidates_scanned, 100);
    assert.equal(p.pool_capped, true);
    assert.equal(p.pool_cap, 100);
    // 100 candidates cannot fill a 150-track request: the miss must be visible.
    assert.equal(p.selected, 100);
    // The ceiling is in the prose, not just the payload.
    assert.match(textOf(out), /top_tracks pool capped at 100/);
    assert.match(textOf(out), /ranks beyond 100 were not read/);
  });

  it('top_tracks: a short pool is not reported as capped', async () => {
    const ranked = Array.from({ length: 12 }, (_, i) => track(`s${i}`, `Few ${i}`, [`Artist${i}`]));
    const h = harness({ topTracks: ranked });
    const out = await h.invoke({ source: 'top_tracks', dry_run: true });
    const p = out.structuredContent as PoolPayload;
    assert.equal(p.candidates_scanned, 12);
    assert.equal(p.pool_capped, false);
    assert.equal(p.pool_cap, null);
    assert.doesNotMatch(textOf(out), /pool capped at/);
  });

  it('recently_played: walks past the first page to reach the requested limit', async () => {
    // Three pages of history; a limit of 80 needs two of them.
    const history = Array.from({ length: 150 }, (_, i) => track(`rp${i}`, `Play ${i}`, [`Artist${i}`]));
    const h = harness({ recentTracks: history });
    const out = await h.invoke({ source: 'recently_played', limit: 80, dry_run: true });
    const p = out.structuredContent as PoolPayload & { selected: number; uris: string[] };
    assert.equal(p.candidates_scanned, 80);
    assert.equal(p.selected, 80);
    assert.equal(p.uris.length, 80);
    assert.equal(p.pool_cap, 80);
    assert.equal(p.pool_capped, true);
    // The oldest pages were not read, and the caller is told so.
    assert.match(textOf(out), /recently_played pool capped at 80/);
    assert.match(textOf(out), /older history was not read/);
    // More than one page of history was actually fetched.
    const recentGets = h.gets.filter((g) => g.startsWith('/me/player/recently-played'));
    assert.equal(recentGets.length, 2);
    // The descent passes cursors.after back as `before`, not the same cursor twice.
    assert.match(recentGets[1]!, /"before":"50"/);
  });

  it('recently_played: an exhausted history is not reported as capped', async () => {
    const history = Array.from({ length: 20 }, (_, i) => track(`e${i}`, `Old ${i}`, [`Artist${i}`]));
    const h = harness({ recentTracks: history });
    const out = await h.invoke({ source: 'recently_played', limit: 200, dry_run: true });
    const p = out.structuredContent as PoolPayload;
    assert.equal(p.candidates_scanned, 20);
    assert.equal(p.pool_capped, false);
    assert.equal(p.pool_cap, null);
    assert.doesNotMatch(textOf(out), /pool capped at/);
  });

  it('recently_played: scan_cap is the walk ceiling the schema advertises', async () => {
    // 300 plays of history, but the caller caps the walk at 50. Reading past 50
    // would make scan_cap a bound the payload does not honour.
    const history = Array.from({ length: 300 }, (_, i) => track(`c${i}`, `Capped ${i}`, [`Artist${i}`]));
    const h = harness({ recentTracks: history });
    const out = await h.invoke({ source: 'recently_played', limit: 200, scan_cap: 50, dry_run: true });
    const p = out.structuredContent as PoolPayload;
    assert.equal(p.candidates_scanned, 50);
    assert.equal(p.pool_capped, true);
    assert.equal(p.pool_cap, 50);
    assert.equal(p.truncated_at_fetch_all_cap, true);
    assert.match(textOf(out), /recently_played pool capped at 50/);
    // One page covers the 50-item ceiling; the walk stops there.
    const recentGets = h.gets.filter((g) => g.startsWith('/me/player/recently-played'));
    assert.equal(recentGets.length, 1);
  });

  it('dry-run and commit agree on candidates_scanned and pool_capped', async () => {
    const ranked = Array.from({ length: 150 }, (_, i) => track(`p${i}`, `Ranked ${i}`, [`Artist${i}`]));
    const dry = await harness({ topTracks: ranked }).invoke({ source: 'top_tracks', limit: 120, dry_run: true });
    const real = await harness({ topTracks: ranked }).invoke({ source: 'top_tracks', limit: 120, time_range: 'long_term' });
    const d = dry.structuredContent as PoolPayload;
    const c = real.structuredContent as PoolPayload;
    assert.equal(d.candidates_scanned, c.candidates_scanned);
    assert.equal(d.pool_capped, c.pool_capped);
    assert.equal(d.pool_cap, c.pool_cap);
    assert.equal(c.pool_capped, true);
    assert.equal(c.pool_cap, 100);
    // The commit prose carries the same disclosure the dry run does, and names
    // the range actually requested rather than a defaulted guess.
    assert.match(textOf(real), /top_tracks pool capped at 100/);
    assert.match(textOf(real), /100 tracks from the top 100 of your long_term ranking/);
  });

  it('saved_tracks keeps its scan_cap disclosure and the shared pool fields', async () => {
    const many = Array.from({ length: 40 }, (_, i) => track(`sv${i}`, `Saved ${i}`, [`Artist${i}`]));
    const h = harness({ savedTracks: many });
    const out = await h.invoke({ source: 'saved_tracks', limit: 40, scan_cap: 40 });
    const p = out.structuredContent as PoolPayload & { added: number };
    assert.equal(p.candidates_scanned, 40);
    assert.equal(p.pool_capped, true);
    assert.equal(p.pool_cap, 40);
    assert.equal(p.truncated_at_fetch_all_cap, true);
    assert.equal(p.added, 40);
    assert.match(textOf(out), /saved_tracks pool truncated at scan_cap=40/);
  });
});
