/**
 * create_smart_playlist (#172): rule-based playlist generation from the
 * user's OWN listening data — top tracks, recently played, or saved tracks —
 * with optional artist filtering and per-artist uniqueness. No deprecated
 * recommendations endpoint involved.
 *
 * Every source draws from a BOUNDED candidate pool (#809): top_tracks reads
 * two pages (ceiling 100), recently_played walks the newest-first cursor
 * chain until `limit` distinct candidates exist (ceiling scan_cap), and
 * saved_tracks reads `scan_cap` newest entries. When a ceiling binds the read,
 * `pool_capped` / `pool_cap` and the prose both say so on the dry-run and the
 * commit path, so a bounded prefix is never read as a complete ranking.
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
  ResponseFormat,
  batchSummary,
  truncateItems,
} from '../shaping.js';
import { getConfig } from '../config.js';
import { issueReceipt, formatReceipt } from '../receipts.js';
import { timeRangeSchema } from './personalization.js';
import type {
  RecentlyPlayedResponse,
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

/** A candidate pool plus the bound that produced it (#809). */
interface CandidatePool {
  candidates: SpotifyTrack[];
  /**
   * Size of the bounded pool actually read, or null when the source was read
   * to its end (no ceiling bound the walk).
   */
  cap: number | null;
  /** True when the pool is a bounded prefix of the source, not a complete ranking. */
  capped: boolean;
  /** True when the scan_cap/fetch-all ceiling — not the source running out — stopped the read. */
  truncatedAtFetchAllCap: boolean;
}

/** /me/top/tracks is read as two offset pages; that 100 is the source's ceiling. */
const TOP_TRACKS_PAGE = 50;
const RECENT_PAGE_SIZE = 50;
const RECENT_MAX_PAGES = 20;

async function loadCandidates(
  client: SpotifyClient,
  source: string,
  opts: { scanCap: number; limit: number },
): Promise<CandidatePool> {
  switch (source) {
    case 'top_tracks': {
      // Two pages of 50 is the ceiling this source contributes, not a
      // suggestion: a full second page means the ranking continues past what
      // was read, so the pool is disclosed as capped (#809).
      const page1 = await client.get<SpotifyPaged<SpotifyTrack>>('/me/top/tracks', {
        limit: String(TOP_TRACKS_PAGE),
        offset: '0',
      });
      const page2 = await client.get<SpotifyPaged<SpotifyTrack>>('/me/top/tracks', {
        limit: String(TOP_TRACKS_PAGE),
        offset: String(TOP_TRACKS_PAGE),
      });
      const candidates = [...(page1?.items ?? []), ...(page2?.items ?? [])].filter((t) => t?.uri);
      const capped = (page1?.items?.length ?? 0) >= TOP_TRACKS_PAGE
        && (page2?.items?.length ?? 0) >= TOP_TRACKS_PAGE;
      return {
        candidates,
        cap: capped ? candidates.length : null,
        capped,
        truncatedAtFetchAllCap: false,
      };
    }
    case 'recently_played': {
      // Walk newest → older until `limit` distinct candidates exist. The ceiling
      // is `scan_cap` (default fetchAllCap) and the walk never exceeds it, so
      // the bound the schema advertises is the bound actually applied. The
      // endpoint hands back a freshest-first page whose `cursors.after` must be
      // supplied as `before` to reach older plays (same descent as
      // analytics.ts / personalization.ts, #806).
      const walkCap = Math.min(opts.scanCap, getConfig().fetchAllCap);
      const want = Math.min(Math.max(1, opts.limit), walkCap);
      const maxPages = Math.min(RECENT_MAX_PAGES, Math.ceil(want / RECENT_PAGE_SIZE) + 1);
      const candidates: SpotifyTrack[] = [];
      const seen = new Set<string>();
      let before: string | undefined;
      let historyEnd = false;
      let pages = 0;
      while (candidates.length < want && pages < maxPages) {
        const params: Record<string, string> = { limit: String(RECENT_PAGE_SIZE) };
        if (before !== undefined) params.before = before;
        const page: RecentlyPlayedResponse | null = await client.get<RecentlyPlayedResponse>(
          '/me/player/recently-played',
          params,
        );
        pages++;
        if (!page) throw new Error('Could not retrieve recently played tracks');
        const rows = page.items ?? [];
        for (const item of rows) {
          const t = item?.track;
          if (!t?.uri || seen.has(t.uri)) continue;
          seen.add(t.uri);
          candidates.push(t);
          if (candidates.length >= want) break;
        }
        if (candidates.length >= want) break;
        // A short page is the end of history; anything else has to be proved by
        // a fresh cursor, so a stuck or absent cursor is reported as capped
        // rather than silently read as "that was all of it".
        if (rows.length < RECENT_PAGE_SIZE) { historyEnd = true; break; }
        const next = page.cursors?.after ? String(page.cursors.after) : null;
        if (next === null || next === before) break;
        before = next;
      }
      const capped = !historyEnd;
      return {
        candidates,
        cap: capped ? candidates.length : null,
        capped,
        truncatedAtFetchAllCap: capped && want === walkCap && candidates.length >= walkCap,
      };
    }
    default: {
      const cap = opts.scanCap;
      const saved = await client.getAllPages<SavedTrackItem>('/me/tracks', { limit: '50' }, { maxItems: cap });
      const candidates = saved.map((entry) => entry?.track).filter((t): t is SpotifyTrack => Boolean(t?.uri));
      const capped = candidates.length >= cap;
      return { candidates, cap: capped ? cap : null, capped, truncatedAtFetchAllCap: capped };
    }
  }
}

/**
 * Name the pool in prose, with its ceiling when one bound the read, so a
 * bounded pool is never presented as a complete ranking (#809).
 */
function poolSourceLabel(source: string, pool: CandidatePool, timeRange?: string): string {
  const suffix = timeRange && source === 'top_tracks' ? ` (${timeRange})` : '';
  if (!pool.capped || pool.cap === null) return `${source}${suffix}`;
  const scope = source === 'top_tracks'
    ? `the top ${pool.cap} of your${timeRange ? ` ${timeRange}` : ''} ranking`
    : `the newest ${pool.cap} of your ${source === 'recently_played' ? 'recently played history' : 'saved tracks'}`;
  return `${scope} (source=${source}${suffix})`;
}

/** The dedicated disclosure line, mirroring `pool_capped` / `pool_cap`. */
function poolCapLine(source: string, pool: CandidatePool): string | null {
  if (!pool.capped || pool.cap === null) return null;
  if (source === 'top_tracks') {
    return `(top_tracks pool capped at ${pool.cap} — the top ${pool.cap} tracks only, ranks beyond ${pool.cap} were not read)`;
  }
  if (source === 'recently_played') {
    return `(recently_played pool capped at ${pool.cap} — the newest ${pool.cap} plays only, older history was not read)`;
  }
  return `(saved_tracks pool truncated at scan_cap=${pool.cap} — newest ${pool.cap} only)`;
}

export function registerSmartTools(server: McpServer, client: SpotifyClient): void {
  server.tool(
    'create_smart_playlist',
    'Create a playlist from rules over your own listening data: top tracks (by time range), '
      + 'recently played, or saved tracks — with optional artist-name filtering and a '
      + 'one-track-per-artist toggle. Every source reads a bounded pool and discloses the bound '
      + 'when it truncates the ranking (top_tracks caps at 100; recently_played walks until '
      + '`limit` candidates exist; saved_tracks caps at scan_cap): pool_capped is true and '
      + 'pool_cap names it, so a capped pool is never read as a complete ranking. '
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
      scan_cap: z.number().int().min(1).max(10000).optional().describe('How many saved tracks to scan when source=saved_tracks; also the walk ceiling for source=recently_played; default SPOTIFY_MCP_FETCH_ALL_CAP (500). Reports truncation when hit.'),
      response_format: ResponseFormat,
      dry_run: DryRun,
    },
    async (args) => {
      const scanCap = args.scan_cap ?? getConfig().fetchAllCap;
      const pool = await loadCandidates(client, args.source, { scanCap, limit: args.limit });
      const candidatesScanned = pool.candidates.length;
      // The payload fields are identical on the dry-run and commit paths so a
      // preview cannot disagree with what the real run reports (#809).
      const poolFields = {
        candidates_scanned: candidatesScanned,
        pool_capped: pool.capped,
        pool_cap: pool.cap,
        truncated_at_fetch_all_cap: pool.truncatedAtFetchAllCap,
        newest_first: args.source === 'saved_tracks',
        scan_cap: scanCap,
      };
      let candidates = dedupeUris(pool.candidates);

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
            + `from ${poolSourceLabel(args.source, pool, args.time_range)}`
            + ':',
          ...view.items.map((t) => `• ${t.artists.map((a) => a.name).join(', ')} — ${t.name}`),
          ...(view.footer ? [view.footer] : []),
        ];
        const capLine = poolCapLine(args.source, pool);
        if (capLine) lines.push(capLine);
        return textResult(lines.join('\n'), {
          ok: true,
          dry_run: true,
          source: args.source,
          selected: picked.length,
          ...poolFields,
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

      const commitCapLine = poolCapLine(args.source, pool);
      return textResult(
        `Created ${visibility} smart playlist "${args.name}" (${picked.length} tracks from `
          + `${poolSourceLabel(args.source, pool, args.time_range)})`
          + `\nID: ${created.id}\nURI: ${created.uri}\nURL: ${created.external_urls?.spotify ?? '(none)'}`
          + `\n${batchSummary(picked.length, picked.map((t) => t.uri))}`
          + (commitCapLine ? `\n${commitCapLine}` : '')
          + `\n${formatReceipt(receipt)}`,
        {
          ok: true,
          playlist_id: created.id,
          playlist_uri: created.uri,
          source: args.source,
          added: picked.length,
          ...poolFields,
          batches_sent: batches,
          uris: picked.map((t) => t.uri),
          receipt: receipt as unknown as Record<string, unknown>,
        },
      );
    },
  );
}
