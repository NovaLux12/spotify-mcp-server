/**
 * swarm3 analytics slice — 500-tool swarm v1.26.0 (issue #442). Owned by ANALYTICS builder.
 *
 * All 24 tools are read-only analytics over the personalization surface:
 *   • /me/player/recently-played (cursor walk — offset pagination NOT supported there)
 *   • /me/top/tracks + /me/top/artists (time_range windows)
 *   • /artists?ids=… batch (genres only, for the genre census)
 *
 * House conventions honoured here:
 *   • shaping.ts helpers only (ResponseFormat / MaxResults / resolveMaxResults /
 *     truncateItems / paginationInfo); no hand-rolled shaping.
 *   • NO removed endpoints (SPEC §9): no audio-features, audio-analysis,
 *     recommendations, related-artists, genres-from-seed.
 *   • NO popularity / followers / available_markets fields — never read.
 *     Live-verified: /me/top/artists rows carry no genres either, so the genre
 *     census resolves genres via the batch /artists endpoint (allowed).
 *   • Track objects widened locally to expose album.release_date (same as
 *     analytics.ts / search.ts / personalization.ts).
 *   • Deterministic output ordering; stable property names.
 */
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { SpotifyClient } from '../client.js';
import {
  ResponseFormat,
  MaxResults,
  resolveMaxResults,
  truncateItems,
  paginationInfo,
} from '../shaping.js';
import type { ResponseFormatValue } from '../shaping.js';
import { spotifyId } from '../refs.js';
import type {
  SpotifyPaged,
  RecentlyPlayedItem,
  RecentlyPlayedResponse,
  SpotifyTrack,
} from '../types/spotify.js';

type TextContent = { type: 'text'; text: string };
interface ToolOut {
  [k: string]: unknown;
  content: TextContent[];
  structuredContent?: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Shared plumbing
// ---------------------------------------------------------------------------

/** shape(): json mode stringifies the payload; payload always rides as structuredContent. */
function shape(rf: ResponseFormatValue, prose: string, payload: Record<string, unknown>): ToolOut {
  return {
    content: [{ type: 'text', text: rf === 'json' ? JSON.stringify(payload, null, 2) : prose }],
    structuredContent: payload,
  };
}

const empty = (rf: ResponseFormatValue, why: string): ToolOut =>
  shape(rf, why, { ok: true, empty: true, reason: why });

/** /me/top/tracks rows include album.release_date even though the shared
 * SpotifyAlbumSimple models only the browse/search subset (same widening as
 * analytics.ts). */
type AnalyticsTrack = SpotifyTrack & {
  album: { release_date?: string } & Record<string, unknown>;
};

/** Recently-played track rows widened for the same reason. */
type RecentTrack = SpotifyTrack & {
  album: { release_date?: string; name?: string } & Record<string, unknown>;
};

const TIME_RANGES = ['short_term', 'medium_term', 'long_term'] as const;
type TimeRangeValue = (typeof TIME_RANGES)[number];

const TimeRange = z
  .enum(['short_term', 'medium_term', 'long_term'])
  .optional()
  .default('medium_term')
  .describe('Time window: short_term (~4 weeks), medium_term (~6 months), long_term (all time). Default: medium_term');

const RecentLimit = z.coerce
  .number()
  .int()
  .positive()
  .max(500)
  .optional()
  .describe('Max recently-played items to walk (default 150; the API pages 50 per call).');

const WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'] as const;
const DAYPARTS = ['night', 'morning', 'afternoon', 'evening'] as const;

const RECENT_PAGE = 50; // per-call cap for recently-played
const TOP_LIMIT = 50; // per-call cap for /me/top/*

function pad2(n: number): string {
  return n.toString().padStart(2, '0');
}

function playedAtMs(iso: string): number {
  return new Date(iso).getTime();
}

function localHour(iso: string): number {
  return new Date(iso).getHours();
}

function localWeekday(iso: string): string {
  return WEEKDAYS[(new Date(iso).getDay() + 6) % 7];
}

function localDate(iso: string): string {
  return iso.slice(0, 10);
}

function daypartOf(hour: number): (typeof DAYPARTS)[number] {
  if (hour < 6) return 'night';
  if (hour < 12) return 'morning';
  if (hour < 18) return 'afternoon';
  return 'evening';
}

/** Decade bucket for an album release_date, or "unknown". */
export function swarm3DecadeOf(releaseDate: string | undefined | null): string {
  if (!releaseDate) return 'unknown';
  const year = Number.parseInt(releaseDate.slice(0, 4), 10);
  if (!Number.isFinite(year) || year <= 0) return 'unknown';
  return `${Math.floor(year / 10) * 10}s`;
}

function bump(map: Record<string, number>, key: string, by = 1): void {
  map[key] = (map[key] ?? 0) + by;
}

function sortedEntries(hist: Record<string, number>): Array<[string, number]> {
  return Object.entries(hist).sort((a, b) => (b[1] - a[1]) || a[0].localeCompare(b[0]));
}

/** Percent helper — one decimal, deterministic. */
function pct(part: number, whole: number): number {
  return whole === 0 ? 0 : Math.round((part / whole) * 1000) / 10;
}

function trackArtists(t: { artists: Array<{ name: string }> }): string {
  return t.artists.map((a) => a.name).join(', ');
}

/** Chronological (oldest-first) copy of a recently-played walk. */
function chronological(items: RecentlyPlayedItem[]): RecentlyPlayedItem[] {
  return [...items].sort((a, b) => playedAtMs(a.played_at) - playedAtMs(b.played_at));
}

/**
 * Walk /me/player/recently-played by its `after` cursor. Newest entries come
 * first; at most 10 cursor pages of 50 (API hard cap ≈ 50 recent items of
 * depth in practice, but the walk stays correct regardless).
 */
async function walkRecentlyPlayed(
  client: SpotifyClient,
  maxItems: number,
): Promise<{ items: RecentlyPlayedItem[]; pages: number }> {
  const items: RecentlyPlayedItem[] = [];
  let afterCursor: string | undefined;
  let pages = 0;
  while (pages < 10) {
    const params: Record<string, string> = { limit: String(RECENT_PAGE) };
    if (afterCursor !== undefined) params.after = afterCursor;
    const page: RecentlyPlayedResponse | null = await client.get<RecentlyPlayedResponse>(
      '/me/player/recently-played',
      params,
    );
    pages += 1;
    const rows = (page?.items ?? []).filter((r) => r?.track?.id);
    items.push(...rows);
    if (items.length >= maxItems) {
      items.length = maxItems;
      break;
    }
    if (!page?.cursors?.after || rows.length < RECENT_PAGE) break;
    afterCursor = page.cursors.after;
  }
  return { items, pages };
}

/** Default history depth when a tool takes max_items. */
function recentDepth(explicit: number | undefined): number {
  return typeof explicit === 'number' && Number.isFinite(explicit) && explicit > 0
    ? Math.min(Math.floor(explicit), 500)
    : 150;
}

async function fetchTopArtists(
  client: SpotifyClient,
  timeRange: string,
  limit: number,
): Promise<Array<{ id: string; name: string }>> {
  const res = await client.get<SpotifyPaged<{ id: string; name?: string }>>('/me/top/artists', {
    time_range: timeRange,
    limit: String(limit),
  });
  return (res?.items ?? [])
    .filter((a) => a?.id != null)
    .map((a) => ({ id: a.id, name: a.name ?? a.id }));
}

async function fetchTopTracks(
  client: SpotifyClient,
  timeRange: string,
  limit: number,
): Promise<AnalyticsTrack[]> {
  const res = await client.get<SpotifyPaged<AnalyticsTrack>>('/me/top/tracks', {
    time_range: timeRange,
    limit: String(limit),
  });
  return (res?.items ?? []).filter((t) => t?.id != null);
}

function topTrackRow(t: AnalyticsTrack): { id: string; name: string; artists: string } {
  return { id: t.id, name: t.name, artists: trackArtists(t) };
}

function recentTrackRow(r: RecentlyPlayedItem): {
  id: string;
  name: string;
  artists: string;
  played_at: string;
} {
  return {
    id: r.track.id,
    name: r.track.name,
    artists: trackArtists(r.track),
    played_at: r.played_at,
  };
}

/** Per-artist/per-track play counts over a history walk. */
function playCounts(items: RecentlyPlayedItem[]): {
  byTrack: Map<string, { name: string; artists: string; plays: number; last: string }>;
  byArtist: Map<string, { name: string; plays: number; tracks: Set<string>; first: string; last: string }>;
  totalPlays: number;
} {
  const byTrack = new Map<string, { name: string; artists: string; plays: number; last: string }>();
  const byArtist = new Map<string, { name: string; plays: number; tracks: Set<string>; first: string; last: string }>();
  for (const r of items) {
    const t = r.track as unknown as RecentTrack;
    const tr = byTrack.get(t.id) ?? { name: t.name, artists: trackArtists(t), plays: 0, last: r.played_at };
    tr.plays += 1;
    if (r.played_at > tr.last) tr.last = r.played_at;
    byTrack.set(t.id, tr);
    for (const a of t.artists) {
      if (!a?.id) continue;
      const cur = byArtist.get(a.id) ?? { name: a.name, plays: 0, tracks: new Set<string>(), first: r.played_at, last: r.played_at };
      cur.plays += 1;
      cur.tracks.add(t.id);
      if (r.played_at < cur.first) cur.first = r.played_at;
      if (r.played_at > cur.last) cur.last = r.played_at;
      byArtist.set(a.id, cur);
    }
  }
  return { byTrack, byArtist, totalPlays: items.length };
}

/** Day-level listening stats (oldest→newest) from a chronological walk. */
function dayStats(chron: RecentlyPlayedItem[]): Array<{
  date: string;
  plays: number;
  unique_tracks: number;
  unique_artists: number;
}> {
  const days = new Map<string, { tracks: Set<string>; artists: Set<string>; plays: number }>();
  for (const r of chron) {
    const d = localDate(r.played_at);
    const cur = days.get(d) ?? { tracks: new Set<string>(), artists: new Set<string>(), plays: 0 };
    cur.plays += 1;
    cur.tracks.add(r.track.id);
    for (const a of r.track.artists) cur.artists.add(a.id);
    days.set(d, cur);
  }
  return [...days.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([date, s]) => ({
      date,
      plays: s.plays,
      unique_tracks: s.tracks.size,
      unique_artists: s.artists.size,
    }));
}

function median(nums: number[]): number {
  if (nums.length === 0) return 0;
  const s = [...nums].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 === 1 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

export function registerSwarm3AnalyticsTools(server: McpServer, client: SpotifyClient): void {
  // 1. top_artist_ranking_delta — rank movement between two top-artist windows
  server.tool(
    'top_artist_ranking_delta',
    'Show how each top artist’s rank moved between two time windows (climbers first; default compares short_term against medium_term). Quota: 2× GET /me/top/artists.',
    {
      base_range: TimeRange.describe('Baseline window. Default: medium_term'),
      compare_range: z
        .enum(['short_term', 'medium_term', 'long_term'])
        .optional()
        .default('short_term')
        .describe('Window to compare against the baseline. Default: short_term'),
      limit: z.coerce.number().int().positive().max(50).optional().default(20).describe('Artists per window (default 20).'),
      response_format: ResponseFormat,
    },
    async (args) => {
      const rf = args.response_format;
      if (args.base_range === args.compare_range) {
        return empty(rf, 'base_range and compare_range must differ.');
      }
      const limit = Math.min(args.limit ?? 20, TOP_LIMIT);
      const [base, comp] = await Promise.all([
        fetchTopArtists(client, args.base_range, limit),
        fetchTopArtists(client, args.compare_range, limit),
      ]);
      const baseRank = new Map(base.map((a, i) => [a.id, i + 1]));
      const rows = comp.map((a, i) => {
        const br = baseRank.get(a.id);
        return {
          id: a.id,
          name: a.name,
          compare_rank: i + 1,
          base_rank: br ?? null,
          delta: br === undefined ? null : br - (i + 1),
          status: br === undefined ? 'new' : br - (i + 1) > 0 ? 'up' : br - (i + 1) < 0 ? 'down' : 'flat',
        };
      });
      rows.sort((x, y) => (y.delta ?? limit + 1) - (x.delta ?? limit + 1) || x.compare_rank - y.compare_rank);
      const counts: Record<string, number> = { up: 0, down: 0, flat: 0, new: 0 };
      for (const r of rows) counts[r.status] += 1;
      const dropped = base.filter((a) => !rows.some((r) => r.id === a.id)).map((a) => ({ id: a.id, name: a.name }));
      const payload = {
        ok: true,
        base_range: args.base_range,
        compare_range: args.compare_range,
        counts,
        movers: rows,
        dropped_from_base: dropped,
      };
      const top = rows.slice(0, 5).map((r) => `#${r.compare_rank} ${r.name} (${r.status}${r.delta === null ? '' : ` ${r.delta > 0 ? '+' : ''}${r.delta}`})`).join(', ');
      return shape(rf, `Artist rank delta ${args.compare_range} vs ${args.base_range}: ${counts.up} up, ${counts.down} down, ${counts.flat} flat, ${counts.new} new. Top movers: ${top || '—'}.`, payload);
    },
  );

  // 2. top_track_ranking_delta — rank movement between two top-track windows
  server.tool(
    'top_track_ranking_delta',
    'Show how each top track’s rank moved between two time windows (climbers first; default compares short_term against medium_term). Quota: 2× GET /me/top/tracks.',
    {
      base_range: TimeRange.describe('Baseline window. Default: medium_term'),
      compare_range: z
        .enum(['short_term', 'medium_term', 'long_term'])
        .optional()
        .default('short_term')
        .describe('Window to compare against the baseline. Default: short_term'),
      limit: z.coerce.number().int().positive().max(50).optional().default(20).describe('Tracks per window (default 20).'),
      response_format: ResponseFormat,
    },
    async (args) => {
      const rf = args.response_format;
      if (args.base_range === args.compare_range) {
        return empty(rf, 'base_range and compare_range must differ.');
      }
      const limit = Math.min(args.limit ?? 20, TOP_LIMIT);
      const [base, comp] = await Promise.all([
        fetchTopTracks(client, args.base_range, limit),
        fetchTopTracks(client, args.compare_range, limit),
      ]);
      const baseRank = new Map(base.map((t, i) => [t.id, i + 1]));
      const rows = comp.map((t, i) => {
        const br = baseRank.get(t.id);
        return {
          ...topTrackRow(t),
          compare_rank: i + 1,
          base_rank: br ?? null,
          delta: br === undefined ? null : br - (i + 1),
          status: br === undefined ? 'new' : br - (i + 1) > 0 ? 'up' : br - (i + 1) < 0 ? 'down' : 'flat',
        };
      });
      rows.sort((x, y) => (y.delta ?? limit + 1) - (x.delta ?? limit + 1) || x.compare_rank - y.compare_rank);
      const counts: Record<string, number> = { up: 0, down: 0, flat: 0, new: 0 };
      for (const r of rows) counts[r.status] += 1;
      const dropped = base.filter((t) => !rows.some((r) => r.id === t.id)).map(topTrackRow);
      const payload = {
        ok: true,
        base_range: args.base_range,
        compare_range: args.compare_range,
        counts,
        movers: rows,
        dropped_from_base: dropped,
      };
      const top = rows.slice(0, 5).map((r) => `"${r.name}" (${r.status}${r.delta === null ? '' : ` ${r.delta > 0 ? '+' : ''}${r.delta}`})`).join(', ');
      return shape(rf, `Track rank delta ${args.compare_range} vs ${args.base_range}: ${counts.up} up, ${counts.down} down, ${counts.flat} flat, ${counts.new} new. Top movers: ${top || '—'}.`, payload);
    },
  );

  // 3. top_artist_leaderboard — points-scored artists across all three windows
  server.tool(
    'top_artist_leaderboard',
    'Score top artists across all three time windows with recency-weighted points (short×3, medium×2, long×1) and rank the combined leaderboard. Quota: 3× GET /me/top/artists.',
    {
      limit: z.coerce.number().int().positive().max(50).optional().default(30).describe('Artists fetched per window (default 30).'),
      max_results: MaxResults,
      response_format: ResponseFormat,
    },
    async (args) => {
      const rf = args.response_format;
      const limit = Math.min(args.limit ?? 30, TOP_LIMIT);
      const [st, mt, lt] = await Promise.all([
        fetchTopArtists(client, 'short_term', limit),
        fetchTopArtists(client, 'medium_term', limit),
        fetchTopArtists(client, 'long_term', limit),
      ]);
      const agg = new Map<string, { name: string; points: number; short: number | null; medium: number | null; long: number | null }>();
      const add = (list: Array<{ id: string; name: string }>, weight: number, key: 'short' | 'medium' | 'long') => {
        list.forEach((a, i) => {
          const cur = agg.get(a.id) ?? { name: a.name, points: 0, short: null, medium: null, long: null };
          cur.points += (limit - i) * weight;
          cur[key] = i + 1;
          agg.set(a.id, cur);
        });
      };
      add(st, 3, 'short');
      add(mt, 2, 'medium');
      add(lt, 1, 'long');
      const all = [...agg.entries()]
        .map(([id, v]) => ({ id, ...v }))
        .sort((a, b) => b.points - a.points || a.name.localeCompare(b.name));
      const tr = truncateItems(all, resolveMaxResults(args.max_results));
      const payload = {
        ok: true,
        windows: TIME_RANGES,
        scoring: 'points = (limit - rank + 1) × weight; weights short 3 / medium 2 / long 1',
        items: tr.items,
        pagination: paginationInfo({ total: tr.total, returned: tr.returned }),
      };
      const top3 = tr.items.slice(0, 3).map((a, i) => `${i + 1}. ${a.name} (${a.points} pts)`).join(', ');
      return shape(rf, `Artist leaderboard: ${all.length} scored. Top: ${top3 || '—'}.${tr.footer ? ` ${tr.footer}.` : ''}`, payload);
    },
  );

  // 4. top_track_leaderboard — points-scored tracks across all three windows
  server.tool(
    'top_track_leaderboard',
    'Score top tracks across all three time windows with recency-weighted points (short×3, medium×2, long×1) and rank the combined leaderboard. Quota: 3× GET /me/top/tracks.',
    {
      limit: z.coerce.number().int().positive().max(50).optional().default(30).describe('Tracks fetched per window (default 30).'),
      max_results: MaxResults,
      response_format: ResponseFormat,
    },
    async (args) => {
      const rf = args.response_format;
      const limit = Math.min(args.limit ?? 30, TOP_LIMIT);
      const [st, mt, lt] = await Promise.all([
        fetchTopTracks(client, 'short_term', limit),
        fetchTopTracks(client, 'medium_term', limit),
        fetchTopTracks(client, 'long_term', limit),
      ]);
      const agg = new Map<string, { name: string; artists: string; points: number; short: number | null; medium: number | null; long: number | null }>();
      const add = (list: AnalyticsTrack[], weight: number, key: 'short' | 'medium' | 'long') => {
        list.forEach((t, i) => {
          const cur = agg.get(t.id) ?? { name: t.name, artists: trackArtists(t), points: 0, short: null, medium: null, long: null };
          cur.points += (limit - i) * weight;
          cur[key] = i + 1;
          agg.set(t.id, cur);
        });
      };
      add(st, 3, 'short');
      add(mt, 2, 'medium');
      add(lt, 1, 'long');
      const all = [...agg.entries()]
        .map(([id, v]) => ({ id, ...v }))
        .sort((a, b) => b.points - a.points || a.name.localeCompare(b.name));
      const tr = truncateItems(all, resolveMaxResults(args.max_results));
      const payload = {
        ok: true,
        windows: TIME_RANGES,
        scoring: 'points = (limit - rank + 1) × weight; weights short 3 / medium 2 / long 1',
        items: tr.items,
        pagination: paginationInfo({ total: tr.total, returned: tr.returned }),
      };
      const top3 = tr.items.slice(0, 3).map((t, i) => `${i + 1}. "${t.name}" (${t.points} pts)`).join(', ');
      return shape(rf, `Track leaderboard: ${all.length} scored. Top: ${top3 || '—'}.${tr.footer ? ` ${tr.footer}.` : ''}`, payload);
    },
  );

  // 5. artist_velocity_report — short vs long rank velocity classification
  server.tool(
    'artist_velocity_report',
    'Classify each top artist’s momentum by comparing short_term and long_term ranks (surging / climbing / steady / slipping / falling / new_entry). Quota: 2× GET /me/top/artists.',
    {
      limit: z.coerce.number().int().positive().max(50).optional().default(40).describe('Artists per window (default 40).'),
      max_results: MaxResults,
      response_format: ResponseFormat,
    },
    async (args) => {
      const rf = args.response_format;
      const limit = Math.min(args.limit ?? 40, TOP_LIMIT);
      const [st, lt] = await Promise.all([
        fetchTopArtists(client, 'short_term', limit),
        fetchTopArtists(client, 'long_term', limit),
      ]);
      const longRank = new Map(lt.map((a, i) => [a.id, i + 1]));
      const rows = st.map((a, i) => {
        const lr = longRank.get(a.id);
        const vel = lr === undefined ? null : lr - (i + 1);
        const status =
          lr === undefined ? 'new_entry'
          : vel !== null && vel >= 20 ? 'surging'
          : vel !== null && vel >= 5 ? 'climbing'
          : vel !== null && vel > -5 ? 'steady'
          : vel !== null && vel > -20 ? 'slipping'
          : 'falling';
        return { id: a.id, name: a.name, short_rank: i + 1, long_rank: lr ?? null, velocity: vel, status };
      });
      rows.sort((a, b) => (b.velocity ?? limit + 1) - (a.velocity ?? limit + 1) || a.short_rank - b.short_rank);
      const counts: Record<string, number> = {};
      for (const r of rows) bump(counts, r.status);
      const tr = truncateItems(rows, resolveMaxResults(args.max_results));
      const payload = {
        ok: true,
        classification: 'surging ≥+20, climbing ≥+5, steady ±4, slipping ≤-5, falling ≤-20 (long minus short rank)',
        counts,
        items: tr.items,
        pagination: paginationInfo({ total: tr.total, returned: tr.returned }),
      };
      const movers = tr.items.filter((r) => r.status === 'surging' || r.status === 'climbing').slice(0, 3).map((r) => r.name).join(', ');
      return shape(rf, `Artist velocity: ${rows.length} classified — ${Object.entries(counts).map(([k, v]) => `${k}×${v}`).join(', ')}. Rising: ${movers || '—'}.`, payload);
    },
  );

  // 6. track_rotation_report — how heavily each track rotates in history
  server.tool(
    'track_rotation_report',
    'Report how many times each track appears in recently-played history and bucket them into heavy/regular/light rotation (default 150 history items). Quota: GET /me/player/recently-played cursor walk.',
    {
      max_items: RecentLimit,
      max_results: MaxResults,
      response_format: ResponseFormat,
    },
    async (args) => {
      const rf = args.response_format;
      const walk = await walkRecentlyPlayed(client, recentDepth(args.max_items));
      if (walk.items.length === 0) return empty(rf, 'No recently-played history available.');
      const { byTrack, totalPlays } = playCounts(walk.items);
      const rows = [...byTrack.entries()]
        .map(([id, v]) => ({ id, name: v.name, artists: v.artists, plays: v.plays, last_played: v.last, rotation: v.plays >= 3 ? 'heavy' : v.plays === 2 ? 'regular' : 'light' }))
        .sort((a, b) => b.plays - a.plays || a.name.localeCompare(b.name));
      const dist: Record<string, number> = { heavy: 0, regular: 0, light: 0 };
      for (const r of rows) dist[r.rotation] += 1;
      const tr = truncateItems(rows, resolveMaxResults(args.max_results));
      const payload = {
        ok: true,
        history_items: walk.items.length,
        recent_pages_walked: walk.pages,
        total_plays: totalPlays,
        unique_tracks: rows.length,
        distribution: dist,
        items: tr.items,
        pagination: paginationInfo({ total: tr.total, returned: tr.returned }),
      };
      const heaviest = tr.items.slice(0, 3).map((r) => `"${r.name}"×${r.plays}`).join(', ');
      return shape(rf, `Rotation over ${totalPlays} plays / ${rows.length} unique tracks: heavy ${dist.heavy}, regular ${dist.regular}, light ${dist.light}. Most rotated: ${heaviest || '—'}.`, payload);
    },
  );

  // 7. discovery_ratio — how much of recent history is new music vs top staples
  server.tool(
    'discovery_ratio',
    'Measure what share of your recently-played tracks are NOT in your top tracks (discovery vs staple listening; default compares against medium_term). Quota: GET /me/player/recently-played + 1× GET /me/top/tracks.',
    {
      time_range: TimeRange.describe('Top-tracks window defining "known" music. Default: medium_term'),
      max_items: RecentLimit,
      response_format: ResponseFormat,
    },
    async (args) => {
      const rf = args.response_format;
      const [walk, top] = await Promise.all([
        walkRecentlyPlayed(client, recentDepth(args.max_items)),
        fetchTopTracks(client, args.time_range, TOP_LIMIT),
      ]);
      if (walk.items.length === 0) return empty(rf, 'No recently-played history available.');
      const known = new Set(top.map((t) => t.id));
      const uniq = new Map<string, { name: string; artists: string; plays: number; fresh: boolean }>();
      let freshPlays = 0;
      for (const r of walk.items) {
        const fresh = !known.has(r.track.id);
        if (fresh) freshPlays += 1;
        const cur = uniq.get(r.track.id) ?? { name: r.track.name, artists: trackArtists(r.track), plays: 0, fresh };
        cur.plays += 1;
        uniq.set(r.track.id, cur);
      }
      const freshTracks = [...uniq.entries()].filter(([, v]) => v.fresh).map(([id, v]) => ({ id, ...v }));
      freshTracks.sort((a, b) => b.plays - a.plays || a.name.localeCompare(b.name));
      const payload = {
        ok: true,
        top_tracks_window: args.time_range,
        history_plays: walk.items.length,
        unique_tracks: uniq.size,
        fresh_unique: freshTracks.length,
        fresh_unique_ratio: uniq.size === 0 ? 0 : Math.round((freshTracks.length / uniq.size) * 1000) / 1000,
        fresh_play_share: pct(freshPlays, walk.items.length),
        fresh_tracks: freshTracks.slice(0, 20),
      };
      return shape(rf, `Discovery: ${freshTracks.length}/${uniq.size} unique tracks (${pct(freshPlays, walk.items.length)}% of plays) were outside your ${args.time_range} top ${top.length}.`, payload);
    },
  );

  // 8. listening_clock — hour-of-day listening profile
  server.tool(
    'listening_clock',
    'Profile when you listen by local hour (24-bucket histogram plus daypart totals and peak hour) from recently-played history (default 150 items). Quota: GET /me/player/recently-played cursor walk.',
    {
      max_items: RecentLimit,
      response_format: ResponseFormat,
    },
    async (args) => {
      const rf = args.response_format;
      const walk = await walkRecentlyPlayed(client, recentDepth(args.max_items));
      if (walk.items.length === 0) return empty(rf, 'No recently-played history available.');
      const hours: Record<string, number> = {};
      const dayparts: Record<string, number> = {};
      for (let h = 0; h < 24; h++) hours[`${pad2(h)}:00`] = 0;
      for (const r of walk.items) {
        const h = localHour(r.played_at);
        hours[`${pad2(h)}:00`] += 1;
        bump(dayparts, daypartOf(h));
      }
      const ranked = sortedEntries(hours);
      const peak = ranked[0];
      const quiet = [...ranked].reverse()[0];
      const payload = {
        ok: true,
        history_items: walk.items.length,
        recent_pages_walked: walk.pages,
        hour_histogram: hours,
        dayparts,
        peak_hour: peak?.[0] ?? null,
        peak_plays: peak?.[1] ?? 0,
        quietest_hour: quiet?.[0] ?? null,
      };
      return shape(rf, `Listening clock: peak ${peak?.[0] ?? '—'} with ${peak?.[1] ?? 0} plays. Dayparts — ${DAYPARTS.map((d) => `${d} ${dayparts[d] ?? 0}`).join(', ')}.`, payload);
    },
  );

  // 9. weekday_listening_report — plays + uniqueness per weekday
  server.tool(
    'weekday_listening_report',
    'Break recently-played history down by weekday (plays, unique tracks, unique artists, busiest day; Mon→Sun ordering, default 150 items). Quota: GET /me/player/recently-played cursor walk.',
    {
      max_items: RecentLimit,
      response_format: ResponseFormat,
    },
    async (args) => {
      const rf = args.response_format;
      const walk = await walkRecentlyPlayed(client, recentDepth(args.max_items));
      if (walk.items.length === 0) return empty(rf, 'No recently-played history available.');
      const perDay: Record<string, { plays: number; tracks: Set<string>; artists: Set<string> }> = {};
      for (const wd of WEEKDAYS) perDay[wd] = { plays: 0, tracks: new Set(), artists: new Set() };
      for (const r of walk.items) {
        const wd = localWeekday(r.played_at);
        perDay[wd].plays += 1;
        perDay[wd].tracks.add(r.track.id);
        for (const a of r.track.artists) perDay[wd].artists.add(a.id);
      }
      const rows = WEEKDAYS.map((wd) => ({ weekday: wd, plays: perDay[wd].plays, unique_tracks: perDay[wd].tracks.size, unique_artists: perDay[wd].artists.size }));
      const busiest = [...rows].sort((a, b) => b.plays - a.plays)[0];
      const payload = {
        ok: true,
        history_items: walk.items.length,
        recent_pages_walked: walk.pages,
        weekdays: rows,
        busiest_weekday: busiest?.weekday ?? null,
      };
      return shape(rf, `Weekday report: busiest ${busiest?.weekday ?? '—'} (${busiest?.plays ?? 0} plays). ${rows.map((r) => `${r.weekday} ${r.plays}`).join(', ')}.`, payload);
    },
  );

  // 10. binge_detector_report — artists played far beyond normal in the window
  server.tool(
    'binge_detector_report',
    'Flag artists whose recently-played counts exceed a play threshold (default ≥5 plays) with span and track coverage, sorted by intensity. Quota: GET /me/player/recently-played cursor walk.',
    {
      threshold: z.coerce.number().int().positive().max(50).optional().default(5).describe('Minimum plays per artist to count as a binge (default 5).'),
      max_items: RecentLimit,
      response_format: ResponseFormat,
    },
    async (args) => {
      const rf = args.response_format;
      const walk = await walkRecentlyPlayed(client, recentDepth(args.max_items));
      if (walk.items.length === 0) return empty(rf, 'No recently-played history available.');
      const { byArtist, totalPlays } = playCounts(walk.items);
      const rows = [...byArtist.entries()]
        .map(([id, v]) => ({
          id,
          name: v.name,
          plays: v.plays,
          share: pct(v.plays, totalPlays),
          unique_tracks: v.tracks.size,
          first_play: v.first,
          last_play: v.last,
        }))
        .filter((r) => r.plays >= (args.threshold ?? 5))
        .sort((a, b) => b.plays - a.plays || a.name.localeCompare(b.name));
      const payload = {
        ok: true,
        threshold: args.threshold ?? 5,
        history_items: walk.items.length,
        total_plays: totalPlays,
        binge_count: rows.length,
        binges: rows.slice(0, 20),
      };
      const names = rows.slice(0, 3).map((r) => `${r.name} (${r.plays} plays, ${r.share}%)`).join(', ');
      return shape(rf, rows.length === 0 ? `No artist reached ${args.threshold ?? 5} plays — no binges detected.` : `Binges (≥${args.threshold ?? 5} plays): ${rows.length} artist(s). Top: ${names}.`, payload);
    },
  );

  // 11. repeat_listener_report — track repeats and back-to-back replays
  server.tool(
    'repeat_listener_report',
    'Quantify repeat listening in recently-played history: share of plays going to tracks heard more than once plus consecutive same-track replays (default 150 items). Quota: GET /me/player/recently-played cursor walk.',
    {
      max_items: RecentLimit,
      max_results: MaxResults,
      response_format: ResponseFormat,
    },
    async (args) => {
      const rf = args.response_format;
      const walk = await walkRecentlyPlayed(client, recentDepth(args.max_items));
      if (walk.items.length === 0) return empty(rf, 'No recently-played history available.');
      const chron = chronological(walk.items);
      const { byTrack, totalPlays } = playCounts(chron);
      let repeatPlays = 0;
      const rows: Array<{ id: string; name: string; artists: string; plays: number }> = [];
      for (const [id, v] of byTrack) {
        if (v.plays >= 2) {
          repeatPlays += v.plays;
          rows.push({ id, name: v.name, artists: v.artists, plays: v.plays });
        }
      }
      let backToBack = 0;
      for (let i = 1; i < chron.length; i++) {
        if (chron[i].track.id === chron[i - 1].track.id) backToBack += 1;
      }
      rows.sort((a, b) => b.plays - a.plays || a.name.localeCompare(b.name));
      const tr = truncateItems(rows, resolveMaxResults(args.max_results));
      const payload = {
        ok: true,
        history_items: walk.items.length,
        total_plays: totalPlays,
        unique_tracks: byTrack.size,
        repeat_tracks: rows.length,
        repeat_play_share: pct(repeatPlays, totalPlays),
        back_to_back_replays: backToBack,
        items: tr.items,
        pagination: paginationInfo({ total: tr.total, returned: tr.returned }),
      };
      return shape(rf, `Repeats: ${rows.length} track(s) heard ≥2× account for ${pct(repeatPlays, totalPlays)}% of plays; ${backToBack} immediate back-to-back replay(s).`, payload);
    },
  );

  // 12. listening_streak_report — consecutive active days in history
  server.tool(
    'listening_streak_report',
    'Compute consecutive-day listening streaks from recently-played history, including the longest streak and whether it is still alive (default 150 items). Quota: GET /me/player/recently-played cursor walk.',
    {
      max_items: RecentLimit,
      response_format: ResponseFormat,
    },
    async (args) => {
      const rf = args.response_format;
      const walk = await walkRecentlyPlayed(client, recentDepth(args.max_items));
      if (walk.items.length === 0) return empty(rf, 'No recently-played history available.');
      const dates = [...new Set(walk.items.map((r) => localDate(r.played_at)))].sort();
      const streaks: Array<{ start: string; end: string; length: number }> = [];
      let start = dates[0];
      let len = 1;
      for (let i = 1; i < dates.length; i++) {
        if (playedAtMs(dates[i] + 'T00:00:00Z') - playedAtMs(dates[i - 1] + 'T00:00:00Z') === 86_400_000) len += 1;
        else {
          streaks.push({ start, end: dates[i - 1], length: len });
          start = dates[i];
          len = 1;
        }
      }
      streaks.push({ start, end: dates[dates.length - 1], length: len });
      const longest = streaks.reduce((m, s) => (s.length > m.length ? s : m), streaks[0]);
      const last = dates[dates.length - 1];
      const yesterday = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);
      const currentAlive = last === new Date().toISOString().slice(0, 10) || last === yesterday;
      const payload = {
        ok: true,
        history_items: walk.items.length,
        active_days: dates.length,
        first_active_day: dates[0],
        last_active_day: last,
        streaks,
        longest_streak: longest,
        current_streak_alive: currentAlive,
        current_streak_length: currentAlive ? streaks[streaks.length - 1].length : 0,
      };
      return shape(rf, `Streaks: ${streaks.length} run(s) over ${dates.length} active days; longest ${longest.length} day(s) (${longest.start} → ${longest.end}); current streak ${currentAlive ? `alive at ${streaks[streaks.length - 1].length} day(s)` : 'broken'}.`, payload);
    },
  );

  // 13. top_genre_census — weighted genre census from top artists
  server.tool(
    'top_genre_census',
    'Build a weighted genre census from your top artists (rank-weighted across the three windows; genres resolved via the batch /artists endpoint, default 40 artists per window). Quota: 3× GET /me/top/artists + 1× GET /artists?ids=.',
    {
      limit: z.coerce.number().int().positive().max(50).optional().default(40).describe('Artists fetched per window (default 40).'),
      max_results: MaxResults,
      response_format: ResponseFormat,
    },
    async (args) => {
      const rf = args.response_format;
      const limit = Math.min(args.limit ?? 40, TOP_LIMIT);
      const windows = await Promise.all([
        fetchTopArtists(client, 'short_term', limit),
        fetchTopArtists(client, 'medium_term', limit),
        fetchTopArtists(client, 'long_term', limit),
      ]);
      const weights = [3, 2, 1];
      const ids = new Set(windows.flat().map((a) => a.id));
      if (ids.size === 0) return empty(rf, 'No top artists available for this account.');
      const idList = [...ids].slice(0, 50);
      const detail = await client.get<{ artists: Array<{ id: string; genres?: string[] } | null> | null }>(
        '/artists',
        { ids: idList.join(',') },
      );
      const genresById = new Map<string, string[]>();
      for (const a of detail?.artists ?? []) {
        if (a?.id) genresById.set(a.id, a.genres ?? []);
      }
      const weighted: Record<string, number> = {};
      const artistCounts: Record<string, number> = {};
      windows.forEach((list, wi) => {
        list.forEach((a, rank) => {
          const weight = (limit - rank) * weights[wi];
          const genres = genresById.get(a.id) ?? [];
          for (const g of genres) {
            bump(weighted, g, weight);
            bump(artistCounts, g);
          }
          if (genres.length === 0) bump(weighted, 'unknown', weight);
        });
      });
      const rows = sortedEntries(weighted).map(([genre, score]) => ({ genre, weighted_score: score, artists: artistCounts[genre] ?? 0 }));
      const tr = truncateItems(rows, resolveMaxResults(args.max_results));
      const payload = {
        ok: true,
        artists_census: ids.size,
        artists_with_genres: idList.filter((id) => (genresById.get(id)?.length ?? 0) > 0).length,
        scoring: 'score = (limit - rank + 1) × window weight (short 3 / medium 2 / long 1) summed per genre',
        items: tr.items,
        pagination: paginationInfo({ total: tr.total, returned: tr.returned }),
      };
      const top = tr.items.slice(0, 5).map((g) => `${g.genre} (${g.weighted_score})`).join(', ');
      return shape(rf, `Genre census: ${rows.length} genre(s) across ${ids.size} artists. Top: ${top || '—'}.`, payload);
    },
  );

  // 14. mood_bucket_report — daypart × familiarity listening buckets
  server.tool(
    'mood_bucket_report',
    'Segment recently-played plays into daypart × familiarity buckets (fresh tracks vs staples from your top tracks, default medium_term) as a lightweight listening-mood proxy. Quota: GET /me/player/recently-played + 1× GET /me/top/tracks.',
    {
      time_range: TimeRange.describe('Top-tracks window defining "staple" music. Default: medium_term'),
      max_items: RecentLimit,
      response_format: ResponseFormat,
    },
    async (args) => {
      const rf = args.response_format;
      const [walk, top] = await Promise.all([
        walkRecentlyPlayed(client, recentDepth(args.max_items)),
        fetchTopTracks(client, args.time_range, TOP_LIMIT),
      ]);
      if (walk.items.length === 0) return empty(rf, 'No recently-played history available.');
      const staple = new Set(top.map((t) => t.id));
      const buckets: Record<string, number> = {};
      for (const dp of DAYPARTS) {
        buckets[`${dp}_staple`] = 0;
        buckets[`${dp}_fresh`] = 0;
      }
      for (const r of walk.items) {
        const dp = daypartOf(localHour(r.played_at));
        bump(buckets, `${dp}_${staple.has(r.track.id) ? 'staple' : 'fresh'}`);
      }
      const rows = Object.entries(buckets).map(([bucket, plays]) => ({ bucket, plays, share: pct(plays, walk.items.length) })).sort((a, b) => b.plays - a.plays);
      const payload = {
        ok: true,
        top_tracks_window: args.time_range,
        history_plays: walk.items.length,
        buckets: rows,
        note: 'Heuristic segmentation: daypart (local time) × whether the track is in your top-tracks window. Not an acoustic mood analysis.',
      };
      const topBucket = rows[0];
      return shape(rf, `Mood buckets: dominant ${topBucket?.bucket ?? '—'} (${topBucket?.plays ?? 0} plays, ${topBucket?.share ?? 0}%).`, payload);
    },
  );

  // 15. deep_dive_report — one artist's footprint across history + top lists
  server.tool(
    'deep_dive_report',
    'Deep-dive one artist: recently-played counts, which of their tracks rotate, and their rank in each top-artists window (accepts ID, URI, or URL). Quota: GET /me/player/recently-played + 3× GET /me/top/artists.',
    {
      artist: spotifyId('artist').describe('Artist ID, URI, or URL.'),
      max_items: RecentLimit,
      response_format: ResponseFormat,
    },
    async (args) => {
      const rf = args.response_format;
      const artistId = args.artist;
      const [walk, st, mt, lt] = await Promise.all([
        walkRecentlyPlayed(client, recentDepth(args.max_items)),
        fetchTopArtists(client, 'short_term', TOP_LIMIT),
        fetchTopArtists(client, 'medium_term', TOP_LIMIT),
        fetchTopArtists(client, 'long_term', TOP_LIMIT),
      ]);
      const matches = walk.items.filter((r) => r.track.artists.some((a) => a.id === artistId));
      const trackPlays = new Map<string, { name: string; plays: number; last: string }>();
      for (const r of matches) {
        const cur = trackPlays.get(r.track.id) ?? { name: r.track.name, plays: 0, last: r.played_at };
        cur.plays += 1;
        if (r.played_at > cur.last) cur.last = r.played_at;
        trackPlays.set(r.track.id, cur);
      }
      const rankIn = (list: Array<{ id: string; name: string }>): number | null => {
        const idx = list.findIndex((a) => a.id === artistId);
        return idx === -1 ? null : idx + 1;
      };
      const tracks = [...trackPlays.entries()]
        .map(([id, v]) => ({ id, ...v }))
        .sort((a, b) => b.plays - a.plays || a.name.localeCompare(b.name));
      const payload = {
        ok: true,
        artist_id: artistId,
        in_recent_history: matches.length > 0,
        history_plays: matches.length,
        unique_tracks_played: trackPlays.size,
        tracks,
        first_play: matches.length > 0 ? chronological(matches)[0].played_at : null,
        last_play: matches.length > 0 ? matches[0].played_at : null,
        top_ranks: { short_term: rankIn(st), medium_term: rankIn(mt), long_term: rankIn(lt) },
      };
      const nameHint = st.find((a) => a.id === artistId)?.name ?? mt.find((a) => a.id === artistId)?.name ?? artistId;
      const ranks = payload.top_ranks;
      return shape(rf, `Deep dive ${nameHint}: ${matches.length} recent play(s) across ${trackPlays.size} track(s); top ranks — short ${ranks.short_term ?? '—'}, medium ${ranks.medium_term ?? '—'}, long ${ranks.long_term ?? '—'}.`, payload);
    },
  );

  // 16. listening_clock_heatmap — weekday × hour matrix
  server.tool(
    'listening_clock_heatmap',
    'Render a weekday × hour listening heatmap from recently-played history with the peak cell highlighted (default 150 items). Quota: GET /me/player/recently-played cursor walk.',
    {
      max_items: RecentLimit,
      response_format: ResponseFormat,
    },
    async (args) => {
      const rf = args.response_format;
      const walk = await walkRecentlyPlayed(client, recentDepth(args.max_items));
      if (walk.items.length === 0) return empty(rf, 'No recently-played history available.');
      const matrix: Record<string, Record<string, number>> = {};
      for (const wd of WEEKDAYS) {
        matrix[wd] = {};
        for (let h = 0; h < 24; h++) matrix[wd][`${pad2(h)}:00`] = 0;
      }
      for (const r of walk.items) matrix[localWeekday(r.played_at)][`${pad2(localHour(r.played_at))}:00`] += 1;
      let peak: { weekday: string; hour: string; plays: number } | null = null;
      for (const wd of WEEKDAYS) {
        for (let h = 0; h < 24; h++) {
          const hour = `${pad2(h)}:00`;
          const plays = matrix[wd][hour];
          if (plays > 0 && (peak === null || plays > peak.plays)) peak = { weekday: wd, hour, plays };
        }
      }
      const activeCells = WEEKDAYS.reduce((n, wd) => n + Object.values(matrix[wd]).filter((v) => v > 0).length, 0);
      const payload = {
        ok: true,
        history_items: walk.items.length,
        recent_pages_walked: walk.pages,
        matrix,
        peak_cell: peak,
        active_cells: activeCells,
        total_cells: WEEKDAYS.length * 24,
      };
      return shape(rf, `Heatmap: ${activeCells}/168 active cells; peak ${peak ? `${peak.weekday} ${peak.hour} (${peak.plays} plays)` : '—'}.`, payload);
    },
  );

  // 17. artist_listening_clock — one artist's hour-of-day profile
  server.tool(
    'artist_listening_clock',
    'Profile WHEN you play one specific artist (hour-of-day histogram plus daypart split; defaults to your most-played artist in the history window). Quota: GET /me/player/recently-played cursor walk.',
    {
      artist: spotifyId('artist').optional().describe('Artist ID/URI/URL. Omit to use the most-played artist in the history window.'),
      max_items: RecentLimit,
      response_format: ResponseFormat,
    },
    async (args) => {
      const rf = args.response_format;
      const walk = await walkRecentlyPlayed(client, recentDepth(args.max_items));
      if (walk.items.length === 0) return empty(rf, 'No recently-played history available.');
      const { byArtist } = playCounts(walk.items);
      let target = args.artist ?? null;
      let resolvedName: string | null = target ? (byArtist.get(target)?.name ?? null) : null;
      if (!target) {
        const top = [...byArtist.entries()].sort((a, b) => b[1].plays - a[1].plays || a[1].name.localeCompare(b[1].name))[0];
        if (!top) return empty(rf, 'No artist plays found in history.');
        target = top[0];
        resolvedName = top[1].name;
      }
      const hours: Record<string, number> = {};
      for (let h = 0; h < 24; h++) hours[`${pad2(h)}:00`] = 0;
      const dayparts: Record<string, number> = {};
      let plays = 0;
      for (const r of walk.items) {
        if (!r.track.artists.some((a) => a.id === target)) continue;
        plays += 1;
        const h = localHour(r.played_at);
        hours[`${pad2(h)}:00`] += 1;
        bump(dayparts, daypartOf(h));
      }
      const ranked = sortedEntries(hours);
      const peak = ranked[0];
      const payload = {
        ok: true,
        artist_id: target,
        artist_name: resolvedName,
        plays,
        share_of_history: pct(plays, walk.items.length),
        hour_histogram: hours,
        dayparts,
        peak_hour: plays > 0 ? peak?.[0] ?? null : null,
      };
      return shape(rf, plays === 0 ? `No plays of ${resolvedName ?? target} in the recent history window.` : `${resolvedName ?? target}: ${plays} play(s) (${pct(plays, walk.items.length)}% of history), peak hour ${peak?.[0] ?? '—'}.`, payload);
    },
  );

  // 18. session_length_report — listening session sizes and durations
  server.tool(
    'session_length_report',
    'Split recently-played history into listening sessions by inactivity gap (default 30 minutes) and report size/duration stats plus a distribution (default 150 items). Quota: GET /me/player/recently-played cursor walk.',
    {
      gap_minutes: z.coerce.number().positive().max(180).optional().default(30).describe('Inactivity gap (minutes) that ends a session (default 30).'),
      max_items: RecentLimit,
      response_format: ResponseFormat,
    },
    async (args) => {
      const rf = args.response_format;
      const walk = await walkRecentlyPlayed(client, recentDepth(args.max_items));
      if (walk.items.length === 0) return empty(rf, 'No recently-played history available.');
      const chron = chronological(walk.items);
      const gapMs = (args.gap_minutes ?? 30) * 60_000;
      const sessions: Array<{ start: string; end: string; plays: number; span_minutes: number }> = [];
      let current = [chron[0]];
      for (let i = 1; i < chron.length; i++) {
        if (playedAtMs(chron[i].played_at) - playedAtMs(chron[i - 1].played_at) > gapMs) {
          const first = current[0];
          const last = current[current.length - 1];
          sessions.push({ start: first.played_at, end: last.played_at, plays: current.length, span_minutes: Math.round(((playedAtMs(last.played_at) - playedAtMs(first.played_at)) / 60_000) * 10) / 10 });
          current = [chron[i]];
        } else {
          current.push(chron[i]);
        }
      }
      const first = current[0];
      const last = current[current.length - 1];
      sessions.push({ start: first.played_at, end: last.played_at, plays: current.length, span_minutes: Math.round(((playedAtMs(last.played_at) - playedAtMs(first.played_at)) / 60_000) * 10) / 10 });
      const sizes = sessions.map((s) => s.plays);
      const dist = { single: 0, small: 0, medium: 0, large: 0, marathon: 0 };
      for (const n of sizes) {
        if (n === 1) dist.single += 1;
        else if (n <= 3) dist.small += 1;
        else if (n <= 6) dist.medium += 1;
        else if (n <= 10) dist.large += 1;
        else dist.marathon += 1;
      }
      const payload = {
        ok: true,
        gap_minutes: args.gap_minutes ?? 30,
        history_items: walk.items.length,
        sessions,
        session_count: sessions.length,
        avg_plays_per_session: sessions.length === 0 ? 0 : Math.round((sizes.reduce((a, b) => a + b, 0) / sessions.length) * 10) / 10,
        median_plays_per_session: median(sizes),
        max_session_plays: sizes.length === 0 ? 0 : Math.max(...sizes),
        distribution: dist,
      };
      return shape(rf, `Sessions (gap > ${args.gap_minutes ?? 30} min): ${sessions.length} session(s), median ${median(sizes)} play(s), largest ${payload.max_session_plays} plays.`, payload);
    },
  );

  // 19. listening_gaps_report — quiet stretches inside the history window
  server.tool(
    'listening_gaps_report',
    'Find the quiet stretches in your recently-played history: every inactivity gap above a threshold (default ≥120 minutes) with the longest gaps listed (default 150 items). Quota: GET /me/player/recently-played cursor walk.',
    {
      min_gap_minutes: z.coerce.number().positive().max(10080).optional().default(120).describe('Minimum gap length to report, in minutes (default 120).'),
      max_items: RecentLimit,
      response_format: ResponseFormat,
    },
    async (args) => {
      const rf = args.response_format;
      const walk = await walkRecentlyPlayed(client, recentDepth(args.max_items));
      if (walk.items.length === 0) return empty(rf, 'No recently-played history available.');
      const chron = chronological(walk.items);
      const gaps: Array<{ from: string; to: string; minutes: number }> = [];
      let totalQuiet = 0;
      for (let i = 1; i < chron.length; i++) {
        const minutes = Math.round(((playedAtMs(chron[i].played_at) - playedAtMs(chron[i - 1].played_at)) / 60_000) * 10) / 10;
        gaps.push({ from: chron[i - 1].played_at, to: chron[i].played_at, minutes });
      }
      const quiet = gaps.filter((g) => g.minutes >= (args.min_gap_minutes ?? 120)).sort((a, b) => b.minutes - a.minutes);
      for (const g of quiet) totalQuiet += g.minutes;
      const windowMinutes = Math.round(((playedAtMs(chron[chron.length - 1].played_at) - playedAtMs(chron[0].played_at)) / 60_000) * 10) / 10;
      const payload = {
        ok: true,
        min_gap_minutes: args.min_gap_minutes ?? 120,
        history_items: walk.items.length,
        window_span_minutes: windowMinutes,
        gap_count: gaps.length,
        reported_gaps: quiet.slice(0, 10),
        reported_gap_count: quiet.length,
        quiet_minutes_reported: Math.round(totalQuiet * 10) / 10,
        quiet_share: pct(totalQuiet, windowMinutes),
        longest_gap: quiet[0] ?? null,
      };
      return shape(rf, quiet.length === 0 ? `No gaps ≥ ${args.min_gap_minutes ?? 120} min — consistently active window.` : `${quiet.length} quiet gap(s) ≥ ${args.min_gap_minutes ?? 120} min (${pct(totalQuiet, windowMinutes)}% of the window); longest ${quiet[0].minutes} min.`, payload);
    },
  );

  // 20. weekly_rotation_report — per-day freshness and variety
  server.tool(
    'weekly_rotation_report',
    'Track day-by-day rotation from recently-played history: plays, unique tracks/artists, and first-heard-this-window tracks per day (oldest→newest, default 150 items). Quota: GET /me/player/recently-played cursor walk.',
    {
      max_items: RecentLimit,
      response_format: ResponseFormat,
    },
    async (args) => {
      const rf = args.response_format;
      const walk = await walkRecentlyPlayed(client, recentDepth(args.max_items));
      if (walk.items.length === 0) return empty(rf, 'No recently-played history available.');
      const chron = chronological(walk.items);
      const seen = new Set<string>();
      const rows: Array<{ date: string; weekday: string; plays: number; unique_tracks: number; unique_artists: number; fresh_tracks: number; fresh_share: number }> = [];
      const perDay = dayStats(chron);
      let idx = 0;
      for (const d of perDay) {
        let fresh = 0;
        while (idx < chron.length && localDate(chron[idx].played_at) === d.date) {
          if (!seen.has(chron[idx].track.id)) {
            fresh += 1;
            seen.add(chron[idx].track.id);
          }
          idx += 1;
        }
        rows.push({ date: d.date, weekday: localWeekday(d.date + 'T12:00:00'), plays: d.plays, unique_tracks: d.unique_tracks, unique_artists: d.unique_artists, fresh_tracks: fresh, fresh_share: pct(fresh, d.plays) });
      }
      const totalFresh = rows.reduce((a, r) => a + r.fresh_tracks, 0);
      const payload = {
        ok: true,
        history_items: walk.items.length,
        days: rows,
        total_fresh_tracks: totalFresh,
        avg_fresh_share: rows.length === 0 ? 0 : Math.round((rows.reduce((a, r) => a + r.fresh_share, 0) / rows.length) * 10) / 10,
      };
      return shape(rf, `Rotation: ${rows.length} active day(s), ${totalFresh} first-heard track(s) overall; average daily fresh share ${payload.avg_fresh_share}%.`, payload);
    },
  );

  // 21. listening_consistency_score — 0-100 consistency composite
  server.tool(
    'listening_consistency_score',
    'Score how consistent your listening is (0-100) from recently-played history: active-day coverage, hour spread, and weekday balance with each component shown (default 150 items). Quota: GET /me/player/recently-played cursor walk.',
    {
      max_items: RecentLimit,
      response_format: ResponseFormat,
    },
    async (args) => {
      const rf = args.response_format;
      const walk = await walkRecentlyPlayed(client, recentDepth(args.max_items));
      if (walk.items.length === 0) return empty(rf, 'No recently-played history available.');
      const chron = chronological(walk.items);
      const activeDays = new Set(chron.map((r) => localDate(r.played_at)));
      const firstDay = [...activeDays][0];
      const lastDay = [...activeDays][activeDays.size - 1];
      const spanDays = Math.max(1, Math.round((playedAtMs(lastDay + 'T00:00:00Z') - playedAtMs(firstDay + 'T00:00:00Z')) / 86_400_000) + 1);
      const dayCoverage = activeDays.size / spanDays;
      const hours = new Set(chron.map((r) => localHour(r.played_at)));
      const hourSpread = hours.size / 24;
      const weekdayPlays: Record<string, number> = {};
      for (const wd of WEEKDAYS) weekdayPlays[wd] = 0;
      for (const r of chron) weekdayPlays[localWeekday(r.played_at)] += 1;
      const activeWeekdays = WEEKDAYS.filter((wd) => weekdayPlays[wd] > 0).length;
      const weekdayBalance = activeWeekdays / 7;
      const score = Math.round(dayCoverage * 40 + hourSpread * 30 + weekdayBalance * 30);
      const payload = {
        ok: true,
        score,
        components: {
          day_coverage: { ratio: Math.round(dayCoverage * 1000) / 1000, points: Math.round(dayCoverage * 40), max: 40, active_days: activeDays.size, span_days: spanDays },
          hour_spread: { ratio: Math.round(hourSpread * 1000) / 1000, points: Math.round(hourSpread * 30), max: 30, active_hours: hours.size },
          weekday_balance: { ratio: Math.round(weekdayBalance * 1000) / 1000, points: Math.round(weekdayBalance * 30), max: 30, active_weekdays: activeWeekdays },
        },
        window: { first_play: chron[0].played_at, last_play: chron[chron.length - 1].played_at },
      };
      return shape(rf, `Consistency score: ${score}/100 (days ${payload.components.day_coverage.points}/40, hours ${payload.components.hour_spread.points}/30, weekdays ${payload.components.weekday_balance.points}/30).`, payload);
    },
  );

  // 22. era_preference_report — decade mix of history vs top tracks
  server.tool(
    'era_preference_report',
    'Compare the decade mix (album release eras) of your recently-played tracks against a top-tracks window, highlighting where recent listening skews older or newer (default medium_term). Quota: GET /me/player/recently-played + 1× GET /me/top/tracks.',
    {
      time_range: TimeRange.describe('Top-tracks window to compare eras against. Default: medium_term'),
      max_items: RecentLimit,
      response_format: ResponseFormat,
    },
    async (args) => {
      const rf = args.response_format;
      const [walk, top] = await Promise.all([
        walkRecentlyPlayed(client, recentDepth(args.max_items)),
        fetchTopTracks(client, args.time_range, TOP_LIMIT),
      ]);
      if (walk.items.length === 0 && top.length === 0) return empty(rf, 'No listening data available.');
      const recentEras: Record<string, number> = {};
      for (const r of walk.items) bump(recentEras, swarm3DecadeOf((r.track as unknown as RecentTrack).album?.release_date));
      const topEras: Record<string, number> = {};
      for (const t of top) bump(topEras, swarm3DecadeOf(t.album?.release_date));
      const decades = [...new Set([...Object.keys(recentEras), ...Object.keys(topEras)])].sort();
      const rows = decades.map((decade) => ({
        decade,
        recent_plays: recentEras[decade] ?? 0,
        recent_share: pct(recentEras[decade] ?? 0, walk.items.length),
        top_count: topEras[decade] ?? 0,
        top_share: pct(topEras[decade] ?? 0, top.length),
      }));
      const recentTop = sortedEntries(recentEras)[0];
      const skew = rows.filter((r) => r.recent_share - r.top_share >= 5).map((r) => r.decade);
      const payload = {
        ok: true,
        top_tracks_window: args.time_range,
        history_plays: walk.items.length,
        top_tracks: top.length,
        rows,
        favourite_recent_era: recentTop?.[0] ?? null,
        recent_skews_vs_top: skew,
      };
      return shape(rf, `Eras: recent favourite ${recentTop?.[0] ?? '—'} (${recentTop?.[1] ?? 0} plays). Skews recent vs ${args.time_range} tops: ${skew.length > 0 ? skew.join(', ') : 'none notable'}.`, payload);
    },
  );

  // 23. listening_recap_brief — one-call narrative recap of recent listening
  server.tool(
    'listening_recap_brief',
    'Produce a one-call recap of your recent listening: headline plays, top artist/track, leaderboard leaders, peak hour, busiest weekday, discovery ratio, and streak status (default 200 history items). Quota: GET /me/player/recently-played + 4× GET /me/top/*.',
    {
      max_items: z.coerce.number().int().positive().max(500).optional().default(200).describe('Max history items to walk (default 200).'),
      response_format: ResponseFormat,
    },
    async (args) => {
      const rf = args.response_format;
      const depth = recentDepth(args.max_items);
      const [walk, stTracks, mtTracks, stArtists, mtArtists] = await Promise.all([
        walkRecentlyPlayed(client, depth),
        fetchTopTracks(client, 'short_term', 10),
        fetchTopTracks(client, 'medium_term', 10),
        fetchTopArtists(client, 'short_term', 10),
        fetchTopArtists(client, 'medium_term', 10),
      ]);
      if (walk.items.length === 0) return empty(rf, 'No recently-played history available.');
      const chron = chronological(walk.items);
      const { byTrack, byArtist } = playCounts(chron);
      const topRecentArtist = [...byArtist.entries()].sort((a, b) => b[1].plays - a[1].plays)[0];
      const topRecentTrack = [...byTrack.entries()].sort((a, b) => b[1].plays - a[1].plays)[0];
      const hours = new Set(chron.map((r) => localHour(r.played_at)));
      const hourHist: Record<string, number> = {};
      for (const r of chron) bump(hourHist, `${pad2(localHour(r.played_at))}:00`);
      const peakHour = sortedEntries(hourHist)[0];
      const weekdayHist: Record<string, number> = {};
      for (const r of chron) bump(weekdayHist, localWeekday(r.played_at));
      const busiestDay = sortedEntries(weekdayHist)[0];
      const stIds = new Set(stTracks.map((t) => t.id));
      const fresh = chron.filter((r) => !stIds.has(r.track.id)).length;
      const dates = [...new Set(chron.map((r) => localDate(r.played_at)))].sort();
      const yesterday = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);
      const today = new Date().toISOString().slice(0, 10);
      const streakAlive = dates[dates.length - 1] === today || dates[dates.length - 1] === yesterday;
      const recap = [
        `Headline: ${chron.length} plays across ${byTrack.size} unique tracks and ${byArtist.size} artists (${dates[0]} → ${dates[dates.length - 1]}).`,
        `Most played lately: ${topRecentArtist ? `${topRecentArtist[1].name} (${topRecentArtist[1].plays} plays)` : '—'}; most rotated track: ${topRecentTrack ? `"${topRecentTrack[1].name}" (${topRecentTrack[1].plays} plays)` : '—'}.`,
        `Charts: #1 short-term artist ${stArtists[0]?.name ?? '—'}, medium-term ${mtArtists[0]?.name ?? '—'}; top track "${stTracks[0]?.name ?? '—'}".`,
        `Rhythm: peak hour ${peakHour?.[0] ?? '—'}, busiest weekday ${busiestDay?.[0] ?? '—'}; listening streak ${streakAlive ? 'alive' : 'broken'}.`,
        `Discovery: ${pct(fresh, chron.length)}% of recent plays were outside your short-term top ${stTracks.length}.`,
      ];
      const payload = {
        ok: true,
        window: { first_play: chron[0].played_at, last_play: chron[chron.length - 1].played_at, plays: chron.length, unique_tracks: byTrack.size, unique_artists: byArtist.size },
        top_recent_artist: topRecentArtist ? { id: topRecentArtist[0], name: topRecentArtist[1].name, plays: topRecentArtist[1].plays } : null,
        top_recent_track: topRecentTrack ? { id: topRecentTrack[0], name: topRecentTrack[1].name, plays: topRecentTrack[1].plays } : null,
        chart_leaders: { short_artist: stArtists[0] ?? null, medium_artist: mtArtists[0] ?? null, short_track: stTracks[0] ? { id: stTracks[0].id, name: stTracks[0].name } : null },
        peak_hour: peakHour?.[0] ?? null,
        busiest_weekday: busiestDay?.[0] ?? null,
        streak_alive: streakAlive,
        discovery_play_share: pct(fresh, chron.length),
        recap_lines: recap,
      };
      return shape(rf, recap.join('\n'), payload);
    },
  );

  // 24. listening_history_export — paginated chronological export of history
  server.tool(
    'listening_history_export',
    'Export your recently-played history as a paginated chronological table (oldest→newest; supports offset continuation; default walks up to 500 items). Quota: GET /me/player/recently-played cursor walk.',
    {
      max_items: z.coerce.number().int().positive().max(500).optional().default(500).describe('Max history items to walk (default 500).'),
      offset: z.coerce.number().int().min(0).optional().default(0).describe('Offset into the chronological list for continued pages (default 0).'),
      max_results: MaxResults,
      response_format: ResponseFormat,
    },
    async (args) => {
      const rf = args.response_format;
      const walk = await walkRecentlyPlayed(client, recentDepth(args.max_items));
      if (walk.items.length === 0) return empty(rf, 'No recently-played history available.');
      const chron = chronological(walk.items);
      const offset = args.offset ?? 0;
      const maxResults = resolveMaxResults(args.max_results);
      const remainder = chron.slice(offset);
      const tr = truncateItems(remainder, maxResults);
      const rows = tr.items.map((r) => {
        const t = r.track as unknown as RecentTrack;
        return {
          played_at: r.played_at,
          track_id: r.track.id,
          track: r.track.name,
          artists: trackArtists(r.track),
          album: t.album?.name ?? null,
          duration_ms: r.track.duration_ms ?? null,
          context: r.context?.type ?? null,
        };
      });
      const page = paginationInfo({ total: chron.length, offset, returned: tr.items.length });
      const payload = {
        ok: true,
        history_items: walk.items.length,
        recent_pages_walked: walk.pages,
        items: rows,
        pagination: page,
      };
      const first = rows[0];
      const last = rows[rows.length - 1];
      return shape(rf, rows.length === 0 ? `Nothing at offset ${offset} (window holds ${chron.length} items).` : `History export ${page.offset}–${page.offset + page.returned} of ${chron.length}: ${first.played_at} … ${last.played_at}.${tr.footer ? ` ${tr.footer}.` : ''}`, payload);
    },
  );
}
