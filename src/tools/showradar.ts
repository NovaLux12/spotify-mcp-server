/**
 * show_new_episodes (#173): new-episode radar across saved podcast shows.
 *
 * Pages /me/shows, fetches the latest episodes per show
 * (GET /shows/{id}/episodes), filters to those released within the lookback
 * window, and cross-references /me/episodes to mark which are already saved.
 *
 * Pure composition over non-deprecated endpoints; mirrors whats_new's radar
 * UX for podcasts. Budget/quota hardening mirrors whats_new (#242/#249).
 *
 * Truncation is disclosed on both axes: the /me/shows listing cap (#673) and
 * the per-call show lookup budget. The cost preview is `cost_preview`, not
 * the mutation `dry_run` — this tool changes nothing (#794).
 *
 * #835: the data-collection logic is exported as `collectShowRadarEpisodes`
 * so save_show_digest (playbackext) can run the radar without going through
 * the tool registration. The tool handler delegates to it and only formats
 * the MCP response — there is one code path for both callers.
 */
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { SpotifyClient } from '../client.js';
import { SpotifyApiError } from '../client.js';
import {
  resolveMaxResults,
  sharedListFields,
  truncateItems,
} from '../shaping.js';
import { getConfig } from '../config.js';
import {
  MARKET_CODE,
  resolveRequestMarket,
  resetProfileCountryCache,
  withMarketHint,
  withMarketSource,
  type MarketResolution,
} from '../markets.js';
import type {
  SavedEpisodeItem,
  SavedShowItem,
  SpotifyEpisodeSimple,
  SpotifyPaged,
} from '../types/spotify.js';

// Re-exported so this module's tests import the market cache hook the same way
// the catalog and audiobooks suites do (#782).
export { resetProfileCountryCache };

type TextContent = { type: 'text'; text: string };
type ToolResult = { content: TextContent[]; structuredContent?: Record<string, unknown> };

const textResult = (text: string, structured?: Record<string, unknown>): ToolResult => ({
  content: [{ type: 'text', text }],
  ...(structured ? { structuredContent: structured } : {}),
});

/** The show/episode lookups this module makes are market-gated, so a hint that
 *  names the family is more use than the generic wording (#782). */
const SHOW_EPISODES_GATED = 'Show episode lookups';

const MARKET_HINT =
  'ISO 3166-1 alpha-2 country code for the per-show episode lookups, e.g. "US". '
  + 'Defaults to SPOTIFY_MCP_MARKET, then to the account country — these '
  + 'lookups are market-gated, so a wrong default silently drops episode rows.';

/**
 * Read-only cost preview (#794). The shared `DryRun` fragment is a *mutation*
 * preview ("describe exactly what would change without performing it"), and
 * show_new_episodes mutates nothing — a `dry_run: true` call replaced the
 * requested episode list with a cost estimate, so an agent that set the flag
 * defensively on this read-only tool got a preview where it expected results.
 * Renamed to `cost_preview` and described as what it is: no calls, no list.
 */
const CostPreview = z
  .boolean()
  .optional()
  .describe(
    'Cost preview only: make no API calls and return the request budget instead of the '
      + 'episode list. Use it to size a real call; it does not report any episodes. Default false.',
  );

/**
 * Disclosure line for a /me/shows listing that stopped at the fetch-all cap
 * (#673). Without it a capped listing reads as the whole library, so a
 * partial scan reports itself as a complete one.
 */
function listingCapNote(listed: number, cap: number): string {
  return ` Saved-show listing stopped at the fetch-all cap of ${cap} (SPOTIFY_MCP_FETCH_ALL_CAP) with ${listed} show(s) listed, so the library may hold more saved shows than were seen; this scan is incomplete. Raise SPOTIFY_MCP_FETCH_ALL_CAP to cover the full library.`;
}

/**
 * Per-call episode-lookup budget, and where it came from (#590).
 *
 * The `max_shows` description advertises SPOTIFY_MCP_SHOWRADAR_BUDGET, so the
 * variable has to be read: it overrides the shared SPOTIFY_MCP_FRESHNESS_BUDGET
 * for this tool only. It was previously a silent no-op — an operator who
 * exported the documented knob saw identical behaviour and no diagnostic.
 * An unset, unparsable or non-positive value falls back to the shared budget,
 * parsing exactly as config.positiveInt does.
 *
 * The source is returned alongside the budget because the cost preview and the
 * truncation note name the variable in prose: reporting the shared budget's
 * name while a different variable is in force is its own small lie.
 */
function resolveBudget(
  maxShows: number | undefined,
  shared: number,
  env: NodeJS.ProcessEnv = process.env,
): { budget: number; source: string } {
  if (maxShows !== undefined) return { budget: maxShows, source: 'max_shows argument' };
  const override = Number.parseInt(env.SPOTIFY_MCP_SHOWRADAR_BUDGET ?? '', 10);
  if (Number.isFinite(override) && override > 0) {
    return { budget: override, source: 'SPOTIFY_MCP_SHOWRADAR_BUDGET' };
  }
  return { budget: shared, source: 'SPOTIFY_MCP_FRESHNESS_BUDGET' };
}

function cutoffDate(days: number): string {
  return new Date(Date.now() - days * 86400_000).toISOString().slice(0, 10);
}

function isQuotaError(err: unknown): { quota: boolean; retryAfter: number | undefined } {
  if (err instanceof SpotifyApiError && err.status === 429 && err.reason === 'QUOTA_EXCEEDED') {
    return { quota: true, retryAfter: err.retryAfterSec };
  }
  if (
    err !== null && typeof err === 'object' &&
    (err as { status?: unknown; reason?: unknown }).status === 429 &&
    (err as { reason?: unknown }).reason === 'QUOTA_EXCEEDED'
  ) {
    const ra = (err as { retryAfterSec?: unknown }).retryAfterSec;
    return { quota: true, retryAfter: typeof ra === 'number' ? ra : undefined };
  }
  return { quota: false, retryAfter: undefined };
}

/** One row the radar emits, in display order (newest first after sorting). */
export interface ShowRadarEpisode {
  show_id: string;
  show_name: string;
  episode_id: string;
  episode_name: string;
  release_date: string;
  duration_ms: number;
  uri: string;
  saved: boolean;
}

/** What `collectShowRadarEpisodes` returns — the input to either formatting or persistence. */
export interface ShowRadarResult {
  /** Episodes within the lookback window, newest first. Empty when nothing matched. */
  episodes: ShowRadarEpisode[];
  /** Cutoff ISO date (YYYY-MM-DD) used to filter episodes by release_date. */
  cutoff: string;
  days: number;
  /** Number of /me/shows entries that came back (pre-budget). */
  saved_shows_total: number;
  /** True iff /me/shows stopped at the fetch-all cap (#673). */
  shows_listing_truncated: boolean;
  /** The cap /me/shows was read under. */
  shows_list_cap: number;
  /** How many shows were actually checked for new episodes. */
  shows_scanned: number;
  /** True iff the per-call budget capped the show scan below saved_shows_total. */
  truncated_by_budget: boolean;
  /** max_shows in force (per-call argument or env). */
  max_shows: number;
  /** Which knob supplied max_shows ('max_shows argument' | env var name | 'SPOTIFY_MCP_FRESHNESS_BUDGET'). */
  budget_source: string;
  /** min(max_shows, fetchAllCap). */
  effective_cap: number;
  per_show_limit: number;
  /** True iff a 429 QUOTA_EXCEEDED halted the per-show loop. */
  quota_hit: boolean;
  /** Retry-After in seconds when quota_hit, else null. */
  retry_after: number | null;
  /** When quota_hit, the number of shows scanned before it. Otherwise shows_scanned. */
  quota_scanned_shows: number;
  /** #782: the market the per-show episode lookups carried, or null when none did. */
  market: string | null;
  /** #782: where that market came from. Absent is a real outcome, not a gap. */
  market_source: MarketResolution['source'];
}

/** Args the radar accepts from any caller (tool handler or save_show_digest). */
export interface CollectShowRadarEpisodesArgs {
  days: number;
  per_show_limit: number;
  max_shows?: number;
  /** #782: caller market for the per-show episode lookups; omitted means default. */
  market?: string;
}

/**
 * Run the show-new-episodes radar end to end and return the data the caller
 * needs to format or persist it.
 *
 * #835: this is the one place the radar reads shows and episodes, so both the
 * tool handler and save_show_digest get the same episodes, the same disclosures,
 * and the same partial-on-quota behaviour. The tool's handler must still drive
 * the cost_preview branch itself — that branch never makes API calls and the
 * caller may legitimately want to short-circuit before doing anything here.
 *
 * The function does NOT consult `cost_preview` — callers wanting the preview
 * must branch before invoking this.
 */
export async function collectShowRadarEpisodes(
  client: SpotifyClient,
  args: CollectShowRadarEpisodesArgs,
): Promise<ShowRadarResult> {
  const cutoff = cutoffDate(args.days);
  const { budget, source: budgetSource } = resolveBudget(args.max_shows, getConfig().freshnessBudget);
  const effectiveCap = Math.min(budget, getConfig().fetchAllCap);

  let quotaHit = false;
  let quotaRetryAfter: number | undefined;
  let quotaScannedShows = 0;

  let savedShows: SavedShowItem[] = [];
  try {
    savedShows = await client.getAllPages<SavedShowItem>('/me/shows', { limit: '50' }, {
      maxItems: getConfig().fetchAllCap,
    });
  } catch (err) {
    const q = isQuotaError(err);
    if (q.quota) {
      quotaHit = true;
      quotaRetryAfter = q.retryAfter;
      // Quota on the shows listing: no episodes to return, no shows scanned.
      return {
        episodes: [],
        cutoff,
        days: args.days,
        saved_shows_total: 0,
        shows_listing_truncated: false,
        shows_list_cap: getConfig().fetchAllCap,
        shows_scanned: 0,
        truncated_by_budget: false,
        max_shows: budget,
        budget_source: budgetSource,
        effective_cap: effectiveCap,
        per_show_limit: args.per_show_limit,
        quota_hit: true,
        retry_after: quotaRetryAfter ?? null,
        quota_scanned_shows: 0,
        market: null,
        market_source: 'none',
      };
    }
    throw err;
  }

  // #673: the /me/shows walk stops at the fetch-all cap and reports nothing
  // about it, so a capped listing used to read as the whole library — a
  // partial scan reported as a complete one. getAllPages returns exactly
  // maxItems when it truncates, so reaching the cap is the signal; the count
  // alone cannot be trusted as the library size.
  const showsListCap = getConfig().fetchAllCap;
  const showsListingTruncated = savedShows.length >= showsListCap;

  if (savedShows.length === 0) {
    return {
      episodes: [],
      cutoff,
      days: args.days,
      saved_shows_total: 0,
      shows_listing_truncated: showsListingTruncated,
      shows_list_cap: showsListCap,
      shows_scanned: 0,
      truncated_by_budget: false,
      max_shows: budget,
      budget_source: budgetSource,
      effective_cap: effectiveCap,
      per_show_limit: args.per_show_limit,
      quota_hit: false,
      retry_after: null,
      quota_scanned_shows: 0,
      market: null,
      market_source: 'none',
    };
  }
  const truncatedByBudget = savedShows.length > effectiveCap;
  const showsToScan = savedShows.slice(0, effectiveCap);

  // #782: the per-show /shows/{id}/episodes lookups below are market-gated and
  // sent no market at all, so an account outside Spotify's default market lost
  // episode rows and a short list read as "this show has no more episodes".
  // Resolved once here — after the empty-library exit, so a scan that reads
  // nothing does not pay for a /me round-trip — and once for every caller,
  // including save_show_digest, which shares this function.
  const market = await resolveRequestMarket(client, args.market);

  // Cross-ref: which episodes are already saved (/me/episodes)?
  let savedEpisodes: SavedEpisodeItem[] = [];
  try {
    savedEpisodes = await client.getAllPages<SavedEpisodeItem>('/me/episodes', { limit: '50' }, {
      maxItems: getConfig().fetchAllCap,
    });
  } catch (err) {
    const q = isQuotaError(err);
    if (q.quota) {
      quotaHit = true;
      quotaRetryAfter = q.retryAfter;
      // Partial with no episode candidates; disclose the budget we never used.
      return {
        episodes: [],
        cutoff,
        days: args.days,
        saved_shows_total: savedShows.length,
        shows_listing_truncated: showsListingTruncated,
        shows_list_cap: showsListCap,
        shows_scanned: 0,
        truncated_by_budget: truncatedByBudget,
        max_shows: budget,
        budget_source: budgetSource,
        effective_cap: effectiveCap,
        per_show_limit: args.per_show_limit,
        quota_hit: true,
        retry_after: quotaRetryAfter ?? null,
        quota_scanned_shows: 0,
        market: market.market ?? null,
        market_source: market.source,
      };
    }
    throw err;
  }
  const savedUris = new Set(
    (savedEpisodes ?? []).map((e) => e.episode?.uri).filter((uri): uri is string => typeof uri === 'string'),
  );

  const candidates: ShowRadarEpisode[] = [];
  let showsScanned = 0;
  for (const entry of showsToScan) {
    const show = entry?.show;
    if (!show?.id) continue;
    try {
      const resp = await client.get<SpotifyPaged<SpotifyEpisodeSimple>>(
        `/shows/${encodeURIComponent(show.id)}/episodes`,
        market.market
          ? { limit: String(args.per_show_limit), market: market.market }
          : { limit: String(args.per_show_limit) },
      );
      showsScanned++;
      for (const ep of resp?.items ?? []) {
        if (!ep?.release_date || ep.release_date < cutoff) continue;
        candidates.push({
          show_id: show.id,
          show_name: show.name ?? show.id,
          episode_id: ep.id,
          episode_name: ep.name ?? ep.id,
          release_date: ep.release_date,
          duration_ms: ep.duration_ms ?? 0,
          uri: ep.uri,
          saved: ep.uri ? savedUris.has(ep.uri) : false,
        });
      }
    } catch (err) {
      const q = isQuotaError(err);
      if (q.quota) {
        quotaHit = true;
        quotaRetryAfter = q.retryAfter;
        quotaScannedShows = showsScanned;
        break;
      }
      throw withMarketHint(err, market.market, args.market, SHOW_EPISODES_GATED);
    }
  }

  // Newest first; tie-break by show/episode id for determinism.
  candidates.sort(
    (a, b) => b.release_date.localeCompare(a.release_date) || a.show_name.localeCompare(b.show_name) || a.episode_name.localeCompare(b.episode_name),
  );

  return {
    episodes: candidates,
    cutoff,
    days: args.days,
    saved_shows_total: savedShows.length,
    shows_listing_truncated: showsListingTruncated,
    shows_list_cap: showsListCap,
    shows_scanned: quotaHit ? quotaScannedShows : showsScanned,
    truncated_by_budget: truncatedByBudget,
    max_shows: budget,
    budget_source: budgetSource,
    effective_cap: effectiveCap,
    per_show_limit: args.per_show_limit,
    quota_hit: quotaHit,
    retry_after: quotaRetryAfter ?? null,
    quota_scanned_shows: quotaHit ? quotaScannedShows : showsScanned,
    market: market.market ?? null,
    market_source: market.source,
  };
}

export function registerShowRadarTools(server: McpServer, client: SpotifyClient): void {
  server.tool(
    'show_new_episodes',
    'Find new episodes across your saved podcast shows: reports episodes '
      + 'released within the lookback window (default 7 days), marking which are already '
      + 'saved in your episode library. Fetches /me/shows then each show\'s latest episodes. '
      + 'WARNING: M saved shows → M+1 requests (1 show page + M episode lookups). Use max_shows to budget '
      + 'and cost_preview to see the cost without making any calls. This tool is read-only: nothing is ever changed.',
    {
      ...sharedListFields,
      days: z
        .number()
        .int()
        .min(1)
        .max(365)
        .optional()
        .default(7)
        .describe('Lookback window in days. Default 7.'),
      per_show_limit: z
        .number()
        .int()
        .min(1)
        .max(50)
        .optional()
        .default(3)
        .describe('How many latest episodes to check per show for recency. Default 3.'),
      max_shows: z
        .number()
        .int()
        .min(1)
        .max(500)
        .optional()
        .describe(
          'Per-call budget for show episode lookups. Default: 25 '
            + '(or SPOTIFY_MCP_FRESHNESS_BUDGET / SPOTIFY_MCP_SHOWRADAR_BUDGET). '
            + 'Scan caps at min(budget, SPOTIFY_MCP_FETCH_ALL_CAP) and reports truncation. '
            + 'WARNING: each lookup is an API request.',
        ),
      cost_preview: CostPreview,
      market: MARKET_CODE.optional().describe(MARKET_HINT),
    },
    async (args) => {
      const cutoff = cutoffDate(args.days);
      const { budget, source: budgetSource } = resolveBudget(args.max_shows, getConfig().freshnessBudget);
      const effectiveCap = Math.min(budget, getConfig().fetchAllCap);

      // ---- cost_preview: describe cost without any API calls ---------
      if (args.cost_preview) {
        const costEstimate = `M saved shows → M+1 requests (1 /me/shows page + M per-show episode lookups), capped at max_shows=${budget} lookups → at most ${budget + 1} requests (effective cap ${effectiveCap} with fetchAllCap=${getConfig().fetchAllCap})`;
        const prose =
          `[cost preview] show_new_episodes — no API calls were made and the episode list is not returned.\n`
          + `Cutoff: episodes on/after ${cutoff} (last ${args.days} day(s))\n`
          + `Per-show limit: ${args.per_show_limit}\n`
          + `Cost estimate: ${costEstimate}\n`
          + `Budget: max_shows=${budget} (${budgetSource}), effective cap ${effectiveCap}.\n`
          + `Saved show count unknown until executed; scan will cap episode lookups at ${effectiveCap}.\n`
          + `Re-run without cost_preview for the new-episode list.`;
        return textResult(prose, {
          ok: true,
          cost_preview: true,
          episodes_returned: false,
          days: args.days,
          cutoff,
          per_show_limit: args.per_show_limit,
          cost_estimate: costEstimate,
          max_shows: budget,
          budget_source: budgetSource,
          effective_cap: effectiveCap,
          shows_list_cap: getConfig().fetchAllCap,
          would_check: `up to ${effectiveCap} shows`,
          capped_at: effectiveCap,
        });
      }

      // #835: delegate to the shared collector. The tool's role is formatting
      // the response, not re-implementing the radar.
      const r = await collectShowRadarEpisodes(client, {
        days: args.days,
        per_show_limit: args.per_show_limit,
        max_shows: args.max_shows,
        market: args.market,
      });
      // #782: reported on every exit below, so a short list cannot be read as
      // "the show has no more episodes" when it was a market-scoped one.
      const market: MarketResolution = { market: r.market ?? undefined, source: r.market_source };

      const showsListingNote = r.shows_listing_truncated ? listingCapNote(r.saved_shows_total, r.shows_list_cap) : '';
      const extra: Record<string, unknown> = {
        days: r.days,
        cutoff: r.cutoff,
        saved_shows: r.saved_shows_total,
        saved_shows_total: r.saved_shows_total,
        shows_listing_truncated: r.shows_listing_truncated,
        shows_list_cap: r.shows_list_cap,
        shows_scanned: r.quota_hit ? r.quota_scanned_shows : r.shows_scanned,
        truncated_by_budget: r.truncated_by_budget,
        max_shows: r.max_shows,
        budget_source: r.budget_source,
        effective_cap: r.effective_cap,
        per_show_limit: r.per_show_limit,
        new_episodes: r.episodes.length,
      };
      if (r.quota_hit) {
        Object.assign(extra, { quota_hit: true, retry_after: r.retry_after, shows_scanned: r.quota_scanned_shows });
      }

      if (r.episodes.length === 0) {
        // Empty library is its own answer — "no shows" reads differently from
        // "shows, but no new episodes in the window" and the latter should
        // never be confused for the former (#173).
        const base = r.saved_shows_total === 0
          ? 'No saved shows in your library — nothing to scan.'
          : `No new episodes found across ${r.quota_hit ? r.quota_scanned_shows : r.shows_scanned} saved show(s) in the last ${r.days} day(s) (since ${r.cutoff}).`;
        const suffix = r.quota_hit
          ? ` Quota exceeded mid-scan (QUOTA_EXCEEDED) after ${r.quota_scanned_shows} shows.${r.retry_after != null ? ` Retry-After: ${r.retry_after}s.` : ''}`
          : r.truncated_by_budget ? ` (scan capped at ${r.effective_cap} shows; ${r.saved_shows_total - r.effective_cap} shows not scanned — raise max_shows to see more)` : '';
        const budgetNote = r.truncated_by_budget ? ` Truncated by budget: ${r.effective_cap} of ${r.saved_shows_total} shows scanned.` : '';
        return withMarketSource(
          textResult(base + suffix + budgetNote + showsListingNote, { ...extra, ok: true, episodes: [] }),
          market,
        );
      }

      const maxResults = resolveMaxResults(args.max_results, getConfig().maxItems);
      const view = truncateItems(r.episodes, maxResults);

      if (args.response_format === 'json') {
        return withMarketSource(
          textResult(JSON.stringify({ ...extra, episodes: view.items }, null, 2), {
            ok: true,
            ...extra,
            episodes: view.items,
          }),
          market,
        );
      }

      const lines = [
        `Found ${r.episodes.length} new episode(s) across ${r.quota_hit ? r.quota_scanned_shows : r.shows_scanned} saved show(s) since ${r.cutoff}:`,
      ];
      for (const ep of view.items) {
        const flag = ep.saved ? ' [saved]' : '';
        lines.push(`• "${ep.episode_name}" — ${ep.show_name} (${ep.release_date}, ${Math.round(ep.duration_ms / 1000)}s)${flag} | ${ep.uri}`);
      }
      if (view.footer) lines.push(`(${view.footer})`);
      if (r.shows_listing_truncated) lines.push(`Saved-show listing capped: ${r.saved_shows_total} show(s) listed, stopping at the fetch-all cap of ${r.shows_list_cap} (SPOTIFY_MCP_FETCH_ALL_CAP) — shows beyond the cap were never listed, so this scan is incomplete. Raise SPOTIFY_MCP_FETCH_ALL_CAP to cover the full library.`);
      if (r.truncated_by_budget) lines.push(`Truncated by budget: scanned ${r.effective_cap} of ${r.saved_shows_total} saved shows (budget ${r.max_shows} from ${r.budget_source}, effective cap ${r.effective_cap}). Raise max_shows or the budget variable to scan more.`);
      if (r.quota_hit) {
        const retryMsg = r.retry_after != null ? ` Retry-After: ${r.retry_after}s.` : '';
        lines.push(`Quota exceeded mid-scan (QUOTA_EXCEEDED) after ${r.quota_scanned_shows} shows — partial results.${retryMsg}`);
      }
      return withMarketSource(textResult(lines.join('\n'), { ok: true, ...extra, episodes: view.items }), market);
    },
  );
}
