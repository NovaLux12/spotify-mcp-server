/**
 * Behaviour tests for the five `search_saved_*` tools in src/tools/library.ts
 * (#761).
 *
 * The slice they belonged to had no behaviour test at all — only the
 * invalid-date-bound cases in tools.librarycounts.test.ts — so the read path
 * (walk → filter → facet → sort → cap) was exercised by nothing. Each test here
 * pins prose totals and payload fields, never internal call order, and every
 * filter is asserted in both directions (a query that must match and a query
 * that must not) so a comparator flipped to `>=` or a facet wired to the wrong
 * field fails.
 *
 * A saved row can come back with a null payload (`{ added_at, track: null }` for
 * content Spotify no longer serves). Those rows are unreadable: they are not
 * matches, and they are reported as a count rather than silently dropped.
 *
 * Stub MCP server + stub SpotifyClient — no network, no token file access.
 *
 * Run: node --import tsx --test tests/tools.librarysearch.test.ts
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { SpotifyClient } from '../src/client.js';
import { registerLibraryTools } from '../src/tools/library.js';

// ---------------------------------------------------------------------------
// Stub plumbing
// ---------------------------------------------------------------------------

interface WalkCall {
  path: string;
  params: Record<string, string> | undefined;
  maxItems: number | undefined;
}

/** Rows keyed by endpoint; the stub slices them to the walk's own maxItems. */
type Library = Record<string, unknown[]>;

interface RegisteredTool {
  name: string;
  schema: z.ZodRawShape;
  handler: (args: Record<string, unknown>) => Promise<{
    content: Array<{ type: string; text: string }>;
    structuredContent?: Record<string, unknown>;
  }>;
}

/**
 * `getAllPages` honours `maxItems` exactly as the real client does, so a test
 * can distinguish "the walk stopped at the cap" from "the library was that
 * small" — and `walked`/`scanned` really mean rows read.
 */
function harness(library: Library) {
  const calls: WalkCall[] = [];
  const client = {
    calls,
    async get<T>(path: string, params?: Record<string, string>): Promise<T | null> {
      throw new Error(`unexpected GET ${path} — these tools only walk`);
    },
    async getAllPages<T>(
      path: string,
      params?: Record<string, string>,
      opts?: { maxItems?: number },
    ): Promise<T[]> {
      calls.push({ path, params, maxItems: opts?.maxItems });
      const rows = library[path];
      if (rows === undefined) throw new Error(`unstubbed walk of ${path}`);
      return (opts?.maxItems === undefined
        ? rows
        : rows.slice(0, opts.maxItems)) as T[];
    },
  };

  const registered: RegisteredTool[] = [];
  const fakeServer = {
    tool(name: string, _desc: string, schema: z.ZodRawShape, handler: RegisteredTool['handler']) {
      registered.push({ name, schema, handler });
    },
  } as unknown as McpServer;
  registerLibraryTools(fakeServer, client as unknown as SpotifyClient);

  return {
    calls,
    invoke: async (name: string, args: Record<string, unknown> = {}) => {
      const tool = registered.find((t) => t.name === name);
      assert.ok(tool, `tool "${name}" should be registered`);
      // Parse through the real schema, the way the MCP server does, so
      // declared defaults (sort_by, limit) are the ones under test.
      const parsed = z.object(tool.schema).parse(args) as Record<string, unknown>;
      const res = await tool.handler(parsed);
      return {
        text: res.content.map((c) => c.text).join('\n'),
        payload: (res.structuredContent ?? {}) as Record<string, never>,
      };
    },
  };
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const album = (id: string, name: string, artist: string, addedAt: string) => ({
  added_at: addedAt,
  album: {
    id,
    name,
    uri: `spotify:album:${id}`,
    album_type: 'album',
    total_tracks: 10,
    release_date: '2025-05-05',
    artists: [{ name: artist }],
  },
});

/** A saved row whose payload Spotify could not serve. */
const deadAlbum = { added_at: '2026-01-01T00:00:00Z', album: null };

const ALBUMS = {
  '/me/albums': [
    album('a1', 'Nightfall', 'Nova', '2026-01-05T00:00:00Z'),
    album('a2', 'Daybreak', 'Iris', '2026-02-10T00:00:00Z'),
    album('a3', 'Nightfall Live', 'Ember', '2026-03-15T00:00:00Z'),
  ],
};

const SHOWS = {
  '/me/shows': [
    {
      added_at: '2026-01-05T00:00:00Z',
      show: { id: 's1', name: 'The Long Signal', uri: 'spotify:show:s1', total_episodes: 40, publisher: 'Deep Field' },
    },
    {
      added_at: '2026-02-10T00:00:00Z',
      show: { id: 's2', name: 'Morning Static', uri: 'spotify:show:s2', total_episodes: 12, publisher: 'Deep Field' },
    },
    // A show with no publisher: the query must not match on an absent field.
    {
      added_at: '2026-03-15T00:00:00Z',
      show: { id: 's3', name: 'Untitled Feed', uri: 'spotify:show:s3', total_episodes: 3 },
    },
  ],
};

const EPISODES = {
  '/me/episodes': [
    {
      added_at: '2026-01-05T00:00:00Z',
      episode: {
        id: 'e1', name: 'The Long Signal', uri: 'spotify:episode:e1',
        duration_ms: 1_800_000, release_date: '2026-01-01',
        show: { name: 'The Long Signal' },
      },
    },
    {
      added_at: '2026-02-10T00:00:00Z',
      episode: {
        id: 'e2', name: 'Interlude', uri: 'spotify:episode:e2',
        duration_ms: 900_000, release_date: '2026-02-01',
        show: { name: 'Morning Static' },
      },
    },
  ],
};

const AUDIOBOOKS = {
  '/me/audiobooks': [
    {
      added_at: '2026-01-05T00:00:00Z',
      audiobook: { name: 'The Salt Road', uri: 'spotify:audiobook:b1', authors: [{ name: 'N. Okafor' }] },
    },
    {
      added_at: '2026-02-10T00:00:00Z',
      audiobook: { name: 'Winter Ledger', uri: 'spotify:audiobook:b2', authors: [{ name: 'R. Vale' }] },
    },
  ],
};

const track = (
  id: string,
  name: string,
  artist: string,
  albumName: string,
  addedAt: string,
) => ({
  added_at: addedAt,
  track: {
    id,
    name,
    uri: `spotify:track:${id}`,
    duration_ms: 200_000,
    artists: [{ id: `ar-${artist}`, name: artist }],
    album: { id: `al-${albumName}`, name: albumName },
  },
});

const TRACKS = {
  '/me/tracks': [
    track('t1', 'Aurora', 'Nova', 'Nightfall', '2026-01-05T00:00:00Z'),
    track('t2', 'Harbour', 'Iris', 'Daybreak', '2026-02-10T00:00:00Z'),
    track('t3', 'Nightfall', 'Nova', 'Harbour Sessions', '2026-03-15T00:00:00Z'),
  ],
};

// ---------------------------------------------------------------------------
// search_saved_albums
// ---------------------------------------------------------------------------

describe('search_saved_albums: the filter runs over the walk and reports both numbers (#761)', () => {
  it('matches the album name and the credited artist, and nothing else', async () => {
    const h = harness(ALBUMS);

    const byName = await h.invoke('search_saved_albums', { query: 'nightfall' });
    assert.equal(byName.payload.matched, 2, 'both albums whose name contains "nightfall" match');
    assert.equal(byName.payload.scanned, 3, 'every walked row is accounted for');
    assert.match(byName.text, /Saved albums search: 2 match\(es\), showing 2 \(scanned 3\)/);

    // Same string, artist facet: only the album credited to Nova matches.
    const byArtist = await h.invoke('search_saved_albums', { artist: 'nova' });
    assert.equal(byArtist.payload.matched, 1, 'artist facet matches credits, not titles');
    assert.match(byArtist.text, /"Nightfall" by Nova/);
    assert.doesNotMatch(byArtist.text, /Daybreak/);

    // A query that matches nothing must report zero, not everything.
    const none = await h.invoke('search_saved_albums', { query: 'no-such-album' });
    assert.equal(none.payload.matched, 0);
    assert.equal(none.payload.scanned, 3);
    assert.match(none.text, /Saved albums search: 0 match\(es\), showing 0 \(scanned 3\)/);
  });

  it('discloses the walk cap and counts only the rows it read', async () => {
    const h = harness(ALBUMS);

    const capped = await h.invoke('search_saved_albums', { scan_cap: 2 });

    assert.equal(capped.payload.scanned, 2, 'scanned is the walk, not the library size');
    assert.equal(capped.payload.matched, 2, 'both walked rows match the empty query');
    assert.match(capped.text, /\(truncated at fetch_all_cap\)/);
    assert.doesNotMatch(capped.text, /Ember/, 'a row the walk never read cannot be listed');
    assert.doesNotMatch(capped.text, /Nightfall Live/);
  });

  it('reports a row with no album payload as unreadable instead of crashing the filter', async () => {
    const h = harness({ '/me/albums': [...ALBUMS['/me/albums'], deadAlbum] });

    // `artist` is the facet that dereferences `album` on every row.
    const res = await h.invoke('search_saved_albums', { artist: 'nova' });

    assert.equal(res.payload.matched, 1, 'the unreadable row is not a match');
    assert.equal(res.payload.unavailable_rows, 1);
    assert.equal(res.payload.scanned, 4, 'the walk still read four rows');
    assert.match(res.text, /1 saved row\(s\) carried no album payload/);
  });
});

// ---------------------------------------------------------------------------
// search_saved_shows
// ---------------------------------------------------------------------------

describe('search_saved_shows: query spans name and publisher (#761)', () => {
  it('matches the show name, the publisher, and neither — a show with no publisher', async () => {
    const h = harness(SHOWS);

    const byName = await h.invoke('search_saved_shows', { query: 'morning' });
    assert.equal(byName.payload.matched, 1);
    assert.match(byName.text, /"Morning Static" by Deep Field/);

    // Publisher matches BOTH shows it credits, and must not reach the third.
    const byPublisher = await h.invoke('search_saved_shows', { query: 'deep field' });
    assert.equal(byPublisher.payload.matched, 2, 'the publisher is searchable across shows');
    assert.doesNotMatch(byPublisher.text, /Untitled Feed/, 'an absent publisher is not a wildcard');

    const none = await h.invoke('search_saved_shows', { query: 'zzz-nothing' });
    assert.equal(none.payload.matched, 0);
    assert.equal(none.payload.scanned, 3);
  });

  it('lists every show and counts no truncation when the walk is complete', async () => {
    const h = harness(SHOWS);

    const res = await h.invoke('search_saved_shows', { scan_cap: 10 });

    assert.equal(res.payload.matched, 3);
    assert.doesNotMatch(res.text, /truncated at fetch_all_cap/, 'a walk short of the cap is not truncated');
  });

  it('reports a row with no show payload as unreadable', async () => {
    const h = harness({ '/me/shows': [...SHOWS['/me/shows'], { added_at: '2026-04-01T00:00:00Z', show: null }] });

    const res = await h.invoke('search_saved_shows', {});

    assert.equal(res.payload.matched, 3);
    assert.equal(res.payload.unavailable_rows, 1);
    assert.match(res.text, /1 saved row\(s\) carried no show payload/);
  });
});

// ---------------------------------------------------------------------------
// search_saved_episodes
// ---------------------------------------------------------------------------

describe('search_saved_episodes: query and show facets are independent (#761)', () => {
  it('query reads the episode title, show reads the parent show', async () => {
    const h = harness(EPISODES);

    // "Interlude" is an episode title, not a show name.
    const byTitle = await h.invoke('search_saved_episodes', { query: 'interlude' });
    assert.equal(byTitle.payload.matched, 1);
    assert.match(byTitle.text, /"Interlude" — Morning Static/);

    // The show facet selects the other row: the two facets cannot be the same
    // lookup, and neither can fall back to the other.
    const byShow = await h.invoke('search_saved_episodes', { show: 'long signal' });
    assert.equal(byShow.payload.matched, 1);
    assert.match(byShow.text, /"The Long Signal" — The Long Signal/);
    assert.doesNotMatch(byShow.text, /Interlude/);

    const none = await h.invoke('search_saved_episodes', { query: 'zzz' });
    assert.equal(none.payload.matched, 0);
    assert.equal(none.payload.scanned, 2);
  });

  it('discloses the walk cap', async () => {
    const h = harness(EPISODES);

    const res = await h.invoke('search_saved_episodes', { scan_cap: 1 });

    assert.equal(res.payload.scanned, 1);
    assert.equal(res.payload.matched, 1);
    assert.match(res.text, /\(truncated at fetch_all_cap\)/);
  });

  it('reports a row with no episode payload as unreadable', async () => {
    const h = harness({ '/me/episodes': [...EPISODES['/me/episodes'], { added_at: '2026-04-01T00:00:00Z', episode: null }] });

    const res = await h.invoke('search_saved_episodes', { show: 'morning' });

    assert.equal(res.payload.matched, 1);
    assert.equal(res.payload.unavailable_rows, 1);
    assert.match(res.text, /1 saved row\(s\) carried no episode payload/);
  });
});

// ---------------------------------------------------------------------------
// search_saved_audiobooks
// ---------------------------------------------------------------------------

describe('search_saved_audiobooks: query spans title and author (#761)', () => {
  it('matches the audiobook name and the author', async () => {
    const h = harness(AUDIOBOOKS);

    const byName = await h.invoke('search_saved_audiobooks', { query: 'salt road' });
    assert.equal(byName.payload.matched, 1);
    assert.match(byName.text, /"The Salt Road" by N\. Okafor/);

    const byAuthor = await h.invoke('search_saved_audiobooks', { query: 'r. vale' });
    assert.equal(byAuthor.payload.matched, 1);
    assert.match(byAuthor.text, /"Winter Ledger" by R\. Vale/);

    const none = await h.invoke('search_saved_audiobooks', { query: 'zzz' });
    assert.equal(none.payload.matched, 0);
    assert.equal(none.payload.scanned, 2);
  });

  it('reports a row with no audiobook payload as unreadable', async () => {
    const h = harness({ '/me/audiobooks': [...AUDIOBOOKS['/me/audiobooks'], { added_at: '2026-04-01T00:00:00Z', audiobook: null }] });

    const res = await h.invoke('search_saved_audiobooks', { query: 'road' });

    assert.equal(res.payload.matched, 1);
    assert.equal(res.payload.unavailable_rows, 1);
    assert.match(res.text, /1 saved row\(s\) carried no audiobook payload/);
  });
});

// ---------------------------------------------------------------------------
// search_saved_tracks
// ---------------------------------------------------------------------------

describe('search_saved_tracks: query, facets, sort and walk cap (#761)', () => {
  it('query searches track name, artist name and album name', async () => {
    const h = harness(TRACKS);

    const byTrackName = await h.invoke('search_saved_tracks', { query: 'aurora' });
    assert.equal(byTrackName.payload.total_matches, 1);
    assert.match(byTrackName.text, /"Aurora" by Nova — Nightfall/);

    const byArtistName = await h.invoke('search_saved_tracks', { query: 'iris' });
    assert.equal(byArtistName.payload.total_matches, 1);
    assert.match(byArtistName.text, /"Harbour" by Iris/);

    // "Nightfall" reaches t1 only through its ALBUM name and t3 only through its
    // TRACK title, so a haystack missing either half returns 1, not 2.
    const both = await h.invoke('search_saved_tracks', { query: 'nightfall' });
    assert.equal(both.payload.total_matches, 2, 'the query haystack is name + artists + album');

    const none = await h.invoke('search_saved_tracks', { query: 'zzz' });
    assert.equal(none.payload.total_matches, 0);
    assert.equal(none.payload.walked, 3);
  });

  it('artist and album facets filter on their own field', async () => {
    const h = harness(TRACKS);

    const byArtist = await h.invoke('search_saved_tracks', { artist: 'nova' });
    assert.equal(byArtist.payload.total_matches, 2, 'both Nova tracks match the artist facet');
    assert.equal(byArtist.payload.walked, 3, 'facets do not shrink the walk');

    const byAlbum = await h.invoke('search_saved_tracks', { album: 'harbour sessions' });
    assert.equal(byAlbum.payload.total_matches, 1);
    assert.match(byAlbum.text, /"Nightfall" by Nova — Harbour Sessions/);
  });

  it('sort_by reorders the matches and total_matches still counts them all', async () => {
    const h = harness(TRACKS);

    const desc = await h.invoke('search_saved_tracks', { sort_by: 'added_desc' });
    const names = (desc.payload.items as unknown as Array<{ track: { name: string } }>).map((i) => i.track.name);
    assert.deepEqual(names, ['Nightfall', 'Harbour', 'Aurora'], 'newest save first');

    const asc = await h.invoke('search_saved_tracks', { sort_by: 'added_asc' });
    assert.deepEqual(
      (asc.payload.items as unknown as Array<{ track: { name: string } }>).map((i) => i.track.name),
      ['Aurora', 'Harbour', 'Nightfall'],
      'added_asc must be the reverse, not a tie',
    );

    const byName = await h.invoke('search_saved_tracks', { sort_by: 'name_asc' });
    assert.deepEqual(
      (byName.payload.items as unknown as Array<{ track: { name: string } }>).map((i) => i.track.name),
      ['Aurora', 'Harbour', 'Nightfall'],
    );

    // `limit` slices the page; it must not become the match count.
    const limited = await h.invoke('search_saved_tracks', { limit: 1 });
    assert.equal(limited.payload.total_matches, 3, 'the count is the walk, not the page');
    assert.equal(limited.payload.returned, 1);
    assert.match(limited.text, /3 match\(es\) across 3 walked, showing 1:/);
  });

  it('discloses a walk that stopped at max_items', async () => {
    const h = harness(TRACKS);

    const res = await h.invoke('search_saved_tracks', { max_items: 2 });

    assert.equal(res.payload.walked, 2, 'walked counts rows read');
    assert.equal(res.payload.scan_cap, 2);
    assert.equal(res.payload.truncated, true);
    assert.match(res.text, /\(walk truncated at 2\)/);
    assert.match(res.text, /\(walk hit cap 2 — pass max_items to scan more\)/);
    assert.doesNotMatch(res.text, /Nightfall" by Nova — Harbour/, 'a row past the cap is not listed');
  });

  it('reports a row with no track payload as unreadable on the facets and the sorts that dereference it', async () => {
    const dead = { added_at: '2026-04-01T00:00:00Z', track: null };
    const h = harness({ '/me/tracks': [...TRACKS['/me/tracks'], dead] });

    // Every one of these reads `s.track` on each row.
    const byArtist = await h.invoke('search_saved_tracks', { artist: 'nova' });
    assert.equal(byArtist.payload.total_matches, 2);
    assert.equal(byArtist.payload.unavailable_rows, 1);
    assert.equal(byArtist.payload.walked, 4, 'the unreadable row is walked, then reported');
    assert.match(byArtist.text, /1 saved row\(s\) carried no track payload/);

    const byAlbum = await h.invoke('search_saved_tracks', { album: 'nightfall' });
    assert.equal(byAlbum.payload.total_matches, 1);

    const byName = await h.invoke('search_saved_tracks', { sort_by: 'name_asc' });
    assert.equal(byName.payload.total_matches, 3, 'the dead row is not a match, and does not break the sort');

    const byArtistSort = await h.invoke('search_saved_tracks', { sort_by: 'artist_asc' });
    assert.equal(byArtistSort.payload.total_matches, 3);
  });
});
