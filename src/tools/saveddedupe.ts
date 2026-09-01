/**
 * Saved-track duplicate detection (#156).
 *
 * Read-only analysis over the user's liked (/me/tracks) library: walks every
 * saved track once, groups tracks that share a normalized name + artist set,
 * and reports groups likely to be the same recording saved more than once
 * (double re-adds, relinks, remasters). Suggestions are prose only — never
 * mutates anything.
 *
 * Matching rules:
 *   • Normalized identity  = punctuation-stripped lowercase track name
 *     + lowercase artist-name set (sorted).
 *   • EXACT duplicates     = same identity AND durations within ±2000 ms.
 *   • NEAR duplicates      = same identity but durations differ >2000 ms
 *     (remasters/re-recordings); only surfaced when include_near_duplicates.
 */
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { SpotifyClient } from '../client.js';
import type { SavedTrackItem, PlaylistItemObject } from '../types/spotify.js';
import {
  ResponseFormat,
  MaxResults,
  resolveMaxResults,
  truncateItems,
} from '../shaping.js';
import type { ResponseFormatValue } from '../shaping.js';
import { getConfig } from '../config.js';

/** Two durations within this window count as the same recording length. */
export const DURATION_TOLERANCE_MS = 2000;

// ---------------------------------------------------------------------------
// Shapes
// ---------------------------------------------------------------------------

export interface SavedTrackMember {
  id: string;
  uri: string;
  name: string;
  artist_names: string[];
  album_name: string | null;
  duration_ms: number;
  /** Save date; groups are ordered oldest → newest by this field. */
  added_at: string;
}

export interface DuplicateGroup {
  kind: 'exact' | 'near_duplicate';
  normalized_name: string;
  artist_names: string[];
  /** Oldest save first. */
  members: SavedTrackMember[];
  /** Every member uri except the oldest save — the removal candidates. */
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
    fetch_all_cap: number;
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
export function normalizeTrackName(name: string): string {
  return name
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\p{P}\p{S}]/gu, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Sorted, deduplicated lowercase artist-name set joined with '|'. */
export function artistKey(names: readonly string[]): string {
  return [...new Set(names.map((n) => n.toLowerCase().trim()))].sort().join('|');
}

/** Identity used to bucket potentially-duplicate recordings together. */
export function identityKey(normalizedName: string, artists: readonly string[]): string {
  return `${normalizedName}::${artistKey(artists)}`;
}

/**
 * Partition members into duration clusters: sorted by duration_ms, a member
 * joins the open cluster while it stays within ±DURATION_TOLERANCE_MS of the
 * cluster's anchor, otherwise it opens a new cluster.
 */
export function clusterByDuration(members: readonly SavedTrackMember[]): SavedTrackMember[][] {
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

const byOldest = (a: SavedTrackMember, b: SavedTrackMember): number =>
  a.added_at.localeCompare(b.added_at) || a.uri.localeCompare(b.uri);

/**
 * Pure grouping over already-fetched members.
 * `includeNearDuplicates` adds groups whose members share name+artists but
 * span more than one duration cluster (>±2000 ms spread — remasters etc.).
 */
export function findDuplicateGroups(
  members: readonly SavedTrackMember[],
  includeNearDuplicates: boolean,
): DuplicateGroup[] {
  // Bucket by identity (dynamic keys → Map).
  const buckets = new Map<
    string,
    { normalizedName: string; artistNames: string[]; items: SavedTrackMember[] }
  >();
  for (const m of members) {
    const normalizedName = normalizeTrackName(m.name);
    const key = identityKey(normalizedName, m.artist_names);
    let bucket = buckets.get(key);
    if (!bucket) {
      bucket = { normalizedName, artistNames: m.artist_names, items: [] };
      buckets.set(key, bucket);
    }
    bucket.items.push(m);
  }

  const groups: DuplicateGroup[] = [];
  for (const bucket of buckets.values()) {
    if (bucket.items.length < 2) continue;
    // Oldest save first; stable tie-break keeps ordering deterministic.
    const ordered = [...bucket.items].sort(byOldest);
    const clusters = clusterByDuration(ordered);

    // Exact duplicates: any duration cluster holding 2+ members.
    for (const cluster of clusters) {
      if (cluster.length < 2) continue;
      const clusterOrdered = [...cluster].sort(byOldest);
      groups.push({
        kind: 'exact',
        normalized_name: bucket.normalizedName,
        artist_names: [...new Set(bucket.artistNames.map((n) => n.toLowerCase()))].sort(),
        members: clusterOrdered,
        removable_uris: clusterOrdered.slice(1).map((m) => m.uri),
        playlist_overlap_uris: [],
        suggestion: 'keep oldest, remove the rest',
      });
    }

    // Near duplicates: same identity, spread across multiple duration
    // clusters — remasters/re-recordings. Only on explicit opt-in.
    if (includeNearDuplicates && clusters.length > 1) {
      groups.push({
        kind: 'near_duplicate',
        normalized_name: bucket.normalizedName,
        artist_names: [...new Set(bucket.artistNames.map((n) => n.toLowerCase()))].sort(),
        members: ordered,
        removable_uris: ordered.slice(1).map((m) => m.uri),
        playlist_overlap_uris: [],
        suggestion: 'keep oldest, remove the rest',
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

async function analyze(
  client: SpotifyClient,
  includeNearDuplicates: boolean,
  playlistId?: string,
): Promise<AnalysisResult> {
  const fetchAllCap = getConfig().fetchAllCap;
  const saved = await client.getAllPages<SavedTrackItem>(
    '/me/tracks',
    { limit: '50' },
    { maxItems: fetchAllCap },
  );

  const members: SavedTrackMember[] = [];
  let skippedUnplayable = 0;
  for (const entry of saved) {
    const track = entry?.track;
    if (!track?.id || !track.uri || typeof track.duration_ms !== 'number') {
      skippedUnplayable++;
      continue;
    }
    members.push({
      id: track.id,
      uri: track.uri,
      name: track.name ?? '',
      artist_names: (track.artists ?? []).map((a) => a.name),
      album_name: track.album?.name ?? null,
      duration_ms: track.duration_ms,
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
      fetch_all_cap: fetchAllCap,
      truncated_by_cap: saved.length >= fetchAllCap,
      ...(playlist ? { playlist_id: playlistId, playlist_name: playlist.name } : {}),
      ...(playlist ? { playlist_tracks: playlist.trackCount } : {}),
    },
    counts: {
      exact_groups: groups.filter((g) => g.kind === 'exact').length,
      near_duplicate_groups: groups.filter((g) => g.kind === 'near_duplicate').length,
      removable_tracks: groups.reduce((n, g) => n + g.removable_uris.length, 0),
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
      + `— fetch-all cap ${scanned.fetch_all_cap} `
      + `${scanned.truncated_by_cap ? 'REACHED — older saved tracks were NOT analyzed' : 'not reached'}.`,
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
    `Found ${groups.length} duplicate group${groups.length === 1 ? '' : 's'} `
      + `(${counts.exact_groups} exact, ${counts.near_duplicate_groups} near) `
      + `— ${counts.removable_tracks} removable track${counts.removable_tracks === 1 ? '' : 's'}:`,
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
    group.members.forEach((m, i) => {
      const marker = i === 0 ? 'keep' : 'remove';
      const album = m.album_name ? ` | album: ${m.album_name}` : '';
      const inPlaylist =
        scanned.playlist_id && group.playlist_overlap_uris.includes(m.uri) ? ' [in playlist]' : '';
      lines.push(
        `    ${marker}: saved ${m.added_at || 'unknown date'} | ${Math.round(m.duration_ms)}ms${album}${inPlaylist} | ${m.uri}`,
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
    'Read-only duplicate detection over your saved (liked) tracks: flags the same recording '
      + 'saved more than once — double re-adds (exact matches within ±2s duration) and, on '
      + 'opt-in, remasters/re-recordings of the same song (near duplicates). Lists each group '
      + 'oldest save first with a keep-one-remove-the-rest suggestion. Optionally pass a '
      + 'playlist_id to cross-reference which duplicates also appear in that playlist. '
      + 'Never mutates your library. Also covers: find_duplicates_in_playlist — See also: find_duplicates_in_playlist, find_duplicate_tracks_across_playlists.',
    {
      response_format: ResponseFormat,
      max_results: MaxResults,
      include_near_duplicates: z
        .boolean()
        .optional()
        .default(false)
        .describe(
          'Also report same-song groups whose durations differ by more than ±2s '
            + '(remasters/re-recordings). Default false.',
        ),
      playlist_id: z
        .string()
        .optional()
        .describe(
          'Optional playlist ID to cross-reference: members of each duplicate group that '
            + 'also appear in this playlist are flagged, so removal decisions can account '
            + 'for where the track is already curated.',
        ),
    },
    async (args) => {
      const rf = args.response_format;
      const result = await analyze(client, args.include_near_duplicates, args.playlist_id);
      const maxResults = resolveMaxResults(args.max_results, getConfig().maxItems);
      return shapeResult(rf, renderProse(result, maxResults), result);
    },
  );
}
