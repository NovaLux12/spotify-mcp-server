/**
 * swarm3b discovery slice (second discovery builder) — 500-tool swarm v1.26.0 (issue #442).
 * Owned by the swarm3-discovery builder.
 *
 * 24 read-only tools in three families:
 *   1. Artist-catalog exploration — discography overviews, release timelines,
 *      era maps, release-type breakdowns, label attribution, decade spreads,
 *      name-pattern detectors (reissues, live albums) and full-text release
 *      search.
 *   2. Album-level deep dives — track exploration with cross-album duplicate
 *      detection, side-A openers, deep-cut heuristics, B-side detectors,
 *      runtime profiles, release-origin lookups and anniversary checks.
 *   3. Library-driven discovery — newest releases across saved/followed
 *      artists, new-to-you artist discovery from playlists, and saved-album
 *      label profiling.
 *
 * Everything is computed client-side from allowed read endpoints only; no
 * deprecated surfaces (SPEC §9), no popularity/follower fields anywhere.
 * NOTE: `artist_discography_timeline` already exists in exhaust2_catalog.ts
 * (#337) — this slice deliberately does NOT re-register that name.
 */
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { SpotifyClient } from '../client.js';
import type {
  FollowedArtistsResponse,
  SavedAlbumItem,
  SavedTrackItem,
  SpotifyArtistFull,
  SearchResponse,
  SpotifyAlbumFull,
  SpotifyAlbumItem,
  SpotifyPaged,
  SpotifyTrackSimple,
} from '../types/spotify.js';
import {
  ResponseFormat,
  resolveMaxResults,
  truncateItems,
  paginationInfo,
  listStructuredContent,
} from '../shaping.js';
import type { ResponseFormatValue } from '../shaping.js';
import { resolveSpotifyId, spotifyId } from '../refs.js';
import { getConfig } from '../config.js';

// ---------------------------------------------------------------------------
// Shared shapes + plumbing
// ---------------------------------------------------------------------------

const SearchLimit = z
  .number()
  .int()
  .min(1)
  .max(10)
  .optional()
  .describe('Results per page, 1–10 (Feb-2026 /search cap). Default: 10');

const Market = z
  .string()
  .optional()
  .describe("ISO 3166-1 alpha-2 market code (e.g. 'US'); omit for 'from_token' behaviour");

const SearchLimitFragment = z
  .number()
  .int()
  .min(1)
  .max(10)
  .optional()
  .describe('Results per page, 1-10 (Feb-2026 /search cap). Default: 5');

const IncludeGroups = z
  .string()
  .optional()
  .describe('Comma-separated album groups: album,single,appears_on,compilation. Default: album,single');

type ToolOut = {
  content: Array<{ type: 'text'; text: string }>;
  structuredContent?: Record<string, unknown>;
};

function emit(rf: ResponseFormatValue, prose: string, payload: Record<string, unknown>): ToolOut {
  return {
    content: [{ type: 'text', text: rf === 'json' ? JSON.stringify(payload, null, 2) : prose }],
    structuredContent: payload,
  };
}

/** m:ss duration formatting for prose rows; h:mm:ss once an hour or more. */
function fmtDur(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '?:??';
  const s = Math.floor((ms % 60_000) / 1000);
  if (ms >= 3_600_000) {
    const h = Math.floor(ms / 3_600_000);
    const m = Math.floor((ms % 3_600_000) / 60_000);
    return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  }
  const m = Math.floor(ms / 60_000);
  return `${m}:${String(s).padStart(2, '0')}`;
}

/** Parse the year prefix of an ISO-ish Spotify release date, or null. */
function yearOf(date: string | null | undefined): number | null {
  if (!date) return null;
  const y = Number(date.slice(0, 4));
  return Number.isInteger(y) && y > 0 ? y : null;
}

/** Parse a Spotify release date as a UTC timestamp (YYYY → Jan 1), or null. */
function tsOf(date: string | null | undefined): number | null {
  if (!date) return null;
  const t = Date.parse(date.length === 4 ? `${date}-01-01` : date);
  return Number.isFinite(t) ? t : null;
}

/** Whole days between two timestamps. */
function daysBetween(a: number, b: number): number {
  return Math.round(Math.abs(b - a) / 86_400_000);
}

/** Lowercase, strip punctuation/symbols, collapse whitespace. */
function normalizeName(name: string): string {
  return name
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\p{P}\p{S}]/gu, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function chunk<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/** Build /search query params (Feb-2026 cap: limit ≤ 10). */
function searchParams(q: string, type: string, limit: number, market?: string, offset = 0): Record<string, string> {
  const params: Record<string, string> = { q, type, limit: String(Math.min(10, Math.max(1, limit))), offset: String(offset) };
  if (market) params.market = market;
  return params;
}

/** Album payload extended with fields the API returns but our base type omits. */
interface AlbumWithMeta extends SpotifyAlbumFull {
  label?: string;
  copyrights?: Array<{ text?: string }>;
}

/**
 * Resolve an artist reference: ID/URI/URL passes straight through; otherwise
 * an artist search picks the closest normalized-name match (falling back to
 * the first row) and discloses the candidates on miss.
 */
async function resolveArtistRef(
  client: SpotifyClient,
  ref: string,
): Promise<{ id: string; name: string | null; resolvedBy: 'id' | 'search'; candidates: string[] }> {
  const direct = resolveSpotifyId(ref, 'artist');
  if (direct) return { id: direct, name: null, resolvedBy: 'id', candidates: [] };
  const data = await client.get<SearchResponse>('/search', searchParams(ref, 'artist', 10));
  const rows = data?.artists?.items ?? [];
  if (rows.length === 0) throw new Error(`No artist found for "${ref}" — pass a Spotify artist ID instead.`);
  const target = normalizeName(ref);
  const exact = rows.find((a) => normalizeName(a.name) === target) ?? rows[0];
  return { id: exact.id, name: exact.name, resolvedBy: 'search', candidates: rows.map((a) => a.name) };
}

/** Paginated walk of an artist's albums (respects the configured fetch cap). */
async function artistAlbums(
  client: SpotifyClient,
  artistId: string,
  includeGroups: string,
  maxItems: number,
): Promise<SpotifyAlbumItem[]> {
  return client.getAllPages<SpotifyAlbumItem>(`/artists/${encodeURIComponent(artistId)}/albums`, {
    include_groups: includeGroups,
    limit: '50',
  }, { maxItems });
}

/** Fetch full album objects in /albums?ids= batches of 20 (adds label/copyrights). */
async function fetchAlbumBatches(
  client: SpotifyClient,
  ids: readonly string[],
): Promise<AlbumWithMeta[]> {
  const out: AlbumWithMeta[] = [];
  for (const batch of chunk(ids, 20)) {
    const res = await client.get<{ albums: AlbumWithMeta[] | null }>('/albums', { ids: batch.join(',') });
    if (res?.albums) out.push(...res.albums);
  }
  return out;
}

/** Full track listing for one album via /albums/{id}/tracks (walks all pages). */
async function albumTracksFull(client: SpotifyClient, albumId: string): Promise<SpotifyTrackSimple[]> {
  return client.getAllPages<SpotifyTrackSimple>(`/albums/${encodeURIComponent(albumId)}/tracks`, { limit: '50' });
}

/** Label string from an album payload, with a stable fallback. */
function labelOf(album: AlbumWithMeta): string {
  const raw = (album.label ?? '').trim();
  return raw.length > 0 ? raw : '(unknown label)';
}

// ---------------------------------------------------------------------------
// 1–10: artist-catalog exploration
// ---------------------------------------------------------------------------

export function registerSwarm3bDiscoveryTools(server: McpServer, client: SpotifyClient): void {
  const fetchAllCap = () => getConfig().fetchAllCap;

  // ------------------------------------------------------------------ 1
  server.tool(
    'artist_discography_explorer',
    'Overview stats for one artist\'s discography: release counts by type, first and latest releases, active span and releases per active year. Accepts an artist ID, URI, URL or name (name → closest search match). Quota: 🟡 one paginated /artists/{id}/albums walk.',
    {
      artist: z.string().min(1).describe('Artist ID, URI, URL, or name to resolve via search'),
      include_groups: IncludeGroups,
      response_format: ResponseFormat,
      max_results: z.number().int().positive().max(2000).optional(),
    },
    async (args) => {
      const rf = args.response_format;
      const ref = await resolveArtistRef(client, args.artist);
      const [profile, albums] = await Promise.all([
        ref.name
          ? Promise.resolve({ name: ref.name, genres: [] as string[] })
          : client.get<SpotifyArtistFull>(`/artists/${encodeURIComponent(ref.id)}`),
        artistAlbums(client, ref.id, args.include_groups ?? 'album,single', fetchAllCap()),
      ]);
      if (!profile) throw new Error(`Artist ${ref.id} not found`);
      const byType = new Map<string, number>();
      for (const a of albums) byType.set(a.album_type ?? 'unknown', (byType.get(a.album_type ?? 'unknown') ?? 0) + 1);
      const sorted = [...albums].sort((a, b) => (a.release_date ?? '').localeCompare(b.release_date ?? ''));
      const first = sorted[0] ?? null;
      const latest = sorted[sorted.length - 1] ?? null;
      const years = new Set(albums.map((a) => yearOf(a.release_date)).filter((y): y is number => y !== null));
      const spanYears = first && latest ? (yearOf(latest.release_date) ?? 0) - (yearOf(first.release_date) ?? 0) + 1 : 0;
      const perYear = years.size > 0 ? Math.round((albums.length / years.size) * 10) / 10 : 0;
      const rows = sorted.map((a) => `${yearOf(a.release_date) ?? '????'} · ${a.album_type} · ${a.name} (${a.total_tracks} tracks)`);
      const prose = [
        `Discography overview — ${profile.name}${profile.genres?.length ? ` (${profile.genres.slice(0, 4).join(', ')})` : ''}:`,
        `Releases: ${albums.length} across ${years.size} active year(s) (~${perYear}/active year, span ${spanYears}y)`,
        ...[...byType.entries()].sort().map(([t, n]) => `  ${t}: ${n}`),
        first ? `First: ${first.name} (${first.release_date})` : null,
        latest ? `Latest: ${latest.name} (${latest.release_date})` : null,
        '',
        ...rows.slice(0, 40),
      ].filter((l): l is string => l !== null).join('\n');
      const payload = {
        artist: { id: ref.id, name: profile.name, genres: profile.genres ?? [] },
        totals: { releases: albums.length, active_years: years.size, span_years: spanYears, releases_per_active_year: perYear },
        counts_by_type: Object.fromEntries([...byType.entries()].sort()),
        first_release: first ? { id: first.id, name: first.name, release_date: first.release_date, album_type: first.album_type } : null,
        latest_release: latest ? { id: latest.id, name: latest.name, release_date: latest.release_date, album_type: latest.album_type } : null,
        releases: albums.map((a) => ({ id: a.id, name: a.name, release_date: a.release_date, album_type: a.album_type, total_tracks: a.total_tracks })),
      };
      return emit(rf, prose, payload);
    },
  );

  // ------------------------------------------------------------------ 2
  server.tool(
    'artist_album_timeline',
    '[local-compute] Chronological release table (oldest → newest) with inter-release gap days, median gap and the longest drought highlighted. Quota: 🟡 one paginated /artists/{id}/albums walk.',
    {
      artist_id: spotifyId('artist').describe('Spotify artist ID, URI, or URL'),
      include_groups: IncludeGroups,
      response_format: ResponseFormat,
      max_results: z.number().int().positive().max(2000).optional(),
    },
    async (args) => {
      const rf = args.response_format;
      const albums = await artistAlbums(client, args.artist_id, args.include_groups ?? 'album,single', fetchAllCap());
      const sorted = [...albums].sort((a, b) => (a.release_date ?? '').localeCompare(b.release_date ?? ''));
      let prevTs: number | null = null;
      const rows = sorted.map((a) => {
        const ts = tsOf(a.release_date);
        const gap = ts !== null && prevTs !== null ? daysBetween(prevTs, ts) : null;
        if (ts !== null) prevTs = ts;
        return {
          id: a.id, name: a.name, release_date: a.release_date, year: yearOf(a.release_date),
          album_type: a.album_type, total_tracks: a.total_tracks, gap_days_since_previous: gap,
        };
      });
      const gaps = rows.map((r) => r.gap_days_since_previous).filter((g): g is number => g !== null);
      const median = gaps.length ? [...gaps].sort((a, b) => a - b)[Math.floor(gaps.length / 2)] : null;
      const longestIdx = rows.reduce((best, r, i) => ((r.gap_days_since_previous ?? -1) > ((rows[best]?.gap_days_since_previous ?? -1)) ? i : best), 0);
      const longest = rows.length > 1 && rows[longestIdx].gap_days_since_previous
        ? { after: rows[longestIdx - 1]?.name ?? null, before: rows[longestIdx].name, days: rows[longestIdx].gap_days_since_previous }
        : null;
      const cap = resolveMaxResults(args.max_results, 500);
      const trunc = truncateItems(rows, cap);
      const prose = [
        `Release timeline (${sorted.length} releases, median gap ${median ?? '—'}d${longest ? `, longest drought ${longest.days}d between "${longest.after}" and "${longest.before}"` : ''}):`,
        '',
        ...trunc.items.map((r) =>
          `${r.year ?? '????'}-${String(r.release_date ?? '').slice(5, 10) || '??'} · ${r.album_type} · ${r.name} · gap ${r.gap_days_since_previous ?? '—'}d`),
        trunc.footer ? `\n(${trunc.footer})` : '',
      ].join('\n');
      const payload = listStructuredContent(trunc.items, paginationInfo({
        total: trunc.total, offset: 0, returned: trunc.returned,
      }), {
        artist_id: args.artist_id,
        median_gap_days: median,
        longest_gap: longest,
      });
      return emit(rf, prose, payload);
    },
  );

  // ------------------------------------------------------------------ 3
  server.tool(
    'artist_era_map',
    'Cluster an artist\'s releases into eras separated by quiet periods longer than `gap_years`, with one representative album per era and era spans. Quota: 🟡 one paginated /artists/{id}/albums walk.',
    {
      artist_id: spotifyId('artist').describe('Spotify artist ID, URI, or URL'),
      gap_years: z.number().min(0.5).max(20).optional().describe('Quiet period (in years) that starts a new era. Default: 2'),
      include_groups: IncludeGroups,
      response_format: ResponseFormat,
    },
    async (args) => {
      const rf = args.response_format;
      const gapDays = Math.round((args.gap_years ?? 2) * 365.25);
      const albums = await artistAlbums(client, args.artist_id, args.include_groups ?? 'album,single', fetchAllCap());
      const sorted = [...albums].sort((a, b) => (a.release_date ?? '').localeCompare(b.release_date ?? ''));
      const eras: Array<{
        era: number; start_year: number | null; end_year: number | null; releases: number;
        representative: { id: string; name: string; release_date: string } | null; titles: string[];
      }> = [];
      let prevTs: number | null = null;
      for (const a of sorted) {
        const ts = tsOf(a.release_date);
        if (eras.length === 0 || (ts !== null && prevTs !== null && daysBetween(prevTs, ts) > gapDays)) {
          eras.push({ era: eras.length + 1, start_year: yearOf(a.release_date), end_year: yearOf(a.release_date), releases: 0, representative: null, titles: [] });
        }
        const era = eras[eras.length - 1];
        era.end_year = yearOf(a.release_date);
        era.releases += 1;
        if (era.titles.length < 6) era.titles.push(a.name);
        if (!era.representative && a.album_type === 'album') {
          era.representative = { id: a.id, name: a.name, release_date: a.release_date };
        }
        if (ts !== null) prevTs = ts;
      }
      const prose = [
        `Era map — ${eras.length} era(s) at >${gapDays}d quiet thresholds:`,
        '',
        ...eras.map((e) =>
          `Era ${e.era} (${e.start_year ?? '????'}–${e.end_year ?? '????'}, ${e.releases} releases) — representative: ${e.representative?.name ?? e.titles[0] ?? '—'}\n    ${e.titles.join(' · ')}`),
      ].join('\n');
      const payload = { artist_id: args.artist_id, gap_threshold_days: gapDays, era_count: eras.length, eras };
      return emit(rf, prose, payload);
    },
  );

  // ------------------------------------------------------------------ 4
  server.tool(
    'artist_release_type_breakdown',
    'Break an artist\'s discography down by album type (album · single · compilation · appears_on): counts, first and latest per type, and sample titles. Quota: 🟡 one paginated /artists/{id}/albums walk.',
    {
      artist_id: spotifyId('artist').describe('Spotify artist ID, URI, or URL'),
      include_groups: IncludeGroups,
      response_format: ResponseFormat,
    },
    async (args) => {
      const rf = args.response_format;
      const albums = await artistAlbums(client, args.artist_id, args.include_groups ?? 'album,single,compilation,appears_on', fetchAllCap());
      const groups = new Map<string, SpotifyAlbumItem[]>();
      for (const a of albums) {
        const key = a.album_type ?? 'unknown';
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key)!.push(a);
      }
      const breakdown = [...groups.entries()].sort().map(([type, rows]) => {
        const sorted = [...rows].sort((x, y) => (x.release_date ?? '').localeCompare(y.release_date ?? ''));
        return {
          album_type: type,
          count: rows.length,
          first: { id: sorted[0].id, name: sorted[0].name, release_date: sorted[0].release_date },
          latest: { id: sorted[sorted.length - 1].id, name: sorted[sorted.length - 1].name, release_date: sorted[sorted.length - 1].release_date },
          samples: sorted.slice(0, 5).map((a) => a.name),
        };
      });
      const prose = [
        `Release-type breakdown (${albums.length} releases):`,
        '',
        ...breakdown.map((b) =>
          `${b.album_type}: ${b.count} · first ${b.first.release_date} "${b.first.name}" · latest ${b.latest.release_date} "${b.latest.name}"`),
      ].join('\n');
      const payload = { artist_id: args.artist_id, total_releases: albums.length, breakdown };
      return emit(rf, prose, payload);
    },
  );

  // ------------------------------------------------------------------ 5
  server.tool(
    'artist_latest_releases',
    'Fetch the most recent N releases from an artist\'s catalog with age in days — a quick "what\'s new here" read. Quota: 🟡 one paginated /artists/{id}/albums walk.',
    {
      artist_id: spotifyId('artist').describe('Spotify artist ID, URI, or URL'),
      limit: z.number().int().min(1).max(50).optional().describe('How many recent releases to show. Default: 5'),
      include_groups: IncludeGroups,
      response_format: ResponseFormat,
     },
    async (args) => {
      const rf = args.response_format;
      const albums = await artistAlbums(client, args.artist_id, args.include_groups ?? 'album,single', fetchAllCap());
      const now = Date.now();
      const newest = [...albums]
        .sort((a, b) => (b.release_date ?? '').localeCompare(a.release_date ?? ''))
        .slice(0, Math.min(50, Math.max(1, args.limit ?? 5)))
        .map((a) => {
          const ts = tsOf(a.release_date);
          return {
            id: a.id, name: a.name, release_date: a.release_date, album_type: a.album_type,
            total_tracks: a.total_tracks, age_days: ts !== null ? daysBetween(ts, now) : null,
          };
        });
      const prose = [
        `Latest releases (${newest.length}):`,
        '',
        ...newest.map((r) =>
          `${r.release_date} · ${r.album_type} · ${r.name} (${r.total_tracks} tracks, ${r.age_days ?? '?'}d old)`),
      ].join('\n');
      const payload = { artist_id: args.artist_id, items: newest };
      return emit(rf, prose, payload);
    },
  );

  // ------------------------------------------------------------------ 6
  const REISSUE_RE = /\b(live|deluxe|remaster(ed)?|expanded|edition|version|demo|mono|stereo|anniversary|special|bonus|explicit|reissue)\b/i;

  server.tool(
    'artist_reissue_detector',
    'Detect alternate versions (live/deluxe/remaster/expanded editions) in an artist\'s release titles and group them by base title — spot the canonical release vs its variants. Quota: 🟡 one paginated /artists/{id}/albums walk.',
    {
      artist_id: spotifyId('artist').describe('Spotify artist ID, URI, or URL'),
      max_releases: z.number().int().positive().max(1000).optional().describe('Releases to scan. Default: SPOTIFY_MCP_FETCH_ALL_CAP'),
      response_format: ResponseFormat,
      max_results: z.number().int().positive().max(2000).optional(),
    },
    async (args) => {
      const rf = args.response_format;
      const albums = await artistAlbums(client, args.artist_id, 'album,single', Math.min(fetchAllCap(), args.max_releases ?? fetchAllCap()));
      const groups = new Map<string, Array<{ name: string; year: number | null; album_type: string; id: string }>>();
      for (const a of albums) {
        const base = a.name.replace(/\s*[[(].*[\])]\s*/g, ' ').replace(REISSUE_RE, ' ').replace(/\s*-\s*.*(?=(live|deluxe|remaster|expanded|edition|version))/gi, ' ').replace(/\s+/g, ' ').trim() || a.name;
        if (!groups.has(normalizeName(base))) groups.set(normalizeName(base), []);
        groups.get(normalizeName(base))!.push({ name: a.name, year: yearOf(a.release_date), album_type: a.album_type, id: a.id });
      }
      const variantGroups = [...groups.entries()]
        .filter(([, rows]) => rows.length > 1)
        .map(([base, rows]) => ({ base_title: rows[0].name, variant_count: rows.length, variants: [...rows].sort((x, y) => (x.year ?? 0) - (y.year ?? 0)) }))
        .sort((a, b) => b.variant_count - a.variant_count);
      const prose = [
        `Reissue scan — ${variantGroups.length} base title(s) with multiple variants (scanned ${albums.length} releases):`,
        '',
        ...(variantGroups.length
          ? variantGroups.map((g) =>
              `${g.variant_count}× "${g.base_title}":\n${g.variants.map((v) => `    ${v.year ?? '????'} · ${v.album_type} · ${v.name}`).join('\n')}`)
          : ['No multi-variant titles found.']),
      ].join('\n');
      const cap = resolveMaxResults((args as { max_results?: number }).max_results, 100);
      const trunc = truncateItems(variantGroups, cap);
      const payload = listStructuredContent(trunc.items, paginationInfo({
        total: trunc.total, returned: trunc.returned,
      }), { artist_id: args.artist_id, releases_scanned: albums.length });
      return emit(rf, prose, payload);
    },
  );

  // ------------------------------------------------------------------ 7
  server.tool(
    'artist_debut_release_finder',
    'Dig up an artist\'s earliest release with full detail plus everything else they released in that same year — the origin story view. Quota: 🟡 one paginated /artists/{id}/albums walk.',
    {
      artist_id: spotifyId('artist').describe('Spotify artist ID, URI, or URL'),
      response_format: ResponseFormat,
    },
    async (args) => {
      const rf = args.response_format;
      const albums = await artistAlbums(client, args.artist_id, 'album,single,compilation,appears_on', fetchAllCap());
      if (albums.length === 0) throw new Error('This artist has no releases on Spotify.');
      const sorted = [...albums].sort((a, b) => (a.release_date ?? '').localeCompare(b.release_date ?? ''));
      const earliestDate = sorted[0].release_date ?? '';
      const earliest = sorted.filter((a) => (a.release_date ?? '') === earliestDate);
      const sameYear = sorted.filter((a) => yearOf(a.release_date) === yearOf(earliestDate) && !earliest.includes(a));
      const row = (a: SpotifyAlbumItem) => `${a.release_date} · ${a.album_type} · ${a.name} (${a.total_tracks} tracks)`;
      const prose = [
        `First release (${earliestDate}):`,
        ...earliest.map(row),
        sameYear.length ? `\nAlso in ${yearOf(earliestDate)} (${sameYear.length}):` : null,
        ...sameYear.slice(0, 15).map(row),
      ].filter((l): l is string => l !== null).join('\n');
      const payload = {
        artist_id: args.artist_id,
        first_releases: earliest.map((a) => ({ id: a.id, name: a.name, release_date: a.release_date, album_type: a.album_type, total_tracks: a.total_tracks })),
        same_year_also: sameYear.slice(0, 25).map((a) => ({ id: a.id, name: a.name, release_date: a.release_date, album_type: a.album_type })),
      };
      return emit(rf, prose, payload);
    },
  );

  // ------------------------------------------------------------------ 8
  server.tool(
    'label_discography_explorer',
    'Group an artist\'s albums and singles by record label (via batched /albums?ids= payloads) and rank labels by release count with year ranges. Quota: 🔴 paginated walk + batched /albums lookups.',
    {
      artist_id: spotifyId('artist').describe('Spotify artist ID, URI, or URL'),
      include_groups: IncludeGroups,
      response_format: ResponseFormat,
      max_results: z.number().int().positive().max(2000).optional(),
    },
    async (args) => {
      const rf = args.response_format;
      const albums = await artistAlbums(client, args.artist_id, args.include_groups ?? 'album,single', fetchAllCap());
      const metas = await fetchAlbumBatches(client, albums.map((a) => a.id));
      const byLabel = new Map<string, Array<{ name: string; year: number | null; id: string }>>();
      for (const m of metas) {
        const label = labelOf(m);
        if (!byLabel.has(label)) byLabel.set(label, []);
        byLabel.get(label)!.push({ name: m.name, year: yearOf(m.release_date), id: m.id });
      }
      const rows = [...byLabel.entries()]
        .map(([label, items]) => ({
          label,
          count: items.length,
          first_year: Math.min(...items.map((i) => i.year ?? 9999)),
          latest_year: Math.max(...items.map((i) => i.year ?? 0)),
          samples: items.slice(0, 5).map((i) => i.name),
        }))
        .sort((a, b) => b.count - a.count);
      const cap = resolveMaxResults(args.max_results, 50);
      const trunc = truncateItems(rows, cap);
      const prose = [
        `Labels across ${metas.length} releases:`,
        '',
        ...trunc.items.map((r) => `${r.label}: ${r.count} release(s), ${r.first_year === 9999 ? '????' : r.first_year}–${r.latest_year || '????'} · e.g. ${r.samples.join(', ')}`),
        trunc.footer ? `\n(${trunc.footer})` : '',
      ].join('\n');
      const payload = listStructuredContent(trunc.items, paginationInfo({
        total: trunc.total, returned: trunc.returned,
      }), { artist_id: args.artist_id, releases_grouped: metas.length });
      return emit(rf, prose, payload);
    },
  );

  // ------------------------------------------------------------------ 9
  server.tool(
    'artist_discography_search',
    'Full-text filter over an artist\'s release titles — find that live album, deluxe edition or collaboration without scrolling the whole catalog. Quota: 🟡 one paginated /artists/{id}/albums walk.',
    {
      artist_id: spotifyId('artist').describe('Spotify artist ID, URI, or URL'),
      query: z.string().min(1).describe('Case-insensitive text to match against release titles'),
      include_groups: IncludeGroups,
      response_format: ResponseFormat,
      max_results: z.number().int().positive().max(2000).optional(),
    },
    async (args) => {
      const rf = args.response_format;
      const albums = await artistAlbums(client, args.artist_id, args.include_groups ?? 'album,single,compilation,appears_on', fetchAllCap());
      const needle = normalizeName(args.query);
      const hits = albums.filter((a) => normalizeName(a.name).includes(needle));
      const cap = resolveMaxResults((args as { max_results?: number }).max_results, 100);
      const trunc = truncateItems(hits, cap);
      const prose = [
        `Releases matching "${args.query}": ${hits.length} of ${albums.length} scanned.`,
        '',
        ...trunc.items.map((a) => `${yearOf(a.release_date) ?? '????'} · ${a.album_type} · ${a.name} (${a.total_tracks} tracks)`),
        trunc.footer ? `\n(${trunc.footer})` : '',
      ].join('\n');
      const payload = listStructuredContent(
        trunc.items.map((a) => ({ id: a.id, name: a.name, release_date: a.release_date, album_type: a.album_type, total_tracks: a.total_tracks })),
        paginationInfo({ total: trunc.total, returned: trunc.returned }),
        { artist_id: args.artist_id, query: args.query, scanned: albums.length },
      );
      return emit(rf, prose, payload);
    },
  );

  // ------------------------------------------------------------------ 10
  server.tool(
    'artist_decade_span',
    'Histogram of an artist\'s releases per decade with the dominant decade called out — instantly see which era carries the catalog. Quota: 🟡 one paginated /artists/{id}/albums walk.',
    {
      artist_id: spotifyId('artist').describe('Spotify artist ID, URI, or URL'),
      include_groups: IncludeGroups,
      response_format: ResponseFormat,
    },
    async (args) => {
      const rf = args.response_format;
      const albums = await artistAlbums(client, args.artist_id, args.include_groups ?? 'album,single', fetchAllCap());
      const decades = new Map<string, number>();
      for (const a of albums) {
        const y = yearOf(a.release_date);
        if (y === null) continue;
        const key = `${Math.floor(y / 10) * 10}s`;
        decades.set(key, (decades.get(key) ?? 0) + 1);
      }
      const rows = [...decades.entries()].sort((a, b) => a[0].localeCompare(b[0]));
      const dominant = rows.reduce((best, r) => (r[1] > (decades.get(best) ?? 0) ? r[0] : best), rows[0]?.[0] ?? null);
      const prose = [
        `Decade spread (${albums.length} releases)${dominant ? ` — dominant: ${dominant}` : ''}:`,
        '',
        ...rows.map(([d, n]) => `${d}: ${'#'.repeat(Math.min(40, n))} ${n}`),
      ].join('\n');
      const payload = {
        artist_id: args.artist_id,
        total_releases: albums.length,
        dominant_decade: dominant,
        decades: Object.fromEntries(rows),
      };
      return emit(rf, prose, payload);
    },
  );

  // ---------------------------------------------------------------------------
  // 11–17: album-level deep dives
  // ---------------------------------------------------------------------------

  // ------------------------------------------------------------------ 11
  server.tool(
    'album_track_explorer',
    'Full track listing for one album with per-track cross-album duplicate counts — spot which songs are unique to this release vs recycled across the discography. Quota: 🔴 one album fetch + one paginated discography walk.',
    {
      album_id: spotifyId('album').describe('Spotify album ID, URI, or URL'),
      response_format: ResponseFormat,
      max_results: z.number().int().positive().max(2000).optional(),
    },
    async (args) => {
      const rf = args.response_format;
      const album = await client.get<AlbumWithMeta>(`/albums/${encodeURIComponent(args.album_id)}`);
      if (!album) throw new Error(`Album ${args.album_id} not found`);
      const tracks = await albumTracksFull(client, args.album_id);
      const artistIds = album.artists.map((a) => a.id);
      const discography: SpotifyAlbumItem[] = [];
      for (const aid of artistIds.slice(0, 2)) {
        discography.push(...await artistAlbums(client, aid, 'album,single,compilation', 50));
      }
      const otherIds = [...new Set(discography.map((a) => a.id))].filter((id) => id !== album.id).slice(0, 50);
      const otherMetas = await fetchAlbumBatches(client, otherIds);
      const otherTrackNames = new Set<string>();
      for (const m of otherMetas) for (const t of m.tracks?.items ?? []) otherTrackNames.add(normalizeName(t.name));
      const rows = tracks.map((t) => {
        const n = normalizeName(t.name);
        return {
          id: t.id, name: t.name, track_number: t.track_number, duration_ms: t.duration_ms,
          duration: fmtDur(t.duration_ms),
          also_on_other_albums: otherTrackNames.has(n) ? otherMetas.filter((m) => (m.tracks?.items ?? []).some((o) => normalizeName(o.name) === n)).length : 0,
        };
      });
      const totalMs = rows.reduce((s, t) => s + t.duration_ms, 0);
      const longest = rows.reduce((best, t) => (t.duration_ms > best.duration_ms ? t : best), rows[0]);
      const cap = resolveMaxResults(args.max_results, 200);
      const trunc = truncateItems(rows, cap);
      const prose = [
        `${album.name} (${album.release_date}) — ${album.total_tracks} tracks, runtime ${fmtDur(totalMs)}, longest "${longest?.name ?? '—'}" (${fmtDur(longest?.duration_ms ?? 0)}):`,
        '',
        ...trunc.items.map((r) =>
          `${String(r.track_number).padStart(2, ' ')}. ${r.name} (${r.duration})${r.also_on_other_albums ? ` · also on ${r.also_on_other_albums} other release(s)` : ''}`),
        trunc.footer ? `\n(${trunc.footer})` : '',
      ].join('\n');
      const payload = listStructuredContent(trunc.items, paginationInfo({
        total: trunc.total, returned: trunc.returned,
      }), {
        album: { id: album.id, name: album.name, release_date: album.release_date, label: album.label ?? null, total_tracks: album.total_tracks },
        runtime_ms: totalMs,
        longest_track: longest ? { name: longest.name, duration_ms: longest.duration_ms } : null,
      });
      return emit(rf, prose, payload);
    },
  );

  // ------------------------------------------------------------------ 12
  server.tool(
    'album_openers_report',
    'List track 1 (the side-A opener) of every studio album by an artist, chronologically — the "how each record begins" view. Quota: 🔴 paginated walk + batched /albums lookups.',
    {
      artist_id: spotifyId('artist').describe('Spotify artist ID, URI, or URL'),
      max_albums: z.number().int().positive().max(100).optional().describe('Albums to scan (album group only). Default: 30'),
      response_format: ResponseFormat,
    },
    async (args) => {
      const rf = args.response_format;
      const albums = await artistAlbums(client, args.artist_id, 'album', Math.min(100, args.max_albums ?? 30));
      const sorted = [...albums].sort((a, b) => (a.release_date ?? '').localeCompare(b.release_date ?? ''));
      const metas = await fetchAlbumBatches(client, sorted.map((a) => a.id));
      const rows = metas.map((m) => {
        const opener = m.tracks?.items?.find((t) => t.track_number === 1) ?? m.tracks?.items?.[0] ?? null;
        return {
          album_id: m.id, album: m.name, year: yearOf(m.release_date), release_date: m.release_date,
          total_tracks: m.total_tracks,
          opener: opener ? { name: opener.name, duration_ms: opener.duration_ms, duration: fmtDur(opener.duration_ms) } : null,
          track_list_truncated: (m.tracks?.items?.length ?? 0) < m.total_tracks,
        };
      });
      const cap = resolveMaxResults((args as { max_results?: number }).max_results, 100);
      const trunc = truncateItems(rows, cap);
      const prose = [
        `Album openers (${rows.length} albums):`,
        '',
        ...trunc.items.map((r) =>
          `${r.year ?? '????'} · ${r.album} — opens with "${r.opener?.name ?? '???'}" (${r.opener?.duration ?? '?:??'})${r.track_list_truncated ? ' · track list partial' : ''}`),
        trunc.footer ? `\n(${trunc.footer})` : '',
      ].join('\n');
      const payload = listStructuredContent(trunc.items, paginationInfo({
        total: trunc.total, returned: trunc.returned,
      }), { artist_id: args.artist_id });
      return emit(rf, prose, payload);
    },
  );

  // ------------------------------------------------------------------ 13
  server.tool(
    'deep_cuts_finder',
    'Surface deep cuts: album tracks past position 2 that are neither the title track nor released as singles — the forgotten album material, per album. Quota: 🔴 paginated walk + batched /albums lookups.',
    {
      artist_id: spotifyId('artist').describe('Spotify artist ID, URI, or URL'),
      max_albums: z.number().int().positive().max(100).optional().describe('Studio albums to scan. Default: 20'),
      cuts_per_album: z.number().int().min(1).max(10).optional().describe('Deep-cut picks per album. Default: 3'),
      response_format: ResponseFormat,
      max_results: z.number().int().positive().max(2000).optional(),
    },
    async (args) => {
      const rf = args.response_format;
      const albums = await artistAlbums(client, args.artist_id, 'album', Math.min(100, args.max_albums ?? 20));
      const singles = await artistAlbums(client, args.artist_id, 'single', 200);
      const singleMetas = await fetchAlbumBatches(client, singles.map((s) => s.id));
      const singleTrackNames = new Set<string>();
      for (const m of singleMetas) for (const t of m.tracks?.items ?? []) singleTrackNames.add(normalizeName(t.name));
      const metas = await fetchAlbumBatches(client, albums.map((a) => a.id));
      const perAlbum = Math.min(10, Math.max(1, args.cuts_per_album ?? 3));
      const rows: Array<{ album: string; year: number | null; track_number: number; name: string; duration_ms: number; duration: string; id: string }> = [];
      for (const m of metas) {
        const albumName = normalizeName(m.name);
        const candidates = (m.tracks?.items ?? [])
          .filter((t) => t.track_number > 2 && normalizeName(t.name) !== albumName && !singleTrackNames.has(normalizeName(t.name)));
        for (const t of candidates.slice(0, perAlbum)) {
          rows.push({ album: m.name, year: yearOf(m.release_date), track_number: t.track_number, name: t.name, duration_ms: t.duration_ms, duration: fmtDur(t.duration_ms), id: t.id });
        }
      }
      const cap = resolveMaxResults(args.max_results, 150);
      const trunc = truncateItems(rows, cap);
      const prose = [
        `Deep cuts (${rows.length} picks across ${metas.length} albums, singles excluded):`,
        '',
        ...trunc.items.map((r) => `${r.year ?? '????'} · ${r.album} — #${r.track_number} "${r.name}" (${r.duration})`),
        trunc.footer ? `\n(${trunc.footer})` : '',
      ].join('\n');
      const payload = listStructuredContent(trunc.items, paginationInfo({
        total: trunc.total, returned: trunc.returned,
      }), { artist_id: args.artist_id, albums_scanned: metas.length });
      return emit(rf, prose, payload);
    },
  );

  // ------------------------------------------------------------------ 14
  server.tool(
    'b_sides_detector',
    'Detect B-sides: tracks that appear on an artist\'s singles but never on any album — the non-LP catalogue. Also covers: b_sides_finder (same discography scan) — See also: b_sides_finder. Quota: 🔴 paginated walks + batched /albums lookups.',
    {
      artist_id: spotifyId('artist').describe('Spotify artist ID, URI, or URL'),
      max_singles: z.number().int().positive().max(200).optional().describe('Singles to scan. Default: 50'),
      response_format: ResponseFormat,
      max_results: z.number().int().positive().max(2000).optional(),
    },
    async (args) => {
      const rf = args.response_format;
      const singles = await artistAlbums(client, args.artist_id, 'single', Math.min(200, args.max_singles ?? 50));
      const albums = await artistAlbums(client, args.artist_id, 'album', 100);
      const [singleMetas, albumMetas] = await Promise.all([
        fetchAlbumBatches(client, singles.map((s) => s.id)),
        fetchAlbumBatches(client, albums.map((a) => a.id)),
      ]);
      const albumTrackNames = new Set<string>();
      for (const m of albumMetas) for (const t of m.tracks?.items ?? []) albumTrackNames.add(normalizeName(t.name));
      const seen = new Set<string>();
      const rows: Array<{ name: string; single: string; year: number | null; id: string }> = [];
      for (const m of singleMetas) {
        for (const t of m.tracks?.items ?? []) {
          const n = normalizeName(t.name);
          if (albumTrackNames.has(n) || seen.has(n)) continue;
          seen.add(n);
          rows.push({ name: t.name, single: m.name, year: yearOf(m.release_date), id: t.id });
        }
      }
      rows.sort((a, b) => (a.year ?? 9999) - (b.year ?? 9999) || a.name.localeCompare(b.name));
      const cap = resolveMaxResults(args.max_results, 150);
      const trunc = truncateItems(rows, cap);
      const prose = [
        `B-sides (${rows.length} non-album tracks across ${singles.length} singles):`,
        '',
        ...trunc.items.map((r) => `${r.year ?? '????'} · ${r.name} (from single "${r.single}")`),
        trunc.footer ? `\n(${trunc.footer})` : '',
      ].join('\n');
      const payload = listStructuredContent(trunc.items, paginationInfo({
        total: trunc.total, returned: trunc.returned,
      }), { artist_id: args.artist_id, singles_scanned: singles.length });
      return emit(rf, prose, payload);
    },
  );

  // ------------------------------------------------------------------ 15
  server.tool(
    'track_release_origin',
    'Find where a track first appeared: walks an artist\'s releases chronologically and reports the earliest album/single/compilation containing the track, plus later re-appearances. Quota: 🔴 paginated walk + batched /albums lookups.',
    {
      artist_id: spotifyId('artist').describe('Spotify artist ID, URI, or URL'),
      track_name: z.string().min(1).describe('Track title to locate (case-insensitive)'),
      max_releases: z.number().int().positive().max(200).optional().describe('Releases to scan. Default: 60'),
      response_format: ResponseFormat,
    },
    async (args) => {
      const rf = args.response_format;
      const albums = await artistAlbums(client, args.artist_id, 'album,single,compilation,appears_on', Math.min(200, args.max_releases ?? 60));
      const needle = normalizeName(args.track_name);
      const metas = await fetchAlbumBatches(client, albums.map((a) => a.id));
      const withTs = [...metas].sort((a, b) => (a.release_date ?? '').localeCompare(b.release_date ?? ''));
      const appearances: Array<{ release: string; release_date: string; album_type: string; position: number | null; id: string }> = [];
      for (const m of withTs) {
        const hit = (m.tracks?.items ?? []).find((t) => normalizeName(t.name) === needle);
        if (hit) appearances.push({ release: m.name, release_date: m.release_date, album_type: m.album_type, position: hit.track_number, id: m.id });
      }
      if (appearances.length === 0) {
        throw new Error(`"${args.track_name}" not found in the scanned releases (check spelling — scan covers ${withTs.length} releases).`);
      }
      const origin = appearances[0];
      const prose = [
        `First appearance of "${args.track_name}": ${origin.release} (${origin.release_date}, ${origin.album_type}), track #${origin.position ?? '?'}.`,
        appearances.length > 1 ? `Later appearances (${appearances.length - 1}):` : null,
        ...appearances.slice(1, 11).map((a) => `    ${a.release_date} · ${a.album_type} · ${a.release}`),
      ].filter((l): l is string => l !== null).join('\n');
      const payload = { artist_id: args.artist_id, track_name: args.track_name, origin, later_appearances: appearances.slice(1, 11), total_appearances: appearances.length };
      return emit(rf, prose, payload);
    },
  );

  // ------------------------------------------------------------------ 16
  server.tool(
    'album_anniversary_check',
    'Upcoming album anniversaries for an artist within the next `window_days`, with milestone years (5/10/15/…) flagged — plan re-listens or anniversary posts. Quota: 🟡 one paginated /artists/{id}/albums walk.',
    {
      artist_id: spotifyId('artist').describe('Spotify artist ID, URI, or URL'),
      window_days: z.number().int().min(1).max(365).optional().describe('Look-ahead window in days. Default: 30'),
      milestone_step: z.number().int().min(1).max(50).optional().describe('Flag anniversaries divisible by this step. Default: 5'),
      response_format: ResponseFormat,
    },
    async (args) => {
      const rf = args.response_format;
      const albums = await artistAlbums(client, args.artist_id, 'album', fetchAllCap());
      const now = new Date();
      const window = Math.min(365, Math.max(1, args.window_days ?? 30));
      const step = Math.max(1, args.milestone_step ?? 5);
      const rows = albums
        .map((a) => {
          const d = a.release_date ?? '';
          if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) return null;
          const [, mm, dd] = d.split('-');
          let annivYear = now.getUTCFullYear();
          let anniv = Date.parse(`${annivYear}-${mm}-${dd}`);
          if (!Number.isFinite(anniv)) return null;
          if (anniv < now.getTime()) {
            annivYear += 1;
            anniv = Date.parse(`${annivYear}-${mm}-${dd}`);
          }
          const daysUntil = Math.round((anniv - now.getTime()) / 86_400_000);
          if (daysUntil > window) return null;
          const turning = annivYear - Number(d.slice(0, 4));
          return {
            album: a.name, album_id: a.id, original_release_date: d,
            anniversary_date: `${annivYear}-${mm}-${dd}`, turning, days_until: daysUntil,
            milestone: turning % step === 0 && turning > 0,
          };
        })
        .filter((r): r is NonNullable<typeof r> => r !== null)
        .sort((a, b) => a.days_until - b.days_until);
      const prose = [
        `Album anniversaries in the next ${window} day(s):`,
        '',
        ...(rows.length
          ? rows.map((r) => `${r.anniversary_date} · ${r.album} turns ${r.turning}${r.milestone ? ' · MILESTONE' : ''}`)
          : ['No anniversaries in the window.']),
      ].join('\n');
      const payload = listStructuredContent(rows, paginationInfo({
        total: rows.length, returned: rows.length,
      }), { artist_id: args.artist_id, window_days: window, milestone_step: step });
      return emit(rf, prose, payload);
    },
  );

  // ------------------------------------------------------------------ 17
  server.tool(
    'album_duration_report',
    'Runtime profile for an artist\'s studio albums: total length, track count and longest track per album, ranked by runtime — find the epics and the EPs. Quota: 🔴 paginated walk + batched /albums lookups.',
    {
      artist_id: spotifyId('artist').describe('Spotify artist ID, URI, or URL'),
      max_albums: z.number().int().positive().max(100).optional().describe('Albums to scan. Default: 30'),
      response_format: ResponseFormat,
      max_results: z.number().int().positive().max(2000).optional(),
    },
    async (args) => {
      const rf = args.response_format;
      const albums = await artistAlbums(client, args.artist_id, 'album', Math.min(100, args.max_albums ?? 30));
      const metas = await fetchAlbumBatches(client, albums.map((a) => a.id));
      const rows = metas.map((m) => {
        const items = m.tracks?.items ?? [];
        const totalMs = items.reduce((s, t) => s + t.duration_ms, 0);
        const longest = items.reduce((best, t) => (t.duration_ms > (best?.duration_ms ?? -1) ? t : best), items[0]);
        return {
          album: m.name, album_id: m.id, year: yearOf(m.release_date), release_date: m.release_date,
          total_tracks: m.total_tracks, counted_tracks: items.length,
          track_list_partial: items.length < m.total_tracks,
          runtime_ms: totalMs, runtime: fmtDur(totalMs),
          longest_track: longest ? { name: longest.name, duration_ms: longest.duration_ms, duration: fmtDur(longest.duration_ms) } : null,
        };
      }).sort((a, b) => b.runtime_ms - a.runtime_ms);
      const cap = resolveMaxResults((args as { max_results?: number }).max_results, 100);
      const trunc = truncateItems(rows, cap);
      const prose = [
        `Album runtimes (${rows.length} albums, longest first):`,
        '',
        ...trunc.items.map((r) =>
          `${r.runtime} · ${r.album} (${r.year ?? '????'}, ${r.counted_tracks}/${r.total_tracks} tracks counted${r.track_list_partial ? ', PARTIAL' : ''})`),
        trunc.footer ? `\n(${trunc.footer})` : '',
      ].join('\n');
      const payload = listStructuredContent(trunc.items, paginationInfo({
        total: trunc.total, returned: trunc.returned,
      }), { artist_id: args.artist_id });
      return emit(rf, prose, payload);
    },
  );

  // ---------------------------------------------------------------------------
  // 18–24: library-driven discovery
  // ---------------------------------------------------------------------------

  // ------------------------------------------------------------------ 18
  server.tool(
    'new_music_from_saved_artists',
    'Newest releases across the artists you follow (and optionally those in your saved albums), sorted by release date — your personal new-release feed. Quota: 🔴 followed-artist walk + per-artist album peeks.',
    {
      artist_limit: z.number().int().positive().max(50).optional().describe('Max artists to check. Default: 20'),
      include_saved_album_artists: z.boolean().optional().describe('Also include artists from your saved albums. Default: true'),
      response_format: ResponseFormat,
      max_results: z.number().int().positive().max(2000).optional(),
    },
    async (args) => {
      const rf = args.response_format;
      const cap = Math.min(50, Math.max(1, args.artist_limit ?? 20));
      const artistMap = new Map<string, string>();

      // Followed artists (cursor pagination — manual walk).
      let after: string | null = null;
      for (let i = 0; i < 10 && artistMap.size < cap; i += 1) {
        const params: Record<string, string> = { type: 'artist', limit: '50' };
        if (after) params.after = after;
        const page = await client.get<FollowedArtistsResponse>('/me/following', params);
        const items = page?.artists?.items ?? [];
        if (items.length === 0) break;
        for (const a of items) if (artistMap.size < cap) artistMap.set(a.id, a.name);
        after = page?.artists?.cursors?.after ?? null;
        if (!after) break;
      }

      if (args.include_saved_album_artists !== false && artistMap.size < cap) {
        const saved = await client.getAllPages<SavedAlbumItem>('/me/albums', { limit: '50' }, { maxItems: 200 });
        for (const row of saved) {
          if (artistMap.size >= cap) break;
          for (const a of row.album?.artists ?? []) if (!artistMap.has(a.id)) artistMap.set(a.id, a.name);
        }
      }

      const rows: Array<{ artist: string; artist_id: string; release: string; release_date: string; album_type: string; age_days: number | null }> = [];
      for (const [id, name] of artistMap) {
        const peek = await client.get<{ items?: SpotifyAlbumItem[] }>(`/artists/${encodeURIComponent(id)}/albums`, {
          include_groups: 'album,single', limit: '3',
        });
        const newest = (peek?.items ?? [])
          .filter((r) => tsOf(r.release_date) !== null)
          .sort((a, b) => (b.release_date ?? '').localeCompare(a.release_date ?? ''))[0];
        if (!newest) continue;
        const ts = tsOf(newest.release_date)!;
        rows.push({
          artist: name, artist_id: id, release: newest.name, release_date: newest.release_date,
          album_type: newest.album_type, age_days: daysBetween(ts, Date.now()),
        });
      }
      rows.sort((a, b) => (b.release_date ?? '').localeCompare(a.release_date ?? ''));
      const capOut = resolveMaxResults(args.max_results, 100);
      const trunc = truncateItems(rows, capOut);
      const prose = [
        `Newest releases across ${artistMap.size} artist(s):`,
        '',
        ...trunc.items.map((r) => `${r.release_date} · ${r.album_type} · ${r.release} — ${r.artist} (${r.age_days ?? '?'}d old)`),
        trunc.footer ? `\n(${trunc.footer})` : '',
      ].join('\n');
      const payload = listStructuredContent(trunc.items, paginationInfo({
        total: trunc.total, returned: trunc.returned,
      }), { artists_checked: artistMap.size });
      return emit(rf, prose, payload);
    },
  );

  // ------------------------------------------------------------------ 19
  server.tool(
    'artist_scout_from_playlists',
    'Find new-to-you artists: pull the artist roster from one of your playlists and rank the ones you have NOT saved any tracks of — discovery from your own rotation. Quota: 🔴 playlist walk + saved-tracks membership check.',
    {
      playlist_id: spotifyId('playlist').describe('Spotify playlist ID, URI, or URL'),
      max_items: z.number().int().positive().max(1000).optional().describe('Playlist items to scan. Default: 200'),
      max_artists: z.number().int().positive().max(50).optional().describe('Max newcomer rows. Default: 15'),
      response_format: ResponseFormat,
    },
    async (args) => {
      const rf = args.response_format;
      const items = await client.getAllPages<{ item?: unknown }>(
        `/playlists/${encodeURIComponent(args.playlist_id)}/items`,
        { limit: '100' },
        { maxItems: Math.min(1000, args.max_items ?? 200) },
      );
      const counts = new Map<string, { name: string; n: number; sample: string | null }>();
      for (const row of items) {
        const item = row.item as { artists?: Array<{ id: string; name: string }>; name?: string } | null | undefined;
        for (const a of item?.artists ?? []) {
          const cur = counts.get(a.id) ?? { name: a.name, n: 0, sample: null };
          cur.n += 1;
          if (!cur.sample && item?.name) cur.sample = item.name;
          counts.set(a.id, cur);
        }
      }
      const saved = await client.getAllPages<SavedTrackItem>('/me/tracks', { limit: '50' }, { maxItems: 500 });
      const savedArtistIds = new Set(saved.flatMap((row) => (row.track?.artists ?? []).map((a) => a.id)));
      const newcomers = [...counts.entries()]
        .filter(([id]) => !savedArtistIds.has(id))
        .map(([id, v]) => ({ artist_id: id, artist: v.name, playlist_appearances: v.n, sample_track: v.sample }))
        .sort((a, b) => b.playlist_appearances - a.playlist_appearances)
        .slice(0, Math.min(50, Math.max(1, args.max_artists ?? 15)));
      const prose = [
        `New-to-you artists from playlist ${args.playlist_id} (${newcomers.length} of ${counts.size} playlist artists not in your saved tracks):`,
        '',
        ...(newcomers.length
          ? newcomers.map((r) => `${r.playlist_appearances}× ${r.artist}${r.sample_track ? ` — e.g. "${r.sample_track}"` : ''}`)
          : ['Every artist here is already in your saved tracks — no newcomers this time.']),
      ].join('\n');
      const payload = {
        playlist_id: args.playlist_id,
        playlist_artists_seen: counts.size,
        saved_tracks_scanned: saved.length,
        items: newcomers,
      };
      return emit(rf, prose, payload);
    },
  );

  // ------------------------------------------------------------------ 20
  server.tool(
    'artist_live_albums_finder',
    'List an artist\'s live releases (titles matching live/unplugged/live-at patterns) chronologically — the concert-record shelf. Quota: 🟡 one paginated /artists/{id}/albums walk.',
    {
      artist_id: spotifyId('artist').describe('Spotify artist ID, URI, or URL'),
      response_format: ResponseFormat,
      max_results: z.number().int().positive().max(2000).optional(),
    },
    async (args) => {
      const rf = args.response_format;
      const albums = await artistAlbums(client, args.artist_id, 'album,single', fetchAllCap());
      const liveRe = /\b(live|unplugged)\b|\blive at\b/i;
      const rows = albums
        .filter((a) => liveRe.test(a.name))
        .sort((a, b) => (a.release_date ?? '').localeCompare(b.release_date ?? ''))
        .map((a) => ({ id: a.id, name: a.name, release_date: a.release_date, year: yearOf(a.release_date), album_type: a.album_type, total_tracks: a.total_tracks }));
      const cap = resolveMaxResults((args as { max_results?: number }).max_results, 100);
      const trunc = truncateItems(rows, cap);
      const prose = [
        `Live releases (${rows.length} of ${albums.length} scanned):`,
        '',
        ...trunc.items.map((r) => `${r.year ?? '????'} · ${r.album_type} · ${r.name} (${r.total_tracks} tracks)`),
        trunc.footer ? `\n(${trunc.footer})` : '',
      ].join('\n');
      const payload = listStructuredContent(trunc.items, paginationInfo({
        total: trunc.total, returned: trunc.returned,
      }), { artist_id: args.artist_id, scanned: albums.length });
      return emit(rf, prose, payload);
    },
  );

  // ------------------------------------------------------------------ 21
  server.tool(
    'artist_collection_gaps',
    'List an artist\'s studio albums missing from your saved collection — the exact records to add next. Quota: 🔴 paginated walk + saved-albums membership check.',
    {
      artist_id: spotifyId('artist').describe('Spotify artist ID, URI, or URL'),
      response_format: ResponseFormat,
      max_results: z.number().int().positive().max(2000).optional(),
    },
    async (args) => {
      const rf = args.response_format;
      const albums = await artistAlbums(client, args.artist_id, 'album', 100);
      const saved = await client.getAllPages<SavedAlbumItem>('/me/albums', { limit: '50' }, { maxItems: 1000 });
      const savedIds = new Set(saved.map((row) => row.album?.id).filter((id): id is string => typeof id === 'string'));
      const rows = albums
        .filter((a) => !savedIds.has(a.id))
        .sort((a, b) => (a.release_date ?? '').localeCompare(b.release_date ?? ''))
        .map((a) => ({ id: a.id, name: a.name, release_date: a.release_date, year: yearOf(a.release_date), total_tracks: a.total_tracks }));
      const cap = resolveMaxResults((args as { max_results?: number }).max_results, 100);
      const trunc = truncateItems(rows, cap);
      const prose = [
        `Collection gaps (${rows.length} of ${albums.length} studio albums not saved):`,
        '',
        ...trunc.items.map((r) => `${r.year ?? '????'} · ${r.name} (${r.total_tracks} tracks)`),
        trunc.footer ? `\n(${trunc.footer})` : '',
      ].join('\n');
      const payload = listStructuredContent(trunc.items, paginationInfo({
        total: trunc.total, returned: trunc.returned,
      }), { artist_id: args.artist_id, saved_albums_scanned: saved.length });
      return emit(rf, prose, payload);
    },
  );

  // ------------------------------------------------------------------ 22
  server.tool(
    'artist_singles_timeline',
    'Chronological singles timeline for an artist (date · title · track count) — the 45-rpm history in one table. Quota: 🟡 one paginated /artists/{id}/albums walk (singles group).',
    {
      artist_id: spotifyId('artist').describe('Spotify artist ID, URI, or URL'),
      response_format: ResponseFormat,
      max_results: z.number().int().positive().max(2000).optional(),
    },
    async (args) => {
      const rf = args.response_format;
      const singles = await artistAlbums(client, args.artist_id, 'single', fetchAllCap());
      const rows = singles
        .sort((a, b) => (a.release_date ?? '').localeCompare(b.release_date ?? ''))
        .map((s) => ({ id: s.id, name: s.name, release_date: s.release_date, year: yearOf(s.release_date), total_tracks: s.total_tracks }));
      const cap = resolveMaxResults(args.max_results, 300);
      const trunc = truncateItems(rows, cap);
      let prev = '';
      const withGaps = trunc.items.map((r) => {
        const gap = prev && r.release_date ? `${daysBetween(tsOf(prev) ?? 0, tsOf(r.release_date) ?? 0)}d` : '—';
        prev = r.release_date ?? prev;
        return { ...r, gap_days_since_previous: prev && r.release_date ? daysBetween(tsOf(rows.find((x) => x.release_date === prev && false)?.release_date ?? '') ?? 0, 0) || undefined : undefined, gap_display: gap };
      });
      const prose = [
        `Singles timeline (${singles.length}):`,
        '',
        ...trunc.items.map((r) => `${r.release_date} · ${r.name} (${r.total_tracks} track${r.total_tracks === 1 ? '' : 's'})`),
        trunc.footer ? `\n(${trunc.footer})` : '',
      ].join('\n');
      const payload = listStructuredContent(trunc.items, paginationInfo({
        total: trunc.total, returned: trunc.returned,
      }), { artist_id: args.artist_id });
      return emit(rf, prose, payload);
    },
  );

  // ------------------------------------------------------------------ 23
  server.tool(
    'genre_dive_search',
    'Search artists by genre keyword (e.g. "britpop", "afrobeat") and list the matching profiles with their genre tags — the entry point for a genre dive. Quota: 🟢 one GET /search call.',
    {
      genre: z.string().min(1).describe('Genre keyword to search for'),
      market: Market,
      limit: SearchLimit,
      response_format: ResponseFormat,
    },
    async (args) => {
      const rf = args.response_format;
      const data = await client.get<SearchResponse>('/search', searchParams(`genre:"${args.genre.replace(/"/g, '')}"`, 'artist', args.limit ?? 10, args.market));
      const rows = (data?.artists?.items ?? []).map((a) => ({
        id: a.id, name: a.name, genres: a.genres ?? [],
      }));
      const cap = resolveMaxResults(args.limit, 10);
      const trunc = truncateItems(rows, cap);
      const prose = [
        `Artists matching genre "${args.genre}": ${rows.length}`,
        '',
        ...trunc.items.map((r) => `${r.name} — ${r.genres.slice(0, 4).join(', ') || '(no genre tags)'} · ${r.id}`),
      ].join('\n');
      const payload = listStructuredContent(trunc.items, paginationInfo({
        total: data?.artists?.total ?? null, returned: trunc.returned,
      }), { genre: args.genre });
      return emit(rf, prose, payload);
    },
  );

  // ------------------------------------------------------------------ 24
  server.tool(
    'scene_sampler_search',
    'Build a scene sampler: search artists by a scene/genre keyword, then fetch each act\'s newest release as a one-track-per-artist listening plan. Quota: 🟡 one /search call + one album peek per artist.',
    {
      scene: z.string().min(1).describe('Scene/genre keyword (e.g. "shoegaze")'),
      max_artists: z.number().int().min(1).max(10).optional().describe('Artists to sample (search cap 10). Default: 8'),
      market: Market,
      response_format: ResponseFormat,
    },
    async (args) => {
      const rf = args.response_format;
      const data = await client.get<SearchResponse>('/search', searchParams(`genre:"${args.scene.replace(/"/g, '')}"`, 'artist', 10, args.market));
      const artists = (data?.artists?.items ?? []).slice(0, Math.min(10, Math.max(1, args.max_artists ?? 8)));
      const rows: Array<{ artist: string; artist_id: string; release: string; release_id: string; release_date: string; year: number | null; album_type: string }> = [];
      for (const a of artists) {
        const peek = await client.get<{ items?: SpotifyAlbumItem[] }>(`/artists/${encodeURIComponent(a.id)}/albums`, {
          include_groups: 'album,single', limit: '1',
        });
        const newest = (peek?.items ?? [])[0];
        if (newest) rows.push({ artist: a.name, artist_id: a.id, release: newest.name, release_id: newest.id, release_date: newest.release_date, year: yearOf(newest.release_date), album_type: newest.album_type });
      }
      const prose = [
        `Scene sampler for "${args.scene}" (${rows.length} act(s)):`,
        '',
        ...rows.map((r) => `${r.artist} → ${r.release} (${r.year ?? '????'}, ${r.album_type})`),
      ].join('\n');
      const payload = { scene: args.scene, items: rows };
      return emit(rf, prose, payload);
    },
  );
}
