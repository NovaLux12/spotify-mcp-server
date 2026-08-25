import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { SpotifyClient } from '../client.js';
import type { FollowedArtistsResponse } from '../types/spotify.js';

export function registerFollowingTools(server: McpServer, client: SpotifyClient): void {

  // get_followed_artists
  server.tool(
    'get_followed_artists',
    'Get all artists the user follows (cursor-based pagination)',
    {
      limit: z.number().int().min(1).max(50).optional().describe('1–50. Default: 20'),
      after: z
        .string()
        .optional()
        .describe('Artist ID cursor for pagination (from previous response)'),
    },
    async (args) => {
      const params: Record<string, string> = {
        type: 'artist',
        limit: String(args.limit ?? 20),
      };
      if (args.after) params.after = args.after;

      const result = await client.get<FollowedArtistsResponse>('/me/following', params);
      if (!result) throw new Error('Could not retrieve followed artists');

      // Same defensive guard as issue #3 — \`result.artists\` is what Spotify
      // returns on success but can be null/undefined on edge cases
      // (e.g. account with zero followed artists, transient state issue).
      // Validate before reading .items.length to avoid the crash on issue #4.
      const followed = result.artists ?? {
        items: [],
        total: 0,
        cursors: null,
        next: null,
      };
      const items = Array.isArray(followed.items) ? followed.items : [];
      const total = typeof followed.total === 'number' ? followed.total : items.length;

      if (items.length === 0) {
        return {
          content: [
            { type: 'text', text: `Followed artists (${total} total, showing 0).` },
          ],
        };
      }

      const lines = [`Followed artists (${total} total, showing ${items.length}):`];
      for (const artist of items) {
        const genres =
          Array.isArray(artist.genres) && artist.genres.length > 0
            ? artist.genres.join(', ')
            : 'no genres listed';
        lines.push(`  • ${artist.name} — ${genres} | URI: ${artist.uri}`);
      }
      if (followed.cursors?.after) {
        lines.push(`\nNext page cursor: ${followed.cursors.after}`);
      }
      return { content: [{ type: 'text', text: lines.join('\n') }] };
    },
  );

  // check_following_artists
  server.tool(
    'check_following_artists',
    'Check if the user follows specific artists. Returns a boolean per ID. Max 50.',
    {
      ids: z.array(z.string()).min(1).max(50).describe('Spotify artist IDs to check'),
    },
    async (args) => {
      const result = await client.get<boolean[]>('/me/following/contains', {
        type: 'artist',
        ids: args.ids.join(','),
      });
      if (!result) throw new Error('Could not check following status');

      const lines = args.ids.map((id, i) => `  ${result[i] ? '✓' : '✗'} ${id}`);
      return { content: [{ type: 'text', text: `Following check:\n${lines.join('\n')}` }] };
    },
  );

  // follow_artists
  server.tool(
    'follow_artists',
    'Follow one or more artists (1–50 IDs). Requires user-follow-modify.',
    {
      ids: z.array(z.string()).min(1).max(50).describe('Spotify artist IDs to follow'),
    },
    async (args) => {
      // Spotify takes ids/type as query parameters on PUT /me/following,
      // not a request body.
      await client.put(`/me/following?type=artist&ids=${args.ids.join(',')}`);
      return {
        content: [
          { type: 'text', text: `Followed ${args.ids.length} artist(s).` },
        ],
      };
    },
  );

  // unfollow_artists
  server.tool(
    'unfollow_artists',
    'Unfollow one or more artists (1–50 IDs). Requires user-follow-modify.',
    {
      ids: z.array(z.string()).min(1).max(50).describe('Spotify artist IDs to unfollow'),
    },
    async (args) => {
      // Symmetric with follow_artists: query parameters, no body.
      await client.delete(`/me/following?type=artist&ids=${args.ids.join(',')}`);
      return {
        content: [
          { type: 'text', text: `Unfollowed ${args.ids.length} artist(s).` },
        ],
      };
    },
  );
}
