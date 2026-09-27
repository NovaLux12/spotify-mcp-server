import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { SpotifyClient } from '../client.js';
import type { SpotifyArtistFull } from '../types/spotify.js';
import { ResponseFormat } from '../shaping.js';

/**
 * #638: this module used to ship three tools. `get_categories` and
 * `get_category_playlists` were deleted with the endpoints they wrapped —
 * Spotify's February 2026 changelog removed `GET /browse/categories`,
 * `GET /browse/categories/{id}` and `GET /browse/categories/{id}/playlists`
 * outright, names no replacement for any of them, and no surviving endpoint
 * exposes the browse category tree. The two tools were not "degraded" so much
 * as dead: every call on a current registration failed, and on a grandfathered
 * one they were the only way to reach the data. Keeping them advertised a
 * capability the platform no longer serves.
 *
 * `browseCategoriesUnavailable` and `resolveBrowseMarket` went with them. The
 * former was the #1013 removal-naming error, which existed to make a failing
 * call honest rather than empty; with no call left to make honest there is
 * nothing for it to describe, and its two live siblings carry their own copies
 * (`browseCategoryUnavailable` in catalog.ts for `get_category` and
 * `browse_category_deepdive`, the gated-shape branch in
 * `category_resolver` in exhaust2_catalog.ts). The latter existed only for the
 * market/country alias the two deleted tools declared.
 *
 * What replaced them: nothing, and that is the point — `search_saved_playlists`
 * and the search family read the playlist surface, and a caller that wants a
 * category id should read it off a playlist URI rather than off a browse tree
 * that no longer exists.
 *
 * `get_artist_genres` stays: `GET /artists/{id}` is a live per-id read.
 */
export function registerBrowseTools(server: McpServer, client: SpotifyClient): void {
  server.tool(
    'get_artist_genres',
    'Get genres for an artist (focused view of GET /artists/{id})',
    {
      artist_id: z.string().describe('Spotify artist ID'),
      response_format: ResponseFormat,
    },
    async (args) => {
      const artist = await client.get<SpotifyArtistFull>(`/artists/${encodeURIComponent(args.artist_id)}`);
      if (!artist) throw new Error(`Artist "${args.artist_id}" not found`);
      const genres: string[] = Array.isArray(artist.genres) ? artist.genres : [];
      if (args.response_format === 'json') {
        const raw: Record<string, unknown> = { id: artist.id, name: artist.name, genres, uri: artist.uri };
        return { content: [{ type: 'text', text: JSON.stringify(raw, null, 2) }], structuredContent: raw };
      }
      const line = genres.length > 0 ? genres.join(', ') : 'none listed';
      return {
        content: [{ type: 'text', text: `Genres for "${artist.name}" (${artist.id}): ${line}` }],
        structuredContent: { id: artist.id, name: artist.name, genres, uri: artist.uri },
      };
    },
  );
}
