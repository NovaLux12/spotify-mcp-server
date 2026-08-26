/**
 * create_smart_playlist (#172): rule-based playlist generation from the
 * user's OWN listening data — top tracks, recently played, or saved tracks —
 * with optional artist filtering and per-artist uniqueness. No deprecated
 * recommendations endpoint involved.
 *
 * dry_run previews the exact candidate list without creating anything; the
 * real run creates the playlist via POST /me/playlists and adds URIs in
 * batches of 100, then issues a meta receipt proving the playlist resolves.
 */
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { SpotifyClient } from '../client.js';
import {
  DryRun,
  batchSummary,
  truncateItems,
} from '../shaping.js';
import { getConfig } from '../config.js';
import { issueReceipt, formatReceipt } from '../receipts.js';
import { timeRangeSchema } from './personalization.js';
import type {
  RecentlyPlayedItem,
  SavedTrackItem,
  SpotifyPaged,
  SpotifyTrack,
} from '../types/spotify.js';

type TextContent = { type: 'text'; text: string };
type ToolResult = { content: TextContent[]; structuredContent?: Record<string, unknown> };

const textResult = (text: string, structured?: Record<string, unknown>): ToolResult => ({
  content: [{ type: 'text', text }],
  ...(structured ? { structuredContent: structured } : {}),
});

const SOURCE_SCHEMA = z
  .enum(['top_tracks', 'recently_played', 'saved_tracks'])
  .default('top_tracks')
  .describe(
    'Where candidates come from: your top tracks by time_range, your recently played '
      + 'history, or your saved (liked) tracks.',
  );

/** Case-insensitive substring match against any of the track's artist names. */
export function matchesArtistFilter(track: SpotifyTrack, filters: readonly string[]): boolean {
  const names = (track.artists ?? []).map((a) => a.name.toLowerCase());
  return filters.some((f) => names.some((n) => n.includes(f.toLowerCase())));
}

/**
 * Keep the first track per artist (primary-artist key) so one prolific act
 * can't fill the whole playlist. Preserves source order.
 */
export function uniqueByArtist(tracks: readonly SpotifyTrack[]): SpotifyTrack[] {
  const seen = new Set<string>();
  const kept: SpotifyTrack[] = [];
  for (const t of tracks) {
    const key = (t.artists?.[0]?.name ?? '').toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    kept.push(t);
  }
  return kept;
}

/** Dedupe by URI keeping first occurrence (recently-played repeats). */
function dedupeUris(tracks: readonly SpotifyTrack[]): SpotifyTrack[] {
  const seen = new Set<string>();
  return tracks.filter((t) => {
    if (!t.uri || seen.has(t.uri)) return false;
    seen.add(t.uri);
    return true;
  });
}

async function loadCandidates(client: SpotifyClient, source: string, scanCap?: number): Promise<SpotifyTrack[]> {
  switch (source) {
    case 'top_tracks': {
      // Two pages of 50 is plenty: filters only shrink the candidate pool.
      const page1 = await client.get<SpotifyPaged<SpotifyTrack>>('/me/top/tracks', {
        limit: '50',
        offset: '0',
      });
      const page2 = await client.get<SpotifyPaged<SpotifyTrack>>('/me/top/tracks', {
        limit: '50',
        offset: '50',
      });
      return [...(page1?.items ?? []), ...(page2?.items ?? [])].filter((t) => t?.uri);
    }
    case 'recently_played': {
      const res = await client.get<{ items?: RecentlyPlayedItem[] }>(
        '/me/player/recently-played',
        { limit: '50' },
      );
      if (!res) throw new Error('Could not retrieve recently played tracks');
      return (res.items ?? [])
        .filter((item) => item?.track)
        .map((item) => item.track as SpotifyTrack);
    }
    default: {
      const cap = scanCap ?? getConfig().fetchAllCap;
      const saved = await client.getAllPages<SavedTrackItem>('/me/tracks', { limit: '50' }, { maxItems: cap });
      return saved.map((entry) => entry?.track).filter((t): t is SpotifyTrack => Boolean(t?.uri));
    }
  }
}

export function registerSmartTools(server: McpServer, client: SpotifyClient): void {
  server.tool(
    'create_smart_playlist',
    'Create a playlist from rules over your own listening data: top tracks (by time range), '
      + 'recently played, or saved tracks — with optional artist-name filtering and a '
      + 'one-track-per-artist toggle. When source=saved_tracks the pool is the newest N saved tracks '
      + '(N=scan_cap, default fetchAllCap=500) and truncation is reported. No deprecated recommendations endpoints involved. '
      + 'dry_run previews the exact track list without creating anything.',
    {
      name: z.string().min(1).describe('Playlist name'),
      source: SOURCE_SCHEMA,
      limit: z
        .number()
        .int()
        .min(1)
        .max(500)
        .optional()
        .default(30)
        .describe('How many tracks the playlist should hold (after filters). Default 30.'),
      time_range: timeRangeSchema,
      artist_filter: z
        .array(z.string())
        .optional()
        .describe(
          'Only include tracks whose artist name contains any of these substrings '
            + '(case-insensitive), e.g. ["Radiohead", "Miles Davis"].',
        ),
      unique_artists: z
        .boolean()
        .optional()
        .default(false)
        .describe('Keep at most one track per primary artist. Default false.'),
      description: z.string().optional().describe('Playlist description'),
      public: z.boolean().optional().default(false).describe('Whether the playlist is public'),
      scan_cap: z.number().int().min(1).max(10000).optional().describe('How many saved tracks to scan when source=saved_tracks; default SPOTIFY_MCP_FETCH_ALL_CAP (500). Reports truncation when hit.'),
      dry_run: DryRun,
    },
    async (args) => {
      const scanCap = args.scan_cap ?? getConfig().fetchAllCap;
      let rawCandidates = await loadCandidates(client, args.source, scanCap);
      const candidatesScanned = rawCandidates.length;
      const truncatedAtCap = args.source === 'saved_tracks' && candidatesScanned >= scanCap;
      let candidates = dedupeUris(rawCandidates);

      if (args.artist_filter && args.artist_filter.length > 0) {
        candidates = candidates.filter((t) => matchesArtistFilter(t, args.artist_filter!));
      }
      if (args.unique_artists) candidates = uniqueByArtist(candidates);

      const picked = candidates.slice(0, args.limit);
      const visibility = args.public ? 'public' : 'private';

      if (args.dry_run) {
        const view = truncateItems(picked, 50);
        const lines = [
          `[dry run] create_smart_playlist — nothing was changed.`,
          `Would create ${visibility} playlist "${args.name}" with ${picked.length} track(s) `
            + `from ${args.source}`
            + (args.time_range && args.source === 'top_tracks' ? ` (${args.time_range})` : '')
            + ':',
          ...view.items.map((t) => `• ${t.artists.map((a) => a.name).join(', ')} — ${t.name}`),
          ...(view.footer ? [view.footer] : []),
        ];
        if (truncatedAtCap) lines.push(`(saved_tracks pool truncated at scan_cap=${scanCap} — newest ${scanCap} only)`);
        return textResult(lines.join('\n'), {
          ok: true,
          dry_run: true,
          source: args.source,
          selected: picked.length,
          candidates_scanned: candidatesScanned,
          truncated_at_fetch_all_cap: truncatedAtCap,
          newest_first: args.source === 'saved_tracks',
          scan_cap: scanCap,
          uris: picked.map((t) => t.uri),
        });
      }

      if (picked.length === 0) {
        throw new Error(
          'No candidate tracks matched — loosen artist_filter or try a wider source/time_range',
        );
      }

      const body: Record<string, unknown> = { name: args.name, public: args.public };
      if (args.description) body.description = args.description;
      const created = await client.post<{
        id: string;
        uri: string;
        external_urls?: { spotify?: string };
      }>('/me/playlists', body);
      if (!created?.id) throw new Error('Could not create playlist');

      const itemsPath = `/playlists/${encodeURIComponent(created.id)}/items`;
      let batches = 0;
      for (let start = 0; start < picked.length; start += 100) {
        await client.post(itemsPath, {
          uris: picked.slice(start, start + 100).map((t) => t.uri),
        });
        batches++;
      }

      const receipt = await issueReceipt(client, {
        kind: 'playlist_meta',
        id: created.id,
        uris: [],
      });

      return textResult(
        `Created ${visibility} smart playlist "${args.name}" (${picked.length} tracks from `
          + `${args.source}${args.time_range && args.source === 'top_tracks' ? `, ${args.time_range}` : ''})`
          + `\nID: ${created.id}\nURI: ${created.uri}\nURL: ${created.external_urls?.spotify ?? '(none)'}`
          + `\n${batchSummary(picked.length, picked.map((t) => t.uri))}`
          + `\n${formatReceipt(receipt)}`,
        {
          ok: true,
          playlist_id: created.id,
          playlist_uri: created.uri,
          source: args.source,
          added: picked.length,
          candidates_scanned: candidatesScanned,
          truncated_at_fetch_all_cap: truncatedAtCap,
          newest_first: args.source === 'saved_tracks',
          scan_cap: scanCap,
          batches_sent: batches,
          uris: picked.map((t) => t.uri),
          receipt: receipt as unknown as Record<string, unknown>,
        },
      );
    },
  );
}
