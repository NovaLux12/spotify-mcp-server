/**
 * Saved-track duplicate detection (#156).
 *
 * Read-only analysis over the user's liked (/me/tracks) library: walks every
 * saved track once, groups tracks that share a normalized name + artist set,
 * and distinguishes probable double re-adds from distinct recordings or
 * release versions. Suggestions are prose only — never mutate anything.
 *
 * Matching rules:
 *   • Discovery identity = punctuation-stripped lowercase track name
 *     + lowercase artist-name set (sorted).
 *   • EXACT duplicates = same non-null ISRC, same album id, and durations
 *     within ±2000 ms. Only the oldest dated save is retained; undated saves
 *     sort last and are never preferred as the keeper.
 *   • NEAR duplicates = same discovery identity but a different ISRC/album or
 *     duration; review only, with no removals recommended.
 */
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { SpotifyClient } from '../client.js';
import { quotaPreflight, quotaSnapshot, quotaWindowRemaining, quotaDelta } from '../client.js';
import type { SavedTrackItem, PlaylistItemObject, SpotifyArtistSimple, SpotifyTrack } from '../types/spotify.js';
import {
  ResponseFormat,
  MaxResults,
  resolveMaxResults,
  completenessFooter,
  truncateItems,
} from '../shaping.js';
import type { ResponseFormatValue } from '../shaping.js';
import { getConfig } from '../config.js';

/** Two durations within this window count as the same recording length. */
const DURATION_TOLERANCE_MS = 2000;

// ---------------------------------------------------------------------------
// Shapes
// ---------------------------------------------------------------------------

interface SavedTrackMember {
  id: string;
  uri: string;
  name: string;
  artist_names: string[];
  album_name: string | null;
  album_id: string | null;
  duration_ms: number;
  /** ISRC identifies the recording when Spotify provides one. */
  isrc: string | null;
  /** Save date; groups are ordered oldest dated → newest dated → undated. */
  added_at: string;
}

interface DuplicateGroup {
  kind: 'exact' | 'near_duplicate';
  /** Human-readable explanation of the evidence behind this classification. */
  match_basis:
    | 'same_isrc_album_duration_within_2000ms'
    | 'same_title_artist_different_recording_or_version';
  normalized_name: string;
  artist_names: string[];
  /** Oldest dated save first; undated saves last, then URI. */
  members: SavedTrackMember[];
  /** Exact groups retain this URI; near-duplicate groups retain every track. */
  kept_uri: string | null;
  /** Derived once per exact duplicate bucket; empty for review-only groups. */
  removable_uris: string[];
  /** Member uris that also appear in the cross-referenced playlist ([] without one). */
  playlist_overlap_uris: string[];
  suggestion: string;
}

interface AnalysisResult {
  ok: true;
  scanned: {
    saved_tracks: number;
    skipped_unplayable: number;
    fetched: number;
    cap: number;
    fetch_all_cap: number;
    snapshot_state: 'complete' | 'partial';
    complete: boolean;
    truncated_by_cap: boolean;
    /** Present only when a playlist_id cross-reference was requested. */
    playlist_id?: string;
    playlist_name?: string | null;
    /** Track (non-episode) items seen in the cross-referenced playlist. */
    playlist_tracks?: number;
  };
  counts: {
    exact_groups: number;
    near_duplicate_groups: number;
    removable_tracks: number;
    /** Groups with ≥1 member also present in the cross-referenced playlist. */
    groups_with_playlist_overlap: number;
  };
  groups: DuplicateGroup[];
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
// Normalization + grouping helpers
// ---------------------------------------------------------------------------

/** Lowercase, strip punctuation/symbols, collapse whitespace. */
function normalizeTrackName(name: string): string {
  return name
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\p{P}\p{S}]/gu, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Sorted, deduplicated lowercase artist-name set joined with '|'. */
function artistKey(names: readonly string[]): string {
  return [...new Set(names.map((n) => n.toLowerCase().trim()))].sort().join('|');
}

/** Identity used to bucket potentially-duplicate recordings together. */
function identityKey(normalizedName: string, artists: readonly string[]): string {
  return `${normalizedName}::${artistKey(artists)}`;
}

/**
 * Partition members into duration clusters: sorted by duration_ms, a member
 * joins the open cluster while it stays within ±DURATION_TOLERANCE_MS of the
 * cluster's anchor, otherwise it opens a new cluster.
 */
function clusterByDuration(members: readonly SavedTrackMember[]): SavedTrackMember[][] {
  const sorted = [...members].sort((a, b) => a.duration_ms - b.duration_ms);
  const clusters: SavedTrackMember[][] = [];
  let current: SavedTrackMember[] = [];
  for (const m of sorted) {
    if (
      current.length === 0 ||
      m.duration_ms - current[0].duration_ms <= DURATION_TOLERANCE_MS
    ) {
      current.push(m);
    } else {
      clusters.push(current);
      current = [m];
    }
  }
  if (current.length > 0) clusters.push(current);
  return clusters;
}

/** Dated saves precede undated saves; URI is the deterministic final tie-break. */
const byOldest = (a: SavedTrackMember, b: SavedTrackMember): number => {
  if (!a.added_at && !b.added_at) return a.uri.localeCompare(b.uri);
  if (!a.added_at) return 1;
  if (!b.added_at) return -1;
  return a.added_at.localeCompare(b.added_at) || a.uri.localeCompare(b.uri);
};

function recordingKey(member: SavedTrackMember): string | null {
  const isrc = member.isrc?.trim().toUpperCase();
  const albumId = member.album_id?.trim();
  return isrc && albumId ? `${isrc}::${albumId}` : null;
}

/**
 * Pure grouping over already-fetched members. Exact removal candidates are
 * computed once for each same-ISRC/same-album/duration bucket. Near groups are
 * review-only because a different ISRC, release, or version is a distinct save.
 */
function findDuplicateGroups(
  members: readonly SavedTrackMember[],
  includeNearDuplicates: boolean,
): DuplicateGroup[] {
  const buckets = new Map<
    string,
    { normalizedName: string; artistNames: string[]; items: SavedTrackMember[] }
  >();
  for (const member of members) {
    const normalizedName = normalizeTrackName(member.name);
    const key = identityKey(normalizedName, member.artist_names);
    let bucket = buckets.get(key);
    if (!bucket) {
      bucket = { normalizedName, artistNames: member.artist_names, items: [] };
      buckets.set(key, bucket);
    }
    bucket.items.push(member);
  }

  const groups: DuplicateGroup[] = [];
  for (const bucket of buckets.values()) {
    // The library is a set, but defensive URI deduplication keeps repeated API
    // rows from producing self-removal recommendations.
    const seenUris = new Set<string>();
    const uniqueItems = bucket.items.filter((member) => {
      if (seenUris.has(member.uri)) return false;
      seenUris.add(member.uri);
      return true;
    });
    if (uniqueItems.length < 2) continue;

    const ordered = [...uniqueItems].sort(byOldest);
    const artistNames = [...new Set(bucket.artistNames.map((n) => n.toLowerCase().trim()))].sort();
    let exactBucketCount = 0;
    let exactMemberCount = 0;

    for (const durationCluster of clusterByDuration(ordered)) {
      const recordingBuckets = new Map<string, SavedTrackMember[]>();
      for (const member of durationCluster) {
        const recording = recordingKey(member);
        if (!recording) continue;
        const recordingMembers = recordingBuckets.get(recording);
        if (recordingMembers) recordingMembers.push(member);
        else recordingBuckets.set(recording, [member]);
      }

      for (const [recording, recordingMembers] of recordingBuckets) {
        if (recordingMembers.length < 2) continue;
        const clusterOrdered = [...recordingMembers].sort(byOldest);
        const keptUri = clusterOrdered[0].uri;
        const removableUris = clusterOrdered.slice(1).map((member) => member.uri);
        const allUndated = clusterOrdered.every((member) => !member.added_at);
        exactBucketCount++;
        exactMemberCount += clusterOrdered.length;
        groups.push({
          kind: 'exact',
          match_basis: 'same_isrc_album_duration_within_2000ms',
          normalized_name: bucket.normalizedName,
          artist_names: artistNames,
          members: clusterOrdered,
          kept_uri: keptUri,
          removable_uris: removableUris,
          playlist_overlap_uris: [],
          suggestion: allUndated
            ? 'exact recording: same ISRC, album, and duration; save dates unavailable, keep lowest URI, remove the rest'
            : 'keep oldest, remove the rest (exact match: same ISRC, album, and duration within 2000 ms)',
        });
      }
    }

    const entirelyOneExactBucket = exactBucketCount === 1 && exactMemberCount === ordered.length;
    if (includeNearDuplicates && !entirelyOneExactBucket) {
      groups.push({
        kind: 'near_duplicate',
        match_basis: 'same_title_artist_different_recording_or_version',
        normalized_name: bucket.normalizedName,
        artist_names: artistNames,
        members: ordered,
        kept_uri: null,
        removable_uris: [],
        playlist_overlap_uris: [],
        suggestion: 'review - different ISRC, release, or duration; no removals recommended',
      });
    }
  }

  groups.sort(
    (a, b) =>
      a.normalized_name.localeCompare(b.normalized_name) ||
      a.kind.localeCompare(b.kind) ||
      a.members[0].uri.localeCompare(b.members[0].uri),
  );

  return groups;
}

// ---------------------------------------------------------------------------
// Core analysis
// ---------------------------------------------------------------------------

/**
 * #161: when a playlist_id is given, page its items and return the set of
 * track URIs it contains (episodes/local entries are not tracks — skipped).
 * The existence probe fails fast with a clear error instead of silently
 * cross-referencing against zero items.
 */
async function loadPlaylistTrackUris(
  client: SpotifyClient,
  playlistId: string,
): Promise<{ uris: Set<string>; name: string | null; trackCount: number }> {
  const id = encodeURIComponent(playlistId);
  const meta = await client.get<{ id?: string; name?: string }>(`/playlists/${id}`);
  if (!meta) throw new Error(`Playlist "${playlistId}" not found`);

  const fetchAllCap = getConfig().fetchAllCap;
  const items = await client.getAllPages<PlaylistItemObject>(
    `/playlists/${id}/items`,
    { limit: '100' },
    { maxItems: fetchAllCap },
  );
  const uris = new Set<string>();
  let unavailable = 0;
  for (const entry of items) {
    const playable = entry.item;
    if (playable?.type === 'track' && playable.uri) uris.add(playable.uri);
    else unavailable++;
  }
  return { uris, name: meta.name ?? null, trackCount: uris.size + unavailable };
}

function hasExternalIsrc(
  track: SpotifyTrack,
): track is SpotifyTrack & { external_ids: { isrc: string } } {
  return 'external_ids' in track
    && typeof track.external_ids === 'object'
    && track.external_ids !== null
    && 'isrc' in track.external_ids
    && typeof track.external_ids.isrc === 'string';
}

async function analyze(
  client: SpotifyClient,
  includeNearDuplicates: boolean,
  playlistId?: string,
): Promise<AnalysisResult & { requests_made?: number }> {
  const snapshot = quotaSnapshot(client);
  const requestedCap = getConfig().fetchAllCap;
  // (#904) shrink the walk to the remaining quota window when recent
  // throttle pressure exists; idle clients keep today's budget exactly.
  const fetchAllCap = Math.min(requestedCap, quotaWindowRemaining(client));
  const walkShrunk = fetchAllCap < requestedCap;
  const walked = await client.getAllPages<SavedTrackItem>(
    '/me/tracks',
    { limit: '50' },
    { maxItems: fetchAllCap + 1 },
  );
  const truncatedByCap = walked.length > fetchAllCap;
  const saved = walked.slice(0, fetchAllCap);

  const members: SavedTrackMember[] = [];
  let skippedUnplayable = 0;
  for (const entry of saved) {
    const track = entry?.track;
    if (!track?.id || !track.uri || typeof track.duration_ms !== 'number') {
      skippedUnplayable++;
      continue;
    }
    const isrc = hasExternalIsrc(track)
      ? track.external_ids.isrc.trim().toUpperCase() || null
      : null;
    members.push({
      id: track.id,
      uri: track.uri,
      name: track.name ?? '',
      artist_names: (track.artists ?? []).map((artist: SpotifyArtistSimple) => artist.name),
      album_name: track.album?.name ?? null,
      album_id: track.album?.id ?? null,
      duration_ms: track.duration_ms,
      isrc,
      added_at: entry.added_at ?? '',
    });
  }

  const groups = findDuplicateGroups(members, includeNearDuplicates);

  // #161: optional cross-reference against one playlist's contents.
  let playlist: Awaited<ReturnType<typeof loadPlaylistTrackUris>> | undefined;
  if (playlistId) playlist = await loadPlaylistTrackUris(client, playlistId);
  for (const g of groups) {
    if (!playlist) continue;
    g.playlist_overlap_uris = g.members.filter((m) => playlist.uris.has(m.uri)).map((m) => m.uri);
  }

  return {
    ok: true,
    scanned: {
      saved_tracks: members.length,
      skipped_unplayable: skippedUnplayable,
      fetched: saved.length,
      cap: fetchAllCap,
      fetch_all_cap: fetchAllCap,
      snapshot_state: truncatedByCap ? 'partial' : 'complete',
      complete: !truncatedByCap,
      truncated_by_cap: truncatedByCap,
      ...(playlist ? { playlist_id: playlistId, playlist_name: playlist.name } : {}),
      ...(playlist ? { playlist_tracks: playlist.trackCount } : {}),
    },
    ...quotaDelta(client, snapshot),
    ...(walkShrunk ? { requests_planned: requestedCap, budget_shrunk: true } : {}),
    counts: {
      exact_groups: groups.filter((g) => g.kind === 'exact').length,
      near_duplicate_groups: groups.filter((g) => g.kind === 'near_duplicate').length,
      removable_tracks: new Set(groups.flatMap((group) => group.removable_uris)).size,
      groups_with_playlist_overlap: playlist
        ? groups.filter((g) => g.playlist_overlap_uris.length > 0).length
        : 0,
    },
    groups,
  };
}

// ---------------------------------------------------------------------------
// Prose rendering
// ---------------------------------------------------------------------------

function renderProse(result: AnalysisResult, maxResults: number): string {
  const { scanned, counts, groups } = result;
  const lines: string[] = ['Saved-track duplicates:', ''];

  lines.push(
    `Scanned ${scanned.saved_tracks} saved track${scanned.saved_tracks === 1 ? '' : 's'} `
      + `${scanned.skipped_unplayable ? `(${scanned.skipped_unplayable} unplayable/local entries skipped) ` : ''}`
      + `— ${completenessFooter({
        fetched: scanned.fetched,
        cap: scanned.cap,
        truncated: scanned.truncated_by_cap,
        subject: 'saved tracks',
      })}.`,
  );

  if (scanned.saved_tracks === 0) {
    lines.push('', 'No saved tracks found — nothing to compare.');
    return lines.join('\n');
  }

  if (groups.length === 0) {
    lines.push('', 'No duplicates found — your library looks clean.');
    return lines.join('\n');
  }

  lines.push(
    `Found ${groups.length} potential duplicate group${groups.length === 1 ? '' : 's'} `
      + `(${counts.exact_groups} exact, ${counts.near_duplicate_groups} near) `
      + `— ${counts.removable_tracks} removable track${counts.removable_tracks === 1 ? '' : 's'}. `
      + 'Only EXACT groups have removal recommendations; NEAR-DUPLICATE groups are review-only.',
  );
  if (scanned.playlist_id) {
    lines.push(
      `Cross-referenced against "${scanned.playlist_name ?? scanned.playlist_id}" `
        + `(${scanned.playlist_tracks ?? 0} items) — members also in that playlist are marked [in playlist]; `
        + `${counts.groups_with_playlist_overlap} group${counts.groups_with_playlist_overlap === 1 ? '' : 's'} overlap.`,
    );
  }
  lines.push('');

  const t = truncateItems(groups, maxResults);
  for (const group of t.items) {
    const label = group.kind === 'near_duplicate' ? 'NEAR-DUPLICATE' : 'EXACT';
    const artists = group.artist_names.join(', ') || 'unknown artist';
    lines.push(`• [${label}] "${group.normalized_name}" — ${artists}`);
    lines.push(
      group.kind === 'exact'
        ? '    Evidence: same non-null ISRC, same album id, and duration within 2000 ms.'
        : '    Evidence: same title/artist set, but a different recording or release. These are distinct saved tracks; review only.',
    );
    group.members.forEach((member) => {
      const marker = group.kept_uri === null
        ? 'review'
        : member.uri === group.kept_uri ? 'keep' : 'remove';
      const albumId = member.album_id ? ` [${member.album_id}]` : '';
      const album = member.album_name ? ` | album: ${member.album_name}${albumId}` : albumId;
      const isrc = member.isrc ? ` | ISRC: ${member.isrc}` : ' | ISRC: unavailable';
      const inPlaylist =
        scanned.playlist_id && group.playlist_overlap_uris.includes(member.uri) ? ' [in playlist]' : '';
      lines.push(
        `    ${marker}: saved ${member.added_at || 'unknown date'} | ${Math.round(member.duration_ms)}ms${album}${isrc}${inPlaylist} | ${member.uri}`,
      );
    });
    lines.push(`    → ${group.suggestion}`);
  }

  if (t.footer) lines.push(`(${t.footer})`);
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

export function registerSavedDedupeTools(server: McpServer, client: SpotifyClient): void {
  server.tool(
    'find_duplicate_saved_tracks',
    'Read-only duplicate detection over your saved (liked) tracks. Exact groups require the '
      + 'same non-null ISRC and album id with duration within ±2s, and keep the oldest dated save. '
      + 'On opt-in, near-duplicate groups show same-title/artist tracks whose ISRC, release, or '
      + 'duration differs; these are distinct saved tracks and are review-only with no removals. '
      + 'Undated saves sort after dated saves. Optionally pass a playlist_id to cross-reference '
      + 'which group members also appear in that playlist. Never mutates your library. '
      + 'Also covers: find_duplicates_in_playlist — See also: find_duplicates_in_playlist, find_duplicate_tracks_across_playlists.',
    {
      response_format: ResponseFormat,
      max_results: MaxResults,
      include_near_duplicates: z
        .boolean()
        .optional()
        .default(false)
        .describe(
          'Also report same-title/artist groups with a different ISRC, release, or duration. '
            + 'Near duplicates are review-only and never recommend removal. Default false.',
        ),
      playlist_id: z
        .string()
        .optional()
        .describe(
          'Optional playlist ID to cross-reference: members of each duplicate group that '
            + 'also appear in this playlist are flagged, so cleanup or review decisions can account '
            + 'for where the track is already curated.',
        ),
    },
    async (args) => {
      const rf = args.response_format;
      const gate = quotaPreflight(client);
      if (gate.blocked) {
        return shapeResult(rf, gate.message, {
          ok: false,
          cooldown: true,
          wait_sec: gate.waitSec,
          requests_made: 0,
          requests_planned: getConfig().fetchAllCap,
        } as unknown as AnalysisResult);
      }
      const result = await analyze(client, args.include_near_duplicates, args.playlist_id);
      const maxResults = resolveMaxResults(args.max_results, getConfig().maxItems);
      return shapeResult(rf, renderProse(result, maxResults), result);
    },
  );
}
