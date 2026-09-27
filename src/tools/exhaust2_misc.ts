/**
 * exhaust2 misc slice — feature swarm v1.24.0.
 *
 * Owned by the fix/exhaust2-misc builder. All tools in this slice are
 * registered here and nowhere else. Slice issue set: GitHub issues #401-#427.
 *
 * Conventions (repo-wide):
 *   - Shared shaping helpers from ../shaping.ts (ResponseFormat/MaxResults/
 *     resolveMaxResults/truncateItems) — never hand-rolled.
 *   - Mutating tools use the shared `DryRunDefault` fragment (default TRUE)
 *     and branch on `isDryRun(args)`, so an omitted flag previews and the
 *     write is an explicit opt-in (#827).
 *   - Phantom endpoints are never faked: honest workarounds carry an explicit
 *     disclosure line in their description.
 *   - No deprecated endpoints (SPEC §9). Gated surfaces fail gracefully.
 *
 * Sidecar state owned by this slice lives in ~/.spotify-mcp/exhaust2-misc.json
 * (override with SPOTIFY_MCP_EXHAUST2_MISC_FILE): taste checkpoints, chapter
 * bookmarks, listening journal, archived monthly reports. Owner-only modes.
 */
import { z } from 'zod';
import { capFor } from '../chunk.js';
import { ARTIST_ALBUM_PAGE_LIMIT, MARKET_CODE } from './catalog.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { chmod, mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { SpotifyClient } from '../client.js';
import { SpotifyApiError, quotaPreflight, quotaSnapshot, quotaWindowRemaining, quotaDelta } from '../client.js';
import {
  ResponseFormat,
  MaxResults,
  DryRunDefault,
  isDryRun,
  resolveMaxResults,
  truncateItems,
  describeDryRun,
  DryRunScan,
  readString,
  capRowSections,
} from '../shaping.js';
import type { ResponseFormatValue, SectionCap } from '../shaping.js';
import type { PlaybackState } from '../types/spotify.js';
import { getConfig, storePath } from '../config.js';
import {
  confirmViaElicitation,
  describeConfirmation,
  requiredConfirmationRefusal,
  REMOVE_ELICIT_THRESHOLD,
} from './confirm.js';
import { loadTokens } from '../auth.js';
import { WRITE_SCOPE_REQUIREMENTS, moduleBlockedByScopes, scopesFor } from '../scopefilter.js';
import { loadScenes, scenesFilePath } from './scenes.js';
import { loadPlaybackExt, playbackExtFile } from './playbackext.js';
import { genreTagsPath, loadGenreTags } from './libraryinsights.js';
import { loadSidecar, SidecarUnreadableError } from '../sidecar.js';
import { historyFilePath, isHistoryEnabled, readHistory } from '../history.js';
import type { HistoryRecord } from '../history.js';
import {
  verifyReceipt,
  getAllReceipts,
  receiptMissMessage,
  isReceiptsPersistent,
  receiptsFilePath,
  receiptRetentionLabel,
  MAX_RECEIPTS,
} from '../receipts.js';
import { emit, type EmitOptions } from '../result.js';
import { spotifyRef } from '../refs.js';

// ---------------------------------------------------------------------------
// Shared shapes + result helpers
// ---------------------------------------------------------------------------

/**
 * #895: in `json` mode this module prints a bounded summary of the payload,
 * not the payload. The host already has the whole thing as `structuredContent`,
 * so printing it too charged the host twice for one object — and these payloads
 * carry capped section sets, so the second copy is the expensive one.
 *
 * This is the shared `emit`'s `jsonSummary` option rather than a module-local
 * wrapper: a wrapper re-implements the prose/json dispatch, which is the drift
 * #582 exists to prevent, and `emit` is the one name the consolidation gate
 * counts copies of. A constant is the honest form of "every call site in this
 * module chooses to summarise" — it says so without a second implementation.
 */
const SUMMARISE_JSON: EmitOptions = { jsonSummary: summarizeExhaust2 };

/**
 * One-line text for a json-mode call whose payload sits in
 * `structuredContent` (#895). Bounded by construction: capped-section counts
 * plus at most six scalar counters, never a row.
 */
const SUMMARY_COUNT_FIELDS = 6;

function summarizeExhaust2(payload: Record<string, unknown>): string {
  const sections = payload.sections as Record<string, SectionCap> | undefined;
  const parts: string[] = [];
  if (sections) {
    for (const [key, section] of Object.entries(sections)) {
      parts.push(
        section.unreadable
          ? `${key} (unreadable)`
          : `${key}: ${section.returned}/${section.total}`,
      );
    }
  }
  const counts = Object.entries(payload)
    .filter(([, value]) => typeof value === 'number' && Number.isFinite(value))
    .slice(0, SUMMARY_COUNT_FIELDS)
    .map(([key, value]) => `${key}=${value as number}`);
  const tail = [
    parts.length > 0 ? `Sections: ${parts.join(', ')}.` : '',
    counts.length > 0 ? `Counts: ${counts.join(', ')}.` : '',
  ].filter(Boolean).join(' ');
  return `Full payload in structuredContent.${tail.length > 0 ? ` ${tail}` : ''}`;
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
function monthBounds(month?: string): { start: number; end: number; label: string } {
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
function countSessions(playedAt: readonly string[]): number {
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
async function loadPlaysBetween(
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

interface TasteCheckpoint {
  label: string;
  saved_at: string;
  time_range: string;
  artists: Array<{ name: string; genres: string[] }>;
  tracks: Array<{ name: string; artist_names: string[]; uri: string }>;
}

interface ChapterBookmark {
  book_uri: string;
  label: string;
  position_ms: number;
  chapter_name?: string;
  created_at: string;
}

interface JournalEntry {
  ts: string;
  note: string;
  session?: string;
  tag?: string;
}

interface MiscStore {
  checkpoints: Record<string, TasteCheckpoint>;
  bookmarks: Record<string, ChapterBookmark[]>;
  journal: JournalEntry[];
  reports: Record<string, unknown>;
}

export function miscFilePath(env: NodeJS.ProcessEnv = process.env): string {
  return storePath('exhaust2-misc', env);
}

/** Load the slice sidecar; ENOENT yields empty, every other failure throws #1051. */
async function loadMiscStore(env: NodeJS.ProcessEnv = process.env): Promise<MiscStore> {
  return loadSidecar<MiscStore>(
    miscFilePath(env),
    () => ({ checkpoints: {}, bookmarks: {}, journal: [], reports: {} }),
    (parsed) => {
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new Error('top level is not a JSON object');
      }
      const p = parsed as Record<string, unknown>;
      // checkpoints and bookmarks are per-key maps; reports is an opaque bag;
      // journal is an append-only array. A wrong shape in any of them would
      // surface as a confusing write-time TypeError — block it at load.
      if (p.checkpoints !== undefined && (typeof p.checkpoints !== 'object' || p.checkpoints === null || Array.isArray(p.checkpoints))) {
        throw new Error('"checkpoints" is not a JSON object');
      }
      if (p.bookmarks !== undefined && (typeof p.bookmarks !== 'object' || p.bookmarks === null || Array.isArray(p.bookmarks))) {
        throw new Error('"bookmarks" is not a JSON object');
      }
      if (p.journal !== undefined && !Array.isArray(p.journal)) {
        throw new Error('"journal" is not an array');
      }
      if (p.reports !== undefined && (typeof p.reports !== 'object' || p.reports === null || Array.isArray(p.reports))) {
        throw new Error('"reports" is not a JSON object');
      }
      return {
        checkpoints: (p.checkpoints ?? {}) as Record<string, TasteCheckpoint>,
        bookmarks: (p.bookmarks ?? {}) as Record<string, ChapterBookmark[]>,
        journal: (p.journal ?? []) as JournalEntry[],
        reports: (p.reports ?? {}) as Record<string, unknown>,
      };
    },
  );
}

/** Persist the slice sidecar: owner-only dir and file modes. */
export async function saveMiscStore(store: MiscStore, env: NodeJS.ProcessEnv = process.env): Promise<void> {
  const file = miscFilePath(env);
  await mkdir(dirname(file), { recursive: true, mode: 0o700 });
  await writeFile(file, `${JSON.stringify(store, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  // #1084: mode only applies at creation; re-assert so a pre-existing or
  // copied-in store does not stay world-readable after this write.
  await chmod(file, 0o600);
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


/** Unified library save/remove (chunked by CHUNK_CAPS.library_writes, like save_to_library). */
export async function modifyLibrary(client: SpotifyClient, uris: readonly string[], op: 'save' | 'remove'): Promise<number> {

  let n = 0;
  const libCap = capFor('library_writes');
  for (let i = 0; i < uris.length; i += libCap) {
    const chunk = uris.slice(i, i + libCap).join(',');
    if (op === 'save') await client.put(`/me/library?uris=${encodeURIComponent(chunk)}`);
    else await client.delete(`/me/library?uris=${encodeURIComponent(chunk)}`);
    n += Math.min(libCap, uris.length - i);
  }
  return n;
}

/** Followed artists via the cursor-paged /me/following endpoint. */
async function loadFollowedArtists(client: SpotifyClient, max = 200): Promise<Array<{ id: string; name: string; genres: string[] }>> {
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
      market: MARKET_CODE.optional().describe('ISO-3166 market code passed on the player read, e.g. \'US\''),
      dry_run: DryRunDefault,
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
      if (isDryRun(args) || uris.length === 0) {
        return emit(rf, `[dry run] quick_save_now (${source}) — nothing was changed.\n${plan}`, {
          ok: uris.length > 0, dry_run: true, source, uris,
          ...(uris.length === 0 ? { hint: 'Nothing currently playing and no recent plays found.' } : {}),
        }, SUMMARISE_JSON);
      }
      await modifyLibrary(client, uris, 'save');
      return emit(rf, `Saved ${uris.length} track${uris.length === 1 ? '' : 's'} to library (${source}):\n${picks.map((p) => `  • ${p.name ?? p.uri}`).join('\n')}`, {
        ok: true, source, saved: uris, count: uris.length,
      }, SUMMARISE_JSON);
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
          { include_groups: 'album,single', limit: String(ARTIST_ALBUM_PAGE_LIMIT) },
        );
        for (const alb of page?.items ?? []) {
          const rd = alb.release_date ?? '';
          if (rd && Date.parse(rd) >= since) freshAlbums.push({ artist: a.name, album: alb.name ?? 'unknown', release_date: rd });
        }
      }
      const shows = await client.getAllPages<{ show?: { id?: string; name?: string; total_episodes?: number } }>('/me/shows', { limit: '50' }, { maxItems: args.max_shows });
      const newEpisodes: Array<{ show: string; episode: string; released: string }> = [];
      const backlog: Array<{ show: string; total_episodes: number | null }> = [];
      let skippedShows = 0;
      for (const row of shows.slice(0, args.max_shows)) {
        const show = row.show;
        if (!show) continue;
        backlog.push({ show: show.name ?? 'unknown', total_episodes: show.total_episodes ?? null });
        // #1343: the show id used to be laundered through a cast and
        // defaulted to `''`, which built the request path `/shows//episodes` —
        // a URL that is not any show, so the read either 404s or returns
        // something the briefing then attributes to this show. A show whose id
        // could not be read is counted as unread and skipped, like a throttled
        // one, rather than asked about through a path nobody can have meant
        // (#803: fall back to a value that cannot itself be wrong).
        const showId = readString(show, 'id');
        if (showId === undefined) { skippedShows++; continue; }
        let ep: { items?: Array<{ name?: string; release_date?: string; resume_point?: { fully_played?: boolean } }> } | null;
        try {
          ep = await client.get<{ items?: Array<{ name?: string; release_date?: string; resume_point?: { fully_played?: boolean } }> }>(
            `/shows/${encodeURIComponent(showId)}/episodes`,
            { limit: '10' },
          );
        } catch (e) {
          // A throttled/gated show must not kill the whole briefing — skip it.
          if (e instanceof SpotifyApiError && (e.status === 429 || e.status === 403)) { skippedShows++; continue; }
          throw e;
        }        for (const e of ep?.items ?? []) {
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
      }, SUMMARISE_JSON);
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
      return emit(rf, lines.join('\n') + archivedLine, payload, SUMMARISE_JSON);
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
      // #895: this used to stringify the payload and hand the STRING to emit(, SUMMARISE_JSON)
      // as the prose, which emit(, SUMMARISE_JSON) then ignored in favour of stringifying the
      // same object again for the text block. Two serializations, one of them
      // thrown away. `tops` is left whole on purpose: it is bounded upstream at
      // `limit: '50'` per range, not an unbounded scan, so a row cap here would
      // trim an already-bounded answer and say nothing useful in its place.
      if (args.output_format === 'json' || rf === 'json') return emit(rf, '', payload, SUMMARISE_JSON);
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
      return emit(rf, lines.join('\n'), payload, SUMMARISE_JSON);
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
      }, SUMMARISE_JSON);
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
        }, SUMMARISE_JSON);
      }
      const a = s.checkpoints[args.from];
      const b = s.checkpoints[args.to];
      if (!a || !b) {
        return emit(rf, `Unknown checkpoint(s): ${[!a && args.from, !b && args.to].filter(Boolean).join(', ')}. Available: ${labels.join(', ')}`, { ok: false, available: labels }, SUMMARISE_JSON);
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
      return emit(rf, lines.join('\n'), payload, SUMMARISE_JSON);
    },
  );

  // -----------------------------------------------------------------------
  // #407 discover_weekly_diff — this week vs the archived copy
  // -----------------------------------------------------------------------
  server.tool(
    'discover_weekly_diff',
    'This week\'s Discover Weekly vs the last copy in your archive playlist: what is new, '
      + 'what overlapped, and which tracks you already liked. 2-3 reads (+1 write only with '
      + 'save_after and dry_run=false). save_after REPLACES the archive playlist\'s whole item '
      + 'list, so it previews by default. Resolves both playlists by exact name.',
    {
      archive_name: z.string().optional().default('Discover Weekly Archive')
        .describe('Archive playlist name kept by save_discover_weekly. Default "Discover Weekly Archive".'),
      liked_cap: z.number().int().min(0).max(2000).optional().default(500)
        .describe('How many saved tracks to scan for "already liked" detection. Default 500.'),
      save_after: z.boolean().optional().default(false)
        .describe('After the diff, sync the archive playlist to this week\'s copy (adds writes)'),
      dry_run: DryRunDefault,
      response_format: ResponseFormat,
    },
    async (args) => {
      const rf = args.response_format as ResponseFormatValue;
      const dw = await findPlaylistByName(client, 'Discover Weekly');
      if (!dw) {
        return emit(rf, 'Could not find "Discover Weekly" in your playlists (it appears in /me/playlists only while active — try again on a refresh).', { ok: false, error: 'source_not_found' }, SUMMARISE_JSON);
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
      const dryRun = isDryRun(args);
      const payload = {
        ok: true, discover_weekly_id: dw.id, total: current.length,
        new_since_archive: fresh, overlapping: overlap, already_liked: alreadyLiked,
        archive_found: archive !== null, archive_id: archive?.id ?? null,
        // #827: always state the mode that produced this payload, so a caller
        // that passed save_after and got a diff back can tell a preview from a
        // committed archive replace.
        dry_run: dryRun,
      };
      if (args.save_after && archive) {
        if (dryRun) {
          return emit(rf, `${describeDryRun('sync Discover Weekly', args.archive_name, [`Would replace ${archive.name} with ${current.length} tracks`])}`, { ...payload, dry_run: true }, SUMMARISE_JSON);
        }
        if (current.length > 0) {
          const writeCap = capFor('playlist_writes');
          await client.put(`/playlists/${encodeURIComponent(archive.id)}/items`, { uris: current.slice(0, writeCap) });
          for (let i = writeCap; i < current.length; i += writeCap) {
            await client.post(`/playlists/${encodeURIComponent(archive.id)}/items`, { uris: current.slice(i, i + writeCap) });
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
      return emit(rf, lines.join('\n'), payload, SUMMARISE_JSON);
    },
  );

  // -----------------------------------------------------------------------
  // #408 dead_library_finder — unsave candidates
  // -----------------------------------------------------------------------

  /**
   * Worst-case request cost of one `dead_library_finder` scan (#896).
   *
   * Exported from the module scope so the cooldown gate, the dry run and the
   * executed path all quote the SAME number. The previous figures
   * (`max_playlists + 2`) counted the playlist LIST walk and nothing else, so
   * every one of them under-reported the real cost by the per-playlist paging
   * factor — ~280 requests reported as ~52.
   *
   * `maxPlaylists` is coerced rather than trusted: handlers are also invoked
   * directly, with a hand-built args object on which zod's `.default()` has
   * not run, so `args.max_playlists` can be `undefined` here. `Math.min(
   * undefined, x)` is `NaN`, and a bound of `NaN` renders as
   * `Worst-case cost: <=NaN requests` — a preview that is worse than no
   * preview, so the declared default is applied explicitly.
   */
  const DEAD_LIBRARY_DEFAULT_MAX_PLAYLISTS = 50;
  const positiveOr = (value: unknown, fallback: number): number =>
    typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;

  const deadLibraryRequestBound = (maxPlaylists: unknown): number => {
    const playlists = positiveOr(maxPlaylists, DEAD_LIBRARY_DEFAULT_MAX_PLAYLISTS);
    const fetchAllCap = getConfig().fetchAllCap;
    const SAVED_PAGE = 50;
    const ITEM_PAGE = 100;
    const PER_PLAYLIST_ITEM_CAP = 500;
    return Math.max(1, Math.ceil(fetchAllCap / SAVED_PAGE)) // /me/tracks
      + Math.max(1, Math.ceil(Math.min(1000, fetchAllCap) / SAVED_PAGE)) // recently-played
      + Math.max(1, Math.ceil(playlists / SAVED_PAGE)) // /me/playlists
      + playlists * Math.max(1, Math.ceil(PER_PLAYLIST_ITEM_CAP / ITEM_PAGE)); // each playlist, paged
  };

  /** The two row arrays `dead_library_finder` publishes; both are the dead set. */
  const DEAD_LIBRARY_ROW_ARRAYS = ['candidates', 'details'] as const;

  /**
   * The audit section, withheld from the human-facing modes (#1517).
   *
   * The same argument `library_hygiene` withholds `groups` for — the array is
   * the record of what happened rather than a rendered view of it — with a
   * sharper edge here, because what it records is a `DELETE /me/library` that
   * cannot be undone. Capping the only per-row record of an irreversible
   * mutation leaves a caller able to say how many tracks were unsaved and
   * unable to say which. `candidates` is not on this list; see the call site.
   */
  const DEAD_LIBRARY_WITHHELD_ROWS = ['details'] as const;

  server.tool(
    'dead_library_finder',
    'Find saved tracks that never appear in your recent history AND sit in none of your '
      + 'playlists — unsave candidates. Local compute over /me/tracks + playlists + history. '
      + 'dry_run defaults to true and issues ZERO requests: it reports the request bound and says the '
      + 'candidate list is unknown, because only the scan can compute it. '
      + 'disabling it actually removes the candidates. Removing 10+ candidates additionally requires elicitation confirmation (or SPOTIFY_MCP_CONFIRM=never for automation).',
    {
      min_age_days: z.number().int().min(1).max(3650).optional().default(30)
        .describe('Only consider tracks saved at least this long ago. Default 30.'),
      max_playlists: z.number().int().min(0).max(500).optional().default(50)
        .describe('Budget for playlist scans (each scan pages that playlist). Default 50.'),
      dry_run: DryRunDefault,
      max_results: MaxResults,
      response_format: ResponseFormat,
    },
    async (args) => {
      const rf = args.response_format as ResponseFormatValue;
      const gate = quotaPreflight(client);
      if (gate.blocked) {
        return emit(rf, gate.message, {
          ok: false, cooldown: true, wait_sec: gate.waitSec, requests_made: 0,
          // #896: this used to report `max_playlists + 2` (~52), which is not
          // what the scan costs — each of those playlists is then paged. A
          // blocked-scan message that names the wrong cost is the same lie as
          // a preview that under-reports it, in the one place the caller is
          // already being told to wait.
          requests_planned: deadLibraryRequestBound(args.max_playlists),
        }, SUMMARISE_JSON);
      }
      const snapshot = quotaSnapshot(client);
      const windowRemaining = quotaWindowRemaining(client);
      const maxPlaylists = Math.min(positiveOr(args.max_playlists, DEAD_LIBRARY_DEFAULT_MAX_PLAYLISTS), windowRemaining);
      const shrink = maxPlaylists < positiveOr(args.max_playlists, DEAD_LIBRARY_DEFAULT_MAX_PLAYLISTS);

      // ---------------------------------------------------------------------
      // #896 — the dry run must short-circuit BEFORE any read.
      //
      // This branch used to sit at the very END of the handler, after
      // /me/tracks, after up to 1000 recently-played, and after paging up to
      // `max_playlists` playlists 500 items each — roughly 280 requests. Since
      // `dry_run` DEFAULTS TO TRUE here, the documented-safe path was the most
      // expensive call in the module, and preview-then-apply paid it twice.
      //
      // The candidate set is genuinely not knowable from the arguments: it is
      // the set of saved tracks that are neither recently played nor present in
      // any playlist, and both halves are answers only the scan can produce. So
      // this preview does NOT invent a count. It reports the request bound, and
      // says plainly that the candidate list is unknown until the scan runs.
      // Returning `count: 0` here would be the #803 class of lie — a value that
      // could not be read, coerced into a plausible one.
      // ---------------------------------------------------------------------
      const fetchAllCap = getConfig().fetchAllCap;
      const SAVED_PAGE = 50;
      const ITEM_PAGE = 100;
      const PER_PLAYLIST_ITEM_CAP = 500;
      const RECENT_CAP = Math.min(1000, fetchAllCap);
      const savedPages = Math.max(1, Math.ceil(fetchAllCap / SAVED_PAGE));
      const recentPages = Math.max(1, Math.ceil(RECENT_CAP / SAVED_PAGE));
      const listPages = Math.max(1, Math.ceil(maxPlaylists / SAVED_PAGE));
      const itemPagesPerPlaylist = Math.max(1, Math.ceil(PER_PLAYLIST_ITEM_CAP / ITEM_PAGE));
      // Every one of the `maxPlaylists` playlists the list walk can return is
      // then paged to the per-playlist cap — the same multiplication #896 caught
      // in `saved_vs_playlist_coverage`. Shares its math with the cooldown gate.
      const estimatedRequestsMax = deadLibraryRequestBound(maxPlaylists);
      const shrinkWarrant = shrink ? { requests_planned: estimatedRequestsMax, budget_shrunk: true } : {};

      if (isDryRun(args)) {
        const knownPart = savedPages + recentPages + listPages;
        return emit(rf,
          `[dry run] dead-library cleanup — nothing was changed, and NO requests were made.\n`
          + `Commiting (dry_run=false) would walk /me/tracks (up to ${savedPages} page(s) for ${fetchAllCap} saved items), `
          + `/me/player/recently-played (up to ${recentPages} page(s)), /me/playlists (up to ${listPages} page(s), at most ${maxPlaylists} playlists), `
          + `then up to ${itemPagesPerPlaylist} item page(s) for EACH of those playlists.\n`
          + `Worst-case cost: <=${estimatedRequestsMax} requests${shrink ? ` (budget shrunk to ${maxPlaylists} playlists by recent throttling)` : ''}.\n`
          + `The unsave-candidate list is UNKNOWN from the arguments alone: a track qualifies only if it is in neither your recent 90 days of plays nor any scanned playlist, `
          + `and neither is knowable without those reads. This preview therefore reports the COST, not a candidate list. `
          + `Re-run with dry_run=false to compute and commit the candidates.`,
          {
            ok: true,
            dry_run: true,
            // Explicitly NOT 0 and NOT []: the answer is unknown, not empty.
            count: null,
            candidates: null,
            candidates_known: false,
            candidates_note: 'unknown until the scan runs — requires /me/tracks + recently-played + per-playlist item reads',
            estimated_requests_max: estimatedRequestsMax,
            estimated_requests_known: knownPart,
            playlists_to_scan_max: maxPlaylists,
            requests_made: 0,
            ...quotaDelta(client, snapshot),
            ...shrinkWarrant,
          }, SUMMARISE_JSON);
      }

      const saved = await client.getAllPages<{ added_at?: string; track?: { uri?: string; name?: string; artists?: Array<{ name: string }> } }>('/me/tracks', { limit: '50' });
      const recent = await loadPlaysBetween(client, Date.now() - 90 * DAY_MS, Date.now(), 1000);
      const playedRecently = new Set(recent.map((p) => p.track.uri));
      const inPlaylist = new Set<string>();
      const lists = await client.getAllPages<{ id: string; name: string }>('/me/playlists', { limit: '50' }, { maxItems: maxPlaylists });
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
      // #895: `candidates` and `details` are the same rows shipped twice, whole,
      // in every mode — a scan of a large library returned the full dead-track
      // set to a caller that had asked for `max_results`. Both are capped, and
      // `count` keeps the exact pre-cap total so "how many were there" survives.
      //
      // #1517: the cap was the right control for `candidates` and the wrong one
      // for `details`, and it was applied to both. `details` is not a rendering
      // of the scan, it IS the record of it — the only statement of WHICH tracks
      // the `DELETE /me/library` below removed, which has no receipt and no
      // undo. Capped in every mode, a caller could still recover `count`/
      // `removed` (how many) and not the rows (which): a scan of 500 eligible
      // tracks reported 10 and deleted 500. #895 introduced this by wrapping
      // both arrays in `capRowSections` and leaving the write reading the
      // uncapped local; the aggregate was always honest, so nothing but a
      // per-row assertion could have caught it.
      //
      // `details` therefore follows the convention `library_hygiene` and
      // `find_duplicate_saved_tracks` already use for their own raw-scan array
      // (`groups`, SPEC.md §5): WITHHELD from the human-facing modes with the
      // shared helper's own `available_via` pointer, and returned WHOLE under
      // `response_format: 'json'`, which is the documented bulk export. The
      // pointer is the helper's fourth argument rather than a hand-rolled
      // `if (rf === 'json')` around the payload, so the disclosure is the one
      // SPEC.md §5 describes and `summarizeExhaust2` reads the same envelope
      // either way.
      //
      // `candidates` stays CAPPED rather than withheld, and that is a decision,
      // not an oversight. It is byte-redundant with `details` —
      // `candidates[i] === details[i].uri`, same rows, same order, same slice —
      // so it carries no fact `details` does not. Withholding it too would
      // delete a second copy of an answer the caller has just been told where
      // to re-fetch, and would cost the human-facing modes their row sample for
      // no gain in disclosure: `sections.candidates` already publishes
      // `returned`/`total`/`truncated` and the top level repeats it.
      const capForScan = resolveMaxResults(args.max_results, getConfig().maxItems);
      // json is the bulk export here for the same reason it is for
      // `library_hygiene`: the audit array is the raw scan, so `max_results` —
      // a cap on what is RETURNED (src/shaping.ts `MaxResults`) — does not
      // apply to it. The ceiling is the exact pre-cap LENGTH rather than a
      // skipped `capRowSections`, so `sections` is still published in every
      // mode, the #895 envelope test above keeps holding, and a json caller
      // reads `truncated: false` beside rows that are all present — a complete
      // result that says it is complete.
      const bulk = rf === 'json';
      // Nothing to withhold is nothing to withhold. `capRowSections` deletes a
      // withheld key and reports `{ truncated: true, withheld: true, total }`
      // unconditionally, so withholding an EMPTY `details` would tell a caller
      // that rows were withheld from a scan that found none — the #803 failure
      // one field over, and a new one, because until #1517 this call site never
      // passed a `withhold` list. The empty case falls through to the ordinary
      // cap, where an empty array is honestly `returned: 0, total: 0,
      // truncated: false`. (The helper itself still has this edge for any other
      // caller; #1517 does not widen the shared contract to fix it.)
      const withholdForScan = bulk || candidates.length === 0 ? [] : DEAD_LIBRARY_WITHHELD_ROWS;
      const payload = capRowSections({
        ok: true, scanned: { saved_tracks: saved.length, playlists: playlistsScanned, recent_plays: recent.length },
        candidates: candidates.map((c) => c.uri),
        details: candidates,
        count: candidates.length,
        estimated_requests_max: estimatedRequestsMax,
        ...quotaDelta(client, snapshot),
        ...shrinkWarrant,
      }, DEAD_LIBRARY_ROW_ARRAYS, bulk ? candidates.length : capForScan, withholdForScan);
      if (candidates.length === 0) return emit(rf, 'No dead tracks found — nothing to remove.', payload, SUMMARISE_JSON);
      // The WRITE reads the uncapped `candidates` local, not the payload, and
      // that independence is the point: #1517 widened the audit trail WITHOUT
      // narrowing the mutation. Capping the delete to the cap would have been
      // the other way to fix it, and it is the wrong one — `max_results` is
      // documented as a cap on what is RETURNED, and this module's own
      // `MaxResults` comment forbids it bounding work or durable output. A
      // caller who lowered it to shrink a reply would have silently unsaved
      // fewer tracks than the scan found. The regression test asserts the
      // DELETE set is identical in every response format, so this cannot be
      // traded back for the disclosure.
      //
      // #1544 reads the SAME list, hoisted to `removalUris` so the gate below
      // can ask about the count the write will actually consume. Gating on
      // `candidates.length` would be the pre-filter length and would let the
      // prompt and the mutation disagree.
      const removalUris = candidates.map((c) => c.uri).filter((u): u is string => typeof u === 'string');

      // #1544 — the gate every other removal of this size already has.
      //
      // The name is what makes this worth gating rather than renaming: an agent
      // picking a tool by name reads `dead_library_finder` as a report. The
      // shape is what the invariant is about. This is `DELETE /me/library` once
      // per candidate in `library_writes` chunks, over a set bounded by
      // `fetchAllCap` (500) rather than by anything the caller chose — a
      // qualifying library reaches that without effort, and `max_results` caps
      // only the REPORTED rows, not this list. So it is the same operation
      // `remove_from_playlist` and `remove_duplicate_playlist_items` are gated
      // for, and it reuses `REMOVE_ELICIT_THRESHOLD` rather than a new constant.
      //
      // The prompt lands after the scan because the scan is what produces the
      // count — the question is then answerable ("unsave 412 tracks?") instead
      // of blind, and the expensive part is not repeated. Gating on the count
      // the scan actually found is also why `candidates.length` cannot be the
      // thing asked about: it is the pre-filter length, and the write consumes
      // `removalUris`.
      if (removalUris.length >= REMOVE_ELICIT_THRESHOLD) {
        const preview = candidates.slice(0, 10);
        const verdict = await confirmViaElicitation(server, {
          message: describeConfirmation(
            `unsave ${removalUris.length} dead track(s) from your saved library`,
            'your library',
            [
              `These ${removalUris.length} track(s) are saved, older than ${args.min_age_days} day(s), and appear in neither your recent plays nor any scanned playlist:`,
              ...preview.map((c) => `${c.name} (saved ${c.added_at || 'unknown'})`),
              ...(removalUris.length > preview.length ? [`(…and ${removalUris.length - preview.length} more)`] : []),
              'They are deleted from your library. Anything absent from the scan is NOT removed.',
            ],
          ),
        });
        // The shared fail-closed guard — unchanged, and unchanged on purpose. An
        // unpromptable host and a prompt that dies mid-flight are both
        // refusals, so both get zero deletes rather than an unprompted 500.
        // SPOTIFY_MCP_CONFIRM=never (exactly that value) is the only bypass.
        const refusal = requiredConfirmationRefusal(verdict);
        if (refusal) return emit(rf, refusal.message, refusal.payload, SUMMARISE_JSON);
      }

      await modifyLibrary(client, removalUris, 'remove');

      // The prose list is bounded by the SAME `capForScan` the `candidates`
      // section went through, so the names a reader sees and
      // `sections.candidates` cannot disagree about how many rows exist. It is
      // deliberately NOT tied to `sections.details` any more: in the
      // human-facing modes that section is withheld (`returned: 0`), and a
      // rendered list that claimed to match it would be a second #803.
      const t = truncateItems(candidates, capForScan);
      const lines = [`Removed ${candidates.length} dead track(s):`];
      t.items.forEach((c) => lines.push(`  • ${c.name} (saved ${c.added_at || 'unknown'})`));
      if (t.footer) lines.push(`(${t.footer})`);
      return emit(rf, lines.join('\n'), { ...payload, removed: candidates.length }, SUMMARISE_JSON);
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
      dry_run: DryRunDefault,
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
      if (isDryRun(args)) {
        const changes = [
          existing
            ? `Would replace all item(s) in existing playlist "${label}"`
            : `Would create playlist "${label}"`,
          ...plays.slice(0, 5).map((p) => `${p.track.name ?? p.track.uri}`),
        ];
        return emit(rf, describeDryRun('week-in-review', label, changes), payload, SUMMARISE_JSON);
      }
      let id = existing?.id ?? null;
      if (existing && !args.rerun) {
        return emit(rf, `Playlist "${label}" already exists and rerun=false — nothing changed.`, { ...payload, ok: false, error: 'exists' }, SUMMARISE_JSON);
      }
      if (!id) {
        const created = await client.post<{ id: string }>('/me/playlists', { name: label, public: false, description: `Plays from ${isoDay(start)} to ${isoDay(end)} — created by week_in_review_playlist` });
        if (!created?.id) throw new Error(`Could not create playlist "${label}"`);
        id = created.id;
      }
      if (uris.length > 0) {
        const writeCap = capFor('playlist_writes');
        await client.put(`/playlists/${encodeURIComponent(id)}/items`, { uris: uris.slice(0, writeCap) });
        for (let i = writeCap; i < uris.length; i += writeCap) {
          await client.post(`/playlists/${encodeURIComponent(id)}/items`, { uris: uris.slice(i, i + writeCap) });
        }
      }
      return emit(rf, `"${label}" ready: ${uris.length} track(s), ${isoDay(start)} → ${isoDay(end)}.`, { ...payload, playlist_id: id }, SUMMARISE_JSON);
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
      return emit(rf, lines.join('\n'), payload, SUMMARISE_JSON);
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
      return emit(rf, lines.join('\n'), payload, SUMMARISE_JSON);
    },
  );

  // -----------------------------------------------------------------------
  // #412 playlist_staleness_report — rotting playlists
  // -----------------------------------------------------------------------
  server.tool(
    'playlist_staleness_report',
    'Per-playlist staleness report: newest/oldest added_at, median item age and count added '
      + 'in the last 90 days — find playlists rotting in place. With the default limit=50 and '
      + 'per_playlist_cap=500 that is up to 1 + 50*5 = 251 requests; pass dry_run=true for that '
      + 'bound with 0 requests made. A mid-walk 429 returns the rows gathered so far plus '
      + 'quota_hit_at_playlist rather than throwing.',
    {
      limit: z.number().int().min(1).max(500).optional().default(50)
        .describe('How many playlists to scan. Default 50.'),
      per_playlist_cap: z.number().int().min(10).max(2000).optional().default(500)
        .describe('Max items paged per playlist. Default 500.'),
      sort: z.enum(['median_age', 'oldest', 'name']).optional().default('median_age').describe('Report sort order'),
      dry_run: DryRunScan,
      max_results: MaxResults,
      response_format: ResponseFormat,
    },
    async (args) => {
      const rf = args.response_format as ResponseFormatValue;

      // #896: the cost of this report is knowable from the arguments alone —
      // 1 list walk plus, for EACH playlist it returns, the pages needed to
      // reach per_playlist_cap. Previewing it by performing it was the bug: the
      // tool had no dry run at all, so the only way to learn the price was to
      // pay it. Zero requests, bound from inputs.
      //
      // Both limits are coerced to their DECLARED defaults first: handlers are
      // also invoked directly with a hand-built args object that never went
      // through zod, and an uncoerced `undefined` would render the bound as
      // `NaN` — a preview that reports a number the scan can never match.
      const STALENESS_DEFAULT_LIMIT = 50;
      const STALENESS_DEFAULT_PER_PLAYLIST_CAP = 500;
      const maxLists = positiveOr(args.limit, STALENESS_DEFAULT_LIMIT);
      const perPlaylistCap = positiveOr(args.per_playlist_cap, STALENESS_DEFAULT_PER_PLAYLIST_CAP);
      const stalenessRequestBound = (n: number, perCap: number): number =>
        Math.max(1, Math.ceil(n / 50)) + n * Math.max(1, Math.ceil(perCap / 100));

      if (args.dry_run) {
        const bound = stalenessRequestBound(maxLists, perPlaylistCap);
        return emit(rf,
          `[dry run] playlist_staleness_report would walk /me/playlists (up to ${Math.max(1, Math.ceil(maxLists / 50))} page(s) for at most ${maxLists} playlists) `
          + `then page up to ${perPlaylistCap} items for EACH of them (up to ${Math.max(1, Math.ceil(perPlaylistCap / 100))} page(s) each). `
          + `Worst-case cost: <=${bound} requests (limit=${maxLists}, per_playlist_cap=${perPlaylistCap}); 0 requests made.\n`
          + `The staleness numbers themselves are UNKNOWN from the arguments — median age, newest/oldest added_at and the 90-day count are all read from each playlist's items. `
          + `This preview reports the cost, not a report. Re-run with dry_run=false to scan.`,
          {
            ok: true,
            dry_run: true,
            playlists: null,
            scanned: null,
            // Not 0 and not []: the walk never ran, so the count is unknown.
            scanned_known: false,
            scanned_note: 'unknown until the scan runs — per-playlist added_at is read, not derived from the arguments',
            estimated_requests_max: bound,
            estimated_requests_known: Math.max(1, Math.ceil(maxLists / 50)),
            playlists_to_scan_max: maxLists,
            item_pages_per_playlist_max: Math.max(1, Math.ceil(perPlaylistCap / 100)),
            requests_made: 0,
          }, SUMMARISE_JSON);
      }

      const gate = quotaPreflight(client);
      if (gate.blocked) {
        return emit(rf, gate.message, {
          ok: false, cooldown: true, wait_sec: gate.waitSec, requests_made: 0,
          // #896: was `limit + 1`, which priced the list walk and none of the
          // per-playlist paging — the real default cost is 251, not 51.
          requests_planned: stalenessRequestBound(maxLists, perPlaylistCap),
        }, SUMMARISE_JSON);
      }
      const snapshot = quotaSnapshot(client);
      const windowRemaining = quotaWindowRemaining(client);
      const limit = Math.min(maxLists, windowRemaining);
      const shrink = limit < maxLists;
      const lists = await client.getAllPages<{ id: string; name: string }>('/me/playlists', { limit: '50' }, { maxItems: limit });
      const rows: Array<{ name: string; items: number; newest: string | null; oldest: string | null; median_age_days: number | null; added_last_90d: number }> = [];
      let skipped = 0;
      let quotaAt: string | null = null;
      for (const pl of lists) {
        let items: PlaylistRow[];
        try {
          items = await client.getAllPages<PlaylistRow>(`/playlists/${encodeURIComponent(pl.id)}/items`, { limit: '100', fields: 'items(added_at),total' }, { maxItems: perPlaylistCap });
        } catch (e) {
          // 403 = collaborative/unfollowed playlists whose items this token cannot
          // read (playlist-read-private/collaborative gaps) — skip, never crash.
          if (e instanceof SpotifyApiError && e.status === 403) { skipped++; continue; }
          // 429 mid-walk: this report spends up to 251 requests on one call, so
          // a throttle part-way through is a normal outcome, not an error worth
          // throwing away a mostly-complete report over. Degrade to the rows
          // gathered so far and NAME the playlist we stopped at — the same
          // branch `saved_vs_playlist_coverage` uses. A partial report that
          // claims to be complete would be the #803 class of lie.
          if (e instanceof SpotifyApiError && e.status === 429) { quotaAt = pl.id; break; }
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
      const payload = {
        ok: true,
        scanned: rows.length,
        skipped_unreadable: skipped,
        playlists: t.items,
        truncated: t.truncated,
        quota_hit_at_playlist: quotaAt,
        // A report that stopped early is NOT a complete report. Say so in the
        // payload, not only in the prose, so a structured consumer can tell.
        ...(quotaAt ? { complete: false, stopped_reason: 'quota_hit_at_playlist' } : { complete: true }),
        estimated_requests_max: stalenessRequestBound(limit, args.per_playlist_cap),
        ...quotaDelta(client, snapshot),
        ...(shrink ? { requests_planned: stalenessRequestBound(limit, args.per_playlist_cap), budget_shrunk: true } : {}),
      };
      const lines = [
        `Playlist staleness report (${rows.length} playlists${skipped ? `, ${skipped} unreadable skipped` : ''}, sorted by ${args.sort}):`,
        '',
        ...(quotaAt ? [`Quota hit at playlist ${quotaAt} — PARTIAL report; ${rows.length} of ${lists.length} playlist(s) measured.`] : []),
      ];
      for (const r of t.items) {
        lines.push(`• ${r.name} — ${r.items} items, median age ${r.median_age_days ?? '?'}d, ${r.added_last_90d} added last 90d (oldest ${r.oldest ?? '?'})`);
      }
      if (t.footer) lines.push(`(${t.footer})`);
      return emit(rf, lines.join('\n'), payload, SUMMARISE_JSON);
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
      sort: z.enum(['backlog_hours', 'newest', 'name']).optional().default('backlog_hours').describe('Report sort order'),
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
      let skippedShows = 0;
      for (const row of shows) {
        const show = row.show;
        if (!show?.id) continue;
        let eps: Array<{ name?: string; duration_ms?: number; release_date?: string; resume_point?: { fully_played?: boolean } }>;
        try {
          eps = await client.getAllPages<{ name?: string; duration_ms?: number; release_date?: string; resume_point?: { fully_played?: boolean } }>(
            `/shows/${encodeURIComponent(show.id)}/episodes`, { limit: '50' }, { maxItems: 500 },
          );
        } catch (e) {
          // Throttled/gated shows are skipped, not fatal — the report names them.
          if (e instanceof SpotifyApiError && (e.status === 429 || e.status === 403)) { skippedShows++; continue; }
          throw e;
        }
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
      if (skippedShows > 0) rows.push({ name: `(${skippedShows} show(s) skipped — throttled or gated)`, unplayed: 0, backlog_hours: 0, newest_episode: null, total_episodes: null });
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
      return emit(rf, lines.join('\n'), payload, SUMMARISE_JSON);
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
      sort: z.enum(['progress', 'remaining', 'title']).optional().default('progress').describe('Report sort order'),
      max_audiobooks: z.number().int().min(1).max(100).optional().default(25).describe('How many audiobooks to scan (default 25, max 100)'),
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
          return emit(rf, 'Audiobooks are app-registration/market gated — your app registration is not entitled to audiobook endpoints (market-gated to US/UK/CA/IE/NZ/AU).', { ok: false, error: 'gated', status: 403 }, SUMMARISE_JSON);
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
      return emit(rf, lines.join('\n'), payload, SUMMARISE_JSON);
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
      op: z.enum(['save', 'list', 'delete']).optional().default('list').describe('Action to take: list bookmarks, save a chapter, or delete one. Default list'),
      book_uri: z.string().optional().describe('Audiobook URI, e.g. spotify:audiobook:abc (required for save/delete)'),
      label: z.string().optional().describe('Bookmark name (required for save)'),
      position_ms: z.number().int().min(0).optional().default(0).describe('Position in the book, ms. Default 0.'),
      chapter_name: z.string().optional().describe('Optional chapter name for context'),
      dry_run: DryRunDefault,
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
        return emit(rf, all.length ? lines.join('\n') : 'No bookmarks saved yet.', { ok: true, bookmarks: all }, SUMMARISE_JSON);
      }
      if (args.op === 'save') {
        if (!args.book_uri || !args.label) {
          return emit(rf, 'save requires book_uri and label.', { ok: false, error: 'missing_params' }, SUMMARISE_JSON);
        }
        if (isDryRun(args)) {
          return emit(rf, describeDryRun('save bookmark', key, [`Would save "${args.label}" @ ${args.position_ms}ms`]), { ok: true, dry_run: true }, SUMMARISE_JSON);
        }
        const list = s.bookmarks[key] ?? [];
        list.push({ book_uri: args.book_uri, label: args.label, position_ms: args.position_ms, ...(args.chapter_name ? { chapter_name: args.chapter_name } : {}), created_at: new Date().toISOString() });
        s.bookmarks[key] = list;
        await saveMiscStore(s);
        return emit(rf, `Bookmark "${args.label}" saved @ ${args.position_ms}ms for ${key}.`, { ok: true, label: args.label, book_uri: key, position_ms: args.position_ms }, SUMMARISE_JSON);
      }
      // delete
      if (!args.book_uri) return emit(rf, 'delete requires book_uri.', { ok: false, error: 'missing_params' }, SUMMARISE_JSON);
      const before = s.bookmarks[key] ?? [];
      const kept = args.label ? before.filter((b) => b.label !== args.label) : [];
      if (isDryRun(args)) {
        return emit(rf, describeDryRun('delete bookmarks', key, [`Would remove ${before.length - kept.length} bookmark(s)`]), { ok: true, dry_run: true, removed: before.length - kept.length }, SUMMARISE_JSON);
      }
      s.bookmarks[key] = kept;
      await saveMiscStore(s);
      return emit(rf, `Removed ${before.length - kept.length} bookmark(s) for ${key}.`, { ok: true, removed: before.length - kept.length, remaining: kept.length }, SUMMARISE_JSON);
    },
  );

  // -----------------------------------------------------------------------
  // #416 artist_complete_check — collector completeness
  // -----------------------------------------------------------------------
  server.tool(
    'artist_complete_check',
    "Collector completeness: the artist's full album list (page-walked at 10/page) vs your "
      + 'saved albums — what\'s missing, with album/single/compilation breakdown. Quota: 1 read '
      + 'per artist-album page (walk stops at the fetch cap) + your saved albums, page-capped.',
    {
      artist_id: spotifyRef(z.string().min(1).describe('Spotify artist ID'), 'artist'),
      include_singles: z.boolean().optional().default(true)
        .describe('Count singles as part of the complete set. Default true.'),
      max_results: MaxResults,
      response_format: ResponseFormat,
    },
    async (args) => {
      const rf = args.response_format as ResponseFormatValue;
      const groups = args.include_singles ? 'album,single,compilation' : 'album,compilation';
      // /artists/{id}/albums rejects limit > 10 with 400 (live-observed 2026-08-27),
      // so "the full album list" needs a page walk at the shared cap — one fat
      // request silently truncates any artist with more releases than the page.
      const cap = getConfig().fetchAllCap;
      const catalog = await client.getAllPages<{ id: string; name: string; album_group?: string; album_type?: string; release_date?: string }>(
        `/artists/${encodeURIComponent(args.artist_id)}/albums`,
        { include_groups: groups, limit: String(ARTIST_ALBUM_PAGE_LIMIT) },
        { maxItems: cap },
      );
      // /artists/{id}/albums is a bare PagingObject (href/items/limit/offset/total) and
      // carries no artist name, so the ID is the only name this call can report.
      const artistName = args.artist_id;
      const savedAlbums = await client.getAllPages<{ album?: { id?: string } }>('/me/albums', { limit: '50' }, { maxItems: cap });
      const savedIds = new Set(savedAlbums.map((r) => r.album?.id).filter((u): u is string => typeof u === 'string'));
      const missing = catalog.filter((a) => !savedIds.has(a.id));
      const capped = catalog.length >= cap;
      const breakdown = new Map<string, number>();
      // #639: `album_group` was removed from Album in Feb 2026. `album_type`
      // survives and is what this breakdown now groups on; the old terminal
      // `'unknown'` was a fabricated bucket, and this map is published as
      // `breakdown`, so it had to stop being a category nobody read.
      for (const a of missing) {
        const group = a.album_type?.trim() || '(untyped)';
        breakdown.set(group, (breakdown.get(group) ?? 0) + 1);
      }
      const maxResults = resolveMaxResults(args.max_results, getConfig().maxItems);
      const t = truncateItems(missing, maxResults);
      const payload = {
        ok: true, artist: artistName, total_albums: catalog.length, missing: missing.length,
        breakdown: Object.fromEntries(breakdown), missing_list: t.items.map((a) => ({ name: a.name, group: a.album_group ?? a.album_type, release_date: a.release_date ?? '' })),
        truncated: t.truncated, capped,
      };
      const lines = [`Completeness for ${artistName}:`, ''];
      lines.push(`Catalog: ${catalog.length} releases, you have ${catalog.length - missing.length}, missing ${missing.length}.`);
      if (capped) lines.push(`(scan stopped at the ${cap}-release fetch cap — this artist may have more releases than were counted)`);
      lines.push(`Breakdown of missing: ${[...breakdown.entries()].map(([g, n]) => `${g}: ${n}`).join(', ') || 'nothing'}`);
      if (missing.length) {
        lines.push('', 'Missing releases:');
        t.items.forEach((a) => lines.push(`  • [${a.album_type?.trim() || '(untyped)'}] ${a.name} (${a.release_date ?? '?'})`));
        if (t.footer) lines.push(`(${t.footer})`);
      }
      return emit(rf, lines.join('\n'), payload, SUMMARISE_JSON);
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
      mode: z.enum(['create', 'refresh']).optional().default('create').describe('create builds a new playlist; refresh rewrites the existing one. Default create'),
      playlist_name: z.string().optional().describe('Playlist name (create mode). Default: "Tagged: <tags>".'),
      playlist_id: spotifyRef(z.string().optional().describe('Playlist to refresh (refresh mode). Auto-resolved from playlist_name if omitted.'), 'playlist'),
      dry_run: DryRunDefault,
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
      if (isDryRun(args)) {
        return emit(rf, describeDryRun(`playlist from tags [${args.tags.join(', ')}]`, name, [
          `Would put ${uris.length} matched track(s) into "${name}" (${args.mode})`,
          ...matched.slice(0, 5).map((r) => `${r.track!.name} — ${r.track!.artists?.map((a) => a.name).join(', ') ?? ''}`),
        ]), payload, SUMMARISE_JSON);
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
        const writeCap = capFor('playlist_writes');
        await client.put(`/playlists/${encodeURIComponent(id)}/items`, { uris: uris.slice(0, writeCap) });
        for (let i = writeCap; i < uris.length; i += writeCap) {
          await client.post(`/playlists/${encodeURIComponent(id)}/items`, { uris: uris.slice(i, i + writeCap) });
        }
      }
      return emit(rf, `"${name}" (${args.mode}) ready with ${uris.length} matched track(s).`, { ...payload, playlist_id: id }, SUMMARISE_JSON);
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
      return emit(rf, lines.join('\n'), { ok: true, entry, today_count: todays.length, total: s.journal.length }, SUMMARISE_JSON);
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
      playlist_id: spotifyRef(z.string().min(1).describe('Playlist ID'), 'playlist'),
      include_added_at: z.boolean().optional().default(false).describe('Add an Added column'),
      max_results: MaxResults,
      response_format: ResponseFormat,
    },
    async (args) => {
      const rf = args.response_format as ResponseFormatValue;
      const meta = await client.get<{ name?: string; owner?: { id?: string } }>(`/playlists/${encodeURIComponent(args.playlist_id)}`);
      if (!meta) return emit(rf, `Playlist "${args.playlist_id}" not found.`, { ok: false, error: 'not_found' }, SUMMARISE_JSON);
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
      return emit(rf, md, { ok: true, playlist: meta.name ?? args.playlist_id, items: items.length, returned: t.returned, truncated: t.truncated }, SUMMARISE_JSON);
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
      return emit(rf, xml, { ok: true, count: outlines.length, disclosure: 'RSS feed URLs are not exposed by the Spotify API — entries link to Spotify show pages.' }, SUMMARISE_JSON);
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
      // #839: an unreadable store used to export as `null`, which the restore
      // checklist below then tells the user to write back — archiving the loss
      // as if it were the user's data and, on restore, replacing the file with
      // a literal null. A store that cannot be read is named, its bytes are
      // copied aside, and the checklist stops telling anyone to restore it.
      const unreadable: Record<string, string> = {};
      const tryRead = async (key: string, p: string): Promise<unknown> => {
        try {
          return await loadSidecar<unknown>(p, () => null, (parsed) => parsed);
        } catch (err) {
          if (err instanceof SidecarUnreadableError) {
            unreadable[key] = err.message;
            return null;
          }
          throw err;
        }
      };
      const [scenes, playbackExt, misc] = await Promise.all([
        tryRead('scenes', scenesFilePath()),
        tryRead('playback_ext', playbackExtFile()),
        tryRead('exhaust2_misc', miscFilePath()),
      ]);
      // Bounded tail read (#628): a large ledger must not be slurped whole.
      const history: unknown[] = await readHistory({ tokenFile: client.tokenFile });
      const bundle = {
        exported_at: new Date().toISOString(),
        bundle_version: 1,
        scenes,
        playback_ext: playbackExt,
        exhaust2_misc: misc,
        ...(Object.keys(unreadable).length > 0 ? { unreadable_stores: unreadable } : {}),
        mutation_history: { enabled: isHistoryEnabled(), path: historyFilePath(process.env, client.tokenFile), records: history },
        restore_checklist: [
          '1. Write scenes.json / playback-ext.json / exhaust2-misc.json back under ~/.spotify-mcp (owner-only modes).'
            + (Object.keys(unreadable).length > 0
              ? ` Do NOT restore ${Object.keys(unreadable).join(', ')} from this bundle: they could not be read (see unreadable_stores), and their bytes are preserved on disk.`
              : ''),
          '2. Re-declare genre tags (or restore genre-tags.json) for playlist_from_tags / filter_by_genre.',
          '3. Mutations.jsonl is an audit trail — restore only if you want undo/audit continuity.',
          '4. Re-run auth (tokens are never exported).',
          '5. Spot-check: list_scenes, list_playback_states, taste_checkpoint_diff.',
        ],
      };
      const json = args.pretty ? JSON.stringify(bundle, null, 2) : JSON.stringify(bundle);
      return emit(rf, json, { ok: true, ...(Object.keys(unreadable).length > 0 ? { unreadable_stores: unreadable } : {}), ...({ bundle } as unknown as Record<string, unknown>) }, SUMMARISE_JSON);
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
      if (!Number.isFinite(start)) return emit(rf, `Invalid week_start "${args.week_start}" — use YYYY-MM-DD.`, { ok: false, error: 'bad_param' }, SUMMARISE_JSON);
      if (start < Date.now() - 95 * DAY_MS) {
        return emit(rf, `${args.week_start} is older than the ~90-day recently-played window — Spotify will return nothing useful for it.`, { ok: false, error: 'outside_window' }, SUMMARISE_JSON);
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
      return emit(rf, lines.join('\n'), payload, SUMMARISE_JSON);
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
      format: z.enum(['markdown', 'csv']).optional().default('markdown').describe('Export format. Default markdown'),
      max_results: MaxResults,
      response_format: ResponseFormat,
    },
    async (args) => {
      const rf = args.response_format as ResponseFormatValue;
      type LogRow = HistoryRecord;
      // Bounded tail read (#628): never load an unbounded ledger into memory.
      let rows: LogRow[] = await readHistory({ tokenFile: client.tokenFile });
      if (rows.length === 0) {
        return emit(rf, 'No mutation history found (history is opt-in: set SPOTIFY_MCP_HISTORY=1).', { ok: false, error: 'no_history' }, SUMMARISE_JSON);
      }
      if (args.from) rows = rows.filter((r) => (r.ts ?? '') >= args.from!);
      if (args.to) rows = rows.filter((r) => (r.ts ?? '').slice(0, 10) <= args.to!);
      const maxResults = resolveMaxResults(args.max_results, getConfig().maxItems);
      const t = truncateItems(rows, maxResults);
      if (args.format === 'csv') {
        const csv = ['ts,who,method,path,snapshot_id', ...t.items.map((r) => [r.ts ?? '', r.who ?? '', r.method ?? '', r.path ?? '', r.snapshot_id ?? ''].map((f) => `"${f.replace(/"/g, '""')}"`).join(','))].join('\n');
        return emit(rf, csv, { ok: true, rows: t.returned, total: rows.length, truncated: t.truncated }, SUMMARISE_JSON);
      }
      const md = [
        '| Timestamp | Who | Method | Path | Snapshot |',
        '| --- | --- | --- | --- | --- |',
        ...t.items.map((r) => `| ${r.ts ?? ''} | ${r.who ?? ''} | ${r.method ?? ''} | ${r.path ?? ''} | ${r.snapshot_id ?? ''} |`),
        ...(t.footer ? ['', `(${t.footer})`] : []),
      ].join('\n');
      return emit(rf, md, { ok: true, rows: t.returned, total: rows.length, truncated: t.truncated }, SUMMARISE_JSON);
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
      mutation_id: z.string().min(1).describe('Receipt id (rcpt_…-N) to preview reverting'),
      check: z.boolean().optional().default(false)
        .describe('Optionally verify the target still exists (1 read)'),
      response_format: ResponseFormat,
    },
    async (args) => {
      const rf = args.response_format as ResponseFormatValue;
      const receipt = verifyReceipt(args.mutation_id, client.tokenFile);
      if (!receipt) {
        return emit(rf, receiptMissMessage(args.mutation_id, process.env, client.tokenFile), { ok: false, error: 'unknown_receipt' }, SUMMARISE_JSON);
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
      return emit(rf, describeDryRun('undo', args.mutation_id, changes) + (checkResult ? `\nCheck: ${checkResult}` : ''), payload, SUMMARISE_JSON);
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
      id: z.string().optional().describe('Exact receipt id (rcpt_…-N)'),
      since: z.string().optional().describe('Only receipts issued at/after this date; receipts with no recorded issue time are always included'),
      uri: z.string().optional().describe('Match receipts whose URI list contains this URI'),
      response_format: ResponseFormat,
    },
    async (args) => {
      const rf = args.response_format as ResponseFormatValue;
      let rows = getAllReceipts(client.tokenFile);
      if (args.id) rows = rows.filter((r) => r.receipt_id === args.id);
      if (args.uri) rows = rows.filter((r) => r.uris.includes(args.uri!));
      const sinceTs = args.since ? ts(args.since) : NaN;
      if (Number.isFinite(sinceTs)) {
        // Receipts carry a real issue time (#587), so this is a timestamp
        // comparison rather than a guess from the id's sequence number. A
        // receipt with no recorded time has an UNKNOWN age, which is not a
        // verdict against the filter — it is kept and counted in the payload.
        rows = rows.filter((r) => r.issued_at === undefined || r.issued_at >= sinceTs);
      }
      const payload = {
        ok: true, matches: rows.length,
        receipts: rows.map((r) => ({ receipt_id: r.receipt_id, kind: r.kind, id: r.id, verified: r.verified, uris: r.uris, missing: r.missing, windowExceeded: r.windowExceeded ?? false, issued_at: r.issued_at ?? null })),
        note: isReceiptsPersistent()
          ? `receipts persist to ${receiptsFilePath(process.env, client.tokenFile)} — ${MAX_RECEIPTS} most recent, ${receiptRetentionLabel()}`
          : `receipts are session-scoped (in-memory, FIFO ${MAX_RECEIPTS}) — not persisted to disk`,
        ...(Number.isFinite(sinceTs) && rows.some((r) => r.issued_at === undefined)
          ? { untimed_receipts_included: rows.filter((r) => r.issued_at === undefined).length }
          : {}),
      };
      const lines = [`Receipt lookup (${rows.length} match(es)):`];
      for (const r of rows) lines.push(`• ${r.receipt_id} — ${r.kind}${r.id ? ` ${r.id}` : ''} ${r.verified ? 'VERIFIED' : 'UNVERIFIED'} (${r.uris.length} uri(s))`);
      if (rows.length === 0) lines.push('  (none — issue a mutation first, or receipts were evicted)');
      return emit(rf, lines.join('\n'), payload, SUMMARISE_JSON);
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
      playlist_id: spotifyRef(z.string().min(1).describe('Playlist ID'), 'playlist'),
      max_results: MaxResults,
      response_format: ResponseFormat,
    },
    async (args) => {
      const rf = args.response_format as ResponseFormatValue;
      const meta = await client.get<{ name?: string; owner?: { id?: string }; uri?: string; tracks?: { total?: number } }>(`/playlists/${encodeURIComponent(args.playlist_id)}`);
      if (!meta) return emit(rf, `Playlist "${args.playlist_id}" not found.`, { ok: false, error: 'not_found' }, SUMMARISE_JSON);
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
      return emit(rf, JSON.stringify(doc, null, 2), doc as unknown as Record<string, unknown>, SUMMARISE_JSON);
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
      dry_run: DryRunDefault,
      response_format: ResponseFormat,
    },
    async (args) => {
      const rf = args.response_format as ResponseFormatValue;
      const live = await client.get<GetDevicesShape>('/me/player/devices');
      const liveNames = new Set((live?.devices ?? []).map((d) => d.name));
      const liveIds = new Set((live?.devices ?? []).map((d) => d.id));
      const matches = (label: string) => liveNames.has(label) || liveIds.has(label);
      // #1070: read scenes and playback-ext independently. loadScenes() throws
      // for an unreadable scenes sidecar (per #839); a failure there must not
      // take down the playback-ext half or strip the dead-preset signal from
      // the response. The scenes failure is surfaced as `load_error` on the
      // response, exactly the way the playback-ext tools do.
      let sceneStore: SceneStore = {};
      let scenesLoadError: string | null = null;
      try {
        sceneStore = await loadScenes();
      } catch (err) {
        scenesLoadError = `scenes.json was unreadable (${err instanceof Error ? err.message : String(err)}); it was not loaded.`;
      }
      const ext = await loadPlaybackExt();
      const deadPresets = Object.keys(ext.devicePresets).filter((label) => !matches(label));
      const deadScenes = scenesLoadError
        ? []
        : Object.entries(sceneStore)
            .filter(([, s]) => s.device_hint !== undefined && !matches(s.device_hint))
            .map(([name]) => name);
      const basePayload = {
        ok: true,
        live_devices: (live?.devices ?? []).map((d) => ({ id: d.id, name: d.name, type: d.type })),
        dead_presets: deadPresets,
        dead_scene_hints: deadScenes,
      };
      const payload = scenesLoadError ? { ...basePayload, load_error: scenesLoadError } : basePayload;
      if (!args.prune || isDryRun(args)) {
        const prose = describeDryRun('device-sidecar sync', '~/.spotify-mcp sidecars', [
          `Dead presets: ${deadPresets.join(', ') || 'none'}`,
          `Scenes with dead device hints: ${deadScenes.join(', ') || 'none'}`,
          args.prune ? 'Re-run with dry_run=false to prune.' : 'Pass prune=true to remove them.',
        ]);
        return emit(rf, scenesLoadError ? `WARNING: ${scenesLoadError}\n${prose}` : prose, payload, SUMMARISE_JSON);
      }
      for (const label of deadPresets) delete ext.devicePresets[label];
      if (!scenesLoadError) {
        for (const name of deadScenes) delete sceneStore[name].device_hint;
        await saveScenesSafe(sceneStore);
      }
      await savePlaybackExtSafe(ext);
      const summaryText = `Pruned ${deadPresets.length} dead preset(s) and ${deadScenes.length} dead scene hint(s).`;
      return emit(
        rf,
        scenesLoadError ? `WARNING: ${scenesLoadError}\n${summaryText}` : summaryText,
        { ...payload, pruned: true },
        SUMMARISE_JSON,
      );
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
  // #1084: mode only applies at creation; re-assert so a pre-existing or
  // copied-in store does not stay world-readable after this write.
  await chmod(file, 0o600);
}

async function savePlaybackExtSafe(store: PlaybackExtStore): Promise<void> {
  const file = playbackExtFile();
  await mkdir(dirname(file), { recursive: true, mode: 0o700 });
  await writeFile(file, `${JSON.stringify(store, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  // #1084: mode only applies at creation; re-assert so a pre-existing or
  // copied-in store does not stay world-readable after this write.
  await chmod(file, 0o600);
}

/** Footer helper for discover_weekly_diff prose. */
function saveLine(args: { save_after?: boolean; dry_run?: boolean }): string {
  if (args.save_after && !isDryRun(args)) return ' — archive synced to this week\'s copy';
  if (args.save_after) return ' — archive would be synced (dry run)';
  return '';
}
