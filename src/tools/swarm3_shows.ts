/** swarm3 shows slice — 500-tool swarm v1.26.0 (issue #442). Owned by shows builder. */
/**
 * swarm3 shows slice — 24 show/episode tools, all registered here and nowhere
 * else (index.ts/toolsets.ts integration is the coordinator's job).
 *
 * House conventions honoured here:
 *   • shaping.ts helpers only (resolveMaxResults / truncateItems /
 *     paginationInfo / describeDryRun) — nothing hand-rolled.
 *   • Every mutating tool carries `dry_run` (default TRUE) and performs only
 *     the read side, returning a deterministic PLAN when true.
 *   • Read tools accept response_format ('concise' default | 'detailed' |
 *     'json') and always emit structuredContent alongside the prose.
 *   • Library walks use client.getAllPages (respecting getConfig().fetchAllCap).
 *   • No deprecated/removed endpoints (SPEC §9). Per issue #230, there is NO
 *     way to mark an episode as played via the API — mark_episode_played_plan
 *     is therefore a permanent, read-only PLAN tool.
 *   • Feb-2026 constraint: `publisher` is optional on show payloads; every
 *     consumer tolerates its absence ("(unknown publisher)").
 */
import { z } from 'zod';
import { MARKET_CODE } from './catalog.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { SpotifyClient } from '../client.js';
import { getConfig } from '../config.js';
import { spotifyId, spotifyIdArray } from '../refs.js';
import {
  DryRun,
  MaxResults,
  ResponseFormat,
  batchSummary,
  describeDryRun,
  paginationInfo,
  resolveMaxResults,
  truncateItems,
} from '../shaping.js';
import type { ResponseFormatValue } from '../shaping.js';
import type {
  SavedEpisodeItem,
  SavedShowItem,
  SpotifyEpisodeFull,
  SpotifyEpisodeSimple,
  SpotifyShowFull,
  SpotifyShowSimple,
} from '../types/spotify.js';

type TextContent = { type: 'text'; text: string };
type ToolResult = { content: TextContent[]; structuredContent?: Record<string, unknown> };

// ---------------------------------------------------------------------------
// Shared shaping helpers (mirrors exhaust2_playlists.ts)
// ---------------------------------------------------------------------------

const jsonText = (data: unknown): string => JSON.stringify(data, null, 2);

/** json mode stringifies the payload; payload always rides as structuredContent. */
function shape(rf: ResponseFormatValue, prose: string, payload: Record<string, unknown>): ToolResult {
  return {
    content: [{ type: 'text', text: rf === 'json' ? jsonText(payload) : prose }],
    structuredContent: payload,
  };
}

/** `dry_run` fragment defaulting to TRUE (repo convention: previews are the default). */
const DryRunDefault = z
  .boolean()
  .optional()
  .default(true)
  .describe(
    'Preview only: perform the read side and return a PLAN without changing anything. '
      + 'Default true — pass false to commit.',
  );

const isDry = (args: { dry_run?: boolean }): boolean => args.dry_run ?? true;

/** Dry-run PLAN result. */
function dryOut(label: string, target: string, lines: string[], extra?: Record<string, unknown>): ToolResult {
  const prose = `[dry run] ${label} — ${target}\n${lines.join('\n')}`;
  return {
    content: [{ type: 'text', text: prose }],
    structuredContent: { ok: true, dry_run: true, label, target, plan: lines, ...extra },
  };
}

// ---------------------------------------------------------------------------
// Shared plumbing
// ---------------------------------------------------------------------------

/** Today as `YYYY-MM-DD`. */
function formatDateStamp(now = new Date()): string {
  return now.toISOString().slice(0, 10);
}

/** `4312000` ms → `1:11:52`-style clock for prose. */
function msToClock(ms: number): string {
  const totalSec = Math.round(ms / 1000);
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  const mm = h > 0 ? String(m).padStart(2, '0') : String(m);
  const ss = String(s).padStart(2, '0');
  return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}

/** `YYYY`, `YYYY-MM`, `YYYY-MM-DD` → comparable number (partial dates pad with zeros). */
function dateNum(date: string | undefined): number {
  if (!date) return 0;
  const digits = date.replace(/\D/g, '').slice(0, 8);
  return parseInt(digits.padEnd(8, '0'), 10);
}

/** Whole days between an ISO timestamp/date and `nowMs` (0 when unparseable/`iso` empty). */
function daysBetween(iso: string | undefined, nowMs: number): number | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return null;
  return Math.max(0, Math.floor((nowMs - t) / 86_400_000));
}

/** Publisher label tolerating the Feb-2026 removal of `publisher` from payloads. */
function publisherOf(show: SpotifyShowSimple | SpotifyShowFull): string {
  return show.publisher?.trim() || '(unknown publisher)';
}

/** Page the saved-shows shelf (fetch-all cap). */
function fetchSavedShows(client: SpotifyClient): Promise<SavedShowItem[]> {
  return client.getAllPages<SavedShowItem>(
    '/me/shows',
    { limit: '50' },
    { maxItems: getConfig().fetchAllCap },
  );
}

/** Page the saved-episodes shelf (fetch-all cap). */
function fetchSavedEpisodes(client: SpotifyClient): Promise<SavedEpisodeItem[]> {
  return client.getAllPages<SavedEpisodeItem>(
    '/me/episodes',
    { limit: '50' },
    { maxItems: getConfig().fetchAllCap },
  );
}

/** Latest episodes for one show, newest first (single GET, ≤50 rows). */
async function latestShowEpisodes(
  client: SpotifyClient,
  showId: string,
  limit: number,
): Promise<SpotifyEpisodeSimple[]> {
  const page = await client.get<{ items?: SpotifyEpisodeSimple[] }>(
    `/shows/${encodeURIComponent(showId)}/episodes`,
    { limit: String(Math.max(1, Math.min(50, limit))), offset: '0' },
  );
  return page?.items ?? [];
}

/** Median of a numeric list (average of the two middle values for even n). */
function median(nums: readonly number[]): number | null {
  if (nums.length === 0) return null;
  const sorted = [...nums].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1
    ? sorted[mid]
    : (sorted[mid - 1] + sorted[mid]) / 2;
}

/**
 * Estimate a show's publish cadence from its most recent episodes: median
 * interval (in days) between consecutive release dates. Returns null when
 * fewer than two datable episodes are visible.
 */
function cadenceDays(episodes: readonly SpotifyEpisodeSimple[]): number | null {
  const dates = episodes
    .map((e) => dateNum(e.release_date))
    .filter((n) => n > 0)
    .sort((a, b) => b - a);
  if (dates.length < 2) return null;
  const gaps: number[] = [];
  for (let i = 1; i < dates.length; i++) gaps.push(dates[i - 1] - dates[i]);
  return median(gaps.filter((g) => g >= 0));
}

/** Advance a YYYY-MM-DD date by N days. */
function addDays(iso: string, days: number): string {
  const base = Date.parse(iso);
  if (Number.isNaN(base)) return iso;
  return new Date(base + days * 86_400_000).toISOString().slice(0, 10);
}

/** Strip HTML tags + collapse whitespace from episode/show descriptions. */
function cleanText(raw: string | undefined): string {
  return (raw ?? '')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Deterministic guest-name candidates from a cleaned episode description:
 * credit patterns ("with X", "featuring X", "guest X", "joins X"). Each
 * candidate is 1–4 consecutive capitalised words.
 */
function guestCandidates(description: string): string[] {
  const text = cleanText(description);
  const out: string[] = [];
  const credit = /\b(?:with|feat\.?|featuring|guest|guests?|joined by|interviews?|speaks? to|talks? to|in conversation with)\s+([A-Z][\w'.-]+(?:\s+[A-Z][\w'.-]+){0,3})/g;
  let m: RegExpExecArray | null;
  while ((m = credit.exec(text)) !== null) {
    // Trim trailing connector words that leaked into the match.
    const name = m[1].replace(/\s+(?:and|about|on|to|from|at|in|the|who|that)$/i, '').trim();
    if (name.length >= 2) out.push(name);
  }
  return out;
}

interface EpisodeRow {
  id: string;
  uri: string;
  name: string;
  showId: string;
  showName: string;
  releaseDate: string;
  durationMs: number | null;
  fullyPlayed: boolean | null;
}

/** Flatten any episode payload into a plain row. */
function toEpisodeRow(e: SpotifyEpisodeSimple | SpotifyEpisodeFull): EpisodeRow {
  return {
    id: e.id,
    uri: e.uri,
    name: e.name,
    showId: e.show?.id ?? '',
    showName: e.show?.name ?? '(unknown show)',
    releaseDate: e.release_date ?? '',
    durationMs: e.duration_ms ?? null,
    fullyPlayed: e.resume_point?.fully_played ?? null,
  };
}

/** Episode meta for up to N ids (best-effort; failed lookups are skipped). */
async function episodeMetaFor(
  client: SpotifyClient,
  ids: readonly string[],
  maxFetch: number,
): Promise<Map<string, SpotifyEpisodeFull>> {
  const out = new Map<string, SpotifyEpisodeFull>();
  for (const id of ids.slice(0, maxFetch)) {
    const full = await client.get<SpotifyEpisodeFull>(`/episodes/${encodeURIComponent(id)}`);
    if (full?.id) out.set(full.id, full);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

export function registerSwarm3ShowsTools(server: McpServer, client: SpotifyClient): void {
  // 1. list_saved_shows -----------------------------------------------------
  server.tool(
    'list_saved_shows',
    'List the shows saved in your library with publisher, episode count, and saved date — '
      + "truncated to max_results with a fetch-all hint when longer. Default 20 rows, 'concise' prose.",
    {
      ...sharedListFieldsShow(),
    },
    async (args) => {
      const rf = args.response_format;
      const rows = await fetchSavedShows(client);
      const view = truncateItems(rows, resolveMaxResults(args.max_results, getConfig().maxItems));
      const lines = view.items.map((r) => ({
        id: r.show?.id ?? null,
        name: r.show?.name ?? '(unavailable)',
        publisher: r.show ? publisherOf(r.show) : null,
        total_episodes: r.show?.total_episodes ?? null,
        saved_at: r.added_at ?? null,
      }));
      const prose = [
        `Saved shows: ${rows.length} total, showing ${view.returned}.`,
        ...lines.map((l) => `  • ${l.name} — ${l.publisher} · ${l.total_episodes ?? '?'} eps · saved ${l.saved_at?.slice(0, 10) ?? '?'}`),
        view.footer ? `(${view.footer})` : '',
      ].filter(Boolean).join('\n');
      return shape(rf, prose, {
        ok: true,
        total: rows.length,
        returned: view.returned,
        shows: lines,
      });
    },
  );

  // 2. get_show_details -----------------------------------------------------
  server.tool(
    'get_show_details',
    'Fetch full metadata for one show (description, publisher, episode count, languages, media type). '
      + "Defaults to 'concise' prose.",
    {
      show_id: spotifyId('show').describe('Show ID, spotify:show: URI, or open.spotify.com/show URL'),
      market: MARKET_CODE.optional().describe('ISO 3166-1 alpha-2 market for availability, e.g. \'US\''),
      response_format: ResponseFormat,
    },
    async (args) => {
      const rf = args.response_format;
      const params: Record<string, string> = {};
      if (args.market) params.market = args.market;
      const show = await client.get<SpotifyShowFull>(`/shows/${encodeURIComponent(args.show_id)}`, params);
      if (!show?.id) throw new Error(`Show "${args.show_id}" not found`);
      const payload: Record<string, unknown> = {
        ok: true,
        id: show.id,
        name: show.name,
        publisher: publisherOf(show),
        description: cleanText(show.description),
        total_episodes: show.total_episodes ?? null,
        explicit: show.explicit ?? null,
        languages: show.languages ?? [],
        media_type: show.media_type ?? null,
        uri: show.uri,
      };
      if (rf === 'json') return shape(rf, '', payload);
      return shape(rf, [
        `"${show.name}" (${show.id})`,
        `  Publisher: ${publisherOf(show)} · ${show.total_episodes ?? '?'} episode(s) · ${show.explicit ? 'explicit' : 'clean'}`,
        `  Media: ${show.media_type ?? '?'} · Languages: ${(show.languages ?? []).join(', ') || '?'}`,
        `  ${cleanText(show.description).slice(0, 300) || '(no description)'}`,
      ].join('\n'), payload);
    },
  );

  // 3. list_show_episodes — canonical show-episode lister (preferred over deprecated get_show_episodes). Both hit GET /shows/{id}/episodes.
  server.tool(
    'list_show_episodes',
    'Page one show\'s episode list newest-first with duration and release date — the browse view '
      + "for a single podcast. Default limit 20, 'concise' prose. Canonical for GET /shows/{id}/episodes; get_show_episodes is a deprecated alias. Also covers: paged podcast episodes.",
    {
      show_id: spotifyId('show').describe('Show ID, spotify:show: URI, or open.spotify.com/show URL'),
      offset: z.number().int().min(0).optional().describe('Offset into the episode list. Default 0'),
      market: MARKET_CODE.optional().describe('ISO 3166-1 alpha-2 market for availability, e.g. \'US\''),
      ...sharedListFieldsShow(),
    },
    async (args) => {
      const rf = args.response_format;
      const offset = args.offset ?? 0;
      const params: Record<string, string> = {
        limit: '50',
        offset: String(offset),
      };
      if (args.market) params.market = args.market;
      const page = await client.get<{ items?: SpotifyEpisodeSimple[]; total?: number; limit?: number }>(
        `/shows/${encodeURIComponent(args.show_id)}/episodes`,
        params,
      );
      const items = page?.items ?? [];
      const total = page?.total ?? null;
      const view = truncateItems(items, resolveMaxResults(args.max_results, getConfig().maxItems));
      const rows = view.items.map(toEpisodeRow);
      const prose = [
        `Episodes${total != null ? ` (${total} total)` : ''}: showing ${view.returned} from offset ${offset}.`,
        ...rows.map((r) => `  • ${r.releaseDate || '?'} · ${r.durationMs != null ? msToClock(r.durationMs) : '?'} · ${r.name}`),
        view.footer ? `(${view.footer})` : '',
      ].filter(Boolean).join('\n');
      return shape(rf, prose, {
        ok: true,
        show_id: args.show_id,
        episodes: rows,
        pagination: paginationInfo({ total, offset, limit: page?.limit ?? null, returned: view.returned }),
      });
    },
  );

  // 4. get_show_latest_episode ----------------------------------------------
  server.tool(
    'get_show_latest_episode',
    'Return the single newest episode of a show with duration, description, and resume point — '
      + "'what dropped last?' in one GET. Defaults to 'concise' prose.",
    {
      show_id: spotifyId('show').describe('Show ID, spotify:show: URI, or open.spotify.com/show URL'),
      market: MARKET_CODE.optional().describe('ISO 3166-1 alpha-2 market for availability, e.g. \'US\''),
      response_format: ResponseFormat,
    },
    async (args) => {
      const rf = args.response_format;
      const params: Record<string, string> = { limit: '1', offset: '0' };
      if (args.market) params.market = args.market;
      const page = await client.get<{ items?: SpotifyEpisodeSimple[] }>(
        `/shows/${encodeURIComponent(args.show_id)}/episodes`,
        params,
      );
      const ep = page?.items?.[0];
      if (!ep) throw new Error(`No episodes found for show "${args.show_id}"`);
      const row = toEpisodeRow(ep);
      const prose = [
        `Latest episode of ${row.showName}:`,
        `  ${row.name}`,
        `  Released ${row.releaseDate || '?'} · ${row.durationMs != null ? msToClock(row.durationMs) : '?'} · ${row.fullyPlayed === true ? 'fully played' : row.fullyPlayed === false ? 'partially played' : 'play state unknown'}`,
        `  ${cleanText(ep.description).slice(0, 300) || '(no description)'}`,
      ].join('\n');
      return shape(rf, prose, { ok: true, episode: row, description: cleanText(ep.description) });
    },
  );

  // 5. saved_shows_publisher_census -----------------------------------------
  server.tool(
    'saved_shows_publisher_census',
    'Count your saved shows by publisher and rank the biggest presses in your subscriptions — '
      + "read-only census over the whole shelf. Defaults to top 10 publishers, 'concise' prose.",
    {
      top_n: z.number().int().min(1).optional().describe('Publishers to list. Default 10'),
      ...sharedListFieldsShow(),
    },
    async (args) => {
      const rf = args.response_format;
      const rows = await fetchSavedShows(client);
      const byPub = new Map<string, { shows: number; episodes: number; names: string[] }>();
      for (const r of rows) {
        if (!r.show) continue;
        const pub = publisherOf(r.show);
        const entry = byPub.get(pub) ?? { shows: 0, episodes: 0, names: [] };
        entry.shows++;
        entry.episodes += r.show.total_episodes ?? 0;
        entry.names.push(r.show.name);
        byPub.set(pub, entry);
      }
      const ranked = [...byPub.entries()]
        .map(([publisher, v]) => ({ publisher, ...v }))
        .sort((a, b) => b.shows - a.shows || b.episodes - a.episodes || a.publisher.localeCompare(b.publisher));
      const top = ranked.slice(0, args.top_n ?? 10);
      const prose = [
        `Publisher census across ${rows.length} saved show(s), ${ranked.length} distinct publisher(s):`,
        ...top.map((p) => `  • ${p.publisher}: ${p.shows} show(s), ${p.episodes} eps — ${p.names.slice(0, 3).join('; ')}${p.names.length > 3 ? '; …' : ''}`),
      ].join('\n');
      return shape(rf, prose, {
        ok: true,
        saved_shows: rows.length,
        distinct_publishers: ranked.length,
        publishers: ranked,
      });
    },
  );

  // 6. shows_without_new_episodes -------------------------------------------
  server.tool(
    'shows_without_new_episodes',
    'Find saved shows with no episode released inside the lookback window ("which pods went '
      + 'quiet?") — pages /me/shows then the latest episode per show. Defaults to 30 days, '
      + '50 show lookups.',
    {
      lookback_days: z.number().int().min(1).max(365).optional().describe('Quiet window in days. Default 30'),
      max_shows: z.number().int().min(1).max(200).optional().describe('Max per-show episode lookups (request budget). Default 50'),
      ...sharedListFieldsShow(),
    },
    async (args) => {
      const rf = args.response_format;
      const lookback = args.lookback_days ?? 30;
      const budget = args.max_shows ?? 50;
      const now = Date.now();
      const cutoffNum = dateNum(addDays(formatDateStamp(new Date(now)), -lookback));
      const shows = (await fetchSavedShows(client)).filter((r) => r.show?.id);
      const quiet: Array<{ id: string; name: string; publisher: string; latest_release: string | null; days_since_latest: number | null }> = [];
      let checked = 0;
      for (const r of shows) {
        if (checked >= budget) break;
        checked++;
        const eps = await latestShowEpisodes(client, r.show.id, 1);
        const latest = eps[0]?.release_date ?? null;
        if (!latest || dateNum(latest) < cutoffNum) {
          quiet.push({
            id: r.show.id,
            name: r.show.name,
            publisher: publisherOf(r.show),
            latest_release: latest,
            days_since_latest: latest ? daysBetween(latest, now) : null,
          });
        }
      }
      quiet.sort((a, b) => (b.days_since_latest ?? -1) - (a.days_since_latest ?? -1));
      const view = truncateItems(quiet, resolveMaxResults(args.max_results, getConfig().maxItems));
      const prose = [
        `Shows quiet for >${lookback} day(s): ${quiet.length} of ${checked} checked${shows.length > budget ? ` (budget capped at ${budget} of ${shows.length} saved)` : ''}.`,
        ...view.items.map((s) => `  • ${s.name} — last release ${s.latest_release ?? 'never'}${s.days_since_latest != null ? ` (${s.days_since_latest}d ago)` : ''} · ${s.publisher}`),
        view.footer ? `(${view.footer})` : '',
      ].filter(Boolean).join('\n');
      return shape(rf, prose, {
        ok: true,
        lookback_days: lookback,
        shows_checked: checked,
        quiet_shows: view.items,
        total_quiet: quiet.length,
      });
    },
  );

  // 7. stale_saved_shows_plan ------------------------------------------------
  server.tool(
    'stale_saved_shows_plan',
    'Build a PLAN for pruning saved shows that have published nothing within the staleness '
      + 'threshold — read-only by design, it never unfollows anything; pair with '
      + 'remove_saved_shows to commit. Defaults to 90 days, 50 show lookups.',
    {
      threshold_days: z.number().int().min(1).max(730).optional().describe('Stale when no release within N days. Default 90'),
      max_shows: z.number().int().min(1).max(200).optional().describe('Max per-show episode lookups (request budget). Default 50'),
      ...sharedListFieldsShow(),
    },
    async (args) => {
      const rf = args.response_format;
      const threshold = args.threshold_days ?? 90;
      const budget = args.max_shows ?? 50;
      const now = Date.now();
      const cutoffNum = dateNum(addDays(formatDateStamp(new Date(now)), -threshold));
      const shows = (await fetchSavedShows(client)).filter((r) => r.show?.id);
      const stale: Array<{ id: string; name: string; publisher: string; latest_release: string | null; days_since_latest: number | null }> = [];
      let checked = 0;
      for (const r of shows) {
        if (checked >= budget) break;
        checked++;
        const eps = await latestShowEpisodes(client, r.show.id, 1);
        const latest = eps[0]?.release_date ?? null;
        if (!latest || dateNum(latest) < cutoffNum) {
          stale.push({
            id: r.show.id,
            name: r.show.name,
            publisher: publisherOf(r.show),
            latest_release: latest,
            days_since_latest: latest ? daysBetween(latest, now) : null,
          });
        }
      }
      stale.sort((a, b) => (b.days_since_latest ?? -1) - (a.days_since_latest ?? -1));
      const view = truncateItems(stale, resolveMaxResults(args.max_results, getConfig().maxItems));
      const changes = view.items.map((s) => `  - unfollow "${s.name}" (${s.id}) — last release ${s.latest_release ?? 'never'}`);
      const prose = [
        `[dry run] stale-shows prune plan — threshold ${threshold} day(s), ${checked} show(s) checked:`,
        `${stale.length} stale show(s):`,
        ...changes,
        view.footer ? `(${view.footer})` : '',
        'Plan only — nothing was unfollowed. Pass these IDs to remove_saved_shows to commit.',
      ].filter(Boolean).join('\n');
      return shape(rf, prose, {
        ok: true,
        dry_run: true,
        threshold_days: threshold,
        shows_checked: checked,
        stale_shows: view.items,
        total_stale: stale.length,
      });
    },
  );

  // 8. subscribe_to_show ------------------------------------------------------
  server.tool(
    'subscribe_to_show',
    'Save one or more shows to your library (PUT /me/shows) — previews a deterministic PLAN by '
      + 'default; pass dry_run=false to commit.',
    {
      show_ids: spotifyIdArray('show').min(1).max(50).describe('Show IDs/URIs to save (1–50)'),
      response_format: ResponseFormat,
      dry_run: DryRunDefault,
    },
    async (args) => {
      const ids = args.show_ids;
      if (isDry(args)) {
        const changes = ids.map((id) => `Save show ${id} to your library`);
        return shape(args.response_format, describeDryRun('subscribe to shows', `${ids.length} show(s)`, changes), {
          ok: true,
          dry_run: true,
          show_ids: ids,
          plan: changes,
        });
      }
      await client.put(`/me/shows?ids=${ids.map(encodeURIComponent).join(',')}`);
      return shape(args.response_format, `Saved ${ids.length} show(s) to your library.\n${batchSummary(ids.length, ids)}`, {
        ok: true,
        dry_run: false,
        saved: ids.length,
        show_ids: ids,
      });
    },
  );

  // 9. unsubscribe_from_show --------------------------------------------------
  server.tool(
    'unsubscribe_from_show',
    'Remove ONE saved show from your library (DELETE /me/shows) — removal verb: also see remove_saved_shows (bulk), delete_playlist_snapshot (local snapshots).  after confirming what it is — '
      + 'previews a PLAN naming the show by default; pass dry_run=false to commit.',
    {
      show_id: spotifyId('show').describe('Show ID, spotify:show: URI, or open.spotify.com/show URL'),
      response_format: ResponseFormat,
      dry_run: DryRunDefault,
    },
    async (args) => {
      const show = await client.get<SpotifyShowFull>(`/shows/${encodeURIComponent(args.show_id)}`);
      const name = show?.name ?? args.show_id;
      const publisher = show ? publisherOf(show) : '?';
      if (isDry(args)) {
        return shape(args.response_format, describeDryRun('unsubscribe from show', `"${name}" (${args.show_id})`, [
          `Remove "${name}" (${publisher}) from your saved shows`,
        ]), {
          ok: true,
          dry_run: true,
          show_id: args.show_id,
          name,
          publisher,
        });
      }
      await client.delete(`/me/shows?ids=${encodeURIComponent(args.show_id)}`);
      return shape(args.response_format, `Removed "${name}" (${publisher}) from your saved shows.`, {
        ok: true,
        dry_run: false,
        show_id: args.show_id,
        name,
        publisher,
      });
    },
  );

  // 10. remove_saved_shows ----------------------------------------------------
  server.tool(
    'remove_saved_shows',
    'Bulk-remove shows from your library (DELETE /me/shows) — removal verb family: also see unsubscribe_from_show (single), remove_saved_episode (episodes).  after cross-checking which of the '
      + 'given IDs are actually saved — previews a PLAN by default; pass dry_run=false to commit.',
    {
      show_ids: spotifyIdArray('show').min(1).max(50).describe('Show IDs/URIs to remove (1–50)'),
      response_format: ResponseFormat,
      dry_run: DryRunDefault,
    },
    async (args) => {
      const ids = args.show_ids;
      const contains = await client.get<boolean[]>(
        `/me/shows/contains`,
        { ids: ids.join(',') },
      );
      const savedSet = new Set<string>();
      (contains ?? []).forEach((isSaved, i) => {
        if (isSaved && ids[i]) savedSet.add(ids[i]);
      });
      const removable = ids.filter((id) => savedSet.has(id));
      const notSaved = ids.filter((id) => !savedSet.has(id));
      if (isDry(args)) {
        const changes = removable.map((id) => `Remove saved show ${id}`)
          .concat(notSaved.map((id) => `SKIP ${id} (not in your saved shows)`));
        return shape(args.response_format, describeDryRun('remove saved shows', `${ids.length} id(s) given`, changes), {
          ok: true,
          dry_run: true,
          removable: removable,
          not_saved: notSaved,
          plan: changes,
        });
      }
      if (removable.length > 0) {
        await client.delete(`/me/shows?ids=${removable.map(encodeURIComponent).join(',')}`);
      }
      return shape(args.response_format,
        `Removed ${removable.length} saved show(s); skipped ${notSaved.length} not-saved id(s).\n${batchSummary(removable.length, removable)}`,
        {
          ok: true,
          dry_run: false,
          removed: removable,
          not_saved: notSaved,
        });
    },
  );

  // 11. get_episode_details ---------------------------------------------------
  server.tool(
    'get_episode_details',
    'Fetch full metadata for one episode (duration, release date, resume point, show, description). '
      + "Defaults to 'concise' prose.",
    {
      episode_id: spotifyId('episode').describe('Episode ID, spotify:episode: URI, or open.spotify.com/episode URL'),
      market: MARKET_CODE.optional().describe('ISO 3166-1 alpha-2 market for availability, e.g. \'US\''),
      response_format: ResponseFormat,
    },
    async (args) => {
      const rf = args.response_format;
      const params: Record<string, string> = {};
      if (args.market) params.market = args.market;
      const ep = await client.get<SpotifyEpisodeFull>(`/episodes/${encodeURIComponent(args.episode_id)}`, params);
      if (!ep?.id) throw new Error(`Episode "${args.episode_id}" not found`);
      const row = toEpisodeRow(ep);
      const payload: Record<string, unknown> = {
        ok: true,
        ...row,
        explicit: ep.explicit ?? null,
        languages: ep.languages ?? [],
        description: cleanText(ep.description),
        resume_position_ms: ep.resume_point?.resume_position_ms ?? null,
        uri: ep.uri,
      };
      if (rf === 'json') return shape(rf, '', payload);
      return shape(rf, [
        `"${row.name}" (${row.showName})`,
        `  Released ${row.releaseDate || '?'} · ${row.durationMs != null ? msToClock(row.durationMs) : '?'} · ${ep.explicit ? 'explicit' : 'clean'}`,
        row.fullyPlayed != null
          ? `  Resume: ${row.fullyPlayed ? 'fully played' : `${Math.round((ep.resume_point?.resume_position_ms ?? 0) / 60_000)} min in`}`
          : '  Resume: play state unknown',
        `  ${cleanText(ep.description).slice(0, 300) || '(no description)'}`,
      ].join('\n'), payload);
    },
  );

  // 12. check_episode_saved ---------------------------------------------------
  server.tool(
    'check_episode_saved',
    'Check which episodes are already saved in your library (GET /me/episodes/contains) — '
      + 'batch yes/no, no guessing. Read-only.',
    {
      episode_ids: spotifyIdArray('episode').min(1).max(50).describe('Episode IDs/URIs to check (1–50)'),
      response_format: ResponseFormat,
    },
    async (args) => {
      const ids = args.episode_ids;
      const contains = await client.get<boolean[]>('/me/episodes/contains', { ids: ids.join(',') });
      const results = ids.map((id, i) => ({ episode_id: id, saved: contains?.[i] === true }));
      const savedCount = results.filter((r) => r.saved).length;
      const prose = [
        `${savedCount} of ${ids.length} episode(s) saved in your library:`,
        ...results.map((r) => `  ${r.saved ? '✓' : '✗'} ${r.episode_id}`),
      ].join('\n');
      return shape(args.response_format, prose, {
        ok: true,
        results,
        saved_count: savedCount,
      });
    },
  );

  // 13. save_episode ----------------------------------------------------------
  server.tool(
    'save_episode',
    'Save episodes to your library (PUT /me/episodes) — previews a PLAN with episode names by '
      + 'default; pass dry_run=false to commit.',
    {
      episode_ids: spotifyIdArray('episode').min(1).max(50).describe('Episode IDs/URIs to save (1–50)'),
      response_format: ResponseFormat,
      dry_run: DryRunDefault,
    },
    async (args) => {
      const ids = args.episode_ids;
      if (isDry(args)) {
        const meta = await episodeMetaFor(client, ids, 10);
        const changes = ids.map((id) => {
          const m = meta.get(id);
          return `Save episode ${id}${m ? ` "${m.name}" (${m.show?.name ?? '?'})` : ''}`;
        });
        return shape(args.response_format, describeDryRun('save episodes', `${ids.length} episode(s)`, changes), {
          ok: true,
          dry_run: true,
          episode_ids: ids,
          plan: changes,
        });
      }
      await client.put(`/me/episodes?ids=${ids.map(encodeURIComponent).join(',')}`);
      return shape(args.response_format, `Saved ${ids.length} episode(s) to your library.\n${batchSummary(ids.length, ids)}`, {
        ok: true,
        dry_run: false,
        saved: ids.length,
        episode_ids: ids,
      });
    },
  );

  // 14. remove_saved_episode ---------------------------------------------------
  server.tool(
    'remove_saved_episode',
    'Remove episodes from your library (DELETE /me/episodes) — removal verb: also see remove_saved_shows (shows), delete_playlist_snapshot (local).  after cross-checking which are '
      + 'actually saved — previews a PLAN by default; pass dry_run=false to commit.',
    {
      episode_ids: spotifyIdArray('episode').min(1).max(50).describe('Episode IDs/URIs to remove (1–50)'),
      response_format: ResponseFormat,
      dry_run: DryRunDefault,
    },
    async (args) => {
      const ids = args.episode_ids;
      const contains = await client.get<boolean[]>('/me/episodes/contains', { ids: ids.join(',') });
      const savedSet = new Set<string>();
      (contains ?? []).forEach((isSaved, i) => {
        if (isSaved && ids[i]) savedSet.add(ids[i]);
      });
      const removable = ids.filter((id) => savedSet.has(id));
      const notSaved = ids.filter((id) => !savedSet.has(id));
      if (isDry(args)) {
        const changes = removable.map((id) => `Remove saved episode ${id}`)
          .concat(notSaved.map((id) => `SKIP ${id} (not saved in your library)`));
        return shape(args.response_format, describeDryRun('remove saved episodes', `${ids.length} id(s) given`, changes), {
          ok: true,
          dry_run: true,
          removable,
          not_saved: notSaved,
          plan: changes,
        });
      }
      if (removable.length > 0) {
        await client.delete(`/me/episodes?ids=${removable.map(encodeURIComponent).join(',')}`);
      }
      return shape(args.response_format,
        `Removed ${removable.length} saved episode(s); skipped ${notSaved.length} not-saved id(s).\n${batchSummary(removable.length, removable)}`,
        {
          ok: true,
          dry_run: false,
          removed: removable,
          not_saved: notSaved,
        });
    },
  );

  // 15. mark_episode_played_plan ----------------------------------------------
  server.tool(
    'mark_episode_played_plan',
    'Plan (never execute — Spotify removed the mark-played API, issue #230) which episodes to '
      + 'mark fully played: fetches current resume points and outputs the target positions the '
      + 'player would seek to. Read-only by design.',
    {
      episode_ids: spotifyIdArray('episode').min(1).max(20).describe('Episode IDs/URIs to plan (1–20)'),
      response_format: ResponseFormat,
    },
    async (args) => {
      const rf = args.response_format;
      const rows: Array<{ episode_id: string; name: string | null; show: string | null; duration_ms: number | null; current_resume_ms: number | null; fully_played: boolean | null }> = [];
      for (const id of args.episode_ids) {
        const ep = await client.get<SpotifyEpisodeFull>(`/episodes/${encodeURIComponent(id)}`);
        rows.push({
          episode_id: id,
          name: ep?.name ?? null,
          show: ep?.show?.name ?? null,
          duration_ms: ep?.duration_ms ?? null,
          current_resume_ms: ep?.resume_point?.resume_position_ms ?? null,
          fully_played: ep?.resume_point?.fully_played ?? null,
        });
      }
      const prose = [
        `[dry run] mark-played plan — the mark-played API was removed (issue #230); this tool is PLAN-ONLY.`,
        ...rows.map((r) => {
          const state = r.fully_played === true
            ? 'already fully played — no action'
            : r.fully_played === false
              ? `seek ${r.duration_ms != null ? msToClock(r.duration_ms) : '?'} to complete (currently ${Math.round((r.current_resume_ms ?? 0) / 60_000)} min in)`
              : 'play state unknown — play the episode to completion in a client';
          return `  • ${r.name ?? r.episode_id} (${r.show ?? '?'}): ${state}`;
        }),
      ].join('\n');
      return shape(rf, prose, {
        ok: true,
        dry_run: true,
        plan_only: true,
        reason: 'spotify mark-played endpoint removed (issue #230)',
        episodes: rows,
      });
    },
  );

  // 16. get_newly_released_episodes -------------------------------------------
  server.tool(
    'get_newly_released_episodes',
    'Collect episodes released since a date across ALL saved shows, merged newest-first and '
      + 'tagged with their show — the unified new-episode inbox. Defaults to the last 7 days.',
    {
      since: z.string().optional().describe('Inclusive release-date floor YYYY-MM-DD. Default 7 days ago'),
      max_shows: z.number().int().min(1).max(200).optional().describe('Max per-show episode lookups (request budget). Default 50'),
      ...sharedListFieldsShow(),
    },
    async (args) => {
      const rf = args.response_format;
      const since = args.since ?? addDays(formatDateStamp(), -7);
      const sinceNum = dateNum(since);
      const budget = args.max_shows ?? 50;
      const shows = (await fetchSavedShows(client)).filter((r) => r.show?.id);
      const fresh: EpisodeRow[] = [];
      let checked = 0;
      for (const r of shows) {
        if (checked >= budget) break;
        checked++;
        const eps = await latestShowEpisodes(client, r.show.id, 20);
        for (const ep of eps) {
          if (dateNum(ep.release_date) >= sinceNum) fresh.push(toEpisodeRow(ep));
        }
      }
      fresh.sort((a, b) => dateNum(b.releaseDate) - dateNum(a.releaseDate) || a.showName.localeCompare(b.showName));
      const view = truncateItems(fresh, resolveMaxResults(args.max_results, getConfig().maxItems));
      const prose = [
        `New episodes since ${since}: ${fresh.length} across ${checked} saved show(s)${shows.length > budget ? ` (budget capped at ${budget})` : ''}.`,
        ...view.items.map((r) => `  • ${r.releaseDate || '?'} · ${r.showName} — ${r.name} (${r.durationMs != null ? msToClock(r.durationMs) : '?'})`),
        view.footer ? `(${view.footer})` : '',
      ].filter(Boolean).join('\n');
      return shape(rf, prose, {
        ok: true,
        since,
        shows_checked: checked,
        total_new: fresh.length,
        episodes: view.items,
      });
    },
  );

  // 17. shows_release_calendar -------------------------------------------------
  server.tool(
    'shows_release_calendar',
    'Estimate each saved show\'s next expected release from its recent publish cadence (median '
      + 'interval between the latest publishes) — a forward calendar for your subscriptions. '
      + 'Defaults to 30 show lookups.',
    {
      max_shows: z.number().int().min(1).max(200).optional().describe('Max per-show episode lookups (request budget). Default 30'),
      ...sharedListFieldsShow(),
    },
    async (args) => {
      const rf = args.response_format;
      const budget = args.max_shows ?? 30;
      const now = Date.now();
      const shows = (await fetchSavedShows(client)).filter((r) => r.show?.id);
      const calendar: Array<{ id: string; name: string; publisher: string; latest_release: string | null; cadence_days: number | null; next_expected: string | null; overdue_days: number | null }> = [];
      let checked = 0;
      for (const r of shows) {
        if (checked >= budget) break;
        checked++;
        const eps = await latestShowEpisodes(client, r.show.id, 10);
        const latest = eps[0]?.release_date ?? null;
        const cadence = cadenceDays(eps);
        const nextExpected = latest && cadence != null ? addDays(latest, Math.round(cadence)) : null;
        calendar.push({
          id: r.show.id,
          name: r.show.name,
          publisher: publisherOf(r.show),
          latest_release: latest,
          cadence_days: cadence,
          next_expected: nextExpected,
          overdue_days: nextExpected ? daysBetween(nextExpected, now) : null,
        });
      }
      calendar.sort((a, b) => (a.next_expected ?? '9999').localeCompare(b.next_expected ?? '9999'));
      const view = truncateItems(calendar, resolveMaxResults(args.max_results, getConfig().maxItems));
      const prose = [
        `Release calendar for ${checked} saved show(s) (next expected first):`,
        ...view.items.map((c) => {
          const when = c.next_expected ?? 'unknown cadence';
          const overdue = c.overdue_days != null && c.overdue_days > 0 ? ` — overdue by ${c.overdue_days}d` : '';
          return `  • ${c.name}: ~${when} (latest ${c.latest_release ?? '?'}, cadence ≈${c.cadence_days != null ? Math.round(c.cadence_days) : '?'}d)${overdue}`;
        }),
        view.footer ? `(${view.footer})` : '',
      ].filter(Boolean).join('\n');
      return shape(rf, prose, {
        ok: true,
        shows_checked: checked,
        calendar: view.items,
      });
    },
  );

  // 18. episode_runtime_report ---------------------------------------------------
  server.tool(
    'episode_runtime_report',
    'Runtime statistics for one show\'s episodes — count, total/min/median/max duration, and the '
      + 'longest and shortest episodes — to plan listening time. Defaults to the 100 newest episodes.',
    {
      show_id: spotifyId('show').describe('Show ID, spotify:show: URI, or open.spotify.com/show URL'),
      episodes_limit: z.number().int().min(1).max(500).optional().describe('How many newest episodes to analyse. Default 100'),
      response_format: ResponseFormat,
      max_results: MaxResults,
    },
    async (args) => {
      const rf = args.response_format;
      const limit = args.episodes_limit ?? 100;
      const eps: SpotifyEpisodeSimple[] = await client.getAllPages<SpotifyEpisodeSimple>(
        `/shows/${encodeURIComponent(args.show_id)}/episodes`,
        { limit: '50' },
        { maxItems: Math.min(limit, getConfig().fetchAllCap) },
      );
      const rows = eps.map(toEpisodeRow);
      const durations = rows.map((r) => r.durationMs).filter((d): d is number => d != null);
      const total = durations.reduce((s, d) => s + d, 0);
      const sorted = [...durations].sort((a, b) => a - b);
      const longest = rows.reduce<EpisodeRow | null>((best, r) => (r.durationMs != null && (!best || (best.durationMs ?? 0) < r.durationMs) ? r : best), null);
      const shortest = rows.reduce<EpisodeRow | null>((best, r) => (r.durationMs != null && (!best || (best.durationMs ?? Infinity) > r.durationMs) ? r : best), null);
      const payload: Record<string, unknown> = {
        ok: true,
        show_id: args.show_id,
        episodes_analysed: rows.length,
        total_runtime_ms: total,
        total_runtime: msToClock(total),
        avg_ms: durations.length ? Math.round(total / durations.length) : null,
        median_ms: median(durations),
        min_ms: sorted[0] ?? null,
        max_ms: sorted[sorted.length - 1] ?? null,
        longest_episode: longest ? { name: longest.name, duration_ms: longest.durationMs, release_date: longest.releaseDate } : null,
        shortest_episode: shortest ? { name: shortest.name, duration_ms: shortest.durationMs, release_date: shortest.releaseDate } : null,
      };
      if (rf === 'json') return shape(rf, '', payload);
      return shape(rf, [
        `Runtime report over ${rows.length} episode(s):`,
        `  Total ${msToClock(total)} · avg ${durations.length ? msToClock(Math.round(total / durations.length)) : '?'} · median ${median(durations) != null ? msToClock(median(durations)!) : '?'} · range ${sorted[0] != null ? msToClock(sorted[0]) : '?'}–${sorted[sorted.length - 1] != null ? msToClock(sorted[sorted.length - 1]!) : '?'}`,
        longest ? `  Longest: "${longest.name}" (${msToClock(longest.durationMs ?? 0)})` : '',
        shortest ? `  Shortest: "${shortest.name}" (${msToClock(shortest.durationMs ?? 0)})` : '',
      ].filter(Boolean).join('\n'), payload);
    },
  );

  // 19. publisher_portfolio -------------------------------------------------------
  server.tool(
    'publisher_portfolio',
    'Per-publisher portfolio across your saved shows: show count, listed episode totals, and '
      + 'sampled runtime of their recent episodes — who owns your listening time. Defaults to '
      + '10 recent episodes per show.',
    {
      eps_per_show: z.number().int().min(1).max(50).optional().describe('Recent episodes sampled per show for runtime. Default 10'),
      ...sharedListFieldsShow(),
    },
    async (args) => {
      const rf = args.response_format;
      const perShow = args.eps_per_show ?? 10;
      const shows = (await fetchSavedShows(client)).filter((r) => r.show?.id);
      const byPub = new Map<string, { shows: string[]; listed_episodes: number; sampled_ms: number; sampled_eps: number }>();
      for (const r of shows) {
        const pub = publisherOf(r.show);
        const entry = byPub.get(pub) ?? { shows: [], listed_episodes: 0, sampled_ms: 0, sampled_eps: 0 };
        entry.shows.push(r.show.name);
        entry.listed_episodes += r.show.total_episodes ?? 0;
        const eps = await latestShowEpisodes(client, r.show.id, perShow);
        for (const ep of eps) {
          entry.sampled_ms += ep.duration_ms ?? 0;
          entry.sampled_eps++;
        }
        byPub.set(pub, entry);
      }
      const portfolio = [...byPub.entries()]
        .map(([publisher, v]) => ({
          publisher,
          show_count: v.shows.length,
          shows: v.shows,
          listed_episodes: v.listed_episodes,
          sampled_episodes: v.sampled_eps,
          sampled_runtime_ms: v.sampled_ms,
          avg_episode_ms: v.sampled_eps ? Math.round(v.sampled_ms / v.sampled_eps) : null,
        }))
        .sort((a, b) => b.show_count - a.show_count || b.listed_episodes - a.listed_episodes || a.publisher.localeCompare(b.publisher));
      const view = truncateItems(portfolio, resolveMaxResults(args.max_results, getConfig().maxItems));
      const prose = [
        `Publisher portfolio across ${shows.length} saved show(s), ${portfolio.length} publisher(s):`,
        ...view.items.map((p) => `  • ${p.publisher}: ${p.show_count} show(s), ${p.listed_episodes} listed eps, sampled runtime ${msToClock(p.sampled_runtime_ms)} (avg ${p.avg_episode_ms != null ? msToClock(p.avg_episode_ms) : '?'}/ep)`),
        view.footer ? `(${view.footer})` : '',
      ].filter(Boolean).join('\n');
      return shape(rf, prose, {
        ok: true,
        saved_shows: shows.length,
        portfolio: view.items,
      });
    },
  );

  // 20. show_activity_feed ----------------------------------------------------------
  server.tool(
    'show_activity_feed',
    'Chronological feed of the most recent episodes across ALL your saved shows, merged and '
      + 'sorted newest-first — one scroll instead of N show visits. Defaults to 3 episodes per '
      + 'show, newest first.',
    {
      eps_per_show: z.number().int().min(1).max(20).optional().describe('Recent episodes pulled per show. Default 3'),
      max_shows: z.number().int().min(1).max(200).optional().describe('Max per-show episode lookups (request budget). Default 50'),
      ...sharedListFieldsShow(),
    },
    async (args) => {
      const rf = args.response_format;
      const perShow = args.eps_per_show ?? 3;
      const budget = args.max_shows ?? 50;
      const shows = (await fetchSavedShows(client)).filter((r) => r.show?.id);
      const feed: EpisodeRow[] = [];
      let checked = 0;
      for (const r of shows) {
        if (checked >= budget) break;
        checked++;
        const eps = await latestShowEpisodes(client, r.show.id, perShow);
        for (const ep of eps) feed.push(toEpisodeRow(ep));
      }
      feed.sort((a, b) => dateNum(b.releaseDate) - dateNum(a.releaseDate) || a.showName.localeCompare(b.showName));
      const view = truncateItems(feed, resolveMaxResults(args.max_results, getConfig().maxItems));
      const prose = [
        `Activity feed: ${feed.length} episode(s) from ${checked} show(s), newest first.`,
        ...view.items.map((r) => `  • ${r.releaseDate || '?'} — ${r.showName}: ${r.name} (${r.durationMs != null ? msToClock(r.durationMs) : '?'})`),
        view.footer ? `(${view.footer})` : '',
      ].filter(Boolean).join('\n');
      return shape(rf, prose, {
        ok: true,
        shows_checked: checked,
        total_episodes: feed.length,
        episodes: view.items,
      });
    },
  );

  // 21. show_backlog_plan -----------------------------------------------------------
  server.tool(
    'show_backlog_plan',
    'Plan (dry-run only, never mutates) your podcast backlog: unlistened episodes across saved '
      + 'shows ordered SHORTEST-FIRST, so the queue clears with quick wins. Defaults to 20 recent '
      + 'episodes per show, 20 shows.',
    {
      eps_per_show: z.number().int().min(1).max(50).optional().describe('Recent episodes pulled per show. Default 20'),
      max_shows: z.number().int().min(1).max(200).optional().describe('Max per-show episode lookups (request budget). Default 20'),
      max_results: MaxResults,
      response_format: ResponseFormat,
      dry_run: DryRun,
    },
    async (args) => {
      const rf = args.response_format;
      const perShow = args.eps_per_show ?? 20;
      const budget = args.max_shows ?? 20;
      const shows = (await fetchSavedShows(client)).filter((r) => r.show?.id);
      const backlog: EpisodeRow[] = [];
      let checked = 0;
      for (const r of shows) {
        if (checked >= budget) break;
        checked++;
        const eps = await latestShowEpisodes(client, r.show.id, perShow);
        for (const ep of eps) {
          const row = toEpisodeRow(ep);
          if (row.fullyPlayed !== true) backlog.push(row);
        }
      }
      backlog.sort((a, b) => (a.durationMs ?? Infinity) - (b.durationMs ?? Infinity));
      const view = truncateItems(backlog, resolveMaxResults(args.max_results, getConfig().maxItems));
      const totalMs = backlog.reduce((s, r) => s + (r.durationMs ?? 0), 0);
      const plannedMs = view.items.reduce((s, r) => s + (r.durationMs ?? 0), 0);
      const prose = [
        `[dry run] backlog plan — ${backlog.length} unlistened episode(s), total ${msToClock(totalMs)}, shortest-first:`,
        ...view.items.map((r, i) => `  ${i + 1}. ${r.durationMs != null ? msToClock(r.durationMs) : '?'} · ${r.showName}: ${r.name} (${r.releaseDate || '?'})`),
        `  Planned block runtime: ${msToClock(plannedMs)}`,
        view.footer ? `(${view.footer})` : '',
      ].filter(Boolean).join('\n');
      return shape(rf, prose, {
        ok: true,
        dry_run: true,
        shows_checked: checked,
        backlog_size: backlog.length,
        backlog_runtime_ms: totalMs,
        plan: view.items,
      });
    },
  );

  // 22. find_show_by_publisher -------------------------------------------------------
  server.tool(
    'find_show_by_publisher',
    'Search the catalog and match shows whose PUBLISHER (network) matches your query — the '
      + 'missing publisher facet on show search. Defaults to 10 search results.',
    {
      query: z.string().describe('Publisher or network name, e.g. "Wondery"'),
      market: MARKET_CODE.optional().describe('ISO 3166-1 alpha-2 market for the search, e.g. \'US\''),
      ...sharedListFieldsShow(),
    },
    async (args) => {
      const rf = args.response_format;
      const params: Record<string, string> = { q: args.query, type: 'show', limit: '50' };
      if (args.market) params.market = args.market;
      const res = await client.get<{ shows?: { items?: (SpotifyShowSimple | null)[]; total?: number } }>(
        '/search',
        params,
      );
      const all = (res?.shows?.items ?? []).filter((s): s is SpotifyShowSimple => !!s?.id);
      const q = args.query.toLowerCase();
      const publisherMatches = all.filter((s) => publisherOf(s).toLowerCase().includes(q));
      const nameMatches = all.filter((s) => !publisherMatches.includes(s) && s.name.toLowerCase().includes(q));
      const view = truncateItems([...publisherMatches, ...nameMatches], resolveMaxResults(args.max_results, getConfig().maxItems));
      const rows = view.items.map((s) => ({
        id: s.id,
        name: s.name,
        publisher: publisherOf(s),
        total_episodes: s.total_episodes ?? null,
        publisher_match: publisherMatches.includes(s),
      }));
      const prose = [
        `Shows for "${args.query}": ${publisherMatches.length} publisher match(es), ${nameMatches.length} name-only match(es).`,
        ...rows.map((r) => `  ${r.publisher_match ? '★' : '·'} ${r.name} — ${r.publisher} · ${r.total_episodes ?? '?'} eps`),
        '(★ = publisher match)',
        view.footer ? `(${view.footer})` : '',
      ].filter(Boolean).join('\n');
      return shape(rf, prose, {
        ok: true,
        query: args.query,
        catalog_scanned: all.length,
        publisher_matches: publisherMatches.length,
        shows: rows,
      });
    },
  );

  // 23. episode_guest_census -----------------------------------------------------------
  server.tool(
    'episode_guest_census',
    'Census recurring GUESTS across a show\'s recent episodes by mining description credits '
      + '("with X", "featuring X", "guest X") — who keeps coming back. Defaults to the 20 newest '
      + 'episodes.',
    {
      show_id: spotifyId('show').describe('Show ID, spotify:show: URI, or open.spotify.com/show URL'),
      episodes_limit: z.number().int().min(1).max(50).optional().describe('Newest episodes to mine. Default 20'),
      ...sharedListFieldsShow(),
    },
    async (args) => {
      const rf = args.response_format;
      const limit = args.episodes_limit ?? 20;
      const eps = await latestShowEpisodes(client, args.show_id, limit);
      const counts = new Map<string, { count: number; episodes: string[] }>();
      for (const ep of eps) {
        for (const name of guestCandidates(ep.description)) {
          const key = name.toLowerCase();
          const entry = counts.get(key) ?? { count: 0, episodes: [] };
          entry.count++;
          if (entry.episodes.length < 3) entry.episodes.push(ep.name);
          counts.set(key, entry);
        }
      }
      const ranked = [...counts.entries()]
        .map(([key, v]) => ({ guest: key, mentions: v.count, sample_episodes: v.episodes }))
        .sort((a, b) => b.mentions - a.mentions || a.guest.localeCompare(b.guest));
      const view = truncateItems(ranked, resolveMaxResults(args.max_results, getConfig().maxItems));
      const prose = [
        `Guest census over ${eps.length} episode(s): ${ranked.length} distinct credit(s).`,
        ...view.items.map((g) => `  • ${g.guest} (${g.mentions}×) — e.g. ${g.sample_episodes.join('; ')}`),
        ranked.length === 0 ? '  (no credit patterns found in descriptions)' : '',
        view.footer ? `(${view.footer})` : '',
      ].filter(Boolean).join('\n');
      return shape(rf, prose, {
        ok: true,
        show_id: args.show_id,
        episodes_mined: eps.length,
        guests: view.items,
      });
    },
  );

  // 24. show_recommendation_brief ---------------------------------------------------------
  server.tool(
    'show_recommendation_brief',
    'Cross-reference newly released episodes against your saved-episode and recently-played '
      + 'history: which new drops are NOT yet saved or played — a listen-next brief. Defaults to '
      + 'the last 14 days.',
    {
      since: z.string().optional().describe('Inclusive release-date floor YYYY-MM-DD. Default 14 days ago'),
      max_shows: z.number().int().min(1).max(200).optional().describe('Max per-show episode lookups (request budget). Default 50'),
      ...sharedListFieldsShow(),
    },
    async (args) => {
      const rf = args.response_format;
      const since = args.since ?? addDays(formatDateStamp(), -14);
      const sinceNum = dateNum(since);
      const budget = args.max_shows ?? 50;
      const shows = (await fetchSavedShows(client)).filter((r) => r.show?.id);
      const newEps: EpisodeRow[] = [];
      let checked = 0;
      for (const r of shows) {
        if (checked >= budget) break;
        checked++;
        const eps = await latestShowEpisodes(client, r.show.id, 20);
        for (const ep of eps) {
          if (dateNum(ep.release_date) >= sinceNum) newEps.push(toEpisodeRow(ep));
        }
      }
      // Listen-state cross-reference: saved episodes + recently played (best effort).
      const [savedEps, recentlyPlayed] = await Promise.all([
        fetchSavedEpisodes(client),
        client
          .get<{ items?: Array<{ track?: SpotifyEpisodeFull | null }> }>('/me/player/recently-played', { limit: '50' })
          .catch(() => null),
      ]);
      const savedIds = new Set(savedEps.map((r) => r.episode?.id).filter(Boolean) as string[]);
      const playedIds = new Set(
        (recentlyPlayed?.items ?? [])
          .map((r) => r.track?.id)
          .filter(Boolean) as string[],
      );
      const brief = newEps.map((r) => ({
        ...r,
        saved_in_library: savedIds.has(r.id),
        recently_played: playedIds.has(r.id),
        unlistened: !savedIds.has(r.id) && !playedIds.has(r.id) && r.fullyPlayed !== true,
      }));
      brief.sort((a, b) => dateNum(b.releaseDate) - dateNum(a.releaseDate));
      const unlistened = brief.filter((b) => b.unlistened);
      const view = truncateItems(brief, resolveMaxResults(args.max_results, getConfig().maxItems));
      const prose = [
        `Listen-next brief (episodes since ${since}): ${newEps.length} new, ${unlistened.length} unlistened across ${checked} show(s).`,
        ...view.items.map((b) => {
          const flags = [b.saved_in_library ? 'saved' : null, b.recently_played ? 'recently played' : null].filter(Boolean);
          return `  ${b.unlistened ? '▶' : '·'} ${b.releaseDate || '?'} · ${b.showName}: ${b.name}${flags.length ? ` [${flags.join(', ')}]` : ' [NEW — not in library or history]'}`;
        }),
        view.footer ? `(${view.footer})` : '',
      ].filter(Boolean).join('\n');
      return shape(rf, prose, {
        ok: true,
        since,
        shows_checked: checked,
        new_episodes: newEps.length,
        unlistened: unlistened.length,
        brief: view.items,
      });
    },
  );
}

/** List-tool shared fields: response_format + max_results (local alias for readability). */
function sharedListFieldsShow(): { response_format: typeof ResponseFormat; max_results: typeof MaxResults } {
  return { response_format: ResponseFormat, max_results: MaxResults };
}
