/**
 * Album completion & consolidation hygiene (#112 idea 5).
 *
 * Read-only analysis over the user's liked (/me/tracks) library:
 *   • NEAR-COMPLETE ALBUMS — albums where 70%–99% of the tracks are already
 *     liked; suggest saving the whole album (and optionally unliking the
 *     individually saved tracks, which become redundant).
 *   • ORPHANED SINGLES — standalone singles where nothing else from the same
 *     release or the same artist is liked; reported at LOW confidence because
 *     a lone single may be perfectly intentional.
 *
 * The tool never mutates anything: suggestions are rendered as prose only.
 */
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { SpotifyClient } from '../client.js';
import type { SavedTrackItem, SpotifyAlbumFull } from '../types/spotify.js';
import {
  ResponseFormat,
  MaxResults,
  resolveMaxResults,
  truncateItems,
} from '../shaping.js';
import type { ResponseFormatValue } from '../shaping.js';
import { getConfig } from '../config.js';

/** Hard cap on distinct GET /albums/{id} lookups per analysis run (#112 idea 5). */
export const ALBUM_LOOKUP_CAP = 200;

/** Coverage ratio at which an album counts as near-complete (inclusive). */
export const NEAR_COMPLETE_THRESHOLD = 0.7;

// ---------------------------------------------------------------------------
// Shapes
// ---------------------------------------------------------------------------

interface LikedTrackRef {
  id: string;
  name: string;
  uri: string;
}

/** All liked tracks sharing one parent album. */
export interface AlbumGroup {
  album_id: string;
  album_name: string;
  album_uri: string;
  /** From the simplified track.album object; null until an album lookup fills it. */
  album_type: string | null;
  artist_ids: string[];
  artist_names: string[];
  liked_count: number;
  liked_tracks: LikedTrackRef[];
  /** Filled from GET /albums/{id}; null when no lookup was made (cap/skip). */
  total_tracks: number | null;
  /** liked_count / total_tracks once known. */
  coverage: number | null;
}

export interface NearCompleteFinding {
  kind: 'near_complete_album';
  album_id: string;
  album_name: string;
  album_uri: string;
  artist_names: string[];
  liked_count: number;
  total_tracks: number;
  /** liked/total, in [0.7, 1.0). */
  coverage: number;
  confidence: 'high';
  suggestion: string;
}

export interface OrphanedSingleFinding {
  kind: 'orphaned_single';
  track_id: string;
  track_name: string;
  track_uri: string;
  artist_names: string[];
  album_id: string;
  album_name: string;
  confidence: 'low';
  reason: string;
}

interface AnalysisResult {
  /** Always true on a completed run. */
  ok: true;
  scanned: {
    liked_tracks: number;
    skipped_unplayable: number;
    album_groups: number;
    fetch_all_cap: number;
    tracks_truncated_by_cap: boolean;
  };
  album_lookups: {
    made: number;
    cap: number;
    truncated_by_cap: boolean;
  };
  counts: {
    near_complete: number;
    orphaned_singles: number;
  };
  groups: AlbumGroup[];
  near_complete: NearCompleteFinding[];
  orphaned_singles: OrphanedSingleFinding[];
}

type ToolOut = {
  content: Array<{ type: 'text'; text: string }>;
  structuredContent?: Record<string, unknown>;
};

function shapeResult(rf: ResponseFormatValue, prose: string, payload: AnalysisResult): ToolOut {
  return {
    content: [{ type: 'text', text: rf === 'json' ? JSON.stringify(payload, null, 2) : prose }],
    structuredContent: payload as unknown as Record<string, unknown>,
  };
}

// ---------------------------------------------------------------------------
// Core analysis (pure given fetched data + album lookups)
// ---------------------------------------------------------------------------

const pct = (ratio: number): string => `${Math.round(ratio * 100)}%`;

export function buildSuggestion(likedCount: number): string {
  return `save the album and optionally prune the ${likedCount} single${likedCount === 1 ? '' : 's'} you liked individually`;
}

/**
 * Walk the liked-tracks library, group by album, look up album totals
 * (cached per album id, capped), and derive hygiene findings.
 */
async function analyze(client: SpotifyClient): Promise<AnalysisResult> {
  const fetchAllCap = getConfig().fetchAllCap;
  const saved = await client.getAllPages<SavedTrackItem>(
    '/me/tracks',
    { limit: '50' },
    { maxItems: fetchAllCap },
  );

  // ---- Group liked tracks by parent album ---------------------------------
  let skippedUnplayable = 0;
  const groupsById = new Map<string, AlbumGroup>();
  const likedTrackIds = new Set<string>();
  const likedCountByArtist = new Map<string, number>();
  const artistsByTrackId = new Map<string, { id: string; name: string }[]>();

  for (const entry of saved) {
    const track = entry?.track;
    if (!track?.id || !track.album?.id) {
      skippedUnplayable++;
      continue;
    }
    likedTrackIds.add(track.id);
    artistsByTrackId.set(track.id, (track.artists ?? []).map((a) => ({ id: a.id, name: a.name })));
    for (const artist of track.artists ?? []) {
      if (!artist.id) continue;
      likedCountByArtist.set(artist.id, (likedCountByArtist.get(artist.id) ?? 0) + 1);
    }
    let group = groupsById.get(track.album.id);
    if (!group) {
      group = {
        album_id: track.album.id,
        album_name: track.album.name,
        album_uri: track.album.uri ?? `spotify:album:${track.album.id}`,
        album_type: null,
        artist_ids: (track.artists ?? []).map((a) => a.id).filter(Boolean),
        artist_names: (track.artists ?? []).map((a) => a.name),
        liked_count: 0,
        liked_tracks: [],
        total_tracks: null,
        coverage: null,
      };
      groupsById.set(track.album.id, group);
    }
    group.liked_count++;
    group.liked_tracks.push({ id: track.id, name: track.name, uri: track.uri });
  }

  // Deterministic processing order: busiest album first, id as tiebreaker.
  const groups = [...groupsById.values()].sort(
    (a, b) => b.liked_count - a.liked_count || a.album_id.localeCompare(b.album_id),
  );

  // ---- GET /albums/{id} per group (cached, capped) ------------------------
  const albumCache = new Map<string, SpotifyAlbumFull | null>();
  let lookups = 0;
  let lookupTruncated = false;
  for (const group of groups) {
    if (lookups >= ALBUM_LOOKUP_CAP) {
      lookupTruncated = true;
      break;
    }
    let full: SpotifyAlbumFull | null;
    if (albumCache.has(group.album_id)) {
      full = albumCache.get(group.album_id) ?? null;
    } else {
      full = await client.get<SpotifyAlbumFull>(`/albums/${encodeURIComponent(group.album_id)}`);
      albumCache.set(group.album_id, full);
      lookups++;
    }
    if (full) {
      group.total_tracks =
        typeof full.total_tracks === 'number' ? full.total_tracks : null;
      group.album_type = full.album_type ?? group.album_type;
    }
  }

  // ---- Findings ------------------------------------------------------------
  const nearComplete: NearCompleteFinding[] = [];
  for (const group of groups) {
    if (!group.total_tracks || group.total_tracks <= 0) continue;
    const coverage = group.liked_count / group.total_tracks;
    group.coverage = coverage;
    if (coverage >= NEAR_COMPLETE_THRESHOLD && coverage < 1) {
      nearComplete.push({
        kind: 'near_complete_album',
        album_id: group.album_id,
        album_name: group.album_name,
        album_uri: group.album_uri,
        artist_names: group.artist_names,
        liked_count: group.liked_count,
        total_tracks: group.total_tracks,
        coverage,
        confidence: 'high',
        suggestion: buildSuggestion(group.liked_count),
      });
    }
  }

  const orphanedSingles: OrphanedSingleFinding[] = [];
  for (const group of groups) {
    if (!group.liked_tracks.length) continue;
    const full = albumCache.get(group.album_id) ?? null;
    const isSingle =
      (full?.album_type ?? group.album_type) === 'single' ||
      (group.total_tracks !== null && group.total_tracks <= 3);
    if (!isSingle) continue;

    // "Other tracks on this release are NOT liked": compare the release's own
    // track listing against the global liked set, minus this group's entries.
    const groupTrackIds = new Set(group.liked_tracks.map((t) => t.id));
    const releaseTracks = full?.tracks?.items ?? [];
    const otherLikedOnRelease = releaseTracks.filter(
      (t) => likedTrackIds.has(t.id) && !groupTrackIds.has(t.id),
    );
    if (releaseTracks.length > 0 && otherLikedOnRelease.length > 0) continue;

    for (const track of group.liked_tracks) {
      // Only liked item from that artist: every artist of this track must have
      // exactly one liked track overall (this one).
      const artists = artistsByTrackId.get(track.id) ?? [];
      const onlyFromArtist =
        artists.length > 0 &&
        artists.every((a) => !a.id || likedCountByArtist.get(a.id) === 1);
      if (!onlyFromArtist) continue;
      orphanedSingles.push({
        kind: 'orphaned_single',
        track_id: track.id,
        track_name: track.name,
        track_uri: track.uri,
        artist_names: artists.map((a) => a.name),
        album_id: group.album_id,
        album_name: group.album_name,
        confidence: 'low',
        reason:
          `nothing else liked from this release (${group.album_name}) or its artist(s) — `
            + 'a lone single like this may be intentional, so treat as a hint only',
      });
    }
  }

  return {
    ok: true,
    scanned: {
      liked_tracks: saved.length,
      skipped_unplayable: skippedUnplayable,
      album_groups: groups.length,
      fetch_all_cap: fetchAllCap,
      tracks_truncated_by_cap: saved.length >= fetchAllCap,
    },
    album_lookups: {
      made: lookups,
      cap: ALBUM_LOOKUP_CAP,
      truncated_by_cap: lookupTruncated,
    },
    counts: {
      near_complete: nearComplete.length,
      orphaned_singles: orphanedSingles.length,
    },
    groups,
    near_complete: nearComplete,
    orphaned_singles: orphanedSingles,
  };
}

// ---------------------------------------------------------------------------
// Prose rendering
// ---------------------------------------------------------------------------

function renderProse(result: AnalysisResult, maxResults: number): string {
  const { scanned, album_lookups, counts, near_complete, orphaned_singles } = result;
  const lines: string[] = ['Library hygiene — album completion & consolidation:', ''];

  lines.push(
    `Scanned ${scanned.liked_tracks} liked track${scanned.liked_tracks === 1 ? '' : 's'} `
      + `across ${scanned.album_groups} album${scanned.album_groups === 1 ? '' : 's'}`
      + `${scanned.skipped_unplayable ? ` (${scanned.skipped_unplayable} unplayable/local entries skipped)` : ''}. `
      + `Fetch-all cap ${scanned.fetch_all_cap} `
      + `${scanned.tracks_truncated_by_cap ? 'REACHED — older saved tracks were NOT analyzed' : 'not reached'}.`,
  );
  lines.push(
    `Album lookups: ${album_lookups.made} made (cap ${album_lookups.cap} `
      + `${album_lookups.truncated_by_cap ? 'REACHED — some albums were not checked' : 'not reached'}).`,
  );

  if (scanned.liked_tracks === 0) {
    lines.push('', 'No liked tracks found — nothing to analyze.');
    return lines.join('\n');
  }

  // Combined findings, top-first: near-complete by coverage desc, then singles.
  near_complete.sort((a, b) => b.coverage - a.coverage || a.album_id.localeCompare(b.album_id));
  const combined: Array<NearCompleteFinding | OrphanedSingleFinding> = [
    ...near_complete,
    ...orphaned_singles,
  ];
  if (combined.length === 0) {
    lines.push('', 'No hygiene findings — your library looks tidy.');
    return lines.join('\n');
  }

  const t = truncateItems(combined, maxResults);
  const ncShown = Math.min(counts.near_complete, t.items.length);

  lines.push('');
  lines.push(
    `NEAR-COMPLETE ALBUMS (${counts.near_complete}): at least ${pct(NEAR_COMPLETE_THRESHOLD)} of the `
      + 'tracks are already liked — saving the album keeps everything in one place:',
  );
  for (const finding of t.items.slice(0, ncShown) as NearCompleteFinding[]) {
    const artists = finding.artist_names.length ? finding.artist_names.join(', ') : 'unknown artist';
    lines.push(
      `  • ${finding.album_name} — ${artists} | ${finding.liked_count}/${finding.total_tracks} tracks `
        + `liked (${pct(finding.coverage)}) | ${finding.suggestion} | URI: ${finding.album_uri}`,
    );
  }
  if (counts.near_complete === 0) lines.push('  (none)');

  lines.push(
    `ORPHANED SINGLES (${counts.orphaned_singles}) [LOW CONFIDENCE] — lone singles with nothing else `
      + 'liked from their release or artist:',
  );
  for (const finding of t.items.slice(ncShown) as OrphanedSingleFinding[]) {
    const artists = finding.artist_names.length ? finding.artist_names.join(', ') : 'unknown artist';
    lines.push(`  • ${finding.track_name} — ${artists} | URI: ${finding.track_uri}`);
  }
  if (counts.orphaned_singles === 0) lines.push('  (none)');

  if (t.footer) lines.push(`(${t.footer})`);
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

export function registerLibraryHygieneTools(server: McpServer, client: SpotifyClient): void {
  server.tool(
    'library_hygiene',
    'Read-only album completion & consolidation analysis over your liked tracks: flags '
      + 'near-complete albums worth saving in full and lone singles with nothing else liked '
      + 'from their artist (low confidence). Suggests only — never mutates your library.',
    {
      response_format: ResponseFormat,
      max_results: MaxResults,
    },
    async (args) => {
      const rf = args.response_format;
      const result = await analyze(client);
      const maxResults = resolveMaxResults(args.max_results, getConfig().maxItems);
      return shapeResult(rf, renderProse(result, maxResults), result);
    },
  );
}
