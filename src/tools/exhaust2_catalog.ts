/**
 * exhaust2 catalog slice — feature swarm v1.24.0 (issues #332–#357).
 *
 * 19 tools are registered here and nowhere else: bundle/context cards and
 * local-compute statistics over real API payloads. The slice's typed-search
 * candidates (#332–#334 + #338–#341: search_tracks/artists/albums/playlists/
 * shows/episodes/audiobooks) shipped first via the #322 typed-search factory in
 * catalog.ts, so this slice deliberately does NOT re-register them —
 * duplicate tool names crash the MCP server. No deprecated endpoints
 * (SPEC §9); the two tools that walk the #329 registration-gated surface
 * (`category_resolver`, `artist_collab_network`) short-circuit Spotify 403s
 * into a clear "app-registration gated" disclosure instead of surfacing raw
 * Forbidden errors.
 */
import { z } from 'zod';
import { MARKET_CODE } from './catalog.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { SpotifyClient } from '../client.js';
import { SpotifyApiError } from '../client.js';
import type {
  SearchResponse,
  SpotifyAlbumItem,
  SpotifyAlbumSimple,
  SpotifyAudiobookSimple,
  SpotifyArtistFull,
  SpotifyArtistSimple,
  SpotifyChapterSimple,
  SpotifyEpisodeSimple,
  SpotifyPlaylistSimple,
  SpotifyShowSimple,
  SpotifyTrack,
  SpotifyTrackSimple,
} from '../types/spotify.js';
import {
  ResponseFormat,
  resolveMaxResults,
  truncateItems,
  paginationInfo,
  listStructuredContent,
} from '../shaping.js';
import type { ResponseFormatValue, PaginationInfo } from '../shaping.js';
import { getConfig } from '../config.js';

// ---------------------------------------------------------------------------
// Shared shapes + plumbing
// ---------------------------------------------------------------------------

/** Search limit is capped at 10 by the Feb-2026 /search page cap. */
const SearchLimit = z
  .number()
  .int()
  .min(1)
  .max(10)
  .optional()
  .describe('Results per page, 1–10 (Feb-2026 /search cap). Default: 5');

const Offset = z.number().int().min(0).optional().describe('Pagination offset. Default: 0');

const Market = z
  .string()
  .optional()
  .describe("ISO 3166-1 alpha-2 market code (e.g. 'US'); omit for 'from_token' behaviour");

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
export function fmtDur(ms: number): string {
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
export function yearOf(date: string | null | undefined): number | null {
  if (!date) return null;
  const y = Number(date.slice(0, 4));
  return Number.isInteger(y) && y > 0 ? y : null;
}

/** Parse a Spotify release date as a UTC timestamp, or null. */
function tsOf(date: string | null | undefined): number | null {
  if (!date) return null;
  const t = Date.parse(date.length === 4 ? `${date}-01-01` : date);
  return Number.isFinite(t) ? t : null;
}

/** Days between two timestamps (fractional, rounded to 1 decimal for gaps). */
function daysBetween(a: number, b: number): number {
  return Math.round(Math.abs(b - a) / 86_400_000 * 10) / 10;
}

/** Lowercase, strip punctuation/symbols, collapse whitespace. */
export function normalizeName(name: string): string {
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

/** Full album payload widens the simplified type with label/copyright fields. */
interface AlbumPayload extends SpotifyAlbumItem {
  label?: string;
  copyrights?: Array<{ text: string; type: string }>;
  tracks?: { items: SpotifyTrackSimple[]; total: number };
}

/** Track payloads as returned by /search and /tracks — album carries dates. */
interface TrackPayload extends Omit<SpotifyTrack, 'album'> {
  album: SpotifyAlbumSimple & {
    release_date?: string;
    release_date_precision?: string;
    album_type?: string;
    total_tracks?: number;
  };
  external_ids?: { isrc?: string; upc?: string };
  is_playable?: boolean;
  album_type?: string;
}

/** /search widened with the audiobook section (missing from SearchResponse). */
interface CatalogSearchResponse extends SearchResponse {
  audiobooks?: { items: SpotifyAudiobookSimple[]; total: number };
}

type SearchArgs = { query: string; limit?: number; offset?: number; market?: string };

function searchRequestParams(
  q: string,
  type: string,
  args: SearchArgs,
): Record<string, string> {
  const params: Record<string, string> = {
    q,
    type,
    limit: String(Math.min(10, Math.max(1, args.limit ?? 5))),
  };
  if (args.offset !== undefined) params.offset = String(args.offset);
  if (args.market) params.market = args.market;
  return params;
}

/**
 * Run a typed /search and return the section's non-null rows. Feb-2026
 * search responses can carry null rows per-slot (curated playlists), which
 * are filtered here.
 */
async function runTypedSearch<T>(
  client: SpotifyClient,
  sectionKey: string,
  type: string,
  args: SearchArgs,
  q?: string,
): Promise<{ items: T[]; total: number | null }> {
  const data = await client.get<CatalogSearchResponse>(
    '/search',
    searchRequestParams(q ?? args.query, type, args),
  );
  const section = (
    data as unknown as Record<string, { items?: unknown[]; total?: number } | undefined> | null
  )?.[sectionKey];
  const items = (section?.items ?? []).filter((x) => x != null);
  return { items: items as T[], total: typeof section?.total === 'number' ? section.total : null };
}

/** Shared prose/structured emission for the simple typed-search tools. */
function emitSearchResult(
  rf: ResponseFormatValue,
  header: string,
  lines: string[],
  rows: unknown[],
  total: number | null,
  extra: Record<string, unknown> = {},
  maxResults?: number,
): ToolOut {
  const cap = resolveMaxResults(maxResults, getConfig().maxItems);
  const trunc = truncateItems(lines, cap);
  const shown = trunc.items.length;
  const out: string[] = [header, ''];
  out.push(...trunc.items);
  if (trunc.footer) out.push('', `(${trunc.footer})`);
  const pagination: PaginationInfo = paginationInfo({
    total,
    offset: 0,
    limit: null,
    returned: shown,
  });
  return emit(rf, out.join('\n'), {
    items: rows.slice(0, Math.max(cap, 0) === 0 ? rows.length : cap),
    total,
    pagination,
    ...extra,
  });
}

/**
 * Graceful-403 contract for the #329 registration-gated surface: Spotify 403
 * on /browse/categories or /artists/{id}/top-tracks becomes a short-circuit
 * disclosure naming the gate, never a raw Forbidden error.
 */
export function gatedEndpointMessage(endpoint: string): string {
  return (
    `Spotify returned 403 for ${endpoint} — this endpoint is app-registration gated ` +
    '(the #329 gated surface: browse categories and artist top-tracks are not enabled ' +
    'on fresh app registrations). Enable it in the Spotify developer dashboard for this app, ' +
    'or use a registration where it is already enabled. Nothing was retrieved.'
  );
}

function isGatedError(err: unknown): err is SpotifyApiError {
  return err instanceof SpotifyApiError && err.status === 403;
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

export function registerExhaust2CatalogTools(server: McpServer, client: SpotifyClient): void {
  // ------------------------------------------------------------------ #335
  server.tool(
    'search_advanced',
    'Structured advanced-search composer: builds a valid Spotify filter query from typed fields and runs it. '
      + 'Supported filter syntax: track:"name" artist:"name" album:"name" year:1984 year:1980-1989 genre:"pop" '
      + 'tag:new (last ~2 weeks) tag:hipster (lowest-popularity) isrc:CCXXXNNNNNNN upc:NNNNNNNNNNNNN. '
      + 'Pass whichever fields you have; they are quoted and composed for you. Quota: 🟢 one GET /search call.',
    {
      fields: z
        .object({
          artist: z.string().optional().describe('artist:"..." filter'),
          track: z.string().optional().describe('track:"..." filter'),
          album: z.string().optional().describe('album:"..." filter'),
          year: z.number().int().min(1900).max(2100).optional().describe('year:YYYY filter'),
          year_range: z
            .object({ from: z.number().int().min(1900).max(2100), to: z.number().int().min(1900).max(2100) })
            .optional()
            .describe('year:FROM-TO range filter'),
          genre: z.string().optional().describe('genre:"..." filter'),
          tag: z.enum(['new', 'hipster']).optional().describe('tag:new or tag:hipster'),
          isrc: z.string().optional().describe('isrc:... exact recording code'),
          upc: z.string().optional().describe('upc:... exact product code'),
        })
        .describe('At least one field is required'),
      types: z
        .array(z.enum(['track', 'artist', 'album', 'playlist', 'show', 'episode', 'audiobook']))
        .min(1)
        .max(3)
        .optional()
        .describe("Content types to search (up to 3). Default: ['track']"),
      limit: SearchLimit,
      market: Market,
      response_format: ResponseFormat,
      max_results: z.number().int().positive().max(2000).optional(),
    },
    async (args) => {
      const rf = args.response_format;
      const f = args.fields;
      if (!f || Object.values(f).every((v) => v === undefined || v === null)) {
        throw new Error('Provide at least one search field (artist, track, album, year, genre, tag, isrc, upc)');
      }
      const parts: string[] = [];
      if (f.track) parts.push(`track:"${f.track.replace(/"/g, '')}"`);
      if (f.artist) parts.push(`artist:"${f.artist.replace(/"/g, '')}"`);
      if (f.album) parts.push(`album:"${f.album.replace(/"/g, '')}"`);
      if (f.year !== undefined) parts.push(`year:${f.year}`);
      if (f.year_range) parts.push(`year:${f.year_range.from}-${f.year_range.to}`);
      if (f.genre) parts.push(`genre:"${f.genre.replace(/"/g, '')}"`);
      if (f.tag) parts.push(`tag:${f.tag}`);
      if (f.isrc) parts.push(`isrc:${f.isrc.replace(/[^A-Za-z0-9]/g, '').toUpperCase()}`);
      if (f.upc) parts.push(`upc:${f.upc.replace(/[^0-9]/g, '')}`);
      const q = parts.join(' ');
      const types = (args.types ?? ['track']).join(',');
      const data = await client.get<CatalogSearchResponse>(
        '/search',
        searchRequestParams(q, types, { query: q, limit: args.limit, market: args.market }),
      );
      const sections: string[] = [`Advanced search — query: ${q}`, ''];
      const payload: Record<string, unknown> = { query: q, types: args.types ?? ['track'] };
      const typeKeys = args.types ?? ['track'];
      const renderers: Record<string, (items: unknown[]) => string[]> = {
        track: (items) =>
          (items as TrackPayload[]).map(
            (t) => `• "${t.name}" — ${(t.artists ?? []).map((a) => a.name).join(', ')} | ${t.album?.name ?? '?'} (${yearOf(t.album?.release_date) ?? '?'}) | ${fmtDur(t.duration_ms)}`,
          ),
        artist: (items) =>
          (items as SpotifyArtistFull[]).map(
            (a) => `• ${a.name}${a.genres?.length ? ` — ${a.genres.slice(0, 3).join(', ')}` : ''}`,
          ),
        album: (items) =>
          (items as SpotifyAlbumItem[]).map(
            (al) => `• "${al.name}" — ${(al.artists ?? []).map((a) => a.name).join(', ')} | ${al.release_date ?? '?'} · ${al.album_type ?? 'album'}`,
          ),
        playlist: (items) =>
          (items as SpotifyPlaylistSimple[]).map((p) => `• "${p.name}" — ${p.owner?.display_name ?? 'unknown'}`),
        show: (items) => (items as SpotifyShowSimple[]).map((s) => `• "${s.name}"`),
        episode: (items) => (items as SpotifyEpisodeSimple[]).map((e) => `• "${e.name}" — ${e.show?.name ?? '?'}`),
        audiobook: (items) => (items as SpotifyAudiobookSimple[]).map((ab) => `• "${ab.name}" — ${(ab.authors ?? []).map((a) => a.name).join(', ')}`),
      };
      let grandTotal = 0;
      for (const t of typeKeys) {
        const sec = data?.[t as keyof CatalogSearchResponse] as { items?: unknown[]; total?: number } | undefined;
        const items = (sec?.items ?? []).filter((x) => x != null);
        grandTotal += items.length;
        sections.push(`${t.toUpperCase()} (${sec?.total ?? items.length}):`);
        const mk = renderers[t];
        const lines = mk ? mk(items) : items.map(() => '• (unknown type)');
        sections.push(...(lines.length > 0 ? lines : ['  (no results)']));
        sections.push('');
        payload[t] = items;
      }
      if (grandTotal === 0) sections.push('No results for the composed filter — try broadening year_range or dropping quoted phrases.');
      return emit(rf, sections.join('\n').trimEnd(), payload);
    },
  );

  // ------------------------------------------------------------------ #336
  server.tool(
    'track_album_bundle',
    'Context card for one track: the track plus its full album metadata and the album\'s remaining track listing '
      + '(the "what am I listening to" card). Quota: 🟡 2 API calls (GET /tracks/{id} + GET /albums/{id}/tracks).',
    {
      track_id: z.string().min(1).describe('Spotify track ID'),
      market: Market,
      response_format: ResponseFormat,
    },
    async (args) => {
      const rf = args.response_format;
      const track = await client.get<TrackPayload>(`/tracks/${encodeURIComponent(args.track_id)}`);
      if (!track) throw new Error(`Track "${args.track_id}" not found`);
      const albumId = track.album?.id;
      const albumTracks = albumId
        ? await client.get<{ items: SpotifyTrackSimple[]; total: number }>(
            `/albums/${encodeURIComponent(albumId)}/tracks`,
            { limit: '50', ...(args.market ? { market: args.market } : {}) },
          )
        : null;
      const artists = (track.artists ?? []).map((a) => a.name).join(', ') || 'unknown artist';
      const yr = yearOf(track.album?.release_date);
      const lines: string[] = [
        `Now playing: "${track.name}" — ${artists}`,
        `Album: ${track.album?.name ?? 'unknown'}${yr ? ` (${yr})` : ''} · ${track.album?.album_type ?? 'album'} · ${track.album?.total_tracks ?? albumTracks?.total ?? '?'} tracks`,
        `Duration: ${fmtDur(track.duration_ms)} | ${track.uri}`,
        '',
      ];
      const listing: Record<string, unknown>[] = [];
      if (albumTracks && Array.isArray(albumTracks.items)) {
        lines.push(`Album tracks (${albumTracks.total ?? albumTracks.items.length}):`);
        albumTracks.items.forEach((s) => {
          const marker = s.id === track.id ? ' ← this track' : '';
          lines.push(`  ${s.track_number ?? '-'}. "${s.name}" — ${fmtDur(s.duration_ms)}${marker}`);
          listing.push({ id: s.id, uri: s.uri, name: s.name, track_number: s.track_number ?? null, duration_ms: s.duration_ms, is_this_track: s.id === track.id });
        });
      }
      const payload: Record<string, unknown> = {
        track: { id: track.id, uri: track.uri, name: track.name, artists: (track.artists ?? []).map((a) => a.name), duration_ms: track.duration_ms, isrc: track.external_ids?.isrc ?? null },
        album: albumId
          ? { id: albumId, name: track.album?.name ?? null, release_date: track.album?.release_date ?? null, album_type: track.album?.album_type ?? null, total_tracks: albumTracks?.total ?? null }
          : null,
        album_tracks: listing,
      };
      return emit(rf, lines.join('\n'), payload);
    },
  );

  // ------------------------------------------------------------------ #337
  server.tool(
    'artist_discography_timeline',
    '[local-compute] Chronological release table (year · type · name · tracks) built from a paginated '
      + '/artists/{id}/albums walk. Sorted newest first; `since_year` trims older rows client-side. '
      + 'Quota: 🟡 one paginated walk (typically several API calls on the rate-limited queue).',
    {
      artist_id: z.string().min(1).describe('Spotify artist ID'),
      include_groups: z
        .string()
        .optional()
        .describe('Comma-separated album groups: album,single,appears_on,compilation. Default: album,single'),
      since_year: z.number().int().min(1900).max(2100).optional().describe('Only releases from this year onward'),
      response_format: ResponseFormat,
      max_results: z.number().int().positive().max(2000).optional(),
    },
    async (args) => {
      const rf = args.response_format;
      const fetchAllCap = getConfig().fetchAllCap;
      const params: Record<string, string> = {
        include_groups: args.include_groups ?? 'album,single',
        limit: '50',
      };
      const albums = await client.getAllPages<SpotifyAlbumItem>(
        `/artists/${encodeURIComponent(args.artist_id)}/albums`,
        params,
        { maxItems: fetchAllCap },
      );
      const trimmed = args.since_year !== undefined
        ? albums.filter((a) => (yearOf(a.release_date) ?? 0) >= (args.since_year as number))
        : albums;
      const sorted = [...trimmed].sort((a, b) => (b.release_date ?? '').localeCompare(a.release_date ?? ''));
      const cap = resolveMaxResults(args.max_results, fetchAllCap);
      const trunc = truncateItems(sorted, cap);
      const header = `Discography timeline (${sorted.length} release${sorted.length === 1 ? '' : 's'}${args.since_year ? ` since ${args.since_year}` : ''}):`;
      const lines = trunc.items.map(
        (a) => `• ${a.release_date ?? '?'} · ${a.album_type ?? 'album'} · "${a.name}" · ${a.total_tracks ?? '?'} tracks`,
      );
      if (trunc.footer) lines.push('', `(${trunc.footer})`);
      return emit(rf, [header, '', ...lines].join('\n'), {
        artist_id: args.artist_id,
        releases: trunc.items.map((a) => ({
          id: a.id, uri: a.uri, name: a.name, release_date: a.release_date ?? null,
          album_type: a.album_type ?? null, total_tracks: a.total_tracks ?? null,
        })),
        total: sorted.length,
        fetch_all_cap: fetchAllCap,
        truncated_by_cap: albums.length >= fetchAllCap,
        pagination: paginationInfo({ total: sorted.length, returned: trunc.items.length }),
      });
    },
  );

  // ------------------------------------------------------------------ #342
  server.tool(
    'search_fresh',
    'Query-scoped newness: runs your query with Spotify\'s `tag:new` filter (last ~2 weeks of releases) — '
      + 'per-artist/genre "what just dropped" without the dead browse/new-releases endpoint. '
      + 'Quota: 🟢 one GET /search call.',
    {
      query: z.string().min(1).describe("Base query, e.g. an artist name ('Noise Pop 2026') or genre"),
      types: z
        .array(z.enum(['album', 'track']))
        .min(1)
        .max(2)
        .optional()
        .describe("Types to search. Default: ['album','track'] (tag:new is only meaningful for releases)"),
      limit: SearchLimit,
      market: Market,
      response_format: ResponseFormat,
      max_results: z.number().int().positive().max(2000).optional(),
    },
    async (args) => {
      const rf = args.response_format;
      const types = args.types ?? ['album', 'track'];
      const q = `${args.query} tag:new`;
      const data = await client.get<CatalogSearchResponse>(
        '/search',
        searchRequestParams(q, types.join(','), { query: q, limit: args.limit, market: args.market }),
      );
      const lines: string[] = [`Fresh releases (tag:new) for "${args.query}":`, ''];
      const payload: Record<string, unknown> = { query: q, types };
      let count = 0;
      if (types.includes('album')) {
        const sec = (data?.albums?.items ?? []).filter((x) => x != null) as SpotifyAlbumItem[];
        count += sec.length;
        lines.push(`ALBUMS (${data?.albums?.total ?? sec.length}):`);
        lines.push(...(sec.length > 0
          ? sec.map((al) => `• "${al.name}" — ${(al.artists ?? []).map((a) => a.name).join(', ')} | ${al.release_date ?? '?'}`)
          : ['  (nothing in the last ~2 weeks)']));
        payload.albums = sec;
        lines.push('');
      }
      if (types.includes('track')) {
        const sec = (data?.tracks?.items ?? []).filter((x) => x != null) as TrackPayload[];
        count += sec.length;
        lines.push(`TRACKS (${data?.tracks?.total ?? sec.length}):`);
        lines.push(...(sec.length > 0
          ? sec.map((t) => `• "${t.name}" — ${(t.artists ?? []).map((a) => a.name).join(', ')} | ${t.album?.name ?? '?'} (${yearOf(t.album?.release_date) ?? '?'})`)
          : ['  (nothing in the last ~2 weeks)']));
        payload.tracks = sec;
      }
      if (count === 0) lines.push('', 'No tag:new matches — the filter only covers the last ~2 weeks.');
      return emit(rf, lines.join('\n'), payload);
    },
  );

  // ------------------------------------------------------------------ #343
  server.tool(
    'track_enrichment_batch',
    'Up to 50 track IDs → enriched rows: album release date, label and artist genres joined back onto each track '
      + 'via chunked several-tracks + several-albums + several-artists fan-in. '
      + 'Quota: 🟡 ~3 chunked API calls (one per several-* endpoint, more when chunking splits).',
    {
      track_ids: z.array(z.string().min(1)).min(1).max(50).describe('Up to 50 Spotify track IDs'),
      fields: z
        .array(z.enum(['release_date', 'label', 'genres', 'duration']))
        .optional()
        .describe('Projection of enrichment columns. Default: all four'),
      response_format: ResponseFormat,
max_results: z.number().int().positive().max(2000).optional(),
    },
    async (args) => {
      const rf = args.response_format;
      const fields = args.fields ?? ['release_date', 'label', 'genres', 'duration'];
      const ids = [...new Set(args.track_ids)];
      const tracksRes = await client.get<{ tracks: (TrackPayload | null)[] }>(
        '/tracks',
        { ids: ids.join(',') },
      );
      const tracks = (tracksRes?.tracks ?? []).filter((t): t is TrackPayload => t != null);
      if (tracks.length === 0) throw new Error('No playable tracks found for the given IDs');

      const albumIds = [...new Set(tracks.map((t) => t.album?.id).filter((x): x is string => !!x))];
      const albums = new Map<string, AlbumPayload>();
      for (const group of chunk(albumIds, 20)) {
        const res = await client.get<{ albums: (AlbumPayload | null)[] }>('/albums', { ids: group.join(',') });
        for (const al of res?.albums ?? []) if (al?.id) albums.set(al.id, al);
      }
      const artistIds = [...new Set(tracks.flatMap((t) => (t.artists ?? []).map((a) => a.id)).filter((x): x is string => !!x))];
      const genresByArtist = new Map<string, string[]>();
      for (const group of chunk(artistIds, 50)) {
        const res = await client.get<{ artists: (SpotifyArtistFull | null)[] }>('/artists', { ids: group.join(',') });
        for (const ar of res?.artists ?? []) if (ar?.id) genresByArtist.set(ar.id, ar.genres ?? []);
      }

      const cap = resolveMaxResults(args.max_results, getConfig().maxItems);
      const trunc = truncateItems(tracks, cap);
      const rows = trunc.items.map((t) => {
        const album = albums.get(t.album?.id ?? '');
        const merged: Record<string, unknown> = {
          id: t.id, uri: t.uri, name: t.name,
          artists: (t.artists ?? []).map((a) => a.name),
          album: t.album?.name ?? null,
        };
        if (fields.includes('release_date')) merged.album_release_date = album?.release_date ?? t.album?.release_date ?? null;
        if (fields.includes('duration')) merged.duration_ms = t.duration_ms;
        if (fields.includes('label')) merged.label = album?.label ?? null;
        if (fields.includes('genres')) {
          merged.artist_genres = Object.fromEntries(
            (t.artists ?? []).map((a) => [a.name, genresByArtist.get(a.id) ?? []]),
          );
        }
        return merged;
      });
      const lines = rows.map((r) => {
        const m = r as { name: string; artists: string[]; album: string | null; album_release_date?: unknown; label?: unknown; duration_ms?: unknown };
        const bits = [
          `${m.album ?? '?'}${m.album_release_date ? ` (${String(m.album_release_date)})` : ''}`,
          m.label ? `label: ${m.label}` : '',
          m.duration_ms !== undefined ? fmtDur(m.duration_ms as number) : '',
        ].filter(Boolean);
        return `• "${m.name}" — ${m.artists.join(', ')} | ${bits.join(' · ')}`;
      });
      return emit(rf, [`Enriched ${tracks.length} track${tracks.length === 1 ? '' : 's'}:`, '', ...lines].join('\n'), {
        tracks: rows,
        counts: { requested: args.track_ids.length, resolved: tracks.length, albums_fetched: albums.size, artists_fetched: genresByArtist.size },
        pagination: paginationInfo({ total: tracks.length, returned: trunc.items.length }),
      });
    },
  );

  // ------------------------------------------------------------------ #344
  server.tool(
    'albums_runtime_batch',
    '[local-compute] Runtime per album — total and mean track length — for up to 20 albums in one pass '
      + '(album objects embed the first 50 tracks, so totals are exact for albums up to 50 tracks and '
      + 'flagged as partial above that). Quota: 🟢 one GET /albums?ids= call.',
    {
      album_ids: z.array(z.string().min(1)).min(1).max(20).describe('Up to 20 Spotify album IDs'),
      market: Market,
      response_format: ResponseFormat,
    },
    async (args) => {
      const rf = args.response_format;
      const res = await client.get<{ albums: (AlbumPayload | null)[] }>(
        '/albums',
        { ids: args.album_ids.join(','), ...(args.market ? { market: args.market } : {}) },
      );
      const albums = (res?.albums ?? []).filter((a): a is AlbumPayload => a != null);
      if (albums.length === 0) throw new Error('No albums found for the given IDs');
      const rows = albums.map((al) => {
        const tracks = al.tracks?.items ?? [];
        const total = tracks.reduce((n, s) => n + (s.duration_ms ?? 0), 0);
        const embedded = al.tracks?.total ?? tracks.length;
        const partial = embedded > tracks.length;
        const mean = tracks.length > 0 ? Math.round(total / tracks.length) : 0;
        return {
          id: al.id, uri: al.uri, name: al.name,
          artists: (al.artists ?? []).map((a) => a.name),
          release_date: al.release_date ?? null,
          track_count_reported: embedded,
          tracks_used: tracks.length,
          partial_estimate: partial,
          total_runtime_ms: total,
          mean_track_ms: mean,
        };
      });
      const lines = rows.map((r) =>
        `• "${r.name}" — total ${fmtDur(r.total_runtime_ms)} · mean ${fmtDur(r.mean_track_ms)} / track · ${r.tracks_used}${r.partial_estimate ? ` of ${r.track_count_reported}` : ''} tracks${r.partial_estimate ? ' (PARTIAL — album embeds only the first 50)' : ''}`,
      );
      return emit(rf, [`Runtime per album (${rows.length} album${rows.length === 1 ? '' : 's'}):`, '', ...lines].join('\n'), { albums: rows });
    },
  );

  // ------------------------------------------------------------------ #345
  server.tool(
    'album_track_stats',
    '[local-compute] Track-length statistics for one album: min/max/mean/median plus a longest-track callout, '
      + 'built from a paged /albums/{id}/tracks walk. Quota: 🟡 one paginated walk (usually a single call).',
    {
      album_id: z.string().min(1).describe('Spotify album ID'),
      market: Market,
      response_format: ResponseFormat,
    },
    async (args) => {
      const rf = args.response_format;
      const fetchAllCap = getConfig().fetchAllCap;
      const albumMeta = await client.get<AlbumPayload>(`/albums/${encodeURIComponent(args.album_id)}`);
      const page = await client.get<{ items: SpotifyTrackSimple[]; total: number }>(
        `/albums/${encodeURIComponent(args.album_id)}/tracks`,
        { limit: '50', ...(args.market ? { market: args.market } : {}) },
      );
      if (!page || !Array.isArray(page.items) || page.items.length === 0) {
        throw new Error(`Album "${args.album_id}" not found or has no listed tracks`);
      }
      const tracks = page.items;
      const durations = tracks.map((s) => s.duration_ms ?? 0).sort((a, b) => a - b);
      const total = durations.reduce((n, d) => n + d, 0);
      const mean = Math.round(total / durations.length);
      const median = durations.length % 2 === 1
        ? durations[(durations.length - 1) / 2]
        : Math.round((durations[durations.length / 2 - 1] + durations[durations.length / 2]) / 2);
      const longest = [...tracks].sort((a, b) => (b.duration_ms ?? 0) - (a.duration_ms ?? 0))[0];
      const payload = {
        album: albumMeta
          ? { id: albumMeta.id, name: albumMeta.name, artists: (albumMeta.artists ?? []).map((a) => a.name), release_date: albumMeta.release_date ?? null }
          : { id: args.album_id },
        stats: {
          track_count: tracks.length,
          min_ms: durations[0],
          max_ms: durations[durations.length - 1],
          mean_ms: mean,
          median_ms: median,
          total_runtime_ms: total,
        },
        longest_track: { id: longest.id, name: longest.name, duration_ms: longest.duration_ms },
      };
      const name = albumMeta?.name ? `"${albumMeta.name}"` : args.album_id;
      const prose = [
        `Track stats for ${name} (${tracks.length} listed tracks):`,
        `  shortest: ${fmtDur(durations[0])} · median: ${fmtDur(median)} · mean: ${fmtDur(mean)} · longest: ${fmtDur(durations[durations.length - 1])}`,
        `  total runtime: ${fmtDur(total)}`,
        `  longest track: "${longest.name}" (${fmtDur(longest.duration_ms)})`,
      ].join('\n');
      return emit(rf, prose, payload);
    },
  );

  // ------------------------------------------------------------------ #346
  server.tool(
    'artist_discography_stats',
    '[local-compute] Discography shape for one artist: release counts by album/single/compilation, first and '
      + 'latest release, releases-per-year rate and the longest silence gap between releases. '
      + 'Quota: 🟡 one paginated /artists/{id}/albums walk (typically several API calls).',
    {
      artist_id: z.string().min(1).describe('Spotify artist ID'),
      include_groups: z
        .string()
        .optional()
        .describe('Comma-separated album groups: album,single,appears_on,compilation. Default: album,single'),
      response_format: ResponseFormat,
    },
    async (args) => {
      const rf = args.response_format;
      const fetchAllCap = getConfig().fetchAllCap;
      const artist = await client.get<SpotifyArtistFull>(`/artists/${encodeURIComponent(args.artist_id)}`);
      const albums = await client.getAllPages<SpotifyAlbumItem>(
        `/artists/${encodeURIComponent(args.artist_id)}/albums`,
        { include_groups: args.include_groups ?? 'album,single', limit: '50' },
        { maxItems: fetchAllCap },
      );
      if (albums.length === 0) throw new Error(`No releases found for artist "${args.artist_id}"`);
      const counts: Record<string, number> = {};
      for (const a of albums) {
        const k = a.album_type ?? 'album';
        counts[k] = (counts[k] ?? 0) + 1;
      }
      const dated = albums
        .map((a) => ({ a, t: tsOf(a.release_date) }))
        .filter((x): x is { a: SpotifyAlbumItem; t: number } => x.t !== null)
        .sort((x, y) => x.t - y.t);
      const first = dated[0];
      const latest = dated[dated.length - 1];
      const spanYears = Math.max(1, daysBetween(first.t, latest.t) / 365.25);
      const rate = Math.round((dated.length / spanYears) * 10) / 10;
      let longestGap = { days: 0, from: null as SpotifyAlbumItem | null, to: null as SpotifyAlbumItem | null };
      for (let i = 1; i < dated.length; i++) {
        const gap = daysBetween(dated[i - 1].t, dated[i].t);
        if (gap > longestGap.days) longestGap = { days: gap, from: dated[i - 1].a, to: dated[i].a };
      }
      const name = artist?.name ?? args.artist_id;
      const prose = [
        `Discography stats for ${name} (${albums.length} release${albums.length === 1 ? '' : 's'}${albums.length >= fetchAllCap ? ', fetch-all cap REACHED' : ''}):`,
        `  counts: ${Object.entries(counts).map(([k, v]) => `${v} ${k}${v === 1 ? '' : 's'}`).join(', ')}`,
        `  first: ${first.a.release_date} "${first.a.name}"`,
        `  latest: ${latest.a.release_date} "${latest.a.name}"`,
        `  rate: ${rate} releases/year over ~${Math.round(spanYears)} year(s)`,
        longestGap.from && longestGap.to
          ? `  longest silence: ${longestGap.days} days between "${longestGap.from.name}" (${longestGap.from.release_date}) and "${longestGap.to.name}" (${longestGap.to.release_date})`
          : '  longest silence: n/a',
      ].join('\n');
      return emit(rf, prose, {
        artist: { id: args.artist_id, name: artist?.name ?? null },
        total_releases: albums.length,
        counts_by_type: counts,
        first_release: { name: first.a.name, release_date: first.a.release_date },
        latest_release: { name: latest.a.name, release_date: latest.a.release_date },
        releases_per_year: rate,
        longest_silence_days: longestGap.days,
        fetch_all_cap: fetchAllCap,
        truncated_by_cap: albums.length >= fetchAllCap,
      });
    },
  );

  // ------------------------------------------------------------------ #347
  server.tool(
    'show_runtime_stats',
    '[local-compute] Runtime profile for one show: total and average episode runtime plus release cadence '
      + '(days between episodes), built from a paged /shows/{id}/episodes walk. '
      + 'Quota: 🟡 one paginated walk (typically several API calls).',
    {
      show_id: z.string().min(1).describe('Spotify show ID'),
      market: Market,
      max_episodes: z
        .number()
        .int()
        .min(1)
        .max(2000)
        .optional()
        .describe('Cap on episodes analyzed. Default: SPOTIFY_MCP_FETCH_ALL_CAP'),
      response_format: ResponseFormat,
    },
    async (args) => {
      const rf = args.response_format;
      const cap = args.max_episodes ?? getConfig().fetchAllCap;
      const show = await client.get<SpotifyShowSimple>(`/shows/${encodeURIComponent(args.show_id)}`);
      const episodes = await client.getAllPages<SpotifyEpisodeSimple>(
        `/shows/${encodeURIComponent(args.show_id)}/episodes`,
        { limit: '50', ...(args.market ? { market: args.market } : {}) },
        { maxItems: cap },
      );
      if (episodes.length === 0) throw new Error(`No episodes found for show "${args.show_id}"`);
      const durations = episodes.map((e) => e.duration_ms ?? 0);
      const total = durations.reduce((n, d) => n + d, 0);
      const avg = Math.round(total / durations.length);
      const dated = episodes
        .map((e) => ({ e, t: tsOf(e.release_date) }))
        .filter((x): x is { e: SpotifyEpisodeSimple; t: number } => x.t !== null)
        .sort((x, y) => x.t - y.t);
      let cadence: number | null = null;
      if (dated.length >= 2) {
        const gaps: number[] = [];
        for (let i = 1; i < dated.length; i++) gaps.push(daysBetween(dated[i - 1].t, dated[i].t));
        cadence = Math.round((gaps.reduce((n, g) => n + g, 0) / gaps.length) * 10) / 10;
      }
      const name = show?.name ?? args.show_id;
      const prose = [
        `Runtime stats for "${name}" (${episodes.length} episode${episodes.length === 1 ? '' : 's'} analyzed${episodes.length >= cap ? ', cap REACHED' : ''}):`,
        `  total runtime: ${fmtDur(total)} · average: ${fmtDur(avg)}/episode`,
        cadence !== null
          ? `  release cadence: ~${cadence} days between episodes (mean of ${dated.length - 1} gaps)`
          : '  release cadence: n/a (fewer than 2 dated episodes)',
      ].join('\n');
      return emit(rf, prose, {
        show: { id: args.show_id, name: show?.name ?? null, publisher: show?.publisher ?? null },
        episodes_analyzed: episodes.length,
        total_runtime_ms: total,
        average_episode_ms: avg,
        cadence_days: cadence,
        truncated_by_cap: episodes.length >= cap,
      });
    },
  );

  // ------------------------------------------------------------------ #348
  server.tool(
    'show_episode_timeline',
    '[local-compute] One show\'s episodes chronologically with hiatus-gap detection — any gap between consecutive '
      + 'release dates larger than the threshold is called out ("no episode in N days"). '
      + 'Quota: 🟡 one paginated /shows/{id}/episodes walk (typically several API calls).',
    {
      show_id: z.string().min(1).describe('Spotify show ID'),
      market: Market,
      gap_threshold_days: z
        .number()
        .min(1)
        .max(365)
        .optional()
        .describe('Minimum gap to flag as a hiatus, in days. Default: 14'),
      response_format: ResponseFormat,
      max_results: z.number().int().positive().max(2000).optional(),
    },
    async (args) => {
      const rf = args.response_format;
      const fetchAllCap = getConfig().fetchAllCap;
      const show = await client.get<SpotifyShowSimple>(`/shows/${encodeURIComponent(args.show_id)}`);
      const episodes = await client.getAllPages<SpotifyEpisodeSimple>(
        `/shows/${encodeURIComponent(args.show_id)}/episodes`,
        { limit: '50', ...(args.market ? { market: args.market } : {}) },
        { maxItems: fetchAllCap },
      );
      if (episodes.length === 0) throw new Error(`No episodes found for show "${args.show_id}"`);
      const threshold = args.gap_threshold_days ?? 14;
      const chronological = [...episodes].sort((a, b) => (a.release_date ?? '').localeCompare(b.release_date ?? ''));
      const cap = resolveMaxResults(args.max_results, fetchAllCap);
      const trunc = truncateItems(chronological, cap);
      const lines: string[] = [];
      const gaps: Array<{ after: string; days: number }> = [];
      for (let i = 1; i < chronological.length; i++) {
        const prev = tsOf(chronological[i - 1].release_date);
        const cur = tsOf(chronological[i].release_date);
        if (prev !== null && cur !== null) {
          const d = daysBetween(prev, cur);
          if (d >= threshold) {
            gaps.push({ after: chronological[i - 1].release_date ?? '?', days: d });
            lines.push(`  ⚠ hiatus — no episode for ${d} days after ${chronological[i - 1].release_date}`);
          }
        }
      }
      lines.push('', `Timeline (oldest → newest, ${chronological.length} episodes):`);
      lines.push(...trunc.items.map((e) => `• ${e.release_date ?? '?'} — "${e.name}" (${fmtDur(e.duration_ms)})`));
      if (trunc.footer) lines.push(`(${trunc.footer})`);
      return emit(rf, lines.join('\n'), {
        show: { id: args.show_id, name: show?.name ?? null },
        episode_count: chronological.length,
        gaps_flagged: gaps,
        gap_threshold_days: threshold,
        episodes: trunc.items.map((e) => ({ id: e.id, uri: e.uri, name: e.name, release_date: e.release_date ?? null, duration_ms: e.duration_ms })),
        pagination: paginationInfo({ total: chronological.length, returned: trunc.items.length }),
      });
    },
  );

  // ------------------------------------------------------------------ #349
  server.tool(
    'category_resolver',
    'Free-text genre/vibe → best-matching browse category ID via local fuzzy match over GET /browse/categories '
      + 'results. REGISTRATION GATE: /browse/categories is on the #329 app-registration gated surface — on fresh '
      + 'registrations this short-circuits with a clear disclosure instead of a raw 403. Quota: 🟡 1–4 API calls '
      + '(paged category walk).',
    {
      text: z.string().min(1).describe('Free-text genre/vibe, e.g. "chill electronic"'),
      country: MARKET_CODE.optional().describe('ISO 3166-1 alpha-2 country code, e.g. \'US\''),
      locale: z.string().optional().describe('Locale, e.g. en_US'),
      response_format: ResponseFormat,
    },
    async (args) => {
      const rf = args.response_format;
      let categories: Array<{ id: string; name: string }> = [];
      try {
        const cap = 200;
        for (let offset = 0; offset < cap; offset += 50) {
          const data = await client.get<{ categories: { items: Array<{ id: string; name: string }>; total?: number } }>(
            '/browse/categories',
            { limit: '50', offset: String(offset), ...(args.country ? { country: args.country } : {}), ...(args.locale ? { locale: args.locale } : {}) },
          );
          const items = data?.categories?.items ?? [];
          categories.push(...items);
          if (items.length < 50) break;
        }
      } catch (err) {
        if (isGatedError(err)) {
          const msg = gatedEndpointMessage('/browse/categories');
          return emit(rf, msg, { gated: true, endpoint: '/browse/categories' });
        }
        throw err;
      }
      if (categories.length === 0) throw new Error('No browse categories returned (empty catalog for this market)');
      const target = normalizeName(args.text);
      const tokens = new Set(target.split(' ').filter(Boolean));
      const scored = categories.map((c) => {
        const name = normalizeName(c.name);
        let score = 0;
        if (name === target) score = 100;
        else if (name.startsWith(target)) score = 80;
        else if (name.includes(target)) score = 60;
        else {
          const nameTokens = name.split(' ');
          const overlap = [...tokens].filter((t) => nameTokens.some((nt) => nt.startsWith(t) || t.startsWith(nt))).length;
          score = overlap > 0 ? (overlap / tokens.size) * 40 : 0;
        }
        return { category: c, score };
      });
      scored.sort((a, b) => b.score - a.score || a.category.name.localeCompare(b.category.name));
      const top = scored.filter((s) => s.score > 0).slice(0, 5);
      const best = top[0];
      const prose = best
        ? [
            `Best match for "${args.text}": ${best.category.name} (id: ${best.category.id}, score ${Math.round(best.score)})`,
            top.length > 1 ? '\nOther candidates:' : '',
            ...top.slice(1).map((s) => `  • ${s.category.name} (id: ${s.category.id}, score ${Math.round(s.score)})`),
          ].filter(Boolean).join('\n')
        : `No browse category matches "${args.text}" — try a broader term (e.g. "chill", "workout", "indie").`;
      return emit(rf, prose, {
        text: args.text,
        best_match: best ? { id: best.category.id, name: best.category.name, score: Math.round(best.score) } : null,
        candidates: top.map((s) => ({ id: s.category.id, name: s.category.name, score: Math.round(s.score) })),
        scanned_categories: categories.length,
      });
    },
  );

  // ------------------------------------------------------------------ #350
  server.tool(
    'search_by_isrc',
    'Exact track resolution from an ISRC via the `isrc:` search filter — the dedupe/relink anchor for catalog '
      + 'work. Quota: 🟢 one GET /search call.',
    {
      isrc: z.string().min(12).max(15).describe('ISRC code, e.g. USUM71703861 (spaces/dashes tolerated)'),
      market: Market,
      response_format: ResponseFormat,
    },
    async (args) => {
      const rf = args.response_format;
      const isrc = args.isrc.replace(/[^A-Za-z0-9]/g, '').toUpperCase();
      if (!/^[A-Z]{2}[A-Z0-9]{3}\d{7}$/.test(isrc)) {
        throw new Error(`"${args.isrc}" is not a valid ISRC (expected CC-XXX-YYNNNNN shape, 12 alphanumeric chars)`);
      }
      const { items, total } = await runTypedSearch<TrackPayload>(
        client, 'tracks', 'track', { query: isrc }, `isrc:${isrc}`,
      );
      const lines = items.map(
        (t) => `• "${t.name}" — ${(t.artists ?? []).map((a) => a.name).join(', ')} | ${t.album?.name ?? '?'} (${yearOf(t.album?.release_date) ?? '?'}) | ${t.uri}`,
      );
      return emitSearchResult(
        rf,
        items.length > 0
          ? `ISRC ${isrc} resolved to ${items.length} track${items.length === 1 ? '' : 's'}:`
          : `ISRC ${isrc} — no track found. The recording may not be distributed in this market's catalog.`,
        lines,
        items.map((t) => ({ id: t.id, uri: t.uri, name: t.name, artists: (t.artists ?? []).map((a) => a.name), album: t.album?.name ?? null, isrc: t.external_ids?.isrc ?? null })),
        total, { isrc }, 50,
      );
    },
  );

  // ------------------------------------------------------------------ #351
  server.tool(
    'find_canonical_track',
    '[local-compute] Given a title + artist, search all versions, group by (artist, title) and rank them — '
      + 'studio > album > live/remaster — to return the canonical URI plus a variant table. '
      + 'Quota: 🟡 1–2 GET /search calls (fallback broad search when the precise filter comes back empty).',
    {
      title: z.string().min(1).describe('Track title'),
      artist: z.string().min(1).describe('Primary artist name'),
      market: Market,
      response_format: ResponseFormat,
    },
    async (args) => {
      const rf = args.response_format;
      const precise = `track:"${args.title.replace(/"/g, '')}" artist:"${args.artist.replace(/"/g, '')}"`;
      let { items } = await runTypedSearch<TrackPayload>(client, 'tracks', 'track', { query: precise }, precise);
      let fallback = false;
      if (items.length === 0) {
        fallback = true;
        const broad = await runTypedSearch<TrackPayload>(
          client, 'tracks', 'track', { query: `${args.title} ${args.artist}` },
        );
        items = broad.items;
      }
      if (items.length === 0) throw new Error(`No versions of "${args.title}" by ${args.artist} found`);
      const groups = new Map<string, TrackPayload[]>();
      for (const t of items) {
        const primaryArtist = normalizeName(t.artists?.[0]?.name ?? '');
        const key = `${normalizeName(t.name)}::${primaryArtist}`;
        const bucket = groups.get(key);
        if (bucket) bucket.push(t);
        else groups.set(key, [t]);
      }
      const REMASTER_RE = /\b(live|remaster|remastered|deluxe|mono|demo|version|edit|mix)\b/i;
      const rank = (t: TrackPayload): number => {
        let score = 0;
        if (!REMASTER_RE.test(t.name)) score += 40;
        const albumType = t.album?.album_type ?? 'album';
        if (albumType === 'album') score += 30;
        else if (albumType === 'single') score += 15;
        const yr = yearOf(t.album?.release_date) ?? 2100;
        return score - yr / 1000;
      };
      const groupsList = [...groups.values()];
      for (const bucket of groupsList) bucket.sort((a, b) => rank(b) - rank(a));
      // The requested title + artist can normalize into several groups (e.g. "Song"
      // vs "Song (Live)"). Rank the groups themselves — by their best item — so the
      // canonical pick comes from the closest match, not the first search hit.
      groupsList.sort((a, b) => rank(b[0]) - rank(a[0]));
      const canonical = groupsList[0][0];
      const variantLines: string[] = [];
      const variants: Record<string, unknown>[] = [];
      for (const bucket of groupsList) {
        for (let i = 0; i < bucket.length; i++) {
          const t = bucket[i];
          const isCanonical = t === canonical;
          const flags: string[] = [];
          if (REMASTER_RE.test(t.name)) flags.push('remaster/live');
          variantLines.push(
            `${isCanonical ? '⭐ canonical' : `  variant ${i + 1}`}: "${t.name}" — ${(t.artists ?? []).map((a) => a.name).join(', ')} | ${t.album?.name ?? '?'} (${t.album?.release_date ?? '?'})${flags.length ? ` [${flags.join(', ')}]` : ''} | ${t.uri}`,
          );
          variants.push({ uri: t.uri, name: t.name, album: t.album?.name ?? null, release_date: t.album?.release_date ?? null, is_canonical: isCanonical });
        }
      }
      const prose = [
        `Canonical version of "${args.title}" by ${args.artist}:`,
        `  "${canonical.name}" — ${(canonical.artists ?? []).map((a) => a.name).join(', ')} | ${canonical.album?.name ?? '?'} (${canonical.album?.release_date ?? '?'})`,
        `  URI: ${canonical.uri}`,
        fallback ? '  (precise filter empty — broad search fallback used)' : '',
        '',
        `All versions (${variants.length}):`,
        ...variantLines,
      ].filter(Boolean).join('\n');
      return emit(rf, prose, {
        canonical: { uri: canonical.uri, id: canonical.id, name: canonical.name, album: canonical.album?.name ?? null },
        variants,
        groups: groupsList.length,
        fallback_search: fallback,
      });
    },
  );

  // ------------------------------------------------------------------ #352
  server.tool(
    'audiobook_chapter_map',
    '[local-compute] Chapter-by-chapter duration map, total runtime and the mid-point chapter for one audiobook. '
      + 'MARKET GATE: audiobooks are US/UK/CA/IE/NZ/AU only. Quota: 🟡 2+ API calls '
      + '(GET /audiobooks/{id} + paged GET /audiobooks/{id}/chapters).',
    {
      audiobook_id: z.string().min(1).describe('Spotify audiobook ID'),
      response_format: ResponseFormat,
      max_results: z.number().int().positive().max(2000).optional(),
    },
    async (args) => {
      const rf = args.response_format;
      const fetchAllCap = getConfig().fetchAllCap;
      const book = await client.get<SpotifyAudiobookSimple>(`/audiobooks/${encodeURIComponent(args.audiobook_id)}`);
      if (!book) throw new Error(`Audiobook "${args.audiobook_id}" not found`);
      const chapters = await client.getAllPages<SpotifyChapterSimple>(
        `/audiobooks/${encodeURIComponent(args.audiobook_id)}/chapters`,
        { limit: '50' },
        { maxItems: fetchAllCap },
      );
      if (chapters.length === 0) throw new Error(`No chapters listed for audiobook "${book.name}"`);
      const total = chapters.reduce((n, c) => n + (c.duration_ms ?? 0), 0);
      let cum = 0;
      let midpoint = chapters[0];
      for (const c of chapters) {
        cum += c.duration_ms ?? 0;
        if (cum > total / 2) {
          midpoint = c;
          break;
        }
      }
      const cap = resolveMaxResults(args.max_results, fetchAllCap);
      const trunc = truncateItems(chapters, cap);
      const lines = [
        `Chapter map for "${book.name}" — ${(book.authors ?? []).map((a) => a.name).join(', ')}`,
        `Total runtime: ${fmtDur(total)} across ${chapters.length} chapters${chapters.length >= fetchAllCap ? ' (fetch-all cap REACHED)' : ''}`,
        `Mid-point chapter: #${midpoint.chapter_number} "${midpoint.name}" (${fmtDur(midpoint.duration_ms)})`,
        '',
        ...trunc.items.map((c) => `  #${c.chapter_number}. "${c.name}" — ${fmtDur(c.duration_ms)}`),
      ];
      if (trunc.footer) lines.push(`(${trunc.footer})`);
      return emit(rf, lines.join('\n'), {
        audiobook: { id: book.id, name: book.name, authors: (book.authors ?? []).map((a) => a.name), total_chapters_reported: book.total_chapters ?? null },
        chapters: trunc.items.map((c) => ({ chapter_number: c.chapter_number, name: c.name, duration_ms: c.duration_ms, id: c.id })),
        total_runtime_ms: total,
        midpoint_chapter: { chapter_number: midpoint.chapter_number, name: midpoint.name },
        pagination: paginationInfo({ total: chapters.length, returned: trunc.items.length }),
      });
    },
  );

  // ------------------------------------------------------------------ #353
  server.tool(
    'artist_collab_network',
    '[local-compute] Featured/collab artists extracted from an artist\'s top tracks and recent albums with '
      + 'co-appearance counts — computed from real payloads, not the dead related-artists endpoint. '
      + 'NOTE: /artists/{id}/top-tracks is on the #329 registration-gated surface; if it 403s the network is '
      + 'computed from recent albums only, with an explicit disclosure. Quota: 🟡 1 + paginated API calls.',
    {
      artist_id: z.string().min(1).describe('Spotify artist ID'),
      market: Market,
      max_albums: z
        .number()
        .int()
        .min(1)
        .max(50)
        .optional()
        .describe('How many recent albums to walk. Default: 10'),
      response_format: ResponseFormat,
      max_results: z.number().int().positive().max(2000).optional(),
    },
    async (args) => {
      const rf = args.response_format;
      const target = await client.get<SpotifyArtistFull>(`/artists/${encodeURIComponent(args.artist_id)}`);
      if (!target) throw new Error(`Artist "${args.artist_id}" not found`);
      const counts = new Map<string, { name: string; count: number; via_top: boolean }>();
      const record = (artist: SpotifyArtistSimple | undefined, viaTop: boolean) => {
        if (!artist || artist.id === target.id) return;
        const prev = counts.get(artist.id);
        counts.set(artist.id, {
          name: artist.name,
          count: (prev?.count ?? 0) + 1,
          via_top: (prev?.via_top ?? false) || viaTop,
        });
      };
      let topTracksNote: string | null = null;
      try {
        const top = await client.get<{ tracks: TrackPayload[] }>(
          `/artists/${encodeURIComponent(args.artist_id)}/top-tracks`,
          args.market ? { market: args.market } : {},
        );
        for (const t of top?.tracks ?? []) for (const a of t.artists ?? []) record(a, true);
      } catch (err) {
        if (isGatedError(err)) {
          topTracksNote = gatedEndpointMessage('/artists/{id}/top-tracks') + ' Falling back to recent albums only.';
        } else {
          throw err;
        }
      }
      const maxAlbums = args.max_albums ?? 10;
      const albums = await client.getAllPages<AlbumPayload>(
        `/artists/${encodeURIComponent(args.artist_id)}/albums`,
        { include_groups: 'album,single', limit: '50' },
        { maxItems: maxAlbums },
      );
      for (const al of albums) {
        for (const a of al.artists ?? []) record(a, false);
        for (const track of al.tracks?.items ?? []) for (const a of track.artists ?? []) record(a, false);
      }
      const collabs = [...counts.entries()]
        .map(([id, v]) => ({ id, name: v.name, co_appearances: v.count, on_top_tracks: v.via_top }))
        .sort((a, b) => b.co_appearances - a.co_appearances || a.name.localeCompare(b.name));
      const cap = resolveMaxResults(args.max_results, getConfig().maxItems);
      const trunc = truncateItems(collabs, cap);
      const lines = [
        `Collab network for "${target.name}" — ${collabs.length} distinct collaborator(s) from ${albums.length} recent album(s)/single(s)${topTracksNote ? ' (top-tracks GATED — albums only)' : ' and top tracks'}:`,
        '',
        ...trunc.items.map((c) => `• ${c.name} — ${c.co_appearances} co-appearance${c.co_appearances === 1 ? '' : 's'}${c.on_top_tracks ? ' [top tracks]' : ''} | spotify:artist:${c.id}`),
      ];
      if (trunc.footer) lines.push(`(${trunc.footer})`);
      if (topTracksNote) lines.push('', topTracksNote);
      return emit(rf, lines.join('\n'), {
        artist: { id: target.id, name: target.name },
        collaborators: trunc.items,
        albums_walked: albums.length,
        top_tracks_available: topTracksNote === null,
        ...(topTracksNote ? { disclosure: topTracksNote } : {}),
        pagination: paginationInfo({ total: collabs.length, returned: trunc.items.length }),
      });
    },
  );

  // ------------------------------------------------------------------ #354
  server.tool(
    'search_market_diff',
    'Same query run in two markets with the result sets diffed — availability/regional insight in one card. '
      + 'Quota: 🟡 2 GET /search calls (one per market).',
    {
      query: z.string().min(1).describe('Search query'),
      types: z
        .array(z.enum(['track', 'artist', 'album', 'playlist', 'show', 'episode', 'audiobook']))
        .min(1)
        .max(2)
        .optional()
        .describe("Types to search (up to 2). Default: ['track']"),
      market_a: MARKET_CODE.describe("First market code, e.g. 'US'"),
      market_b: MARKET_CODE.describe("Second market code, e.g. 'GB'"),
      limit: SearchLimit,
      response_format: ResponseFormat,
    },
    async (args) => {
      const rf = args.response_format;
      const type = (args.types ?? ['track'])[0];
      const sectionKey = type === 'audiobook' ? 'audiobooks' : type === 'track' ? 'tracks' : type === 'artist' ? 'artists' : type === 'album' ? 'albums' : type === 'playlist' ? 'playlists' : type === 'show' ? 'shows' : 'episodes';
      const a = await runTypedSearch<{ uri?: string; id?: string; name?: string }>(client, sectionKey, type, { query: args.query, limit: args.limit, market: args.market_a });
      const b = await runTypedSearch<{ uri?: string; id?: string; name?: string }>(client, sectionKey, type, { query: args.query, limit: args.limit, market: args.market_b });
      const keyOf = (x: { uri?: string; id?: string }): string => x.uri ?? x.id ?? JSON.stringify(x);
      const setA = new Map(a.items.map((x) => [keyOf(x), x]));
      const setB = new Map(b.items.map((x) => [keyOf(x), x]));
      const onlyA = a.items.filter((x) => !setB.has(keyOf(x)));
      const onlyB = b.items.filter((x) => !setA.has(keyOf(x)));
      const both = a.items.filter((x) => setB.has(keyOf(x)));
      const lines = [
        `Market diff for "${args.query}" (${type}): ${args.market_a} vs ${args.market_b}`,
        `  both markets: ${both.length} · only ${args.market_a}: ${onlyA.length} · only ${args.market_b}: ${onlyB.length}`,
        '',
        onlyA.length > 0 ? `Only in ${args.market_a}:` : `Nothing exclusive to ${args.market_a}.`,
        ...onlyA.map((x) => `  • ${x.name ?? keyOf(x)} (${keyOf(x)})`),
        onlyB.length > 0 ? `Only in ${args.market_b}:` : `Nothing exclusive to ${args.market_b}.`,
        ...onlyB.map((x) => `  • ${x.name ?? keyOf(x)} (${keyOf(x)})`),
      ];
      return emit(rf, lines.join('\n'), {
        query: args.query,
        type,
        market_a: args.market_a,
        market_b: args.market_b,
        both,
        only_in_a: onlyA,
        only_in_b: onlyB,
      });
    },
  );

  // ------------------------------------------------------------------ #355
  server.tool(
    'episode_context_bundle',
    'Episode + parent show + neighbouring episodes (prev/next by release date) in one card. '
      + 'Quota: 🟡 2 API calls (GET /episodes/{id} + GET /shows/{id}/episodes).',
    {
      episode_id: z.string().min(1).describe('Spotify episode ID'),
      market: Market,
      response_format: ResponseFormat,
    },
    async (args) => {
      const rf = args.response_format;
      const episode = await client.get<SpotifyEpisodeFullLocal>(`/episodes/${encodeURIComponent(args.episode_id)}`);
      if (!episode) throw new Error(`Episode "${args.episode_id}" not found`);
      const showId = episode.show?.id;
      const neighbours = showId
        ? await client.get<{ items: SpotifyEpisodeSimple[]; total: number }>(
            `/shows/${encodeURIComponent(showId)}/episodes`,
            { limit: '50', ...(args.market ? { market: args.market } : {}) },
          )
        : null;
      const siblings = neighbours?.items ?? [];
      const targetTs = tsOf(episode.release_date);
      let prev: SpotifyEpisodeSimple | null = null;
      let next: SpotifyEpisodeSimple | null = null;
      if (targetTs !== null) {
        for (const s of siblings) {
          const st = tsOf(s.release_date);
          if (st === null) continue;
          const prevTs = prev ? tsOf(prev.release_date) : null;
          const nextTs = next ? tsOf(next.release_date) : null;
          if (st < targetTs && (prevTs === null || st > prevTs)) prev = s;
          if (st > targetTs && (nextTs === null || st < nextTs)) next = s;
        }
      }
      const lines = [
        `"${episode.name}" — show: ${episode.show?.name ?? 'unknown'}`,
        `Released ${episode.release_date ?? '?'} · ${fmtDur(episode.duration_ms)}`,
        episode.description ? `About: ${episode.description.slice(0, 200)}${episode.description.length > 200 ? '…' : ''}` : '',
        '',
        prev ? `← previous: "${prev.name}" (${prev.release_date})` : '← no previous episode in the current window',
        next ? `→ next: "${next.name}" (${next.release_date})` : '→ no next episode in the current window',
      ].filter(Boolean);
      return emit(rf, lines.join('\n'), {
        episode: { id: episode.id, uri: episode.uri, name: episode.name, release_date: episode.release_date ?? null, duration_ms: episode.duration_ms, show: episode.show ?? null },
        previous: prev ? { id: prev.id, name: prev.name, release_date: prev.release_date ?? null } : null,
        next: next ? { id: next.id, name: next.name, release_date: next.release_date ?? null } : null,
        siblings_in_window: siblings.length,
      });
    },
  );

  // ------------------------------------------------------------------ #356
  server.tool(
    'audiobooks_by_author',
    'Author catalogue via the `author:` search filter with client-side sorting — `sort=release` orders by release '
      + 'date (when Spotify exposes one; unknown dates sort last) and `sort=length` orders by chapter count as '
      + 'the length proxy. MARKET GATE: audiobooks are US/UK/CA/IE/NZ/AU only. Quota: 🟢 one GET /search call.',
    {
      author: z.string().min(1).describe('Author name'),
      sort: z.enum(['release', 'length']).optional().describe("Sort client-side by release date or chapter count. Default: 'release'"),
      limit: SearchLimit,
      market: Market,
      response_format: ResponseFormat,
    },
    async (args) => {
      const rf = args.response_format;
      const author = args.author.replace(/"/g, '');
      const q = `author:"${author}"`;
      const { items, total } = await runTypedSearch<AudiobookSearchItem>(
        client, 'audiobooks', 'audiobook', { query: q, limit: args.limit, market: args.market }, q,
      );
      const sorted = [...items].sort((a, b) => {
        if (args.sort === 'length') {
          return (b.total_chapters ?? 0) - (a.total_chapters ?? 0);
        }
        const av = a.release_date ?? '9999';
        const bv = b.release_date ?? '9999';
        return av.localeCompare(bv);
      });
      const lines = sorted.map((ab) => {
        const narrators = (ab.narrators ?? []).map((n) => n.name).join(', ');
        return `• "${ab.name}"${ab.release_date ? ` (${ab.release_date})` : ''} — ${ab.total_chapters ?? '?'} chapters${narrators ? ` · narrated by ${narrators}` : ''} | ${ab.uri}`;
      });
      return emitSearchResult(
        rf,
        `Audiobooks by ${author} — ${sorted.length} result${sorted.length === 1 ? '' : 's'}, sorted by ${args.sort ?? 'release'}:`,
        lines,
        sorted.map((ab) => ({ id: ab.id, uri: ab.uri, name: ab.name, release_date: ab.release_date ?? null, total_chapters: ab.total_chapters ?? null, narrators: (ab.narrators ?? []).map((n) => n.name) })),
        total,
        { sort: args.sort ?? 'release' },
        50,
      );
    },
  );

  // ------------------------------------------------------------------ #357
  server.tool(
    'artist_genres_compact',
    'Up to 50 artist IDs → name·genres two-column projection (compact roster view over several-artists). '
      + 'Quota: 🟢 one GET /artists?ids= call.',
    {
      artist_ids: z.array(z.string().min(1)).min(1).max(50).describe('Up to 50 Spotify artist IDs'),
      response_format: ResponseFormat,
    },
    async (args) => {
      const rf = args.response_format;
      const ids = [...new Set(args.artist_ids)];
      const res = await client.get<{ artists: (SpotifyArtistFull | null)[] }>('/artists', { ids: ids.join(',') });
      const artists = (res?.artists ?? []).filter((a): a is SpotifyArtistFull => a != null);
      if (artists.length === 0) throw new Error('No artists found for the given IDs');
      const cap = resolveMaxResults(undefined, getConfig().maxItems);
      const trunc = truncateItems(artists, cap);
      const pad = Math.min(30, Math.max(...trunc.items.map((x) => x.name.length), 1));
      const lines = trunc.items.map((a) => `• ${a.name.padEnd(pad)} — ${(a.genres ?? []).join(', ') || 'no genres'}`);
      const noGenres = artists.filter((a) => (a.genres ?? []).length === 0).length;
      if (trunc.footer) lines.push(`(${trunc.footer})`);
      return emit(rf, [`Roster (${artists.length} artists, ${noGenres} without genre tags):`, '', ...lines].join('\n'), {
        artists: trunc.items.map((a) => ({ id: a.id, name: a.name, genres: a.genres ?? [] })),
        counts: { requested: args.artist_ids.length, resolved: artists.length, without_genres: noGenres },
        pagination: paginationInfo({ total: artists.length, returned: trunc.items.length }),
      });
    },
  );
}

// ---------------------------------------------------------------------------
// Local widened search/episode types (Spotify adds fields beyond the shared
// simplified types; declared last so the registration body stays readable).
// ---------------------------------------------------------------------------

interface SpotifyEpisodeFullLocal {
  id: string;
  name: string;
  uri: string;
  duration_ms: number;
  release_date: string | null;
  description: string;
  show: { id: string; name: string; uri?: string } | null;
}

interface AudiobookSearchItem extends Omit<SpotifyAudiobookSimple, 'narrators'> {
  release_date?: string;
  narrators?: Array<{ name: string }>;
}
