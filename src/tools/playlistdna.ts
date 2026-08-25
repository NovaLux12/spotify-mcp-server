import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { SpotifyApiError, type SpotifyClient } from '../client.js';
import { getConfig } from '../config.js';
import {
  ResponseFormat,
  MaxResults,
  DryRun,
  resolveMaxResults,
  truncateItems,
} from '../shaping.js';
import type {
  PlaylistItemObject,
  PlaylistItemsResponse,
  SpotifyPaged,
  SpotifyPlaylistSimple,
  SpotifyTrack,
  SavedTrackItem,
} from '../types/spotify.js';

// ---------------------------------------------------------------------------
// Playlist DNA — grow_playlist (#112 idea 6)
//
// Co-occurrence curation built entirely from the user's own data (no
// recommendations endpoint, which was removed Feb-2026):
//   1. Page the target playlist fully → seed track IDs + seed artist-name
//      multiset (exact lowercase name match — genres are unavailable on any
//      Spotify surface this server may call).
//   2. Walk the user's OTHER playlists (/me/playlists paged → per-playlist
//      items pages, capped at getConfig().fetchAllCap) building an inverted
//      index trackId → playlists containing it.
//   3. Candidates = tracks in ≥2 other playlists that are not already in the
//      target and (when exclude_saved, default true) not in saved tracks
//      (/me/tracks pages, capped). Score = co-occurrence count, +2 bonus when
//      the track shares an artist name with any seed track.
//   4. Top `size` (5–50, default 20) rendered with score evidence.
//
// Read-only by design: the mutating add is deliberately NOT included. The
// response returns proposed URIs + reasons and instructs the agent to confirm
// with the user, then call add_to_playlist. dry_run is accepted for shape
// parity but there is nothing to preview — every call is a preview.
// ---------------------------------------------------------------------------

type TextContent = { type: 'text'; text: string };
type ToolResult = { content: TextContent[]; structuredContent?: Record<string, unknown> };

function shapeResult(
  rf: 'concise' | 'detailed' | 'json',
  prose: string,
  payload: Record<string, unknown>,
): ToolResult {
  return {
    content: [{ type: 'text', text: rf === 'json' ? JSON.stringify(payload, null, 2) : prose }],
    structuredContent: payload,
  };
}

/** Artist bonus added to the raw co-occurrence count. */
export const ARTIST_BONUS = 2;

/** One scored grow candidate. */
export interface DnaCandidate {
  track_id: string;
  uri: string;
  name: string;
  artists: string[];
  /** Co-occurrence count across other playlists (+ ARTIST_BONUS when applicable). */
  score: number;
  /** How many of your other playlists contain this track. */
  playlists: number;
  /** Seed-artist names this track shares (exact lowercase match), if any. */
  shared_seed_artists: string[];
}

type ItemRows = PlaylistItemsResponse['items'];

/** True when the playlist row nests an actual track (not an episode/null). */
function asTrack(row: PlaylistItemObject | null | undefined): SpotifyTrack | null {
  const playable = row?.item;
  if (!playable || !('artists' in playable) || !Array.isArray(playable.artists)) return null;
  return playable;
}

/** Seed extraction shared by the empty-seed guard and the scorer. */
function collectSeeds(rows: ItemRows): { ids: Set<string>; artists: Map<string, number> } {
  const ids = new Set<string>();
  const artists = new Map<string, number>(); // lowercase artist name → occurrences
  for (const row of rows) {
    const t = asTrack(row);
    if (!t?.id) continue;
    ids.add(t.id);
    for (const a of t.artists) {
      if (!a?.name) continue;
      const key = a.name.toLowerCase();
      artists.set(key, (artists.get(key) ?? 0) + 1);
    }
  }
  return { ids, artists };
}

export interface GrowPlanInput {
  targetId: string;
  targetName: string;
  targetItems: ItemRows;
  otherPlaylists: Array<{ id: string; name: string; items: ItemRows }>;
  /** Saved-track IDs when exclude_saved is on; null skips that filter. */
  savedTrackIds: ReadonlySet<string> | null;
  size: number;
}

export interface GrowPlan {
  targetId: string;
  targetName: string;
  seedTracks: number;
  seedArtists: string[];
  candidates: DnaCandidate[];
}

/**
 * Pure scoring core over pre-fetched pages so tests can drive fixtures
 * directly through the same code path the handler uses.
 */
export function buildGrowPlan(input: GrowPlanInput): GrowPlan {
  // 1. Seeds.
  const { ids: seedIds, artists: seedArtists } = collectSeeds(input.targetItems);

  // 2. Inverted index trackId → occurrence count over OTHER playlists only.
  const index = new Map<string, { count: number; track: SpotifyTrack }>();
  for (const pl of input.otherPlaylists) {
    for (const row of pl.items) {
      const t = asTrack(row);
      if (!t?.id) continue;
      let entry = index.get(t.id);
      if (!entry) {
        entry = { count: 0, track: t };
        index.set(t.id, entry);
      }
      entry.count += 1;
    }
  }

  // 3. Candidate filter + scoring.
  const candidates: DnaCandidate[] = [];
  for (const [trackId, { count, track }] of index) {
    if (count < 2) continue; // must co-occur in ≥2 other playlists
    if (seedIds.has(trackId)) continue; // already in the target
    if (input.savedTrackIds?.has(trackId)) continue; // already saved

    const artists = track.artists.map((a) => a.name);
    const shared = [...seedArtists.keys()].filter((seedArtist) =>
      artists.some((n) => n.toLowerCase() === seedArtist),
    );
    candidates.push({
      track_id: trackId,
      uri: `spotify:track:${trackId}`,
      name: track.name,
      artists,
      score: count + (shared.length > 0 ? ARTIST_BONUS : 0),
      playlists: count,
      shared_seed_artists: shared,
    });
  }

  // Deterministic order: score desc, then track id asc.
  candidates.sort((a, b) => b.score - a.score || a.track_id.localeCompare(b.track_id));

  return {
    targetId: input.targetId,
    targetName: input.targetName,
    seedTracks: seedIds.size,
    seedArtists: [...seedArtists.keys()].sort(),
    candidates: candidates.slice(0, input.size),
  };
}

/** Evidence phrase for one candidate: "in 3 of your playlists, shares artist "x" with seed". */
export function describeCandidate(c: DnaCandidate): string {
  let reason = `in ${c.playlists} of your playlists`;
  if (c.shared_seed_artists.length > 0) {
    reason += `, shares artist "${c.shared_seed_artists[0]}" with seed`;
    if (c.shared_seed_artists.length > 1) reason += ` (+${c.shared_seed_artists.length - 1} more)`;
  }
  return reason;
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

export function registerPlaylistDnaTools(server: McpServer, client: SpotifyClient): void {
  server.tool(
    'grow_playlist',
    'Propose tracks to grow one of your playlists using ONLY your own listening data (no recommendations): finds tracks appearing in >=2 of your OTHER playlists, boosts ones sharing an artist with the target playlist, excludes tracks already in it (and optionally your saved library), and returns top candidates with evidence. Read-only: review the proposals, then call add_to_playlist with the URIs you want.',
    {
      playlist_id: z.string().min(1).describe('Target playlist ID to grow'),
      size: z
        .number()
        .int()
        .min(5)
        .max(50)
        .optional()
        .describe('How many candidates to propose (default 20)'),
      exclude_saved: z
        .boolean()
        .optional()
        .describe('Skip tracks already in your saved library (default true)'),
      dry_run: DryRun,
      response_format: ResponseFormat,
      max_results: MaxResults,
    },
    async ({ playlist_id, size, exclude_saved, dry_run: _dryRun, response_format, max_results }) => {
      void _dryRun; // accepted for shape parity; every call is read-only anyway
      const rf = response_format;
      const take = size ?? 20;
      const cap = getConfig().fetchAllCap;

      // 1. Seeds: page the target playlist fully.
      const targetItems = await client.getAllPages<PlaylistItemObject>(
        `/playlists/${encodeURIComponent(playlist_id)}/items`,
        { limit: '100' },
      );
      const { ids: seedIds } = collectSeeds(targetItems);

      // Empty-seed edge: nothing to reason from — bail out before any walks.
      if (seedIds.size === 0) {
        return shapeResult(
          rf,
          `The target playlist has no tracks, so there is nothing to build DNA from. Add some tracks first, then run grow_playlist again.`,
          {
            tool: 'grow_playlist',
            target_playlist: { id: playlist_id },
            seeds: { tracks: 0, artists: [] },
            proposals: [],
          },
        );
      }

      // 2. Walk OTHER playlists. A lightweight probe records the user's real
      // playlist total first; the listing walk itself is capped at
      // fetchAllCap entries, so playlists past the cap are never indexed.
      const probe = await client.get<SpotifyPaged<SpotifyPlaylistSimple>>('/me/playlists', {
        limit: '1',
      });
      const rawTotal = typeof probe?.total === 'number' ? probe.total : null;
      const listings = await client.getAllPages<SpotifyPlaylistSimple>(
        '/me/playlists',
        { limit: '50' },
        { maxItems: cap },
      );
      const others = listings.filter((p) => p && p.id && p.id !== playlist_id);

      const walked: Array<{ id: string; name: string; items: ItemRows }> = [];
      let cappedWalk = false;
      let unreadable = 0;
      for (const pl of others) {
        if (walked.length >= cap) {
          cappedWalk = true;
          break;
        }
        // Collaborative/followed playlists the token cannot read items for
        // return 403 — skip them rather than failing the whole analysis.
        try {
          walked.push({
            id: pl.id,
            name: pl.name,
            items: await client.getAllPages<PlaylistItemObject>(
              `/playlists/${encodeURIComponent(pl.id)}/items`,
              { limit: '100' },
            ),
          });
        } catch (err) {
          if (err instanceof SpotifyApiError && err.status === 403) {
            unreadable++;
            continue;
          }
          throw err;
        }
      }
      if (rawTotal !== null && rawTotal > listings.length) cappedWalk = true;

      // 3a. Optional saved-library exclusion (capped walk).
      let savedTrackIds: Set<string> | null = null;
      const excludeSaved = exclude_saved ?? true;
      if (excludeSaved) {
        const saved = await client.getAllPages<SavedTrackItem>(
          '/me/tracks',
          { limit: '50' },
          { maxItems: cap },
        );
        savedTrackIds = new Set(
          saved.map((row) => row?.track?.id).filter((id): id is string => Boolean(id)),
        );
      }

      // 3b/4. Score via the pure core and take the top N.
      const plan = buildGrowPlan({
        targetId: playlist_id,
        targetName: '',
        targetItems,
        otherPlaylists: walked,
        savedTrackIds,
        size: take,
      });
      const proposals = plan.candidates;

      const view = truncateItems(proposals, resolveMaxResults(max_results));

      // 5. Render — read-only proposal, no mutation performed.
      const header =
        `Playlist DNA for ${playlist_id}: ${proposals.length} candidate(s) from ` +
        `${walked.length}${cappedWalk ? ` of ${others.length}` : ''} other playlist(s)` +
        `${excludeSaved ? `, excluding your saved tracks (${savedTrackIds!.size} scanned)` : ''}.\n`;
      const lines: string[] = [];
      for (let i = 0; i < view.items.length; i++) {
        const c = view.items[i];
        lines.push(`${i + 1}. ${c.name} — ${c.artists.join(', ')} [score ${c.score}]`);
        lines.push(`   ${c.uri} — ${describeCandidate(c)}`);
      }
      if (view.footer) lines.push(`(${view.footer})`);
      lines.push(
        'Read-only proposal — nothing was added. Confirm with the user, then call add_to_playlist with the URIs you want.',
      );

      return shapeResult(rf, header + lines.join('\n'), {
        tool: 'grow_playlist',
        target_playlist: { id: playlist_id },
        seeds: { tracks: plan.seedTracks, artists: plan.seedArtists },
        scanned: {
          playlists_total: rawTotal ?? others.length,
          playlists_walked: walked.length,
          walk_capped: cappedWalk,
          ...(excludeSaved ? { saved_tracks_scanned: savedTrackIds!.size } : {}),
        },
        total: proposals.length,
        returned: view.items.length,
        items: view.items,
        next_step: 'Confirm with the user, then call add_to_playlist with the chosen URIs.',
      });
    },
  );
}
