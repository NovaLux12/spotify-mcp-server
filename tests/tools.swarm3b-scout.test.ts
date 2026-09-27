/**
 * Regression: artist_scout_from_playlists scanned only the first 500 liked
 * tracks (#802). Any artist saved past offset 500 looked like a newcomer
 * because the membership check never read them.
 *
 * The fix binds the scan to SPOTIFY_MCP_FETCH_ALL_CAP (same family as
 * `walkSavedTracks` / `new_music_from_saved_artists` / `artist_collection_gaps`),
 * reads the truncation verdict from the shared getAllPagesWithTruncation
 * contract, and renames the verdict payload field to `not_in_scanned_library`
 * so the claim matches the evidence.
 *
 * Run: node --import tsx --test tests/tools.swarm3b-scout.test.ts
 */
import './helpers/hermetic.js';

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { SpotifyClient } from '../src/client.js';
import type { SavedTrackItem } from '../src/types/spotify.js';
import { initConfig } from '../src/config.js';
import { registerSwarm3bDiscoveryTools } from '../src/tools/swarm3b_discovery.js';

type ToolOut = {
  content: Array<{ type: string; text: string }>;
  structuredContent?: Record<string, unknown>;
};

type RegisteredTool = {
  name: string;
  validate: (args: Record<string, unknown>) => Record<string, unknown>;
  handler: (args: Record<string, unknown>) => Promise<ToolOut>;
};

interface FixtureOptions {
  /** Number of playlist rows; defaults to 1 (one playlist artist). */
  playlistRows?: number;
  /** Artist IDs attached to the playlist rows (one per row, in order). */
  playlistArtistIds?: string[];
  /** Total liked-track library rows to seed; defaults to the scan cap. */
  totalTracks?: number;
  /** Server-reported total for the /me/tracks walk. */
  tracksTotal?: number;
  /** Configured fetch-all cap (mirrors SPOTIFY_MCP_FETCH_ALL_CAP). */
  fetchAllCap?: number;
}

interface Harness {
  savedWalkCalls: number[];
  call: (name: string, args: Record<string, unknown>) => Promise<ToolOut>;
}

function makeHarness(options: FixtureOptions = {}): Harness {
  const fetchAllCap = options.fetchAllCap ?? 500;
  initConfig({ ...process.env, SPOTIFY_MCP_FETCH_ALL_CAP: String(fetchAllCap) });
  const savedWalkCalls: number[] = [];
  const totalTracks = options.totalTracks ?? fetchAllCap;
  const playlistArtistIds = options.playlistArtistIds ?? ['plist-art'];
  const playlistRows = options.playlistRows ?? playlistArtistIds.length;

  // Saved-tracks library: one row per liked track, newest first, each track
  // stamped with a unique artist id so the harness can target a specific
  // offset.
  const savedLibrary: SavedTrackItem[] = Array.from({ length: totalTracks }, (_, i) => ({
    added_at: new Date(2024, 0, 1, 0, 0, totalTracks - i).toISOString(),
    track: {
      id: `lib${i}`,
      uri: `spotify:track:lib${i}`,
      name: `Library Track ${i}`,
      artists: [{ id: `lib-art-${i}`, name: `Library Artist ${i}` }],
      duration_ms: 200_000,
    },
  }));

  // Playlist items: row i carries the artist id at index i (or the last id
  // when there are more rows than artists). The harness names the artist
  // IDs directly so callers can align them with library artist ids.
  const playlistItems = Array.from({ length: playlistRows }, (_, i) => {
    const id = playlistArtistIds[Math.min(i, playlistArtistIds.length - 1)];
    return {
      item: {
        id: `pl-row-${i}`,
        uri: `spotify:track:pl-row-${i}`,
        name: `Playlist Track ${i}`,
        artists: [{ id, name: `Playlist Artist ${id}` }],
      },
    };
  });

  const client = {
    async getAllPages<T>(path: string, _params?: Record<string, string>, opts?: { maxItems?: number }): Promise<T[]> {
      // The playlist walk uses the bare getAllPages — cap is playlist-local.
      if (path.includes('/items')) return playlistItems.slice(0, opts?.maxItems ?? playlistItems.length) as T[];
      // No other bare walks expected; return an empty array if asked.
      return [] as T[];
    },
    async getAllPagesWithTruncation<T>(path: string, _params?: Record<string, string>, opts?: { maxItems?: number }): Promise<{ items: T[]; truncated: boolean; truncatedByCap: boolean; reportedTotal: number | null }> {
      const maxItems = opts?.maxItems ?? fetchAllCap;
      if (path === '/me/tracks') {
        savedWalkCalls.push(maxItems);
        const slice = savedLibrary.slice(0, maxItems);
        const truncated = slice.length > maxItems
          || (options.tracksTotal !== undefined && slice.length < options.tracksTotal);
        return { items: slice as T[], truncated, truncatedByCap: truncated, reportedTotal: options.tracksTotal ?? savedLibrary.length };
      }
      throw new Error(`unexpected truncation walk ${path}`);
    },
  };

  const registered: RegisteredTool[] = [];
  const fakeServer = {
    tool(name: string, _description: string, schema: z.ZodRawShape, handler: RegisteredTool['handler']) {
      registered.push({ name, validate: (args) => z.object(schema).parse(args), handler });
    },
  } as unknown as McpServer;
  registerSwarm3bDiscoveryTools(fakeServer, client as SpotifyClient);

  return {
    savedWalkCalls,
    call: async (name: string, args: Record<string, unknown>) => {
      const tool = registered.find((t) => t.name === name);
      assert.ok(tool, `tool ${name} not registered`);
      return tool.handler(tool.validate(args));
    },
  };
}

describe('artist_scout_from_playlists scans the configured cap and discloses truncation (#802)', () => {
  it('reads the configured fetch-all cap, not a frozen 500', async () => {
    const h = makeHarness({ fetchAllCap: 1500, totalTracks: 1500 });
    await h.call('artist_scout_from_playlists', { playlist_id: '4uLU6hMCjMI75M1A2tKUQC' });
    assert.deepEqual(h.savedWalkCalls, [1500], 'saved-tracks walk must follow SPOTIFY_MCP_FETCH_ALL_CAP');
  });

  it('does not label any library artist as a newcomer when the scan covers all liked tracks (1200-track fixture, cap=1500)', async () => {
    // The regression: pre-fix, the scan was hard-capped at 500, so artists
    // saved at offset 501+ looked like newcomers. With a 1200-track library
    // and cap=1500, every artist in the library must be excluded from the
    // newcomer list.
    const libArtistIds = Array.from({ length: 1200 }, (_, i) => `lib-art-${i}`);
    const h = makeHarness({
      fetchAllCap: 1500,
      totalTracks: 1200,
      playlistArtistIds: libArtistIds,
      playlistRows: 1200,
    });
    const res = await h.call('artist_scout_from_playlists', { playlist_id: '4uLU6hMCjMI75M1A2tKUQC', max_artists: 50 });
    const payload = res.structuredContent!;
    const newcomers = payload.not_in_scanned_library as Array<{ artist_id: string }>;
    assert.equal(newcomers.length, 0, 'no artist present in the library may be reported as a newcomer');
    assert.equal(payload.library_scan_truncated, false);
    assert.equal(payload.library_scan_cap, 1500);
    assert.equal(payload.saved_tracks_scanned, 1200);
    assert.match(res.content[0]!.text, /compared against 1200 liked tracks, newest first/);
  });

  it('reports library_scan_truncated when the library outruns it (cap=500)', async () => {
    // 1200 liked tracks, scan cap 500. The walk hits the cap, the verdict
    // is true, and the prose names the scanned prefix so the caller can
    // not mistake the verdict for "compared against the whole library".
    const libArtistIds = Array.from({ length: 1200 }, (_, i) => `lib-art-${i}`);
    const h = makeHarness({
      fetchAllCap: 500,
      totalTracks: 1200,
      tracksTotal: 1200,
      playlistArtistIds: libArtistIds,
      playlistRows: 1200,
    });
    const res = await h.call('artist_scout_from_playlists', { playlist_id: '4uLU6hMCjMI75M1A2tKUQC', max_artists: 50 });
    const payload = res.structuredContent!;
    assert.equal(payload.library_scan_truncated, true, 'a 1200-track library under cap=500 must be disclosed as truncated');
    assert.equal(payload.library_scan_cap, 500);
    assert.equal(payload.saved_tracks_scanned, 500);
    assert.match(res.content[0]!.text, /TRUNCATED/);
    assert.match(res.content[0]!.text, /cap of 500/);
    assert.match(res.content[0]!.text, /first 500 liked tracks/);
  });

  it('renames the verdict field to not_in_scanned_library so the claim matches the evidence', async () => {
    const h = makeHarness({ fetchAllCap: 500, totalTracks: 50 });
    const res = await h.call('artist_scout_from_playlists', { playlist_id: '4uLU6hMCjMI75M1A2tKUQC' });
    const payload = res.structuredContent!;
    assert.ok(Array.isArray(payload.not_in_scanned_library), 'verdict field must be not_in_scanned_library');
    assert.equal(payload.items, undefined, 'legacy `items` field is removed in this v1->v2 breaking change');
  });

  it('reads the latest saved tracks first so the verdict is honest about which prefix was scanned', async () => {
    // When the scan is bounded, the prose must say "first N liked tracks"
    // — not "your saved tracks" — so a caller that did not pass scan_cap
    // does not believe the comparison reached the entire library.
    const h = makeHarness({ fetchAllCap: 500, totalTracks: 1200, tracksTotal: 1200 });
    const res = await h.call('artist_scout_from_playlists', { playlist_id: '4uLU6hMCjMI75M1A2tKUQC' });
    assert.match(res.content[0]!.text, /first 500 liked tracks/);
    assert.doesNotMatch(res.content[0]!.text, /compared against 500 liked tracks, newest first/, 'truncated prose must not sound complete');
  });
});