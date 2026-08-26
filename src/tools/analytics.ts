import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { SpotifyClient } from '../client.js';
import type {
  SpotifyTrack,
  SpotifyPaged,
  RecentlyPlayedResponse,
  RecentlyPlayedItem,
} from '../types/spotify.js';
import { ResponseFormat, MaxResults, resolveMaxResults } from '../shaping.js';
import type { ResponseFormatValue } from '../shaping.js';

// ---------------------------------------------------------------------------
// Listening report (issue #97)
//
// One aggregate tool over the personalization surface: top tracks + artists
// for BOTH the requested time_range and short_term (4 calls), plus up to 150
// recently-played entries via manual cursor walks (getAllPages is offset-based
// and explicitly does NOT support the recently-played after/before cursors).
//
// Platform facts baked in (live-verified): artist objects carry NO
// genres/followers/popularity on /me/top/artists — never referenced here.
// Track objects carry album.release_date (not modelled on SpotifyAlbumSimple,
// widened locally like search.ts / personalization.ts do).
// ---------------------------------------------------------------------------

/** /me/top/tracks rows include album.release_date even though the shared
 * SpotifyAlbumSimple models only the browse/search subset. */
type AnalyticsTrack = SpotifyTrack & {
  album: { release_date?: string } & Record<string, unknown>;
};

// Index signature keeps the handler's return assignable to the MCP SDK's
// CallToolResult (which requires {[k:string]: unknown}).
interface ToolOut {
  [k: string]: unknown;
  content: Array<{ type: 'text'; text: string }>;
  structuredContent?: Record<string, unknown>;
}

const timeRangeSchema = z
  .enum(['short_term', 'medium_term', 'long_term'])
  .optional()
  .describe('Window to report on. Default: medium_term');

const TOP_LIMIT = 50; // per-call fetch cap for /me/top/*
const RECENT_PAGE_SIZE = 50; // per-call cap for recently-played
const RECENT_MAX_PAGES = 3; // ≤3 cursor walks ⇒ ≤150 items

export interface ListeningReport {
  time_range: 'short_term' | 'medium_term' | 'long_term';
  fetched: {
    top_tracks_time_range: number;
    top_tracks_short_term: number;
    top_artists_time_range: number;
    top_artists_short_term: number;
    recently_played: number | null; // null when include_recent=false
    recent_pages_walked: number;
  };
  rising: Array<{ id: string; name: string; artists: string }>;
  constant: Array<{ id: string; name: string; artists: string }>;
  fading: Array<{ id: string; name: string; artists: string }>;
  era_histogram: Record<string, number>;
  discovery_ratio: number;
  discovery_counts: { new_in_short: number; short_total: number };
  repeat_overlap_count: number | null; // null when include_recent=false
  hour_buckets: Record<string, number> | null; // null when include_recent=false
}

/** Decade bucket for an album release_date ("YYYY…" ISO form), or "unknown". */
export function decadeOf(releaseDate: string | undefined | null): string {
  if (!releaseDate) return 'unknown';
  const year = Number.parseInt(releaseDate.slice(0, 4), 10);
  if (!Number.isFinite(year) || year <= 0) return 'unknown';
  return `${Math.floor(year / 10) * 10}s`;
}

/** Local-hour-of-day bucket label for a played_at timestamp. Buckets are
 * [start, start+4) so midnight rolls over cleanly: 23:xx → "20-23",
 * 00:xx → "00-03". */
export function hourBucketOf(playedAt: string): string {
  const h = new Date(playedAt).getHours();
  const start = Math.floor(h / 4) * 4;
  const pad = (n: number) => n.toString().padStart(2, '0');
  return `${pad(start)}-${pad(start + 3)}`;
}

function trackRow(t: AnalyticsTrack): { id: string; name: string; artists: string } {
  return {
    id: t.id,
    name: t.name,
    artists: t.artists.map((a) => a.name).join(', '),
  };
}

/**
 * Walk /me/player/recently-played by its `after` cursor (offset pagination is
 * NOT supported there). At most RECENT_MAX_PAGES calls of RECENT_PAGE_SIZE
 * items each.
 */
async function walkRecentlyPlayed(
  client: SpotifyClient,
): Promise<{ items: RecentlyPlayedItem[]; pages: number }> {
  const items: RecentlyPlayedItem[] = [];
  let afterCursor: string | undefined;
  let pages = 0;
  while (pages < RECENT_MAX_PAGES) {
    const params: Record<string, string> = { limit: String(RECENT_PAGE_SIZE) };
    if (afterCursor !== undefined) params.after = afterCursor;
    const page: RecentlyPlayedResponse | null = await client.get<RecentlyPlayedResponse>(
      '/me/player/recently-played',
      params,
    );
    pages += 1;
    const rows = page?.items ?? [];
    items.push(...rows.filter((r) => r?.track));
    // Stop on missing cursor or a short/empty page.
    if (!page?.cursors?.after || rows.length < RECENT_PAGE_SIZE) break;
    afterCursor = page.cursors.after;
  }
  return { items, pages };
}

function buildReport(args: {
  time_range: 'short_term' | 'medium_term' | 'long_term';
  include_recent: boolean;
  trTracks: AnalyticsTrack[];
  stTracks: AnalyticsTrack[];
  recent: RecentlyPlayedItem[] | null;
  recentPages: number;
  artistCounts: { tr: number; st: number };
}): ListeningReport {
  const { time_range, include_recent, trTracks, stTracks, recent, recentPages, artistCounts } =
    args;

  const trIds = new Set(trTracks.map((t) => t.id));
  const stIds = new Set(stTracks.map((t) => t.id));

  const rising = stTracks.filter((t) => !trIds.has(t.id)).map(trackRow);
  const constant = stTracks.filter((t) => trIds.has(t.id)).map(trackRow);
  const fading = trTracks.filter((t) => !stIds.has(t.id)).map(trackRow);

  // Era histogram across the requested window's tracks.
  const era_histogram: Record<string, number> = {};
  for (const t of trTracks) {
    const decade = decadeOf(t.album?.release_date);
    era_histogram[decade] = (era_histogram[decade] ?? 0) + 1;
  }

  const shortTotal = stTracks.length;
  const newInShort = rising.length;
  const discovery_ratio =
    shortTotal === 0 ? 0 : Math.round((newInShort / shortTotal) * 1000) / 1000;

  let repeat_overlap_count: number | null = null;
  let hour_buckets: Record<string, number> | null = null;
  if (include_recent && recent) {
    const recentTrackIds = new Set(recent.map((r) => r.track.id));
    // UNIQUE top-track IDs across either window that show up in history.
    const topIds = new Set([...trIds, ...stIds]);
    repeat_overlap_count = [...topIds].filter((id) => recentTrackIds.has(id)).length;
    hour_buckets = {};
    for (const r of recent) {
      const bucket = hourBucketOf(r.played_at);
      hour_buckets[bucket] = (hour_buckets[bucket] ?? 0) + 1;
    }
  }

  return {
    time_range,
    fetched: {
      top_tracks_time_range: trTracks.length,
      top_tracks_short_term: stTracks.length,
      top_artists_time_range: artistCounts.tr,
      top_artists_short_term: artistCounts.st,
      recently_played: include_recent ? (recent ? recent.length : null) : null,
      recent_pages_walked: recentPages,
    },
    rising,
    constant,
    fading,
    era_histogram,
    discovery_ratio,
    discovery_counts: { new_in_short: newInShort, short_total: shortTotal },
    repeat_overlap_count,
    hour_buckets,
  };
}

function proseDigest(report: ListeningReport, maxNames: number): string {
  const lines: string[] = [];
  lines.push(`Listening report (${report.time_range} vs short_term):`);
  lines.push(
    `Top tracks fetched: ${report.fetched.top_tracks_time_range} (${report.time_range}), ` +
      `${report.fetched.top_tracks_short_term} (short_term); artists: ` +
      `${report.fetched.top_artists_time_range}/${report.fetched.top_artists_short_term}.`,
  );

  if (report.fetched.top_tracks_time_range === 0 && report.fetched.top_tracks_short_term === 0) {
    lines.push('No listening data found — nothing to classify.');
    return lines.join('\n');
  }

  lines.push(
    `Rising: ${report.rising.length} | Constant: ${report.constant.length} | ` +
      `Fading: ${report.fading.length} | Discovery ratio: ${report.discovery_ratio}`,
  );
  const namedLists = [
    ['Rising', report.rising],
    ['Fading', report.fading],
  ] as const;
  for (const [label, list] of namedLists) {
    if (list.length > 0) {
      const names = list
        .slice(0, maxNames)
        .map((t) => `"${t.name}"`)
        .join(', ');
      const more = list.length > maxNames ? ` (+${list.length - maxNames} more)` : '';
      lines.push(`  ${label}: ${names}${more}`);
    }
  }

  const eras = Object.entries(report.era_histogram);
  if (eras.length > 0) {
    lines.push(`Eras: ${eras.map(([decade, n]) => `${decade}×${n}`).join(', ')}`);
  }

  if (report.repeat_overlap_count !== null) {
    const pages =
      report.fetched.recent_pages_walked === 1
        ? '1 page'
        : `${report.fetched.recent_pages_walked} pages`;
    lines.push(
      `Recently played: ${report.fetched.recently_played} items (${pages}); ` +
        `top-track repeats in history: ${report.repeat_overlap_count}`,
    );
    const buckets = Object.entries(report.hour_buckets ?? {});
    if (buckets.length > 0) {
      lines.push(`Hours: ${buckets.map(([b, n]) => `${b}×${n}`).join(', ')}`);
    }
  } else {
    lines.push('Recently played skipped (include_recent=false).');
  }
  return lines.join('\n');
}

function shapeResultGeneric(rf: ResponseFormatValue, prose: string, payload: Record<string, unknown>): ToolOut {
  return {
    content: [{ type: 'text', text: rf === 'json' ? JSON.stringify(payload, null, 2) : prose }],
    structuredContent: { ...payload },
  };
}

function shapeResult(rf: ResponseFormatValue, prose: string, payload: ListeningReport): ToolOut {
  return {
    content: [{ type: 'text', text: rf === 'json' ? JSON.stringify(payload, null, 2) : prose }],
    structuredContent: { ...payload },
  };
}

export function registerAnalyticsTools(server: McpServer, client: SpotifyClient): void {
  // listening_streaks — consecutive-day streaks from recently-played
  server.tool(
    'listening_streaks',
    'Compute consecutive-day listening streaks from recently-played history (up to 150 items). Quota: GET /me/player/recently-played cursor walk.',
    {
      max_items: z.coerce.number().int().positive().max(150).optional().describe('Max history items to walk (default 150)'),
      response_format: ResponseFormat,
    },
    async (args) => {
      const rf: ResponseFormatValue = args.response_format ?? 'concise';
      const walk = await walkRecentlyPlayed(client);
      const dates = [...new Set(walk.items.map((r) => r.played_at.slice(0, 10)))].sort();
      if (dates.length === 0) return shapeResultGeneric(rf, 'No listening history — no streaks.', { ok: true, streaks: [], current_streak: 0, longest_streak: 0, dates: [] });
      const streaks: Array<{ start: string; end: string; length: number }> = [];
      let curStart = dates[0]; let curLen = 1;
      for (let i = 1; i < dates.length; i++) {
        const prev = new Date(dates[i - 1] + 'T00:00:00Z').getTime();
        const cur = new Date(dates[i] + 'T00:00:00Z').getTime();
        if (cur - prev === 86400000) curLen++;
        else { streaks.push({ start: curStart, end: dates[i - 1], length: curLen }); curStart = dates[i]; curLen = 1; }
      }
      streaks.push({ start: curStart, end: dates[dates.length - 1], length: curLen });
      const longest = Math.max(...streaks.map((s) => s.length));
      const todayStr = new Date().toISOString().slice(0, 10);
      const current = dates[dates.length - 1] === todayStr ? streaks[streaks.length - 1].length : (dates[dates.length - 1] === new Date(Date.now() - 86400000).toISOString().slice(0, 10) ? streaks[streaks.length - 1].length : 0);
      const payload = { ok: true, dates_count: dates.length, streaks, longest_streak: longest, current_streak: current };
      return shapeResultGeneric(rf, `Listening streaks: ${streaks.length} streak(s), longest ${longest} day(s), current ${current} day(s).`, payload);
    },
  );

  // top_artists_by_range — expose /me/top/artists across windows with deltas
  server.tool(
    'top_artists_by_range',
    'Top artists for each time window with rank deltas (short vs long). Quota: up to 3× GET /me/top/artists.',
    {
      time_range: z.enum(['short_term', 'medium_term', 'long_term', 'all']).optional().default('all').describe('Window or all'),
      limit: z.coerce.number().int().positive().max(50).optional().default(20).describe('Limit per window'),
      response_format: ResponseFormat,
    },
    async (args) => {
      const rf: ResponseFormatValue = args.response_format ?? 'concise';
      const limit = String(args.limit ?? 20);
      const ranges = args.time_range === 'all' ? (['short_term', 'medium_term', 'long_term'] as const) : [args.time_range as 'short_term' | 'medium_term' | 'long_term'];
      const results: Record<string, Array<{ id: string; name: string; rank: number }>> = {};
      for (const tr of ranges) {
        const res = await client.get<SpotifyPaged<{ id: string; name: string }>>('/me/top/artists', { time_range: tr, limit });
        results[tr] = (res?.items ?? []).map((a, i) => ({ id: a.id, name: (a as { name?: string }).name ?? a.id, rank: i + 1 }));
      }
      const payload: Record<string, unknown> = { ok: true, ranges: results };
      if (ranges.length === 2) {
        const [a, b] = ranges;
        const bMap = new Map(results[b].map((x) => [x.id, x.rank]));
        const deltas = results[a].map((x) => ({ id: x.id, name: x.name, delta: (bMap.get(x.id) ?? 999) - x.rank }));
        (payload as Record<string, unknown>).deltas = deltas;
      }
      return shapeResultGeneric(rf, `Top artists by range: ${ranges.map((r) => `${r}×${results[r].length}`).join(', ')}.`, payload);
    },
  );

  // taste_shift_report — compare short vs long windows
  server.tool(
    'taste_shift_report',
    'Compare short_term vs long_term top artists+tracks: rising/falling + Jaccard similarity. Quota: 4× GET /me/top/*.',
    {
      limit: z.coerce.number().int().positive().max(50).optional().default(20).describe('Limit per window'),
      response_format: ResponseFormat,
    },
    async (args) => {
      const rf: ResponseFormatValue = args.response_format ?? 'concise';
      const limit = String(args.limit ?? 20);
      const [stTracks, ltTracks, stArtists, ltArtists] = await Promise.all([
        client.get<SpotifyPaged<{ id: string; name: string }>>('/me/top/tracks', { time_range: 'short_term', limit }),
        client.get<SpotifyPaged<{ id: string; name: string }>>('/me/top/tracks', { time_range: 'long_term', limit }),
        client.get<SpotifyPaged<{ id: string; name: string }>>('/me/top/artists', { time_range: 'short_term', limit }),
        client.get<SpotifyPaged<{ id: string; name: string }>>('/me/top/artists', { time_range: 'long_term', limit }),
      ]);
      const jaccard = (a: Set<string>, b: Set<string>) => { const inter = [...a].filter((x) => b.has(x)).length; const uni = new Set([...a, ...b]).size; return uni === 0 ? 1 : Math.round((inter / uni) * 1000) / 1000; };
      const stT = new Set((stTracks?.items ?? []).map((t) => t.id));
      const ltT = new Set((ltTracks?.items ?? []).map((t) => t.id));
      const stA = new Set((stArtists?.items ?? []).map((a) => a.id));
      const ltA = new Set((ltArtists?.items ?? []).map((a) => a.id));
      const payload = {
        ok: true,
        tracks: { jaccard: jaccard(stT, ltT), rising: [...stT].filter((x) => !ltT.has(x)).slice(0, 10), falling: [...ltT].filter((x) => !stT.has(x)).slice(0, 10) },
        artists: { jaccard: jaccard(stA, ltA), rising: [...stA].filter((x) => !ltA.has(x)).slice(0, 10), falling: [...ltA].filter((x) => !stA.has(x)).slice(0, 10) },
      };
      return shapeResultGeneric(rf, `Taste shift: tracks Jaccard ${payload.tracks.jaccard}, artists Jaccard ${payload.artists.jaccard}. Rising tracks: ${payload.tracks.rising.slice(0, 3).join(', ') || '—'}.`, payload);
    },
  );

  server.tool(
    'listening_report',
    'Aggregate listening report: compares your top tracks between two time windows (rising / constant / fading), plus era histogram, discovery ratio, repeat overlap with recently played, and hour-of-day buckets',
    {
      time_range: timeRangeSchema,
      include_recent: z
        .boolean()
        .optional()
        .describe(
          'Include recently-played analysis (repeat overlap + hour buckets). Default: true',
        ),
      response_format: ResponseFormat,
      max_results: MaxResults,
    },
    async (args) => {
      const time_range = args.time_range ?? 'medium_term';
      const include_recent = args.include_recent ?? true;
      const rf: ResponseFormatValue = args.response_format ?? 'concise';
      const topParams = { limit: String(TOP_LIMIT) };

      // 4 fixed top-* calls. Null responses degrade to empty lists so a
      // sparse account still yields a zeroed report rather than a crash.
      const [trTracksRes, stTracksRes, trArtistsRes, stArtistsRes] = await Promise.all([
        client.get<SpotifyPaged<AnalyticsTrack>>('/me/top/tracks', {
          ...topParams,
          time_range,
        }),
        client.get<SpotifyPaged<AnalyticsTrack>>('/me/top/tracks', {
          ...topParams,
          time_range: 'short_term',
        }),
        client.get<SpotifyPaged<{ id: string }>>('/me/top/artists', {
          ...topParams,
          time_range,
        }),
        client.get<SpotifyPaged<{ id: string }>>('/me/top/artists', {
          ...topParams,
          time_range: 'short_term',
        }),
      ]);

      const trTracks = (trTracksRes?.items ?? []).filter((t) => t?.id != null);
      const stTracks = (stTracksRes?.items ?? []).filter((t) => t?.id != null);

      let recent: RecentlyPlayedItem[] | null = null;
      let recentPages = 0;
      if (include_recent) {
        const walk = await walkRecentlyPlayed(client);
        recent = walk.items;
        recentPages = walk.pages;
      }

      const payload = buildReport({
        time_range,
        include_recent,
        trTracks,
        stTracks,
        recent,
        recentPages,
        artistCounts: {
          tr: (trArtistsRes?.items ?? []).filter((a) => a?.id != null).length,
          st: (stArtistsRes?.items ?? []).filter((a) => a?.id != null).length,
        },
      });

      const maxNames = resolveMaxResults(args.max_results);
      return shapeResult(rf, proseDigest(payload, maxNames), payload);
    },
  );
}
