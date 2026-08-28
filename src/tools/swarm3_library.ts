/**
 * swarm3 library slice — feature swarm v1.25.0 (500-tool push, branch swarm3-500-tools).
 *
 * Owned by the library builder. All 24 tools in this slice are registered
 * here and nowhere else (index.ts/toolsets.ts are NOT edited by this slice).
 *
 * House conventions honoured here:
 *   • shaping.ts helpers only (ResponseFormat / MaxResults / resolveMaxResults /
 *     truncateItems / paginationInfo / listStructuredContent) — nothing hand-rolled
 *     beyond pure local math.
 *   • Saved-library walks go through client.getAllPages (low-priority queue,
 *     fetch-all cap respected via scan_cap).
 *   • Feb-2026 API shape: NO popularity/followers/available_markets/genres
 *     fields are read anywhere — those fields are gone from the API. The
 *     explicit / is_local / is_playable / restrictions flags are fine.
 *   • Read-only slice: no mutations, so dry_run appears only on the
 *     multi-walk scans where a request-cost preview is useful (repo convention
 *     from #57 applied to heavy scans).
 *   • No deprecated endpoints (SPEC §9).
 */
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { SpotifyClient } from '../client.js';
import { SpotifyApiError } from '../client.js';
import {
  ResponseFormat,
  MaxResults,
  resolveMaxResults,
  truncateItems,
  paginationInfo,
  listStructuredContent,
} from '../shaping.js';
import type { ResponseFormatValue } from '../shaping.js';
import { getConfig } from '../config.js';
import type {
  SavedTrackItem,
  SavedAlbumItem,
  SpotifyPlaylistSimple,
  PlaylistItemObject,
} from '../types/spotify.js';

type ToolOut = {
  content: Array<{ type: 'text'; text: string }>;
  structuredContent?: Record<string, unknown>;
};

function shapeResult(rf: ResponseFormatValue, prose: string, payload: Record<string, unknown>): ToolOut {
  return {
    content: [{ type: 'text', text: rf === 'json' ? JSON.stringify(payload, null, 2) : prose }],
    structuredContent: payload,
  };
}

// ---------------------------------------------------------------------------
// Shared args fragments
// ---------------------------------------------------------------------------

const ScanCap = z
  .number()
  .int()
  .min(1)
  .max(10000)
  .optional()
  .describe('Max saved items to walk per paginated source (default: SPOTIFY_MCP_FETCH_ALL_CAP)');

const TopN = z
  .number()
  .int()
  .min(1)
  .max(100)
  .optional()
  .describe('How many rows/groups to show (default 10)');

const DryRunScan = z
  .boolean()
  .optional()
  .describe('Preview only: report the request cost of the scan without performing it (default false)');

// ---------------------------------------------------------------------------
// Row types + loaders (Feb-2026 field shape: no popularity/markets/genres)
// ---------------------------------------------------------------------------

interface ArtistRef {
  id: string | null;
  name: string;
}

interface AlbumRef {
  id: string | null;
  name: string;
  release_date: string | null;
  album_type: string | null;
  label: string | null;
}

interface TrackRow {
  id: string | null;
  name: string;
  uri: string;
  duration_ms: number;
  explicit: boolean;
  is_local: boolean;
  is_playable: boolean | null;
  restriction_reason: string | null;
  added_at: string;
  artists: ArtistRef[];
  album: AlbumRef;
}

interface AlbumRow {
  id: string | null;
  name: string;
  uri: string;
  album_type: string;
  release_date: string | null;
  total_tracks: number;
  label: string | null;
  added_at: string;
  artists: ArtistRef[];
}

interface RecentlyPlayedShell {
  items?: Array<{ track?: { id?: string } | null } | null>;
}

function artistRefs(raw: unknown): ArtistRef[] {
  const arr = (raw as { artists?: unknown })?.artists;
  if (!Array.isArray(arr)) return [];
  const out: ArtistRef[] = [];
  for (const a of arr) {
    const one = a as { id?: string; name?: string };
    out.push({ id: typeof one?.id === 'string' ? one.id : null, name: typeof one?.name === 'string' ? one.name : '(unknown)' });
  }
  return out;
}

function toTrackRow(item: SavedTrackItem): TrackRow {
  const t = (item?.track ?? {}) as unknown as Record<string, unknown>;
  const album = (t.album ?? {}) as Record<string, unknown>;
  const restrictions = t.restrictions as { reason?: string } | undefined;
  return {
    id: typeof t.id === 'string' ? t.id : null,
    name: typeof t.name === 'string' ? t.name : '(unknown)',
    uri: typeof t.uri === 'string' ? t.uri : '',
    duration_ms: typeof t.duration_ms === 'number' ? t.duration_ms : 0,
    explicit: t.explicit === true,
    is_local: t.is_local === true,
    is_playable: typeof t.is_playable === 'boolean' ? t.is_playable : null,
    restriction_reason: restrictions?.reason ?? null,
    added_at: typeof item?.added_at === 'string' ? item.added_at : '',
    artists: artistRefs(t),
    album: {
      id: typeof album.id === 'string' ? album.id : null,
      name: typeof album.name === 'string' ? album.name : '(unknown)',
      release_date: typeof album.release_date === 'string' ? album.release_date : null,
      album_type: typeof album.album_type === 'string' ? album.album_type : null,
      label: typeof album.label === 'string' ? album.label : null,
    },
  };
}

function toAlbumRow(item: SavedAlbumItem): AlbumRow {
  const a = (item?.album ?? {}) as unknown as Record<string, unknown>;
  return {
    id: typeof a.id === 'string' ? a.id : null,
    name: typeof a.name === 'string' ? a.name : '(unknown)',
    uri: typeof a.uri === 'string' ? a.uri : '',
    album_type: typeof a.album_type === 'string' ? a.album_type : '(unknown)',
    release_date: typeof a.release_date === 'string' ? a.release_date : null,
    total_tracks: typeof a.total_tracks === 'number' ? a.total_tracks : 0,
    label: typeof a.label === 'string' ? a.label : null,
    added_at: typeof item?.added_at === 'string' ? item.added_at : '',
    artists: artistRefs(a),
  };
}

async function loadSavedTracks(client: SpotifyClient, scanCap: number): Promise<TrackRow[]> {
  const items = await client.getAllPages<SavedTrackItem>(
    '/me/tracks',
    { limit: '50' },
    { maxItems: scanCap },
  );
  return items.filter((i) => i?.track).map(toTrackRow);
}

async function loadSavedAlbums(client: SpotifyClient, scanCap: number): Promise<AlbumRow[]> {
  const items = await client.getAllPages<SavedAlbumItem>(
    '/me/albums',
    { limit: '50' },
    { maxItems: scanCap },
  );
  return items.filter((i) => i?.album).map(toAlbumRow);
}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

function yearOf(date: string | null): number | null {
  if (!date) return null;
  const m = /^(\d{4})/.exec(date);
  return m ? parseInt(m[1], 10) : null;
}

function decadeOf(date: string | null): string | null {
  const y = yearOf(date);
  if (y === null || Number.isNaN(y)) return null;
  return `${Math.floor(y / 10) * 10}s`;
}

function monthKeyOf(addedAt: string): string | null {
  if (!addedAt) return null;
  const m = /^(\d{4})-(\d{2})/.exec(addedAt);
  return m ? `${m[1]}-${m[2]}` : null;
}

function monthIndex(key: string): number {
  const [y, m] = key.split('-').map((p) => parseInt(p, 10));
  return y * 12 + (m - 1);
}

/** Longest run of consecutive months + run ending at the last add (current streak). */
function monthStreaks(keys: string[]): { longest: number; current: number; longest_span: [string, string] | null } {
  const uniq = [...new Set(keys.filter(Boolean))].sort();
  if (uniq.length === 0) return { longest: 0, current: 0, longest_span: null };
  let longest = 1;
  let bestStart = 0;
  let runStart = 0;
  for (let i = 1; i < uniq.length; i++) {
    if (monthIndex(uniq[i]) === monthIndex(uniq[i - 1]) + 1) {
      if (i - runStart + 1 > longest) {
        longest = i - runStart + 1;
        bestStart = runStart;
      }
    } else {
      runStart = i;
    }
  }
  let current = 1;
  for (let i = uniq.length - 1; i > 0; i--) {
    if (monthIndex(uniq[i]) === monthIndex(uniq[i - 1]) + 1) current++;
    else break;
  }
  return { longest, current, longest_span: [uniq[bestStart], uniq[bestStart + longest - 1]] };
}

function msToClock(ms: number): string {
  const totalSec = Math.round(ms / 1000);
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  const mm = h > 0 ? String(m).padStart(2, '0') : String(m);
  const ss = String(s).padStart(2, '0');
  return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}

/** Lowercase + collapse whitespace — identity key for "same track name". */
function normaliseName(name: string): string {
  return name.toLowerCase().replace(/\s+/g, ' ').trim();
}

/**
 * Strip edition noise (parenthesised/bracketed suffixes, remaster/deluxe
 * wording) so "Album (Remastered 2011)" and "Album" compare equal for the
 * edition lint.
 */
function stripEditionNoise(name: string): string {
  let out = name
    .replace(/\([^)]*\)|\[[^\]]*\]/g, ' ')
    .replace(/\b(?:remaster(?:ed)?|deluxe|expanded|anniversary|edition|mono|stereo|remix(?:es)?)\b/gi, ' ');
  out = out.replace(/\s*-\s*$/, ' ');
  return normaliseName(out);
}

const FEAT_RE = /(?:\(|\[)?\bfeat(?:uring)?\.?\s|\bfeat\.|featuring/i;

function primaryArtistName(row: { artists: ArtistRef[] }): string {
  return row.artists[0]?.name ?? '(unknown)';
}

function artistNames(row: { artists: ArtistRef[] }): string {
  return row.artists.map((a) => a.name).join(', ') || '(unknown)';
}

function tally<T>(items: readonly T[], keyFn: (item: T) => string | null): Map<string, number> {
  const map = new Map<string, number>();
  for (const item of items) {
    const k = keyFn(item);
    if (k === null) continue;
    map.set(k, (map.get(k) ?? 0) + 1);
  }
  return map;
}

function sortedTally(map: Map<string, number>): Array<[string, number]> {
  return [...map.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
}

function histogramLines(entries: Array<[string, number]>): string[] {
  const max = Math.max(1, ...entries.map(([, n]) => n));
  return entries.map(([k, n]) => `  ${k.padEnd(10)} ${String(n).padStart(5)}  ${'█'.repeat(Math.max(1, Math.round((n / max) * 30)))}`);
}

function quotaNote(err: unknown): string | null {
  if (err instanceof SpotifyApiError && err.status === 429) {
    return `Quota hit mid-scan (Retry-After: ${err.retryAfterSec ?? 'unknown'}s) — results are partial.`;
  }
  return null;
}

function walkCap(scan_cap?: number): number {
  return scan_cap ?? getConfig().fetchAllCap;
}

// ---------------------------------------------------------------------------
// Registration — 24 tools
// ---------------------------------------------------------------------------
export function registerSwarm3LibraryTools(server: McpServer, client: SpotifyClient): void {
  // 1. saved_albums_by_decade
  server.tool(
    'saved_albums_by_decade',
    'Group your saved albums by release decade (from each album release_date) and show a histogram. Read-only.',
    {
      response_format: ResponseFormat,
      max_results: MaxResults,
      scan_cap: ScanCap,
    },
    async ({ response_format, max_results, scan_cap }) => {
      const rf = response_format;
      const albums = await loadSavedAlbums(client, walkCap(scan_cap));
      const tallyMap = tally(albums, (a) => decadeOf(a.release_date));
      const entries = sortedTally(tallyMap);
      const unknown = albums.filter((a) => decadeOf(a.release_date) === null).length;
      const lines = [
        `Saved albums by release decade (${albums.length} album(s) walked${scan_cap ? `, scan_cap=${walkCap(scan_cap)}` : ''}).`,
        ...histogramLines(entries),
        ...(unknown > 0 ? [`  (unknown)   ${String(unknown).padStart(5)}`] : []),
      ];
      const payload: Record<string, unknown> = {
        total_albums: albums.length,
        decades: entries.map(([decade, count]) => ({ decade, count })),
        unknown_decade: unknown,
        scan_cap: walkCap(scan_cap),
      };
      return shapeResult(rf, lines.join('\n'), payload);
    },
  );

  // 2. saved_albums_by_label
  server.tool(
    'saved_albums_by_label',
    'Group your saved albums by record label (from each album payload) and rank labels by count. Read-only.',
    {
      response_format: ResponseFormat,
      max_results: MaxResults,
      scan_cap: ScanCap,
    },
    async ({ response_format, max_results, scan_cap }) => {
      const rf = response_format;
      const maxResults = resolveMaxResults(max_results, getConfig().maxItems);
      const albums = await loadSavedAlbums(client, walkCap(scan_cap));
      const entries = sortedTally(tally(albums, (a) => a.label ?? '(no label in payload)'));
      const t = truncateItems(entries, maxResults);
      const lines = [
        `Saved albums by label (${albums.length} album(s), ${entries.length} distinct label(s)).`,
        ...t.items.map(([label, n]) => `  • ${label}: ${n}`),
        ...(t.footer ? [`(${t.footer})`] : []),
      ];
      const payload: Record<string, unknown> = {
        ...listStructuredContent(
          t.items.map(([label, count]) => ({ label, count })),
          paginationInfo({ total: t.total, returned: t.returned }),
        ),
        total_albums: albums.length,
        distinct_labels: entries.length,
        truncated: t.truncated,
      };
      return shapeResult(rf, lines.join('\n'), payload);
    },
  );

  // 3. saved_albums_by_type
  server.tool(
    'saved_albums_by_type',
    'Group your saved albums by album_type (album / single / compilation / EP). Read-only.',
    {
      response_format: ResponseFormat,
      max_results: MaxResults,
      scan_cap: ScanCap,
    },
    async ({ response_format, max_results, scan_cap }) => {
      const rf = response_format;
      const albums = await loadSavedAlbums(client, walkCap(scan_cap));
      const entries = sortedTally(tally(albums, (a) => a.album_type || null));
      const lines = [
        `Saved albums by album_type (${albums.length} album(s)).`,
        ...histogramLines(entries),
      ];
      const payload: Record<string, unknown> = {
        total_albums: albums.length,
        types: entries.map(([album_type, count]) => ({ album_type, count })),
        scan_cap: walkCap(scan_cap),
      };
      return shapeResult(rf, lines.join('\n'), payload);
    },
  );

  // 4. artist_representation_census
  server.tool(
    'artist_representation_census',
    'Census of your saved tracks by credited artist: rank the top N artists by how many saved tracks they appear on. Read-only.',
    {
      response_format: ResponseFormat,
      max_results: MaxResults,
      top_n: TopN,
      scan_cap: ScanCap,
    },
    async ({ response_format, max_results, top_n, scan_cap }) => {
      const rf = response_format;
      const maxResults = resolveMaxResults(max_results, getConfig().maxItems);
      const n = top_n ?? 10;
      const tracks = await loadSavedTracks(client, walkCap(scan_cap));
      const counts = new Map<string, { name: string; tracks: number }>();
      for (const tr of tracks) {
        for (const a of tr.artists) {
          const key = a.id ?? `name:${normaliseName(a.name)}`;
          const cur = counts.get(key) ?? { name: a.name, tracks: 0 };
          cur.tracks++;
          counts.set(key, cur);
        }
      }
      const ranked = [...counts.entries()]
        .map(([key, v]) => ({ artist_id: key.startsWith('name:') ? null : key, artist: v.name, saved_tracks: v.tracks }))
        .sort((a, b) => b.saved_tracks - a.saved_tracks || a.artist.localeCompare(b.artist));
      const t = truncateItems(ranked, n);
      const lines = [
        `Artist representation census: ${counts.size} distinct artist(s) across ${tracks.length} saved track(s). Top ${t.returned}:`,
        ...t.items.map((r, i) => `  ${String(i + 1).padStart(2)}. ${r.artist} — ${r.saved_tracks} saved track(s)`),
        ...(t.footer ? [`(${t.footer})`] : []),
      ];
      const payload: Record<string, unknown> = {
        ...listStructuredContent(t.items, paginationInfo({ total: t.total, returned: t.returned })),
        distinct_artists: counts.size,
        total_saved_tracks: tracks.length,
        truncated: t.truncated,
      };
      return shapeResult(rf, lines.join('\n'), payload);
    },
  );

  // 5. orphaned_artist_check
  server.tool(
    'orphaned_artist_check',
    'Find asymmetries in your library: artists you saved tracks from but never saved an album of, and vice versa. Read-only.',
    {
      response_format: ResponseFormat,
      max_results: MaxResults,
      scan_cap: ScanCap,
      dry_run: DryRunScan,
    },
    async ({ response_format, max_results, scan_cap, dry_run }) => {
      const rf = response_format;
      const maxResults = resolveMaxResults(max_results, getConfig().maxItems);
      const cap = walkCap(scan_cap);
      if (dry_run) {
        const pages = Math.max(1, Math.ceil(cap / 50));
        return shapeResult(rf, `[dry run] orphaned_artist_check would walk /me/tracks + /me/albums (scan_cap=${cap}). Cost: ~${pages * 2} requests.`, {
          dry_run: true, scan_cap: cap, estimated_requests: pages * 2,
        });
      }
      const [tracks, albums] = await Promise.all([
        loadSavedTracks(client, cap),
        loadSavedAlbums(client, cap),
      ]);
      const trackArtists = new Map<string, string>();
      const albumArtists = new Map<string, string>();
      for (const tr of tracks) {
        for (const a of tr.artists) trackArtists.set(a.id ?? `name:${normaliseName(a.name)}`, a.name);
      }
      for (const al of albums) {
        for (const a of al.artists) albumArtists.set(a.id ?? `name:${normaliseName(a.name)}`, a.name);
      }
      const tracksOnly = [...trackArtists.entries()]
        .filter(([k]) => !albumArtists.has(k))
        .map(([id, name]) => ({ artist_id: id.startsWith('name:') ? null : id, artist: name }))
        .sort((a, b) => a.artist.localeCompare(b.artist));
      const albumsOnly = [...albumArtists.entries()]
        .filter(([k]) => !trackArtists.has(k))
        .map(([id, name]) => ({ artist_id: id.startsWith('name:') ? null : id, artist: name }))
        .sort((a, b) => a.artist.localeCompare(b.artist));
      const tT = truncateItems(tracksOnly, maxResults);
      const tA = truncateItems(albumsOnly, maxResults);
      const lines = [
        `Orphaned artist check: ${tracks.length} saved track(s) / ${albums.length} saved album(s).`,
        `Artists with saved tracks but ZERO saved albums: ${tT.total}`,
        ...tT.items.slice(0, Math.min(tT.items.length, 15)).map((r) => `  • ${r.artist}`),
        ...(tT.footer ? [`  (${tT.footer})`] : []),
        `Artists with saved albums but ZERO saved tracks: ${tA.total}`,
        ...tA.items.slice(0, Math.min(tA.items.length, 15)).map((r) => `  • ${r.artist}`),
        ...(tA.footer ? [`  (${tA.footer})`] : []),
      ];
      const payload: Record<string, unknown> = {
        total_saved_tracks: tracks.length,
        total_saved_albums: albums.length,
        track_only_artists: tracksOnly,
        album_only_artists: albumsOnly,
        truncated: tT.truncated || tA.truncated,
        scan_cap: cap,
      };
      return shapeResult(rf, lines.join('\n'), payload);
    },
  );

  // 6. saved_track_age_report
  server.tool(
    'saved_track_age_report',
    'Histogram of when you saved each liked track (added_at): age buckets plus a per-year add histogram. Read-only.',
    {
      response_format: ResponseFormat,
      max_results: MaxResults,
      scan_cap: ScanCap,
    },
    async ({ response_format, max_results, scan_cap }) => {
      const rf = response_format;
      const tracks = await loadSavedTracks(client, walkCap(scan_cap));
      const now = Date.now();
      const buckets: Array<[string, number]> = [
        ['< 7 days', 0], ['7–30 days', 0], ['30–90 days', 0], ['90–365 days', 0],
        ['1–2 years', 0], ['2–5 years', 0], ['5+ years', 0], ['(no date)', 0],
      ];
      const perYear = new Map<string, number>();
      let oldest: { added_at: string; name: string } | null = null;
      for (const tr of tracks) {
        const t = tr.added_at ? Date.parse(tr.added_at) : Number.NaN;
        if (Number.isNaN(t)) { buckets[7][1]++; continue; }
        const days = (now - t) / 86400000;
        if (days < 7) buckets[0][1]++;
        else if (days < 30) buckets[1][1]++;
        else if (days < 90) buckets[2][1]++;
        else if (days < 365) buckets[3][1]++;
        else if (days < 730) buckets[4][1]++;
        else if (days < 1825) buckets[5][1]++;
        else buckets[6][1]++;
        const y = new Date(t).getUTCFullYear();
        perYear.set(String(y), (perYear.get(String(y)) ?? 0) + 1);
        if (!oldest || t < Date.parse(oldest.added_at)) oldest = { added_at: tr.added_at, name: tr.name };
      }
      const yearEntries = [...perYear.entries()].sort((a, b) => a[0].localeCompare(b[0]));
      const lines = [
        `Saved-track age report (${tracks.length} track(s)).`,
        ...buckets.filter(([, n]) => n > 0).map(([label, n]) => `  ${label.padEnd(12)} ${String(n).padStart(6)}`),
        '',
        'Adds per year:',
        ...histogramLines(yearEntries),
        ...(oldest ? [`Oldest save: "${oldest.name}" added ${oldest.added_at.slice(0, 10)}`] : []),
      ];
      const payload: Record<string, unknown> = {
        total: tracks.length,
        age_buckets: buckets.map(([bucket, count]) => ({ bucket, count })),
        per_year: yearEntries.map(([year, count]) => ({ year, count })),
        oldest: oldest ?? null,
        scan_cap: walkCap(scan_cap),
      };
      return shapeResult(rf, lines.join('\n'), payload);
    },
  );

  // 7. added_on_this_day
  server.tool(
    'added_on_this_day',
    'Show tracks you saved on this calendar day (month + day) in previous years — your library "on this day". Read-only.',
    {
      response_format: ResponseFormat,
      max_results: MaxResults,
      scan_cap: ScanCap,
    },
    async ({ response_format, max_results, scan_cap }) => {
      const rf = response_format;
      const maxResults = resolveMaxResults(max_results, getConfig().maxItems);
      const now = new Date();
      const mmdd = `${String(now.getUTCMonth() + 1).padStart(2, '0')}-${String(now.getUTCDate()).padStart(2, '0')}`;
      const tracks = await loadSavedTracks(client, walkCap(scan_cap));
      const hits = tracks
        .filter((tr) => tr.added_at.slice(5, 10) === mmdd)
        .sort((a, b) => a.added_at.localeCompare(b.added_at));
      const byYear = tally(hits, (tr) => tr.added_at.slice(0, 4));
      const t = truncateItems(hits, maxResults);
      const lines = [
        `On this day (${mmdd}) across previous years: ${hits.length} saved track(s).`,
        ...t.items.map((tr) => `  • [${tr.added_at.slice(0, 4)}] ${tr.name} — ${artistNames(tr)}`),
        ...(t.footer ? [`(${t.footer})`] : []),
        ...(hits.length === 0 ? ['Nothing was saved on this day in previous years (within the walked window).'] : []),
      ];
      const payload: Record<string, unknown> = {
        ...listStructuredContent(
          t.items.map((tr) => ({ name: tr.name, artists: artistNames(tr), added_at: tr.added_at, uri: tr.uri })),
          paginationInfo({ total: t.total, returned: t.returned }),
        ),
        day_key: mmdd,
        per_year: [...byYear.entries()].sort(),
        truncated: t.truncated,
      };
      return shapeResult(rf, lines.join('\n'), payload);
    },
  );

  // 8. library_growth_timeline
  server.tool(
    'library_growth_timeline',
    'Show how fast your saved-track library grew: adds per month, busiest month, and your longest/current monthly add streaks. Read-only.',
    {
      response_format: ResponseFormat,
      max_results: MaxResults,
      scan_cap: ScanCap,
    },
    async ({ response_format, max_results, scan_cap }) => {
      const rf = response_format;
      const maxResults = resolveMaxResults(max_results, getConfig().maxItems);
      const tracks = await loadSavedTracks(client, walkCap(scan_cap));
      const perMonth = tally(tracks, (tr) => monthKeyOf(tr.added_at));
      const entries = [...perMonth.entries()].sort((a, b) => a[0].localeCompare(b[0]));
      const streaks = monthStreaks(entries.map(([k]) => k));
      const busiest = entries.reduce<[string, number] | null>((best, [k, n]) => (!best || n > best[1] ? [k, n] : best), null);
      const shown = entries.slice(-maxResults);
      const lines = [
        `Library growth: ${tracks.length} adds across ${entries.length} month(s).`,
        ...(busiest ? [`Busiest month: ${busiest[0]} (${busiest[1]} adds)`] : []),
        `Longest monthly add streak: ${streaks.longest} month(s)${streaks.longest_span ? ` (${streaks.longest_span[0]} → ${streaks.longest_span[1]})` : ''}.`,
        `Current streak: ${streaks.current} consecutive month(s) with at least one add.`,
        '',
        `Most recent ${shown.length} month(s):`,
        ...histogramLines(shown),
        ...(entries.length > shown.length ? [`(showing last ${shown.length} of ${entries.length} months — pass max_results to see more)`] : []),
      ];
      const payload: Record<string, unknown> = {
        total_adds: tracks.length,
        months_active: entries.length,
        per_month: entries.map(([month, count]) => ({ month, count })),
        busiest_month: busiest ? { month: busiest[0], adds: busiest[1] } : null,
        streaks: { longest: streaks.longest, longest_span: streaks.longest_span, current: streaks.current },
        truncated: entries.length > shown.length,
        scan_cap: walkCap(scan_cap),
      };
      return shapeResult(rf, lines.join('\n'), payload);
    },
  );

  // 9. duplicate_saved_versions
  server.tool(
    'duplicate_saved_versions',
    'Find songs you saved more than once from different albums (same normalised track name + primary artist, distinct album IDs). Read-only.',
    {
      response_format: ResponseFormat,
      max_results: MaxResults,
      scan_cap: ScanCap,
    },
    async ({ response_format, max_results, scan_cap }) => {
      const rf = response_format;
      const maxResults = resolveMaxResults(max_results, getConfig().maxItems);
      const tracks = await loadSavedTracks(client, walkCap(scan_cap));
      interface Version { album: string; album_id: string | null; added_at: string; uri: string }
      const groups = new Map<string, { name: string; artist: string; versions: Version[]; albumIds: Set<string> }>();
      for (const tr of tracks) {
        if (tr.is_local) continue;
        const key = `${normaliseName(tr.name)}|${normaliseName(primaryArtistName(tr))}`;
        const g = groups.get(key) ?? { name: tr.name, artist: primaryArtistName(tr), versions: [], albumIds: new Set<string>() };
        g.versions.push({ album: tr.album.name, album_id: tr.album.id, added_at: tr.added_at, uri: tr.uri });
        if (tr.album.id) g.albumIds.add(tr.album.id);
        else g.albumIds.add(`name:${normaliseName(tr.album.name)}`);
        groups.set(key, g);
      }
      const dupes = [...groups.values()]
        .filter((g) => g.albumIds.size >= 2)
        .sort((a, b) => b.versions.length - a.versions.length || a.name.localeCompare(b.name));
      const t = truncateItems(dupes, maxResults);
      const lines = [
        `Duplicate saved versions: ${dupes.length} song(s) saved from 2+ distinct albums (${tracks.length} saved track(s) walked).`,
        ...t.items.flatMap((g) => [
          `  • "${g.name}" — ${g.artist} (${g.versions.length} versions):`,
          ...g.versions.map((v) => `      - ${v.album} [added ${v.added_at.slice(0, 10)}] ${v.uri}`),
        ]),
        ...(t.footer ? [`(${t.footer})`] : []),
        ...(dupes.length === 0 ? ['No duplicate saved versions found — clean.'] : []),
      ];
      const payload: Record<string, unknown> = {
        ...listStructuredContent(
          t.items.map((g) => ({ name: g.name, artist: g.artist, versions: g.versions })),
          paginationInfo({ total: t.total, returned: t.returned }),
        ),
        duplicate_groups: dupes.length,
        total_saved_tracks: tracks.length,
        truncated: t.truncated,
      };
      return shapeResult(rf, lines.join('\n'), payload);
    },
  );

  // 10. album_edition_lint
  server.tool(
    'album_edition_lint',
    'Lint your saved albums for the same record kept across multiple editions (same name after edition-noise stripping + primary artist, distinct album IDs). Read-only.',
    {
      response_format: ResponseFormat,
      max_results: MaxResults,
      scan_cap: ScanCap,
    },
    async ({ response_format, max_results, scan_cap }) => {
      const rf = response_format;
      const maxResults = resolveMaxResults(max_results, getConfig().maxItems);
      const albums = await loadSavedAlbums(client, walkCap(scan_cap));
      const groups = new Map<string, { canonical: string; artist: string; editions: AlbumRow[]; ids: Set<string> }>();
      for (const al of albums) {
        const key = `${stripEditionNoise(al.name)}|${normaliseName(primaryArtistName(al))}`;
        const g = groups.get(key) ?? { canonical: al.name, artist: primaryArtistName(al), editions: [], ids: new Set<string>() };
        g.editions.push(al);
        if (al.id) g.ids.add(al.id);
        else g.ids.add(`name:${normaliseName(al.name)}`);
        groups.set(key, g);
      }
      const lints = [...groups.values()]
        .filter((g) => g.ids.size >= 2)
        .sort((a, b) => b.editions.length - a.editions.length || a.canonical.localeCompare(b.canonical));
      const t = truncateItems(lints, maxResults);
      const lines = [
        `Album edition lint: ${lints.length} record(s) saved across multiple editions (${albums.length} saved album(s) walked).`,
        ...t.items.flatMap((g) => [
          `  • "${g.canonical}" — ${g.artist} (${g.editions.length} editions):`,
          ...g.editions.map((e) => `      - ${e.name} [${e.album_type}, ${e.release_date ?? '?'}] ${e.uri}`),
        ]),
        ...(t.footer ? [`(${t.footer})`] : []),
        ...(lints.length === 0 ? ['No cross-edition duplicates found — clean.'] : []),
      ];
      const payload: Record<string, unknown> = {
        ...listStructuredContent(
          t.items.map((g) => ({
            canonical: g.canonical,
            artist: g.artist,
            editions: g.editions.map((e) => ({ id: e.id, name: e.name, album_type: e.album_type, release_date: e.release_date, uri: e.uri })),
          })),
          paginationInfo({ total: t.total, returned: t.returned }),
        ),
        lint_groups: lints.length,
        total_saved_albums: albums.length,
        truncated: t.truncated,
      };
      return shapeResult(rf, lines.join('\n'), payload);
    },
  );

  // 11. never_played_saved
  server.tool(
    'never_played_saved',
    'List saved tracks absent from your recently-played window. Honest bounds: recently-played only covers roughly your last 50 plays, so this is "not played lately", not "never played". Read-only.',
    {
      response_format: ResponseFormat,
      max_results: MaxResults,
      scan_cap: ScanCap,
      dry_run: DryRunScan,
    },
    async ({ response_format, max_results, scan_cap, dry_run }) => {
      const rf = response_format;
      const maxResults = resolveMaxResults(max_results, getConfig().maxItems);
      const cap = walkCap(scan_cap);
      if (dry_run) {
        const pages = Math.max(1, Math.ceil(cap / 50));
        return shapeResult(rf, `[dry run] never_played_saved would walk /me/tracks (scan_cap=${cap}) + one /me/player/recently-played call. Cost: ~${pages + 1} requests.`, {
          dry_run: true, scan_cap: cap, estimated_requests: pages + 1,
        });
      }
      const tracks = await loadSavedTracks(client, cap);
      const recent = await client.get<RecentlyPlayedShell>('/me/player/recently-played', { limit: '50' });
      const playedIds = new Set<string>();
      for (const it of recent?.items ?? []) {
        const id = it?.track?.id;
        if (id) playedIds.add(id);
      }
      const never = tracks.filter((tr) => tr.id && !playedIds.has(tr.id) && !tr.is_local);
      const t = truncateItems(never, maxResults);
      const lines = [
        `Saved tracks not in the recently-played window (${playedIds.size} distinct recently-played id(s), window ≈ last 50 plays): ${t.total} of ${tracks.length}.`,
        'Caveat: recently-played only reaches back a short play window — absence here means "not played recently", NOT "never played since you saved it".',
        ...t.items.map((tr) => `  • ${tr.name} — ${artistNames(tr)} [saved ${tr.added_at.slice(0, 10)}]`),
        ...(t.footer ? [`(${t.footer})`] : []),
      ];
      const payload: Record<string, unknown> = {
        ...listStructuredContent(
          t.items.map((tr) => ({ name: tr.name, artists: artistNames(tr), added_at: tr.added_at, uri: tr.uri })),
          paginationInfo({ total: t.total, returned: t.returned }),
        ),
        recently_played_ids: playedIds.size,
        total_saved_tracks: tracks.length,
        window_bounds_caveat: 'recently-played ≈ last 50 plays; results are bounded, not lifetime truth',
        truncated: t.truncated,
      };
      return shapeResult(rf, lines.join('\n'), payload);
    },
  );

  // 12. saved_vs_playlist_coverage
  server.tool(
    'saved_vs_playlist_coverage',
    'Report which of your saved tracks appear in none of your owned/followed playlists, with a coverage ratio. Read-only.',
    {
      response_format: ResponseFormat,
      max_results: MaxResults,
      scan_cap: ScanCap,
      dry_run: DryRunScan,
    },
    async ({ response_format, max_results, scan_cap, dry_run }) => {
      const rf = response_format;
      const maxResults = resolveMaxResults(max_results, getConfig().maxItems);
      const cap = walkCap(scan_cap);
      if (dry_run) {
        // Cost preview without any calls: playlist count unknown until walk, so estimate at scan_cap pages.
        const trackPages = Math.max(1, Math.ceil(cap / 50));
        const listPages = Math.max(1, Math.ceil(cap / 50));
        return shapeResult(rf, `[dry run] saved_vs_playlist_coverage would walk /me/tracks + /me/playlists + up to ${cap / 100} item page(s) per playlist (scan_cap=${cap}). Worst-case cost: ~${trackPages + listPages + cap / 100} requests.`, {
          dry_run: true, scan_cap: cap, estimated_requests_max: trackPages + listPages + cap / 100,
        });
      }
      const tracks = await loadSavedTracks(client, cap);
      const playlists = await client.getAllPages<SpotifyPlaylistSimple>('/me/playlists', { limit: '50' }, { maxItems: cap });
      const playlistTrackIds = new Set<string>();
      let quotaAt: string | null = null;
      for (const pl of playlists) {
        if (!pl?.id) continue;
        try {
          const items = await client.getAllPages<PlaylistItemObject>(
            `/playlists/${encodeURIComponent(pl.id)}/items`,
            { limit: '100' },
            { maxItems: cap },
          );
          for (const it of items) {
            const tr = (it as unknown as { track?: { id?: string } | null }).track;
            if (tr?.id) playlistTrackIds.add(tr.id);
          }
        } catch (e) {
          if (e instanceof SpotifyApiError && e.status === 429) {
            quotaAt = pl.id;
            break;
          }
          // Skip unreadable playlists; they cannot add coverage.
        }
      }
      const missing = tracks.filter((tr) => tr.id && !playlistTrackIds.has(tr.id) && !tr.is_local);
      const ratio = tracks.length === 0 ? 0 : 1 - missing.length / tracks.length;
      const t = truncateItems(missing, maxResults);
      const lines = [
        `Saved-vs-playlist coverage: ${(ratio * 100).toFixed(1)}% of ${tracks.length} saved track(s) appear in at least one of ${playlists.length} playlist(s).`,
        `Saved tracks in NO playlist: ${t.total}`,
        ...t.items.slice(0, 25).map((tr) => `  • ${tr.name} — ${artistNames(tr)}`),
        ...(t.footer ? [`(${t.footer})`] : []),
        ...(quotaAt ? [`Quota hit at playlist ${quotaAt} — partial coverage returned.`] : []),
      ];
      const payload: Record<string, unknown> = {
        ...listStructuredContent(
          t.items.map((tr) => ({ name: tr.name, artists: artistNames(tr), uri: tr.uri })),
          paginationInfo({ total: t.total, returned: t.returned }),
        ),
        coverage_ratio: ratio,
        total_saved_tracks: tracks.length,
        playlists_scanned: playlists.length,
        quota_hit_at_playlist: quotaAt,
        truncated: t.truncated,
      };
      return shapeResult(rf, lines.join('\n'), payload);
    },
  );

  // 13. artist_completeness_score
  server.tool(
    'artist_completeness_score',
    'For your top N saved-track artists, fetch each artist\u2019s top tracks and score how many of them you have saved (0–100%). Read-only, capped at 25 artists.',
    {
      response_format: ResponseFormat,
      max_results: MaxResults,
      top_n: z.number().int().min(1).max(25).optional().describe('How many top artists to score (default 10, max 25 — one request each)'),
      scan_cap: ScanCap,
      dry_run: DryRunScan,
    },
    async ({ response_format, max_results, top_n, scan_cap, dry_run }) => {
      const rf = response_format;
      const maxResults = resolveMaxResults(max_results, getConfig().maxItems);
      const n = top_n ?? 10;
      const cap = walkCap(scan_cap);
      if (dry_run) {
        return shapeResult(rf, `[dry run] artist_completeness_score would walk /me/tracks (scan_cap=${cap}) then call /artists/{id}/top-tracks × ${n}. Cost: ~${Math.max(1, Math.ceil(cap / 50)) + n} requests.`, {
          dry_run: true, scan_cap: cap, artists_to_score: n, estimated_requests: Math.max(1, Math.ceil(cap / 50)) + n,
        });
      }
      const tracks = await loadSavedTracks(client, cap);
      const counts = tally(tracks, (tr) => tr.artists[0]?.id ?? (tr.artists[0] ? `name:${normaliseName(tr.artists[0].name)}` : null));
      const top = [...counts.entries()]
        .filter(([k]) => !k.startsWith('name:'))
        .sort((a, b) => b[1] - a[1])
        .slice(0, n);
      const savedIds = new Set(tracks.map((tr) => tr.id).filter((id): id is string => id !== null));
      interface Score { artist_id: string; artist: string; saved_tracks: number; top_tracks_total: number; saved_top_tracks: number; completeness: number; missing_top: string[] }
      const scores: Score[] = [];
      let quotaHit = false;
      for (const [artistId, savedCount] of top) {
        if (quotaHit) break;
        try {
          const res = await client.get<{ tracks?: Array<{ id?: string; name?: string } | null> }>(
            `/artists/${encodeURIComponent(artistId)}/top-tracks`,
            {},
          );
          const topTracks = (res?.tracks ?? []).filter((x): x is { id: string; name: string } => typeof x?.id === 'string');
          const savedTop = topTracks.filter((x) => savedIds.has(x.id));
          const missing = topTracks.filter((x) => !savedIds.has(x.id)).map((x) => x.name);
          scores.push({
            artist_id: artistId,
            artist: tracks.find((tr) => tr.artists[0]?.id === artistId)?.artists[0]?.name ?? artistId,
            saved_tracks: savedCount,
            top_tracks_total: topTracks.length,
            saved_top_tracks: savedTop.length,
            completeness: topTracks.length === 0 ? 0 : savedTop.length / topTracks.length,
            missing_top: missing,
          });
        } catch (e) {
          if (e instanceof SpotifyApiError && e.status === 429) quotaHit = true;
        }
      }
      scores.sort((a, b) => a.completeness - b.completeness || b.saved_tracks - a.saved_tracks);
      const t = truncateItems(scores, maxResults);
      const avg = scores.length === 0 ? 0 : scores.reduce((a, s) => a + s.completeness, 0) / scores.length;
      const lines = [
        `Artist completeness (saved tracks vs artist top-tracks): avg ${(avg * 100).toFixed(0)}% across ${scores.length} artist(s).`,
        ...t.items.map((s) => `  • ${s.artist}: ${s.saved_top_tracks}/${s.top_tracks_total} top tracks saved (${(s.completeness * 100).toFixed(0)}%) — missing: ${s.missing_top.slice(0, 3).join('; ') || '—'}`),
        ...(t.footer ? [`(${t.footer})`] : []),
        ...(quotaHit ? [`Quota hit after ${scores.length}/${top.length} artist(s) — partial results.`] : []),
      ];
      const payload: Record<string, unknown> = {
        ...listStructuredContent(t.items, paginationInfo({ total: t.total, returned: t.returned })),
        average_completeness: avg,
        artists_scored: scores.length,
        quota_hit: quotaHit,
        truncated: t.truncated,
      };
      return shapeResult(rf, lines.join('\n'), payload);
    },
  );

  // 14. saved_runtime_by_era
  server.tool(
    'saved_runtime_by_era',
    'Total listening runtime of your saved tracks grouped by the release decade of each track\u2019s album. Read-only.',
    {
      response_format: ResponseFormat,
      max_results: MaxResults,
      scan_cap: ScanCap,
    },
    async ({ response_format, max_results, scan_cap }) => {
      const rf = response_format;
      const tracks = await loadSavedTracks(client, walkCap(scan_cap));
      const runtime = new Map<string, { ms: number; tracks: number }>();
      let noDate = { ms: 0, tracks: 0 };
      for (const tr of tracks) {
        const d = decadeOf(tr.album.release_date);
        const slot = d ?? null;
        if (slot === null) { noDate.ms += tr.duration_ms; noDate.tracks++; continue; }
        const cur = runtime.get(slot) ?? { ms: 0, tracks: 0 };
        cur.ms += tr.duration_ms;
        cur.tracks++;
        runtime.set(slot, cur);
      }
      const entries = [...runtime.entries()]
        .map(([decade, v]) => ({ decade, ...v }))
        .sort((a, b) => a.decade.localeCompare(b.decade));
      const totalMs = entries.reduce((a, e) => a + e.ms, 0) + noDate.ms;
      const lines = [
        `Saved runtime by release era: ${msToClock(totalMs)} total across ${tracks.length} track(s).`,
        ...entries.map((e) => `  ${e.decade.padEnd(8)} ${msToClock(e.ms).padStart(10)}  (${e.tracks} track(s), avg ${msToClock(e.tracks === 0 ? 0 : e.ms / e.tracks)})`),
        ...(noDate.tracks > 0 ? [`  (unknown) ${msToClock(noDate.ms).padStart(10)}  (${noDate.tracks} track(s), no release_date)`] : []),
      ];
      const payload: Record<string, unknown> = {
        total_runtime_ms: totalMs,
        eras: entries.map((e) => ({ decade: e.decade, runtime_ms: e.ms, tracks: e.tracks })),
        unknown_era: noDate,
        scan_cap: walkCap(scan_cap),
      };
      return shapeResult(rf, lines.join('\n'), payload);
    },
  );

  // 15. longest_saved_tracks
  server.tool(
    'longest_saved_tracks',
    'Rank your saved tracks by duration, longest first. Read-only.',
    {
      response_format: ResponseFormat,
      max_results: MaxResults,
      scan_cap: ScanCap,
    },
    async ({ response_format, max_results, scan_cap }) => {
      const rf = response_format;
      const maxResults = resolveMaxResults(max_results, getConfig().maxItems);
      const tracks = await loadSavedTracks(client, walkCap(scan_cap));
      const sorted = [...tracks].sort((a, b) => b.duration_ms - a.duration_ms);
      const t = truncateItems(sorted, maxResults);
      const lines = [
        `Longest saved tracks (of ${tracks.length}):`,
        ...t.items.map((tr, i) => `  ${String(i + 1).padStart(2)}. ${msToClock(tr.duration_ms)}  ${tr.name} — ${artistNames(tr)} [${tr.album.name}]`),
        ...(t.footer ? [`(${t.footer})`] : []),
      ];
      const payload: Record<string, unknown> = {
        ...listStructuredContent(
          t.items.map((tr) => ({ name: tr.name, artists: artistNames(tr), album: tr.album.name, duration_ms: tr.duration_ms, duration: msToClock(tr.duration_ms), uri: tr.uri })),
          paginationInfo({ total: t.total, returned: t.returned }),
        ),
        truncated: t.truncated,
      };
      return shapeResult(rf, lines.join('\n'), payload);
    },
  );

  // 16. shortest_saved_tracks
  server.tool(
    'shortest_saved_tracks',
    'Rank your saved tracks by duration, shortest first. Read-only.',
    {
      response_format: ResponseFormat,
      max_results: MaxResults,
      scan_cap: ScanCap,
    },
    async ({ response_format, max_results, scan_cap }) => {
      const rf = response_format;
      const maxResults = resolveMaxResults(max_results, getConfig().maxItems);
      const tracks = await loadSavedTracks(client, walkCap(scan_cap));
      const sorted = [...tracks].sort((a, b) => a.duration_ms - b.duration_ms);
      const t = truncateItems(sorted, maxResults);
      const lines = [
        `Shortest saved tracks (of ${tracks.length}):`,
        ...t.items.map((tr, i) => `  ${String(i + 1).padStart(2)}. ${msToClock(tr.duration_ms)}  ${tr.name} — ${artistNames(tr)} [${tr.album.name}]`),
        ...(t.footer ? [`(${t.footer})`] : []),
      ];
      const payload: Record<string, unknown> = {
        ...listStructuredContent(
          t.items.map((tr) => ({ name: tr.name, artists: artistNames(tr), album: tr.album.name, duration_ms: tr.duration_ms, duration: msToClock(tr.duration_ms), uri: tr.uri })),
          paginationInfo({ total: t.total, returned: t.returned }),
        ),
        truncated: t.truncated,
      };
      return shapeResult(rf, lines.join('\n'), payload);
    },
  );

  // 17. saved_albums_by_year
  server.tool(
    'saved_albums_by_year',
    'Histogram of your saved albums by release year. Read-only.',
    {
      response_format: ResponseFormat,
      max_results: MaxResults,
      scan_cap: ScanCap,
    },
    async ({ response_format, max_results, scan_cap }) => {
      const rf = response_format;
      const albums = await loadSavedAlbums(client, walkCap(scan_cap));
      const entries = [...tally(albums, (a) => (yearOf(a.release_date) !== null ? String(yearOf(a.release_date)) : null)).entries()]
        .sort((a, b) => a[0].localeCompare(b[0]));
      const unknown = albums.filter((a) => yearOf(a.release_date) === null).length;
      const lines = [
        `Saved albums by release year (${albums.length} album(s)).`,
        ...histogramLines(entries),
        ...(unknown > 0 ? [`  (unknown)   ${String(unknown).padStart(5)}`] : []),
      ];
      const payload: Record<string, unknown> = {
        total_albums: albums.length,
        per_year: entries.map(([year, count]) => ({ year, count })),
        unknown_year: unknown,
        scan_cap: walkCap(scan_cap),
      };
      return shapeResult(rf, lines.join('\n'), payload);
    },
  );

  // 18. collab_density_report
  server.tool(
    'collab_density_report',
    'Measure collaboration density: how many of your saved tracks credit 2+ artists, with the top collaborations ranked. Read-only.',
    {
      response_format: ResponseFormat,
      max_results: MaxResults,
      scan_cap: ScanCap,
    },
    async ({ response_format, max_results, scan_cap }) => {
      const rf = response_format;
      const maxResults = resolveMaxResults(max_results, getConfig().maxItems);
      const tracks = await loadSavedTracks(client, walkCap(scan_cap));
      const collabs = tracks.filter((tr) => tr.artists.length >= 2);
      const ratio = tracks.length === 0 ? 0 : collabs.length / tracks.length;
      const creditCounts = new Map<string, number>();
      for (const tr of collabs) {
        for (const a of tr.artists) creditCounts.set(a.name, (creditCounts.get(a.name) ?? 0) + 1);
      }
      const topCollaborators = sortedTally(creditCounts).slice(0, maxResults);
      const sorted = [...collabs].sort((a, b) => b.artists.length - a.artists.length);
      const t = truncateItems(sorted, maxResults);
      const lines = [
        `Collab density: ${collabs.length}/${tracks.length} saved track(s) (${(ratio * 100).toFixed(1)}%) credit 2+ artists.`,
        `Top collaborators: ${topCollaborators.slice(0, 5).map(([name, n]) => `${name} (${n})`).join(', ') || '—'}`,
        `Most-credited tracks:`,
        ...t.items.map((tr) => `  • [${tr.artists.length} artists] ${tr.name} — ${artistNames(tr)}`),
        ...(t.footer ? [`(${t.footer})`] : []),
      ];
      const payload: Record<string, unknown> = {
        collab_tracks: collabs.length,
        total_saved_tracks: tracks.length,
        collab_ratio: ratio,
        top_collaborators: topCollaborators.map(([name, count]) => ({ artist: name, credited_tracks: count })),
        most_credited_tracks: t.items.map((tr) => ({ name: tr.name, artists: artistNames(tr), credited_artists: tr.artists.length, uri: tr.uri })),
        truncated: t.truncated,
      };
      return shapeResult(rf, lines.join('\n'), payload);
    },
  );

  // 19. featuring_density_report
  server.tool(
    'featuring_density_report',
    'Measure how many of your saved track titles carry a "feat." / "featuring" marker, with examples ranked. Read-only.',
    {
      response_format: ResponseFormat,
      max_results: MaxResults,
      scan_cap: ScanCap,
    },
    async ({ response_format, max_results, scan_cap }) => {
      const rf = response_format;
      const maxResults = resolveMaxResults(max_results, getConfig().maxItems);
      const tracks = await loadSavedTracks(client, walkCap(scan_cap));
      const feats = tracks.filter((tr) => FEAT_RE.test(tr.name));
      const ratio = tracks.length === 0 ? 0 : feats.length / tracks.length;
      const t = truncateItems(feats, maxResults);
      const lines = [
        `Featuring density: ${feats.length}/${tracks.length} saved track(s) (${(ratio * 100).toFixed(1)}%) have "feat." in the title.`,
        ...t.items.map((tr) => `  • ${tr.name} — ${artistNames(tr)}`),
        ...(t.footer ? [`(${t.footer})`] : []),
      ];
      const payload: Record<string, unknown> = {
        ...listStructuredContent(
          t.items.map((tr) => ({ name: tr.name, artists: artistNames(tr), uri: tr.uri })),
          paginationInfo({ total: t.total, returned: t.returned }),
        ),
        feat_tracks: feats.length,
        total_saved_tracks: tracks.length,
        feat_ratio: ratio,
        truncated: t.truncated,
      };
      return shapeResult(rf, lines.join('\n'), payload);
    },
  );

  // 20. title_length_outliers
  server.tool(
    'title_length_outliers',
    'Statistical outliers in saved-track title length (characters): mean/median plus the longest and shortest titles. Read-only.',
    {
      response_format: ResponseFormat,
      max_results: MaxResults,
      scan_cap: ScanCap,
    },
    async ({ response_format, max_results, scan_cap }) => {
      const rf = response_format;
      const maxResults = resolveMaxResults(max_results, getConfig().maxItems);
      const tracks = await loadSavedTracks(client, walkCap(scan_cap));
      const lens = tracks.map((tr) => tr.name.length);
      const sortedByLen = [...tracks].sort((a, b) => b.name.length - a.name.length);
      const mean = lens.length === 0 ? 0 : lens.reduce((a, b) => a + b, 0) / lens.length;
      const sortedLens = [...lens].sort((a, b) => a - b);
      const median = sortedLens.length === 0 ? 0 : sortedLens[Math.floor(sortedLens.length / 2)];
      const longest = truncateItems(sortedByLen, maxResults);
      const shortest = [...sortedByLen].reverse().slice(0, Math.min(maxResults, 5));
      const lines = [
        `Title length: mean ${mean.toFixed(1)} chars, median ${median}, range ${sortedLens[0] ?? 0}–${sortedLens[sortedLens.length - 1] ?? 0} (${tracks.length} track(s)).`,
        `Longest titles:`,
        ...longest.items.slice(0, 10).map((tr) => `  • ${tr.name.length} chars: ${tr.name}`),
        ...(longest.footer ? [`  (${longest.footer})`] : []),
        `Shortest titles (5):`,
        ...shortest.map((tr) => `  • ${tr.name.length} chars: ${tr.name}`),
      ];
      const payload: Record<string, unknown> = {
        count: tracks.length,
        mean_chars: mean,
        median_chars: median,
        min_chars: sortedLens[0] ?? 0,
        max_chars: sortedLens[sortedLens.length - 1] ?? 0,
        longest: longest.items.slice(0, 10).map((tr) => ({ name: tr.name, chars: tr.name.length, uri: tr.uri })),
        shortest: shortest.map((tr) => ({ name: tr.name, chars: tr.name.length, uri: tr.uri })),
        truncated: longest.truncated,
      };
      return shapeResult(rf, lines.join('\n'), payload);
    },
  );

  // 21. explicit_content_ratio
  server.tool(
    'explicit_content_ratio',
    'Share of your saved tracks flagged explicit, with the top explicit artists. Read-only.',
    {
      response_format: ResponseFormat,
      max_results: MaxResults,
      scan_cap: ScanCap,
    },
    async ({ response_format, max_results, scan_cap }) => {
      const rf = response_format;
      const maxResults = resolveMaxResults(max_results, getConfig().maxItems);
      const tracks = await loadSavedTracks(client, walkCap(scan_cap));
      const explicitTracks = tracks.filter((tr) => tr.explicit);
      const ratio = tracks.length === 0 ? 0 : explicitTracks.length / tracks.length;
      const perArtist = tally(explicitTracks, (tr) => (tr.artists[0] ? tr.artists[0].name : null));
      const top = sortedTally(perArtist).slice(0, maxResults);
      const lines = [
        `Explicit content ratio: ${explicitTracks.length}/${tracks.length} saved track(s) are explicit (${(ratio * 100).toFixed(1)}%).`,
        `Top explicit artists:`,
        ...top.map(([name, n]) => `  • ${name}: ${n} explicit track(s)`),
      ];
      const payload: Record<string, unknown> = {
        explicit_tracks: explicitTracks.length,
        total_saved_tracks: tracks.length,
        explicit_ratio: ratio,
        top_explicit_artists: top.map(([artist, count]) => ({ artist, explicit_tracks: count })),
      };
      return shapeResult(rf, lines.join('\n'), payload);
    },
  );

  // 22. is_local_census
  server.tool(
    'is_local_census',
    'Count your saved tracks flagged as local files (is_local true) and list them — these often fail to play on other devices. Read-only.',
    {
      response_format: ResponseFormat,
      max_results: MaxResults,
      scan_cap: ScanCap,
    },
    async ({ response_format, max_results, scan_cap }) => {
      const rf = response_format;
      const maxResults = resolveMaxResults(max_results, getConfig().maxItems);
      const tracks = await loadSavedTracks(client, walkCap(scan_cap));
      const locals = tracks.filter((tr) => tr.is_local);
      const t = truncateItems(locals, maxResults);
      const lines = [
        `Local-file census: ${locals.length}/${tracks.length} saved track(s) flagged is_local.`,
        ...(locals.length > 0 ? ['Note: local files are device-bound and usually unplayable elsewhere.'] : []),
        ...t.items.map((tr) => `  • ${tr.name} — ${artistNames(tr)} ${tr.uri}`),
        ...(t.footer ? [`(${t.footer})`] : []),
      ];
      const payload: Record<string, unknown> = {
        ...listStructuredContent(
          t.items.map((tr) => ({ name: tr.name, artists: artistNames(tr), uri: tr.uri, added_at: tr.added_at })),
          paginationInfo({ total: t.total, returned: t.returned }),
        ),
        local_count: locals.length,
        total_saved_tracks: tracks.length,
        truncated: t.truncated,
      };
      return shapeResult(rf, lines.join('\n'), payload);
    },
  );

  // 23. unplayable_saved_check
  server.tool(
    'unplayable_saved_check',
    'Audit your saved library for tracks the API marks unplayable (is_playable false or a restrictions block) and show why. Read-only.',
    {
      response_format: ResponseFormat,
      max_results: MaxResults,
      scan_cap: ScanCap,
    },
    async ({ response_format, max_results, scan_cap }) => {
      const rf = response_format;
      const maxResults = resolveMaxResults(max_results, getConfig().maxItems);
      const tracks = await loadSavedTracks(client, walkCap(scan_cap));
      const unplayable = tracks.filter((tr) => tr.is_playable === false || tr.restriction_reason !== null);
      const t = truncateItems(unplayable, maxResults);
      const byReason = tally(unplayable, (tr) => tr.restriction_reason ?? (tr.is_playable === false ? 'is_playable=false' : null));
      const lines = [
        `Unplayable saved tracks: ${unplayable.length}/${tracks.length}.`,
        ...sortedTally(byReason).map(([reason, n]) => `  • ${reason}: ${n}`),
        ...t.items.map((tr) => `  • ${tr.name} — ${artistNames(tr)} [${tr.restriction_reason ?? 'is_playable=false'}] ${tr.uri}`),
        ...(t.footer ? [`(${t.footer})`] : []),
        ...(unplayable.length === 0 ? ['No unplayable saved tracks detected in the walked window.'] : []),
      ];
      const payload: Record<string, unknown> = {
        ...listStructuredContent(
          t.items.map((tr) => ({ name: tr.name, artists: artistNames(tr), reason: tr.restriction_reason ?? 'is_playable=false', uri: tr.uri })),
          paginationInfo({ total: t.total, returned: t.returned }),
        ),
        unplayable_count: unplayable.length,
        total_saved_tracks: tracks.length,
        by_reason: Object.fromEntries(sortedTally(byReason)),
        truncated: t.truncated,
      };
      return shapeResult(rf, lines.join('\n'), payload);
    },
  );

  // 24. library_value_summary
  server.tool(
    'library_value_summary',
    'One mega-report over your saved library: totals, runtime, explicit/local/unplayable counts, collab + featuring density, growth streaks, era histogram, duplicate-version and edition-lint counts, and top artists. Read-only.',
    {
      response_format: ResponseFormat,
      max_results: MaxResults,
      scan_cap: ScanCap,
      dry_run: DryRunScan,
    },
    async ({ response_format, max_results, scan_cap, dry_run }) => {
      const rf = response_format;
      const maxResults = resolveMaxResults(max_results, getConfig().maxItems);
      const cap = walkCap(scan_cap);
      if (dry_run) {
        const pages = Math.max(1, Math.ceil(cap / 50));
        return shapeResult(rf, `[dry run] library_value_summary would walk /me/tracks + /me/albums (scan_cap=${cap}). Cost: ~${pages * 2} requests.`, {
          dry_run: true, scan_cap: cap, estimated_requests: pages * 2,
        });
      }
      const [tracks, albums] = await Promise.all([
        loadSavedTracks(client, cap),
        loadSavedAlbums(client, cap),
      ]);

      const totalMs = tracks.reduce((a, tr) => a + tr.duration_ms, 0);
      const explicitTracks = tracks.filter((tr) => tr.explicit);
      const locals = tracks.filter((tr) => tr.is_local);
      const unplayable = tracks.filter((tr) => tr.is_playable === false || tr.restriction_reason !== null);
      const collabs = tracks.filter((tr) => tr.artists.length >= 2);
      const feats = tracks.filter((tr) => FEAT_RE.test(tr.name));
      const artistCounts = tally(tracks, (tr) => (tr.artists[0] ? tr.artists[0].name : null));
      const topArtists = sortedTally(artistCounts).slice(0, Math.min(5, maxResults));

      const perMonth = tally(tracks, (tr) => monthKeyOf(tr.added_at));
      const streaks = monthStreaks([...perMonth.keys()]);
      const busiest = [...perMonth.entries()].sort((a, b) => b[1] - a[1])[0] ?? null;

      const eraRuntime = new Map<string, number>();
      for (const tr of tracks) {
        const d = decadeOf(tr.album.release_date);
        if (d) eraRuntime.set(d, (eraRuntime.get(d) ?? 0) + tr.duration_ms);
      }
      const eras = [...eraRuntime.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3);

      const albumDecades = sortedTally(tally(albums, (a) => decadeOf(a.release_date))).slice(0, 3);

      // duplicate versions + edition lint counts (pure, no extra API calls)
      const versionGroups = new Map<string, Set<string>>();
      for (const tr of tracks) {
        const key = `${normaliseName(tr.name)}|${normaliseName(primaryArtistName(tr))}`;
        const set = versionGroups.get(key) ?? new Set<string>();
        set.add(tr.album.id ?? `name:${normaliseName(tr.album.name)}`);
        versionGroups.set(key, set);
      }
      const duplicateVersionGroups = [...versionGroups.values()].filter((s) => s.size >= 2).length;

      const editionGroups = new Map<string, Set<string>>();
      for (const al of albums) {
        const key = `${stripEditionNoise(al.name)}|${normaliseName(primaryArtistName(al))}`;
        const set = editionGroups.get(key) ?? new Set<string>();
        set.add(al.id ?? `name:${normaliseName(al.name)}`);
        editionGroups.set(key, set);
      }
      const editionLintGroups = [...editionGroups.values()].filter((s) => s.size >= 2).length;

      const lens = tracks.map((tr) => tr.name.length);
      const longestTrack = [...tracks].sort((a, b) => b.duration_ms - a.duration_ms)[0] ?? null;
      const shortestTrack = [...tracks].sort((a, b) => a.duration_ms - b.duration_ms)[0] ?? null;

      const lines = [
        `LIBRARY VALUE SUMMARY — ${tracks.length} saved track(s) across ${albums.length} saved album(s) (scan_cap=${cap}).`,
        `Total runtime: ${msToClock(totalMs)}; mean title length ${lens.length === 0 ? 0 : (lens.reduce((a, b) => a + b, 0) / lens.length).toFixed(1)} chars.`,
        `Content flags: explicit ${(explicitTracks.length / Math.max(1, tracks.length) * 100).toFixed(1)}% (${explicitTracks.length}), local files ${locals.length}, unplayable ${unplayable.length}.`,
        `Collabs: ${(collabs.length / Math.max(1, tracks.length) * 100).toFixed(1)}% multi-artist; featuring-in-title ${(feats.length / Math.max(1, tracks.length) * 100).toFixed(1)}%.`,
        `Top artists: ${topArtists.map(([a, n]) => `${a} (${n})`).join(', ') || '—'}.`,
        `Growth: busiest month ${busiest ? `${busiest[0]} (${busiest[1]} adds)` : '—'}; longest monthly streak ${streaks.longest}; current streak ${streaks.current}.`,
        `Eras by runtime: ${eras.map(([d, ms]) => `${d} ${msToClock(ms)}`).join(', ') || '—'}.`,
        `Albums: top decades ${albumDecades.map(([d, n]) => `${d} (${n})`).join(', ') || '—'}.`,
        `Hygiene: ${duplicateVersionGroups} duplicate-version group(s), ${editionLintGroups} cross-edition album group(s).`,
        longestTrack ? `Longest saved track: ${msToClock(longestTrack.duration_ms)} — ${longestTrack.name}.` : '',
        shortestTrack ? `Shortest saved track: ${msToClock(shortestTrack.duration_ms)} — ${shortestTrack.name}.` : '',
      ].filter(Boolean);

      const payload: Record<string, unknown> = {
        total_saved_tracks: tracks.length,
        total_saved_albums: albums.length,
        total_runtime_ms: totalMs,
        explicit: { count: explicitTracks.length, ratio: tracks.length === 0 ? 0 : explicitTracks.length / tracks.length },
        local_files: locals.length,
        unplayable: unplayable.length,
        collab: { tracks: collabs.length, ratio: tracks.length === 0 ? 0 : collabs.length / tracks.length },
        featuring: { tracks: feats.length, ratio: tracks.length === 0 ? 0 : feats.length / tracks.length },
        top_artists: topArtists.map(([artist, count]) => ({ artist, saved_tracks: count })),
        growth: {
          busiest_month: busiest ? { month: busiest[0], adds: busiest[1] } : null,
          longest_streak_months: streaks.longest,
          current_streak_months: streaks.current,
        },
        eras_by_runtime: eras.map(([decade, ms]) => ({ decade, runtime_ms: ms })),
        top_album_decades: albumDecades.map(([decade, count]) => ({ decade, count })),
        hygiene: { duplicate_version_groups: duplicateVersionGroups, edition_lint_groups: editionLintGroups },
        longest_track: longestTrack ? { name: longestTrack.name, duration_ms: longestTrack.duration_ms } : null,
        shortest_track: shortestTrack ? { name: shortestTrack.name, duration_ms: shortestTrack.duration_ms } : null,
        scan_cap: cap,
      };
      return shapeResult(rf, lines.join('\n'), payload);
    },
  );
}
