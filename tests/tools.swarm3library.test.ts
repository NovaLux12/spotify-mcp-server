/**
 * Behaviour tests for the 24 tools in src/tools/swarm3_library.ts (#761).
 *
 * Until now the only coverage of this module was one dry_run test in
 * tools.swarm-coverage.test.ts (which asserts zero API calls and never enters
 * the read path) — the other 23 tools had no behaviour test at all, so their
 * grouping math, their ratios and their payload fields were exercised by
 * nothing. Every tool below runs against the SAME paged fixture so the numbers
 * are cross-checkable, and each test asserts prose totals and payload fields
 * rather than call order.
 *
 * Fixture shape (see TRACKS / ALBUMS below for the field-by-field values):
 *   6 saved tracks over 5 saved albums, 2 playlists, 3 artists' top-tracks.
 *   Deliberate edges: an album with no release_date, a local file, an
 *   unplayable track, a restricted track, the same track saved from two albums
 *   (duplicate version) and the same record saved as two editions.
 *
 * `saved_vs_playlist_coverage` gets its own test because the Feb-2026 API
 * rename (playlist rows carry `item`, not `track`) once made it report 0%
 * coverage for every library — the fixture serves one item-shaped and one
 * legacy-shaped playlist so both readings stay exercised.
 *
 * Stub MCP server + stub SpotifyClient — no network, no token file access.
 *
 * Run: node --import tsx --test tests/tools.swarm3library.test.ts
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { SpotifyClient } from '../src/client.js';
import { registerSwarm3LibraryTools } from '../src/tools/swarm3_library.js';

// ---------------------------------------------------------------------------
// Stub plumbing
// ---------------------------------------------------------------------------

interface TrackPayload {
  id: string;
  name: string;
  uri: string;
  duration_ms: number;
  explicit?: boolean;
  is_local?: boolean;
  is_playable?: boolean;
  restrictions?: { reason: string };
  artists: Array<{ id: string; name: string }>;
  album: { id: string; name: string; release_date: string | null };
}

interface SavedTrack {
  added_at: string;
  track: TrackPayload | null;
}

interface SavedAlbum {
  added_at: string;
  album: {
    id: string;
    name: string;
    uri: string;
    album_type: string;
    total_tracks: number;
    release_date: string | null;
    label: string | null;
    artists: Array<{ id: string; name: string }>;
  };
}

interface PlaylistRow {
  item?: { id: string };
  track?: { id: string };
}

type Library = Record<string, unknown>;

interface RegisteredTool {
  name: string;
  schema: z.ZodRawShape;
  handler: (args: Record<string, unknown>) => Promise<{
    content: Array<{ type: string; text: string }>;
    structuredContent?: Record<string, unknown>;
  }>;
}

/** Recorded `getAllPages` walks, with the ceiling each one was handed. */
interface WalkCall {
  path: string;
  maxItems: number | undefined;
}

function harness(library: Library) {
  const calls: Array<{ path: string; params: Record<string, string> | undefined }> = [];
  const walks: WalkCall[] = [];
  const client = {
    calls,
    walks,
    async get<T>(path: string, params?: Record<string, string>): Promise<T | null> {
      calls.push({ path, params });
      if (!(path in library)) throw new Error(`unstubbed GET ${path}`);
      return library[path] as T | null;
    },
    async getAllPages<T>(
      path: string,
      _params?: Record<string, string>,
      opts?: { maxItems?: number },
    ): Promise<T[]> {
      walks.push({ path, maxItems: opts?.maxItems });
      if (!(path in library)) throw new Error(`unstubbed walk of ${path}`);
      const rows = library[path];
      if (!Array.isArray(rows)) throw new Error(`walk of ${path} must be stubbed with rows`);
      return (opts?.maxItems === undefined ? rows : rows.slice(0, opts.maxItems)) as T[];
    },
  };

  const registered: RegisteredTool[] = [];
  const fakeServer = {
    tool(name: string, _desc: string, schema: z.ZodRawShape, handler: RegisteredTool['handler']) {
      registered.push({ name, schema, handler });
    },
  } as unknown as McpServer;
  registerSwarm3LibraryTools(fakeServer, client as unknown as SpotifyClient);

  const invoke = async (name: string, args: Record<string, unknown> = {}) => {
    const tool = registered.find((t) => t.name === name);
    assert.ok(tool, `tool "${name}" must be registered`);
    // Parse through the declared schema, as the MCP server does.
    const parsed = z.object(tool.schema).parse(args) as Record<string, unknown>;
    const res = await tool.handler(parsed);
    return {
      text: res.content.map((c) => c.text).join('\n'),
      payload: (res.structuredContent ?? {}) as Record<string, never>,
      names: () =>
        (res.structuredContent as { items?: Array<{ name?: string }> }).items?.map((i) => i.name) ?? [],
    };
  };

  return { calls, walks, invoke };
}

// ---------------------------------------------------------------------------
// Shared fixture
// ---------------------------------------------------------------------------

const track = (
  id: string,
  name: string,
  artists: Array<[string, string]>,
  album: { id: string; name: string; release_date: string | null },
  addedAt: string,
  extra: Partial<TrackPayload> = {},
): SavedTrack => ({
  added_at: addedAt,
  track: {
    id,
    name,
    uri: `spotify:track:${id}`,
    duration_ms: 200_000,
    explicit: false,
    is_local: false,
    is_playable: true,
    artists: artists.map(([aid, aname]) => ({ id: aid, name: aname })),
    album,
    ...extra,
  },
});

const NIGHTFALL = { id: 'al-nightfall', name: 'Nightfall', release_date: '2019-05-01' };
const NIGHTFALL_DELUXE = { id: 'al-nightfall-deluxe', name: 'Nightfall Deluxe', release_date: '2019-05-01' };
const VOLCANO = { id: 'al-volcano', name: 'Volcano', release_date: '1995-07-20' };
const SANDS = { id: 'al-sands', name: 'Sands', release_date: null };

/**
 * tr-aurora      200000ms, 2026-01  (Nightfall, Nova)
 * tr-beacon      250000ms, 2026-02  explicit, Nova + Iris
 * tr-aurora-x    210000ms, 2026-02  same name+artist as tr-aurora, other album
 * tr-cinder      180000ms, 2026-02  is_local
 * tr-dune        210000ms, 2026-03  is_playable false, album has no release_date
 * tr-ember-song  195000ms, 2026-03  restrictions.reason, "featuring" in title
 */
const TRACKS: SavedTrack[] = [
  track('tr-aurora', 'Aurora', [['ar-nova', 'Nova']], NIGHTFALL, '2026-01-05T00:00:00Z'),
  track('tr-beacon', 'Beacon (feat. Iris)', [['ar-nova', 'Nova'], ['ar-iris', 'Iris']], NIGHTFALL, '2026-02-10T00:00:00Z', { duration_ms: 250_000, explicit: true }),
  track('tr-aurora-x', 'Aurora', [['ar-nova', 'Nova']], NIGHTFALL_DELUXE, '2026-02-11T00:00:00Z', { duration_ms: 210_000 }),
  track('tr-cinder', 'Cinder', [['ar-ember', 'Ember']], VOLCANO, '2026-02-20T00:00:00Z', { duration_ms: 180_000, is_local: true }),
  track('tr-dune', 'Dune', [['ar-iris', 'Iris']], SANDS, '2026-03-02T00:00:00Z', { duration_ms: 210_000, is_playable: false }),
  track('tr-ember-song', 'Ember Song featuring Ash', [['ar-ember', 'Ember'], ['ar-ash', 'Ash']], VOLCANO, '2026-03-05T00:00:00Z', { duration_ms: 195_000, restrictions: { reason: 'market' } }),
];

const album = (
  id: string,
  name: string,
  artists: Array<[string, string]>,
  releaseDate: string | null,
  albumType: string,
  label: string | null,
): SavedAlbum => ({
  added_at: '2026-01-05T00:00:00Z',
  album: {
    id,
    name,
    uri: `spotify:album:${id}`,
    album_type: albumType,
    total_tracks: 10,
    release_date: releaseDate,
    label,
    artists: artists.map(([aid, aname]) => ({ id: aid, name: aname })),
  },
});

/**
 * al-nightfall + al-nightfall-remaster are the same record in two editions;
 * al-sands has no release_date; al-solstice's only artist (Zephyr) saved no
 * tracks, and Ash saved tracks but no album.
 */
const ALBUMS: SavedAlbum[] = [
  album('al-nightfall', 'Nightfall', [['ar-nova', 'Nova']], '2019-05-01', 'album', 'Aurora Records'),
  album('al-nightfall-remaster', 'Nightfall (Remastered 2019)', [['ar-nova', 'Nova']], '2019-05-01', 'album', 'Aurora Records'),
  album('al-volcano', 'Volcano', [['ar-ember', 'Ember']], '1995-07-20', 'album', null),
  album('al-sands', 'Sands', [['ar-iris', 'Iris']], null, 'single', 'Dust Records'),
  album('al-solstice', 'Solstice', [['ar-zephyr', 'Zephyr']], '2021-03-03', 'single', 'Aurora Records'),
];

/** `/artists/{id}/top-tracks` returns `{ tracks: [...] }`, as the tool reads it. */
const TOP_TRACKS: Record<string, { tracks: Array<{ id: string; name: string }> }> = {
  '/artists/ar-nova/top-tracks': {
    tracks: [
      { id: 'tr-aurora', name: 'Aurora' },
      { id: 'tr-beacon', name: 'Beacon (feat. Iris)' },
      { id: 'tr-x', name: 'Nova Unlisted' },
    ],
  },
  '/artists/ar-ember/top-tracks': {
    tracks: [{ id: 'tr-ember-song', name: 'Ember Song featuring Ash' }],
  },
  '/artists/ar-iris/top-tracks': {
    tracks: [
      { id: 'tr-dune', name: 'Dune' },
      { id: 'tr-y', name: 'Iris Unlisted' },
    ],
  },
};

/** pl-1 speaks the current `item` shape; pl-2 the legacy `track` shape. */
const PLAYLISTS: Array<{ id: string; name: string }> = [
  { id: 'pl-1', name: 'Late Shift' },
  { id: 'pl-2', name: 'Long Drive' },
];

const PLAYLIST_ITEMS: Record<string, PlaylistRow[]> = {
  '/playlists/pl-1/items': [{ item: { id: 'tr-aurora' } }],
  '/playlists/pl-2/items': [{ track: { id: 'tr-dune' } }],
};

const FIXTURE: Library = {
  '/me/tracks': TRACKS,
  '/me/albums': ALBUMS,
  '/me/playlists': PLAYLISTS,
  ...PLAYLIST_ITEMS,
  ...TOP_TRACKS,
  '/me/player/recently-played': {
    items: [{ track: { id: 'tr-aurora' } }, { track: { id: 'tr-dune' } }],
  },
};

const SCAN = { scan_cap: 200 };

// ---------------------------------------------------------------------------
// 1-3. Album groupings
// ---------------------------------------------------------------------------

describe('swarm3_library: album groupings over the shared fixture (#761)', () => {
  it('saved_albums_by_decade counts each album once and names the undated ones', async () => {
    const h = harness(FIXTURE);
    const { payload, text } = await h.invoke('saved_albums_by_decade', SCAN);

    assert.equal(payload.total_albums, 5);
    assert.deepEqual(payload.decades, [
      { decade: '2010s', count: 2 },
      { decade: '1990s', count: 1 },
      { decade: '2020s', count: 1 },
    ]);
    assert.equal(payload.unknown_decade, 1, 'an album with no release_date is unknown, not dropped');
    assert.match(text, /Saved albums by release decade \(5 album\(s\) walked, scan_cap=200\)/);
    assert.match(text, /\(unknown\)\s+1/);
  });

  it('saved_albums_by_label counts a missing label as its own bucket', async () => {
    const h = harness(FIXTURE);
    const { payload, text } = await h.invoke('saved_albums_by_label', SCAN);

    assert.equal(payload.total_albums, 5);
    assert.equal(payload.distinct_labels, 3);
    const byLabel = Object.fromEntries(
      (payload.items as unknown as Array<{ label: string; count: number }>).map((r) => [r.label, r.count]),
    );
    assert.deepEqual(byLabel, { 'Aurora Records': 3, 'Dust Records': 1, '(no label in payload)': 1 });
    assert.equal((payload.items as unknown as Array<{ count: number }>)[0].count, 3, 'the biggest label ranks first');
    assert.match(text, /Saved albums by label \(5 album\(s\), 3 distinct label\(s\)\)/);
  });

  it('saved_albums_by_type groups on album_type', async () => {
    const h = harness(FIXTURE);
    const { payload, text } = await h.invoke('saved_albums_by_type', SCAN);

    assert.equal(payload.total_albums, 5);
    assert.deepEqual(payload.types, [
      { album_type: 'album', count: 3 },
      { album_type: 'single', count: 2 },
    ]);
    assert.match(text, /Saved albums by album_type \(5 album\(s\)\)/);
  });
});

// ---------------------------------------------------------------------------
// 4-5. Artist-level views
// ---------------------------------------------------------------------------

describe('swarm3_library: artist representation and asymmetry (#761)', () => {
  it('artist_representation_census counts every credit, not just the first', async () => {
    const h = harness(FIXTURE);
    const { payload, text } = await h.invoke('artist_representation_census', SCAN);

    // Ash is credited on exactly one track, and only as a second artist.
    assert.equal(payload.distinct_artists, 4);
    assert.equal(payload.total_saved_tracks, 6);
    assert.deepEqual(
      (payload.items as unknown as Array<{ artist: string; saved_tracks: number }>).map((r) => [r.artist, r.saved_tracks]),
      [['Nova', 3], ['Ember', 2], ['Iris', 2], ['Ash', 1]],
    );
    assert.match(text, /Artist representation census: 4 distinct artist\(s\) across 6 saved track\(s\)/);
  });

  it('orphaned_artist_check finds the two one-sided artists and no others', async () => {
    const h = harness(FIXTURE);
    const { payload, text } = await h.invoke('orphaned_artist_check', SCAN);

    assert.equal(payload.total_saved_tracks, 6);
    assert.equal(payload.total_saved_albums, 5);
    assert.deepEqual(payload.track_only_artists, [{ artist_id: 'ar-ash', artist: 'Ash' }]);
    assert.deepEqual(payload.album_only_artists, [{ artist_id: 'ar-zephyr', artist: 'Zephyr' }]);
    assert.match(text, /Artists with saved tracks but ZERO saved albums: 1/);
    assert.match(text, /Artists with saved albums but ZERO saved tracks: 1/);
  });
});

// ---------------------------------------------------------------------------
// 6-8. Time over the saved library
// ---------------------------------------------------------------------------

describe('swarm3_library: when the library was saved (#761)', () => {
  it('saved_track_age_report puts each track in the bucket its age falls in, on both sides of every edge', async () => {
    // One track per bucket edge, so a flipped comparator (>= vs >) moves a row.
    const daysAgo = (n: number) => new Date(Date.now() - n * 86_400_000).toISOString();
    const aged: SavedTrack[] = [
      track('tr-6', 'Six', [['ar-a', 'A']], NIGHTFALL, daysAgo(6)),
      track('tr-7', 'Seven', [['ar-a', 'A']], NIGHTFALL, daysAgo(7)),
      track('tr-29', 'Twenty nine', [['ar-a', 'A']], NIGHTFALL, daysAgo(29)),
      track('tr-30', 'Thirty', [['ar-a', 'A']], NIGHTFALL, daysAgo(30)),
      track('tr-89', 'Eighty nine', [['ar-a', 'A']], NIGHTFALL, daysAgo(89)),
      track('tr-90', 'Ninety', [['ar-a', 'A']], NIGHTFALL, daysAgo(90)),
      track('tr-365', 'A year', [['ar-a', 'A']], NIGHTFALL, daysAgo(365)),
      track('tr-730', 'Two years', [['ar-a', 'A']], NIGHTFALL, daysAgo(730)),
      track('tr-1825', 'Five years', [['ar-a', 'A']], NIGHTFALL, daysAgo(1825)),
      { added_at: '', track: { ...(TRACKS[0].track as TrackPayload), id: 'tr-undated' } },
    ];
    const h = harness({ '/me/tracks': aged });
    const { payload, text } = await h.invoke('saved_track_age_report', SCAN);

    assert.equal(payload.total, 10);
    assert.deepEqual(payload.age_buckets, [
      { bucket: '< 7 days', count: 1 },
      { bucket: '7–30 days', count: 2 },
      { bucket: '30–90 days', count: 2 },
      { bucket: '90–365 days', count: 1 },
      { bucket: '1–2 years', count: 1 },
      { bucket: '2–5 years', count: 1 },
      { bucket: '5+ years', count: 1 },
      { bucket: '(no date)', count: 1 },
    ]);
    const perYear = payload.per_year as unknown as Array<{ year: string; count: number }>;
    assert.equal(perYear.reduce((a, r) => a + r.count, 0), 9, 'the undated row is in no year');
    assert.equal((payload.oldest as { name: string }).name, 'Five years', 'oldest is the earliest date, not the first row');
    assert.match(text, /Saved-track age report \(10 track\(s\)\)/);
  });

  it('added_on_this_day matches this calendar day in earlier years and nothing else', async () => {
    const now = new Date();
    const today = `${String(now.getUTCMonth() + 1).padStart(2, '0')}-${String(now.getUTCDate()).padStart(2, '0')}`;
    const otherDay = today === '01-15' ? '02-16' : '01-15';
    const h = harness({
      '/me/tracks': [
        track('tr-2020', 'Saved last year on the day', [['ar-a', 'A']], NIGHTFALL, `2020-${today}T09:00:00Z`),
        track('tr-2022', 'Saved two years ago on the day', [['ar-a', 'A']], NIGHTFALL, `2022-${today}T09:00:00Z`),
        track('tr-2021', 'Saved on a different day', [['ar-a', 'A']], NIGHTFALL, `2021-${otherDay}T09:00:00Z`),
      ],
    });
    const { payload, names, text } = await h.invoke('added_on_this_day', SCAN);

    assert.equal(payload.day_key, today);
    assert.deepEqual(names(), ['Saved last year on the day', 'Saved two years ago on the day'], 'oldest save first');
    assert.deepEqual(payload.per_year, [['2020', 1], ['2022', 1]]);
    assert.match(text, new RegExp(`On this day \\(${today}\\) across previous years: 2 saved track\\(s\\)`));
  });

  it('library_growth_timeline sums the months, names the busiest, and measures the streak', async () => {
    const h = harness(FIXTURE);
    const { payload, text } = await h.invoke('library_growth_timeline', SCAN);

    assert.equal(payload.total_adds, 6);
    assert.equal(payload.months_active, 3);
    assert.deepEqual(payload.per_month, [
      { month: '2026-01', count: 1 },
      { month: '2026-02', count: 3 },
      { month: '2026-03', count: 2 },
    ]);
    assert.deepEqual(payload.busiest_month, { month: '2026-02', adds: 3 });
    const streaks = payload.streaks as unknown as { longest: number; current: number; longest_span: [string, string] };
    assert.equal(streaks.longest, 3, 'Jan→Feb→Mar is one unbroken run');
    assert.equal(streaks.current, 3);
    assert.deepEqual(streaks.longest_span, ['2026-01', '2026-03']);
    assert.match(text, /Busiest month: 2026-02 \(3 adds\)/);
  });
});

// ---------------------------------------------------------------------------
// 9-10. Duplicate hygiene
// ---------------------------------------------------------------------------

describe('swarm3_library: duplicate versions and cross-edition albums (#761)', () => {
  it('duplicate_saved_versions groups the same song saved from two different albums', async () => {
    const h = harness(FIXTURE);
    const { payload, text } = await h.invoke('duplicate_saved_versions', SCAN);

    assert.equal(payload.total_saved_tracks, 6);
    assert.equal(payload.duplicate_groups, 1);
    const [group] = payload.items as unknown as Array<{
      name: string; artist: string; versions: Array<{ album_id: string }>;
    }>;
    assert.equal(group.name, 'Aurora');
    assert.equal(group.artist, 'Nova');
    assert.deepEqual(group.versions.map((v) => v.album_id), ['al-nightfall', 'al-nightfall-deluxe']);
    assert.match(text, /Duplicate saved versions: 1 song\(s\) saved from 2\+ distinct albums \(6 saved track\(s\) walked\)/);
  });

  it('album_edition_lint sees through remaster wording to the same record', async () => {
    const h = harness(FIXTURE);
    const { payload, text } = await h.invoke('album_edition_lint', SCAN);

    assert.equal(payload.total_saved_albums, 5);
    assert.equal(payload.lint_groups, 1);
    const [group] = payload.items as unknown as Array<{ canonical: string; artist: string; editions: Array<{ name: string }> }>;
    assert.equal(group.canonical, 'Nightfall');
    assert.equal(group.artist, 'Nova');
    assert.deepEqual(group.editions.map((e) => e.name), ['Nightfall', 'Nightfall (Remastered 2019)']);
    assert.match(text, /Album edition lint: 1 record\(s\) saved across multiple editions/);
  });
});

// ---------------------------------------------------------------------------
// 11-12. Cross-source reads
// ---------------------------------------------------------------------------

describe('swarm3_library: cross-source reads (#761)', () => {
  it('never_played_saved subtracts the recently-played window and says how small that window is', async () => {
    const h = harness(FIXTURE);
    const { payload, names, text } = await h.invoke('never_played_saved', SCAN);

    // tr-aurora is in the window; tr-aurora-x (the same title, saved from the
    // deluxe) is not; tr-cinder is local and out of scope. So the rows are
    // identified by URI — two of them share the title "Aurora".
    assert.equal(payload.recently_played_ids, 2);
    assert.equal(payload.total_saved_tracks, 6);
    assert.deepEqual(
      (payload.items as unknown as Array<{ uri: string }>).map((i) => i.uri).sort(),
      ['spotify:track:tr-aurora-x', 'spotify:track:tr-beacon', 'spotify:track:tr-ember-song'],
    );
    assert.match(text, /3 of 6\.$/m);
    assert.match(text, /window ≈ last 50 plays/);
    assert.match(text, /NOT "never played since you saved it"/);
  });

  it('saved_vs_playlist_coverage credits item-shaped playlist rows (#A7-001, #761)', async () => {
    const h = harness(FIXTURE);
    const { payload, text } = await h.invoke('saved_vs_playlist_coverage', SCAN);

    // pl-1 carries tr-aurora under `item`, pl-2 carries tr-dune under the legacy
    // `track`. Both must count as covered, or the ratio reads 0% for a library
    // that is fully curated. The rows below are named by URI because
    // tr-aurora and tr-aurora-x share a title.
    assert.equal(payload.playlists_scanned, 2);
    assert.equal(payload.total_saved_tracks, 6);
    assert.equal(payload.coverage_ratio, 0.5, '3 of 6 saved tracks are in no playlist');
    assert.equal(payload.quota_hit_at_playlist, null);
    assert.deepEqual(
      (payload.items as unknown as Array<{ uri: string }>).map((i) => i.uri).sort(),
      ['spotify:track:tr-aurora-x', 'spotify:track:tr-beacon', 'spotify:track:tr-ember-song'],
    );
    assert.match(text, /50\.0% of 6 saved track\(s\) appear in at least one of 2 playlist\(s\)/);
    assert.match(text, /Saved tracks in NO playlist: 3/);

    // Direction-sensitive, both ways: an inverted ratio reads 100% when nothing
    // is covered. With no playlists at all, 5 of the 6 saved tracks are in no
    // playlist — the local file is in none either but is excluded from
    // `missing`, so it is the only row that counts as neither.
    const empty = harness({ ...FIXTURE, '/me/playlists': [] });
    const none = await empty.invoke('saved_vs_playlist_coverage', SCAN);
    assert.equal(none.payload.coverage_ratio, 1 - 5 / 6, 'no playlists means no coverage, not full coverage');
    assert.equal((none.payload.items as unknown as unknown[]).length, 5);

    // And the other end: every non-local track in one playlist is full coverage.
    const all = harness({
      ...FIXTURE,
      '/me/playlists': [{ id: 'pl-1', name: 'Everything' }],
      '/playlists/pl-1/items': TRACKS.filter((t) => t.track).map((t) => ({ item: { id: (t.track as TrackPayload).id } })),
    });
    const full = await all.invoke('saved_vs_playlist_coverage', SCAN);
    assert.equal(full.payload.coverage_ratio, 1, 'a fully curated library reads 100%');
    assert.match(full.text, /100\.0% of 6 saved track\(s\) appear in at least one of 1 playlist\(s\)/);
  });
});

// ---------------------------------------------------------------------------
// 13-16. Per-artist and duration views
// ---------------------------------------------------------------------------

describe('swarm3_library: completeness, era runtime and duration ranking (#761)', () => {
  it('artist_completeness_score scores saved-over-top and orders by the weakest first', async () => {
    const h = harness(FIXTURE);
    const { payload, text } = await h.invoke('artist_completeness_score', SCAN);

    assert.equal(payload.artists_scored, 3);
    assert.equal(payload.quota_hit, false);
    const rows = payload.items as unknown as Array<{
      artist: string; saved_top_tracks: number; top_tracks_total: number; completeness: number; missing_top: string[];
    }>;
    assert.deepEqual(rows.map((r) => r.artist), ['Iris', 'Nova', 'Ember'], 'ascending completeness');
    assert.deepEqual(rows.map((r) => [r.saved_top_tracks, r.top_tracks_total]), [[1, 2], [2, 3], [1, 1]]);
    assert.equal(rows[1].completeness, 2 / 3);
    assert.deepEqual(rows[1].missing_top, ['Nova Unlisted'], 'the unsaved top track is named');
    const avg = payload.average_completeness as number;
    assert.ok(Math.abs(avg - (0.5 + 2 / 3 + 1) / 3) < 1e-12, `average_completeness was ${avg}`);
    assert.match(text, /avg 72% across 3 artist\(s\)/);
  });

  it('saved_runtime_by_era buckets runtime by the album decade, undated albums aside', async () => {
    const h = harness(FIXTURE);
    const { payload, text } = await h.invoke('saved_runtime_by_era', SCAN);

    // 2010s: 200000 + 250000 + 210000 = 660000; 1990s: 180000 + 195000 = 375000.
    assert.deepEqual(payload.eras, [
      { decade: '1990s', runtime_ms: 375_000, tracks: 2 },
      { decade: '2010s', runtime_ms: 660_000, tracks: 3 },
    ]);
    assert.deepEqual(payload.unknown_era, { ms: 210_000, tracks: 1 });
    assert.equal(payload.total_runtime_ms, 1_245_000, 'the unknown era is runtime too, not a hole');
    assert.match(text, /Saved runtime by release era: 20:45 total across 6 track\(s\)/);
    assert.match(text, /\(unknown\).*no release_date/);
  });

  it('longest_saved_tracks ranks descending and formats the clock', async () => {
    const h = harness(FIXTURE);
    const { payload, text } = await h.invoke('longest_saved_tracks', SCAN);

    const rows = payload.items as unknown as Array<{ name: string; duration_ms: number; duration: string }>;
    assert.equal(rows[0].name, 'Beacon (feat. Iris)');
    assert.equal(rows[0].duration_ms, 250_000);
    assert.equal(rows[0].duration, '4:10');
    const durations = rows.map((r) => r.duration_ms);
    assert.deepEqual(durations, [...durations].sort((a, b) => b - a), 'descending, longest first');
    assert.equal(rows[rows.length - 1].name, 'Cinder');
    assert.match(text, /Longest saved tracks \(of 6\)/);
  });

  it('shortest_saved_tracks is the mirror image', async () => {
    const h = harness(FIXTURE);
    const { payload, text } = await h.invoke('shortest_saved_tracks', SCAN);

    const rows = payload.items as unknown as Array<{ name: string; duration_ms: number; duration: string }>;
    assert.equal(rows[0].name, 'Cinder');
    assert.equal(rows[0].duration_ms, 180_000);
    assert.equal(rows[0].duration, '3:00');
    const durations = rows.map((r) => r.duration_ms);
    assert.deepEqual(durations, [...durations].sort((a, b) => a - b), 'ascending, shortest first');
    assert.match(text, /Shortest saved tracks \(of 6\)/);
  });
});

// ---------------------------------------------------------------------------
// 17-19. Years, collaboration, featuring
// ---------------------------------------------------------------------------

describe('swarm3_library: years, collaboration and featuring (#761)', () => {
  it('saved_albums_by_year splits the year out of release_date', async () => {
    const h = harness(FIXTURE);
    const { payload, text } = await h.invoke('saved_albums_by_year', SCAN);

    assert.equal(payload.total_albums, 5);
    assert.deepEqual(payload.per_year, [
      { year: '1995', count: 1 },
      { year: '2019', count: 2 },
      { year: '2021', count: 1 },
    ]);
    assert.equal(payload.unknown_year, 1);
    assert.match(text, /Saved albums by release year \(5 album\(s\)\)/);
  });

  it('collab_density_report measures 2+ credited artists', async () => {
    const h = harness(FIXTURE);
    const { payload, text } = await h.invoke('collab_density_report', SCAN);

    assert.equal(payload.total_saved_tracks, 6);
    assert.equal(payload.collab_tracks, 2);
    assert.ok(Math.abs((payload.collab_ratio as number) - 2 / 6) < 1e-12);
    assert.deepEqual(
      (payload.top_collaborators as unknown as Array<{ artist: string; credited_tracks: number }>).map((r) => r.artist),
      ['Ash', 'Ember', 'Iris', 'Nova'],
    );
    assert.equal(
      (payload.most_credited_tracks as unknown as Array<{ name: string }>)[0].name,
      'Beacon (feat. Iris)',
    );
    assert.match(text, /Collab density: 2\/6 saved track\(s\) \(33\.3%\) credit 2\+ artists\./);
  });

  it('featuring_density_report counts the title marker, not the credit', async () => {
    const h = harness(FIXTURE);
    const { payload, text } = await h.invoke('featuring_density_report', SCAN);

    // tr-ember-song carries "featuring" in the TITLE; tr-aurora-x is a
    // multi-artist-free duplicate, so a credit-based count would differ.
    assert.equal(payload.feat_tracks, 2);
    assert.equal(payload.total_saved_tracks, 6);
    assert.ok(Math.abs((payload.feat_ratio as number) - 2 / 6) < 1e-12);
    assert.deepEqual(
      [...names(payload)].sort(),
      ['Beacon (feat. Iris)', 'Ember Song featuring Ash'],
    );
    assert.match(text, /Featuring density: 2\/6 saved track\(s\) \(33\.3%\) have "feat\." in the title\./);

    function names(p: Record<string, never>): string[] {
      return (p.items as unknown as Array<{ name: string }>).map((i) => i.name);
    }
  });
});

// ---------------------------------------------------------------------------
// 20-23. Content flags
// ---------------------------------------------------------------------------

describe('swarm3_library: content flags (#761)', () => {
  it('title_length_outliers reports mean, median and both ends', async () => {
    const h = harness(FIXTURE);
    const { payload, text } = await h.invoke('title_length_outliers', SCAN);
    // 6 + 19 + 6 + 6 + 4 + 24 = 65 chars over 6 titles.
    assert.equal(payload.count, 6);
    assert.equal(payload.min_chars, 4);
    assert.equal(payload.max_chars, 24);
    assert.equal(payload.median_chars, 6);
    assert.ok(Math.abs((payload.mean_chars as number) - 65 / 6) < 1e-9, `mean was ${payload.mean_chars}`);
    const longest = payload.longest as unknown as Array<{ name: string; chars: number }>;
    assert.equal(longest[0].name, 'Ember Song featuring Ash');
    assert.equal(longest[0].chars, 24);
    const shortest = payload.shortest as unknown as Array<{ chars: number }>;
    assert.equal(shortest.length, 5, 'the short end is capped at five');
    assert.equal(shortest[0].chars, 4, 'the short end really is the shortest titles');
    assert.equal(shortest[shortest.length - 1].chars, 19);
    assert.match(text, /Title length: mean 10\.8 chars, median 6, range 4–24 \(6 track\(s\)\)/);
  });

  it('explicit_content_ratio shares the explicit count and its artists', async () => {
    const h = harness(FIXTURE);
    const { payload, text } = await h.invoke('explicit_content_ratio', SCAN);

    assert.equal(payload.explicit_tracks, 1);
    assert.equal(payload.total_saved_tracks, 6);
    assert.ok(Math.abs((payload.explicit_ratio as number) - 1 / 6) < 1e-12);
    assert.deepEqual(payload.top_explicit_artists, [{ artist: 'Nova', explicit_tracks: 1 }]);
    assert.match(text, /Explicit content ratio: 1\/6 saved track\(s\) are explicit \(16\.7%\)\./);
  });

  it('is_local_census counts the local files it lists', async () => {
    const h = harness(FIXTURE);
    const { payload, text } = await h.invoke('is_local_census', SCAN);

    assert.equal(payload.local_count, 1);
    assert.equal(payload.total_saved_tracks, 6);
    assert.match(text, /Local-file census: 1\/6 saved track\(s\) flagged is_local\./);
    assert.match(text, /local files are device-bound/);
  });

  it('unplayable_saved_check separates a restriction from an unplayable flag', async () => {
    const h = harness(FIXTURE);
    const { payload, text } = await h.invoke('unplayable_saved_check', SCAN);

    assert.equal(payload.unplayable_count, 2);
    assert.equal(payload.total_saved_tracks, 6);
    assert.deepEqual(payload.by_reason, { 'is_playable=false': 1, market: 1 });
    assert.match(text, /Unplayable saved tracks: 2\/6\./);
    assert.match(text, /• market: 1/);
  });
});

// ---------------------------------------------------------------------------
// 24. library_value_summary
// ---------------------------------------------------------------------------

describe('swarm3_library: library_value_summary (#761)', () => {
  it('adds up the walk once and every field agrees with it', async () => {
    const h = harness(FIXTURE);
    const { payload, text } = await h.invoke('library_value_summary', SCAN);

    assert.equal(payload.total_saved_tracks, 6);
    assert.equal(payload.total_saved_albums, 5);
    assert.equal(payload.total_runtime_ms, 1_245_000, '200+250+210+180+210+195 thousand ms');
    assert.deepEqual(payload.explicit, { count: 1, ratio: 1 / 6 });
    assert.equal(payload.local_files, 1);
    assert.equal(payload.unplayable, 2);
    assert.deepEqual(payload.collab, { tracks: 2, ratio: 2 / 6 });
    assert.deepEqual(payload.featuring, { tracks: 2, ratio: 2 / 6 });
    assert.deepEqual(payload.top_artists, [
      { artist: 'Nova', saved_tracks: 3 },
      { artist: 'Ember', saved_tracks: 2 },
      { artist: 'Iris', saved_tracks: 1 },
    ]);
    assert.deepEqual(payload.growth, {
      busiest_month: { month: '2026-02', adds: 3 },
      longest_streak_months: 3,
      current_streak_months: 3,
    });
    assert.deepEqual(payload.eras_by_runtime, [
      { decade: '2010s', runtime_ms: 660_000 },
      { decade: '1990s', runtime_ms: 375_000 },
    ]);
    assert.deepEqual(payload.top_album_decades, [
      { decade: '2010s', count: 2 },
      { decade: '1990s', count: 1 },
      { decade: '2020s', count: 1 },
    ]);
    assert.deepEqual(payload.hygiene, { duplicate_version_groups: 1, edition_lint_groups: 1 });
    assert.deepEqual(payload.longest_track, { name: 'Beacon (feat. Iris)', duration_ms: 250_000 });
    assert.deepEqual(payload.shortest_track, { name: 'Cinder', duration_ms: 180_000 });
    assert.equal(payload.scan_cap, 200);
    assert.match(text, /LIBRARY VALUE SUMMARY — 6 saved track\(s\) across 5 saved album\(s\) \(scan_cap=200\)/);
    assert.match(text, /Total runtime: 20:45;/);
    assert.match(text, /Hygiene: 1 duplicate-version group\(s\), 1 cross-edition album group\(s\)\./);
  });
});

// ---------------------------------------------------------------------------
// scanGate: the shared pre-flight behind every multi-walk scan
// ---------------------------------------------------------------------------

describe('swarm3_library: the shared scan gate (#761)', () => {
  it('a cooled-down client gets a blocked payload and zero requests', async () => {
    const registered: RegisteredTool[] = [];
    const client = {
      getRateLimitStatus: () => ({ cooldownRemainingMs: 30_000, requestsTotal: 0 }),
      get: () => {
        throw new Error('a blocked scan must issue no request');
      },
      getAllPages: () => {
        throw new Error('a blocked scan must walk nothing');
      },
    };
    const fakeServer = {
      tool(name: string, _desc: string, schema: z.ZodRawShape, handler: RegisteredTool['handler']) {
        registered.push({ name, schema, handler });
      },
    } as unknown as McpServer;
    registerSwarm3LibraryTools(fakeServer, client as unknown as SpotifyClient);

    const tool = registered.find((t) => t.name === 'library_value_summary');
    assert.ok(tool);
    const res = await tool.handler({ response_format: 'concise' } as Record<string, unknown>);

    assert.equal(res.structuredContent?.ok, false);
    assert.equal(res.structuredContent?.cooldown, true);
    assert.equal(res.structuredContent?.requests_made, 0);
    assert.equal(res.structuredContent?.wait_sec, 30);
    assert.match(res.content[0].text, /Rate-limit cooldown active/);
  });

  it('recent throttle pressure shrinks the walk and says the budget moved', async () => {
    const registered: RegisteredTool[] = [];
    const walks: number[] = [];
    const client = {
      // fetchAllCap is 500; 120 requests in the last minute leaves 380.
      getRateLimitStatus: () => ({ lastThrottleAt: Date.now(), requestsLastMinute: 120, requestsTotal: 7 }),
      get: () => null,
      getAllPages: (_p: string, _q: unknown, opts?: { maxItems?: number }) => {
        walks.push(opts?.maxItems ?? -1);
        return [];
      },
    };
    const fakeServer = {
      tool(name: string, _desc: string, schema: z.ZodRawShape, handler: RegisteredTool['handler']) {
        registered.push({ name, schema, handler });
      },
    } as unknown as McpServer;
    registerSwarm3LibraryTools(fakeServer, client as unknown as SpotifyClient);

    const tool = registered.find((t) => t.name === 'library_value_summary');
    assert.ok(tool);
    const res = await tool.handler({ scan_cap: 500, response_format: 'concise' } as Record<string, unknown>);

    assert.deepEqual(walks, [380, 380], 'both walks are held to the shrunk budget');
    assert.equal(res.structuredContent?.budget_shrunk, true);
    assert.equal(res.structuredContent?.requests_planned, 500, 'what was asked for is still reported');
    assert.equal(res.structuredContent?.scan_cap, 380, 'what was actually walked is reported too');
  });
});
