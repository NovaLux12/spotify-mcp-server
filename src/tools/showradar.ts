/**
 * show_new_episodes (#173): new-episode radar across saved podcast shows.
 *
 * Pages /me/shows, fetches the latest episodes per show
 * (GET /shows/{id}/episodes), filters to those released within the lookback
 * window, and cross-references /me/episodes to mark which are already saved.
 *
 * Pure composition over non-deprecated endpoints; mirrors whats_new's radar
 * UX for podcasts.
 */
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { SpotifyClient } from '../client.js';
import {
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

export function registerShowRadarTools(server: McpServer, client: SpotifyClient): void {
  server.tool(
    'show_new_episodes',
    'Find new episodes across your saved podcast shows: reports episodes '
      + 'released within the lookback window (default 7 days), marking which are already '
      + 'saved in your episode library. Fetches /me/shows then each show\'s latest episodes.',
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
    },
    async (args) => {
      const cutoff = cutoffDate(args.days);

      const savedShows = await client.getAllPages<SavedShowItem>('/me/shows', { limit: '50' }, {
        maxItems: getConfig().fetchAllCap,
      });
      if (savedShows.length === 0) {
        return textResult('No saved shows in your library — nothing to scan.', {
          ok: true,
          days: args.days,
          cutoff,
          saved_shows: 0,
          new_episodes: 0,
          episodes: [],
        });
      }

      // Cross-ref: which episodes are already saved (/me/episodes)?
      const savedEpisodes = await client.getAllPages<SavedEpisodeItem>('/me/episodes', { limit: '50' }, {
        maxItems: getConfig().fetchAllCap,
      });
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
      for (const entry of savedShows) {
        const show = entry?.show;
        if (!show?.id) continue;
        const resp = await client.get<SpotifyPaged<SpotifyEpisodeSimple>>(
          `/shows/${encodeURIComponent(show.id)}/episodes`,
          { limit: String(args.per_show_limit) },
        );
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
      }

      // Newest first; tie-break by show/episode id for determinism.
      candidates.sort(
        (a, b) => b.release_date.localeCompare(a.release_date) || a.show_name.localeCompare(b.show_name) || a.episode_name.localeCompare(b.episode_name),
      );

      const extra = {
        days: args.days,
        cutoff,
        saved_shows: savedShows.length,
        per_show_limit: args.per_show_limit,
        new_episodes: candidates.length,
      };

      if (candidates.length === 0) {
        return textResult(
          `No new episodes found across ${savedShows.length} saved show(s) in the last ${args.days} day(s) (since ${cutoff}).`,
          { ...extra, ok: true, episodes: [] },
        );
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
        `Found ${candidates.length} new episode(s) across ${savedShows.length} saved show(s) since ${cutoff}:`,
      ];
      for (const ep of view.items) {
        const flag = ep.saved ? ' [saved]' : '';
        lines.push(`• "${ep.episode_name}" — ${ep.show_name} (${ep.release_date}, ${Math.round(ep.duration_ms / 1000)}s)${flag} | ${ep.uri}`);
      }
      if (view.footer) lines.push(`(${view.footer})`);
      return textResult(lines.join('\n'), { ok: true, ...extra, episodes: view.items });
    },
  );
}
