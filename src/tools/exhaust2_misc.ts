/**
 * exhaust2 misc slice — feature swarm v1.24.0.
 *
 * Owned by the fix/exhaust2-misc builder. All tools in this slice are
 * registered here and nowhere else. Slice issue set: GitHub issues #401-#427.
 *
 * Conventions (repo-wide):
 *   - Shared shaping helpers from ../shaping.ts (ResponseFormat/MaxResults/
 *     resolveMaxResults/truncateItems) — never hand-rolled.
 *   - Mutating tools default dry_run=true and return an explicit PLAN.
 *   - Phantom endpoints are never faked: honest workarounds carry an explicit
 *     disclosure line in their description.
 *   - No deprecated endpoints (SPEC §9). Gated surfaces fail gracefully.
 *
 * Sidecar state owned by this slice lives in ~/.spotify-mcp/exhaust2-misc.json
 * (override with SPOTIFY_MCP_EXHAUST2_MISC_FILE): taste checkpoints, chapter
 * bookmarks, listening journal, archived monthly reports. Owner-only modes.
 */
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import type { SpotifyClient } from '../client.js';
import { SpotifyApiError } from '../client.js';
import {
  ResponseFormat,
  MaxResults,
  DryRun,
  resolveMaxResults,
  truncateItems,
  describeDryRun,
} from '../shaping.js';
import type { ResponseFormatValue } from '../shaping.js';
import type { PlaybackState } from '../types/spotify.js';
import { getConfig } from '../config.js';
import { loadTokens } from '../auth.js';
import { WRITE_SCOPE_REQUIREMENTS, moduleBlockedByScopes, scopesFor } from '../scopefilter.js';
import { loadScenes, scenesFilePath } from './scenes.js';
import { loadPlaybackExt, playbackExtFile } from './playbackext.js';
import { genreTagsPath, loadGenreTags } from './libraryinsights.js';
import { historyFilePath, isHistoryEnabled } from '../history.js';
import { verifyReceipt, getAllReceipts } from '../receipts.js';

// ---------------------------------------------------------------------------
// Shared shapes + result helpers
// ---------------------------------------------------------------------------

type TextContent = { type: 'text'; text: string };
type ToolResult = { content: TextContent[]; structuredContent?: Record<string, unknown> };

function textResult(text: string, structured?: Record<string, unknown>): ToolResult {
  return { content: [{ type: 'text', text }], ...(structured ? { structuredContent: structured } : {}) };
}

/** Prose or JSON body; structuredContent is always attached (#52). */
function emit(
  fmt: ResponseFormatValue | string | undefined,
  prose: string,
  payload: Record<string, unknown>,
): ToolResult {
  if (fmt === 'json') {
    return { content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }], structuredContent: payload };
  }
  return { content: [{ type: 'text', text: prose }], structuredContent: payload };
}

const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;
const AVG_TRACK_MS = 210_000; // fallback when duration is unknown
const SESSION_GAP_MS = 30 * 60_000; // listening-session gap detection

function ts(d: number | string): number {
  const t = typeof d === 'number' ? d : Date.parse(d);
  return Number.isFinite(t) ? t : NaN;
}

function isoDay(d: number): string {
  return new Date(d).toISOString().slice(0, 10);
}

/** Bounds for a YYYY-MM calendar month (default: previous full month). */
export function monthBounds(month?: string): { start: number; end: number; label: string } {
  if (month && /^\d{4}-\d{2}$/.test(month)) {
    const [y, m] = month.split('-').map(Number);
    const start = Date.UTC(y, m - 1, 1);
    return { start, end: Date.UTC(y, m, 1), label: month };
  }
  const now = new Date();
  const start = Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1);
  return { start, end: Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1), label: isoDay(start).slice(0, 7) };
}

/** Count listening sessions (plays clustered with gaps > 30 min). */
export function countSessions(playedAt: readonly string[]): number {
  const sorted = playedAt.map((p) => ts(p)).filter((t) => Number.isFinite(t)).sort((a, b) => a - b);
  let sessions = sorted.length > 0 ? 1 : 0;
  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i]! - sorted[i - 1]! > SESSION_GAP_MS) sessions++;
  }
  return sessions;
}

function playDate(item: { played_at?: string }): number {
  return ts(item.played_at ?? '');
}

/** Cursor-walk recently-played between two epoch bounds (after inclusive, before exclusive). */
export async function loadPlaysBetween(
  client: SpotifyClient,
  afterMs: number,
  beforeMs: number,
  maxItems = 1000,
): Promise<Array<{ played_at: string; track: { uri: string; name?: string; duration_ms?: number; artists?: Array<{ name: string }> } }>> {
  const out: Array<{ played_at: string; track: { uri: string; name?: string; duration_ms?: number; artists?: Array<{ name: string }> } }> = [];
  let before = String(beforeMs);
  const cap = Math.min(maxItems, getConfig().fetchAllCap);
  while (out.length < cap) {
    const page = await client.get<{ items: Array<{ played_at: string; track: { uri: string; name?: string; duration_ms?: number; artists?: Array<{ name: string }> } }>; next?: string | null }>(
      '/me/player/recently-played',
      { limit: '50', before },
    );
    if (!page || !Array.isArray(page.items) || page.items.length === 0) break;
    for (const row of page.items) {
      const t = playDate(row);
      if (!Number.isFinite(t)) continue;
      if (t < afterMs) return out;
      if (t < beforeMs) out.push({ played_at: row.played_at, track: row.track });
    }
    before = String(playDate(page.items[page.items.length - 1]!));
    if (page.next == null) break;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Slice sidecar (~/.spotify-mcp/exhaust2-misc.json)
// ---------------------------------------------------------------------------

export interface TasteCheckpoint {
  label: string;
  saved_at: string;
  time_range: string;
  artists: Array<{ name: string; genres: string[] }>;
  tracks: Array<{ name: string; artist_names: string[]; uri: string }>;
}

export interface ChapterBookmark {
  book_uri: string;
  label: string;
  position_ms: number;
  chapter_name?: string;
  created_at: string;
}

export interface JournalEntry {
  ts: string;
  note: string;
  session?: string;
  tag?: string;
}

export interface MiscStore {
  checkpoints: Record<string, TasteCheckpoint>;
  bookmarks: Record<string, ChapterBookmark[]>;
  journal: JournalEntry[];
  reports: Record<string, unknown>;
}

export function miscFilePath(env: NodeJS.ProcessEnv = process.env): string {
  return env.SPOTIFY_MCP_EXHAUST2_MISC_FILE ?? join(homedir(), '.spotify-mcp', 'exhaust2-misc.json');
}

/** Load the slice sidecar; missing/corrupt file yields an empty store. */
export async function loadMiscStore(env: NodeJS.ProcessEnv = process.env): Promise<MiscStore> {
  try {
    const raw = await readFile(miscFilePath(env), 'utf8');
    const p = JSON.parse(raw) as Partial<MiscStore>;
    if (!p || typeof p !== 'object') throw new Error('bad');
    return {
      checkpoints: p.checkpoints ?? {},
      bookmarks: p.bookmarks ?? {},
      journal: p.journal ?? [],
      reports: p.reports ?? {},
    };
  } catch {
    return { checkpoints: {}, bookmarks: {}, journal: [], reports: {} };
  }
}

/** Persist the slice sidecar: owner-only dir and file modes. */
export async function saveMiscStore(store: MiscStore, env: NodeJS.ProcessEnv = process.env): Promise<void> {
  const file = miscFilePath(env);
  await mkdir(dirname(file), { recursive: true, mode: 0o700 });
  await writeFile(file, `${JSON.stringify(store, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
}

// ---------------------------------------------------------------------------
// Small API helpers
// ---------------------------------------------------------------------------

type PlaylistRow = { item?: { uri?: string; type?: string; name?: string; artists?: Array<{ name: string }>; album?: { name?: string; release_date?: string }; duration_ms?: number } | null; added_at?: string; added_by?: { id?: string } | null };

async function findPlaylistByName(client: SpotifyClient, name: string): Promise<{ id: string; name: string } | null> {
  const lists = await client.getAllPages<{ id: string; name: string; owner?: { id?: string } }>('/me/playlists', { limit: '50' });
  const found = lists.find((p) => p?.name?.toLowerCase() === name.toLowerCase());
  return found ? { id: found.id, name: found.name } : null;
}

/** Unified library save/remove (chunked, 40 URIs per call like save_to_library). */
export async function modifyLibrary(client: SpotifyClient, uris: readonly string[], op: 'save' | 'remove'): Promise<number> {
  let n = 0;
  for (let i = 0; i < uris.length; i += 40) {
    const chunk = uris.slice(i, i + 40).join(',');
    if (op === 'save') await client.put(`/me/library?uris=${encodeURIComponent(chunk)}`);
    else await client.delete(`/me/library?uris=${encodeURIComponent(chunk)}`);
    n += Math.min(40, uris.length - i);
  }
  return n;
}

/** Followed artists via the cursor-paged /me/following endpoint. */
export async function loadFollowedArtists(client: SpotifyClient, max = 200): Promise<Array<{ id: string; name: string; genres: string[] }>> {
  const out: Array<{ id: string; name: string; genres: string[] }> = [];
  let after: string | undefined;
  while (out.length < max) {
    const params: Record<string, string> = { type: 'artist', limit: '50' };
    if (after) params.after = after;
    const page = await client.get<{ artists?: { items?: Array<{ id: string; name: string; genres?: string[] }>; cursors?: { after?: string } | null; next?: string | null } }>(
      '/me/following',
      params,
    );
    const items = page?.artists?.items ?? [];
    if (items.length === 0) break;
    for (const a of items) out.push({ id: a.id, name: a.name, genres: a.genres ?? [] });
    if (!page?.artists?.next || !page.artists.cursors?.after) break;
    after = page.artists.cursors.after;
  }
  return out.slice(0, max);
}

/** Ordered, deduped track plays (most recent first). */
function dedupePlays(plays: Array<{ played_at: string; track: { uri: string; name?: string; duration_ms?: number; artists?: Array<{ name: string }> } }>): typeof plays {
  const seen = new Set<string>();
  const out: typeof plays = [];
  for (const p of plays) {
    if (!p.track?.uri || seen.has(p.track.uri)) continue;
    seen.add(p.track.uri);
    out.push(p);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

export function registerExhaust2MiscTools(server: McpServer, client: SpotifyClient): void {
  // -----------------------------------------------------------------------
  // #401 quick_save_now — one-call "like this song"
  // -----------------------------------------------------------------------
  server.tool(
    'quick_save_now',
    'One-call "like this song": saves the currently-playing track (or the last `recent` '
      + 'recently-played tracks) straight to your library. Collapses get_currently_playing → '
      + 'save_to_library into a single step. 1 player read + 1 library write. dry_run previews.',
    {
      recent: z.number().int().min(1).max(40).optional().default(1)
        .describe('Save the N most recent plays (only used as fallback when nothing is currently playing). Default 1.'),
      market: z.string().optional().describe('ISO-3166 market code passed on the player read'),
      dry_run: z.boolean().optional().default(true)
        .describe('Preview the save plan without writing (default true)'),
      response_format: ResponseFormat,
    },
    async (args) => {
      const rf = args.response_format as ResponseFormatValue;
      const params: Record<string, string> = {};
      if (args.market) params.market = args.market;
      const now = await client.get<PlaybackState>('/me/player', params);
      let source: 'current' | 'recent' = 'current';
      let picks: Array<{ uri: string; name?: string }> = [];
      if (now?.item && 'uri' in now.item && (now.item as { uri?: string }).uri) {
        picks = [{ uri: (now.item as { uri: string }).uri, name: (now.item as { name?: string }).name }];
      } else {
        source = 'recent';
        const recents = await client.get<{ items: Array<{ played_at: string; track: { uri: string; name?: string } }> }>(
          '/me/player/recently-played',
          { limit: String(args.recent) },
        );
        picks = (recents?.items ?? []).map((r) => ({ uri: r.track.uri, name: r.track.name })).slice(0, args.recent);
      }
      const uris = [...new Set(picks.map((p) => p.uri))];
      const plan = `Save to library: ${picks.map((p) => `${p.name ?? 'unknown'} (${p.uri})`).join(', ') || 'nothing'}`;
      if (args.dry_run || uris.length === 0) {
        return emit(rf, `[dry run] quick_save_now (${source}) — nothing was changed.\n${plan}`, {
          ok: uris.length > 0, dry_run: true, source, uris,
          ...(uris.length === 0 ? { hint: 'Nothing currently playing and no recent plays found.' } : {}),
        });
      }
      await modifyLibrary(client, uris, 'save');
      return emit(rf, `Saved ${uris.length} track${uris.length === 1 ? '' : 's'} to library (${source}):\n${picks.map((p) => `  • ${p.name ?? p.uri}`).join('\n')}`, {
        ok: true, source, saved: uris, count: uris.length,
      });
    },
  );

  // -----------------------------------------------------------------------
  // #402 morning_briefing — daily digest
  // -----------------------------------------------------------------------
  server.tool(
    'morning_briefing',
    'Daily digest in one call: new releases from followed artists + new episodes from saved '
      + 'shows + per-show backlog + today\'s listening so far. Superset of whats_new + '
      + 'show_new_episodes. Quota: roughly 2 + artists + shows reads (budgeted).',
    {
      since_hours: z.number().int().min(1).max(24 * 30).optional().default(24)
        .describe('Lookback window for new releases/episodes. Default 24h.'),
      include_listening: z.boolean().optional().default(true)
        .describe('Include today\'s listening so far (adds 1 recently-played read)'),
      max_artists: z.number().int().min(1).max(200).optional().default(20)
        .describe('Budget for followed-artist album lookups. Default 20.'),
      max_shows: z.number().int().min(1).max(200).optional().default(20)
        .describe('Budget for per-show episode lookups. Default 20.'),
      response_format: ResponseFormat,
    },
    async (args) => {
      const rf = args.response_format as ResponseFormatValue;
      const since = Date.now() - args.since_hours * HOUR_MS;
      const artists = await loadFollowedArtists(client, args.max_artists);
      const freshAlbums: Array<{ artist: string; album: string; release_date: string }> = [];
      for (const a of artists.slice(0, args.max_artists)) {
        // NOTE: /artists/{id}/albums currently rejects limit > 10 with 400
        // (live-observed 2026-08-27) — page at 10 instead of 20.
        const page = await client.get<{ items?: Array<{ name?: string; release_date?: string; artists?: Array<{ name: string }> }> }>(
          `/artists/${encodeURIComponent(a.id)}/albums`,
          { include_groups: 'album,single', limit: '10' },
        );
        for (const alb of page?.items ?? []) {
          const rd = alb.release_date ?? '';
          if (rd && Date.parse(rd) >= since) freshAlbums.push({ artist: a.name, album: alb.name ?? 'unknown', release_date: rd });
        }
      }
      const shows = await client.getAllPages<{ show?: { name?: string; total_episodes?: number }; total?: number }>('/me/shows', { limit: '50' }, { maxItems: args.max_shows });
      const newEpisodes: Array<{ show: string; episode: string; released: string }> = [];
      const backlog: Array<{ show: string; total_episodes: number | null }> = [];
      for (const row of shows.slice(0, args.max_shows)) {
        const show = row.show;
        if (!show) continue;
        backlog.push({ show: show.name ?? 'unknown', total_episodes: row.total ?? null });
        let ep: { items?: Array<{ name?: string; release_date?: string; resume_point?: { fully_played?: boolean } }> } | null;
        try {
          ep = await client.get<{ items?: Array<{ name?: string; release_date?: string; resume_point?: { fully_played?: boolean } }> }>(
            `/shows/${encodeURIComponent(String((show as unknown as { id?: string }).id ?? ''))}/episodes`,
            { limit: '10' },
          );
        } catch (e) {
          // A throttled/gated show must not kill the whole briefing — skip it.
          if (e instanceof SpotifyApiError && (e.status === 429 || e.status === 403)) continue;
          throw e;
        }
        for (const e of ep?.items ?? []) {
          const rd = e.release_date ?? '';
          if (rd && Date.parse(rd) >= since && !e.resume_point?.fully_played) {
            newEpisodes.push({ show: show.name ?? 'unknown', episode: e.name ?? 'unknown', released: rd });
          }
        }
      }
      let listening: { plays: number; minutes: number; sessions: number } | null = null;
      if (args.include_listening) {
        const dayStart = new Date(); dayStart.setHours(0, 0, 0, 0);
        const plays = await loadPlaysBetween(client, dayStart.getTime(), Date.now());
        listening = {
          plays: plays.length,
          minutes: Math.round(plays.reduce((n, p) => n + (p.track.duration_ms ?? AVG_TRACK_MS), 0) / 60_000),
          sessions: countSessions(plays.map((p) => p.played_at)),
        };
      }
      const lines: string[] = [`Morning briefing (last ${args.since_hours}h):`, ''];
      lines.push(`New releases from ${artists.length} followed artist(s): ${freshAlbums.length === 0 ? 'none' : ''}`);
      for (const a of freshAlbums) lines.push(`  • ${a.artist} — ${a.album} (${a.release_date})`);
      lines.push('', `New podcast episodes: ${newEpisodes.length === 0 ? 'none' : ''}`);
      for (const e of newEpisodes) lines.push(`  • [${e.show}] ${e.episode} (${e.released})`);
      lines.push('', `Show backlog: ${backlog.map((b) => `${b.show}: ${b.total_episodes ?? '?'} eps`).join(' · ') || 'no saved shows'}`);
      if (listening) lines.push('', `Today so far: ${listening.plays} plays, ~${listening.minutes} min, ${listening.sessions} session(s).`);
      return emit(rf, lines.join('\n'), {
        ok: true, since_hours: args.since_hours, new_releases: freshAlbums, new_episodes: newEpisodes,
        show_backlog: backlog, listening, budgets: { max_artists: args.max_artists, max_shows: args.max_shows },
      });
    },
  );

  // -----------------------------------------------------------------------
  // #403 monthly_listening_report — calendar-month report
  // -----------------------------------------------------------------------
  server.tool(
    'monthly_listening_report',
    'Calendar-month listening report: top tracks/artists, estimated minutes, active days and '
      + 'session count, rendered as markdown; optionally archives a sidecar snapshot for '
      + 'month-over-month diffs. Local compute over recently-played (90-day window — older '
      + 'months cannot be fully reconstructed) + /me/top short-term data. ~6 reads.',
    {
      month: z.string().optional().describe('Month to report on, YYYY-MM. Default: previous full calendar month.'),
      archive: z.boolean().optional().default(false)
        .describe('Archive the report into the local sidecar under this month label for later diffs'),
      max_results: MaxResults,
      response_format: ResponseFormat,
    },
    async (args) => {
      const rf = args.response_format as ResponseFormatValue;
      const { start, end, label } = monthBounds(args.month);
      const plays = await loadPlaysBetween(client, start, end, getConfig().fetchAllCap);
      const counts = new Map<string, { name: string; artists: string; plays: number; ms: number }>();
      const artistCounts = new Map<string, number>();
      const days = new Set<string>();
      for (const p of plays) {
        const t = p.track;
        if (!t?.uri) continue;
        const key = t.uri;
        const prev = counts.get(key);
        counts.set(key, {
          name: t.name ?? 'unknown',
          artists: (t.artists ?? []).map((a) => a.name).join(', ') || 'unknown',
          plays: (prev?.plays ?? 0) + 1,
          ms: (prev?.ms ?? 0) + (t.duration_ms ?? AVG_TRACK_MS),
        });
        for (const a of t.artists ?? []) artistCounts.set(a.name, (artistCounts.get(a.name) ?? 0) + 1);
        days.add(isoDay(playDate(p)));
      }
      const minutes = Math.round(plays.reduce((n, p) => n + (p.track.duration_ms ?? AVG_TRACK_MS), 0) / 60_000);
      const topTracks = [...counts.values()].sort((a, b) => b.plays - a.plays);
      const topArtists = [...artistCounts.entries()].map(([name, plays]) => ({ name, plays })).sort((a, b) => b.plays - a.plays);
      const sessions = countSessions(plays.map((p) => p.played_at));
      const payload = {
        ok: true, month: label, plays: plays.length, minutes, active_days: days.size, sessions,
        top_tracks: topTracks.slice(0, 10), top_artists: topArtists.slice(0, 10),
        window_note: 'recently-played only covers ~90 days; earlier months show partial data',
      };
      let archivedLine = '';
      if (args.archive) {
        const s = await loadMiscStore();
        s.reports[`listening-${label}`] = payload;
        await saveMiscStore(s);
        archivedLine = `\nArchived to sidecar slot "listening-${label}".`;
      }
      const maxResults = resolveMaxResults(args.max_results, getConfig().maxItems);
      const tt = truncateItems(topTracks, maxResults);
      const lines: string[] = [`# Listening report — ${label}`, ''];
      lines.push(`- Plays: ${plays.length} · Est. minutes: ${minutes} · Active days: ${days.size} · Sessions: ${sessions}`);
      if (plays.length >= getConfig().fetchAllCap) lines.push('- (note: fetch-all cap reached — counts are a lower bound)');
      lines.push('', '## Top tracks');
      tt.items.forEach((t, i) => lines.push(`${i + 1}. ${t.name} — ${t.artists} (${t.plays} plays)`));
      if (tt.footer) lines.push(`(${tt.footer})`);
      lines.push('', '## Top artists');
      topArtists.slice(0, 10).forEach((a, i) => lines.push(`${i + 1}. ${a.name} (${a.plays} plays)`));
      lines.push('', payload.window_note);
      return emit(rf, lines.join('\n') + archivedLine, payload);
    },
  );

  // -----------------------------------------------------------------------
  // #404 year_in_review — Wrapped substitute
  // -----------------------------------------------------------------------
  server.tool(
    'year_in_review',
    'Spotify-Wrapped substitute: top tracks/artists across all top-list time ranges, decade '
      + 'mix, library growth and discovery ratio, rendered as a markdown review. Local compute. '
      + 'Quota: ~9 reads (3 top ranges × 2 lists + library + history).',
    {
      year: z.number().int().optional().describe('Year to review (used for library-growth histogram framing). Default: current year.'),
      output_format: z.enum(['markdown', 'json']).optional().default('markdown')
        .describe('Render as markdown review or raw json'),
      max_results: MaxResults,
      response_format: ResponseFormat,
    },
    async (args) => {
      const rf = args.response_format as ResponseFormatValue;
      const year = args.year ?? new Date().getUTCFullYear();
      const ranges = ['short_term', 'medium_term', 'long_term'] as const;
      const tops: Record<string, { tracks: Array<{ name: string; artists: string; release: string }>; artists: Array<{ name: string; genres: string[] }> }> = {};
      const trackCounts = new Map<string, { name: string; artists: string; plays: number }>();
      for (const r of ranges) {
        const tracks = await client.get<{ items?: Array<{ name?: string; artists?: Array<{ name: string }>; album?: { release_date?: string } }> }>(
          '/me/top/tracks', { time_range: r, limit: '50' },
        );
        const artists = await client.get<{ items?: Array<{ name?: string; genres?: string[] }> }>(
          '/me/top/artists', { time_range: r, limit: '50' },
        );
        tops[r] = {
          tracks: (tracks?.items ?? []).map((t) => ({
            name: t.name ?? 'unknown',
            artists: (t.artists ?? []).map((a) => a.name).join(', ') || 'unknown',
            release: t.album?.release_date ?? '',
          })),
          artists: (artists?.items ?? []).map((a) => ({ name: a.name ?? 'unknown', genres: a.genres ?? [] })),
        };
        if (r === 'short_term') {
          for (const t of tops[r].tracks) {
            const k = `${t.name}::${t.artists}`;
            trackCounts.set(k, { name: t.name, artists: t.artists, plays: (trackCounts.get(k)?.plays ?? 0) + 1 });
          }
        }
      }
      const saved = await client.getAllPages<{ added_at?: string; track?: { name?: string } }>('/me/tracks', { limit: '50' });
      const growthByYear = new Map<string, number>();
      for (const row of saved) {
        const y = (row.added_at ?? '').slice(0, 4);
        if (y) growthByYear.set(y, (growthByYear.get(y) ?? 0) + 1);
      }
      const recent = await loadPlaysBetween(client, Date.now() - 90 * DAY_MS, Date.now(), 1000);
      const recentUris = new Set(recent.map((p) => p.track.uri));
      const recentFirstHalf = recent.slice(0, Math.floor(recent.length / 2));
      const knownFirstHalf = new Set(recentFirstHalf.map((p) => p.track.uri));
      const discoveryRatio = recentUris.size > 0
        ? Math.round(((recentUris.size - [...knownFirstHalf].filter((u) => recent.slice(Math.floor(recent.length / 2)).some((p) => p.track.uri === u)).length) / Math.max(1, recentUris.size)) * 100) / 100
        : 0;
      const decade = new Map<string, number>();
      for (const r of ranges) {
        for (const t of tops[r].tracks) {
          const y = Number(t.release.slice(0, 4));
          if (!Number.isFinite(y)) continue;
          const d = `${Math.floor(y / 10) * 10}s`;
          decade.set(d, (decade.get(d) ?? 0) + 1);
        }
      }
      const payload = {
        ok: true, year, tops,
        library_growth: Object.fromEntries([...growthByYear.entries()].sort()),
        decade_mix: Object.fromEntries([...decade.entries()].sort((a, b) => b[0].localeCompare(a[0]))),
        discovery_ratio: discoveryRatio,
        saved_tracks: saved.length,
      };
      if (args.output_format === 'json' || rf === 'json') return emit(rf, JSON.stringify(payload, null, 2), payload);
      const maxResults = resolveMaxResults(args.max_results, getConfig().maxItems);
      const lines: string[] = [`# Year in review — ${year}`, ''];
      for (const r of ranges) {
        lines.push(`## ${r.replace('_', ' ')} top artists`);
        tops[r].artists.slice(0, 5).forEach((a, i) => lines.push(`${i + 1}. ${a.name} — ${a.genres.slice(0, 3).join(', ')}`));
        lines.push('', `## ${r.replace('_', ' ')} top tracks`);
        const t = truncateItems(tops[r].tracks, maxResults);
        t.items.slice(0, 5).forEach((x, i) => lines.push(`${i + 1}. ${x.name} — ${x.artists}`));
        if (t.footer) lines.push(`(${t.footer})`);
        lines.push('');
      }
      lines.push('## Decade mix', ...[...decade.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5).map(([d, n]) => `- ${d}: ${n} tracks`));
      lines.push('', '## Library growth');
      for (const [y, n] of [...growthByYear.entries()].sort()) lines.push(`- ${y}: ${n} saved tracks`);
      lines.push('', `Discovery ratio (approx, last 90d): ${discoveryRatio}`);
      return emit(rf, lines.join('\n'), payload);
    },
  );

  // -----------------------------------------------------------------------
  // #405 taste_checkpoint — dated snapshot slot
  // -----------------------------------------------------------------------
  server.tool(
    'taste_checkpoint',
    'Save a snapshot of your current top artists/tracks/genres to a dated sidecar slot for '
      + 'longitudinal taste tracking (pair with taste_checkpoint_diff). 2 reads, sidecar write only.',
    {
      label: z.string().optional().describe('Slot label. Default: today as YYYY-MM-DD.'),
      time_range: z.enum(['short_term', 'medium_term', 'long_term']).optional().default('medium_term')
        .describe('Which top-list window to snapshot. Default medium_term.'),
      response_format: ResponseFormat,
    },
    async (args) => {
      const rf = args.response_format as ResponseFormatValue;
      const label = args.label ?? isoDay(Date.now());
      const tracks = await client.get<{ items?: Array<{ name?: string; uri?: string; artists?: Array<{ name: string }> }> }>(
        '/me/top/tracks', { time_range: args.time_range, limit: '50' },
      );
      const artists = await client.get<{ items?: Array<{ name?: string; genres?: string[] }> }>(
        '/me/top/artists', { time_range: args.time_range, limit: '50' },
      );
      const cp: TasteCheckpoint = {
        label, saved_at: new Date().toISOString(), time_range: args.time_range,
        artists: (artists?.items ?? []).map((a) => ({ name: a.name ?? 'unknown', genres: a.genres ?? [] })),
        tracks: (tracks?.items ?? []).filter((t) => t.uri).map((t) => ({
          name: t.name ?? 'unknown',
          artist_names: (t.artists ?? []).map((x) => x.name),
          uri: t.uri!,
        })),
      };
      const s = await loadMiscStore();
      s.checkpoints[label] = cp;
      await saveMiscStore(s);
      return emit(rf, `Checkpoint "${label}" saved (${cp.tracks.length} tracks, ${cp.artists.length} artists, ${args.time_range}).`, {
        ok: true, label, tracks: cp.tracks.length, artists: cp.artists.length, time_range: args.time_range, saved_at: cp.saved_at,
      });
    },
  );

  // -----------------------------------------------------------------------
  // #406 taste_checkpoint_diff — pure sidecar diff
  // -----------------------------------------------------------------------
  server.tool(
    'taste_checkpoint_diff',
    'Diff two saved taste checkpoints: new entrants, drop-offs, genre drift and Jaccard '
      + 'similarity. Pure local sidecar — zero API calls. List slots with from="?" or omit.',
    {
      from: z.string().optional().describe('Older checkpoint label'),
      to: z.string().optional().describe('Newer checkpoint label'),
      response_format: ResponseFormat,
    },
    async (args) => {
      const rf = args.response_format as ResponseFormatValue;
      const s = await loadMiscStore();
      const labels = Object.keys(s.checkpoints);
      if (args.from === undefined || args.to === undefined) {
        return emit(rf, `Available checkpoints (${labels.length}): ${labels.join(', ') || 'none — create one with taste_checkpoint'}`, {
          ok: false, available: labels,
        });
      }
      const a = s.checkpoints[args.from];
      const b = s.checkpoints[args.to];
      if (!a || !b) {
        return emit(rf, `Unknown checkpoint(s): ${[!a && args.from, !b && args.to].filter(Boolean).join(', ')}. Available: ${labels.join(', ')}`, { ok: false, available: labels });
      }
      const key = (t: { name: string; artist_names: string[] }) => `${t.name.toLowerCase()}::${t.artist_names.map((x) => x.toLowerCase()).sort().join('|')}`;
      const aT = new Set(a.tracks.map(key));
      const bT = new Set(b.tracks.map(key));
      const aA = new Set(a.artists.map((x) => x.name.toLowerCase()));
      const bA = new Set(b.artists.map((x) => x.name.toLowerCase()));
      const intersect = (x: Set<string>, y: Set<string>) => [...x].filter((v) => y.has(v)).length;
      const jaccard = (x: Set<string>, y: Set<string>) => {
        const uni = new Set([...x, ...y]).size;
        return uni === 0 ? 1 : Math.round((intersect(x, y) / uni) * 100) / 100;
      };
      const genreCount = (cp: TasteCheckpoint) => {
        const m = new Map<string, number>();
        for (const ar of cp.artists) for (const g of ar.genres) m.set(g, (m.get(g) ?? 0) + 1);
        return m;
      };
      const ga = genreCount(a); const gb = genreCount(b);
      const rising = [...gb.entries()].filter(([g, n]) => n > (ga.get(g) ?? 0)).sort((a, b) => b[1] - a[1]).slice(0, 5);
      const falling = [...ga.entries()].filter(([g, n]) => n > (gb.get(g) ?? 0)).sort((a, b) => b[1] - a[1]).slice(0, 5);
      const payload = {
        ok: true, from: args.from, to: args.to,
        new_tracks: b.tracks.filter((t) => !aT.has(key(t))).map((t) => `${t.name} — ${t.artist_names.join(', ')}`),
        dropped_tracks: a.tracks.filter((t) => !bT.has(key(t))).map((t) => `${t.name} — ${t.artist_names.join(', ')}`),
        new_artists: b.artists.filter((x) => !aA.has(x.name.toLowerCase())).map((x) => x.name),
        dropped_artists: a.artists.filter((x) => !bA.has(x.name.toLowerCase())).map((x) => x.name),
        genres_rising: rising.map(([g, n]) => ({ genre: g, count: n })),
        genres_falling: falling.map(([g, n]) => ({ genre: g, count: n })),
        jaccard_tracks: jaccard(aT, bT), jaccard_artists: jaccard(aA, bA),
      };
      const lines: string[] = [`Taste diff "${args.from}" → "${args.to}":`, ''];
      lines.push(`Tracks: ${payload.new_tracks.length} new, ${payload.dropped_tracks.length} dropped (Jaccard ${payload.jaccard_tracks})`);
      for (const t of payload.new_tracks.slice(0, 10)) lines.push(`  + ${t}`);
      for (const t of payload.dropped_tracks.slice(0, 10)) lines.push(`  - ${t}`);
      lines.push(`Artists: ${payload.new_artists.length} new, ${payload.dropped_artists.length} dropped (Jaccard ${payload.jaccard_artists})`);
      if (rising.length) lines.push('', `Genres rising: ${rising.map(([g, n]) => `${g} (${n})`).join(', ')}`);
      if (falling.length) lines.push(`Genres falling: ${falling.map(([g, n]) => `${g} (${n})`).join(', ')}`);
      return emit(rf, lines.join('\n'), payload);
    },
  );

  // -----------------------------------------------------------------------
  // #407 discover_weekly_diff — this week vs the archived copy
  // -----------------------------------------------------------------------
  server.tool(
    'discover_weekly_diff',
    'This week\'s Discover Weekly vs the last copy in your archive playlist: what is new, '
      + 'what overlapped, and which tracks you already liked. 2-3 reads (+1 write only with '
      + 'save_after). Resolves both playlists by exact name.',
    {
      archive_name: z.string().optional().default('Discover Weekly Archive')
        .describe('Archive playlist name kept by save_discover_weekly. Default "Discover Weekly Archive".'),
      liked_cap: z.number().int().min(0).max(2000).optional().default(500)
        .describe('How many saved tracks to scan for "already liked" detection. Default 500.'),
      save_after: z.boolean().optional().default(false)
        .describe('After the diff, sync the archive playlist to this week\'s copy (adds writes)'),
      dry_run: DryRun,
      response_format: ResponseFormat,
    },
    async (args) => {
      const rf = args.response_format as ResponseFormatValue;
      const dw = await findPlaylistByName(client, 'Discover Weekly');
      if (!dw) {
        return emit(rf, 'Could not find "Discover Weekly" in your playlists (it appears in /me/playlists only while active — try again on a refresh).', { ok: false, error: 'source_not_found' });
      }
      const rows = await client.getAllPages<PlaylistRow>(`/playlists/${encodeURIComponent(dw.id)}/items`, { limit: '100' });
      const current = rows.map((r) => r?.item?.uri).filter((u): u is string => typeof u === 'string');
      const archive = await findPlaylistByName(client, args.archive_name);
      const archiveRows = archive
        ? await client.getAllPages<PlaylistRow>(`/playlists/${encodeURIComponent(archive.id)}/items`, { limit: '100' })
        : [];
      const archived = new Set(archiveRows.map((r) => r?.item?.uri).filter((u): u is string => typeof u === 'string'));
      const likedRows = args.liked_cap > 0
        ? await client.getAllPages<{ track?: { uri?: string } }>('/me/tracks', { limit: '50' }, { maxItems: args.liked_cap })
        : [];
      const liked = new Set(likedRows.map((r) => r.track?.uri).filter((u): u is string => typeof u === 'string'));
      const fresh = current.filter((u) => !archived.has(u));
      const overlap = current.filter((u) => archived.has(u));
      const alreadyLiked = fresh.filter((u) => liked.has(u));
      const payload = {
        ok: true, discover_weekly_id: dw.id, total: current.length,
        new_since_archive: fresh, overlapping: overlap, already_liked: alreadyLiked,
        archive_found: archive !== null, archive_id: archive?.id ?? null,
      };
      if (args.save_after && archive) {
        if (args.dry_run) {
          return emit(rf, `${describeDryRun('sync Discover Weekly', args.archive_name, [`Would replace ${archive.name} with ${current.length} tracks`])}`, { ...payload, dry_run: true });
        }
        if (current.length > 0) {
          await client.put(`/playlists/${encodeURIComponent(archive.id)}/items`, { uris: current.slice(0, 100) });
          for (let i = 100; i < current.length; i += 100) {
            await client.post(`/playlists/${encodeURIComponent(archive.id)}/items`, { uris: current.slice(i, i + 100) });
          }
        }
      }
      const lines: string[] = [`Discover Weekly diff (${current.length} tracks):`, ''];
      if (!archive) lines.push(`No archive playlist "${args.archive_name}" found — everything counts as new.`);
      lines.push(`New since archive: ${fresh.length}${saveLine(args)}`);
      lines.push(`Overlap with archive: ${overlap.length}`);
      lines.push(`Already in your liked library: ${alreadyLiked.length}`);
      if (fresh.length) {
        lines.push('', 'New this week:');
        for (const r of rows) {
          const u = r?.item?.uri;
          if (u && fresh.includes(u)) lines.push(`  • ${r.item?.name ?? u} — ${r.item?.artists?.map((a) => a.name).join(', ') ?? ''}${liked.has(u) ? ' [liked]' : ''}`);
        }
      }
      return emit(rf, lines.join('\n'), payload);
    },
  );

  // -----------------------------------------------------------------------
  // #408 dead_library_finder — unsave candidates
  // -----------------------------------------------------------------------
  server.tool(
    'dead_library_finder',
    'Find saved tracks that never appear in your recent history AND sit in none of your '
      + 'playlists — unsave candidates. Local compute over /me/tracks + playlists + history. '
      + 'dry_run defaults to true; disabling it actually removes the candidates.',
    {
      min_age_days: z.number().int().min(1).max(3650).optional().default(30)
        .describe('Only consider tracks saved at least this long ago. Default 30.'),
      max_playlists: z.number().int().min(0).max(500).optional().default(50)
        .describe('Budget for playlist scans (each scan pages that playlist). Default 50.'),
      dry_run: z.boolean().optional().default(true)
        .describe('Plan only (default). Set false to remove the candidates from your library.'),
      max_results: MaxResults,
      response_format: ResponseFormat,
    },
    async (args) => {
      const rf = args.response_format as ResponseFormatValue;
      const saved = await client.getAllPages<{ added_at?: string; track?: { uri?: string; name?: string; artists?: Array<{ name: string }> } }>('/me/tracks', { limit: '50' });
      const recent = await loadPlaysBetween(client, Date.now() - 90 * DAY_MS, Date.now(), 1000);
      const playedRecently = new Set(recent.map((p) => p.track.uri));
      const inPlaylist = new Set<string>();
      const lists = await client.getAllPages<{ id: string; name: string }>('/me/playlists', { limit: '50' }, { maxItems: args.max_playlists });
      let playlistsScanned = 0;
      for (const pl of lists) {
        playlistsScanned++;
        const rows = await client.getAllPages<PlaylistRow>(`/playlists/${encodeURIComponent(pl.id)}/items`, { limit: '100' }, { maxItems: 500 });
        for (const r of rows) {
          const u = r?.item?.uri;
          if (u) inPlaylist.add(u);
        }
      }
      const cutoff = Date.now() - args.min_age_days * DAY_MS;
      const candidates = saved
        .filter((s) => {
          const u = s.track?.uri;
          if (!u || playedRecently.has(u) || inPlaylist.has(u)) return false;
          const added = ts(s.added_at ?? '');
          return !Number.isFinite(added) || added <= cutoff;
        })
        .map((s) => ({ uri: s.track!.uri, name: s.track!.name ?? 'unknown', added_at: s.added_at ?? '' }));
      const payload = {
        ok: true, scanned: { saved_tracks: saved.length, playlists: playlistsScanned, recent_plays: recent.length },
        candidates: candidates.map((c) => c.uri),
        details: candidates,
        count: candidates.length,
      };
      if (args.dry_run) {
        return emit(rf, describeDryRun('dead-library cleanup', 'your library', [
          `Would remove ${candidates.length} unplayed, playlist-absent track(s)`,
          ...candidates.slice(0, 5).map((c) => `${c.name} (saved ${c.added_at || 'unknown'})`),
        ]), payload);
      }
      if (candidates.length === 0) return emit(rf, 'No dead tracks found — nothing to remove.', payload);
      await modifyLibrary(client, candidates.map((c) => c.uri).filter((u): u is string => typeof u === 'string'), 'remove');
      const maxResults = resolveMaxResults(args.max_results, getConfig().maxItems);
      const t = truncateItems(candidates, maxResults);
      const lines = [`Removed ${candidates.length} dead track(s):`];
      t.items.forEach((c) => lines.push(`  • ${c.name} (saved ${c.added_at || 'unknown'})`));
      if (t.footer) lines.push(`(${t.footer})`);
      return emit(rf, lines.join('\n'), { ...payload, removed: candidates.length });
    },
  );

  // -----------------------------------------------------------------------
  // #409 week_in_review_playlist — weekly ritual playlist
  // -----------------------------------------------------------------------
  server.tool(
    'week_in_review_playlist',
    'Create a "Week of <date>" playlist from the last 7 days of plays: deduped, ordered by '
      + 'recency. Rerunning replaces the same playlist\'s content — your weekly ritual in one '
      + 'call. Quota: 1-3 reads + 1-3 writes. dry_run previews the tracklist.',
    {
      week_offset: z.number().int().min(0).max(12).optional().default(0)
        .describe('0 = last 7 days, 1 = the week before that, etc.'),
      dedupe: z.boolean().optional().default(true).describe('Keep one entry per track. Default true.'),
      rerun: z.boolean().optional().default(true)
        .describe('If a playlist with the same name exists, replace its content instead of failing.'),
      dry_run: z.boolean().optional().default(true).describe('Preview the plan (default true).'),
      response_format: ResponseFormat,
    },
    async (args) => {
      const rf = args.response_format as ResponseFormatValue;
      const end = Date.now() - args.week_offset * 7 * DAY_MS;
      const start = end - 7 * DAY_MS;
      const label = `Week of ${isoDay(start)}`;
      let plays = await loadPlaysBetween(client, start, end, getConfig().fetchAllCap);
      if (!args.dedupe) {
        // dedupe=false still needs uri-stable rows; keep order by recency
        plays = plays.filter((p) => p.track?.uri);
      } else {
        plays = dedupePlays(plays);
      }
      const uris = plays.map((p) => p.track.uri);
      const payload = { ok: true, playlist: label, start: isoDay(start), end: isoDay(end), tracks: uris.length, uris };
      const existing = await findPlaylistByName(client, label);
      if (args.dry_run) {
        const changes = [
          existing
            ? `Would replace all item(s) in existing playlist "${label}"`
            : `Would create playlist "${label}"`,
          ...plays.slice(0, 5).map((p) => `${p.track.name ?? p.track.uri}`),
        ];
        return emit(rf, describeDryRun('week-in-review', label, changes), payload);
      }
      let id = existing?.id ?? null;
      if (existing && !args.rerun) {
        return emit(rf, `Playlist "${label}" already exists and rerun=false — nothing changed.`, { ...payload, ok: false, error: 'exists' });
      }
      if (!id) {
        const created = await client.post<{ id: string }>('/me/playlists', { name: label, public: false, description: `Plays from ${isoDay(start)} to ${isoDay(end)} — created by week_in_review_playlist` });
        if (!created?.id) throw new Error(`Could not create playlist "${label}"`);
        id = created.id;
      }
      if (uris.length > 0) {
        await client.put(`/playlists/${encodeURIComponent(id)}/items`, { uris: uris.slice(0, 100) });
        for (let i = 100; i < uris.length; i += 100) {
          await client.post(`/playlists/${encodeURIComponent(id)}/items`, { uris: uris.slice(i, i + 100) });
        }
      }
      return emit(rf, `"${label}" ready: ${uris.length} track(s), ${isoDay(start)} → ${isoDay(end)}.`, { ...payload, playlist_id: id });
    },
  );

  // -----------------------------------------------------------------------
  // #410 scope_audit — token scope decoder + tool classification
  // -----------------------------------------------------------------------
  server.tool(
    'scope_audit',
    "Decode the current token's granted OAuth scopes and classify every registered tool "
      + 'module: callable, scope-gated, or read-only. Optional probe fires one lightweight read '
      + 'for actionable evidence. Supports the #329 gating audit.',
    {
      probe: z.boolean().optional().default(false)
        .describe('Fire one probe read (/me/top/artists) to verify top-list access'),
      response_format: ResponseFormat,
    },
    async (args) => {
      const rf = args.response_format as ResponseFormatValue;
      let granted: Set<string>;
      let scopeError: string | null = null;
      try {
        const tokens = await loadTokens();
        granted = scopesFor(tokens.scope);
      } catch (e) {
        granted = scopesFor(undefined);
        scopeError = e instanceof Error ? e.message : String(e);
      }
      const modules: Array<{ module: string; required_write_scopes: string[]; status: 'callable' | 'scope_gated' }> = [];
      for (const [key, required] of Object.entries(WRITE_SCOPE_REQUIREMENTS)) {
        modules.push({
          module: key,
          required_write_scopes: required,
          status: moduleBlockedByScopes(key, granted) ? 'scope_gated' : 'callable',
        });
      }
      let probeResult: string | null = null;
      if (args.probe) {
        try {
          const r = await client.get<{ items?: unknown[] }>('/me/top/artists', { time_range: 'short_term', limit: '1' });
          probeResult = r !== null ? 'ok — user-top-read granted' : 'empty';
        } catch (e) {
          probeResult = e instanceof SpotifyApiError
            ? `HTTP ${e.status}${e.reason ? ` (${e.reason})` : ''} — ${e.status === 403 ? 'scope or app-registration gated' : e.status === 429 ? 'rate limited' : 'error'}`
            : String(e);
        }
      }
      const payload = {
        ok: true, granted_scopes: [...granted].sort(), scope_error: scopeError,
        write_modules: modules,
        read_only_note: 'Read-only modules have no scope requirements and are never blocked.',
        probe: probeResult,
      };
      const lines = ['Scope audit for the current token:'];
      lines.push(`Granted scopes (${granted.size}): ${[...granted].sort().join(' ') || '(none — no token persisted yet)'}`);
      if (scopeError) lines.push(`Token read failed: ${scopeError}`);
      lines.push('', 'Write-capable modules:');
      for (const m of modules) lines.push(`  • ${m.module}: ${m.status}${m.status === 'scope_gated' ? ` (needs ${m.required_write_scopes.join(', ')})` : ''}`);
      lines.push('', 'Read-only modules: always callable.');
      if (probeResult) lines.push('', `Probe: ${probeResult}`);
      return emit(rf, lines.join('\n'), payload);
    },
  );

  // -----------------------------------------------------------------------
  // #411 quota_probe — lightweight quota + gating map
  // -----------------------------------------------------------------------
  server.tool(
    'quota_probe',
    'Fire 2-3 lightweight authenticated reads and report Retry-After / quota state plus a '
      + 'per-endpoint 403 gating map — actionable evidence for the #330 gauntlet. Quota: 2-3 reads.',
    {
      probe_set: z.enum(['minimal', 'light', 'full']).optional().default('light')
        .describe("minimal = /me · light = + /me/player · full = + /me/top/tracks + /me/audiobooks. Default light."),
      response_format: ResponseFormat,
    },
    async (args) => {
      const rf = args.response_format as ResponseFormatValue;
      const endpoints = ['/me', '/me/player'];
      if (args.probe_set === 'full') endpoints.push('/me/top/tracks?limit=1', '/me/audiobooks?limit=1');
      const map: Array<{ endpoint: string; status: 'ok' | 'empty' | 'http_403' | 'http_429' | 'error'; detail?: string }> = [];
      for (const ep of endpoints) {
        const path = ep.split('?')[0]!;
        const params: Record<string, string> = {};
        if (ep.includes('limit=')) params.limit = '1';
        if (ep.includes('/me/top/')) params.time_range = 'short_term';
        try {
          const r = await client.get<unknown>(path, params);
          map.push({ endpoint: ep, status: r === null || r === undefined ? 'empty' : 'ok' });
        } catch (e) {
          if (e instanceof SpotifyApiError) {
            map.push({
              endpoint: ep,
              status: e.status === 403 ? 'http_403' : e.status === 429 ? 'http_429' : 'error',
              detail: `${e.message}${e.reason ? ` (reason: ${e.reason})` : ''}${e.retryAfterSec !== undefined ? ` (Retry-After: ${e.retryAfterSec}s)` : ''}`,
            });
          } else {
            map.push({ endpoint: ep, status: 'error', detail: e instanceof Error ? e.message : String(e) });
          }
        }
      }
      const rateLimit = client.getRateLimitStatus();
      const payload = {
        ok: true, probe_set: args.probe_set, endpoints: map,
        rate_limit: rateLimit,
        note: 'http_403 usually means OAuth scope or app-registration gating; http_429 means throttling/quota exhaustion.',
      };
      const lines = [`Quota probe (${args.probe_set}):`, ''];
      for (const m of map) lines.push(`  • ${m.endpoint}: ${m.status}${m.detail ? ` — ${m.detail}` : ''}`);
      lines.push('', `Client rate-limit state: cooldown ${rateLimit.cooldownRemainingMs}ms, last throttle ${rateLimit.lastThrottleAt ?? 'none'}`);
      return emit(rf, lines.join('\n'), payload);
    },
  );

  // -----------------------------------------------------------------------
  // #412 playlist_staleness_report — rotting playlists
  // -----------------------------------------------------------------------
  server.tool(
    'playlist_staleness_report',
    'Per-playlist staleness report: newest/oldest added_at, median item age and count added '
      + 'in the last 90 days — find playlists rotting in place. Quota: 1 + N reads (N = playlists '
      + 'scanned), page-capped.',
    {
      limit: z.number().int().min(1).max(500).optional().default(50)
        .describe('How many playlists to scan. Default 50.'),
      per_playlist_cap: z.number().int().min(10).max(2000).optional().default(500)
        .describe('Max items paged per playlist. Default 500.'),
      sort: z.enum(['median_age', 'oldest', 'name']).optional().default('median_age'),
      max_results: MaxResults,
      response_format: ResponseFormat,
    },
    async (args) => {
      const rf = args.response_format as ResponseFormatValue;
      const lists = await client.getAllPages<{ id: string; name: string }>('/me/playlists', { limit: '50' }, { maxItems: args.limit });
      const rows: Array<{ name: string; items: number; newest: string | null; oldest: string | null; median_age_days: number | null; added_last_90d: number }> = [];
      let skipped = 0;
      for (const pl of lists) {
        let items: PlaylistRow[];
        try {
          items = await client.getAllPages<PlaylistRow>(`/playlists/${encodeURIComponent(pl.id)}/items`, { limit: '100', fields: 'items(added_at),total' }, { maxItems: args.per_playlist_cap });
        } catch (e) {
          // 403 = collaborative/unfollowed playlists whose items this token cannot
          // read (playlist-read-private/collaborative gaps) — skip, never crash.
          if (e instanceof SpotifyApiError && e.status === 403) { skipped++; continue; }
          throw e;
        }
        const ages = items.map((r) => (r?.added_at ? Math.floor((Date.now() - Date.parse(r.added_at)) / DAY_MS) : NaN)).filter((n) => Number.isFinite(n));
        ages.sort((a, b) => a - b);
        const median = ages.length ? ages[Math.floor(ages.length / 2)]! : null;
        const sortedAdded = items.map((r) => r?.added_at ?? '').filter(Boolean).sort();
        rows.push({
          name: pl.name,
          items: ages.length,
          newest: sortedAdded.at(-1) || null,
          oldest: sortedAdded[0] || null,
          median_age_days: median,
          added_last_90d: ages.filter((a) => a <= 90).length,
        });
      }
      const cmp: Record<string, (a: typeof rows[number], b: typeof rows[number]) => number> = {
        median_age: (a, b) => (b.median_age_days ?? -1) - (a.median_age_days ?? -1),
        oldest: (a, b) => (a.oldest ?? 'z').localeCompare(b.oldest ?? 'z'),
        name: (a, b) => a.name.localeCompare(b.name),
      };
      rows.sort(cmp[args.sort] ?? cmp.median_age!);
      const maxResults = resolveMaxResults(args.max_results, getConfig().maxItems);
      const t = truncateItems(rows, maxResults);
      const payload = { ok: true, scanned: rows.length, skipped_unreadable: skipped, playlists: t.items, truncated: t.truncated };
      const lines = [`Playlist staleness report (${rows.length} playlists${skipped ? `, ${skipped} unreadable skipped` : ''}, sorted by ${args.sort}):`, ''];
      for (const r of t.items) {
        lines.push(`• ${r.name} — ${r.items} items, median age ${r.median_age_days ?? '?'}d, ${r.added_last_90d} added last 90d (oldest ${r.oldest ?? '?'})`);
      }
      if (t.footer) lines.push(`(${t.footer})`);
      return emit(rf, lines.join('\n'), payload);
    },
  );

  // -----------------------------------------------------------------------
  // #413 show_backlog_report — unsubscribe decision support
  // -----------------------------------------------------------------------
  server.tool(
    'show_backlog_report',
    'Per saved podcast show: unplayed episodes (resume_point), hours of backlog and '
      + 'newest-episode age — decide what to unsubscribe from. Quota: 1 + N reads (budgeted).',
    {
      sort: z.enum(['backlog_hours', 'newest', 'name']).optional().default('backlog_hours'),
      min_hours: z.number().min(0).max(10000).optional().default(0)
        .describe('Only surface shows with at least this many backlog hours. Default 0 (all).'),
      max_shows: z.number().int().min(1).max(200).optional().default(25)
        .describe('Budget for per-show episode paging. Default 25.'),
      max_results: MaxResults,
      response_format: ResponseFormat,
    },
    async (args) => {
      const rf = args.response_format as ResponseFormatValue;
      const shows = await client.getAllPages<{ show?: { id?: string; name?: string; total_episodes?: number } }>('/me/shows', { limit: '50' }, { maxItems: args.max_shows });
      const rows: Array<{ name: string; unplayed: number; backlog_hours: number; newest_episode: string | null; total_episodes: number | null }> = [];
      for (const row of shows) {
        const show = row.show;
        if (!show?.id) continue;
        const eps = await client.getAllPages<{ name?: string; duration_ms?: number; release_date?: string; resume_point?: { fully_played?: boolean } }>(
          `/shows/${encodeURIComponent(show.id)}/episodes`, { limit: '50' }, { maxItems: 500 },
        );
        let unplayed = 0; let ms = 0; let newest: string | null = null;
        for (const e of eps) {
          if (newest === null || (e.release_date ?? '') > newest) newest = e.release_date ?? null;
          if (!e.resume_point?.fully_played) {
            unplayed++;
            ms += e.duration_ms ?? 0;
          }
        }
        rows.push({ name: show.name ?? 'unknown', unplayed, backlog_hours: Math.round((ms / HOUR_MS) * 10) / 10, newest_episode: newest, total_episodes: row.show?.total_episodes ?? eps.length });
      }
      if (args.min_hours > 0) {
        const filtered = rows.filter((r) => r.backlog_hours >= args.min_hours);
        rows.length = 0;
        rows.push(...filtered);
      }
      const sorters: Record<string, (a: typeof rows[number], b: typeof rows[number]) => number> = {
        backlog_hours: (a, b) => b.backlog_hours - a.backlog_hours,
        newest: (a, b) => (b.newest_episode ?? '').localeCompare(a.newest_episode ?? ''),
        name: (a, b) => a.name.localeCompare(b.name),
      };
      rows.sort(sorters[args.sort] ?? sorters.backlog_hours!);
      const maxResults = resolveMaxResults(args.max_results, getConfig().maxItems);
      const t = truncateItems(rows, maxResults);
      const payload = { ok: true, shows: t.items, scanned: rows.length, truncated: t.truncated };
      const lines = [`Show backlog report (${rows.length} shows):`, ''];
      for (const r of t.items) {
        lines.push(`• ${r.name} — ${r.unplayed} unplayed (~${r.backlog_hours}h), newest ep ${r.newest_episode ?? '?'}`);
      }
      if (t.footer) lines.push(`(${t.footer})`);
      return emit(rf, lines.join('\n'), payload);
    },
  );

  // -----------------------------------------------------------------------
  // #414 audiobook_library_progress — what am I actually reading
  // -----------------------------------------------------------------------
  server.tool(
    'audiobook_library_progress',
    'All saved audiobooks with % complete and estimated time remaining, sorted by progress — '
      + 'what am I actually reading. Quota: 1 + N reads. NOTE: audiobook endpoints are '
      + 'market-gated (US/UK/CA/IE/NZ/AU) — outside these a clear error is returned.',
    {
      sort: z.enum(['progress', 'remaining', 'title']).optional().default('progress'),
      max_audiobooks: z.number().int().min(1).max(100).optional().default(25),
      max_results: MaxResults,
      response_format: ResponseFormat,
    },
    async (args) => {
      const rf = args.response_format as ResponseFormatValue;
      let books: Array<{ audiobook?: { id?: string; name?: string } }> = [];
      try {
        books = await client.getAllPages<{ audiobook?: { id?: string; name?: string } }>('/me/audiobooks', { limit: '50' }, { maxItems: args.max_audiobooks });
      } catch (e) {
        if (e instanceof SpotifyApiError && e.status === 403) {
          return emit(rf, 'Audiobooks are app-registration/market gated — your app registration is not entitled to audiobook endpoints (market-gated to US/UK/CA/IE/NZ/AU).', { ok: false, error: 'gated', status: 403 });
        }
        throw e;
      }
      const rows: Array<{ title: string; percent: number; remaining_hours: number; chapters_done: number; chapters_total: number }> = [];
      for (const row of books) {
        const book = row.audiobook;
        if (!book?.id) continue;
        const chapters = await client.getAllPages<{ name?: string; duration_ms?: number; resume_point?: { fully_played?: boolean } }>(
          `/audiobooks/${encodeURIComponent(book.id)}/chapters`, { limit: '50' }, { maxItems: 500 },
        );
        const total = chapters.length || 1;
        const done = chapters.filter((c) => c.resume_point?.fully_played).length;
        const remainingMs = chapters.filter((c) => !c.resume_point?.fully_played).reduce((n, c) => n + (c.duration_ms ?? 0), 0);
        rows.push({
          title: book.name ?? 'unknown',
          percent: Math.round((done / total) * 100),
          remaining_hours: Math.round((remainingMs / HOUR_MS) * 10) / 10,
          chapters_done: done, chapters_total: chapters.length,
        });
      }
      const sorters: Record<string, (a: typeof rows[number], b: typeof rows[number]) => number> = {
        progress: (a, b) => b.percent - a.percent,
        remaining: (a, b) => b.remaining_hours - a.remaining_hours,
        title: (a, b) => a.title.localeCompare(b.title),
      };
      rows.sort(sorters[args.sort] ?? sorters.progress!);
      const maxResults = resolveMaxResults(args.max_results, getConfig().maxItems);
      const t = truncateItems(rows, maxResults);
      const payload = { ok: true, audiobooks: t.items, scanned: rows.length, truncated: t.truncated };
      const lines = [`Audiobook progress (${rows.length} books):`, ''];
      for (const r of t.items) lines.push(`• ${r.title} — ${r.percent}% (${r.chapters_done}/${r.chapters_total} chapters), ~${r.remaining_hours}h left`);
      if (t.footer) lines.push(`(${t.footer})`);
      return emit(rf, lines.join('\n'), payload);
    },
  );

  // -----------------------------------------------------------------------
  // #415 chapter_bookmarks — named positions per audiobook (sidecar)
  // -----------------------------------------------------------------------
  server.tool(
    'chapter_bookmarks',
    'Named chapter+position bookmarks per audiobook, stored in the local sidecar (jump later '
      + 'via jump_to_chapter). save/list/delete. Zero API calls — pure sidecar.',
    {
      op: z.enum(['save', 'list', 'delete']).optional().default('list'),
      book_uri: z.string().optional().describe('Audiobook URI, e.g. spotify:audiobook:abc (required for save/delete)'),
      label: z.string().optional().describe('Bookmark name (required for save)'),
      position_ms: z.number().int().min(0).optional().default(0).describe('Position in the book, ms. Default 0.'),
      chapter_name: z.string().optional().describe('Optional chapter name for context'),
      dry_run: DryRun,
      response_format: ResponseFormat,
    },
    async (args) => {
      const rf = args.response_format as ResponseFormatValue;
      const s = await loadMiscStore();
      const key = args.book_uri ?? '*';
      if (args.op === 'list') {
        const all = args.book_uri ? (s.bookmarks[key] ?? []) : Object.values(s.bookmarks).flat();
        const lines = [`Chapter bookmarks (${all.length}):`];
        for (const b of all) lines.push(`• [${b.book_uri}] ${b.label} @ ${Math.round(b.position_ms / 1000)}s${b.chapter_name ? ` (${b.chapter_name})` : ''}`);
        return emit(rf, all.length ? lines.join('\n') : 'No bookmarks saved yet.', { ok: true, bookmarks: all });
      }
      if (args.op === 'save') {
        if (!args.book_uri || !args.label) {
          return emit(rf, 'save requires book_uri and label.', { ok: false, error: 'missing_params' });
        }
        if (args.dry_run) {
          return emit(rf, describeDryRun('save bookmark', key, [`Would save "${args.label}" @ ${args.position_ms}ms`]), { ok: true, dry_run: true });
        }
        const list = s.bookmarks[key] ?? [];
        list.push({ book_uri: args.book_uri, label: args.label, position_ms: args.position_ms, ...(args.chapter_name ? { chapter_name: args.chapter_name } : {}), created_at: new Date().toISOString() });
        s.bookmarks[key] = list;
        await saveMiscStore(s);
        return emit(rf, `Bookmark "${args.label}" saved @ ${args.position_ms}ms for ${key}.`, { ok: true, label: args.label, book_uri: key, position_ms: args.position_ms });
      }
      // delete
      if (!args.book_uri) return emit(rf, 'delete requires book_uri.', { ok: false, error: 'missing_params' });
      const before = s.bookmarks[key] ?? [];
      const kept = args.label ? before.filter((b) => b.label !== args.label) : [];
      if (args.dry_run) {
        return emit(rf, describeDryRun('delete bookmarks', key, [`Would remove ${before.length - kept.length} bookmark(s)`]), { ok: true, dry_run: true, removed: before.length - kept.length });
      }
      s.bookmarks[key] = kept;
      await saveMiscStore(s);
      return emit(rf, `Removed ${before.length - kept.length} bookmark(s) for ${key}.`, { ok: true, removed: before.length - kept.length, remaining: kept.length });
    },
  );

  // -----------------------------------------------------------------------
  // #416 artist_complete_check — collector completeness
  // -----------------------------------------------------------------------
  server.tool(
    'artist_complete_check',
    "Collector completeness: the artist's full album list vs your saved albums — what's "
      + 'missing, with album/single/compilation breakdown. Quota: 2 reads (artist albums + '
      + 'your saved albums, page-capped).',
    {
      artist_id: z.string().min(1).describe('Spotify artist ID'),
      include_singles: z.boolean().optional().default(true)
        .describe('Count singles as part of the complete set. Default true.'),
      max_results: MaxResults,
      response_format: ResponseFormat,
    },
    async (args) => {
      const rf = args.response_format as ResponseFormatValue;
      const groups = args.include_singles ? 'album,single,compilation' : 'album,compilation';
      const albums = await client.get<{ name?: string; items?: Array<{ id: string; name: string; album_group?: string; album_type?: string; release_date?: string }> }>(
        `/artists/${encodeURIComponent(args.artist_id)}/albums`,
        { include_groups: groups, limit: '50' },
      );
      const artistName = albums?.name ?? args.artist_id;
      const savedAlbums = await client.getAllPages<{ album?: { id?: string } }>('/me/albums', { limit: '50' }, { maxItems: getConfig().fetchAllCap });
      const savedIds = new Set(savedAlbums.map((r) => r.album?.id).filter((u): u is string => typeof u === 'string'));
      const missing = (albums?.items ?? []).filter((a) => !savedIds.has(a.id));
      const breakdown = new Map<string, number>();
      for (const a of missing) breakdown.set(a.album_group ?? a.album_type ?? 'unknown', (breakdown.get(a.album_group ?? a.album_type ?? 'unknown') ?? 0) + 1);
      const maxResults = resolveMaxResults(args.max_results, getConfig().maxItems);
      const t = truncateItems(missing, maxResults);
      const payload = {
        ok: true, artist: artistName, total_albums: (albums?.items ?? []).length, missing: missing.length,
        breakdown: Object.fromEntries(breakdown), missing_list: t.items.map((a) => ({ name: a.name, group: a.album_group ?? a.album_type, release_date: a.release_date ?? '' })),
        truncated: t.truncated,
      };
      const lines = [`Completeness for ${artistName}:`, ''];
      lines.push(`Catalog: ${(albums?.items ?? []).length} releases, you have ${(albums?.items ?? []).length - missing.length}, missing ${missing.length}.`);
      lines.push(`Breakdown of missing: ${[...breakdown.entries()].map(([g, n]) => `${g}: ${n}`).join(', ') || 'nothing'}`);
      if (missing.length) {
        lines.push('', 'Missing releases:');
        t.items.forEach((a) => lines.push(`  • [${a.album_group ?? a.album_type ?? '?'}] ${a.name} (${a.release_date ?? '?'})`));
        if (t.footer) lines.push(`(${t.footer})`);
      }
      return emit(rf, lines.join('\n'), payload);
    },
  );

  // -----------------------------------------------------------------------
  // #417 playlist_from_tags — write side of tag_management
  // -----------------------------------------------------------------------
  server.tool(
    'playlist_from_tags',
    'Create or refresh a playlist from saved library items whose artists carry the given '
      + 'genre tags (the write side of tag_management — uses the same sidecar rule pattern). '
      + 'Quota: 2+ reads + 1-3 writes. dry_run previews the match list.',
    {
      tags: z.array(z.string()).min(1).describe('Genre tags to match (same values declared via tag_management)'),
      mode: z.enum(['create', 'refresh']).optional().default('create'),
      playlist_name: z.string().optional().describe('Playlist name (create mode). Default: "Tagged: <tags>".'),
      playlist_id: z.string().optional().describe('Playlist to refresh (refresh mode). Auto-resolved from playlist_name if omitted.'),
      dry_run: z.boolean().optional().default(true).describe('Preview the match list (default true).'),
      response_format: ResponseFormat,
    },
    async (args) => {
      const rf = args.response_format as ResponseFormatValue;
      const wanted = args.tags.map((t) => t.toLowerCase());
      const tagStore = loadGenreTags().tags;
      const saved = await client.getAllPages<{ track?: { uri?: string; name?: string; artists?: Array<{ name: string }> } }>('/me/tracks', { limit: '50' });
      const matched: typeof saved = [];
      for (const row of saved) {
        const artists = row.track?.artists ?? [];
        const hit = artists.some((a) => {
          const declared = Object.entries(tagStore).find(([k]) => k.toLowerCase() === a.name.toLowerCase())?.[1] ?? [];
          return declared.some((d) => wanted.includes(d.toLowerCase()));
        });
        if (hit && row.track?.uri) matched.push(row);
      }
      const uris = [...new Set(matched.map((r) => r.track!.uri))];
      const name = args.playlist_name ?? `Tagged: ${args.tags.join(', ')}`;
      const payload = { ok: true, tags: args.tags, matches: uris.length, uris, playlist_name: name, mode: args.mode };
      if (args.dry_run) {
        return emit(rf, describeDryRun(`playlist from tags [${args.tags.join(', ')}]`, name, [
          `Would put ${uris.length} matched track(s) into "${name}" (${args.mode})`,
          ...matched.slice(0, 5).map((r) => `${r.track!.name} — ${r.track!.artists?.map((a) => a.name).join(', ') ?? ''}`),
        ]), payload);
      }
      let id: string | null = args.playlist_id ?? null;
      if (!id && args.mode === 'refresh') {
        const found = await findPlaylistByName(client, name);
        id = found?.id ?? null;
      }
      if (!id) {
        const created = await client.post<{ id: string }>('/me/playlists', { name, public: false, description: `Library tracks tagged ${args.tags.join(', ')}` });
        if (!created?.id) throw new Error(`Could not create playlist "${name}"`);
        id = created.id;
      }
      if (uris.length > 0) {
        await client.put(`/playlists/${encodeURIComponent(id)}/items`, { uris: uris.slice(0, 100) });
        for (let i = 100; i < uris.length; i += 100) {
          await client.post(`/playlists/${encodeURIComponent(id)}/items`, { uris: uris.slice(i, i + 100) });
        }
      }
      return emit(rf, `"${name}" (${args.mode}) ready with ${uris.length} matched track(s).`, { ...payload, playlist_id: id });
    },
  );

  // -----------------------------------------------------------------------
  // #418 listening_journal_append — recall notes (sidecar)
  // -----------------------------------------------------------------------
  server.tool(
    'listening_journal_append',
    'Attach a timestamped note to today\'s journal, optionally tagged with a session id or '
      + 'tag — makes tag_listening_session actually useful for recall. Sidecar only, zero API calls.',
    {
      note: z.string().min(1).describe('The note to append'),
      session: z.string().optional().describe('Tag onto a saved listening session id'),
      tag: z.string().optional().describe('Free-form tag for later filtering'),
      response_format: ResponseFormat,
    },
    async (args) => {
      const rf = args.response_format as ResponseFormatValue;
      const s = await loadMiscStore();
      const entry: JournalEntry = {
        ts: new Date().toISOString(),
        note: args.note,
        ...(args.session ? { session: args.session } : {}),
        ...(args.tag ? { tag: args.tag } : {}),
      };
      s.journal.push(entry);
      await saveMiscStore(s);
      const today = isoDay(Date.now());
      const todays = s.journal.filter((e) => e.ts.slice(0, 10) === today);
      const lines = [`Journal entry appended (${todays.length} today, ${s.journal.length} total):`, `  ${entry.ts} ${args.tag ? `#${args.tag} ` : ''}${args.note}`];
      return emit(rf, lines.join('\n'), { ok: true, entry, today_count: todays.length, total: s.journal.length });
    },
  );

  // -----------------------------------------------------------------------
  // #419 export_playlist_markdown — paste-ready tracklist
  // -----------------------------------------------------------------------
  server.tool(
    'export_playlist_markdown',
    'Export one playlist as a paste-ready markdown table (the doc-friendly variant of '
      + 'export_playlist). 1 read.',
    {
      playlist_id: z.string().min(1).describe('Playlist ID'),
      include_added_at: z.boolean().optional().default(false).describe('Add an Added column'),
      max_results: MaxResults,
      response_format: ResponseFormat,
    },
    async (args) => {
      const rf = args.response_format as ResponseFormatValue;
      const meta = await client.get<{ name?: string; owner?: { id?: string } }>(`/playlists/${encodeURIComponent(args.playlist_id)}`);
      if (!meta) return emit(rf, `Playlist "${args.playlist_id}" not found.`, { ok: false, error: 'not_found' });
      const items = await client.getAllPages<PlaylistRow>(`/playlists/${encodeURIComponent(args.playlist_id)}/items`, { limit: '100' });
      const maxResults = resolveMaxResults(args.max_results, getConfig().maxItems);
      const t = truncateItems(items, maxResults);
      const cols = ['#', 'Track', 'Artists', 'Album', ...(args.include_added_at ? ['Added'] : [])];
      const rows = t.items.map((r, i) => [
        String(i + 1),
        r?.item?.name ?? r?.item?.uri ?? '(unavailable)',
        r?.item?.artists?.map((a) => a.name).join(', ') ?? '',
        r?.item?.album?.name ?? '',
        ...(args.include_added_at ? [r?.added_at ?? ''] : []),
      ]);
      const md = [
        `# ${meta.name ?? args.playlist_id}`,
        '',
        `| ${cols.join(' | ')} |`,
        `| ${cols.map(() => '---').join(' | ')} |`,
        ...rows.map((r) => `| ${r.join(' | ')} |`),
        ...(t.footer ? ['', `(${t.footer})`] : []),
      ].join('\n');
      return emit(rf, md, { ok: true, playlist: meta.name ?? args.playlist_id, items: items.length, returned: t.returned, truncated: t.truncated });
    },
  );

  // -----------------------------------------------------------------------
  // #420 export_shows_opml — podcast interchange
  // -----------------------------------------------------------------------
  server.tool(
    'export_shows_opml',
    "Export your saved shows as OPML XML — the interchange format podcast apps speak. "
      + 'DISCLOSURE: the Spotify API does not expose publishers\' underlying RSS feed URLs, so '
      + 'each OPML entry links to the Spotify show page (some apps import it, some ignore it).',
    {
      fetch_all: z.boolean().optional().default(false).describe('Page the whole library (up to fetch-all cap) instead of the first 50'),
      response_format: ResponseFormat,
    },
    async (args) => {
      const rf = args.response_format as ResponseFormatValue;
      const shows = await client.getAllPages<{ show?: { name?: string; uri?: string; publisher?: string; external_urls?: { spotify?: string } } }>(
        '/me/shows', { limit: '50' }, { maxItems: args.fetch_all ? getConfig().fetchAllCap : 50 },
      );
      const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
      const outlines = shows
        .filter((r) => r.show?.uri)
        .map((r) => `    <outline type="rss" text="${esc(r.show!.name ?? 'unknown')}" xmlUrl="" htmlUrl="${esc(r.show!.external_urls?.spotify ?? `https://open.spotify.com/show/${r.show!.uri!.split(':').at(-1)}`)}"/>`);
      const xml = ['<?xml version="1.0" encoding="UTF-8"?>', '<opml version="2.0">', '  <head><title>Spotify saved shows</title></head>', '  <body>', ...outlines, '  </body>', '</opml>', ''].join('\n');
      return emit(rf, xml, { ok: true, count: outlines.length, disclosure: 'RSS feed URLs are not exposed by the Spotify API — entries link to Spotify show pages.' });
    },
  );

  // -----------------------------------------------------------------------
  // #421 sidecar_export_bundle — one-call machine migration export
  // -----------------------------------------------------------------------
  server.tool(
    'sidecar_export_bundle',
    'One-call export of ALL local sidecar state (scenes, device presets, tags, smart rules, '
      + 'playback states, bookmarks, checkpoints, journal) as a single JSON for machine '
      + 'migration, plus a restore checklist. Zero API calls.',
    {
      pretty: z.boolean().optional().default(true).describe('Pretty-print the JSON bundle. Default true.'),
      response_format: ResponseFormat,
    },
    async (args) => {
      const rf = args.response_format as ResponseFormatValue;
      const tryRead = async (p: string): Promise<unknown> => {
        try { return JSON.parse(await readFile(p, 'utf8')); } catch { return null; }
      };
      const [scenes, playbackExt, misc] = await Promise.all([
        tryRead(scenesFilePath()),
        tryRead(playbackExtFile()),
        tryRead(miscFilePath()),
      ]);
      let history: unknown[] = [];
      try {
        const raw = await readFile(historyFilePath(), 'utf8');
        history = raw.trim().split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return { unparseable: l }; } });
      } catch { history = []; }
      const bundle = {
        exported_at: new Date().toISOString(),
        bundle_version: 1,
        scenes,
        playback_ext: playbackExt,
        exhaust2_misc: misc,
        mutation_history: { enabled: isHistoryEnabled(), path: historyFilePath(), records: history },
        restore_checklist: [
          '1. Write scenes.json / playback-ext.json / exhaust2-misc.json back under ~/.spotify-mcp (owner-only modes).',
          '2. Re-declare genre tags (or restore genre-tags.json) for playlist_from_tags / filter_by_genre.',
          '3. Mutations.jsonl is an audit trail — restore only if you want undo/audit continuity.',
          '4. Re-run auth (tokens are never exported).',
          '5. Spot-check: list_scenes, list_playback_states, taste_checkpoint_diff.',
        ],
      };
      const json = args.pretty ? JSON.stringify(bundle, null, 2) : JSON.stringify(bundle);
      return emit(rf, json, { ok: true, ...({ bundle } as unknown as Record<string, unknown>) });
    },
  );

  // -----------------------------------------------------------------------
  // #422 listening_week_in_time — retro charts via before/after walk
  // -----------------------------------------------------------------------
  server.tool(
    'listening_week_in_time',
    'Charts for any specific past week within the ~90-day recently-played window, via a '
      + 'before/after cursor walk — retro "what was I playing then". Quota: 2-6 reads.',
    {
      week_start: z.string().min(10).describe('Week start date, YYYY-MM-DD (local ISO day)'),
      top_n: z.number().int().min(1).max(50).optional().default(10).describe('Top N rows. Default 10.'),
      max_results: MaxResults,
      response_format: ResponseFormat,
    },
    async (args) => {
      const rf = args.response_format as ResponseFormatValue;
      const start = Date.parse(`${args.week_start}T00:00:00Z`);
      if (!Number.isFinite(start)) return emit(rf, `Invalid week_start "${args.week_start}" — use YYYY-MM-DD.`, { ok: false, error: 'bad_param' });
      if (start < Date.now() - 95 * DAY_MS) {
        return emit(rf, `${args.week_start} is older than the ~90-day recently-played window — Spotify will return nothing useful for it.`, { ok: false, error: 'outside_window' });
      }
      const plays = await loadPlaysBetween(client, start, start + 7 * DAY_MS, 1000);
      const counts = new Map<string, { name: string; artists: string; plays: number }>();
      const perDay = new Map<string, number>();
      for (const p of plays) {
        const t = p.track;
        if (!t?.uri) continue;
        const k = t.uri;
        counts.set(k, { name: t.name ?? 'unknown', artists: (t.artists ?? []).map((a) => a.name).join(', '), plays: (counts.get(k)?.plays ?? 0) + 1 });
        perDay.set(isoDay(playDate(p)), (perDay.get(isoDay(playDate(p))) ?? 0) + 1);
      }
      const top = [...counts.values()].sort((a, b) => b.plays - a.plays);
      const maxResults = resolveMaxResults(args.top_n ?? resolveMaxResults(args.max_results, getConfig().maxItems), getConfig().maxItems);
      const t = truncateItems(top, maxResults);
      const payload = {
        ok: true, week_start: args.week_start, plays: plays.length,
        top_tracks: t.items, per_day: Object.fromEntries([...perDay.entries()].sort()), truncated: t.truncated,
      };
      const lines = [`What you played ${args.week_start} → ${isoDay(start + 7 * DAY_MS)}:`, ''];
      lines.push(`Total plays: ${plays.length}`);
      lines.push('', 'Top tracks:');
      t.items.forEach((x, i) => lines.push(`${i + 1}. ${x.name} — ${x.artists} (${x.plays} plays)`));
      if (t.footer) lines.push(`(${t.footer})`);
      lines.push('', `Per day: ${[...perDay.entries()].sort().map(([d, n]) => `${d}: ${n}`).join(' · ')}`);
      return emit(rf, lines.join('\n'), payload);
    },
  );

  // -----------------------------------------------------------------------
  // #423 mutation_log_export — readable audit trail
  // -----------------------------------------------------------------------
  server.tool(
    'mutation_log_export',
    'Render the JSONL mutation history as a CSV or markdown report, date/uri-filtered — '
      + 'an audit trail you can actually read. Local file only, zero API calls.',
    {
      from: z.string().optional().describe('Start date (inclusive), YYYY-MM-DD'),
      to: z.string().optional().describe('End date (inclusive), YYYY-MM-DD'),
      format: z.enum(['markdown', 'csv']).optional().default('markdown'),
      max_results: MaxResults,
      response_format: ResponseFormat,
    },
    async (args) => {
      const rf = args.response_format as ResponseFormatValue;
      type LogRow = { ts?: string; who?: string; method?: string; path?: string; snapshot_id?: string };
      let rows: LogRow[] = [];
      try {
        const raw = await readFile(historyFilePath(), 'utf8');
        rows = raw.trim().split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l) as LogRow; } catch { return {}; } });
      } catch {
        return emit(rf, 'No mutation history found (history is opt-in: set SPOTIFY_MCP_HISTORY=1).', { ok: false, error: 'no_history' });
      }
      if (args.from) rows = rows.filter((r) => (r.ts ?? '') >= args.from!);
      if (args.to) rows = rows.filter((r) => (r.ts ?? '').slice(0, 10) <= args.to!);
      const maxResults = resolveMaxResults(args.max_results, getConfig().maxItems);
      const t = truncateItems(rows, maxResults);
      if (args.format === 'csv') {
        const csv = ['ts,who,method,path,snapshot_id', ...t.items.map((r) => [r.ts ?? '', r.who ?? '', r.method ?? '', r.path ?? '', r.snapshot_id ?? ''].map((f) => `"${f.replace(/"/g, '""')}"`).join(','))].join('\n');
        return emit(rf, csv, { ok: true, rows: t.returned, total: rows.length, truncated: t.truncated });
      }
      const md = [
        '| Timestamp | Who | Method | Path | Snapshot |',
        '| --- | --- | --- | --- | --- |',
        ...t.items.map((r) => `| ${r.ts ?? ''} | ${r.who ?? ''} | ${r.method ?? ''} | ${r.path ?? ''} | ${r.snapshot_id ?? ''} |`),
        ...(t.footer ? ['', `(${t.footer})`] : []),
      ].join('\n');
      return emit(rf, md, { ok: true, rows: t.returned, total: rows.length, truncated: t.truncated });
    },
  );

  // -----------------------------------------------------------------------
  // #424 undo_preview — dry-run for undo_mutation
  // -----------------------------------------------------------------------
  server.tool(
    'undo_preview',
    'Dry-run for undo_mutation: shows exactly what a receipt-driven revert WOULD do (diff of '
      + 'before/after, target inversion calls) without executing. 0-2 reads.',
    {
      mutation_id: z.string().min(1).describe('Receipt id (rcpt_N) to preview reverting'),
      check: z.boolean().optional().default(false)
        .describe('Optionally verify the target still exists (1 read)'),
      response_format: ResponseFormat,
    },
    async (args) => {
      const rf = args.response_format as ResponseFormatValue;
      const receipt = verifyReceipt(args.mutation_id);
      if (!receipt) {
        return emit(rf, `Unknown receipt "${args.mutation_id}" — receipts are session-scoped and kept for the most recent 100 mutations.`, { ok: false, error: 'unknown_receipt' });
      }
      const invert = receipt.kind === 'playlist_items'
        ? `DELETE /playlists/${receipt.id ?? '?'}/items with ${receipt.uris.length} uri(s)`
        : receipt.kind === 'library'
          ? `DELETE /me/library?uris=... with ${receipt.uris.length} uri(s)`
          : 'not reversible';
      const changes = [
        `Invert ${receipt.kind} ${receipt.id ?? ''}: ${invert}`,
        `Receipt verified at mutation time: ${receipt.verified}`,
        `Occurrences before/after: ${receipt.before ?? '?'}/${receipt.after ?? '?'}`,
        ...receipt.uris.slice(0, 5).map((u) => `  - ${u}`),
        ...(receipt.uris.length > 5 ? [`  …and ${receipt.uris.length - 5} more`] : []),
      ];
      let checkResult: string | null = null;
      if (args.check && receipt.kind === 'playlist_items' && receipt.id) {
        const pl = await client.get<{ name?: string }>(`/playlists/${encodeURIComponent(receipt.id)}`);
        checkResult = pl ? `target playlist "${pl.name ?? receipt.id}" still exists` : 'target playlist no longer exists — undo would fail';
      }
      const payload = {
        ok: true, dry_run: true, receipt_id: args.mutation_id, kind: receipt.kind, id: receipt.id,
        uris: receipt.uris, planned_inversion: invert, check: checkResult,
        reversible: receipt.kind === 'playlist_items' || receipt.kind === 'library',
      };
      return emit(rf, describeDryRun('undo', args.mutation_id, changes) + (checkResult ? `\nCheck: ${checkResult}` : ''), payload);
    },
  );

  // -----------------------------------------------------------------------
  // #425 receipt_lookup — find receipts by id/date/uri
  // -----------------------------------------------------------------------
  server.tool(
    'receipt_lookup',
    'Find mutation receipts by id, date range or affected URI — closes the receipts loop '
      + '(issue → lookup). Local, zero API calls.',
    {
      id: z.string().optional().describe('Exact receipt id (rcpt_N)'),
      since: z.string().optional().describe('Only receipts issued... they carry no wall-clock; use id/uri filters mostly'),
      uri: z.string().optional().describe('Match receipts whose URI list contains this URI'),
      response_format: ResponseFormat,
    },
    async (args) => {
      const rf = args.response_format as ResponseFormatValue;
      let rows = getAllReceipts();
      if (args.id) rows = rows.filter((r) => r.receipt_id === args.id);
      if (args.uri) rows = rows.filter((r) => r.uris.includes(args.uri!));
      const sinceTs = args.since ? ts(args.since) : NaN;
      if (Number.isFinite(sinceTs)) {
        // Receipts do not persist timestamps; approximate ordering by id sequence number.
        rows = rows.filter((r) => Number(r.receipt_id.replace(/\D/g, '')) * 1 >= Number(args.since!.replace(/\D/g, '')));
      }
      const payload = {
        ok: true, matches: rows.length,
        receipts: rows.map((r) => ({ receipt_id: r.receipt_id, kind: r.kind, id: r.id, verified: r.verified, uris: r.uris, missing: r.missing, windowExceeded: r.windowExceeded ?? false })),
        note: 'receipts are session-scoped (in-memory, FIFO 100)',
      };
      const lines = [`Receipt lookup (${rows.length} match(es)):`];
      for (const r of rows) lines.push(`• ${r.receipt_id} — ${r.kind}${r.id ? ` ${r.id}` : ''} ${r.verified ? 'VERIFIED' : 'UNVERIFIED'} (${r.uris.length} uri(s))`);
      if (rows.length === 0) lines.push('  (none — issue a mutation first, or receipts were evicted)');
      return emit(rf, lines.join('\n'), payload);
    },
  );

  // -----------------------------------------------------------------------
  // #426 export_playlist_json — full-fidelity export
  // -----------------------------------------------------------------------
  server.tool(
    'export_playlist_json',
    'Full-fidelity JSON export of one playlist: items + added_at + added_by + URIs (the '
      + 'fields CSV/M3U lose). 1 read.',
    {
      playlist_id: z.string().min(1).describe('Playlist ID'),
      max_results: MaxResults,
      response_format: ResponseFormat,
    },
    async (args) => {
      const rf = args.response_format as ResponseFormatValue;
      const meta = await client.get<{ name?: string; owner?: { id?: string }; uri?: string; tracks?: { total?: number } }>(`/playlists/${encodeURIComponent(args.playlist_id)}`);
      if (!meta) return emit(rf, `Playlist "${args.playlist_id}" not found.`, { ok: false, error: 'not_found' });
      const items = await client.getAllPages<PlaylistRow>(`/playlists/${encodeURIComponent(args.playlist_id)}/items`, { limit: '100' });
      const maxResults = resolveMaxResults(args.max_results, getConfig().maxItems);
      const t = truncateItems(items, maxResults);
      const doc = {
        playlist: {
          id: args.playlist_id, name: meta.name ?? null, owner: meta.owner?.id ?? null, uri: meta.uri ?? null,
          total_tracks: meta.tracks?.total ?? items.length,
        },
        exported_at: new Date().toISOString(),
        item_count: items.length, returned: t.returned, truncated: t.truncated,
        items: t.items.map((r, i) => ({
          position: i,
          uri: r?.item?.uri ?? null,
          name: r?.item?.name ?? null,
          artists: r?.item?.artists?.map((a) => a.name) ?? [],
          album: r?.item?.album?.name ?? null,
          duration_ms: r?.item?.duration_ms ?? null,
          added_at: r?.added_at ?? null,
          added_by: r?.added_by?.id ?? null,
        })),
      };
      return emit(rf, JSON.stringify(doc, null, 2), doc as unknown as Record<string, unknown>);
    },
  );

  // -----------------------------------------------------------------------
  // #427 device_sync_state — reconcile sidecar labels vs live devices
  // -----------------------------------------------------------------------
  server.tool(
    'device_sync_state',
    'Reconcile sidecar device labels/volume presets (and scene device hints) against the '
      + 'live device list; flags dead labels and can prune them. 1 read + sidecar. dry_run plans.',
    {
      prune: z.boolean().optional().default(false).describe('Remove dead device presets/labels from the sidecar'),
      dry_run: z.boolean().optional().default(true).describe('Plan the prune without writing (default true).'),
      response_format: ResponseFormat,
    },
    async (args) => {
      const rf = args.response_format as ResponseFormatValue;
      const live = await client.get<GetDevicesShape>('/me/player/devices');
      const liveNames = new Set((live?.devices ?? []).map((d) => d.name));
      const liveIds = new Set((live?.devices ?? []).map((d) => d.id));
      const matches = (label: string) => liveNames.has(label) || liveIds.has(label);
      const ext = await loadPlaybackExt();
      const deadPresets = Object.keys(ext.devicePresets).filter((label) => !matches(label));
      const sceneStore = await loadScenes();
      const deadScenes = Object.entries(sceneStore)
        .filter(([, s]) => s.device_hint !== undefined && !matches(s.device_hint))
        .map(([name]) => name);
      const payload = {
        ok: true, live_devices: (live?.devices ?? []).map((d) => ({ id: d.id, name: d.name, type: d.type })),
        dead_presets: deadPresets, dead_scene_hints: deadScenes,
      };
      if (!args.prune || args.dry_run) {
        return emit(rf, describeDryRun('device-sidecar sync', '~/.spotify-mcp sidecars', [
          `Dead presets: ${deadPresets.join(', ') || 'none'}`,
          `Scenes with dead device hints: ${deadScenes.join(', ') || 'none'}`,
          args.prune ? 'Re-run with dry_run=false to prune.' : 'Pass prune=true to remove them.',
        ]), payload);
      }
      for (const label of deadPresets) delete ext.devicePresets[label];
      for (const name of deadScenes) delete sceneStore[name].device_hint;
      await savePlaybackExtSafe(ext);
      await saveScenesSafe(sceneStore);
      return emit(rf, `Pruned ${deadPresets.length} dead preset(s) and ${deadScenes.length} dead scene hint(s).`, { ...payload, pruned: true });
    },
  );
}

// ---------------------------------------------------------------------------
// Internal write helpers used by device_sync_state (kept near the bottom so
// the registration body stays readable).
// ---------------------------------------------------------------------------

interface GetDevicesShape { devices?: Array<{ id: string; name: string; type: string; is_active?: boolean; volume_percent?: number }> }

type SceneStore = Record<string, { device_hint?: string; volume?: number; shuffle?: boolean; repeat?: 'off' | 'track' | 'context'; context_uri?: string }>;
type PlaybackExtStore = { states: Record<string, unknown>; devicePresets: Record<string, unknown>; sessions: Record<string, unknown>; smartRules: Record<string, unknown>; showDigest?: unknown };

async function saveScenesSafe(store: SceneStore): Promise<void> {
  const file = scenesFilePath();
  await mkdir(dirname(file), { recursive: true, mode: 0o700 });
  await writeFile(file, `${JSON.stringify(store, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
}

async function savePlaybackExtSafe(store: PlaybackExtStore): Promise<void> {
  const file = playbackExtFile();
  await mkdir(dirname(file), { recursive: true, mode: 0o700 });
  await writeFile(file, `${JSON.stringify(store, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
}

/** Footer helper for discover_weekly_diff prose. */
function saveLine(args: { save_after?: boolean; dry_run?: boolean }): string {
  if (args.save_after && !args.dry_run) return ' — archive synced to this week\'s copy';
  if (args.save_after) return ' — archive would be synced (dry run)';
  return '';
}
