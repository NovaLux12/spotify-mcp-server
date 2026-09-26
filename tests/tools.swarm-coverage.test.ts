/**
 * Coverage for batch (100-chunk) and dry_run preview semantics across swarm slices.
 *
 * swarm3_library / swarm3_playback / swarm3_snapshots had no dedicated tests;
 * this file ensures their dry_run paths make zero mutating calls and that
 * batch writers fan out in groups of 100.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { SpotifyClient } from '../src/client.js';
import { initConfig } from '../src/config.js';
import { registerSwarm3LibraryTools } from '../src/tools/swarm3_library.js';
import { registerSwarm3PlaybackTools } from '../src/tools/swarm3_playback.js';
import { registerPlaylistBatchTools } from '../src/tools/playlistbatch.js';
import { registerSwarm3DiscoveryTools } from '../src/tools/swarm3_discovery.js';
import { registerSwarm3bDiscoveryTools } from '../src/tools/swarm3b_discovery.js';
import { registerSwarm3ShowsTools } from '../src/tools/swarm3_shows.js';
const STRICT_ARTIST_ID = 'artist1234567890123456';

type Registered = {
  name: string;
  description: string;
  schema: z.ZodRawShape | z.ZodType;
  handler: (args: Record<string, unknown>) => Promise<{ content: Array<{ type: string; text: string }>; structuredContent?: Record<string, unknown> }>;
};

function makeHarness(register: (s: McpServer, c: SpotifyClient) => void, responder: (path: string, body: unknown, method?: string) => unknown) {
  const registered: Registered[] = [];
  const calls: Array<{ method: string; path: string; arg?: unknown }> = [];
  const server = {
    tool(name: string, desc: string, schema: z.ZodRawShape, handler: Registered['handler']) {
      registered.push({ name, description: desc, schema, handler });
    },
    registerTool(name: string, config: { description?: string; inputSchema?: z.ZodType }, handler: Registered['handler']) {
      registered.push({ name, description: config.description ?? '', schema: config.inputSchema as unknown as z.ZodType, handler });
    },
  } as unknown as McpServer;
  const client = {
    calls,
    async get<T>(path: string, params?: Record<string, string>): Promise<T | null> {
      calls.push({ method: 'GET', path, arg: params });
      return responder(path, params, 'GET') as T | null;
    },
    async post<T>(path: string, body?: unknown): Promise<T | null> {
      calls.push({ method: 'POST', path, arg: body });
      return responder(path, body, 'POST') as T | null;
    },
    async put<T>(path: string, body?: unknown): Promise<T | null> {
      calls.push({ method: 'PUT', path, arg: body });
      return responder(path, body, 'PUT') as T | null;
    },
    async delete<T>(path: string, body?: unknown): Promise<T | null> {
      calls.push({ method: 'DELETE', path, arg: body });
      return responder(path, body, 'DELETE') as T | null;
    },
    async getAllPages<T>(path: string, params?: Record<string, string>, opts?: { maxItems?: number }): Promise<T[]> {
      // For dry_run paths this should not be reached; for non-dry_run we delegate to GET paging via responder
      const maxItems = opts?.maxItems ?? 500;
      const all: T[] = [];
      let offset = 0;
      for (;;) {
        const page = await (client as unknown as { get: (p: string, pr?: Record<string, string>) => Promise<{ items: T[]; total?: number; limit?: number; offset?: number; next?: string | null } | null> }).get(path, { ...params, offset: String(offset) });
        if (!page || !Array.isArray(page.items)) break;
        all.push(...page.items);
        if (all.length >= maxItems) return all.slice(0, maxItems);
        const limit = typeof (page as unknown as { limit?: number }).limit === 'number' && (page as unknown as { limit: number }).limit > 0 ? (page as unknown as { limit: number }).limit : page.items.length;
        offset += limit;
        if (page.items.length === 0 || page.items.length < limit) break;
        if (typeof (page as unknown as { total?: number }).total === 'number' && offset >= (page as unknown as { total: number }).total) break;
      }
      return all;
    },
  } as unknown as SpotifyClient & { calls: typeof calls };
  register(server, client);
  const find = (name: string) => {
    const t = registered.find((x) => x.name === name);
    assert.ok(t, `tool ${name} must be registered`);
    return t;
  };
  const invoke = async (name: string, args: Record<string, unknown>) => {
    const t = find(name);
    // Validate through schema when possible; library tools use raw shape, playback uses raw shape, playlistbatch uses ZodType
    if (t.schema && typeof (t.schema as z.ZodType).parse === 'function') {
      const parsed = (t.schema as z.ZodType).parse(args);
      return t.handler(parsed as Record<string, unknown>);
    }
    if (t.schema && typeof t.schema === 'object' && !('parse' in (t.schema as Record<string, unknown>))) {
      const parsed = z.object(t.schema as z.ZodRawShape).parse(args);
      return t.handler(parsed);
    }
    return t.handler(args);
  };
  return { registered, client: client as unknown as { calls: typeof calls }, find, invoke, text: (r: { content: Array<{ type: string; text: string }> }) => r.content[0].text };
}

describe('canonical list_show_episodes', () => {
  it('forwards offset and market and renders the episode page', async () => {
    const showId = 's'.repeat(22);
    const h = makeHarness(registerSwarm3ShowsTools, (path) => {
      assert.equal(path, `/shows/${showId}/episodes`);
      return {
        items: [{ name: 'Episode One', release_date: '2026-01-01', duration_ms: 1_800_000 }],
        total: 12,
        limit: 50,
      };
    });
    const out = await h.invoke('list_show_episodes', {
      show_id: showId,
      offset: 20,
      market: 'GB',
      response_format: 'json',
    });
    assert.deepEqual(h.client.calls[0]?.arg, { limit: '50', offset: '20', market: 'GB' });
    const payload = out.structuredContent as { ok: boolean; show_id: string; episodes: unknown[] };
    assert.equal(payload.ok, true);
    assert.equal(payload.show_id, showId);
    assert.equal(payload.episodes.length, 1);
  });
});

// swarm3_library — dry_run cost preview must not touch the network

describe('swarm3_library dry_run previews make zero API calls', () => {
  it('saved_vs_playlist_coverage dry_run previews cost without GETs', async () => {
    const h = makeHarness(registerSwarm3LibraryTools, () => {
      throw new Error('no API call expected during dry_run');
    });
    const out = await h.invoke('saved_vs_playlist_coverage', { dry_run: true, scan_cap: 100 });
    assert.equal(h.client.calls.length, 0, 'dry_run must not call any endpoint');
    assert.ok(out.structuredContent, 'structuredContent required');
    assert.equal((out.structuredContent as { dry_run: boolean }).dry_run, true);
    assert.match(h.text(out), /\[dry run\]/i);
  });

  it('orphaned_artist_check dry_run is zero-call', async () => {
    const h = makeHarness(registerSwarm3LibraryTools, () => { throw new Error('no call'); });
    const out = await h.invoke('orphaned_artist_check', { dry_run: true, scan_cap: 50 });
    assert.equal(h.client.calls.length, 0);
    assert.equal((out.structuredContent as { dry_run: boolean }).dry_run, true);
  });
});

// swarm3_playback — dry_run previews device plans without PUTs

describe('swarm3_playback dry_run previews', () => {
  it('apply_volume_plan dry_run returns plan lines without PUT', async () => {
    const h = makeHarness(registerSwarm3PlaybackTools, (path) => {
      if (path === '/me/player/devices') {
        return { devices: [{ id: 'd1', name: 'Speaker', type: 'Speaker', is_active: true, is_restricted: false, is_private_session: false, volume_percent: 30, supports_volume: true }] } as unknown;
      }
      if (path.startsWith('/me/player/volume')) return null as unknown;
      throw new Error(`unexpected GET ${path}`);
    });
    // apply_volume_plan dry_run defaults true — omit dry_run to exercise default
    const out = await h.invoke('apply_volume_plan', { volume: 42 } as Record<string, unknown>);
    const sc = out.structuredContent as { dry_run: boolean; steps: string[] };
    assert.equal(sc.dry_run, true);
    assert.ok(Array.isArray(sc.steps) && sc.steps.length === 1);
    // Must not have issued any PUT — only the GET /me/player/devices read
    assert.equal(h.client.calls.filter((c) => c.method === 'PUT').length, 0, 'dry_run must not PUT');
  });

  it('apply_volume_plan dry_run=false issues one PUT per device', async () => {
    const h = makeHarness(registerSwarm3PlaybackTools, (path) => {
      if (path === '/me/player/devices') {
        return { devices: [
          { id: 'd1', name: 'Speaker', type: 'Speaker', is_active: true, is_restricted: false, is_private_session: false, volume_percent: 30, supports_volume: true },
          { id: 'd2', name: 'Phone', type: 'Smartphone', is_active: false, is_restricted: false, is_private_session: false, volume_percent: 80, supports_volume: true },
        ] } as unknown;
      }
      if (path.startsWith('/me/player/volume')) return null as unknown;
      return null as unknown;
    });
    const out = await h.invoke('apply_volume_plan', { volume: 25, dry_run: false } as Record<string, unknown>);
    assert.equal(h.client.calls.filter((c) => c.method === 'PUT').length, 2);
    assert.match(h.text(out), /Volume set to 25%/);
  });
});

// batch — chunk at 100: 250 URIs → 3 POSTs (100/100/50)

describe('batch chunking at 100', () => {
  it('batch_add_to_playlist splits 250 unique source URIs into 100/100/50 POSTs', async () => {
    const targetPlaylistId = 'playlist12345678901234';
    const uris = Array.from({ length: 250 }, (_, i) => `spotify:track:${String(i).padStart(22, '0')}`);
    const h = makeHarness(registerPlaylistBatchTools, (path, _body, method) => {
      if (method === 'POST' && path.includes(`/playlists/${targetPlaylistId}/items`)) return { snapshot_id: 'snap' } as unknown;
      // GET /playlists/{id}/items pages — return empty so dedupe against existing adds nothing
      if (path.includes(`/playlists/${targetPlaylistId}/items`)) return { items: [], total: 0, limit: 100, offset: 0, next: null } as unknown;
      return { items: [], total: 0, limit: 100, offset: 0, next: null } as unknown;
    });
    const previousConfirm = process.env.SPOTIFY_MCP_CONFIRM;
    process.env.SPOTIFY_MCP_CONFIRM = 'never';
    try {
      const out = await h.invoke('batch_add_to_playlist', { target_playlist_id: targetPlaylistId, source_uris: uris });
      const posts = h.client.calls.filter((c) => c.method === 'POST' && c.path.includes(`/playlists/${targetPlaylistId}/items`));
      assert.equal(posts.length, 3, '250 tracks must fan out into 3 POSTs');
      const batchSizes = posts.map((post) => {
        if (!post.arg || typeof post.arg !== 'object' || !('uris' in post.arg) || !Array.isArray(post.arg.uris)) {
          throw new Error('batch POST did not include a URI array');
        }
        return post.arg.uris.length;
      });
      assert.deepEqual(batchSizes, [100, 100, 50]);
      assert.match(h.text(out), /across 3 batch/);
    } finally {
      if (previousConfirm === undefined) delete process.env.SPOTIFY_MCP_CONFIRM;
      else process.env.SPOTIFY_MCP_CONFIRM = previousConfirm;
    }
  });

  it('batch_add_to_playlist dry_run with 250 URIs makes zero POSTs', async () => {
    const targetPlaylistId = 'playlist12345678901234';
    const uris = Array.from({ length: 250 }, (_, i) => `spotify:track:${String(i).padStart(22, '0')}`);
    const h = makeHarness(registerPlaylistBatchTools, (path) => {
      if (path.includes(`/playlists/${targetPlaylistId}/items`)) return { items: [], total: 0, limit: 100, offset: 0, next: null } as unknown;
      return null as unknown;
    });
    const out = await h.invoke('batch_add_to_playlist', { target_playlist_id: targetPlaylistId, source_uris: uris, dry_run: true });
    assert.equal(h.client.calls.filter((c) => c.method === 'POST').length, 0);
    assert.match(h.text(out), /\[dry run\]/);
  });
});

describe('swarm3b max_results stays consistent across prose and structured output', () => {
  it('artist_discography_explorer caps releases at max_results', async () => {
    const albums = Array.from({ length: 3 }, (_, i) => ({
      id: `release-${i}`,
      name: `Release ${i}`,
      release_date: `202${i}-01-01`,
      album_type: 'album',
      total_tracks: 1,
      artists: [{ id: 'artist-1', name: 'Artist One' }],
    }));
    const artistId = STRICT_ARTIST_ID;
    const h = makeHarness(registerSwarm3bDiscoveryTools, (path) => {
      if (path === `/artists/${artistId}`) return { id: artistId, name: 'Artist One', genres: [] } as unknown;
      if (path === `/artists/${artistId}/albums`) return { items: albums, total: albums.length, limit: 50, offset: 0, next: null } as unknown;
      throw new Error(`unexpected path ${path}`);
    });
    const out = await h.invoke('artist_discography_explorer', { artist: artistId, max_results: 2 });
    const payload = out.structuredContent as { releases: unknown[]; pagination: { returned: number } };
    assert.equal(payload.releases.length, 2);
    assert.equal(payload.pagination.returned, 2);
    assert.equal(h.text(out).split('\n').filter((line) => /^\d{4} ·/.test(line)).length, 2);
    assert.match(h.text(out), /1 more/);
  });

  it('artist_reissue_detector caps prose groups and structured items together', async () => {
    const albums = Array.from({ length: 12 }, (_, i) => [
      { id: `live-${i}`, name: `Album ${i} (Live)`, release_date: `202${i % 10}-01-01`, album_type: 'album', total_tracks: 1 },
      { id: `studio-${i}`, name: `Album ${i} (Remastered)`, release_date: `202${i % 10}-02-01`, album_type: 'album', total_tracks: 1 },
    ]).flat();
    const h = makeHarness(registerSwarm3bDiscoveryTools, (path) => {
      if (path === `/artists/${STRICT_ARTIST_ID}/albums`) return { items: albums, total: albums.length, limit: 50, offset: 0, next: null } as unknown;
      throw new Error(`unexpected path ${path}`);
    });
    const out = await h.invoke('artist_reissue_detector', { artist_id: STRICT_ARTIST_ID, max_results: 5 });
    const payload = out.structuredContent as { items: unknown[]; pagination: { total: number; returned?: number } };
    assert.equal(payload.items.length, 5);
    assert.equal(payload.pagination.total, 12);
    assert.equal(payload.pagination.total - payload.items.length, 7);
    assert.equal(h.text(out).split('\n').filter((line) => /^\d+× /.test(line)).length, 5);
    assert.match(h.text(out), /7 more/);
  });

  it('album_openers_report exposes and honors max_results', async () => {
    const albums = Array.from({ length: 3 }, (_, i) => ({ id: `album-${i}`, name: `Album ${i}`, release_date: `202${i}-01-01`, album_type: 'album', total_tracks: 1 }));
    const full = albums.map((a) => ({ ...a, tracks: { items: [{ id: `track-${a.id}`, name: `Track ${a.name}`, track_number: 1, duration_ms: 1000 }], total: 1 } }));
    const h = makeHarness(registerSwarm3bDiscoveryTools, (path) => {
      if (path === `/artists/${STRICT_ARTIST_ID}/albums`) return { items: albums, total: albums.length, limit: 50, offset: 0, next: null } as unknown;
      if (path === '/albums') return { albums: full } as unknown;
      throw new Error(`unexpected path ${path}`);
    });
    const out = await h.invoke('album_openers_report', { artist_id: STRICT_ARTIST_ID, max_results: 2 });
    const payload = out.structuredContent as { items: unknown[]; total: number; returned: number; withheld: number };
    assert.equal(payload.items.length, 2);
    assert.equal(payload.total, 3);
    assert.equal(payload.returned, 2);
    assert.equal(payload.withheld, 1);
    assert.equal(h.text(out).split('\n').filter((line) => /^\d{4} ·/.test(line)).length, 2);
    assert.match(h.text(out), /showing 2 of 3/);
    assert.match(h.text(out), /1 withheld/);
  });
});

describe('swarm3b timeline and anniversary edge cases', () => {
  it('artist_singles_timeline emits no dead gap fields', async () => {
    const singles = [
      { id: 'single-1', name: 'Single One', release_date: '2023-01-01', album_type: 'single', total_tracks: 1 },
      { id: 'single-2', name: 'Single Two', release_date: '2023-02-01', album_type: 'single', total_tracks: 1 },
      { id: 'single-3', name: 'Single Three', release_date: '2023-03-01', album_type: 'single', total_tracks: 1 },
    ];
    const h = makeHarness(registerSwarm3bDiscoveryTools, (path) => {
      if (path === `/artists/${STRICT_ARTIST_ID}/albums`) return { items: singles, total: singles.length, limit: 50, offset: 0, next: null } as unknown;
      throw new Error(`unexpected path ${path}`);
    });
    const out = await h.invoke('artist_singles_timeline', { artist_id: STRICT_ARTIST_ID });
    const payload = out.structuredContent as { items: Array<Record<string, unknown>> };
    assert.equal(payload.items.length, 3);
    for (const item of payload.items) {
      assert.equal('gap_display' in item, false);
      assert.equal('gap_days_since_previous' in item, false);
    }
    assert.doesNotMatch(h.text(out), /gap/i);
  });

  async function withFixedDate<T>(iso: string, fn: () => Promise<T>): Promise<T> {
    const RealDate = globalThis.Date;
    const fixedMs = new RealDate(iso).getTime();
    class FixedDate extends RealDate {
      constructor(value?: string | number) {
        super(value === undefined ? fixedMs : value);
      }
      static now(): number {
        return fixedMs;
      }
    }
    globalThis.Date = FixedDate as unknown as DateConstructor;
    try {
      return await fn();
    } finally {
      globalThis.Date = RealDate;
    }
  }

  it('album_anniversary_check clamps leap-day anniversaries in a non-leap year', async () => {
    const album = { id: 'leap-album', name: 'Leap Album', release_date: '2024-02-29', album_type: 'album', total_tracks: 1 };
    const h = makeHarness(registerSwarm3bDiscoveryTools, (path) => {
      if (path === `/artists/${STRICT_ARTIST_ID}/albums`) return { items: [album], total: 1, limit: 50, offset: 0, next: null } as unknown;
      throw new Error(`unexpected path ${path}`);
    });
    const out = await withFixedDate('2025-01-15', () => h.invoke('album_anniversary_check', { artist_id: STRICT_ARTIST_ID, window_days: 365 }));
    const payload = out.structuredContent as { items: Array<{ anniversary_date: string; days_until: number; date_adjusted: boolean }> };
    assert.equal(payload.items.length, 1);
    assert.equal(payload.items[0].anniversary_date, '2025-02-28');
    assert.equal(payload.items[0].date_adjusted, true);
    assert.ok(Number.isFinite(payload.items[0].days_until));
  });

  it('album_anniversary_check revalidates a passed leap-day date', async () => {
    const album = { id: 'leap-album', name: 'Leap Album', release_date: '2024-02-29', album_type: 'album', total_tracks: 1 };
    const h = makeHarness(registerSwarm3bDiscoveryTools, (path) => {
      if (path === `/artists/${STRICT_ARTIST_ID}/albums`) return { items: [album], total: 1, limit: 50, offset: 0, next: null } as unknown;
      throw new Error(`unexpected path ${path}`);
    });
    const out = await withFixedDate('2024-03-01', () => h.invoke('album_anniversary_check', { artist_id: STRICT_ARTIST_ID, window_days: 365 }));
    const payload = out.structuredContent as { items: Array<{ anniversary_date: string; days_until: number; date_adjusted: boolean }> };
    assert.equal(payload.items.length, 1);
    assert.equal(payload.items[0].anniversary_date, '2025-02-28');
    assert.equal(payload.items[0].date_adjusted, true);
    assert.ok(Number.isFinite(payload.items[0].days_until));
  });
});

describe('swarm3 release radars account for per-artist probe failures', () => {
  it('new_music_from_saved_artists returns successful probes and names failures', async () => {
    const artists = Array.from({ length: 5 }, (_, i) => ({ id: `artist-${i}`, name: `Artist ${i}` }));
    const h = makeHarness(registerSwarm3bDiscoveryTools, (path) => {
      if (path === '/me/following') return { artists: { items: artists, cursors: { after: null }, next: null } } as unknown;
      const match = path.match(/^\/artists\/(artist-\d+)\/albums$/);
      if (match) {
        if (match[1] === 'artist-2') throw new Error('429 probe failure');
        return { items: [{ id: `${match[1]}-release`, name: 'New Release', release_date: '2026-01-01', album_type: 'single' }] } as unknown;
      }
      throw new Error(`unexpected path ${path}`);
    });
    const out = await h.invoke('new_music_from_saved_artists', { artist_limit: 5, include_saved_album_artists: false });
    const payload = out.structuredContent as { items: unknown[]; artists_probed: number; artists_failed: number; probe_failures: Array<{ name: string }> };
    assert.equal(payload.items.length, 4);
    assert.equal(payload.artists_probed, 4);
    assert.equal(payload.artists_failed, 1);
    assert.equal(payload.artists_probed + payload.artists_failed, artists.length);
    assert.equal(payload.probe_failures[0]?.name, 'Artist 2');
    assert.match(h.text(out), /Artist 2/);
  });

  it('artistwatch_new_additions excludes failed artists from quiet results', async () => {
    const artists = Array.from({ length: 10 }, (_, i) => ({ id: `artist-${i}`, name: `Artist ${i}` }));
    const h = makeHarness(registerSwarm3DiscoveryTools, (path) => {
      if (path === '/me/following') return { artists: { items: artists, cursors: { after: null }, next: null } } as unknown;
      const match = path.match(/^\/artists\/(artist-\d+)\/albums$/);
      if (match) {
        if (match[1] === 'artist-1' || match[1] === 'artist-5') throw new Error('403 probe failure');
        return { items: [] } as unknown;
      }
      throw new Error(`unexpected path ${path}`);
    });
    const out = await h.invoke('artistwatch_new_additions', { artists_cap: 10 });
    const payload = out.structuredContent as { artists_probed: number; artists_failed: number; quiet_count: number; probe_failures: Array<{ name: string }> };
    assert.equal(payload.artists_probed, 8);
    assert.equal(payload.artists_failed, 2);
    assert.equal(payload.quiet_count, 8);
    assert.equal(payload.artists_probed + payload.artists_failed, artists.length);
    assert.deepEqual(payload.probe_failures.map((failure) => failure.name), ['Artist 1', 'Artist 5']);
    assert.match(h.text(out), /Artist 1/);
  });
  it('new_music_from_top_artists keeps failed probes out of quiet artists', async () => {
    const artists = Array.from({ length: 3 }, (_, i) => ({ id: `artist-${i}`, name: `Artist ${i}`, genres: [] }));
    const h = makeHarness(registerSwarm3DiscoveryTools, (path) => {
      if (path === '/me/top/artists') return { items: artists } as unknown;
      const match = path.match(/^\/artists\/(artist-\d+)\/albums$/);
      if (match) {
        if (match[1] === 'artist-1') throw new Error('429 probe failure');
        return { items: [] } as unknown;
      }
      throw new Error(`unexpected path ${path}`);
    });
    const out = await h.invoke('new_music_from_top_artists', { artists_cap: 3 });
    const payload = out.structuredContent as { artists_probed: number; artists_failed: number; quiet: unknown[]; probe_failures: Array<{ name: string }> };
    assert.equal(payload.artists_probed, 2);
    assert.equal(payload.artists_failed, 1);
    assert.equal(payload.quiet.length, 2);
    assert.equal(payload.artists_probed + payload.artists_failed, artists.length);
    assert.equal(payload.probe_failures[0]?.name, 'Artist 1');
  });
});

// ---------------------------------------------------------------------------
// swarm3_discovery — #816 (b_sides_finder cap basis) and #817 (market on the wire)
// ---------------------------------------------------------------------------

const ALBUM_UNDER_TEST = 'album12345678901234567';
const ALBUM_PATH = `/albums/${ALBUM_UNDER_TEST}`;
const ALBUM_TRACKS_PATH = `${ALBUM_PATH}/tracks`;

/**
 * Album market stub. The payload the stub hands back is chosen from the
 * `market` param the client actually put on the wire, so a tool that drops
 * the declared market shows up as the wrong *content*, not just a missing
 * call-log key.
 */
function marketAlbumResponder(): (path: string, body: unknown) => unknown {
  const gbTracks = (n: number) =>
    Array.from({ length: n }, (_, i) => ({
      id: `track-gb-${i}`,
      uri: `spotify:track:track-gb-${i}`,
      name: `Cherry Lane ${i + 1}`,
      track_number: i + 1,
      duration_ms: 200_000 + i * 1_000,
    }));
  return (path, body) => {
    const params = (body ?? {}) as Record<string, string>;
    const gb = params.market === 'GB';
    if (path === ALBUM_PATH) {
      return {
        id: ALBUM_UNDER_TEST,
        uri: `spotify:album:${ALBUM_UNDER_TEST}`,
        name: gb ? 'Record (GB edition)' : 'Record (token-market edition)',
        release_date: '2011-04-11',
        album_type: 'album',
        artists: [],
        label: 'Label',
        // total far above items.length so the paged tracks walk always runs.
        tracks: { total: 60, items: gbTracks(gb ? 2 : 1) },
      };
    }
    if (path === ALBUM_TRACKS_PATH) {
      const n = gb ? 2 : 1;
      return { items: gbTracks(n), limit: n, total: n, offset: Number(params.offset ?? 0) };
    }
    throw new Error(`unexpected path ${path}`);
  };
}

/** album_focus_report nests the count under `stats`; the two plans keep it flat. */
function trackCount(payload: Record<string, unknown> | undefined): number | undefined {
  const stats = payload?.stats as { track_count?: number } | undefined;
  return (payload?.track_count as number | undefined) ?? stats?.track_count;
}

for (const tool of ['album_representative_plan', 'front_to_back_plan', 'album_focus_report'] as const) {
  it(`${tool} puts the declared market on the wire (#817)`, async () => {
    const h = makeHarness(registerSwarm3DiscoveryTools, marketAlbumResponder());
    const out = await h.invoke(tool, { album_id: ALBUM_UNDER_TEST, market: 'GB' });

    const albumCall = h.client.calls.find((c) => c.path === ALBUM_PATH);
    assert.ok(albumCall, `${tool} must request the album payload`);
    assert.equal((albumCall.arg as Record<string, string>).market, 'GB');
    const tracksCall = h.client.calls.find((c) => c.path === ALBUM_TRACKS_PATH);
    assert.ok(tracksCall, `${tool} must page the remaining album tracks`);
    assert.equal((tracksCall.arg as Record<string, string>).market, 'GB');

    // The GB tracklist, not the token-market one — proof the request carried it.
    assert.equal(trackCount(out.structuredContent), 2);
    assert.match(h.text(out), /Cherry Lane 1/);
  });

  it(`${tool} omits market entirely when the argument is absent (#817)`, async () => {
    const h = makeHarness(registerSwarm3DiscoveryTools, marketAlbumResponder());
    const out = await h.invoke(tool, { album_id: ALBUM_UNDER_TEST });

    for (const call of h.client.calls) {
      const params = (call.arg ?? {}) as Record<string, string>;
      assert.equal('market' in params, false, `${call.path} must not carry a market key`);
    }
    assert.equal(trackCount(out.structuredContent), 1);
  });
}

/** 40 album-group releases and 25 single/compilation releases for one artist. */
function discography(albums: number, sides: number): (path: string, body: unknown) => unknown {
  const core = Array.from({ length: albums }, (_, i) => ({
    id: `core${i}`, name: `Core ${i}`, release_date: `20${String(10 + (i % 15)).padStart(2, '0')}-01-01`,
    album_type: 'album', album_group: 'album', total_tracks: 1,
  }));
  const side = Array.from({ length: sides }, (_, i) => ({
    id: `side${i}`, name: `Side ${i}`, release_date: `20${String(10 + (i % 15)).padStart(2, '0')}-02-01`,
    album_type: 'single', album_group: 'single', total_tracks: 1,
  }));
  return (path, body) => {
    const params = (body ?? {}) as Record<string, string>;
    if (path === `/artists/${STRICT_ARTIST_ID}/albums`) {
      const items = params.include_groups === 'album' ? core : side;
      return { items, limit: 50, total: items.length };
    }
    if (path === '/albums') {
      const ids = (params.ids ?? '').split(',').filter(Boolean);
      return {
        albums: ids.map((id) => ({
          id,
          name: `Release ${id}`,
          // Core releases carry "Alpha"; only the sides carry a non-core title.
          tracks: {
            total: 1,
            items: [{
              id: `tr-${id}`, uri: `spotify:track:tr-${id}`,
              name: id.startsWith('core') ? 'Alpha' : 'Beta',
              track_number: 1, duration_ms: 180_000,
            }],
          },
        })),
      };
    }
    throw new Error(`unexpected path ${path}`);
  };
}

describe('b_sides_finder reports the walk ceiling, not the selection size (#816)', () => {
  it('calls a complete 40-album / 25-side walk uncapped at the default max_per_group', async () => {
    initConfig({ ...process.env, SPOTIFY_MCP_FETCH_ALL_CAP: '500' });
    try {
      const h = makeHarness(registerSwarm3DiscoveryTools, discography(40, 25));
      const out = await h.invoke('b_sides_finder', { artist_id: STRICT_ARTIST_ID });
      const p = out.structuredContent as {
        truncated_by_cap: boolean;
        groups_selected: { core: number; side: number };
        core_releases_scanned: number;
        side_releases_scanned: number;
        b_sides: unknown[];
      };
      assert.equal(p.truncated_by_cap, false, 'a complete walk must not claim truncation');
      assert.deepEqual(p.groups_selected, { core: 30, side: 25 });
      // "scanned" is the walk, not the selection: 40 albums were read, 30 fanned in.
      assert.equal(p.core_releases_scanned, 40);
      assert.equal(p.side_releases_scanned, 25);
      assert.equal(p.b_sides.length, 25);
    } finally {
      initConfig();
    }
  });

  it('flips truncated_by_cap when the walk itself hits the fetch-all ceiling', async () => {
    initConfig({ ...process.env, SPOTIFY_MCP_FETCH_ALL_CAP: '20' });
    try {
      const h = makeHarness(registerSwarm3DiscoveryTools, discography(40, 25));
      const out = await h.invoke('b_sides_finder', { artist_id: STRICT_ARTIST_ID });
      const p = out.structuredContent as {
        truncated_by_cap: boolean;
        core_releases_scanned: number;
        side_releases_scanned: number;
      };
      assert.equal(p.truncated_by_cap, true, 'a walk stopped at the ceiling must say so');
      assert.equal(p.core_releases_scanned, 20, 'walk-size field must show the ceiling');
      assert.equal(p.side_releases_scanned, 20);
    } finally {
      initConfig();
    }
  });

  it('is independent of max_per_group', async () => {
    initConfig({ ...process.env, SPOTIFY_MCP_FETCH_ALL_CAP: '500' });
    try {
      const narrow = makeHarness(registerSwarm3DiscoveryTools, discography(40, 25));
      const wide = makeHarness(registerSwarm3DiscoveryTools, discography(40, 25));
      const a = (await narrow.invoke('b_sides_finder', { artist_id: STRICT_ARTIST_ID, max_per_group: 5 }))
        .structuredContent as { truncated_by_cap: boolean; groups_selected: { core: number }; core_releases_scanned: number };
      const b = (await wide.invoke('b_sides_finder', { artist_id: STRICT_ARTIST_ID, max_per_group: 60 }))
        .structuredContent as { truncated_by_cap: boolean; groups_selected: { core: number }; core_releases_scanned: number };
      assert.equal(a.truncated_by_cap, false);
      assert.equal(b.truncated_by_cap, false);
      assert.equal(a.groups_selected.core, 5, 'selection honours max_per_group');
      assert.equal(b.groups_selected.core, 40, 'selection honours max_per_group');
      // The walk is the same either way; only the selection moves.
      assert.equal(a.core_releases_scanned, 40);
      assert.equal(b.core_releases_scanned, 40);
    } finally {
      initConfig();
    }
  });
});
