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
        return {
          items: recent.map((t) => ({ track: t, played_at: '2026-08-26T10:00:00Z', context: null })),
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
// Candidate-pool cap disclosure (#809)
// ---------------------------------------------------------------------------

describe('create_smart_playlist candidate pool caps', () => {
  interface PoolPayload {
    candidates_scanned: number;
    truncated_by_cap: boolean;
    cap: number;
  }

  it('discloses the 50-item recently_played ceiling when the page is full', async () => {
    const recent = Array.from({ length: 50 }, (_, i) => track(`r${i}`, `Recent ${i}`, [`Artist${i}`]));
    const h = harness({ recentTracks: recent });
    const out = await h.invoke({ source: 'recently_played', limit: 200, dry_run: true });
    const p = out.structuredContent as PoolPayload;
    assert.equal(p.truncated_by_cap, true);
    assert.equal(p.cap, 50);
    assert.equal(p.candidates_scanned, 50);
    // The prose must not read as a complete pool.
    assert.match(textOf(out), /candidate pool capped at 50 for source=recently_played/);
  });

  it('does not claim a cap when recently_played returns a short page', async () => {
    const recent = Array.from({ length: 7 }, (_, i) => track(`r${i}`, `Recent ${i}`, [`Artist${i}`]));
    const h = harness({ recentTracks: recent });
    const out = await h.invoke({ source: 'recently_played', dry_run: true });
    const p = out.structuredContent as PoolPayload;
    assert.equal(p.candidates_scanned, 7);
    assert.equal(p.truncated_by_cap, false);
    assert.doesNotMatch(textOf(out), /candidate pool capped/);
  });

  it('discloses the 100-item top_tracks ceiling only when both pages are full', async () => {
    const full = Array.from({ length: 120 }, (_, i) => track(`t${i}`, `Top ${i}`, [`Artist${i}`]));
    const capped = harness({ topTracks: full });
    const cappedOut = await capped.invoke({ source: 'top_tracks', limit: 200, dry_run: true });
    const cappedPayload = cappedOut.structuredContent as PoolPayload;
    assert.equal(cappedPayload.truncated_by_cap, true);
    assert.equal(cappedPayload.cap, 100);
    assert.equal(cappedPayload.candidates_scanned, 100);
    assert.match(textOf(cappedOut), /candidate pool capped at 100 for source=top_tracks/);

    const short = harness({ topTracks: full.slice(0, 40) });
    const shortOut = await short.invoke({ source: 'top_tracks', dry_run: true });
    const shortPayload = shortOut.structuredContent as PoolPayload;
    assert.equal(shortPayload.candidates_scanned, 40);
    assert.equal(shortPayload.truncated_by_cap, false);
    assert.doesNotMatch(textOf(shortOut), /candidate pool capped/);
  });

  it('names the saved_tracks scan_cap that bound the pool on the commit path', async () => {
    const many = Array.from({ length: 60 }, (_, i) => track(`s${i}`, `Saved ${i}`, [`Artist${i}`]));
    const h = harness({ savedTracks: many });
    const out = await h.invoke({ source: 'saved_tracks', scan_cap: 60, limit: 30 });
    const p = out.structuredContent as PoolPayload;
    assert.equal(p.truncated_by_cap, true);
    assert.equal(p.cap, 60);
    assert.match(textOf(out), /candidate pool capped at 60 for source=saved_tracks/);
    assert.match(textOf(out), /raise scan_cap/);
  });

  it('leaves a short saved_tracks pool uncapped', async () => {
    const h = harness({ savedTracks: [track('s1', 'A'), track('s2', 'B')] });
    const out = await h.invoke({ source: 'saved_tracks', dry_run: true });
    const p = out.structuredContent as PoolPayload;
    assert.equal(p.candidates_scanned, 2);
    assert.equal(p.truncated_by_cap, false);
    assert.equal(p.cap, 500);
  });

  it('offers limit for the list footer and never offset/fetch_all for this tool', async () => {
    const top = Array.from({ length: 100 }, (_, i) => track(`t${i}`, `Top ${i}`, [`Artist${i}`]));
    const h = harness({ topTracks: top });
    const out = await h.invoke({ source: 'top_tracks', limit: 80, dry_run: true });
    const text = textOf(out);
    assert.match(text, /30 more — raise limit/);
    assert.doesNotMatch(text, /fetch_all|pass offset/);
  });

  it('does not tell the caller to raise limit when limit cannot lift a pool cap', async () => {
    const full = Array.from({ length: 100 }, (_, i) => track(`t${i}`, `Top ${i}`, [`Artist${i}`]));
    const h = harness({ topTracks: full });
    const out = await h.invoke({ source: 'top_tracks', limit: 200, dry_run: true });
    const poolLine = textOf(out).split('\n').find((l) => l.includes('candidate pool capped'));
    assert.ok(poolLine, 'the pool cap must be disclosed');
    assert.match(poolLine, /no parameter raises this ceiling/);
    assert.doesNotMatch(poolLine, /raise limit|raise scan_cap/);
  });
});
