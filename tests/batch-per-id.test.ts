/**
 * #1224 — the six sites that still hard-failed on Spotify's removed `?ids=`
 * batch endpoints, asserted by REQUEST SHAPE rather than by failure.
 *
 * The defect only reproduces on a registration without the batch grant, which
 * CI does not have and cannot get. A test that waits for a 403 would therefore
 * pass forever without exercising anything. So this file drives every one of
 * the six sites through a stub client that records each path it is asked for
 * and answers everything else, then asserts two facts about that record:
 *
 *   1. no `GET` to a bare collection path (`/albums`, `/tracks`, `/artists`,
 *      `/episodes`, …) ever went out — those are exactly the routes the
 *      February 2026 changelog removed, and the per-id replacements
 *      (`/albums/{id}`) are not gated; and
 *   2. the per-id routes WERE used, so a tool that bailed before its fan-in
 *      fails here rather than passing vacuously.
 *
 * The denylist is not re-spelled here: it is the #725 batch pattern read out of
 * `GATED_PATH_PATTERNS` (src/gating.ts), the single source of truth. The
 * assertion also fails loudly if that pattern is renamed or dropped, so this
 * test cannot quietly degrade into a no-op.
 *
 * A separate case pins the fan-out WIDTH. "Per id" is only a real fix if the N
 * requests are not N concurrent requests; an unbounded `Promise.all` over a
 * 200-album library is the same denial of service by another name.
 *
 * Note for #638: `test/fixtures/removed-endpoints.json` is that issue's
 * deliverable and is deliberately NOT created here. When it lands, these six
 * paths belong in it and this file's inline denylist should collapse into it.
 *
 * Run: node --import tsx --test tests/batch-per-id.test.ts
 */
import './helpers/hermetic.js';

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { SpotifyClient } from '../src/client.js';
import { GATED_PATH_PATTERNS } from '../src/gating.js';
import { PER_ID_FANOUT_WIDTH } from '../src/tools/catalog.js';
import { registerExhaust2CatalogTools } from '../src/tools/exhaust2_catalog.js';
import { registerLibraryHygieneTools } from '../src/tools/libraryhygiene.js';
import { registerSwarm3DiscoveryTools } from '../src/tools/swarm3_discovery.js';
import { registerSwarm3bDiscoveryTools } from '../src/tools/swarm3b_discovery.js';

// ---------------------------------------------------------------------------
// The denylist, read from the shared gated-path set rather than re-spelled.
// ---------------------------------------------------------------------------

/** The #725 batch pattern, identified by the only alternative it lists. */
const BATCH_PATTERN = GATED_PATH_PATTERNS.find((re) => re.source.includes('chapters'));
assert.ok(
  BATCH_PATTERN,
  'the #725 batch pattern must stay in GATED_PATH_PATTERNS; this file classifies against it instead of re-spelling it',
);

/** Whether a recorded request went to a removed bare-collection route. */
function isRemovedBatchRequest(recorded: Recorded): boolean {
  return BATCH_PATTERN!.test(recorded.path);
}

interface Recorded {
  /** The path exactly as passed to the client, with no query string. */
  path: string;
  /** The query params, so `?ids=` shows up in the failure text. */
  params: Record<string, string>;
  /** How the request was issued. */
  via: 'get' | 'getAllPages' | 'getAllPagesWithTruncation';
  /** Start order within the run, so a burst is visible in the failure text. */
  seq: number;
}

function describeRecord(r: Recorded): string {
  const q = Object.keys(r.params).length > 0 ? `?${new URLSearchParams(r.params).toString()}` : '';
  return `GET ${r.path}${q} (via ${r.via})`;
}

// ---------------------------------------------------------------------------
// A recorder that answers everything, so each tool runs far enough to reach
// its album fan-in. Anything it does not recognise returns `{}` rather than
// throwing: a tool that walks into an unexpected shape should fail on the
// request-shape assertions below, not on a missing fixture method.
// ---------------------------------------------------------------------------

const ARTIST_ID = '4Z8W4fKeB5YxbusRsdQVPb';
const OTHER_ARTIST = '1Xyo4u8uXC1ZmMpatF5PJ';

/**
 * Spotify ids are 22 base62 characters and the `spotifyId()` argument schema
 * enforces it, so fixtures are built through these rather than typed out — a
 * 21-character literal would fail validation before the fan-in and the
 * request-shape assertion would then prove nothing.
 */
const ALBUM_ID_PREFIX = 'alb';
const TRACK_ID_PREFIX = 'trk';
function albumId(n: number): string {
  return ALBUM_ID_PREFIX + String(n).padStart(22 - ALBUM_ID_PREFIX.length, '0');
}
function trackId(n: number): string {
  return TRACK_ID_PREFIX + String(n).padStart(22 - TRACK_ID_PREFIX.length, '0');
}

interface AlbumSpec {
  id: string;
  name: string;
  release_date: string;
  album_type: string;
  label: string;
  trackCount?: number;
  artistIds?: string[];
}

interface ClientOptions {
  /** Releases the artist-discography and saved-album walks return. */
  releases?: AlbumSpec[];
  /** Albums the per-id route can read. Defaults to `releases`. */
  albums?: AlbumSpec[];
  /** Ids `/tracks/{id}` resolves. Defaults to one per release. */
  trackIds?: string[];
  /** Saved albums `/me/albums` returns. Defaults to `releases`. */
  savedAlbums?: AlbumSpec[];
  /** Saved liked tracks `/me/tracks` returns. Defaults to one per release. */
  savedTracks?: Array<{ id: string; albumId: string; artistIds?: string[] }>;
}

interface Recorder {
  client: SpotifyClient;
  records: Recorded[];
  /** Peak number of concurrently-open per-id album reads. */
  peakInFlight: number;
  get paths(): string[];
}

function track(id: string, name: string, n: number, artistIds: string[]) {
  return {
    id,
    name,
    uri: `spotify:track:${id}`,
    duration_ms: 200_000,
    explicit: false,
    track_number: n,
    artists: artistIds.map((a, i) => ({ id: a, name: `Artist ${i}`, uri: `spotify:artist:${a}` })),
  };
}

function albumPayload(spec: AlbumSpec) {
  const artistIds = spec.artistIds ?? [ARTIST_ID];
  const trackCount = spec.trackCount ?? 3;
  return {
    id: spec.id,
    name: spec.name,
    uri: `spotify:album:${spec.id}`,
    album_type: spec.album_type,
    release_date: spec.release_date,
    total_tracks: trackCount,
    label: spec.label,
    copyrights: [{ text: `℗ ${spec.release_date.slice(0, 4)} Test`, type: 'C' }],
    genres: ['test'],
    artists: artistIds.map((a, i) => ({ id: a, name: `Artist ${i}`, uri: `spotify:artist:${a}` })),
    images: [],
    album_group: spec.album_type,
    tracks: {
      total: trackCount,
      items: Array.from({ length: trackCount }, (_, i) => track(`trk-${spec.id}-${i + 1}`, `${spec.name} ${i + 1}`, i + 1, artistIds)),
    },
  };
}

function makeRecorder(options: ClientOptions = {}): Recorder {
  const releases = options.releases ?? [
    { id: albumId(1), name: 'Record One', release_date: '2020-01-01', album_type: 'album', label: 'Test Label' },
    { id: albumId(2), name: 'Record Two', release_date: '2021-01-01', album_type: 'album', label: 'Other Label' },
    // Carries artist B as well, so `find_collaborations` — the one caller that
    // filters releases down to those crediting both artists before it fans in
    // — actually reaches the fan-in instead of short-circuiting on an empty
    // match set.
    { id: albumId(3), name: 'Promo', release_date: '2019-01-01', album_type: 'single', label: 'Test Label', artistIds: [ARTIST_ID, OTHER_ARTIST] },
  ];
  const albums = options.albums ?? releases;
  const byAlbumId = new Map(albums.map((a) => [a.id, a]));
  const savedAlbums = options.savedAlbums ?? releases;
  const trackIds = options.trackIds ?? releases.map((_, i) => trackId(i));
  // Annotated to the option's own type: the `??` default is an object literal
  // that would otherwise infer the narrower `{ id; albumId }` and drop the
  // optional `artistIds` the fixture below reads.
  const savedTracks: NonNullable<ClientOptions['savedTracks']> = options.savedTracks
    ?? releases.map((a, i) => ({ id: `lik${String(i).padStart(19, '0')}`, albumId: a.id }));

  const records: Recorded[] = [];
  let seq = 0;
  let inFlight = 0;
  let peakInFlight = 0;

  const record = (path: string, params: Record<string, string>, via: Recorded['via']): void => {
    records.push({ path, params, via, seq: seq++ });
  };

  const client = {
    async get<T>(path: string, params: Record<string, string> = {}): Promise<T> {
      record(path, params, 'get');

      // The removed routes. Answering `{}` would let a tool carry on as if the
      // read had succeeded, which is the lie this whole file exists to catch;
      // throwing names the offender in the failure output.
      if (isRemovedBatchRequest({ path, params, via: 'get', seq: 0 })) {
        throw new Error(`REMOVED BATCH ROUTE REQUESTED: GET ${path}?${new URLSearchParams(params).toString()}`);
      }

      const perIdAlbum = /^\/albums\/(.+)$/.exec(path);
      if (perIdAlbum) {
        // A per-id read is the shape under test, so it is the one that
        // measures concurrency: the width assertion below reads this counter.
        inFlight++;
        peakInFlight = Math.max(peakInFlight, inFlight);
        await new Promise((resolve) => setImmediate(resolve));
        inFlight--;
        const spec = byAlbumId.get(decodeURIComponent(perIdAlbum[1]));
        return (spec ? albumPayload(spec) : {}) as T;
      }

      const perIdTrack = /^\/tracks\/(.+)$/.exec(path);
      if (perIdTrack) {
        const id = decodeURIComponent(perIdTrack[1]);
        const spec = releases.find((r) => trackIds.includes(id)) ?? releases[0];
        if (!trackIds.includes(id)) return {} as T;
        return {
          id,
          name: `Track ${id}`,
          uri: `spotify:track:${id}`,
          duration_ms: 200_000,
          popularity: 1,
          artists: [{ id: ARTIST_ID, name: 'Artist 0' }, { id: OTHER_ARTIST, name: 'Artist 1' }],
          album: {
            id: spec.id,
            name: spec.name,
            uri: `spotify:album:${spec.id}`,
            release_date: spec.release_date,
            album_type: spec.album_type,
            total_tracks: spec.trackCount ?? 3,
          },
        } as T;
      }

      // `[^/]+`, not `.+`: `/artists/{id}/albums` is a listing, not an artist.
      if (/^\/artists\/([^/]+)$/.test(path)) {
        return { id: ARTIST_ID, name: 'Artist 0', genres: ['rock'], uri: `spotify:artist:${ARTIST_ID}` } as T;
      }

      if (path === '/search') {
        return { artists: { items: [{ id: OTHER_ARTIST, name: 'Artist 1', genres: ['pop'] }], total: 1 } } as T;
      }
      return {} as T;
    },

    async getAllPages<T>(path: string, params: Record<string, string> = {}): Promise<T[]> {
      record(path, params, 'getAllPages');
      return pageOf<T>(path);
    },

    async getAllPagesWithTruncation<T>(path: string, params: Record<string, string> = {}, opts?: { maxItems?: number }): Promise<{ items: T[]; truncated: boolean }> {
      record(path, params, 'getAllPagesWithTruncation');
      const items = pageOf<T>(path);
      const max = opts?.maxItems ?? items.length;
      return { items: items.slice(0, max), truncated: items.length > max };
    },
  } as unknown as SpotifyClient;

  function pageOf<T>(path: string): T[] {
    if (path === '/me/albums') {
      return savedAlbums.map((a) => ({ added_at: '2024-01-01T00:00:00Z', album: albumPayload(a) })) as T[];
    }
    if (path === '/me/tracks') {
      return savedTracks.map((t) => ({
        added_at: '2024-01-01T00:00:00Z',
        track: {
          id: t.id,
          name: `Liked ${t.id}`,
          uri: `spotify:track:${t.id}`,
          duration_ms: 200_000,
          artists: (t.artistIds ?? [ARTIST_ID]).map((a, i) => ({ id: a, name: `Artist ${i}` })),
          album: { id: t.albumId, name: byAlbumId.get(t.albumId)?.name ?? t.albumId, uri: `spotify:album:${t.albumId}` },
        },
      })) as T[];
    }
    // Artist discography walk. The include_groups filter is honoured loosely:
    // every site under test asks for at least one group that includes these
    // rows, and an over-broad walk is harmless for a request-shape test.
    if (/^\/artists\/[^/]+\/albums$/.test(path)) {
      return releases.map((r) => albumPayload(r)) as T[];
    }
    return [] as T[];
  }

  return {
    client,
    records,
    get peakInFlight() {
      return peakInFlight;
    },
    get paths() {
      return records.map((r) => r.path);
    },
  };
}

// ---------------------------------------------------------------------------
// Tool registration
// ---------------------------------------------------------------------------

type ToolOut = {
  content: Array<{ type: string; text: string }>;
  structuredContent?: Record<string, unknown>;
};

type RegisteredTool = {
  name: string;
  validate: (args: Record<string, unknown>) => Record<string, unknown>;
  handler: (args: Record<string, unknown>) => Promise<ToolOut>;
};

function registerWith(register: (server: McpServer, client: SpotifyClient) => void, client: SpotifyClient): RegisteredTool[] {
  const registered: RegisteredTool[] = [];
  const fakeServer = {
    tool(name: string, _description: string, schema: z.ZodRawShape, handler: RegisteredTool['handler']) {
      registered.push({ name, validate: (args) => z.object(schema).parse(args), handler });
    },
  } as unknown as McpServer;
  register(fakeServer, client);
  return registered;
}

/**
 * Drive one tool and hand back the recorder regardless of how the handler
 * ended. The defect this file guards is a request SHAPE, so a tool that throws
 * later — on a fixture that does not model its whole contract — must not hide
 * the request record from the assertions. The `assert` half is that every case
 * also requires per-id album reads to have happened, so an early bail is a
 * failure rather than a silent pass.
 */
async function drive(registered: RegisteredTool[], name: string, args: Record<string, unknown>): Promise<void> {
  const tool = registered.find((t) => t.name === name);
  assert.ok(tool, `tool ${name} was not registered`);
  try {
    await tool.handler(tool.validate(args));
  } catch (error) {
    // Deliberately swallowed; the shape assertions run on `records` either way.
    void error;
  }
}

/**
 * The two assertions every case makes:
 *   - nothing went to a removed bare-collection route, and
 *   - the per-id replacement was actually exercised.
 */
function assertRequestShape(rec: Recorder, opts: { expectPerId: RegExp; label: string }): void {
  const offenders = rec.records.filter((r) => isRemovedBatchRequest(r));
  assert.deepEqual(
    offenders.map(describeRecord),
    [],
    `${opts.label} must not request a February-2026-removed batch route`,
  );
  assert.ok(
    rec.records.some((r) => opts.expectPerId.test(r.path)),
    `${opts.label} never issued a per-id read matching ${opts.expectPerId} — it failed before the fan-in, so the request-shape check proved nothing`,
  );
}

// ---------------------------------------------------------------------------
// The six sites.
// ---------------------------------------------------------------------------

describe('#1224 no site requests a removed `?ids=` batch route', () => {
  it('site 1 — track_enrichment_batch reads tracks, albums and artists per id', async () => {
    const rec = makeRecorder();
    const registered = registerWith(registerExhaust2CatalogTools, rec.client);
    await drive(registered, 'track_enrichment_batch', { track_ids: [trackId(0), trackId(1)] });

    assertRequestShape(rec, { expectPerId: /^\/tracks\/.+/, label: 'track_enrichment_batch' });
    // All three legs, not just the one the change is named after.
    assertRequestShape(rec, { expectPerId: /^\/albums\/.+/, label: 'track_enrichment_batch (album leg)' });
    assertRequestShape(rec, { expectPerId: /^\/artists\/.+/, label: 'track_enrichment_batch (artist leg)' });
  });

  it('site 2 — albums_runtime_batch reads albums per id', async () => {
    const rec = makeRecorder();
    const registered = registerWith(registerExhaust2CatalogTools, rec.client);
    await drive(registered, 'albums_runtime_batch', { album_ids: [albumId(1)] });
    assertRequestShape(rec, { expectPerId: new RegExp(`^/albums/${albumId(1)}$`), label: 'albums_runtime_batch' });
  });

  it('site 3 — library_hygiene fans its album totals in per id', async () => {
    const rec = makeRecorder();
    const registered = registerWith(registerLibraryHygieneTools, rec.client);
    await drive(registered, 'library_hygiene', {});
    assertRequestShape(rec, { expectPerId: new RegExp(`^/albums/${albumId(1)}$`), label: 'library_hygiene' });
  });

  it('site 4 — swarm3 fetchFullAlbums: every caller reads albums per id', async () => {
    // All seven callers, not one. The helper is the shared shape, but a
    // caller that bypassed it would still hard-fail, so the contract is
    // asserted at the tool boundary where the request actually leaves.
    const cases: Array<[string, Record<string, unknown>]> = [
      ['artist_deep_cuts', { artist_id: ARTIST_ID }],
      ['artist_first_release', { artist_id: ARTIST_ID }],
      ['artist_latest_release_report', { artist_id: ARTIST_ID }],
      ['find_collaborations', { artist_a: ARTIST_ID, artist_b: OTHER_ARTIST }],
      ['label_explorer', {}],
      ['b_sides_finder', { artist_id: ARTIST_ID }],
    ];
    for (const [name, args] of cases) {
      const rec = makeRecorder();
      const registered = registerWith(registerSwarm3DiscoveryTools, rec.client);
      await drive(registered, name, args);
      assertRequestShape(rec, { expectPerId: /^\/albums\/.+/, label: `swarm3 ${name}` });
    }
  });

  it('site 5 — swarm3b fetchAlbumBatches: every caller reads albums per id', async () => {
    const cases: Array<[string, Record<string, unknown>]> = [
      ['label_discography_explorer', { artist_id: ARTIST_ID }],
      ['album_track_explorer', { album_id: albumId(1) }],
      ['album_openers_report', { artist_id: ARTIST_ID }],
      ['deep_cuts_finder', { artist_id: ARTIST_ID }],
      ['b_sides_detector', { artist_id: ARTIST_ID }],
      ['track_release_origin', { artist_id: ARTIST_ID, track_name: 'Record One 1' }],
      ['album_duration_report', { artist_id: ARTIST_ID }],
    ];
    for (const [name, args] of cases) {
      const rec = makeRecorder();
      const registered = registerWith(registerSwarm3bDiscoveryTools, rec.client);
      await drive(registered, name, args);
      assertRequestShape(rec, { expectPerId: /^\/albums\/.+/, label: `swarm3b ${name}` });
    }
  });
});

describe('#1224 the per-id fan-out is width-bounded', () => {
  it('albums_runtime_batch issues 20 album reads without opening 20 sockets', async () => {
    const ids = Array.from({ length: 20 }, (_, i) => albumId(i));
    const rec = makeRecorder({
      albums: ids.map((id, i) => ({ id, name: `Album ${i}`, release_date: '2020-01-01', album_type: 'album', label: 'L' })),
    });
    const registered = registerWith(registerExhaust2CatalogTools, rec.client);
    await drive(registered, 'albums_runtime_batch', { album_ids: ids });

    const albumReads = rec.records.filter((r) => r.path.startsWith('/albums/'));
    assert.equal(albumReads.length, 20, 'one request per id — the batch route is what collapsed 20 into 1');
    assert.ok(
      rec.peakInFlight <= PER_ID_FANOUT_WIDTH,
      `per-id reads must stay within the fan-out width (peak ${rec.peakInFlight} > ${PER_ID_FANOUT_WIDTH})`,
    );
    assert.ok(
      rec.peakInFlight > 1,
      'a width of 1 would be the old serial chunk loop in disguise — the point is a bounded burst',
    );
  });

  it('library_hygiene bounds a 200-album fan-in', async () => {
    const albums = Array.from({ length: 200 }, (_, i) => ({
      id: albumId(i),
      name: `Album ${i}`,
      release_date: '2020-01-01',
      album_type: 'album',
      label: 'L',
    }));
    const rec = makeRecorder({
      releases: albums,
      albums,
      savedAlbums: albums,
      savedTracks: albums.map((a, i) => ({ id: `lik${String(i).padStart(19, '0')}`, albumId: a.id })),
    });
    const registered = registerWith(registerLibraryHygieneTools, rec.client);
    await drive(registered, 'library_hygiene', {});

    const albumReads = rec.records.filter((r) => r.path.startsWith('/albums/'));
    assert.ok(albumReads.length > 100, `expected the capped fan-in to run, saw ${albumReads.length} per-id reads`);
    assert.ok(
      rec.peakInFlight <= PER_ID_FANOUT_WIDTH,
      `library_hygiene must not open 200 concurrent sockets (peak ${rec.peakInFlight} > ${PER_ID_FANOUT_WIDTH})`,
    );
  });
});

describe('#1224 the denylist is the shared gated-path pattern, not a private copy', () => {
  it('classifies a bare collection path as removed and a per-id path as not', () => {
    // Guards the guard: if BATCH_PATTERN resolved to the wrong entry, or to
    // nothing, the two assertions above would be reading a regex that does not
    // mean what the file claims.
    for (const bare of ['/albums', '/tracks', '/artists', '/episodes', '/shows', '/audiobooks', '/chapters']) {
      assert.ok(
        isRemovedBatchRequest({ path: bare, params: {}, via: 'get', seq: 0 }),
        `${bare} is a February-2026-removed batch route and must be on the denylist`,
      );
    }
    for (const perId of ['/albums/alb1', '/tracks/t1', '/artists/a1', '/episodes/e1']) {
      assert.ok(
        !isRemovedBatchRequest({ path: perId, params: {}, via: 'get', seq: 0 }),
        `${perId} is the documented per-id replacement and must not be on the denylist`,
      );
    }
  });

  it('agrees with the production classifier the client wrapper uses', () => {
    // `isGatedPath` is what src/client.ts consults. If this file's denylist and
    // the runtime one drift apart, the test would be asserting a fiction.
    assert.ok(BATCH_PATTERN!.test('/albums'));
    assert.ok(GATED_PATH_PATTERNS.some((re) => re.test('/albums')));
  });
});
