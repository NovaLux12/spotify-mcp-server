import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { SpotifyClient } from '../client.js';
import type {
  SpotifyTrack,
  SpotifyArtistFull,
  SpotifyPaged,
  RecentlyPlayedResponse,
} from '../types/spotify.js';

function formatDuration(ms: number): string {
  const minutes = Math.floor(ms / 60000);
  const seconds = Math.floor((ms % 60000) / 1000);
  return `${minutes}:${seconds.toString().padStart(2, '0')}`;
}

const timeRangeSchema = z
  .enum(['short_term', 'medium_term', 'long_term'])
  .optional()
  .describe('~4 weeks / ~6 months / all time. Default: medium_term');

const limitSchema = (max = 50) =>
  z.number().int().min(1).max(max).optional().describe(`1–${max}. Default: 20`);

export function registerPersonalizationTools(server: McpServer, client: SpotifyClient): void {
  // get_top_tracks
  server.tool(
    'get_top_tracks',
    "Get the user's most-played tracks",
    {
      time_range: timeRangeSchema,
      limit: limitSchema(50),
    },
    async (args) => {
      const params: Record<string, string> = {
        time_range: args.time_range ?? 'medium_term',
        limit: String(args.limit ?? 20),
      };
      const result = await client.get<SpotifyPaged<SpotifyTrack>>('/me/top/tracks', params);
      if (!result) throw new Error('Could not retrieve top tracks');

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

      const lines = [`Top tracks (${total} total, showing ${items.length}):`];
      items.forEach((track, i) => {
        const artists = track.artists.map((a) => a.name).join(', ');
        lines.push(
          `  ${i + 1}. "${track.name}" by ${artists} (${formatDuration(track.duration_ms)}) | URI: ${track.uri}`,
        );
      });
      return { content: [{ type: 'text', text: lines.join('\n') }] };
    },
  );

  // get_top_artists
  server.tool(
    'get_top_artists',
    "Get the user's most-played artists",
    {
      time_range: timeRangeSchema,
      limit: limitSchema(50),
    },
    async (args) => {
      const params: Record<string, string> = {
        time_range: args.time_range ?? 'medium_term',
        limit: String(args.limit ?? 20),
      };
      const result = await client.get<SpotifyPaged<SpotifyArtistFull>>('/me/top/artists', params);
      if (!result) throw new Error('Could not retrieve top artists');

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

      const lines = [`Top artists (${total} total, showing ${items.length}):`];
      items.forEach((artist, i) => {
        const genres =
          Array.isArray(artist.genres) && artist.genres.length > 0
            ? artist.genres.join(', ')
            : 'no genres listed';
        lines.push(`  ${i + 1}. ${artist.name} — ${genres} | URI: ${artist.uri}`);
      });
      return { content: [{ type: 'text', text: lines.join('\n') }] };
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

      const lines = [`Recently played (${result.items.length} tracks):`];
      for (const item of result.items) {
        const artists = item.track.artists.map((a) => a.name).join(', ');
        const playedAt = new Date(item.played_at).toLocaleString();
        lines.push(
          `  • "${item.track.name}" by ${artists} — played at ${playedAt} | URI: ${item.track.uri}`,
        );
      }
      return { content: [{ type: 'text', text: lines.join('\n') }] };
    },
  );

}
