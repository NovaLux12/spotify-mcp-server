/**
 * stats.fm taste-intelligence slice (v2 taste track).
 *
 * Eight read-only tools over the stats.fm PUBLIC API v1 (no auth):
 *   https://api.stats.fm/api/v1
 *
 * Local minimal fetch shim lives inside this module on purpose — do NOT
 * depend on sibling-branch client files (e.g. a wt-statsfm shared client);
 * the merge resolves the shared client later. Tests inject fixtures via
 * __setStatsfmFetchImpl.
 *
 * Parsing is deliberately lenient: stats.fm shapes vary across endpoints
 * (streams vs top vs stats), so every extractor tolerates missing/renamed
 * fields and degrades to "not enough data" prose instead of crashing.
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
  listStructuredContent,
} from '../shaping.js';

// ---------------------------------------------------------------------------
// Local minimal stats.fm fetch shim (merge resolves shared client later)
// ---------------------------------------------------------------------------

/** Base for every request in this module. */
export const STATSFM_API_BASE = 'https://api.stats.fm/api/v1';

/** Minimal fetch: full URL in, parsed JSON out (or throw). */
export type StatsfmFetchImpl = (url: string) => Promise<unknown>;

async function defaultFetchImpl(url: string): Promise<unknown> {
  const res = await fetch(url, {
    headers: {
      accept: 'application/json',
      'user-agent': 'spotify-mcp/statsfm-taste',
    },
  });
  if (!res.ok) throw new Error(`stats.fm API HTTP ${res.status} for ${url}`);
  return res.json() as Promise<unknown>;
}

let fetchImpl: StatsfmFetchImpl = defaultFetchImpl;

/** Test seam: inject fixture-backed fetch. */
export function __setStatsfmFetchImpl(impl: StatsfmFetchImpl): void {
  fetchImpl = impl;
}

/** Test seam: restore the live fetch shim. */
export function __resetStatsfmFetchImpl(): void {
  fetchImpl = defaultFetchImpl;
}

async function statsfmGet<T>(path: string, params?: Record<string, string>): Promise<T> {
  const qs =
    params && Object.keys(params).length > 0
      ? `?${new URLSearchParams(params).toString()}`
      : '';
  return (await fetchImpl(`${STATSFM_API_BASE}${path}${qs}`)) as T;
}

// ---------------------------------------------------------------------------
// Lenient stats.fm shapes
// ---------------------------------------------------------------------------

interface RawItem {
  [k: string]: unknown;
}

function asItems(payload: unknown): RawItem[] {
  if (Array.isArray(payload)) return payload as RawItem[];
  if (payload && typeof payload === 'object') {
    const obj = payload as Record<string, unknown>;
    if (Array.isArray(obj.items)) return obj.items as RawItem[];
    if (Array.isArray(obj.data)) return obj.data as RawItem[];
  }
  return [];
}

function str(v: unknown, fallback = ''): string {
  return typeof v === 'string' ? v : fallback;
}

function num(v: unknown, fallback = 0): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback;
}

/** Stream/total count across stats.fm field-name variants. */
function countOf(it: RawItem): number {
  for (const k of ['streams', 'streamCount', 'playCount', 'plays', 'count', 'total']) {
    const n = num(it[k], NaN);
    if (Number.isFinite(n) && n !== 0) return n;
  }
  return num(it.streams, 0);
}

function nameOf(it: RawItem): string {
  return (
    str(it.name) ||
    str(it.genre) ||
    str((it.item as RawItem | undefined)?.name) ||
    'unknown'
  );
}

/** Normalized stream row used by every analytic below. */
export interface TasteStream {
  trackId: string;
  trackName: string;
  artistNames: string[];
  playedAtMs: number;
}

function artistNamesOf(track: RawItem | undefined): string[] {
  if (!track || typeof track !== 'object') return [];
  const raw = track.artists;
  if (!Array.isArray(raw)) {
    const single = str(track.artistName) || str(track.artist);
    return single ? [single] : [];
  }
  return (raw as RawItem[])
    .map((a) => (typeof a === 'string' ? a : str(a.name)))
    .filter((n) => n.length > 0);
}

function playedAtOf(entry: RawItem): number {
  for (const k of ['playedAt', 'endTime', 'played_at', 'timestamp', 'createdAt']) {
    const v = entry[k];
    if (typeof v === 'number' && Number.isFinite(v)) return v < 1e12 ? v * 1000 : v;
    if (typeof v === 'string') {
      const t = Date.parse(v);
      if (Number.isFinite(t)) return t;
    }
  }
  // Some stream rows nest under `item`/`stream`.
  for (const k of ['item', 'stream']) {
    const nested = entry[k];
    if (nested && typeof nested === 'object') {
      const t = playedAtOf(nested as RawItem);
      if (t > 0) return t;
    }
  }
  return 0;
}

function trackOf(entry: RawItem): RawItem | undefined {
  for (const k of ['track', 'item', 'stream']) {
    const v = entry[k];
    if (v && typeof v === 'object') {
      const obj = v as RawItem;
      // Unwrap one more level: { item: { track: {...} } }.
      if (obj.track && typeof obj.track === 'object') return obj.track as RawItem;
      if (obj.name !== undefined || obj.artists !== undefined || obj.id !== undefined) {
        return obj;
      }
    }
  }
  // Flat row: the entry itself carries track fields.
  if (entry.trackName !== undefined || entry.trackId !== undefined) return entry;
  return undefined;
}

/** Normalize any stats.fm streams payload into flat rows (drops undated rows). */
export function normalizeStreams(payload: unknown): TasteStream[] {
  const out: TasteStream[] = [];
  for (const entry of asItems(payload)) {
    const playedAtMs = playedAtOf(entry);
    if (playedAtMs <= 0) continue;
    const track = trackOf(entry);
    out.push({
      trackId: str(track?.id) || str(entry.trackId) || str(track?.name),
      trackName:
        str(track?.name) || str(entry.trackName) || 'unknown track',
      artistNames: artistNamesOf(track),
      playedAtMs,
    });
  }
  return out.sort((a, b) => a.playedAtMs - b.playedAtMs);
}

/** Normalized top-list row (artists / tracks / genres). */
export interface TopRow {
  id: string;
  name: string;
  count: number;
}

export function normalizeTopList(payload: unknown): TopRow[] {
  return asItems(payload).map((it) => ({
    id: str(it.id) || nameOf(it),
    name: nameOf(it),
    count: countOf(it),
  }));
}

// ---------------------------------------------------------------------------
// Pure analytics (exported for tests)
// ---------------------------------------------------------------------------

/** Exposure ladder for a single subject. Thresholds are documented, not magic. */
export type ExposureTier = 'unheard' | 'sampled' | 'explored' | 'established' | 'favorite';

export function classifyExposure(lifetimeStreams: number): ExposureTier {
  if (lifetimeStreams <= 0) return 'unheard';
  if (lifetimeStreams <= 2) return 'sampled';
  if (lifetimeStreams <= 9) return 'explored';
  if (lifetimeStreams <= 49) return 'established';
  return 'favorite';
}

/** One listening session: maximal run of streams separated by at most gapMin. */
export interface ListeningSession {
  startMs: number;
  endMs: number;
  streams: number;
  tracks: string[];
}

/** Group ascending streams into sessions; a gap > gapMinutes starts a new one. */
export function groupSessions(streams: TasteStream[], gapMinutes = 30): ListeningSession[] {
  const sessions: ListeningSession[] = [];
  let current: ListeningSession | null = null;
  const gapMs = Math.max(1, gapMinutes) * 60_000;
  for (const s of streams) {
    if (!current || s.playedAtMs - current.endMs > gapMs) {
      current = { startMs: s.playedAtMs, endMs: s.playedAtMs, streams: 0, tracks: [] };
      sessions.push(current);
    }
    current.endMs = s.playedAtMs;
    current.streams += 1;
    if (s.trackName !== 'unknown track' && !current.tracks.includes(s.trackName)) {
      current.tracks.push(s.trackName);
    }
  }
  return sessions;
}

/**
 * Recency half-life (days) from stream ages: assuming exponential decay,
 * median age = halfLife * ln(2), so halfLife = median / ln(2). Null when empty.
 */
export function estimateHalfLifeDays(
  streams: TasteStream[],
  nowMs = Date.now(),
): number | null {
  if (streams.length === 0) return null;
  const ages = streams
    .map((s) => (nowMs - s.playedAtMs) / 86_400_000)
    .filter((a) => a >= 0)
    .sort((a, b) => a - b);
  if (ages.length === 0) return null;
  const mid = Math.floor(ages.length / 2);
  const median =
    ages.length % 2 === 1 ? ages[mid] : (ages[mid - 1] + ages[mid]) / 2;
  return Math.round((median / Math.LN2) * 10) / 10;
}

/** Per-month roll-up consumed by era detection. */
export interface MonthlySummary {
  month: string; // YYYY-MM
  streams: number;
  topArtist: string;
  uniqueArtists: number;
}

/** Roll dated streams up into per-month summaries. */
export function summarizeMonths(streams: TasteStream[]): MonthlySummary[] {
  const byMonth = new Map<string, TasteStream[]>();
  for (const s of streams) {
    const d = new Date(s.playedAtMs);
    const key = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
    const bucket = byMonth.get(key);
    if (bucket) bucket.push(s);
    else byMonth.set(key, [s]);
  }
  return [...byMonth.entries()]
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([month, rows]) => {
      const artistCounts = new Map<string, number>();
      for (const r of rows) {
        for (const a of r.artistNames.length > 0 ? r.artistNames : ['unknown']) {
          artistCounts.set(a, (artistCounts.get(a) ?? 0) + 1);
        }
      }
      let topArtist = 'unknown';
      let topCount = -1;
      for (const [a, c] of artistCounts) {
        if (c > topCount) {
          topCount = c;
          topArtist = a;
        }
      }
      return { month, streams: rows.length, topArtist, uniqueArtists: artistCounts.size };
    });
}

/** One listening era: a run of months with a stable signature artist/volume. */
export interface ListeningEra {
  startMonth: string;
  endMonth: string;
  months: number;
  signatureArtist: string;
  avgStreamsPerMonth: number;
  boundaryReason: string;
}

/**
 * Change-point detection over monthly summaries. A new era starts when the
 * monthly top artist changes OR volume shifts by more than 60% vs the
 * previous month. Deterministic and documented — not a statistical model.
 */
export function detectEras(months: MonthlySummary[]): ListeningEra[] {
  const eras: ListeningEra[] = [];
  let start = 0;
  const reasonFor = (prev: MonthlySummary, cur: MonthlySummary): string | null => {
    if (cur.topArtist !== prev.topArtist) {
      return `top artist ${prev.topArtist} → ${cur.topArtist}`;
    }
    if (prev.streams > 0) {
      const shift = Math.abs(cur.streams - prev.streams) / prev.streams;
      if (shift > 0.6) {
        return `volume shift ${prev.streams} → ${cur.streams} streams/mo`;
      }
    }
    return null;
  };
  const closeEra = (from: number, to: number, reason: string): void => {
    const slice = months.slice(from, to + 1);
    const sig = new Map<string, number>();
    let total = 0;
    for (const m of slice) {
      total += m.streams;
      sig.set(m.topArtist, (sig.get(m.topArtist) ?? 0) + m.streams);
    }
    let signatureArtist = slice[0].topArtist;
    let best = -1;
    for (const [a, c] of sig) {
      if (c > best) {
        best = c;
        signatureArtist = a;
      }
    }
    eras.push({
      startMonth: slice[0].month,
      endMonth: slice[slice.length - 1].month,
      months: slice.length,
      signatureArtist,
      avgStreamsPerMonth: Math.round(total / slice.length),
      boundaryReason: reason,
    });
  };
  for (let i = 1; i < months.length; i++) {
    const reason = reasonFor(months[i - 1], months[i]);
    if (reason !== null) {
      closeEra(start, i - 1, start === 0 ? 'history start' : `prev: ${reason}`);
      void reason;
      start = i;
    }
  }
  if (months.length > 0) {
    const lastReason =
      start === 0 ? 'history start' : `prev: ${reasonFor(months[start - 1], months[start]) ?? 'change'}`;
    closeEra(start, months.length - 1, start === 0 ? 'history start' : lastReason);
  }
  // First era always opens the history; fix its reason label.
  if (eras.length > 0) eras[0].boundaryReason = 'history start';
  return eras;
}

/** Day-part buckets (UTC; stats.fm timestamps carry no local zone). */
export type DayPart = 'night' | 'morning' | 'afternoon' | 'evening';

export function dayPartOfHour(hourUtc: number): DayPart {
  if (hourUtc < 6) return 'night';
  if (hourUtc < 12) return 'morning';
  if (hourUtc < 18) return 'afternoon';
  return 'evening';
}

export function summarizeDayParting(streams: TasteStream[]): Record<DayPart, number> {
  const out: Record<DayPart, number> = { night: 0, morning: 0, afternoon: 0, evening: 0 };
  for (const s of streams) {
    out[dayPartOfHour(new Date(s.playedAtMs).getUTCHours())] += 1;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Local-only feedback store (record_feedback never touches the network)
// ---------------------------------------------------------------------------

export type FeedbackRating = 'love' | 'like' | 'mixed' | 'boring' | 'dislike';
export type FeedbackSubjectType = 'track' | 'artist' | 'album' | 'genre';

export interface FeedbackEntry {
  id: number;
  at: string;
  subject_type: FeedbackSubjectType;
  subject: string;
  rating: FeedbackRating;
  note: string | null;
}

const feedbackStore: FeedbackEntry[] = [];
let feedbackSeq = 0;

export function recordFeedbackEntry(input: {
  subject_type: FeedbackSubjectType;
  subject: string;
  rating: FeedbackRating;
  note?: string;
}): FeedbackEntry {
  const entry: FeedbackEntry = {
    id: (feedbackSeq += 1),
    at: new Date().toISOString(),
    subject_type: input.subject_type,
    subject: input.subject,
    rating: input.rating,
    note: input.note ?? null,
  };
  feedbackStore.push(entry);
  return entry;
}

export function listFeedbackEntries(): FeedbackEntry[] {
  return [...feedbackStore];
}

/** Test seam: reset the in-memory feedback store. */
export function __clearFeedbackEntries(): void {
  feedbackStore.length = 0;
  feedbackSeq = 0;
}

// ---------------------------------------------------------------------------
// Shared arg fragments + output helper
// ---------------------------------------------------------------------------

const statsfmUserSchema = z
  .string()
  .min(1)
  .describe('stats.fm user ID (or username) — public profile, no auth needed');

const rangeSchema = z
  .enum(['lifetime', 'month', 'week'])
  .optional()
  .describe('stats.fm range window. Default: lifetime');

interface ToolOut {
  [k: string]: unknown;
  content: Array<{ type: 'text'; text: string }>;
  structuredContent?: Record<string, unknown>;
}

function textOut(lines: string[], structured?: Record<string, unknown>): ToolOut {
  const out: ToolOut = { content: [{ type: 'text', text: lines.join('\n') }] };
  if (structured) out.structuredContent = structured;
  return out;
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

export function registerStatsfmTasteTools(server: McpServer, _client: SpotifyClient): void {
  void _client; // stats.fm public API needs no Spotify client; kept for index.ts uniformity

  // ---- taste_profile ----
  server.tool(
    'taste_profile',
    'Taste snapshot from stats.fm: core artists, top genres, loyalty-vs-novelty balance, and day-parting (when you listen). Read-only, no auth.',
    {
      statsfm_user: statsfmUserSchema,
      range: rangeSchema,
      response_format: ResponseFormat,
      max_results: MaxResults,
    },
    async (args) => {
      const u = args.statsfm_user;
      const range = args.range ?? 'lifetime';
      const [artistsRaw, genresRaw, tracksRaw, streamsRaw] = await Promise.all([
        statsfmGet<unknown>(`/users/${encodeURIComponent(u)}/top/artists`, {
          range,
          limit: '20',
        }),
        statsfmGet<unknown>(`/users/${encodeURIComponent(u)}/top/genres`, {
          range,
          limit: '20',
        }),
        statsfmGet<unknown>(`/users/${encodeURIComponent(u)}/top/tracks`, {
          range,
          limit: '20',
        }),
        statsfmGet<unknown>(`/users/${encodeURIComponent(u)}/streams`, { limit: '100' }),
      ]);
      if (args.response_format === 'json') {
        const raw = {
          topArtists: artistsRaw,
          topGenres: genresRaw,
          topTracks: tracksRaw,
          recentStreams: streamsRaw,
        };
        return {
          content: [{ type: 'text', text: JSON.stringify(raw) }],
          structuredContent: { ...raw },
        };
      }
      const artists = normalizeTopList(artistsRaw);
      const genres = normalizeTopList(genresRaw);
      const tracks = normalizeTopList(tracksRaw);
      const streams = normalizeStreams(streamsRaw);
      const cap = resolveMaxResults(args.max_results);

      if (artists.length === 0 && genres.length === 0 && tracks.length === 0) {
        return textOut([
          `No taste data for "${u}" (range ${range}) — check the stats.fm user ID.`,
        ]);
      }

      const totalArtistStreams = artists.reduce((s, a) => s + a.count, 0);
      const top5 = artists.slice(0, 5).reduce((s, a) => s + a.count, 0);
      const loyalty = totalArtistStreams > 0 ? top5 / totalArtistStreams : 0;
      const lifetimeTop20 = new Set(artists.slice(0, 20).map((a) => a.name.toLowerCase()));
      const recentNovel = streams.filter(
        (s) => !s.artistNames.some((a) => lifetimeTop20.has(a.toLowerCase())),
      );
      const novelty =
        streams.length > 0 ? recentNovel.length / streams.length : 0;
      const parts = summarizeDayParting(streams);
      const peak = (Object.entries(parts) as Array<[DayPart, number]>).sort(
        (a, b) => b[1] - a[1],
      )[0];

      const detailed = args.response_format === 'detailed';
      const lines = [
        `Taste profile for ${u} (range ${range}, loyalty ${(loyalty * 100).toFixed(0)}% top-5 / novelty ${(novelty * 100).toFixed(0)}% recent-outside-core):`,
        `Core artists: ${artists
          .slice(0, Math.min(10, cap))
          .map((a) => `${a.name} (${a.count})`)
          .join(' · ') || 'n/a'}`,
        `Top genres: ${genres
          .slice(0, Math.min(8, cap))
          .map((g) => `${g.name} (${g.count})`)
          .join(' · ') || 'n/a'}`,
        `Day-parting (UTC, last ${streams.length} streams): night ${parts.night} / morning ${parts.morning} / afternoon ${parts.afternoon} / evening ${parts.evening} — peak: ${peak[0]}.`,
      ];
      if (detailed && tracks.length > 0) {
        lines.push(
          `Top tracks: ${tracks
            .slice(0, Math.min(10, cap))
            .map((t) => `${t.name} (${t.count})`)
            .join(' · ')}`,
        );
      }
      return textOut(lines, {
        user: u,
        range,
        coreArtists: artists.slice(0, 10),
        topGenres: genres.slice(0, 8),
        loyaltyVsNovelty: {
          loyaltyShareTop5: Math.round(loyalty * 1000) / 1000,
          recentNoveltyShare: Math.round(novelty * 1000) / 1000,
          recentStreamsSampled: streams.length,
        },
        dayParting: { ...parts, peak: peak[0] },
        ...(detailed ? { topTracks: tracks.slice(0, 10) } : {}),
      });
    },
  );

  // ---- artist_affinity ----
  server.tool(
    'artist_affinity',
    'How deep does an artist run? Lifetime intensity (share of top-artist streams) plus a recency half-life fitted to recent stream ages. Read-only, no auth.',
    {
      statsfm_user: statsfmUserSchema,
      artist: z.string().min(1).describe('Artist name (substring match) or stats.fm artist ID'),
      response_format: ResponseFormat,
    },
    async (args) => {
      const u = args.statsfm_user;
      const q = args.artist.toLowerCase();
      const [artistsRaw, streamsRaw] = await Promise.all([
        statsfmGet<unknown>(`/users/${encodeURIComponent(u)}/top/artists`, {
          range: 'lifetime',
          limit: '50',
        }),
        statsfmGet<unknown>(`/users/${encodeURIComponent(u)}/streams`, { limit: '500' }),
      ]);
      const artists = normalizeTopList(artistsRaw);
      const streams = normalizeStreams(streamsRaw);
      const row = artists.find(
        (a) => a.name.toLowerCase().includes(q) || a.id.toLowerCase() === q,
      );
      const mine = streams.filter((s) =>
        s.artistNames.some((a) => a.toLowerCase().includes(q)),
      );
      const total = artists.reduce((s, a) => s + a.count, 0);
      const intensity = row && total > 0 ? row.count / total : 0;
      const halfLife = estimateHalfLifeDays(mine);
      const tier = classifyExposure(row?.count ?? 0);
      if (!row && mine.length === 0) {
        return textOut(
          [`No affinity for "${args.artist}" — unheard in ${u}'s stats.fm history.`],
          { user: u, artist: args.artist, tier: 'unheard', intensity: 0 },
        );
      }
      const lastPlayed =
        mine.length > 0 ? new Date(mine[mine.length - 1].playedAtMs).toISOString() : null;
      const lines = [
        `Affinity for ${row?.name ?? args.artist} (${u}): ${tier}, intensity ${(intensity * 100).toFixed(1)}% of top-artist streams (${row?.count ?? 0} lifetime).`,
        `Recent: ${mine.length} streams in sample${halfLife !== null ? `, recency half-life ${halfLife}d` : ''}${lastPlayed ? `, last played ${lastPlayed}` : ''}.`,
      ];
      if (args.response_format === 'json') {
        const raw = { topArtists: artistsRaw, recentStreams: streamsRaw };
        return {
          content: [{ type: 'text', text: JSON.stringify(raw) }],
          structuredContent: { ...raw },
        };
      }
      return textOut(lines, {
        user: u,
        artist: row?.name ?? args.artist,
        tier,
        intensity: Math.round(intensity * 1000) / 1000,
        lifetimeStreams: row?.count ?? 0,
        recentStreams: mine.length,
        halfLifeDays: halfLife,
        lastPlayed,
      });
    },
  );

  // ---- exposure_check ----
  server.tool(
    'exposure_check',
    'Where does a subject sit on the exposure ladder — unheard / sampled / explored / established / favorite? Evidence cites lifetime + recent counts. Read-only, no auth.',
    {
      statsfm_user: statsfmUserSchema,
      subject: z.string().min(1).describe('Artist, track, album, or genre name to check'),
      subject_type: z
        .enum(['artist', 'track', 'album', 'genre'])
        .optional()
        .describe('Which top-list to check against. Default: artist'),
      response_format: ResponseFormat,
    },
    async (args) => {
      const u = args.statsfm_user;
      const kind = args.subject_type ?? 'artist';
      const q = args.subject.toLowerCase();
      const listPath =
        kind === 'track'
          ? 'tracks'
          : kind === 'album'
            ? 'albums'
            : kind === 'genre'
              ? 'genres'
              : 'artists';
      const [listRaw, streamsRaw] = await Promise.all([
        statsfmGet<unknown>(`/users/${encodeURIComponent(u)}/top/${listPath}`, {
          range: 'lifetime',
          limit: '100',
        }),
        statsfmGet<unknown>(`/users/${encodeURIComponent(u)}/streams`, { limit: '500' }),
      ]);
      const rows = normalizeTopList(listRaw);
      const streams = normalizeStreams(streamsRaw);
      const row = rows.find(
        (r) => r.name.toLowerCase().includes(q) || r.id.toLowerCase() === q,
      );
      const recentHits = streams.filter(
        (s) =>
          s.trackName.toLowerCase().includes(q) ||
          s.artistNames.some((a) => a.toLowerCase().includes(q)),
      ).length;
      const tier = classifyExposure(row?.count ?? 0);
      const lines = [
        `Exposure for "${args.subject}" (${kind}, ${u}): ${tier} — ${row?.count ?? 0} lifetime streams, ${recentHits} in the recent sample.`,
      ];
      if (args.response_format === 'json') {
        const raw = { topList: listRaw, recentStreams: streamsRaw };
        return {
          content: [{ type: 'text', text: JSON.stringify(raw) }],
          structuredContent: { ...raw },
        };
      }
      return textOut(lines, {
        user: u,
        subject: args.subject,
        subject_type: kind,
        tier,
        lifetimeStreams: row?.count ?? 0,
        recentStreams: recentHits,
      });
    },
  );

  // ---- listening_eras ----
  server.tool(
    'listening_eras',
    'Change points in monthly listening: groups months into eras split on top-artist turnover or >60% volume shifts. Read-only, no auth.',
    {
      statsfm_user: statsfmUserSchema,
      response_format: ResponseFormat,
      max_results: MaxResults,
    },
    async (args) => {
      const u = args.statsfm_user;
      const streamsRaw = await statsfmGet<unknown>(
        `/users/${encodeURIComponent(u)}/streams`,
        { limit: '500' },
      );
      if (args.response_format === 'json') {
        const raw = { streams: streamsRaw };
        return {
          content: [{ type: 'text', text: JSON.stringify(raw) }],
          structuredContent: { ...raw },
        };
      }
      const streams = normalizeStreams(streamsRaw);
      const months = summarizeMonths(streams);
      if (months.length === 0) {
        return textOut([`No dated streams for "${u}" — cannot build eras.`]);
      }
      const eras = detectEras(months);
      const shaped = truncateItems(eras, resolveMaxResults(args.max_results));
      const lines = [`Listening eras for ${u} (${months.length} months, ${eras.length} eras):`];
      shaped.items.forEach((e, i) => {
        lines.push(
          `  ${i + 1}. ${e.startMonth} → ${e.endMonth} (${e.months}mo): ${e.signatureArtist}, ~${e.avgStreamsPerMonth}/mo [${e.boundaryReason}]`,
        );
      });
      if (shaped.footer) lines.push(`(${shaped.footer})`);
      const pagination = paginationInfo({
        total: eras.length,
        offset: 0,
        limit: null,
        returned: eras.length,
      });
      return {
        content: [{ type: 'text', text: lines.join('\n') }],
        structuredContent: listStructuredContent(shaped.items, pagination, {
          months,
          truncated: shaped.truncated,
          remaining: shaped.remaining,
        }),
      };
    },
  );

  // ---- listening_sessions ----
  server.tool(
    'listening_sessions',
    'Group recent streams into sessions: a gap longer than gap_minutes starts a new session (default 30). Read-only, no auth.',
    {
      statsfm_user: statsfmUserSchema,
      gap_minutes: z
        .number()
        .int()
        .min(5)
        .max(240)
        .optional()
        .describe('Inactivity gap that splits sessions. Default: 30'),
      limit: z.number().int().min(1).max(500).optional().describe('Streams to fetch. Default: 100'),
      response_format: ResponseFormat,
      max_results: MaxResults,
    },
    async (args) => {
      const u = args.statsfm_user;
      const gap = args.gap_minutes ?? 30;
      const streamsRaw = await statsfmGet<unknown>(
        `/users/${encodeURIComponent(u)}/streams`,
        { limit: String(args.limit ?? 100) },
      );
      if (args.response_format === 'json') {
        const raw = { streams: streamsRaw };
        return {
          content: [{ type: 'text', text: JSON.stringify(raw) }],
          structuredContent: { ...raw },
        };
      }
      const streams = normalizeStreams(streamsRaw);
      if (streams.length === 0) {
        return textOut([`No dated streams for "${u}" — no sessions to group.`]);
      }
      const sessions = groupSessions(streams, gap);
      const shaped = truncateItems(sessions, resolveMaxResults(args.max_results));
      const avgLen =
        sessions.reduce((s, x) => s + x.streams, 0) / Math.max(1, sessions.length);
      const longest = sessions.reduce((m, x) => Math.max(m, x.streams), 0);
      const fmt = (ms: number): string => new Date(ms).toISOString().slice(0, 16).replace('T', ' ');
      const lines = [
        `Listening sessions for ${u}: ${sessions.length} sessions from ${streams.length} streams (gap ${gap}m, avg ${avgLen.toFixed(1)} tracks, longest ${longest}).`,
      ];
      shaped.items.forEach((s, i) => {
        lines.push(
          `  ${i + 1}. ${fmt(s.startMs)} → ${fmt(s.endMs)} UTC: ${s.streams} tracks — ${s.tracks.slice(0, 5).join(' · ')}${s.tracks.length > 5 ? ` (+${s.tracks.length - 5} more)` : ''}`,
        );
      });
      if (shaped.footer) lines.push(`(${shaped.footer})`);
      const pagination = paginationInfo({
        total: sessions.length,
        offset: 0,
        limit: null,
        returned: sessions.length,
      });
      return {
        content: [{ type: 'text', text: lines.join('\n') }],
        structuredContent: listStructuredContent(shaped.items, pagination, {
          gapMinutes: gap,
          sessionCount: sessions.length,
          truncated: shaped.truncated,
          remaining: shaped.remaining,
        }),
      };
    },
  );

  // ---- forgotten_favorites ----
  server.tool(
    'forgotten_favorites',
    'High-lifetime tracks with zero recent plays — favorites that fell off. Ranked by lifetime streams. Read-only, no auth.',
    {
      statsfm_user: statsfmUserSchema,
      top_limit: z
        .number()
        .int()
        .min(5)
        .max(100)
        .optional()
        .describe('Lifetime top tracks to scan. Default: 50'),
      response_format: ResponseFormat,
      max_results: MaxResults,
    },
    async (args) => {
      const u = args.statsfm_user;
      const [topRaw, streamsRaw] = await Promise.all([
        statsfmGet<unknown>(`/users/${encodeURIComponent(u)}/top/tracks`, {
          range: 'lifetime',
          limit: String(args.top_limit ?? 50),
        }),
        statsfmGet<unknown>(`/users/${encodeURIComponent(u)}/streams`, { limit: '500' }),
      ]);
      if (args.response_format === 'json') {
        const raw = { topTracks: topRaw, recentStreams: streamsRaw };
        return {
          content: [{ type: 'text', text: JSON.stringify(raw) }],
          structuredContent: { ...raw },
        };
      }
      const top = normalizeTopList(topRaw);
      const streams = normalizeStreams(streamsRaw);
      const recentIds = new Set(streams.map((s) => s.trackId.toLowerCase()));
      const recentNames = new Set(streams.map((s) => s.trackName.toLowerCase()));
      const forgotten = top.filter(
        (t) =>
          !recentIds.has(t.id.toLowerCase()) && !recentNames.has(t.name.toLowerCase()),
      );
      const shaped = truncateItems(forgotten, resolveMaxResults(args.max_results));
      const lines = [
        forgotten.length === 0
          ? `No forgotten favorites for ${u} — every lifetime top-${top.length} track appears in the recent sample.`
          : `Forgotten favorites for ${u}: ${forgotten.length} of lifetime top-${top.length} absent from the last ${streams.length} streams.`,
      ];
      shaped.items.forEach((t, i) => {
        lines.push(`  ${i + 1}. ${t.name} (${t.count} lifetime streams)`);
      });
      if (shaped.footer) lines.push(`(${shaped.footer})`);
      if (shaped.items.length > 0) {
        lines.push(`Revival pick: replay "${shaped.items[0].name}".`);
      }
      const pagination = paginationInfo({
        total: forgotten.length,
        offset: 0,
        limit: null,
        returned: forgotten.length,
      });
      return {
        content: [{ type: 'text', text: lines.join('\n') }],
        structuredContent: listStructuredContent(shaped.items, pagination, {
          scannedTop: top.length,
          recentSampled: streams.length,
          truncated: shaped.truncated,
          remaining: shaped.remaining,
        }),
      };
    },
  );

  // ---- taste_recommendations ----
  server.tool(
    'taste_recommendations',
    'Bridge-mode recommendations: adjacent genres/artists between the listener\u2019s core and the unexplored, each with evidence and a risk note. Heuristic over stats.fm tops — read-only, no auth.',
    {
      statsfm_user: statsfmUserSchema,
      response_format: ResponseFormat,
      max_results: MaxResults,
    },
    async (args) => {
      const u = args.statsfm_user;
      const [artistsRaw, genresRaw, streamsRaw] = await Promise.all([
        statsfmGet<unknown>(`/users/${encodeURIComponent(u)}/top/artists`, {
          range: 'lifetime',
          limit: '30',
        }),
        statsfmGet<unknown>(`/users/${encodeURIComponent(u)}/top/genres`, {
          range: 'lifetime',
          limit: '15',
        }),
        statsfmGet<unknown>(`/users/${encodeURIComponent(u)}/streams`, { limit: '200' }),
      ]);
      if (args.response_format === 'json') {
        const raw = { topArtists: artistsRaw, topGenres: genresRaw, recentStreams: streamsRaw };
        return {
          content: [{ type: 'text', text: JSON.stringify(raw) }],
          structuredContent: { ...raw },
        };
      }
      const artists = normalizeTopList(artistsRaw);
      const genres = normalizeTopList(genresRaw);
      const streams = normalizeStreams(streamsRaw);
      if (artists.length === 0 || genres.length === 0) {
        return textOut([
          `Not enough taste data for "${u}" to build bridges — need top artists and genres.`,
        ]);
      }
      const coreGenres = genres.slice(0, 3).map((g) => g.name);
      const recentArtistNames = new Set(
        streams.flatMap((s) => s.artistNames.map((a) => a.toLowerCase())),
      );
      interface Bridge {
        direction: string;
        evidence: string;
        risk: string;
      }
      const bridges: Bridge[] = [];
      for (const g of genres.slice(3, 10)) {
        bridges.push({
          direction: `Bridge from ${coreGenres.join(' / ')} toward ${g.name}`,
          evidence: `${g.name} ranks #${genres.indexOf(g) + 1} lifetime with ${g.count} streams — adjacent but underexplored vs core ${coreGenres[0]}.`,
          risk: `Only ${g.count} lifetime streams: start with one playlist, skip if the first 3 tracks bounce.`,
        });
      }
      for (const a of artists.slice(10, 20)) {
        if (recentArtistNames.has(a.name.toLowerCase())) continue;
        bridges.push({
          direction: `Revisit ${a.name} (lifetime #${artists.indexOf(a) + 1})`,
          evidence: `${a.count} lifetime streams but absent from the last ${streams.length} — dormant affinity, not a cold start.`,
          risk: `Taste may have moved on: treat as a re-test, not a lock.`,
        });
        if (bridges.length >= 10) break;
      }
      const shaped = truncateItems(bridges, resolveMaxResults(args.max_results, 5));
      const lines = [`Bridge-mode recommendations for ${u} (core: ${coreGenres.join(' / ')}):`];
      shaped.items.forEach((b, i) => {
        lines.push(`  ${i + 1}. ${b.direction}`);
        lines.push(`      Evidence: ${b.evidence}`);
        lines.push(`      Risk: ${b.risk}`);
      });
      if (shaped.footer) lines.push(`(${shaped.footer})`);
      const pagination = paginationInfo({
        total: bridges.length,
        offset: 0,
        limit: null,
        returned: bridges.length,
      });
      return {
        content: [{ type: 'text', text: lines.join('\n') }],
        structuredContent: listStructuredContent(shaped.items, pagination, {
          coreGenres,
          truncated: shaped.truncated,
          remaining: shaped.remaining,
        }),
      };
    },
  );

  // ---- record_feedback ----
  server.tool(
    'record_feedback',
    'Record a local-only taste verdict (love/like/mixed/boring/dislike) or list stored verdicts. Never touches the network — memory for future recommendations.',
    {
      action: z
        .enum(['record', 'list'])
        .optional()
        .describe('record (default) stores a verdict; list returns stored verdicts'),
      subject_type: z
        .enum(['track', 'artist', 'album', 'genre'])
        .optional()
        .describe('Required for record'),
      subject: z.string().min(1).optional().describe('Track/artist/album/genre name. Required for record'),
      rating: z
        .enum(['love', 'like', 'mixed', 'boring', 'dislike'])
        .optional()
        .describe('Required for record'),
      note: z.string().max(500).optional().describe('Optional free-text note'),
      response_format: ResponseFormat,
    },
    async (args) => {
      const action = args.action ?? 'record';
      if (action === 'list') {
        const entries = listFeedbackEntries();
        const lines =
          entries.length === 0
            ? ['No feedback recorded yet — use action=record to store a verdict.']
            : [
                `${entries.length} feedback entr${entries.length === 1 ? 'y' : 'ies'}:`,
                ...entries.map(
                  (e) =>
                    `  #${e.id} [${e.rating}] ${e.subject_type}:${e.subject}${e.note ? ` — ${e.note}` : ''} (${e.at})`,
                ),
              ];
        if (args.response_format === 'json') {
          return {
            content: [{ type: 'text', text: JSON.stringify(entries) }],
            structuredContent: { entries },
          };
        }
        return textOut(lines, { entries });
      }
      if (!args.subject_type || !args.subject || !args.rating) {
        throw new Error(
          'record_feedback with action=record requires subject_type, subject, and rating',
        );
      }
      const entry = recordFeedbackEntry({
        subject_type: args.subject_type,
        subject: args.subject,
        rating: args.rating,
        note: args.note,
      });
      const counts: Record<FeedbackRating, number> = {
        love: 0,
        like: 0,
        mixed: 0,
        boring: 0,
        dislike: 0,
      };
      for (const e of listFeedbackEntries()) counts[e.rating] += 1;
      const lines = [
        `Recorded #${entry.id}: [${entry.rating}] ${entry.subject_type}:${entry.subject}${entry.note ? ` — ${entry.note}` : ''} (local-only, ${listFeedbackEntries().length} total).`,
      ];
      return textOut(lines, { entry, counts });
    },
  );
}
