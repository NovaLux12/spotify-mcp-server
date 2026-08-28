/** swarm3 discovery slice — 500-tool swarm v1.26.0 (issue #442). Owned by discovery builder. */
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { SpotifyClient } from '../client.js';
import type {
  SavedAlbumItem,
  SavedTrackItem,
  SearchResponse,
  SpotifyAlbumItem,
  SpotifyAlbumSimple,
  SpotifyArtistFull,
  SpotifyArtistSimple,
  SpotifyTrack,
  SpotifyTrackSimple,
} from '../types/spotify.js';
import {
  ResponseFormat,
  resolveMaxResults,
  truncateItems,
  paginationInfo,
} from '../shaping.js';
import type { ResponseFormatValue } from '../shaping.js';
import { getConfig } from '../config.js';
import { spotifyId, resolveSpotifyId } from '../refs.js';

// ---------------------------------------------------------------------------
// Shared shapes + local plumbing (mirrors exhaust2 house helpers)
// ---------------------------------------------------------------------------

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

/** m:ss duration formatting; h:mm:ss once an hour or more. */
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

/** Parse the year prefix of a Spotify release date, or null. */
function yearOf(date: string | null | undefined): number | null {
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

/** Strip edition suffixes so deluxe/remaster variants collapse to the base title. */
function baseTitle(name: string): string {
  return normalizeName(
    name
      .replace(/\s*\((?:deluxe|remaster|remastered|expanded|anniversary|explicit|super\s+deluxe|bonus)[^)]*\)\s*/gi, ' ')
      .replace(/\s+-\s+(?:deluxe|remaster|remastered|expanded|anniversary|explicit|bonus)[^-]*$/gi, ' '),
  );
}

function chunk<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/** Full album payload: simplified listing widened with label/copyright/tracks. */
interface AlbumPayload extends SpotifyAlbumItem {
  label?: string;
  copyrights?: Array<{ text: string; type: string }>;
  genres?: string[];
  tracks?: { items: SpotifyTrackSimple[]; total: number };
}

/** /artists/{id}/albums row widened with the album_group discriminator. */
interface ReleaseRow extends SpotifyAlbumItem {
  album_group?: string;
}

/** Track search row: album carries release metadata beyond the shared type. */
interface TrackSearchRow {
  id: string;
  name: string;
  uri: string;
  duration_ms: number;
  artists: SpotifyArtistSimple[];
  album?: {
    id?: string;
    name?: string;
    release_date?: string;
    album_type?: string;
  };
}

/** Widened saved-album row (real payloads carry label on the album). */
interface SavedAlbumWide {
  added_at: string;
  album: SpotifyAlbumItem & { label?: string };
}

/** Widened saved-track row (real payloads carry album release metadata). */
interface SavedTrackWide {
  added_at: string;
  track: SpotifyTrack & { album: SpotifyAlbumSimple & { release_date?: string; album_type?: string } };
}

/** Run one typed /search call and return the section's non-null rows. */
async function runSearch<T>(
  client: SpotifyClient,
  sectionKey: 'tracks' | 'artists' | 'albums',
  type: string,
  q: string,
  limit: number,
  market?: string,
): Promise<{ items: T[]; total: number | null }> {
  const params: Record<string, string> = { q, type, limit: String(Math.min(10, Math.max(1, limit))) };
  if (market) params.market = market;
  const data = await client.get<SearchResponse>('/search', params);
  const section = data?.[sectionKey];
  const items = (section?.items ?? []).filter((x) => x != null);
  return { items: items as T[], total: typeof section?.total === 'number' ? section.total : null };
}

/** Walk an artist's releases (paged, fetch-all cap). */
async function walkArtistAlbums(
  client: SpotifyClient,
  artistId: string,
  includeGroups: string,
  maxItems?: number,
): Promise<ReleaseRow[]> {
  return client.getAllPages<ReleaseRow>(
    `/artists/${encodeURIComponent(artistId)}/albums`,
    { include_groups: includeGroups, limit: '50' },
    { maxItems: maxItems ?? getConfig().fetchAllCap },
  );
}

/** Fan-in full album payloads (label/copyright/tracks) via chunked /albums?ids=. */
async function fetchFullAlbums(
  client: SpotifyClient,
  ids: string[],
  market?: string,
): Promise<Map<string, AlbumPayload>> {
  const out = new Map<string, AlbumPayload>();
  for (const group of chunk([...new Set(ids)], 20)) {
    const res = await client.get<{ albums: (AlbumPayload | null)[] }>(
      '/albums',
      { ids: group.join(','), ...(market ? { market } : {}) },
    );
    for (const al of res?.albums ?? []) if (al?.id) out.set(al.id, al);
  }
  return out;
}

/** Followed artists via the cursor-paged /me/following endpoint (offset paging does not apply). */
async function loadFollowedArtists(client: SpotifyClient, max: number): Promise<SpotifyArtistFull[]> {
  const out: SpotifyArtistFull[] = [];
  let after: string | undefined;
  while (out.length < max) {
    const params: Record<string, string> = { type: 'artist', limit: '50' };
    if (after) params.after = after;
    const page = await client.get<{
      artists?: {
        items?: SpotifyArtistFull[];
        cursors?: { after?: string } | null;
        next?: string | null;
      };
    }>('/me/following', params);
    const items = page?.artists?.items ?? [];
    if (items.length === 0) break;
    for (const a of items) out.push(a);
    if (!page?.artists?.next || !page.artists.cursors?.after) break;
    after = page.artists.cursors.after;
  }
  return out.slice(0, max);
}

/** Walk the user's saved albums (capped). */
async function walkSavedAlbums(client: SpotifyClient, cap: number): Promise<SavedAlbumWide[]> {
  const rows = await client.getAllPages<SavedAlbumWide>('/me/albums', { limit: '50' }, { maxItems: cap });
  return rows.filter((r) => r?.album != null);
}

/** Walk the user's saved tracks (capped). */
async function walkSavedTracks(client: SpotifyClient, cap: number): Promise<SavedTrackWide[]> {
  const rows = await client.getAllPages<SavedTrackWide>('/me/tracks', { limit: '50' }, { maxItems: cap });
  return rows.filter((r) => r?.track != null);
}

/** Latest dated release from a release list, null when empty/undated. */
function latestDated(rows: ReleaseRow[]): ReleaseRow | null {
  let best: ReleaseRow | null = null;
  let bestTs = -Infinity;
  for (const r of rows) {
    const t = tsOf(r.release_date);
    if (t === null) continue;
    if (t > bestTs || (t === bestTs && best !== null && (r.name ?? '').localeCompare(best.name ?? '') < 0)) {
      best = r;
      bestTs = t;
    }
  }
  return best;
}

/** ASCII histogram bar scaled to the max bucket. */
function bar(count: number, max: number, width = 30): string {
  if (max <= 0 || count <= 0) return '';
  return '█'.repeat(Math.min(width, Math.max(1, Math.round((count / max) * width))));
}

const nowMs = (): number => Date.now();

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

export function registerSwarm3DiscoveryTools(server: McpServer, client: SpotifyClient): void {
  // -------------------------------------------------------- 1. artist_deep_dive
  server.tool(
    'artist_deep_dive',
    'Builds a one-artist dossier from the artist object plus a full discography walk: genres, release counts by '
      + 'group, active span, most prolific year, first/latest releases and most frequent collaborators. '
      + 'Quota: 1 + one paginated /artists/{id}/albums walk.',
    {
      artist_id: spotifyId('artist'),
      include_groups: z
        .string()
        .optional()
        .describe('Comma-separated groups: album,single,appears_on,compilation. Default: all four'),
      response_format: ResponseFormat,
    },
    async (args) => {
      const rf = args.response_format;
      const artist = await client.get<SpotifyArtistFull>(`/artists/${encodeURIComponent(args.artist_id)}`);
      if (!artist) throw new Error(`Artist "${args.artist_id}" not found`);
      const albums = await walkArtistAlbums(
        client, args.artist_id, args.include_groups ?? 'album,single,appears_on,compilation',
      );
      if (albums.length === 0) throw new Error(`No releases found for "${artist.name}"`);
      const counts: Record<string, number> = {};
      const byYear = new Map<number, number>();
      const collabs = new Map<string, { name: string; count: number }>();
      for (const a of albums) {
        const g = a.album_group ?? a.album_type ?? 'album';
        counts[g] = (counts[g] ?? 0) + 1;
        const y = yearOf(a.release_date);
        if (y !== null) byYear.set(y, (byYear.get(y) ?? 0) + 1);
        for (const ar of a.artists ?? []) {
          if (ar.id === artist.id) continue;
          const prev = collabs.get(ar.id);
          collabs.set(ar.id, { name: ar.name, count: (prev?.count ?? 0) + 1 });
        }
      }
      const dated = albums
        .map((a) => ({ a, t: tsOf(a.release_date) }))
        .filter((x): x is { a: ReleaseRow; t: number } => x.t !== null)
        .sort((x, y) => x.t - y.t);
      const first = dated[0]?.a ?? null;
      const last = dated[dated.length - 1]?.a ?? null;
      const prolific = [...byYear.entries()].sort((x, y) => y[1] - x[1] || x[0] - y[0])[0] ?? null;
      const topCollabs = [...collabs.entries()]
        .map(([id, v]) => ({ id, name: v.name, co_appearances: v.count }))
        .sort((x, y) => y.co_appearances - x.co_appearances || x.name.localeCompare(y.name))
        .slice(0, 8);
      const span = first && last ? `${first.release_date} to ${last.release_date}` : 'unknown';
      const prose = [
        `Deep dive: ${artist.name}`,
        `  genres: ${artist.genres?.length ? artist.genres.join(', ') : 'untagged'}`,
        `  releases: ${albums.length} (${Object.entries(counts).map(([k, v]) => `${v} ${k}`).join(', ')})`,
        `  active span: ${span}`,
        prolific ? `  most prolific year: ${prolific[0]} (${prolific[1]} release${prolific[1] === 1 ? '' : 's'})` : '',
        first ? `  first: "${first.name}" (${first.release_date}, ${first.album_type})` : '',
        last ? `  latest: "${last.name}" (${last.release_date}, ${last.album_type})` : '',
        topCollabs.length
          ? `  top collaborators: ${topCollabs.slice(0, 5).map((c) => `${c.name} x${c.co_appearances}`).join(', ')}`
          : '  top collaborators: none on shared releases',
      ].filter(Boolean).join('\n');
      return emit(rf, prose, {
        artist: { id: artist.id, name: artist.name, genres: artist.genres ?? [] },
        total_releases: albums.length,
        counts_by_group: counts,
        active_span: { first: first?.release_date ?? null, latest: last?.release_date ?? null },
        most_prolific_year: prolific ? { year: prolific[0], releases: prolific[1] } : null,
        first_release: first ? { id: first.id, name: first.name, release_date: first.release_date } : null,
        latest_release: last ? { id: last.id, name: last.name, release_date: last.release_date } : null,
        top_collaborators: topCollabs,
        fetch_all_cap: getConfig().fetchAllCap,
        truncated_by_cap: albums.length >= getConfig().fetchAllCap,
      });
    },
  );

  // --------------------------------------------- 2. artist_discography_gaps
  server.tool(
    'artist_discography_gaps',
    'Chronological discography table (oldest to newest by default) with per-release gap-in-days versus the previous '
      + 'release, built from a paginated /artists/{id}/albums walk. '
      + 'Quota: one paginated walk (several queued calls on long discographies).',
    {
      artist_id: spotifyId('artist'),
      include_groups: z
        .string()
        .optional()
        .describe('Comma-separated album groups. Default: album,single'),
      since_year: z.number().int().min(1900).max(2100).optional()
        .describe('Only releases from this year onward'),
      order: z.enum(['oldest_first', 'newest_first']).optional()
        .describe('Output ordering. Default: oldest_first'),
      response_format: ResponseFormat,
      max_results: z.number().int().positive().max(2000).optional(),
    },
    async (args) => {
      const rf = args.response_format;
      const cap0 = getConfig().fetchAllCap;
      const albums = await walkArtistAlbums(client, args.artist_id, args.include_groups ?? 'album,single');
      const trimmed = args.since_year !== undefined
        ? albums.filter((a) => (yearOf(a.release_date) ?? 0) >= (args.since_year as number))
        : albums;
      const chrono = [...trimmed]
        .filter((a) => tsOf(a.release_date) !== null)
        .sort((a, b) => (a.release_date ?? '').localeCompare(b.release_date ?? '') || a.name.localeCompare(b.name));
      const gaps: number[] = [];
      for (let i = 0; i < chrono.length; i++) {
        if (i === 0) gaps.push(0);
        else {
          const p = tsOf(chrono[i - 1].release_date);
          const c = tsOf(chrono[i].release_date);
          gaps.push(p !== null && c !== null ? daysBetween(p, c) : 0);
        }
      }
      const ordered = args.order === 'newest_first' ? [...chrono].reverse() : chrono;
      const orderedGaps = args.order === 'newest_first' ? [...gaps].reverse() : gaps;
      const cap = resolveMaxResults(args.max_results, cap0);
      const trunc = truncateItems(ordered, cap);
      const lines = trunc.items.map((a, i) => {
        const gap = orderedGaps[i] ?? 0;
        const gapTxt = gap > 0 ? ` (+${gap}d)` : '';
        return `- ${a.release_date ?? '?'}${gapTxt} | ${a.album_group ?? a.album_type ?? 'album'} | "${a.name}" | ${a.total_tracks ?? '?'} tracks | ${a.uri}`;
      });
      if (trunc.footer) lines.push(`(${trunc.footer})`);
      const header = `Discography timeline for ${args.artist_id} (${chrono.length} dated releases`
        + `${args.since_year ? `, since ${args.since_year}` : ''}):`;
      return emit(rf, [header, '', ...lines].join('\n'), {
        artist_id: args.artist_id,
        releases: trunc.items.map((a) => ({
          id: a.id, uri: a.uri, name: a.name, release_date: a.release_date ?? null,
          album_type: a.album_type ?? null, album_group: a.album_group ?? null,
          total_tracks: a.total_tracks ?? null,
        })),
        total: chrono.length,
        truncated_by_cap: albums.length >= cap0,
        pagination: paginationInfo({ total: chrono.length, returned: trunc.items.length }),
      });
    },
  );

  // ---------------------------------------------------- 3. artist_era_sampler
  server.tool(
    'artist_era_sampler',
    'Splits an artist discography into equal year-span eras and deterministically picks representative releases per '
      + 'era (albums first, earliest and fullest first) as a sampling plan. '
      + 'Quota: one paginated /artists/{id}/albums walk.',
    {
      artist_id: spotifyId('artist'),
      eras: z.number().int().min(2).max(8).optional().describe('Number of eras to split the span into. Default: 3'),
      per_era: z.number().int().min(1).max(5).optional().describe('Releases picked per era. Default: 2'),
      response_format: ResponseFormat,
    },
    async (args) => {
      const rf = args.response_format;
      const albums = (await walkArtistAlbums(client, args.artist_id, 'album,single'))
        .filter((a) => tsOf(a.release_date) !== null);
      if (albums.length === 0) throw new Error(`No dated releases found for artist "${args.artist_id}"`);
      const years = albums.map((a) => yearOf(a.release_date) as number);
      const minY = Math.min(...years);
      const maxY = Math.max(...years);
      const nEras = args.eras ?? 3;
      const perEra = args.per_era ?? 2;
      const width = Math.max(1, Math.ceil((maxY - minY + 1) / nEras));
      const eraPlans: Array<Record<string, unknown>> = [];
      const lines: string[] = [`Era sampler for artist ${args.artist_id} (${minY}-${maxY}, ${nEras} eras):`, ''];
      for (let i = 0; i < nEras; i++) {
        const from = minY + i * width;
        const to = from + width - 1;
        const inEra = albums.filter((a) => {
          const y = yearOf(a.release_date) as number;
          return y >= from && y <= to;
        });
        const albumsFirst = [...inEra].sort((a, b) => {
          const ta = a.album_type === 'album' ? 0 : 1;
          const tb = b.album_type === 'album' ? 0 : 1;
          return ta - tb
            || (a.release_date ?? '').localeCompare(b.release_date ?? '')
            || (b.total_tracks ?? 0) - (a.total_tracks ?? 0)
            || a.name.localeCompare(b.name);
        });
        const picks = albumsFirst.slice(0, perEra);
        lines.push(`Era ${from}-${to} (${inEra.length} releases):`);
        if (picks.length === 0) lines.push('  (no releases in this era)');
        for (const p of picks) {
          lines.push(`  - "${p.name}" (${p.release_date}, ${p.album_type}, ${p.total_tracks ?? '?'} tracks) | ${p.uri}`);
        }
        eraPlans.push({
          era: `${from}-${to}`,
          release_count: inEra.length,
          picks: picks.map((p) => ({
            id: p.id, uri: p.uri, name: p.name, release_date: p.release_date ?? null,
            album_type: p.album_type ?? null, total_tracks: p.total_tracks ?? null,
          })),
        });
      }
      return emit(rf, lines.join('\n'), {
        artist_id: args.artist_id,
        span: { first_year: minY, last_year: maxY },
        era_width_years: width,
        eras: eraPlans,
      });
    },
  );

  // ------------------------------------------------------- 4. artist_deep_cuts
  server.tool(
    'artist_deep_cuts',
    'Finds an artist\'s deep cuts: tracks whose (normalized) title appears on exactly one release across the '
      + 'artist\'s recent albums and singles, ranked longest-first. '
      + 'Quota: 2 walks + one chunked /albums?ids= fan-in (1 call per 20 releases).',
    {
      artist_id: spotifyId('artist'),
      max_releases: z.number().int().min(1).max(100).optional()
        .describe('Releases analyzed (albums + singles, newest first). Default: 30'),
      response_format: ResponseFormat,
      max_results: z.number().int().positive().max(2000).optional(),
    },
    async (args) => {
      const rf = args.response_format;
      const maxRel = args.max_releases ?? 30;
      const releases = await walkArtistAlbums(client, args.artist_id, 'album,single');
      if (releases.length === 0) throw new Error(`No releases found for artist "${args.artist_id}"`);
      const newestFirst = [...releases].sort((a, b) =>
        (b.release_date ?? '').localeCompare(a.release_date ?? '') || a.name.localeCompare(b.name));
      const selected = newestFirst.slice(0, maxRel);
      const full = await fetchFullAlbums(client, selected.map((r) => r.id));
      const seen = new Map<string, number>();
      const rows: Array<{ release: ReleaseRow; track: SpotifyTrackSimple }> = [];
      for (const rel of selected) {
        const al = full.get(rel.id);
        for (const t of al?.tracks?.items ?? []) {
          const key = normalizeName(t.name);
          seen.set(key, (seen.get(key) ?? 0) + 1);
          rows.push({ release: rel, track: t });
        }
      }
      const deep = rows
        .filter((r) => (seen.get(normalizeName(r.track.name)) ?? 0) === 1)
        .sort((a, b) => (b.track.duration_ms ?? 0) - (a.track.duration_ms ?? 0)
          || (b.release.release_date ?? '').localeCompare(a.release.release_date ?? ''));
      const cap = resolveMaxResults(args.max_results, getConfig().maxItems);
      const trunc = truncateItems(deep, cap);
      const lines = [
        `Deep cuts for artist ${args.artist_id} (${selected.length} releases analyzed, ${deep.length} one-off tracks):`,
        '',
        ...trunc.items.map((r) =>
          `- "${r.track.name}" | from "${r.release.name}" (${r.release.release_date}, ${r.release.album_type}) | ${fmtDur(r.track.duration_ms)} | ${r.track.uri}`),
      ];
      if (trunc.footer) lines.push(`(${trunc.footer})`);
      return emit(rf, lines.join('\n'), {
        artist_id: args.artist_id,
        releases_analyzed: selected.length,
        deep_cuts: trunc.items.map((r) => ({
          id: r.track.id, uri: r.track.uri, name: r.track.name, duration_ms: r.track.duration_ms,
          release: { id: r.release.id, name: r.release.name, release_date: r.release.release_date ?? null, album_type: r.release.album_type ?? null },
        })),
        pagination: paginationInfo({ total: deep.length, returned: trunc.items.length }),
        truncated_by_cap: releases.length >= getConfig().fetchAllCap,
      });
    },
  );

  // --------------------------------------------------- 5. artist_first_release
  server.tool(
    'artist_first_release',
    'Locates an artist\'s earliest release across all album groups and returns a full card for it: label, '
      + 'copyright, track listing and runtime via the full album payload. '
      + 'Quota: one paginated walk + 1 GET /albums/{id}.',
    {
      artist_id: spotifyId('artist'),
      response_format: ResponseFormat,
    },
    async (args) => {
      const rf = args.response_format;
      const albums = await walkArtistAlbums(client, args.artist_id, 'album,single,appears_on,compilation');
      const dated = albums
        .filter((a) => tsOf(a.release_date) !== null)
        .sort((a, b) => (a.release_date ?? '').localeCompare(b.release_date ?? '') || a.name.localeCompare(b.name));
      const first = dated[0];
      if (!first) throw new Error(`No dated releases found for artist "${args.artist_id}"`);
      const full = (await fetchFullAlbums(client, [first.id])).get(first.id) ?? null;
      const tracks = full?.tracks?.items ?? [];
      const runtime = tracks.reduce((n, t) => n + (t.duration_ms ?? 0), 0);
      const artistName = (first.artists ?? []).map((a) => a.name).join(', ');
      const lines = [
        `First release by ${artistName || args.artist_id}:`,
        `  "${first.name}" (${first.release_date}, ${first.album_group ?? first.album_type}, ${first.total_tracks ?? tracks.length} tracks)`,
        full?.label ? `  label: ${full.label}` : '',
        full?.copyrights?.length ? `  copyright: ${full.copyrights.map((c) => c.text).join('; ')}` : '',
        tracks.length ? `  runtime: ${fmtDur(runtime)}` : '',
        '',
        ...tracks.slice(0, 50).map((t, i) => `  ${i + 1}. "${t.name}" (${fmtDur(t.duration_ms)})`),
        `  uri: ${first.uri}`,
      ].filter(Boolean);
      return emit(rf, lines.join('\n'), {
        first_release: {
          id: first.id, uri: first.uri, name: first.name,
          release_date: first.release_date ?? null, album_type: first.album_type ?? null,
          album_group: first.album_group ?? null,
          label: full?.label ?? null,
          copyrights: full?.copyrights ?? null,
          track_count: full?.tracks?.total ?? first.total_tracks ?? null,
          runtime_ms: runtime,
          tracks: tracks.map((t) => ({ id: t.id, name: t.name, track_number: t.track_number, duration_ms: t.duration_ms })),
        },
        releases_scanned: albums.length,
      });
    },
  );

  // ------------------------------------------- 6. artist_latest_release_report
  server.tool(
    'artist_latest_release_report',
    'Reports on an artist\'s most recent release: full metadata (label, copyright, track listing, runtime), days '
      + 'since release and the gap to the release before it. '
      + 'Quota: one paginated walk + 1-2 GET /albums/{id}.',
    {
      artist_id: spotifyId('artist'),
      include_groups: z
        .string()
        .optional()
        .describe('Comma-separated album groups. Default: album,single'),
      response_format: ResponseFormat,
    },
    async (args) => {
      const rf = args.response_format;
      const albums = await walkArtistAlbums(client, args.artist_id, args.include_groups ?? 'album,single');
      const chrono = albums
        .filter((a) => tsOf(a.release_date) !== null)
        .sort((a, b) => (a.release_date ?? '').localeCompare(b.release_date ?? '') || a.name.localeCompare(b.name));
      const latest = chrono[chrono.length - 1];
      if (!latest) throw new Error(`No dated releases found for artist "${args.artist_id}"`);
      const prev = chrono[chrono.length - 2] ?? null;
      const full = (await fetchFullAlbums(client, [latest.id])).get(latest.id) ?? null;
      const tracks = full?.tracks?.items ?? [];
      const runtime = tracks.reduce((n, t) => n + (t.duration_ms ?? 0), 0);
      const latestTs = tsOf(latest.release_date);
      const daysAgo = latestTs !== null ? daysBetween(latestTs, nowMs()) : null;
      const gapToPrev = prev && latestTs !== null && tsOf(prev.release_date) !== null
        ? daysBetween(tsOf(prev.release_date) as number, latestTs)
        : null;
      const lines = [
        `Latest release${prev ? ` (previous was "${prev.name}", ${prev.release_date})` : ''}:`,
        `  "${latest.name}" | ${latest.release_date} | ${latest.album_group ?? latest.album_type} | ${full?.label ?? 'label unknown'}`,
        daysAgo !== null ? `  released ${daysAgo} day${daysAgo === 1 ? '' : 's'} ago` : '',
        gapToPrev !== null ? `  gap since previous release: ${gapToPrev} days` : '',
        tracks.length ? `  runtime: ${fmtDur(runtime)} across ${tracks.length} listed tracks` : '',
        '',
        ...tracks.slice(0, 50).map((t, i) => `  ${t.track_number ?? i + 1}. "${t.name}" (${fmtDur(t.duration_ms)})`),
      ].filter(Boolean);
      return emit(rf, lines.join('\n'), {
        latest_release: {
          id: latest.id, uri: latest.uri, name: latest.name,
          release_date: latest.release_date ?? null, album_type: latest.album_type ?? null,
          album_group: latest.album_group ?? null, label: full?.label ?? null,
          copyrights: full?.copyrights ?? null,
          track_count: full?.tracks?.total ?? latest.total_tracks ?? null,
          runtime_ms: runtime,
          days_since_release: daysAgo,
        },
        previous_release: prev ? { id: prev.id, name: prev.name, release_date: prev.release_date ?? null } : null,
        gap_days_since_previous: gapToPrev,
        tracks: tracks.map((t) => ({ id: t.id, name: t.name, track_number: t.track_number, duration_ms: t.duration_ms })),
        releases_scanned: albums.length,
      });
    },
  );

  // ------------------------------------------- 7. artist_album_completeness
  server.tool(
    'artist_album_completeness',
    'Checks how complete your saved-album library is for one artist: canonical studio-album titles from the '
      + 'discography walk matched (edition-insensitively) against your /me/albums walk, with a missing list. '
      + 'Quota: 2 paginated walks (artist albums + saved albums).',
    {
      artist_id: spotifyId('artist'),
      saved_cap: z.number().int().min(1).max(2000).optional()
        .describe('Max saved albums scanned. Default: SPOTIFY_MCP_FETCH_ALL_CAP'),
      response_format: ResponseFormat,
    },
    async (args) => {
      const rf = args.response_format;
      const cap = args.saved_cap ?? getConfig().fetchAllCap;
      const releases = await walkArtistAlbums(client, args.artist_id, 'album');
      if (releases.length === 0) throw new Error(`No album-group releases found for artist "${args.artist_id}"`);
      const canonical = new Map<string, ReleaseRow>();
      for (const r of releases) {
        const key = baseTitle(r.name);
        const prev = canonical.get(key);
        if (!prev || (r.release_date ?? '').localeCompare(prev.release_date ?? '') < 0) canonical.set(key, r);
      }
      const saved = await walkSavedAlbums(client, cap);
      const savedKeys = new Set<string>();
      for (const row of saved) {
        if ((row.album.artists ?? []).some((a) => a.id === args.artist_id)) savedKeys.add(baseTitle(row.album.name));
      }
      const have: ReleaseRow[] = [];
      const missing: ReleaseRow[] = [];
      for (const [key, r] of [...canonical.entries()].sort((a, b) =>
        (a[1].release_date ?? '').localeCompare(b[1].release_date ?? '') || a[1].name.localeCompare(b[1].name))) {
        (savedKeys.has(key) ? have : missing).push(r);
      }
      const pct = canonical.size > 0 ? Math.round((have.length / canonical.size) * 100) : 0;
      const lines = [
        `Album completeness for artist ${args.artist_id}: ${have.length}/${canonical.size} canonical albums saved (${pct}%)`,
        '',
        have.length ? 'Saved:' : 'Saved: (none)',
        ...have.map((r) => `  + "${r.name}" (${r.release_date})`),
        missing.length ? 'Missing:' : 'Missing: (nothing — complete!)',
        ...missing.map((r) => `  - "${r.name}" (${r.release_date}, ${r.total_tracks ?? '?'} tracks) | ${r.uri}`),
      ];
      return emit(rf, lines.join('\n'), {
        artist_id: args.artist_id,
        canonical_album_count: canonical.size,
        saved_count: have.length,
        completeness_pct: pct,
        saved_albums: have.map((r) => ({ id: r.id, name: r.name, release_date: r.release_date ?? null })),
        missing_albums: missing.map((r) => ({ id: r.id, name: r.name, release_date: r.release_date ?? null, uri: r.uri })),
        saved_library_scanned: saved.length,
        truncated_by_cap: saved.length >= cap,
      });
    },
  );

  // ------------------------------------------------ 8. artist_top_vs_saved
  server.tool(
    'artist_top_vs_saved',
    'Compares your top artists (from /me/top/artists) against your own library: saved-album and saved-track counts '
      + 'per top artist, ranked by library presence. Read-only; no popularity fields used. '
      + 'Quota: 1 /me/top/artists + 2 capped library walks.',
    {
      window: z.enum(['short_term', 'medium_term', 'long_term']).optional()
        .describe("Listening window for top artists. Default: 'medium_term'"),
      artists_cap: z.number().int().min(1).max(25).optional()
        .describe('Top artists to compare. Default: 10'),
      saved_album_cap: z.number().int().min(1).max(2000).optional()
        .describe('Max saved albums scanned. Default: 1000'),
      saved_track_cap: z.number().int().min(1).max(2000).optional()
        .describe('Max saved tracks scanned. Default: 2000'),
      response_format: ResponseFormat,
    },
    async (args) => {
      const rf = args.response_format;
      const artistsCap = args.artists_cap ?? 10;
      const top = await client.get<{ items: SpotifyArtistFull[]; total?: number }>('/me/top/artists', {
        limit: String(Math.min(50, artistsCap)),
        time_range: args.window ?? 'medium_term',
      });
      const artists = (top?.items ?? []).slice(0, artistsCap);
      if (artists.length === 0) throw new Error('No top artists returned for this window — listen a little more first');
      const savedAlbums = await walkSavedAlbums(client, args.saved_album_cap ?? 1000);
      const savedTracks = await walkSavedTracks(client, args.saved_track_cap ?? 2000);
      const ids = new Set(artists.map((a) => a.id));
      const albumsBy = new Map<string, number>();
      for (const row of savedAlbums) {
        for (const a of row.album.artists ?? []) {
          if (ids.has(a.id)) albumsBy.set(a.id, (albumsBy.get(a.id) ?? 0) + 1);
        }
      }
      const tracksBy = new Map<string, number>();
      for (const row of savedTracks) {
        for (const a of row.track.artists ?? []) {
          if (ids.has(a.id)) tracksBy.set(a.id, (tracksBy.get(a.id) ?? 0) + 1);
        }
      }
      const rows = artists.map((a, i) => ({
        rank: i + 1,
        id: a.id,
        name: a.name,
        genres: a.genres ?? [],
        saved_albums: albumsBy.get(a.id) ?? 0,
        saved_tracks: tracksBy.get(a.id) ?? 0,
      })).sort((x, y) => y.saved_tracks - x.saved_tracks || y.saved_albums - x.saved_albums || x.rank - y.rank);
      const pad = Math.min(30, Math.max(...rows.map((r) => r.name.length), 1));
      const lines = [
        `Top ${rows.length} artists (${args.window ?? 'medium_term'}) vs your library:`,
        '',
        ...rows.map((r) => `- ${r.name.padEnd(pad)} | saved albums: ${r.saved_albums} | saved tracks: ${r.saved_tracks}`),
      ];
      return emit(rf, lines.join('\n'), {
        window: args.window ?? 'medium_term',
        artists: rows,
        library_scanned: { saved_albums: savedAlbums.length, saved_tracks: savedTracks.length },
      });
    },
  );

  // ------------------------------------------------- 9. find_collaborations
  server.tool(
    'find_collaborations',
    'Finds tracks where two artists appear together: walks artist A\'s releases, matches artist B (name or ID) on '
      + 'release-level credits, then pinpoints the exact shared tracks via full-album payloads. '
      + 'Quota: 1-2 walks/searches + chunked /albums?ids= fan-in.',
    {
      artist_a: spotifyId('artist'),
      artist_b: z.string().min(1).describe('Second artist: name, ID, URI or open.spotify.com URL'),
      max_releases: z.number().int().min(1).max(100).optional()
        .describe('Releases of artist A scanned. Default: 40'),
      market: Market,
      response_format: ResponseFormat,
    },
    async (args) => {
      const rf = args.response_format;
      const a = args.artist_a;
      let bId: string | null = null;
      let bName = args.artist_b.trim();
      const direct = bName.includes(':') || bName.includes('/') || /^[A-Za-z0-9]{22}$/.test(bName);
      if (direct) {
        bId = resolveSpotifyId(bName, 'artist');
      } else {
        const { items } = await runSearch<SpotifyArtistFull>(client, 'artists', 'artist', `artist:"${bName.replace(/"/g, '')}"`, 1, args.market);
        if (items.length === 0) throw new Error(`Artist "${bName}" not found in search`);
        bId = items[0].id;
        bName = items[0].name;
      }
      if (!bId) throw new Error(`Could not resolve artist reference "${args.artist_b}"`);
      const aArtist = await client.get<SpotifyArtistFull>(`/artists/${encodeURIComponent(a)}`);
      if (!aArtist) throw new Error(`Artist A "${a}" not found`);
      const releases = await walkArtistAlbums(client, a, 'album,single,appears_on');
      const newestFirst = [...releases].sort((x, y) =>
        (y.release_date ?? '').localeCompare(x.release_date ?? '') || x.name.localeCompare(y.name));
      const selected = newestFirst.slice(0, args.max_releases ?? 40);
      const releaseHits = selected.filter((r) => (r.artists ?? []).some((ar) => ar.id === bId));
      const full = await fetchFullAlbums(client, releaseHits.map((r) => r.id), args.market);
      const collabTracks: Array<Record<string, unknown>> = [];
      const lines: string[] = [
        `Collaborations between "${aArtist.name}" and "${bName}" (${selected.length} releases scanned):`,
        '',
      ];
      for (const rel of releaseHits) {
        const al = full.get(rel.id);
        const found = (al?.tracks?.items ?? []).filter((t) => (t.artists ?? []).some((ar) => ar.id === bId));
        lines.push(`- "${rel.name}" (${rel.release_date}, ${rel.album_group ?? rel.album_type})`);
        if (found.length > 0) {
          for (const t of found) {
            lines.push(`    track: "${t.name}" (${fmtDur(t.duration_ms)}) | ${t.uri}`);
            collabTracks.push({
              track: { id: t.id, uri: t.uri, name: t.name, duration_ms: t.duration_ms },
              release: { id: rel.id, name: rel.name, release_date: rel.release_date ?? null, album_type: rel.album_type ?? null },
            });
          }
        } else if ((al?.tracks?.items ?? []).length === 0) {
          lines.push('    (track listing unavailable — release-level credit only)');
        }
      }
      if (releaseHits.length === 0) lines.push('(no shared-credit releases found in the scanned window)');
      return emit(rf, lines.join('\n'), {
        artist_a: { id: a, name: aArtist.name },
        artist_b: { id: bId, name: bName },
        releases_scanned: selected.length,
        collab_releases: releaseHits.map((r) => ({ id: r.id, name: r.name, release_date: r.release_date ?? null })),
        collab_tracks: collabTracks,
      });
    },
  );

  // ------------------------------------------- 10. artist_collaboration_network
  server.tool(
    'artist_collaboration_network',
    'Builds a depth-2 collaboration web for one artist from discography walks alone: first-degree collaborators '
      + 'with co-appearance counts, then each top collaborator\'s recent releases to surface second-degree links and '
      + 'mutual connections. Quota: 1 + up to first_degree_cap additional small walks.',
    {
      artist_id: spotifyId('artist'),
      first_degree_cap: z.number().int().min(1).max(10).optional()
        .describe('Top first-degree collaborators expanded for second-degree links. Default: 4'),
      releases_per_collab: z.number().int().min(1).max(50).optional()
        .describe('Recent releases walked per collaborator. Default: 10'),
      max_releases: z.number().int().min(1).max(100).optional()
        .describe('Releases of the central artist scanned. Default: 30'),
      response_format: ResponseFormat,
      max_results: z.number().int().positive().max(2000).optional(),
    },
    async (args) => {
      const rf = args.response_format;
      const target = await client.get<SpotifyArtistFull>(`/artists/${encodeURIComponent(args.artist_id)}`);
      if (!target) throw new Error(`Artist "${args.artist_id}" not found`);
      const releases = await walkArtistAlbums(client, args.artist_id, 'album,single');
      const newestFirst = [...releases].sort((x, y) =>
        (y.release_date ?? '').localeCompare(x.release_date ?? '') || x.name.localeCompare(y.name));
      const selected = newestFirst.slice(0, args.max_releases ?? 30);
      const first = new Map<string, { name: string; count: number }>();
      for (const rel of selected) {
        for (const ar of rel.artists ?? []) {
          if (ar.id === target.id) continue;
          const prev = first.get(ar.id);
          first.set(ar.id, { name: ar.name, count: (prev?.count ?? 0) + 1 });
        }
      }
      const ranked = [...first.entries()]
        .map(([id, v]) => ({ id, name: v.name, co_appearances: v.count }))
        .sort((x, y) => y.co_appearances - x.co_appearances || x.name.localeCompare(y.name));
      const expand = ranked.slice(0, args.first_degree_cap ?? 4);
      const second = new Map<string, { name: string; via: string[] }>();
      const firstIds = new Set(expand.map((c) => c.id));
      for (const c of expand) {
        const rels = await client.getAllPages<ReleaseRow>(
          `/artists/${encodeURIComponent(c.id)}/albums`,
          { include_groups: 'album,single', limit: '50' },
          { maxItems: args.releases_per_collab ?? 10 },
        );
        for (const rel of rels) {
          for (const ar of rel.artists ?? []) {
            if (ar.id === c.id || ar.id === target.id || firstIds.has(ar.id)) continue;
            const prev = second.get(ar.id);
            if (!prev) second.set(ar.id, { name: ar.name, via: [c.name] });
            else if (!prev.via.includes(c.name)) second.set(ar.id, { name: ar.name, via: [...prev.via, c.name] });
          }
        }
      }
      const secondRows = [...second.entries()]
        .map(([id, v]) => ({ id, name: v.name, via: v.via, link_count: v.via.length }))
        .sort((x, y) => y.link_count - x.link_count || x.name.localeCompare(y.name));
      const mutual = secondRows.filter((r) => r.link_count >= 2);
      const capN = resolveMaxResults(args.max_results, getConfig().maxItems);
      const trunc = truncateItems(secondRows, capN);
      const lines = [
        `Collaboration web for "${target.name}" (${selected.length} own releases scanned):`,
        '',
        `First degree (${ranked.length}):`,
        ...ranked.slice(0, 15).map((c) => `  - ${c.name} | co-appearances: ${c.co_appearances} | spotify:artist:${c.id}`),
        '',
        `Second degree (via ${expand.map((c) => c.name).join(', ') || 'n/a'}):`,
        ...(trunc.items.length
          ? trunc.items.map((r) => `  - ${r.name} | linked via: ${r.via.join(', ')}${r.link_count >= 2 ? ' | MUTUAL' : ''}`)
          : ['  (none found in scanned window)']),
      ];
      if (trunc.footer) lines.push(`(${trunc.footer})`);
      return emit(rf, lines.join('\n'), {
        artist: { id: target.id, name: target.name },
        first_degree: ranked,
        second_degree: trunc.items,
        mutual_second_degree: mutual.map((r) => ({ id: r.id, name: r.name, via: r.via })),
        releases_scanned: selected.length,
        collaborators_expanded: expand.map((c) => c.name),
        pagination: paginationInfo({ total: secondRows.length, returned: trunc.items.length }),
      });
    },
  );

  // -------------------------------------------------------- 11. label_explorer
  server.tool(
    'label_explorer',
    'Census of record labels across your saved albums (label comes from chunked full-album fan-in); pass a label '
      + 'name to list just that label\'s albums in your library. Quota: 1 walk + 1 /albums?ids= call per 20 albums.',
    {
      label: z.string().min(1).optional().describe('Exact-ish label name to filter to (case-insensitive)'),
      saved_cap: z.number().int().min(1).max(2000).optional()
        .describe('Max saved albums scanned. Default: 500'),
      response_format: ResponseFormat,
      max_results: z.number().int().positive().max(2000).optional(),
    },
    async (args) => {
      const rf = args.response_format;
      const cap = args.saved_cap ?? 500;
      const saved = await walkSavedAlbums(client, cap);
      if (saved.length === 0) throw new Error('Your saved-album library is empty');
      const full = await fetchFullAlbums(client, saved.map((r) => r.album.id));
      const census = new Map<string, Array<{ id: string; name: string; release_date: string | null; artists: string[] }>>();
      for (const row of saved) {
        const lbl = full.get(row.album.id)?.label ?? '(unknown label)';
        const bucket = census.get(lbl) ?? [];
        bucket.push({
          id: row.album.id,
          name: row.album.name,
          release_date: row.album.release_date ?? null,
          artists: (row.album.artists ?? []).map((a) => a.name),
        });
        census.set(lbl, bucket);
      }
      const filter = args.label ? normalizeName(args.label) : null;
      const names = [...census.keys()].sort((a, b) => {
        if (filter) {
          const fa = normalizeName(a) === filter ? 0 : normalizeName(a).includes(filter) ? 1 : 2;
          const fb = normalizeName(b) === filter ? 0 : normalizeName(b).includes(filter) ? 1 : 2;
          if (fa !== fb) return fa - fb;
        }
        return (census.get(b) as Array<unknown>).length - (census.get(a) as Array<unknown>).length || a.localeCompare(b);
      });
      const target = filter ? names.filter((n) => normalizeName(n).includes(filter) || normalizeName(n) === filter) : names;
      const capN = resolveMaxResults(args.max_results, getConfig().maxItems);
      const shown = filter ? target : names.slice(0, 15);
      const trunc = truncateItems(shown, capN);
      const lines = [
        filter
          ? `Albums on labels matching "${args.label}" in your library (${target.reduce((n, l) => n + (census.get(l) as Array<unknown>).length, 0)} albums, ${target.length} label${target.length === 1 ? '' : 's'}):`
          : `Label census across ${saved.length} saved albums (top ${trunc.items.length} labels):`,
        '',
        ...trunc.items.map((l) => {
          const albums = census.get(l) as Array<{ name: string; release_date: string | null }>;
          return `- ${l} — ${albums.length} album${albums.length === 1 ? '' : 's'}${
            albums.length <= 5 ? `: ${albums.map((x) => `"${x.name}" (${x.release_date ?? '?'})`).join(', ')}` : ''
          }`;
        }),
      ];
      if (trunc.footer) lines.push(`(${trunc.footer})`);
      return emit(rf, lines.join('\n'), {
        saved_albums_scanned: saved.length,
        distinct_labels: census.size,
        labels: trunc.items.map((l) => ({
          label: l,
          album_count: (census.get(l) as Array<unknown>).length,
          albums: census.get(l),
        })),
        label_filter: args.label ?? null,
        truncated_by_cap: saved.length >= cap,
        pagination: paginationInfo({ total: target.length, returned: trunc.items.length }),
      });
    },
  );

  // --------------------------------------------------------- 12. year_explorer
  server.tool(
    'year_explorer',
    'Time-machine view of one release year built from your own library plus a small catalog supplement: saved '
      + 'albums and saved tracks originally released in that year, plus top catalog matches via a year: search. '
      + 'Quota: 2 capped library walks + 1 /search call.',
    {
      year: z.number().int().min(1900).max(2100).describe('Release year to explore'),
      saved_album_cap: z.number().int().min(1).max(2000).optional().describe('Default: 1000'),
      saved_track_cap: z.number().int().min(1).max(2000).optional().describe('Default: 2000'),
      catalog_limit: SearchLimitFragment,
      market: Market,
      response_format: ResponseFormat,
    },
    async (args) => {
      const rf = args.response_format;
      const [savedAlbums, savedTracks] = await Promise.all([
        walkSavedAlbums(client, args.saved_album_cap ?? 1000),
        walkSavedTracks(client, args.saved_track_cap ?? 2000),
      ]);
      const albums = savedAlbums
        .filter((r) => yearOf(r.album.release_date) === args.year)
        .sort((a, b) => (a.album.release_date ?? '').localeCompare(b.album.release_date ?? ''));
      const tracks = savedTracks
        .filter((r) => yearOf(r.track.album?.release_date) === args.year)
        .sort((a, b) => (a.track.album?.release_date ?? '').localeCompare(b.track.album?.release_date ?? ''));
      const q = `year:${args.year}`;
      const catalog = await runSearch<SpotifyAlbumItem>(client, 'albums', 'album', q, args.catalog_limit ?? 5, args.market);
      const lines = [
        `Year explorer: ${args.year}`,
        '',
        `In your library — ${albums.length} saved album${albums.length === 1 ? '' : 's'}, ${tracks.length} saved track${tracks.length === 1 ? '' : 's'} from ${args.year}:`,
        ...albums.map((r) => `  album: "${r.album.name}" — ${(r.album.artists ?? []).map((a) => a.name).join(', ')} (${r.album.release_date ?? '?'})`),
        ...tracks.slice(0, 25).map((r) => `  track: "${r.track.name}" — ${(r.track.artists ?? []).map((a) => a.name).join(', ')} | ${r.track.album?.name ?? '?'}`),
        tracks.length > 25 ? `  (...and ${tracks.length - 25} more tracks)` : '',
        '',
        `Catalog supplement (top ${catalog.items.length} album matches for ${q}):`,
        ...(catalog.items.length
          ? catalog.items.map((al) => `  - "${al.name}" — ${(al.artists ?? []).map((a) => a.name).join(', ')} (${al.release_date ?? '?'})`)
          : ['  (no matches)']),
      ];
      return emit(rf, lines.join('\n'), {
        year: args.year,
        saved_albums: albums.map((r) => ({ id: r.album.id, name: r.album.name, release_date: r.album.release_date ?? null, artists: (r.album.artists ?? []).map((a) => a.name) })),
        saved_tracks: tracks.map((r) => ({ id: r.track.id, uri: r.track.uri, name: r.track.name, album: r.track.album?.name ?? null })),
        catalog_albums: catalog.items,
        library_scanned: { saved_albums: savedAlbums.length, saved_tracks: savedTracks.length },
      });
    },
  );

  // --------------------------------------------------- 13. decade_sampler_plan
  server.tool(
    'decade_sampler_plan',
    'Read-only sampling plan across decades: groups your saved albums by release decade and deterministically picks '
      + 'evenly spaced representatives per decade (spread across the decade, longest-held tiebreak). '
      + 'Quota: 1 capped /me/albums walk.',
    {
      per_decade: z.number().int().min(1).max(10).optional().describe('Albums picked per decade. Default: 3'),
      saved_cap: z.number().int().min(1).max(2000).optional().describe('Max saved albums scanned. Default: 1000'),
      response_format: ResponseFormat,
    },
    async (args) => {
      const rf = args.response_format;
      const cap = args.saved_cap ?? 1000;
      const saved = await walkSavedAlbums(client, cap);
      if (saved.length === 0) throw new Error('Your saved-album library is empty');
      const perDecade = args.per_decade ?? 3;
      const decades = new Map<number, SavedAlbumWide[]>();
      for (const row of saved) {
        const y = yearOf(row.album.release_date);
        if (y === null) continue;
        const d = Math.floor(y / 10) * 10;
        const bucket = decades.get(d) ?? [];
        bucket.push(row);
        decades.set(d, bucket);
      }
      const sortedDecades = [...decades.keys()].sort((a, b) => a - b);
      const plan: Array<Record<string, unknown>> = [];
      const lines: string[] = [`Decade sampler plan across ${saved.length} saved albums:`, ''];
      for (const d of sortedDecades) {
        const bucket = decades.get(d) as SavedAlbumWide[];
        const byDate = [...bucket].sort((a, b) =>
          (a.album.release_date ?? '').localeCompare(b.album.release_date ?? '')
          || (a.added_at ?? '').localeCompare(b.added_at ?? ''));
        const picks: SavedAlbumWide[] = [];
        if (byDate.length <= perDecade) picks.push(...byDate);
        else {
          for (let i = 0; i < perDecade; i++) {
            const idx = Math.round((i * (byDate.length - 1)) / Math.max(1, perDecade - 1));
            const pick = byDate[idx];
            if (pick && !picks.includes(pick)) picks.push(pick);
          }
        }
        lines.push(`${d}s (${bucket.length} album${bucket.length === 1 ? '' : 's'} in library):`);
        for (const p of picks) {
          lines.push(`  - "${p.album.name}" — ${(p.album.artists ?? []).map((a) => a.name).join(', ')} (${p.album.release_date ?? '?'}) | ${p.album.uri}`);
        }
        plan.push({
          decade: `${d}s`,
          library_count: bucket.length,
          picks: picks.map((p) => ({
            id: p.album.id, uri: p.album.uri, name: p.album.name,
            artists: (p.album.artists ?? []).map((a) => a.name),
            release_date: p.album.release_date ?? null, added_at: p.added_at ?? null,
          })),
        });
      }
      return emit(rf, lines.join('\n'), {
        saved_albums_scanned: saved.length,
        per_decade: perDecade,
        decades: plan,
        note: 'Read-only plan — no playlist was created.',
        truncated_by_cap: saved.length >= cap,
      });
    },
  );

  // ------------------------------------------- 14. artist_name_disambiguator
  server.tool(
    'artist_name_disambiguator',
    'Resolves an ambiguous artist name: runs a typed artist search and profiles each candidate (genres, active '
      + 'year span and a sample release from a small discography probe) so you can pick the right ID. '
      + 'Quota: 1 /search + 1 small albums call per candidate.',
    {
      name: z.string().min(1).describe('Artist name to disambiguate'),
      candidates_cap: z.number().int().min(1).max(10).optional().describe('Candidates profiled. Default: 5'),
      market: Market,
      response_format: ResponseFormat,
    },
    async (args) => {
      const rf = args.response_format;
      const cap = args.candidates_cap ?? 5;
      const { items, total } = await runSearch<SpotifyArtistFull>(
        client, 'artists', 'artist', args.name.replace(/"/g, ''), cap, args.market,
      );
      if (items.length === 0) throw new Error(`No artist candidates found for "${args.name}"`);
      const rows: Array<Record<string, unknown>> = [];
      const lines = [`Artist candidates for "${args.name}" (${total ?? items.length} total matches):`, ''];
      for (const a of items) {
        let span = 'unknown';
        let sample: { name: string; release_date: string | null } | null = null;
        try {
          const probe = await client.get<{ items: ReleaseRow[] }>(
            `/artists/${encodeURIComponent(a.id)}/albums`,
            { include_groups: 'album,single', limit: '5' },
          );
          const rels = (probe?.items ?? []).filter((r) => tsOf(r.release_date) !== null);
          if (rels.length > 0) {
            const dates = rels.map((r) => r.release_date as string).sort();
            span = `${dates[0].slice(0, 4)}-${dates[dates.length - 1].slice(0, 4)} (recent 5)`;
            sample = { name: rels[rels.length - 1].name, release_date: rels[rels.length - 1].release_date ?? null };
          }
        } catch {
          span = 'probe failed';
        }
        lines.push(`- ${a.name} | ${a.id} | genres: ${a.genres?.length ? a.genres.slice(0, 4).join(', ') : 'untagged'} | releases: ${span}${sample ? ` | e.g. "${sample.name}"` : ''}`);
        rows.push({
          id: a.id, uri: a.uri, name: a.name, genres: a.genres ?? [],
          recent_span: span, sample_release: sample,
        });
      }
      return emit(rf, lines.join('\n'), {
        query: args.name,
        candidates: rows,
        total_matches: total,
      });
    },
  );

  // ------------------------------------------ 15. artistwatch_new_additions
  server.tool(
    'artistwatch_new_additions',
    'Watches your FOLLOWED artists for new material: walks /me/following, probes each artist\'s latest release and '
      + 'flags those released within the last N days. Quota: 1 cursor walk + 1 small albums call per followed artist.',
    {
      days: z.number().int().min(1).max(365).optional()
        .describe('Freshness window in days. Default: 30'),
      artists_cap: z.number().int().min(1).max(100).optional()
        .describe('Max followed artists probed. Default: 30'),
      response_format: ResponseFormat,
    },
    async (args) => {
      const rf = args.response_format;
      const windowDays = args.days ?? 30;
      const capN = args.artists_cap ?? 30;
      const followed = await loadFollowedArtists(client, capN);
      if (followed.length === 0) throw new Error('You follow no artists (or the follow scope is missing)');
      const additions: Array<Record<string, unknown>> = [];
      const quiet: Array<{ id: string; name: string; latest: string | null }> = [];
      for (const a of followed) {
        let latest: ReleaseRow | null = null;
        try {
          const probe = await client.get<{ items: ReleaseRow[] }>(
            `/artists/${encodeURIComponent(a.id)}/albums`,
            { include_groups: 'album,single', limit: '5' },
          );
          latest = latestDated(probe?.items ?? []);
        } catch {
          latest = null;
        }
        if (!latest || tsOf(latest.release_date) === null) {
          quiet.push({ id: a.id, name: a.name, latest: null });
          continue;
        }
        const ageDays = daysBetween(tsOf(latest.release_date) as number, nowMs());
        if (ageDays <= windowDays) {
          additions.push({
            artist: { id: a.id, name: a.name },
            release: { id: latest.id, uri: latest.uri, name: latest.name, release_date: latest.release_date ?? null, album_type: latest.album_type ?? null },
            days_ago: ageDays,
          });
        } else {
          quiet.push({ id: a.id, name: a.name, latest: latest.release_date ?? null });
        }
      }
      additions.sort((x, y) => (x.days_ago as number) - (y.days_ago as number));
      const lines = [
        `New additions from ${followed.length} followed artist${followed.length === 1 ? '' : 's'} (window: ${windowDays} days):`,
        '',
        additions.length
          ? additions.map((x) => {
              const r = x.release as { name: string; release_date: string | null; album_type: string | null; uri: string };
              const ar = x.artist as { name: string };
              return `- ${ar.name} — "${r.name}" (${r.release_date ?? '?'}, ${r.album_type ?? 'release'}, ${x.days_ago}d ago) | ${r.uri}`;
            }).join('\n')
          : '(nothing new in the window)',
        '',
        `${quiet.length} followed artist${quiet.length === 1 ? '' : 's'} had no release in the window.`,
      ];
      return emit(rf, lines.join('\n'), {
        window_days: windowDays,
        followed_scanned: followed.length,
        additions,
        quiet_count: quiet.length,
        quiet,
      });
    },
  );

  // ------------------------------------------- 16. album_representative_plan
  server.tool(
    'album_representative_plan',
    'Builds a deterministic "sample this album" plan: opener, mid-point, closer and the longest track, ordered by '
      + 'original position with cumulative offsets, from the full album payload. '
      + 'Quota: 1 GET /albums/{id} (+1 paged tracks walk above 50 tracks).',
    {
      album_id: spotifyId('album'),
      market: Market,
      response_format: ResponseFormat,
    },
    async (args) => {
      const rf = args.response_format;
      const albumId = encodeURIComponent(args.album_id);
      const album = await client.get<AlbumPayload>(`/albums/${albumId}`);
      if (!album) throw new Error(`Album "${args.album_id}" not found`);
      let tracks = album.tracks?.items ?? [];
      if ((album.tracks?.total ?? tracks.length) > tracks.length) {
        const extra = await client.getAllPages<SpotifyTrackSimple>(
          `/albums/${albumId}/tracks`, { limit: '50' }, { maxItems: getConfig().fetchAllCap },
        );
        tracks = extra;
      }
      if (tracks.length === 0) throw new Error(`Album "${album.name}" has no listed tracks`);
      const longest = [...tracks].sort((x, y) => (y.duration_ms ?? 0) - (x.duration_ms ?? 0))[0];
      const mid = tracks[Math.floor((tracks.length - 1) / 2)];
      const picks = [...new Set([tracks[0], mid, longest, tracks[tracks.length - 1]])]
        .sort((x, y) => x.track_number - y.track_number);
      const offsets = new Map<string, number>();
      let cum = 0;
      for (const t of tracks) {
        offsets.set(t.id, cum);
        cum += t.duration_ms ?? 0;
      }
      const roleOf = (t: SpotifyTrackSimple): string =>
        t.id === tracks[0].id ? 'opener' : t.id === tracks[tracks.length - 1].id ? 'closer' : t.id === longest.id ? 'longest' : 'mid-point';
      const lines = [
        `Representative sampling plan for "${album.name}" (${(album.artists ?? []).map((a) => a.name).join(', ')}, ${album.release_date ?? '?'}) — ${tracks.length} tracks, ${fmtDur(cum)} total:`,
        '',
        ...picks.map((t) => {
          const off = offsets.get(t.id) ?? 0;
          return `  ${roleOf(t).padEnd(9)} #${t.track_number} "${t.name}" — starts at ${fmtDur(off)} (${fmtDur(t.duration_ms)}) | ${t.uri}`;
        }),
        '',
        'Play these in order for a fair pass over the record.',
      ];
      return emit(rf, lines.join('\n'), {
        album: { id: album.id, uri: album.uri, name: album.name, release_date: album.release_date ?? null, artists: (album.artists ?? []).map((a) => a.name) },
        track_count: tracks.length,
        total_runtime_ms: cum,
        plan: picks.map((t) => ({
          role: roleOf(t),
          id: t.id, uri: t.uri, name: t.name, track_number: t.track_number,
          duration_ms: t.duration_ms, starts_at_ms: offsets.get(t.id) ?? 0,
        })),
      });
    },
  );

  // ------------------------------------------------------ 17. front_to_back_plan
  server.tool(
    'front_to_back_plan',
    'Full front-to-back listening plan for one album: ordered track listing with cumulative start times and '
      + 'vinyl-style side breaks at a configurable minutes-per-side budget. Read-only. '
      + 'Quota: 1 GET /albums/{id} (+1 paged tracks walk above 50 tracks).',
    {
      album_id: spotifyId('album'),
      side_minutes: z.number().int().min(5).max(45).optional()
        .describe('Approximate minutes per vinyl side (break inserted after a track would overflow). Default: 20'),
      market: Market,
      response_format: ResponseFormat,
    },
    async (args) => {
      const rf = args.response_format;
      const albumId = encodeURIComponent(args.album_id);
      const album = await client.get<AlbumPayload>(`/albums/${albumId}`);
      if (!album) throw new Error(`Album "${args.album_id}" not found`);
      let tracks = album.tracks?.items ?? [];
      if ((album.tracks?.total ?? tracks.length) > tracks.length) {
        const extra = await client.getAllPages<SpotifyTrackSimple>(
          `/albums/${albumId}/tracks`, { limit: '50' }, { maxItems: getConfig().fetchAllCap },
        );
        tracks = extra;
      }
      if (tracks.length === 0) throw new Error(`Album "${album.name}" has no listed tracks`);
      const budget = (args.side_minutes ?? 20) * 60_000;
      const sides: Array<{ label: string; tracks: SpotifyTrackSimple[]; runtime: number }> = [];
      let current: { label: string; tracks: SpotifyTrackSimple[]; runtime: number } = { label: 'Side A', tracks: [], runtime: 0 };
      let letter = 65;
      for (const t of tracks) {
        if (current.runtime > 0 && current.runtime + (t.duration_ms ?? 0) > budget) {
          sides.push(current);
          letter += 1;
          current = { label: `Side ${String.fromCharCode(letter)}`, tracks: [], runtime: 0 };
        }
        current.tracks.push(t);
        current.runtime += t.duration_ms ?? 0;
      }
      if (current.tracks.length > 0) sides.push(current);
      const total = tracks.reduce((n, t) => n + (t.duration_ms ?? 0), 0);
      const lines = [
        `Front-to-back plan: "${album.name}" — ${(album.artists ?? []).map((a) => a.name).join(', ')} (${album.release_date ?? '?'})`,
        `${tracks.length} tracks, ${fmtDur(total)} total, split into ${sides.length} side${sides.length === 1 ? '' : 's'} at ~${args.side_minutes ?? 20} min:`,
        '',
      ];
      const structuredSides: Array<Record<string, unknown>> = [];
      let cum = 0;
      for (const side of sides) {
        lines.push(`${side.label} (${fmtDur(side.runtime)}):`);
        const rows: Array<Record<string, unknown>> = [];
        for (const t of side.tracks) {
          lines.push(`  ${fmtDur(cum)}  #${t.track_number} "${t.name}" (${fmtDur(t.duration_ms)})`);
          rows.push({ id: t.id, uri: t.uri, name: t.name, track_number: t.track_number, duration_ms: t.duration_ms, starts_at_ms: cum });
          cum += t.duration_ms ?? 0;
        }
        lines.push('');
        structuredSides.push({ label: side.label, runtime_ms: side.runtime, tracks: rows });
      }
      return emit(rf, lines.join('\n').trimEnd(), {
        album: { id: album.id, uri: album.uri, name: album.name, release_date: album.release_date ?? null, artists: (album.artists ?? []).map((a) => a.name) },
        track_count: tracks.length,
        total_runtime_ms: total,
        side_minutes_budget: args.side_minutes ?? 20,
        sides: structuredSides,
        note: 'Read-only plan — no playback was started.',
      });
    },
  );

  // -------------------------------------------------------- 18. b_sides_finder
  server.tool(
    'b_sides_finder',
    'Surfaces an artist\'s b-sides: tracks on singles/compilation releases whose normalized titles never appear on '
      + 'the artist\'s core album-group releases, found via discography walks + chunked full-album fan-in. '
      + 'Quota: 2 walks + 1 /albums?ids= call per 20 releases per group.',
    {
      artist_id: spotifyId('artist'),
      max_per_group: z.number().int().min(1).max(60).optional()
        .describe('Releases scanned per group (newest first). Default: 30'),
      response_format: ResponseFormat,
      max_results: z.number().int().positive().max(2000).optional(),
    },
    async (args) => {
      const rf = args.response_format;
      const cap = args.max_per_group ?? 30;
      const coreRels = await walkArtistAlbums(client, args.artist_id, 'album');
      const sideRels = await walkArtistAlbums(client, args.artist_id, 'single,compilation');
      const pickNewest = (rows: ReleaseRow[]): ReleaseRow[] =>
        [...rows].sort((x, y) => (y.release_date ?? '').localeCompare(x.release_date ?? '') || x.name.localeCompare(y.name)).slice(0, cap);
      const coreSelected = pickNewest(coreRels);
      const sideSelected = pickNewest(sideRels);
      if (coreSelected.length === 0 && sideSelected.length === 0) {
        throw new Error(`No releases found for artist "${args.artist_id}"`);
      }
      const coreFull = await fetchFullAlbums(client, coreSelected.map((r) => r.id));
      const sideFull = await fetchFullAlbums(client, sideSelected.map((r) => r.id));
      const coreNames = new Set<string>();
      for (const rel of coreSelected) {
        for (const t of coreFull.get(rel.id)?.tracks?.items ?? []) coreNames.add(normalizeName(t.name));
      }
      const bsides: Array<{ track: SpotifyTrackSimple; release: ReleaseRow }> = [];
      for (const rel of sideSelected) {
        for (const t of sideFull.get(rel.id)?.tracks?.items ?? []) {
          if (!coreNames.has(normalizeName(t.name))) bsides.push({ track: t, release: rel });
        }
      }
      bsides.sort((x, y) => (y.release.release_date ?? '').localeCompare(x.release.release_date ?? '')
        || x.track.name.localeCompare(y.track.name));
      const capN = resolveMaxResults(args.max_results, getConfig().maxItems);
      const trunc = truncateItems(bsides, capN);
      const lines = [
        `B-sides for artist ${args.artist_id} (${coreSelected.length} core releases vs ${sideSelected.length} singles/compilations scanned, ${bsides.length} tracks not on any core release):`,
        '',
        ...trunc.items.map((b) =>
          `- "${b.track.name}" | on "${b.release.name}" (${b.release.release_date}, ${b.release.album_group ?? b.release.album_type}) | ${fmtDur(b.track.duration_ms)} | ${b.track.uri}`),
      ];
      if (trunc.footer) lines.push(`(${trunc.footer})`);
      return emit(rf, lines.join('\n'), {
        artist_id: args.artist_id,
        core_releases_scanned: coreSelected.length,
        side_releases_scanned: sideSelected.length,
        b_sides: trunc.items.map((b) => ({
          id: b.track.id, uri: b.track.uri, name: b.track.name, duration_ms: b.track.duration_ms,
          release: { id: b.release.id, name: b.release.name, release_date: b.release.release_date ?? null, album_group: b.release.album_group ?? null },
        })),
        pagination: paginationInfo({ total: bsides.length, returned: trunc.items.length }),
        truncated_by_cap: coreRels.length >= cap || sideRels.length >= cap,
      });
    },
  );

  // ---------------------------------------------------- 19. album_focus_report
  server.tool(
    'album_focus_report',
    'Deep focus report on one album: track-by-track listing with cumulative runtime, duration statistics, edition '
      + 'detection (same base title elsewhere in the artist discography) and label/copyright capture. '
      + 'Quota: 1 GET /albums/{id} + 1 paginated discography walk.',
    {
      album_id: spotifyId('album'),
      market: Market,
      response_format: ResponseFormat,
    },
    async (args) => {
      const rf = args.response_format;
      const albumId = encodeURIComponent(args.album_id);
      const album = await client.get<AlbumPayload>(`/albums/${albumId}`);
      if (!album) throw new Error(`Album "${args.album_id}" not found`);
      let tracks = album.tracks?.items ?? [];
      if ((album.tracks?.total ?? tracks.length) > tracks.length) {
        const extra = await client.getAllPages<SpotifyTrackSimple>(
          `/albums/${albumId}/tracks`, { limit: '50' }, { maxItems: getConfig().fetchAllCap },
        );
        tracks = extra;
      }
      if (tracks.length === 0) throw new Error(`Album "${album.name}" has no listed tracks`);
      const durations = tracks.map((t) => t.duration_ms ?? 0).sort((x, y) => x - y);
      const total = durations.reduce((n, d) => n + d, 0);
      const median = durations.length % 2 === 1
        ? durations[(durations.length - 1) / 2]
        : Math.round((durations[durations.length / 2 - 1] + durations[durations.length / 2]) / 2);
      const longest = [...tracks].sort((x, y) => (y.duration_ms ?? 0) - (x.duration_ms ?? 0))[0];
      const shortest = [...tracks].sort((x, y) => (x.duration_ms ?? 0) - (y.duration_ms ?? 0))[0];
      const primary = (album.artists ?? [])[0];
      const editions: Array<Record<string, unknown>> = [];
      if (primary?.id) {
        const rels = await walkArtistAlbums(client, primary.id, 'album');
        const base = baseTitle(album.name);
        for (const rel of rels) {
          if (rel.id === album.id) continue;
          if (baseTitle(rel.name) === base) {
            editions.push({
              id: rel.id, uri: rel.uri, name: rel.name, release_date: rel.release_date ?? null,
              album_type: rel.album_type ?? null, total_tracks: rel.total_tracks ?? null,
              track_delta: (rel.total_tracks ?? 0) - (album.tracks?.total ?? tracks.length),
            });
          }
        }
        editions.sort((x, y) => String(x.release_date).localeCompare(String(y.release_date)));
      }
      const lines = [
        `Focus report: "${album.name}" — ${(album.artists ?? []).map((a) => a.name).join(', ')} (${album.release_date ?? '?'}, ${album.album_type})`,
        album.label ? `  label: ${album.label}` : '',
        `  ${tracks.length} tracks, ${fmtDur(total)} runtime | shortest ${fmtDur(durations[0])} / median ${fmtDur(median)} / longest ${fmtDur(durations[durations.length - 1])}`,
        `  longest: #${longest.track_number} "${longest.name}" (${fmtDur(longest.duration_ms)}) | shortest: #${shortest.track_number} "${shortest.name}" (${fmtDur(shortest.duration_ms)})`,
        editions.length
          ? `  other editions in catalog: ${editions.map((e) => `"${e.name}" (${e.release_date}, ${e.total_tracks} tracks)`).join(', ')}`
          : '  no other editions detected in the album-group catalog',
        '',
        'Track listing:',
        ...tracks.map((t) => `  #${t.track_number} "${t.name}" (${fmtDur(t.duration_ms)})`),
      ].filter(Boolean);
      return emit(rf, lines.join('\n'), {
        album: {
          id: album.id, uri: album.uri, name: album.name, release_date: album.release_date ?? null,
          album_type: album.album_type ?? null, label: album.label ?? null,
          artists: (album.artists ?? []).map((a) => a.name),
        },
        stats: {
          track_count: tracks.length, total_runtime_ms: total,
          min_ms: durations[0], median_ms: median, max_ms: durations[durations.length - 1],
        },
        longest_track: { id: longest.id, name: longest.name, duration_ms: longest.duration_ms },
        shortest_track: { id: shortest.id, name: shortest.name, duration_ms: shortest.duration_ms },
        editions,
        tracks: tracks.map((t) => ({ id: t.id, uri: t.uri, name: t.name, track_number: t.track_number, duration_ms: t.duration_ms })),
      });
    },
  );

  // ----------------------------------------------------- 20. artist_catalog_stats
  server.tool(
    'artist_catalog_stats',
    'Numbers-only catalog profile for one artist: release totals by group, summed track counts, average tracks per '
      + 'release, active span, busiest year and median release gap, from one paginated discography walk. '
      + 'Quota: one paginated /artists/{id}/albums walk.',
    {
      artist_id: spotifyId('artist'),
      include_groups: z
        .string()
        .optional()
        .describe('Comma-separated album groups. Default: album,single,appears_on,compilation'),
      response_format: ResponseFormat,
    },
    async (args) => {
      const rf = args.response_format;
      const albums = await walkArtistAlbums(
        client, args.artist_id, args.include_groups ?? 'album,single,appears_on,compilation',
      );
      if (albums.length === 0) throw new Error(`No releases found for artist "${args.artist_id}"`);
      const counts: Record<string, number> = {};
      const byYear = new Map<number, number>();
      let trackSum = 0;
      for (const a of albums) {
        const g = a.album_group ?? a.album_type ?? 'album';
        counts[g] = (counts[g] ?? 0) + 1;
        trackSum += a.total_tracks ?? 0;
        const y = yearOf(a.release_date);
        if (y !== null) byYear.set(y, (byYear.get(y) ?? 0) + 1);
      }
      const chrono = albums
        .filter((a) => tsOf(a.release_date) !== null)
        .sort((x, y) => (x.release_date ?? '').localeCompare(y.release_date ?? ''));
      const gaps: number[] = [];
      for (let i = 1; i < chrono.length; i++) {
        const p = tsOf(chrono[i - 1].release_date);
        const c = tsOf(chrono[i].release_date);
        if (p !== null && c !== null) gaps.push(daysBetween(p, c));
      }
      gaps.sort((x, y) => x - y);
      const medianGap = gaps.length > 0
        ? (gaps.length % 2 === 1 ? gaps[(gaps.length - 1) / 2] : Math.round((gaps[gaps.length / 2 - 1] + gaps[gaps.length / 2]) / 2))
        : null;
      const first = chrono[0] ?? null;
      const last = chrono[chrono.length - 1] ?? null;
      const firstTs = first ? tsOf(first.release_date) : null;
      const lastTs = last ? tsOf(last.release_date) : null;
      const spanYears = first && last && firstTs !== null && lastTs !== null
        ? Math.max(1, Math.round(daysBetween(firstTs, lastTs) / 365.25))
        : null;
      const busiest = [...byYear.entries()].sort((x, y) => y[1] - x[1] || x[0] - y[0])[0] ?? null;
      const albumCount = counts.album ?? 0;
      const singleCount = counts.single ?? 0;
      const lines = [
        `Catalog stats for artist ${args.artist_id}:`,
        `  releases: ${albums.length} (${Object.entries(counts).map(([k, v]) => `${v} ${k}`).join(', ')})`,
        `  listed tracks: ${trackSum} total | avg ${Math.round((trackSum / albums.length) * 10) / 10} per release`,
        spanYears !== null ? `  active span: ~${spanYears} year(s) (${first?.release_date} to ${last?.release_date})` : '',
        busiest ? `  busiest year: ${busiest[0]} (${busiest[1]} releases)` : '',
        medianGap !== null ? `  median gap between releases: ${medianGap} days` : '',
        `  singles-to-albums ratio: ${singleCount}:${albumCount}`,
      ].filter(Boolean);
      return emit(rf, lines.join('\n'), {
        artist_id: args.artist_id,
        total_releases: albums.length,
        counts_by_group: counts,
        total_listed_tracks: trackSum,
        avg_tracks_per_release: Math.round((trackSum / albums.length) * 10) / 10,
        span_years: spanYears,
        first_release: first ? { name: first.name, release_date: first.release_date ?? null } : null,
        latest_release: last ? { name: last.name, release_date: last.release_date ?? null } : null,
        busiest_year: busiest ? { year: busiest[0], releases: busiest[1] } : null,
        median_gap_days: medianGap,
        singles_to_albums_ratio: `${singleCount}:${albumCount}`,
        truncated_by_cap: albums.length >= getConfig().fetchAllCap,
      });
    },
  );

  // --------------------------------------------------- 21. lyric_snippet_search
  server.tool(
    'lyric_snippet_search',
    'Finds candidate tracks for a remembered lyric or title fragment: runs quoted-phrase /search over tracks and '
      + 'ranks exact title matches first. DISCLOSURE: Spotify\'s public API has no lyrics endpoint, so matching is '
      + 'title/album-based; verify the snippet against the returned candidates. Quota: 1-2 /search calls.',
    {
      snippet: z.string().min(2).describe('Remembered phrase, lyric fragment or title fragment'),
      artist: z.string().min(1).optional().describe('Narrow to an artist name'),
      limit: SearchLimitFragment,
      market: Market,
      response_format: ResponseFormat,
    },
    async (args) => {
      const rf = args.response_format;
      const phrase = args.snippet.replace(/"/g, '').trim();
      const artistPart = args.artist ? ` artist:"${args.artist.replace(/"/g, '')}"` : '';
      const q = `"${phrase}"${artistPart}`;
      let { items } = await runSearch<TrackSearchRow>(client, 'tracks', 'track', q, args.limit ?? 10, args.market);
      let fallback = false;
      if (items.length === 0) {
        fallback = true;
        const broad = await runSearch<TrackSearchRow>(
          client, 'tracks', 'track', `${phrase}${artistPart}`, args.limit ?? 10, args.market,
        );
        items = broad.items;
      }
      const target = normalizeName(phrase);
      const scoreOf = (t: TrackSearchRow): number => {
        const n = normalizeName(t.name);
        if (n === target) return 3;
        if (n.includes(target) || target.includes(n)) return 2;
        return 1;
      };
      const ranked = [...items].sort((x, y) => scoreOf(y) - scoreOf(x)
        || (x.album?.release_date ?? '').localeCompare(y.album?.release_date ?? '')
        || x.name.localeCompare(y.name));
      const lines = [
        `Candidates for snippet "${args.snippet}"${args.artist ? ` by ${args.artist}` : ''}:`,
        fallback ? '(exact-phrase search empty — broad fallback used)' : '',
        ranked.length
          ? ranked.map((t) => {
              const exact = normalizeName(t.name) === target ? ' [exact title match]' : '';
              return `- "${t.name}" — ${(t.artists ?? []).map((a) => a.name).join(', ')} | ${t.album?.name ?? '?'} (${t.album?.release_date ?? '?'})${exact} | ${t.uri}`;
            }).join('\n')
          : '(no candidates — Spotify search cannot match inside lyrics; try a distinctive title word instead)',
        '',
        'Note: the Spotify public API exposes no lyrics search — these matches are title/album based.',
      ].filter(Boolean);
      return emit(rf, lines.join('\n'), {
        snippet: args.snippet,
        artist_filter: args.artist ?? null,
        candidates: ranked.map((t) => ({
          id: t.id, uri: t.uri, name: t.name,
          artists: (t.artists ?? []).map((a) => a.name),
          album: t.album?.name ?? null, release_date: t.album?.release_date ?? null,
          exact_title_match: normalizeName(t.name) === target,
        })),
        fallback_search: fallback,
        disclosure: 'Spotify public API has no lyrics endpoint; matching is title/album based.',
      });
    },
  );

  // ------------------------------------------- 22. new_music_from_top_artists
  server.tool(
    'new_music_from_top_artists',
    'Fresh-music digest from YOUR listening: probes the latest release of each of your top artists (from '
      + '/me/top/artists) and flags those released within the last N days. Quota: 1 /me/top/artists + 1 small '
      + 'albums call per top artist.',
    {
      window: z.enum(['short_term', 'medium_term', 'long_term']).optional()
        .describe("Top-artist window. Default: 'medium_term'"),
      days: z.number().int().min(1).max(365).optional()
        .describe('Freshness window in days. Default: 30'),
      artists_cap: z.number().int().min(1).max(25).optional()
        .describe('Top artists probed. Default: 10'),
      response_format: ResponseFormat,
    },
    async (args) => {
      const rf = args.response_format;
      const windowDays = args.days ?? 30;
      const cap = args.artists_cap ?? 10;
      const top = await client.get<{ items: SpotifyArtistFull[] }>('/me/top/artists', {
        limit: String(Math.min(50, cap)),
        time_range: args.window ?? 'medium_term',
      });
      const artists = (top?.items ?? []).slice(0, cap);
      if (artists.length === 0) throw new Error('No top artists returned for this window — listen a little more first');
      const fresh: Array<Record<string, unknown>> = [];
      const quiet: Array<{ id: string; name: string; latest_name: string | null; latest_date: string | null }> = [];
      for (const a of artists) {
        let latest: ReleaseRow | null = null;
        try {
          const probe = await client.get<{ items: ReleaseRow[] }>(
            `/artists/${encodeURIComponent(a.id)}/albums`,
            { include_groups: 'album,single', limit: '5' },
          );
          latest = latestDated(probe?.items ?? []);
        } catch {
          latest = null;
        }
        if (!latest || tsOf(latest.release_date) === null) {
          quiet.push({ id: a.id, name: a.name, latest_name: null, latest_date: null });
          continue;
        }
        const ageDays = daysBetween(tsOf(latest.release_date) as number, nowMs());
        if (ageDays <= windowDays) {
          fresh.push({
            artist: { id: a.id, name: a.name },
            release: { id: latest.id, uri: latest.uri, name: latest.name, release_date: latest.release_date ?? null, album_type: latest.album_type ?? null },
            days_ago: ageDays,
          });
        } else {
          quiet.push({ id: a.id, name: a.name, latest_name: latest.name, latest_date: latest.release_date ?? null });
        }
      }
      fresh.sort((x, y) => (x.days_ago as number) - (y.days_ago as number));
      const lines = [
        `New music from your top ${artists.length} artists (${args.window ?? 'medium_term'}, window ${windowDays} days):`,
        '',
        fresh.length
          ? fresh.map((x) => {
              const r = x.release as { name: string; release_date: string | null; uri: string };
              const ar = x.artist as { name: string };
              return `- ${ar.name} — "${r.name}" (${r.release_date ?? '?'}, ${x.days_ago}d ago) | ${r.uri}`;
            }).join('\n')
          : '(no fresh releases in the window)',
        '',
        `${quiet.length} top artist${quiet.length === 1 ? '' : 's'} quiet in the window.`,
      ];
      return emit(rf, lines.join('\n'), {
        window: args.window ?? 'medium_term',
        window_days: windowDays,
        artists_probed: artists.length,
        fresh,
        quiet,
      });
    },
  );

  // ------------------------------------------------------- 23. discovery_digest
  server.tool(
    'discovery_digest',
    'One combined discovery digest from your own data: latest releases from your top artists with freshness flags, '
      + 'a tag:new catalog search seeded with your most common top-artist genre, and a followed-artist count. '
      + 'Quota: ~2 + N small API calls (top artists, per-artist probes, 1 search, 1 followed walk).',
    {
      days: z.number().int().min(1).max(365).optional()
        .describe('Freshness window in days. Default: 30'),
      top_artists: z.number().int().min(1).max(15).optional()
        .describe('Top artists in section A. Default: 5'),
      market: Market,
      response_format: ResponseFormat,
    },
    async (args) => {
      const rf = args.response_format;
      const windowDays = args.days ?? 30;
      const cap = args.top_artists ?? 5;
      const top = await client.get<{ items: SpotifyArtistFull[] }>('/me/top/artists', {
        limit: String(Math.min(50, cap)),
        time_range: 'medium_term',
      });
      const artists = (top?.items ?? []).slice(0, cap);
      if (artists.length === 0) throw new Error('No top artists returned — listen a little more first');
      const genreCounts = new Map<string, number>();
      for (const a of artists) for (const g of a.genres ?? []) genreCounts.set(g, (genreCounts.get(g) ?? 0) + 1);
      const topGenre = [...genreCounts.entries()].sort((x, y) => y[1] - x[1] || x[0].localeCompare(y[0]))[0]?.[0] ?? null;
      const sections: string[] = [`Discovery digest (window: ${windowDays} days)`, ''];
      const payload: Record<string, unknown> = { window_days: windowDays, top_genre: topGenre };
      const latest: Array<Record<string, unknown>> = [];
      for (const a of artists) {
        let rel: ReleaseRow | null = null;
        try {
          const probe = await client.get<{ items: ReleaseRow[] }>(
            `/artists/${encodeURIComponent(a.id)}/albums`,
            { include_groups: 'album,single', limit: '5' },
          );
          rel = latestDated(probe?.items ?? []);
        } catch {
          rel = null;
        }
        if (rel && tsOf(rel.release_date) !== null) {
          const age = daysBetween(tsOf(rel.release_date) as number, nowMs());
          latest.push({
            artist: { id: a.id, name: a.name },
            release: { id: rel.id, uri: rel.uri, name: rel.name, release_date: rel.release_date ?? null, album_type: rel.album_type ?? null },
            days_ago: age,
            fresh: age <= windowDays,
          });
        }
      }
      latest.sort((x, y) => (x.days_ago as number) - (y.days_ago as number));
      sections.push('A. Latest from your top artists:');
      sections.push(latest.map((x) => {
        const r = x.release as { name: string; release_date: string | null; uri: string };
        const ar = x.artist as { name: string };
        return `  - ${ar.name} — "${r.name}" (${r.release_date ?? '?'}, ${x.days_ago}d ago${x.fresh ? ', FRESH' : ''})`;
      }).join('\n') || '  (no dated releases found)');
      sections.push('');
      const q = topGenre ? `genre:"${topGenre}" tag:new` : 'tag:new';
      const fresh = await runSearch<SpotifyAlbumItem>(client, 'albums', 'album', q, 5, args.market);
      sections.push(`B. tag:new catalog matches${topGenre ? ` for genre "${topGenre}"` : ''}:`);
      sections.push(fresh.items.length
        ? fresh.items.map((al) => `  - "${al.name}" — ${(al.artists ?? []).map((x) => x.name).join(', ')} (${al.release_date ?? '?'})`).join('\n')
        : '  (nothing tagged new right now)');
      sections.push('');
      let followed = 0;
      try {
        followed = (await loadFollowedArtists(client, 50)).length;
      } catch {
        followed = -1;
      }
      sections.push(`C. Followed artists scanned: ${followed >= 0 ? followed : 'scope unavailable'}`);
      payload.latest_from_top_artists = latest;
      payload.tag_new_albums = fresh.items;
      payload.followed_artists_count = followed;
      return emit(rf, sections.join('\n'), payload);
    },
  );

  // ------------------------------------------------ 24. era_distribution_report
  server.tool(
    'era_distribution_report',
    'Histogram of releases across eras: pass artist_id for that artist\'s discography in 5-year buckets, or omit it '
      + 'for your own saved-album library in decade buckets, with percentages and peak-era callouts. '
      + 'Quota: 1 walk (discography or saved albums).',
    {
      artist_id: spotifyId('artist').optional()
        .describe('Artist mode when given; omit for library mode'),
      include_groups: z
        .string()
        .optional()
        .describe('Artist mode album groups. Default: album,single'),
      saved_cap: z.number().int().min(1).max(2000).optional()
        .describe('Library mode max saved albums. Default: 1000'),
      response_format: ResponseFormat,
    },
    async (args) => {
      const rf = args.response_format;
      const lines: string[] = [];
      const buckets = new Map<number, number>();
      let width: number;
      let mode: 'artist' | 'library';
      let scanned = 0;
      let capHit = false;
      if (args.artist_id) {
        mode = 'artist';
        width = 5;
        const rels = (await walkArtistAlbums(client, args.artist_id, args.include_groups ?? 'album,single'))
          .filter((r) => tsOf(r.release_date) !== null);
        if (rels.length === 0) throw new Error(`No dated releases found for artist "${args.artist_id}"`);
        scanned = rels.length;
        capHit = scanned >= getConfig().fetchAllCap;
        for (const r of rels) {
          const y = yearOf(r.release_date) as number;
          const b = Math.floor(y / width) * width;
          buckets.set(b, (buckets.get(b) ?? 0) + 1);
        }
      } else {
        mode = 'library';
        width = 10;
        const cap = args.saved_cap ?? 1000;
        const saved = (await walkSavedAlbums(client, cap)).filter((r) => tsOf(r.album.release_date) !== null);
        if (saved.length === 0) throw new Error('Your saved-album library is empty (or nothing in it is dated)');
        scanned = saved.length;
        capHit = scanned >= cap;
        for (const r of saved) {
          const y = yearOf(r.album.release_date) as number;
          const b = Math.floor(y / width) * width;
          buckets.set(b, (buckets.get(b) ?? 0) + 1);
        }
      }
      const sorted = [...buckets.entries()].sort((x, y) => x[0] - y[0]);
      const max = Math.max(...sorted.map(([, c]) => c));
      const peak = sorted.reduce((x, y) => (y[1] > x[1] ? y : x), sorted[0]);
      lines.push(`${mode === 'artist' ? `Era distribution for artist ${args.artist_id}` : 'Era distribution of your saved albums'} (${scanned} releases, ${width}-year buckets):`, '');
      for (const [start, count] of sorted) {
        const pct = Math.round((count / scanned) * 100);
        lines.push(`  ${start}-${start + width - 1} | ${bar(count, max).padEnd(30, ' ')} ${count} (${pct}%)`);
      }
      lines.push('');
      lines.push(`Peak era: ${peak[0]}-${peak[0] + width - 1} (${peak[1]} releases, ${Math.round((peak[1] / scanned) * 100)}%)`);
      const dormant: string[] = [];
      for (let i = 1; i < sorted.length; i++) {
        const prevEnd = sorted[i - 1][0] + width - 1;
        if (sorted[i][0] > prevEnd + width) dormant.push(`${prevEnd + 1}-${sorted[i][0] - 1}`);
      }
      if (dormant.length) lines.push(`Empty spans: ${dormant.join(', ')}`);
      return emit(rf, lines.join('\n'), {
        mode,
        artist_id: args.artist_id ?? null,
        bucket_width_years: width,
        scanned,
        buckets: sorted.map(([start, count]) => ({
          start, end: start + width - 1, count, pct: Math.round((count / scanned) * 100),
        })),
        peak_era: { start: peak[0], end: peak[0] + width - 1, count: peak[1] },
        empty_spans: dormant,
        truncated_by_cap: capHit,
      });
    },
  );
}
