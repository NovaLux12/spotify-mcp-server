/**
 * show_new_episodes (#173): new-episode radar across saved podcast shows.
 *
 * Pages /me/shows, fetches the latest episodes per show
 * (GET /shows/{id}/episodes), filters to those released within the lookback
 * window, and cross-references /me/episodes to mark which are already saved.
 *
 * Pure composition over non-deprecated endpoints; mirrors whats_new's radar
 * UX for podcasts. Budget/quota hardening mirrors whats_new (#242/#249).
 */
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { SpotifyClient } from '../client.js';
import { SpotifyApiError } from '../client.js';
import {
  DryRun,
  resolveMaxResults,
  sharedListFields,
  truncateItems,
} from '../shaping.js';
import { getConfig } from '../config.js';
import type {
  SavedEpisodeItem,
  SavedShowItem,
  SpotifyEpisodeSimple,
  SpotifyPaged,
} from '../types/spotify.js';

type TextContent = { type: 'text'; text: string };
type ToolResult = { content: TextContent[]; structuredContent?: Record<string, unknown> };

const textResult = (text: string, structured?: Record<string, unknown>): ToolResult => ({
  content: [{ type: 'text', text }],
  ...(structured ? { structuredContent: structured } : {}),
});

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

export function registerShowRadarTools(server: McpServer, client: SpotifyClient): void {
  server.tool(
    'show_new_episodes',
    'Find new episodes across your saved podcast shows: reports episodes '
      + 'released within the lookback window (default 7 days), marking which are already '
      + 'saved in your episode library. Fetches /me/shows then each show\'s latest episodes. '
      + 'WARNING: M saved shows → M+1 requests (1 show page + M episode lookups). Use max_shows to budget '
      + 'and dry_run to preview the cost before running.',
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
      dry_run: DryRun,
    },
    async (args) => {
      const cutoff = cutoffDate(args.days);
      const freshnessBudget = args.max_shows ?? getConfig().freshnessBudget;
      const effectiveCap = Math.min(freshnessBudget, getConfig().fetchAllCap);

      // ---- dry_run: describe cost without any API calls ---------
      if (args.dry_run) {
        const costEstimate = `M saved shows → M+1 requests (1 /me/shows page + M per-show episode lookups), capped at max_shows=${freshnessBudget} lookups → at most ${freshnessBudget + 1} requests (effective cap ${effectiveCap} with fetchAllCap=${getConfig().fetchAllCap})`;
        const prose =
          `[dry run] show_new_episodes preview — no API calls were made and nothing was changed.\n`
          + `Cutoff: episodes on/after ${cutoff} (last ${args.days} day(s))\n`
          + `Per-show limit: ${args.per_show_limit}\n`
          + `Cost estimate: ${costEstimate}\n`
          + `Budget: max_shows=${freshnessBudget} (SPOTIFY_MCP_FRESHNESS_BUDGET), effective cap ${effectiveCap}.\n`
          + `Saved show count unknown until executed; scan will cap episode lookups at ${effectiveCap}.`;
        return textResult(prose, {
          ok: true,
          dry_run: true,
          days: args.days,
          cutoff,
          per_show_limit: args.per_show_limit,
          cost_estimate: costEstimate,
          max_shows: freshnessBudget,
          effective_cap: effectiveCap,
          would_check: `up to ${effectiveCap} shows`,
          capped_at: effectiveCap,
        });
      }

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
          return textResult(
            `Quota exceeded while listing saved shows (QUOTA_EXCEEDED). No episodes scanned.${quotaRetryAfter != null ? ` Retry-After: ${quotaRetryAfter}s.` : ''}`,
            {
              ok: true,
              quota_hit: true,
              retry_after: quotaRetryAfter ?? null,
              shows_scanned: 0,
              saved_shows_total: 0,
              truncated_by_budget: false,
              quota_hit_at: 'listing shows',
              days: args.days,
              cutoff,
              new_episodes: 0,
              episodes: [],
            },
          );
        }
        throw err;
      }

      if (savedShows.length === 0) {
        return textResult('No saved shows in your library — nothing to scan.', {
          ok: true,
          days: args.days,
          cutoff,
          saved_shows: 0,
          saved_shows_total: 0,
          shows_scanned: 0,
          truncated_by_budget: false,
          new_episodes: 0,
          episodes: [],
        });
      }

      const truncatedByBudget = savedShows.length > effectiveCap;
      const showsToScan = savedShows.slice(0, effectiveCap);

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
          // Return partial with no episode candidates
          return textResult(
            `Quota exceeded while listing saved episodes (QUOTA_EXCEEDED). Partial: ${showsToScan.length} shows would be scanned.${quotaRetryAfter != null ? ` Retry-After: ${quotaRetryAfter}s.` : ''}`,
            {
              ok: true,
              quota_hit: true,
              retry_after: quotaRetryAfter ?? null,
              shows_scanned: 0,
              saved_shows_total: savedShows.length,
              truncated_by_budget: truncatedByBudget,
              max_shows: freshnessBudget,
              effective_cap: effectiveCap,
              days: args.days,
              cutoff,
              new_episodes: 0,
              episodes: [],
            },
          );
        }
        throw err;
      }
      const savedUris = new Set(
        (savedEpisodes ?? []).map((e) => e.episode?.uri).filter((uri): uri is string => typeof uri === 'string'),
      );

      interface EpisodeRow {
        show_id: string;
        show_name: string;
        episode_id: string;
        episode_name: string;
        release_date: string;
        duration_ms: number;
        uri: string;
        saved: boolean;
      }

      const candidates: EpisodeRow[] = [];
      let showsScanned = 0;
      for (const entry of showsToScan) {
        const show = entry?.show;
        if (!show?.id) continue;
        try {
          const resp = await client.get<SpotifyPaged<SpotifyEpisodeSimple>>(
            `/shows/${encodeURIComponent(show.id)}/episodes`,
            { limit: String(args.per_show_limit) },
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
          throw err;
        }
      }

      // Newest first; tie-break by show/episode id for determinism.
      candidates.sort(
        (a, b) => b.release_date.localeCompare(a.release_date) || a.show_name.localeCompare(b.show_name) || a.episode_name.localeCompare(b.episode_name),
      );

      const extra: Record<string, unknown> = {
        days: args.days,
        cutoff,
        saved_shows: savedShows.length,
        saved_shows_total: savedShows.length,
        shows_scanned: quotaHit ? quotaScannedShows : showsScanned,
        truncated_by_budget: truncatedByBudget,
        max_shows: freshnessBudget,
        effective_cap: effectiveCap,
        per_show_limit: args.per_show_limit,
        new_episodes: candidates.length,
      };
      if (quotaHit) {
        Object.assign(extra, { quota_hit: true, retry_after: quotaRetryAfter ?? null, shows_scanned: quotaScannedShows });
      }

      if (candidates.length === 0) {
        const base = `No new episodes found across ${quotaHit ? quotaScannedShows : showsScanned} saved show(s) in the last ${args.days} day(s) (since ${cutoff}).`;
        const suffix = quotaHit
          ? ` Quota exceeded mid-scan (QUOTA_EXCEEDED) after ${quotaScannedShows} shows.${quotaRetryAfter != null ? ` Retry-After: ${quotaRetryAfter}s.` : ''}`
          : truncatedByBudget ? ` (scan capped at ${effectiveCap} shows; ${savedShows.length - effectiveCap} shows not scanned — raise max_shows to see more)` : '';
        const budgetNote = truncatedByBudget ? ` Truncated by budget: ${effectiveCap} of ${savedShows.length} shows scanned.` : '';
        return textResult(base + suffix + budgetNote, { ...extra, ok: true, episodes: [] });
      }

      const maxResults = resolveMaxResults(args.max_results, getConfig().maxItems);
      const view = truncateItems(candidates, maxResults);

      if (args.response_format === 'json') {
        return textResult(JSON.stringify({ ...extra, episodes: view.items }, null, 2), {
          ok: true,
          ...extra,
          episodes: view.items,
        });
      }

      const lines = [
        `Found ${candidates.length} new episode(s) across ${quotaHit ? quotaScannedShows : showsScanned} saved show(s) since ${cutoff}:`,
      ];
      for (const ep of view.items) {
        const flag = ep.saved ? ' [saved]' : '';
        lines.push(`• "${ep.episode_name}" — ${ep.show_name} (${ep.release_date}, ${Math.round(ep.duration_ms / 1000)}s)${flag} | ${ep.uri}`);
      }
      if (view.footer) lines.push(`(${view.footer})`);
      if (truncatedByBudget) lines.push(`Truncated by budget: scanned ${effectiveCap} of ${savedShows.length} saved shows (max_shows=${freshnessBudget}, effective cap ${effectiveCap}). Raise max_shows to scan more.`);
      if (quotaHit) {
        const retryMsg = quotaRetryAfter != null ? ` Retry-After: ${quotaRetryAfter}s.` : '';
        lines.push(`Quota exceeded mid-scan (QUOTA_EXCEEDED) after ${quotaScannedShows} shows — partial results.${retryMsg}`);
      }
      return textResult(lines.join('\n'), { ok: true, ...extra, episodes: view.items });
    },
  );
}
