import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { SpotifyClient } from '../client.js';
import type {
  SpotifyPaged,
  SpotifyPlaylistSimple,
  SpotifyImage,
} from '../types/spotify.js';
import {
  ResponseFormat,
  MaxResults,
  resolveMaxResults,
  truncateItems,
  paginationInfo,
  listStructuredContent,
} from '../shaping.js';
import type { ResponseFormatValue, PaginationInfo } from '../shaping.js';
import { getConfig } from '../config.js';

// ---------------------------------------------------------------------------
// Shared result shaping (#51/#52 helpers composed locally per file)
// ---------------------------------------------------------------------------

type ToolOut = {
  content: Array<{ type: 'text'; text: string }>;
  structuredContent?: Record<string, unknown>;
}

/**
 * Emit a tool result (#51): `json` mode stringifies the machine-readable
 * payload; every mode attaches it as MCP structuredContent (#52).
 */
function shapeResult(
  rf: ResponseFormatValue,
  prose: string,
  payload: Record<string, unknown>,
): ToolOut {
  return {
    content: [
      { type: 'text', text: rf === 'json' ? JSON.stringify(payload, null, 2) : prose },
    ],
    structuredContent: payload,
  };
}

/**
 * Pagination footers (#52/#53): the truncation footer when this call sliced
 * items client-side, otherwise a next-offset hint while the API has more.
 */
function appendPaginationFooters(
  lines: string[],
  t: { footer: string | null },
  pagination: PaginationInfo,
): void {
  if (t.footer) {
    lines.push(`(${t.footer})`);
  } else if (pagination.next_offset !== null) {
    lines.push(`(More available — pass offset=${pagination.next_offset} for the next page)`);
  }
}

// Public user profile as returned by GET /users/{user_id}.
//
// NOTE (issues #39/#40): this endpoint is flagged deprecated:true in the
// current API schema but is believed live for this app registration. If
// Spotify ever rejects it, the client raises SpotifyApiError whose message
// propagates straight through to the caller.
interface PublicUserProfile {
  id: string;
  display_name: string | null;
  uri: string;
  external_urls?: { spotify?: string };
  followers?: { total: number } | null;
  images?: SpotifyImage[] | null;
}

export function registerUsersTools(server: McpServer, client: SpotifyClient): void {

  // get_user_profile
  server.tool(
    'get_user_profile',
    "Get any Spotify user's public profile (display name, follower count, profile image)",
    {
      user_id: z.string().min(1).describe('Spotify user ID'),
      response_format: ResponseFormat,
    },
    async (args) => {
      const user = await client.get<PublicUserProfile>(
        `/users/${encodeURIComponent(args.user_id)}`,
      );
      if (!user) throw new Error(`User "${args.user_id}" not found`);

      const name = user.display_name ?? user.id;
      const lines = [`User: ${name}`, `ID: ${user.id}`, `URI: ${user.uri}`];

      if (typeof user.followers?.total === 'number') {
        lines.push(`Followers: ${user.followers.total}`);
      }

      const imageUrl =
        Array.isArray(user.images) && user.images.length > 0
          ? user.images[0]?.url
          : undefined;
      if (imageUrl) lines.push(`Profile image: ${imageUrl}`);

      const url = user.external_urls?.spotify;
      if (url) lines.push(`URL: ${url}`);

      // json mode = raw API object (#51); profile is short so detailed adds
      // nothing beyond concise.
      return shapeResult(args.response_format, lines.join('\n'), user as unknown as Record<string, unknown>);
    },
  );

  // get_user_playlists_by_id
  server.tool(
    'get_user_playlists_by_id',
    "List another Spotify user's public playlists (paginated). Output is capped by max_results (default: SPOTIFY_MCP_MAX_ITEMS).",
    {
      user_id: z.string().min(1).describe('Spotify user ID'),
      limit: z.number().int().min(1).max(50).optional().describe('1–50. Default: 20'),
      offset: z.number().int().min(0).optional().describe('Pagination offset. Default: 0'),
      response_format: ResponseFormat,
      max_results: MaxResults,
    },
    async (args) => {
      const params: Record<string, string> = { limit: String(args.limit ?? 20) };
      if (args.offset !== undefined) params.offset = String(args.offset);

      const result = await client.get<SpotifyPaged<SpotifyPlaylistSimple>>(
        `/users/${encodeURIComponent(args.user_id)}/playlists`,
        params,
      );
      if (!result) throw new Error(`Could not retrieve playlists for user "${args.user_id}"`);

      // Same defensive guard as issue #3 — items/total can be missing on
      // edge cases (e.g. user with zero public playlists).
      const allItems = Array.isArray(result.items) ? result.items : [];
      const total = typeof result.total === 'number' ? result.total : allItems.length;

      const detailed = args.response_format === 'detailed';
      const renderLine = (pl: SpotifyPlaylistSimple): string => {
        const trackCount = pl.tracks?.total ?? 0;
        const owner = pl.owner.display_name ?? pl.owner.id;
        let line = `  • "${pl.name}" by ${owner} (${trackCount} tracks) | ID: ${pl.id} | URI: ${pl.uri}`;
        if (detailed && pl.description) line += ` | ${pl.description}`;
        return line;
      };

      const cap = resolveMaxResults(args.max_results, getConfig().maxItems);
      const t = truncateItems(allItems, cap);
      const pagination = paginationInfo({
        total,
        offset: args.offset ?? 0,
        limit: args.limit ?? 20,
        returned: t.items.length,
      });

      const lines = [
        `Playlists owned by ${args.user_id} (${total} total, showing ${t.items.length}):`,
      ];
      for (const pl of t.items) lines.push(renderLine(pl));
      appendPaginationFooters(lines, t, pagination);
      return shapeResult(args.response_format, lines.join('\n'), listStructuredContent(t.items, pagination));
    },
  );
}
