import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { SpotifyClient } from '../client.js';
import type {
  SpotifyTrack,
  SpotifyArtistFull,
  SpotifyPaged,
  RecentlyPlayedResponse,
} from '../types/spotify.js';
import {
  ResponseFormat,
  MaxResults,
  resolveMaxResults,
  truncateItems,
  paginationInfo,
  listStructuredContent,
} from '../shaping.js';

function formatDuration(ms: number): string {
  const minutes = Math.floor(ms / 60000);
  const seconds = Math.floor((ms % 60000) / 1000);
  return `${minutes}:${seconds.toString().padStart(2, '0')}`;
}

// /me/top/artists actually returns followers/popularity even though
// SpotifyArtistFull models the GET /artists/{id} subset — widen locally
// (same pattern as search.ts) so detailed mode can surface them.
type TopArtist = SpotifyArtistFull & {
  followers?: { total: number };
  popularity?: number;
};
export const timeRangeSchema = z
  .enum(['short_term', 'medium_term', 'long_term'])
  .optional()
  .describe('~4 weeks / ~6 months / all time. Default: medium_term');

const limitSchema = (max = 50) =>
  z.number().int().min(1).max(max).optional().describe(`1–${max}. Default: 20`);
const offsetSchema = () =>
  z.number().int().min(0).optional().describe('Start position (0-based). Default: 0');

export function registerPersonalizationTools(server: McpServer, client: SpotifyClient): void {
  // get_top_tracks
  server.tool(
    'get_top_tracks',
    "Get the user's most-played tracks",
    {
      time_range: timeRangeSchema,
      limit: limitSchema(50),
      offset: offsetSchema(),
      response_format: ResponseFormat,
      max_results: MaxResults,
    },
    async (args) => {
      const params: Record<string, string> = {
        time_range: args.time_range ?? 'medium_term',
        limit: String(args.limit ?? 20),
        offset: String(args.offset ?? 0),
      };
      const result = await client.get<SpotifyPaged<SpotifyTrack>>('/me/top/tracks', params);
      if (!result) throw new Error('Could not retrieve top tracks');

      if (args.response_format === 'json') {
        return {
          content: [{ type: 'text', text: JSON.stringify(result) }],
          structuredContent: { ...result },
        };
      }

      // Spotify's /me/top/tracks can return null/undefined `items` on 200 in
      // some edge cases (no listening history, account issue, malformed
      // pagination state). Validate before reading `.length` to avoid the
      // "Cannot read properties of undefined" crash on issue #3.
      const items = Array.isArray(result.items) ? result.items : [];
      const total = typeof result.total === 'number' ? result.total : items.length;

      if (items.length === 0) {
        return {
          content: [{ type: 'text', text: `No top tracks found (total: ${total}).` }],
        };
      }

      const shaped = truncateItems(items, resolveMaxResults(args.max_results));
      const detailed = args.response_format === 'detailed';

      const lines = [`Top tracks (${total} total, showing ${shaped.items.length}):`];
      shaped.items.forEach((track, i) => {
        const artists = track.artists.map((a) => a.name).join(', ');
        lines.push(
          `  ${i + 1}. "${track.name}" by ${artists} (${formatDuration(track.duration_ms)}) | URI: ${track.uri}`,
        );
        if (detailed && track.album?.name) lines.push(`      Album: ${track.album.name}`);
      });
      if (shaped.footer) lines.push(`(${shaped.footer})`);

      // Pagination reflects API-level continuation (pre-truncation page size)
      // so agents never skip unshown items when paging (#52).
      const pagination = paginationInfo({
        total,
        offset: args.offset ?? 0,
        limit: args.limit ?? 20,
        returned: items.length,
      });
      return {
        content: [{ type: 'text', text: lines.join('\n') }],
        structuredContent: listStructuredContent(shaped.items, pagination, {
          truncated: shaped.truncated,
          remaining: shaped.remaining,
        }),
      };
    },
  );

  // get_top_artists
  server.tool(
    'get_top_artists',
    "Get the user's most-played artists",
    {
      time_range: timeRangeSchema,
      limit: limitSchema(50),
      offset: offsetSchema(),
      response_format: ResponseFormat,
      max_results: MaxResults,
    },
    async (args) => {
      const params: Record<string, string> = {
        time_range: args.time_range ?? 'medium_term',
        limit: String(args.limit ?? 20),
        offset: String(args.offset ?? 0),
      };
      const result = await client.get<SpotifyPaged<TopArtist>>('/me/top/artists', params);
      if (!result) throw new Error('Could not retrieve top artists');

      if (args.response_format === 'json') {
        return {
          content: [{ type: 'text', text: JSON.stringify(result) }],
          structuredContent: { ...result },
        };
      }

      // Same defensive guard as get_top_tracks above — issue #3 crashes
      // here when Spotify returns null/undefined `items` or when an artist
      // row omits `genres` (the second access previously crashed). Surface
      // a useful empty/error message instead.
      const items = Array.isArray(result.items) ? result.items : [];
      const total = typeof result.total === 'number' ? result.total : items.length;

      if (items.length === 0) {
        return {
          content: [{ type: 'text', text: `No top artists found (total: ${total}).` }],
        };
      }

      const shaped = truncateItems(items, resolveMaxResults(args.max_results));
      const detailed = args.response_format === 'detailed';

      const lines = [`Top artists (${total} total, showing ${shaped.items.length}):`];
      shaped.items.forEach((artist, i) => {
        const genres =
          Array.isArray(artist.genres) && artist.genres.length > 0
            ? artist.genres.join(', ')
            : 'no genres listed';
        lines.push(`  ${i + 1}. ${artist.name} — ${genres} | URI: ${artist.uri}`);
        if (detailed) {
          const extras: string[] = [];
          if (artist.followers && typeof artist.followers.total === 'number') {
            extras.push(`Followers: ${artist.followers.total}`);
          }
          if (typeof artist.popularity === 'number') {
            extras.push(`Popularity: ${artist.popularity}`);
          }
          if (extras.length > 0) lines.push(`      ${extras.join(' | ')}`);
        }
      });
      if (shaped.footer) lines.push(`(${shaped.footer})`);

      const pagination = paginationInfo({
        total,
        offset: args.offset ?? 0,
        limit: args.limit ?? 20,
        returned: items.length,
      });
      return {
        content: [{ type: 'text', text: lines.join('\n') }],
        structuredContent: listStructuredContent(shaped.items, pagination, {
          truncated: shaped.truncated,
          remaining: shaped.remaining,
        }),
      };
    },
  );

  // get_recently_played
  server.tool(
    'get_recently_played',
    'Get recently played tracks with timestamps',
    {
      limit: limitSchema(50),
      after: z
        .number()
        .int()
        .optional()
        .describe('Unix timestamp ms — return tracks played after this time'),
      before: z
        .number()
        .int()
        .optional()
        .describe('Unix timestamp ms — return tracks played before this time'),
      response_format: ResponseFormat,
      max_results: MaxResults,
    },
    async (args) => {
      const params: Record<string, string> = { limit: String(args.limit ?? 20) };
      if (args.after !== undefined) params.after = String(args.after);
      if (args.before !== undefined) params.before = String(args.before);

      const result = await client.get<RecentlyPlayedResponse>(
        '/me/player/recently-played',
        params,
      );
      if (!result) throw new Error('Could not retrieve recently played tracks');

      if (args.response_format === 'json') {
        return {
          content: [{ type: 'text', text: JSON.stringify(result) }],
          structuredContent: { ...result },
        };
      }

      // Spotify returns entries whose `track` is null for removed/unavailable
      // tracks (issue #15) — skip them instead of crashing on dereference.
      const fetched = (result.items ?? []).filter((item) => item?.track);
      const shaped = truncateItems(fetched, resolveMaxResults(args.max_results));
      const detailed = args.response_format === 'detailed';

      const lines = [`Recently played (${fetched.length} tracks):`];
      for (const item of shaped.items) {
        const artists = item.track.artists.map((a) => a.name).join(', ');
        const playedAt = new Date(item.played_at).toLocaleString();
        lines.push(
          `  • "${item.track.name}" by ${artists} — played at ${playedAt} | URI: ${item.track.uri}`,
        );
        if (detailed && item.track.album?.name) {
          lines.push(`      Album: ${item.track.album.name}`);
        }
      }
      if (shaped.footer) lines.push(`(${shaped.footer})`);
      const nextCursor = result.cursors?.after ?? null;
      if (nextCursor !== null) {
        lines.push(`Pass after=${nextCursor} to continue.`);
      }

      // Recently-played pages by after/before cursors rather than numeric
      // offsets — expose the cursor alongside the shared pagination shape.
      const pagination = paginationInfo({
        total: null,
        offset: 0,
        limit: args.limit ?? 20,
        returned: fetched.length,
      });
      return {
        content: [{ type: 'text', text: lines.join('\n') }],
        structuredContent: listStructuredContent(shaped.items, pagination, {
          next_cursor: nextCursor,
          truncated: shaped.truncated,
          remaining: shaped.remaining,
        }),
      };
    },
  );
}
